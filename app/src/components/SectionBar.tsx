import type { ReactNode } from 'react'

/** A page's one section header: a small-caps label with the fact about that
 *  section on the right.
 *
 *  Lived inside pages/Creator.tsx until the thesis page needed the same rhythm.
 *  Moved here rather than copied: a second definition is how two surfaces that
 *  are meant to read as one product start drifting a letter-space apart. */
export function SectionBar({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-white/10 pb-3">
      <h2 className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-ink">{title}</h2>
      {meta && <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">{meta}</span>}
    </div>
  )
}
