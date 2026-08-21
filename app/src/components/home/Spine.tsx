import { useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { Link } from 'react-router'
import { useInViewOnce, usePrefersReducedMotion } from '../../lib/motion'
import { AssetLogo } from '../AssetLogo'
import { BasketAvatar } from '../BasketAvatar'
import { ChainBadge } from '../ChainBadge'
import { formatUsdCompact } from '../../lib/spectrum/format'
import type { BasketSummary } from '../../lib/spectrum/basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// THE HOMEPAGE SPINE — the narrative primitives (owner 2026-08-02: "build out a
// completely new homepage that better reflects the whole proposition").
//
// The page tells ONE story in four rungs, and these are the parts it is made
// of. Everything here reuses Spectrum's own token system rather than importing
// a second visual language: the spectral prism, Chakra Petch display, the
// double-bezel shell already used on the portfolio, the house cubic-bezier.
//
// Craft law applied (design MasterModule): double-bezel on every major
// container · eyebrow tags above every section head · scroll reveals that carry
// mass (translate + blur + opacity, transform/opacity only) · custom easing
// everywhere, never linear/ease-in-out · macro whitespace · single-column
// collapse below md with no rotations or negative overlaps surviving.
// ─────────────────────────────────────────────────────────────────────────────

export const SPECTRAL = 'linear-gradient(92deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
export const EASE = 'cubic-bezier(0.32,0.72,0,1)'

/** Scroll reveal with mass: rises, unblurs and fades in once. Reduced motion
 *  shows the final state immediately — the content is never gated on the
 *  animation (the blank-hero lesson: decoration must never own visibility). */
export function Reveal({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode
  delay?: number
  className?: string
}) {
  const reduced = usePrefersReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const seen = useInViewOnce(ref)
  const on = reduced || seen
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: on ? 1 : 0,
        transform: on ? 'translateY(0)' : 'translateY(32px)',
        filter: on ? 'blur(0)' : 'blur(6px)',
        transition: reduced ? 'none' : `opacity 800ms ${EASE} ${delay}ms, transform 800ms ${EASE} ${delay}ms, filter 800ms ${EASE} ${delay}ms`,
      }}
    >
      {children}
    </div>
  )
}

/** The microscopic pill above every section head. */
export function Eyebrow({ children, tone = 'faint' }: { children: ReactNode; tone?: 'faint' | 'spectral' }) {
  if (tone === 'spectral')
    return (
      <span className="inline-flex items-center rounded-full p-px" style={{ background: SPECTRAL }}>
        <span className="rounded-full bg-void px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink">
          {children}
        </span>
      </span>
    )
  return (
    <span className="inline-flex items-center rounded-full border border-white/12 bg-white/[0.03] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
      {children}
    </span>
  )
}

/** The double-bezel enclosure — a glass plate in a machined tray. Concentric
 *  radii by construction: inner = outer − padding. */
export function Bezel({
  children,
  className = '',
  glow,
  inner = '',
  panel = 'bg-panel/70',
  clip = true,
}: {
  children: ReactNode
  className?: string
  glow?: string
  inner?: string
  /** The plate's background class. Defaults to the translucent glass every
   *  Bezel on the page uses. A card sitting over the BRIGHT hero art needs an
   *  opaque plate or the picture washes it out (owner 2026-08-02 19:00: "the
   *  hero right card is too transparent make it darker") — passed as a single
   *  class rather than layered on via `inner`, because two background
   *  utilities on one element resolve by stylesheet order, not by the order
   *  they appear in the class string. */
  panel?: string
  /** False lets popovers escape the plate (owner 1410: the wallet-link panel
   *  clipped at the card edge). The caller then owns not passing `glow` —
   *  the glow blob relies on this clipping. Absent = clipped, as always. */
  clip?: boolean
}) {
  return (
    <div className={`rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5 ${className}`}>
      <div
        className={`relative h-full ${clip ? 'overflow-hidden' : ''} rounded-[calc(2rem-0.375rem)] ${panel} shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)] ${inner}`}
      >
        {glow && (
          <span
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full opacity-20 blur-3xl"
            style={{ background: glow }}
          />
        )}
        {children}
      </div>
    </div>
  )
}

