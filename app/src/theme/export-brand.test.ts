import { describe, expect, it } from 'vitest'
import { brandConfigToTs } from './export-brand'
import { PAGE_KEYS, type BrandConfig } from './brand'

const base: BrandConfig = {
  name: 'Acme',
  style: 'spectral',
  palette: { gradientFrom: '#111111', gradientVia: '#222222', gradientTo: '#333333' },
}

// The studio's exporter is one of THREE config writers (app contract · this ·
// create/render.mjs). It silently dropped `setupStudio`, so an operator who had
// locked their site and then pressed Apply got /setup back on the next build.
// These pin the round-trip: everything a knob can be, the exporter can write.
describe('brandConfigToTs', () => {
  it('omits every default-ON knob when it is left ON', () => {
    const out = brandConfigToTs(base)
    for (const k of ['stocks', 'prismCredit', 'starterTokens', 'setupStudio', 'defaultChainId', 'pages']) {
      expect(out).not.toContain(`${k}:`)
    }
    expect(out).toContain('name: "Acme"')
  })

  it('writes every knob back when it is turned OFF (setupStudio regression)', () => {
    const out = brandConfigToTs({
      ...base,
      stocks: false,
      prismCredit: false,
      starterTokens: false,
      setupStudio: false,
      defaultChainId: 8453,
    })
    expect(out).toContain('stocks: false')
    expect(out).toContain('prismCredit: false')
    expect(out).toContain('starterTokens: false')
    expect(out).toContain('setupStudio: false')
    expect(out).toContain('defaultChainId: 8453')
  })

  it('emits only the pages that are OFF, and can emit every page key', () => {
    const allOff = Object.fromEntries(PAGE_KEYS.map((k) => [k, false]))
    const out = brandConfigToTs({ ...base, pages: allOff })
    for (const k of PAGE_KEYS) expect(out).toContain(`${k}: false`)
    const oneOff = brandConfigToTs({ ...base, pages: { league: false } })
    expect(oneOff).toContain('league: false')
    expect(oneOff).not.toContain('discover: false')
  })

  it('accepts "Spectrum" as a name — it is the shipped default, not a red line', () => {
    expect(brandConfigToTs({ ...base, name: 'Spectrum' })).toContain('name: "Spectrum"')
  })
})
