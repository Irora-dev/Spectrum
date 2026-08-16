import { useState, type ReactNode } from 'react'
import { showName, showSymbol } from '../lib/spectrum/safe-copy'
import { Link } from 'react-router'
import { basketHref } from '../lib/spectrum/short-url'
import { ChainBadge } from './ChainBadge'
import { BasketAvatar } from './BasketAvatar'
import { BasketBento } from './BasketBento'
import { AssetLogo } from './AssetLogo'
import { BasketSpark } from './BasketSpark'
import { ShareBasket } from './ShareBasket'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { QuickBuy } from './QuickBuy'
import { formatNav, formatPct, formatUsdCompact } from '../lib/spectrum/format'
import { CreatorChip } from './CreatorChip'
import { WatchButton } from './WatchButton'
import { CopyAddress } from './CopyAddress'
import { HELD_LABEL, heldValueUsd, type HeldPosition } from '../lib/spectrum/held-baskets'

const PER_PAGE = 3

/** "YOU HOLD THIS" (QOL round 2026-08-05) — discovery was disconnected from your
 *  own book: a basket already in the wallet looked identical to one never touched.
 *  So the fact goes on the card, in its identity area, next to the ticker it is a
 *  fact about.
 *
 *  Exported because Explore's ThesisCard is the other card face and shows the same
 *  fact — one component, so the two cannot drift into two different markers.
 *
 *  Quiet and factual on purpose: no score, no rank, nothing that reads as advice.
 *  It states holding, never a reason to hold.
 *
 *  HONEST VALUE (held-baskets.ts owns the rule): the marker shows for an UNPRICED
 *  position too, because holding it is a fact either way — the dollars are simply
 *  absent rather than rendered "$0".
 *
 *  Inert by construction: no title, no handler, nothing hoverable, so it can live
 *  inside the card's pointer-events-none content layer without punching a dead
 *  spot in the whole-card link behind it. Its own words are the label. */
export function HeldMark({ position }: { position: HeldPosition }) {
  const usd = heldValueUsd(position)
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-cyan/30 bg-cyan/[0.08] px-1.5 py-0.5 font-mono text-[9px] uppercase leading-none tracking-[0.1em] text-cyan">
      {HELD_LABEL}
      {usd != null && <span className="tabular-nums text-cyan/70">· {formatUsdCompact(usd)}</span>}
    </span>
  )
}

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
      title={`${showSymbol(symbol)} · ${weightPct.toFixed(1)}%`}
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
      /* 36px below sm (mobile sweep 2026-08-06: measured 32×32, and on touch
         these arrows are the ONLY way to the rest of the assets — the strip
         stays a translateX carousel on purpose, because making it swipeable
         means giving it pointer-events, which would cost tap-through to the
         basket the whole card links to). */
      className="press grid h-9 w-9 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-cyan hover:text-cyan disabled:opacity-30 disabled:hover:border-white/15 disabled:hover:text-ink-dim sm:h-8 sm:w-8"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d={dir === 'prev' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
      </svg>
    </button>
  )
}

