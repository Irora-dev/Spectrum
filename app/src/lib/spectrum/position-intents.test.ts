import { describe, expect, it } from 'vitest'
import { composeRebalance, type PositionRow } from './position-intents'
import { MAX_ALLOCATION_ASSETS, type AllocAsset } from './allocation'

const A = (sym: string, chainId = 8453): AllocAsset => ({
  chainId,
  address: `0x${Array.from(sym).map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(40, '0')}`,
  symbol: sym,
})

const P = (sym: string, valueUsd: number, pct = 0): PositionRow => ({ asset: A(sym), valueUsd, pct })

const wsum = (r: ReturnType<typeof composeRebalance>) => r.targets.reduce((s, t) => s + t.weight, 0)

describe('composeRebalance', () => {
  it('a sell reduces the position and weights re-sum to exactly 100', () => {
    const r = composeRebalance([P('WETH', 600), P('DEGEN', 400)], [{ kind: 'sell', asset: A('WETH'), usd: 300 }])
    expect(wsum(r)).toBe(100)
    const weth = r.targets.find((t) => t.asset.symbol === 'WETH')!
    const degen = r.targets.find((t) => t.asset.symbol === 'DEGEN')!
    expect(weth.weight).toBeLessThan(degen.weight)
    expect(r.soldUsd).toBe(300)
  })

  it('sells clamp at the held value — never oversold', () => {
    const r = composeRebalance([P('WETH', 200)], [{ kind: 'sell', asset: A('WETH'), usd: 999 }])
    expect(r.soldUsd).toBe(200)
    expect(r.targets).toHaveLength(0) // sold out entirely
  })

  it('selling a position entirely removes it from the mix', () => {
    const r = composeRebalance([P('WETH', 500), P('DEGEN', 500)], [{ kind: 'sell', asset: A('WETH'), usd: 500 }])
    expect(r.targets.map((t) => t.asset.symbol)).toEqual(['DEGEN'])
    expect(wsum(r)).toBe(100)
  })

  it('a buy of a NEW asset joins the mix and counts as deployed amount', () => {
    const r = composeRebalance([P('WETH', 900)], [{ kind: 'buy', asset: A('BANKR'), usd: 100 }])
    expect(r.targets.map((t) => t.asset.symbol).sort()).toEqual(['BANKR', 'WETH'])
    expect(r.amountUsd).toBe(100)
    expect(wsum(r)).toBe(100)
    expect(r.targets.find((t) => t.asset.symbol === 'BANKR')!.weight).toBe(10)
  })

  it('sell-to-buy composes both sides (the rebalance shape)', () => {
    const r = composeRebalance(
      [P('WETH', 500), P('DEGEN', 500)],
      [
        { kind: 'sell', asset: A('WETH'), usd: 250 },
        { kind: 'buy', asset: A('AERO'), usd: 250 },
      ],
    )
    expect(r.soldUsd).toBe(250)
    expect(r.boughtUsd).toBe(250)
    expect(r.targets.map((t) => t.asset.symbol).sort()).toEqual(['AERO', 'DEGEN', 'WETH'])
    expect(wsum(r)).toBe(100)
  })

  it('an unheld sell composes to nothing (never invents a position)', () => {
    const r = composeRebalance([P('WETH', 100)], [{ kind: 'sell', asset: A('GHOST'), usd: 50 }])
    expect(r.soldUsd).toBe(0)
    expect(r.targets.map((t) => t.asset.symbol)).toEqual(['WETH'])
  })
})

