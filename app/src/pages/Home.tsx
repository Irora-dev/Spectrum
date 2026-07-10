import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { buildCreatorLeaderboard, listable, perfMeasurable, rankBaskets, versionChain } from '../lib/spectrum/leaderboard'
import { formatUsdCompact } from '../lib/spectrum/format'
import { BasketListRow } from '../components/BasketListRow'
import { ConceptOrbit } from '../components/ConceptReveal'
import { HeroIntro, heroIntroWillPlay } from '../components/HeroIntro'
import { SpectrumWordmark } from '../components/SpectrumWordmark'
import { BasketSpotlight, CreatorLine, TabBtn, ThesisCard } from './Explore'
import { BlueprintBasket } from '../components/BlueprintBasket'

// One of the three what-is-this cards between the showcase and the theses
// (17:08 → 17:34: bento-inspired hues + sheens, everything CENTERED, eyebrows
// gone, a spectral outline so the columns pop). Factual copy only.
function ExplainerCard({ title, body, visual }: { title: string; body: string; visual: ReactNode }) {
  return (
    <div
      className="rounded-2xl p-px transition-shadow duration-300 hover:shadow-[0_0_36px_-10px_rgba(164,139,255,0.6)]"
      style={{ background: 'linear-gradient(135deg, rgba(53,224,255,0.35), rgba(164,139,255,0.3) 50%, rgba(255,77,184,0.35))' }}
    >
      <div className="flex h-full flex-col items-center rounded-[15px] bg-panel/95 p-7 text-center backdrop-blur-sm">
        <div className="flex h-24 items-center justify-center">{visual}</div>
        <h3 className="mt-6 font-display text-xl font-bold uppercase tracking-tight text-ink">{title}</h3>
        <p className="mt-2.5 text-sm leading-relaxed text-ink-dim">{body}</p>
      </div>
    </div>
  )
}

// One bento-styled tile: the gradient fill + the slow hue sheen the real
// bento tiles wear (owner 17:34: "bento colored with the hue").
function BentoBit({ color, className = '', dur = 10 }: { color: string; className?: string; dur?: number }) {
  return (
    <span
      className={`relative overflow-hidden rounded-md ${className}`}
      style={{ background: `linear-gradient(135deg, ${color}77, ${color}22)`, border: `1px solid ${color}55` }}
    >
      <span
        aria-hidden
        className="bento-sheen absolute inset-0"
        style={{
          backgroundImage: 'linear-gradient(115deg, transparent 42%, rgba(255,255,255,0.16) 50%, transparent 58%)',
          animationDuration: `${dur}s`,
        }}
      />
    </span>
  )
}

// The three visuals — pure CSS/SVG, each in the site's own idiom.
function VisualBasket() {
  // 4 on the top row, 3 on the bottom — even (owner 18:04)
  const tiles = [
    { c: 'var(--color-cyan)', w: 'w-12', d: 9 },
    { c: 'var(--color-violet-bright)', w: 'w-9', d: 12 },
    { c: 'var(--color-magenta)', w: 'w-7', d: 10 },
    { c: 'var(--color-teal)', w: 'w-10', d: 13 },
    { c: 'var(--color-amber)', w: 'w-9', d: 11 },
    { c: 'var(--color-violet)', w: 'w-16', d: 14 },
    { c: '#75daff', w: 'w-12', d: 10 },
  ]
  return (
    <div className="flex w-full max-w-[230px] flex-wrap content-start justify-center gap-1.5 rounded-xl border border-white/10 bg-black/25 p-2.5">
      {tiles.map((t, i) => (
        <BentoBit key={i} color={t.c} className={`${t.w} h-6`} dur={t.d} />
      ))}
    </div>
  )
}
function VisualPrism() {
  return (
    <div className="flex w-full max-w-[230px] items-center justify-center rounded-xl border border-white/10 bg-black/25 px-2.5 py-3">
    <svg viewBox="0 0 120 64" className="h-14 w-auto" fill="none" aria-hidden>
      <path d="M4 32h34" stroke="var(--color-ink)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M42 12L74 32 42 52z" stroke="url(#xg)" strokeWidth="2.5" strokeLinejoin="round" fill="rgba(164,139,255,0.10)" />
      <path d="M74 32l38-14" stroke="var(--color-cyan)" strokeWidth="2" strokeLinecap="round" />
      <path d="M74 32h38" stroke="var(--color-violet-bright)" strokeWidth="2" strokeLinecap="round" />
      <path d="M74 32l38 14" stroke="var(--color-magenta)" strokeWidth="2" strokeLinecap="round" />
      <defs>
        <linearGradient id="xg" x1="42" y1="12" x2="74" y2="52" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-cyan)" /><stop offset="0.5" stopColor="var(--color-violet-bright)" /><stop offset="1" stopColor="var(--color-magenta)" />
        </linearGradient>
      </defs>
    </svg>
    </div>
  )
}
function VisualFee() {
  return (
    <div className="mx-auto w-full">
      <div className="flex h-8 w-full gap-1">
        <BentoBit color="var(--color-teal)" className="h-full w-[58%] !rounded-lg" dur={11} />
        <BentoBit color="var(--color-violet-bright)" className="h-full w-[30%] !rounded-lg" dur={13} />
        <BentoBit color="var(--color-magenta)" className="h-full w-[12%] !rounded-lg" dur={9} />
      </div>
      <div className="mt-3 flex justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
        <span>holders</span><span>creator</span><span>burn</span>
      </div>
    </div>
  )
}

