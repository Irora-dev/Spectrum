import { feeGenerationFor } from '../chain/deployments'
// ─────────────────────────────────────────────────────────────────────────────
// THE ALLOCATION MODEL — the portfolio flow's spine (PLAN.md Phase 1, spec:
// docs/allocator/PORTFOLIO-FLOW.md). Pure data + reducers, no React, no chain:
// the flow's screens drive these, the simulated runner advances them, and the
// tests pin them. Persistence is injectable storage so tests never touch the
// real localStorage.
//
// The braindead law lives here as a shape: the user's decisions are exactly
// (assets, weights, amount). Chains exist on the asset records because the
// system resolved them — the user never chose one.
// ─────────────────────────────────────────────────────────────────────────────

// 50, was 12 (the owner 2026-08-06 11:20 — two rulings, one number): the reshape
// popup greyed out Review & Execute on his 13-asset demo book because ANY dial
// composed 13 targets > 12 ("gated by the amount of assets, which is wrong"),
// and the portfolio should "support up to like 25 to 50 assets". The integer-
// weight doctrine (every leg ≥1% of 100) puts the mathematical ceiling at 100;
// 50 honors both rulings while the too-many-legs refusal stays honest above it.
// Real-run gas for a wide batch is the simulate-before-sign law's job, per leg,
// at execution time — a UI cap was never the right guard for that.
export const MAX_ALLOCATION_ASSETS = 50

/** Picker-first Create (the owner 2026-08-01 20:26): picking starts BEFORE any
 *  wallet exists. The pre-connect draft lives under this scope and adopts
 *  into the wallet's scope at connect. */
export const GUEST_SCOPE = 'guest'

/** THE ENGINE IS SIMULATED — a property of the CODE, not of an env flag (PM
 *  review 2026-08-01, blocking finding 1: labels were env-gated while the
 *  engine simulates unconditionally, so a production build could claim assets
 *  were in the wallet). Every "live"/"approve"/"in your wallet" string keys
 *  off THIS constant; it flips only when Phase 3 wires real execution. */
export const SIMULATED = false

/** THE BATCHING-FEE LEVER — bps-shaped per the RULED model (the owner 2026-08-02,
 *  resolving the two-models conflict; supersedes the 08-01 capped-never-flat
 *  principle row): FLAT bps on BUYS ONLY, NOT capped, under the contract's
 *  immutable MAX_FEE_BPS = 200 ceiling. Zero on exits; a
 *  rebalance charges once, on the buy side of the diff only; the skim sits
 *  INSIDE the user's floor at the real execution price, INSIDE any route
 *  comparison (never added after), and never stacks with LiFi's integrator fee
 *  on one route. Governing design:
 *  spectrum-contracts/docs/BATCH-PERIPHERY-DESIGN-2026-08-02.md.
 *
 *  Both residuals RULED (the owner, 2026-08-02 ~12:20 — the fee model is WHOLE,
 *  no open questions): (1) ~~"0.5% from launch and always" — 50 bps from day
 *  one, permanent~~ — the RATE is SUPERSEDED 2026-08-07 (amendment below); the
 *  "from launch and always" half still stands, i.e. no wire-at-zero and no
 *  introductory rate, the amended number is charged from day one;
 *  (2) the publish waiver is DEAD —
 *  a batch that later publishes still pays (the batcher earns its fee on
 *  assembly; publishing seeds only a portion, so the overlap stays small).
 *  Also final: a zero-rated corner for basket-buys inside rebalances
 *  (contracts-side, in the governing design).
 *
 *  ⚠ AMENDED 50 → 40 BPS (the owner, 2026-08-07, relayed by R): 0x charges the
 *  taker its OWN mandatory fee on top of ours on the aggregator path, and
 *  0.65% total was too much. The ruling moves OUR number only. Nothing
 *  contract-side changes — `feeBps` is a per-call field of `BatchParams`, not
 *  a bytecode constant, so this line IS the change (no redeploy).
 *
 *  ⚠⚠ AND THE CONTRACT CANNOT ENFORCE THIS (SpectrumContracts, 2026-08-07):
 *  `MAX_FEE_BPS = 200` permits FIVE TIMES this policy, and `feeRecipient` is
 *  validated only against the zero address. The contract trusts calldata for
 *  both the fee RATE and its DESTINATION, so this constant and the params
 *  builder are the only things holding the policy. Treat a divergence between
 *  the charged number and the shown number as a money defect, not a copy nit —
 *  which is why nothing anywhere may restate this figure as a literal. */
export const BATCH_FEE_BPS = 40

/** THE GENERATION-2 BATCH FEE (the owner's fee-model ruling, 2026-08-16): 0.25%
 *  ours, 100% buys-and-burns PRISM, no integrator — 0x's ~15 bps skim makes
 *  ~0.4% all-in on aggregator legs. Applies ONLY where deployments.json seats
 *  a generation-2 batcher (feeGeneration: 2); resolve through
 *  `batchFeeBpsFor`, never by reading this constant directly. */
export const GEN2_BATCH_FEE_BPS = 25

/** The batch fee THIS chain's deployed batcher generation charges — the one
 *  resolver every compose/display path must use (a hardcoded BATCH_FEE_BPS at
 *  a call site becomes a silent 15 bps overcharge the day a chain flips). */
export function batchFeeBpsFor(chainId: number): number {
  return feeGenerationFor(chainId) === 2 ? GEN2_BATCH_FEE_BPS : BATCH_FEE_BPS
}

/** 0x'S OWN TAKER FEE, which is NOT ours and which we cannot switch off
 *  (measured by SpectrumContracts, 2026-08-07; it is the reason the ruling
 *  above happened). It is charged by the aggregator inside the quote, so it
 *  never appears in `BatchParams` and never reaches our fee recipient.
 *
 *  ⚠ IT IS MODELLED HERE FOR ONE PURPOSE ONLY: so a surface that discloses
 *  the all-in cost COMPUTES it instead of restating it. Do NOT read this as
 *  "every buy pays 55 bps" — it applies to the 0x-composed path alone, and
 *  that path is dark (`ZEROEX_COMPOSE_ENABLED`). A blanket all-in figure would
 *  be a false sentence on a money surface for every leg that never touches 0x.
 *  Callers must gate on the path, not on this constant's existence. */
