import { encodeAbiParameters, keccak256, encodePacked, pad, toHex, zeroAddress } from 'viem'
import type { Address, PublicClient } from 'viem'
import { swapRouterAbi } from './abis-v2'
import { packLegMin } from './hook-data'
import type { Side } from './use-basket-swap'

// ─────────────────────────────────────────────────────────────────────────────
// swap-sim — price a buy or sell by simulating the REAL path on-chain.
//
// WHY THIS EXISTS. The FE used to derive both floors from spot/NAV, which are
// FRICTIONLESS. The chain charges for execution on BOTH sides:
//   SELL: every leg asset→ETH (that pool's fee + price impact), then the hub leg
//         ETH→settlement (fee + impact again).
//   BUY:  the hub leg settlement→ETH, then ETH→each leg — AND the mint's min-rule
//         (`min_i(acquired_i × supply / held_i)`) discards whatever imbalance the
//         acquisition leaves across legs, donating it to existing holders.
// Measured live on Robinhood 2026-07-14 (both deployed baskets):
//   sells landed ~1.8% under NAV at 1 share and −43.6% at 500/5452 shares;
//   buys landed 10–18% under the frictionless share expectation at $1, −68% at $1000.
// Floors derived from the frictionless number therefore sat ABOVE what the chain
// would pay and reverted — sells above ~5 shares, and buys at EVERY size.
//
// Deriving the floor from the SIMULATED output fixes both at any size, because the
// number being haircut is the number the chain will actually pay. It also lets the
// UI show the true cost instead of an unachievable one.
//
// METHOD. `eth_call` the router's `swapExactIn` with a 1-wei floor (and zero per-leg
// floors, which the contract permits on any non-first mint) and read the returned
// amountOut. Two paths, widest-compatibility first:
//   1. Allowance already covers the trade → simulate AS the trader with NO state
//      override (works on every RPC, including ones that reject overrides).
//   2. Otherwise → allowance-only state override, so a quote exists BEFORE approve.
// Any failure returns null and the caller degrades to the old estimate: this can
// only improve a quote, never introduce a new failure.
// ─────────────────────────────────────────────────────────────────────────────

/** OZ v5 ERC20 lays `_balances` at slot 0 and `_allowances` at slot 1; SpectrumBasket
 *  inherits ERC20 first, so those slots hold for the basket (verified live against
 *  both deployed Robinhood baskets). A settlement token with a different layout just
 *  makes the override miss ⇒ the simulate fails ⇒ we degrade to the estimate
 *  (self-validating: never silently wrong, only less precise). */
const ALLOWANCES_SLOT = 1n

function allowanceSlot(owner: Address, spender: Address): `0x${string}` {
  const inner = keccak256(encodePacked(['bytes32', 'uint256'], [pad(owner, { size: 32 }), ALLOWANCES_SLOT]))
  return keccak256(encodePacked(['bytes32', 'bytes32'], [pad(spender, { size: 32 }), inner]))
}

export interface SwapSimInput {
  side: Side
  basket: Address
  /** settlement token (the buy's tokenIn); the basket itself is the sell's tokenIn */
  settlement: Address
  router: Address
  /** tokenIn amount, raw */
  amountIn: bigint
  /** on-chain basket length — hookData legMins must be length-correct */
  legCount: number
  /** the trader */
  holder: Address
  /** true when the router's allowance for tokenIn already covers amountIn */
  allowanceCovers: boolean
  /** BUY only — the payload's per-leg funding split (bps), from `factory.bareLegMins`
   *  via mint-funding.ts. A D-R1 basket funds legs from these bits, so a probe without
   *  them acquires nothing and reverts NoOutput: the measurement then silently degrades
   *  to the frictionless estimate, which is the floor basis this module exists to
   *  replace. Absent ⇒ the pre-packing shape (plain 1-wei floors), unchanged. */
  fundingSplitBps?: readonly number[] | null
}

