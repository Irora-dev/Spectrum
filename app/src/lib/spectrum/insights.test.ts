import { describe, expect, it } from 'vitest'
import { applyChanges, buildInsights, exitCost, findDepegs, realizedOnTrim, toPlanChanges, tierSplit, DRIFT_THRESHOLD_PP, type InsightPosition } from './insights'
import { TIER_ORDER } from './market-tiers'

const P = (symbol: string, valueUsd: number, pct: number, tier: InsightPosition['tier']): InsightPosition => ({
  key: `8453:${symbol.toLowerCase()}`,
  symbol,
  valueUsd,
  pct,
  tier,
})

const base = {
  totalUsd: 10_000,
  networks: 1,
  unpricedCount: 0,
  baseline: null,
}

describe('portfolio insights', () => {
  it('says nothing about an empty portfolio', () => {
    expect(buildInsights({ ...base, positions: [], totalUsd: 0 })).toEqual([])
    expect(buildInsights({ ...base, positions: [P('WETH', 100, 100, 'majors')], totalUsd: 0 })).toEqual([])
  })

  // His card: a low cap that grew into a bigger share than it was set to.
  it('flags a position that has drifted past the threshold, naming both ends and the date', () => {
    const out = buildInsights({
      ...base,
      positions: [P('DEGEN', 2100, 21, 'micro'), P('WETH', 7900, 79, 'majors')],
      baseline: { at: Date.parse('2026-07-14T00:00:00Z'), shares: { '8453:degen': 12, '8453:weth': 88 } },
    })
    // WETH legitimately drifted too (88 → 79) and is the bigger position, so
    // target DEGEN's card by id rather than taking the first drift card.
    const drift = out.find((i) => i.id === 'drift:8453:degen')
    expect(drift).toBeTruthy()
    expect(drift!.headline).toContain('$DEGEN')
    expect(drift!.headline).toContain('21%')
    expect(drift!.headline).toContain('up from 12%')
    // the measurement is stated, not implied
    expect(drift!.detail).toContain('You set it at 12%')
    expect(drift!.detail).toContain('Jul')
    // the visual-first face (23:1x): subject names the thing, stat carries
    // the figure — the card renders these, the sentence rides the ⓘ
    expect(drift!.subject).toBe('$DEGEN drift')
    expect(drift!.stat).toBe('12% → 21%')
  })

  it('every insight carries a non-empty subject and stat for the visual-first face', () => {
    const out = buildInsights({
      ...base,
      positions: [
        { ...P('DEGEN', 6000, 60, 'micro'), sourceCount: 3 },
        P('WETH', 3000, 30, 'majors'),
        P('USDC', 1000, 10, 'cash'),
      ],
      networks: 3,
      unpricedCount: 1,
    })
    expect(out.length).toBeGreaterThan(3)
    for (const i of out) {
      expect(i.subject.length, i.id).toBeGreaterThan(0)
      expect(i.stat.length, i.id).toBeGreaterThan(0)
    }
  })

  it('says "down from" when a position shrank', () => {
    const out = buildInsights({
      ...base,
      positions: [P('DEGEN', 500, 5, 'micro'), P('WETH', 9500, 95, 'majors')],
      baseline: { at: 1, shares: { '8453:degen': 30, '8453:weth': 70 } },
    })
    expect(out.find((i) => i.id === 'drift:8453:degen')!.headline).toContain('down from 30%')
  })

  it('stays quiet on ordinary noise below the threshold', () => {
    const out = buildInsights({
      ...base,
      positions: [P('WETH', 10_000, 100, 'majors')],
      baseline: { at: 1, shares: { '8453:weth': 100 - (DRIFT_THRESHOLD_PP - 1) } },
    })
    expect(out.some((i) => i.kind === 'drift')).toBe(false)
  })

  it('never invents a baseline for a position it has none for', () => {
    const out = buildInsights({
      ...base,
      positions: [P('BRETT', 5000, 50, 'small'), P('WETH', 5000, 50, 'majors')],
      baseline: { at: 1, shares: { '8453:weth': 90 } },
    })
    expect(out.some((i) => i.id === 'drift:8453:brett')).toBe(false)
    expect(out.some((i) => i.id === 'drift:8453:weth')).toBe(true)
  })

  it('states the spectrum read in DOLLARS first, his own sentence shape', () => {
    const out = buildInsights({
      ...base,
      totalUsd: 120_000,
      positions: [P('DEGEN', 50_000, 41.7, 'micro'), P('WETH', 70_000, 58.3, 'majors')],
    })
    const s = out.find((i) => i.kind === 'spectrum')!
    // grouped-dollar law (owner ~23:5x): full digits with commas to six
    // figures; compact only from $1M
    expect(s.headline).toBe('$50,000 of your $120,000 is in small caps and new tokens')
  })

  it('money goes compact only from a million', () => {
    const out = buildInsights({
      ...base,
      totalUsd: 2_300_000,
      positions: [P('DEGEN', 1_150_000, 50, 'micro'), P('WETH', 1_150_000, 50, 'majors')],
    })
    const s = out.find((i) => i.kind === 'spectrum')!
    expect(s.headline).toContain('$1.15M')
    expect(s.headline).toContain('$2.30M')
  })

  // Measured against an even split of the same count: "50% in two positions" is
  // not concentration when you hold four things, it is what holding four things
  // means. And with two positions the statement is vacuous.
  it('only claims concentration when it beats an even split of the same count', () => {
    const evenFour = buildInsights({
      ...base,
      positions: [P('A', 2500, 25, 'large'), P('B', 2500, 25, 'large'), P('C', 2500, 25, 'large'), P('D', 2500, 25, 'large')],
    })
    expect(evenFour.some((i) => i.kind === 'concentration')).toBe(false)

    const evenThree = buildInsights({
      ...base,
      positions: [P('A', 3400, 34, 'large'), P('B', 3300, 33, 'large'), P('C', 3300, 33, 'large')],
    })
    expect(evenThree.some((i) => i.kind === 'concentration')).toBe(false)

    const twoOnly = buildInsights({ ...base, positions: [P('A', 5000, 50, 'large'), P('B', 5000, 50, 'large')] })
    expect(twoOnly.some((i) => i.kind === 'concentration')).toBe(false)

    const heavy = buildInsights({
      ...base,
      positions: [P('A', 6000, 60, 'large'), P('B', 2000, 20, 'large'), P('C', 2000, 20, 'large')],
    })
    expect(heavy.find((i) => i.kind === 'concentration')!.headline).toContain('80%')
  })

  it('shows at most two drift cards, growth leading', () => {
    const out = buildInsights({
      ...base,
      positions: [
        P('A', 3000, 30, 'micro'),
        P('B', 3000, 30, 'micro'),
        P('C', 2000, 20, 'small'),
        P('D', 2000, 20, 'small'),
      ],
      baseline: { at: 1, shares: { '8453:a': 10, '8453:b': 12, '8453:c': 40, '8453:d': 38 } },
    })
    const drift = out.filter((i) => i.kind === 'drift')
    expect(drift).toHaveLength(2)
    expect(drift[0].headline).toContain('up from')
  })

  it('reports unreadable holdings rather than hiding them', () => {
    const out = buildInsights({ ...base, positions: [P('WETH', 10_000, 100, 'majors')], unpricedCount: 2 })
    const u = out.find((i) => i.kind === 'unreadable')!
    expect(u.headline).toContain('2 holdings')
    expect(u.detail).toContain('never counted')
  })

  it('mentions the network spread only when there is a spread', () => {
    expect(buildInsights({ ...base, positions: [P('WETH', 10_000, 100, 'majors')] }).some((i) => i.kind === 'spread')).toBe(false)
    expect(
      buildInsights({ ...base, networks: 3, positions: [P('WETH', 10_000, 100, 'majors')] }).some((i) => i.kind === 'spread'),
    ).toBe(true)
  })

  it('ranks the drift card above the standing facts', () => {
    const out = buildInsights({
      ...base,
      networks: 3,
      unpricedCount: 1,
      positions: [P('DEGEN', 2100, 21, 'micro'), P('USDC', 3000, 30, 'cash'), P('WETH', 4900, 49, 'majors')],
      baseline: { at: 1, shares: { '8453:degen': 5 } },
    })
    expect(out[0].kind).toBe('drift')
    // and the whole list is ordered
    for (let i = 1; i < out.length; i++) expect(out[i - 1].magnitude).toBeGreaterThanOrEqual(out[i].magnitude)
  })

  it('gives every card a stable unique id', () => {
    const out = buildInsights({
      ...base,
      networks: 2,
      unpricedCount: 1,
      positions: [P('DEGEN', 6000, 60, 'micro'), P('USDC', 4000, 40, 'cash')],
      baseline: { at: 1, shares: { '8453:degen': 10 } },
    })
    expect(new Set(out.map((i) => i.id)).size).toBe(out.length)
  })
})

