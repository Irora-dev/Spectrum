import { describe, expect, it } from 'vitest'
import { fairMintMinShares, planFairMint, type FairMintLeg } from './fair-mint'

// LPADS-shaped fixture: 3 legs, 18dp, drifted hard from its 34/33/33 launch
// weights — current VALUE split ~55/25/20. supply 1361.41, TVL ~$1454.
const L = (address: string, heldUnits: number, priceUsd: number): FairMintLeg => ({
  address,
  decimals: 18,
  heldRaw: BigInt(Math.round(heldUnits * 1e6)) * 10n ** 12n,
  priceUsd,
})
const SUPPLY = 1361_414264711097721147n // ~1361.41e18
const FEE_BPS = 100 // 1%

const DRIFTED = [
  L('0xa', 200_000, 0.004), // $800
  L('0xb', 40_000, 0.009), //  $360
  L('0xc', 1_200, 0.245), //   $294
]

describe('planFairMint — the drift-haircut escape route', () => {
  it('splits pro-rata to CURRENT value and the min-rule discards ~nothing', () => {
    const plan = planFairMint(DRIFTED, 528.8, SUPPLY, FEE_BPS)
    expect(plan).not.toBeNull()
    // budgets follow current value weights, not launch weights
    const total = plan!.legBudgetsUsd.reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(528.8, 6)
    expect(plan!.legBudgetsUsd[0] / total).toBeCloseTo(800 / 1454, 3)
    // the whole point: structural loss ≈ 0 (integer rounding only)
    expect(plan!.roundingLossPct).toBeLessThan(0.01)
  })

  it('predicted shares ≈ budget/NAV minus the basket fee — the fair outcome', () => {
    const plan = planFairMint(DRIFTED, 528.8, SUPPLY, FEE_BPS)!
    const shares = Number(plan.expectedSharesRaw) / 1e18
    const nav = 1454 / 1361.414 // ≈ 1.068
    const fair = (528.8 / nav) * (1 - FEE_BPS / 10_000)
    // within 0.1% of fair — versus −28% through the router on the same basket
    expect(Math.abs(shares / fair - 1)).toBeLessThan(0.001)
  })

  it('refuses an unpriced leg — never guesses', () => {
    expect(planFairMint([DRIFTED[0], { ...DRIFTED[1], priceUsd: 0 }, DRIFTED[2]], 500, SUPPLY, FEE_BPS)).toBeNull()
  })

  it('refuses a drained leg (held 0 → the contract reverts NoOutput)', () => {
    expect(planFairMint([DRIFTED[0], { ...DRIFTED[1], heldRaw: 0n }, DRIFTED[2]], 500, SUPPLY, FEE_BPS)).toBeNull()
  })

  it('refuses when a leg budget rounds to dust (no-skip min-rule zeroes the mint)', () => {
    // $0.000001 across three legs → sub-unit raw amounts on a 0-decimals-like scale
    const tiny = [
      { ...DRIFTED[0], decimals: 0 },
      { ...DRIFTED[1], decimals: 0 },
      { ...DRIFTED[2], decimals: 0 },
    ]
    expect(planFairMint(tiny, 0.000001, SUPPLY, FEE_BPS)).toBeNull()
  })

  it('fee replay rounds UP per leg (contract parity)', () => {
    // one leg, fee 1%, amount 101 raw → slice ceil(1.01)=2, net 99
    const one = [{ address: '0xa', decimals: 0, heldRaw: 1000n, priceUsd: 1 }]
    const plan = planFairMint(one, 101, 1000n, 100)!
    // shares = floor(99 × 1000 / 1000) = 99
    expect(plan.expectedSharesRaw).toBe(99n)
  })

  it('minShares haircut is bounded and monotone', () => {
    expect(fairMintMinShares(1_000_000n, 100)).toBe(990_000n)
    expect(fairMintMinShares(1_000_000n, 0)).toBe(1_000_000n)
    expect(fairMintMinShares(1_000_000n, 999_999)).toBe(500_000n) // clamped at 50%
  })
})
