import { useQueries } from '@tanstack/react-query'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { TRADING_ENABLED } from '../lib/config/features'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { fetchFeeState } from '../lib/spectrum/use-fee-state'
import { chainCfg } from '../lib/chain/chains'
import { useFeeActions, useClaimAll, CLAIM_KEY, frontendKey, type ClaimAllItem } from '../lib/spectrum/use-fee-actions'
import { BasketAvatar } from './BasketAvatar'
import { useNetworkSwitch, type NetworkSwitch } from './WrongNetwork'

// Claimable holder fees, surfaced ON the portfolio (R+C walkthrough 2026-07-06:
// holders shouldn't have to find /flush). Self-hiding: renders nothing until a
// held basket actually has USDC to claim. The full crank console stays /flush.
/** The aggregation, reusable (the portfolio Earn card condenses to one number
 *  + Claim all; per-basket rows stay for surfaces that want the breakdown). */
export function usePortfolioClaimables(baskets: BasketSummary[]) {
  const { address } = useAccount()
  const results = useQueries({
    queries: baskets.map((b) => ({
      queryKey: ['spectrum', 'feeState', b.chainId, b.address.toLowerCase(), address?.toLowerCase()],
      queryFn: () => fetchFeeState(b.address as Address, b.chainId, address as Address | undefined),
      enabled: TRADING_ENABLED && !!address,
      staleTime: 15_000,
    })),
  })
  const me = address?.toLowerCase() ?? ''
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
  const items: ClaimAllItem[] = [
    ...claimable.map(({ b }) => ({ address: b.address as Address, chainId: b.chainId, kind: 'claim' as const })),
    ...created.map(({ b }) => ({ address: b.address as Address, chainId: b.chainId, kind: 'flush' as const })),
  ]
  const totalUsdc = [...claimable, ...created].reduce((s, x) => s + x.usdc, 0)
  // A failed read coerces to 0 and then gets filtered OUT, so the basket silently
  // vanished from the list and the total, and the portfolio stated "$0.00
  // claimable" as fact (kit audit). The producer forbids exactly that — carry the
  // flag so the surfaces can say the figure may be incomplete.
  const degraded = results.some((r) => r.data?.degraded === true)
  return { claimable, created, items, totalUsdc, degraded }
}

