import { getAddress } from 'viem'
import { cacheGet, cacheSet, DAY_MS } from './persist-cache'

// ─────────────────────────────────────────────────────────────────────────────
// Token art — the single home of the logo/color source ladders. Consumed by
// AssetLogo (display) and use-token-color (dominant-color extraction), which
// need the SAME rungs in different orders:
//
//   display    — DexScreener CDN first (fast, covers most listed tokens), then
//                TrustWallet, then the async Coingecko rung, then initials.
//   extraction — TrustWallet first (GitHub raw sends ACAO:*; DexScreener's CDN
//                refuses crossOrigin loads — verified live), then DexScreener
//                (kept in case their CDN ever turns CORS on), then Coingecko.
//
// The Coingecko rung is a keyless contract lookup (api.coingecko.com and its
// coin-images CDN both send ACAO:*, so the image is canvas-readable). It's
// async and rate-limited (~30 req/min), so it runs only after the static rungs
// fail, and every lookup — including misses — is cached for the session.
// ─────────────────────────────────────────────────────────────────────────────

const CHAIN_SLUG: Record<number, string> = { 1: 'ethereum', 8453: 'base' }

export function dexscreenerLogoUrl(address: string, chainId: number): string {
  return `https://dd.dexscreener.com/ds-data/tokens/${CHAIN_SLUG[chainId] ?? 'ethereum'}/${address.toLowerCase()}.png?size=lg`
}

// TrustWallet's assets repo uses the same chain slugs, but CHECKSUMMED addresses.
export function trustwalletLogoUrl(address: string, chainId: number): string | null {
  try {
    return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${CHAIN_SLUG[chainId] ?? 'ethereum'}/assets/${getAddress(address)}/logo.png`
  } catch {
    return null // unparseable address — skip the TrustWallet rung
  }
}

/** Static display ladder, fastest-first. The Coingecko rung is async — append
 *  `await coingeckoLogoUrl(…)` once these are exhausted. */
export function logoSources(address: string, chainId: number): string[] {
  const tw = trustwalletLogoUrl(address, chainId)
  return [dexscreenerLogoUrl(address, chainId), ...(tw ? [tw] : [])]
}

/** Static extraction ladder, CORS-readable-first. */
export function colorSources(address: string, chainId: number): string[] {
  const tw = trustwalletLogoUrl(address, chainId)
  return [...(tw ? [tw] : []), dexscreenerLogoUrl(address, chainId)]
}

export interface CoingeckoInfo {
  /** coin-images CDN URL (canvas-readable: the CDN sends ACAO:*), or null. */
  image: string | null
  marketCapUsd: number | null
  /** Coingecko's global market-cap rank — a strong authenticity signal. */
  rank: number | null
}

// One in-flight/settled promise per token — misses cache too, so a logo-less
// token costs exactly one API hit per session against the keyless rate limit
// (~30/min). Settled results ALSO persist to localStorage (7 days), so repeat
// visits don't re-spend that budget on the same majors.
const cgLookups = new Map<string, Promise<CoingeckoInfo | null>>()

/** Coingecko contract lookup: image + market cap + rank, or null (unknown
 *  token / unsupported chain / network failure). Cached in-memory + on disk. */
export function coingeckoInfo(address: string, chainId: number): Promise<CoingeckoInfo | null> {
  const platform = CHAIN_SLUG[chainId]
  if (!platform) return Promise.resolve(null)
  const key = `${chainId}:${address.toLowerCase()}`
  let p = cgLookups.get(key)
  if (!p) {
    const cached = cacheGet<CoingeckoInfo | null>(`cg:${key}`)
    if (cached !== null) {
      p = Promise.resolve(cached)
    } else {
      p = fetch(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${address.toLowerCase()}`, {
        headers: { Accept: 'application/json' },
      })
        .then((r) => {
          if (r.ok)
            return r.json() as Promise<{
              image?: { large?: string; small?: string }
              market_cap_rank?: number
              market_data?: { market_cap?: { usd?: number } }
            }>
          if (r.status === 404) return null // definitive: not a Coingecko-known token
          throw new Error(`coingecko ${r.status}`) // 429/5xx: transient, don't cache
        })
        .then((j): CoingeckoInfo | null => {
          // A definitive miss (unknown token) caches as an all-null info so it
          // doesn't re-spend rate limit every visit; transient failures (catch
          // below) stay uncached and retry next session.
          const info: CoingeckoInfo = {
            image: j?.image?.large ?? j?.image?.small ?? null,
            marketCapUsd: j?.market_data?.market_cap?.usd ?? null,
            rank: j?.market_cap_rank ?? null,
          }
          cacheSet(`cg:${key}`, info, 7 * DAY_MS)
          return info
        })
        .catch(() => null)
    }
    cgLookups.set(key, p)
  }
  return p
}

/** The Coingecko rung as a plain logo URL (AssetLogo / color extraction). */
export function coingeckoLogoUrl(address: string, chainId: number): Promise<string | null> {
  return coingeckoInfo(address, chainId).then((i) => i?.image ?? null)
}
