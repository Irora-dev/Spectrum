import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { erc20ApproveAbi } from './abis-v2'
import { chainCfg } from '../chain/chains'
import { deploymentFor } from '../chain/deployments'
import { clientFor } from '../chain/rpc'
import { findBestPool, hookedMarketDominates } from '../pools'
import { v3FactoryAbi } from '../pools/abis'
import { Venue } from '../pools/types'
import {
  directSwapWrapperAbiGen2,
  directSwapWrapperFor,
  swapWithFeeCall,
  wrapperFeeBpsFor,
  wrapperFeeRaw,
  type WrapperCall,
} from './direct-swap-wrapper'
import {
  encodeUrV3SwapExactIn,
  encodeUrV4SwapExactInSingle,
  packV3Path,
  urUsesSixFieldV3,
  type UrV4PoolKey,
} from './universal-router'

// ─────────────────────────────────────────────────────────────────────────────
// THE DIRECT-SWAP LANE — one module that turns "this asset, this direction,
// this chain" into a fee-charging SpectrumDirectSwapWrapper call, for every
// swap the batcher cannot carry (the owner's order, 2026-08-16/17: one fee
// rule everywhere; the wrapper contract's own header names the carve as the
// planned remedy for the whole 0x-refusing class).
//
// WHAT RIDES THIS LANE:
//   · the LNOC class — 0x quotes the asset but refuses batcher-composed swaps
//     at size (the taker ceiling, Settler 0x46a14930) while the same pool
//     fills a user-taker at every size. Route: v3, settlement-funded, the
//     exact path the carve proof ran (USDG → hub → WETH → tier → asset).
//   · the FWA class — the token's REAL market is a hooked v4 pool 0x cannot
//     route at all. Route: the hooked pool itself, native-funded (the
//     TradePrism/PRISM-carve shape, generalized; hooked pools are lawful HERE
//     because this is a single wallet swap — the basket-leg rejection is the
//     contract's law, not this lane's).
//   · runner sales whose route ends in settlement (v3 path or a
//     settlement-paired v4 pool) — the sale step's wrapper lane, so sells pay
//     the product fee too (feeless today, PrismBeat's measured finding).
//
// THE LAWS, inherited whole:
//   · fee = wrapperFeeBpsFor (40 bps, 100% burn on a feeGeneration-2 chain) —
//     NEVER batchFeeBpsFor: the batcher's 25 assumes 0x's own ~15 inside the
//     quote, and there is no 0x on this lane.
//   · the ERC-20 pull is sellAmount + fee, so THE APPROVAL IS sellAmount + fee
//     (the contract reverts FeeOnTransferSellToken on any shortfall); native
//     input sends value = sellAmount + fee EXACTLY (WrongNativeValue law).
//   · THE QUOTE IS THE SIMULATION (S1's shape): the probe eth_calls the REAL
//     wrapper with the REAL bytes and minBuy=1, the floor haircuts the probe's
//     measured output, and the floored bytes are eth_call-proven AGAIN before
//     anything signs. The bytes proven are the bytes returned — callers sign
//     them verbatim (verified-bytes discipline is the caller's half).
//   · READ-FAILED REFUSES: no route, no quote, an unparseable return — the
//     lane answers null/refusal and the caller keeps its aggregator path. A
//     lane that guessed would be composing floors off an error.
//   · every UR shape here is proven before it carries money: the v3 six-field
//     shape on live 4663 (the carve proof), the v4 single-hop buy on live
//     mainnet (the owner's own PRISM buy through the wrapper, fork-replayed by
//     SpectrumContracts), the v4 WETH-out sell on a mainnet fork (their
//     DirectSwapWrapperSellFork.t.sol, 4/4). No shape ships without its proof.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectDirection = 'buy' | 'sell'

export interface DirectRouteV3 {
  kind: 'v3'
  /** Packed path in TRADE direction (buy: settlement→…→asset; sell: mirror). */
  path: Hex
  sixField: boolean
  /** settlement↔WETH hop tier (measured by the probe below, never assumed). */
  hubFee: number
  /** asset↔WETH pool tier, from the detector's chosen candidate. */
  assetFee: number
}

export interface DirectRouteV4 {
  kind: 'v4'
  poolKey: UrV4PoolKey
  zeroForOne: boolean
  /** True when this is the token's hooked market (the FWA class) — the
   *  surface says so in words; hooks can price dynamically. */
  hooked: boolean
}

