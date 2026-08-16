import { describe, expect, it } from 'vitest'
import {
  BATCH_BASE_GAS,
  GAS_PER_LEG_TAIL,
  MAX_GAS_SHARE_OF_FEE,
  MAX_TX_GAS,
  economicLegCap,
  type LegCapInputs,
} from './economic-leg-cap'

// THE BOUND THE CONTRACT DELEGATED TO US IN PROSE. Each test is named for the
// wrong answer it prevents.

const GWEI = 1_000_000_000n
const inp = (over: Partial<LegCapInputs> = {}): LegCapInputs => ({
  contractMaxLegs: 32,
  gasPriceWei: GWEI / 100n, // Base-ish: 0.01 gwei
  nativeUsd: 3_000,
  feeUsd: 50, // 50 bps on a $10k batch
  ...over,
})

describe('the protocol ceiling — EIP-7825 is absolute, not a price question', () => {
  it('never permits a batch that could not fit one transaction', () => {
    const v = economicLegCap(inp({ contractMaxLegs: 1_000, feeUsd: 1e9 }))
    expect(v.maxLegs * GAS_PER_LEG_TAIL + BATCH_BASE_GAS).toBeLessThanOrEqual(MAX_TX_GAS)
    expect(v.bound).toBe('protocol-gas')
  })
  it('the contract bound still wins when it is the tighter of the two', () => {
    const v = economicLegCap(inp({ feeUsd: 1e9 }))
    expect(v.maxLegs).toBe(32)
    expect(v.bound).toBe('contract')
    expect(v.message).toBeNull() // nothing to say when nothing was cut
  })
})

describe('the economic ceiling — the case the contract measured', () => {
  it('a cheap chain leaves the full plan intact', () => {
    expect(economicLegCap(inp()).maxLegs).toBe(32)
  })

  it('ETHEREUM ABOVE ~2.2 GWEI CUTS THE PLAN — the contract’s own stated crossover', () => {
    // its note: a 32-leg batch "costs more than this product's entire fee above
    // ~2.2 gwei" on Ethereum. Above that, 32 legs must NOT survive.
    const v = economicLegCap(inp({ gasPriceWei: 3n * GWEI, nativeUsd: 3_000, feeUsd: 50 }))
    expect(v.maxLegs).toBeLessThan(32)
    expect(v.bound).toBe('economics')
    expect(v.message).toMatch(/fees are high/i)
  })

  it('gas may never eat more of the fee than the stated share', () => {
    for (const gwei of [1n, 3n, 10n, 40n, 120n]) {
      const v = economicLegCap(inp({ gasPriceWei: gwei * GWEI }))
      if (v.maxLegs === 0) continue
      const gasUsd = (Number(gwei * GWEI) / 1e18) * (v.maxLegs * GAS_PER_LEG_TAIL + BATCH_BASE_GAS) * 3_000
      expect(gasUsd, `${gwei} gwei`).toBeLessThanOrEqual(50 * MAX_GAS_SHARE_OF_FEE + 1e-6)
    }
  })

  it('an expensive chain and a small purchase refuses ENTIRELY, in words a person can act on', () => {
    const v = economicLegCap(inp({ gasPriceWei: 200n * GWEI, feeUsd: 0.5 }))
    expect(v.maxLegs).toBe(0)
    expect(v.message).toMatch(/higher than this purchase is worth/i)
  })

  it('a bigger purchase buys back legs — the bound is economic, not arbitrary', () => {
    const small = economicLegCap(inp({ gasPriceWei: 20n * GWEI, feeUsd: 10 }))
    const large = economicLegCap(inp({ gasPriceWei: 20n * GWEI, feeUsd: 500 }))
    expect(large.maxLegs).toBeGreaterThan(small.maxLegs)
  })
})

describe('unreadable inputs REFUSE — an unmeasured gas price is not a cheap one', () => {
  it('a missing or hostile gas price or native price yields zero legs, not a full plan', () => {
    for (const over of [
      { gasPriceWei: null },
      { gasPriceWei: -1n },
      { nativeUsd: null },
      { nativeUsd: 0 },
      { nativeUsd: Number.NaN },
      { nativeUsd: Number.POSITIVE_INFINITY },
    ] as Partial<LegCapInputs>[]) {
      const v = economicLegCap(inp(over))
      expect(v.maxLegs, String(Object.keys(over)[0])).toBe(0)
      expect(v.bound).toBe('unreadable')
      expect(v.message).toBeTruthy()
    }
  })

  it('an unreadable contract bound refuses rather than composing against a guess', () => {
    // 1e21 passes Number.isInteger — a count needs a CEILING, not a type check
    for (const bad of [0, -1, Number.NaN, 1.5, 1e21, Number.POSITIVE_INFINITY]) {
      expect(economicLegCap(inp({ contractMaxLegs: bad })).maxLegs).toBe(0)
    }
  })

  it('NO FEE REVENUE leaves the hard ceilings standing rather than dividing by zero', () => {
    for (const feeUsd of [0, -5, Number.NaN]) {
      const v = economicLegCap(inp({ feeUsd }))
      expect(Number.isFinite(v.maxLegs)).toBe(true)
      expect(v.maxLegs).toBeGreaterThan(0)
      expect(v.maxLegs).toBeLessThanOrEqual(32)
    }
  })
})

describe('the answer is always a usable integer', () => {
  it('never negative, never fractional, never above the contract bound', () => {
    for (const gwei of [0n, 1n, 5n, 50n, 500n, 5_000n]) {
      for (const feeUsd of [0.01, 1, 50, 10_000]) {
        const v = economicLegCap(inp({ gasPriceWei: gwei * GWEI, feeUsd }))
        expect(Number.isInteger(v.maxLegs)).toBe(true)
        expect(v.maxLegs).toBeGreaterThanOrEqual(0)
        expect(v.maxLegs).toBeLessThanOrEqual(32)
      }
    }
  })
})
