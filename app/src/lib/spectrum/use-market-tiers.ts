import { useQueries } from '@tanstack/react-query'
import { chainCfg } from '../chain/chains'
import { cacheGet, cacheSet } from './persist-cache'
import { assetKey, type AllocAsset } from './allocation'

// Market caps for HELD assets — keyless DexScreener batch reads (the same
// endpoint token-search already leans on), persist-cached, one query per
// chain. A chain DexScreener doesn't index (4663) or a failed read yields
// null → the asset renders 'unranked' (facts-only law: never guessed).

const MCAP_TTL_MS = 60 * 60 * 1000
// v4: the cached record gained firstSeenMs (the ultra-small-cap age test), so
// v3 entries must not be reused — a missing age would read as "not new"

interface DexPairLite {
  baseToken?: { address?: string }
  marketCap?: number
  fdv?: number
  liquidity?: { usd?: number }
  priceChange?: { h24?: number }
  /** When this pair started trading, ms epoch — DexScreener's own field. The
   *  closest thing to a launch date a keyless read can get. */
  pairCreatedAt?: number
}

/** What one DexScreener read tells us about a token. Market cap drives the
 *  tier; LIQUIDITY drives the exit-depth facts. Both arrive in the SAME
 *  response, so reading depth costs no extra call — it was being thrown away. */
export interface MarketRead {
  mcapUsd: number | null
  /** Quote-side depth of the deepest pool, USD. Null = unreadable, never 0. */
  liquidityUsd: number | null
  /** 24h price change, percent. Null = unreadable — NEVER 0, because "flat" and
   *  "we don't know" are different things and only one of them is a fact. */
  change24hPct: number | null
  /** WHEN IT STARTED TRADING (ms epoch) — the OLDEST pair we can see, because a
   *  token's age is the age of its first market, not of whichever pool a
   *  deployer opened this morning to make it look established. Null =
   *  unreadable, which the tier treats as "unknown", never as "old". */
  firstSeenMs: number | null
}

async function fetchCaps(slug: string, addresses: string[]): Promise<Map<string, MarketRead>> {
  const out = new Map<string, MarketRead>()
  const misses: string[] = []
  for (const a of addresses) {
    const hit = cacheGet<MarketRead>(`mkt:v4:${slug}:${a}`)
    if (hit != null) out.set(a, hit)
    else misses.push(a)
  }
  for (let i = 0; i < misses.length; i += 30) {
    const batch = misses.slice(i, i + 30)
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${batch.join(',')}`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) continue // failed read → nulls below, never zeroes
      const pairs = (await res.json()) as DexPairLite[]
      // Cap = the largest reported; DEPTH = the DEEPEST SINGLE POOL, never the
      // sum. Summing pools would overstate what one exit can actually clear:
      // you trade against a pool, not against the total.
      const caps = new Map<string, number>()
      const depth = new Map<string, number>()
      // the change is read from the DEEPEST pair, not the first or the average:
      // a shallow pool's print is noise, and the deep pool is the price people
      // actually trade at.
      const chg = new Map<string, { liq: number; pct: number }>()
      // OLDEST pair wins the age: a fresh pool on an old token must not make it
      // look newly launched, and the ultra band is gated on genuine newness.
      const born = new Map<string, number>()
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const addr = p.baseToken?.address?.toLowerCase()
        if (!addr) continue
        const at = p.pairCreatedAt
        if (typeof at === 'number' && Number.isFinite(at) && at > 0 && at < (born.get(addr) ?? Infinity)) born.set(addr, at)
        const cap = p.marketCap ?? p.fdv ?? 0
        if (cap > (caps.get(addr) ?? 0)) caps.set(addr, cap)
        const liq = p.liquidity?.usd ?? 0
        if (liq > (depth.get(addr) ?? 0)) depth.set(addr, liq)
        const h24 = p.priceChange?.h24
        if (typeof h24 === 'number' && Number.isFinite(h24) && liq >= (chg.get(addr)?.liq ?? -1)) {
          chg.set(addr, { liq, pct: h24 })
        }
      }
      for (const addr of new Set([...caps.keys(), ...depth.keys(), ...born.keys()])) {
        const rec: MarketRead = {
          mcapUsd: (caps.get(addr) ?? 0) > 0 ? (caps.get(addr) as number) : null,
          liquidityUsd: (depth.get(addr) ?? 0) > 0 ? (depth.get(addr) as number) : null,
          change24hPct: chg.get(addr)?.pct ?? null,
          firstSeenMs: born.get(addr) ?? null,
        }
        if (rec.mcapUsd != null || rec.liquidityUsd != null || rec.change24hPct != null || rec.firstSeenMs != null) {
          cacheSet(`mkt:v4:${slug}:${addr}`, rec, MCAP_TTL_MS)
          out.set(addr, rec)
        }
      }
    } catch {
      /* offline/rate-limited — the batch stays unranked this pass */
    }
  }
  for (const a of addresses) if (!out.has(a)) out.set(a, { mcapUsd: null, liquidityUsd: null, change24hPct: null, firstSeenMs: null })
  return out
}

/** assetKey → the whole read (cap + depth), one query per chain. */
export function useMarketData(assets: Pick<AllocAsset, 'chainId' | 'address' | 'symbol'>[]): Map<string, MarketRead> {
  const byChain = new Map<number, string[]>()
  for (const a of assets) {
    const list = byChain.get(a.chainId) ?? []
    list.push(a.address.toLowerCase())
    byChain.set(a.chainId, list)
  }
  const chains = [...byChain.keys()].sort()

  const results = useQueries({
    queries: chains.map((chainId) => {
      let slug = ''
      try {
        slug = chainCfg(chainId).dexscreenerSlug
      } catch {
        slug = ''
      }
      const addrs = [...new Set(byChain.get(chainId) ?? [])].sort()
      return {
        queryKey: ['spectrum', 'mcap', chainId, addrs.join(',')],
        queryFn: () => fetchCaps(slug, addrs),
        enabled: slug !== '' && addrs.length > 0,
        staleTime: MCAP_TTL_MS,
        gcTime: MCAP_TTL_MS,
        retry: 1,
      }
    }),
  })

  const out = new Map<string, MarketRead>()
  chains.forEach((chainId, i) => {
    const data = results[i]?.data
    for (const a of assets) {
      if (a.chainId !== chainId) continue
      out.set(assetKey(a), data?.get(a.address.toLowerCase()) ?? { mcapUsd: null, liquidityUsd: null, change24hPct: null, firstSeenMs: null })
    }
  })
  return out
}

/** Map of assetKey → market cap USD (null = unreadable → 'unranked').
 *  The original face, kept so every existing caller is untouched. */
export function useMarketTiers(assets: Pick<AllocAsset, 'chainId' | 'address' | 'symbol'>[]): Map<string, number | null> {
  const full = useMarketData(assets)
  const out = new Map<string, number | null>()
  for (const [k, v] of full) out.set(k, v.mcapUsd)
  return out
}