export interface DirectRoute {
  chainId: number
  asset: Address
  assetDecimals: number
  direction: DirectDirection
  /** What the wallet PAYS on a buy / RECEIVES on a sell. 'settlement' routes
   *  fund from (or land in) the chain's settlement token; 'native' routes are
   *  the ETH-paired v4 shape — buys fund from native ETH, and a NATIVE-out
   *  sell cannot land settlement, so runner sales must not take one (the
   *  wrapper itself refuses native out; WETH-out is TradePrism's lane, not
   *  this module's). */
  counter: 'settlement' | 'native'
  route: DirectRouteV3 | DirectRouteV4
  /** Depth context for the surface's honesty line (null = unindexed). */
  depthUsd: number | null
}

export type DirectRouteAnswer =
  | { ok: true; route: DirectRoute }
  | { ok: false; reason: string }

const v3PoolLiquidityAbi = parseAbi(['function liquidity() view returns (uint128)'])

/** The v4 quoter speaks eth_call despite its nonpayable ABI — the same trick
 *  prism/pool.ts pins; declared view so viem serves it as a read. Used only
 *  by the restricted-token degrade, which has no wrapper return to parse. */
const v4QuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) view returns (uint256 amountOut, uint256 gasEstimate)',
])

/** Standard v3 tiers, deepest-liquidity-wins, for the settlement↔WETH hop.
 *  MEASURED per call rather than pinned: the 4663 hub rode 100 (0.01%) on the
 *  carve proof, but a constant here would be the exact "money constant whose
 *  basis rots in a comment" class this repo has been burned by twice. */
const HUB_TIERS = [100, 500, 3000, 10000] as const

async function deepestHubTier(client: PublicClient, chainId: number): Promise<number | null> {
  const cfg = chainCfg(chainId)
  const settlement = deploymentFor(chainId).usdc
  if (!cfg.uniV3Factory || !cfg.weth || !settlement) return null
  const reads = await Promise.all(
    HUB_TIERS.map(async (fee) => {
      try {
        const pool = (await client.readContract({
          address: cfg.uniV3Factory as Address,
          abi: v3FactoryAbi,
          functionName: 'getPool',
          args: [settlement as Address, cfg.weth as Address, fee],
        })) as Address
        if (!pool || pool === zeroAddress) return { fee, liquidity: 0n }
        const liquidity = (await client.readContract({ address: pool, abi: v3PoolLiquidityAbi, functionName: 'liquidity' })) as bigint
        return { fee, liquidity }
      } catch {
        return { fee, liquidity: -1n } // read failed ≠ empty — see below
      }
    }),
  )
  // A failed read may hide the deepest hop, and ranking around it would route
  // the swap through whatever survived (the MOG-class mis-route) — any
  // failure refuses the v3 route whole; the caller degrades or retries.
  if (reads.some((r) => r.liquidity === -1n)) return null
  const best = [...reads].sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0))[0]
  return best && best.liquidity > 0n ? best.fee : null
}

/**
 * Decide the route a wrapper swap of `asset` would ride, or the sentence for
 * why none exists. Pure discovery — nothing here signs or quotes.
 *
 * Venue choice mirrors the detector's own ranking with ONE deliberate
 * inversion: when the token's hooked market DOMINATES its best routable pool
 * (hookedMarketDominates — the FWA class), the hooked pool IS the route. The
 * detector refuses it for basket legs because the CONTRACT rejects hooks;
 * this lane is a plain wallet swap through the UniversalRouter, which is
 * exactly how the owner's own live PRISM buys execute.
 */
