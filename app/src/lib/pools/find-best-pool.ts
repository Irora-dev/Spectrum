import {
  encodePacked,
  formatUnits,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
} from 'viem'
import { clientFor, hasAlchemyKey, hasAlchemyTier } from '../chain/rpc'
import { chainCfg, isPoolReady, type ChainCfg, type PoolReadyChainCfg } from '../chain/chains'
import { nativeEthUsdOnChain } from './v4-usd'
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
  VENUE_LABEL,
  Venue,
  ZERO_POOL_KEY,
  type BasketRoute,
  type BestPoolResult,
  type PoolCandidate,
} from './types'
import { probeTransferFee, screenTokenIdentity } from './token-screen'

type Client = ReturnType<typeof clientFor>

// Standard Uniswap V3 fee tiers (pip fee → tick spacing).
const V3_FEE_TIERS: { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
]

const SHALLOW_USD_THRESHOLD = 10_000

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
  cfg: PoolReadyChainCfg,
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
  cfg: PoolReadyChainCfg,
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

// V4 ETH pools are native-ETH (currency0 = address(0), currency1 = asset). Discovery
// is by Initialize logs. With an Alchemy key, one filtered full-range call is instant;
// public RPCs choke on wide ranges, so fall back to a bounded, PARALLEL recent scan
// (and flag partial coverage so the caller can warn).
async function scanV4Initialize(
  client: Client,
  chainId: number,
  poolManager: Address,
  asset: Address,
): Promise<{ inits: V4Init[]; partial: boolean }> {
  // V4 has no factory getPool — discovery is by Initialize logs over the full range.
  // Only Alchemy-class endpoints serve a wide filtered getLogs quickly; public RPCs
  // on Base/Ethereum rate-limit/time out, so keyless there skips V4 and flags
  // partial. A chain with NO Alchemy tier at all (Robinhood) is different: its own
  // RPC is the only option and serves the filtered full-range call fast (young
  // chain) — attempt it; the catch below still degrades to partial on error.
  if (!hasAlchemyKey() && hasAlchemyTier(chainId)) return { inits: [], partial: true }
  const cacheKey = `v4scan:v1:${chainId}:${asset.toLowerCase()}`
  const cachedRaw = cacheGet<V4ScanCache>(cacheKey)
  const cached = cachedRaw && isV4ScanCache(cachedRaw) ? cachedRaw : null
  try {
    const latest = await client.getBlockNumber()
    const fromBlock = cached ? BigInt(cached.upToBlock) + 1n : 0n
    if (cached && fromBlock > latest) return { inits: cached.inits, partial: false }
    const logs = await client.getLogs({
      address: poolManager,
      event: v4InitializeEvent,
      args: { currency0: NATIVE_ETH, currency1: asset },
      fromBlock,
      toBlock: latest,
    })
    const inits = mergeInits(cached?.inits ?? [], toRecs(logs))
    cacheSet(cacheKey, { upToBlock: latest.toString(), inits } satisfies V4ScanCache, 0)
    return { inits, partial: false }
  } catch {
    // A cached prior full scan is still complete UP TO its block — usable, but
    // flagged partial so the caller's "may be missing a venue" warning shows.
    return cached ? { inits: cached.inits, partial: true } : { inits: [], partial: true }
  }
}

// Virtual ETH-side reserve from PoolManager storage: amount0 ≈ L · 2^96 / sqrtPriceX96.
async function v4DepthEth(client: Client, poolManager: Address, id: `0x${string}`): Promise<number> {
  try {
    const base = keccak256(encodePacked(['bytes32', 'uint256'], [id, V4_POOLS_SLOT]))
    const liquiditySlot = toHex(BigInt(base) + 3n, { size: 32 }) // StateLibrary: liquidity at base+3
    const [slot0Word, liqWord] = await Promise.all([
      client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [base] }),
      client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [liquiditySlot] }),
    ])
    const sqrtP = BigInt(slot0Word) & ((1n << 160n) - 1n)
    const liquidity = BigInt(liqWord) & ((1n << 128n) - 1n)
    if (sqrtP === 0n || liquidity === 0n) return 0
    const ethWei = (liquidity << 96n) / sqrtP
    return Number(formatUnits(ethWei, 18))
  } catch {
    return 0
  }
}

