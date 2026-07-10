import { getAddress, type Address } from 'viem'
import type { BasketRoute } from '../pools'
import { CAP } from './weights'

// The V2 basket token is a standard 18-decimal ERC-20.
export const BASKET_TOKEN_DECIMALS = 18
// Canonical USDC (the V2 settlement asset) is 6 decimals on Base.
export const USDC_DECIMALS = 6

// One basket entry exactly as deployBasket/predictTokenAddress expect it
// (abis-v2.ts — DRAFT; bind to the contracts deliverable). NB (carried from v1,
// re-verify on V2): the factory zeroes `decimals` inside its init-code build
// before CREATE2 and re-derives it on-chain — we still populate it truthfully.
export interface DeployBasketEntry {
  asset: Address
  venue: number
  ethPool: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
  v3Fee: number
  v2Pair: Address
  /** weight in basis points (Σ = 10000). */
  weight: number
  decimals: number
}

export interface DeployAssetInput {
  address: Address | string
  decimals: number
  route: BasketRoute
}

/**
 * Assemble the deployBasket basket from the builder's assets + whole-% weights.
 * Weights are pct×100 → bps; the weight model keeps whole-number percentages
 * summing to exactly CAP (100), so the bps sum is exactly 10000 with no drift.
 * The SAME array must be fed to both mineSalt and deployBasket (the address
 * depends on it).
 */
export function toBasketEntries(assets: DeployAssetInput[], weightsPct: number[]): DeployBasketEntry[] {
  if (assets.length !== weightsPct.length) {
    throw new Error(`basket/weights length mismatch (${assets.length} vs ${weightsPct.length})`)
  }
  const totalPct = weightsPct.reduce((s, w) => s + w, 0)
  if (totalPct !== CAP) throw new Error(`weights must sum to ${CAP}% (got ${totalPct}%)`)
  return assets.map((a, i) => ({
    asset: getAddress(a.address as string),
    venue: a.route.venue,
    ethPool: { ...a.route.ethPool },
    v3Fee: a.route.v3Fee,
    v2Pair: a.route.v2Pair,
    weight: weightsPct[i] * 100,
    decimals: a.decimals,
  }))
}

/** Integer square root for bigint (Newton's method). Floors, like Solidity's. */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('isqrt: negative input')
  if (value < 2n) return value
  let x0 = value >> 1n
  let x1 = (x0 + value / x0) >> 1n
  while (x1 < x0) {
    x0 = x1
    x1 = (x0 + value / x0) >> 1n
  }
  return x0
}

const Q192 = 1n << 192n

/**
 * Initial sqrtPriceX96 for the basket's own USDC/BASKET V4 pool so its NAV opens
 * at $1.00 — 1 basket token ($1) trades 1:1 against 1 USDC ($1). Uniswap encodes
 * sqrtPriceX96 = sqrt(amount1/amount0)·2^96 over RAW units of currency0/1, and
 * V4 orders currencies by address. USDC is $1, so equal $ value means equal unit
 * counts; only the decimal gap (USDC 6, basket 18) sets the ratio — the same
 * decimal-gap math as v1's dstable (also 6 decimals), re-derived against USDC.
 * The basket address must be the MINED one (its sort order vs USDC decides
 * currency0). DRAFT: re-verify the sort-order branch against the V2 token
 * address space once the contracts land.
 */
export function startSqrtPriceX96ForDollarNav(
  basketAddr: Address,
  usdcAddr: Address,
  basketDecimals = BASKET_TOKEN_DECIMALS,
  usdcDecimals = USDC_DECIMALS,
): bigint {
  const usdcIsCurrency0 = BigInt(usdcAddr) < BigInt(basketAddr)
  const dec0 = usdcIsCurrency0 ? usdcDecimals : basketDecimals
  const dec1 = usdcIsCurrency0 ? basketDecimals : usdcDecimals
  // sqrt(10^dec1 / 10^dec0) · 2^96 == isqrt(10^dec1 · 2^192 / 10^dec0)
  return isqrt((10n ** BigInt(dec1) * Q192) / 10n ** BigInt(dec0))
}