describe('overlap — the look-through fact', () => {
  it('names an asset reached through several holdings at once', () => {
    const out = buildInsights({
      ...base,
      positions: [
        { ...P('WETH', 4200, 42, 'majors'), sourceCount: 3 },
        P('USDC', 5800, 58, 'cash'),
      ],
    })
    const o = out.find((i) => i.kind === 'overlap')!
    expect(o.headline).toContain('$WETH reaches 42%')
    expect(o.headline).toContain('through 3 holdings')
  })

  it('says nothing when every asset arrives one way', () => {
    const out = buildInsights({ ...base, positions: [{ ...P('WETH', 10_000, 100, 'majors'), sourceCount: 1 }] })
    expect(out.some((i) => i.kind === 'overlap')).toBe(false)
  })

  it('ignores a multi-source dust position', () => {
    const out = buildInsights({
      ...base,
      positions: [{ ...P('WETH', 100, 1, 'majors'), sourceCount: 4 }, P('USDC', 9900, 99, 'cash')],
    })
    expect(out.some((i) => i.kind === 'overlap')).toBe(false)
  })
})

describe('depth — can you actually get out', () => {
  it('states the position as a share of its deepest pool', () => {
    const out = buildInsights({
      ...base,
      positions: [{ ...P('DEGEN', 1800, 18, 'micro'), liquidityUsd: 12_000 }, P('USDC', 8200, 82, 'cash')],
    })
    const d = out.find((i) => i.kind === 'depth')!
    expect(d.headline).toContain('$DEGEN is 15% of its pool')
    expect(d.detail).toContain('deepest pool')
  })

  it('stays silent on a position that is a rounding error in its pool', () => {
    const out = buildInsights({
      ...base,
      positions: [{ ...P('WETH', 1000, 10, 'majors'), liquidityUsd: 50_000_000 }],
    })
    expect(out.some((i) => i.kind === 'depth')).toBe(false)
  })

  it('stays quiet below 5% — 2% of a pool is not a fact worth a card', () => {
    const out = buildInsights({
      ...base,
      positions: [{ ...P('DEGEN', 200, 2, 'micro'), liquidityUsd: 10_000 }, P('WETH', 9800, 98, 'majors')],
    })
    expect(out.some((i) => i.kind === 'depth')).toBe(false)
  })

  // A stablecoin is deep in a dozen pools and redeemable besides, so its share
  // of any ONE pool says nothing about whether you can get out.
  it('never reports pool share for cash', () => {
    const out = buildInsights({
      ...base,
      positions: [{ ...P('USDC', 5000, 50, 'cash'), liquidityUsd: 20_000 }, P('WETH', 5000, 50, 'majors')],
    })
    expect(out.some((i) => i.kind === 'depth')).toBe(false)
  })

  it('never guesses when liquidity is unreadable', () => {
    const out = buildInsights({
      ...base,
      positions: [{ ...P('DEGEN', 5000, 50, 'micro'), liquidityUsd: null }, P('USDC', 5000, 50, 'cash')],
    })
    expect(out.some((i) => i.kind === 'depth')).toBe(false)
  })
})

