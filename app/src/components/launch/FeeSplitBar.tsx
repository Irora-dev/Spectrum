import { feeSplit } from '../../lib/spectrum/fee-model'

// ─────────────────────────────────────────────────────────────────────────────
// WHO GETS WHAT — the fee, drawn (owner 2026-08-12: "as simple, visual and
// easy as possible"). One stacked bar of the whole fee: the league slice
// where the lineage carries one, the PRISM burn, the fixed protocol slices,
// the creator's cut, and the holders' remainder — live against the two
// sliders, so the split is SEEN instead of computed in the reader's head.
//
// THE MATH IS fee-model's OWN feeSplit — the contract-exact, league-aware
// computation — never a local approximation (owner, live 2026-08-14: "this
// isnt accurate anymore is it" — he was right for the league lineage: the
// old local math omitted the league carve and overstated the creator at
// 24.00% where the contract pays 22.80%, the exact overstatement feeSplit's
// header documents from the kit audit). Conservative posture: interface +
// launcher present (the floor for creator/holders — unused slices only ever
// grow them). leagueBps 0 keeps non-league lineages byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

const fmt = (f: number) => `${(f * 100).toFixed(f * 100 % 1 === 0 ? 0 : 1)}%`

export function FeeSplitBar({ creatorShareBps, leagueBps = 0 }: { creatorShareBps: number; leagueBps?: number }) {
  const split = feeSplit(creatorShareBps, { hasInterface: true, hasLauncher: true, leagueBps })
  const segs = [
    // muted metal tones for the protocol-side slices (owner 2026-08-15: "less
    // colour for the creator/league/prism split") — the money YOU keep stays
    // the only loud color pair below
    ...(split.league > 0 ? [{ k: 'creator league', f: split.league, color: 'rgba(255,197,61,0.45)' }] : []),
    { k: 'PRISM burn', f: split.burn, color: 'rgba(255,79,216,0.4)' },
    { k: 'protocol', f: split.interface + split.launcher, color: 'rgba(255,255,255,0.22)' },
    ...(split.creator > 0 ? [{ k: 'you', f: split.creator, color: 'var(--color-cyan)' }] : []),
    { k: 'holders', f: split.holders, color: 'var(--color-teal)' },
  ]
  return (
    <div>
      <div className="flex h-[6px] w-full overflow-hidden rounded-full" role="img" aria-label={`Of every fee: ${segs.map((s) => `${fmt(s.f)} ${s.k}`).join(', ')}`}>
        {segs.map((s) => (
          <span key={s.k} className="h-full" style={{ width: `${s.f * 100}%`, background: s.color }} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        {segs.map((s) => (
          <span key={s.k} className="inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-faint">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
            {s.k} <span className="font-num tabular-nums text-ink-dim">{fmt(s.f)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
