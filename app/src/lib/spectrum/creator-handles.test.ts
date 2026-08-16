import { describe, expect, it } from 'vitest'
import {
  addressForIn,
  checkHandle,
  handleForIn,
  handleStateIn,
  isReservedHandle,
  normalizeHandle,
  resolveHandles,
  type HandleClaim,
} from './creator-handles'

// The feature is won or lost here (spec §4): two strings that LOOK the same
// must never both exist. Every test below is either a lookalike that MUST
// collide, a shape rule at its boundary, or an ordering rule the resolver has
// to get right for a shared link to keep pointing at the same person.

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const C = '0x3333333333333333333333333333333333333333'
const everyone = () => true

function claim(author: string, name: string, blockNumber: number, logIndex = 0): HandleClaim {
  return { author, subject: author, name, blockNumber: BigInt(blockNumber), logIndex }
}

const norm = (s: string) => normalizeHandle(s)?.normalized ?? null

describe('normalizeHandle — confusables', () => {
  // A copycat impersonates a creator with a name nobody can distinguish. Each
  // row is a spoof that MUST normalize onto the real name.
  const pairs: [string, string, string][] = [
    ['Cyrillic а U+0430', 'bаsedresearch', 'basedresearch'],
    ['Cyrillic е U+0435', 'basеdresearch', 'basedresearch'],
    ['Cyrillic о U+043E', 'fоundry', 'foundry'],
    ['Cyrillic р U+0440', 'рrismbeat', 'prismbeat'],
    ['Cyrillic с U+0441', 'сrypto', 'crypto'],
    ['Cyrillic х U+0445', 'maхi', 'maxi'],
    ['Cyrillic у U+0443', 'verу', 'very'],
    ['Cyrillic к U+043A', 'baкer', 'baker'],
    ['Cyrillic м U+043C', 'doмain', 'domain'],
    ['Cyrillic т U+0442', 'baskeтs', 'baskets'],
    ['Cyrillic uppercase А U+0410', 'Аlpha', 'alpha'],
    ['Greek ο U+03BF', 'fοundry', 'foundry'],
    ['Greek α U+03B1', 'bαsed', 'based'],
    ['Greek ν U+03BD', 'haνoc', 'havoc'],
    ['Greek ρ U+03C1', 'ρrism', 'prism'],
    ['Fullwidth ａ U+FF41', 'bａsed', 'based'],
    ['Fullwidth digit １ U+FF11', 'top１', 'top1'],
    ['Small capital ᴀ U+1D00', 'bᴀsed', 'based'],
    ['Dotless ı U+0131', 'maın', 'main'],
    ['Armenian օ U+0585', 'fօundry', 'foundry'],
    ['Cherokee lowercase U+AB7A', 'bꭺsed', 'based'],
    ['En dash U+2013', 'based–research', 'based-research'],
    ['Non-breaking hyphen U+2011', 'based‑research', 'based-research'],
    ['Minus sign U+2212', 'based−research', 'based-research'],
    ['Dashed low line U+FE4D', 'based﹍research', 'based_research'],
    ['Fullwidth low line U+FF3F', 'based＿research', 'based_research'],
  ]

  for (const [label, spoof, real] of pairs) {
    it(`${label} collides with the Latin name`, () => {
      expect(norm(spoof)).toBe(real)
      expect(norm(spoof)).toBe(norm(real))
    })
  }

  it('a whole name in Cyrillic collapses onto the Latin one', () => {
    expect(norm('сро')).toBe('cpo')
  })

  it('an unmapped script is refused rather than becoming a second name', () => {
    expect(norm('你好世')).toBeNull() // Han characters, no lookalike
    expect(checkHandle('你好世')).toEqual({ ok: false, fault: 'bad-characters' })
  })

  it('does NOT fold 0/o or 1/l, which are legal names a creator may want', () => {
    expect(norm('c0inbase')).toBe('c0inbase')
    expect(norm('coinbase')).toBe('coinbase')
    expect(norm('c0inbase')).not.toBe(norm('coinbase'))
  })
})

describe('normalizeHandle — invisible characters', () => {
  const hidden: [string, string][] = [
    ['zero-width space U+200B', 'based​research'],
    ['zero-width non-joiner U+200C', 'based‌research'],
    ['zero-width joiner U+200D', 'based‍research'],
    ['soft hyphen U+00AD', 'based­research'],
    ['word joiner U+2060', 'based⁠research'],
    ['byte order mark U+FEFF', 'based﻿research'],
    ['left-to-right mark U+200E', 'based‎research'],
    ['right-to-left mark U+200F', 'based‏research'],
    ['right-to-left override U+202E', '‮basedresearch'],
    ['left-to-right embedding U+202A', '‪based‬research'],
    ['first strong isolate U+2068', 'based⁨research⁩'],
    ['Hangul filler U+3164', 'basedㅤresearch'],
    ['Hangul choseong filler U+115F', 'basedᅟresearch'],
    ['braille blank U+2800', 'based⠀research'],
    ['combining acute U+0301', 'based́research'],
  ]

  for (const [label, spoof] of hidden) {
    it(`${label} is stripped entirely`, () => {
      expect(norm(spoof)).toBe('basedresearch')
    })
  }

  it('a name made only of invisibles is empty, never a claimable blank', () => {
    expect(checkHandle('​​ㅤ⠀')).toEqual({ ok: false, fault: 'empty' })
  })

  it('a bidi override cannot reverse a name into a different one', () => {
    expect(norm('‮moc‬')).toBe(norm('moc'))
  })
})

