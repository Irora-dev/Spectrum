import { describe, expect, it } from 'vitest'
import {
  decideFirstMintSplit,
  firstMintSplitFromWeights,
  WEIGHT_TOTAL_BPS,
  type FirstMintWeightSplit,
} from './first-mint-split'

// ─────────────────────────────────────────────────────────────────────────────
// The ONE place a weight may become a funding split, pinned at its edges.
//
// Everywhere else a weight-derived split is the starved-basket exploit contracts
// measured ($10,000 buy → $4,255 at target weights vs $9,900 at the lens split).
// At the FIRST mint it is the only number that exists and the money is the first
// minter's own, so it is legal — and these tests exist so that "first mint only,
// packing only, from the basket only" stays true.
// ─────────────────────────────────────────────────────────────────────────────

const CURRENT = '0x07Bfce0976b205FcfDF115F7aD1401Ab1f197e6f' as const
const RETIRED = '0xa60ce83A00000000000000000000000000004E5D' as const

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0)

describe('firstMintSplitFromWeights — the basket own weights become the split', () => {
  it('passes clean on-chain weights through and totals exactly 10000', () => {
    // The real shape: SpectrumBasket requires its leg weights to total BPS, so the
    // common case is an identity.
    const out = firstMintSplitFromWeights([4000, 4000, 2000], 3)
    expect(out).toEqual({ source: 'basket-design-weights', splitBps: [4000, 4000, 2000] })
    expect(sum(out!.splitBps)).toBe(WEIGHT_TOTAL_BPS)
  })

  it('a single-leg basket is the whole buy', () => {
    expect(firstMintSplitFromWeights([10_000], 1)?.splitBps).toEqual([10_000])
  })

  it('THE RESIDUAL LANDS ON THE HEAVIEST LEG, and the total is exact', () => {
    // 3333/3333/3334-style thirds: flooring loses a bp, and it must go to the leg
    // where it moves the least — never spread, never dropped.
    const out = firstMintSplitFromWeights([1, 1, 1], 3)
    expect(out?.splitBps).toEqual([3334, 3333, 3333])
    expect(sum(out!.splitBps)).toBe(WEIGHT_TOTAL_BPS)

    const lopsided = firstMintSplitFromWeights([1, 2, 97], 3)
    expect(lopsided?.splitBps).toEqual([100, 200, 9700])
    expect(sum(lopsided!.splitBps)).toBe(WEIGHT_TOTAL_BPS)

    // The heaviest leg is not always the last one.
    const heaviestFirst = firstMintSplitFromWeights([7, 1, 1], 3)
    expect(heaviestFirst?.splitBps[0]).toBeGreaterThan(heaviestFirst!.splitBps[1])
    expect(sum(heaviestFirst!.splitBps)).toBe(WEIGHT_TOTAL_BPS)
  })

  it('ties go to the earliest leg, and the WHOLE residual lands there', () => {
    // Not spread a bp at a time: one leg absorbs it, so the result never depends on
    // sort stability or iteration order.
    expect(firstMintSplitFromWeights([1, 1], 2)?.splitBps).toEqual([5000, 5000])
    expect(firstMintSplitFromWeights([1, 1, 1, 1, 1, 1], 6)?.splitBps).toEqual([1670, 1666, 1666, 1666, 1666, 1666])
  })

  it('normalises a set that does not already total 10000', () => {
    // Percentages, or any other scale, still land on an exact-10000 split.
    const out = firstMintSplitFromWeights([60, 40], 2)
    expect(out?.splitBps).toEqual([6000, 4000])
    expect(sum(out!.splitBps)).toBe(WEIGHT_TOTAL_BPS)
  })

  it('REFUSES a leg count that does not describe this basket', () => {
    // The weights answer for a different basket, or the basket changed under the
    // quote. Funding the wrong leg is the failure this prevents.
    expect(firstMintSplitFromWeights([4000, 4000, 2000], 2)).toBeNull()
    expect(firstMintSplitFromWeights([5000, 5000], 3)).toBeNull()
    expect(firstMintSplitFromWeights([], 0)).toBeNull()
    expect(firstMintSplitFromWeights([10_000], -1)).toBeNull()
    expect(firstMintSplitFromWeights([10_000], 1.5)).toBeNull()
  })

  it('REFUSES a weight that cannot be one', () => {
    for (const bad of [0, -1, 10_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(firstMintSplitFromWeights([bad, 5000], 2)).toBeNull()
    }
  })

  it('REFUSES when a leg would end up funded with nothing', () => {
    // A zero-split leg is skipped by the acquire loop, but the first mint demands a
    // non-zero floor on every non-USDC leg (FirstMintLegMinRequired) — the two
    // together revert. A basket cannot legally reach this shape; if we read one that
    // does, it is not ours to round away.
    expect(firstMintSplitFromWeights([1, 100_000_000], 2)).toBeNull()
  })
})

describe('decideFirstMintSplit — packing only, current lineage only', () => {
  const base = {
    currentFactory: CURRENT as `0x${string}`,
    factory: CURRENT as `0x${string}`,
    weightsBps: [4000, 4000, 2000],
    legCount: 3,
  }

  it('PACKING deployment: the basket own weights become the split', () => {
    const out = decideFirstMintSplit({ ...base, packsFundingSplit: true })
    expect(out.kind).toBe('ok')
    expect(out.kind === 'ok' && out.split.splitBps).toEqual([4000, 4000, 2000])
    expect(out.kind === 'ok' && sum(out.split.splitBps)).toBe(WEIGHT_TOTAL_BPS)
  })

  it('NON-PACKING deployment: no split at all, whatever the weights say', () => {
    // The byte-identical path. A pre-packing basket reads the WHOLE word as its
    // floor, so anything in the top bits is an astronomical floor and LegMinNotMet.
    expect(decideFirstMintSplit({ ...base, packsFundingSplit: false })).toEqual({ kind: 'not-packing' })
  })

  it('a SUPERSEDED lineage never packs, even on a packing chain', () => {
    // Generation is a property of the factory/basket PAIR: the flag describes the
    // CURRENT factory, and retired baskets stay tradable through their own contracts.
    expect(
      decideFirstMintSplit({ ...base, packsFundingSplit: true, factory: RETIRED }),
    ).toEqual({ kind: 'not-packing' })
  })

  it('with no factory configured there is nothing to be the current generation', () => {
    expect(decideFirstMintSplit({ ...base, packsFundingSplit: true, currentFactory: null })).toEqual({
      kind: 'not-packing',
    })
  })

  it('a WEIGHT READ THAT DID NOT LAND refuses instead of shipping zeros', () => {
    // Guessing "legacy" here would ship the zero-split payload on the exact
    // deployment that cannot survive it.
    expect(decideFirstMintSplit({ ...base, packsFundingSplit: true, weightsBps: null })).toEqual({
      kind: 'unreadable',
    })
  })

  it('weights that cannot make an honest split refuse, they are not repaired', () => {
    expect(decideFirstMintSplit({ ...base, packsFundingSplit: true, legCount: 2 })).toEqual({ kind: 'unreadable' })
    expect(decideFirstMintSplit({ ...base, packsFundingSplit: true, weightsBps: [0, 0, 0] })).toEqual({
      kind: 'unreadable',
    })
  })
})

describe('the split is self-describing, so it cannot pass for a lens answer', () => {
  it('carries its own provenance', () => {
    const out = firstMintSplitFromWeights([5000, 5000], 2) as FirstMintWeightSplit
    expect(out.source).toBe('basket-design-weights')
  })
})
