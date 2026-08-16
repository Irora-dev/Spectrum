import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { flushSync } from 'react-dom'
import { Link, useNavigate } from 'react-router'
import { useAccount } from 'wagmi'
import { WALLET_ENABLED } from '../../lib/config/features'
import { GUEST_SCOPE } from '../../lib/spectrum/allocation'
import { SUPPORTED_CHAIN_IDS } from '../../lib/chain/chains'
import brand from '../../brand.config'
import { pageEnabled } from '../../theme/brand'
import { useAllBaskets, usePortfolio } from '../../lib/spectrum/hooks'
import { useRawHoldings } from '../../lib/spectrum/use-raw-holdings'
import { formatUsdCompact } from '../../lib/spectrum/format'
import { basketRowsFromPortfolio, deriveFoundBook, majors } from '../../lib/spectrum/found-book'
import { flowHref } from '../../lib/spectrum/flow-link'
import { homeOnboardingSeen } from '../../lib/spectrum/home-onboarding-seen'
import { seedDraftFromHoldings } from '../../lib/spectrum/seed-from-holdings'
import { withViewTransition } from '../../lib/spectrum/view-transition'
import { useWalletGroup } from '../../lib/spectrum/use-wallet-group'
import { useCountUp, usePrefersReducedMotion } from '../../lib/motion'
import { GhostBook } from './GhostBook'
import { LinkedWallets, WalletDot } from './LinkedWallets'
import { AssetLogo } from '../AssetLogo'
import { FoundBook, inBook } from './FoundBook'
import { ChainBadge } from '../ChainBadge'
import { SpectrumWordmark } from '../SpectrumWordmark'
import { WalletButton } from '../WalletButton'
import { EASE, SPECTRAL } from '../home/Spine'
import { IntroArt } from '../home/IntroArt'

// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO FIRST-OPEN (owner 2026-08-03: "an introduction / onboarding system
// for the first time someone opens up their portfolio").
//
// Three steps, each honest to the machinery that exists TODAY:
//   story    — the three beats of the portfolio system, told with the same
//              IntroArt the homepage section uses (real primitives, real reads).
//   connect  — the app's own WalletButton. Skipped when already connected.
//   found    — the wallet's REAL major assets via the existing raw-holdings
//              read (cross-chain, per-network isolated), so "we help you build
//              out your portfolio" starts from what someone actually holds.
//              Unreadable networks and unpriced tokens are SAID, never hidden.
//
// Deliberately absent: any mention of linking MULTIPLE wallets. That machinery
// does not exist yet (relayed to the allocator lane 2026-08-03); an onboarding
// that promises it would be a lie in the product's first minute.
//
// One-shot: a localStorage latch, NOT gated on reduced motion — this is
// information, not decoration, so motion preferences change the animation,
// never whether someone is onboarded. Mounted at the ROUTE (App.tsx) beside
// <Yours/>, so the portfolio page itself carries zero intro code and the
// allocator lane's rework of that file merges clean.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum.portfolio-intro.v1'

/** The veil's latch, readable by the OnboardingGate (the consolidation). */
export function portfolioIntroSeen(): boolean {
  return seenBefore()
}

function seenBefore(): boolean {
  try {
    return localStorage.getItem(KEY) === 'done'
  } catch {
    return true // storage unavailable: never loop someone through an intro forever
  }
}

export function markPortfolioIntroSeen() {
  try {
    localStorage.setItem(KEY, 'done')
  } catch {
    /* private browsing: the latch just does not persist */
  }
}

/** THE REPLAY DOOR (owner ~11:3x: "a way to redemo the onboarding"):
 *  `/portfolio?intro=replay` plays the ceremony again regardless of the latch —
 *  for demos, reviews, and anyone who skipped too fast. Finishing re-arms the
 *  latch as usual, so the replay is one showing, not a reset. */
function replayRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('intro') === 'replay'
  } catch {
    return false
  }
}

