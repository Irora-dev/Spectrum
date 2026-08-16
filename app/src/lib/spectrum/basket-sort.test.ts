import { describe, expect, it } from 'vitest'
import {
  BASKET_ORDER_IDS,
  filterByMinTvl,
  hasLaunchTimes,
  hasReturns,
  launchTimeLookup,
  orderBaskets,
  parseLaunchIndex,
  returnsToDate,
  tvlStepLabel,
  tvlStepsFor,
  tvlStepTitle,
  type SortableBasket,
} from './basket-sort'

// Explore's sort control (QOL round 2026-08-05). The laws under test: unknown is
// not zero (it sorts to the END), the page's own ranking survives as both the
// default option and the tie-break, and the age axis never invents a launch time.
const b = (address: string, aumUsd?: number | null, holdersCount?: number | null): SortableBasket => ({
  chainId: 8453,
  address,
  aumUsd,
  holdersCount,
})
const ids = (list: readonly SortableBasket[]) => list.map((x) => x.address)

describe("'top' hands back the page's ranking", () => {
  it('never reorders (rankBaskets already ran)', () => {
    const list = [b('a', 1), b('b', 900), b('c', 50)]
    expect(ids(orderBaskets(list, 'top'))).toEqual(['a', 'b', 'c'])
  })

  it('copies rather than sorting the caller of a memoized list in place', () => {
    const list = [b('a', 1), b('b', 900)]
    expect(orderBaskets(list, 'tvl')).not.toBe(list)
    expect(ids(list)).toEqual(['a', 'b'])
  })

  it('is what an unrecognised order falls back to', () => {
    const list = [b('a', 1), b('b', 900)]
    expect(ids(orderBaskets(list, 'nonsense' as 'top'))).toEqual(['a', 'b'])
  })
})

describe('value (TVL)', () => {
  it('orders biggest first', () => {
    expect(ids(orderBaskets([b('a', 10), b('b', 9_000), b('c', 500)], 'tvl'))).toEqual(['b', 'c', 'a'])
  })

  it('sorts an unknown value to the END, and a known zero among the numbers', () => {
    const list = [b('unknown', null), b('small', 5), b('zero', 0), b('big', 100), b('absent', undefined)]
    expect(ids(orderBaskets(list, 'tvl'))).toEqual(['big', 'small', 'zero', 'unknown', 'absent'])
  })

  it('treats a broken read as unknown, never as a huge number', () => {
    const list = [b('nan', Number.NaN), b('inf', Number.POSITIVE_INFINITY), b('real', 7)]
    expect(ids(orderBaskets(list, 'tvl'))).toEqual(['real', 'nan', 'inf'])
  })
})

describe('holders', () => {
  it('orders most-held first', () => {
    const list = [b('a', 1, 4), b('b', 1, 900), b('c', 1, 40)]
    expect(ids(orderBaskets(list, 'holders'))).toEqual(['b', 'c', 'a'])
  })

  it('is not a basket with no holders when the count is absent', () => {
    // the chain path leaves holdersCount undefined — those go last, ahead of nobody
    const list = [b('unindexed', 5_000, null), b('one', 1, 1), b('none', 1, 0)]
    expect(ids(orderBaskets(list, 'holders'))).toEqual(['one', 'none', 'unindexed'])
  })

  it('keeps the incoming ranking among equally unknown baskets', () => {
    const list = [b('first', 1, null), b('second', 900, undefined), b('third', 50, null)]
    expect(ids(orderBaskets(list, 'holders'))).toEqual(['first', 'second', 'third'])
  })
})

