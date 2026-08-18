import {
  encodePacked,
  formatUnits,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
} from 'viem'
import { clientFor, hasPrivateRpc, publicWideLogsRisky } from '../chain/rpc'
import { chainCfg, isPoolReady, isV2Ready, isV3Ready, type ChainCfg, type PoolReadyChainCfg, type V2ReadyChainCfg, type V3ReadyChainCfg } from '../chain/chains'
import { nativeEthUsdOnChain, v4PoolId } from './v4-usd'
import { cacheGet, cacheSet } from '../spectrum/persist-cache'
import { V4_POOLS_SLOT } from '../chain/constants'
import {
  aerodromeFactoryAbi,
  erc20MetaAbi,
  poolManagerExtsloadAbi,
  v2FactoryAbi,
  v2PairAbi,
  v3FactoryAbi,
  v4InitializeEvent,
} from './abis'
import {
  DYNAMIC_FEE_FLAG,
  NATIVE_ETH,
  PoolDetectionError,
  V4_PROBE_TIERS,
  VENUE_LABEL,
  Venue,
  ZERO_POOL_KEY,
  type BasketRoute,
  type BestPoolResult,
  type PoolCandidate,
  type PoolKey,
} from './types'
import { probeTransferFee, screenTokenIdentity } from './token-screen'
import { V2_REJECTED_MESSAGE as V2_ONLY_SENTENCE, V2_REJECTION_CLAUSE, chainRejectsV2 } from './v2-legs'

type Client = ReturnType<typeof clientFor>

// Standard Uniswap V3 fee tiers (pip fee → tick spacing).
const V3_FEE_TIERS: { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
]

const SHALLOW_USD_THRESHOLD = 10_000

/** The V2 law lives in ONE module (v2-legs.ts) so no surface can render a
 *  softer variant — the detector is only its first enforcement point.
 *  Re-exported here because this is where importers already look for it. */
export { V2_REJECTED_MESSAGE, V2_REJECTION_CLAUSE } from './v2-legs'

/** The venue's own ordering: every Uniswap pool sorts its sides by numeric
 *  address, so a pool found by asking a factory for (a, b) has a KNOWN pair
 *  without reading it back. That is what keeps `token0`/`token1` free on the
 *  candidate rather than an extra multicall per pool.
 *
 *  Compared lowercased because address CASE is EIP-55 checksum information, not
 *  value — comparing mixed-case hex would sort two spellings of one address
 *  differently and silently swap the sides. */
export function sortedPair(a: Address, b: Address): { token0: Address; token1: Address } {
  return a.toLowerCase() < b.toLowerCase() ? { token0: a, token1: b } : { token0: b, token1: a }
}

// Upper bound on pairs read from any one DexScreener response (mirrors
// token-search.ts MAX_PAIRS_PER_RESPONSE): a glitchy/hostile payload degrades
// to truncated data, never a hung add-flow.
const MAX_DEX_PAIRS = 500

// One retry, short backoff: a single RPC hiccup must never silently DELETE a
// venue — swallowing one once hid MOG's $4.6M V2 pair, so detection "found"
// an $11k V3 pool and confidently warned it was shallow (2026-07-07 1211).
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    await new Promise((r) => setTimeout(r, 150))
    return fn()
  }
}

// ── V2 ───────────────────────────────────────────────────────────────────────
// `candidate: null` + `checkFailed: false` = there genuinely is no V2 pair;
// `checkFailed: true` = we could not KNOW — the caller must not rank without it.
async function findV2(
  client: Client,
  cfg: V2ReadyChainCfg,
  asset: Address,
): Promise<{ candidate: PoolCandidate | null; checkFailed: boolean }> {
  let pair: Address
  try {
    pair = await withRetry(() =>
      client.readContract({ address: cfg.uniV2Factory, abi: v2FactoryAbi, functionName: 'getPair', args: [asset, cfg.weth] }),
    )
  } catch {
    return { candidate: null, checkFailed: true }
  }
  if (!pair || pair.toLowerCase() === zeroAddress) return { candidate: null, checkFailed: false }
  try {
    const [reserves, token0] = await withRetry(() =>
      Promise.all([
        client.readContract({ address: pair, abi: v2PairAbi, functionName: 'getReserves' }),
        client.readContract({ address: pair, abi: v2PairAbi, functionName: 'token0' }),
      ]),
    )
    const wethReserve = token0.toLowerCase() === cfg.weth.toLowerCase() ? reserves[0] : reserves[1]
    const depthEth = Number(formatUnits(wethReserve, 18))
    if (depthEth <= 0) return { candidate: null, checkFailed: false }
    return {
      candidate: {
        venue: Venue.V2,
        label: VENUE_LABEL[Venue.V2],
        fee: 3000,
        tickSpacing: 0,
        poolAddress: pair,
        poolId: null,
        ethPoolKey: null,
        // the AUTHORITATIVE pair: token0 is read from the pool itself above (to
        // pick the right reserve), so this side does not rely on the sort
        // convention at all — the other side is whichever of the two we asked
        // the factory for is left
        token0,
        token1: token0.toLowerCase() === cfg.weth.toLowerCase() ? asset : cfg.weth,
        depthEth,
        depthUsd: null,
      },
      checkFailed: false,
    }
  } catch {
    // The pair EXISTS but its reserves were unreadable — that is a failed check,
    // not an empty venue.
    return { candidate: null, checkFailed: true }
  }
}

