// Alert rules: set here, evaluated locally by the service worker, stored in
// the user's own browser sync. The copy is deliberately honest about cadence —
// alarms don't wake a sleeping machine, so this is "checked every N minutes
// while your browser is open", never "real-time". And alerts state facts about
// the user's own position; nothing here suggests an action.

import { useEffect, useRef, useState } from 'react'
import type { Rule } from '../../shared/rules'
import { SectionRule } from './bits'

function describe(rule: Rule): string {
  if (rule.type === 'drift') return `Any asset ≥ ${rule.pts}pts from target`
  if (rule.type === 'move') return `A held basket moves ≥ ${rule.pct}% in 24h`
  const parts: string[] = []
  if (rule.aboveUsd != null && rule.aboveUsd > 0) parts.push(`above $${rule.aboveUsd.toLocaleString('en-US')}`)
  if (rule.belowUsd != null && rule.belowUsd > 0) parts.push(`below $${rule.belowUsd.toLocaleString('en-US')}`)
  return `Total crosses ${parts.join(' or ') || '—'}`
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`press relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${on ? 'bg-cyan' : 'bg-white/10'}`}
    >
      <span
        aria-hidden
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full transition-[left] duration-150 ${on ? 'left-[16px]' : 'left-[2px]'}`}
        style={{ background: on ? 'var(--color-void)' : 'var(--color-ink-dim)' }}
      />
    </button>
  )
}

const newId = () => `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`

function AddEditor({ onSave, onCancel }: { onSave: (r: Rule) => void; onCancel: () => void }) {
  const [type, setType] = useState<Rule['type']>('drift')
  const [pts, setPts] = useState('3')
  const [movePct, setMovePct] = useState('5')
  const [above, setAbove] = useState('')
  const [below, setBelow] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)

  // The editor lives at the bottom of the scroll column — opening it (or
  // switching to the taller value form) must bring its fields above the fold,
  // or "+ add" appears to do nothing but show three chips.
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'nearest' })
  }, [type])

  const num = (s: string) => {
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const valid =
    type === 'drift' ? num(pts) != null : type === 'move' ? num(movePct) != null : num(above) != null || num(below) != null

  const save = () => {
    if (type === 'drift') onSave({ id: newId(), type, enabled: true, pts: num(pts) as number })
    else if (type === 'move') onSave({ id: newId(), type, enabled: true, pct: num(movePct) as number })
    else onSave({ id: newId(), type, enabled: true, aboveUsd: num(above), belowUsd: num(below) })
  }

  const chip = (id: Rule['type'], label: string) => {
    const active = type === id
    return (
      <button
        type="button"
        onClick={() => setType(id)}
        aria-pressed={active}
        className={`press relative rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${active ? 'text-void' : 'text-ink-dim hover:text-ink'}`}
      >
        {active && <span aria-hidden className="absolute inset-0 rounded-full bg-cyan" />}
        <span className="relative">{label}</span>
      </button>
    )
  }

  const field = (value: string, set: (v: string) => void, width = 'w-14') => (
    <input
      inputMode="decimal"
      value={value}
      onChange={(e) => set(e.target.value)}
      className={`${width} rounded-md border border-line bg-white/[0.04] px-2 py-1 text-right font-mono text-[11px] text-ink outline-none focus:border-line-bright`}
    />
  )

  return (
    <div ref={cardRef} className="card-surface mt-3 rounded-xl p-3">
      <div className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-0.5">
        {chip('drift', 'drift')}
        {chip('value', 'value')}
        {chip('move', 'move')}
      </div>

      <div className="mt-3 font-mono text-[11px] leading-relaxed text-ink-dim">
        {type === 'drift' && (
          <label className="flex items-center gap-2">
            any asset sits {field(pts, setPts, 'w-12')} pts or more from its target
          </label>
        )}
        {type === 'move' && (
          <label className="flex items-center gap-2">
            a held basket moves {field(movePct, setMovePct, 'w-12')} % or more in 24h
          </label>
        )}
        {type === 'value' && (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2">total crosses above ${field(above, setAbove, 'w-20')}</label>
            <label className="flex items-center gap-2">or below ${field(below, setBelow, 'w-20')}</label>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="press rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!valid}
          className={`press rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${
            valid ? 'bg-cyan text-void' : 'bg-white/10 text-ink-faint'
          }`}
        >
          add alert
        </button>
      </div>
    </div>
  )
}

export function AlertsPanel({
  rules,
  onChange,
  pollMinutes,
  hasTargets,
}: {
  rules: Rule[]
  onChange: (rules: Rule[]) => void
  pollMinutes: number
  hasTargets: boolean
}) {
  const [adding, setAdding] = useState(false)

  return (
    <section className="px-4 pt-6">
      <div className="mb-2">
        <SectionRule
          right={
            !adding ? (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="press rounded-full border border-line bg-white/[0.03] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-line-bright hover:text-ink"
              >
                + add
              </button>
            ) : undefined
          }
        >
          alerts
        </SectionRule>
      </div>

      {rules.length === 0 && !adding && (
        <p className="font-mono text-[11px] leading-relaxed text-ink-dim">
          No alerts set. Rules run in your browser, on your machine. No server, no account.
        </p>
      )}

      <ul className="divide-y divide-white/5">
        {rules.map((r) => (
          <li key={r.id} className="group flex h-12 items-center gap-3">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.enabled ? 'bg-cyan' : 'bg-white/15'}`}
            />
            <div className="min-w-0 flex-1">
              <div className={`truncate font-mono text-[11px] ${r.enabled ? 'text-ink' : 'text-ink-faint'}`}>{describe(r)}</div>
              {r.type === 'drift' && r.enabled && !hasTargets && (
                <div className="font-mono text-[10px] text-amber">needs targets set above</div>
              )}
            </div>
            <Toggle
              on={r.enabled}
              label={`${describe(r)} · ${r.enabled ? 'on' : 'off'}`}
              onChange={(v) => onChange(rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))}
            />
            {/* Quiet until sought: the delete only surfaces on row hover or
                keyboard focus, so the resting row is dot · rule · toggle. */}
            <button
              type="button"
              aria-label={`Delete: ${describe(r)}`}
              onClick={() => onChange(rules.filter((x) => x.id !== r.id))}
              className="press grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-faint opacity-0 transition-opacity hover:bg-white/5 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
            >
              <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden>
                <path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      {adding && (
        <AddEditor
          onSave={(r) => {
            onChange([...rules, r])
            setAdding(false)
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      <p className="mt-3 font-mono text-[10px] leading-relaxed text-ink-faint">
        Checked every {pollMinutes} min while your browser is open. Alerts state facts about your own
        position, never advice.
      </p>
    </section>
  )
}
