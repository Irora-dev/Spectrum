import { describe, expect, it } from 'vitest'
import { heldKey, heldPosition, heldValueUsd, indexHeldBaskets } from './held-baskets'

// The "you hold this" lookup (QOL round 2026-08-05). What must hold or the card
// marker lies: a zero balance is not a holding, an unpriced holding is null and
// never $0, and one basket resolves by chain AND address (a shared address across
// chains must not answer for the other chain's basket).
const row = (address: string, chainId: number, balance: number, valueUsd: number) => ({
  basket: { chainId, address },
  balance,
  valueUsd,
})

describe('indexHeldBaskets', () => {
  it('indexes a held basket by chain-qualified lowercased key', () => {
    const idx = indexHeldBaskets([row('0xAbCdEf', 8453, 12, 480)])
    expect([...idx.keys()]).toEqual(['8453:0xabcdef'])
    expect(idx.get('8453:0xabcdef')).toEqual({ balance: 12, valueUsd: 480 })
  })

  it('reads nothing from no portfolio at all', () => {
    expect(indexHeldBaskets(undefined).size).toBe(0)
    expect(indexHeldBaskets(null).size).toBe(0)
    expect(indexHeldBaskets([]).size).toBe(0)
  })

  it('drops rows with no real balance (never a $0 position)', () => {
    const idx = indexHeldBaskets([
      row('0xa', 1, 0, 0),
      row('0xb', 1, -5, 100),
      row('0xc', 1, Number.NaN, 100),
      row('0xd', 1, 0.0001, 0),
    ])
    expect([...idx.keys()]).toEqual(['1:0xd'])
  })

  it('prices an unreadable NAV as null, not zero', () => {
    const idx = indexHeldBaskets([row('0xa', 1, 10, 0), row('0xb', 1, 10, Number.NaN)])
    expect(idx.get('1:0xa')?.valueUsd).toBeNull()
    expect(idx.get('1:0xb')?.valueUsd).toBeNull()
    // the FACT of holding survives an unpriced value — that is the marker's job
    expect(idx.get('1:0xa')?.balance).toBe(10)
  })

  it('keeps the same basket on two chains apart', () => {
    const idx = indexHeldBaskets([row('0xa', 1, 5, 50), row('0xa', 8453, 7, 70)])
    expect(idx.get('1:0xa')?.balance).toBe(5)
    expect(idx.get('8453:0xa')?.balance).toBe(7)
  })

  it('sums duplicate rows for one basket (a group reads as one book)', () => {
    const idx = indexHeldBaskets([row('0xa', 1, 5, 50), row('0xa', 1, 7, 70)])
    expect(idx.get('1:0xa')).toEqual({ balance: 12, valueUsd: 120 })
  })

  it('keeps a partly priced merge priced, and a wholly unpriced one null', () => {
    expect(indexHeldBaskets([row('0xa', 1, 5, 50), row('0xa', 1, 7, 0)]).get('1:0xa')?.valueUsd).toBe(50)
    expect(indexHeldBaskets([row('0xa', 1, 5, 0), row('0xa', 1, 7, 0)]).get('1:0xa')?.valueUsd).toBeNull()
  })
})

describe('heldKey / heldPosition', () => {
  it('resolves a card to its own position, case-insensitively', () => {
    const idx = indexHeldBaskets([row('0xabc', 8453, 3, 30)])
    expect(heldPosition(idx, { chainId: 8453, address: '0xABC' })).toEqual({ balance: 3, valueUsd: 30 })
  })

  it('is null for a basket the viewer does not hold, and for no wallet at all', () => {
    const idx = indexHeldBaskets([row('0xabc', 8453, 3, 30)])
    expect(heldPosition(idx, { chainId: 8453, address: '0xdef' })).toBeNull()
    expect(heldPosition(idx, { chainId: 1, address: '0xabc' })).toBeNull()
    expect(heldPosition(undefined, { chainId: 1, address: '0xabc' })).toBeNull()
  })

  it('keys chain-first so the two halves can never be confused', () => {
    expect(heldKey({ chainId: 8453, address: '0xAB' })).toBe('8453:0xab')
  })
})

describe('heldValueUsd', () => {
  it('states a priced figure', () => {
    expect(heldValueUsd({ balance: 1, valueUsd: 1234.5 })).toBe(1234.5)
    expect(heldValueUsd({ balance: 1, valueUsd: 0.01 })).toBe(0.01)
  })

  it('withholds an unpriced one', () => {
    expect(heldValueUsd({ balance: 1, valueUsd: null })).toBeNull()
    expect(heldValueUsd(null)).toBeNull()
    expect(heldValueUsd(undefined)).toBeNull()
  })

  it('withholds a sub-cent figure rather than rendering "$0"', () => {
    expect(heldValueUsd({ balance: 1, valueUsd: 0.004 })).toBeNull()
    expect(heldValueUsd({ balance: 1, valueUsd: Number.NaN })).toBeNull()
  })
})