export const ZEROEX_TAKER_FEE_BPS = 15

/** What the user pays all-in on a leg, in bps — ours plus the aggregator's
 *  where the aggregator is in the route. `viaZeroEx: false` returns our fee
 *  unchanged, because that is the honest total on a route 0x never saw. */
export function allInFeeBps(viaZeroEx: boolean, ourFeeBps: number = BATCH_FEE_BPS): number {
  return viaZeroEx ? ourFeeBps + ZEROEX_TAKER_FEE_BPS : ourFeeBps
}

/** The fee as a percentage STRING for copy — the one formatter every surface
 *  uses, so no sentence can drift from the charged number. 40 → "0.40%". */
export function feePctLabel(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`
}

export interface AllocAsset {
  chainId: number
  address: string
  symbol: string
  /** Venue + routable depth ride along from resolution (the launch page's own
   *  numbers) so the review screen can be honest about where a buy would land. */
  venueLabel?: string
  depthUsd?: number | null
}

export interface AllocTarget {
  asset: AllocAsset
  /** Relative weight (≥1). Display always normalizes to 100% — same doctrine
   *  as the bundle forge's normalizedLegs. */
  weight: number
}

/** The door the user walked through — a starting posture, not a fork: it sets
 *  the default outcome and the review framing, and stays flippable at review
 *  (rework spec 2026-08-01; "the manager system is actually more the create
 *  flow" — the owner). */
export type FlowIntent = 'keep' | 'publish'

/** HOW the diff fills — the channel checkout (blend spec, the owner-confirmed
 *  2026-08-02: "adding, rebalancing or selling should be able to be done
 *  through the three execution [channels]"). Market is the only executable
 *  channel until the keyed orderbook lands (E2/E3); the others render at
 *  their true state and are never a dead confirm. */
export type ExecutionChannel = 'market' | 'limit' | 'slices'
export const EXECUTION_CHANNELS: ExecutionChannel[] = ['market', 'limit', 'slices']

/** Chains where a limit order can actually be filled. Kept here rather than
 *  imported from `cow.ts` so this module stays dependency-free; a test pins the
 *  two lists equal, which is what stops them drifting apart. */
export const COW_LIMIT_CHAIN_IDS: number[] = [1, 8453]

/**
 * Is this channel executable — and WHERE.
 *
 * `chainId` is optional so existing call sites keep compiling, and omitting it
 * FAILS CLOSED: a caller that has not proven which chain it is on does not get
 * to offer a limit order. That deliberately preserves today's behaviour exactly
 * (limit was executable nowhere), so this change can only ever widen the gate at
 * a call site that opts in by passing its chain — never loosen it by accident.
 * Widening a guard is safe; loosening one is not.
 *
 * WHY PER-CHAIN. Limit orders ride CoW, and CoW's settlement, ComposableCoW and
 * TWAP handler all read NO CODE on Robinhood 4663 (probed 2026-08-02) — while
 * every live Spectrum basket is on 4663. Offering "only at your price" there
 * would present a control that can never fill, which is exactly the dead confirm
 * this codebase refuses.
 *
 * `slices` stays false everywhere. A CoW TWAP is a ComposableCoW conditional
 * order whose owner must be a forwarding CONTRACT: measured, 36 conditional-order
 * owners on Base, 29 Safes, 6 other contracts, ZERO EOAs — and no mainstream
 * wallet lets a dApp install its own EIP-7702 delegate. The user-facing benefit
 * of "spread over time" is delivered honestly instead by a partially-fillable
 * limit, which fills in pieces as the market reaches it; `order-intent.ts`
 * computes which outcome a given price actually buys.
 */
export const channelExecutable = (c: ExecutionChannel, chainId?: number): boolean => {
  if (c === 'market') return true
  if (c === 'limit') return chainId != null && COW_LIMIT_CHAIN_IDS.includes(chainId)
  return false
}

/** How the flow was entered. A seed declares intent, so the doors are skipped
 *  (rework spec: "Bundle this" from a basket page, "Rebalance" from Yours). */
export type SeedKind = 'none' | 'rebalance' | 'basket-version' | 'basket-page'
export interface FlowSeed {
  kind: SeedKind
  chainId?: number
  address?: string
}

export interface AllocationDraft {
  targets: AllocTarget[]
  amountUsd: number | null
  intent: FlowIntent
  /** The basket's name (Door B) — the ONE product the user is creating; the
   *  per-network split is presentation-wise behind the scenes (the owner 18:41). */
  name?: string
  /** HOLDINGS-BACKED PUBLISH (the picker path, freeze IN-item wired
   *  2026-08-03): the picked positions' HELD values. Present = this publish
   *  seeds from what is already held (mintInKind converts the seeded
   *  portion; no new money) — the review says so and the completion records
   *  the KEPT remainder as the private portfolio. Display + bookkeeping;
   *  never an input to the money math. */
  seedFrom?: { chainId: number; address: string; symbol: string; heldUsd: number }[]
  /** Publish seeds a CHOSEN portion of each leg (four-gaps amendment,
   *  greenlit 2026-08-01): mintInKind CONVERTS, so all-in would kill the
   *  private portfolio. Percentage of every leg that seeds the basket;
   *  the rest stays raw and rebalanceable. Deliberate default, never 100. */
  seedPct?: number
  /** The creator's thesis, carried from the flow into the existing post-
   *  deploy ceremony at real wiring (never a second ceremony). */
  thesis?: string
  /** How the diff fills (channel checkout; blend spec). Absent = market. */
  channel?: ExecutionChannel
  /** THE SEED BOOK'S OWNER (desk-204, provenance half — closed 2026-08-12):
   *  the address whose HOLDINGS seeded this draft (the positions mode and the
   *  publish picker stamp it at their seams). Real execution refuses a draft
   *  whose book is the demo identity — a simulation must not become a
   *  signature by riding a draft across a wallet connect (adoptGuestDraft
   *  carries drafts, so the guest scope is exactly where that laundering
   *  happened). Provenance only; never an input to the money math. Absent on
   *  drafts built from scratch. */
  seedBookOwner?: string
  /** Rebalance context (positions mode): the sells funding this plan (incl.
   *  drawn cash) and the GROSS buys (the fee base — fees charge the buy side
   *  of the diff). Presence marks a rebalance draft — amountUsd is NET new
   *  money there and 0 is VALID (PM audit finding 2 + proof-audit K2). */
  funding?: {
    soldUsd: number
    grossBuysUsd?: number
    resultUsd?: number
    /** What the portfolio looked like when the plan was composed, one row per
     *  position. The review needs it to lead with what CHANGES rather than
     *  only showing the result (owner 17:53: "it's still a bit confusing as to
     *  what's actually happening… you're going to be decreasing these things,
     *  adding a new asset"). A snapshot of what the composer saw — display
     *  only, never an input to the money math, which reads live targets. */
    before?: { chainId: number; address: string; symbol: string; usd: number }[]
    /** The legs the user actually moved, with their EXACT ends. Recorded by the
     *  composer rather than re-derived in the review: the stored plan is
     *  integer percentages, so `pct × resultUsd` reintroduces up to half a
     *  point of the total per leg and invented changes on untouched positions.
     *  Display only, like `before`. */
    changes?: {
      chainId: number
      address: string
      symbol: string
      fromUsd: number
      /** Realized gain/loss on a TRIM where cost basis is KNOWN (baskets via
       *  the pnl index): frac-sold × (current − invested). Feature 4 — a
       *  factual receipt, absent wherever basis isn't known (never guessed).
       *  Display only. */
      realizedUsd?: number
      toUsd: number
      /** SELL legs only: the exact raw amount to sell, as a decimal string
       *  (bigint does not survive JSON). Computed at compose time as a
       *  PROPORTION of a holding we already know the size of, so it never has
       *  to be reconstructed from a USD figure and a price — which would round
       *  someone's money. Absent on adds, and on anything unpriced. */
      sellRaw?: string
      decimals?: number
    }[]
  }
  updatedAt: number
}

export const DEFAULT_SEED_PCT = 25

export const assetKey = (a: Pick<AllocAsset, 'chainId' | 'address'>) =>
  `${a.chainId}:${a.address.toLowerCase()}`

export function emptyDraft(now: number = Date.now()): AllocationDraft {
  return { targets: [], amountUsd: null, intent: 'keep', updatedAt: now }
}

/** A REBALANCE CANNOT BECOME A PUBLISH. `funding` marks a draft composed
 *  against an existing portfolio — the positions mode is its only writer — and
 *  the completion path saves the portfolio ONLY on the keep branch, then clears
 *  the draft either way. Flipping such a draft to publish therefore drops the
 *  rebalance that just ran, silently (UIGuy's finding on the two-page popup).
 *  Publishing what you already hold is real and wanted, but it is the QUEUED
 *  publish work, designed deliberately — never a toggle hit in passing.
 *  Guarded HERE, in the one pure choke point every caller goes through, rather
 *  than at the toggle: `?door=publish` applies an intent at load and never
 *  touches the toggle, so a toggle-only guard would leave that path open. */
export function setIntent(draft: AllocationDraft, intent: FlowIntent, now: number = Date.now()): AllocationDraft {
  if (intent === 'publish' && draft.funding) return draft
  return { ...draft, intent, updatedAt: now }
}

export function setChannel(draft: AllocationDraft, channel: ExecutionChannel, now: number = Date.now()): AllocationDraft {
  return { ...draft, channel, updatedAt: now }
}

/** Weights ARE percentages (the owner 18:41: a stepper moves ONE asset, never the
 *  others; the review gate demands the total hit exactly 100). */
export function weightSum(draft: AllocationDraft): number {
  return draft.targets.reduce((s, t) => s + t.weight, 0)
}

/** Exact-100 even distribution (largest remainder), so "even it out" and the
 *  add-time default always pass the 100% gate without touching a stepper. */
function evenWeights(n: number): number[] {
  if (n <= 0) return []
  const base = Math.floor(100 / n)
  const extra = 100 - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

export function addTarget(draft: AllocationDraft, asset: AllocAsset, now: number = Date.now()): AllocationDraft {
  if (draft.targets.some((t) => assetKey(t.asset) === assetKey(asset))) return draft
  if (draft.targets.length >= MAX_ALLOCATION_ASSETS) return draft
  // Adding re-splits evenly — a fresh pick set starts balanced; the
  // independent steppers take over from there.
  const targets = [...draft.targets, { asset, weight: 0 }]
  const even = evenWeights(targets.length)
  // A holdings-backed publish (seedFrom) is only true for exactly its picked
  // set: an added asset is money the wallet does NOT hold, so the marker
  // drops and the draft degrades to the buy-shaped publish — the same
  // designed fallback loadDraft applies to a draft that lost its origin.
  // The review's "no new money" strip disappears with it, never lies on.
  return {
    ...draft,
    targets: targets.map((t, i) => ({ ...t, weight: even[i] })),
    ...(draft.seedFrom ? { seedFrom: undefined } : {}),
    updatedAt: now,
  }
}

export function removeTarget(draft: AllocationDraft, asset: Pick<AllocAsset, 'chainId' | 'address'>, now: number = Date.now()): AllocationDraft {
  const targets = draft.targets.filter((t) => assetKey(t.asset) !== assetKey(asset))
  // Removing a picked leg keeps a holdings-backed publish holdings-backed:
  // that leg's seedFrom row leaves with it, and the pinned amount follows the
  // remaining held sum (mirrors buildPublishDraft — the review derives leg
  // dollars from amountUsd, so the two must agree about the same money).
  if (draft.seedFrom && draft.seedFrom.length > 0) {
    const gone = assetKey(asset)
    const rows = draft.seedFrom.filter((r) => assetKey(r) !== gone)
    return {
      ...draft,
      targets,
      seedFrom: rows.length > 0 ? rows : undefined,
      amountUsd: rows.length > 0 ? Math.round(rows.reduce((t, r) => t + r.heldUsd, 0) * 100) / 100 : draft.amountUsd,
      updatedAt: now,
    }
  }
  return { ...draft, targets, updatedAt: now }
}

export function setTargetWeight(draft: AllocationDraft, asset: Pick<AllocAsset, 'chainId' | 'address'>, weight: number, now: number = Date.now()): AllocationDraft {
  // A DIAL THAT CANNOT READ ITS INPUT DOES NOT MOVE (draft-lifecycle model
  // test, 2026-08-04): the clamp below guards RANGE, not readability —
  // Math.round(NaN) walks through min/max unchanged and a NaN weight landed
  // in the draft the station renders and the composer reads. The §3d shape
  // again: a law written for one representation of "bad".
  if (!Number.isFinite(weight)) return draft
  const w = Math.min(100, Math.max(1, Math.round(weight)))
  return {
    ...draft,
    targets: draft.targets.map((t) => (assetKey(t.asset) === assetKey(asset) ? { ...t, weight: w } : t)),
    updatedAt: now,
  }
}

export function evenSplit(draft: AllocationDraft, now: number = Date.now()): AllocationDraft {
  const even = evenWeights(draft.targets.length)
  return { ...draft, targets: draft.targets.map((t, i) => ({ ...t, weight: even[i] })), updatedAt: now }
}

export function setName(draft: AllocationDraft, name: string, now: number = Date.now()): AllocationDraft {
  return { ...draft, name: name.slice(0, 48), updatedAt: now }
}

export function setSeedPct(draft: AllocationDraft, seedPct: number, now: number = Date.now()): AllocationDraft {
  return { ...draft, seedPct: Math.min(100, Math.max(1, Math.round(seedPct))), updatedAt: now }
}

export function setThesis(draft: AllocationDraft, thesis: string, now: number = Date.now()): AllocationDraft {
  return { ...draft, thesis: thesis.slice(0, 500), updatedAt: now }
}

export function setAmount(draft: AllocationDraft, amountUsd: number | null, now: number = Date.now()): AllocationDraft {
  // NON-FINITE IS NOT AN AMOUNT (draft-lifecycle model test, 2026-08-04):
  // `Number('1e999')` from a text field is Infinity, `Math.max(0, Infinity)`
  // kept it, and the review's Investing figure — the number the confirm gates
  // on — displayed it as a fact. NaN only fell out by accident of `NaN > 0`.
  // Both refuse to null here at the OP, not just at the storage boundary.
  const amt = amountUsd == null || !Number.isFinite(amountUsd) ? null : Math.max(0, amountUsd)
  return { ...draft, amountUsd: amt && amt > 0 ? amt : null, updatedAt: now }
}

export interface NormalizedTarget extends AllocTarget {
  pct: number
  /** Dollar slice at the draft's amount (0 when no amount is set). */
  usd: number
}

/** Weights → percentages that always sum to 100 (largest-remainder rounding,
 *  so the display never shows 33+33+33=99). Non-finite or negative weights
 *  sanitize to 0 first — NaN <= 0 is false, so without this a corrupt weight
 *  rendered "NaN%" and a negative one produced a negative CSS width (PM
 *  review, contained finding a). */
export function normalizedTargets(draft: AllocationDraft): NormalizedTarget[] {
  const clean = draft.targets.map((t) =>
    Number.isFinite(t.weight) && t.weight > 0 ? t : { ...t, weight: 0 },
  )
  const total = clean.reduce((s, t) => s + t.weight, 0)
  if (total <= 0 || clean.length === 0) return clean.map((t) => ({ ...t, pct: 0, usd: 0 }))
  return normalizeClean(clean, total, draft.amountUsd ?? 0)
}

function normalizeClean(targets: AllocTarget[], total: number, amount: number): NormalizedTarget[] {
  const draft = { targets, amountUsd: amount }
  const exact = draft.targets.map((t) => (t.weight / total) * 100)
  const floors = exact.map(Math.floor)
  let leftover = 100 - floors.reduce((s, f) => s + f, 0)
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
  const pcts = [...floors]
  for (const { i } of order) {
    if (leftover <= 0) break
    pcts[i] += 1
    leftover -= 1
  }
  return draft.targets.map((t, i) => ({ ...t, pct: pcts[i], usd: (amount * pcts[i]) / 100 }))
}

// ── persistence (local-first — G6 recommendation; an on-chain note is public,
//    so a PRIVATE portfolio is never a note) ─────────────────────────────────

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function safeStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null // privacy mode — the draft is session-only then
  }
}

const draftKey = (addr: string) => `spectrum:allocation:draft:${addr.toLowerCase()}`
const execKey = (addr: string) => `spectrum:allocation:exec:${addr.toLowerCase()}`
const portfolioKey = (addr: string) => `spectrum:allocation:portfolio:${addr.toLowerCase()}`

function read<T>(key: string, storage: StorageLike | null): T | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown, storage: StorageLike | null) {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    /* full or blocked — the flow still works, it just won't survive refresh */
  }
}

function remove(key: string, storage: StorageLike | null) {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** A ceiling on a DOLLAR amount crossing the storage seam. $1 trillion is far
 *  past any real portfolio and far below where a wei-scale paste lands, so it
 *  separates "an amount" from "evidence something is wrong" without ever
 *  refusing a real one (redteam round 8). */
export const MAX_PLAUSIBLE_AMOUNT_USD = 1e12

/** ONE read-time validator for everything that crosses the localStorage seam
 *  (PM review: four contained findings, all the same seam). A malformed blob
 *  must degrade to "start fresh", never to a white screen. */
function validTarget(t: unknown): t is AllocTarget {
  if (!t || typeof t !== 'object') return false
  const x = t as { asset?: { address?: unknown; chainId?: unknown; symbol?: unknown }; weight?: unknown }
  return (
    !!x.asset &&
    typeof x.asset.address === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(x.asset.address) &&
    typeof x.asset.symbol === 'string' &&
    Number.isFinite(x.asset.chainId as number) &&
    Number.isFinite(x.weight as number)
  )
}

function sanitizeTargets(targets: unknown): AllocTarget[] {
  if (!Array.isArray(targets)) return []
  // ONE ROW PER ASSET (draft-lifecycle model test, 2026-08-04): the count cap
  // stopped 500 stored targets becoming 500 legs, but 12 copies of the SAME
  // asset walked through it — duplicate keys make removeTarget/setTargetWeight
  // touch the first row while the review renders every copy, and the composer
  // would budget one asset twice. First occurrence wins, same as every other
  // boundary here.
  const seen = new Set<string>()
  return targets
    .filter(validTarget)
    .filter((t) => {
      const key = `${t.asset.chainId}:${t.asset.address.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((t) => ({ ...t, weight: Math.min(100, Math.max(1, Math.round(t.weight))) }))
    .slice(0, MAX_ALLOCATION_ASSETS)
}

export function loadDraft(addr: string, storage: StorageLike | null = safeStorage()): AllocationDraft | null {
  const d = read<AllocationDraft>(draftKey(addr), storage)
  if (!d || !Array.isArray(d.targets)) return null
  // The funding block is resolved FIRST because the intent depends on it.
  // `setIntent` guards TRANSITIONS; deserialisation is not a transition, so a
  // draft persisted with BOTH publish and funding would walk straight back into
  // the state that guard exists to forbid (UIGuy's finding). That state is
  // reachable rather than theoretical: the flip was allowed, and persisted,
  // until 9523f5c — so a browser that flipped one before then still holds it.
  // This is the trust boundary where targets, amountUsd, channel and seedPct
  // are all clamped already; the invariant belongs here, not in a migration.
  const funding =
    d.funding && Number.isFinite(d.funding.soldUsd) && d.funding.soldUsd >= 0
      ? {
          soldUsd: Math.round(d.funding.soldUsd * 100) / 100,
          grossBuysUsd:
            Number.isFinite(d.funding.grossBuysUsd as number) && (d.funding.grossBuysUsd as number) >= 0
              ? Math.round((d.funding.grossBuysUsd as number) * 100) / 100
              : undefined,
          resultUsd:
            Number.isFinite(d.funding.resultUsd as number) && (d.funding.resultUsd as number) > 0
              ? Math.round((d.funding.resultUsd as number) * 100) / 100
              : undefined,
          // Display-only snapshot, but it crosses the storage seam like
          // everything else here, so it is clamped like everything else here:
          // a malformed row is dropped rather than rendered as a stray leg.
          before: Array.isArray(d.funding.before)
            ? d.funding.before
                .filter(
                  (b) =>
                    b &&
                    Number.isFinite(b.chainId) &&
                    typeof b.address === 'string' &&
                    /^0x[0-9a-fA-F]{40}$/.test(b.address) &&
                    typeof b.symbol === 'string' &&
                    Number.isFinite(b.usd) &&
                    b.usd >= 0,
                )
                .slice(0, MAX_ALLOCATION_ASSETS * 2)
                .map((b) => ({
                  chainId: b.chainId,
                  address: b.address.toLowerCase(),
                  symbol: b.symbol.slice(0, 16),
                  usd: Math.round(b.usd * 100) / 100,
                }))
            : undefined,
          changes: Array.isArray(d.funding.changes)
            ? d.funding.changes
                .filter(
                  (c) =>
                    c &&
                    Number.isFinite(c.chainId) &&
                    typeof c.address === 'string' &&
                    /^0x[0-9a-fA-F]{40}$/.test(c.address) &&
                    typeof c.symbol === 'string' &&
                    Number.isFinite(c.fromUsd) &&
                    c.fromUsd >= 0 &&
                    Number.isFinite(c.toUsd) &&
                    c.toUsd >= 0,
                )
                .slice(0, MAX_ALLOCATION_ASSETS * 2)
                .map((c) => ({
                  chainId: c.chainId,
                  address: c.address.toLowerCase(),
                  symbol: c.symbol.slice(0, 16),
                  fromUsd: Math.round(c.fromUsd * 100) / 100,
                  toUsd: Math.round(c.toUsd * 100) / 100,
                  realizedUsd: Number.isFinite(c.realizedUsd) ? Math.round((c.realizedUsd as number) * 100) / 100 : undefined,
                  // a raw amount must be digits or it is not a raw amount
                  sellRaw: typeof c.sellRaw === 'string' && /^\d+$/.test(c.sellRaw) ? c.sellRaw : undefined,
                  decimals:
                    Number.isInteger(c.decimals) && (c.decimals as number) >= 0 && (c.decimals as number) <= 36
                      ? c.decimals
                      : undefined,
                }))
            : undefined,
        }
      : undefined
  // holdings-backed publish marker (the picker path) — rows validated like
  // funding.before; a publish that lost its origin degrades to buy-shaped
  // wording, never to wrong numbers
  const seedFromRows =
    Array.isArray(d.seedFrom) && d.intent === 'publish' && !funding
      ? d.seedFrom
          .filter(
            (r) =>
              r &&
              Number.isFinite(r.chainId) &&
              typeof r.address === 'string' &&
              /^0x[0-9a-fA-F]{40}$/.test(r.address) &&
              typeof r.symbol === 'string' &&
              Number.isFinite(r.heldUsd) &&
              r.heldUsd > 0,
          )
          .slice(0, MAX_ALLOCATION_ASSETS)
          .map((r) => ({
            chainId: r.chainId,
            address: r.address.toLowerCase(),
            symbol: r.symbol.slice(0, 16),
            heldUsd: Math.round(r.heldUsd * 100) / 100,
          }))
      : undefined
  return {
    targets: sanitizeTargets(d.targets),
    // funding present (a rebalance) → amountUsd 0 is valid; otherwise > 0 only.
    // A HOLDINGS-BACKED publish pins the amount to its own held sum (mirrors
    // buildPublishDraft): the review derives leg dollars from amountUsd while
    // the seed strip states the held values — a stored draft carrying any
    // other number would make one page contradict itself about the same money.
    //
    // AND BOUNDED ABOVE (redteam round 8, 2026-08-04): the check was
    // `isFinite && > 0`, so a stored `1e21` survived the trust boundary into
    // the number the review DISPLAYS and the confirm GATES ON. Anyone who can
    // write this storage can already do worse — but "we read our own storage
    // as intent" is exactly where a bound belongs, and an amount past the
    // ceiling is evidence of tampering or of a wei value pasted into a dollar
    // field, neither of which is an amount to spend.
    amountUsd:
      seedFromRows && seedFromRows.length > 0
        ? Math.round(seedFromRows.reduce((t, r) => t + r.heldUsd, 0) * 100) / 100
        : Number.isFinite(d.amountUsd as number) &&
            (d.amountUsd as number) <= MAX_PLAUSIBLE_AMOUNT_USD &&
            ((d.amountUsd as number) > 0 || (d.funding != null && (d.amountUsd as number) === 0))
          ? d.amountUsd
          : null,
    // Drafts persisted before the doors existed carry no intent — keep is the
    // default door. A funding draft is a rebalance and can never read back as
    // publish, however it was written (see the note above).
    intent: d.intent === 'publish' && !funding ? 'publish' : 'keep',
    name: typeof d.name === 'string' ? d.name.slice(0, 48) : undefined,
    seedPct: Number.isFinite(d.seedPct as number) ? Math.min(100, Math.max(1, Math.round(d.seedPct as number))) : undefined,
    seedFrom: seedFromRows && seedFromRows.length > 0 ? seedFromRows : undefined,
    thesis: typeof d.thesis === 'string' ? d.thesis.slice(0, 500) : undefined,
    // Unknown/legacy channel values fall back to market (URL-intent law).
    channel: d.channel === 'limit' || d.channel === 'slices' ? d.channel : d.channel === 'market' ? 'market' : undefined,
    // Provenance survives the seam or drops — a malformed owner is no owner.
    // Absence reads as "built from scratch"; the arming gate cannot fail
    // closed here without refusing every hand-built draft ever stored.
    seedBookOwner:
      typeof d.seedBookOwner === 'string' && /^0x[0-9a-fA-F]{40}$/.test(d.seedBookOwner)
        ? d.seedBookOwner.toLowerCase()
        : undefined,
    funding,
    updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : 0,
  }
}
export function saveDraft(addr: string, draft: AllocationDraft, storage: StorageLike | null = safeStorage()) {
  write(draftKey(addr), draft, storage)
}
export function clearDraft(addr: string, storage: StorageLike | null = safeStorage()) {
  remove(draftKey(addr), storage)
}

export interface SavedPortfolio {
  targets: AllocTarget[]
  /** Drift-alert band, ± percentage points around each target's saved share
   *  (feature 3): inside the band, drift stays quiet; outside, the card
   *  fires. Plan-level v1; absent = the standing default. */
  bandPp?: number
  amountUsd: number
  executedAt: number
  /** True when the portfolio was assembled by the SIMULATED engine — the UI
   *  must say so and never present it as chain-confirmed (honesty law). */
  simulated: boolean
  /** True when this book was SEEDED from the wallet's holdings by the sign-in
   *  add (the owner 2026-08-13) rather than composed by the user. While it
   *  stands: drift never arms — "you set it at 9%" was a lie on day one,
   *  nothing was SET — and the book tops itself up as later reads surface
   *  holdings a partial first read missed. A flow save replaces the record
   *  wholesale and drops this flag: the user took the wheel. */
  seededFromHoldings?: boolean
}

/** Adopt the guest draft into a freshly connected wallet's scope. The wallet's
 *  own draft wins if it already holds targets; the guest scope clears either way. */
export function adoptGuestDraft(addr: string, storage: StorageLike | null = safeStorage()) {
  if (!addr || addr.toLowerCase() === GUEST_SCOPE) return
  const guest = loadDraft(GUEST_SCOPE, storage)
  if (!guest) return
  // "clears either way" is the promise — the old early-return on an empty
  // TARGETS list broke it (draft-lifecycle model test, 2026-08-04): a
  // target-less guest draft still carries amountUsd/name/thesis, and leaving
  // it meant the NEXT guest on this device inherited an amount they never
  // set. Adopt only a real draft; clear the guest scope regardless.
  if (guest.targets.length > 0) {
    const mine = loadDraft(addr, storage)
    if (!mine || mine.targets.length === 0) saveDraft(addr, guest, storage)
  }
  clearDraft(GUEST_SCOPE, storage)
}

export function loadPortfolio(addr: string, storage: StorageLike | null = safeStorage()): SavedPortfolio | null {
  const p = read<SavedPortfolio>(portfolioKey(addr), storage)
  if (!p || !Array.isArray(p.targets)) return null
  const targets = sanitizeTargets(p.targets)
  if (targets.length === 0 || !Number.isFinite(p.amountUsd)) return null
  const bandPp =
    Number.isFinite(p.bandPp) && (p.bandPp as number) >= 1 && (p.bandPp as number) <= 25
      ? Math.round(p.bandPp as number)
      : undefined
  return { ...p, targets, bandPp, simulated: p.simulated !== false }
}
/** Set/clear the plan's drift-alert band without touching anything else. */
export function savePortfolioBand(addr: string, bandPp: number | undefined, storage: StorageLike | null = safeStorage()) {
  const p = loadPortfolio(addr, storage)
  if (!p) return
  write(portfolioKey(addr), { ...p, bandPp }, storage)
}
export function savePortfolio(addr: string, p: SavedPortfolio, storage: StorageLike | null = safeStorage()) {
  write(portfolioKey(addr), p, storage)
}
export function clearPortfolio(addr: string, storage: StorageLike | null = safeStorage()) {
  remove(portfolioKey(addr), storage)
}

// ── NAMED PLANS (feature 6) ──────────────────────────────────────────────────
// Several kept target-sets per address — "aggressive", "safe harbor" — adopted
// into the reshape dials on demand. Device-local like every draft; weights are
// relative (the flow's own doctrine) and sanitized on the way out.

export interface NamedPlan {
  name: string
  targets: AllocTarget[]
  savedAt: number
}

const plansKey = (addr: string) => `spectrum:plans:${addr.toLowerCase()}`

export function loadNamedPlans(addr: string, storage: StorageLike | null = safeStorage()): NamedPlan[] {
  const raw = read<NamedPlan[]>(plansKey(addr), storage)
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p) => p && typeof p.name === 'string' && p.name.trim().length > 0 && Array.isArray(p.targets))
    .map((p) => ({
      name: p.name.trim().slice(0, 24),
      targets: sanitizeTargets(p.targets),
      savedAt: Number.isFinite(p.savedAt) ? p.savedAt : 0,
    }))
    .filter((p) => p.targets.length > 0)
    .slice(0, 12)
}

