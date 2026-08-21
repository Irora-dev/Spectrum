import { useEffect, useRef } from 'react'
import type { PortfolioInsight } from '../lib/spectrum/insights'
import { InfoDot } from './InfoDot'

// ─────────────────────────────────────────────────────────────────────────────
// AN INSIGHT, DRAWN — VISUAL-FIRST (owner 2026-08-02 23:1x: "we need to find a
// way to make these way more visual insights with less text"). The card's face
// is subject · STAT · mark · action; the full sentence and its measurement live
// behind the ⓘ — the same "facts → ⓘ" law the 12:36 round set for the
// how-it-fills cards. The module still names the wording AND the form; the
// card only renders, so the picture can never contradict the fact.
//
// THE DISCIPLINE HERE (dataviz method):
//   · the mark shows the SHAPE, the stat carries the number — one home each;
//   · text wears ink tokens, never the mark's colour: a coloured bar beside a
//     neutral label reads as data, coloured text reads as a verdict, and these
//     are neutral facts (his facts-only rule);
//   · one accent for the subject, one recessive track for the whole, and a 2px
//     surface gap between adjacent fills so segments stay countable;
//   · marks are aria-hidden and the face is terse, so the full sentence rides
//     along sr-only — a screen reader hears the fact once, in words.
// ─────────────────────────────────────────────────────────────────────────────

const TRACK = 'h-2.5 w-full overflow-hidden rounded-full bg-white/[0.07]'

/** A share that MOVED: where it was, where it is, and the distance between —
 *  the ghost marks the old level so the travel is the thing you see. The
 *  then/now microlabels died with the prose: the stat above says exactly
 *  "50% → 69%", and saying it twice was the text he wants gone. */
function MoveMark({ fromPct, toPct }: { fromPct: number; toPct: number }) {
  const grew = toPct > fromPct
  const lo = Math.max(0, Math.min(fromPct, toPct))
  const hi = Math.min(100, Math.max(fromPct, toPct))
  const accent = grew ? 'var(--color-teal)' : 'var(--color-cyan)'
  return (
    <div aria-hidden className="mt-4">
      {/* the track is not clipped: the NOW marker rides above it, and a
          marker clipped by its own track cannot mark an endpoint */}
      <div className="relative">
        <div className={TRACK}>
          {/* where it was — held, recessive */}
          <span className="block h-full rounded-full bg-white/20" style={{ width: `${Math.min(100, fromPct)}%` }} />
        </div>
        {/* the travel — the subject of the card */}
        <span
          className="absolute inset-y-0 rounded-full transition-[left,width] duration-700"
          style={{ left: `${lo}%`, width: `${Math.max(1, hi - lo)}%`, background: accent }}
        />
        {/* where it stands NOW — without this the two ends are symmetrical
            and the eye cannot tell which one is today */}
        <span
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel transition-[left] duration-700"
          style={{ left: `${Math.min(100, toPct)}%`, background: accent }}
        />
      </div>
    </div>
  )
}

/** Part of a whole: one filled track, the rest left as the whole. */
function ShareMark({ pct }: { pct: number }) {
  return (
    <div aria-hidden className="mt-4">
      <div className={TRACK}>
        <span
          className="block h-full rounded-full transition-[width] duration-700"
          style={{ width: `${Math.min(100, Math.max(1, pct))}%`, background: 'var(--color-magenta)' }}
        />
      </div>
    </div>
  )
}

/** A few named parts of the whole. The named parts take the accent, the
 *  remainder stays recessive — the card is about the named ones. */
