import { describe, expect, it } from 'vitest'
import { dailyReturnSigns, effectiveBets, movedTogether, planCounterfactual, priceAtAndNow, sinceValue, weeklySwing } from './history-insights'

const series = (startDay: number, prices: number[]) =>
  prices.map((value, i) => ({ time: (startDay + i) * 86400 + 3600, value }))

describe('priceAtAndNow', () => {
  it('reads the nearest price after the moment and the latest', () => {
    const pts = series(100, [10, 11, 12, 13])
    const pr = priceAtAndNow(pts, 101 * 86400)
    expect(pr).toEqual({ at: 11, now: 13 })
  })
  it('refuses a window that starts after the moment', () => {
    expect(priceAtAndNow(series(100, [10, 11]), 90 * 86400)).toBeNull()
  })
})

describe('planCounterfactual (feature 2: both futures grow from one past)', () => {
  it('states plan-vs-actual over the same start', () => {
    // A doubled, B halved. Actual today: A=$100, B=$100 (started 50/200).
    // Plan was 50/50 → plan-now = 250×(0.5×2 + 0.5×0.5) = 312.50 vs actual 200.
    const fact = planCounterfactual({
      planShares: { a: 50, b: 50 },
      currentUsd: { a: 100, b: 100 },
      histByKey: { a: series(100, [1, 2]), b: series(100, [1, 0.5]) },
      atSec: 100 * 86400,
    })!
    expect(fact.actualNowUsd).toBe(200)
    expect(fact.planNowUsd).toBe(312.5)
    expect(fact.skippedKeys).toEqual([])
  })
  it('skips legs whose history cannot price the plan date, and says which', () => {
    const fact = planCounterfactual({
      planShares: { a: 50, b: 50 },
      currentUsd: { a: 100, b: 100 },
      histByKey: { a: series(100, [1, 2]), b: [] },
      atSec: 100 * 86400,
    })!
    expect(fact.coveredKeys).toEqual(['a'])
    expect(fact.skippedKeys).toEqual(['b'])
  })
  it('cuts both ways: drift can have HELPED', () => {
    const fact = planCounterfactual({
      planShares: { a: 90, b: 10 },
      currentUsd: { a: 100, b: 300 },
      histByKey: { a: series(100, [1, 1]), b: series(100, [1, 3]) },
      atSec: 100 * 86400,
    })!
    expect(fact.actualNowUsd).toBeGreaterThan(fact.planNowUsd)
  })
})

describe('movedTogether (feature 7: a measurement, never advice)', () => {
  it('counts sign-agreement over shared non-flat days', () => {
    const a = series(100, [1, 1.1, 1.2, 1.1, 1.2, 1.3, 1.4])
    const b = series(100, [2, 2.2, 2.4, 2.2, 2.4, 2.6, 2.8])
    const f = movedTogether(a, b)!
    expect(f.days).toBe(6)
    expect(f.together).toBe(6)
  })
  it('needs at least 5 shared days or says nothing', () => {
    expect(movedTogether(series(100, [1, 1.1, 1.2]), series(100, [2, 2.1, 2.2]))).toBeNull()
  })
  it('flat days are not co-movement', () => {
    const flat = series(100, [1, 1, 1, 1, 1, 1, 1])
    expect(movedTogether(flat, flat)).toBeNull()
  })
})

describe('dailyReturnSigns', () => {
  it('collapses to one close per day and signs the day-over-day move', () => {
    const pts = [...series(100, [10, 12]), { time: 101 * 86400 + 7200, value: 9 }]
    const signs = dailyReturnSigns(pts)
    expect(signs).toEqual([{ day: 101, sign: -1 }])
  })
})

