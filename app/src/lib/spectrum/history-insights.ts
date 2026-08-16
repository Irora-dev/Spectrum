import type { NavPoint } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY-DERIVED FACTS (features 2 + 7, greenlit 2026-08-03 ~11:2x) — pure
// math over the SAME per-asset price histories the hero chart already
// fetches. React-free (the purity law); the hook wires queries, this module
// only computes, so every claim here is unit-tested.
//
//   · PLAN COUNTERFACTUAL (2): "holding your saved plan untouched would be
//     worth $X today; your actual mix is $Y." Both sides start from the SAME
//     reconstructed value at the plan date (today's holdings priced then —
//     the constant-quantity read, stated as such), so the difference is
//     purely the weights. A counterfactual FACT that cuts both ways.
//   · MOVED TOGETHER (7): which two holdings moved as one — the share of
//     days their daily returns agreed in sign. A measurement, never advice.
// ─────────────────────────────────────────────────────────────────────────────

/** The price at (or nearest AFTER) a moment, and the latest price. Null when
 *  the series doesn't cover the moment — a fact that can't be computed is
 *  skipped, never approximated from the wrong window. */
export function priceAtAndNow(points: NavPoint[], atSec: number): { at: number; now: number } | null {
  if (!Array.isArray(points) || points.length < 2) return null
  const sorted = [...points].sort((a, b) => a.time - b.time)
  if (atSec < sorted[0].time - 6 * 3600) return null // window starts too late
  const later = sorted.find((p) => p.time >= atSec) ?? null
  const at = later ?? sorted[sorted.length - 1]
  const now = sorted[sorted.length - 1]
  if (!(at.value > 0) || !(now.value > 0)) return null
  return { at: at.value, now: now.value }
}

export interface PlanVsInput {
  /** Plan shares (sum ≈ 100) keyed like positions. */
  planShares: Record<string, number>
  /** Current value per key (today's holdings). */
  currentUsd: Record<string, number>
  /** Price history per key, covering the plan date. */
  histByKey: Record<string, NavPoint[]>
  /** The plan date, seconds. */
  atSec: number
}

export interface PlanVsFact {
  actualNowUsd: number
  planNowUsd: number
  /** Keys that priced at both ends — coverage honesty for the caller. */
  coveredKeys: string[]
  skippedKeys: string[]
}

export function planCounterfactual(input: PlanVsInput): PlanVsFact | null {
  const keys = Object.keys(input.planShares)
  if (keys.length === 0) return null
  const covered: { key: string; ret: number }[] = []
  const skipped: string[] = []
  // returns per PLAN leg
  for (const k of keys) {
    const pr = priceAtAndNow(input.histByKey[k] ?? [], input.atSec)
    if (!pr) {
      skipped.push(k)
      continue
    }
    // ⚠ AN IMPLAUSIBLE RETURN IS DATA NOISE, NOT A FACT (2026-08-13, the sibling
    // of the 1e27% chart bug — same dust-history root: a ~1e-21 plan-date price
    // makes now/at explode to ~1e16, and planNowUsd becomes an astronomical but
    // FINITE dollar figure that no isFinite guard catches and this "facts only"
    // card renders raw, e.g. "$5e+22M"). A price that moved by more than a
    // million-fold in a 30-day window did not; skip the leg (coverage-honest,
    // the skippedKeys the caller already discloses) rather than fabricate a
    // number. Symmetric: a near-zero NOW price would explode `startUsd` the
    // other way (now/ret), so the band is bounded on both sides.
    const ret = pr.now / pr.at
    if (!Number.isFinite(ret) || ret > 1e6 || ret < 1e-6) {
      skipped.push(k)
      continue
    }
    covered.push({ key: k, ret })
  }
  if (covered.length === 0) return null
  // the shared starting value: today's covered holdings priced AT the plan
  // date (constant-quantity). Only keys present in BOTH sides count, so the
  // two futures grow from one past.
  let startUsd = 0
  let actualNowUsd = 0
  for (const c of covered) {
    const now = input.currentUsd[c.key] ?? 0
    startUsd += now / c.ret
    actualNowUsd += now
  }
  if (!(startUsd > 0)) return null
  const shareSum = covered.reduce((s, c) => s + (input.planShares[c.key] ?? 0), 0)
  if (!(shareSum > 0)) return null
  let planNowUsd = 0
  for (const c of covered) {
    const share = (input.planShares[c.key] ?? 0) / shareSum
    planNowUsd += startUsd * share * c.ret
  }
  return {
    actualNowUsd: Math.round(actualNowUsd * 100) / 100,
    planNowUsd: Math.round(planNowUsd * 100) / 100,
    coveredKeys: covered.map((c) => c.key),
    skippedKeys: skipped,
  }
}

