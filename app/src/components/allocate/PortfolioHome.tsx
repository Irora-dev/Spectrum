import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { useBalance } from 'wagmi'
import { formatUsdCompact } from '../../lib/spectrum/format'
import {
  emptyDraft,
  loadExec,
  loadPortfolio,
  normalizedTargets,
  planProgress,
  saveDraft,
  type AllocationDraft,
  type ExecutionPlan,
  type FlowIntent,
  type SavedPortfolio,
} from '../../lib/spectrum/allocation'
import { PortfolioFlow } from './PortfolioFlow'

// ─────────────────────────────────────────────────────────────────────────────
// STATION 0 — the portfolio home band (docs/allocator/PORTFOLIO-FLOW.md).
// the owner's opening beat: the value in your wallet, an empty portfolio, one
// button. Once a portfolio exists (or a run is mid-flight) the band flips to
// that state. Mounted at the top of /portfolio; the page's existing holdings
// content continues below (the full merge is Phase 2).
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
const fixtureMode = import.meta.env.VITE_DEV_FIXTURE === '1'
const DEMO_WALLET_USD = 4826.19

/** Kit accents, cycled, for the allocation's segments — reuse, never a new palette. */
const SEG = ['var(--color-cyan)', 'var(--color-violet-bright)', 'var(--color-magenta)', 'var(--color-amber)', 'var(--color-teal)']

/** The value in the wallet, read honestly: a shimmer while reading, never a
 *  silent $0 from an error. Simulation supplies a demo value after a beat (so
 *  the reading state is a real, reviewable moment); live mode sums native
 *  balances and says plainly that dollar pricing arrives with live wiring. */
function useWalletValue(address: string): { usd: number | null; label: string | null; reading: boolean } {
  const [demoReady, setDemoReady] = useState(false)
  useEffect(() => {
    if (!fixtureMode) return
    const t = window.setTimeout(() => setDemoReady(true), 700)
    return () => window.clearTimeout(t)
  }, [])

  const addr = address as `0x${string}`
  const enabled = !fixtureMode
  const eth = useBalance({ address: addr, chainId: 1, query: { enabled } })
  const base = useBalance({ address: addr, chainId: 8453, query: { enabled } })
  const rh = useBalance({ address: addr, chainId: 4663, query: { enabled } })

  if (fixtureMode) return demoReady ? { usd: DEMO_WALLET_USD, label: null, reading: false } : { usd: null, label: null, reading: true }

  const reads = [eth, base, rh]
  if (reads.every((r) => r.isPending)) return { usd: null, label: null, reading: true }
  const known = reads.filter((r) => r.data != null)
  const wei = known.reduce((s, r) => s + (r.data?.value ?? 0n), 0n)
  const ethTotal = Number(wei) / 1e18
  const partial = known.length < reads.length
  return {
    usd: null,
    label: `Ξ ${ethTotal.toLocaleString(undefined, { maximumFractionDigits: 4 })}${partial ? ' · part of your balance can’t be read right now' : ''}`,
    reading: false,
  }
}

function Bezel({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'amber' }) {
  return (
    <div className={`h-full rounded-[2rem] border p-1.5 ${tone === 'amber' ? 'border-amber-300/25 bg-amber-300/[0.03]' : 'border-white/10 bg-white/[0.03]'}`}>
      <div className="relative h-full overflow-hidden rounded-[calc(2rem-0.375rem)] bg-panel/70 shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)] backdrop-blur-md">
        {children}
      </div>
    </div>
  )
}

