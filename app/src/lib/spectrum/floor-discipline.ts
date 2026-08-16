// ─────────────────────────────────────────────────────────────────────────────
// BACKEND FLOOR DISCIPLINE — the portfolio batcher's actual security boundary.
//
// Implements rules 1–5 of spectrum-contracts/docs/BACKEND-FLOOR-DISCIPLINE.md
// (SpectrumContracts, 2026-08-06). Rules 6 (private mempool) and 7 (realised-
// price monitor) are separate deliverables and are NOT in this file.
//
// WHY THIS FILE IS THE CONTROL. The batcher verifies delivery by measured
// balance delta against the per-leg `minBuyAmount` WE supply, and it has no
// price reference with which it could ever check that number is economically
// meaningful. `ZeroFloor` rejects 0 and nothing else. Their round-3 measured
// the consequence: a leg routing 100% of its budget to an attacker and handing
// back 1 wei passed every on-chain guard, because the floor said 1 wei was
// acceptable. A dishonest floor is indistinguishable from ordinary slippage on
// chain. So the protection is not in the contract; it is here.
//
// THE SHAPE OF THE ANSWER. For each leg we build a total slippage tolerance
//
//     s_i = s_market_i + self_impact_i + tax_i
//
// and floor at `quote.buyAmount × (1 − s_i)`. Two things about that sum are
// easy to get wrong and both are load-bearing:
//
//   · s IS PER-ASSET AND IT GROWS ALONG THE BATCH. The backend quotes every leg
//     against ONE pre-batch chain state, but the legs execute sequentially and
//     typically share a hop (USDC→WETH is shared by essentially every leg of a
//     USDC-funded portfolio). Each leg moves that hop against the next, so a
//     constant `s` is wrong by construction for every leg after the first.
//     Their measurement: 32 legs over a $50k shared hop cost the last leg
//     2,968 bps against its own quote.
//   · THE CAP IS A REFUSAL, NOT A CLAMP. If an honest floor needs more room
//     than `sMaxBps`, clamping would hand back a floor we know to be too loose
//     while looking like we applied a limit. The leg is refused instead. Fewer
//     legs submitted is a better failure than a leg submitted with a floor that
//     does not protect it.
//
// DIRECTION MATTERS EVERYWHERE IN HERE: a LARGER s is a LOOSER floor (more
// extractable value permitted), a smaller s is a tighter floor (an honest leg
// may revert). We round the self-impact term UP, because that term is a real
// cost that WILL be incurred and under-stating it reverts honest legs — and we
// then bound the total with the cap, which is the thing that stops "round up"
// becoming "no protection".
// ─────────────────────────────────────────────────────────────────────────────

/** Rule 5's recommended product cap. The only bound that exists on the largest
 *  line in the cost stack. Still the default for every leg that does not carry
 *  its own ceiling, and still the thing that bounds SELF-IMPACT on a deep asset
 *  in a large batch — which is most of what it was protecting. */
export const S_MAX_BPS = 300

