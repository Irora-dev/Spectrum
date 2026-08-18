import { chainCfg, SUPPORTED_CHAIN_IDS } from '../../lib/chain/chains'
import { showChainId } from '../../lib/spectrum/safe-copy'
import type { ChainNeed } from '../../lib/spectrum/plan-shared-types'
import { formatAssetCeil } from '../../lib/spectrum/thesis-pay-asset'
import type { LegFunding, ThesisRun, ThesisRunStep, ThesisStepState } from '../../lib/spectrum/thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// THE RUN, AS LANES — the pure model behind ThesisRunOverlay (no React, no
// chain, no storage), extracted so the node test suite can drive every headline
// state the overlay paints without mounting a component (the house has no
// component-test rig — vitest here is `environment: node`, `src/**/*.test.ts`).
//
// One LANE per network: the leg's own story read out of the run's steps
// (switch → bridge → arrival → buy, or sell → send-home). The overlay renders
// lanes; it never re-derives money or state inline, so the number a test
// asserted is the number the screen shows.
//
// Deliberately imports ONLY modules that exist today (types + chain config +
// safe-copy): the four sibling modules land in parallel, and this file being
// green is what keeps the overlay's logic testable while they do.
// ─────────────────────────────────────────────────────────────────────────────

/** Exact dollars from integer cents. Never compacted: these sit on funding and
 *  landing lines, and "$1.2k" hides up to fifty dollars (the page's own law). */
export function usdCents(cents: number): string {
  const n = Number.isFinite(cents) ? cents / 100 : 0
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Integer cents → settlement raw (6dp USDC-family): cents × 10^4. The one
 *  place the overlay crosses the cents/raw seam on the way OUT (bridge + buy
 *  amounts), so it is bounded here and tested. Non-finite/≤0 → 0n, never NaN. */
export function centsToUsdcRaw(cents: number): bigint {
  if (!Number.isFinite(cents) || cents <= 0) return 0n
  return BigInt(Math.round(cents)) * 10_000n
}

/** Settlement raw → integer cents, FLOORED — a landed amount is never rounded
 *  up on a money line. Clamped into safe-integer range. */
export function rawToCentsFloor(raw: bigint): number {
  if (raw <= 0n) return 0
  const cents = raw / 10_000n
  return cents > 9_007_199_254_740_991n ? Number.MAX_SAFE_INTEGER : Number(cents)
}

/** "42s" · "4m" · "1h 12m" — the in-flight chip's clock. Clamps negative to 0s
 *  (a persisted startedAt ahead of a skewed device clock must not print -3s). */
export function elapsedLabel(sinceMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - sinceMs) / 1000))
  if (s < 90) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** A chain named by the app's OWN config and nothing else (the WrongNetwork
 *  rule). Unknown ids come back as honest words, never another chain's name —
 *  chainCfg throws on unknowns, so the guard runs first. */
export function chainLabel(chainId: number): string {
  return SUPPORTED_CHAIN_IDS.includes(chainId) ? chainCfg(chainId).name : `network ${showChainId(chainId)}`
}

/** The chain's settlement-token name for copy ("USDC" / "USDG"). Falls back to
 *  the family name where the chain cannot be named. */
export function settlementLabel(chainId: number): string {
  return SUPPORTED_CHAIN_IDS.includes(chainId) ? chainCfg(chainId).usdcSymbol : 'USDC'
}

/** Which lane a step belongs to. Buy-side bridges tell the DESTINATION leg's
 *  story ("bridge $135 to Base" is part of the Base lane); a post-sell
 *  consolidate tells the SOURCE chain's ("sold here, then sent home"). */
export function laneChainOf(step: ThesisRunStep): number {
  return step.kind === 'consolidate' ? (step.bridgeFromChainId ?? step.chainId) : step.chainId
}

export type LaneTone = 'queued' | 'working' | 'signing' | 'awaiting' | 'failed' | 'done' | 'skipped'

