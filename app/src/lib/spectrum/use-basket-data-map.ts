import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Address } from 'viem'
import { getBasketData, type BasketData } from './basket-data'
import type { PortfolioHolding } from './hooks'

/**
 * The held baskets' full data, as a `chainId:address` map.
 *
 * ⚠ THE QUERY KEY IS THE POINT. It is byte-identical to the one `useNavGaps`
 * (and `useLiveExposure`) already mount — `['spectrum','basket',chainId,addr]`
 * — so react-query serves this from the same cache entry and NO additional
 * request is made. Mounting this beside them costs nothing; giving it its own
 * key would silently double every held basket's reads, which is exactly the
 * "rpc efficient" requirement this exists to satisfy (the owner, 2026-08-15).
 *
 * If you change the key, change it in all three or the dedupe is gone.
 */
export function useBasketDataMap(holdings: readonly PortfolioHolding[]): Map<string, BasketData | null> {
  const results = useQueries({
    queries: holdings.map((h) => ({
      queryKey: ['spectrum', 'basket', h.basket.chainId, h.basket.address.toLowerCase()],
      queryFn: () => getBasketData(h.basket.address as Address, h.basket.chainId, { inception: true, detail: true }),
      enabled: !!h.basket.address && h.valueUsd > 0,
      staleTime: 60_000,
    })),
  })
  // recompute only when a result actually lands, not on every render
  const sig = results.map((r) => r.dataUpdatedAt ?? 0).join('|')
  return useMemo(() => {
    const out = new Map<string, BasketData | null>()
    holdings.forEach((h, i) => {
      out.set(`${h.basket.chainId}:${h.basket.address.toLowerCase()}`, results[i]?.data ?? null)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdings, sig])
}
