import { describe, expect, it } from 'vitest'
import {
  CONTRACT_AGREE_PCT,
  COST_BASIS_MAX_RATIO,
  corroborate,
  costBasisVerdict,
  crossCheckSplit,
  DEGENERATE_LEG_BPS,
  degenerateSplitVerdict,
  DEPTH_MAX_TRADE_SHARE_PCT,
  depthVerdict,
  deriveSplitBps,
  guardSplit,
  MIN_MEANINGFUL_LIQUIDITY_USD,
  SOURCE_AGREE_PCT,
  type LegMark,
} from './split-guard'

// ─────────────────────────────────────────────────────────────────────────────
// Ⓡ the owner: "plenty of testing across high caps, mid caps, low caps, new pairs etc".
// So the fixtures below are REAL market shapes rather than round numbers, and the
// suite is organised by that axis: a guard that only ever sees WETH is untested.
// ─────────────────────────────────────────────────────────────────────────────

/** Realistic depth and price shapes. The numbers matter: a guard tuned only on
 *  majors will either block every memecoin or wave through every thin pool. */
const MARKET = {
  /** WETH-class: deep enough that size is almost never the problem. */
  highCap: { symbol: 'WETH', markUsd: 4_012.55, held: 12.4, liquidityUsd: 48_000_000 },
  /** AERO-class: a real market, but a $2M trade is a different question. */
  midCap: { symbol: 'AERO', markUsd: 1.184, held: 84_000, liquidityUsd: 9_400_000 },
  /** DEGEN-class: the size test bites here, which is the point. */
  lowCap: { symbol: 'DEGEN', markUsd: 0.01243, held: 6_400_000, liquidityUsd: 780_000 },
  /** A micro pair: real, tradeable in cents, unusable at size. */
  microCap: { symbol: 'SURPLUS', markUsd: 0.000042, held: 91_000_000, liquidityUsd: 24_000 },
  /** A pair minted an hour ago: the mark exists, the market does not. */
  newPair: { symbol: 'FRESH', markUsd: 0.31, held: 40_000, liquidityUsd: 640 },
} satisfies Record<string, LegMark>

describe('cost basis: the check that needs no price feed', () => {
  // The measured production failure: 509,250x. This is the case that must never
  // pass, and it is catchable with nothing but the basket's own history.
  it('BLOCKS the real 509,250x case contracts measured', () => {
    const v = costBasisVerdict({ symbol: 'THIN', markUsd: 814_799_287, held: 1, fundedUsd: 1_600 })
    expect(v.severity).toBe('block')
    expect(v.code).toBe('cost-basis')
    expect(v.reason).toMatch(/cannot be trusted/i)
  })

  it('passes an ordinary gain that is nowhere near absurd', () => {
    // 3x on a real position is a story, not a malfunction.
    expect(costBasisVerdict({ symbol: 'DEGEN', markUsd: 0.03, held: 100_000, fundedUsd: 1_000 }).severity).toBe('ok')
  })

  it('catches the collapse direction too, not only the spike', () => {
    // A mark 100x BELOW basis is equally unusable, and a naive ratio would miss it.
    const v = costBasisVerdict({ symbol: 'DOWN', markUsd: 0.0001, held: 1_000, fundedUsd: 10_000 })
    expect(v.severity).toBe('block')
  })

  it('walks the exact boundary', () => {
    const at = costBasisVerdict({ symbol: 'X', markUsd: COST_BASIS_MAX_RATIO, held: 1, fundedUsd: 1 })
    const over = costBasisVerdict({ symbol: 'X', markUsd: COST_BASIS_MAX_RATIO + 0.01, held: 1, fundedUsd: 1 })
    expect(at.severity).toBe('ok')
    expect(over.severity).toBe('block')
  })

  // A missing basis is not evidence of a good mark. It must not read as a pass
  // that was earned — the check simply did not run.
  it('skips honestly when the funding figure is unknown', () => {
    expect(costBasisVerdict({ symbol: 'X', markUsd: 1, held: 1 }).severity).toBe('ok')
    expect(costBasisVerdict({ symbol: 'X', markUsd: 1, held: 1, fundedUsd: 0 }).severity).toBe('ok')
  })

  it('BLOCKS a mark that is not a number at all', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(costBasisVerdict({ symbol: 'X', markUsd: bad, held: 1, fundedUsd: 1 }).severity).toBe('block')
    }
  })
})

