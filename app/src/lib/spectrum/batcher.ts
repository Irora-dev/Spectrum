import { parseAbi, zeroAddress, type Address, type PublicClient } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { BATCH_FEE_BPS } from './allocation'
import { showSymbol } from './safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// THE BATCHER INTEGRATION LAYER — slice A of PHASE3-READINESS.md, built DARK
// (the owner's confirm, 2026-08-03 ~18:1x: "yes do all these"). Nothing here is
// reachable from any UI path while SIMULATED is true; this is the calldata,
// floor, and simulation foundation the real runner will stand on.
//
// The integration contract (PLAN.md Phase 3, relayed whole 2026-08-02) is the
// single source for every signature and struct below. Two laws enforced at
// composition, not hoped for at runtime:
//
//  · VENUE ENUMS DO NOT ALIGN AND MUST NEVER BE CAST. The pools lib says
//    {V4=0, V3=1, V2=2, V4Q=3}; the batcher says {0=V4, 1=V3, 2=V2,
//    3=BASKET}. The value 3 is a STOCKS-FORK VENUE on one side and a BASKET
//    LEG on the other — a naive cast would submit a V4Q leg as a basket and
//    run someone's money through the wrong acquisition path. Mapping is
//    explicit; a venue with no batcher meaning REFUSES at composition.
//  · FLOORS ARE NEVER ZERO on token legs (contract rule 1 — zero floors
//    revert on-chain anyway; we refuse to compose them so the failure is a
//    sentence at review time, not a revert at signing time). Two NAMED
//    exceptions, so no reader trusts a guard that is not there (battle-test
//    half-1 finding 8): `aggMinBps` and `refPriceX96` ship 0 — their
//    semantics are contracts-owed (readiness E4 rows) and a made-up bound
//    would be worse than a stated absence.
//
// ONE ABI, THREE CHAINS — after a morning of two (SpectrumContracts,
// 2026-08-04, twice, the later note winning): their first measurement found
// the robinhood lineage diverged (five-field params, no integrator); the owner
// had the fee split ported the same morning, so ALL THREE chains now share
// the six-field BatchParams and the same selectors, forge-inspected on both
// builds. What SURVIVES from the two-batchers hour: the explicit chain map
// (an unmapped chain still refuses — never a guessed struct) and the
// SELECTOR PINS (test-computed from this ABI vs the forge values — a struct
// drift here fails a test instead of reverting on chain; this tripwire is
// what caught the divergence in the first place). Ceremony caveat: the
// robinhood PORT is a money-path change owing its own adversarial pass +
// mutation run before 4663's ceremony — Base-first is unaffected.
// ─────────────────────────────────────────────────────────────────────────────

export const batcherAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Leg { uint8 venue; address asset; PoolKey ethPool; uint24 v3Fee; address v2Pair; uint256 budget; uint256 minOut; uint256 refPriceX96; bool optional; }',
  'struct BatchResult { uint256 spentFunding; uint256 hubOut; uint256 feeEth; uint256 ethRefunded; uint256 usdcRefunded; uint256[] outs; uint256 skippedBitmap; }',
  'struct BatchParams { address recipient; uint256 deadline; uint256 hubMinOut; uint16 aggMinBps; uint16 feeBps; address integrator; }',
  'function batchBuy(Leg[] legs, address fundingAsset, uint256 fundingTotal, BatchParams p) payable returns (BatchResult result)',
  'function batchRebalance(Leg[] sells, Leg[] buys, address fundingAsset, uint256 fundingTopUp, BatchParams p) payable returns (BatchResult result)',
  'function claimIntegratorFees(address integrator)',
  'function flushBurn()',
])

/** Chains a batcher build exists for — an unmapped chain REFUSES at
 *  composition rather than defaulting to a struct shape that may not match
 *  its deployment (the two-batchers hour's surviving law). */
export const BATCHER_CHAINS = new Set([1, 8453, 4663])

