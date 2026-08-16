import { parseAbiItem, toFunctionSelector, type Address, type PublicClient } from 'viem'
import { useQueries, useQuery } from '@tanstack/react-query'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { clientFor, hasPrivateRpc, publicWideLogsRisky } from '../chain/rpc'
import { cacheGet, cacheSet } from './persist-cache'
import { chainlinkFeedFor, fetchChainlinkHistory } from './chainlink-history'

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

/** One trade, stored raw so the history can be REPLAYED (2026-08-11).
 *  bigints are stringified — JSON has no bigint, and a money number must not
 *  round-trip through a float. */
export interface StoredFlow {
  basket: string
  kind: SwapFlow['kind']
  amountIn: string
  amountOut: string
  blockNumber?: string
  txHash?: string
  /** ETH-out sells: proceeds priced at the sale's own block, settlement 6dp. */
  proceedsUsd6?: string
}

export interface PnlIndex {
  /** Last block folded in (stringified bigint). */
  upToBlock: string
  /** lowercased basket address → position. */
  positions: Record<string, PnlPosition>
  /** THE TRADES THEMSELVES, in chain order (2026-08-11). The fold answers
   *  "what is it worth now"; a tax/accounting export answers "what happened,
   *  when, against what basis" — which a running total cannot, because the
   *  fold discards every individual disposal. Kept in the SAME cache write as
   *  `positions` so the two can never cover different blocks. Absent on an
   *  index written before this existed; CACHE_VER forces the rebuild. */
  flows?: StoredFlow[]
}

export interface SwapFlow {
  basket: string
  /** buy = settlement in, shares out · sell = shares in, settlement out ·
   *  sellEth = shares in, ETH out. */
  kind: 'buy' | 'sell' | 'sellEth'
  amountIn: bigint
  amountOut: bigint
  /** The log's block. Priced ETH-out proceeds need it; the trade-history
   *  export needs it on EVERY flow to date the row (2026-08-11). */
  blockNumber?: bigint
  /** The transaction, so an exported row can be verified on a block explorer —
   *  an accountant's document has to be checkable, not just readable. */
  txHash?: string
  /** ETH-out sells only: the wei proceeds valued in SETTLEMENT units (6dp) at
   *  the sale's own block, priced by the caller.
   *
   *  the owner 2026-08-02: "a sell paid out in eth is defffo pnl yes." It used to
   *  book nothing, because pricing wei needed a price and the module refuses to
   *  guess one. The resolution is not to guess: the caller prices the proceeds
   *  at the BLOCK THE SALE HAPPENED IN, never at spot-now, so this is a
   *  historical fact rather than a present-day estimate applied to a past
   *  event. Absent (no feed on that chain) it stays unbooked exactly as before
   *  — a missing price is not a verdict. */
  proceedsUsd6?: bigint
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
      if (f.kind === 'sellEth' && f.proceedsUsd6 != null) {
        // ETH-out proceeds, valued at the sale's own block by the caller. Same
        // arithmetic as a settlement sell — only the source of the number differs.
        const proceedsCovered = (f.proceedsUsd6 * covered) / f.amountIn
        realized += proceedsCovered - costRemoved
      }
      // An ETH-out sell with NO price (no feed on that chain) still removes the
      // basis with the shares — otherwise the remaining basis would overstate
      // what the held position cost — but books no realized number rather than
      // inventing one.
      cost -= costRemoved
      shares -= covered
    }
    out[key] = { cost: cost.toString(), shares: shares.toString(), realized: realized.toString() }
  }
  return out
}

/** SwapFlow → StoredFlow (bigints out to strings for JSON). */
export function storeFlow(f: SwapFlow): StoredFlow {
  return {
    basket: f.basket,
    kind: f.kind,
    amountIn: f.amountIn.toString(),
    amountOut: f.amountOut.toString(),
    ...(f.blockNumber != null ? { blockNumber: f.blockNumber.toString() } : {}),
    ...(f.txHash != null ? { txHash: f.txHash } : {}),
    ...(f.proceedsUsd6 != null ? { proceedsUsd6: f.proceedsUsd6.toString() } : {}),
  }
}