describe('the drift card can act', () => {
  it('offers the exact dollar value that restores the share it was set to', () => {
    const out = buildInsights({
      ...base,
      positions: [P('DEGEN', 2100, 21, 'micro'), P('WETH', 7900, 79, 'majors')],
      baseline: { at: 1, shares: { '8453:degen': 10, '8453:weth': 90 } },
    })
    const d = out.find((i) => i.id === 'drift:8453:degen')!
    // both are covered, so the universe is the full $10K → 10% is $1,000
    expect(d.action).toEqual({ kind: 'restore', key: '8453:degen', toUsd: 1000, label: 'Trim back to 10%' })
  })

  it('says top back up when the position shrank', () => {
    const out = buildInsights({
      ...base,
      positions: [P('DEGEN', 1000, 10, 'micro'), P('WETH', 9000, 90, 'majors')],
      baseline: { at: 1, shares: { '8453:degen': 30, '8453:weth': 70 } },
    })
    expect(out.find((i) => i.id === 'drift:8453:degen')!.action!.label).toBe('Top back up to 30%')
  })

  it('leaves standing facts with nothing to press', () => {
    const out = buildInsights({ ...base, positions: [P('USDC', 10_000, 100, 'cash')] })
    expect(out.every((i) => i.kind === 'drift' || i.action === undefined)).toBe(true)
  })
})

