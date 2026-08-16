import { describe, expect, it } from 'vitest'
import { BENTO_DUST_USD } from './found-book'
import { payTokenFromHoldings, type PayPrefillContext } from './pay-prefill'
import type { RawHolding } from './raw-holdings'

const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

// Real hex addresses, one per symbol: an ERC-20 pay token is only ever seated
// for an address that actually validates, so the fixtures have to be valid.
const addrs = new Map<string, string>()
const addrFor = (symbol: string): string => {
  if (!addrs.has(symbol)) addrs.set(symbol, `0x${(addrs.size + 1).toString(16).padStart(40, '0')}`)
  return addrs.get(symbol) as string
}

const h = (symbol: string, usd: number | null, over: Partial<RawHolding> = {}): RawHolding => ({
  chainId: 8453,
  address: addrFor(symbol),
  symbol,
  decimals: 18,
  amount: 1,
  usd,
  ...over,
})

const ctx = (over: Partial<PayPrefillContext> = {}): PayPrefillContext => ({
  chainId: 8453,
  hubChoices: ['ETH', 'USDC', 'WETH'],
  anyTokenPay: true,
  weth: WETH,
  usdc: USDC,
  ...over,
})

describe('the pay side opens on what you hold (owner QOL round 2026-08-05)', () => {
  it('picks the largest PRICED holding', () => {
    const out = payTokenFromHoldings([h('SMALL', 20), h('BIG', 900), h('MID', 100)], ctx())
    expect(out).toEqual({ kind: 'erc20', address: addrFor('BIG'), symbol: 'BIG', decimals: 18, chainId: 8453 })
  })

  it('an UNPRICED holding is never "biggest" — priced always wins, however small', () => {
    const out = payTokenFromHoldings(
      [h('WHALE', null, { amount: 1_000_000 }), h('TINY', 1.5)],
      ctx(),
    )
    expect(out).toMatchObject({ symbol: 'TINY' })
  })

  it('nothing priced on this network: null, so the caller keeps its own default', () => {
    expect(payTokenFromHoldings([h('A', null), h('B', null)], ctx())).toBeNull()
    expect(payTokenFromHoldings([], ctx())).toBeNull()
  })

  it('dust is never suggested (below the book’s tile floor)', () => {
    expect(payTokenFromHoldings([h('CRUMB', BENTO_DUST_USD - 0.5)], ctx())).toBeNull()
    expect(payTokenFromHoldings([h('EDGE', BENTO_DUST_USD)], ctx())).toMatchObject({ symbol: 'EDGE' })
  })

  it('a held hub asset seats as the HUB, never as a custom token', () => {
    expect(payTokenFromHoldings([h('ETH', 900, { address: NATIVE, native: true })], ctx())).toEqual({
      kind: 'hub',
      hub: 'ETH',
    })
    expect(payTokenFromHoldings([h('WETH', 900, { address: WETH })], ctx())).toEqual({ kind: 'hub', hub: 'WETH' })
    expect(payTokenFromHoldings([h('USDC', 900, { address: USDC, decimals: 6 })], ctx())).toEqual({
      kind: 'hub',
      hub: 'USDC',
    })
    // checksummed vs lowercase is the same asset
    expect(payTokenFromHoldings([h('WETH', 900, { address: WETH.toUpperCase().replace('0X', '0x') })], ctx())).toEqual({
      kind: 'hub',
      hub: 'WETH',
    })
  })

  it('a hub this chain cannot execute is stepped past, not seated', () => {
    const out = payTokenFromHoldings(
      [h('WETH', 900, { address: WETH }), h('ALT', 100)],
      ctx({ hubChoices: ['USDC'] }),
    )
    expect(out).toMatchObject({ symbol: 'ALT' })
    // and with nothing else payable, the default simply stands
    expect(payTokenFromHoldings([h('WETH', 900, { address: WETH })], ctx({ hubChoices: ['USDC'] }))).toBeNull()
  })

  it('an ERC-20 is only seated where the any-token pay path exists', () => {
    const holdings = [h('ALT', 900), h('ETH', 100, { address: NATIVE, native: true })]
    expect(payTokenFromHoldings(holdings, ctx({ anyTokenPay: false }))).toEqual({ kind: 'hub', hub: 'ETH' })
    expect(payTokenFromHoldings(holdings, ctx({ anyTokenPay: true }))).toMatchObject({ symbol: 'ALT' })
  })

  it('only the ACTIVE chain counts — an address means nothing off its chain', () => {
    const out = payTokenFromHoldings([h('ELSEWHERE', 900, { chainId: 1 }), h('HERE', 10)], ctx())
    expect(out).toMatchObject({ symbol: 'HERE', chainId: 8453 })
  })

  it('excluded addresses and basket rows are never the pay side', () => {
    const basket = h('IXBIG', 900, { basket: true })
    const excluded = h('EXCL', 800)
    const out = payTokenFromHoldings([basket, excluded, h('OK', 5)], ctx({ exclude: [excluded.address.toUpperCase()] }))
    expect(out).toMatchObject({ symbol: 'OK' })
  })

  it('a token claiming absurd decimals is unreadable, not payable', () => {
    const out = payTokenFromHoldings([h('EVIL', 900, { decimals: 1e6 }), h('OK', 5)], ctx())
    expect(out).toMatchObject({ symbol: 'OK' })
  })
})
