import { chainCfg } from '../chain/chains'
import { cacheGet, cacheSet } from './persist-cache'
import { verifiedTokens, type ListedToken } from './token-list'

// ─────────────────────────────────────────────────────────────────────────────
// Token search by name/symbol for the launch basket builder.
//
// Two sources, merged:
//
//   1. VERIFIED LIST (token-list.ts — the Uniswap Labs default list). A typed
//      symbol that matches a listed token resolves to its canonical address
//      deterministically. Verified matches PIN ABOVE everything else — for the
//      majors people actually type, identity comes from the list, not from
//      liquidity inference. Zero-config; failures degrade to source 2 alone.
//
//   2. DexScreener's keyless search (`/latest/dex/search?q=`) — the same
//      provider used for pricing. It returns pairs across all chains; we filter
//      to the active chain, require the query to actually appear in the token's
//      symbol/name (drops fuzzy noise), and dedupe by token address.
//
// ETH-PAIRED IS ELIGIBILITY, not just ranking: basket legs route through
// ETH/WETH venues (find-best-pool: V2 `getPair(asset, WETH)`, V3
// `getPool(asset, WETH, fee)`, V4 native-ETH pools), so a token with no
// ETH-side pool cannot be a constituent at all. Search therefore only shows
// UNVERIFIED tokens with ≥1 ETH/WETH-quoted pair. VERIFIED tokens are exempt
// from the depth gate: their identity is list-anchored, the majors all route,
// and the depth endpoints rate-limit under per-keystroke typing — hiding UNI
// because a DexScreener call 429'd is worse than showing it without a
// liquidity figure (the add-flow's on-chain probe stays the final authority).
//
// Impostor resistance: reported `liquidity.usd` is manipulable — it values the
// BASE-token side at the pair's own (settable) price, so a scam pool with $1k
// of real WETH can claim $100M. Ranking/display therefore counts ONLY the
// QUOTE-SIDE reserve of the ETH/WETH-quoted pairs: tokens someone actually
// deposited, valued at the quote token's own USD price (priceUsd / priceNative
// — immune to base-side manipulation, both scale together).
//
// Depth second pass: the search endpoint only returns pairs MATCHING THE
// QUERY, so a token's ETH-liquidity sum from pass 1 can miss its deepest
// pools. The top candidates (verified matches included) are re-read through
// the batch endpoint (`/tokens/v1/{chain}/{addr,…}` — full pair set per token)
// and re-ranked on the complete picture. Structural facts, not curation — and
// the row UI always shows the contract address so the picker stays verifiable.
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenHit {
  address: string
  symbol: string
  name: string
  /** REAL (quote-side, hub-quoted) liquidity — WETH/USDC actually in the pools. */
  liquidityUsd: number
  /** Reported market cap (FDV fallback) — display + ranking tiebreak, 0 if unknown. */
  marketCapUsd: number
  /** 24h volume across the token's ETH/WETH-quoted pairs — display + final tiebreak.
   *  Wash-tradeable, so it never outranks liquidity/mcap; it disambiguates dead-heats
   *  and shows the picker which same-name token actually trades. */
  volumeH24Usd: number
  /** On the verified token list (canonical identity for majors). */
  verified: boolean
  /** Verified-list logo (preferred icon source when present). */
  logoURI?: string
}

export interface DexPair {
  chainId?: string
  baseToken?: { address?: string; name?: string; symbol?: string }
  quoteToken?: { address?: string; symbol?: string }
  liquidity?: { usd?: number; quote?: number }
  volume?: { h24?: number }
  /** Base-token price in USD / in quote units — their ratio prices the QUOTE token. */
  priceUsd?: string
  priceNative?: string
  priceChange?: { h24?: number }
  marketCap?: number
  fdv?: number
}

/** The ETH side of a routable pair on `chainId`: WETH, plus the zero address (how
 *  native-ETH V4 pools surface as a quote token). USDC deliberately does NOT count —
 *  basket legs route through ETH venues only (see header). */
export function ethHubsFor(chainId: number): Set<string> {
  const cfg = chainCfg(chainId)
  return new Set(
    [cfg.weth, '0x0000000000000000000000000000000000000000'].filter(Boolean).map((a) => a!.toLowerCase()),
  )
}

/** USD value of a pair's quote-side reserve (the unfakeable half), or 0. */
export function quoteSideUsd(p: DexPair): number {
  const quoteAmt = p.liquidity?.quote ?? 0
  const usd = Number.parseFloat(p.priceUsd ?? '')
  const native = Number.parseFloat(p.priceNative ?? '')
  if (!(quoteAmt > 0) || !Number.isFinite(usd) || !Number.isFinite(native) || native <= 0) return 0
  return quoteAmt * (usd / native)
}

