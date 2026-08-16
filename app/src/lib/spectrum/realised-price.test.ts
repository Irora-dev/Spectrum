import { describe, expect, it } from 'vitest'
import {
  AT_FLOOR_BAND_SHARE_BPS,
  MIN_SAMPLE,
  bandSlackBps,
  realisedVsQuoteBps,
  skimSignal,
  type FilledLeg,
} from './realised-price'

// RULE 7. Each test is named for the thing the monitor must NOT miss or must
// NOT claim. The whole point is a verdict on a DISTRIBUTION, so the fixtures
// are populations, not examples.

const leg = (over: Partial<FilledLeg> = {}): FilledLeg => ({
  key: 'AAVE',
  fundingUsed: 1_000_000n,
  delivered: 1_000_000n,
  minBuyAmount: 900_000n,
  quotedBuyAmount: 1_000_000n,
  ...over,
})

/** n legs whose delivery sits at a given share of the granted band. */
const population = (n: number, slackShareBps: number, quoted = 1_000_000n, floor = 900_000n): FilledLeg[] =>
  Array.from({ length: n }, (_, i) =>
    leg({ key: `L${i}`, quotedBuyAmount: quoted, minBuyAmount: floor, delivered: floor + ((quoted - floor) * BigInt(slackShareBps)) / 10_000n }),
  )

describe('bandSlackBps — how much of the band a leg left on the table', () => {
  it('reads 0 on the floor and 10,000 at the full quote', () => {
    expect(bandSlackBps(leg({ delivered: 900_000n }))).toBe(0)
    expect(bandSlackBps(leg({ delivered: 1_000_000n }))).toBe(10_000)
    expect(bandSlackBps(leg({ delivered: 950_000n }))).toBe(5_000)
  })
  it('a delivery BELOW our own floor reads as zero slack, not negative', () => {
    expect(bandSlackBps(leg({ delivered: 1n }))).toBe(0)
  })
  it('AN UNMEASURABLE LEG IS NULL, never a clean reading', () => {
    expect(bandSlackBps(leg({ quotedBuyAmount: 0n }))).toBeNull()
    expect(bandSlackBps(leg({ minBuyAmount: 0n }))).toBeNull()
    expect(bandSlackBps(leg({ delivered: -1n }))).toBeNull()
    // no band granted (floor == quote): nothing to hug, nothing to say
    expect(bandSlackBps(leg({ minBuyAmount: 1_000_000n }))).toBeNull()
  })
})

describe('the verdict refuses to speak on too small a sample', () => {
  it('says so rather than giving a weak opinion', () => {
    const v = skimSignal(population(MIN_SAMPLE - 1, 0))
    expect(v.kind).toBe('insufficient-sample')
    expect(v.message).toMatch(/needed before the pattern means anything/i)
  })
  it('UNMEASURABLE LEGS DO NOT COUNT TOWARD THE SAMPLE — an outage is not calm', () => {
    // twenty legs, none measurable: the monitor must not report "ordinary"
    const broken = Array.from({ length: 20 }, (_, i) => leg({ key: `B${i}`, quotedBuyAmount: 0n }))
    const v = skimSignal(broken)
    expect(v.kind).toBe('insufficient-sample')
    expect(v.measured).toBe(0)
  })
})

describe('THE SIGNATURE: extraction hugs the floor, honest execution scatters', () => {
  it('a population sitting ON the floor ALERTS', () => {
    const v = skimSignal(population(20, 0))
    expect(v.kind).toBe('clustered-at-floor')
    if (v.kind !== 'clustered-at-floor') throw new Error('unreachable')
    expect(v.atFloor).toBe(20)
    expect(v.message).toMatch(/keeps the rest/i)
    expect(v.message!.length, 'the alert must fit the shown-text bound').toBeLessThanOrEqual(240)
  })

  it('a population scattered across the band is ORDINARY, and says nothing', () => {
    const scattered = Array.from({ length: 20 }, (_, i) =>
      leg({ key: `S${i}`, delivered: 900_000n + (100_000n * BigInt((i * 500) % 10_000)) / 10_000n }),
    )
    const v = skimSignal(scattered)
    expect(v.kind).toBe('ordinary')
    expect(v.message).toBeNull()
  })

  it('a FEW legs near the floor among many honest ones does NOT alert — thin markets exist', () => {
    const mixed = [...population(4, 0), ...population(16, 6_000).map((l, i) => ({ ...l, key: `H${i}` }))]
    expect(skimSignal(mixed).kind).toBe('ordinary')
  })

  it('the alert threshold is a SHARE, so it fires on a majority however large the batch', () => {
    for (const n of [10, 32, 200]) {
      const skimmed = [
        ...population(Math.ceil(n * 0.7), 0),
        ...population(Math.floor(n * 0.3), 8_000).map((l, i) => ({ ...l, key: `H${i}` })),
      ]
      expect(skimSignal(skimmed).kind, `n=${n}`).toBe('clustered-at-floor')
    }
  })

  it('legs JUST inside the at-floor threshold count, just outside do not', () => {
    expect(skimSignal(population(20, AT_FLOOR_BAND_SHARE_BPS)).kind).toBe('clustered-at-floor')
    expect(skimSignal(population(20, AT_FLOOR_BAND_SHARE_BPS + 1)).kind).toBe('ordinary')
  })
})

describe('per-leg reporting is separate from the verdict, on purpose', () => {
  it('states the realised share of the quote', () => {
    expect(realisedVsQuoteBps(leg({ delivered: 994_000n }))).toBe(9_940)
    expect(realisedVsQuoteBps(leg({ quotedBuyAmount: 0n }))).toBeNull()
  })
  it('a single leg on its floor produces a report but NEVER a verdict', () => {
    const one = [leg({ delivered: 900_000n })]
    expect(realisedVsQuoteBps(one[0])).toBe(9_000)
    expect(skimSignal(one).kind).toBe('insufficient-sample')
  })
})
