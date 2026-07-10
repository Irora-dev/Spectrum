import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { formatUnits, parseUnits, type Address } from 'viem'
import { useAccount, useSwitchChain } from 'wagmi'
import { chainCfg } from '../lib/chain/chains'
import { useBasketFees } from '../lib/spectrum/use-basket-fees'
import { useMigrate, type MigrateTxState } from '../lib/spectrum/use-migrate'
import { TRADING_ENABLED } from '../lib/config/features'
import { INTERFACE_TAG_ADDRESS } from '../lib/config/operator'
import { BasketDiff } from './BasketDiff'
import { SweepPanel } from './SweepPanel'
import { CompleteBanner } from './CompleteBanner'

// Holder "upgrade to the new version" modal — the LIVE in-kind path on the two
// on-chain primitives: redeemInKind out of the old version, then mintInKind into
// the new one (approvals in between; every tx simulated pre-sign — see
// use-migrate.ts). Overlapping constituents move in-kind; the delta trade
// bridges the composition difference (sell what v2 doesn't take, buy what the
// proceeds can't cover — shown in the plan before any signature; the rebalance
// variant funds every leg to the balanced target, migration-scoped). The upgrade
// itself is always the holder's explicit, opt-in choice — nothing migrates
// automatically. Gated by TRADING_ENABLED (preview-only when off). Migration
// copy — keep it mechanical and neutral: describe the basket in-kind delta only,
// never as a fund/index redemption right and never with a performance claim.
export function MigrateModal({
  open,
  onClose,
  fromAddr,
  fromSymbol,
  toAddr,
  toSymbol,
  chainId,
}: {
  open: boolean
  onClose: () => void
  fromAddr: string
  fromSymbol: string
  toAddr: string
  toSymbol: string
  chainId: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const cfg = chainCfg(chainId)
  const navigate = useNavigate()
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const { data: fees } = useBasketFees(open ? toAddr : undefined, chainId)
  const m = useMigrate(fromAddr, toAddr, chainId, open && TRADING_ENABLED)

  // Amount editing (display units of the OLD basket's shares); applied on
  // blur/Enter/MAX so typing never spams the planner.
  const [amtInput, setAmtInput] = useState<string | null>(null)
  // Which detail popup is open over the review screen (keeps the screen itself short).
  const [info, setInfo] = useState<null | 'more' | 'mechanic'>(null)
  const fromDecimals = m.plan?.from.decimals ?? 18
  const shownAmount = amtInput ?? (m.plan ? formatUnits(m.amount, fromDecimals) : '')
  const applyAmount = () => {
    if (amtInput == null || !m.plan) return
    try {
      const raw = parseUnits(amtInput, fromDecimals)
      m.setAmount(raw > m.plan.fromBalance ? m.plan.fromBalance : raw)
    } catch {
      /* unparseable input — keep the last applied amount */
    }
    setAmtInput(null)
  }

  if (!open) return null
  const feePct = fees?.basketFeeBps != null ? (fees.basketFeeBps / 100).toFixed(2) : null
  const wrongChain = isConnected && walletChainId !== chainId
  const busy = m.phase === 'running'

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Upgrade to $${toSymbol}`}
        onClick={(e) => e.stopPropagation()}
        className={`search-pop relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-3xl card-surface backdrop-blur-md ${
          m.phase === 'done' ? 'max-w-3xl' : 'max-w-lg'
        }`}
      >
        <div aria-hidden className="h-1 w-full shrink-0" style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
        <div className="overflow-y-auto p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Opt-in upgrade</div>
              <h2 className="mt-1 font-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                Upgrade to ${toSymbol}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="press grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-dim hover:bg-white/8 hover:text-ink"
            >
              ✕
            </button>
          </div>

          {/* REVIEW intro — a few easy lines; the full story + mechanics live behind
              popups so the screen fits the viewport. Hidden once migration starts. */}
          {m.phase !== 'running' && m.phase !== 'done' && m.phase !== 'error' && (
            <>
              {/* one line only — the DEX/what-trades detail lives in Read more
                  (owner 2026-07-06: hide it here, it duplicated the popup) */}
              <p className="mt-3 text-sm leading-relaxed text-ink-dim">
                Your holdings move into ${toSymbol} <span className="text-ink">in kind</span>.{' '}
                <button type="button" onClick={() => setInfo('more')} className="press font-medium text-cyan hover:underline">
                  Read more
                </button>
              </p>

              <div className="mt-4">
                <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">What changes</div>
                <BasketDiff prevAddr={fromAddr} nextAddr={toAddr} chainId={chainId} />
              </div>

              {/* mechanics behind an icon popup (fees · haircut · what moves vs. trades) */}
              <button
                type="button"
                onClick={() => setInfo('mechanic')}
                className="press mt-3 flex w-full items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-left hover:border-white/25"
              >
                <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-cyan/30 bg-cyan/10 text-cyan">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">How the fees &amp; mechanics work</span>
                  <span className="block font-mono text-[10px] text-ink-faint">exit haircut · basket fee · what moves vs. what trades</span>
                </span>
                <span aria-hidden className="ml-auto shrink-0 text-lg leading-none text-ink-faint">›</span>
              </button>
            </>
          )}

          {/* ── live migration panel ─────────────────────────────────────────── */}
          {TRADING_ENABLED && !isConnected && (
            <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-center font-mono text-[11px] text-ink-dim">
              Connect a wallet to migrate.
            </p>
          )}

          {TRADING_ENABLED && isConnected && wrongChain && (
            <button
              type="button"
              onClick={() => switchChain({ chainId })}
              className="press mt-4 w-full rounded-xl border border-cyan/40 bg-cyan/10 py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-cyan hover:bg-cyan/20"
            >
              Switch to {cfg.name}
            </button>
          )}

          {TRADING_ENABLED && isConnected && !wrongChain && (
            <>
              {m.phase === 'planning' && (
                <p className="mt-4 animate-pulse rounded-xl border border-white/10 bg-white/[0.02] p-4 text-center font-mono text-[11px] text-ink-dim">
                  Reading both baskets on {cfg.name}…
                </p>
              )}

              {m.phase === 'blocked' && m.blocker && (
                <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4 font-mono text-[11px] leading-relaxed text-ink-dim">
                  {m.blocker.kind === 'no-balance' && <>You hold no ${fromSymbol} in this wallet, nothing to migrate.</>}
                  {m.blocker.kind === 'zero-supply' && (
                    <>
                      ${toSymbol} has no supply yet, in-kind entry opens after its first regular buy
                      (swap-mint). Buy a small amount of ${toSymbol} first, then come back.
                    </>
                  )}
                  {m.blocker.kind === 'missing-legs' && (
                    <>
                      ${toSymbol} added constituents your redemption won&rsquo;t cover:{' '}
                      <span className="text-ink">{m.blocker.legs.map((l) => l.symbol).join(', ')}</span>, and
                      it dropped nothing that could be sold to fund them. Acquire those first, or buy $
                      {toSymbol} directly instead.
                    </>
                  )}
                  {m.blocker.kind === 'no-delta-config' && (
                    <>
                      ${toSymbol} added{' '}
                      <span className="text-ink">{m.blocker.legs.map((l) => l.symbol).join(', ')}</span>, which
                      needs the auto delta trade, but no Uniswap V3 router/quoter is configured on this build
                      (deployments.json). Acquire the assets manually, or buy ${toSymbol} directly.
                    </>
                  )}
                  {m.blocker.kind === 'no-route' && (
                    <>
                      No V3/WETH pool found to auto-trade{' '}
                      <span className="text-ink">{m.blocker.legs.map((l) => l.symbol).join(', ')}</span>. Trade
                      those manually, then reopen, or buy ${toSymbol} directly instead.
                    </>
                  )}
                  {m.blocker.kind === 'dust' && <>The migratable amount rounds to zero ${toSymbol} shares.</>}
                </div>
              )}

              {m.phase === 'ready' && m.plan && (
                <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Amount</span>
                    <div className="flex items-center gap-2">
                      <input
                        value={shownAmount}
                        onChange={(e) => setAmtInput(e.target.value)}
                        onBlur={applyAmount}
                        onKeyDown={(e) => e.key === 'Enter' && applyAmount()}
                        disabled={busy || m.redeemDone}
                        inputMode="decimal"
                        className="w-36 rounded-lg border border-white/10 bg-transparent px-2 py-1 text-right font-mono text-[12px] text-ink outline-none focus:border-cyan/50 disabled:opacity-50"
                      />
                      <span className="font-mono text-[11px] text-ink-dim">${fromSymbol}</span>
                      <button
                        type="button"
                        disabled={busy || m.redeemDone}
                        onClick={() => {
                          setAmtInput(null)
                          if (m.plan) m.setAmount(m.plan.fromBalance)
                        }}
                        className="press rounded-md border border-white/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-dim hover:border-cyan/50 hover:text-cyan disabled:opacity-50"
                      >
                        Max
                      </button>
                    </div>
                  </div>

                  {/* headline: what you'll get. Detail folds away to keep it short. */}
                  <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px]">
                    <span className="text-ink-faint">You receive ≈</span>
                    <span className="tabular-nums text-ink">
                      {fmtAmt(m.plan.mint.targetShares, m.plan.to.decimals)} ${toSymbol}
                    </span>
                  </div>
                  {/* the trust line (owner decision): how much moves in kind vs. trades.
                      Priced values exist on the rebalance path; no-delta = pure in-kind. */}
                  {(() => {
                    const d = m.plan.delta
                    if (d?.totalValueWeth != null && d.totalValueWeth > 0n) {
                      const swappedRaw = d.potWeth > d.totalValueWeth ? d.totalValueWeth : d.potWeth
                      const swappedPct = Number((swappedRaw * 1000n) / d.totalValueWeth) / 10
                      const inKindPct = Math.round((100 - swappedPct) * 10) / 10
                      return (
                        <div className="mt-1 flex items-center justify-between gap-3 font-mono text-[11px]">
                          <span className="text-ink-faint">Route</span>
                          <span className="tabular-nums text-ink-dim">
                            ≈{inKindPct}% in-kind · ≈{swappedPct}% swapped
                          </span>
                        </div>
                      )
                    }
                    if (!d)
                      return (
                        <div className="mt-1 flex items-center justify-between gap-3 font-mono text-[11px]">
                          <span className="text-ink-faint">Route</span>
                          <span className="text-ink-dim">100% in-kind, no swaps needed</span>
                        </div>
                      )
                    return null
                  })()}
                  <details className="group mt-2">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint hover:text-ink-dim">
                      <svg viewBox="0 0 24 24" className="h-3 w-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                      Deposit &amp; trade detail
                    </summary>
                    <div className="mt-2 space-y-1 font-mono text-[11px] text-ink-dim">
                      {m.plan.to.legs.map((leg, i) => (
                        <div key={leg.asset} className="flex items-center justify-between gap-3">
                          <span className="text-ink-faint">deposit {leg.symbol}</span>
                          <span className="tabular-nums">{fmtAmt(m.plan!.mint.amounts[i], leg.decimals)}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-2">
                        <span className="text-ink-faint">floor (minShares)</span>
                        <span className="tabular-nums">{fmtAmt(m.plan.mint.minShares, m.plan.to.decimals)}</span>
                      </div>
                      {m.plan.delta && (
                        <div className="mt-1 space-y-1 border-t border-white/10 pt-2">
                          <div className="text-ink-faint">
                            {m.plan.deltaKind === 'rebalance'
                              ? 'rebalance, every leg funded to the balanced target (one tx, via WETH):'
                              : 'delta trade (one tx, via WETH):'}
                          </div>
                          {m.plan.delta.sells.map((s) => (
                            <div key={s.leg.asset} className="flex items-center justify-between gap-3">
                              <span className="text-ink-faint">sell {s.leg.symbol}</span>
                              <span className="tabular-nums">{fmtAmt(s.amountIn, s.leg.decimals)} → ~{fmtAmt(s.quotedWeth, 18)} WETH</span>
                            </div>
                          ))}
                          {m.plan.delta.buys.map((b) => (
                            <div key={b.leg.asset} className="flex items-center justify-between gap-3">
                              <span className="text-ink-faint">buy {b.leg.symbol}</span>
                              <span className="tabular-nums">~{fmtAmt(b.quotedOut, b.leg.decimals)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {!m.plan.delta && m.plan.dropped.length > 0 && (
                        <div className="mt-1 border-t border-white/10 pt-2 text-ink-faint">
                          leftover after: {m.plan.dropped.map(({ leg, out }) => `${fmtAmt(out, leg.decimals)} ${leg.symbol}`).join(' · ')}, sweepable at the end
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              )}

              {/* PROCESS view — replaces the review content while the migration runs
                  so you watch the actual steps happen (owner ask). */}
              {(m.phase === 'running' || m.phase === 'error') && (
                <MigrateStepper m={m} delta={hasDelta(m)} fromSymbol={fromSymbol} toSymbol={toSymbol} explorer={cfg.explorer} />
              )}

              {m.error && (
                <p className="mt-3 rounded-xl border border-magenta/30 bg-magenta/[0.06] p-3 font-mono text-[11px] leading-relaxed text-ink-dim">
                  {m.error}
                </p>
              )}

              {m.phase === 'done' && m.result ? (
                <div className="mt-4">
                  <CompleteBanner
                    title={`Welcome to $${toSymbol}`}
                    amount={`+${fmtAmt(m.result.shares, m.plan?.to.decimals ?? 18)} $${toSymbol}`}
                    // No leftover-teaser here: the sweep panel below speaks ONLY
                    // when something is genuinely worth sweeping (owner 13:57 —
                    // dust must not announce itself).
                    subtitle="Upgrade complete."
                    tone="spectral"
                    txHref={`${cfg.explorer}/tx/${m.result.mintHash}`}
                  />

                  {/* leftover sweep — turn residual constituents into shares or USDC,
                      replacing the old "dropped assets stay in your wallet" dead end.
                      The panel self-hides when there's nothing worth sweeping. */}
                  <SweepPanel
                    residue={m.residue}
                    basket={toAddr as Address}
                    chainId={chainId}
                    toSymbol={toSymbol}
                    feeBps={fees?.basketFeeBps ?? 0}
                    explorer={cfg.explorer}
                  />

                  {/* allowance honesty (owner decision): full-balance approvals stay
                      behind for convenience, say so + hand over the revoke lever. */}
                  {address && (
                    <p className="mt-3 text-center font-mono text-[10px] leading-relaxed text-ink-faint">
                      Token allowances to the swap router &amp; ${toSymbol} remain, so future sweeps need no
                      re-approval.{' '}
                      <a
                        href={`https://revoke.cash/address/${address}?chainId=${chainId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan hover:underline"
                      >
                        Review / revoke ↗
                      </a>
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      // The upgrade's destination IS the new basket — land there,
                      // not back on the old version's page (owner 13:57).
                      navigate(`/token?addr=${toAddr}&chain=${chainId}`)
                      onClose()
                    }}
                    className="press mt-3 w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:scale-[1.01]"
                    style={{ background: 'linear-gradient(90deg,var(--color-teal),var(--color-cyan))' }}
                  >
                    Done · view ${toSymbol} →
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy || m.phase === 'planning' || m.phase === 'blocked' || !m.plan || m.preview}
                  onClick={() => void m.execute()}
                  className="press mt-4 w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
                >
                  {busy
                    ? 'Migrating…'
                    : m.phase === 'error'
                      ? m.redeemDone
                        ? 'Resume migration'
                        : 'Retry migration'
                      : `Upgrade to $${toSymbol}`}
                </button>
              )}

              {/* demo baskets plan a display-only preview — say so instead of erroring */}
              {m.preview && (
                <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-ink-faint">
                  Demo basket, preview only; migration needs a real deployment.
                </p>
              )}

              {m.redeemDone && m.phase === 'error' && (
                <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-ink-faint">
                  Your ${fromSymbol} redemption already settled, its constituents are in your wallet. Resume
                  finishes the approvals + in-kind mint from there.
                </p>
              )}
            </>
          )}

          {!TRADING_ENABLED && (
            <>
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="mt-5 w-full cursor-not-allowed rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black opacity-60"
                style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
              >
                Upgrade to ${toSymbol}
              </button>
              <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-ink-faint">
                Preview only, this build does not broadcast transactions (trading is disabled).
              </p>
            </>
          )}
        </div>

        {/* detail popups over the review screen — keep the screen itself short */}
        {info && (
          <InfoPopup kind={info} fromSymbol={fromSymbol} toSymbol={toSymbol} feePct={feePct} onClose={() => setInfo(null)} />
        )}
      </div>
    </div>,
    document.body,
  )
}