// The landing page: a cinematic full-bleed hero (the assets-converge-into-one
// animation behind the wordmark) that explains the concept at a glance, then
// EXPLORE'S OWN surfaces (owner 2026-07-06 13:46): the top-three spotlight
// slideshow and the thesis cards — one language, Home is a preview of /explore.
export function Home() {
  const { data, isLoading, isError } = useAllBaskets()
  // Post-intro entrance (owner 16:44): as the intro fades, the SIDE animations
  // come in first, THEN the hero text. When no intro plays (SPA nav, reduced
  // motion, already seen) everything starts visible — no re-animation.
  const [introDone, setIntroDone] = useState(() => !heroIntroWillPlay())
  // Discovery shows only the latest version of each lineage (superseded versions
  // stay reachable via the version strip on the basket page).
  const all = (data ?? []).filter((b) => !b.supersededBy)

  // Exactly Explore's rules: spotlight = the measurable top three by performance
  // to date; the thesis grid follows the same perf order (objective, not curated).
  // Home has no search, so the $100 listing floor always applies (R+C)
  const ranked = rankBaskets(data ?? [], { sort: 'perf' }).filter(listable)
  const spotlight = ranked.filter(perfMeasurable).slice(0, 3)
  const theses = ranked.slice(0, 6)
  // the Home preview tabs (owner 17:08) — the same three lenses as Explore
  const [view, setView] = useState<'thesis' | 'baskets' | 'creators'>('thesis')
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

      {/* ── cinematic hero: converging assets behind the wordmark ─────────── */}
      <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-x-clip">
        {/* the SIDE animations (aurora + orbit) — first in after the intro */}
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 transition-opacity duration-700 ${introDone ? 'opacity-100' : 'opacity-0'}`}
        >
          {/* aurora */}
          <div className="absolute inset-0">
            <div className="absolute left-1/2 top-1/2 h-[540px] w-[540px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet/15 blur-[130px]" />
            <div className="absolute left-[18%] top-[28%] h-72 w-72 rounded-full bg-cyan/12 blur-[120px]" />
            <div className="absolute right-[16%] top-[42%] h-72 w-72 rounded-full bg-magenta/12 blur-[130px]" />
          </div>

          {/* the concept animation, blown up as an ambient backdrop (no centre
              token, the wordmark sits at the convergence point) */}
          <div className="absolute inset-0 grid place-items-center">
            <ConceptOrbit
              showCore={false}
              logoSize={46}
              className="opacity-50 [--orbit-r:200px] sm:[--orbit-r:300px] lg:[--orbit-r:360px]"
            />
          </div>
        </div>

        {/* legibility scrim — large + soft, fully transparent before any edge so
            it never shows a hard boundary; the glow simply melts into the page
            (no solid band, so nothing cuts off on load or scroll) */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(125% 85% at 50% 44%, rgba(5,5,11,0.66) 0%, rgba(5,5,11,0.22) 46%, transparent 78%)',
          }}
        />

        {/* foreground — HERO text second in after the intro (owner 16:44).
            The hero is deliberately SHORTER than the viewport now: the two
            buttons + "Launched baskets" scroll cue are gone, one centered
            "Launch your own basket" sits above the showcase bento, and the
            bento itself peeks half into the fold to pull the scroll. */}
        <div
          className={`relative z-10 mx-auto flex min-h-[38svh] max-w-5xl flex-col justify-center px-4 pt-16 transition-all delay-300 duration-700 ${
            introDone ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
          }`}
        >
          {/* the FULLY centered stack (owner 17:34): title · the two-line
              description at his dictated break · an OUTLINE launch button */}
          <div className="flex flex-col items-center text-center">
            <SpectrumWordmark className="text-6xl leading-[0.9] tracking-tight sm:text-7xl md:text-8xl lg:text-9xl" />
            <p className="mt-7 max-w-3xl text-lg leading-snug text-ink-dim sm:text-xl">
              <span className="block">A new asset class: basket tokens, whole baskets of assets</span>
              <span className="block">backed onchain, trading as one token.</span>
            </p>
            {/* two buttons (owner 18:04): the LIT one scrolls you to the
                showcase (basket + the three columns in view); launch is the
                outline on its right */}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => document.getElementById('showcase')?.scrollIntoView({ behavior: 'smooth' })}
                className="press rounded-lg bg-cyan px-7 py-3 font-mono text-xs font-bold uppercase tracking-[0.18em] text-void transition-transform hover:scale-[1.03] active:scale-[0.96]"
              >
                Discover more
              </button>
              <Link
                to="/launch"
                className="press rounded-lg border border-white/25 bg-white/[0.03] px-7 py-3 font-mono text-xs font-bold uppercase tracking-[0.18em] text-ink backdrop-blur transition-colors hover:border-cyan hover:text-cyan"
              >
                Launch your own basket
              </Link>
            </div>

            {/* the headline stats (facts, not claims): creators · baskets · TVL */}
            {all.length > 0 && (
              <div className="mt-10 flex items-end justify-center">
                {[
                  { v: String(creatorCount), l: 'creators' },
                  { v: String(all.length), l: 'baskets' },
                  { v: formatUsdCompact(tvlTotal), l: 'TVL', accent: true },
                ].map((s, i) => (
                  <div key={s.l} className={`text-center ${i > 0 ? 'ml-6 border-l border-white/10 pl-6 sm:ml-9 sm:pl-9' : ''}`}>
                    <div className={`font-num text-2xl leading-none tabular-nums sm:text-3xl ${s.accent ? 'text-cyan' : 'text-ink'}`}>{s.v}</div>
                    <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">{s.l}</div>
                  </div>
                ))}
              </div>
            )}
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
        <section id="showcase" className="scroll-mt-20 space-y-28">
          {spotlight.length > 0 ? <BasketSpotlight baskets={spotlight} compact /> : <BlueprintBasket compact />}

          {/* ── the three-card explainer: what this is, in one glance (17:08) ── */}
          <div className="grid gap-4 sm:grid-cols-3">
            <ExplainerCard
              title="One token, whole basket"
              body="A single onchain token that holds a whole basket of assets, redeemable for what's inside."
              visual={<VisualBasket />}
            />
            <ExplainerCard
              title="Built on Uniswap v4"
              body="Each basket is its own v4 hook: the token is its own liquidity, backed onchain."
              visual={<VisualPrism />}
            />
            <ExplainerCard
              title="One fee, set at launch"
              body="A single trade fee, fixed forever at launch, split between creator and holders."
              visual={<VisualFee />}
            />
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
                ) : (
                  <div className="space-y-2">
                    {creators.map((c, i) => (
                      <CreatorLine key={c.address} entry={c} rank={i + 1} />
                    ))}
                  </div>
                )}
              </div>

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
    </div>
  )
}
