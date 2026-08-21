import { useEffect, useMemo, useState } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { useQueries } from '@tanstack/react-query'
import { BasketSpark } from '../BasketSpark'
import { BasketBento } from '../BasketBento'
import { PortfolioChart, type ChartReadout } from '../PortfolioChart'
import { ChainBadge } from '../ChainBadge'
import { formatPct, formatUsdCompact } from '../../lib/spectrum/format'
import { chartLinksFor } from '../../lib/spectrum/chart-links'
import { fetchAssetHistory, honest24hPct } from '../../lib/spectrum/history'
import { usePortfolioHistory } from '../../lib/spectrum/use-portfolio-history'
import type { PortfolioHistoryAsset } from '../../lib/spectrum/portfolio-history'
import { tokenVisual } from '../../lib/spectrum/token-meta'
import { useMinWidth, usePrefersReducedMotion } from '../../lib/motion'
import type { BasketSummary } from '../../lib/spectrum/basket-data'
import { PLUMBING } from './IntroArt'
import { Bezel, Reveal, SPECTRAL } from './Spine'

/** One line of the example book. Named for what it is: the SHOWCASE's row
 *  model, not a row component — the row component is the app's own HoldingRow. */
interface ExampleRow {
  symbol: string
  address: string
  chainId: number
  pct: number
  usd: number
}

/** Build an example portfolio out of the real constituents of live baskets:
 *  distinct assets, biggest baskets first, weights normalised to 100. */
function useExampleRows(
  baskets: BasketSummary[],
  total: number,
  /** The rotating pool + window (the hero's living bento). Omit both and the old
   *  behaviour is exactly preserved: the first five distinct assets, static. */
  pool?: { symbol: string; address: string; chainId: number; w: number }[],
  offset = 0,
  windowSize = 5,
): ExampleRow[] {
  return useMemo(() => {
    let picked: { symbol: string; address: string; chainId: number; w: number }[] = []
    if (pool && pool.length > 0) {
      // A rotating WINDOW over the pool, wrapping, so a tile leaves and another
      // arrives on every tick and the weights re-proportion around them.
      const n = Math.min(windowSize, pool.length)
      picked = Array.from({ length: n }, (_, i) => pool[(offset + i) % pool.length])
    } else {
      const seen = new Set<string>()
      for (const b of baskets) {
        for (const t of b.top ?? []) {
          const k = t.symbol.toUpperCase()
          if (seen.has(k)) continue
          seen.add(k)
          picked.push({ symbol: t.symbol, address: t.address, chainId: b.chainId, w: t.weightPct || 1 })
          if (picked.length >= 5) break
        }
        if (picked.length >= 5) break
      }
    }
    if (picked.length === 0) return []
    // Deliberately uneven so it reads like a real book, not a demo of equal slices.
    //
    // AND THE SIZES RESHUFFLE (owner 2026-08-03: "a grid of like eight or something…
    // eight or nine. And then they reshuffle sizing randomly"). The shape is ROTATED
    // by the same offset that rotates the window, so on every cycle a different asset
    // takes the big tile and the whole grid re-proportions. Rotation rather than
    // Math.random on purpose: it varies exactly as much, but it is deterministic, so
    // a re-render cannot reshuffle the grid underneath someone mid-hover.
    const shape = [24, 18, 14, 11, 9, 8, 6, 5, 5]
    const weights = picked.map((_, i) => shape[(i + offset) % shape.length] ?? Math.max(2, Math.round(100 / picked.length)))
    const sum = weights.reduce((x, y) => x + y, 0)
    return picked.map((p, i) => {
      // normalised so the shown percentages always total 100 whatever the window size
      const pct = Math.round((weights[i] / sum) * 1000) / 10
      return { symbol: p.symbol, address: p.address, chainId: p.chainId, pct, usd: (total * pct) / 100 }
    })
  }, [baskets, total, pool, offset, windowSize])
}


// Concrete hexes: the dither engine paints to canvas via hexToRgb, which cannot
// resolve a CSS var() string — same values and same reason as PortfolioChart.
const UP = '#35e0ff'
const DOWN = '#ff4db8'

