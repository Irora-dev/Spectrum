import { encodeFunctionData, zeroAddress, type Address } from 'viem'
import { asFundingRaw, scaleLegBudgetsToRaw, BatchComposeRefusal, type FundingRaw } from './batcher'
import { concentrationOf, concentrationRefusal, planToLegs, type PlanConcentration, type PlanLegInput } from './plan-legs'
import { isDevPreview } from './dev-preview'
import { deriveLegFloors, singleSwapImpactBps, S_MAX_BPS, S_MAX_THIN_BPS, type FloorRefusal } from './floor-discipline'
import { validateLegQuote, ZeroExQuoteRefusal, type LegQuote, type ZeroExFetcher, ALLOWANCE_HOLDER } from './zeroex-quote'
import { showSymbol } from './safe-copy'
import { economicLegCap } from './economic-leg-cap'

// ─────────────────────────────────────────────────────────────────────────────
// SpectrumPortfolioBatcher COMPOSITION (plan §8, 2026-08-06 — built DARK).
//
// The compose path for the contract that actually deploys: portfolio-only,
// every swap via 0x AllowanceHolder, NO hub / baskets / venues. ABI + laws
// mirrored from the SHIPPING artifact — the ceremony message landed 2026-08-12
// (spectrum-contracts docs/abi/SpectrumPortfolioBatcher.rehearsal-2026-08-12
// .abi.json, identical bytes on all three chains), superseding the `0645ee2`
// pre-burn-leg source mirror. The selector is PINNED in tests and was
// re-verified CONTAINED in the deployed batcher bytecode on 8453 / 4663 / 1
// (2026-08-12, `cast code`, two voices per chain).
//
// THE LAWS THIS CONTRACT CHANGES (vs the retired hybrid — each mirrored here,
// none carried over on habit):
//  · FEE IS EXCLUSIVE, ON DEPLOYED CAPITAL: the contract requires
//    `committed + committed×feeBps/10000 ≤ received` and charges the fee on
//    what actually deployed. The old inclusive fee-out-of-the-pull equation
//    (`feeCentsOfTotal`) does NOT apply here.
//  · FUNDING IS ERC-20 ONLY: address(0) reverts on chain, so it refuses here.
//    There is no native path and no `value` — ever.
//  · THE FEE SINK IS DIRECT: `feeRecipient` in BatchParams, per batch. The
//    integrator-accrual model does not exist on this contract.
//  · DEADLINES ARE BOUNDED ABOVE: `now + 24h` max (DeadlineTooFar) — a
//    signature can no longer be a standing grant by construction.
//
// STILL TRUE, carried deliberately: floors are OURS and arrive ON the leg
// (derivation lives in floor-discipline; composition carries); recipient is
// the signer (product law — everything lands in your own wallet); refusals
// are sentences, never crashes; nothing here reads a clock or the network.
// ─────────────────────────────────────────────────────────────────────────────

/** THE DARK FLAG (plan §8). Nothing may wire this compose path into a UI or
 *  runner while false. Flips only on the owner's word, after the deployed
 *  address + fresh selectors are seated and re-verified.
 *
 *  2026-08-12 — the flag's own three conditions are MET, on record: the owner's
 *  word ("…the portfolio execution system … i need to be able to execute"),
 *  the batcher address seated per chain in the operator's deployments and
 *  re-verified on-chain the same day, and the selectors re-pinned against
 *  the shipping burn-leg ABI (commit 2371eef, batchBuy 0x0c8ef5f9). The flip
 *  is now HELD by the YOUNGER gate those conditions predate: the go-live
 *  interlock (go-live-interlock.test.ts) fails the whole suite on any live
 *  flip until its ruled preconditions land — CONCENTRATION_POLICY and
 *  RECENT_COMPLETION_WINDOW_MS (the owner's unset numbers), the release surface
 *  (spec awaiting his confirm), the A12 sweep over the final bytes, and two
 *  independent clean review passes at the current moneyDigest. Meeting that
 *  gate deliberately is the flip commit's job; nothing may weaken it to get
 *  there. Until then the UI's execute station states the blocked fact in
 *  words (execution-arming.ts) instead of walking a simulation. */
export const ZEROEX_COMPOSE_ENABLED = true

/** Mirrors SpectrumPortfolioBatcher.MAX_LEGS. Flat count — no basket
 *  weighting, because no basket legs exist on this contract. */
export const PORTFOLIO_MAX_LEGS = 32

/** Mirrors MAX_FEE_BPS (2% ceiling). */
export const PORTFOLIO_MAX_FEE_BPS = 200

/** Mirrors MAX_DEADLINE_WINDOW (24h), in seconds. */
export const PORTFOLIO_MAX_DEADLINE_WINDOW_SEC = 86_400

/** The floor discipline's market term under a REAL 0x quote basis: route
 *  impact and venue fees already live inside `buyAmount`, so what remains is
 *  quote-to-execution drift. Design constant — calibrate against live fills
 *  once the rule-7 realised-price monitor runs. Self-impact and transfer-tax
 *  terms are unchanged (quotes all price ONE pre-batch state; the contract
 *  floors pre-forward). */
export const QUOTE_DRIFT_BAND_BPS = 30

/** THE DEEP/THIN BOUNDARY, bps — and it is the OLD `MAX_QUOTE_DRIFT_BPS` value,
 *  deliberately, so that every leg which was composable before this ruling
 *  composes identically after it.
 *
 *  ⚠ THIS LINE EXISTS BECAUSE MY FIRST CUT BROKE A PIN AND THE PIN WAS RIGHT
 *  (:695, caught on the first run). I had keyed "thin" off `S_MAX_BPS` (300)
 *  while also uncapping the drift band, which opened a band between 250 and 300
 *  where a leg's market term GREW but its ceiling did not — so the room left for
 *  self-impact shrank and legs that used to compose started refusing. A widening
 *  that makes some legs refuse is not a widening, it is a bug with a good story.
 *
 *  Keyed here instead: at or below this, the leg is deep, its band is exactly
 *  what it always was, and it is held to `S_MAX_BPS` with the same headroom for
 *  self-impact as before. Above it, the leg is thin BY ITS OWN MEASUREMENT and
 *  carries the ruling's wider ceiling. */
export const DEEP_MARKET_DRIFT_BPS = 250