/** Realised tokenOut for this trade (shares on a buy, settlement on a sell), or null. */
export async function simulateSwapOut(
  client: PublicClient,
  { side, basket, settlement, router, amountIn, legCount, holder, allowanceCovers, fundingSplitBps }: SwapSimInput,
): Promise<bigint | null> {
  if (amountIn <= 0n || legCount <= 0) return null
  const tokenIn = side === 'buy' ? settlement : basket
  // A split describing a different basket would measure the wrong trade.
  const split = side === 'buy' && fundingSplitBps?.length === legCount ? fundingSplitBps : null

  // 1-wei floors BOTH aggregate and per-leg: we want the realised number, not a
  // pass/fail. Per-leg was zero here, which is legal on a non-first mint but
  // REVERTS FirstMintLegMinRequired on a first one (SpectrumBasket.sol:527,
  // proven on-chain 2026-08-02) — so on any never-bought basket this probe
  // always failed, `realisedOutRaw` came back undefined, and the caller fell
  // back to FRICTIONLESS per-leg floors that the two-hop acquisition can never
  // reach. That is the LegMinNotMet a real user hit on their first buy. 1 wei
  // is non-zero (satisfies the first-mint rule) and below any real fill, so it
  // measures reality on every basket, first mint or not.
  //
  // The SPLIT rides the same words on a D-R1 basket: a probe without it funds no leg
  // and reverts NoOutput (contracts' KitZeroSplitProbe, 2026-08-05), so the probe would
  // report "unpriceable" on every healthy basket. A leg the split funds with 0 must
  // carry NO floor — the acquire loop skips it and a floor there reverts LegMinNotMet.
  const legWords = split
    ? split.map((s) => (s === 0 ? 0n : packLegMin(s, 1n)))
    : new Array<bigint>(legCount).fill(1n)
  const hookData = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256[]' }, { type: 'address' }],
    [1n, legWords, zeroAddress],
  )
  const args = [basket, tokenIn, amountIn, 1n, hookData, holder] as const

  const attempt = async (useOverride: boolean) => {
    const { result } = await client.simulateContract({
      address: router,
      abi: swapRouterAbi,
      functionName: 'swapExactIn',
      args,
      account: holder,
      ...(useOverride
        ? {
            stateOverride: [
              {
                address: tokenIn,
                stateDiff: [
                  { slot: allowanceSlot(holder, router), value: pad(toHex(2n ** 200n), { size: 32 }) },
                ],
              },
            ],
          }
        : {}),
    })
    return result as bigint
  }

  try {
    return await attempt(!allowanceCovers)
  } catch {
    if (allowanceCovers) return null
    try {
      return await attempt(false) // RPC may reject overrides — try as-is
    } catch {
      return null
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Max-safe sizing (lab 2026-07-29) — the largest tradeable amount whose
// SIMULATED realised output stays within the slippage tolerance of the
// frictionless expectation. This turns the simulator from a silent protector
// into visible confidence: "Max safe" on the trade panel fills the input with
// the biggest size that still executes acceptably (impact-bounded), instead of
// the user bisecting by hand. Binary search over [0, cap]; each probe is one
// eth_call. Any probe failure shrinks the range (fails safe toward smaller).
// ─────────────────────────────────────────────────────────────────────────────

export interface MaxSafeInput {
  side: Side
  basket: Address
  settlement: Address
  router: Address
  legCount: number
  holder: Address
  /** Hard cap (the user's balance), raw units of the trade's tokenIn. */
  capRaw: bigint
  /** Frictionless expectation inputs — mirror the TradePanel preview math. */
  navPerToken: number
  feeFrac: number
  basketDecimals: number
  slippageBps: number
  /** BUY only — the payload's funding split (see SwapSimInput). Read ONCE for the cap
   *  and reused across the search: the split is a property of the basket's current
   *  composition, and re-reading it per probe would double an already chatty search. */
  fundingSplitBps?: readonly number[] | null
}

/** Largest amountIn ≤ capRaw whose realised output ≥ frictionless × (1 − slip).
 *  Returns 0n when even the smallest probe misses (pools too thin) or cap is 0. */
export async function findMaxSafe(client: PublicClient, input: MaxSafeInput): Promise<bigint> {
  const { side, capRaw, navPerToken, feeFrac, basketDecimals, slippageBps } = input
  if (capRaw <= 0n || !(navPerToken > 0)) return 0n
  const shareDec = Math.min(basketDecimals, 18)
  const inDec = side === 'buy' ? 6 : shareDec
  const outDec = side === 'buy' ? shareDec : 6

  const frictionlessOut = (amtRaw: bigint): bigint => {
    const amt = Number(amtRaw) / 10 ** inDec
    const out = side === 'buy' ? (amt * (1 - feeFrac)) / navPerToken : amt * navPerToken * (1 - feeFrac)
    return BigInt(Math.floor(out * 10 ** outDec))
  }
  const bps = BigInt(10_000 - slippageBps)

  const fits = async (amtRaw: bigint): Promise<boolean> => {
    if (amtRaw <= 0n) return false
    const out = await simulateSwapOut(client, {
      side,
      basket: input.basket,
      settlement: input.settlement,
      router: input.router,
      amountIn: amtRaw,
      legCount: input.legCount,
      holder: input.holder,
      allowanceCovers: false,
      fundingSplitBps: input.fundingSplitBps,
    })
    if (out == null || out <= 0n) return false
    return out >= (frictionlessOut(amtRaw) * bps) / 10_000n
  }

  // The whole balance fits → done (the common healthy-pool case, 1 probe).
  if (await fits(capRaw)) return capRaw
  let lo = 0n
  let hi = capRaw
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2n
    if (mid === lo) break
    if (await fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}
