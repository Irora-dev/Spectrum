import { isAddress, type Address } from 'viem'
import {
  isDemoLegAddress,
  thesisRunKey,
  type LegFunding,
  type ThesisRun,
  type ThesisRunDirection,
  type ThesisRunStep,
  type ThesisSellPlan,
  type ThesisStepKind,
  type ThesisStepState,
} from './thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// THE THESIS-RUN SEQUENCER — the pure state machine behind the one-flow
// cross-chain thesis buy/sell (the owner 2026-08-09, direct route). The overlay
// drives; this module only COMPOSES step lists, REDUCES transitions, and
// PERSISTS the run across reloads. No React, no chain, no clock inside the
// reducers — the only time read is `now()` at build, injectable for tests.
//
// COMPOSITION LAW (buy): every bridge SEND fires before any buying, grouped by
// source chain so the wallet switches once per source — bridges take minutes,
// and firing them first makes their in-flight time overlap the buys instead of
// preceding them. Each bridge's paired await-bridge step sits in the BUY
// phase, immediately before its leg's buy: that is the moment the money must
// have arrived. v1 EXECUTION IS STRICTLY LINEAR (activeStep = the first
// non-terminal step) — the overlap comes from step ORDER, not a scheduler.
//
// THE REFUSAL LAW: a real run (demo=false) must never arm against a synthetic
// leg address — enforced at BUILD (compose refuses) and again at LOAD (a
// stored "real" run carrying a demo address reads as no-run). demo=true
// composes the same steps and says so on the run itself.
//
// THE MONEY LAW on resume: a run reloaded while a step was 'signing' or
// 'confirming' cannot know whether money moved — the submission-store doctrine
// (submission-store.ts:47-54: "a submission with an id means MONEY IS IN
// FLIGHT and time passing does not resolve that ambiguity"). loadThesisRun
// demotes exactly those two states to 'failed' with a note telling the user to
// check their wallet before retrying — never a silent re-arm. 'awaiting'
// survives as-is: a bridge in flight is re-polled by txHash (bridge-pending),
// which a reload does not invalidate.
//
// PERSISTENCE POSTURE: sanitize-on-read, drop-to-null (bridge-pending.ts's
// precedent) — this is a RESUME record, not the money-safety record. The
// double-submit guards live in submission-store/bridge-pending; a blob that
// fails any validation reads as "no run", and the user re-plans from FRESH
// balance reads. A MISSING resume is safe; a WRONG one is not — which is also
// why saveThesisRun is best-effort (a failed save degrades to re-planning and
// must not blow up the live flow mid-step).
// ─────────────────────────────────────────────────────────────────────────────

/** Spec-exact refusal sentence for a real run against synthetic legs. */
export const DEMO_BUY_REFUSAL = 'This bundle is a demo — its baskets are synthetic and cannot be bought.'
/** The same law on the sell side, verb adjusted. */
export const DEMO_SELL_REFUSAL = 'This bundle is a demo — its baskets are synthetic and cannot be sold.'
/** The money-law demotion note, word for word — the UI may match on it. */
export const INTERRUPTED_MID_SIGNATURE_NOTE =
  "Interrupted mid-signature — check your wallet's activity before retrying"

/** Stable step id: `${kind}:${chainId}` plus a discriminator where two of a
 *  kind can share a chain (the contract's "never index-derived" rule — steps
 *  are looked up by id after a reload, so an id must not move when the list
 *  around it changes). Discriminators in use: 'src' (bridge-phase switch),
 *  'out' (consolidate-phase switch), the lowercased basket address (sell),
 *  `from:<chainId>` (consolidate — several sources bridge to ONE home chain). */
export function stepIdOf(kind: ThesisStepKind, chainId: number, discriminator?: string): string {
  return discriminator ? `${kind}:${chainId}:${discriminator}` : `${kind}:${chainId}`
}

// ── composition ──────────────────────────────────────────────────────────────

export interface BuildThesisBuyRunArgs {
  ref: string
  deployer: string
  signer: Address
  /** The total the user typed, integer cents — refused otherwise. */
  amountCents: number
  legs: { chainId: number; address: Address }[]
  /** thesis-funding.ts's output, one per leg; ORDER here is execution order. */
  fundings: LegFunding[]
  demo: boolean
  /** Injectable clock, read ONCE for startedAt (never inside reducers). */
  now?: () => number
}

