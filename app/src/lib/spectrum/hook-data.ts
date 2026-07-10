import { encodeAbiParameters, zeroAddress, type Address, type Hex } from 'viem'
import { INTERFACE_TAG_ADDRESS } from '../config/operator'

// ─────────────────────────────────────────────────────────────────────────────
// The SINGLE hookData encoder for every transactional path.
// V2 contracts hard-revert on empty hookData; per-leg minimums (legMins)
// are the primary first-mint per-leg floor.
//
// SECURITY INVARIANT — no silent zero path, EVER:
//   • legMins are always derived from the live per-leg quote at sign time.
//   • There is no code path that encodes zero, empty, or placeholder legMins —
//     not for the first mint, not behind any "disable slippage protection"
//     toggle (none exists), not as a fallback. Callers without live quotes
//     cannot encode; encodeMintHookData throws instead of degrading.
// Do not add a bypass. The contract reverting on empty hookData is the backstop;
// the FE must never invite that revert nor work around it.
//
// DRAFT layout (bind to the contracts deliverable): abi.encode(
//   uint256 minOut, uint256[] legMins, address frontend )
// The `frontend` slot is the interface-kickback tag: address(0) = no tag
// → the kickback slice follows the creator's routing.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SLIPPAGE_BPS = 100 // 1%
export const MAX_SLIPPAGE_BPS = 500 // hard UI cap: 5%
export const WARN_SLIPPAGE_BPS = 200 // entries above 2% warn in the UI

const BPS = 10_000n

export interface MintHookDataInput {
  /** Live per-leg quoted amounts (raw units), exactly as quoted at sign time. */
  quotedLegAmounts: bigint[]
  /** Slippage tolerance in bps, 1..MAX_SLIPPAGE_BPS. */
  slippageBps: number
  /** Aggregate minimum out (raw units), already slippage-adjusted by the caller. */
  minOut: bigint
  /** Interface-kickback tag override; defaults to the operator env config. */
  interfaceTag?: Address | null
}

export interface EncodedHookData {
  hookData: Hex
  /** The per-leg minimums actually encoded — surface these in the review step. */
  legMins: bigint[]
  minOut: bigint
  frontend: Address
}

export function clampSlippageBps(bps: number): number {
  if (!Number.isFinite(bps)) return DEFAULT_SLIPPAGE_BPS
  return Math.min(Math.max(Math.round(bps), 1), MAX_SLIPPAGE_BPS)
}

/** legMins[i] = quotedLeg[i] × (1 − slippageBps/10000), floor-rounded. */
export function deriveLegMins(quotedLegAmounts: bigint[], slippageBps: number): bigint[] {
  const s = BigInt(clampSlippageBps(slippageBps))
  return quotedLegAmounts.map((q) => (q * (BPS - s)) / BPS)
}

export function encodeMintHookData(input: MintHookDataInput): EncodedHookData {
  const { quotedLegAmounts, minOut } = input
  if (quotedLegAmounts.length === 0) {
    throw new Error('hook-data: refusing to encode without live per-leg quotes (no zero/empty legMins path exists).')
  }
  if (quotedLegAmounts.some((q) => q <= 0n)) {
    throw new Error('hook-data: every leg must have a positive live quote at sign time.')
  }
  const slippageBps = clampSlippageBps(input.slippageBps)
  const legMins = deriveLegMins(quotedLegAmounts, slippageBps)
  if (legMins.some((m) => m <= 0n)) {
    // A floor-rounded zero min would silently disable the per-leg protection.
    throw new Error('hook-data: a derived leg minimum rounded to zero — quote too small to protect; aborting.')
  }
  const frontend = (input.interfaceTag ?? INTERFACE_TAG_ADDRESS ?? zeroAddress) as Address
  const hookData = encodeAbiParameters(
    [
      { name: 'minOut', type: 'uint256' },
      { name: 'legMins', type: 'uint256[]' },
      { name: 'frontend', type: 'address' },
    ],
    [minOut, legMins, frontend],
  )
  return { hookData, legMins, minOut, frontend }
}

export interface RedeemHookDataInput {
  /** Number of legs = the on-chain basket length (the per-leg array is zero-filled). */
  legCount: number
  /** Aggregate minimum USDC out (raw) — the BINDING sell protection. */
  minOut: bigint
  interfaceTag?: Address | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Redeem (sell) hookData — DIFFERENT protection model from mint.
//
// On a sell, the binding protection is the AGGREGATE USDC `minOut`: SpectrumBasket
// `_sellFlow` reverts `SlippageExceeded` when the realized USDC is below it, and the
// swap router backstops the same floor. The per-leg `legMins` consumed by `_unwindToUsdc`
// are OPTIONAL there and ETH/USDC-denominated (NOT constituent-token counts like the mint
// path) — the FE does not reconstruct those units, so it ships length-correct ZERO per-leg
// floors. The hook accepts this: `BadLegMinsLength` is a LENGTH check, and zero values
// simply skip the per-leg guard.
//
// This is NOT a violation of the mint-path "no silent zero" invariant (that is the
// first-mint per-leg-floor invariant, which is mint-only). A sell is protected by the aggregate
// `minOut` it commits here — which this function REQUIRES to be non-zero.
// ─────────────────────────────────────────────────────────────────────────────
export function encodeRedeemHookData(input: RedeemHookDataInput): EncodedHookData {
  if (!Number.isInteger(input.legCount) || input.legCount <= 0) {
    throw new Error('hook-data: redeem requires a positive on-chain leg count.')
  }
  if (input.minOut <= 0n) {
    // The aggregate minOut IS the sell protection — never ship an unprotected sell.
    throw new Error('hook-data: redeem requires a positive aggregate minOut (the binding sell floor).')
  }
  const legMins = new Array<bigint>(input.legCount).fill(0n)
  const frontend = (input.interfaceTag ?? INTERFACE_TAG_ADDRESS ?? zeroAddress) as Address
  const hookData = encodeAbiParameters(
    [
      { name: 'minOut', type: 'uint256' },
      { name: 'legMins', type: 'uint256[]' },
      { name: 'frontend', type: 'address' },
    ],
    [input.minOut, legMins, frontend],
  )
  return { hookData, legMins, minOut: input.minOut, frontend }
}
