import type { AwayDelta } from './away-diff'
import { showSymbol } from './safe-copy'
import { CASH_SYMBOLS, TIER_LABELS, type MarketTier } from './market-tiers'
import { MASKED_USD, moneyPrivacyOn } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO INSIGHTS — the strip the owner asked for (2026-08-02 17:53): "below
// positions we should actually have an individual little area above public
// baskets, which is insights, and it just gives little cards that just pop up
// with unique information." His headline example is the DRIFT card: "as you
// make money in a low cap it increases as a percentage of the portfolio, so it
// slowly goes up the list and flags you as it becomes more of a percent."
//
// FACTS ONLY (his own standing red line, 00:49): every card states a number
// that is true right now, with what it is measured against. No card gives
// advice, no card scores the portfolio, and no card renders unless its fact is
// actually true — a strip that pads itself out is noise, and this lane already
// ruled that a panel with nothing to say should not appear at all.
//
// Ranked by magnitude rather than shuffled: a fact that matters should not wait
// its turn because of the date. The list genuinely moves day to day anyway,
// because these are live shares.
//
// React-free by construction (the purity law): pure input → ranked output, so
// it is unit-testable and portable into the extension's service worker.
// ─────────────────────────────────────────────────────────────────────────────

export type InsightKind =
  | 'drift'
  | 'concentration'
  | 'spectrum'
  | 'cash'
  | 'spread'
  | 'unreadable'
  | 'overlap'
  | 'depth'
  | 'exit'
  | 'navgap'
  | 'depeg'
  | 'bets'
  | 'swing'
  | 'dust'
  | 'planvs'
  | 'cluster'
  | 'away'
  | 'superseded'
  | 'partial-bundle'

/**
 * The picture a card draws, chosen by what the fact IS (the form heuristic:
 * the data's job picks the mark, and a restatement in bigger type is not a
 * picture). Owner 18:5x: "let's make those insight cards more visual."
 *
 * - `move`   — a share that travelled: two points on one track, then → now.
 * - `share`  — part of a whole: one filled track.
 * - `stack`  — a few named parts of the whole: segments, largest first.
 * - `none`   — a fact with no magnitude to draw (a count, a status).
 */
export type InsightMark =
  | { form: 'move'; fromPct: number; toPct: number }
  | { form: 'share'; pct: number }
  | { form: 'stack'; parts: { label: string; pct: number }[] }
  | { form: 'none' }

/** An action a card can offer — noticing and acting become one motion.
 *  `restore` hands the reshape mode the target that puts a drifted position
 *  back where it was SET; `sweep` (16:4x feature 6) stages the dust
 *  positions' trims to zero. The card only OFFERS; the mode confirms. */
export type InsightAction =
  | { kind: 'restore'; key: string; toUsd: number; label: string }
  | { kind: 'sweep'; keys: string[]; label: string }
  /** Route to a page that already owns the act (the partial-bundle card →
   *  the bundle's own page; migration used to route this way too). */
  | { kind: 'goto'; href: string; label: string }
  /** Open the REAL migrate review (Token's MigrateModal) right on the card —
   *  the supersession card's one-click swap (owner 2026-08-16: "they can one
   *  click swap into it from that button on that card"). The modal still
   *  holds every signature; the click opens the review, never a send. */
  | {
      kind: 'migrate'
      fromAddr: string
      fromSymbol: string
      toAddr: string
      toSymbol: string
      chainId: number
      label: string
    }

export interface PortfolioInsight {
  /** Stable across renders so React keys and dismissals can hold onto it. */
  id: string
  kind: InsightKind
  /** The fact, as one sentence. Already complete — the UI adds no wording. */
  headline: string
  /** The measurement behind it: what it is against, or when it is since. */
  detail: string
  /** VISUAL-FIRST FACE (owner 23:1x: "make these way more visual with less
   *  text"): what the card is ABOUT, a few words for the small-caps label. */
  subject: string
  /** The figure itself — the card's typographic hero. The full sentence
   *  (headline + detail) moves behind the ⓘ, the same "facts → ⓘ" law the
   *  12:36 round set for the how-it-fills cards. */
  stat: string
  /** How to draw it. The card renders this; it never invents its own. */
  mark: InsightMark
  /** Optional one-tap follow-through. Absent on facts with nothing to do. */
  action?: InsightAction
  /** Ranking only. Never shown, never presented as a score. */
  magnitude: number
  /** Symbols this fact is ABOUT (QOL round 6): hovering the card spotlights
   *  their tiles in the picture — the movers' machinery, shared. Absent on
   *  whole-portfolio facts with no particular tiles to light. */
  spot?: string[]
}

export interface InsightPosition {
  key: string
  symbol: string
  valueUsd: number
  /** Share of the whole portfolio, 0–100. */
  pct: number
  tier: MarketTier
  /** How many DISTINCT holdings this asset reaches you through — a direct
   *  position and two baskets that each hold it is 3. The look-through fact
   *  only this product can state. */
  sourceCount?: number
  /** Deepest single pool backing it, USD. Null = unreadable, never assumed. */
  liquidityUsd?: number | null
}

/** What the portfolio was SET to, and when — the baseline drift measures from.
 *  Shares are the target weights the user chose, not a measured history, so the
 *  copy says "you set it at" rather than implying we watched it.
 *
 *  LIKE-FOR-LIKE OR NOTHING: these shares are percentages of the SAVED PLAN. If
 *  the plan covers two assets and the portfolio now holds nine, "50% then, 11%
 *  now" compares a share of the plan against a share of everything and reads as
 *  a collapse that never happened. Drift therefore measures current shares over
 *  the SAME set the baseline covers (see buildInsights). */
export interface InsightBaseline {
  at: number
  shares: Record<string, number>
  /** The plan's drift-alert band (feature 3), ± pp; absent = the default. */
  bandPp?: number
}

