import type { BasketSummary } from './basket-data'
import type { ChainNeed } from './plan-shared-types'

// ─────────────────────────────────────────────────────────────────────────────
// A THESIS — one idea a creator shipped, which the chain forced into several
// baskets (the owner 2026-08-09: "a condensed cross-chain basket page where you can
// see a creator's multi-chain baskets they shipped via the create page in one
// flow that can be bought/sold in one flow" · "I don't think it needs to be
// communicated as multiple baskets. It should be: here's the thesis, across
// chains").
//
// WHY THIS EXISTS AND WHAT IT IS NOT. Nothing new is deployed and no contract
// changes. `compilePlan` already emits one `create:<chainId>` step per network,
// so picking assets across Base, Ethereum and Robinhood ships THREE ordinary
// baskets — correct, because a basket is single-chain by construction (one V2
// factory per chain). This module is the read side: it recognises those
// baskets as one product again, so the page can sell the idea rather than the
// plumbing.
//
// ⚠ THE GROUPING KEY IS (deployer, name), AND THAT IS A DELIBERATE CHOICE WITH
// A KNOWN LIMIT. `AllocationDraft.name` is documented as "the ONE product the
// user is creating" — it is per-draft, so every per-chain basket from one
// create session carries the same name and the same deployer. That makes the
// key real evidence rather than a guess.
//
// What it CANNOT do is distinguish two separate theses a creator deliberately
// gave the same name. It shows them as one. The alternative — a thesis id
// written at deploy — needs a contract or registry field that does not exist,
// so this is the honest key available today rather than the best key
// imaginable.
//
// ⚠ THE LAUNCH-TIME WINDOW IS GONE (2026-08-10). A `launchWindowMs` guard used
// to narrow the key — legs also had to have launched near each other — and on
// violation it `continue`d, DROPPING the whole bucket. That was survivable
// while a thesis could only be born whole (one create session, minutes apart),
// and it became a feature-killer the day JOINING shipped: a basket joins a
// thesis by shipping a renamed VERSION carrying the thesis's name (the reshape
// popup — names are immutable on-chain, so the rename IS the join), which is
// by definition a late arrival. Under the window that leg would not merely
// have failed to group — it would have KILLED its thesis from every surface
// (the strips, the pages, resolveThesis → 404), invisibly, months after the
// fact. The window's one payoff — keeping two same-name ideas months apart
// from merging — is cheap to recover by hand now renames are cheap (that same
// reshape system renames either side), and the thesis-url ambiguity path
// already handles the display half of a collision. So a deliberate join
// groups, a genuine collision is recoverable, and nothing is dropped.
// `launchWindowMs`/`launchedAt` stay accepted for API compat but are INERT —
// see GroupOptions.
// ─────────────────────────────────────────────────────────────────────────────

/** Baskets from one create session, recognised as one product again. */
export interface Thesis {
  /** The creator, lowercased. */
  deployer: string
  /** The shared name, as the creator typed it (first basket's spelling wins). */
  name: string
  /** Its baskets, one per chain, richest first. */
  legs: BasketSummary[]
  /** The chains it spans, in the legs' order. */
  chainIds: number[]
  /** Summed AUM across every leg — the thesis's own size. */
  totalAumUsd: number
}

/** The DISCOVERY floor (owner 2026-08-16: unseeded test shells — "$3.0000
 *  combined price" walls — were burying the homepage and Explore): a bundle
 *  earns a discovery surface only once real money sits in it. */
export const DISCOVERY_TVL_FLOOR_USD = 100

/** Whether a bundle may appear on a DISCOVERY surface (homepage, Explore).
 *  One predicate so the two surfaces cannot drift. An unseeded bundle reads
 *  as ~$0 AUM, so the one floor covers both of the owner's cases ("without
 *  seeding or with less than $100 of tvl").
 *
 *  ⚠ Discovery only. The bundle's own page, the creator page and the
 *  portfolio must keep showing it — those are ownership/direct surfaces, and
 *  a creator hidden from their own unseeded work could never seed it. */
export function thesisIsDiscoverable(t: Thesis): boolean {
  return Number.isFinite(t.totalAumUsd) && t.totalAumUsd >= DISCOVERY_TVL_FLOOR_USD
}

/** Two names are the same product when they differ only in case or spacing —
 *  a creator retyping "Bullish EVM" as "bullish evm" on the second chain is one
 *  idea, and a key that says otherwise splits a thesis in half on screen. */
