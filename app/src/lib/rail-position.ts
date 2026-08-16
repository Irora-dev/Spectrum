// ─────────────────────────────────────────────────────────────────────────────
// WHICH ITEM A SCROLL RAIL IS PARKED ON — the one piece of the carousel that is
// arithmetic rather than layout, kept here so it can be tested in a node env
// (the app's vitest run has no DOM).
//
// It takes the per-item visible FRACTIONS an IntersectionObserver already
// reports, never a scrollLeft. Scroll-event math has to know item widths, gaps,
// padding and the snap alignment to answer the same question, and it is wrong
// on the first and last item of a snapped rail (they cannot reach the centre),
// under rubber-banding, and at any zoom level. The observer measures what is
// actually on screen, so this is a plain argmax over its numbers.
// ─────────────────────────────────────────────────────────────────────────────

/** Ratios within this of the leader count as the same — see `activeFromRatios`. */
const TIE = 0.02

/**
 * The index of the item a rail is showing, given each item's visible fraction
 * (0 = off the rail, 1 = fully on it) in DOM order.
 *
 * Near-ties resolve to the EARLIER item. Two items can be equally visible
 * mid-swipe, and a rail is read left to right, so the reader's position is the
 * first of them; without the tolerance the indicator flickers one step ahead
 * and back on every drag. Empty input is index 0, which is what an empty rail
 * shows.
 */
export function activeFromRatios(ratios: readonly number[]): number {
  let best = 0
  let bestRatio = -1
  for (let i = 0; i < ratios.length; i++) {
    const r = ratios[i] ?? 0
    if (r > bestRatio + TIE) {
      bestRatio = r
      best = i
    }
  }
  return best
}
