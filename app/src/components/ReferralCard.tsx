import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useAccount } from 'wagmi'
import { useQueries } from '@tanstack/react-query'
import type { Address } from 'viem'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { readPendingFrontendFees } from '../lib/spectrum/use-fee-state'
import { refLinkFor } from '../lib/spectrum/referral'
import { creatorPath } from '../lib/spectrum/handle-registry'
import { useHandleForAddress } from '../lib/spectrum/use-handles'
import { frontendPotFlushable } from '../lib/spectrum/fee-model'
import { TRADING_ENABLED } from '../lib/config/features'

export interface ReferralEarnings {
  /** Everything accrued to this address, incl. pots still under a chain's crank floor. */
  total: number
  /** The subset of `total` that can actually be flushed right now (F-1: a
   *  mainnet pot at or under 10 USDC is refused by the contract). */
  claimableTotal: number
  items: { address: Address; chainId: number; usdc: number; symbol: string; flushable: boolean }[]
  /** STILL COUNTING. `total` sums `q.data ?? 0`, so a read in flight is
   *  indistinguishable from a zero balance — and /earn is a SHAREABLE page, so
   *  a cold load told a referrer with real pending fees "$0.00 · nothing to
   *  claim yet", confidently, for as long as the per-basket multicalls took.
   *  A caller must not present the total as final while this is true. */
  loading: boolean
}

// The connected address's total pending frontend-fee accrual across every basket
// — the interface slice earned on referred BUYS + the launcher slice on referred
// LAUNCHES (pendingFrontendFees is a single per-recipient bucket; interface,
// launcher and creator all accrue to it). Read directly for the arbitrary
// recipient — fetchFeeState only reads the operator/launcher/creator roles, so it
// would miss a pure referrer's interface earnings. Items feed the claim (flush).
export function useReferralEarned(): ReferralEarnings {
  const { address } = useAccount()
  const { data: allBaskets, isLoading: allBasketsLoading } = useAllBaskets()
  const results = useQueries({
    queries: (allBaskets ?? []).map((b) => ({
      queryKey: ['spectrum', 'pendingFrontend', b.chainId, b.address.toLowerCase(), address?.toLowerCase()],
      queryFn: () => readPendingFrontendFees(b.address as Address, b.chainId, address as Address),
      enabled: TRADING_ENABLED && !!address,
      staleTime: 30_000,
    })),
  })
  return useMemo(() => {
    const baskets = allBaskets ?? []
    const items: ReferralEarnings['items'] = []
    let total = 0
    let claimableTotal = 0
    results.forEach((q, i) => {
      const usdc = q.data ?? 0
      total += usdc
      const b = baskets[i]
      if (usdc > 0.005 && b) {
        const flushable = frontendPotFlushable(b.chainId, usdc)
        if (flushable) claimableTotal += usdc
        items.push({ address: b.address as Address, chainId: b.chainId, usdc, symbol: b.symbol, flushable })
      }
    })
    items.sort((a, b) => b.usdc - a.usdc)
    // The basket list has to land before a single per-basket read can start, so
    // "no baskets yet" is still counting rather than an answer.
    const loading = allBasketsLoading || results.some((q) => q.isPending)
    return { total, claimableTotal, items, loading }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    results.map((q) => q.data).join(','),
    results.map((q) => q.isPending).join(','),
    allBaskets,
    allBasketsLoading,
  ])
}

// Compact "Refer & earn" card for the Portfolio + creator dashboard: your link,
// what you've earned, and a way to the full page. Self-hides without a wallet.
export function ReferralCard({ className = '', creatorAddress = null, bare = false }: { className?: string; bare?: boolean;
  /** When set (a creator viewing their own portfolio), the shared link is their
   *  CREATOR PAGE (one link, every basket) instead of /explore — buys through
   *  it pay their creator fee PLUS the referral slice (owner 2026-07-29). */
  creatorAddress?: string | null }) {
  const { address, isConnected } = useAccount()
  const { total: earned } = useReferralEarned()
  const [copied, setCopied] = useState(false)
  // The link a creator DISTRIBUTES prefers their claimed name — this copy
  // button is where the URL system pays off. Address form when unnamed or
  // unresolved; every old link keeps working. (Hooks above the early return.)
  const { lookup: creatorHandle } = useHandleForAddress(creatorAddress)
  // …and the REF ITSELF rides the sharer's own claimed name too (owner
  // 2026-08-16: "surely the earn ref link can go through the creators name
  // e.g ref=iroradevtest rather than wallet address"). resolveRefInput has
  // resolved spectrum names since desk 202, so ?ref=<name> already captures;
  // this is the builder half catching up. Address when unnamed — never broken.
  const { lookup: myHandle } = useHandleForAddress(address)
  if (!isConnected || !address) return null
  const refWord = myHandle.status === 'found' ? myHandle.owner.display : address
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const link = creatorAddress
    ? refLinkFor(
        refWord,
        origin,
        creatorPath(creatorAddress, creatorHandle.status === 'found' ? creatorHandle.owner : null),
      )
    : refLinkFor(refWord, origin)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <section className={bare ? className : `rounded-2xl border border-violet/25 bg-violet/[0.04] p-4 ${className}`}>
      {!bare && (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-violet">Refer &amp; earn</span>
          <Link to="/earn" className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan hover:underline">
            Earn page →
          </Link>
        </div>
      )}
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-num text-2xl font-semibold tabular-nums text-ink">
          {TRADING_ENABLED ? `$${earned.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
        </span>
        {/* "pending", not "earned" — this balance zeroes on claim, and the
            EarnCard calls the same bucket pending (honesty audit R6) */}
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{creatorAddress ? 'pending · your page link: creator fee + ~5% referral' : 'pending · claim on portfolio'}</span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 font-mono text-[11px] text-ink-dim" title={link}>
          {link}
        </code>
        <button
          type="button"
          onClick={copy}
          className="press shrink-0 rounded-lg border border-violet/40 bg-violet/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-violet hover:border-violet/70"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </section>
  )
}