/** Last price per UTC day → day-over-day return signs. */
export function dailyReturnSigns(points: NavPoint[]): { day: number; sign: 1 | -1 | 0 }[] {
  if (!Array.isArray(points) || points.length < 2) return []
  const byDay = new Map<number, number>()
  for (const p of [...points].sort((a, b) => a.time - b.time)) {
    if (!(p.value > 0)) continue
    byDay.set(Math.floor(p.time / 86400), p.value)
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0])
  const out: { day: number; sign: 1 | -1 | 0 }[] = []
  for (let i = 1; i < days.length; i++) {
    const r = days[i][1] / days[i - 1][1] - 1
    out.push({ day: days[i][0], sign: r > 0.0005 ? 1 : r < -0.0005 ? -1 : 0 })
  }
  return out
}

export interface TogetherFact {
  days: number
  together: number
}

/** How often two series' daily returns agreed in sign, over shared days.
 *  Flat days (sign 0) are skipped on either side — "both did nothing" is not
 *  the co-movement claim the card makes. */
export function movedTogether(a: NavPoint[], b: NavPoint[]): TogetherFact | null {
  const sa = new Map(dailyReturnSigns(a).map((d) => [d.day, d.sign]))
  const sb = new Map(dailyReturnSigns(b).map((d) => [d.day, d.sign]))
  let days = 0
  let together = 0
  for (const [day, s1] of sa) {
    const s2 = sb.get(day)
    // a NaN sign (Math.sign of a NaN return) is neither 0 nor ±1: it used to
    // count into `days` while never matching, silently deflating "together"
    if (!((s1 === 1 || s1 === -1) && (s2 === 1 || s2 === -1))) continue
    days++
    if (s1 === s2) together++
  }
  return days >= 5 ? { days, together } : null
}

/** Last price per UTC day → day-over-day RETURNS (magnitudes, not signs). */
export function dailyReturns(points: NavPoint[]): { day: number; ret: number }[] {
  if (!Array.isArray(points) || points.length < 2) return []
  const byDay = new Map<number, number>()
  for (const p of [...points].sort((a, b) => a.time - b.time)) {
    if (!(p.value > 0)) continue
    byDay.set(Math.floor(p.time / 86400), p.value)
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0])
  const out: { day: number; ret: number }[] = []
  for (let i = 1; i < days.length; i++) out.push({ day: days[i][0], ret: days[i][1] / days[i - 1][1] - 1 })
  return out
}

export interface BetsInput {
  /** Current value per key — the weights, in dollars. */
  weightsByKey: Record<string, number>
  histByKey: Record<string, NavPoint[]>
}

export interface BetsFact {
  /** How many independent bets the included positions move like. */
  bets: number
  /** Positions included (complete pairwise coverage) / considered. */
  included: number
  considered: number
  /** Share of considered VALUE the included set covers, 0–100. */
  coveredSharePct: number
  /** The thinnest pair's shared-day count — the measurement's weakest leg. */
  minPairDays: number
}

/** DIVERSIFICATION, MEASURED (feature 5 of the ~16:4x round): the effective
 *  number of independent bets — 1 / (w'ρw) over value weights and the daily-
 *  return correlation matrix. Fully correlated = 1 bet however many rows;
 *  fully independent = 1/Σw². Assets are included only while EVERY pair has
 *  ≥6 shared trading days (the least-covered drops first): a missing
 *  correlation defaulted to zero would FLATTER the diversification claim,
 *  and this module does not flatter. Capped at n — "more independent than
 *  its own position count" is a hedging claim this card does not make. */
