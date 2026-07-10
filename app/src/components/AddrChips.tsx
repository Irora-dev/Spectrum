// A bright, gradient-tinted address bar: the addresses a doc step or section
// actually needs, right where the reader is, each one copyable in one tap.
// Renders ONLY from this build's chain config (nothing hardcoded); chains
// without a value are omitted, and with none configured it renders nothing.
import { CHAINS, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { CopyChip } from './DocKit'

export function AddrChips({ label, get }: { label: string; get: (c: (typeof CHAINS)[number]) => string | null }) {
  const rows = SUPPORTED_CHAIN_IDS.map((id) => CHAINS[id])
    .filter(Boolean)
    .map((c) => ({ name: c.name, value: get(c) }))
    .filter((r): r is { name: string; value: string } => !!r.value)
  if (rows.length === 0) return null
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border border-white/[0.22] px-4 py-3"
      style={{ background: 'linear-gradient(90deg, rgba(53,224,255,0.10), rgba(164,139,255,0.12), rgba(255,77,184,0.10))' }}
    >
      <span className="font-display text-[13px] font-bold uppercase tracking-[0.14em] text-ink">{label}</span>
      {rows.map((r) => (
        <span key={r.name} className="inline-flex min-w-0 items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim">{r.name}</span>
          <CopyChip text={r.value} label={r.value} />
        </span>
      ))}
    </div>
  )
}