/** The little a lane needs to know about its leg. Symbol is RAW deployer text —
 *  the component wraps showSymbol at the render site, never here, so the model
 *  stays byte-faithful for tests. */
export interface LaneLeg {
  chainId: number
  address: string
  symbol: string
}

export interface Lane {
  chainId: number
  legAddress: string | null
  /** RAW deployer-controlled symbol — render only through showSymbol. */
  legSymbol: string | null
  /** The money this lane moves (buy share, or the sell's estimate), or null
   *  when the run does not carry one — absent beats invented. */
  dollarsCents: number | null
  /** Sell-side dollars are estimates; floors bind at signing, not here. */
  estimated: boolean
  steps: ThesisRunStep[]
  tone: LaneTone
  /** The honest sentence to surface (failed > skipped > awaiting), or null. */
  note: string | null
}

/** Lane headline from its steps' states, worst-news-first: a failure outranks
 *  everything, a live flight outranks a signature, and a lane is 'done' only
 *  when every step settled (skips count as settled — a refused leg is shown as
 *  skipped, never dressed as done: an all-skipped lane stays 'skipped'). */
export function laneTone(steps: readonly ThesisRunStep[]): LaneTone {
  if (steps.length === 0) return 'queued'
  if (steps.some((s) => s.state === 'failed')) return 'failed'
  if (steps.some((s) => s.state === 'awaiting')) return 'awaiting'
  if (steps.some((s) => s.state === 'signing')) return 'signing'
  if (steps.some((s) => s.state === 'confirming' || s.state === 'active')) return 'working'
  if (steps.every((s) => s.state === 'skipped')) return 'skipped'
  if (steps.every((s) => s.state === 'done' || s.state === 'skipped')) return 'done'
  return 'queued'
}

/** Group the run's steps into per-network lanes, in first-appearance order (the
 *  order the sequencer will walk them), joined to the legs for identity. */
export function deriveLanes(run: ThesisRun, legs: readonly LaneLeg[]): Lane[] {
  const order: number[] = []
  const byChain = new Map<number, ThesisRunStep[]>()
  for (const s of run.steps) {
    const c = laneChainOf(s)
    const list = byChain.get(c)
    if (list) list.push(s)
    else {
      byChain.set(c, [s])
      order.push(c)
    }
  }
  return order.map((chainId) => {
    const steps = byChain.get(chainId)!
    const leg = legs.find((l) => l.chainId === chainId) ?? null
    const trade = steps.find((s) => s.kind === 'buy' || s.kind === 'sell') ?? null
    const dollars = trade?.amountCents ?? null
    const note =
      steps.find((s) => s.state === 'failed' && s.note)?.note ??
      steps.find((s) => s.state === 'skipped' && s.note)?.note ??
      steps.find((s) => s.state === 'awaiting' && s.note)?.note ??
      null
    return {
      chainId,
      legAddress: leg?.address ?? trade?.legAddress ?? null,
      legSymbol: leg?.symbol ?? null,
      dollarsCents: dollars != null && dollars > 0 ? dollars : null,
      estimated: run.direction === 'sell',
      steps,
      tone: laneTone(steps),
      note,
    }
  })
}

/** Partial credit per state for the header bar. The bar is presentation — the
 *  authoritative "finished" verdict stays with the sequencer's runProgress —
 *  but the fill must be deterministic and monotone over a normal run, which is
 *  what the test pins. Skipped counts complete: the run will not do it. */
const STEP_CREDIT: Record<ThesisStepState, number> = {
  queued: 0,
  active: 0.15,
  signing: 0.35,
  confirming: 0.7,
  awaiting: 0.55,
  done: 1,
  skipped: 1,
  failed: 0.35,
}

export function runFraction(run: ThesisRun): number {
  if (run.steps.length === 0) return 0
  const sum = run.steps.reduce((acc, s) => acc + (STEP_CREDIT[s.state] ?? 0), 0)
  return Math.min(1, Math.max(0, sum / run.steps.length))
}

