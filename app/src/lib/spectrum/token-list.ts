import { cacheGet, cacheSet, DAY_MS } from './persist-cache'

// ─────────────────────────────────────────────────────────────────────────────
// Verified token list — the launch search's authority rung for major tokens.
//
// Two merged sources, both keyless + CORS-open, curated-first:
//   1. Uniswap Labs default list (tokens.uniswap.org, ~390 ETH + ~107 Base) —
//      tightly curated; wins on any address collision.
//   2. Coingecko per-chain lists (tokens.coingecko.com/{chain}/all.json,
//      thousands per chain) — broader coverage gatekept by Coingecko's listing
//      process; fills what Uniswap's list misses (e.g. bridged LINK on Base).
//
// A symbol typed by a creator that matches a listed token resolves to the
// CANONICAL address deterministically, instead of being inferred from pool
// liquidity — which closes the impostor gap outright for the tokens people
// actually type.
//
// Operator posture: zero config. Fetched at runtime on first search, cached in
// localStorage for 3 days, deduped in-flight; any failure degrades to whatever
// sources remain (worst case: DexScreener alone). The list is a RANKING/
// identity aid only — nothing is gated on it, and unlisted tokens remain fully
// addable (paste-address stays the universal path).
// ─────────────────────────────────────────────────────────────────────────────

const UNISWAP_LIST_URL = 'https://tokens.uniswap.org'
const CG_SLUG: Record<number, string> = { 1: 'ethereum', 8453: 'base' }
// 1 day, not longer: a successful refresh fully REPLACES the cached list, so the
// TTL is exactly how long a token REMOVED from the lists (usually: exposed as a
// scam and delisted) keeps its Verified badge on this device. Keep it short.
const TTL = 1 * DAY_MS

export interface ListedToken {
  address: string
  symbol: string
  name: string
  decimals: number
  chainId: number
  logoURI?: string
}

interface RawList {
  tokens?: {
    chainId?: number
    address?: string
    symbol?: string
    name?: string
    decimals?: number
    logoURI?: string
  }[]
}

/** ipfs:// → a public gateway; Coingecko /thumb/ → the /large/ rendition.
 *  https-only on the way out — this string comes from a fetched list and flows
 *  into <img src>, so it gets the same posture as creator-metadata's
 *  sanitizeImageUrl: anything that doesn't parse to an https URL is dropped
 *  (the UI falls back to the generated logo). */
function normalizeLogo(uri: string | undefined): string | undefined {
  if (!uri) return undefined
  const candidate = uri.startsWith('ipfs://')
    ? `https://ipfs.io/ipfs/${uri.slice(7)}`
    : uri.replace('/thumb/', '/large/')
  try {
    const u = new URL(candidate)
    return u.protocol === 'https:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

function normalize(raw: RawList | null, chainFilter?: number): ListedToken[] {
  return (raw?.tokens ?? [])
    .filter(
      (t) =>
        t.address &&
        t.symbol &&
        (t.chainId === 1 || t.chainId === 8453) &&
        (chainFilter == null || t.chainId === chainFilter),
    )
    .map((t) => ({
      address: t.address!,
      symbol: t.symbol!,
      name: t.name ?? t.symbol!,
      decimals: t.decimals ?? 18,
      chainId: t.chainId!,
      logoURI: normalizeLogo(t.logoURI),
    }))
}

// One in-flight fetch per source; settled lists cache to localStorage.
const inFlight = new Map<string, Promise<ListedToken[]>>()

function loadSource(cacheKey: string, url: string, chainFilter?: number): Promise<ListedToken[]> {
  const cached = cacheGet<ListedToken[]>(cacheKey)
  if (cached) return Promise.resolve(cached)
  let p = inFlight.get(cacheKey)
  if (!p) {
    p = fetch(url, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<RawList>) : null))
      .then((json) => {
        const tokens = normalize(json, chainFilter)
        if (tokens.length > 0) cacheSet(cacheKey, tokens, TTL)
        return tokens
      })
      .catch(() => [] as ListedToken[])
      .finally(() => {
        inFlight.delete(cacheKey)
      })
    inFlight.set(cacheKey, p)
  }
  return p
}

/** Verified tokens for one chain — Uniswap list merged over the Coingecko
 *  chain list (curated wins on collisions). Empty on total failure. */
export async function verifiedTokens(chainId: number): Promise<ListedToken[]> {
  const cgSlug = CG_SLUG[chainId]
  const [uni, cg] = await Promise.all([
    loadSource('uniswap-token-list', UNISWAP_LIST_URL),
    cgSlug
      ? loadSource(`cg-token-list:${chainId}`, `https://tokens.coingecko.com/${cgSlug}/all.json`, chainId)
      : Promise.resolve([] as ListedToken[]),
  ])
  const merged = new Map<string, ListedToken>()
  for (const t of cg) merged.set(t.address.toLowerCase(), t)
  for (const t of uni) if (t.chainId === chainId) merged.set(t.address.toLowerCase(), t) // curated wins
  return [...merged.values()]
}

/** Address (lowercase) → listed token, for one chain. */
export async function verifiedLookup(chainId: number): Promise<Map<string, ListedToken>> {
  const list = await verifiedTokens(chainId)
  return new Map(list.map((t) => [t.address.toLowerCase(), t]))
}