describe('audit-pinned cases (PM adversarial audit 2026-08-02)', () => {
  it('net semantics: sell-funded buys report zero new money', () => {
    const r = composeRebalance(
      [P('WETH', 1000), P('DEGEN', 1000)],
      [
        { kind: 'sell', asset: A('WETH'), usd: 400 },
        { kind: 'buy', asset: A('AERO'), usd: 400 },
      ],
    )
    expect(r.newMoneyUsd).toBe(0)
    expect(r.amountUsd).toBe(0) // NET now (K2) — gross rides boughtUsd
    expect(r.boughtUsd).toBe(400)
    expect(r.soldUsd).toBe(400)
    expect(r.executable).toBe(true)
  })

  it('buys beyond sells report the difference as new money', () => {
    const r = composeRebalance([P('WETH', 1000)], [
      { kind: 'sell', asset: A('WETH'), usd: 100 },
      { kind: 'buy', asset: A('AERO'), usd: 350 },
    ])
    expect(r.newMoneyUsd).toBe(250)
  })

  it('sell-only composes executable with zero amount (never a dead end)', () => {
    const r = composeRebalance([P('WETH', 800), P('DEGEN', 200)], [{ kind: 'sell', asset: A('WETH'), usd: 400 }])
    expect(r.executable).toBe(true)
    expect(r.amountUsd).toBe(0)
    expect(r.soldUsd).toBe(400)
    expect(wsum(r)).toBe(100)
  })

  it('full exit refuses with the honest reason', () => {
    const r = composeRebalance([P('WETH', 500)], [{ kind: 'sell', asset: A('WETH'), usd: 500 }])
    expect(r.executable).toBe(false)
    expect(r.reason).toBe('full-exit')
  })

  it('more legs than the flow loads refuses instead of silently truncating', () => {
    // pinned to the CONSTANT, not a literal: the cap moved 12 → 50 (the owner
    // 2026-08-06 — his 13-asset book greyed out Review & Execute) and this
    // pin's job is the refusal-over-truncation LAW at whatever the cap is
    const positions = Array.from({ length: MAX_ALLOCATION_ASSETS }, (_, i) => P(`T${i.toString().padStart(2, '0')}`, 100))
    const r = composeRebalance(positions, [{ kind: 'buy', asset: A('NEWCOIN'), usd: 100 }])
    expect(r.targets.length).toBe(MAX_ALLOCATION_ASSETS + 1)
    expect(r.executable).toBe(false)
    expect(r.reason).toBe('too-many-legs')
  })

  it('a 13-asset book dials without hitting the cap (the 2026-08-06 bug, pinned)', () => {
    const positions = Array.from({ length: 13 }, (_, i) => P(`T${i.toString().padStart(2, '0')}`, 100))
    const r = composeRebalance(positions, [{ kind: 'sell', asset: A('T00'), usd: 50 }])
    expect(r.executable).toBe(true)
  })

  it('weights still sum to exactly 100 under heavy leg counts (≤100)', () => {
    const positions = Array.from({ length: 60 }, (_, i) => P(`H${i.toString().padStart(2, '0')}`, 1 + (i % 7)))
    const r = composeRebalance(positions, [])
    expect(r.targets.reduce((s, t) => s + t.weight, 0)).toBe(100)
  })
})

describe('cash legs (PM proof-audit K2 — the pile is composed now)', () => {
  const CASH = (usd: number) => P('USDC', usd)

  it('adds draw from held cash: the stable SELLS and no new money is invented', () => {
    const r = composeRebalance([CASH(500), P('WETH', 500)], [{ kind: 'buy', asset: A('WETH'), usd: 300 }])
    expect(r.cashDrawUsd).toBe(300)
    expect(r.newMoneyUsd).toBe(0)
    expect(r.amountUsd).toBe(0) // net — nothing to bring
    expect(r.soldUsd).toBe(300) // the cash sell is real
    const usdc = r.targets.find((t) => t.asset.symbol === 'USDC')!
    const weth = r.targets.find((t) => t.asset.symbol === 'WETH')!
    expect(usdc.weight).toBe(20) // 200 of 1000
    expect(weth.weight).toBe(80)
  })

  it('adds beyond trims + cash surface the difference as new money', () => {
    const r = composeRebalance([CASH(100), P('WETH', 500)], [{ kind: 'buy', asset: A('WETH'), usd: 300 }])
    expect(r.cashDrawUsd).toBe(100)
    expect(r.newMoneyUsd).toBe(200)
    expect(r.amountUsd).toBe(200)
  })

  it('pure trims credit the pile: 500→300 with USDC held composes 70/30, not 62/38', () => {
    const r = composeRebalance([CASH(500), P('WETH', 500)], [{ kind: 'sell', asset: A('WETH'), usd: 200 }])
    expect(r.cashCreditUsd).toBe(200)
    const usdc = r.targets.find((t) => t.asset.symbol === 'USDC')!
    const weth = r.targets.find((t) => t.asset.symbol === 'WETH')!
    expect(usdc.weight).toBe(70)
    expect(weth.weight).toBe(30)
  })

  it('trims with NO stable held mark cashless instead of pretending', () => {
    const r = composeRebalance([P('WETH', 500), P('DEGEN', 500)], [{ kind: 'sell', asset: A('WETH'), usd: 200 }])
    expect(r.cashless).toBe(true)
    expect(r.cashCreditUsd).toBe(0)
    expect(r.executable).toBe(true)
  })
})