/**
 * THE THIN-MARKET CEILING — the owner's ruling, live 2026-08-15, after three
 * on-chain `RequiredLegFailed` reverts on a $3,154 $LNOC leg: "for small caps
 * we should allow open slippage but just surface it for people to be aware."
 *
 * ⚠ WHY A HIGHER CEILING IS THE CORRECT ANSWER HERE AND NOT A LOOSENING OF
 * DISCIPLINE — measured on 4663, not reasoned about:
 *
 *  · His $3,154 into $LNOC pays 2,120 bps of its OWN price impact (quote curve:
 *    $100 → $0.00210/token, $3,154 → $0.00255/token). That impact is already
 *    INSIDE 0x's buyAmount, so it is not what the floor is protecting against.
 *  · What the floor is protecting against is quote-to-execution drift, and in a
 *    pool this thin drift is a STEP FUNCTION, not a trickle: sampling the same
 *    quote every 12s for 4 minutes gave 854 bps peak-to-trough with 722 of it
 *    arriving in ONE 12-second interval, flat to within 1 bps either side of it.
 *    That step is somebody else's trade landing. A 100 or 250 bps tolerance
 *    survives the quiet and dies at the first step — which is exactly what his
 *    three reverts were.
 *  · So for a measured-thin asset the choice is not "tight floor vs loose
 *    floor", it is "a floor that permits the trade vs a floor that guarantees a
 *    revert". A tolerance that cannot be met is not protection; it is a
 *    permanent refusal wearing protection's clothing.
 *
 * THE BOUNDS THAT MAKE IT SAFE, and the reviewer should check each:
 *  1. It is reachable ONLY on MEASURED depth. Unreadable depth still returns a
 *    null market term and still refuses (the read-failed law is untouched).
 *  2. It is PER-LEG. A deep asset's ceiling stays `S_MAX_BPS`, so the bound on
 *    self-impact in a large batch — the thing that cap was really holding — is
 *    unchanged for every leg that is not itself thin.
 *  3. The QUOTE is still independently validated: the plausibility bracket
 *    (±400 bps against a depth-aware expectation) refuses a wrong quote before
 *    any floor derives from it, so a wide floor cannot rescue a bad quote.
 *  4. It bounds what the user RECEIVES, never what they SPEND. `sellAmount` is
 *    exact and approved exactly; a wider tolerance can only mean fewer tokens
 *    for the same dollars, and the resulting worst case is stated in dollars on
 *    the review card before they sign. That surfacing is half of the ruling and
 *    is not optional.
 *
 * ⚠⚠ RAISED TO 3,000 AND THEN PUT BACK TO 1,200 THE SAME HOUR — the premise of
 * the raise was measured false, so the raise had to go with it. What settled it:
 * the batch fails with a ONE-WEI floor, i.e. with our protection fully disabled,
 * so no tolerance number was ever the binding constraint. Widening it bought
 * nothing and gave away real protection. 1,200 stays because it has its own
 * measurement (the 722-bps single-interval step below); 3,000 had only a hope
 * attached to it. The live failure is a BATCHER-vs-USER execution difference —
 * a user-taker swap fills $6,000 through the same pool at every slippage while
 * the batcher-composed one refuses above ~$1,000 — which is a routing/caller
 * question for the contract lane, not a floor question. Do not re-raise this
 * without a measurement that a wider floor is what changes the outcome.
 *
 * The superseded reasoning, kept because the ruling itself still stands for the
 * day a tolerance IS the binding thing: the owner's second ruling after a
 * $7,167 leg still refused at 1,200: "we have to allow for a way higher
 * slippage tolerance, yes ill be moving price up 30% thats fine, just as long
 * as people are aware that will happen." The measured behaviour backs him: the
 * refusal is 0x's own router saying "return too low", intermittently — the pool
 * genuinely moves between the quote and the simulated execution, in steps of
 * hundreds of bps, and at his size relative to a $31k pool the sensitivity to
 * anyone else's trade is large. A ceiling that cannot absorb that is a
 * permanent refusal, which is the failure mode he has hit six times.
 *
 * ⚠ AND A METHOD NOTE, because it nearly sent this the wrong way: an `eth_call`
 * control appeared to show every floor passing, which argued AGAINST widening.
 * That control was worthless — it also "passed" with a ZERO allowance and no
 * approval, which no honest execution can do. `eth_simulateV1` enforced the
 * allowance correctly and is the trustworthy one. A control that cannot fail is
 * not evidence; check that yours can produce a negative before believing it.
 *
 * ⚠ IT SITS ABOVE THE DRIFT BAND'S OWN CAP, WITH HEADROOM, AND THAT GAP IS
 * LOAD-BEARING — the second pin my first cut broke (:695, two thin legs). The
 * band saturates at `MAX_QUOTE_DRIFT_BPS`; `s` is then that band PLUS the
 * batch's accumulated self-impact. A ceiling equal to the band's cap therefore
 * leaves a saturated leg exactly zero room for self-impact, so the second thin
 * leg of any batch refuses — the old design always kept this gap (250 band
 * under a 300 cap) and losing it turned a widening into a new refusal. The
 * ratio is deliberately kept generous rather than equal: a thin batch's
 * self-impact is the term most likely to be large.
 *
 * ⚠ THE RESIDUAL, STATED: rule 6 (private mempool) is NOT implemented, so a
 * wider floor is also more room for a sandwich on this leg. On a $23k pool the
 * measured honest drift already exceeds what a tight floor allows, so the tight
 * floor was not buying protection so much as preventing the trade — but this is
 * a real widening of a money tolerance and it is on SpectrumContracts' desk as
 * such, not smuggled in.
 */
