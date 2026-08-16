import { describe, expect, it } from 'vitest'
import { combineExposure, rawToExposureRows, type RawHolding } from './raw-holdings'
import type { ExposureBreakdown } from './exposure'

const H = (chainId: number, address: string, symbol: string, usd: number | null): RawHolding => ({
  chainId,
  address,
  symbol,
  decimals: 18,
  amount: 1,
  usd,
})

const base: ExposureBreakdown = {
  assets: [
    {
      key: '1:0xaaa',
      address: '0xaaa',
      symbol: 'WETH',
      chainId: 1,
      valueUsd: 300,
      pct: 75,
      basketCount: 2,
      contributions: [
        { basketSymbol: 'ALPHA', basketAddress: '0xb1', chainId: 1, valueUsd: 200 },
        { basketSymbol: 'BETA', basketAddress: '0xb2', chainId: 1, valueUsd: 100 },
      ],
    },
    {
      key: '1:0xbbb',
      address: '0xbbb',
      symbol: 'AAVE',
      chainId: 1,
      valueUsd: 100,
      pct: 25,
      basketCount: 1,
      contributions: [{ basketSymbol: 'ALPHA', basketAddress: '0xb1', chainId: 1, valueUsd: 100 }],
    },
  ],
  totalUsd: 400,
  chainCount: 1,
  basis: 'target',
  fellBackCount: 0,
}

describe('raw holdings → exposure', () => {
  it('unpriced holdings never enter the weighting (shown elsewhere, not guessed)', () => {
    expect(rawToExposureRows([H(1, '0xccc', 'MYSTERY', null)])).toHaveLength(0)
  })

  it('same asset adds up with a held-directly contribution; new assets append; pcts recompute to 100', () => {
    const out = combineExposure(base, [H(1, '0xAAA', 'WETH', 100), H(8453, '0xddd', 'BANKR', 500)])
    const weth = out.assets.find((a) => a.key === '1:0xaaa')!
    expect(weth.valueUsd).toBe(400)
    expect(weth.contributions.some((c) => c.basketSymbol === 'held directly')).toBe(true)
    const bankr = out.assets.find((a) => a.symbol === 'BANKR')!
    expect(bankr.basketCount).toBe(0)
    expect(out.totalUsd).toBe(1000)
    expect(out.chainCount).toBe(2)
    expect(out.assets.reduce((s, a) => s + a.pct, 0)).toBeCloseTo(100)
    expect(out.assets[0].valueUsd).toBeGreaterThanOrEqual(out.assets[1].valueUsd)
  })

  it('no priced raw holdings → the base breakdown passes through untouched', () => {
    expect(combineExposure(base, [H(1, '0xccc', 'X', null)])).toBe(base)
  })
})

// ── the manual-add merge seam (paste-to-add, owner 2026-08-12) ───────────────
import { planExtraTokens } from './raw-holdings'

describe('planExtraTokens (hand-added tokens join the sweep)', () => {
  const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const KNOWN = '0x1111111111111111111111111111111111111111'
  const DISC = '0x2222222222222222222222222222222222222222'
  const MANUAL = '0x3333333333333333333333333333333333333333'

  it('unions discovery + manual, dedupes against the curated list and itself', () => {
    const { extras, manualSet } = planExtraTokens(new Set([KNOWN]), [DISC, KNOWN], [MANUAL, DISC, KNOWN])
    expect(extras).toEqual([DISC, MANUAL]) // KNOWN never re-described; DISC once
    expect(manualSet.has(MANUAL)).toBe(true)
    expect(manualSet.has(DISC)).toBe(true) // pasted AND discovered — still hand-added
    expect(manualSet.has(KNOWN)).toBe(true) // pasted a listed token — flag survives for the fold exemption
  })

  it('case-folds manual input and refuses garbage + the native sentinel', () => {
    const { extras, manualSet } = planExtraTokens(new Set(), [], [MANUAL.toUpperCase().replace('0X', '0x'), 'not-an-address', NATIVE])
    expect(extras).toEqual([MANUAL])
    expect(manualSet.size).toBe(1)
  })

  it('no manual rows = byte-identical behavior to the old discovery-only path', () => {
    const { extras, manualSet } = planExtraTokens(new Set([KNOWN]), [DISC], [])
    expect(extras).toEqual([DISC])
    expect(manualSet.size).toBe(0)
  })
})