describe('exitCost', () => {
  const L = (symbol: string, usd: number, chainId: number, liquidityUsd?: number | null) => ({ symbol, usd, chainId, liquidityUsd })

  it('states the fee exactly and counts one transaction per network', () => {
    const c = exitCost([L('WETH', 6000, 8453), L('AAVE', 4000, 1), L('DEGEN', 2000, 8453)], 50)
    expect(c.feeToAssembleUsd).toBe(60) // 0.50% of 12,000
    expect(c.transactions).toBe(2)
  })

  it('flags only positions that are a real slice of their own pool', () => {
    const c = exitCost([L('DEGEN', 1000, 8453, 10_000), L('WETH', 1000, 8453, 50_000_000)], 50)
    expect(c.thin.map((t) => t.symbol)).toEqual(['DEGEN'])
    expect(Math.round(c.thin[0].poolSharePct)).toBe(10)
  })

  it('thin legs share the depth card law: cash excluded, floored at 5%', () => {
    const c = exitCost(
      [
        L('USDC', 900, 8453, 10_000), // 9% of pool but CASH — redeemable, misleading, out
        L('DEGEN', 800, 8453, 10_000), // 8% — a real slice, in
        L('WETH', 300, 8453, 10_000), // 3% — under the floor, noise wearing a number
      ],
      50,
    )
    expect(c.thin.map((t) => t.symbol)).toEqual(['DEGEN'])
  })

  it('invents nothing when liquidity is unreadable', () => {
    const c = exitCost([L('X', 5000, 8453, null), L('Y', 5000, 8453)], 50)
    expect(c.thin).toEqual([])
    expect(c.feeToAssembleUsd).toBe(50)
  })

  it('ignores zero legs in the transaction count', () => {
    expect(exitCost([L('A', 0, 1), L('B', 100, 8453)], 50).transactions).toBe(1)
  })
})

describe('the plan diff', () => {
  const C = (key: string, symbol: string, fromUsd: number, toUsd: number) => ({ key, symbol, fromUsd, toUsd })

  it('names each kind of move', () => {
    const out = toPlanChanges([
      C('a', 'WETH', 1840, 1290),
      C('c', 'USDC', 1200, 1750),
      C('e', 'BRETT', 0, 400),
      C('d', 'OLD', 300, 0),
    ])
    const by = Object.fromEntries(out.map((c) => [c.symbol, c]))
    expect(by.WETH.kind).toBe('trim')
    expect(by.USDC.kind).toBe('add')
    expect(by.BRETT.kind).toBe('new')
    expect(by.OLD.kind).toBe('exit')
  })

  it('carries both ends of every move', () => {
    const [c] = toPlanChanges([C('a', 'WETH', 1840.22, 1290)])
    expect(c.fromUsd).toBe(1840.22)
    expect(c.toUsd).toBe(1290)
    expect(c.deltaUsd).toBeCloseTo(-550.22, 2)
  })

  it('orders by the size of the move, not the size of the position', () => {
    const out = toPlanChanges([C('big', 'BIG', 10_000, 9_900), C('small', 'SML', 100, 900)])
    expect(out.map((c) => c.symbol)).toEqual(['SML', 'BIG'])
  })

  // The bug this shape exists to prevent: deriving each leg's dollars from
  // integer percentages invented sub-dollar "changes" on positions the plan
  // never touched, so the review promised trades that would never happen.
  it('treats sub-dollar rounding as no change at all', () => {
    expect(toPlanChanges([C('a', 'WETH', 1000, 1000.4)])).toEqual([])
  })

  it('applies the recorded moves onto the before-picture exactly', () => {
    const before = [
      { key: 'a', symbol: 'WETH', usd: 1840 },
      { key: 'b', symbol: 'DEGEN', usd: 860 },
      { key: 'd', symbol: 'OLD', usd: 300 },
    ]
    const after = applyChanges(before, toPlanChanges([C('a', 'WETH', 1840, 1290), C('e', 'BRETT', 0, 400), C('d', 'OLD', 300, 0)]))
    const by = Object.fromEntries(after.map((l) => [l.symbol, l.usd]))
    expect(by.WETH).toBe(1290)
    expect(by.BRETT).toBe(400)
    // an untouched position is carried through UNCHANGED, to the cent
    expect(by.DEGEN).toBe(860)
    // an exited one is gone
    expect(by.OLD).toBeUndefined()
  })
})

