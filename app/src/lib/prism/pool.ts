import { concatHex, encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import { deploymentFor } from '../chain/deployments'
import { PRISM_CLAIM_CHAIN_ID, PRISM_V2_HOOK } from './claim'

// ─────────────────────────────────────────────────────────────────────────────
// The {ETH, PRISM v2} v4 pool, driven DIRECTLY (quote = canonical V4Quoter,
// fill = canonical Universal Router). Built 2026-07-30 when the routing
// service dropped coverage of the day-old pool mid-evening (it routed at
// 16:00, "no available quotes" by 20:30) — aggregator coverage of a young
// hook pool is transient, the pool itself is fine: the owner's original call
// ("it's a uni v4 hook so maybe needs a router") was right. TradePrism uses
// this as the FALLBACK when the aggregator has no route (and the aggregator
// stays primary — it can split across venues when it does work).
//
// Pool identity (verified on-chain: quoteExactInputSingle answered 0.1 ETH →
// 4.305 PRISM against these exact params): native ETH is currency0, the PRISM
// hook token is currency1 AND its own hook, fee 10000 (1%), tickSpacing 200 —
// the same constants the burner read-back pinned. Buy = zeroForOne.
// ─────────────────────────────────────────────────────────────────────────────

export const PRISM_POOL_KEY = {
  currency0: '0x0000000000000000000000000000000000000000' as Address, // native ETH
  currency1: PRISM_V2_HOOK,
  fee: 10_000,
  tickSpacing: 200,
  hooks: PRISM_V2_HOOK,
} as const

/** Canonical Permit2 (same address on every chain) — the Universal Router
 *  pulls ERC-20 input through it, so a SELL needs the two-step allowance:
 *  PRISM → Permit2 (ERC-20 approve), then Permit2 → router (permit2.approve). */
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

export const permit2Abi = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

// Declared `view` so viem lets a plain read drive it — the quoter is
// stateMutability-nonpayable in the real ABI but is designed for eth_call
// (the same trick delta-trade.ts uses on the v3 QuoterV2 via simulateContract).
const v4QuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) view returns (uint256 amountOut, uint256 gasEstimate)',
])

const urAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])

// Universal Router command + v4-periphery action bytes (vendored
// lib/v4-periphery/src/libraries/Actions.sol; UR Commands.sol V4_SWAP = 0x10).
const CMD_V4_SWAP = '0x10' as const
const ACTIONS = '0x060c0f' as const // SWAP_EXACT_IN_SINGLE · SETTLE_ALL · TAKE_ALL

const POOL_KEY_ABI = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const

const U128_MAX = (1n << 128n) - 1n

export type PoolDir = 'buy' | 'sell'

/** Quote the pool directly. Returns the raw out amount (18dp both ways). */
export async function quotePrismPool(client: PublicClient, dir: PoolDir, amountIn: bigint): Promise<bigint> {
  const quoter = deploymentFor(PRISM_CLAIM_CHAIN_ID).v4Quoter
  if (!quoter) throw new Error('No v4 quoter configured for Ethereum.')
  if (amountIn <= 0n || amountIn > U128_MAX) throw new Error('Amount out of range.')
  const [amountOut] = await client.readContract({
    address: quoter,
    abi: v4QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        poolKey: PRISM_POOL_KEY,
        zeroForOne: dir === 'buy',
        exactAmount: amountIn,
        hookData: '0x',
      },
    ],
  })
  return amountOut
}

/** The Universal Router execute() call for an exact-in swap against the PRISM
 *  pool, minOut ENFORCED ON-CHAIN (the same floor guarantee the aggregator
 *  path gives). Buy sends ETH as tx value; sell settles PRISM via Permit2. */
export function encodePrismPoolSwap(dir: PoolDir, amountIn: bigint, minOut: bigint): { to: Address; data: Hex; value: bigint } {
  const router = deploymentFor(PRISM_CLAIM_CHAIN_ID).universalRouter
  if (!router) throw new Error('No Universal Router configured for Ethereum.')
  if (amountIn <= 0n || amountIn > U128_MAX || minOut < 0n || minOut > U128_MAX) throw new Error('Amount out of range.')
  const zeroForOne = dir === 'buy'
  const inputCurrency = zeroForOne ? PRISM_POOL_KEY.currency0 : PRISM_POOL_KEY.currency1
  const outputCurrency = zeroForOne ? PRISM_POOL_KEY.currency1 : PRISM_POOL_KEY.currency0

  const swapParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { ...POOL_KEY_ABI, name: 'poolKey' },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [{ poolKey: PRISM_POOL_KEY, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x' }],
  )
  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [inputCurrency, amountIn],
  )
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [outputCurrency, minOut],
  )
  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [ACTIONS, [swapParams, settleParams, takeParams]],
  )
  const data = encodeFunctionData({
    abi: urAbi,
    functionName: 'execute',
    args: [concatHex([CMD_V4_SWAP]), [v4Input], BigInt(Math.floor(Date.now() / 1000) + 1200)],
  })
  return { to: router, data, value: zeroForOne ? amountIn : 0n }
}

export function universalRouterAddress(): Address | null {
  return deploymentFor(PRISM_CLAIM_CHAIN_ID).universalRouter ?? null
}
