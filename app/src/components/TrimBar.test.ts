import { describe, expect, it } from 'vitest'
import { dollarsOf, travelOf } from './TrimBar'

// The non-linear travel curve (the owner, 13:19): precision near the current
// value, acceleration at the ends — and the inverse must land a typed number
// exactly where a drag would have.
describe('the trim curve — fine near the anchor, fast at the rails', () => {
  const CUR = 53_302
  const MAX = 60_000

  it('round-trips within one LOCAL notch everywhere, and exactly near the anchor', () => {
    // A typed number never routes through the slider (DollarField commits the
    // exact dollars); travelOf only parks the thumb. So the honest round-trip
    // bound is the curve's own local step at that point — fine at the anchor,
    // deliberately coarse at the rails.
    for (const v of [0, 1, 500, CUR - 1, CUR, CUR + 1, 55_000, MAX]) {
      const t = travelOf(v, CUR, MAX, false)
      const back = dollarsOf(t, CUR, MAX, false)
      const localNotch = Math.abs(dollarsOf(Math.min(1000, t + 1), CUR, MAX, false) - dollarsOf(Math.max(0, t - 1), CUR, MAX, false))
      expect(Math.abs(back - v), `v=${v}`).toBeLessThanOrEqual(Math.max(1, localNotch))
    }
    // near the anchor the round-trip is EXACT to the dollar — the whole point
    for (const v of [CUR - 5, CUR, CUR + 5]) {
      expect(Math.abs(dollarsOf(travelOf(v, CUR, MAX, false), CUR, MAX, false) - v)).toBeLessThanOrEqual(1)
    }
  })

  it('one notch near the anchor moves LESS than a dollar-linear notch; the far rail moves more', () => {
    const t0 = travelOf(CUR, CUR, MAX, false)
    const nearStep = Math.abs(dollarsOf(t0 + 1, CUR, MAX, false) - CUR)
    const farStep = Math.abs(dollarsOf(1000, CUR, MAX, false) - dollarsOf(999, CUR, MAX, false))
    const linearStep = MAX / 1000
    expect(nearStep).toBeLessThan(linearStep / 4) // fine where his hand is
    expect(farStep).toBeGreaterThan(linearStep) // fast where it should be
  })

  it('the rails are exact: travel 0 → $0, travel 1000 → max; the anchor is the current value', () => {
    expect(dollarsOf(0, CUR, MAX, false)).toBe(0)
    expect(dollarsOf(1000, CUR, MAX, false)).toBe(MAX)
    expect(dollarsOf(travelOf(CUR, CUR, MAX, false), CUR, MAX, false)).toBe(CUR)
  })

  it('a NEW position anchors at zero and stays monotone', () => {
    let prev = -1
    for (let t = 0; t <= 1000; t += 50) {
      const v = dollarsOf(t, 0, 10_000, true)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('degenerate books hold: cur at max, and a zero max', () => {
    expect(dollarsOf(1000, 500, 500, false)).toBe(500)
    expect(dollarsOf(0, 500, 500, false)).toBe(0)
    expect(dollarsOf(500, 0, 0, false)).toBe(0)
  })
})