/** The measured selectors (forge inspect, contracts 2026-08-04, post-port:
 *  identical on all three chains) — pinned in tests against the ABI above. */
export const BATCH_BUY_SELECTOR: `0x${string}` = '0xc3b25c36'
export const BATCH_REBALANCE_SELECTOR: `0x${string}` = '0xce932a32'

/** The batcher's own venue words. NOT the pools lib's — see the header. */
export const BATCHER_VENUE = { V4: 0, V3: 1, V2: 2, BASKET: 3 } as const

/** Raw funding units, BRANDED (battle-test half-1 finding 1, the cents/raw
 *  seam): plan-legs speaks integer CENTS and this layer speaks the funding
 *  asset's raw units, and the two once shared the plain-bigint field
 *  `budgetRaw` — a cents value composed as raw with zero refusal, and the
 *  displayed-vs-signed gate could not catch it because display and calldata
 *  derived from the same wrong number. The brand makes cents-as-raw a TYPE
 *  error: only `asFundingRaw` mints one, and it lives at the runner's
 *  scaling step, the one place the conversion is real. */
export type FundingRaw = bigint & { readonly __brand: 'FundingRaw' }
export function asFundingRaw(raw: bigint): FundingRaw {
  if (raw < 0n) throw new BatchComposeRefusal('a negative funding amount is not an amount')
  return raw as FundingRaw
}

export interface BatcherLegInput {
  symbol: string
  asset: Address
  /** The pools lib's route for this asset (find-best-pool's own struct), or
   *  'basket' for a basket leg (runs the basket's inner acquisition). */
  route: { venue: Venue; ethPool: PoolKey; v3Fee: number; v2Pair: Address } | 'basket'
  /** Funding to spend on this leg, RAW UNITS of the funding asset — the
   *  brand refuses cents at the type layer (see FundingRaw). */
  budgetRaw: FundingRaw
  /** OUR quote basis for the leg's output (raw out units) — floors derive
   *  from THIS, never from any aggregator's claim (readiness law B2). */
  quotedOutRaw: bigint
  /** THE LEG'S FLOOR, raw out units. Venue legs: derived per-asset and
   *  batch-aware by the floor discipline at plan time (floor-discipline.ts —
   *  BACKEND-FLOOR-DISCIPLINE.md is the binding spec; the contract verifies
   *  against whatever number we supply and cannot judge it). Basket legs: the
   *  assembly's legacy haircut. composeLeg CARRIES this number — floor
   *  derivation has exactly one home, and it is not here. */
  minOutRaw: bigint
  /** The review marked this leg skippable (thin-leg consent, contract rule 4). */
  optional: boolean
}

export interface ComposedLeg {
  venue: number
  asset: Address
  ethPool: PoolKey
  v3Fee: number
  v2Pair: Address
  budget: bigint
  minOut: bigint
  refPriceX96: bigint
  optional: boolean
}

export class BatchComposeRefusal extends Error {
  constructor(
    message: string,
    readonly leg?: string,
  ) {
    super(message)
    this.name = 'BatchComposeRefusal'
  }
}

const ZERO_KEY: PoolKey = {
  currency0: zeroAddress,
  currency1: zeroAddress,
  fee: 0,
  tickSpacing: 0,
  hooks: zeroAddress,
}

