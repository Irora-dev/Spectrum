import { describe, expect, it } from 'vitest'
import { buildCreatorProfile } from './hooks'
import type { BasketSummary } from './basket-data'

// Minimal BasketSummary factory — only the fields buildCreatorProfile reads.
function b(partial: Partial<BasketSummary> & { address: string; deployer: string | null }): BasketSummary {
  return {
    chainId: 8453,
    name: partial.address,
    symbol: 'SYM',
    basketLength: 1,
    navPerToken: 1,
    aumUsd: 0,
    change24hPct: null,
    pricedCount: 0,
    top: [],
    navSeries: [],
    supersededBy: null,
    ...partial,
  }
}

const ME = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa'
const OTHER = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb'

describe('buildCreatorProfile', () => {
  it('keeps only current versions in baskets, counts all versions in totalVersions', () => {
    const all = [
      b({ address: '0x01', deployer: ME, supersededBy: '0x02', aumUsd: 100 }), // V1 (superseded)
      b({ address: '0x02', deployer: ME, aumUsd: 200 }), // V2 (current head)
      b({ address: '0x03', deployer: ME, aumUsd: 50 }), // standalone (current)
      b({ address: '0x99', deployer: OTHER, aumUsd: 999 }), // someone else
    ]
    const p = buildCreatorProfile(ME, all)
    expect(p.basketCount).toBe(2) // 0x02 + 0x03
    expect(p.totalVersions).toBe(3) // 0x01 + 0x02 + 0x03
    expect(p.baskets.map((x) => x.address).sort()).toEqual(['0x02', '0x03'])
    // TVL sums CURRENT versions only (superseded 0x01's AUM excluded).
    expect(p.totalAumUsd).toBe(250)
  })

  it('counts a multi-version chain as one series; standalones are not series', () => {
    const all = [
      b({ address: '0x01', deployer: ME, supersededBy: '0x02' }),
      b({ address: '0x02', deployer: ME, supersededBy: '0x03' }),
      b({ address: '0x03', deployer: ME }), // head of a 3-version series
      b({ address: '0x10', deployer: ME }), // standalone
    ]
    expect(buildCreatorProfile(ME, all).seriesCount).toBe(1)
  })

  it('counts two independent chains as two series', () => {
    const all = [
      b({ address: '0x01', deployer: ME, supersededBy: '0x02' }),
      b({ address: '0x02', deployer: ME }),
      b({ address: '0x03', deployer: ME, supersededBy: '0x04' }),
      b({ address: '0x04', deployer: ME }),
    ]
    expect(buildCreatorProfile(ME, all).seriesCount).toBe(2)
  })

  it('never merges a chain across a different deployer (spoof guard)', () => {
    // 0x01 (ME) claims to be superseded by 0x02 (OTHER) — a cross-deployer claim.
    // It must NOT form a series for ME: 0x02 is not ME's basket.
    const all = [
      b({ address: '0x01', deployer: ME, supersededBy: '0x02' }),
      b({ address: '0x02', deployer: OTHER }),
    ]
    const p = buildCreatorProfile(ME, all)
    expect(p.seriesCount).toBe(0)
    expect(p.basketCount).toBe(0) // 0x01 is superseded, 0x02 isn't ME's
    expect(p.totalVersions).toBe(1) // only 0x01 is ME's
  })

  it('empty when the address deployed nothing', () => {
    const p = buildCreatorProfile(ME, [b({ address: '0x99', deployer: OTHER })])
    expect(p.basketCount).toBe(0)
    expect(p.totalVersions).toBe(0)
    expect(p.seriesCount).toBe(0)
    expect(p.chains).toEqual([])
  })
})