// ── V3 (sweep all standard fee tiers) ─────────────────────────────────────────
async function findV3(
  client: Client,
  cfg: V3ReadyChainCfg,
  asset: Address,
): Promise<{ candidates: PoolCandidate[]; checkFailed: boolean }> {
  let checkFailed = false
  const results = await Promise.all(
    V3_FEE_TIERS.map(async (tier): Promise<PoolCandidate | null> => {
      let pool: Address
      try {
        pool = await withRetry(() =>
          client.readContract({ address: cfg.uniV3Factory, abi: v3FactoryAbi, functionName: 'getPool', args: [asset, cfg.weth, tier.fee] }),
        )
      } catch {
        checkFailed = true
        return null
      }
      if (!pool || pool.toLowerCase() === zeroAddress) return null
      // Depth = the WETH the pool actually holds (real reserves, not a heuristic).
      let wethBal: bigint
      try {
        wethBal = await withRetry(() =>
          client.readContract({ address: cfg.weth, abi: erc20MetaAbi, functionName: 'balanceOf', args: [pool] }),
        )
      } catch {
        checkFailed = true
        return null
      }
      const depthEth = Number(formatUnits(wethBal, 18))
      if (depthEth <= 0) return null
      return {
        venue: Venue.V3,
        label: VENUE_LABEL[Venue.V3],
        fee: tier.fee,
        tickSpacing: tier.tickSpacing,
        poolAddress: pool,
        poolId: null,
        ethPoolKey: null,
        // the factory was asked for exactly (asset, weth) at this tier, so the
        // pool's sides are those two in the venue's sort order
        ...sortedPair(asset, cfg.weth),
        depthEth,
        depthUsd: null,
      }
    }),
  )
  return { candidates: results.filter((c): c is PoolCandidate => c !== null), checkFailed }
}

// ── V4 (discover via Initialize logs; depth via PoolManager storage) ──────────
interface V4Init {
  id: `0x${string}`
  fee: number
  tickSpacing: number
  hooks: Address
}

function toRecs(
  logs: { args: { id?: `0x${string}`; fee?: number; tickSpacing?: number; hooks?: `0x${string}` } }[],
): V4Init[] {
  return logs
    .filter((l) => l.args.id)
    .map((l) => ({
      id: l.args.id as `0x${string}`,
      fee: l.args.fee ?? 0,
      tickSpacing: l.args.tickSpacing ?? 0,
      hooks: (l.args.hooks ?? zeroAddress) as Address,
    }))
}

// Persisted scan state per (chain, asset): Initialize is append-only (one event
// per pool id, ever), so a repeat lookup only scans NEW blocks since the last
// pass instead of re-walking the full range — the repeat cost of the launch
// page's most expensive read drops to one bounded call.
interface V4ScanCache {
  /** Last block covered (stringified bigint — JSON-safe). */
  upToBlock: string
  inits: V4Init[]
}

function isV4ScanCache(v: unknown): v is V4ScanCache {
  if (!v || typeof v !== 'object') return false
  const c = v as V4ScanCache
  return typeof c.upToBlock === 'string' && Array.isArray(c.inits) && c.inits.every((i) => typeof i?.id === 'string')
}

function mergeInits(prev: V4Init[], next: V4Init[]): V4Init[] {
  const seen = new Set(prev.map((i) => i.id))
  return [...prev, ...next.filter((i) => !seen.has(i.id))]
}

// Why the full scan didn't fully run: 'skipped' = never attempted (no private RPC
// on an Alchemy-tier chain) · 'rpc-error' = attempted and the provider refused
// (log-range caps — QuickNode et al limit getLogs spans — or a rate-limit burst).
// The distinction drives the WARNING TEXT: before it existed, a failed scan on a
// QuickNode-configured site printed "no private RPC" — flatly wrong (the
// spectrumbaskets.xyz report, 2026-07-12). false = complete.
export type V4ScanGap = false | 'skipped' | 'rpc-error'

// V4-family pools have no factory getPool — discovery is by Initialize logs over
// the full range, filtered on the pool's currency PAIR: native-ETH-paired for V4
// legs ({0x0, asset}) and settlement-paired for V4Q legs ({USDG, asset} sorted).
// Alchemy serves one filtered FULL-RANGE call; most other providers cap getLogs
// spans and public RPCs choke — those paths degrade to the callers' direct
// standard-tier probes (real coverage, minus exotic tick spacings).
async function scanV4Initialize(
  client: Client,
  chainId: number,
  poolManager: Address,
  pair: { currency0: Address; currency1: Address },
  cacheKey: string,
): Promise<{ inits: V4Init[]; partial: V4ScanGap }> {
  // Only private-class endpoints serve a wide filtered getLogs quickly; public RPCs
  // on Base/Ethereum rate-limit/time out, so keyless there skips the scan (the
  // probe fallback still runs). Robinhood is different: its OWN public endpoint
  // serves the filtered full-range call fast (young chain) — keyless RH keeps
  // attempting it (publicWideLogsRisky excludes 4663 even though Alchemy now
  // serves the chain); the catch below still degrades on error.
  if (!hasPrivateRpc(chainId) && publicWideLogsRisky(chainId)) return { inits: [], partial: 'skipped' }
  const cachedRaw = cacheGet<V4ScanCache>(cacheKey)
  const cached = cachedRaw && isV4ScanCache(cachedRaw) ? cachedRaw : null
  // One quiet retry before declaring partial coverage: the launch flow bursts
  // many concurrent RPC calls, and a single transient 429 used to pin the
  // "coverage is partial" warning onto the asset until it was re-added by hand
  // — while the identical query succeeded a second later (owner hit this live
  // on 4663, 2026-07-29; the pair-filtered full-range query itself is fine
  // there). A short backoff lets the limiter window pass.
  for (let attempt = 0; ; attempt++) {
    try {
      const latest = await client.getBlockNumber()
      const fromBlock = cached ? BigInt(cached.upToBlock) + 1n : 0n
      if (cached && fromBlock > latest) return { inits: cached.inits, partial: false }
      const logs = await client.getLogs({
        address: poolManager,
        event: v4InitializeEvent,
        args: { currency0: pair.currency0, currency1: pair.currency1 },
        fromBlock,
        toBlock: latest,
      })
      const inits = mergeInits(cached?.inits ?? [], toRecs(logs))
      cacheSet(cacheKey, { upToBlock: latest.toString(), inits } satisfies V4ScanCache, 0)
      return { inits, partial: false }
    } catch {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 800))
        continue
      }
      // A cached prior full scan is still complete UP TO its block — usable, but
      // flagged so the caller's coverage warning shows.
      return cached ? { inits: cached.inits, partial: 'rpc-error' } : { inits: [], partial: 'rpc-error' }
    }
  }
}

