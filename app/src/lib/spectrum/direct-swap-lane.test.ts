import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, type Address, type Hex, type PublicClient } from 'viem'
import {
  backOutWrapperFee,
  directSwapLaneInternals,
  quoteAndComposeDirectSwap,
  type DirectRoute,
} from './direct-swap-lane'
import { directSwapWrapperAbiGen2, directSwapWrapperFor, wrapperFeeRaw, WRAPPER_FEE_BPS } from './direct-swap-wrapper'
import { erc20ApproveAbi } from './abis-v2'
import { packV3Path } from './universal-router'

// ─────────────────────────────────────────────────────────────────────────────
// THE DIRECT-SWAP LANE'S LAWS. The lane composes wrapper money — these pins
// hold the fee rate (40, NEVER the batcher's 25), the pull law (sell + fee),
// the exact-value native law, the quote-is-the-simulation discipline (probe →
// floor → RE-PROVE the floored bytes), and the read-failed refusals.
// Chain 4663's REAL deployment book seats the wrapper these pins compose
// against — a book change that unseats it fails here, which is the point.
// ─────────────────────────────────────────────────────────────────────────────

const CHAIN = 4663
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address // the book's settlement
const LNOC = '0x1111111111111111111111111111111111111111' as Address
const HOLDER = '0x40B1e5818b449Db3A7bb0FE482B5784F77fCD2c0' as Address
const WETH_4663 = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address

const v3BuyRoute = (): DirectRoute => ({
  chainId: CHAIN,
  asset: LNOC,
  assetDecimals: 18,
  direction: 'buy',
  counter: 'settlement',
  route: {
    kind: 'v3',
    path: packV3Path([USDG, WETH_4663, LNOC], [100, 10000]),
    sixField: true,
    hubFee: 100,
    assetFee: 10000,
  },
  depthUsd: 30_000,
})

const v3SellRoute = (): DirectRoute => ({
  ...v3BuyRoute(),
  direction: 'sell',
  route: {
    kind: 'v3',
    path: packV3Path([LNOC, WETH_4663, USDG], [10000, 100]),
    sixField: true,
    hubFee: 100,
    assetFee: 10000,
  },
})

