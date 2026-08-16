import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePrefersReducedMotion } from '../../lib/motion'

// ─────────────────────────────────────────────────────────────────────────────
// THE FIRST-VISIT TOUR (owner 2026-08-16: the portfolio's first open should
// "genuinely guide the user's hand properly in a beautiful way") — the guided
// half of the 14:21 welcome ask, which until now was one cyan line. Three
// spotlit beats over the REAL page: the hero (one book), the positions grid
// (act on any tile), the rebalance door (move weights, not positions). Then it
// gets out of the way forever.
//
// HOUSE MECHANICS, no library: a portal overlay whose backdrop is the
// spotlight itself (one ring div carrying a 9999px box-shadow, so the page
// shows through the cutout and dims everywhere else), the card floating beside
// the measured anchor. Anchors are looked up per beat, never held — the page
// re-renders freely underneath.
//
// LAWS:
//  · once, ever — the caller gates on the same welcome latch as the greeting
//    and we mark it spent on ANY exit (done, skip, Escape).
//  · the page stays the truth: the tour never re-renders or clones content,
//    only points at it. A beat whose anchor is missing is skipped silently.
//  · reduced motion: no smooth scrolling, no transitions, same words.
//  · Escape always exits. The card traps focus on its own two buttons only in
//    the tab order sense (the backdrop is inert), so a keyboard user is never
//    stuck behind the overlay.
// ─────────────────────────────────────────────────────────────────────────────

export interface TourBeat {
  key: string
  /** Looked up at show time — the page owns the element. */
  anchor: () => HTMLElement | null
  title: string
  body: string
}

const PAD = 12 // breathing room between the anchor's box and the ring

export function FirstVisitTour({ beats, onExit }: { beats: TourBeat[]; onExit: () => void }) {
  const reduced = usePrefersReducedMotion()
  const [idx, setIdx] = useState(0)
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const nextRef = useRef<HTMLButtonElement | null>(null)
  const live = beats.filter((b) => b.anchor() != null)
  const beat = live[Math.min(idx, live.length - 1)]

  const measure = useCallback(() => {
    const el = beat?.anchor()
    if (!el) return setRect(null)
    const r = el.getBoundingClientRect()
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
  }, [beat])

  // bring the beat's anchor into view, then measure once it has settled
  useEffect(() => {
    const el = beat?.anchor()
    if (!el) return
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
    const t = window.setTimeout(measure, reduced ? 0 : 420)
    return () => window.clearTimeout(t)
  }, [beat, reduced, measure])

  // the ring follows the page — scroll and resize both re-measure
  useEffect(() => {
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, { passive: true })
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure)
    }
  }, [measure])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit])

  // the next button is where a keyboard user lands on every beat
  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true })
  }, [idx])

  if (live.length === 0 || !beat) return null
  const last = idx >= live.length - 1

  // the card sits under the ring when the lower half has room, above it when
  // it doesn't, and CLAMPED fully on-screen either way — a viewport-tall
  // anchor (the hero card) must never push the words off the top (measured on
  // the first live shot: the title clipped behind the nav). Phones get a
  // bottom sheet; a floating card over a spotlight is thumb-hostile at 390px.
  const CARD_H = 232 // conservative estimate; the clamp is what matters
  const isPhone = typeof window !== 'undefined' && window.innerWidth < 640
  const below = rect ? rect.top + rect.height + PAD + CARD_H + 24 < window.innerHeight : true
  const rawTop = rect ? (below ? rect.top + rect.height + PAD + 8 : rect.top - PAD - CARD_H - 8) : 0
  const cardStyle: React.CSSProperties = isPhone
    ? { position: 'fixed', left: 16, right: 16, bottom: 16 }
    : rect
      ? {
          position: 'fixed',
          left: Math.min(Math.max(rect.left, 16), window.innerWidth - 416),
          top: Math.min(Math.max(rawTop, 16), window.innerHeight - CARD_H - 16),
          width: 400,
        }
      : { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 400 }

  return createPortal(
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="Portfolio tour">
      {/* THE SPOTLIGHT: the ring's shadow IS the backdrop, so the anchor keeps
          its true pixels and everything else steps back. The ring is CLAMPED
          to the viewport (16px margins, and above the phone sheet): an anchor
          taller than the screen — the hero on a phone — would otherwise throw
          its border off-screen and read as a glow with no shape; clamped, it
          frames exactly what is visible, which is the honest claim. */}
      {rect ? (
        (() => {
          const safeTop = 16
          const safeBottom = window.innerHeight - (isPhone ? 240 : 16)
          const top = Math.max(rect.top - PAD, safeTop)
          const bottom = Math.min(rect.top + rect.height + PAD, safeBottom)
          const left = Math.max(rect.left - PAD, 8)
          const right = Math.min(rect.left + rect.width + PAD, window.innerWidth - 8)
          return (
            <div
              aria-hidden
              className={`pointer-events-none fixed rounded-2xl border border-cyan/60 ${reduced ? '' : 'transition-all duration-300'}`}
              style={{
                top,
                left,
                width: Math.max(right - left, 48),
                height: Math.max(bottom - top, 48),
                boxShadow: '0 0 0 9999px rgba(4,6,12,0.72), 0 0 44px -8px rgba(53,224,255,0.5)',
              }}
            />
          )
        })()
      ) : (
        <div aria-hidden className="fixed inset-0 bg-[rgba(4,6,12,0.72)]" />
      )}

      <div style={cardStyle} className="rounded-2xl border border-white/15 bg-panel p-5 shadow-2xl">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan">
          {String(idx + 1).padStart(2, '0')} / {String(live.length).padStart(2, '0')}
        </div>
        <h3 className="mt-2 font-display text-lg font-bold uppercase tracking-[0.04em] text-ink">{beat.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">{beat.body}</p>
        <div className="mt-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2" aria-hidden>
            {live.map((b, i) => (
              <span
                key={b.key}
                className={`h-1.5 rounded-full ${i === idx ? 'w-6 bg-cyan' : 'w-1.5 bg-white/25'} ${reduced ? '' : 'transition-all duration-300'}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onExit}
              className="press rounded-lg px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
            >
              Skip
            </button>
            <button
              ref={nextRef}
              type="button"
              onClick={() => (last ? onExit() : setIdx((v) => v + 1))}
              className="spectral-btn press inline-flex h-10 items-center rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
            >
              {last ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