/** The first step that still has work in it (not done, not skipped) — the demo
 *  driver's cursor, and the fallback when the sequencer's activeStep answers
 *  null on a run that is visibly unfinished (e.g. blocked on a failure). */
export function firstUnsettledStep(run: ThesisRun): ThesisRunStep | null {
  return run.steps.find((s) => s.state !== 'done' && s.state !== 'skipped') ?? null
}

/** The one button's words. await-bridge has NO action — the network is working,
 *  not the user — and a consolidate with no measured amount offers nothing
 *  (it skips itself with the honest note instead of bridging a guess). */
export function primaryActionLabel(step: ThesisRunStep | null): string | null {
  if (!step) return null
  switch (step.kind) {
    case 'switch':
      return `Switch to ${chainLabel(step.chainId)}`
    case 'bridge':
      return step.amountCents != null && step.amountCents > 0
        ? `Bridge ${usdCents(step.amountCents)} to ${chainLabel(step.chainId)}`
        : `Bridge funds to ${chainLabel(step.chainId)}`
    case 'convert':
      // The pay amount is the QUOTED sizing, ≈-marked and rounded UP — never a
      // number the plan did not carry. A convert with no readable amount
      // offers no invented one.
      return step.payAmountRaw != null && step.payAmountRaw > 0n && step.paySymbol != null
        ? `Sell ≈${formatAssetCeil(step.payAmountRaw, step.payDecimals ?? 18)} ${step.paySymbol} for ${settlementLabel(step.chainId)} on ${chainLabel(step.chainId)}`
        : `Convert funds for ${chainLabel(step.chainId)}`
    case 'await-bridge':
      return null
    case 'buy':
      return `Buy the ${chainLabel(step.chainId)} leg`
    case 'sell':
      return `Sell the ${chainLabel(step.chainId)} leg`
    case 'consolidate':
      return step.amountCents != null && step.amountCents > 0
        ? `Bring ${usdCents(step.amountCents)} home to ${chainLabel(step.chainId)}`
        : null
  }
}

/** Ribbon word for a step — one lowercase word so the lane reads as a sentence
 *  of stations: switch → bridge → arrival → buy (or sell ETH → arrival → buy). */
export function describeStep(step: ThesisRunStep): string {
  switch (step.kind) {
    case 'switch':
      return 'switch'
    case 'bridge':
      return 'bridge'
    case 'convert':
      return step.paySymbol ? `sell ${step.paySymbol}` : 'convert'
    case 'await-bridge':
      return 'arrival'
    case 'buy':
      return 'buy'
    case 'sell':
      return 'sell'
    case 'consolidate':
      return 'send home'
  }
}

export function stepStateWords(state: ThesisStepState): string {
  switch (state) {
    case 'queued':
      return 'queued'
    case 'active':
      return 'ready'
    case 'signing':
      return 'in your wallet'
    case 'confirming':
      return 'confirming'
    case 'awaiting':
      return 'in flight'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed — you can retry'
    case 'skipped':
      return 'skipped'
  }
}

/** The aria-live sentence for a transition — plain words, network first. */
export function announceStep(step: ThesisRunStep): string {
  return `${chainLabel(laneChainOf(step))}: ${describeStep(step)} — ${stepStateWords(step.state)}`
}

/** The header's one number. Buy: the user's own total. Sell: the sum of the
 *  legs' estimates where the plan carried them — null when none did, because a
 *  header printing $0.00 over a real sale would be a lie of arithmetic. */
export function runTotalCents(run: ThesisRun): number | null {
  if (run.direction === 'buy') return run.amountCents > 0 ? run.amountCents : null
  const known = run.steps.filter((s) => s.kind === 'sell' && s.amountCents != null && s.amountCents > 0)
  if (known.length === 0) return null
  return known.reduce((acc, s) => acc + (s.amountCents ?? 0), 0)
}

