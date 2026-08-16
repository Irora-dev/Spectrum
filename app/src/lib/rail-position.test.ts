import { describe, expect, it } from 'vitest'
import { activeFromRatios } from './rail-position'

describe('activeFromRatios', () => {
  it('is index 0 for an empty rail', () => {
    expect(activeFromRatios([])).toBe(0)
  })

  it('takes the most visible item', () => {
    expect(activeFromRatios([0.14, 1, 0])).toBe(1)
    expect(activeFromRatios([0, 0, 0.9])).toBe(2)
  })

  it('parks on the first item when the rail is at the start', () => {
    // one card on screen, the next peeking — the reader is on card one
    expect(activeFromRatios([1, 0.16, 0, 0, 0, 0])).toBe(0)
  })

  it('resolves an exact tie to the earlier item', () => {
    expect(activeFromRatios([0.5, 0.5])).toBe(0)
  })

  it('resolves a near-tie to the earlier item (no mid-drag flicker)', () => {
    // 1.0 beats 0.99 arithmetically, but both cards are fully readable and the
    // reader has not left the first one yet
    expect(activeFromRatios([0.99, 1])).toBe(0)
    // past the tolerance it does move on
    expect(activeFromRatios([0.9, 1])).toBe(1)
  })

  it('ignores holes in the ratio list', () => {
    const sparse: number[] = []
    sparse[2] = 0.8
    expect(activeFromRatios(sparse)).toBe(2)
  })

  it('is index 0 when nothing is visible (a rail scrolled out of view)', () => {
    expect(activeFromRatios([0, 0, 0])).toBe(0)
  })
})
