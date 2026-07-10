import { Link } from 'react-router-dom'
import { PrismMark } from '../hud'

// Catch-all for unknown / stale URLs (e.g. an old shared link). Keeps people on
// the site with a clear way back instead of a blank screen.
export function NotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center px-4">
      <div className="text-center">
        <div className="mb-6 flex justify-center">
          <PrismMark size={56} />
        </div>
        {/* bespoke layout, canonical type (see PageHeader — lg tier) */}
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">Error 404</div>
        <h1 className="mt-3 font-display text-5xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-6xl">
          Lost the signal
        </h1>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-ink-dim">
          This page doesn&rsquo;t exist. It may have moved, or the link is off. Let&rsquo;s get you back to the
          spectrum.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/"
            className="rounded-lg bg-cyan px-6 py-3 font-mono text-xs font-bold uppercase tracking-[0.18em] text-void transition-transform hover:scale-[1.03] active:scale-[0.96]"
          >
            Home
          </Link>
          <Link
            to="/explore"
            className="rounded-lg border border-white/20 bg-white/[0.04] px-6 py-3 font-mono text-xs uppercase tracking-[0.18em] text-ink press hover:border-cyan hover:text-cyan"
          >
            Explore baskets →
          </Link>
        </div>
      </div>
    </div>
  )
}