describe('tierSplit', () => {
  it('orders safer to riskier and drops empty tiers', () => {
    const rows = tierSplit(
      [P('USDC', 2500, 25, 'cash'), P('DEGEN', 2500, 25, 'micro'), P('WETH', 5000, 50, 'majors')],
      TIER_ORDER,
    )
    expect(rows.map((r) => r.tier)).toEqual(['cash', 'majors', 'micro'])
    expect(rows.map((r) => Math.round(r.pct))).toEqual([25, 50, 25])
    expect(rows.reduce((s, r) => s + r.usd, 0)).toBe(10_000)
  })

  it('is empty rather than dividing by zero', () => {
    expect(tierSplit([], TIER_ORDER)).toEqual([])
    expect(tierSplit([P('X', 0, 0, 'cash')], TIER_ORDER)).toEqual([])
  })
})

describe('realizedOnTrim (feature 4: the receipt, never guessed)', () => {
  it('computes frac × (current − invested) on a known basis', () => {
    // trim $500 of a $1,000 position bought for $600 → half the $400 gain
    expect(realizedOnTrim(1000, 600, 500)).toBe(200)
  })
  it('losses come out signed', () => {
    expect(realizedOnTrim(1000, 1400, 250)).toBe(-100)
  })
  it('unknown or degenerate basis → null, never a guess', () => {
    expect(realizedOnTrim(1000, undefined, 500)).toBeNull()
    expect(realizedOnTrim(1000, 0, 500)).toBeNull()
    expect(realizedOnTrim(0, 600, 500)).toBeNull()
  })
  it('a full exit realizes the whole difference', () => {
    expect(realizedOnTrim(1000, 600, 1000)).toBe(400)
  })
})

describe('drift band (feature 3)', () => {
  it('a custom band silences moves the default would fire on', () => {
    const positions = [P('DEGEN', 2100, 21, 'micro'), P('WETH', 7900, 79, 'majors')]
    const base8 = {
      ...base,
      positions,
      baseline: { at: 1, shares: { '8453:degen': 14, '8453:weth': 86 }, bandPp: 8 },
    }
    // DEGEN moved 7pp — beyond the 5pp default, inside the 8pp band
    expect(buildInsights(base8).find((i) => i.kind === 'drift')).toBeUndefined()
    const base5 = { ...base8, baseline: { ...base8.baseline, bandPp: undefined } }
    expect(buildInsights(base5).find((i) => i.kind === 'drift')).toBeTruthy()
  })
})

describe('planvs + cluster cards (features 2 + 7, injected facts)', () => {
  it('states the counterfactual both ways and skips below the floor', () => {
    const pos = [P('WETH', 10_000, 100, 'majors')]
    const cost = buildInsights({ ...base, positions: pos, planVs: { actualNowUsd: 45_357, planNowUsd: 46_890, atMs: Date.parse('2026-08-02'), skippedCount: 0 } })
    const card = cost.find((i) => i.kind === 'planvs')!
    expect(card.subject).toContain('cost')
    expect(card.stat).toContain('vs')
    const helped = buildInsights({ ...base, positions: pos, planVs: { actualNowUsd: 46_890, planNowUsd: 45_357, atMs: 1, skippedCount: 1 } })
    expect(helped.find((i) => i.kind === 'planvs')!.subject).toContain('helped')
    expect(helped.find((i) => i.kind === 'planvs')!.detail).toContain('1 leg')
    const quiet = buildInsights({ ...base, positions: pos, planVs: { actualNowUsd: 45_357, planNowUsd: 45_360, atMs: 1, skippedCount: 0 } })
    expect(quiet.some((i) => i.kind === 'planvs')).toBe(false)
  })
  it('names the moved-together pair as a measurement', () => {
    const out = buildInsights({ ...base, positions: [P('WETH', 10_000, 100, 'majors')], together: { aSym: 'DEGEN', bSym: 'BRETT', days: 10, together: 9 } })
    const c = out.find((i) => i.kind === 'cluster')!
    expect(c.headline).toBe('$DEGEN and $BRETT moved together 9 of 10 days')
    expect(c.stat).toBe('9/10 days')
  })
})

