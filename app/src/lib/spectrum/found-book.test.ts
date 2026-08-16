import { describe, expect, it } from 'vitest'
import { BENTO_DUST_USD, basketRowsFromPortfolio, deriveFoundBook, majors } from './found-book'
import type { RawHolding } from './raw-holdings'

const h = (symbol: string, usd: number | null, over: Partial<RawHolding> = {}): RawHolding => ({
  chainId: 8453,
  address: `0x${symbol.padEnd(40, 'a').toLowerCase()}`,
  symbol,
  decimals: 18,
  amount: 1,
  usd,
  ...over,
})

describe('the found book (one derivation, two surfaces)', () => {
  it('majors sort priced first, unpriced last, capped', () => {
    const out = majors([h('DEAD', null), h('BIG', 900), h('MID', 100)], 2)
    expect(out.map((x) => x.symbol)).toEqual(['BIG', 'MID'])
  })

  it('bento tiles are value-share weighted with chain-qualified ids', () => {
    const { bentoItems } = deriveFoundBook([h('A', 750), h('B', 250)])
    expect(bentoItems.map((t) => t.weightPct)).toEqual([75, 25])
    expect(bentoItems[0].id).toBe(`8453:${bentoItems[0].address.toLowerCase()}`)
    // the cross-chain native collision (5ea8cb8): same address, two chains,
    // two DISTINCT ids
    const native = deriveFoundBook([
      h('ETH', 500, { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', chainId: 1, native: true }),
      h('ETH', 500, { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', chainId: 8453, native: true }),
    ])
    expect(new Set(native.bentoItems.map((t) => t.id)).size).toBe(2)
  })

  it('dust does not tile — it stays in the rows, honestly', () => {
    const { bentoItems, listRows } = deriveFoundBook([h('A', 500), h('B', 400), h('DUST', BENTO_DUST_USD - 0.5)])
    expect(bentoItems.map((t) => t.symbol)).toEqual(['A', 'B'])
    expect(listRows.map((r) => r.symbol)).toEqual(['DUST'])
  })

  it('a holding exactly at the dust floor tiles once and never rows', () => {
    const { bentoItems, listRows } = deriveFoundBook([h('A', 500), h('EDGE', BENTO_DUST_USD)])
    expect(bentoItems.map((t) => t.symbol)).toContain('EDGE')
    expect(listRows.find((r) => r.symbol === 'EDGE')).toBeUndefined()
  })

  it('fewer than two tileable holdings: no picture, rows carry everything', () => {
    const { bentoItems, listRows } = deriveFoundBook([h('ONLY', 900), h('DEAD', null)])
    expect(bentoItems).toEqual([])
    expect(listRows.map((r) => r.symbol)).toEqual(['ONLY', 'DEAD'])
  })

  it('readableUsd sums every priced holding, not just the majors window', () => {
    const many = Array.from({ length: 9 }, (_, i) => h(`T${i}`, 100))
    expect(deriveFoundBook(many).readableUsd).toBe(900)
  })
})

describe('basketRowsFromPortfolio (the audit finding, 2026-08-04)', () => {
  const pos = (symbol: string, balance: number, valueUsd: number) => ({
    basket: { address: `0x${symbol.padEnd(40, 'b')}`, symbol, chainId: 8453, decimals: 18 },
    balance,
    valueUsd,
  })

  it('a baskets-ONLY wallet gets a real book instead of “nothing readable”', () => {
    // The whole point: the raw sweep reads verified token lists and can never
    // contain a basket token, so this wallet used to read as empty on first open.
    const rows = basketRowsFromPortfolio([pos('LPADS', 12, 400), pos('WSB', 4, 600)])
    const { bentoItems, readableUsd } = deriveFoundBook(rows)
    expect(readableUsd).toBe(1000)
    expect(bentoItems.map((t) => t.symbol)).toEqual(['WSB', 'LPADS'])
    expect(bentoItems.map((t) => Math.round(t.weightPct))).toEqual([60, 40])
  })

  it('marks rows as baskets so surfaces can render one tile and refuse to seed them', () => {
    expect(basketRowsFromPortfolio([pos('LPADS', 1, 10)])[0].basket).toBe(true)
  })

  it('an unreadable NAV prices as null (unpriced), never zero', () => {
    expect(basketRowsFromPortfolio([pos('DARK', 5, 0)])[0].usd).toBeNull()
  })

  it('a zero balance is not a holding', () => {
    expect(basketRowsFromPortfolio([pos('GONE', 0, 0)])).toEqual([])
  })

  it('folds BESIDE raw rows without double counting (the basket holds its own legs)', () => {
    const book = deriveFoundBook([h('WETH', 700), ...basketRowsFromPortfolio([pos('LPADS', 3, 300)])])
    expect(book.readableUsd).toBe(1000)
    expect(book.bentoItems.map((t) => t.symbol)).toEqual(['WETH', 'LPADS'])
  })
})
