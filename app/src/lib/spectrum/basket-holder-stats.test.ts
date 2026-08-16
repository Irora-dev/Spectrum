import { describe, expect, it } from 'vitest'
import { buildBasketHolderStats } from './basket-holder-stats'
import type { BasketData, Holding } from './basket-data'
import type { PortfolioHolding } from './hooks'
import type { PnlIndex } from './pnl'

const leg = (symbol: string, over: Partial<Holding> = {}): Holding => ({
  asset: `0x${symbol.toLowerCase().padEnd(40, '0')}`,
  symbol,
  name: symbol,
  decimals: 18,
  targetWeightPct: 25,
  balance: 100,
  priceUsd: 1,
  valueUsd: 1_000,
  liveWeightPct: 25,
  change24hPct: 0,
  priced: true,
  series: [],
  ...over,
})

const data = (over: Partial<BasketData> = {}): BasketData =>
  ({ totalSupply: 100, effectiveSupply: 100, navPerToken: 10, aumUsd: 1_000, holdings: [], ...over }) as BasketData

const holding = (over: Partial<PortfolioHolding> = {}): PortfolioHolding =>
  ({
    balance: 10,
    valueUsd: 100,
    basket: { address: '0xbasket', chainId: 8453, symbol: 'BSK', navPerToken: 10, change24hPct: 5 },
    ...over,
  }) as PortfolioHolding

const idx = (cost: string, shares: string, realized = '0'): PnlIndex =>
  ({ upToBlock: '1', positions: { '0xbasket': { cost, shares, realized } } }) as unknown as PnlIndex