export interface InsightInputs {
  positions: InsightPosition[]
  totalUsd: number
  networks: number
  unpricedCount: number
  baseline?: InsightBaseline | null
  /** Feature 2 (precomputed by the history hook): the plan counterfactual —
   *  both futures grown from the same reconstructed start. */
  planVs?: { actualNowUsd: number; planNowUsd: number; atMs: number; skippedCount: number } | null
  /** Feature 7 (precomputed): the strongest moved-together pair. */
  together?: { aSym: string; bSym: string; days: number; together: number } | null
  /** 16:4x feature 5 (precomputed): how many independent bets the portfolio
   *  moves like — 1/(w'ρw) over 30-day daily returns, assets included only
   *  with complete pairwise coverage (a defaulted correlation would flatter). */
  bets?: { bets: number; included: number; considered: number; coveredSharePct: number } | null
  /** Stress replay v1 (owner ~17:5x, the non-db pick): the worst and best
   *  7-trading-day run of the last 30 days, compounded over TODAY's weights.
   *  A replay of what happened, clearly labeled — never a forecast; "worst
   *  month on record" waits until longer histories are fetched. */
  swing?: { worstPct: number; bestPct: number; included: number; considered: number; coveredSharePct: number; days: number } | null
  /** EXIT COST (the freeze-amendment's fourth feature, desk 34): measured
   *  sell-side costs, per position. Each row is a real simulation of selling
   *  the position's FULL size through its actual route (swap-sim's eth_call),
   *  costUsd being the gap between mark value and what the route returned.
   *  Measured in use-exit-costs.ts because this module is pure — and a
   *  position that would not measure is ABSENT here (unreadable stays null,
   *  never zero), so no card can render off a guess. */
  exitCosts?: { key: string; symbol: string; costUsd: number; costPct: number; sizeUsd: number; route: string }[] | null
  /** MARK UNCERTAINTY on held baskets (feature 2 of the ~16:4x round,
   *  reshaped for honesty): the kit values a basket two independent ways —
   *  on-chain views and a spot reconstruction of its contents — and
   *  divergencePct is how far they disagree RIGHT NOW (the kit's own >2%
   *  warning fact, surfaced instead of discarded). NOT market-price-vs-NAV:
   *  the self-pool has no real liquidity and pricing off it is exactly what
   *  a manipulated trade would move, so this product never reads it. */
  navGaps?: { key: string; symbol: string; divergencePct: number; valueUsd: number }[] | null
  /** DEPEG WATCH (feature 3): cash-tier positions whose measured unit price
   *  sits off the dollar, from the same read that prices the page. Absent =
   *  every stable read at par (or nothing readable — never guessed). */
  depegs?: { symbol: string; priceUsd: number; offPct: number; valueUsd: number }[] | null
  /** DUST (16:4x feature 6): direct token positions under the ceiling —
   *  tradeable rows only (a basket is trimmed by shares, cash is the
   *  destination, so neither counts as dust here). */
  dust?: { count: number; totalUsd: number; keys: string[] } | null
  /** SUPERSEDED HELD BASKETS (Ⓡ the owner ruled 2026-08-04, model-review #3): a
   *  held basket whose lineage carries a VERIFIED successor (the deployer-
   *  signed supersedes graph — UIGuy's versioning.ts read, cached per chain).
   *  The fact lived only on the basket page someone may never revisit; the
   *  book is where they'd notice. Facts-only, no urgency theater: supersession
   *  is the creator's claim, and holding the old version stays legitimate
   *  forever — its exits and fees work; nothing here may imply otherwise. */
  superseded?: { key: string; oldSymbol: string; newSymbol: string; newAddress: string; oldAddress: string; chainId: number; valueUsd: number }[] | null
  /** Bundles the wallet holds PART of — some legs, not all (owner 2026-08-16,
   *  after a conversion-route refusal stranded a 2-of-3 buy: "safeguards and
   *  maybe prompts on their portfolio if they have ever not been able to buy
   *  every leg"). Derived from on-chain holdings vs the catalog's grouping,
   *  so it also catches partials however they happened. */
  partialBundles?: { name: string; heldCount: number; totalCount: number; missingWords: string; href: string; heldUsd: number }[] | null
}

/** Direct token positions under this are DUST — visible, tradeable, and
 *  individually too small to matter (16:4x feature 6). */
export const DUST_CEILING_USD = 10

/** A position must move this many percentage points before drift is worth
 *  saying. Below it, the card would fire on ordinary price noise. */
export const DRIFT_THRESHOLD_PP = 5

/** Pool-share floor for depth facts, shared by the depth card AND the
 *  review's thin-legs line (calibration story at the depth block). Below it,
 *  a pool share is noise wearing a number. */
export const DEPTH_FLOOR_PCT = 5

/** Measured exit-cost floor, % of position value. Routine route friction on a
 *  healthy basket measured ~1.8% at small size (live, 2026-07-14) — the honest
 *  round-trip framing the owner accepted — so the card fires from 1% and lets
 *  MAGNITUDE decide whether it earns a slot: routine costs rank low, a
 *  position that is expensive to leave outranks the standing facts. */
export const EXIT_COST_FLOOR_PCT = 1

/** Mark-uncertainty floor — the kit's own basket-page warning threshold
 *  (basket-data: ">2% ⇒ surface a warning"); one law, two surfaces. */
export const NAVGAP_FLOOR_PCT = 2
/** …and the POSITION must be worth the card (audit find: a $2 basket with a
 *  4% divergence would have headlined uncertainty about pocket change). */
export const NAVGAP_VALUE_FLOOR_USD = 50

/** A stable must sit at least this far off the dollar before the card fires —
 *  spreads and rounding put every read a few bps off par all day long. */
export const DEPEG_FLOOR_PCT = 0.5
/** …and the position must be worth caring about (dust wobble is not a fact). */
export const DEPEG_VALUE_FLOOR_USD = 20

/** The depeg measurements, pure: cash-tier rows priced off their own read
 *  (usd/amount = unit price). Rows below the floors are absent — the card
 *  never fires on routine spread noise or dust. */
