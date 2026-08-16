import { zeroAddress, type Address } from 'viem'

// Venue enum — empirically confirmed from on-chain baskets:
// 0 = Uniswap V4 (native-ETH PoolKey, hooks=0x0), 1 = V3 (v3Fee tier), 2 = V2 (pair),
// 3 = V4Q (settlement-quoted hookless V4 — the stocks-fork lineage; MUST stay 3,
// it mirrors that fork's Solidity enum order {V4, V3, V2, V4Q}). Deployed
// V2-lineage factories reject venue 3 in the token constructor — the detector
// only emits it where the chain config declares `v4qLineage`.
export enum Venue {
  V4 = 0,
  V3 = 1,
  V2 = 2,
  V4Q = 3,
}

export const VENUE_LABEL: Record<Venue, string> = {
  [Venue.V4]: 'Uniswap V4',
  [Venue.V3]: 'Uniswap V3',
  [Venue.V2]: 'Uniswap V2',
  [Venue.V4Q]: 'Uniswap V4 (USD-paired)',
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
  /** THE POOL'S TWO SIDES — the identity anchor, not a convenience field.
   *
   *  Discovery already knows this and used to throw it away: the V2 path READS
   *  `token0()` to pick the right reserve and then discarded it, and the V4
   *  paths carry the pair in `ethPoolKey` already. Without it on the candidate,
   *  a safety screen cannot do the one check that actually matters — matching
   *  the user's token BY ADDRESS and confirming the other side is a canonical
   *  quote asset. Symbol matching is what lets a scam token wear a real tile.
   *
   *  Sorted the way the venue sorts: `token0` is the numerically lower address
   *  (every Uniswap venue orders this way), which is why populating these costs
   *  ZERO extra RPC calls — V2 has an authoritative read already paid for, V3
   *  is derivable from the pair the factory was asked for, and V4/V4Q read
   *  straight off the PoolKey. Compare case-insensitively; these are not
   *  normalised to lowercase, because the rest of this module keeps `Address`. */
  token0: Address
  token1: Address
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
  /** The deepest HOOKED v4 pool's ETH-side depth, when one exists — hooked
   *  pools can't be routed (basket legs are hookless by design), but their
   *  depth tells whether the token's REAL market is one we can't use
   *  (the FWA class, measured 2026-08-15). null = none seen. */
  hookedMarket: { hookedDepthEth: number; bestHooklessDepthEth: number } | null
}

export type PoolErrorCode =
  | 'HOOKED_MARKET'
  | 'NO_POOL'
  | 'ONLY_AERODROME'
  | 'BAD_ASSET'
  | 'VENUE_CHECK_FAILED' // an RPC error left V2/V3 coverage incomplete — retry beats a wrong pool
  | 'V2_ONLY' // a Uniswap V2 pair is the token's ONLY route, and this chain's factory rejects venue 2 (`rejectsV2Legs`)
  | 'V2_LEG_REJECTED' // a leg CARRIES a venue-2 route on a rejecting chain (a draft saved before the rule) — v2-legs.ts
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

/** True when detection COULD NOT CHECK (RPC dropped a venue sweep) — a retry,
 *  never a verdict about the token. Batch resolvers must not treat it like
 *  NO_POOL: dropping the leg and renormalizing ships a silently-shorter basket
 *  (the verify-pass F4/F5 class). Non-detection errors (transport throws that
 *  never became a PoolDetectionError) count as retryable too. */
export function isRetryableDetection(e: unknown): boolean {
  return !(e instanceof PoolDetectionError) || e.code === 'VENUE_CHECK_FAILED'
}

/** Known hookless V4 tiers for LOGS-FREE probing (one storage read each) — the
 *  four standards + live-observed non-standards. ONE list for both consumers
 *  (per-leg discovery + the ETH/settlement hub anchor); the sweep caught them
 *  drifting apart within a single commit. */
export const V4_PROBE_TIERS: { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 5000, tickSpacing: 100 }, // the RH launch norm (CASHCAT/HOODRAT legs)
  { fee: 10000, tickSpacing: 200 },
  { fee: 20000, tickSpacing: 400 }, // 2% memecoin tier
]
