import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { usePrefersReducedMotion } from '../lib/motion'
import { activeFromRatios } from '../lib/rail-position'

// ─────────────────────────────────────────────────────────────────────────────
// THE CAROUSEL PRIMITIVE (owner 2026-08-05, the mobile sweep: "Anything that
// uses too much width we dont stack cards below we create a carousel").
//
// IT IS A NATIVE SCROLL CONTAINER, NOT A SLIDER. One `overflow-x-auto` div with
// CSS scroll-snap, and that is the whole engine. Momentum, rubber-banding,
// two-finger and trackpad scrolling, keyboard scrolling, the platform's own
// tap-versus-drag arbitration and the "scroll a focused child into view"
// behaviour all arrive for free and behave like the OS, not like us. A
// JS drag/transform slider has to re-implement every one of those, and the one
// it always gets wrong is tap-versus-drag: it captures the pointer and the
// links and buttons inside the cards stop working. There is no pointer handler
// in this file for exactly that reason.
//
// IT IS NOT A SECOND BannerCarousel (recreating a component that exists is
// banned here, so this needs saying). That one is a single SLOT that fades
// between messages on a timer, driven by us, with nothing to scroll and no
// reader input. This is many items side by side, moved by the reader, with no
// timer. Same word, no shared behaviour — only the dot styling is shared, on
// purpose, so the two indicators read as one system.
//
// A RAIL IS A PHONE ANSWER, SO THE SWITCH IS A PROP. Above `gridFrom` the items
// are the plain grid the caller already had; below it they are a rail. The
// switch is pure CSS: a JS breakpoint check paints the wrong layout on the first
// frame and corrects it on the second, which is a visible flash on every load,
// and the first adopter of this is the homepage.
// ─────────────────────────────────────────────────────────────────────────────

/** The breakpoint at which the rail becomes the caller's grid. `never` = always a rail. */
export type GridFrom = 'sm' | 'md' | 'lg' | 'never'

// Written out per breakpoint rather than built from a template, because
// Tailwind only generates classes it can SEE in the source. The pairs are the
// longhands (`overflow-x`/`overflow-y`) on both sides of the switch on purpose:
// mixing the `overflow` shorthand in would resolve by stylesheet order instead
// of by breakpoint, which is the same trap Bezel's `panel` prop documents.
const GRID_AT: Record<GridFrom, string> = {
  sm: 'sm:grid sm:snap-none sm:overflow-x-visible sm:overflow-y-visible',
  md: 'md:grid md:snap-none md:overflow-x-visible md:overflow-y-visible',
  lg: 'lg:grid lg:snap-none lg:overflow-x-visible lg:overflow-y-visible',
  never: '',
}

/** The indicator belongs to the rail, so it leaves with the rail. */
const CONTROLS_HIDE_AT: Record<GridFrom, string> = {
  sm: 'sm:hidden',
  md: 'md:hidden',
  lg: 'lg:hidden',
  never: '',
}

// Enough steps that a drag reports movement continuously; the exact values do
// not matter, only that the observer keeps talking while a card crosses the edge.
const THRESHOLDS = [0, 0.25, 0.5, 0.75, 0.9, 1]

interface CarouselProps {
  /** One element per item. Each is wrapped in its own snap stop. */
  children: ReactNode
  /** Names the set for screen readers, e.g. "Live baskets". Not shown on screen. */
  label: string
  /** Rail below this breakpoint, the caller's grid at and above it. Default `sm` (phones only). */
  gridFrom?: GridFrom
  /** Grid classes for the non-rail state, e.g. `sm:grid-cols-2 lg:grid-cols-3`. The gap is `gap-4` either way. */
  gridClassName?: string
  /** One item's width on the rail. Under 100% so the next item peeks, which is the affordance. */
  peek?: string
  /** Position dots under the rail. On by default; pass false for a rail of one-glance items. */
  dots?: boolean
  /**
   * Previous/next buttons. OFF by default: a thumb does not need them, and on a
   * phone they cost a tap target for a gesture the reader already has. Turn them
   * on when the rail survives past phone widths (`gridFrom` of `md`/`lg`/`never`),
   * where a mouse has no swipe. They then show only to a fine pointer.
   */
  arrows?: boolean
  /**
   * Change this whenever the ITEM SET changes (a filter, a tab) and the rail
   * returns to the first item. Without it a filter leaves the reader parked
   * where item four used to be, looking at either nothing or an unrelated card.
   */
  resetKey?: string | number
  /** Classes for the outer wrapper (margins, not layout). */
  className?: string
}

