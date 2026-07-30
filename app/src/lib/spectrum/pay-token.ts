import { isAddress, type Address } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// The pay side of the swap console (owner 2026-07-29, ease-of-buying batch 2):
// a buyer holding ANYTHING should be able to buy a basket — "I don't have USDG"
// is the real funding blocker, not swap-UI friction. The pay side is therefore
// either one of the chain's hub tokens (ETH / WETH / settlement — routed through
// Uniswap or the chain's external hub exactly as before) or ANY ERC-20, whose
// hub leg rides the already-guarded same-chain LiFi path (lifi.ts: target ==
// spender, echoed route == asked, exact value; delivery measured from receipt
// logs). The protected basket leg is identical in every case.
// ─────────────────────────────────────────────────────────────────────────────

export type HubToken = 'ETH' | 'WETH' | 'USDC'

export interface Erc20PayToken {
  kind: 'erc20'
  address: Address
  symbol: string
  decimals: number
  /** The chain this address lives on — an address means nothing off its chain,
   *  so persisted picks are only ever restored onto the SAME chain. */
  chainId: number
}

export type PayToken = { kind: 'hub'; hub: HubToken } | Erc20PayToken

export const hubPay = (hub: HubToken): PayToken => ({ kind: 'hub', hub })

/** A token's `decimals()` read off-chain, bounded. viem does NOT range-check an
 *  ABI `uint8` (a hostile token can decode as 1e6), and `formatUnits` is
 *  O(decimals²) — an unbounded value wedges the main thread for minutes
 *  (redteam 2026-07-29 F-2, measured 3.5s at 100k). Same 0..36 bound the
 *  persisted-pick parser has always enforced; null ⇒ treat as unreadable. */
export function asTokenDecimals(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= 36 ? n : null
}

/** Storage codec. Hubs persist as their bare name — exactly what the pre-batch-2
 *  remembered-pay-token wrote, so old values keep working unchanged. */
export function serializePayToken(p: PayToken): string {
  if (p.kind === 'hub') return p.hub
  return `erc20:${JSON.stringify({ address: p.address, symbol: p.symbol, decimals: p.decimals, chainId: p.chainId })}`
}

/** Parse a stored pay token. Hostile-input posture (localStorage is writable by
 *  anything on the origin): every field re-validated, a mismatched chainId is
 *  dropped, and garbage returns null — the caller falls back to its default. */
export function parseStoredPayToken(
  raw: string | null,
  chainId: number,
  allowedHubs: readonly HubToken[],
): PayToken | null {
  if (!raw) return null
  if ((allowedHubs as readonly string[]).includes(raw)) return { kind: 'hub', hub: raw as HubToken }
  if (!raw.startsWith('erc20:')) return null
  try {
    const o = JSON.parse(raw.slice(6)) as Record<string, unknown>
    if (
      o &&
      typeof o.address === 'string' &&
      isAddress(o.address) &&
      typeof o.symbol === 'string' &&
      o.symbol.length > 0 &&
      o.symbol.length <= 24 &&
      typeof o.decimals === 'number' &&
      Number.isInteger(o.decimals) &&
      o.decimals >= 0 &&
      o.decimals <= 36 &&
      o.chainId === chainId
    ) {
      return { kind: 'erc20', address: o.address as Address, symbol: o.symbol, decimals: o.decimals, chainId }
    }
  } catch {
    /* unparseable — treated as absent */
  }
  return null
}

// ── recent custom pay tokens (per chain) ─────────────────────────────────────
// The picker's "Recent" shelf — the cheap, indexer-free version of "your
// tokens": what this wallet actually paid with before is what it most likely
// holds and will pay with again.

const RECENT_MAX = 6
const recentKey = (chainId: number) => `spectrum:recent-pay-tokens:${chainId}`

export function recentPayTokens(chainId: number): Erc20PayToken[] {
  try {
    const raw = window.localStorage.getItem(recentKey(chainId))
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    const out: Erc20PayToken[] = []
    for (const item of arr) {
      const p = parseStoredPayToken(
        `erc20:${JSON.stringify(item)}`,
        chainId,
        [],
      )
      if (p && p.kind === 'erc20') out.push(p)
      if (out.length >= RECENT_MAX) break
    }
    return out
  } catch {
    return []
  }
}

export function rememberRecentPayToken(t: Erc20PayToken): void {
  try {
    const rest = recentPayTokens(t.chainId).filter((r) => r.address.toLowerCase() !== t.address.toLowerCase())
    const next = [t, ...rest].slice(0, RECENT_MAX)
    window.localStorage.setItem(
      recentKey(t.chainId),
      JSON.stringify(next.map(({ address, symbol, decimals, chainId }) => ({ address, symbol, decimals, chainId }))),
    )
  } catch {
    /* storage unavailable — recents are a nicety */
  }
}
