import { describe, expect, it } from 'vitest'
import { feeSplit, frontendFlushFloorUsdc, frontendPotFlushable, PROTOCOL_FEE_MODEL } from './fee-model'

const MAX = PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS
const both = { hasInterface: true, hasLauncher: true }

// The league lineage takes LEAGUE_SHARE_BPS off the TOP of every fee, before the
// whole waterfall — so a split computed without it overstates every other sink.
// The audit measured the gap: creator read 24.00% where the contract pays 22.80%.
describe('feeSplit with the league leg', () => {
  it('sums to exactly 1 with and without the league slice', () => {
    for (const leagueBps of [0, 500]) {
      const s = feeSplit(MAX, { ...both, leagueBps })
      const total = s.league + s.burn + s.interface + s.launcher + s.creator + s.holders
      expect(total, `leagueBps=${leagueBps}`).toBeCloseTo(1, 12)
    }
  })

  it('omitting leagueBps leaves every legacy number byte-identical', () => {
    const before = feeSplit(MAX, both)
    const zero = feeSplit(MAX, { ...both, leagueBps: 0 })
    expect(zero).toEqual(before)
    expect(before.league).toBe(0)
  })

  it('reproduces the DEPLOYED contract numbers (D-R3 burn 25% — SpectrumBasket.sol:151)', () => {
    // The audit's 24.0/22.8 pin was itself computed at v1's 10% burn — the
    // constant the owner caught stale live (2026-08-14: "i mean its 25% prism
    // fee % right"). At the deployed 2_500 bps burn, creator 30% of the
    // remainder pays 20.0% league-off / 19.0% league-on.
    const off = feeSplit(MAX, both)
    const on = feeSplit(MAX, { ...both, leagueBps: 500 })
    expect(off.burn * 100).toBeCloseTo(25.0, 1)
    expect(off.creator * 100).toBeCloseTo(20.0, 1)
    expect(on.creator * 100).toBeCloseTo(19.0, 1)
    expect(off.holders * 100).toBeCloseTo(46.7, 1)
    expect(on.holders * 100).toBeCloseTo(44.3, 1)
    expect(on.league * 100).toBeCloseTo(5.0, 6)
  })

  it('dilutes every sink pro-rata — exactly (BPS−LEAGUE)/BPS of its pre-league value', () => {
    const off = feeSplit(MAX, both)
    const on = feeSplit(MAX, { ...both, leagueBps: 500 })
    const factor = (10_000 - 500) / 10_000
    for (const k of ['burn', 'interface', 'launcher', 'creator', 'holders'] as const) {
      expect(on[k], `${k} should be diluted pro-rata`).toBeCloseTo(off[k] * factor, 5)
    }
  })

  it('skips the carve with no creatorPayout, exactly as the contract does', () => {
    const withPayout = feeSplit(MAX, { ...both, leagueBps: 500, hasCreatorPayout: true })
    const without = feeSplit(MAX, { ...both, leagueBps: 500, hasCreatorPayout: false })
    expect(withPayout.league).toBeGreaterThan(0)
    expect(without.league).toBe(0)
    // and the skipped slice flows through the normal waterfall, not into limbo
    expect(without).toEqual(feeSplit(MAX, both))
  })

  it('burn stays the residual sink and absorbs the league carve dust', () => {
    // 333 bps divides unevenly into 1e18, so dust exists to be absorbed
    const s = feeSplit(2_137, { ...both, leagueBps: 333 })
    const total = s.league + s.burn + s.interface + s.launcher + s.creator + s.holders
    expect(total).toBeCloseTo(1, 12)
    expect(s.burn).toBeGreaterThan(0)
  })
})

// F-1 (2026-07-30): a frontend-fee pot at or under the chain's crank floor is
// refused by the contract (and was cranker-stripped on the incumbent mainnet
// lineage) — the UI derives every "claimable vs accruing" split from these.
describe('frontendPotFlushable', () => {
  it('mainnet floor is 10 USDC, strictly-above semantics (the contract refuses <=)', () => {
    expect(frontendFlushFloorUsdc(1)).toBe(10)
    expect(frontendPotFlushable(1, 10)).toBe(false)
    expect(frontendPotFlushable(1, 9.99)).toBe(false)
    expect(frontendPotFlushable(1, 10.01)).toBe(true)
    expect(frontendPotFlushable(1, 0)).toBe(false)
  })
  it('Base and Robinhood have no floor — any positive pot flushes', () => {
    for (const chainId of [8453, 4663]) {
      expect(frontendFlushFloorUsdc(chainId)).toBe(0)
      expect(frontendPotFlushable(chainId, 0.01)).toBe(true)
      expect(frontendPotFlushable(chainId, 0)).toBe(false)
    }
  })
})