export function Carousel({
  children,
  label,
  gridFrom = 'sm',
  gridClassName = '',
  peek = '86%',
  dots = true,
  arrows = false,
  resetKey,
  className = '',
}: CarouselProps) {
  const items = Children.toArray(children)
  const count = items.length
  // The re-observe trigger. Item COUNT is not enough: a filter can swap a set of
  // six for a different set of six, React re-keys the wrappers, and the observer
  // would be left watching detached nodes and reporting a frozen position.
  const sig = items.map((c) => (isValidElement(c) ? String(c.key) : '')).join('|')

  const railRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const reduced = usePrefersReducedMotion()

  // POSITION COMES FROM THE ITEMS THEMSELVES. The observer's root is the rail,
  // so each item reports how much of it is on screen and the dots follow the
  // real scroll, including a half-swipe the reader abandons. No scroll listener,
  // so nothing runs on the main thread per frame while a finger is down.
  useEffect(() => {
    const rail = railRef.current
    if (!rail || typeof IntersectionObserver === 'undefined') return
    const kids = Array.from(rail.children) as HTMLElement[]
    const ratios = new Array<number>(kids.length).fill(0)
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = kids.indexOf(e.target as HTMLElement)
          if (i >= 0) ratios[i] = e.intersectionRatio
        }
        setActive(activeFromRatios(ratios))
      },
      { root: rail, threshold: THRESHOLDS },
    )
    kids.forEach((k) => io.observe(k))
    return () => io.disconnect()
  }, [sig])

  // Back to the start on a new set, INSTANTLY: a smooth scroll across items
  // that are being replaced in the same frame is a wobble, and the reader asked
  // for a different set, not for a journey back through the old one.
  useEffect(() => {
    if (resetKey === undefined) return
    railRef.current?.scrollTo({ left: 0, behavior: 'instant' })
    setActive(0)
  }, [resetKey])

  /** One item over, by the item's own edge — then mandatory snap settles it exactly. */
  const step = (dir: 1 | -1) => {
    const rail = railRef.current
    if (!rail) return
    const target = Math.min(Math.max(active + dir, 0), count - 1)
    const child = rail.children[target] as HTMLElement | undefined
    if (!child) return
    const pad = parseFloat(getComputedStyle(rail).paddingLeft) || 0
    const left =
      rail.scrollLeft + child.getBoundingClientRect().left - rail.getBoundingClientRect().left - pad
    rail.scrollTo({ left, behavior: reduced ? 'instant' : 'smooth' })
  }

  if (count === 0) return null

  return (
    <div className={className}>
      <div
        ref={railRef}
        role="group"
        aria-label={label}
        /* THE GEOMETRY, in the order it matters:
           · `-mx-4 px-4` bleeds the rail to the screen edge while the first item
             still lines up with the page gutter, so cards run off the edge
             instead of ending in a channel. Net zero once it is a grid.
           · `scroll-pl-4` matches that padding, or snap-start would park item
             two flush against the edge and item one 16px in.
           · `overscroll-x-contain` keeps a swipe that runs out of rail from
             becoming the browser's back gesture.
           · `overflow-y-hidden` (not the default `auto` that `overflow-x` forces)
             so the rail is strictly horizontal. The cards' entrance reveal rests
             32px low, which would otherwise make the rail a two-axis scroller
             for the second it takes to play. The cost is a clipped sliver of a
             card that is at opacity 0 at the time. */
        className={`scrollbar-none -mx-4 flex min-w-0 snap-x snap-mandatory gap-4 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-pl-4 px-4 ${GRID_AT[gridFrom]} ${gridClassName}`}
      >
        {items.map((child, i) => (
          // `min-w-0` is load-bearing: a flex item's default min-width is its
          // MIN-CONTENT width, so a wide card would quietly overrule `peek` and
          // the snap stops would stop lining up. `flexBasis` is an inline style
          // rather than a class so a caller can pass any width without Tailwind
          // needing to have seen it, and the grid ignores it for free.
          <div
            key={(isValidElement(child) && child.key) || i}
            className="min-w-0 shrink-0 snap-start"
            style={{ flexBasis: peek }}
          >
            {child}
          </div>
        ))}
      </div>

      {/* THE INDICATOR IS DECORATION (aria-hidden) AND NEVER THE NAVIGATION.
          The rail is a real scroll container, so a screen-reader or keyboard
          user reaches every item the ordinary way: the items keep their own tab
          order and the browser scrolls a focused one into view. That is also why
          the rail itself takes no tabindex — it would add a focus stop that says
          nothing and does nothing that Tab does not already do. */}
      {count > 1 && (dots || arrows) && (
        <div
          className={`mt-5 flex items-center justify-center gap-3 ${CONTROLS_HIDE_AT[gridFrom]}`}
        >
          {arrows && <Arrow dir={-1} onClick={() => step(-1)} disabled={active === 0} />}
          {dots && (
            <div aria-hidden className="flex items-center gap-1.5">
              {items.map((_, i) => (
                <span
                  key={i}
                  className={`h-1 rounded-full transition-all duration-300 motion-reduce:transition-none ${
                    i === active ? 'w-4 bg-white/40' : 'w-1 bg-white/15'
                  }`}
                />
              ))}
            </div>
          )}
          {arrows && <Arrow dir={1} onClick={() => step(1)} disabled={active === count - 1} />}
        </div>
      )}
    </div>
  )
}

/** The kit's existing rail arrow (see PopularAssets): same chevron, same press,
 *  same wording, so a rail control means the same thing everywhere. Hidden to a
 *  coarse pointer, where the gesture is better than any button we could draw. */
function Arrow({
  dir,
  onClick,
  disabled,
}: {
  dir: 1 | -1
  onClick: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === -1 ? 'Scroll left' : 'Scroll right'}
      className="press hidden h-8 w-8 place-items-center rounded-full border border-white/12 text-ink-dim hover:border-cyan/60 hover:text-cyan disabled:opacity-30 disabled:hover:border-white/12 disabled:hover:text-ink-dim pointer-fine:grid"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={dir === -1 ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
      </svg>
    </button>
  )
}