export function portfolioIntroWillPlay(): boolean {
  return WALLET_ENABLED && (replayRequested() || !seenBefore())
}

// Headings only (owner ~10:2x: "much less text make it simplified") — the art
// carries each beat, exactly as it does on the homepage section.
const BEATS = [
  { k: 'One book, every EVM chain', kind: 'book' as const, accent: 'var(--color-cyan)' },
  { k: 'Move weights, not positions', kind: 'weights' as const, accent: 'var(--color-violet-bright)' },
  { k: 'Insights, not advice', kind: 'insights' as const, accent: 'var(--color-teal)' },
]


type Step = 'story' | 'connect' | 'found'



/** THE FIRST-OPEN FRAME — mounts the ceremony OVER the page and makes the page
 *  itself part of the reveal: while the intro shows, the portfolio waits soft
 *  behind the veil (scaled a breath down, blurred); the moment the exit starts
 *  it surfaces — sharpening and settling as the veil lifts, so what emerges is
 *  the chart arriving rather than a page that was flatly there all along.
 *
 *  ⚠ The containing-block trap, handled: a transform on this wrapper would
 *  anchor any `fixed` overlay inside the page (fees popup, mode popup) to the
 *  wrapper instead of the viewport — the search-modal class. So the held
 *  styles are CLEARED to undefined once the arrival settles; in steady state
 *  the wrapper is transform-free. */
export function PortfolioFirstOpen({ children }: { children: ReactNode }) {
  const [willPlay] = useState(() => portfolioIntroWillPlay())
  const reduced = usePrefersReducedMotion()
  const held = willPlay && !reduced
  const [phase, setPhase] = useState<'held' | 'arriving' | 'settled'>(held ? 'held' : 'settled')

  useEffect(() => {
    if (phase !== 'arriving') return
    const t = window.setTimeout(() => setPhase('settled'), 1000)
    return () => window.clearTimeout(t)
  }, [phase])

  return (
    <>
      {willPlay && <PortfolioIntro onExitStart={() => setPhase('settled')} onRevealStart={() => setPhase('arriving')} />}
      <div
        /* REMOUNT on leaving 'held': the page's own entrance stagger (the
           Shells' `enter` cascade) already played invisibly UNDER the veil,
           so what emerged arrived as one flat block. Flipping the key as the
           veil lifts replays it — the portfolio BUILDS itself in front of
           you, card by card, which is the reveal the page was designed to
           make. Cheap: React Query serves the remount from cache. Reduced
           motion never holds, so the key never flips and nothing replays. */
        key={phase === 'held' ? 'held' : 'live'}
        /* No 'arriving' style: the key flip mounts a NEW node, and CSS
           transitions never run on initial mount — a from-state block here
           was dead code (audit F4). The arrival IS the children's replayed
           `enter` cascade behind the veil's own delayed fade. */
        style={
          phase === 'held'
            ? { transform: 'scale(0.988) translateY(10px)', filter: 'blur(5px)', opacity: 0.85 }
            : undefined
        }
      >
        {children}
      </div>
    </>
  )
}