export function findDepegs(
  rows: { symbol: string; amount: number; usd: number | null }[],
): { symbol: string; priceUsd: number; offPct: number; valueUsd: number }[] {
  return rows
    .filter((r) => CASH_SYMBOLS.has(r.symbol.toUpperCase()) && r.usd != null && r.usd >= DEPEG_VALUE_FLOOR_USD && r.amount > 0)
    .map((r) => {
      const priceUsd = (r.usd as number) / r.amount
      return { symbol: r.symbol, priceUsd, offPct: Math.abs(1 - priceUsd) * 100, valueUsd: r.usd as number }
    })
    .filter((r) => Number.isFinite(r.priceUsd) && r.offPct >= DEPEG_FLOOR_PCT)
    .sort((a, b) => b.offPct - a.offPct)
}

// Same money law as formatUsdCompact (owner ~23:5x): grouped dollars to six
// digits, compact from a million. Kept local so this module stays React-free
// and dependency-light, with a test pinning the two in agreement.
// ⚠ NON-FINITE GUARD (2026-08-13, defense-in-depth beside the history-insights
// ratio fix): format.ts's family already guards this; these local twins did
// not, so a NaN/Infinity leaking from a bad ratio rendered "$NaN" / "$Infinity"
// on a facts card. A non-finite money figure is no figure — dash it.
const usd = (n: number) =>
  moneyPrivacyOn()
    ? MASKED_USD
    : !Number.isFinite(n)
    ? '$—'
    : n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
      ? `$${Math.round(n).toLocaleString('en-US')}`
      : `$${n.toFixed(n < 100 ? 2 : 0)}`

const pct = (n: number) => (Number.isFinite(n) ? `${n.toFixed(0)}%` : '—')

