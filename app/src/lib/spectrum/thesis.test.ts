import { describe, expect, it } from 'vitest'
import { DISCOVERY_TVL_FLOOR_USD, groupIntoTheses, thesisCombinedSeries, thesisIsDiscoverable, thesisNeeds, thesisOneOfEach, type Thesis } from './thesis'
import type { BasketSummary } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// A thesis is RECOGNISED, never recorded — nothing on chain says these baskets
// belong together, so the grouping is an inference and every one of its limits
// has to bite in a test rather than live in a comment. The money half matters
// more: `thesisNeeds` decides how a buyer's dollars split across chains, and a
// split that does not sum to the amount is a chain that quietly under-funds.
// ─────────────────────────────────────────────────────────────────────────────

const DEP = '0x00000000000000000000000000000000000000c0'
const T0 = 1_770_000_000_000

// launch times live OUTSIDE the basket (the page resolves them separately), so
// the fixture keeps its own map and the tests inject a resolver — writing them
// onto the basket is exactly the mistake the module's own comment records.
const LAUNCH = new Map<string, number>()
const leg = (over: Partial<BasketSummary> & { chainId: number; at?: number }): BasketSummary => {
  const { at, ...rest } = over
  const b = {
    address: `0x${over.chainId.toString(16).padStart(40, '0')}`,
    name: 'Bullish EVM',
    symbol: 'BEVM',
    deployer: DEP,
    aumUsd: 1000,
    at: T0,
    top: [],
    basketLength: 2,
    navPerToken: 1,
    change24hPct: null,
    pricedCount: 2,
    navSeries: [],
    ...rest,
  } as unknown as BasketSummary
  LAUNCH.set(`${b.chainId}:${b.address}`, at ?? T0)
  return b
}
const at = (b: BasketSummary) => LAUNCH.get(`${b.chainId}:${b.address}`) ?? null

