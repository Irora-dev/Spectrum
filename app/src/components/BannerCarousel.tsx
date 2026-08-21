import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useOperatorSlide } from './OperatorBanner'
import { useReferredSlide } from './ReferredBanner'
import { usePrismClaimSlide } from './PrismClaimBanner'

// ─────────────────────────────────────────────────────────────────────────────
// ONE banner slot, rotating (owner 2026-08-02: "a single rotating carousel
// banner"). Supersedes the capped rail + the out-of-rail disclosure line: the
// old cap meant a strip could shadow another PERMANENTLY, and the disclosure
// had to live outside the rail to survive that. Rotation dissolves both — every
// live message gets the slot on a cycle, so nothing can be buried, and the
// disclosure rides the same slot it could previously never share.
//
// Each banner keeps its OWN eligibility + dismissal (the slide hooks return
// null when they have nothing to say); this component is presentation only.
// Height = the tallest live slide (grid stack), so rotation never shifts
// layout. Auto-advance pauses on hover/focus and is OFF under reduced motion —
// the dots always work by hand.
// ─────────────────────────────────────────────────────────────────────────────

const ROTATE_MS = 9_000

/** The experimental-technology line (owner 2026-07-30) — the one PERMANENT
 *  slide, so the carousel always has something honest to say and the
 *  disclosure can never be dismissed away. */
function RiskSlide() {
  return (
    <div className="py-2 text-center">
      <span className="font-mono text-[11px] leading-relaxed text-ink-faint">
        Spectrum is experimental technology.{' '}
        {/* a 14px-tall link is not a tap target (mobile audit 2026-08-05):
            inline-flex + min-height gives it a thumb without moving the text */}
        <Link
          to="/risk"
          className="inline-flex min-h-[36px] items-center underline underline-offset-2 hover:text-ink"
        >
          Read the disclosure →
        </Link>
      </span>
    </div>
  )
}

export function BannerCarousel() {
  const operator = useOperatorSlide()
  const referred = useReferredSlide()
  const prism = usePrismClaimSlide()

  const slides = [
    { key: 'operator', node: operator },
    { key: 'referred', node: referred },
    { key: 'prism', node: prism },
    { key: 'risk', node: <RiskSlide /> },
  ].filter((s) => s.node != null)

  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const reducedMotion = useRef(
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  ).current

  // A slide dismissing itself mid-cycle shrinks the list — clamp for this
  // render, and RESET the state so the next advance is in order rather than
  // one stale-modulus skip.
  const active = Math.min(index, slides.length - 1)
  useEffect(() => {
    if (index >= slides.length && slides.length > 0) setIndex(slides.length - 1)
  }, [index, slides.length])

  useEffect(() => {
    if (slides.length < 2 || paused || reducedMotion) return
    const t = window.setInterval(() => setIndex((i) => (i + 1) % slides.length), ROTATE_MS)
    return () => window.clearInterval(t)
  }, [slides.length, paused, reducedMotion])

  if (slides.length === 0) return null
  if (slides.length === 1) return <div>{slides[0].node}</div>

  return (
    <div
      className="relative"
      /* pointer events, mouse-typed only: a TAP fires mouseenter with no
         mouseleave until the next tap elsewhere, stalling rotation forever —
         touch users get the dots, hover-pause stays a pointer affordance */
      onPointerEnter={(e) => e.pointerType === 'mouse' && setPaused(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setPaused(false)}
      /* keyboard focus pauses (rotation must not advance under a keyboard
         user); pointer-initiated focus does NOT — a dot TAP focuses the button
         on Chrome/Android and would stall rotation exactly like the hover bug
         this replaced. :focus-visible is the platform's own distinction. */
      onFocus={(e) => {
        if ((e.target as HTMLElement).matches?.(':focus-visible')) setPaused(true)
      }}
      onBlur={() => setPaused(false)}
    >
      {/* grid stack: every slide occupies the same cell, so the slot is as
          tall as the tallest live message and rotation never moves the page */}
      <div className="grid">
        {slides.map((s, i) => (
          <div
            key={s.key}
            aria-hidden={i !== active}
            className={`col-start-1 row-start-1 motion-reduce:transition-none ${
              i === active
                ? 'visible opacity-100 [transition:opacity_700ms,visibility_0s]'
                : 'invisible opacity-0 [transition:opacity_700ms,visibility_0s_700ms]'
            }`}
          >
            {s.node}
          </div>
        ))}
      </div>
      {/* gap-0: the dots' own horizontal padding (below) is the separation now
          — adding a gap on top of a 28px target only pushes neighbours apart
          without making either easier to hit.
          IN FLOW, not overlaid (owner 2026-08-19: the active dot sat ON the
          short risk line and read as "a weird white dot in front of the
          sentence") — the dots now take their own thin band under the slide;
          -mt-3 folds most of the buttons' 36px thumb padding back in. */}
      <div className="pointer-events-none -mt-3 flex justify-center gap-0">
        {slides.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setIndex(i)}
            aria-label={`Show message ${i + 1} of ${slides.length}`}
            aria-pressed={i === active}
            /* THE BUTTON IS A TRANSPARENT TAP TARGET (36px thumb, px-3/py-4); the
               VISIBLE dot is the inner span. The old bg-clip-content trick let
               the whole rounded button paint faint white on the light plane —
               a "weird transparent circle" below the banner (owner 2026-08-21).
               The button now paints nothing, and the dot is INK-token so it
               reads on both planes (white on paper was invisible / a ghost). */
            className="press pointer-events-auto grid place-items-center px-3 py-4"
          >
            <span
              aria-hidden
              className={`block h-1 rounded-full transition-all duration-500 ${
                i === active ? 'w-4 bg-ink/45' : 'w-1 bg-ink/20 group-hover:bg-ink/35'
              }`}
            />
          </button>
        ))}
      </div>
    </div>
  )
}
