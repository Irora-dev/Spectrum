import { describe, expect, it } from 'vitest'
import { domainSeparator, hashTypedData } from 'viem'
import {
  buildLimitOrder,
  buildQuoteRequest,
  COW_NATIVE_BUY,
  COW_ORDER_TYPES,
  COW_SETTLEMENT,
  COW_VAULT_RELAYER,
  appDataRefusal,
  cowApiBase,
  cowDomain,
  COW_CHAIN_IDS,
  cowSupportsChain,
  isTerminalCowStatus,
  limitOrderRefusal,
  limitOrderTypedData,
  orderPostBody,
  schemeForSignature,
  SPECTRUM_APP_DATA,
} from './cow'
import { COW_LIMIT_CHAIN_IDS } from './allocation'

const WETH = '0x4200000000000000000000000000000000000006' as const
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
// Checksummed with `cast to-check-sum-address`, not hand-cased: viem's typed-data
// validator REJECTS a mixed-case address whose checksum is wrong, so a sloppy
// fixture fails at hashing rather than at review. (It bit me writing this file.)
const OWNER = '0x182e54f8011cb15887764E6D4a658cD9b96c8d8F' as const
const APP: `0x${string}` = `0x${'11'.repeat(32)}`

const base = {
  sellToken: WETH,
  buyToken: USDC,
  owner: OWNER,
  sellAmountRaw: 1_000000000000000000n,
  minBuyAmountRaw: 4000_000000n,
  validForSec: 3600,
  nowSec: 1_780_000_000,
  appData: APP,
}

describe('cow: chain support', () => {
  it('supports mainnet and Base', () => {
    expect(cowSupportsChain(1)).toBe(true)
    expect(cowSupportsChain(8453)).toBe(true)
  })

  // The whole reason channelExecutable has to become chain-aware. Probed
  // 2026-08-02: settlement, ComposableCoW and the TWAP handler all read NO CODE
  // on 4663, so an order posted there could never be filled by anyone.
  it('does NOT support Robinhood 4663, where CoW is not deployed', () => {
    expect(cowSupportsChain(4663)).toBe(false)
  })

  // DRIFT GUARD. allocation.ts keeps its own copy of this list so it can stay
  // dependency-free, which means two sources of truth for "where can a limit
  // order fill". If they ever disagree, the flow offers a channel the rail
  // cannot serve, or hides one it can. Pin them equal.
  it('agrees with the channel gate in allocation.ts', () => {
    expect([...COW_LIMIT_CHAIN_IDS].sort()).toEqual([...COW_CHAIN_IDS].sort())
  })

  it('has an api host for every supported chain', () => {
    expect(cowApiBase(1)).toContain('mainnet')
    expect(cowApiBase(8453)).toContain('base')
  })
})

describe('cow: the EIP-712 domain', () => {
  // THE ANCHOR TEST. This exact value was read from the deployed contract with
  // `cast call 0x9008…ab41 "domainSeparator()(bytes32)"` on Base, 2026-08-02.
  // If this ever fails, our signatures are being produced against a domain the
  // settlement contract does not recognise, and every order would be rejected.
  it('reproduces the ON-CHAIN domainSeparator for Base', () => {
    expect(domainSeparator({ domain: cowDomain(8453) })).toBe(
      '0xd72ffa789b6fae41254d0b5a13e6e1e92ed947ec6a251edf1cf0b6c02c257b4b',
    )
  })

  it('is chain-separated, so a Base signature cannot be replayed on mainnet', () => {
    expect(domainSeparator({ domain: cowDomain(1) })).not.toBe(domainSeparator({ domain: cowDomain(8453) }))
  })

  it('verifies against the settlement contract, not the vault relayer', () => {
    expect(cowDomain(8453).verifyingContract).toBe(COW_SETTLEMENT)
    expect(COW_VAULT_RELAYER).not.toBe(COW_SETTLEMENT)
  })
})