/**
 * THE FUNDING EQUATION — the one place the fee's relationship to the money
 * lives (seam round, 2026-08-04). The basis is MEASURED now, off the deployed
 * source by contracts (SpectrumBatcher.sol, their desk note 2026-08-04 16:02)
 * — and it is THREE regimes, not the one-basis binary the question assumed:
 *
 *  · batchBuy — INCLUSIVE, taken off the PULL (L352-353):
 *        feeEth  = fundingTotal × feeBps / BPS
 *        forLegs = fundingTotal − feeEth
 *    i.e. sum(legBudgets) = fundingTotal − fee(fundingTotal) — this module's
 *    original equation, which began as the fail-safe reading and turned out
 *    to be the contract's own arithmetic. To fund legs S, pull
 *    ceil(S·BPS/(BPS−f)).
 *    ⚠ SETTLEMENT-FUNDED batchBuy realises the fee's ETH as its PRO-RATA
 *    SHARE OF THE ACTUAL HUB EXECUTION, rounding up (L375, confirmed by
 *    contracts 2026-08-04 eve): feeUsdc = fundingTotal×f/BPS is exact in
 *    settlement terms, but feeEth = mulDivRoundingUp(hubOut, feeUsdc, hubIn)
 *    moves with the hub fill. Never pin exact feeEth on a settlement-funded
 *    batch against fundingTotal×f — pin it against the realised hubOut. The
 *    native path's feeEth IS exact (carved before any swap, already in the
 *    burn's denomination — that asymmetry is deliberate and is what made the
 *    hub-floor mis-denomination possible).
 *
 *  · batchRebalance, fully funded — ADDITIVE, on venueBuyBudget (L524-525):
 *        feeEth  = venueBuyBudget × feeBps / BPS
 *        ethNeed = venueBuyBudget + feeEth
 *    The OPPOSITE direction: supply B·(BPS+f)/BPS, never B·BPS/(BPS−f). The
 *    basis is the VENUE buys ONLY — basket-venue buys in a rebalance are
 *    untaxed, and SELLS ARE NEVER TAXED (a sell-only rebalance has
 *    venueBuyBudget = 0, therefore fee = 0; any projection that multiplies
 *    exit volume by feeBps is wrong by model, pinned contract-side in
 *    BatcherVenueSells.t.sol).
 *
 *  · batchRebalance, UNDER-funded — the fee is RE-DERIVED from what actually
 *    arrived (L561-565): feeEth = ethHave × feeBps / (BPS + feeBps), legs
 *    scale pro-rata. NOT an error path: sell proceeds fund the ETH side and
 *    cannot be known exactly at compose time, so any rebalance whose sells
 *    come in light lands here — the fee prediction must treat regime 2 as a
 *    CEILING ("at most what regime 2 predicted, less when sells come light"),
 *    never as the exact charge.
 *
 * With integer floors the regimes agree EXACTLY at the fully-funded boundary:
 * rebalanceFeeRawFromActual(rebalanceEthNeedRaw(B)) === rebalanceFeeRawOnBudget(B)
 * (write B·f = a·BPS + r with r < BPS; then (B+a)·f = a·(BPS+f) + r, so the
 * floor is a). Pinned as a property, so "regime 3 is regime 2's inverse" is a
 * test, not prose.
 *
 * Mixing the bases is DIRECTIONAL, which is why one code path is a trap:
 * the inclusive gross-up where additive belongs OVER-funds by ~f² (comes back
 * as the refund line the review shows); the additive formula where inclusive
 * belongs UNDER-funds — BudgetsExceedFunding revert, or a starved last leg,
 * which is F9's exact prediction and the failure this equation was born
 * fixing (`composeBatchBuy` once required sum(legs) === fundingTotal with no
 * fee term at all).
 */
export function feeCentsOfTotal(totalCents: number, feeBps: number = BATCH_FEE_BPS): number {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0
  return Math.floor((Math.floor(totalCents) * clampBps(feeBps)) / 10_000)
}

/** The gross total to pull so that the LEGS can spend exactly `legCents`.
 *  The inverse of the equation above, rounded UP: under-funding starves a leg,
 *  over-funding comes back as a refund, so the rounding goes the safe way. */
export function fundingTotalForLegCents(legCents: number, feeBps: number = BATCH_FEE_BPS): number {
  if (!Number.isFinite(legCents) || legCents <= 0) return 0
  const bps = clampBps(feeBps)
  if (bps >= 10_000) return 0 // a 100% fee leaves nothing to spend: not a plan
  return Math.ceil((Math.floor(legCents) * 10_000) / (10_000 - bps))
}

