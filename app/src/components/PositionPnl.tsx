import { useEffect, useRef } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { useAccount, useReadContract } from 'wagmi'
import type { Address } from 'viem'
import { basketAbi, erc20BalanceAbi } from '../lib/spectrum/abis-v2'
import { TRADING_ENABLED } from '../lib/config/features'
import { basketPnl, loadPnlIndex, usePnlIndex, usePnlIndexes } from '../lib/spectrum/pnl'
import { fetchFeeState } from '../lib/spectrum/use-fee-state'
import { InfoDot } from './InfoDot'

// "Invested capital · Current value · Net PnL" (owner 2026-07-31; beautify
// pass 08-01) — one block, two hosts: the Token page (card) and each
// Portfolio holding (row, mounted as a SIBLING of the card's Link — an ⓘ is
// interactive and can't nest inside it, the same rule the share row obeys).
// Renders ONLY when the connected wallet has a router-traded basis here;
// self-hides everywhere else. Figures come from lib/spectrum/pnl.ts — see its
// header for the honest-basis rules and the one-scan-per-wallet RPC budget.

const usd = (n: number) =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function CoverageDot({ coverage }: { coverage: number }) {
  if (coverage >= 0.99) return null
  return (
    <InfoDot>
      The basis covers the {Math.round(coverage * 100)}% of your balance bought through this
      site&rsquo;s router. Tokens that arrived another way (a wallet transfer, a migration, an
      ETH-direct buy) have no knowable purchase price here, so they are left out rather than
      guessed — value and PnL are computed on the covered part only.
    </InfoDot>
  )
}