const dayMonth = (ms: number) => {
  const d = new Date(ms)
  return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`
}

/**
 * Every insight that is true right now, most notable first.
 *
 * Callers render the top N. Returning the whole ranked list rather than a
 * pre-cut slice keeps the "how many fit" decision with the surface.
 */
export function buildInsights(input: InsightInputs): PortfolioInsight[] {
  // BOUND THE DEPLOYER'S TEXT AT THE DOOR, ONCE (2026-08-06, after the same
  // class was found reaching WALLET-PROMPT labels in capability-ladder.ts).
  // Twenty sites in this module interpolate `symbol` into a sentence, and
  // `InsightCard` renders the subject with no truncation plus the headline
  // inside a tooltip and an sr-only span, where no CSS bound can save it.
  // Wrapping each call site would be twenty chances to miss one; bounding the
  // INPUT makes an unsafe symbol unrepresentable past this line.
  const positions = input.positions.map((p) => {
    const safe = showSymbol(p.symbol)
    return safe === p.symbol ? p : { ...p, symbol: safe }
  })
  const { totalUsd, networks, unpricedCount, baseline, planVs, together } = input
  const out: PortfolioInsight[] = []
  if (totalUsd <= 0 || positions.length === 0) return out

  const byValue = [...positions].sort((a, b) => b.valueUsd - a.valueUsd)

  // ── DRIFT — his card. A position that has grown (or shrunk) into a different
  //    share of the portfolio than the one it was set to.
  if (baseline) {
    const drifted: PortfolioInsight[] = []
    // Re-base TODAY onto the baseline's own universe, so both numbers are
    // shares of the same thing. Without this, adding an asset the plan never
    // mentioned makes every planned position look like it shrank.
    // A SHARE MUST BE A SHARE (audit round 4, 2026-08-04): `Number.isFinite`
    // let any magnitude through, and a stored plan carrying a corrupt weight
    // rendered "down from 1000000000%" as a stated fact about the user's own
    // plan. A baseline share outside 0–100 is not a share, so the position is
    // uncovered rather than described with a number that cannot be true.
    const covered = positions.filter((p) => {
      const was = baseline.shares[p.key]
      return Number.isFinite(was) && was >= 0 && was <= 100
    })
    const coveredUsd = covered.reduce((s, p) => s + p.valueUsd, 0)
    for (const p of covered) {
      const was = baseline.shares[p.key]
      if (coveredUsd <= 0) break
      const nowPct = (p.valueUsd / coveredUsd) * 100
      const move = nowPct - was
      const band = baseline.bandPp ?? DRIFT_THRESHOLD_PP
      if (Math.abs(move) < band) continue
      drifted.push({
        id: `drift:${p.key}`,
        kind: 'drift',
        headline: `$${showSymbol(p.symbol)} is now ${pct(nowPct)} of your plan, ${move > 0 ? 'up' : 'down'} from ${pct(was)}`,
        detail: `You set it at ${pct(was)} on ${dayMonth(baseline.at)}; it is ${usd(p.valueUsd)} today.`,
        subject: `$${showSymbol(p.symbol)} drift`,
        stat: `${pct(was)} → ${pct(nowPct)}`,
        // nowPct, NOT p.pct: the mark must be drawn in the same universe the
        // sentence speaks in, or the picture contradicts the words above it.
        mark: { form: 'move', fromPct: was, toPct: nowPct },
        // ONE TAP BACK TO PLAN: the dollar value this position would hold at
        // the share it was SET to, over the same universe the baseline covers.
        // Noticing a drift and correcting it become one motion.
        action: {
          kind: 'restore',
          key: p.key,
          toUsd: Math.round((was / 100) * coveredUsd * 100) / 100,
          label: move > 0 ? `Trim back to ${pct(was)}` : `Top back up to ${pct(was)}`,
        },
        // A bigger move in a bigger position matters more. GROWTH leads: it is
        // the case he described ("as you make money in a low cap it increases
        // as a percentage… and flags you"), and one position growing is what
        // makes another shrink, so the two are usually one fact seen twice.
        magnitude: 60 + Math.min(35, Math.abs(move)) + Math.min(5, nowPct / 20) + (move > 0 ? 4 : 0),
      })
    }
    // At most two. Beyond that the strip becomes a list of every rebalance leg
    // and the other kinds never get a slot.
    out.push(...drifted.sort((a, b) => b.magnitude - a.magnitude).slice(0, 2))
  }

  // ── CONCENTRATION — the top two, his own example of a fact ("68% sits in
  //    two assets" was the phrasing he used when he set the facts-only line).
  // Measured against what an EVEN split of the same count would give, because
  // "50% is in two positions" is not concentration when you hold four things —
  // it is the definition of holding four things. Under three positions the
  // statement is vacuous, so it is not made at all.
  if (byValue.length >= 3) {
    const topTwo = byValue[0].pct + byValue[1].pct
    const evenTwo = (2 / byValue.length) * 100
    if (topTwo >= 55 && topTwo - evenTwo >= 10) {
      out.push({
        id: 'concentration:top2',
        kind: 'concentration',
        headline: `${pct(topTwo)} of your portfolio is in two positions`,
        detail: `$${byValue[0].symbol} at ${pct(byValue[0].pct)} and $${byValue[1].symbol} at ${pct(byValue[1].pct)}, out of ${byValue.length}.`,
        subject: `$${byValue[0].symbol} + $${byValue[1].symbol}`,
        stat: pct(topTwo),
        spot: [byValue[0].symbol, byValue[1].symbol],
        mark: {
          form: 'stack',
          parts: [
            { label: `$${byValue[0].symbol}`, pct: byValue[0].pct },
            { label: `$${byValue[1].symbol}`, pct: byValue[1].pct },
            { label: `the other ${byValue.length - 2}`, pct: Math.max(0, 100 - topTwo) },
          ],
        },
        magnitude: 30 + Math.min(30, topTwo - evenTwo),
      })
    }
  }

  // ── DOWN THE SPECTRUM — in dollars, his own sentence shape: "I have
  //    $120,000, but 50,000 of it is actually in high risk stuff."
  const volatile = positions.filter((p) => p.tier === 'small' || p.tier === 'micro')
  const volatileUsd = volatile.reduce((s, p) => s + p.valueUsd, 0)
  if (volatileUsd > 0.005) {
    const share = (volatileUsd / totalUsd) * 100
    out.push({
      id: 'spectrum:volatile',
      kind: 'spectrum',
      headline: `${usd(volatileUsd)} of your ${usd(totalUsd)} is in small caps and new tokens`,
      detail: `${pct(share)} of the portfolio, across ${volatile.length} position${volatile.length === 1 ? '' : 's'}.`,
      subject: 'in small caps & new',
      stat: usd(volatileUsd),
      spot: volatile.map((p) => p.symbol),
      mark: { form: 'share', pct: share },
      magnitude: 25 + Math.min(35, share / 2),
    })
  }

  // ── IDLE CASH — a fact, not a nudge to deploy it.
  const cashUsd = positions.filter((p) => p.tier === 'cash').reduce((s, p) => s + p.valueUsd, 0)
  if (cashUsd > 0.005) {
    const share = (cashUsd / totalUsd) * 100
    out.push({
      id: 'cash:idle',
      kind: 'cash',
      headline: `${usd(cashUsd)} is sitting in stablecoins`,
      detail: `${pct(share)} of the portfolio is cash.`,
      subject: 'in stablecoins',
      stat: usd(cashUsd),
      spot: positions.filter((p) => p.tier === 'cash').map((p) => p.symbol),
      mark: { form: 'share', pct: share },
      magnitude: 15 + Math.min(25, share / 2),
    })
  }

  // ── SPREAD — the cross-chain fact this product exists to make ordinary.
  if (networks > 1) {
    out.push({
      id: 'spread:networks',
      kind: 'spread',
      headline: `Your portfolio spans ${networks} networks`,
      detail: `Held in one place, traded in one flow.`,
      subject: 'networks spanned',
      stat: String(networks),
      mark: { form: 'none' },
      magnitude: 12 + Math.min(8, networks * 2),
    })
  }

  // ── UNREADABLE — the honesty card. Never counted, and never silent about it.
  if (unpricedCount > 0) {
    out.push({
      id: 'unreadable:count',
      kind: 'unreadable',
      headline: `${unpricedCount} holding${unpricedCount === 1 ? '' : 's'} ${unpricedCount === 1 ? 'has' : 'have'} no readable price`,
      detail: `Listed on the page, never counted in any total here.`,
      subject: 'no readable price',
      stat: `${unpricedCount} holding${unpricedCount === 1 ? '' : 's'}`,
      mark: { form: 'none' },
      magnitude: 20,
    })
  }

  // ── OVERLAP — the look-through fact nothing else can tell you. Holding
  //    three baskets that each carry WETH means your real WETH exposure is
  //    larger than any single row suggests: you own fewer things than you
  //    think, several times over.
  const multi = positions
    .filter((p) => (p.sourceCount ?? 1) > 1 && p.pct >= 5)
    .sort((a, b) => b.pct - a.pct)[0]
  if (multi) {
    out.push({
      id: `overlap:${multi.key}`,
      kind: 'overlap',
      headline: `$${showSymbol(multi.symbol)} reaches ${pct(multi.pct)} of your portfolio through ${multi.sourceCount} holdings`,
      detail: `You hold it in ${multi.sourceCount} places at once; the position rows show each separately.`,
      subject: `$${showSymbol(multi.symbol)} · ${multi.sourceCount} holdings`,
      stat: pct(multi.pct),
      mark: { form: 'share', pct: multi.pct },
      magnitude: 40 + Math.min(25, multi.pct),
    })
  }

  // ── DEPTH — the number that decides whether a position is real. A mark
  //    price you could never exit at is not a price. Stated as a share of the
  //    deepest single pool, because you trade against a pool, not a total.
  //
  //    CALIBRATION, learned from live data: the first cut fired at 1% and put
  //    "your USDC is 2% of its pool" at the top of the strip. Two percent is
  //    not a fact worth a card, and for CASH it is actively misleading — a
  //    stablecoin is deep in a dozen pools and redeemable besides, so its
  //    share of any ONE pool says nothing about getting out. Cash is excluded
  //    and the floor is 5% (DEPTH_FLOOR_PCT, module-level — exitCost shares
  //    it), below which this is noise wearing a number.
  const deep = positions
    .filter(
      (p) =>
        p.tier !== 'cash' &&
        typeof p.liquidityUsd === 'number' &&
        (p.liquidityUsd as number) > 0 &&
        p.valueUsd > 0,
    )
    .map((p) => ({ p, share: (p.valueUsd / (p.liquidityUsd as number)) * 100 }))
    .filter((x) => x.share >= DEPTH_FLOOR_PCT)
    .sort((a, b) => b.share - a.share)[0]
  if (deep) {
    out.push({
      id: `depth:${deep.p.key}`,
      kind: 'depth',
      headline: `Your $${showSymbol(deep.p.symbol)} is ${deep.share < 1 ? 'under 1' : deep.share.toFixed(0)}% of its pool`,
      detail: `${usd(deep.p.valueUsd)} against ${usd(deep.p.liquidityUsd as number)} of pooled liquidity, its deepest pool.`,
      subject: `$${showSymbol(deep.p.symbol)} pool share`,
      stat: `${deep.share < 1 ? '<1' : deep.share.toFixed(0)}%`,
      mark: { form: 'share', pct: Math.min(100, deep.share) },
      // Depth outranks the standing facts once a position is a real slice of
      // the pool it would have to leave through.
      magnitude: 42 + Math.min(30, deep.share),
    })
  }

  // ── EXIT COST (freeze-amendment feature 4, desk 34) — what leaving a
  //    position would actually cost through the real route, MEASURED: a sell
  //    of the position's full size simulated on-chain, the cost being the gap
  //    between mark value and what the route returns. Unlike the depth card
  //    (structural: your share of the pool), this is the measured outcome.
  //    Facts only: the number, its size, its route — never a projection of
  //    returns. Worst position only, same as depth; below the floor the cost
  //    is routine friction, not a fact worth a card.
  const exit = (input.exitCosts ?? [])
    .filter((e) => Number.isFinite(e.costPct) && Number.isFinite(e.costUsd) && e.costPct >= EXIT_COST_FLOOR_PCT && e.sizeUsd > 0)
    .sort((a, b) => b.costPct - a.costPct)[0]
  if (exit) {
    out.push({
      id: `exit:${exit.key}`,
      kind: 'exit',
      headline: `Exiting $${showSymbol(exit.symbol)} would cost ${usd(exit.costUsd)} right now, ${exit.costPct.toFixed(1)}% of the position`,
      detail: `A sell of your full ${usd(exit.sizeUsd)} was simulated through ${exit.route} just now; the cost is the gap between mark value and what the route returns. It moves with pool depth.`,
      subject: `$${showSymbol(exit.symbol)} exit cost`,
      stat: `${exit.costPct.toFixed(1)}%`,
      mark: { form: 'share', pct: Math.min(100, exit.costPct) },
      // Routine friction (~2%) ranks low; a position that is genuinely
      // expensive to leave climbs past the standing facts.
      magnitude: 30 + Math.min(40, exit.costPct * 3),
    })
  }

  // ── MARK UNCERTAINTY (16:4x feature 2, honesty-reshaped) — a held basket
  //    whose two independent valuations disagree. The number on the page is
  //    only as solid as the reads behind it; when they split past the kit's
  //    own warning floor, the split IS the fact. Worst basket only.
  const navGap = (input.navGaps ?? [])
    .filter((g) => Number.isFinite(g.divergencePct) && g.divergencePct >= NAVGAP_FLOOR_PCT && g.valueUsd >= NAVGAP_VALUE_FLOOR_USD)
    .sort((a, b) => b.divergencePct - a.divergencePct)[0]
  if (navGap) {
    out.push({
      id: `navgap:${navGap.key}`,
      kind: 'navgap',
      headline: `$${showSymbol(navGap.symbol)}'s mark is uncertain by ${navGap.divergencePct.toFixed(1)}% right now`,
      detail: `Its on-chain valuation and the spot reconstruction of its contents disagree by ${navGap.divergencePct.toFixed(1)}%; the ${usd(
        navGap.valueUsd,
      )} shown rides one of them. Wide gaps usually mean a thin or fast-moving market in a constituent.`,
      subject: `$${showSymbol(navGap.symbol)} mark`,
      stat: `±${navGap.divergencePct.toFixed(1)}%`,
      mark: { form: 'share', pct: Math.min(100, navGap.divergencePct) },
      magnitude: 40 + Math.min(28, navGap.divergencePct * 3),
    })
  }

  // ── DEPEG WATCH (16:4x feature 3) — the one time cash is not boring. The
  //    tier math assumes a dollar is a dollar; when a held stable's own read
  //    says otherwise past the floor, this outranks nearly everything —
  //    protective facts are what the strip is FOR. Worst stable only.
  const depeg = (input.depegs ?? []).filter((d) => Number.isFinite(d.offPct) && d.offPct >= DEPEG_FLOOR_PCT)[0]
  if (depeg) {
    out.push({
      id: `depeg:${depeg.symbol}`,
      kind: 'depeg',
      headline: `Your $${showSymbol(depeg.symbol)} is trading at $${depeg.priceUsd.toFixed(3)}, ${depeg.offPct.toFixed(1)}% off the dollar`,
      detail: `Unit price from the same read that values this page; ${usd(depeg.valueUsd)} held. A measurement right now, not a forecast.`,
      subject: `$${showSymbol(depeg.symbol)} peg`,
      stat: `$${depeg.priceUsd.toFixed(3)}`,
      mark: { form: 'none' },
      magnitude: 58 + Math.min(20, depeg.offPct * 4),
    })
  }

  // ── DUST (16:4x feature 6) — the housekeeping fact, with one motion. The
  //    card OFFERS the sweep; the reshape popup stages the trims and nothing
  //    runs without the user's confirm, same rail as the drift card's
  //    restore. Three or more scraps make a fact; fewer is just a small
  //    position.
  // owner 2026-08-05 21:06: the dust card "should be something that you show
  // always… so easy to sweep it" — any dust at all now qualifies (was ≥3),
  // and the strip promotes it to the FRONT.
  if (input.dust && input.dust.count >= 1 && input.dust.totalUsd > 0) {
    const d = input.dust
    out.push({
      id: 'dust',
      kind: 'dust',
      headline: `${usd(d.totalUsd)} sits across ${d.count} positions under ${usd(DUST_CEILING_USD)}`,
      detail: `Direct token positions each below ${usd(
        DUST_CEILING_USD,
      )}. The sweep stages their trims into cash in the reshape popup; nothing runs without your confirm.`,
      subject: 'in dust positions',
      stat: usd(d.totalUsd),
      mark: { form: 'none' },
      // the action wears the number that justifies it (touch round,
      // 2026-08-05): one glance, decision made
      action: { kind: 'sweep', keys: d.keys, label: `Sweep to cash · $${d.totalUsd.toFixed(2)}` },
      magnitude: 16 + Math.min(8, d.count),
    })
  }

  // ── VS YOUR SAVED PLAN (feature 2) — the counterfactual fact, both ways.
  if (planVs) {
    const diff = planVs.planNowUsd - planVs.actualNowUsd
    const floor = Math.max(50, planVs.actualNowUsd * 0.005)
    if (Math.abs(diff) >= floor) {
      const helped = diff < 0 // drift left you ahead of the plan
      out.push({
        id: 'planvs',
        kind: 'planvs',
        headline: `Holding your ${dayMonth(planVs.atMs)} plan untouched would be worth ${usd(planVs.planNowUsd)}; your mix is ${usd(planVs.actualNowUsd)}`,
        detail: `Today's holdings valued from the same ${dayMonth(planVs.atMs)} start — only the weights differ. Money added or removed since isn't netted${
          planVs.skippedCount > 0 ? `; ${planVs.skippedCount} leg${planVs.skippedCount === 1 ? '' : 's'} had no readable history and sat out` : ''
        }.`,
        subject: helped ? 'drift has helped, vs plan' : 'drift has cost, vs plan',
        stat: `${usd(planVs.actualNowUsd)} vs ${usd(planVs.planNowUsd)}`,
        mark: { form: 'none' },
        magnitude: 45 + Math.min(30, (Math.abs(diff) / Math.max(1, planVs.actualNowUsd)) * 400),
      })
    }
  }

  // ── STRESS REPLAY v1 (~17:5x) — "how bad can this get", answered with
  //    history instead of a forecast, and with BOTH ends because a range is
  //    a fact and a fear headline is not. Today's weights over the real
  //    daily moves; the depth is stated (last 30 days) and grows only when
  //    the data does.
  // A CLAIM MAY NOT CONTRADICT ITSELF (audit round 4): an inverted pair
  // rendered "the worst week moved 10.0%; the best week, -10.0%" — a sentence
  // whose own two halves disagree about which is worse. The computation cannot
  // produce it, but this interface accepts any pair, and a self-contradicting
  // fact is worse than a missing one.
  if (
    input.swing &&
    input.swing.included >= 2 &&
    // READABLE FIRST, then ordered (the hostile-number sweep, 2026-08-04): the
    // round-4 fix required worst <= best, and -Infinity satisfies that — so
    // "the worst week this mix would have moved -Infinity%" reached the user as
    // a stated fact. A percentage that is not a finite number is not a
    // percentage.
    Number.isFinite(input.swing.worstPct) &&
    Number.isFinite(input.swing.bestPct) &&
    input.swing.worstPct <= input.swing.bestPct
  ) {
    const sw = input.swing
    out.push({
      id: 'swing',
      kind: 'swing',
      headline: `In the last month's worst week this mix would have moved ${sw.worstPct.toFixed(1)}%; the best week, ${sw.bestPct > 0 ? '+' : ''}${sw.bestPct.toFixed(1)}%`,
      detail: `Today's weights replayed over each asset's real daily moves (7 consecutive trading days, ${sw.days}-day shared grid${
        sw.coveredSharePct < 99 ? `; covers ${sw.coveredSharePct}% of the portfolio` : ''
      }). A replay of the last 30 days, not a forecast.`,
      subject: 'worst week · best week',
      stat: `${sw.worstPct.toFixed(1)}%`,
      mark: { form: 'none' },
      magnitude: 30 + Math.min(25, Math.abs(sw.worstPct)),
    })
  }

  // ── DIVERSIFICATION, MEASURED (16:4x feature 5) — the whole-portfolio
  //    sibling of moved-together: how many independent bets the included
  //    positions move like. A measurement of granularity, never a verdict —
  //    and more notable the further it sits from the position count.
  if (input.bets && input.bets.included >= 3) {
    const b = input.bets
    out.push({
      id: 'bets',
      kind: 'bets',
      headline: `Your ${b.included} position${b.included === 1 ? '' : 's'} move like ${b.bets.toFixed(1)} independent bet${b.bets === 1 ? '' : 's'}`,
      detail: `Thirty-day daily co-movement across your largest positions, value-weighted${
        b.included < b.considered
          ? `; ${b.included} of ${b.considered} qualified — a position needs shared history AND its own movement (a pegged stable is not a bet). ${b.coveredSharePct}% of the value considered`
          : ''
      }. A granularity measurement, not a score.`,
      subject: 'independent bets',
      stat: `≈${b.bets.toFixed(1)}`,
      mark: { form: 'none' },
      magnitude: 24 + Math.min(20, (b.included / Math.max(1, b.bets) - 1) * 10),
    })
  }

  // ── A NEWER VERSION EXISTS — TOP OF THE STRIP, ONE-CLICK SWAP (owner
  //    2026-08-16: "the top priority insight should be when a creator has
  //    updated a new version of a basket/bundle the person holds and then
  //    they can one click swap into it from that button on that card" —
  //    supersedes the Ⓡ 2026-08-04 above-housekeeping placement AND the
  //    goto-the-page action). Copy still states the creator's claim without
  //    urgency: holding the old version stays legitimate forever.
  for (const s of input.superseded ?? []) {
    out.push({
      id: `superseded:${s.key}`,
      kind: 'superseded',
      headline: `$${showSymbol(s.oldSymbol)} has a newer version, $${showSymbol(s.newSymbol)} — its creator published an upgrade.`,
      detail:
        'A deployer-signed supersession claim, verified on-chain. Holding the current version stays fully functional — exits and fees work as ever; swapping is at your discretion.',
      subject: `$${showSymbol(s.oldSymbol)} version`,
      stat: `→ $${showSymbol(s.newSymbol)}`,
      mark: { form: 'none' },
      action: {
        kind: 'migrate',
        fromAddr: s.oldAddress,
        fromSymbol: s.oldSymbol,
        toAddr: s.newAddress,
        toSymbol: s.newSymbol,
        chainId: s.chainId,
        label: `Swap into $${showSymbol(s.newSymbol)} →`,
      },
      // the strip's kind-order pins this card first regardless; the magnitude
      // only ranks superseded cards among THEMSELVES (biggest position first)
      magnitude: 100 + Math.min(10, s.valueUsd / 1000),
    })
  }

  // ── AN INCOMPLETE BUNDLE (owner 2026-08-16, after a refused conversion leg
  //    stranded a 2-of-3 buy): you hold SOME legs of a bundle, not all — the
  //    prompt that stops a partial buy from being silently forgotten. Facts
  //    only: however the partial happened, the completion door is the
  //    bundle's own page, where the missing leg can be bought alone.
  for (const b of input.partialBundles ?? []) {
    out.push({
      id: `partial-bundle:${b.name}`,
      kind: 'partial-bundle',
      headline: `You hold ${b.heldCount} of ${b.totalCount} networks of ${b.name} — the bundle is incomplete.`,
      detail: `Missing on ${b.missingWords}. Buy the missing leg from the bundle's page (each leg can be bought alone), or bridge funds there first if that network is short.`,
      subject: `${b.name} bundle`,
      stat: `${b.heldCount}/${b.totalCount} legs`,
      mark: { form: 'share', pct: (b.heldCount / Math.max(1, b.totalCount)) * 100 },
      action: { kind: 'goto', href: b.href, label: 'Complete the bundle →' },
      magnitude: 60 + Math.min(10, b.heldUsd / 1000),
    })
  }

  // ── MOVED TOGETHER (feature 7) — the co-movement measurement.
  if (together) {
    out.push({
      id: `cluster:${together.aSym}:${together.bSym}`,
      kind: 'cluster',
      headline: `$${together.aSym} and $${together.bSym} moved together ${together.together} of ${together.days} days`,
      detail: 'Daily direction agreement over the past 30 days, from the same price history the chart uses.',
      subject: `$${together.aSym} + $${together.bSym}`,
      stat: `${together.together}/${together.days} days`,
      mark: { form: 'none' },
      magnitude: 24 + (together.together / together.days) * 12,
    })
  }

  return out.sort((a, b) => b.magnitude - a.magnitude)
}

