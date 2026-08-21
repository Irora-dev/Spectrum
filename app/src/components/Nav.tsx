import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import { NetworkToggle } from './NetworkToggle'
import { WalletButton } from './WalletButton'
import { SpectrumWordmark } from './SpectrumWordmark'
import { PrismMark } from '../hud'
import modeSun from '../assets/theme/mode-sun.webp'
import modeMoon from '../assets/theme/mode-moon.webp'
import { SWAP_ENABLED, TRADING_ENABLED, WALLET_ENABLED } from '../lib/config/features'
import { useReferralEarned } from './ReferralCard'
import { useAccount } from 'wagmi'
import { setViewerDesignMode, viewerDesignMode, type ViewerDesignMode } from '../theme/design-mode'
import { useHandleRegistry } from '../lib/spectrum/use-handles'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { useBookTotal } from '../lib/spectrum/use-book-total'
import { formatUsdCompact } from '../lib/spectrum/format'
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
  // PORTFOLIO LEADS (owner 2026-08-02, "connect it all together in a flow that
  // makes sense"). The site's story is MANAGE first, publish second: the
  // portfolio is the daily habit and the thing a person boots up, and
  // publishing a basket is what they graduate into from inside it. Holdings,
  // PnL, earnings and claims already live here, which is what let /earn leave
  // the bar; leading with it is what makes the rest of the site read as one
  // flow rather than three products sharing a header.
  // CHAT LEADS (owner 2026-08-19 22:4x: "chat on top menu should be first") —
  // the agent surface is the front door now.
  ...(P('trade') ? [{ to: '/chat', label: 'Chat' }] : []),
  ...(WALLET_ENABLED && P('portfolio') ? [{ to: '/portfolio', label: 'Portfolio' }] : []),
  // LABEL is "Baskets" (owner 2026-08-02): the nav should name the THING, not
  // the verb. The /explore ROUTE is deliberately unchanged, so every existing
  // link, redirect, share URL and OG card keeps working.
  ...(P('discover') ? [{ to: '/explore', label: 'Baskets' }] : []),
  // SWAP RETURNS to the bar (owner 2106 #14: "a one-to-one swap is not a bad
  // thing" — and the future idea, captured in the ledger: the swap page later
  // interfaces the portfolio/basket systems). Was demoted to More on 08-01.
  ...(SWAP_ENABLED && P('trade') ? [{ to: '/swap', label: 'Swap' }] : []),
  // LEARN takes the third slot that CREATE used to hold. Creation is an ACTION
  // reached from inside the portfolio ("Publish") and from Explore's empty
  // state — not a destination competing with them. Before this, the bar
  // advertised TWO different builders (this entry pointed at /launch while the
  // newer two-door flow lives at /create), which is the exact confusion the
  // owner asked to remove. Nothing is deleted: /launch and /create keep their
  // routes, their page keys and their More entries.
  ...(P('docs') ? [{ to: '/learn', label: 'Learn' }] : []),
]
// EVERYTHING ELSE MOVES BEHIND "MORE" (owner 2026-08-01: "so many pages, so
// many systems — it's very hard for the average person"). The site offered 13
// destinations before a visitor had done anything; the primary bar is now 3.
//
// Nothing is deleted and no page key changed — these are all still one click
// away, and an operator who wants a surface promoted edits this list. The order
// is roughly how often a real person needs them.
// MORE, SPLIT IN TWO — progressive disclosure (owner 2026-08-01: the nav went
// from 13 destinations to 3, but More still held ten, so the SITE was still ten
// systems, just hidden in a drawer).
//
// VISITOR entries are what anyone might want. CREATOR entries only appear once
// the connected wallet has actually launched something — the site is three items
// for a newcomer and grows into the rest as you become someone who needs them.
// Nothing is removed and no page key changed: every route stays reachable, and
// an operator who wants a surface promoted edits this list.
export const moreVisitorLinks: { to: string; label: string }[] = [
  // Swap PROMOTED to the primary bar (2106 #14) — no duplicate entry here.
  // THE CREATE DOOR (owner 1826: "put into the More, so you have create there
  // as well"). First in the list: for the visitor this menu serves, making a
  // basket outranks integrating one. Gated by the page's OWN key, never a
  // separate one — a menu entry must not outlive its page. Since the
  // 2026-08-12 route ruling ("/launch replaced with /create") /create IS the
  // real creation surface riding the `launch` key, so the entry rides it too
  // (CREATE_FLOW now gates only the simulated /manager engine).
  // "or bundle" rides the label since the condensation (the owner 2026-08-11:
  // /create is the default for creating a basket AND bundle) — the menu is
  // where a creator learns the door exists, so the door says what it makes.
  ...(P('launch') ? [{ to: '/create', label: 'Create a basket or bundle' }] : []),
  // the creators DISCOVERY page — browse the people, not the baskets (owner
  // 2026-08-21: in the dropdown, not the top bar). Rides the same 'discover'
  // gate as /explore; a visitor link, always visible.
  ...(P('discover') ? [{ to: '/creators/explore', label: 'Creators' }] : []),
  ...(P('integrate') ? [{ to: '/integrate', label: 'Integrate' }] : []),
  // The one GENERAL fee surface (owner 2026-08-01, relayed by R: "maybe we still
  // should have a general fee page with flush but reworded in the menu"). The
  // route stays /flush — it is deep-linked from the holdings cards and the docs —
  // but "Flush" is crank jargon, and the menu is read by people who just want
  // their fees.
  ...(TRADING_ENABLED && P('fees') ? [{ to: '/flush', label: 'Fees' }] : []),
  // The PRISM v2 community-airdrop claim tool (owner 2026-07-30: linked here).
  ...(P('claim') ? [{ to: '/claim', label: 'PRISM claim' }] : []),
  // Learn's duplicate REMOVED (2106 #14) — it lives on the primary bar only.
]