function hasDelta(m: { plan: { delta: unknown } | null; deltaProgress: { total: number } }): boolean {
  return !!(m.plan && m.plan.delta) || m.deltaProgress.total > 0
}

// ── read-more / read-mechanic popup, layered over the review screen ───────────
function InfoPopup({
  kind,
  fromSymbol,
  toSymbol,
  feePct,
  onClose,
}: {
  kind: 'more' | 'mechanic'
  fromSymbol: string
  toSymbol: string
  feePct: string | null
  onClose: () => void
}) {
  return (
    <div className="absolute inset-0 z-[5] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-void/80 backdrop-blur-sm" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="search-pop relative max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/12 bg-panel-2 p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold text-ink">
            {kind === 'more' ? 'How the upgrade works' : 'Fees & mechanics'}
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" className="press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-dim hover:bg-white/8 hover:text-ink">✕</button>
        </div>
        {kind === 'more' ? (
          <div className="mt-3 space-y-2.5 text-sm leading-relaxed text-ink-dim">
            <p>${fromSymbol} is immutable and keeps working, exactly as it does now. Upgrading is opt-in; doing nothing keeps your current basket.</p>
            <p>The move is <span className="text-ink">in kind</span>: you redeem ${fromSymbol} for its underlying assets, then deposit the ones ${toSymbol} also holds straight back in. Assets both versions share never hit a DEX, so you avoid swap costs on the overlap.</p>
            <p>If ${toSymbol} swapped an asset out for a new one, only that changed slice trades: the dropped asset is sold and the added one bought with the proceeds, batched into a single transaction.</p>
            <p>Anything left over afterward (a dropped asset, or dust) is yours, you can sweep it into ${toSymbol} or cash it out to USDC at the end.</p>
          </div>
        ) : (
          <div className="mt-3 space-y-2.5 text-sm leading-relaxed text-ink-dim">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-[12px]">
              <span className="text-ink-faint">Overlapping assets</span><span className="text-ink">move in kind, no swap</span>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-[12px]">
              <span className="text-ink-faint">Dropped assets</span><span className="text-ink">sold, or swept after</span>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-[12px]">
              <span className="text-ink-faint">Basket fee</span><span className="text-ink">{feePct ? `${feePct}% ` : ''}exit + entry</span>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-[12px]">
              <span className="text-ink-faint">Price tolerances</span><span className="text-ink">≤1% swaps · 0.5% mint floor</span>
            </div>
            <p>The exit fee leaving ${fromSymbol} stays with its remaining holders; the entry fee into ${toSymbol} is taken in kind and distributed normally. The in-kind route only saves the DEX cost on shared assets, not the protocol fee.</p>
            <p>Tolerances protect, not cost: each swap is floored 1% under its live quote, the mint floor sits 0.5% under a measured dry-run, and a 0.3% buffer absorbs reserve drift between planning and execution. Worst-case friction is bounded by their sum; typical runs land well inside it.</p>
            {INTERFACE_TAG_ADDRESS && (
              <p className="text-ink-faint">This interface receives the protocol’s fixed interface share (about 5% of the fee) on upgrades made through it.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── animated migration stepper — the live process, one stage at a time ────────
type StepState = 'pending' | 'active' | 'done' | 'error'
function StepDot({ state, n }: { state: StepState; n: number }) {
  if (state === 'done')
    return (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-teal/50 bg-teal/15 text-teal">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      </span>
    )
  if (state === 'error')
    return <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-magenta/50 bg-magenta/15 font-mono text-[11px] text-magenta">✕</span>
  if (state === 'active')
    return (
      <span className="relative grid h-6 w-6 shrink-0 place-items-center rounded-full border border-cyan/60 bg-cyan/15 font-mono text-[10px] text-cyan">
        <span aria-hidden className="absolute inset-0 animate-ping rounded-full border border-cyan/50 motion-reduce:animate-none" />
        {n}
      </span>
    )
  return <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/12 font-mono text-[10px] text-ink-faint">{n}</span>
}

function StepLine({ state, title, hint, hash, explorer }: { state: StepState; title: string; hint?: string; hash?: string | null; explorer: string }) {
  const tone = state === 'error' ? 'text-magenta' : state === 'done' ? 'text-ink' : state === 'active' ? 'text-ink' : 'text-ink-faint'
  return (
    <div className="flex items-start gap-3">
      <StepDot state={state} n={0} />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className={`text-sm font-medium ${tone}`}>{title}</div>
        {hint && <div className="mt-0.5 font-mono text-[10px] text-ink-faint">{hint}</div>}
      </div>
      {hash && (
        <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="shrink-0 pt-0.5 font-mono text-[10px] text-cyan hover:underline">tx ↗</a>
      )}
    </div>
  )
}

interface StepperModel {
  phase: string
  stage: string
  redeemDone: boolean
  approveProgress: { done: number; total: number }
  deltaProgress: { done: number; total: number }
  txOf: (k: string) => MigrateTxState
}
function MigrateStepper({ m, delta, fromSymbol, toSymbol, explorer }: { m: StepperModel; delta: boolean; fromSymbol: string; toSymbol: string; explorer: string }) {
  const running = m.phase === 'running'
  // Approvals come BEFORE the trade (owner 2026-07-07 13:57: "approve the
  // assets, then trade the difference") — every signature in one stage, the
  // batched swap after, nothing asking mid-flow.
  const order = ['redeem', 'approve', ...(delta ? ['delta'] : []), 'mint'] as const
  const idx = (s: string) => order.indexOf(s as (typeof order)[number])
  const cur = idx(m.stage)
  // A stage is done once we've moved past it (or the whole migration is done),
  // active when it's the current stage while running, error on the failed stage.
  const st = (stage: string, tx?: MigrateTxState): StepState => {
    if (tx?.status === 'error') return 'error'
    if (m.phase === 'done') return 'done'
    const here = idx(stage)
    if (here < cur) return 'done'
    if (here === cur) return running ? 'active' : m.phase === 'error' ? 'error' : 'active'
    return 'pending'
  }
  const redeemState: StepState = m.txOf('redeem').status === 'error' ? 'error' : m.redeemDone ? 'done' : m.stage === 'redeem' ? (running ? 'active' : 'error') : 'pending'
  const approveState: StepState =
    m.approveProgress.total > 0 && m.approveProgress.done >= m.approveProgress.total ? 'done' : st('approve')
  return (
    <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Migrating</div>
      <StepLine state={redeemState} title={`Redeem $${fromSymbol}`} hint="burn the old version, receive its assets" hash={m.txOf('redeem').hash} explorer={explorer} />
      <div>
        <StepLine
          state={approveState}
          title="Approve the assets"
          hint={m.approveProgress.total > 0 ? `${m.approveProgress.done} of ${m.approveProgress.total} approved · all signatures up-front` : 'every signature up-front, nothing asks mid-flow'}
          explorer={explorer}
        />
        {m.approveProgress.total > 0 && (approveState === 'active' || approveState === 'done') && (
          <div className="ml-9 mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-cyan transition-all duration-500" style={{ width: `${Math.round((m.approveProgress.done / m.approveProgress.total) * 100)}%` }} />
          </div>
        )}
      </div>
      {delta && (
        <StepLine
          state={st('delta', m.txOf('delta-swap'))}
          title="Trade the difference"
          hint="one batched swap via WETH"
          hash={m.txOf('delta-swap').hash}
          explorer={explorer}
        />
      )}
      <StepLine state={st('mint', m.txOf('mint'))} title={`Mint $${toSymbol}`} hint="deposit the assets, receive the new version" hash={m.txOf('mint').hash} explorer={explorer} />
    </div>
  )
}

/** Compact raw-amount display: enough precision to be checkable, no noise. */
function fmtAmt(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals)
  const n = Number(s)
  if (!Number.isFinite(n)) return s
  if (n === 0) return '0'
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 })
}
