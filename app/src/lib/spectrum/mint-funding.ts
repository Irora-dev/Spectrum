import type { Address, PublicClient } from 'viem'
import { lineageFor } from './basket-data'
import { readContractSplit, type ContractSplitResult } from './contract-split'
import { firstMintSplitFor, type FirstMintWeightSplit } from './first-mint-split'
import type { MintFunding } from './hook-data'

// ─────────────────────────────────────────────────────────────────────────────
// mint-funding — the ONLY producer of the funding split a buy payload carries.
//
// A D-R1 basket funds each leg from bits [255:240] of that leg's legMins word
// (SpectrumBasket._acquireBasket, SPLIT_SHIFT = 240). The kit wrote plain floors,
// so every split read as zero, `nonBufferWeight` summed to zero, the acquire loop
// returned early and a HEALTHY multi-leg buy reverted NoOutput (0x5a7cfa65) —
// measured by contracts in test/KitZeroSplitProbe.t.sol on 2026-08-05: the packed
// shape mints 4886 shares, empty hookData mints 4901, the kit's shape reverts.
//
// ⛔ ON EVERY BUY AFTER THE FIRST, THE SPLIT COMES FROM
// `factory.bareLegMins(basket, amountIn)` AND NOTHING ELSE. (The first mint is the
// one exception, spelled out below — it is a different `MintFunding` case, so no
// code path can reach it by accident, and it does not soften this rule.)
// It is decoded (contract-split.ts) and handed on UNTOUCHED. Deriving it from the
// basket's target weights is the exploitable shape: on a basket whose first minter
// starved a leg, $5,000 of attacker capital turns a $10,000 buy into $4,255 at
// target weights versus $9,900 at the lens split (contracts' FirstMintStarveEconomics
// measurement; their `_packTargetSplit` helper is annotated as test-only for exactly
// this reason, `_mintBasketLensSplit` is the safe reference).
// THE STRUCTURAL GUARANTEE: this module takes no weights, no marks and no prices —
// there is nothing here a split could be derived FROM. Keep it that way.
//
// ⚠ THE ONE EXCEPTION, AND ITS EXACT EDGES — THE FIRST MINT ON A PACKING DEPLOYMENT.
// At effectiveSupply() == 0 a packing basket still funds each leg from the top bits,
// but the lens cannot supply them: SpectrumFactory.bareLegMins reverts MissingHookData
// as its first statement there, by design, because a bare first mint sets the share
// basis every future holder inherits. Zeros are not an option either — nothing is
// acquired, and the mint reverts LegMinNotMet (or FirstMintUnderValued where no USDC
// leg carries a floor). The only number that exists at that moment is the creator's
// own design weights, so that is what is packed, read off the basket itself.
//
// WHY IT IS SAFE THERE AND NOWHERE ELSE: the weight-derived split is exploitable
// because it ignores what a basket ACTUALLY holds, so a first minter who starved a
// leg collects the difference from whoever comes next. At the first mint there is no
// composition to be out of step with (the basket holds nothing) and no earlier
// attacker to collect (nobody went before) — and the money being divided belongs to
// the person who chose those weights. Contracts' own bootstrap path packs the same
// numbers. It applies at the FIRST MINT ONLY.
//
// ⛔ AND IT MUST NOT WIDEN. The weight never enters this file: first-mint-split.ts
// reads it, checks it and hands over a purpose-typed `FirstMintWeightSplit`, and this
// module only forwards that value inside the first-mint branch. If a future edit
// needs a weight, a mark, a price or a percentage in THIS file — or reaches for a
// FirstMintWeightSplit outside the first-mint branch — that edit is the bug.
//
// ⚠ THE SAME EXCEPTION, ONE STEP EARLIER — THE ATOMIC LAUNCH (launch-first-mint.ts).
// Deploying a basket and making its first deposit as two signatures leaves a window
// where anyone can make that first deposit instead, with a starved leg, and the next
// honest buyer is shorted (the 57% measurement above IS that attack). Sending both as
// ONE batch removes the window. At batch time the basket does not exist, so the
// weights come from the deployBasket ARGUMENTS instead of off the basket — sound
// because those arguments ARE the address (the factory abi.encodes them into the init
// code it CREATE2s from), so the split is bound to the basket being created, in the
// same transaction, signed by the person funding it. It is a THIRD `MintFunding` case
// (`deploy-args-weights`), it is built only on that path, and NOTHING in this file
// produces it: decideMintFunding cannot return it, which is what keeps an ordinary buy
// out of it.
//
// Four honest outcomes, because a signing path must branch on them differently:
//   · lens-split           — the factory answered packed; pack it beside our floors.
//   · first-mint-weights   — first mint on a PACKING deployment: the basket's own
//                            design weights, per the exception above. Never reachable
//                            once supply exists; never on a pre-packing deployment.
//   · basket-weights       — the deployment has no split field (pre-packing factory)
//                            or this is its first mint. NOTHING may ride the top bits
//                            there: a pre-D-R1 basket reads the WHOLE word as the
//                            floor, so a packed split becomes an astronomical floor
//                            and reverts LegMinNotMet on every buy. Sending the
//                            legacy shape is not a fallback, it is that generation's
//                            correct payload.
//   · refusal              — the factory has the function and would not answer, or we
//                            could not reach it. Do not invent a split, do not quote.
//
// caller-split.ts plans a split from OUR OWN marks (its `splitBps` is `ours`). That
// predates the starved-basket measurement: do not feed its output into a payload. Its
// value is as a guard layer (cross-check, dust-pool refusal), never as a provenance.
//
// ⛔ HOW WE KNOW A DEPLOYMENT PACKS AT A FIRST MINT: WE ARE TOLD, AND WE HAVE TO BE.
// Every LATER buy learns the generation from the lens's own answer (contract-split.ts
// distinguishes packed words from plain floors on the wire). At supply 0 there is
// nothing to learn from: both generations revert MissingHookData from the same first
// line of bareLegMins, their baskets and factories expose an IDENTICAL public surface
// (no version, no constant, no selector one has and the other lacks), and probing a
// sibling basket instead would deadlock on a fresh factory — its only basket is the
// one being seeded. So the generation travels with the deployments.json entry that
// points at the factory (`packsFundingSplit`), the same rule and the same reason as
// `v4qLineage`, and it is read for the CURRENT factory only. Guessing is not on the
// menu in either direction: both mistakes revert at simulate before any money moves,
// but a guess would still be a guess.
// ─────────────────────────────────────────────────────────────────────────────

