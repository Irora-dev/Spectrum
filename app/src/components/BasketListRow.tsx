import { useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { useCreatorMeta } from '../lib/spectrum/hooks'
import { resolveCreator } from '../lib/spectrum/creator'
import { perfMeasurable, perfToDate, MEASURABLE_TVL_FLOOR_USD } from '../lib/spectrum/leaderboard'
import { VersionJourney } from './VersionJourney'
import { BasketAvatar } from './BasketAvatar'
import { AssetLogo } from './AssetLogo'
import { AssetHoverCard } from './AssetHoverCard'
import { BasketBento } from './BasketBento'
import { CreatorChip } from './CreatorChip'
import { BasketWash } from './BasketWash'
import { formatNav, formatPct, formatUsdCompact } from '../lib/spectrum/format'
import { SWAP_ENABLED } from '../lib/config/features'
import { useBasketData } from '../lib/spectrum/hooks'
import { DexSwapCard } from './DexSwapCard'
import { BasketChart } from './BasketChart'

// No em dashes in shown copy (owner call) — fold "—"/"–" into commas.
function tidyRowDesc(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim()
}

// The icon popovers PORTAL to <body>: the rows' staggered-entrance wrappers
// (.enter) hold a filter value, which makes every row its own stacking context —
// an in-flow popover would paint UNDER the next row no matter its z-index. A
// fixed-position portal escapes all of that and flips upward near the fold.
function IconPopover({ anchor, children }: { anchor: DOMRect; children: ReactNode }) {
  const W = 210
  const flipUp = anchor.bottom + 200 > window.innerHeight
  const style: CSSProperties = {
    position: 'fixed',
    left: Math.min(Math.max(anchor.left + anchor.width / 2, 8 + W / 2), window.innerWidth - 8 - W / 2),
    top: flipUp ? undefined : anchor.bottom + 8,
    bottom: flipUp ? window.innerHeight - anchor.top + 8 : undefined,
    transform: 'translateX(-50%)',
    zIndex: 80,
    pointerEvents: 'none',
  }
  return createPortal(
    <div style={style} className="w-max">
      {children}
    </div>,
    document.body,
  )
}

// Calm, scannable row: ticker, name, description, a basket-logo preview, and a
// trend sparkline — the full bento stays hidden until you expand the row. The
// Visit button jumps to the dedicated basket page.
// `stats` (Explore's Baskets tab — the performance lens, owner 2026-07-06 12:34)
// puts perf-to-date · holders · TVL on the FACE; elsewhere (Home rows) the face
// stays thesis-first with numbers below the fold (R+C walkthrough).
export function BasketListRow({ ix, rank, chain, stats = false, open: controlledOpen, onOpenChange }: { ix: BasketSummary; rank?: number; chain?: BasketSummary[]; stats?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  // Uncontrolled by default (own state); optionally controlled so a parent can
  // expand rows in pairs (Slash Creators opens both cards in a row together).
  const [openState, setOpenState] = useState(false)
  const open = controlledOpen ?? openState
  const toggleOpen = () => (onOpenChange ? onOpenChange(!open) : setOpenState((o) => !o))
  // the expansion's bento⇄graph lens (owner 19:24) + the dotted constituents
  const [face, setFace] = useState<'bento' | 'chart'>('bento')
  // which asset icon is hovered (its live-price popover shows) + where it is
  // on screen (the popover is a fixed portal — see IconPopover).
  const [tok, setTok] = useState<{ key: string; rect: DOMRect } | null>(null)
  // The creator's signed thesis — on the row FACE now (thesis-first, R+C
  // walkthrough 2026-07-06), so it fetches eagerly; react-query dedupes per
  // basket and the same query feeds the expansion.
  const { data: meta } = useCreatorMeta(ix.address, ix.chainId)
  // the full basket read powers the in-row swap strip; fetches only once opened
  const { data: full } = useBasketData(open && SWAP_ENABLED ? ix.address : undefined, ix.chainId)
  const faceThesis = meta?.tagline || meta?.thesis || null
  const up = (ix.change24hPct ?? 0) >= 0
  const accent = up ? 'var(--color-cyan)' : 'var(--color-magenta)'
  const logos = ix.top.slice(0, 6)
  const moreLogos = Math.max(0, ix.top.length - logos.length)
  const bentoItems = ix.top.map((t) => ({
    symbol: t.symbol,
    address: t.address,
    weightPct: t.weightPct,
    chainId: ix.chainId,
  }))

  return (
    <div className="relative rounded-xl border border-white/10 bg-white/[0.025] transition-colors hover:border-white/20">
      {/* the basket's own paper-warp identity, faded left so the text keeps contrast */}
      <BasketWash ix={ix} opacity={0.34} />
      {/* header — click anywhere (except Visit) to expand the basket */}
      <div className="relative flex items-center gap-4 px-3 py-3 sm:px-4">
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-label={`Toggle ${ix.symbol} basket`}
          className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan/70"
        />

        {/* identity — ONE line across the width: ticker · name · creator
            (details like the description live in the expanded view) */}
        <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3.5">
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            className={`h-4 w-4 shrink-0 text-ink-faint transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          {rank != null && <span className="w-5 shrink-0 text-center font-mono text-xs tabular-nums text-ink-faint">{rank}</span>}
          <BasketAvatar address={ix.address} symbol={ix.symbol} size={36} />
          <div className="flex min-w-0 flex-1 items-baseline gap-x-3">
            <span className="shrink-0 font-display text-base font-bold leading-none text-ink">${ix.symbol}</span>
            <span className="hidden max-w-[11rem] shrink-0 truncate text-sm text-ink-dim min-[440px]:block">{ix.name?.trim() || '—'}</span>
            {/* THE THESIS on the face — why this basket exists, before any number
                (thesis-first, R+C 2026-07-06); the n-asset line is the fallback.
                In stats mode the numbers ARE the face, the thesis lives one
                tab over and in the expansion. */}
            {!stats && (
              <span className="hidden min-w-0 flex-1 truncate text-[13px] text-ink-dim/90 sm:block">
                {faceThesis ? tidyRowDesc(faceThesis) : `a ${ix.basketLength}-asset onchain basket`}
              </span>
            )}
          </div>
        </div>

        {/* stats face (Baskets tab): performance to date · holders · TVL —
            value-over-caption like the creator rows, sized to actually READ
            (owner 13:46: bigger descriptors, bigger numbers, more width) */}
        {stats && (
          <div className="pointer-events-none relative flex shrink-0 items-end gap-5 text-right sm:gap-8">
            <div className="w-[5.5rem]">
              {perfMeasurable(ix) ? (
                (() => {
                  const p = perfToDate(ix) * 100
                  return (
                    <div
                      className={`font-num font-semibold leading-none tabular-nums ${Math.abs(p) >= 1000 ? 'text-sm' : 'text-lg sm:text-xl'}`}
                      style={{ color: p >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)' }}
                    >
                      {Math.abs(p) >= 1000 ? `${p >= 0 ? '+' : ''}${Math.round(p).toLocaleString()}%` : formatPct(p)}
                    </div>
                  )
                })()
              ) : (
                <div
                  className="font-num text-lg leading-none text-ink-faint"
                  title={`Below the $${MEASURABLE_TVL_FLOOR_USD.toLocaleString()} measurable-TVL floor, NAV here is fee arithmetic, not performance`}
                >
                 —
                </div>
              )}
              <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">to date</div>
            </div>
            <div className="hidden w-16 min-[520px]:block">
              <div className="font-num text-lg leading-none tabular-nums text-ink sm:text-xl">
                {ix.holdersCount != null ? ix.holdersCount.toLocaleString() : '—'}
              </div>
              <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">holders</div>
            </div>
            <div className="hidden w-20 min-[440px]:block">
              <div className="font-num text-lg leading-none tabular-nums text-ink sm:text-xl">{formatUsdCompact(ix.aumUsd)}</div>
              <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">TVL</div>
            </div>
          </div>
        )}

        {/* the basket's assets — front and centre, hover one for its live price
            (owner ask 2026-07-06). pointer-events-auto: they sit over the
            row-toggle overlay like the Visit button does. NOT in stats mode:
            a variable-width strip here knocked the stat columns out of
            vertical alignment row-to-row (owner 2026-07-06 ~15:0x) — on the
            performance list the logos live in the expansion. */}
        {!stats && (
          <div className="pointer-events-auto relative hidden items-center sm:flex">
            <div className="flex items-center -space-x-1.5">
              {logos.map((t) => {
                const k = t.address.toLowerCase()
                return (
                  <div
                    key={t.address}
                    className="relative transition-transform hover:z-20"
                    onMouseEnter={(e) => setTok({ key: k, rect: e.currentTarget.getBoundingClientRect() })}
                    onMouseLeave={() => setTok((p) => (p?.key === k ? null : p))}
                  >
                    <span className="block cursor-pointer rounded-full ring-2 ring-panel/90 transition-transform duration-150 hover:scale-110">
                      <AssetLogo address={t.address} symbol={t.symbol} chainId={ix.chainId} size={26} />
                    </span>
                    {tok?.key === k && (
                      <IconPopover anchor={tok.rect}>
                        <AssetHoverCard chainId={ix.chainId} address={t.address} symbol={t.symbol} weightPct={t.weightPct} />
                      </IconPopover>
                    )}
                  </div>
                )
              })}
            </div>
            {moreLogos > 0 && <span className="ml-2 font-mono text-[10px] text-ink-faint">+{moreLogos}</span>}
          </div>
        )}

        {/* numbers live in the expansion now (below-the-fold content — R+C);
            the face keeps identity · thesis · assets · Visit */}

      </div>

      {/* expandable bento */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-white/10 p-3">
            <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 min-[440px]:hidden">
              <span className="text-sm text-ink">{ix.name?.trim() || '—'}</span>
            </div>
            {/* the creator's signed thesis leads the expansion (owner ask) — its
                own quiet panel with real air, the creator's face on the right;
                the honest asset-count line is the no-thesis fallback */}
            {meta?.tagline || meta?.thesis ? (
              <div className="mb-3 flex items-center gap-5 rounded-xl border border-white/[0.06] bg-black/20 px-5 py-4 sm:gap-6 sm:px-6">
                <div className="min-w-0 flex-1">
                  {meta.tagline && <p className="font-display text-[15px] font-semibold leading-snug text-ink">{meta.tagline}</p>}
                  {meta.thesis && (
                    <p className={`${meta.tagline ? 'mt-2' : ''} line-clamp-3 max-w-3xl text-[13px] leading-relaxed text-ink-dim`}>{meta.thesis}</p>
                  )}
                  <div className="mt-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
                    The creator&rsquo;s signed thesis · a {ix.basketLength}-asset onchain basket
                  </div>
                </div>
                {ix.deployer && (() => {
                  const identity = resolveCreator({ handle: meta?.handle, name: meta?.name, deployer: ix.deployer })
                  const avatarSymbol = identity.kind === 'address' ? 'x' : identity.label.replace(/^@/, '')
                  return (
                    <Link
                      to={`/creator/${ix.deployer}`}
                      className="group/creator flex shrink-0 flex-col items-center gap-2 self-center"
                    >
                      <span className="overflow-hidden rounded-full ring-2 ring-white/12 transition-transform duration-150 group-hover/creator:scale-105">
                        <BasketAvatar address={ix.deployer} symbol={avatarSymbol} imageUrl={meta?.avatarUrl ?? undefined} size={40} />
                      </span>
                      <span className="max-w-[7.5rem] truncate font-mono text-[10px] text-ink-dim group-hover/creator:text-cyan">
                        {identity.label}
                      </span>
                    </Link>
                  )
                })()}
              </div>
            ) : (
              <div className="mb-2.5 px-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                {`A ${ix.basketLength}-asset onchain basket`}
              </div>
            )}
            {/* the lens toggle sits ABOVE the basket, below the thesis (19:24) */}
            <div className="mb-2 flex items-center gap-1.5 px-0.5">
              {(['bento', 'chart'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFace(f)}
                  aria-pressed={face === f}
                  className={`press rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                    face === f ? 'border-white/25 bg-white/10 text-ink' : 'border-white/10 text-ink-faint hover:text-ink-dim'
                  }`}
                >
                  {f === 'bento' ? 'Basket' : 'Graph'}
                </button>
              ))}
            </div>
            {face === 'chart' ? (
              <BasketChart
                chainId={ix.chainId}
                assets={ix.top.map((t) => ({ address: t.address, weight: t.weightPct }))}
                navPerToken={ix.navPerToken}
                ageSec={null}
                symbol={`$${ix.symbol}`}
                fallback={ix.navSeries}
                underlyingAssets={ix.top.map((t) => ({ address: t.address, symbol: t.symbol }))}
                heightClass="h-44 sm:h-52"
              />
            ) : (
              <BasketBento items={bentoItems} aspect={3.2} />
            )}
            {/* numbers (off the face) + trend + creator: below-the-fold, as agreed */}
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 px-0.5">
              <span className="font-mono text-[11px] text-ink-dim">
                <span className="text-ink">${formatNav(ix.navPerToken, 4)}</span> NAV
              </span>
              <span className="font-num text-[11px] font-semibold tabular-nums" style={{ color: accent }}>
                {formatPct(ix.change24hPct)} 24h
              </span>
              <span className="flex items-center gap-1 font-mono text-[10px] tracking-wide text-ink-faint">
                <span>by</span>
                <CreatorChip deployer={ix.deployer} basket={ix.address} chainId={ix.chainId} size={14} className="font-mono text-[10px]" />
              </span>
            </div>
            {/* the version journey (owner pick #5) + the concrete-money line (#2) */}
            {(
              <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-0.5">
                {chain && chain.length > 1 ? <VersionJourney chain={chain} /> : <span />}
                {perfMeasurable(ix) && (
                  <span className="font-mono text-[10px] text-ink-faint">
                    $100 at launch → <span className="text-ink">${Math.round(100 * ix.navPerToken).toLocaleString()}</span> today
                  </span>
                )}
              </div>
            )}

            {/* buy it RIGHT HERE (R+C 18:26: "you should be able to swap it
                right here") — the real console, locked to this basket; the
                page link rides beside it as Read the basket */}
            {SWAP_ENABLED && full && (
              <div className="mt-3">
                <DexSwapCard chainId={ix.chainId} fixedBasket={full} strip />
              </div>
            )}
            <div className="mt-3 flex justify-end px-0.5">
              <Link
                to={`/token?addr=${ix.address}&chain=${ix.chainId}`}
                className="press rounded-lg border border-white/15 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
              >
                Read the basket →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
