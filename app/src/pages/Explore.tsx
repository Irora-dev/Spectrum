import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAllBaskets, useBasketSectors, useCreatorMeta } from '../lib/spectrum/hooks'
import {
  buildCreatorLeaderboard,
  rankBaskets,
  collectAssets,
  basketHasAsset,
  perfToDate,
  type CreatorEntry,
  type AssetRef,
} from '../lib/spectrum/leaderboard'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { resolveCreator } from '../lib/spectrum/creator'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { formatPct, formatUsdCompact } from '../lib/spectrum/format'
import { useFollows } from '../lib/spectrum/follows'
import { BasketAvatar } from '../components/BasketAvatar'
import { AssetLogo } from '../components/AssetLogo'
import { BasketBento } from '../components/BasketBento'
import { BasketListRow } from '../components/BasketListRow'
import { BasketWash } from '../components/BasketWash'
import { LaunchCta } from '../components/LaunchCta'
import { VersionJourneyMini } from '../components/VersionJourney'
import { WarpIdentity } from '../components/WarpIdentity'
import { perfMeasurable, versionChain } from '../lib/spectrum/leaderboard'
import { FollowButton } from '../components/FollowButton'
import { PageHeader } from '../components/PageHeader'
import { matchesTerms, parseQueryTerms, termsHitLabel } from '../lib/spectrum/search'
import { listable } from '../lib/spectrum/leaderboard'
import { useWalletAssets } from '../lib/spectrum/use-wallet-assets'
import { tagAllowed } from '../lib/spectrum/tags'
import { DexSwapCard } from '../components/DexSwapCard'
import { SWAP_ENABLED } from '../lib/config/features'
import { DEFAULT_CHAIN_ID } from '../lib/chain/chains'
import { SpectralSearch } from '../components/SpectralSearch'
import { BasketChart } from '../components/BasketChart'
import { BlueprintBasket } from '../components/BlueprintBasket'

// ─────────────────────────────────────────────────────────────────────────────
// /explore — the site's flagship social page. Three lenses on one catalogue:
//   • Thesis (default) — every index as bento + thesis cards behind the search
//   • Baskets — the performance list: TVL⊕perf rank-sum, numbers on the face
//   • Creators — each creator + their standout basket (leaderboard folded in)
// A clickable asset-icon row narrows Baskets + Creators to baskets holding that
// asset. Runs on on-chain truth alone; the operator DB later enriches the windows.
// Ranking = value / activity / on-chain performance, never an editorial "pick":
// factual labels + a past-performance disclaimer, no ratings (compliance §9).
// ─────────────────────────────────────────────────────────────────────────────

type ChainFilter = 'all' | 1 | 8453
type View = 'thesis' | 'baskets' | 'creators'

function pctColor(p: number | null | undefined): string {
  return (p ?? 0) >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)'
}
function bentoItems(b: BasketSummary) {
  return b.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct, chainId: b.chainId }))
}
// No em dashes in shown copy (owner call) — fold "—"/"–" into commas.
function tidyDesc(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim()
}
// A percentage, formatted + sized so big numbers (e.g. +10,000%) don't clip.
function PerfText({ pct, base = 'text-xl' }: { pct: number; base?: string }) {
  const a = Math.abs(pct)
  const text = a >= 1000 ? `${pct >= 0 ? '+' : ''}${Math.round(pct).toLocaleString()}%` : formatPct(pct)
  const size = a >= 10000 ? 'text-xs' : a >= 1000 ? 'text-sm' : base
  return (
    <span className={`font-num font-semibold tabular-nums ${size}`} style={{ color: pctColor(pct) }}>
      {text}
    </span>
  )
}

function useCreatorIdentity(entry: CreatorEntry) {
  const { data: meta } = useCreatorMeta(entry.bestBasket.address, entry.bestBasket.chainId)
  const identity = resolveCreator({ handle: meta?.handle, name: meta?.name, deployer: entry.address })
  return { meta, identity }
}

function Disclaimer() {
  return (
    <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
      Ranked by on-chain value and performance to date (a basket's current NAV against its ~$1.00 launch), not a
      recommendation.{' '}
      <Link to="/risk" className="text-ink-dim underline-offset-2 hover:text-cyan hover:underline">
        Past performance is not indicative of future results.
      </Link>
    </p>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`press inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
        active ? 'border-white/25 bg-white/10 text-ink' : 'border-white/10 text-ink-faint hover:text-ink-dim'
      }`}
    >
      {children}
    </button>
  )
}

// ── masthead headline stats (owner ask: larger, better presented) ────────────
function HeadlineStat({ value, label, divider = false, accent = false }: { value: string; label: string; divider?: boolean; accent?: boolean }) {
  return (
    <div className={`text-right ${divider ? 'ml-5 border-l border-white/10 pl-5 sm:ml-7 sm:pl-7' : ''}`}>
      <div className={`font-num text-2xl leading-none tabular-nums sm:text-3xl ${accent ? 'text-cyan' : 'text-ink'}`}>{value}</div>
      <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">{label}</div>
    </div>
  )
}

function Interactive({ children }: { children: ReactNode }) {
  return <span className="pointer-events-auto relative z-10">{children}</span>
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-ink-faint">{children}</div>
}

// ── asset filter row (clickable icons of every asset on the page) ────────────
function AssetFilterRow({ assets, selected, onSelect }: { assets: AssetRef[]; selected: string | null; onSelect: (a: string | null) => void }) {
  if (assets.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Filter by asset</span>
      {assets.map((a) => {
        const on = selected === a.address.toLowerCase()
        return (
          <button
            key={a.address.toLowerCase()}
            type="button"
            onClick={() => onSelect(on ? null : a.address.toLowerCase())}
            title={on ? `Showing baskets with ${a.symbol}` : `Only baskets with ${a.symbol}`}
            aria-pressed={on}
            className={`press inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 transition-colors ${
              on ? 'border-cyan/50 bg-cyan/10' : 'border-white/10 hover:border-white/30'
            }`}
          >
            <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={18} />
            <span className={`font-mono text-[10px] uppercase tracking-[0.1em] ${on ? 'text-cyan' : 'text-ink-dim'}`}>{a.symbol}</span>
          </button>
        )
      })}
      {selected && (
        <button type="button" onClick={() => onSelect(null)} className="press font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-cyan">
          Clear ✕
        </button>
      )}
    </div>
  )
}

