import { formatUnits, isAddress, type Address } from 'viem'
import { clientFor, hasAlchemyKey } from '../chain/rpc'
import { ZERO_ADDRESS } from '../chain/constants'
import { chainCfg, DEFAULT_CHAIN_ID, SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { basketAbi, erc20BalanceAbi, factoryAbi, launchedEvent } from './abis-v2'
import { cacheGet, cacheSet } from './persist-cache'
import { loadSnapshot, type SpectrumSnapshot } from './snapshot'

// ─────────────────────────────────────────────────────────────────────────────
// Spectrum V2 basket-token data layer — fully client-side, keyless-first.
//
// Discovery (keyless): PRIMARY = the factory enumeration views
// (allBaskets/allBasketsLength — append-only public array), which a
// plain public RPC serves completely. The Launched log scan is enrichment only
// (inception timestamps) and a bounded fallback if enumeration is unavailable.
// No seed lists, no platform allowlist of any kind: with no factory
// configured or no baskets launched, the list is honestly empty.
//
// NAV: PRIMARY = the static on-chain views exchangeRate()/
// totalReserve(), which are non-reverting and return (value, fullyPriced)
// display-grade marks in USDC terms. The DexScreener aggregate-spot
// reconstruction is computed alongside for holdings display and serves as
// (a) a cross-check — >2% divergence is flagged on `navDivergencePct` — and
// (b) the fallback when the static views are unavailable. There is no dstable
// price-factor machinery in V2 (settlement is canonical Base USDC).
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────────────

export interface Holding {
  asset: string
  symbol: string
  name: string
  decimals: number
  targetWeightPct: number
  balance: number
  priceUsd: number
  valueUsd: number
  liveWeightPct: number
  change24hPct: number | null
  priced: boolean
  series: NavPoint[]
}

export interface NavPoint {
  time: number
  value: number
}

export type NavSource = 'onchain' | 'reconstructed'

export interface BasketData {
  chainId: number
  address: string
  name: string
  symbol: string
  decimals: number
  totalSupply: number
  aumUsd: number
  navPerToken: number
  /** Where navPerToken came from: static on-chain views (primary) or the spot reconstruction (fallback). */
  navSource: NavSource
  /** True when the on-chain views reported every leg priced. */
  fullyPriced: boolean
  /** |on-chain NAV − reconstructed NAV| as a % of on-chain NAV, when both exist. >2% ⇒ surface a warning. */
  navDivergencePct: number | null
  change24hPct: number | null
  holdings: Holding[]
  navSeries: NavPoint[]
  pricedCount: number
  totalCount: number
  inceptionTs: number | null
  ageHours: number | null
  /** Creator (deployer) address from the factory registry; null if unknown. */
  deployer: string | null
  /** effectiveSupply() — the NAV denominator (excludes tokens pending burn). null if the view reverts. */
  effectiveSupply: number | null
  updatedAt: string
}

export interface BasketTopHolding {
  address: string
  symbol: string
  weightPct: number
}

export interface BasketSummary {
  chainId: number
  address: string
  name: string
  symbol: string
  basketLength: number
  navPerToken: number
  aumUsd: number
  change24hPct: number | null
  pricedCount: number
  top: BasketTopHolding[]
  navSeries: NavPoint[]
  /** Creator (deployer) address from the factory registry; null if unknown. */
  deployer: string | null
  /** Address of a verified signed successor that supersedes this version, else
   *  null (a head / single version). Discovery surfaces show heads only; the
   *  full list stays available for the version strip. */
  supersededBy?: string | null
  /** Number of holders. Requires holder indexing (Transfer events) — NOT available
   *  from on-chain enumeration, so this is undefined on the shipped chain path and
   *  populated only by the operator DB/indexer (or the dev fixture). Undefined →
   *  the UI shows no holder count. */
  holdersCount?: number | null
}

// ── DexScreener pricing (per-chain, no key) ──────────────────────────────────

interface DexPair {
  baseToken?: { address?: string; symbol?: string; name?: string }
  priceUsd?: string | null
  priceChange?: { h1?: number; h6?: number; h24?: number }
  liquidity?: { usd?: number }
}

// Short-TTL spot-price cache, keyed by chain-slug + token. A homepage of cards
// shares many constituents, so without this each refresh re-hits DexScreener
// once per card — wasteful and a 429 risk. TTL < the 60s query refetch.
const DEX_TTL_MS = 30_000
interface CachedDexPair {
  pair: DexPair | null
  ts: number
}
const dexCache = new Map<string, CachedDexPair>()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Parse a DexScreener USD price string to a finite positive number, else null.
// A malformed value parsed straight would flow into balance × price and silently
// turn the whole basket's AUM and NAV into NaN. Guard at the source.
function parsePriceUsd(s: string | undefined | null): number | null {
  if (s == null) return null
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

async function fetchDexPrices(
  addresses: string[],
  slug: string,
): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>()
  // '' = DexScreener doesn't index this chain (Robinhood) — skip the fetch
  // entirely; legs render honestly unpriced and the USDC/USDG leg keeps its $1.
  if (!slug || addresses.length === 0) return out
  const now = Date.now()
  const misses: string[] = []
  for (const a of addresses) {
    const cached = dexCache.get(`${slug}:${a}`)
    if (cached && now - cached.ts < DEX_TTL_MS) {
      if (cached.pair) out.set(a, cached.pair)
    } else {
      misses.push(a)
    }
  }
  if (misses.length === 0) return out

  // DexScreener accepts up to 30 contracts per call; a basket is <= ~12.
  const url = `https://api.dexscreener.com/tokens/v1/${slug}/${misses.join(',')}`
  let pairs: DexPair[] | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } })
      if (r.ok) {
        pairs = (await r.json()) as DexPair[]
        break
      }
      if (r.status !== 429 && r.status < 500) break
    } catch {
      /* network error — retry */
    }
    if (attempt < 2) await sleep(300 * (attempt + 1))
  }
  if (!pairs) return out

  // Deepest-liquidity pair per token among the fetched misses.
  const best = new Map<string, DexPair>()
  for (const p of pairs) {
    const a = p.baseToken?.address?.toLowerCase()
    if (!a) continue
    const prev = best.get(a)
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) best.set(a, p)
  }
  for (const a of misses) {
    const pair = best.get(a) ?? null
    dexCache.set(`${slug}:${a}`, { pair, ts: now })
    if (pair) out.set(a, pair)
  }
  return out
}