describe('effectiveBets (16:4x feature 5) — diversification measured, never flattered', () => {
  // deterministic daily series builders
  const series = (rets: number[], start = 1_700_000_000): { time: number; value: number }[] => {
    let v = 100
    const out = [{ time: start, value: v }]
    rets.forEach((r, i) => {
      v = v * (1 + r)
      out.push({ time: start + (i + 1) * 86400, value: v })
    })
    return out
  }
  const R = [0.01, -0.02, 0.015, -0.005, 0.02, -0.01, 0.008, -0.012, 0.01, 0.005]

  it('perfectly co-moving positions are ONE bet, however many rows', () => {
    const hist = { a: series(R), b: series(R), c: series(R) }
    const f = effectiveBets({ weightsByKey: { a: 100, b: 100, c: 100 }, histByKey: hist })!
    expect(f.bets).toBeCloseTo(1, 1)
    expect(f.included).toBe(3)
  })

  it('independent movers approach 1/Σw² and never exceed the position count', () => {
    // three orthogonal-ish patterns
    const hist = {
      a: series([0.02, -0.01, 0.015, 0.01, -0.02, 0.005, -0.015, 0.02, -0.01, 0.01]),
      b: series([-0.01, 0.02, -0.005, -0.02, 0.01, -0.015, 0.02, -0.005, 0.015, -0.02]),
      c: series([0.005, 0.005, -0.02, 0.015, 0.005, 0.02, -0.01, -0.02, 0.005, 0.015]),
    }
    const f = effectiveBets({ weightsByKey: { a: 100, b: 100, c: 100 }, histByKey: hist })!
    expect(f.bets).toBeGreaterThan(1.5)
    expect(f.bets).toBeLessThanOrEqual(3)
  })

  it('an asset without pairwise coverage is DROPPED, not defaulted to zero correlation', () => {
    const hist = { a: series(R), b: series(R), c: series(R), d: [] as { time: number; value: number }[] }
    const f = effectiveBets({ weightsByKey: { a: 100, b: 100, c: 100, d: 500 }, histByKey: hist })!
    expect(f.included).toBe(3)
    expect(f.considered).toBe(4)
    expect(f.coveredSharePct).toBe(Math.round((300 / 800) * 100))
  })

  it('under three positions there is no diversification claim to make', () => {
    const hist = { a: series(R), b: series(R) }
    expect(effectiveBets({ weightsByKey: { a: 100, b: 100 }, histByKey: hist })).toBeNull()
  })
})

describe('sinceValue (16:4x feature 4) — the constant-quantity read at a past moment', () => {
  const mk = (vals: number[], start = 1_700_000_000) => vals.map((value, i) => ({ time: start + i * 86400, value }))

  it('prices today holdings at the past moment; coverage below 80% says nothing', () => {
    const histByKey = { a: mk([100, 110]), b: mk([50, 45]) }
    const f = sinceValue({ currentUsd: { a: 1100, b: 450 }, histByKey, atSec: 1_700_000_000 })!
    // a: 1100/(110/100)=1000 · b: 450/(45/50)=500
    expect(f.thenUsd).toBeCloseTo(1500, 0)
    expect(f.nowUsd).toBeCloseTo(1550, 0)
    const thin = sinceValue({ currentUsd: { a: 100, b: 900 }, histByKey: { a: mk([100, 110]) }, atSec: 1_700_000_000 })
    expect(thin).toBeNull() // only 10% of the money priced at both ends
  })

  it('a moment before the window says nothing rather than guessing', () => {
    const histByKey = { a: mk([100, 110], 1_700_000_000) }
    expect(sinceValue({ currentUsd: { a: 1100 }, histByKey, atSec: 1_600_000_000 })).toBeNull()
  })
})

describe('audit pins (2026-08-03 self-review)', () => {
  const seriesOf = (rets: number[], start = 1_700_000_000): { time: number; value: number }[] => {
    let v = 100
    const out = [{ time: start, value: v }]
    rets.forEach((r, i) => {
      v = v * (1 + r)
      out.push({ time: start + (i + 1) * 86400, value: v })
    })
    return out
  }
  const MOVE = [0.02, -0.01, 0.015, 0.01, -0.02, 0.005, -0.015, 0.02, -0.01, 0.01]
  const MOVE2 = [-0.01, 0.02, -0.005, -0.02, 0.01, -0.015, 0.02, -0.005, 0.015, -0.02]
  const MOVE3 = [0.005, 0.005, -0.02, 0.015, 0.005, 0.02, -0.01, -0.02, 0.005, 0.015]
  const FLAT = Array(10).fill(0.0001) // a peg: ~0.01%/day

  it('a pegged stable is NOT a bet — it correlates with nothing and inflated the count', () => {
    const hist = { a: seriesOf(MOVE), b: seriesOf(MOVE2), c: seriesOf(MOVE3), usdc: seriesOf(FLAT) }
    const f = effectiveBets({ weightsByKey: { a: 100, b: 100, c: 100, usdc: 300 }, histByKey: hist })!
    expect(f.included).toBe(3) // the stable sits out
    expect(f.considered).toBe(4)
    expect(f.coveredSharePct).toBe(50) // 300 of 600 excluded, stated
  })

  it('since coverage is honest against the WHOLE book, not the fetched subset', () => {
    const mk = (vals: number[], start = 1_700_000_000) => vals.map((value, i) => ({ time: start + i * 86400, value }))
    const histByKey = { a: mk([100, 110]) }
    // the subset covers $1,100 fully — but the book is $2,000
    const f = sinceValue({ currentUsd: { a: 1100 }, histByKey, atSec: 1_700_000_000, totalUsd: 2000 })
    expect(f).toBeNull() // 55% of the book priced — below the 80% gate, says nothing
    const ok = sinceValue({ currentUsd: { a: 1100 }, histByKey, atSec: 1_700_000_000, totalUsd: 1200 })!
    expect(ok.coveredSharePct).toBe(92)
  })
})

