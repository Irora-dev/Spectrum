import { describe, expect, it } from 'vitest'
import { parseEther, type Address, type Hex } from 'viem'
import type { LifiQuote } from './lifi'
import { LIFI_NATIVE } from './lifi'
import type { PendingBridge } from './bridge-pending'
import { deploymentFor } from '../chain/deployments'
import { DEFAULT_SLIPPAGE_BPS } from './hook-data'
import {
  refuelFromTokenUnits,
  resolveSettlementLeg,
  runBridgeLeg,
  REFUEL_USD_MAX,
  REFUEL_USD_MIN,
  type BridgeLegEffects,
  type BridgeLegExec,
  type BridgeLegPhase,
} from './use-bridge-leg'

// ─────────────────────────────────────────────────────────────────────────────
// THE EXTRACTED BRIDGE EXECUTOR, PINNED. BridgeFund's laws lived only in a
// component no test could reach (node suite, no DOM); the extraction's whole
// point is that the thesis run rides the SAME path — so the machine is pinned
// here against a scripted wallet, step order and all. What matters most:
// the fresh quote precedes every wallet call; the approval is exactly the
// quote's spender for exactly the amount; the send carries the quoted tx
// VERBATIM with an explicit chainId; the pending row lands before 'sent'; and
// a closed surface between approval and signature stops the money.
// ─────────────────────────────────────────────────────────────────────────────

const HOLDER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address
const FROM_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const TO_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const SPENDER = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address
const TX = ('0x' + 'ab'.repeat(32)) as Hex

const QUOTE: LifiQuote = {
  tool: 'across',
  toAmount: 249_100_000n,
  toAmountMin: 248_000_000n,
  approvalAddress: SPENDER,
  tx: { to: SPENDER, data: '0xdeadbeef' as Hex, value: 0n, gasLimit: 250_000n },
  nativeFeeRaw: 0n,
  gasCostUsd: 0.42,
  etaSec: null,
  crossChain: true,
}

interface Script {
  quote?: LifiQuote | Error
  allowance?: bigint
  nativeUsd?: number | null
  /** Latch isClosed() true once the (first) approval lands — the mid-flight exit. */
  closeAfterApprove?: boolean
  sendError?: unknown
}

function makeFx(script: Script = {}) {
  const calls = {
    quotes: [] as Parameters<BridgeLegEffects['fetchQuote']>[0][],
    allowanceReads: [] as { chainId: number; token: Address; holder: Address; spender: Address }[],
    approvals: [] as { chainId: number; token: Address; spender: Address; value: bigint }[],
    waits: [] as [number, Hex][],
    sends: [] as { to: Address; data: Hex; value: bigint; gas?: bigint; chainId: number }[],
    bridges: [] as PendingBridge[],
    priceReads: [] as number[],
  }
  const phases: BridgeLegPhase[] = []
  let closed = false
  const fx: BridgeLegEffects = {
    fetchQuote: (args) => {
      calls.quotes.push(args)
      if (script.quote instanceof Error) return Promise.reject(script.quote)
      return Promise.resolve(script.quote ?? QUOTE)
    },
    readAllowance: (a) => {
      calls.allowanceReads.push(a)
      return Promise.resolve(script.allowance ?? 0n)
    },
    approve: (a) => {
      calls.approvals.push(a)
      if (script.closeAfterApprove) closed = true
      return Promise.resolve(('0x' + 'aa'.repeat(32)) as Hex)
    },
    waitForReceipt: (chainId, hash) => {
      calls.waits.push([chainId, hash])
      return Promise.resolve()
    },
    sendTransaction: (tx) => {
      calls.sends.push(tx)
      if (script.sendError) return Promise.reject(script.sendError)
      return Promise.resolve(TX)
    },
    recordBridge: (row) => {
      calls.bridges.push(row)
    },
    nativeUsd: (chainId) => {
      calls.priceReads.push(chainId)
      return Promise.resolve(script.nativeUsd === undefined ? 2500 : script.nativeUsd)
    },
    isClosed: () => closed,
    setPhase: (p) => {
      phases.push(p)
    },
    now: () => 1_754_000_000_000,
  }
  return { fx, calls, phases }
}

