import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { NetworkToggle } from './NetworkToggle'
import { WalletButton } from './WalletButton'
import { SpectrumWordmark } from './SpectrumWordmark'
import { PrismMark } from '../hud'
import { SWAP_ENABLED, TRADING_ENABLED, WALLET_ENABLED } from '../lib/config/features'
import { useReferralEarned } from './ReferralCard'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'

const P = (k: Parameters<typeof pageEnabled>[1]) => pageEnabled(brand.pages, k)
// Any scaffolded chain with a league pool → the link shows (the page itself is per-chain).
const LEAGUE_ANYWHERE = SUPPORTED_CHAIN_IDS.some((id) => !!chainCfg(id).leaguePool) || import.meta.env.DEV

// The primary set stays flat; the utility surfaces live under More (owner
// 2026-07-06 13:46: Flush + FAQ + Docs fold into a dropdown). Owner 2026-07-07
// 17:57 ("swap, launch and compose should be in the top main menu, not more"):
// the three build/trade actions are PRIMARY — and this is where the Composer
// (/compose) finally gets a nav link (it had none before). Ordered as the
// creation journey: Explore → Swap → Composer → Launch → Portfolio.
// Links are gated by the operator's brand.pages (default-on) AND, for the transactional
// surfaces, their existing VITE_ENABLE_* build flag. Ordered as the creation journey.
// Exported: the mobile bottom tab bar (MobileTabBar) renders the SAME gated
// model — one source of truth for what the operator's config enables.
export const links: { to: string; label: string; end?: boolean; badge?: string }[] = [
  ...(P('discover') ? [{ to: '/explore', label: 'Explore' }] : []),
  // Swap = buy/sell (needs a deployed router) — flag-hidden until SWAP + brand toggle.
  ...(SWAP_ENABLED && P('trade') ? [{ to: '/swap', label: 'Swap' }] : []),
  // Launch — the create flow. The Composer lives in the More menu (owner
  // 2026-07-29: it is a creator TOOL, reached from Launch, not a headline tab).
  ...(P('launch') ? [{ to: '/launch', label: 'Launch' }] : []),
  // Portfolio = read-only holdings (needs only a connected wallet).
  ...(WALLET_ENABLED && P('portfolio') ? [{ to: '/portfolio', label: 'Portfolio' }] : []),
  // League rides the PRIMARY bar (owner 2026-07-29) — only where a pool exists.
  ...(P('league') && LEAGUE_ANYWHERE ? [{ to: '/league', label: 'League' }] : []),
  // Earn is a STANDING primary tab (owner 2026-07-29: on by default); the live
  // claimable amount decorates it once anything has accrued.
  ...(P('refer') ? [{ to: '/earn', label: 'Earn' }] : []),
]
export const moreLinks: { to: string; label: string }[] = [
  ...(P('launch') ? [{ to: '/compose', label: 'Composer' }] : []),
  // Cross-chain BUNDLES (revived 2026-07-29). "Bundle" is the product name
  // (owner call); the page itself always spells out that it is several basket
  // tokens held as one allocation — never "one token".
  ...(P('bundle') ? [{ to: '/bundle', label: 'Bundles' }] : []),
  ...(P('creators') ? [{ to: '/creators', label: 'Creators' }] : []),
  ...(P('integrate') ? [{ to: '/integrate', label: 'Integrate' }] : []),
  // Flush = fee-claim, a transactional surface.
  ...(TRADING_ENABLED && P('fees') ? [{ to: '/flush', label: 'Flush' }] : []),
  // The PRISM v2 community-airdrop claim tool (owner 2026-07-30: linked here).
  ...(P('claim') ? [{ to: '/claim', label: 'PRISM claim' }] : []),
  ...(P('docs') ? [{ to: '/faq', label: 'FAQ' }, { to: '/docs/valuation', label: 'Docs' }] : []),
]

// The centered menu is absolutely positioned, so it can collide with the wordmark
// and wallet button. The compact info-only set fits from md; any flag-enabled
// set needs lg. Flags are build-time constants, so this is too (+1 = More).
export const fullNavAt = links.length + 1 <= 3 ? 'md' : 'lg'

// ── the More dropdown ─────────────────────────────────────────────────────────
// Hover-safe by construction: the panel's gap sits INSIDE the hover area (pt-2
// inside the absolute wrapper, no dead zone) plus a short close delay, so
// moving the pointer down into the items never dismisses it (owner 13:46).
// Click also toggles, for touch + keyboards.
function MoreMenu({ links }: { links: { to: string; label: string }[] }) {
  const [open, setOpen] = useState(false)
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
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function Nav() {
  // The burger + inline drawer are GONE (owner 2026-07-30 mobile system): on
  // phones the fixed bottom tab bar (MobileTabBar, mounted by Layout) is the
  // primary navigation; this header keeps brand + network + wallet only.

  // Global "you have fees to claim" nudge (owner 2026-07-07): a dot on More +
  // the amount on Earn, so unclaimed fees are discoverable from any page.
  // useReferralEarned shares react-query keys with Portfolio/refer, so this
  // adds no duplicate reads; the N basket reads are fine pre-launch (indexer at
  // scale). The badge promises "claimable", so it carries claimableTotal —
  // pots still under a chain's crank floor (F-1) accrue but can't flush, and
  // a badge made of them would advertise a claim that no-ops.
  const { claimableTotal: refClaimable } = useReferralEarned()
  const claimBadge = refClaimable

  // The creator's single home is Portfolio (owner 2026-07-29: portfolio and
  // creator page are one merged unit for an actual creator) — the old promoted
  // per-wallet "Creators" entry is retired. Earn is a standing tab; the live
  // claimable amount rides it once anything has accrued.
  const primaryLinks = useMemo(
    () =>
      claimBadge > 0
        ? links.map((l) => (l.to === '/earn' ? { ...l, badge: `$${refClaimable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` } : l))
        : links,
    [claimBadge, refClaimable],
  )
  const moreForViewer = moreLinks

  // z-50, ABOVE the z-40 foreground band canvas: the header is a stacking
  // context, so everything inside it (connect modal, account dropdown, More
  // menu, mobile drawer) paints at ITS z — at z-30 they all rendered UNDER the
  // band glow (audit). The bar still shows the bands through its own
  // backdrop-blur translucency; page modals at z-[60]+ still cover the nav.
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-void/70 backdrop-blur">
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
              {l.badge && (
                <span className="ml-1.5 font-num text-[11px] font-semibold tabular-nums text-teal">{l.badge}</span>
              )}
            </NavLink>
          ))}
          <MoreMenu links={moreForViewer} />
        </nav>

        {/* right — network + wallet (mobile primary nav = the bottom tab bar) */}
        <div className="flex items-center gap-2">
          <NetworkToggle />
          {WALLET_ENABLED && <WalletButton />}
        </div>
      </div>
    </header>
  )
}