export interface BuildThesisSellRunArgs {
  ref: string
  deployer: string
  signer: Address
  /** thesis-sell.ts's output; steps ORDER is execution order. */
  plan: ThesisSellPlan
  legs: { chainId: number; address: Address }[]
  demo: boolean
  now?: () => number
}

/** A run's money ceiling, cents. $1 trillion is far past any honest thesis buy
 *  — the bound exists to reject garbage crossing the storage seam (the
 *  allocation.ts dollar-ceiling rationale), never to police real amounts. */
const MAX_PLAUSIBLE_CENTS = 100_000_000_000_000

/** Track the wallet-chain context while composing so ADJACENT duplicate
 *  switches collapse: a switch is emitted only when the target differs from
 *  the chain the previous steps already put the wallet on. The FIRST switch is
 *  always emitted — build time cannot know the wallet's live chain, and the
 *  overlay auto-completes a switch the wallet already satisfies. */
interface Composer {
  steps: ThesisRunStep[]
  ctx: number | null
}

function pushSwitch(c: Composer, chainId: number, discriminator?: string): void {
  if (c.ctx === chainId) return // already on that chain's group — collapses
  c.steps.push({ id: stepIdOf('switch', chainId, discriminator), kind: 'switch', chainId, state: 'queued' })
  c.ctx = chainId
}

/** Composition bugs must refuse, never arm: two steps sharing an id would make
 *  advanceStep patch both — an ambiguous run is worse than no run. */
function collidingId(steps: ThesisRunStep[]): string | null {
  const seen = new Set<string>()
  for (const s of steps) {
    if (seen.has(s.id)) return s.id
    seen.add(s.id)
  }
  return null
}

