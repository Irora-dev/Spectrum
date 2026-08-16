import { useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

/** The drawn trim/add bar — glass track, the CHANGE filled between the
 *  current marker and the thumb, a soft marker the thumb passes OVER, and the
 *  invisible native input as the drag/a11y layer. ONE implementation, shared
 *  by the list card and the picture's dial deck, so two surfaces can never
 *  drift about the same control. */
export function TrimBar({
  symbol,
  cur,
  target,
  scaleUsd,
  isNew,
  onTarget,
}: {
  symbol: string
  cur: number
  target: number
  scaleUsd: number
  isNew: boolean
  onTarget: (usd: number) => void
}) {
  const max = Math.max(scaleUsd, target, 100)
  // THE RESISTANCE FIX (the owner's 09:47 recording: "you feel resistance moving
  // it, which just shouldn't happen"). The input was fully controlled by
  // travelOf(target…) while dollarsOf ROUNDS to whole dollars — near the
  // anchor one notch moves cents, rounds to the same dollar, and maps back
  // to the same notch: the thumb visibly refused several notches of drag.
  // During a drag the TRAVEL is the source of truth (drag-local state); the
  // dollar prop resumes command on release, so the two can never fight
  // mid-gesture and never disagree at rest.
  const [dragTravel, setDragTravel] = useState<number | null>(null)
  const delta = target - cur
  const moved = Math.abs(delta) > 0.5
  // ── THE FEEL FIX (owner 2026-08-15: "i dont like the friction/resistance —
  // slower increments at the beginning but still slide normally"): the drawn
  // thumb used to sit in DOLLAR space, so near the anchor the curve compressed
  // dollars and the thumb visibly lagged the finger — which reads as friction.
  // The thumb and the change-fill now live in TRAVEL space (the finger's own
  // coordinates, 1:1 — zero resistance), while the VALUE keeps the square
  // curve: cents per pixel near the anchor, big steps at the rail ends. The
  // anchor marker sits at cur/max in BOTH spaces by construction (travelOf's
  // t_anchor = cur/max), so nothing drawn can disagree at rest. ──
  const travelNow = (dragTravel ?? travelOf(target, cur, max, isNew)) / 1000
  const anchorFrac = isNew || max <= 0 ? 0 : Math.min(1, Math.max(0, cur / max))
  const pctT = (f: number) => Math.min(100, Math.max(0, f * 100))
  // thumb-width-compensated centers (24px thumb) so marker, fill and thumb agree
  const centerT = (f: number) => `calc(${pctT(f)}% + ${12 - pctT(f) * 0.24}px)`
  const curP = pctT(anchorFrac)
  const valP = pctT(travelNow)
  const tone = moved ? (delta < 0 ? 'var(--color-cyan)' : 'var(--color-teal)') : 'transparent'
  return (
    <div className="relative h-10 min-w-0 flex-1">
      {/* glass track */}
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-white/[0.07]" />
      {/* held portion, whisper-quiet (context, not the story) */}
      {!isNew && (
        <span aria-hidden className="absolute top-1/2 h-2 -translate-y-1/2 rounded-l-full bg-white/[0.06]" style={{ left: 0, width: `${curP}%` }} />
      )}
      {/* THE CHANGE — filled between the current marker and the thumb */}
      {moved && (
        <span
          aria-hidden
          className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full opacity-90"
          style={{ left: `${Math.min(curP, valP)}%`, width: `${Math.abs(valP - curP)}%`, background: tone }}
        />
      )}
      {/* the current marker — soft pill the thumb passes OVER */}
      {!isNew && (
        <span aria-hidden className="absolute top-1/2 z-[5] h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/45" style={{ left: centerT(anchorFrac) }} />
      )}
      {/* the invisible native input = the drag layer (a11y + drag).
          ⚠ NON-LINEAR TRAVEL, anchored at the CURRENT value (the owner, live
          2026-08-14 13:19: "the initial part of the slider needs to use less
          cash but go more distance, and as you go further it speeds up").
          Linear travel put ~$130 in every notch of a $53k position — a fine
          trim was unreachable by drag. Travel now maps through a square curve
          CENTERED ON `cur`: near the current mark a notch moves cents, at the
          rail ends it moves the same big steps as before. The drawn geometry
          (marker, fill, thumb) stays in dollar space — only the drag layer's
          value mapping changed, so the two can never disagree about where
          money sits. */}
      <input
        type="range"
        min={0}
        max={1000}
        step={1}
        value={dragTravel ?? travelOf(target, cur, max, isNew)}
        onChange={(e) => {
          const t = Number(e.target.value)
          setDragTravel(t)
          onTarget(dollarsOf(t, cur, max, isNew))
        }}
        onPointerUp={() => setDragTravel(null)}
        onBlur={() => setDragTravel(null)}
        onKeyUp={() => setDragTravel(null)}
        aria-label={`Target value for $${showSymbol(symbol)}, dollars`}
        className="trim-bar"
      />
      {/* the drawn thumb — a void core in a spectral ring, above the marker */}
      <span
        aria-hidden
        className="trim-thumb pointer-events-none absolute top-1/2 z-20 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full transition-shadow"
        style={{ left: centerT(travelNow), background: SPECTRAL, boxShadow: '0 4px 14px rgba(0,0,0,0.6)' }}
      >
        <span className="h-4 w-4 rounded-full bg-[#0c0a18] shadow-[inset_0_1px_2px_rgba(255,255,255,0.25)]" />
      </span>
    </div>
  )
}

/** The travel curve, exponent 2: fine near the anchor, fast at the ends. */
const GAMMA = 2

/** travel [0..1000] → dollars [0..max], anchored so the resting thumb sits at
 *  the SAME track position as the dollar-linear bar did (t_anchor = cur/max). */
export function dollarsOf(travel: number, cur: number, max: number, isNew: boolean): number {
  const t = Math.min(1, Math.max(0, travel / 1000))
  const anchor = isNew || max <= 0 ? 0 : Math.min(1, Math.max(0, cur / max))
  if (t >= anchor) {
    const span = 1 - anchor
    const u = span <= 0 ? 1 : (t - anchor) / span
    return Math.round(cur + (max - cur) * u ** GAMMA)
  }
  const u = anchor <= 0 ? 0 : (anchor - t) / anchor
  return Math.round(cur - cur * u ** GAMMA)
}

/** dollars → travel: the exact inverse, so a typed number lands the thumb
 *  where a drag to that number would have. */
export function travelOf(target: number, cur: number, max: number, isNew: boolean): number {
  const anchor = isNew || max <= 0 ? 0 : Math.min(1, Math.max(0, cur / max))
  const v = Math.min(max, Math.max(0, target))
  if (v >= cur) {
    const range = max - cur
    const u = range <= 0 ? 1 : (v - cur) / range
    return Math.round((anchor + (1 - anchor) * u ** (1 / GAMMA)) * 1000)
  }
  const u = cur <= 0 ? 0 : (cur - v) / cur
  return Math.round((anchor - anchor * u ** (1 / GAMMA)) * 1000)
}