/** Regime 2 (batchRebalance, fully funded): the contract's fee in the
 *  contract's own domain — floor(venueBuyBudget·f/BPS), mirrored exactly so a
 *  sizing prediction and the chain never disagree by a rounding direction.
 *  venueBuyBudget ≤ 0 returns 0: a sells-only rebalance pays NO fee by model. */
export function rebalanceFeeRawOnBudget(venueBuyBudgetRaw: bigint, feeBps: number = BATCH_FEE_BPS): bigint {
  if (venueBuyBudgetRaw <= 0n) return 0n
  return (venueBuyBudgetRaw * BigInt(clampBps(feeBps))) / 10_000n
}

/** Regime 2: what the ETH side must supply to fully fund `venueBuyBudgetRaw`
 *  — the fee sits ON TOP (L524-525), so this is budget + fee, never the
 *  inclusive gross-up. Supplying less does not revert; it lands the batch in
 *  regime 3 and the legs scale pro-rata. */
export function rebalanceEthNeedRaw(venueBuyBudgetRaw: bigint, feeBps: number = BATCH_FEE_BPS): bigint {
  if (venueBuyBudgetRaw <= 0n) return 0n
  return venueBuyBudgetRaw + rebalanceFeeRawOnBudget(venueBuyBudgetRaw, feeBps)
}

/** Regime 3 (under-funded rebalance): the fee re-derived from what actually
 *  arrived — floor(ethHave·f/(BPS+f)), the exact integer inverse of regime 2
 *  (see the equation block: at ethHave = ethNeed(B) this equals
 *  rebalanceFeeRawOnBudget(B), pinned as a property). Monotone in ethHave, so
 *  regime 2's prediction is a CEILING on the fee whenever sells come in light. */
export function rebalanceFeeRawFromActual(ethHaveRaw: bigint, feeBps: number = BATCH_FEE_BPS): bigint {
  if (ethHaveRaw <= 0n) return 0n
  const f = BigInt(clampBps(feeBps))
  return (ethHaveRaw * f) / (10_000n + f)
}

/** Regime 2 in the plan's denominator (integer cents), fee rounded UP — the
 *  planning-safe direction: a cent over-reserved comes back with the refund
 *  line, a cent under-reserved silently drops a fully-funded plan into
 *  regime 3 and shaves the legs it promised to fill. The raw functions above
 *  stay the contract truth.
 *
 *  ⚠⚠ RETURNS THE TOTAL — BUDGET PLUS FEE — NOT THE FEE (corrected 2026-08-08,
 *  adversarial pass). This docblock used to end "this is the figure
 *  `ChainNeed.feeCents` carries for a rebalance chain", and it is the ONLY
 *  instruction whoever wires this will have. funding-plan sums
 *  `buysCents + feeCents` at two sites, so following the sentence gives
 *  `{ buysCents: 1_000_000, feeCents: 1_004_000 }` — a $10,000 rebalance
 *  drawing $20,040, DOUBLE the request. And `fundingConservationErrors` agrees
 *  it is fine, because it re-derives the need with the same sum: the check and
 *  the mistake share an assumption, so the arithmetic is self-consistently
 *  wrong. This module's own test treats the return as a total, which is what
 *  says the SENTENCE was wrong rather than the function.
 *
 *  For a rebalance chain: `buysCents` is the budget, `feeCents` is
 *  `feeCentsOfTotal(budget)`, and THIS is what the two of them sum to. No
 *  production caller exists yet, which is precisely why the doc had to be
 *  fixed before one does. */
export function rebalanceNeedCentsOnBudget(budgetCents: number, feeBps: number = BATCH_FEE_BPS): number {
  if (!Number.isFinite(budgetCents) || budgetCents <= 0) return 0
  const b = Math.floor(budgetCents)
  return b + Math.ceil((b * clampBps(feeBps)) / 10_000)
}