export function effectiveBets(input: BetsInput): BetsFact | null {
  const allKeys = Object.keys(input.weightsByKey).filter((k) => (input.weightsByKey[k] ?? 0) > 0)
  const considered = allKeys.length
  if (considered < 3) return null
  const rets = new Map<string, Map<number, number>>()
  for (const k of allKeys) rets.set(k, new Map(dailyReturns(input.histByKey[k] ?? []).map((d) => [d.day, d.ret])))
  // A PEGGED (or dead) asset is not a bet (audit find): its returns are ~0,
  // it correlates with nothing, and every stable aboard inflated the
  // independent-bets count by one. Under 0.1%/day stddev an asset sits out.
  const keys = allKeys.filter((k) => {
    const rs = [...rets.get(k)!.values()]
    if (rs.length < 6) return true // history coverage is the drop loop's job
    const mean = rs.reduce((s2, v) => s2 + v, 0) / rs.length
    const sd = Math.sqrt(rs.reduce((s2, v) => s2 + (v - mean) ** 2, 0) / rs.length)
    return sd >= 0.001
  })

  const sharedDays = (a: string, b: string): number[] => {
    const ma = rets.get(a)!
    const mb = rets.get(b)!
    const out: number[] = []
    for (const d of ma.keys()) if (mb.has(d)) out.push(d)
    return out
  }

  // drop the least-covered asset until every pair shares ≥6 days. Ties on
  // the worst PAIR are broken by TOTAL pairwise coverage — with one empty
  // series aboard, every asset's worst pair is that one, and dropping the
  // first-seen victim instead of the sparse culprit emptied the whole set.
  const included = [...keys]
  for (;;) {
    if (included.length < 3) return null
    let worstKey: string | null = null
    let worstCount = Infinity
    let worstSum = Infinity
    let allOk = true
    for (let i = 0; i < included.length; i++) {
      let ownWorst = Infinity
      let ownSum = 0
      for (let j = 0; j < included.length; j++) {
        if (i === j) continue
        const n = sharedDays(included[i], included[j]).length
        ownWorst = Math.min(ownWorst, n)
        ownSum += n
      }
      if (ownWorst < 6) allOk = false
      if (ownWorst < worstCount || (ownWorst === worstCount && ownSum < worstSum)) {
        worstCount = ownWorst
        worstSum = ownSum
        worstKey = included[i]
      }
    }
    if (allOk) break
    included.splice(included.indexOf(worstKey as string), 1)
  }

  const corr = (a: string, b: string): number => {
    const days = sharedDays(a, b)
    const ra = rets.get(a)!
    const rb = rets.get(b)!
    const xs = days.map((d) => ra.get(d) as number)
    const ys = days.map((d) => rb.get(d) as number)
    const n = xs.length
    const mx = xs.reduce((s, v) => s + v, 0) / n
    const my = ys.reduce((s, v) => s + v, 0) / n
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my)
      sxx += (xs[i] - mx) ** 2
      syy += (ys[i] - my) ** 2
    }
    if (!(sxx > 0) || !(syy > 0)) return 0
    return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)))
  }

  const totalConsidered = allKeys.reduce((s, k) => s + input.weightsByKey[k], 0)
  const totalIncluded = included.reduce((s, k) => s + input.weightsByKey[k], 0)
  if (!(totalIncluded > 0)) return null
  const w = included.map((k) => input.weightsByKey[k] / totalIncluded)
  let denom = 0
  let minPairDays = Infinity
  for (let i = 0; i < included.length; i++) {
    for (let j = 0; j < included.length; j++) {
      const rho = i === j ? 1 : corr(included[i], included[j])
      denom += w[i] * w[j] * rho
      if (i < j) minPairDays = Math.min(minPairDays, sharedDays(included[i], included[j]).length)
    }
  }
  if (!(denom > 0)) return null
  const bets = Math.min(included.length, Math.max(1, 1 / denom))
  return {
    bets: Math.round(bets * 10) / 10,
    included: included.length,
    considered,
    coveredSharePct: Math.round((totalIncluded / totalConsidered) * 100),
    minPairDays,
  }
}

/** SINCE YOU LAST LOOKED (feature 4): today's holdings priced at a past
 *  moment — the same constant-quantity read the chart and the counterfactual
 *  stand on, so the three never disagree. Null when the window doesn't cover
 *  the moment or too little of the money prices at both ends. */
