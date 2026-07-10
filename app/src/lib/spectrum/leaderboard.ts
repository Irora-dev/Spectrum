import type { BasketSummary } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// Chain-derived leaderboard aggregation — the base truth for the /creators page.
//
// Everything here is computed from the public basket list (useAllBaskets), so the
// showcase works with NO database: creators + baskets rank by combined TVL and
// on-chain 24h movement, versions/series come from the signed `supersededBy`
// links, and identity/thesis resolve per-row through the existing verified path
// (CreatorChip / useCreatorMeta). Multi-period returns/volume/fees would need an
// external indexer this DB-less kit does not run; the page shows the on-chain
// windows it can compute and omits the rest.
//
// Ranking default = TVL / activity (plan §9: activity-first, compliance-friendlier;
// performance-window sorts are user-selected and DB-backed).
// ─────────────────────────────────────────────────────────────────────────────

/** Count version SERIES among one creator's baskets: connected components of size
 *  ≥2 over the `supersededBy` links (old→new), restricted to this creator's own
 *  baskets so a spoofed different-deployer claim never merges a chain (§F2). Pure;
 *  union-find over lowercased addresses (N = one creator's basket count — tiny). */
export function countVersionSeries(mine: BasketSummary[]): number {
  const inSet = new Set(mine.map((b) => b.address.toLowerCase()))
  const parent = new Map<string, string>()
  mine.forEach((b) => parent.set(b.address.toLowerCase(), b.address.toLowerCase()))
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r) as string
    return r
  }
  for (const b of mine) {
    const succ = b.supersededBy?.toLowerCase()
    if (succ && inSet.has(succ)) {
      const ra = find(b.address.toLowerCase())
      const rb = find(succ)
      if (ra !== rb) parent.set(ra, rb)
    }
  }
  const size = new Map<string, number>()
  for (const b of mine) {
    const r = find(b.address.toLowerCase())
    size.set(r, (size.get(r) ?? 0) + 1)
  }
  let n = 0
  for (const s of size.values()) if (s >= 2) n++
  return n
}

/** Performance-to-date of a basket as a fraction (0.083 = +8.3%). Baskets launch
 *  at ~$1.00 NAV by convention (plan §4/App C: startSqrtPriceX96 chosen for it), so
 *  NAV−1 is a chain-only "since launch" proxy. It is a FACT (current NAV vs the
 *  launch convention), not a projection — always shown with a past-performance
 *  disclaimer, and superseded by the DB's inception-anchored return when present. */
export function perfToDate(b: BasketSummary): number {
  return (b.navPerToken || 0) - 1
}

/**
 * Perf-to-date is only a MEANINGFUL claim above a real TVL: a near-empty basket's
 * NAV is fee residue over ~zero supply (the dust-basket amplification — a $0.40
 * pool can show "+40,000%"), which is arithmetic, not performance. Below this
 * floor the UI shows no perf/money claims and the perf ranking sinks the basket
 * (owner catch 2026-07-06 on live data; compliance §9 — never publish a
 * misleading figure).
 */
export const MEASURABLE_TVL_FLOOR_USD = 1_000
export function perfMeasurable(b: BasketSummary): boolean {
  return (b.aumUsd || 0) >= MEASURABLE_TVL_FLOOR_USD
}

/**
 * The LISTING floor (R+C 2026-07-06 18:26, both settled on $100): baskets under
 * it are hidden from every browsing surface — their price action is seed-size
 * noise — but stay fully reachable through search ("if you search for them,
 * you can find them"). Distinct from the $1k measurability floor, which only
 * gates perf/money CLAIMS on baskets that are listed.
 */
export const LISTING_TVL_FLOOR_USD = 100
export function listable(b: BasketSummary): boolean {
  return (b.aumUsd || 0) >= LISTING_TVL_FLOOR_USD
}

/**
 * The ordered version chain (V1→Vn) a basket belongs to, within one creator's
 * baskets — following the signed `supersededBy` links both directions. Returns
 * `[basket]` when standalone, `[]` when the basket isn't in the set. Cycle-guarded.
 */
