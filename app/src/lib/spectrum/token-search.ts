import { stocksForChain } from '../chain/stocks'
import { chainCfg } from '../chain/chains'
import { cacheGet, cacheSet } from './persist-cache'
import { normalizeLogo, verifiedTokens, type ListedToken } from './token-list'
import { PRISM_V2_HOOK } from '../prism/claim'
import { isAddress } from 'viem'
import { describeTokens } from './token-discovery'

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
  /** HOUSE-CURATED identity (owner 2026-08-15: "when you type prism into the
   *  portfolio add or reweight it should always show THIS prism first"): the
   *  app's own load-bearing address for a name the user typed. Outranks even
   *  the verified tier in every sort — a house pin exists only when the query
   *  matched its own name terms, so it can never hijack unrelated searches. */
  housePinned?: boolean
}

/** The app's own load-bearing identities, pinned FIRST when the user types
 *  their name — by ADDRESS from the app's own constants (the same doctrine as
 *  the curated stock registry on Blockscout rows: identity from our registry,
 *  never from what an indexer ranks). Per chain; match is prefix-both-ways at
 *  ≥3 chars so "pri", "prism", "prism v2" all pin and "p" alone does not. */
const HOUSE_CURATED: Record<number, { token: ListedToken; match: (ql: string) => boolean }[]> = {
  1: [
    {
      token: { address: PRISM_V2_HOOK, symbol: 'PRISM', name: 'Prism', decimals: 18, chainId: 1 },
      match: (ql) => ql.length >= 3 && ('prism'.startsWith(ql) || ql.startsWith('prism')),
    },
  ],
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
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
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

/** Whole-result cache TTL: short enough to stay fresh, long enough that
 *  retyping and the second surface (mode add bar vs flow picker) reuse the
 *  answer instead of multiplying rate-limited calls. */
const SEARCH_TTL_MS = 60_000

export async function searchTokens(
  query: string,
  chainId: number,
  signal?: AbortSignal,
): Promise<TokenHit[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const cfg = chainCfg(chainId)
  const ql = q.toLowerCase()
  const cacheKey = `toksearch:v1:${chainId}:${ql}`
  const cached = cacheGet<TokenHit[]>(cacheKey)
  if (cached) return cached
  // ── A PASTED ADDRESS RESOLVES DIRECTLY (owner 2026-08-15, live: LNOC pasted
  // into the portfolio add bar answered "no routable market found" while its
  // V3 pool held real liquidity — every text rung filters on symbol/name
  // CONTAINING the query, which a hex string can never satisfy; the launch
  // picker special-cases pastes, these searches did not). The chain's own
  // contract is the identity source; depth enrichment is best-effort — the
  // add-time probe (findBestPool) stays the routability judge, as everywhere.
  if (isAddress(q, { strict: false })) {
    try {
      const [desc] = await describeTokens(chainId, [q])
      if (!desc) return [] // no code / not an ERC-20 on THIS chain — other chains may still answer
      // no depth enrichment here: the paste IS the identity claim, and the
      // add-time probe (findBestPool) stays the routability judge — a figure
      // of 0 shows honestly as no-figure rather than blocking the row
      const hit: TokenHit = {
        address: q,
        symbol: desc.symbol,
        name: desc.symbol,
        liquidityUsd: 0,
        marketCapUsd: 0,
        volumeH24Usd: 0,
        verified: false,
      }
      cacheSet(cacheKey, [hit], SEARCH_TTL_MS)
      return [hit]
    } catch {
      return []
    }
  }
  const slug = cfg.dexscreenerSlug // 'base' | 'ethereum' — matches DexScreener chainId
  // The chain's own BLOCKSCOUT knows EVERY token on the chain — the rung for
  // chains DexScreener doesn't index, and the ZERO-HIT FALLBACK where it does
  // (owner report 2026-07-29: typing "Pons" found nothing while PONS sat there
  // with 21k holders — and again 2026-08-03, because the no-slug premise had
  // gone stale after DexScreener started indexing Robinhood). Ranked by
  // Blockscout's own order (holders); depth stays the builder's job
  // downstream (findBestPool is the routability judge).
  const searchBlockscout = async (): Promise<TokenHit[]> => {
    if (!cfg.explorer.includes('blockscout')) return []
    try {
      const r = await fetch(`${cfg.explorer}/api/v2/tokens?q=${encodeURIComponent(q)}`, {
        signal,
        headers: { Accept: 'application/json' },
      })
      if (!r.ok) return []
      const j = (await r.json()) as {
        items?: { address_hash?: string; address?: string; symbol?: string | null; name?: string | null; type?: string; icon_url?: string | null; circulating_market_cap?: string | null }[]
      }
      // The explorer orders by HOLDER COUNT, which a dust airdrop buys — so an
      // impostor "USDG" could outrank the real one (redteam 2026-07-29 F-3).
      // Three defences: the app's OWN curated registry wins identity (a curated
      // match is the canonical address, marked verified and sorted first), the
      // same relevance gate the DexScreener rung applies, and hygiene on every
      // attacker-controlled string (https-only icons, length caps — H-1/H-2).
      const curated = new Map(
        stocksForChain(chainId).map((st) => [st.address.toLowerCase(), st.symbol.toUpperCase()]),
      )
      const rows = (j.items ?? [])
        .filter((t) => (t.type ?? 'ERC-20') === 'ERC-20' && (t.address_hash || t.address) && t.symbol)
        .map((t) => {
          const address = (t.address_hash || t.address) as string
          const symbol = (t.symbol as string).slice(0, 24)
          const name = (t.name ?? (t.symbol as string)).slice(0, 64)
          return {
            address,
            symbol,
            name,
            liquidityUsd: 0,
            marketCapUsd: t.circulating_market_cap ? Number(t.circulating_market_cap) || 0 : 0,
            volumeH24Usd: 0,
            // "verified" here means EXACTLY one thing: this address is in the
            // app's own curated registry for the chain. Never the explorer's word.
            verified: curated.get(address.toLowerCase()) === symbol.toUpperCase(),
            logoURI: normalizeLogo(t.icon_url ?? undefined),
          }
        })
        // relevance: the explorer's fuzzy match is not a mandate
        .filter((t) => t.symbol.toLowerCase().includes(ql) || t.name.toLowerCase().includes(ql))
      // curated identity first; the rest keep the explorer's order
      return [...rows.filter((t) => t.verified), ...rows.filter((t) => !t.verified)].slice(0, 6)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      return []
    }
  }
  if (!slug) {
    const bs = await searchBlockscout()
    cacheSet(cacheKey, bs, SEARCH_TTL_MS)
    return bs
  }
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

  // House-curated identities join the verified set (and get pinned first in the
  // sort below): injected-if-absent exactly like verified matches, so a depth
  // endpoint missing them can never hide them.
  const housePinnedAddrs = new Set<string>()
  for (const c of HOUSE_CURATED[chainId] ?? []) {
    if (!c.match(ql)) continue
    const key = c.token.address.toLowerCase()
    housePinnedAddrs.add(key)
    if (!verifiedByAddr.has(key)) {
      verifiedMatches.push(c.token)
      verifiedByAddr.set(key, c.token)
    }
  }

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

  // Zero hits on an indexed chain → the Blockscout rung still knows every
  // token on the chain (untraded/unindexed long tail); better a hit without
  // depth figures than a silent nothing. The on-chain probe stays the
  // eligibility authority at add time.
  if (pool.length === 0) {
    const bs = await searchBlockscout()
    cacheSet(cacheKey, bs, SEARCH_TTL_MS)
    return bs
  }

  const ranked = pool
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
        housePinned: housePinnedAddrs.has(address.toLowerCase()) || undefined,
      }
    })
    .sort((a, b) => {
      // House-curated identity outranks everything — see HOUSE_CURATED.
      const dp = Number(!!b.housePinned) - Number(!!a.housePinned)
      if (dp !== 0) return dp
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
  cacheSet(cacheKey, ranked, SEARCH_TTL_MS)
  return ranked
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-CHAIN MERGE (owner 2026-08-03 ~10:3x: "why can't I find PONS on
// Robinhood in the suggestions? ensure the highest mcap on the most relevant
// chain appears first"). The old merge deduped same-symbol listings by
// measured ETH-quoted liquidity — but some chains' pairs (Robinhood) measure
// 0 there, so ANY same-ticker listing elsewhere silently hid the real one.
//
// The law, one home for both search surfaces (the flow picker + the mode's
// add bar):
//   · within one SYMBOL: verified identity wins outright; otherwise the
//     highest REPORTED MARKET CAP wins its symbol — that is what puts the
//     canonical token's home chain first — with real (quote-side) liquidity
//     and then volume as tiebreaks;
//   · across rows: an EXACT symbol match pins above everything, then
//     verified, then market cap, then real liquidity, then volume.
// Reported mcap is manipulable, so real liquidity stays the tiebreak and the
// add-time on-chain probe stays the final authority; the suggestion row also
// always shows its chain, so the pick stays verifiable.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainHit {
  h: TokenHit
  chainId: number
}

/** Reported mcap counts ONLY when real (quote-side) liquidity corroborates
 *  it. Found live within the hour of the first mcap-primary cut: an ETH
 *  "Pons" pair claiming $14M liquidity and $28.5M mcap off 0.0003 WETH of
 *  actual reserve — reported numbers are self-priced, the quote reserve is
 *  not. Below the floor a mcap claim scores zero and real liquidity (then
 *  raw mcap, for depthless rungs like Blockscout rows) decides. */
const CREDIBLE_LIQ_FLOOR_USD = 5_000
const credibleMcap = (h: TokenHit) => (h.liquidityUsd >= CREDIBLE_LIQ_FLOOR_USD ? h.marketCapUsd : 0)
/** Dust reserves don't count as depth: $0.58 of real WETH must not outrank a
 *  listing whose rung reports no figure at all (Blockscout rows carry 0). */
const DUST_LIQ_FLOOR_USD = 100
const meaningfulLiq = (h: TokenHit) => (h.liquidityUsd >= DUST_LIQ_FLOOR_USD ? h.liquidityUsd : 0)

export function mergeCrossChainHits(rows: ChainHit[], query: string, limit: number): ChainHit[] {
  const q = query.trim().toUpperCase()
  const better = (a: ChainHit, b: ChainHit): boolean => {
    // A house-curated identity wins its symbol outright (see HOUSE_CURATED) —
    // a fatter same-ticker listing on another chain must not displace it.
    if (!!a.h.housePinned !== !!b.h.housePinned) return !!a.h.housePinned
    if (a.h.verified !== b.h.verified) return a.h.verified
    const ca = credibleMcap(a.h)
    const cb = credibleMcap(b.h)
    if (ca !== cb) return ca > cb
    const la = meaningfulLiq(a.h)
    const lb = meaningfulLiq(b.h)
    if (la !== lb) return la > lb
    if (a.h.marketCapUsd !== b.h.marketCapUsd) return a.h.marketCapUsd > b.h.marketCapUsd
    return a.h.volumeH24Usd > b.h.volumeH24Usd
  }
  const bySym = new Map<string, ChainHit>()
  for (const row of rows) {
    const k = row.h.symbol.toUpperCase()
    const prev = bySym.get(k)
    if (!prev || better(row, prev)) bySym.set(k, row)
  }
  return [...bySym.values()]
    .sort((a, b) => {
      // House pin above even the exact-symbol row: the pin only exists when
      // the user's query matched its own name terms, so this is "the thing
      // they typed", not a hijack.
      const dp = Number(!!b.h.housePinned) - Number(!!a.h.housePinned)
      if (dp !== 0) return dp
      const ax = a.h.symbol.toUpperCase() === q ? 1 : 0
      const bx = b.h.symbol.toUpperCase() === q ? 1 : 0
      if (ax !== bx) return bx - ax
      if (a.h.verified !== b.h.verified) return a.h.verified ? -1 : 1
      const cm = credibleMcap(b.h) - credibleMcap(a.h)
      if (cm !== 0) return cm
      const dl = meaningfulLiq(b.h) - meaningfulLiq(a.h)
      if (dl !== 0) return dl
      if (a.h.marketCapUsd !== b.h.marketCapUsd) return b.h.marketCapUsd - a.h.marketCapUsd
      return b.h.volumeH24Usd - a.h.volumeH24Usd
    })
    .slice(0, limit)
}