export function buildThesisBuyRun(args: BuildThesisBuyRunArgs): ThesisRun | { refused: string } {
  const { ref, deployer, signer, amountCents, legs, fundings, demo } = args

  // THE REFUSAL LAW first — a synthetic thesis refuses regardless of anything
  // else being wrong with the request.
  if (!demo && legs.some((l) => isDemoLegAddress(l.address))) return { refused: DEMO_BUY_REFUSAL }

  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_PLAUSIBLE_CENTS)
    return { refused: 'The buy amount must be a positive whole number of cents.' }
  if (legs.length === 0) return { refused: 'This bundle has no legs to buy.' }

  // Join legs ↔ fundings by chainId (a thesis holds ONE leg per chain — the
  // grouper's own law). Any mismatch means the two sibling modules disagree
  // about what is being bought, and composing over that could move the wrong
  // money or silently drop a leg — both refusals, never repairs.
  const addressOf = new Map<number, Address>()
  for (const l of legs) {
    if (addressOf.has(l.chainId))
      return { refused: `Two legs share chain ${l.chainId} — a thesis holds one leg per chain.` }
    addressOf.set(l.chainId, l.address)
  }
  const seen = new Set<number>()
  for (const f of fundings) {
    if (!addressOf.has(f.chainId))
      return { refused: `The funding plan names chain ${f.chainId}, which has no leg — refusing a plan that does not match the thesis.` }
    if (seen.has(f.chainId))
      return { refused: `The funding plan names chain ${f.chainId} twice — refusing the ambiguity.` }
    seen.add(f.chainId)
  }
  if (seen.size !== addressOf.size)
    return { refused: 'A leg has no funding entry — refusing to compose a run that would silently drop it.' }

  const runnable = (f: LegFunding) => f.note == null && f.gasOk

  // Money numbers a runnable leg will actually sign with must be sane HERE —
  // a NaN or zero amount discovered at the wallet prompt is a worse failure
  // than a refusal at compose time.
  for (const f of fundings) {
    if (!runnable(f)) continue
    if (!Number.isInteger(f.needCents) || f.needCents <= 0)
      return { refused: `The funding plan for chain ${f.chainId} carries an unreadable buy amount.` }
    if (f.bridge != null && f.convert != null)
      return { refused: `The funding plan for chain ${f.chainId} carries both a bridge and a conversion — refusing the ambiguity.` }
    if (f.bridge != null) {
      if (!Number.isInteger(f.bridge.amountCents) || f.bridge.amountCents <= 0)
        return { refused: `The funding plan for chain ${f.chainId} carries an unreadable bridge amount.` }
      if (f.bridge.fromChainId === f.chainId)
        return { refused: `The funding plan bridges chain ${f.chainId} to itself — refusing.` }
    }
    if (f.convert != null) {
      // A conversion may legally be same-chain (sell ETH → USDC where the leg
      // lives) — only its MONEY fields are contract-checked here.
      const cv = f.convert
      if (typeof cv.fromAmountRaw !== 'bigint' || cv.fromAmountRaw <= 0n)
        return { refused: `The funding plan for chain ${f.chainId} carries an unreadable conversion amount.` }
      if (typeof cv.quotedToMinRaw !== 'bigint' || cv.quotedToMinRaw <= 0n)
        return { refused: `The funding plan for chain ${f.chainId} carries a conversion with no quoted floor — refusing to arm an unquoted sale.` }
      if (!isAddress(cv.token.address))
        return { refused: `The funding plan for chain ${f.chainId} names an unreadable pay token — refusing.` }
      if (typeof cv.token.symbol !== 'string' || cv.token.symbol.length === 0 || cv.token.symbol.length > 24)
        return { refused: `The funding plan for chain ${f.chainId} names an unreadable pay-token symbol — refusing.` }
      if (!Number.isInteger(cv.token.decimals) || cv.token.decimals < 0 || cv.token.decimals > 36)
        return { refused: `The funding plan for chain ${f.chainId} names unreadable pay-token decimals — refusing.` }
    }
  }

  const c: Composer = { steps: [], ctx: null }

  // PHASE 1 — every SEND that moves money toward a leg (settlement bridges AND
  // pay-asset conversions), grouped by source chain in first-appearance order,
  // one switch per source. Conversions sign where the pay asset lives, exactly
  // like a bridge signs on its source. Skipped legs contribute NOTHING here:
  // firing a send for a leg that will not buy moves money for nothing.
  const bySource = new Map<number, LegFunding[]>()
  for (const f of fundings) {
    if (!runnable(f)) continue
    const src = f.bridge?.fromChainId ?? f.convert?.fromChainId
    if (src == null) continue
    const group = bySource.get(src)
    if (group) group.push(f)
    else bySource.set(src, [f])
  }
  for (const [src, group] of bySource) {
    pushSwitch(c, src, 'src')
    for (const f of group) {
      // chainId = the leg the money FUNDS (destination); bridgeFromChainId =
      // where the send is signed. The switch above targets the source.
      if (f.bridge != null) {
        c.steps.push({
          id: stepIdOf('bridge', f.chainId),
          kind: 'bridge',
          chainId: f.chainId,
          legAddress: addressOf.get(f.chainId),
          amountCents: f.bridge.amountCents,
          bridgeFromChainId: src,
          bridgeTxHash: null,
          state: 'queued',
        })
      } else if (f.convert != null) {
        c.steps.push({
          id: stepIdOf('convert', f.chainId),
          kind: 'convert',
          chainId: f.chainId,
          legAddress: addressOf.get(f.chainId),
          // The settlement cents this sale covers — display truth; the sale
          // itself is denominated in payAmountRaw and re-quoted fresh at
          // signing (use-bridge-leg's law).
          amountCents: f.shortfallCents,
          bridgeFromChainId: src,
          bridgeTxHash: null,
          payTokenAddress: f.convert.token.address,
          paySymbol: f.convert.token.symbol,
          payDecimals: f.convert.token.decimals,
          payAmountRaw: f.convert.fromAmountRaw,
          state: 'queued',
        })
      }
    }
  }

  // PHASE 2 — per leg in the fundings' order: [switch] → [await-bridge if
  // money travels to it cross-chain] → [buy]. A same-chain conversion needs no
  // arrival step: it settles in its own confirmed transaction (lifi.ts — "a
  // same-chain swap settles in the transaction we signed"), and the convert
  // step itself holds the linear cursor until that confirmation. A refused leg
  // is SHOWN as one skipped buy step, in place, so every leg in the input
  // appears in the run.
  for (const f of fundings) {
    if (!runnable(f)) {
      const step: ThesisRunStep = {
        id: stepIdOf('buy', f.chainId),
        kind: 'buy',
        chainId: f.chainId,
        legAddress: addressOf.get(f.chainId),
        state: 'skipped',
        // gasOk=false with a null note still needs an honest sentence (the
        // contract requires one on skipped states).
        note: f.note ?? 'This leg cannot pay for its own gas, so it was refused rather than stranding funds.',
        ...(f.noteCode ? { noteCode: f.noteCode } : {}),
        ...(f.noteShortCents != null ? { noteShortCents: f.noteShortCents } : {}),
      }
      if (Number.isInteger(f.needCents) && f.needCents > 0) step.amountCents = f.needCents
      c.steps.push(step)
      continue
    }
    pushSwitch(c, f.chainId)
    const inbound =
      f.bridge != null
        ? { fromChainId: f.bridge.fromChainId, amountCents: f.bridge.amountCents }
        : f.convert != null && f.convert.fromChainId !== f.chainId
          ? { fromChainId: f.convert.fromChainId, amountCents: f.shortfallCents }
          : null
    if (inbound != null) {
      c.steps.push({
        id: stepIdOf('await-bridge', f.chainId),
        kind: 'await-bridge',
        chainId: f.chainId,
        legAddress: addressOf.get(f.chainId),
        amountCents: inbound.amountCents,
        bridgeFromChainId: inbound.fromChainId,
        bridgeTxHash: null, // filled from the send step's hash — the join key bridge-pending polls by
        state: 'queued',
      })
    }
    c.steps.push({
      id: stepIdOf('buy', f.chainId),
      kind: 'buy',
      chainId: f.chainId,
      legAddress: addressOf.get(f.chainId),
      amountCents: f.needCents,
      state: 'queued',
    })
  }

  const collision = collidingId(c.steps)
  if (collision != null)
    return { refused: `Internal: two steps composed the same id (${collision}) — refusing to arm an ambiguous run.` }

  return {
    v: 1,
    ref,
    deployer,
    direction: 'buy',
    signer,
    amountCents,
    steps: c.steps,
    startedAt: (args.now ?? Date.now)(),
    demo,
  }
}

