import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLifiQuoteQuery, parseLifiQuote, LifiQuoteError, LIFI_NATIVE } from './lifi'
import type { Address } from 'viem'

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
// The pinned execution targets (lifi.ts LIFI_TARGETS) — probed live across 10
// route shapes / 4 tools, 2026-07-29. RH has its own; Base + Ethereum share the
// canonical diamond.
const DIAMOND = '0xB477751B76CF82d00a686A1232f5fCD772414Af3'
const DIAMOND_BASE = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const PAYER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address

const asked = { chainId: 4663, fromToken: LIFI_NATIVE, toToken: USDG, fromAmount: 100000000000000000n }

// The shape li.quest actually returned for ETH→USDG on 4663 (2026-07-11).
const good = () => ({
  tool: 'rialto',
  action: {
    fromChainId: 4663,
    toChainId: 4663,
    fromAmount: '100000000000000000',
    fromToken: { address: LIFI_NATIVE },
    toToken: { address: USDG },
    toAddress: PAYER,
  },
  estimate: { toAmount: '180722739', toAmountMin: '179819125', approvalAddress: DIAMOND },
  transactionRequest: { to: DIAMOND, data: '0x736eac0b335c117c', value: '0x16345785d8a0000', gasLimit: '0xd8c5c' },
})

describe('parseLifiQuote (hostile-input guards on the external hub route)', () => {
  it('parses the real response shape', () => {
    const q = parseLifiQuote(good(), asked)
    expect(q.toAmount).toBe(180722739n)
    expect(q.toAmountMin).toBe(179819125n)
    expect(q.approvalAddress.toLowerCase()).toBe(DIAMOND.toLowerCase())
    expect(q.tx.value).toBe(asked.fromAmount) // native pay: value == offered ETH exactly
    expect(q.tx.gasLimit).toBe(0xd8c5cn)
  })

  it('sums estimate.gasCosts to the USD figure LiFi reports (B1: net means net of GAS)', () => {
    const b = good()
    ;(b.estimate as Record<string, unknown>).gasCosts = [
      { amountUSD: '0.0021', type: 'SEND' },
      { amountUSD: '0.30', type: 'APPROVE' },
    ]
    expect(parseLifiQuote(b, asked).gasCostUsd).toBeCloseTo(0.3021, 10)
  })

  it('gas the API does not state is null, never zero (direct wins uncontested)', () => {
    expect(parseLifiQuote(good(), asked).gasCostUsd).toBeNull() // no gasCosts field at all
    const empty = good()
    ;(empty.estimate as Record<string, unknown>).gasCosts = []
    expect(parseLifiQuote(empty, asked).gasCostUsd).toBeNull()
  })

  it('one unreadable gas entry nulls the WHOLE figure — a partial sum understates', () => {
    for (const bad of [{ type: 'SEND' }, { amountUSD: '' }, { amountUSD: '-1' }]) {
      const b = good()
      ;(b.estimate as Record<string, unknown>).gasCosts = [{ amountUSD: '0.30' }, bad]
      expect(parseLifiQuote(b, asked).gasCostUsd).toBeNull()
    }
  })

  it('rejects an execution target that is not the approval spender', () => {
    const b = good()
    b.transactionRequest.to = '0x1111111111111111111111111111111111111111'
    expect(() => parseLifiQuote(b, asked)).toThrow(LifiQuoteError)
  })

  it('rejects a response whose echoed route differs from the request', () => {
    for (const mutate of [
      (b: ReturnType<typeof good>) => (b.action.fromChainId = 8453),
      (b: ReturnType<typeof good>) => (b.action.toToken.address = '0x2222222222222222222222222222222222222222' as Address),
      (b: ReturnType<typeof good>) => (b.action.fromAmount = '999'),
    ]) {
      const b = good()
      mutate(b)
      expect(() => parseLifiQuote(b, asked)).toThrow(LifiQuoteError)
    }
  })

  it('rejects a native-pay transaction whose value is not exactly the offered ETH', () => {
    const b = good()
    b.transactionRequest.value = '0xffffffffffffffff' // more than offered
    expect(() => parseLifiQuote(b, asked)).toThrow(LifiQuoteError)
  })

  it('rejects nonzero value on ERC-20 pay', () => {
    const erc20Asked = { ...asked, fromToken: '0x020bfc650a365f8bb26819deaabf3e21291018b4' as Address }
    const b = good()
    b.action.fromToken.address = erc20Asked.fromToken
    // value still carries ETH → must be rejected (ERC-20 pay sends no value)
    expect(() => parseLifiQuote(b, erc20Asked)).toThrow(LifiQuoteError)
  })

  it('rejects zero-output quotes', () => {
    const b = good()
    b.estimate.toAmountMin = '0'
    expect(() => parseLifiQuote(b, asked)).toThrow(LifiQuoteError)
  })
})

