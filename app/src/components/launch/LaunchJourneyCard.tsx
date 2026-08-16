import { Link } from 'react-router'
import { showName, showSymbol } from '../../lib/spectrum/safe-copy'
import { stepDoor } from '../../lib/spectrum/launch-doors'
import {
  STEP_LABEL,
  STEP_ORDER,
  STEP_WHY,
  resumeHeadline,
  stepOf,
  type Journey,
  type JourneyStep,
  type StepId,
} from '../../lib/spectrum/launch-journey'

// ─────────────────────────────────────────────────────────────────────────────
// THE LAUNCH JOURNEY, DRAWN — one card, two mounts.
//
// the owner, 2026-08-13: "this flow of the create basket is crucial, you should
// ALWAYS be guided through the entire setup, and even if you accidentally
// refresh or click off you should always be able to resume from your creator
// page or /create."
//
// It is deliberately ONE component for both the "continue your launch" resume
// card and the post-deploy "your basket is live → seed → thesis → share" card,
// because they are the same fact seen from two places. Two components would be
// two chances to disagree about whether a basket is seeded.
//
// EVERY STATE HERE IS DERIVED, NEVER ASSERTED. The card cannot claim a step
// that did not happen, because it never decides one: it renders whatever
// launch-journey.ts judged from the readings, INCLUDING 'unknown'. A step whose
// truth could not be read draws as "couldn't read" — never as done, never as
// outstanding — and when any required step is unknown the headline refuses to
// name a next step at all (resumeHeadline's own law, pinned by its tests).
//
// The rail is the whole journey, always: seeing "share" greyed out three steps
// away is the point — it is what makes a launch legible as a journey instead of
// as a button that already fired.
// ─────────────────────────────────────────────────────────────────────────────

const DOT: Record<JourneyStep['status'], string> = {
  done: 'border-cyan/70 bg-cyan/70',
  todo: 'border-white/25 bg-transparent',
  unknown: 'border-amber/60 bg-amber/25',
}

const TEXT: Record<JourneyStep['status'], string> = {
  done: 'text-ink-dim',
  todo: 'text-ink-faint',
  unknown: 'text-amber/90',
}

/** The whole journey as a TRACK — marks joined by a line that fills as far
 *  as the work has come (the owner live 2026-08-15: balance the card, more
 *  visual, less text). Evidence still rides every mark's tooltip. */
