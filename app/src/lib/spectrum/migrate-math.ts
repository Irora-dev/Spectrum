// ─────────────────────────────────────────────────────────────────────────────
// In-kind migration planner — PURE math, mirrors SpectrumBasket.sol rounding
// exactly (FullMath.mulDiv rounds down; mulDivRoundingUp rounds up):
//
//   redeemInKind:  net   = amount·(BPS−fee)/BPS         (floor; haircut stays in pool)
//                  out_i = idleHeld_i·net/supply         (floor, per masked-on leg)
//   mintInKind:    slice = ceil(recv_i·fee/BPS)          (pool-favouring)
//                  s_i   = floor((recv_i−slice)·supply/idleHeld_i)
//                  shares = min_i(s_i)                   (the no-skip min-rule)
//
// The min-rule means (a) a v2 leg with zero availability blocks the whole mint,
// and (b) any deposit above the binding leg's proportional requirement is a
// DONATION to the pool. So the planner works backwards: find the max mintable
// shares from what the holder has, step down a small drift buffer, then compute
// the SMALLEST per-leg deposit that still clears that target. Donation exposure
// is bounded by (buffer + slippage) ≈ well under 1%.
// ─────────────────────────────────────────────────────────────────────────────
import type { Address } from 'viem'

export const BPS = 10_000n

/** Stay this far below the max mintable shares so reserve drift between the
 *  plan read and execution doesn't push the binding leg under target. */
export const DRIFT_BUFFER_BPS = 30n
/** minShares tolerance below target — the on-chain SlippageExceeded floor. */
export const MIN_SHARES_SLIPPAGE_BPS = 50n

export const mulDivDown = (a: bigint, b: bigint, c: bigint): bigint => (a * b) / c
export const mulDivUp = (a: bigint, b: bigint, c: bigint): bigint => (a * b + c - 1n) / c

export interface LegReserve {
  asset: Address
  symbol: string
  decimals: number
  /** Tracked reserve (`idleHeld`), raw asset decimals. */
  idleHeld: bigint
}

export interface RedeemPlan {
  /** Post-haircut share amount the pro-rata is computed from. */
  net: bigint
  outs: { leg: LegReserve; out: bigint }[]
}

/** Preview of redeemInKind(amount, all-true mask, to). */
export function planRedeem(
  legs: LegReserve[],
  effectiveSupply: bigint,
  feeBps: number,
  amount: bigint,
): RedeemPlan {
  const net = (amount * (BPS - BigInt(feeBps))) / BPS
  const outs = legs.map((leg) => ({
    leg,
    out: effectiveSupply > 0n ? mulDivDown(leg.idleHeld, net, effectiveSupply) : 0n,
  }))
  return { net, outs }
}

/** Forward share math for one leg: deposit `recv` → shares (contract-exact). */
export function sharesForLeg(recv: bigint, feeBps: number, supply: bigint, held: bigint): bigint {
  if (held === 0n) return 0n
  const slice = mulDivUp(recv, BigInt(feeBps), BPS)
  return mulDivDown(recv - slice, supply, held)
}

/** SMALLEST deposit on a leg that still yields ≥ `s` shares (invert + verify —
 *  the fee ceil can eat a unit, so bump until the forward check passes). */
export function recvForShares(s: bigint, feeBps: number, supply: bigint, held: bigint): bigint {
  if (s === 0n) return 0n
  const fee = BigInt(feeBps)
  const neededNet = mulDivUp(s, held, supply)
  let recv = mulDivUp(neededNet * BPS, 1n, BPS - fee)
  while (sharesForLeg(recv, feeBps, supply, held) < s) recv += 1n
  return recv
}

export interface MintPlan {
  ok: boolean
  /** v2 legs the holder has ZERO of — each one blocks the whole mint (no-skip rule). */
  missing: LegReserve[]
  /** Max shares mintable from availability (pre-buffer). */
  maxShares: bigint
  /** Buffered target the amounts are computed for. */
  targetShares: bigint
  /** On-chain minShares floor (SlippageExceeded below it). */
  minShares: bigint
  /** Positional deposits, aligned with the v2 legs array. */
  amounts: bigint[]
  /** Index of the availability-binding leg (lowest per-leg max), −1 when blocked. */
  bindingIndex: number
}

/**
 * Plan mintInKind deposits from what the holder actually has.
 * `available` is keyed by LOWERCASED asset address → raw wallet balance.
 */