// ── CROSS-CHAIN pay side (owner 2026-07-29) ──────────────────────────────────
// Widening which chains are legal must not widen the strictness: both ends still
// have to echo exactly what was asked, and a same-chain caller must be unable to
// be handed a cross-chain route (that is how funds would silently go missing —
// the source receipt would look fine while nothing ever arrived).
describe('parseLifiQuote — cross-chain', () => {
  const crossAsked = { ...asked, fromChainId: 8453 } // pay on Base, deliver on 4663
  const crossGood = () => {
    const b = good()
    b.action.fromChainId = 8453
    // signing happens on Base → the Base diamond is the only legal target
    b.estimate.approvalAddress = DIAMOND_BASE
    b.transactionRequest.to = DIAMOND_BASE
    return b
  }

  it('accepts a route whose ends match the asked from/to chains, and flags it crossChain', () => {
    const q = parseLifiQuote(crossGood(), crossAsked)
    expect(q.crossChain).toBe(true)
    expect(q.toAmountMin).toBeGreaterThan(0n)
  })

  it('keeps same-chain routes unflagged (no behaviour change for existing callers)', () => {
    expect(parseLifiQuote(good(), asked).crossChain).toBe(false)
  })

  it('REFUSES a cross-chain route offered to a same-chain request', () => {
    // The dangerous direction: the caller expects settlement in its own tx.
    expect(() => parseLifiQuote(crossGood(), asked)).toThrow(LifiQuoteError)
  })

  it('REFUSES a same-chain route offered to a cross-chain request', () => {
    expect(() => parseLifiQuote(good(), crossAsked)).toThrow(LifiQuoteError)
  })

  it('REFUSES a route that silently redirects the destination chain', () => {
    const b = crossGood()
    b.action.toChainId = 1
    expect(() => parseLifiQuote(b, crossAsked)).toThrow(LifiQuoteError)
  })

  it('still enforces target == approval spender across chains', () => {
    const b = crossGood()
    b.transactionRequest.to = '0x000000000000000000000000000000000000dEaD'
    expect(() => parseLifiQuote(b, crossAsked)).toThrow(LifiQuoteError)
  })
})

describe('parseLifiStatus — delivery is never guessed', () => {
  it('DONE with a real received amount is a delivery', async () => {
    const { parseLifiStatus } = await import('./lifi')
    const r = parseLifiStatus({ status: 'DONE', receiving: { amount: '180000000' } })
    expect(r).toEqual({ state: 'done', toAmount: 180000000n })
  })

  it('DONE but REFUNDED is NOT a delivery', async () => {
    const { parseLifiStatus } = await import('./lifi')
    expect(parseLifiStatus({ status: 'DONE', substatus: 'REFUNDED' }).state).toBe('refunded')
  })

  it('DONE with no amount is unknown, never a zero delivery', async () => {
    const { parseLifiStatus } = await import('./lifi')
    expect(parseLifiStatus({ status: 'DONE' }).state).toBe('unknown')
  })

  it('PENDING and NOT_FOUND are both still in flight', async () => {
    const { parseLifiStatus } = await import('./lifi')
    expect(parseLifiStatus({ status: 'PENDING' }).state).toBe('pending')
    expect(parseLifiStatus({ status: 'NOT_FOUND' }).state).toBe('pending')
  })

  it('an unreadable body is unknown (retryable), never failed', async () => {
    const { parseLifiStatus } = await import('./lifi')
    expect(parseLifiStatus(null).state).toBe('unknown')
    expect(parseLifiStatus({ status: 'WAT' }).state).toBe('unknown')
  })

  it('FAILED carries a reason', async () => {
    const { parseLifiStatus } = await import('./lifi')
    const r = parseLifiStatus({ status: 'FAILED', substatus: 'INSUFFICIENT_ALLOWANCE' })
    expect(r).toEqual({ state: 'failed', reason: 'INSUFFICIENT_ALLOWANCE' })
  })
})

