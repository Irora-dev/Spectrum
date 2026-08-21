import { parseUnits, type Address } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { DEPTH_FLOOR_PCT } from './insights'
import { DEFAULT_MAX_PRICE_AGE_MS } from './quote-freshness'
import type { BatcherLegInput, BatchSimResult } from './batcher'
import { skippedLegs } from './batcher'
import { showSymbol } from './safe-copy'
import {
  deriveLegFloors,
  singleSwapImpactBps,
  type FloorLegInput,
  type FloorLegResult,
  type FloorRefusal,
} from './floor-discipline'

// ─────────────────────────────────────────────────────────────────────────────
// PLAN → LEGS (slice A dark, brick 3) — the pure bridge from what the flow
// KNOWS (targets with weights, an amount, per-asset market reads and routes)
// to what the batcher SIGNS (BatcherLegInput[]), plus the decode from what
// the simulation RETURNS (BatchResult) to what the review SHOWS.
//
// Pure by construction: the async work (findBestPool per asset, decimals
// resolution, spot reads) happens in the runner that calls this — the bridge
// itself is arithmetic and law, so every claim is pinned. The laws it owns:
//
//  · BUDGETS ARE EXACT: integer-cent per-leg budgets by largest remainder —
//    the sum of legs equals the funding total to the cent, never a re-derived
//    percentage (the $3.63-DEGEN lesson lives here too).
//  · THE QUOTE BASIS IS SPOT, STATED: quotedOutRaw = budget / spotPrice in
//    the leg's own decimals — the frictionless expectation, exactly what
//    swap-quote calls the degraded basis. The measured (simulated) number
//    replaces it the moment the deployed batcher can answer; floors stay a
//    haircut on whichever basis is in force (B2's law, one derivation).
//  · THIN IS MARKED, NOT DROPPED: a leg whose budget is a real slice of its
//    own pool (≥ DEPTH_FLOOR_PCT, the depth card's calibrated law) composes
//    with optional=true — the consent surface the review renders. Unreadable
//    depth marks optional too: unknown is not safe.
//  · UNPRICEABLE REFUSES: a leg with no spot price cannot state a floor, and
//    a floorless leg is exactly what the batcher law refuses. The refusal
//    names the asset at review time.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanLegInput {
  symbol: string
  asset: Address
  decimals: number
  /** Normalized share of the plan, 0–100 (the flow's own normalization). */
  weightPct: number
  /** Independent spot, USD per whole token (the page's market read). <=0 or
   *  null = unpriceable — the leg refuses. */
  priceUsd: number | null
  /** Age of that spot read, ms. Stale floors are weak floors (swap-quote's
   *  own law, one bound both paths): past the bound the leg REFUSES rather
   *  than composing protection off a price that may no longer exist. Absent
   *  = the caller could not date the read — treated as stale, not as fresh. */
  priceAgeMs?: number | null
  /** Deepest single pool, USD. Null = unreadable → marked optional. */
  liquidityUsd: number | null
  /** The buyToken's KNOWN transfer tax, bps (BACKEND-FLOOR-DISCIPLINE rule 4:
   *  the contract floors on what the swap produced BEFORE the forward, so a
   *  fee-on-transfer token skims the user afterwards and the widening happens
   *  in OUR floor). 0 for a normal token — the curated book's tokens are
   *  vetted no-tax. Null = unknown, which REFUSES the leg rather than
   *  assuming 0: an unknown tax on a reflection token is the silently-
   *  500-bps-loose case the rule names. */
  buyTokenTaxBps: number | null
  /** The pools lib's route, or 'basket' for a basket leg. */
  route: { venue: Venue; ethPool: PoolKey; v3Fee: number; v2Pair: Address } | 'basket'
}

export interface PlanLegsRefusal {
  symbol: string
  reason: string
}

/** Exact integer-cent budgets by largest remainder — sums to totalCents.
 *  The total is FLOORED at the door (finding 6): a fractional cent total
 *  made the largest-remainder distribution allocate MORE than the total
 *  (50/50 of 1000.5 → 501+500), and over-allocation is the one direction
 *  a budget must never miss in. */
export function centBudgets(weights: number[], totalCents: number): number[] {
  // A HOSTILE TOTAL YIELDS NO BUDGETS (the hostile-number sweep, 2026-08-04):
  // `Math.floor(NaN)` is NaN and every derived budget inherited it, so an
  // unreadable funding figure produced NaN cent budgets — which the composer
  // then scales into calldata. Unreadable money is no money here.
  if (!Number.isFinite(totalCents)) return weights.map(() => 0)
  totalCents = Math.floor(totalCents)
  // A HOSTILE WEIGHT TAKES NO SHARE, rather than poisoning its siblings: one
  // NaN made `sum` NaN and every budget NaN with it (integerShares had the
  // identical bug — same fix, same reason: an unreadable value cannot be a
  // proportion of anything).
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))
  const sum = clean.reduce((s, w) => s + w, 0)
  if (!(sum > 0) || totalCents <= 0) return weights.map(() => 0)
  const exact = clean.map((w) => (w / sum) * totalCents)
  const floors = exact.map((e) => Math.floor(e))
  let rem = totalCents - floors.reduce((s, f) => s + f, 0)
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; rem > 0; k++, rem--) floors[order[k % order.length].i] += 1
  return floors
}

