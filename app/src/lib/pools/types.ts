import { zeroAddress, type Address } from 'viem'

// Venue enum — empirically confirmed from on-chain baskets:
// 0 = Uniswap V4 (native-ETH PoolKey, hooks=0x0), 1 = V3 (v3Fee tier), 2 = V2 (pair).
export enum Venue {
  V4 = 0,
  V3 = 1,
  V2 = 2,
}

export const VENUE_LABEL: Record<Venue, string> = {
  [Venue.V4]: 'Uniswap V4',
  [Venue.V3]: 'Uniswap V3',
  [Venue.V2]: 'Uniswap V2',
}

// Native ETH sentinel (V4 ETH pools use address(0) as currency0).
export const NATIVE_ETH = zeroAddress

// V4 dynamic-fee flag — pools carrying it are rejected (fee must be static).
export const DYNAMIC_FEE_FLAG = 0x800000

export interface PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export const ZERO_POOL_KEY: PoolKey = {
  currency0: zeroAddress,
  currency1: zeroAddress,
  fee: 0,
  tickSpacing: 0,
  hooks: zeroAddress,
}

export interface PoolCandidate {
  venue: Venue
  label: string
  /** pip fee (3000 = 0.3%). V2 is fixed 0.3% by convention. */
  fee: number
  /** tick spacing (V3/V4); 0 for V2. */
  tickSpacing: number
  /** V2 pair / V3 pool address; null for V4 (singleton). */
  poolAddress: Address | null
  /** V4 pool id; null otherwise. */
  poolId: string | null
  /** V4 PoolKey; null otherwise. */
  ethPoolKey: PoolKey | null
  /** ETH/WETH-side depth (on-chain). Fallback ranking only — NOT comparable across
   *  venues (V2/V3 are real reserves; V4's virtual reserve inflates concentrated L). */
  depthEth: number
  /** USD liquidity used for ranking — DexScreener pool TVL when listed, else an
   *  on-chain ETH-side estimate. */
  depthUsd: number | null
  /** True when DexScreener lists this exact pool (real, cross-venue-comparable TVL). */
  dexListed?: boolean
}

// Routing fields ready to drop into a `deployIndex` basket entry.
export interface BasketRoute {
  venue: Venue
  ethPool: PoolKey // populated for V4; zeroed otherwise
  v3Fee: number // populated for V3; 0 otherwise
  v2Pair: Address // populated for V2; zero otherwise
}

export interface BestPoolResult {
  asset: Address
  chainId: number
  decimals: number
  best: PoolCandidate
  route: BasketRoute
  /** All valid Uniswap candidates, deepest-first. */
  candidates: PoolCandidate[]
  warnings: string[]
}

export type PoolErrorCode =
  | 'NO_POOL'
  | 'ONLY_AERODROME'
  | 'BAD_ASSET'
  | 'VENUE_CHECK_FAILED' // an RPC error left V2/V3 coverage incomplete — retry beats a wrong pool
  // Constituent screening (token-screen.ts) — deterministic disqualifiers:
  | 'NOT_A_CONTRACT' // no code at the address on this chain
  | 'NON_STANDARD' // decimals() reverts / out of range — the deploy itself would revert
  | 'ERC777' // ERC-1820-registered 777 token — the basket ctor rejects it on-chain
  | 'SPECTRUM_BASKET' // a basket token (its own V4 hook) can't be nested as a leg
  | 'FEE_ON_TRANSFER' // measured transfer fee — legs under-fill on every mint
  | 'REBASING' // elastic balances break share accounting

export class PoolDetectionError extends Error {
  readonly code: PoolErrorCode
  constructor(message: string, code: PoolErrorCode) {
    super(message)
    this.name = 'PoolDetectionError'
    this.code = code
  }
}
