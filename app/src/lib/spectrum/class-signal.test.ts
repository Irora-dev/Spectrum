import { describe, expect, it } from 'vitest'
import { classSignalFor, innerLegsFit } from './class-signal'

describe('classSignalFor — the tier→signal mapping (option A, 2026-08-05)', () => {
  it('maps every tier, basket KIND beats any tier, unranked carries NO meter', () => {
    expect(classSignalFor('cash', false)).toEqual({ kind: 'cash' })
    expect(classSignalFor('stocks', false)).toEqual({ kind: 'stock' })
    expect(classSignalFor('majors', false)).toEqual({ kind: 'crypto', capBars: 3 })
    expect(classSignalFor('large', false)).toEqual({ kind: 'crypto', capBars: 3 })
    expect(classSignalFor('mid', false)).toEqual({ kind: 'crypto', capBars: 2 })
    expect(classSignalFor('small', false)).toEqual({ kind: 'crypto', capBars: 1 })
    expect(classSignalFor('micro', false)).toEqual({ kind: 'crypto', capBars: 1 })
    expect(classSignalFor('unranked', false)).toEqual({ kind: 'crypto' })
    expect(classSignalFor(null, false)).toEqual({ kind: 'crypto' })
    for (const t of ['cash', 'stocks', 'large', 'unranked', null] as const) {
      expect(classSignalFor(t, true)).toEqual({ kind: 'basket' })
    }
  })
})

describe('innerLegsFit — legibility decides, never the share', () => {
  it('needs two legs and a readable box, exactly at the bounds', () => {
    expect(innerLegsFit(120, 96, 2)).toBe(true)
    expect(innerLegsFit(119, 96, 2)).toBe(false)
    expect(innerLegsFit(120, 95, 2)).toBe(false)
    expect(innerLegsFit(400, 300, 1)).toBe(false) // one leg is not a map
    expect(innerLegsFit(400, 300, 12)).toBe(true)
  })
})
