// ─────────────────────────────────────────────────────────────────────────────
// THE REALISED-PRICE MONITOR — rule 7, and the only thing that can SEE the skim.
//
// BACKEND-FLOOR-DISCIPLINE rule 7, verbatim: "Build the realised-price monitor
// BEFORE launch. `LegFilled` emits both the measured input and the measured
// delivery, so realised price per leg is auditable off-chain. **Alert when
// `delivered/used` clusters at the floor across many legs** — that is the
// signature of the invisible skim (a route that fills 100 and hands us exactly
// the 99 we floored, pocketing the rest, indistinguishable from ordinary
// slippage on chain)."
//
// WHY NOTHING ELSE CATCHES THIS. Rules 1–5 decide what we ALLOW; they cannot
// tell whether the allowance was taken. On chain a skimmed leg and an honest
// thin-market leg are the same event: both delivered less than quoted, both
// above the floor, both `LegFilled`. The tell is not in any single leg — it is
// in the DISTRIBUTION. Honest execution scatters inside the tolerance band;
// extraction hugs its edge, because an extractor takes everything the floor
// permits and not one wei less.
//
// ⚠ THE ABI TRAP, from their doc and worth repeating at the point of use: the
// `LegFilled` event's third field is NAMED `sellAmount` but carries the MEASURED
// `used`. The value is the right one; the name will mislead whoever wires the
// decoder.
//
// ⚠ THIS MODULE ACCUSES NOBODY ON ONE LEG. A single leg landing near its floor
// is ordinary — thin markets do that. The verdict therefore requires a MINIMUM
// SAMPLE and reports "not enough legs to say" rather than a weak opinion, which
// is the same half-knowable law the rest of this lane follows: say the half you
// know, invent nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** One filled leg, as decoded from `LegFilled` plus what we floored it at. */
export interface FilledLeg {
  key: string
  /** MEASURED funding consumed (the event's misnamed `sellAmount`). */
  fundingUsed: bigint
  /** MEASURED buyToken produced at the contract, before the forward. */
  delivered: bigint
  /** OUR floor for this leg — what we told the contract to enforce. */
  minBuyAmount: bigint
  /** The quote this leg's floor derived from, so slack is measured against the
   *  band we actually granted rather than against a re-derived guess. */
  quotedBuyAmount: bigint
}

/**
 * How much of the tolerance band this leg LEFT ON THE TABLE, in bps of the
 * band. 0 = landed exactly on the floor (took every bp we permitted); 10_000 =
 * landed at the full quote (took none of it).
 *
 * Null when the band is empty or the inputs are unusable — an unmeasurable leg
 * is excluded from the verdict rather than counted as clean, because counting
 * unreadable legs as clean is how a monitor reports calm during an outage.
 */
export function bandSlackBps(leg: FilledLeg): number | null {
  if (leg.quotedBuyAmount <= 0n || leg.minBuyAmount <= 0n) return null
  if (leg.delivered < 0n) return null
  const band = leg.quotedBuyAmount - leg.minBuyAmount
  if (band <= 0n) return null // no band granted: nothing to hug
  const slack = leg.delivered - leg.minBuyAmount
  if (slack < 0n) return 0 // below our own floor: the contract should have reverted
  const capped = slack > band ? band : slack
  return Number((capped * 10_000n) / band)
}

export type SkimVerdict =
  /** Not enough measurable legs to distinguish extraction from thin markets. */
  | { kind: 'insufficient-sample'; measured: number; needed: number; message: string }
  /** The distribution looks like ordinary execution. */
  | { kind: 'ordinary'; measured: number; medianSlackBps: number; atFloor: number; message: null }
  /** Deliveries are hugging the floor across many legs — the skim's signature. */
  | { kind: 'clustered-at-floor'; measured: number; medianSlackBps: number; atFloor: number; message: string }

/** Below this share of the granted band, a leg counts as "at the floor". A
 *  design constant: 5% of the band is close enough that ordinary market noise
 *  would rarely land there repeatedly. Named and exported so it can be
 *  calibrated against live fills rather than argued about. */
export const AT_FLOOR_BAND_SHARE_BPS = 500

/** Fewer legs than this and the distribution says nothing. */
export const MIN_SAMPLE = 8

/** Above this share of measurable legs sitting at the floor, alert. */
export const CLUSTER_ALERT_SHARE = 0.6

/**
 * The verdict over a set of filled legs — one batch, or many batches pooled.
 *
 * Pure. The caller decodes `LegFilled` and supplies the floors it set; this
 * module only judges the shape of the result.
 */
export function skimSignal(legs: readonly FilledLeg[], opts: { minSample?: number } = {}): SkimVerdict {
  const minSample = opts.minSample ?? MIN_SAMPLE
  const slacks = legs.map(bandSlackBps).filter((s): s is number => s != null)
  const measured = slacks.length
  if (measured < minSample) {
    return {
      kind: 'insufficient-sample',
      measured,
      needed: minSample,
      message: `Only ${measured} leg${measured === 1 ? '' : 's'} could be measured; ${minSample} are needed before the pattern means anything.`,
    }
  }
  const sorted = [...slacks].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const medianSlackBps = sorted.length % 2 === 1 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2)
  const atFloor = slacks.filter((s) => s <= AT_FLOOR_BAND_SHARE_BPS).length

  if (atFloor / measured >= CLUSTER_ALERT_SHARE) {
    return {
      kind: 'clustered-at-floor',
      measured,
      medianSlackBps,
      atFloor,
      // ⚠ bounded deliberately: the strings sweep caught the first version of
      // this sentence at ~255 characters, over the 240 shown-text bound — an
      // alert nobody can read is not an alert.
      message: `${atFloor} of ${measured} legs landed within ${AT_FLOOR_BAND_SHARE_BPS / 100}% of the least we would accept. Honest fills scatter; sitting on that edge is what a route does when it keeps the rest. Check these before running more.`,
    }
  }
  return { kind: 'ordinary', measured, medianSlackBps, atFloor, message: null }
}

/**
 * The realised rate for a leg, as a ratio of what the quote implied — the
 * number a human actually wants to see beside a fill ("you got 99.4% of the
 * quoted amount"). Returned in bps of the quote; null when unmeasurable.
 *
 * SEPARATE FROM THE VERDICT ON PURPOSE: this is per-leg reporting, and the
 * verdict above is deliberately NOT derivable from any single leg.
 */
export function realisedVsQuoteBps(leg: FilledLeg): number | null {
  if (leg.quotedBuyAmount <= 0n || leg.delivered < 0n) return null
  return Number((leg.delivered * 10_000n) / leg.quotedBuyAmount)
}
