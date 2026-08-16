import { useMemo, useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { availableRanges } from '../lib/spectrum/history'
import { useNavHistory } from '../lib/spectrum/hooks'
import type { ChartRange, NavInput } from '../lib/spectrum/history'
import type { NavPoint } from '../lib/spectrum/basket-data'
import { AreaChart } from './dither-kit/area-chart'
import { Area } from './dither-kit/area'
import { Tooltip } from './dither-kit/tooltip'
import { formatNav } from '../lib/spectrum/format'
import { tokenVisual } from '../lib/spectrum/token-meta'

interface Props {
  chainId: number
  assets: NavInput[]
  navPerToken: number
  ageSec?: number | null
  /** Cheap series shown while the real history loads / if it fails. */
  fallback?: NavPoint[]
  range?: ChartRange
  /** Gliding NAV tooltip on hover (owner 2026-07-29) — on by default. */
  interactive?: boolean
  /** Identity: the basket the spark belongs to — seeds its colour. */
  address?: string
  symbol?: string
  /** Constituents WITH symbols — the fill becomes a weight-proportioned
   *  gradient across their colours (owner 2026-07-29: the chart wears the
   *  bento's colours). Falls back to `assets` (address-hash colours). */
  legs?: { symbol?: string; address: string; weightPct: number }[]
  /** Compact timeframe pills, top-right (the larger spark surfaces). */
  withRanges?: boolean
  /** Parent-driven hover (a card's group hover lifts the fill). */
  hovered?: boolean
  /** Bloom override — the hero showcase runs 'aura' always-on. */
  bloom?: 'off' | 'low' | 'high' | 'aura'
  animate?: boolean
  className?: string
}

function timeLabel(t: number, range: ChartRange): string {
  const d = new Date(t * 1000)
  if (range === '24H') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// The basket spark, rendered through the DITHER engine (owner 2026-07-29:
// every chart wears the kit) in the basket's own identity colour, with the
// kit's gliding tooltip on hover. Falls back to a cheap series until real
// history resolves so it never renders blank.
export function BasketSpark({
  chainId,
  assets,
  navPerToken,
  ageSec,
  fallback,
  range = '7D',
  interactive = true,
  address = '',
  symbol = '',
  legs,
  withRanges = false,
  hovered = false,
  bloom,
  animate = false,
  className = '',
}: Props) {
  const ranges = useMemo(() => availableRanges(ageSec ?? null), [ageSec])
  const [rangeSel, setRangeSel] = useState(range)
  const activeRange = withRanges && ranges.includes(rangeSel) ? rangeSel : range
  // spark: decorative resolution — keyless-first history (see NavHistoryInput).
  const { data } = useNavHistory({ chainId, assets, navPerToken, ageSec, range: activeRange, spark: true })
  const series = data.length >= 2 ? data : fallback ?? []
  // Rows carry a pre-formatted time label — the kit tooltip's heading reads the
  // field verbatim, so formatting belongs to the data, not the tooltip.
  const rows = useMemo(
    () => series.map((p) => ({ t: timeLabel(p.time, activeRange), v: p.value })),
    [series, activeRange],
  )
  const color = tokenVisual(symbol, address).color
  const palette = useMemo(() => {
    const src = legs ?? assets.map((a) => ({ address: a.address, weightPct: a.weight, symbol: undefined }))
    const stops = src
      .filter((l) => l.weightPct > 0)
      .map((l) => ({ color: tokenVisual(l.symbol ?? '', l.address).color, weight: l.weightPct }))
    return stops.length >= 2 ? stops : undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, assets])
  const config = useMemo(
    () => ({ v: { label: symbol ? `$${showSymbol(symbol)}` : 'NAV', color, palette } }),
    [symbol, color, palette],
  )
  // The move the shown window actually represents. With no y-axis anywhere in
  // the app this label is the ONLY absolute reference a viewer gets, so it
  // rides beside the timeframe pills (honesty audit 2026-07-29).
  const change =
    rows.length >= 2 && rows[0].v > 0 ? ((rows[rows.length - 1].v - rows[0].v) / rows[0].v) * 100 : null
  if (rows.length < 2) return <div className={className} aria-hidden />
  const chart = (
    <AreaChart
      data={rows}
      config={config}
      yDomain="data"
      interactive={interactive}
      animate={animate}
      hovered={hovered}
      bloom={bloom ?? 'low'}
      bloomOnHover={bloom == null}
      margins={{ top: 0, right: 0, bottom: 0, left: 0 }}
      className={className}
    >
      {interactive && <Tooltip labelKey="t" valueFormatter={(v) => `$${formatNav(v, 4)}`} variant="default" />}
      <Area dataKey="v" variant="gradient" />
    </AreaChart>
  )
  if (!withRanges) return chart
  return (
    <div className="flex h-full w-full flex-col">
      <div className="mb-1.5 flex items-center justify-end gap-1">
        {change != null && (
          <span
            className={`mr-auto font-num text-[11px] font-semibold tabular-nums ${change >= 0 ? 'text-teal' : 'text-magenta'}`}
            title={`Change over the shown window (${activeRange})`}
          >
            {change >= 0 ? '+' : ''}
            {change.toFixed(2)}%
          </span>
        )}
        {ranges.map((r) => (
          <button
            key={r}
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setRangeSel(r)
            }}
            /* 32px below sm (mobile sweep 2026-08-06: measured ~17px tall, the
               smallest control on either page). Held to 32 rather than 36:
               these ride INSIDE a card's spark header, where a 36px row would
               push down the picture the card exists to show. */
            className={`press inline-flex min-h-[32px] min-w-[32px] items-center justify-center rounded-md px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide sm:min-h-0 sm:min-w-0 sm:px-1.5 ${
              activeRange === r ? 'bg-white/12 text-ink' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            {r}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{chart}</div>
    </div>
  )
}
