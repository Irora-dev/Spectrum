import { describe, expect, it } from 'vitest'
import { canonSymbol, unifyAssets } from './asset-unify'

const P = (chainId: number, symbol: string, valueUsd: number, over: Partial<Parameters<typeof unifyAssets>[0][number]> = {}) => ({
  key: `${chainId}:0x${symbol.toLowerCase().padEnd(4, '0')}`,
  chainId,
  address: `0x${symbol.toLowerCase().padEnd(4, '0')}`,
  symbol,
  valueUsd,
  ...over,
})

describe('asset unification (owner ~15:0x: one bento asset per real asset)', () => {
  it('folds eth/weth across chains into ONE asset — canon symbol, summed money, largest part leads', () => {
    const out = unifyAssets([P(8453, 'WETH', 6310, { pct: 14 }), P(1, 'ETH', 2130, { pct: 5 }), P(1, 'AAVE', 4820, { pct: 11 })])
    const eth = out.find((u) => u.canon === 'ETH')!
    expect(eth.merged).toBe(true)
    expect(eth.id).toBe('canon:eth')
    expect(eth.valueUsd).toBe(8440)
    expect(eth.pct).toBe(19)
    expect(eth.parts.map((p) => p.symbol)).toEqual(['WETH', 'ETH']) // largest first
    expect(eth.dominant.chainId).toBe(8453)
    const aave = out.find((u) => u.canon === 'AAVE')!
    expect(aave.merged).toBe(false)
    expect(aave.id).toBe(aave.parts[0].key) // singles keep their own key
  })

  it('folds the SAME symbol held on two chains (usdc twice = one asset held twice)', () => {
    const out = unifyAssets([P(8453, 'USDC', 3100), P(1, 'USDC', 900)])
    expect(out).toHaveLength(1)
    expect(out[0].canon).toBe('USDC')
    expect(out[0].parts).toHaveLength(2)
  })

  it('folds the BTC wrap family', () => {
    const out = unifyAssets([P(1, 'WBTC', 2000), P(8453, 'cbBTC', 1000)])
    expect(out).toHaveLength(1)
    expect(out[0].canon).toBe('BTC')
    expect(canonSymbol('cbBTC')).toBe('BTC')
  })

  it('blends the 24h change value-weighted over PRICED parts; all-null stays null (never flat)', () => {
    const out = unifyAssets([
      P(8453, 'WETH', 100, { change24hPct: 2 }),
      P(1, 'ETH', 50, { change24hPct: -1 }),
      P(1, 'AAVE', 10, { change24hPct: null }),
    ])
    const eth = out.find((u) => u.canon === 'ETH')!
    expect(eth.change24hPct).toBeCloseTo((2 * 100 + -1 * 50) / 150, 6)
    const aave = out.find((u) => u.canon === 'AAVE')!
    expect(aave.change24hPct).toBeNull()
  })

  it('a merged asset with one unreadable part blends over what IS priced', () => {
    const out = unifyAssets([P(8453, 'WETH', 100, { change24hPct: 3 }), P(1, 'ETH', 900, { change24hPct: null })])
    expect(out[0].change24hPct).toBeCloseTo(3, 6)
  })

  it('orders by total value, largest first', () => {
    const out = unifyAssets([P(1, 'AAVE', 100), P(8453, 'WETH', 900), P(1, 'ETH', 200)])
    expect(out.map((u) => u.canon)).toEqual(['ETH', 'AAVE'])
  })
})

describe('audit round 2: symbols are attacker-controlled — folding is curated', () => {
  it('an arbitrary same-symbol stranger does NOT fold (scam-PEPE cannot wear real-PEPE)', () => {
    const out = unifyAssets([P(8453, 'PEPE', 900), P(1, 'PEPE', 50_000)])
    expect(out).toHaveLength(2) // two tiles, identities separate
    expect(out.every((u) => !u.merged)).toBe(true)
  })
  it('the curated families still fold (the owner ask intact)', () => {
    expect(unifyAssets([P(8453, 'WETH', 100), P(1, 'ETH', 50)])).toHaveLength(1)
    expect(unifyAssets([P(8453, 'USDC', 100), P(1, 'USDC', 50)])).toHaveLength(1)
  })
})

describe('the basket law (audit 2026-08-04): a basket is never the same asset as a token', () => {
  it('a basket whose creator named it WETH stays its OWN tile beside the real fold', () => {
    const rows = [
      { key: '8453:0xweth', chainId: 8453, address: '0xweth', symbol: 'WETH', valueUsd: 900 },
      { key: '1:0xeth', chainId: 1, address: '0xeth', symbol: 'ETH', valueUsd: 100 },
      { key: '8453:0xbasket', chainId: 8453, address: '0xbasket', symbol: 'WETH', valueUsd: 500, basket: true },
    ]
    const out = unifyAssets(rows)
    expect(out).toHaveLength(2)
    const fold = out.find((u) => u.merged)!
    expect(fold.parts.map((p) => p.key).sort()).toEqual(['1:0xeth', '8453:0xweth'])
    const basket = out.find((u) => u.parts.some((p) => p.basket))!
    expect(basket.merged).toBe(false)
    expect(basket.id).toBe('8453:0xbasket')
  })

  it('a basket named USDC never joins the stable fold either', () => {
    const rows = [
      { key: '8453:0xusdc', chainId: 8453, address: '0xusdc', symbol: 'USDC', valueUsd: 100 },
      { key: '1:0xusdc', chainId: 1, address: '0xusdc2', symbol: 'USDC', valueUsd: 100 },
      { key: '8453:0xbk', chainId: 8453, address: '0xbk', symbol: 'USDC', valueUsd: 100, basket: true },
    ]
    const out = unifyAssets(rows)
    expect(out).toHaveLength(2)
    expect(out.find((u) => u.parts.some((p) => p.basket))!.parts).toHaveLength(1)
  })
})