const leg = (over: Partial<BridgeLegExec> = {}): BridgeLegExec => ({
  fromChainId: 8453,
  toChainId: 1,
  fromToken: { address: FROM_USDC, symbol: 'USDC', decimals: 6 },
  toTokenAddress: TO_USDC,
  amountRaw: 250_000_000n,
  holder: HOLDER,
  ...over,
})

describe('runBridgeLeg — the money path, step by step', () => {
  it('ERC-20 happy path: quote → approve exactly the spender/amount → verbatim send → pending row → sent', async () => {
    const { fx, calls, phases } = makeFx({ allowance: 0n })
    const r = await runBridgeLeg(fx, leg())

    expect(r).toEqual({ txHash: TX })
    expect(phases).toEqual(['quoting', 'approving', 'signing', 'sent'])

    // Fresh quote, asked exactly as BridgeFund asks it.
    expect(calls.quotes).toHaveLength(1)
    expect(calls.quotes[0]).toMatchObject({
      chainId: 1,
      fromChainId: 8453,
      fromToken: FROM_USDC,
      toToken: TO_USDC,
      fromAmount: 250_000_000n,
      fromAddress: HOLDER,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    })
    expect('fromAmountForGas' in calls.quotes[0]).toBe(false)

    // Approval: the QUOTE'S spender, the EXACT amount, the SOURCE chain named.
    expect(calls.allowanceReads).toEqual([{ chainId: 8453, token: FROM_USDC, holder: HOLDER, spender: SPENDER }])
    expect(calls.approvals).toEqual([{ chainId: 8453, token: FROM_USDC, spender: SPENDER, value: 250_000_000n }])
    expect(calls.waits).toHaveLength(1)
    expect(calls.waits[0][0]).toBe(8453)

    // The send is the quoted transaction VERBATIM + the explicit source chain.
    expect(calls.sends).toEqual([
      { to: QUOTE.tx.to, data: QUOTE.tx.data, value: QUOTE.tx.value, gas: 250_000n, chainId: 8453 },
    ])

    // The pending row lands immediately, carrying the quote's arrival figure.
    expect(calls.bridges).toHaveLength(1)
    expect(calls.bridges[0]).toMatchObject({
      txHash: TX,
      fromChainId: 8453,
      toChainId: 1,
      holder: HOLDER,
      fromSymbol: 'USDC',
      fromAmountRaw: 250_000_000n,
      fromDecimals: 6,
      quotedToAmountRaw: QUOTE.toAmount,
      startedAt: 1_754_000_000_000,
    })
  })

  it('zero-first when a stale partial allowance stands (approvalPlan), in order', async () => {
    const { fx, calls } = makeFx({ allowance: 5n })
    await runBridgeLeg(fx, leg())
    expect(calls.approvals.map((a) => a.value)).toEqual([0n, 250_000_000n])
    expect(calls.waits).toHaveLength(2)
  })

  it('no approval transaction when the allowance already covers the amount', async () => {
    const { fx, calls, phases } = makeFx({ allowance: 250_000_000n })
    const r = await runBridgeLeg(fx, leg())
    expect(r).toEqual({ txHash: TX })
    expect(calls.approvals).toEqual([])
    expect(phases).toEqual(['quoting', 'approving', 'signing', 'sent'])
  })

  it('native pay: no allowance read, no approvals, value rides verbatim, chainId still explicit', async () => {
    const nativeQuote: LifiQuote = { ...QUOTE, tx: { ...QUOTE.tx, value: 100_000_000_000_000_000n } }
    const { fx, calls, phases } = makeFx({ quote: nativeQuote })
    const r = await runBridgeLeg(
      fx,
      leg({ fromToken: { address: LIFI_NATIVE, symbol: 'ETH', decimals: 18 }, amountRaw: 100_000_000_000_000_000n }),
    )
    expect(r).toEqual({ txHash: TX })
    expect(phases).toEqual(['quoting', 'signing', 'sent'])
    expect(calls.allowanceReads).toEqual([])
    expect(calls.approvals).toEqual([])
    expect(calls.sends[0]).toMatchObject({ value: 100_000_000_000_000_000n, chainId: 8453 })
  })

  it('a surface closed between approval and signature STOPS the money — no send, no row, honest sentence', async () => {
    const { fx, calls, phases } = makeFx({ allowance: 0n, closeAfterApprove: true })
    const r = await runBridgeLeg(fx, leg())
    expect(r).toEqual({ error: 'The transfer was not signed — this screen closed during the approval step.' })
    expect(calls.approvals).toHaveLength(1) // the approval was already paid for…
    expect(calls.sends).toEqual([]) // …but nothing moves after the exit
    expect(calls.bridges).toEqual([])
    expect(phases.at(-1)).toBe('idle')
  })

  it('a quote failure surfaces its own message and settles idle — no wallet contact', async () => {
    const { fx, calls, phases } = makeFx({ quote: new Error('No route for this swap right now (HTTP 500).') })
    const r = await runBridgeLeg(fx, leg())
    expect(r).toEqual({ error: 'No route for this swap right now (HTTP 500).' })
    expect(calls.allowanceReads).toEqual([])
    expect(calls.approvals).toEqual([])
    expect(calls.sends).toEqual([])
    expect(phases.at(-1)).toBe('idle')
  })

  it('a wallet rejection at the send surfaces shortMessage (the human half of a viem error), no pending row', async () => {
    const sendError = Object.assign(new Error('User rejected the request.\nDetails: eth_sendTransaction gunk'), {
      shortMessage: 'User rejected the request.',
    })
    const { fx, calls, phases } = makeFx({ sendError })
    const r = await runBridgeLeg(fx, leg())
    expect(r).toEqual({ error: 'User rejected the request.' })
    expect(calls.bridges).toEqual([])
    expect(phases.at(-1)).toBe('idle')
  })
})