async function findV4(
  client: Client,
  cfg: Pick<ChainCfg, 'chainId'> & { poolManager: Address },
  asset: Address,
): Promise<{ candidates: PoolCandidate[]; partial: boolean }> {
  const { inits, partial } = await scanV4Initialize(client, cfg.chainId, cfg.poolManager, asset)
  const seen = new Set<string>()
  const out: PoolCandidate[] = []
  for (const init of inits) {
    if (seen.has(init.id)) continue
    seen.add(init.id)
    if (init.hooks.toLowerCase() !== zeroAddress) continue // only no-hook pools can be routed
    if (init.fee === DYNAMIC_FEE_FLAG) continue // reject dynamic-fee pools
    const depthEth = await v4DepthEth(client, cfg.poolManager, init.id)
    if (depthEth <= 0) continue
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
      depthEth,
      depthUsd: null,
    })
  }
  return { candidates: out, partial }
}

// ── V4, settlement-paired (chains whose hub IS the settlement asset) ─────────
// Robinhood: tokens pool against USDG, not native ETH — scan asset↔settlement
// pools (both address orderings), hookless + static-fee only. Depth reads
// straight off the SETTLEMENT side of the pool → depthUsd is exact ($1 anchor),
// no ETH price needed.
async function findV4Settlement(
  client: Client,
  cfg: Pick<ChainCfg, 'chainId'> & { poolManager: Address; usdc: Address },
  asset: Address,
): Promise<{ candidates: PoolCandidate[]; partial: boolean }> {
  const usdc = cfg.usdc
  // PoolKey currencies sort numerically — the settlement asset can be either side.
  const usdcIs0 = BigInt(usdc.toLowerCase()) < BigInt(asset.toLowerCase())
  const [c0, c1] = usdcIs0 ? [usdc, asset] : [asset, usdc]
  const cacheKey = `v4scan-settle:v1:${cfg.chainId}:${asset.toLowerCase()}`
  const cachedRaw = cacheGet<V4ScanCache>(cacheKey)
  const cached = cachedRaw && isV4ScanCache(cachedRaw) ? cachedRaw : null
  let inits: V4Init[]
  let partial = false
  try {
    const latest = await client.getBlockNumber()
    const fromBlock = cached ? BigInt(cached.upToBlock) + 1n : 0n
    if (cached && fromBlock > latest) {
      inits = cached.inits
    } else {
      const logs = await client.getLogs({
        address: cfg.poolManager,
        event: v4InitializeEvent,
        args: { currency0: c0, currency1: c1 },
        fromBlock,
        toBlock: latest,
      })
      inits = mergeInits(cached?.inits ?? [], toRecs(logs))
      cacheSet(cacheKey, { upToBlock: latest.toString(), inits } satisfies V4ScanCache, 0)
    }
  } catch {
    inits = cached?.inits ?? []
    partial = true
  }
  const out: PoolCandidate[] = []
  for (const init of inits) {
    if (init.hooks.toLowerCase() !== zeroAddress) continue
    if (init.fee === DYNAMIC_FEE_FLAG) continue
    const usd = await v4DepthSettlement(client, cfg.poolManager, init.id, usdcIs0)
    if (usd <= 0) continue
    out.push({
      venue: Venue.V4,
      label: VENUE_LABEL[Venue.V4],
      fee: init.fee,
      tickSpacing: init.tickSpacing,
      poolAddress: null,
      poolId: init.id,
      ethPoolKey: { currency0: c0, currency1: c1, fee: init.fee, tickSpacing: init.tickSpacing, hooks: zeroAddress },
      depthEth: 0,
      depthUsd: usd, // exact: read off the settlement side ($1 anchor)
    })
  }
  return { candidates: out, partial }
}