describe('returns (since launch — the owner 2026-08-13)', () => {
  // NAV−1 against the ~$1.00 launch convention; the honesty gates are the
  // measurable floor (the "+40,000%" dust catch, 2026-07-06) and unreadable≠zero.
  const r = (address: string, aumUsd?: number | null, navPerToken?: number | null): SortableBasket => ({
    chainId: 8453,
    address,
    aumUsd,
    navPerToken,
  })

  it('orders best since-launch return first', () => {
    const list = [r('flat', 5_000, 1.0), r('up', 5_000, 1.42), r('down', 5_000, 0.88)]
    expect(ids(orderBaskets(list, 'returns'))).toEqual(['up', 'flat', 'down'])
  })

  it('sinks a dust basket to the END, however loud its arithmetic "perf"', () => {
    // the $0.40 pool showing +40,000% — a figure, not a performance
    const list = [r('dust', 0.4, 401), r('real', 5_000, 1.05), r('modest', 2_000, 1.01)]
    expect(ids(orderBaskets(list, 'returns'))).toEqual(['real', 'modest', 'dust'])
    expect(returnsToDate(list[0])).toBeNull()
  })

  it('holds the $1,000 measurable floor exactly where leaderboard.ts does', () => {
    expect(returnsToDate(r('at-floor', 1_000, 1.2))).toBeCloseTo(0.2)
    expect(returnsToDate(r('under', 999.99, 1.2))).toBeNull()
  })

  it('sorts an unreadable NAV to the END — never a 0%, never a −100%', () => {
    const list = [r('absent', 5_000, undefined), r('zero-nav', 5_000, 0), r('loser', 5_000, 0.6), r('nil', 5_000, null)]
    // 'loser' has a real −40% and still outranks every unreadable, because
    // unreadable is not a measured loss
    expect(ids(orderBaskets(list, 'returns'))).toEqual(['loser', 'absent', 'zero-nav', 'nil'])
  })

  it('treats a broken read as unknown, never as a huge number', () => {
    const list = [r('nan', 5_000, Number.NaN), r('inf', 5_000, Number.POSITIVE_INFINITY), r('real', 5_000, 1.1)]
    expect(ids(orderBaskets(list, 'returns'))).toEqual(['real', 'nan', 'inf'])
  })

  it('keeps the incoming ranking among equal returns and among the figureless tail', () => {
    const list = [r('a', 5_000, 1.1), r('b', 9_000, 1.1), r('x', 3), r('y', 8), r('z', 1)]
    expect(ids(orderBaskets(list, 'returns'))).toEqual(['a', 'b', 'x', 'y', 'z'])
  })

  it('needs two honest figures before the option means anything (hasReturns)', () => {
    expect(hasReturns([r('one', 5_000, 1.2)])).toBe(false)
    expect(hasReturns([r('one', 5_000, 1.2), r('dust', 3, 90)])).toBe(false)
    expect(hasReturns([r('one', 5_000, 1.2), r('two', 2_000, 0.9)])).toBe(true)
  })
})

describe('newest', () => {
  const age = (m: Record<string, number>) => (x: SortableBasket) => m[x.address] ?? null

  it('orders the most recently launched first', () => {
    const list = [b('old'), b('new'), b('mid')]
    expect(ids(orderBaskets(list, 'newest', age({ old: 1_000, mid: 5_000, new: 9_000 })))).toEqual([
      'new',
      'mid',
      'old',
    ])
  })

  it('sorts an unknown launch to the END rather than to the beginning of time', () => {
    const list = [b('unknown'), b('known')]
    expect(ids(orderBaskets(list, 'newest', age({ known: 5_000 })))).toEqual(['known', 'unknown'])
  })

  it("keeps the page's order when no lookup is supplied at all", () => {
    const list = [b('a'), b('b'), b('c')]
    expect(ids(orderBaskets(list, 'newest'))).toEqual(['a', 'b', 'c'])
  })
})

describe('parseLaunchIndex', () => {
  it('reads the persisted shape', () => {
    const m = parseLaunchIndex({ upToBlock: '123', entries: { '0xAbC': 1_700_000_000 } })
    expect(m.get('0xabc')).toBe(1_700_000_000)
  })

  it('yields nothing for an absent, foreign or hostile blob', () => {
    for (const raw of [null, undefined, 7, 'launched', [], { entries: null }, { entries: [] }, {}]) {
      expect(parseLaunchIndex(raw).size).toBe(0)
    }
  })

  it('drops entries that are not real timestamps', () => {
    const m = parseLaunchIndex({
      entries: { good: 1_700_000_000, zero: 0, neg: -1, str: '1700000000', nan: Number.NaN, nil: null },
    })
    expect([...m.keys()]).toEqual(['good'])
  })
})

