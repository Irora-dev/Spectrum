import { Component, type ReactNode } from 'react'

/**
 * A DECORATIVE subtree must never be able to take the site down.
 *
 * This exists because it already happened. `SpectrumBackground` builds a
 * three.js `WebGLRenderer`, which THROWS with "Error creating WebGL context"
 * on any client that can't give it one — a GPU-blocklisted driver, WebGL
 * switched off, a privacy browser blocking the fingerprinting surface, a
 * headless or virtualised environment. It was mounted unguarded at the app
 * root, so that throw propagated all the way up and React unmounted the entire
 * tree: `#root` left with zero children. Not a degraded background — a blank
 * site, for a decoration.
 *
 * HeroIntro already had this exact defence for its own shader ("a decorative
 * overlay must NEVER take the site down"). The lesson simply hadn't been
 * applied to the other WebGL surface. Anything decorative that touches WebGL,
 * canvas, or a heavy third-party renderer belongs inside one of these.
 *
 * Renders nothing on failure. There is deliberately no fallback UI: the point
 * of a decoration is that its absence should be unremarkable.
 */
export class DecorativeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
