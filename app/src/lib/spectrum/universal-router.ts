import { concatHex, encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL ROUTER PAYLOADS for the direct-swap wrapper — the encoder the
// carved lanes hand to `swapWithFee`'s `poolData` (forwarded VERBATIM to the
// pinned router; direct-swap-wrapper.ts owns the fee/value laws).
//
// WHY THIS EXISTS (owner 2026-08-16, greenlighting the LNOC migration): 0x
// refuses batcher-composed swaps on the thin-market class (the LNOC saga —
// six dead theories, then measured: the same pool fills a user-taker at
// every size). The wrapper removes 0x from the path entirely; what remains
// is composing the router's own commands, which this module does.
//
// ⚠⚠ EVERY SHAPE HERE IS PROVEN BEFORE IT CARRIES MONEY — the standing law
// after SpectrumContracts' fork run made my first sell shape's slippage
// donation EXECUTABLE (w-0, 2026-08-16: WRAP_ETH's amount is EXACT, not a
// floor; the difference strands on the router for any stranger to sweep).
// The v3 exact-in buy shape below was proven by eth_simulateV1 against live
// 4663 (approve + swapWithFee from the owner's own wallet) before the carve
// wired it. Do not add a shape without its proof.
//
// CONSTANTS — verified by SpectrumContracts against v4-periphery/UR source
// (w-93), not recalled: MSG_SENDER = address(1) maps to whoever called
// execute() (the WRAPPER, so the measured delta works); ADDRESS_THIS =
// address(2) is the router itself; CONTRACT_BALANCE (high-bit sentinel)
// means "the router's whole balance" — the ONLY lawful WRAP_ETH amount.
// ─────────────────────────────────────────────────────────────────────────────

export const UR_MSG_SENDER = '0x0000000000000000000000000000000000000001' as Address
export const UR_ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as Address
export const UR_CONTRACT_BALANCE = (1n << 255n) as bigint

/** UR command bytes (Commands.sol). */
export const UR_CMD_V3_SWAP_EXACT_IN = '0x00' as const

const urExecuteAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])

/** Pack a v3 path: token(20) ‖ fee(3) ‖ token(20) [‖ fee(3) ‖ token(20) …].
 *  `fees[i]` is the pool fee between tokens[i] and tokens[i+1]. */
export function packV3Path(tokens: readonly Address[], fees: readonly number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw new Error('malformed v3 path')
  let out = tokens[0].toLowerCase() as string
  for (let i = 0; i < fees.length; i++) {
    const fee = fees[i]
    if (!Number.isInteger(fee) || fee < 0 || fee > 0xffffff) throw new Error('malformed v3 fee')
    out += fee.toString(16).padStart(6, '0')
    out += tokens[i + 1].slice(2).toLowerCase()
  }
  return out as Hex
}

/**
 * A V3 exact-in swap through the Universal Router, shaped for the WRAPPER as
 * caller: recipient is the MSG_SENDER sentinel (= the wrapper, whose measured
 * delta is the floor check), payerIsUser true (the router pulls the input
 * from the wrapper via Permit2 — the wrapper's own exact approve enables it).
 * Returns the COMPLETE execute() calldata for `poolData`.
 */
export function encodeUrV3SwapExactIn(args: {
  path: Hex
  amountIn: bigint
  /** The same floor passed to swapWithFee — the wrapper's measured floor is
   *  the binding one; carrying it here too just fails faster. */
  amountOutMin: bigint
  /** Unix seconds; the router's own deadline. */
  deadline: number
  /** ⚠ THE 4663 UR IS A CUSTOM BUILD (SpectrumContracts, proven on live 4663
   *  from the router's own verified source, 2026-08-16): its V3_SWAP_EXACT_IN
   *  takes SIX inputs — a trailing `uint256[] minHopPriceX36` per-hop price
   *  guard. A 5-field encode has no word at index 5, the Dispatcher's
   *  toUint256Array(5) runs off the end, and the whole execute reverts
   *  SliceOutOfBounds (0x3b99b53d) — the exact revert that blocked the LNOC
   *  carve. An EMPTY array DISABLES the guard (length==0 skips the check and
   *  amountOutMin binds alone), proven: the 6-field encode parses clean and
   *  reaches the swap. Pass true on 4663; mainnet/Base keep the canonical
   *  5-field shape. To USE the guard, pass one X36 min-price per hop instead
   *  (length must equal (path.length−20)/23). */
  sixField?: boolean
}): Hex {
  if (args.amountIn <= 0n || args.amountOutMin < 0n) throw new Error('malformed v3 amounts')
  const input = args.sixField
    ? encodeAbiParameters(
        [
          { type: 'address' }, // recipient
          { type: 'uint256' }, // amountIn
          { type: 'uint256' }, // amountOutMinimum
          { type: 'bytes' }, // path
          { type: 'bool' }, // payerIsUser
          { type: 'uint256[]' }, // minHopPriceX36 — empty disables the guard
        ],
        [UR_MSG_SENDER, args.amountIn, args.amountOutMin, args.path, true, []],
      )
    : encodeAbiParameters(
        [
          { type: 'address' }, // recipient
          { type: 'uint256' }, // amountIn
          { type: 'uint256' }, // amountOutMinimum
          { type: 'bytes' }, // path
          { type: 'bool' }, // payerIsUser
        ],
        [UR_MSG_SENDER, args.amountIn, args.amountOutMin, args.path, true],
      )
  return encodeFunctionData({
    abi: urExecuteAbi,
    functionName: 'execute',
    args: [concatHex([UR_CMD_V3_SWAP_EXACT_IN]), [input], BigInt(args.deadline)],
  })
}

/** Does this chain's Universal Router speak the six-field V3_SWAP_EXACT_IN?
 *  4663's custom build does (see `sixField` above); the canonical deploys on
 *  1/8453 do not. A chain-shape fact, so it lives beside the encoder. */
export function urUsesSixFieldV3(chainId: number): boolean {
  return chainId === 4663
}
