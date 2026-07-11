import { defineChain, type Address, type Chain } from 'viem'
import { base, mainnet } from 'viem/chains'
import {
  BASE_CHAIN_ID,
  BASESCAN,
  ETHERSCAN,
  MAINNET_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER,
} from './constants'
import { configuredChainIds, deploymentFor, type ChainDeployment } from './deployments'

// Robinhood Chain (Arbitrum Orbit L2; docs.robinhood.com/chain) — not bundled in
// viem/chains yet, defined here. Native gas is ETH; Multicall3 verified deployed
// at the canonical address (batching works). The settlement asset the factory is
// wired to there is USDG (Global Dollar, 6 decimals), not USDC — same math,
// different name (see usdcSymbol below).
const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_EXPLORER } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

// Per-chain config powering the (auto-hiding) network toggle + reader / pool
// engine. Base + Ethereum + Robinhood ship LIVE by default (a deployments.json
// entry activates a chain, and the canonical book carries all three; Base leads
// as the primary). A future chain is one deployments.json entry + one scaffold
// row below. There are NO seed lists and NO addresses here — addresses come
// exclusively from deployments.ts (canonical book, every field overridable).
export interface ChainCfg extends ChainDeployment {
  chainId: number
  key: string
  name: string
  viemChain: Chain
  /** DexScreener path segment for keyless token pricing — '' = not indexed
   *  there (consumers skip the fetch instead of asking for a 404). */
  dexscreenerSlug: string
  explorer: string
  /** Display symbol of the chain's settlement asset (the factory's `USDC()`
   *  immutable): USDC on Base/Ethereum, USDG on Robinhood Chain. Labels only —
   *  decimals are 6 everywhere and the math never branches on it. */
  usdcSymbol: string
  /** External hub-swap router for chains with NO canonical Uniswap periphery:
   *  'lifi' routes the any-asset ↔ settlement hop through LiFi's source-verified
   *  diamond (the only verified router on Robinhood Chain). null = the chain has
   *  proper Uniswap infra (Base/Ethereum) or no hub path at all. */
  externalHubRouter: 'lifi' | null
}

// Chain scaffolds the app knows how to render (viem chain, explorer, pricing
// slug). A chain becomes ACTIVE when deployments.json has an entry for it OR it is
// named in VITE_EXTRA_CHAIN_IDS (an operator opt-in — see envExtraChainIds below).
const SCAFFOLDS: Record<number, Omit<ChainCfg, keyof ChainDeployment>> = {
  [BASE_CHAIN_ID]: {
    chainId: BASE_CHAIN_ID,
    key: 'base',
    name: 'Base',
    viemChain: base,
    dexscreenerSlug: 'base',
    explorer: BASESCAN,
    usdcSymbol: 'USDC',
    externalHubRouter: null,
  },
  [MAINNET_CHAIN_ID]: {
    chainId: MAINNET_CHAIN_ID,
    key: 'ethereum',
    name: 'Ethereum',
    viemChain: mainnet,
    dexscreenerSlug: 'ethereum',
    explorer: ETHERSCAN,
    usdcSymbol: 'USDC',
    externalHubRouter: null,
  },
  [ROBINHOOD_CHAIN_ID]: {
    chainId: ROBINHOOD_CHAIN_ID,
    key: 'robinhood',
    name: 'Robinhood',
    viemChain: robinhood,
    dexscreenerSlug: '', // DexScreener does not index Robinhood Chain (2026-07)
    explorer: ROBINHOOD_EXPLORER,
    usdcSymbol: 'USDG',
    externalHubRouter: 'lifi',
  },
}

// Operator opt-in for a FUTURE scaffolded chain that has no deployments.json
// entry yet (both shipped chains are already active via the canonical book).
// Comma-separated chain ids; ids with no scaffold above are ignored, never
// guessed (same rule as deployments.json). An activated chain with no addresses
// is an honest empty shell (lists / transacts nothing) until configured.
function envExtraChainIds(): number[] {
  const raw = import.meta.env.VITE_EXTRA_CHAIN_IDS
  if (!raw) return []
  return String(raw)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}

function buildChains(): Record<number, ChainCfg> {
  const out: Record<number, ChainCfg> = {}
  // deployments.json entries first (Base default), then env-activated chains, so
  // the toggle order stays Base-first and DEFAULT_CHAIN_ID still prefers Base.
  for (const id of [...configuredChainIds(), ...envExtraChainIds()]) {
    if (out[id]) continue // de-dupe (a chain can be both configured and env-listed)
    const scaffold = SCAFFOLDS[id]
    if (!scaffold) continue // unknown/unscaffolded chain — ignored, not guessed
    out[id] = { ...scaffold, ...deploymentFor(id) }
  }
  // Never ship a zero-chain build: fall back to the Base scaffold (empty addresses).
  if (Object.keys(out).length === 0) {
    out[BASE_CHAIN_ID] = { ...SCAFFOLDS[BASE_CHAIN_ID], ...deploymentFor(BASE_CHAIN_ID) }
  }
  return out
}

export const CHAINS: Record<number, ChainCfg> = buildChains()

// Base leads the switcher (primary network); env-activated chains follow.
// (Object.keys would otherwise sort integer keys numerically → 1 before 8453.)
export const SUPPORTED_CHAIN_IDS: number[] = (() => {
  const ids = Object.keys(CHAINS).map(Number)
  return ids.includes(BASE_CHAIN_ID)
    ? [BASE_CHAIN_ID, ...ids.filter((id) => id !== BASE_CHAIN_ID)]
    : ids
})()
export const DEFAULT_CHAIN_ID = SUPPORTED_CHAIN_IDS.includes(BASE_CHAIN_ID)
  ? BASE_CHAIN_ID
  : SUPPORTED_CHAIN_IDS[0]

export function chainCfg(chainId: number): ChainCfg {
  const cfg = CHAINS[chainId]
  if (!cfg) throw new Error(`Unsupported chainId: ${chainId}`)
  return cfg
}

/** A pool-engine-ready config (all Uniswap infra addresses present). */
export type PoolReadyChainCfg = ChainCfg & {
  weth: Address
  poolManager: Address
  uniV2Factory: Address
  uniV3Factory: Address
}

export function isPoolReady(cfg: ChainCfg): cfg is PoolReadyChainCfg {
  return !!(cfg.weth && cfg.poolManager && cfg.uniV2Factory && cfg.uniV3Factory)
}