function nameKey(name: string | null | undefined): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export interface GroupOptions {
  /** ⚠ INERT since 2026-08-10 — accepted for API compat, read by nothing.
   *  This used to bound how far apart two legs may have launched and still
   *  group (default 24h), and a violation dropped the whole bucket; the join
   *  flow made that a feature-killer (a joined leg is a legitimate late
   *  arrival — see the header). Advisory at most; do not build on it. */
  launchWindowMs?: number
  /** Ungrouped single-chain baskets are usually noise on a thesis surface, but
   *  a caller listing "everything they made" wants them. Default false. */
  includeSingles?: boolean
  /** ⚠ INERT since 2026-08-10, with `launchWindowMs` above. Kept so the
   *  callers that resolve launch times (the Creator and Thesis pages inject
   *  their `launchTimeLookup`) keep compiling and may keep passing it; the
   *  grouping itself no longer reads launch times at all. */
  launchedAt?: (b: BasketSummary) => number | null | undefined
}

/**
 * Group a creator's baskets into theses. Deterministic and pure — no network,
 * no wallet — so it is testable and safe to call in a render.
 *
 * Legs are sorted richest-first inside a thesis, and theses richest-first
 * overall, so the surface leads with the idea that carries the most money
 * rather than with whichever chain answered a read first.
 */
export function groupIntoTheses(baskets: readonly BasketSummary[], opts: GroupOptions = {}): Thesis[] {
  const buckets = new Map<string, BasketSummary[]>()

  for (const b of baskets) {
    // a basket with no deployer cannot be attributed to anyone, and a nameless
    // one cannot be matched to a sibling — neither is evidence of a thesis
    if (!b.deployer) continue
    const nk = nameKey(b.name)
    if (!nk) continue
    const key = `${b.deployer.toLowerCase()}::${nk}`
    const list = buckets.get(key)
    if (list) list.push(b)
    else buckets.set(key, [b])
  }

  const out: Thesis[] = []
  for (const list of buckets.values()) {
    // ONE BASKET PER CHAIN. Two baskets on the SAME chain sharing a name are a
    // creator relaunching, not a wider thesis — keep the richer and drop the
    // other, or a thesis would double-count a chain's money in its total.
    const byChain = new Map<number, BasketSummary>()
    for (const b of [...list].sort((x, y) => y.aumUsd - x.aumUsd)) {
      if (!byChain.has(b.chainId)) byChain.set(b.chainId, b)
    }
    const legs = [...byChain.values()].sort((a, z) => z.aumUsd - a.aumUsd)
    if (legs.length < 2 && !opts.includeSingles) continue

    // NO launch-time check here, deliberately — a joined leg arrives months
    // late by design, and the old window did not skip the leg, it dropped the
    // whole thesis (see the header on why the window is gone).

    out.push({
      deployer: legs[0].deployer!.toLowerCase(),
      name: legs[0].name ?? '',
      legs,
      chainIds: legs.map((l) => l.chainId),
      totalAumUsd: legs.reduce((s, l) => s + (Number.isFinite(l.aumUsd) ? l.aumUsd : 0), 0),
    })
  }
  return out.sort((a, b) => b.totalAumUsd - a.totalAumUsd)
}

/**
 * What buying the WHOLE thesis costs on each chain, in integer cents — the
 * shape `buildFundingPlan` consumes, so the existing cross-chain planner does
 * the bridging and ordering rather than this module inventing a second one.
 *
 * The split is by each leg's share of the thesis's AUM: buying the idea means
 * buying it in the proportions the creator actually shipped, not equally per
 * chain. A thesis whose Base leg holds 80% of the money should take 80% of the
 * buyer's dollars.
 *
 * ⚠ IT REFUSES RATHER THAN GUESSING when the proportions cannot be read: a
 * thesis whose legs all report zero or unreadable AUM has no shippable split,
 * and dividing equally would be inventing the creator's intent. Returns null,
 * and the caller says so.
 *
 * SEED MODE (`seedShares`, owner 2026-08-12: the ceremonies' "Seed the bundle"
 * door): a JUST-published or JUST-reshaped version starts empty — zero AUM on
 * every leg — which the refusal above correctly rejects, because live AUM
 * carries no signal there. But the ceremony that shipped it still holds the
 * creator's own DEPLOY WEIGHTS, and those ARE the shipped intent. The optional
 * map (chainId → share, any positive unit) replaces the AUM weights outright;
 * everything downstream — the largest-remainder conservation, the zero-weight
 * exclusion, the refusal when no share is positive — is the same law. Absent,
 * behavior is byte-identical to before the parameter existed.
 */