export function buildThesisSellRun(args: BuildThesisSellRunArgs): ThesisRun | { refused: string } {
  const { ref, deployer, signer, plan, legs, demo } = args

  // Same refusal law as the buy side — and the plan's own step addresses are
  // what actually arm, so they are checked alongside the legs.
  if (!demo && (legs.some((l) => isDemoLegAddress(l.address)) || plan.steps.some((s) => isDemoLegAddress(s.address))))
    return { refused: DEMO_SELL_REFUSAL }
  if (plan.steps.length === 0) return { refused: 'There is nothing to sell — the plan has no steps.' }

  for (const s of plan.steps) {
    if (typeof s.sellRaw !== 'bigint' || s.sellRaw <= 0n)
      return { refused: `The sell plan for chain ${s.chainId} carries no readable amount.` }
  }

  const c: Composer = { steps: [], ctx: null }

  // Per sell step: [switch] → [sell], in the plan's order.
  for (const s of plan.steps) {
    pushSwitch(c, s.chainId)
    c.steps.push({
      id: stepIdOf('sell', s.chainId, s.address.toLowerCase()),
      kind: 'sell',
      chainId: s.chainId,
      legAddress: s.address,
      // NO amountCents on a sell — the contract's rule: sells carry raw in
      // sellRaw; estCents is the plan's display number, floors are the live
      // sell path's job.
      sellRaw: s.sellRaw,
      state: 'queued',
    })
  }

  // Optional consolidation: per source chain WITH proceeds (i.e. where a sell
  // ran), home chain excluded — bridging home to home is not a step.
  if (plan.consolidate != null) {
    const home = plan.consolidate.toChainId
    const sources = [...new Set(plan.steps.map((s) => s.chainId))].filter((chainId) => chainId !== home)
    for (const src of sources) {
      pushSwitch(c, src, 'out')
      c.steps.push({
        id: stepIdOf('consolidate', home, `from:${src}`),
        kind: 'consolidate',
        // chainId = destination (home), bridgeFromChainId = where it signs —
        // the same convention as buy-phase bridges, so the overlay reads one
        // shape for both. amountCents is deliberately ABSENT: the live number
        // exists only after the sells land, and the UI fills it then
        // (setStepAmount below).
        chainId: home,
        bridgeFromChainId: src,
        bridgeTxHash: null,
        state: 'queued',
      })
    }
  }

  const collision = collidingId(c.steps)
  if (collision != null)
    return { refused: `Internal: two steps composed the same id (${collision}) — refusing to arm an ambiguous run.` }

  return {
    v: 1,
    ref,
    deployer,
    direction: 'sell',
    signer,
    amountCents: 0, // sell runs: amounts live per step (the contract's rule)
    steps: c.steps,
    startedAt: (args.now ?? Date.now)(),
    demo,
  }
}