/** Realized gain/loss when a fraction of a position is trimmed against a
 *  KNOWN invested basis (feature 4): frac × (current − invested). Returns
 *  null wherever basis is unknown or inputs are degenerate — a receipt is
 *  never guessed. Pure; the review only renders it. */
export function realizedOnTrim(currentUsd: number, investedUsd: number | undefined, trimUsd: number): number | null {
  if (!Number.isFinite(currentUsd) || currentUsd <= 0) return null
  if (investedUsd == null || !Number.isFinite(investedUsd) || investedUsd <= 0) return null
  if (!Number.isFinite(trimUsd) || trimUsd <= 0) return null
  const frac = Math.min(1, trimUsd / currentUsd)
  return Math.round(frac * (currentUsd - investedUsd) * 100) / 100
}

// ── WHAT CHANGES ─────────────────────────────────────────────────────────────
// The review used to lead with the RESULTING mix, which answers "what will I
// hold" and never answers "what is about to happen to me" — the question
// someone pressing execute is actually asking (owner 17:53: "it's still a bit
// confusing as to what's actually happening… you're going to be decreasing
// these things, adding a new asset").

export interface PlanLeg {
  key: string
  symbol: string
  usd: number
}

export interface PlanChange extends PlanLeg {
  fromUsd: number
  toUsd: number
  deltaUsd: number
  /** The trim receipt (feature 4), only where basis was known. */
  realizedUsd?: number
  kind: 'exit' | 'trim' | 'add' | 'new'
}