/**
 * Compose the plan's buy side into batcher leg inputs. `fundingUsdCents` is
 * the NET amount the legs spend (the fee charges separately per the ruled
 * model). Returns the legs AND the refusals — the caller shows refusals as
 * review sentences; one unpriceable leg does not silently shrink a plan.
 */
/** A plan leg in CENTS — everything the batcher needs EXCEPT the raw budget,
 *  which only the runner can mint (it knows the funding asset's decimals).
 *  The old shape carried `budgetRaw: BigInt(cents)` "for the runner to
 *  scale", which made a cents value TYPE-compatible with the batcher's raw
 *  field — the exact seam battle-test half-1 composed wrong money through.
 *  Now the batcher's brand (`FundingRaw`) is absent here by construction. */
export type PlanLeg = Omit<BatcherLegInput, 'budgetRaw' | 'minOutRaw'> & { budgetUsdCents: number }

export function planToLegs(
  targets: PlanLegInput[],
  fundingUsdCents: number,
): { legs: PlanLeg[]; refusals: PlanLegsRefusal[] } {
  const refusals: PlanLegsRefusal[] = []
  const usable = targets.filter((t) => {
    if (!Number.isFinite(t.weightPct) || t.weightPct < 0) {
      // a corrupt weight reaching parseUnits throws a raw viem error —
      // composition failures are sentences, not crashes (finding 7)
      refusals.push({ symbol: t.symbol, reason: `$${showSymbol(t.symbol)}'s weight is not a number — the plan is corrupt for this leg; rebuild it` })
      return false
    }
    if (t.priceUsd == null || !(t.priceUsd > 0)) {
      refusals.push({ symbol: t.symbol, reason: `$${showSymbol(t.symbol)} has no readable price — a floor cannot be stated, so this leg cannot ride the batch` })
      return false
    }
    if (t.priceAgeMs == null || !Number.isFinite(t.priceAgeMs) || t.priceAgeMs > DEFAULT_MAX_PRICE_AGE_MS) {
      refusals.push({
        symbol: t.symbol,
        reason: `$${showSymbol(t.symbol)}'s price read is ${t.priceAgeMs == null ? 'undated' : 'stale'} — a floor derived from it may protect nothing; re-quote and retry`,
      })
      return false
    }
    if (t.priceAgeMs < 0) {
      // a FUTURE-dated read is strictly less trustworthy than an undated one:
      // it means the clock or the subtraction is wrong (finding 4)
      refusals.push({
        symbol: t.symbol,
        reason: `$${showSymbol(t.symbol)}'s price read is dated in the future — the clock that dated it cannot be trusted; re-quote and retry`,
      })
      return false
    }
    return true
  })
  const budgets = centBudgets(
    usable.map((t) => t.weightPct),
    fundingUsdCents,
  )
  /** asset → could we read this leg's pool depth at all? A plan-time fact kept
   *  BESIDE the legs rather than on them: PlanLeg derives from the batcher's
   *  input type, and nothing about composing calldata should learn this. */
  const depthUnreadableByAsset = new Map<string, boolean>()
  const legs = usable.map((t, i): PlanLeg | null => {
    const budgetUsd = budgets[i] / 100
    // spot expectation in the leg's own decimals — the stated basis
    const expectedTokens = budgetUsd / (t.priceUsd as number)
    if (!Number.isFinite(expectedTokens)) {
      refusals.push({ symbol: t.symbol, reason: `$${showSymbol(t.symbol)}'s expected output is not a number — the price and budget do not divide; re-quote and retry` })
      return null
    }
    const quotedOutRaw = parseUnits(expectedTokens.toFixed(Math.min(t.decimals, 18)), t.decimals)
    // thin = a real slice of its own pool (the depth card's calibrated law).
    // Unreadable depth is NOT safe — optional. A ZERO (or negative) depth is
    // a DEAD pool, worse than unreadable — it must never land on the
    // required side (finding 3: liquidityUsd 0 used to read as safe).
    //
    // ⚠ AND NaN IS A THIRD SPELLING OF UNREADABLE (four-reviewer audit,
    // 2026-08-07): it passes `== null`, fails `<= 0` AND fails the ratio test
    // (every NaN comparison is false), so a leg of unmeasurable depth used to
    // land REQUIRED — composing with no thin-leg consent. The sibling this
    // guard was paired with (split-guard's depthVerdict) had the finite clause
    // from birth; this one did not. Same class I fixed in pool-safety the same
    // afternoon and did not think to grep for here — the finding is UIGuy's.
    // depth we could not READ at all, versus depth we read and found shallow.
    // The lone-leg ruling applies only to the second (see `kept.length === 1`
    // below): an unreadable depth is the read-failed class and is governed by
    // its own older law, which this ruling must not quietly overturn.
    const depthUnreadable = t.liquidityUsd == null || !Number.isFinite(t.liquidityUsd) || t.liquidityUsd <= 0
    const thin = depthUnreadable || (budgetUsd / t.liquidityUsd!) * 100 >= DEPTH_FLOOR_PCT
    depthUnreadableByAsset.set(t.asset.toLowerCase(), depthUnreadable)
    return {
      symbol: t.symbol,
      asset: t.asset,
      route: t.route,
      budgetUsdCents: budgets[i],
      quotedOutRaw,
      optional: thin,
    }
  })
  // ⚠ A ZERO-CENT LEG IS A REFUSAL, NOT A DISAPPEARANCE (reviewer M5,
  // 2026-08-07): this filter silently dropped legs whose largest-remainder
  // share rounded to zero cents — the user approved N assets and received
  // N-1 with no row saying why. Every other exit from this function speaks.
  const kept: PlanLeg[] = []
  for (const l of legs) {
    if (l == null) continue
    if (l.budgetUsdCents > 0) {
      kept.push(l)
      continue
    }
    refusals.push({
      symbol: l.symbol,
      reason: `$${showSymbol(l.symbol)}'s share of this amount rounds to zero cents — nothing would be bought; raise the amount or its weight`,
    })
  }
  // ⚠ A LONE LEG IS NEVER SKIPPABLE (the owner's ruling, 2026-08-08). `optional`
  // exists so ONE failing buy does not revert the others — with no others it
  // protects nothing and only changes which failure the user gets. Skippable:
  // the buy fails, the contract drops it, the batch reports SUCCESS, and the
  // user has paid the funding pull and our fee for nothing. Required: the batch
  // reverts, costing gas alone, and it is unambiguous that it did not happen.
  // Paying a fee to be told it worked is the worse outcome.
  //
  // Decided on the RESULTING legs, not the input targets: a plan that started
  // with five and kept one after refusals is a one-leg batch, and it is the
  // batch the contract sees that matters. Set here, at the last point before
  // the legs leave this function, so nothing downstream has to remember it.
  // ⚠ AND IT DOES NOT OVERTURN THE READ-FAILED LAW. the owner ruled on a THIN leg —
  // one whose depth we measured and found shallow. A leg whose depth could not
  // be READ is a different case with an older ruling: an unmeasurable depth
  // never lands on the required side, because a read that failed is not a
  // verdict. Two of the cross-module sweeps hold that law and caught this
  // immediately when the first cut applied the ruling to both. The interaction
  // is real (a lone unreadable-depth leg stays skippable, so its failure still
  // costs the fee) and is on the owner's desk rather than decided here.
  if (kept.length === 1 && !depthUnreadableByAsset.get(kept[0].asset.toLowerCase()))
    kept[0] = { ...kept[0], optional: false }
  return { legs: kept, refusals }
}

