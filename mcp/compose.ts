// ─────────────────────────────────────────────────────────────────────────────
// THE COMPOSE PIPELINE — the app's own money path, node-side, law by law.
//
// Nothing here is new arithmetic: every step is the app's own module called in
// the app's own order (reuse, never recreation). The laws travel with them:
//   · floors derive from the SIMULATED realised output (the quote IS the
//     simulation) — an agent never supplies a floor;
//   · the settlement's decimals are verified on-chain before any amount
//     scales (law S2b);
//   · a buy without a resolved funding split refuses (the starved-basket
//     exploit's door stays shut);
//   · the composed bytes are SIMULATED before they are returned — a doomed
//     call fails here with the revert's own words, never at the wallet;
//   · every refusal is a sentence.
// ─────────────────────────────────────────────────────────────────────────────
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, formatUnits, getAbiItem, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from 'viem'
import { chainCfg } from '../app/src/lib/chain/chains'
import { deploymentFor } from '../app/src/lib/chain/deployments'
import { clientFor } from '../app/src/lib/chain/rpc'
import { erc20ApproveAbi, factoryDeployAbi, swapRouterAbi, type FeeConfigInput } from '../app/src/lib/spectrum/abis-v2'
import { getBasketData, type BasketData } from '../app/src/lib/spectrum/basket-data'
import { showName, showSymbol } from '../app/src/lib/spectrum/safe-copy'
import { buildSwapQuote, toRaw } from '../app/src/lib/spectrum/swap-quote'
import { probeSwapArgs, simulateSwapOut } from '../app/src/lib/spectrum/swap-sim'
import { lensFactoryFor, resolveMintFunding } from '../app/src/lib/spectrum/mint-funding'
import { encodeMintHookData, encodeRedeemHookData, DEFAULT_SLIPPAGE_BPS, type MintFunding } from '../app/src/lib/spectrum/hook-data'
import { friendlyRevert, rawMessageOf } from '../app/src/lib/spectrum/decode-revert'
import { verifiedSettlementDecimals } from '../app/src/lib/spectrum/settlement-verify'
import { basketAbi } from '../app/src/lib/spectrum/abis-v2'
import { toBasketEntries, startSqrtPriceX96ForDollarNav, type DeployAssetInput } from '../app/src/lib/spectrum/deploy'
import { mineSalt } from '../app/src/lib/spectrum/salt-mining'
import { buildLaunchCalls } from '../app/src/lib/spectrum/launch-batch'
import { resolveAsset } from '../app/src/components/launch/BasketBuilder'
import { decodeOrNull, lintBatchCalldata, lintWrapperCalldata } from '../app/src/lib/spectrum/calldata-lint'
import { PORTFOLIO_BATCH_BUY_SELECTOR, PORTFOLIO_BATCH_BUY_SELECTOR_GEN2 } from '../app/src/lib/spectrum/portfolio-batcher'
import { directSwapWrapperAbi, directSwapWrapperAbiGen2 } from '../app/src/lib/spectrum/direct-swap-wrapper'

export interface ComposedTx {
  to: Address
  data: Hex
  value: string
  chainId: number
}

export interface ComposedSwap {
  /** The exact-amount approval the router needs first (absent when covered). */
  approval: ComposedTx | null
  swap: ComposedTx
  review: string[]
}

function refuse(sentence: string): never {
  throw new Error(sentence)
}

/** Decode the composed swapExactIn back and prove it carries EXACTLY the floor,
 *  recipient, tokenIn and amount we intend — an arg-order regression guard on
 *  the one call this server hand-assembles. Never fires in a healthy build;
 *  when it does, it means the encode drifted, and shipping those bytes would
 *  sign a different trade than the review describes. */
function assertSwapBytes(data: Hex, want: { basket: Address; minOut: bigint; holder: Address; tokenIn: Address; amountIn: bigint }): void {
  const dec = decodeFunctionData({ abi: swapRouterAbi, data })
  const a = dec.args as readonly [Address, Address, bigint, bigint, Hex, Address]
  if (a[0].toLowerCase() !== want.basket.toLowerCase()) refuse('internal: the composed bytes name a different basket than intended — refusing to return them')
  if (a[1].toLowerCase() !== want.tokenIn.toLowerCase()) refuse('internal: the composed bytes name a different tokenIn than intended — refusing to return them')
  if (a[2] !== want.amountIn) refuse('internal: the composed bytes carry a different input amount than intended — refusing')
  if (a[3] !== want.minOut) refuse('internal: the composed bytes carry a different floor than the review states — refusing (this is the displayed-vs-signed law, MCP-side)')
  if (a[5].toLowerCase() !== want.holder.toLowerCase()) refuse('internal: the composed bytes send to a different recipient than intended — refusing')
}

