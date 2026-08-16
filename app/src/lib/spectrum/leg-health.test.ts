import { describe, expect, it } from 'vitest'
import { classifyPoolState, deadLegsOf, type LegHealth } from './leg-health'

// The mint pre-flight exists because LegMinNotMet's three causes have opposite
// remedies (contracts, measured live 2026-08-04) and the dead-leg one is
// knowable BEFORE a user tries. These pin the classification law and the two
// invariants the UI stands on.

const leg = (status: LegHealth['status'], reason: LegHealth['reason'] = null): LegHealth => ({
  asset: '0x1111111111111111111111111111111111111111',
  symbol: 'X',
  status,
  reason,
})

describe('classifyPoolState — a pool that cannot fill a swap is dead', () => {
  it('live pool (price + liquidity) is ok', () => {
    expect(classifyPoolState(2n ** 96n, 10n)).toBe('ok')
  })
  it('the LIVE dead-leg case: initialized pool, ZERO liquidity (a pool existing tells you nothing)', () => {
    // Contracts verified this independently of their own tool: the one dead
    // leg on the registry has a pool at exactly one tier, holding nothing.
    expect(classifyPoolState(2n ** 96n, 0n)).toBe('dead')
  })
  it('uninitialized pool (sqrtP 0) is dead even if a liquidity word reads nonzero', () => {
    expect(classifyPoolState(0n, 5n)).toBe('dead')
  })
})

describe('the invariants the buy surface stands on', () => {
  it('deadLegsOf surfaces ONLY dead — unknown never gates (could-not-check ≠ does-not-exist)', () => {
    const legs = [leg('ok'), leg('unknown'), leg('dead', 'no-liquidity'), leg('unknown')]
    const dead = deadLegsOf(legs)
    expect(dead).toHaveLength(1)
    expect(dead[0].status).toBe('dead')
  })
  it('an all-unknown sweep gates nothing at all', () => {
    expect(deadLegsOf([leg('unknown'), leg('unknown')])).toHaveLength(0)
  })
})
