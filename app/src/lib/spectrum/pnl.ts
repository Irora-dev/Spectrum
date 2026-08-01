import { parseAbiItem, toFunctionSelector, type Address, type PublicClient } from 'viem'
import { useQueries, useQuery } from '@tanstack/react-query'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { clientFor, hasPrivateRpc, publicWideLogsRisky } from '../chain/rpc'
import { cacheGet, cacheSet } from './persist-cache'

// ─────────────────────────────────────────────────────────────────────────────
// Position PnL — "Invested capital · Current value · Net PnL" (owner
// 2026-07-31) for the Token page + Portfolio, built to spend almost no RPC:
//
//   · ONE wide filtered getLogs per (chain, wallet) — the router's Swapped
//     event indexes BOTH basket and trader, so a single trader-filtered call
//     returns every buy and sell across EVERY basket at once. No per-basket
//     scanning, ever. The call carries EVERY lineage's router (current +
//     legacy) as an address array, so kept-listed superseded baskets get a
//     basis from the router they actually trade through — still one call.
//   · The fold is PERSISTED (localStorage, no expiry — logs are immutable
//     history) with the last scanned block; revisits top up incrementally
//     from there, so a returning browser pays one bounded call per chain —
//     and none within the in-session rate limit.
//   · Same wide-logs convention as the launch index / V4 sweep: needs a
//     private endpoint on Base/Ethereum (key or provider URL); Robinhood's
//     own public node serves full-range filtered logs fine. Ungated chains
//     simply render no PnL — the feature self-hides, never spams a public
//     endpoint.
//
// BASIS DEFINITION (the honest part): average-cost over what this wallet
// TRADED THROUGH THIS PROTOCOL'S ROUTER, in settlement terms (6dp ≈ $).
//   buy  → cost += settlementIn;  shares += sharesOut
//   sell → the sold shares carry out their proportional share of cost;
//          realized += settlementOut − costRemoved
// Tokens that arrived any other way (wallet transfers, migrations' in-kind
// mints) have no knowable price here — they are EXCLUDED from the basis, the
// UI compares tracked-cost against the value of TRACKED shares only, and says
// so when the wallet holds more than the basis covers. A sell of untracked
// shares can't invent basis either: only the covered portion books realized
// PnL. No number this module produces is ever a guess.
// ─────────────────────────────────────────────────────────────────────────────

const swappedEvent = parseAbiItem(
  'event Swapped(address indexed basket, address indexed trader, address tokenIn, uint256 amountIn, uint256 amountOut, address frontend)',
)

export interface PnlPosition {
  /** Remaining average-cost basis, settlement raw (6dp). */
  cost: string
  /** Shares that basis covers, raw (18dp). */
  shares: string
  /** Realized PnL banked by sells of covered shares, settlement raw (6dp). */
  realized: string
}

export interface PnlIndex {
  /** Last block folded in (stringified bigint). */
  upToBlock: string
  /** lowercased basket address → position. */
  positions: Record<string, PnlPosition>
}

export interface SwapFlow {
  basket: string
  /** buy = settlement in, shares out · sell = shares in, settlement out ·
   *  sellEth = shares in, ETH out (proceeds unpriceable here: the sold
   *  shares' basis leaves the position but no realized PnL books). */
  kind: 'buy' | 'sell' | 'sellEth'
  amountIn: bigint
  amountOut: bigint
}

/** Fold trade flows into positions — average-cost, pure, exported for tests.
 *  Flows must arrive in chain order (getLogs returns them ordered). */
export function foldFlows(positions: Record<string, PnlPosition>, flows: SwapFlow[]): Record<string, PnlPosition> {
  const out = { ...positions }
  for (const f of flows) {
    const key = f.basket.toLowerCase()
    const p = out[key] ?? { cost: '0', shares: '0', realized: '0' }
    let cost = BigInt(p.cost)
    let shares = BigInt(p.shares)
    let realized = BigInt(p.realized)
    if (f.kind === 'buy') {
      cost += f.amountIn
      shares += f.amountOut
    } else if (shares > 0n && f.amountIn > 0n) {
      // Only the tracked portion of a sell carries basis; shares that arrived
      // outside the router have no cost here and book nothing.
      const covered = f.amountIn > shares ? shares : f.amountIn
      const costRemoved = (cost * covered) / shares
      if (f.kind === 'sell') {
        // settlement proceeds (6dp $) — realized books
        const proceedsCovered = (f.amountOut * covered) / f.amountIn
        realized += proceedsCovered - costRemoved
      }
      // ETH-out sells: proceeds are wei, unpriceable here — the basis still
      // LEAVES with the shares (or remaining-basis would overstate what the
      // held position cost), but realized never books a guessed number.
      cost -= costRemoved
      shares -= covered
    }
    out[key] = { cost: cost.toString(), shares: shares.toString(), realized: realized.toString() }
  }
  return out
}

