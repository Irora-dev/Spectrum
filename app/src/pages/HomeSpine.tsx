import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { WALLET_ENABLED } from '../lib/config/features'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'

// /create is the REAL creation surface riding the launch page key (owner
// 2026-08-12 cutover) — its doors show exactly when the page does, never on
// CREATE_FLOW (which now gates only the simulated /manager engine).
const CREATE_PAGE_ON = pageEnabled(brand.pages, 'launch')
import { useAllBaskets } from '../lib/spectrum/hooks'
import { buildCreatorLeaderboard, listable, rankBaskets, type ChainFilter } from '../lib/spectrum/leaderboard'
import { formatUsdCompact } from '../lib/spectrum/format'
import { basketHref } from '../lib/spectrum/short-url'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { useCountUp, usePrefersReducedMotion } from '../lib/motion'
import { HeroIntro, heroIntroWillPlay } from '../components/HeroIntro'
import { SpectrumWordmark } from '../components/SpectrumWordmark'
import { ConvictionCard, HERO_BENTO_RESERVE_CLASS } from '../components/home/Showcase'
import homeBgBubbles from '../assets/home-bg-bubbles.svg'
// the LIVE chat replaces the demo portfolio readout in the hero's straddle
// slot (owner 2026-08-20: "the left and right cards from the chat with all
// the chat functionality so you can use it on the homepage") — lazy so the
// mascot sprites stay off the first paint
const ChatEmbed = lazy(() => import('./Chat').then((m) => ({ default: m.Chat })))
import { MadeBasket } from '../components/MadeBasket'
import { IntroArt } from '../components/home/IntroArt'
import homeHeroArt from '../assets/home-hero-v2.jpg'
import homeHeroArt1280 from '../assets/home-hero-v2.1280.jpg'
import { Bezel, EASE, FactRow, IslandCta, Reveal, SectionHead, SPECTRAL, SplitCta } from '../components/home/Spine'
import { ChainBadge } from '../components/ChainBadge'
import { Carousel } from '../components/Carousel'
import {
  BASKET_ORDERS,
  filterByMinTvl,
  hasReturns,
  orderBaskets,
  tvlStepLabel,
  tvlStepsFor,
  type BasketOrder,
} from '../lib/spectrum/basket-sort'
import { groupIntoTheses, thesisIsDiscoverable } from '../lib/spectrum/thesis'
import { ThesisDoorCard } from '../components/ThesisCard'

const HomeOnboarding = lazy(() =>
  import('../components/home/HomeOnboarding').then((m) => ({ default: m.HomeOnboarding })),
)

// ─────────────────────────────────────────────────────────────────────────────
// THE HOMEPAGE (owner 2026-08-02: "build out a completely new homepage that's
// absolutely stunning and better reflects the whole proposition").
//
// THE PROPOSITION, in the order a person meets it — his own narrative lines,
// screened and assigned to the rung each one actually describes:
//   hero      "Buy anything, anywhere, in one flow. Then make it your token."
//   the loop   craft a thesis · hold it · publish it · earn the fee when others buy in
//   discovery "Buy someone's conviction in one click."
//   publish   "Turn your thesis into a token."
//
// Deliberately NOT said (copy screen): no "ETF" (a regulated word we do not
// need), no "get paid for being right" (that is a returns promise — the fee is
// real and concrete, so we say the fee), no "mothership" (jargon that means
// nothing to a newcomer), no "earn your validation" (ambiguous between clout
// and money — "clout and fees" is the honest version and it is his own phrase).
//
// The order is the funnel R and the owner settled in the 2026-08-02 daily: MANAGE
// is the front door and the daily habit, PUBLISHING is the graduation. Every
// earlier homepage led with baskets, which sold the second half first.
// ─────────────────────────────────────────────────────────────────────────────

// The hero art's side taper — the lanes the animated light bands occupy, so the
// picture is a hole they shine through rather than a plate sitting on top of
// them. Tracks the shader's own band geometry; no vertical component (the art
// carries its own falloff), plus a short foot fade so it dissolves into the
// page instead of ending on a line.
const LANE = 'max(18px, min(13vw, 19.5vw - 66.5px, 50vw - 484px))'
const SIDE_TAPER = `linear-gradient(90deg, transparent 0, rgba(0,0,0,0.4) calc(${LANE} * 0.4), black calc(${LANE}), black calc(100% - ${LANE}), rgba(0,0,0,0.4) calc(100% - (${LANE} * 0.4)), transparent 100%)`
const FOOT_FADE = 'linear-gradient(180deg, black 0%, black 86%, transparent 100%)'


// THE HERO ROTATES BETWEEN TWO PROPOSITIONS (owner 2026-08-02 17:57: "after two
// seconds the buy anything anywhere in one flow text disappears and then make it
// a basket token appears in the exact same place with the same styling, and then
// the list on the right hand side disappears and the bento grid of that list
// with a name of the token appears… and it keeps rotating, slowly").
//
// Both headlines live in the DOM at once, grid-stacked, and cross-fade — the
// BannerCarousel idiom already in this kit. That buys three things a swap would
// not: zero layout shift (the taller variant sets the height), no re-measure
// jump, and a stable <h1> for crawlers. The h1 keeps the CANONICAL sentence and
// the second proposition rides as an aria-hidden overlay, because a mutating h1
// is a worse trade than a marketing line screen readers meet again in the loop
// section below, where it is stated as its own rung.
const ROTATE_MS = 3600

