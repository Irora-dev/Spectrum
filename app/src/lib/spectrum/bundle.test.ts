import { describe, expect, it } from 'vitest'
import {
  MAX_BUNDLE_LEGS,
  bundleChains,
  decodeBundle,
  encodeBundleParams,
  normalizedLegs,
  splitBudget,
  type Bundle,
} from './bundle'

const A = `0x${'a'.repeat(40)}`
const B = `0x${'b'.repeat(40)}`
const C = `0x${'c'.repeat(40)}`
const KOL = `0x${'d'.repeat(40)}`

describe('encode/decode round-trip', () => {
  it('round-trips legs, creator and name', () => {
    const b: Bundle = { legs: [{ chainId: 1, address: A, weight: 60 }, { chainId: 8453, address: B, weight: 40 }], by: KOL, name: 'Cross-chain majors' }
    const decoded = decodeBundle(encodeBundleParams(b).toString())
    expect(decoded.legs).toEqual(b.legs)
    expect(decoded.by).toBe(KOL)
    expect(decoded.name).toBe('Cross-chain majors')
  })

  it('drops zero/invalid legs on encode', () => {
    const p = encodeBundleParams({ legs: [{ chainId: 1, address: A, weight: 50 }, { chainId: 1, address: 'nope', weight: 50 }, { chainId: 1, address: B, weight: 0 }], by: null, name: null })
    expect(decodeBundle(p.toString()).legs).toEqual([{ chainId: 1, address: A, weight: 50 }])
  })

  it('drops invalid legs + dupes on decode, and rejects a bad creator', () => {
    const d = decodeBundle('b=1-' + A + '-60_1-' + A + '-20_999-bad-10&by=notanaddr')
    expect(d.legs).toEqual([{ chainId: 1, address: A, weight: 60 }]) // dupe + malformed dropped
    expect(d.by).toBeNull()
  })

  it('caps at MAX_BUNDLE_LEGS', () => {
    const legs = Array.from({ length: MAX_BUNDLE_LEGS + 3 }, (_, i) => ({ chainId: 1, address: `0x${String(i).padStart(40, '0')}`, weight: 10 }))
    expect(decodeBundle(encodeBundleParams({ legs, by: null, name: null }).toString()).legs).toHaveLength(MAX_BUNDLE_LEGS)
  })

  it('is empty for a URL with no bundle', () => {
    const d = decodeBundle('foo=bar')
    expect(d.legs).toEqual([])
    expect(d.by).toBeNull()
  })
})

describe('normalizedLegs', () => {
  it('normalises relative weights to ~100', () => {
    const norm = normalizedLegs([{ chainId: 1, address: A, weight: 3 }, { chainId: 8453, address: B, weight: 1 }])
    expect(norm[0].pct).toBeCloseTo(75)
    expect(norm[1].pct).toBeCloseTo(25)
  })
  it('is all-zero when weights sum to zero', () => {
    expect(normalizedLegs([{ chainId: 1, address: A, weight: 0 }])[0].pct).toBe(0)
  })
})

describe('splitBudget', () => {
  it('splits a budget by normalised weight', () => {
    const s = splitBudget([{ chainId: 1, address: A, weight: 60 }, { chainId: 8453, address: B, weight: 40 }], 1000)
    expect(s[0]).toBeCloseTo(600)
    expect(s[1]).toBeCloseTo(400)
  })
  it('is all-zero for a non-positive budget', () => {
    expect(splitBudget([{ chainId: 1, address: A, weight: 1 }], 0)).toEqual([0])
  })
})

describe('bundleChains', () => {
  it('lists distinct chains in first-seen order', () => {
    expect(bundleChains([{ chainId: 8453, address: A, weight: 1 }, { chainId: 1, address: B, weight: 1 }, { chainId: 8453, address: C, weight: 1 }])).toEqual([8453, 1])
  })
})
