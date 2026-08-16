import { describe, expect, it } from 'vitest'
import { publishSeedPlan, reshapeSeedPlan, seedThesisOf, type SeedPlan } from './seed-plan'
import type { PublishLane } from './publish-bundle-model'
import type { ReshapeDraft, ThesisReshapeLane } from './reshape-types'

// ─────────────────────────────────────────────────────────────────────────────
// The seed plan decides which just-shipped lanes MONEY may be pointed at, and
// with what split. Both halves are laws with teeth (owner 2026-08-12):
//   · a confirmed-but-unread lane CANNOT seed — excluded and named, never a
//     silent shorter bundle;
//   · zero seedable lanes = no legs, so the door does not render;
//   · shares are the DEPLOY WEIGHTS, not live AUM (a fresh version has none).
// ─────────────────────────────────────────────────────────────────────────────

const A1 = '0x1111111111111111111111111111111111111111' as `0x${string}`
const A2 = '0x2222222222222222222222222222222222222222' as `0x${string}`
const P1 = '0x00000000000000000000000000000000000000d1' as `0x${string}`
const P2 = '0x00000000000000000000000000000000000000d2' as `0x${string}`

describe('publishSeedPlan — landed lanes with read-back addresses, at the Composer mix shares', () => {
  const lane = (chainId: number, state: PublishLane['state'], newAddress: `0x${string}` | null): PublishLane => ({
    chainId,
    state,
    newAddress,
    note: null,
  })
  const tickers = { 8453: 'BEVM', 1: 'BEVM' }
  const groups = [
    { chainId: 8453, mixSharePct: 70 },
    { chainId: 1, mixSharePct: 30 },
  ]

  it('seeds exactly the done lanes that carry an address, each at its network’s share of the mix', () => {
    const plan = publishSeedPlan([lane(8453, 'done', A1), lane(1, 'done', A2)], tickers, groups)
    expect(plan.legs).toEqual([
      { chainId: 8453, address: A1, symbol: 'BEVM', share: 70 },
      { chainId: 1, address: A2, symbol: 'BEVM', share: 30 },
    ])
    expect(plan.excluded).toEqual([])
  })

  it('a confirmed-but-unread lane is EXCLUDED and named — never seeded, never silently dropped', () => {
    const plan = publishSeedPlan([lane(8453, 'done', A1), lane(1, 'done', null)], tickers, groups)
    expect(plan.legs.map((l) => l.chainId)).toEqual([8453])
    expect(plan.excluded).toEqual([1])
  })

  it('an unfinished lane neither seeds nor excludes — only landed baskets are anyone’s to open', () => {
    const plan = publishSeedPlan([lane(8453, 'done', A1), lane(1, 'failed', null)], tickers, groups)
    expect(plan.legs.map((l) => l.chainId)).toEqual([8453])
    expect(plan.excluded).toEqual([])
  })

  it('zero seedable lanes → zero legs (the door must not render)', () => {
    const plan = publishSeedPlan([lane(8453, 'done', null), lane(1, 'deploying', null)], tickers, groups)
    expect(plan.legs).toEqual([])
    expect(plan.excluded).toEqual([8453])
  })
})

describe('reshapeSeedPlan — shipped versions seed; the walkthrough walks its predecessors', () => {
  const lane = (
    chainId: number,
    state: ThesisReshapeLane['state'],
    newAddress: `0x${string}` | null,
    predecessor: `0x${string}`,
  ): ThesisReshapeLane => ({ chainId, predecessor, state, newAddress, note: null })
  const draft = (symbol: string, weights: number[]): ReshapeDraft =>
    ({ name: 'Bullish EVM', symbol, legs: [], weights, feeConfig: {} }) as unknown as ReshapeDraft
  const drafts = { 8453: draft('BEVM', [60, 40]), 1: draft('BEVM', [50, 30, 20]) }

  it('real: done lanes with a read-back new address seed over that address, at the draft weight sums', () => {
    const plan = reshapeSeedPlan([lane(8453, 'done', A1, P1), lane(1, 'done', A2, P2)], drafts, false)
    expect(plan.legs).toEqual([
      { chainId: 8453, address: A1, symbol: 'BEVM', share: 100 },
      { chainId: 1, address: A2, symbol: 'BEVM', share: 100 },
    ])
    expect(plan.excluded).toEqual([])
  })

  it('real: a done lane with no read-back address is excluded and named', () => {
    const plan = reshapeSeedPlan([lane(8453, 'done', A1, P1), lane(1, 'done', null, P2)], drafts, false)
    expect(plan.legs.map((l) => l.chainId)).toEqual([8453])
    expect(plan.excluded).toEqual([1])
  })

  it('skipped lanes kept their current version — they neither seed nor exclude', () => {
    const plan = reshapeSeedPlan([lane(8453, 'done', A1, P1), lane(1, 'skipped', null, P2)], drafts, false)
    expect(plan.legs.map((l) => l.chainId)).toEqual([8453])
    expect(plan.excluded).toEqual([])
  })

  it('demo: done lanes seed over their PREDECESSORS (nothing arms in a walkthrough), nothing excluded', () => {
    // the demo script never learns an address — the walkthrough still needs
    // legs to walk, and the run machine's own demo refusals stand
    const plan = reshapeSeedPlan([lane(8453, 'done', null, P1), lane(1, 'done', null, P2)], drafts, true)
    expect(plan.legs.map((l) => l.address)).toEqual([P1, P2])
    expect(plan.excluded).toEqual([])
  })
})

describe('seedThesisOf — the run overlay’s input, claiming nothing a fresh basket does not have', () => {
  const plan: SeedPlan = {
    legs: [
      { chainId: 8453, address: A1, symbol: 'BEVM', share: 70 },
      { chainId: 1, address: A2, symbol: 'BEVM', share: 30 },
    ],
    excluded: [],
  }

  it('builds a zero-AUM thesis over the seed legs plus the explicit share map, deployer lowercased', () => {
    const built = seedThesisOf(plan, 'Bullish EVM', '0xABCDEF0000000000000000000000000000000001')!
    expect(built.thesis.deployer).toBe('0xabcdef0000000000000000000000000000000001')
    expect(built.thesis.name).toBe('Bullish EVM')
    expect(built.thesis.chainIds).toEqual([8453, 1])
    expect(built.thesis.totalAumUsd).toBe(0)
    expect(built.thesis.legs.map((l) => [l.chainId, l.address, l.symbol, l.aumUsd])).toEqual([
      [8453, A1, 'BEVM', 0],
      [1, A2, 'BEVM', 0],
    ])
    expect([...built.seedShares.entries()]).toEqual([
      [8453, 70],
      [1, 30],
    ])
  })

  it('null when nothing is seedable — the caller renders no door', () => {
    expect(seedThesisOf({ legs: [], excluded: [8453] }, 'Bullish EVM', '0xabc')).toBeNull()
  })
})
