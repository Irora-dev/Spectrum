// THE ONE-ASSET LAW (owner 2026-08-13) — pinned end to end.
//
// the owner: "for simplicity can't we allow a basket to just have one asset? since
// the multi-chain baskets can always have one asset on one chain and a future
// upgrade could always add more."
//
// The ≥2 minimum was OURS, never the factory's: scripts/one-leg-probe.ts
// eth_call-simulated a one-leg deployBasket green on the production Base
// factory, the production Ethereum factory, and the rehearsal Base factory —
// each next to a two-leg control through the same code. These tests pin the
// pure half of that ruling: one leg is a VALID basket, its weight is exactly
// 100, and it survives the whole compose → deploy-array path. What replaced
// the block is a sentence (SINGLE_ASSET_NOTE), so that is pinned too.
import { describe, expect, it } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import {
  addAsset,
  adjustWeight,
  CAP,
  equalSplit,
  isValid,
  MAX_ASSETS,
  MIN_ASSETS,
  removeAsset,
  SINGLE_ASSET_NOTE,
  sum,
} from './weights'
import { toBasketEntries, type DeployAssetInput } from './deploy'
import { Venue, type BasketRoute } from '../pools/types'

const V3_ROUTE: BasketRoute = {
  venue: Venue.V3,
  ethPool: { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress },
  v3Fee: 3000,
  v2Pair: zeroAddress,
}
const leg = (address: string): DeployAssetInput => ({ address: address as Address, decimals: 18, route: V3_ROUTE })

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

describe('the leg-count floor is 1, not 2', () => {
  it('MIN_ASSETS is 1 — the law, not a magic number at a call site', () => {
    expect(MIN_ASSETS).toBe(1)
  })

  it('a single leg is a VALID weight vector — it is simply 100%', () => {
    expect(isValid([CAP])).toBe(true)
    expect(equalSplit(1)).toEqual([CAP])
    expect(sum(equalSplit(1))).toBe(CAP)
  })

  it('an empty basket is still refused — relaxing to 1 did not relax to 0', () => {
    expect(isValid([])).toBe(false)
    expect(equalSplit(0)).toEqual([])
  })

  it('the 20-asset ceiling is untouched by the new floor', () => {
    expect(isValid(equalSplit(MAX_ASSETS))).toBe(true)
    expect(isValid(new Array(MAX_ASSETS + 1).fill(0))).toBe(false)
  })
})

describe('a lone leg stays pinned at 100 through every weight move', () => {
  it('adjustWeight refuses at n=1 — there is no counterparty, so mass cannot drift', () => {
    expect(adjustWeight([CAP], 0, -25)).toEqual([CAP])
    expect(adjustWeight([CAP], 0, +25)).toEqual([CAP])
  })

  it('adding a second asset to a lone leg re-lands Σ on exactly 100', () => {
    const w = addAsset([CAP])
    expect(w).toHaveLength(2)
    expect(sum(w)).toBe(CAP)
    expect(isValid(w)).toBe(true)
  })

  it('removing back down to one leg restores it to the whole basket', () => {
    const w = removeAsset([60, 40], 1)
    expect(w).toEqual([CAP])
    expect(isValid(w)).toBe(true)
  })
})

describe('the deploy array the factory actually receives', () => {
  it('one leg encodes as a single entry at 10000 bps (Σ the factory enforces)', () => {
    const entries = toBasketEntries([leg(A)], [CAP])
    expect(entries).toHaveLength(1)
    expect(entries[0].weight).toBe(10_000)
    expect(entries.reduce((s, e) => s + e.weight, 0)).toBe(10_000)
  })

  it('two legs are unchanged by the relaxation', () => {
    const entries = toBasketEntries([leg(A), leg(B)], [50, 50])
    expect(entries.map((e) => e.weight)).toEqual([5_000, 5_000])
  })

  it('a lone leg at less than 100 is still refused — Σ=CAP is the contract law', () => {
    expect(() => toBasketEntries([leg(A)], [99])).toThrow(/sum to 100/)
  })
})

describe('what replaced the block is a sentence, not silence', () => {
  it('the note states the tracking truth AND that the fee is unchanged', () => {
    expect(SINGLE_ASSET_NOTE).toMatch(/One asset/i)
    expect(SINGLE_ASSET_NOTE).toMatch(/rather than spreading risk/i)
    expect(SINGLE_ASSET_NOTE).toMatch(/creator fee still applies/i)
  })

  it('it stays one short line — a fact, not a lecture', () => {
    expect(SINGLE_ASSET_NOTE.length).toBeLessThan(140)
    expect(SINGLE_ASSET_NOTE.split('.').filter((s) => s.trim()).length).toBe(1)
  })
})
