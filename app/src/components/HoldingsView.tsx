import { useState, type ReactNode } from 'react'
import { BasketBento } from './BasketBento'
import { AssetLogo } from './AssetLogo'
import type { Holding } from '../lib/spectrum/basket-data'
import { chainCfg } from '../lib/chain/chains'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { formatPct, formatPrice, formatUsdCompact } from '../lib/spectrum/format'

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`press rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
        active ? 'bg-white/12 text-ink' : 'text-ink-faint hover:text-ink-dim'
      }`}
    >
      {children}
    </button>
  )
}

function Row({ h, chainId }: { h: Holding; chainId: number }) {
  const vis = tokenVisual(h.symbol, h.asset)
  const weight = h.priced && h.liveWeightPct > 0 ? h.liveWeightPct : h.targetWeightPct
  const drift = h.priced && h.liveWeightPct > 0 ? h.liveWeightPct - h.targetWeightPct : 0
  // No DexScreener page to open on unindexed chains (Robinhood) — open the
  // chain's own explorer for the asset instead.
  const slug = chainCfg(chainId).dexscreenerSlug
  const open = () =>
    window.open(
      slug ? `https://dexscreener.com/${slug}/${h.asset}` : `${chainCfg(chainId).explorer}/address/${h.asset}`,
      '_blank',
      'noreferrer',
    )

  return (
    <tr
      onClick={open}
      className="cursor-pointer border-b border-white/[0.06] transition-colors last:border-0 hover:bg-white/[0.03]"
    >
      <td className="py-2.5 pr-3">
        <div className="flex items-center gap-2.5">
          <AssetLogo
            address={h.asset}
            symbol={h.symbol}
            chainId={chainId}
            size={26}
            discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`}
          />
          <div className="min-w-0">
            <div className="font-display text-sm font-semibold leading-none text-ink">{h.symbol}</div>
            {h.name && <div className="mt-0.5 hidden truncate text-[11px] text-ink-faint sm:block">{h.name}</div>}
          </div>
        </div>
      </td>
      <td className="px-3 text-right font-num text-sm tabular-nums text-ink-dim">
        {h.priced ? formatPrice(h.priceUsd) : <span className="text-ink-faint">no price</span>}
      </td>
      <td className="hidden px-3 text-right font-num text-sm tabular-nums sm:table-cell">
        {h.change24hPct == null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <span style={{ color: h.change24hPct >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)' }}>{formatPct(h.change24hPct)}</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <div className="ml-auto w-20">
          <div className="flex items-baseline justify-end gap-1">
            <span className="font-num text-sm font-semibold tabular-nums text-ink">{weight.toFixed(1)}%</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.08]">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(2, weight))}%`, background: vis.color }} />
          </div>
          {Math.abs(drift) >= 0.5 && (
            <div className="mt-0.5 text-right font-mono text-[9px] text-ink-faint">{h.targetWeightPct.toFixed(0)}% target</div>
          )}
        </div>
      </td>
      <td className="hidden pl-3 text-right font-num text-sm tabular-nums text-ink-dim md:table-cell">
        {h.priced ? formatUsdCompact(h.valueUsd) : <span className="text-ink-faint">—</span>}
      </td>
    </tr>
  )
}

export function HoldingsView({ holdings, chainId }: { holdings: Holding[]; chainId: number }) {
  const [view, setView] = useState<'visual' | 'list'>('visual')

  const bentoItems = holdings.map((h) => ({
    symbol: h.symbol,
    address: h.asset,
    weightPct: h.targetWeightPct,
    chainId,
  }))
  const sorted = [...holdings].sort(
    (a, b) => b.valueUsd - a.valueUsd || b.targetWeightPct - a.targetWeightPct,
  )

  return (
    // No h-full: the bento is fixed-height now, so the view must hug its content
    // — stretching would push the FeePanel below it to the column's bottom.
    <div className="flex flex-col">
      <div className="flex shrink-0 items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
          Holdings · {holdings.length} assets
        </div>
        <div className="inline-flex rounded-lg border border-white/10 p-0.5">
          <ToggleBtn active={view === 'visual'} onClick={() => setView('visual')}>
            Visual
          </ToggleBtn>
          <ToggleBtn active={view === 'list'} onClick={() => setView('list')}>
            List
          </ToggleBtn>
        </div>
      </div>

      {view === 'visual' ? (
        // Fixed height (not flex-1): the bento previously stretched to match the
        // right rail and dwarfed the page — owner feedback wants it shorter.
        <div className="mt-3 flex h-[300px] flex-col">
          <div className="relative min-h-0 flex-1">
            <BasketBento items={bentoItems} fill expandable />
          </div>
          <div className="mt-2 shrink-0 font-mono text-[10px] text-ink-faint">Hover a tile to preview its 7d chart</div>
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left" aria-label="Basket holdings">
            <thead>
              <tr className="border-b border-white/10 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                <th scope="col" className="py-2 pr-3 font-semibold">Asset</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Price</th>
                <th scope="col" className="hidden px-3 py-2 text-right font-semibold sm:table-cell">24h</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Weight</th>
                <th scope="col" className="hidden pl-3 py-2 text-right font-semibold md:table-cell">Value</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((h) => (
                <Row key={h.asset} h={h} chainId={chainId} />
              ))}
            </tbody>
          </table>
          <div className="mt-2 font-mono text-[10px] text-ink-faint">Tap a row to view the asset on DexScreener ↗</div>
        </div>
      )}
    </div>
  )
}
