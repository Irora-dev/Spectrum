import { describe, expect, it } from 'vitest'
import { buildYScale, computeBands } from './scales'
import { seedRamp } from './palette'

// The kit is VENDORED (tripwire.sh/dither-kit) and we modified its scale +
// palette math locally: the `yDomain: "data"` mode (2026-07-29 audit — every
// NAV chart rendered flat against a zero-anchored domain) and the weighted
// constituent ramp. These tests pin BOTH: that "zero" mode is unchanged from
// the upstream behaviour, and that "data" mode does what the fix promises.

const rows = (vals: number[]) => vals.map((v) => ({ v }))
// A realistic NAV week: ~$1.05 with a 3% swing — the case that motivated the fix.
const NAV = [1.041, 1.048, 1.052, 1.061, 1.058, 1.072, 1.069]

describe('computeBands — zero mode is upstream-identical', () => {
  it('all-positive data floors every band at 0 and reports the data max', () => {
    const { bands, max } = computeBands(rows([2, 5, 3]), ['v'], 'default')
    expect(bands.v).toEqual([
      [0, 2],
      [0, 5],
      [0, 3],
    ])
    expect(max).toBe(5)
  })

  it('all-zero data keeps the unit-span fallback (no degenerate domain)', () => {
    const { max } = computeBands(rows([0, 0]), ['v'], 'default')
    expect(max).toBe(1)
  })

  it('negative data keeps max at the zero baseline through the scale', () => {
    const { min, max } = computeBands(rows([-1, -2]), ['v'], 'default')
    const y = buildYScale(min, max, 100) // zero mode
    expect(y.domain()[0]).toBeLessThanOrEqual(-2)
    expect(y.domain()[1]).toBeGreaterThanOrEqual(0)
  })

  it('empty data cannot produce a non-finite domain', () => {
    const { min, max } = computeBands([], ['v'], 'default')
    const y = buildYScale(min, max, 100)
    expect(y.domain().every(Number.isFinite)).toBe(true)
  })
})

describe('computeBands + buildYScale — data mode (the flat-chart fix)', () => {
  it('floors bands at the DATA min so the fill spans the moving band', () => {
    const { bands } = computeBands(rows(NAV), ['v'], 'default', 'data')
    const floors = bands.v.map(([f]) => f)
    expect(new Set(floors).size).toBe(1) // one shared floor
    expect(floors[0]).toBe(Math.min(...NAV))
  })

  it('a 3% NAV week uses most of the plot (it used <3% against zero)', () => {
    const { min, max } = computeBands(rows(NAV), ['v'], 'default', 'data')
    const H = 256
    const dataY = buildYScale(min, max, H, 'data')
    const zeroY = buildYScale(min, max, H) // the pre-fix behaviour
    const span = (y: ReturnType<typeof buildYScale>) =>
      Math.abs(y(Math.min(...NAV)) - y(Math.max(...NAV)))
    expect(span(dataY)).toBeGreaterThan(H * 0.7) // readable trend
    expect(span(zeroY)).toBeLessThan(H * 0.05) // the bug, pinned
  })

  it('a TINY move does NOT fill the plot (the honesty floor)', () => {
    // 0.05% wobble around $1.05 — without a min-span floor the data-band zoom
    // renders this as a mountain range, and no chart here has a y-axis.
    const tiny = [1.05, 1.0502, 1.0501, 1.05025, 1.0503]
    const { min, max } = computeBands(rows(tiny), ['v'], 'default', 'data')
    const H = 256
    const y = buildYScale(min, max, H, 'data')
    const span = Math.abs(y(Math.min(...tiny)) - y(Math.max(...tiny)))
    expect(span).toBeLessThan(H * 0.2) // reads as the wiggle it is
    // …while a real 3% move still fills the plot (asserted above)
  })

  it('a flat series still yields a finite, non-zero-width domain', () => {
    const { min, max } = computeBands(rows([1.05, 1.05, 1.05]), ['v'], 'default', 'data')
    const y = buildYScale(min, max, 100, 'data')
    const [lo, hi] = y.domain()
    expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true)
    expect(hi).toBeGreaterThan(lo)
  })

  it('all-zero data in data mode stays finite (pad falls through to 1)', () => {
    const { min, max } = computeBands(rows([0, 0]), ['v'], 'default', 'data')
    const y = buildYScale(min, max, 100, 'data')
    expect(y.domain().every(Number.isFinite)).toBe(true)
  })
})

describe('seedRamp — the weighted constituent gradient', () => {
  const RED = '#ff0000'
  const BLUE = '#0000ff'

  it('lays stops out proportionally to weight and interpolates between them', () => {
    const ramp = seedRamp([{ color: RED, weight: 50 }, { color: BLUE, weight: 50 }], 100)
    expect(ramp).toHaveLength(100)
    // ends sit at the stop centres (25% / 75%), so they are the pure colours
    expect(ramp[0].fill).toEqual([255, 0, 0])
    expect(ramp[99].fill).toEqual([0, 0, 255])
    // the midpoint is a genuine blend, not a hard switch
    const mid = ramp[50].fill
    expect(mid[0]).toBeGreaterThan(0)
    expect(mid[0]).toBeLessThan(255)
    expect(mid[2]).toBeGreaterThan(0)
  })

  it('weight skews where the colour sits (a 90% leg dominates the field)', () => {
    const ramp = seedRamp([{ color: RED, weight: 90 }, { color: BLUE, weight: 10 }], 100)
    const reddish = ramp.filter((s) => s.fill[0] > s.fill[2]).length
    expect(reddish).toBeGreaterThan(60)
  })

  it('derives line/star tints toward white from the fill', () => {
    const [s] = seedRamp([{ color: RED, weight: 1 }, { color: BLUE, weight: 1 }], 2)
    expect(s.line[0]).toBeGreaterThanOrEqual(s.fill[0])
    expect(s.star[1]).toBeGreaterThan(s.line[1] - 1) // star is the lightest tint
  })

  it('drops zero/NaN weights and unparseable colours instead of crashing', () => {
    expect(seedRamp([{ color: RED, weight: 0 }, { color: BLUE, weight: 100 }], 10)[0].fill).toEqual([0, 0, 255])
    expect(seedRamp([{ color: RED, weight: Number.NaN }, { color: BLUE, weight: 5 }], 10)).toHaveLength(10)
    expect(seedRamp([{ color: 'not-a-colour', weight: 5 }], 10)).toEqual([])
    expect(seedRamp([], 10)).toEqual([])
  })

  it('cols=1 and a single stop are both safe', () => {
    expect(seedRamp([{ color: RED, weight: 1 }, { color: BLUE, weight: 1 }], 1)).toHaveLength(1)
    const one = seedRamp([{ color: RED, weight: 100 }], 5)
    expect(one).toHaveLength(5)
    expect(one.every((s) => s.fill[0] === 255)).toBe(true)
  })
})