// ── The floor plan (BACKEND-FLOOR-DISCIPLINE wired at the plan seam) ─────────
//
// The floor is the batcher's WHOLE protection — the contract verifies delivery
// against the per-leg number WE supply and cannot judge whether it was honestly
// derived (their round-3: a leg routing 100% of its budget to an attacker and
// handing back 1 wei passed every on-chain guard). So floors are derived HERE,
// per asset, batch-aware, from measured inputs — never one global constant.
//
// REFUSAL REDISTRIBUTES, LIKE EVERY PLAN-TIME REFUSAL: a floor-refused leg is
// excluded (by asset identity, never the deployer-controlled symbol) and the
// plan re-budgets over the survivors — the same law planToLegs already applies
// to unpriceable legs. Redistribution changes budgets, budgets change impact,
// so the loop re-derives until a round refuses nothing. The exclusion set only
// grows, so it terminates. Refusals ride out as review sentences AND as the
// floor layer's structured reasons; a shorter batch is never submitted quietly.

/** The spot basis is frictionless AND ages (the stated basis law above):
 *  between the read and execution the market moves within the price-age
 *  bound. This band is the tolerance for that drift — the industry-default
 *  0.5%. A design constant to CALIBRATE against live fills once the
 *  realised-price monitor (floor doc rule 7) runs; when the basis becomes the
 *  0x quote's buyAmount (the AssetLeg refit), it shrinks to quote-to-execution
 *  drift at this same seam. */
export const SPOT_DRIFT_BAND_BPS = 50

/** The venue's own LP fee for this route, bps — a real, certain shortfall vs
 *  the frictionless spot basis, so it belongs in the floor's market term.
 *  Null = the fee cannot be read (a dynamic-fee or implausible tier, or V4Q,
 *  which is not a batch venue) — an unreadable cost refuses, never guesses. */
export function venueLegFeeBps(route: PlanLegInput['route']): number | null {
  if (route === 'basket') return null
  if (route.venue === Venue.V2) return 30 // the V2 protocol constant, 0.30%
  const raw = route.venue === Venue.V3 ? route.v3Fee : route.venue === Venue.V4 ? route.ethPool.fee : null
  // Uniswap fee units are hundredths of a bip (3000 = 30 bps); 1e6 = 100% is
  // the ceiling, and the V4 dynamic-fee flag (0x800000) sits above it.
  if (raw == null || !Number.isInteger(raw) || raw < 0 || raw > 1_000_000) return null
  return Math.ceil(raw / 100)
}

