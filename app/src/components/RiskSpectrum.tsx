import { useEffect, useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { AssetLogo } from './AssetLogo'
import { BasketAvatar } from './BasketAvatar'
import { InfoDot } from './InfoDot'
import { formatUsdCompact } from '../lib/spectrum/format'
import { capLabel, TIER_LABELS, TIER_ORDER, TIER_RAMP, TIER_THRESHOLDS, type MarketTier } from '../lib/spectrum/market-tiers'

// ─────────────────────────────────────────────────────────────────────────────
// THE RISK SPECTRUM — your assets standing where they actually sit (owner
// 2026-08-02 18:51: "it would be so cool if we display the logos of the assets
// you have above that bar… so instead of just being safer and riskier, it shows
// you in terms of conservative to risk where your assets are actually weighted
// on the bar, rather than just be a flat bar").
//
// HOW TO READ IT — two encodings, both facts, neither a score:
//   · WHERE a logo sits along the axis = that asset's market-cap tier. Left is
//     cash and the majors, right is the launch bucket.
//   · HOW BIG the logo is = that asset's share of the portfolio. His point was
//     that a position growing into a larger share is what makes the portfolio
//     riskier overall, so the thing that grows on screen is the size of the
//     mark that sits on the risky end.
//
// The tier bar keeps its place beneath as the aggregate: the logos say WHICH
// assets and WHERE, the bar says HOW MUCH in each band. One reads the other.
//
// HONESTY: an asset whose market cap will not read is `unranked` and is drawn
// OUTSIDE the axis, in neutral grey, never guessed onto a position. Nothing
// here rates the portfolio — position is a market-value fact and size is a
// share, which is the line the owner drew himself (facts only, 00:49).
// ─────────────────────────────────────────────────────────────────────────────

export interface SpectrumAsset {
  key: string
  symbol: string
  address: string
  chainId: number
  valueUsd: number
  pct: number
  tier: MarketTier
  isBasket?: boolean
}

/** The plotted tiers, in order, excluding `unranked` — which has no position on
 *  a market-cap axis and is listed separately rather than invented onto one. */
const AXIS: MarketTier[] = TIER_ORDER.filter((t) => t !== 'unranked')

/** Logo size from share of portfolio. Square-rooted so AREA tracks the share
 *  rather than the diameter — a diameter-linear scale makes a 4% position look
 *  four times a 1% one when it should look twice. Floored so a small position
 *  is still identifiable, capped so one whale cannot swallow the row. */
function sizeFor(pct: number): number {
  const MIN = 22
  const MAX = 52
  return Math.round(MIN + (MAX - MIN) * Math.sqrt(Math.min(100, Math.max(0, pct)) / 100))
}

/** A HELD POSITION NEVER READS AS ZERO (the owner 2026-08-06 12:58, "the 0%…
 *  shouldn't happen"). Rounding a real sub-half-percent holding to "0%" tells
 *  the one lie this axis exists to avoid — that there is nothing there. Below
 *  the rounding floor the mark says "<1%", which is the true statement. */
function sharePct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '—'
  return pct < 0.5 ? '<1%' : `${pct.toFixed(0)}%`
}

