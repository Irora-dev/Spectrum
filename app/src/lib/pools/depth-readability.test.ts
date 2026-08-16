import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// UNREADABLE DEPTH IS NOT DEEP DEPTH.
//
// The class, from specallocator's pool-safety finding (2026-08-07): a guard
// written for ONE spelling of missing lets the other one through. `!= null`
// admits NaN, and every subsequent `<` comparison against NaN is false — so a
// pool of UNKNOWN depth walks past a floor written to stop shallow ones.
//
// It was reachable here through the launch flow rather than theoretical:
// DexScreener responses are `as`-cast, never validated, and `?? 0` defends only
// against null/undefined, so a non-numeric `liquidity.usd` entered as a "number"
// TypeScript believed in. The remedy is at BOTH ends — validate where the value
// enters (finiteUsd), and make the guards test finiteness rather than nullness —
// and these pin the arithmetic that makes both necessary.
// ─────────────────────────────────────────────────────────────────────────────

/** The boundary rule, mirroring `finiteUsd` in find-best-pool.ts. */
const finiteUsd = (v: unknown): number | null => {
  if (typeof v === 'string' && v.trim() === '') return null // Number('') is 0, not NaN
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

describe('the NaN that the old guard shape let through', () => {
  it('passes a != null check while failing every comparison — both at once', () => {
    const depth = Number.NaN
    expect(depth != null).toBe(true) // the guard says "we have a value"
    expect(depth < 20_000).toBe(false) // …and the floor never fires
    expect(depth <= 50_000).toBe(false) // …nor the softer warning
    expect(depth > 20_000).toBe(false) // it is not "deep" either — it is nothing
  })

  it('poisons a sort comparator rather than ordering badly', () => {
    // (b ?? 0) - (a ?? 0) is the ranking in find-best-pool; ?? does NOT catch NaN
    const unreadable: number | null = Number.NaN
    expect(unreadable ?? 0).toBeNaN() // ?? sees a number, so NaN survives it
    expect(Number.isNaN((unreadable ?? 0) - 5)).toBe(true)
  })
})

describe('finiteUsd — only a real, non-negative figure gets through', () => {
  it('keeps honest numbers, including zero', () => {
    expect(finiteUsd(0)).toBe(0)
    expect(finiteUsd(12_345.6)).toBe(12_345.6)
  })

  it('accepts a numeric STRING, which is how an API actually sends money', () => {
    expect(finiteUsd('12345.6')).toBe(12_345.6)
  })

  it('refuses every shape that would become NaN downstream', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, 'abc', '', null, undefined, {}, [], true]) {
      expect(finiteUsd(bad)).toBeNull()
    }
  })

  it('refuses a negative figure — depth below zero is a broken read, not a small pool', () => {
    expect(finiteUsd(-1)).toBeNull()
    expect(finiteUsd('-250')).toBeNull()
  })
})