export function versionChain(basketAddr: string, mine: BasketSummary[]): BasketSummary[] {
  const byAddr = new Map(mine.map((b) => [b.address.toLowerCase(), b] as const))
  const start = basketAddr.toLowerCase()
  if (!byAddr.has(start)) return []
  const succOf = new Map<string, string>() // old → new
  const predOf = new Map<string, string>() // new → old
  for (const b of mine) {
    const s = b.supersededBy?.toLowerCase()
    if (s && byAddr.has(s)) {
      succOf.set(b.address.toLowerCase(), s)
      predOf.set(s, b.address.toLowerCase())
    }
  }
  let root = start
  const seenBack = new Set<string>()
  while (predOf.has(root) && !seenBack.has(root)) {
    seenBack.add(root)
    root = predOf.get(root) as string
  }
  const chain: BasketSummary[] = []
  const seenFwd = new Set<string>()
  let cur: string | undefined = root
  while (cur && byAddr.has(cur) && !seenFwd.has(cur)) {
    seenFwd.add(cur)
    chain.push(byAddr.get(cur) as BasketSummary)
    cur = succOf.get(cur)
  }
  return chain
}

/** One ranked creator entity = a deployer wallet + its live baskets and stats. */
export interface CreatorEntry {
  /** Deployer address (as stored on-chain — used for the /creator/:address link). */
  address: string
  /** Current (non-superseded) baskets, largest first. */
  baskets: BasketSummary[]
  /** The creator's largest current basket — the identity + accent + thesis source. */
  topBasket: BasketSummary
  /** The creator's BEST-performing current basket (highest NAV-to-date) — the spotlight. */
  bestBasket: BasketSummary
  /** The best basket's full version chain (V1→Vn, incl. superseded). */
  bestVersionChain: BasketSummary[]
  /** Count of current (non-superseded) baskets. */
  basketCount: number
  /** Count of all versions incl. superseded. */
  totalVersions: number
  /** Count of maintained version chains (≥2 linked versions, same deployer). */
  seriesCount: number
  /** Σ current-basket AUM. */
  combinedTvl: number
  /** Σ holders across current baskets, or null when holder data isn't indexed
   *  (the shipped chain path has none — needs the operator DB/indexer). */
  holdersTotal: number | null
  /** Best 24h change across current baskets, or null when none is priced. */
  best24hPct: number | null
  /** Distinct chains with a current basket. */
  chains: number[]
}

/**
 * Group every basket by its on-chain deployer and rank the creators by combined
 * TVL. Creators whose baskets are all superseded (no live presence) are dropped.
 * `all` is expected AUM-sorted (useAllBaskets) so each creator's `baskets` and the
 * whole list inherit a sensible secondary order.
 */
export function buildCreatorLeaderboard(all: BasketSummary[]): CreatorEntry[] {
  const byDeployer = new Map<string, BasketSummary[]>()
  for (const b of all) {
    const d = b.deployer?.toLowerCase()
    if (!d) continue
    const arr = byDeployer.get(d)
    if (arr) arr.push(b)
    else byDeployer.set(d, [b])
  }

  const entries: CreatorEntry[] = []
  for (const mine of byDeployer.values()) {
    const current = mine.filter((b) => !b.supersededBy)
    if (current.length === 0) continue
    const combinedTvl = current.reduce((s, b) => s + (b.aumUsd || 0), 0)
    const holderVals = current.map((b) => b.holdersCount).filter((x): x is number => x != null)
    const holdersTotal = holderVals.length ? holderVals.reduce((s, n) => s + n, 0) : null
    const changes = current.map((b) => b.change24hPct).filter((x): x is number => x != null)
    const best24hPct = changes.length ? Math.max(...changes) : null
    const chains = Array.from(new Set(current.map((b) => b.chainId)))
    const topBasket = current.reduce((a, b) => ((b.aumUsd || 0) > (a.aumUsd || 0) ? b : a), current[0])
    // Best-performing = highest NAV-to-date among current baskets (tie → larger AUM).
    const bestBasket = current.reduce(
      (a, b) => (perfToDate(b) > perfToDate(a) || (perfToDate(b) === perfToDate(a) && (b.aumUsd || 0) > (a.aumUsd || 0)) ? b : a),
      current[0],
    )
    entries.push({
      address: (mine[0].deployer as string),
      baskets: [...current].sort((a, b) => (b.aumUsd || 0) - (a.aumUsd || 0)),
      topBasket,
      bestBasket,
      bestVersionChain: versionChain(bestBasket.address, mine),
      basketCount: current.length,
      totalVersions: mine.length,
      seriesCount: countVersionSeries(mine),
      combinedTvl,
      holdersTotal,
      best24hPct,
      chains,
    })
  }
  return entries.sort((a, b) => b.combinedTvl - a.combinedTvl)
}