// ── THE CALLDATA LINT, MCP-SIDE (hardening wave A, worn at this seam too) ────
// The app runs an INDEPENDENT decode of composed money calldata against the
// money laws right before its wallet prompts (calldata-lint.ts — used by
// TradePrism and DirectLegCard, dispatched by where the bytes are headed).
// This server wears the same gate at ITS wallet seam: every composed payload
// passes through lintComposedTx before it is registered or returned.
//
// The lint's v1 scope is the two fee-rail call families (batchBuy on both
// generations, swapWithFee on both) — when composed bytes speak one of those
// selectors, the app's own lint runs STRICT (no consent surface here; every
// finding refuses in its own words, exactly like TradePrism's lane). The four
// call shapes this server composes today (swapExactIn, redeemInKind,
// deployBasket, ERC-20 approve) are NOT lint families; each carries its own
// decode-back guard at compose time, so here they must simply DECODE on their
// own pinned ABI — and anything else fails closed: an unreadable or unknown
// call is never clean (the lint's law 7), so it never returns.
const selectorOf = (abi: Abi, name: string): string => {
  const item = getAbiItem({ abi, name }) as AbiFunction | undefined
  if (!item) throw new Error(`internal: ABI item '${name}' not found — the lint dispatch table cannot build`)
  return toFunctionSelector(item).toLowerCase()
}
/** Exported for the suite: the wrapper lane's selectors (both generations). */
export const WRAPPER_SELECTORS: readonly string[] = [selectorOf(directSwapWrapperAbi, 'swapWithFee'), selectorOf(directSwapWrapperAbiGen2, 'swapWithFee')]
/** The call shapes this server itself composes, each with the ABI that must be
 *  able to read it back (fail-closed readability — never a shape allowlist an
 *  unreadable call can hide behind). */
const OWN_FAMILIES: ReadonlyArray<{ selector: string; abi: Abi; what: string }> = [
  { selector: selectorOf(swapRouterAbi, 'swapExactIn'), abi: swapRouterAbi, what: 'swapExactIn' },
  { selector: selectorOf(basketAbi, 'redeemInKind'), abi: basketAbi, what: 'redeemInKind' },
  { selector: selectorOf(factoryDeployAbi, 'deployBasket'), abi: factoryDeployAbi, what: 'deployBasket' },
  { selector: selectorOf(erc20ApproveAbi, 'approve'), abi: erc20ApproveAbi, what: 'approve' },
]

/**
 * Judge one composed payload before it may return: the app's own calldata lint
 * on the fee-rail families, fail-closed readability on everything else. Throws
 * a refusal sentence naming the law that fired; returns void when clean.
 *
 * `signer` is who will SIGN the payload (the recipient law's subject). null is
 * lawful only for shapes with no recipient law — a batch payload without a
 * declared signer refuses rather than skipping the law.
 */
export function lintComposedTx(tx: ComposedTx, expect: { signer: Address | null; nowSeconds: number }): void {
  const selector = tx.data.slice(0, 10).toLowerCase()

  if (selector === PORTFOLIO_BATCH_BUY_SELECTOR || selector === PORTFOLIO_BATCH_BUY_SELECTOR_GEN2) {
    if (!expect.signer)
      refuse('the calldata lint refused this compose — law recipient-match: a batch payload was composed without a declared signer, so the recipient-is-the-signer law cannot be checked; refusing rather than skipping it')
    const findings = lintBatchCalldata({
      data: tx.data,
      value: BigInt(tx.value),
      expected: { recipient: expect.signer, nowSeconds: expect.nowSeconds },
    })
    if (findings.length > 0) refuse(`the calldata lint refused this compose — law ${findings[0].law}: ${findings[0].sentence}`)
    return
  }

  if (WRAPPER_SELECTORS.includes(selector)) {
    const findings = lintWrapperCalldata({
      data: tx.data,
      value: BigInt(tx.value),
      expected: { nowSeconds: expect.nowSeconds },
    })
    if (findings.length > 0) refuse(`the calldata lint refused this compose — law ${findings[0].law}: ${findings[0].sentence}`)
    return
  }

  const own = OWN_FAMILIES.find((f) => f.selector === selector)
  if (own) {
    // not a lint family (v1 scope is the fee rails); the shape still has to
    // READ on its own pinned ABI — what cannot be read is never clean (law 7)
    if (decodeOrNull(own.abi, tx.data) == null)
      refuse(`the calldata lint refused this compose — law unrecognized: these bytes carry the ${own.what} selector but do not decode on its ABI, and an unreadable call is never clean`)
    return
  }

  refuse(`the calldata lint refused this compose — law unrecognized: selector ${selector} is not a call family this server composes or knows how to judge, and an unreadable call is never clean`)
}

async function readDeployment(chainId: number) {
  const dep = deploymentFor(chainId)
  if (!dep.swapRouter || !dep.usdc) refuse(`chain ${chainId} has no swap router / settlement configured in this kit's deployment book — buys and sells are inert there`)
  if (!dep.factory) refuse(`chain ${chainId} has no factory configured — nothing can deploy there`)
  return { router: dep.swapRouter as Address, usdc: dep.usdc as Address, factory: dep.factory as Address }
}

async function readBasketOrRefuse(chainId: number, basket: Address): Promise<BasketData> {
  const data = await getBasketData(basket, chainId)
  if (!data) refuse(`basket ${basket} did not read on chain ${chainId} — wrong address, wrong chain, or the RPC could not answer`)
  return data
}

