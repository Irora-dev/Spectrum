import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Address } from 'viem'
import { getBasketData } from './basket-data'
import type { PortfolioHolding } from './hooks'

// ─────────────────────────────────────────────────────────────────────────────
// use-nav-gaps — the MARK-UNCERTAINTY feed (16:4x feature 2, honesty-shaped):
// per held basket, how far its two independent valuations (on-chain views vs
// the spot reconstruction of its contents) disagree right now. The kit already
// computes navDivergencePct on every detail read and the portfolio was
// throwing it away. Query keys mirror useBasketData/useLiveExposure exactly,
// so this usually costs ZERO extra network — it reads the same cache.
// A basket whose divergence cannot be read is ABSENT (null never zero).
// ─────────────────────────────────────────────────────────────────────────────

export interface NavGapRow {
  key: string
  symbol: string
  divergencePct: number
  valueUsd: number
}

export function useNavGaps(holdings: PortfolioHolding[]): NavGapRow[] | null {
  const results = useQueries({
    queries: holdings.map((h) => ({
      queryKey: ['spectrum', 'basket', h.basket.chainId, h.basket.address.toLowerCase()],
      queryFn: () => getBasketData(h.basket.address as Address, h.basket.chainId, { inception: true, detail: true }),
      enabled: !!h.basket.address && h.valueUsd > 0,
      staleTime: 60_000,
    })),
  })
  const sig = results.map((r) => r.dataUpdatedAt ?? 0).join('|')
  return useMemo(() => {
    const out: NavGapRow[] = []
    holdings.forEach((h, i) => {
      const d = results[i]?.data
      if (!d || d.navDivergencePct == null || !Number.isFinite(d.navDivergencePct)) return
      out.push({
        key: `${h.basket.chainId}:${h.basket.address.toLowerCase()}`,
        symbol: h.basket.symbol,
        divergencePct: d.navDivergencePct,
        valueUsd: h.valueUsd,
      })
    })
    return out.length > 0 ? out : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
}
