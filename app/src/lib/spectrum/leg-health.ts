// ─────────────────────────────────────────────────────────────────────────────
// Mint pre-flight: can this basket's legs be ACQUIRED at all?
//
// LegMinNotMet has three causes with opposite remedies (contracts, measured on
// the live registry 2026-08-04): a TWAP burst (heals ~30 min), a thin pool
// (size down), and a STRUCTURALLY DEAD leg — a constituent whose routing pool
// is missing or holds zero liquidity. The third is knowable BEFORE the user
// tries (their live example: a basket whose leg has one pool, at one tier,
// with zero liquidity in it — no amount, retry, or slippage setting can ever
// mint it). This module answers exactly that question, per leg, from the same
// routing facts the mint itself uses (basket(i) venue / V3 fee tier / V4
// PoolKey), so the buy surface can say "this can't work" instead of letting a
// user discover it one revert at a time.
//
// ⛔ TRI-STATE, deliberately: 'dead' requires a SUCCESSFUL read that answered
// zero — a failed read is 'unknown', and unknown must NEVER gate anything
// ("could not check" ≠ "does not exist"; a flaky RPC once reported a live
// factory codeless). Display-grade, read-only, no trade path touched. Selling
// shares the same wall (legs swap back through the same pools), but today's
// one dead-legged basket is unseeded, so buy copy is where this mounts.
// ─────────────────────────────────────────────────────────────────────────────

import { zeroAddress, parseAbi, encodeAbiParameters, keccak256, toHex, type Address } from 'viem'
import { clientFor } from '../chain/rpc'
import { chainCfg } from '../chain/chains'
import { V4_POOLS_SLOT } from '../chain/constants'
import { poolManagerExtsloadAbi, v3FactoryAbi } from '../pools/abis'
import { v4PoolId } from '../pools/v4-usd'
import type { PoolKey } from '../pools/types'
import { legRoutingOf } from './basket-data'

export type LegHealthStatus = 'ok' | 'dead' | 'unknown'

export interface LegHealth {
  asset: Address
  /** On-chain symbol when the meta carries one — the banner names the leg. */
  symbol: string | null
  status: LegHealthStatus
  /** Only for dead legs: pool missing at its declared tier vs pool empty. */
  reason: 'no-pool' | 'no-liquidity' | null
}

export interface MintHealth {
  legs: LegHealth[]
  /** The structurally dead legs — non-empty ⇒ no mint can succeed today. */
  dead: LegHealth[]
  /** True when every leg answered (no unknowns) — an incomplete sweep can
   *  still show its dead legs, it just can't clear the basket. */
  complete: boolean
}

const v3PoolLiquidityAbi = parseAbi(['function liquidity() view returns (uint128)'])

/** One retry for transient blips — same posture as the pricing rungs. */
async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    await new Promise((r) => setTimeout(r, 150))
    return fn()
  }
}

/** A zero can be a LIE: a flaky RPC node returns decodable zeros for real
 *  state (measured twice on this project — a live factory read codeless, and
 *  the depth sweep reporting Base's DEEPEST pool "uninitialised" while
 *  contracts pushed $100k through it). So 'dead' is never a single sample:
 *  the first zero is re-sampled after a beat, and only agreement claims it —
 *  disagreement means the reads are unstable, which is 'unknown', not 'dead'.
 *  (Both samples can still hit one consistently-lying endpoint; the banner
 *  being non-gating is the backstop for that residual.) */
async function confirmDead(again: () => Promise<boolean>): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 400))
  try {
    return await again()
  } catch {
    return false // could not re-check → do not claim dead
  }
}

/** Pure classifier: a pool's (sqrtPriceX96, liquidity) → leg status. Zero on
 *  either axis means the pool cannot fill a swap: uninitialized (sqrtP 0) or
 *  initialized-but-empty (liquidity 0 — the live dead-leg case). */
export function classifyPoolState(sqrtP: bigint, liquidity: bigint): Exclude<LegHealthStatus, 'unknown'> {
  return sqrtP > 0n && liquidity > 0n ? 'ok' : 'dead'
}

/** Pure summary the UI mounts on: which legs make minting impossible. */
export function deadLegsOf(legs: LegHealth[]): LegHealth[] {
  return legs.filter((l) => l.status === 'dead')
}

/** V4/V4Q leg: slot0 + liquidity off the singleton's extsload (the same two
 *  words the depth ranker reads). */