/** Shown only once the wallet has launched a basket — these mean nothing before that. */
export const moreCreatorLinks: { to: string; label: string }[] = [
  ...(P('refer') ? [{ to: '/earn', label: 'Earn' }] : []),
  ...(P('league') && LEAGUE_ANYWHERE ? [{ to: '/league', label: 'League' }] : []),
  // The Composer's separate menu row FOLDED into the visitor list's one create
  // door (2026-08-12: /create IS the composer face — two rows to one surface
  // read as two products; /compose stays routed for old links).
  ...(P('bundle') ? [{ to: '/bundle', label: 'Bundles' }] : []),
  ...(P('creators') ? [{ to: '/creators', label: 'For creators' }] : []),
]

/** Every entry, regardless of viewer — for anything that must enumerate them all. */
export const moreLinks: { to: string; label: string }[] = [...moreVisitorLinks, ...moreCreatorLinks]

/** THE viewer-aware More set. Exported as a hook because the desktop dropdown and
 *  the mobile sheet must never disagree about what exists — that divergence is
 *  exactly what the hand-kept TAB_ROUTES mirror got dinged for in the shell audit.
 *  Costs nothing: useAllBaskets is already in flight for the fee badge, same query
 *  key, and BasketSummary already carries the on-chain deployer. */
export function useMoreLinks() {
  const { address } = useAccount()
  const { data: allBaskets } = useAllBaskets()
  const isCreator = useMemo(() => {
    const me = address?.toLowerCase()
    return !!me && (allBaskets ?? []).some((b) => b.deployer?.toLowerCase() === me)
  }, [allBaskets, address])
  return useMemo(
    () =>
      // the profile door from the mall (owner 2026-08-15 11:43: "I also need
      // to be able to get to it from the main menu from the mall") — dynamic,
      // because the public page is /creator/<this wallet>
      isCreator && address
        ? [...moreVisitorLinks, ...moreCreatorLinks, { to: `/creator/${address}`, label: 'Your creator profile' }]
        : moreVisitorLinks,
    [isCreator, address],
  )
}


// The centered menu is absolutely positioned, so it can collide with the wordmark
// and wallet button. The compact info-only set fits from md; any flag-enabled
// set needs lg. Flags are build-time constants, so this is too (+1 = More).
export const fullNavAt = links.length + 1 <= 3 ? 'md' : 'lg'