// v2: the scan gained the legacy lineages' routers, so a v1 index is missing
// every superseded-basket trade — rebuild rather than top up onto a short fold.
const CACHE_VER = 'v2'
// The ROUTER SET is part of the key, not just the version. A newly-added legacy
// lineage's trades are all historical — below the cached `upToBlock` — and the
// incremental top-up only ever scans forward, so without this a book edit that
// adds a router would silently under-report that wallet's basis forever, with
// no self-heal and no way for a user to clear it. This has a precedent: the old
// ETH/Base lineage was discovered days after the new contracts were seated.
// Keying on the set makes the invalidation automatic instead of a promise that
// whoever edits deployments.json also remembers to bump CACHE_VER here.
const keyFor = (chainId: number, wallet: string) =>
  `pnl:${CACHE_VER}:${chainId}:${wallet.toLowerCase()}:${routersFor(chainId)
    .map((r) => r.toLowerCase())
    .join(',')}`

const inflight = new Map<string, Promise<PnlIndex | null>>()
const lastScanMs = new Map<string, number>()
const RESCAN_FLOOR_MS = 120_000

/** Every lineage's router on this chain — current first, then the superseded
 *  ones whose baskets stay listed. Deduped: the same address twice in a
 *  getLogs address array risks a node returning the log twice, and the fold
 *  is not idempotent (a double-counted buy inflates the basis outright). */
export function routersFor(chainId: number): Address[] {
  const cfg = chainCfg(chainId)
  const all = [cfg.swapRouter, ...cfg.legacy.map((l) => l.swapRouter)].filter(Boolean) as Address[]
  return [...new Map(all.map((a) => [a.toLowerCase(), a])).values()]
}

/** True when this chain can serve the one wide scan the index needs. */
export function pnlAvailable(chainId: number): boolean {
  if (routersFor(chainId).length === 0) return false
  return hasPrivateRpc(chainId) || !publicWideLogsRisky(chainId)
}

// A settlement sell and an ETH-out sell emit the SAME event shape (tokenIn =
// the basket) but amountOut in different units — dollars at 6dp vs ETH wei — so
// sells are classified by their tx's input selector: exact, never a magnitude
// guess. (Probed live on the deployed 4663 router 2026-08-01: both ETH
// entrypoints exist there, so the ambiguity is real on-chain.) We match the
// SETTLEMENT entrypoint positively; see the classifier for why the default has
// to be the other way.
const SETTLEMENT_SELL_SELECTOR = toFunctionSelector(
  'function swapExactIn(address,address,uint256,uint256,bytes,address)',
)

async function scan(client: PublicClient, routers: Address[], wallet: Address, fromBlock: bigint, toBlock: bigint): Promise<SwapFlow[]> {
  const logs = await client.getLogs({
    address: routers,
    event: swappedEvent,
    args: { trader: wallet },
    fromBlock,
    toBlock,
  })
  const flows: SwapFlow[] = []
  for (const l of logs) {
    const basket = l.args.basket as string
    const tokenIn = (l.args.tokenIn as string).toLowerCase()
    const amountIn = l.args.amountIn as bigint
    const amountOut = l.args.amountOut as bigint
    if (tokenIn !== basket.toLowerCase()) {
      // BUY. tokenIn == address(0) is the router's ETH entrypoint: amountIn is
      // ETH WEI, and the shares' dollar cost is unknowable from the event —
      // folding it as settlement would inflate the basis ×10^12 (audit
      // 2026-08-01). Excluded: the shares simply stay uncovered, exactly like
      // a transfer-in, and the coverage ⓘ says so.
      if (tokenIn === '0x0000000000000000000000000000000000000000') continue
      flows.push({ basket, kind: 'buy', amountIn, amountOut })
    } else {
      // SELL — settlement-out vs ETH-out share one event shape; classify by
      // the tx's input selector. One getTransaction per SELL log only (sells
      // are the rare flow), folded once then cached forever with the index.
      // Classified by POSITIVE match on the settlement entrypoint, not by
      // ruling out the ETH one. The retired lineages are a different build
      // (6356 bytes vs the live routers' 6429) and nothing has verified their
      // ETH-out signature; under a negative test an unrecognised selector
      // would fall through to 'sell' and fold WEI as 6-dp dollars — a 0.1 ETH
      // sale rendering as +$100,000,000,000 realized. That matters here and
      // now: every listed basket on Ethereum and Base today is legacy-lineage.
      // Unknown therefore means 'sellEth' — the basis leaves with the shares
      // and nothing books, which understates rather than inventing.
      let kind: SwapFlow['kind'] = 'sellEth'
      try {
        const tx = await client.getTransaction({ hash: l.transactionHash })
        if (tx.input.slice(0, 10).toLowerCase() === SETTLEMENT_SELL_SELECTOR) kind = 'sell'
      } catch {
        kind = 'sellEth'
      }
      flows.push({ basket, kind, amountIn, amountOut })
    }
  }
  return flows
}