export function PositionPnl({
  basket,
  chainId,
  navPerToken,
  symbol,
  balanceTokens,
  variant = 'card',
  className = '',
}: {
  basket: string
  chainId: number
  navPerToken: number
  /** Ticker for the holdings line (card variant). */
  symbol?: string
  /** Live balance in token units when the host already has it (Portfolio);
   *  omitted → read on-chain (Token page). */
  balanceTokens?: number
  variant?: 'card' | 'row'
  className?: string
}) {
  const { address } = useAccount()
  const queryClient = useQueryClient()
  const { data: index } = usePnlIndex(chainId, address)
  // One balanceOf only when the host didn't bring a balance — Portfolio passes
  // its own, so the row variant adds zero reads.
  const { data: balRaw } = useReadContract({
    address: basket as Address,
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: [address as Address],
    chainId,
    query: { enabled: !!address && balanceTokens == null, staleTime: 30_000, refetchInterval: 60_000 },
  })
  const balance = balanceTokens ?? (balRaw != null ? Number(balRaw) / 1e18 : 0)

  // The holder's claimable fee accrual (claimFees() pot) — one cheap view,
  // card variant only (Portfolio's summary aggregates its own via the shared
  // feeState cache). Community ask 2026-08-01: the claim must be VISIBLE from
  // the holdings surfaces, not only on the fee console.
  const { data: claimRaw } = useReadContract({
    address: basket as Address,
    abi: basketAbi,
    functionName: 'claimableFees',
    args: [address as Address],
    chainId,
    query: { enabled: !!address && variant === 'card', staleTime: 30_000, refetchInterval: 60_000 },
  })
  const claimableUsd = claimRaw != null ? Number(claimRaw) / 1e6 : 0

  // Post-trade freshness: the wallet's balance moving means a trade just
  // landed — force one top-up past the in-session rescan floor so the block
  // updates now, not in two minutes. Skips the initial render.
  const prevBal = useRef<number | null>(null)
  useEffect(() => {
    if (!address) return
    if (prevBal.current != null && Math.abs(prevBal.current - balance) > 1e-9) {
      void loadPnlIndex(chainId, address, true).then(() =>
        queryClient.invalidateQueries({ queryKey: ['spectrum', 'pnl', chainId, address.toLowerCase()] }),
      )
    }
    prevBal.current = balance
  }, [balance, address, chainId, queryClient])

  const pnl = basketPnl(index, basket, navPerToken, balance)
  // The row (Portfolio) is a PnL strip — basis or nothing. The card (Token
  // page) is a HOLDINGS card (owner 2026-08-01): it shows whenever the wallet
  // owns the basket, and the PnL story folds in only where a basis exists.
  if (!address) return null
  if (variant === 'row' && !pnl) return null
  if (variant === 'card' && balance <= 0 && !pnl && claimableUsd < 0.005) return null

  const up = (pnl?.netUsd ?? 0) >= 0
  const accent = up ? 'var(--color-teal)' : 'var(--color-magenta)'
  const tone = up ? 'text-teal' : 'text-magenta'
  const sign = up ? '+' : ''

  if (variant === 'row') {
    const p = pnl!
    return (
      <div className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 font-mono text-[11px] ${className}`}>
        <span className="text-ink-faint">
          Invested <span className="tabular-nums text-ink-dim">{usd(p.investedUsd)}</span>
          <span aria-hidden className="mx-1.5 text-ink-faint">→</span>
          <span className="tabular-nums text-ink-dim">{usd(p.currentUsd)}</span>
          <CoverageDot coverage={p.coverage} />
        </span>
        <span className={`font-semibold tabular-nums ${tone}`}>
          {sign}{usd(p.netUsd)} · {sign}{(p.netPct * 100).toFixed(1)}%
        </span>
      </div>
    )
  }

  return (
    <section className={`relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] ${className}`}>
      {/* the sign owns the card's accent — bar + corner bloom (neutral violet
          while no basis exists to be up or down about) */}
      <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${pnl ? accent : 'var(--color-violet)'}, transparent 70%)` }} />
      <div aria-hidden className="ambient-bloom pointer-events-none absolute -right-14 -top-16 h-40 w-40 rounded-full opacity-15 blur-3xl" style={{ background: pnl ? accent : 'var(--color-violet)' }} />

      <div className="relative p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">
            Your holdings
            {pnl && <CoverageDot coverage={pnl.coverage} />}
          </span>
          {pnl && pnl.realizedUsd !== 0 && (
            <span
              className="rounded-full border px-2 py-0.5 font-mono text-[10px] tabular-nums"
              style={{
                color: pnl.realizedUsd > 0 ? 'var(--color-teal)' : 'var(--color-magenta)',
                borderColor: 'color-mix(in srgb, currentColor 35%, transparent)',
                background: 'color-mix(in srgb, currentColor 10%, transparent)',
              }}
              title="Banked by past sells through this site — separate from the open position below"
            >
              realized {pnl.realizedUsd > 0 ? '+' : ''}{usd(pnl.realizedUsd)}
            </span>
          )}
        </div>

        {/* reading order (owner 2026-08-01): current holdings value first,
            then total invested, then the PnL number + % side by side */}
        <div className="mt-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">Current value</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-num text-3xl font-bold tabular-nums text-ink">
              {usd(balance * navPerToken)}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-ink-dim">
              {balance.toLocaleString('en-US', { maximumFractionDigits: balance < 1 ? 4 : 2 })}{symbol ? ` $${showSymbol(symbol)}` : ' tokens'}
            </span>
          </div>
        </div>

        {pnl && (
          <div className="mt-4 space-y-2.5 border-t border-white/[0.07] pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[11px] text-ink-dim">Total invested</span>
              <span className="font-num text-base font-semibold tabular-nums text-ink">{usd(pnl.investedUsd)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[11px] text-ink-dim">Net PnL</span>
              <span className="flex items-baseline gap-2">
                <span className={`font-num text-xl font-bold tabular-nums ${tone}`}>
                  {sign}{usd(pnl.netUsd)}
                </span>
                <span
                  className="rounded-lg px-2 py-0.5 font-num text-sm font-semibold tabular-nums"
                  style={{ color: accent, background: `color-mix(in srgb, ${accent} 12%, transparent)` }}
                >
                  {sign}{(pnl.netPct * 100).toFixed(1)}%
                </span>
              </span>
            </div>
          </div>
        )}

        {/* the holder fee reserve — YOUR claimable share of this basket's
            trading fees (accrues per share beside NAV, never inside it) */}
        {claimableUsd >= 0.005 && (
          <div className="mt-4 flex items-baseline justify-between gap-3 border-t border-white/[0.07] pt-3">
            <span className="font-mono text-[11px] text-ink-dim">
              Claimable fees
              <InfoDot>
                Your share of this basket&rsquo;s trading fees, accrued per token you hold. It
                sits in a reserve beside NAV (never inside it) until you claim it to your wallet
                in {`$`}-terms on the fee console — permissionless, no operator involved.
              </InfoDot>
            </span>
            <span className="flex items-baseline gap-2.5">
              <span className="font-num text-base font-semibold tabular-nums text-teal">{usd(claimableUsd)}</span>
              {TRADING_ENABLED && (
                <Link
                  to={`/flush?basket=${basket}&chain=${chainId}`}
                  className="font-mono text-[11px] font-semibold text-cyan underline underline-offset-2 hover:text-ink"
                >
                  Claim →
                </Link>
              )}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}


// ── the all-holdings summary (owner 2026-08-01: "a summary across all
// holdings just below the left hero card") — the same card language as the
// Token page's holdings card, aggregated: Σ current (covered) → Σ invested →
// net + %. Only holdings with a router-traded basis can contribute; when some
// don't, the ⓘ says how many are covered instead of guessing their cost.
export function PortfolioPnlSummary({
  holdings,
  className = '',
}: {
  holdings: { address: string; chainId: number; navPerToken: number; balance: number }[]
  className?: string
}) {
  const { address } = useAccount()
  const indexes = usePnlIndexes(address)
  // Holder-fee claimables per holding — SAME query keys as the Earn card's
  // aggregation (PortfolioClaims), so on Portfolio this hits cache only.
  const claimReads = useQueries({
    queries: holdings.map((h) => ({
      queryKey: ['spectrum', 'feeState', h.chainId, h.address.toLowerCase(), address?.toLowerCase()],
      queryFn: () => fetchFeeState(h.address as Address, h.chainId, address as Address | undefined),
      enabled: TRADING_ENABLED && !!address,
      staleTime: 15_000,
    })),
  })
  if (!address || holdings.length === 0) return null

  let invested = 0
  let current = 0
  let realized = 0
  let covered = 0
  for (const h of holdings) {
    const p = basketPnl(indexes[h.chainId], h.address, h.navPerToken, h.balance)
    if (!p) continue
    invested += p.investedUsd
    current += p.currentUsd
    realized += p.realizedUsd
    covered++
  }
  const claimable = claimReads.reduce((sum, r) => sum + (r.data?.claimableUsdc ?? 0), 0)
  // Render whenever there is ANYTHING to say — a basis, banked PnL, or a
  // claimable fee reserve (owner 2026-08-01: the claim must be visible here).
  if (invested <= 0 && realized === 0 && claimable < 0.005) return null
  const net = current - invested
  const up = net >= 0
  const accent = up ? 'var(--color-teal)' : 'var(--color-magenta)'
  const tone = up ? 'text-teal' : 'text-magenta'
  const sign = up ? '+' : ''

  return (
    <section className={`relative overflow-hidden rounded-2xl border border-white/15 bg-panel p-6 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] ${className}`}>
      <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${accent}, transparent 70%)` }} />
      <div aria-hidden className="ambient-bloom pointer-events-none absolute -right-14 -top-16 h-40 w-40 rounded-full opacity-15 blur-3xl" style={{ background: accent }} />
      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <span className="font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">
            Your PnL
            {covered < holdings.length && (
              <InfoDot>
                {covered} of {holdings.length} holdings carry a purchase history from this
                site&rsquo;s router; the others (transferred in, migrated, or bought elsewhere)
                have no knowable cost here and are left out of these figures rather than guessed.
              </InfoDot>
            )}
          </span>
          {realized !== 0 && (
            <span
              className="rounded-full border px-2 py-0.5 font-mono text-[10px] tabular-nums"
              style={{
                color: realized > 0 ? 'var(--color-teal)' : 'var(--color-magenta)',
                borderColor: 'color-mix(in srgb, currentColor 35%, transparent)',
                background: 'color-mix(in srgb, currentColor 10%, transparent)',
              }}
              title="Banked by past sells through this site — separate from the open positions below"
            >
              realized {realized > 0 ? '+' : ''}{usd(realized)}
            </span>
          )}
        </div>

        {invested > 0 && (
          <>
            <div className="mt-3">
              <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">Current value</div>
              <div className="mt-1 font-num text-3xl font-bold tabular-nums text-ink">{usd(current)}</div>
            </div>

            <div className="mt-4 space-y-2.5 border-t border-white/[0.07] pt-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[11px] text-ink-dim">Total invested</span>
                <span className="font-num text-base font-semibold tabular-nums text-ink">{usd(invested)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[11px] text-ink-dim">Net PnL</span>
                <span className="flex items-baseline gap-2">
                  <span className={`font-num text-xl font-bold tabular-nums ${tone}`}>
                    {sign}{usd(net)}
                  </span>
                  <span
                    className="rounded-lg px-2 py-0.5 font-num text-sm font-semibold tabular-nums"
                    style={{ color: accent, background: `color-mix(in srgb, ${accent} 12%, transparent)` }}
                  >
                    {sign}{invested > 0 ? ((net / invested) * 100).toFixed(1) : '0.0'}%
                  </span>
                </span>
              </div>
            </div>
          </>
        )}

        {/* the holder fee reserve across every holding — claimable in $-terms
            on the fee console (community ask 2026-08-01: visible from here) */}
        {claimable >= 0.005 && (
          <div className={`flex items-baseline justify-between gap-3 ${invested > 0 ? 'mt-4 border-t border-white/[0.07] pt-3' : 'mt-3'}`}>
            <span className="font-mono text-[11px] text-ink-dim">
              Claimable fees
              <InfoDot>
                Your share of your baskets&rsquo; trading fees, accrued per token you hold. It
                sits in each basket&rsquo;s reserve beside NAV (never inside it) until you claim
                it to your wallet — permissionless, no operator involved.
              </InfoDot>
            </span>
            <span className="flex items-baseline gap-2.5">
              <span className="font-num text-base font-semibold tabular-nums text-teal">{usd(claimable)}</span>
              {TRADING_ENABLED && (
                <Link to="/flush" className="font-mono text-[11px] font-semibold text-cyan underline underline-offset-2 hover:text-ink">
                  Claim →
                </Link>
              )}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
