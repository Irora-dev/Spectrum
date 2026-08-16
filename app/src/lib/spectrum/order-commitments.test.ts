import { describe, expect, it } from 'vitest'
import {
  commitmentsByToken,
  committedOf,
  overCommitWarning,
  planApproval,
  readBalance,
  revokePlan,
  tokenKey,
  ZERO_FIRST_TOKENS,
} from './order-commitments'
import type { PendingOrder } from './cow-pending'

const WETH = '0x4200000000000000000000000000000000000006' as const
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const USDT_MAINNET = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as const
const ONE = 10n ** 18n

const order = (over: Partial<PendingOrder> = {}): PendingOrder => ({
  uid: 'u',
  chainId: 8453,
  owner: '0x182e54f8011cb15887764E6D4a658cD9b96c8d8F',
  sellToken: WETH,
  buyToken: USDC,
  sellSymbol: 'WETH',
  buySymbol: 'USDC',
  sellDecimals: 18,
  buyDecimals: 6,
  sellAmountRaw: ONE,
  minBuyAmountRaw: 4000_000000n,
  validTo: 0,
  createdAtMs: 0,
  status: 'open',
  executedSellRaw: 0n,
  executedBuyRaw: 0n,
  ...over,
})

describe('commitments: what is still owed', () => {
  it('sums open orders per token', () => {
    const c = commitmentsByToken([order({ uid: 'a' }), order({ uid: 'b', sellAmountRaw: 2n * ONE })])
    expect(c.get(tokenKey(8453, WETH))?.committedRaw).toBe(3n * ONE)
    expect(c.get(tokenKey(8453, WETH))?.orderCount).toBe(2)
  })

  // A half-filled order only needs its other half. Counting the original size
  // would over-approve and overstate what the user has locked up.
  it('counts only the REMAINDER of a partially filled order', () => {
    const c = commitmentsByToken([order({ executedSellRaw: ONE / 4n })])
    expect(c.get(tokenKey(8453, WETH))?.committedRaw).toBe((ONE * 3n) / 4n)
  })

  it('a terminal order commits nothing', () => {
    for (const status of ['fulfilled', 'expired', 'cancelled'] as const) {
      expect(commitmentsByToken([order({ status })]).size).toBe(0)
    }
  })

  // A surplus fill can report executed > signed. Unsigned bigint subtraction
  // would underflow to an astronomically large commitment.
  it('never underflows when a solver beat the limit and over-executed', () => {
    expect(commitmentsByToken([order({ executedSellRaw: ONE * 2n })]).size).toBe(0)
  })

  // Base WETH and mainnet WETH are different assets that share a symbol.
  it('never sums the same token address across different chains', () => {
    const c = commitmentsByToken([order({ uid: 'a', chainId: 8453 }), order({ uid: 'b', chainId: 1 })])
    expect(c.size).toBe(2)
    expect(committedOf([order({ chainId: 8453 })], 1, WETH)).toBe(0n)
  })

  it('reports zero for a token with nothing open', () => {
    expect(committedOf([], 8453, WETH)).toBe(0n)
  })
})

describe('commitments: free balance', () => {
  it('subtracts what is committed', () => {
    const r = readBalance(3n * ONE, ONE)
    expect(r.freeRaw).toBe(2n * ONE)
    expect(r.overCommitted).toBe(false)
  })

  it('never reports a negative free balance', () => {
    const r = readBalance(ONE, 3n * ONE)
    expect(r.freeRaw).toBe(0n)
    expect(r.overCommitted).toBe(true)
  })
})