export function saveNamedPlan(addr: string, plan: NamedPlan, storage: StorageLike | null = safeStorage()) {
  const rest = loadNamedPlans(addr, storage).filter((p) => p.name.toLowerCase() !== plan.name.trim().toLowerCase())
  write(plansKey(addr), [{ ...plan, name: plan.name.trim().slice(0, 24) }, ...rest].slice(0, 12), storage)
}

export function deleteNamedPlan(addr: string, name: string, storage: StorageLike | null = safeStorage()) {
  write(plansKey(addr), loadNamedPlans(addr, storage).filter((p) => p.name.toLowerCase() !== name.toLowerCase()), storage)
}

// ── THE WATCHLIST (feature 8) ────────────────────────────────────────────────
// Assets you're deciding about: ghost tiles in the reshape picture, one tap to
// fund. Device-local; symbols/addresses sanitized like targets.

const watchKey = (addr: string) => `spectrum:watch:${addr.toLowerCase()}`

export function loadWatchlist(addr: string, storage: StorageLike | null = safeStorage()): AllocAsset[] {
  const raw = read<AllocAsset[]>(watchKey(addr), storage)
  if (!Array.isArray(raw)) return []
  return sanitizeTargets(raw.map((a) => ({ asset: a, weight: 1 }))).map((t) => t.asset)
}

