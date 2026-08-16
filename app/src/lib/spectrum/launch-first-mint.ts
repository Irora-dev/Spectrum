import { firstMintSplitFromWeights, WEIGHT_TOTAL_BPS } from './first-mint-split'
import { seedGuard, type SeedLeg } from './seed-guard'
import type { LegVerdict } from './split-guard'

// ─────────────────────────────────────────────────────────────────────────────
// launch-first-mint — the ATOMIC LAUNCH's own funding case, and nothing else.
//
// THE WINDOW THIS CLOSES. A deployed basket holds nothing until someone mints
// into it, and on a PACKING deployment the depositor chooses how their money
// splits across legs. So anyone can make a fresh basket's first mint with a
// deliberately starved leg, and the next honest buyer is funded against a
// composition that is missing a leg. Contracts measured it (their
// test/FirstMintStarveEconomics.t.sol, the attacker-capital axis): $5,000 of
// attacker capital turns a $10,000 victim mint into $4,255, a 57% loss.
// SpectrumBasket.sol still carries an earlier "~$40, a nuisance not a heist"
// comment on the same gap — that comment is RETRACTED by the test file above
// (":173, the axis I failed to measure"). Do not be reassured by it.
// The named remedy, in the contract's own words, is atomic deploy-plus-first-mint:
// the window is not narrowed, it never opens.
//
// NOT YET LIVE: today's factories give the caller no split field, so the trap
// cannot be set. It arms the moment the packing factory is seated, which is why
// this lands now rather than after.
//
// ⛔ WHY WEIGHTS ARE LEGAL HERE AND NOWHERE ELSE. mint-funding.ts states the law:
// a funding split is never derived from weights, because a weight-derived split
// ignores what a basket ACTUALLY holds and pays the difference to whoever starved
// it. first-mint-split.ts names the one exception (the first mint, reading the
// weights off the deployed basket). THIS module is that same exception moved one
// step earlier in time, and its soundness is structural rather than argued:
//
//   At batch time the basket does not exist, so nothing can be read off it. The
//   weights come from the deployBasket ARGUMENTS instead, and those arguments ARE
//   the address: SpectrumFactory._buildInitCode abi.encodes the BasketEntry array
//   (weight included, only `decimals` zeroed) into the constructor args, hashes
//   that init code, and CREATE2s at keccak(0xff, factory, salt, initCodeHash) —
//   the same pre-image predictTokenAddress returns and the salt miner mines
//   against. Change one weight and you change the address. So the split we pack
//   describes the basket being created in the SAME transaction, by the SAME
//   signer, whose money it is. There is no earlier holder to under-fund and no
//   attacker who went before, because nobody can go before: that is the point.
//
// ⛔ AND IT MUST NOT WIDEN. `deploy-args-weights` is its own MintFunding case so a
// payload built from it can never pass for a lens answer, and this module is its
// only producer. Its input is the deployBasket argument array, a shape no buy path
// holds — a buy has a deployed address, not deploy arguments. decideMintFunding
// (the producer for every ordinary buy) cannot return this case at all.
// ─────────────────────────────────────────────────────────────────────────────

/** SpectrumBasket.MIN_FIRST_DEPOSIT — 10 USDC (6dp). Below it the mint reverts
 *  InsufficientFirstDeposit, so the launch form refuses before the wallet does. */
export const MIN_FIRST_DEPOSIT_USDC = 10

/** SpectrumBasket.SETTLEMENT_TO_BASKET_SCALE — settlement 6dp to share 18dp. */
export const SETTLEMENT_TO_BASKET_SCALE = 1_000_000_000_000n
/** SpectrumBasket.MIN_LIQUIDITY — dead-burned on the first mint (anti-inflation lock). */
export const MIN_LIQUIDITY = 1_000_000_000_000_000n
/** SpectrumBasket.MAX_FIRST_MINT_SLIPPAGE_BPS — the contract's own realised-value belt. */
export const MAX_FIRST_MINT_SLIPPAGE_BPS = 500n

const BPS = 10_000n

/**
 * The split the atomic launch's first mint carries.
 *
 * Self-describing on purpose, exactly like FirstMintWeightSplit beside it: the
 * `source` literal is what makes a payload built from these numbers visibly a
 * different thing from a lens answer (hook-data.ts).
 */
export interface DeployArgsWeightSplit {
  readonly source: 'deploy-args-weights'
  readonly splitBps: readonly number[]
}

/** Just the field this module reads off a deployBasket entry. Deliberately not the
 *  whole DeployBasketEntry: nothing here may reach for an address, a route or a
 *  price, so there is nothing a caller could substitute a mark into. */
export interface DeployArgWeight {
  readonly weight: number
}

/**
 * Turn the deployBasket arguments into the split their basket's first mint may
 * carry. Pure, and the ONLY producer of the `deploy-args-weights` case.
 *
 * Normalisation is not re-implemented here: it delegates to
 * `firstMintSplitFromWeights`, the same function the read-from-the-basket path
 * uses, so the two cannot drift apart. Same rules, therefore: integer bps totalling
 * exactly 10000, any residual to the heaviest leg (earliest wins a tie, so the
 * result never depends on sort stability), and `null` rather than a shipped split on
 * a leg count that does not describe these arguments, a non-integer or negative
 * weight, or any leg that would end up funded with zero.
 *
 * That last rule is load-bearing at a first mint specifically: a zero-split leg is
 * skipped by the acquire loop while the first mint REQUIRES a non-zero floor on
 * every non-USDC leg (FirstMintLegMinRequired), so the two together revert.
 */
