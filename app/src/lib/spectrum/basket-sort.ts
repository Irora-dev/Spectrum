import { cacheGet } from './persist-cache'
import { MEASURABLE_TVL_FLOOR_USD } from './leaderboard'

// ─────────────────────────────────────────────────────────────────────────────
// EXPLORE'S ORDER — the three questions people actually rank baskets by
// (QOL round 2026-08-05).
//
// Filters narrowed the catalogue but nothing could ORDER it: value, holders and
// age were all on the cards and none of them was sortable, so "which is the
// biggest" meant reading every card. This module is the ordering (plus the one
// figure-threshold filter that shares its honesty laws — the TVL minimum,
// the owner 2026-08-13); the page's own ranking (leaderboard.ts rankBaskets) stays
// the DEFAULT option and is never replaced — 'top' hands the ranked list
// straight back.
//
// TWO LAWS, both the honesty rule in a different coat:
//  1. UNKNOWN IS NOT ZERO. A basket with no holder count is not a basket with no
//     holders, so it sorts to the END of the list instead of to the bottom of the
//     numbers. A known 0 is a fact and sorts among the facts.
//  2. THE DEFAULT RANKING IS THE TIE-BREAK. Comparators return 0 for equal
//     values and Array.prototype.sort has been stable since ES2019, so ties (and
//     the whole unknown tail) keep the order the page ranked them in — never a
//     random reshuffle between renders.
// ─────────────────────────────────────────────────────────────────────────────

/** What Explore can order by. 'top' = the page's own ranking, untouched. */
export type BasketOrder = 'top' | 'returns' | 'tvl' | 'holders' | 'newest'

/** The pills, in the order they render. Plain words, no jargon (house rule) —
 *  and "Top" is deliberately the same word the lens tab uses for the ranking it
 *  hands over. `title` states the window a figure-bearing order runs on, so
 *  the pill never claims more than the number underneath it. */
export const BASKET_ORDERS: readonly { id: BasketOrder; label: string; title?: string }[] = [
  { id: 'top', label: 'Top' },
  {
    id: 'returns',
    label: 'Returns',
    title:
      'Best since-launch returns first — current NAV against the ~$1.00 launch, the same % to date the cards show. Baskets under $1,000 TVL or without a readable NAV go last.',
  },
  { id: 'tvl', label: 'Value' },
  { id: 'holders', label: 'Holders' },
  { id: 'newest', label: 'Newest' },
]

/** The order ids, for validating a remembered or linked value (view-prefs.ts). */
export const BASKET_ORDER_IDS: readonly BasketOrder[] = BASKET_ORDERS.map((o) => o.id)

/** Only the fields the cards already carry. Everything optional-and-nullable
 *  because the chain path genuinely leaves holder counts absent. */
export interface SortableBasket {
  chainId: number
  address: string
  aumUsd?: number | null
  holdersCount?: number | null
  navPerToken?: number | null
}

/** A real number, or null for "we do not know". NaN and Infinity are not
 *  knowledge — they are what a failed read looks like after arithmetic. */
