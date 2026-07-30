import { createPublicClient, http, type PublicClient } from 'viem'
import { CHAINS } from './chains'
import { BASE_CHAIN_ID, MAINNET_CHAIN_ID, ROBINHOOD_CHAIN_ID } from './constants'

// Public fallbacks (no key). Match the existing dashboard's reference.
const PUBLIC_BASE = 'https://base-rpc.publicnode.com'
const PUBLIC_MAINNET = 'https://ethereum-rpc.publicnode.com'
// Robinhood Chain's own public endpoint (docs.robinhood.com/chain/connecting) —
// rate-limited; for production set VITE_ROBINHOOD_RPC_URL to a provider endpoint.
const PUBLIC_ROBINHOOD = 'https://rpc.mainnet.chain.robinhood.com'

// All four RPC vars are trimmed at the read: a hand-edited value with stray
// whitespace would otherwise be truthy — forming a broken provider URL and
// arming the wide V4 scan on a dead endpoint. ''/absent stays cleanly falsy.
const envTrim = (v: string | undefined): string => (v ?? '').trim()
const alchemyKey = envTrim(import.meta.env.VITE_ALCHEMY_API_KEY)

// Precedence (mirrors the existing app): explicit VITE_*_RPC_URL → Alchemy key → public.
//
// NOTE: this is a fully client-side (static / IPFS) build — anything resolved here
// ships in the bundle. A VITE_ALCHEMY_API_KEY would therefore be PUBLIC. Prefer the
// public fallback, a key restricted by allowed-origins, or a read proxy you control.
export function baseRpcUrl(): string {
  return (
    envTrim(import.meta.env.VITE_BASE_RPC_URL) ||
    (alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}` : PUBLIC_BASE)
  )
}

export function mainnetRpcUrl(): string {
  return (
    envTrim(import.meta.env.VITE_MAINNET_RPC_URL) ||
    (alchemyKey ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}` : PUBLIC_MAINNET)
  )
}

// Alchemy DOES serve Robinhood Chain now (robinhood-mainnet.g.alchemy.com —
// owner-confirmed + DNS/endpoint-verified 2026-07-30; the old "no tier" note
// predated it), so the one key covers all three chains.
export function robinhoodRpcUrl(): string {
  return (
    envTrim(import.meta.env.VITE_ROBINHOOD_RPC_URL) ||
    (alchemyKey ? `https://robinhood-mainnet.g.alchemy.com/v2/${alchemyKey}` : PUBLIC_ROBINHOOD)
  )
}

// Whether an Alchemy key is configured — enables wide (full-range) filtered getLogs,
// which public RPCs choke on. The pool engine uses this for complete V4 discovery.
export function hasAlchemyKey(): boolean {
  return !!alchemyKey
}

// A PRIVATE endpoint serves this chain: an explicit URL override (any provider —
// QuickNode, Infura, self-hosted…) or the Alchemy key on a chain Alchemy serves.
// This — not hasAlchemyKey alone — is what the pool engine gates wide V4 discovery
// on: an operator on a non-Alchemy provider gets the full scan too (the old
// key-only check skipped their perfectly capable endpoint, owner 2026-07-12).
export function hasPrivateRpc(chainId: number): boolean {
  if (chainId === BASE_CHAIN_ID && envTrim(import.meta.env.VITE_BASE_RPC_URL)) return true
  if (chainId === MAINNET_CHAIN_ID && envTrim(import.meta.env.VITE_MAINNET_RPC_URL)) return true
  if (chainId === ROBINHOOD_CHAIN_ID && envTrim(import.meta.env.VITE_ROBINHOOD_RPC_URL)) return true
  return hasAlchemyKey() && hasAlchemyTier(chainId)
}

// Two SEPARATE facts that used to share one flag (split 2026-07-30 when
// Alchemy added Robinhood Chain):
//  · which chains the Alchemy key can serve (URL formation / hasPrivateRpc) —
//    all three now;
//  · which chains' PUBLIC endpoints choke on wide filtered getLogs, so a
//    keyless build should SKIP full-range scans there rather than hammer them.
//    Robinhood's own endpoint is proven fast on wide logs (the chain is young),
//    so keyless RH keeps ATTEMPTING full-range exactly as before — folding it
//    into one flag would have silently downgraded keyless RH discovery.
const ALCHEMY_TIER: Record<number, boolean> = {
  [BASE_CHAIN_ID]: true,
  [MAINNET_CHAIN_ID]: true,
  [ROBINHOOD_CHAIN_ID]: true,
}
export function hasAlchemyTier(chainId: number): boolean {
  return !!ALCHEMY_TIER[chainId]
}
const PUBLIC_CHOKES_ON_WIDE_LOGS: Record<number, boolean> = {
  [BASE_CHAIN_ID]: true,
  [MAINNET_CHAIN_ID]: true,
}
/** True when this chain's PUBLIC endpoint can't take full-range filtered
 *  getLogs — the scanners skip wide discovery there unless a private endpoint
 *  is configured. */
export function publicWideLogsRisky(chainId: number): boolean {
  return !!PUBLIC_CHOKES_ON_WIDE_LOGS[chainId]
}

export function rpcUrlFor(chainId: number): string {
  if (chainId === MAINNET_CHAIN_ID) return mainnetRpcUrl()
  if (chainId === ROBINHOOD_CHAIN_ID) return robinhoodRpcUrl()
  return baseRpcUrl()
}

// Per-chain singleton read clients. `batch.multicall` coalesces concurrent
// readContract calls into Multicall3 — one RPC round-trip instead of N, which
// matters both over a public endpoint and for metered (CU-billed) keys, where
// one aggregate3 call bills as a single eth_call no matter how many reads ride
// in it. `batchSize` is the max CALLDATA BYTES per chunk (viem default 1,024
// ≈ ~28 one-arg reads); 16 KB lets a whole list-poll cycle (~hundreds of
// reads) collapse into a couple of eth_calls while staying far under any
// provider calldata cap.
//
// Retry posture: default viem backoff starts at ~150 ms, which under a
// rate-limit (429) burst re-storms the endpoint. A slower base delay
// (exponential per attempt) lets the limiter window pass instead of tripping
// it repeatedly.
const clients = new Map<number, PublicClient>()
export function clientFor(chainId: number): PublicClient {
  const existing = clients.get(chainId)
  if (existing) return existing
  const cfg = CHAINS[chainId]
  if (!cfg) throw new Error(`Unsupported chainId: ${chainId}`)
  const client: PublicClient = createPublicClient({
    chain: cfg.viemChain,
    transport: http(rpcUrlFor(chainId), { retryCount: 4, retryDelay: 400 }),
    batch: { multicall: { batchSize: 16_384 } },
  })
  clients.set(chainId, client)
  return client
}

export function baseClient(): PublicClient {
  return clientFor(BASE_CHAIN_ID)
}