/** StoredFlow → SwapFlow. Refuses a row whose numbers will not parse rather
 *  than letting a NaN reach money math (storage is a trust boundary). */
export function readFlow(r: StoredFlow): SwapFlow | null {
  try {
    return {
      basket: r.basket,
      kind: r.kind,
      amountIn: BigInt(r.amountIn),
      amountOut: BigInt(r.amountOut),
      ...(r.blockNumber != null ? { blockNumber: BigInt(r.blockNumber) } : {}),
      ...(r.txHash != null ? { txHash: r.txHash } : {}),
      ...(r.proceedsUsd6 != null ? { proceedsUsd6: BigInt(r.proceedsUsd6) } : {}),
    }
  } catch {
    return null
  }
}

// v2: the scan gained the legacy lineages' routers, so a v1 index is missing
// every superseded-basket trade — rebuild rather than top up onto a short fold.
// v3: ETH-out sells now BOOK realized when the chain has an ETH/USD feed
// (the owner 2026-08-02). Every v2 index folded them as unbooked, so they must all
// rebuild — a forward top-up would leave old sells silently missing.
// v4: the index now carries the raw flows so the trade-history export can
// replay them (2026-08-11). A v3 index has the fold but not the trades, and the
// top-up only scans FORWARD — so the history would start at whenever the user
// upgraded. One rebuild buys the whole past; it is the same single wide call a
// fresh browser already makes.
const CACHE_VER = 'v4'
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

async function scan(client: PublicClient, chainId: number, routers: Address[], wallet: Address, fromBlock: bigint, toBlock: bigint): Promise<SwapFlow[]> {
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
      flows.push({ basket, kind: 'buy', amountIn, amountOut, blockNumber: l.blockNumber, txHash: l.transactionHash })
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
      flows.push({ basket, kind, amountIn, amountOut, blockNumber: l.blockNumber, txHash: l.transactionHash })
    }
  }
  await priceEthOutSells(client, chainId, flows)
  return flows
}

/**
 * Value ETH-out proceeds AT THE BLOCK EACH SALE HAPPENED IN.
 *
 * The old behaviour booked nothing because pricing wei needs a price and this
 * module refuses to guess one. the owner's call on 2026-08-02 is that these are
 * realized PnL — so the answer is a HISTORICAL price, not spot-now applied
 * retroactively, which would be exactly the guess the module was avoiding.
 *
 * Cheap by construction: sells are the rare flow, the feed history is fetched
 * ONCE for the whole window, and the whole index is cached forever after.
 * If the chain has no ETH/USD feed the flows are left unpriced and the fold
 * keeps today's honest silence — a missing feed is not a verdict.
 */
