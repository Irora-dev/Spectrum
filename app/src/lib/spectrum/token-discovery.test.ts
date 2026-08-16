import { afterEach, describe, expect, it, vi } from 'vitest'
import { priceDiscovered } from './token-discovery'

// THE SHALLOW-POOL FLOOR (live repro 2026-08-12): airdropped scam tokens carry
// self-made ghost pools whose "price" is arbitrary — one such print valued a
// real wallet at $620 TRILLION on Robinhood Chain. Below the liquidity floor
// even the deepest pool is not a market: the token stays UNPRICED and visible
// (the module's own honesty law), never priced off noise.

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = '0xcccccccccccccccccccccccccccccccccccccccc'

function stubDexScreener(pairs: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => pairs })),
  )
}

describe('priceDiscovered (the ghost-pool floor)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('prices off the deepest pool and refuses prints below the liquidity floor', async () => {
    stubDexScreener([
      // A: one real market + one absurd ghost — the deep pool's print wins
      { baseToken: { address: A }, priceUsd: '2.0', liquidity: { usd: 50_000 } },
      { baseToken: { address: A }, priceUsd: '999999', liquidity: { usd: 12 } },
      // B: ONLY a ghost pool (the $620T mechanism) — stays unpriced
      { baseToken: { address: B }, priceUsd: '3900000000000', liquidity: { usd: 6 } },
      // C: a price with no liquidity fact at all — noise, stays unpriced
      { baseToken: { address: C }, priceUsd: '5' },
    ])
    const out = await priceDiscovered('robinhood', [A, B, C])
    expect(out.get(A)).toBe(2.0)
    expect(out.has(B)).toBe(false)
    expect(out.has(C)).toBe(false)
  })

  it('a pool exactly at the floor still counts (the floor gates noise, not new tokens)', async () => {
    stubDexScreener([{ baseToken: { address: A }, priceUsd: '0.5', liquidity: { usd: 1_000 } }])
    const out = await priceDiscovered('base', [A])
    expect(out.get(A)).toBe(0.5)
  })

  it('a failed batch stays unpriced, never zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => [] })))
    const out = await priceDiscovered('base', [A])
    expect(out.size).toBe(0)
  })
})
