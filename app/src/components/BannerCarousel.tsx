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
          without making either easier to hit. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0.5 flex justify-center gap-0">
        {slides.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setIndex(i)}
            aria-label={`Show message ${i + 1} of ${slides.length}`}
            aria-pressed={i === active}
            /* THE DOT IS 4px TALL — the BUTTON must not be (mobile audit
               2026-08-05, measured 4x4). Vertical padding plus a background-clip
               content box gives a 36px thumb target around an unchanged dot.
               ⚠ THE 2026-08-05 FIX ONLY GREW THE VERTICAL AXIS (mobile sweep
               2026-08-06 measured 20px WIDE): px-3 takes the inactive target to
               28px across, and the row's gap goes to 0 so the visible spacing
               stays where it was. The dot itself is still 4px. */
            className={`press pointer-events-auto box-content h-1 rounded-full bg-clip-content px-3 py-4 transition-all duration-500 ${
              i === active ? 'w-4 bg-white/40' : 'w-1 bg-white/15 hover:bg-white/30'
            }`}
          />
        ))}
      </div>
    </div>
  )
}
