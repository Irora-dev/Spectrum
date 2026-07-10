import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { useQueries } from '@tanstack/react-query'
import type { Address } from 'viem'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { readPendingFrontendFees } from '../lib/spectrum/use-fee-state'
import { refLinkFor } from '../lib/spectrum/referral'
import { TRADING_ENABLED } from '../lib/config/features'

export interface ReferralEarnings {
  total: number
  items: { address: Address; chainId: number; usdc: number; symbol: string }[]
}

// The connected address's total pending frontend-fee accrual across every basket
// — the interface slice earned on referred BUYS + the launcher slice on referred
// LAUNCHES (pendingFrontendFees is a single per-recipient bucket; interface,
// launcher and creator all accrue to it). Read directly for the arbitrary
// recipient — fetchFeeState only reads the operator/launcher/creator roles, so it
// would miss a pure referrer's interface earnings. Items feed the claim (flush).
export function useReferralEarned(): ReferralEarnings {
  const { address } = useAccount()
  const { data: allBaskets } = useAllBaskets()
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
    results.forEach((q, i) => {
      const usdc = q.data ?? 0
      total += usdc
      const b = baskets[i]
      if (usdc > 0.005 && b) items.push({ address: b.address as Address, chainId: b.chainId, usdc, symbol: b.symbol })
    })
    items.sort((a, b) => b.usdc - a.usdc)
    return { total, items }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((q) => q.data).join(','), allBaskets])
}

// Compact "Refer & earn" card for the Portfolio + creator dashboard: your link,
// what you've earned, and a way to the full page. Self-hides without a wallet.
export function ReferralCard({ className = '' }: { className?: string }) {
  const { address, isConnected } = useAccount()
  const { total: earned } = useReferralEarned()
  const [copied, setCopied] = useState(false)
  if (!isConnected || !address) return null
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const link = refLinkFor(address, origin)
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
    <section className={`rounded-2xl border border-violet/25 bg-violet/[0.04] p-4 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-violet">Refer &amp; earn</span>
        <Link to="/refer" className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan hover:underline">
          Referral page →
        </Link>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-num text-2xl font-semibold tabular-nums text-ink">
          {TRADING_ENABLED ? `$${earned.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">earned · claim on portfolio</span>
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
