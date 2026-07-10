import { describe, it, expect } from 'vitest'
import { hexToRgb01 } from './brand-colors'

describe('hexToRgb01', () => {
  it('parses white / black to the 0..1 extremes', () => {
    expect(hexToRgb01('#ffffff')).toEqual([1, 1, 1])
    expect(hexToRgb01('#000000')).toEqual([0, 0, 0])
  })
  it('parses a token color and tolerates missing #/whitespace', () => {
    const cyan = hexToRgb01('#35e0ff')!
    expect(cyan[0]).toBeCloseTo(0x35 / 255)
    expect(cyan[1]).toBeCloseTo(0xe0 / 255)
    expect(cyan[2]).toBe(1)
    expect(hexToRgb01('  35e0ff ')).toEqual(cyan)
  })
  it('returns null for malformed / empty input', () => {
    expect(hexToRgb01('')).toBeNull()
    expect(hexToRgb01('var(--color-cyan)')).toBeNull()
    expect(hexToRgb01('#fff')).toBeNull()
  })
})