export interface Agg {
  address: string
  symbol: string
  name: string
  /** Quote-side USD across the token's ETH/WETH-quoted pairs (0 = unroutable). */
  liquidityUsd: number
  marketCapUsd: number
  /** 24h volume summed over the SAME ETH/WETH-quoted pairs the liquidity counts. */
  volumeH24Usd: number
  /** 24h price change % from the token's DEEPEST ETH/WETH pair (most representative). */
  priceChangeH24: number
  /** internal: the quote-side USD of the pair `priceChangeH24` was taken from. */
  topPairUsd: number
}

// Upper bound on pairs processed from any one DexScreener response — a glitchy
// or hostile payload with tens of thousands of rows must degrade (truncated
// aggregation), never hang the picker. Real responses are well under this.
const MAX_PAIRS_PER_RESPONSE = 500

/** Fold a pair list into per-token aggregates (ETH-paired liquidity + mcap + volume). */
export function aggregatePairs(pairs: DexPair[], slug: string, hubs: Set<string>, into: Map<string, Agg>): void {
  for (const p of pairs.slice(0, MAX_PAIRS_PER_RESPONSE)) {
    if (p.chainId !== slug) continue
    const address = p.baseToken?.address
    if (!address) continue
    const key = address.toLowerCase()
    const cur = into.get(key) ?? {
      address,
      symbol: p.baseToken?.symbol ?? '',
      name: p.baseToken?.name ?? '',
      liquidityUsd: 0,
      marketCapUsd: 0,
      volumeH24Usd: 0,
      priceChangeH24: 0,
      topPairUsd: 0,
    }
    const ethQuoted = !!p.quoteToken?.address && hubs.has(p.quoteToken.address.toLowerCase())
    if (ethQuoted) {
      const q = quoteSideUsd(p)
      cur.liquidityUsd += q
      cur.volumeH24Usd += p.volume?.h24 ?? 0
      // 24h change from the DEEPEST pair — the most representative of the token.
      const chg = p.priceChange?.h24
      if (typeof chg === 'number' && Number.isFinite(chg) && q >= cur.topPairUsd) {
        cur.topPairUsd = q
        cur.priceChangeH24 = chg
      }
    }
    // Market cap is per-token, but pairs disagree slightly — keep the largest claim.
    const mcap = p.marketCap ?? p.fdv ?? 0
    if (mcap > cur.marketCapUsd) cur.marketCapUsd = mcap
    into.set(key, cur)
  }
}

/** Depth entries persist briefly: the picker fires on every keystroke and
 *  DexScreener rate-limits, so a recent success must outlive the next failure —
 *  a rate-limited call showing a major at $0 (or a token at a fraction of its
 *  real depth) is exactly the launch-page bug this guards against. */
const DEPTH_TTL_MS = 15 * 60_000

/** Full-pair-set depth for up to 30 tokens in ONE request (the batch endpoint
 *  is per-token, not query-scoped, so its sums see pools pass 1 missed). */