describe('normalizeHandle — shape rules at the boundary', () => {
  it('accepts exactly three characters and refuses two', () => {
    expect(norm('abc')).toBe('abc')
    expect(checkHandle('ab')).toEqual({ ok: false, fault: 'too-short' })
  })

  it('accepts exactly thirty characters and refuses thirty-one', () => {
    expect(norm('a'.repeat(30))).toBe('a'.repeat(30))
    expect(checkHandle('a'.repeat(31))).toEqual({ ok: false, fault: 'too-long' })
  })

  it('refuses a leading or trailing separator', () => {
    expect(checkHandle('-abc')).toEqual({ ok: false, fault: 'edge-separator' })
    expect(checkHandle('abc-')).toEqual({ ok: false, fault: 'edge-separator' })
    expect(checkHandle('_abc')).toEqual({ ok: false, fault: 'edge-separator' })
    expect(checkHandle('abc_')).toEqual({ ok: false, fault: 'edge-separator' })
  })

  it('refuses doubled separators in any combination', () => {
    for (const bad of ['a--b', 'a__b', 'a-_b', 'a_-b', 'ab---cd']) {
      expect(checkHandle(bad)).toEqual({ ok: false, fault: 'double-separator' })
    }
  })

  it('allows single separators inside the name', () => {
    expect(norm('based-research')).toBe('based-research')
    expect(norm('based_research')).toBe('based_research')
    expect(norm('a-b_c-d')).toBe('a-b_c-d')
  })

  it('refuses anything outside the allowlist', () => {
    for (const bad of ['ab!', 'a b', 'a.b', 'a/b', 'a\\b', 'a:b', 'a#b', 'a$b', 'a%b', 'a\nb']) {
      expect(checkHandle(bad)).toEqual({ ok: false, fault: 'bad-characters' })
    }
  })

  it('refuses empty and non-string input', () => {
    expect(checkHandle('')).toEqual({ ok: false, fault: 'empty' })
    expect(checkHandle('   ')).toEqual({ ok: false, fault: 'empty' })
    expect(checkHandle(null)).toEqual({ ok: false, fault: 'empty' })
    expect(checkHandle(undefined)).toEqual({ ok: false, fault: 'empty' })
    expect(checkHandle(42)).toEqual({ ok: false, fault: 'empty' })
  })

  it('drops a typed @ and surrounding whitespace', () => {
    expect(norm('  @basedresearch  ')).toBe('basedresearch')
  })

  it('keeps the typed casing for display and judges uniqueness on the fold', () => {
    const h = normalizeHandle('BasedResearch')
    expect(h?.normalized).toBe('basedresearch')
    expect(h?.display).toBe('BasedResearch')
  })

  it('falls back to the normalized form when the typed form is not plain ASCII', () => {
    // Letting the display carry a Cyrillic letter would re-open the exact
    // spoofing surface the fold closes.
    const h = normalizeHandle('bаsedresearch')
    expect(h?.normalized).toBe('basedresearch')
    expect(h?.display).toBe('basedresearch')
  })
})

describe('reserved names', () => {
  it('refuses every ruled name at claim time', () => {
    for (const name of ['spectrum', 'admin', 'support', 'help', 'supportdesk', 'official', 'team', 'mod', 'moderator', 'staff', 'security', 'billing', 'wallet', 'claim', 'airdrop']) {
      expect(checkHandle(name)).toEqual({ ok: false, fault: 'reserved' })
    }
  })

  it('refuses route segments so a page cannot collide with a name', () => {
    for (const name of ['explore', 'portfolio', 'launch', 'swap', 'learn', 'docs', 'create', 'setup', 'bundle', 'league', 'earn']) {
      expect(checkHandle(name)).toEqual({ ok: false, fault: 'reserved' })
    }
  })

  it('catches a reserved name behind casing and lookalikes', () => {
    expect(checkHandle('SPECTRUM')).toEqual({ ok: false, fault: 'reserved' })
    expect(checkHandle('spеctrum')).toEqual({ ok: false, fault: 'reserved' }) // Cyrillic е
    expect(checkHandle('ｓpectrum')).toEqual({ ok: false, fault: 'reserved' }) // fullwidth s
  })

  it('normalization is separate from reservation, so reserving is retroactive', () => {
    expect(normalizeHandle('spectrum')?.normalized).toBe('spectrum')
    expect(isReservedHandle('spectrum')).toBe(true)
  })

  it('ignores a reserved name at RESOLVE time, so an older claim stops working', () => {
    const map = resolveHandles([claim(A, 'spectrum', 1), claim(B, 'portfolio', 2)], everyone)
    expect(map.byHandle.size).toBe(0)
    expect(addressForIn(map, 'spectrum')).toBeNull()
    expect(addressForIn(map, 'portfolio')).toBeNull()
  })
})

