import { useMemo, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import { useSweep, type ResidueToken, type SweepTxState } from '../lib/spectrum/use-sweep'
import { AssetLogo } from './AssetLogo'
import { CompleteBanner } from './CompleteBanner'

// The leftover sweep, rendered in the MigrateModal done state. When a version
// migration leaves residual constituents in the wallet, this converts them — in
// one tap — into more shares (Compound) or USDC (Cash out). Mirrors the handoff
// mockup (frontend/handover/leftover-sweep/mockup.html) in the app's own system:
// card surfaces, the .press affordance, inline colored status (cyan confirming ·
// teal success · magenta error — no toasts), real token icons. Sweeping is always
// opt-in; dust worth less than its gas is skipped, not swept at a loss.
//
// SCOPE (owner decisions, 2026-07-05): defaults to the residue THIS migration
// left behind (measured against the pre-flow baseline) — never pre-existing
// holdings. "Include wallet balances" is the explicit opt-in to the wider sweep.
// When the whole leftover is worth about what the sweep costs in gas, the panel
// says so and de-emphasizes the button — visible, honest, never hidden.

const fmtAmt = (raw: bigint, decimals: number): string => {
  const n = Number(formatUnits(raw, decimals))
  if (!Number.isFinite(n)) return '0'
  if (n === 0) return '0'
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}
const fmtUsd = (raw6: bigint): string => {
  const n = Number(formatUnits(raw6, 6))
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function StepRow({ label, tx, explorer }: { label: string; tx: SweepTxState; explorer: string }) {
  const state =
    tx.status === 'success'
      ? '✓'
      : tx.status === 'signing'
        ? 'sign in wallet…'
        : tx.status === 'confirming'
          ? 'confirming…'
          : tx.status === 'error'
            ? 'failed'
            : '—'
  const tone =
    tx.status === 'error' ? 'text-magenta' : tx.status === 'success' ? 'text-teal' : tx.status === 'confirming' ? 'text-cyan' : 'text-ink-faint'
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-dim">{label}</span>
      <span className={tone}>
        {tx.hash ? (
          <a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer" className="hover:underline">
            {state} ↗
          </a>
        ) : (
          state
        )}
      </span>
    </div>
  )
}

export function SweepPanel({
  residue,
  basket,
  chainId,
  toSymbol,
  feeBps,
  explorer,
}: {
  residue: ResidueToken[]
  basket: Address
  chainId: number
  toSymbol: string
  feeBps: number
  explorer: string
}) {
  // Scope: 'migration' (default) sweeps only what THIS upgrade left behind;
  // 'wallet' is the explicit opt-in to include pre-existing balances too.
  const [scope, setScope] = useState<'migration' | 'wallet'>('migration')
  const migrationTokens = useMemo(() => residue.filter((r) => r.amount > 0n), [residue])
  const walletTokens = useMemo(
    () => residue.map((r) => ({ ...r, amount: r.walletBalance ?? r.amount })).filter((r) => r.amount > 0n),
    [residue],
  )
  const hasWider = walletTokens.some((w) => {
    const m = residue.find((r) => r.address === w.address)
    return m != null && w.amount > m.amount
  })
  const tokens = scope === 'wallet' ? walletTokens : migrationTokens

  const s = useSweep({ residue: tokens, basket, chainId, feeBps, open: true })
  const { phase, quote, mode, compoundAvailable } = s
  const busy = phase === 'running'

  const scopeToggle = hasWider && !busy && phase !== 'done' && (
    <button
      type="button"
      onClick={() => setScope(scope === 'migration' ? 'wallet' : 'migration')}
      className="press mt-2 flex w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-void/30 px-3 py-2 text-left font-mono text-[10px] text-ink-dim hover:border-white/20"
    >
      <span
        aria-hidden
        className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded border ${scope === 'wallet' ? 'border-cyan/60 bg-cyan/20 text-cyan' : 'border-white/20 text-transparent'}`}
      >
        ✓
      </span>
      Include wallet balances not from this upgrade
    </button>
  )

  // Sweep infra not configured on this build → keep the honest old behavior.
  if (!s.configured) {
    return (
      <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-center font-mono text-[11px] text-ink-faint">
        Any leftover constituents stay in your wallet.
      </p>
    )
  }

  if (phase === 'quoting') {
    return (
      <p className="mt-4 animate-pulse rounded-xl border border-white/10 bg-white/[0.02] p-3 text-center font-mono text-[11px] text-ink-dim">
        Checking your leftover…
      </p>
    )
  }

  // Nothing worth sweeping in this scope: SAY NOTHING (owner 2026-07-07 13:57 —
  // "only sub-gas dust… nothing left to do" must not announce itself; the
  // banner already says the upgrade is complete). The wider-scope opt-in still
  // offers itself, but only when the wallet actually holds more of these assets.
  if (phase === 'empty') {
    if (!hasWider) return null
    return <div className="mt-1">{scopeToggle}</div>
  }

  // Done — a congratulatory close to the whole flow.
  if (phase === 'done' && s.result) {
    const r = s.result
    return (
      <div className="mt-4">
        <CompleteBanner
          title="Swept clean"
          amount={r.mode === 'compound' && r.shares != null ? `+${fmtAmt(r.shares, 18)} $${toSymbol}` : `${fmtUsd(r.usdc)} USDC`}
          subtitle={`${r.mode === 'compound' ? 'Compounded into your position.' : 'Cashed out to your wallet.'} Wallet leftover: 0.`}
          tone="teal"
          txHref={r.hash && r.hash !== '0x' ? `${explorer}/tx/${r.hash}` : undefined}
        />
      </div>
    )
  }

  // Ready / running / error — the sweep offer.
  if (!quote) return null
  const minReceived = quote.survivors.reduce((acc, r) => acc + (r.usdcOut ?? 0n), 0n)
  // Aggregate gas honesty (owner decision): estimate the whole sweep's gas from
  // the per-leg unit (compound adds ~a basket mint on top) — when the leftover
  // is worth about that, say so and de-emphasize, but never hide the button.
  const swapCount = quote.survivors.filter((r) => !r.isUsdc).length
  const totalGasEst = quote.gasCostUsdc * BigInt(Math.max(1, swapCount) + (mode === 'compound' ? 5 : 0))
  const marginal = quote.totalUsdc < totalGasEst

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      {/* Two columns on wide screens (leftover | action) so it fits by width, not
          height; stacks on mobile where the modal scrolls. */}
      <div className="gap-5 lg:grid lg:grid-cols-2">
        {/* ── LEFT: the leftover ─────────────────────────────────────────── */}
        <div>
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.24em] text-amber-300">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-300" /> Leftover
          </span>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
            {scope === 'migration' ? 'What this upgrade left behind.' : 'All wallet balances of the involved assets.'}{' '}
            <span className="text-ink">Compound</span> them into ${toSymbol}, or <span className="text-ink">cash out</span> to USDC.
          </p>

          <div className="mt-3 max-h-44 space-y-1.5 overflow-y-auto pr-0.5">
            {quote.rows.map((r) => (
              <div
                key={r.token.address}
                className={`flex items-center gap-3 rounded-lg border border-white/[0.06] bg-void/40 px-3 py-2 ${r.skip === 'dust' || r.skip === 'no-route' ? 'opacity-55' : ''}`}
              >
                <AssetLogo address={r.token.address} symbol={r.token.symbol} chainId={chainId} size={24} />
                <div className="min-w-0">
                  <div className="font-mono text-[12px] text-ink">{r.token.symbol}</div>
                  {r.skip && (
                    <div className="font-mono text-[10px] text-ink-faint">{r.skip === 'dust' ? 'skip · below gas cost' : 'skip · no route'}</div>
                  )}
                </div>
                <div className="ml-auto text-right">
                  <div className="font-num text-[13px] text-ink">{fmtAmt(r.token.amount, r.token.decimals)}</div>
                  {r.usdcOut != null && <div className="font-mono text-[10px] text-ink-dim">≈ {fmtUsd(r.usdcOut)}</div>}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-2 flex items-center justify-between px-1 font-mono text-[11px] text-ink-dim">
            <span>Sweepable now</span>
            <span className="font-num text-ink">{fmtUsd(quote.totalUsdc)}</span>
          </div>
          {scopeToggle}
        </div>

        {/* ── RIGHT: the action ──────────────────────────────────────────── */}
        <div className="mt-4 flex flex-col lg:mt-0">
          <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-white/[0.08] bg-void/50 p-1">
            {(['compound', 'cashout'] as const).map((mo) => {
              const on = mode === mo
              const disabled = mo === 'compound' && !compoundAvailable
              return (
                <button
                  key={mo}
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => s.setMode(mo)}
                  aria-selected={on}
                  className={`press flex flex-col items-center gap-1 rounded-lg px-3 py-2.5 transition-colors disabled:opacity-40 ${
                    on ? 'bg-white/10 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]' : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  <span className="font-display text-[15px] font-semibold">{mo === 'compound' ? 'Compound' : 'Cash out'}</span>
                  <span className="font-mono text-[10px] tracking-[0.06em] text-ink-dim">{mo === 'compound' ? `more $${toSymbol}` : 'to USDC'}</span>
                </button>
              )
            })}
          </div>

          <div className="mt-3 rounded-xl border border-white/[0.09] bg-void/50 p-3.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">You&rsquo;ll receive</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-num text-2xl font-medium text-ink">{fmtUsd(quote.totalUsdc)}</span>
              <span className="font-display text-sm text-ink-dim">{mode === 'compound' ? `into $${toSymbol}` : 'USDC'}</span>
            </div>
            <div className="mt-1.5 hidden font-mono text-[11px] leading-relaxed text-ink-faint sm:block">
              {mode === 'compound'
                ? `Buys more $${toSymbol} at the live quote, floored by a min-received you approve before signing.`
                : `Left in your wallet as USDC. Min ${fmtUsd(minReceived === 0n ? quote.totalUsdc : (minReceived * 99n) / 100n)} after 1% slippage.`}
            </div>
          </div>

          {(busy || phase === 'error') && (
            <div className="mt-3 space-y-1.5 rounded-xl border border-white/10 bg-white/[0.02] p-3 font-mono text-[11px]">
              <StepRow label="Swap leftover → USDC" tx={s.txOf('swap')} explorer={explorer} />
              {mode === 'compound' && <StepRow label={`Compound into $${toSymbol}`} tx={s.txOf('compound')} explorer={explorer} />}
            </div>
          )}

          {s.error && (
            <p className="mt-3 rounded-xl border border-magenta/30 bg-magenta/[0.06] p-3 font-mono text-[11px] leading-relaxed text-ink-dim">
              {s.error}
            </p>
          )}

          {marginal && !busy && (
            <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-2.5 text-center font-mono text-[10px] leading-relaxed text-ink-dim">
              Worth about what the sweep costs in gas (~{fmtUsd(totalGasEst)}), fine to leave it.
            </p>
          )}

          <button
            type="button"
            disabled={busy || !s.walletReady}
            onClick={() => void s.execute()}
            className={
              marginal
                ? 'press mt-3 w-full rounded-xl border border-white/15 py-3 font-display text-sm font-bold uppercase tracking-[0.12em] text-ink-dim hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50'
                : 'press mt-3 w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.12em] text-black disabled:cursor-not-allowed disabled:opacity-50'
            }
            style={marginal ? undefined : { background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
          >
            {busy ? 'Sweeping…' : phase === 'error' ? 'Retry sweep' : mode === 'compound' ? `Compound into $${toSymbol}` : 'Cash out to USDC'}
          </button>
          <p className="mt-2 hidden text-center font-mono text-[10px] leading-relaxed text-ink-faint sm:block">
            Swaps batch into one transaction. Always opt-in.
          </p>
        </div>
      </div>
    </div>
  )
}