// The window both cards plot: 7 days, /portfolio's own default range. Long
// enough that the 24h anchor honest24hPct insists on always sits inside it, and
// identical across both cards so the peek and the panel below share ONE cached
// fetch set rather than each paying for its own.
const RANGE = '7D' as const
const fullLabel = (t: number) =>
  new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

interface Curve {
  rows: { time: number; value: number; tl: string }[]
  /** The mix's real 24h move. Null when history can't prove one — never a 0. */
  day: number | null
  /** The shown window's own direction; it tints the fill. */
  accent: string
  palette?: { color: string; weight: number }[]
  coveragePct: number
  isLoading: boolean
  /** Paint nothing at all unless this is true. */
  has: boolean
}

/** The example book's REAL history: these assets, at these weights, valued
 *  through per-asset price history. The combination is scale-invariant, so the
 *  percentage it yields is a fact about the MIX and owes nothing to the
 *  illustrative total the curve is anchored to. */
function useExampleCurve(rows: ExampleRow[], totalUsd: number): Curve {
  const assets = useMemo<PortfolioHistoryAsset[]>(
    () => rows.map((r) => ({ chainId: r.chainId, address: r.address, valueUsd: r.usd })),
    [rows],
  )
  const { points, coveragePct, isLoading } = usePortfolioHistory(assets, totalUsd, RANGE)
  // The mix's own identity colours, weight-proportioned — the fill wears the
  // bento's colours (the convention BasketSpark and PortfolioChart both follow).
  const palette = useMemo(() => {
    const top = [...rows]
      .filter((r) => r.usd > 0)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5)
    return top.length >= 2
      ? top.map((r) => ({ color: tokenVisual(r.symbol, r.address).color, weight: r.usd }))
      : undefined
  }, [rows])
  return useMemo(() => {
    const has = points.length >= 2 && coveragePct > 0
    if (!has) return { rows: [], day: null, accent: UP, palette, coveragePct, isLoading, has: false }
    const first = points[0].value
    const last = points[points.length - 1].value
    const move = first > 0 ? ((last - first) / first) * 100 : null
    return {
      rows: points.map((p) => ({ time: p.time, value: p.value, tl: fullLabel(p.time) })),
      day: honest24hPct(points),
      accent: move != null && move < 0 ? DOWN : UP,
      palette,
      coveragePct,
      isLoading,
      has: true,
    }
  }, [points, coveragePct, isLoading, palette])
}

interface Quote {
  /** Real last-traded USD price. 0 = no readable history; formatPrice renders
   *  the house '—' for that, which is the truthful answer, not a made-up one. */
  price: number
  /** Real 24h move through the same honesty guard the cards use, or null. */
  day: number | null
  /** Real change across the WHOLE fetched window (7 days), first sample to last.
   *  Used to choose which assets the hero shows — see pickWinners. Null when the
   *  series is too short to state one, never 0. */
  week: number | null
}

const quoteKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

/** REAL spot price and REAL 24h per asset, read straight off the per-asset
 *  history cache the curve above already fills: the query keys here are
 *  byte-identical to the ones usePortfolioHistory issues for the same assets and
 *  the same range, so this hook adds no network call of its own.
 *
 *  It exists because the shared holdings row prints a price and a daily move,
 *  and the alternative was inventing both next to a real ticker — the one thing
 *  this panel does not do. Unreadable history degrades to '—', never to a
 *  plausible-looking number. */
/** Only needs an address and a chain, so it is typed for the minimum rather than for
 *  ExampleRow: the hero quotes its whole POOL to rank it, and pool entries have no
 *  weight or dollar value yet. */
