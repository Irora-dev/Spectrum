import type { CategoryPill } from '../lib/spectrum/asset-categories'
import { chainMeta } from './ChainBadge'

/** The category pills (owner 23:09): click one and matching holdings stay
 *  alight while the rest darken — "like a light bulb goes off" — click it
 *  again and everything comes back. ONE active pill at a time: these are a
 *  spotlight, not a query builder. The DIMMING belongs to the consumer (list
 *  rows, bento tiles); this row only owns which pill is lit.
 *
 *  Chain pills wear the chain's house identity — dot + short code in the
 *  chain's own colour — instead of the full name (owner ~00:3x: "can be fit
 *  into one line if we use the icons for each chain rather than text");
 *  the full name stays as the accessible label. */
export function CategoryPills({
  pills,
  active,
  onToggle,
}: {
  pills: CategoryPill[]
  active: string | null
  onToggle: (id: string | null) => void
}) {
  if (pills.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {pills.map((p) => {
        const on = active === p.id
        if (p.chainId != null) {
          const m = chainMeta(p.chainId)
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              aria-label={`Spotlight ${p.label}`}
              title={p.label}
              onClick={() => onToggle(on ? null : p.id)}
              className="press inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wide transition-colors"
              style={
                on
                  ? { color: m.color, borderColor: `${m.color}99`, background: `${m.color}1f` }
                  : { color: 'var(--color-ink-dim)', borderColor: 'rgba(255,255,255,0.15)' }
              }
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
              {m.short}
            </button>
          )
        }
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(on ? null : p.id)}
            className={`press rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${
              on ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
            }`}
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
}