export function BasketCard({
  ix,
  footer,
  fullBento = false,
  held,
}: {
  ix: BasketSummary
  footer?: ReactNode
  fullBento?: boolean
  /** The viewer's position in THIS basket, resolved by the page from ONE portfolio
   *  read (held-baskets.ts + use-held-baskets.ts). A prop, never a hook here: a
   *  card that fetched its own would run one subscription and one fold over the
   *  whole catalogue per card for an answer the page already holds. Omitted or
   *  null = no wallet, or not held, and the card renders exactly as before. */
  held?: HeldPosition | null
}) {
  const [page, setPage] = useState(0)
  const up = (ix.change24hPct ?? 0) >= 0
  const accent = up ? 'var(--color-cyan)' : 'var(--color-magenta)'
  const sig = basketSignatureColor(ix.address, ix.top[0])

  const holdings = ix.top
  const pages = Math.max(1, Math.ceil(holdings.length / PER_PAGE))
  const cur = Math.min(page, pages - 1)
  const remaining = Math.max(0, holdings.length - (cur + 1) * PER_PAGE)

  // A name that merely echoes the ticker ("test50055" under $TEST50055) is a
  // row of noise, not information — hierarchy pass, owner 2026-08-16: "so much
  // text no hierarchy". Only a name that says something the ticker doesn't
  // gets its line; an empty name gets nothing (the old placeholder dash was
  // a row spent saying "nothing here").
  const name = ix.name?.trim() ? showName(ix.name) : ''
  const nameEchoesTicker =
    name.replace(/\s+/g, '').toLowerCase() === showSymbol(ix.symbol).replace(/\s+/g, '').toLowerCase()

  return (
    <div className={`group relative overflow-hidden rounded-2xl border border-white/15 p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] transition-[translate,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-white/30 ${fullBento ? 'bg-panel hover:bg-panel-2' : 'bg-white/[0.045] backdrop-blur-md hover:bg-white/[0.06]'}`}>
      {/* whole-card link sits behind the content; the pager opts back into clicks */}
      <Link
        to={basketHref(ix)}
        aria-label={`View $${showSymbol(ix.symbol)}`}
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
              {/* wraps rather than overflows: the held marker joins this line only
                  for the baskets you own, and a narrow card must give it a second
                  row instead of pushing the chain badge off the edge */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-display text-xl font-semibold leading-none text-ink">${showSymbol(ix.symbol)}</span>
                <ChainBadge chainId={ix.chainId} />
                {held && <HeldMark position={held} />}
              </div>
              {name && !nameEchoesTicker && <div className="mt-1 line-clamp-1 text-xs text-ink-dim">{name}</div>}
              {/* ONE quiet provenance row — creator and contract together
                  (they were two stacked rows; hierarchy pass 2026-08-16). The
                  address chip keeps its copy click via pointer-events-auto:
                  this content layer is inert so the card-wide link behind it
                  keeps working, and the chip opts back in for its own click. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] tracking-wide text-ink-faint">
                <span className="flex items-center gap-1">
                  <span>by</span>
                  <CreatorChip deployer={ix.deployer} basket={ix.address} chainId={ix.chainId} size={16} className="font-mono text-[10px]" />
                </span>
                <span className="pointer-events-auto">
                  <CopyAddress address={ix.address} what={`${showSymbol(ix.symbol)} basket address`} size="xs" />
                </span>
              </div>
            </div>
          </div>
          {/* personal watchlist toggle — opts back into pointer events over the
              whole-card link; browser-only, powers the Explore "Watching" filter */}
          {/* QOL #10: share sits beside watch INSIDE this wrapper — the card
              lays a whole-card link behind pointer-events-none content, so a
              button anywhere else here is unclickable. */}
          <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
            <ShareBasket address={ix.address} symbol={ix.symbol} name={ix.name} chainId={ix.chainId} variant="icon" />
            <WatchButton basket={ix.address} chainId={ix.chainId} variant="icon" />
          </div>
        </div>

        {/* nav trend — above the assets (real reconstructed history, hoverable);
            the fullBento (trio) card breathes more between its stacked blocks.
            24H, not 7D: the only % on this card is change24hPct, and a 7-day
            shape beside a 24-hour number reads as one claim (honesty audit) */}
        <div className={`pointer-events-auto h-12 ${fullBento ? 'mt-6' : 'mt-3'}`}>
          <BasketSpark
            chainId={ix.chainId}
            assets={holdings.map((t) => ({ address: t.address, weight: t.weightPct }))}
            navPerToken={ix.navPerToken}
            fallback={ix.navSeries}
            range="24H"
            address={ix.address}
            symbol={ix.symbol}
            legs={holdings.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct }))}
          />
        </div>

        {/* assets — the FULL weighted bento when the host gives the card the
            height for it (the Home trio, owner 2026-07-29); else the paged strip */}
        {fullBento ? (
          <div className="mt-6">
            <BasketBento
              items={holdings.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct, chainId: ix.chainId }))}
              fill
              className="min-h-[200px]"
            />
          </div>
        ) : (
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

          {/* the count row earns its height only when there is more to page
              to — with every asset already on screen, the tiles ARE the count
              (hierarchy pass 2026-08-16) */}
          {pages > 1 && (
            <div className="mt-2.5 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{holdings.length} assets</span>
              <div className="pointer-events-auto flex items-center gap-1.5">
                <PagerBtn dir="prev" disabled={cur === 0} onClick={() => setPage(cur - 1)} />
                {remaining > 0 && <span className="font-mono text-[10px] font-semibold text-ink-dim">+{remaining}</span>}
                <PagerBtn dir="next" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} />
              </div>
            </div>
          )}
        </div>
        )}

        {/* price — the 24h move sits BESIDE the price it describes (one money
            fact, read in one glance), and the buy stands alone on the right as
            the card's one action (hierarchy pass 2026-08-16) */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-num text-2xl leading-none tabular-nums text-ink">
                ${formatNav(ix.navPerToken, 4)}
                <span className="ml-1 text-xs text-ink-faint">USD</span>
              </span>
              <span className="font-num text-sm font-semibold tabular-nums" style={{ color: accent }}>
                {formatPct(ix.change24hPct)}
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-ink-faint">AUM {formatUsdCompact(ix.aumUsd)}</div>
          </div>
          {/* buy from the card — one click to a filled quote (owner 2026-07-29) */}
          <QuickBuy address={ix.address} chainId={ix.chainId} symbol={ix.symbol} />
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
