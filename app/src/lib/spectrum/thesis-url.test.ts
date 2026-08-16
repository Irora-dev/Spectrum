import { describe, expect, it } from 'vitest'
import { resolveThesis, thesisHref, thesisRef, thesisSlug } from './thesis-url'
import { groupIntoTheses } from './thesis'
import type { BasketSummary } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// The slug is the only thing standing between a shared link and the wrong
// thesis, so the two properties that matter are pinned here: it must AGREE with
// the grouper (two spellings the grouper calls one idea must produce one link),
// and where it cannot agree it must REFUSE rather than pick.
// ─────────────────────────────────────────────────────────────────────────────

const DEP = '0x00000000000000000000000000000000000000c0'
const OTHER = '0x00000000000000000000000000000000000000ff'

let seq = 0
const leg = (over: Partial<BasketSummary> & { chainId: number }): BasketSummary =>
  ({
    address: `0x${(++seq).toString(16).padStart(40, '0')}`,
    name: 'Bullish EVM',
    symbol: 'BEVM',
    deployer: DEP,
    aumUsd: 1000,
    top: [],
    basketLength: 2,
    navPerToken: 1,
    change24hPct: null,
    pricedCount: 2,
    navSeries: [],
    ...over,
  }) as unknown as BasketSummary

describe('thesisSlug', () => {
  it('folds case and spacing exactly where the grouper folds them', () => {
    // the grouper calls these one idea; two links for one idea would split it
    expect(thesisSlug('Bullish EVM')).toBe(thesisSlug('  bullish   evm '))
    expect(groupIntoTheses([leg({ chainId: 1, name: 'Bullish EVM' }), leg({ chainId: 8453, name: '  bullish   evm ' })])).toHaveLength(1)
  })

  it('strips punctuation to single hyphens and never leads or trails with one', () => {
    expect(thesisSlug('!! The Long Game (2026) !!')).toBe('the-long-game-2026')
  })

  it('clips a very long name rather than minting a paragraph as a path', () => {
    const slug = thesisSlug('x'.repeat(400))
    expect(slug.length).toBeLessThanOrEqual(48)
  })

  it('is empty for a name with no path-safe characters, leaving the ref its hash', () => {
    expect(thesisSlug('📈📈📈')).toBe('')
    expect(thesisRef('📈📈📈')).toMatch(/^[0-9a-f]{8}$/)
    expect(thesisRef('📈📈📈')).not.toBe(thesisRef('🚀🚀🚀'))
  })
})

describe('thesisRef', () => {
  it('carries the readable half AND a hash, so a link cannot change meaning', () => {
    expect(thesisRef('Bullish EVM')).toMatch(/^bullish-evm-[0-9a-f]{8}$/)
  })

  it('hashes the GROUPER’S key, so two spellings of one idea mint one ref', () => {
    expect(thesisRef('Bullish EVM')).toBe(thesisRef('  bullish   evm '))
  })

  it('separates two names the readable half alone cannot', () => {
    expect(thesisSlug('Bullish EVM')).toBe(thesisSlug('Bullish-EVM'))
    expect(thesisRef('Bullish EVM')).not.toBe(thesisRef('Bullish-EVM'))
  })
})

describe('thesisHref', () => {
  it('lowercases the creator half, so one thesis has one address', () => {
    expect(thesisHref(DEP.toUpperCase(), 'Bullish EVM')).toBe(`/thesis/${DEP}/${thesisRef('Bullish EVM')}`)
  })
})

describe('resolveThesis', () => {
  it('round-trips: the link a thesis mints resolves back to that thesis', () => {
    const baskets = [leg({ chainId: 1, aumUsd: 500 }), leg({ chainId: 8453, aumUsd: 2000 })]
    const t = groupIntoTheses(baskets)[0]
    const slug = thesisHref(t.deployer, t.name).split('/').pop()!
    expect(resolveThesis(baskets, t.deployer, slug).hit?.chainIds).toEqual([8453, 1])
  })

  it('REFUSES a tie on the readable half rather than picking', () => {
    // the grouper keeps the hyphen, a path cannot keep the space: two ideas,
    // one readable slug. Picking would send a reader somewhere they did not ask
    // for, so the bare slug refuses.
    const baskets = [leg({ chainId: 1, name: 'Bullish EVM' }), leg({ chainId: 8453, name: 'Bullish-EVM' })]
    const m = resolveThesis(baskets, DEP, 'bullish-evm')
    expect(m.hit).toBeNull()
    expect(m.ambiguous).toHaveLength(2)

    // AND THE WAY OUT RESOLVES: the refs offered for those candidates each land
    // on exactly one thesis, or the tie screen would loop back to itself.
    for (const t of m.ambiguous) {
      const out = resolveThesis(baskets, DEP, thesisRef(t.name))
      expect(out.hit?.name, t.name).toBe(t.name)
    }
  })

  it('an exact ref beats the readable half even when that half is ambiguous', () => {
    const baskets = [leg({ chainId: 1, name: 'Bullish EVM' }), leg({ chainId: 8453, name: 'Bullish-EVM' })]
    expect(resolveThesis(baskets, DEP, thesisRef('Bullish-EVM')).hit?.name).toBe('Bullish-EVM')
  })

  it('ignores superseded versions — a fat retired v1 must not stand in for the live one', () => {
    const m = resolveThesis(
      [
        leg({ chainId: 8453, aumUsd: 9000, symbol: 'OLD', supersededBy: '0xabc' }),
        leg({ chainId: 8453, aumUsd: 10, symbol: 'NEW' }),
        leg({ chainId: 1, aumUsd: 10, symbol: 'NEW' }),
      ],
      DEP,
      'bullish-evm',
    )
    expect(m.hit?.legs.map((l) => l.symbol)).toEqual(['NEW', 'NEW'])
  })

  it('still resolves when only ONE leg could be read — a silent chain is not a missing thesis', () => {
    const m = resolveThesis([leg({ chainId: 8453 })], DEP, 'bullish-evm')
    expect(m.hit?.legs).toHaveLength(1)
  })

  it('never crosses creators, and refuses an empty deployer or slug', () => {
    const baskets = [leg({ chainId: 1 }), leg({ chainId: 8453 })]
    expect(resolveThesis(baskets, OTHER, 'bullish-evm').hit).toBeNull()
    expect(resolveThesis(baskets, DEP, '').hit).toBeNull()
    expect(resolveThesis(baskets, '', 'bullish-evm').hit).toBeNull()
  })

  it('resolves a checksummed or shouted deployer from the URL', () => {
    const baskets = [leg({ chainId: 1 }), leg({ chainId: 8453 })]
    expect(resolveThesis(baskets, DEP.toUpperCase(), 'BULLISH-EVM').hit).not.toBeNull()
  })
})