/** What the run pays in the CHOSEN pay asset — the sum of its conversions'
 *  sized sales, for the header's "≈ 0.021 ETH from Ethereum funds it" line
 *  (the USD figure stays the anchor; this is the second truth beside it).
 *  null when the run has no conversions, and null on a mixed-asset run —
 *  a single sum over two different tokens is a wrong number, not a total. */
export function payAssetTotal(
  run: ThesisRun,
): { symbol: string; decimals: number; totalRaw: bigint; fromChainId: number } | null {
  const converts = run.steps.filter(
    (s) => s.kind === 'convert' && s.payAmountRaw != null && s.payAmountRaw > 0n && s.paySymbol != null,
  )
  if (converts.length === 0) return null
  const first = converts[0]
  const decimals = first.payDecimals ?? 18
  const from = first.bridgeFromChainId ?? first.chainId
  if (
    !converts.every(
      (s) => s.paySymbol === first.paySymbol && (s.payDecimals ?? 18) === decimals && (s.bridgeFromChainId ?? s.chainId) === from,
    )
  )
    return null
  return {
    symbol: first.paySymbol!,
    decimals,
    totalRaw: converts.reduce((acc, s) => acc + (s.payAmountRaw ?? 0n), 0n),
    fromChainId: from,
  }
}

export interface LandedRow {
  chainId: number
  /** RAW deployer symbol — showSymbol at the render site. */
  legSymbol: string | null
  /** The leg's address, for the buy-on-its-page door on a skipped row. */
  legAddress: string | null
  words: string
  /** The structured refusal riding a skipped lane (thesis-run-types) — doors
   *  key on this first; the sentence is the fallback for pre-code runs. */
  noteCode?: 'needs-funds' | 'gas-unsized' | 'gas-short'
  noteShortCents?: number
  /** false = the leg was skipped; the success plate says so rather than
   *  counting it among the networks now held. */
  ok: boolean
}

/** The success plate's per-network rows: what actually landed where, with a
 *  skipped leg stated instead of hidden. */
export function landedRows(run: ThesisRun, legs: readonly LaneLeg[]): LandedRow[] {
  return deriveLanes(run, legs).map((lane) => {
    if (lane.tone === 'skipped') {
      const skipped = lane.steps.find((s) => s.state === 'skipped' && (s.noteCode != null || s.noteShortCents != null))
      return {
        chainId: lane.chainId,
        legSymbol: lane.legSymbol,
        legAddress: lane.legAddress,
        words: lane.note ?? 'skipped',
        ok: false,
        ...(skipped?.noteCode ? { noteCode: skipped.noteCode } : {}),
        ...(skipped?.noteShortCents != null ? { noteShortCents: skipped.noteShortCents } : {}),
      }
    }
    const trade = lane.steps.find((s) => s.kind === 'buy' || s.kind === 'sell') ?? null
    if (run.direction === 'buy') {
      return {
        chainId: lane.chainId,
        legSymbol: lane.legSymbol,
        legAddress: lane.legAddress,
        words: lane.dollarsCents != null ? `${usdCents(lane.dollarsCents)} in` : 'landed',
        ok: true,
      }
    }
    let words = trade?.note ?? 'sold'
    if (lane.steps.some((s) => s.kind === 'consolidate' && s.state === 'done')) words += ' · proceeds sent home'
    else if (lane.steps.some((s) => s.kind === 'consolidate' && s.state === 'skipped')) words += ' · proceeds stayed here'
    return { chainId: lane.chainId, legSymbol: lane.legSymbol, legAddress: lane.legAddress, words, ok: true }
  })
}

// ── the demo walkthrough's script ────────────────────────────────────────────
// (Mid-signature resume safety is the STORE's job, not this file's:
// loadThesisRun demotes signing/confirming → failed with its honest note, so
// a resume never silently re-offers a signature it cannot vouch for.)

