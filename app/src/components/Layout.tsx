import type { ReactNode } from 'react'
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Nav, fullNavAt } from './Nav'
import { MobileTabBar } from './MobileTabBar'
import { BannerCarousel } from './BannerCarousel'
import brand from '../brand.config'
import { ATTRIBUTION_TEXT, pageEnabled, setupStudioEnabled, type PageKey } from '../theme/brand'
import { isMacPlatform, requestSearchFocus } from '../lib/search-focus'
import { useHotkey } from '../lib/use-hotkey'

// `page` ties a footer link to a brand.pages toggle (default-on); legal links have none.
const ALL_FOOTER_LINKS: { to: string; label: string; page?: PageKey }[] = [
  // /faq merged into /learn; the integrator reference is the second entry, and
  // it points at the canonical /docs rather than the /docs/valuation alias.
  { to: '/learn', label: 'Learn', page: 'docs' },
  { to: '/docs', label: 'Developer docs', page: 'docs' },
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

// The shortcut's shape: Command/Control+K, and bare "/" as the second door
// (the convention every search field on the web has trained people on).
const SEARCH_KEYS = [{ key: 'k', mod: true }, { key: '/' }] as const

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [mac] = useState(() => isMacPlatform())
  // KEYBOARD SEARCH (QOL #18, owner-greenlit 2026-08-05). Mounted in the shell
  // so every route answers it. A search already on screen claims the request
  // synchronously; otherwise we travel to the Baskets page, whose search
  // consumes the standing request as it mounts. NO new search surface was
  // built: the honest minimum is opening the one the site already has.
  useHotkey(
    [...SEARCH_KEYS],
    () => {
      if (requestSearchFocus()) return
      if (pageEnabled(brand.pages, 'discover')) navigate('/explore')
    },
    mac,
  )
  // /embed renders inside third-party iframes — chrome-less by design
  if (pathname.startsWith('/embed')) return <>{children}</>
  // Root bottom padding clears the fixed mobile tab bar (h-14 + safe area)
  // below the breakpoint where the full top menu takes over.
  // `--page-dock-pad` lets a PAGE with its own fixed bottom dock raise this
  // (portfolio sets 72px while its action dock is mounted). Mobile sweep
  // 2026-08-06: the dock floats at bottom:72px, so the root's 56px tab-bar
  // clearance left it sitting ON the footer's legal text at max scroll —
  // page-level padding could never fix that, because the footer renders
  // OUTSIDE the page. Unset = 0 = byte-identical everywhere else.
  const barPad =
    fullNavAt === 'md'
      ? 'pb-[calc(var(--page-dock-pad,0px)+3.5rem+env(safe-area-inset-bottom))] md:pb-0'
      : 'pb-[calc(var(--page-dock-pad,0px)+3.5rem+env(safe-area-inset-bottom))] lg:pb-0'
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
      {/* ONE ROTATING SLOT (owner 2026-08-02: "a single rotating carousel
          banner") — supersedes the capped rail + the out-of-rail disclosure:
          the cap could shadow a message permanently; rotation gives every live
          message the slot on a cycle, the risk disclosure riding it as the one
          permanent slide. Each banner keeps its own eligibility + dismissal. */}
      <BannerCarousel />

      {/* max-w-[1000px] (was 6xl): the centre column stays clear of the
          foregrounded spectrum bands (R 2026-07-30). Gutters respect the
          landscape notch (viewport-fit=cover exposes the sensor housing;
          audit L) — max() keeps the 16/24px design gutters everywhere else. */}
      {/* THE PHONE GUTTER CLEARS THE BANDS (owner 2026-08-06 23:13, on a Pixel
          8: "everything's a little bit close to the spectrum band — it needs to
          be moved over into the center just a little bit more", and again on
          /portfolio and /explore: "use less width on mobile"). The shader
          floors its bright lanes at 18px on phones (SpectrumBackground's
          edgeScaleFor), and the gutter was 16 — content sat INSIDE the glow.
          24 everywhere now: one step on the scale, 6px of grace over the lane,
          and it matches what sm+ already used. */}
      <main className="mx-auto w-full max-w-[1000px] flex-1 px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] py-8">
        {children}
      </main>

      <footer className="border-t border-line">
        {/* 1000px like the main column (audit): at 6xl the footer text sat
            inside the foregrounded band lanes and off-grid with the content.
            TIGHTENED 2026-08-13 (the owner, on the choose station: "footer text
            could be made smaller/less text" — the station's viewport budget
            subtracts this footer, so every trimmed pixel goes to the grid):
            paddings a step down, the disclaimer compressed to its clauses. */}
        {/* CENTERED (owner 2026-08-19): the footer reads as one centered stack —
            brand line, attribution, links — instead of a left/right split. */}
        <div className="mx-auto flex max-w-[1000px] flex-col items-center gap-y-2 px-4 py-3 text-center sm:px-6">
          <div className="flex flex-col items-center gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
              {brand.name} · {brand.tagline || 'onchain baskets'}
            </span>
            {/* Required kit attribution (Spectrum Mini convention) — shown on every page. */}
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint/60">
              {ATTRIBUTION_TEXT}
            </span>
          </div>
          {/* gap-y-0 below sm: each link is its own 36px row now (mobile sweep
              2026-08-06 — nine 15px-tall targets across three wrapped lines),
              so the min-height IS the vertical rhythm and an extra gap would
              only pad an already-taller footer. */}
          <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-0 sm:gap-x-5 sm:gap-y-2">
            {FOOTER_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="inline-flex min-h-[36px] items-center font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint transition-colors hover:text-cyan sm:min-h-0"
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
            "investment" below is deliberate (it disclaims), keep the disclaimer
            form. Compressed 2026-08-13 (the owner: "smaller/less text") — every
            disclaiming CLAUSE survives; only the wording around them shrank. */}
        <div className="mx-auto max-w-[1000px] border-t border-line/60 px-4 py-2 sm:px-6">
          <p className="mx-auto max-w-4xl text-center font-mono text-[9px] leading-snug tracking-[0.05em] text-ink-faint/70">
            Informational only — not an offer, solicitation, or financial, investment, legal, or tax advice.
            Software without warranty; basket tokens are created and issued by their deployers, who are solely
            responsible for them. Onchain assets carry risk, including total loss. Verify on-chain yourself.
          </p>
        </div>
      </footer>

      {/* the mobile-first primary navigation (owner 2026-07-30) — fixed bottom
          tab bar, hidden once the full top menu appears */}
      <MobileTabBar />
    </div>
  )
}