/** Load (and incrementally top up) the wallet's PnL index for one chain. */
export async function loadPnlIndex(chainId: number, wallet: Address, force = false): Promise<PnlIndex | null> {
  if (!pnlAvailable(chainId)) return null
  const routers = routersFor(chainId)
  const key = keyFor(chainId, wallet)

  const running = inflight.get(key)
  if (running) return running

  const run = (async (): Promise<PnlIndex | null> => {
    const cached = cacheGet<PnlIndex>(key)
    const last = lastScanMs.get(key) ?? 0
    if (cached && !force && Date.now() - last < RESCAN_FLOOR_MS) return cached
    try {
      const client = clientFor(chainId)
      // Fold only to head − 5: the fold is not idempotent, so a shallow reorg
      // under upToBlock could otherwise double-count or drop a trade. The
      // unconfirmed tail folds next visit once it's 5-deep.
      const head = (await client.getBlockNumber()) - 5n
      const from = cached ? BigInt(cached.upToBlock) + 1n : 0n
      if (head < 0n || (cached && from > head)) return cached
      const flows = await scan(client, routers, wallet, from, head)
      const next: PnlIndex = {
        upToBlock: head.toString(),
        positions: foldFlows(cached?.positions ?? {}, flows),
      }
      cacheSet(key, next, 0) // history is immutable — never expires
      lastScanMs.set(key, Date.now())
      return next
    } catch {
      // RPC hiccup: keep whatever we had; the UI simply shows nothing new.
      return cached ?? null
    }
  })()
  inflight.set(key, run)
  try {
    return await run
  } finally {
    inflight.delete(key)
  }
}

export interface BasketPnl {
  /** Remaining basis, in dollars (settlement units). */
  investedUsd: number
  /** Value of the shares the basis covers, at the CURRENT nav. */
  currentUsd: number
  /** currentUsd − investedUsd (unrealized, on covered shares). */
  netUsd: number
  /** netUsd / investedUsd. */
  netPct: number
  /** Realized PnL banked by past sells, in dollars (0 when never sold). */
  realizedUsd: number
  /** Covered shares as a fraction of the wallet's live balance (≤1). Below
   *  ~0.99 the UI says the basis covers only part of the position. */
  coverage: number
}

/** Derive display PnL for one basket from the index + live balance/NAV. */
export function basketPnl(
  index: PnlIndex | null | undefined,
  basket: string,
  navPerToken: number,
  balanceTokens: number,
): BasketPnl | null {
  const p = index?.positions[basket.toLowerCase()]
  if (!p) return null
  const cost = Number(BigInt(p.cost)) / 1e6
  const shares = Number(BigInt(p.shares)) / 1e18
  const realized = Number(BigInt(p.realized)) / 1e6
  if (cost <= 0 && realized === 0) return null
  // Compare basis against what the wallet STILL HOLDS. Fewer tokens than the
  // basis covers (a transfer-out) → the departed tokens take their share of
  // the basis with them (their outcome is unknowable here); more tokens than
  // covered (a transfer-in / ETH-path buy) → the extras carry no basis and
  // the coverage ⓘ says so. Both directions stay proportional — full cost
  // against a partial holding read as a fake loss (audit 2026-08-01).
  const covered = Math.min(shares, balanceTokens)
  if (covered <= 0 && realized === 0) return null
  const investedUsd = shares > 0 ? (cost * covered) / shares : 0
  const currentUsd = covered * navPerToken
  const netUsd = currentUsd - investedUsd
  return {
    investedUsd,
    currentUsd,
    netUsd,
    netPct: investedUsd > 0 ? netUsd / investedUsd : 0,
    realizedUsd: realized,
    coverage: balanceTokens > 0 ? Math.min(1, shares / balanceTokens) : 1,
  }
}

/** The wallet's PnL index for a chain — one shared query per (chain, wallet). */
export function usePnlIndex(chainId: number, wallet?: string) {
  return useQuery({
    queryKey: ['spectrum', 'pnl', chainId, wallet?.toLowerCase()],
    queryFn: () => loadPnlIndex(chainId, wallet as Address),
    enabled: !!wallet && pnlAvailable(chainId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
}

/** Every configured chain's index at once (the Portfolio summary) — same
 *  cache keys as usePnlIndex, so the per-holding rows ride the same data. */
export function usePnlIndexes(wallet?: string): Record<number, PnlIndex | null> {
  return useQueries({
    queries: SUPPORTED_CHAIN_IDS.map((chainId) => ({
      queryKey: ['spectrum', 'pnl', chainId, wallet?.toLowerCase()],
      queryFn: () => loadPnlIndex(chainId, wallet as Address),
      enabled: !!wallet && pnlAvailable(chainId),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    })),
    combine: (results) =>
      Object.fromEntries(SUPPORTED_CHAIN_IDS.map((id, i) => [id, results[i].data ?? null])),
  })
}