export function planMint(
  legs: LegReserve[],
  effectiveSupply: bigint,
  feeBps: number,
  available: ReadonlyMap<string, bigint>,
  bufferBps: bigint = DRIFT_BUFFER_BPS,
  slippageBps: bigint = MIN_SHARES_SLIPPAGE_BPS,
): MintPlan {
  const blocked = (missing: LegReserve[]): MintPlan => ({
    ok: false,
    missing,
    maxShares: 0n,
    targetShares: 0n,
    minShares: 0n,
    amounts: legs.map(() => 0n),
    bindingIndex: -1,
  })

  if (effectiveSupply === 0n) return blocked([]) // no in-kind first mint (C-1)

  const missing = legs.filter((l) => (available.get(l.asset.toLowerCase()) ?? 0n) === 0n)
  if (missing.length > 0) return blocked(missing)
  if (legs.some((l) => l.idleHeld === 0n)) return blocked([]) // drained leg reverts on-chain (E-8)

  let maxShares = -1n
  let bindingIndex = -1
  legs.forEach((l, i) => {
    const avail = available.get(l.asset.toLowerCase()) ?? 0n
    const s = sharesForLeg(avail, feeBps, effectiveSupply, l.idleHeld)
    if (maxShares === -1n || s < maxShares) {
      maxShares = s
      bindingIndex = i
    }
  })
  if (maxShares <= 0n) return blocked([]) // dust — rounds to zero shares

  const targetShares = (maxShares * (BPS - bufferBps)) / BPS
  if (targetShares === 0n) return blocked([])

  const amounts = legs.map((l) => {
    const want = recvForShares(targetShares, feeBps, effectiveSupply, l.idleHeld)
    const avail = available.get(l.asset.toLowerCase()) ?? 0n
    return want > avail ? avail : want // clamp (recvForShares(target ≤ maxShares) ≤ avail by construction)
  })
  const minShares = (targetShares * (BPS - slippageBps)) / BPS

  return { ok: true, missing: [], maxShares, targetShares, minShares, amounts, bindingIndex }
}

/** Max shares supportable by the legs the holder CAN fund (zero-availability
 *  legs excluded — the delta trade buys those). Used to size how much of each
 *  missing leg the delta needs to acquire. 0n when nothing is funded. */
export function maxSharesOverFunded(
  legs: LegReserve[],
  effectiveSupply: bigint,
  feeBps: number,
  available: ReadonlyMap<string, bigint>,
): bigint {
  if (effectiveSupply === 0n) return 0n
  let max = -1n
  for (const l of legs) {
    const avail = available.get(l.asset.toLowerCase()) ?? 0n
    if (avail === 0n) continue
    if (l.idleHeld === 0n) return 0n
    const s = sharesForLeg(avail, feeBps, effectiveSupply, l.idleHeld)
    if (max === -1n || s < max) max = s
  }
  return max <= 0n ? 0n : max
}

// ─────────────────────────────────────────────────────────────────────────────
// REBALANCE planner (pure) — the "fund every under-funded leg from your broader
// holdings" step. The old delta funded an ADDED leg only from the proceeds of the
// DROPPED leg it replaced; when that was thin, the in-kind mint bottlenecked to
// dust and the rest fell to the sweep (a full DEX round-trip). This instead sizes
// deposits to the BALANCED target — each leg proportional to the pool's reserves,
// scaled to your total available value — so the in-kind mint captures the maximum
// and the sweep shrinks to nothing. Legs above target are SOLD, legs below are
// BOUGHT, all through the WETH hub (the hook routes/executes; this only plans).
//
// Prices come in as `priceE18` (WETH-wei per 1e18 raw token units) from live
// quotes, so this stays pure + unit-testable. A buffer keeps the target under the
// available value so swap slippage on the rebalanced portion can't leave a leg short.
// ─────────────────────────────────────────────────────────────────────────────

export interface RebalanceLegInput {
  asset: Address
  symbol: string
  decimals: number
  idleHeld: bigint
  /** available raw amount (redeemed + wallet). */
  avail: bigint
  /** WETH-wei value of 1e18 raw units of this leg (from a live quote); 0 = unpriced. */
  priceE18: bigint
}

export interface RebalancePlan {
  ok: boolean
  reason?: 'zero-supply' | 'no-value' | 'unpriced' | 'dust'
  /** Balanced target shares the deposits are sized for. */
  targetShares: bigint
  /** Balanced per-leg deposit (raw), aligned with the input legs. */
  deposits: bigint[]
  /** Legs to SELL to the hub (holding above the balanced deposit). */
  sells: { asset: Address; symbol: string; decimals: number; amount: bigint }[]
  /** Legs to BUY from the hub (holding below), with a WETH budget for each. */
  buys: { asset: Address; symbol: string; decimals: number; deficit: bigint; wethBudget: bigint }[]
}

/** The rebalance path is adopted only when it mints this much MORE than the
 *  plain (no extra swaps) path — below that the swap fees/slippage on the
 *  rebalanced portion outweigh the share gain and the old path stands. */
export const REBALANCE_MIN_GAIN_BPS = 500n

/** value(amountRaw) in WETH-wei = amountRaw · priceE18 / 1e18. */
const E18 = 1_000_000_000_000_000_000n