describe('weeklySwing (stress replay v1) — the worst and best week, replayed', () => {
  const mkSeries = (rets: number[], start = 1_700_000_000): { time: number; value: number }[] => {
    let v = 100
    const out = [{ time: start, value: v }]
    rets.forEach((r, i) => {
      v = v * (1 + r)
      out.push({ time: start + (i + 1) * 86400, value: v })
    })
    return out
  }

  it('finds the worst and best 7-day runs of the shared grid, value-weighted', () => {
    // 14 daily returns: a bad first week, a good second week
    const bad = [-0.05, -0.04, -0.03, -0.02, -0.05, -0.01, -0.02]
    const good = [0.03, 0.04, 0.02, 0.03, 0.05, 0.01, 0.02]
    const hist = { a: mkSeries([...bad, ...good]), b: mkSeries([...bad, ...good]) }
    const f = weeklySwing({ weightsByKey: { a: 100, b: 100 }, histByKey: hist })!
    expect(f.worstPct).toBeLessThan(-15)
    expect(f.bestPct).toBeGreaterThan(15)
    expect(f.included).toBe(2)
  })

  it('cash damps the replay — a stable aboard halves the swing, which is the truth', () => {
    const bad = [-0.05, -0.04, -0.03, -0.02, -0.05, -0.01, -0.02]
    const flat = Array(14).fill(0)
    const hist = { a: mkSeries([...bad, ...bad]), usdc: mkSeries(flat) }
    const all = weeklySwing({ weightsByKey: { a: 100 }, histByKey: { a: hist.a } })
    const damped = weeklySwing({ weightsByKey: { a: 100, usdc: 100 }, histByKey: hist })!
    expect(all).toBeNull() // single asset: no replay claim
    expect(damped.worstPct).toBeGreaterThan(-15) // ~half the pure-asset drop
    expect(damped.worstPct).toBeLessThan(-8)
  })

  it('too little shared history says nothing', () => {
    const hist = { a: mkSeries([0.01, -0.01, 0.02]), b: mkSeries([0.01, -0.01, 0.02]) }
    expect(weeklySwing({ weightsByKey: { a: 100, b: 100 }, histByKey: hist })).toBeNull()
  })

  it('coverage is honest against the caller total', () => {
    const rets14 = Array(14).fill(0).map((_, i) => (i % 2 ? 0.01 : -0.01))
    const hist = { a: mkSeries(rets14), b: mkSeries(rets14) }
    const f = weeklySwing({ weightsByKey: { a: 100, b: 100 }, histByKey: hist, totalUsd: 500 })!
    expect(f.coveredSharePct).toBe(40)
  })
})

describe('planCounterfactual — implausible-return guard (the 1e27% sibling, 2026-08-13)', () => {
  it('skips a leg whose plan-date price is dust-history noise, never fabricating an astronomical dollar figure', () => {
    // DUST priced ~1e-20 at the plan date, ~1e-4 now → a 1e16× "return" that
    // used to explode planNowUsd to ~$5e18 and render "$5e+22M" on a facts card
    const fact = planCounterfactual({
      planShares: { a: 50, dust: 50 },
      currentUsd: { a: 100, dust: 100 },
      histByKey: { a: series(100, [1, 2]), dust: series(100, [1e-20, 1e-4]) },
      atSec: 100 * 86400,
    })!
    expect(fact.coveredKeys).toEqual(['a'])
    expect(fact.skippedKeys).toEqual(['dust'])
    // and planNowUsd is a real, sane number — never astronomical
    expect(Number.isFinite(fact.planNowUsd)).toBe(true)
    expect(fact.planNowUsd).toBeLessThan(1e9)
  })
  it('a near-zero NOW price is skipped too — the band is symmetric so startUsd cannot explode', () => {
    const fact = planCounterfactual({
      planShares: { a: 50, gone: 50 },
      currentUsd: { a: 100, gone: 1 },
      histByKey: { a: series(100, [1, 2]), gone: series(100, [1, 1e-20]) },
      atSec: 100 * 86400,
    })!
    expect(fact.skippedKeys).toEqual(['gone'])
    expect(Number.isFinite(fact.planNowUsd)).toBe(true)
  })
})