/**
 * THE RUNNER'S SCALING STEP — cents become the funding asset's raw units, with
 * conservation BY CONSTRUCTION (seam round, 2026-08-04).
 *
 * This step existed only as a comment ("the runner scales") — the one seam in
 * the pipeline with no code and no test, and the seam the cents/raw bug lived
 * in. Building it surfaced the reason it could not be a multiplication:
 *
 * THE FEE IS COMPUTED IN TWO DOMAINS. Cents are the plan's denominator, because
 * dollars are the only thing comparable across chains and assets. But the
 * CONTRACT computes its fee in raw units — so `floor(700c × 50bps) = 3c` while
 * the chain's own arithmetic gives 3.5c. Scaling per-leg cent budgets up to raw
 * therefore over-budgets the legs by up to half a cent, and `composeBatchBuy`'s
 * exact law correctly refuses the whole plan. Measured: $7, $1, $999.99 and
 * $123,456.78 all failed to compose; $1,000 and $50,000 happened to divide
 * evenly and passed. A pipeline that only works on round numbers is not a
 * pipeline.
 *
 * So the raw budgets are DISTRIBUTED from the raw spendable — largest remainder
 * over the cent weights, the same method `centBudgets` uses one domain down —
 * which makes `sum(legsRaw) === spendable` true by construction rather than by
 * luck. The cent figures remain the display and funding-plan truth; raw is
 * derived from them but reconciled against the total the CONTRACT will see.
 */
export function scaleLegBudgetsToRaw(legCents: number[], fundingTotalRaw: FundingRaw, feeBps: number = BATCH_FEE_BPS): FundingRaw[] {
  const total = fundingTotalRaw as bigint
  const spendable = total - (total * BigInt(clampBps(feeBps))) / 10_000n
  const weights = legCents.map((c) => (Number.isFinite(c) && c > 0 ? Math.floor(c) : 0))
  const weightSum = weights.reduce((a, b) => a + b, 0)
  if (spendable <= 0n || weightSum <= 0) return legCents.map(() => asFundingRaw(0n))

  // integer floor share per leg, then hand the remainder out largest-fraction
  // first — so the sum is EXACTLY `spendable`, never a cent over or under
  const floors = weights.map((w) => (spendable * BigInt(w)) / BigInt(weightSum))
  let remainder = spendable - floors.reduce((a, b) => a + b, 0n)
  const order = weights
    .map((w, i) => ({ i, frac: (spendable * BigInt(w)) % BigInt(weightSum) }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : 0))
  for (let k = 0; remainder > 0n && order.length > 0; k += 1, remainder -= 1n) {
    floors[order[k % order.length].i] += 1n
  }
  return floors.map((f) => asFundingRaw(f))
}

/** Year ~5138 in unix seconds. Not a policy window (the runner sets that from
 *  the chain's own clock) — a sanity ceiling, so a wei-scale paste cannot
 *  become a signature that never expires. */
export const MAX_PLAUSIBLE_DEADLINE_SEC = 100_000_000_000

/** A basket leg costs ~6 plain legs of the 32-leg cap (contract rule 6). */
export const BATCH_LEG_CAP = 32
export const BASKET_LEG_WEIGHT = 6

export function batchCapCost(legs: { route: BatcherLegInput['route'] }[]): number {
  return legs.reduce((s, l) => s + (l.route === 'basket' ? BASKET_LEG_WEIGHT : 1), 0)
}

/** One leg, composed under the two laws. Throws BatchComposeRefusal with a
 *  review-grade sentence — composition failures are sentences, not reverts.
 *  The floor arrives ON the leg (see BatcherLegInput.minOutRaw) — this
 *  function carries it, it never derives one. */
