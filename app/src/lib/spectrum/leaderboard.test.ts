import { describe, expect, it } from 'vitest'
import {
  buildCreatorLeaderboard,
  rankBaskets,
  countVersionSeries,
  perfToDate,
  versionChain,
  basketHasAsset,
  collectAssets,
  perfMeasurable,
  MEASURABLE_TVL_FLOOR_USD,
  listable,
  LISTING_TVL_FLOOR_USD,
} from './leaderboard'
import type { BasketSummary } from './basket-data'

function b(p: Partial<BasketSummary> & { address: string; deployer: string | null }): BasketSummary {
  return {
    chainId: 8453,
    name: p.address,
    symbol: 'SYM',
    basketLength: 1,
    navPerToken: 1,
    aumUsd: 0,
    change24hPct: null,
    pricedCount: 0,
    top: [],
    navSeries: [],
    supersededBy: null,
    ...p,
  }
}

const A = '0xAAaa000000000000000000000000000000000001'
const B = '0xBBbb000000000000000000000000000000000002'

describe('buildCreatorLeaderboard', () => {
  it('groups by deployer, ranks by combined TVL desc, excludes superseded from TVL', () => {
    const all = [
      b({ address: '0x01', deployer: A, aumUsd: 100 }),
      b({ address: '0x02', deployer: A, aumUsd: 300, supersededBy: '0x03' }), // superseded → excluded
      b({ address: '0x03', deployer: A, aumUsd: 50 }),
      b({ address: '0x10', deployer: B, aumUsd: 400 }),
    ]
    const lb = buildCreatorLeaderboard(all)
    expect(lb.map((c) => c.address)).toEqual([B, A]) // B(400) > A(100+50=150)
    const a = lb.find((c) => c.address === A)!
    expect(a.combinedTvl).toBe(150)
    expect(a.basketCount).toBe(2) // 0x01 + 0x03
    expect(a.totalVersions).toBe(3)
    expect(a.seriesCount).toBe(1) // 0x02→0x03 chain
  })

  it('drops creators whose baskets are all superseded (no live presence)', () => {
    const all = [
      b({ address: '0x01', deployer: A, supersededBy: '0x02' }),
      b({ address: '0x02', deployer: A, supersededBy: '0x03' }),
      // note: 0x03 belongs to B, so A has no current basket
      b({ address: '0x03', deployer: B, aumUsd: 10 }),
    ]
    const lb = buildCreatorLeaderboard(all)
    expect(lb.map((c) => c.address)).toEqual([B])
  })

  it('holdersTotal sums current baskets when indexed, else null', () => {
    const withHolders = [
      b({ address: '0x01', deployer: A, aumUsd: 10, holdersCount: 100 }),
      b({ address: '0x02', deployer: A, aumUsd: 20, holdersCount: 55 }),
    ]
    expect(buildCreatorLeaderboard(withHolders)[0].holdersTotal).toBe(155)
    // No holder data indexed → null (not 0), so the UI can hide it honestly.
    const noHolders = [b({ address: '0x10', deployer: B, aumUsd: 5 })]
    expect(buildCreatorLeaderboard(noHolders)[0].holdersTotal).toBeNull()
  })

  it('best24hPct is the max across current baskets; null when none priced', () => {
    const all = [
      b({ address: '0x01', deployer: A, aumUsd: 10, change24hPct: 1.2 }),
      b({ address: '0x02', deployer: A, aumUsd: 20, change24hPct: 4.8 }),
      b({ address: '0x10', deployer: B, aumUsd: 5, change24hPct: null }),
    ]
    const lb = buildCreatorLeaderboard(all)
    expect(lb.find((c) => c.address === A)!.best24hPct).toBe(4.8)
    expect(lb.find((c) => c.address === B)!.best24hPct).toBeNull()
  })

  it('topBasket is the creator’s largest current basket', () => {
    const all = [
      b({ address: '0x01', deployer: A, aumUsd: 10 }),
      b({ address: '0x02', deployer: A, aumUsd: 90 }),
    ]
    expect(buildCreatorLeaderboard(all)[0].topBasket.address).toBe('0x02')
  })

  it('bestBasket is the highest NAV-to-date (not the largest); carries its version chain', () => {
    const all = [
      b({ address: '0x01', deployer: A, aumUsd: 900, navPerToken: 1.02, supersededBy: '0x02' }),
      b({ address: '0x02', deployer: A, aumUsd: 900, navPerToken: 1.05 }), // v2 of 0x01, current
      b({ address: '0x03', deployer: A, aumUsd: 10, navPerToken: 1.4 }), // small but best performer
    ]
    const c = buildCreatorLeaderboard(all)[0]
    expect(c.bestBasket.address).toBe('0x03')
    expect(c.topBasket.address).toBe('0x02') // largest current by AUM
    // 0x03 is standalone → its chain is just itself
    expect(c.bestVersionChain.map((x) => x.address)).toEqual(['0x03'])
  })
})

