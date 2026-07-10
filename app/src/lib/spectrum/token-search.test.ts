import { describe, expect, it } from 'vitest'
import { aggregatePairs, type Agg, type DexPair } from './token-search'

const WETH = '0x4200000000000000000000000000000000000006'
const hubs = new Set([WETH, '0x0000000000000000000000000000000000000000'])

const pair = (over: Partial<DexPair>): DexPair => ({
  chainId: 'base',
  baseToken: { address: '0xaaa0000000000000000000000000000000000001', symbol: 'AAA', name: 'Token A' },
  quoteToken: { address: WETH, symbol: 'WETH' },
  liquidity: { usd: 1_000_000, quote: 10 }, // 10 WETH real
  volume: { h24: 5_000 },
  priceUsd: '2', // base price 2 USD…
  priceNative: '0.001', // …= 0.001 WETH → WETH ≈ $2000
  ...over,
})

describe('aggregatePairs — anti-impostor aggregation', () => {
  it('counts ONLY quote-side USD + volume on ETH-quoted pairs; ignores reported liquidity.usd', () => {
    const into = new Map<string, Agg>()
    aggregatePairs([pair({})], 'base', hubs, into)
    const agg = [...into.values()][0]
    expect(agg.liquidityUsd).toBeCloseTo(10 * 2000) // 10 WETH × $2000, NOT the claimed $1M
    expect(agg.volumeH24Usd).toBe(5_000)
  })

  it('non-ETH-quoted pairs contribute no liquidity/volume (mcap claim still kept)', () => {
    const into = new Map<string, Agg>()
    aggregatePairs(
      [pair({ quoteToken: { address: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead', symbol: 'USDC' }, marketCap: 7 })],
      'base',
      hubs,
      into,
    )
    const agg = [...into.values()][0]
    expect(agg.liquidityUsd).toBe(0)
    expect(agg.volumeH24Usd).toBe(0)
    expect(agg.marketCapUsd).toBe(7)
  })

  it('caps processing at 500 pairs per response (hostile payloads degrade, never hang)', () => {
    const flood: DexPair[] = Array.from({ length: 10_000 }, (_, i) =>
      pair({ baseToken: { address: `0x${(i + 1).toString(16).padStart(40, '0')}`, symbol: `T${i}`, name: `T${i}` } }),
    )
    const into = new Map<string, Agg>()
    aggregatePairs(flood, 'base', hubs, into)
    expect(into.size).toBe(500)
  })

  it('drops wrong-chain pairs', () => {
    const into = new Map<string, Agg>()
    aggregatePairs([pair({ chainId: 'ethereum' })], 'base', hubs, into)
    expect(into.size).toBe(0)
  })
})