function priceAt(now: number, ch1: number, ch6: number, ch24: number, hoursAgo: number): number {
  const anchors: [number, number][] = [
    [24, 1 / (1 + (ch24 || 0) / 100)],
    [6, 1 / (1 + (ch6 || 0) / 100)],
    [1, 1 / (1 + (ch1 || 0) / 100)],
    [0, 1],
  ]
  if (hoursAgo >= 24) return now * anchors[0][1]
  for (let i = 0; i < anchors.length - 1; i++) {
    const [h0, f0] = anchors[i]
    const [h1, f1] = anchors[i + 1]
    if (hoursAgo <= h0 && hoursAgo >= h1) {
      const t = h0 === h1 ? 0 : (h0 - hoursAgo) / (h0 - h1)
      return now * (f0 + (f1 - f0) * t)
    }
  }
  return now
}

function timeSteps(maxHours: number): number[] {
  const n = 14
  const m = Math.min(Math.max(maxHours, 0.05), 24)
  return Array.from({ length: n + 1 }, (_, i) => +(m * (1 - i / n)).toFixed(4))
}

function buildAssetSeries(
  priceNow: number,
  ch1: number,
  ch6: number,
  ch24: number,
  maxHours: number,
): NavPoint[] {
  const nowSec = Math.floor(Date.now() / 1000)
  const steps = timeSteps(maxHours)
  const raw = steps.map((h) => priceAt(priceNow, ch1, ch6, ch24, h))
  const base = raw[0] || raw.find((v) => v > 0) || 1
  return steps.map((h, i) => ({
    time: nowSec - Math.round(h * 3600),
    value: base > 0 ? (raw[i] / base) * 100 : 100,
  }))
}

function buildNavSeries(
  items: { balance: number; priceUsd: number; ch1: number; ch6: number; ch24: number }[],
  supply: number,
  maxHours: number,
): NavPoint[] {
  if (supply <= 0) return []
  const nowSec = Math.floor(Date.now() / 1000)
  return timeSteps(maxHours).map((h) => {
    let aum = 0
    for (const it of items) aum += it.balance * priceAt(it.priceUsd, it.ch1, it.ch6, it.ch24, h)
    return { time: nowSec - Math.round(h * 3600), value: aum / supply }
  })
}

// ── Launch index (inception timestamps) ─────────────────────────────────────
// One factory-wide filtered getLogs (Launched, full range) yields EVERY
// basket's launch block in a single call — the same wide-filtered pattern the
// pool engine uses, and like there it needs an Alchemy-class endpoint
// (hasAlchemyKey). Replaces the old per-basket 9-window walk, which burned up
// to 9 getLogs per basket per session and was guaranteed to find nothing for
// baskets older than its 80k-block lookback. The index is persisted
// (localStorage) and topped up incrementally from the last scanned block, so
// a returning browser pays nothing and a new basket costs one bounded call.
interface LaunchIndex {
  /** Last block covered by the scan (stringified bigint — JSON-safe). */
  upToBlock: string
  /** lowercased basket address → launch unix ts. */
  entries: Record<string, number>
}
const launchIndexMem = new Map<number, LaunchIndex>()
const launchIndexInflight = new Map<number, Promise<LaunchIndex | null>>()
const launchIndexLastScanMs = new Map<number, number>()
const LAUNCH_INDEX_MIN_RESCAN_MS = 30_000

