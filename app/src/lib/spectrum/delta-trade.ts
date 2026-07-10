import { encodePacked, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import { BPS, mulDivDown, mulDivUp } from './migrate-math'

// ─────────────────────────────────────────────────────────────────────────────
// The migrate modal's DELTA TRADE: when a new version drops one constituent and
// adds another, the dropped legs are SOLD and the added legs BOUGHT with the
// proceeds, so the whole migration completes in one flow (the piece the
// never-deployed migration router would have done atomically — sequenced here).
//
// Routing is deliberately narrow and venue-independent: every trade goes
// through the canonical Uniswap V3 SwapRouter02 via the WETH hub
// (dropped → WETH, WETH → added), picking the best of the 500/3000/10000 fee
// tiers by QUOTED OUTPUT (QuoterV2 — balance-free, so the preview can quote
// before the redeem has landed). A leg with no V3/WETH pool is reported by
// name, never guessed around. Base's SwapRouter02 ships without a V2 factory,
// so V3-only keeps one code path for both chains.
// ─────────────────────────────────────────────────────────────────────────────

export const FEE_TIERS = [500, 3000, 10000] as const
/** minOut/maxIn guard around the freshly re-quoted leg (bps). */
export const DELTA_SLIPPAGE_BPS = 100n
/** Headroom on the exact-output WETH budget before falling back to exact-in. */
export const EXACT_OUT_HEADROOM_BPS = 100n

export const swapRouter02Abi = parseAbi([
  // SwapRouter02 (NOT SwapRouter01): no deadline field in the params structs.
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
  // Multihop exact-in (packed path: token·fee·token[·fee·token]) — lets a sell
  // and its buy ride ONE swap (C→WETH→D), no intermediate WETH custody.
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
  // Native batching: every delta leg in a single transaction.
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  // Unwrap the router's WETH balance to native ETH — batched after a swap whose
  // recipient was ADDRESS_THIS (the /swap page's receive-native-ETH leg).
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
])

export const quoterV2Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
])

/** Packed V3 path: token(20) · fee(3) · token(20) [· fee(3) · token(20)].
 *  tokens.length must equal fees.length + 1. */
export function encodeV3Path(tokens: Address[], fees: number[]): Hex {
  if (tokens.length !== fees.length + 1 || fees.length === 0) {
    throw new Error(`bad path shape: ${tokens.length} tokens / ${fees.length} fees`)
  }
  const types: ('address' | 'uint24')[] = ['address']
  const values: (Address | number)[] = [tokens[0]]
  for (let i = 0; i < fees.length; i++) {
    types.push('uint24', 'address')
    values.push(fees[i], tokens[i + 1])
  }
  return encodePacked(types, values)
}

/** Quote a multihop exact-in path (balance-free QuoterV2 lens). Null = no fill. */
export async function quoteExactInPath(
  client: PublicClient,
  quoter: Address,
  path: Hex,
  amountIn: bigint,
): Promise<bigint | null> {
  try {
    const { result } = await client.simulateContract({
      address: quoter,
      abi: quoterV2Abi,
      functionName: 'quoteExactInput',
      args: [path, amountIn],
    })
    return result[0]
  } catch {
    return null
  }
}

export interface TierQuote {
  fee: number
  /** exact-in: amountOut. exact-out: amountIn. */
  amount: bigint
}

/** Best fee tier by quoted OUTPUT for tokenIn→tokenOut exact-in.
 *  Returns null when no tier has a pool that can fill the trade. */