export type FlooredPlanLeg = PlanLeg & {
  /** The leg's floor, raw out units. Venue legs: derived by floor-discipline
   *  (per-asset, batch-aware). Basket legs: null — the assembly applies the
   *  legacy global haircut (a path that dies with the hub-less refit). */
  minOutRaw: bigint | null
  /** The tolerance behind a venue floor — the review/audit trail. */
  floor: { sBps: number; marketBps: number; selfImpactBps: number; taxBps: number } | null
}

// ── THE CONSENT DIVERGENCE (M2's detection half — measured 2026-08-07) ──────
//
// The fixpoint below re-budgets the FULL funding over the survivors each
// round, so refusals CASCADE: excluding a leg makes every survivor bigger,
// which refuses more thin legs, which makes the remainder bigger again. The
// end state is either everything-refuses (safe) or the deepest legs absorb
// the whole batch. Measured: 12 equal targets, one deep asset, a $50k hop —
// ONE leg composed carrying 100% where it asked for 8.33%, and it composed
// happily, because every leg was correctly floored. Nothing was stolen; what
// broke was CONSENT — the composed batch is not the portfolio the user
// approved, and nothing said so.
//
// THE FACT (concentrationOf, below) AND THE POLICY (CONCENTRATION_POLICY +
// concentrationVerdict) are now both here. The threshold question sat on
// the owner's desk (ask q-1786112460254-114) and he RULED 2026-08-13, adopting
// the standing 75% recommendation verbatim (decisions/LOG.md in the OS repo):
// the posture is REFUSE — the accepted tradeoff is that a partly-fillable
// portfolio does nothing rather than composing into a batch the user never
// approved. Both fixpoints (this one and the 0x assembler) consult ONE
// verdict, so "what the cap means" cannot drift between paths.

export interface ConcentrationRow {
  symbol: string
  /** lowercased asset address — the identity the fixpoint keys by */
  asset: string
  /** the share of the batch this leg was CONSENTED at (its weight over ALL
   *  targets the user approved, including ones later refused) */
  consentedPct: number
  /** the share of what actually composed that this leg now carries */
  realisedPct: number
  /** realised / consented — 1 is faithful, 12 is one leg wearing the batch.
   *
   *  NULL, NOT Infinity, when nothing was consented (independent pass,
   *  2026-08-08). The sentinel was Infinity and it broke this fact three ways.
   *  Every unconsented leg tied, so `Infinity - Infinity = NaN` made the
   *  comparator return NaN and the sort degenerate to INSERTION ORDER —
   *  measured, a $1 leg was named `worst` while a $79 unconsented leg sat
   *  below it, and on a top-five surface an $80 leg landed at index 10 where
   *  nobody would see it. It also does not survive JSON: `stringify` writes
   *  null and it reads back as 0, so a batch that refuses in memory PASSES
   *  after any round trip, and drafts already go through localStorage. And it
   *  poisons any aggregate — sums go Infinity, variance goes NaN, and
   *  `NaN > threshold` is FALSE, which is fail-OPEN on a safety number.
   *  Null is JSON-native, round-trips unchanged, and cannot be compared by
   *  accident: a consumer must handle "there is no ratio" explicitly, which is
   *  the honest shape of "asked for nothing, received something". */
  ratio: number | null
}

export interface PlanConcentration {
  /** EVERY composed leg, worst ratio first — never a filtered subset (a fact a
   *  policy reads may not quietly omit rows). */
  rows: ConcentrationRow[]
  /** the single worst row, or null when nothing composed */
  worst: ConcentrationRow | null
  /** how many consented targets did NOT survive to composition */
  excludedCount: number
  /** how many COMPOSED legs have no readable consent — the other direction */
  unconsentedCount: number
}

/** Compute the consent divergence of a composed set against the ORIGINAL
 *  targets. Shared by both fixpoints (plan-legs and the 0x path) so the two
 *  can never drift apart on what "concentration" means. */
