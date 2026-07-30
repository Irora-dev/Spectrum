import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useLocation } from 'react-router-dom'
import { links as navLinks, moreLinks, fullNavAt } from './Nav'
import { useReferralEarned } from './ReferralCard'

// The mobile-first navigation (owner 2026-07-30): a fixed bottom tab bar —
// thumb-reach, app-like — replacing the old top burger + inline drawer. Shows
// only below the breakpoint where the full top menu appears (fullNavAt, from
// the same gated link model in Nav, so operator page toggles govern both).
//
// Tabs: Home + up to three of the enabled primary destinations (Explore ·
// Swap · Portfolio), then More — a bottom SHEET carrying every remaining
// enabled link (Launch, League, Earn with its live badge, and the More set).
// The sheet is PORTALED to body: the bar carries backdrop-blur, which would
// otherwise become the containing block for a fixed child (the WalletButton
// lesson) and trap it in the bar's stacking context.

const TAB_ROUTES = ['/explore', '/swap', '/portfolio']

function icon(to: string): ReactNode {
  const p = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'h-[22px] w-[22px]',
    'aria-hidden': true,
  }
  switch (to) {
    case '/':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
          <path d="M9.5 21v-6h5v6" />
        </svg>
      )
    case '/explore':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="m15.5 8.5-2.2 5-5 2.2 2.2-5z" />
        </svg>
      )
    case '/swap':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <path d="M7 4v13m0 0-3-3m3 3 3-3" />
          <path d="M17 20V7m0 0-3 3m3-3 3 3" />
        </svg>
      )
    case '/portfolio':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h13A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
          <path d="M16 6V5a2 2 0 0 0-2-2H10a2 2 0 0 0-2 2v1" />
          <path d="M15 13h3" />
        </svg>
      )
    case '/launch':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <path d="M12 2.5l9 9.5-9 9.5-9-9.5z" />
        </svg>
      )
    case '/league':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <path d="M8 21h8M12 17v4" />
          <path d="M7 4h10v6a5 5 0 0 1-10 0z" />
          <path d="M7 6H4.5a0 0 0 0 0 0 0c0 2.5 1 4 2.5 4.5M17 6h2.5c0 2.5-1 4-2.5 4.5" />
        </svg>
      )
    case '/earn':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v10M14.5 9.2c-.6-.8-1.6-1.2-2.6-1.2-1.4 0-2.5.8-2.5 1.9 0 2.6 5.3 1.3 5.3 3.9 0 1.1-1.2 1.9-2.7 1.9-1.2 0-2.3-.5-2.8-1.3" />
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      )
  }
}