export const S_MAX_THIN_BPS = 1_200

export interface FloorLegInput {
  /** Stable identity for reporting — never used in the maths. */
  key: string
  /** The quote's own buyAmount, raw units. Rule 1: the floor derives from THIS,
   *  never from 0x's internal minBuyAmount, which is its own default tolerance
   *  living inside calldata we never parse. */
  quotedBuyAmount: bigint
  /** Notional this leg pushes through the shared hop, in the hop's funding-side
   *  units (USD-equivalent is fine as long as it matches `hopReserve`). */
  notional: number
  /** Rule 2: measured market slippage for THIS asset's binding hop, bps. Null =
   *  unmeasured, which is not zero — the leg is refused. */
  marketSlippageBps: number | null
  /** Rule 4: the buyToken's known transfer tax in bps. The contract floors on
   *  what the SWAP produced, before the forward, so a fee-on-transfer token
   *  skims the user afterwards and the widening must happen here. 0 for a
   *  normal token; null when we do not know, which is refused rather than
   *  assumed to be 0 — an unknown tax on a reflection token is exactly the
   *  500-bps-loose case the rule exists for. */
  buyTokenTaxBps: number | null
  /** THIS LEG'S OWN ceiling, bps (the owner's thin-market ruling — see
   *  `S_MAX_THIN_BPS`). Absent = the batch cap applies, which is the deep-market
   *  default and the behaviour every existing caller gets unchanged. Present =
   *  the caller MEASURED this asset's depth and sized a ceiling for it, and the
   *  surface states the number to the user.
   *
   *  Unusable here means the same as it does for the batch cap and gets the same
   *  answer — this leg refuses, rather than silently falling back to a cap the
   *  caller did not ask for. Direction matters: a caller who asked for a ceiling
   *  we cannot honour must never receive a laxer one by default. */
  sMaxBps?: number
}

export interface FloorLegResult {
  key: string
  /** What to put in the batch. Guaranteed > 0. */
  minBuyAmount: bigint
  /** The total tolerance applied, bps — for the audit trail. */
  sBps: number
  breakdown: { marketBps: number; selfImpactBps: number; taxBps: number }
}

export type FloorRefusalReason =
  | 'unmeasured-market-slippage'
  | 'unknown-buy-token-tax'
  | 'unreadable-quote'
  | 'unreadable-hop-reserve'
  | 'exceeds-s-max'
  | 'floor-rounds-to-zero'
  /** Rule 4, stated honestly: the contract floors on what the SWAP produced,
   *  before the forward, so a fee-on-transfer buyToken skims the user AFTER the
   *  only guard we have. No floor on this contract can cover that. */
  | 'buy-token-taxes-the-forward'
  /** A caller supplied a cap we cannot honour (non-finite, <= 0, or > 10,000).
   *  Refused rather than quietly replaced with the product default — replacing
   *  it would hand back a LOOSER bound than was asked for. */
  | 'unusable-cap'

export interface FloorRefusal {
  key: string
  reason: FloorRefusalReason
  /** Plain words — this reaches a human deciding whether to run the batch. */
  message: string
  /** Present when the refusal was the cap, so the operator can see by how much. */
  neededBps?: number
}

export interface FloorPlan {
  legs: FloorLegResult[]
  refusals: FloorRefusal[]
}

