import { useId, useMemo, useState } from 'react'
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useUnderlyingSeries } from '../lib/spectrum/use-underlying-series'
import { useNavHistory } from '../lib/spectrum/hooks'
import { availableRanges, type ChartRange, type NavInput } from '../lib/spectrum/history'
import type { NavPoint } from '../lib/spectrum/basket-data'
import { formatNav, formatPct, formatPrice } from '../lib/spectrum/format'

const UP = 'var(--color-cyan)'
const DOWN = 'var(--color-magenta)'

interface Props {
  chainId: number
  assets: NavInput[]
  navPerToken: number
  ageSec?: number | null
  symbol: string
  /** Cheap series to show while real history loads / if it fails. */
  fallback?: NavPoint[]
  /** Constituents (address+symbol+24h) — enables the dotted-underlying toggle (19:24). */
  underlyingAssets?: { address: string; symbol: string; change24hPct?: number | null }[]
  /** The basket's own 24h move — shown beside the NAV in the hover (16:59). */
  change24hPct?: number | null
  /** Tailwind height classes for the plot area. */
  heightClass?: string
  className?: string
}

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

function PctChip({ v }: { v: number | null | undefined }) {
  if (v == null || !Number.isFinite(v)) return null
  return (
    <span className={`font-num text-[10px] tabular-nums ${v >= 0 ? 'text-teal' : 'text-magenta'}`}>
      {formatPct(v, 1)}
    </span>
  )
}

