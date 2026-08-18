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

// ─────────────────────────────────────────────────────────────────────────────
// V4 SHAPES — the generalized single-hop exact-in pair. Provenance, per shape:
//  · ERC-20-out (encodeUrV4SwapExactInSingle): the SHIPPED prism/pool.ts
//    encoder (encodePrismPoolSwap — carrying real mainnet buys since
//    2026-07-30) lifted off its pinned PRISM constants. Byte-identity to that
//    shipped encoder is pinned in universal-router.test.ts.
//  · WETH-out sell (encodeUrV4SellToWeth): FORK-PROVEN by SpectrumContracts —
//    test/fork/DirectSwapWrapperSellFork.t.sol (spectrum-contracts repo),
//    4/4 on a real mainnet fork at block 25767000; test 1 is this exact
//    shippable shape.
// ─────────────────────────────────────────────────────────────────────────────

/** UR command bytes + v4-periphery action bytes. VERIFIED — against the
 *  deployed router's Etherscan source AND a real sell tx's decoded calldata,
 *  by SpectrumContracts (test/fork/DirectSwapWrapperSellFork.t.sol in the
 *  spectrum-contracts repo) — not recalled from memory. */
export const UR_CMD_V4_SWAP = '0x10' as const
export const UR_CMD_WRAP_ETH = '0x0b' as const
export const V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06
export const V4_ACTION_SETTLE_ALL = 0x0c
export const V4_ACTION_TAKE = 0x0e
export const V4_ACTION_TAKE_ALL = 0x0f
/** ActionConstants.OPEN_DELTA — as a TAKE amount, 0 means "the whole open
 *  delta": the lawful amount when the real output is only known post-swap. */
export const V4_OPEN_DELTA = 0n

const U128_MAX = (1n << 128n) - 1n

/** A v4 PoolKey as the encoders take it (same field set the detector's
 *  hooked-market readout and prism/pool.ts's PRISM_POOL_KEY carry). */
export interface UrV4PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

const V4_POOL_KEY_ABI = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const

/** Pack action bytes into the actions `bytes` ('0x060c0f' style). */
function packV4Actions(actions: readonly number[]): Hex {
  return ('0x' + actions.map((a) => a.toString(16).padStart(2, '0')).join('')) as Hex
}

/** ExactInputSingleParams — the exact tuple layout the shipped prism encoder
 *  proved on live mainnet (uint128 amounts; the byte-identity test pins this
 *  helper to that encoder, so the two can never drift apart silently). */
function encodeV4ExactInSingleParams(
  poolKey: UrV4PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMin: bigint,
  hookData: Hex,
): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { ...V4_POOL_KEY_ABI, name: 'poolKey' },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum: amountOutMin, hookData }],
  )
}

/** uint128 range guard — the prism module's own law, kept verbatim. */
function assertU128Amounts(amountIn: bigint, amountOutMin: bigint): void {
  if (amountIn <= 0n || amountIn > U128_MAX || amountOutMin < 0n || amountOutMin > U128_MAX) {
    throw new Error('Amount out of range.')
  }
}

const NATIVE = '0x0000000000000000000000000000000000000000'

/**
 * Generalized v4 single-hop exact-in swap → COMPLETE execute() calldata for
 * the wrapper's `poolData`. This is prism/pool.ts's encodePrismPoolSwap
 * (actions 0x06 SWAP_EXACT_IN_SINGLE ‖ 0x0c SETTLE_ALL ‖ 0x0f TAKE_ALL under
 * the single 0x10 command, SETTLE_ALL(inputCurrency, amountIn),
 * TAKE_ALL(outputCurrency, minOut)) generalized over any pool key — the
 * shipped shape, pinned byte-identical in the test file.
 *
 * OUTPUT DELIVERY: TAKE_ALL credits MSG_SENDER — the address(1) sentinel,
 * which the router maps to whoever called execute(). Through the direct-swap
 * wrapper that is the WRAPPER itself, whose measured balance-delta floor
 * then binds (the wrapper's whole security model).
 *
 * NATIVE OUTPUT IS REFUSED HERE: a native-out fill (currency0 = address(0),
 * zeroForOne = false) would hand the wrapper raw ETH, which the gen-3 wrapper
 * reverts (NativeOutputUnsupported). That sell must take WETH instead — use
 * encodeUrV4SellToWeth, the fork-proven shape for exactly this case.
 *
 * `hookData` defaults '0x'. A non-empty value is the HOOKED-pool lane — e.g.
 * FWA's dynamic-fee hook takes none, but the parameter exists for hooks that
 * require data.
 *
 * `deadline` is caller-supplied unix seconds — this module stays pure (no
 * Date.now() here; the prism module derives its own, which is why the
 * byte-identity test pins the clock).
 */
