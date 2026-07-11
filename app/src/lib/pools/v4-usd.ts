// ─────────────────────────────────────────────────────────────────────────────
// On-chain USD pricing over Uniswap V4 — for chains no price indexer covers
// (Robinhood 4663: no DexScreener/DefiLlama). Everything derives from two
// on-chain facts the protocol already stands on:
//   • the chain's settlement asset (the factory's USDC()/USDG) anchors $1;
//   • every basket leg routes through a native-ETH V4 pool whose PoolKey the
//     basket exposes on-chain (basket(i).ethPool) — its slot0 IS the price.
// ETH/USD = the deepest hookless native-ETH/settlement pool's slot0; a leg's
// USD = ETH/USD × its own pool's slot0. No external service, no oracle, no
// guessing — display-grade (trade floors still come from buildSwapQuote).
// ─────────────────────────────────────────────────────────────────────────────

import { encodeAbiParameters, formatUnits, keccak256, toHex, type Address } from 'viem'
import { clientFor, hasAlchemyKey, hasAlchemyTier } from '../chain/rpc'
import { chainCfg } from '../chain/chains'
import { V4_POOLS_SLOT } from '../chain/constants'
import { cacheGet, cacheSet } from '../spectrum/persist-cache'
import { poolManagerExtsloadAbi, v4InitializeEvent } from './abis'
import { DYNAMIC_FEE_FLAG, NATIVE_ETH, type PoolKey } from './types'

const POOL_KEY_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'currency0', type: 'address' },
      { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickSpacing', type: 'int24' },
      { name: 'hooks', type: 'address' },
    ],
  },
] as const

/** V4 pool id = keccak256(abi.encode(PoolKey)) — the singleton's mapping key. */
export function v4PoolId(key: PoolKey): `0x${string}` {
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [key]))
}

/** slot0 price as raw-currency1 per raw-currency0 ((sqrtP/2^96)^2), or null. */
async function slot0Price1Per0(chainId: number, poolManager: Address, id: `0x${string}`): Promise<number | null> {
  try {
    const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, V4_POOLS_SLOT]))
    const word = await clientFor(chainId).readContract({
      address: poolManager,
      abi: poolManagerExtsloadAbi,
      functionName: 'extsload',
      args: [base],
    })
    const sqrtP = BigInt(word) & ((1n << 160n) - 1n)
    if (sqrtP === 0n) return null
    const ratio = Number(sqrtP) / 2 ** 96
    const p = ratio * ratio
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

/** ETH-side virtual depth (same math as the detector) — hub-pool ranking only. */
async function depthEth(chainId: number, poolManager: Address, id: `0x${string}`): Promise<number> {
  try {
    const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, V4_POOLS_SLOT]))
    const liquiditySlot = toHex(BigInt(base) + 3n, { size: 32 })
    const client = clientFor(chainId)
    const [slot0Word, liqWord] = await Promise.all([
      client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [base] }),
      client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [liquiditySlot] }),
    ])
    const sqrtP = BigInt(slot0Word) & ((1n << 160n) - 1n)
    const liquidity = BigInt(liqWord) & ((1n << 128n) - 1n)
    if (sqrtP === 0n || liquidity === 0n) return 0
    return Number(formatUnits((liquidity << 96n) / sqrtP, 18))
  } catch {
    return 0
  }
}

interface HubPoolCache {
  id: `0x${string}`
  pickedAt: number
}
const HUB_TTL_MS = 6 * 3600 * 1000
const hubInflight = new Map<number, Promise<`0x${string}` | null>>()

// The chain's canonical ETH/USD reference: the deepest hookless static-fee
// native-ETH/settlement V4 pool. Persisted (re-ranked every ~6h); discovery is
// one filtered full-range Initialize scan — proven fast on young no-tier chains,
// and skipped (null) on keyless Alchemy-tier chains exactly like the detector.
async function hubPoolId(chainId: number): Promise<`0x${string}` | null> {
  const cfg = chainCfg(chainId)
  if (!cfg.poolManager || !cfg.usdc) return null
  const cacheKey = `v4hub:v1:${chainId}`
  const cached = cacheGet<HubPoolCache>(cacheKey)
  if (cached?.id && Date.now() - cached.pickedAt < HUB_TTL_MS) return cached.id

  const inflight = hubInflight.get(chainId)
  if (inflight) return inflight
  const run = (async (): Promise<`0x${string}` | null> => {
    if (!hasAlchemyKey() && hasAlchemyTier(chainId)) return cached?.id ?? null
    try {
      const client = clientFor(chainId)
      const latest = await client.getBlockNumber()
      const logs = await client.getLogs({
        address: cfg.poolManager!,
        event: v4InitializeEvent,
        args: { currency0: NATIVE_ETH, currency1: cfg.usdc },
        fromBlock: 0n,
        toBlock: latest,
      })
      const eligible = logs
        .map((l) => l.args)
        .filter((a) => a.id && (a.hooks ?? '').toLowerCase() === '0x0000000000000000000000000000000000000000' && a.fee !== DYNAMIC_FEE_FLAG)
      let best: `0x${string}` | null = null
      let bestDepth = 0
      // Bounded: rank the first 24 eligible pools by ETH-side depth.
      for (const a of eligible.slice(0, 24)) {
        const d = await depthEth(chainId, cfg.poolManager!, a.id as `0x${string}`)
        if (d > bestDepth) {
          bestDepth = d
          best = a.id as `0x${string}`
        }
      }
      if (best) cacheSet(cacheKey, { id: best, pickedAt: Date.now() } satisfies HubPoolCache, 0)
      return best ?? cached?.id ?? null
    } catch {
      return cached?.id ?? null
    }
  })()
  hubInflight.set(chainId, run)
  try {
    return await run
  } finally {
    hubInflight.delete(chainId)
  }
}

let ethUsdMem: { chainId: number; at: number; price: number } | null = null
const ETH_USD_TTL_MS = 60_000

/** Live ETH price in USD from the chain's own ETH/settlement V4 pool ($1 anchor). */
export async function nativeEthUsdOnChain(chainId: number): Promise<number | null> {
  if (ethUsdMem && ethUsdMem.chainId === chainId && Date.now() - ethUsdMem.at < ETH_USD_TTL_MS) {
    return ethUsdMem.price
  }
  const cfg = chainCfg(chainId)
  if (!cfg.poolManager) return null
  const id = await hubPoolId(chainId)
  if (!id) return null
  const p = await slot0Price1Per0(chainId, cfg.poolManager, id) // settlement-raw (6dp) per wei
  if (p == null) return null
  const price = p * 1e12 // 10^(18-6): wei → ETH, raw → whole settlement units ($1 each)
  if (!Number.isFinite(price) || price <= 0) return null
  ethUsdMem = { chainId, at: Date.now(), price }
  return price
}

/** USD price of a basket leg from ITS OWN native-ETH V4 pool (the on-chain route). */
export async function v4LegUsd(
  chainId: number,
  ethPool: PoolKey,
  assetDecimals: number,
  ethUsd: number,
): Promise<number | null> {
  const cfg = chainCfg(chainId)
  if (!cfg.poolManager) return null
  const p = await slot0Price1Per0(chainId, cfg.poolManager, v4PoolId(ethPool)) // asset-raw per wei
  if (p == null) return null
  const usd = (ethUsd * 10 ** (assetDecimals - 18)) / p
  return Number.isFinite(usd) && usd > 0 ? usd : null
}