export function toggleWatch(addr: string, asset: AllocAsset, storage: StorageLike | null = safeStorage()): boolean {
  const cur = loadWatchlist(addr, storage)
  const k = assetKey(asset)
  const has = cur.some((a) => assetKey(a) === k)
  const next = has ? cur.filter((a) => assetKey(a) !== k) : [...cur, asset].slice(0, 16)
  write(watchKey(addr), next, storage)
  return !has
}

export function isWatched(addr: string, asset: AllocAsset, storage: StorageLike | null = safeStorage()): boolean {
  return loadWatchlist(addr, storage).some((a) => assetKey(a) === assetKey(asset))
}

// ── the execution plan (compute → execute) ──────────────────────────────────
//
// compilePlan turns a draft into ordered steps: the first chain's buys run
// first (funds are assumed to start there), each further chain gets a `fund`
// step (position funds on that network) before its buys. Real balances and
// real routing replace these assumptions in Phase 3 — the SHAPE (grouped by
// network, funding made visible, one row per action) is the product.

export type StepKind = 'fund' | 'buy' | 'batch' | 'create' | 'seedmint'
export type StepState = 'queued' | 'approve' | 'confirming' | 'done' | 'failed'

export interface PlanStep {
  id: string
  kind: StepKind
  chainId: number
  /** buy steps only */
  symbol?: string
  address?: string
  /** batch steps: how many assets land in the one transaction, and which. */
  count?: number
  symbols?: string[]
  usd: number
  state: StepState
}

