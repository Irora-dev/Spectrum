import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import { deploymentFor, feeGenerationFor } from '../chain/deployments'

// ─────────────────────────────────────────────────────────────────────────────
// THE DIRECT-SWAP WRAPPER (SpectrumContracts, 2026-08-16, desk w-82…w-91) —
// the fee rail for every swap OUTSIDE the main batcher (owner: "implement into
// all buy/sell systems across portfolio and baskets to ensure fees are kept
// for stuff outside the main batcher"). It forwards opaque UniversalRouter
// calldata VERBATIM to a pinned router, measures its own balance delta against
// the floor, and charges the batcher's exact fee rule: fee/8 to the
// caller-supplied integrator, the other 7/8 to an IMMUTABLE burn sink the
// caller cannot name. Compose the same router calldata you compose today — a
// standard v4 payload works unchanged (fork-proven against the owner's own live
// PRISM buy, tx 0x83610bfa).
//
// THE CONTRACT'S OWN LAWS, mirrored here so a mismatch reverts LOUDLY instead
// of silently mis-pricing:
//  · the fee is EXCLUSIVE, charged on the input. Native input: msg.value MUST
//    equal sellAmount + fee EXACTLY or it reverts WrongNativeValue (both
//    numbers carried). The fee formula is the contract's floor division.
//  · sellToken address(0) = native input. NATIVE OUTPUT IS UNSUPPORTED this
//    generation (NativeOutputUnsupported) — a sell that would land raw ETH
//    must take WETH instead (same asset; the house unwrap-any-time line).
//  · minBuyAmount is checked on the MEASURED delta; an exact-floor fill is
//    accepted. Everything lands in msg.sender — there is NO recipient param.
//  · deadline is inclusive and capped 24h ahead. feeBps ceiling 200 inclusive.
//
// ⚠⚠ ADDRESS DISCIPLINE (Ⓡ w-385 + SpectrumContracts w-91): the 4663 and Base
// wrappers are REHEARSAL DECOYS (their burn sink is a throwaway rehearsal
// collector) — they live ONLY in the local never-commit deployments.json,
// labeled, and must never reach a shared branch or the live site. The MAINNET
// wrapper is NOT a decoy: it takes real 40 bps and burns real PRISM,
// permanently, ownerless. the owner accepted that knowingly (2026-08-16). Wiring
// reads whatever the deployments book seats — this module never hardcodes one.
//
// FIRST-SWAP CHECK owed per chain (w-91, updated for the fee-model change):
// read the FeeCharged event and verify the burn cut against THE CHAIN'S OWN
// GENERATION — gen-1 wrappers split 7:1 (burnCut == fee − fee/8, integrator
// keeps fee/8); a feeGeneration-2 chain's wrapper burns 100% (burnCut == fee,
// FeeCharged is (burnSink, burnCut), no integrator anywhere). The burn is the
// reason this contract exists; a wrapper that collected the fee and burned
// nothing would look identical on every other measure.
// ─────────────────────────────────────────────────────────────────────────────

export const directSwapWrapperAbi = parseAbi([
  'function swapWithFee(address sellToken, uint256 sellAmount, address buyToken, uint256 minBuyAmount, bytes poolData, uint16 feeBps, address feeRecipient, uint256 deadline) payable returns (uint256 bought)',
])

/** THE FEE-MODEL GENERATION-2 wrapper ABI (the production ceremony; contracts
 *  branch feature/no-integrator-100pct-burn, fork-proven buy+sell): the
 *  feeRecipient arg is GONE — 100% of the fee buys and burns PRISM — and
 *  FeeCharged is (burnSink, burnCut). Which ABI a chain speaks comes from
 *  deployments.json's feeGeneration, the same discriminant as the batcher. */
export const directSwapWrapperAbiGen2 = parseAbi([
  'function swapWithFee(address sellToken, uint256 sellAmount, address buyToken, uint256 minBuyAmount, bytes poolData, uint16 feeBps, uint256 deadline) payable returns (uint256 bought)',
])

/** The contract's inclusive feeBps ceiling — exactly 200 is accepted. */
export const WRAPPER_MAX_FEE_BPS = 200

/** THE WRAPPER'S PRODUCT RATE — 40 bps (0.4%), 100% burn, both generations
 *  (fee-model ruling 2026-08-16, docs/FEE-MODEL-100PCT-BURN-2026-08-16.md in
 *  the contracts repo). ⚠ NOT the batcher's rate: the batcher charges 25 on a
 *  feeGeneration-2 chain because 0x's own ~15 bps skim rides inside its quotes
 *  (≈40 all-in); the wrapper routes through the UniversalRouter with no
 *  aggregator in the path, so OUR fee is the whole 40. A lane that charges
 *  `batchFeeBpsFor` here undercharges by 15 bps and breaks the ruled model. */
