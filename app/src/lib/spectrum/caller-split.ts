import type { ContractSplitResult } from './contract-split'
import {
  crossCheckSplit,
  degenerateSplitVerdict,
  deriveSplitBps,
  guardSplit,
  type LegMark,
  type LegVerdict,
} from './split-guard'

// ─────────────────────────────────────────────────────────────────────────────
// caller-split — the D-R1 handshake, whole (layers 2-4 composed).
//
// ⛔ ITS `splitBps` IS NOT A PAYLOAD SPLIT. Step 3 below ("pass OURS") is
// SUPERSEDED by measurement: contracts showed on 2026-08-05 that a split derived
// from our own reading of a basket costs a $10,000 buyer $5,745 on a basket whose
// first minter starved a leg, where the factory's lens split costs $100. What a buy
// encodes now comes from `factory.bareLegMins`, untouched — mint-funding.ts is the
// only producer, and this module is a GUARD layer (cross-check, dust-pool refusal),
// never a provenance. Do not wire `plan.splitBps` into hookData.
//
// The original spec (SpectrumContracts 2026-08-02), step by step:
//   1. the kit computes its OWN split — marks fed by the caller, and the caller
//      is expected to feed REALIZABLE values (simulate-and-measure per leg, the
//      swap-sim pattern), not spot marks: value = price × quantity only if that
//      price is achievable at that quantity.
//   2. the contract's derived split is read beside it (contract-split.ts).
//   3. agreement within tolerance → proceed, and pass OURS — the caller-supplied
//      path is the informed path.
//   4. disagreement beyond tolerance, or EITHER side implying ~nothing on a leg
//      that holds reserves → DO NOT QUOTE. Warn and offer a resync. Someone told
//      "these prices disagree, refresh" is strictly better off than someone
//      silently filled on a bad split.
//   5. the contract REFUSING to derive (BareSplitNotDerivable) is a hard signal
//      of its own — surfaced, never swallowed.
//
// Pure: the contract read happens outside and its RESULT is an input, so every
// branch here is walkable in a unit test without a chain.
//
// The cross-check tolerance (CONTRACT_AGREE_PCT) is MEASURED as of 2026-08-03
// — see its declaration in split-guard.ts for the fork-measured band and the
// size-dependence caveat for very large trades.
// ─────────────────────────────────────────────────────────────────────────────

/** A leg as the handshake sees it: the guard's mark plus the basket's intent
 *  (seed weight), which the degeneracy check reads. */
export interface CallerSplitLeg extends LegMark {
  /** The leg's seed/target weight in bps, when known. Null is honest-unknown. */
  seedBps?: number | null
}

export interface CallerSplitPlan {
  ok: true
  /** OUR derived split. ⛔ NOT for a payload (see the header): a buy encodes the
   *  factory's lens split. Useful only as a number to compare against. */
  splitBps: number[]
  /** Non-blocking observations, already user-worded (e.g. unverified depth). */
  warnings: LegVerdict[]
  /** False when the factory predates bareLegMins — the cross-check honestly did
   *  not run, and the caller may want to say so rather than imply it passed. */
  crossChecked: boolean
}

export interface CallerSplitRefusal {
  ok: false
  /** Layer 4's sentence — shown to the user in place of a quote. */
  headline: string
  verdicts: LegVerdict[]
  /** True when refreshing prices is the plausible remedy; false when the block
   *  is structural (a dust pool does not deepen on retry). */
  resync: boolean
}

export type CallerSplitOutcome = CallerSplitPlan | CallerSplitRefusal

const STRUCTURAL: ReadonlyArray<LegVerdict['code']> = ['depth', 'dust-pool', 'no-depth-data']

function refuse(headline: string, verdicts: LegVerdict[]): CallerSplitRefusal {
  const structural = verdicts.some((v) => v.severity === 'block' && STRUCTURAL.includes(v.code))
  return { ok: false, headline, verdicts, resync: !structural }
}

/**
 * Decide the caller split for a buy, or refuse to quote.
 *
 * `tradeUsdPerLeg` is each leg's intended funding (same order as `legs`); the
 * depth check measures the trade against the market it will hit. `contract` is
 * the pre-fetched read — pass `{ kind: 'unavailable' }` on a pre-rev factory.
 */
export function planCallerSplit(
  legs: CallerSplitLeg[],
  tradeUsdPerLeg: number[],
  contract: ContractSplitResult,
): CallerSplitOutcome {
  // Layer 2 + absurdity signal 1 (cost basis) + depth, over our own marks.
  const guard = guardSplit(legs, tradeUsdPerLeg)
  if (guard.blocking) {
    return refuse(guard.headline ?? 'These prices cannot be trusted right now.', guard.legs)
  }

  const ours = deriveSplitBps(legs, tradeUsdPerLeg)
  if (ours == null) {
    return refuse('Could not derive a trustworthy split from current prices.', guard.legs)
  }

  // Absurdity signal 2 on OUR split: a broken number is broken wherever it came from.
  const oursDegenerate = degenerateSplitVerdict(ours, legs)
  if (oursDegenerate.length > 0) {
    return refuse(oursDegenerate[0].reason ?? 'The derived split is broken.', oursDegenerate)
  }

  // Step 5 — the contract refusing to derive is a hard signal, surfaced as such.
  if (contract.kind === 'not-derivable') {
    return {
      ok: false,
      headline: 'The contract itself could not derive a trustworthy split for this basket right now.',
      verdicts: [
        {
          symbol: 'contract',
          severity: 'block',
          code: 'source-disagreement',
          reason: contract.named
            ? 'The factory refused to derive a bare split (BareSplitNotDerivable).'
            : 'The factory rejected the split derivation.',
        },
      ],
      resync: true,
    }
  }

  // Pre-rev factory: the cross-check honestly did not run.
  if (contract.kind === 'unavailable') {
    return { ok: true, splitBps: ours, warnings: guard.legs, crossChecked: false }
  }

  // Steps 3-4 — compare, and disagreement means NEITHER side gets trusted.
  const contractBps = contract.legs.map((l) => l.splitBps)
  const theirsDegenerate = degenerateSplitVerdict(contractBps, legs)
  if (theirsDegenerate.length > 0) {
    return refuse(theirsDegenerate[0].reason ?? 'The contract-derived split is broken.', theirsDegenerate)
  }
  const disagreement = crossCheckSplit(ours, contractBps)
  if (disagreement.length > 0) {
    return refuse(
      'Our price reading and the contract’s disagree about this basket. Refresh and try again rather than trading through the disagreement.',
      disagreement,
    )
  }

  return { ok: true, splitBps: ours, warnings: guard.legs, crossChecked: true }
}
