import { describe, expect, it } from 'vitest'
import type { PortfolioSnapshot } from './portfolio'
import { evaluateRules, type Rule } from './rules'

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    v: 1,
    at: 1_700_000_000_000,
    address: '0xabc',
    totalUsd: 10_000,
    change24hPct: null,
    change24hExcluded: 0,
    heldCount: 1,
    createdCount: 0,
    assets: [],
    held: [],
    created: [],
    chainIds: [8453],
    chainsFailed: [],
    ...over,
  }
}

const asset = (key: string, symbol: string, pct: number) => ({
  key,
  address: key.split(':')[1],
  symbol,
  chainId: Number(key.split(':')[0]),
  pct,
  valueUsd: 100,
  basketCount: 1,
})

describe('drift rule', () => {
  const rule: Rule = { id: 'r1', type: 'drift', enabled: true, pts: 3 }

  it('fires per asset at or beyond the threshold, with factual copy', () => {
    const s = snap({ assets: [asset('8453:0x1', 'WETH', 31.2), asset('8453:0x2', 'USDC', 24)] })
    const targets = { '8453:0x1': 25, '8453:0x2': 25 }
    const out = evaluateRules({ rules: [rule], snapshot: s, prev: null, targets })
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('drift:r1:8453:0x1')
    expect(out[0].title).toBe('WETH is +6.2pts over target')
    expect(out[0].body).toContain('Target 25.0%')
    expect(out[0].body).toContain('now 31.2%')
  })

  it('is quiet with no targets and quiet under the threshold', () => {
    const s = snap({ assets: [asset('8453:0x1', 'WETH', 27)] })
    expect(evaluateRules({ rules: [rule], snapshot: s, prev: null, targets: {} })).toHaveLength(0)
    expect(evaluateRules({ rules: [rule], snapshot: s, prev: null, targets: { '8453:0x1': 25 } })).toHaveLength(0)
  })

  it('never uses advice words', () => {
    const s = snap({ assets: [asset('8453:0x1', 'WETH', 40)] })
    const out = evaluateRules({ rules: [rule], snapshot: s, prev: null, targets: { '8453:0x1': 20 } })
    const text = (out[0].title + out[0].body).toLowerCase()
    for (const banned of ['rebalance', 'consider', 'should', 'recommend', 'buy', 'sell']) {
      expect(text).not.toContain(banned)
    }
  })
})

describe('value rule', () => {
  const rule: Rule = { id: 'r2', type: 'value', enabled: true, aboveUsd: 12_000, belowUsd: 8_000 }

  it('fires only on a crossing since the previous read', () => {
    const prev = snap({ totalUsd: 11_000 })
    const now = snap({ totalUsd: 12_500 })
    const out = evaluateRules({ rules: [rule], snapshot: now, prev, targets: {} })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Portfolio crossed above $12,000')
  })

  it('does not fire without a previous read, or already past the line', () => {
    const now = snap({ totalUsd: 12_500 })
    expect(evaluateRules({ rules: [rule], snapshot: now, prev: null, targets: {} })).toHaveLength(0)
    const prevAlreadyAbove = snap({ totalUsd: 12_100 })
    expect(evaluateRules({ rules: [rule], snapshot: now, prev: prevAlreadyAbove, targets: {} })).toHaveLength(0)
  })

  it('ignores a previous snapshot for a different address', () => {
    const prev = snap({ totalUsd: 11_000, address: '0xother' })
    const now = snap({ totalUsd: 12_500 })
    expect(evaluateRules({ rules: [rule], snapshot: now, prev, targets: {} })).toHaveLength(0)
  })

  it('fires the downward crossing', () => {
    const prev = snap({ totalUsd: 9_000 })
    const now = snap({ totalUsd: 7_500 })
    const out = evaluateRules({ rules: [rule], snapshot: now, prev, targets: {} })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Portfolio crossed below $8,000')
  })
})