describe('resolveHandles — who owns a name', () => {
  it('the earliest claim wins across blocks', () => {
    const map = resolveHandles([claim(B, 'alpha', 900), claim(A, 'alpha', 100)], everyone)
    expect(map.byHandle.get('alpha')?.address).toBe(A.toLowerCase())
  })

  it('the earliest claim wins on log index inside one block', () => {
    const map = resolveHandles([claim(B, 'alpha', 100, 7), claim(A, 'alpha', 100, 2)], everyone)
    expect(map.byHandle.get('alpha')?.address).toBe(A.toLowerCase())
  })

  it('does not trust the order it was handed', () => {
    const claims = [claim(C, 'alpha', 100, 9), claim(A, 'alpha', 100, 1), claim(B, 'alpha', 99, 50)]
    const forward = resolveHandles(claims, everyone)
    const backward = resolveHandles([...claims].reverse(), everyone)
    expect(forward.byHandle.get('alpha')?.address).toBe(B.toLowerCase())
    expect(backward.byHandle.get('alpha')?.address).toBe(B.toLowerCase())
  })

  it('a lookalike claimed later loses to the real name claimed first', () => {
    const map = resolveHandles(
      [claim(A, 'basedresearch', 10), claim(B, 'bаsedresearch', 11)],
      everyone,
    )
    expect(map.byHandle.size).toBe(1)
    expect(map.byHandle.get('basedresearch')?.address).toBe(A.toLowerCase())
    expect(map.byAddress.has(B.toLowerCase())).toBe(false)
  })

  it('drops a claim where the author is not the subject', () => {
    const impersonation: HandleClaim = { author: B, subject: A, name: 'alpha', blockNumber: 1n, logIndex: 0 }
    const map = resolveHandles([impersonation], everyone)
    expect(map.byHandle.size).toBe(0)
  })

  it('compares author and subject case-insensitively', () => {
    const checksummed: HandleClaim = {
      author: '0xAbC0000000000000000000000000000000000001',
      subject: '0xabc0000000000000000000000000000000000001',
      name: 'alpha',
      blockNumber: 1n,
      logIndex: 0,
    }
    const map = resolveHandles([checksummed], everyone)
    expect(map.byHandle.get('alpha')?.address).toBe('0xabc0000000000000000000000000000000000001')
  })

  it('drops a claimant who has never deployed a basket', () => {
    const shipped = new Set([A.toLowerCase()])
    const map = resolveHandles([claim(B, 'alpha', 1), claim(A, 'beta', 2)], (a) => shipped.has(a))
    expect(map.byHandle.has('alpha')).toBe(false)
    expect(map.byHandle.get('beta')?.address).toBe(A.toLowerCase())
  })

  it('a squatter who never shipped does not block the name for a creator who did', () => {
    const shipped = new Set([B.toLowerCase()])
    const map = resolveHandles([claim(A, 'alpha', 1), claim(B, 'alpha', 500)], (a) => shipped.has(a))
    expect(map.byHandle.get('alpha')?.address).toBe(B.toLowerCase())
  })

  it('gives each address exactly one current name', () => {
    const map = resolveHandles([claim(A, 'alpha', 1), claim(A, 'beta', 2), claim(A, 'gamma', 3)], everyone)
    expect(map.byAddress.get(A.toLowerCase())?.handle).toBe('gamma')
    expect(map.byHandle.size).toBe(1)
  })
})