// ── reducers (all pure — new objects on change, the SAME reference on a
//    refused or no-op call, so a caller can detect refusal by identity) ──────

/** Patch one step. Refusals (returning the run unchanged):
 *  - unknown stepId — log nothing, corrupt nothing;
 *  - 'done'/'skipped' are TERMINAL and frozen whole: what happened is a
 *    record, and a record does not get rewritten;
 *  - 'failed' may change state only via retryStep (its note/hash may still be
 *    enriched — a failure learning more detail is not a transition);
 *  - nothing transitions INTO 'skipped' at runtime — skipped is a plan-time
 *    verdict by the contract's own definition, and a runtime skip would erase
 *    a money step from progress. */
export function advanceStep(
  run: ThesisRun,
  stepId: string,
  patch: Partial<Pick<ThesisRunStep, 'state' | 'note' | 'bridgeTxHash'>>,
): ThesisRun {
  const step = run.steps.find((s) => s.id === stepId)
  if (!step) return run
  if (step.state === 'done' || step.state === 'skipped') return run
  if (patch.state !== undefined) {
    if (patch.state === 'skipped') return run
    if (step.state === 'failed' && patch.state !== 'failed') return run
  }
  const next: ThesisRunStep = { ...step }
  if (patch.state !== undefined) next.state = patch.state
  if ('note' in patch) next.note = patch.note
  if ('bridgeTxHash' in patch) next.bridgeTxHash = patch.bridgeTxHash
  return { ...run, steps: run.steps.map((s) => (s.id === stepId ? next : s)) }
}

/** The ONLY exit from 'failed': back to 'queued', note cleared. bridgeTxHash
 *  is deliberately KEPT — if a send did land before the failure, the hash is
 *  evidence, and the re-send overwrites it with the new one via advanceStep. */
export function retryStep(run: ThesisRun, stepId: string): ThesisRun {
  const step = run.steps.find((s) => s.id === stepId)
  if (!step || step.state !== 'failed') return run
  return {
    ...run,
    steps: run.steps.map((s) => (s.id === stepId ? { ...s, state: 'queued' as ThesisStepState, note: null } : s)),
  }
}

/** The linear cursor: the first step not in a terminal state (done/skipped),
 *  or null when the run is over. v1 IS STRICTLY LINEAR by design — an
 *  'awaiting' bridge HOLDS the cursor rather than being passed, because the
 *  bridges were already fired first (phase 1), so their in-flight minutes
 *  overlap the earlier legs' switches and buys by construction. A smarter
 *  cursor that hops chains mid-wait is a v2 decision, not a default. */
export function activeStep(run: ThesisRun): ThesisRunStep | null {
  return run.steps.find((s) => s.state !== 'done' && s.state !== 'skipped') ?? null
}

/** Progress over the RUNNABLE steps: total excludes skipped (a leg refused at
 *  plan time was never work to do), finished = every non-skipped step done.
 *  A run whose every leg was skipped is finished-with-nothing-to-do
 *  (0/0, finished: true) — the overlay's skipped rows carry the why. */
