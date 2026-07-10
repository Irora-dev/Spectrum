import { isAddress, type Address } from 'viem'
import raw from './deployments.json'

// ─────────────────────────────────────────────────────────────────────────────
// Per-chain deployment config. The checked-in deployments.json SHIPS the
// CANONICAL Spectrum address book (Base 8453 + Ethereum 1), so a zero-config
// build is a working site on the canonical deployment. Every field is an
// override point: set the VITE_* env vars (default chain only) or edit
// deployments.json to serve your OWN deployment instead. A chain with no entry
// is an honest empty shell (lists nothing, transacts nothing). The two
// fee-recipient vars (VITE_INTERFACE_TAG_ADDRESS / VITE_LAUNCHER_ADDRESS) are
// deliberately NOT part of this file and ship empty — no default fee
// recipient, ever.
//
// Env overrides (apply to the DEFAULT chain — Base 8453; static-bundle note in
// .env.example applies: every VITE_ value ships publicly):
//   VITE_FACTORY_ADDRESS, VITE_USDC_ADDRESS, VITE_POOL_MANAGER_ADDRESS,
//   VITE_SWAP_ROUTER_ADDRESS, VITE_WETH_ADDRESS, VITE_UNIV2_FACTORY_ADDRESS,
//   VITE_UNIV3_FACTORY_ADDRESS, VITE_AERODROME_FACTORY_ADDRESS,
//   VITE_UNIV3_SWAP_ROUTER_ADDRESS, VITE_UNIV3_QUOTER_ADDRESS,
//   VITE_V4_QUOTER_ADDRESS, VITE_UNIVERSAL_ROUTER_ADDRESS
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainDeployment {
  /** Spectrum V2 factory. deployments.json ships the canonical one; null = the chain is unconfigured. */
  factory: Address | null
  /** Canonical USDC for the chain (the V2 settlement asset). */
  usdc: Address | null
  /** Uniswap V4 PoolManager singleton. */
  poolManager: Address | null
  /** Spectrum first-party swap router —
   *  the periphery that carries the (minOut, legMins[], frontend) hookData into a
   *  basket's V4 self-pool for buy/sell. deployments.json ships the CANONICAL
   *  router; override via env/json to route through your own. null (a chain with
   *  none configured) leaves the TradePanel + /swap broadcast inert —
   *  VITE_ENABLE_SWAP is the arm switch either way. */
  swapRouter: Address | null
  weth: Address | null
  uniV2Factory: Address | null
  uniV3Factory: Address | null
  /** Uniswap V3 SwapRouter02 (canonical) — executes the migrate modal's delta
   *  trades (sell dropped legs → buy added legs via the WETH hub). Optional:
   *  unset → in-kind migration still works for reweight/drop-a-leg versions,
   *  only the auto delta trade is unavailable. */
  uniV3SwapRouter: Address | null
  /** Uniswap V3 QuoterV2 (canonical) — balance-free quotes for those trades. */
  uniV3Quoter: Address | null
  /** Uniswap V4 Quoter (canonical) — quotes basket self-pools verbatim with
   *  empty hookData (the /integrate quoting path). Verified by matching the
   *  quoter's immutable poolManager() against this chain's poolManager. */
  v4Quoter: Address | null
  /** Uniswap Universal Router (canonical, v4-capable) — one standard fill path
   *  for basket self-pools (any unlock executor also works). Verified by the
   *  router bytecode embedding this chain's poolManager immutable. */
  universalRouter: Address | null
  /** Aerodrome PoolFactory (Base) — detected only to WARN (no hook support). */
  aerodromeFactory: Address | null
}

function addr(v: unknown): Address | null {
  return typeof v === 'string' && isAddress(v, { strict: false }) ? (v as Address) : null
}

const ENV_OVERRIDES: Partial<Record<keyof ChainDeployment, string | undefined>> = {
  factory: import.meta.env.VITE_FACTORY_ADDRESS,
  usdc: import.meta.env.VITE_USDC_ADDRESS,
  poolManager: import.meta.env.VITE_POOL_MANAGER_ADDRESS,
  swapRouter: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
  weth: import.meta.env.VITE_WETH_ADDRESS,
  uniV2Factory: import.meta.env.VITE_UNIV2_FACTORY_ADDRESS,
  uniV3Factory: import.meta.env.VITE_UNIV3_FACTORY_ADDRESS,
  uniV3SwapRouter: import.meta.env.VITE_UNIV3_SWAP_ROUTER_ADDRESS,
  uniV3Quoter: import.meta.env.VITE_UNIV3_QUOTER_ADDRESS,
  v4Quoter: import.meta.env.VITE_V4_QUOTER_ADDRESS,
  universalRouter: import.meta.env.VITE_UNIVERSAL_ROUTER_ADDRESS,
  aerodromeFactory: import.meta.env.VITE_AERODROME_FACTORY_ADDRESS,
}

const FIELDS: (keyof ChainDeployment)[] = [
  'factory',
  'usdc',
  'poolManager',
  'swapRouter',
  'weth',
  'uniV2Factory',
  'uniV3Factory',
  'uniV3SwapRouter',
  'uniV3Quoter',
  'v4Quoter',
  'universalRouter',
  'aerodromeFactory',
]

/** The default chain env overrides apply to (Base). */
export const DEFAULT_CHAIN_ID = 8453

export function deploymentFor(chainId: number): ChainDeployment {
  const entry = (raw as Record<string, Record<string, string>>)[String(chainId)] ?? {}
  const out = {} as ChainDeployment
  for (const f of FIELDS) {
    const env = chainId === DEFAULT_CHAIN_ID ? addr(ENV_OVERRIDES[f]) : null
    out[f] = env ?? addr(entry[f])
  }
  return out
}

/** Chain ids present in deployments.json (the shipped canonical book: Base + Ethereum). */
export function configuredChainIds(): number[] {
  return Object.keys(raw as Record<string, unknown>)
    .map(Number)
    .filter((n) => Number.isInteger(n))
}
