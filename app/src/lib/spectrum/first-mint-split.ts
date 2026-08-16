import type { Address } from 'viem'
import { legWeightsBpsOf } from './basket-data'
import { deploymentFor } from '../chain/deployments'

// ─────────────────────────────────────────────────────────────────────────────
// first-mint-split — the ONE place a funding split may come from the basket's own
// design weights, and the reason it is a separate module: mint-funding.ts must
// stay a file with no weights in it, so the weight never travels as a bare
// number[] that some later edit could reach for on a normal buy.
//
// ⚠ THIS IS THE NARROW EXCEPTION TO THE NO-WEIGHTS LAW (mint-funding.ts states the
// law and names this exception). It is safe at the FIRST mint and nowhere else,
// because the money being divided belongs to the person who chose the weights:
// there is no earlier holder to under-fund and no attacker who went before, since
// nobody went before. From the second mint on, a weight-derived split is the
// starved-basket exploit contracts measured ($10,000 buy → $4,255 at target
// weights vs $9,900 at the lens split), and the lens answers by then.
//
// The lens cannot help here: SpectrumFactory.bareLegMins reverts MissingHookData
// as its FIRST statement at effectiveSupply() == 0, by design — a bare first mint
// sets the share basis every future holder inherits, so only the caller's own
// price source may protect it. The design weights are the only number that exists
// at that moment, and they are the same ones contracts' own bootstrap path packs.
//
// WHERE THE NUMBERS COME FROM, and how they cannot come from anywhere else:
// `legWeightsBpsOf` reads `basket(i).weight` off the deployed basket. There is no
// parameter on this module for a weight, a percentage, a quote or a UI value — the
// only input is the basket's address, so a caller has nothing to substitute.
// ─────────────────────────────────────────────────────────────────────────────

/** SpectrumBasket.BPS — the constructor requires the leg weights to total exactly this. */
export const WEIGHT_TOTAL_BPS = 10_000

/**
 * A split the FIRST mint on a packing deployment may carry. Self-describing on
 * purpose: it must never be mistaken for a lens answer, and the `source` literal
 * is what makes a payload built from it visibly a different thing (hook-data.ts).
 */
export interface FirstMintWeightSplit {
  readonly source: 'basket-design-weights'
  readonly splitBps: readonly number[]
}

/**
 * Turn the basket's own leg weights into the split to pack. Pure.
 *
 * On-chain weights are already integer bps totalling 10000, so this is normally an
 * identity — it exists to make that a CHECKED fact rather than an assumed one, and
 * to fail rather than ship a split that would fund the wrong amounts. Any residual
 * lands on the heaviest leg (the one where a few bps move the least, and the tie
 * goes to the earliest so the result never depends on sort stability).
 *
 * `null` when the weights cannot honestly become a split: a leg count that does not
 * describe this basket, a non-integer or negative weight, nothing to divide, or a
 * leg that would end up funded with zero. That last one matters — a zero-split leg
 * is skipped by the acquire loop while the first mint REQUIRES a non-zero floor on
 * every non-USDC leg (FirstMintLegMinRequired), so the two rules together would
 * revert. A basket cannot have a zero weight (the constructor rejects it), so this
 * is a guard against a basket we misread, not against a legal shape.
 */