/** One state of the rotating hero headline: two lines that roll in together but
 *  not quite at the same moment.
 *
 *  `from` is the resting DIRECTION (-1 above, +1 below). Giving the two variants
 *  opposite signs is what makes both lines travel the same way on any given
 *  transition, which is the difference between a roll and a swap. */
function HeroHeadline({
  active,
  from,
  reduced,
  children,
  ...rest
}: {
  active: boolean
  from: -1 | 1
  reduced: boolean
  children: [ReactNode, ReactNode]
} & { 'aria-hidden'?: boolean }) {
  const lines = children
  return (
    <p
      {...rest}
      className="col-start-1 row-start-1 font-display font-semibold leading-[1.0] tracking-tight text-ink"
      /* bigger per 2106 #13; both variants share it so the turn never jumps */
      /* the phone floor drops 2.3rem → 1.75rem (owner 2026-08-06 23:13: "'hold
         anything anywhere as one portfolio' can be made smaller") — the clamp's
         minimum was doing all the work below ~480px, where a 37px headline over
         a full-bleed photo was the loudest thing on the screen */
      style={{ fontSize: 'clamp(1.75rem, 0.5rem + 5.2vw, 4.6rem)' }}
    >
      {lines.map((line, i) => (
        <span
          key={i}
          className="block will-change-[transform,opacity,filter] motion-reduce:!translate-y-0 motion-reduce:!blur-0"
          style={{
            opacity: active ? 1 : 0,
            transform: reduced ? undefined : `translateY(${active ? 0 : from * 26}px)`,
            filter: reduced ? undefined : `blur(${active ? 0 : 10}px)`,
            transition: reduced
              ? `opacity 400ms ${EASE}`
              : `opacity 620ms ${EASE} ${i * 90}ms, transform 760ms ${EASE} ${i * 90}ms, filter 620ms ${EASE} ${i * 90}ms`,
          }}
        >
          {line}
        </span>
      ))}
    </p>
  )
}