describe('audit round 5 (2026-08-04): nothing unreadable enters the money math', () => {
  const P = (symbol: string, valueUsd: number) => ({
    asset: { chainId: 8453, address: `0x${symbol.toLowerCase().padEnd(40, '0')}` as `0x${string}`, symbol },
    valueUsd,
    pct: 0,
    kind: 'token' as const,
  })
  const I = (kind: 'sell' | 'buy', symbol: string, usd: number) => ({
    kind,
    asset: { chainId: 8453, address: `0x${symbol.toLowerCase().padEnd(40, '0')}` as `0x${string}`, symbol },
    usd,
  })

  it('a NaN intent amount does NOT reach amountUsd — the figure the confirm gates on', () => {
    // Before: soldUsd NaN → amountUsd NaN, and `NaN == null` is false, so the
    // set-an-amount gate would have passed it straight to a confirm.
    const r = composeRebalance([P('WETH', 1000), P('USDC', 500)], [I('sell', 'WETH', Number.NaN), I('buy', 'AERO', 200)])
    expect(Number.isFinite(r.soldUsd)).toBe(true)
    expect(Number.isFinite(r.amountUsd)).toBe(true)
  })

  it('an Infinite buy cannot claim infinite new money', () => {
    const r = composeRebalance([P('USDC', 500)], [I('buy', 'AERO', Number.POSITIVE_INFINITY)])
    expect(Number.isFinite(r.amountUsd)).toBe(true)
    expect(r.amountUsd).toBe(0)
  })

  it('a position whose value did not read is not tradeable — dropped, never treated as zero', () => {
    const r = composeRebalance([P('WETH', Number.NaN), P('USDC', 500)], [I('sell', 'WETH', 100), I('buy', 'AERO', 200)])
    expect(Number.isFinite(r.soldUsd)).toBe(true)
    // the unreadable WETH contributes no proceeds: the buy is funded from cash
    expect(r.cashDrawUsd).toBeGreaterThan(0)
  })

  it('every composed figure is finite across hostile inputs', () => {
    const hostile = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]
    for (const n of hostile) {
      const r = composeRebalance([P('WETH', 1000), P('USDC', 500)], [I('sell', 'WETH', n), I('buy', 'AERO', n)])
      // every NUMBER the composer emits, whatever its name — the invariant is
      // "no non-finite figure leaves this function", not a hand-listed set
      for (const [field, v] of Object.entries(r)) {
        if (typeof v === 'number') expect(Number.isFinite(v), `${field} = ${v}`).toBe(true)
      }
      for (const t of r.targets) expect(Number.isFinite(t.weight)).toBe(true)
    }
  })
})