export function composeLeg(input: BatcherLegInput): ComposedLeg {
  if (input.budgetRaw <= 0n) throw new BatchComposeRefusal(`$${showSymbol(input.symbol)}: a leg with no budget cannot be composed`, input.symbol)
  const minOut = input.minOutRaw
  if (minOut <= 0n)
    throw new BatchComposeRefusal(
      `$${showSymbol(input.symbol)}: this leg carries no floor — a zero floor protects nothing and the contract reverts it`,
      input.symbol,
    )
  // ⚠⚠ `optional` IS CONSENT, AND IT WAS UNVALIDATED (self-audit, 2026-08-07 —
  // the same asymmetry an independent reviewer found in pool-safety, where
  // tickSpacing was checked and feeBps was not: here the floor two lines up is
  // validated and the consent flag beside it was not).
  //
  // MEASURED: `undefined`, `null`, `'yes'`, `1` and `0` all composed and rode
  // into the calldata unchanged. This flag decides whether the contract may
  // SILENTLY SKIP this leg (rule 4) — the difference between "the user agreed
  // this asset may be dropped" and "the user required it". A non-boolean
  // reaching the ABI encoder either coerces (turning an absent consent into a
  // definite answer nobody gave) or throws deep in viem, which this module's
  // own law says must never be how a bad input surfaces.
  if (typeof input.optional !== 'boolean')
    throw new BatchComposeRefusal(
      `$${showSymbol(input.symbol)}: whether this leg may be skipped was not answered — a consent that is not yes or no is not a consent`,
      input.symbol,
    )
  if (input.route === 'basket') {
    return {
      venue: BATCHER_VENUE.BASKET,
      asset: input.asset,
      ethPool: ZERO_KEY,
      v3Fee: 0,
      v2Pair: zeroAddress,
      budget: input.budgetRaw,
      minOut,
      refPriceX96: 0n,
      optional: input.optional,
    }
  }
  const venue =
    input.route.venue === Venue.V4
      ? BATCHER_VENUE.V4
      : input.route.venue === Venue.V3
        ? BATCHER_VENUE.V3
        : input.route.venue === Venue.V2
          ? BATCHER_VENUE.V2
          : null
  if (venue == null)
    throw new BatchComposeRefusal(
      `$${showSymbol(input.symbol)}: its pool venue has no batcher route (V4Q is the stocks fork's venue, not a batch leg) — this leg cannot ride the batch`,
      input.symbol,
    )
  return {
    venue,
    asset: input.asset,
    ethPool: input.route.ethPool,
    v3Fee: input.route.v3Fee,
    v2Pair: input.route.v2Pair,
    budget: input.budgetRaw,
    minOut,
    refPriceX96: 0n,
    optional: input.optional,
  }
}

export interface ComposeBatchBuyInput {
  /** The chain this batch signs on — picks the batcher FAMILY (two builds,
   *  two structs, two selectors). An unmapped chain refuses. */
  chainId: number
  legs: BatcherLegInput[]
  /** Native ETH = zeroAddress sentinel here; else the chain's settlement asset
   *  (contract rule 2 — nothing else composes). */
  fundingAsset: Address
  fundingTotalRaw: FundingRaw
  recipient: Address
  /** The signer. "Everything lands in your own wallet" is a PRODUCT LAW —
   *  recipient must equal owner or composition refuses (threat-model E1: a
   *  compromised caller must not be able to point outputs elsewhere). */
  owner: Address
  deadlineSec: number
  /** OUR aggregate floor on the funding→hub swap, raw. */
  hubMinOutRaw: bigint
  /** The integrator the fee split accrues to — earns on ALL chains since the
   *  robinhood port (contracts 2026-08-04, second note). zeroAddress = none,
   *  stated explicitly — never defaulted. */
  integrator: Address
}

export type ComposedBatchBuy = {
  capCost: number
  value: bigint
  args: readonly [
    ComposedLeg[],
    Address,
    bigint,
    { recipient: Address; deadline: bigint; hubMinOut: bigint; aggMinBps: number; feeBps: number; integrator: Address },
  ]
}

