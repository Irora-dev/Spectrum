import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { fetchAssetHistory, type ChartRange } from './history'
import type { NavPoint } from './basket-data'
import { tokenVisual } from './token-meta'

// ─────────────────────────────────────────────────────────────────────────────
// The constituents' price lines, prepared to overlay a basket's NAV chart
// (owner 2026-07-06 19:24: "the basket line thick… every individual asset as
// dotted lines underneath"). Cost-conscious by design (his explicit ask):
//   • fetches ONLY while the underlying view is toggled on;
//   • the price source is the keyless history API, not RPC;
//   • query keys match the hover cards' exactly, so caches are shared and a
//     7D overlay is usually free;
//   • capped to the top constituents; 5-minute staleTime, no polling.
// Each series is normalized to its own start and scaled to the NAV series'
// first value, so relative performance is honestly comparable on one axis.
// ─────────────────────────────────────────────────────────────────────────────

export const UNDERLYING_MAX_ASSETS = 6

export interface UnderlyingLine {
  symbol: string
  color: string
  /** 24h move of the asset (from the basket's holdings) — tooltip context. */
  change24hPct: number | null
  /** Resampled onto `anchor`'s length, scaled to anchor[0].value. */
  points: number[]
  /** The REAL USD price at each resampled point (same grid) — the hover
   *  tooltip shows these (owner 2026-07-07 16:40), the lines draw `points`. */
  prices: number[]
}

export function useUnderlyingSeries(
  chainId: number,
  assets: { address: string; symbol: string; change24hPct?: number | null }[],
  enabled: boolean,
  anchor: NavPoint[],
  range: ChartRange = '30D',
): UnderlyingLine[] {
  const capped = assets.slice(0, UNDERLYING_MAX_ASSETS)
  const queries = useQueries({
    queries: capped.map((a) => ({
      queryKey: ['spectrum', 'assetHist', chainId, a.address.toLowerCase(), range],
      queryFn: () => fetchAssetHistory(chainId, a.address, range),
      enabled: enabled && anchor.length >= 2,
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    })),
  })

  return useMemo(() => {
    if (!enabled || anchor.length < 2) return []
    const n = anchor.length
    const base = anchor[0].value || 1
    const out: UnderlyingLine[] = []
    capped.forEach((a, i) => {
      const s = queries[i]?.data
      if (!s || s.length < 2) return
      const first = s[0].value || 1
      const points: number[] = []
      const prices: number[] = []
      for (let k = 0; k < n; k++) {
        const idx = Math.round((k / (n - 1)) * (s.length - 1))
        points.push((s[idx].value / first) * base)
        prices.push(s[idx].value)
      }
      out.push({ symbol: a.symbol, color: tokenVisual(a.symbol, a.address).color, change24hPct: a.change24hPct ?? null, points, prices })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, anchor, queries.map((q) => q.dataUpdatedAt).join(','), chainId])
}