async function timestampsForBlocks(
  chainId: number,
  blockNumbers: bigint[],
): Promise<Map<bigint, number>> {
  const client = clientFor(chainId)
  const uniq = Array.from(new Set(blockNumbers))
  const out = new Map<bigint, number>()
  // Small chunks: getBlock can't multicall, so bound the burst.
  const CHUNK = 8
  for (let i = 0; i < uniq.length; i += CHUNK) {
    await Promise.all(
      uniq.slice(i, i + CHUNK).map(async (bn) => {
        try {
          const blk = await client.getBlock({ blockNumber: bn })
          if (blk) out.set(bn, Number(blk.timestamp))
        } catch {
          /* leave missing — the entry is simply not indexed this pass */
        }
      }),
    )
  }
  return out
}

// Build or top up the per-chain index. Serialized per chain (inflight map) and
// rate-limited so a burst of misses (e.g. a non-factory token page) can't spam
// rescans. Returns null when unavailable (no key / no factory / RPC failure).
async function loadLaunchIndex(chainId: number, forceTopUp = false): Promise<LaunchIndex | null> {
  if (!hasAlchemyKey()) return null // wide filtered getLogs — keyed endpoints only
  const factory = chainCfg(chainId).factory
  if (!factory) return null

  const inflight = launchIndexInflight.get(chainId)
  if (inflight) return inflight

  const run = (async (): Promise<LaunchIndex | null> => {
    let idx = launchIndexMem.get(chainId) ?? cacheGet<LaunchIndex>(`launch-index:v1:${chainId}`)
    if (idx && typeof idx.upToBlock !== 'string') idx = null // shape guard for stale/foreign blobs
    const last = launchIndexLastScanMs.get(chainId) ?? 0
    const needScan = !idx || (forceTopUp && Date.now() - last >= LAUNCH_INDEX_MIN_RESCAN_MS)
    if (idx && !needScan) {
      launchIndexMem.set(chainId, idx)
      return idx
    }
    try {
      const client = clientFor(chainId)
      const latest = await client.getBlockNumber()
      const fromBlock = idx ? BigInt(idx.upToBlock) + 1n : 0n
      if (idx && fromBlock > latest) return idx
      const logs = await client.getLogs({
        address: factory,
        event: launchedEvent,
        fromBlock,
        toBlock: latest,
      })
      const tsByBlock = await timestampsForBlocks(chainId, logs.map((l) => l.blockNumber))
      const entries: Record<string, number> = { ...(idx?.entries ?? {}) }
      for (const l of logs) {
        const basket = l.args.basket?.toLowerCase()
        const ts = tsByBlock.get(l.blockNumber)
        if (basket && ts != null) entries[basket] = ts
      }
      const next: LaunchIndex = { upToBlock: latest.toString(), entries }
      launchIndexMem.set(chainId, next)
      launchIndexLastScanMs.set(chainId, Date.now())
      cacheSet(`launch-index:v1:${chainId}`, next, 0)
      return next
    } catch {
      return idx ?? null
    }
  })()
  launchIndexInflight.set(chainId, run)
  try {
    return await run
  } finally {
    launchIndexInflight.delete(chainId)
  }
}

const inceptionCache = new Map<string, number>()
/** Seed inception from an external source (snapshot) so views skip the scan. */
export function seedInception(token: string, chainId: number, ts: number): void {
  inceptionCache.set(`${chainId}:${token.toLowerCase()}`, ts)
}
async function getInceptionTs(token: Address, chainId: number): Promise<number | null> {
  const key = `${chainId}:${token.toLowerCase()}`
  const cached = inceptionCache.get(key)
  if (cached != null) return cached

  // Keyed path: the shared launch index. A miss on a current index triggers at
  // most one rate-limited top-up; absence after that is authoritative (the
  // full range was scanned — there is no Launched event for this token).
  let idx = await loadLaunchIndex(chainId)
  if (idx) {
    let ts = idx.entries[key.split(':')[1]]
    if (ts == null) {
      idx = (await loadLaunchIndex(chainId, true)) ?? idx
      ts = idx.entries[key.split(':')[1]]
    }
    if (ts != null) inceptionCache.set(key, ts)
    return ts ?? null
  }

  // Keyless fallback: the original bounded recent-window walk (public RPCs
  // reject wide filtered ranges). Coverage is honest-but-partial: baskets
  // older than the lookback resolve to null.
  const factory = chainCfg(chainId).factory
  if (!factory) return null
  try {
    const client = clientFor(chainId)
    const latest = await client.getBlockNumber()
    const WINDOW = 9000n
    for (let end = latest; end > latest - 80000n && end > 0n; end -= WINDOW) {
      const start = end - WINDOW + 1n > 0n ? end - WINDOW + 1n : 0n
      try {
        const logs = await client.getLogs({
          address: factory,
          event: launchedEvent,
          args: { basket: token },
          fromBlock: start,
          toBlock: end,
        })
        if (logs.length > 0) {
          const blk = await client.getBlock({ blockNumber: logs[0].blockNumber })
          const ts = blk ? Number(blk.timestamp) : null
          if (ts != null) inceptionCache.set(key, ts)
          return ts
        }
      } catch {
        /* window failed — try the next one */
      }
    }
    return null
  } catch {
    return null
  }
}

