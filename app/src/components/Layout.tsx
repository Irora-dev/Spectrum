import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Nav } from './Nav'
import { ReferredBanner } from './ReferredBanner'
import brand from '../brand.config'
import { ATTRIBUTION_TEXT, pageEnabled, setupStudioEnabled, type PageKey } from '../theme/brand'

// `page` ties a footer link to a brand.pages toggle (default-on); legal links have none.
const ALL_FOOTER_LINKS: { to: string; label: string; page?: PageKey }[] = [
  { to: '/learn', label: 'Learn', page: 'docs' },
  { to: '/faq', label: 'FAQ', page: 'docs' },
  { to: '/docs/valuation', label: 'Docs', page: 'docs' },
  { to: '/integrate', label: 'Integrate', page: 'integrate' },
  { to: '/refer', label: 'Refer', page: 'refer' },
  { to: '/terms', label: 'Terms' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/risk', label: 'Risk' },
  { to: '/verify', label: 'Verify contracts' },
  { to: '/setup', label: 'Customize' },
]
const FOOTER_LINKS = ALL_FOOTER_LINKS.filter((l) =>
  l.to === '/setup' ? setupStudioEnabled(brand) : !l.page || pageEnabled(brand.pages, l.page),
)

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  // /embed renders inside third-party iframes — chrome-less by design
  if (pathname.startsWith('/embed')) return <>{children}</>
  return (
    <div className="relative flex min-h-full flex-col overflow-x-clip">
      {/* decorative left rail */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-2 top-1/2 hidden -translate-y-1/2 rotate-180 font-mono text-[10px] uppercase tracking-[0.4em] text-ink-faint/60 [writing-mode:vertical-rl] xl:block"
      >
        capture · launch · settle
      </div>

      <Nav />
      <ReferredBanner />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
              {brand.name} · {brand.tagline || 'onchain baskets'}
            </span>
            {/* Required kit attribution (Spectrum Mini convention) — shown on every page. */}
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint/60">
              {ATTRIBUTION_TEXT}
            </span>
          </div>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-x-5">
            {FOOTER_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint transition-colors hover:text-cyan"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          {/* PRISM stays out of the footer tagline (a fixed pool-fee share routes to its
              buy-and-burn path; it doesn't "power" baskets). The PrismMark glyph in Nav is
              the same surface. The kit attribution above is the required "powered by" line. */}
        </div>
        {/* Placeholder site-wide disclaimer. The negative-disclaimer use of
            "investment" below is deliberate (it disclaims), keep the disclaimer form. */}
        <div className="mx-auto max-w-6xl border-t border-line/60 px-4 py-3 sm:px-6">
          <p className="max-w-4xl font-mono text-[10px] leading-relaxed tracking-[0.05em] text-ink-faint/75">
            Informational only. Not an offer, solicitation, or financial, investment, legal, or tax advice.
            Spectrum is software provided without warranty. Basket tokens are created and issued by their
            respective deployers, who are solely responsible for their own use of it. Verify on-chain yourself.
            Onchain assets carry risk, including total loss of value.
          </p>
        </div>
      </footer>
    </div>
  )
}