describe('depth: across every cap tier', () => {
  // The tier axis the owner asked for. Same $50k trade, four very different answers.
  const TRADE = 50_000

  it('high cap absorbs it without comment', () => {
    expect(depthVerdict(MARKET.highCap, TRADE).severity).toBe('ok')
  })

  it('mid cap absorbs it too', () => {
    expect(depthVerdict(MARKET.midCap, TRADE).severity).toBe('ok')
  })

  it('low cap is fine at $50k but BLOCKS at $200k', () => {
    expect(depthVerdict(MARKET.lowCap, TRADE).severity).toBe('ok')
    const big = depthVerdict(MARKET.lowCap, 200_000)
    expect(big.severity).toBe('block')
    expect(big.code).toBe('depth')
    expect(big.reason).toMatch(/whole market/i)
  })

  it('micro cap BLOCKS even a modest trade', () => {
    expect(depthVerdict(MARKET.microCap, 5_000).severity).toBe('block')
  })

  // A brand-new pair is the case a mark looks fine and the market does not exist.
  it('a NEW PAIR is a dust pool and blocks regardless of size', () => {
    const v = depthVerdict(MARKET.newPair, 1)
    expect(v.severity).toBe('block')
    expect(v.code).toBe('dust-pool')
  })

  it('walks the trade-share boundary', () => {
    const liq = 1_000_000
    const leg = { symbol: 'X', markUsd: 1, held: 1, liquidityUsd: liq }
    const at = (liq * DEPTH_MAX_TRADE_SHARE_PCT) / 100
    expect(depthVerdict(leg, at).severity).toBe('ok')
    expect(depthVerdict(leg, at * 1.01).severity).toBe('block')
  })

  it('walks the dust boundary', () => {
    expect(depthVerdict({ symbol: 'X', markUsd: 1, held: 1, liquidityUsd: MIN_MEANINGFUL_LIQUIDITY_USD }, 1).severity).toBe('ok')
    expect(depthVerdict({ symbol: 'X', markUsd: 1, held: 1, liquidityUsd: MIN_MEANINGFUL_LIQUIDITY_USD - 1 }, 1).severity).toBe('block')
  })

  // UNREADABLE IS NOT ZERO. Treating a failed read as an empty pool would block
  // every leg on a chain with no indexer (4663), and treating it as fine would
  // wave through the exact case we are defending against. It warns.
  it('treats unreadable depth as unverified, neither empty nor fine', () => {
    for (const liq of [null, undefined, Number.NaN]) {
      const v = depthVerdict({ symbol: 'X', markUsd: 1, held: 1, liquidityUsd: liq as number | null }, 50_000)
      expect(v.severity).toBe('warn')
      expect(v.code).toBe('no-depth-data')
      expect(v.reason).toMatch(/could not read/i)
    }
  })
})

describe('layer 2: corroboration across independent sources', () => {
  it('agrees when three sources agree', () => {
    const r = corroborate([
      { source: 'alchemy', priceUsd: 4_012.55 },
      { source: 'dexscreener', priceUsd: 4_014.10 },
      { source: 'coingecko', priceUsd: 4_011.90 },
    ])
    expect(r.severity).toBe('ok')
    expect(r.priceUsd).toBeCloseTo(4_012.55, 2)
    expect(r.usedSources).toHaveLength(3)
  })

  // THE REASON FOR A MEDIAN. One absurd source moves a mean arbitrarily far; the
  // median ignores it. This is the whole value of having three.
  it('a single absurd outlier cannot move the answer', () => {
    const r = corroborate([
      { source: 'a', priceUsd: 4_012 },
      { source: 'b', priceUsd: 4_015 },
      { source: 'manipulated', priceUsd: 814_799_287 },
    ])
    expect(r.priceUsd).toBe(4_015)
    // and it still reports the disagreement rather than hiding behind the median
    expect(r.severity).toBe('warn')
  })

  it('warns when sources disagree beyond the band', () => {
    const r = corroborate([
      { source: 'a', priceUsd: 100 },
      { source: 'b', priceUsd: 110 },
    ])
    expect(r.severity).toBe('warn')
    expect(r.spreadPct).toBeCloseTo(10, 4)
    expect(r.reason).toMatch(/disagree/i)
  })

  it('walks the agreement boundary', () => {
    const inside = corroborate([{ source: 'a', priceUsd: 100 }, { source: 'b', priceUsd: 100 + SOURCE_AGREE_PCT }])
    const outside = corroborate([{ source: 'a', priceUsd: 100 }, { source: 'b', priceUsd: 100 + SOURCE_AGREE_PCT + 0.5 }])
    expect(inside.severity).toBe('ok')
    expect(outside.severity).toBe('warn')
  })

  // One source is not corroboration. Calling it 'ok' would claim an agreement
  // that never happened.
  it('ONE source is a warning, not a pass', () => {
    const r = corroborate([{ source: 'only', priceUsd: 42 }])
    expect(r.severity).toBe('warn')
    expect(r.priceUsd).toBe(42)
    expect(r.reason).toMatch(/uncorroborated/i)
  })

  it('BLOCKS when nothing usable answered', () => {
    expect(corroborate([]).severity).toBe('block')
    expect(corroborate([{ source: 'a', priceUsd: 0 }, { source: 'b', priceUsd: Number.NaN }]).severity).toBe('block')
    expect(corroborate([]).priceUsd).toBeNull()
  })

  it('ignores unusable sources without discarding the good ones', () => {
    const r = corroborate([
      { source: 'dead', priceUsd: 0 },
      { source: 'a', priceUsd: 10 },
      { source: 'b', priceUsd: 10.05 },
    ])
    expect(r.severity).toBe('ok')
    expect(r.usedSources).toEqual(['a', 'b'])
  })
})