export function runProgress(run: ThesisRun): { done: number; total: number; failed: number; finished: boolean } {
  let done = 0
  let total = 0
  let failed = 0
  for (const s of run.steps) {
    if (s.state === 'skipped') continue
    total++
    if (s.state === 'done') done++
    else if (s.state === 'failed') failed++
  }
  return { done, total, failed, finished: done === total }
}

/** Fill a consolidate step's late-bound amount — the ONE number composition
 *  cannot know (proceeds exist only after the sells land). Narrow on purpose:
 *  consolidate steps only, positive integer cents only, never a terminal step.
 *  Everything else returns the run unchanged. */
export function setStepAmount(run: ThesisRun, stepId: string, amountCents: number): ThesisRun {
  const step = run.steps.find((s) => s.id === stepId)
  if (!step || step.kind !== 'consolidate') return run
  if (step.state === 'done' || step.state === 'skipped') return run
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_PLAUSIBLE_CENTS) return run
  return { ...run, steps: run.steps.map((s) => (s.id === stepId ? { ...s, amountCents } : s)) }
}

// ── persistence (localStorage, injectable; sanitize-on-read) ────────────────

function defaultStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null // SSR/tests/privacy mode: no resume, which is the safe absence
  }
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<ThesisStepKind>([
  'switch',
  'bridge',
  'convert',
  'await-bridge',
  'buy',
  'sell',
  'consolidate',
])
const KNOWN_STATES: ReadonlySet<string> = new Set<ThesisStepState>([
  'queued',
  'active',
  'signing',
  'confirming',
  'awaiting',
  'done',
  'failed',
  'skipped',
])

// Bounds exist to reject hostile blobs cheaply, sized far past anything this
// module writes — a legitimate run must never fail its own read.
const MAX_ID_LEN = 200
const MAX_TX_HASH_LEN = 256
const MAX_NOTE_LEN = 2000
const MAX_STEPS = 400
/** uint256 is 78 decimal digits — a sellRaw longer than this is not a token
 *  amount, and BigInt-parsing megabyte strings is a DoS on the read path. */
const MAX_SELL_RAW_DIGITS = 100
const SELL_RAW_RE = /^\d{1,100}$/

type Stored = Record<string, unknown>

/** THE BIGINT-JSON IDIOM IS THE HOUSE ONE (bridge-pending.ts serializeRow,
 *  cow-pending.ts): the schema knows exactly which field is a bigint, so it is
 *  serialized as a plain decimal string per field and parsed back with BigInt
 *  under guard — no generic marker format to invent or to trust. A sellRaw or
 *  payAmountRaw that arrives as a JSON NUMBER is rejected outright: past 2^53
 *  it has already lost precision, and a lossy money amount must read as no-run. */
function serializeStep(s: ThesisRunStep): Stored {
  const out: Stored = { ...s }
  if (s.sellRaw !== undefined) out.sellRaw = s.sellRaw.toString()
  if (s.payAmountRaw !== undefined) out.payAmountRaw = s.payAmountRaw.toString()
  return out
}

