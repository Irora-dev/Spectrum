import { useQueries } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { TRADING_ENABLED } from '../lib/config/features'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { fetchFeeState } from '../lib/spectrum/use-fee-state'
import { useFeeActions, useClaimAll, CLAIM_KEY, frontendKey, type ClaimAllItem } from '../lib/spectrum/use-fee-actions'
import { BasketAvatar } from './BasketAvatar'

// Claimable holder fees, surfaced ON the portfolio (R+C walkthrough 2026-07-06:
// holders shouldn't have to find /flush). Self-hiding: renders nothing until a
// held basket actually has USDC to claim. The full crank console stays /flush.
export function PortfolioClaims({ baskets, className = '' }: { baskets: BasketSummary[]; className?: string }) {
  const { address } = useAccount()
  const ca = useClaimAll()
  const results = useQueries({
    queries: baskets.map((b) => ({
      queryKey: ['spectrum', 'feeState', b.chainId, b.address.toLowerCase(), address?.toLowerCase()],
      queryFn: () => fetchFeeState(b.address as Address, b.chainId, address as Address | undefined),
      enabled: TRADING_ENABLED && !!address,
      staleTime: 15_000,
    })),
  })
  if (!TRADING_ENABLED || !address) return null
  const me = address.toLowerCase()
  const claimable = baskets
    .map((b, i) => ({ b, usdc: results[i].data?.claimableUsdc ?? 0 }))
    .filter((x) => x.usdc > 0.005)
  // CREATED fees: my pending creator/launcher accruals on these baskets
  // ("holding fees or created fees" — recording 2026-07-06 12:08)
  const created = baskets
    .map((b, i) => ({
      b,
      usdc: (results[i].data?.frontend ?? [])
        .filter((f) => f.address.toLowerCase() === me)
        .reduce((s, f) => s + f.pendingUsdc, 0),
    }))
    .filter((x) => x.usdc > 0.005)
  if (claimable.length === 0 && created.length === 0) return null

  // one-button sweep across every row (owner 2026-07-07): holder claims +
  // creator flushes, sequenced on the current chain.
  const items: ClaimAllItem[] = [
    ...claimable.map(({ b }) => ({ address: b.address as Address, chainId: b.chainId, kind: 'claim' as const })),
    ...created.map(({ b }) => ({ address: b.address as Address, chainId: b.chainId, kind: 'flush' as const })),
  ]
  const totalUsdc = [...claimable, ...created].reduce((s, x) => s + x.usdc, 0)
  const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <section className={`rounded-2xl border border-teal/25 bg-teal/[0.04] p-4 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-teal">Claimable fees</span>
        <span className="font-mono text-[10px] text-ink-faint">accrued to you · paid in USDC</span>
        {items.length >= 2 && (
          <button
            type="button"
            disabled={ca.running}
            onClick={() => void ca.claimAll(items)}
            className="press ml-auto rounded-lg border border-teal/50 bg-teal/15 px-3 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-teal hover:enabled:border-teal disabled:opacity-60"
          >
            {ca.running ? `Claiming ${ca.done + ca.failed}/${ca.total}…` : `Claim all ${fmtUsd(totalUsdc)}`}
          </button>
        )}
      </div>
      {(ca.error || ca.skippedOtherChain > 0) && !ca.running && (
        <p className="mt-1.5 font-mono text-[10px] text-ink-faint">
          {ca.error ?? ''}
          {ca.skippedOtherChain > 0 ? ` ${ca.skippedOtherChain} on another network — switch to claim those.` : ''}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2.5">
        {claimable.map(({ b, usdc }) => (
          <ClaimRow key={`h:${b.chainId}:${b.address}`} basket={b} usdc={usdc} />
        ))}
        {created.map(({ b, usdc }) => (
          <CreatorFlushRow key={`c:${b.chainId}:${b.address}`} basket={b} usdc={usdc} me={address} />
        ))}
      </div>
    </section>
  )
}

function CreatorFlushRow({ basket, usdc, me }: { basket: BasketSummary; usdc: number; me: Address }) {
  const acts = useFeeActions(basket.address as Address, basket.chainId)
  const st = acts.stateOf(frontendKey(me))
  const busy = st.status === 'signing' || st.status === 'confirming'
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-void/40 py-2 pl-2.5 pr-2">
      <BasketAvatar address={basket.address} symbol={basket.symbol} size={26} />
      <div className="leading-tight">
        <div className="font-display text-sm font-semibold text-ink">
          ${basket.symbol} <span className="font-mono text-[9px] uppercase text-ink-faint">creator</span>
        </div>
        <div className="font-num text-[11px] tabular-nums text-teal">
          ${usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>
      <button
        type="button"
        disabled={busy || !acts.enabled}
        onClick={() => void acts.flushFrontend(me)}
        className="press ml-1 rounded-lg border border-teal/40 bg-teal/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-teal hover:enabled:border-teal/70 disabled:opacity-50"
      >
        {busy ? 'Flushing…' : st.status === 'success' ? 'Paid ✓' : 'Flush'}
      </button>
    </div>
  )
}

function ClaimRow({ basket, usdc }: { basket: BasketSummary; usdc: number }) {
  const acts = useFeeActions(basket.address as Address, basket.chainId)
  const st = acts.stateOf(CLAIM_KEY)
  const busy = st.status === 'signing' || st.status === 'confirming'
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-void/40 py-2 pl-2.5 pr-2">
      <BasketAvatar address={basket.address} symbol={basket.symbol} size={26} />
      <div className="leading-tight">
        <div className="font-display text-sm font-semibold text-ink">${basket.symbol}</div>
        <div className="font-num text-[11px] tabular-nums text-teal">
          ${usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>
      <button
        type="button"
        disabled={busy || !acts.enabled}
        onClick={() => void acts.claim()}
        className="press ml-1 rounded-lg border border-teal/40 bg-teal/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-teal hover:enabled:border-teal/70 disabled:opacity-50"
      >
        {busy ? 'Claiming…' : st.status === 'success' ? 'Claimed ✓' : 'Claim'}
      </button>
    </div>
  )
}
