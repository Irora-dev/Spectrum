import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import { BATCH_FEE_BPS, GEN2_BATCH_FEE_BPS } from './allocation'
import {
  PORTFOLIO_MAX_DEADLINE_WINDOW_SEC,
  portfolioBatcherAbi,
  portfolioBatcherAbiGen2,
} from './portfolio-batcher'
import {
  WRAPPER_FEE_BPS,
  WRAPPER_MAX_DEADLINE_SEC,
  directSwapWrapperAbi,
  directSwapWrapperAbiGen2,
  wrapperFeeRaw,
} from './direct-swap-wrapper'
import { decodeOrNull, lintBatchCalldata, lintWrapperCalldata } from './calldata-lint'

// THE CALLDATA LINT: an independent decode of the exact bytes a wallet would
// sign, judged against the money laws. Every fixture here is ENCODED with the
// same imported ABIs the composers use — never hand-pasted hex — so what the
// lint reads is what viem would really put on the wire, and every violation
// test mutates ONE lawful value and expects the lint to name it with the real
// numbers. Clean = the empty array, and the clean fixtures assert exactly that.

const OWNER = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
const ATTACKER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const INTEGRATOR = '0x4200000000000000000000000000000000000042' as Address
const FUNDING = '0x4200000000000000000000000000000000000006' as Address
const ASSET = '0x1111111111111111111111111111111111111111' as Address
const BUY = '0x2222222222222222222222222222222222222222' as Address

const NOW = 1_800_000_000
const DEADLINE = BigInt(NOW + 1_200)
/** Opaque router/0x calldata — the lint judges PRESENCE, never content. */
const A_ROUTE = '0xdeadbeefcafef00d' as Hex

// ── batch fixtures — encoded with the imported generation ABIs ──────────────

interface BatchOver {
  feeBps?: number
  minBuyAmount?: bigint
  burnSwapData?: Hex
  deadline?: bigint
  recipient?: Address
  feeRecipient?: Address
}

function gen2Batch(over: BatchOver = {}): Hex {
  return encodeFunctionData({
    abi: portfolioBatcherAbiGen2,
    functionName: 'batchBuy',
    args: [
      [{ buyToken: ASSET, sellAmount: 500_000n, minBuyAmount: over.minBuyAmount ?? 4_900n, swapData: A_ROUTE, optional: false }],
      FUNDING,
      1_000_000n,
      {
        recipient: over.recipient ?? OWNER,
        deadline: over.deadline ?? DEADLINE,
        feeBps: over.feeBps ?? GEN2_BATCH_FEE_BPS,
        burnSwapData: over.burnSwapData ?? A_ROUTE,
      },
    ],
  })
}

function gen1Batch(over: BatchOver = {}): Hex {
  return encodeFunctionData({
    abi: portfolioBatcherAbi,
    functionName: 'batchBuy',
    args: [
      [{ buyToken: ASSET, sellAmount: 500_000n, minBuyAmount: over.minBuyAmount ?? 4_900n, swapData: A_ROUTE, optional: false }],
      FUNDING,
      1_000_000n,
      {
        recipient: over.recipient ?? OWNER,
        deadline: over.deadline ?? DEADLINE,
        feeBps: over.feeBps ?? BATCH_FEE_BPS,
        feeRecipient: over.feeRecipient ?? INTEGRATOR,
        burnSwapData: over.burnSwapData ?? A_ROUTE,
      },
    ],
  })
}

// ── wrapper fixtures ─────────────────────────────────────────────────────────

const SELL = 1_000_000_000_000_000_000n // a 1 ETH native sell, so the fee math is legible
const WRAP_FEE = wrapperFeeRaw(SELL, WRAPPER_FEE_BPS)
const EXACT_NATIVE = SELL + WRAP_FEE

interface WrapOver {
  sellToken?: Address
  minBuyAmount?: bigint
  feeBps?: number
  deadline?: bigint
  feeRecipient?: Address
}

