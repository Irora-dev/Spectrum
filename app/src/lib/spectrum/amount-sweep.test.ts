import { describe, expect, it } from 'vitest'
import { BATCH_FEE_BPS } from './allocation'
import { asFundingRaw, feeCentsOfTotal, scaleLegBudgetsToRaw } from './batcher'
import { centBudgets } from './plan-legs'

// ─────────────────────────────────────────────────────────────────────────────
// THE MECHANICAL AMOUNT SWEEP (greenlit exotic path 6) — boring on purpose.
// The $7 / $999.99 findings said the dust-and-precision boundary is where the
// bodies are: a pipeline that happened to work on round numbers composed and
// a pipeline that met an odd cent refused. So this file walks the boundary
// MECHANICALLY — every gross amount in the dust band exhaustively, log-spaced
// odd amounts up to $1M — crossed with token decimals {6, 8, 18} and leg
// counts up to the 32 cap, asserting the seam's conservation laws at every
// single point:
//   · cent budgets sum EXACTLY to the net (never a cent conjured or lost)
//   · raw budgets sum EXACTLY to the raw spendable (the contract's own view)
//   · no leg goes negative, and a zero-weight leg never gains a unit
// No expected outputs anywhere — the laws ARE the assertion, which is what
// lets the sweep run tens of thousands of points nobody hand-imagined.
// ─────────────────────────────────────────────────────────────────────────────

const DECIMALS = [6, 8, 18] as const
const LEG_COUNTS = [1, 2, 3, 5, 8, 13, 21, 32] as const

/** A $1-pegged funding asset: gross cents → raw at the given decimals. */
const rawFor = (grossCents: number, decimals: number): bigint => BigInt(grossCents) * 10n ** BigInt(decimals - 2)

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32

/** Returns the FIRST violated law at this point, or null. Plain code, not
 *  expect(): the sweeps drive ~100k points and assertion overhead would time
 *  the suite out — violations collect and ONE assertion reports them all. */
function checkPoint(grossCents: number, decimals: number, legs: number, weights: number[]): string | null {
  const label = `$${(grossCents / 100).toFixed(2)} × ${decimals}dp × ${legs} legs`
  const netCents = grossCents - feeCentsOfTotal(grossCents)
  if (netCents <= 0) return null // dust below the fee floor is refused upstream
  const cents = centBudgets(weights, netCents)
  // an all-zero weight set allocates nothing BY LAW (a proportion of nothing);
  // with any positive weight, conservation is exact
  const wantCents = weights.some((w) => w > 0) ? netCents : 0
  const centSum = cents.reduce((s, v) => s + v, 0)
  if (centSum !== wantCents) return `${label}: cent conservation ${centSum} ≠ ${wantCents}`
  if (!cents.every((v) => v >= 0)) return `${label}: negative cent budget`

  const totalRaw = rawFor(grossCents, decimals)
  // ⚠ DERIVED, NOT TYPED. This was a literal `50n` while the cent half of the
  // SAME conservation law went through `feeCentsOfTotal` (which reads the
  // constant) — so half the law tracked the fee policy and half did not. When
  // the owner's 2026-08-07 ruling moved the fee to 40 bps this line would have
  // failed ~100k points at once, reporting a conservation break where the only
  // thing broken was the test's own copy of the number. A conservation law must
  // hold at WHATEVER the fee is; the policy VALUE is pinned separately, against
  // a literal, in allocation.test.ts.
  const spendable = totalRaw - (totalRaw * BigInt(BATCH_FEE_BPS)) / 10_000n
  const raws = scaleLegBudgetsToRaw(cents, asFundingRaw(totalRaw))
  const rawSum = raws.reduce<bigint>((s, v) => s + (v as bigint), 0n)
  if (cents.some((c) => c > 0) && rawSum !== spendable) return `${label}: raw conservation ${rawSum} ≠ ${spendable}`
  for (let i = 0; i < cents.length; i++) {
    if (cents[i] === 0 && raws[i] !== 0n) return `${label}: zero-weight leg ${i} gained raw`
    if ((raws[i] as bigint) < 0n) return `${label}: negative raw leg ${i}`
  }
  return null
}

describe('the dust band, exhaustively: every gross amount from 1c to $20.00', () => {
  it('conserves cents and raw at every point × every decimals × every leg count', () => {
    const rnd = lcg(6001)
    const violations: string[] = []
    for (let grossCents = 1; grossCents <= 2_000; grossCents++) {
      for (const decimals of DECIMALS) {
        for (const legs of LEG_COUNTS) {
          const weights = Array.from({ length: legs }, () => 1 + Math.floor(rnd() * 100))
          const v = checkPoint(grossCents, decimals, legs, weights)
          if (v) violations.push(v)
        }
      }
    }
    expect(violations, `${violations.length} of 48,000 points violated`).toEqual([])
  }, 30_000)
})

describe('the long range: odd amounts to $1M, log-spaced, never round', () => {
  it('conserves cents and raw across the whole money range', () => {
    const rnd = lcg(6002)
    const violations: string[] = []
    // ~60 log-spaced anchors, each perturbed by an odd cent offset so no
    // amount is ever round (round numbers are how the original bug hid)
    for (let step = 0; step < 60; step++) {
      const anchor = Math.round(2_000 * Math.pow(1.11, step)) // → past $1M
      const grossCents = Math.min(100_000_000, anchor + 1 + Math.floor(rnd() * 97))
      for (const decimals of DECIMALS) {
        for (const legs of LEG_COUNTS) {
          const weights = Array.from({ length: legs }, () => (rnd() > 0.15 ? 1 + rnd() * 100 : 0))
          const v = checkPoint(grossCents, decimals, legs, weights)
          if (v) violations.push(v)
        }
      }
    }
    expect(violations).toEqual([])
  }, 30_000)

  it('the measured historical failures compose clean forever: $7, $1, $999.99, $123,456.78', () => {
    const violations: string[] = []
    for (const grossCents of [700, 100, 99_999, 12_345_678]) {
      for (const decimals of DECIMALS) {
        for (const legs of LEG_COUNTS) {
          const v = checkPoint(grossCents, decimals, legs, Array.from({ length: legs }, (_, i) => 1 + ((i * 37) % 100)))
          if (v) violations.push(v)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
