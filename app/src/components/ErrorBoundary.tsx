import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'

// ─────────────────────────────────────────────────────────────────────────────
// THE ROUTE-LEVEL BOUNDARY (QOL round 2026-08-05, item 12).
//
// One unexpected throw in one card used to blank the WHOLE site: React unmounts
// up to the nearest boundary, and above the routes there was none, so `#root`
// emptied. The nav, the footer and every other page went with it. That is a
// resilience gap the kit ships to OPERATORS, who cannot patch our components
// and will not be watching a console when a visitor hits it.
//
// WHY THIS IS A SECOND BOUNDARY AND NOT AN EXTENSION OF THE EXISTING ONE.
// `DecorativeBoundary` (and `HeroIntro`'s private `ShaderBoundary`) exist for a
// different contract, stated in their own headers: a decoration that fails
// renders NOTHING, because the absence of a decoration should be unremarkable.
// Silence is exactly the wrong answer for a page a visitor asked for — they
// would be left staring at empty chrome with no way to tell it had broken. So
// this one is its sibling, not its replacement: same lesson (a throw must not
// take the site down), opposite fallback (say so, and offer a way out).
//
// The fallback is deliberately PLAIN and honest. It never blames the visitor,
// never says anything about their money (a render error tells us nothing about
// what did or did not reach the chain, so any reassurance would be a guess),
// and never puts a stack trace on screen. The trace goes to the console, which
// is where the operator can actually use it.
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  children: ReactNode
  /** Any change to this clears a caught error. `RouteErrorBoundary` feeds it the
   *  location, which is what makes navigating away from a broken page a recovery. */
  resetKey?: string
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // React logs caught errors itself, buried in its own multi-line report. This
    // is the line an operator can search for: one prefix, the page it happened
    // on, and the component path that threw.
    console.error(
      `[spectrum] page failed to render (${this.props.resetKey ?? 'unknown route'}):`,
      error,
      info.componentStack,
    )
  }

  componentDidUpdate(prev: Props) {
    // RECOVERY WITHOUT A RELOAD. Clearing on a location change is what lets the
    // surviving nav do its job: click anything and the next page mounts fresh.
    //
    // The reset is a prop compare rather than `key={pathname}` on the boundary
    // itself, which was the first shape tried. A key would remount the route
    // subtree on EVERY navigation, healthy or not — and the routes that share a
    // component (/docs → /docs/valuation, /token → /t/:chain/:ref) would lose
    // their scroll position and in-page state to a boundary that never caught
    // anything. Guarding on `failed` keeps the cost at exactly zero until
    // something actually breaks.
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  render() {
    return this.state.failed ? <PageError /> : this.props.children
  }
}

/** The route-keyed boundary — what App wraps the routes in. Split from the class
 *  so the class itself stays router-free and usable around anything. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation()
  // The SEARCH is part of the key, not just the path: a malformed query param
  // (`?tokens=`, `?door=`) is a real way to make a page throw, so correcting it
  // in place has to count as a recovery too.
  return <ErrorBoundary resetKey={`${pathname}${search}`}>{children}</ErrorBoundary>
}

/** The visible fallback. Mirrors the dashed-panel idiom the pages already use
 *  for their nothing-here and could-not-load states (`Empty` in pages/Explore,
 *  `Notice` in pages/Token) so a broken page still looks like this site. Those
 *  are local to their page modules and stay that way: importing one here would
 *  pull a whole route's graph into the always-loaded shell bundle and undo the
 *  code splitting. */
function PageError() {
  return (
    <div className="py-10" role="alert">
      <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center">
        <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">
          Something went wrong on this page
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-dim">
          It could not finish loading. Reloading often clears it, and you can still use the rest of the site.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="press rounded-lg border border-cyan/40 bg-cyan/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-cyan hover:border-cyan"
          >
            Reload this page
          </button>
          {/* A router link, not an anchor: it navigates in place, which trips the
              reset above and proves the recovery path without a full reload. */}
          <Link
            to="/"
            className="press rounded-lg border border-white/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
          >
            Back to home
          </Link>
        </div>
        <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
          details are in the browser console
        </p>
      </div>
    </div>
  )
}