/** Synthetic fundings for the walkthrough: the home chain is fully funded, so
 *  every other leg is short by its whole share and bridges from home — the
 *  richest version of the flow (switch → bridge → arrival → buy) on screen,
 *  with nothing read and nothing armed. Cents are conserved by construction. */
export function demoFundings(needs: readonly ChainNeed[], homeChainId: number): LegFunding[] {
  const home = needs.some((n) => n.chainId === homeChainId) ? homeChainId : (needs[0]?.chainId ?? homeChainId)
  return needs.map((n) => {
    const local = n.chainId === home
    return {
      chainId: n.chainId,
      needCents: n.buysCents,
      haveCents: local ? n.buysCents : 0,
      shortfallCents: local ? 0 : n.buysCents,
      bridge: local ? null : { fromChainId: home, amountCents: n.buysCents, refuelWeiNeeded: null },
      gasOk: true,
      note: null,
    }
  })
}

/** What a driver may patch onto a step — exactly advanceStep's contract
 *  (state/note/bridgeTxHash; amounts travel through setStepAmount, never a
 *  patch, so a driver cannot invent money on a step). */
export type StepPatch = Partial<Pick<ThesisRunStep, 'state' | 'note' | 'bridgeTxHash'>>

export interface DemoTick {
  patches: [string, StepPatch][]
  /** How long to sit in the CURRENT state before applying — the pacing that
   *  makes the walkthrough watchable (bridges linger so the beam is seen). */
  delayMs: number
}

/** One beat of the walkthrough: given the run as it stands, the next honest
 *  transition and how long to hold before it. Pure, so the pacing and the
 *  terminal guarantee (every step reaches done) are testable without timers.
 *  Returns null when nothing is left to move. */
export function demoTick(run: ThesisRun): DemoTick | null {
  const step = firstUnsettledStep(run)
  if (!step) return null
  const arrivedCents =
    step.amountCents ?? run.steps.find((s) => s.kind === 'bridge' && s.chainId === step.chainId)?.amountCents ?? null
  switch (step.kind) {
    case 'switch':
      return { patches: [[step.id, { state: 'done' }]], delayMs: 1300 }
    case 'bridge':
    case 'convert': {
      // A convert walks the bridge's beats: it is a send from a source chain
      // whose arrival (when cross-chain) the paired await step then holds.
      // Nothing here quotes — the walkthrough's beats are timers, by law.
      if (step.state === 'signing') {
        const arrival = run.steps.find((s) => s.kind === 'await-bridge' && s.chainId === step.chainId)
        const patches: DemoTick['patches'] = [[step.id, { state: 'done' }]]
        if (arrival) patches.push([arrival.id, { state: 'awaiting' }])
        return { patches, delayMs: 900 }
      }
      return { patches: [[step.id, { state: 'signing' }]], delayMs: 1000 }
    }
    case 'await-bridge': {
      if (step.state === 'awaiting') {
        return {
          patches: [
            [step.id, { state: 'done', note: arrivedCents != null ? `${usdCents(arrivedCents)} arrived` : 'arrived' }],
          ],
          delayMs: 4000, // the beam's screen time
        }
      }
      return { patches: [[step.id, { state: 'awaiting' }]], delayMs: 300 }
    }
    case 'buy':
    case 'sell':
    case 'consolidate': {
      if (step.state === 'signing') return { patches: [[step.id, { state: 'confirming' }]], delayMs: 1400 }
      if (step.state === 'confirming') {
        const note =
          step.kind === 'buy'
            ? step.amountCents != null
              ? `${usdCents(step.amountCents)} in`
              : null
            : step.kind === 'sell'
              ? 'sold'
              : 'sent home'
        return { patches: [[step.id, { state: 'done', note }]], delayMs: 1200 }
      }
      return { patches: [[step.id, { state: 'signing' }]], delayMs: 1100 }
    }
  }
}