/** THE BUNDLE SIMULATION (eth_simulateV1): [approve exact-amount, then the
 *  call] from the holder — the allowance becomes REAL inside the simulated
 *  block, so no storage-slot guessing is involved. This exists because the
 *  override path assumes the OZ slot-1 allowance layout, which holds for
 *  basket tokens (sells) but NOT for every settlement token (Base settlement
 *  measured at base slot 10, 2026-08-19), and some RPCs ignore overrides
 *  entirely (4663, measured 2026-08-18) — the bundle is the in-repo proven
 *  method for both (direct-swap-lane.ts). Returns the target call's return
 *  data; null when the RPC lacks eth_simulateV1 (callers keep their other
 *  paths); throws the revert's own words on a genuine in-simulation revert. */
async function simulateWithApproval(
  client: ReturnType<typeof clientFor>,
  holder: Address,
  approval: { token: Address; spender: Address; amount: bigint },
  target: { to: Address; data: Hex },
): Promise<Hex | null> {
  let sim
  try {
    sim = await client.simulateCalls({
      account: holder,
      calls: [
        {
          to: approval.token,
          data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [approval.spender, approval.amount] }),
          value: 0n,
        },
        { to: target.to, data: target.data, value: 0n },
      ],
    })
  } catch {
    return null // no eth_simulateV1 on this RPC — not a verdict on the trade
  }
  const call = sim.results[1]
  if (!call || call.status !== 'success') {
    // the kit's own revert decoder speaks here: it unwraps the router's
    // WrappedError (0x90bfb865), names the protocol's custom errors, and
    // diagnoses an empty hook reason (an untradeable constituent) — the raw
    // selector alone reads as a mystery
    const err = call && 'error' in call ? call.error : null
    const fallback = err ? rawMessageOf(err).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' · ').slice(0, 300) : 'the call reverted in simulation'
    throw new Error(err ? friendlyRevert(err, fallback) : fallback)
  }
  return call.data
}

/** The one door for slippage: bounded, defaulted, never trusted raw. */
function wantSlippage(v: unknown): number {
  if (v == null) return DEFAULT_SLIPPAGE_BPS
  const n = Number(v)
  if (!Number.isInteger(n) || n < 10 || n > 2_000)
    refuse(`slippageBps must be an integer between 10 and 2000 — ${String(v)} is not a tolerance this server will sign floors from`)
  return n
}

// ── BUY (mint-via-swap) ──────────────────────────────────────────────────────

interface BuyArgs {
  chainId: number
  basket: Address
  /** settlement to spend, human units (e.g. "250" = $250 of USDC-family). */
  amountUsd: number
  holder: Address
  slippageBps?: number
}

/** What a READ-ONLY quote returns: the numbers and the sentences, nothing
 *  signable. Deliberately carries no {to,data,value} — a quote must never be
 *  executable, so the type itself has nowhere to put calldata. */
export interface ComposedQuote {
  quoteOnly: true
  amountUsd: number
  /** expected shares at the LIVE simulated fill, raw 18dp string. */
  expectedSharesRaw: string
  /** the floor a compose would sign (simulated fill − slippage), raw string. */
  floorSharesRaw: string
  expectedShares: string
  floorShares: string
  slippageBps: number
  feeBps: number
  navPerToken: number
  navSource: string
  review: string[]
}