function known(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** Biggest first, unknown last, ties keep their incoming order. */
function byDesc<T>(list: readonly T[], valueOf: (x: T) => number | null): T[] {
  return [...list].sort((a, b) => {
    const va = valueOf(a)
    const vb = valueOf(b)
    if (va == null) return vb == null ? 0 : 1
    if (vb == null) return -1
    return vb - va
  })
}

// ── the returns order (the owner 2026-08-13: "add baskets order by top returns") ─
// The window is SINCE LAUNCH: a basket launches at ~$1.00 NAV by convention
// (leaderboard.ts perfToDate — the exact figure every card already shows as
// "% to date"), so NAV−1 is the one return this DB-less kit can always state.
// A 24h field exists too (change24hPct) but the ruling asked for one returns
// order, and since-launch is the page's own headline number.
//
// Two honesty gates, both older rulings applied to a new order:
//  · THE MEASURABLE FLOOR: under $1,000 TVL a NAV figure is fee residue over
//    ~zero supply, not performance — the $0.40 pool that showed "+40,000%"
//    (owner catch 2026-07-06; compliance §9). rankBaskets' perf sort already
//    sinks those baskets; an explicit Returns order must too, or the top slot
//    is won by arithmetic. No figure ⇒ null ⇒ the end of the list.
//  · UNREADABLE ≠ ZERO (law 1 above): a NAV that is absent, non-finite or
//    ≤0 against measurable TVL is a broken read, and ranking it as −100%
//    would state a loss nobody measured. Null, end of list.

/** Since-launch return as a fraction (0.083 = +8.3%), or null when the basket
 *  has no honest figure (dust TVL, or an unreadable NAV). */
export function returnsToDate(b: SortableBasket): number | null {
  const aum = known(b.aumUsd)
  if (aum == null || aum < MEASURABLE_TVL_FLOOR_USD) return null
  const nav = known(b.navPerToken)
  if (nav == null || nav <= 0) return null
  return nav - 1
}

/** Is a Returns order MEANINGFUL for this list? Two honest figures is the
 *  floor, exactly as hasLaunchTimes holds for Newest: one (or none) cannot
 *  express an order, and a pill that changes nothing is a lie about what the
 *  site knows. The pages hide the option on false. */
export function hasReturns(list: readonly SortableBasket[], min = 2): boolean {
  let n = 0
  for (const b of list) {
    if (returnsToDate(b) != null && ++n >= min) return true
  }
  return false
}

// ── the TVL threshold filter (the owner 2026-08-13: "a filter for total tvl") ────
// A minimum on the basket's measured TVL — the same aumUsd figure the cards
// state. The candidate rungs are fixed; which rungs a page OFFERS is a fact
// about its catalogue, read per render:
//  · SATISFIABLE — at least one basket clears the rung, so picking it can
//    never empty the grid (the chain-chip law: no option filters to nothing),
//  · DISCRIMINATING — at least one basket does NOT clear it, so the rung
//    actually filters (a threshold every basket clears is "Any" in a costume).
// Catalogues span $10 shelves to $M books, so a fixed offered list would be
// all-or-nothing somewhere; deriving from the spread is what keeps the steps
// real on every operator's site.
//
// UNREADABLE TVL IS EXCLUDED by any threshold — a basket that cannot state
// its value cannot prove it clears a minimum — but INCLUDED under Any (0),
// which filters nothing. The controls say so where they offer the steps.

/** The candidate rungs, smallest first. */
export const TVL_LADDER: readonly number[] = [100, 1_000, 10_000, 100_000, 1_000_000]

/** The rungs worth offering for this catalogue (see the laws above). */
export function tvlStepsFor(list: readonly SortableBasket[]): number[] {
  return TVL_LADDER.filter((min) => {
    let clears = false
    let misses = false
    for (const b of list) {
      const v = known(b.aumUsd)
      if (v != null && v >= min) clears = true
      else misses = true // unreadable counts as a miss: the threshold would exclude it
      if (clears && misses) break
    }
    return clears && misses
  })
}

/** A rung's label, shared by every surface that offers it so two controls
 *  cannot spell one threshold differently. COMPACT ($100k+, $1M+) on purpose,
 *  twice over: a rung is a control option, not a money reading — so it sits
 *  outside the grouped-figures law (which governs stated readings) and outside
 *  formatUsdCompact's privacy mask (masked options would all say the same
 *  thing) — and the compact form is what keeps an ACTIVE rung inside
 *  Explore's one-row band (the 2026-08-12 ruling; the grouped spelling
 *  measurably wrapped it at 1440). Surfaces put the full grouped figure in
 *  the chip's title/aria, so nothing is hidden — just abbreviated. */
export function tvlStepLabel(min: number): string {
  if (min >= 1_000_000) return `$${min / 1_000_000}M+`
  if (min >= 1_000) return `$${min / 1_000}k+`
  return `$${min}+`
}

/** The full grouped figure for a rung's title/aria — the compact label's
 *  honest long form, stated once so the two can never drift. */
export function tvlStepTitle(min: number): string {
  return `at least $${min.toLocaleString('en-US')} TVL`
}

/** The list at or above the threshold; `min` ≤ 0 is "Any" and keeps everything,
 *  unreadable TVL included. Always a copy, never the caller's array. */
export function filterByMinTvl<T extends SortableBasket>(list: readonly T[], min: number): T[] {
  if (!(min > 0)) return [...list]
  return list.filter((b) => {
    const v = known(b.aumUsd)
    return v != null && v >= min
  })
}

/**
 * Order a ranked list by one of the pills. `ageOf` supplies the creation time
 * (unix seconds) per basket and may return null for any basket whose launch is
 * unknown — BasketSummary carries no inception field, so the age axis is only
 * offered when a lookup can actually answer for the page (see launchTimeLookup).
 */
export function orderBaskets<T extends SortableBasket>(
  list: readonly T[],
  order: BasketOrder,
  ageOf?: (basket: T) => number | null,
): T[] {
  if (order === 'returns') return byDesc(list, returnsToDate)
  if (order === 'tvl') return byDesc(list, (b) => known(b.aumUsd))
  if (order === 'holders') return byDesc(list, (b) => known(b.holdersCount))
  if (order === 'newest') return byDesc(list, (b) => (ageOf ? known(ageOf(b)) : null))
  return [...list] // 'top' — the page's ranking, handed back untouched
}

// ── where "newest" comes from ────────────────────────────────────────────────
// BasketSummary carries no creation timestamp: the list path builds summaries
// without `{ inception: true }`, so nothing on a card knows its own launch date.
// What DOES exist is the per-chain LAUNCH INDEX basket-data.ts builds from the
// factory's Launched events (one wide getLogs, persisted forever under the house
// cache namespace, topped up incrementally). Any basket page visit fills it for
// the WHOLE chain, so a browser that has been used at all already has this.
//
// So the age axis reads that index rather than deriving launch times a second
// way, and it reads it WITHOUT a network call: no query, no RPC, no per-card
// anything. Coupling is one key string and it fails safe in every direction —
// an absent, expired, stale or hostile blob yields no entries, which means "we do
// not know when these launched", which hides the pill (see hasLaunchTimes).
// Never a wrong order; at worst an unavailable one.
//
// If BasketSummary ever carries inceptionTs, delete this half and pass it
// straight to orderBaskets.

/** The persisted shape (basket-data.ts owns the writing). */
const LAUNCH_INDEX_KEY = (chainId: number) => `launch-index:v2:${chainId}`

/** Lowercased basket address → launch unix seconds. Hostile/foreign blobs, and
 *  entries that are not positive finite timestamps, are dropped rather than
 *  trusted: this feeds an ORDER people read as fact. */
export function parseLaunchIndex(raw: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (raw == null || typeof raw !== 'object') return out
  const entries = (raw as { entries?: unknown }).entries
  if (entries == null || typeof entries !== 'object' || Array.isArray(entries)) return out
  for (const [addr, ts] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof addr !== 'string' || !addr) continue
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue
    out.set(addr.toLowerCase(), ts)
  }
  return out
}

/**
 * An `ageOf` for orderBaskets, over the chains on the page. Built once per page
 * (the index only changes when a basket page runs a scan, never mid-visit), and
 * returns null for any basket the index has no entry for.
 */
export function launchTimeLookup(
  chainIds: readonly number[],
  read: (key: string) => unknown = (key) => cacheGet<unknown>(key),
): (basket: { chainId: number; address: string }) => number | null {
  const byChain = new Map<number, Map<string, number>>()
  for (const id of chainIds) byChain.set(id, parseLaunchIndex(read(LAUNCH_INDEX_KEY(id))))
  return (basket) => byChain.get(basket.chainId)?.get(basket.address.toLowerCase()) ?? null
}

/**
 * Is ordering by age MEANINGFUL for this list? Two known launch times is the
 * floor: one (or none) cannot express an order, and a "Newest" pill that changes
 * nothing is a lie about what the site knows. The page hides the pill on false.
 */
export function hasLaunchTimes<T extends { chainId: number; address: string }>(
  list: readonly T[],
  ageOf: (basket: T) => number | null,
  min = 2,
): boolean {
  let n = 0
  for (const b of list) {
    if (ageOf(b) != null && ++n >= min) return true
  }
  return false
}
