import { useState, type CSSProperties, type ReactNode } from 'react'
import { showName, showSymbol } from '../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { basketHref } from '../lib/spectrum/short-url'
import { Link } from 'react-router'
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
      {/* THE ROW OVERLAPPED ITSELF ON A PHONE (owner 2026-08-06 23:13: "you see
          BASECORE and then you see the percentages … all of that information
          needs to be visible, not clipping"). The identity block is `flex-1
          min-w-0` but its ticker was `shrink-0`, so once the two stat columns
          were subtracted the ticker had nowhere to go and PAINTED OVER the
          percentage — not a clip, an overlap. Every gap and every figure below
          is reduced under `sm` so the four facts (ticker · perf · TVL, and the
          rank) fit side by side at 390px; from `sm` up the row is exactly what
          it was. */}
      <div className="relative flex items-center gap-2 px-3 py-3 sm:gap-4 sm:px-4">
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-label={`Toggle ${showSymbol(ix.symbol)} basket`}
          className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan/70"
        />

        {/* identity — ONE line across the width: ticker · name · creator
            (details like the description live in the expanded view) */}
        <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 sm:gap-3.5">
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            className={`h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-200 sm:h-4 sm:w-4 ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          {rank != null && <span className="w-4 shrink-0 text-center font-mono text-xs tabular-nums text-ink-faint sm:w-5">{rank}</span>}
          {/* THE AVATAR IS WHAT PAYS FOR THE TICKER (owner 2026-08-06 23:13).
              Measured at 390px: 316px of row content, of which the two stat
              columns take 160 and the chevron/rank/avatar/gaps take 96, left
              the ticker 52px — "$STONKMEME" needs ~91. It is the one element
              here that repeats what the ticker and the row's own BasketWash
              already say, so below sm it stands down and the ticker gets its
              ~102px. Back at every width the desktop row ever had it. */}
          <span className="hidden shrink-0 sm:block">
            <BasketAvatar address={ix.address} symbol={ix.symbol} size={36} />
          </span>
          <div className="flex min-w-0 flex-1 items-baseline gap-x-2 sm:gap-x-3">
            {/* `min-w-0 truncate` below sm is the guard, not the fix: a ticker
                longer than the room left now ends in an ellipsis instead of
                overlapping the number beside it. `sm:shrink-0` hands the
                desktop row back its original behaviour untouched. */}
            {/* ⚠ BOUNDED, and it lost this guard in the absorption union
                (specallocator's catch, 2026-08-07): my lane rewrote this line
                for mobile and the merge took my side wholesale, dropping the
                showSymbol their lane had added. The tell was the asymmetry —
                the aria-label above stayed bounded, so a screen-reader user got
                the safe string while a sighted user got the hostile one.
                `truncate` clips the BOX; showSymbol bounds the STRING and
                strips controls and bidi overrides, which CSS cannot do. */}
            <span className="min-w-0 truncate font-display text-sm font-bold leading-none text-ink sm:shrink-0 sm:text-base">${showSymbol(ix.symbol)}</span>
            <span className="hidden max-w-[11rem] shrink-0 truncate text-sm text-ink-dim min-[440px]:block">{ix.name?.trim() ? showName(ix.name) : '—'}</span>
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
          <div className="pointer-events-none relative flex shrink-0 items-end gap-2 text-right sm:gap-8">
            {/* wider column, smaller number, below sm: "+999.99%" is eight
                glyphs and the old 72px box could not hold them at 18px */}
            <div className="w-20 sm:w-[5.5rem]">
              {perfMeasurable(ix) ? (
                (() => {
                  const p = perfToDate(ix) * 100
                  return (
                    <div
                      className={`font-num font-semibold leading-none tabular-nums ${Math.abs(p) >= 1000 ? 'text-sm' : 'text-base sm:text-xl'}`}
                      style={{ color: p >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)' }}
                    >
                      {Math.abs(p) >= 1000 ? `${p >= 0 ? '+' : ''}${Math.round(p).toLocaleString()}%` : formatPct(p)}
                    </div>
                  )
                })()
              ) : (
                <div
                  className="font-num text-base leading-none text-ink-faint sm:text-lg"
                  title={`Below the $${MEASURABLE_TVL_FLOOR_USD.toLocaleString()} measurable-TVL floor, NAV here is fee arithmetic, not performance`}
                >
                 —
                </div>
              )}
              <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-dim sm:text-[10px]">to date</div>
            </div>
            <div className="hidden w-16 min-[520px]:block">
              <div className="font-num text-base leading-none tabular-nums text-ink sm:text-xl">
                {ix.holdersCount != null ? ix.holdersCount.toLocaleString() : '—'}
              </div>
              <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-dim sm:text-[10px]">holders</div>
            </div>
            {/* TVL IS NEVER HIDDEN (mobile sweep 2026-08-06): this lens ranks
                by TVL⊕perf, and below 440px every row rendered as rank +
                ticker + dead space — the two facts the ordering is MADE of
                were both gone, and four of seven rows read a bare "— to
                date". The one number that explains the order stays at every
                width; holders (below) is still the widescreen extra. */}
            <div className="w-[4.5rem] sm:w-20">
              <div className="font-num text-base leading-none tabular-nums text-ink sm:text-xl">{formatUsdCompact(ix.aumUsd)}</div>
              <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-dim sm:text-[10px]">TVL</div>
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
              {/* ⚠ BOUNDED IN CODE, because nothing bounds it in CSS here
                  (specallocator's sweep, 2026-08-07): this span sits in a
                  flex-wrap row with no truncate, no line-clamp and no
                  max-width, so a deployer name's length is genuinely unbounded
                  at this site. showName also does what CSS never can — strip
                  bidi overrides and zero-width characters. */}
              <span className="text-sm text-ink">{showName(ix.name) || '—'}</span>
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
                symbol={`$${showSymbol(ix.symbol)}`}
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
              // -mx-0.5 gives the strip the row's full width back (the expansion's
              // px-0.5 gutter was squeezing the one control that must never
              // collide); the strip itself is container-queried, so it uses it
              <div className="-mx-0.5 mt-3">
                <DexSwapCard chainId={ix.chainId} fixedBasket={full} strip />
              </div>
            )}
            <div className="mt-3 flex justify-end px-0.5">
              <Link
                to={basketHref(ix)}
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
