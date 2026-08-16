import { describe, expect, it } from 'vitest'
import { classifyTier, TIER_ORDER, TIER_THRESHOLDS, volatileSharePct } from './market-tiers'

describe('classifyTier', () => {
  it('registries outrank market cap (stables, majors, stocks)', () => {
    expect(classifyTier('USDC', 50e9)).toBe('cash')
    expect(classifyTier('cbBTC', null)).toBe('majors')
    expect(classifyTier('NVDA', 3e12, { isStock: true })).toBe('stocks')
  })

  it('tiers by the stated thresholds', () => {
    expect(classifyTier('LINK', TIER_THRESHOLDS.large)).toBe('large')
    expect(classifyTier('AERO', TIER_THRESHOLDS.mid)).toBe('mid')
    expect(classifyTier('DEGEN', TIER_THRESHOLDS.small)).toBe('small')
    expect(classifyTier('NEWLAUNCH', 5_000_000)).toBe('micro')
    expect(classifyTier('JUSTOVER', 20_000_001)).toBe('small')
  })

  it('an unreadable cap is unranked, never guessed into a tier', () => {
    expect(classifyTier('MYSTERY', null)).toBe('unranked')
    expect(classifyTier('MYSTERY', 0)).toBe('unranked')
  })

  it('cash leads and unranked trails the display order', () => {
    expect(TIER_ORDER[0]).toBe('cash')
    expect(TIER_ORDER[TIER_ORDER.length - 1]).toBe('unranked')
  })
})

describe('volatileSharePct', () => {
  it('sums exactly the small + micro tiers', () => {
    expect(
      volatileSharePct([
        { tier: 'majors', pct: 50 },
        { tier: 'small', pct: 30 },
        { tier: 'micro', pct: 12 },
        { tier: 'unranked', pct: 8 },
      ]),
    ).toBe(42)
  })
})