describe('the measured exit-cost card (freeze-amendment feature 4, desk 34)', () => {
  const holdingsRow = (over: Partial<{ key: string; symbol: string; costUsd: number; costPct: number; sizeUsd: number; route: string }> = {}) => ({
    key: '8453:0xba5e01',
    symbol: 'DEVBKT',
    costUsd: 178.18,
    costPct: 1.9,
    sizeUsd: 9378,
    route: 'its own router on Base',
    ...over,
  })
  const pos = [P('DEVBKT', 9378, 60, 'mid'), P('WETH', 6310, 40, 'majors')]

  it('states the measured number, its size and its route — and draws cost as a share', () => {
    const out = buildInsights({ ...base, positions: pos, exitCosts: [holdingsRow()] })
    const card = out.find((c) => c.kind === 'exit')
    expect(card).toBeTruthy()
    expect(card!.subject).toBe('$DEVBKT exit cost')
    expect(card!.stat).toBe('1.9%')
    expect(card!.headline).toContain('$178') // the module's own money law: no cents from $100
    expect(card!.headline).toContain('1.9%')
    expect(card!.detail).toContain('$9,378')
    expect(card!.detail).toContain('its own router on Base')
    expect(card!.mark).toEqual({ form: 'share', pct: 1.9 })
    expect(card!.action).toBeUndefined() // facts only, no advice
  })

  it('renders NO card when nothing measured — null and empty are the same silence', () => {
    expect(buildInsights({ ...base, positions: pos }).some((c) => c.kind === 'exit')).toBe(false)
    expect(buildInsights({ ...base, positions: pos, exitCosts: null }).some((c) => c.kind === 'exit')).toBe(false)
    expect(buildInsights({ ...base, positions: pos, exitCosts: [] }).some((c) => c.kind === 'exit')).toBe(false)
  })

  it('routine friction below the floor is not a fact worth a card', () => {
    const out = buildInsights({ ...base, positions: pos, exitCosts: [holdingsRow({ costPct: 0.6, costUsd: 56 })] })
    expect(out.some((c) => c.kind === 'exit')).toBe(false)
  })

  it('states the WORST position only, and a bigger cost ranks past the standing facts', () => {
    const cheap = holdingsRow()
    const dear = holdingsRow({ key: '8453:0xba5e02', symbol: 'DEVTWO', costPct: 12.4, costUsd: 607, sizeUsd: 4905 })
    const out = buildInsights({ ...base, positions: pos, exitCosts: [cheap, dear] })
    const exits = out.filter((c) => c.kind === 'exit')
    expect(exits).toHaveLength(1)
    expect(exits[0].subject).toBe('$DEVTWO exit cost')
    // 12.4% to leave outranks the concentration fact on the same portfolio
    const conc = out.find((c) => c.kind === 'concentration')
    if (conc) expect(exits[0].magnitude).toBeGreaterThan(conc.magnitude)
  })

  it('a negative measurement (route pays above mark) never cards', () => {
    const out = buildInsights({ ...base, positions: pos, exitCosts: [holdingsRow({ costPct: -0.4, costUsd: -37 })] })
    expect(out.some((c) => c.kind === 'exit')).toBe(false)
  })
})

describe('mark uncertainty + depeg (16:4x features 2+3)', () => {
  const pos = [P('DEVTWO', 4905, 60, 'mid'), P('WETH', 3270, 40, 'majors')]

  it('navgap fires at the kit warning floor, worst basket only, absent when unread', () => {
    const out = buildInsights({
      ...base,
      positions: pos,
      navGaps: [
        { key: '8453:0xba5e02', symbol: 'DEVTWO', divergencePct: 2.8, valueUsd: 4905 },
        { key: '8453:0xba5e01', symbol: 'DEVBKT', divergencePct: 4.1, valueUsd: 900 },
      ],
    })
    const cards = out.filter((c) => c.kind === 'navgap')
    expect(cards).toHaveLength(1)
    expect(cards[0].subject).toBe('$DEVBKT mark') // worst divergence wins
    expect(cards[0].stat).toBe('±4.1%')
    expect(buildInsights({ ...base, positions: pos, navGaps: [{ key: 'x', symbol: 'A', divergencePct: 1.9, valueUsd: 500 }] }).some((c) => c.kind === 'navgap')).toBe(false)
    expect(buildInsights({ ...base, positions: pos }).some((c) => c.kind === 'navgap')).toBe(false)
  })

  it('findDepegs floors: routine spread noise and dust never measure', () => {
    expect(findDepegs([{ symbol: 'USDC', amount: 3100, usd: 3100 }])).toHaveLength(0) // at par
    expect(findDepegs([{ symbol: 'USDC', amount: 3100, usd: 3094 }])).toHaveLength(0) // 0.19% — spread noise
    expect(findDepegs([{ symbol: 'USDC', amount: 10, usd: 9.8 }])).toHaveLength(0) // 2% but $9.80 — dust
    expect(findDepegs([{ symbol: 'DEGEN', amount: 1000, usd: 900 }])).toHaveLength(0) // not cash
    const hit = findDepegs([{ symbol: 'USDC', amount: 3100, usd: 3062 }]) // 1.23% off, $3,062
    expect(hit).toHaveLength(1)
    expect(hit[0].offPct).toBeCloseTo(1.226, 2)
  })

  it('a depeg outranks the standing facts — protective cards are what the strip is for', () => {
    const out = buildInsights({
      ...base,
      positions: pos,
      depegs: [{ symbol: 'USDC', priceUsd: 0.988, offPct: 1.2, valueUsd: 3062 }],
      navGaps: [{ key: 'k', symbol: 'DEVTWO', divergencePct: 2.8, valueUsd: 4905 }],
    })
    expect(out[0].kind).toBe('depeg')
    expect(out[0].stat).toBe('$0.988')
    expect(out[0].headline).toContain('1.2% off the dollar')
  })
})