describe('layer 3: cross-checking the contract', () => {
  it('is silent when the two splits agree', () => {
    expect(crossCheckSplit([3400, 3300, 3300], [3390, 3310, 3300])).toEqual([])
  })

  it('warns per leg when they diverge materially', () => {
    // 8 points apart. (4000 vs 4500 is exactly 5, i.e. ON the boundary — the
    // boundary itself is walked in its own test below.)
    const out = crossCheckSplit([4000, 6000], [4800, 5200])
    expect(out).toHaveLength(2)
    expect(out[0].severity).toBe('warn')
    expect(out[0].code).toBe('source-disagreement')
  })

  // Compared in POINTS of the whole split, not as a ratio: 1bp -> 3bps is a 200%
  // ratio change and completely immaterial.
  it('ignores a large RATIO change on a tiny leg', () => {
    expect(crossCheckSplit([1, 9999], [3, 9997])).toEqual([])
  })

  it('catches the 9999/0 failure shape outright', () => {
    const out = crossCheckSplit([5000, 5000], [9999, 1])
    expect(out.length).toBeGreaterThan(0)
  })

  it('walks the agreement boundary', () => {
    const at = crossCheckSplit([5000, 5000], [5000 + CONTRACT_AGREE_PCT * 100, 5000 - CONTRACT_AGREE_PCT * 100])
    const over = crossCheckSplit([5000, 5000], [5000 + CONTRACT_AGREE_PCT * 100 + 50, 5000 - CONTRACT_AGREE_PCT * 100 - 50])
    expect(at).toEqual([])
    expect(over.length).toBeGreaterThan(0)
  })

  it('BLOCKS when the two sides disagree about how many legs exist', () => {
    const out = crossCheckSplit([5000, 5000], [3333, 3333, 3334])
    expect(out[0].severity).toBe('block')
  })
})

describe('absurdity signal 2: the degenerate split (arithmetic only)', () => {
  const seeded = (bps: number[]) => bps.map((seedBps, i) => ({ symbol: `LEG${i + 1}`, seedBps, held: 10 }))

  it('BLOCKS the measured 9999/0 shape against a 34/33/33 seed', () => {
    const out = degenerateSplitVerdict([9999, 0, 1], seeded([3400, 3300, 3300]))
    expect(out).toHaveLength(2)
    expect(out.every((v) => v.severity === 'block' && v.code === 'degenerate-split')).toBe(true)
    expect(out[0].reason).toMatch(/broken/i)
  })

  it('passes every live basket shape it was calibrated against', () => {
    // Contracts measured the smallest leg split on all 12 live 4663 baskets;
    // PADWAR's 425 bps is the tightest that exists. Nothing real may trip.
    for (const smallest of [425, 1344, 1407, 1439, 1729, 1819, 2131, 2308, 3700]) {
      const out = degenerateSplitVerdict([10_000 - smallest, smallest], seeded([5000, 5000]))
      expect(out).toEqual([])
    }
  })

  it('walks the exact boundary', () => {
    expect(degenerateSplitVerdict([10_000 - DEGENERATE_LEG_BPS, DEGENERATE_LEG_BPS], seeded([5000, 5000]))).toEqual(
      [],
    )
    expect(
      degenerateSplitVerdict([10_000 - DEGENERATE_LEG_BPS + 1, DEGENERATE_LEG_BPS - 1], seeded([5000, 5000])),
    ).toHaveLength(1)
  })

  it('holds a leg to the check when the basket merely HOLDS it (reserves are intent)', () => {
    // No seed weight known, but the basket holds real units of leg 2.
    const legs = [
      { symbol: 'A', held: 10 },
      { symbol: 'B', held: 10 },
    ]
    expect(degenerateSplitVerdict([9999, 1], legs)).toHaveLength(1)
  })

  it('exempts a leg that was neither seeded meaningfully nor held', () => {
    // A dust-seeded, unheld leg at ~zero is consistent with its own intent.
    const legs = [
      { symbol: 'A', seedBps: 9900, held: 10 },
      { symbol: 'B', seedBps: 100, held: 0 },
    ]
    expect(degenerateSplitVerdict([9950, 50], legs)).toEqual([])
  })

  it('ignores non-finite shares rather than judging them', () => {
    expect(degenerateSplitVerdict([Number.NaN, 10_000], seeded([5000, 5000]))).toEqual([])
  })
})

