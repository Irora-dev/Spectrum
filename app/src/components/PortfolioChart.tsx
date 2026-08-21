import { useEffect, useMemo, useState } from 'react'
import type { ChartRange } from '../lib/spectrum/history'
import { usePortfolioHistory } from '../lib/spectrum/use-portfolio-history'
import type { PortfolioHistoryAsset } from '../lib/spectrum/portfolio-history'
import { formatPct, formatUsdCompact, moneyPrivacyOn } from '../lib/spectrum/format'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { InfoDot } from './InfoDot'
import { AreaChart } from './dither-kit/area-chart'
import { Area as DitherArea } from './dither-kit/area'
import { XAxis as DXAxis } from './dither-kit/x-axis'
import { YAxis as DYAxis } from './dither-kit/y-axis'
import { Tooltip as DTooltip } from './dither-kit/tooltip'
import { useChartPart } from './dither-kit/chart-context'

// ─────────────────────────────────────────────────────────────────────────────
// The hero's value chart (owner 10:32: "a beautiful chart on the hero … using
// the dither chart that actually shows the PnL with a date range"). The dither
// engine wears the mix's own identity colours, weight-proportioned — the same
// convention as BasketChart's constituent gradient.
//
// What the curve IS (and says it is, in the ⓘ): today's combined mix valued
// through real per-asset price history — how what you hold now has moved. Not
// cost-basis PnL: flows in/out of the window aren't netted. Coverage below
// 100% is stated, never smoothed over.
// ─────────────────────────────────────────────────────────────────────────────

// Concrete hexes (mirroring index.css tokens): the dither engine paints to
// canvas via hexToRgb, which cannot resolve a CSS var() string.
// the plane's own accents, resolved live (the InsightCard pattern): the void
// draws its light cyan/magenta, paper draws the violet/berry authority inks —
// hardcoding the void hexes here left the up-line near-invisible on light
// mode (#35e0ff on white ≈ 1.6:1) and reintroduced the hue the 2026-08-19
// re-ink removed. Re-reads on brandchange so the design-mode toggle repaints.
const FALLBACK_UP = '#35e0ff'
const FALLBACK_DOWN = '#ff4db8'
function usePlaneAccents(): { up: string; down: string } {
  const read = () => {
    const cs = getComputedStyle(document.documentElement)
    return {
      up: cs.getPropertyValue('--color-cyan').trim() || FALLBACK_UP,
      down: cs.getPropertyValue('--color-magenta').trim() || FALLBACK_DOWN,
    }
  }
  const [accents, setAccents] = useState(read)
  useEffect(() => {
    const on = () => setAccents(read())
    window.addEventListener('spectrum:brandchange', on)
    return () => window.removeEventListener('spectrum:brandchange', on)
  }, [])
  return accents
}

const RANGES: ChartRange[] = ['24H', '7D', '30D']