// The canonical V4 fee/tick-spacing tiers. When the log scan can't run (or fails),
// pools at these tiers are still discoverable DIRECTLY: the pool id is a pure hash
// of the PoolKey, and depth reads by id (extsload) are cheap single calls every
// endpoint serves — including public ones. Real coverage for the overwhelmingly
// common case; only exotic custom tick spacings stay invisible without a scan.
const V4_STANDARD_TIERS = V4_PROBE_TIERS

function probeStandardV4(asset: Address): V4Init[] {
  return V4_STANDARD_TIERS.map(({ fee, tickSpacing }) => ({
    id: v4PoolId({ currency0: NATIVE_ETH, currency1: asset, fee, tickSpacing, hooks: zeroAddress }),
    fee,
    tickSpacing,
    hooks: zeroAddress,
  }))
}

// Virtual ETH-side reserve from PoolManager storage: amount0 ≈ L · 2^96 / sqrtPriceX96.
// Returns -1 on a READ FAILURE (post-retry) — the sweep's catch: a bare `return 0`
// made an RPC blip indistinguishable from an empty pool, silently dropping a
// possibly-deepest V4 candidate (the MOG-class mis-route, V4 edition).
async function v4DepthEth(client: Client, poolManager: Address, id: `0x${string}`): Promise<number> {
  try {
    const base = keccak256(encodePacked(['bytes32', 'uint256'], [id, V4_POOLS_SLOT]))
    const liquiditySlot = toHex(BigInt(base) + 3n, { size: 32 }) // StateLibrary: liquidity at base+3
    const [slot0Word, liqWord] = await withRetry(() =>
      Promise.all([
        client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [base] }),
        client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [liquiditySlot] }),
      ]),
    )
    const sqrtP = BigInt(slot0Word) & ((1n << 160n) - 1n)
    const liquidity = BigInt(liqWord) & ((1n << 128n) - 1n)
    if (sqrtP === 0n || liquidity === 0n) return 0
    const ethWei = (liquidity << 96n) / sqrtP
    return Number(formatUnits(ethWei, 18))
  } catch {
    return -1
  }
}

/** The key fields a hooked Initialize event carries (fee · tickSpacing ·
 *  hooks); the pair is supplied by the caller because the scan fixed it. */
export interface HookedInitLike {
  fee: number
  tickSpacing: number
  hooks: Address
}

/** Pick the deepest HOOKED pool and return its FULL v4 pool key + depth —
 *  hooked pools can't be basket routes, but the direct-swap lane can trade
 *  them through the UniversalRouter (encodeUrV4SwapExactInSingle's hookData
 *  lane), so the detector now keeps the key it used to throw away.
 *
 *  `depths[i]` belongs to `hooked[i]`; iteration is over the DEPTHS list, so
 *  the caller's read cap (first 6 hooked ids, unchanged) is the boundary —
 *  an unread init can never be selected. -1 (the read-failure sentinel) and
 *  0-depth entries never win; null when nothing read > 0. */
export function deepestHookedPool(
  hooked: readonly HookedInitLike[],
  depths: readonly number[],
  pair: { currency0: Address; currency1: Address },
): (PoolKey & { depthEth: number }) | null {
  let best: (PoolKey & { depthEth: number }) | null = null
  for (let i = 0; i < depths.length; i++) {
    const init = hooked[i]
    const depthEth = depths[i]
    if (!init || !(depthEth > 0)) continue
    if (!best || depthEth > best.depthEth) {
      best = {
        currency0: pair.currency0,
        currency1: pair.currency1,
        fee: init.fee,
        tickSpacing: init.tickSpacing,
        hooks: init.hooks,
        depthEth,
      }
    }
  }
  return best
}

async function findV4(
  client: Client,
  cfg: Pick<ChainCfg, 'chainId'> & { poolManager: Address },
  asset: Address,
): Promise<{
  candidates: PoolCandidate[]
  partial: V4ScanGap
  depthCheckFailed?: boolean
  hookedDepthEth?: number
  hookedDeepest?: (PoolKey & { depthEth: number }) | null
}> {
  const scan = await scanV4Initialize(
    client,
    cfg.chainId,
    cfg.poolManager,
    { currency0: NATIVE_ETH, currency1: asset },
    `v4scan:v1:${cfg.chainId}:${asset.toLowerCase()}`,
  )
  // Scan incomplete (skipped or refused)? Probe the standard tiers directly —
  // depth reads by computed pool id work on ANY endpoint, so builds without a
  // full-scan-capable RPC still see the standard-tier V4 pools instead of none.
  // Nonexistent probed pools read zero depth and drop out below.
  const inits = scan.partial === false ? scan.inits : [...scan.inits, ...probeStandardV4(asset)]
  const partial = scan.partial
  const seen = new Set<string>()
  // Concurrent depth reads: many-pool memecoins meant dozens of sequential
  // round-trips against rate-limited public RPCs (a visible stall); the batching
  // client coalesces them into Multicall3 instead of N sequential round-trips.
  const hooked: V4Init[] = []
  const eligible = inits.filter((init) => {
    if (seen.has(init.id)) return false
    seen.add(init.id)
    if (init.hooks.toLowerCase() !== zeroAddress) {
      hooked.push(init) // rejected as a ROUTE — but its depth (and now its KEY) still tells the venue story
      return false
    }
    if (init.fee === DYNAMIC_FEE_FLAG) return false // reject dynamic-fee pools
    return true
  })
  const [depths, hookedDepths] = await Promise.all([
    Promise.all(eligible.map((i) => v4DepthEth(client, cfg.poolManager, i.id))),
    Promise.all(hooked.slice(0, 6).map((i) => v4DepthEth(client, cfg.poolManager, i.id))),
  ])
  const depthCheckFailed = depths.some((d) => d === -1)
  // The scan's pair filter fixed {currency0, currency1} = {native, asset}
  // (native ETH is address(0), always the numerically-lower side), so every
  // hooked init's key is pair + its own fee/tickSpacing/hooks. hookedDepthEth
  // derives from the same selection (max positive read depth, 0 when none) —
  // one source of truth, byte-identical to the old reduce.
  const hookedDeepest = deepestHookedPool(hooked, hookedDepths, { currency0: NATIVE_ETH, currency1: asset })
  const hookedDepthEth = hookedDeepest?.depthEth ?? 0
  const out: PoolCandidate[] = []
  eligible.forEach((init, idx) => {
    const depthEth = depths[idx]
    if (depthEth <= 0) return
    out.push({
      venue: Venue.V4,
      label: VENUE_LABEL[Venue.V4],
      fee: init.fee,
      tickSpacing: init.tickSpacing,
      poolAddress: null,
      poolId: init.id,
      ethPoolKey: {
        currency0: NATIVE_ETH,
        currency1: asset,
        fee: init.fee,
        tickSpacing: init.tickSpacing,
        hooks: zeroAddress,
      },
      // straight off the key this pool IS — no derivation, no read
      token0: NATIVE_ETH,
      token1: asset,
      depthEth,
      depthUsd: null,
    })
  })
  return { candidates: out, partial, depthCheckFailed, hookedDepthEth, hookedDeepest }
}

