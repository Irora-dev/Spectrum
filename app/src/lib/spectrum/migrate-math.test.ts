import { describe, expect, it } from 'vitest'
import {
  BPS,
  approvalPlan,
  mulDivUp,
  planMint,
  planRebalance,
  planRedeem,
  recvForShares,
  sharesForLeg,
  type LegReserve,
  type RebalanceLegInput,
} from './migrate-math'

const A = '0xaaaaAAaaAaAAAAaAAAaaAAaaaAAAaaAaaAaAaAA1' as const
const B = '0xbbbbBBbbBbBBBBbBBBbbBBbbbBBBbbBbbBbBbBB2' as const
const C = '0xccccCCccCcCCCCcCCCccCCcccCCCccCccCcCcCC3' as const

const leg = (asset: string, idleHeld: bigint, decimals = 18): LegReserve => ({
  asset: asset as LegReserve['asset'],
  symbol: asset.slice(2, 5).toUpperCase(),
  decimals,
  idleHeld,
})

describe('planRedeem — mirrors redeemInKind rounding', () => {
  it('haircut floors against the caller; per-leg pro-rata floors', () => {
    const legs = [leg(A, 1000n * 10n ** 18n), leg(B, 500n * 10n ** 6n, 6)]
    const supply = 100n * 10n ** 18n
    const { net, outs } = planRedeem(legs, supply, 100, 10n * 10n ** 18n) // 1% fee
    expect(net).toBe((10n * 10n ** 18n * 9900n) / 10000n)
    expect(outs[0].out).toBe((legs[0].idleHeld * net) / supply) // 99 A
    expect(outs[1].out).toBe((legs[1].idleHeld * net) / supply) // 49.5 B (raw 6dp)
    expect(outs[0].out).toBe(99n * 10n ** 18n)
    expect(outs[1].out).toBe(495n * 10n ** 5n)
  })
  it('awkward primes still round down, never up', () => {
    const legs = [leg(A, 999_999_999_999n)]
    const { outs } = planRedeem(legs, 777_777_777_777n, 137, 12_345_678_901n)
    const net = (12_345_678_901n * (BPS - 137n)) / BPS
    expect(outs[0].out).toBe((999_999_999_999n * net) / 777_777_777_777n)
  })
})

describe('sharesForLeg ↔ recvForShares — exact inverse pair', () => {
  const cases: Array<[bigint, number, bigint, bigint]> = [
    // [target shares, feeBps, supply, held]
    [10n ** 18n, 100, 100n * 10n ** 18n, 1000n * 10n ** 18n],
    [7n, 100, 999_999_999n, 123_456_789n],
    [123_456_789_123n, 250, 777_777_777_777n, 999_999_999_999n],
    [1n, 9999, 10n ** 24n, 10n ** 24n], // pathological fee just below 100%
  ]
  it('recvForShares yields ≥ target, and one unit less yields < target (minimality)', () => {
    for (const [s, fee, supply, held] of cases) {
      const recv = recvForShares(s, fee, supply, held)
      expect(sharesForLeg(recv, fee, supply, held)).toBeGreaterThanOrEqual(s)
      expect(sharesForLeg(recv - 1n, fee, supply, held)).toBeLessThan(s)
    }
  })
  it('zero target needs zero deposit; drained leg yields zero shares', () => {
    expect(recvForShares(0n, 100, 10n, 10n)).toBe(0n)
    expect(sharesForLeg(10n ** 18n, 100, 10n ** 18n, 0n)).toBe(0n)
  })
})