async function priceEthOutSells(client: PublicClient, chainId: number, flows: SwapFlow[]): Promise<void> {
  const eth = flows.filter((f) => f.kind === 'sellEth' && f.blockNumber != null)
  if (!eth.length) return
  const feed = chainlinkFeedFor(chainId, chainCfg(chainId).weth ?? '')
  if (!feed) return // no feed on this chain — stays unbooked, exactly as before

  // Block → timestamp, one read per DISTINCT block (several sells can share one).
  const blocks = [...new Set(eth.map((f) => f.blockNumber as bigint))]
  const times = new Map<bigint, number>()
  await Promise.all(
    blocks.map(async (bn) => {
      try {
        const b = await client.getBlock({ blockNumber: bn })
        times.set(bn, Number(b.timestamp))
      } catch {
        /* unreadable block → this sale stays unpriced */
      }
    }),
  )
  const stamps = [...times.values()]
  if (!stamps.length) return

  let series: { time: number; value: number }[] = []
  try {
    series = await fetchChainlinkHistory(client, feed, Math.min(...stamps))
  } catch {
    return // history unavailable → unbooked, never guessed
  }
  if (!series.length) return

  // Nearest round AT OR BEFORE the sale; the feed only updates on deviation, so
  // the last print before the trade is the price that was live when it executed.
  const priceAt = (t: number): number | null => {
    let best: number | null = null
    for (const pt of series) {
      if (pt.time <= t) best = pt.value
      else break
    }
    return best ?? series[0]?.value ?? null
  }

  for (const f of eth) {
    const t = times.get(f.blockNumber as bigint)
    if (t == null) continue
    const usd = priceAt(t)
    if (usd == null || !Number.isFinite(usd) || usd <= 0) continue
    // wei → USD → settlement 6dp, in bigint the whole way so no float drift
    // reaches a money number: (wei * usd_1e8 * 1e6) / (1e18 * 1e8).
    const usd1e8 = BigInt(Math.round(usd * 1e8))
    f.proceedsUsd6 = (f.amountOut * usd1e8) / 10n ** 20n
  }
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
      const flows = await scan(client, chainId, routers, wallet, from, head)
      const next: PnlIndex = {
        upToBlock: head.toString(),
        positions: foldFlows(cached?.positions ?? {}, flows),
        // append, never replace: the scan is INCREMENTAL, so `flows` holds only
        // what is new since upToBlock
        flows: [...(cached?.flows ?? []), ...flows.map(storeFlow)],
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

/** Sum PnL indexes across a wallet GROUP: positions merge per basket by
 *  summing their raw fields (cost, shares, realized are additive by
 *  construction — average-cost folding is linear in them). `upToBlock` takes
 *  the OLDEST member: the merged picture is only as fresh as its stalest
 *  wallet, and claiming newer would misdescribe part of the money. */
export function mergePnlIndexes(list: (PnlIndex | null | undefined)[]): PnlIndex | null {
  const real = list.filter((x): x is PnlIndex => x != null)
  if (real.length === 0) return null
  if (real.length === 1) return real[0]
  const positions: Record<string, PnlPosition> = {}
  for (const idx of real) {
    for (const [k, p] of Object.entries(idx.positions)) {
      const prev = positions[k]
      positions[k] = prev
        ? {
            cost: (BigInt(prev.cost) + BigInt(p.cost)).toString(),
            shares: (BigInt(prev.shares) + BigInt(p.shares)).toString(),
            realized: (BigInt(prev.realized) + BigInt(p.realized)).toString(),
          }
        : p
    }
  }
  const upToBlock = real.reduce(
    (min, i) => (BigInt(i.upToBlock) < BigInt(min) ? i.upToBlock : min),
    real[0].upToBlock,
  )
  return { upToBlock, positions }
}

/** Every configured chain's index at once (the Portfolio summary) — same
 *  cache keys as usePnlIndex, so the per-holding rows ride the same data.
 *
 *  Takes one wallet or a linked-wallet GROUP: a group's indexes merge per
 *  chain (mergePnlIndexes), so the hero's invested/net line describes the
 *  same merged book the holdings show. Per-wallet cache keys are preserved —
 *  a member's index is shared with its solo view, never refetched. */
export function usePnlIndexes(wallet?: string | string[]): Record<number, PnlIndex | null> {
  const list = (Array.isArray(wallet) ? wallet : wallet ? [wallet] : [])
    .map((w) => w.toLowerCase())
    .filter((w, i, arr) => w && arr.indexOf(w) === i)
  return useQueries({
    queries: list.flatMap((w) =>
      SUPPORTED_CHAIN_IDS.map((chainId) => ({
        queryKey: ['spectrum', 'pnl', chainId, w],
        queryFn: () => loadPnlIndex(chainId, w as Address),
        enabled: pnlAvailable(chainId),
        staleTime: 60_000,
        refetchOnWindowFocus: false,
      })),
    ),
    combine: (results) =>
      Object.fromEntries(
        SUPPORTED_CHAIN_IDS.map((id, chainIdx) => [
          id,
          mergePnlIndexes(list.map((_, wIdx) => results[wIdx * SUPPORTED_CHAIN_IDS.length + chainIdx]?.data)),
        ]),
      ),
  })
}