// ── V4Q (settlement-quoted hookless V4 — the stocks-fork lineage) ─────────────
// Emitted ONLY where the chain config declares `v4qLineage` (the fork factory's
// Venue enum adds V4Q=3; deployed V2-lineage factories reject venue 3 in the
// token constructor, so this sweep must stay dark there). Discovery mirrors
// findV4 with the SETTLEMENT asset in place of native ETH — pair sorted by
// address like any V4 PoolKey. Depth is read settlement-side: the settlement
// token is 6dp and $1 by construction, so the in-range settlement amount IS
// the USD figure — no ETH anchor, no indexer, cross-venue comparable as-is.

/** Settlement-side in-range depth in dollars. -1 = read failure (post-retry),
 *  the sweep sentinel — same doctrine as v4DepthEth. */
async function v4qDepthUsd(
  client: Client,
  poolManager: Address,
  id: `0x${string}`,
  settlementIsCurrency0: boolean,
): Promise<number> {
  try {
    const base = keccak256(encodePacked(['bytes32', 'uint256'], [id, V4_POOLS_SLOT]))
    const liquiditySlot = toHex(BigInt(base) + 3n, { size: 32 })
    const [slot0Word, liqWord] = await withRetry(() =>
      Promise.all([
        client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [base] }),
        client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [liquiditySlot] }),
      ]),
    )
    const sqrtP = BigInt(slot0Word) & ((1n << 160n) - 1n)
    const liquidity = BigInt(liqWord) & ((1n << 128n) - 1n)
    if (sqrtP === 0n || liquidity === 0n) return 0
    // amount0 = L·2^96/√P (currency0 side) · amount1 = L·√P/2^96 (currency1 side)
    const raw = settlementIsCurrency0 ? (liquidity << 96n) / sqrtP : (liquidity * sqrtP) >> 96n
    return Number(formatUnits(raw, 6))
  } catch {
    return -1
  }
}

// Exported for the live ground-truth probe scripts (scripts/rh-*.ts), which
// force the sweep against mainnet before any V4Q factory is configured.
export async function findV4Q(
  client: Client,
  cfg: Pick<ChainCfg, 'chainId'> & { poolManager: Address; usdc: Address },
  asset: Address,
): Promise<{ candidates: PoolCandidate[]; partial: V4ScanGap; depthCheckFailed?: boolean }> {
  const settlementIsC0 = BigInt(cfg.usdc) < BigInt(asset)
  const pair = settlementIsC0
    ? { currency0: cfg.usdc, currency1: asset }
    : { currency0: asset, currency1: cfg.usdc }
  const scan = await scanV4Initialize(
    client,
    cfg.chainId,
    cfg.poolManager,
    pair,
    `v4qscan:v1:${cfg.chainId}:${asset.toLowerCase()}`,
  )
  // Same degradation as findV4: scan incomplete → probe the known hookless tiers
  // directly (pool id is a pure hash; nonexistent pools read zero and drop out).
  const probed: V4Init[] = V4_PROBE_TIERS.map(({ fee, tickSpacing }) => ({
    id: v4PoolId({ ...pair, fee, tickSpacing, hooks: zeroAddress }),
    fee,
    tickSpacing,
    hooks: zeroAddress,
  }))
  const inits = scan.partial === false ? scan.inits : [...scan.inits, ...probed]
  const seen = new Set<string>()
  const eligible = inits.filter((init) => {
    if (seen.has(init.id)) return false
    seen.add(init.id)
    if (init.hooks.toLowerCase() !== zeroAddress) return false
    if (init.fee === DYNAMIC_FEE_FLAG) return false
    return true
  })
  const depths = await Promise.all(eligible.map((i) => v4qDepthUsd(client, cfg.poolManager, i.id, settlementIsC0)))
  const depthCheckFailed = depths.some((d) => d === -1)
  const out: PoolCandidate[] = []
  eligible.forEach((init, idx) => {
    const usd = depths[idx]
    if (usd <= 0) return
    out.push({
      venue: Venue.V4Q,
      label: VENUE_LABEL[Venue.V4Q],
      fee: init.fee,
      tickSpacing: init.tickSpacing,
      poolAddress: null,
      poolId: init.id,
      ethPoolKey: { ...pair, fee: init.fee, tickSpacing: init.tickSpacing, hooks: zeroAddress },
      // the quote-paired key already holds both sides in venue order
      token0: pair.currency0,
      token1: pair.currency1,
      depthEth: 0, // not ETH-comparable by construction; ranking rides depthUsd
      depthUsd: usd,
    })
  })
  return { candidates: out, partial: scan.partial, depthCheckFailed }
}