/** Below this a move is rounding, not a change. Matches the composer's own
 *  threshold so the review can never show a leg the plan does not contain. */
export const CHANGE_FLOOR_USD = 0.5

/**
 * What kind of move this is, from its two ends.
 *
 * NOTE ON WHY THE COMPOSER EMITS CHANGES RATHER THAN THE REVIEW DERIVING THEM:
 * the stored plan is integer PERCENTAGES, so re-deriving each leg's dollars as
 * `pct × resultUsd` reintroduces up to half a percentage point of the total per
 * leg. On a $4.8K portfolio that invented "Adding to $DEGEN, uses $3.63" for a
 * position the plan never touched — the review promising a trade that would
 * never happen. The composer knows the exact ends, so it records them.
 */
export function changeKind(fromUsd: number, toUsd: number): PlanChange['kind'] {
  if (toUsd < CHANGE_FLOOR_USD) return 'exit'
  if (fromUsd < CHANGE_FLOOR_USD) return 'new'
  return toUsd > fromUsd ? 'add' : 'trim'
}

/** The recorded moves as display rows, biggest move first. Legs the plan does
 *  not touch are absent by construction — this is the CHANGE, not the mix. */
export function toPlanChanges(
  recorded: { key: string; symbol: string; fromUsd: number; toUsd: number; realizedUsd?: number }[],
): PlanChange[] {
  return recorded
    .filter((c) => Math.abs(c.toUsd - c.fromUsd) >= CHANGE_FLOOR_USD)
    .map((c) => ({
      key: c.key,
      symbol: c.symbol,
      usd: c.toUsd,
      fromUsd: c.fromUsd,
      toUsd: c.toUsd,
      deltaUsd: c.toUsd - c.fromUsd,
      kind: changeKind(c.fromUsd, c.toUsd),
      realizedUsd: c.realizedUsd,
    }))
    .sort((x, y) => Math.abs(y.deltaUsd) - Math.abs(x.deltaUsd))
}

