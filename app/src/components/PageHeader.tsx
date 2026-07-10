import type { ReactNode } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// THE page masthead — one component so every static page opens with the same
// rhythm and can't drift again (owner ask 2026-07-05: headers were "a different
// style and font" per page). Canonical treatment, derived from the FAQ/Learn
// pair (the most refined instances at the time of unification):
//
//   eyebrow  font-mono 10px uppercase tracking-[0.3em] ink-faint
//   title    font-display font-bold uppercase leading-[0.95] tracking-tight ink
//   sub      max-w-2xl text-sm→base ink-dim
//
// Three size tiers, nothing else varies:
//   sm — dense app pages (Explore, Portfolio, legal)
//   md — content + tool pages (FAQ, Learn, Docs, Swap, Flush)
//   lg — the flagship flows (Launch)
//
// Exempt BY DESIGN: the homepage (its own wordmark identity) and entity heroes
// (Token / Creator — their "header" is the entity itself). Launch + NotFound
// keep bespoke layouts but use these exact type classes — if you change the
// treatment here, change it there.
// ─────────────────────────────────────────────────────────────────────────────

const TIERS = {
  sm: { title: 'text-2xl sm:text-3xl', eyebrowGap: 'mt-2', subGap: 'mt-1.5' },
  md: { title: 'text-4xl sm:text-5xl', eyebrowGap: 'mt-3', subGap: 'mt-4' },
  lg: { title: 'text-5xl sm:text-6xl', eyebrowGap: 'mt-3', subGap: 'mt-4' },
} as const

export function PageHeader({
  eyebrow,
  title,
  sub,
  size = 'md',
  actions,
  className = '',
}: {
  eyebrow?: string
  title: ReactNode
  /** One short paragraph; links welcome. */
  sub?: ReactNode
  size?: keyof typeof TIERS
  /** Right-aligned slot on the masthead row (chain chip, stats, search…). */
  actions?: ReactNode
  className?: string
}) {
  const t = TIERS[size]
  return (
    <div className={`flex flex-wrap items-end justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        {eyebrow && <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">{eyebrow}</div>}
        <h1
          className={`${eyebrow ? t.eyebrowGap : ''} font-display ${t.title} font-bold uppercase leading-[0.95] tracking-tight text-ink`}
        >
          {title}
        </h1>
        {sub && <p className={`${t.subGap} max-w-2xl text-sm leading-relaxed text-ink-dim sm:text-base`}>{sub}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}