// ── the highlight slideshow: top three baskets, bento-first ─────────────────
// One hero card that cycles the top three performers. The bento treemap runs the
// FULL width on top (tiles re-reveal on every slide change); beneath it the
// identity (ticker · name · creator) sits left and the thesis right, with the
// View CTA at the card's bottom-right corner (owner relayout 2026-07-06 12:34).
// Auto-advances gently; pauses on hover/focus; sits out entirely under
// prefers-reduced-motion. Rank is factual, never an editorial pick (§9).
interface SpotNav {
  n: number
  idx: number
  onDot: (i: number) => void
  onNext: () => void
  /** compact carries the bento⇄graph toggle inside the same pill row */
  face?: 'bento' | 'chart'
  onFace?: (f: 'bento' | 'chart') => void
}

function SpotlightSlide({ ix, active, booted = true, compact = false, nav, face = 'bento' }: { ix: BasketSummary; active: boolean; booted?: boolean; compact?: boolean; nav?: SpotNav; face?: 'bento' | 'chart' }) {
  const { data: meta } = useCreatorMeta(ix.address, ix.chainId)
  const identity = resolveCreator({ handle: meta?.handle, name: meta?.name, deployer: ix.deployer ?? undefined })
  const accent = basketSignatureColor(ix.address, ix.top[0])
  const tagline = meta?.tagline || null
  const thesis = meta?.thesis || null
  const avatarSymbol = identity.kind === 'address' ? 'x' : identity.label.replace(/^@/, '')

  return (
    <div
      aria-hidden={!active}
      style={{ gridArea: '1 / 1' }}
      className={`h-full transition-[opacity,transform,visibility] duration-700 ease-out ${active ? 'visible opacity-100' : 'invisible pointer-events-none translate-y-1.5 opacity-0'}`}
    >
      <div className="relative flex h-full flex-col gap-5 px-5 pb-5 pt-5 sm:px-6">
        {/* the basket's LIVE paper-warp identity (same shader as its own page's
            hero, only three slides ever mount, so the WebGL budget is safe),
            masked toward the bento on top so the text zone below keeps contrast */}
        <WarpIdentity
          seed={`${ix.chainId}:${ix.address.toLowerCase()}`}
          colors={[accent, ...ix.top.slice(0, 3).map((t) => tokenVisual(t.symbol, t.address).color)]}
          drift={false}
          speed={active ? 0.9 : 0.15}
          className="pointer-events-none absolute inset-0 mix-blend-screen opacity-[0.3] [mask-image:linear-gradient(180deg,black_0%,rgba(0,0,0,0.5)_52%,rgba(0,0,0,0.12)_82%,transparent_100%)]"
        />

        {/* the bento — the hero, full width (owner ask 2026-07-06 12:34).
            Tiles re-reveal each time this slide activates. */}
        {face === 'chart' ? (
          /* the REAL interactive chart — un-linked so its controls work */
          <div className={`relative overflow-hidden rounded-2xl border border-white/10 bg-black/25 p-3 sm:p-3.5 ${compact ? 'min-h-[200px] sm:min-h-[250px]' : 'min-h-[230px] sm:min-h-[340px]'}`}>
            <BasketChart
              chainId={ix.chainId}
              assets={ix.top.map((t) => ({ address: t.address, weight: t.weightPct }))}
              navPerToken={ix.navPerToken}
              ageSec={null}
              symbol={`$${ix.symbol}`}
              fallback={ix.navSeries}
              underlyingAssets={ix.top.map((t) => ({ address: t.address, symbol: t.symbol }))}
              heightClass={compact ? 'h-40 sm:h-48' : 'h-48 sm:h-64'}
            />
          </div>
        ) : (
        <Link to={`/token?addr=${ix.address}&chain=${ix.chainId}`} className="relative block overflow-hidden rounded-2xl border border-white/10 bg-black/25 p-3 transition-colors hover:border-white/25 sm:p-3.5">
          <BasketBento items={bentoItems(ix)} fill className={compact ? 'min-h-[200px] sm:min-h-[250px]' : 'min-h-[230px] sm:min-h-[340px]'} reveal={{ delayMs: 150, stepMs: 60 }} show={active && booted} />
        </Link>
        )}
        {/* compact: the Basket/Graph pill rides the bento's TOP-RIGHT (owner
            19:24) — a sibling of the card link, so it never navigates */}
        {compact && nav?.face && nav.onFace && (
          <div className="absolute right-8 top-8 z-10">
            <FaceToggle face={nav.face} onChange={nav.onFace} />
          </div>
        )}

        {/* beneath the bento: identity left · thesis right (owner relayout) */}
        <div className="relative grid flex-1 gap-5 lg:grid-cols-[1fr_1.45fr] lg:gap-8">
          {/* ── identity: ticker · name · creator, under the basket; in
                 compact the slideshow pill pins to the column bottom, level
                 with the View-basket button (owner 18:04) ── */}
          <div className={`min-w-0 ${nav ? 'flex flex-col' : ''}`}>
            <Link to={`/token?addr=${ix.address}&chain=${ix.chainId}`} className="block">
              <span className="font-display text-4xl font-bold leading-none tracking-tight text-ink sm:text-5xl">${ix.symbol}</span>
            </Link>
            <div className="mt-2.5 truncate text-base text-ink-dim">{ix.name?.trim() || ix.symbol}</div>
            {ix.deployer && (
              <Link to={`/creator/${ix.deployer}`} className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-1 pr-3 transition-colors hover:border-white/25">
                <BasketAvatar address={ix.deployer} symbol={avatarSymbol} imageUrl={meta?.avatarUrl ?? undefined} size={20} />
                <span className="truncate font-mono text-[11px] text-ink-dim">{identity.label}</span>
              </Link>
            )}
            {/* the slideshow pill: very bottom-left, in line with View basket */}
            {nav && (
              <div className="mt-auto flex items-center gap-2 self-start pt-3.5">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/35 px-2.5 py-1.5 backdrop-blur-sm">
                {Array.from({ length: nav.n }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Show basket ${i + 1}`}
                    aria-current={i === nav.idx}
                    onClick={() => nav.onDot(i)}
                    className="press grid h-5 place-items-center px-0.5"
                  >
                    <span
                      className={`block h-2 rounded-full transition-all duration-300 ${i === nav.idx ? 'w-6' : 'w-2 bg-white/30 hover:bg-white/50'}`}
                      style={i === nav.idx ? { background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' } : undefined}
                    />
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Next basket"
                  onClick={() => nav.onNext()}
                  className="press grid h-6 w-6 place-items-center rounded-full text-ink-dim transition-colors hover:text-ink"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                </button>
              </div>

              </div>
            )}
          </div>

          {/* ── THE THESIS — bigger, to the right of the identity; the launch
                 post's X mark sits quietly in its corner. The CTA below it,
                 right-aligned = the card's bottom-right corner. ── */}
          <div className="flex min-w-0 flex-col gap-4">
            {(tagline || thesis) && (
              <div className="relative rounded-xl border border-white/[0.08] bg-black/25 px-5 py-4 pr-11">
                {meta?.postUrl && (
                  <a
                    href={meta.postUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="The launch post on X"
                    title="The launch post on X"
                    className="press absolute right-3.5 top-3.5 text-ink-faint transition-colors hover:text-ink"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                  </a>
                )}
                {tagline && <p className="font-display text-xl font-semibold leading-snug text-ink">{tidyDesc(tagline)}</p>}
                {thesis && (
                  <p className={`${tagline ? 'mt-2' : ''} line-clamp-3 font-display text-[16px] leading-relaxed ${tagline ? 'text-ink-dim' : 'text-ink'} sm:text-[17px]`}>
                    {tidyDesc(thesis)}
                  </p>
                )}
              </div>
            )}
            <div className="mt-auto flex justify-end">
              <Link
                to={`/token?addr=${ix.address}&chain=${ix.chainId}`}
                className="press inline-flex items-center gap-2 rounded-xl border border-white/15 px-6 py-3 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
              >
                View basket →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// `compact` (the homepage hero peek, 16:55 + 17:08): no control strip on top
// and no outer chrome — the card opens straight onto the bento — with the
// slideshow controls (dots + next) tucked INSIDE the bento's bottom-left
// corner and a faster 3.5s auto-advance (hover still pauses).
export function BasketSpotlight({ baskets, compact = false }: { baskets: BasketSummary[]; compact?: boolean }) {
  const [idx, setIdx] = useState(0)
  const [face, setFace] = useState<'bento' | 'chart'>('bento')
  const [paused, setPaused] = useState(false)
  // WCAG 2.2.2: auto-rotation needs an explicit stop, not just hover-pause
  // (which touch users never discover). Persistent + user-controlled.
  const [stopped, setStopped] = useState(false)
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const n = baskets.length

  // First-load bento pop (owner 13:46): the tile reveal already fires on every
  // slide CHANGE; starting `booted` false for one beat makes the FIRST bento
  // pop on mount too. Reduced motion boots instantly (no new load animation).
  const [booted, setBooted] = useState(reduced)
  useEffect(() => {
    if (booted) return
    const t = window.setTimeout(() => setBooted(true), 80)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (idx >= n) setIdx(0)
  }, [n, idx])
  useEffect(() => {
    if (paused || stopped || reduced || n < 2) return
    const t = window.setInterval(() => setIdx((i) => (i + 1) % n), compact ? 3500 : 6500)
    return () => window.clearInterval(t)
  }, [paused, stopped, reduced, compact, n])
  if (n === 0) return null

  const arrow = 'press grid h-9 w-9 place-items-center rounded-xl border border-white/12 bg-white/[0.03] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan sm:h-11 sm:w-11'
  return (
    <section
      aria-label="Top baskets"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      className={
        compact
          ? 'relative overflow-hidden rounded-3xl' // chrome-less: no box behind the bento (owner 17:08)
          : 'relative overflow-hidden rounded-3xl border border-white/12 bg-white/[0.03] backdrop-blur-md'
      }
    >
      {!compact && (
        <div aria-hidden className="h-1 w-full" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
      )}

      {/* header row: label left · dots + arrows right (compact drops the whole
          strip — the card opens straight onto the bento) */}
      {!compact && (
      <div className="flex items-center justify-between gap-3 px-5 pb-2.5 pt-4 sm:px-6">
        <FaceToggle face={face} onChange={setFace} />
        {n > 1 && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              {baskets.map((b, i) => (
                <button
                  key={`${b.chainId}:${b.address}`}
                  type="button"
                  onClick={() => setIdx(i)}
                  aria-label={`Show $${b.symbol}`}
                  aria-current={i === idx}
                  className="press grid h-6 place-items-center px-0.5"
                >
                  <span
                    className={`block h-2.5 rounded-full transition-all duration-300 ${i === idx ? 'w-9' : 'w-2.5 bg-white/20 hover:bg-white/40'}`}
                    style={i === idx ? { background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' } : undefined}
                  />
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => setIdx((idx - 1 + n) % n)} aria-label="Previous basket" className={arrow}>
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
              </button>
              <button type="button" onClick={() => setIdx((idx + 1) % n)} aria-label="Next basket" className={arrow}>
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
              </button>
              <button
                type="button"
                onClick={() => setStopped((v) => !v)}
                aria-label={stopped ? 'Resume the slideshow' : 'Pause the slideshow'}
                aria-pressed={stopped}
                className={arrow}
              >
                {stopped ? (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* grid-stacked slides — the container sizes to the tallest, no absolute jumps */}
      <div className="grid">
        {baskets.map((b, i) => (
          <SpotlightSlide
            key={`${b.chainId}:${b.address}`}
            ix={b}
            active={i === idx}
            booted={booted}
            compact={compact}
            face={face}
            nav={compact && n > 1 ? { n, idx, onDot: setIdx, onNext: () => setIdx((idx + 1) % n), face, onFace: setFace } : undefined}
          />
        ))}
      </div>

      </section>
  )
}

// ── creator row — the ONE creators surface (leaderboard folded in; exported
//    for Home's Creators tab) ──────────────────────────────────────────────
export function CreatorLine({ entry, rank, w = 'value' }: { entry: CreatorEntry; rank: number; w?: LbWindow }) {
  const { meta, identity } = useCreatorIdentity(entry)
  const best = entry.bestBasket
  const perf = perfToDate(best) * 100
  const avatarSymbol = identity.kind === 'address' ? 'x' : identity.label.replace(/^@/, '')
  const dayRet = best.change24hPct ?? null

  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/[0.025] p-3 transition-colors hover:border-white/20 sm:p-4">
      <BasketWash ix={best} opacity={0.26} />
      <Link to={`/creator/${entry.address}`} aria-label={identity.label} className="absolute inset-0 z-0 rounded-2xl" />
      {/* pointer-events-none: every non-interactive pixel falls through to the
          profile link above; Interactive children opt back in (owner note) */}
      <div className="pointer-events-none relative flex items-center gap-3 sm:gap-4">
        <span className="w-5 shrink-0 text-center font-mono text-xs tabular-nums text-ink-faint">{rank}</span>

        <div className="pointer-events-none flex min-w-0 flex-1 items-center gap-3">
          <BasketAvatar address={entry.address} symbol={avatarSymbol} imageUrl={meta?.avatarUrl ?? undefined} size={40} />
          <div className="min-w-0">
            {/* the Signed chip is gone from the rows (owner 13:46) — the badge
                still lives on the creator/token pages where it explains itself */}
            <div className="flex items-center gap-2">
              <span className="truncate font-display text-sm font-semibold text-ink">{identity.label}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
              <span className="line-clamp-1">
                top ${best.symbol}
                {perfMeasurable(best) && (
                  <>
                    {' '}· <span style={{ color: pctColor(perf) }}>{perf >= 1000 ? `${Math.round(perf).toLocaleString()}%` : formatPct(perf)}</span> since launch
                  </>
                )}
              </span>
              <VersionJourneyMini chain={entry.bestVersionChain} />
            </div>
          </div>
        </div>

        {/* value + holders: LARGE, adjacent (owner ask) — no asset logos */}
        <div className="pointer-events-none relative flex shrink-0 items-end gap-5 text-right sm:gap-7">
          <div>
            <div className="font-num text-lg leading-none tabular-nums text-ink sm:text-xl">{formatUsdCompact(entry.combinedTvl)}</div>
            <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">TVL</div>
          </div>
          <div className="hidden min-[440px]:block">
            <div className="font-num text-lg leading-none tabular-nums text-ink sm:text-xl">
              {entry.holdersTotal != null ? entry.holdersTotal.toLocaleString() : entry.basketCount}
            </div>
            <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
              {entry.holdersTotal != null ? 'holders' : entry.basketCount === 1 ? 'basket' : 'baskets'}
            </div>
          </div>
          {w !== 'value' && (
            <div className="hidden w-16 sm:block">
              {w === 'day' && dayRet != null ? (
                <PerfText pct={dayRet} base="text-lg" />
              ) : (
                <div
                  className="font-num text-lg leading-none tabular-nums text-ink-faint"
                  title="Weekly/monthly performance needs the operator's snapshot indexer, available once a data layer is configured."
                >
                 —
                </div>
              )}
              <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">{WINDOW_LABEL[w]}</div>
            </div>
          )}
        </div>

        <Interactive><FollowButton deployer={entry.address} /></Interactive>
      </div>
    </div>
  )
}

// ── the THESIS tab (recording 2026-07-06 12:08): the page's main lens — a
//    what-are-you-looking-for search, tags beneath, then every launched index
//    as bento + thesis + creator + view. Thesis-less baskets show the honest
//    asset-count line; ranking is the same measurable-first perf order. ──────
export function ThesisCard({ ix, chain, face = 'bento' }: { ix: BasketSummary; chain?: BasketSummary[]; face?: 'bento' | 'chart' }) {
  const { data: meta } = useCreatorMeta(ix.address, ix.chainId)
  const identity = resolveCreator({ handle: meta?.handle, name: meta?.name, deployer: ix.deployer ?? undefined })
  const avatarSymbol = identity.kind === 'address' ? 'x' : identity.label.replace(/^@/, '')
  const tagline = meta?.tagline || null
  const thesis = meta?.thesis || null
  // The thesis body collapses behind its title (owner 13:46 — the wall of
  // content thinned; the full read is one tap, right on the card).
  const [openThesis, setOpenThesis] = useState(false)

  return (
    <div className="relative flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] p-5 transition-colors hover:border-white/20 sm:p-6">
      {/* the paper-wash identity, faintly through the whole card (owner 12:34) */}
      <BasketWash ix={ix} opacity={0.28} />
      {face === 'chart' ? (
        /* the REAL interactive chart (identical to the basket page's, 19:4x) —
           NOT link-wrapped: its ranges/underlying/tooltip need the pointer */
        <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black/25 p-3">
          <BasketChart
            chainId={ix.chainId}
            assets={ix.top.map((t) => ({ address: t.address, weight: t.weightPct }))}
            navPerToken={ix.navPerToken}
            ageSec={null}
            symbol={`$${ix.symbol}`}
            fallback={ix.navSeries}
            underlyingAssets={ix.top.map((t) => ({ address: t.address, symbol: t.symbol }))}
            heightClass="h-36 sm:h-40"
          />
        </div>
      ) : (
      <Link to={`/token?addr=${ix.address}&chain=${ix.chainId}`} className="relative block overflow-hidden rounded-xl border border-white/10 bg-black/25 p-3 transition-colors hover:border-white/25">
        {/* …and unmasked BEHIND the bento — the colors bleed through the grid's gaps */}
        <BasketWash ix={ix} side="full" opacity={0.32} />
        <BasketBento items={bentoItems(ix)} aspect={2.3} />
      </Link>
      )}

      <div className="relative mt-4 flex min-w-0 items-center justify-between gap-3">
        <Link to={`/token?addr=${ix.address}&chain=${ix.chainId}`} className="min-w-0">
          <span className="font-display text-xl font-bold leading-tight text-ink">${ix.symbol}</span>
          <span className="ml-2.5 truncate text-sm text-ink-dim">{ix.name?.trim() || ''}</span>
        </Link>
        {ix.deployer && (
          <Link to={`/creator/${ix.deployer}`} className="inline-flex max-w-[45%] shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-1 pr-2.5 transition-colors hover:border-white/25">
            <BasketAvatar address={ix.deployer} symbol={avatarSymbol} imageUrl={meta?.avatarUrl ?? undefined} size={18} />
            <span className="truncate font-mono text-[10px] text-ink-dim">{identity.label}</span>
          </Link>
        )}
      </div>

      <div className="relative mt-3 flex-1">
        {/* the title line: the tagline, else the thesis's own first line */}
        {tagline ? (
          <p className="font-display text-lg font-semibold leading-snug text-ink">{tidyDesc(tagline)}</p>
        ) : thesis ? (
          <p className="line-clamp-1 font-display text-lg font-semibold leading-snug text-ink">{tidyDesc(thesis)}</p>
        ) : (
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
            No thesis published, a {ix.basketLength}-asset onchain basket
          </p>
        )}
        {/* the body reveals on tap (collapsed by default) */}
        {thesis && (
          <>
            <button
              type="button"
              onClick={() => setOpenThesis((v) => !v)}
              aria-expanded={openThesis}
              className="press mt-1.5 flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors hover:text-cyan"
            >
              <svg viewBox="0 0 24 24" className={`h-3 w-3 transition-transform duration-200 ${openThesis ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
              {openThesis ? 'Hide the thesis' : 'Read the thesis'}
            </button>
            {openThesis && <p className="mt-2 text-sm leading-relaxed text-ink-dim">{tidyDesc(thesis)}</p>}
          </>
        )}
      </div>

      <div className="relative mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* the numbers, left of the CTA (owner 12:34; sized up + perf pilled
            13:46): performance to date · holders · TVL. Dust under the
            measurable floor shows no perf claim (§9); missing counts skip. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1.5">
          {chain && chain.length > 1 && <VersionJourneyMini chain={chain} />}
          {perfMeasurable(ix) && (() => {
            const p = perfToDate(ix) * 100
            const c = pctColor(p)
            return (
              <span
                className="inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-1 font-num text-sm font-semibold tabular-nums"
                style={{ color: c, background: `${c}1a`, borderColor: `${c}33` }}
              >
                {Math.abs(p) >= 1000 ? `${p >= 0 ? '+' : ''}${Math.round(p).toLocaleString()}%` : formatPct(p)}
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] opacity-75">to date</span>
              </span>
            )
          })()}
          <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px] tracking-wide text-ink-faint">
            {ix.holdersCount != null && (
              <span>
                <span className="tabular-nums text-ink-dim">{ix.holdersCount.toLocaleString()}</span> holders
              </span>
            )}
            <span>
              <span className="tabular-nums text-ink-dim">{formatUsdCompact(ix.aumUsd)}</span> TVL
            </span>
          </span>
        </div>
        <Link
          to={`/token?addr=${ix.address}&chain=${ix.chainId}`}
          className="press rounded-lg border border-white/15 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
        >
          View basket →
        </Link>
      </div>
    </div>
  )
}