function useExampleQuotes(rows: { chainId: number; address: string }[]): {
  quotes: Map<string, Quote>
  /** Every pool query answered (data or error) — ranking may run. */
  settled: boolean
} {
  const results = useQueries({
    queries: rows.map((r) => ({
      queryKey: ['spectrum', 'assetHist', r.chainId, r.address.toLowerCase(), RANGE],
      // Lowercased like the planner's own call, so whichever hook wins the race
      // for a shared key issues the identical request.
      queryFn: () => fetchAssetHistory(r.chainId, r.address.toLowerCase(), RANGE, null),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
    })),
  })
  const settled = results.length > 0 && results.every((q) => q.isSuccess || q.isError)
  const sig = rows.map((r) => quoteKey(r.chainId, r.address)).join('|')
  const stamp = results.map((q) => q.dataUpdatedAt).join(',')
  const quotes = useMemo(() => {
    const m = new Map<string, Quote>()
    rows.forEach((r, i) => {
      const s = results[i]?.data ?? []
      m.set(quoteKey(r.chainId, r.address), {
        price: s.length > 0 ? s[s.length - 1].value : 0,
        day: honest24hPct(s),
        // first-to-last across the 7D window. Two samples minimum; a single point
        // cannot express a change and says so with null rather than 0.
        week: s.length >= 2 && s[0].value > 0 ? ((s[s.length - 1].value - s[0].value) / s[0].value) * 100 : null,
      })
    })
    return m
  }, [sig, stamp]) // eslint-disable-line react-hooks/exhaustive-deps
  return { quotes, settled }
}


/** The 24h readout: the mix's own move over the last day, or nothing at all.
 *  Never a placeholder, never a zero standing in for "we don't know". */
function DayMove({ day, size = 'sm' }: { day: number | null; size?: 'sm' | 'md' }) {
  if (day == null) return null
  return (
    <span className="inline-flex items-baseline gap-2">
      <span
        className={`font-num font-semibold tabular-nums ${size === 'md' ? 'text-xl' : 'text-base'}`}
        style={{ color: day < 0 ? DOWN : UP }}
      >
        {formatPct(day)}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">24h</span>
    </span>
  )
}

/** A basket as a CONVICTION card (owner 2026-08-02 17:01: "show the chart for
 *  each one of these as well… the amount of people that hold it and the TVL").
 *  No prose: the chart is the argument, the numbers are the proof. */
