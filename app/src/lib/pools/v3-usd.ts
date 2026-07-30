// ─────────────────────────────────────────────────────────────────────────────
// On-chain USD pricing for V3-ROUTED basket legs — the V3 sibling of v4-usd.
// Exists for chains no price indexer covers (Robinhood 4663), where a leg's
// routing pool is the only price source. A V3 leg carries no PoolKey in the
// basket struct — just its fee tier — so the pool is re-derived from the
// canonical V3 factory (getPool is pure factory state, memoized: pools are
// immutable once deployed) and its slot0 IS the price, exactly like V4.
// Display-grade (trade floors still come from swap simulation).
// ─────────────────────────────────────────────────────────────────────────────

import { parseAbi, zeroAddress, type Address } from 'viem'
import { clientFor } from '../chain/rpc'
import { chainCfg } from '../chain/chains'
import { v3FactoryAbi } from './abis'

// Exported: pool-spot-history samples V3 slot0 at historical blocks too.
export const v3PoolSlot0Abi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
])

/** One retry for transient RPC blips — same posture as the V4 pricing rung. */
async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    await new Promise((r) => setTimeout(r, 150))
    return fn()
  }
}

// (chainId:asset:fee) → pool address. A found pool is immutable (CREATE2 off
// factory state); a NOT-found result is also cached — the factory can gain the
// pool later, but a deployed LEG referencing that fee tier can't exist unless
// the pool did at deploy time, so misses here are config errors, not races.
const poolMem = new Map<string, Address | null>()

export async function v3PoolFor(chainId: number, asset: Address, fee: number): Promise<Address | null> {
  const cfg = chainCfg(chainId)
  if (!cfg.uniV3Factory || !cfg.weth) return null
  const key = `${chainId}:${asset.toLowerCase()}:${fee}`
  const hit = poolMem.get(key)
  if (hit !== undefined) return hit
  try {
    const pool = await retryOnce(() =>
      clientFor(chainId).readContract({
        address: cfg.uniV3Factory!,
        abi: v3FactoryAbi,
        functionName: 'getPool',
        args: [asset, cfg.weth!, fee],
      }),
    )
    const resolved = pool && pool.toLowerCase() !== zeroAddress ? pool : null
    poolMem.set(key, resolved)
    return resolved
  } catch {
    return null // transient — NOT memoized, retries next call
  }
}

/** USD price of a V3-routed basket leg from ITS OWN routing pool: slot0 price
 *  vs WETH × the chain's ETH/USD anchor. Ordering-aware (token0 = lower
 *  address). Returns null on any failure — the caller's other rungs decide. */
export async function v3LegUsd(
  chainId: number,
  asset: Address,
  fee: number,
  assetDecimals: number,
  ethUsd: number | null,
): Promise<number | null> {
  if (ethUsd == null || !(fee > 0)) return null
  const cfg = chainCfg(chainId)
  if (!cfg.weth) return null
  const pool = await v3PoolFor(chainId, asset, fee)
  if (!pool) return null
  try {
    const [sqrtP] = await retryOnce(() =>
      clientFor(chainId).readContract({ address: pool, abi: v3PoolSlot0Abi, functionName: 'slot0' }),
    )
    if (sqrtP === 0n) return null
    const ratio = Number(sqrtP) / 2 ** 96
    const p = ratio * ratio // raw1 per raw0
    if (!Number.isFinite(p) || p <= 0) return null
    // token0 is the numerically lower address (Uniswap sort order).
    const wethIsToken0 = BigInt(cfg.weth) < BigInt(asset)
    const usd = wethIsToken0
      ? (ethUsd * 10 ** (assetDecimals - 18)) / p // p = asset-raw per weth-raw
      : ethUsd * p * 10 ** (assetDecimals - 18) // p = weth-raw per asset-raw
    return Number.isFinite(usd) && usd > 0 ? usd : null
  } catch {
    return null
  }
}