// ── Aerodrome (Base) — detect so we can warn (can't host hooks) ───────────────
async function aerodromeExists(client: Client, cfg: PoolReadyChainCfg, asset: Address): Promise<boolean> {
  if (!cfg.aerodromeFactory) return false
  const factory = cfg.aerodromeFactory
  try {
    const [volatile, stable] = await Promise.all([
      client.readContract({ address: factory, abi: aerodromeFactoryAbi, functionName: 'getPool', args: [asset, cfg.weth, false] }).catch(() => zeroAddress),
      client.readContract({ address: factory, abi: aerodromeFactoryAbi, functionName: 'getPool', args: [asset, cfg.weth, true] }).catch(() => zeroAddress),
    ])
    return volatile.toLowerCase() !== zeroAddress || stable.toLowerCase() !== zeroAddress
  } catch {
    return false
  }
}

async function wethUsdPrice(slug: string, weth: Address): Promise<number | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${weth}`, { headers: { Accept: 'application/json' } })
    if (!r.ok) return null
    const pairs = (await r.json()) as { priceUsd?: string; liquidity?: { usd?: number } }[]
    let best: number | null = null
    let bestLiq = -1
    for (const p of (Array.isArray(pairs) ? pairs : []).slice(0, MAX_DEX_PAIRS)) {
      // THE PRICE GETS THE SAME TREATMENT AS THE LIQUIDITY. My earlier pass
      // routed liquidity through finiteUsd and left `parseFloat(priceUsd)`
      // bare, which is a half-landed fix of exactly the class it was fixing:
      // a non-numeric priceUsd makes this NaN, every unlisted candidate's
      // `depthEth * ethUsd` becomes NaN, and BOTH the partial-scan refusal and
      // the shallow-pool warning below stop firing — so a dust pool is crowned
      // silently. Found by the 2026-08-07 audit round.
      const liq = finiteUsd(p?.liquidity?.usd) ?? 0
      const price = finiteUsd(p?.priceUsd)
      if (liq > bestLiq && price != null && price > 0) {
        bestLiq = liq
        best = price
      }
    }
    return best
  } catch {
    return null
  }
}

// Real USD liquidity per pool, keyed by the pool's on-chain identifier — V2/V3 pool
// CONTRACT address, V4 pool id (DexScreener uses the 32-byte poolId as `pairAddress`
// for v4). This is the cross-venue-consistent depth metric (pool TVL, the same way
// for every DEX version) and matches what users see in the asset search.
/** A USD figure from an UNTRUSTED API is not a number just because the cast
 *  says so. DexScreener's responses are `as`-cast, never validated, and
 *  `?? 0` only defends against null/undefined — a string, an empty string or
 *  anything else arrives intact and turns the first arithmetic that touches it
 *  into NaN. That matters more than it sounds downstream: NaN passes a
 *  `!= null` guard and then fails EVERY `<` comparison, so a depth of unknown
 *  shape reads as "no problem" rather than "unreadable" (the class
 *  specallocator hit in pool-safety's own gate, 2026-08-07). Finite and
 *  non-negative, or nothing. */
function finiteUsd(v: unknown): number | null {
  // `Number('')` is 0, not NaN — the empty-string coercion is the exact shape
  // the finding named, and it would enter here as a confident zero. A blank
  // field is an absent reading, so it is rejected before the numeric parse.
  if (typeof v === 'string' && v.trim() === '') return null
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

async function fetchPoolLiquidity(slug: string, asset: Address): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (!slug) return map // chain not indexed by DexScreener — on-chain depth ranks instead
  try {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/${slug}/${asset}`, {
      headers: { Accept: 'application/json' },
    })
    if (!r.ok) return map
    const pairs = (await r.json()) as { pairAddress?: string; liquidity?: { usd?: number } }[]
    for (const p of (Array.isArray(pairs) ? pairs : []).slice(0, MAX_DEX_PAIRS)) {
      const key = p.pairAddress?.toLowerCase()
      if (key) map.set(key, finiteUsd(p.liquidity?.usd) ?? 0)
    }
  } catch {
    /* DexScreener unavailable → caller falls back to on-chain depth */
  }
  return map
}

function toRoute(c: PoolCandidate): BasketRoute {
  if (c.venue === Venue.V4) return { venue: Venue.V4, ethPool: c.ethPoolKey!, v3Fee: 0, v2Pair: zeroAddress }
  // V4Q: the struct's ethPool slot carries the SETTLEMENT-paired key (fork
  // BasketEntry doc: "{settlement, asset} sorted by address — hookless either way").
  if (c.venue === Venue.V4Q) return { venue: Venue.V4Q, ethPool: c.ethPoolKey!, v3Fee: 0, v2Pair: zeroAddress }
  if (c.venue === Venue.V3) return { venue: Venue.V3, ethPool: ZERO_POOL_KEY, v3Fee: c.fee, v2Pair: zeroAddress }
  return { venue: Venue.V2, ethPool: ZERO_POOL_KEY, v3Fee: 0, v2Pair: c.poolAddress! }
}

/**
 * Find the deepest valid Uniswap pool (v2/v3/v4 vs ETH/WETH) for `asset` on `chainId`.
 * Rejects dynamic-fee and hooked V4 pools; throws if none (noting an Aerodrome-only
 * asset). Returns the chosen route ready for a `deployBasket` basket entry + all
 * candidates (deepest-first) + warnings.
 *
 * On a chain configured `rejectsV2Legs` (deployments.ts), V2 is not a venue at
 * all: it is excluded from the ranking, and a token whose ONLY route is a V2
 * pair is REFUSED here — `V2_ONLY`. This is the single choke point every add
 * surface goes through (picker, builder, reshape, bundle union all resolve via
 * findBestPool), so the ruling lands on all of them from this one place.
 */