export function ConvictionCard({ b, i }: { b: BasketSummary; i: number }) {
  const vis = tokenVisual(b.symbol, b.address)
  const legs = (b.top ?? []).map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct }))
  return (
    <Reveal delay={i * 70} className="h-full">
      <Bezel className="h-full transition-transform duration-500 hover:-translate-y-1" glow={vis.color}>
        <div className="flex h-full flex-col p-6">
          {/* TICKER AND NETWORK ON ONE LINE (2026-08-05 QOL round #1: "the
              homepage never says which chain a basket lives on until you open
              it"). Three networks are live, so the network is part of a basket's
              name, not a footnote — the badge used to sit on a second line under
              the ticker, where it read as an afterthought. Beside the ticker it
              states the same pair the basket's own page header states, in the
              same order.
              Still the app's real ChainBadge: the ticker truncates and the badge
              never shrinks, so a long name can't push the network off the card. */}
          <div className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-display text-lg font-bold text-ink">${showSymbol(b.symbol)}</span>
              <ChainBadge chainId={b.chainId} className="shrink-0" />
            </span>
            {b.change24hPct != null && (
              <span
                className="font-num text-sm font-semibold tabular-nums"
                style={{ color: b.change24hPct >= 0 ? 'var(--color-teal)' : 'var(--color-magenta)' }}
              >
                {b.change24hPct >= 0 ? '+' : '−'}
                {Math.abs(b.change24hPct).toFixed(1)}%
              </span>
            )}
          </div>

          {/* THE CHART — the real reconstructed 24h shape, same engine the
              basket pages use, so this is history and not decoration */}
          <div className="pointer-events-auto mt-5 h-14">
            <BasketSpark
              chainId={b.chainId}
              assets={legs.map((t) => ({ address: t.address, weight: t.weightPct }))}
              navPerToken={b.navPerToken}
              fallback={b.navSeries}
              range="24H"
              address={b.address}
              symbol={b.symbol}
              legs={legs}
            />
          </div>

          <div className="mt-5 flex-1">
            <BasketBento
              items={legs.map((t) => ({ ...t, chainId: b.chainId }))}
              aspect={2.2}
            />
          </div>

          {/* the proof: what it holds, who holds it, what it is worth */}
          <div className="mt-6 grid grid-cols-3 gap-4 border-t border-white/8 pt-4">
            <span>
              <span className="block font-num text-sm font-semibold tabular-nums text-ink">{b.basketLength}</span>
              <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">assets</span>
            </span>
            <span>
              <span className="block font-num text-sm font-semibold tabular-nums text-ink">
                {b.holdersCount != null ? b.holdersCount : '—'}
              </span>
              <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">holders</span>
            </span>
            <span className="text-right">
              <span className="block font-num text-sm font-semibold tabular-nums text-ink">
                {formatUsdCompact(b.aumUsd)}
              </span>
              <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">value</span>
            </span>
          </div>
        </div>
      </Bezel>
    </Reveal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HERO BENTO (owner 2026-08-02 ~22:15: "the homepage needs to really be
// reworked to have a lot more bento grid elements to it as thats now become the
// core of the portfolio page in both the view of your assets and how you
// rebalance… make a giant beautiful bento grid layout using 60-70% of width which
// sits half over the hero viewport and half in the next section, make it stunning").
//
// WHY A BENTO IS THE RIGHT HERO OBJECT NOW, and this is his argument not mine: the
// bento stopped being decoration on the portfolio page and became the SURFACE —
// it is how you read what you hold AND how you dial a rebalance. So the homepage
// showing one is showing the product, not an illustration of it. That is the same
// reuse-real-product rule that killed the drawn glyphs.
//
// It renders the app's OWN BasketBento (specallocator's, shared) with the money
// footer they added at ~21:2x, so the tiles carry amounts and 24h change exactly as
// they do on /portfolio. One component, one behaviour, no homepage lookalike.
//
// HONESTY, unchanged from the panel below it: the assets, the networks, the weights
// and the 24h moves are REAL, read from live baskets. The dollar amounts are
// illustrative and the card says so. Renders NOTHING with no readable baskets — a
// fresh operator install must not show a fabricated portfolio.
// ─────────────────────────────────────────────────────────────────────────────

/** Half of the bento's own height, expressed as a percentage of its WIDTH.
 *
 *  A percentage margin resolves against the containing block's WIDTH, which is
 *  exactly what makes this self-maintaining: height = width / ASPECT, so half the
 *  height is width / (2 × ASPECT). At any viewport the overlap stays exactly half,
 *  with no magic pixel value to re-tune when the width changes. (My own lesson:
 *  a fixed negative pull under an svh hero eats the buttons on short viewports.) */
export const HERO_BENTO_ASPECT = 2.6

/** How far the panel rides up over the hero, as a percentage of its own WIDTH.
 *
 *  HALF THE PANEL'S HEIGHT AGAIN (owner 1826: "move the portfolio card up so
 *  it's halfway over the hero and halfway over the next section" — his
 *  original 22:15 ask, re-instated). The pull's history matters here: the
 *  half-height version broke once before, when the hero shrank to 46/52svh
 *  and the pull reached past the art and OVERLAPPED THE HEADLINE AND THE CTAs
 *  ("this all overlaps, you need to push the bento card down"), and it spent
 *  three days as a modest 2.5% crossing because of that.
 *
 *  What makes half-height safe THIS time is structural, not tuned: the hero
 *  section now RESERVES the overlap zone as its own bottom padding
 *  (HERO_BENTO_RESERVE_CLASS below) — the copy ends above the reserve, the
 *  art (inset-0) extends over it, and the card rides up into room that
 *  belongs to it. The pull can no longer reach the copy at ANY viewport
 *  because the reserve is derived from the same arithmetic that sizes the
 *  pull (pins in hero-bento.test.ts).
 *
 *  This margin applies INSIDE the panel's own width container, so the
 *  percentage resolves against the panel's width: half its height is exactly
 *  100 / (2 × ASPECT) — 19.23% — at every viewport, no magic pixels. */
export const HERO_BENTO_OVERLAP_PCT = 19.23
export const HERO_BENTO_OVERLAP_CLASS = 'lg:[margin-top:-19.23%]'

/** The panel's lg breakout: its width is this × the page container (capped just
 *  inside the viewport). The literal 114% in HERO_BENTO_CONTAINER_CLASS and this
 *  constant are pinned together in hero-bento.test.ts. */
export const HERO_BENTO_BREAKOUT = 1.14
export const HERO_BENTO_CONTAINER_CLASS =
  'relative left-1/2 w-full -translate-x-1/2 px-4 sm:px-6 lg:w-[min(114%,calc(100vw-3rem))] lg:px-0'

/** The room the HERO reserves for the crossing, as its own bottom padding —
 *  applied to the hero <section> by HomeSpine.
 *
 *  Derivation: percentage padding resolves against the containing block's
 *  width (the page container, C). The panel is at most BREAKOUT × C wide, so
 *  its half-height pull is at most BREAKOUT / (2 × ASPECT) = 1.14 / 5.2 =
 *  21.923% of C — the reserve equals that worst case. Where the viewport cap
 *  binds instead (the panel is narrower than 1.14 × C), the actual pull is
 *  smaller and the difference becomes extra air below the copy, never a
 *  collision. The fixed clearance floor between the copy and the card is the
 *  hero's own inner pb-16, which sits ABOVE this reserve. lg-only, exactly
 *  like the pull it mirrors. */
export const HERO_BENTO_RESERVE_CLASS = 'lg:pb-[21.923%]'

/** How often a tile swaps out. Slow enough to read as a portfolio breathing rather
 *  than a slideshow; the owner's ask was "constantly load in one or two new assets
 *  and shuffle them about based on their percentages… so people get an idea that oh,
 *  this is like a moving portfolio". */
const BENTO_CYCLE_MS = 4200
/** Choose which assets the hero shows: the ones that have genuinely RISEN over the
 *  window (owner 2026-08-03: "just use a basket of assets that have done well over the
 *  last 7 days").
 *
 *  EVERY NUMBER STAYS TRUE. This selects real assets by their real measured 7-day
 *  change and shows their real history — it does not touch a single price. That is the
 *  difference between choosing a favourable example and fabricating one, and it is why
 *  this was his call to make rather than mine.
 *
 *  Ranked best-first and filtered to actual gainers. If nothing rose — a genuinely red
 *  week — it returns the whole pool ranked rather than an empty panel: a flat or
 *  falling market is allowed to look like one. We never invent a winner.
 *
 *  Assets with no readable history sort last rather than being dropped, so a thin
 *  market cannot empty the panel either. */
function pickWinners<T extends { symbol: string; address: string; chainId: number }>(
  pool: T[],
  quotes: Map<string, Quote>,
): T[] {
  const withPerf = pool.map((p) => ({ p, week: quotes.get(quoteKey(p.chainId, p.address))?.week ?? null }))
  const ranked = [...withPerf].sort((a, b) => (b.week ?? -Infinity) - (a.week ?? -Infinity))
  const gainers = ranked.filter((r) => r.week != null && r.week > 0)
  const picked = (gainers.length > 0 ? gainers : ranked).map((r) => r.p)
  // THE PERSONALITY RULE outranks raw performance (owner ~16:2x, then ~16:3x
  // when the first fix missed this mount: "STILL SHOWS THE WETH/WBTC"):
  // wrapped majors and stables are plumbing, not a portfolio anyone chose —
  // they go to the BACK of the pool, so the visible window is stocks + the
  // chain's own tokens and plumbing only appears when nothing else is left.
  // Stable partition: real measured order preserved within each half.
  return [
    ...picked.filter((p) => !PLUMBING.has(p.symbol.toUpperCase())),
    ...picked.filter((p) => PLUMBING.has(p.symbol.toUpperCase())),
  ]
}

/** Tiles on screen at once. The pool behind it is every asset the live baskets hold,
 *  so the rotation has somewhere to rotate TO. */
const BENTO_WINDOW = 9
/** Phones show FEWER, BIGGER tiles (mobile sweep 2026-08-06): nine tiles in a
 *  ~312x120 strip truncated five of eight tickers to "B…"/"G…" and pushed the
 *  percentage onto a second line where it struck through the amount. The panel
 *  is a picture of a portfolio, and an unreadable tile is not one. */
const BENTO_WINDOW_PHONE = 5

export function HeroBento({ baskets }: { baskets: BasketSummary[] }) {
  const TOTAL = 128_400

  // THE POOL: every distinct asset the live baskets hold, not just the first few.
  // The window rotates over this, which is what gives the panel life.
  const pool = useMemo(() => {
    const seen = new Set<string>()
    const out: { symbol: string; address: string; chainId: number; w: number }[] = []
    for (const b of baskets) {
      for (const t of b.top ?? []) {
        const k = `${b.chainId}:${t.address.toLowerCase()}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ symbol: t.symbol, address: t.address, chainId: b.chainId, w: t.weightPct || 1 })
      }
    }
    return out
  }, [baskets])

  // A LIVING BENTO (owner 2026-08-03: "it should basically constantly be like load in
  // one or two new assets and shuffle them about based on their percentages… so people
  // get an idea that oh, this is like a moving portfolio").
  // Every few seconds the window advances, so a tile leaves, a new asset arrives, and
  // the weights re-proportion around it. `animateLayout` makes the remaining tiles
  // GLIDE to their new geometry rather than jumping, which is the whole difference
  // between a portfolio breathing and a slideshow.
  // Reduced motion holds one frame: this is decoration and must never be the only way
  // to read what the panel says.
  const reduced = usePrefersReducedMotion()
  const [offset, setOffset] = useState(0)

  // Quote the WHOLE pool so the ranking is real, then rotate the window over the
  // winners. Same query keys as the chart and the tiles, so this shares their cache
  // rather than adding a second wave of requests.
  //
  // RANK ONCE, WHEN SETTLED (owner ~16:0x: assets "stack on top of each other
  // when it loads, looks like you have two portfolios one with stocks the
  // other with crypto"): pickWinners re-sorted on EVERY answered quote, so as
  // histories streamed in the window's membership churned wholesale — the
  // crypto-ranked board and the stocks-ranked board swapping mid-glide read
  // as two portfolios colliding. Until every pool query answers, the window
  // holds the pool's natural (stable) order; the ONE re-rank happens settled.
  const { quotes, settled } = useExampleQuotes(pool)
  const winners = useMemo(() => (settled ? pickWinners(pool, quotes) : pool), [settled, pool, quotes])

  // The rotation also waits for the settled ranking — ticking the window over
  // an order about to be replaced multiplied the churn.
  const wide = useMinWidth(640)
  const windowSize = wide ? BENTO_WINDOW : BENTO_WINDOW_PHONE
  const canRotate = !reduced && settled && pool.length > windowSize
  useEffect(() => {
    if (!canRotate) return
    const t = window.setInterval(() => setOffset((o) => (o + 1) % pool.length), BENTO_CYCLE_MS)
    return () => window.clearInterval(t)
  }, [canRotate, pool.length])

  const rows = useExampleRows(baskets, TOTAL, winners, offset, windowSize)
  const curve = useExampleCurve(rows, TOTAL)

  // The chart EMITS its progress readout rather than drawing it (owner 2026-08-03:
  // "move that under the port number area"). PortfolioChart already supports this —
  // pass onReadout and it suppresses its own block so the host can place it.
  const [readout, setReadout] = useState<ChartReadout | null>(null)

  // BUILT EXACTLY AS THE PORTFOLIO PAGE BUILDS IT (owner: "the bento grid layout
  // isn't taken directly from the portfolio page like it should"). He was right —
  // I had passed only the amount and the 24h move, and left out the CHART LINK and
  // its real venue brand mark, which is a third of what a tile carries on
  // /portfolio. Same call shape as Yours.tsx's picture view now, item for item, so
  // the two surfaces cannot describe an asset differently.
  const items = useMemo(
    () =>
      rows.slice(0, 12).map((r) => {
        const q = quotes.get(quoteKey(r.chainId, r.address))
        const link = chartLinksFor(r.chainId, r.address)[0]
        return {
          // chain-qualified: the bento keys by ADDRESS unless told otherwise,
          // and native ETH shares one sentinel address across chains — the
          // found step's tile-stacking bug (5ea8cb8), same fix here.
          id: `${r.chainId}:${r.address.toLowerCase()}`,
          symbol: r.symbol,
          address: r.address,
          weightPct: r.pct,
          chainId: r.chainId,
          footer: {
            amount: formatUsdCompact(r.usd),
            // a REAL move; a null one is omitted rather than drawn as flat
            change24hPct: q?.day ?? null,
            href: link?.href,
            hrefLabel: link ? `${link.label}: $${showSymbol(r.symbol)}` : undefined,
            markSrc: link?.mark,
          },
        }
      }),
    [rows, quotes],
  )

  // The shape PortfolioChart consumes, from the same real rows the tiles show.
  const historyAssets = useMemo<(PortfolioHistoryAsset & { symbol: string })[]>(
    () => rows.map((r) => ({ chainId: r.chainId, address: r.address, valueUsd: r.usd, symbol: r.symbol })),
    [rows],
  )

  if (rows.length === 0) return null

  return (
    /* WIDER (owner: "that card needs way more width"). 94%, so the panel is the
       page's widest object and the twelve tiles have room to be read rather than
       recognised. Full width on small screens; the OVERLAP is lg-only. */
    /* 15% MORE WIDTH (owner ~16:0x): the panel now BREAKS OUT of the page
       container — centred with the left-1/2 idiom (mx-auto cannot centre a
       width beyond 100%), capped just inside the viewport so it never scrolls
       sideways. Small screens keep the full-width flow. */
    <div className={HERO_BENTO_CONTAINER_CLASS}>
      {/* lg-only overlap: an inline style would beat the breakpoint, so this is a
          static arbitrary class. On small screens the bento simply flows. */}
      <div className={`relative ${HERO_BENTO_OVERLAP_CLASS}`}>
        {/* THE LIFT. A panel straddling a boundary has to read as floating OVER
            it rather than colliding with it, and that is done with light, not with
            a border: a wide spectral bloom behind the panel and a deep shadow
            under it. Both are decorative, so both are aria-hidden and neither can
            affect layout (absolutely positioned, negative z). */}
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-x-12 -bottom-16 -top-8 -z-10 rounded-[4rem] opacity-30 blur-[80px]"
          style={{ background: SPECTRAL }}
        />
        <Reveal>
          <Bezel
            glow="var(--color-violet)"
            panel="bg-void/95"
            className="showcase-shadow"
          >
            {/* the prism runs the full top edge — the house mark for the one
                object on a page that matters most (the publish card and the
                popup's own header use exactly this) */}
            <span aria-hidden className="absolute inset-x-0 top-0 z-10 h-px" style={{ background: SPECTRAL }} />

            <div className="relative p-6 sm:p-10">
              {/* MONEY LEFT, CHART RIGHT (owner 2026-08-03: "i wanted the price
                  chart to sit on the right hand side of the price not below it for
                  the homepage").
                  It stacked before because /portfolio stacks them — but that page
                  has a whole viewport for its hero and this is one panel, where
                  stacking pushed the tiles below the fold. Side by side, the total
                  and its history read as one statement.
                  Hierarchy is unchanged and still the honest order: the label says
                  what the number IS before you meet the number.
                  The chart column is the wider of the two, because an axis and eight
                  date ticks need room; on small screens they stack, since a chart in
                  half a phone is unreadable. */}
              {/* THE TOTAL IS THE FIRST THING, TOP LEFT, and big (owner
                  2026-08-03: "make the total port number bigger and move it up to
                  the top left corner and remove the example text").
                  The wordy label that used to sit above it is gone, so the number
                  itself is now the panel's opening mark rather than the third thing
                  you read. The chart shrinks to sit beside it as support rather than
                  as a second subject.
                  The dollar anchor is INVENTED (the assets, networks, weights and
                  24h moves are real from live baskets; the total is not) and
                  carries NO marker here — his ruling, honored in full; confirmed
                  against the live DOM 2026-08-03 evening. The page's one surviving
                  marker is IntroArt's 9px "example" on the interactive weights
                  card, disclosing that card's demo money — a different mount,
                  accepted at review. */}
              {/* THE BENTO ITSELF — the app's own component, at hero scale, with a
                  hairline above it so the money and the picture read as two
                  registers of one object rather than two stacked things. */}
              <div>
                {/* INTERACTIVE (owner: "also interactive"). `expandable` is the bento's
                    OWN hover-preview behaviour — the same one the showcase panel
                    below uses — so a tile opens its 7d preview card in place. Not a
                    new interaction invented for the homepage. */}
                <BasketBento items={items} aspect={wide ? HERO_BENTO_ASPECT : 1.6} expandable animateLayout />
              </div>

              <div className="mt-8 grid gap-8 border-t border-white/8 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-12">
                <div>
                  {/* THE 24H SITS JUST ABOVE THE VALUE and the value drops down
                      (owner ~16:1x: "move the portfolio card value down and
                      move +2.74% 24h to just above it") — the day's move reads
                      first as the small fact, then the number lands under it. */}
                  <div className="mb-3">
                    <DayMove day={curve.day} size="md" />
                  </div>
                  {/* THE NUMBER FITS ITS BOX (mobile sweep 2026-08-06): at
                      text-7xl the six digits measured 306px inside a 264px
                      cell, so the panel's own clip cut the last digit — the
                      headline figure of the homepage's headline object,
                      reading "$128,40". The phone step drops to 5xl (and the
                      currency mark with it); sm+ is unchanged. */}
                  <span className="flex items-baseline">
                    <span className="mr-2 font-num text-3xl font-light text-ink-faint sm:mr-3 sm:text-5xl">$</span>
                    {/* FLUID, not a step (owner 2026-08-06 23:13: "the 128,400
                        text on the Galaxy Fold clips the title, which needs to
                        be fixed"). A fixed phone step still clips at 320px —
                        the narrowest live Android — so the figure scales with
                        the viewport and simply cannot outgrow its box; sm+
                        keeps the 8xl display size. */}
                    {/* ⚠ ONE fluid rule, no sm: class — an inline fontSize beats
                        any Tailwind step, so a `sm:text-8xl` beside this would
                        be silently dead. The clamp's ceiling IS 8xl (6rem). */}
                    <span
                      className="font-num font-light leading-[0.88] tracking-tight tabular-nums text-ink"
                      style={{ fontSize: 'clamp(2rem, 1rem + 6.4vw, 6rem)' }}
                    >
                      {TOTAL.toLocaleString('en-US')}
                    </span>
                  </span>
                  {/* THE PROGRESS READOUT, under the number where he asked for it:
                      what the mix was worth when the window opened, and how it
                      travelled to now. Emitted by the chart, so the figures cannot
                      disagree with the curve beside them. */}
                  {readout && readout.changePct != null && (
                    <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink">
                        started with {formatUsdCompact(readout.startUsd)}
                      </span>
                      <span
                        className="font-num text-sm font-semibold tabular-nums"
                        style={{ color: readout.changePct < 0 ? DOWN : UP }}
                      >
                        {readout.deltaUsd < 0 ? '−' : '+'}
                        {formatUsdCompact(Math.abs(readout.deltaUsd))}
                      </span>
                      <span
                        className="font-num text-sm tabular-nums"
                        style={{ color: readout.changePct < 0 ? DOWN : UP }}
                      >
                        {readout.changePct >= 0 ? '+' : '−'}
                        {Math.abs(readout.changePct).toFixed(2)}%
                      </span>
                      <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
                        {readout.range}
                      </span>
                    </div>
                  )}
                </div>

                {/* the portfolio page's own chart, smaller: support beside the number
                    rather than a second subject competing with it */}
                <div className="min-w-0">
                  <PortfolioChart assets={historyAssets} totalUsd={TOTAL} heightClass="h-32" onReadout={setReadout} hideCoverage />
                </div>
              </div>

            </div>
          </Bezel>
        </Reveal>
      </div>
    </div>
  )
}
