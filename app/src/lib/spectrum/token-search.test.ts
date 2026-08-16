import { describe, expect, it } from 'vitest'
import { aggregatePairs, mergeCrossChainHits, type Agg, type DexPair, type TokenHit } from './token-search'

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

describe('mergeCrossChainHits (the PONS law: highest mcap on the relevant chain first)', () => {
  const hit = (symbol: string, chainId: number, mcap: number, liq: number, verified = false) => ({
    h: {
      address: `0x${symbol.toLowerCase()}${chainId}`.padEnd(42, '0'),
      symbol,
      name: symbol,
      liquidityUsd: liq,
      marketCapUsd: mcap,
      volumeH24Usd: 0,
      verified,
    } as TokenHit,
    chainId,
  })

  it('the canonical chain wins its symbol: real mcap + real liquidity beats smaller listings', () => {
    const out = mergeCrossChainHits([hit('PONS', 1, 40_000, 250_000), hit('PONS', 4663, 20_600_000, 556_000)], 'PONS', 6)
    expect(out).toHaveLength(1)
    expect(out[0].chainId).toBe(4663)
  })

  it('a FAKE mcap with dust liquidity cannot take the slot (the live ETH Pons impostor)', () => {
    // found live: an ETH pair claiming $28.5M mcap off ~$1 of real reserve;
    // mcap only counts when quote-side liquidity corroborates it
    const out = mergeCrossChainHits([hit('PONS', 1, 28_500_000, 1), hit('PONS', 4663, 20_600_000, 556_000)], 'PONS', 6)
    expect(out[0].chainId).toBe(4663)
  })

  it('with no credible candidate, raw mcap still ranks depthless rungs (Blockscout rows)', () => {
    const out = mergeCrossChainHits([hit('X', 1, 1_000, 0), hit('X', 4663, 9_000_000, 0)], 'X', 6)
    expect(out[0].chainId).toBe(4663)
  })

  it('an exact symbol match pins above bigger unrelated tokens', () => {
    const out = mergeCrossChainHits(
      [hit('PONSTAR', 4663, 50_000_000, 100_000), hit('PONS', 4663, 2_000_000, 5_000)],
      'PONS',
      6,
    )
    expect(out[0].h.symbol).toBe('PONS')
  })

  it('a HOUSE-PINNED identity wins its symbol over a fatter VERIFIED listing elsewhere, and tops the list (the PRISM order, 2026-08-15)', () => {
    const pinned = hit('PRISM', 1, 0, 0)
    pinned.h.housePinned = true
    const out = mergeCrossChainHits(
      [hit('PRISMX', 8453, 50_000_000, 100_000), hit('PRISM', 8453, 20_000_000, 500_000, true), pinned],
      'PRISM',
      6,
    )
    // wins the PRISM symbol against verified+mcap+liquidity, AND ranks first
    // overall — "always show this prism first".
    expect(out[0].chainId).toBe(1)
    expect(out[0].h.housePinned).toBe(true)
    expect(out.filter((r) => r.h.symbol === 'PRISM')).toHaveLength(1)
  })

  it('verified identity wins its symbol regardless of reported mcap', () => {
    const out = mergeCrossChainHits([hit('UNI', 8453, 900_000_000_000, 10), hit('UNI', 1, 5_000_000_000, 80_000_000, true)], 'UNI', 6)
    expect(out[0].chainId).toBe(1)
    expect(out[0].h.verified).toBe(true)
  })

  it('liquidity stays the tiebreak when mcaps are unknown', () => {
    const out = mergeCrossChainHits([hit('X', 1, 0, 10_000), hit('X', 8453, 0, 90_000)], 'X', 6)
    expect(out[0].chainId).toBe(8453)
  })
})

describe('merge dust floor (a $0.58 pool is not depth)', () => {
  const hit = (symbol: string, chainId: number, mcap: number, liq: number) => ({
    h: {
      address: `0x${symbol.toLowerCase()}${chainId}`.padEnd(42, '0'),
      symbol,
      name: symbol,
      liquidityUsd: liq,
      marketCapUsd: mcap,
      volumeH24Usd: 0,
      verified: false,
    } as TokenHit,
    chainId,
  })

  it('dust liquidity does not outrank a depthless rung with real mcap', () => {
    // FONZ on RH: $9 of WETH vs a Blockscout row carrying mcap but liq 0
    const out = mergeCrossChainHits([hit('FONZ', 1, 0, 9), hit('FONZ', 4663, 142_000, 0)], 'FONZ', 6)
    expect(out[0].chainId).toBe(4663)
  })

  it('real (non-dust) liquidity still wins over raw mcap claims', () => {
    const out = mergeCrossChainHits([hit('Y', 1, 0, 40_000), hit('Y', 4663, 9_000_000, 0)], 'Y', 6)
    expect(out[0].chainId).toBe(1)
  })
})