function WalletValue({ address }: { address: string }) {
  const v = useWalletValue(address)
  return (
    <Bezel>
      <div className="flex h-full flex-col justify-between p-6 sm:p-8">
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-dim">Value in your wallet</span>
        <div className="mt-6">
          {v.reading && (
            <div className="flex items-center gap-3">
              <span aria-hidden className="h-9 w-40 animate-pulse rounded-xl bg-white/[0.06]" />
              <span className="font-mono text-[11px] text-ink-faint">reading your wallet…</span>
            </div>
          )}
          {!v.reading && v.usd != null && (
            <div>
              <span className="flex items-baseline font-num text-6xl font-light leading-none tabular-nums text-ink">
                <span className="mr-1 text-3xl text-ink-faint">$</span>
                {v.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {fixtureMode && (
                <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/90">
                  simulated value
                </p>
              )}
            </div>
          )}
          {!v.reading && v.usd == null && v.label != null && (
            <div>
              <span className="font-num text-4xl font-light tabular-nums text-ink">{v.label.split(' · ')[0]}</span>
              {v.label.includes('·') && (
                <p className="mt-2 font-mono text-[11px] text-amber-300/85">{v.label.split(' · ')[1]}</p>
              )}
              <p className="mt-2 font-mono text-[10px] text-ink-faint">dollar pricing arrives with live wiring</p>
            </div>
          )}
        </div>
        <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          across all networks · read for you
        </p>
      </div>
    </Bezel>
  )
}

export function PortfolioHome({
  address,
  autoCreateIntent = null,
  onAutoCreate,
}: {
  address: string
  /** The landing DOOR hands its intent through the connect beat: when this
   *  arrives, the flow opens itself with that door already walked through. */
  autoCreateIntent?: FlowIntent | null
  onAutoCreate?: () => void
}) {
  const [nonce, setNonce] = useState(0)
  const [flowOpen, setFlowOpen] = useState(false)
  const [flowIntent, setFlowIntent] = useState<FlowIntent | undefined>(undefined)
  const [resume, setResume] = useState<ExecutionPlan | null>(null)

  const portfolio: SavedPortfolio | null = useMemo(() => loadPortfolio(address), [address, nonce])
  const pending: ExecutionPlan | null = useMemo(() => {
    const p = loadExec(address)
    return p && p.status === 'running' ? p : null
  }, [address, nonce])

  const openFresh = (intent: FlowIntent = 'keep') => {
    setResume(null)
    setFlowIntent(intent)
    setFlowOpen(true)
  }
  const openResume = () => {
    setResume(pending)
    setFlowIntent(undefined)
    setFlowOpen(true)
  }
  const openRebuild = () => {
    if (portfolio) {
      const d: AllocationDraft = { ...emptyDraft(), targets: portfolio.targets, amountUsd: portfolio.amountUsd }
      saveDraft(address, d)
    }
    setResume(null)
    setFlowIntent('keep')
    setFlowOpen(true)
  }
  const close = () => {
    setFlowOpen(false)
    setNonce((n) => n + 1)
  }

  // The DOOR's intent, honored after the connect beat: resume a mid-run build
  // first; otherwise ALWAYS open the flow with that door walked through
  // (the owner 18:41: "Create your portfolio… takes me to the end page. I need to
  // be able to [trial it]" — a create click means create, even when a saved
  // portfolio exists; completing Door A replaces it, which the flow says).
  useEffect(() => {
    if (!autoCreateIntent) return
    onAutoCreate?.()
    if (flowOpen) return
    if (pending) {
      openResume()
    } else {
      openFresh(autoCreateIntent)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCreateIntent])

  const norm = portfolio
    ? normalizedTargets({ targets: portfolio.targets, amountUsd: portfolio.amountUsd, intent: 'keep', updatedAt: 0 })
    : []

  return (
    <div className="mb-8">
      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(360px,440px)]">
        <WalletValue address={address} />

        {/* the portfolio object: empty seat → mid-run → live */}
        {pending ? (
          <Bezel tone="amber">
            <div className="flex h-full flex-col justify-between p-6 sm:p-8">
              <div>
                <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-amber-300/90">Build in progress</span>
                <p className="mt-4 text-[13px] leading-relaxed text-ink-dim">
                  Your portfolio was mid-build when this page closed — nothing was lost.
                </p>
              </div>
              <div className="mt-6">
                <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-ink-faint">
                  <span>
                    {planProgress(pending).done}/{planProgress(pending).total} steps
                  </span>
                </div>
                <div className="relative mt-2 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${(planProgress(pending).done / Math.max(1, planProgress(pending).total)) * 100}%`,
                      background: SPECTRAL,
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={openResume}
                  className="press mt-6 inline-flex h-12 items-center gap-3 rounded-full pl-6 pr-2 font-display text-sm font-bold uppercase tracking-[0.14em] text-void"
                  style={{ background: SPECTRAL }}
                >
                  Resume
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-black/15">→</span>
                </button>
              </div>
            </div>
          </Bezel>
        ) : portfolio ? (
          <Bezel>
            <div className="flex h-full flex-col p-6 sm:p-8">
              <div className="flex items-center justify-between gap-4">
                <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-dim">Your portfolio</span>
                {portfolio.simulated && (
                  <span className="rounded-full border border-amber-300/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/90">
                    simulated
                  </span>
                )}
              </div>

              {/* the allocation, as one bar — segments are the kit's own accents */}
              <div className="mt-6 flex h-3 gap-0.5 overflow-hidden rounded-full">
                {norm.map((t, i) => (
                  <span
                    key={`${t.asset.chainId}:${t.asset.address}`}
                    className="transition-[width] duration-700"
                    style={{ width: `${t.pct}%`, background: SEG[i % SEG.length], transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)' }}
                  />
                ))}
              </div>

              <div className="mt-6 space-y-2">
                {norm.slice(0, 4).map((t, i) => (
                  <div key={`${t.asset.chainId}:${t.asset.address}`} className="flex items-center gap-3">
                    <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: SEG[i % SEG.length] }} />
                    <span className="flex-1 font-display text-sm font-bold text-ink">${showSymbol(t.asset.symbol)}</span>
                    <span className="font-num text-sm tabular-nums text-ink-dim">{t.pct}%</span>
                  </div>
                ))}
                {norm.length > 4 && (
                  <p className="font-mono text-[10px] text-ink-faint">+{norm.length - 4} more</p>
                )}
              </div>

              <div className="mt-6 flex items-center justify-between gap-4 border-t border-white/10 pt-6">
                <span className="font-mono text-[11px] text-ink-dim">
                  invested <span className="font-semibold text-ink">{formatUsdCompact(portfolio.amountUsd)}</span>
                </span>
                <button
                  type="button"
                  onClick={openRebuild}
                  className="press inline-flex h-9 items-center rounded-full border border-white/15 px-4 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
                >
                  Rebuild
                </button>
              </div>
            </div>
          </Bezel>
        ) : (
          <button type="button" onClick={() => openFresh()} className="group h-full text-left">
            <div className="relative h-full overflow-hidden rounded-[2rem] border border-dashed border-white/15 bg-white/[0.02] p-6 transition-colors duration-500 group-hover:border-cyan/40 sm:p-8">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full opacity-0 blur-3xl transition-opacity duration-700 group-hover:opacity-25"
                style={{ background: 'var(--color-violet-bright)' }}
              />
              <div className="flex h-full flex-col items-start justify-between gap-6">
                <div>
                  <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-dim">Your portfolio</span>
                  <p className="mt-4 max-w-[36ch] text-[13px] leading-relaxed text-ink-dim">
                    Nothing here yet. Pick the assets you want, set the weights — routing is
                    handled for you, and everything lands in your own wallet.
                  </p>
                </div>
                <span className="flex items-center gap-4">
                  <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl">
                    <span aria-hidden className="forge-add-ring absolute -inset-1.5 rounded-[1.25rem] opacity-60 blur-md transition-opacity duration-500 group-hover:opacity-95" />
                    <span aria-hidden className="forge-add-ring absolute inset-0 rounded-2xl" />
                    <span aria-hidden className="absolute inset-[2px] rounded-[calc(1rem-2px)] bg-panel" />
                    <span className="relative font-mono text-xl leading-none text-ink">+</span>
                  </span>
                  <span
                    className="inline-flex h-12 items-center rounded-full pl-6 pr-6 font-display text-sm font-bold uppercase tracking-[0.14em] text-void transition-transform duration-500 group-hover:scale-[1.02]"
                    style={{ background: SPECTRAL }}
                  >
                    Create your onchain portfolio
                  </span>
                </span>
              </div>
            </div>
          </button>
        )}
      </div>

      {flowOpen && (
        <PortfolioFlow
          address={address}
          walletUsd={fixtureMode ? DEMO_WALLET_USD : null}
          onClose={close}
          onCreated={close}
          resumePlan={resume}
          initialIntent={flowIntent}
        />
      )}
    </div>
  )
}