export const WRAPPER_FEE_BPS = 40

/** The rate a wrapper lane charges on this chain. Flat across generations
 *  today; the per-chain read exists so a future generation's rate lands in
 *  ONE place (the same shape as allocation.ts's batchFeeBpsFor). */
export function wrapperFeeBpsFor(_chainId: number): number {
  return WRAPPER_FEE_BPS
}

/** The contract's inclusive deadline horizon. */
export const WRAPPER_MAX_DEADLINE_SEC = 24 * 3600

/** The wrapper seated for this chain in the deployments book, or null.
 *  Null = the lane keeps its current (fee-less) direct path — wiring never
 *  invents an address. */
export function directSwapWrapperFor(chainId: number): Address | null {
  return deploymentFor(chainId).directSwapWrapper
}

/** The contract's own fee arithmetic (floor division, EXCLUSIVE of
 *  sellAmount). Native input must send sellAmount + THIS, byte-exact. */
export function wrapperFeeRaw(sellAmount: bigint, feeBps: number): bigint {
  return (sellAmount * BigInt(feeBps)) / 10_000n
}

export interface WrapperCall {
  to: Address
  data: Hex
  /** sellAmount + fee for native input (the contract's exact-value law);
   *  0n for ERC-20 input. */
  value: bigint
  /** The fee charged on top, in the sell token's units — callers must
   *  disclose it and budget it. */
  feeRaw: bigint
}

/**
 * Build the swapWithFee call, or null when the lane must stay direct:
 * no wrapper seated on this chain · no fee recipient configured · feeBps
 * outside the contract's ceiling. Null is a lawful answer — the caller keeps
 * today's path — never a throw, so a misconfiguration can't kill the lane.
 */
export function swapWithFeeCall(args: {
  chainId: number
  /** null = native ETH input (the contract's address(0) form). */
  sellToken: Address | null
  sellAmount: bigint
  buyToken: Address
  minBuyAmount: bigint
  /** VERBATIM UniversalRouter calldata — exactly what the lane composes today. */
  poolData: Hex
  feeBps: number
  /** Gen-1's integrator sink; IGNORED on a feeGeneration-2 chain (the arg no
   *  longer exists — 100% burn). */
  feeRecipient: Address | null
  nowSec: number
  /** Seconds ahead for the wrapper's own deadline; clamped to the 24h cap. */
  deadlineAheadSec?: number
}): WrapperCall | null {
  const to = directSwapWrapperFor(args.chainId)
  if (!to) return null
  const generation = feeGenerationFor(args.chainId)
  // gen-2 has NO integrator: a missing recipient refuses nothing there (the
  // arg does not exist); gen-1 keeps its exact no-recipient-stays-direct law
  if (generation !== 2 && (!args.feeRecipient || args.feeRecipient === zeroAddress)) return null
  if (!Number.isInteger(args.feeBps) || args.feeBps < 0 || args.feeBps > WRAPPER_MAX_FEE_BPS) return null
  if (args.sellAmount <= 0n || args.minBuyAmount < 0n) return null
  const native = args.sellToken == null
  const fee = wrapperFeeRaw(args.sellAmount, args.feeBps)
  const deadline = BigInt(args.nowSec + Math.min(Math.max(args.deadlineAheadSec ?? 1200, 60), WRAPPER_MAX_DEADLINE_SEC))
  const data =
    generation === 2
      ? encodeFunctionData({
          abi: directSwapWrapperAbiGen2,
          functionName: 'swapWithFee',
          args: [
            native ? zeroAddress : (args.sellToken as Address),
            args.sellAmount,
            args.buyToken,
            args.minBuyAmount,
            args.poolData,
            args.feeBps,
            deadline,
          ],
        })
      : encodeFunctionData({
          abi: directSwapWrapperAbi,
          functionName: 'swapWithFee',
          args: [
            native ? zeroAddress : (args.sellToken as Address),
            args.sellAmount,
            args.buyToken,
            args.minBuyAmount,
            args.poolData,
            args.feeBps,
            args.feeRecipient as Address,
            deadline,
          ],
        })
  return { to, data, value: native ? args.sellAmount + fee : 0n, feeRaw: fee }
}
