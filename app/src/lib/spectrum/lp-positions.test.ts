import { describe, expect, it } from 'vitest'
import { amountsForLiquidity, int24At, withLpExposure, V3_POSITION_MANAGER, V4_POSITION_MANAGER, type LpPosition } from './lp-positions'

// The range math must DISCRIMINATE — below, inside and above the range are
// three different answers (the boundary law: an instrument that cannot tell
// them apart reports agreement with everything).
describe('amountsForLiquidity — the three range regimes come out different', () => {
  // a familiar shape: ticks ±600 around 0, price at 1 (sqrtP=1)
  const L = 1e18
  const below = amountsForLiquidity(L, Math.pow(1.0001, -1000 / 2), -600, 600)
  const inside = amountsForLiquidity(L, 1, -600, 600)
  const above = amountsForLiquidity(L, Math.pow(1.0001, 1000 / 2), -600, 600)

  it('below the range: all token0, no token1', () => {
    expect(below.amount0Raw).toBeGreaterThan(0)
    expect(below.amount1Raw).toBe(0)
  })
  it('inside the range: both sides positive', () => {
    expect(inside.amount0Raw).toBeGreaterThan(0)
    expect(inside.amount1Raw).toBeGreaterThan(0)
  })
  it('above the range: all token1, no token0', () => {
    expect(above.amount0Raw).toBe(0)
    expect(above.amount1Raw).toBeGreaterThan(0)
  })
  it('conservation of shape: sliding price up converts 0-side into 1-side monotonically', () => {
    const mid1 = amountsForLiquidity(L, Math.pow(1.0001, -300 / 2), -600, 600)
    const mid2 = amountsForLiquidity(L, Math.pow(1.0001, 300 / 2), -600, 600)
    expect(mid1.amount0Raw).toBeGreaterThan(mid2.amount0Raw)
    expect(mid1.amount1Raw).toBeLessThan(mid2.amount1Raw)
  })
  it('degenerate inputs answer zero-zero, never NaN', () => {
    for (const r of [
      amountsForLiquidity(0, 1, -600, 600),
      amountsForLiquidity(-5, 1, -600, 600),
      amountsForLiquidity(1e18, 1, 600, 600), // empty range
      amountsForLiquidity(1e18, 1, 600, -600), // inverted range
    ]) {
      expect(r.amount0Raw).toBe(0)
      expect(r.amount1Raw).toBe(0)
    }
  })
})

describe('the manager registries', () => {
  it('mainnet + Base carry the canonical NPM; 4663 = SpectrumContracts’ chain-verified read (factory() self-asserts the pairing)', () => {
    expect(V3_POSITION_MANAGER[1]).toBe('0xC36442b4a4522E871399CD717aBDD847Ab11FE88')
    expect(V3_POSITION_MANAGER[8453]).toBe('0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1')
    expect(V3_POSITION_MANAGER[4663]).toBe('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3')
  })
  it('the v4 posm registry: mainnet tx-cross-checked; 4663 = the chain-verified read (poolManager() matches)', () => {
    expect(V4_POSITION_MANAGER[1]).toBe('0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e')
    expect(V4_POSITION_MANAGER[8453]).toBe('0x7C5f5A4bBd8fD63184577525326123B519429bDc')
    expect(V4_POSITION_MANAGER[4663]).toBe('0x58daec3116aae6D93017bAAea7749052E8a04fA7')
  })
})

describe('int24At — the packed PositionInfo tick slices sign-extend', () => {
  it('reads a positive and a NEGATIVE tick out of one packed word (the live #356513 shape and its mirror)', () => {
    // pack tickLower at bits 8..31, tickUpper at bits 32..55 like the posm does
    const pack = (lower: number, upper: number) =>
      ((BigInt(upper >>> 0) & 0xffffffn) << 32n) | ((BigInt(lower >>> 0) & 0xffffffn) << 8n)
    expect(int24At(pack(15600, 29600), 8n)).toBe(15600)
    expect(int24At(pack(15600, 29600), 32n)).toBe(29600)
    expect(int24At(pack(-887220, -100), 8n)).toBe(-887220)
    expect(int24At(pack(-887220, -100), 32n)).toBe(-100)
  })
})


describe('withLpExposure — LP folds into the book like any other asset', () => {
  const base = {
    assets: [
      { key: '1:0xaa', address: '0xaa', symbol: 'FWA', chainId: 1, valueUsd: 60_000, pct: 75, basketCount: 0, contributions: [] },
      { key: '1:0xbb', address: '0xbb', symbol: 'ETH', chainId: 1, valueUsd: 20_000, pct: 25, basketCount: 0, contributions: [] },
    ],
    totalUsd: 80_000,
    chainCount: 1,
  }
  const pos = (id: string, value: number, inRange = false): LpPosition => ({
    chainId: 1,
    version: 4,
    tokenId: id,
    token0: { address: '0x0000000000000000000000000000000000000000' as never, symbol: 'ETH', decimals: 18 },
    token1: { address: '0xcf4d' as never, symbol: 'PRISM', decimals: 18 },
    fee: 10_000,
    inRange,
    amount0: 1,
    amount1: 0,
    valueUsd: value,
    partialPricing: false,
  })
  const read = { positions: [pos('1', 12_000), pos('2', 8_000)], unsupportedChains: [], cappedChains: [], unreadableV4: [] }

  it('ONE tile per pair, the total grows, every pct re-weights over the new total', () => {
    const out = withLpExposure(base as never, read)!
    expect(out.totalUsd).toBe(100_000)
    const lp = out.assets.find((a) => a.lp)
    expect(lp).toMatchObject({ symbol: 'ETH/PRISM LP', valueUsd: 20_000, pct: 20 })
    expect(lp!.contributions).toHaveLength(2)
    expect(out.assets.find((a) => a.symbol === 'FWA')!.pct).toBe(60)
    // and the base object was never mutated (display law: derive, don't edit)
    expect(base.totalUsd).toBe(80_000)
    expect(base.assets[0].pct).toBe(75)
  })
  it('null book / empty read pass through unchanged', () => {
    expect(withLpExposure(null, read)).toBeNull()
    expect(withLpExposure(base as never, undefined)).toBe(base)
    expect(withLpExposure(base as never, { ...read, positions: [] })).toBe(base)
  })
  it('an unpriced position never rides the fold (a $0 tile is a lie, not a row)', () => {
    const out = withLpExposure(base as never, { ...read, positions: [{ ...pos('9', 0), valueUsd: null }] })
    expect(out).toBe(base)
  })
  it('the contribution line NAMES the position and its range state', () => {
    const out = withLpExposure(base as never, { ...read, positions: [pos('356513', 11_840, false)] })!
    expect(out.assets.find((a) => a.lp)!.contributions[0].basketSymbol).toBe('v4 position #356513 (out of range)')
  })
})