// Creator attribution: the factory registry maps basket → deployer. One cheap
// static read, permanently cached (a deployer never changes) — and persisted,
// so a returning browser re-reads nothing. Only definite (non-null) deployers
// persist; a null (error / not a factory token) stays session-only so an RPC
// hiccup can't burn a permanent wrong answer into storage. Exported: this is
// the ONE deployer source — use-basket-fees and creator-metadata reuse it
// instead of re-issuing the same factory read.
const deployerCache = new Map<string, string | null>()
export async function getDeployer(token: Address, chainId: number): Promise<string | null> {
  const key = `${chainId}:${token.toLowerCase()}`
  const cached = deployerCache.get(key)
  if (cached !== undefined) return cached
  const persisted = cacheGet<string>(`deployer:v1:${key}`)
  if (persisted) {
    deployerCache.set(key, persisted)
    return persisted
  }
  const factory = chainCfg(chainId).factory
  if (!factory) return null
  try {
    const client = clientFor(chainId)
    const deployer = await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: 'tokens',
      args: [token],
    })
    const out = deployer && deployer !== ZERO_ADDRESS ? deployer : null
    deployerCache.set(key, out)
    if (out) cacheSet(`deployer:v1:${key}`, out, 0)
    return out
  } catch {
    deployerCache.set(key, null)
    return null
  }
}

function weightedChange(holdings: Holding[], aumUsd: number): number | null {
  if (aumUsd <= 0) return null
  let acc = 0
  let priced = 0
  for (const h of holdings) {
    if (h.change24hPct == null || !h.priced) continue
    acc += (h.valueUsd / aumUsd) * h.change24hPct
    priced += h.valueUsd
  }
  return priced > 0 ? acc : null
}

// ── Core reads ───────────────────────────────────────────────────────────────

// Per-basket immutable facts. Baskets are immutable by design — basket, weights,
// name/symbol/decimals, fee config, and deployer are fixed at deploy — so read
// them once and reuse. Persisted (localStorage): immutable-by-contract data
// never needs a second read per BROWSER, not just per session.
interface ImmutableMeta {
  name: string
  symbol: string
  decimals: number
  len: number
  assets: Address[]
  targetBps: number[]
  assetDecimals: number[]
  deployer: string | null
}
const immutableCache = new Map<string, ImmutableMeta>()

// Minimal shape check before trusting a persisted blob (quota-partial writes,
// old versions, foreign keys all degrade to a live re-read).
function isImmutableMeta(v: unknown): v is ImmutableMeta {
  if (!v || typeof v !== 'object') return false
  const m = v as ImmutableMeta
  return (
    typeof m.name === 'string' &&
    typeof m.symbol === 'string' &&
    Number.isFinite(m.decimals) &&
    Number.isFinite(m.len) &&
    Array.isArray(m.assets) &&
    m.assets.length === m.len &&
    m.assets.every((a) => isAddress(a, { strict: false })) &&
    Array.isArray(m.targetBps) &&
    m.targetBps.length === m.len &&
    Array.isArray(m.assetDecimals) &&
    m.assetDecimals.length === m.len
  )
}

function getCachedMeta(key: string): ImmutableMeta | undefined {
  const mem = immutableCache.get(key)
  if (mem) return mem
  const persisted = cacheGet<ImmutableMeta>(`imm:v1:${key}`)
  if (persisted && isImmutableMeta(persisted)) {
    immutableCache.set(key, persisted)
    return persisted
  }
  return undefined
}

/** Seed immutable meta from an external source (snapshot). Validated like any
 *  persisted blob; display-grade only — mutable state is always read live. */