async function v4LegHealth(chainId: number, poolManager: Address, key: PoolKey): Promise<Pick<LegHealth, 'status' | 'reason'>> {
  const readState = async (): Promise<'ok' | 'dead'> => {
    const id = v4PoolId(key)
    const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, V4_POOLS_SLOT]))
    const liquiditySlot = toHex(BigInt(base) + 3n, { size: 32 })
    const client = clientFor(chainId)
    const [slot0Word, liqWord] = await retryOnce(() =>
      Promise.all([
        client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [base] }),
        client.readContract({ address: poolManager, abi: poolManagerExtsloadAbi, functionName: 'extsload', args: [liquiditySlot] }),
      ]),
    )
    const sqrtP = BigInt(slot0Word) & ((1n << 160n) - 1n)
    const liquidity = BigInt(liqWord) & ((1n << 128n) - 1n)
    return classifyPoolState(sqrtP, liquidity)
  }
  try {
    if ((await readState()) === 'ok') return { status: 'ok', reason: null }
    const confirmed = await confirmDead(async () => (await readState()) === 'dead')
    return confirmed ? { status: 'dead', reason: 'no-liquidity' } : { status: 'unknown', reason: null }
  } catch {
    return { status: 'unknown', reason: null }
  }
}

/** V3 leg: the factory's pool at the leg's DECLARED tier — the tier the
 *  contract will swap through; a healthy pool at another tier can't help this
 *  leg (contracts' tier sweep ruled wrong-tier out as a live cause, but a
 *  missing pool at the declared tier is still a config-error shape worth
 *  naming). A decoded zero address is a real answer, not a failure. */
async function v3LegHealth(chainId: number, asset: Address, fee: number): Promise<Pick<LegHealth, 'status' | 'reason'>> {
  const cfg = chainCfg(chainId)
  if (!cfg.uniV3Factory || !cfg.weth) return { status: 'unknown', reason: null }
  const client = clientFor(chainId)
  const readPool = () =>
    retryOnce(() =>
      client.readContract({
        address: cfg.uniV3Factory!,
        abi: v3FactoryAbi,
        functionName: 'getPool',
        args: [asset, cfg.weth!, fee],
      }),
    )
  try {
    const pool = await readPool()
    if (!pool || pool.toLowerCase() === zeroAddress) {
      // a zero ADDRESS is also just a zero word from a node — confirm it too
      const confirmed = await confirmDead(async () => {
        const p2 = await readPool()
        return !p2 || p2.toLowerCase() === zeroAddress
      })
      return confirmed ? { status: 'dead', reason: 'no-pool' } : { status: 'unknown', reason: null }
    }
    const readLiq = () =>
      retryOnce(() => client.readContract({ address: pool, abi: v3PoolLiquidityAbi, functionName: 'liquidity' }))
    if ((await readLiq()) > 0n) return { status: 'ok', reason: null }
    const confirmed = await confirmDead(async () => (await readLiq()) === 0n)
    return confirmed ? { status: 'dead', reason: 'no-liquidity' } : { status: 'unknown', reason: null }
  } catch {
    return { status: 'unknown', reason: null }
  }
}

/**
 * Per-leg mint health for a basket. Rides the immutable meta the page already
 * fetched (cache-only — null when routing facts aren't warm yet, e.g.
 * snapshot-seeded meta before the live read fills it). A handful of view
 * calls, once per staleTime, no polling.
 */
export async function basketMintHealth(basket: string, chainId: number): Promise<MintHealth | null> {
  const routing = legRoutingOf(basket, chainId)
  if (!routing) return null
  const cfg = chainCfg(chainId)
  const usdcLow = cfg.usdc?.toLowerCase()
  const legs = await Promise.all(
    routing.assets.map(async (asset, i): Promise<LegHealth> => {
      const symbol = routing.assetSymbols?.[i] ?? null
      // The settlement leg IS the funding currency — nothing to acquire.
      if (usdcLow && asset.toLowerCase() === usdcLow) return { asset, symbol, status: 'ok', reason: null }
      const key = routing.ethPools?.[i]
      if (key && cfg.poolManager) {
        return { asset, symbol, ...(await v4LegHealth(chainId, cfg.poolManager, key)) }
      }
      const venue = routing.legVenues?.[i]
      const fee = routing.v3Fees?.[i] ?? 0
      if (venue === 1 && fee > 0) {
        return { asset, symbol, ...(await v3LegHealth(chainId, asset, fee)) }
      }
      // A venue this rung can't judge (V2, or routing facts missing): never gate.
      return { asset, symbol, status: 'unknown', reason: null }
    }),
  )
  return { legs, dead: deadLegsOf(legs), complete: legs.every((l) => l.status !== 'unknown') }
}