/** Primary CTA with the nested trailing icon — the arrow never sits naked. */
export function IslandCta({
  to,
  children,
  tone = 'spectral',
  external = false,
}: {
  to: string
  children: ReactNode
  tone?: 'spectral' | 'quiet'
  external?: boolean
}) {
  const spectral = tone === 'spectral'
  const body = (
    <>
      {/* balanced (owner 2026-08-06 23:13: "how publishing works — that
          button, the text needs to be balanced better over two lines") */}
      <span className="font-display text-[12px] font-bold uppercase tracking-[0.12em] [text-wrap:balance]">{children}</span>
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full transition-transform duration-500 group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105 ${
          spectral ? 'bg-black/15' : 'bg-white/10'
        }`}
        style={{ transitionTimingFunction: EASE }}
        aria-hidden
      >
        →
      </span>
    </>
  )
  // The primary fill is now `.spectral-btn` (owner 2026-08-02 17:39: "the create
  // your portfolio button needs to be beautified — look at the way we've done the
  // button on the actual portfolio page, it needs to have the exact same style").
  // That class is what Yours.tsx's add/rebalance button uses: the same prism ramp
  // plus the inset top highlight, the inset floor shade and the violet drop
  // shadow, so the button reads as a machined object instead of a flat swatch.
  // Deliberately keeping the nested arrow disc, which is this page's own idiom.
  const cls = `press group inline-flex h-12 items-center gap-3 rounded-full py-1 pl-6 pr-1 transition-transform duration-500 hover:scale-[1.02] active:scale-[0.98] ${
    spectral ? 'spectral-btn text-void' : 'border border-white/15 text-ink hover:border-cyan/50'
  }`
  const style: CSSProperties = { transitionTimingFunction: EASE }
  if (external)
    return (
      <a href={to} target="_blank" rel="noopener noreferrer" className={cls} style={style}>
        {body}
      </a>
    )
  return (
    <Link to={to} className={cls} style={style}>
      {body}
    </Link>
  )
}

/**
 * THE SPLIT CTA — two doors in one object (the owner, 2026-08-16: "a cool dual
 * button thing where you have 'Create Portfolio' / 'Create Baskets' and then
 * hovering over one side shifts the button colour to that and leaves the other
 * bit in a white outline/text").
 *
 * WHY IT IS ONE OBJECT AND NOT TWO BUTTONS. Two primary buttons side by side
 * make a person choose before they know the difference, and whichever is
 * painted brighter quietly becomes the recommendation. A split pill says these
 * are peers and the choice is yours: at rest NEITHER is filled, so the page
 * makes no claim, and the fill follows the pointer as a preview of the door you
 * are about to open rather than a verdict about which one is correct.
 *
 * Built from `.spectral-btn` and the same h-12 pill as IslandCta, deliberately,
 * so it reads as the same family rather than a second button language.
 *
 * ⚠ TWO REAL LINKS, not one control with a mode. Keyboard users tab to each
 * half and see the same fill on :focus-visible that a pointer gets on hover;
 * the hover-only version of this pattern is invisible to them. And the
 * hairline only shows while neither half is engaged, because a divider inside
 * a filled half is just a scratch on the paint.
 */
export function SplitCta({
  left,
  right,
}: {
  left: { to: string; label: string }
  right: { to: string; label: string }
}) {
  /* whitespace-nowrap + the xs size step-down keep each label on ONE line
     always (owner 2026-08-16: "Create portfolio → … should be always on one
     line") — without the nowrap the label breaks mid-phrase inside the fixed
     h-12 half the moment the parent squeezes it. */
  const half =
    'group/half relative z-10 flex h-12 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-4 font-display text-[11px] font-bold uppercase tracking-[0.12em] sm:gap-2 sm:px-5 sm:text-[12px] ' +
    'text-ink transition-colors duration-300 hover:text-void focus-visible:text-void focus-visible:outline-none'
  return (
    <div
      className="press group/split relative inline-flex items-stretch overflow-hidden rounded-full border border-white/15 transition-transform duration-500 hover:scale-[1.02] active:scale-[0.98]"
      style={{ transitionTimingFunction: EASE }}
    >
      {[left, right].map((side, i) => (
        <Link key={side.to} to={side.to} className={half}>
          {/* the fill lives BEHIND the label and only this half's own hover
              paints it, which is what leaves the other side outlined */}
          <span
            aria-hidden
            className="spectral-btn pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover/half:opacity-100 group-focus-visible/half:opacity-100 motion-reduce:transition-none"
            style={{ transitionTimingFunction: EASE, borderRadius: i === 0 ? '9999px 0 0 9999px' : '0 9999px 9999px 0' }}
          />
          <span className="relative">{side.label}</span>
          <span aria-hidden className="relative transition-transform duration-500 group-hover/half:translate-x-0.5" style={{ transitionTimingFunction: EASE }}>
            →
          </span>
        </Link>
      ))}
      {/* the divider retreats the moment either side is engaged */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-2.5 left-1/2 w-px -translate-x-1/2 bg-white/15 transition-opacity duration-300 group-hover/split:opacity-0"
      />
    </div>
  )
}

/** A section head: eyebrow, display line, and one plain sentence beneath.
 *
 *  `size="display"` (owner 2026-08-02 17:39, on the loop head: "needs to be two
 *  lines and make it larger") matches the discovery and publish heads instead of
 *  sitting a tier under them, and drops [text-wrap:balance] — balance re-flows a
 *  head into whatever line count it prefers, which is the opposite of an
 *  explicit two-line composition. At display size the caller owns the breaks.
 *
 *  SPACING IS MOBILE-FIRST FROM 2026-08-05 (owner, mobile sweep: "Logos and text
 *  shouldn't have too much spacing between each other"). A head is ONE cluster —
 *  the pill labels the title and the sentence explains it — so on a phone the two
 *  internal gaps drop to 16px, which reads as one block instead of three stacked
 *  strangers. The 24px desktop gaps come back at sm and are untouched above it. */
export function SectionHead({
  eyebrow,
  title,
  sub,
  spectralWord,
  size = 'default',
}: {
  /** Optional since the 2106 batch: the loop head dropped its pill. */
  eyebrow?: string
  title: ReactNode
  sub?: ReactNode
  spectralWord?: string
  size?: 'default' | 'display'
}) {
  const display = size === 'display'
  return (
    // NO width cap at display size (owner 2026-08-02 17:57, angry and right:
    // "that needs to be two lines… for some you've made it eight lines. Make it
    // two, spread it across. Use more width, damn it"). My 17:39 change capped
    // this at 26ch while ENLARGING the type, which is the same ch-cap defect I
    // had just fixed three times on this page: a cap narrower than a hand-broken
    // line wraps every one of those lines again. At display size the caller's
    // explicit breaks are the only thing that may decide line count.
    <div className={display ? 'max-w-none' : 'max-w-[46ch]'}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2
        /* ONE scale for every section title (owner 2026-08-17: "i dont like
           how these different section titles have different sizing") — the
           display/default split gave 60px next to 48px on the same page. The
           unified clamp tops at 46px, which also lets the longest ink line
           ("Managing a portfolio across chains") hold a single line at lg. */
        className="mt-4 font-display font-semibold leading-[1.04] tracking-tight text-ink [text-wrap:balance] sm:mt-6"
        style={{
          // PHONE FLOORS LOWERED (owner 2026-08-06 23:13, by line count:
          // "managing a portfolio across chains has never been this easy needs
          // to be balanced over three lines, not four"; "craft a thesis hold it
          // and get paid also needs three"). The clamp minimum was doing all
          // the work below ~480px, and at 2rem a hand-broken line simply could
          // not fit a 342px column — so every explicit line wrapped again.
          fontSize: 'clamp(1.375rem, 0.9rem + 2.6vw, 2.875rem)',
        }}
      >
        {title}
        {spectralWord && <span className="spectral-text"> {spectralWord}</span>}
      </h2>
      {sub && <p className="mt-4 text-[14px] leading-relaxed text-ink-dim sm:mt-6">{sub}</p>}
    </div>
  )
}

/** The rung's visual is a REAL FRAGMENT OF THE PRODUCT, built from live on-chain
 *  baskets (owner 2026-08-02 17:39: "these cards as well need to actually have
 *  proper visuals from the site, not just images, not just like little icons
 *  you've made, needs to be proper"). This replaces the drawn SVG glyphs the
 *  17:01 round asked for — he saw them rendered and wanted the real surfaces.
 *
 *  Every number and mark here is real: the asset art comes from the same
 *  AssetLogo the app uses, the token art is the basket's own BasketAvatar, the
 *  holders and value are read from chain. Nothing is projected — in particular
 *  the "earn" rung shows what a real basket IS (its holders, its value), never a
 *  fee estimate, because a projected earning is a returns promise.
 *
 *  With no readable baskets each rung renders NOTHING rather than a placeholder,
 *  so a fresh operator install shows the four steps as words instead of a lie. */
function RungArt({
  kind,
  accent,
  baskets,
}: {
  kind: 'hold' | 'shape' | 'token' | 'earn'
  accent: string
  baskets: BasketSummary[]
}) {
  // Distinct real assets across baskets, biggest first — used by the first two
  // rungs. Deliberately spans chains so "any chain, one book" is literal.
  const assets = useMemo(() => {
    const seen = new Set<string>()
    const out: { symbol: string; address: string; chainId: number; weightPct: number }[] = []
    for (const b of baskets) {
      for (const t of b.top ?? []) {
        const k = t.symbol.toUpperCase()
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ symbol: t.symbol, address: t.address, chainId: b.chainId, weightPct: t.weightPct || 1 })
        if (out.length >= 4) return out
      }
    }
    return out
  }, [baskets])

  const basket = baskets[0]

  if (kind === 'hold') {
    // the real book: real assets, real networks, gathered in one list
    if (assets.length === 0) return null
    return (
      <ul className="space-y-2">
        {/* 8px logo→ticker, not 10 (owner 2026-08-05: "Logos and text shouldn't
            have too much spacing between each other"). A 22px mark and its own
            symbol are one label, so they sit in the tight end of the cluster
            band; 8 is also on the house scale where 10 was not. */}
        {assets.slice(0, 3).map((a) => (
          <li key={a.symbol} className="flex items-center gap-2">
            <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={22} />
            <span className="min-w-0 flex-1 truncate font-display text-[12px] font-bold text-ink">${showSymbol(a.symbol)}</span>
            <ChainBadge chainId={a.chainId} />
          </li>
        ))}
      </ul>
    )
  }

  if (kind === 'shape') {
    // the real control at rest: the trim/add bar the portfolio actually uses,
    // carrying real symbols. Positions are a resting illustration of the
    // control, which is why no percentage is printed beside them.
    if (assets.length === 0) return null
    const fills = [72, 34, 51]
    return (
      // 12px between trim bars (was 14, off the house scale in both directions).
      <ul className="space-y-3">
        {assets.slice(0, 3).map((a, i) => (
          <li key={a.symbol}>
            <span className="mb-1.5 block truncate font-display text-[11px] font-bold text-ink-dim">${showSymbol(a.symbol)}</span>
            <span className="relative block h-1.5 w-full rounded-full bg-white/[0.07]">
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${fills[i]}%`, background: accent, opacity: 0.55 }}
              />
              <span
                aria-hidden
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full p-px"
                style={{ left: `${fills[i]}%`, background: SPECTRAL }}
              >
                <span className="block h-full w-full rounded-full bg-void" />
              </span>
            </span>
          </li>
        ))}
      </ul>
    )
  }

  if (kind === 'token') {
    // the product's own token art for a REAL published basket
    if (!basket) return null
    return (
      <div className="flex flex-col items-start gap-3">
        <BasketAvatar address={basket.address} symbol={basket.symbol} size={52} />
        <span className="min-w-0 max-w-full truncate font-display text-lg font-bold text-ink">${showSymbol(basket.symbol)}</span>
      </div>
    )
  }

  // earn — what a real published basket IS: who holds it, what it is worth.
  // Facts read from chain, never a fee projection.
  if (!basket) return null
  const holders = basket.holdersCount
  return (
    <div className="space-y-4">
      {holders != null && (
        <div>
          <div className="font-num text-2xl font-light leading-none tabular-nums text-ink">{holders}</div>
          <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
            holders of ${showSymbol(basket.symbol)}
          </div>
        </div>
      )}
      {basket.aumUsd > 0 && (
        <div>
          <div className="font-num text-2xl font-light leading-none tabular-nums" style={{ color: accent }}>
            {formatUsdCompact(basket.aumUsd)}
          </div>
          <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">trading through it</div>
        </div>
      )}
    </div>
  )
}