export function concentrationOf(
  targets: readonly { symbol: string; asset: string; weightPct: number }[],
  composed: readonly { asset: string; budgetUsdCents: number }[],
): PlanConcentration {
  const weightSum = targets.reduce((s, t) => s + (Number.isFinite(t.weightPct) && t.weightPct > 0 ? t.weightPct : 0), 0)
  const totalCents = composed.reduce((s, l) => s + l.budgetUsdCents, 0)
  const byAsset = new Map<string, { symbol: string; weightPct: number }>()
  for (const t of targets) {
    const k = t.asset.toLowerCase()
    if (!byAsset.has(k)) byAsset.set(k, { symbol: t.symbol, weightPct: t.weightPct })
  }
  // ⚠⚠ EVERY COMPOSED LEG GETS A ROW (self-audit, 2026-08-07, hunting the class
  // the independent pass taught me: a filter that silently removes things from a
  // FACT a policy will read, while the fact still presents itself as complete).
  //
  // This used to `continue` past a composed leg whose consent was unreadable or
  // absent. MEASURED: three composed legs produced ONE row — realisedPct summed
  // to 30 instead of 100, excludedCount said 0, and `worst.ratio` reported 0.30,
  // i.e. APPARENT SAFETY, while 70% of the batch sat in legs the fact could not
  // see. the owner is about to set a policy threshold on that exact number, so a
  // silent omission there is a silent permission.
  //
  // A leg that received money it never consented to is not an ABSENCE of
  // concentration — it is the WORST kind, so it gets `consentedPct: 0` and an
  // infinite ratio, which is what "asked for nothing, received something"
  // actually means. Sorting puts it first, where it belongs.
  // ⚠ THE RATIO MUST COMPARE SHARES OF THE SAME UNIVERSE (independent pass,
  // 2026-08-08). `realisedPct` is the leg's share of the WHOLE batch, which is
  // the honest number to show; `consentedPct` is its weight over the CONSENTED
  // targets only. Dividing one by the other mixes two denominators, and the
  // reviewer named the consequence exactly: unconsented money inflates the
  // realised denominator and so DEFLATES every honest leg's ratio.
  // MEASURED: a leg consented at 50% that takes the entire batch reports
  // ratio 2 — a true 2x over-fill. Add one unconsented leg of equal size and
  // the SAME leg, holding the SAME money, reports ratio 1.0, i.e. perfectly
  // faithful. The more money lands where nobody consented, the more innocent
  // every other leg looks — fail-open on the exact number a policy will read.
  // So the ratio is measured over the CONSENTED-composed total, while
  // realisedPct keeps meaning share-of-the-whole-batch for the surface.
  const consentedCents = composed.reduce((sum, l) => {
    const t = byAsset.get(l.asset.toLowerCase())
    const readable = !!t && Number.isFinite(t.weightPct) && t.weightPct > 0 && weightSum > 0
    return readable ? sum + l.budgetUsdCents : sum
  }, 0)
  const rows: ConcentrationRow[] = []
  // ⚠ ONE NON-FINITE COMPOSED CENT EMPTIES THE FACT AND THE CAP PASSES (audit
  // F6, 2026-08-13 — fail-OPEN on a safety number). A NaN budget makes
  // `totalCents` NaN, `totalCents > 0` false, `rows: []`, and
  // concentrationRefusal returns null on a wildly concentrated batch.
  // Unreachable through today's finite-cent composition, but concentrationOf
  // is the exported shared fact and this codebase's own history (the
  // Infinity/JSON finding) shows these get recomputed from persisted data.
  // A non-finite budget is not a small share — it is unreadable money, so the
  // whole fact refuses by pinning worst to a null-ratio sentinel row.
  const hostileCent = composed.find((l) => !Number.isFinite(l.budgetUsdCents))
  if (hostileCent) {
    const row: ConcentrationRow = { symbol: hostileCent.asset, asset: hostileCent.asset.toLowerCase(), consentedPct: 0, realisedPct: 100, ratio: null }
    return { rows: [row], worst: row, excludedCount: 0, unconsentedCount: 1 }
  }
  if (totalCents > 0) {
    for (const l of composed) {
      const k = l.asset.toLowerCase()
      const t = byAsset.get(k)
      const readableConsent = !!t && Number.isFinite(t.weightPct) && t.weightPct > 0 && weightSum > 0
      const consentedPct = readableConsent ? (t!.weightPct / weightSum) * 100 : 0
      const realisedPct = (l.budgetUsdCents / totalCents) * 100
      /** the same leg's share of the CONSENTED half — the ratio's numerator, so
       *  both sides of the division describe the same universe */
      const realisedOfConsented = consentedCents > 0 ? (l.budgetUsdCents / consentedCents) * 100 : 0
      rows.push({
        symbol: t?.symbol ?? k,
        asset: k,
        consentedPct,
        realisedPct,
        ratio: consentedPct > 0 ? realisedOfConsented / consentedPct : null,
      })
    }
  }
  // UNCONSENTED FIRST, THEN BY SEVERITY WITHIN EACH GROUP. A null ratio is not
  // a missing value to sort last — it is the worst thing this fact can say, so
  // it leads. Among unconsented legs the severity is how much of the batch
  // landed there, which is exactly the ordering the Infinity tie destroyed.
  rows.sort((a, b) => {
    if ((a.ratio == null) !== (b.ratio == null)) return a.ratio == null ? -1 : 1
    if (a.ratio == null || b.ratio == null) return b.realisedPct - a.realisedPct
    return b.ratio - a.ratio
  })
  const composedAssets = new Set(composed.map((l) => l.asset.toLowerCase()))
  return {
    rows,
    worst: rows[0] ?? null,
    /** Targets the user CONSENTED to that did not compose — the opposite
     *  direction of drift from `unconsentedCount`.
     *
     *  ⚠ THE TWO COUNTERS USED INCONSISTENT DEFINITIONS OF "CONSENTED"
     *  (independent pass, 2026-08-08). `unconsentedCount` derived it from
     *  `consentedPct === 0`, while this filtered every target key with NO
     *  weight predicate at all — so a target weighted ZERO was "not consented"
     *  to one counter and "consented" to the other, and the reviewer measured
     *  the same input classified oppositely by nothing but whether it composed.
     *  Resolved toward the meaning of the weight itself: a target weighted zero
     *  is the user saying "none of this", so it is NOT consented, and its
     *  absence from the batch is the plan working rather than a target dropped.
     *  Counting it here overstated the drift on exactly the plans that were
     *  behaving. Both counters now read consent the same way.
     *
     *  THE UNITS STILL DIFFER AND THAT IS INHERENT, not an oversight: this
     *  counts ASSETS the user asked for and did not get, while
     *  `unconsentedCount` counts composed LEGS nobody asked for. They measure
     *  opposite directions and cannot share a unit — do not sum them. */
    excludedCount: [...byAsset.entries()].filter(
      ([k, t]) => !composedAssets.has(k) && Number.isFinite(t.weightPct) && t.weightPct > 0 && weightSum > 0,
    ).length,
    /** Composed legs whose consent could not be read at all — money moved for a
     *  target nobody can show the user agreeing to. Separate from
     *  `excludedCount`, which is the opposite direction (consented, not
     *  composed), because collapsing them would hide which way the plan drifted. */
    unconsentedCount: rows.filter((r) => r.consentedPct === 0).length,
  }
}