export async function bestExactInTier(
  client: PublicClient,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<TierQuote | null> {
  const quotes = await Promise.all(
    FEE_TIERS.map(async (fee): Promise<TierQuote | null> => {
      try {
        const { result } = await client.simulateContract({
          address: quoter,
          abi: quoterV2Abi,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        })
        return { fee, amount: result[0] }
      } catch {
        return null // no pool / no liquidity at this tier
      }
    }),
  )
  return quotes.filter(Boolean).reduce<TierQuote | null>(
    (best, q) => (best === null || q!.amount > best.amount ? q! : best),
    null,
  )
}

/** Best fee tier by quoted INPUT (smallest) for tokenIn→tokenOut exact-out. */
export async function bestExactOutTier(
  client: PublicClient,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountOut: bigint,
): Promise<TierQuote | null> {
  const quotes = await Promise.all(
    FEE_TIERS.map(async (fee): Promise<TierQuote | null> => {
      try {
        const { result } = await client.simulateContract({
          address: quoter,
          abi: quoterV2Abi,
          functionName: 'quoteExactOutputSingle',
          args: [{ tokenIn, tokenOut, amount: amountOut, fee, sqrtPriceLimitX96: 0n }],
        })
        return { fee, amount: result[0] }
      } catch {
        return null
      }
    }),
  )
  return quotes.filter(Boolean).reduce<TierQuote | null>(
    (best, q) => (best === null || q!.amount < best.amount ? q! : best),
    null,
  )
}

export const minOutFor = (quoted: bigint, slippageBps: bigint = DELTA_SLIPPAGE_BPS): bigint =>
  mulDivDown(quoted, BPS - slippageBps, BPS)
export const maxInFor = (quoted: bigint, slippageBps: bigint = DELTA_SLIPPAGE_BPS): bigint =>
  mulDivUp(quoted, BPS + slippageBps, BPS)

/**
 * Split the WETH pot across the added legs, proportional to their v2 target
 * weights (the only value signal that needs no extra pricing). The LAST leg
 * takes the remainder so the split always sums exactly to the pot.
 * WETH itself as an added leg takes its share with no swap.
 */
export function splitPotByWeight(pot: bigint, weightsBps: number[]): bigint[] {
  const total = weightsBps.reduce((a, w) => a + w, 0)
  if (pot <= 0n || total <= 0 || weightsBps.length === 0) return weightsBps.map(() => 0n)
  const shares = weightsBps.map((w) => mulDivDown(pot, BigInt(w), BigInt(total)))
  const assigned = shares.reduce((a, s) => a + s, 0n)
  shares[shares.length - 1] += pot - assigned
  return shares
}

/** splitPotByWeight with BIGINT weights — allocates a sold amount across the
 *  buys proportional to their WETH budgets (the rebalance delta's value signal).
 *  Last non-zero weight takes the remainder so the split sums exactly. */
export function splitAmountByBudgets(amount: bigint, budgets: bigint[]): bigint[] {
  const total = budgets.reduce((a, b) => a + b, 0n)
  if (amount <= 0n || total <= 0n || budgets.length === 0) return budgets.map(() => 0n)
  const shares = budgets.map((b) => mulDivDown(amount, b, total))
  const assigned = shares.reduce((a, s) => a + s, 0n)
  for (let i = budgets.length - 1; i >= 0; i--) {
    if (budgets[i] > 0n) {
      shares[i] += amount - assigned
      break
    }
  }
  return shares
}

// ─────────────────────────────────────────────────────────────────────────────
// Realistic per-leg buy fills — the adequacy half of the swap-mint floor.
//
// swap-quote.ts prices each constituent off its INDEPENDENT DexScreener spot
// (manipulation-resistant), but the basket doesn't buy at spot: SpectrumBasket
// `_acquireBasket` swaps USDC→ETH ONCE, then splits that ETH by weight and swaps
// ETH→each constituent — paying the real pool fee + price impact on both hops.
// A floor derived from frictionless spot is therefore UNREACHABLE for any leg
// whose pool cost exceeds the flat slippage tolerance → `LegMinNotMet` on honest
// buys. This re-prices each leg along that SAME route via V3 QuoterV2 (a close
// proxy for the basket's own venues — the amounts a fair fill actually delivers),
// so the floor sits a slippage below realistic execution, not below an ideal that
// can't happen. Manipulation protection is unchanged: the aggregate share `minOut`
// (off independent NAV) remains the binding backstop; this only relaxes the
// secondary per-leg floors to a reachable level.
// ─────────────────────────────────────────────────────────────────────────────

export interface BuyLegQuoteInput {
  asset: Address
  /** target weight, percent (0..100) */
  weightPct: number
  /** the constituent IS USDC (buffer leg: filled 1:1 by weight, no swap) */
  isUsdc: boolean
  /** independent spot-based expected amount (raw, leg decimals) — the per-leg fallback */
  spotAmount: bigint
}

/**
 * Per-leg acquired amounts (raw, on-chain basket order) for a swap-mint of `usdcNet`
 * USDC (raw 6dp), mirroring `_acquireBasket`: USDC legs fill 1:1 by weight; the rest
 * is one USDC→WETH hop split by weight into ETH→asset hops. Per-leg fallback to
 * `spotAmount` when a hop can't be quoted (never a frictionless/zero floor). Returns
 * null only when the USDC→WETH hub can't be quoted (caller keeps the spot floors).
 */
export async function quoteBuyLegFills(
  client: PublicClient,
  quoter: Address,
  usdc: Address,
  weth: Address,
  legs: BuyLegQuoteInput[],
  usdcNet: bigint,
): Promise<bigint[] | null> {
  if (usdcNet <= 0n || legs.length === 0) return null
  const usdcLow = usdc.toLowerCase()
  const wethLow = weth.toLowerCase()
  const fills = legs.map(() => 0n)

  const bufferBps = legs.map((l) => (l.isUsdc || l.asset.toLowerCase() === usdcLow ? Math.round(l.weightPct * 100) : 0))
  const totalBufferBps = bufferBps.reduce((a, b) => a + b, 0)
  legs.forEach((_, i) => {
    if (bufferBps[i] > 0) fills[i] = mulDivDown(usdcNet, BigInt(bufferBps[i]), BPS)
  })

  const nonBufferIdx = legs.map((_, i) => i).filter((i) => bufferBps[i] === 0)
  if (nonBufferIdx.length === 0) return fills

  const usdcNonBuffer = totalBufferBps > 0 ? usdcNet - mulDivDown(usdcNet, BigInt(totalBufferBps), BPS) : usdcNet
  if (usdcNonBuffer <= 0n) {
    for (const i of nonBufferIdx) fills[i] = legs[i].spotAmount
    return fills
  }

  const eth = await bestExactInTier(client, quoter, usdc, weth, usdcNonBuffer)
  if (!eth || eth.amount === 0n) return null // hub unquotable → caller keeps spot floors

  const ethShares = splitPotByWeight(eth.amount, nonBufferIdx.map((i) => Math.round(legs[i].weightPct * 100)))
  await Promise.all(
    nonBufferIdx.map(async (i, j) => {
      const share = ethShares[j]
      if (share <= 0n) {
        fills[i] = legs[i].spotAmount
        return
      }
      if (legs[i].asset.toLowerCase() === wethLow) {
        fills[i] = share
        return
      }
      const q = await bestExactInTier(client, quoter, weth, legs[i].asset, share)
      fills[i] = q && q.amount > 0n ? q.amount : legs[i].spotAmount
    }),
  )
  return fills
}