function HeroBlock({ introDone }: { introDone: boolean }) {
  const reduced = usePrefersReducedMotion()
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    // Reduced motion holds the FIRST proposition and never rotates. The
    // rotation also waits for the intro so the first thing anyone reads is the
    // headline, not a state mid-fade.
    if (reduced || !introDone) return
    const t = window.setInterval(() => setPhase((p) => 1 - p), ROTATE_MS)
    return () => window.clearInterval(t)
  }, [reduced, introDone])
  const second = phase === 1

  return (
    // HERO_BENTO_RESERVE_CLASS: the hero's foot reserves the room the straddling
    // bento rides up into (owner 1826 re-instated "halfway over the hero" —
    // the reserve is what makes the half-height pull structurally unable to
    // reach the copy this time; arithmetic + pins in home/Showcase.tsx and
    // hero-bento.test.ts). The art is inset-0, so it extends down over the
    // reserved zone and the card's top half genuinely sits over the picture.
    <section className={`relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden ${HERO_BENTO_RESERVE_CLASS}`}>
      {/* THE ART IS BACK (owner 2026-08-02). Full-bleed, no vignette of ours —
          the file carries its own falloff and its left half is painted black
          for exactly this copy. Masked only at the SIDES, so the site's own
          animated light bands pass through rather than being covered. */}
      <img
        src={homeHeroArt}
        srcSet={`${homeHeroArt1280} 1280w, ${homeHeroArt} 3840w`}
        sizes="100vw"
        fetchPriority="high"
        alt=""
        aria-hidden
        /* DARKER (owner 2106 #13): the art dims via brightness so its own
           falloff geometry is untouched — a scrim div would flatten the mask */
        /* 15% darker again (owner 2026-08-06 live) — 0.62 × 0.85.
           MUCH darker on a PHONE (owner 2026-08-06 23:13, device wall: "on
           mobile it fills the full thing, it needs to be way way darker — like
           20%, and then we have a black background behind it"). The art is
           full-bleed behind the whole hero on a phone, so what reads as
           atmosphere on a laptop reads as noise under the headline there.
           brightness, not a scrim: a scrim div flattens the art's own mask. */
        /* DESKTOP PUSHED BACK TOO (design review 2026-08-06: "the 3D glass
           coins sit at the same brightness level as the text — add a scrim or
           reduce their contrast so the headline reads clearly; right now the
           eye bounces between the title and the coins"). The phone was already
           at 0.2 on his own instruction; desktop follows to 0.38, which keeps
           the coins as the picture's colour moment without competing with the
           wordmark for the same focal point. */
          className={`absolute inset-0 h-full w-full object-cover object-[right_80%] brightness-[0.2] transition-opacity duration-700 sm:brightness-[0.38] ${
          introDone ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          WebkitMaskImage: `${SIDE_TAPER}, ${FOOT_FADE}`,
          WebkitMaskComposite: 'source-in',
          maskImage: `${SIDE_TAPER}, ${FOOT_FADE}`,
          maskComposite: 'intersect',
        }}
      />

      <div
        // TIGHTER (owner 2026-08-02 18:55: "the hero has too much space/padding").
        // The svh floor was doing the padding's job twice: 86svh of minimum height
        // AND py-16 inside it, so on a laptop the block was mostly air. The floor
        // drops to 68/74 and the inner padding to 40, which is one step on the
        // house scale rather than an arbitrary trim.
        className={`relative z-10 mx-auto flex min-h-0 w-full max-w-[1280px] flex-col justify-start px-4 pb-10 pt-14 sm:min-h-[46svh] sm:pb-16 sm:pt-20 transition-all delay-300 duration-700 sm:px-6 md:min-h-[52svh] ${
          introDone ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
        }`}
      >
        {/* THE WORDMARK CROWNS THE HERO — centred, large, and lifted off the art.
            17:39: "the spectrum title should actually be centered at the top, so
            move it up, move it to the center, make it bigger". 17:57: "move that
            up a bit more and add a very subtle drop shadow just to make it pop".
            The shadow is a `filter` on the element ITSELF, never a blurred
            duplicate behind it — a filtered copy of a background-clip:text node
            rasterises and draws a hard edge at its own box, which is the exact
            artefact that once cost three rounds of chasing a phantom line. */}
        {/* text-6xl below sm (mobile sweep 2026-08-06): at 7xl the wordmark
            measured 367px inside a 358px column, so its final M sat 7px off
            the right edge — visibly off-centre against a 17px left gutter,
            and clipped on the narrowest Androids (360w). */}
        <SpectrumWordmark className="mx-auto block text-center text-6xl leading-[0.86] tracking-tight drop-shadow-[0_6px_24px_rgba(0,0,0,0.55)] min-[420px]:text-7xl sm:text-8xl lg:text-[8.5rem]" />

        {/* CENTRED UNDER THE WORDMARK (owner 2026-08-02 ~22:15: "move the title
            description up to just under the spectrum text centered"). The hero was
            a two-column composition with the copy left and a card right; the card
            is now the GIANT BENTO below, straddling the fold, so the copy takes
            the centre line under the wordmark and the hero reads as one axis
            instead of two. */}
        {/* NO WIDTH CAP (owner: "the description is on 5 lines it should be on two
            lines use more width"). My 24ch cap was the whole bug, and it is the
            FOURTH time a ch cap has silently added lines to a hand-broken headline
            on this page. At display scale the explicit breaks are the composition,
            so a cap can only ever fight them. The hero container bounds the width. */}
        {/* mt-6 on a phone (owner 2026-08-06 23:13: "the gap between SPECTRUM
            and the text, the description, needs to be a little bit smaller") —
            the wordmark and the line under it are ONE cluster, and 40px of air
            between them on a 390px screen read as two unrelated blocks. */}
        <div className="mx-auto mt-6 flex flex-col items-center text-center sm:mt-10">
          {/* THE ROTATION IS A ROLL, NOT A CROSS-FADE (owner: "needs a better
              transition animation something that feels more premium").
              A plain opacity swap is the cheapest-looking motion there is, because
              nothing has weight: two ghosts trade places. This carries MASS, which
              is the house reveal idiom (translate + blur + opacity, transform and
              opacity only so it stays on the compositor) applied to a toggle:

              · the two variants rest at OPPOSITE offsets, so whichever way the
                toggle goes both lines travel the SAME direction — that reads as one
                object rolling over, rather than two things swapping.
              · each line of a variant is staggered, so the headline turns over line
                by line instead of as a slab. That stagger is most of the "premium".
              · blur on the way out and in, which is what makes it read as depth
                rather than a dissolve.
              · reduced motion drops the movement and the blur entirely and keeps a
                plain fade — the meaning never depends on the animation. */}
          {/* THE TITLE ROTATES AGAIN (owner 2026-08-05 ~22:0x: "i do want it
              rotating i liked that") — his 2106 line is now the FIRST
              proposition rather than a replacement for the pair, so the hero
              keeps both: what you hold, then what you can make of it. Bigger
              than the retired pair was, per 2106 #13, and both variants share
              the size so nothing jumps at the turn. */}
          <div className="grid">
            {/* his exact line (live 2026-08-13): multichain is the claim */}
            <HeroHeadline active={!second} from={-1} reduced={reduced}>
              <>Hold your assets multichain,</>
              <span className="spectral-text">as one portfolio.</span>
            </HeroHeadline>
            <HeroHeadline active={second} from={1} reduced={reduced} aria-hidden>
              <>Then make it your</>
              <span className="spectral-text">Basket Token.</span>
            </HeroHeadline>
          </div>
          {/* the description line is GONE (owner 1826: "remove your assets on
              every chain, one book, reshape it and publish it as a token —
              that's not needed"): the rotating headline already tells both
              halves, and the CTA below is what the freed breath serves. */}
          {/* THE HERO'S OWN ACT (owner 1826: "the get started button say like
              create your portfolio… which sits above the portfolio card") —
              the primary door, above the straddling bento. One destination for
              every visitor state: /portfolio routes a first-timer through the
              onboarding funnel (OnboardingGate), shows a returning visitor
              their book, and asks a disconnected one to connect — the shipped
              machinery does the honest thing, so this stays a plain link.
              WALLET_ENABLED-gated like every portfolio door. */}
          {WALLET_ENABLED && (
            /* more room above the act (design review 2026-08-06: "the button
               feels slightly orphaned — either give it more breathing room
               above or tighten the subhead, so the grouping feels
               intentional"). The headline cluster and the act are two groups,
               so the gap between them belongs in the between-groups band, not
               the within-group one. */
            <div className="mt-10 sm:mt-14">
              <SplitCta left={{ to: '/portfolio', label: 'Create portfolio' }} right={{ to: '/create', label: 'Create baskets' }} />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/** Live baskets as the CONVICTIONS they are — the promotion read (n=12, zero
 *  exceptions) proved a published thesis is what converts, so the card leads
 *  with the basket's identity and its real composition, never a score. */
function ConvictionGrid({ baskets, resetKey }: { baskets: BasketSummary[]; resetKey: string }) {
  if (baskets.length === 0) return null
  return (
    // The outer margin lives with the SECTION, not here: the row above the grid
    // is a filter on some sites and nothing on others, so the caller owns the gap.
    //
    // A RAIL ON PHONES (owner 2026-08-05, the mobile sweep: "Anything that uses
    // too much width we dont stack cards below we create a carousel"). Each of
    // these cards is a ticker, a 24h chart, a bento of what it holds and three
    // figures, so six of them stacked one per row is most of a phone screen
    // EACH: the section became a corridor you scroll through rather than a shelf
    // you look along, and the fourth card down is doing nothing for anyone.
    // Sideways it is one thumb flick per basket with the next already peeking,
    // and the comparison the section exists to make is back. From `sm` up there
    // is width for real columns, so the grid up there is exactly as it was.
    //
    // resetKey is the network filter above: pressing a network has to show that
    // network's FIRST basket, not leave the reader parked in the middle of the
    // rail where the fourth card used to be.
    <Carousel
      label="Live baskets"
      gridFrom="sm"
      gridClassName="sm:grid-cols-2 lg:grid-cols-3"
      resetKey={resetKey}
    >
      {baskets.map((b, i) => (
        <Link key={`${b.chainId}:${b.address}`} to={basketHref(b)} className="press-lg group block h-full">
          <ConvictionCard b={b} i={i} />
        </Link>
      ))}
    </Carousel>
  )
}

/** One choice in the network filter: a network (or All) and how many of the
 *  cards on screen it accounts for. */
interface ChainOption {
  chain: ChainFilter
  n: number
}

// ─────────────────────────────────────────────────────────────────────────────
// THE NETWORK FILTER (2026-08-05 QOL round #1: "the homepage never says which
// chain a basket lives on until you open it").
//
// Three networks are live and the grid mixed them silently, so the only way to
// learn where a basket lived was to open it. Two fixes, one round: every card
// now wears its ChainBadge beside its ticker (see ConvictionCard), and this row
// lets you keep one network.
//
// It RENDERS ONLY when the cards on screen genuinely span more than one network.
// An operator running a single chain would get a control whose every option
// shows the same six cards, which is furniture, not a feature.
//
// The counts are the real cards behind each choice, so the number beside a
// network is exactly how many you are left with when you press it. Nothing is
// fetched: this filters the baskets the page already read.
//
// Chrome is Explore's own filter-pill row (its tag pills' shape and its cyan
// active state) and the network's identity is the app's real ChainBadge, so a
// network looks the same here, on Explore, and on the basket's own page.
// ─────────────────────────────────────────────────────────────────────────────
function ChainFilterRow({
  options,
  value,
  onChange,
}: {
  options: ChainOption[]
  value: ChainFilter
  onChange: (v: ChainFilter) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Filter by network</span>
      {options.map(({ chain, n }) => {
        const on = value === chain
        return (
          <button
            key={String(chain)}
            type="button"
            onClick={() => onChange(chain)}
            aria-pressed={on}
            /* h-7 rather than vertical padding: a pill holding the ChainBadge
               and a pill holding the word "All" resolve to different heights
               from the same py, and a filter row whose pills are two heights
               reads as a mistake. One height, both cases. */
            className={`press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
              on
                ? 'border-cyan/50 bg-cyan/10 text-cyan'
                : 'border-white/10 text-ink-dim hover:border-white/30 hover:text-ink'
            }`}
          >
            {/* the bare word takes a little more inset than the badge does: the
                badge carries its own border, so it already reads as inset */}
            {chain === 'all' ? (
              <span className="px-1">All</span>
            ) : (
              <ChainBadge chainId={chain} className="shrink-0" />
            )}
            <span className={`tabular-nums ${on ? 'text-cyan/70' : 'text-ink-faint'}`}>{n}</span>
          </button>
        )
      })}
    </div>
  )
}

// THE MADE BASKET moved to components/MadeBasket.tsx (owner 1826: the Baskets
// page's intro mounts the same real object) — imported above, one component on
// both surfaces.

export function HomeSpine() {
  const { data } = useAllBaskets()
  // The hero copy is hidden until the intro finishes — and Home guarantees the
  // reveal ITSELF, just past the intro's own failsafe. One decorative component
  // must never be able to own whether the page has a headline (the blank-hero
  // lesson: this exact gate blanked the hero once already).
  const [introDone, setIntroDone] = useState(() => !heroIntroWillPlay())
  useEffect(() => {
    if (introDone) return
    const t = window.setTimeout(() => setIntroDone(true), 7500)
    return () => window.clearTimeout(t)
  }, [introDone])
  const all = useMemo(() => (data ?? []).filter((b) => !b.supersededBy), [data])
  const ranked = useMemo(() => rankBaskets(data ?? [], { sort: 'perf' }).filter((x) => listable(x)), [data])

  // ── THE SECTION'S OWN ORDER + TVL MINIMUM (the owner 2026-08-13: "the baskets at
  //    bottom of homepage … add baskets order by top returns also? and then
  //    also a filter for total tvl") — Explore's controls in the lighter form a
  //    showcase takes: one Returns⇄Value pill pair and one TVL select, riding
  //    the network-filter row. Same model as Explore's band (basket-sort.ts),
  //    so the two surfaces cannot disagree about what a word or a rung means.
  //    · Returns IS the section's existing ranking (rankBaskets 'perf' — NAV
  //      against the ~$1.00 launch), so the default pick renders the exact six
  //      this shelf always showed; the pair just names it and offers Value.
  //    · The pair hides when under two baskets carry an honest returns figure
  //      (the Newest-pill law), the select when no rung is real for this
  //      catalogue — offered rungs can never empty the shelf (tvlStepsFor).
  const [homeOrder, setHomeOrder] = useState<BasketOrder>('returns')
  const [homeMinTvl, setHomeMinTvl] = useState(0)
  const canReturns = useMemo(() => hasReturns(ranked), [ranked])
  const homeTvlSteps = useMemo(() => tvlStepsFor(ranked), [ranked])
  const activeHomeMinTvl = homeTvlSteps.includes(homeMinTvl) ? homeMinTvl : 0
  const activeHomeOrder: BasketOrder = homeOrder === 'returns' && !canReturns ? 'top' : homeOrder
  const convictions = useMemo(
    () => orderBaskets(filterByMinTvl(ranked, activeHomeMinTvl), activeHomeOrder).slice(0, 6),
    [ranked, activeHomeMinTvl, activeHomeOrder],
  )
  // THE CROSS-CHAIN THESES (the owner 2026-08-09: theses "show up amongst baskets
  // on the homepage") — one idea a creator shipped, which the chain forced into
  // several baskets, recognised again by (deployer, name) over the heads. No
  // launchedAt handed in: the join lane made the launch window advisory.
  // Multi-chain groups only (the grouper's default). Pure, so one memo.
  // Discovery floor (owner 2026-08-16): unseeded / sub-$100 bundles stay off
  // the homepage — thesis.ts owns the rule, Explore applies the same one.
  const crossChainTheses = useMemo(
    () => groupIntoTheses(all).filter(thesisIsDiscoverable).sort((a, b) => b.totalAumUsd - a.totalAumUsd),
    [all],
  )

  // THE NETWORK FILTER's choices, counted off the cards that are actually on
  // screen — so a count can never promise more than pressing it delivers. Fewer
  // than two networks among them and there is nothing to choose: the row is
  // dropped entirely rather than shown with one live option. Networks are
  // ordered by how many cards they hold, then by id, so the order is a fact
  // about the page and stays put between renders.
  const [pickedChain, setPickedChain] = useState<ChainFilter>('all')
  const chainOptions = useMemo<ChainOption[]>(() => {
    const counts = new Map<number, number>()
    for (const b of convictions) counts.set(b.chainId, (counts.get(b.chainId) ?? 0) + 1)
    if (counts.size < 2) return []
    return [
      { chain: 'all', n: convictions.length },
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([chainId, n]) => ({ chain: chainId as ChainFilter, n })),
    ]
  }, [convictions])
  // A pick can outlive its option (the baskets reload and that network drops out
  // of the top six), so the live value is DERIVED rather than trusted — a choice
  // that no longer exists falls back to All instead of emptying the grid.
  const chain: ChainFilter = chainOptions.some((o) => o.chain === pickedChain) ? pickedChain : 'all'
  const shownConvictions = useMemo(
    () => (chain === 'all' ? convictions : convictions.filter((b) => b.chainId === chain)),
    [convictions, chain],
  )

  const creators = buildCreatorLeaderboard(all).length
  const tvl = all.reduce((s, b) => s + (b.aumUsd || 0), 0)
  const chains = new Set(all.map((b) => b.chainId)).size
  const c = useCountUp(creators, creators > 0, 900)
  const t = useCountUp(tvl, tvl > 0, 1200)
  const n = useCountUp(all.length, all.length > 0, 900)

  // the pastel-orbs backdrop (owner: 60% on light) — this ROUTED homepage owns
  // it; the effect previously lived in the unrouted pages/Home.tsx and never ran
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--chat-bg-url', `url(${homeBgBubbles})`)
    const t = requestAnimationFrame(() => root.style.setProperty('--chat-bg-live', 'var(--home-bg-opacity, 0)'))
    return () => {
      cancelAnimationFrame(t)
      root.style.setProperty('--chat-bg-live', '0')
      root.style.removeProperty('--chat-bg-url')
    }
  }, [])

  return (
    <div>
      <HeroIntro onDone={() => setIntroDone(true)} />

      <HeroBlock introDone={introDone} />

      {/* THE CHAT STRADDLES THE HERO (owner 1826's straddle law + owner
          2026-08-20 "move the chat much much closer to the buttons in hero").
          The pull MIRRORS HERO_BENTO_RESERVE_CLASS exactly — same percentage,
          same containing block — so the chat's top lands where the reserve
          begins: right under the hero copy, with the hero's own inner pb-16 as
          the only clearance. The bento's overlap class stayed behind in
          Showcase when the chat took this slot, which left the whole reserve
          as dead air between the CTAs and the chat.
          It lives OUTSIDE the hero <section> deliberately: that section carries
          overflow-hidden to mask the art, so anything inside it would be CLIPPED
          rather than overlapping. Sitting here and pulling itself up is what lets
          it cross the boundary. z-20 so it rides over the art, not under it. */}
      <div className="relative z-20 px-4 sm:px-6 lg:[margin-top:-21.923%]">
        <Suspense fallback={<div className="mx-auto h-[560px] w-full max-w-[1480px] rounded-[24px] border border-white/[0.08] bg-white/[0.02] lg:h-[680px]" aria-hidden />}>
          <ChatEmbed embed />
        </Suspense>
      </div>

      {WALLET_ENABLED && (
        /* pt (owner 2026-08-06 23:5x: "should add a bit of padding above the
           Manage your portfolio" doors). The section had NO top padding — the
           straddling bento above supplies its own overlap, so the doors were
           landing straight under the panel's shadow with nothing between them. */
        <section className="relative pt-10 pb-12 sm:pt-14 sm:pb-16 lg:pb-24">
          <div
            aria-hidden
            /* THE SEAM (owner 2026-08-03: "still a weird bg seam between these
               two sections"). This glow started at top-0 with its radial centred
               ON that edge, so it was at FULL strength exactly where the section
               began and vanished above it — a hard horizontal band, which reads as
               a seam between the two sections rather than as light.
               Pulled above the boundary and centred inside itself, so it rises and
               falls with nothing to butt against. */
            className="pointer-events-none absolute left-1/2 -top-64 -z-10 h-[min(900px,120%)] w-screen -translate-x-1/2"
            style={{
              background:
                'radial-gradient(90% 50% at 50% 45%, color-mix(in oklab, var(--color-cyan) 9%, transparent), transparent 70%)',
            }}
          />
          {/* THE GET-STARTED ACT IS THE ONBOARDING (owner ~16:3x: "this must be
              the onboarding flow we have had built here … not the choose assets
              flow it needs replacing") — connect-first, your real book, the
              0845 doors. The choose station lives on at /create; it is no
              longer the homepage's face. */}
          {/* no section head: the hero above IS the title+description (owner
              2106 #13 — 'then the create-portfolio/create-basket doors') */}
          <div>
            <Suspense fallback={<div className="min-h-[220px] sm:min-h-[40vh]" />}>
              <HomeOnboarding />
            </Suspense>
          </div>
        </section>
      )}

      {/* (the giant bento's mount moved UP to straddle the hero — owner 1826;
          see the block above the onboarding section) */}

      {/* THE OLD SHOWCASE PANEL IS GONE (owner: "can be removed entirely").
          The hero bento now does its whole job and does it better, so the panel had
          become a second total, a second curve, a second asset list and a second
          bento stacked under the first. Removing it also takes the LAST fabricated
          numbers off this page: its trim bars carried invented deltas (-24%, +61%)
          and a made-up "trims free up / adds use" pair, which were the only figures
          left on the homepage that no real reading stood behind. */}

      {/* THE THING ITSELF, directly under the hero — the hero sells it in one
          breath and this does it. Gated: with the flow off the page runs on to
          the loop, which is an honest homepage for a kit without the flow. */}
      {/* THE PORTFOLIO INTRO (owner 2026-08-03: "you didn't add the whole portfolio
          intro section above craft thesis. I want you to add that" — asked at 08:45
          and genuinely missed, so it is his second time saying it).
          His framing, near verbatim: a how-it-works for the PORTFOLIO system, that
          "buying and managing your portfolio multi chain has never been easier", then
          showing the weight movements and the insights.
          It sits ABOVE the loop deliberately: the loop is the whole arc ending in
          publishing, and this is the half a person actually starts with. The funnel
          is manage-first, graduate-later. */}
      <section id="managing" className="relative scroll-mt-24 py-12 sm:py-16 lg:py-24">
        {/* the act's own light — every major act carries one (the create
            section's cyan radial, the publish card's bloom); this one ran
            bare. Centred INSIDE itself per the seam lesson: a radial centred
            on a boundary reads as a band, not as light. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[min(800px,130%)] w-screen -translate-x-1/2 -translate-y-1/2"
          style={{
            background:
              'radial-gradient(80% 55% at 50% 50%, color-mix(in oklab, var(--color-violet-bright) 7%, transparent), transparent 70%)',
          }}
        />
        <Reveal>
          <SectionHead
            eyebrow="the portfolio system"
            size="display"
            title={
              <>
                {/* two lines TOTAL at >=sm: the ink sentence holds one line
                    (em-shrink keeps the clamp), the spectral line is the
                    second (owner 2026-08-17). Phones keep the 08-06 ruling. */}
                <span className="sm:whitespace-nowrap">Managing a portfolio across chains</span>
                <br />
              </>
            }
            spectralWord="has never been this easy."
          />
        </Reveal>
        {/* VISUAL-FIRST (owner 2026-08-03 ~10:00: "far more visual, use elements
            from the portfolio page/system"; then ~10:2x: "way way too much
            text") — the visuals carry the whole point now, the heading is the
            only sentence. Same arc as 17:39: descriptions deleted on sight. */}
        {/* A RAIL ON PHONES (mobile sweep 2026-08-06): stacked, these three
            Bezel cards ran ~1064px — 1.26 viewports of corridor — while the
            discovery section two blocks down already flicks sideways. Same
            Carousel primitive, same reason: one thumb flick per idea with the
            next peeking, instead of scrolling past three full screens. Tighter
            card padding on phone too (p-8 was 32px inside a 326px card). */}
        <Carousel label="How the portfolio system works" gridFrom="lg" gridClassName="lg:grid-cols-3" className="mt-10 sm:mt-14">
          {[
            { k: 'One book, every EVM chain', kind: 'book' as const, accent: 'var(--color-cyan)' },
            { k: 'Move weights, not positions', kind: 'weights' as const, accent: 'var(--color-violet-bright)' },
            { k: 'Insights, not advice', kind: 'insights' as const, accent: 'var(--color-teal)' },
          ].map((c, i) => (
            <Reveal key={c.k} delay={i * 90} className="h-full">
              <Bezel className="h-full" glow={c.accent}>
                <div className="flex h-full flex-col gap-4 p-6 sm:p-8">
                  <span aria-hidden className="h-px w-12" style={{ background: c.accent }} />
                  <h3 className="font-display text-lg font-bold uppercase tracking-[0.04em] text-ink">{c.k}</h3>
                  <IntroArt kind={c.kind} accent={c.accent} baskets={all} />
                </div>
              </Bezel>
            </Reveal>
          ))}
        </Carousel>
      </section>

      {/* THE LOOP — the proposition, shown as the thing it produces */}
      <section className="py-12 sm:py-16 lg:py-24">
        {/* head left, door right — the discovery section's own idiom. The
            description (the fee sentence + the earning link) is GONE and the
            create door stands in its place (owner 1826: "in the craft a
            thesis, hold it and get paid [when others] hold it too — remove
            the description and have the Create a basket button which takes
            you to the create page"). The door rides the flow's own gate. */}
        <div className="flex flex-wrap items-center justify-between gap-8">
          <Reveal>
            {/* two lines and larger (owner 17:39: "craft the thesis, hold it, let
                others hold it too needs to be two lines and make it larger") —
                the break is explicit so it cannot re-flow into three */}
            <SectionHead
              size="display"
              /* owner 2026-08-03 late: 'should say WHEN others hold not let' —
                 supersedes the ~16:2x 'let' phrasing */
              title={
                <>
                  Craft a thesis, hold it and get
                  <br />
                </>
              }
              spectralWord="paid when others hold it too."
            />
          </Reveal>
          {CREATE_PAGE_ON && (
            <Reveal delay={120}>
              <IslandCta to="/create">Create a basket</IslandCta>
            </Reveal>
          )}
        </div>
        <div className="mt-14">
          {/* THE MADE BASKET (owner ~10:2x: "instead of these four cards it
              should be a bento basket with a ticker and ca to show making a
              basket") — the rungs are replaced by the thing the loop PRODUCES:
              one real published basket, whole. */}
          <MadeBasket baskets={all} />
        </div>
      </section>

      {/* DISCOVERY — his line, and the data behind why it is the right line */}
      {convictions.length > 0 && (
        <section className="py-12 sm:py-16 lg:py-24">
          <div className="flex flex-wrap items-center justify-between gap-8">
            <Reveal>
              {/* no eyebrow pill, no description (owner 17:01) — two lines,
                  bigger, and the cards below are the argument. The ch cap was
                  14 and wrapped the spectral line, making it THREE (owner 17:39:
                  "buy someone's conviction in one click again needs to be two
                  lines, not three") — widened past the longest line so only the
                  explicit break decides. */}
              <h2
                className="max-w-[26ch] font-display font-semibold leading-[1.0] tracking-tight text-ink"
                /* phone floor lowered so the hand-broken pair stays TWO lines
                   (owner 2026-08-06 23:13: "buy someone's conviction in one
                   click needs to be moved over two lines") */
                style={{ fontSize: 'clamp(1.5rem, 0.7rem + 4.6vw, 3.75rem)' }}
              >
                Buy someone&rsquo;s
                <br />
                <span className="spectral-text">conviction in one click.</span>
              </h2>
            </Reveal>
            <Reveal delay={120}>
              {/* same voice as "Create a basket" (owner 2026-08-17): the two
                  section CTAs are peers, so they wear the same fill */}
              <IslandCta to="/explore">
                See all baskets
              </IslandCta>
            </Reveal>
          </div>
          {/* the controls sit between the head and the cards, so you choose a
              network / order / floor before you read them rather than after.
              One quiet row: the network filter left, the order pair + TVL
              select right (the owner 2026-08-13) — the same chip chrome as the
              network pills so the row reads as one instrument. */}
          {(chainOptions.length > 0 || canReturns || homeTvlSteps.length > 0) && (
            <Reveal delay={180} className="mt-14">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                {chainOptions.length > 0 && (
                  <ChainFilterRow options={chainOptions} value={chain} onChange={setPickedChain} />
                )}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {canReturns &&
                    BASKET_ORDERS.filter((o) => o.id === 'returns' || o.id === 'tvl').map((o) => {
                      const on = activeHomeOrder === o.id
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => setHomeOrder(o.id)}
                          aria-pressed={on}
                          title={o.title}
                          className={`press inline-flex h-7 shrink-0 items-center rounded-full border px-3 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                            on
                              ? 'border-cyan/50 bg-cyan/10 text-cyan'
                              : 'border-white/10 text-ink-dim hover:border-white/30 hover:text-ink'
                          }`}
                        >
                          {o.label}
                        </button>
                      )
                    })}
                  {homeTvlSteps.length > 0 && (
                    <select
                      value={activeHomeMinTvl}
                      onChange={(e) => setHomeMinTvl(Number(e.target.value))}
                      aria-label="Minimum basket TVL"
                      title="Only baskets at or above this measured value. One whose value can't be read right now only shows under Any: it can't prove it clears a minimum."
                      className={`h-7 shrink-0 rounded-full border bg-void px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] outline-none transition-colors focus:border-cyan/50 ${
                        activeHomeMinTvl > 0 ? 'border-cyan/50 text-cyan' : 'border-white/10 text-ink-dim'
                      }`}
                    >
                      <option value={0}>TVL · Any</option>
                      {homeTvlSteps.map((min) => (
                        <option key={min} value={min}>
                          TVL {tvlStepLabel(min)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </Reveal>
          )}
          <div className={chainOptions.length > 0 || canReturns || homeTvlSteps.length > 0 ? 'mt-8' : 'mt-14'}>
            <ConvictionGrid baskets={shownConvictions} resetKey={`${chain}|${activeHomeOrder}|${activeHomeMinTvl}`} />
          </div>

          {/* ── THE THESES SHELF (the owner 2026-08-09: theses "show up amongst
                 baskets on the homepage") — each cross-chain idea as ONE door
                 under the per-chain cards it groups, so two cards above sharing
                 a name read as legs of one idea rather than as strangers. The
                 card is the shared components/ThesisCard the creator page and
                 Explore's Theses tab mount, in the creator strip's own
                 responsive idiom: snap-scroll on phones, wrapping from sm.
                 UNTOUCHED by the network filter above on purpose — a thesis is
                 cross-chain by nature, so a network press must not amputate its
                 legs; each card wears its own chain badges instead. Absent
                 entirely when none exist: no heading over an empty row. ── */}
          {crossChainTheses.length > 0 && (
            <Reveal delay={200} className="mt-14">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                <h3 className="font-display text-lg font-bold uppercase tracking-[0.04em] text-ink">Bundles</h3>
                <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                  one idea, published across networks
                  {CREATE_PAGE_ON && (
                    <Link to="/create?door=publish" className="press text-ink-faint transition-colors hover:text-violet-bright">
                      + compose your own
                    </Link>
                  )}
                </span>
              </div>
              <div className="-mx-4 mt-6 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
                {crossChainTheses.map((t) => (
                  <ThesisDoorCard
                    key={`${t.deployer}::${t.name}`}
                    thesis={t}
                    size="md"
                    /* the full face (chart + bento) needs real width: one per
                       screen on phones, two-up from lg via the grid below */
                    /* grow to the section's full edge (owner 2026-08-17: the bundles rail
                       must align with the upper grid's right-hand side) — 2-up
                       from lg, filling the row instead of stopping at 520px */
                    className="min-w-0 shrink-0 basis-[88%] snap-start sm:flex-1 sm:basis-auto sm:shrink lg:min-w-[420px]"

                  />
                ))}
              </div>
            </Reveal>
          )}
        </section>
      )}

      {/* THE NUMBERS — live from chain, and the one section that had no
          title (beautify round ~15:5x): the head states what the row IS —
          counts read from chain at this moment — so the cells stop floating
          under a bare pill. */}
      {all.length > 0 && (
        <section className="py-12 sm:py-16 lg:py-24">
          <Reveal>
            <SectionHead
              eyebrow="live on chain"
              title={<>Nothing here is a claim.</>}
              spectralWord="It is a reading."
            />
          </Reveal>
          <div className="mt-14">
            <FactRow
              facts={[
                { v: String(Math.round(n)), l: 'baskets live' },
                { v: String(Math.round(c)), l: 'creators' },
                { v: String(chains), l: 'networks' },
                { v: formatUsdCompact(t), l: 'total value locked', spectral: true },
              ]}
            />
          </div>
        </section>
      )}

      {/* PUBLISH — the graduation (owner 17:01: description out, buttons and
          the whole card cooler). A full-bleed prism edge, the prism bloom
          behind the type, and the two actions as islands. */}
      <section className="py-12 sm:py-16 lg:py-24">
        <Reveal>
          <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5">
            <div className="relative overflow-hidden rounded-[calc(2rem-0.375rem)] bg-panel/80 shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)]">
              {/* the prism runs the full top edge, then blooms behind the type */}
              <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: SPECTRAL }} />
              <span
                aria-hidden
                className="pointer-events-none absolute -left-24 -top-32 h-96 w-96 rounded-full opacity-20 blur-[120px]"
                style={{ background: SPECTRAL }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-40 -right-24 h-96 w-96 rounded-full opacity-[0.14] blur-[120px]"
                style={{ background: 'var(--color-magenta)' }}
              />
              <div className="relative grid items-center gap-12 p-10 sm:p-16 lg:grid-cols-[minmax(0,1fr)_auto]">
                <h2
                  className="max-w-[13ch] font-display font-semibold leading-[1.0] tracking-tight text-ink"
                  style={{ fontSize: 'clamp(1.5rem, 0.7rem + 4.6vw, 3.75rem)' }}
                >
                  Turn your thesis into a <span className="spectral-text">token.</span>
                </h2>
                <div className="flex flex-col gap-4 lg:justify-self-end">
                  {WALLET_ENABLED && <SplitCta left={{ to: '/portfolio', label: 'Create portfolio' }} right={{ to: '/create', label: 'Create baskets' }} />}
                  {/* anchored: /learn now reads PORTFOLIO-first (owner 2026-08-02,
                      the settled funnel is manage-then-publish), so a card
                      promising "how publishing works" lands on that section
                      rather than making the reader scroll past act one. */}
                  <IslandCta to="/learn#publish" tone="quiet">
                    How publishing works
                  </IslandCta>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* THE POSTURE — the quiet, load-bearing sentences. Each wears the tiny
          identity dot of the intro card whose promise it grounds (cyan = the
          book, violet = the moves, teal = the facts) — the page's accent
          system closing its own loop instead of three floating lines. */}
      <section className="pb-12 sm:pb-16 lg:pb-24">
        <Reveal>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 border-t border-white/8 pt-12 text-center">
            {[
              { line: 'self-custodial · your wallet holds everything', accent: 'var(--color-cyan)' },
              { line: 'no database · every number read from chain', accent: 'var(--color-teal)' },
              { line: 'contracts have no admin · nobody can pause you', accent: 'var(--color-violet-bright)' },
            ].map(({ line, accent }) => (
              <span
                key={line}
                className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint"
              >
                <span aria-hidden className="h-1 w-1 shrink-0 rounded-full" style={{ background: accent }} />
                {line}
              </span>
            ))}
          </div>
        </Reveal>
      </section>
    </div>
  )
}