// Settlement-side virtual reserve of a V4 pool, in USD (settlement = 6dp $1 asset):
// currency0 side is L*2^96/sqrtP; currency1 side is L*sqrtP/2^96.
async function v4DepthSettlement(
  client: Client,
  poolManager: Address,
  id: `0x${string}`,
  settlementIs0: boolean,
): Promise<number> {
  try {
    const base = keccak256(encodePacked(['bytes32', 'uint256'], [id, V4_POOLS_SLOT]))
    const liquiditySlot = toHex(BigInt(base) + 3n, { size: 32 })
    const [slot0Word, liqWord] = await Promise.all([
      client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [base] }),
      client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [liquiditySlot] }),
    ])
    const sqrtP = BigInt(slot0Word) & ((1n << 160n) - 1n)
    const liquidity = BigInt(liqWord) & ((1n << 128n) - 1n)
    if (sqrtP === 0n || liquidity === 0n) return 0
    const raw = settlementIs0 ? (liquidity << 96n) / sqrtP : (liquidity * sqrtP) >> 96n
    return Number(formatUnits(raw, 6))
  } catch {
    return 0
  }
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
      const liq = p?.liquidity?.usd ?? 0
      if (liq > bestLiq && p?.priceUsd) {
        bestLiq = liq
        best = parseFloat(p.priceUsd)
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
      if (key) map.set(key, p.liquidity?.usd ?? 0)
    }
  } catch {
    /* DexScreener unavailable → caller falls back to on-chain depth */
  }
  return map
}

function toRoute(c: PoolCandidate): BasketRoute {
  if (c.venue === Venue.V4) return { venue: Venue.V4, ethPool: c.ethPoolKey!, v3Fee: 0, v2Pair: zeroAddress }
  if (c.venue === Venue.V3) return { venue: Venue.V3, ethPool: ZERO_POOL_KEY, v3Fee: c.fee, v2Pair: zeroAddress }
  return { venue: Venue.V2, ethPool: ZERO_POOL_KEY, v3Fee: 0, v2Pair: c.poolAddress! }
}

/**
 * Find the deepest valid Uniswap pool (v2/v3/v4 vs ETH/WETH) for `asset` on `chainId`.
 * Rejects dynamic-fee and hooked V4 pools; throws if none (noting an Aerodrome-only
 * asset). Returns the chosen route ready for a `deployBasket` basket entry + all
 * candidates (deepest-first) + warnings.
 */
