import { describe, expect, it } from 'vitest'
import { draftShareUrl, stepDoor } from './launch-doors'
import { journeyOfBasket, journeyOfDraft, read, unread, type BasketRef, type DraftRef } from './launch-journey'
import { MAX_ASSETS } from './weights'
import { dominantTheme, suggestNames, suggestTicker, MAX_SUGGESTED_NAME } from './launch-names'

const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

const basket = (over: Partial<BasketRef> = {}) =>
  journeyOfBasket({
    chainId: 8453,
    address: '0x1111111111111111111111111111111111111111',
    name: 'Blue Chips',
    symbol: 'BLUE',
    supply: read(0),
    thesis: read(''),
    sharedLocally: false,
    ...over,
  })

const draft = (over: Partial<DraftRef> = {}) =>
  journeyOfDraft({
    kind: 'composer',
    key: 'spectrum:composer-draft:v1',
    chainId: null,
    predecessor: null,
    name: 'Half Built',
    symbol: 'HALF',
    assetCount: 2,
    symbols: ['WETH', 'USDC'],
    savedAt: 1,
    ...over,
  })

describe('every door opens something that already exists', () => {
  it('the seed door carries ?deployed=1 — that is what raises the shipped seed console', () => {
    const d = stepDoor(basket(), 'seed')!
    expect(d.href).toContain('deployed=1')
    expect(d.label).toBe('Seed it now')
  })

  it('the thesis door lands on the basket page by default', () => {
    expect(stepDoor(basket(), 'thesis')!.href).not.toContain('deployed=1')
  })

  it('the share door carries ?share=1 — the bare page has had no Share button since 2026-08-07', () => {
    // The old pin asserted share === thesis (the bare page); that encoded the
    // dead end the owner's 2026-08-14 recording surfaced: a "Share it" door
    // that landed on a page with no share affordance. ?share=1 is what raises
    // the shipped ShareModal (the drawn image card) on arrival.
    const d = stepDoor(basket(), 'share')!
    expect(d.href).toContain('?share=1')
    expect(d.href).not.toBe(stepDoor(basket(), 'thesis')!.href)
    expect(d.label).toBe('Share it')
  })

  it('a page that already hosts a step points at it in place instead of at itself', () => {
    expect(stepDoor(basket(), 'thesis', { thesis: '#thesis-editor' })!.href).toBe('#thesis-editor')
    expect(stepDoor(basket(), 'share', { share: '#share' })!.href).toBe('#share')
  })

  it('a composer draft resumes at bare /create, which restores it on mount', () => {
    expect(stepDoor(draft(), 'build')!.href).toBe('/create')
  })

  it('a builder draft lands on the MODERN create page — the studio is never linked (owner 2026-08-14)', () => {
    const j = draft({ kind: 'builder', key: 'spectrum:launch-draft:v2:8453', chainId: 8453 })
    const d = stepDoor(j, 'build')!
    expect(d.href).toBe('/create')
    expect(d.href).not.toContain('studio=1')
  })

  it('a version-mode draft reopens NAMING its predecessor — its key is scoped to it', () => {
    const j = draft({
      kind: 'builder',
      key: 'spectrum:launch-draft:v2:8453:from:0xabc',
      chainId: 8453,
      predecessor: '0xabc',
    })
    expect(stepDoor(j, 'build')!.href).toBe('/create?from=0xabc&chain=8453')
  })

  it('a draft has no seed, thesis or share door — there is no basket to point at', () => {
    for (const step of ['seed', 'thesis', 'share'] as const) expect(stepDoor(draft(), step)).toBeNull()
  })

  it('an unreadable basket still gets its doors — not knowing is not a dead end', () => {
    expect(stepDoor(basket({ supply: unread('rpc refused') }), 'seed')).not.toBeNull()
  })
})

