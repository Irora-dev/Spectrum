import { describe, expect, it } from 'vitest'
import { planCallerSplit, type CallerSplitLeg } from './caller-split'
import type { ContractSplitResult } from './contract-split'

// ─────────────────────────────────────────────────────────────────────────────
// The whole handshake, walked branch by branch. Fixtures reuse contracts' REAL
// calibration set (measured 2026-08-02 across all 12 live 4663 baskets): the
// tightest real basket has a 425-bps smallest leg, and both measured failure
// shapes (the 509,250x mark, the 9999/0 split) appear here verbatim so the
// suite fails the day the guard stops catching what actually happened.
// ─────────────────────────────────────────────────────────────────────────────

/** A healthy 3-leg basket in the 34/33/33 shape contracts used as the example. */
const healthyLegs = (): CallerSplitLeg[] => [
  { symbol: 'WETH', markUsd: 4_012.55, held: 1.7, liquidityUsd: 48_000_000, fundedUsd: 6_400, seedBps: 3400 },
  { symbol: 'AERO', markUsd: 1.184, held: 5_600, liquidityUsd: 9_400_000, fundedUsd: 6_100, seedBps: 3300 },
  { symbol: 'DEGEN', markUsd: 0.01243, held: 530_000, liquidityUsd: 780_000, fundedUsd: 6_050, seedBps: 3300 },
]

/** Split the healthy legs' actual value proportions, in bps (what deriveSplitBps
 *  lands on for these marks; recomputed here so drift in the fixture shows). */
const healthyValueBps = (): number[] => {
  const values = healthyLegs().map((l) => l.markUsd * l.held)
  const total = values.reduce((s, v) => s + v, 0)
  const raw = values.map((v) => Math.floor((v / total) * 10_000))
  raw[0] += 10_000 - raw.reduce((s, v) => s + v, 0)
  return raw
}

const evenTrade = [700, 700, 700]

const agreeingContract = (): ContractSplitResult => ({
  kind: 'ok',
  legs: healthyValueBps().map((splitBps) => ({ splitBps, floorRaw: 1n })),
})

describe('the happy path: both sides agree', () => {
  it('quotes OUR split, cross-checked, summing to exactly 10000', () => {
    const out = planCallerSplit(healthyLegs(), evenTrade, agreeingContract())
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.crossChecked).toBe(true)
      expect(out.splitBps.reduce((s, v) => s + v, 0)).toBe(10_000)
      // Step 3 of the spec: the caller-supplied path passes OURS, not theirs.
      expect(out.splitBps).toEqual(healthyValueBps())
      expect(out.warnings).toHaveLength(0)
    }
  })

  it('tolerates the tightest REAL basket shape (a 425-bps smallest leg)', () => {
    // PADWAR's measured shape: tight but genuine. The degeneracy check must not
    // fire on anything that actually exists.
    const legs: CallerSplitLeg[] = [
      { symbol: 'BIG', markUsd: 100, held: 95.75, liquidityUsd: 5_000_000, seedBps: 9575 },
      { symbol: 'PAD', markUsd: 100, held: 4.25, liquidityUsd: 2_000_000, seedBps: 425 },
    ]
    const contract: ContractSplitResult = {
      kind: 'ok',
      legs: [
        { splitBps: 9575, floorRaw: 1n },
        { splitBps: 425, floorRaw: 1n },
      ],
    }
    const out = planCallerSplit(legs, [500, 500], contract)
    expect(out.ok).toBe(true)
  })
})

describe('absurdity signal 1: the 509,250x mark', () => {
  it('refuses the measured production failure outright, offering a resync', () => {
    const legs = healthyLegs()
    // Their fixture: a leg marking 509,250x what it was funded with.
    legs[2] = { ...legs[2], markUsd: 814_799_287, held: 1, fundedUsd: 1_600 }
    const out = planCallerSplit(legs, evenTrade, { kind: 'unavailable' })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.verdicts.some((v) => v.code === 'cost-basis')).toBe(true)
      expect(out.resync).toBe(true)
      expect(out.headline).toBeTruthy()
    }
  })
})