describe('cow: building a limit order', () => {
  it('signs the USER’s price as buyAmount, never a quote', () => {
    const o = buildLimitOrder(base)
    expect(o.buyAmount).toBe('4000000000')
    expect(o.sellAmount).toBe('1000000000000000000')
    expect(o.kind).toBe('sell')
  })

  it('expires at now + validFor', () => {
    expect(buildLimitOrder(base).validTo).toBe(1_780_003_600)
  })

  it('carries a zero feeAmount (solver-determined since the fee overhaul)', () => {
    expect(buildLimitOrder(base).feeAmount).toBe('0')
  })

  it('defaults the receiver to the owner and never to anything else', () => {
    expect(buildLimitOrder(base).receiver).toBe(OWNER)
  })

  it('honours an explicit receiver when one is given', () => {
    const to = '0x00000000000000000000000000000000DeaDBeef' as const
    expect(buildLimitOrder({ ...base, receiver: to }).receiver).toBe(to)
  })

  it('is partially fillable by default', () => {
    expect(buildLimitOrder(base).partiallyFillable).toBe(true)
    expect(buildLimitOrder({ ...base, partiallyFillable: false }).partiallyFillable).toBe(false)
  })
})

describe('cow: refusals — an order that is wrong must never become signable', () => {
  it('refuses a token for itself', () => {
    expect(limitOrderRefusal({ ...base, buyToken: WETH })).toMatch(/itself/i)
  })

  // Native ETH is buyable but NOT sellable on this rail. Without this guard the
  // order signs fine and simply never fills.
  it('refuses SELLING native ETH and names WETH as the fix', () => {
    expect(limitOrderRefusal({ ...base, sellToken: COW_NATIVE_BUY })).toMatch(/WETH/)
  })

  it('allows BUYING native ETH', () => {
    expect(limitOrderRefusal({ ...base, buyToken: COW_NATIVE_BUY })).toBeNull()
  })

  it('refuses a zero or negative size, and a zero price', () => {
    expect(limitOrderRefusal({ ...base, sellAmountRaw: 0n })).toBeTruthy()
    expect(limitOrderRefusal({ ...base, minBuyAmountRaw: 0n })).toBeTruthy()
  })

  it('refuses an expiry that has already passed', () => {
    expect(limitOrderRefusal({ ...base, validForSec: 0 })).toBeTruthy()
  })

  it('THROWS rather than returning a signable order when a refusal applies', () => {
    expect(() => buildLimitOrder({ ...base, sellAmountRaw: 0n })).toThrow()
  })

  it('passes a well-formed order', () => {
    expect(limitOrderRefusal(base)).toBeNull()
  })
})