describe('perfToDate', () => {
  it('is NAV minus the $1.00 launch convention, as a fraction', () => {
    expect(perfToDate(b({ address: '0x1', deployer: A, navPerToken: 1.25 }))).toBeCloseTo(0.25)
    expect(perfToDate(b({ address: '0x2', deployer: A, navPerToken: 0.9 }))).toBeCloseTo(-0.1)
  })
})

describe('versionChain', () => {
  const mine = [
    b({ address: '0x01', deployer: A, supersededBy: '0x02' }),
    b({ address: '0x02', deployer: A, supersededBy: '0x03' }),
    b({ address: '0x03', deployer: A }),
    b({ address: '0x10', deployer: A }), // standalone
  ]
  it('returns the ordered chain root→head from any member', () => {
    expect(versionChain('0x02', mine).map((x) => x.address)).toEqual(['0x01', '0x02', '0x03'])
    expect(versionChain('0x01', mine).map((x) => x.address)).toEqual(['0x01', '0x02', '0x03'])
  })
  it('a standalone basket is a chain of one', () => {
    expect(versionChain('0x10', mine).map((x) => x.address)).toEqual(['0x10'])
  })
  it('returns [] for a basket not in the set', () => {
    expect(versionChain('0xzz', mine)).toEqual([])
  })

  it('ignores baskets with no deployer', () => {
    expect(buildCreatorLeaderboard([b({ address: '0x01', deployer: null, aumUsd: 99 })])).toEqual([])
  })
})

describe('rankBaskets', () => {
  const all = [
    b({ address: '0x01', deployer: A, aumUsd: 100, change24hPct: 1, chainId: 8453 }),
    b({ address: '0x02', deployer: A, aumUsd: 500, change24hPct: -2, chainId: 1 }),
    b({ address: '0x03', deployer: B, aumUsd: 50, change24hPct: 9, supersededBy: '0x01' }),
  ]
  it('defaults to current-only, TVL desc', () => {
    expect(rankBaskets(all).map((x) => x.address)).toEqual(['0x02', '0x01'])
  })
  it('sort by change surfaces movers among current baskets', () => {
    expect(rankBaskets(all, { sort: 'change' }).map((x) => x.address)).toEqual(['0x01', '0x02'])
  })
  it('chain + minTvl filters apply', () => {
    expect(rankBaskets(all, { chain: 1 }).map((x) => x.address)).toEqual(['0x02'])
    expect(rankBaskets(all, { minTvl: 200 }).map((x) => x.address)).toEqual(['0x02'])
  })
  it('currentOnly:false includes superseded', () => {
    expect(rankBaskets(all, { currentOnly: false }).length).toBe(3)
  })
  it('sort by perf ranks by NAV-to-date', () => {
    const byPerf = rankBaskets(
      [
        // above the measurability floor — perf ordering only applies to REAL baskets
        b({ address: '0x1', deployer: A, navPerToken: 1.05, aumUsd: 50_000 }),
        b({ address: '0x2', deployer: A, navPerToken: 1.4, aumUsd: 50_000 }),
        b({ address: '0x3', deployer: A, navPerToken: 0.9, aumUsd: 50_000 }),
      ],
      { sort: 'perf' },
    )
    expect(byPerf.map((x) => x.address)).toEqual(['0x2', '0x1', '0x3'])
  })
  it('asset filter keeps only baskets holding that asset', () => {
    const WETH = '0xWeth', DEGEN = '0xDegen'
    const list = [
      b({ address: '0x1', deployer: A, aumUsd: 10, top: [{ address: WETH, symbol: 'WETH', weightPct: 100 }] }),
      b({ address: '0x2', deployer: A, aumUsd: 20, top: [{ address: DEGEN, symbol: 'DEGEN', weightPct: 100 }] }),
    ]
    expect(rankBaskets(list, { asset: WETH }).map((x) => x.address)).toEqual(['0x1'])
  })
  it('weighted sort blends TVL rank with perf rank (rank-sum); good-at-both beats best-at-one', () => {
    const ranked = rankBaskets(
      [
        b({ address: '0xbig', deployer: A, navPerToken: 1.0, aumUsd: 900_000 }), // tvl 0 + perf 3 = 3
        b({ address: '0xmid', deployer: A, navPerToken: 1.4, aumUsd: 100_000 }), // tvl 1 + perf 1 = 2 ← wins
        b({ address: '0xflat', deployer: A, navPerToken: 1.05, aumUsd: 50_000 }), // tvl 2 + perf 2 = 4
        b({ address: '0xhot', deployer: A, navPerToken: 1.5, aumUsd: 20_000 }), // tvl 3 + perf 0 = 3
      ],
      { sort: 'weighted' },
    )
    // big ties hot at 3 → TVL desc breaks it
    expect(ranked.map((x) => x.address)).toEqual(['0xmid', '0xbig', '0xhot', '0xflat'])
  })
  it('weighted sort sinks dust below every measurable basket, whatever its arithmetic perf', () => {
    const ranked = rankBaskets(
      [
        b({ address: '0xd', deployer: A, navPerToken: 404, aumUsd: 0.4 }), // "+40,300%" dust
        b({ address: '0xr', deployer: A, navPerToken: 1.1, aumUsd: 5_000 }),
      ],
      { sort: 'weighted' },
    )
    expect(ranked.map((x) => x.address)).toEqual(['0xr', '0xd'])
  })
})

