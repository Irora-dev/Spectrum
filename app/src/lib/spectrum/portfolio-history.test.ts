import { describe, expect, it } from 'vitest'
import {
  combinePortfolioHistory,
  planPortfolioHistory,
  PORTFOLIO_HISTORY_CAP,
  type PortfolioHistoryAsset,
} from './portfolio-history'
import type { NavPoint } from './basket-data'

const A = (chainId: number, address: string, valueUsd: number): PortfolioHistoryAsset => ({
  chainId,
  address,
  valueUsd,
})

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const series = (values: number[], start = 1_000): NavPoint[] =>
  values.map((value, i) => ({ time: start + i * 60, value }))

describe('planPortfolioHistory', () => {
  it('keys fetches by chain:address so cross-chain twins never collide', () => {
    const plan = planPortfolioHistory([A(8453, '0x4200000000000000000000000000000000000006', 100), A(4663, '0x4200000000000000000000000000000000000006', 50)])
    expect(plan.fetches).toHaveLength(2)
    expect(new Set(plan.fetches.map((f) => f.key)).size).toBe(2)
  })

  it('remaps native ETH to the chain WETH for history, merging with held WETH', () => {
    const wethFor = () => '0x4200000000000000000000000000000000000006'
    const plan = planPortfolioHistory(
      [A(8453, NATIVE, 100), A(8453, '0x4200000000000000000000000000000000000006', 50)],
      undefined,
      wethFor,
    )
    expect(plan.fetches).toHaveLength(1)
    expect(plan.fetches[0].address).toBe('0x4200000000000000000000000000000000000006')
    expect(plan.inputs[0].weight).toBe(150)
  })

  it('drops native ETH honestly when the chain has no WETH identity', () => {
    const plan = planPortfolioHistory([A(8453, NATIVE, 100), A(8453, '0xaa00000000000000000000000000000000000002', 50)], undefined, () => undefined)
    expect(plan.fetches).toHaveLength(1)
    expect(plan.totalUsd).toBe(150) // still in coverage denominator
    expect(plan.plannedUsd).toBe(50)
  })

  it('caps at the top N by value and keeps the full total for coverage', () => {
    const assets = Array.from({ length: 20 }, (_, i) => A(8453, `0x${(i + 1).toString(16).padStart(40, '0')}`, 20 - i))
    const plan = planPortfolioHistory(assets)
    expect(plan.fetches).toHaveLength(PORTFOLIO_HISTORY_CAP)
    expect(plan.totalUsd).toBe(assets.reduce((s, a) => s + a.valueUsd, 0))
    expect(plan.plannedUsd).toBeLessThan(plan.totalUsd)
  })

  it('ignores unpriced and zero-value rows entirely', () => {
    const plan = planPortfolioHistory([A(8453, '0xaa00000000000000000000000000000000000001', 0), A(8453, '0xaa00000000000000000000000000000000000002', 40)])
    expect(plan.fetches).toHaveLength(1)
    expect(plan.totalUsd).toBe(40)
  })
})

describe('combinePortfolioHistory', () => {
  it('anchors the final point to the live total', () => {
    const plan = planPortfolioHistory([A(8453, '0xaa00000000000000000000000000000000000001', 300)])
    const map = new Map([[plan.fetches[0].key, series([100, 110, 120])]])
    const { points } = combinePortfolioHistory(plan, map, 300)
    expect(points.length).toBeGreaterThanOrEqual(2)
    expect(points[points.length - 1].value).toBeCloseTo(300, 6)
    expect(points[0].value).toBeCloseTo(250, 6) // 300 · (100/120)
  })

  it('coverage counts only assets whose history actually came back', () => {
    const plan = planPortfolioHistory([
      A(8453, '0xaa00000000000000000000000000000000000001', 75),
      A(8453, '0xaa00000000000000000000000000000000000002', 25),
    ])
    const map = new Map([
      [plan.fetches[0].key, series([100, 105])],
      [plan.fetches[1].key, [] as NavPoint[]], // unreadable — never faked flat
    ])
    const { coveragePct } = combinePortfolioHistory(plan, map, 100)
    expect(coveragePct).toBe(75)
  })

  it('returns an empty curve, never zeros, when nothing is readable', () => {
    const plan = planPortfolioHistory([A(8453, '0xaa00000000000000000000000000000000000001', 50)])
    const { points, coveragePct } = combinePortfolioHistory(plan, new Map(), 50)
    expect(points).toHaveLength(0)
    expect(coveragePct).toBe(0)
  })
})
