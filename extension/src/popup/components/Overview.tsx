// The total, the 24h figure, and the stacked spectrum bar — the portfolio
// refracted into its constituents, the site's own idiom at popup scale. The
// total is the ONLY display-scale type on this surface.

import { formatGrouped, formatUsdCompact } from '@app/lib/spectrum/format'
import { tokenVisual } from '@app/lib/spectrum/token-meta'
import type { PortfolioSnapshot } from '../../shared/portfolio'
import type { DriftReport } from '../../shared/portfolio'
import { MicroLabel, SignedFigure } from './bits'

const BAR_MAX = 8

function totalLabel(n: number): string {
  if (!isFinite(n)) return '—'
  if (n >= 100_000) return formatUsdCompact(n)
  return '$' + formatGrouped(n, 2)
}

export function Overview({ snapshot, drift }: { snapshot: PortfolioSnapshot; drift: DriftReport }) {
  const { assets } = snapshot
  const barAssets = assets.slice(0, BAR_MAX)
  const otherPct = assets.slice(BAR_MAX).reduce((s, a) => s + a.pct, 0)
  const chainCount = new Set(assets.map((a) => a.chainId)).size

  return (
    <section className="px-4 pt-5">
      <MicroLabel>total value</MicroLabel>
      <div className="mt-2 font-display text-[28px] font-semibold leading-none tracking-tight text-ink tnum">
        {totalLabel(snapshot.totalUsd)}
      </div>
      {/* The 24h figure sits BENEATH the total (spec §4), signed and
          tone-coloured — the only other voice in the hero block. */}
      <p className="mt-2 font-mono text-[11px]">
        {snapshot.change24hPct == null ? (
          <span className="text-ink-faint">— 24h</span>
        ) : (
          <>
            <SignedFigure value={snapshot.change24hPct} suffix="%" />
            <span className="ml-1 text-ink-faint">24h</span>
            {snapshot.change24hExcluded > 0 && (
              <span className="text-ink-faint">
                {' '}
                · excludes {snapshot.change24hExcluded} unpriced
              </span>
            )}
          </>
        )}
      </p>

      {assets.length > 0 && (
        <>
          <div className="mt-4 flex h-2 w-full overflow-hidden rounded-full ring-1 ring-inset ring-white/10">
            {barAssets.map((a) => (
              <div
                key={a.key}
                title={`${a.symbol} · ${a.pct.toFixed(1)}%`}
                style={{ width: `${a.pct}%`, background: tokenVisual(a.symbol, a.address).color }}
                className="h-full transition-[width] duration-500 ease-out"
              />
            ))}
            {otherPct > 0.05 && (
              <div
                title={`Other · ${otherPct.toFixed(1)}%`}
                style={{ width: `${otherPct}%` }}
                className="h-full bg-white/20 transition-[width] duration-500 ease-out"
              />
            )}
          </div>
          <div className="mt-2 flex items-center justify-between">
            <MicroLabel>
              {assets.length} asset{assets.length === 1 ? '' : 's'} · {chainCount} chain{chainCount === 1 ? '' : 's'}
            </MicroLabel>
            {drift.aggregatePts != null && (
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim">
                drift <span className="text-ink tnum">{drift.aggregatePts.toFixed(1)}pts</span>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  )
}