describe('move rule', () => {
  const rule: Rule = { id: 'r3', type: 'move', enabled: true, pct: 5 }
  const held = (symbol: string, change24hPct: number | null) => ({
    chainId: 4663,
    address: `0x${symbol.toLowerCase()}`,
    symbol,
    name: symbol,
    balance: 1,
    valueUsd: 500,
    change24hPct,
  })

  it('fires for held baskets at or beyond the move, skips unpriced ones', () => {
    const s = snap({ held: [held('AAA', 7.5), held('BBB', -6.2), held('CCC', 4.9), held('DDD', null)] })
    const out = evaluateRules({ rules: [rule], snapshot: s, prev: null, targets: {} })
    expect(out.map((f) => f.title)).toEqual(['AAA moved +7.5% over 24h', 'BBB moved -6.2% over 24h'])
    expect(out[0].intent).toEqual({ token: { address: '0xaaa', chainId: 4663 } })
  })
})

describe('notification text hygiene', () => {
  it('caps and collapses attacker-mintable symbols (airdropped spam baskets)', () => {
    const rule: Rule = { id: 'r', type: 'move', enabled: true, pct: 5 }
    const s = snap({
      held: [
        {
          chainId: 8453,
          address: '0xspam',
          symbol: '  VISIT\nCLAIM-REWARDS-NOW-AT-EVIL-DOT-COM-FOR-FREE-MONEY  ',
          name: 'spam',
          balance: 1,
          valueUsd: 5,
          change24hPct: 50,
        },
      ],
    })
    const [f] = evaluateRules({ rules: [rule], snapshot: s, prev: null, targets: {} })
    expect(f.title).toBe('VISIT CLAIM-REWARDS-NOW-… moved +50.0% over 24h')
    expect(f.title).not.toContain('\n')
  })
})

describe('rule gating', () => {
  it('disabled rules never fire', () => {
    const s = snap({ assets: [asset('8453:0x1', 'WETH', 40)], held: [] })
    const rules: Rule[] = [
      { id: 'a', type: 'drift', enabled: false, pts: 1 },
      { id: 'b', type: 'move', enabled: false, pct: 1 },
    ]
    expect(evaluateRules({ rules, snapshot: s, prev: null, targets: { '8453:0x1': 10 } })).toHaveLength(0)
  })
})

describe('partial reads never alarm (a failed chain is not a position change)', () => {
  it('drift is silent when any chain failed this read — a missing chain reads as under-target', () => {
    const rule: Rule = { id: 'r', type: 'drift', enabled: true, pts: 3 }
    // Mainnet failed; its targeted asset is absent → would fire -20pts without the gate.
    const s = snap({ assets: [asset('8453:0x1', 'WETH', 100)], chainsFailed: [1] })
    const targets = { '8453:0x1': 50, '1:0x2': 20 }
    expect(evaluateRules({ rules: [rule], snapshot: s, prev: null, targets })).toHaveLength(0)
  })

  it('value crossings need BOTH reads complete — an outage dip and its recovery are not crossings', () => {
    const rule: Rule = { id: 'r', type: 'value', enabled: true, belowUsd: 8_000, aboveUsd: 12_000 }
    const clean = snap({ totalUsd: 13_000 })
    const outage = snap({ totalUsd: 7_000, chainsFailed: [1] })
    // The dip (clean → degraded): silent.
    expect(evaluateRules({ rules: [rule], snapshot: outage, prev: clean, targets: {} })).toHaveLength(0)
    // The recovery (degraded → clean): silent too.
    expect(evaluateRules({ rules: [rule], snapshot: clean, prev: outage, targets: {} })).toHaveLength(0)
  })

  it('move still fires on a degraded read — the basket that answered really did move', () => {
    const rule: Rule = { id: 'r', type: 'move', enabled: true, pct: 5 }
    const s = snap({
      chainsFailed: [1],
      held: [{ chainId: 8453, address: '0xok', symbol: 'OK', name: 'Ok', balance: 1, valueUsd: 100, change24hPct: 9 }],
    })
    const out = evaluateRules({ rules: [rule], snapshot: s, prev: null, targets: {} })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('OK moved +9.0% over 24h')
  })
})
