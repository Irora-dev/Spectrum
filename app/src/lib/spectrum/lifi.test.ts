import { describe, expect, it } from 'vitest'
import { parseLifiQuote, LifiQuoteError, LIFI_NATIVE } from './lifi'
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