describe('groupIntoTheses — recognising one idea across chains', () => {
  it('groups baskets sharing a deployer and a name, richest leg first', () => {
    const t = groupIntoTheses([leg({ chainId: 1, aumUsd: 500 }), leg({ chainId: 8453, aumUsd: 2000 })])
    expect(t).toHaveLength(1)
    expect(t[0].chainIds).toEqual([8453, 1])
    expect(t[0].totalAumUsd).toBe(2500)
  })

  it('treats case and spacing differences as the same product', () => {
    // a creator retyping the name on the second chain is one idea; a key that
    // says otherwise splits a thesis in half on screen
    const t = groupIntoTheses([leg({ chainId: 1, name: 'Bullish EVM' }), leg({ chainId: 8453, name: '  bullish   evm ' })])
    expect(t).toHaveLength(1)
    expect(t[0].legs).toHaveLength(2)
  })

  it('does NOT group different creators who chose the same name', () => {
    const t = groupIntoTheses([leg({ chainId: 1 }), leg({ chainId: 8453, deployer: '0x00000000000000000000000000000000000000ff' })])
    expect(t).toHaveLength(0)
  })

  it('keeps ONE leg per chain — a relaunch is not a wider thesis', () => {
    // two baskets on one chain sharing a name would double-count that chain's
    // money in the total, which is the number the page leads with
    const t = groupIntoTheses([
      leg({ chainId: 8453, aumUsd: 100, address: '0xaaa' }),
      leg({ chainId: 8453, aumUsd: 900, address: '0xbbb' }),
      leg({ chainId: 1, aumUsd: 50 }),
    ])
    expect(t[0].legs).toHaveLength(2)
    expect(t[0].totalAumUsd).toBe(950) // the richer 8453 leg, not both
  })

  it('GROUPS legs that launched seasons apart — a late join is a legitimate arrival', () => {
    // the launch window is GONE (thesis.ts header, 2026-08-10): a basket joins
    // a thesis by shipping a renamed version months later, and the old window
    // did not merely refuse the late leg — its `continue` dropped the WHOLE
    // bucket, killing the thesis from every surface the day anything joined
    const t = groupIntoTheses([leg({ chainId: 1 }), leg({ chainId: 8453, at: T0 + 40 * 24 * 3600 * 1000 })], { launchedAt: at })
    expect(t).toHaveLength(1)
    expect(t[0].legs).toHaveLength(2)
  })

  it('a YEAR apart, same name + deployer → ONE thesis, even under an explicit tight window', () => {
    // the boundary pin for the new semantics: launchWindowMs is accepted for
    // API compat and applied to NOTHING — a caller passing the tightest window
    // imaginable still gets the join grouped
    const t = groupIntoTheses(
      [leg({ chainId: 1 }), leg({ chainId: 8453, at: T0 + 365 * 24 * 3600 * 1000 })],
      { launchedAt: at, launchWindowMs: 60_000 },
    )
    expect(t).toHaveLength(1)
    expect(t[0].legs).toHaveLength(2)
    expect(t[0].chainIds).toHaveLength(2)
  })

  it('still groups legs minutes apart — one session, several wallet prompts', () => {
    const t = groupIntoTheses([leg({ chainId: 1 }), leg({ chainId: 8453, at: T0 + 9 * 60 * 1000 })], { launchedAt: at })
    expect(t).toHaveLength(1)
  })

  it('a MISSING launch time never blocks grouping — launch times feed nothing now', () => {
    // under the old window this pinned the epoch trap (null read as "56 years
    // ago"); with launch times inert it pins the stronger fact that a resolver
    // answering null for everything changes nothing at all
    const t = groupIntoTheses([leg({ chainId: 1, at: undefined }), leg({ chainId: 8453 })], { launchedAt: () => null })
    expect(t).toHaveLength(1)
  })

  it('drops single-chain baskets by default, and keeps them when asked', () => {
    expect(groupIntoTheses([leg({ chainId: 8453 })])).toHaveLength(0)
    expect(groupIntoTheses([leg({ chainId: 8453 })], { includeSingles: true })).toHaveLength(1)
  })

  it('ignores baskets with no deployer or no name — neither is evidence', () => {
    const t = groupIntoTheses([
      leg({ chainId: 1, deployer: null as never }),
      leg({ chainId: 8453, name: '   ' }),
      leg({ chainId: 4663 }),
    ], { includeSingles: true })
    expect(t.every((x) => x.legs.every((l) => l.deployer && (l.name ?? '').trim()))).toBe(true)
  })
})

describe('thesisIsDiscoverable — the discovery floor (owner 2026-08-16)', () => {
  const t = (totalAumUsd: number): Thesis => ({
    deployer: DEP,
    name: 'Bullish EVM',
    legs: [],
    chainIds: [1, 8453],
    totalAumUsd,
  })

  it('a bundle at or above $100 TVL is discoverable — the rule hides "less than $100", so exactly $100 shows', () => {
    expect(thesisIsDiscoverable(t(DISCOVERY_TVL_FLOOR_USD))).toBe(true)
    expect(thesisIsDiscoverable(t(2500))).toBe(true)
  })

  it('a sub-$100 bundle is not — the owner’s walls of "$3.0000 combined price" test shells', () => {
    expect(thesisIsDiscoverable(t(99.99))).toBe(false)
    expect(thesisIsDiscoverable(t(3))).toBe(false)
  })

  it('an unseeded bundle (~$0 AUM) is not — "without seeding" and "under $100" are one floor', () => {
    expect(thesisIsDiscoverable(t(0))).toBe(false)
  })

  it('an unreadable total fails CLOSED — a bundle whose money cannot be proven does not get a discovery slot', () => {
    expect(thesisIsDiscoverable(t(Number.NaN))).toBe(false)
    expect(thesisIsDiscoverable(t(Number.POSITIVE_INFINITY))).toBe(false)
  })
})