/** The before-picture with the recorded moves applied — the exact after, with
 *  no percentage round-trip. Used for the before/after tier read. */
export function applyChanges(before: PlanLeg[], changes: PlanChange[]): PlanLeg[] {
  const by = new Map(before.map((b) => [b.key, { ...b }]))
  for (const c of changes) {
    const existing = by.get(c.key)
    if (existing) existing.usd = c.toUsd
    else by.set(c.key, { key: c.key, symbol: c.symbol, usd: c.toUsd })
  }
  return [...by.values()].filter((l) => l.usd >= CHANGE_FLOOR_USD)
}

// ── WHAT IT COSTS TO GET OUT ────────────────────────────────────────────────
// Owner: "assembling this costs about X; unwinding it costs about Y." Half of
// that is EXACTLY knowable and half is not, and the split is the whole design.
//
// KNOWABLE, so stated as a number: the batching fee (buys only, zero on exits)
// and the transaction count, which is one per network — the batcher's entire
// pitch. UNKNOWABLE without a live quote: slippage. So this NEVER invents a
// slippage figure. Where a position is a real slice of its own pool it says so
// as the FACT it is (a share of depth) and leaves the number to the quote at
// execution. A made-up exit cost would be worse than no exit cost: it would be
// a promise about someone else's money.