export async function composeBuy(args: BuyArgs & { quoteOnly: true }): Promise<ComposedQuote>
export async function composeBuy(args: BuyArgs): Promise<ComposedSwap>
export async function composeBuy(args: BuyArgs & { quoteOnly?: boolean }): Promise<ComposedSwap | ComposedQuote> {
  const { chainId, basket, holder } = args
  const client = clientFor(chainId)
  const { router, usdc, factory } = await readDeployment(chainId)
  const slippageBps = wantSlippage(args.slippageBps)
  if (!(args.amountUsd > 0)) refuse('amountUsd must be positive — zero buys nothing')

  const data = await readBasketOrRefuse(chainId, basket)
  // THE LINEAGE LAW (2026-08-21, measured on 4663): a superseded basket keeps
  // its OWN router and its OWN factory's funding lens. Asking the CURRENT
  // (packing) factory for the split on a legacy pre-packing basket packs split
  // bits into the floor words — an astronomical legMins → LegMinNotMet on
  // every buy, at every size and slippage (28 of 34 baskets on 4663). The
  // app's card resolves both per-lineage (use-dex-swap: ix.router ?? dep;
  // use-mint-funding: lensFactoryFor) — this server now does the same.
  const swapRouter = (data.router ?? router) as Address
  const lensFactory = (await lensFactoryFor(chainId, basket)) ?? factory
  // law S2b: the settlement's decimals verified on-chain before ANY scaling
  const settlementDecimals = await verifiedSettlementDecimals(client, chainId, usdc)
  // the same read use-basket-fees makes (its fetcher is hook-private): the
  // headline rate is REQUIRED — an unread fee refuses, never defaults
  const feeRead = await client.readContract({ address: basket, abi: basketAbi, functionName: 'basketFeeBps' }).catch(() => null)
  if (feeRead == null) refuse('this basket’s fee could not be read — a floor built on an unread fee is a guess, and this server does not guess')
  const fees = { basketFeeBps: Number(feeRead) }

  const firstMint = data.totalSupply === 0
  const legCount = data.holdings.length
  // decimal-safe (the app's own toRaw), NOT float math — so the amount the
  // simulation prices is byte-identical to the amount the swap signs
  // (quote.amountRaw below), on any settlement-decimals, not just 6dp
  const amountRaw = toRaw(args.amountUsd, settlementDecimals)
  if (amountRaw <= 0n) refuse('amountUsd is below one unit of settlement — too small to buy')

  // does the router already have the allowance? then no approval leg is needed
  const usdcAllowance = (await client
    .readContract({ address: usdc, abi: erc20ApproveAbi, functionName: 'allowance', args: [holder, swapRouter] })
    .catch(() => 0n)) as bigint
  const allowanceCovers = usdcAllowance >= amountRaw

  // the funding split — a buy with no split acquires nothing on a D-R1 basket;
  // the lens asked is the basket's OWN lineage's (the lineage law above)
  const funding = await resolveMintFunding(client, { chainId, factory: lensFactory, basket, amountIn: amountRaw, legCount, firstMint })
  if (!funding.ok) refuse(`the buy's funding split did not resolve: ${funding.reason}`)

  // THE QUOTE IS THE SIMULATION: realised shares for THIS amount, measured.
  // Path 1 is the app's own simulateSwapOut (plain eth_call under a standing
  // allowance; allowance-slot override otherwise). Path 2, when that measures
  // nothing and no allowance stands, is the [approve, swap] bundle — see
  // simulateWithApproval for why both exist.
  const fundingSplitBps = 'splitBps' in funding.funding ? funding.funding.splitBps : null
  let simulated = await simulateSwapOut(client, {
    side: 'buy',
    basket,
    settlement: usdc,
    router: swapRouter,
    amountIn: amountRaw,
    legCount,
    holder,
    allowanceCovers,
    fundingSplitBps,
  })
  let revertWords: string | null = null
  if ((simulated == null || simulated <= 0n) && !allowanceCovers) {
    try {
      const probeArgs = probeSwapArgs({ side: 'buy', basket, settlement: usdc, amountIn: amountRaw, legCount, holder, fundingSplitBps })
      const out = await simulateWithApproval(
        client,
        holder,
        { token: usdc, spender: swapRouter, amount: amountRaw },
        { to: swapRouter, data: encodeFunctionData({ abi: swapRouterAbi, functionName: 'swapExactIn', args: probeArgs }) },
      )
      if (out != null) simulated = decodeFunctionResult({ abi: swapRouterAbi, functionName: 'swapExactIn', data: out }) as bigint
    } catch (e) {
      revertWords = e instanceof Error ? e.message : null
    }
  }
  if (simulated == null || simulated <= 0n)
    refuse(
      `the buy did not survive its own simulation, so no honest floor exists — nothing was composed.${revertWords ? ` The chain's own words: ${revertWords}.` : ''} Causes, likeliest first: (1) the holder lacks the settlement balance (the simulation spends the holder's REAL funds); (2) the basket is unbuyable right now (a parked or gated leg); (3) this RPC supports neither eth_simulateV1 nor eth_call state overrides — seat an operator RPC (e.g. VITE_ALCHEMY_API_KEY); (4) the market moved. The read-only tools work on any RPC.`,
    )

  const quote = buildSwapQuote({
    side: 'buy',
    amount: args.amountUsd,
    navPerToken: data.navPerToken,
    feeFrac: fees.basketFeeBps / 10_000,
    slippageBps,
    holdings: data.holdings,
    basketDecimals: data.decimals,
    settlementDecimals,
    realisedOutRaw: simulated,
    fundingSplitBps: 'splitBps' in funding.funding ? funding.funding.splitBps : undefined,
  })
  if (!quote) refuse('no honest quote could be built for this buy (a leg quoted zero, or the basket’s pricing is unreadable) — nothing was composed')

  // READ-ONLY QUOTE: same pipeline to this exact point (live simulated fill,
  // verified decimals, resolved funding, the app's own quote math) — then the
  // numbers return and NOTHING else happens: no hookData, no bytes, no
  // pre-return proof, no registry entry. There is nothing here to execute.
  if (args.quoteOnly === true) {
    const expectedShares = formatUnits(simulated, Math.min(data.decimals, 18))
    const floorShares = formatUnits(quote.minOutRaw, Math.min(data.decimals, 18))
    return {
      quoteOnly: true,
      amountUsd: args.amountUsd,
      expectedSharesRaw: simulated.toString(),
      floorSharesRaw: quote.minOutRaw.toString(),
      expectedShares,
      floorShares,
      slippageBps,
      feeBps: fees.basketFeeBps,
      navPerToken: data.navPerToken,
      navSource: data.navSource,
      review: [
        `QUOTE (numbers only — nothing was composed, nothing is executable):`,
        `· buy $${data.symbol} (${data.name}) on ${chainCfg(chainId).name} for $${args.amountUsd} settlement`,
        `· expected: ~${expectedShares} shares at the LIVE simulated fill (the quote IS the simulation, measured just now)`,
        `· floor a compose would sign: ${floorShares} shares (the simulated fill − ${slippageBps} bps)`,
        `· price basis: NAV $${data.navPerToken.toFixed(6)} per share (${data.navSource}${data.fullyPriced ? '' : ' — NOT every leg priced, treat the NAV as partial'}) · fee: the basket's own ${fees.basketFeeBps} bps`,
        `· quotes age with the market — run spectrum_compose_buy for signable bytes with a floor simulated fresh at that moment`,
      ],
    }
  }

  const { hookData } = encodeMintHookData({
    quotedLegAmounts: quote.quotedLegAmounts,
    slippageBps,
    minOut: quote.minOutRaw,
    interfaceTag: null, // the operator's own tag applies (env), exactly like a fresh visitor
    funding: funding.funding as MintFunding,
  })
  const callArgs = [basket, usdc, quote.amountRaw, quote.minOutRaw, hookData, holder] as const
  assertSwapBytes(encodeFunctionData({ abi: swapRouterAbi, functionName: 'swapExactIn', args: callArgs }), {
    basket,
    minOut: quote.minOutRaw,
    holder,
    tokenIn: usdc,
    amountIn: quote.amountRaw,
  })

  // the click-time simulate, server-side: the EXACT floored bytes must pass
  // before they return. Under a standing allowance the plain path proves them;
  // without one, the bundle proves them behind the same exact-amount approval
  // the composed sequence sends first — unproven bytes never leave this server.
  const flooredData = encodeFunctionData({ abi: swapRouterAbi, functionName: 'swapExactIn', args: callArgs })
  if (allowanceCovers) {
    await client.simulateContract({ account: holder, address: swapRouter, abi: swapRouterAbi, functionName: 'swapExactIn', args: callArgs }).catch((e) => {
      refuse(`the composed buy failed its pre-return simulation: ${friendlyRevert(e, rawMessageOf(e).split('\n')[0])} — nothing was composed`)
    })
  } else {
    let proven: Hex | null = null
    try {
      proven = await simulateWithApproval(client, holder, { token: usdc, spender: swapRouter, amount: quote.amountRaw }, { to: swapRouter, data: flooredData })
    } catch (e) {
      refuse(`the composed buy failed its pre-return simulation: ${e instanceof Error ? e.message.split('\n')[0] : 'the chain refused'} — nothing was composed`)
    }
    if (proven == null)
      refuse('the composed buy cannot be PROVEN on this RPC (no standing allowance and no eth_simulateV1) — refusing to return unproven bytes; seat an operator RPC or approve the router first')
  }

  const shares = formatUnits(quote.minOutRaw, Math.min(data.decimals, 18))
  return {
    approval: allowanceCovers
      ? null
      : {
          to: usdc,
          data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [swapRouter, quote.amountRaw] }),
          value: '0',
          chainId,
        },
    swap: { to: swapRouter, data: flooredData, value: '0', chainId },
    review: [
      `REVIEW (the words are the law — read before signing):`,
      `· buy $${showSymbol(data.symbol)} (${showName(data.name)}) on ${chainCfg(chainId).name} for $${args.amountUsd} settlement`,
      // the RECIPIENT, said out loud (audit 2026-08-21): the shares go to
      // `holder`, and `holder` must be the wallet that signs — a recipient in
      // opaque calldata is where the free-holder theft hid
      `· the shares arrive at ${holder} — this MUST be the wallet that signs; if it is not yours, do not sign`,
      `· floor: at least ${shares} shares arrive or the chain reverts (floor = the SIMULATED fill − ${slippageBps} bps; per-leg minimums ride in the payload)`,
      `· fee: the basket's own ${fees.basketFeeBps} bps, charged by the contract${firstMint ? ' · THIS IS THE FIRST MINT — the seed buy sets the basket in motion' : ''}`,
      allowanceCovers
        ? `· one signature: the swap — the router's allowance already covers this amount, so no approval is needed. This server holds no keys and has sent nothing`
        : `· two signatures: the exact-amount approval (never infinite), then the swap — this server holds no keys and has sent nothing`,
    ],
  }
}

