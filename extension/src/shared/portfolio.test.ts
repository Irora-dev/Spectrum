import { describe, expect, it } from 'vitest'
import { aggregate24h, computeDrift } from './portfolio'

describe('aggregate24h', () => {
  it('value-weights the change over priced holdings and counts the excluded', () => {
    // 1000 now at +10% (was ~909.09) + 1000 now at -10% (was ~1111.11), one unpriced.
    const { pct, excluded } = aggregate24h([
      { valueUsd: 1000, change24hPct: 10 },
      { valueUsd: 1000, change24hPct: -10 },
      { valueUsd: 500, change24hPct: null },
    ])
    const prev = 1000 / 1.1 + 1000 / 0.9
    expect(pct).toBeCloseTo(((2000 - prev) / prev) * 100, 6)
    expect(excluded).toBe(1)
  })

  it('is null when nothing carries a 24h figure', () => {
    expect(aggregate24h([{ valueUsd: 100, change24hPct: null }])).toEqual({ pct: null, excluded: 1 })
    expect(aggregate24h([])).toEqual({ pct: null, excluded: 0 })
  })

  it('excludes a -100% (or worse) figure instead of dividing by zero', () => {
    const { pct, excluded } = aggregate24h([
      { valueUsd: 0, change24hPct: -100 },
      { valueUsd: 100, change24hPct: 5 },
    ])
    expect(excluded).toBe(1)
    expect(pct).toBeCloseTo(5, 6)
  })
})

describe('computeDrift', () => {
  const assets = [
    { key: '8453:0xa', symbol: 'WETH', pct: 31 },
    { key: '8453:0xb', symbol: 'USDC', pct: 49 },
    { key: '4663:0xc', symbol: 'HOOD', pct: 20 },
  ]

  it('reports per-asset deltas sorted by magnitude and the half-sum aggregate', () => {
    const drift = computeDrift(assets, { '8453:0xa': 25, '8453:0xb': 55 })
    expect(drift.perAsset.map((d) => d.key)).toEqual(['8453:0xa', '8453:0xb'])
    expect(drift.perAsset[0].deltaPts).toBeCloseTo(6)
    expect(drift.perAsset[1].deltaPts).toBeCloseTo(-6)
    expect(drift.aggregatePts).toBeCloseTo(6)
    expect(drift.untargeted).toBe(1)
  })

  it('is null-aggregate with no targets at all', () => {
    const drift = computeDrift(assets, {})
    expect(drift.aggregatePts).toBeNull()
    expect(drift.perAsset).toHaveLength(0)
    expect(drift.untargeted).toBe(3)
  })

  it('counts a targeted asset the wallet no longer holds as fully under target', () => {
    const drift = computeDrift(assets, { '1:0xgone': 10 })
    expect(drift.perAsset).toHaveLength(1)
    expect(drift.perAsset[0].currentPct).toBe(0)
    expect(drift.perAsset[0].deltaPts).toBe(-10)
    expect(drift.aggregatePts).toBeCloseTo(5)
  })
})
