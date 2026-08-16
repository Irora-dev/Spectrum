import { useCallback, useMemo } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import { chainCfg, DEFAULT_CHAIN_ID, SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { useActiveChainId } from '../chain/active-chain'
import { clientFor } from '../chain/rpc'
import { factoryAbi, SLOT_DURATION_BLOCKS } from './abis-v2'
import {
  getBasketData,
  getUserHoldings,
  listBaskets,
  listBasketsForChain,
} from './basket-data'
import type { BasketSummary, NavPoint } from './basket-data'
import type { ExposureLeg } from './exposure'
import { resolveCreator, type ResolvedCreator } from './creator'
import { resolveCreatorMeta } from './creator-metadata'
import { resolveCreatorIdentityAny } from './creator-identity'
import { countVersionSeries } from './leaderboard'
import { buildLineageGraph, computeBasketDiff } from './versioning'
import {
  combineNavHistory,
  fetchAssetHistory,
  type ChartRange,
  type NavInput,
} from './history'

// ── Poll cadence ─────────────────────────────────────────────────────────────
// Display-grade list data doesn't need trade-grade freshness: 5 min on the
// chain the user is LOOKING AT, slower on the other(s). Every tick is a full
// per-visitor re-read of that chain's fleet, so cadence is the single biggest
// multiplier on a metered key (detail pages and tx paths stay fresh on their
// own reads). Intervals only run while the tab is focused (React Query
// default) — an unfocused tab polls nothing.
const LIST_POLL_ACTIVE_MS = 300_000
const LIST_POLL_INACTIVE_MS = 900_000
const LIST_STALE_MS = 120_000

// Every basket across the configured chains, sorted by AUM (objective metric).
// One query PER CHAIN (all sharing the ['spectrum','baskets',chainId] cache
// with useBasketsForChain), combined here — the inactive chain polls at a
// slower cadence instead of riding the active chain's interval. Each chain
// fails independently to [] (as listAllBaskets always did), so one chain's
// outage can't blank the other's list.
export function useAllBaskets() {
  const activeChainId = useActiveChainId()
  return useQueries({
    queries: SUPPORTED_CHAIN_IDS.map((chainId) => ({
      queryKey: ['spectrum', 'baskets', chainId],
      // No swallow (audit R7): a failed chain used to `.catch(() => [])`,
      // making an OUTAGE indistinguishable from an EMPTY chain — every
      // cross-chain money total silently omitted it. The error now lands in
      // the query (matching useBasketsForChain on the same cache key) and the
      // combine below keeps the other chains' list alive and COUNTS the gap.
      queryFn: () => listBasketsForChain(chainId),
      staleTime: LIST_STALE_MS,
      refetchInterval: chainId === activeChainId ? LIST_POLL_ACTIVE_MS : LIST_POLL_INACTIVE_MS,
    })),
    combine: (results) => ({
      // Undefined until every chain SETTLES once (data or final error) — same
      // first-paint semantics as before; a failed chain then contributes []
      // instead of blanking the others (stale data, when it exists, is kept).
      data: results.every((r) => r.data !== undefined || r.isError)
        ? results
            .flatMap((r) => (r.data ?? []) as BasketSummary[])
            .sort((a, b) => b.aumUsd - a.aumUsd)
        : undefined,
      isLoading: results.some((r) => r.isLoading),
      isError: results.every((r) => r.isError),
      /** Chains whose CURRENT read is failing (money surfaces say so). */
      chainsFailed: results.filter((r) => r.isError).length,
    }),
  })
}

export interface CreatorProfile {
  /** The deployer address this profile is keyed by. */
  address: string
  /** Resolved display identity. In V2 attribution is the on-chain deployer
   *  address (the honest fact) until creator-published metadata exists. */
  identity: ResolvedCreator
  /** Current (non-superseded) baskets this address deployed, sorted by AUM desc. */
  baskets: BasketSummary[]
  /** Count of current (non-superseded) baskets — the headline number. */
  basketCount: number
  /** Count of ALL versions incl. superseded (basketCount ≤ totalVersions). */
  totalVersions: number
  /** Count of verified version chains this creator maintains (≥2 linked versions). */
  seriesCount: number
  totalAumUsd: number
  /** Distinct chains this creator has launched on. */
  chains: number[]
  /** Baskets in the discovered list whose deployer is UNKNOWN (the registry
   *  read failed or hasn't landed yet) — any of them could be this creator's,
   *  so while this is non-zero an empty `baskets` means "could not check",
   *  never "this creator published nothing". The empty state branches on it. */
  unknownDeployerCount: number
}

// Pure aggregation: a creator profile = all baskets whose on-chain deployer
// matches, plus headline stats. No new fetch — derived from the cached list
// (which includes superseded versions; discovery surfaces filter them, we don't).
// Identity comes only from the deployer address until creator-published metadata
// exists (resolved separately, client-verified — see useCreatorMeta).
export function buildCreatorProfile(address: string, all: BasketSummary[]): CreatorProfile {
  const addr = address.toLowerCase()
  const mine = all.filter((b) => b.deployer?.toLowerCase() === addr)
  const baskets = mine.filter((b) => !b.supersededBy)
  const totalAumUsd = baskets.reduce((s, b) => s + (b.aumUsd || 0), 0)
  const chains = Array.from(new Set(baskets.map((b) => b.chainId)))
  const identity = resolveCreator({ deployer: address })
  return {
    address,
    identity,
    baskets,
    basketCount: baskets.length,
    totalVersions: mine.length,
    seriesCount: countVersionSeries(mine),
    totalAumUsd,
    chains,
    unknownDeployerCount: all.filter((b) => b.deployer == null).length,
  }
}

// All baskets by one creator (deployer) + headline stats. Reuses the cached
// `useAllBaskets` query, so opening a profile costs no extra network.
// `chainsFailed` rides along: a failed CHAIN contributes [] to the combined
// list, so this creator's every basket may live in the gap — the empty state
// must treat that as "could not check", exactly like an unknown deployer.
export function useCreatorProfile(address?: string) {
  const { data: all, isLoading, isError, chainsFailed } = useAllBaskets()
  const data = useMemo(
    () => (address && all ? buildCreatorProfile(address, all) : undefined),
    [address, all],
  )
  return { data, isLoading, isError, chainsFailed }
}

export interface PortfolioHolding {
  basket: BasketSummary
  /** Balance in token units. */
  balance: number
  /** balance × navPerToken, in USD. */
  valueUsd: number
  /** WHO holds it, per group member (owner 2026-08-16, the sort-by-wallet
   *  control): the merged read has kept per-wallet balances since 2026-08-11
   *  — this carries them onto the row instead of discarding them at the fold.
   *  Absent on single-wallet reads, where the owner is the address itself. */
  contributors?: { owner: string; usd: number }[]
}

export interface Portfolio {
  address: string
  /** Held baskets (non-zero balance), sorted by value desc. */
  holdings: PortfolioHolding[]
  /** Baskets this wallet deployed. */
  created: BasketSummary[]
  totalValueUsd: number
  heldCount: number
  createdCount: number
  /** Baskets whose balance could not be READ this pass (an RPC refusal, not a
   *  zero balance). Every total here is a floor while this is > 0, and the
   *  page must say so rather than printing at full confidence. */
  unreadableCount: number
  /** Held-basket USD per wallet in the group (lowercase address → USD). The
   *  group panel's rows could previously only show TOKEN dollars and carried a
   *  note saying baskets were unattributable; they are attributable now. */
  basketUsdByWallet: Map<string, number>
}

// A connected wallet's positions: baskets held (balance × NAV) + baskets
// created. Per-wallet balances are the only fresh read (batched per chain).
//
// Takes one address, or a linked-wallet GROUP (wallet-links.ts). A group
// merges the READ — balances sum per basket, `created` unions — and the
// returned `address` is the group's FIRST entry (the anchor; group callers
// must not act on it — acting belongs to useAccount's connected wallet).
// Single-address callers behave byte-identically.
export function usePortfolio(address?: string | string[]) {
  const { data: all, isLoading: allLoading, isError: allError, chainsFailed } = useAllBaskets()
  const qc = useQueryClient()
  const baskets = useMemo(() => all ?? [], [all])
  const sig = baskets.map((b) => `${b.chainId}:${b.address}`).join(',')
  const addrSig = (Array.isArray(address) ? address.join(',') : (address ?? '')).toLowerCase()
  const addrs = useMemo(() => {
    const list = (Array.isArray(address) ? address : address ? [address] : []).map((a) => a.toLowerCase())
    return list.filter((a, i) => a && list.indexOf(a) === i)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrSig])

  const balances = useQuery({
    queryKey: ['spectrum', 'portfolio', addrs.join('|'), sig],
    queryFn: async () => {
      const reads = await Promise.all(addrs.map((a) => getUserHoldings(a as Address, baskets)))
      const merged = new Map<string, number>()
      // WHO holds it, kept alongside HOW MUCH (2026-08-11): the raw-token
      // sweep has carried `contributors` since it learned to read groups, and
      // the basket half threw the same fact away — so the group panel could
      // only show token dollars per wallet and had to say so. Same shape here.
      const byWallet = new Map<string, Map<string, number>>()
      for (let i = 0; i < reads.length; i++) {
        const owner = addrs[i]
        for (const [k, v] of reads[i].balances) {
          merged.set(k, (merged.get(k) ?? 0) + v)
          if (v > 0) {
            const per = byWallet.get(k) ?? new Map<string, number>()
            per.set(owner, (per.get(owner) ?? 0) + v)
            byWallet.set(k, per)
          }
        }
      }
      // A basket counts as unreadable when a read of it FAILED and no wallet in
      // the group produced a number for it — one wallet's success is a real
      // (if partial) answer, and calling that unreadable would over-warn.
      const unreadable = new Set<string>()
      for (const r of reads) for (const k of r.unreadable) if (!merged.has(k)) unreadable.add(k)
      return { balances: merged, unreadable, byWallet }
    },
    enabled: addrs.length > 0 && baskets.length > 0,
    staleTime: LIST_STALE_MS,
    refetchInterval: LIST_POLL_ACTIVE_MS,
    // Group changes change the KEY — keep the standing book while the merged
    // balances load rather than emptying the page (same law as raw-holdings,
    // including its identity gate: an account SWITCH shares no address with
    // the previous read, and carrying it showed A's positions — and a bogus
    // transient PnL against B's cost-basis indexes — under B's name).
    placeholderData: (prev, prevQuery) => {
      if (!prev || !prevQuery) return undefined
      const prevSet = String(prevQuery.queryKey[2] ?? '').split('|').filter(Boolean)
      return prevSet.some((a) => addrs.includes(a)) ? prev : undefined
    },
  })

  const data = useMemo<Portfolio | undefined>(() => {
    if (addrs.length === 0 || !all) return undefined
    const balMap = balances.data?.balances ?? new Map<string, number>()
    const holdings = all
      .map((basket) => {
        const balance = balMap.get(basket.address.toLowerCase()) ?? 0
        // per-wallet attribution rides the row (sort-by-wallet, 2026-08-16) —
        // the byWallet map already held it; the fold just stopped dropping it
        const per = balances.data?.byWallet.get(basket.address.toLowerCase())
        const contributors = per
          ? [...per.entries()]
              .filter(([, bal]) => bal > 0)
              .map(([owner, bal]) => ({ owner, usd: bal * basket.navPerToken }))
              .sort((a, b) => b.usd - a.usd)
          : undefined
        return { basket, balance, valueUsd: balance * basket.navPerToken, ...(contributors?.length ? { contributors } : {}) }
      })
      .filter((h) => h.balance > 0)
      .sort((a, b) => b.valueUsd - a.valueUsd)
    const created = all.filter(
      (b) => b.deployer && addrs.includes(b.deployer.toLowerCase()) && !b.supersededBy,
    )
    const totalValueUsd = holdings.reduce((s, h) => s + h.valueUsd, 0)
    // per-wallet BASKET dollars, priced with the same NAV the rows use
    const basketUsdByWallet = new Map<string, number>()
    for (const h of holdings) {
      const per = balances.data?.byWallet.get(h.basket.address.toLowerCase())
      if (!per) continue
      for (const [owner, bal] of per) {
        basketUsdByWallet.set(owner, (basketUsdByWallet.get(owner) ?? 0) + bal * h.basket.navPerToken)
      }
    }
    return {
      address: addrs[0],
      holdings,
      created,
      totalValueUsd,
      heldCount: holdings.length,
      createdCount: created.length,
      // baskets whose balance the RPC would not answer for — a FLOOR marker on
      // every total derived from this book (audit 2026-08-11)
      unreadableCount: balances.data?.unreadable.size ?? 0,
      basketUsdByWallet,
    }
  }, [addrs, all, balances.data])

  // A failed portfolio read used to be a DEAD END (audit 2026-08-07): this hook
  // handed back `isError` and no way to try again, so Yours.tsx could only
  // apologise and the reader's only exit was a browser reload. Both halves have
  // to go back out, in order: the per-chain basket lists first (their all-fail
  // is what `allError` reports, and an empty list keeps `balances` disabled), then
  // this wallet's balances for the case where the lists were fine and the
  // balance read is what blipped. The lists go through the client rather than
  // useAllBaskets' combine — that shape is shared with every other caller and
  // does not need a refetch handle bolted onto it for one page's retry button.
  const refetch = useCallback(async () => {
    await qc.refetchQueries({ queryKey: ['spectrum', 'baskets'] })
    await balances.refetch()
  }, [qc, balances.refetch])

  return { data, isLoading: allLoading || balances.isLoading, isError: allError || balances.isError, chainsFailed, refetch }
}

export interface LiveExposure {
  /** Live (current pool) legs per held basket, keyed `${chainId}:${lowercased address}`. */
  legsByKey: Map<string, ExposureLeg[]>
  /** A fresh per-basket read is in flight. */
  isLoading: boolean
  /** Held baskets whose live legs resolved / total held (for an honest caption). */
  resolved: number
  total: number
}

// Live per-asset weights for the portfolio look-through. The cached summary only
// carries each basket's TARGET weights; the actual current pool weights drift as
// prices move, so 'live' basis needs a fresh `getBasketData` per held basket.
// Gated by `enabled` — costs nothing until the user opts into the live view — and
// keyed identically to `useBasketData`, so it dedupes with any open detail page.
export function useLiveExposure(holdings: PortfolioHolding[], enabled: boolean): LiveExposure {
  const results = useQueries({
    queries: holdings.map((h) => ({
      queryKey: ['spectrum', 'basket', h.basket.chainId, h.basket.address.toLowerCase()],
      queryFn: () => getBasketData(h.basket.address as Address, h.basket.chainId, { inception: true, detail: true }),
      enabled: enabled && !!h.basket.address,
      staleTime: 60_000,
    })),
  })

  const holdingsSig = holdings.map((h) => `${h.basket.chainId}:${h.basket.address.toLowerCase()}`).join(',')
  const dataSig = results.map((r) => r.dataUpdatedAt ?? 0).join('|')

  return useMemo(() => {
    const legsByKey = new Map<string, ExposureLeg[]>()
    let resolved = 0
    holdings.forEach((h, i) => {
      const d = results[i]?.data
      if (!d) return
      legsByKey.set(
        `${h.basket.chainId}:${h.basket.address.toLowerCase()}`,
        d.holdings.map((leg) => ({ address: leg.asset, symbol: leg.symbol, weightPct: leg.liveWeightPct })),
      )
      resolved += 1
    })
    return {
      legsByKey,
      isLoading: enabled && results.some((r) => r.isLoading),
      resolved,
      total: holdings.length,
    }
  }, [enabled, holdingsSig, dataSig]) // eslint-disable-line react-hooks/exhaustive-deps
}

// Verified, render-safe creator metadata for one basket (X handle / avatar /
// banner + version lineage). Null until a deployer-signed blob is
// published AND verifies against the basket's on-chain deployer
// (creator-metadata.ts); callers then fall back to address attribution.
// Per-basket metadata is effectively immutable → cache hard.
export function useCreatorMeta(basket?: string, chainId: number = DEFAULT_CHAIN_ID) {
  return useQuery({
    queryKey: ['spectrum', 'creatorMeta', chainId, basket?.toLowerCase()],
    queryFn: () => resolveCreatorMeta(basket as Address, chainId),
    enabled: !!basket,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  })
}

// Verified, SELF-signed creator identity (profile page: name/bio/banner +
// bullish-on picks — creator-identity.ts). Resolves across every scaffolded
// chain; null → honest address attribution. Invalidated by the /creators editor
// on publish so the creator's own page updates without a reload.
export function useCreatorIdentity(creator?: string) {
  return useQuery({
    queryKey: ['spectrum', 'creatorIdentity', creator?.toLowerCase()],
    queryFn: () => resolveCreatorIdentityAny(creator as Address),
    enabled: !!creator,
    staleTime: 60_000,
    gcTime: 30 * 60_000,
  })
}

// Sector tags across a set of baskets (the Explore tags rail) — one query per
// basket via useQueries, EXACTLY mirroring useCreatorMeta's key/fn so the rows'
// own metadata lookups and this rail share one cache (no double fetches).
export function useBasketSectors(
  baskets: { address: string; chainId: number }[],
): Map<string, string[]> {
  const results = useQueries({
    queries: baskets.map((b) => ({
      queryKey: ['spectrum', 'creatorMeta', b.chainId, b.address.toLowerCase()],
      queryFn: () => resolveCreatorMeta(b.address as Address, b.chainId),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    })),
  })
  return useMemo(() => {
    const out = new Map<string, string[]>()
    results.forEach((r, i) => {
      const sectors = r.data?.sectors ?? []
      if (sectors.length > 0) out.set(`${baskets[i].chainId}:${baskets[i].address.toLowerCase()}`, sectors)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.data).filter(Boolean).length, baskets.length])
}

export interface LineageInfo {
  /** Lowercased addresses, root → head. */
  versions: string[]
  /** 1-based position of `basket` in its lineage. */
  version: number
  count: number
  head: string | null
  predecessor: string | null
  successor: string | null
  hasPredecessor: boolean
  hasSuccessor: boolean
}

// Version lineage for one basket, derived from deployer-signed `supersedes`
// claims (versioning.ts). The per-chain graph is built once and shared across
// every basket on that chain via the query cache (the perf lever). With no
// metadata host configured every basket is its own single version.
export function useLineage(basket?: string, chainId: number = DEFAULT_CHAIN_ID): LineageInfo {
  const { data: all } = useAllBaskets()
  const refs = useMemo(
    () =>
      (all ?? [])
        .filter((b) => b.chainId === chainId)
        .map((b) => ({ address: b.address, chainId: b.chainId, deployer: b.deployer })),
    [all, chainId],
  )
  const sig = refs.map((r) => r.address.toLowerCase()).sort().join(',')
  const graph = useQuery({
    queryKey: ['spectrum', 'lineageGraph', chainId, sig],
    queryFn: () => buildLineageGraph(refs),
    enabled: refs.length > 0,
    staleTime: 5 * 60_000,
  })
  return useMemo<LineageInfo>(() => {
    const g = graph.data
    const a = basket?.toLowerCase() ?? null
    if (!g || !a) {
      return {
        versions: a ? [a] : [],
        version: 1,
        count: a ? 1 : 0,
        head: a,
        predecessor: null,
        successor: null,
        hasPredecessor: false,
        hasSuccessor: false,
      }
    }
    const versions = g.lineageOf(a)
    const idx = versions.indexOf(a)
    return {
      versions,
      version: idx >= 0 ? idx + 1 : 1,
      count: versions.length,
      head: g.headOf(a),
      predecessor: g.predecessorOf(a),
      successor: g.successorOf(a),
      hasPredecessor: !!g.predecessorOf(a),
      hasSuccessor: g.hasSuccessor(a),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.data, basket])
}

// On-chain diff (added / removed / reweighted constituents) between two versions.
export function useBasketDiff(prevAddr?: string, nextAddr?: string, chainId: number = DEFAULT_CHAIN_ID) {
  return useQuery({
    queryKey: ['spectrum', 'basketDiff', chainId, prevAddr?.toLowerCase(), nextAddr?.toLowerCase()],
    queryFn: async () => {
      const [prev, next] = await Promise.all([
        getBasketData(prevAddr as Address, chainId),
        getBasketData(nextAddr as Address, chainId),
      ])
      return computeBasketDiff(prev, next)
    },
    enabled: !!prevAddr && !!nextAddr,
    staleTime: 60_000,
  })
}

// Baskets on a single chain. Shares its cache entry with useAllBaskets'
// per-chain queries (same key), so mounting both costs one fetch, not two.
export function useBasketsForChain(chainId: number) {
  return useQuery({
    queryKey: ['spectrum', 'baskets', chainId],
    queryFn: () => listBasketsForChain(chainId),
    staleTime: LIST_STALE_MS,
    refetchInterval: LIST_POLL_ACTIVE_MS,
  })
}

// Back-compat: default-chain-only list.
export function useBaskets() {
  return useQuery({
    queryKey: ['spectrum', 'baskets', DEFAULT_CHAIN_ID],
    queryFn: listBaskets,
    staleTime: LIST_STALE_MS,
    refetchInterval: LIST_POLL_ACTIVE_MS,
  })
}

// Full data for a single basket (constituents, NAV, holdings, series).
export function useBasketData(address?: string, chainId: number = DEFAULT_CHAIN_ID) {
  return useQuery({
    queryKey: ['spectrum', 'basket', chainId, address?.toLowerCase()],
    queryFn: () => getBasketData(address as Address, chainId, { inception: true, detail: true }),
    enabled: !!address,
    staleTime: 60_000,
  })
}

export interface NavHistoryInput {
  chainId: number
  assets: NavInput[]
  navPerToken: number
  ageSec?: number | null
  range: ChartRange
  /** Decorative sparkline surfaces (list cards) prefer the keyless history
   *  source; detail-grade charts keep the keyed source first. Distinct query
   *  keys per tier — a coarse spark series must never fill a detail chart's
   *  cache slot (LaunchBanner deliberately shares BasketStats' detail key). */
  spark?: boolean
}

// Real reconstructed NAV history for one basket over a range. Each constituent's
// price series is its own React Query (keyed by chain/addr/range), so identical
// assets across many cards are de-duplicated to a single network call.
export function useNavHistory(input?: NavHistoryInput) {
  const range: ChartRange = input?.range ?? '7D'
  const chainId = input?.chainId ?? 0
  const ageSec = input?.ageSec ?? null
  const navPerToken = input?.navPerToken ?? 0
  const spark = input?.spark ?? false

  // Stable signature so identity-changing `assets` arrays don't thrash memos.
  const sig = (input?.assets ?? [])
    .map((a) => `${a.address.toLowerCase()}:${a.weight}`)
    .join('|')
  const assets = useMemo(() => input?.assets ?? [], [sig]) // eslint-disable-line react-hooks/exhaustive-deps
  const uniqAddrs = useMemo(
    () => Array.from(new Set(assets.map((a) => a.address.toLowerCase()))),
    [sig], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const results = useQueries({
    queries: uniqAddrs.map((addr) => ({
      queryKey: spark
        ? ['spectrum', 'assetHist', chainId, addr, range, 'spark']
        : ['spectrum', 'assetHist', chainId, addr, range],
      queryFn: () => fetchAssetHistory(chainId, addr, range, ageSec, { preferKeyless: spark }),
      enabled: !!input && chainId > 0 && uniqAddrs.length > 0,
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
    })),
  })

  const isLoading = results.length > 0 && results.some((r) => r.isLoading)
  const updatedKey = results.map((r) => r.dataUpdatedAt).join(',')

  const { data, perAsset } = useMemo<{ data: NavPoint[]; perAsset: PerAssetReturn[] }>(() => {
    if (!input || uniqAddrs.length === 0) return { data: [], perAsset: [] }
    const map = new Map<string, NavPoint[]>()
    uniqAddrs.forEach((addr, i) => map.set(addr, results[i]?.data ?? []))
    const curve = combineNavHistory(assets, map, navPerToken)
    const perAsset: PerAssetReturn[] = assets.map((a) => {
      const s = map.get(a.address.toLowerCase()) ?? []
      const base = s.length ? s[0].value : 0
      const pct = s.length >= 2 && base > 0 ? (s[s.length - 1].value / base - 1) * 100 : null
      const series = base > 0 ? s.map((p) => ({ time: p.time, value: (p.value / base) * 100 })) : []
      return { address: a.address, weight: a.weight, pct, series }
    })
    return { data: curve, perAsset }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, updatedKey, navPerToken])

  return { data, perAsset, isLoading }
}

// One constituent's real price history (shared query key with the chart engine).
export function useAssetHistory(chainId: number, address: string | undefined, range: ChartRange = '7D') {
  return useQuery({
    queryKey: ['spectrum', 'assetHist', chainId, address?.toLowerCase(), range],
    queryFn: () => fetchAssetHistory(chainId, address as string, range),
    enabled: !!address && chainId > 0,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  })
}

export interface PerAssetReturn {
  address: string
  weight: number
  /** % change over the window; null if the series is too short to price. */
  pct: number | null
  /** Price history normalized to 100 at the window start. */
  series: NavPoint[]
}

// Live Dutch-auction deploy price (currentDeployPrice). Read-only,
// polled so the launch CTA can show a live cost. Auction params themselves come
// from factory views (abis-v2), never hardcoded. With no factory configured
// (shipped default) this reports a closed slot.
export function useDeployPrice(chainId: number, enabled = true) {
  return useQuery({
    queryKey: ['spectrum', 'deployPrice', chainId],
    enabled,
    queryFn: async (): Promise<{ priceWei: bigint | null; slotOpen: boolean; blocksLeft: number | null }> => {
      const factory = chainCfg(chainId).factory
      if (!factory) return { priceWei: null, slotOpen: false, blocksLeft: null }
      const client = clientFor(chainId)
      try {
        const wei = await client.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: 'currentDeployPrice',
        })
        return { priceWei: wei as bigint, slotOpen: true, blocksLeft: null }
      } catch {
        // SlotNotOpen() — the 10-block cooldown after someone else's launch
        // (contracts team, launch ceremony: show a COUNTDOWN, never a stale
        // price). lastDeployBlock is public, so the remaining wait is exact.
        try {
          const [last, now] = await Promise.all([
            client.readContract({ address: factory, abi: factoryAbi, functionName: 'lastDeployBlock' }),
            client.getBlockNumber(),
          ])
          const left = Number((last as bigint) + SLOT_DURATION_BLOCKS - now)
          return { priceWei: null, slotOpen: false, blocksLeft: left > 0 ? left : 1 }
        } catch {
          return { priceWei: null, slotOpen: false, blocksLeft: null }
        }
      }
    },
    // Only currentDeployPrice() exists on-chain (no param getters), so a poll
    // is unavoidable — 12 s tracks the V2 auction's decline plenty closely for
    // a CTA (the click-time simulate reprices exactly; the new lineage's flat
    // fee makes the poll a slot-open watcher and nothing more), at half
    // the standing cost of the old 6 s loop. Callers already gate `enabled`
    // to a fully-specified basket; the interval also stops while unfocused.
    refetchInterval: 12_000,
    staleTime: 10_000,
  })
}
