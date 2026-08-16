import { useQuery } from '@tanstack/react-query'
import { basketMintHealth } from './leg-health'

/** Mint pre-flight (dead-leg detection) for the buy surface. Rides the meta
 *  the page already fetched; a handful of view calls, re-checked at most every
 *  5 minutes, never polled — a dead pool gaining liquidity is an LP event, not
 *  a tick. Query retry off: the module retries each read once itself, and
 *  'unknown' is an honest resting state that never gates anything. */
export function useMintHealth(address?: string, chainId?: number, enabled = true) {
  return useQuery({
    queryKey: ['spectrum', 'mintHealth', chainId, address?.toLowerCase()],
    queryFn: () => basketMintHealth(address!, chainId!),
    enabled: !!address && !!chainId && enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
}