export function encodeUrV4SwapExactInSingle(args: {
  poolKey: UrV4PoolKey
  zeroForOne: boolean
  amountIn: bigint
  amountOutMin: bigint
  hookData?: Hex
  deadline: number
}): Hex {
  assertU128Amounts(args.amountIn, args.amountOutMin)
  const inputCurrency = args.zeroForOne ? args.poolKey.currency0 : args.poolKey.currency1
  const outputCurrency = args.zeroForOne ? args.poolKey.currency1 : args.poolKey.currency0
  if (outputCurrency.toLowerCase() === NATIVE) {
    throw new Error(
      'Native output is unsupported by this shape (the wrapper reverts NativeOutputUnsupported) — use encodeUrV4SellToWeth for a WETH-out sell.',
    )
  }
  const swapParams = encodeV4ExactInSingleParams(
    args.poolKey,
    args.zeroForOne,
    args.amountIn,
    args.amountOutMin,
    args.hookData ?? '0x',
  )
  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [inputCurrency, args.amountIn],
  )
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [outputCurrency, args.amountOutMin],
  )
  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [packV4Actions([V4_ACTION_SWAP_EXACT_IN_SINGLE, V4_ACTION_SETTLE_ALL, V4_ACTION_TAKE_ALL]), [swapParams, settleParams, takeParams]],
  )
  return encodeFunctionData({
    abi: urExecuteAbi,
    functionName: 'execute',
    args: [concatHex([UR_CMD_V4_SWAP]), [v4Input], BigInt(args.deadline)],
  })
}

/**
 * THE FORK-PROVEN WETH-OUT SELL SHAPE — SpectrumContracts,
 * test/fork/DirectSwapWrapperSellFork.t.sol (spectrum-contracts repo), 4/4 on
 * a real mainnet fork at block 25767000; test 1 is this exact shippable
 * shape. Sells `currency1` into a native-ETH pool (zeroForOne = false) and
 * delivers WETH to the wrapper:
 *
 *   commands = 0x10 ‖ 0x0b            (V4_SWAP, then WRAP_ETH)
 *   v4 actions = 0x06 ‖ 0x0c ‖ 0x0e   (SWAP_EXACT_IN_SINGLE, SETTLE_ALL,
 *                                      TAKE — TAKE, not TAKE_ALL)
 *   TAKE(native, ADDRESS_THIS, OPEN_DELTA) leaves the native output ON THE
 *   ROUTER; WRAP_ETH(MSG_SENDER, CONTRACT_BALANCE) then wraps the router's
 *   WHOLE balance and delivers the WETH to the wrapper, whose measured
 *   balance-delta floor binds.
 *
 * ⚠⚠ THE ONE WORD THAT MUST NEVER REGRESS: WRAP_ETH's amount is an EXACT
 * amount, NOT a floor. Passing minOut there instead of the CONTRACT_BALANCE
 * sentinel strands realOutput − minOut as native ETH on the router — where
 * ANY stranger's SWEEP command takes it (DirectSwapWrapperSellFork.t.sol
 * test 2 makes that theft executable on the fork; that run is why w-0's
 * first sell shape was scrapped, 2026-08-16). CONTRACT_BALANCE is the ONLY
 * lawful WRAP_ETH amount here.
 */
export function encodeUrV4SellToWeth(args: {
  poolKey: UrV4PoolKey
  amountIn: bigint
  amountOutMin: bigint
  hookData?: Hex
  deadline: number
}): Hex {
  if (args.poolKey.currency0.toLowerCase() !== NATIVE) {
    throw new Error('encodeUrV4SellToWeth needs a native-ETH pool (currency0 = address(0)).')
  }
  assertU128Amounts(args.amountIn, args.amountOutMin)
  // The slippage floor rides in the SWAP params (amountOutMinimum) — enforced
  // by the pool fill itself, so it never needs restating at the wrap step.
  const swapParams = encodeV4ExactInSingleParams(
    args.poolKey,
    false, // selling currency1 for native currency0
    args.amountIn,
    args.amountOutMin,
    args.hookData ?? '0x',
  )
  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [args.poolKey.currency1, args.amountIn],
  )
  // TAKE (0x0e), not TAKE_ALL: recipient ADDRESS_THIS keeps the native output
  // on the router for the wrap step; OPEN_DELTA (0) = the full open delta.
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [args.poolKey.currency0, UR_ADDRESS_THIS, V4_OPEN_DELTA],
  )
  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [packV4Actions([V4_ACTION_SWAP_EXACT_IN_SINGLE, V4_ACTION_SETTLE_ALL, V4_ACTION_TAKE]), [swapParams, settleParams, takeParams]],
  )
  // ⚠ CONTRACT_BALANCE, exactly — see the block comment above for why any
  // other word here is an executable donation (fork test 2).
  const wrapInput = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [UR_MSG_SENDER, UR_CONTRACT_BALANCE],
  )
  return encodeFunctionData({
    abi: urExecuteAbi,
    functionName: 'execute',
    args: [concatHex([UR_CMD_V4_SWAP, UR_CMD_WRAP_ETH]), [v4Input, wrapInput], BigInt(args.deadline)],
  })
}