describe('the whole guard, and the split it gates', () => {
  const mixed = [MARKET.highCap, MARKET.midCap, MARKET.lowCap]
  const evenTrade = [10_000, 10_000, 10_000]

  it('passes a healthy mixed-cap basket', () => {
    const v = guardSplit(mixed, evenTrade)
    expect(v.severity).toBe('ok')
    expect(v.blocking).toBe(false)
    expect(v.headline).toBeNull()
  })

  it('derives a split that sums to exactly 10000', () => {
    const bps = deriveSplitBps(mixed, evenTrade)
    expect(bps).not.toBeNull()
    expect(bps!.reduce((s, v) => s + v, 0)) .toBe(10_000)
  })

  // Asserted against the values COMPUTED from the fixtures rather than eyeballed:
  // my first version assumed WETH must dominate, but 12.4 WETH ($49.8k) really is
  // worth less than 84k AERO ($99.5k). The guard was right and the test was wrong.
  it('weights the split by value, in the order the values actually rank', () => {
    const bps = deriveSplitBps(mixed, evenTrade)!
    const values = mixed.map((l) => l.markUsd * l.held)
    const byValue = [...values.keys()].sort((a, b) => values[b] - values[a])
    const byShare = [...bps.keys()].sort((a, b) => bps[b] - bps[a])
    expect(byShare).toEqual(byValue)
  })

  // The 9999/0 failure: a leg with real value must never receive nothing.
  it('never gives a real leg zero, refusing instead', () => {
    const lopsided: LegMark[] = [
      { symbol: 'BIG', markUsd: 1_000_000_000, held: 1_000, liquidityUsd: 50_000_000 },
      { symbol: 'SMALL', markUsd: 0.000000001, held: 1, liquidityUsd: 50_000_000 },
    ]
    const bps = deriveSplitBps(lopsided, [1_000, 1_000])
    // Either a valid split where SMALL still gets at least 1bp, or an honest null.
    if (bps) expect(bps[1]).toBeGreaterThan(0)
    else expect(bps).toBeNull()
  })

  it('REFUSES to derive a split at all when any leg is blocking', () => {
    const bad = [...mixed, { symbol: 'THIN', markUsd: 814_799_287, held: 1, fundedUsd: 1_600, liquidityUsd: 5_000_000 }]
    expect(deriveSplitBps(bad, [...evenTrade, 1_000])).toBeNull()
  })

  it('names the actual reason rather than a count of problems', () => {
    const bad = [{ symbol: 'THIN', markUsd: 814_799_287, held: 1, fundedUsd: 1_600, liquidityUsd: 5_000_000 }]
    const v = guardSplit(bad, [1_000])
    expect(v.headline).toMatch(/THIN/)
    expect(v.headline).not.toMatch(/\d+ (issues|problems)/i)
  })

  it('warns but does not block on unreadable depth alone', () => {
    const noDepth = [{ symbol: 'X', markUsd: 1, held: 100, liquidityUsd: null }]
    const v = guardSplit(noDepth, [500])
    expect(v.severity).toBe('warn')
    expect(v.blocking).toBe(false)
    // and a split is still derivable, because unverified is not unusable
    expect(deriveSplitBps(noDepth, [500])).not.toBeNull()
  })

  it('BLOCKS an empty basket rather than dividing by nothing', () => {
    const v = guardSplit([], [])
    expect(v.blocking).toBe(true)
    expect(deriveSplitBps([], [])).toBeNull()
  })

  it('refuses when every value is zero', () => {
    expect(deriveSplitBps([{ symbol: 'X', markUsd: 1, held: 0, liquidityUsd: 5_000_000 }], [100])).toBeNull()
  })

  // Every shown sentence is read by a person, so the house copy rules apply.
  it('has no em dashes and no jargon in any shown reason', () => {
    const bad = [
      { symbol: 'THIN', markUsd: 814_799_287, held: 1, fundedUsd: 1_600, liquidityUsd: 100 },
      { symbol: 'X', markUsd: 1, held: 1, liquidityUsd: null },
    ]
    for (const leg of guardSplit(bad, [1_000, 1_000]).legs) {
      expect(leg.reason).toBeTruthy()
      expect(leg.reason!).not.toMatch(/—/)
      expect(leg.reason!).not.toMatch(/bps|basis point|slippage tolerance|oracle/i)
    }
  })
})