/** Gen-2 wrapper call — native sell by default (sellToken address(0)). */
function gen2Wrapper(over: WrapOver = {}): Hex {
  return encodeFunctionData({
    abi: directSwapWrapperAbiGen2,
    functionName: 'swapWithFee',
    args: [
      over.sellToken ?? zeroAddress,
      SELL,
      BUY,
      over.minBuyAmount ?? 990_000_000_000_000_000n,
      A_ROUTE,
      over.feeBps ?? WRAPPER_FEE_BPS,
      over.deadline ?? DEADLINE,
    ],
  })
}

/** Gen-1 wrapper call — ERC-20 sell by default, integrator sink present. */
function gen1Wrapper(over: WrapOver = {}): Hex {
  return encodeFunctionData({
    abi: directSwapWrapperAbi,
    functionName: 'swapWithFee',
    args: [
      over.sellToken ?? FUNDING,
      SELL,
      BUY,
      over.minBuyAmount ?? 990_000_000_000_000_000n,
      A_ROUTE,
      over.feeBps ?? WRAPPER_FEE_BPS,
      over.feeRecipient ?? INTEGRATOR,
      over.deadline ?? DEADLINE,
    ],
  })
}

const batchExpected = { recipient: OWNER, nowSeconds: NOW }
const wrapExpected = { nowSeconds: NOW }

// ─────────────────────────────────────────────────────────────────────────────

describe('the lane constants this lint imports are the ruled numbers', () => {
  it('batch gen-1 is 40 bps, batch gen-2 is 25 bps, the wrapper is 40 bps — and the fee math on 1 ETH is exact', () => {
    expect(BATCH_FEE_BPS).toBe(40)
    expect(GEN2_BATCH_FEE_BPS).toBe(25)
    expect(WRAPPER_FEE_BPS).toBe(40)
    expect(WRAP_FEE).toBe(4_000_000_000_000_000n)
    expect(EXACT_NATIVE).toBe(1_004_000_000_000_000_000n)
  })
})

describe('lawful calldata lints clean — both families, both generations', () => {
  it('a generation-2 batch: the lane fee, a real floor, a burn route, a sane deadline, the signer as recipient', () => {
    expect(lintBatchCalldata({ data: gen2Batch(), expected: batchExpected })).toEqual([])
  })
  it('a generation-1 batch, the declared fee sink matching', () => {
    expect(lintBatchCalldata({ data: gen1Batch(), expected: { ...batchExpected, feeRecipient: INTEGRATOR } })).toEqual([])
  })
  it('a generation-2 wrapper native sell carrying sellAmount + fee exactly', () => {
    expect(lintWrapperCalldata({ data: gen2Wrapper(), value: EXACT_NATIVE, expected: wrapExpected })).toEqual([])
  })
  it('a generation-1 wrapper ERC-20 sell carrying no native value, the declared sink matching', () => {
    expect(lintWrapperCalldata({ data: gen1Wrapper(), expected: { ...wrapExpected, feeRecipient: INTEGRATOR } })).toEqual([])
  })
})