/**
 * THE CONCENTRATION POLICY — does this batch's drift exceed what was allowed?
 *
 * ⚠⚠ IT READS THE ABSOLUTE SHARE, NOT `ratio`, AND THAT IS THE WHOLE POINT
 * (measured 2026-08-08, and it changed the question rather than answering it).
 * `ratio` is realised-over-consented, and when legs are refused the survivors
 * mechanically absorb the money — so the ratio is essentially legs-planned over
 * legs-surviving. It measures HOW MANY LEGS WERE REFUSED, not how bad the
 * outcome is. Measured straight from `concentrationOf`:
 *
 *   5 legs, all 5 survive  → ratio 1.00, largest asset holds  20%
 *   5 legs, 2 survive      → ratio 2.50, largest asset holds  50%
 *   3 legs, 1 survives     → ratio 3.00, largest asset holds 100%
 *   10 legs, 3 survive     → ratio 3.33, largest asset holds  33%
 *
 * Ratio 3.00 means one asset holds EVERYTHING; ratio 3.33 — a HIGHER number —
 * means the largest holds a third. A threshold on ratio refuses the safe plan
 * and permits the dangerous one. That is not a calibration problem; the
 * variable does not track the harm. The canonical case agrees: "12 is one leg
 * wearing the batch" is twelve legs collapsing to one, which as a share is
 * simply 100% — the 12 was always standing in for the absolute share.
 *
 * `ratio` stays on the row as DESCRIPTION ("you asked for 10% of this and the
 * plan gave it 33%"), which is a good sentence and a bad gate.
 *
 * ⚠ THE THRESHOLD WAS A PARAMETER WITH NO DEFAULT until 2026-08-13, when the
 * value arrived: the owner approved this SHAPE on 2026-08-08, and RULED the number
 * live on 2026-08-13 (decisions/LOG.md in the OS repo; answers ask
 * q-1786112460254-114), adopting the standing 75% recommendation verbatim.
 * CONCENTRATION_POLICY below is that ruling as source — the marker the
 * go-live interlock greps for, present now because a ruling exists.
 *
 * COMPARE WITH TOLERANCE, never against a bare integer: the canonical case
 * measures 11.999999999999996 and a faithful plan 1.0000000009999999, so a
 * literal `>= 12` and a literal `> 1` each miss the case they were written for.
 */
export function concentrationExceeds(
  fact: PlanConcentration,
  maxSharePct: number,
  /** Float slack, in percentage points. Money maths that has been through a
   *  division does not land on integers. */
  tolerancePct = 1e-6,
): { exceeded: boolean; worstSharePct: number; symbol: string | null } {
  let worst: ConcentrationRow | null = null
  for (const r of fact.rows) if (!worst || r.realisedPct > worst.realisedPct) worst = r
  const share = worst?.realisedPct ?? 0
  return {
    exceeded: Number.isFinite(share) && Number.isFinite(maxSharePct) && share > maxSharePct + tolerancePct,
    worstSharePct: share,
    symbol: worst?.symbol ?? null,
  }
}

/** THE RULED M2 POLICY — CONSENT DIVERGENCE, not an absolute cap (the owner, live
 *  2026-08-13; decisions/LOG.md; supersedes the same-day absolute 75% cap).
 *
 *  His two rulings, verbatim: a deliberate single-asset buy (or a consented
 *  90/10) must COMPOSE — "exempt single-asset intent"; and a plan that
 *  collapses onto fewer legs must refuse or prompt re-edit — "it should never
 *  put more into assets that you didn't specify putting that money into."
 *
 *  Both unify here: the gate is per-leg OVER-ALLOCATION (realised minus
 *  consented share), not absolute share. A single-asset buy realises exactly
 *  what it consented (over-allocation 0) and passes; a deliberate 80/20 the
 *  same. A 12→2 collapse puts ~50% into a leg consented ~8% — +42 points over
 *  consent — and refuses. Money in a zero-weight asset is over-allocation by
 *  its whole share, caught by the same test. The absolute 75% cap was the
 *  prior approximation of this and is gone: it wrongly refused a deliberate
 *  80/20 and a deliberate single-asset buy.
 *
 *  The tolerance is a rounding epsilon only — largest-remainder distribution
 *  deviates sub-percent, so any MATERIAL redistribution onto survivors
 *  refuses, faithfully to "never put more." If the owner wants mild redistribution
 *  tolerated, raise maxOverAllocationPp; zero would refuse any deviation. */