describe('parseLifiQuote — the execution-target allowlist (redteam F-4)', () => {
  it('REFUSES a well-formed response whose target is not the pinned contract', () => {
    // Every other guard passes: spender === target, route echoes, value exact.
    // This is the compromised-API case: one arbitrary call from the user's EOA.
    const b = good()
    const evil = '0x00000000000000000000000000000000DeaDBeef'
    b.estimate.approvalAddress = evil
    b.transactionRequest.to = evil
    expect(() => parseLifiQuote(b, asked)).toThrow(/unrecognised execution target/)
  })

  it('pins per SOURCE chain: the RH target is illegal for a Base-signed route', () => {
    const b = good()
    b.action.fromChainId = 8453 // signing on Base, RH diamond in the tx
    expect(() => parseLifiQuote(b, { ...asked, fromChainId: 8453 })).toThrow(
      /unrecognised execution target/,
    )
  })

  it('FAILS CLOSED on a chain with no pinned target', () => {
    const b = good()
    b.action.fromChainId = 999_999
    b.action.toChainId = 999_999
    expect(() =>
      parseLifiQuote(b, { ...asked, chainId: 999_999, fromChainId: 999_999 }),
    ).toThrow(/No verified swap-routing contract/)
  })
})

describe('parseLifiQuote — recipient echo (redteam F-5)', () => {
  it('REFUSES a route that delivers to someone else', () => {
    const b = good()
    b.action.toAddress = '0x00000000000000000000000000000000DeaDBeef' as Address
    expect(() => parseLifiQuote(b, { ...asked, fromAddress: PAYER })).toThrow(
      /does not deliver to your wallet/,
    )
  })

  it('accepts the payer as recipient (case-insensitive)', () => {
    const b = good()
    b.action.toAddress = PAYER.toLowerCase() as Address
    expect(parseLifiQuote(b, { ...asked, fromAddress: PAYER }).toAmount).toBeGreaterThan(0n)
  })

  it('is skipped when the caller passes no payer (back-compat)', () => {
    const b = good()
    b.action.toAddress = '0x00000000000000000000000000000000DeaDBeef' as Address
    expect(parseLifiQuote(b, asked).toAmount).toBeGreaterThan(0n)
  })
})

describe('buildLifiQuoteQuery — the refuel seam (bridging ruling 2026-08-02)', () => {
  const base = {
    chainId: 8453,
    fromToken: LIFI_NATIVE,
    toToken: USDG,
    fromAmount: 100000000000000000n,
    fromAddress: PAYER,
    slippageBps: 50,
    fromChainId: 1,
  }

  it('appends fromAmountForGas when positive, alongside an intact base query', () => {
    const q = buildLifiQuoteQuery({ ...base, fromAmountForGas: 2500000000000000n })
    expect(q.get('fromAmountForGas')).toBe('2500000000000000')
    // The refuel must never disturb what the guards downstream rely on.
    expect(q.get('fromChain')).toBe('1')
    expect(q.get('toChain')).toBe('8453')
    expect(q.get('fromAmount')).toBe('100000000000000000')
    expect(q.get('toAddress')).toBe(PAYER)
  })

  it('omits the parameter entirely when unset — coverage is not universal', () => {
    const q = buildLifiQuoteQuery(base)
    expect(q.has('fromAmountForGas')).toBe(false)
  })

  it('omits the parameter at zero — a zero refuel is no refuel, not an ask', () => {
    const q = buildLifiQuoteQuery({ ...base, fromAmountForGas: 0n })
    expect(q.has('fromAmountForGas')).toBe(false)
  })
})

// ── order + integrator (the thesis-run ruling, the owner 2026-08-09) ─────────────
// `order` is a defaulted parameter so the kit-wide preference lives in ONE
// word; `integrator` is the white-label law — the kit ships origin-less, and
// attribution exists only when the operator's own env provides it.
describe('buildLifiQuoteQuery — order and integrator', () => {
  const base = {
    chainId: 8453,
    fromToken: LIFI_NATIVE,
    toToken: USDG,
    fromAmount: 100000000000000000n,
    fromAddress: PAYER,
    slippageBps: 50,
    fromChainId: 1,
  }

  afterEach(() => vi.unstubAllEnvs())

  it('orders CHEAPEST by default (the owner 2026-08-09), without disturbing the base query', () => {
    const q = buildLifiQuoteQuery(base)
    expect(q.get('order')).toBe('CHEAPEST')
    expect(q.get('fromChain')).toBe('1')
    expect(q.get('toChain')).toBe('8453')
    expect(q.get('fromAmount')).toBe('100000000000000000')
  })

  it('a surface can differ deliberately — the parameter overrides the default', () => {
    expect(buildLifiQuoteQuery({ ...base, order: 'FASTEST' }).get('order')).toBe('FASTEST')
  })

  it('omits integrator entirely when the env is absent, empty, or blank — origin-less by design', () => {
    // Stubbed in every branch: the machine running the suite may itself be a
    // deployment with an identity in .env.local (the RH test deploy sets one),
    // and this law is about what the BUILDER does with each env state.
    vi.stubEnv('VITE_LIFI_INTEGRATOR', undefined)
    expect(buildLifiQuoteQuery(base).has('integrator')).toBe(false)
    vi.stubEnv('VITE_LIFI_INTEGRATOR', '')
    expect(buildLifiQuoteQuery(base).has('integrator')).toBe(false)
    vi.stubEnv('VITE_LIFI_INTEGRATOR', '   ')
    expect(buildLifiQuoteQuery(base).has('integrator')).toBe(false)
  })

  it('carries the operator identity when their deployment sets one', () => {
    vi.stubEnv('VITE_LIFI_INTEGRATOR', 'acme-operator')
    expect(buildLifiQuoteQuery(base).get('integrator')).toBe('acme-operator')
  })
})

