import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// WHICH FACTORY MAY SPEAK FOR A BASKET (mint-funding.ts `lensFactoryFor`).
//
// Generation is a property of the factory/basket PAIR — the split field landed on
// both sides in one change — and superseded lineages stay listed and tradable
// here (owner 2026-08-01). Ask a NEW packing factory about an OLD basket and it
// answers a PACKED word: the old basket has no split field, reads the whole word
// as the floor, and every buy on every legacy basket reverts LegMinNotMet. The
// mirror mistake (a legacy factory answering for a current basket) ships a bare
// floor with no split, which is the measured NoOutput bug.
//
// ⚠ AUDIT 2026-08-06: the fix claims resolution "at all four call sites" and
// nothing asserted it anywhere. These rows are that assertion.
//
// THE SEAM: `lineageFor` (basket-data.ts) takes exactly two things from outside —
// the chain's lineage list (`chainCfg`) and a read client (`clientFor`) — and asks
// each candidate factory's own `tokens(basket)` registry, current first. Both are
// faked below, so the REAL candidate walk runs with no network.
// ─────────────────────────────────────────────────────────────────────────────

/** Hoisted so the (hoisted) vi.mock factories below can name them. */
const A = vi.hoisted(() => ({
  current: '0x00000000000000000000000000000000000cf001' as `0x${string}`,
  currentRouter: '0x00000000000000000000000000000000000c7001' as `0x${string}`,
  legacy: '0x000000000000000000000000000000000001e9c1' as `0x${string}`,
  legacyRouter: '0x000000000000000000000000000000000001e7c1' as `0x${string}`,
}))
const DEPLOYER = '0x00000000000000000000000000000000000de907' as const
const ZERO = '0x0000000000000000000000000000000000000000' as const
const CHAIN = 8453

/** `${factory}:${basket}` (lowercased) → the deployer that registry returns. */
const registry = vi.hoisted(() => new Map<string, string>())
/** Factories whose registry cannot answer at all (a reverting or unreachable read). */
const mute = vi.hoisted(() => new Set<string>())
/** Every factory asked, in order — so "never fell back" is provable, not implied. */
const asked = vi.hoisted(() => [] as string[])

vi.mock('../chain/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chain/chains')>()
  return {
    ...actual,
    // One current lineage + one superseded one, so the candidate order is testable
    // without depending on what an operator's deployments.json happens to hold.
    chainCfg: (chainId: number) => ({
      ...actual.chainCfg(chainId),
      factory: A.current,
      swapRouter: A.currentRouter,
      legacy: [{ factory: A.legacy, swapRouter: A.legacyRouter }],
    }),
  }
})

vi.mock('../chain/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chain/rpc')>()
  return {
    ...actual,
    clientFor: (() => ({
      readContract: async (opts: { address: string; functionName: string; args?: readonly unknown[] }) => {
        const factory = String(opts.address).toLowerCase()
        asked.push(factory)
        // `tokens` is the only read this path may make; anything else means the
        // module under test changed shape and the fixture is lying about it.
        if (opts.functionName !== 'tokens') throw new Error(`unexpected read: ${opts.functionName}`)
        if (mute.has(factory)) throw new Error('this registry cannot answer')
        return registry.get(`${factory}:${String(opts.args?.[0] ?? '').toLowerCase()}`) ?? ZERO
      },
    })) as unknown as typeof actual.clientFor,
  }
})

const { lensFactoryFor } = await import('./mint-funding')

/** A fresh basket address per case: `lineageFor` memoizes per chain+address. */
let n = 0
const nextBasket = () => `0x${(++n).toString(16).padStart(40, 'b')}` as `0x${string}`
const register = (factory: string, basket: string) =>
  registry.set(`${factory.toLowerCase()}:${basket.toLowerCase()}`, DEPLOYER)

describe('lensFactoryFor — a basket is answered by ITS OWN lineage', () => {
  beforeEach(() => {
    asked.length = 0
    mute.clear()
  })

  it('a basket on a SUPERSEDED lineage resolves to that lineage factory, not the current one', () => {
    // The severe case: the current factory packs, this basket cannot read a packed
    // word, and a packed split reads as an astronomical floor ⇒ LegMinNotMet on
    // every buy of every legacy basket.
    const basket = nextBasket()
    register(A.legacy, basket)
    return expect(lensFactoryFor(CHAIN, basket)).resolves.toBe(A.legacy)
  })

  it('never answers the CURRENT factory for a legacy basket, even though it is asked first', async () => {
    const basket = nextBasket()
    register(A.legacy, basket)
    const factory = await lensFactoryFor(CHAIN, basket)
    expect(factory).not.toBe(A.current)
    // the current registry WAS consulted and honestly said "not mine" (zero deployer)
    expect(asked).toEqual([A.current.toLowerCase(), A.legacy.toLowerCase()])
  })

  it('a basket on the CURRENT lineage resolves to the current factory', async () => {
    const basket = nextBasket()
    register(A.current, basket)
    expect(await lensFactoryFor(CHAIN, basket)).toBe(A.current)
    // and stops there: no legacy registry is consulted once the basket is claimed
    expect(asked).toEqual([A.current.toLowerCase()])
  })

  it('an UNKNOWN basket refuses rather than falling back to the current factory', async () => {
    // Falling back is the whole failure mode: the caller would then hand
    // resolveMintFunding a factory that has never heard of this basket, and the
    // answer would be about a different generation.
    const basket = nextBasket()
    expect(await lensFactoryFor(CHAIN, basket)).toBeNull()
    expect(asked).toEqual([A.current.toLowerCase(), A.legacy.toLowerCase()])
  })

  it('a registry that CANNOT answer is not a claim on the basket', async () => {
    // A reverting or unreachable current registry must not swallow the basket; the
    // legacy lineage still gets its turn, and it is the one that owns this basket.
    const basket = nextBasket()
    mute.add(A.current.toLowerCase())
    register(A.legacy, basket)
    expect(await lensFactoryFor(CHAIN, basket)).toBe(A.legacy)
  })

  it('refuses when NO registry can answer (a read that did not land is not a lineage)', async () => {
    const basket = nextBasket()
    mute.add(A.current.toLowerCase())
    mute.add(A.legacy.toLowerCase())
    register(A.legacy, basket)
    expect(await lensFactoryFor(CHAIN, basket)).toBeNull()
  })

  it('resolves each basket on its own, never on the last one answered', async () => {
    // The memo is per chain+address; a legacy basket must not tint the next lookup.
    const legacyBasket = nextBasket()
    const currentBasket = nextBasket()
    register(A.legacy, legacyBasket)
    register(A.current, currentBasket)
    expect(await lensFactoryFor(CHAIN, legacyBasket)).toBe(A.legacy)
    expect(await lensFactoryFor(CHAIN, currentBasket)).toBe(A.current)
    expect(await lensFactoryFor(CHAIN, legacyBasket)).toBe(A.legacy) // memoized, still its own
  })
})