export type PlanStatus = 'running' | 'done' | 'cancelled'

export interface ExecutionPlan {
  id: string
  steps: PlanStep[]
  amountUsd: number
  createdAt: number
  status: PlanStatus
  /** "Stop after this step" means AFTER: an in-flight step finishes before the
   *  run cancels (PM review, contained finding d — abandoning a step mid-
   *  confirmation becomes a money bug the moment execution is real). */
  stopRequested?: boolean
}

export function compilePlan(draft: AllocationDraft, now: number = Date.now()): ExecutionPlan {
  const norm = normalizedTargets(draft)
  const chains: number[] = []
  for (const t of norm) if (!chains.includes(t.asset.chainId)) chains.push(t.asset.chainId)

  const steps: PlanStep[] = []
  chains.forEach((chainId, ci) => {
    const group = norm.filter((t) => t.asset.chainId === chainId)
    const slice = group.reduce((s, t) => s + t.usd, 0)
    if (draft.intent === 'publish') {
      // Door B: one ordinary basket per network, seeded with the CHOSEN
      // portion of the holdings (mintInKind converts what it seeds; the
      // remainder stays raw — four-gaps amendment). Launch fee is read live
      // at signing, never compiled in here.
      const seedPct = draft.seedPct ?? DEFAULT_SEED_PCT
      steps.push({ id: `create:${chainId}`, kind: 'create', chainId, usd: (slice * seedPct) / 100, state: 'queued' })
      steps.push({ id: `seed:${chainId}`, kind: 'seedmint', chainId, usd: 0, state: 'queued' })
      return
    }
    if (ci > 0) {
      steps.push({ id: `fund:${chainId}`, kind: 'fund', chainId, usd: slice, state: 'queued' })
    }
    // Door A batches: ALL of a network's buys land in ONE transaction — the
    // batch-swap periphery's shape (the owner 2026-08-01: "reduce txs of 20 asset
    // purchases down to 3 — that's the whole appeal"). The batcher compresses
    // transactions; it never wraps: assets still land raw in the wallet.
    steps.push({
      id: `batch:${chainId}`,
      kind: 'batch',
      chainId,
      count: group.length,
      symbols: group.map((t) => t.asset.symbol),
      usd: slice,
      state: 'queued',
    })
  })

  return {
    id: `alloc-${now.toString(36)}`,
    steps,
    amountUsd: draft.amountUsd ?? 0,
    createdAt: now,
    status: 'running',
  }
}

