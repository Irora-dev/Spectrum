import { describe, it, expect } from 'vitest'
import { operatorBrandToTheme, applyBrandVars, VAR_MAP } from './theme'
import { STYLE_PRESETS } from './presets'
import { SPECTRUM_DNA, validateSiteName } from './brand'
import type { BrandConfig, DesignStyle } from './brand'

const spectralBrand: BrandConfig = {
  name: 'Baskets',
  style: 'spectral',
  palette: { ...SPECTRUM_DNA },
}

describe('operatorBrandToTheme', () => {
  it('spectral + spectrum DNA reproduces the spectral preset exactly (no launch-look drift)', () => {
    expect(operatorBrandToTheme(spectralBrand)).toEqual(STYLE_PRESETS.spectral)
  })

  it('overlays the operator gradient onto amber/magenta/cyan, leaves surfaces from the preset', () => {
    const t = operatorBrandToTheme({
      ...spectralBrand,
      palette: { gradientFrom: '#111111', gradientVia: '#222222', gradientTo: '#333333' },
    })
    expect(t.amber).toBe('#111111')
    expect(t.magenta).toBe('#222222')
    expect(t.cyan).toBe('#333333')
    expect(t.void).toBe(STYLE_PRESETS.spectral.void)
  })

  it('overlays accent onto violet when set', () => {
    const t = operatorBrandToTheme({
      ...spectralBrand,
      palette: { ...SPECTRUM_DNA, accent: '#abcabc' },
    })
    expect(t.violet).toBe('#abcabc')
  })

  it('picks the chosen style preset (aurora surfaces differ from spectral)', () => {
    const t = operatorBrandToTheme({ ...spectralBrand, style: 'aurora' })
    expect(t.void).toBe(STYLE_PRESETS.aurora.void)
    expect(t.void).not.toBe(STYLE_PRESETS.spectral.void)
  })

  it('falls back to spectral for an unknown style', () => {
    const t = operatorBrandToTheme({ ...spectralBrand, style: 'nope' as unknown as DesignStyle })
    expect(t.void).toBe(STYLE_PRESETS.spectral.void)
  })
})

describe('applyBrandVars', () => {
  it('writes exactly one CSS var per theme field (VAR_MAP is exhaustive)', () => {
    const set: Record<string, string> = {}
    const fakeEl = {
      style: { setProperty: (k: string, v: string) => { set[k] = v } },
    } as unknown as HTMLElement
    const theme = operatorBrandToTheme(spectralBrand)
    applyBrandVars(theme, fakeEl)
    expect(Object.keys(set).length).toBe(Object.keys(theme).length)
    expect(Object.keys(set).length).toBe(Object.keys(VAR_MAP).length)
    expect(set['--color-cyan']).toBe(theme.cyan)
    expect(set['--color-void']).toBe(theme.void)
    expect(set['--font-display']).toBe(theme.fontDisplay)
  })
})

describe('validateSiteName', () => {
  it('accepts a normal name', () => {
    expect(validateSiteName('Acme Baskets').ok).toBe(true)
  })
  it('rejects empty / whitespace', () => {
    expect(validateSiteName('   ').ok).toBe(false)
  })
  it('rejects names longer than 32 chars', () => {
    expect(validateSiteName('x'.repeat(33)).ok).toBe(false)
  })
  it('rejects anything containing "spectrum", case-insensitively', () => {
    expect(validateSiteName('SpEcTrUm Pro').ok).toBe(false)
    expect(validateSiteName('my spectrum site').ok).toBe(false)
  })
})