describe('dust (16:4x feature 6) — the housekeeping fact with one motion', () => {
  const pos = [P('WETH', 6000, 60, 'majors'), P('AAVE', 4000, 40, 'mid')]

  it('fires on ANY dust with the sweep action (owner 2026-08-05 21:06: "show always" — supersedes the 16:4x three-scrap floor)', () => {
    const out = buildInsights({
      ...base,
      positions: pos,
      dust: { count: 3, totalUsd: 13.8, keys: ['1:0xa', '1:0xb', '1:0xc'] },
    })
    const card = out.find((c) => c.kind === 'dust')!
    expect(card).toBeTruthy()
    expect(card.headline).toContain('$13.80')
    expect(card.action).toEqual({ kind: 'sweep', keys: ['1:0xa', '1:0xb', '1:0xc'], label: 'Sweep to cash · $13.80' })
    // a single scrap now qualifies — the card is standing housekeeping, not a
    // threshold event; ZERO dust still shows nothing (absence stays honest)
    expect(buildInsights({ ...base, positions: pos, dust: { count: 1, totalUsd: 4, keys: ['1:0xa'] } }).some((c) => c.kind === 'dust')).toBe(true)
    expect(buildInsights({ ...base, positions: pos, dust: { count: 0, totalUsd: 0, keys: [] } }).some((c) => c.kind === 'dust')).toBe(false)
  })
})

describe('audit pins (2026-08-03 self-review)', () => {
  const pos = [P('DEVTWO', 4905, 60, 'mid'), P('WETH', 3270, 40, 'majors')]
  it('a diverged basket worth pocket change never cards — uncertainty about $2 is noise', () => {
    const out = buildInsights({
      ...base,
      positions: pos,
      navGaps: [{ key: 'k', symbol: 'TINY', divergencePct: 4.2, valueUsd: 2 }],
    })
    expect(out.some((c) => c.kind === 'navgap')).toBe(false)
  })
})

describe('the supersession card (Ⓡ ruled 2026-08-04, model-review #3)', () => {
  // a held basket always reaches the strip with a non-empty book (its own
  // look-through rows) — the entry guard's world, matched here
  const base = {
    positions: [{ key: '8453:0xleg', symbol: 'WETH', valueUsd: 2_000, pct: 100, tier: 'majors' as const, sourceCount: 1, liquidityUsd: null }],
    totalUsd: 2_000,
    networks: 1,
    unpricedCount: 0,
  }
  it('a held basket with a verified successor states the fact and carries the ONE-CLICK swap (owner 2026-08-16)', () => {
    const cards = buildInsights({
      ...base,
      superseded: [
        { key: '8453:0xold', oldSymbol: 'ALPHA', newSymbol: 'ALPHA2', newAddress: '0xnew', oldAddress: '0xold', chainId: 8453, valueUsd: 2_000 },
      ],
    })
    const c = cards.find((x) => x.kind === 'superseded')!
    expect(c.headline).toBe('$ALPHA has a newer version, $ALPHA2 — its creator published an upgrade.')
    // the action opens the REAL migrate review right on the card — from, to
    // and CHAIN all carried (the chainless-link class from audit 2026-08-12
    // stays dead: the payload names the chain explicitly)
    expect(c.action).toEqual({
      kind: 'migrate',
      fromAddr: '0xold',
      fromSymbol: 'ALPHA',
      toAddr: '0xnew',
      toSymbol: 'ALPHA2',
      chainId: 8453,
      label: 'Swap into $ALPHA2 →',
    })
    // facts-only: no urgency words, and the detail SAYS the old version keeps working
    expect(c.headline + c.detail).not.toMatch(/urgent|must|now!|immediately|deprecated/i)
    expect(c.detail).toMatch(/stays fully functional/)
    // his ruling: top of the strip — nothing outranks a superseded card
    expect(Math.max(...cards.map((x) => x.magnitude))).toBe(c.magnitude)
  })
  it('absent input produces no card — silence stays valid', () => {
    expect(buildInsights({ ...base, superseded: null }).filter((c) => c.kind === 'superseded')).toHaveLength(0)
  })
})