function StepRail({ journey, active }: { journey: Journey; active: StepId | null }) {
  return (
    <ol className="mt-5 flex w-full items-start">
      {STEP_ORDER.map((id, i) => {
        const step = stepOf(journey, id)
        const isActive = id === active
        const prev = i > 0 ? stepOf(journey, STEP_ORDER[i - 1]).status : null
        return (
          <li key={id} title={step.evidence} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span className="flex w-full items-center">
              <span aria-hidden className={`h-[2px] flex-1 ${i === 0 ? 'opacity-0' : prev === 'done' ? 'bg-cyan/60' : 'bg-white/10'}`} />
              <span
                aria-hidden
                className={`h-3 w-3 shrink-0 rounded-full border-2 transition-colors ${
                  isActive ? 'border-cyan bg-cyan/30 shadow-[0_0_12px_rgba(53,224,255,0.5)]' : DOT[step.status]
                }`}
              />
              <span aria-hidden className={`h-[2px] flex-1 ${i === STEP_ORDER.length - 1 ? 'opacity-0' : step.status === 'done' ? 'bg-cyan/60' : 'bg-white/10'}`} />
            </span>
            <span className={`truncate font-mono text-[10px] uppercase tracking-[0.12em] ${isActive ? 'font-bold text-ink' : TEXT[step.status]}`}>
              {id}
              {step.status === 'unknown' && <span aria-hidden> ?</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** A door, as the house draws one: an internal route through Link, an in-page
 *  anchor as a plain link. h-11 clears the 36px phone tap floor with room. */
function Door({ href, label, tone }: { href: string; label: string; tone: 'primary' | 'quiet' }) {
  const cls =
    tone === 'primary'
      ? 'press inline-flex h-11 items-center justify-center rounded-xl border border-cyan/45 bg-cyan/10 px-5 font-mono text-[11px] uppercase tracking-[0.14em] text-cyan transition-colors hover:border-cyan'
      : 'press inline-flex h-11 items-center justify-center rounded-xl border border-white/12 px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan'
  return href.startsWith('#') ? (
    <a href={href} className={cls}>
      {label}
    </a>
  ) : (
    <Link to={href} className={cls}>
      {label}
    </Link>
  )
}

export function LaunchJourneyCard({
  journey,
  eyebrow,
  anchors,
  className = '',
}: {
  journey: Journey
  /** What this card IS where it sits — "continue your launch" on a resume
   *  surface, "your basket is live" on the post-deploy one. */
  eyebrow: string
  /** In-page anchors for steps this page already hosts (the basket page hosts
   *  the thesis editor and the share modal, so it points at itself in place). */
  anchors?: { thesis?: string; share?: string }
  className?: string
}) {
  // `next` rather than `resumeAt`: on a finished-but-unshared basket the card
  // still has something to offer, and share is exactly it.
  const target = journey.uncertain ? null : journey.next
  const door = target ? stepDoor(journey, target, anchors ?? {}) : null
  const subjectLabel =
    journey.subject.kind === 'draft'
      ? showName(journey.subject.draft.name || 'your draft')
      : showName(journey.subject.basket.name || journey.subject.basket.symbol)

  return (
    <section
      aria-label={`Launch journey for ${subjectLabel}`}
      className={`rounded-2xl border p-4 sm:p-5 ${
        journey.uncertain ? 'border-amber/35 bg-amber/[0.05]' : 'border-cyan/30 bg-cyan/[0.04]'
      } ${className}`}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">{eyebrow}</div>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <h3 className="font-display text-xl font-bold leading-snug text-ink [text-wrap:balance] sm:text-2xl">
          {resumeHeadline(journey)}
        </h3>
        {/* the why rides the SAME line on wide cards — balanced, not stacked */}
        <p className="pb-0.5 text-sm leading-relaxed text-ink-dim">
          {journey.uncertain
            ? 'Part of the network didn’t answer. Everything below is still live.'
            : target
              ? STEP_WHY[target]
              : 'Nothing outstanding. Fully set up.'}
        </p>
      </div>

      {/* A draft's one line of substance: what is actually in it. */}
      {journey.subject.kind === 'draft' && journey.subject.draft.symbols.length > 0 && (
        <p className="mt-2 truncate font-mono text-[11px] text-ink-faint">
          {journey.subject.draft.symbols
            .slice(0, 5)
            .map((s) => `$${showSymbol(s)}`)
            .join(' · ')}
          {journey.subject.draft.symbols.length > 5 ? ` +${journey.subject.draft.symbols.length - 5}` : ''}
        </p>
      )}

      {door && (
        <div className="mt-4 flex flex-wrap gap-2.5">
          <Door href={door.href} label={door.label} tone="primary" />
          {/* The steps AFTER the one being offered, as quiet doors — the card
              is a journey, so nothing about it should feel like a single forced
              move. Only ever real, reachable steps, and only ever ONE button
              per destination: a draft's build and deploy steps legitimately
              share a door (/create is both), and rendering it twice put the
              same button next to itself (caught in the 2026-08-13 headless
              probe, which read two identical "pick up where you left off"
              doors on the creator page). */}
          {(() => {
            const seen = new Set([door.href])
            return STEP_ORDER.filter((id) => id !== target && stepOf(journey, id).status === 'todo')
              .map((id) => ({ id, d: stepDoor(journey, id, anchors ?? {}) }))
              .filter(({ d }) => {
                if (!d || seen.has(d.href)) return false
                seen.add(d.href)
                return true
              })
              .slice(0, 2)
              .map(({ id, d }) => <Door key={id} href={d!.href} label={d!.label} tone="quiet" />)
          })()}
        </div>
      )}

      <StepRail journey={journey} active={target} />

      {/* The share step's local nature, said out loud once — never a claim
          about whether anyone actually saw it. */}
      {stepOf(journey, 'share').status === 'done' && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          shared — remembered on this device only
        </p>
      )}
    </section>
  )
}

export { STEP_LABEL }