function fmtAxis(t: number, range: ChartRange): string {
  const d = new Date(t * 1000)
  if (range === '24H') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fmtFull(t: number): string {
  return new Date(t * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** YOUR ACTIONS ON YOUR OWN LINE (feature 1, ~16:4x round): executed runs
 *  from the device-local exec log, drawn where they happened. The line
 *  finally answers "why did it move HERE" when the answer was "you acted". */
export interface ChartMarker {
  /** milliseconds (Date.now() at completion) */
  ts: number
  kind: 'rebalance' | 'create' | 'publish'
}

const MARK_COLOR: Record<ChartMarker['kind'], string> = {
  rebalance: 'var(--color-cyan)',
  create: 'var(--color-teal)',
  publish: 'var(--color-magenta)',
}
const MARK_LABEL: Record<ChartMarker['kind'], string> = {
  rebalance: 'rebalanced',
  create: 'portfolio built',
  publish: 'published',
}

/** Vertical event ticks on the shared chart context (the dither-kit's
 *  ReferenceLine is horizontal-only; this is its time-axis sibling, kept in
 *  this file because only the portfolio chart draws actions). */
function EventMarks({ markers, times }: { markers: ChartMarker[]; times: number[] }) {
  const ctx = useChartPart('EventMarks')
  if (!ctx.ready || times.length === 0) return null
  const first = times[0]
  const last = times[times.length - 1]
  return (
    <g>
      {markers.map((m, i) => {
        const raw = m.ts / 1000
        // an action from moments ago sits PAST the series' newest point (the
        // curve lags real time by up to a point's spacing) — clamp it to the
        // right edge instead of dropping it; only history before the window
        // is genuinely out of frame
        if (!Number.isFinite(raw) || raw < first) return null
        const sec = Math.min(raw, last)
        // nearest row index — the marker rides the curve's own grid
        let best = 0
        let bestD = Infinity
        for (let j = 0; j < times.length; j++) {
          const d = Math.abs(times[j] - sec)
          if (d < bestD) {
            bestD = d
            best = j
          }
        }
        const x = ctx.xCenter(best) ?? 0
        const h = ctx.plot.height
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: markers are static per render
          <g key={`${m.ts}-${i}`} style={{ color: MARK_COLOR[m.kind] }}>
            <title>{`${MARK_LABEL[m.kind]} · ${fmtFull(sec)}`}</title>
            <line x1={x} x2={x} y1={h - 12} y2={h} stroke="currentColor" strokeWidth={1.5} opacity={0.85} />
            <rect x={x - 2.5} y={h - 17} width={5} height={5} transform={`rotate(45 ${x} ${h - 14.5})`} fill="currentColor" opacity={0.95} />
          </g>
        )
      })}
    </g>
  )
}

function fmtUsdTick(v: number): string {
  // PRIVACY (audit find): the eye masked the hero, the tooltip and every
  // money line - while the y-axis kept printing the portfolio's value in
  // plain digits. Blank ticks under privacy: the curve's shape stays
  // (percent-true), the absolutes leave, consistent with the masked page.
  if (moneyPrivacyOn()) return ''
  const n = Math.abs(v)
  if (!Number.isFinite(v)) return ''
  if (n >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  // 1dp all the way to 100K — a portfolio's ticks often sit inside one $1K
  // band, and rounding them together prints the same label four times.
  if (n >= 1_000) return `$${(v / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  if (n >= 1) return `$${v.toFixed(0)}`
  if (n === 0) return '$0'
  return `$${v.toPrecision(2)}`
}

export interface ChartReadout {
  startUsd: number
  deltaUsd: number
  changePct: number | null
  range: ChartRange
}

/** The loading WOBBLE (owner 2026-08-03 08:34: "showed like a loading kind
 *  of wobble of a chart before it actually loads your real balance") — a
 *  neutral drifting wave standing where the curve will be. Deliberately
 *  unreadable as data: no axis, no dollars, ink-neutral, and it says what it
 *  is. The wave is periodic (100-unit humps) so the 200-unit drift loops
 *  seamlessly; SMIL keeps it self-contained, and reduced-motion gets the
 *  static wave. */
function ChartSkeleton({ quiet = false }: { quiet?: boolean }) {
  const noMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const wave = 'M0,62 q25,-18 50,0 t50,0 t50,0 t50,0 t50,0 t50,0 t50,0 t50,0 t50,0 t50,0 t50,0 t50,0'
  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-lg bg-white/[0.02]"
      role={quiet ? undefined : 'status'}
      aria-label={quiet ? undefined : 'Indexing your holdings'}
      aria-hidden={quiet || undefined}
    >
      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 400 100" aria-hidden>
        <defs>
          <linearGradient id="chart-skel-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.09)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>
        <g>
          {!noMotion && (
            <animateTransform attributeName="transform" type="translate" from="0 0" to="-200 0" dur="7s" repeatCount="indefinite" />
          )}
          <path d={`${wave} V100 H0 Z`} fill="url(#chart-skel-fade)" />
          <path d={wave} className="chart-skel-wave" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" vectorEffect="non-scaling-stroke">
            {!noMotion && <animate attributeName="stroke-opacity" values="0.6;1;0.6" dur="2.4s" repeatCount="indefinite" />}
          </path>
        </g>
      </svg>
      {!quiet && (
        <span className="absolute inset-x-0 bottom-3 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          indexing your holdings…
        </span>
      )}
    </div>
  )
}

interface Props {
  /** The combined mix, symbols included so the dither palette can wear them. */
  assets: (PortfolioHistoryAsset & { symbol: string })[]
  totalUsd: number
  heightClass?: string
  className?: string
  /** TRUE while the host's holdings are still indexing — the skeleton holds
   *  until the asset list is complete, not merely until the current subset's
   *  histories land (08:34: one smooth load). */
  indexing?: boolean
  /** The hero's right block renders the readout (13:57) — when set, the
   *  chart's own header slims to the range switcher + coverage truth. */
  onReadout?: (r: ChartReadout | null) => void
  /** Executed-run event ticks (feature 1) — absent = the chart as before. */
  markers?: ChartMarker[]
  /** THE RANGE LIFT (2106 board: movers follow the window): fires on mount
   *  and on every switch, so a host can keep companion surfaces — the movers
   *  strip — on the SAME window the curve is showing. Absent = unchanged. */
  onRange?: (r: ChartRange) => void
  /** Suppress the partial-coverage line (owner 2026-08-03, on the HOMEPAGE: "remove
   *  the readable history… remove the curve track 61%").
   *
   *  OPT-IN, and absent means unchanged, because on /portfolio that line is
   *  load-bearing honesty about real money — it says the curve only tracks part of
   *  what you actually hold. On the homepage's example panel the same sentence is
   *  noise about an illustrative figure. So the homepage passes this and the real
   *  portfolio keeps its disclosure. */
  hideCoverage?: boolean
  /** THE CURVE ALONE (owner 2026-08-06, the onboarding rework: "the beautiful
   *  chart… without any number"): no header, no readout, no range switcher, no
   *  axes, no tooltip, no coverage line — just the dithered curve. For
   *  ILLUSTRATIVE mounts only (the onboarding demo card); every money surface
   *  keeps its numbers. Absent = byte-identical to before. */
  bare?: boolean
}

export function PortfolioChart({
  assets,
  totalUsd,
  heightClass = 'h-48',
  className = '',
  indexing = false,
  onReadout,
  hideCoverage = false,
  markers,
  onRange,
  bare = false,
}: Props) {
  // phone-width tick thinning (mobile sweep) — read once; a rotation reloads
  const compact = typeof window !== 'undefined' && window.innerWidth < 640
  // the window opens the way you left it (touch round, 2026-08-05) —
  // read-once like the chart's other device-local prefs; a bad value
  // degrades to the default, never to a crash
  const [range, setRange] = useState<ChartRange>(() => {
    try {
      const saved = window.localStorage.getItem('spectrum:chart-range')
      return saved === '24H' || saved === '7D' || saved === '30D' ? saved : '7D'
    } catch {
      return '7D'
    }
  })
  // the lift itself: mount + every switch, one effect so both paths agree
  useEffect(() => {
    onRange?.(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])
  const { points, coveragePct, isLoading, ready } = usePortfolioHistory(assets, totalUsd, range, indexing)

  type Row = { time: number; value: number; tl: string }
  const rows = useMemo<Row[]>(
    () => points.map((p) => ({ time: p.time, value: p.value, tl: fmtFull(p.time) })),
    [points],
  )

  const { up: UP, down: DOWN } = usePlaneAccents()
  const { change, deltaUsd, startUsd, accent } = useMemo(() => {
    if (points.length < 2) return { change: null as number | null, deltaUsd: 0, startUsd: 0, accent: UP }
    const first = points[0].value
    const last = points[points.length - 1].value
    // A percent needs a MEANINGFUL base (the owner live 2026-08-13: the card said
    // "started with $0 · +1.3879061058478332e+27%" — the window opened on one
    // dust-history row worth ~1e-21 dollars, which RENDERS as $0 but divides
    // as 1e-21, and toFixed itself falls back to scientific notation past
    // 1e21). Under a cent there is no story a ratio can tell: the delta is
    // the whole truth, so the percent is null and the card omits it.
    const chg = first >= 0.01 ? ((last - first) / first) * 100 : null
    return { change: chg, deltaUsd: last - first, startUsd: first, accent: chg != null && chg < 0 ? DOWN : UP }
  }, [points, UP, DOWN])

  // The mix's identity colours, weight-proportioned (top 5 carry the gradient).
  const palette = useMemo(() => {
    const top = [...assets]
      .filter((a) => a.valueUsd > 0)
      .sort((a, b) => b.valueUsd - a.valueUsd)
      .slice(0, 5)
    if (top.length < 2) return undefined
    return top.map((a) => ({ color: tokenVisual(a.symbol, a.address).color, weight: a.valueUsd }))
  }, [assets])

  const has = rows.length >= 2

  useEffect(() => {
    if (!onReadout) return
    // no readout until the first settled reveal — a partial curve's numbers
    // flickering on the hero's right block was half the "reloads" look.
    // A null changePct still READS OUT (the zero-base window above): the
    // delta is true and the card must not wave a skeleton forever over a
    // percent that cannot honestly exist.
    onReadout(ready && has ? { startUsd, deltaUsd, changePct: change, range } : null)
  }, [ready, has, change, startUsd, deltaUsd, range]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={className}>
      {/* the readout row sits UP with the total; the plot gets its own air
          below (owner 11:26: "moved up a bit so there's a bit more padding
          between it and the chart area") */}
      {!bare && (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {/* "Progress ⓘ" used to lead this row. When the host wires onReadout
              the numbers it introduced move up to the hero's right block, and
              the word was left standing over nothing — the owner 2026-08-06 12:53,
              "that's just pointless". It renders only where it still labels
              something: the standalone readout below. The caveat rides with
              the numbers, so it goes where they go. */}
          {ready && has && change != null && !onReadout && (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
              Progress
              <InfoDot>
                &ldquo;Started with&rdquo; is what today&rsquo;s mix was worth at the window&rsquo;s
                open, from real per-asset price history — the move is how it travelled to now.
                Money added or removed inside the window isn&rsquo;t netted out, and unreadable
                assets are excluded, never guessed.
              </InfoDot>
            </span>
          )}
          {ready && has && change != null && !onReadout && (
            <>
              {/* his sentence, as a readout (12:02) — lifted to the hero's
                  right block when the host wires onReadout (13:57) */}
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">started with</span>
              <span className="font-num text-sm font-semibold tabular-nums text-ink">{formatUsdCompact(startUsd)}</span>
              <span className="font-num text-sm font-semibold tabular-nums" style={{ color: accent }}>
                {deltaUsd >= 0 ? '+' : '−'}
                {formatUsdCompact(Math.abs(deltaUsd))}
              </span>
              <span className="font-num text-sm font-semibold tabular-nums" style={{ color: accent }}>
                {formatPct(change)}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">past {range}</span>
            </>
          )}
          {isLoading && ready && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" role="status" aria-label="Updating price history" />
          )}
        </div>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => {
                setRange(r)
                try {
                  window.localStorage.setItem('spectrum:chart-range', r)
                } catch {
                  /* private browsing: the pick just does not persist */
                }
              }}
              /* 36 below sm (mobile sweep 2026-08-06 measured 32) — this is the
                 main control on every chart the app owns; desktop keeps 32. */
              className={`press min-h-[36px] rounded-md px-3 py-1.5 font-mono text-xs uppercase tracking-wide sm:min-h-[32px] ${
                range === r ? 'bg-white/12 text-ink' : 'text-ink-faint hover:text-ink-dim'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      )}

      {/* the corner "VALUE" label is RETIRED (the owner 2026-08-06 14:10: "the
          value text is also can be removed as well, that little value text").
          The y-axis is already money-formatted, so the word restated what the
          numbers beside it say — the same one-fact-one-place cut as the
          Progress caption above. */}

      <div className={`relative w-full ${heightClass}`} aria-busy={isLoading}>
        {!ready ? (
          /* ONE smooth load (08:34): the wobble stands in until every
             holding's history has indexed, then the real curve appears once —
             never the partial repaints that read as "the graph reloading".
             BARE mounts wobble WITHOUT the words — the demo card must not
             tell a walletless visitor it is "indexing your holdings"
             (audit 2026-08-06 UX#7). */
          <ChartSkeleton quiet={bare} />
        ) : !has ? (
          bare ? (
            /* an illustrative mount with no history keeps a quiet plate —
               the sentence is honest on money surfaces and absurd on a
               marketing card */
            <div className="h-full w-full rounded-lg bg-white/[0.02]" aria-hidden />
          ) : (
            <div className="grid h-full w-full place-items-center rounded-lg bg-white/[0.02] font-mono text-[11px] uppercase tracking-widest text-ink-faint">
              No price history readable for this mix
            </div>
          )
        ) : (
          /* absolute wrapper — same reason as BasketChart: the canvas engine's
             explicit width must never become the grid track's min-content */
          <div className="absolute inset-0">
            <AreaChart
              data={rows}
              yDomain="data"
              margins={bare ? { top: 6, right: 2, bottom: 6, left: 2 } : { top: 6, right: 2, bottom: 22, left: 56 }}
              config={{ value: { label: 'Portfolio', color: accent, palette } }}
              bloom="low"
              className="h-full w-full"
            >
              {/* fewer ticks on phones — 8 labels collide at 390px */}
              {!bare && <DXAxis dataKey="time" tickFormatter={(t) => fmtAxis(Number(t), range)} maxTicks={compact ? 4 : 8} />}
              {!bare && <DYAxis tickFormatter={(v) => fmtUsdTick(Number(v))} tickCount={4} />}
              {!bare && <DTooltip labelKey="tl" valueFormatter={(v) => formatUsdCompact(v)} />}
              <DitherArea dataKey="value" variant="gradient" />
              {markers && markers.length > 0 && <EventMarks markers={markers} times={rows.map((r) => r.time)} />}
            </AreaChart>
          </div>
        )}
      </div>

      {/* BOTH guards kept at the merge: theirs waits for `ready` so the line cannot
          flash a wrong coverage mid-load, mine lets the homepage opt out because on
          an illustrative panel the sentence is noise while on /portfolio it is
          load-bearing honesty about real money. */}
      {ready && has && coveragePct < 99 && !hideCoverage && !bare && (
        <p className="mt-2 text-right font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
          curve tracks {coveragePct.toFixed(0)}% of today&rsquo;s value; the rest has no readable history
        </p>
      )}
    </div>
  )
}