export async function discoverDirectRoute(
  chainId: number,
  asset: Address,
  direction: DirectDirection,
): Promise<DirectRouteAnswer> {
  const wrapper = directSwapWrapperFor(chainId)
  if (!wrapper) return { ok: false, reason: 'No direct-swap wrapper is deployed on this network yet.' }
  let best
  try {
    best = await findBestPool(asset, chainId)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  const cfg = chainCfg(chainId)
  const settlement = deploymentFor(chainId).usdc
  const client = clientOf(chainId)

  // The hooked market wins when it dominates — the token's REAL venue.
  const deepestHooked = best.hookedMarket?.deepest ?? null
  if (deepestHooked && hookedMarketDominates(best.hookedMarket?.hookedDepthEth ?? 0, best.best.depthEth)) {
    const poolKey: UrV4PoolKey = {
      currency0: deepestHooked.currency0,
      currency1: deepestHooked.currency1,
      fee: deepestHooked.fee,
      tickSpacing: deepestHooked.tickSpacing,
      hooks: deepestHooked.hooks,
    }
    // ETH-paired by scan construction (currency0 = native zero address):
    // buys spend native (zeroForOne true), sells produce native — which the
    // wrapper cannot deliver, so a runner sale refuses here by `counter`.
    const zeroForOne = direction === 'buy'
    return {
      ok: true,
      route: {
        chainId,
        asset,
        assetDecimals: best.decimals,
        direction,
        counter: 'native',
        route: { kind: 'v4', poolKey, zeroForOne, hooked: true },
        depthUsd: best.best.depthUsd ?? null,
      },
    }
  }

  const venue = best.route.venue
  if (venue === Venue.V3) {
    if (!settlement || !cfg.weth) return { ok: false, reason: 'This network has no settlement/WETH configured for a routed swap.' }
    if (!client) return { ok: false, reason: 'We have no connection to this network.' }
    const hubFee = await deepestHubTier(client, chainId)
    if (hubFee == null)
      return { ok: false, reason: 'The settlement↔WETH hop could not be measured just now, so this route cannot be priced. Try again.' }
    const assetFee = best.route.v3Fee
    const tokens: readonly Address[] =
      direction === 'buy'
        ? [settlement as Address, cfg.weth as Address, asset]
        : [asset, cfg.weth as Address, settlement as Address]
    const fees = direction === 'buy' ? [hubFee, assetFee] : [assetFee, hubFee]
    return {
      ok: true,
      route: {
        chainId,
        asset,
        assetDecimals: best.decimals,
        direction,
        counter: 'settlement',
        route: { kind: 'v3', path: packV3Path(tokens, fees), sixField: urUsesSixFieldV3(chainId), hubFee, assetFee },
        depthUsd: best.best.depthUsd ?? null,
      },
    }
  }
  if (venue === Venue.V4Q) {
    // Settlement-paired hookless v4 — single hop, ERC-20 both sides. The key
    // rides the detector's own struct (its ethPool slot carries the
    // settlement-paired key on a V4Q route, per its own comment).
    const k = best.route.ethPool
    const poolKey: UrV4PoolKey = { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks }
    if (!settlement) return { ok: false, reason: 'This network has no settlement token configured.' }
    const settlementIs0 = poolKey.currency0.toLowerCase() === (settlement as Address).toLowerCase()
    const zeroForOne = direction === 'buy' ? settlementIs0 : !settlementIs0
    return {
      ok: true,
      route: {
        chainId,
        asset,
        assetDecimals: best.decimals,
        direction,
        counter: 'settlement',
        route: { kind: 'v4', poolKey, zeroForOne, hooked: false },
        depthUsd: best.best.depthUsd ?? null,
      },
    }
  }
  if (venue === Venue.V4) {
    // ETH-paired hookless v4 (native one side) — same shape as the hooked
    // route minus the hook honesty line.
    const k = best.route.ethPool
    const poolKey: UrV4PoolKey = { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks }
    return {
      ok: true,
      route: {
        chainId,
        asset,
        assetDecimals: best.decimals,
        direction,
        counter: 'native',
        route: { kind: 'v4', poolKey, zeroForOne: direction === 'buy', hooked: false },
        depthUsd: best.best.depthUsd ?? null,
      },
    }
  }
  return { ok: false, reason: 'This asset routes only through a Uniswap V2 pair, which this lane cannot carry.' }
}

function clientOf(chainId: number): PublicClient | null {
  try {
    return clientFor(chainId) as PublicClient
  } catch {
    return null
  }
}

export interface ComposedDirectSwap {
  /** The EXACT call to sign — the same bytes the proof call validated. */
  call: WrapperCall
  /** The probe's measured output (minBuy=1 eth_call of the real wrapper). */
  probedOutRaw: bigint
  /** The floor the signed bytes enforce (measured × (10000 − slippage)). */
  minBuyRaw: bigint
  feeBps: number
  /** Fee in sell-token units — the pull is sellAmount + THIS. */
  feeRaw: bigint
  /** ERC-20 routes: the exact approval swapWithFee's pull needs (sellAmount +
   *  fee, to the WRAPPER). Native routes: null. */
  approval: { token: Address; spender: Address; amountRaw: bigint } | null
  /** What the surface must show — the displayed-vs-signed tuple. */
  shown: { feeBps: number; minBuyRaw: bigint; wrapper: Address }
  /** THE RESTRICTED-TOKEN DEGRADE (measured on FWA, 2026-08-17): some
   *  hook-launched tokens refuse transfers to arbitrary contracts, so the
   *  TAKE to the wrapper reverts while the SAME payload straight to the
   *  router (recipient = the user) fills fine — the token's own immutable
   *  law, not a routing defect. When the wrapper probe reverts but the
   *  direct-router probe proves, the lane returns the DIRECT call: feeless
   *  (the token refuses our turnstile — disclosed, never silent), floor
   *  still enforced ON-CHAIN by the router's own amountOutMinimum. */
  feeless?: boolean
}

export type ComposedDirectAnswer =
  | { ok: true; swap: ComposedDirectSwap }
  | { ok: false; reason: string }

function poolDataFor(route: DirectRoute, sellAmount: bigint, minBuy: bigint, nowSec: number): Hex {
  if (route.route.kind === 'v3') {
    return encodeUrV3SwapExactIn({
      path: route.route.path,
      amountIn: sellAmount,
      amountOutMin: minBuy,
      deadline: nowSec + 1200,
      sixField: route.route.sixField,
    })
  }
  return encodeUrV4SwapExactInSingle({
    poolKey: route.route.poolKey,
    zeroForOne: route.route.zeroForOne,
    amountIn: sellAmount,
    amountOutMin: minBuy,
    deadline: nowSec + 1200,
  })
}

function wrapperCallFor(route: DirectRoute, sellAmount: bigint, minBuy: bigint, nowSec: number): WrapperCall | null {
  const settlement = deploymentFor(route.chainId).usdc as Address | null
  const nativeIn = route.direction === 'buy' && route.counter === 'native'
  const sellToken = route.direction === 'buy' ? (nativeIn ? null : settlement) : route.asset
  const buyToken = route.direction === 'buy' ? route.asset : (settlement as Address)
  if (!nativeIn && !sellToken) return null
  if (!buyToken) return null
  return swapWithFeeCall({
    chainId: route.chainId,
    sellToken,
    sellAmount,
    buyToken,
    minBuyAmount: minBuy,
    poolData: poolDataFor(route, sellAmount, minBuy, nowSec),
    feeBps: wrapperFeeBpsFor(route.chainId),
    // gen-1 chains would stay direct on null (that lane's own law); every
    // shipped book is feeGeneration 2, where the arg does not exist.
    feeRecipient: null,
    nowSec,
  })
}

/**
 * Quote-and-compose: probe the REAL wrapper call with minBuy=1, floor the
 * measured output, re-encode with the floor, prove the floored bytes with a
 * second simulation, and hand back the proven bytes. The caller signs them
 * VERBATIM or not at all.
 *
 * `holder` must hold the input at call time (quotes run at execute time, the
 * directPrism pattern — a review-time quote against unarrived funding would
 * be a promise about a state that does not exist yet).
 *
 * ERC-20 probes ride an eth_simulateV1 BUNDLE — [approve(wrapper, pull),
 * swapWithFee] from the holder in one simulated block — so the quote exists
 * BEFORE any approval signs with NO storage-layout guessing (the slot-guess
 * override was tried first and 4663's RPC ignored stateDiff entirely; the
 * bundle is the method the original carve proof used). Where the RPC lacks
 * eth_simulateV1, a REAL standing allowance still probes on plain eth_call
 * (approve-first executors); with neither, the lane refuses.
 */
export async function quoteAndComposeDirectSwap(args: {
  route: DirectRoute
  sellAmountRaw: bigint
  slippageBps: number
  holder: Address
  nowSec: number
  /** THE PLAN'S OWN FLOOR, raw buy-token units (a sale step's floorRaw).
   *  When set, the signed floor is max(probe×(1−slip), THIS) — the plan's
   *  number is what the wrapper enforces on-chain, exactly the protection
   *  the routed lanes' toAmountMin gives. Without it (2026-08-18, measured
   *  live on the owner's CASHCAT sale): the lane double-haircut — its own
   *  probe×(1−slip) floor sat ~1.2% under the estimate the PLAN floored at
   *  −4%, so 0.97×0.988 < 0.96 refused the lane by a hair on EVERY default-
   *  slippage sale and the fee rail never rode. A lane that can only lose
   *  the race it was built for is dead code wearing a fee. */
  minFloorRaw?: bigint
  client?: PublicClient | null
}): Promise<ComposedDirectAnswer> {
  const { route, sellAmountRaw, holder, nowSec } = args
  const client = args.client ?? clientOf(route.chainId)
  if (!client) return { ok: false, reason: 'We have no connection to this network.' }
  if (sellAmountRaw <= 0n) return { ok: false, reason: 'This swap carries no readable amount.' }
  if (route.direction === 'sell' && route.counter === 'native')
    return {
      ok: false,
      reason: 'This asset trades against native ETH, and the wrapper cannot deliver native proceeds — this sale stays on the routed lane.',
    }
  const wrapper = directSwapWrapperFor(route.chainId)
  if (!wrapper) return { ok: false, reason: 'No direct-swap wrapper is deployed on this network yet.' }

  const probe = wrapperCallFor(route, sellAmountRaw, 1n, nowSec)
  if (!probe) return { ok: false, reason: 'This route could not be composed on this network’s configuration.' }

  const erc20In = probe.value === 0n
  const sellToken = route.direction === 'buy' ? (deploymentFor(route.chainId).usdc as Address) : route.asset
  const pull = sellAmountRaw + probe.feeRaw

  const decodeBought = (data: Hex | undefined): bigint => {
    if (!data || data === '0x') throw new Error('empty return')
    return decodeFunctionResult({ abi: directSwapWrapperAbiGen2, functionName: 'swapWithFee', data }) as bigint
  }
  /** Run one candidate call through its live proof. ERC-20: the simulate
   *  bundle (approve then swap, really executed in the simulated block);
   *  native: a plain eth_call carries the value. Throws the revert's words. */
  const prove = async (call: WrapperCall): Promise<bigint> => {
    if (!erc20In) {
      const res = await client.call({ account: holder, to: call.to, data: call.data, value: call.value })
      return decodeBought(res.data)
    }
    try {
      const sim = await client.simulateCalls({
        account: holder,
        calls: [
          {
            to: sellToken,
            data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [wrapper, pull] }),
            value: 0n,
          },
          { to: call.to, data: call.data, value: 0n },
        ],
      })
      const swap = sim.results[1]
      if (!swap || swap.status !== 'success') {
        const words = swap && 'error' in swap && swap.error instanceof Error ? swap.error.message.split('\n')[0] : 'the swap call reverted'
        throw new Error(words)
      }
      return decodeBought(swap.data)
    } catch (e) {
      // an RPC without eth_simulateV1 (or a transport hiccup) — a REAL
      // standing allowance still proves the bytes on plain eth_call; a
      // genuine in-simulation revert rethrows its own words above
      if (e instanceof Error && /revert|MinBuy|Wrong|Refus|expired|Slice|delta/i.test(e.message)) throw e
      const res = await client.call({ account: holder, to: call.to, data: call.data, value: call.value })
      return decodeBought(res.data)
    }
  }

  /** The restricted-token degrade (see ComposedDirectSwap.feeless): a
   *  NATIVE-funded buy whose wrapper probe reverted re-probes the identical
   *  payload straight at the router — the user as recipient. A pass there
   *  isolates the refusal to the token's own transfer rule, and the lane
   *  returns the direct call rather than killing a buy the chain will fill.
   *  The router's own eth_call has no return value to parse, so the probe's
   *  measure is BALANCE-DELTA-free: the payload floor is the only guard, and
   *  the two-step probe/floor discipline runs by re-encoding the payload —
   *  first with minOut=1 measured via simulateCalls asset changes where the
   *  RPC serves them, else the quoter-free path refuses. To keep this rung
   *  PROVEN-simple, the degrade probes the FLOORED payload directly against
   *  the v4 quoter's answer: quote via the chain's v4Quoter (seated on every
   *  book chain), floor it, encode with the floor, prove with eth_call. */
  const directUrDegrade = async (): Promise<ComposedDirectAnswer | null> => {
    if (!(route.direction === 'buy' && route.counter === 'native' && route.route.kind === 'v4')) return null
    const dep = deploymentFor(route.chainId)
    const ur = dep.universalRouter as Address | null
    const quoter = dep.v4Quoter as Address | null
    if (!ur || !quoter) return null
    let quoted: bigint
    try {
      const [amountOut] = (await client.readContract({
        address: quoter,
        abi: v4QuoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey: route.route.poolKey, zeroForOne: route.route.zeroForOne, exactAmount: sellAmountRaw, hookData: '0x' }],
      })) as readonly [bigint, bigint]
      quoted = amountOut
    } catch {
      return null // no quoter answer → the degrade cannot price → stay refused
    }
    if (quoted <= 0n) return null
    const slipD = Math.min(Math.max(Math.trunc(args.slippageBps), 0), 9_999)
    const floorD = (quoted * BigInt(10_000 - slipD)) / 10_000n
    if (floorD <= 0n) return null
    const data = poolDataFor(route, sellAmountRaw, floorD, nowSec)
    try {
      await client.call({ account: holder, to: ur, data, value: sellAmountRaw })
    } catch {
      return null // the token refuses even the direct route — the refusal stands
    }
    return {
      ok: true,
      swap: {
        call: { to: ur, data, value: sellAmountRaw, feeRaw: 0n },
        probedOutRaw: quoted,
        minBuyRaw: floorD,
        feeBps: 0,
        feeRaw: 0n,
        approval: null,
        shown: { feeBps: 0, minBuyRaw: floorD, wrapper },
        feeless: true,
      },
    }
  }

  let probedOut: bigint
  try {
    probedOut = await prove(probe)
  } catch (e) {
    const degraded = await directUrDegrade()
    if (degraded) return degraded
    return {
      ok: false,
      reason: `This route did not survive its own live simulation, so nothing will be signed against it. ${e instanceof Error ? e.message.split('\n')[0] : ''}`.trim(),
    }
  }
  if (probedOut <= 0n) return { ok: false, reason: 'The route quoted nothing for this size.' }

  const slip = Math.min(Math.max(Math.trunc(args.slippageBps), 0), 9_999)
  // The signed floor: the probe's haircut, RAISED to the plan's own floor
  // where one is supplied — never lowered. A probe that cannot clear the
  // plan's floor refuses here (the market genuinely does not cover the plan
  // today); a probe above it signs the STRONGER of the two protections.
  const haircut = (probedOut * BigInt(10_000 - slip)) / 10_000n
  const minBuy = args.minFloorRaw != null && args.minFloorRaw > haircut ? args.minFloorRaw : haircut
  if (minBuy <= 0n) return { ok: false, reason: 'The floored output rounds to nothing at this size.' }
  if (probedOut < minBuy)
    return { ok: false, reason: 'The route’s live fill does not cover the plan’s floor — the routed lanes may still clear it.' }

  const real = wrapperCallFor(route, sellAmountRaw, minBuy, nowSec)
  if (!real) return { ok: false, reason: 'This route could not be composed on this network’s configuration.' }
  try {
    const proven = await prove(real)
    if (proven < minBuy) return { ok: false, reason: 'The market moved between the quote and its proof — re-run for fresh prices.' }
  } catch {
    return { ok: false, reason: 'The floored swap did not survive its own live simulation — the market may have moved. Re-run for fresh prices.' }
  }

  return {
    ok: true,
    swap: {
      call: real,
      probedOutRaw: probedOut,
      minBuyRaw: minBuy,
      feeBps: wrapperFeeBpsFor(route.chainId),
      feeRaw: real.feeRaw,
      approval: erc20In ? { token: sellToken, spender: wrapper, amountRaw: pull } : null,
      shown: { feeBps: wrapperFeeBpsFor(route.chainId), minBuyRaw: minBuy, wrapper },
    },
  }
}