describe('runBridgeLeg — the refuel leg (dest-native wei → from-token units)', () => {
  it('prices the DESTINATION chain native and rides fromAmountForGas on the quote', async () => {
    const { fx, calls } = makeFx({ nativeUsd: 2500 })
    // 0.002 ETH needed on arrival @ $2500 = $5.00 ⇒ 5_000_000 raw (6dp).
    const r = await runBridgeLeg(fx, leg({ refuelWeiNeeded: parseEther('0.002') }))
    expect(r).toEqual({ txHash: TX })
    expect(calls.priceReads).toEqual([1]) // toChainId — the wei being covered live there
    expect(calls.quotes[0].fromAmountForGas).toBe(5_000_000n)
  })

  it('REFUSES when no native price is readable — before the quote, before any wallet call', async () => {
    const { fx, calls, phases } = makeFx({ nativeUsd: null })
    const r = await runBridgeLeg(fx, leg({ refuelWeiNeeded: parseEther('0.002') }))
    expect('error' in r && r.error).toMatch(/could not read a native-gas price/i)
    expect('error' in r && r.error).toMatch(/nothing was sent/i)
    expect(calls.quotes).toEqual([])
    expect(calls.approvals).toEqual([])
    expect(calls.sends).toEqual([])
    expect(phases).toEqual(['quoting', 'idle'])
  })

  it('REFUSES a refuel on a non-settlement pay token — the $1 anchor is the whole conversion', async () => {
    const { fx, calls } = makeFx()
    const r = await runBridgeLeg(
      fx,
      leg({
        fromToken: { address: LIFI_NATIVE, symbol: 'ETH', decimals: 18 },
        refuelWeiNeeded: parseEther('0.002'),
      }),
    )
    expect('error' in r && r.error).toMatch(/settlement-asset bridge/i)
    expect(calls.quotes).toEqual([])
    expect(calls.priceReads).toEqual([])
  })

  it('no refuel asked (absent / null / 0n) ⇒ no price read, no fromAmountForGas on the quote', async () => {
    for (const refuelWeiNeeded of [undefined, null, 0n]) {
      const { fx, calls } = makeFx()
      await runBridgeLeg(fx, leg({ refuelWeiNeeded }))
      expect(calls.priceReads).toEqual([])
      expect('fromAmountForGas' in calls.quotes[0]).toBe(false)
    }
  })
})