describe('the share-this-draft link builds what the shipped parser accepts', () => {
  it('emits the /createbasket wire format', () => {
    expect(draftShareUrl({ addresses: [WETH, USDC], chainId: 8453 })).toBe(
      `/createbasket?tokens=${WETH},${USDC}&chain=8453`,
    )
  })

  it('lowercases and de-duplicates, the way the parser itself does', () => {
    const url = draftShareUrl({ addresses: [WETH.toUpperCase(), WETH, USDC], chainId: 1 })!
    expect(url).toBe(`/createbasket?tokens=${WETH},${USDC}&chain=1`)
  })

  it('drops anything that is not a 20-byte address rather than passing junk on', () => {
    expect(draftShareUrl({ addresses: ['0xnope', '', WETH], chainId: 1 })).toBe(
      `/createbasket?tokens=${WETH}&chain=1`,
    )
  })

  it('caps at the same MAX_ASSETS the parser slices to', () => {
    const many = Array.from({ length: MAX_ASSETS + 5 }, (_, i) => `0x${String(i).padStart(40, '0')}`)
    const url = draftShareUrl({ addresses: many, chainId: 1 })!
    expect(url.split('tokens=')[1].split('&')[0].split(',')).toHaveLength(MAX_ASSETS)
  })

  it('is null when nothing valid survives — never a link to an empty composer', () => {
    expect(draftShareUrl({ addresses: [], chainId: 1 })).toBeNull()
    expect(draftShareUrl({ addresses: ['nonsense'], chainId: 1 })).toBeNull()
    expect(draftShareUrl({ addresses: [WETH], chainId: Number.NaN })).toBeNull()
  })

  it('takes an origin for a clipboard-ready absolute link, without doubling the slash', () => {
    expect(draftShareUrl({ addresses: [WETH], chainId: 1, origin: 'https://x.io/' })).toBe(
      `https://x.io/createbasket?tokens=${WETH}&chain=1`,
    )
  })
})

describe('name suggestions are offered, never enforced', () => {
  it('names the sector when the picks agree on one', () => {
    const names = suggestNames(['AAVE', 'UNI', 'SYRUP'])
    expect(names[0]).toContain('DeFi')
    expect(dominantTheme(['AAVE', 'UNI', 'SYRUP'])).toBe('defi')
  })

  it('never guesses a sector from untagged picks', () => {
    expect(dominantTheme(['ZZZ', 'QQQ'])).toBeNull()
    expect(suggestNames(['ZZZ', 'QQQ']).join(' ')).not.toMatch(/DeFi|AI|Memes|Stocks/)
  })

  it('one tagged asset in a crowd does not name the basket', () => {
    expect(dominantTheme(['AAVE', 'ZZZ', 'QQQ', 'YYY', 'XXX'])).toBeNull()
  })

  it('says "Basket", never "index" — the house word', () => {
    expect(suggestNames(['AAVE', 'UNI']).join(' ').toLowerCase()).not.toContain('index')
  })

  it('always offers something for a non-empty pick, and nothing for an empty one', () => {
    expect(suggestNames(['WETH']).length).toBeGreaterThan(0)
    expect(suggestNames([])).toEqual([])
    expect(suggestNames(['  ', ''])).toEqual([])
  })

  it('stays inside its length bound and never repeats itself', () => {
    const names = suggestNames(['AAVE', 'UNI', 'SYRUP', 'cbBTC'])
    for (const n of names) expect(n.length).toBeLessThanOrEqual(MAX_SUGGESTED_NAME)
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length)
  })

  it('the ticker suggestion is letters, short, and null when there is nothing to make one from', () => {
    expect(suggestTicker('Blue Chip Basket')).toBe('BCB')
    expect(suggestTicker('Memes')).toBe('MEMES')
    expect(suggestTicker('The And')).toBeNull()
    expect(suggestTicker('!!')).toBeNull()
    expect(suggestTicker('A Very Long Basket Name Of Many Words Indeed')!.length).toBeLessThanOrEqual(8)
  })
})