/** The four rungs — a number, three or four words, and a real piece of the
 *  product. `baskets` is live on-chain data; empty is handled, never faked. */
export function LoopLadder({
  rungs,
  baskets = [],
}: {
  rungs: { n: string; title: string; body: string; accent: string; art: 'hold' | 'shape' | 'token' | 'earn' }[]
  baskets?: BasketSummary[]
}) {
  return (
    <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {rungs.map((r, i) => (
        <Reveal key={r.n} delay={i * 90} className="h-full">
          <li className="h-full list-none">
            <Bezel className="h-full" glow={r.accent}>
              {/* MOBILE SWEEP 2026-08-05 ("sections on mobile/tablets shouldn't
                  have giant gaps between them… within 1 sec of scroll from one
                  info to another"). Below sm the four rungs are FOUR STACKED
                  CARDS, so this padding and these internal gaps are paid four
                  times over — 20/16 on a phone, the desktop 24/24 from sm up,
                  where the grid is already 2-up and the ladder is half as tall. */}
              <div className="flex h-full flex-col gap-4 p-5 sm:gap-6 sm:p-6">
                <span className="font-num text-2xl font-light leading-none tabular-nums" style={{ color: r.accent }}>
                  {r.n}
                </span>
                <div className="flex-1">
                  <RungArt kind={r.art} accent={r.accent} baskets={baskets} />
                </div>
                <div>
                  <h3 className="font-display text-base font-bold uppercase tracking-[0.06em] text-ink">{r.title}</h3>
                  <p className="mt-2 text-[12px] leading-relaxed text-ink-dim">{r.body}</p>
                </div>
              </div>
            </Bezel>
          </li>
        </Reveal>
      ))}
    </ol>
  )
}

