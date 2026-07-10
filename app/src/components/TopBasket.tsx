import { useRef, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { BasketAvatar } from './BasketAvatar'
import { AssetLogo } from './AssetLogo'
import { BasketBento } from './BasketBento'
import { ChainBadge } from './ChainBadge'
import { useInViewOnce, usePrefersReducedMotion } from '../lib/motion'
import { BasketSpark } from './BasketSpark'
import { CreatorChip } from './CreatorChip'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { formatNav, formatUsdCompact } from '../lib/spectrum/format'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-black/20 px-4 py-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">{label}</div>
      <div className="mt-1.5 font-num text-lg font-semibold tabular-nums text-ink">{value}</div>
    </div>
  )
}

// The single largest basket by total value, shown with its full bento composition.
// Selection is purely by an objective metric (TVL), framed factually with no buy
// CTA — the card links to the basket's own info page. This is analytics display,
// not editorial curation or promotion of a specific buyable token.
export function TopBasket({ ix, label = 'Largest by total value' }: { ix: BasketSummary; label?: string }) {
  const sig = basketSignatureColor(ix.address, ix.top[0])
  const to = `/token?addr=${ix.address}&chain=${ix.chainId}`
  const bentoItems = ix.top.map((t) => ({
    symbol: t.symbol,
    address: t.address,
    weightPct: t.weightPct,
    chainId: ix.chainId,
  }))
  const ref = useRef<HTMLElement>(null)
  const shown = useInViewOnce(ref)
  const icons = ix.top.slice(0, 7)
  const more = Math.max(0, ix.basketLength - icons.length)
  const reduced = usePrefersReducedMotion()
  // Choreographed entrance: each block eases up in sequence once the card is seen.
  const reveal = (i: number): CSSProperties =>
    reduced
      ? {}
      : {
          opacity: shown ? 1 : 0,
          transform: shown ? 'none' : 'translateY(14px)',
          transition: `opacity 0.5s ease ${i * 75}ms, transform 0.65s cubic-bezier(0.16,1,0.3,1) ${i * 75}ms`,
        }

  return (
    <section ref={ref} className="space-y-3">
      {label && (
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint" style={reveal(0)}>
          {label}
        </div>
      )}
      <div
        className="group/spot relative"
        style={{ opacity: reduced || shown ? 1 : 0, transition: reduced ? undefined : 'opacity 0.45s ease' }}
      >
        {/* signature-colour bloom behind the spotlight */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-8 -top-10 bottom-0 opacity-20 blur-3xl transition-opacity duration-500 group-hover/spot:opacity-35"
          style={{ background: `radial-gradient(55% 60% at 50% 0%, ${sig}, transparent 72%)` }}
        />
        <Link
          to={to}
          className="group relative block overflow-hidden rounded-2xl border border-white/[0.12] bg-white/[0.03] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] backdrop-blur-md transition-[transform,border-color] duration-200 hover:-translate-y-1 hover:border-white/25"
        >
          <div
            aria-hidden
            className="h-1.5 w-full origin-left"
            style={{
              background: sig,
              transform: reduced || shown ? 'scaleX(1)' : 'scaleX(0)',
              transition: reduced ? undefined : 'transform 0.7s cubic-bezier(0.16,1,0.3,1)',
            }}
          />
        <div className="grid gap-8 p-7 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-10 lg:min-h-[23rem]">
          {/* details (left) */}
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3.5" style={reveal(1)}>
              <BasketAvatar address={ix.address} symbol={ix.symbol} size={60} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-2xl font-semibold leading-none text-ink">${ix.symbol}</span>
                  <ChainBadge chainId={ix.chainId} />
                </div>
                <div className="mt-1.5 truncate text-sm text-ink-dim">{ix.name || ix.symbol}</div>
                <div className="mt-1 flex items-center gap-1 font-mono text-[10px] tracking-wide text-ink-faint">
                  <span>by</span>
                  <CreatorChip deployer={ix.deployer} basket={ix.address} chainId={ix.chainId} size={16} asLink={false} className="font-mono text-[10px]" />
                </div>
              </div>
            </div>

            <p className="line-clamp-2 text-[15px] leading-relaxed text-ink-dim" style={reveal(2)}>
              {`A ${ix.basketLength}-asset onchain basket.`}
            </p>

            {/* constituent logo cluster — what's inside, at a glance */}
            <div className="flex items-center" style={reveal(3)}>
              <div className="flex items-center -space-x-2.5">
                {icons.map((t) => (
                  <AssetLogo key={t.address} address={t.address} symbol={t.symbol} chainId={ix.chainId} size={30} />
                ))}
              </div>
              {more > 0 && <span className="ml-3 font-mono text-[11px] text-ink-faint">+{more} more</span>}
            </div>

            <div className="grid grid-cols-3 gap-3" style={reveal(4)}>
              <Stat label="Total value" value={formatUsdCompact(ix.aumUsd)} />
              <Stat label="Price" value={`$${formatNav(ix.navPerToken, 4)}`} />
              <Stat label="Assets" value={String(ix.basketLength)} />
            </div>

            {/* 7d trend — a proper full-width band */}
            <div className="mt-1 min-h-[9rem] flex-1" style={reveal(5)}>
              <BasketSpark
                chainId={ix.chainId}
                assets={ix.top.map((t) => ({ address: t.address, weight: t.weightPct }))}
                navPerToken={ix.navPerToken}
                fallback={ix.navSeries}
                range="7D"
                interactive={false}
              />
            </div>

            <div className="pt-1" style={reveal(6)}>
              <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">7d trend</span>
            </div>
          </div>

          {/* composition bento (right) */}
          <div className="flex items-center" style={reveal(5)}>
            <BasketBento items={bentoItems} aspect={1.4} className="w-full" />
          </div>
        </div>

        {/* view-details — bottom-right of the card, becomes a proper button on hover */}
        <div className="flex justify-end border-t border-white/10 px-7 py-4 sm:px-8">
          <span className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim transition-[border-color,background-color,color,box-shadow] duration-200 group-hover:border-cyan/60 group-hover:bg-cyan/10 group-hover:text-cyan group-hover:shadow-[0_8px_24px_-10px_rgba(53,224,255,0.5)]">
            View details
            <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-0.5">→</span>
          </span>
        </div>
        </Link>
      </div>
    </section>
  )
}
