import { describe, expect, it } from 'vitest'
import type { Address, PublicClient } from 'viem'
import { DELTA_SLIPPAGE_BPS, maxInFor, minOutFor, quoteBuyLegFills, splitAmountByBudgets, splitPotByWeight } from './delta-trade'
import { maxSharesOverFunded, sharesForLeg, type LegReserve } from './migrate-math'

const A = '0xaaaaAAaaAaAAAAaAAAaaAAaaaAAAaaAaaAaAaAA1' as const
const B = '0xbbbbBBbbBbBBBBbBBBbbBBbbbBBBbbBbbBbBbBB2' as const
const C = '0xccccCCccCcCCCCcCCCccCCcccCCCccCccCcCcCC3' as const

const leg = (asset: string, idleHeld: bigint): LegReserve => ({
  asset: asset as LegReserve['asset'],
  symbol: asset.slice(2, 5).toUpperCase(),
  decimals: 18,
  idleHeld,
})

describe('splitPotByWeight — WETH pot allocation across added legs', () => {
  it('splits proportionally and sums EXACTLY to the pot (last leg takes the remainder)', () => {
    const pot = 10n ** 18n + 7n // awkward remainder
    const shares = splitPotByWeight(pot, [2500, 2500, 5000])
    expect(shares.reduce((a, s) => a + s, 0n)).toBe(pot)
    expect(shares[2]).toBeGreaterThanOrEqual(shares[0] + shares[1] - 2n) // ~half
  })
  it('single leg takes everything; zero pot/weights yield zeros', () => {
    expect(splitPotByWeight(123n, [4000])).toEqual([123n])
    expect(splitPotByWeight(0n, [1, 2])).toEqual([0n, 0n])
    expect(splitPotByWeight(5n, [])).toEqual([])
    expect(splitPotByWeight(5n, [0, 0])).toEqual([0n, 0n])
  })
})

describe('splitAmountByBudgets — sold amount allocated across rebalance buys', () => {
  it('splits proportionally to bigint budgets and sums EXACTLY (last NON-ZERO takes the remainder)', () => {
    const amount = 10n ** 18n + 7n
    const shares = splitAmountByBudgets(amount, [1n * 10n ** 18n, 1n * 10n ** 18n, 2n * 10n ** 18n, 0n])
    expect(shares.reduce((a, s) => a + s, 0n)).toBe(amount)
    expect(shares[3]).toBe(0n) // a zero-budget slot never takes the remainder
    expect(shares[2]).toBeGreaterThanOrEqual(shares[0] + shares[1] - 2n) // ~half
  })
  it('single budget takes everything; zero amount/budgets yield zeros', () => {
    expect(splitAmountByBudgets(123n, [7n])).toEqual([123n])
    expect(splitAmountByBudgets(0n, [1n, 2n])).toEqual([0n, 0n])
    expect(splitAmountByBudgets(5n, [])).toEqual([])
    expect(splitAmountByBudgets(5n, [0n, 0n])).toEqual([0n, 0n])
  })
})

describe('slippage guards', () => {
  it('minOutFor floors down, maxInFor ceils up, symmetric around the quote', () => {
    const q = 1_000_000n
    expect(minOutFor(q)).toBe((q * (10_000n - DELTA_SLIPPAGE_BPS)) / 10_000n)
    expect(maxInFor(q)).toBeGreaterThan(q)
    expect(minOutFor(q)).toBeLessThan(q)
  })
})

describe('maxSharesOverFunded — sizing the delta buy off the funded legs', () => {
  const supply = 100n * 10n ** 18n
  const legs = [leg(A, 1000n * 10n ** 18n), leg(B, 500n * 10n ** 18n), leg(C, 250n * 10n ** 18n)]
  it('ignores unfunded legs (those are what the delta buys)', () => {
    const available = new Map([
      [A.toLowerCase(), 100n * 10n ** 18n],
      [B.toLowerCase(), 50n * 10n ** 18n],
      // C unfunded — excluded, NOT zero-clamped
    ])
    const max = maxSharesOverFunded(legs, supply, 100, available)
    const sA = sharesForLeg(100n * 10n ** 18n, 100, supply, legs[0].idleHeld)
    const sB = sharesForLeg(50n * 10n ** 18n, 100, supply, legs[1].idleHeld)
    expect(max).toBe(sA < sB ? sA : sB)
    expect(max).toBeGreaterThan(0n)
  })
  it('zero when nothing is funded or supply is zero; zero on a drained funded leg', () => {
    expect(maxSharesOverFunded(legs, supply, 100, new Map())).toBe(0n)
    expect(maxSharesOverFunded(legs, 0n, 100, new Map([[A.toLowerCase(), 1n]]))).toBe(0n)
    expect(
      maxSharesOverFunded([leg(A, 0n)], supply, 100, new Map([[A.toLowerCase(), 10n ** 18n]])),
    ).toBe(0n)
  })
})