describe('basketHasAsset / collectAssets', () => {
  const WETH = '0xWeth', DEGEN = '0xDegen'
  const list = [
    b({ address: '0x1', deployer: 'A', top: [{ address: WETH, symbol: 'WETH', weightPct: 60 }, { address: DEGEN, symbol: 'DEGEN', weightPct: 40 }] }),
    b({ address: '0x2', deployer: 'A', top: [{ address: WETH, symbol: 'WETH', weightPct: 100 }] }),
  ]
  it('basketHasAsset matches case-insensitively', () => {
    expect(basketHasAsset(list[0], WETH.toUpperCase())).toBe(true)
    expect(basketHasAsset(list[1], DEGEN)).toBe(false)
  })
  it('collectAssets dedupes by address, counts, orders most-held first', () => {
    const assets = collectAssets(list)
    expect(assets.map((a) => a.symbol)).toEqual(['WETH', 'DEGEN']) // WETH in 2, DEGEN in 1
    expect(assets[0].count).toBe(2)
    expect(assets[1].count).toBe(1)
  })
})

describe('countVersionSeries (shared)', () => {
  it('counts a 3-version chain as one series', () => {
    const mine = [
      b({ address: '0x01', deployer: A, supersededBy: '0x02' }),
      b({ address: '0x02', deployer: A, supersededBy: '0x03' }),
      b({ address: '0x03', deployer: A }),
    ]
    expect(countVersionSeries(mine)).toBe(1)
  })
})

describe('listable — the $100 browse floor (R+C 2026-07-06)', () => {
  it('hides sub-$100 baskets from browsing surfaces, keeps $100+ listed', () => {
    expect(listable(b({ address: '0x1', deployer: A, aumUsd: 40 }))).toBe(false)
    expect(listable(b({ address: '0x2', deployer: A, aumUsd: 100 }))).toBe(true)
    expect(LISTING_TVL_FLOOR_USD).toBeLessThan(MEASURABLE_TVL_FLOOR_USD)
  })
})

describe('perfMeasurable — the dust-basket floor (owner catch 2026-07-06)', () => {
  const dust = { aumUsd: 0.4, navPerToken: 404, supersededBy: null } as never
  const real = { aumUsd: 50_000, navPerToken: 1.2, supersededBy: null } as never
  it('a near-empty basket is not a performance claim', () => {
    expect(perfMeasurable(dust)).toBe(false)
    expect(perfMeasurable(real)).toBe(true)
    expect(MEASURABLE_TVL_FLOOR_USD).toBeGreaterThan(0)
  })
  it('perf sort SINKS dust below every measurable basket (spotlight can never be won by residue arithmetic)', () => {
    const ranked = rankBaskets(
      [
        b({ address: '0xd', deployer: A, navPerToken: 404, aumUsd: 0.4 }), // the $0.40 dust pool
        b({ address: '0xr', deployer: A, navPerToken: 1.2, aumUsd: 50_000 }),
      ],
      { sort: 'perf' },
    )
    expect(ranked.map((x) => x.address)).toEqual(['0xr', '0xd'])
  })
})