describe('basket holder stats — the numbers a buyer is deciding with', () => {
  it('pairs each held basket with its PnL and its own legs', () => {
    const s = buildBasketHolderStats(
      [holding()],
      { 8453: idx('80000000', '10000000000000000000') }, // $80 basis, 10 shares
      new Map([['8453:0xbasket', data({ holdings: [leg('AAA', { change24hPct: 12 }), leg('BBB', { change24hPct: -4 })] })]]),
    )
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0].pnl?.investedUsd).toBeCloseTo(80)
    expect(s.rows[0].pnl?.currentUsd).toBeCloseTo(100)
    expect(s.rows[0].best?.symbol).toBe('AAA')
    expect(s.rows[0].worst?.symbol).toBe('BBB')
    expect(s.totalNetUsd).toBeCloseTo(20)
  })

  it('⚠ an UNPRICEABLE leg can never be the best performer, and is counted out loud', () => {
    const s = buildBasketHolderStats(
      [holding()],
      { 8453: idx('80000000', '10000000000000000000') },
      new Map([
        [
          '8453:0xbasket',
          data({ holdings: [leg('AAA', { change24hPct: 3 }), leg('DEAD', { priced: false, change24hPct: 999 }), leg('BBB', { change24hPct: -1 })] }),
        ],
      ]),
    )
    // the 999 is not a move, it is an unread price — it must not win
    expect(s.rows[0].best?.symbol).toBe('AAA')
    expect(s.rows[0].unpricedLegs).toBe(1)
    expect(s.rows[0].legs.find((l) => l.symbol === 'DEAD')?.change24hPct).toBeNull()
  })

  it('a basket with NO priceable leg has no best and no worst — never an invented one', () => {
    const s = buildBasketHolderStats(
      [holding()],
      {},
      new Map([['8453:0xbasket', data({ holdings: [leg('X', { priced: false }), leg('Y', { priced: false })] })]]),
    )
    expect(s.rows[0].best).toBeNull()
    expect(s.rows[0].worst).toBeNull()
    expect(s.rows[0].unpricedLegs).toBe(2)
  })

  it('⚠ ONE priced leg is a mover, not a best AND a worst — the same row must not appear twice', () => {
    const s = buildBasketHolderStats(
      [holding()],
      {},
      new Map([['8453:0xbasket', data({ holdings: [leg('ONLY', { change24hPct: 7 }), leg('NOPE', { priced: false })] })]]),
    )
    expect(s.rows[0].best?.symbol).toBe('ONLY')
    expect(s.rows[0].worst).toBeNull()
  })

  it('no cost basis yields a row with null PnL — the position still exists', () => {
    const s = buildBasketHolderStats([holding()], {}, new Map([['8453:0xbasket', data({ holdings: [leg('AAA')] })]]))
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0].pnl).toBeNull()
    expect(s.rowsWithoutBasis).toBe(1)
    // and it must NOT drag the totals to a fake break-even
    expect(s.totalInvestedUsd).toBe(0)
    expect(s.totalNetPct).toBe(0)
  })

  it('totals cover ONLY rows with a basis, and say how many they left out', () => {
    const s = buildBasketHolderStats(
      [
        holding(),
        holding({ basket: { address: '0xother', chainId: 8453, symbol: 'OTH', navPerToken: 2, change24hPct: 0 } as never, balance: 5, valueUsd: 10 }),
      ],
      { 8453: idx('80000000', '10000000000000000000') },
      new Map([
        ['8453:0xbasket', data({ holdings: [leg('AAA')] })],
        ['8453:0xother', data({ holdings: [leg('BBB')] })],
      ]),
    )
    expect(s.rowsWithoutBasis).toBe(1)
    expect(s.totalInvestedUsd).toBeCloseTo(80) // the basis-less row contributes nothing
    expect(s.totalCurrentUsd).toBeCloseTo(100)
  })

  it('a holder’s leg dollars are THEIR share, and can never exceed the basket’s own', () => {
    const s = buildBasketHolderStats(
      [holding({ balance: 25 })], // 25 of 100 supply = a quarter
      {},
      new Map([['8453:0xbasket', data({ effectiveSupply: 100, holdings: [leg('AAA', { valueUsd: 1_000 })] })]]),
    )
    expect(s.rows[0].legs[0].valueUsd).toBeCloseTo(250)
  })

  it('⚠ a STALE supply read cannot inflate a holder past 100% of the basket', () => {
    const s = buildBasketHolderStats(
      [holding({ balance: 500 })], // more tokens than the (stale) supply says exist
      {},
      new Map([['8453:0xbasket', data({ effectiveSupply: 100, holdings: [leg('AAA', { valueUsd: 1_000 })] })]]),
    )
    expect(s.rows[0].legs[0].valueUsd).toBeLessThanOrEqual(1_000)
  })

  it('an unreadable basket (no data) still renders its position, with no legs claimed', () => {
    const s = buildBasketHolderStats([holding()], {}, new Map())
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0].legs).toEqual([])
    expect(s.rows[0].best).toBeNull()
    expect(s.rows[0].valueUsd).toBe(100)
  })

  it('a zero or unreadable supply does not divide — legs price at zero rather than Infinity', () => {
    const s = buildBasketHolderStats(
      [holding()],
      {},
      new Map([['8453:0xbasket', data({ effectiveSupply: 0, holdings: [leg('AAA', { valueUsd: 1_000 })] })]]),
    )
    expect(Number.isFinite(s.rows[0].legs[0].valueUsd)).toBe(true)
    expect(s.rows[0].legs[0].valueUsd).toBe(0)
  })

  it('rows are ordered by money, biggest position first', () => {
    const s = buildBasketHolderStats(
      [
        holding({ basket: { address: '0xsmall', chainId: 8453, symbol: 'SML', navPerToken: 1, change24hPct: 0 } as never, valueUsd: 5 }),
        holding({ basket: { address: '0xbig', chainId: 8453, symbol: 'BIG', navPerToken: 1, change24hPct: 0 } as never, valueUsd: 500 }),
      ],
      {},
      new Map(),
    )
    expect(s.rows.map((r) => r.symbol)).toEqual(['BIG', 'SML'])
  })
})