describe('cow: the typed data handed to the wallet', () => {
  it('hashes deterministically and depends on the price', () => {
    const a = hashTypedData(limitOrderTypedData(8453, buildLimitOrder(base)))
    const b = hashTypedData(limitOrderTypedData(8453, buildLimitOrder(base)))
    const c = hashTypedData(limitOrderTypedData(8453, buildLimitOrder({ ...base, minBuyAmountRaw: 4001_000000n })))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('hashes differently per chain', () => {
    const o = buildLimitOrder(base)
    expect(hashTypedData(limitOrderTypedData(1, o))).not.toBe(hashTypedData(limitOrderTypedData(8453, o)))
  })

  // EIP-712 hashes by DECLARED FIELD ORDER, so a reorder silently invalidates
  // every signature rather than failing loudly. Pin the order itself.
  it('pins the struct field order', () => {
    expect(COW_ORDER_TYPES.Order.map((f) => f.name)).toEqual([
      'sellToken',
      'buyToken',
      'receiver',
      'sellAmount',
      'buyAmount',
      'validTo',
      'appData',
      'feeAmount',
      'kind',
      'partiallyFillable',
      'sellTokenBalance',
      'buyTokenBalance',
    ])
  })
})

const ECDSA_SIG: `0x${string}` = `0x${'ab'.repeat(65)}` // r+s+v, exactly 65 bytes

describe('cow: the signing scheme is DERIVED, never assumed', () => {
  // The defect this pins: hardcoding eip712 breaks every smart-account and
  // EIP-7702 user, because MetaMask Smart Account / Alchemy / ZeroDev / Biconomy
  // return signTypedData wrapped in a nested ERC-7739 envelope that does not
  // ecrecover. Posted as eip712 it is rejected with an error that looks like our
  // bug. Length is the discriminator, same as CoW's own SDK uses.
  it('calls a raw 65-byte ECDSA signature eip712', () => {
    expect(schemeForSignature(ECDSA_SIG)).toBe('eip712')
  })

  it('calls a WRAPPED (non-65-byte) signature eip1271, so a smart account still works', () => {
    expect(schemeForSignature(`0x${'ab'.repeat(200)}`)).toBe('eip1271')
    expect(schemeForSignature(`0x${'ab'.repeat(66)}`)).toBe('eip1271')
    expect(schemeForSignature(`0x${'ab'.repeat(64)}`)).toBe('eip1271')
  })

  it('never guesses eip712 for an empty or stub signature', () => {
    expect(schemeForSignature('0x')).toBe('eip1271')
  })
})

describe('cow: request bodies', () => {
  it('posts the order with the signer and the derived scheme attached', () => {
    const body = orderPostBody(buildLimitOrder(base), OWNER, ECDSA_SIG)
    expect(body.from).toBe(OWNER)
    expect(body.signature).toBe(ECDSA_SIG)
    expect(body.signingScheme).toBe('eip712')
    expect(body.sellAmount).toBe('1000000000000000000')
  })

  it('flips the scheme for a smart-account signature without touching the order', () => {
    const order = buildLimitOrder(base)
    const wrapped: `0x${string}` = `0x${'cd'.repeat(300)}`
    const body = orderPostBody(order, OWNER, wrapped)
    expect(body.signingScheme).toBe('eip1271')
    // the signed struct itself must be byte-identical either way
    expect(body.buyAmount).toBe(order.buyAmount)
    expect(body.validTo).toBe(order.validTo)
  })

  it('asks for a quote as the connected wallet, off-chain', () => {
    const q = buildQuoteRequest({ ...base })
    expect(q.from).toBe(OWNER)
    expect(q.receiver).toBe(OWNER)
    expect(q.onchainOrder).toBe(false)
    expect(q.sellAmountBeforeFee).toBe('1000000000000000000')
  })
})

describe('cow: order status', () => {
  it('treats expired and cancelled as terminal, not as failures', () => {
    expect(isTerminalCowStatus('expired')).toBe(true)
    expect(isTerminalCowStatus('cancelled')).toBe(true)
    expect(isTerminalCowStatus('fulfilled')).toBe(true)
  })

  it('keeps polling an open order', () => {
    expect(isTerminalCowStatus('open')).toBe(false)
    expect(isTerminalCowStatus('presignaturePending')).toBe(false)
  })
})

// appData is signed as a HASH, so a hook attached to it is invisible in the
// wallet prompt. Verified in the wild: a real filled Base order carries
// partnerFee volumeBps 85, i.e. a wallet skimming 0.85% through this field. Our
// document must be able to do nothing but describe the order.
describe('cow: appData must stay inert', () => {
  it('the shipped document carries no hooks and no fee', () => {
    expect(appDataRefusal(SPECTRUM_APP_DATA)).toBeNull()
    expect(JSON.stringify(SPECTRUM_APP_DATA)).not.toMatch(/hooks|partnerFee|referrer/)
  })

  it('REFUSES hooks, which would execute arbitrary calls the user cannot see', () => {
    const doc = { ...SPECTRUM_APP_DATA, metadata: { ...SPECTRUM_APP_DATA.metadata, hooks: { pre: [] } } }
    expect(appDataRefusal(doc)).toMatch(/hooks/)
  })

  it('REFUSES a partner fee, because the fee model says none on orders in v1', () => {
    const doc = { ...SPECTRUM_APP_DATA, metadata: { ...SPECTRUM_APP_DATA.metadata, partnerFee: { volumeBps: 85 } } }
    expect(appDataRefusal(doc)).toMatch(/partnerFee/)
  })

  it('refuses a forbidden key at the top level too, not only inside metadata', () => {
    expect(appDataRefusal({ ...SPECTRUM_APP_DATA, hooks: [] } as never)).toBeTruthy()
  })
})