export interface ExitCost {
  /** Buy-side fee to assemble, USD — exact, from the live constant. */
  feeToAssembleUsd: number
  /** One per network, the compression the batcher exists to deliver. */
  transactions: number
  /** Positions that are a meaningful slice of their own pool, worst first. */
  thin: { symbol: string; poolSharePct: number }[]
}

export function exitCost(
  legs: { symbol: string; usd: number; chainId: number; liquidityUsd?: number | null }[],
  feeBps: number,
): ExitCost {
  const gross = legs.reduce((s, l) => s + Math.max(0, l.usd), 0)
  // Same calibration as the depth card (DEPTH_FLOOR_PCT block above), learned
  // from live reads and re-armed here before this shared the law: CASH is
  // excluded — a stablecoin is deep in a dozen pools and redeemable besides,
  // so "your $USDC is 2% of its pool" on the review was actively misleading —
  // and below the floor a pool share is noise wearing a number.
  const thin = legs
    .filter(
      (l) =>
        !CASH_SYMBOLS.has(l.symbol.toUpperCase()) &&
        typeof l.liquidityUsd === 'number' &&
        (l.liquidityUsd as number) > 0 &&
        l.usd > 0,
    )
    .map((l) => ({ symbol: l.symbol, poolSharePct: (l.usd / (l.liquidityUsd as number)) * 100 }))
    .filter((x) => x.poolSharePct >= DEPTH_FLOOR_PCT)
    .sort((a, b) => b.poolSharePct - a.poolSharePct)
  return {
    feeToAssembleUsd: Math.round(((gross * feeBps) / 10_000) * 100) / 100,
    transactions: new Set(legs.filter((l) => l.usd > 0).map((l) => l.chainId)).size,
    thin,
  }
}

/** SINCE YOU WERE AWAY (the owner's greenlit mount, desk 46): the away-diff's
 *  ranked deltas dressed as strip cards, so the briefing LEADS the insights
 *  band in the band's own visual language. The sentences arrive ready from
 *  the diff (measured deltas, never advice); this maps each onto the form
 *  heuristic — a travelled share takes the move mark, an arrival takes its
 *  share of the book, a departure and the total draw nothing rather than a
 *  fake picture. Deltas come pre-ranked and capped; order is preserved. */
export function awayInsights(deltas: AwayDelta[]): PortfolioInsight[] {
  return deltas.map((d, i): PortfolioInsight => {
    // magnitude only orders away cards among themselves when a caller
    // re-sorts; the strip PREPENDS these, so rank arrives structural
    const mag = 1000 - i
    switch (d.kind) {
      case 'total-moved':
        return {
          id: 'away:total',
          kind: 'away',
          headline: d.sentence,
          detail: 'measured against your last visit',
          subject: 'while you were away',
          stat: `${d.pct >= 0 ? '+' : '−'}${Math.abs(d.pct).toFixed(1)}%`,
          mark: { form: 'none' },
          magnitude: mag,
        }
      case 'share-moved':
        return {
          id: `away:share:${d.key}`,
          kind: 'away',
          headline: d.sentence,
          detail: 'share of the book, measured against your last visit',
          subject: `$${showSymbol(d.symbol)} while you were away`,
          stat: `${d.fromPct.toFixed(1)}% → ${d.toPct.toFixed(1)}%`,
          mark: { form: 'move', fromPct: d.fromPct, toPct: d.toPct },
          magnitude: mag,
        }
      case 'exit-cost-moved':
        return {
          id: `away:exit:${d.key}`,
          kind: 'away',
          headline: d.sentence,
          detail: 'cost to leave the position, measured against your last visit',
          subject: `$${showSymbol(d.symbol)} exit cost`,
          stat: `${d.fromPct.toFixed(1)}% → ${d.toPct.toFixed(1)}%`,
          mark: { form: 'move', fromPct: d.fromPct, toPct: d.toPct },
          magnitude: mag,
        }
      case 'position-new':
        return {
          id: `away:new:${d.key}`,
          kind: 'away',
          headline: d.sentence,
          detail: 'new in the book since your last visit',
          subject: `$${showSymbol(d.symbol)} arrived`,
          stat: `${d.pct.toFixed(1)}%`,
          mark: { form: 'share', pct: d.pct },
          magnitude: mag,
        }
      case 'position-gone':
        return {
          id: `away:gone:${d.key}`,
          kind: 'away',
          headline: d.sentence,
          detail: 'left the book since your last visit',
          subject: `$${showSymbol(d.symbol)} left`,
          stat: `was ${d.wasPct.toFixed(1)}%`,
          mark: { form: 'none' },
          magnitude: mag,
        }
    }
  })
}

/** Per-tier dollars and share, ordered safer → riskier. The spectrum read the
 *  bar draws, and the same numbers the review's before/after compares. */
export function tierSplit(
  positions: InsightPosition[],
  order: MarketTier[],
): { tier: MarketTier; label: string; usd: number; pct: number }[] {
  const total = positions.reduce((s, p) => s + p.valueUsd, 0)
  if (total <= 0) return []
  return order
    .map((tier) => {
      const rows = positions.filter((p) => p.tier === tier)
      const tierUsd = rows.reduce((s, p) => s + p.valueUsd, 0)
      return { tier, label: TIER_LABELS[tier], usd: tierUsd, pct: (tierUsd / total) * 100 }
    })
    .filter((g) => g.usd > 0.005)
}
