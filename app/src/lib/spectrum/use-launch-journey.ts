import { useEffect, useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Address, PublicClient } from 'viem'
import { chainCfg } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { basketAbi } from './abis-v2'
import type { BasketSummary } from './basket-data'
import { useCreatorProfile } from './hooks'
import { fetchNotesCached } from './notes-social'
import { basketMetaShapeCheck, NOTE_KINDS } from './profile-registry'
import {
  hasShareStamp,
  inProgressLaunches,
  journeyOfBasket,
  read,
  readLaunchDrafts,
  readShareStamps,
  unread,
  type BasketRef,
  type DraftRef,
  type Journey,
  type Reading,
} from './launch-journey'

// ─────────────────────────────────────────────────────────────────────────────
// THE READING HALF of launch-journey.ts — the part that goes and asks.
//
// launch-journey.ts judges and cannot lie, because it never reads anything: it
// is handed Readings and every Reading may say "I did not answer". This module
// is where those Readings are actually produced, so it is where the honesty is
// either kept or thrown away. Two deliberate choices, both about that:
//
// 1. SEEDING IS READ AS `effectiveSupply()`, DIRECTLY. One eth_call per basket
//    — not getBasketData, which would drag pricing, holdings and an inception
//    log scan behind it for a single boolean. It is also the only read shape
//    that keeps the distinction: the call either returns a number or throws,
//    and a throw becomes `unread`, never a zero. (aumUsd/navPerToken would have
//    been cheaper still and are exactly the trap — both read 0 on an unseeded
//    basket AND on a basket whose pricing merely failed.)
//
// 2. THE THESIS IS READ AS EVENTS, NOT VIA useCreatorMeta. resolveCreatorMeta
//    catches a failed registry read and falls through to `null`, so its null
//    means "no thesis" and "the read failed" at the same time — the exact
//    conflation this feature exists to prevent. fetchNotesCached keeps them
//    apart: `null` = could not read, `[]` = genuinely none. It is also
//    incrementally cached in localStorage, so the per-basket cost amortizes.
//
// Both queries carry their OWN keys rather than borrowing useBasketData's, so a
// light journey read can never be served to the Token page in place of the full
// object it expects.
// ─────────────────────────────────────────────────────────────────────────────

/** Bound on how many of a creator's baskets get probed. A launch journey is
 *  about the RECENT ones; a creator with fifty baskets must not pay fifty log
 *  scans to be told which two are unfinished. */
const MAX_PROBED = 12

const keyOf = (b: { chainId: number; address: string }) => `${b.chainId}:${b.address.toLowerCase()}`

/** localStorage is not reactive. Re-read on the two moments a draft can have
 *  changed behind this component's back: another tab wrote one, or the user
 *  came back to this one. */
export function useLaunchDrafts(): DraftRef[] {
  const [drafts, setDrafts] = useState<DraftRef[]>(() => readLaunchDrafts())
  useEffect(() => {
    const reread = () => setDrafts(readLaunchDrafts())
    reread()
    window.addEventListener('storage', reread)
    window.addEventListener('focus', reread)
    return () => {
      window.removeEventListener('storage', reread)
      window.removeEventListener('focus', reread)
    }
  }, [])
  return drafts
}

/** effectiveSupply(), as a Reading. A revert or an RPC refusal is `unread`.
 *
 *  The DEV fixture is consulted first, exactly as getBasketData does it (same
 *  gate, same dynamic import so the catalogue never enters a production
 *  bundle). Without this the journey read past the fixture to a chain that has
 *  no such basket, and every fixture basket reported "couldn't read" — honest,
 *  but honest about the wrong question: in fixture mode the fixture IS the
 *  truth, and asking the chain instead is simply asking the wrong source. */
export async function readEffectiveSupply(
  client: PublicClient,
  address: Address,
  chainId: number,
): Promise<Reading<number>> {
  if (import.meta.env.DEV) {
    const { devBasketData } = await import('./dev-fixture')
    const mock = devBasketData(address, chainId)
    // The fixture's own null/number distinction is preserved, not flattened.
    if (mock) return mock.effectiveSupply == null ? unread('the fixture reports no effectiveSupply') : read(mock.effectiveSupply)
  }
  try {
    const raw = await client.readContract({ address, abi: basketAbi, functionName: 'effectiveSupply' })
    return read(Number(raw))
  } catch (e) {
    return unread(e instanceof Error && e.message ? e.message.slice(0, 80) : 'the view did not answer')
  }
}

/** The basket's published thesis text, as a Reading. '' = the registry answered
 *  and there is none (or it was cleared); `unread` = it did not answer. */
