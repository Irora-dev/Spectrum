import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { fetchAssetHistory, type ChartRange } from './history'
import {
  combinePortfolioHistory,
  planPortfolioHistory,
  type PortfolioCurve,
  type PortfolioHistoryAsset,
} from './portfolio-history'
import type { NavPoint } from './basket-data'

// React wrapper around the pure portfolio-history planner (purity law: the
// math lives in portfolio-history.ts). Query keys deliberately match
// useNavHistory's ['spectrum','assetHist',chainId,addr,range] so the hero
// chart and every basket chart share one per-asset history cache.
//
// ONE SMOOTH LOAD (owner 2026-08-03 08:34: "the graph reloads multiple
// times… as it's indexing"): the curve used to recombine and repaint on
// EVERY per-asset landing — and the asset list itself grows while balances
// index, so the chart redrew N times before the page went quiet. Two rules:
//   · the FIRST reveal waits for a quiet window — every in-flight query done
//     and nothing new arriving for a beat — so the first paint is the whole
//     indexed curve, not whichever asset happened to land first;
//   · after that, the last SETTLED curve is LATCHED: a late asset or a
//     refetch keeps showing it until the new combine completes, then swaps
//     once. The chart never walks backwards through partial states.
// `ready` stays false until the first reveal — the chart shows its skeleton.

const FIRST_REVEAL_QUIET_MS = 400

export function usePortfolioHistory(
  assets: PortfolioHistoryAsset[],
  totalUsd: number,
  range: ChartRange,
  /** TRUE while the caller's ASSET LIST is still indexing (balance reads in
   *  flight). The hook cannot see that from inside — cached histories make
   *  each partial list settle instantly, and the gaps between balance
   *  arrivals beat any quiet window (caught live: a one-sliver curve
   *  revealed as "loaded"). While indexing, nothing latches and ready stays
   *  false. Optional so existing callers keep their exact behavior. */
  indexing = false,
): PortfolioCurve & { isLoading: boolean; ready: boolean } {
  const sig = assets.map((a) => `${a.chainId}:${a.address.toLowerCase()}:${Math.round(a.valueUsd)}`).join('|')
  const plan = useMemo(() => planPortfolioHistory(assets), [sig]) // eslint-disable-line react-hooks/exhaustive-deps

  const results = useQueries({
    queries: plan.fetches.map((f) => ({
      queryKey: ['spectrum', 'assetHist', f.chainId, f.address, range],
      queryFn: () => fetchAssetHistory(f.chainId, f.address, range, null),
      enabled: totalUsd > 0,
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
    })),
  })

  const isLoading = indexing || (results.length > 0 && results.some((r) => r.isLoading))
  const allDone = !indexing && results.length > 0 && results.every((r) => !r.isLoading)
  const updatedKey = results.map((r) => r.dataUpdatedAt).join(',')

  const live = useMemo(() => {
    const map = new Map<string, NavPoint[]>()
    plan.fetches.forEach((f, i) => map.set(f.key, results[i]?.data ?? []))
    return combinePortfolioHistory(plan, map, totalUsd)
  }, [plan, updatedKey, totalUsd]) // eslint-disable-line react-hooks/exhaustive-deps

  // the latch: the last curve computed with every query settled, per range —
  // points and coverage travel TOGETHER so a stale pair can never mix
  const settledRef = useRef<{ range: ChartRange; curve: PortfolioCurve } | null>(null)
  if (allDone) settledRef.current = { range, curve: live }
  const latched = settledRef.current && settledRef.current.range === range ? settledRef.current.curve : null

  // the first reveal: a quiet window, so the staggered plan growth while
  // balances index cannot flash a one-asset curve as "loaded". sig/updatedKey
  // in the deps restart the wait whenever anything new arrives inside it.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (ready || !allDone) return
    const t = window.setTimeout(() => setReady(true), FIRST_REVEAL_QUIET_MS)
    return () => window.clearTimeout(t)
  }, [ready, allDone, sig, updatedKey, indexing])

  const shown = allDone ? live : latched ?? live
  return { ...shown, isLoading, ready: ready && latched != null }
}