export function composeBatchBuy(input: ComposeBatchBuyInput): ComposedBatchBuy {
  if (!BATCHER_CHAINS.has(input.chainId))
    throw new BatchComposeRefusal(
      `chain ${input.chainId} has no known batcher build — composing against a guessed struct shape is how money reverts (or worse)`,
    )
  if (input.legs.length === 0) throw new BatchComposeRefusal('an empty batch is not a plan')
  const capCost = batchCapCost(input.legs)
  if (capCost > BATCH_LEG_CAP)
    throw new BatchComposeRefusal(
      `this plan weighs ${capCost} of the batcher's ${BATCH_LEG_CAP}-leg budget (a basket leg counts ${BASKET_LEG_WEIGHT}) — it must split`,
    )
  if (!(input.fundingTotalRaw > 0n)) throw new BatchComposeRefusal('no funding to batch')
  // THE CENTS/RAW SEAM'S RUNTIME HALF (finding 1; the FundingRaw brand is the
  // type half): leg budgets must add up to exactly what the batch pulls. A
  // mismatch in either direction means two layers disagree about what a
  // number denominates, and no floor can protect money that was mis-scaled
  // before any floor was derived.
  const budgetSum = input.legs.reduce((s, l) => s + l.budgetRaw, 0n)
  // THE FUNDING EQUATION (see feeCentsOfTotal): the legs spend what is left
  // after the contract's fee, so the check needs the FEE TERM it was missing.
  // Requiring sum(legs) === fundingTotal made the batch pull only the net and
  // let the contract take its cut out of the legs — every floor then sat ~fee
  // above what its leg could actually buy.
  const total = input.fundingTotalRaw as bigint
  const feeRaw = (total * BigInt(BATCH_FEE_BPS)) / 10_000n
  const spendable = total - feeRaw
  if (budgetSum !== spendable)
    throw new BatchComposeRefusal(
      `the legs' budgets sum to ${budgetSum} but this batch can only spend ${spendable} of the ${total} it pulls (the rest is the ${BATCH_FEE_BPS}bps fee) — refusing before any floor is derived from a budget the legs will not receive`,
    )
  if (input.recipient === zeroAddress) throw new BatchComposeRefusal('recipient must be explicit — never assumed (contract rule 3)')
  if (input.recipient.toLowerCase() !== input.owner.toLowerCase())
    throw new BatchComposeRefusal('recipient must be the signer — everything lands in your own wallet, structurally')
  if (input.hubMinOutRaw <= 0n) throw new BatchComposeRefusal('the hub floor is zero — floors derive from our quote basis, never omitted')
  // BigInt() on a float throws a RAW RangeError — composition failures are
  // sentences, not crashes (finding 7)
  // A DEADLINE MUST BE A PLAUSIBLE UNIX SECOND (the hostile-number sweep,
  // 2026-08-04): `Number.isInteger(1e21)` is TRUE, so a wei-scale value pasted
  // into a seconds field composed a deadline ~30 trillion years out — a
  // permanent authorization wearing a signature, which is exactly the standing-
  // grant shape P1 exists to forbid on the permit side. Bounded above as well
  // as below; the ceiling is generous (year 5138) because this module cannot
  // read a clock, and the runner bounds it tightly against the CHAIN's own
  // timestamp at signing (readiness §5b).
  if (!Number.isInteger(input.deadlineSec) || input.deadlineSec <= 0 || input.deadlineSec > MAX_PLAUSIBLE_DEADLINE_SEC)
    throw new BatchComposeRefusal(
      'the deadline is not a plausible unix second — refusing to sign time that cannot be said exactly, or that never expires',
    )
  const legs = input.legs.map((l) => composeLeg(l))
  const isNative = input.fundingAsset === zeroAddress
  return {
    args: [
      legs,
      input.fundingAsset,
      input.fundingTotalRaw as bigint,
      {
        recipient: input.recipient,
        deadline: BigInt(input.deadlineSec),
        hubMinOut: input.hubMinOutRaw,
        aggMinBps: 0,
        feeBps: BATCH_FEE_BPS,
        integrator: input.integrator,
      },
    ] as const,
    value: isNative ? (input.fundingTotalRaw as bigint) : 0n,
    capCost,
  }
}