/** Does the hooked market DOMINATE the best routable pool? ≥2× = the hooked
 *  pool is the token's real market and a basket leg would ride a side pool
 *  (the FWA class). Threshold MEASURED, not guessed: FWA hooked 261.5 ETH vs
 *  its pinned side pool ~40 (6.5× — a 20× gate MISSED it, owner caught the
 *  live basket); PRISM v2 hooked ~67 ETH vs v3 dust (~19×). 2× keeps tokens
 *  whose open market genuinely dominates addable. */
export function hookedMarketDominates(hookedDepthEth: number, bestRoutableDepthEth: number): boolean {
  if (!(hookedDepthEth > 0)) return false
  return hookedDepthEth >= Math.max(bestRoutableDepthEth, 0.01) * 2
}

/** BestPoolResult's hookedMarket, extended with the deepest hooked pool's
 *  FULL KEY — so the direct-swap lane can COMPOSE a UniversalRouter swap
 *  against the token's real (hooked) market instead of only warning about it.
 *  Declared here rather than widening types.ts's BestPoolResult: strictly
 *  additive — the base type every existing consumer imports is untouched, and
 *  this narrowing is assignable wherever BestPoolResult is expected (the
 *  dominance warning above keeps reading the same two depth fields). */
export interface HookedMarketReadout {
  hookedDepthEth: number
  bestHooklessDepthEth: number
  /** The deepest hooked candidate by depthEth ({native, asset} pair exactly
   *  as the scan filters it; depth reads stay capped at the first 6 hooked
   *  ids, unchanged). null when none read > 0. */
  deepest: (PoolKey & { depthEth: number }) | null
}

/** What findBestPool actually returns: BestPoolResult with the hooked-market
 *  readout extended (see HookedMarketReadout). */
export interface BestPoolResultWithHookedKey extends BestPoolResult {
  hookedMarket: HookedMarketReadout | null
}