export function seedImmutableMeta(address: string, chainId: number, meta: ImmutableMeta): void {
  if (!isImmutableMeta(meta)) return
  const key = `${chainId}:${address.toLowerCase()}`
  immutableCache.set(key, meta)
  cacheSet(`imm:v1:${key}`, meta, 0)
}

// `inception` defaults off: list views don't need the lifetime-clamped chart
// window, and skipping it avoids a per-basket getLogs scan storm on public RPC.
export async function getBasketData(
  address: Address,
  chainId: number = DEFAULT_CHAIN_ID,
  opts: { inception?: boolean; detail?: boolean } = {},
): Promise<BasketData> {
  // DEV-only mock fixture so reviewers see a populated UI while the shipped
  // chain config is empty. Never part of a production build.
  if (import.meta.env.DEV) {
    const { devBasketData } = await import('./dev-fixture')
    const mock = devBasketData(address, chainId)
    if (mock) return mock
  }

  const client = clientFor(chainId)
  const cfg = chainCfg(chainId)
  const key = `${chainId}:${address.toLowerCase()}`

  // Immutable facts — read once per browser (persisted), then reuse on every poll.
  let meta = getCachedMeta(key)
  if (!meta) {
    const [name, symbol, decimalsRaw, lenRaw, deployer] = await Promise.all([
      client.readContract({ address, abi: basketAbi, functionName: 'name' }),
      client.readContract({ address, abi: basketAbi, functionName: 'symbol' }),
      client.readContract({ address, abi: basketAbi, functionName: 'decimals' }),
      client.readContract({ address, abi: basketAbi, functionName: 'basketLength' }),
      getDeployer(address, chainId),
    ])
    const n = Number(lenRaw)
    const entries = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        client.readContract({ address, abi: basketAbi, functionName: 'basket', args: [BigInt(i)] }),
      ),
    )
    meta = {
      name: name as string,
      symbol: symbol as string,
      decimals: Number(decimalsRaw),
      len: n,
      assets: entries.map((e) => e[0]),
      targetBps: entries.map((e) => Number(e[5])),
      assetDecimals: entries.map((e) => Number(e[6])),
      deployer,
    }
    immutableCache.set(key, meta)
    cacheSet(`imm:v1:${key}`, meta, 0)
  }
  const { name, symbol, decimals, assets, targetBps, assetDecimals, deployer } = meta

  // Mutable — supply, held balances and the static NAV views move on every
  // mint/redeem, so always re-read. The V2 static views are non-reverting by
  // SPEC, but each read still fails safe to null (draft ABI, RPC hiccups).
  const [supplyRaw, effRaw, exchangeRate, totalReserve] = await Promise.all([
    client.readContract({ address, abi: basketAbi, functionName: 'totalSupply' }),
    client.readContract({ address, abi: basketAbi, functionName: 'effectiveSupply' }).catch(() => null),
    client.readContract({ address, abi: basketAbi, functionName: 'exchangeRate' }).catch(() => null),
    client.readContract({ address, abi: basketAbi, functionName: 'totalReserve' }).catch(() => null),
  ])
  const totalSupply = Number(formatUnits(supplyRaw, decimals))
  const effectiveSupply = effRaw != null ? Number(formatUnits(effRaw, decimals)) : null
  const navDenom = effectiveSupply && effectiveSupply > 0 ? effectiveSupply : totalSupply

  // Held amount per constituent: prefer idleHeld(asset) — the basket's tracked,
  // donation-immune reserve (the auto-getter of `mapping idleHeld` in
  // SpectrumBasket) — falling back to the basket's raw balanceOf only if that view
  // is unavailable (e.g. a not-yet-deployed/preview build). balanceOf is
  // donation-inflatable, so the fallback can overstate; idleHeld is the truth.
  const balances = await Promise.all(
    assets.map((a, i) =>
      client
        .readContract({ address, abi: basketAbi, functionName: 'idleHeld', args: [a] })
        .catch(() =>
          client.readContract({ address: a, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [address] }),
        )
        .then((b) => Number(formatUnits(b, assetDecimals[i])))
        .catch(() => 0),
    ),
  )

  const inceptionTs = opts.inception ? await getInceptionTs(address, chainId) : null
  const ageHours = inceptionTs != null ? (Date.now() / 1000 - inceptionTs) / 3600 : null
  const maxHours = ageHours != null ? Math.min(Math.max(ageHours, 0.05), 24) : 24

  const dex = await fetchDexPrices(assets.map((a) => a.toLowerCase()), cfg.dexscreenerSlug)
  const USDC = cfg.usdc?.toLowerCase()

  const holdings: Holding[] = assets.map((a, i) => {
    const low = a.toLowerCase()
    const p = dex.get(low)
    let priceUsd = parsePriceUsd(p?.priceUsd) ?? 0
    // Canonical USDC is the settlement asset — $1 when no pair is listed.
    if (USDC && low === USDC && !priceUsd) priceUsd = 1
    const balance = balances[i]
    const valueUsd = balance * priceUsd
    return {
      asset: a,
      symbol: p?.baseToken?.symbol ?? (USDC && low === USDC ? 'USDC' : '?'),
      name: p?.baseToken?.name ?? '',
      decimals: assetDecimals[i],
      targetWeightPct: targetBps[i] / 100,
      balance,
      priceUsd,
      valueUsd,
      liveWeightPct: 0,
      change24hPct: p?.priceChange?.h24 ?? null,
      priced: priceUsd > 0,
      series: buildAssetSeries(
        priceUsd,
        p?.priceChange?.h1 ?? 0,
        p?.priceChange?.h6 ?? 0,
        p?.priceChange?.h24 ?? 0,
        maxHours,
      ),
    }
  })

  const reconAum = holdings.reduce((s, h) => s + h.valueUsd, 0)
  for (const h of holdings) h.liveWeightPct = reconAum > 0 ? (h.valueUsd / reconAum) * 100 : 0
  const reconNav = navDenom > 0 ? reconAum / navDenom : 0

  // ── NAV source selection: on-chain static views primary; reconstruction
  // fallback + cross-check. USDC has 6 decimals; the rate is
  // 1e18-scaled USDC-per-token.
  let navPerToken = reconNav
  let aumUsd = reconAum
  let navSource: NavSource = 'reconstructed'
  let fullyPriced = false
  let navDivergencePct: number | null = null
  if (exchangeRate != null) {
    const [rate1e18, priced] = exchangeRate
    const onchainNav = Number(formatUnits(rate1e18, 18))
    if (onchainNav > 0) {
      navPerToken = onchainNav
      navSource = 'onchain'
      fullyPriced = priced
      if (reconNav > 0) navDivergencePct = (Math.abs(onchainNav - reconNav) / onchainNav) * 100
    }
  }
  if (totalReserve != null && navSource === 'onchain') {
    const [usdcValue] = totalReserve
    const onchainAum = Number(formatUnits(usdcValue, 6))
    if (onchainAum > 0) aumUsd = onchainAum
  }

  const navSeries = buildNavSeries(
    holdings.map((h, i) => {
      const p = dex.get(assets[i].toLowerCase())
      return {
        balance: h.balance,
        priceUsd: h.priceUsd,
        ch1: p?.priceChange?.h1 ?? 0,
        ch6: p?.priceChange?.h6 ?? 0,
        ch24: p?.priceChange?.h24 ?? 0,
      }
    }),
    navDenom,
    maxHours,
  )

  return {
    chainId,
    address,
    name,
    symbol,
    decimals,
    totalSupply,
    aumUsd,
    navPerToken,
    navSource,
    fullyPriced,
    navDivergencePct,
    change24hPct: weightedChange(holdings, reconAum),
    holdings,
    navSeries,
    pricedCount: holdings.filter((h) => h.priced).length,
    totalCount: holdings.length,
    inceptionTs,
    ageHours,
    deployer,
    effectiveSupply,
    updatedAt: new Date().toISOString(),
  }
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** Parse the operator hide-list (comma-separated addresses → lowercased set).
 *  Malformed entries are dropped (check-config flags them before a build). */
