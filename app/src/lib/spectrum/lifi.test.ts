import { describe, expect, it } from 'vitest'
import { parseLifiQuote, LifiQuoteError, LIFI_NATIVE } from './lifi'
import type { Address } from 'viem'

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const DIAMOND = '0xB477751B76CF82d00a686A1232f5fCD772414Af3'

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