/** The most a per-asset drift band may widen to.
 *
 *  ⚠ RAISED 250 → 1,000 on the owner's thin-market ruling (live 2026-08-15), and
 *  the old value is why three $LNOC batches reverted on chain. 250 bps was not
 *  a measured bound on drift; it was the point past which we stopped estimating.
 *  Measured on the actual pool: the same quote moved 854 bps peak-to-trough
 *  over four minutes, 722 of it inside ONE 12-second interval. A band that
 *  cannot reach the drift it is estimating does not bound the risk, it just
 *  guarantees the leg reverts — see `S_MAX_THIN_BPS` for the full measurement
 *  and the bounds that keep this safe.
 *
 *  Still reachable ONLY on measured depth (unreadable returns null → refusal),
 *  still per-asset, and a deep asset's band is unchanged: at $10k of depth-
 *  proportionate size a major still bands at tens of bps, not hundreds. */
export const MAX_QUOTE_DRIFT_BPS = 1_000

/**
 * What an HONEST route would return at this size — the quote bracket's
 * reference. Frictionless spot is not that reference: a real route pays this
 * asset's own price impact, so comparing a quote against spot forces the
 * bracket wide enough to swallow the difference, and everything inside that
 * width silently becomes floor basis.
 *
 * Unreadable depth returns the spot expectation UNCHANGED — the strictest
 * reference available — so an unmeasurable asset gets a tighter bracket rather
 * than a looser one. (It is refused a floor downstream anyway; this must not be
 * the place that quietly widens.)
 */
export function depthAwareExpectation(spotOutRaw: bigint, notionalUsd: number, liquidityUsd: number | null): bigint {
  const impact = singleSwapImpactBps(notionalUsd, liquidityUsd)
  if (impact == null || impact <= 0 || impact >= 10_000) return spotOutRaw
  return (spotOutRaw * BigInt(10_000 - impact)) / 10_000n
}

/**
 * Rule 2's market term for a REAL quote basis: what this asset's price can
 * drift between the quote and its execution. Route impact and venue fees
 * already live inside `buyAmount`, so what remains is drift — and drift scales
 * with thinness, which is why it cannot be one constant.
 *
 * Derived from the same measured depth the floor's own-size term uses: an asset
 * whose own trade barely moves its pool also barely moves between blocks.
 * Unreadable depth returns null, which REFUSES the leg — an unmeasured asset is
 * not a deep one.
 */
export function quoteDriftBpsFor(liquidityUsd: number | null, notionalUsd: number): number | null {
  const impact = singleSwapImpactBps(notionalUsd, liquidityUsd)
  if (impact == null) return null
  // the floor is the deep-market band; thinness widens it, bounded, so a very
  // thin asset hits the floor cap's refusal rather than an unbounded estimate
  return Math.min(QUOTE_DRIFT_BAND_BPS + impact, MAX_QUOTE_DRIFT_BPS)
}

/**
 * THIS LEG'S OWN TOLERANCE CEILING, bps — the number that (a) bounds its floor,
 * (b) is what we ask 0x to embed, and (c) is what the review states to the user.
 * One derivation so those three can never disagree.
 *
 * A DEEP asset keeps `S_MAX_BPS` exactly as before, so nothing about the bound
 * on self-impact in a large batch changes for the assets it was really holding.
 * A leg whose MEASURED drift band already exceeds that cap is thin by its own
 * measurement, and it gets `S_MAX_THIN_BPS` — the owner's ruling, with the widened
 * number surfaced rather than silently applied.
 *
 * Unmeasurable depth returns null and the leg is refused upstream; it must never
 * arrive here and be handed the wider ceiling, because "we could not read it" is
 * not "we read it and it was thin" (the read-failed law, which this ruling
 * deliberately does not touch).
 */
export function legToleranceCeilingBps(liquidityUsd: number | null, notionalUsd: number): number | null {
  const drift = quoteDriftBpsFor(liquidityUsd, notionalUsd)
  if (drift == null) return null
  return drift > DEEP_MARKET_DRIFT_BPS ? S_MAX_THIN_BPS : S_MAX_BPS
}

/** Is this leg riding the WIDER thin-market ceiling? The review card asks, so
 *  that the sentence a user reads is keyed to the same predicate the floor is. */
export function isThinMarketLeg(liquidityUsd: number | null, notionalUsd: number): boolean {
  return legToleranceCeilingBps(liquidityUsd, notionalUsd) === S_MAX_THIN_BPS
}

/** The batchBuy ABI, from the SHIPPING SpectrumPortfolioBatcher artifact
 *  (docs/abi/SpectrumPortfolioBatcher.rehearsal-2026-08-12.abi.json). The
 *  burn-leg build: BatchParams gained `burnSwapData` (bytes), which moved the
 *  selector `0x273d1ecf` (the retired `0645ee2` shape) → `0x0c8ef5f9` — pinned
 *  in portfolio-batcher.test.ts against this shape and verified contained in
 *  the deployed bytecode on all three chains. The contract's other externals,
 *  execBurn (0x1afa9dc8) and execLeg (0xafa10a1e), are self-call-only
 *  (OnlySelf) and deliberately NOT surfaced here — nothing app-side may call
 *  them; their selectors are pinned in the tests as documentation only. */
export const portfolioBatcherAbi = [
  {
    type: 'function',
    name: 'batchBuy',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'legs',
        type: 'tuple[]',
        components: [
          { name: 'buyToken', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'minBuyAmount', type: 'uint256' },
          { name: 'swapData', type: 'bytes' },
          { name: 'optional', type: 'bool' },
        ],
      },
      { name: 'fundingAsset', type: 'address' },
      { name: 'fundingTotal', type: 'uint256' },
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'feeRecipient', type: 'address' },
          { name: 'burnSwapData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'bought', type: 'uint256[]' },
      { name: 'refunded', type: 'uint256' },
    ],
  },
] as const

export const PORTFOLIO_BATCH_BUY_SELECTOR = '0x0c8ef5f9'

/** THE GENERATION-2 batchBuy ABI (the production-ceremony fee model, the owner
 *  2026-08-16; contracts branch feature/no-integrator-100pct-burn):
 *  BatchParams DROPS feeRecipient — the tuple is (recipient, deadline, feeBps,
 *  burnSwapData) — because the fee is 100% buy-and-burn with no integrator.
 *  The selector MOVES with the tuple. ⚠ DEPLOY-DAY LAW: this mirror is built
 *  from the contracts branch's final shape; the allocator A1 gate re-derives
 *  the selector from the DEPLOYED artifact at seating and any disagreement
 *  fails loudly — never trust this file over the deployed bytes. */
