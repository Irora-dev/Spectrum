import { describe, expect, it } from 'vitest'
import { badgeTextForDrift } from './badge'

describe('badgeTextForDrift', () => {
  it('is blank when drift is unknown or immaterial', () => {
    expect(badgeTextForDrift(null)).toBe('')
    expect(badgeTextForDrift(undefined)).toBe('')
    expect(badgeTextForDrift(0)).toBe('')
    expect(badgeTextForDrift(0.9)).toBe('')
    expect(badgeTextForDrift(NaN)).toBe('')
  })

  it('shows one decimal under 10 points, whole numbers to 99, then caps', () => {
    expect(badgeTextForDrift(1)).toBe('1.0')
    expect(badgeTextForDrift(5.84)).toBe('5.8')
    expect(badgeTextForDrift(9.99)).toBe('10.0') // toFixed rounds up at the seam
    expect(badgeTextForDrift(12.6)).toBe('13')
    expect(badgeTextForDrift(99.4)).toBe('99')
    expect(badgeTextForDrift(150)).toBe('99+')
  })
})