export const CONCENTRATION_POLICY = {
  /** A leg may realise at most this many percentage POINTS above its consented
   *  share before the plan refuses (the owner's consent-divergence ruling). */
  maxOverAllocationPp: 1,
} as const

/** The worst over-allocated leg: how many points its realised share exceeds
 *  its consented share, and which leg. An unconsented leg (consentedPct 0)
 *  over-allocates by its whole realised share. */
function worstOverAllocation(fact: PlanConcentration): { overPp: number; row: ConcentrationRow | null } {
  let row: ConcentrationRow | null = null
  let overPp = 0
  for (const r of fact.rows) {
    if (!Number.isFinite(r.realisedPct) || !Number.isFinite(r.consentedPct)) {
      // a non-finite share is unreadable money, not a small over-allocation —
      // treat it as the worst possible so the plan refuses (audit F6 posture)
      return { overPp: Number.POSITIVE_INFINITY, row: r }
    }
    const over = r.realisedPct - r.consentedPct
    if (over > overPp) {
      overPp = over
      row = r
    }
  }
  return { overPp, row }
}

/** The ruled policy applied to the fact — ONE verdict for both fixpoints
 *  (this module's floored plan and the 0x assembler), so what "the policy"
 *  means can never drift between paths. Returns the refusal sentence, or
 *  null when no leg is over-allocated beyond the rounding tolerance. */
export function concentrationRefusal(fact: PlanConcentration): string | null {
  const worst = worstOverAllocation(fact)
  if (worst.overPp <= CONCENTRATION_POLICY.maxOverAllocationPp) return null
  const r = worst.row
  const name = r ? `$${showSymbol(r.symbol)}` : 'one leg'
  const asked = r && Number.isFinite(r.consentedPct) ? Math.round(r.consentedPct) : null
  const got = r && Number.isFinite(r.realisedPct) ? Math.ceil(r.realisedPct) : null
  const dropped = fact.excludedCount
  // consent-divergence, in the user's own terms — and it offers the re-edit
  // the owner's ruling names ("refuse or ask to re-edit").
  const askedGot =
    asked != null && got != null
      ? `You asked for ${asked}% of ${name}, but this plan would put ${got}% there`
      : `This plan would put more into ${name} than you asked for`
  const because = dropped > 0 ? ` — because ${dropped} of your assets couldn’t be bought on this network` : ''
  return (
    `${askedGot}${because}. That is more than you chose, so nothing was bought. ` +
    `Lower the amount, or re-edit your picks to assets this network can fill.`
  )
}

export interface PlanFloorsResult {
  legs: FlooredPlanLeg[]
  /** Plan-time + floor-time refusals as review sentences — one channel. */
  refusals: PlanLegsRefusal[]
  /** The floor layer's structured refusals (reason codes, needed bps) — the
   *  same events as their sentences in `refusals`, kept for the audit trail. */
  floorRefusals: FloorRefusal[]
  /** How far the composed batch drifted from what was consented — see
   *  `concentrationOf`. Since 2026-08-13 the RULED policy acts on it right
   *  here (concentrationRefusal): a batch over the cap returns ZERO legs
   *  with the refusal sentence in `refusals`, the fact still attached. */
  concentration: PlanConcentration
}

/**
 * planToLegs + the floor plan, to a fixpoint. `hopReserveUsd` is the shared
 * funding hop's funding-side reserve, MEASURED per chain by the caller
 * (canonical USDC/WETH pool on Base+Ethereum, the USDG side on 4663) — null
 * refuses every venue leg: an unmeasured hop is not a deep hop (4663 measured
 * 700–3,000 bps of batch self-impact on plausible depths).
 */