export const portfolioBatcherAbiGen2 = [
  {
    type: 'function',
    name: 'batchBuy',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'legs',
        type: 'tuple[]',
        components: [
          { name: 'buyToken', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'minBuyAmount', type: 'uint256' },
          { name: 'swapData', type: 'bytes' },
          { name: 'optional', type: 'bool' },
        ],
      },
      { name: 'fundingAsset', type: 'address' },
      { name: 'fundingTotal', type: 'uint256' },
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'burnSwapData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'bought', type: 'uint256[]' },
      { name: 'refunded', type: 'uint256' },
    ],
  },
] as const

/** Gen-2 batchBuy selector — SpectrumContracts' own measurement of the new
 *  tuple (their 2026-08-16 fee-model brief); a test pins it against
 *  toFunctionSelector(portfolioBatcherAbiGen2) so the mirror and the constant
 *  can never drift apart, and the A1 gate confirms it against deployed bytes. */
export const PORTFOLIO_BATCH_BUY_SELECTOR_GEN2 = '0x2c84261e'

/** THE ONE ENCODER for a composed batch — picks the generation's own ABI, so
 *  no call site can pair gen-2 args with the gen-1 selector (or vice versa).
 *  Every place that turns a ComposedPortfolioBatchBuy into calldata MUST go
 *  through this; a hand-rolled encodeFunctionData beside it is the mismatch
 *  waiting to happen. */
export function encodePortfolioBatchBuy(composed: ComposedPortfolioBatchBuy): `0x${string}` {
  return composed.generation === 2
    ? encodeFunctionData({ abi: portfolioBatcherAbiGen2, functionName: 'batchBuy', args: composed.args as never })
    : encodeFunctionData({ abi: portfolioBatcherAbi, functionName: 'batchBuy', args: composed.args as never })
}

export interface PortfolioAssetLeg {
  symbol: string
  buyToken: Address
  /** Funding-asset input for this leg, raw units (exact-input). */
  sellAmountRaw: FundingRaw
  /** OUR floor on measured delivery — derived by the floor discipline from
   *  the 0x quote's buyAmount, carried here (never derived here). */
  minBuyAmountRaw: bigint
  /** The 0x calldata, validated by zeroex-quote (target pinned, value zero). */
  swapData: `0x${string}`
  /** Thin-leg consent (the review's surface): on failure, skip + refund. */
  optional: boolean
}

export interface ComposePortfolioBatchBuyInput {
  /** The pre-quoted burn route (see the args note below) — absent keeps the
   *  fail-closed empty route. */
  burnSwapData?: `0x${string}`
  legs: PortfolioAssetLeg[]
  /** ERC-20 only — zeroAddress refuses (the contract has no native path). */
  fundingAsset: Address
  /** The gross pull, raw units, measured by the wallet layer. */
  fundingTotalRaw: FundingRaw
  /** The signer. Recipient == owner is product law, enforced here. */
  owner: Address
  recipient: Address
  /** The CHAIN's clock at composition (never Date.now — money time is chain
   *  time), so the 24h ceiling is judged against the clock that enforces it. */
  chainNowSec: number
  deadlineSec: number
  /** The operator's fee, ≤ 200 bps. Charged BY THE CONTRACT on deployed
   *  capital — exclusive, on top of leg budgets. */
  feeBps: number
  /** Direct per-batch fee sink (BatchParams.feeRecipient). Explicit, never
   *  defaulted; zero refuses (the contract reverts ZeroAddress). GENERATION 2
   *  HAS NO SUCH FIELD (100% burn, no integrator) — the input is ignored
   *  there and the composed params carry no recipient at all. */
  feeRecipient: Address
  /** The batcher generation this batch's calldata must speak — resolve via
   *  feeGenerationFor(chainId), never assume (a gen-2 tuple aimed at a gen-1
   *  contract is an unknown selector; the reverse mis-encodes the params).
   *  Absent = 1, the deployed default. */
  generation?: 1 | 2
}

export type ComposedPortfolioBatchBuy = {
  /** Which ABI these args encode with (runner-effects picks the matching
   *  portfolioBatcherAbi/Gen2 at encode time). Stamped by the composer from
   *  the input, never inferred from the args' shape. */
  generation: 1 | 2
  /** encodeFunctionData(<generation's abi>, 'batchBuy', args) — value 0n
   *  always: the function is nonpayable and funding is ERC-20. Generation 2's
   *  params tuple carries NO feeRecipient. */
  args: readonly [
    { buyToken: Address; sellAmount: bigint; minBuyAmount: bigint; swapData: `0x${string}`; optional: boolean }[],
    Address,
    bigint,
    (
      | { recipient: Address; deadline: bigint; feeBps: number; feeRecipient: Address; burnSwapData: `0x${string}` }
      | { recipient: Address; deadline: bigint; feeBps: number; burnSwapData: `0x${string}` }
    ),
  ]
}

/** The largest total leg commitment the contract accepts for a given pull —
 *  the EXCLUSIVE fee equation inverted with the contract's own integer math
 *  (`committed + committed×fee/10000 ≤ funding`, floor division). */
export function maxCommittedFor(fundingTotalRaw: bigint, feeBps: number): bigint {
  if (fundingTotalRaw <= 0n) return 0n
  // An UNUSABLE FEE COMMITS NOTHING (S6). clampFee answers -1 for out-of-range,
  // and BigInt(-1) made this solve `c - c/10000 <= F`, answering 100,010 units
  // ABOVE a 1e9 pull. A hostile fee must yield no budget, not a bigger one.
  const clamped = clampFee(feeBps)
  if (clamped < 0) return 0n
  const fee = BigInt(clamped)
  // start from the real-arithmetic bound, then walk to the exact integer edge
  let c = (fundingTotalRaw * 10_000n) / (10_000n + fee)
  while (c + (c * fee) / 10_000n > fundingTotalRaw) c -= 1n
  while ((c + 1n) + ((c + 1n) * fee) / 10_000n <= fundingTotalRaw) c += 1n
  return c
}

function clampFee(feeBps: number): number {
  return Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= PORTFOLIO_MAX_FEE_BPS ? feeBps : -1
}