export function launchSplitFromDeployArgs(
  basket: readonly DeployArgWeight[],
  legCount: number,
): DeployArgsWeightSplit | null {
  if (!Array.isArray(basket) || basket.length === 0) return null
  const split = firstMintSplitFromWeights(
    basket.map((e) => e.weight),
    legCount,
  )
  if (!split) return null
  return { source: 'deploy-args-weights', splitBps: split.splitBps }
}

/**
 * The aggregate share floor for a first mint we CANNOT simulate.
 *
 * At supply 0 the basket mints `realised * SCALE - MIN_LIQUIDITY` shares, where
 * `realised` is the post-swap USDC value of what the acquire actually bought, and
 * the contract itself reverts FirstMintUnderValued below
 * `net * (BPS - MAX_FIRST_MINT_SLIPPAGE_BPS) / BPS`. This mirrors that belt exactly.
 *
 * WHY NOT TIGHTER. Every other buy derives its minOut from a live simulation of the
 * real trade; there is nothing to simulate before the basket exists, so a tighter
 * aggregate bound here would be a guess that false-reverts honest launches. Nothing
 * is left unprotected by mirroring it: the contract names the mandatory non-zero
 * per-leg legMins as "the ONLY guarantee against a price-pump sandwich" at the first
 * mint and its realised-value belt as "a SECONDARY depletion bound only", and those
 * per-leg floors are derived from live route quotes at the buyer's own tolerance
 * (encodeMintHookData, from the fills the launch quotes). This is the aggregate
 * belt, at the chain's own number.
 *
 * `null` when the deposit is too small to floor at all — refuse rather than ship a
 * zero, which would be no floor.
 */
export function firstMintMinOut(netSettlementRaw: bigint): bigint | null {
  if (netSettlementRaw <= 0n) return null
  const guaranteed = (netSettlementRaw * (BPS - MAX_FIRST_MINT_SLIPPAGE_BPS)) / BPS
  const minOut = guaranteed * SETTLEMENT_TO_BASKET_SCALE - MIN_LIQUIDITY
  return minOut > 0n ? minOut : null
}

/**
 * The per-leg seed the depth guard judges: each leg's share of the deposit, in
 * settlement dollars, beside that leg's own pool depth.
 *
 * The share is the SPLIT's, not the raw weight's, because the split is what the
 * payload will actually fund each leg with. On this path they are the same numbers
 * by construction (the split IS the deploy arguments' weights), which is precisely
 * why the guard can run before the basket exists.
 */
export function seedLegsForLaunch(
  legs: readonly { symbol: string; depthUsd: number | null }[],
  splitBps: readonly number[],
  depositUsd: number,
): SeedLeg[] {
  if (legs.length !== splitBps.length) return []
  if (!Number.isFinite(depositUsd) || depositUsd <= 0) return []
  return legs.map((l, i) => ({
    symbol: l.symbol,
    seedUsd: (depositUsd * splitBps[i]) / WEIGHT_TOTAL_BPS,
    depthUsd: l.depthUsd,
  }))
}

export interface SeedVerdict {
  /** Any block-grade finding. The launch does not proceed while this is true. */
  blocked: boolean
  /** Every finding, block and warn, in leg order. Shown as written. */
  verdicts: LegVerdict[]
  /** True when there is something to warn about and nothing to block on, so the
   *  creator must acknowledge before the launch arms. */
  needsAck: boolean
}

/**
 * Run the seed-depth guard over a proposed launch deposit and say what the flow
 * must do about it. Pure; `seedGuard` does the measuring.
 *
 * The guard existed, exported, and was called from nowhere. It is called here.
 */
export function seedVerdictForLaunch(
  legs: readonly { symbol: string; depthUsd: number | null }[],
  splitBps: readonly number[],
  depositUsd: number,
): SeedVerdict {
  const verdicts = seedGuard(seedLegsForLaunch(legs, splitBps, depositUsd))
  const blocked = verdicts.some((v) => v.severity === 'block')
  return { blocked, verdicts, needsAck: !blocked && verdicts.length > 0 }
}

// The first deposit is part of launching, not a later errand: the gap between the
// two is the window. Making it OPTIONAL is this one flag (owner may ask for it);
// nothing else branches on it.
export const FIRST_DEPOSIT_REQUIRED = true

/**
 * Whether a launch may arm, given the deposit and what the guard said. One place,
 * so the button and the signer cannot disagree about it.
 */
export function launchSeedReady(args: {
  depositUsd: number
  verdict: SeedVerdict
  /** The creator ticked the warn acknowledgement. Irrelevant when nothing warned. */
  acknowledged: boolean
}): boolean {
  const { depositUsd, verdict, acknowledged } = args
  if (verdict.blocked) return false
  if (verdict.needsAck && !acknowledged) return false
  if (!FIRST_DEPOSIT_REQUIRED && !(depositUsd > 0)) return true
  return Number.isFinite(depositUsd) && depositUsd >= MIN_FIRST_DEPOSIT_USDC
}

/** The one sentence a wallet that cannot batch is shown, before it signs anything.
 *  Owner-approved wording. Plain, no jargon, no em dashes: it has to be true and
 *  understood by someone who has never heard of a batch. */
export const NON_ATOMIC_LAUNCH_NOTE =
  'Your wallet signs one step at a time, so there is a short gap after launch when someone else could make the first deposit. Buying first closes it.'