export function currentStep(plan: ExecutionPlan): PlanStep | null {
  return plan.steps.find((s) => s.state !== 'done') ?? null
}

/** Promote the first queued step to `approve` (start, and after each done). */
export function armNext(plan: ExecutionPlan): ExecutionPlan {
  const i = plan.steps.findIndex((s) => s.state === 'queued')
  if (i < 0) return plan
  const steps = plan.steps.slice()
  steps[i] = { ...steps[i], state: 'approve' }
  return { ...plan, steps }
}

export function startPlan(plan: ExecutionPlan): ExecutionPlan {
  return armNext(plan)
}

/** One tick of progress: approve→confirming, confirming→done (arming the next
 *  step), no-op on failed (needs an explicit retry) and when finished. */
export function advancePlan(plan: ExecutionPlan): ExecutionPlan {
  if (plan.status !== 'running') return plan
  const i = plan.steps.findIndex((s) => s.state !== 'done')
  if (i < 0) return { ...plan, status: 'done' }
  const step = plan.steps[i]
  if (step.state === 'failed') return plan
  const steps = plan.steps.slice()
  if (step.state === 'approve') {
    steps[i] = { ...step, state: 'confirming' }
    return { ...plan, steps }
  }
  if (step.state === 'confirming') {
    steps[i] = { ...step, state: 'done' }
    const done = { ...plan, steps }
    if (done.stopRequested) return { ...done, status: 'cancelled' }
    const next = done.steps.findIndex((s) => s.state === 'queued')
    if (next < 0) return { ...done, status: 'done' }
    return armNext(done)
  }
  // queued head (shouldn't happen mid-run) — arm it
  return armNext(plan)
}