export function RiskSpectrum({
  assets,
  tierBar,
}: {
  assets: SpectrumAsset[]
  tierBar: { tier: MarketTier; usd: number; pct: number }[]
}) {
  // COMPACT AT REST — state ABOVE the early return (the hook law; the gate's
  // own first catch on my surface: a book that mounts empty and then loads
  // would have re-rendered with two extra hooks and error-boundaried).
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hover || pinned
  // a pinned detail owns Escape (QOL round 5) — the chevron opened it, the
  // key closes it; listener exists only while pinned, and a consumed Escape
  // never bubbles into a host dialog's own dismiss
  useEffect(() => {
    if (!pinned) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setPinned(false)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [pinned])

  const plotted = assets.filter((a) => a.tier !== 'unranked' && a.valueUsd > 0.005)
  const unranked = assets.filter((a) => a.tier === 'unranked' && a.valueUsd > 0.005)
  if (plotted.length === 0 && tierBar.length === 0) return null

  // ONE COLUMN PER TIER: the logos and the bar segment are the SAME flex item,
  // so a logo is over its own band BY CONSTRUCTION. The first cut laid the
  // logos on evenly-spaced bands while the bar sized itself proportionally, so
  // the two disagreed and NVDA stood over "ETH & BTC" instead of "stocks" — a
  // chart that lies about the very thing it exists to show. Alignment must be
  // structural, never a calculation that can drift from the thing it mirrors.
  const columns = AXIS.map((tier) => ({
    tier,
    bar: tierBar.find((g) => g.tier === tier) ?? null,
    assets: plotted.filter((a) => a.tier === tier).sort((x, y) => y.valueUsd - x.valueUsd),
  })).filter((c) => c.bar || c.assets.length > 0)

  // THE OVERALL READ (owner ~11:0x: this area "doesn't do a good enough job
  // showing how much overall risk you're taking"). One factual headline: how
  // much money sits on the RISKIER half of the axis (mid caps and smaller —
  // the axis's own ends name the halves, so this is a position on the stated
  // market-cap scale, not a score; the facts-only line holds).
  const SAFER: MarketTier[] = ['cash', 'stocks', 'majors', 'large']
  const ranked = tierBar.filter((g) => g.tier !== 'unranked')
  const rankedUsd = ranked.reduce((s2, g) => s2 + g.usd, 0)
  const riskierUsd = ranked.filter((g) => !SAFER.includes(g.tier)).reduce((s2, g) => s2 + g.usd, 0)
  const riskierPct = rankedUsd > 0 ? (riskierUsd / rankedUsd) * 100 : 0
  // THE COVERAGE GATE (chaos probe, 2026-08-04 — the since-line's subset-
  // relative lesson, same class): with the market feed dark, everything
  // mcap-ranked goes unranked while cash/majors/stocks still classify by
  // symbol — and the headline then said "0% of your money at the riskier
  // end", a SAFETY VERDICT derived from failed reads. The sentence says
  // "of your money", so its denominator must BE your money: below 80%
  // ranked coverage the percent is withheld and the gap is said instead.
  const allUsd = tierBar.reduce((s2, g) => s2 + g.usd, 0)
  const rankedCoverage = allUsd > 0 ? rankedUsd / allUsd : 0
  const headlineHonest = rankedUsd > 0 && rankedCoverage >= 0.8

  // COMPACT AT REST (same note: "it should take up less space when not
  // hovered"): the resting state is one slim stacked strip + the headline;
  // hovering (or the chevron, for touch/keyboard) expands the full spectrum.
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {/* "Where your money sits" → "Your risk curve" at a step up in size
            (the owner 2026-08-06 12:49 #12) — sized with the hero's "Your
            portfolio", so the two section names on the page read as a pair. */}
        <p className="font-mono text-[13px] uppercase tracking-[0.16em] text-ink-faint">
          Your risk curve
          <InfoDot>
            Each asset stands at its market-cap band and is drawn to its share of your portfolio,
            so a position growing into a bigger slice grows on the riskier end of this line. Small
            caps sit above {capLabel(TIER_THRESHOLDS.small)} of market value and new
            &amp; micro below it. A measurement of where your money is, never a rating of it.
          </InfoDot>
        </p>
        {/* the headline fact — the answer to "how much risk am I taking",
            in the axis's own words */}
        {headlineHonest ? (
          /* THE ANSWER, at reading size (owner ~11:1x: "make this text easier
             / more obvious your risk level") — a plain sentence with the
             number as its own subject, not a small-caps whisper. Ink stays
             neutral: the palette is part of the claim, and this is a
             position on the stated scale, not a warning. */
          <span className="ml-auto flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <span className="font-num text-2xl font-semibold leading-none tabular-nums text-ink">
              {riskierPct.toFixed(0)}%
            </span>
            <span className="text-[14px] leading-snug text-ink-dim">
              of your money at the riskier end ·{' '}
              <span className="font-num font-semibold tabular-nums text-ink">{formatUsdCompact(riskierUsd)}</span>
            </span>
          </span>
        ) : allUsd > 0 ? (
          /* the coverage gate's honest face: too much of the book unplaced
             for a whole-book percent — say the gap, never a verdict */
          <span className="ml-auto text-[13px] leading-snug text-ink-faint">
            {Math.round((1 - rankedCoverage) * 100)}% of the book has no readable market value right now, so no overall figure
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setPinned((v) => !v)}
          aria-expanded={open}
          aria-controls="risk-spectrum-detail"
          aria-label={open ? 'Collapse the risk spectrum' : 'Expand the risk spectrum'}
          className="press grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/12 text-ink-faint hover:border-cyan/50 hover:text-cyan"
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-3.5 w-3.5 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      {/* THE REST STRIP — the whole story at a glance in 12px: the mix as one
          stacked bar on the tier ramp, ends named. Collapses when the detail
          opens (the bands below say the same thing with labels — one home
          per fact on screen at a time). */}
      <div
        aria-hidden={open}
        className="grid transition-[grid-template-rows,opacity] duration-500 motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? '0fr' : '1fr', opacity: open ? 0 : 1 }}
      >
        <div className="overflow-hidden">
          <div className="mt-2.5 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
            {ranked.map((g) => (
              <span
                key={g.tier}
                title={`${TIER_LABELS[g.tier]} · ${formatUsdCompact(g.usd)} · ${g.pct.toFixed(0)}%`}
                className="h-full transition-[width] duration-500"
                style={{ width: `${rankedUsd > 0 ? (g.usd / rankedUsd) * 100 : 0}%`, background: TIER_RAMP[g.tier] }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">
            <span>safer</span>
            <span>riskier</span>
          </div>
        </div>
      </div>

      {/* THE DETAIL — the full spectrum, on hover or the chevron */}
      <div
        id="risk-spectrum-detail"
        className="grid transition-[grid-template-rows,opacity] duration-500 motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="overflow-hidden">
          {/* PHONE: one tight ROW per band, safest at the top (the mobile
              sweep: the wrapped columns sprawled ~90px of air per band at
              375px — a giant-gaps violation on the exact surface he opens).
              The band chip anchors the row; the logos keep their share-sized
              honesty beside it. Reading order stays safer→riskier. */}
          <div className="mt-3 flex flex-col gap-2 sm:hidden">
            {columns.map((c) => (
              <div key={c.tier} className="flex min-w-0 items-center gap-2.5">
                {/* THE BAND NAME DROPS INSTEAD OF BEING CUT (the owner 2026-08-06
                    12:58: "the mid cap, low cap, whatever needs to go below…
                    because it's cut off, you just see C"). A fixed w-28 with
                    `truncate` clipped three of five labels by construction —
                    "$10,292 · small caps" ended at "small c", which reads as a
                    stray letter rather than a shortened word. The chip sizes to
                    its content now and wraps to a second line when the two
                    facts cannot share one. */}
                <span
                  className="flex min-h-[36px] w-28 shrink-0 flex-wrap items-center justify-center gap-x-1.5 rounded-lg px-2 py-1 text-center"
                  style={{ background: TIER_RAMP[c.tier] }}
                >
                  <span className="font-num text-[10px] font-semibold tabular-nums text-void">
                    {formatUsdCompact(c.bar?.usd ?? 0)}
                  </span>
                  <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-void">
                    {TIER_LABELS[c.tier].toLowerCase()}
                  </span>
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  {c.assets.map((a) => (
                    <span
                      key={a.key}
                      className="flex items-center gap-1"
                      title={`$${showSymbol(a.symbol)} · ${formatUsdCompact(a.valueUsd)} · ${a.pct.toFixed(1)}% · ${TIER_LABELS[a.tier].toLowerCase()}`}
                    >
                      {a.isBasket ? (
                        <BasketAvatar address={a.address} symbol={a.symbol} size={Math.min(36, sizeFor(a.pct))} />
                      ) : (
                        <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={Math.min(36, sizeFor(a.pct))} />
                      )}
                      <span className="font-num text-[9px] font-semibold tabular-nums text-ink-faint">
                        {sharePct(a.pct)}
                      </span>
                    </span>
                  ))}
                </span>
              </div>
            ))}
            <p className="mt-1 text-center font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">
              safer above · riskier below
            </p>
          </div>

          {/* THE SPECTRUM: one column per band, logos over their own segment.
              WRAPS when the bands cannot share one line (390px): min-w-fit
              columns overflowed the page horizontally — the h-overflow law —
              and wrapped columns keep the safer→riskier ORDER as reading order. */}
          <div className="mt-3 hidden w-full flex-wrap items-end gap-x-0.5 gap-y-4 sm:flex">
            {columns.map((c) => (
              <div
                key={c.tier}
                className="flex min-w-fit flex-col items-center transition-[flex-grow] duration-700"
                style={{
                  flexGrow: Math.max(c.bar?.pct ?? 0, 1),
                  flexBasis: 0,
                  transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)',
                }}
              >
                <div className="flex min-h-[64px] flex-wrap items-end justify-center gap-x-2 gap-y-1 px-1">
                  {c.assets.map((a) => (
                    <span
                      key={a.key}
                      className="flex flex-col items-center gap-1"
                      title={`$${showSymbol(a.symbol)} · ${formatUsdCompact(a.valueUsd)} · ${a.pct.toFixed(1)}% · ${TIER_LABELS[a.tier].toLowerCase()}`}
                    >
                      {a.isBasket ? (
                        <BasketAvatar address={a.address} symbol={a.symbol} size={sizeFor(a.pct)} />
                      ) : (
                        <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={sizeFor(a.pct)} />
                      )}
                      <span className="font-num text-[9px] font-semibold tabular-nums text-ink-faint">
                        {sharePct(a.pct)}
                      </span>
                    </span>
                  ))}
                </div>
                {/* the band itself — its own column's foot. Same drop-don't-clip
                    rule as the phone chip above: min-w-fit keeps the desktop
                    columns wide enough today, but overflow-hidden over a nowrap
                    line means any future narrowing loses the word silently
                    rather than wrapping it. */}
                <div
                  className="mt-3 flex min-h-[36px] w-full flex-wrap items-center justify-center gap-x-1.5 rounded-lg px-3 py-1 text-center"
                  style={{ background: TIER_RAMP[c.tier] }}
                >
                  <span className="font-num text-[11px] font-semibold tabular-nums text-void">
                    {formatUsdCompact(c.bar?.usd ?? 0)}
                  </span>
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-void">
                    {TIER_LABELS[c.tier].toLowerCase()}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* THE AXIS, drawn as one (owner ~21:4x) — a ruled line named for
              the measurement; calling it a risk scale would be the score his
              own facts-only rule bars. Phones read top-to-bottom, so their
              caption lives with the rows above. */}
          <div className="mt-3 hidden items-center gap-3 font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint sm:flex">
            <span className="shrink-0">safer</span>
            <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-white/25 to-white/[0.06]" />
            <span className="shrink-0 tracking-[0.16em] text-ink-dim">the market-cap scale</span>
            <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-white/[0.06] to-white/25" />
            <span className="shrink-0">riskier</span>
          </div>

          {/* Unreadable market caps have NO place on a market-cap axis, so
              they are named instead of guessed onto one. */}
          {unranked.length > 0 && (
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              {unranked.map((a) => `$${showSymbol(a.symbol)}`).join(' · ')}: no readable market value, so not placed on this line
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
