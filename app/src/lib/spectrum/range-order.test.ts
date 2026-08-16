import { describe, expect, it } from 'vitest'
import {
  mcapForPrice,
  previewRangeOrder,
  priceForMcap,
  rangeOrderProgress,
  snapTick,
  tickForPrice,
} from './range-order'

// The behaviour these lock down is the behaviour a user reads before placing a
// position: the headline proceeds, and the bar that says how much has sold.

describe('range orders: the fill price is the GEOMETRIC mean, not the midpoint', () => {
  it('fills at √(Pa·Pb) across magnitudes', () => {
    for (const [lo, hi] of [
      [1e-6, 5e-6],
      [0.001, 0.005],
      [100, 500],
      [2000, 2400],
    ]) {
      const p = previewRangeOrder(1, { lower: lo, upper: hi })!
      expect(p.avgFillPrice).toBeCloseTo(Math.sqrt(lo * hi), 12)
    }
  })

  it("the owner's own case: $1M→$5M mcap fills at ≈$2.24M, NOT the $3M midpoint", () => {
    const supply = 1_000_000_000
    const lower = priceForMcap(1_000_000, supply)!
    const upper = priceForMcap(5_000_000, supply)!
    const p = previewRangeOrder(1_000_000, { lower, upper }, supply)!
    expect(p.effectiveMcap! / 1e6).toBeCloseTo(2.2360679, 5)
    // the midpoint would overstate the payout by a third — the exact error the
    // geometric mean exists to prevent
    expect(3_000_000 / p.effectiveMcap!).toBeCloseTo(1.3416, 3)
    expect(p.upliftVsFloor).toBeCloseTo(Math.sqrt(5), 9)
  })

  it('proceeds scale with size and the uplift never drops below 1', () => {
    const a = previewRangeOrder(100, { lower: 10, upper: 40 })!
    const b = previewRangeOrder(200, { lower: 10, upper: 40 })!
    expect(b.proceeds).toBeCloseTo(a.proceeds * 2, 9)
    expect(a.upliftVsFloor).toBeGreaterThanOrEqual(1)
  })

  it('refuses what it cannot state, rather than showing a wrong figure', () => {
    const R = { lower: 10, upper: 40 }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
      expect(previewRangeOrder(bad, R)).toBeNull()
      expect(previewRangeOrder(100, { lower: bad, upper: 40 })).toBeNull()
      expect(previewRangeOrder(100, { lower: 10, upper: bad })).toBeNull()
      expect(priceForMcap(bad, 1e9)).toBeNull()
      expect(priceForMcap(1e6, bad)).toBeNull()
      expect(mcapForPrice(bad, 1e9)).toBeNull()
      expect(tickForPrice(bad)).toBeNull()
    }
    // an inverted or zero-width range is not a range
    expect(previewRangeOrder(100, { lower: 40, upper: 10 })).toBeNull()
    expect(previewRangeOrder(100, { lower: 40, upper: 40 })).toBeNull()
  })
})

describe('range orders: the progress bar tells the truth about conversion', () => {
  const R = { lower: 100, upper: 400 }

  it('is 0 below the range and 1 above it', () => {
    expect(rangeOrderProgress(50, R)!.fraction).toBe(0)
    expect(rangeOrderProgress(100, R)!.fraction).toBe(0)
    expect(rangeOrderProgress(400, R)!.fraction).toBe(1)
    expect(rangeOrderProgress(9_999, R)!.fraction).toBe(1)
    expect(rangeOrderProgress(50, R)!.state).toBe('waiting')
    expect(rangeOrderProgress(9_999, R)!.state).toBe('filled')
  })

  it('is NOT linear in price — a linear bar would lie about money', () => {
    // the price midpoint of [100,400] is 250
    const atMidPrice = rangeOrderProgress(250, R)!.fraction
    expect(atMidPrice).not.toBeCloseTo(0.5, 2)
    // the true half-converted point is where 1/√P is the mean of the endpoints'
    const halfInv = (1 / Math.sqrt(100) + 1 / Math.sqrt(400)) / 2
    const halfPrice = 1 / (halfInv * halfInv)
    expect(rangeOrderProgress(halfPrice, R)!.fraction).toBeCloseTo(0.5, 9)
  })

  it('rises monotonically as price climbs a sell range', () => {
    let prev = -1
    for (const p of [100, 130, 170, 220, 280, 340, 400]) {
      const f = rangeOrderProgress(p, R)!.fraction
      expect(f).toBeGreaterThanOrEqual(prev)
      prev = f
    }
    expect(prev).toBe(1)
  })

  it('a BUY order runs the other way along the same maths', () => {
    const price = 250
    const sell = rangeOrderProgress(price, R, 'sell')!.fraction
    const buy = rangeOrderProgress(price, R, 'buy')!.fraction
    expect(sell + buy).toBeCloseTo(1, 12)
  })

  it('CAN ALWAYS UNFILL — even at 100%, until it is withdrawn', () => {
    for (const p of [50, 250, 400, 9_999]) {
      expect(rangeOrderProgress(p, R)!.canUnfill).toBe(true)
    }
    // the flag survives the state that most invites a "done ✓"
    const full = rangeOrderProgress(9_999, R)!
    expect(full.state).toBe('filled')
    expect(full.canUnfill).toBe(true)
  })

  it('never emits a non-finite or out-of-band fraction', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
      expect(rangeOrderProgress(bad, R)).toBeNull()
      expect(rangeOrderProgress(250, { lower: bad, upper: 400 })).toBeNull()
      expect(rangeOrderProgress(250, { lower: 100, upper: bad })).toBeNull()
    }
    for (const p of [100.0000001, 399.9999999, 1e-9, 1e21]) {
      const r = rangeOrderProgress(p, R)
      if (r) {
        expect(Number.isFinite(r.fraction)).toBe(true)
        expect(r.fraction).toBeGreaterThanOrEqual(0)
        expect(r.fraction).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('range orders: the bounds we can actually place', () => {
  it('a sell range never widens past what the user asked', () => {
    // lower rounds UP so they cannot fill below their floor; upper rounds DOWN
    expect(snapTick(1005, 60, 'up')).toBe(1020)
    expect(snapTick(1055, 60, 'down')).toBe(1020)
    expect(snapTick(-1005, 60, 'up')).toBe(-960)
  })

  it('refuses a nonsense spacing rather than minting a bad range', () => {
    for (const bad of [0, -60, 1.5, Number.NaN]) {
      expect(snapTick(1000, bad, 'up')).toBeNull()
    }
    expect(snapTick(Number.NaN, 60, 'up')).toBeNull()
  })

  it('price↔tick round-trips within a tick', () => {
    for (const p of [1e-9, 0.42, 1, 2600, 1e6]) {
      const t = tickForPrice(p)!
      expect(Math.abs(Math.pow(1.0001, t) - p) / p).toBeLessThan(0.0001)
    }
  })
})