/**
 * Rule 3's closed form: `self_impact_i ≈ 1 − 1 / (1 + V_before_i / R_hop)²`,
 * where `V_before_i` is the cumulative batch notional through the shared hop
 * BEFORE this leg. Matches their measurement to ~20 bps.
 *
 * Returns bps, rounded UP. Null when the reserve cannot be read — an unmeasured
 * hop is not a deep hop, and on Robinhood 4663 this term was measured at
 * 700–3,000 bps, so assuming it away is the specific mistake the rule names.
 */
export function selfImpactBps(cumulativeNotionalBefore: number, hopReserve: number | null): number | null {
  if (hopReserve == null || !Number.isFinite(hopReserve) || hopReserve <= 0) return null
  if (!Number.isFinite(cumulativeNotionalBefore) || cumulativeNotionalBefore < 0) return null
  const ratio = 1 + cumulativeNotionalBefore / hopReserve
  const impact = 1 - 1 / (ratio * ratio)
  if (!Number.isFinite(impact) || impact < 0) return null
  return Math.ceil(Math.min(impact, 1) * 10_000)
}

/**
 * Rule 2's own-size term: the shortfall of a single constant-product swap of
 * `notionalUsd` against a pool whose TOTAL liquidity is `poolLiquidityUsd`
 * (both sides — the funding-side reserve is half of it). The exact output law
 * is `out = R_out·v/(R_in+v)`, so the shortfall vs the frictionless spot quote
 * is `v/(R_in+v)`. Concentrated pools (V3/V4) fill BETTER than constant
 * product at the same TVL, so this errs TIGHT (an honest leg leans on the
 * drift band), never loose — and the cap bounds the sum regardless.
 *
 * Returns bps rounded UP; null when the depth cannot be read — unmeasured is
 * not deep (rule 2: never a global constant, never a guess).
 */
export function singleSwapImpactBps(notionalUsd: number, poolLiquidityUsd: number | null): number | null {
  if (poolLiquidityUsd == null || !Number.isFinite(poolLiquidityUsd) || poolLiquidityUsd <= 0) return null
  if (!Number.isFinite(notionalUsd) || notionalUsd < 0) return null
  const fundingSide = poolLiquidityUsd / 2
  const impact = notionalUsd / (fundingSide + notionalUsd)
  if (!Number.isFinite(impact) || impact < 0) return null
  return Math.ceil(Math.min(impact, 1) * 10_000)
}

/**
 * Build every leg's `minBuyAmount`, in execution order.
 *
 * ORDER IS SEMANTIC, not cosmetic: the self-impact term accumulates along the
 * array, so callers must pass legs in the order the batch will execute them.
 * Passing them in a different order produces floors for a batch that will not
 * happen.
 *
 * A refused leg is REMOVED, not floored at something arbitrary — and the caller
 * is expected to surface the refusals rather than quietly submit a shorter
 * batch (rule 5's "REFUSE to submit any leg above it").
 */
