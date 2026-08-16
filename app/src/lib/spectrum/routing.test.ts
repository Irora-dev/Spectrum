import { describe, expect, it } from 'vitest'
import { pickRoute } from './routing'

describe('pickRoute — net of gas, both arms (readiness B1)', () => {
  it('THE PM-NAMED INVERSION: gross favors the aggregator, net favors direct on a small leg', () => {
    // $100 leg on mainnet: aggregator delivers $99.80 gross via 3 hops at $12
    // gas; direct delivers $99.20 via one pool at $4 gas.
    const v = pickRoute({ outUsd: 99.2, gasCostUsd: 4 }, { outUsd: 99.8, gasCostUsd: 12 })
    expect(v.winner).toBe('direct') // gross would have said aggregator
    expect(v.marginUsd).toBeCloseTo(7.4, 2)
    expect(v.raced).toBe(true)
  })

  it('the aggregator wins when it is genuinely better net', () => {
    const v = pickRoute({ outUsd: 990, gasCostUsd: 5 }, { outUsd: 1002, gasCostUsd: 9 })
    expect(v.winner).toBe('aggregator')
    expect(v.marginUsd).toBeCloseTo(8, 2)
  })

  it('no aggregator quote = direct uncontested (policy rule 5), never an error', () => {
    const v = pickRoute({ outUsd: 100, gasCostUsd: 3 }, null)
    expect(v).toEqual({ winner: 'direct', marginUsd: null, raced: false, uneconomic: false })
  })

  it('unreadable gas on EITHER arm kills the race — a gross comparison never runs', () => {
    expect(pickRoute({ outUsd: 100, gasCostUsd: null }, { outUsd: 110, gasCostUsd: 2 }).winner).toBe('direct')
    expect(pickRoute({ outUsd: 100, gasCostUsd: 3 }, { outUsd: 110, gasCostUsd: null }).winner).toBe('direct')
    expect(pickRoute({ outUsd: 100, gasCostUsd: null }, { outUsd: 110, gasCostUsd: 2 }).raced).toBe(false)
  })

  it('ties fall to direct — our own route, no third-party allowance', () => {
    const v = pickRoute({ outUsd: 100, gasCostUsd: 2 }, { outUsd: 101, gasCostUsd: 3 })
    expect(v.winner).toBe('direct')
    expect(v.marginUsd).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT ROUND (2026-08-04): this module was in NEITHER half of the battle test.
// Four findings, each pinned. Probed from outside the suite.
// ─────────────────────────────────────────────────────────────────────────────

describe('the audit round: unreadable means unreadable, whatever shape it arrives in', () => {
  it('a NaN gas cost KILLS the race — the law was written for null and NaN walked past it', () => {
    // Before: raced:true with marginUsd NaN, and the review would have rendered
    // "direct route won by $NaN".
    const v = pickRoute({ outUsd: 100, gasCostUsd: 5 }, { outUsd: 100, gasCostUsd: Number.NaN })
    expect(v).toEqual({ winner: 'direct', marginUsd: null, raced: false, uneconomic: false })
  })

  it('an Infinite gas cost kills it too', () => {
    const v = pickRoute({ outUsd: 100, gasCostUsd: 5 }, { outUsd: 100, gasCostUsd: Number.POSITIVE_INFINITY })
    expect(v.raced).toBe(false)
    expect(v.marginUsd).toBeNull()
  })

  it('a NaN or Infinite DELIVERY kills it on either arm', () => {
    expect(pickRoute({ outUsd: Number.NaN, gasCostUsd: 1 }, { outUsd: 100, gasCostUsd: 1 }).raced).toBe(false)
    expect(pickRoute({ outUsd: 100, gasCostUsd: 1 }, { outUsd: Number.POSITIVE_INFINITY, gasCostUsd: 1 }).raced).toBe(false)
  })

  it('a NEGATIVE gas cost is unreadable, not free money', () => {
    // Before: the aggregator claimed −$1,000 of gas and won by $1,005.
    const v = pickRoute({ outUsd: 100, gasCostUsd: 5 }, { outUsd: 100, gasCostUsd: -1000 })
    expect(v.winner).toBe('direct')
    expect(v.raced).toBe(false)
  })

  it('a NEGATIVE delivery is unreadable too — a quote is third-party data', () => {
    expect(pickRoute({ outUsd: 100, gasCostUsd: 5 }, { outUsd: -50, gasCostUsd: 1 }).raced).toBe(false)
  })

  it('marginUsd is NEVER NaN — an unreadable number ends the race instead of entering it', () => {
    const shapes: (number | null)[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, null]
    for (const g of shapes) {
      for (const v of [
        pickRoute({ outUsd: 100, gasCostUsd: 5 }, { outUsd: 100, gasCostUsd: g }),
        pickRoute({ outUsd: 100, gasCostUsd: g }, { outUsd: 100, gasCostUsd: 5 }),
      ]) {
        expect(v.marginUsd === null || Number.isFinite(v.marginUsd)).toBe(true)
      }
    }
  })
})

describe('the audit round: a tie has a WIDTH, and a losing race is not a win', () => {
  it('a sub-cent margin is a TIE and falls to direct — not worth a third-party allowance', () => {
    // Before: the aggregator "won" by a third of a cent, moving the money
    // through an extra spender for a margin that reports as $0.00.
    const v = pickRoute({ outUsd: 1000, gasCostUsd: 10 }, { outUsd: 1000.003, gasCostUsd: 10 })
    expect(v.winner).toBe('direct')
    expect(v.raced).toBe(true) // the race DID run; direct simply held
  })

  it('a real margin still flips the winner', () => {
    const v = pickRoute({ outUsd: 1000, gasCostUsd: 10 }, { outUsd: 1002, gasCostUsd: 10 })
    expect(v.winner).toBe('aggregator')
    expect(v.marginUsd).toBe(2)
  })

  it('a race BOTH arms lose is flagged uneconomic — gas exceeds delivery either way', () => {
    // Before: it just named a "winner", with no way for the review to know the
    // trade destroys value whichever arm runs.
    const v = pickRoute({ outUsd: 5, gasCostUsd: 40 }, { outUsd: 6, gasCostUsd: 30 })
    expect(v.uneconomic).toBe(true)
    expect(v.winner).toBe('aggregator') // still the better of two losses
  })

  it('a healthy race is never flagged uneconomic', () => {
    expect(pickRoute({ outUsd: 1000, gasCostUsd: 10 }, { outUsd: 1005, gasCostUsd: 10 }).uneconomic).toBe(false)
  })

  it('the margin is always the ABSOLUTE gap, never a negative "advantage"', () => {
    expect(pickRoute({ outUsd: 1000, gasCostUsd: 10 }, { outUsd: 900, gasCostUsd: 10 }).marginUsd).toBe(100)
    expect(pickRoute({ outUsd: 900, gasCostUsd: 10 }, { outUsd: 1000, gasCostUsd: 10 }).marginUsd).toBe(100)
  })
})
