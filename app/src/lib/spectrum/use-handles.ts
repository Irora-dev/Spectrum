import { useQuery } from '@tanstack/react-query'
import { handleForIn, type HandleMap } from './creator-handles'
import {
  HANDLE_AUTHORITY_CHAIN_ID,
  lookupHandle,
  resolveHandleRegistry,
  type HandleLookup,
  type HandleRegistryResult,
} from './handle-registry'

// React seam over handle-registry.ts. One query for the whole site: the map is
// resolved once, cached, and every surface reads it — the claim form's live
// availability check costs no network per keystroke, and the creator route
// shares the same answer.

export const HANDLES_QUERY_KEY = ['spectrum', 'handles', HANDLE_AUTHORITY_CHAIN_ID] as const

export function useHandleRegistry(enabled = true) {
  return useQuery<HandleRegistryResult>({
    queryKey: HANDLES_QUERY_KEY,
    queryFn: resolveHandleRegistry,
    // OFF unless something actually needs a name. A /creator/0x… URL resolves
    // with no lookup, so opening one must not spend a log scan proving it.
    enabled,
    // Claims are rare and the scan is incremental, so a long stale window costs
    // nothing; a fresh claim invalidates this key directly.
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
  })
}

/** One name → its owner, with loading kept SEPARATE from the answer: a page
 *  must never read "still loading" as "nobody has this name". */
export function useAddressForHandle(name: string | null | undefined): {
  lookup: HandleLookup
  loading: boolean
  refetch: () => void
} {
  const { data, isPending, isFetching, refetch } = useHandleRegistry(!!name)
  const loading = !!name && (isPending || isFetching) && data === undefined
  let lookup: HandleLookup = { status: 'unknown' }
  if (!name) lookup = { status: 'none' }
  else if (data?.status === 'ok') lookup = lookupHandle(data.map, name)
  // A site with no registry has no names at all, which is an ANSWER (none), not
  // a failure — the address form of the URL still works.
  else if (data?.status === 'off') lookup = { status: 'none' }
  return { lookup, loading, refetch: () => void refetch() }
}

/** An address → the name it currently goes by, for links and cards. */
export function useHandleForAddress(address: string | null | undefined): {
  lookup: HandleLookup
  loading: boolean
} {
  const { data, isPending } = useHandleRegistry(!!address)
  let lookup: HandleLookup = { status: 'unknown' }
  if (!address) lookup = { status: 'none' }
  else if (data?.status === 'ok') {
    const owner = handleForIn(data.map, address)
    lookup = owner ? { status: 'found', owner } : { status: 'none' }
  } else if (data?.status === 'off') lookup = { status: 'none' }
  return { lookup, loading: isPending && data === undefined }
}

/** The resolved map when there IS one, else null. Null means "not known" and
 *  must never be read as "empty". */
export function handleMapOf(result: HandleRegistryResult | undefined): HandleMap | null {
  return result?.status === 'ok' ? result.map : null
}