describe('planMint — the no-skip min-rule planner', () => {
  const supply = 100n * 10n ** 18n
  const legs = [leg(A, 1000n * 10n ** 18n), leg(B, 500n * 10n ** 6n, 6), leg(C, 250n * 10n ** 18n)]
  const availFor = (a: bigint, b: bigint, c: bigint) =>
    new Map([
      [A.toLowerCase(), a],
      [B.toLowerCase(), b],
      [C.toLowerCase(), c],
    ])

  it('zero v2 supply blocks (no in-kind first mint — C-1)', () => {
    const p = planMint(legs, 0n, 100, availFor(1n, 1n, 1n))
    expect(p.ok).toBe(false)
  })
  it('a zero-availability leg blocks and is named', () => {
    const p = planMint(legs, supply, 100, availFor(99n * 10n ** 18n, 0n, 25n * 10n ** 18n))
    expect(p.ok).toBe(false)
    expect(p.missing.map((l) => l.asset)).toEqual([B])
  })
  it('dust availability (rounds to zero shares) blocks', () => {
    const p = planMint(legs, supply, 100, availFor(1n, 1n, 1n))
    expect(p.ok).toBe(false)
    expect(p.missing).toHaveLength(0)
  })
  it('happy path: binding leg found, amounts affordable, forward-check clears target on EVERY leg', () => {
    // proportional would be A:100, B:50(6dp), C:25 per 10 shares; make B the binding leg
    const avail = availFor(200n * 10n ** 18n, 40n * 10n ** 6n, 60n * 10n ** 18n)
    const p = planMint(legs, supply, 100, avail)
    expect(p.ok).toBe(true)
    expect(p.bindingIndex).toBe(1)
    expect(p.targetShares).toBeGreaterThan(0n)
    expect(p.targetShares).toBeLessThanOrEqual(p.maxShares)
    expect(p.minShares).toBeLessThan(p.targetShares)
    p.amounts.forEach((amt, i) => {
      expect(amt).toBeLessThanOrEqual(avail.get(legs[i].asset.toLowerCase())!)
      expect(sharesForLeg(amt, 100, supply, legs[i].idleHeld)).toBeGreaterThanOrEqual(p.targetShares)
    })
    // the min across legs at these amounts IS ≥ target (what the contract computes)
    const minAcross = p.amounts.reduce(
      (min, amt, i) => {
        const s = sharesForLeg(amt, 100, supply, legs[i].idleHeld)
        return s < min ? s : min
      },
      p.amounts.length ? sharesForLeg(p.amounts[0], 100, supply, legs[0].idleHeld) : 0n,
    )
    expect(minAcross).toBeGreaterThanOrEqual(p.targetShares)
  })
  it('deposits stay minimal: no leg overshoots its target requirement by more than rounding', () => {
    const avail = availFor(200n * 10n ** 18n, 40n * 10n ** 6n, 60n * 10n ** 18n)
    const p = planMint(legs, supply, 100, avail)
    p.amounts.forEach((amt, i) => {
      // one raw unit less must NOT clear the target — minimality bound per leg
      expect(sharesForLeg(amt - 1n, 100, supply, legs[i].idleHeld)).toBeLessThan(p.targetShares)
    })
  })
  it('a drained v2 leg (idleHeld 0) blocks — the contract reverts NoOutput', () => {
    const p = planMint([leg(A, 0n)], supply, 100, new Map([[A.toLowerCase(), 10n ** 18n]]))
    expect(p.ok).toBe(false)
  })
})

describe('approvalPlan — exact-amount + USDT zero-first', () => {
  it('none when covered or nothing needed', () => {
    expect(approvalPlan(10n, 10n)).toBe('none')
    expect(approvalPlan(11n, 10n)).toBe('none')
    expect(approvalPlan(0n, 0n)).toBe('none')
  })
  it('direct from zero; zero-first from a short non-zero allowance', () => {
    expect(approvalPlan(0n, 10n)).toBe('direct')
    expect(approvalPlan(5n, 10n)).toBe('zero-first')
  })
})

describe('mulDivUp', () => {
  it('rounds up exactly like FullMath.mulDivRoundingUp', () => {
    expect(mulDivUp(10n, 10n, 3n)).toBe(34n)
    expect(mulDivUp(9n, 1n, 3n)).toBe(3n)
  })
})

