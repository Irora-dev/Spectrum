import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChainBadge } from './ChainBadge'
import { BasketAvatar } from './BasketAvatar'
import { AssetLogo } from './AssetLogo'
import { BasketSpark } from './BasketSpark'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { formatNav, formatPct, formatUsdCompact } from '../lib/spectrum/format'
import { CreatorChip } from './CreatorChip'
import { WatchButton } from './WatchButton'

const PER_PAGE = 3

// One uniform asset tile (brand colour + ticker + weight + logo).
function AssetTile({
  symbol,
  address,
  weightPct,
  chainId,
}: {
  symbol: string
  address: string
  weightPct: number
  chainId: number
}) {
  const vis = tokenVisual(symbol, address)
  return (
    <div
      className="relative flex h-[68px] flex-col justify-between overflow-hidden rounded-lg p-1.5"
      style={{ background: vis.color, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -3px 6px rgba(0,0,0,0.2)' }}
      title={`${symbol} · ${weightPct.toFixed(1)}%`}
    >
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0) 38%, rgba(0,0,0,0.18))' }}
      />
      <div className="relative flex items-start justify-between gap-1">
        <span className="max-w-[70%] truncate rounded bg-white/90 px-1 py-0.5 font-display text-[9px] font-bold uppercase leading-none text-black">
          {symbol}
        </span>
        <span className="font-num text-[10px] font-bold leading-none" style={{ color: vis.ink }}>
          {Math.round(weightPct)}%
        </span>
      </div>
      <div className="relative self-end">
        <AssetLogo
          address={address}
          symbol={symbol}
          chainId={chainId}
          size={18}
          discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`}
        />
      </div>
    </div>
  )
}

function PagerBtn({ dir, disabled, onClick }: { dir: 'prev' | 'next'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'prev' ? 'Previous assets' : 'More assets'}
      className="press grid h-8 w-8 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-cyan hover:text-cyan disabled:opacity-30 disabled:hover:border-white/15 disabled:hover:text-ink-dim"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d={dir === 'prev' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
      </svg>
    </button>
  )
}

export function BasketCard({ ix, footer }: { ix: BasketSummary; footer?: ReactNode }) {
  const [page, setPage] = useState(0)
  const up = (ix.change24hPct ?? 0) >= 0
  const accent = up ? 'var(--color-cyan)' : 'var(--color-magenta)'
  const sig = basketSignatureColor(ix.address, ix.top[0])

  const holdings = ix.top
  const pages = Math.max(1, Math.ceil(holdings.length / PER_PAGE))
  const cur = Math.min(page, pages - 1)
  const remaining = Math.max(0, holdings.length - (cur + 1) * PER_PAGE)

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/15 bg-white/[0.045] p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] backdrop-blur-md transition-[translate,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-white/30 hover:bg-white/[0.06]">
      {/* whole-card link sits behind the content; the pager opts back into clicks */}
      <Link
        to={`/token?addr=${ix.address}&chain=${ix.chainId}`}
        aria-label={`View $${ix.symbol}`}
        className="absolute inset-0 z-0"
      />

      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full opacity-[0.12] blur-3xl transition-opacity duration-300 group-hover:opacity-30"
        style={{ background: sig }}
      />

      <div className="pointer-events-none relative z-10">
        {/* header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <BasketAvatar address={ix.address} symbol={ix.symbol} size={40} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-display text-lg font-semibold leading-none text-ink">${ix.symbol}</span>
                <ChainBadge chainId={ix.chainId} />
              </div>
              <div className="mt-1 line-clamp-1 text-xs text-ink-dim">{ix.name?.trim() || '—'}</div>
              <div className="mt-1 flex items-center gap-1 font-mono text-[10px] tracking-wide text-ink-faint">
                <span>by</span>
                <CreatorChip deployer={ix.deployer} basket={ix.address} chainId={ix.chainId} size={16} className="font-mono text-[10px]" />
              </div>
            </div>
          </div>
          {/* personal watchlist toggle — opts back into pointer events over the
              whole-card link; browser-only, powers the Explore "Watching" filter */}
          <div className="pointer-events-auto shrink-0">
            <WatchButton basket={ix.address} chainId={ix.chainId} variant="icon" />
          </div>
        </div>

        {/* nav trend — above the assets (real reconstructed history, hoverable) */}
        <div className="pointer-events-auto mt-3 h-12">
          <BasketSpark
            chainId={ix.chainId}
            assets={holdings.map((t) => ({ address: t.address, weight: t.weightPct }))}
            navPerToken={ix.navPerToken}
            fallback={ix.navSeries}
            range="7D"
          />
        </div>

        {/* assets — three at a time, paged with arrows */}
        <div className="mt-3">
          <div className="overflow-hidden">
            <div className="flex transition-transform duration-300 ease-out" style={{ transform: `translateX(-${cur * 100}%)` }}>
              {Array.from({ length: pages }).map((_, pi) => (
                <div key={pi} className="grid w-full shrink-0 grid-cols-3 gap-2">
                  {holdings.slice(pi * PER_PAGE, pi * PER_PAGE + PER_PAGE).map((t) => (
                    <AssetTile key={t.address} symbol={t.symbol} address={t.address} weightPct={t.weightPct} chainId={ix.chainId} />
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-2.5 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{holdings.length} assets</span>
            {pages > 1 && (
              <div className="pointer-events-auto flex items-center gap-1.5">
                <PagerBtn dir="prev" disabled={cur === 0} onClick={() => setPage(cur - 1)} />
                {remaining > 0 && <span className="font-mono text-[10px] font-semibold text-ink-dim">+{remaining}</span>}
                <PagerBtn dir="next" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} />
              </div>
            )}
          </div>
        </div>

        {/* price */}
        <div className="mt-3 flex items-end justify-between">
          <div>
            <div className="font-num text-2xl leading-none tabular-nums text-ink">
              ${formatNav(ix.navPerToken, 4)}
              <span className="ml-1 text-xs text-ink-faint">USD</span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-ink-faint">AUM {formatUsdCompact(ix.aumUsd)}</div>
          </div>
          <span className="font-num text-sm font-semibold tabular-nums" style={{ color: accent }}>
            {formatPct(ix.change24hPct)}
          </span>
        </div>
      </div>

      {/* optional owner/admin footer, flush inside the card surface (Portfolio → Created) */}
      {footer && (
        <div className="pointer-events-none relative z-10 -mx-4 -mb-4 mt-4 border-t border-white/10 bg-black/20 px-4 py-3">
          {footer}
        </div>
      )}
    </div>
  )
}