export async function readThesisNote(
  chainId: number,
  basket: string,
  deployer: string | null,
): Promise<Reading<string>> {
  // Same fixture gate, same reason, and the same one resolveCreatorMeta opens
  // with — a fixture basket has no registry history to scan, so reading past it
  // would report "couldn't read" about a basket the fixture can answer for.
  if (import.meta.env.DEV) {
    const { devCreatorMeta } = await import('./dev-fixture')
    const mock = devCreatorMeta(basket, chainId)
    if (mock) return read(mock.thesis ?? '')
  }
  const registry = chainCfg(chainId).notesRegistry
  if (!registry) return unread('this network has no notes registry')
  // The registry read is authored: a note only counts as the basket's thesis
  // when its author IS the deployer (authorship replaces a signature here). No
  // deployer, no readable answer — and a guess would be worse than none.
  if (!deployer) return unread('the basket’s deployer is unknown')
  let events
  try {
    events = await fetchNotesCached(
      clientFor(chainId),
      registry as Address,
      { author: deployer as Address, subject: basket as Address, kind: NOTE_KINDS.thesis },
      `journey-thesis:${chainId}:${basket.toLowerCase()}`,
    )
  } catch (e) {
    return unread(e instanceof Error && e.message ? e.message.slice(0, 80) : 'the registry read threw')
  }
  if (events === null) return unread('every note-registry read window refused')
  if (events.length === 0) return read('')
  // Latest wins, and later notes CLEAR earlier ones — so the newest row is the
  // whole answer, including when it is empty.
  const latest = [...events].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  )[events.length - 1]
  if (!latest.raw) return read('')
  try {
    const meta = basketMetaShapeCheck(JSON.parse(latest.raw))
    return read(meta?.thesis ?? '')
  } catch {
    // A note exists but is not a thesis envelope — nothing publishes it
    // anywhere else either, so there is no thesis. The registry DID answer.
    return read('')
  }
}

/**
 * Every launch this wallet has in flight — the drafts still standing plus the
 * baskets it deployed whose journey is not finished.
 *
 * `loading` is true only while something is still being asked. It is separate
 * from `uncertain` on each journey: loading means "not yet", uncertain means
 * "asked, and the answer never came" — and only the second one is a fact worth
 * showing a creator.
 */
export function useLaunchJourneys(
  wallet: string | undefined,
  opts: { enabled?: boolean; skipComposerDraft?: boolean } = {},
): { journeys: Journey[]; loading: boolean } {
  const enabled = opts.enabled !== false && !!wallet
  const drafts = useLaunchDrafts()
  const { data: profile, isLoading: profileLoading } = useCreatorProfile(enabled ? wallet : undefined)

  const mine: BasketSummary[] = useMemo(
    () => (enabled ? (profile?.baskets ?? []).slice(0, MAX_PROBED) : []),
    [enabled, profile?.baskets],
  )

  const supplies = useQueries({
    queries: mine.map((b) => ({
      queryKey: ['spectrum', 'journey-supply', b.chainId, b.address.toLowerCase()],
      queryFn: () => readEffectiveSupply(clientFor(b.chainId), b.address as Address, b.chainId),
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      // The Reading IS the failure channel — a refusal is data, not an error,
      // so retrying would only delay the honest "couldn't read".
      retry: false,
    })),
  })

  const theses = useQueries({
    queries: mine.map((b) => ({
      queryKey: ['spectrum', 'journey-thesis', b.chainId, b.address.toLowerCase()],
      queryFn: () => readThesisNote(b.chainId, b.address, b.deployer),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      retry: false,
    })),
  })

  const stamps = useMemo(() => readShareStamps(), [])

  const baskets: BasketRef[] = useMemo(
    () =>
      mine.map((b, i) => ({
        chainId: b.chainId,
        address: b.address,
        name: b.name,
        symbol: b.symbol,
        // A query still in flight has not refused — it is simply not back yet,
        // and 'unknown' would flash "couldn't read" at every creator on every
        // page load. Pending reads keep the basket OUT of the offer entirely
        // (see `loading` below) rather than being narrated as a failure.
        supply: supplies[i]?.data ?? unread('still reading'),
        thesis: theses[i]?.data ?? unread('still reading'),
        sharedLocally: hasShareStamp(stamps, b.chainId, b.address),
      })),
    [mine, supplies, theses, stamps],
  )

  const loading =
    enabled && (profileLoading || supplies.some((q) => q.isPending) || theses.some((q) => q.isPending))

  const journeys = useMemo(() => {
    if (!enabled) return []
    const visibleDrafts = opts.skipComposerDraft ? drafts.filter((d) => d.kind !== 'composer') : drafts
    // While reads are still out, offer the DRAFTS (whose truth is local and
    // already in hand) and hold the baskets back — never a half-read basket
    // narrated as "couldn't read".
    return inProgressLaunches({ drafts: visibleDrafts, baskets: loading ? [] : baskets })
  }, [enabled, drafts, baskets, loading, opts.skipComposerDraft])

  return { journeys, loading }
}

/** One deployed basket's journey, for a surface that already holds its facts
 *  (the basket page). Same judging, no extra reads for what it already has. */
export function useBasketJourney(input: {
  chainId: number
  address: string
  name: string
  symbol: string
  /** effectiveSupply from the page's own BasketData — `null` means the view
   *  reverted, `undefined` means the page has not got it yet. */
  effectiveSupply: number | null | undefined
  deployer: string | null
}): { journey: Journey | null; loading: boolean } {
  const { chainId, address, name, symbol, effectiveSupply, deployer } = input
  const [{ data: thesis, isPending }] = useQueries({
    queries: [
      {
        queryKey: ['spectrum', 'journey-thesis', chainId, address.toLowerCase()],
        queryFn: () => readThesisNote(chainId, address, deployer),
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        retry: false,
      },
    ],
  })
  const stamps = useMemo(() => readShareStamps(), [])
  const loading = effectiveSupply === undefined || isPending
  const journey = useMemo(() => {
    if (loading) return null
    return journeyOfBasket({
      chainId,
      address,
      name,
      symbol,
      supply: effectiveSupply == null ? unread('effectiveSupply() reverted') : read(effectiveSupply),
      thesis: thesis ?? unread('still reading'),
      sharedLocally: hasShareStamp(stamps, chainId, address),
    })
  }, [loading, chainId, address, name, symbol, effectiveSupply, thesis, stamps])
  return { journey, loading }
}

export { keyOf as journeyKeyOf }