/** Stop the run honestly: a step that hasn't been approved yet is abandoned at
 *  once; a step already confirming FINISHES first, then the run cancels. */
export function requestStop(plan: ExecutionPlan): ExecutionPlan {
  if (plan.status !== 'running') return plan
  const current = plan.steps.find((s) => s.state !== 'done')
  if (!current || current.state === 'queued' || current.state === 'approve' || current.state === 'failed') {
    return { ...plan, status: 'cancelled' }
  }
  return { ...plan, stopRequested: true }
}

export function failCurrent(plan: ExecutionPlan): ExecutionPlan {
  const i = plan.steps.findIndex((s) => s.state === 'approve' || s.state === 'confirming')
  if (i < 0) return plan
  const steps = plan.steps.slice()
  steps[i] = { ...steps[i], state: 'failed' }
  return { ...plan, steps }
}

export function retryStep(plan: ExecutionPlan, id: string): ExecutionPlan {
  return {
    ...plan,
    steps: plan.steps.map((s) => (s.id === id && s.state === 'failed' ? { ...s, state: 'approve' } : s)),
  }
}

/** Cancel between steps: what's done is yours (it is in your wallet); the
 *  remainder is abandoned and the UI says so plainly. */
export function cancelPlan(plan: ExecutionPlan): ExecutionPlan {
  if (plan.status !== 'running') return plan
  return { ...plan, status: 'cancelled' }
}