export interface MintFundingPlan {
  ok: true
  funding: MintFunding
  /** True when a split rides the payload's top bits — a lens answer, or the first
   *  mint's own weights on a packing deployment. False = the legacy no-split shape.
   *  It says what the WIRE looks like, not where the numbers came from: read
   *  `funding.source` for the provenance, which is the load-bearing distinction. */
  packed: boolean
}

export interface MintFundingRefusal {
  ok: false
  /** Shown to the user in place of a quote. Plain words, no selectors. */
  reason: string
  /** True when trying again is the plausible remedy (a read that did not land),
   *  false when the basket itself is the blocker. */
  retryable: boolean
}

export type MintFundingOutcome = MintFundingPlan | MintFundingRefusal

/**
 * Turn a lens read into the funding a payload may carry. Pure: the read happens
 * outside and its RESULT is the input, so every branch is walkable without a chain.
 *
 * `firstMint` is the caller's own knowledge (effectiveSupply() === 0). It is a
 * shortcut, not the safety net — a caller that gets it wrong still lands on the
 * first-mint shape via the lens's MissingHookData refusal.
 *
 * `firstMintSplit` is the ONLY way a weight reaches a payload, and it is read in the
 * first-mint branch and nowhere else: on any later mint it is dead, whatever a caller
 * passes. `null`/absent = a pre-packing deployment, which keeps today's exact shape.
 */
