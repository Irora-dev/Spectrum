import { describe, expect, it } from 'vitest'
import { zeroAddress } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { planToLegs, type PlanLegInput } from './plan-legs'
import { asFundingRaw, composeBatchBuy, BatchComposeRefusal } from './batcher'

// THE ROGUE GALLERY (battle-test item 3): nightmare portfolios driven through
// the composition pipeline, pinning the REFUSAL SENTENCES — the copy is the
// safety surface, so the copy is what gets pinned.

const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
const T = (symbol: string, weightPct: number, over: Partial<PlanLegInput> = {}): PlanLegInput => ({
  symbol, asset: `0x${symbol.toLowerCase().padEnd(4, 'f').padEnd(40, '0')}` as PlanLegInput['asset'],
  decimals: 18, weightPct, priceUsd: 10, priceAgeMs: 5_000, liquidityUsd: 1_000_000,
  buyTokenTaxBps: 0,
  route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress }, ...over,
})
// the runner's scaling + floor steps, stood in: cents become branded raw units,
// and the leg carries the legacy 50-bps haircut these fixtures assume
const legOf = (l: ReturnType<typeof planToLegs>['legs'][number]) => ({ ...l, budgetRaw: asFundingRaw(1000n), minOutRaw: (l.quotedOutRaw * 9_950n) / 10_000n })

describe('the rogue gallery — nightmare portfolios refuse in sentences', () => {
  it('the ALL-DEAD wallet: every leg unpriceable → zero legs, every refusal NAMED', () => {
    const { legs, refusals } = planToLegs([T('A', 50, { priceUsd: null }), T('B', 50, { priceUsd: 0 })], 100_000)
    expect(legs).toHaveLength(0)
    expect(refusals.map((r) => r.symbol)).toEqual(['A', 'B'])
    refusals.forEach((r) => expect(r.reason).toMatch(/no readable price/))
  })

  it('the STALE-EVERYTHING wallet: a whole plan of dead reads composes nothing', () => {
    const { legs, refusals } = planToLegs([T('A', 50, { priceAgeMs: 999_999 }), T('B', 50, { priceAgeMs: null })], 100_000)
    expect(legs).toHaveLength(0)
    expect(refusals).toHaveLength(2)
  })

  it('the ALL-THIN wallet: everything survives but EVERYTHING is optional (the consent surface carries the whole plan)', () => {
    const { legs } = planToLegs([T('A', 50, { liquidityUsd: 100 }), T('B', 50, { liquidityUsd: null })], 100_000)
    expect(legs.every((l) => l.optional)).toBe(true)
  })

  it('the OVER-CAP whale: six baskets refuse with the split arithmetic in the sentence', () => {
    const legs = Array.from({ length: 6 }, (_, i) => legOf(planToLegs([T(`B${i}`, 100, { route: 'basket' })], 1000).legs[0]))
    expect(() =>
      composeBatchBuy({ chainId: 8453, legs, fundingAsset: zeroAddress, fundingTotalRaw: asFundingRaw(6000n), recipient: T('A', 1).asset, owner: T('A', 1).asset, deadlineSec: 1, hubMinOutRaw: 1n, integrator: zeroAddress }),
    ).toThrow(/32-leg budget.*counts 6/)
  })

  it('the MICRO-DUST plan: $1 across three legs still sums exactly, nothing invented', () => {
    const { legs } = planToLegs([T('A', 33.3), T('B', 33.3), T('C', 33.4)], 100)
    expect(legs.reduce((s, l) => s + l.budgetUsdCents, 0)).toBe(100)
  })

  it('the EMPTY plan and the ZERO-money plan both refuse before any leg exists', () => {
    expect(() =>
      composeBatchBuy({ chainId: 8453, legs: [], fundingAsset: zeroAddress, fundingTotalRaw: asFundingRaw(1n), recipient: T('A', 1).asset, owner: T('A', 1).asset, deadlineSec: 1, hubMinOutRaw: 1n, integrator: zeroAddress }),
    ).toThrow(BatchComposeRefusal)
    expect(planToLegs([T('A', 100)], 0).legs).toHaveLength(0)
  })
})
