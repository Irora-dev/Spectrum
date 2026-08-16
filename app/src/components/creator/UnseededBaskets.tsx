import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import type { BasketSummary } from '../../lib/spectrum/basket-data'
import { dismissUnseeded, seedBlockerFor, unseededBasketsOf } from '../../lib/spectrum/unseeded-baskets'
import type { SeedPlan } from '../reshape/seed-plan'
import { SeedBundleDoor } from '../reshape/SeedBundleDoor'
import { ChainBadge } from '../ChainBadge'
import { showSymbol } from '../../lib/spectrum/safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// "You created this basket — you still need to seed it" (owner 2026-08-15
// 11:43, after being bumped off the seed ceremony). One component, mounted on
// the portfolio (the recovery banner) AND the creator's own profile (the
// not-fully-published section). The door inside is the REAL SeedBundleDoor —
// the same stake input, run overlay and pay-asset offer the ceremony mounts —
// handed a plan rebuilt from on-chain truth (unseeded-baskets.ts). Shares are
// equal across a ticker's networks: a refresh loses any cross-network
// preference, and equal is the reshape precedent's own honest derivation.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export function UnseededBaskets() {
  const { address } = useAccount()
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['unseeded-baskets', address],
    queryFn: () => unseededBasketsOf(address as Address),
    enabled: !!address,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const groups = useMemo(() => {
    const m = new Map<string, BasketSummary[]>()
    for (const b of data ?? []) {
      const k = b.symbol.toUpperCase()
      m.set(k, [...(m.get(k) ?? []), b])
    }
    return [...m.entries()]
  }, [data])
  // structural seed blockers, probed once per listed basket (long stale — a
  // venue verdict changes on the market's clock, not the render's)
  const { data: blockers } = useQuery({
    queryKey: ['seed-blockers', (data ?? []).map((b) => `${b.chainId}:${b.address.toLowerCase()}`).join(',')],
    queryFn: async () => {
      const out = new Map<string, string>()
      for (const b of data ?? []) {
        const why = await seedBlockerFor(b).catch(() => null)
        if (why) out.set(`${b.chainId}:${b.address.toLowerCase()}`, why)
      }
      return out
    },
    enabled: (data ?? []).length > 0,
    staleTime: 10 * 60_000,
  })
  if (!address || groups.length === 0) return null

  return (
    <div className="mt-6 space-y-4">
      {groups.map(([symbol, rows]) => {
        const plan: SeedPlan = {
          legs: rows.map((b) => ({ chainId: b.chainId, address: b.address as `0x${string}`, symbol: b.symbol, share: 1 })),
          excluded: [],
        }
        return (
          <div key={symbol} className="relative overflow-hidden rounded-3xl card-surface p-5">
            <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: SPECTRAL }} />
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200/90">still needs its seed</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="font-display text-xl font-bold tracking-tight text-ink">{showSymbol(symbol)}</span>
                  <span className="inline-flex items-center gap-1">
                    {rows.map((b) => (
                      <ChainBadge key={b.chainId} chainId={b.chainId} size="sm" />
                    ))}
                  </span>
                </div>
                <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed text-ink-dim">
                  You created this — its {rows.length === 1 ? 'basket is' : 'baskets are'} live on-chain but empty
                  until the first buy.
                </p>
                {(() => {
                  const why = rows.map((b) => blockers?.get(`${b.chainId}:${b.address.toLowerCase()}`)).find(Boolean)
                  return why ? (
                    <p className="mt-2 max-w-[52ch] rounded-lg border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
                      this one likely can&rsquo;t seed: {why} · the contract is immutable, so remove it and launch
                      the mix again without that holding
                    </p>
                  ) : null
                })()}
              </div>
              <button
                type="button"
                onClick={() => {
                  for (const b of rows) dismissUnseeded(b.chainId, b.address)
                  void qc.invalidateQueries({ queryKey: ['unseeded-baskets', address] })
                }}
                title="Remove from this list — the on-chain baskets stay"
                aria-label={`Remove ${showSymbol(symbol)} from this list (the on-chain baskets stay)`}
                className="press shrink-0 rounded-full border border-white/12 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:border-white/30 hover:text-ink"
              >
                remove
              </button>
            </div>
            <SeedBundleDoor plan={plan} name={symbol} deployer={address} accent="var(--color-cyan)" gradient={SPECTRAL} textClass="text-void" />
          </div>
        )
      })}
    </div>
  )
}
