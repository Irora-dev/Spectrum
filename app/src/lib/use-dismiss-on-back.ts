import { useEffect, useRef } from 'react'

// ── the back gesture closes the overlay ──────────────────────────────────────
// QOL round 2026-08-05 #7: "the browser back button doesn't close modals; on
// mobile that's the instinct, and it currently navigates away from the page
// entirely." So while an overlay is open it parks one history entry of its own,
// and the back gesture pops that entry instead of the page.
//
// The traps this has to survive, in the order they bite:
//  1. A LINK INSIDE the overlay must still navigate. On close we rewind only
//     when our own entry is still the one we are standing on; after the router
//     has pushed a route it is not, so we leave the stack alone rather than
//     undoing the navigation the user just asked for.
//  2. Closing by any other route (Escape, the backdrop, picking something) must
//     not leave a dead entry behind — the same check drives a history.back()
//     when the entry IS still ours.
//  3. That back() fires a popstate of its own. Swallowing exactly one keeps our
//     cleanup from reading as a gesture and closing an overlay underneath, and
//     it is what makes React StrictMode's dev double-mount (push, clean up,
//     push again) harmless.
// Overlays stack safely because each stamps its entry with its own id: on a pop,
// the instance whose id is no longer current is the one that closes.
//
// Everything above the hook is pure and window-free on purpose — it is where the
// decisions live, so it can be unit-tested in this repo's node test env.

/** The key we stamp into history state. */
const MARKER = 'spectrumOverlay'

/** Random per page load: history state SURVIVES a reload, so a bare counter
 *  could reopen the page standing on an entry already stamped "1" and mistake
 *  it for one of ours. */
const SESSION = Math.random().toString(36).slice(2, 8)
let seq = 0

export function nextMarkerId(): string {
  seq += 1
  return `${SESSION}-${seq}`
}

/** Our marker stamped onto whatever the router already put there: react-router
 *  reads `idx`/`key` off history state to work out how far a pop travelled, so
 *  replacing its state would leave its own navigation maths an entry out. */
export function markerState(prev: unknown, id: string): Record<string, unknown> {
  const base = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {}
  return { ...base, [MARKER]: id }
}

/** True when the entry we are standing on is the one this overlay pushed. One
 *  predicate answers both questions: after a pop, "is my entry gone, so should I
 *  close?" (it is not current), and on close, "is my entry still here, so should
 *  I rewind it?" (it is). */
export function isMarkerCurrent(state: unknown, id: string): boolean {
  return !!state && typeof state === 'object' && (state as Record<string, unknown>)[MARKER] === id
}

/** A history.back() WE called leaves a popstate behind that is not a gesture.
 *  Held as a moment rather than a counter so a pop that never arrives cannot
 *  leave the guard armed forever and swallow a real back gesture later. */
const SELF_POP_WINDOW_MS = 500
let selfBackAt = 0

export function noteSelfBack(now: number = Date.now()): void {
  selfBackAt = now
}

export function isSelfPop(now: number = Date.now()): boolean {
  if (selfBackAt === 0) return false
  const fresh = now - selfBackAt <= SELF_POP_WINDOW_MS
  selfBackAt = 0 // single shot either way, so a stale note clears itself
  return fresh
}

/**
 * Dismiss an open overlay on the browser back gesture.
 *
 * @param open      whether the overlay is showing; while false this does nothing at all.
 * @param onDismiss close the overlay (the same thing Escape does).
 */
export function useDismissOnBack(open: boolean, onDismiss: () => void): void {
  // onDismiss is nearly always an inline arrow, so it must not be a dependency:
  // re-running the effect would rewind and re-push the entry on every render.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    if (!open) return
    const id = nextMarkerId()
    try {
      window.history.pushState(markerState(window.history.state, id), '')
    } catch {
      // Safari rate-limits pushState. With no entry parked there is nothing to
      // pop, so stand down entirely rather than half-arm the listener.
      return
    }
    // One push per open, and the flag that says whether an entry is still ours
    // to clean up.
    let parked = true

    const onPop = () => {
      if (isSelfPop()) return
      if (!parked || isMarkerCurrent(window.history.state, id)) return
      parked = false // the browser has already taken our entry off the stack
      dismiss.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (!parked || !isMarkerCurrent(window.history.state, id)) return
      noteSelfBack()
      window.history.back()
    }
  }, [open])
}
