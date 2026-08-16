import { describe, expect, it } from 'vitest'
import { shareCardItems } from './share-card'

describe('shareCardItems (feature 9: percent-only, nothing private)', () => {
  const A = (symbol: string, valueUsd: number) => ({ symbol, address: `0x${'11'.repeat(20)}`, valueUsd })
  it('normalizes to shares of the held total, top 12, no dollars anywhere', () => {
    const items = shareCardItems([A('WETH', 3000), A('USDC', 1000), A('DUST', 0)])
    expect(items.map((i) => [i.symbol, i.pct])).toEqual([
      ['WETH', 75],
      ['USDC', 25],
    ])
    for (const i of items) expect(Object.keys(i)).toEqual(['symbol', 'pct', 'color'])
  })
  it('empty portfolio → empty card', () => {
    expect(shareCardItems([A('X', 0)])).toEqual([])
  })
})