export function parseHiddenBaskets(raw: unknown): ReadonlySet<string> {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => isAddress(s, { strict: false })),
  )
}

// The protocol team's own pre-launch TEST baskets (owner 2026-07-10) — hidden
// from discovery on EVERY deployment by default. They are development artifacts
// on the canonical factories, not products; a fresh operator site should not
// open listing them. Same semantics as the env list below: discovery-only and
// this-frontend-only — direct Token links, holdings, fee claims and swaps all
// still work, and the on-chain enumeration stays permissionless.
export const DEFAULT_HIDDEN_BASKETS = [
  '0x2a8dd699d5759f58fed3abab69e216933c854088',
  '0x6920d5652023c6ea2503239212c9142e5196c088',
  '0x48fd8ab4670508361d2f5f0e936201b344024088',
]

// Operator list-curation (optional, ships empty): basket addresses THIS BUILD
// omits from its discovery listings — e.g. the operator's own pre-launch test
// baskets. ADDS to the defaults above. Discovery-only and this-frontend-only:
// the factory enumeration stays permissionless (any other frontend still lists
// them), and a hidden basket's direct Token link, holdings, fee claims and
// swaps all still work.
const HIDDEN_BASKETS: ReadonlySet<string> = new Set([
  ...DEFAULT_HIDDEN_BASKETS,
  ...parseHiddenBaskets(import.meta.env.VITE_HIDDEN_BASKETS),
])

