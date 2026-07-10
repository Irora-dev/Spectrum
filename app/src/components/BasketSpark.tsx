import { useId, useMemo } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts'
import { useNavHistory } from '../lib/spectrum/hooks'
import type { ChartRange, NavInput } from '../lib/spectrum/history'
import type { NavPoint } from '../lib/spectrum/basket-data'
import { formatNav } from '../lib/spectrum/format'

interface Props {
  chainId: number
  assets: NavInput[]
  navPerToken: number
  ageSec?: number | null
  /** Cheap series shown while the real history loads / if it fails. */
  fallback?: NavPoint[]
  range?: ChartRange
  interactive?: boolean
  className?: string
}

function MiniTooltip({ active, payload }: { active?: boolean; payload?: { payload: NavPoint }[] }) {
  if (!active || !payload || payload.length === 0) return null
  const p = payload[0].payload
  return (
    <div className="rounded-md border border-white/15 bg-void/90 px-2 py-1 font-num text-[11px] font-semibold tabular-nums text-ink shadow-lg backdrop-blur">
      ${formatNav(p.value, 4)}
    </div>
  )
}

// Small spectral area chart fed by real reconstructed NAV history. Falls back to
// a cheap series until the real one resolves so it never renders blank.
export function BasketSpark({
  chainId,
  assets,
  navPerToken,
  ageSec,
  fallback,
  range = '7D',
  interactive = true,
  className = '',
}: Props) {
  // spark: decorative resolution — keyless-first history (see NavHistoryInput).
  const { data } = useNavHistory({ chainId, assets, navPerToken, ageSec, range, spark: true })
  const series = data.length >= 2 ? data : fallback ?? []

  const raw = useId().replace(/[^a-zA-Z0-9]/g, '')
  const strokeId = `ss${raw}`
  const fillId = `sf${raw}`

  const { domain, accent } = useMemo(() => {
    if (series.length < 2) return { domain: [0, 1] as [number, number], accent: 'var(--color-cyan)' }
    const vals = series.map((p) => p.value)
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const pad = (max - min) * 0.15 || max * 0.05 || 1
    const chg = series[0].value > 0 ? series[series.length - 1].value - series[0].value : 0
    return {
      domain: [min - pad, max + pad] as [number, number],
      accent: chg < 0 ? 'var(--color-magenta)' : 'var(--color-cyan)',
    }
  }, [series])

  if (series.length < 2) return <div className={`h-full w-full rounded bg-white/[0.02] ${className}`} />

  return (
    /* absolute wrapper: recharts' explicit svg width must never become an
       ancestor track's min-content (mobile overflow), see BasketChart */
    <div className={`relative h-full w-full ${className}`}>
      <div className="absolute inset-0">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-amber)" />
              <stop offset="50%" stopColor="var(--color-magenta)" />
              <stop offset="100%" stopColor="var(--color-cyan)" />
            </linearGradient>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity={0.18} />
              <stop offset="100%" stopColor={accent} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={domain} hide />
          {interactive && (
            <Tooltip
              cursor={{ stroke: 'rgba(255,255,255,0.25)', strokeWidth: 1 }}
              content={<MiniTooltip />}
              isAnimationActive={false}
              allowEscapeViewBox={{ x: false, y: true }}
              position={{ y: -8 }}
            />
          )}
          <Area
            type="monotone"
            dataKey="value"
            stroke={`url(#${strokeId})`}
            strokeWidth={1.5}
            fill={`url(#${fillId})`}
            dot={false}
            activeDot={interactive ? { r: 2.5, fill: accent, stroke: 'var(--color-void)', strokeWidth: 1.5 } : false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
      </div>
    </div>
  )
}