function parseStep(v: unknown): ThesisRunStep | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Stored
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > MAX_ID_LEN) return null
  if (typeof o.kind !== 'string' || !KNOWN_KINDS.has(o.kind)) return null
  if (typeof o.state !== 'string' || !KNOWN_STATES.has(o.state)) return null
  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0) return null
  if (!(o.legAddress === undefined || (typeof o.legAddress === 'string' && isAddress(o.legAddress)))) return null
  if (
    !(
      o.amountCents === undefined ||
      (typeof o.amountCents === 'number' && Number.isFinite(o.amountCents) && o.amountCents >= 0)
    )
  )
    return null
  if (
    !(
      o.bridgeFromChainId === undefined ||
      (typeof o.bridgeFromChainId === 'number' && Number.isInteger(o.bridgeFromChainId) && o.bridgeFromChainId > 0)
    )
  )
    return null
  if (
    !(
      o.bridgeTxHash === undefined ||
      o.bridgeTxHash === null ||
      (typeof o.bridgeTxHash === 'string' && o.bridgeTxHash.length > 0 && o.bridgeTxHash.length <= MAX_TX_HASH_LEN)
    )
  )
    return null
  if (!(o.note === undefined || o.note === null || (typeof o.note === 'string' && o.note.length <= MAX_NOTE_LEN)))
    return null
  let sellRaw: bigint | undefined
  if (o.sellRaw !== undefined) {
    if (typeof o.sellRaw !== 'string' || o.sellRaw.length > MAX_SELL_RAW_DIGITS || !SELL_RAW_RE.test(o.sellRaw))
      return null
    try {
      sellRaw = BigInt(o.sellRaw)
    } catch {
      return null
    }
  }
  // The convert quartet — same regime as sellRaw: strings for the bigint,
  // bounded symbol/decimals (an unbounded decimals makes formatUnits
  // quadratic; the F-2/F-6 lesson), address must BE an address.
  if (!(o.payTokenAddress === undefined || (typeof o.payTokenAddress === 'string' && isAddress(o.payTokenAddress))))
    return null
  if (!(o.paySymbol === undefined || (typeof o.paySymbol === 'string' && o.paySymbol.length > 0 && o.paySymbol.length <= 24)))
    return null
  if (
    !(
      o.payDecimals === undefined ||
      (typeof o.payDecimals === 'number' && Number.isInteger(o.payDecimals) && o.payDecimals >= 0 && o.payDecimals <= 36)
    )
  )
    return null
  let payAmountRaw: bigint | undefined
  if (o.payAmountRaw !== undefined) {
    if (typeof o.payAmountRaw !== 'string' || o.payAmountRaw.length > MAX_SELL_RAW_DIGITS || !SELL_RAW_RE.test(o.payAmountRaw))
      return null
    try {
      payAmountRaw = BigInt(o.payAmountRaw)
    } catch {
      return null
    }
  }
  // A convert step that cannot be re-quoted is not resumable: a partial
  // quartet would make the wallet sign garbage, so the whole run reads as
  // no-run and the user re-plans from fresh reads (a MISSING resume is safe).
  if (
    o.kind === 'convert' &&
    (o.payTokenAddress === undefined || o.paySymbol === undefined || o.payDecimals === undefined || payAmountRaw === undefined || payAmountRaw <= 0n)
  )
    return null
  // Explicit construction (the parseRow way) — unknown extra keys from a
  // hostile blob never ride into the typed object.
  const step: ThesisRunStep = {
    id: o.id,
    kind: o.kind as ThesisStepKind,
    chainId: o.chainId,
    state: o.state as ThesisStepState,
  }
  if (o.legAddress !== undefined) step.legAddress = o.legAddress as Address
  if (o.amountCents !== undefined) step.amountCents = o.amountCents as number
  if (sellRaw !== undefined) step.sellRaw = sellRaw
  if (o.bridgeFromChainId !== undefined) step.bridgeFromChainId = o.bridgeFromChainId as number
  if (o.bridgeTxHash !== undefined) step.bridgeTxHash = o.bridgeTxHash as string | null
  if (o.payTokenAddress !== undefined) step.payTokenAddress = o.payTokenAddress as Address
  if (o.paySymbol !== undefined) step.paySymbol = o.paySymbol as string
  if (o.payDecimals !== undefined) step.payDecimals = o.payDecimals as number
  if (payAmountRaw !== undefined) step.payAmountRaw = payAmountRaw
  if (o.note !== undefined) step.note = o.note as string | null
  // the structured refusal survives the round-trip (hostile-input bounded:
  // only the known codes pass, a junk code drops silently to the prose)
  if (o.noteCode === 'needs-funds' || o.noteCode === 'gas-unsized' || o.noteCode === 'gas-short') step.noteCode = o.noteCode
  if (typeof o.noteShortCents === 'number' && Number.isFinite(o.noteShortCents) && o.noteShortCents >= 0)
    step.noteShortCents = o.noteShortCents
  return step
}

