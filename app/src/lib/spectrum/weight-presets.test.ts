import { describe, expect, it } from 'vitest'
import { CAP, MAX_ASSETS, MIN, isValid } from './weights'
import { presetAvailable, presetWeights, proportionalWeights, type PresetAsset } from './weight-presets'

// The presets have to obey the SAME laws the manual dials do, or a one-click
// preset would hand the deploy step a basket the sliders could never have made.
// isValid() is weights.ts's own gate, so every preset output is run through it.

const caps = (...v: (number | null | undefined)[]): PresetAsset[] => v.map((marketCapUsd) => ({ marketCapUsd }))
const liqs = (...v: (number | null | undefined)[]): PresetAsset[] => v.map((liquidityUsd) => ({ liquidityUsd }))

describe('every preset obeys weights.ts', () => {
  for (const n of [1, 2, 3, 5, 7, 13, MAX_ASSETS]) {
    it(`Σ = CAP, nothing under MIN, whole numbers — ${n} assets, all three presets`, () => {
      const assets = Array.from({ length: n }, (_, i) => ({
        marketCapUsd: (i + 1) * 1_000,
        liquidityUsd: (n - i) * 7_777,
      }))
      for (const kind of ['even', 'market-cap', 'liquidity'] as const) {
        const r = presetWeights(kind, assets)
        expect(r, kind).not.toBeNull()
        expect(isValid(r!.weights), `${kind} @ ${n}`).toBe(true)
        expect(r!.weights.every(Number.isInteger)).toBe(true)
      }
    })
  }

  it('a lopsided mix still lands exactly on CAP', () => {
    const r = presetWeights('market-cap', caps(1e12, 1, 1, 1, 1))!
    expect(r.weights.reduce((s, w) => s + w, 0)).toBe(CAP)
    expect(Math.min(...r.weights)).toBeGreaterThanOrEqual(MIN)
  })

  it('the biggest asset gets the biggest weight', () => {
    const r = presetWeights('market-cap', caps(10, 100, 30))!
    expect(r.weights[1]).toBeGreaterThan(r.weights[2])
    expect(r.weights[2]).toBeGreaterThan(r.weights[0])
  })

  it('liquidity reads liquidityUsd, market cap reads marketCapUsd — never each other', () => {
    const mixed: PresetAsset[] = [
      { marketCapUsd: 1, liquidityUsd: 100 },
      { marketCapUsd: 100, liquidityUsd: 1 },
    ]
    expect(presetWeights('market-cap', mixed)!.weights[1]).toBeGreaterThan(
      presetWeights('market-cap', mixed)!.weights[0],
    )
    expect(presetWeights('liquidity', mixed)!.weights[0]).toBeGreaterThan(
      presetWeights('liquidity', mixed)!.weights[1],
    )
  })
})

describe('the honesty rule: no numbers means NO preset, never a disguised even split', () => {
  it('refuses when every metric is missing', () => {
    expect(presetWeights('market-cap', caps(null, undefined, 0))).toBeNull()
    expect(presetAvailable('market-cap', caps(0, 0))).toBe(false)
  })

  it('refuses on NaN and Infinity rather than producing a NaN basket', () => {
    expect(presetWeights('liquidity', liqs(Number.NaN, Number.NaN))).toBeNull()
    expect(proportionalWeights([Number.POSITIVE_INFINITY])).toBeNull()
  })

  it('refuses negatives — a negative cap is not a small cap', () => {
    expect(presetWeights('market-cap', caps(-5, -10))).toBeNull()
  })

  it('a PARTIAL answer is reported, not hidden: unknown assets sit at the floor and are named', () => {
    const r = presetWeights('market-cap', caps(1_000, 0, 500))!
    expect(r.unknown).toEqual([1])
    expect(r.weights[1]).toBe(MIN)
    expect(isValid(r.weights)).toBe(true)
  })

  it('a fully-known split names nobody', () => {
    expect(presetWeights('market-cap', caps(1, 2, 3))!.unknown).toEqual([])
  })

  it('"even" needs no numbers at all — it is the one preset that always runs', () => {
    const r = presetWeights('even', caps(null, null, null))!
    expect(isValid(r.weights)).toBe(true)
    expect(r.unknown).toEqual([])
  })

  it('refuses an empty pick and anything past the asset cap', () => {
    expect(presetWeights('even', [])).toBeNull()
    expect(presetWeights('even', caps(...Array(MAX_ASSETS + 1).fill(1)))).toBeNull()
  })
})

describe('a preset is deterministic — the same picks always build the same basket', () => {
  it('ties break toward the earlier asset, every time', () => {
    const a = presetWeights('market-cap', caps(1, 1, 1, 1, 1, 1, 1))!.weights
    const b = presetWeights('market-cap', caps(1, 1, 1, 1, 1, 1, 1))!.weights
    expect(a).toEqual(b)
    // 7 equal assets over a 93-point budget: the remainder lands on the front
    expect(a[0]).toBeGreaterThanOrEqual(a[6])
  })

  it('a single asset is the whole basket', () => {
    expect(presetWeights('market-cap', caps(42))!.weights).toEqual([CAP])
  })
})