/** Facts stated flat — no card, no chrome, just the numbers and what they are. */
export function FactRow({ facts }: { facts: { v: string; l: string; spectral?: boolean }[] }) {
  const cells = useMemo(() => facts.filter((f) => f.v), [facts])
  if (cells.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {cells.map((f, i) => (
        <Reveal key={f.l} delay={i * 70} className="h-full">
          {/* fancier per owner 17:01 — each number in its own machined cell
              with the prism running along its top edge */}
          {/* 20px cell padding until lg (mobile sweep 2026-08-05). This grid is
              2-up on a phone and 4-up from sm, so 32px of padding was eating
              more of each cell than the number inside it — the tightening has to
              hold through the tablet range, not stop at sm, for the same reason
              the owner named tablets alongside mobile. */}
          <div className="relative h-full overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02] p-5 lg:p-8">
            <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: SPECTRAL, opacity: 0.6 }} />
            <span
              aria-hidden
              className="pointer-events-none absolute -right-12 -top-16 h-40 w-40 rounded-full opacity-[0.12] blur-3xl"
              style={{ background: SPECTRAL }}
            />
            <div
              className={`relative font-num text-4xl font-light leading-none tabular-nums sm:text-5xl ${
                f.spectral ? 'spectral-text font-normal' : 'text-ink'
              }`}
            >
              {f.v}
            </div>
            {/* the number and what it IS are one fact, so 12px on a phone */}
            <div className="relative mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint lg:mt-4">{f.l}</div>
          </div>
        </Reveal>
      ))}
    </div>
  )
}
