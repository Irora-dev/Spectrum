// ─────────────────────────────────────────────────────────────────────────────
// ROUTE COMPARISON — readiness B1, the my-side half (pure; the seam field
// `LifiQuote.gasCostUsd` is UIGuy's). The PM's finding: a gross comparison
// drops LiFi's gas estimate and systematically favors multi-hop aggregator
// routes on Ethereum — it can invert the winner on small legs. So: NET OF GAS,
// both arms, one function, and every tie or unreadable number falls to the
// DIRECT route — the permanently-warm fallback the policy names (aggregator
// coverage is per-asset transient; the PRISM lesson).
//
// This module never sees calldata and never touches floors — it picks which
// arm gets composed. Floors stay the batcher/B2 law regardless of winner.
//
// AUDIT ROUND (2026-08-04 — this module was in NEITHER half of the battle
// test, and four things were wrong):
//  · "UNREADABLE KILLS THE RACE" WAS WRITTEN FOR `null`. A NaN walked straight
//    past the null check: the race ran, the margin came out NaN, and the review
//    would have rendered "direct route won by $NaN". Infinity did the same.
//    Every number is `Number.isFinite`-checked now, on both arms and both
//    fields — the law is about READABILITY, and NaN is the least readable
//    number there is.
//  · A NEGATIVE COST IS NOT A COST. An aggregator quote claiming gas of
//    −$1,000 won by $1,005 — free money, and a route wins by asserting it.
//    Negative gas and negative delivery are now UNREADABLE, not favorable:
//    quotes are third-party data (the attacker-controlled-strings lesson
//    applied to numbers).
//  · A TIE NEEDS A WIDTH. "Ties fall to direct" was exact-equality, so a
//    margin of a third of a cent moved the money through a third-party spender
//    and an extra allowance — for a number that rounds to $0.00 in the very
//    field that reports it. Anything under a cent is a tie.
//  · A RACE BOTH ARMS LOSE IS NOT A WIN. When gas exceeds delivery on both
//    sides, the old verdict just named the "winner"; the caller had no way to
//    know the trade destroys value either way. `uneconomic` says it, and the
//    review can refuse or warn rather than presenting a loss as a choice.
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteArm {
  /** What the route delivers, USD (the like-with-like number — refuel-bearing
   *  quotes must already be normalized by the caller per the bridging law). */
  outUsd: number
  /** What executing it costs in gas, USD. Null = unreadable — NOT zero. */
  gasCostUsd: number | null
}

export interface RouteVerdict {
  winner: 'direct' | 'aggregator'
  /** Net advantage of the winner over the loser, USD; null when the race
   *  never ran (an arm missing/unreadable — the fallback won by default).
   *  Never NaN: an unreadable number ends the race instead of entering it. */
  marginUsd: number | null
  /** True when the aggregator arm was priced but lost/was refused — the
   *  review can say "direct route won" with a number instead of silence. */
  raced: boolean
  /** True when the WINNER still delivers less than its own gas costs: the
   *  trade destroys value whichever arm runs. The review must say so rather
   *  than presenting a loss as a choice. */
  uneconomic: boolean
}

/** Under a cent apart is a TIE, and ties fall to direct — our own route, no
 *  third-party spender, no extra allowance. Sub-cent noise must never be worth
 *  an approval. */
export const ROUTE_TIE_EPSILON_USD = 0.01

/** A readable money number: finite AND not negative. A negative delivery or a
 *  negative cost is malformed third-party data, not an opportunity. */
const readable = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** Pick the arm to compose. `aggregator` null = no quote (timeout, 429, no
 *  coverage) — direct wins uncontested, which is the policy's rule 5, not an
 *  error state. */
export function pickRoute(direct: RouteArm, aggregator: RouteArm | null): RouteVerdict {
  const directReadable = readable(direct.outUsd) && readable(direct.gasCostUsd)
  // The direct arm is our own route and always the fallback, so even an
  // unreadable direct arm returns 'direct' — but the race cannot have run.
  if (!aggregator || !directReadable || !readable(aggregator.outUsd) || !readable(aggregator.gasCostUsd))
    return { winner: 'direct', marginUsd: null, raced: false, uneconomic: false }

  const directNet = direct.outUsd - (direct.gasCostUsd as number)
  const aggNet = aggregator.outUsd - (aggregator.gasCostUsd as number)
  const aggWins = aggNet - directNet > ROUTE_TIE_EPSILON_USD
  const winnerNet = aggWins ? aggNet : directNet
  return {
    winner: aggWins ? 'aggregator' : 'direct',
    marginUsd: round2(Math.abs(aggNet - directNet)),
    raced: true,
    // gas eats the whole delivery: true whichever arm we pick
    uneconomic: winnerNet <= 0,
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