describe('law 1 · fee-bounds — the lane and generation own the number', () => {
  it('a generation-2 batch charging the generation-1 rate names both numbers', () => {
    const f = lintBatchCalldata({ data: gen2Batch({ feeBps: BATCH_FEE_BPS }), expected: batchExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('fee-bounds')
    expect(f[0].level).toBe('violation')
    expect(f[0].expected).toBe('25')
    expect(f[0].observed).toBe('40')
    expect(f[0].sentence).toMatch(/40 bps/)
    expect(f[0].sentence).toMatch(/25 bps/)
  })
  it('a wrapper charging the batcher’s 25 is the named undercharge trap', () => {
    // value made exact under the calldata's OWN feeBps, so the rate is the one broken law
    const value = SELL + wrapperFeeRaw(SELL, GEN2_BATCH_FEE_BPS)
    const f = lintWrapperCalldata({ data: gen2Wrapper({ feeBps: GEN2_BATCH_FEE_BPS }), value, expected: wrapExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('fee-bounds')
    expect(f[0].expected).toBe('40')
    expect(f[0].observed).toBe('25')
  })
})

describe('law 2 · native-value — sellAmount + fee EXACTLY, or nothing at all', () => {
  it('one wei over reverts WrongNativeValue on chain, so it violates here — both exact numbers carried', () => {
    const f = lintWrapperCalldata({ data: gen2Wrapper(), value: EXACT_NATIVE + 1n, expected: wrapExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('native-value')
    expect(f[0].level).toBe('violation')
    expect(f[0].expected).toBe('1004000000000000000')
    expect(f[0].observed).toBe('1004000000000000001')
    expect(f[0].sentence).toMatch(/WrongNativeValue/)
  })
  it('one wei under violates too', () => {
    const f = lintWrapperCalldata({ data: gen2Wrapper(), value: EXACT_NATIVE - 1n, expected: wrapExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('native-value')
    expect(f[0].observed).toBe('1003999999999999999')
  })
  it('an ERC-20 sell that sends native value anyway has nowhere lawful for it to land', () => {
    const f = lintWrapperCalldata({ data: gen1Wrapper(), value: 1n, expected: { ...wrapExpected, feeRecipient: INTEGRATOR } })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('native-value')
    expect(f[0].expected).toBe('0')
    expect(f[0].observed).toBe('1')
  })
  it('batchBuy is nonpayable — any native value violates', () => {
    const f = lintBatchCalldata({ data: gen2Batch(), value: 1n, expected: batchExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('native-value')
    expect(f[0].observed).toBe('1')
  })
})

describe('law 3 · floor-present — a zero/one-wei floor is a gutted floor', () => {
  it('a one-wei leg floor without consent violates, naming the leg', () => {
    const f = lintBatchCalldata({ data: gen2Batch({ minBuyAmount: 1n }), expected: batchExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('floor-present')
    expect(f[0].level).toBe('violation')
    expect(f[0].observed).toBe('1')
    expect(f[0].sentence).toMatch(/leg 0/)
  })
  it('the same call with { allowNoFloor: true } is clean — floorless is chosen out loud', () => {
    expect(
      lintBatchCalldata({ data: gen2Batch({ minBuyAmount: 1n }), expected: batchExpected, consent: { allowNoFloor: true } }),
    ).toEqual([])
  })
  it('a zero floor on the wrapper without consent violates — the measured-delta floor is the only protection there', () => {
    const f = lintWrapperCalldata({ data: gen2Wrapper({ minBuyAmount: 0n }), value: EXACT_NATIVE, expected: wrapExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('floor-present')
    expect(f[0].observed).toBe('0')
  })
})

describe('law 4 · burn-route-present — on the 100%-burn generation an empty route diverts the WHOLE fee', () => {
  it('empty burnSwapData on generation 2 without consent violates', () => {
    const f = lintBatchCalldata({ data: gen2Batch({ burnSwapData: '0x' }), expected: batchExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('burn-route-present')
    expect(f[0].level).toBe('violation')
    expect(f[0].observed).toBe('0x')
    expect(f[0].sentence).toMatch(/fallback sink/)
  })
  it('with { allowDivert: true } the divert-consented call passes clean', () => {
    expect(
      lintBatchCalldata({ data: gen2Batch({ burnSwapData: '0x' }), expected: batchExpected, consent: { allowDivert: true } }),
    ).toEqual([])
  })
  it('an empty route on generation 1 is not this law — v1 scopes it to the 100%-burn generation', () => {
    expect(
      lintBatchCalldata({ data: gen1Batch({ burnSwapData: '0x' }), expected: { ...batchExpected, feeRecipient: INTEGRATOR } }),
    ).toEqual([])
  })
})

describe('law 5 · deadline-sane — strictly ahead of now, inclusively within the horizon', () => {
  it('a deadline behind the clock violates', () => {
    const f = lintBatchCalldata({ data: gen2Batch({ deadline: BigInt(NOW - 60) }), expected: batchExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('deadline-sane')
    expect(f[0].observed).toBe(String(NOW - 60))
    expect(f[0].sentence).toMatch(/not strictly ahead/)
  })
  it('a deadline exactly AT the clock violates too — strictly ahead is the law', () => {
    const f = lintWrapperCalldata({ data: gen2Wrapper({ deadline: BigInt(NOW) }), value: EXACT_NATIVE, expected: wrapExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('deadline-sane')
    expect(f[0].observed).toBe(String(NOW))
  })
  it('a deadline exactly at the horizon is lawful — the cap is inclusive', () => {
    const atCap = BigInt(NOW + WRAPPER_MAX_DEADLINE_SEC)
    expect(lintWrapperCalldata({ data: gen2Wrapper({ deadline: atCap }), value: EXACT_NATIVE, expected: wrapExpected })).toEqual([])
  })
  it('one second past the horizon violates — a far deadline is a standing grant', () => {
    const past = BigInt(NOW + PORTFOLIO_MAX_DEADLINE_WINDOW_SEC + 1)
    const f = lintBatchCalldata({ data: gen2Batch({ deadline: past }), expected: batchExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('deadline-sane')
    expect(f[0].observed).toBe(past.toString())
    expect(f[0].sentence).toMatch(/standing grant/)
  })
})

describe('law 6 · recipient-match — money lands where the signer declared', () => {
  it('a redirected batch recipient violates, naming both addresses', () => {
    const f = lintBatchCalldata({ data: gen2Batch({ recipient: ATTACKER }), expected: batchExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('recipient-match')
    expect(f[0].expected).toBe(OWNER)
    expect(f[0].observed).toBe(ATTACKER)
    expect(f[0].sentence).toContain(OWNER)
    expect(f[0].sentence).toContain(ATTACKER)
  })
  it('a repointed generation-1 fee sink violates when the sink was declared', () => {
    const f = lintBatchCalldata({
      data: gen1Batch({ feeRecipient: ATTACKER }),
      expected: { ...batchExpected, feeRecipient: INTEGRATOR },
    })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('recipient-match')
    expect(f[0].expected).toBe(INTEGRATOR)
    expect(f[0].observed).toBe(ATTACKER)
  })
})

describe('law 7 · unrecognized — what cannot be read is never clean', () => {
  const approveData = encodeFunctionData({
    abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
    functionName: 'approve',
    args: [OWNER, 1n],
  })
  it('an unknown selector is a single unrecognized finding on the batch lane', () => {
    const f = lintBatchCalldata({ data: approveData, expected: batchExpected })
    expect(f).toHaveLength(1)
    expect(f[0].law).toBe('unrecognized')
    expect(f[0].level).toBe('unrecognized')
  })
  it('the wrapper lane fails closed on unknown selectors and on undecodable bytes', () => {
    const unknown = lintWrapperCalldata({ data: approveData, expected: wrapExpected })
    expect(unknown).toHaveLength(1)
    expect(unknown[0].level).toBe('unrecognized')
    const garbage = lintWrapperCalldata({ data: '0x12', expected: wrapExpected })
    expect(garbage).toHaveLength(1)
    expect(garbage[0].level).toBe('unrecognized')
  })
  it('calldata from the OTHER family is unrecognized — the lanes never cross-read', () => {
    expect(lintWrapperCalldata({ data: gen2Batch(), expected: wrapExpected })[0].law).toBe('unrecognized')
    expect(lintBatchCalldata({ data: gen2Wrapper(), expected: batchExpected })[0].law).toBe('unrecognized')
  })
  it('decodeOrNull answers null on garbage and the decoded call on real bytes', () => {
    expect(decodeOrNull(portfolioBatcherAbiGen2, '0x12')).toBeNull()
    expect(decodeOrNull(portfolioBatcherAbiGen2, gen2Batch())?.functionName).toBe('batchBuy')
  })
})

describe('violations accumulate — one finding per broken law, in check order', () => {
  it('a call breaking six laws at once gets six findings, none swallowed', () => {
    const data = gen2Batch({
      feeBps: 100,
      minBuyAmount: 0n,
      burnSwapData: '0x',
      deadline: BigInt(NOW - 1),
      recipient: ATTACKER,
    })
    const f = lintBatchCalldata({ data, value: 5n, expected: batchExpected })
    expect(f.map((x) => x.law)).toEqual([
      'fee-bounds',
      'native-value',
      'floor-present',
      'burn-route-present',
      'deadline-sane',
      'recipient-match',
    ])
    expect(f.every((x) => x.level === 'violation')).toBe(true)
  })
})