const nativeSellRoute = (): DirectRoute => ({
  ...v3SellRoute(),
  counter: 'native',
  route: {
    kind: 'v4',
    poolKey: { currency0: '0x0000000000000000000000000000000000000000', currency1: LNOC, fee: 10000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000' },
    zeroForOne: false,
    hooked: false,
  },
})

/** A client whose SIMULATE BUNDLE answers from a script — the probe (minBuy=1)
 *  and the proof (floored bytes) are separate bundles, so the script can
 *  disagree between them (the market-moved case). ERC-20 probes ride
 *  simulateCalls([approve, swap]); the recorded entry is the SWAP call of each
 *  bundle plus the approve bytes, so the pins can hold both. Native probes
 *  ride plain eth_call — `call` answers from the same script. */
function scriptedClient(outs: (bigint | Error)[]): {
  client: PublicClient
  calls: { data: Hex; value: bigint | undefined }[]
  approves: { to: Address; data: Hex }[]
} {
  const calls: { data: Hex; value: bigint | undefined }[] = []
  const approves: { to: Address; data: Hex }[] = []
  let i = 0
  const next = () => outs[Math.min(i++, outs.length - 1)]
  const client = {
    call: async (args: { data: Hex; value?: bigint }) => {
      calls.push({ data: args.data, value: args.value })
      const out = next()
      if (out instanceof Error) throw out
      return { data: encodeAbiParameters([{ type: 'uint256' }], [out]) }
    },
    simulateCalls: async (args: { calls: { to: Address; data: Hex; value?: bigint }[] }) => {
      const [approve, swap] = args.calls
      approves.push({ to: approve.to, data: approve.data })
      calls.push({ data: swap.data, value: swap.value })
      const out = next()
      // a scripted Error = the swap call REVERTING inside the simulated
      // block (status failure), which the lane must treat as the revert's
      // own words — never as method-unsupported
      if (out instanceof Error)
        return {
          results: [
            { status: 'success', data: '0x' },
            { status: 'failure', error: out, data: '0x' },
          ],
        }
      return {
        results: [
          { status: 'success', data: '0x' },
          { status: 'success', data: encodeAbiParameters([{ type: 'uint256' }], [out]) },
        ],
      }
    },
  } as unknown as PublicClient
  return { client, calls, approves }
}

describe('backOutWrapperFee — the pull never exceeds the budget', () => {
  it('exact fit: 10,040 backs out to sell 10,000 + fee 40', () => {
    const { sellRaw, feeRaw } = backOutWrapperFee(10_040n, 40)
    expect(sellRaw).toBe(10_000n)
    expect(feeRaw).toBe(40n)
  })
  it('sell + fee(sell) ≤ budget across adversarial remainders (the contract’s own floor division)', () => {
    for (const budget of [1n, 2n, 251n, 9_999n, 10_039n, 10_041n, 123_456_789n, 10n ** 18n + 7n]) {
      const { sellRaw, feeRaw } = backOutWrapperFee(budget, 40)
      expect(sellRaw + feeRaw, `budget ${budget}`).toBeLessThanOrEqual(budget)
      expect(feeRaw, `budget ${budget}`).toBe(wrapperFeeRaw(sellRaw, 40))
      // never degenerate: a positive budget above the fee quantum sells something
      if (budget >= 252n) expect(sellRaw, `budget ${budget}`).toBeGreaterThan(0n)
    }
  })
  it('the strand is BOUNDED: the back-out leaves less than one fee quantum in the wallet, never more (the module’s own documented residual)', () => {
    // maximality is deliberately NOT the law here (measured: budget 39 sells
    // 38 though 39 fits) — conservative under-sell is accepted, but only
    // within one fee quantum (10000/feeBps wei of sell per fee wei).
    for (const budget of [10_040n, 10_041n, 9_999n, 1n, 39n, 40n, 41n, 123_456_789n, 10n ** 18n + 7n]) {
      const { sellRaw, feeRaw } = backOutWrapperFee(budget, 40)
      expect(sellRaw + feeRaw <= budget).toBe(true)
      expect(budget - (sellRaw + feeRaw) <= 10_000n / 40n).toBe(true)
    }
  })
  it('zero and negative budgets sell nothing', () => {
    expect(backOutWrapperFee(0n, 40)).toEqual({ sellRaw: 0n, feeRaw: 0n })
    expect(backOutWrapperFee(-5n, 40)).toEqual({ sellRaw: 0n, feeRaw: 0n })
  })
})

describe('the composed wrapper call — rate 40, pull sell+fee, value exact', () => {
  const wrapper = directSwapWrapperFor(CHAIN)
  it('the book seats the 4663 wrapper these laws compose against', () => {
    expect(wrapper).toBeTruthy()
  })
  it('a settlement-funded BUY composes sellToken=settlement, buyToken=asset, value 0, feeBps 40 — NEVER the batcher’s 25', () => {
    const call = directSwapLaneInternals.wrapperCallFor(v3BuyRoute(), 1_000_000n, 123n, 1_700_000_000)!
    expect(call.to).toBe(wrapper)
    expect(call.value).toBe(0n)
    const dec = decodeFunctionData({ abi: directSwapWrapperAbiGen2, data: call.data })
    expect(dec.functionName).toBe('swapWithFee')
    const [sellToken, sellAmount, buyToken, minBuy, , feeBps] = dec.args as unknown as readonly [Address, bigint, Address, bigint, Hex, number, bigint]
    expect(sellToken.toLowerCase()).toBe(USDG.toLowerCase())
    expect(sellAmount).toBe(1_000_000n)
    expect(buyToken.toLowerCase()).toBe(LNOC.toLowerCase())
    expect(minBuy).toBe(123n)
    expect(feeBps).toBe(WRAPPER_FEE_BPS)
    expect(feeBps).toBe(40)
    expect(call.feeRaw).toBe(wrapperFeeRaw(1_000_000n, 40))
  })
  it('a SELL composes sellToken=asset, buyToken=settlement', () => {
    const call = directSwapLaneInternals.wrapperCallFor(v3SellRoute(), 5n * 10n ** 18n, 9_900_000n, 1_700_000_000)!
    const dec = decodeFunctionData({ abi: directSwapWrapperAbiGen2, data: call.data })
    const [sellToken, , buyToken] = dec.args as unknown as readonly [Address, bigint, Address]
    expect(sellToken.toLowerCase()).toBe(LNOC.toLowerCase())
    expect(buyToken.toLowerCase()).toBe(USDG.toLowerCase())
    expect(call.value).toBe(0n)
  })
})

describe('quoteAndComposeDirectSwap — the quote IS the simulation, twice', () => {
  it('probe → floor → the floored bytes RE-PROVEN → the proven bytes returned verbatim', async () => {
    const probed = 2_850_000n * 10n ** 12n
    const { client, calls, approves } = scriptedClient([probed, probed])
    const answer = await quoteAndComposeDirectSwap({
      route: v3BuyRoute(),
      sellAmountRaw: 1_000_000n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      client,
    })
    expect(answer.ok, answer.ok ? '' : answer.reason).toBe(true)
    if (!answer.ok) return
    const wantFloor = (probed * 9_700n) / 10_000n
    expect(answer.swap.minBuyRaw).toBe(wantFloor)
    expect(answer.swap.probedOutRaw).toBe(probed)
    // the returned bytes ARE the floored bytes the second call proved
    const dec = decodeFunctionData({ abi: directSwapWrapperAbiGen2, data: answer.swap.call.data })
    expect((dec.args as unknown as readonly [Address, bigint, Address, bigint])[3]).toBe(wantFloor)
    expect(calls).toHaveLength(2)
    const probeDec = decodeFunctionData({ abi: directSwapWrapperAbiGen2, data: calls[0].data })
    expect((probeDec.args as unknown as readonly [Address, bigint, Address, bigint])[3]).toBe(1n) // the probe floors at 1 wei
    // the displayed-vs-signed tuple carries the same floor and the fee rate
    expect(answer.swap.shown.minBuyRaw).toBe(wantFloor)
    expect(answer.swap.shown.feeBps).toBe(40)
    // the ERC-20 pull's exact approval: sell + fee, to the wrapper
    expect(answer.swap.approval).toEqual({
      token: USDG,
      spender: directSwapWrapperFor(CHAIN),
      amountRaw: 1_000_000n + wrapperFeeRaw(1_000_000n, 40),
    })
    // …and the SIMULATED bundle's own approve carries the same pull to the
    // same spender on the sold token (the bundle IS the storage-layout-free
    // proof, so its approve must match what execution will really grant)
    expect(approves).toHaveLength(2) // probe bundle + proof bundle
    expect(approves[0].to.toLowerCase()).toBe(USDG.toLowerCase())
    const apDec = decodeFunctionData({ abi: erc20ApproveAbi, data: approves[0].data })
    expect((apDec.args as readonly [Address, bigint])[0]).toBe(directSwapWrapperFor(CHAIN))
    expect((apDec.args as readonly [Address, bigint])[1]).toBe(1_000_000n + wrapperFeeRaw(1_000_000n, 40))
  })
  it('the PLAN’S floor RAISES the signed floor — never the double-haircut that lost the race (the CASHCAT lesson)', async () => {
    // probe 2,858; own haircut 2,772; the plan floors at 2,778 — the lane
    // must sign 2,778 (the plan's number, wrapper-enforced) and RIDE
    const probed = 2_858_000_000n
    const planFloor = 2_778_000_000n
    const { client } = scriptedClient([probed, probed])
    const answer = await quoteAndComposeDirectSwap({
      route: v3SellRoute(),
      sellAmountRaw: 5n * 10n ** 18n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      minFloorRaw: planFloor,
      client,
    })
    expect(answer.ok, answer.ok ? '' : answer.reason).toBe(true)
    if (!answer.ok) return
    expect(answer.swap.minBuyRaw).toBe(planFloor)
    const dec = decodeFunctionData({ abi: directSwapWrapperAbiGen2, data: answer.swap.call.data })
    expect((dec.args as unknown as readonly [Address, bigint, Address, bigint])[3]).toBe(planFloor)
  })
  it('a probe UNDER the plan’s floor refuses in the plan’s words — the routed lanes may still clear it', async () => {
    const { client, calls } = scriptedClient([2_700_000_000n])
    const answer = await quoteAndComposeDirectSwap({
      route: v3SellRoute(),
      sellAmountRaw: 5n * 10n ** 18n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      minFloorRaw: 2_778_000_000n,
      client,
    })
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.reason).toMatch(/does not cover the plan’s floor/)
    expect(calls).toHaveLength(1) // refused before any floored proof call
  })
  it('a probe EXACTLY AT the plan’s floor RIDES — the wrapper’s own exact-floor law, in this lane’s suite (audit :531)', async () => {
    const planFloor = 2_778_000_000n
    const { client } = scriptedClient([planFloor, planFloor])
    const answer = await quoteAndComposeDirectSwap({
      route: v3SellRoute(),
      sellAmountRaw: 5n * 10n ** 18n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      minFloorRaw: planFloor,
      client,
    })
    expect(answer.ok, answer.ok ? '' : answer.reason).toBe(true)
    if (!answer.ok) return
    expect(answer.swap.minBuyRaw).toBe(planFloor)
  })
  it('the composed deadline is exactly now + 1200 — never the past, never past the wrapper’s day (audit :324/:333)', async () => {
    const probed = 2_850_000n * 10n ** 12n
    const { client } = scriptedClient([probed, probed])
    const nowSec = 1_700_000_000
    const answer = await quoteAndComposeDirectSwap({ route: v3BuyRoute(), sellAmountRaw: 1_000_000n, slippageBps: 300, holder: HOLDER, nowSec, client })
    expect(answer.ok, answer.ok ? '' : answer.reason).toBe(true)
    if (!answer.ok) return
    const dec = decodeFunctionData({ abi: directSwapWrapperAbiGen2, data: answer.swap.call.data })
    const deadline = (dec.args as unknown as readonly [Address, bigint, Address, bigint, Hex, number, bigint])[6]
    expect(deadline).toBe(BigInt(nowSec + 1200))
  })
  it('a plan floor BELOW the haircut never lowers it — the stronger protection signs', async () => {
    const probed = 1_000_000n
    const { client } = scriptedClient([probed, probed])
    const answer = await quoteAndComposeDirectSwap({
      route: v3BuyRoute(),
      sellAmountRaw: 1_000_000n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      minFloorRaw: 1n,
      client,
    })
    expect(answer.ok, answer.ok ? '' : answer.reason).toBe(true)
    if (!answer.ok) return
    expect(answer.swap.minBuyRaw).toBe((probed * 9_700n) / 10_000n)
  })

  it('a proof that lands UNDER the floor refuses — the market moved between quote and proof', async () => {
    const probed = 1_000_000n
    const { client } = scriptedClient([probed, (probed * 9_700n) / 10_000n - 1n])
    const answer = await quoteAndComposeDirectSwap({
      route: v3BuyRoute(),
      sellAmountRaw: 1_000_000n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      client,
    })
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.reason).toMatch(/market moved between the quote and its proof/)
  })
  it('a probe that reverts refuses in the simulation’s own words — nothing composes off an error', async () => {
    const { client } = scriptedClient([new Error('execution reverted: SliceOutOfBounds')])
    const answer = await quoteAndComposeDirectSwap({
      route: v3BuyRoute(),
      sellAmountRaw: 1_000_000n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      client,
    })
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.reason).toMatch(/did not survive its own live simulation/)
  })
  it('a native-proceeds SELL refuses by construction — the wrapper cannot deliver native out', async () => {
    const { client, calls } = scriptedClient([1n])
    const answer = await quoteAndComposeDirectSwap({
      route: nativeSellRoute(),
      sellAmountRaw: 10n ** 18n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      client,
    })
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.reason).toMatch(/cannot deliver native proceeds/)
    expect(calls).toHaveLength(0) // refused before any call — by construction, not by probe
  })
  it('zero and negative amounts refuse before any call', async () => {
    const { client, calls } = scriptedClient([1n])
    for (const amt of [0n, -1n]) {
      const answer = await quoteAndComposeDirectSwap({
        route: v3BuyRoute(),
        sellAmountRaw: amt,
        slippageBps: 300,
        holder: HOLDER,
        nowSec: 1_700_000_000,
        client,
      })
      expect(answer.ok).toBe(false)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('the restricted-token degrade — feeless ONLY when the token refuses the wrapper AND the router proves', () => {
  const hookedBuyRoute = (): DirectRoute => ({
    chainId: CHAIN,
    asset: LNOC,
    assetDecimals: 18,
    direction: 'buy',
    counter: 'native',
    route: {
      kind: 'v4',
      poolKey: { currency0: '0x0000000000000000000000000000000000000000', currency1: LNOC, fee: 0, tickSpacing: 60, hooks: '0x2C67ebA8A50AF0dB5Fba55F725247a75CbDA6444' },
      zeroForOne: true,
      hooked: true,
    },
    depthUsd: 900_000,
  })
  /** wrapper probe reverts; the quoter answers; the direct-UR call passes/fails per script */
  function degradeClient(quoted: bigint, urPasses: boolean): { client: PublicClient; urCalls: { to: Address; data: Hex; value?: bigint }[] } {
    const urCalls: { to: Address; data: Hex; value?: bigint }[] = []
    const client = {
      call: async (args: { to: Address; data: Hex; value?: bigint }) => {
        // the wrapper probe (native input rides plain eth_call) and the
        // degrade's UR proof both land here — split by target
        if (args.to.toLowerCase() === directSwapWrapperFor(CHAIN)!.toLowerCase()) throw new Error('execution reverted (token transfer rule)')
        urCalls.push(args)
        if (!urPasses) throw new Error('execution reverted')
        return { data: '0x' }
      },
      readContract: async () => [quoted, 0n] as const, // the v4 quoter
    } as unknown as PublicClient
    return { client, urCalls }
  }
  it('wrapper refused + router proven → the DIRECT call, feeless, floor IN the payload, approval null', async () => {
    const { client, urCalls } = degradeClient(64n * 10n ** 18n, true)
    const answer = await quoteAndComposeDirectSwap({
      route: hookedBuyRoute(),
      sellAmountRaw: 10n ** 15n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      client,
    })
    expect(answer.ok, answer.ok ? '' : answer.reason).toBe(true)
    if (!answer.ok) return
    expect(answer.swap.feeless).toBe(true)
    expect(answer.swap.feeBps).toBe(0)
    expect(answer.swap.feeRaw).toBe(0n)
    expect(answer.swap.approval).toBe(null)
    expect(answer.swap.shown.feeBps).toBe(0)
    const wantFloor = (64n * 10n ** 18n * 9_700n) / 10_000n
    expect(answer.swap.minBuyRaw).toBe(wantFloor)
    // the signed bytes ARE the proven direct-router bytes, value = amountIn
    // EXACTLY (no fee on top — there is no wrapper in this call)
    expect(urCalls).toHaveLength(1)
    expect(answer.swap.call.to).toBe(urCalls[0].to)
    expect(answer.swap.call.data).toBe(urCalls[0].data)
    expect(answer.swap.call.value).toBe(10n ** 15n)
  })
  it('wrapper refused + router ALSO refused → the refusal stands (no feeless invention)', async () => {
    const { client } = degradeClient(64n * 10n ** 18n, false)
    const answer = await quoteAndComposeDirectSwap({
      route: hookedBuyRoute(),
      sellAmountRaw: 10n ** 15n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      client,
    })
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.reason).toMatch(/did not survive its own live simulation/)
  })
  it('a SETTLEMENT-funded route never degrades feeless — the rung is native-v4-buy only', async () => {
    const { client, urCalls } = degradeClient(64n * 10n ** 18n, true)
    // v3 settlement route whose probe reverts (the wrapper target throws in
    // this client for ANY sim — simulateCalls is absent, plain call throws)
    const answer = await quoteAndComposeDirectSwap({
      route: v3BuyRoute(),
      sellAmountRaw: 1_000_000n,
      slippageBps: 300,
      holder: HOLDER,
      nowSec: 1_700_000_000,
      client,
    })
    expect(answer.ok).toBe(false)
    expect(urCalls).toHaveLength(0)
  })
})

describe('deepestHubTier — measured, fail-closed', () => {
  const factoryClient = (liquidityByFee: Record<number, bigint | Error>, pools?: Record<number, Address>) =>
    ({
      readContract: async (args: { functionName: string; args?: readonly unknown[] }) => {
        if (args.functionName === 'getPool') {
          const fee = args.args?.[2] as number
          return pools?.[fee] ?? (`0x${(fee + 1).toString(16).padStart(40, '0')}` as Address)
        }
        // liquidity() — keyed by the pool address's embedded fee
        const addr = (args as unknown as { address: Address }).address
        const fee = Number(BigInt(addr)) - 1
        const out = liquidityByFee[fee] ?? 0n
        if (out instanceof Error) throw out
        return out
      },
    }) as unknown as PublicClient
  it('the deepest tier wins', async () => {
    const tier = await directSwapLaneInternals.deepestHubTier(factoryClient({ 100: 5_000n, 500: 9_000n, 3000: 100n, 10000: 0n }), CHAIN)
    expect(tier).toBe(500)
  })
  it('ANY failed read refuses the route whole — a hidden deepest hop must not mis-route the swap', async () => {
    const tier = await directSwapLaneInternals.deepestHubTier(factoryClient({ 100: 5_000n, 500: new Error('rpc'), 3000: 100n, 10000: 0n }), CHAIN)
    expect(tier).toBe(null)
  })
  it('no liquidity anywhere → null', async () => {
    const tier = await directSwapLaneInternals.deepestHubTier(factoryClient({ 100: 0n, 500: 0n, 3000: 0n, 10000: 0n }), CHAIN)
    expect(tier).toBe(null)
  })
})

// keep vitest's unused-import lint honest — vi is used for nothing here today,
// and an accidental global mock in this file would hide a real network call
void vi