export function planProgress(plan: ExecutionPlan): { done: number; total: number } {
  return { done: plan.steps.filter((s) => s.state === 'done').length, total: plan.steps.length }
}

const STEP_STATES: StepState[] = ['queued', 'approve', 'confirming', 'done', 'failed']

// ── the published snapshot + divergence (four-gaps item 4: the post-publish
//    loop) — what was frozen, so the kept portfolio can be compared against it
//    and the republish-as-v2 nudge can RECUR when the position earns it. ─────

export interface PublishedSnapshot {
  targets: AllocTarget[]
  name?: string
  seedPct: number
  publishedAt: number
  simulated: boolean
}

const publishedKey = (addr: string) => `spectrum:allocation:published:${addr.toLowerCase()}`

export function loadPublished(addr: string, storage: StorageLike | null = safeStorage()): PublishedSnapshot | null {
  const p = read<PublishedSnapshot>(publishedKey(addr), storage)
  if (!p || !Array.isArray(p.targets)) return null
  const targets = sanitizeTargets(p.targets)
  return targets.length > 0 ? { ...p, targets } : null
}
export function savePublished(addr: string, p: PublishedSnapshot, storage: StorageLike | null = safeStorage()) {
  write(publishedKey(addr), p, storage)
}

/** How far the CURRENT targets sit from the published mix — the divergence
 *  that triggers the republish nudge. Max absolute per-asset weight gap, with
 *  assets present on only one side counted at their full weight. */
export function divergencePct(current: AllocTarget[], published: AllocTarget[]): number {
  const key = (t: AllocTarget) => assetKey(t.asset)
  const a = new Map(current.map((t) => [key(t), t.weight]))
  const b = new Map(published.map((t) => [key(t), t.weight]))
  let max = 0
  for (const [k, w] of a) max = Math.max(max, Math.abs(w - (b.get(k) ?? 0)))
  for (const [k, w] of b) if (!a.has(k)) max = Math.max(max, w)
  return max
}

export function loadExec(addr: string, storage: StorageLike | null = safeStorage()): ExecutionPlan | null {
  const p = read<ExecutionPlan>(execKey(addr), storage)
  if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return null // a 0-step "running" plan wedged the station forever
  const stepsValid = p.steps.every(
    (s) => s && typeof s.id === 'string' && Number.isFinite(s.chainId) && STEP_STATES.includes(s.state),
  )
  return stepsValid ? p : null
}
export function saveExec(addr: string, plan: ExecutionPlan, storage: StorageLike | null = safeStorage()) {
  write(execKey(addr), plan, storage)
}
export function clearExec(addr: string, storage: StorageLike | null = safeStorage()) {
  remove(execKey(addr), storage)
}
