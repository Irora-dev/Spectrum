import { describe, expect, it } from 'vitest'
import { DEFAULT_HIDDEN_BASKETS, parseHiddenBaskets } from './basket-data'

const A = '0x74D8c56314d7310d491e1b271567Cf2283ed301B'
const B = '0xa1d2116c176b271dd39007a87c2d11cfea253da8'

describe('parseHiddenBaskets (VITE_HIDDEN_BASKETS — operator list-curation)', () => {
  it('ships empty: unset/empty env hides nothing', () => {
    expect(parseHiddenBaskets(undefined).size).toBe(0)
    expect(parseHiddenBaskets('').size).toBe(0)
    expect(parseHiddenBaskets('  ,  ,').size).toBe(0)
  })
  it('parses a comma-separated list, lowercased, whitespace-tolerant', () => {
    const set = parseHiddenBaskets(` ${A} , ${B}`)
    expect(set.size).toBe(2)
    expect(set.has(A.toLowerCase())).toBe(true)
    expect(set.has(B)).toBe(true) // already lowercase
  })
  it('drops malformed entries without poisoning valid ones', () => {
    const set = parseHiddenBaskets(`not-an-address, ${A}, 0x1234`)
    expect(set.size).toBe(1)
    expect(set.has(A.toLowerCase())).toBe(true)
  })
  it('the default hide-list is the three protocol test baskets, pre-lowercased', () => {
    expect(DEFAULT_HIDDEN_BASKETS).toHaveLength(3)
    for (const a of DEFAULT_HIDDEN_BASKETS) {
      expect(a).toMatch(/^0x[0-9a-f]{40}$/) // lowercase — HIDDEN_BASKETS compares lowercased
    }
    expect(DEFAULT_HIDDEN_BASKETS).toContain('0x48fd8ab4670508361d2f5f0e936201b344024088')
  })
})
