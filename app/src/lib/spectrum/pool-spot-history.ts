import { encodeAbiParameters, keccak256, type Address, type PublicClient } from 'viem'
import { chainCfg } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { V4_POOLS_SLOT } from '../chain/constants'
import { poolManagerExtsloadAbi } from '../pools/abis'
import { NATIVE_ETH, PoolDetectionError, type PoolKey } from '../pools/types'
import { findBestPool } from '../pools/find-best-pool'
import { v4PoolId } from '../pools/v4-usd'
import { v3PoolFor, v3PoolSlot0Abi } from '../pools/v3-usd'
import { chainlinkFeedFor, fetchChainlinkHistory } from './chainlink-history'
import type { NavPoint } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// Pool-spot history — the price series for FEEDLESS Robinhood-native tokens
// (CASHCAT, HOODRAT, …; lab 2026-07-29). No API anywhere lists them, but their
// price lives in their own V4 pool's storage, and the chain's public node
// serves HISTORICAL state: sampling slot0 at past blocks reconstructs a real
// series with no indexer. The USD leg joins each sample with the on-chain
// Chainlink ETH/USD round nearest in time (chainlink-history.ts).
//
// Honest limits, measured 2026-07-29 on the public RPC: historical state is
// PATCHY (a mixed replica pool — ~24h reliably, older blocks hit-or-miss with
// "metadata is not found"). Failed samples are simply skipped: the chart draws
// from surviving points and shortens honestly rather than fabricating.
// Display-grade only — trade floors still come from the swap simulation.
// ─────────────────────────────────────────────────────────────────────────────

/** ~blocks/second, calibrated per call from two real headers (the 4663 L2 runs
 *  ~10 blk/s today; hardcoding would rot). */
async function blockRate(client: PublicClient): Promise<{ latest: bigint; latestTs: number; rate: number }> {
  const latest = await client.getBlock()
  const probeN = latest.number > 200_000n ? latest.number - 200_000n : 1n
  const probe = await client.getBlock({ blockNumber: probeN })
  const dt = Number(latest.timestamp - probe.timestamp)
  const rate = dt > 0 ? Number(latest.number - probe.number) / dt : 10
  return { latest: latest.number, latestTs: Number(latest.timestamp), rate }
}

async function slot0At(
  client: PublicClient,
  poolManager: Address,
  id: `0x${string}`,
  blockNumber: bigint,
): Promise<number | null> {
  try {
    const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, V4_POOLS_SLOT]))
    const word = await client.readContract({
      address: poolManager,
      abi: poolManagerExtsloadAbi,
      functionName: 'extsload',
      args: [base],
      blockNumber,
    })
    const sqrtP = BigInt(word) & ((1n << 160n) - 1n)
    if (sqrtP === 0n) return null
    const ratio = Number(sqrtP) / 2 ** 96
    const p = ratio * ratio
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null // pruned replica / pre-init block — skip the sample
  }
}

/** V3 sibling of slot0At: the pool contract's own slot0 at a pinned block.
 *  Same output contract — raw1 per raw0, null = skip the sample. */
async function v3Slot0At(client: PublicClient, pool: Address, blockNumber: bigint): Promise<number | null> {
  try {
    const [sqrtP] = await client.readContract({ address: pool, abi: v3PoolSlot0Abi, functionName: 'slot0', blockNumber })
    if (sqrtP === 0n) return null
    const ratio = Number(sqrtP) / 2 ** 96
    const p = ratio * ratio
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null // pruned replica / pre-init block — skip the sample
  }
}

/** Nearest-at-or-before join (falls back to the earliest point). */
function joinUsd(series: NavPoint[], t: number): number | null {
  if (series.length === 0) return null
  let best = series[0]
  for (const p of series) {
    if (p.time <= t) best = p
    else break
  }
  return best.value
}

// The asset's sampleable routing pool: V4 = a native-ETH PoolKey (slot0 via
// PoolManager extsload), V3 = the pool contract itself (its own slot0). V2 has
// no live 4663 case (no factory seated) — unsupported until one exists.
// V4Q (venue 3) deliberately falls to null here: every V4Q-eligible asset today
// is a tokenized stock with a Chainlink feed, so its chart comes from the
// feed rung, never this feedless one. Revisit only if a FEEDLESS token's best
// pool ever becomes settlement-paired.
type SpotRoute = { kind: 'v4'; key: PoolKey } | { kind: 'v3'; pool: Address }

const routeCache = new Map<string, SpotRoute | null>()