// ── the design-mode toggle (owner 2026-08-17: "main menu top right… just a
// light icon and dark icon on the toggle, the one that's on has colour").
// Icon-only: moon = the spectral dark default, sun = the enterprise light
// plane. The switch owns no theming — setViewerDesignMode re-applies the whole
// brand through the style seam, which is what makes it a DESIGN change, not a
// palette swap. ─────────────────────────────────────────────────────────────
function DesignModeToggle() {
  const [mode, setMode] = useState<ViewerDesignMode>(() => viewerDesignMode())
  const light = mode === 'enterprise'
  // THE WAVE (owner 2026-08-19): the new design floods out from the press as
  // an expanding circle — View Transition API, clip-path on the new snapshot.
  // No support (Firefox) or reduced motion = the instant switch, unchanged.
  const flip = (e: React.MouseEvent<HTMLButtonElement>) => {
    const next: ViewerDesignMode = light ? 'default' : 'enterprise'
    const apply = () => {
      setViewerDesignMode(next, brand)
      setMode(next)
    }
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } }
    if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      apply()
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const maxR = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
    const vt = doc.startViewTransition(apply)
    void vt.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`] },
        { duration: 650, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
      )
    })
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={light}
      aria-label={light ? 'Switch to the dark design' : 'Switch to the light design'}
      onClick={flip}
      className="press flex h-9 shrink-0 items-center gap-1 rounded-full border border-white/12 bg-white/5 px-1.5 transition-colors hover:border-white/25"
    >
      {/* the owner's coin art (2026-08-19): the active plane's coin full +
          scaled, the other dimmed — same switch mechanics */}
      <span aria-hidden className={`grid h-6 w-6 place-items-center transition-all ${light ? 'scale-90 opacity-35' : 'scale-110 opacity-100'}`}>
        <img src={modeMoon} alt="" draggable={false} width={22} height={22} className="select-none" />
      </span>
      <span aria-hidden className={`grid h-6 w-6 place-items-center transition-all ${light ? 'scale-110 opacity-100' : 'scale-90 opacity-35'}`}>
        <img src={modeSun} alt="" draggable={false} width={22} height={22} className="select-none" />
      </span>
    </button>
  )
}

// ── the More dropdown ─────────────────────────────────────────────────────────
// Hover-safe by construction: the panel's gap sits INSIDE the hover area (pt-2
// inside the absolute wrapper, no dead zone) plus a short close delay, so
// moving the pointer down into the items never dismisses it (owner 13:46).
// Click also toggles, for touch + keyboards.
function MoreMenu({ links }: { links: { to: string; label: string }[] }) {
  const [open, setOpen] = useState(false)
  const closeT = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname])
  // Outside-tap + Escape, the same pair WalletButton registers a few elements
  // away. Closing was mouseleave-only, so on a touchscreen at >=lg — where the
  // mobile tab bar is hidden and this IS the menu — there was no way to dismiss
  // it except pressing More again. Never fires while closed.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const enter = () => {
    if (closeT.current) window.clearTimeout(closeT.current)
    setOpen(true)
  }
  const leave = () => {
    closeT.current = window.setTimeout(() => setOpen(false), 140)
  }
  const active = links.some((l) => pathname.startsWith(l.to))
  return (
    <div ref={rootRef} className="relative" onMouseEnter={enter} onMouseLeave={leave}>
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
                  /* nowrap: a dropdown entry is a label, and the panel sizes to
                     its longest one — "Create a basket" folding to two lines in
                     a one-line menu read as a mistake (1826 review shot) */
                  `flex items-center justify-between gap-3 whitespace-nowrap rounded-lg px-3.5 py-2 font-mono text-sm uppercase tracking-[0.16em] transition-colors ${
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

// ── the live book total on the Portfolio entry ────────────────────────────────
// QOL round 2026-08-05, item 2: "there is no way back to your book from
// anywhere except the nav — once you are deep in a basket page or the swap
// console, 'how much do I hold overall' means finding the nav." WHY it lands
// here: the header is the one surface every page keeps, so the Portfolio entry
// stops being only a signpost and becomes the readout. Your book should be
// reachable AND legible from anywhere, without a trip to the page to read one
// number.
//
// SAME GATE AS THE DESTINATION (BOOK_TOTAL_ENABLED) and mounted only for a
// connected wallet — never a readout for a page this operator turned off, and
// never a dead affordance. Every read lives inside this child for that reason:
// a visitor who has not connected pays for nothing.
//
// HONEST OR ABSENT: nothing renders until something priced actually came back.
// A first read in flight is a small pulse; a failed or unpriced read is nothing
// at all. Never $0, which in a header reads as "your book is empty".
//
// FROM XL ONLY: the centered menu is absolutely positioned, and at lg it
// already sits close to the wordmark and the wallet button (the collision
// defect noted at fullNavAt above), so this waits for the same headroom the
// roomier padding waits for. Phones never see it either: the desktop menu is
// hidden there and the fixed bottom tab bar is the primary navigation, which
// keeps its own Portfolio tab. Width is bounded on purpose — the readout hides
// when the claim badge is showing, so the entry carries at most one number and
// never grows wider than it already can today.
const BOOK_TOTAL_ENABLED = WALLET_ENABLED && P('portfolio')

function PortfolioTotal({ address }: { address: string }) {
  const { usd, isLoading, wallets } = useBookTotal(address)
  if (usd == null)
    return isLoading ? (
      <span
        className="ml-2 hidden h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint align-middle xl:inline-block"
        role="status"
        aria-label="Reading your book"
      />
    ) : null
  return (
    <span
      className="ml-2 hidden font-num text-[11px] tabular-nums text-ink-faint xl:inline"
      title={
        wallets > 1
          ? `Your book across ${wallets} linked wallets, everything we can price right now`
          : 'Your book, everything we can price right now'
      }
    >
      {formatUsdCompact(usd)}
    </span>
  )
}

export function Nav() {
  // The burger + inline drawer are GONE (owner 2026-07-30 mobile system): on
  // phones the fixed bottom tab bar (MobileTabBar, mounted by Layout) is the
  // primary navigation; this header keeps brand + network + wallet only.

  // Global "you have fees to claim" nudge (owner 2026-07-07): the claimable
  // amount rides the Yours tab, so unclaimed fees are discoverable from any
  // page. (The "dot on More" the original note describes has no code behind it
  // — MoreMenu takes links only — so the badge is the whole mechanism.)
  // useReferralEarned shares react-query keys with Portfolio/refer, so this
  // adds no duplicate reads; the N basket reads are fine pre-launch (indexer at
  // scale). The badge promises "claimable", so it carries claimableTotal —
  // pots still under a chain's crank floor (F-1) accrue but can't flush, and
  // a badge made of them would advertise a claim that no-ops.
  const { claimableTotal: refClaimable } = useReferralEarned()
  const claimBadge = refClaimable

  // The creator's single home is Portfolio (owner 2026-07-29: portfolio and
  // creator page are one merged unit for an actual creator) — the old promoted
  // per-wallet "Creators" entry is retired.
  //
  // The badge rides YOURS, not Earn. It used to target '/earn', which was a
  // primary tab; when the nav collapsed to three, /earn moved behind More and
  // this map stopped matching anything — so a wallet with claimable fees got
  // NO signal anywhere in the chrome, while we kept paying for the reads that
  // computed it. Yours is the right home for it anyway: it is where holdings,
  // PnL and claims live, so the number points at the page that can act on it.
  // ⚠ A CLAIMED NAME PROMOTES THE PROFILE OUT OF THE DROPDOWN (the owner,
  // 2026-08-16: "once the person has created a creator profile and signed a
  // link the 'your creator profile' should go from the drop down menu to the
  // top menu as 'profile' to the right of portfolio").
  //
  // Keyed on the NAME, not on having deployed: a wallet-address profile is a
  // page you tolerate, whereas a claimed name is one you send people to, and
  // only the second earns a permanent seat in the chrome. Everyone else keeps
  // the dropdown entry exactly as before, so the nav does not grow for people
  // who have not asked it to.
  // the viewer's own claimed name, if any (the registry is already fetched for
  // handle resolution elsewhere, so this rides the same cached query)
  const { address: navAddress } = useAccount()
  const { data: handleReg } = useHandleRegistry()
  const myHandle =
    handleReg?.status === 'ok' && navAddress ? (handleReg.map.byAddress.get(navAddress.toLowerCase())?.handle ?? null) : null
  const primaryLinks = useMemo(() => {
    const withBadge =
      claimBadge > 0
        ? links.map((l) => (l.to === '/portfolio' ? { ...l, badge: `$${refClaimable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` } : l))
        : links
    if (!myHandle) return withBadge
    const at = withBadge.findIndex((l) => l.to === '/portfolio')
    const profile: (typeof links)[number] = { to: `/creator/${myHandle}`, label: 'Profile' }
    // immediately to the RIGHT of Portfolio; appended if Portfolio is absent
    return at < 0 ? [...withBadge, profile] : [...withBadge.slice(0, at + 1), profile, ...withBadge.slice(at + 1)]
  }, [claimBadge, refClaimable, myHandle])
  // Creator surfaces appear only once this wallet has actually launched
  // something — before that they are five destinations that mean nothing to the
  // person reading them. Shared with the mobile sheet via the hook.
  const moreForViewer = useMoreLinks()

  // The book readout's one condition: a connected wallet, on a build where the
  // Portfolio page exists. Undefined keeps PortfolioTotal unmounted, so its
  // reads never start for a visitor who has not connected.
  const { address, isConnected } = useAccount()
  const bookAddress = BOOK_TOTAL_ENABLED && isConnected && address ? address : undefined

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
        {/* the wordmark's LINK was 24px tall (mobile audit 2026-08-05); the
            mark itself is unchanged, the target now clears a thumb */}
        <Link to="/" className="flex min-h-[36px] shrink-0 items-center gap-2.5">
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
              {/* ONE NUMBER AT A TIME: two dollar figures on one nav entry is a
                  coin toss for whoever reads it, and the claim badge is the one
                  that needs an action, so it wins the slot while it is showing.
                  The readout returns the moment the fees are claimed. */}
              {l.to === '/portfolio' && !l.badge && bookAddress && <PortfolioTotal address={bookAddress} />}
            </NavLink>
          ))}
          <MoreMenu links={moreForViewer} />
        </nav>

        {/* right — network + wallet (mobile primary nav = the bottom tab bar) */}
        <div className="flex items-center gap-2">
          <DesignModeToggle />
          <NetworkToggle />
          {WALLET_ENABLED && <WalletButton />}
        </div>
      </div>
    </header>
  )
}
