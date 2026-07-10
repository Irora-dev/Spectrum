import { describe, it, expect } from 'vitest'
import { structureToCssVars } from './structure'
import type { DesignStyle } from './brand'

describe('structureToCssVars', () => {
  it('spectral reproduces the reference glass card (default build unchanged)', () => {
    const v = structureToCssVars('spectral')
    expect(v['--st-card-bg']).toBe('rgba(23, 23, 32, 0.78)')
    expect(v['--st-card-border']).toContain('rgba(255, 255, 255, 0.1)')
    expect(v['--st-card-blur']).toBe('blur(12px)')
  })
  it('umbra is opaque + solid + no blur (drastically different, not just recoloured)', () => {
    const v = structureToCssVars('umbra')
    expect(v['--st-card-bg']).toBe('var(--color-panel)')
    expect(v['--st-card-blur']).toBe('none')
    expect(v['--st-card-shadow']).toContain('40px')
    expect(v['--font-display']).toContain('Inter')
  })
  it('sylvan pins a serif display face + sharp radii', () => {
    const v = structureToCssVars('sylvan')
    expect(v['--font-display']).toContain('Newsreader')
    expect(v['--radius-2xl']).toBe('5px') // sharp editorial corners, vs glass's 1rem
  })
  it('umbra rounds the radius scale up (vs glass defaults)', () => {
    expect(structureToCssVars('umbra')['--radius-2xl']).toBe('20px')
    expect(structureToCssVars('spectral')['--radius-2xl']).toBe('1rem')
  })
  it('always emits all three font vars, so switching styles clears a prior override', () => {
    for (const s of ['spectral', 'aurora', 'prism', 'umbra', 'sylvan'] as DesignStyle[]) {
      const v = structureToCssVars(s)
      expect(v['--font-display']).toMatch(/\S/)
      expect(v['--font-num']).toMatch(/\S/)
      expect(v['--font-mono']).toMatch(/\S/)
    }
  })
})
