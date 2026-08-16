import { describe, expect, it } from 'vitest'
import { computeExposure } from './exposure'
import type { PortfolioHolding } from './hooks'

const held = (over: Record<string, unknown>): PortfolioHolding =>
  ({
    balance: 1,
    valueUsd: 1000,
    ...over,
  }) as PortfolioHolding

describe('computeExposure — the legless-basket rule (class-signal review, 2026-08-06)', () => {
  it('keeps a legless basket WHOLE under its own key instead of dropping the money', () => {
    const r = computeExposure([
      held({ basket: { chainId: 8453, address: '0xB45E', symbol: 'OPQ', top: [] }, valueUsd: 6500 }),
    ])
    const row = r.assets.find((a) => a.symbol === 'OPQ')
    expect(row).toBeTruthy()
    expect(row!.valueUsd).toBe(6500)
    expect(row!.key).toBe('8453:0xb45e')
    // the book's total keeps the position — this used to silently drop it
    expect(r.totalUsd).toBe(6500)
  })

  it('a basket WITH legs still explodes exactly as before', () => {
    const r = computeExposure([
      held({
        basket: {
          chainId: 8453,
          address: '0xB45E',
          symbol: 'MIX',
          top: [
            { symbol: 'AAA', address: '0xA', weightPct: 60 },
            { symbol: 'BBB', address: '0xB', weightPct: 40 },
          ],
        },
        valueUsd: 1000,
      }),
    ])
    expect(r.assets.find((a) => a.symbol === 'MIX')).toBeUndefined()
    expect(r.assets.find((a) => a.symbol === 'AAA')?.valueUsd).toBe(600)
    expect(r.assets.find((a) => a.symbol === 'BBB')?.valueUsd).toBe(400)
  })
})

describe("computeExposure — the whole-basket fold (owner 2026-08-16: the bento shows baskets, not look-through)", () => {
  const mix = {
    chainId: 8453,
    address: '0xB45E',
    symbol: 'MIX',
    top: [
      { symbol: 'AAA', address: '0xA', weightPct: 60 },
      { symbol: 'BBB', address: '0xB', weightPct: 40 },
    ],
  }

  it('folds a legged basket to ONE row under its own key, legs riding for the tile', () => {
    const r = computeExposure([held({ basket: mix, valueUsd: 1000 })], { basketFold: 'whole' })
    expect(r.assets).toHaveLength(1)
    const row = r.assets[0]!
    expect(row.symbol).toBe('MIX')
    expect(row.key).toBe('8453:0xb45e')
    expect(row.basket).toBe(true)
    expect(row.basketLegs?.map((l) => l.symbol)).toEqual(['AAA', 'BBB'])
    expect(row.valueUsd).toBe(1000)
    expect(r.totalUsd).toBe(1000)
    // the constituents never surface as their own rows in this fold
    expect(r.assets.find((a) => a.symbol === 'AAA')).toBeUndefined()
  })

  it('merges the SAME basket held from two linked wallets into one row', () => {
    const r = computeExposure(
      [held({ basket: mix, valueUsd: 1000 }), held({ basket: mix, valueUsd: 500 })],
      { basketFold: 'whole' },
    )
    expect(r.assets).toHaveLength(1)
    expect(r.assets[0]!.valueUsd).toBe(1500)
    expect(r.assets[0]!.contributions).toHaveLength(2)
  })

  it('omitting the option keeps the original exploded look-through byte for byte', () => {
    const r = computeExposure([held({ basket: mix, valueUsd: 1000 })])
    expect(r.assets.find((a) => a.symbol === 'MIX')).toBeUndefined()
    expect(r.assets.find((a) => a.symbol === 'AAA')?.valueUsd).toBe(600)
  })
})