export function composePortfolioBatchBuy(input: ComposePortfolioBatchBuyInput): ComposedPortfolioBatchBuy {
  // the demo identity never composes — same backstop as assembleBatchBuy
  // (the owner 2026-08-06 1330; desk 204). Checks BOTH parties: a demo owner or a
  // demo recipient is a simulation leaking toward a signature.
  if (isDevPreview(input.owner) || isDevPreview(input.recipient))
    throw new BatchComposeRefusal('this is the demo book — a simulation. Nothing here can be bought for real; connect your own wallet to build a portfolio.')

  if (input.legs.length === 0) throw new BatchComposeRefusal('an empty batch is not a plan')
  if (input.legs.length > PORTFOLIO_MAX_LEGS)
    throw new BatchComposeRefusal(`this plan carries ${input.legs.length} legs — the batcher takes ${PORTFOLIO_MAX_LEGS}; it must split`)
  if (input.fundingAsset === zeroAddress)
    throw new BatchComposeRefusal('this batcher funds in ERC-20 only — there is no native path on the contract, so none composes here')
  if (!(input.fundingTotalRaw > 0n)) throw new BatchComposeRefusal('no funding to batch')

  if (clampFee(input.feeBps) < 0)
    throw new BatchComposeRefusal(
      `the fee is not a plausible setting — the contract's ceiling is ${PORTFOLIO_MAX_FEE_BPS} bps and refuses anything above it`,
    )
  const generation = input.generation ?? 1
  // Generation 2 has NO fee recipient by construction (100% burn) — the
  // zero-sink law is generation 1's alone.
  if (generation !== 2 && input.feeRecipient === zeroAddress)
    throw new BatchComposeRefusal('the fee recipient must be explicit — the contract reverts a zero fee sink, so composition refuses one')
  if (input.recipient === zeroAddress) throw new BatchComposeRefusal('recipient must be explicit — never assumed')
  if (input.recipient.toLowerCase() !== input.owner.toLowerCase())
    throw new BatchComposeRefusal('recipient must be the signer — everything lands in your own wallet, structurally')

  // Money time is chain time. The contract refuses deadlines past now+24h
  // (DeadlineTooFar) and in the past — both refused here, against the chain's
  // own clock, so a wrong local clock cannot compose a doomed signature.
  if (!Number.isInteger(input.chainNowSec) || input.chainNowSec <= 0)
    throw new BatchComposeRefusal('the chain clock reading is unusable — money time comes from the chain, and we could not read it')
  if (!Number.isInteger(input.deadlineSec) || input.deadlineSec <= input.chainNowSec)
    throw new BatchComposeRefusal('the deadline is not ahead of the chain clock — this batch would arrive already expired')
  if (input.deadlineSec > input.chainNowSec + PORTFOLIO_MAX_DEADLINE_WINDOW_SEC)
    throw new BatchComposeRefusal('the deadline sits past the contract 24h ceiling — a signature must expire, so composition refuses it')

  const seen = new Set<string>()
  let committed = 0n
  for (const leg of input.legs) {
    if (leg.sellAmountRaw <= 0n)
      throw new BatchComposeRefusal(`$${showSymbol(leg.symbol)}: a leg with no budget cannot be composed`, leg.symbol)
    if (leg.minBuyAmountRaw <= 0n)
      throw new BatchComposeRefusal(
        `$${showSymbol(leg.symbol)}: this leg carries no floor — a zero floor disables the only delivery guard, and the contract reverts it`,
        leg.symbol,
      )
    if (leg.buyToken.toLowerCase() === input.fundingAsset.toLowerCase())
      throw new BatchComposeRefusal(
        `$${showSymbol(leg.symbol)}: this leg buys the funding asset itself — the contract refuses it, so nothing composes`,
        leg.symbol,
      )
    if (!/^0x[0-9a-fA-F]{8,}$/.test(leg.swapData))
      throw new BatchComposeRefusal(`$${showSymbol(leg.symbol)}: this leg carries no executable route calldata`, leg.symbol)
    // one asset, one leg: a duplicate identity reaching composition means an
    // upstream dedupe failed — refuse loudly rather than compose a batch that
    // buys one asset twice (the basket-dial lesson: duplicates inflate the
    // fee base and double a position silently)
    const key = leg.buyToken.toLowerCase()
    if (seen.has(key))
      throw new BatchComposeRefusal(
        `$${showSymbol(leg.symbol)}: this asset appears twice in one batch — refusing rather than buying it twice`,
        leg.symbol,
      )
    seen.add(key)
    committed += leg.sellAmountRaw
  }

  // THE EXCLUSIVE FUNDING EQUATION, the contract's own integer math mirrored:
  // budgets PLUS the fee they will incur must fit the pull. (The old batcher's
  // inclusive equation — fee out of the pull — composes calldata this
  // contract reverts with BudgetsExceedFunding.)
  const fee = BigInt(input.feeBps)
  if (committed + (committed * fee) / 10_000n > (input.fundingTotalRaw as bigint))
    throw new BatchComposeRefusal(
      `the legs commit ${committed} plus a ${input.feeBps} bps fee on what deploys, which exceeds the ${input.fundingTotalRaw} pull — refusing before any signature exists`,
    )

  // NO CONCENTRATION CHECK HERE (was an absolute cap, audit F2; removed with
  // the owner's consent-divergence ruling 2026-08-13). The policy is now "no leg
  // realises more than you CONSENTED it" — which needs the consent context
  // (the original target weights) that this function does not have. A single
  // leg at 100% is a LEGITIMATE single-asset buy under his ruling, so any
  // absolute check here would false-refuse it. The divergence guard lives
  // where consent lives: concentrationRefusal at the assembler exits
  // (plan-legs.ts + assembleZeroExBatchBuyUnchecked). The runner reaches this
  // function only THROUGH the assembler, so the guard is not bypassed.

  return {
    generation,
    args: [
      input.legs.map((l) => ({
        buyToken: l.buyToken,
        sellAmount: l.sellAmountRaw as bigint,
        minBuyAmount: l.minBuyAmountRaw,
        swapData: l.swapData,
        optional: l.optional,
      })),
      input.fundingAsset,
      input.fundingTotalRaw as bigint,
      {
        recipient: input.recipient,
        deadline: BigInt(input.deadlineSec),
        feeBps: input.feeBps,
        // gen-2's tuple has no recipient field AT ALL — spreading keeps the
        // object literal exactly the ABI's shape for each generation
        ...(generation === 2 ? {} : { feeRecipient: input.feeRecipient }),
        // The burn leg's 0x route. the owner's first live batchBuy (2026-08-15,
        // tx 0x7d3536…) proved the empty route DIVERTS the whole burn cut to
        // the fallback sink (BurnSwapFailed — fail-closed, no loss, but no
        // burn). The assembler now quotes the route for a slightly-UNDER
        // estimate of the cut (SpectrumContracts' prescription) so it
        // executes on the measured amount and only dust diverts; absent a
        // route (no burn asset configured, quote failed, all-optional plan)
        // the empty bytes keep today's fail-closed divert.
        burnSwapData: input.burnSwapData ?? '0x',
      },
    ] as const,
  }
}