/**
 * History for a feedless 4663 asset from its own routing pool. Resolves the
 * deepest pool once (cached), samples slot0 across the window, and prices
 * each sample via the Chainlink ETH/USD round nearest in time.
 */
export async function fetchPoolSpotHistory(
  chainId: number,
  address: string,
  startSec: number,
): Promise<NavPoint[]> {
  const cfg = chainCfg(chainId)
  if (chainId !== 4663 || !cfg.poolManager) return []
  const client = clientFor(chainId)

  // the asset's routing pool (the same resolution the builder trusts)
  const cacheKey = `${chainId}:${address.toLowerCase()}`
  let route = routeCache.get(cacheKey)
  let decimals = 18
  if (route === undefined) {
    try {
      const best = await findBestPool(address as Address, chainId)
      decimals = best.decimals
      if (best.route.venue === 0 && best.route.ethPool.currency0 === NATIVE_ETH) {
        route = { kind: 'v4', key: best.route.ethPool }
      } else if (best.route.venue === 1 && best.route.v3Fee > 0) {
        // V3-best token (live on 4663 since the gate split): sample the pool
        // contract itself — without this branch PONS-class tokens lost their
        // chart the moment detection IMPROVED past their thin V4 pool.
        const pool = await v3PoolFor(chainId, address as Address, best.route.v3Fee)
        route = pool ? { kind: 'v3', pool } : null
      } else {
        route = null
      }
      routeCache.set(cacheKey, route) // a real resolution is settled truth
    } catch (e) {
      // Only a DEFINITIVE verdict may be memoized. VENUE_CHECK_FAILED (and any
      // non-detection error) is "could not check, retry" — caching its null
      // blanked the token's chart for the whole session on one RPC blip.
      route = null
      if (e instanceof PoolDetectionError && e.code !== 'VENUE_CHECK_FAILED') {
        routeCache.set(cacheKey, null)
      }
    }
  } else {
    try {
      const best = await findBestPool(address as Address, chainId) // cache-warm in find-best-pool itself
      decimals = best.decimals
    } catch {
      /* keep 18 */
    }
  }
  if (!route) return []

  // ETH/USD across the window from the chain's own Chainlink feed
  const ethFeed = cfg.weth ? chainlinkFeedFor(chainId, cfg.weth) : null // WETH → ETH/USD
  if (!ethFeed) return []
  const ethSeries = await fetchChainlinkHistory(client, ethFeed, startSec)
  if (ethSeries.length === 0) return []

  const { latest, latestTs, rate } = await blockRate(client)
  const now = latestTs
  const span = Math.max(now - startSec, 3600)
  const SAMPLES = span <= 90_000 ? 24 : 32
  const pm = cfg.poolManager
  const r = route
  const id = r.kind === 'v4' ? v4PoolId(r.key) : null
  // Both samplers return raw1-per-raw0. V4: ETH is always currency0. V3: the
  // pool sorts by address, so the formula flips when the asset is token0.
  const wethIsToken0 = r.kind === 'v3' && !!cfg.weth && BigInt(cfg.weth) < BigInt(address)
  const toUsd = (p: number, ethUsd: number): number =>
    r.kind === 'v4' || wethIsToken0
      ? (ethUsd * 10 ** (decimals - 18)) / p // p = asset-raw per wei
      : ethUsd * p * 10 ** (decimals - 18) // p = weth-raw per asset-raw

  const targets = Array.from({ length: SAMPLES }, (_, i) => startSec + Math.round((i / (SAMPLES - 1)) * span))
  // Bounded waves (sweep catch): historical reads pin DIFFERENT blockNumbers so
  // they cannot coalesce into one multicall — a 32-wide burst was self-inflicted
  // rate-limiting against the public node. 6 at a time keeps it polite.
  const reads: (NavPoint | null)[] = []
  const WAVE = 6
  for (let w = 0; w < targets.length; w += WAVE) {
    const wave = await Promise.all(
      targets.slice(w, w + WAVE).map(async (t) => {
        const back = BigInt(Math.max(0, Math.round((now - t) * rate)))
        const bn = latest > back ? latest - back : 1n
        const p = r.kind === 'v4' ? await slot0At(client, pm, id!, bn) : await v3Slot0At(client, r.pool, bn)
        if (p == null) return null
        const ethUsd = joinUsd(ethSeries, t)
        if (ethUsd == null) return null
        const usd = toUsd(p, ethUsd)
        return Number.isFinite(usd) && usd > 0 ? { time: t, value: usd } : null
      }),
    )
    reads.push(...wave)
  }
  const points = reads.filter((x): x is NavPoint => x !== null)
  return points.length >= 2 ? points : []
}
