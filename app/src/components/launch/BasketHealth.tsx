// Mechanical "basket health" readout for the weights step — diversification (how
// concentrated the weights are) + an aggregate slippage estimate from the routing
// pools' real depth. Factual liquidity math, NOT a performance/return projection.

const REF_MINT = 1000 // reference mint size for the slippage estimate, USD

interface HealthAsset {
  symbol: string
  address: string
  depthUsd: number | null
}

function fmtPct(n: number): string {
  if (n < 0.01) return '<0.01%'
  return `${n < 1 ? n.toFixed(2) : n.toFixed(1)}%`
}

export function BasketHealth({ assets, weights }: { assets: HealthAsset[]; weights: number[] }) {
  if (assets.length < 2) return null

  const total = weights.reduce((a, b) => a + (b || 0), 0) || 100
  const fracs = weights.map((w) => (w || 0) / total)
  const top = Math.round(Math.max(...weights.map((w) => w || 0)))

  // Aggregate price impact for a reference mint: each asset takes w·T through its pool,
  // impact_i ≈ (w·T)/depth_i; NAV-weighted ⇒ T·Σ(w_frac² / depth_i).
  let impact = 0
  let unpriced = 0
  fracs.forEach((f, i) => {
    const d = assets[i]?.depthUsd
    if (d == null || d <= 0) {
      unpriced++
      return
    }
    impact += (f * f * REF_MINT) / d
  })
  const slip = impact * 100
  const allUnpriced = unpriced === assets.length

  const conc =
    top <= 45 ? { c: 'var(--color-teal)', t: 'Balanced' } : top <= 70 ? { c: 'var(--color-amber)', t: 'Tilted' } : { c: '#ff4d6d', t: 'Concentrated' }
  const liq = slip < 0.5 ? { c: 'var(--color-teal)', t: 'Deep' } : slip < 2 ? { c: 'var(--color-amber)', t: 'Moderate' } : { c: '#ff4d6d', t: 'Thin' }

  // The verdict sits IN the value line (owner 13:46: "Tilted"/"Deep" inline
  // with "3 assets · top 48%" / "0.1% slip"), and the whole readout steps up
  // a size so it actually reads.
  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[13px] uppercase tracking-[0.18em] text-ink-dim">Basket health</span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">estimate</span>
      </div>
      <div className="grid grid-cols-2 gap-5">
        {/* diversification / concentration */}
        <div>
          <span className="font-mono text-xs uppercase tracking-wide text-ink-faint">Spread</span>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-mono text-[15px] font-bold uppercase tracking-wide" style={{ color: conc.c }}>
              {conc.t}
            </span>
            <span className="font-num text-xl font-bold tabular-nums text-ink">{assets.length}</span>
            <span className="font-mono text-xs text-ink-dim">assets · top {top}%</span>
          </div>
          <div aria-hidden className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/8">
            <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${top}%`, background: conc.c }} />
          </div>
        </div>

        {/* routing liquidity / slippage */}
        <div>
          <span className="font-mono text-xs uppercase tracking-wide text-ink-faint">Liquidity</span>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-mono text-[15px] font-bold uppercase tracking-wide" style={{ color: liq.c }}>
              {allUnpriced ? '—' : liq.t}
            </span>
            <span className="font-num text-xl font-bold tabular-nums" style={{ color: allUnpriced ? '#a7a8bb' : liq.c }}>
              {allUnpriced ? '—' : `≈${fmtPct(slip)}`}
            </span>
            <span className="font-mono text-xs text-ink-dim">slip · $1k mint</span>
          </div>
          <div className="mt-2.5 font-mono text-[11px] leading-tight text-ink-faint">
            {unpriced > 0 ? `${unpriced} pool${unpriced > 1 ? 's' : ''} unmeasured` : 'from live routing-pool depth'}
          </div>
        </div>
      </div>
    </div>
  )
}