export function sinceValue(input: {
  currentUsd: Record<string, number>
  histByKey: Record<string, NavPoint[]>
  atSec: number
  /** The WHOLE portfolio's value — coverage honesty (audit find: coverage
   *  relative to the fetched subset claimed "98%" while the subset itself
   *  was 70% of the money). Defaults to the subset total when absent. */
  totalUsd?: number
}): { thenUsd: number; nowUsd: number; coveredSharePct: number } | null {
  const keys = Object.keys(input.currentUsd).filter((k) => (input.currentUsd[k] ?? 0) > 0)
  if (keys.length === 0) return null
  let thenUsd = 0
  let coveredNow = 0
  let totalNow = 0
  for (const k of keys) {
    const now = input.currentUsd[k]
    totalNow += now
    const pr = priceAtAndNow(input.histByKey[k] ?? [], input.atSec)
    if (!pr) continue
    thenUsd += now / (pr.now / pr.at)
    coveredNow += now
  }
  if (!(totalNow > 0) || !(coveredNow > 0)) return null
  const denom = input.totalUsd != null && input.totalUsd > 0 ? input.totalUsd : totalNow
  const coveredSharePct = (coveredNow / denom) * 100
  if (coveredSharePct < 80) return null // most of the money must price at both ends
  return { thenUsd: Math.round(thenUsd * 100) / 100, nowUsd: Math.round(coveredNow * 100) / 100, coveredSharePct: Math.round(coveredSharePct) }
}

export interface SwingFact {
  /** Worst compound return over any 7 consecutive shared trading days, %. */
  worstPct: number
  bestPct: number
  /** Assets in the replay / considered; coverage of the caller's total. */
  included: number
  considered: number
  coveredSharePct: number
  days: number
}

/** STRESS REPLAY, at the depth the data honestly supports (owner ~17:5x —
 *  we fetch 30 DAYS of history, so "worst month on record" is not yet a
 *  computable claim; the worst WEEK of the last month is): today's weights
 *  over each asset's real daily moves, compounded across every 7-day run of
 *  the shared trading-day grid — the worst and the best, both, because a
 *  range is a fact and a fear headline is not. Stables stay IN: cash damping
 *  is part of how this mix would actually have moved. Null under 2 covered
 *  assets or 10 shared days — too thin to call a replay. */
export function weeklySwing(input: BetsInput & { totalUsd?: number }): SwingFact | null {
  const keys = Object.keys(input.weightsByKey).filter((k) => (input.weightsByKey[k] ?? 0) > 0)
  if (keys.length < 2) return null
  const rets = new Map<string, Map<number, number>>()
  for (const k of keys) rets.set(k, new Map(dailyReturns(input.histByKey[k] ?? []).map((d) => [d.day, d.ret])))
  // covered = assets with a usable series; the grid = days they ALL share
  const covered = keys.filter((k) => (rets.get(k)?.size ?? 0) >= 10)
  if (covered.length < 2) return null
  let grid: number[] | null = null
  for (const k of covered) {
    const days = new Set(rets.get(k)!.keys())
    grid = grid == null ? [...days] : grid.filter((d) => days.has(d))
  }
  const days = (grid ?? []).sort((a, b) => a - b)
  if (days.length < 10) return null
  const totalIncluded = covered.reduce((s, k) => s + input.weightsByKey[k], 0)
  if (!(totalIncluded > 0)) return null
  const w = new Map(covered.map((k) => [k, input.weightsByKey[k] / totalIncluded]))
  const portfolioRet = days.map((d) => covered.reduce((s, k) => s + (w.get(k) as number) * (rets.get(k)!.get(d) as number), 0))
  const WINDOW = 7
  let worst = Infinity
  let best = -Infinity
  for (let i = 0; i + WINDOW <= portfolioRet.length; i++) {
    let c = 1
    for (let j = i; j < i + WINDOW; j++) c *= 1 + portfolioRet[j]
    const pct = (c - 1) * 100
    if (pct < worst) worst = pct
    if (pct > best) best = pct
  }
  if (!Number.isFinite(worst) || !Number.isFinite(best)) return null
  const denom = input.totalUsd != null && input.totalUsd > 0 ? input.totalUsd : keys.reduce((s, k) => s + input.weightsByKey[k], 0)
  return {
    worstPct: Math.round(worst * 10) / 10,
    bestPct: Math.round(best * 10) / 10,
    included: covered.length,
    considered: keys.length,
    coveredSharePct: Math.round((totalIncluded / denom) * 100),
    days: days.length,
  }
}
