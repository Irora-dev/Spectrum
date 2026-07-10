import type { ReactNode } from 'react'
import { useNavHistory } from '../lib/spectrum/hooks'
import { computeReturns } from '../lib/spectrum/history'
import type { BasketData } from '../lib/spectrum/basket-data'
import { formatAge, formatPct, formatUsdCompact } from '../lib/spectrum/format'
import { useCountUp } from '../lib/motion'

const DAY = 86400

function Stat({
  label,
  children,
  accent,
  large,
}: {
  label: string
  children: ReactNode
  accent?: string
  large?: boolean
}) {
  return (
    <div className="bg-void/40 px-5 py-4">
      <div
        className={`font-mono uppercase tracking-[0.2em] ${large ? 'text-[11px] text-ink-dim' : 'text-[10px] text-ink-faint'}`}
      >
        {label}
      </div>
      <div
        className={`mt-2 font-num leading-none tabular-nums text-ink ${large ? 'text-3xl font-light sm:text-4xl' : 'text-2xl font-light'}`}
        style={accent ? { color: accent } : undefined}
      >
        {children}
      </div>
    </div>
  )
}

// Key metrics + a multi-horizon returns strip. Returns are computed from the
// reconstructed history (one age-clamped fetch) and are immune to absolute NAV
// scaling since they're ratios.
export function BasketStats({ ix, chainId }: { ix: BasketData; chainId: number }) {
  const ageSec = ix.ageHours != null ? ix.ageHours * 3600 : null
  const range = ageSec != null && ageSec <= 30 * DAY ? 'ALL' : '30D'
  const assets = ix.holdings.map((h) => ({
    address: h.asset,
    weight: h.liveWeightPct > 0 ? h.liveWeightPct : h.targetWeightPct,
  }))
  const { data } = useNavHistory({ chainId, assets, navPerToken: ix.navPerToken, ageSec, range })
  const returns = computeReturns(data.length >= 2 ? data : ix.navSeries, ageSec)

  const changeColor =
    ix.change24hPct == null ? undefined : ix.change24hPct >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)'
  const fullyPriced = ix.pricedCount >= ix.totalCount
  const aumUp = useCountUp(ix.aumUsd, true)

  return (
    <div className="space-y-4">
      {/* Four uniform tiles (owner call: Priced + Supply dropped; the partial-
          pricing honesty signal lives on as an accent when not fully priced). */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 lg:grid-cols-4">
        <Stat label="AUM">{formatUsdCompact(aumUp)}</Stat>
        <Stat label="24h" accent={changeColor}>
          {formatPct(ix.change24hPct)}
        </Stat>
        <Stat label="Assets" accent={fullyPriced ? undefined : 'var(--color-amber)'}>
          {ix.totalCount}
        </Stat>
        <Stat label="Launched">
          <span className="whitespace-nowrap">{ageSec != null ? `${formatAge(ageSec)} ago` : '—'}</span>
        </Stat>
      </div>

      {/* Returns as pill chips (matches the hero's badge family); the all-time
          horizon reads as what it actually is: return since creation. */}
      {returns.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
          {returns.map((r) => (
            <span
              key={r.range}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1.5 pl-3 pr-2"
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">
                {r.range === 'ALL' ? 'Return since creation' : `${r.range} return`}
              </span>
              <span
                className="rounded-full px-2 py-0.5 font-num text-sm font-semibold tabular-nums"
                style={{
                  color: r.pct >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)',
                  background: r.pct >= 0 ? '#35e0ff1f' : '#ff4db81f',
                }}
              >
                {formatPct(r.pct)}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