export async function findBestPool(asset: Address, chainId: number): Promise<BestPoolResultWithHookedKey> {
  const cfg = chainCfg(chainId)
  // Honest failure, not silent degradation. The V4 PoolManager is the baseline —
  // the protocol's own pools ARE V4 — so a chain with one runs V4-only detection;
  // V2/V3/Aerodrome scans join in only where that infra exists (Base/Ethereum).
  if (!cfg.poolManager) {
    throw new PoolDetectionError(
      'No deployment is configured for this chain on this build — pool detection is unavailable.',
      'NO_POOL',
    )
  }
  const v23Ready = isPoolReady(cfg) // weth + BOTH factories (full coverage)
  const v2Ready = isV2Ready(cfg)
  const v3Ready = isV3Ready(cfg) // V3 alone (Robinhood: canonical V3, no V2)
  // THE V2 REJECTION (per-chain lineage — `rejectsV2Legs`, deployments.ts). On a
  // chain whose factory reverts InvalidEthPool on venue 2, a V2 route is not a
  // slower route: CREATE2 swallows the reason, so the leg mines, prices, and
  // then bricks the deploy at simulate under a CREATE2Failed that names no
  // cause. The V2 sweep below still RUNS unchanged — a found pair is the whole
  // difference between "this token routes somewhere else" and "this token has
  // nowhere to go on this deployment", and only one of those sentences is true.
  const v2Rejected = chainRejectsV2(chainId)
  const client = clientFor(chainId)

  const lower = asset.toLowerCase()
  if ((cfg.weth && lower === cfg.weth.toLowerCase()) || lower === NATIVE_ETH) {
    throw new PoolDetectionError('Asset cannot be ETH/WETH.', 'BAD_ASSET')
  }
  // V4Q sweep only on a declared V4Q-lineage factory, and never for the
  // settlement asset itself (a {USDG, USDG} pair is malformed; a settlement leg
  // is the fork's buffer case and still resolves its ETH hub pool via findV4).
  const v4qReady = !!cfg.v4qLineage && !!cfg.usdc && lower !== cfg.usdc.toLowerCase()

  // Identity screen (contract exists / decimals sane / not 777 / not a nested
  // basket / not denylisted) runs IN PARALLEL with venue discovery — but its
  // verdict is evaluated FIRST: "this token can't be a leg" is the more useful
  // truth than "no pool found", and both cost the same wall-clock this way.
  // The V4 scan is ALWAYS the native-ETH-paired one: the factory routes every
  // leg through a native-ETH V4 pool ON EVERY CHAIN — the shared-address deploy
  // means the same bytecode everywhere, and a leg carrying any other pool shape
  // fails inside the token constructor as CREATE2Failed() (proven on Robinhood
  // 2026-07-12: the working basket's legs are ETH-paired; USDG-paired keys from
  // the removed settlement scan bricked every deploy at simulate).
  const [screen, v2, v3s, v4, v4q, aero] = await Promise.all([
    screenTokenIdentity(client, cfg, asset),
    v2Ready ? findV2(client, cfg as V2ReadyChainCfg, asset) : Promise.resolve({ candidate: null, checkFailed: false }),
    v3Ready ? findV3(client, cfg as V3ReadyChainCfg, asset) : Promise.resolve({ candidates: [], checkFailed: false }),
    findV4(client, cfg as Pick<ChainCfg, 'chainId'> & { poolManager: Address }, asset),
    v4qReady
      ? findV4Q(client, cfg as Pick<ChainCfg, 'chainId'> & { poolManager: Address; usdc: Address }, asset)
      : Promise.resolve({ candidates: [] as PoolCandidate[], partial: false as V4ScanGap, depthCheckFailed: false }),
    v23Ready ? aerodromeExists(client, cfg as PoolReadyChainCfg, asset) : Promise.resolve(false), // aero detection stays full-coverage-only
  ])
  if (screen.hardFail) throw new PoolDetectionError(screen.hardFail.message, screen.hardFail.code)
  const decimals = screen.decimals

  // Incomplete V2/V3 coverage is a HARD stop, not a shrug: ranking without a
  // venue silently routes the leg into whatever survived (MOG once landed on an
  // $11k V3 pool while its $4.6M V2 pair sat unchecked). Retry beats wrong.
  //
  // …with ONE narrowing, and only where V2 cannot win anyway: on a rejecting
  // chain an unread V2 pair can no longer mis-route a leg, so it blocks only
  // when nothing else answered — there it would decide between the V2-only
  // refusal and "no pool at all", and an unchecked venue may not pick between
  // two verdicts. Otherwise a transient V2 hiccup would stall an add for a
  // venue this deployment cannot use.
  const otherVenuesFound = v3s.candidates.length + v4.candidates.length + v4q.candidates.length > 0
  const v2CheckBlocks = v2.checkFailed && (!v2Rejected || !otherVenuesFound)
  if (v2CheckBlocks || v3s.checkFailed || v4.depthCheckFailed || v4q.depthCheckFailed) {
    throw new PoolDetectionError(
      'Could not check every Uniswap venue for this token (RPC error) — refusing to pick a pool from an incomplete sweep. Add the token again to retry.',
      'VENUE_CHECK_FAILED',
    )
  }

  const candidates: PoolCandidate[] = []
  // A rejected venue never enters the ranking, so the sort below cannot crown
  // it: a leg that would have taken V2 on its USD liquidity takes its best
  // non-V2 pool instead. Flag off, this line is the old one exactly.
  if (v2.candidate && !v2Rejected) candidates.push(v2.candidate)
  candidates.push(...v3s.candidates, ...v4.candidates, ...v4q.candidates)

  if (candidates.length === 0) {
    // Named BEFORE the generic sentences below, because with a V2 pair sitting
    // right there neither of them is true — not "no Uniswap pool found", not
    // "only an Aerodrome pool exists" — and the user's next move depends on
    // knowing which wall they hit.
    if (v2Rejected && v2.candidate) {
      throw new PoolDetectionError(V2_ONLY_SENTENCE, 'V2_ONLY')
    }
    if (aero) {
      throw new PoolDetectionError(
        "Only an Aerodrome pool exists for this asset — Aerodrome can't host Spectrum's V4 hook. Choose a token with a Uniswap v2/v3/v4 pool.",
        'ONLY_AERODROME',
      )
    }
    // Name exactly the venues that were swept (the gate split made these
    // independent — a 4663 user was told "v4 only" while V3 WAS searched).
    const swept = v23Ready ? 'v2/v3/v4' : v3Ready ? 'v3/v4' : v2Ready ? 'v2/v4' : 'v4'
    throw new PoolDetectionError(
      `No Uniswap ${swept} ETH pool found for this asset on this chain.`,
      'NO_POOL',
    )
  }

  // The token routes — now confirm its transfers are whole. A fee-on-transfer
  // token under-fills its leg on every mint (and can brick a V4 leg), so a
  // MEASURED fee is a hard stop; an inconclusive probe (exotic storage layout,
  // keyless RPC without eth_simulateV1) adds nothing rather than crying wolf.
  const fee = await probeTransferFee(client, asset)
  if (fee.verdict === 'fee-on-transfer') {
    throw new PoolDetectionError(
      `This token takes a fee on transfer (${((10_000 - fee.receivedBps) / 100).toFixed(2)}% measured) — basket legs would under-fill on every mint.`,
      'FEE_ON_TRANSFER',
    )
  }
  // THE FWA CLASS (SpectrumContracts w-59 R1 + the live TEST10006 seed
  // failure): a token that REFUSES plain transfers can be bought into a
  // basket and then strand it — transfer gating is the one hole in the
  // in-kind exit story, so it is a hard stop at add time, measured, never
  // inferred. Inconclusive still adds nothing rather than crying wolf.
  if (fee.verdict === 'transfer-refused') {
    throw new PoolDetectionError(
      'This token refused a plain wallet-to-wallet transfer in simulation — it gates transfers with its own rule, so a basket holding it could not exit in kind. Pick a different asset.',
      'FEE_ON_TRANSFER',
    )
  }

  // Rank by REAL USD liquidity (DexScreener pool TVL) — measured the same way for
  // every venue. The on-chain `depthEth` is NOT comparable across versions (V2/V3 are
  // real reserves; V4's virtual reserve is inflated for concentrated liquidity), which
  // let tiny tightly-concentrated V4 pools out-rank genuinely deep pools. Match each
  // candidate to its DexScreener pool (V4 by poolId, V2/V3 by pool address).
  const [ethUsd, liqByPool] = await Promise.all([
    cfg.dexscreenerSlug && cfg.weth
      ? wethUsdPrice(cfg.dexscreenerSlug, cfg.weth)
      : nativeEthUsdOnChain(chainId), // unindexed chain (Robinhood): its own ETH/settlement pool
    fetchPoolLiquidity(cfg.dexscreenerSlug, asset),
  ])
  for (const c of candidates) {
    const key = (c.venue === Venue.V4 || c.venue === Venue.V4Q ? c.poolId : c.poolAddress)?.toLowerCase()
    const listedUsd = key ? liqByPool.get(key) : undefined
    c.dexListed = listedUsd != null
    // DexScreener TVL when the pool is indexed; otherwise a V4Q candidate KEEPS
    // its settlement-side read (already real dollars — overwriting it with
    // depthEth×ethUsd would zero it); everything else gets the on-chain
    // ETH-side estimate (ethUsd comes from the chain's own settlement pool
    // where no indexer covers it — see nativeEthUsdOnChain).
    c.depthUsd =
      listedUsd != null
        ? listedUsd
        : c.venue === Venue.V4Q
          ? c.depthUsd
          : ethUsd != null
            ? c.depthEth * ethUsd
            : null
  }

  // A PARTIAL V4 scan must never crown a depthless pool: with the scan degraded
  // (capped public RPC) a real V4 pool can be invisible while a dust V2/V3 pool
  // "wins" — the exact mis-route the V2/V3 hard-stop doctrine forbids. If the
  // would-be best has no measurable depth AND V4 coverage was partial, refuse
  // and let the user retry (the scan is flaky, not permanently broken).
  // Either V4-family scan cut short counts: a partial sweep must never crown a
  // depthless pool (the same doctrine for ETH-paired and settlement-paired).
  const v4Partial: V4ScanGap = v4.partial !== false ? v4.partial : v4q.partial
  {
    const sorted = [...candidates].sort((a, b) => (b.depthUsd ?? 0) - (a.depthUsd ?? 0) || b.depthEth - a.depthEth)
    const top = sorted[0]
    if (v4Partial !== false && top && (top.depthUsd ?? 0) < 100 && top.depthEth < 0.05) {
      throw new PoolDetectionError(
        'Could not establish real pool depth for this token (the V4 scan was cut short by this RPC) — add it again to retry.',
        'VENUE_CHECK_FAILED',
      )
    }
  }

  // DexScreener-listed pools (real, comparable TVL) always rank above unlisted dust;
  // among listed, deepest USD wins; unlisted fall back to on-chain ETH depth.
  candidates.sort((a, b) => {
    if (!!a.dexListed !== !!b.dexListed) return a.dexListed ? -1 : 1
    if (a.dexListed && b.dexListed) return (b.depthUsd ?? 0) - (a.depthUsd ?? 0)
    if (a.depthUsd != null || b.depthUsd != null) return (b.depthUsd ?? 0) - (a.depthUsd ?? 0)
    return b.depthEth - a.depthEth
  })
  const best = candidates[0]

  const warnings: string[] = []
  // The excluded venue, said out loud and FIRST: the leg is not routing through
  // this token's V2 pair, and (often) not through its deepest pool either — the
  // creator should hear why before they weigh it, not infer it from a depth
  // figure that looks lower than the one the token search showed them.
  if (v2Rejected && v2.candidate) {
    warnings.push(
      `A Uniswap V2 pair exists for this token but was excluded — ${V2_REJECTION_CLAUSE}, so the leg routes through ${best.label} instead.`,
    )
  }
  // Only meaningful where DexScreener SHOULD have answered: on settlement-hub
  // chains (no slug) the depth figures are exact on-chain settlement-side reads.
  const allUnpriced = candidates.length > 1 && candidates.every((c) => c.depthUsd == null)
  if ((cfg.dexscreenerSlug && liqByPool.size === 0 && candidates.length > 1) || allUnpriced) {
    warnings.push(
      'Live pool-depth data was unavailable — venues were ranked by on-chain reserves for this add (V4 depth is virtual and can over-rank).',
    )
  }
  // THE HOOKED-MARKET WARNING (measured live 2026-08-15, TEST10006's FWA leg:
  // the token's REAL $944k market is a HOOKED v4 pool — baskets cannot route
  // hooks by design — so the detector pinned a $15k hookless side pool, and
  // the token's own contract then refused trades through it at seed time.
  // The creator must hear this at ADD time, not at the seed wall. A warning
  // rather than a refusal: some hook-launched tokens trade fine through their
  // hookless/v3 side pools — the ratio is what says which story this is.)
  {
    const hookedEthW = (v4 as { hookedDepthEth?: number }).hookedDepthEth ?? 0
    if (hookedMarketDominates(hookedEthW, best.depthEth)) {
      warnings.push(
        `This token's main market is a hooked pool baskets cannot route — the leg would ride a far smaller side pool, and some hook-launched tokens refuse trades outside their own market. If the seed or buys revert with the token's own error, this is why.`,
      )
    }
  }
  if (best.depthUsd != null && best.depthUsd < SHALLOW_USD_THRESHOLD) {
    warnings.push(
      `Deepest pool is shallow (~$${Math.round(best.depthUsd).toLocaleString()} ${best.dexListed ? 'listed TVL' : best.venue === Venue.V4 ? 'virtual in-range' : best.venue === Venue.V4Q ? 'settlement-side in-range' : 'ETH-side'}) — sizable trades may slip.`,
    )
    // A shallow Uniswap side + a live Aerodrome pool usually means the token's real
    // depth lives on Aerodrome — which Spectrum can't route (it can't host the hook).
    if (aero) {
      warnings.push(
        "This token also trades on Aerodrome, but Spectrum can only route Uniswap v2/v3/v4 — Aerodrome depth doesn't help this leg.",
      )
    }
  }
  if (v4Partial) {
    // The text states the CAUSE, not the chain tier (a failed scan on a
    // QuickNode-configured site used to print "no private RPC" — wrong). Either
    // way the standard V4 tiers WERE probed directly (both the ETH-paired and,
    // on a V4Q chain, the settlement-paired shapes); only exotic tick spacings
    // are invisible without the full log scan.
    warnings.push(
      v4Partial === 'skipped'
        ? 'V4 coverage is partial: standard fee tiers were checked directly, but a full V4 scan needs a private RPC this build does not have — an exotic-tier V4 pool may be missed. Set an origin-restricted key (VITE_ALCHEMY_API_KEY) or your own provider URL (VITE_BASE_RPC_URL / VITE_MAINNET_RPC_URL).'
        : 'V4 coverage is partial: the full V4 scan failed on this RPC (provider log-range caps are the usual cause), so standard fee tiers were checked directly — an exotic-tier V4 pool may be missed. Re-add the token to retry the full scan.',
    )
  }

  const hookedEth = (v4 as { hookedDepthEth?: number }).hookedDepthEth ?? 0
  return {
    asset,
    chainId,
    decimals,
    best,
    route: toRoute(best),
    candidates,
    warnings,
    hookedMarket:
      hookedEth > 0
        ? { hookedDepthEth: hookedEth, bestHooklessDepthEth: best.depthEth, deepest: v4.hookedDeepest ?? null }
        : null,
  }
}
