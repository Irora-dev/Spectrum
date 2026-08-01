import { describe, expect, it } from 'vitest'
import {
  addrPrefix,
  basketHref,
  basketRef,
  bundleHref,
  chainFromSlug,
  chainSlug,
  creatorHref,
  resolveBasketRef,
} from './short-url'
import type { BasketSummary } from './basket-data'

const b = (address: string, symbol: string, chainId = 4663): BasketSummary =>
  ({ address, symbol, chainId, name: symbol, aumUsd: 0 } as unknown as BasketSummary)

const T2 = b('0x29374eaadbb63b27c9a806b76f2862635d8d8088', 'T2')
const WSB = b('0x6c8c140d2c7c0a546082c101968d7eb387cfc088', 'WSB')
const DEFI = b('0x20cea835ed6d1720e55e0445e327bfcce40a8088', 'DEFI', 1)
// a deliberate ticker twin on the SAME chain — the case a bare symbol can't serve
const T2_TWIN = b('0xaaaa0000000000000000000000000000000000ff', 'T2')

describe('chain slugs', () => {
  it('letters the known chains and round-trips them', () => {
    expect(chainSlug(4663)).toBe('r')
    expect(chainSlug(8453)).toBe('b')
    expect(chainSlug(1)).toBe('e')
    for (const id of [1, 8453, 4663]) expect(chainFromSlug(chainSlug(id))).toBe(id)
  })
  it('an unknown chain falls back to its id, so a self-hosted chain still works', () => {
    expect(chainSlug(999)).toBe('999')
    expect(chainFromSlug('999')).toBe(999)
  })
  it('rejects nonsense', () => {
    expect(chainFromSlug('nope')).toBeNull()
    expect(chainFromSlug('-1')).toBeNull()
  })
})

describe('basketRef — the canonical short id', () => {
  it('is SYMBOL-<8hex>: legible to a human, exact for the machine', () => {
    expect(basketRef(T2)).toBe('T2-29374eaa')
    expect(basketHref(T2)).toBe('/t/r/T2-29374eaa')
    expect(basketHref(DEFI)).toBe('/t/e/DEFI-20cea835')
  })
  it('drops to the address prefix when a symbol has no business in a path', () => {
    expect(basketRef(b('0x29374eaadbb63b27c9a806b76f2862635d8d8088', 'A B/C'))).toBe('29374eaa')
  })
  it('the ref is derived only from address + symbol, so it never depends on who else exists', () => {
    // The stability guarantee: minting a ref must not consult the basket list,
    // or a link's meaning could change when a twin launches later.
    expect(basketRef(T2)).toBe(basketRef({ symbol: 'T2', address: T2.address }))
  })
})

describe('resolveBasketRef', () => {
  const all = [T2, WSB, DEFI, T2_TWIN]

  it('resolves the canonical ref even when the ticker has a twin', () => {
    expect(resolveBasketRef('T2-29374eaa', 4663, all).hit).toBe(T2)
    expect(resolveBasketRef('T2-aaaa0000', 4663, all).hit).toBe(T2_TWIN)
  })

  it('accepts a full address — the always-works escape hatch', () => {
    expect(resolveBasketRef(T2.address, 4663, all).hit).toBe(T2)
    expect(resolveBasketRef(T2.address.toUpperCase(), 4663, all).hit).toBe(T2)
  })

  it('accepts a bare hex prefix', () => {
    expect(resolveBasketRef('29374eaa', 4663, all).hit).toBe(T2)
  })

  it('accepts a bare symbol when it is unique on the chain', () => {
    expect(resolveBasketRef('WSB', 4663, all).hit).toBe(WSB)
    expect(resolveBasketRef('wsb', 4663, all).hit).toBe(WSB)
  })

  it('REFUSES to guess when a bare symbol is ambiguous', () => {
    const r = resolveBasketRef('T2', 4663, all)
    expect(r.hit).toBeNull()
    expect(r.ambiguous).toHaveLength(2)
  })

  it('a symbol that merely looks hexy still resolves as a symbol', () => {
    // DEFI is [d,e,f,i] — the `i` keeps it out of the hex branch, but BEEF
    // would fall INTO it and must still come back out via the symbol branch.
    const beef = b('0x1111000000000000000000000000000000000001', 'BEEF', 1)
    expect(resolveBasketRef('DEFI', 1, [DEFI, beef]).hit).toBe(DEFI)
    expect(resolveBasketRef('BEEF', 1, [DEFI, beef]).hit).toBe(beef)
  })

  it('the chain narrows the search — the same ticker on two chains is not ambiguous', () => {
    const t2OnEth = b('0xbbbb0000000000000000000000000000000000ff', 'T2', 1)
    expect(resolveBasketRef('T2', 1, [T2, t2OnEth]).hit).toBe(t2OnEth)
  })

  it('an unknown ref resolves to nothing rather than something plausible', () => {
    const r = resolveBasketRef('NOPE-deadbeef', 4663, all)
    expect(r.hit).toBeNull()
    expect(r.ambiguous).toHaveLength(0)
    expect(resolveBasketRef('', 4663, all).hit).toBeNull()
  })
})

describe('creator + bundle paths', () => {
  const addr = '0xF4E6CCBEA77A070B84EC182674A52D9B62826554'
  const lower = addr.toLowerCase()
  it('is address-only and lowercased — a name here would 404 until the page resolves ENS', () => {
    expect(creatorHref(addr)).toBe(`/c/${lower}`)
  })
  it('bundle paths carry the slug untouched', () => {
    expect(bundleHref(addr, '1a2b3c4d')).toBe(`/b/${lower}/1a2b3c4d`)
  })
  it('addrPrefix is the first 4 bytes, lowercased', () => {
    expect(addrPrefix('0xF4E6CCBEA77A070B84EC182674A52D9B62826554')).toBe('f4e6ccbe')
  })
})

describe('resolveBasketRef — the attacks', () => {
  const REAL = b('0x6c8c140d2c7c0a546082c101968d7eb387cfc088', 'WSB')
  const SCAM = b('0xfacade0000000000000000000000000000000001', 'SCAM')
  const FACADE = b('0x1111000000000000000000000000000000000002', 'FACADE')

  it('REFUSES a ref whose symbol half disagrees with its address half', () => {
    // /t/b/USDC-6c8c140d used to resolve straight to WSB and render a buy
    // console. The human half is attacker-supplied text; it must be checked.
    const r = resolveBasketRef('USDC-6c8c140d', 4663, [REAL])
    expect(r.hit).toBeNull()
    expect(r.ambiguous).toHaveLength(0)
    // the honest ref still works
    expect(resolveBasketRef('WSB-6c8c140d', 4663, [REAL]).hit).toBe(REAL)
  })

  it('a hex-LOOKING ticker resolves to the ticker, not to a mined address prefix', () => {
    // basket addresses are CREATE2 with a ground salt, so 0xfacade… is cheap to
    // mine — the bare ticker FACADE must not land on it.
    expect(resolveBasketRef('FACADE', 4663, [FACADE, SCAM]).hit).toBe(FACADE)
  })

  it('chainFromSlug rejects prototype keys and Number() aliases', () => {
    for (const bad of ['constructor', '__proto__', '0x10', '1e3', ' 1', '1.0', '+1']) {
      expect(chainFromSlug(bad)).toBeNull()
    }
    expect(chainFromSlug('42161')).toBe(42161)
  })
})
