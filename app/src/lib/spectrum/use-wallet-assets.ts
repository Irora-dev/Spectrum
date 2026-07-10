import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useAccount, useReadContracts } from 'wagmi'
import { erc20Abi, type Address } from 'viem'
import { fetchAssetHistory } from './history'
import type { AssetRef } from './leaderboard'

// ─────────────────────────────────────────────────────────────────────────────
// Which of the page's assets does the CONNECTED WALLET meaningfully hold?
// (R+C 2026-07-06 18:26: "baskets that contain assets they hold… if it's like
// $100 or more of a certain token, those baskets get surfaced as if they had
// searched for them.") One batched balanceOf+decimals read over the page's
// asset set, valued against the chart engine's cached price series (same
// query keys — usually free). Pure surfacing input: facts about the viewer's
// own wallet, never a recommendation (§9).
// ─────────────────────────────────────────────────────────────────────────────

export const WALLET_SURFACE_FLOOR_USD = 100

export interface HeldAsset {
  address: string
  symbol: string
  chainId: number
  valueUsd: number
}

export function useWalletAssets(assets: AssetRef[]): HeldAsset[] {
  const { address: viewer, isConnected } = useAccount()

  const { data: reads } = useReadContracts({
    contracts: assets.flatMap((a) => [
      { address: a.address as Address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [viewer as Address], chainId: a.chainId },
      { address: a.address as Address, abi: erc20Abi, functionName: 'decimals' as const, chainId: a.chainId },
    ]),
    query: { enabled: isConnected && !!viewer && assets.length > 0, staleTime: 60_000 },
  })

  // Last point of each asset's 7d series = its live price (exactly what the
  // hover cards show; shared queryKey → shared cache).
  const priceQueries = useQueries({
    queries: assets.map((a) => ({
      queryKey: ['spectrum', 'assetHist', a.chainId, a.address.toLowerCase(), '7D'],
      queryFn: () => fetchAssetHistory(a.chainId, a.address, '7D'),
      enabled: isConnected && assets.length > 0,
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    })),
  })

  return useMemo(() => {
    if (!isConnected || !reads) return []
    const out: HeldAsset[] = []
    assets.forEach((a, i) => {
      const bal = reads[i * 2]?.result as bigint | undefined
      const dec = reads[i * 2 + 1]?.result as number | undefined
      const series = priceQueries[i]?.data
      const price = series?.length ? series[series.length - 1].value : null
      if (bal == null || dec == null || price == null || bal === 0n) return
      const units = Number(bal / 10n ** BigInt(Math.max(0, dec - 9))) / 1e9
      const valueUsd = units * price
      if (valueUsd >= WALLET_SURFACE_FLOOR_USD) out.push({ address: a.address, symbol: a.symbol, chainId: a.chainId, valueUsd })
    })
    return out.sort((x, y) => y.valueUsd - x.valueUsd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, reads, priceQueries.map((q) => q.dataUpdatedAt).join(','), assets])
}