/**
 * ⚠ WHAT THIS RESULT DOES AND DOES NOT PROVE — read before rendering "you spent
 * X on leg N" (SpectrumContracts, measured 2026-08-04 in
 * spectrum-contracts/test/V3PartialFill.t.sol; their desk item to this lane).
 *
 * `outs` IS TRUSTWORTHY: the batcher measures each leg's OUTPUT by balance
 * delta, so "you received Y of this asset" is an honest sentence.
 *
 * THE INPUT SIDE IS ASSUMED, NOT MEASURED, and on a V3 leg that gap is real
 * money. With a router that spends only part of what it is offered, their
 * measurement was: 1.0 ETH offered to the leg, 0.4 ETH actually spent, 0.6 ETH
 * STRANDED IN THE ROUTER, asset delivered 0.4 (correctly proportional), 0.99 ETH
 * refunded — and the batch SUCCEEDED, with both of the batcher's end-state
 * asserts passing and `ethRefunded` looking entirely normal. So from this struct
 * a partial-fill loss is INDISTINGUISHABLE from a clean batch: there is no field
 * here to detect it from, which is why this warning is a comment rather than a
 * guard.
 *
 * THE RULE FOR THIS LANE, until the contract fix lands: do not render a
 * per-leg SPENT figure sourced from the leg's requested budget. On a thin V3
 * pool the requested and the spent differ and the difference is unrecoverable,
 * so such a sentence would be confidently wrong about someone's money. Show
 * what was RECEIVED (`outs`), which is measured. The hold applies to composing
 * a V3 leg onto a chain with real V3 liquidity; it is moot while the batch path
 * is dark (SIMULATED, and no batcher is seated in deployments.json), which is
 * the only reason this is a note instead of a blocker.
 *
 * One thing deliberately NOT claimed, because they did not measure it: whether
 * Uniswap's own SwapRouter02 under-spends in practice. What is measured is what
 * OUR contract does when a router under-spends. Treat the frequency as unknown
 * and the consequence as established.
 */
export interface BatchSimResult {
  spentFunding: bigint
  hubOut: bigint
  feeEth: bigint
  ethRefunded: bigint
  usdcRefunded: bigint
  outs: readonly bigint[]
  skippedBitmap: bigint
}

/** Which legs the simulation skipped (rule 4's consent surface, decoded). */
export function skippedLegs(result: Pick<BatchSimResult, 'skippedBitmap'>, legCount: number): number[] {
  const out: number[] = []
  for (let i = 0; i < legCount; i++) if ((result.skippedBitmap >> BigInt(i)) & 1n) out.push(i)
  return out
}

/** Simulate the EXACT call that would be signed (readiness §5: the simulated
 *  request object is what gets written, so the bytes cannot drift between
 *  preview and signature). Throws viem's decorated error on revert — the
 *  caller maps it to a review-grade sentence, and a revert IS the floor
 *  check biting (the contract enforces every floor we composed).
 *
 *  E1's SIGNER-BOUND half (battle-test half-1 finding 2): compose checks
 *  recipient===owner, but owner is a caller-supplied STRING — the one party
 *  this last gate can actually verify is the account about to sign. A
 *  mismatch here is exactly the compromised-caller case E1 exists to stop,
 *  refused at the last gate before bytes. */
export async function simulateBatchBuy(
  client: PublicClient,
  batcher: Address,
  account: Address,
  composed: ComposedBatchBuy,
) {
  const recipient = composed.args[3].recipient
  if (account.toLowerCase() !== recipient.toLowerCase())
    throw new BatchComposeRefusal(
      'the signing account is not the composed recipient — refusing to simulate a batch whose outputs land somewhere the signer never named',
    )
  return client.simulateContract({
    address: batcher,
    abi: batcherAbi,
    functionName: 'batchBuy',
    args: composed.args,
    account,
    value: composed.value,
  })
}

function clampBps(bps: number): number {
  if (!Number.isFinite(bps)) return 0
  return Math.min(Math.max(Math.round(bps), 0), 10_000)
}
