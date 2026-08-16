import { describe, expect, it } from 'vitest'
import { decodeFunctionData, type Address, type Hex } from 'viem'
import { LAUNCH_BATCH_ATOMIC_REQUIRED, buildLaunchCalls } from './launch-batch'
import { sendCallsParams } from './batch-calls'
import { factoryDeployAbi, swapRouterAbi, type FeeConfigInput } from './abis-v2'
import type { DeployBasketEntry } from './deploy'

const FACTORY = '0x00000000000000000000000000000000000000f1' as Address
const ROUTER = '0x00000000000000000000000000000000000000f2' as Address
const USDC = '0x00000000000000000000000000000000000000f3' as Address
const BASKET = '0x0000000000000000000000000000000000000088' as Address
const HOLDER = '0x00000000000000000000000000000000000000f5' as Address
const SALT = `0x${'11'.repeat(32)}` as Hex

const feeConfig: FeeConfigInput = {
  basketFeeBps: 100,
  creatorShareBps: 0,
  creatorPayout: '0x0000000000000000000000000000000000000000',
  launcher: '0x0000000000000000000000000000000000000000',
}

const leg = (asset: string, weight: number): DeployBasketEntry => ({
  asset: asset as Address,
  venue: 1,
  ethPool: {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0x0000000000000000000000000000000000000000',
    fee: 0,
    tickSpacing: 0,
    hooks: '0x0000000000000000000000000000000000000000',
  },
  v3Fee: 3000,
  v2Pair: '0x0000000000000000000000000000000000000000',
  weight,
  decimals: 18,
})

const basket = [leg('0x00000000000000000000000000000000000000a1', 6000), leg('0x00000000000000000000000000000000000000a2', 4000)]

const deployCall = {
  factory: FACTORY,
  salt: SALT,
  name: 'Test',
  symbol: 'TEST',
  basket,
  startSqrtPriceX96: 79228162514264337593543950336n,
  priceWei: 100_000_000_000_000_000n,
  feeConfig,
}

const mintCall = {
  router: ROUTER,
  settlement: USDC,
  basket: BASKET,
  amountRaw: 100_000_000n,
  minOut: 94_050_000_000_000_000_000n,
  hookData: '0xdeadbeef' as Hex,
  to: HOLDER,
}

describe('the launch batch — one ceremony, three calls, in order', () => {
  it('is deploy, then approve, then the first mint', () => {
    const calls = buildLaunchCalls(deployCall, mintCall)
    expect(calls).toHaveLength(3)
    expect(calls[0].to).toBe(FACTORY)
    expect(calls[0].value).toBe(deployCall.priceWei)
    expect(calls[1].to).toBe(USDC) // approve the router for exactly the deposit
    expect(calls[2].to).toBe(ROUTER)
    expect(calls[1].value).toBeUndefined()
    expect(calls[2].value).toBeUndefined()
  })

  it('calls deployBasket with the ARGUMENT TUPLE UNCHANGED — the mined salt depends on it', () => {
    const [deploy] = buildLaunchCalls(deployCall, mintCall)
    const decoded = decodeFunctionData({ abi: factoryDeployAbi, data: deploy.data })
    expect(decoded.functionName).toBe('deployBasket')
    const [salt, name, symbol, entries, startSqrt, maxCost, fees] = decoded.args as unknown as [
      Hex,
      string,
      string,
      { asset: Address; weight: number }[],
      bigint,
      bigint,
      FeeConfigInput,
    ]
    expect(salt).toBe(SALT)
    expect(name).toBe('Test')
    expect(symbol).toBe('TEST')
    expect(startSqrt).toBe(deployCall.startSqrtPriceX96)
    expect(maxCost).toBe(deployCall.priceWei)
    expect(fees.basketFeeBps).toBe(100)
    // The weights ride the arguments, which is what binds them to the CREATE2 address.
    expect(entries.map((e) => e.weight)).toEqual([6000, 4000])
    expect(entries.map((e) => e.asset.toLowerCase())).toEqual(basket.map((e) => e.asset.toLowerCase()))
  })

  it('mints into the PREDICTED address with the same amount it approved', () => {
    const calls = buildLaunchCalls(deployCall, mintCall)
    const mint = decodeFunctionData({ abi: swapRouterAbi, data: calls[2].data })
    expect(mint.functionName).toBe('swapExactIn')
    const [target, tokenIn, amountIn, minOut, hookData, to] = mint.args as [
      Address,
      Address,
      bigint,
      bigint,
      Hex,
      Address,
    ]
    expect(target.toLowerCase()).toBe(BASKET.toLowerCase())
    expect(tokenIn.toLowerCase()).toBe(USDC.toLowerCase())
    expect(amountIn).toBe(mintCall.amountRaw)
    expect(minOut).toBe(mintCall.minOut)
    expect(hookData).toBe(mintCall.hookData)
    expect(to.toLowerCase()).toBe(HOLDER.toLowerCase())
    // the approval covers exactly this pull, no more
    expect(calls[1].data.endsWith(mintCall.amountRaw.toString(16).padStart(64, '0'))).toBe(true)
  })

  it('with no priced first mint it degrades to the deploy alone, never a half-formed mint', () => {
    expect(buildLaunchCalls(deployCall)).toHaveLength(1)
    expect(buildLaunchCalls(deployCall, null)).toHaveLength(1)
  })
})

describe('the launch batch REQUIRES atomicity', () => {
  it('says so, and the reason is that a partial run reopens the window', () => {
    expect(LAUNCH_BATCH_ATOMIC_REQUIRED).toBe(true)
  })

  it('atomicRequired reaches the wire as true for this batch', () => {
    const calls = buildLaunchCalls(deployCall, mintCall)
    const params = sendCallsParams(HOLDER, 8453, calls, LAUNCH_BATCH_ATOMIC_REQUIRED)
    expect(params.atomicRequired).toBe(true)
    expect(params.chainId).toBe('0x2105')
    expect((params.calls as unknown[]).length).toBe(3)
  })

  it('the deploy call keeps its value on the wire, the others carry none', () => {
    const params = sendCallsParams(HOLDER, 8453, buildLaunchCalls(deployCall, mintCall), true)
    const wire = params.calls as { to: Address; value?: string }[]
    expect(wire[0].value).toBe('0x16345785d8a0000') // 0.1 ETH auction slot
    expect(wire[1].value).toBeUndefined()
    expect(wire[2].value).toBeUndefined()
  })

  it('the independent-calls default is unchanged: false unless a batch asks', () => {
    // The crank sweep is better off partially landing. Only a batch whose calls are
    // one ceremony opts in.
    expect(sendCallsParams(HOLDER, 8453, [], false).atomicRequired).toBe(false)
  })
})