// ── SELL (pooled redeem-via-swap) ────────────────────────────────────────────

interface SellArgs {
  chainId: number
  basket: Address
  /** shares to sell, RAW base units (string) — never a decimal. */
  sharesRaw: string
  holder: Address
  slippageBps?: number
}

/** The sell twin of ComposedQuote: numbers and sentences only, no calldata. */
export interface ComposedSellQuote {
  quoteOnly: true
  sharesRaw: string
  shares: string
  /** the LIVE simulated settlement proceeds, raw string. */
  expectedOutRaw: string
  /** the floor a compose would sign (simulated proceeds − slippage), raw string. */
  floorOutRaw: string
  expectedOut: string
  floorOut: string
  slippageBps: number
  navPerToken: number
  navSource: string
  review: string[]
}

export async function composeSell(args: SellArgs & { quoteOnly: true }): Promise<ComposedSellQuote>
export async function composeSell(args: SellArgs): Promise<ComposedSwap>
export async function composeSell(args: SellArgs & { quoteOnly?: boolean }): Promise<ComposedSwap | ComposedSellQuote> {
  const { chainId, basket, holder } = args
  const client = clientFor(chainId)
  const { router, usdc } = await readDeployment(chainId)
  const slippageBps = wantSlippage(args.slippageBps)
  if (!/^\d+$/.test(args.sharesRaw)) refuse('sharesRaw must be a raw integer string — a decimal here mis-sizes real money')
  const sharesRaw = BigInt(args.sharesRaw)
  if (sharesRaw <= 0n) refuse('sharesRaw must be positive — zero sells nothing')

  const data = await readBasketOrRefuse(chainId, basket)
  // the lineage law (see composeBuy): a superseded basket sells through its
  // OWN router — the app's card does the same (ix.router ?? dep.swapRouter)
  const swapRouter = (data.router ?? router) as Address
  const settlementDecimals = await verifiedSettlementDecimals(client, chainId, usdc)
  // no fee read here on purpose: the sell floor derives from the SIMULATED
  // realised proceeds, and the simulation already pays the basket's own fee
  const legCount = data.holdings.length

  // does the router already hold the SHARES allowance? (the buy's F4, mirrored)
  const shareAllowance = (await client
    .readContract({ address: basket, abi: erc20ApproveAbi, functionName: 'allowance', args: [holder, swapRouter] })
    .catch(() => 0n)) as bigint
  const allowanceCovers = shareAllowance >= sharesRaw

  // same two lawful paths as the buy — though a basket token IS the OZ slot-1
  // layout the override assumes, so path 1 usually measures sells by itself
  let simulated = await simulateSwapOut(client, {
    side: 'sell',
    basket,
    settlement: usdc,
    router: swapRouter,
    amountIn: sharesRaw,
    legCount,
    holder,
    allowanceCovers,
  })
  let revertWords: string | null = null
  if ((simulated == null || simulated <= 0n) && !allowanceCovers) {
    try {
      const probeArgs = probeSwapArgs({ side: 'sell', basket, settlement: usdc, amountIn: sharesRaw, legCount, holder })
      const out = await simulateWithApproval(
        client,
        holder,
        { token: basket, spender: swapRouter, amount: sharesRaw },
        { to: swapRouter, data: encodeFunctionData({ abi: swapRouterAbi, functionName: 'swapExactIn', args: probeArgs }) },
      )
      if (out != null) simulated = decodeFunctionResult({ abi: swapRouterAbi, functionName: 'swapExactIn', data: out }) as bigint
    } catch (e) {
      revertWords = e instanceof Error ? e.message : null
    }
  }
  if (simulated == null || simulated <= 0n)
    refuse(
      `the sell did not survive its own simulation, so no honest floor exists — nothing was composed.${revertWords ? ` The chain's own words: ${revertWords}.` : ''} Causes: the holder may not hold these shares (the simulation sells the holder's REAL balance), a leg may be parked, this RPC may support neither eth_simulateV1 nor state overrides (seat an operator RPC), or the market moved. THE UNCONDITIONAL EXIT — spectrum_compose_redeem_in_kind — needs no simulation and no floor, and always stands.`,
    )

  // the floor: the simulated settlement out, haircut once — never doubled
  const minOutRaw = (simulated * BigInt(10_000 - slippageBps)) / 10_000n
  if (minOutRaw <= 0n) refuse('the floor rounded to zero — this sell is too small to protect honestly')

  // QUOTE-ONLY exits here: the live simulation ran (that IS the quote), the
  // floor is the one a compose would sign — but no bytes exist to sign or
  // register, so a quote can never become executable (the buy quote's law)
  if (args.quoteOnly === true) {
    const humanQ = formatUnits(sharesRaw, Math.min(data.decimals, 18))
    const expOut = formatUnits(simulated, settlementDecimals)
    const floorOut = formatUnits(minOutRaw, settlementDecimals)
    return {
      quoteOnly: true,
      sharesRaw: sharesRaw.toString(),
      shares: humanQ,
      expectedOutRaw: simulated.toString(),
      floorOutRaw: minOutRaw.toString(),
      expectedOut: expOut,
      floorOut,
      slippageBps,
      navPerToken: data.navPerToken,
      navSource: data.navSource,
      review: [
        `QUOTE (numbers only — nothing was composed, nothing is executable):`,
        `· selling ${humanQ} $${data.symbol} on ${chainCfg(chainId).name} simulates to $${expOut} settlement at the LIVE fill`,
        `· a compose right now would sign a floor of $${floorOut} (simulated proceeds − ${slippageBps} bps)`,
        `· NAV basis $${data.navPerToken.toFixed(6)} (${data.navSource})`,
        `· to act: spectrum_compose_sell with the same arguments — it re-simulates fresh at that moment`,
      ],
    }
  }

  const { hookData } = encodeRedeemHookData({ legCount, minOut: minOutRaw, interfaceTag: null })
  const callArgs = [basket, basket, sharesRaw, minOutRaw, hookData, holder] as const
  assertSwapBytes(encodeFunctionData({ abi: swapRouterAbi, functionName: 'swapExactIn', args: callArgs }), {
    basket,
    minOut: minOutRaw,
    holder,
    tokenIn: basket,
    amountIn: sharesRaw,
  })
  const flooredData = encodeFunctionData({ abi: swapRouterAbi, functionName: 'swapExactIn', args: callArgs })
  if (allowanceCovers) {
    await client.simulateContract({ account: holder, address: swapRouter, abi: swapRouterAbi, functionName: 'swapExactIn', args: callArgs }).catch((e) => {
      refuse(`the composed sell failed its pre-return simulation: ${friendlyRevert(e, rawMessageOf(e).split('\n')[0])} — nothing was composed`)
    })
  } else {
    let proven: Hex | null = null
    try {
      proven = await simulateWithApproval(client, holder, { token: basket, spender: swapRouter, amount: sharesRaw }, { to: swapRouter, data: flooredData })
    } catch (e) {
      refuse(`the composed sell failed its pre-return simulation: ${e instanceof Error ? e.message.split('\n')[0] : 'the chain refused'} — nothing was composed`)
    }
    if (proven == null)
      refuse('the composed sell cannot be PROVEN on this RPC (no standing allowance and no eth_simulateV1) — refusing to return unproven bytes; seat an operator RPC or approve the router for the shares first')
  }

  const human = formatUnits(sharesRaw, Math.min(data.decimals, 18))
  const floorUsd = formatUnits(minOutRaw, settlementDecimals)
  return {
    approval: allowanceCovers
      ? null
      : {
          to: basket,
          data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [swapRouter, sharesRaw] }),
          value: '0',
          chainId,
        },
    swap: { to: swapRouter, data: flooredData, value: '0', chainId },
    review: [
      `REVIEW (the words are the law — read before signing):`,
      `· sell ${human} $${showSymbol(data.symbol)} (${showName(data.name)}) on ${chainCfg(chainId).name} into settlement`,
      `· the settlement proceeds arrive at ${holder} — this MUST be the wallet that signs; if it is not yours, do not sign`,
      `· floor: at least $${floorUsd} arrives or the chain reverts (floor = the SIMULATED proceeds − ${slippageBps} bps)`,
      `· a PARKED leg makes the pooled sell refuse at simulation — the unconditional exit (redeem in kind) always stands instead`,
      allowanceCovers
        ? `· one signature: the swap — the router's shares allowance already covers this amount. This server holds no keys and has sent nothing`
        : `· two signatures: the exact-amount approval, then the swap — this server holds no keys and has sent nothing`,
    ],
  }
}