// ── ranking windows (the old leaderboard, folded into Creators) ─────────────
type LbWindow = 'value' | 'day' | 'week' | 'month'
const WINDOW_LABEL: Record<Exclude<LbWindow, 'value'>, string> = { day: 'Today', week: 'This week', month: 'This month' }

function Skeleton() {
  return (
    <div className="space-y-5 py-3">
      <div className="h-20 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-64 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />
        ))}
      </div>
    </div>
  )
}

// ── the idle typing placeholder (owner ask 2026-07-06): the search bar types
//    out inspiration ("Show me all DeFi baskets…") while nobody's using it.
//    Types forward, holds, deletes, next phrase. Stops the moment the input is
//    focused or filled; reduced motion keeps the static placeholder. ─────────
function useTypingPlaceholder(phrases: string[], active: boolean, fallback: string): string {
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const [shown, setShown] = useState('')
  const animate = active && !reduced && phrases.length > 0
  useEffect(() => {
    if (!animate) return
    let i = 0
    let len = 0
    let deleting = false
    let t: number
    const tick = () => {
      const phrase = phrases[i % phrases.length]
      if (!deleting) {
        len++
        setShown(phrase.slice(0, len))
        if (len >= phrase.length) {
          deleting = true
          t = window.setTimeout(tick, 1800) // hold the full phrase
          return
        }
        t = window.setTimeout(tick, 46 + Math.random() * 42) // human-ish typing
      } else {
        len = Math.max(0, len - 2)
        setShown(phrase.slice(0, len))
        if (len === 0) {
          deleting = false
          i++
          t = window.setTimeout(tick, 500)
          return
        }
        t = window.setTimeout(tick, 24)
      }
    }
    t = window.setTimeout(tick, 700)
    return () => window.clearTimeout(t)
  }, [animate, phrases])
  return animate ? `${shown}|` : fallback
}

