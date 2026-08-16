import { describe, expect, it } from 'vitest'
import { hookedMarketDominates } from './find-best-pool'

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