export type BasketSort = 'tvl' | 'change' | 'perf' | 'weighted'
export type ChainFilter = number | 'all'

/** Rank baskets for the Baskets tab from chain facts: TVL (default), 24h change,
 *  performance-to-date (NAV vs the ~$1.00 launch — the "best performing" sort), or
 *  `weighted` — a performance-based list that still respects size (owner
 *  2026-07-06 12:34): the rank-sum of each basket's TVL rank and its
 *  perf-to-date rank. A factual blend of two disclosed facts, no magic scale
 *  constants; measurable baskets always outrank dust (§9). The perf leg
 *  upgrades to the DB's 7-day window once the snapshot indexer exists. */
export function rankBaskets(
  all: BasketSummary[],
  opts: { chain?: ChainFilter; minTvl?: number; currentOnly?: boolean; sort?: BasketSort; asset?: string | null } = {},
): BasketSummary[] {
  const { chain = 'all', minTvl = 0, currentOnly = true, sort = 'tvl', asset = null } = opts
  let list = all
  if (currentOnly) list = list.filter((b) => !b.supersededBy)
  if (chain !== 'all') list = list.filter((b) => b.chainId === chain)
  if (minTvl > 0) list = list.filter((b) => (b.aumUsd || 0) >= minTvl)
  if (asset) list = list.filter((b) => basketHasAsset(b, asset))
  if (sort === 'weighted') {
    const key = (x: BasketSummary) => `${x.chainId}:${x.address.toLowerCase()}`
    const score = new Map<string, number>()
    ;[...list].sort((a, b) => (b.aumUsd || 0) - (a.aumUsd || 0)).forEach((b, i) => score.set(key(b), i))
    ;[...list].sort((a, b) => perfToDate(b) - perfToDate(a)).forEach((b, i) => score.set(key(b), (score.get(key(b)) ?? 0) + i))
    return [...list].sort((a, b) => {
      const ma = perfMeasurable(a) ? 1 : 0
      const mb = perfMeasurable(b) ? 1 : 0
      if (ma !== mb) return mb - ma // dust sinks regardless of its arithmetic "perf"
      return (score.get(key(a)) ?? 0) - (score.get(key(b)) ?? 0) || (b.aumUsd || 0) - (a.aumUsd || 0)
    })
  }
  return [...list].sort((a, b) => {
    if (sort === 'change') return (b.change24hPct ?? -Infinity) - (a.change24hPct ?? -Infinity)
    if (sort === 'perf') {
      // sub-floor baskets sink: their perf figure is dust arithmetic, and the
      // spotlight/top slots must never be won by it
      const ma = perfMeasurable(a) ? 1 : 0
      const mb = perfMeasurable(b) ? 1 : 0
      if (ma !== mb) return mb - ma
      return (ma ? perfToDate(b) - perfToDate(a) : (b.aumUsd || 0) - (a.aumUsd || 0))
    }
    return (b.aumUsd || 0) - (a.aumUsd || 0)
  })
}

/** One asset that appears in some basket on the page (for the icon filter row). */
export interface AssetRef {
  address: string
  symbol: string
  chainId: number
  /** How many baskets on the page hold it (drives ordering — most common first). */
  count: number
}

/** True when a basket holds the given asset (lowercased address match) among its
 *  surfaced holdings (`top`). */
export function basketHasAsset(b: BasketSummary, assetAddr: string): boolean {
  const a = assetAddr.toLowerCase()
  return b.top.some((t) => t.address.toLowerCase() === a)
}

/** Distinct assets across the given baskets, most-held first — the clickable filter
 *  row. Keyed by lowercased address (a token shared across chains collapses to one
 *  chip carrying its first-seen chainId, which is only used for the logo source). */
export function collectAssets(baskets: BasketSummary[]): AssetRef[] {
  const byAddr = new Map<string, AssetRef>()
  for (const b of baskets) {
    for (const t of b.top) {
      const key = t.address.toLowerCase()
      const cur = byAddr.get(key)
      if (cur) cur.count += 1
      else byAddr.set(key, { address: t.address, symbol: t.symbol, chainId: b.chainId, count: 1 })
    }
  }
  return [...byAddr.values()].sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
}