describe('thesisNeeds — splitting a buyer’s money the way the creator shipped it', () => {
  const thesis = (aums: number[]): Thesis => {
    const legs = aums.map((a, i) => leg({ chainId: [8453, 1, 4663][i], aumUsd: a }))
    return {
      deployer: DEP,
      name: 'Bullish EVM',
      legs,
      chainIds: legs.map((l) => l.chainId),
      totalAumUsd: aums.reduce((s, a) => s + a, 0),
    }
  }

  it('splits by each leg’s share of the thesis, not equally per chain', () => {
    // buying the idea means buying it in the proportions actually shipped
    const needs = thesisNeeds(thesis([8000, 2000]), 1000, 40)!
    expect(needs.map((n) => n.buysCents)).toEqual([80_000, 20_000])
  })

  it('the cents sum EXACTLY to the amount, at an ugly ratio', () => {
    // a per-chain rounding drift is a chain that quietly under-funds, which the
    // conservation check then refuses — so the split must conserve by
    // construction rather than approximately
    for (const amount of [999.99, 1234.56, 0.07, 100_000.01]) {
      for (const aums of [[1, 1, 1], [7, 3], [1_000_000, 3], [5, 5, 5]]) {
        const needs = thesisNeeds(thesis(aums), amount, 40)
        const sum = (needs ?? []).reduce((s, n) => s + n.buysCents, 0)
        expect(sum, `${amount} over ${aums.join(':')}`).toBe(Math.round(amount * 100))
      }
    }
  })

  it('a zero-AUM leg never receives a remainder cent — it is not in the thesis', () => {
    const needs = thesisNeeds(thesis([100, 0]), 10, 40)!
    expect(needs).toHaveLength(1)
    expect(needs[0].chainId).toBe(8453)
  })

  it('REFUSES when no leg has readable AUM — dividing equally would invent intent', () => {
    expect(thesisNeeds(thesis([0, 0]), 1000, 40)).toBeNull()
    expect(thesisNeeds(thesis([Number.NaN, Number.NaN]), 1000, 40)).toBeNull()
  })

  it('refuses an unreadable or non-positive amount rather than composing nothing', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(thesisNeeds(thesis([1, 1]), bad, 40), `amount ${bad}`).toBeNull()
    }
  })

  it('the fee rides the buys and is floored, matching the funding equation', () => {
    const needs = thesisNeeds(thesis([1]), 1000, 40)!
    expect(needs[0].buysCents).toBe(100_000)
    expect(needs[0].feeCents).toBe(400) // floor(100000 * 40 / 10000)
  })
})

describe('thesisNeeds — seed shares (the ceremonies’ door over a fresh, zero-AUM bundle)', () => {
  const thesis = (aums: number[]): Thesis => {
    const legs = aums.map((a, i) => leg({ chainId: [8453, 1, 4663][i], aumUsd: a }))
    return {
      deployer: DEP,
      name: 'Bullish EVM',
      legs,
      chainIds: legs.map((l) => l.chainId),
      totalAumUsd: aums.reduce((s, a) => s + a, 0),
    }
  }

  it('zero-AUM legs with explicit shares split the stake by those shares', () => {
    // the exact seam: a just-shipped version has zero AUM everywhere, which the
    // AUM law refuses — the deploy weights carried by the ceremony are the
    // creator's shipped intent and take over outright
    const needs = thesisNeeds(thesis([0, 0, 0]), 100, 0, new Map([[8453, 60], [1, 25], [4663, 15]]))!
    expect(needs.map((n) => [n.chainId, n.buysCents])).toEqual([
      [8453, 6000],
      [1, 2500],
      [4663, 1500],
    ])
  })

  it('conserves EXACTLY at ugly ratios over zero-AUM legs — largest remainder, sums exact', () => {
    for (const amount of [999.99, 1234.56, 0.07, 100_000.01]) {
      for (const shares of [[1, 1, 1], [7, 3, 90], [33.4, 33.3, 33.3]]) {
        const needs = thesisNeeds(thesis([0, 0, 0]), amount, 0, new Map([[8453, shares[0]], [1, shares[1]], [4663, shares[2]]]))
        const sum = (needs ?? []).reduce((s, n) => s + n.buysCents, 0)
        expect(sum, `${amount} over ${shares.join(':')}`).toBe(Math.round(amount * 100))
      }
    }
  })

  it('ABSENT override preserves today’s behavior byte-identical', () => {
    // the explicit-undefined call walks exactly the code path every existing
    // caller compiles into — same split, same refusal
    expect(thesisNeeds(thesis([8000, 2000]), 1000, 40, undefined)).toEqual(thesisNeeds(thesis([8000, 2000]), 1000, 40))
    expect(thesisNeeds(thesis([0, 0]), 1000, 40, undefined)).toBeNull()
  })

  it('the override outranks live AUM entirely — a seeded split never reads the money sitting there', () => {
    const needs = thesisNeeds(thesis([8000, 2000]), 100, 0, new Map([[8453, 10], [1, 90]]))!
    expect(needs.map((n) => n.buysCents)).toEqual([1000, 9000])
  })

  it('REFUSES when no share is positive — an empty or unreadable override invents nothing', () => {
    expect(thesisNeeds(thesis([0, 0]), 1000, 0, new Map())).toBeNull()
    expect(thesisNeeds(thesis([0, 0]), 1000, 0, new Map([[8453, 0], [1, Number.NaN]]))).toBeNull()
    expect(thesisNeeds(thesis([0, 0]), 1000, 0, new Map([[8453, -5], [1, -1]]))).toBeNull()
  })

  it('a leg absent from the shares (or non-positive there) funds nothing and never takes a remainder cent', () => {
    const needs = thesisNeeds(thesis([0, 0]), 10.01, 0, new Map([[8453, 100]]))!
    expect(needs).toHaveLength(1)
    expect(needs[0].chainId).toBe(8453)
    expect(needs[0].buysCents).toBe(1001)
  })

  it('the fee rides the seeded buys under the same floor law', () => {
    const needs = thesisNeeds(thesis([0]), 1000, 40, new Map([[8453, 100]]))!
    expect(needs[0].buysCents).toBe(100_000)
    expect(needs[0].feeCents).toBe(400)
  })
})

