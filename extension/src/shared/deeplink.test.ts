import { describe, expect, it } from 'vitest'
import { portfolioUrl, siteBase, tokenUrl } from './deeplink'

describe('siteBase', () => {
  it('normalizes a bare domain to https', () => {
    expect(siteBase('spectrum.example')).toBe('https://spectrum.example')
  })

  it('preserves a subpath (the kit supports base:"./" hosting) and strips trailing slashes', () => {
    expect(siteBase('https://example.com/shop/')).toBe('https://example.com/shop')
    expect(siteBase('example.com/shop//')).toBe('https://example.com/shop')
  })

  it('drops query and hash — the base is a place, not a plan', () => {
    expect(siteBase('https://example.com/app?ref=x#y')).toBe('https://example.com/app')
  })

  it('rejects the unconfigured and the unusable', () => {
    expect(siteBase(undefined)).toBeNull()
    expect(siteBase('   ')).toBeNull()
    expect(siteBase('not a url at all //')).toBeNull()
  })

  it('refuses non-web protocols', () => {
    expect(siteBase('javascript:alert(1)')).toBeNull()
    expect(siteBase('chrome-extension://abc')).toBeNull()
  })
})

describe('deep links carry intent, never a plan', () => {
  it('builds the two link shapes off the base', () => {
    expect(portfolioUrl('https://example.com/shop')).toBe('https://example.com/shop/portfolio')
    expect(tokenUrl('https://example.com', '0xAbC', 4663)).toBe('https://example.com/token?addr=0xAbC&chain=4663')
  })
})
