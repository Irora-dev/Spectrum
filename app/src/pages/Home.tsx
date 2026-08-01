import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { basketHref } from '../lib/spectrum/short-url'
import { useCountUp } from '../lib/motion'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { buildCreatorLeaderboard, listable, perfMeasurable, rankBaskets, versionChain } from '../lib/spectrum/leaderboard'
import { formatNav, formatUsdCompact } from '../lib/spectrum/format'
import { BasketListRow } from '../components/BasketListRow'
import { BasketAvatar } from '../components/BasketAvatar'
import { BasketSpark } from '../components/BasketSpark'
import { BasketBento } from '../components/BasketBento'
import { BasketWash } from '../components/BasketWash'
import { ChainBadge } from '../components/ChainBadge'
import { DexSwapCard } from '../components/DexSwapCard'
import { SWAP_ENABLED } from '../lib/config/features'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { CreatorChip } from '../components/CreatorChip'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { HeroIntro, heroIntroWillPlay } from '../components/HeroIntro'
import { LeagueBanner } from '../components/LeagueBanner'
import { useActiveChainId } from '../lib/chain/active-chain'
import { ROBINHOOD_CHAIN_ID } from '../lib/chain/constants'
import { stocksEnabled } from '../theme/brand'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'
import homeHeroArt from '../assets/home-hero-v2.jpg'
// 1280w variant: a phone decodes ~10× fewer pixels (systems audit) — srcSet
// lets the browser pick; the 3840w original still serves large screens.
import homeHeroArt1280 from '../assets/home-hero-v2.1280.jpg'

// The hero art's left/right taper — the lanes the animated light bands occupy.
// Deliberately has NO vertical component (see the hero for why).
// The hole tracks the SAME band geometry the shader now uses (owner 2026-07-30
// "fix 2"): bright reach ≈ max(18px, min(13vw, 19.5vw − 66.5px, 50vw − 484px))
// — 19.5vw−66.5px is a linear fit of the old vw/1024 ramp (errs a few px WIDE,
// the safe direction), 50vw−484px is the content-gutter clamp the shader
// applies, 13vw the natural cap. Art is fully back exactly where the bright
// lane ends; 40%-alpha at 0.4× of it. The old fixed 5%/12% stops matched the
// lanes only at ≤400px and ≥1280px (audit).
const LANE = 'max(18px, min(13vw, 19.5vw - 66.5px, 50vw - 484px))'
const SIDE_TAPER =
  `linear-gradient(90deg, transparent 0, rgba(0,0,0,0.4) calc(${LANE} * 0.4), black calc(${LANE}), black calc(100% - ${LANE}), rgba(0,0,0,0.4) calc(100% - (${LANE} * 0.4)), transparent 100%)`
// A SHORT foot fade (owner 2026-07-30) — the last 14% only, so the art dissolves
// into the page instead of ending on a line. Deliberately not the old 72% fade
// that stacked on the picture's own falloff and banded.
const FOOT_FADE = 'linear-gradient(180deg, black 0%, black 86%, transparent 100%)'
const BasketBuilder = lazy(() =>
  import('../components/launch/BasketBuilder').then((m) => ({ default: m.BasketBuilder })),
)
// Learn-more opens the teaching walkthrough IN PLACE (Colby 2026-07-29 —
// replaces the jump to /creators); lazy so the hero pays nothing until asked.
const LearnWalkthrough = lazy(() =>
  import('../components/LearnWalkthrough').then((m) => ({ default: m.LearnWalkthrough })),
)
import { SpectrumWordmark } from '../components/SpectrumWordmark'
import { CreatorLine, Disclaimer, TabBtn, ThesisCard } from './Explore'
import { BlueprintBasket } from '../components/BlueprintBasket'
import { PrismRule } from '../components/PrismRule'
import { BundleGrid, useRankedBundles } from '../components/BundleGrid'
import { BundleBento } from '../components/BundleBento'
import { PoweredByPrism } from '../components/PoweredByPrism'
import { TradePrism } from '../components/TradePrism'
import { publishedBundleHref } from '../lib/spectrum/notes-social'