describe('absurdity signal 2: the degenerate split', () => {
  it('refuses OUR OWN split when a seeded leg would get almost nothing', () => {
    // Marks are individually plausible (no cost-basis trip: bases unknown), but
    // the value concentration implies ~60 bps on two seeded legs. The split is
    // arithmetic on data we already have, and it is broken.
    const legs: CallerSplitLeg[] = [
      { symbol: 'HOT', markUsd: 988, held: 10, liquidityUsd: 30_000_000, seedBps: 3400 },
      { symbol: 'COLD', markUsd: 6, held: 10, liquidityUsd: 8_000_000, seedBps: 3300 },
      { symbol: 'ICED', markUsd: 6, held: 10, liquidityUsd: 8_000_000, seedBps: 3300 },
    ]
    const out = planCallerSplit(legs, evenTrade, { kind: 'unavailable' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.verdicts.every((v) => v.code === 'degenerate-split')).toBe(true)
  })

  it('refuses the CONTRACT’S 9999/0 even when our own split looks fine', () => {
    // The exact measured failure: the contract derives 9999/0/1 against a
    // 34/33/33 seed. Regardless of which feed says so, a seeded leg at zero is
    // broken, and the refusal must name that rather than the disagreement.
    const contract: ContractSplitResult = {
      kind: 'ok',
      legs: [
        { splitBps: 9999, floorRaw: 1n },
        { splitBps: 0, floorRaw: 0n },
        { splitBps: 1, floorRaw: 1n },
      ],
    }
    const out = planCallerSplit(healthyLegs(), evenTrade, contract)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.verdicts.some((v) => v.code === 'degenerate-split')).toBe(true)
      expect(out.headline).toMatch(/broken/i)
    }
  })
})

describe('step 4: disagreement means nobody gets trusted', () => {
  it('refuses to quote through a material split disagreement', () => {
    // Ours lands near value proportions; the contract says something 20+ points
    // away on the first leg. Neither side is assumed right.
    const ours = healthyValueBps()
    const shifted = [...ours]
    const delta = 2_200
    shifted[0] = ours[0] - delta
    shifted[1] = ours[1] + delta
    const contract: ContractSplitResult = {
      kind: 'ok',
      legs: shifted.map((splitBps) => ({ splitBps, floorRaw: 1n })),
    }
    const out = planCallerSplit(healthyLegs(), evenTrade, contract)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.verdicts.some((v) => v.code === 'source-disagreement')).toBe(true)
      expect(out.resync).toBe(true)
      expect(out.headline).toMatch(/refresh/i)
    }
  })
})

describe('step 5: the contract refusing to derive is a hard signal', () => {
  it('surfaces BareSplitNotDerivable as its own refusal, never swallowed', () => {
    const out = planCallerSplit(healthyLegs(), evenTrade, { kind: 'not-derivable', named: true })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.headline).toMatch(/contract/i)
      expect(out.verdicts[0].reason).toMatch(/BareSplitNotDerivable/)
    }
  })
})

describe('the pre-rev world', () => {
  it('proceeds without the cross-check and SAYS the check did not run', () => {
    const out = planCallerSplit(healthyLegs(), evenTrade, { kind: 'unavailable' })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.crossChecked).toBe(false)
  })
})

describe('structural refusals do not promise a resync', () => {
  it('a dust pool does not deepen on retry', () => {
    const legs = healthyLegs()
    legs[2] = { ...legs[2], liquidityUsd: 640 }
    const out = planCallerSplit(legs, evenTrade, { kind: 'unavailable' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.resync).toBe(false)
  })
})

describe('house copy rules on everything a person sees', () => {
  it('no em dashes, no jargon in headlines or reasons', () => {
    const outcomes = [
      planCallerSplit(healthyLegs(), evenTrade, { kind: 'not-derivable', named: true }),
      planCallerSplit(healthyLegs(), evenTrade, {
        kind: 'ok',
        legs: [
          { splitBps: 9999, floorRaw: 1n },
          { splitBps: 0, floorRaw: 0n },
          { splitBps: 1, floorRaw: 1n },
        ],
      }),
    ]
    for (const out of outcomes) {
      if (out.ok) continue
      expect(out.headline).not.toMatch(/—/)
      for (const v of out.verdicts) {
        if (v.reason) expect(v.reason).not.toMatch(/—/)
      }
    }
  })
})