describe('refuelFromTokenUnits — the unit seam refuel.ts warns about', () => {
  it('converts wei → USD at the given price → 6dp raw ($5.00 exactly)', () => {
    expect(refuelFromTokenUnits(parseEther('0.002'), 2500)).toBe(5_000_000n)
  })

  it('rounds UP — under-refuel is the wall this exists to close', () => {
    // 0.001111… ETH @ $3000 = $3.3333… ⇒ 3_333_334, never 3_333_333.
    expect(refuelFromTokenUnits(1_111_111_111_111_111n, 3000)).toBe(3_333_334n)
  })

  it(`clamps up to the $${REFUEL_USD_MIN} floor — an overshoot arrives as the user's own gas`, () => {
    expect(refuelFromTokenUnits(parseEther('0.0001'), 2500)).toBe(2_000_000n) // $0.25 asked
  })

  it(`clamps down to the $${REFUEL_USD_MAX} ceiling — an unbounded ask distorts the bridge`, () => {
    expect(refuelFromTokenUnits(parseEther('0.05'), 2500)).toBe(15_000_000n) // $125 asked
  })

  it('an unreadable price is null — the caller must refuse, never guess', () => {
    for (const bad of [null, undefined, Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(refuelFromTokenUnits(parseEther('0.002'), bad)).toBeNull()
    }
  })

  it('zero or negative wei needed is 0n — no refuel, not a $2 minimum ask', () => {
    expect(refuelFromTokenUnits(0n, 2500)).toBe(0n)
    expect(refuelFromTokenUnits(-1n, 2500)).toBe(0n)
  })
})

describe('resolveSettlementLeg — the thesis-run form names no tokens', () => {
  it('resolves both ends to each chain\'s own settlement asset at 6dp', () => {
    const r = resolveSettlementLeg({ fromChainId: 8453, toChainId: 1, amountRaw: 250_000_000n, holder: HOLDER })
    expect(r.ok).toBeTruthy()
    expect(r.ok?.fromToken.address).toBe(deploymentFor(8453).usdc)
    expect(r.ok?.toTokenAddress).toBe(deploymentFor(1).usdc)
    expect(r.ok?.fromToken.decimals).toBe(6)
    expect(r.ok?.fromToken.symbol).toBe('USDC')
    expect(r.ok?.amountRaw).toBe(250_000_000n)
    expect(r.ok?.holder).toBe(HOLDER)
  })

  it('carries the refuel ask through untouched — conversion happens at run time, priced fresh', () => {
    const r = resolveSettlementLeg({
      fromChainId: 8453,
      toChainId: 1,
      amountRaw: 1n,
      holder: HOLDER,
      refuelWeiNeeded: 123n,
    })
    expect(r.ok?.refuelWeiNeeded).toBe(123n)
  })

  it('an unconfigured chain refuses by name — never a throw, never a guess', () => {
    const r = resolveSettlementLeg({ fromChainId: 999_999, toChainId: 1, amountRaw: 1n, holder: HOLDER })
    expect(r.ok).toBeUndefined()
    expect(r.error).toMatch(/no settlement asset is configured/i)
    expect(r.error).toMatch(/chain 999999/) // unknown id still named, chainCfg's throw contained
  })
})
