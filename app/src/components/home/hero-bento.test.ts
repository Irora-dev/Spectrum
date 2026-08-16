import { describe, expect, it } from 'vitest'
import {
  HERO_BENTO_ASPECT,
  HERO_BENTO_BREAKOUT,
  HERO_BENTO_CONTAINER_CLASS,
  HERO_BENTO_OVERLAP_CLASS,
  HERO_BENTO_OVERLAP_PCT,
  HERO_BENTO_RESERVE_CLASS,
} from './Showcase'

// The bento rides up over the hero boundary BY EXACTLY HALF ITS OWN HEIGHT
// (owner 1826: "halfway over the hero and halfway over the next section" —
// re-instating his original ask). This spec broke once before: when the hero
// shrank, a half-height pull reached past the art and overlapped the headline
// and CTAs, and the pull spent three days as a modest 2.5% crossing.
//
// What this file pins is the PAIR that makes half-height safe structurally:
// the pull is half the panel's height, AND the hero reserves at least the
// worst-case pull as its own bottom padding, derived from the same constants.
// If either side drifts — someone widens the breakout, changes the aspect, or
// shaves the reserve — a pin fails before the copy is reachable again.
describe('hero bento: half over the hero, and the hero reserves the room', () => {
  it('the overlap class matches the constant, so the two cannot drift apart', () => {
    // Tailwind resolves class names at BUILD time and cannot see a computed string,
    // so the class carries a literal. This is the guard on that duplication.
    const found = HERO_BENTO_OVERLAP_CLASS.match(/-([\d.]+)%/)
    expect(found, `no percentage in "${HERO_BENTO_OVERLAP_CLASS}"`).toBeTruthy()
    expect(Number(found![1])).toBeCloseTo(HERO_BENTO_OVERLAP_PCT, 2)
  })

  it('is NEGATIVE, or it would push the panel down instead of pulling it up', () => {
    expect(HERO_BENTO_OVERLAP_CLASS).toMatch(/margin-top:-/)
  })

  // THE SPEC ITSELF. The margin applies inside the panel's own width container,
  // so half the panel's height is 100/(2×aspect) percent of that width — exact
  // at every viewport, no magic pixels.
  it('pulls up by exactly half the panel height', () => {
    expect(HERO_BENTO_OVERLAP_PCT).toBeCloseTo(100 / (2 * HERO_BENTO_ASPECT), 1)
  })

  // THE REGRESSION GUARD, the structural half. The reserve is a percentage of
  // the page container C; the panel is at most BREAKOUT × C wide, so the pull
  // is at most BREAKOUT × (overlap% of panel width) of C. The hero must
  // reserve at least that worst case, or a wide viewport reaches the copy.
  it('the hero reserves at least the worst-case pull', () => {
    const reserve = HERO_BENTO_RESERVE_CLASS.match(/pb-\[([\d.]+)%\]/)
    expect(reserve, `no percentage in "${HERO_BENTO_RESERVE_CLASS}"`).toBeTruthy()
    const worstCasePctOfContainer = (HERO_BENTO_BREAKOUT * 100) / (2 * HERO_BENTO_ASPECT)
    expect(Number(reserve![1])).toBeGreaterThanOrEqual(worstCasePctOfContainer - 0.01)
  })

  it('the breakout constant matches the literal in the container class', () => {
    const found = HERO_BENTO_CONTAINER_CLASS.match(/min\((\d+)%/)
    expect(found, `no breakout percentage in "${HERO_BENTO_CONTAINER_CLASS}"`).toBeTruthy()
    expect(Number(found![1])).toBeCloseTo(HERO_BENTO_BREAKOUT * 100, 2)
  })

  // lg-only, BOTH sides: a large negative pull on a phone drags the panel over
  // the CTAs (the fixed-pull-under-an-svh-hero mistake this codebase has already
  // made) — and a reserve without its pull, or a pull without its reserve, is
  // the collision this file exists to prevent.
  it('the pull and the reserve apply from the same breakpoint', () => {
    expect(HERO_BENTO_OVERLAP_CLASS.startsWith('lg:')).toBe(true)
    expect(HERO_BENTO_RESERVE_CLASS.startsWith('lg:')).toBe(true)
  })

  it('is a WIDE aspect, since a tall hero object would swallow the fold', () => {
    expect(HERO_BENTO_ASPECT).toBeGreaterThan(1.8)
  })
})