function StackMark({ parts }: { parts: { label: string; pct: number }[] }) {
  const ACCENTS = ['var(--color-cyan)', 'var(--color-violet-bright)']
  return (
    <div aria-hidden className="mt-4">
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
        {parts.map((p, i) => (
          <span
            key={p.label}
            className="transition-[width] duration-700"
            style={{
              width: `${Math.max(1, Math.min(100, p.pct))}%`,
              background: i < ACCENTS.length ? ACCENTS[i] : 'rgba(255,255,255,0.10)',
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
        {parts.slice(0, ACCENTS.length).map((p, i) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: ACCENTS[i] }} />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function InsightCard({
  insight,
  onAct,
  onHover,
  pulseOnMount = false,
}: {
  insight: PortfolioInsight
  /** The host performs the action; the card only offers it. Absent host ⇒ the
   *  button is not rendered at all, never rendered dead. */
  onAct?: (a: NonNullable<PortfolioInsight['action']>) => void
  /** THE CARD ASKS THE PICTURE QUESTIONS (QOL round 6, the legend's own
   *  pattern): hovering a card whose fact names assets spotlights their
   *  tiles. The host wires it only when `insight.spot` has someone to light. */
  onHover?: (on: boolean) => void
  /** THE AWAY PULSE (touch round 2): the host marks the strip's first card
   *  when the away briefing has content — one soft glow at entrance, saying
   *  "start here, something changed while you were gone". element.animate on
   *  the card's own root (no CSS-shell edits, per the spec), skipped entirely
   *  under prefers-reduced-motion. Once per mount by construction: the effect
   *  runs on mount only, and finished animations leave no residue. */
  pulseOnMount?: boolean
}) {
  const m = insight.mark
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pulseOnMount || !rootRef.current) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // element.animate keyframes are canvas territory where var() indirection
    // is unreliable — so read the RESOLVED accent once at mount instead of
    // hardcoding a hex: the pulse then follows the plane (void cyan, paper
    // violet) like every class-driven surface does (the 2026-08-19 re-ink's
    // one JS residual, closed).
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-cyan').trim() || '#35e0ff'
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(accent)
    const [r, g, b] = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [53, 224, 255]
    rootRef.current.animate(
      [
        { boxShadow: `0 0 0 0 rgba(${r}, ${g}, ${b}, 0)`, borderColor: 'rgba(255, 255, 255, 0.1)' },
        { boxShadow: `0 0 24px 2px rgba(${r}, ${g}, ${b}, 0.25)`, borderColor: `rgba(${r}, ${g}, ${b}, 0.5)`, offset: 0.35 },
        { boxShadow: `0 0 0 0 rgba(${r}, ${g}, ${b}, 0)`, borderColor: 'rgba(255, 255, 255, 0.1)' },
      ],
      { duration: 1600, easing: 'ease-in-out', delay: 400 },
    )
    // mount-only by design: re-running on a prop flip would re-glow a card
    // the user has already seen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      ref={rootRef}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
      className="enter flex min-w-60 max-w-full flex-1 basis-60 flex-col rounded-2xl border border-white/10 bg-panel p-5 transition-colors hover:border-white/20"
    >
      {/* the face: what it's about, then the figure — the sentence is one ⓘ
          away. 11px on the readable ink step (the owner 2026-08-06: the titles
          were "a bit hard to read"). */}
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim">
        {insight.subject}
        <InfoDot>
          {insight.headline}. {insight.detail}
        </InfoDot>
      </p>
      <p className="mt-2 font-num text-[26px] font-semibold leading-none tabular-nums text-ink">{insight.stat}</p>
      <span className="sr-only">
        {insight.headline}. {insight.detail}
      </span>
      {/* the mark sits at the FOOT of the card, so a row of cards shares one
          baseline however long their subjects run */}
      <div className="mt-auto">
        {m.form === 'move' && <MoveMark fromPct={m.fromPct} toPct={m.toPct} />}
        {m.form === 'share' && <ShareMark pct={m.pct} />}
        {m.form === 'stack' && <StackMark parts={m.parts} />}
        {/* the follow-through: a fact you can act on in one tap, never a
            recommendation — the label states the mechanical move, not advice */}
        {insight.action && onAct && (
          <button
            type="button"
            onClick={() => onAct(insight.action!)}
            className="press mt-4 inline-flex h-9 items-center rounded-full border border-white/15 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
          >
            {insight.action.label} →
          </button>
        )}
      </div>
    </div>
  )
}
