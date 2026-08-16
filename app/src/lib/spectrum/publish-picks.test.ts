import { describe, expect, it } from 'vitest'
import { assetKey } from './allocation'
import type { PositionRow } from './position-intents'
import { buildPublishDraft, integerShares, picksWithShares, publishableRows } from './publish-picks'

const row = (symbol: string, valueUsd: number, kind?: 'token' | 'basket', chainId = 8453): PositionRow => ({
  asset: { chainId, address: `0x${symbol.toLowerCase().padEnd(40, '0')}`, symbol },
  valueUsd,
  pct: 0,
  kind,
})

const keyOf = (r: PositionRow) => assetKey(r.asset).toLowerCase()

describe('publishableRows', () => {
  it('keeps direct tokens (cash included) and drops baskets and zero-value rows', () => {
    const rows = [row('WETH', 100), row('USDC', 50), row('DEVBKT', 900, 'basket'), row('DUST', 0)]
    expect(publishableRows(rows).map((r) => r.asset.symbol)).toEqual(['WETH', 'USDC'])
  })

  it('treats an absent kind as a token', () => {
    expect(publishableRows([row('AAVE', 10)])).toHaveLength(1)
  })
})

describe('picksWithShares', () => {
  it('shares are of the PICKED set, not the portfolio', () => {
    const rows = [row('WETH', 300), row('AAVE', 100), row('SYRUP', 600)]
    const picks = picksWithShares(rows, new Set([keyOf(rows[0]), keyOf(rows[1])]))
    expect(picks.map((p) => [p.row.asset.symbol, Math.round(p.sharePct)])).toEqual([
      ['WETH', 75],
      ['AAVE', 25],
    ])
  })

  it('a picked basket key is ignored — baskets cannot be legs', () => {
    const basket = row('DEVBKT', 900, 'basket')
    const picks = picksWithShares([basket, row('WETH', 100)], new Set([keyOf(basket)]))
    expect(picks).toHaveLength(0)
  })
})

describe('buildPublishDraft', () => {
  it('returns null with nothing picked', () => {
    expect(buildPublishDraft([row('WETH', 100)], new Set(), 1)).toBeNull()
  })

  it('weights are integer percents summing 100 mirroring held proportions; amount is the picked total; intent publish; no funding', () => {
    const rows = [row('WETH', 300.4), row('AAVE', 99.6)]
    const draft = buildPublishDraft(rows, new Set(rows.map(keyOf)), 42)
    expect(draft).not.toBeNull()
    expect(draft!.intent).toBe('publish')
    expect(draft!.targets.map((t) => [t.asset.symbol, t.weight])).toEqual([
      ['WETH', 75],
      ['AAVE', 25],
    ])
    expect(draft!.amountUsd).toBe(400)
    expect(draft!.funding).toBeUndefined()
    expect(draft!.updatedAt).toBe(42)
  })

  it('a dust position the user picked keeps 1% instead of vanishing; the sum stays 100', () => {
    const rows = [row('WETH', 100), row('DUSTY', 0.4)]
    const draft = buildPublishDraft(rows, new Set(rows.map(keyOf)), 1)
    const weights = Object.fromEntries(draft!.targets.map((t) => [t.asset.symbol, t.weight]))
    expect(weights.DUSTY).toBe(1)
    expect(weights.WETH).toBe(99)
  })
})

describe('integerShares', () => {
  it('sums to exactly 100 and follows largest remainder', () => {
    expect(integerShares([300.4, 99.6])).toEqual([75, 25])
    expect(integerShares([1, 1, 1])).toEqual([34, 33, 33])
  })

  it('every entry stays ≥1, excess clawed from the largest', () => {
    const s = integerShares([1000, 1, 1, 1])
    expect(s.reduce((a, b) => a + b, 0)).toBe(100)
    expect(Math.min(...s)).toBe(1)
    expect(s[0]).toBe(97)
  })

  it('an empty or zero set yields zeros, never NaN', () => {
    expect(integerShares([])).toEqual([])
    expect(integerShares([0, 0])).toEqual([0, 0])
  })
})

describe('holdings-backed draft (the freeze IN-item wiring)', () => {
  const row = (symbol: string, valueUsd: number, chainId = 8453) => ({
    asset: { chainId, address: `0x${'77'.repeat(20)}`, symbol },
    valueUsd,
    pct: 0,
  })
  it('carries seedFrom (held values) and the default seed depth', () => {
    const rows = [row('WETH', 300), row('AAVE', 100)]
    const d = buildPublishDraft(rows as never, new Set([`8453:${'0x' + '77'.repeat(20)}`.toLowerCase()]), 1)!
    expect(d.seedFrom).toHaveLength(2)
    expect(d.seedFrom![0]).toMatchObject({ symbol: 'WETH', heldUsd: 300 })
    expect(d.seedPct).toBeGreaterThan(0)
  })
})

describe('audit round 5 (2026-08-04): a weight is ALWAYS a number', () => {
  it('an unreadable value cannot poison its siblings — it takes no share', () => {
    // Before: one NaN poisoned the total, Math.floor(NaN) is NaN, and the
    // function returned [null,null,null] once serialized — NaN weights landing
    // in a DRAFT, which the weight station and the composer then read.
    const out = integerShares([Number.NaN, 50, 50])
    expect(out).toEqual([0, 50, 50])
    expect(out.every((n) => Number.isFinite(n))).toBe(true)
  })

  it('a negative value takes no share either — it cannot be a proportion of anything', () => {
    const out = integerShares([-10, 60, 50])
    expect(out[0]).toBe(0)
    expect(out.reduce((s, n) => s + n, 0)).toBe(100)
  })

  it('every shape still sums to exactly 100 when anything is spendable', () => {
    for (const vals of [
      [Number.NaN, 50, 50],
      [-10, 60, 50],
      [Number.POSITIVE_INFINITY, 10],
      [1e-9, 1e-9, 99.9],
      [1, 1, 1],
    ]) {
      const out = integerShares(vals)
      expect(out.every((n) => Number.isFinite(n))).toBe(true)
      if (out.some((n) => n > 0)) expect(out.reduce((s, n) => s + n, 0)).toBe(100)
    }
  })

  it('an all-unreadable set produces all zeros, never a fabricated split', () => {
    expect(integerShares([Number.NaN, Number.NaN])).toEqual([0, 0])
  })
})
