import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { NetworkToggle } from './NetworkToggle'
import { WalletButton } from './WalletButton'
import { SpectrumWordmark } from './SpectrumWordmark'
import { PrismMark } from '../hud'
import { SWAP_ENABLED, TRADING_ENABLED, WALLET_ENABLED } from '../lib/config/features'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { useReferralEarned } from './ReferralCard'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'

const P = (k: Parameters<typeof pageEnabled>[1]) => pageEnabled(brand.pages, k)

// The primary set stays flat; the utility surfaces live under More (owner
// 2026-07-06 13:46: Flush + FAQ + Docs fold into a dropdown). Owner 2026-07-07
// 17:57 ("swap, launch and compose should be in the top main menu, not more"):
// the three build/trade actions are PRIMARY — and this is where the Composer
// (/compose) finally gets a nav link (it had none before). Ordered as the
// creation journey: Explore → Swap → Composer → Launch → Portfolio.
// Links are gated by the operator's brand.pages (default-on) AND, for the transactional
// surfaces, their existing VITE_ENABLE_* build flag. Ordered as the creation journey.
const links: { to: string; label: string; end?: boolean }[] = [
  ...(P('discover') ? [{ to: '/explore', label: 'Explore' }] : []),
  // Swap = buy/sell (needs a deployed router) — flag-hidden until SWAP + brand toggle.
  ...(SWAP_ENABLED && P('trade') ? [{ to: '/swap', label: 'Swap' }] : []),
  // Composer (backtest/compose) + Launch — the create flow.
  ...(P('launch') ? [{ to: '/compose', label: 'Composer' }, { to: '/launch', label: 'Launch' }] : []),
  // Portfolio = read-only holdings (needs only a connected wallet).
  ...(WALLET_ENABLED && P('portfolio') ? [{ to: '/portfolio', label: 'Portfolio' }] : []),
]
const moreLinks: { to: string; label: string }[] = [
  ...(P('creators') ? [{ to: '/creators', label: 'Creators' }] : []),
  ...(P('integrate') ? [{ to: '/integrate', label: 'Integrate' }] : []),
  ...(P('refer') ? [{ to: '/refer', label: 'Refer & earn' }] : []),
  // Flush = fee-claim, a transactional surface.
  ...(TRADING_ENABLED && P('fees') ? [{ to: '/flush', label: 'Flush' }] : []),
  ...(P('docs') ? [{ to: '/faq', label: 'FAQ' }, { to: '/docs/valuation', label: 'Docs' }] : []),
]

// The centered menu is absolutely positioned, so it can collide with the wordmark
// and wallet button. The compact info-only set fits from md; any flag-enabled
// set needs lg. Flags are build-time constants, so this is too (+1 = More).
const fullNavAt = links.length + 1 <= 3 ? 'md' : 'lg'