describe('the partial-bundle prompt (owner 2026-08-16: a stranded 2-of-3 buy must not be forgotten)', () => {
  const base = {
    positions: [{ key: '8453:0xleg', symbol: 'WETH', valueUsd: 2_000, pct: 100, tier: 'majors' as const, sourceCount: 1, liquidityUsd: null }],
    totalUsd: 2_000,
    networks: 1,
    unpricedCount: 0,
  }
  it('a partly-held bundle states the count, the missing networks, and the completion door', () => {
    const cards = buildInsights({
      ...base,
      partialBundles: [
        { name: 'test50055', heldCount: 2, totalCount: 3, missingWords: 'RH', href: '/bundle/0xdead/test50055', heldUsd: 60 },
      ],
    })
    const c = cards.find((x) => x.kind === 'partial-bundle')!
    expect(c.headline).toBe('You hold 2 of 3 networks of test50055 — the bundle is incomplete.')
    expect(c.detail).toMatch(/Missing on RH/)
    expect(c.action).toEqual({ kind: 'goto', href: '/bundle/0xdead/test50055', label: 'Complete the bundle →' })
    expect(c.mark).toEqual({ form: 'share', pct: (2 / 3) * 100 })
  })
  it('absent input produces no card — the caller only hands in true partials', () => {
    expect(buildInsights({ ...base, partialBundles: null }).filter((c) => c.kind === 'partial-bundle')).toHaveLength(0)
  })
})

describe('audit round 4 (2026-08-04): a stated fact may not be impossible or self-contradicting', () => {
  const one = {
    positions: [{ key: '8453:0xa', symbol: 'X', valueUsd: 1000, pct: 100, tier: 'majors' as const, sourceCount: 1, liquidityUsd: null }],
    totalUsd: 1000,
    networks: 1,
    unpricedCount: 0,
  }

  it('a baseline share outside 0-100 is NOT a share — no drift card off a corrupt stored plan', () => {
    // Before: "$X is now 100% of your plan, down from 1000000000%" — rendered
    // as a stated fact about the user's own plan.
    const cards = buildInsights({ ...one, baseline: { at: 1, shares: { '8453:0xa': 1e9 }, bandPp: 5 } })
    expect(cards.filter((c) => c.kind === 'drift')).toHaveLength(0)
    const neg = buildInsights({ ...one, baseline: { at: 1, shares: { '8453:0xa': -20 }, bandPp: 5 } })
    expect(neg.filter((c) => c.kind === 'drift')).toHaveLength(0)
  })

  it('an in-range baseline share still drifts normally — the bound is not a blanket', () => {
    const cards = buildInsights({ ...one, baseline: { at: 1, shares: { '8453:0xa': 40 }, bandPp: 5 } })
    expect(cards.filter((c) => c.kind === 'drift')).toHaveLength(1)
  })

  it('an inverted swing pair produces NO card — a sentence cannot disagree with itself', () => {
    // Before: "the worst week would have moved 10.0%; the best week, -10.0%"
    const bad = buildInsights({ ...one, swing: { worstPct: 10, bestPct: -10, included: 2, considered: 2, coveredSharePct: 100, days: 30 } })
    expect(bad.filter((c) => c.kind === 'swing')).toHaveLength(0)
  })

  it('a well-ordered swing pair still speaks', () => {
    const ok = buildInsights({ ...one, swing: { worstPct: -5.3, bestPct: 4.1, included: 2, considered: 2, coveredSharePct: 100, days: 30 } })
    expect(ok.filter((c) => c.kind === 'swing')).toHaveLength(1)
  })
})
