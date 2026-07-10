import { describe, expect, it } from 'vitest'
import { bumpVersionTicker } from './versioning'

// The version-ticker nudge (owner 2026-07-07 13:38): prefill an incremented
// ticker on a new version so two live versions never share one ticker by default.
describe('bumpVersionTicker', () => {
  it('appends V2 to an unversioned ticker', () => {
    expect(bumpVersionTicker('BLUE')).toBe('BLUEV2')
  })

  it('increments an existing V<n> suffix', () => {
    expect(bumpVersionTicker('BLUEV1')).toBe('BLUEV2')
    expect(bumpVersionTicker('TBV2')).toBe('TBV3')
    expect(bumpVersionTicker('BLUEV99')).toBe('BLUEV100')
  })

  it('does not read a bare trailing digit as a version', () => {
    expect(bumpVersionTicker('ROTATE2')).toBe('ROTATE2V2')
  })

  it('trims the base to keep the 11-char cap when appending', () => {
    expect(bumpVersionTicker('ABCDEFGHIJK')).toBe('ABCDEFGHIV2')
    expect(bumpVersionTicker('ABCDEFGHIJK')).toHaveLength(11)
  })

  it('returns the input untouched when incrementing cannot fit or parse', () => {
    expect(bumpVersionTicker('ABCDEFGHV99')).toBe('ABCDEFGHV99') // V100 would be 12 chars
    expect(bumpVersionTicker('blue coin!')).toBe('blue coin!') // not a builder-legal symbol
    expect(bumpVersionTicker('')).toBe('')
  })

  it('normalizes case on the way through', () => {
    expect(bumpVersionTicker('bluev1')).toBe('BLUEV2')
  })
})