export function planToFlooredLegs(
  targets: PlanLegInput[],
  fundingUsdCents: number,
  opts: { hopReserveUsd: number | null; sMaxBps?: number },
): PlanFloorsResult {
  const excluded = new Set<string>()
  const floorRefusals: FloorRefusal[] = []
  const floorSentences: PlanLegsRefusal[] = []

  // Each round either returns or grows `excluded` — bounded by construction;
  // the explicit bound turns a broken invariant into a loud failure instead of
  // a spin.
  for (let round = 0; round <= targets.length + 1; round++) {
    const live = targets.filter((t) => !excluded.has(t.asset.toLowerCase()))
    const planned = planToLegs(live, fundingUsdCents)

    // Join floor inputs back to their targets by asset IDENTITY, first
    // occurrence wins (the dedupe law — symbols are deployer-controlled).
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

    const venueLegs = planned.legs.filter((l) => l.route !== 'basket')
    const floorInputs: FloorLegInput[] = venueLegs.map((l) => {
      const t = targetByAsset.get(l.asset.toLowerCase())
      const feeBps = venueLegFeeBps(l.route)
      const impactBps = t ? singleSwapImpactBps(l.budgetUsdCents / 100, t.liquidityUsd) : null
      return {
        key: l.asset.toLowerCase(),
        quotedBuyAmount: l.quotedOutRaw,
        notional: l.budgetUsdCents / 100,
        marketSlippageBps: feeBps == null || impactBps == null ? null : feeBps + impactBps + SPOT_DRIFT_BAND_BPS,
        buyTokenTaxBps: t ? t.buyTokenTaxBps : null,
      }
    })

    const plan = deriveLegFloors(floorInputs, { hopReserve: opts.hopReserveUsd, sMaxBps: opts.sMaxBps })

    if (plan.refusals.length === 0) {
      const floorByKey = new Map<string, FloorLegResult>(plan.legs.map((f) => [f.key, f]))
      const legs: FlooredPlanLeg[] = planned.legs.map((l) => {
        if (l.route === 'basket') return { ...l, minOutRaw: null, floor: null }
        const f = floorByKey.get(l.asset.toLowerCase())
        if (!f) throw new Error(`floor plan lost leg ${l.asset} — refusal-free rounds must floor every venue leg`)
        return {
          ...l,
          minOutRaw: f.minBuyAmount,
          floor: {
            sBps: f.sBps,
            marketBps: f.breakdown.marketBps,
            selfImpactBps: f.breakdown.selfImpactBps,
            taxBps: f.breakdown.taxBps,
          },
        }
      })
      // THE CONSENT-DIVERGENCE POLICY BINDS AT THE EXIT (the owner 2026-08-13): a
      // converged, fully-floored plan that would over-allocate a leg beyond
      // what was consented returns NOTHING — refuse-or-re-edit, his ruling,
      // with the fact attached so the surface can show what almost happened.
      const concentration = concentrationOf(targets, legs)
      const capRefusal = concentrationRefusal(concentration)
      if (capRefusal != null) {
        const worst = concentration.rows.reduce<ConcentrationRow | null>(
          (m, r) => (m == null || r.realisedPct - r.consentedPct > m.realisedPct - m.consentedPct ? r : m),
          null,
        )
        const worstSym = worst?.symbol ?? 'batch'
        return {
          legs: [],
          // the divergence sentence LEADS: downstream "first reason" surfaces
          // (the assemblers' no-composable-legs throws) must headline the
          // ruling, not whichever per-leg floor refusal accumulated first
          refusals: [{ symbol: worstSym, reason: capRefusal }, ...planned.refusals, ...floorSentences],
          floorRefusals,
          concentration,
        }
      }
      return {
        legs,
        refusals: [...planned.refusals, ...floorSentences],
        floorRefusals,
        concentration,
      }
    }

    for (const r of plan.refusals) {
      excluded.add(r.key)
      floorRefusals.push(r)
      const symbol = targetByAsset.get(r.key)?.symbol ?? r.key
      floorSentences.push({ symbol, reason: `$${showSymbol(symbol)}: ${r.message}` })
    }
  }
  throw new Error('floor plan did not converge — the exclusion set must grow every round')
}

// ── BatchResult → the review's rows ─────────────────────────────────────────

export interface BatchReviewRow {
  symbol: string
  budgetUsdCents: number
  /** Raw out units the SIMULATION says this leg acquires; null = skipped. */
  outRaw: bigint | null
  skipped: boolean
  optional: boolean
}

export interface BatchReview {
  rows: BatchReviewRow[]
  spentFunding: bigint
  feeEth: bigint
  /** Refunds may arrive in a DIFFERENT denomination than funding (contract
   *  rule 5) — carried as their own lines, never netted into a total. */
  ethRefunded: bigint
  usdcRefunded: bigint
  skippedCount: number
}

/** Decode a simulated BatchResult against the composed legs. The result's
 *  `outs` array is positional; a skipped leg's out is meaningless and is
 *  carried as null, never as a number someone might render.
 *
 *  A LENGTH MISMATCH REFUSES LOUDLY (finding 5): a short outs array used to
 *  render as a leg that neither filled nor skipped — ABI drift becoming a
 *  silent misrender is E12's exact residual, and a loud refusal is the
 *  only honest decode of a result that does not match its request. */
export function decodeBatchResult(
  legs: { symbol: string; budgetUsdCents: number; optional: boolean }[],
  result: BatchSimResult,
): BatchReview {
  if (result.outs.length !== legs.length)
    throw new Error(
      `the batch result answers ${result.outs.length} legs but ${legs.length} were sent — the ABI and the deployed contract disagree; nothing in this result can be trusted`,
    )
  const skipped = new Set(skippedLegs(result, legs.length))
  const rows = legs.map((l, i) => ({
    symbol: l.symbol,
    budgetUsdCents: l.budgetUsdCents,
    outRaw: skipped.has(i) ? null : (result.outs[i] ?? null),
    skipped: skipped.has(i),
    optional: l.optional,
  }))
  return {
    rows,
    spentFunding: result.spentFunding,
    feeEth: result.feeEth,
    ethRefunded: result.ethRefunded,
    usdcRefunded: result.usdcRefunded,
    skippedCount: skipped.size,
  }
}
