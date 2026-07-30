import { describe, expect, it } from 'vitest'
import { feeSinksFor, pct } from './SlashCreators'

// The marketing surfaces (the /creators split bar + volume calculator, the
// walkthrough's fee slide) must show the league carve on a league chain —
// omitting it overstated the creator at 24.00% where the contract pays 22.80%
// and left the split bar 5% short of a whole (kit audit).
describe('feeSinksFor', () => {
  it('a non-league chain keeps the legacy five sinks and integer labels', () => {
    const { split, sinks } = feeSinksFor(0)
    expect(sinks.map((s) => s.key)).toEqual(['creator', 'holders', 'burn', 'interface', 'launcher'])
    expect(split.league).toBe(0)
    // byte-identical to the pre-league display
    expect(pct(split.creator)).toBe('24')
    expect(pct(split.holders)).toBe('56')
    expect(pct(split.burn)).toBe('10')
  })

  it('a league chain gains the league sink and the bar still sums to a whole', () => {
    const { split, sinks } = feeSinksFor(500)
    expect(sinks.map((s) => s.key)).toEqual(['creator', 'holders', 'burn', 'league', 'interface', 'launcher'])
    // every segment renders `width: frac*100%` — a missing sink leaves a gap
    const total = sinks.reduce((acc, s) => acc + s.frac, 0)
    expect(total).toBeCloseTo(1, 12)
    // the audit's measured numbers, no longer overstated
    expect(pct(split.creator)).toBe('22.8')
    expect(pct(split.league)).toBe('5')
  })
})