export function decideMintFunding(
  contract: ContractSplitResult,
  opts: { legCount: number; firstMint: boolean; firstMintSplit?: FirstMintWeightSplit | null },
): MintFundingOutcome {
  const { legCount, firstMint } = opts
  if (!Number.isInteger(legCount) || legCount <= 0) {
    return { ok: false, reason: 'This basket has no legs to fund.', retryable: false }
  }
  // The lens refuses at supply 0 (MissingHookData) because only the caller's own
  // price source may protect the mint that sets every future holder's share basis.
  if (firstMint || (contract.kind === 'not-derivable' && contract.firstMint)) {
    const seed = opts.firstMintSplit
    // Pre-packing deployment: unchanged from before this fix, and it must stay that
    // way — its baskets read the whole word as the floor.
    if (seed == null) {
      return { ok: true, packed: false, funding: { source: 'basket-weights', because: 'first-mint' } }
    }
    if (seed.splitBps.length !== legCount) {
      // The weights describe a different basket than the one being quoted.
      return {
        ok: false,
        reason: 'The basket changed while this quote was being prepared. Refresh and try again.',
        retryable: true,
      }
    }
    return {
      ok: true,
      packed: true,
      funding: { source: 'first-mint-weights', splitBps: seed.splitBps },
    }
  }

  if (contract.kind === 'ok') {
    if (contract.legs.length !== legCount) {
      // The answer describes a different basket (or the basket changed under the
      // quote). Packing a mis-length split funds the wrong leg.
      return {
        ok: false,
        reason: 'The basket changed while this quote was being prepared. Refresh and try again.',
        retryable: true,
      }
    }
    return {
      ok: true,
      packed: true,
      // UNTOUCHED. No normalising, no topping up to 10000 (the lens rounds each leg
      // down, so an honest split sums slightly under; the contract expects that).
      funding: { source: 'lens-split', splitBps: contract.legs.map((l) => l.splitBps) },
    }
  }

  if (contract.kind === 'not-derivable') {
    return {
      ok: false,
      reason: contract.named
        ? 'This basket cannot be funded safely right now: the contract could not work out how much of your buy each holding should get.'
        : 'The basket refused to price this buy right now. Refresh and try again.',
      retryable: true,
    }
  }

  // `unavailable`. Only the deployment-shaped reasons decide a payload: a read that
  // never landed says nothing about the generation, and guessing "legacy" there would
  // silently ship a zero-split payload again on the exact deployment this fix targets.
  if (contract.why === 'unpacked' || contract.why === 'no-function') {
    return { ok: true, packed: false, funding: { source: 'basket-weights', because: 'pre-packing-deployment' } }
  }
  return {
    ok: false,
    reason: 'Could not read how this basket splits a buy across its holdings. Check your connection and try again.',
    retryable: true,
  }
}

/**
 * The factory whose lens may speak for THIS basket: its own lineage's, never the
 * chain's current one by assumption.
 *
 * ⛔ WHY IT MATTERS: generation is a property of the factory/basket PAIR — the split
 * field landed on both sides in one change — and superseded lineages stay tradable
 * here (owner 2026-08-01). Ask a NEW packing factory about an OLD basket and you get a
 * packed split the old basket cannot read: it takes the whole word as the floor, so
 * every buy on every legacy basket would revert LegMinNotMet. `lineageFor` answers
 * from the factories' own `tokens` registries and memoizes.
 */
export async function lensFactoryFor(chainId: number, basket: Address): Promise<Address | null> {
  const lineage = await lineageFor(chainId, basket)
  return lineage?.factory ?? null
}

/**
 * Read the lens and decide the funding for a buy of `amountIn` (GROSS settlement, the
 * same number passed to swapExactIn — the lens applies the fee itself). Never throws:
 * the caller branches on the outcome.
 *
 * `factory` MUST be the basket's OWN lineage factory — get it from `lensFactoryFor`.
 */