export function firstMintSplitFromWeights(
  weightsBps: readonly number[],
  legCount: number,
): FirstMintWeightSplit | null {
  if (!Number.isInteger(legCount) || legCount <= 0) return null
  if (weightsBps.length !== legCount) return null
  if (!weightsBps.every((w) => Number.isInteger(w) && w > 0 && w <= WEIGHT_TOTAL_BPS)) return null

  const total = weightsBps.reduce((s, w) => s + w, 0)
  if (total <= 0) return null

  // Scale to bps first (a no-op when the weights already total 10000), floor each
  // leg so the sum can only fall SHORT, then hand the shortfall to one leg. Rounding
  // each leg independently could overshoot 10000, and an over-100% split would
  // over-fund the USDC buffer leg, which the basket bounds at BPS.
  const scaled = weightsBps.map((w) => Math.floor((w * WEIGHT_TOTAL_BPS) / total))
  let residual = WEIGHT_TOTAL_BPS - scaled.reduce((s, w) => s + w, 0)
  if (residual < 0) return null // unreachable with floor(), and not a shape to ship if it ever is

  let heaviest = 0
  for (let i = 1; i < scaled.length; i++) if (scaled[i] > scaled[heaviest]) heaviest = i
  scaled[heaviest] += residual
  residual = 0

  if (scaled.some((w) => w <= 0)) return null
  if (scaled.reduce((s, w) => s + w, 0) !== WEIGHT_TOTAL_BPS) return null
  if (scaled.some((w) => w > WEIGHT_TOTAL_BPS)) return null

  return { source: 'basket-design-weights', splitBps: scaled }
}

/** Whether the FIRST mint on this basket may carry a weight split, and if so, what it is.
 *  Three outcomes because a signing path must branch on them differently: shipping the
 *  legacy shape, packing the weights, and refusing are three different payloads. */
export type FirstMintSplitOutcome =
  | { kind: 'not-packing' } // pre-packing deployment: the legacy no-split shape is correct
  | { kind: 'ok'; split: FirstMintWeightSplit }
  | { kind: 'unreadable' } // the deployment packs but the weights did not come back

/**
 * The decision itself, pure: the reads happen outside and their RESULTS are the
 * input, so every branch is walkable without a chain (same shape as
 * decideMintFunding beside it).
 *
 * ⛔ THE GENERATION IS DECLARED, NOT PROBED, AND IT HAS TO BE. Every later buy learns
 * the generation from the lens's own answer, but at supply 0 BOTH generations revert
 * MissingHookData from the same first line of bareLegMins, and the packing factory
 * exposes no constant, version or selector the older one lacks. Probing a sibling
 * basket instead would deadlock on a fresh factory (its only basket is the one being
 * seeded), so the flag travels with the deployments.json entry that points at the
 * factory — same rule, same reason, as `v4qLineage`.
 *
 * And it applies to the CURRENT factory ONLY: generation is a property of the
 * factory/basket PAIR, superseded lineages stay tradable here, and a packed split on
 * a retired basket is an astronomical floor and LegMinNotMet on every buy.
 */
export function decideFirstMintSplit(args: {
  /** deployments.json `packsFundingSplit` for this chain. */
  packsFundingSplit: boolean
  /** The chain's CURRENT factory. */
  currentFactory: Address | null
  /** The basket's OWN lineage factory. */
  factory: Address
  /** The basket's on-chain leg weights; `null` = the read did not land. */
  weightsBps: readonly number[] | null
  legCount: number
}): FirstMintSplitOutcome {
  const { packsFundingSplit, currentFactory, factory, weightsBps, legCount } = args
  const packs =
    packsFundingSplit && !!currentFactory && currentFactory.toLowerCase() === factory.toLowerCase()
  if (!packs) return { kind: 'not-packing' }
  if (weightsBps == null) return { kind: 'unreadable' }
  const split = firstMintSplitFromWeights(weightsBps, legCount)
  return split ? { kind: 'ok', split } : { kind: 'unreadable' }
}

/** Gather the two facts and decide. Never throws — the caller branches on the outcome. */
export async function firstMintSplitFor(args: {
  chainId: number
  factory: Address
  basket: Address
  legCount: number
}): Promise<FirstMintSplitOutcome> {
  const { chainId, factory, basket, legCount } = args
  const dep = deploymentFor(chainId)
  // Read the weights only where they can legally be used: on a pre-packing
  // deployment this costs nothing and touches nothing.
  if (!dep.packsFundingSplit || !dep.factory || dep.factory.toLowerCase() !== factory.toLowerCase()) {
    return { kind: 'not-packing' }
  }
  return decideFirstMintSplit({
    packsFundingSplit: true,
    currentFactory: dep.factory,
    factory,
    weightsBps: await legWeightsBpsOf(basket, chainId),
    legCount,
  })
}
