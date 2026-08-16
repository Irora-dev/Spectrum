// ─────────────────────────────────────────────────────────────────────────────
// THE SHARED HOP'S RESERVE — the last unmeasured term in the floor formula.
//
// BACKEND-FLOOR-DISCIPLINE rule 3: the backend quotes every leg against ONE
// pre-batch chain state, but the legs execute SEQUENTIALLY and typically share
// a hop (funding→WETH is shared by essentially every leg of a stable-funded
// portfolio). Each leg moves that hop against the next, so
//
//     self_impact_i ≈ 1 − 1 / (1 + V_before_i / R_hop)²
//
// and `R_hop` — that hop's FUNDING-SIDE reserve — is the input. Their measured
// consequence: 32 legs over a $50k shared hop cost the last leg 2,968 bps
// against its own quote. On Base/Ethereum USDC/WETH the hop is deep enough
// that the term tends to zero; on Robinhood 4663 a $50k–$250k hop is entirely
// plausible and the term is 700–3,000 bps. **Which is why this is measured per
// chain and never assumed per chain.**
//
// WHY THE FUNDING SIDE, AND WHY THAT MAKES IT EXACT: the impact a swap has on a
// constant-product pool is a function of the reserve it pays INTO. Our funding
// asset is the chain's dollar stable (USDC/USDG), so the funding-side reserve
// AMOUNT already is its USD value — no price read, no second oracle, no
// conversion to get wrong. `liquidity.usd` (both sides) would need halving,
// which is an approximation this does not have to make.
//
// A FAILED READ RETURNS NULL, AND NULL REFUSES EVERY LEG (deriveLegFloors'
// 'unreadable-hop-reserve'). That is deliberate and it is the whole point: an
// unmeasured hop is not a deep hop. This module must never answer 0 or a
// fallback constant — either would silently hand back the flattering answer.
//
// COST: one DexScreener read per chain per compose, cached — the same keyless
// provider the market reads already use, so no new vendor, no key, and idle
// stays zero (nothing here runs on a timer).
// ─────────────────────────────────────────────────────────────────────────────

import { cacheGet, cacheSet } from './persist-cache'
import { showSymbol } from './safe-copy'

/** Five minutes: long enough that a compose does not re-read on every retry,
 *  short enough that a hop draining is seen within one session. Floors derived
 *  from a stale reserve are the loose direction, so this stays SHORT. */
export const HOP_RESERVE_TTL_MS = 5 * 60_000

/** DexScreener's pair shape, narrowed to what the reserve needs. `base`/`quote`
 *  are TOKEN AMOUNTS (not USD) — the field pair this module exists to read. */
export interface DexPairReserve {
  baseToken?: { address?: string; symbol?: string }
  quoteToken?: { address?: string; symbol?: string }
  liquidity?: { usd?: number; base?: number; quote?: number }
}

export interface HopReserveRead {
  /** The funding-side reserve, USD. */
  reserveUsd: number
  /** What the hop actually is, for the audit trail and the review sentence.
   *  BOUNDED AND INERT: this is a DexScreener-reported symbol, i.e. deployer-
   *  controlled text on a path that can reach shown copy — `showSymbol` is not
   *  decoration here (the hostile-string sweep's whole premise). */
  pair: string
  /** True when no funding↔WETH pair was found and the deepest funding pair of
   *  any kind stood in. Stated, never silent: the floor's self-impact term is
   *  then computed against a hop the batch may not literally share. */
  substituted: boolean
}

/**
 * Pick the pair that IS the shared hop, and read its funding-side reserve.
 *
 * Pure — the network lives in `readHopReserveUsd`. Returns null when no pair
 * can be read honestly, never a fallback number.
 */
export function pickHopReserve(
  pairs: readonly DexPairReserve[],
  funding: string,
  weth: string | null,
): HopReserveRead | null {
  const f = funding.toLowerCase()
  const w = weth?.toLowerCase() ?? null
  type Cand = { read: HopReserveRead; usd: number }
  const cands: Cand[] = []

  for (const p of Array.isArray(pairs) ? pairs : []) {
    const base = p.baseToken?.address?.toLowerCase()
    const quote = p.quoteToken?.address?.toLowerCase()
    if (!base || !quote) continue
    // the funding asset must be ONE SIDE of this pair — otherwise its reserve
    // is not the reserve our swaps pay into
    const fundingIsBase = base === f
    const fundingIsQuote = quote === f
    if (!fundingIsBase && !fundingIsQuote) continue

    const amount = fundingIsBase ? p.liquidity?.base : p.liquidity?.quote
    // A FAILED READ IS NOT A SMALL RESERVE: a missing or non-finite side
    // amount drops the candidate rather than counting as zero depth (which
    // would refuse honest legs) or being coerced to something plausible.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) continue

    const other = fundingIsBase ? p.quoteToken : p.baseToken
    const otherAddr = fundingIsBase ? quote : base
    const isWeth = w != null && otherAddr === w
    const usd = typeof p.liquidity?.usd === 'number' && Number.isFinite(p.liquidity.usd) ? p.liquidity.usd : 0

    cands.push({
      read: {
        // the funding asset is the chain's dollar stable, so the amount IS the
        // USD figure — stated in the header, no price read involved
        reserveUsd: amount,
        pair: showSymbol(other?.symbol ?? otherAddr.slice(0, 8)),
        substituted: !isWeth,
      },
      usd,
    })
  }
  if (cands.length === 0) return null

  // PREFER THE REAL HOP: the deepest funding↔WETH pair, because that is the one
  // essentially every leg routes through. Only if none exists does the deepest
  // funding pair of any kind stand in — and it says so.
  const weths = cands.filter((c) => !c.read.substituted)
  const pool = weths.length > 0 ? weths : cands
  return pool.reduce((best, c) => (c.usd > best.usd ? c : best), pool[0]).read
}

/** The network seam, injected — the same pattern the quote client uses, so a
 *  test drives this without touching DexScreener and the module stays pure at
 *  its edges. */
export type DexPairsFetcher = (args: { slug: string; token: string }) => Promise<DexPairReserve[]>

/** The default fetcher: DexScreener's keyless token endpoint — already this
 *  app's market-data provider, so no new dependency enters on this path. */
export const dexPairsFetcher: DexPairsFetcher = async ({ slug, token }) => {
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${token}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`dexscreener ${res.status}`)
  const body = (await res.json()) as DexPairReserve[]
  return Array.isArray(body) ? body : []
}

/**
 * Measure the chain's shared-hop reserve. Null on ANY failure — unreadable,
 * unroutable, offline, or nonsense — because `deriveLegFloors` turns null into
 * a refusal of every leg, which is the correct fail-closed answer.
 */
export async function readHopReserveUsd(
  args: { chainId: number; slug: string; funding: string; weth: string | null },
  fetchPairs: DexPairsFetcher = dexPairsFetcher,
): Promise<HopReserveRead | null> {
  const key = `hop:v1:${args.chainId}:${args.funding.toLowerCase()}`
  const hit = cacheGet<HopReserveRead>(key)
  if (hit != null) return hit
  try {
    const read = pickHopReserve(await fetchPairs({ slug: args.slug, token: args.funding }), args.funding, args.weth)
    // only a real read is cached: caching null would freeze a transient
    // outage into a refusal for the whole TTL
    if (read != null) cacheSet(key, read, HOP_RESERVE_TTL_MS)
    return read
  } catch {
    return null
  }
}
