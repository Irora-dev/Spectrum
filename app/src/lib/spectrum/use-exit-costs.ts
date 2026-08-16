import { useMemo } from 'react'
import { useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import { clientFor } from '../chain/rpc'
import { deploymentFor } from '../chain/deployments'
import { getBasketData } from './basket-data'
import { isDevPreview } from './dev-preview'
import { simulateSwapOut } from './swap-sim'
import { toRaw } from './swap-quote'
import type { PortfolioHolding } from './hooks'

// ─────────────────────────────────────────────────────────────────────────────
// use-exit-costs — the MEASURED half of the exit-cost insight card (the
// freeze-amendment's fourth portfolio feature, desk 34).
//
// WHAT IT MEASURES. For each held basket: simulate selling the FULL held
// balance through the basket's own router right now (swap-sim's eth_call —
// the same load-bearing machinery the trade panel's floors stand on) and
// read what the route actually returns. The cost is the gap to mark value
// (balance × NAV). Measured live 2026-07-14: ~1.8% under NAV at small size,
// −43.6% at 500 shares — the honest round-trip framing the owner accepted.
//
// SCOPE, deliberately v1: BASKET positions only. They are the positions whose
// route is the product itself, and the only ones the kit can simulate without
// inventing a venue. A direct token's exit story stays with the depth card
// (structural pool share); nothing here guesses.
//
// HONESTY LAW. A position that will not measure (mock basket, missing
// deployment, RPC refusal, sim revert) is ABSENT from the result — null is
// never zero, and buildInsights renders no card for what is not measured.
// This hook is display-plumbing: nothing here feeds a floor or a signature.
//
// KNOWN LIMIT (PM review, 2026-08-03): GROUP-MERGED positions cannot measure.
// Linked wallets merge balances into one book, but the sim sells the MERGED
// size as the ACTIVE wallet — which does not hold that much, so the eth_call
// reverts and the row goes absent (correct: no wrong number can render). The
// honest upgrade, if absence ever deserves better, is PER-WALLET sims summed
// — never a merged-size sim.
// ─────────────────────────────────────────────────────────────────────────────

export interface MeasuredExitCost {
  /** `${chainId}:${address}` — the insight-position key of the BASKET row. */
  key: string
  symbol: string
  /** Mark value minus what the simulated sell returns, USD. */
  costUsd: number
  /** costUsd as a share of the position's mark value, 0–100. */
  costPct: number
  /** The mark value the sell was simulated against (the position's size). */
  sizeUsd: number
  /** Where it was measured, for the card's sentence. */
  route: string
}

/** Positions under this are not worth an eth_call — the cost of leaving $4
 *  is not a fact anyone needs a card for. */
const VALUE_FLOOR_USD = 10
/** Biggest positions first; more than this many held baskets is rare and the
 *  card only ever states the worst one. */
const MAX_MEASURED = 8

const NET_NAME: Record<number, string> = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood' }
const routeLabel = (chainId: number) => `its own router on ${NET_NAME[chainId] ?? `chain ${chainId}`}`

async function measureOne(h: PortfolioHolding, holder: string, qc: QueryClient): Promise<MeasuredExitCost | null> {
  const { chainId, address, symbol } = h.basket
  // Dev stand-in for the preview identity's MOCK baskets (they do not exist
  // on-chain, so the real sim can never answer for them). Dynamic import so
  // the fixture never enters a production bundle; the helper itself returns
  // null unless the fixture flag is on — same gating as every other stand-in.
  if (import.meta.env.DEV && isDevPreview(holder)) {
    const dev = (await import('./dev-fixture')).devExitCost(address, chainId, h.valueUsd)
    if (dev) return dev
  }
  try {
    const dep = deploymentFor(chainId)
    if (!dep.usdc) return null
    // SHARED CACHE (audit round 2): the same basket-detail read the page's
    // other consumers key on — nav-gaps, live exposure, the basket pages —
    // so a portfolio with baskets stops fetching each basket's detail twice.
    const d = await qc.ensureQueryData({
      queryKey: ['spectrum', 'basket', chainId, address.toLowerCase()],
      queryFn: () => getBasketData(address as Address, chainId, { inception: true, detail: true }),
      staleTime: 60_000,
    })
    const router = (d.router ?? dep.swapRouter) as Address | null
    if (!router || !(d.navPerToken > 0) || !(h.balance > 0)) return null
    const legCount = d.totalCount > 0 ? d.totalCount : d.holdings.length
    if (legCount <= 0) return null
    const amountIn = toRaw(h.balance, Math.min(d.decimals, 18))
    if (amountIn <= 0n) return null
    const out = await simulateSwapOut(clientFor(chainId), {
      side: 'sell',
      basket: address as Address,
      settlement: dep.usdc,
      router,
      amountIn,
      legCount,
      holder: holder as Address,
      allowanceCovers: false,
    })
    if (out == null || out <= 0n) return null
    const sizeUsd = h.balance * d.navPerToken
    const realisedUsd = Number(out) / 1e6 // settlement is the 6-decimal USDC
    const costUsd = sizeUsd - realisedUsd
    if (!Number.isFinite(costUsd) || sizeUsd <= 0) return null
    return {
      key: `${chainId}:${address.toLowerCase()}`,
      symbol,
      costUsd: Math.round(costUsd * 100) / 100,
      costPct: (costUsd / sizeUsd) * 100,
      sizeUsd: Math.round(sizeUsd * 100) / 100,
      route: routeLabel(chainId),
    }
  } catch {
    return null // unreadable stays absent, never zero
  }
}

/** Measured exit costs for the held baskets, biggest positions first.
 *  Rows that did not measure are simply absent. `null` until anything has
 *  measured at all — buildInsights treats both the same (no card). */
export function useExitCosts(
  holdings: PortfolioHolding[],
  holder: string | undefined,
  enabled: boolean,
): MeasuredExitCost[] | null {
  const rows = useMemo(
    () =>
      [...holdings]
        .filter((h) => h.valueUsd >= VALUE_FLOOR_USD && h.balance > 0)
        .sort((a, b) => b.valueUsd - a.valueUsd)
        .slice(0, MAX_MEASURED),
    [holdings],
  )
  const qc = useQueryClient()
  const results = useQueries({
    queries: rows.map((h) => ({
      // Balance in the key at cent-of-a-share grain: a re-measure is only due
      // when the held size actually changes, not on every render.
      queryKey: [
        'spectrum',
        'exitcost',
        h.basket.chainId,
        h.basket.address.toLowerCase(),
        holder?.toLowerCase() ?? '',
        Math.round(h.balance * 100),
      ],
      queryFn: () => measureOne(h, holder as string, qc),
      enabled: enabled && !!holder,
      staleTime: 5 * 60_000,
      retry: 0, // a refusal IS the answer (unreadable); retries just hammer the RPC
    })),
  })
  const sig = results.map((r) => r.dataUpdatedAt ?? 0).join('|')
  return useMemo(() => {
    const out = results.map((r) => r.data).filter((d): d is MeasuredExitCost => d != null)
    return out.length > 0 ? out : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
}