// ── DRAFT → QUOTES → FLOORS → CALLDATA (the async assembly) ─────────────────

export interface AssembleZeroExBatchBuyInput {
  chainId: number
  /** The chain's slice of the draft — the SAME plan inputs the spot path
   *  uses; planToLegs' refusal laws (unpriceable, stale, corrupt) all apply
   *  before any quote is fetched. */
  targets: PlanLegInput[]
  /** The gross pull in integer USD cents (the funding plan's view) — the
   *  review's dollar domain. Legs spend the EXCLUSIVE net of it. */
  grossUsdCents: number
  /** The gross pull in the funding asset's raw units, wallet-measured. */
  fundingTotalRaw: bigint
  /** ERC-20 only. Also the sellToken of every quote. */
  fundingAsset: Address
  account: Address
  /** THE BATCHER'S OWN ADDRESS — the `taker` every 0x quote must name.
   *  ⚠ CRITICAL, found by independent review 2026-08-07 and verified against
   *  the contract's own header ("every 0x quote MUST settle its output to THIS
   *  CONTRACT. A quote that names the end recipient as the output target always
   *  fails the floor (`got` would be 0)"). This field used to not exist and the
   *  quotes named `account`, the signer — so `execLeg` measured zero delivery
   *  and EVERY composed batch reverted RequiredLegFailed, or worse, a batch of
   *  all-optional legs SUCCEEDED having bought nothing. Required, not optional:
   *  a missing batcher address must refuse, never fall back to the signer. */
  batcher: Address
  chainNowSec: number
  deadlineSec: number
  feeBps: number
  feeRecipient: Address
  /** The batcher generation the target chain's contract speaks — passes
   *  through to composePortfolioBatchBuy verbatim. Absent = 1. */
  generation?: 1 | 2
  /** Gas price in wei, for the ECONOMIC leg cap the contract delegates to the
   *  backend in writing (see economic-leg-cap.ts). Null refuses: an unmeasured
   *  gas price is not a cheap one, and this bound exists for the expensive case. */
  gasPriceWei: bigint | null
  /** USD per whole native token, for the same bound. Null refuses. */
  nativeUsd: number | null
  /** The shared funding hop's funding-side reserve, USD, MEASURED (floor
   *  rule 3) — null refuses every leg; an unmeasured hop is not a deep hop.
   *  Produced by `hop-reserve.ts`; pass `read?.reserveUsd ?? null` so a failed
   *  measurement stays null rather than becoming a flattering number. */
  hopReserveUsd: number | null
  /** The chain's burn TARGET (what the burn cut buys-and-burns — PRISM on
   *  mainnet, per lib/prism/claim.ts's own constant). Absent = no route is
   *  quoted and the burn keeps the contract's fail-closed divert. */
  burn?: { asset: Address }
}


export interface AssembledZeroExBatchBuy {
  composed: ComposedPortfolioBatchBuy
  /** Cent view + floor audit trail, for the review. */
  legs: (PortfolioAssetLeg & {
    budgetUsdCents: number
    buyAmountRaw: bigint
    /** What 0x took for itself on this leg, sell-token raw units (null =
     *  unreadable, never 0). Carried so the surface can state the ALL-IN cost
     *  rather than only our own fee — the disclosure gap SpectrumContracts
     *  found in a live receipt (2026-08-15). */
    zeroExFeeRaw: bigint | null
    /** `ceilingBps` is the leg's tolerance ceiling — what we asked 0x to embed
     *  and what bounded `sBps`. It travels on the audit trail because the whole
     *  point of the thin-market ruling is that the number is stated, and a
     *  number nobody can read back is not stated. */
    floor: { sBps: number; selfImpactBps: number; taxBps: number; ceilingBps: number }
  })[]
  /** Every leg that fell out, and why — plan-time, quote-time, floor-time.
   *  One channel; the review shows them all. */
  refusals: { symbol: string; reason: string }[]
  floorRefusals: FloorRefusal[]
  /** The consent divergence of what composed vs what was approved (M2's
   *  detection half; the fixpoint's refusals CASCADE, so survivors can absorb
   *  the batch). Same helper as the plan-legs fixpoint — one meaning. A FACT:
   *  nothing here acts on it; the policy is the owner's open decision. */
  concentration: PlanConcentration
}

/**
 * THE LIVE ENTRY POINT — the only one app code may import.
 *
 * The dark flag was a CONVENTION until now ("a runner must check it first"),
 * and a convention is not a gate: the one thing a comment cannot do is stop the
 * wiring that forgets it. The flag is enforced HERE, at the only door app code
 * has, and the ungated path is renamed to say what it is — so a future runner
 * cannot go live by omission; it has to reach for a function whose name admits
 * it is bypassing the gate.
 */
export async function assembleZeroExBatchBuyLive(
  input: AssembleZeroExBatchBuyInput,
  fetchQuote: ZeroExFetcher,
): Promise<AssembledZeroExBatchBuy> {
  if (!ZEROEX_COMPOSE_ENABLED)
    throw new BatchComposeRefusal('this way of buying is not switched on yet, so nothing was composed and no funds were touched')
  return assembleZeroExBatchBuyUnchecked(input, fetchQuote)
}

/**
 * One chain's batch against the 0x path, to a fixpoint: a leg refused at
 * quote or floor time is EXCLUDED (by asset identity) and the plan re-budgets
 * over the survivors — which changes sellAmounts, so surviving legs re-quote.
 * The exclusion set only grows, so it terminates; live use should rarely
 * loop past round one.
 *
 * Throws BatchComposeRefusal when nothing can compose AT ALL; per-leg
 * refusals otherwise travel on the result.
 */