describe('launchTimeLookup / hasLaunchTimes', () => {
  const store: Record<string, unknown> = {
    'launch-index:v2:8453': { entries: { '0xa': 3_000, '0xb': 1_000 } },
    'launch-index:v2:1': { entries: { '0xc': 2_000 } },
  }
  const read = (key: string) => store[key] ?? null

  it('answers per chain, so one chain cannot date another chain basket', () => {
    const at = launchTimeLookup([1, 8453], read)
    expect(at({ chainId: 8453, address: '0xA' })).toBe(3_000)
    expect(at({ chainId: 1, address: '0xa' })).toBeNull()
    expect(at({ chainId: 1, address: '0xc' })).toBe(2_000)
    expect(at({ chainId: 999, address: '0xa' })).toBeNull()
  })

  it('orders a cross-chain page by real launch times', () => {
    const at = launchTimeLookup([1, 8453], read)
    const list = [
      { chainId: 8453, address: '0xb' },
      { chainId: 1, address: '0xc' },
      { chainId: 8453, address: '0xa' },
      { chainId: 8453, address: '0xz' },
    ]
    expect(orderBaskets(list, 'newest', at).map((x) => x.address)).toEqual(['0xa', '0xc', '0xb', '0xz'])
  })

  it('knows nothing when the index was never built (the pill stays hidden)', () => {
    const at = launchTimeLookup([8453], () => null)
    expect(at({ chainId: 8453, address: '0xa' })).toBeNull()
    expect(hasLaunchTimes([{ chainId: 8453, address: '0xa' }], at)).toBe(false)
  })

  it('needs two known launches before an age order means anything', () => {
    const at = launchTimeLookup([8453], read)
    expect(hasLaunchTimes([{ chainId: 8453, address: '0xa' }], at)).toBe(false)
    expect(
      hasLaunchTimes(
        [
          { chainId: 8453, address: '0xa' },
          { chainId: 8453, address: '0xb' },
        ],
        at,
      ),
    ).toBe(true)
  })
})

describe('the pill list', () => {
  it("keeps the page's own ranking as the default option", () => {
    expect(BASKET_ORDER_IDS[0]).toBe('top')
    expect([...BASKET_ORDER_IDS]).toEqual(['top', 'returns', 'tvl', 'holders', 'newest'])
  })
})

describe('the TVL threshold (the owner 2026-08-13)', () => {
  it('offers only rungs that are satisfiable AND discriminating', () => {
    // 42k–1.2M catalogue: $100/$1k/$10k filter nothing (everyone clears),
    // $100k and $1M genuinely split it, nothing sits above 1.2M
    const list = [b('s', 42_000), b('m', 96_000), b('l', 640_000), b('xl', 1_240_000)]
    expect(tvlStepsFor(list)).toEqual([100_000, 1_000_000])
  })

  it('offers the small rungs on a small catalogue', () => {
    const list = [b('dust', 12), b('small', 480), b('real', 2_600)]
    expect(tvlStepsFor(list)).toEqual([100, 1_000])
  })

  it('offers nothing when no rung can both match and filter', () => {
    expect(tvlStepsFor([])).toEqual([])
    expect(tvlStepsFor([b('a', 5), b('b', 8)])).toEqual([]) // nobody clears even $100
    // both clear $100 (not discriminating) and neither clears $1k (would empty
    // the grid) — a catalogue this uniform gets no threshold control at all
    expect(tvlStepsFor([b('a', 500), b('b', 700)])).toEqual([])
  })

  it('an unreadable TVL counts as a miss, so a rung everyone else clears is still offered', () => {
    expect(tvlStepsFor([b('known', 5_000), b('mystery', null)])).toEqual([100, 1_000])
  })

  it('filters at-or-above, excluding unreadable values under any threshold', () => {
    const list = [b('big', 120_000), b('exact', 100_000), b('small', 900), b('mystery', null), b('absent', undefined)]
    expect(ids(filterByMinTvl(list, 100_000))).toEqual(['big', 'exact'])
    expect(ids(filterByMinTvl(list, 1_000))).toEqual(['big', 'exact'])
  })

  it('spells every rung compactly, one label for every surface', () => {
    // compact is load-bearing: the grouped form measurably wrapped Explore's
    // one-row band when a rung went active (the full figure rides title/aria)
    expect([100, 1_000, 10_000, 100_000, 1_000_000].map(tvlStepLabel)).toEqual([
      '$100+',
      '$1k+',
      '$10k+',
      '$100k+',
      '$1M+',
    ])
    expect(tvlStepTitle(100_000)).toBe('at least $100,000 TVL')
  })

  it('"Any" keeps everything — unreadable included — and always hands back a copy', () => {
    const list = [b('a', 5), b('mystery', null)]
    const out = filterByMinTvl(list, 0)
    expect(ids(out)).toEqual(['a', 'mystery'])
    expect(out).not.toBe(list)
  })

  it('composes with the orders: filter first, the order still holds its laws', () => {
    const list = [b('dusty', 40), b('big-flat', 50_000), b('mid-up', 9_000)]
    const withNav = list.map((x, i) => ({ ...x, navPerToken: [12, 1.0, 1.3][i] }))
    expect(ids(orderBaskets(filterByMinTvl(withNav, 1_000), 'returns'))).toEqual(['mid-up', 'big-flat'])
  })
})
