import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// The ⓘ disclosure — R's design law: the label stays one line, the detail lives
// behind the dot. Opens on hover AND on click/tap so touch + keyboard work.
// Extracted from /setup (2026-07-29) so the launch flow shares one implementation.
//
// The panel is PORTALED to <body> as position:fixed (owner 2026-08-01: "all pop
// up cards are not clipped by the bg cards they're on, these pop ups should
// always show"). In-flow it was clipped or buried by three different things,
// and every one of them is load-bearing where it sits:
//   · `overflow-hidden` on the card shells — the rounded corners clip the
//     wash/bloom/gradient bar, so the cards cannot give it up;
//   · `backdrop-blur` and `transform` on those same shells — either makes the
//     card the containing block, which traps even position:fixed children;
//   · the `.enter` staggered-entrance wrappers, whose settled filter/transform
//     values persist and make each row its own stacking context.
// Portaling escapes all three at once, so this is a one-file fix rather than a
// hunt through ~14 ancestors. z-100 clears the band canvas (z-40), the modals
// (z-90) and the swap pending overlay (z-95) — the ⓘ renders INSIDE that one.
const PANEL_Z = 100
const MARGIN = 8

export function InfoDot({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)
  const panelRef = useRef<HTMLSpanElement>(null)
  // The panel is portaled away from the button, so the only thing tying the two
  // together for assistive tech is this id + aria-describedby. Without it every
  // word behind every ⓘ — including the load-bearing measurability caveat — is
  // invisible to a screen reader.
  const panelId = useId()

  const place = useCallback(() => {
    const el = btnRef.current
    if (!el) return
    const a = el.getBoundingClientRect()
    const width = Math.min(352, window.innerWidth * 0.78) // matches w-[min(22rem,78vw)]
    // Flip up purely on "is there more room above than below". An earlier
    // version also required `a.top > est`, which left a hole: on a short
    // viewport (landscape phone, or Android with the keyboard up) BOTH branches
    // could be false and the panel was placed deliberately below the fold,
    // unreachable because it is fixed and pointer-events-none.
    const below = window.innerHeight - a.bottom - MARGIN * 2
    const above = a.top - MARGIN * 2
    const flipUp = below < above
    setStyle({
      position: 'fixed',
      left: Math.min(Math.max(a.left + a.width / 2, MARGIN + width / 2), window.innerWidth - MARGIN - width / 2),
      top: flipUp ? undefined : a.bottom + MARGIN,
      bottom: flipUp ? window.innerHeight - a.top + MARGIN : undefined,
      width,
      // Never taller than the side it sits on — long copy scrolls instead of
      // running off the screen (the $1k measurability caveat is ~10 lines on a
      // narrow phone).
      maxHeight: Math.max(96, flipUp ? above : below),
      overflowY: 'auto',
      transform: 'translateX(-50%)',
      zIndex: PANEL_Z,
    })
  }, [])

  // Place before paint so the panel never flashes at the wrong spot.
  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  // A fixed panel anchored off a stale rect detaches from its dot the moment
  // anything moves — and plenty here scrolls independently (the token page's
  // sticky rail, the pending overlay, the composer). Follow, don't strand.
  useEffect(() => {
    if (!open) return
    const onMove = () => place()
    window.addEventListener('scroll', onMove, true) // capture: catches nested scrollers
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open, place])

  // Tap-to-open needs a tap-to-dismiss that isn't the dot itself.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      // The panel counts as "inside" even though it is portaled — otherwise
      // touching it to scroll long copy dismisses it mid-gesture.
      if (!btnRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span
      // ml-1.5: the dot always trails a label, and every one of its call sites
      // butted it against the last word (owner 2026-08-01, spotted on
      // "Claimable fees") — the breathing room belongs to the component, not
      // to 21 copies of a space.
      className="relative ml-1.5 inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={btnRef}
        type="button"
        aria-label="What this means"
        aria-expanded={open}
        // OPEN, never toggle. Hover already opened it on a mouse, so a toggle
        // made clicking the dot CLOSE the panel you had just revealed — and on
        // touch the compatibility mouseenter fired first, so a tap opened and
        // immediately shut it. Closing is the outside-tap / Escape / mouseleave
        // job. preventDefault+stopPropagation because several call sites sit
        // inside a <label htmlFor=…> (the fee slider, the creator-payout
        // field), where the click would otherwise activate the field too and
        // pop the keyboard on a phone.
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        // Keyboard parity: the CSS-only tip this replaced revealed on focus.
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-describedby={open ? panelId : undefined}
        /* THE TARGET AND THE CIRCLE ARE TWO THINGS (owner 2026-08-06: the
           info circles were "way way too big"). The mobile audit's 32px
           minimum lives on THIS button — unpainted, so the tap area is
           generous while nothing shows — and the drawn circle is the small
           inner span below. The -m-2 keeps the 32px box from moving the
           line it sits in, exactly as the audit's union left it. */
        className="press group/idot -m-2 grid min-h-[32px] min-w-[32px] place-items-center"
      >
        {/* 14 → 15.5px (the owner 2026-08-06 12:49, "about ten percent bigger"):
            the 12:02 cut to 14 overshot slightly. The tap target above is
            untouched at 32px. */}
        <span
          className={`grid h-[15.5px] w-[15.5px] place-items-center rounded-full border font-mono text-[8px] font-bold leading-none transition-colors ${
            open
              ? 'border-cyan/60 bg-cyan/15 text-cyan'
              : 'border-white/25 bg-white/[0.07] text-ink-dim group-hover/idot:border-cyan/50 group-hover/idot:text-cyan'
          }`}
        >
          {/* owner 2026-08-05 21:06 + 08-06 ("a little bit to the left"):
              the grid centers the glyph's EM BOX, but the mono 'i' inks left
              of its own advance width — the half-pixel X nudge centers the
              INK, which is what the eye judges */}
          <span className="block leading-none" style={{ transform: 'translate(0.5px, -0.5px)' }}>
            i
          </span>
        </span>
      </button>
      {open &&
        style &&
        createPortal(
          <span
            id={panelId}
            ref={panelRef}
            role="tooltip"
            // Interactive, so long copy can actually be scrolled — the panel is
            // clamped to the viewport and would otherwise clip its own tail
            // with no way to reach it. Because it is portaled it is NOT a
            // descendant of the wrapper, so moving onto it fires the wrapper's
            // mouseleave; these two handlers hold it open across that gap.
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            style={style}
            className="block rounded-xl border border-white/[0.2] bg-panel-2 p-3.5 text-left text-[12px] font-normal normal-case leading-relaxed tracking-normal text-ink-dim shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)]"
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  )
}