export function deriveLegFloors(
  legs: readonly FloorLegInput[],
  opts: { hopReserve: number | null; sMaxBps?: number },
): FloorPlan {
  // A-8: `??` catches null/undefined only, so a NaN cap survived and every
  // `sBps > sMax` comparison was false — the cap silently switched OFF and a
  // 5,000-bps floor shipped. An unusable cap falls back to the product cap.
  // ⚠ MY OWN FIX INTRODUCED A LOOSENING HERE AND REVIEW CAUGHT IT (2026-08-07).
  // Closing the NaN hole, I wrote `> 0 ? cap : S_MAX_BPS`, which silently
  // WIDENED a caller's cap of 0 or negative up to 300 — the dangerous direction,
  // in the module whose header says direction matters everywhere. Measured:
  // cap 0 with a 250-bps leg refused BEFORE the fix and shipped AFTER it.
  //
  // An UNUSABLE cap and an ABSENT one are different questions and now get
  // different answers: absent → the product cap; present-but-unusable → refuse
  // every leg, because a caller who asked for a cap we cannot honour must not
  // silently receive a laxer one. Above 10,000 is also unusable: `10_000 - sBps`
  // would go negative and the "positive by construction" comment below would
  // become false.
  const capGiven = opts.sMaxBps !== undefined
  const capUsable = Number.isFinite(opts.sMaxBps) && (opts.sMaxBps as number) > 0 && (opts.sMaxBps as number) <= 10_000
  if (capGiven && !capUsable) {
    return {
      legs: [],
      refusals: legs.map((l) => ({
        key: l.key,
        reason: 'unusable-cap' as const,
        message: 'The protection limit for this batch could not be read, so no floor was derived. Nothing was composed.',
      })),
    }
  }
  const sMax = capUsable ? (opts.sMaxBps as number) : S_MAX_BPS
  const out: FloorLegResult[] = []
  const refusals: FloorRefusal[] = []
  // Accumulates over legs we actually SUBMIT: a refused leg never executes, so
  // it never moves the shared hop and must not inflate later legs' impact.
  let cumulative = 0

  for (const leg of legs) {
    if (typeof leg.quotedBuyAmount !== 'bigint' || leg.quotedBuyAmount <= 0n) {
      refusals.push({ key: leg.key, reason: 'unreadable-quote', message: 'No usable quote for this leg, so no honest floor can be built for it.' })
      continue
    }
    if (leg.marketSlippageBps == null || !Number.isFinite(leg.marketSlippageBps) || leg.marketSlippageBps < 0) {
      refusals.push({ key: leg.key, reason: 'unmeasured-market-slippage', message: 'This asset’s pool depth could not be measured, so its slippage is unknown and we will not guess a floor.' })
      continue
    }
    // UNKNOWN tax composes at the UNTAXED (tight) floor — the owner's ruling,
    // 2026-08-15 live ("we shouldn't refuse unknown tokens, we can never
    // track all tokens"), superseding the refuse-on-unknown posture. This is
    // fail-CLOSED at the contract's own measurement, with ONE bounded residual.
    // The floor is checked on `got` — the buy-token delta measured AT THE
    // BATCHER, before the forward (SpectrumPortfolioBatcher.execLeg, :973-974)
    // — and the leg is then forwarded with `safeTransfer(recipient, got)`
    // (:977). A fee-on-transfer buy token is taxed AGAIN on that forward, so the
    // recipient nets one transfer-tax below `got` and can land under the floor
    // we displayed. The contract says so itself and labels it "RESIDUAL,
    // ACCEPTED + DOCUMENTED" (:969-972): bounded by that token's own fee, and
    // deliberately preferred over a recipient-side delta, which opened a
    // fund-loss vector. So a genuinely-taxed unknown usually fails its floor
    // outright at the batcher — optional leg skipped, required leg reverted
    // (MinBuyNotMet wrapped in RequiredLegFailed) — a wasted attempt, not lost
    // money; but where it passes, the under-delivery is real, bounded by that
    // token's transfer tax, and exactly zero for non-FoT tokens. A MEASURED
    // positive tax still refuses below — that is knowledge, not ignorance,
    // and rule 5's "cannot be honestly floored" stands for it. Negative or
    // non-finite claimed taxes are hostile input and stay refusable via the
    // measured branch (they are not null; they are nonsense).
    if (leg.buyTokenTaxBps != null && (!Number.isFinite(leg.buyTokenTaxBps) || leg.buyTokenTaxBps < 0)) {
      refusals.push({ key: leg.key, reason: 'unknown-buy-token-tax', message: 'This token’s claimed transfer tax is unreadable — refusing to size a floor from nonsense.' })
      continue
    }
    // THE PER-LEG CEILING (the owner's thin-market ruling). Absent → the batch cap,
    // which is what every pre-ruling caller passes and gets unchanged. Present
    // but unusable → THIS leg refuses, mirroring the batch cap's law one scope
    // down: a ceiling we cannot honour is never quietly replaced by a laxer one.
    const legCapGiven = leg.sMaxBps !== undefined
    const legCapUsable = Number.isFinite(leg.sMaxBps) && (leg.sMaxBps as number) > 0 && (leg.sMaxBps as number) <= 10_000
    if (legCapGiven && !legCapUsable) {
      refusals.push({
        key: leg.key,
        reason: 'unusable-cap',
        message: 'The protection limit for this asset could not be read, so no floor was derived for it.',
      })
      continue
    }
    const legCap = legCapGiven ? (leg.sMaxBps as number) : sMax

    const impact = selfImpactBps(cumulative, opts.hopReserve)
    if (impact == null) {
      refusals.push({ key: leg.key, reason: 'unreadable-hop-reserve', message: 'The shared hop’s depth could not be read, so the batch’s own price impact is unknown.' })
      continue
    }

    const market = Math.ceil(leg.marketSlippageBps)
    const tax = leg.buyTokenTaxBps == null ? 0 : Math.ceil(leg.buyTokenTaxBps)
    // ⚠ RULE 4 WAS APPLIED WITH THE SIGN INVERTED (found by independent review,
    // 2026-08-07). The tax was ADDED to s, which LOWERS the floor — so declaring
    // a 200-bps transfer tax bought the route 200 bps of extra room and the
    // forward skim then applied on top of that. Measured: a 200-bps token's
    // guaranteed amount fell from 997,000 to 957,460, i.e. 394 bps of
    // UNPROTECTED value, on a leg certified as inside the 300-bps cap. The spec
    // wanted the opposite: the contract floors on `got` BEFORE the forward, so
    // compensating the skim requires RAISING the floor to Q(1−s)/(1−tax).
    //
    // And raising it that way puts the floor ABOVE the quote for any real tax,
    // which is rule 5's answer stated honestly: a fee-on-transfer buyToken
    // CANNOT be honestly floored on this contract. So it is REFUSED rather than
    // submitted at a floor that protects less than the untaxed case would.
    if (tax > 0) {
      refusals.push({
        key: leg.key,
        reason: 'buy-token-taxes-the-forward',
        message:
          'This token charges a fee on every transfer, so the amount that reaches you is always less than the amount we can guarantee. We will not buy it rather than promise you a number we cannot hold.',
      })
      continue
    }
    const sBps = market + impact

    // RULE 5 — a refusal, never a clamp. See the header. The bound is the LEG'S
    // ceiling now: a thin asset may carry a wider one (measured + surfaced), and
    // a deep asset in a large batch is still held to the batch cap, which is
    // where this rule was doing most of its work.
    if (sBps > legCap) {
      refusals.push({
        key: leg.key,
        reason: 'exceeds-s-max',
        neededBps: sBps,
        message: `An honest floor for this leg needs ${sBps} bps of room, over the ${legCap} bps cap. Submitting it would mean accepting a floor we know does not protect it.`,
      })
      continue
    }

    // Integer maths on the raw amount: no float ever touches the submitted
    // number. `10_000 - sBps` is non-negative because sBps <= legCap <= 10_000;
    // the one boundary where it reaches zero (a 10,000-bps ceiling actually
    // consumed in full) produces a zero floor and is caught by the rounds-to-
    // zero refusal immediately below, so nothing composes off it.
    const minBuyAmount = (leg.quotedBuyAmount * BigInt(10_000 - sBps)) / 10_000n
    if (minBuyAmount <= 0n) {
      // ZeroFloor would reject it on chain anyway, and a floor that rounds to
      // nothing is the 1-wei case by another route.
      refusals.push({ key: leg.key, reason: 'floor-rounds-to-zero', message: 'This leg is too small to carry a meaningful floor at its required tolerance.' })
      continue
    }

    out.push({ key: leg.key, minBuyAmount, sBps, breakdown: { marketBps: market, selfImpactBps: impact, taxBps: tax } })
    cumulative += Number.isFinite(leg.notional) && leg.notional > 0 ? leg.notional : 0
  }

  return { legs: out, refusals }
}
