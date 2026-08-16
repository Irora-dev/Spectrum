import { useEffect, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// FRESH DOT — the one live-read indicator (QOL round, owner 2026-08-05).
//
// The complaint it answers, in the owner's words: "every figure comes from
// chain, and the site's whole pitch is that nothing is a claim, but a page open
// for twenty minutes shows twenty-minute-old numbers with no timestamp."
//
// The owner's instruction was explicit: REUSE THE LIVE-DOT SYSTEM THIS KIT
// ALREADY HAS rather than invent a freshness widget. That system is the small
// pulsing cyan dot standing beside a micro caption, hand-copied into
// PortfolioChart, BasketChart, HomeOnboarding and portfolio/LinkedWallets. This
// file is that dot extracted once, with the half it was always missing: a dot
// that can only pulse says "live" and never says HOW OLD, so a read that
// settled twenty minutes ago looked identical to one that landed a second ago.
//
// Two states, both honest:
//   · a read in flight  → the pulsing cyan dot, the existing look untouched
//   · settled           → a calm dot plus how long ago the numbers were read
//
// THE AGE IS NEVER GUESSED. It comes from the query's own `dataUpdatedAt`, so
// it is the moment the data actually landed rather than anything inferred from
// the wall clock or from when this component happened to mount. A timestamp of
// 0 (never fetched, or standing placeholder data carried over from another
// wallet's read) renders NOTHING AT ALL — the same law the money surfaces obey,
// where a failed read is unreadable and never zero. "read 0 min ago" beside a
// number nobody has fetched yet is exactly the claim this kit refuses to make.
// ─────────────────────────────────────────────────────────────────────────────

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The caption for a read that is `ageMs` old. Plain words only.
 *
 * Under a minute is "just now" rather than a count of seconds: a figure whose
 * age ticks every second reads as noise, and the honest thing being said here
 * is "this is current", which seconds do not add to. Hours and days get their
 * own wording because nothing polls these reads while a tab sits idle, so
 * "read 430 min ago" is a real state this would otherwise print.
 *
 * A negative age (a clock that moved backwards, or a machine whose time drifted
 * behind the node's) collapses to "just now" instead of a nonsense future read.
 */
export function freshLabel(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < MINUTE) return 'just now'
  if (ageMs < HOUR) return `read ${Math.floor(ageMs / MINUTE)} min ago`
  if (ageMs < DAY) {
    const hours = Math.floor(ageMs / HOUR)
    return `read ${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  const days = Math.floor(ageMs / DAY)
  return `read ${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * How long until `freshLabel` would say something different.
 *
 * One timer per VISIBLE change, not a tick per second. The boundary is
 * computable, so the component sleeps straight to it — this dot sits in the
 * portfolio hero beside a count-up animation, and a per-second clock there
 * would re-render that whole subtree sixty times a minute to change nothing.
 */
export function msUntilLabelChange(ageMs: number): number {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0
  if (age < MINUTE) return MINUTE - age
  if (age < HOUR) return MINUTE - (age % MINUTE)
  if (age < DAY) return HOUR - (age % HOUR)
  return DAY - (age % DAY)
}

/** Re-renders exactly when the caption would change, and never otherwise.
 *  `updatedAt` of 0 means no clock at all — nothing is being counted. */
function useLabelClock(updatedAt: number): void {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!updatedAt) return
    let id = 0
    const schedule = () => {
      // Floored at a second: a tab that wakes from sleep exactly on a boundary
      // computes ~0 here, and an unfloored 0 would spin.
      const wait = Math.max(1_000, msUntilLabelChange(Date.now() - updatedAt))
      id = window.setTimeout(() => {
        tick((n) => n + 1)
        schedule()
      }, wait)
    }
    schedule()
    return () => window.clearTimeout(id)
  }, [updatedAt])
}

export function FreshDot({
  fetching,
  updatedAt,
  reading = 'the numbers',
  className = '',
  onRefresh,
}: {
  /** A read is in flight right now — React Query's `isFetching`. */
  fetching: boolean
  /** React Query's `dataUpdatedAt` for the query behind the figure. 0 means
   *  never read, which renders nothing rather than an invented age. */
  updatedAt: number
  /** What is being read, for screen readers: "your holdings", "price history". */
  reading?: string
  className?: string
  /** THE AGE IS A DOOR (QOL round 6): tapping the settled caption re-reads
   *  now. User-initiated, so it spends no standing budget (the RPC audit's
   *  line) — and the pulsing state already says the press was heard. Absent
   *  = the read-only caption exactly as it was. */
  onRefresh?: () => void
}) {
  // No clock while a fetch runs: the pulsing dot carries the entire message for
  // as long as it is spinning, so counting behind it would re-render for
  // nothing and then be thrown away the moment the read lands.
  useLabelClock(fetching ? 0 : updatedAt)

  if (fetching)
    return (
      <span
        className={`h-1.5 w-1.5 animate-pulse rounded-full bg-cyan motion-reduce:animate-none ${className}`}
        role="status"
        aria-label={`Updating ${reading}`}
      />
    )

  // Absent, never guessed (see the header): no timestamp means no caption.
  if (!updatedAt) return null

  const caption = (
    /* micro-scale mono caps, matching the captions this dot stands beside */
    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
      {freshLabel(Date.now() - updatedAt)}
    </span>
  )

  if (onRefresh)
    return (
      /* AN OBVIOUS PRESS (the owner 2026-08-06: "a very little spin icon… made
         into a bit more of a pill, so it's obvious to press") — the settled
         caption wears the utility-pill chrome, a refresh glyph replacing the
         resting dot (one symbol per job; a dot AND a spinner is clutter) */
      <button
        type="button"
        onClick={onRefresh}
        title={`Read ${reading} again now`}
        aria-label={`Read ${reading} again now`}
        className={`press inline-flex h-6 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 transition-colors hover:border-cyan/40 hover:[&_span]:text-ink ${className}`}
      >
        <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
        {caption}
      </button>
    )

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
      {caption}
    </span>
  )
}