// Enumerate every basket from the factory's append-only array (keyless-first).
// Falls back to a bounded Launched-log scan if enumeration is unavailable.
async function discoverBaskets(chainId: number): Promise<Address[]> {
  const cfg = chainCfg(chainId)
  if (!cfg.factory) return [] // shipped default: no deployment configured → honestly empty
  const client = clientFor(chainId)

  try {
    const len = Number(
      await client.readContract({ address: cfg.factory, abi: factoryAbi, functionName: 'allBasketsLength' }),
    )
    const addrs = await Promise.all(
      Array.from({ length: len }, (_, i) =>
        client.readContract({ address: cfg.factory!, abi: factoryAbi, functionName: 'allBaskets', args: [BigInt(i)] }),
      ),
    )
    return addrs
  } catch {
    /* enumeration unavailable — fall through to the bounded log scan */
  }

  try {
    const latest = await client.getBlockNumber()
    const from = latest > 60000n ? latest - 60000n : 0n
    const logs = await client.getLogs({
      address: cfg.factory,
      event: launchedEvent,
      fromBlock: from,
      toBlock: latest,
    })
    const out: Address[] = []
    for (const l of logs) if (l.args.basket) out.push(l.args.basket)
    return out
  } catch {
    return []
  }
}

// Tag each summary with its verified signed successor (versioning.ts), if any,
// so discovery surfaces (Explore/Home/Creator/Portfolio-created) can show only
// the latest version while the FULL list stays available for the version strip
// and lineage graph. With no metadata host configured nothing is tagged → no-op.
// Lazy import keeps the versioning↔basket-data module graph acyclic.
async function tagLineage(list: BasketSummary[]): Promise<BasketSummary[]> {
  if (list.length < 2) return list
  try {
    const { buildLineageGraph } = await import('./versioning')
    const graph = await buildLineageGraph(
      list.map((s) => ({ address: s.address, chainId: s.chainId, deployer: s.deployer })),
    )
    return list.map((s) => ({ ...s, supersededBy: graph.successorOf(s.address) }))
  } catch {
    return list
  }
}

// Build list summaries from a fresh operator snapshot (see snapshot.ts) —
// zero RPC on the visitor side. Returns null when the snapshot doesn't cover
// this chain (caller falls back to live discovery). Reuses the same series /
// change math as the live path so cards render identically either way, and
// seeds the immutable/deployer/inception caches so a subsequent detail view
// (always live for mutable state) skips every immutable read.
function summariesFromSnapshot(chainId: number, snap: SpectrumSnapshot): BasketSummary[] | null {
  const chain = snap.chains[String(chainId)]
  if (!chain || !Array.isArray(chain.baskets)) return null
  const out: BasketSummary[] = []
  for (const b of chain.baskets) {
    if (!isAddress(b.address, { strict: false })) continue
    const addr = b.address.toLowerCase()
    if (HIDDEN_BASKETS.has(addr)) continue
    const legs = Array.isArray(b.legs) ? b.legs : []
    const navDenom = b.effectiveSupply && b.effectiveSupply > 0 ? b.effectiveSupply : b.totalSupply
    const ageHours = b.inceptionTs != null ? (Date.now() / 1000 - b.inceptionTs) / 3600 : null
    const maxHours = ageHours != null ? Math.min(Math.max(ageHours, 0.05), 24) : 24
    const items = legs.map((l) => ({
      balance: l.balance,
      priceUsd: l.priceUsd,
      ch1: l.ch1 ?? 0,
      ch6: l.ch6 ?? 0,
      ch24: l.ch24 ?? 0,
    }))
    const aumRecon = items.reduce((s, it) => s + it.balance * it.priceUsd, 0)
    let ch24acc = 0
    let pricedValue = 0
    for (const l of legs) {
      const value = l.balance * l.priceUsd
      if (l.priceUsd > 0 && aumRecon > 0) {
        ch24acc += (value / aumRecon) * (l.ch24 ?? 0)
        pricedValue += value
      }
    }
    seedImmutableMeta(b.address, chainId, {
      name: b.name,
      symbol: b.symbol,
      decimals: b.decimals,
      len: legs.length,
      assets: legs.map((l) => l.asset as Address),
      targetBps: legs.map((l) => l.targetBps),
      assetDecimals: legs.map((l) => l.decimals),
      deployer: b.deployer,
    })
    if (b.deployer) deployerCache.set(`${chainId}:${addr}`, b.deployer)
    if (b.inceptionTs != null) seedInception(b.address, chainId, b.inceptionTs)
    out.push({
      chainId,
      address: b.address,
      name: b.name,
      symbol: b.symbol,
      basketLength: legs.length,
      navPerToken: b.navPerToken,
      aumUsd: b.aumUsd,
      change24hPct: pricedValue > 0 ? ch24acc : null,
      pricedCount: legs.filter((l) => l.priceUsd > 0).length,
      top: [...legs]
        .sort((a, z) => z.targetBps - a.targetBps)
        .map((l) => ({ address: l.asset, symbol: l.symbol, weightPct: l.targetBps / 100 })),
      navSeries: buildNavSeries(items, navDenom, maxHours),
      deployer: b.deployer,
    })
  }
  return out.sort((a, b) => b.aumUsd - a.aumUsd)
}

