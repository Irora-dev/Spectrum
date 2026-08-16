import { getAddress } from 'viem'
import { chainCfg } from '../chain/chains'
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

// ⚠ THE DEXSCREENER SLUG COMES FROM THE CHAIN BOOK, NOT FROM A COPY HERE
// (the owner, 2026-08-16: "the logos of assets dont show on the deploy basket
// spinning animation"). This file used to hold its own `{1, 8453}` map and a
// comment asserting Robinhood had "no DexScreener coverage" — which stopped
// being true when 4663 was indexed, and `chains.ts` was updated while this copy
// was not. So every Robinhood asset silently fell through to initials, in the
// launch animation and everywhere else this ladder is used.
//
// A second copy of a fact is a second thing to forget. `chainCfg` already
// carries `dexscreenerSlug` as the single source of truth, so this reads it.
const dexSlug = (chainId: number): string | null => {
  try {
    return chainCfg(chainId).dexscreenerSlug || null
  } catch {
    return null // an unsupported chain has no art, which is not an error
  }
}

export function dexscreenerLogoUrl(address: string, chainId: number): string | null {
  const slug = dexSlug(chainId)
  if (!slug) return null
  return `https://dd.dexscreener.com/ds-data/tokens/${slug}/${address.toLowerCase()}.png?size=lg`
}

// ⚠ TRUSTWALLET KEEPS ITS OWN NARROW MAP, deliberately. Its slugs only LOOK
// like DexScreener's because 'ethereum' and 'base' happen to match; it has no
// Robinhood repo at all, so reusing the chain book here would build URLs that
// 404 on every 4663 asset and slow the ladder down for nothing.
const TRUSTWALLET_SLUG: Record<number, string> = { 1: 'ethereum', 8453: 'base' }

// TrustWallet's assets repo uses CHECKSUMMED addresses.
export function trustwalletLogoUrl(address: string, chainId: number): string | null {
  const slug = TRUSTWALLET_SLUG[chainId]
  if (!slug) return null
  try {
    return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${slug}/assets/${getAddress(address)}/logo.png`
  } catch {
    return null // unparseable address — skip the TrustWallet rung
  }
}

/** Static display ladder, fastest-first. The Coingecko rung is async — append
 *  `await coingeckoLogoUrl(…)` once these are exhausted. */
export function logoSources(address: string, chainId: number): string[] {
  const dex = dexscreenerLogoUrl(address, chainId)
  const tw = trustwalletLogoUrl(address, chainId)
  return [...(dex ? [dex] : []), ...(tw ? [tw] : [])]
}

/** Static extraction ladder, CORS-readable-first. */
export function colorSources(address: string, chainId: number): string[] {
  const tw = trustwalletLogoUrl(address, chainId)
  const dex = dexscreenerLogoUrl(address, chainId)
  return [...(tw ? [tw] : []), ...(dex ? [dex] : [])]
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
  // ⚠ COINGECKO'S PLATFORM IDS ARE ITS OWN, and only coincide with DexScreener's
  // for these two. Keyed narrowly on purpose: asking Coingecko about a platform
  // it does not have is a guaranteed miss plus a wasted round-trip.
  const platform = TRUSTWALLET_SLUG[chainId]
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
          // below) stay uncached and retry on the next ask.
          const info: CoingeckoInfo = {
            image: j?.image?.large ?? j?.image?.small ?? null,
            marketCapUsd: j?.market_data?.market_cap?.usd ?? null,
            rank: j?.market_cap_rank ?? null,
          }
          cacheSet(`cg:${key}`, info, 7 * DAY_MS)
          return info
        })
        .catch(() => {
          // Transient (429/5xx/network): a settled-null promise in the session
          // memo would blackhole ranks + the CG logo rung until reload — the
          // exact pattern the Blockscout rung below fixes. Drop the memo.
          cgLookups.delete(key)
          return null
        })
    }
    cgLookups.set(key, p)
  }
  return p
}

/** The Coingecko rung as a plain logo URL (AssetLogo / color extraction). */
export function coingeckoLogoUrl(address: string, chainId: number): Promise<string | null> {
  return coingeckoInfo(address, chainId).then((i) => i?.image ?? null)
}

// ── Blockscout icon lookup (Robinhood Chain) ─────────────────────────────────
// No static logo CDN covers 4663, but the chain's Blockscout DOES track token
// icons (Coingecko art for listed memecoins, Robinhood's own CDN for stocks).
// One JSON fetch per token, memoized for the session (owner 2026-07-29: RH
// tokens were falling to monograms with real art available).
const bsIconMem = new Map<string, Promise<string | null>>()
export function blockscoutIconUrl(address: string, chainId: number): Promise<string | null> {
  if (chainId !== 4663) return Promise.resolve(null)
  const key = address.toLowerCase()
  let p = bsIconMem.get(key)
  if (!p) {
    p = fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${key}`, { headers: { Accept: 'application/json' } })
      .then((r) => {
        // Only DEFINITIVE answers are cacheable: 200 (icon or none) and 404.
        // A 429/5xx/network blip must NOT blackhole the icon for the session
        // (sweep catch — it was re-breaking the very fix this rung shipped).
        if (r.ok) return r.json() as Promise<{ icon_url?: string | null }>
        if (r.status === 404) return null
        throw new Error(`blockscout ${r.status}`)
      })
      .then((j) => {
        const u = (j?.icon_url ?? '').trim()
        return u && u.startsWith('https://') ? u : null
      })
      .catch(() => {
        bsIconMem.delete(key) // transient — retry on the next render
        return null
      })
    bsIconMem.set(key, p)
  }
  return p
}

