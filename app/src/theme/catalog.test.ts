import { describe, it, expect } from 'vitest'
import { GRADIENT_CATALOG, gradientById } from './catalog'
import { STYLE_PRESETS } from './presets'
import type { DesignStyle } from './brand'

describe('gradient catalog', () => {
  it('has unique ids and valid 3-stop hex gradients', () => {
    const ids = GRADIENT_CATALOG.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const g of GRADIENT_CATALOG) {
      for (const stop of [g.from, g.via, g.to]) expect(stop).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
  it('resolves by id (and misses safely)', () => {
    expect(gradientById('ocean')?.from).toBe('#3b82f6')
    expect(gradientById('nope')).toBeUndefined()
  })
})

describe('style presets', () => {
  it('every DesignStyle has a complete preset (union ↔ map in lockstep)', () => {
    const styles: DesignStyle[] = ['spectral', 'aurora', 'prism', 'umbra', 'sylvan']
    for (const s of styles) {
      const p = STYLE_PRESETS[s]
      expect(p).toBeTruthy()
      // spot-check the load-bearing tokens exist on every preset
      for (const k of ['void', 'panel', 'ink', 'cyan', 'magenta', 'amber', 'fontDisplay'] as const) {
        expect(p[k]).toMatch(/\S/)
      }
    }
  })
})