describe('encodeV3Path — packed multihop paths for the one-tx delta', () => {
  const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as const
  const W = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
  const D = '0xdddddddddddddddddddddddddddddddddddddddd' as const
  it('1-hop = 43 bytes; 2-hop = 66 bytes; tokens and fees in order', async () => {
    const { encodeV3Path } = await import('./delta-trade')
    const one = encodeV3Path([A, W], [3000])
    expect(one.length).toBe(2 + 43 * 2)
    expect(one.toLowerCase().startsWith(('0x' + A.slice(2)).toLowerCase())).toBe(true)
    expect(one.slice(2 + 40, 2 + 40 + 6)).toBe('000bb8') // 3000 as uint24
    const two = encodeV3Path([A, W, D], [500, 10000])
    expect(two.length).toBe(2 + 66 * 2)
    expect(two.slice(2 + 40, 2 + 40 + 6)).toBe('0001f4') // 500
    expect(two.slice(2 + 40 + 6 + 40, 2 + 40 + 6 + 40 + 6)).toBe('002710') // 10000
    expect(two.toLowerCase().endsWith(D.slice(2).toLowerCase())).toBe(true)
  })
  it('refuses malformed shapes', async () => {
    const { encodeV3Path } = await import('./delta-trade')
    expect(() => encodeV3Path([A, W], [3000, 500])).toThrow()
    expect(() => encodeV3Path([A], [])).toThrow()
  })
})

// ── quoteBuyLegFills — realistic per-leg buy fills along the real acquire route ──
// A stub QuoterV2 client: quoteExactInputSingle echoes amountIn (a 1:1 "pool"),
// and any pair whose tokenOut is UNROUTABLE throws at every tier (no pool).
const USDC = '0x0000000000000000000000000000000000005dc0' as Address
const WETH = '0x000000000000000000000000000000000000e770' as Address
const TOKA = '0x000000000000000000000000000000000000000a' as Address
const UNRO = '0x0000000000000000000000000000000000000bad' as Address

function stubQuoter(unroutable: Address[] = []): PublicClient {
  const dead = new Set(unroutable.map((a) => a.toLowerCase()))
  return {
    simulateContract: async ({ args }: { args: [{ tokenOut: Address; amountIn: bigint }] }) => {
      const { tokenOut, amountIn } = args[0]
      if (dead.has(tokenOut.toLowerCase())) throw new Error('no pool')
      return { result: [amountIn, 0n, 0, 0n] } // echo: 1:1 fill
    },
  } as unknown as PublicClient
}

describe('quoteBuyLegFills — per-leg floors mirror _acquireBasket', () => {
  const q = '0x0000000000000000000000000000000000000q1' as Address

  it('buffer USDC legs fill 1:1 by weight; non-buffer route USDC→WETH→asset', async () => {
    const usdcNet = 1_000_000n // 1 USDC (6dp)
    const fills = await quoteBuyLegFills(stubQuoter(), q, USDC, WETH, [
      { asset: USDC, weightPct: 40, isUsdc: true, spotAmount: 999n },
      { asset: TOKA, weightPct: 60, isUsdc: false, spotAmount: 1n },
    ], usdcNet)
    expect(fills).not.toBeNull()
    // buffer leg: 40% of net, 1:1
    expect(fills![0]).toBe(400_000n)
    // non-buffer leg: all non-buffer USDC (600k) → WETH (echo 600k) → sole leg gets it all (echo 600k)
    expect(fills![1]).toBe(600_000n)
  })

  it('falls back to spotAmount for a leg whose ETH→asset hop has no pool', async () => {
    const fills = await quoteBuyLegFills(stubQuoter([UNRO]), q, USDC, WETH, [
      { asset: TOKA, weightPct: 50, isUsdc: false, spotAmount: 111n },
      { asset: UNRO, weightPct: 50, isUsdc: false, spotAmount: 222n },
    ], 1_000_000n)
    expect(fills).not.toBeNull()
    expect(fills![0]).toBe(500_000n) // routable: half the echoed ETH
    expect(fills![1]).toBe(222n) // unroutable leg → spot fallback (never frictionless zero)
  })

  it('returns null when the USDC→WETH hub itself cannot be quoted', async () => {
    const fills = await quoteBuyLegFills(stubQuoter([WETH]), q, USDC, WETH, [
      { asset: TOKA, weightPct: 100, isUsdc: false, spotAmount: 5n },
    ], 1_000_000n)
    expect(fills).toBeNull()
  })

  it('a WETH constituent leg takes its ETH share directly (no second hop)', async () => {
    // Hub live (nothing dead): USDC(1e6)→WETH echoes 1e6, split 50/50 → 500k each.
    // The WETH leg passes its share through; the TOKA leg quotes WETH→TOKA (echo).
    const fills = await quoteBuyLegFills(stubQuoter(), q, USDC, WETH, [
      { asset: WETH, weightPct: 50, isUsdc: false, spotAmount: 1n },
      { asset: TOKA, weightPct: 50, isUsdc: false, spotAmount: 1n },
    ], 1_000_000n)
    expect(fills).not.toBeNull()
    expect(fills![0]).toBe(500_000n) // WETH leg: its ETH share, passed through
    expect(fills![1]).toBe(500_000n) // TOKA leg: quoted from its ETH share
  })
})