// ── CREATE (deploy a new basket) ─────────────────────────────────────────────

export async function composeCreate(args: {
  chainId: number
  name: string
  symbol: string
  /** asset address or symbol per leg — resolved through the kit's own discovery. */
  assets: string[]
  /** integer percents, summing to exactly 100, one per asset. */
  weightsPct: number[]
  deployer: Address
  /** total fee bps for the basket (the contract floors at 100 = 1%). */
  basketFeeBps: number
  /** creator's share of the remainder, bps (0..3000). 0 = no creator fee. */
  creatorShareBps: number
  /** required when creatorShareBps > 0 — where the creator share pays. */
  creatorPayout?: Address
  /** OPTIONAL — the predecessor basket this deploy is the next VERSION of.
   *  Spectrum versioning is a deployer-signed social convention (no on-chain
   *  successor pointer — the contracts reject one), so this does NOT change the
   *  deploy calldata; it is carried into the review + next-step, which tell the
   *  agent to sign the `supersedes` metadata claim after the deploy (same
   *  deployer, must own the predecessor). Holders of the predecessor then
   *  migrate to this new head. */
  supersedes?: Address
}): Promise<{ calls: ComposedTx[]; predicted: Address; review: string[] }> {
  const { chainId, deployer } = args
  const client = clientFor(chainId)
  const { factory } = await readDeployment(chainId)
  if (!args.name.trim() || !args.symbol.trim()) refuse('a basket needs a real name and symbol')
  if (args.assets.length < 2 || args.assets.length > 12) refuse(`a basket carries 2–12 legs — ${args.assets.length} was asked`)
  if (args.assets.length !== args.weightsPct.length) refuse('assets and weightsPct must pair one-to-one')
  // per-weight validation BEFORE the sum check downstream: toBasketEntries only
  // proves SUM===100, which lets -10/110 through — every leg must carry a real
  // positive integer weight on its own
  for (let i = 0; i < args.weightsPct.length; i++) {
    const w = args.weightsPct[i]
    if (!Number.isInteger(w) || w < 1 || w > 99)
      refuse(`weightsPct[${i}] = ${w} is not an integer between 1 and 99 — every leg carries its own real positive weight (a sum that happens to hit 100 is not enough)`)
  }

  // the kit's own discovery resolves each leg (address or symbol → route);
  // an unroutable leg refuses with the resolver's own words
  const resolved: DeployAssetInput[] = []
  for (const raw of args.assets) {
    // the kit's resolver refuses in its own sentences (hooked-market, no
    // route) — those words pass through verbatim
    const a = await resolveAsset(raw.trim(), chainId).catch((e) => refuse(`asset '${raw}': ${e instanceof Error ? e.message.split('\n')[0] : 'did not resolve'}`))
    resolved.push({ address: a.address, decimals: a.decimals, route: a.route, symbol: a.symbol })
  }
  const entries = toBasketEntries(resolved, args.weightsPct, chainId) // throws its own sentences on bad weights/venues

  const feeConfig: FeeConfigInput = {
    basketFeeBps: args.basketFeeBps,
    creatorShareBps: args.creatorShareBps,
    creatorPayout: args.creatorShareBps > 0 ? (args.creatorPayout ?? refuse('creatorShareBps > 0 needs creatorPayout — the contract reverts BadCreatorShare otherwise')) : ('0x0000000000000000000000000000000000000000' as Address),
    launcher: '0x0000000000000000000000000000000000000000' as Address,
  }

  // the CREATE2 salt: mined against the factory's own predictTokenAddress
  // oracle — the mined address carries the hook bits or deploy reverts
  const mined = await mineSalt({ factory, chainId, basket: entries, deployer, feeConfig })

  const priceWei = (await client
    .readContract({ address: factory, abi: factoryDeployAbi, functionName: 'currentDeployPrice' })
    .catch(() => refuse('the factory’s current deploy price could not be read — composing a deploy with an unread cost overpays or reverts; nothing was composed'))) as bigint

  const usdcDecimals = await verifiedSettlementDecimals(client, chainId, (deploymentFor(chainId).usdc as Address))
  const startSqrtPriceX96 = startSqrtPriceX96ForDollarNav(mined.predicted, deploymentFor(chainId).usdc as Address, undefined, usdcDecimals)
  const calls = buildLaunchCalls({
    factory,
    salt: mined.salt,
    name: args.name.trim(),
    symbol: args.symbol.trim().toUpperCase(),
    basket: entries,
    startSqrtPriceX96,
    priceWei,
    feeConfig,
  })
  // decode-back guard: the deploy call must carry the mined salt verbatim (a
  // salt drift means the sent tx deploys to a different address than the
  // predicted one we reviewed) and the name/symbol we intend
  const deployCall = calls.find((c) => c.to.toLowerCase() === factory.toLowerCase())
  if (!deployCall) refuse('internal: the launch batch carries no call to the factory — refusing to return it')
  {
    const d = decodeFunctionData({ abi: factoryDeployAbi, data: deployCall.data }) as { functionName: string; args: readonly unknown[] }
    if (d.functionName !== 'deployBasket') refuse('internal: the factory call is not deployBasket — refusing')
    if (String(d.args[0]).toLowerCase() !== mined.salt.toLowerCase()) refuse('internal: the deploy call carries a different salt than was mined — the sent address would not be the predicted one; refusing')
    if (String(d.args[1]) !== args.name.trim() || String(d.args[2]) !== args.symbol.trim().toUpperCase()) refuse('internal: the deploy call carries a different name/symbol than intended — refusing')
  }

  return {
    calls: calls.map((c) => ({ to: c.to, data: c.data, value: (c.value ?? 0n).toString(), chainId })),
    predicted: mined.predicted,
    review: [
      `REVIEW (the words are the law — read before signing):`,
      `· deploy '${args.name.trim()}' ($${args.symbol.trim().toUpperCase()}) on ${chainCfg(chainId).name} with ${entries.length} legs (${args.weightsPct.join('/')}%)`,
      `· predicted address ${mined.predicted} (CREATE2-mined for THIS deployer — another wallet's send reverts)`,
      `· deploy cost ${formatUnits(priceWei, 18)} native, read from the factory's own currentDeployPrice — the call carries it as maxCost, so a surprise repricing reverts rather than overpays`,
      `· fee config: ${args.basketFeeBps} bps total, creator share ${args.creatorShareBps} bps`,
      `· the first BUY seeds the basket afterwards (spectrum_compose_buy) — this deploy mints nothing by itself`,
      ...(args.supersedes
        ? [
            `· VERSION LINK: this is meant as the next version of ${args.supersedes}. Spectrum versioning is a DEPLOYER-SIGNED metadata claim, not an on-chain pointer — so AFTER the deploy lands, the same deployer signs a \`supersedes\` = ${args.supersedes} metadata claim for the new basket and publishes it (the kit's creator-metadata path). Only then does the lineage graph show this as the successor and holders of ${args.supersedes} migrate to it. This deploy call does NOT itself create the link.`,
          ]
        : []),
      `· this server holds no keys and has sent nothing`,
    ],
  }
}
