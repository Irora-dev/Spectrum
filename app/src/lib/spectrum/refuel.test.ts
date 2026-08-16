import { describe, expect, it } from 'vitest'
import { parseEther, parseGwei } from 'viem'
import { computeRefuelGasWei, REFUEL_CLAMPS, REFUEL_GAS_BUDGET, REFUEL_HEADROOM_X } from './refuel'

describe('computeRefuelGasWei — live formula, per-chain clamps (contracts sizing rule)', () => {
  it('computes base fee × budget × headroom inside the clamps', () => {
    // 10 gwei on mainnet: 10e9 × 3M × 2 = 0.06 ETH — between 0.005 and 0.1.
    const fee = parseGwei('10')
    expect(computeRefuelGasWei(1, fee)).toBe(fee * REFUEL_GAS_BUDGET * REFUEL_HEADROOM_X)
  })

  it('a zero/unreadable base fee answers the FLOOR, never zero — under-refuel is the failure class', () => {
    expect(computeRefuelGasWei(1, 0n)).toBe(REFUEL_CLAMPS[1].floorWei)
  })

  it('a fee spike is ceiling-clamped — never converts half a bridge into gas', () => {
    expect(computeRefuelGasWei(8453, parseGwei('5000'))).toBe(REFUEL_CLAMPS[8453].ceilingWei)
  })

  it('an unknown destination gets null — no policy means no refuel ask, and the seam omits the param', () => {
    expect(computeRefuelGasWei(999999, parseGwei('10'))).toBeNull()
  })

  it('every clamp is sane: 0 < floor < ceiling', () => {
    for (const [chain, c] of Object.entries(REFUEL_CLAMPS)) {
      expect(c.floorWei > 0n, `chain ${chain}`).toBe(true)
      expect(c.ceilingWei > c.floorWei, `chain ${chain}`).toBe(true)
      expect(c.ceilingWei <= parseEther('0.2'), `chain ${chain} ceiling stays human-scale`).toBe(true)
    }
  })
})