export async function assembleZeroExBatchBuyUnchecked(
  input: AssembleZeroExBatchBuyInput,
  fetchQuote: ZeroExFetcher,
): Promise<AssembledZeroExBatchBuy> {
  // REFUSE THE UNREADABLE HOP FIRST, before any quote is fetched: it refuses
  // every leg downstream anyway (floor rule 3), so N network round-trips would
  // be pure waste and the sentence would arrive after a wallet had been kept
  // waiting. The caller measures with `hop-reserve.ts` and passes
  // `read?.reserveUsd ?? null` — a failed measurement stays null.
  // S1: no batcher address, no honest quote — the output target is not a
  // detail we can default. Refused before a single network call.
  if (!input.batcher || input.batcher === zeroAddress)
    throw new BatchComposeRefusal(
      'this network has no batcher address configured yet, so no route can be quoted to it — nothing was composed',
    )
  // ⚠ THE ORIGINAL DEFECT, RE-ADMITTABLE (review, 2026-08-07): my first fix
  // added the field but nothing refused `batcher === account`, which IS the bug
  // S1 fixed — quoting delivery to the signer. The cheapest possible guard was
  // absent, so a caller could reintroduce it by passing the wrong variable.
  if (input.batcher.toLowerCase() === input.account.toLowerCase())
    throw new BatchComposeRefusal(
      'the route would deliver to your own wallet instead of the contract that checks the amount — refusing to quote a batch that cannot pay out',
    )
  // S6: an out-of-range fee made maxCommittedFor answer ABOVE the pull, and the
  // refusal only arrived after N live quotes had been spent on over-budget
  // amounts. The fee check belongs beside the hop check, before the network.
  if (clampFee(input.feeBps) < 0)
    throw new BatchComposeRefusal(
      `the fee is not a plausible setting — the contract's ceiling is ${PORTFOLIO_MAX_FEE_BPS} bps and refuses anything above it`,
    )
  if (input.hopReserveUsd == null || !Number.isFinite(input.hopReserveUsd) || input.hopReserveUsd <= 0)
    throw new BatchComposeRefusal(
      'we could not measure how deep this network’s trading route is right now, and we will not set protection floors against a depth we could not read — try again in a moment',
    )
  const spendable = maxCommittedFor(input.fundingTotalRaw, input.feeBps)
  if (spendable <= 0n) throw new BatchComposeRefusal('the amount is too small to spend once the fee is provided for — nothing to compose')
  // The same equation in the CENT domain — the review's dollars. Both views
  // budget the exclusive net; raw is what the chain settles (seam law).
  if (!Number.isFinite(input.grossUsdCents) || Math.floor(input.grossUsdCents) <= 0)
    throw new BatchComposeRefusal('this network has no funded amount to spend — nothing to compose')
  const spendableCents = Number(maxCommittedFor(BigInt(Math.floor(input.grossUsdCents)), input.feeBps))
  if (spendableCents <= 0) throw new BatchComposeRefusal('the amount is too small to spend once the fee is provided for — nothing to compose')

  const excluded = new Set<string>()
  const refusals: { symbol: string; reason: string }[] = []
  const floorRefusals: FloorRefusal[] = []

  for (let round = 0; round <= input.targets.length + 1; round++) {
    const live = input.targets.filter((t) => !excluded.has(t.asset.toLowerCase()))
    // Plan in the CENT domain (weights → exact cent budgets, the existing
    // laws), then distribute the raw spendable by those cents — conservation
    // by construction, the one scaling.
    const planned = planToLegs(live, spendableCents)
    for (const r of planned.refusals) if (!refusals.some((x) => x.symbol === r.symbol && x.reason === r.reason)) refusals.push(r)
    if (planned.legs.length === 0) {
      const why = planned.refusals[0]?.reason ?? refusals[0]?.reason
      throw new BatchComposeRefusal(why ? `no leg of this plan can compose — the first reason: ${why}` : 'this plan has no composable legs')
    }
    // feeBps 0 HERE, deliberately: scaleLegBudgetsToRaw's default nets the
    // OLD inclusive fee out of its total, but this contract's fee is
    // EXCLUSIVE and maxCommittedFor already solved the pull down to the
    // spendable — netting again would double-charge (caught by the
    // conservation pin on this module's first run).
    // THE ECONOMIC LEG CAP (the contract delegates it to us in prose; see
    // economic-leg-cap.ts). Applied AFTER planning — the leg count is only known
    // here — and BEFORE quoting, so an over-long plan is not paid for in network
    // calls. The fee basis is this batch's own revenue in dollars.
    const cap = economicLegCap({
      contractMaxLegs: PORTFOLIO_MAX_LEGS,
      gasPriceWei: input.gasPriceWei,
      nativeUsd: input.nativeUsd,
      feeUsd: (spendableCents / 100) * (input.feeBps / 10_000),
    })
    if (cap.maxLegs <= 0) throw new BatchComposeRefusal(cap.message ?? 'this network cannot run a batch right now')
    if (planned.legs.length > cap.maxLegs)
      throw new BatchComposeRefusal(
        cap.message ?? `this plan carries more assets than this network can take in one go (${cap.maxLegs})`,
      )

    const raws = scaleLegBudgetsToRaw(
      planned.legs.map((l) => l.budgetUsdCents),
      asFundingRaw(spendable),
      0,
    )

    const targetByAsset = new Map<string, PlanLegInput>()
    for (const t of live) {
      const k = t.asset.toLowerCase()
      if (!targetByAsset.has(k)) targetByAsset.set(k, t)
    }
    // ⚠⚠ TWO LEGS ON ONE ASSET WOULD SHARE ONE FLOOR (independent review,
    // 2026-08-07). The floor plan is keyed by asset address, so a duplicated
    // asset produced two results under one key and the join Map kept ONE —
    // both legs then carried it. Measured on a 99/1 split: the small leg got a
    // floor at 99.15% of its own quote (permanent revert) and the BIG one got
    // 1.002%, leaving $9,752 of a $9,950 batch below its own composed floor —
    // exactly the round-3 attack the floor discipline exists to stop.
    //
    // This module already writes the dedupe law one block above for
    // `targetByAsset` and simply never applied it to the legs. A duplicate is
    // refused rather than merged: merging would change the plan the user
    // consented to, and the flow's own normalization should not be producing
    // one — if it does, that is a bug to see, not to paper over.
    const seenAsset = new Set<string>()
    for (const t of live) {
      const k = t.asset.toLowerCase()
      if (seenAsset.has(k)) {
        throw new Error(
          `the same asset appears twice in one plan (${k}) — refusing rather than deriving one floor for two legs`,
        )
      }
      seenAsset.add(k)
    }

    // Quote every leg concurrently — sellAmount is this round's raw budget.
    const quoted = await Promise.all(
      planned.legs.map(async (l, i): Promise<{ i: number; quote: LegQuote } | { i: number; refusal: ZeroExQuoteRefusal }> => {
        // ONE derivation of this leg's ceiling, read here and again at the floor
        // stage from the same frozen market row — so the tolerance we ask 0x to
        // embed, the tolerance our floor enforces, and the tolerance the review
        // states are the same number by construction.
        const ceiling = legToleranceCeilingBps(targetByAsset.get(l.asset.toLowerCase())?.liquidityUsd ?? null, l.budgetUsdCents / 100)
        try {
          const raw = await fetchQuote({
            chainId: input.chainId,
            sellToken: input.fundingAsset,
            buyToken: l.asset,
            sellAmountRaw: raws[i] as bigint,
            // the BATCHER takes delivery, never the signer (S1)
            taker: input.batcher,
            // ⚠⚠ ASK 0x FOR THE LEG'S CEILING, NOT ITS DERIVED TOLERANCE. Unset,
            // 0x embeds its own 100-bps default, which on a thin asset is
            // TIGHTER than the floor we derive below — so the trade was being
            // stopped by a number we never chose, do not display, and cannot
            // explain, inside calldata we never parse. Three of the owner's $LNOC
            // batches died there (2026-08-15) and read as an unexplained
            // `RequiredLegFailed`.
            //
            // The ceiling is the most our own floor could ever permit, so what
            // 0x embeds is always >= what we enforce, and OUR floor is the
            // binding constraint — the number a human was shown is the number
            // that decides. Passing the derived tolerance instead would be a
            // race between two nearly-equal minimums, and 0x's would win on
            // rounding while saying nothing a user could read.
            //
            // Null ceiling means depth was unreadable; the leg is refused at the
            // floor stage regardless, so we simply omit and let 0x's default
            // stand for a quote that will not be used.
            ...(ceiling != null ? { slippageBps: ceiling } : {}),
          })
          const quote = validateLegQuote(raw, {
            symbol: l.symbol,
            chainId: input.chainId,
            sellToken: input.fundingAsset,
            buyToken: l.asset,
            sellAmountRaw: raws[i] as bigint,
            // the page's own frictionless expectation for this budget — the
            // bracket's independent reference (plan-legs' stated spot basis)
            // ⚠⚠ THE BRACKET AND THE FLOOR COMPOSE, AND NOTHING MULTIPLIED
            // THEM (independent review, CRITICAL). The validator accepted any
            // buyAmount within the bracket of the FRICTIONLESS spot, and that
            // accepted number then became the floor's basis — so a leg could
            // report 30 bps of tolerance while permitting 2,024. Neither number
            // was wrong alone; their product was never computed.
            //
            // The reference is now what an honest route WOULD return at this
            // size: spot minus this asset's own measured price impact. That
            // lets the bracket close to the honest band (a thin route no longer
            // needs 2,000 bps of room to look plausible, because the reference
            // already accounts for its thinness), which is what makes rule 1 —
            // derive the floor from the quote — safe to rely on.
            spotOutRaw: depthAwareExpectation(l.quotedOutRaw, l.budgetUsdCents / 100, targetByAsset.get(l.asset.toLowerCase())?.liquidityUsd ?? null),
            // the UNADJUSTED figure, for the bracket's HIGH side only: our
            // depth model is pessimistic on concentrated pools, so the ceiling
            // must hang off real spot or the model's own conservatism starts
            // refusing honest quotes (the owner's $LNOC refusal, 2026-08-15)
            frictionlessOutRaw: l.quotedOutRaw,
          })
          return { i, quote }
        } catch (e) {
          if (e instanceof ZeroExQuoteRefusal) return { i, refusal: e }
          // a transport failure is not a verdict about the asset — but it IS
          // a refusal for THIS assembly; the sentence says which it was
          return {
            i,
            refusal: new ZeroExQuoteRefusal(
              `$${showSymbol(l.symbol)}: the route service did not answer for this leg — try again in a moment`,
              l.symbol,
            ),
          }
        }
      }),
    )

    const quoteRefused = quoted.filter((q): q is { i: number; refusal: ZeroExQuoteRefusal } => 'refusal' in q)
    if (quoteRefused.length > 0) {
      for (const q of quoteRefused) {
        const leg = planned.legs[q.i]
        excluded.add(leg.asset.toLowerCase())
        refusals.push({ symbol: leg.symbol, reason: q.refusal.message })
      }
      continue
    }

    // Floors from the QUOTE basis (rule 1), in execution order: drift band as
    // the market term, self-impact accumulating, tax widening — the same
    // discipline, one derivation home.
    const okQuotes = quoted as { i: number; quote: LegQuote }[]
    const floorPlan = deriveLegFloors(
      planned.legs.map((l, i) => {
        const liq = targetByAsset.get(l.asset.toLowerCase())?.liquidityUsd ?? null
        const notionalUsd = l.budgetUsdCents / 100
        const ceiling = legToleranceCeilingBps(liq, notionalUsd)
        return {
        key: l.asset.toLowerCase(),
        quotedBuyAmount: okQuotes.find((q) => q.i === i)!.quote.buyAmountRaw,
        notional: notionalUsd,
        // RULE 2 SAYS NEVER A GLOBAL CONSTANT, and this path had regressed to
        // one: 30 bps for every asset on every chain, which is ~6x too loose
        // for a deep major and far too tight for a thin listing — and because
        // it was constant, rule 5's cap could never fire from the market term
        // at all. Quote-to-execution drift is per-asset too: a major moves a
        // few bps over a quote's life where a thin listing moves hundreds. The
        // depth that decides it was already in hand at this line and discarded.
        marketSlippageBps: quoteDriftBpsFor(liq, notionalUsd),
        buyTokenTaxBps: targetByAsset.get(l.asset.toLowerCase())?.buyTokenTaxBps ?? null,
        // The SAME ceiling the quote was fetched under, from the same frozen
        // row. A measured-thin leg carries the wider one (the owner's ruling); a
        // deep one carries the batch default and is bounded exactly as before.
        // Undefined when depth is unreadable — the leg refuses on the null
        // market term above regardless, and handing a ceiling to a leg we could
        // not measure is precisely the confusion this must not introduce.
        ...(ceiling != null ? { sMaxBps: ceiling } : {}),
        }
      }),
      { hopReserve: input.hopReserveUsd },
    )
    if (floorPlan.refusals.length > 0) {
      for (const r of floorPlan.refusals) {
        excluded.add(r.key)
        floorRefusals.push(r)
        const symbol = targetByAsset.get(r.key)?.symbol ?? r.key
        refusals.push({ symbol, reason: `$${showSymbol(symbol)}: ${r.message}` })
      }
      continue
    }

    const floorByKey = new Map(floorPlan.legs.map((f) => [f.key, f]))
    const legs = planned.legs.map((l, i): AssembledZeroExBatchBuy['legs'][number] => {
      const quote = okQuotes.find((q) => q.i === i)!.quote
      const floor = floorByKey.get(l.asset.toLowerCase())
      if (!floor) throw new Error(`floor plan lost leg ${l.asset} — refusal-free rounds must floor every leg`)
      return {
        symbol: l.symbol,
        buyToken: l.asset,
        sellAmountRaw: raws[i],
        minBuyAmountRaw: floor.minBuyAmount,
        zeroExFeeRaw: quote.zeroExFeeRaw,
        swapData: quote.swapData,
        optional: l.optional,
        budgetUsdCents: l.budgetUsdCents,
        buyAmountRaw: quote.buyAmountRaw,
        floor: {
          sBps: floor.sBps,
          selfImpactBps: floor.breakdown.selfImpactBps,
          taxBps: floor.breakdown.taxBps,
          ceilingBps: legToleranceCeilingBps(targetByAsset.get(l.asset.toLowerCase())?.liquidityUsd ?? null, l.budgetUsdCents / 100) ?? S_MAX_BPS,
        },
      }
    })

    // THE RULED CAP BINDS BEFORE THE COMPOSE (the owner 2026-08-13,
    // CONCENTRATION_POLICY — one verdict shared with plan-legs' own exit so
    // the two paths cannot drift on what the cap means): a batch whose worst
    // leg realises past the cap refuses HERE, before any calldata exists,
    // in the assembler's own refusal grammar.
    const concentration = concentrationOf(
      input.targets,
      legs.map((l) => ({ asset: l.buyToken, budgetUsdCents: l.budgetUsdCents })),
    )
    const capRefusal = concentrationRefusal(concentration)
    if (capRefusal != null) throw new BatchComposeRefusal(capRefusal)
    // ── THE BURN ROUTE (the owner's order 2026-08-15, "do this so burn works";
    // SpectrumContracts' prescription from his live tx). The cut is 7/8 of
    // feeBps × MEASURED spend, and a route quoted for more than the measured
    // cut reverts whole (his tx's exact failure). So the route is sized on
    // the GUARANTEED floor of the spend — the non-optional legs only, every
    // optional leg may skip — with a 0.5% haircut for quote drift; the
    // remainder of the real cut diverts as dust, by design. A failed burn
    // quote NEVER blocks the batch: the burn is fail-closed on-chain, and
    // the review says the divert out loud instead. ──
    let burnSwapData: `0x${string}` | undefined
    if (input.burn) {
      const requiredCommitted = legs.reduce((t, l) => (l.optional ? t : t + (l.sellAmountRaw as bigint)), 0n)
      const burnEstRaw = (requiredCommitted * BigInt(input.feeBps) * 7n * 995n) / (80_000n * 1_000n)
      if (burnEstRaw > 0n) {
        try {
          const raw = await fetchQuote({
            chainId: input.chainId,
            sellToken: input.fundingAsset,
            buyToken: input.burn.asset,
            sellAmountRaw: burnEstRaw,
            // the BATCHER takes delivery — it burns what lands on itself
            taker: input.batcher,
          })
          // The burn quote takes the STRUCTURAL half of validateLegQuote —
          // pinned target/spender, no native value, real calldata, exact
          // echo — but NOT the spot-plausibility bracket: the burn asset has
          // no independent spot in this flow BY DESIGN, and the bracket's
          // job (protecting a floor derived from buyAmount) is done on-chain
          // here by the contract's own burn floor; a wrong quote fail-closes
          // to the divert, never an under-protected fill.
          const to = raw.transaction?.to?.toLowerCase()
          const spender = raw.allowanceTarget?.toLowerCase()
          const holder = ALLOWANCE_HOLDER.toLowerCase()
          const data = raw.transaction?.data
          const sellEcho = raw.sellAmount != null ? BigInt(raw.sellAmount) : null
          if (
            to !== holder ||
            spender !== holder ||
            (raw.transaction?.value != null && raw.transaction.value !== '0') ||
            typeof data !== 'string' ||
            !/^0x[0-9a-fA-F]{8,}$/.test(data) ||
            raw.buyToken?.toLowerCase() !== input.burn.asset.toLowerCase() ||
            raw.sellToken?.toLowerCase() !== input.fundingAsset.toLowerCase() ||
            sellEcho !== burnEstRaw
          )
            throw new BatchComposeRefusal('the burn quote failed its structural checks')
          burnSwapData = data as `0x${string}`
        } catch {
          refusals.push({
            symbol: 'BURN',
            reason: 'the burn route could not be quoted, so this run’s burn cut will divert to the fallback sink instead of burning — nothing else is affected',
          })
        }
      }
    }
    const composed = composePortfolioBatchBuy({
      legs,
      fundingAsset: input.fundingAsset,
      fundingTotalRaw: asFundingRaw(input.fundingTotalRaw),
      owner: input.account,
      recipient: input.account,
      chainNowSec: input.chainNowSec,
      deadlineSec: input.deadlineSec,
      feeBps: input.feeBps,
      feeRecipient: input.feeRecipient,
      ...(input.generation != null ? { generation: input.generation } : {}),
      ...(burnSwapData ? { burnSwapData } : {}),
    })
    return {
    composed,
    legs,
    refusals,
    floorRefusals,
    // the 0x leg names its asset `buyToken`; the helper keys by address either way
    concentration,
  }
  }
  throw new Error('assembly did not converge — the exclusion set must grow every round')
}