export function MobileTabBar() {
  const [sheetOpen, setSheetOpen] = useState(false)
  const { pathname } = useLocation()

  // Same fee-nudge as the top nav: the Earn row (in the sheet) carries the live
  // claimable amount; the More tab gets a dot so it's discoverable when closed.
  // claimableTotal, not total — sub-floor pots can't flush (F-1).
  const { claimableTotal: refClaimable } = useReferralEarned()
  const claimBadge = refClaimable

  const tabs = [
    { to: '/', label: 'Home', end: true },
    ...navLinks.filter((l) => TAB_ROUTES.includes(l.to)).slice(0, 3),
  ]
  const sheetLinks = [
    ...navLinks.filter((l) => !TAB_ROUTES.includes(l.to)),
    ...moreLinks,
  ]

  // Close the sheet whenever the route changes (tapping a link navigates).
  useEffect(() => setSheetOpen(false), [pathname])
  // Close on Escape while open.
  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheetOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetOpen])

  // Body scroll LOCKS while the sheet is open (the house pattern — Refer's
  // modal does the same); without it the page kept scrolling behind the scrim.
  useEffect(() => {
    if (!sheetOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [sheetOpen])

  // Close the sheet if the viewport widens past the breakpoint that hides this
  // whole component (audit): the scrim carries md:hidden/lg:hidden, so the sheet
  // became invisible while `sheetOpen` stayed true — leaving body.overflow
  // locked, the page frozen, and the More button that would close it gone too.
  useEffect(() => {
    if (!sheetOpen) return
    const q = window.matchMedia(fullNavAt === 'md' ? '(min-width: 768px)' : '(min-width: 1024px)')
    if (q.matches) {
      setSheetOpen(false)
      return
    }
    const onChange = (e: MediaQueryListEvent) => e.matches && setSheetOpen(false)
    q.addEventListener('change', onChange)
    return () => q.removeEventListener('change', onChange)
  }, [sheetOpen])

  // Return focus where it came from when the sheet closes, and don't re-grab it
  // on every re-render (the live Earn badge settling used to yank focus off a
  // link inside the sheet — the inline ref callback re-fired focus()).
  const restoreFocus = useRef<HTMLElement | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (sheetOpen) {
      restoreFocus.current = document.activeElement as HTMLElement | null
      sheetRef.current?.focus()
      return
    }
    const back = restoreFocus.current
    restoreFocus.current = null
    if (back && document.contains(back)) back.focus()
  }, [sheetOpen])

  // Native apps drop chrome during text entry: hide the bar while the on-screen
  // keyboard is up (visualViewport shrinks well below the layout viewport) so
  // it never floats over an amount field's fold row or CTA (mobile UX review).
  const [keyboardUp, setKeyboardUp] = useState(false)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => setKeyboardUp(vv.height < window.innerHeight * 0.75)
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])

  // Re-tapping the ACTIVE tab scrolls to top (the native tab-bar contract) —
  // long pages have no other fast way back up on a phone.
  const tabTap = (to: string) => {
    if (pathname === to) window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Drag-to-dismiss on the sheet (the grabber advertises it): translate follows
  // the finger from a top-region pointerdown, release past 80px closes.
  const [dragY, setDragY] = useState(0)
  const drag = useRef<{ startY: number; on: boolean }>({ startY: 0, on: false })
  const sheetDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { startY: e.clientY, on: true }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const sheetMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current.on) return
    setDragY(Math.max(0, e.clientY - drag.current.startY))
  }
  const sheetUp = () => {
    if (!drag.current.on) return
    drag.current.on = false
    if (dragY > 80) setSheetOpen(false)
    setDragY(0)
  }

  const hideAt = fullNavAt === 'md' ? 'md:hidden' : 'lg:hidden'
  const sheetActive = sheetLinks.some((l) => pathname.startsWith(l.to))

  return (
    <>
      {/* the bar — z-50 like the header, above the z-40 band canvas */}
      <nav
        aria-label="Primary"
        className={`fixed inset-x-0 bottom-0 z-50 border-t border-line bg-void/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl transition-transform duration-200 ${keyboardUp ? 'translate-y-full' : 'translate-y-0'} ${hideAt}`}
      >
        <div className="mx-auto grid h-14 max-w-md auto-cols-fr grid-flow-col">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={'end' in t ? t.end : undefined}
              onClick={() => tabTap(t.to)}
              className={({ isActive }) =>
                `press relative flex flex-col items-center justify-center gap-1 ${
                  isActive ? 'text-cyan' : 'text-ink-faint'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {/* active indicator: a short cyan hairline at the very top */}
                  <span
                    aria-hidden
                    className={`absolute inset-x-1/2 top-0 h-[2px] w-8 -translate-x-1/2 rounded-full bg-cyan transition-opacity ${
                      isActive ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                  {icon(t.to)}
                  <span className="font-mono text-[9px] uppercase tracking-[0.12em]">{t.label}</span>
                </>
              )}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            className={`press relative flex flex-col items-center justify-center gap-1 ${
              sheetActive ? 'text-cyan' : 'text-ink-faint'
            }`}
          >
            <span
              aria-hidden
              className={`absolute inset-x-1/2 top-0 h-[2px] w-8 -translate-x-1/2 rounded-full bg-cyan transition-opacity ${
                sheetActive ? 'opacity-100' : 'opacity-0'
              }`}
            />
            <span className="relative">
              {icon('more')}
              {claimBadge > 0 && (
                <span aria-hidden className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-teal" />
              )}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.12em]">More</span>
          </button>
        </div>
      </nav>

      {/* the More sheet — portaled, above the bar and every page surface */}
      {sheetOpen &&
        createPortal(
          <div
            className={`fixed inset-0 z-[80] flex flex-col justify-end bg-black/60 backdrop-blur-sm ${hideAt}`}
            onClick={() => setSheetOpen(false)}
          >
            {/* dialog semantics + programmatic focus (mobile audit M): without
                tabIndex+focus, keyboard/AT focus stayed on the More button
                UNDER the overlay and Tab walked the obscured page. role=menu
                was wrong anyway — these are links, not menuitems. */}
            <div
              role="dialog"
              aria-modal="true"
              aria-label="More pages"
              tabIndex={-1}
              ref={sheetRef}
              className={`search-pop max-h-[80svh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-white/12 bg-panel px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 outline-none ${dragY > 0 ? '' : 'transition-transform duration-200'}`}
              style={{ transform: dragY > 0 ? `translateY(${dragY}px)` : undefined }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* the grabber DOES drag now (it always advertised it): follow the
                  finger from the handle region, release past 80px dismisses */}
              <div
                className="-mx-3 -mt-3 cursor-grab touch-none px-3 pb-2 pt-3 active:cursor-grabbing"
                onPointerDown={sheetDown}
                onPointerMove={sheetMove}
                onPointerUp={sheetUp}
                onPointerCancel={sheetUp}
              >
                <div aria-hidden className="mx-auto h-1 w-10 rounded-full bg-white/15" />
              </div>
              {sheetLinks.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  className={({ isActive }) =>
                    `press flex items-center gap-3 rounded-xl px-3 py-3 font-mono text-sm uppercase tracking-[0.16em] ${
                      isActive ? 'text-cyan' : 'text-ink-dim hover:bg-white/5 hover:text-ink'
                    }`
                  }
                >
                  <span className="text-ink-faint">{icon(l.to)}</span>
                  <span className="flex-1">{l.label}</span>
                  {l.to === '/earn' && claimBadge > 0 && (
                    <span className="rounded-full bg-cyan/15 px-2 py-0.5 font-mono text-[10px] normal-case tracking-normal tabular-nums text-cyan">
                      ${refClaimable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