// ── planRebalance — fund every leg from broader holdings to the balanced target ──
describe('planRebalance — balanced-target rebalance', () => {
  // 3 equal-weight legs, equal reserves + equal price ⇒ balanced deposit is equal.
  const rleg = (asset: string, idleHeld: bigint, avail: bigint, priceE18: bigint): RebalanceLegInput => ({
    asset: asset as RebalanceLegInput['asset'],
    symbol: asset.slice(2, 5),
    decimals: 18,
    idleHeld,
    avail,
    priceE18,
  })
  const P = 10n ** 18n // 1 WETH per token (E18)
  const HELD = 1_000n * 10n ** 18n

  it('the ADDED leg (avail 0) is funded by selling the surplus of held legs', () => {
    // You hold lots of A and B, none of C (the newly added leg). Reserves + prices equal.
    const legs = [
      rleg(A, HELD, 900n * 10n ** 18n, P),
      rleg(B, HELD, 900n * 10n ** 18n, P),
      rleg(C, HELD, 0n, P),
    ]
    const plan = planRebalance(legs, HELD, 0, 0n, 0n) // no buffer, no fee → clean thirds
    expect(plan.ok).toBe(true)
    // total avail value = 1800; balanced across 3 equal legs ⇒ 600 each
    expect(plan.deposits.map((d) => d / 10n ** 18n)).toEqual([600n, 600n, 600n])
    // A and B each sell 300; C is bought with the proceeds
    expect(plan.sells.map((s) => s.amount / 10n ** 18n).sort()).toEqual([300n, 300n])
    expect(plan.buys).toHaveLength(1)
    expect(plan.buys[0].asset).toBe(C)
    expect(plan.buys[0].deficit / 10n ** 18n).toBe(600n)
  })

  it('captures far more than the old dropped→added path when the dropped leg is thin', () => {
    // C added, D-equivalent dropped delivered only dust; but you hold plenty of A & B.
    // Old path: C funded only from dust ⇒ ~0 mint. Rebalance: C funded from A/B surplus.
    const legs = [
      rleg(A, HELD, 1_500n * 10n ** 18n, P),
      rleg(B, HELD, 1_500n * 10n ** 18n, P),
      rleg(C, HELD, 1n, P), // essentially nothing of the added leg
    ]
    const plan = planRebalance(legs, HELD, 0, 0n, 0n)
    expect(plan.ok).toBe(true)
    // ~3000 value / 3 legs ⇒ ~1000 each; C deficit ~1000 funded from A+B surplus.
    expect(plan.deposits[2] / 10n ** 18n).toBe(1000n)
    expect(plan.buys[0].asset).toBe(C)
    // in-kind target shares ≈ 1000/1000 × supply = the full balanced level
    expect(plan.targetShares).toBeGreaterThan(0n)
  })

  it('no sells/buys when already balanced', () => {
    const legs = [rleg(A, HELD, 500n * 10n ** 18n, P), rleg(B, HELD, 500n * 10n ** 18n, P), rleg(C, HELD, 500n * 10n ** 18n, P)]
    const plan = planRebalance(legs, HELD, 0, 0n, 0n)
    expect(plan.ok).toBe(true)
    expect(plan.sells).toHaveLength(0)
    expect(plan.buys).toHaveLength(0)
    expect(plan.deposits.map((d) => d / 10n ** 18n)).toEqual([500n, 500n, 500n])
  })

  it('weights the target by RESERVES, not equally', () => {
    // A holds 2× the reserve of B/C ⇒ balanced deposit for A is 2× as well.
    const legs = [rleg(A, 2n * HELD, 0n, P), rleg(B, HELD, 1_200n * 10n ** 18n, P), rleg(C, HELD, 0n, P)]
    const plan = planRebalance(legs, HELD, 0, 0n, 0n)
    expect(plan.ok).toBe(true)
    // value 1200 over reserves [2000,1000,1000] ⇒ deposits [600,300,300]
    expect(plan.deposits.map((d) => d / 10n ** 18n)).toEqual([600n, 300n, 300n])
  })

  it('refuses on an unpriced leg (never guesses a balanced target)', () => {
    const legs = [rleg(A, HELD, 100n, P), rleg(B, HELD, 100n, 0n), rleg(C, HELD, 100n, P)]
    expect(planRebalance(legs, HELD, 0, 0n, 0n).ok).toBe(false)
    expect(planRebalance(legs, HELD, 0, 0n, 0n).reason).toBe('unpriced')
  })

  it('the buffer keeps the target below the full available value', () => {
    const legs = [rleg(A, HELD, 300n * 10n ** 18n, P), rleg(B, HELD, 300n * 10n ** 18n, P), rleg(C, HELD, 300n * 10n ** 18n, P)]
    const bal = planRebalance(legs, HELD, 0, 0n, 0n).deposits[0]
    const buffered = planRebalance(legs, HELD, 0, 0n, 100n).deposits[0] // 1% buffer
    expect(buffered).toBeLessThan(bal)
  })

  it('extraAvailValueWeth (dropped-leg proceeds) joins the budget and funds the buys', () => {
    // Migration proceeds live ONLY in the dropped leg: every v2 leg starts empty,
    // the 600-WETH pot from selling the dropped leg funds all three buys.
    const legs = [rleg(A, HELD, 0n, P), rleg(B, HELD, 0n, P), rleg(C, HELD, 0n, P)]
    const none = planRebalance(legs, HELD, 0, 0n, 0n)
    expect(none.ok).toBe(false)
    expect(none.reason).toBe('no-value')
    const plan = planRebalance(legs, HELD, 0, 600n * 10n ** 18n, 0n)
    expect(plan.ok).toBe(true)
    expect(plan.deposits.map((d) => d / 10n ** 18n)).toEqual([200n, 200n, 200n])
    expect(plan.sells).toHaveLength(0)
    expect(plan.buys).toHaveLength(3)
    // each buy's WETH budget covers its full deficit (price = 1 WETH per token)
    expect(plan.buys.map((b) => b.wethBudget / 10n ** 18n)).toEqual([200n, 200n, 200n])
    // and mixed: extra value on top of held legs raises every target proportionally
    const mixed = planRebalance(
      [rleg(A, HELD, 300n * 10n ** 18n, P), rleg(B, HELD, 0n, P)],
      HELD,
      0,
      300n * 10n ** 18n, // dropped proceeds worth as much as the held A
      0n,
    )
    expect(mixed.ok).toBe(true)
    // 600 total value over equal reserves ⇒ 300 each: A is exactly at target, B is bought
    expect(mixed.deposits.map((d) => d / 10n ** 18n)).toEqual([300n, 300n])
    expect(mixed.sells).toHaveLength(0)
    expect(mixed.buys.map((b) => b.asset)).toEqual([B])
  })
})