function ChartTooltip({
  active,
  payload,
  symbol,
  lines,
  basketChange,
}: {
  active?: boolean
  payload?: { payload: NavPoint & Record<string, number> }[]
  symbol: string
  /** Underlying meta (symbol/color/24h) — row keys `p{k}` hold the real prices. */
  lines?: { symbol: string; color: string; change24hPct: number | null }[]
  basketChange?: number | null
}) {
  if (!active || !payload || payload.length === 0) return null
  const p = payload[0].payload
  return (
    <div className="min-w-[13rem] rounded-lg border border-white/15 bg-void/90 px-3.5 py-2.5 shadow-xl backdrop-blur">
      {/* the basket: NAV + its 24h move on the right (owner 16:59) */}
      <div className="flex items-baseline justify-between gap-5">
        <div className="font-num text-sm font-semibold tabular-nums text-ink">
          ${formatNav(p.value, 4)}
          <span className="ml-1 text-[10px] font-normal text-ink-faint">{symbol}</span>
        </div>
        <PctChip v={basketChange} />
      </div>
      {/* the constituents' REAL prices + 24h beside each (owner 16:40 + 16:59) */}
      {lines && lines.length > 0 && (
        <div className="mt-1.5 space-y-1 border-t border-white/10 pt-1.5">
          {lines.map((u, k) => (
            <div key={u.symbol} className="flex items-baseline justify-between gap-5">
              <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-dim">
                <span aria-hidden className="h-1 w-3 rounded-full" style={{ background: u.color }} />
                {u.symbol}
              </span>
              <span className="flex items-baseline gap-2">
                <span className="font-num text-[11px] tabular-nums text-ink-dim">{formatPrice(p[`p${k}`])}</span>
                <PctChip v={u.change24hPct} />
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
        {fmtFull(p.time)}
      </div>
    </div>
  )
}

export function BasketChart({
  chainId,
  assets,
  navPerToken,
  ageSec,
  symbol,
  fallback,
  underlyingAssets = [],
  change24hPct = null,
  heightClass = 'h-56 sm:h-64',
  className = '',
}: Props) {
  const ranges = useMemo(() => availableRanges(ageSec ?? null), [ageSec])
  const [range, setRange] = useState<ChartRange>(() =>
    ranges.includes('7D') ? '7D' : ranges[0],
  )
  const active = ranges.includes(range) ? range : ranges[0]

  const { data, isLoading } = useNavHistory({ chainId, assets, navPerToken, ageSec, range: active })
  const series = data.length >= 2 ? data : fallback ?? []

  // The dotted-constituents overlay (owner 19:24: every graph on the site) —
  // fetches only while toggled on; range-matched; normalized to the NAV start.
  const [under, setUnder] = useState(false)
  const underLines = useUnderlyingSeries(chainId, underlyingAssets, under && underlyingAssets.length > 0, series, active)
  type Row = NavPoint & Record<string, number>
  const rows = useMemo<Row[]>(() => {
    if (!under || underLines.length === 0) return series as Row[]
    return series.map((p, i) => {
      const r: Row = { time: p.time, value: p.value } as Row
      underLines.forEach((u, k) => {
        r[`u${k}`] = u.points[i]
        r[`p${k}`] = u.prices[i]
      })
      return r
    })
  }, [series, under, underLines])

  const raw = useId().replace(/[^a-zA-Z0-9]/g, '')
  const strokeId = `cs${raw}`
  const fillId = `cf${raw}`

  const { domain, accent, change } = useMemo(() => {
    if (series.length < 2) return { domain: [0, 1] as [number, number], accent: UP, change: null as number | null }
    const vals = series.map((p) => p.value)
    let min = Math.min(...vals)
    let max = Math.max(...vals)
    if (under) {
      for (const u of underLines) {
        for (const v of u.points) {
          if (v < min) min = v
          if (v > max) max = v
        }
      }
    }
    const pad = (max - min) * 0.12 || max * 0.04 || 1
    const first = series[0].value
    const last = series[series.length - 1].value
    const chg = first > 0 ? ((last - first) / first) * 100 : null
    return {
      domain: [min - pad, max + pad] as [number, number],
      accent: chg != null && chg < 0 ? DOWN : UP,
      change: chg,
    }
  }, [series, under, underLines])

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {change != null && (
            <span
              className="font-num text-xs font-semibold tabular-nums"
              style={{ color: accent }}
            >
              {formatPct(change)}
            </span>
          )}
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            {active === 'ALL' ? 'since launch' : `past ${active}`}
          </span>
          {isLoading && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" role="status" aria-label="Updating price history" />
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* the Underlying toggle — deliberately louder than the range pills
              (owner 2026-07-06 ~19:5x): a spectral hairline ring + glow when
              off, filled cyan with a mini legs glyph when on */}
          {underlyingAssets.length > 0 && (
            <button
              type="button"
              onClick={() => setUnder((v) => !v)}
              aria-pressed={under}
              title="Overlay every constituent as a dotted line"
              className={`press mr-1.5 rounded-lg p-px transition-shadow ${
                under ? '' : 'shadow-[0_0_14px_-4px_rgba(164,139,255,0.7)] hover:shadow-[0_0_18px_-4px_rgba(164,139,255,0.95)]'
              }`}
              style={{ background: under ? 'var(--color-cyan)' : 'linear-gradient(100deg, rgba(53,224,255,0.75), rgba(164,139,255,0.8) 50%, rgba(255,77,184,0.75))' }}
            >
              <span
                className={`flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide ${
                  under ? 'bg-cyan text-void' : 'bg-panel/95 text-ink'
                }`}
              >
                <svg viewBox="0 0 24 24" aria-hidden className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M3 8c3-3 6 3 9 0s6 3 9 0" />
                  <path d="M3 16c3-3 6 3 9 0s6 3 9 0" strokeDasharray="2.5 2.5" />
                </svg>
                Underlying
              </span>
            </button>
          )}
          {ranges.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`press rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wide ${
                active === r ? 'bg-white/12 text-ink' : 'text-ink-faint hover:text-ink-dim'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className={`relative w-full ${heightClass}`} aria-busy={isLoading}>
        {series.length < 2 ? (
          <div className="grid h-full w-full place-items-center rounded-lg bg-white/[0.02] font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            {isLoading ? 'Loading price history…' : 'No price history yet'}
          </div>
        ) : (
          /* absolute wrapper: recharts writes an EXPLICIT width on its svg,
             which would otherwise become the ancestor grid track's min-content
             and lock the layout wider than the viewport (mobile overflow),
             absolutely-positioned content can't size the track */
          <div className="absolute inset-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 6, right: 2, bottom: 0, left: 2 }}>
              <defs>
                <linearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="var(--color-amber)" />
                  <stop offset="50%" stopColor="var(--color-magenta)" />
                  <stop offset="100%" stopColor="var(--color-cyan)" />
                </linearGradient>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={accent} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t) => fmtAxis(t as number, active)}
                tick={{ fill: 'var(--color-ink-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                axisLine={false}
                tickLine={false}
                minTickGap={48}
              />
              <YAxis domain={domain} hide />
              <Tooltip
                cursor={{ stroke: 'rgba(255,255,255,0.28)', strokeWidth: 1, strokeDasharray: '3 4' }}
                content={<ChartTooltip symbol={symbol} lines={under ? underLines : undefined} basketChange={change24hPct} />}
                isAnimationActive={false}
              />
              {/* INVERTED emphasis with Underlying on (R 2026-07-07 17:19):
                  the constituents become the highlighted solid colored lines,
                  the basket steps back to a dashed reference line. */}
              {under &&
                underLines.map((u, k) => (
                  <Line
                    key={u.symbol}
                    type="monotone"
                    dataKey={`u${k}`}
                    stroke={u.color}
                    strokeWidth={2}
                    strokeOpacity={1}
                    dot={false}
                    activeDot={{ r: 3, fill: u.color, stroke: 'var(--color-void)', strokeWidth: 1.5 }}
                    isAnimationActive={false}
                  />
                ))}
              <Area
                type="monotone"
                dataKey="value"
                stroke={under ? 'rgba(232,232,240,0.65)' : `url(#${strokeId})`}
                strokeWidth={under ? 1.6 : 3}
                strokeDasharray={under ? '6 5' : undefined}
                fill={under ? 'transparent' : `url(#${fillId})`}
                dot={false}
                activeDot={{ r: 3.5, fill: accent, stroke: 'var(--color-void)', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          </div>
        )}
      </div>
      {under && underLines.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {underLines.map((u) => (
            <span key={u.symbol} className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-dim">
              <span aria-hidden className="h-1 w-4 rounded-full" style={{ background: u.color }} />
              {u.symbol}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-dim">
            <span aria-hidden className="h-0 w-4 border-t border-dashed border-white/50" />
            {symbol}
          </span>
          <span className="font-mono text-[9px] text-ink-faint">each normalized to the basket&rsquo;s start</span>
        </div>
      )}
    </div>
  )
}