export async function resolveMintFunding(
  client: PublicClient,
  args: {
    chainId: number
    factory: Address
    basket: Address
    amountIn: bigint
    legCount: number
    firstMint: boolean
  },
): Promise<MintFundingOutcome> {
  const { chainId, factory, basket, amountIn, legCount, firstMint } = args
  if (firstMint) {
    // No lens call: it refuses here by design. The only question is which payload
    // shape this generation reads, and on a packing one, what the basket's own
    // weights are (first-mint-split.ts — the sole exception to the no-weights law).
    const seed = await firstMintSplitFor({ chainId, factory, basket, legCount })
    if (seed.kind === 'unreadable') {
      return {
        ok: false,
        reason: 'Could not read how this basket divides a first buy across its holdings. Refresh and try again.',
        retryable: true,
      }
    }
    return decideMintFunding(
      { kind: 'unavailable' },
      { legCount, firstMint: true, firstMintSplit: seed.kind === 'ok' ? seed.split : null },
    )
  }
  if (amountIn <= 0n) {
    return { ok: false, reason: 'Enter an amount to buy first.', retryable: false }
  }
  const contract = await readContractSplit(client, factory, basket, amountIn, chainId)
  return decideMintFunding(contract, { legCount, firstMint })
}

/** The per-leg funding proportion in bps, for the floor derivation that must bind to
 *  it. `null` when NOTHING rides the payload's top bits and the basket funds from its
 *  own target weights (the pre-packing shape) — there is nothing to override there.
 *  Never build a payload from this — it is the same numbers, for pricing only. */
export function fundingSplitBpsOf(funding: MintFunding): readonly number[] | null {
  // Exhaustive by exclusion on purpose: every case that CARRIES a split must answer
  // with it, and a future case that forgets to be listed here would silently price
  // its legs off target weights while the payload funds them off the split.
  return funding.source === 'basket-weights' ? null : funding.splitBps
}

/**
 * The one sentence for a first mint whose deployment entry is mislabeled pre-packing.
 *
 * THE SHAPE THIS NAMES (measured live, 2026-08-15, every rehearsal chain): the
 * generation is DECLARED, not probed (`packsFundingSplit`, first-mint-split.ts states
 * why probing cannot work at supply 0) — so when the flag is missing on a deployment
 * whose factory actually packs, every first mint composes the legacy unsplit payload,
 * the basket reads a zero split on every leg, `nonBufferWeight` sums to zero, the
 * acquire loop returns early having bought NOTHING, and the mint reverts
 * FirstMintUnderValued. That error reads as pool conditions ("moved the constituents
 * more than the 5% guard") and sent a real operator hunting pool depth and fee tiers;
 * the actual fix was one config key.
 *
 * The two causes need OPPOSITE remedies and only a probe can tell them apart: re-run
 * the same realised-output simulation WITH the basket's own weights packed (lawful at
 * the first mint only — the exception this file names). If the resolved (unsplit)
 * payload would not simulate but the weights-packed one answers, the deployment entry
 * is the defect, and no amount or pool change can help. Pure: the caller runs the
 * probes and this decides.
 */
export function firstMintShapeGapSentence(args: {
  /** effectiveSupply() === 0 — the only mint the weight exception covers. */
  firstMint: boolean
  /** The funding the payload actually resolved to. */
  funding: MintFunding
  /** Did the realised-output probe with the RESOLVED payload shape answer? */
  resolvedProbeAnswered: boolean
  /** Did the same probe, re-run with the basket's own weights packed, answer? */
  weightsProbeAnswered: boolean
}): string | null {
  const { firstMint, funding, resolvedProbeAnswered, weightsProbeAnswered } = args
  if (!firstMint) return null
  if (funding.source !== 'basket-weights') return null
  if (resolvedProbeAnswered) return null
  if (!weightsProbeAnswered) return null
  return (
    'This first buy went out without its funding split: the deployment entry for this chain is not marked as a packing factory (deployments.json packsFundingSplit), so the payload used the older no-split shape, and this basket generation then buys nothing and refuses. ' +
    'A probe with the split packed succeeds, so the pools and the amount are fine. ' +
    'Set packsFundingSplit to true on this chain’s deployments entry and retry.'
  )
}