async function batchDepth(
  addresses: string[],
  slug: string,
  hubs: Set<string>,
  signal?: AbortSignal,
): Promise<Map<string, Agg>> {
  const out = new Map<string, Agg>()
  if (addresses.length === 0) return out
  const misses: string[] = []
  for (const a of addresses) {
    const hit = cacheGet<Agg>(`tokdepth:v1:${slug}:${a}`)
    if (hit) out.set(a, hit)
    else misses.push(a)
  }
  if (misses.length === 0) return out
  try {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/${slug}/${misses.slice(0, 30).join(',')}`,
      { signal, headers: { Accept: 'application/json' } },
    )
    if (!res.ok) return out
    const pairs = (await res.json()) as DexPair[]
    const fresh = new Map<string, Agg>()
    aggregatePairs(Array.isArray(pairs) ? pairs : [], slug, hubs, fresh)
    for (const [key, agg] of fresh) {
      cacheSet(`tokdepth:v1:${slug}:${key}`, agg, DEPTH_TTL_MS)
      out.set(key, agg)
    }
  } catch {
    /* rate-limited/offline — cached depths above still serve this search */
  }
  return out
}

/** Verified-list matches for the query: exact symbol > symbol prefix > name. */
function matchVerified(list: ListedToken[], ql: string): ListedToken[] {
  const score = (t: ListedToken) =>
    t.symbol.toLowerCase() === ql
      ? 3
      : t.symbol.toLowerCase().startsWith(ql)
        ? 2
        : t.name.toLowerCase().includes(ql)
          ? 1
          : 0
  return list
    .map((t) => ({ t, s: score(t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map((x) => x.t)
}

export async function searchTokens(
  query: string,
  chainId: number,
  signal?: AbortSignal,
): Promise<TokenHit[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const cfg = chainCfg(chainId)
  const slug = cfg.dexscreenerSlug // 'base' | 'ethereum' — matches DexScreener chainId
  const ql = q.toLowerCase()
  const hubs = ethHubsFor(chainId)

  // ── pass 1: DexScreener search + the verified list, in parallel ────────────
  const [pairs, listed] = await Promise.all([
    fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, {
      signal,
      headers: { Accept: 'application/json' },
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ pairs?: DexPair[] }>) : null))
      .then((j) => j?.pairs ?? [])
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') throw e
        return [] as DexPair[]
      }),
    verifiedTokens(chainId),
  ])

  const byAddr = new Map<string, Agg>()
  aggregatePairs(
    // Relevance gate: the query must appear in the symbol or name.
    pairs.filter(
      (p) =>
        (p.baseToken?.symbol ?? '').toLowerCase().includes(ql) ||
        (p.baseToken?.name ?? '').toLowerCase().includes(ql),
    ),
    slug,
    hubs,
    byAddr,
  )

  const verifiedMatches = matchVerified(listed, ql)
  const verifiedByAddr = new Map(verifiedMatches.map((t) => [t.address.toLowerCase(), t]))

  // ── pass 2: full-pair-set depth for every candidate that could rank ────────
  const candidates = [
    ...verifiedMatches.map((t) => t.address),
    ...[...byAddr.values()]
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
      .slice(0, 10)
      .map((a) => a.address),
  ]
  const uniq = [...new Set(candidates.map((a) => a.toLowerCase()))]
  const full = await batchDepth(uniq, slug, hubs, signal)
  for (const [key, agg] of full) {
    const cur = byAddr.get(key)
    if (!cur) {
      byAddr.set(key, agg) // verified match the query-search never surfaced
    } else {
      // The batch saw the token's WHOLE pair set — its sums supersede pass 1.
      cur.liquidityUsd = agg.liquidityUsd
      cur.volumeH24Usd = agg.volumeH24Usd
      cur.marketCapUsd = Math.max(cur.marketCapUsd, agg.marketCapUsd)
    }
  }

  // A verified match with NO depth data anywhere (the query search missed it AND
  // the batch call failed/rate-limited — "uni" → UNI is exactly this: DexScreener's
  // search ranks cross-chain noise above it) must still SURFACE. Its identity is
  // list-anchored and the add-flow's on-chain probe is the real eligibility
  // authority; it just shows without a liquidity figure rather than vanishing.
  for (const t of verifiedMatches) {
    const key = t.address.toLowerCase()
    if (!byAddr.has(key)) {
      byAddr.set(key, {
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        liquidityUsd: 0,
        marketCapUsd: 0,
        volumeH24Usd: 0,
        priceChangeH24: 0,
        topPairUsd: 0,
      })
    }
  }

  // Eligibility gate: no ETH/WETH-quoted pair → not a possible basket leg → not
  // shown — for UNVERIFIED tokens, where hub-quoted depth is also the identity
  // signal. Verified tokens keep their list-anchored identity even when the depth
  // endpoints are down (all majors route; the on-chain probe is final anyway).
  const pool = [...byAddr.values()].filter(
    (h) => h.liquidityUsd > 0 || verifiedByAddr.has(h.address.toLowerCase()),
  )

  return pool
    .map(({ address, symbol, name, liquidityUsd, marketCapUsd, volumeH24Usd }): TokenHit => {
      const v = verifiedByAddr.get(address.toLowerCase())
      return {
        address,
        // The list's symbol/name are canonical when we have them.
        symbol: v?.symbol ?? symbol,
        name: v?.name ?? name,
        liquidityUsd,
        marketCapUsd,
        volumeH24Usd,
        verified: !!v,
        logoURI: v?.logoURI,
      }
    })
    .sort((a, b) => {
      // Verified first, then exact/prefix symbol match. WITHIN the verified
      // tier market cap ranks (two list-verified tokens sharing a symbol —
      // e.g. "Mog Coin" vs "Based Mog Coin" — differ by SIZE, and quote-pair
      // quirks make liquidity the weaker signal there); the unverified tail
      // stays liquidity-first (there, hub-quoted depth IS the anti-impostor
      // signal), with market cap breaking ties (e.g. all-zero). 24h volume is
      // the LAST tiebreak only — it's wash-tradeable, so it never outranks the
      // structural signals; it just splits genuine dead-heats.
      const dv = Number(b.verified) - Number(a.verified)
      if (dv !== 0) return dv
      const score = (h: TokenHit) =>
        h.symbol.toLowerCase() === ql ? 2 : h.symbol.toLowerCase().startsWith(ql) ? 1 : 0
      const ds = score(b) - score(a)
      if (ds !== 0) return ds
      if (a.verified && b.verified) {
        const dm = b.marketCapUsd - a.marketCapUsd
        if (dm !== 0) return dm
        const dl = b.liquidityUsd - a.liquidityUsd
        return dl !== 0 ? dl : b.volumeH24Usd - a.volumeH24Usd
      }
      const dl = b.liquidityUsd - a.liquidityUsd
      if (dl !== 0) return dl
      const dm = b.marketCapUsd - a.marketCapUsd
      return dm !== 0 ? dm : b.volumeH24Usd - a.volumeH24Usd
    })
    .slice(0, 8)
}