// ── the More dropdown ─────────────────────────────────────────────────────────
// Hover-safe by construction: the panel's gap sits INSIDE the hover area (pt-2
// inside the absolute wrapper, no dead zone) plus a short close delay, so
// moving the pointer down into the items never dismisses it (owner 13:46).
// Click also toggles, for touch + keyboards.
function MoreMenu({ links, claimBadge = 0 }: { links: { to: string; label: string }[]; claimBadge?: number }) {
  const [open, setOpen] = useState(false)
  const badgeStr = `$${claimBadge.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const closeT = useRef<number | null>(null)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname])
  const enter = () => {
    if (closeT.current) window.clearTimeout(closeT.current)
    setOpen(true)
  }
  const leave = () => {
    closeT.current = window.setTimeout(() => setOpen(false), 140)
  }
  const active = links.some((l) => pathname.startsWith(l.to))
  return (
    <div className="relative" onMouseEnter={enter} onMouseLeave={leave}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex items-center gap-1.5 px-3.5 py-1.5 font-mono text-base uppercase tracking-[0.18em] transition-colors xl:px-6 ${
          active ? 'text-cyan' : open ? 'text-ink' : 'text-ink-dim hover:text-ink'
        }`}
      >
        More
        {claimBadge > 0 && <span aria-hidden title="Referral fees to claim" className="h-1.5 w-1.5 rounded-full bg-cyan shadow-[0_0_6px_var(--color-cyan)]" />}
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-1/2 top-full z-50 -translate-x-1/2 pt-2">
          <div className="search-pop min-w-[10rem] rounded-xl border border-white/12 bg-void/95 p-1.5 shadow-2xl backdrop-blur">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  `flex items-center justify-between gap-3 rounded-lg px-3.5 py-2 font-mono text-sm uppercase tracking-[0.16em] transition-colors ${
                    isActive ? 'text-cyan' : 'text-ink-dim hover:bg-white/5 hover:text-ink'
                  }`
                }
              >
                <span>{l.label}</span>
                {l.to === '/refer' && claimBadge > 0 && (
                  <span className="rounded-full bg-cyan/15 px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal tabular-nums text-cyan">
                    {badgeStr}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function Nav() {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  const { address: account } = useAccount()
  const { data: allBaskets } = useAllBaskets()

  // A connected wallet that has DEPLOYED a basket gets "Creators" promoted to the
  // primary bar, pointed at its OWN creator dashboard (/creator/:address), and
  // dropped from More (no duplicate). Everyone else keeps "Creators" in More →
  // the /creators funnel. (owner 2026-07-07). useAllBaskets is already cached
  // app-wide, so this adds no fetch.
  const isDeployer = !!account && (allBaskets ?? []).some((b) => b.deployer?.toLowerCase() === account.toLowerCase())
  const primaryLinks = useMemo(
    () =>
      isDeployer && account && P('creators')
        ? [...links, { to: `/creator/${account}`, label: 'Creators' }]
        : links,
    [isDeployer, account],
  )
  const moreForViewer = useMemo(() => (isDeployer ? moreLinks.filter((l) => l.to !== '/creators') : moreLinks), [isDeployer])

  // Global "you have referral fees to claim" nudge (owner 2026-07-07): a dot on
  // More + the amount on Refer & earn, so unclaimed fees are discoverable from any
  // page. useReferralEarned shares react-query keys with Portfolio/refer, so this
  // adds no duplicate reads; the N basket reads are fine pre-launch (indexer at scale).
  // Gate on claimable ITEMS (per-basket accruals above the dust floor), not the raw
  // total — a total made only of sub-floor dust has nothing to actually claim
  // (audit 2026-07-07).
  const { total: refClaimable, items: refItems } = useReferralEarned()
  const claimBadge = refItems.length > 0 ? refClaimable : 0

  // Close the drawer whenever the route changes (tapping a link navigates).
  useEffect(() => setOpen(false), [pathname])

  // Close on Escape while the drawer is open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-void/70 backdrop-blur">
      <div className="relative flex items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        {/* left — logo */}
        {/* The PrismMark glyph (a light prism) is optional chrome — operators may
            keep it or drop it when rebranding the default theme. */}
        {/* On narrow phones the wordmark + network toggle + wallet button can't
            share one row, the prism glyph alone carries the brand below 520px. */}
        <Link to="/" className="flex shrink-0 items-center gap-2.5">
          <PrismMark size={24} />
          {/* wrapper span, not a class on the wordmark: .spectrum-wordmark sets
              its own display and would win the specificity fight with `hidden` */}
          <span className="hidden min-[520px]:block">
            <SpectrumWordmark className="text-lg tracking-[0.3em]" />
          </span>
        </Link>

        {/* center — menu (desktop). Roomier from xl only: at lg the absolutely-
            centered menu sits close to the wordmark/wallet (the old collision
            defect), so the extra padding/gap waits for the headroom. */}
        <nav className={`absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 xl:gap-2.5 ${fullNavAt === 'md' ? 'md:flex' : 'lg:flex'}`}>
          {primaryLinks.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `px-3.5 py-1.5 font-mono text-base uppercase tracking-[0.18em] transition-colors xl:px-6 ${
                  isActive ? 'text-cyan' : 'text-ink-dim hover:text-ink'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
          <MoreMenu links={moreForViewer} claimBadge={claimBadge} />
        </nav>

        {/* right — network + wallet + mobile menu toggle */}
        <div className="flex items-center gap-2">
          <NetworkToggle />
          {WALLET_ENABLED && <WalletButton />}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="mobile-nav"
            className={`press relative grid h-10 w-10 place-items-center rounded-lg border border-white/12 text-ink-dim hover:border-white/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/70 ${fullNavAt === 'md' ? 'md:hidden' : 'lg:hidden'}`}
          >
            {/* Cross-fade the two glyphs (scale·opacity·blur) instead of hard-swapping
                paths, so the toggle reads as one icon morphing rather than a jump. */}
            <svg
              viewBox="0 0 24 24" aria-hidden
              className={`absolute h-5 w-5 transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${open ? 'scale-100 opacity-100 blur-0' : 'scale-[0.25] opacity-0 blur-[4px]'}`}
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
            <svg
              viewBox="0 0 24 24" aria-hidden
              className={`absolute h-5 w-5 transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${open ? 'scale-[0.25] opacity-0 blur-[4px]' : 'scale-100 opacity-100 blur-0'}`}
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* mobile drawer — the More set rides flat here, no nested menu */}
      {open && (
        <nav id="mobile-nav" className={`search-pop border-t border-line bg-void/95 px-3 py-2 backdrop-blur ${fullNavAt === 'md' ? 'md:hidden' : 'lg:hidden'}`}>
          {[...primaryLinks, ...moreForViewer].map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                `press flex items-center justify-between gap-3 rounded-lg px-3 py-3 font-mono text-sm uppercase tracking-[0.18em] ${
                  isActive ? 'text-cyan' : 'text-ink-dim hover:bg-white/5 hover:text-ink'
                }`
              }
            >
              <span>{l.label}</span>
              {l.to === '/refer' && claimBadge > 0 && (
                <span className="rounded-full bg-cyan/15 px-1.5 py-0.5 font-mono text-[9px] normal-case tracking-normal tabular-nums text-cyan">
                  ${refClaimable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  )
}
