import { useBasketDiff } from '../lib/spectrum/hooks'
import { AssetLogo } from './AssetLogo'
import type { ConstituentDiff } from '../lib/spectrum/versioning'

// On-chain diff between two basket versions: which constituents were added,
// removed, or reweighted. Purely factual (weights are on-chain facts) — never a
// performance/backtest claim.
const KIND_META: Record<ConstituentDiff['kind'], { label: string; color: string }> = {
  added: { label: 'Added', color: 'var(--color-teal)' },
  removed: { label: 'Removed', color: '#ff4d6d' },
  reweighted: { label: 'Reweighted', color: 'var(--color-amber)' },
  unchanged: { label: 'Unchanged', color: 'var(--color-ink-dim)' },
}

function wt(p: number | null): string {
  return p == null ? '—' : `${p.toFixed(p % 1 === 0 ? 0 : 1)}%`
}

function Chip({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em]"
      style={{ color, background: `${color}1a` }}
    >
      <span className="font-num font-bold tabular-nums">{n}</span>
      {label}
    </span>
  )
}

export function BasketDiff({
  prevAddr,
  nextAddr,
  chainId,
}: {
  prevAddr: string
  nextAddr: string
  chainId: number
}) {
  const { data: diff, isLoading } = useBasketDiff(prevAddr, nextAddr, chainId)

  if (isLoading) return <div className="h-28 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />
  if (!diff) return null

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap gap-2">
        <Chip n={diff.addedCount} label="added" color={KIND_META.added.color} />
        <Chip n={diff.removedCount} label="removed" color={KIND_META.removed.color} />
        <Chip n={diff.reweightedCount} label="reweighted" color={KIND_META.reweighted.color} />
      </div>

      <ul className="space-y-2">
        {diff.constituents.map((c) => {
          const m = KIND_META[c.kind]
          const removed = c.kind === 'removed'
          return (
            <li
              key={c.asset}
              className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-white/8 py-2.5 pl-4 pr-4"
              style={{ background: `linear-gradient(90deg, ${m.color}14, ${m.color}05 40%, rgba(255,255,255,0.02) 80%)` }}
            >
              <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: m.color }} />
              <AssetLogo address={c.asset} symbol={c.symbol} chainId={chainId} size={28} />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className={`font-display text-base font-bold ${removed ? 'text-ink-faint line-through' : 'text-ink'}`}>
                  {c.symbol}
                </span>
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide"
                  style={{ color: m.color, background: `${m.color}24` }}
                >
                  {m.label}
                </span>
              </div>
              <div className="shrink-0 font-num text-base tabular-nums">
                {c.kind === 'reweighted' ? (
                  <span className="flex items-center gap-2">
                    <span className="text-ink-faint">{wt(c.fromWeightPct)}</span>
                    <span aria-hidden style={{ color: m.color }}>→</span>
                    <span className="font-semibold text-ink">{wt(c.toWeightPct)}</span>
                  </span>
                ) : c.kind === 'added' ? (
                  <span className="font-semibold" style={{ color: m.color }}>+{wt(c.toWeightPct)}</span>
                ) : removed ? (
                  <span className="text-ink-faint line-through">{wt(c.fromWeightPct)}</span>
                ) : (
                  <span className="text-ink-dim">{wt(c.toWeightPct)}</span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
