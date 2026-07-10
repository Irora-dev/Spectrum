import type { Address } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Chain-agnostic protocol constants ONLY. There are deliberately NO contract
// addresses in this file: the V2 FE ships with an EMPTY address book (see
// deployments.ts / deployments.json) and knows nothing about v1.
//
// Fee-model values (fee bps, burn share, bounds) are NOT constants in V2 — they
// vary per basket and are read on-chain (lib/spectrum/use-basket-fees.ts).
// Auction parameters are read from factory views (abis-v2.ts), not hardcoded.
// ─────────────────────────────────────────────────────────────────────────────

export const BASE_CHAIN_ID = 8453
export const MAINNET_CHAIN_ID = 1

// Pool-state read: the Uniswap V4 PoolManager keeps pools in a mapping at
// storage slot 6; pool Slot0 lives at keccak(poolId . slot). A Uniswap constant,
// not a deployment address.
export const V4_POOLS_SLOT = 6n

export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as Address
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

// Explorers
export const BASESCAN = 'https://basescan.org'
export const ETHERSCAN = 'https://etherscan.io'
