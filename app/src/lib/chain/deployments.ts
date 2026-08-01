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
  /** SpectrumNotes (registry/SpectrumNotes.sol) — ownerless, event-only
   *  on-chain metadata store (creator profiles + basket theses). Optional:
   *  unset → metadata falls back to the signed-blob rungs. */
  notesRegistry: Address | null
  /** LeaguePool (registry/LeaguePool.sol; canonical home = spectrum-contracts
   *  V3) — the creator league's ownerless pool, which STREAMS each league fee
   *  slice to the current crown-holder (no prize pot, no settlement day).
   *  Optional: unset → no /league page, no league copy anywhere. */
  leaguePool: Address | null
  /** True when THIS chain's configured factory is the V4Q lineage (the stocks
   *  fork: its Venue enum adds V4Q = settlement-quoted hookless V4). Arms the
   *  detector's settlement-paired sweep, letting stocks whose depth lives
   *  USDG-side (AAPL/TSLA class) become venue-3 legs. json-only, NO env
   *  override BY DESIGN: lineage is a property of the factory, so the flag
   *  must travel with the deployments.json edit that points at that factory —
   *  a standalone env flag could arm venue 3 against a deployed V2-lineage
   *  factory, whose enum stops at V2, bricking every deploy at simulate. */
  v4qLineage: boolean
  /** The creator-league slice this chain's baskets take OFF THE TOP of every fee,
   *  in bps (0 = this lineage has no league leg). Like `v4qLineage` this is
   *  json-only with NO env override BY DESIGN: it is a compile-time constant in
   *  the basket bytecode, so it must travel with the deployments.json edit that
   *  points at that factory. Getting it wrong doesn't break a transaction — it
   *  makes every DISPLAYED fee split wrong, which is why it is config and not a
   *  guess (a league chain showed the creator 24.00% where the contract paid
   *  22.80%, and the league slice nowhere at all). */
  leagueShareBps: number
  /** Superseded lineages whose baskets stay LISTED and TRADABLE through their
   *  own contracts (owner 2026-08-01: "the old baskets should continue to
   *  show, but every new launch is solely from the new contracts"). Each pair
   *  is a retired factory + the router its baskets trade through — discovery
   *  enumerates them, the trade path routes per basket, and the LAUNCH path
   *  never touches them (it reads only `factory`). json-only, no env override:
   *  a lineage is a fact about deployed history, not a per-site knob. */
  legacy: { factory: Address; swapRouter: Address }[]
}

function addr(v: unknown): Address | null {
  return typeof v === 'string' && isAddress(v, { strict: false }) ? (v as Address) : null
}

const ENV_OVERRIDES: Partial<Record<AddressField, string | undefined>> = {
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
  notesRegistry: import.meta.env.VITE_NOTES_REGISTRY_ADDRESS,
  leaguePool: import.meta.env.VITE_LEAGUE_POOL_ADDRESS,
}

type AddressField = Exclude<keyof ChainDeployment, 'v4qLineage' | 'leagueShareBps' | 'legacy'>

const FIELDS: AddressField[] = [
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
  'notesRegistry',
  'leaguePool',
]

/** The default chain env overrides apply to (Base). */
export const DEFAULT_CHAIN_ID = 8453

export function deploymentFor(chainId: number): ChainDeployment {
  const entry = (raw as Record<string, Record<string, unknown>>)[String(chainId)] ?? {}
  const out = {} as ChainDeployment
  for (const f of FIELDS) {
    const env = chainId === DEFAULT_CHAIN_ID ? addr(ENV_OVERRIDES[f]) : null
    out[f] = env ?? addr(entry[f])
  }
  // Not addresses — and json-only (see the field docs for why no env override).
  out.v4qLineage = entry.v4qLineage === true
  const league = Number(entry.leagueShareBps)
  // Bounded: a malformed or absurd value must degrade to "no league leg" rather
  // than silently rewrite every displayed fee split.
  out.leagueShareBps = Number.isFinite(league) && league > 0 && league <= 2_000 ? Math.round(league) : 0
  // Legacy lineages: validated pairs only — a malformed entry is dropped, and a
  // pair missing either address is dropped whole (a factory whose baskets have
  // no router would list things the site can't trade).
  out.legacy = Array.isArray(entry.legacy)
    ? (entry.legacy as unknown[]).flatMap((l) => {
        const rec = (l ?? {}) as Record<string, unknown>
        const factory = addr(rec.factory)
        const swapRouter = addr(rec.swapRouter)
        return factory && swapRouter ? [{ factory, swapRouter }] : []
      })
    : []
  return out
}

/** Chain ids present in deployments.json (the shipped canonical book: Base, Ethereum + Robinhood). */
export function configuredChainIds(): number[] {
  return Object.keys(raw as Record<string, unknown>)
    .map(Number)
    .filter((n) => Number.isInteger(n))
}