// The landing page: a cinematic full-bleed hero (the assets-converge-into-one
// animation behind the wordmark) that explains the concept at a glance, then
// EXPLORE'S OWN surfaces (owner 2026-07-06 13:46): the top-three spotlight
// slideshow and the thesis cards — one language, Home is a preview of /explore.

// ── the hero showcase (owner 2026-07-29, replaces the trio): ONE big basket —
// details on the left, the full weighted bento on the right — sliding through
// the top pool. Mounted straddling the hero's lower edge so it pulls the eye
// down ("drags intrigue"). Hover pauses; explicit stop (WCAG 2.2.2).
// ── HOME SWAP (R, 2026-07-29 16:07: "a really nice swap functionality so that
// you can just swap… below the creator league and the stats, above build-yours.
// Make it really pretty. Basically a version of the swap system on the swap
// page.") It IS the swap system: the same DexSwapCard /swap and /token use, so
// quotes, floors, the simulate-then-sign path and every guard are shared — this
// adds a frame, not a second money path. Beside it, the compact identity of
// whatever the console has selected, because you are buying a whole thesis.
function HomeSwap({ baskets }: { baskets: BasketSummary[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const chainId = useActiveChainId()
  if (!SWAP_ENABLED) return null
  const ix = selected ? baskets.find((b) => b.address.toLowerCase() === selected.toLowerCase()) : undefined
  const sig = ix ? basketSignatureColor(ix.address, ix.top[0]) : 'var(--color-violet)'
  const up = (ix?.change24hPct ?? 0) >= 0

  return (
    <section id="swap" className="scroll-mt-20 pt-10">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-4xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl">
          Buy one <span className="spectral-text">right here</span>
        </h2>
        <p className="mt-3 font-mono text-xs uppercase tracking-[0.18em] text-ink-faint">
          One token, the whole basket — no bridge, no account
        </p>
      </div>

      <div className="relative mt-8">
        {/* ambient bloom behind the console, tinted by the selected basket */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-8 -top-10 bottom-0 opacity-25 blur-3xl"
          style={{ background: `radial-gradient(55% 60% at 50% 0%, ${sig}, transparent 72%)` }}
        />
        <div className="relative mx-auto grid max-w-5xl gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:items-start">
          <DexSwapCard chainId={chainId} onBasketChange={setSelected} />

          {/* what you are actually buying — appears once something is selected */}
          {ix ? (
            <aside className="relative overflow-hidden rounded-3xl border border-white/[0.12] bg-white/[0.02] p-5 backdrop-blur-md">
              <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${sig}, transparent)` }} />
              <BasketWash ix={ix} side="right" opacity={0.28} />
              <div className="relative flex items-center gap-3.5">
                <BasketAvatar address={ix.address} symbol={ix.symbol} size={48} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-2xl font-bold leading-none text-ink">${ix.symbol}</span>
                    <ChainBadge chainId={ix.chainId} />
                  </div>
                  <div className="mt-1 truncate font-display text-sm text-ink-dim">{ix.name?.trim() || ''}</div>
                </div>
              </div>

              <div className="relative mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/25 p-2">
                <BasketBento
                  items={ix.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct, chainId: ix.chainId }))}
                  aspect={2.4}
                />
              </div>

              {/* the selection's living trend (owner: a chart on Buy-one-right-here) */}
              <div className="relative mt-4 h-24 w-full">
                <BasketSpark
                  chainId={ix.chainId}
                  assets={ix.top.map((t) => ({ address: t.address, weight: t.weightPct }))}
                  navPerToken={ix.navPerToken}
                  fallback={ix.navSeries}
                  range="7D"
                  address={ix.address}
                  symbol={ix.symbol}
                  legs={ix.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct }))}
                  withRanges
                  bloom="low"
                />
              </div>

              <div className="relative mt-4 flex items-end justify-between gap-4">
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">NAV</div>
                  <div className="font-num text-xl font-light tabular-nums text-ink">${formatNav(ix.navPerToken, 4)}</div>
                </div>
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">24h</div>
                  <div className={`font-num text-lg tabular-nums ${up ? 'text-cyan' : 'text-magenta'}`}>
                    {ix.change24hPct != null ? `${up ? '+' : ''}${ix.change24hPct.toFixed(2)}%` : '—'}
                  </div>
                </div>
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">TVL</div>
                  <div className="font-num text-lg tabular-nums text-ink-dim">{formatUsdCompact(ix.aumUsd)}</div>
                </div>
              </div>

              <Link
                to={basketHref(ix)}
                className="press relative mt-4 block rounded-lg border border-white/15 py-2 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
              >
                See the whole basket →
              </Link>
            </aside>
          ) : (
            <aside className="relative hidden overflow-hidden rounded-3xl border border-dashed border-white/10 p-8 lg:block">
              <p className="font-mono text-[11px] leading-relaxed text-ink-faint">
                Pick a basket in the console and its composition, NAV and 24h move show up here — you
                always see what a token actually holds before you buy it.
              </p>
            </aside>
          )}
        </div>
      </div>
    </section>
  )
}

// ── the hero's bundle companion (owner 2026-07-29): the single deepest published
// bundle, rendered as its own bento so a visitor sees at a glance that a bundle
// is SEVERAL baskets. Silent when nothing is published.
function FeaturedBundle({ chainId }: { chainId: number }) {
  const { ranked } = useRankedBundles(chainId, 1)
  const top = ranked[0]
  if (!top) return null
  const chains = top.chains.length
  return (
    <Link
      to={publishedBundleHref(top.bundle, top.bundle.by)}
      className="group relative mt-4 flex flex-col gap-4 overflow-hidden rounded-3xl border border-white/12 bg-panel/60 p-5 press hover:border-cyan/40 sm:flex-row sm:items-center sm:p-6"
    >
      <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-48 w-48 rounded-full bg-violet/15 blur-3xl" />
      <div className="relative min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-ink-faint">Featured bundle</div>
        <h3 className="mt-1.5 truncate font-display text-2xl font-bold leading-tight text-ink sm:text-3xl">
          {top.bundle.name || 'Untitled bundle'}
        </h3>
        <p className="mt-2 max-w-md text-sm leading-snug text-ink-dim">
          {top.bundle.legs.length} baskets across {chains} chain{chains === 1 ? '' : 's'}, held as one
          allocation. Not one token, and each basket stays in your own wallet.
        </p>
        <div className="mt-3 flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          {/* unresolved legs contribute $0 — mark the sum partial (audit R4) */}
          {top.tvlUsd > 0 && (
            <span className="tabular-nums text-ink-dim">
              {formatUsdCompact(top.tvlUsd)}
              {top.legs.length > top.resolvedCount ? '+' : ''} combined TVL
            </span>
          )}
          <span className="text-cyan transition-transform group-hover:translate-x-0.5">View bundle →</span>
        </div>
      </div>
      <div className="relative w-full sm:w-[46%]">
        <BundleBento legs={top.legs} aspect={2} compact linkLegs={false} />
      </div>
    </Link>
  )
}

function HeroShowcase({ baskets }: { baskets: BasketSummary[] }) {
  const [idx, setIdx] = useState(0)
  const [paused, setPaused] = useState(false)
  const [stopped, setStopped] = useState(false)
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const n = baskets.length
  useEffect(() => {
    if (idx >= n && n > 0) setIdx(0)
  }, [n, idx])
  useEffect(() => {
    if (paused || stopped || reduced || n < 2) return
    const t = window.setInterval(() => setIdx((i) => (i + 1) % n), 6000)
    return () => window.clearInterval(t)
  }, [paused, stopped, reduced, n])
  const ix = baskets[Math.min(idx, n - 1)]
  if (!ix) return null
  const up = (ix.change24hPct ?? 0) >= 0

  return (
    <section
      aria-label="Basket showcase"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      className="relative overflow-hidden rounded-3xl border border-white/12 bg-panel shadow-[0_30px_90px_-30px_rgba(123,92,255,0.45)]"
    >
      <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
      <div key={`${ix.chainId}:${ix.address}`} className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:gap-10">
        {/* ── details, left: identity TOP · chart middle · money + CTA BOTTOM
            (owner 2026-07-29: use the space, bigger, chart in the gap) ── */}
        <div className="enter flex min-w-0 flex-col" style={{ '--enter-i': 0 } as CSSProperties}>
          <div className="flex items-start gap-4">
            <BasketAvatar address={ix.address} symbol={ix.symbol} size={64} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-display text-4xl font-bold leading-none tracking-tight text-ink">${ix.symbol}</span>
                <ChainBadge chainId={ix.chainId} />
              </div>
              <div className="mt-1.5 line-clamp-1 font-display text-lg text-ink-dim">{ix.name?.trim() || ''}</div>
              <div className="mt-1.5 flex items-center gap-1.5 font-mono text-xs text-ink-faint">
                <span>by</span>
                <CreatorChip deployer={ix.deployer} basket={ix.address} chainId={ix.chainId} size={18} className="font-mono text-xs" />
              </div>
            </div>
          </div>

          {/* the gap becomes the trend — AURA bloom: the hero literally glows
              with the top basket's own shape, in its own colour (owner) */}
          <div className="pointer-events-auto mt-5 h-32 flex-1">
            <BasketSpark
              chainId={ix.chainId}
              assets={ix.top.map((t) => ({ address: t.address, weight: t.weightPct }))}
              navPerToken={ix.navPerToken}
              fallback={ix.navSeries}
              range="7D"
              address={ix.address}
              symbol={ix.symbol}
              legs={ix.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct }))}
              withRanges
              bloom="aura"
              animate
            />
          </div>

          <div className="mt-6 flex items-end gap-8">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">NAV</div>
              <div className="font-num text-3xl font-light tabular-nums text-ink">${formatNav(ix.navPerToken, 4)}</div>
            </div>
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">24h</div>
              <div className={`font-num text-xl tabular-nums ${up ? 'text-cyan' : 'text-magenta'}`}>
                {ix.change24hPct != null ? `${up ? '+' : ''}${ix.change24hPct.toFixed(2)}%` : ','}
              </div>
            </div>
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">TVL</div>
              <div className="font-num text-xl tabular-nums text-ink-dim">{formatUsdCompact(ix.aumUsd)}</div>
            </div>
          </div>
          <div className="mt-7 flex items-center gap-3">
            <Link
              to={basketHref(ix)}
              className="press rounded-lg bg-cyan px-6 py-2.5 font-mono text-xs font-bold uppercase tracking-[0.16em] text-black hover:opacity-90"
            >
              View basket →
            </Link>
            {n > 1 && (
              <div className="ml-1 flex items-center gap-1.5">
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
                      className={`block h-2 rounded-full transition-all duration-300 ${i === idx ? 'w-7' : 'w-2 bg-white/20 hover:bg-white/40'}`}
                      style={i === idx ? { background: 'linear-gradient(90deg,var(--color-cyan),var(--color-magenta))' } : undefined}
                    />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setStopped((v) => !v)}
                  aria-label={stopped ? 'Resume the slideshow' : 'Pause the slideshow'}
                  aria-pressed={stopped}
                  className="press ml-1 grid h-6 w-6 place-items-center rounded-md border border-white/10 text-ink-faint hover:border-cyan/50 hover:text-cyan"
                >
                  {stopped ? (
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
        {/* ── the full weighted bento, right ── */}
        <div className="enter" style={{ '--enter-i': 1 } as CSSProperties}>
          <BasketBento
            items={ix.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct, chainId: ix.chainId }))}
            fill
            className="min-h-[260px] sm:min-h-[320px]"
            reveal={{ delayMs: 100, stepMs: 55 }}
          />
        </div>
      </div>
    </section>
  )
}


// The protocol-in-three-numbers strip (owner 2026-07-29: "make it look more
// impressive"): a glass band with count-up numerals, hairline dividers and a
// spectral wash — TVL carries the gradient. Numbers COUNT UP on first render
// (reduced-motion lands instantly via useCountUp).
function StatsStrip({ creators, baskets, tvlUsd }: { creators: number; baskets: number; tvlUsd: number }) {
  const c = useCountUp(creators, true, 900)
  const b = useCountUp(baskets, true, 900)
  const t = useCountUp(tvlUsd, true, 1200)
  const cells = [
    { v: String(Math.round(c)), l: 'creators', grad: false },
    { v: String(Math.round(b)), l: 'baskets live', grad: false },
    { v: formatUsdCompact(t), l: 'total value locked', grad: true },
  ]
  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-panel">
      <div aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(53,224,255,0.5), rgba(123,92,255,0.5), rgba(255,77,184,0.5), transparent)' }} />
      <div aria-hidden className="pointer-events-none absolute -left-20 -top-24 h-64 w-64 rounded-full bg-cyan/10 blur-[100px]" />
      <div aria-hidden className="pointer-events-none absolute -right-20 -bottom-24 h-64 w-64 rounded-full bg-magenta/10 blur-[100px]" />
      <div className="relative grid grid-cols-3 divide-x divide-white/[0.07]">
        {cells.map((s) => (
          <div key={s.l} className="px-4 py-10 text-center sm:py-12">
            <div
              className={`font-num text-4xl font-light leading-none tabular-nums sm:text-6xl ${s.grad ? 'spectral-text font-normal' : 'text-ink'}`}
              style={s.grad ? undefined : { textShadow: '0 0 30px rgba(255,255,255,0.10)' }}
            >
              {s.v}
            </div>
            <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.26em] text-ink-faint">{s.l}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Home() {
  const activeChainId = useActiveChainId()
  const { data, isLoading, isError } = useAllBaskets()
  // Post-intro entrance (owner 16:44): as the intro fades, the SIDE animations
  // come in first, THEN the hero text. When no intro plays (SPA nav, reduced
  // motion, already seen) everything starts visible — no re-animation.
  const [introDone, setIntroDone] = useState(() => !heroIntroWillPlay())
  const [learnOpen, setLearnOpen] = useState(false)
  // Discovery shows only the latest version of each lineage (superseded versions
  // stay reachable via the version strip on the basket page).
  const all = (data ?? []).filter((b) => !b.supersededBy)

  // Exactly Explore's rules: spotlight = the measurable top three by performance
  // to date; the thesis grid follows the same perf order (objective, not curated).
  // Home has no search, so the listing floor (LISTING_TVL_FLOOR_USD) always applies (R+C)
  const ranked = rankBaskets(data ?? [], { sort: 'perf' }).filter(listable)
  const spotlight = ranked.filter(perfMeasurable).slice(0, 9) // trio window pool
  const theses = ranked.slice(0, 6)
  // the Home preview tabs (owner 17:08) — the same three lenses as Explore
  const [view, setView] = useState<'thesis' | 'baskets' | 'creators' | 'bundles'>('thesis')
  const weighted = rankBaskets(data ?? [], { sort: 'weighted' }).filter(listable).slice(0, 8)
  // headline facts for the hero strip (owner 18:26: 'surface some stats')
  const creatorCount = buildCreatorLeaderboard(all).length
  const tvlTotal = all.reduce((s, b) => s + (b.aumUsd || 0), 0)
  const creators = buildCreatorLeaderboard(all).slice(0, 6)
  const chainOf = (b: (typeof all)[number]) =>
    versionChain(b.address, (data ?? []).filter((x) => x.deployer && b.deployer && x.deployer.toLowerCase() === b.deployer!.toLowerCase()))

  return (
    <div className="space-y-14">
      {/* the heatmap logo intro (hard loads only) — the hero staggers in on its fade */}
      <HeroIntro onDone={() => setIntroDone(true)} />

      {learnOpen && (
        <Suspense fallback={null}>
          <LearnWalkthrough onClose={() => setLearnOpen(false)} />
        </Suspense>
      )}

      {/* the creator-league advert (owner 2026-07-29) — above the hero carousel;
          z-10 so the hero's orbiting logos pass BEHIND the solid card */}
      {/* ── HERO BANNER TRIAL (owner 2026-07-29, the league treatment): the
          treasure-chest art full-bleed under the nav, edges masked to fully
          transparent so the site's own animated bands ride above it. The art
          is RIGHT-weighted (the chest), so the title block sits over the
          BLACK left half — the league layout mirrored to fit this art. The
          orbit/aurora ambient hero is retired in this trial. ── */}
      {/* NO mask, NO overlay, NO vignette of ours (owner 2026-07-30). The art
          file carries its own falloff — its left half is painted black for this
          text, and its bottom row is blacker than the page — so the honest job
          here is geometric: show the WHOLE frame and add nothing.
          The hero is a LETTERBOX again (owner preferred the shorter height), so
          object-cover must crop this 16:9 art vertically — and where it crops
          decides whether an edge shows. Anchored at 80% down: the art's own near
          black foot lands at the bottom, where a step would sit naked mid-page
          (measured 0.1/255 there, versus 20/255 cropping from the centre). The
          cost lands at the TOP instead, which butts against the nav's own border
          — a deliberate boundary rather than a stray line. */}
      <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
        <img
          src={homeHeroArt}
          srcSet={`${homeHeroArt1280} 1280w, ${homeHeroArt} 3840w`}
          sizes="100vw"
          fetchPriority="high"
          alt=""
          aria-hidden
          className={`league-hero-in absolute inset-0 h-full w-full object-cover object-[right_80%] transition-opacity duration-700 ${introDone ? 'opacity-100' : 'opacity-0'}`}
          style={{
            // SIDE taper only (owner 2026-07-30: the art was sitting on top of
            // the light bands). This is not a vignette over the picture — it is
            // the hole the site's animated side bands shine through. No vertical
            // fade: the art's own falloff is left completely alone.
            WebkitMaskImage: `${SIDE_TAPER}, ${FOOT_FADE}`,
            WebkitMaskComposite: 'source-in',
            maskImage: `${SIDE_TAPER}, ${FOOT_FADE}`,
            maskComposite: 'intersect',
          }}
        />

        <div
          className={`relative z-10 mx-auto flex min-h-[60svh] w-full max-w-6xl items-center px-4 transition-all delay-300 duration-700 sm:px-6 ${
            introDone ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
          }`}
        >
          <div className="relative -mt-10 max-w-2xl pb-8 pt-4">
            {/* (no readability vignette — the art's own black left half is the
                backdrop this copy was composed for) */}
            {/* The blurred duplicate that used to sit behind this (a glow copy,
                `absolute inset-0 blur-[20px]`) is GONE: a filtered copy of a
                background-clip:text element gets rasterised and clipped at its
                own box, and that clip landed exactly at the wordmark's right
                edge — the dark vertical line the owner kept seeing over the art
                (2026-07-30). The art's own black left half is all the contrast
                this needs. */}
            {/* text-6xl base (was 7xl): the wordmark is the operator's brand
                name, a single unbreakable word — at 72px any ≥9-char name
                overflowed a 375px phone's column (mobile audit M) */}
            <SpectrumWordmark className="text-6xl leading-[0.9] tracking-tight sm:text-8xl lg:text-9xl" />
            <p className="mt-6 text-base leading-snug text-ink-dim sm:text-lg lg:text-xl">
              <span className="block sm:whitespace-nowrap">Introducing A New Asset Class: Basket Tokens</span>
              <span className="mt-1 block sm:whitespace-nowrap">One Token Backed By The Price Of All Assets</span>
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {/* opens the walkthrough in place (Colby 2026-07-29) — the deep
                  /creators pitch is the walkthrough's own final-slide link */}
              <button
                type="button"
                onClick={() => setLearnOpen(true)}
                className="press rounded-lg bg-cyan px-7 py-3 font-mono text-xs font-bold uppercase tracking-[0.18em] text-void transition-transform hover:scale-[1.03] active:scale-[0.96]"
              >
                Learn more
              </button>
              <Link
                to="/launch"
                className="press rounded-lg border border-white/25 bg-white/[0.03] px-7 py-3 font-mono text-xs font-bold uppercase tracking-[0.18em] text-ink backdrop-blur transition-colors hover:border-cyan hover:text-cyan"
              >
                Launch your own basket
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── launched baskets: loading / error / content ─────────────────── */}
      {isLoading && (
        <section className="space-y-8" aria-busy="true" aria-label="Loading baskets">
          <div className="h-64 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-44 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        </section>
      )}

      {isError && !isLoading && (
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
          <p className="font-mono text-sm text-ink-dim">Couldn&rsquo;t load baskets right now.</p>
          <p className="mt-1 font-mono text-[11px] text-ink-faint">Check your connection and try again.</p>
        </section>
      )}

      {/* ── Explore's own surfaces, as the homepage preview (owner 13:46; the
             spotlight peeks into the hero chrome-less + control-less, title
             inside the viewport — 16:55). When NO basket clears the criteria —
             an empty network, or nothing over the listing/measurability floors
             — the BLUEPRINT ghost holds the spotlight slot so the page never
             looks abandoned (owner 2026-07-07 14:1x). Still no curation: the
             ghost is unmistakably a drawing, not a listing. ── */}
      {!isLoading && !isError && (
        // z-10: the hero's orbiting logos must pass BEHIND everything below (owner)
        <section id="showcase" className="relative z-10 scroll-mt-20 space-y-28">
          {/* the hero-straddle group: the RH strip (when shown) and the
              showcase pull up TOGETHER — the two separate negative margins
              were stacking and swallowing the hero's buttons (owner) */}
          {/* The spotlight and the RH strip ride UP over the hero's foot —
              owner 2026-07-30: "there shouldn't be so much padding between the
              hero content and the next elements".
              The pull is calc(30svh − 142px), not a fixed value, because the
              hero is 60svh with its copy CENTRED: the space below the buttons
              therefore grows with viewport height, and a fixed pull swung from
              −12px (the next section eating the buttons on an 800px-tall
              screen — the very failure the old comment warned about) to +88px
              at 1080px. With the calc it is ~30px at every height. */}
          {/* the sub-sm pull relaxes on very short viewports (scoped max-sm so
              it can never fight the sm: calc) — at svh ≲ 520 the opaque
              showcase card overlapped the second hero CTA's tail (audit L) */}
          <div className="relative z-10 -mt-24 max-sm:[@media(max-height:540px)]:-mt-4 space-y-5 sm:-mt-[calc(30svh-142px)]">
            {/* the strip + spotlight break OUT of the main column onto the
                hero's own max-w-6xl line, so their edges align vertically with
                the hero buttons (owner 2026-07-30: "use more width… match the
                side of the learn more button"). Same container formula as the
                hero copy, so the edges agree at every viewport; overflow-x-clip
                (not hidden) keeps the cards' drop shadows. */}
            <div className="relative left-1/2 w-screen -translate-x-1/2 overflow-x-clip">
              <div className="mx-auto w-full max-w-6xl space-y-5 px-4 sm:px-6">
                {activeChainId === ROBINHOOD_CHAIN_ID && stocksEnabled(brand) && (
                  <Link
                    to="/launch"
                    className="group flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-2xl border border-white/12 bg-panel px-5 py-3 press hover:border-cyan/40"
                  >
                    <span className="font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">
                      Stocks <span className="spectral-text">and</span> tokens, one basket
                    </span>
                    {/* was font-mono 10px ink-faint — unreadable at a glance (owner
                        2026-07-29: "much more visible, the nvda etc onwards"). The
                        tickers are the hook, so they get real size, real contrast,
                        and the tickers themselves carry the accent. */}
                    <span className="text-sm text-ink-dim sm:text-base">
                      <span className="font-num font-semibold tabular-nums text-ink">NVDA · SPY · ETH</span>{' '}
                      in a single token, on Robinhood Chain
                      <span className="ml-2 font-semibold text-cyan transition-transform group-hover:translate-x-0.5">
                        build yours →
                      </span>
                    </span>
                  </Link>
                )}
                {spotlight.length > 0 ? <HeroShowcase baskets={spotlight} /> : <BlueprintBasket compact />}
              </div>
            </div>
            {/* the spotlight's companion: the deepest published BUNDLE, shown as
                its bento (owner 2026-07-29). Renders only when one exists, so a
                fresh deployment never shows an empty rail. */}
            {pageEnabled(brand.pages, 'bundle') && <FeaturedBundle chainId={activeChainId} />}
          </div>

          {/* the league advert — between the spotlight and the stats (owner);
              negative margins pull the section's space-y-28 gaps in around it */}
          <div className="-mt-8 -mb-4">
            <LeagueBanner />
          </div>

          {/* the headline stats (facts, not claims) — redressed as the counting
              glass strip */}
          {all.length > 0 && <StatsStrip creators={creatorCount} baskets={all.length} tvlUsd={tvlTotal} />}

          {/* the swap console — R's placement: below the league stats, above
              build-yours */}
          <PrismRule />
          <HomeSwap baskets={all} />

          {/* ── BUILD ONE RIGHT HERE (owner 2026-07-29, replaces the three-card
              explainer): the REAL launch builder embedded on the homepage — the
              same stepper + live bento preview + deploy flow /creators embeds,
              so a visitor composes and launches a basket without leaving Home.
              Multi-step by construction (the builder's own steps carry the
              complexity); one money path, zero duplicated deploy code. */}
          <PrismRule />
          <div id="build" className="scroll-mt-20 pt-10">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="font-display text-4xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl">
                Build your <span className="spectral-text">own</span>
              </h2>
              <p className="mt-3 font-mono text-xs uppercase tracking-[0.18em] text-ink-faint">
                Pick assets, set weights, name it, deploy. Live in about a minute.
              </p>
            </div>
            <div className="mt-10">
              <Suspense
                fallback={
                  <div className="grid min-h-[40vh] place-items-center rounded-2xl border border-white/10 bg-white/[0.02]" role="status" aria-label="Loading the builder">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-cyan" />
                  </div>
                }
              >
                <BasketBuilder wizard />
              </Suspense>
            </div>
          </div>

          {theses.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-end justify-between border-b border-white/10 pb-3.5">
                <div>
                  <h2 className="font-display text-xl font-bold uppercase tracking-tight text-ink sm:text-2xl">
                    {view === 'thesis' ? 'Top performers' : view === 'baskets' ? 'The baskets' : 'The creators'}
                  </h2>
                  <p className="mt-1.5 font-mono text-xs uppercase tracking-[0.18em] text-ink-dim">
                    {view === 'thesis'
                      ? 'Every basket, in its creator\u2019s words'
                      : view === 'baskets'
                        ? 'The performance list'
                        : 'The people behind the baskets'}
                  </p>
                </div>
                <Link
                  to="/explore"
                  className="press shrink-0 rounded-full border border-white/15 bg-white/[0.03] px-4 py-2 font-mono text-xs uppercase tracking-[0.16em] text-cyan transition-colors hover:border-cyan/50 hover:text-ink"
                >
                  Explore all {all.length} →
                </Link>
              </div>

              {/* the same three lenses as Explore (owner 17:08) */}
              <div className="flex items-center gap-1">
                <TabBtn active={view === 'thesis'} onClick={() => setView('thesis')}>Top performers</TabBtn>
                <TabBtn active={view === 'baskets'} onClick={() => setView('baskets')}>Baskets</TabBtn>
                <TabBtn active={view === 'creators'} onClick={() => setView('creators')}>Creators</TabBtn>
                {pageEnabled(brand.pages, 'bundle') && (
                  <TabBtn active={view === 'bundles'} onClick={() => setView('bundles')}>Bundles</TabBtn>
                )}
              </div>

              <div key={view}>
                {view === 'thesis' ? (
                  <div className="grid gap-4 lg:grid-cols-2">
                    {theses.map((b) => (
                      <ThesisCard key={`${b.chainId}:${b.address}`} ix={b} chain={chainOf(b)} />
                    ))}
                  </div>
                ) : view === 'baskets' ? (
                  <div className="space-y-2">
                    {weighted.map((b, i) => (
                      <BasketListRow key={`${b.chainId}:${b.address}`} ix={b} rank={i + 1} stats chain={chainOf(b)} />
                    ))}
                  </div>
                ) : view === 'bundles' ? (
                  /* bundles as BENTOS in a grid (owner 2026-07-29), same visual
                     language as a bundle's own page */
                  <BundleGrid chainId={activeChainId} limit={6} />
                ) : (
                  <div className="space-y-2">
                    {creators.map((c, i) => (
                      <CreatorLine key={c.address} entry={c} rank={i + 1} />
                    ))}
                  </div>
                )}
              </div>

              {/* the disclaimer rides WITH the perf claims above, exactly as on
                  Explore's tabs (house rule — audit) */}
              <Disclaimer />

              <div className="flex justify-center pt-2">
                <Link
                  to="/explore"
                  className="press rounded-xl border border-white/15 px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
                >
                  Explore more →
                </Link>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ecosystem credit — links out to PrismBeat (owner 2026-07-30) */}
      <div className="flex justify-center">
        <PoweredByPrism />
      </div>

      {/* Buy PRISM itself, under the credit (owner 2026-07-30) */}
      <div className="mx-auto mt-6 w-full max-w-[560px]">
        <TradePrism buyOnly />
      </div>
    </div>
  )
}