export async function findBestPool(asset: Address, chainId: number): Promise<BestPoolResult> {
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
  const v23Ready = isPoolReady(cfg) // weth + V2/V3 factories present
  const client = clientFor(chainId)

  const lower = asset.toLowerCase()
  if ((cfg.weth && lower === cfg.weth.toLowerCase()) || lower === NATIVE_ETH) {
    throw new PoolDetectionError('Asset cannot be ETH/WETH.', 'BAD_ASSET')
  }
  if (!cfg.weth && cfg.usdc && lower === cfg.usdc.toLowerCase()) {
    throw new PoolDetectionError('The settlement asset itself cannot be a basket leg.', 'BAD_ASSET')
  }

  // Identity screen (contract exists / decimals sane / not 777 / not a nested
  // basket / not denylisted) runs IN PARALLEL with venue discovery — but its
  // verdict is evaluated FIRST: "this token can't be a leg" is the more useful
  // truth than "no pool found", and both cost the same wall-clock this way.
  const [screen, v2, v3s, v4, aero] = await Promise.all([
    screenTokenIdentity(client, cfg, asset),
    v23Ready ? findV2(client, cfg as PoolReadyChainCfg, asset) : Promise.resolve({ candidate: null, checkFailed: false }),
    v23Ready ? findV3(client, cfg as PoolReadyChainCfg, asset) : Promise.resolve({ candidates: [], checkFailed: false }),
    cfg.weth
      ? findV4(client, cfg as Pick<ChainCfg, 'chainId'> & { poolManager: Address }, asset)
      : findV4Settlement(client, cfg as Pick<ChainCfg, 'chainId'> & { poolManager: Address; usdc: Address }, asset),
    v23Ready ? aerodromeExists(client, cfg as PoolReadyChainCfg, asset) : Promise.resolve(false),
  ])
  if (screen.hardFail) throw new PoolDetectionError(screen.hardFail.message, screen.hardFail.code)
  const decimals = screen.decimals

  // Incomplete V2/V3 coverage is a HARD stop, not a shrug: ranking without a
  // venue silently routes the leg into whatever survived (MOG once landed on an
  // $11k V3 pool while its $4.6M V2 pair sat unchecked). Retry beats wrong.
  if (v2.checkFailed || v3s.checkFailed) {
    throw new PoolDetectionError(
      'Could not check every Uniswap venue for this token (RPC error) — refusing to pick a pool from an incomplete sweep. Add the token again to retry.',
      'VENUE_CHECK_FAILED',
    )
  }

  const candidates: PoolCandidate[] = []
  if (v2.candidate) candidates.push(v2.candidate)
  candidates.push(...v3s.candidates, ...v4.candidates)

  if (candidates.length === 0) {
    if (aero) {
      throw new PoolDetectionError(
        "Only an Aerodrome pool exists for this asset — Aerodrome can't host Spectrum's V4 hook. Choose a token with a Uniswap v2/v3/v4 pool.",
        'ONLY_AERODROME',
      )
    }
    throw new PoolDetectionError(
      v23Ready
        ? 'No Uniswap v2/v3/v4 ETH pool found for this asset.'
        : 'No Uniswap v4 ETH pool found for this asset on this chain.',
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
    const key = (c.venue === Venue.V4 ? c.poolId : c.poolAddress)?.toLowerCase()
    const listedUsd = key ? liqByPool.get(key) : undefined
    c.dexListed = listedUsd != null
    // DexScreener TVL when the pool is indexed; else keep an exact settlement-side
    // figure (findV4Settlement precomputed it); else an on-chain ETH-side estimate.
    c.depthUsd = listedUsd != null ? listedUsd : c.depthUsd != null ? c.depthUsd : ethUsd != null ? c.depthEth * ethUsd : null
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
  // Only meaningful where DexScreener SHOULD have answered: on settlement-hub
  // chains (no slug) the depth figures are exact on-chain settlement-side reads.
  if (cfg.dexscreenerSlug && liqByPool.size === 0 && candidates.length > 1) {
    warnings.push(
      'Live pool-depth data was unavailable — venues were ranked by on-chain reserves for this add (V4 depth is virtual and can over-rank).',
    )
  }
  if (best.depthUsd != null && best.depthUsd < SHALLOW_USD_THRESHOLD) {
    warnings.push(
      `Deepest pool is shallow (~$${Math.round(best.depthUsd).toLocaleString()} ETH-side) — sizable trades may slip.`,
    )
    // A shallow Uniswap side + a live Aerodrome pool usually means the token's real
    // depth lives on Aerodrome — which Spectrum can't route (it can't host the hook).
    if (aero) {
      warnings.push(
        "This token also trades on Aerodrome, but Spectrum can only route Uniswap v2/v3/v4 — Aerodrome depth doesn't help this leg.",
      )
    }
  }
  if (v4.partial) {
    warnings.push(
      hasAlchemyTier(chainId)
        ? 'V4 venues were not scanned on this build (keyless RPC) — a deeper V4 pool may exist. Set an origin-restricted key (VITE_ALCHEMY_API_KEY) for complete V4 coverage.'
        : 'The V4 pool scan was incomplete (RPC error) — a deeper pool may exist. Re-add the token to retry.',
    )
  }

  return { asset, chainId, decimals, best, route: toRoute(best), candidates, warnings }
}