export function planRebalance(
  legs: RebalanceLegInput[],
  effectiveSupply: bigint,
  feeBps: number,
  /** WETH-wei of NON-leg value joining the budget (dropped-leg sale proceeds) —
   *  it holds no leg, so it funds the buys. */
  extraAvailValueWeth: bigint = 0n,
  bufferBps: bigint = DRIFT_BUFFER_BPS,
): RebalancePlan {
  const empty = (reason: RebalancePlan['reason']): RebalancePlan => ({
    ok: false,
    reason,
    targetShares: 0n,
    deposits: legs.map(() => 0n),
    sells: [],
    buys: [],
  })

  if (effectiveSupply === 0n) return empty('zero-supply')
  if (legs.some((l) => l.idleHeld === 0n)) return empty('zero-supply') // drained leg reverts on-chain
  // Every leg must be priced to size a balanced target (a leg we hold none of is
  // still priced from a probe quote by the caller).
  if (legs.some((l) => l.priceE18 <= 0n)) return empty('unpriced')

  const availValue = legs.reduce((s, l) => s + mulDivDown(l.avail, l.priceE18, E18), 0n) + extraAvailValueWeth
  const heldValue = legs.reduce((s, l) => s + mulDivDown(l.idleHeld, l.priceE18, E18), 0n)
  if (availValue === 0n || heldValue === 0n) return empty('no-value')

  // Target the balanced level, a buffer below the full available value so the
  // rebalance swaps' slippage can't push the binding leg under target.
  const budgetValue = mulDivDown(availValue, BPS - bufferBps, BPS)
  const deposits = legs.map((l) => mulDivDown(l.idleHeld, budgetValue, heldValue))

  const targetShares = legs.reduce((min, l, i) => {
    const s = sharesForLeg(deposits[i], feeBps, effectiveSupply, l.idleHeld)
    return min === -1n || s < min ? s : min
  }, -1n)
  if (targetShares <= 0n) return empty('dust')

  const sells: RebalancePlan['sells'] = []
  const buys: RebalancePlan['buys'] = []
  legs.forEach((l, i) => {
    const target = deposits[i]
    if (l.avail > target) {
      sells.push({ asset: l.asset, symbol: l.symbol, decimals: l.decimals, amount: l.avail - target })
    } else if (target > l.avail) {
      const deficit = target - l.avail
      buys.push({ asset: l.asset, symbol: l.symbol, decimals: l.decimals, deficit, wethBudget: mulDivDown(deficit, l.priceE18, E18) })
    }
  })

  return { ok: true, targetShares, deposits, sells, buys }
}

/**
 * Tokens MEASURED to accept `approve(non-zero → non-zero)` directly, so the
 * zero-first dance can be skipped and the user signs ONE transaction instead of
 * two (the owner, 2026-08-16: "why does it need to remove token approval only to
 * approve the token again?").
 *
 * ⚠ MEASURED, NOT ASSUMED, and the direction of risk is why. Being wrong toward
 * zero-first costs one cheap transaction; being wrong the other way makes the
 * approval REVERT and the run fail. So this list holds only the settlement
 * tokens this app actually funds with, each probed on its own chain
 * (eth_simulateV1, 2026-08-16: approve(1.00) then approve(2.00) with no zero
 * step, final allowance 2.00 on all three):
 *
 *   1     USDC  0xA0b8…eB48   direct re-approve OK
 *   8453  USDC  0x8335…2913   direct re-approve OK
 *   4663  USDG  0x5fc5…d168   direct re-approve OK
 *
 * Anything NOT on this list keeps the zero-first dance, because USDT-style
 * tokens genuinely do revert and the default must stay the safe one. Add a
 * token here only with a probe like the one above; a guess belongs nowhere near
 * an approval.
 */
const DIRECT_REAPPROVE: Record<number, ReadonlySet<string>> = {
  1: new Set(['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']),
  8453: new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']),
  4663: new Set(['0x5fc5360d0400a0fd4f2af552add042d716f1d168']),
}

/** Does this exact token on this exact chain accept a direct re-approve? */
export function acceptsDirectReapprove(chainId: number, token: string): boolean {
  return DIRECT_REAPPROVE[chainId]?.has(token.toLowerCase()) ?? false
}

/** Exact-amount approval plan (no infinite approve — the repo's standing-allowance
 *  red line). USDT-style tokens revert on approve(non-zero → non-zero), so a
 *  short existing allowance needs the zero-first dance — UNLESS the token is on
 *  the measured direct-re-approve list, in which case the zero step is pure
 *  wasted gas and an extra wallet prompt.
 *
 *  `on` is optional so every existing caller keeps the conservative behaviour
 *  unchanged; only callers that know which token on which chain can opt in. */
export function approvalPlan(
  allowance: bigint,
  needed: bigint,
  on?: { chainId: number; token: string },
): 'none' | 'direct' | 'zero-first' {
  if (needed === 0n || allowance >= needed) return 'none'
  if (allowance === 0n) return 'direct'
  return on && acceptsDirectReapprove(on.chainId, on.token) ? 'direct' : 'zero-first'
}