export function thesisNeeds(
  thesis: Thesis,
  amountUsd: number,
  feeBps: number,
  seedShares?: ReadonlyMap<number, number>,
): ChainNeed[] | null {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null
  const weights = thesis.legs.map((l) => {
    if (seedShares) {
      const s = seedShares.get(l.chainId)
      return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 0
    }
    return Number.isFinite(l.aumUsd) && l.aumUsd > 0 ? l.aumUsd : 0
  })
  const total = weights.reduce((s, w) => s + w, 0)
  if (total <= 0) return null

  const grossCents = Math.round(amountUsd * 100)
  if (grossCents <= 0) return null

  // largest-remainder, so the cents sum EXACTLY to the amount — the same law
  // the batcher's own scaling obeys. A per-chain rounding drift is a chain
  // that quietly under-funds, which the conservation check would then refuse.
  const exact = weights.map((w) => (grossCents * w) / total)
  const floors = exact.map(Math.floor)
  let left = grossCents - floors.reduce((s, n) => s + n, 0)
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (left <= 0) break
    // a zero-weight leg never receives a remainder unit — it is not in the thesis
    if (weights[i] <= 0) continue
    floors[i] += 1
    left -= 1
  }

  return thesis.legs
    .map((leg, i) => ({
      chainId: leg.chainId,
      buysCents: floors[i],
      // the fee rides the buys, per the funding equation's inclusive regime
      feeCents: Math.floor((floors[i] * feeBps) / 10_000),
    }))
    .filter((n) => n.buysCents > 0)
}

// ── the combined READ figures (the owner 2026-08-10: the thesis surfaces need "a
// global chart that counts the total value across the underlying baskets and
// also the combined price") ──────────────────────────────────────────────────

/** The thesis's own value curve: every leg's NAV series scaled to that leg's
 *  REAL dollars and summed pointwise, so the curve ends exactly at the
 *  thesis's TVL. Aligned from the tail (the shortest series bounds the
 *  window) — the series are same-cadence spark histories, and the tail is the
 *  part they all agree on.
 *
 *  null unless EVERY leg carries a usable series and a positive AUM: a
 *  "total" drawn from two of three legs is a wrong number wearing a chart,
 *  and the caller shows nothing rather than that. */
export function thesisCombinedSeries(legs: readonly BasketSummary[]): { time: number; value: number }[] | null {
  if (legs.length === 0) return null
  const parts: { series: { time: number; value: number }[]; scale: number }[] = []
  for (const leg of legs) {
    const s = leg.navSeries
    if (!s || s.length < 2) return null
    const last = s[s.length - 1]?.value
    if (!Number.isFinite(leg.aumUsd) || leg.aumUsd <= 0 || !Number.isFinite(last) || last <= 0) return null
    parts.push({ series: s, scale: leg.aumUsd / last })
  }
  const len = Math.min(...parts.map((p) => p.series.length))
  const base = parts[0].series.slice(-len)
  return base.map((pt, i) => ({
    time: pt.time,
    value: parts.reduce((sum, p) => {
      const row = p.series[p.series.length - len + i]
      return sum + (Number.isFinite(row?.value) ? row.value * p.scale : 0)
    }, 0),
  }))
}

/** The combined price: what ONE TOKEN OF EACH leg costs, summed. The one
 *  per-unit figure that is honest across baskets with unrelated supplies —
 *  an average would weight nothing real. null when any leg's NAV is
 *  unreadable: a partial sum reads as a real price and is not one. */
export function thesisOneOfEach(legs: readonly BasketSummary[]): number | null {
  if (legs.length === 0) return null
  let sum = 0
  for (const leg of legs) {
    if (!Number.isFinite(leg.navPerToken) || leg.navPerToken <= 0) return null
    sum += leg.navPerToken
  }
  return sum
}

/** The composite bento: every leg's holdings on one canvas, each weighted by
 *  its share of its own basket AND that basket's share of the whole. The same
 *  asset on two chains stays two tiles (two positions, two monies) — `id`
 *  keeps their keys apart, and `chainMark` flags tickers that appear on more
 *  than one chain so the duplicate is legible on the tile itself. Extracted
 *  from the thesis page so its card can draw the identical picture. */
export function thesisBentoItems(
  thesis: Thesis,
  fold: (symbol: string) => string,
): { id: string; symbol: string; address: string; chainId: number; weightPct: number; chainMark: boolean }[] {
  const total = thesis.totalAumUsd
  if (!(total > 0)) return []
  const chainsOf = new Map<string, Set<number>>()
  for (const leg of thesis.legs) {
    for (const t of leg.top ?? []) {
      const k = fold(t.symbol)
      const set = chainsOf.get(k) ?? new Set<number>()
      set.add(leg.chainId)
      chainsOf.set(k, set)
    }
  }
  return thesis.legs.flatMap((leg) => {
    const share = (Number.isFinite(leg.aumUsd) ? leg.aumUsd : 0) / total
    if (share <= 0) return []
    return (leg.top ?? [])
      .map((t) => ({
        id: `${leg.chainId}:${t.address}`,
        symbol: t.symbol,
        address: t.address,
        chainId: leg.chainId,
        weightPct: share * (t.weightPct || 0),
        chainMark: (chainsOf.get(fold(t.symbol))?.size ?? 0) > 1,
      }))
      .filter((t) => t.weightPct > 0)
  })
}
