import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { chainCfg } from '../../lib/chain/chains'
import { LIFI_NATIVE } from '../../lib/spectrum/lifi'
import { formatAssetFloor, type PayAssetOption } from '../../lib/spectrum/thesis-pay-asset'
import { AssetLogo } from '../AssetLogo'
import { ChainBadge } from '../ChainBadge'
import { usdCents } from './run-lanes'

// ─────────────────────────────────────────────────────────────────────────────
// The thesis console's pay-source picker (the owner 2026-08-13: "you should
// probably be able to select the asset you want to swap out of here right?" —
// ruling his own 2026-08-11 question). BridgeFund's PayTokenPicker is the
// precedent and this wears its exact shell — portal, scrim, card surface,
// spectral strip, the same row grammar — but its universe is DELIBERATELY
// conservative (thesis-pay-asset.ts): the settlement default plus native ETH /
// WETH the wallet ACTUALLY holds on the thesis's own networks. Nothing the
// wallet doesn't hold is listed; an unreadable balance is never offered as
// available. Demo/disconnected shows the default alone and reads nothing.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export function PayAssetPicker({
  options,
  loading,
  current,
  spendableCents,
  networks,
  settlementWords,
  demo,
  onPick,
  onClose,
}: {
  /** Held+readable assets, or null when nothing was read (demo/disconnected). */
  options: PayAssetOption[] | null
  loading: boolean
  current: PayAssetOption | null
  spendableCents: number | null
  networks: number
  /** The settlement family's own names, e.g. "USDC · USDG". */
  settlementWords: string
  demo: boolean
  onPick: (opt: PayAssetOption | null) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = options ?? []

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[12vh]"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose what you pay from"
        onClick={(e) => e.stopPropagation()}
        className="search-pop relative w-full max-w-md overflow-hidden rounded-3xl card-surface backdrop-blur-md"
      >
        <div aria-hidden className="h-1 w-full" style={{ background: SPECTRAL }} />
        <div className="p-4">
          <div className="px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">you pay from</div>

          <div className="mt-2 space-y-1">
            {/* the default — today's flow, byte for byte */}
            <PickRow
              active={current == null}
              onPick={() => onPick(null)}
              left={
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.06] font-display text-sm font-bold text-ink">
                  $
                </span>
              }
              title="Settlement balances"
              sub={`${settlementWords} across ${networks} ${networks === 1 ? 'network' : 'networks'} — the default`}
              right={spendableCents != null ? usdCents(spendableCents) : null}
            />

            {rows.map((o) => (
              <PickRow
                key={`${o.chainId}:${o.address}`}
                active={current != null && current.chainId === o.chainId && current.address.toLowerCase() === o.address.toLowerCase()}
                onPick={() => onPick(o)}
                left={
                  o.address === LIFI_NATIVE ? (
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.06] font-display text-xs font-bold text-ink">
                      {o.symbol.slice(0, 4)}
                    </span>
                  ) : (
                    <AssetLogo address={o.address} symbol={o.symbol} chainId={o.chainId} size={32} />
                  )
                }
                title={o.symbol}
                sub={
                  <span className="flex items-center gap-1.5">
                    <ChainBadge chainId={o.chainId} size="sm" />
                    <span>on {chainCfg(o.chainId).name}</span>
                  </span>
                }
                right={`${formatAssetFloor(o.balanceRaw, o.decimals)} held`}
              />
            ))}

            {loading && <p className="px-2 py-3 text-center font-mono text-[11px] text-ink-faint">Reading what this wallet holds…</p>}
            {!loading && options != null && rows.length === 0 && (
              <p className="px-2 py-3 text-center font-mono text-[11px] leading-relaxed text-ink-faint">
                No other spendable assets were readable in this wallet on these networks — only what you verifiably
                hold is ever offered.
              </p>
            )}
            {options == null && !loading && (
              <p className="px-2 py-3 text-center font-mono text-[11px] leading-relaxed text-ink-faint">
                {demo
                  ? 'The walkthrough spends settlement balances. On a live bundle, assets your wallet holds appear here.'
                  : 'Connect a wallet and its spendable assets appear here.'}
              </p>
            )}
          </div>

          <p className="mt-2 border-t border-white/[0.07] px-1 pt-2 font-mono text-[9px] uppercase leading-relaxed tracking-wider text-ink-faint">
            A non-settlement pick sells into each network&rsquo;s settlement first through LiFi, quoted before you
            sign; the basket buys themselves are unchanged and keep every protection.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function PickRow({
  active,
  onPick,
  left,
  title,
  sub,
  right,
}: {
  active: boolean
  onPick: () => void
  left: React.ReactNode
  title: string
  sub: React.ReactNode
  right: string | null
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={`press flex w-full items-center gap-3 rounded-2xl border px-2.5 py-2.5 text-left ${
        active ? 'border-cyan/40 bg-cyan/[0.06]' : 'border-transparent hover:bg-white/[0.05]'
      }`}
    >
      {left}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-display text-sm font-semibold text-ink">{title}</span>
          {active && (
            <span className="rounded-md border border-cyan/25 bg-cyan/[0.06] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-cyan/90">
              selected
            </span>
          )}
        </span>
        <span className="block truncate font-mono text-[10px] text-ink-faint">{sub}</span>
      </span>
      {right && <span className="shrink-0 font-num text-sm tabular-nums text-ink-dim">{right}</span>}
    </button>
  )
}