describe('thesisCombinedSeries — the total-value curve', () => {
  const leg = (aum: number, values: number[], t0 = 1000): BasketSummary =>
    ({
      chainId: 1,
      address: '0xa',
      name: 'X',
      symbol: 'X',
      basketLength: 1,
      navPerToken: 1,
      aumUsd: aum,
      change24hPct: 0,
      pricedCount: 1,
      top: [],
      navSeries: values.map((value, i) => ({ time: t0 + i * 3600, value })),
      deployer: '0xd',
      supersededBy: null,
      holdersCount: null,
    }) as unknown as BasketSummary

  it('ends exactly at the summed TVL and scales each leg by its own dollars', () => {
    const out = thesisCombinedSeries([leg(600, [100, 120]), leg(400, [200, 160])])
    expect(out).not.toBeNull()
    expect(out![out!.length - 1].value).toBeCloseTo(1000)
    // first point: 600*(100/120) + 400*(200/160) = 500 + 500
    expect(out![0].value).toBeCloseTo(1000)
  })

  it('aligns from the tail when series lengths differ', () => {
    const out = thesisCombinedSeries([leg(500, [90, 95, 100]), leg(500, [50, 100])])
    expect(out).toHaveLength(2)
    expect(out![1].value).toBeCloseTo(1000)
  })

  it('refuses a partial total: any leg without a usable series → null', () => {
    expect(thesisCombinedSeries([leg(600, [100, 120]), leg(400, [])])).toBeNull()
    expect(thesisCombinedSeries([leg(600, [100, 120]), leg(0, [100, 100])])).toBeNull()
    expect(thesisCombinedSeries([])).toBeNull()
  })
})

describe('thesisOneOfEach — the combined price', () => {
  const nav = (navPerToken: number): BasketSummary => ({ navPerToken }) as BasketSummary
  it('sums one token of each leg', () => {
    expect(thesisOneOfEach([nav(1.25), nav(0.75), nav(2)])).toBeCloseTo(4)
  })
  it('refuses when any leg is unpriced — a partial sum reads as a real price', () => {
    expect(thesisOneOfEach([nav(1.25), nav(NaN)])).toBeNull()
    expect(thesisOneOfEach([nav(1.25), nav(0)])).toBeNull()
    expect(thesisOneOfEach([])).toBeNull()
  })
})
