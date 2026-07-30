import { describe, expect, it } from 'vitest'
import { hubPay, parseStoredPayToken, serializePayToken, type PayToken } from './pay-token'

const HUBS = ['ETH', 'USDC', 'WETH'] as const
const ADDR = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'

describe('pay-token storage codec (localStorage is hostile input)', () => {
  it('hub picks persist as the bare legacy names (old values keep working)', () => {
    expect(serializePayToken(hubPay('ETH'))).toBe('ETH')
    expect(parseStoredPayToken('WETH', 8453, HUBS)).toEqual({ kind: 'hub', hub: 'WETH' })
  })

  it('erc20 picks round-trip', () => {
    const t: PayToken = { kind: 'erc20', address: ADDR, symbol: 'NVDA', decimals: 18, chainId: 4663 }
    expect(parseStoredPayToken(serializePayToken(t), 4663, HUBS)).toEqual(t)
  })

  it('a stored erc20 from a DIFFERENT chain is dropped (addresses mean nothing across chains)', () => {
    const t: PayToken = { kind: 'erc20', address: ADDR, symbol: 'NVDA', decimals: 18, chainId: 4663 }
    expect(parseStoredPayToken(serializePayToken(t), 8453, HUBS)).toBeNull()
  })

  it('a hub name the chain cannot execute is dropped', () => {
    expect(parseStoredPayToken('WETH', 4663, ['ETH', 'USDC'])).toBeNull()
  })

  it('rejects malformed / forged payloads instead of guessing', () => {
    for (const raw of [
      null,
      '',
      'erc20:',
      'erc20:{',
      'erc20:{"address":"not-an-address","symbol":"X","decimals":18,"chainId":1}',
      `erc20:{"address":"${ADDR}","symbol":"","decimals":18,"chainId":1}`,
      `erc20:{"address":"${ADDR}","symbol":"${'A'.repeat(25)}","decimals":18,"chainId":1}`,
      `erc20:{"address":"${ADDR}","symbol":"OK","decimals":1.5,"chainId":1}`,
      `erc20:{"address":"${ADDR}","symbol":"OK","decimals":99,"chainId":1}`,
      `erc20:{"address":"${ADDR}","symbol":"OK","decimals":18,"chainId":"1"}`,
      'DOGE', // not a hub, not an erc20 blob
    ]) {
      expect(parseStoredPayToken(raw, 1, HUBS)).toBeNull()
    }
  })
})
