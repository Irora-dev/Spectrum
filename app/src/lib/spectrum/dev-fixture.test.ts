import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SUPPORTED_CHAIN_IDS } from '../chain/chains'

// ─────────────────────────────────────────────────────────────────────────────
// THE DEMO BOOK'S OWN INVARIANTS.
//
// Written after a real defect (2026-08-07): the opaque-basket fixture was given
// `…ba5e0d`, an address 'Full Stack Base' already carried, so the demo book
// listed TWO baskets under ONE identity. React logged a duplicate key on
// /explore for every list that keys by `chainId:address`, and any
// address-keyed lookup answered with whichever of the two it reached first.
// Typecheck, 1630 unit tests, lint and the production build were ALL GREEN the
// whole time it was live — nothing in the suite ever looked at the book as a set.
//
// The demo book is what the owner reviews on and what a new builder sees first,
// so a collision here is not "just fixtures": it silently changes what the app
// appears to do.
//
// These assert the OBSERVABLE list rather than the private array, because
// `chainId:address` — the thing that collided — is a property of what the app
// is handed, not of how the fixture happens to be stored.
// ─────────────────────────────────────────────────────────────────────────────

// The book only stands up under the force switch, and `fixtureMode` is captured
// at module scope — so the env has to be stubbed BEFORE the import, not after.
// (The first draft of this file imported at the top and every assertion passed
// against an EMPTY book. The guard below is what caught it, and is why it is
// the first test rather than an afterthought.)
let devBasketSummaries: (chainId: number) => { chainId: number; address: string; symbol: string }[] | null

beforeAll(async () => {
  vi.stubEnv('VITE_DEV_FIXTURE', '1')
  vi.resetModules()
  ;({ devBasketSummaries } = await import('./dev-fixture'))
})

function everyDemoBasket() {
  return SUPPORTED_CHAIN_IDS.flatMap((chainId) => devBasketSummaries(chainId) ?? [])
}

describe('the demo book is internally consistent', () => {
  it('lists something to check at all — an empty book would pass every test below', () => {
    expect(everyDemoBasket().length).toBeGreaterThan(0)
  })

  it('gives every basket its own identity: one chainId:address, one basket', () => {
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const b of everyDemoBasket()) {
      const key = `${b.chainId}:${b.address.toLowerCase()}`
      const previous = seen.get(key)
      if (previous && previous !== b.symbol) collisions.push(`${key} is claimed by both $${previous} and $${b.symbol}`)
      else seen.set(key, b.symbol)
    }
    expect(collisions).toEqual([])
  })

  it('gives every basket on a chain its own ticker, so a symbol lookup is unambiguous', () => {
    const collisions: string[] = []
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      const seen = new Map<string, string>()
      for (const b of devBasketSummaries(chainId) ?? []) {
        const key = b.symbol.toUpperCase()
        const previous = seen.get(key)
        if (previous && previous !== b.address.toLowerCase()) {
          collisions.push(`${chainId}: $${key} is claimed by both ${previous} and ${b.address.toLowerCase()}`)
        } else seen.set(key, b.address.toLowerCase())
      }
    }
    expect(collisions).toEqual([])
  })

  it('holds addresses that are real 20-byte hex — a malformed one reads as a live address', () => {
    const malformed = everyDemoBasket()
      .filter((b) => !/^0x[0-9a-fA-F]{40}$/.test(b.address))
      .map((b) => `$${b.symbol}: ${b.address}`)
    expect(malformed).toEqual([])
  })
})
