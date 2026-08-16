import { erc20Abi, formatUnits, type Address } from 'viem'
import { clientFor } from '../chain/rpc'
import { SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { describeTokens } from './token-discovery'

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL ASSETS (owner 2026-08-12: "we need to allow people to paste a
// contract address to detect any asset that our system didn't pick up
// automatically"). A per-owner, device-local list of pasted token addresses
// that JOINS THE SWEEP: use-raw-holdings unions every group member's rows and
// hands them to fetchChainRawHoldings, so a hand-added asset survives reloads,
// rides the same describe/price path as discovered tokens, and lands in the
// same totals and exports. Hand-added rows are exempt from the dust fold —
// the user explicitly asked for them.
//
// Store shape (versioned + validated like the composer draft): one row per
// (chainId, address), lowercase, addedAt for provenance; corrupt rows are
// dropped on read, a write heals the row. Capped so a paste-happy session
// cannot grow it unbounded.
// ─────────────────────────────────────────────────────────────────────────────

export interface ManualAsset {
  chainId: number
  /** lowercase 0x… */
  address: string
  addedAt: number
}

const keyFor = (owner: string) => `spectrum:manual-assets:v1:${owner.toLowerCase()}`
const ADDR_RE = /^0x[0-9a-f]{40}$/
const MAX_ROWS = 100

function validRow(r: unknown): r is { chainId: number; address: string; addedAt?: number } {
  if (typeof r !== 'object' || r === null) return false
  const o = r as Record<string, unknown>
  return (
    typeof o.chainId === 'number' &&
    SUPPORTED_CHAIN_IDS.includes(o.chainId) &&
    typeof o.address === 'string' &&
    ADDR_RE.test(o.address.toLowerCase())
  )
}

/** This owner's hand-added assets — validated, deduped, corrupt rows dropped. */
export function loadManualAssets(owner: string): ManualAsset[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(keyFor(owner)) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: ManualAsset[] = []
    for (const r of raw) {
      if (!validRow(r)) continue
      const address = r.address.toLowerCase()
      const k = `${r.chainId}:${address}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ chainId: r.chainId, address, addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0 })
    }
    return out
  } catch {
    return []
  }
}

/** Add rows for this owner (deduped, capped, invalid rows refused quietly),
 *  then wake every subscribed reader — the raw sweep re-keys and re-reads. */
export function addManualAssets(owner: string, rows: { chainId: number; address: string }[]): void {
  const cur = loadManualAssets(owner)
  const seen = new Set(cur.map((r) => `${r.chainId}:${r.address}`))
  const now = Date.now()
  for (const r of rows) {
    const address = r.address.toLowerCase()
    if (!ADDR_RE.test(address) || !SUPPORTED_CHAIN_IDS.includes(r.chainId)) continue
    const k = `${r.chainId}:${address}`
    if (seen.has(k)) continue
    seen.add(k)
    cur.push({ chainId: r.chainId, address, addedAt: now })
  }
  try {
    window.localStorage.setItem(keyFor(owner), JSON.stringify(cur.slice(-MAX_ROWS)))
  } catch {
    /* private mode — the pasted asset still reads this session via notify */
  }
  notify()
}

/** The union of several owners' manual rows (a linked GROUP reads as one
 *  book, so any member's hand-added asset belongs to the merged read). */
export function manualAssetsFor(owners: readonly string[]): ManualAsset[] {
  const seen = new Set<string>()
  const out: ManualAsset[] = []
  for (const o of owners) {
    for (const r of loadManualAssets(o)) {
      const k = `${r.chainId}:${r.address}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(r)
    }
  }
  return out
}

/** Stable signature of the union — a React Query key part, so an add re-keys
 *  the sweep and the new asset appears without a reload. */
export function manualSig(owners: readonly string[]): string {
  return manualAssetsFor(owners)
    .map((r) => `${r.chainId}:${r.address}`)
    .sort()
    .join('|')
}

// The wake-up wire (useSyncExternalStore shape): adds notify, readers re-read.
const listeners = new Set<() => void>()
export function subscribeManualAssets(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
function notify(): void {
  for (const fn of [...listeners]) fn()
}

// ── the paste-time probe ─────────────────────────────────────────────────────

export interface ChainProbeResult {
  chainId: number
  /** The address answers as a token contract on this chain. */
  found: boolean
  /** Bounded by describeTokens (≤24 chars); null when not found. */
  symbol: string | null
  decimals: number | null
  /** Whole-token balance summed across the wallet group's members. */
  amount: number
  /** Some member's balance read FAILED on this chain — the amount is a floor,
   *  and a zero must not be presented as a fact. */
  unreadable: boolean
}

/** A token exists PER CHAIN (the cross-chain law): probe every supported
 *  chain — does the pasted address answer as a token there, and what does the
 *  wallet group hold of it? Reads only; a chain that cannot answer reports
 *  found:false rather than guessing. */
export async function probeAssetAcrossChains(address: string, owners: readonly string[]): Promise<ChainProbeResult[]> {
  const addr = address.toLowerCase()
  return Promise.all(
    SUPPORTED_CHAIN_IDS.map(async (chainId): Promise<ChainProbeResult> => {
      try {
        const desc = await describeTokens(chainId, [addr])
        if (desc.length === 0) return { chainId, found: false, symbol: null, decimals: null, amount: 0, unreadable: false }
        const d = desc[0]
        const client = clientFor(chainId)
        const bals = await Promise.all(
          owners.map((o) =>
            client
              .readContract({ address: addr as Address, abi: erc20Abi, functionName: 'balanceOf', args: [o as Address] })
              .then((v) => v as bigint)
              .catch(() => null),
          ),
        )
        const unreadable = bals.some((b) => b === null)
        const total = bals.reduce<bigint>((s, b) => s + (b ?? 0n), 0n)
        return { chainId, found: true, symbol: d.symbol, decimals: d.decimals, amount: Number(formatUnits(total, d.decimals)), unreadable }
      } catch {
        return { chainId, found: false, symbol: null, decimals: null, amount: 0, unreadable: false }
      }
    }),
  )
}