describe('parseLifiQuote — on-top native fees reconcile, byte-exact (owner 2026-08-16: the RH leg class)', () => {
  // A cross-chain shape: ETH on mainnet → USDG on 4663, tool fee charged in
  // native ON TOP of fromAmount (feeCosts included:false), value = sum.
  const askedX = {
    chainId: 4663,
    fromChainId: 1,
    fromToken: LIFI_NATIVE,
    toToken: USDG,
    fromAmount: 100000000000000000n,
    fromAddress: PAYER,
  }
  const FEE = 2000000000000000n // 0.002 native, on top
  const crossFee = () => {
    const b = good()
    b.action.fromChainId = 1
    b.action.toChainId = 4663
    ;(b.estimate as Record<string, unknown>).approvalAddress = DIAMOND_BASE
    b.transactionRequest.to = DIAMOND_BASE
    ;(b.estimate as Record<string, unknown>).feeCosts = [
      { name: 'relayer', included: false, amount: FEE.toString(), token: { address: LIFI_NATIVE, chainId: 1 } },
    ]
    b.transactionRequest.value = '0x' + (askedX.fromAmount + FEE).toString(16)
    return b
  }

  it('accepts a native pay whose value = principal + the DISCLOSED on-top fee, and carries the fee', () => {
    const q = parseLifiQuote(crossFee(), askedX)
    expect(q.tx.value).toBe(askedX.fromAmount + FEE)
    expect(q.nativeFeeRaw).toBe(FEE)
  })

  it('a fee-free response still parses with nativeFeeRaw 0n (the old exact-equality case)', () => {
    expect(parseLifiQuote(good(), asked).nativeFeeRaw).toBe(0n)
  })

  it('rejects value that exceeds principal WITHOUT a disclosing fee entry — undisclosed wei still dies', () => {
    const b = crossFee()
    ;(b.estimate as Record<string, unknown>).feeCosts = []
    expect(() => parseLifiQuote(b, askedX)).toThrow(/unexpected transaction value/)
  })

  it('an included:true fee never raises the expected value', () => {
    const b = crossFee()
    ;((b.estimate as Record<string, unknown>).feeCosts as Record<string, unknown>[])[0]!.included = true
    // value still claims principal + fee → mismatch → reject
    expect(() => parseLifiQuote(b, askedX)).toThrow(/unexpected transaction value/)
  })

  it('a destination-chain fee entry never rides this transaction value', () => {
    const b = crossFee()
    ;(((b.estimate as Record<string, unknown>).feeCosts as Record<string, unknown>[])[0]!.token as Record<string, unknown>).chainId = 4663
    expect(() => parseLifiQuote(b, askedX)).toThrow(/unexpected transaction value/)
  })

  it('a token pay may carry the on-top native fee as its whole value', () => {
    const b = crossFee()
    b.action.fromToken = { address: USDG }
    b.transactionRequest.value = '0x' + FEE.toString(16)
    const q = parseLifiQuote(b, { ...askedX, fromToken: USDG })
    expect(q.tx.value).toBe(FEE)
    expect(q.nativeFeeRaw).toBe(FEE)
  })

  it('a native "fee" exceeding the principal is rejected outright', () => {
    const b = crossFee()
    const huge = askedX.fromAmount + 1n
    ;((b.estimate as Record<string, unknown>).feeCosts as Record<string, unknown>[])[0]!.amount = huge.toString()
    b.transactionRequest.value = '0x' + (askedX.fromAmount + huge).toString(16)
    expect(() => parseLifiQuote(b, askedX)).toThrow(/native fee exceeds/)
  })

  it('an unreadable fee amount is malformed, never zero', () => {
    const b = crossFee()
    ;((b.estimate as Record<string, unknown>).feeCosts as Record<string, unknown>[])[0]!.amount = 'not-a-number'
    expect(() => parseLifiQuote(b, askedX)).toThrow(/fee costs/)
  })
})
