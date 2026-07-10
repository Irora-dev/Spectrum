import { useMemo } from 'react'
import { AssetLogo } from './AssetLogo'
import { useAssetHistory } from '../lib/spectrum/hooks'
import { computeReturns } from '../lib/spectrum/history'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { formatPct, formatPrice } from '../lib/spectrum/format'

// The expanded preview shown when a bento tile is hovered: logo, ticker, weight,
// live price + 24h change, and a brand-colored sparkline of the asset's 7d history
// (lazy-loaded; reuses the chart engine's cache so it's usually instant).
export function AssetHoverCard({
  chainId,
  address,
  symbol,
  weightPct,
}: {
  chainId: number
  address: string
  symbol: string
  weightPct: number
}) {
  const { data, isLoading } = useAssetHistory(chainId, address, '7D')
  const series = data ?? []
  const vis = tokenVisual(symbol, address)
  const price = series.length ? series[series.length - 1].value : null
  const change24h = useMemo(
    () => computeReturns(series, null).find((r) => r.range === '24H')?.pct ?? null,
    [series],
  )
  const c = (change24h ?? 0) >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)'

  const spark = useMemo(() => {
    if (series.length < 2) return null
    const vals = series.map((p) => p.value)
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const range = max - min || 1
    const W = 186
    const H = 42
    const pts = series.map(
      (p, i) => `${((i / (series.length - 1)) * W).toFixed(1)},${(H - ((p.value - min) / range) * (H - 6) - 3).toFixed(1)}`,
    )
    return { line: pts.join(' '), area: `0,${H} ${pts.join(' ')} ${W},${H}`, W, H }
  }, [series])

  const gid = `hov-${address.slice(2, 10)}`

  return (
    <div
      className="search-pop rounded-2xl border p-3 shadow-[0_22px_50px_-12px_rgba(0,0,0,0.75)]"
      style={{
        borderColor: `${vis.color}66`,
        // TWO layers: the token tint is a whisper OVER a near-opaque dark base
        // (the old single gradient left the top ~9% opaque — see-through over
        // the washes; owner note 2026-07-06 ×2).
        background: `linear-gradient(165deg, ${vis.color}12, transparent 55%), rgba(4,4,8,0.98)`,
        backdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <AssetLogo
          address={address}
          symbol={symbol}
          chainId={chainId}
          size={28}
          discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`}
        />
        <div className="min-w-0">
          <div className="font-display text-sm font-bold uppercase leading-none tracking-wide text-ink">{symbol}</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
            {weightPct.toFixed(1)}% of basket
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex items-baseline justify-between">
        <span className="font-num text-base tabular-nums text-ink">{price != null ? formatPrice(price) : '—'}</span>
        {change24h != null && (
          <span className="font-num text-xs font-semibold tabular-nums" style={{ color: c }}>
            {formatPct(change24h)} <span className="text-ink-faint">24h</span>
          </span>
        )}
      </div>

      <div className="mt-2 h-11">
        {spark ? (
          <svg viewBox={`0 0 ${spark.W} ${spark.H}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={vis.color} stopOpacity="0.38" />
                <stop offset="100%" stopColor={vis.color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon points={spark.area} fill={`url(#${gid})`} />
            <polyline
              points={spark.line}
              fill="none"
              stroke={vis.color}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : (
          <div className="grid h-full place-items-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            {isLoading ? 'loading…' : 'no chart'}
          </div>
        )}
      </div>
    </div>
  )
}