// Over-committing is often deliberate: "sell at 4,500 or at 5,000, whichever
// comes first" is a normal ladder. Blocking it would break a real strategy to
// prevent something that is not even a loss.
describe('commitments: over-commit WARNS, never blocks', () => {
  it('says nothing when it fits', () => {
    expect(overCommitWarning(readBalance(3n * ONE, ONE), ONE, 'WETH')).toBeNull()
  })

  it('warns without forbidding, and says only one may fill', () => {
    const w = overCommitWarning(readBalance(2n * ONE, 2n * ONE), ONE, 'WETH')
    expect(w).toBeTruthy()
    expect(w).toMatch(/only one is meant to fill|cannot all complete/i)
    expect(w).not.toMatch(/cannot place|not allowed|blocked/i)
  })

  it('has a plainer message when there is nothing else open', () => {
    const w = overCommitWarning(readBalance(ONE, 0n), 2n * ONE, 'WETH')
    expect(w).toMatch(/more WETH than the wallet holds/i)
  })
})

describe('commitments: approvals are driven by the TOTAL, never one order', () => {
  // THE BUG THIS PREVENTS. Approving just the new order's size would set the
  // allowance below what an already-open order needs and silently break it.
  it('targets committed + adding, not adding alone', () => {
    const p = planApproval({
      currentAllowanceRaw: 0n,
      committedRaw: 2n * ONE,
      addingRaw: ONE,
      chainId: 8453,
      token: WETH,
    })
    expect(p.requiredRaw).toBe(3n * ONE)
    expect(p.kind).toBe('approve')
  })

  it('does nothing when the existing allowance already covers it', () => {
    const p = planApproval({
      currentAllowanceRaw: 10n * ONE,
      committedRaw: 2n * ONE,
      addingRaw: ONE,
      chainId: 8453,
      token: WETH,
    })
    expect(p.kind).toBe('none')
  })

  // Reducing an allowance is a deliberate act, never a side effect of placing
  // an order.
  it('never proposes LOWERING a larger existing allowance', () => {
    const p = planApproval({
      currentAllowanceRaw: 2n ** 255n,
      committedRaw: 0n,
      addingRaw: ONE,
      chainId: 8453,
      token: WETH,
    })
    expect(p.kind).toBe('none')
  })

  it('handles the exact-boundary case as sufficient', () => {
    const p = planApproval({ currentAllowanceRaw: ONE, committedRaw: 0n, addingRaw: ONE, chainId: 8453, token: WETH })
    expect(p.kind).toBe('none')
  })
})

describe('commitments: the zero-first token quirk', () => {
  it('zeroes first for mainnet USDT when an allowance is already set', () => {
    const p = planApproval({
      currentAllowanceRaw: ONE,
      committedRaw: 0n,
      addingRaw: 2n * ONE,
      chainId: 1,
      token: USDT_MAINNET,
    })
    expect(p.kind).toBe('reset-then-approve')
  })

  it('does NOT need the reset when the allowance is already zero', () => {
    const p = planApproval({
      currentAllowanceRaw: 0n,
      committedRaw: 0n,
      addingRaw: ONE,
      chainId: 1,
      token: USDT_MAINNET,
    })
    expect(p.kind).toBe('approve')
  })

  // A bridged namesake on another chain is a DIFFERENT contract and must not
  // inherit the assumption. Assuming it does is how a safe list becomes wrong.
  it('does not apply the mainnet quirk to the same address on another chain', () => {
    expect(ZERO_FIRST_TOKENS.has(tokenKey(8453, USDT_MAINNET))).toBe(false)
  })

  it('ordinary tokens approve directly', () => {
    const p = planApproval({ currentAllowanceRaw: ONE, committedRaw: 0n, addingRaw: 2n * ONE, chainId: 8453, token: WETH })
    expect(p.kind).toBe('approve')
  })
})

// An approval OUTLIVES the order that needed it. When a limit expires unfilled,
// the permission is still standing.
describe('commitments: the standing-allowance sweep', () => {
  it('suggests revoking when an allowance survives with nothing open', () => {
    const r = revokePlan(ONE, 0n)
    expect(r.suggest).toBe(true)
    expect(r.reason).toMatch(/no open orders/i)
  })

  it('does not suggest revoking while orders still need it', () => {
    expect(revokePlan(ONE, ONE).suggest).toBe(false)
  })

  it('says nothing when there is no allowance to revoke', () => {
    expect(revokePlan(0n, 0n).suggest).toBe(false)
  })
})
