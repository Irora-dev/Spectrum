import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Nav, fullNavAt } from './Nav'
import { MobileTabBar } from './MobileTabBar'
import { OperatorBanner } from './OperatorBanner'
import { ReferredBanner } from './ReferredBanner'
import { PrismClaimBanner } from './PrismClaimBanner'
import brand from '../brand.config'
import { ATTRIBUTION_TEXT, pageEnabled, setupStudioEnabled, type PageKey } from '../theme/brand'

// `page` ties a footer link to a brand.pages toggle (default-on); legal links have none.
const ALL_FOOTER_LINKS: { to: string; label: string; page?: PageKey }[] = [
  { to: '/learn', label: 'Learn', page: 'docs' },
  { to: '/faq', label: 'FAQ', page: 'docs' },
  { to: '/docs/valuation', label: 'Docs', page: 'docs' },
  { to: '/integrate', label: 'Integrate', page: 'integrate' },
  { to: '/earn', label: 'Earn', page: 'refer' },
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
  // Root bottom padding clears the fixed mobile tab bar (h-14 + safe area)
  // below the breakpoint where the full top menu takes over.
  const barPad =
    fullNavAt === 'md'
      ? 'pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0'
      : 'pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0'
  return (
    <div className={`relative flex min-h-full flex-col overflow-x-clip ${barPad}`}>
      {/* decorative left rail */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-2 top-1/2 hidden -translate-y-1/2 rotate-180 font-mono text-[10px] uppercase tracking-[0.4em] text-ink-faint/60 [writing-mode:vertical-rl] xl:block"
      >
        capture · launch · settle
      </div>

      <Nav />
      {/* the operator's on-chain announcement, when one is live (no backend) */}
      <OperatorBanner />
      <ReferredBanner />
      {/* only ever renders for the 1,203 snapshot wallets, unclaimed + connected */}
      <PrismClaimBanner />

      {/* max-w-[1000px] (was 6xl): the centre column stays clear of the
          foregrounded spectrum bands (R 2026-07-30). Gutters respect the
          landscape notch (viewport-fit=cover exposes the sensor housing;
          audit L) — max() keeps the 16/24px design gutters everywhere else. */}
      <main className="mx-auto w-full max-w-[1000px] flex-1 px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] py-8 sm:px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))]">
        {children}
      </main>

      <footer className="border-t border-line">
        {/* 1000px like the main column (audit): at 6xl the footer text sat
            inside the foregrounded band lanes and off-grid with the content */}
        <div className="mx-auto flex max-w-[1000px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
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
          {/* PRISM's ecosystem credit lives in the PoweredByPrism banner on a few pages
              (Home / basket / fees / swap — owner 2026-07-30), not in the footer tagline.
              The PrismMark glyph in Nav is the site's own brand glyph. The kit attribution
              above is the required "powered by" line. */}
        </div>
        {/* Placeholder site-wide disclaimer. The negative-disclaimer use of
            "investment" below is deliberate (it disclaims), keep the disclaimer form. */}
        <div className="mx-auto max-w-[1000px] border-t border-line/60 px-4 py-3 sm:px-6">
          <p className="max-w-4xl font-mono text-[10px] leading-relaxed tracking-[0.05em] text-ink-faint/75">
            Informational only. Not an offer, solicitation, or financial, investment, legal, or tax advice.
            Spectrum is software provided without warranty. Basket tokens are created and issued by their
            respective deployers, who are solely responsible for their own use of it. Verify on-chain yourself.
            Onchain assets carry risk, including total loss of value.
          </p>
        </div>
      </footer>

      {/* the mobile-first primary navigation (owner 2026-07-30) — fixed bottom
          tab bar, hidden once the full top menu appears */}
      <MobileTabBar />
    </div>
  )
}