describe('resolveHandles — renaming and retirement (spec §5)', () => {
  it('a rename retires the old name, which then resolves to nobody', () => {
    const map = resolveHandles([claim(A, 'alpha', 1), claim(A, 'beta', 2)], everyone)
    expect(map.byHandle.get('beta')?.address).toBe(A.toLowerCase())
    expect(map.byHandle.has('alpha')).toBe(false)
    expect(map.retired.get('alpha')).toBe(A.toLowerCase())
    expect(addressForIn(map, 'alpha')).toBeNull()
  })

  it('nobody else can take a retired name', () => {
    const map = resolveHandles([claim(A, 'alpha', 1), claim(A, 'beta', 2), claim(B, 'alpha', 3)], everyone)
    expect(addressForIn(map, 'alpha')).toBeNull()
    expect(map.retired.get('alpha')).toBe(A.toLowerCase())
    expect(map.byAddress.has(B.toLowerCase())).toBe(false)
  })

  it('the original claimant can take their own retired name back', () => {
    const map = resolveHandles(
      [claim(A, 'alpha', 1), claim(A, 'beta', 2), claim(B, 'alpha', 3), claim(A, 'alpha', 4)],
      everyone,
    )
    expect(map.byHandle.get('alpha')?.address).toBe(A.toLowerCase())
    expect(map.retired.has('alpha')).toBe(false)
    // Taking it back retires whatever they held in the meantime.
    expect(map.retired.get('beta')).toBe(A.toLowerCase())
    expect(map.byAddress.get(A.toLowerCase())?.handle).toBe('alpha')
  })

  it('a claim dropped because the name was taken does not resurrect when it retires', () => {
    // B asked for alpha while A held it, then A renamed away. B's old claim
    // must stay dead, or a shared link silently changes person.
    const map = resolveHandles([claim(A, 'alpha', 1), claim(B, 'alpha', 2), claim(A, 'beta', 3)], everyone)
    expect(addressForIn(map, 'alpha')).toBeNull()
    expect(map.byAddress.has(B.toLowerCase())).toBe(false)
  })

  it('re-claiming the name you already hold changes nothing', () => {
    const map = resolveHandles([claim(A, 'alpha', 1), claim(A, 'ALPHA', 2)], everyone)
    expect(map.byHandle.get('alpha')?.address).toBe(A.toLowerCase())
    expect(map.retired.size).toBe(0)
    expect(map.byHandle.size).toBe(1)
  })

  it('a malformed claim never destroys the name the author already holds', () => {
    const map = resolveHandles([claim(A, 'alpha', 1), claim(A, '!!', 2), claim(A, 'spectrum', 3)], everyone)
    expect(map.byHandle.get('alpha')?.address).toBe(A.toLowerCase())
    expect(map.retired.size).toBe(0)
  })

  it("the registry's clear releases the name, and it retires rather than freeing", () => {
    const map = resolveHandles([claim(A, 'alpha', 1), claim(A, '', 2), claim(B, 'alpha', 3)], everyone)
    expect(map.byAddress.has(A.toLowerCase())).toBe(false)
    expect(addressForIn(map, 'alpha')).toBeNull()
    expect(map.retired.get('alpha')).toBe(A.toLowerCase())
  })

  it('two renames retire both earlier names', () => {
    const map = resolveHandles([claim(A, 'one', 1), claim(A, 'two', 2), claim(A, 'three', 3)], everyone)
    expect(map.retired.get('one')).toBe(A.toLowerCase())
    expect(map.retired.get('two')).toBe(A.toLowerCase())
    expect(map.byHandle.get('three')?.address).toBe(A.toLowerCase())
  })
})

describe('lookups', () => {
  const map = resolveHandles([claim(A, 'alpha', 1), claim(A, 'beta', 2), claim(B, 'gamma', 3)], everyone)

  it('resolves a name to its owner, through a lookalike too', () => {
    expect(addressForIn(map, 'BETA')?.address).toBe(A.toLowerCase())
    expect(addressForIn(map, 'bеta')?.address).toBe(A.toLowerCase())
  })

  it('resolves an address to its current name', () => {
    expect(handleForIn(map, A)?.handle).toBe('beta')
    expect(handleForIn(map, A.toUpperCase())?.handle).toBe('beta')
    expect(handleForIn(map, C)).toBeNull()
    expect(handleForIn(map, null)).toBeNull()
  })

  it('states a name honestly for the claim form', () => {
    expect(handleStateIn(map, 'gamma')).toMatchObject({ state: 'taken' })
    expect(handleStateIn(map, 'gamma', B)).toMatchObject({ state: 'yours' })
    expect(handleStateIn(map, 'alpha')).toMatchObject({ state: 'retired', by: A.toLowerCase() })
    expect(handleStateIn(map, 'alpha', A)).toMatchObject({ state: 'reclaimable' })
    expect(handleStateIn(map, 'alpha', B)).toMatchObject({ state: 'retired' })
    expect(handleStateIn(map, 'brandnew')).toEqual({ state: 'free' })
    expect(handleStateIn(map, 'spectrum')).toEqual({ state: 'invalid', fault: 'reserved' })
    expect(handleStateIn(map, 'x')).toEqual({ state: 'invalid', fault: 'too-short' })
  })

  it('an empty claim set resolves to nobody rather than throwing', () => {
    const none = resolveHandles([], everyone)
    expect(addressForIn(none, 'alpha')).toBeNull()
    expect(handleForIn(none, A)).toBeNull()
  })
})
