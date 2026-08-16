import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RawHolding } from './raw-holdings'

function fakeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => void m.clear(),
    key: () => null,
    get length() {
      return m.size
    },
  }
}

async function fresh() {
  vi.resetModules()
  vi.stubGlobal('window', { localStorage: fakeStorage() })
  const seed = await import('./seed-from-holdings')
  const alloc = await import('./allocation')
  return { seed, alloc }
}

beforeEach(() => vi.unstubAllGlobals())

const A = '0x00000000000000000000000000000000000000aa'

const h = (symbol: string, usd: number | null, extra: Partial<RawHolding> = {}): RawHolding => ({
  chainId: 8453,
  address: `0x${symbol.padEnd(40, '0').toLowerCase()}`,
  symbol,
  decimals: 18,
  amount: 1,
  usd,
  ...extra,
})

describe('seedDraftFromHoldings', () => {
  it('seeds value-share weights from priced holdings, intent keep', async () => {
    const { seed, alloc } = await fresh()
    const res = seed.seedDraftFromHoldings(A, [h('AAA', 700), h('BBB', 300)], 1_000)
    expect(res?.seeded).toBe(true)
    expect(res?.draft.intent).toBe('keep')
    expect(res?.draft.targets.map((t) => [t.asset.symbol, t.weight])).toEqual([
      ['AAA', 70],
      ['BBB', 30],
    ])
    // persisted: the flow will actually open on it
    expect(alloc.loadDraft(A)?.targets).toHaveLength(2)
  })

  it('NEVER clobbers an existing draft — returns it untouched', async () => {
    const { seed, alloc } = await fresh()
    seed.seedDraftFromHoldings(A, [h('AAA', 700), h('BBB', 300)])
    const res = seed.seedDraftFromHoldings(A, [h('CCC', 999), h('DDD', 1)])
    expect(res?.seeded).toBe(false)
    expect(alloc.loadDraft(A)?.targets.map((t) => t.asset.symbol)).toEqual(['AAA', 'BBB'])
  })

  it('excludes unpriced holdings; native FOLDS to its WETH form (connect-first ruling, 2026-08-03)', async () => {
    // The sentinel itself stays untradeable, but the ROW no longer vanishes:
    // a mostly-ETH wallet used to seed a draft missing its biggest holding.
    const { seed } = await fresh()
    const { chainCfg } = await import('../chain/chains')
    const res = seed.seedDraftFromHoldings(A, [
      h('AAA', 500),
      h('BBB', 500),
      h('DEAD', null),
      h('ETH', 900, { native: true, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
    ])
    expect(res?.draft.targets.map((t) => t.asset.symbol)).toEqual(['WETH', 'AAA', 'BBB'])
    expect(res?.draft.targets[0].asset.address).toBe(chainCfg(8453).weth)
  })

  it('a native row and a real WETH row on one chain merge into ONE leg — usd summed BEFORE weights', async () => {
    const { seed } = await fresh()
    const { chainCfg } = await import('../chain/chains')
    const weth = chainCfg(8453).weth
    if (!weth) throw new Error('Base weth missing from chain config — the fold this test pins needs it')
    const res = seed.seedDraftFromHoldings(A, [
      h('ETH', 400, { native: true, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
      h('WETH', 300, { address: weth }),
      h('BBB', 300),
    ])
    expect(res?.draft.targets).toHaveLength(2) // never two legs with one key
    const wl = res?.draft.targets.find((t) => t.asset.symbol === 'WETH')
    expect(wl?.asset.address).toBe(weth)
    expect(wl?.weight).toBe(70) // 700 of 1000
  })

  it('a chain with no known weth keeps the exclusion', async () => {
    const { seed } = await fresh()
    const res = seed.seedDraftFromHoldings(A, [
      h('ETH', 900, { native: true, chainId: 999_999, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
      h('AAA', 500),
      h('BBB', 500),
    ])
    expect(res?.draft.targets.map((t) => t.asset.symbol)).toEqual(['AAA', 'BBB'])
  })

  it('refuses with fewer than two seedable holdings', async () => {
    const { seed } = await fresh()
    expect(seed.seedDraftFromHoldings(A, [h('AAA', 500), h('DEAD', null)])).toBeNull()
    expect(seed.seedDraftFromHoldings(A, [])).toBeNull()
    expect(seed.seedDraftFromHoldings('', [h('AAA', 1), h('BBB', 1)])).toBeNull()
  })

  it('caps at MAX_ALLOCATION_ASSETS, keeping the largest', async () => {
    const { seed, alloc } = await fresh()
    // over-the-cap input derives from the constant (the cap moved 12 → 50,
    // the owner 2026-08-06); the law under pin is largest-kept truncation
    // values sit ABOVE the dust floor so the law under pin stays the cap, not the floor
    const many = Array.from({ length: alloc.MAX_ALLOCATION_ASSETS + 8 }, (_, i) => h(`T${String(i).padStart(2, '0')}`, 100 + alloc.MAX_ALLOCATION_ASSETS + 8 - i))
    const res = seed.seedDraftFromHoldings(A, many)
    expect(res?.draft.targets).toHaveLength(alloc.MAX_ALLOCATION_ASSETS)
    expect(res?.draft.targets[0].asset.symbol).toBe('T00')
  })

  it('a held BASKET never seeds a leg — it is not a plain asset the picker resolves', async () => {
    const { seed } = await fresh()
    const res = seed.seedDraftFromHoldings(A, [
      h('LPADS', 900, { basket: true }),
      h('AAA', 60),
      h('BBB', 40),
    ])
    expect(res?.draft.targets.map((t) => t.asset.symbol)).toEqual(['AAA', 'BBB'])
  })

  it('a baskets-ONLY wallet cannot seed at all — refused, never a one-leg draft', async () => {
    const { seed } = await fresh()
    expect(
      seed.seedDraftFromHoldings(A, [h('LPADS', 500, { basket: true }), h('WSB', 500, { basket: true })]),
    ).toBeNull()
  })

  it('a sliver SHARE still gets a weight of at least 1 (the floor drops dust DOLLARS, not small shares)', async () => {
    const { seed } = await fresh()
    const res = seed.seedDraftFromHoldings(A, [h('BIG', 100_000), h('DUST', 10)])
    expect(res?.draft.targets.find((t) => t.asset.symbol === 'DUST')?.weight).toBe(1)
  })
})

describe('seedDraftFromComposition (the discovery seam)', () => {
  const legs = (w: number[]) =>
    w.map((weightPct, i) => ({ chainId: 8453, address: `0x${String(i).padStart(40, '0')}`, symbol: `T${i}`, weightPct }))

  it('seeds the recipe at normalized designed weights', async () => {
    const { seed, alloc } = await fresh()
    const res = seed.seedDraftFromComposition(A, legs([40, 35, 25]), 5)
    expect(res?.seeded).toBe(true)
    expect(res?.draft.targets.map((t) => t.weight)).toEqual([40, 35, 25])
    expect(alloc.loadDraft(A)?.updatedAt).toBe(5)
  })

  it('never clobbers an existing draft', async () => {
    const { seed } = await fresh()
    seed.seedDraftFromComposition(A, legs([60, 40]))
    const res = seed.seedDraftFromComposition(A, legs([10, 90]))
    expect(res?.seeded).toBe(false)
    expect(res?.draft.targets.map((t) => t.weight)).toEqual([60, 40])
  })

  it('refuses under two usable legs and drops zero-weight legs', async () => {
    const { seed } = await fresh()
    expect(seed.seedDraftFromComposition(A, legs([100, 0]))).toBeNull()
    const res = seed.seedDraftFromComposition(A, legs([50, 0, 50]))
    expect(res?.draft.targets).toHaveLength(2)
  })
})

// ── THE SIGN-IN BOOK ADD (the owner 2026-08-13, the reveal≠add loop) ─────────────
describe('savePortfolioFromHoldings', () => {
  it('writes the saved allocation the portfolio counts: value-share targets, the priced total, simulated', async () => {
    const { seed, alloc } = await fresh()
    const res = seed.savePortfolioFromHoldings(A, [h('AAA', 700), h('BBB', 300)], 1_000)
    expect(res).toEqual({ added: true, count: 2, totalUsd: 1000 })
    const p = alloc.loadPortfolio(A)
    expect(p?.targets.map((t) => [t.asset.symbol, t.weight])).toEqual([
      ['AAA', 70],
      ['BBB', 30],
    ])
    expect(p?.amountUsd).toBe(1000)
    expect(p?.executedAt).toBe(1_000)
    // no engine ran and nothing chain-confirmed EXECUTED — the flag's
    // "never present as chain-confirmed" contract wants the modest side
    expect(p?.simulated).toBe(true)
  })

  it('a book of ONE asset is legitimate — the ≥2 floor is a weighting law, not a book law', async () => {
    const { seed, alloc } = await fresh()
    // the draft seeder refuses this same wallet…
    expect(seed.seedDraftFromHoldings(A, [h('AAA', 500)])).toBeNull()
    // …the book add does not
    const res = seed.savePortfolioFromHoldings(A, [h('AAA', 500)])
    expect(res.added).toBe(true)
    expect(alloc.loadPortfolio(A)?.targets).toHaveLength(1)
  })

  it('never clobbers an existing saved allocation — an add for the first minute, not a reset', async () => {
    const { seed, alloc } = await fresh()
    seed.savePortfolioFromHoldings(A, [h('AAA', 700), h('BBB', 300)], 1_000)
    const res = seed.savePortfolioFromHoldings(A, [h('CCC', 999)], 2_000)
    expect(res.added).toBe(false)
    expect(alloc.loadPortfolio(A)?.targets.map((t) => t.asset.symbol)).toEqual(['AAA', 'BBB'])
    expect(alloc.loadPortfolio(A)?.executedAt).toBe(1_000)
  })

  it('writes nothing for an unpriced or basket-only wallet — no empty claim, no zero amount', async () => {
    const { seed, alloc } = await fresh()
    expect(seed.savePortfolioFromHoldings(A, [h('AAA', null)]).added).toBe(false)
    expect(seed.savePortfolioFromHoldings(A, [h('BSK', 500, { basket: true })]).added).toBe(false)
    expect(alloc.loadPortfolio(A)).toBeNull()
  })

  it('shares the draft seeder’s fold law: native folds to its WETH form', async () => {
    const { seed, alloc } = await fresh()
    const { chainCfg } = await import('../chain/chains')
    seed.savePortfolioFromHoldings(A, [
      h('ETH', 900, { native: true, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
      h('AAA', 100),
    ])
    const p = alloc.loadPortfolio(A)
    expect(p?.targets.map((t) => t.asset.symbol)).toEqual(['WETH', 'AAA'])
    expect(p?.targets[0].asset.address).toBe(chainCfg(8453).weth)
  })
})

// ── the dust floor + the seeded flag + the top-up (the owner 2026-08-13 live) ────
describe('the seedable fold’s dust floor', () => {
  it('rows under the house floor never seed; the floor binds AFTER the native merge', async () => {
    const { seed, alloc } = await fresh()
    // $9.99 is dust; $6 native + $6 WETH merge into one $12 leg that is not
    const { chainCfg } = await import('../chain/chains')
    const weth = chainCfg(8453).weth
    if (!weth) throw new Error('Base weth missing from chain config — the fold this test pins needs it')
    // explicit hex addresses: the saved-portfolio read path (loadPortfolio →
    // sanitizeTargets) refuses a non-hex address, unlike the draft path
    seed.savePortfolioFromHoldings(A, [
      h('BIG', 500, { address: '0x' + 'b16'.padEnd(40, '0') }),
      h('LINT', 9.99, { address: '0x' + '117'.padEnd(40, '0') }),
      h('ETH', 6, { native: true, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
      h('WETH', 6, { address: weth }),
    ])
    const symbols = alloc.loadPortfolio(A)?.targets.map((t) => t.asset.symbol)
    expect(symbols).toEqual(['BIG', 'WETH'])
  })
})

describe('topUpSeededPortfolio', () => {
  it('stamps the seeded flag on the add, then APPENDS what later reads surface — existing targets untouched', async () => {
    const { seed, alloc } = await fresh()
    seed.savePortfolioFromHoldings(A, [h('AAA', 700), h('BBB', 300)], 1_000)
    expect(alloc.loadPortfolio(A)?.seededFromHoldings).toBe(true)
    // the fuller read arrives: AAA re-read (already a target), CCC new
    const res = seed.topUpSeededPortfolio(A, [h('AAA', 700), h('BBB', 300), h('CCC', 1_000)])
    expect(res).toEqual({ added: true, count: 1 })
    const p = alloc.loadPortfolio(A)
    expect(p?.targets.map((t) => [t.asset.symbol, t.weight])).toEqual([
      ['AAA', 70], // the original weights stand — never reweighted
      ['BBB', 30],
      ['CCC', 50], // its value share of TODAY's seedable total (1000/2000)
    ])
    expect(p?.executedAt).toBe(1_000) // the add moment is history, not rewritten
    expect(p?.seededFromHoldings).toBe(true)
  })

  it('never touches a user-composed book (no flag), and no-ops when nothing new cleared the fold', async () => {
    const { seed, alloc } = await fresh()
    // a flow-style save: no seeded flag
    alloc.savePortfolio(A, {
      targets: [{ asset: { chainId: 8453, address: '0xaaa0000000000000000000000000000000000000', symbol: 'AAA' }, weight: 100 }],
      amountUsd: 500,
      executedAt: 1,
      simulated: true,
    })
    expect(seed.topUpSeededPortfolio(A, [h('CCC', 1_000)]).added).toBe(false)
    expect(alloc.loadPortfolio(A)?.targets).toHaveLength(1)
    // and on a seeded book, dust/known rows change nothing
    const B = '0x00000000000000000000000000000000000000bb'
    seed.savePortfolioFromHoldings(B, [h('AAA', 700), h('BBB', 300)])
    expect(seed.topUpSeededPortfolio(B, [h('AAA', 700), h('LINT', 2)]).added).toBe(false)
  })

  it('respects the cap: appends biggest-first only while room remains', async () => {
    const { seed, alloc } = await fresh()
    const { MAX_ALLOCATION_ASSETS } = await import('./allocation')
    // hex-valid addresses (decimal digits padded with 'a') — the saved read refuses non-hex
    const start = Array.from({ length: MAX_ALLOCATION_ASSETS - 1 }, (_, i) => h(`T${i}`, 100 + i, { address: `0x${String(i).padStart(40, 'a')}` }))
    seed.savePortfolioFromHoldings(A, start)
    const res = seed.topUpSeededPortfolio(A, [...start, h('NEW1', 5_000, { address: `0x${'e1'.repeat(20)}` }), h('NEW2', 4_000, { address: `0x${'e2'.repeat(20)}` })])
    expect(res).toEqual({ added: true, count: 1 })
    const symbols = alloc.loadPortfolio(A)?.targets.map((t) => t.asset.symbol)
    expect(symbols).toHaveLength(MAX_ALLOCATION_ASSETS)
    expect(symbols).toContain('NEW1') // the bigger of the two took the last seat
    expect(symbols).not.toContain('NEW2')
  })
})