function parseRun(v: unknown, signer: string, ref: string, direction: ThesisRunDirection): ThesisRun | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Stored
  if (o.v !== 1) return null
  // The key already scopes ref/direction/signer, but the BLOB is the hostile
  // party here — its own fields must agree with what was asked for, and the
  // signer match is what stops one wallet resuming another wallet's
  // half-finished money movement.
  if (o.ref !== ref || o.direction !== direction) return null
  if (typeof o.deployer !== 'string' || o.deployer.length === 0 || o.deployer.length > 500) return null
  if (typeof o.signer !== 'string' || !isAddress(o.signer) || o.signer.toLowerCase() !== signer.toLowerCase())
    return null
  if (
    typeof o.amountCents !== 'number' ||
    !Number.isInteger(o.amountCents) ||
    o.amountCents < 0 ||
    o.amountCents > MAX_PLAUSIBLE_CENTS
  )
    return null
  if (typeof o.startedAt !== 'number' || !Number.isFinite(o.startedAt) || o.startedAt <= 0) return null
  if (typeof o.demo !== 'boolean') return null
  if (!Array.isArray(o.steps) || o.steps.length === 0 || o.steps.length > MAX_STEPS) return null
  const steps: ThesisRunStep[] = []
  const ids = new Set<string>()
  for (const entry of o.steps) {
    const step = parseStep(entry)
    if (step == null) return null
    if (ids.has(step.id)) return null // duplicate ids = an ambiguous resume — advanceStep patches by id
    ids.add(step.id)
    steps.push(step)
  }
  // THE REFUSAL LAW AT THE LOAD SEAM: a stored "real" run carrying a synthetic
  // leg address is forged or corrupt either way — it reads as no-run.
  if (o.demo === false && steps.some((s) => s.legAddress != null && isDemoLegAddress(s.legAddress))) return null
  return {
    v: 1,
    ref,
    deployer: o.deployer,
    direction,
    signer: o.signer as Address,
    amountCents: o.amountCents,
    steps,
    startedAt: o.startedAt,
    demo: o.demo,
  }
}

/** THE MONEY LAW on resume, applied per step: 'signing'/'confirming' mean a
 *  wallet was asked and this record cannot know whether money moved — demote
 *  to 'failed' with the honest sentence, so the retry is the USER'S informed
 *  act, never an automatic re-arm. 'awaiting' survives untouched: the bridge
 *  is re-polled by txHash. */
function demoteMidSignature(s: ThesisRunStep): ThesisRunStep {
  if (s.state !== 'signing' && s.state !== 'confirming') return s
  return { ...s, state: 'failed', note: INTERRUPTED_MID_SIGNATURE_NOTE }
}

/** Best-effort persist (see the header: a MISSING resume is safe — the user
 *  re-plans from fresh reads — so a quota/privacy failure degrades silently
 *  rather than blowing up the live flow between two wallet prompts). */
export function saveThesisRun(run: ThesisRun, storage?: Storage): void {
  const store = storage ?? defaultStorage()
  if (!store) return
  try {
    store.setItem(
      thesisRunKey(run.signer, run.ref, run.direction),
      JSON.stringify({ ...run, steps: run.steps.map(serializeStep) }),
    )
  } catch {
    /* quota, privacy mode — the in-memory run still drives this session */
  }
}

/** Sanitize-on-read: ANY violation reads as no-run (null) — a hostile or
 *  half-written blob must never crash the overlay or resume wrongly
 *  (bridge-pending.ts's precedent). What comes back has the money-law
 *  demotion already applied. */
export function loadThesisRun(
  signer: string,
  ref: string,
  direction: ThesisRunDirection,
  storage?: Storage,
): ThesisRun | null {
  const store = storage ?? defaultStorage()
  if (!store) return null
  let raw: string | null
  try {
    raw = store.getItem(thesisRunKey(signer, ref, direction))
  } catch {
    return null
  }
  if (!raw) return null
  let blob: unknown
  try {
    blob = JSON.parse(raw)
  } catch {
    return null
  }
  const run = parseRun(blob, signer, ref, direction)
  if (run == null) return null
  return { ...run, steps: run.steps.map(demoteMidSignature) }
}

export function clearThesisRun(
  signer: string,
  ref: string,
  direction: ThesisRunDirection,
  storage?: Storage,
): void {
  const store = storage ?? defaultStorage()
  if (!store) return
  try {
    store.removeItem(thesisRunKey(signer, ref, direction))
  } catch {
    /* an unwritable store has nothing to clear */
  }
}