/** The settlement-raw a sale may hand the wrapper so the PULL never exceeds
 *  the plan's outflow: sell + fee(sell) ≤ budget, fee floor-divided exactly
 *  like the contract. The wei the back-out strands (< 1 fee quantum) stays in
 *  the wallet — conservative, never over-pulled. */
export function backOutWrapperFee(budgetRaw: bigint, feeBps: number): { sellRaw: bigint; feeRaw: bigint } {
  if (budgetRaw <= 0n) return { sellRaw: 0n, feeRaw: 0n }
  let sell = (budgetRaw * 10_000n) / BigInt(10_000 + feeBps)
  // floor division can leave sell + fee(sell) one quantum over on adversarial
  // remainders — walk down until the contract's own arithmetic fits
  while (sell > 0n && sell + wrapperFeeRaw(sell, feeBps) > budgetRaw) sell -= 1n
  return { sellRaw: sell, feeRaw: wrapperFeeRaw(sell, feeBps) }
}

/** Decode a receipt's FeeCharged — the first-swap check's data and the
 *  success plate's honesty line (burnCut == fee on a feeGeneration-2 chain). */
export const feeChargedEventAbi = parseAbi(['event FeeCharged(address indexed burnSink, uint256 burnCut)'])

/** Test seams only — the executors go through the exported functions above. */
export const directSwapLaneInternals = { deepestHubTier, wrapperCallFor }