describe('mutation-survivor kills, the bounded final round — composeRebalance/toWeights', () => {
  const CASH = { cashSymbols: new Set(['USDC', 'USDT']) }

  it('THE SHAVE LOOP FINALLY RUNS: dust legs floored to 1 push the sum past 100, and the shave takes it back from the big leg only', () => {
    // 11 × $0.50 dust + $94.50 big: floors give 11×1 + 94 = 105 — the whole
    // while(sum>100) block had NEVER executed in any suite (every mutant in it
    // survived, including `while(false)`).
    const positions = [...Array.from({ length: 11 }, (_, i) => P(`D${i}`, 0.5)), P('BIG', 94.5)]
    const r = composeRebalance(positions, [])
    expect(wsum(r)).toBe(100)
    const big = r.targets.find((t) => t.asset.symbol === 'BIG')!
    expect(big.weight).toBe(89) // 94 floored, shaved 5
    for (const t of r.targets) if (t.asset.symbol !== 'BIG') expect(t.weight).toBe(1) // the 1-floor is never shaved
  })

  it('the remainder units go by LARGEST FRACTION, not by index or corrupted ordering', () => {
    // exact shares 33.8 / 33.5 / 32.7 → floors 33/33/32, and the two remainder
    // units land on the .8 and .7 fractions — an index-ordered or corrupted
    // distribution would hand the second unit to BB instead
    const r = composeRebalance([P('AA', 33.8), P('BB', 33.5), P('CC', 32.7)], [])
    const w = Object.fromEntries(r.targets.map((t) => [t.asset.symbol, t.weight]))
    expect(w).toEqual({ AA: 34, BB: 33, CC: 33 })
  })

  it('the dust boundary is strict: exactly $0.005 is OUT, just above it is IN', () => {
    const out = composeRebalance([P('DUST', 0.005)], [])
    expect(out.targets).toHaveLength(0)
    expect(out.executable).toBe(false)
    expect(out.reason).toBe('empty') // nothing sold — this is emptiness, not an exit
    const kept = composeRebalance([P('DUST', 0.006)], [])
    expect(kept.targets).toHaveLength(1)
  })

  it('CASH DRAW IS EXACTLY bought − sold, drawn proportionally and capped by the pile (the sign-flip mutant doubled it)', () => {
    const r = composeRebalance(
      [P('TOK', 100), P('USDC', 50)],
      [
        { kind: 'sell', asset: A('TOK'), usd: 20 },
        { kind: 'buy', asset: A('NEW'), usd: 50 },
      ],
      CASH,
    )
    expect(r.cashDrawUsd).toBe(30) // 50 bought − 20 trimmed, NOT 70
    expect(r.soldUsd).toBe(50) // the 20 trim + the 30 composed cash sell
    expect(r.amountUsd).toBe(0) // fully funded from trims + cash: no new money
    const usdc = r.targets.find((t) => t.asset.symbol === 'USDC')
    // the pile shrank to 20 of a 130 book (~15%) — the draw genuinely left it
    expect(usdc && usdc.weight <= 16).toBe(true)
  })

  it('LEFTOVER PROCEEDS CREDIT THE LARGEST STABLE, exactly sold − bought, and a credited rebalance is NOT cashless', () => {
    const r = composeRebalance(
      [P('TOK', 100), P('USDT', 5), P('USDC', 25)],
      [
        { kind: 'sell', asset: A('TOK'), usd: 40 },
        { kind: 'buy', asset: A('NEW'), usd: 10 },
      ],
      CASH,
    )
    expect(r.cashCreditUsd).toBe(30) // 40 sold − 10 bought, NOT 50
    expect(r.cashless).toBe(false)
    // the LARGEST stable (USDC 25 → 55) received it; USDT stayed at 5 (≈5.5%)
    const w = Object.fromEntries(r.targets.map((t) => [t.asset.symbol, t.weight]))
    expect(w.USDC).toBeGreaterThan(w.USDT * 8)
    expect(w.USDT).toBeLessThanOrEqual(6)
  })

  it('a whole-book exit reads full-exit; an empty book reads empty — the two refusals never swap', () => {
    const exit = composeRebalance([P('TOK', 100)], [{ kind: 'sell', asset: A('TOK'), usd: 100 }])
    expect(exit.executable).toBe(false)
    expect(exit.reason).toBe('full-exit')
    const empty = composeRebalance([], [])
    expect(empty.executable).toBe(false)
    expect(empty.reason).toBe('empty')
  })
})