export function PortfolioClaims({ baskets, className = '', bare = false, holderOnly = false }: { baskets: BasketSummary[]; className?: string;
  /** Content-only: the caller's card owns the chrome (the portfolio Earn card). */
  bare?: boolean;
  /** Render ONLY the holder-fee bucket, hiding the created/fee-tag rows. /earn
   *  already shows the fee-tag pot as its headline, with its own claim-all and
   *  its own $10 mainnet crank floor — repeating `created` there would count the
   *  same money twice, hand a sub-floor pot a Flush button that is guaranteed to
   *  revert, and start a second claim-all whose re-entrancy guard the first one
   *  cannot see (all three caught in review, 2026-08-01). */
  holderOnly?: boolean }) {
  const { address } = useAccount()
  const ca = useClaimAll()
  const agg = usePortfolioClaimables(baskets)
  const { claimable } = agg
  const created = holderOnly ? [] : agg.created
  const items = holderOnly ? agg.items.filter((i) => i.kind === 'claim') : agg.items
  const totalUsdc = holderOnly ? claimable.reduce((s, x) => s + x.usdc, 0) : agg.totalUsdc
  if (!TRADING_ENABLED || !address) return null
  if (claimable.length === 0 && created.length === 0) return null
  const rowCount = claimable.length + created.length
  const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <section className={bare ? className : `rounded-2xl border border-teal/25 bg-teal/[0.04] p-4 ${className}`}>
      {/* SCALES with the number of baskets (owner 2026-07-29: "it shouldn't push
          the card down"). Up to two, the full rows fit and each keeps its own
          button. Beyond that everything collapses to ONE LINE — label, the
          avatar strip, the count and the Claim-all button on a single row
          (owner 2026-08-16: "beautify this across one line on creator page and
          on the portfolio fees popup") — with per-basket detail behind the
          same disclosure. */}
      {rowCount <= 2 ? (
        <>
          <div className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1.5 text-center">
            <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-teal">Claimable fees</span>
            {items.length >= 2 && (
              <button
                type="button"
                disabled={ca.running}
                onClick={() => void ca.claimAll(items)}
                className="press mx-auto rounded-lg border border-teal/50 bg-teal/15 px-3 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-teal hover:enabled:border-teal disabled:opacity-60"
              >
                {ca.running ? `Claiming ${ca.done + ca.failed}/${ca.total}…` : `Claim all ${fmtUsd(totalUsdc)}`}
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-2.5">
            {claimable.map(({ b, usdc }) => (
              <ClaimRow key={`h:${b.chainId}:${b.address}`} basket={b} usdc={usdc} />
            ))}
            {created.map(({ b, usdc }) => (
              <CreatorFlushRow key={`c:${b.chainId}:${b.address}`} basket={b} usdc={usdc} me={address} />
            ))}
          </div>
        </>
      ) : (
        <details className="group">
          <summary className="press flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-teal">Claimable fees</span>
            <span className="flex items-center gap-1">
              {[...claimable.map((x) => ({ ...x, k: 'h' })), ...created.map((x) => ({ ...x, k: 'c' }))].slice(0, 8).map(({ b, k }) => (
                <span key={`i:${k}:${b.chainId}:${b.address}`} title={`$${showSymbol(b.symbol)}`} className="ring-1 ring-white/10 rounded-lg">
                  <BasketAvatar address={b.address} symbol={b.symbol} size={22} />
                </span>
              ))}
              {rowCount > 8 && (
                <span className="ml-1 font-mono text-[10px] tabular-nums text-ink-faint">+{rowCount - 8}</span>
              )}
            </span>
            <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors group-hover:text-ink-dim">
              across {rowCount} baskets
              <span aria-hidden className="ml-1 inline-block transition-transform group-open:rotate-180">▾</span>
            </span>
            <span className="flex-1" />
            <button
              type="button"
              disabled={ca.running}
              onClick={(e) => {
                // a button in a <summary> — the press must claim, never toggle
                e.preventDefault()
                e.stopPropagation()
                void ca.claimAll(items)
              }}
              className="press rounded-lg border border-teal/50 bg-teal/15 px-3 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-teal hover:enabled:border-teal disabled:opacity-60"
            >
              {ca.running ? `Claiming ${ca.done + ca.failed}/${ca.total}…` : `Claim all ${fmtUsd(totalUsdc)}`}
            </button>
          </summary>
          <div className="mt-3 flex flex-wrap justify-center gap-2.5">
            {claimable.map(({ b, usdc }) => (
              <ClaimRow key={`h:${b.chainId}:${b.address}`} basket={b} usdc={usdc} />
            ))}
            {created.map(({ b, usdc }) => (
              <CreatorFlushRow key={`c:${b.chainId}:${b.address}`} basket={b} usdc={usdc} me={address} />
            ))}
          </div>
        </details>
      )}
      {(ca.error || ca.skippedOtherChain > 0) && !ca.running && (
        <p className="mt-1.5 font-mono text-[10px] text-ink-faint">
          {ca.error ?? ''}
          {ca.skippedOtherChain > 0 ? ` ${ca.skippedOtherChain} on another network, switch to claim those.` : ''}
        </p>
      )}
    </section>
  )
}

// ── A ROW THAT CANNOT ACT SAYS WHY, AND OFFERS THE WAY OUT ───────────────────
// `acts.enabled` goes false whenever the wallet sits on a chain other than the
// basket's (use-fee-actions.ts `walletReady`), so a multi-chain holder got a
// stack of greyed-out Claim/Flush buttons with no stated reason and no route
// forward — while the Claim-all control directly above them named that exact
// condition out loud ("N on another network — switch to claim those"). The row
// now spends its one button on the thing that IS possible. The switch comes
// from the house hook (WrongNetwork.tsx), so its wording, its offer-never-take
// rule, and its declined-in-words acknowledgement stay defined in one place.
function SwitchChainAction({ sw, chainId }: { sw: NetworkSwitch; chainId: number }) {
  return (
    <div className="ml-1 flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={sw.switchNow}
        disabled={sw.switching}
        className="press rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-200/90 hover:enabled:border-amber-400/70 disabled:opacity-60"
      >
        {sw.switching ? 'Confirm in wallet…' : `Switch to ${chainCfg(chainId).name}`}
      </button>
      {/* rule 4 of the house notice: a decline is neither failure nor success,
          so it is said rather than swallowed — and the offer stays up. */}
      {sw.declined && (
        <span className="max-w-[9rem] text-right font-mono text-[9px] leading-tight text-amber-300/90">
          Still on {sw.walletWords} — nothing was sent.
        </span>
      )}
    </div>
  )
}

function CreatorFlushRow({ basket, usdc, me }: { basket: BasketSummary; usdc: number; me: Address }) {
  const acts = useFeeActions(basket.address as Address, basket.chainId)
  const sw = useNetworkSwitch(basket.chainId)
  const st = acts.stateOf(frontendKey(me))
  const busy = st.status === 'signing' || st.status === 'confirming'
  // A flush of our own owns this button while it runs AND while it reports that
  // it landed: a wallet that wanders to another chain mid-flight must not steal
  // the progress label or the user's only receipt.
  const offerSwitch = sw.mismatch && !busy && st.status !== 'success'
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-void/40 py-2 pl-2.5 pr-2">
      <BasketAvatar address={basket.address} symbol={basket.symbol} size={26} />
      <div className="leading-tight">
        <div className="font-display text-sm font-semibold text-ink">
          ${showSymbol(basket.symbol)} <span className="font-mono text-[9px] uppercase text-ink-faint">creator</span>
        </div>
        <div className="font-num text-[11px] tabular-nums text-teal">
          ${usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>
      {offerSwitch ? (
        <SwitchChainAction sw={sw} chainId={basket.chainId} />
      ) : (
        <button
          type="button"
          disabled={busy || !acts.enabled}
          onClick={() => void acts.flushFrontend(me)}
          className="press ml-1 rounded-lg border border-teal/40 bg-teal/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-teal hover:enabled:border-teal/70 disabled:opacity-50"
        >
          {busy ? 'Flushing…' : st.status === 'success' ? 'Paid ✓' : 'Flush'}
        </button>
      )}
    </div>
  )
}

function ClaimRow({ basket, usdc }: { basket: BasketSummary; usdc: number }) {
  const acts = useFeeActions(basket.address as Address, basket.chainId)
  const sw = useNetworkSwitch(basket.chainId)
  const st = acts.stateOf(CLAIM_KEY)
  const busy = st.status === 'signing' || st.status === 'confirming'
  // Same rule as the flush row above: our own tx keeps the button until it has
  // both finished and said so.
  const offerSwitch = sw.mismatch && !busy && st.status !== 'success'
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-void/40 py-2 pl-2.5 pr-2">
      <BasketAvatar address={basket.address} symbol={basket.symbol} size={26} />
      <div className="leading-tight">
        <div className="font-display text-sm font-semibold text-ink">${showSymbol(basket.symbol)}</div>
        <div className="font-num text-[11px] tabular-nums text-teal">
          ${usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>
      {offerSwitch ? (
        <SwitchChainAction sw={sw} chainId={basket.chainId} />
      ) : (
        <button
          type="button"
          disabled={busy || !acts.enabled}
          onClick={() => void acts.claim()}
          className="press ml-1 rounded-lg border border-teal/40 bg-teal/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-teal hover:enabled:border-teal/70 disabled:opacity-50"
        >
          {busy ? 'Claiming…' : st.status === 'success' ? 'Claimed ✓' : 'Claim'}
        </button>
      )}
    </div>
  )
}