export function PortfolioIntro({
  onExitStart,
  onRevealStart,
}: {
  /** Fired on ANY exit (skip, Escape, reveal) — the page must never stay held. */
  onExitStart?: () => void
  /** Fired only by the primary CTA — the ceremonial arrival. */
  onRevealStart?: () => void
} = {}) {
  const [open, setOpen] = useState(() => portfolioIntroWillPlay())
  const { address, isConnected } = useAccount()
  // ONE STORY, TOLD ONCE: someone who walked the homepage's get-started act
  // (connected, saw their book) opens on the FOUND step — the story stays one
  // dot-click back. Connection is read inside an effect below rather than
  // here because wagmi hydrates after mount; the initializer only consults
  // the breadcrumb.
  const [step, setStep] = useState<Step>(() => (homeOnboardingSeen() ? 'found' : 'story'))
  // The REVEAL (owner ~10:3x: "a beautiful transition animation that then
  // reveals your portfolio chart etc") — the portfolio is already rendered
  // behind this overlay, so the reveal IS the overlay's exit: the panel rises
  // and dissolves, then the veil lifts. Reduced motion cuts straight through.
  const [closing, setClosing] = useState(false)
  const reduced = usePrefersReducedMotion()
  const { data: basketData } = useAllBaskets()
  const baskets = useMemo(() => (basketData ?? []).filter((b) => !b.supersededBy), [basketData])
  // CONNECTION-HONEST (owner ~12:3x: the found step "shows fake assets, a
  // fake pnl number — it should ask you to connect and then shows"): the
  // ceremony reads ONLY a real connection. No dev stand-in HERE — a step
  // titled "What you already hold" over demo assets is a lie in the
  // product's first minute; the portfolio PAGE keeps its own preview
  // fallback, but the ceremony asks first. The linked-wallet group joins
  // the found step's read; the wallet controls live in the TOP BAR.
  const connected = isConnected && address ? address : undefined
  const walletGroup = useWalletGroup(connected)
  const raw = useRawHoldings(open && connected ? walletGroup.addresses : undefined)
  // BASKET HOLDINGS BELONG IN THE BOOK (audit 2026-08-04): the raw sweep reads
  // the verified token lists and can never see a basket token, so a wallet
  // holding only baskets read as empty here. The portfolio read already values
  // them at NAV; fold those rows in. Same group as the raw read.
  const heldBaskets = usePortfolio(open && connected ? walletGroup.addresses : undefined)
  const panelRef = useRef<HTMLDivElement>(null)

  // Connecting IS the step's completion — advance the moment it happens.
  useEffect(() => {
    if (step === 'connect' && isConnected) setStep('found')
  }, [step, isConnected])

  // A dialog owns Escape, contains Tab, and the page behind must not scroll
  // under it. Escape defers to popovers (they consume it in capture phase —
  // one keypress was closing a popover AND dismissing the ceremony, burning
  // the one-shot latch). Tab wraps within the panel: without the trap,
  // Shift+Tab escaped into nav controls blurred under the veil.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return
        dismiss()
        return
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const inside = panelRef.current.contains(document.activeElement)
        if (!inside) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    // Consume the replay door: the param already did its job (this mount).
    // Left in the URL, back/forward and refresh replayed the ceremony forever
    // — "one showing, not a reset" is enforced here, not just documented.
    try {
      const url = new URL(window.location.href)
      if (url.searchParams.get('intro') === 'replay') {
        url.searchParams.delete('intro')
        window.history.replaceState(window.history.state, '', url)
      }
    } catch {
      /* URL API unavailable — the latch still limits the damage */
    }
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Every step is its own subtree, so the advancing button unmounts under the
  // user and focus fell to <body> — under the veil. Refocus the panel ONLY
  // when focus actually dropped (audit F5: the dots persist across steps, and
  // yanking a keyboard user off a dot they just pressed made every dot-step
  // cost a re-tab). The dialog's label names the step so the change is heard.
  useEffect(() => {
    if (document.activeElement === document.body || !panelRef.current?.contains(document.activeElement)) {
      panelRef.current?.focus()
    }
  }, [step])

  // Disconnecting mid-ceremony (production, no preview fallback) must walk
  // the machine BACK — the found step with no address read as an empty
  // wallet, which is a false claim about a wallet that is not even there.
  useEffect(() => {
    if (step === 'found' && !connected) setStep('connect')
  }, [step, connected])

  // The found step's headline number: everything PRICED across networks,
  // eased up from zero once the read settles (the hero's count-up idiom).
  // Unpriced holdings are excluded from the figure and shown as dashes in the
  // list — a dash in a sum would be a guess.
  const bookRows = useMemo(
    () => [...(raw.data?.holdings ?? []), ...basketRowsFromPortfolio(heldBaskets.data?.holdings ?? [])],
    [raw.data, heldBaskets.data],
  )
  const book = deriveFoundBook(bookRows)
  const readableUsd = book.readableUsd
  const countedTotal = useCountUp(readableUsd, step === 'found' && !raw.isLoading && !heldBaskets.isLoading && readableUsd > 0)

  // The found step's picture and its remainder rows: the BOOK is drawn by
  // the real engine now (FoundBook — specallocator's lane, owner ~12:4x via
  // the desk; the two display laws it learned live — chain-qualified ids,
  // the dust floor — moved WITH the derivation into that component, plus the
  // market read, chain clustering and the glide). The split lives in ONE
  // predicate (inBook) so the rows can only ever carry what the picture
  // cannot: unpriced holdings AND dust. (found-book.ts still feeds the
  // homepage act and the readable total above — same wallet, same numbers.)
  const found = raw.data
  // majors over the FOLDED rows (raw + held baskets) — otherwise the picture
  // and rows stay blind to baskets while the headline total counts them.
  const top = majors(bookRows)
  const pictured = top.filter(inBook)
  const showBook = pictured.length >= 2
  const listRows = showBook ? top.filter((h) => !inBook(h)) : top
  // PICK WHAT TO BRING IN (the owner's first-run ruling, 2026-08-03 ~15:5x): the
  // book reports which holdings are IN (everything, until a tile is tapped
  // out); the seed CTA honors it below. null = the book hasn't reported yet,
  // which reads as everything-in. (specallocator wiring — reviewed, kept)
  const [included, setIncluded] = useState<Set<string> | null>(null)
  const isIncluded = (h: { chainId: number; address: string }) =>
    included == null || included.has(`${h.chainId}:${h.address.toLowerCase()}`)

  // Per-wallet readable totals from the merge's own attribution — the pill's
  // panel shows what each member brings to the one book.
  const readableByWallet = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of found?.holdings ?? [])
      for (const c of h.contributors ?? []) {
        if (c.usd != null && c.usd > 0) m.set(c.owner, (m.get(c.owner) ?? 0) + c.usd)
      }
    return m
  }, [found])

  const navigate = useNavigate()
  const keepHref = flowHref('keep')
  // "Start from what you hold": seed the weighting DRAFT from the priced
  // majors (native folds to its WETH form in the seeder; never an existing
  // draft) and land in the flow with the book pre-loaded.
  //
  // THE SCOPE IS WHAT THE FLOW WILL READ, not what we read holdings for:
  // disconnected (the dev-preview walk) the flow opens on GUEST_SCOPE, and a
  // draft seeded under the preview address would simply never show.
  const seedScope = isConnected && address ? address : GUEST_SCOPE
  // The CTA mirrors THE SEED PIPELINE EXACTLY (union of the pick ruling and
  // audit A6): shapeThese seeds bookRows → isIncluded (the tiles the visitor
  // kept IN; rows never pictured stop at the report) → the seeder's own laws
  // (baskets refused, unpriced refused, native folds). Counting anything else
  // over- or under-promises the button.
  const canSeed =
    keepHref != null &&
    connected != null &&
    bookRows.filter((h) => isIncluded(h) && !h.basket && h.usd != null && h.usd > 0).length >= 2
  // Say what cannot ride rather than dropping it silently (the honesty law).
  // A basket the visitor TAPPED OUT earns no line — that exclusion was chosen.
  const excludedBaskets = bookRows.filter((h) => h.basket && isIncluded(h) && (h.usd ?? 0) > 0).length

  function shapeThese() {
    if (!keepHref || !connected) return
    // only what the book says is IN seeds the draft (the pick ruling)
    seedDraftFromHoldings(seedScope, bookRows.filter(isIncluded))
    markPortfolioIntroSeen()
    onExitStart?.()
    // THE GLIDE (the owner ~16:2x, specallocator wiring — review me): the book's
    // tiles travel into the weight station as one motion. flushSync commits
    // the route swap inside the transition's update; the double-rAF lets the
    // (pre-warmed) lazy route resolve and paint before the new snapshot.
    // Landing at WEIGHT keeps the CTA's own promise — "Shape these weights"
    // used to land on the picker. Unsupported/reduced-motion = plain swap.
    withViewTransition(async () => {
      flushSync(() => {
        setOpen(false)
        navigate(`${keepHref}&at=weight`)
      })
      // NOT rAF: rendering is frozen inside the update callback, so a paint
      // callback never fires and the API aborts on timeout (measured). The
      // settle is DETERMINISTIC now (audit follow-up, replaces a guessed
      // 60ms): await the lazy route's module, then poll for the station's
      // own vt-named tiles in the committed DOM — found means the new-side
      // snapshot has its morph targets. Bounded at ~240ms; timing out
      // degrades to the plain crossfade, never breaks.
      await import('../../pages/Manager')
      for (let i = 0; i < 8; i++) {
        if (document.querySelector('[style*="view-transition-name"]')) break
        await new Promise<void>((r) => setTimeout(r, 30))
      }
      await new Promise<void>((r) => setTimeout(r, 16))
    })
  }

  if (!open) return null

  function dismiss() {
    markPortfolioIntroSeen()
    onExitStart?.()
    setOpen(false)
  }

  /** The ceremonial exit: rise, dissolve, reveal. Only the primary CTA earns
   *  it; Skip and Escape cut straight through via dismiss(). */
  function reveal() {
    if (closing) return
    markPortfolioIntroSeen()
    if (reduced) {
      onExitStart?.()
      setOpen(false)
      return
    }
    onRevealStart?.()
    setClosing(true)
    window.setTimeout(() => setOpen(false), 780)
  }

  return (
    <div
      /* the entrance classes come OFF while closing — an animation's fill
         holds its final opacity and would pin the veil open under the exit
         transition */
      /* z-[85], deliberately UNDER the WalletButton connect dialog's z-[90]
         (it portals to document.body): the ceremony's own connect step
         summons that dialog, and at z-[95] this veil buried it — the primary
         onboarding action opened invisible and unclickable. Above the page's
         own popups (z-40/50), below anything the ceremony itself summons. */
      className={`fixed inset-0 z-[85] overflow-y-auto bg-void/80 backdrop-blur-md ${closing ? '' : 'intro-veil-in'}`}
      style={{
        opacity: closing ? 0 : 1,
        transition: closing ? `opacity 640ms ${EASE} 120ms` : undefined,
        pointerEvents: closing ? 'none' : undefined,
      }}
    >
      {/* DOCK CLEARANCE SEAM (specallocator's measured ask, 2026-08-03): a
          page that floats a fixed dock sets --intro-dock-clearance (e.g.
          130px) on :root or any ancestor while the dock is mounted, and the
          shell's scroller keeps the panel's last lines clear of it at max
          scroll. Unset = 0px = today's padding byte-identical. Shell-side by
          necessity: the body doesn't scroll here — this veil does — so a
          spacer portaled to body is inert (their proof). */}
      <div className="grid min-h-full place-items-center p-4 pb-[calc(1rem+var(--intro-dock-clearance,0px))] sm:p-6 sm:pb-[calc(1.5rem+var(--intro-dock-clearance,0px))]">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={
            step === 'story'
              ? 'Welcome to your portfolio'
              : step === 'connect'
                ? 'Connect your wallet'
                : 'What you already hold'
          }
          tabIndex={-1}
          className={`relative w-full max-w-5xl rounded-2xl border border-white/10 bg-panel p-6 shadow-2xl outline-none sm:p-10 ${closing ? '' : 'intro-panel-in'}`}
          style={{
            opacity: closing ? 0 : 1,
            transform: closing ? 'translateY(-22px) scale(1.015)' : undefined,
            filter: closing ? 'blur(6px)' : undefined,
            transition: closing
              ? `opacity 560ms ${EASE}, transform 680ms ${EASE}, filter 560ms ${EASE}`
              : undefined,
          }}
        >
          {/* the product's signature: the same animated spectral strip every
              Shell on the page behind wears — the ceremony is OF the product,
              not a slide over it. Rounds its own top corners (overflow-hidden
              on the panel would clip the wallet popover). */}
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-1 rounded-t-2xl motion-reduce:[animation:none]"
            style={{ background: SPECTRAL, backgroundSize: '300% 100%', animation: 'spectrum-refract 16s ease-in-out infinite' }}
          />
          {/* the brand opens the ceremony; the WALLET CONTROLS live UP HERE
              (owner ~11:4x: "the connect button should be at the top so the
              connect / link another pop up doesnt go off screen") — their
              popovers open DOWNWARD, so anchoring them at the top keeps the
              whole panel beneath them as room. Dots say where you are. */}
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <SpectrumWordmark className="text-sm" />
            {/* wraps (2026-08-05): the skip below makes this a THREE-item cluster,
                and wallet + dots + skip together outgrow a 320px screen — without
                a wrap the last one gets pushed past the panel edge. */}
            <span className="flex flex-wrap items-center justify-end gap-4">
              {isConnected && address ? (
                <LinkedWallets group={walletGroup} active={address} readableByWallet={readableByWallet} />
              ) : (
                <WalletButton />
              )}
              {/* the dots NAVIGATE now (not just say where you are): any step
                  that is legal from here is one click back or forward —
                  re-reading the story must not cost a full replay. Legality:
                  story always; connect only disconnected (connected, it
                  auto-advances instantly — a dead stop); found only past a
                  real connection (the connection-honest rule). */}
              <span className="inline-flex items-center">
                {(
                  [
                    { s: 'story' as Step, label: 'The story', legal: true },
                    { s: 'connect' as Step, label: 'Connect', legal: !connected },
                    { s: 'found' as Step, label: 'What you hold', legal: connected != null },
                  ] as const
                ).map(({ s, label, legal }) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => legal && s !== step && setStep(s)}
                    /* the ACTIVE dot stays enabled (aria-current carries the
                       state; the click guard makes it a no-op) — disabling it
                       dropped keyboard focus to <body> on every dot press */
                    disabled={!legal}
                    aria-label={label}
                    aria-current={s === step ? 'step' : undefined}
                    className="group/dot grid h-6 place-items-center px-1 disabled:cursor-default"
                  >
                    <span
                      className={`h-1.5 rounded-full transition-all duration-500 ${
                        s === step ? '' : `bg-white/15 ${legal ? 'group-hover/dot:bg-white/40' : ''}`
                      }`}
                      style={{
                        width: s === step ? 20 : 6,
                        ...(s === step ? { background: SPECTRAL } : {}),
                      }}
                    />
                  </button>
                ))}
              </span>
              {/* THE VISIBLE WAY OUT (QOL round 2026-08-05, item 14: "Escape
                  works, but there's no visible skip affordance for someone
                  who's seen it and just wants their book"). Escape was the only
                  exit on the FOUND step — and that is the step someone who
                  already walked the homepage act opens on, so the person most
                  likely to want out had the least to click.
                  It lives up here rather than in each step's button row because
                  it has to be there on ALL of them, and the row it would join
                  differs per step (Skip beside Get started, Not now, two CTAs).
                  Calls the same dismiss() as Escape and the step rows: one
                  place burns the one-shot latch, so every exit leaves the
                  ceremony in exactly the same state. */}
              <button
                type="button"
                onClick={dismiss}
                aria-label="Skip intro and go to your portfolio"
                /* h-6 matches the dot buttons beside it: same baseline, and a
                   tappable row rather than an 11px sliver of text. */
                className="press inline-flex h-6 items-center font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint hover:text-ink"
              >
                Skip intro
              </button>
            </span>
          </div>

          {step === 'story' && (
            <div className="intro-step-in">
              <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
                Everything you hold, one place
              </h2>
              <div className="mt-8 grid gap-4 sm:grid-cols-3">
                {BEATS.map((c, i) => (
                  <div
                    key={c.k}
                    className="intro-step-in relative flex flex-col gap-3 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] p-5"
                    style={{ animationDelay: `${i * 80 + 60}ms` }}
                  >
                    {/* the Bezel glow idiom, card-sized */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full opacity-15 blur-2xl"
                      style={{ background: c.accent }}
                    />
                    <span aria-hidden className="h-px w-10" style={{ background: c.accent }} />
                    <h3 className="font-display text-[13px] font-bold uppercase tracking-[0.04em] text-ink">{c.k}</h3>
                    <IntroArt kind={c.kind} accent={c.accent} baskets={baskets} />
                  </div>
                ))}
              </div>
              <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={dismiss}
                  className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:text-ink"
                >
                  Skip
                </button>
                <button
                  type="button"
                  onClick={() => setStep(connected ? 'found' : 'connect')}
                  className="spectral-btn press inline-flex h-11 items-center rounded-full px-7 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-void"
                >
                  {connected ? 'See what you hold' : 'Get started'}
                </button>
              </div>
            </div>
          )}

          {step === 'connect' && (
            <div className="intro-step-in">
              <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
                Connect to see everything you hold
              </h2>
              <p className="mt-3 text-[13px] leading-relaxed text-ink-dim">
                Reading is free and signs nothing. The Connect button is at the top.
              </p>
              {/* the ghost book — shared silhouette (GhostBook.tsx) */}
              <div className="mt-6">
                <GhostBook />
              </div>
              {/* the networks it reads — the real badges, not a claim */}
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {SUPPORTED_CHAIN_IDS.map((c, i) => (
                  <span key={c} className="intro-step-in" style={{ animationDelay: `${i * 70 + 80}ms` }}>
                    <ChainBadge chainId={c} />
                  </span>
                ))}
              </div>
              <div className="mt-8">
                <button
                  type="button"
                  onClick={dismiss}
                  className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:text-ink"
                >
                  Not now
                </button>
              </div>
            </div>
          )}

          {step === 'found' && (
            <div className="intro-step-in">
              <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
                {top.length > 0 ? 'What you already hold' : 'Your portfolio'}
              </h2>
              {raw.isLoading && (
                <div className="mt-6">
                  <p className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" aria-hidden />
                    reading your wallet across networks
                  </p>
                  {/* skeleton rows where the book will land — shape, not data */}
                  <div className="mt-5 space-y-2.5" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="h-10 animate-pulse rounded-lg bg-white/[0.04]"
                        style={{ animationDelay: `${i * 160}ms` }}
                      />
                    ))}
                  </div>
                </div>
              )}
              {!raw.isLoading && top.length > 0 && (
                <>
                  {readableUsd > 0 && (
                    <div className="mt-5">
                      <div className="flex items-baseline font-num text-4xl font-light leading-none tabular-nums text-ink sm:text-5xl">
                        <span className="mr-1.5 text-2xl text-ink-faint sm:text-3xl">$</span>
                        {formatUsdCompact(countedTotal).replace(/^\$/, '')}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                        {/* the wallet count waits for the read it describes —
                            "2 wallets" over a still-solo placeholder total
                            asserted a false pairing (audit F3) */}
                        readable across your wallets
                        {walletGroup.isGroup && !raw.isPlaceholderData
                          ? ` · ${walletGroup.addresses.length} wallets`
                          : ''}
                        {/* the merged read in flight: the previous book stands
                            (placeholderData) and this dot is the only tell */}
                        {raw.isFetching && !raw.isLoading && (
                          <span
                            className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan"
                            role="status"
                            aria-label="Updating holdings"
                          />
                        )}
                      </div>
                    </div>
                  )}
                  {/* THE BOOK AS THE PRODUCT DRAWS IT — the real engine's
                      bento (FoundBook): market read on the tiles, chain
                      clustering, staggered build-in, glide on group changes.
                      Needs two priced holdings — a one-tile picture says less
                      than rows. Rows below then carry ONLY what the picture
                      cannot: the unpriced holdings, dashes and all. */}
                  {showBook && (
                    <div className="mt-5">
                      <FoundBook holdings={pictured} pickable onIncludedChange={setIncluded} />
                    </div>
                  )}
                  {listRows.length > 0 && (
                    <ul className={`${showBook ? 'mt-4' : 'mt-5'} divide-y divide-white/5`}>
                      {listRows.map((h, i) => (
                        <li
                          key={`${h.chainId}:${h.address}`}
                          className="intro-step-in flex items-center gap-3 py-2.5"
                          style={{ animationDelay: `${i * 55 + 80}ms` }}
                        >
                          <AssetLogo address={h.address} symbol={h.symbol} chainId={h.chainId} size={26} />
                          <span className="min-w-0 flex-1 truncate font-display text-[13px] font-bold text-ink">
                            ${showSymbol(h.symbol)}
                          </span>
                          {/* which wallets this merged row is made of — the
                              pill's own identity dots, colour-stable */}
                          {walletGroup.isGroup && (h.contributors?.length ?? 0) > 0 && (
                            <span className="flex shrink-0 items-center gap-1">
                              {h.contributors!.slice(0, 4).map((c) => (
                                <WalletDot key={c.owner} address={c.owner} size={7} />
                              ))}
                            </span>
                          )}
                          <ChainBadge chainId={h.chainId} />
                          <span className="w-24 text-right font-num text-sm font-semibold tabular-nums text-ink">
                            {h.usd != null && h.usd > 0 ? formatUsdCompact(h.usd) : '—'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {!raw.isLoading && top.length === 0 && (
                <>
                  <p className="mt-3 text-[13px] leading-relaxed text-ink-dim">
                    Nothing readable in this wallet yet.
                  </p>
                  {/* an empty book is not a dead end — and the ON-MISSION exit
                      is the flow itself: build a portfolio with fresh money
                      (connect-first ruling, 2026-08-03). Conviction on the
                      baskets page stays as the quiet second door. Both gated
                      the way the nav gates them: on an operator site with the
                      flow or discover off, no CTA silently bounces. */}
                  <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
                    {keepHref && (
                      <button
                        type="button"
                        onClick={() => {
                          dismiss()
                          navigate(keepHref)
                        }}
                        className="font-mono text-[11px] uppercase tracking-[0.12em] text-cyan transition-colors hover:text-ink"
                      >
                        Build a portfolio →
                      </button>
                    )}
                    {pageEnabled(brand.pages, 'discover') && (
                      <Link
                        to="/explore"
                        onClick={dismiss}
                        className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:text-ink"
                      >
                        Browse baskets →
                      </Link>
                    )}
                  </div>
                </>
              )}
              {found && (found.chainsFailed > 0 || found.unreadable > 0) && (
                <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                  {found.chainsFailed > 0 && `${found.chainsFailed} network${found.chainsFailed === 1 ? '' : 's'} unreadable right now`}
                  {found.chainsFailed > 0 && found.unreadable > 0 && ' · '}
                  {found.unreadable > 0 && `${found.unreadable} token${found.unreadable === 1 ? '' : 's'} unreadable, not zero`}
                </p>
              )}
              <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
                {canSeed && (
                  <button
                    type="button"
                    onClick={shapeThese}
                    className="press inline-flex h-11 items-center rounded-full border border-white/15 px-6 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-ink transition-colors hover:border-cyan/50"
                  >
                    Shape these weights
                  </button>
                )}
                {canSeed && excludedBaskets > 0 && (
                  <span className="w-full text-right font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint sm:w-auto">
                    {excludedBaskets === 1 ? 'your basket stays as it is' : `your ${excludedBaskets} baskets stay as they are`}
                  </span>
                )}
                <button
                  type="button"
                  onClick={reveal}
                  className="spectral-btn press inline-flex h-11 items-center rounded-full px-7 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-void"
                >
                  Open your portfolio
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
