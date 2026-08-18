import { describe, expect, it } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import { deepestHookedPool, findBestPool, hookedMarketDominates } from './find-best-pool'
import type { BestPoolResult } from './types'

describe('hookedMarketDominates — the FWA-class gate, thresholds MEASURED not guessed', () => {
  it('catches the two live cases: FWA (261.5 vs ~40 ETH, 6.5×) and PRISM v2 (~67 vs v3 dust)', () => {
    expect(hookedMarketDominates(261.5, 39.9)).toBe(true) // FWA — a 20× gate MISSED this; the owner caught it live
    expect(hookedMarketDominates(66.89, 3.5)).toBe(true) // PRISM v2
  })
  it('a token whose OPEN market genuinely dominates stays addable', () => {
    expect(hookedMarketDominates(10, 100)).toBe(false) // minor hook pool beside a deep open market
    expect(hookedMarketDominates(19.9, 10)).toBe(false) // under 2× — open market is comparable
  })
  it('the boundary: exactly 2× dominates; no hooked pool never does', () => {
    expect(hookedMarketDominates(20, 10)).toBe(true)
    expect(hookedMarketDominates(0, 10)).toBe(false)
    expect(hookedMarketDominates(-1, 10)).toBe(false)
  })
  it('a dust routable best cannot launder dominance away (the 0.01 floor)', () => {
    expect(hookedMarketDominates(0.05, 0.000001)).toBe(true) // 0.05 ≥ 0.01×2
    expect(hookedMarketDominates(0.01, 0)).toBe(false) // under the floored 2×
  })
})

describe('deepestHookedPool — the hooked market now carries ITS KEY, not just a depth', () => {
  const H1 = '0x0000000000000000000000000000000000000a01' as Address
  const H2 = '0x0000000000000000000000000000000000000a02' as Address
  const ASSET = '0x00000000000000000000000000000000000a55e7' as Address
  const pair = { currency0: zeroAddress, currency1: ASSET }
  const inits = [
    { fee: 0x800000, tickSpacing: 60, hooks: H1 }, // dynamic-fee hook — the FWA shape
    { fee: 10_000, tickSpacing: 200, hooks: H2 },
    { fee: 3_000, tickSpacing: 60, hooks: H1 },
  ]

  it("picks the deepest by depthEth and carries THAT init's key fields + the scan pair", () => {
    expect(deepestHookedPool(inits, [12.5, 261.5, 40], pair)).toEqual({
      currency0: zeroAddress,
      currency1: ASSET,
      fee: 10_000,
      tickSpacing: 200,
      hooks: H2,
      depthEth: 261.5,
    })
  })

  it('read failures (the -1 sentinel) and empty pools (0) never win; nothing readable → null', () => {
    expect(deepestHookedPool(inits, [-1, 0, 7.2], pair)).toMatchObject({ fee: 3_000, hooks: H1, depthEth: 7.2 })
    expect(deepestHookedPool(inits, [-1, -1, 0], pair)).toBeNull()
    expect(deepestHookedPool([], [], pair)).toBeNull()
  })

  it('only READ depths can win — the depths list is the 6-cap boundary, an unread 7th init is invisible', () => {
    const seven = [...inits, ...inits, { fee: 500, tickSpacing: 10, hooks: H2 }]
    // depths for the first 6 only (the cap findV4 applies); the 7th init would
    // win if the selection ever looked past what was actually read.
    const r = deepestHookedPool(seven, [1, 2, 3, 4, 5, 6], pair)
    expect(r).toMatchObject({ fee: 3_000, tickSpacing: 60, hooks: H1, depthEth: 6 })
  })

  it('the result type pins `deepest` onto hookedMarket — additive on BestPoolResult (types.ts untouched)', () => {
    // Compile-time pin: findBestPool's declared result must accept the extended
    // shape AND stay assignable where the base BestPoolResult type is expected.
    type HookedMarket = Awaited<ReturnType<typeof findBestPool>>['hookedMarket']
    const pinned: HookedMarket = {
      hookedDepthEth: 261.5,
      bestHooklessDepthEth: 40,
      deepest: { currency0: zeroAddress, currency1: ASSET, fee: 10_000, tickSpacing: 200, hooks: H2, depthEth: 261.5 },
    }
    const base: BestPoolResult['hookedMarket'] = pinned // narrowing, not a fork
    expect(pinned?.deepest?.hooks).toBe(H2)
    expect(base?.hookedDepthEth).toBe(261.5)
  })
})