// ── the bento ⇄ graph face toggle (R+C 18:26) — one pill, two lenses ─────────
function FaceToggle({
  face,
  onChange,
  compact = false,
}: {
  face: 'bento' | 'chart'
  onChange: (f: 'bento' | 'chart') => void
  compact?: boolean
}) {
  const seg = (id: 'bento' | 'chart', label: string) => (
    <button
      type="button"
      onClick={() => onChange(id)}
      aria-pressed={face === id}
      className={`press rounded-full font-mono uppercase tracking-[0.12em] transition-colors ${
        compact ? 'px-2.5 py-1 text-[10px]' : 'px-4 py-1.5 text-xs'
      } ${face === id ? 'bg-white/15 text-ink' : 'text-ink-faint hover:text-ink-dim'}`}
    >
      {label}
    </button>
  )
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full border border-white/10 ${compact ? 'bg-black/35 p-0.5 backdrop-blur-sm' : 'bg-white/[0.03] p-0.5'}`}>
      {seg('bento', 'Basket')}
      {seg('chart', 'Graph')}
    </span>
  )
}

// ── tab button (bigger — owner call; exported: Home's toggle reuses it) ─────
export function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`press rounded-xl px-5 py-2.5 font-display text-sm font-semibold uppercase tracking-[0.14em] transition-colors sm:px-6 sm:text-base ${
        active ? 'bg-white/10 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]' : 'text-ink-faint hover:text-ink-dim'
      }`}
    >
      {children}
    </button>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────
export function Explore() {
  const { data, isLoading, isError } = useAllBaskets()
  const [view, setView] = useState<View>('thesis')
  const [lbWindow, setLbWindow] = useState<LbWindow>('value')
  const [q, setQ] = useState('')
  const [chain, setChain] = useState<ChainFilter>('all')
  const [onlyFollowing, setOnlyFollowing] = useState(false)
  const [asset, setAsset] = useState<string | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const { follows, count: followCount } = useFollows()
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const all = useMemo(() => data ?? [], [data])
  const chainScoped = useMemo(() => (chain === 'all' ? all : all.filter((b) => b.chainId === chain)), [all, chain])
  const hasBoth = all.some((b) => b.chainId === 1) && all.some((b) => b.chainId === 8453)
  const ql = q.trim().toLowerCase()
  // NL smart search (owner 2026-07-06): "i'm interested in agents" → ["agent"]
  const qTerms = useMemo(() => (ql ? parseQueryTerms(ql) : []), [ql])
  const [searchFocused, setSearchFocused] = useState(false)
  // one global bento⇄graph toggle for the card grid (R+C: 'toggle all of them')
  const [cardFace, setCardFace] = useState<'bento' | 'chart'>('bento')

  // assets present on the page (current baskets, chain-scoped) — the filter row
  const assets = useMemo(() => collectAssets(chainScoped.filter((b) => !b.supersededBy)), [chainScoped])
  // assets the CONNECTED wallet holds ≥$100 of (R+C: surface their baskets)
  const heldAssets = useWalletAssets(assets)

  // ── creator-invented tags (signed `sectors`), ranked by frequency × TVL —
  //    "theses and trends" (R+C walkthrough): the trending rail + tag filter.
  //    True most-searched ordering arrives with the operator DB. ──
  const heads = useMemo(() => chainScoped.filter((b) => !b.supersededBy), [chainScoped])
  const sectorsByBasket = useBasketSectors(heads)
  const keyOfB = (b: BasketSummary) => `${b.chainId}:${b.address.toLowerCase()}`
  const trendingTags = useMemo(() => {
    const score = new Map<string, { label: string; n: number; tvl: number }>()
    for (const b of heads) {
      for (const t of sectorsByBasket.get(keyOfB(b)) ?? []) {
        if (!tagAllowed(t)) continue // creator tags are free-form; the site won't render banned ones
        const k = t.toLowerCase()
        const cur = score.get(k) ?? { label: t, n: 0, tvl: 0 }
        cur.n += 1
        cur.tvl += b.aumUsd || 0
        score.set(k, cur)
      }
    }
    return [...score.values()].sort((a, b) => b.n - a.n || b.tvl - a.tvl).slice(0, 10)
  }, [heads, sectorsByBasket])
  const basketHasTag = (b: BasketSummary) => !tag || (sectorsByBasket.get(keyOfB(b)) ?? []).some((t) => t.toLowerCase() === tag)

  // Inspiration the idle search bar types out — PLAIN search words (R+C 18:26:
  // people search a token, a tag, a chain — not sentences): live trending tags
  // first, then the page's top assets, then evergreen category words. The NL
  // matcher still handles sentences if someone types one.
  const searchIdeas = useMemo(
    () => [
      ...trendingTags.slice(0, 3).map((t) => t.label.toLowerCase()),
      ...assets.slice(0, 2).map((a) => a.symbol),
      'blue chip',
      'AI agents',
      'memes',
      'BTC',
      'base',
    ],
    [trendingTags, assets],
  )
  const typedPlaceholder = useTypingPlaceholder(
    searchIdeas,
    view === 'thesis' && !searchFocused && q === '',
    'What are you interested in?',
  )

  // Thesis tab — best-performing, asset-filtered, searchable
  const baskets = useMemo(() => {
    let list = rankBaskets(chainScoped, { sort: 'perf', asset })
    if (tag) list = list.filter(basketHasTag)
    if (qTerms.length) list = list.filter((b) => matchesTerms(`${b.symbol} ${b.name} ${b.address} ${b.top.map((t) => t.symbol).join(' ')} ${(sectorsByBasket.get(keyOfB(b)) ?? []).join(' ')}`, qTerms))
    // sub-$100 baskets browse hidden, search reachable (R+C listing floor)
    if (!qTerms.length) list = list.filter(listable)
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainScoped, asset, qTerms, tag, sectorsByBasket])

  // Baskets tab — the performance list (owner 12:34): TVL⊕perf rank-sum, so
  // "big and performing" beats "merely big" and dust never surfaces
  const weightedBaskets = useMemo(() => {
    let list = rankBaskets(chainScoped, { sort: 'weighted', asset })
    if (tag) list = list.filter(basketHasTag)
    if (qTerms.length) list = list.filter((b) => matchesTerms(`${b.symbol} ${b.name} ${b.address} ${b.top.map((t) => t.symbol).join(' ')} ${(sectorsByBasket.get(keyOfB(b)) ?? []).join(' ')}`, qTerms))
    if (!qTerms.length) list = list.filter(listable)
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainScoped, asset, qTerms, tag, sectorsByBasket])

  // Spotlight — the UNFILTERED top three by performance (search/asset filters
  // scope the rows below, never the page's headline truth).
  const spotlightBaskets = useMemo(() => rankBaskets(chainScoped, { sort: 'perf' }).filter(perfMeasurable).slice(0, 3), [chainScoped])

  // Creators tab (leaderboard folded in) — creator entities, filtered; the
  // Today window re-ranks by the best basket's 24h move (live on-chain), the
  // default ranks by combined value. Week/Month wait on the snapshot indexer.
  const creators = useMemo(() => {
    let list = buildCreatorLeaderboard(chainScoped)
    if (onlyFollowing) list = list.filter((c) => follows.has(c.address.toLowerCase()))
    if (asset) list = list.filter((c) => c.baskets.some((b) => basketHasAsset(b, asset)))
    if (tag) list = list.filter((c) => c.baskets.some(basketHasTag))
    if (qTerms.length) list = list.filter((c) => matchesTerms([c.address, ...c.baskets.map((b) => `${b.symbol} ${b.name} ${b.top.map((t) => t.symbol).join(' ')}`)].join(' '), qTerms))
    if (lbWindow === 'day') list = [...list].sort((a, b) => (b.bestBasket.change24hPct ?? -Infinity) - (a.bestBasket.change24hPct ?? -Infinity))
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainScoped, onlyFollowing, follows, asset, qTerms, lbWindow, tag, sectorsByBasket])

  // compact masthead stats — static values (the count-up read as gimmicky; owner call 2026-07-06)
  const creatorCount = buildCreatorLeaderboard(chainScoped).length
  const basketTotal = chainScoped.filter((b) => !b.supersededBy).length
  const tvlTotal = chainScoped.filter((b) => !b.supersededBy).reduce((s, b) => s + (b.aumUsd || 0), 0)

  if (isLoading) return <Skeleton />
  if (isError) return <div className="py-6"><Empty>Couldn't load Explore, the public RPC may be rate-limiting. An origin-restricted key or read proxy makes it reliable.</Empty></div>

  const showAssetRow = assets.length > 0

  return (
    <div className="space-y-5 py-3">
      {/* ── compact masthead (canonical treatment, sm tier — stays compact per
             the 1239 owner note; the gradient one-off is gone for consistency).
             Page rhythm tightened 2026-07-07 17:57 (owner: Explore reads thinner). ── */}
      <div className="enter" style={{ '--enter-i': 0 } as CSSProperties}>
      <PageHeader
        size="md"
        title="Explore"
        actions={
          <div className="flex items-end">
            <HeadlineStat value={String(creatorCount)} label="creators" />
            <HeadlineStat value={String(basketTotal)} label="baskets" divider />
            <HeadlineStat value={formatUsdCompact(tvlTotal)} label="TVL" divider accent />
          </div>
        }
      />
      </div>

      {/* ── the top-three slideshow (hidden on the leaderboard + while filtering);
             when NO basket clears the criteria the blueprint ghost holds the
             slot instead (owner 2026-07-07 14:1x) ── */}
      {!ql && !asset && !tag && (
        <div className="enter" style={{ '--enter-i': 1 } as CSSProperties}>
          {spotlightBaskets.length > 0 ? <BasketSpotlight baskets={spotlightBaskets} /> : <BlueprintBasket />}
        </div>
      )}

      {/* ── tabs (big, left) + search (right) — one row, saves vertical space ── */}
      <div className="enter flex flex-wrap items-center justify-between gap-3 border-y border-white/10 py-2.5" style={{ '--enter-i': 2 } as CSSProperties}>
        <div className="flex items-center gap-1">
          <TabBtn active={view === 'thesis'} onClick={() => setView('thesis')}>Top performers</TabBtn>
          <TabBtn active={view === 'baskets'} onClick={() => setView('baskets')}>Baskets</TabBtn>
          <TabBtn active={view === 'creators'} onClick={() => setView('creators')}>Creators</TabBtn>
        </div>
        {view !== 'thesis' && (
        <label className="relative flex min-w-0 flex-1 items-center sm:max-w-xs">
          <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3 h-4 w-4 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search creators or baskets…"
            spellCheck={false}
            className="w-full rounded-xl border border-white/10 bg-white/[0.02] py-2 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
          />
        </label>
        )}
      </div>

      {/* ── secondary filters: chain · following · (leaderboard) timeframe ──── */}
      {(hasBoth || followCount > 0 || onlyFollowing || view === 'creators') && (
        <div className="no-scrollbar flex items-center gap-2 overflow-x-auto">
          {hasBoth && (
            <>
              <Pill active={chain === 'all'} onClick={() => setChain('all')}>All</Pill>
              <Pill active={chain === 8453} onClick={() => setChain(8453)}>Base</Pill>
              <Pill active={chain === 1} onClick={() => setChain(1)}>ETH</Pill>
            </>
          )}
          {view === 'creators' && (followCount > 0 || onlyFollowing) && (
            <Pill active={onlyFollowing} onClick={() => setOnlyFollowing((v) => !v)}>
              Following{followCount > 0 ? ` · ${followCount}` : ''}
            </Pill>
          )}
          {view === 'creators' &&
            (['value', 'day', 'week', 'month'] as LbWindow[]).map((w) => (
              <Pill key={w} active={lbWindow === w} onClick={() => setLbWindow(w)}>
                {w === 'value' ? 'Value' : w === 'day' ? 'Day' : w === 'week' ? 'Week' : 'Month'}
              </Pill>
            ))}
        </div>
      )}

      {/* ── trending tags — creator-invented, ranked by adoption (R+C: "theses
             and trends"); click to filter both tabs ── */}
      {view !== 'thesis' && trendingTags.length > 0 && (
        <div className="enter flex flex-wrap items-center gap-2" style={{ '--enter-i': 3 } as CSSProperties}>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Trending</span>
          {trendingTags.map((t) => {
            const on = tag === t.label.toLowerCase()
            const hit = !on && termsHitLabel(t.label, qTerms)
            return (
              <button
                key={t.label.toLowerCase()}
                type="button"
                onClick={() => setTag(on ? null : t.label.toLowerCase())}
                aria-pressed={on}
                className={`press rounded-full border px-3 py-1 font-mono text-[11px] transition-all ${
                  on
                    ? 'border-cyan/50 bg-cyan/10 text-cyan'
                    : hit
                      ? 'border-cyan/60 bg-cyan/[0.08] text-cyan shadow-[0_0_16px_-4px_rgba(53,224,255,0.8)]'
                      : 'border-white/10 text-ink-dim hover:border-white/30 hover:text-ink'
                }`}
              >
                #{t.label.toLowerCase().replace(/\s+/g, '')}
                <span className={`ml-1.5 ${on || hit ? 'text-cyan/70' : 'text-ink-faint'}`}>{t.n}</span>
              </button>
            )
          })}
          {tag && (
            <button type="button" onClick={() => setTag(null)} className="press font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-cyan">
              Clear ✕
            </button>
          )}
        </div>
      )}

      {/* ── asset filter icon row (Baskets + Creators) ───────────────────────── */}
      {view !== 'thesis' && showAssetRow && (
        <div className="enter" style={{ '--enter-i': 3 } as CSSProperties}>
          <AssetFilterRow assets={assets} selected={asset} onSelect={setAsset} />
        </div>
      )}

      {/* ── you hold these — one tap surfaces the baskets holding them, the
             same as a search would (R+C 18:26; facts about the viewer's own
             wallet, never a recommendation) ── */}
      {heldAssets.length > 0 && (
        <div className="enter flex flex-wrap items-center gap-2 rounded-2xl border border-cyan/20 bg-cyan/[0.03] px-4 py-3" style={{ '--enter-i': 3 } as CSSProperties}>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan">In your wallet</span>
          {heldAssets.map((a) => {
            const on = asset === a.address.toLowerCase()
            return (
              <button
                key={a.address.toLowerCase()}
                type="button"
                onClick={() => setAsset(on ? null : a.address.toLowerCase())}
                aria-pressed={on}
                title={`Show baskets holding ${a.symbol}`}
                className={`press inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 transition-colors ${
                  on ? 'border-cyan/60 bg-cyan/15' : 'border-white/12 bg-white/[0.03] hover:border-cyan/40'
                }`}
              >
                <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={18} />
                <span className={`font-mono text-[10px] uppercase tracking-[0.1em] ${on ? 'text-cyan' : 'text-ink-dim'}`}>{a.symbol}</span>
              </button>
            )
          })}
          <span className="font-mono text-[10px] text-ink-faint">tap one to see the baskets that hold it</span>
        </div>
      )}

      {/* ── content — keyed by tab so each switch replays the row cascade ── */}
      <div key={view}>
      {view === 'thesis' ? (
        <div className="space-y-8">
          {/* the search hero: search + tags LEFT, quick swap RIGHT (owner
              15:1x), the search and the swap card sharing ONE grid row so
              their tops and bottoms align exactly — the card drives the row
              height, the search stretches to it (owner 16:11). Stacks on
              mobile in the same order. */}
          <div
            className={`enter pt-4 ${SWAP_ENABLED ? 'lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-x-9 lg:[grid-template-rows:auto_auto_auto]' : ''}`}
            style={{ '--enter-i': 3 } as CSSProperties}
          >
            {/* "Quick search" heads the column so the two headers sit side by
                side (owner 15:32) */}
            <div className="mb-2 flex items-baseline justify-between px-1 lg:col-start-1 lg:row-start-1">
              <span className="inline-flex items-center gap-1.5 font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-cyan" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
                </svg>
                Quick search
              </span>
            </div>
            {/* the glossy spectral search — stretched to the swap card's height */}
            <div className="lg:col-start-1 lg:row-start-2">
              <SpectralSearch
                value={q}
                onChange={setQ}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder={typedPlaceholder}
                size="lg"
                stretch={SWAP_ENABLED}
              />
            </div>
            {trendingTags.length > 0 && (
              <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2 lg:col-start-1 lg:row-start-3 lg:justify-start">
                {trendingTags.map((t) => {
                  const on = tag === t.label.toLowerCase()
                  // the query names this tag → flag it (owner: "im interested
                  // in agents" lights up #agents)
                  const hit = !on && termsHitLabel(t.label, qTerms)
                  return (
                    <button
                      key={t.label.toLowerCase()}
                      type="button"
                      onClick={() => setTag(on ? null : t.label.toLowerCase())}
                      aria-pressed={on}
                      className={`press rounded-full border px-3.5 py-1.5 font-mono text-[11px] transition-all ${
                        on
                          ? 'border-cyan/50 bg-cyan/10 text-cyan'
                          : hit
                            ? 'border-cyan/60 bg-cyan/[0.08] text-cyan shadow-[0_0_16px_-4px_rgba(53,224,255,0.8)]'
                            : 'border-white/10 text-ink-dim hover:border-white/30 hover:text-ink'
                      }`}
                    >
                      #{t.label.toLowerCase().replace(/\s+/g, '')}
                    </button>
                  )
                })}
              </div>
            )}

            {/* the quick swap, IN LINE with the search (owner 15:1x): its
                "Quick swap" header + the strip; the full console stays on
                /swap and the basket pages */}
            {SWAP_ENABLED && (
              <>
                <div className="mb-2 mt-7 flex items-baseline justify-between px-1 lg:col-start-2 lg:row-start-1 lg:mt-0">
                  <span className="inline-flex items-center gap-1.5 font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-cyan" fill="currentColor" aria-hidden>
                      <path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />
                    </svg>
                    Quick swap
                  </span>
                  <Link
                    to="/swap"
                    className="press font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint transition-colors hover:text-cyan"
                  >
                    Full console →
                  </Link>
                </div>
                <div className="lg:col-start-2 lg:row-start-2">
                  <DexSwapCard chainId={chain === 'all' ? DEFAULT_CHAIN_ID : chain} strip />
                </div>
              </>
            )}
          </div>

          {baskets.length === 0 ? (
            <Empty>{tag || ql ? 'Nothing matches, try another tag or search.' : 'No baskets launched yet on this network.'}</Empty>
          ) : (
            /* ALL baskets in the card format (R+C 18:26: the Baskets tab IS
               the list; this lens stays cards end to end) */
            <div className="space-y-3">
              <div className="flex justify-start">
                <FaceToggle face={cardFace} onChange={setCardFace} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {baskets.map((b, i) => (
                  <div key={`${b.chainId}:${b.address}`} className="enter" style={{ '--enter-i': 4 + Math.min(i, 8) } as CSSProperties}>
                    <ThesisCard
                      ix={b}
                      face={cardFace}
                      chain={versionChain(b.address, all.filter((x) => x.deployer && b.deployer && x.deployer.toLowerCase() === b.deployer!.toLowerCase()))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <Disclaimer />
        </div>
      ) : view === 'baskets' ? (
        weightedBaskets.length === 0 ? (
          <Empty>{asset ? 'No baskets hold that asset on this network.' : ql ? 'No baskets match your search.' : 'No baskets launched yet on this network.'}</Empty>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              {weightedBaskets.map((b, i) => (
                <div key={`${b.chainId}:${b.address}`} className="enter" style={{ '--enter-i': 3 + Math.min(i, 9) } as CSSProperties}>
                  <BasketListRow
                    ix={b}
                    rank={i + 1}
                    stats
                    chain={versionChain(b.address, all.filter((x) => x.deployer && b.deployer && x.deployer.toLowerCase() === b.deployer!.toLowerCase()))}
                  />
                  {/* the launch funnel, planted mid-flow (owner pick #7) */}
                  {i === 4 && <div className="enter mt-2" style={{ '--enter-i': 8 } as CSSProperties}><LaunchCta /></div>}
                </div>
              ))}
              {weightedBaskets.length <= 4 && <LaunchCta />}
            </div>
            <Disclaimer />
          </div>
        )
      ) : creators.length === 0 ? (
        <Empty>
          {onlyFollowing && followCount === 0
            ? 'Not following any creators yet. Open a creator and tap Follow.'
            : asset
              ? 'No creators have a basket with that asset.'
              : ql
                ? 'No creators match your search.'
                : 'No creators yet. Once a basket is launched, its creator appears here.'}
        </Empty>
      ) : (
        <div className="space-y-4">
          {(lbWindow === 'week' || lbWindow === 'month') && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-dim">
              <span className="text-cyan">{WINDOW_LABEL[lbWindow]}</span> windows need the operator's snapshot history, so they
              light up once a data layer is configured. Ranked by combined value for now; <span className="text-ink">Day</span> is live on-chain.
            </div>
          )}
          <div className="space-y-2">
            {creators.map((c, i) => (
              <div key={c.address} className="enter" style={{ '--enter-i': 3 + Math.min(i, 9) } as CSSProperties}>
                <CreatorLine entry={c} rank={i + 1} w={lbWindow} />
              </div>
            ))}
          </div>
          <Disclaimer />
        </div>
      )}
      </div>
    </div>
  )
}