export async function listBasketsForChain(chainId: number): Promise<BasketSummary[]> {
  // DEV-only mock fixture (see getBasketData).
  if (import.meta.env.DEV) {
    const { devBasketSummaries } = await import('./dev-fixture')
    const mock = devBasketSummaries(chainId)
    if (mock) return tagLineage(mock)
  }

  // Snapshot-first (optional; ships OFF): a fresh operator snapshot serves the
  // whole list with zero visitor RPC. Stale/absent → live discovery below.
  const snap = await loadSnapshot()
  if (snap) {
    const fromSnap = summariesFromSnapshot(chainId, snap)
    if (fromSnap) return tagLineage(fromSnap)
  }

  const discovered = await discoverBaskets(chainId)
  const addresses = Array.from(new Set(discovered.map((a) => a.toLowerCase()))).filter(
    (a) => !HIDDEN_BASKETS.has(a),
  )

  const list = await Promise.all(
    addresses.filter((addr) => isAddress(addr, { strict: false })).map(async (addr): Promise<BasketSummary | null> => {
      try {
        const d = await getBasketData(addr as Address, chainId)
        // All constituents, by launch-target weight (so cards show the whole
        // basket and the bento %/sizes match the detail page).
        const top = [...d.holdings]
          .sort((a, b) => b.targetWeightPct - a.targetWeightPct)
          .map((h) => ({ address: h.asset, symbol: h.symbol, weightPct: h.targetWeightPct }))
        return {
          chainId,
          address: d.address,
          name: d.name,
          symbol: d.symbol,
          basketLength: d.totalCount,
          navPerToken: d.navPerToken,
          aumUsd: d.aumUsd,
          change24hPct: d.change24hPct,
          pricedCount: d.pricedCount,
          top,
          navSeries: d.navSeries,
          deployer: d.deployer,
        }
      } catch {
        return null
      }
    }),
  )

  const sorted = list
    .filter((x): x is BasketSummary => x !== null)
    .sort((a, b) => b.aumUsd - a.aumUsd)
  return tagLineage(sorted)
}

// Every basket across all configured chains, sorted by AUM (objective metric).
// Each chain fails independently.
export async function listAllBaskets(): Promise<BasketSummary[]> {
  const perChain = await Promise.all(
    SUPPORTED_CHAIN_IDS.map((id) => listBasketsForChain(id).catch(() => [] as BasketSummary[])),
  )
  return perChain.flat().sort((a, b) => b.aumUsd - a.aumUsd)
}

// Back-compat: default-chain-only list.
export async function listBaskets(): Promise<BasketSummary[]> {
  return listBasketsForChain(DEFAULT_CHAIN_ID)
}

// Per-wallet basket balances (powers the portfolio). Reads balanceOf + decimals
// per basket, grouped by chain so each chain's reads batch into one Multicall3
// call. Returns token-unit balances keyed by lowercased address; failures → 0.
export async function getUserHoldings(
  account: Address,
  baskets: { address: string; chainId: number }[],
): Promise<Map<string, number>> {
  // DEV-only mock holdings so the Portfolio renders populated while the shipped
  // chain config is empty (mirrors getBasketData / listBaskets). Never in prod.
  if (import.meta.env.DEV) {
    const { devUserHoldings } = await import('./dev-fixture')
    const mock = devUserHoldings(baskets)
    if (mock) return mock
  }

  const out = new Map<string, number>()
  const byChain = new Map<number, string[]>()
  for (const b of baskets) {
    const arr = byChain.get(b.chainId) ?? []
    arr.push(b.address)
    byChain.set(b.chainId, arr)
  }
  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainId, addrs]) => {
      const client = clientFor(chainId)
      await Promise.all(
        addrs.map(async (addr) => {
          const token = addr as Address
          try {
            const [bal, dec] = await Promise.all([
              client.readContract({ address: token, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [account] }),
              client.readContract({ address: token, abi: basketAbi, functionName: 'decimals' }),
            ])
            out.set(addr.toLowerCase(), Number(formatUnits(bal, Number(dec))))
          } catch {
            out.set(addr.toLowerCase(), 0)
          }
        }),
      )
    }),
  )
  return out
}
