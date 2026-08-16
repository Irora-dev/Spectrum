import { describe, expect, it } from 'vitest'
import { decodeEventLog, toEventSelector } from 'viem'
import {
  BATCH_EXECUTED_SIGNATURE,
  BATCH_EXECUTED_TOPIC0,
  batchExecutedEvent,
  expectedBatchFee,
  verifyBatchFee,
  type ReceiptLogLike,
} from './batch-fee-verification'

// ─────────────────────────────────────────────────────────────────────────────
// The requirement's laws, each pinned by the case that must come out DIFFERENT
// (a check that cannot distinguish anything reports agreement with everything):
// the one-wei boundary, the spoofed address, the zero-rate legitimacy, the
// absent event as refusal. Doc: BACKEND-FEE-VERIFICATION-REQUIREMENT-2026-08-10.
// ─────────────────────────────────────────────────────────────────────────────

const BATCHER = '0x00000000000000000000000000000000000b47c4'
const RECIPIENT = '0x1111111111111111111111111111111111111111'
const FUNDING = '0x2222222222222222222222222222222222222222'

const word = (v: bigint | string): string =>
  (typeof v === 'string' ? BigInt(v) : v).toString(16).padStart(64, '0')

const addressTopic = (a: string): string => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`

function batchExecutedLog(args: {
  address?: string
  topic0?: string
  fundingTotal: bigint
  fee: bigint
  refunded?: bigint
}): ReceiptLogLike {
  return {
    address: args.address ?? BATCHER,
    topics: [args.topic0 ?? BATCH_EXECUTED_TOPIC0, addressTopic(RECIPIENT), addressTopic(FUNDING)],
    data: `0x${word(args.fundingTotal)}${word(args.fee)}${word(args.refunded ?? 0n)}`,
  }
}

describe('the topic0 pin — the paper-encoded-interface law', () => {
  it('the documented topic0 IS keccak256 of the documented signature', () => {
    // If these disagree, either the transcribed signature or the transcribed
    // hash is wrong, and nothing downstream can be trusted.
    expect(toEventSelector(BATCH_EXECUTED_SIGNATURE)).toBe(BATCH_EXECUTED_TOPIC0)
  })

  it('the exported ABI item derives the same selector as the string signature', () => {
    expect(toEventSelector(batchExecutedEvent)).toBe(BATCH_EXECUTED_TOPIC0)
  })

  it('the hand decode agrees with viem decodeEventLog on the same fixture', () => {
    const log = batchExecutedLog({ fundingTotal: 1_000_001n, fee: 4_000n, refunded: 77n })
    const viemDecoded = decodeEventLog({
      abi: [batchExecutedEvent],
      data: log.data as `0x${string}`,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    })
    const v = verifyBatchFee({ logs: [log], batcher: BATCHER, expectedFeeBps: 40 })
    if (v.kind !== 'verified') throw new Error(`expected verified, got ${v.kind}`)
    expect(v.events[0].recipient.toLowerCase()).toBe((viemDecoded.args.recipient as string).toLowerCase())
    expect(v.events[0].fundingAsset.toLowerCase()).toBe((viemDecoded.args.fundingAsset as string).toLowerCase())
    expect(v.events[0].fundingTotal).toBe(viemDecoded.args.fundingTotal)
    expect(v.events[0].fee).toBe(viemDecoded.args.fee)
    expect(v.events[0].refunded).toBe(viemDecoded.args.refunded)
  })
})

describe('expectedBatchFee — the exact floor', () => {
  it('floors, never rounds', () => {
    // 1_000_001 · 40 / 10_000 = 4_000.004 → 4_000 exactly
    expect(expectedBatchFee(1_000_001n, 40)).toBe(4_000n)
    expect(expectedBatchFee(1_000_000n, 40)).toBe(4_000n)
    expect(expectedBatchFee(999_999n, 40)).toBe(3_999n)
  })

  it('zero rate expects zero', () => {
    expect(expectedBatchFee(123_456_789n, 0)).toBe(0n)
  })

  it('refuses a rate that is not a whole bps in range', () => {
    expect(() => expectedBatchFee(1n, -1)).toThrow()
    expect(() => expectedBatchFee(1n, 40.5)).toThrow()
    expect(() => expectedBatchFee(1n, 10_001)).toThrow()
    expect(() => expectedBatchFee(-1n, 40)).toThrow()
  })
})

describe('verifyBatchFee — the exact compare', () => {
  it('verified when fee equals the floor exactly', () => {
    const v = verifyBatchFee({
      logs: [batchExecutedLog({ fundingTotal: 1_000_001n, fee: 4_000n })],
      batcher: BATCHER,
      expectedFeeBps: 40,
    })
    expect(v.kind).toBe('verified')
  })

  it('ONE WEI short is under-paid — the boundary that proves the compare is exact', () => {
    const v = verifyBatchFee({
      logs: [batchExecutedLog({ fundingTotal: 1_000_001n, fee: 3_999n })],
      batcher: BATCHER,
      expectedFeeBps: 40,
    })
    if (v.kind !== 'under-paid') throw new Error(`expected under-paid, got ${v.kind}`)
    expect(v.worst.deficit).toBe(1n)
  })

  it('the deflation path: fee 0 against a non-zero rate names the whole floor as deficit', () => {
    const v = verifyBatchFee({
      logs: [batchExecutedLog({ fundingTotal: 1_000_000n, fee: 0n })],
      batcher: BATCHER,
      expectedFeeBps: 40,
    })
    if (v.kind !== 'under-paid') throw new Error(`expected under-paid, got ${v.kind}`)
    expect(v.worst.expectedFee).toBe(4_000n)
    expect(v.worst.deficit).toBe(4_000n)
  })

  it('a zero-rate integrator is legitimate: fee 0 at feeBps 0 verifies', () => {
    const v = verifyBatchFee({
      logs: [batchExecutedLog({ fundingTotal: 1_000_000n, fee: 0n })],
      batcher: BATCHER,
      expectedFeeBps: 0,
    })
    expect(v.kind).toBe('verified')
  })

  it('expectedFee computes from the EVENT fundingTotal — the API cannot even be handed a submitted total', () => {
    // The event says 500k was measured in; whatever the caller believed they
    // submitted is irrelevant to the floor.
    const v = verifyBatchFee({
      logs: [batchExecutedLog({ fundingTotal: 500_000n, fee: 2_000n })],
      batcher: BATCHER,
      expectedFeeBps: 40,
    })
    if (v.kind !== 'verified') throw new Error(`expected verified, got ${v.kind}`)
    expect(v.events[0].expectedFee).toBe(2_000n)
  })

  it('fee ABOVE the floor is a rate mismatch (our bps assumption is stale), never a silent pass', () => {
    const v = verifyBatchFee({
      logs: [batchExecutedLog({ fundingTotal: 1_000_000n, fee: 4_001n })],
      batcher: BATCHER,
      expectedFeeBps: 40,
    })
    expect(v.kind).toBe('rate-mismatch')
  })
})

describe('the refusal postures — silence is never proof', () => {
  it('no matching event is a refusal, not a clean result', () => {
    const v = verifyBatchFee({ logs: [], batcher: BATCHER, expectedFeeBps: 40 })
    expect(v.kind).toBe('no-event')
  })

  it('a matching log that will not decode refuses instead of scoring zeros', () => {
    const log = batchExecutedLog({ fundingTotal: 1_000_000n, fee: 4_000n })
    const truncated = { ...log, data: log.data.slice(0, 2 + 64 * 2) } // 2 words, not 3
    const v = verifyBatchFee({ logs: [truncated], batcher: BATCHER, expectedFeeBps: 40 })
    expect(v.kind).toBe('unreadable')
  })

  it('a matching log with the wrong topic count refuses', () => {
    const log = batchExecutedLog({ fundingTotal: 1_000_000n, fee: 4_000n })
    const twoTopics = { ...log, topics: log.topics.slice(0, 2) }
    const v = verifyBatchFee({ logs: [twoTopics], batcher: BATCHER, expectedFeeBps: 40 })
    expect(v.kind).toBe('unreadable')
  })
})

describe('the address filter is load-bearing — a spoofed event cannot vouch', () => {
  it('an event with the right topic0 from ANOTHER address does not count at all', () => {
    const spoof = batchExecutedLog({ address: RECIPIENT, fundingTotal: 1_000_000n, fee: 4_000n })
    const v = verifyBatchFee({ logs: [spoof], batcher: BATCHER, expectedFeeBps: 40 })
    expect(v.kind).toBe('no-event')
  })

  it('a fat-fee spoof beside an under-paid real event does not rescue it', () => {
    const spoof = batchExecutedLog({ address: RECIPIENT, fundingTotal: 1_000_000n, fee: 40_000n })
    const real = batchExecutedLog({ fundingTotal: 1_000_000n, fee: 0n })
    const v = verifyBatchFee({ logs: [spoof, real], batcher: BATCHER, expectedFeeBps: 40 })
    if (v.kind !== 'under-paid') throw new Error(`expected under-paid, got ${v.kind}`)
    expect(v.events).toHaveLength(1) // the spoof never entered the census
  })

  it('address matching is case-insensitive (checksummed vs lowercase receipts)', () => {
    const log = batchExecutedLog({ address: BATCHER.toUpperCase().replace('0X', '0x'), fundingTotal: 1_000_000n, fee: 4_000n })
    const v = verifyBatchFee({ logs: [log], batcher: BATCHER, expectedFeeBps: 40 })
    expect(v.kind).toBe('verified')
  })

  it('a different event from the batcher (wrong topic0) is ignored', () => {
    const other = batchExecutedLog({ topic0: `0x${'ab'.repeat(32)}`, fundingTotal: 1n, fee: 0n })
    const v = verifyBatchFee({ logs: [other], batcher: BATCHER, expectedFeeBps: 40 })
    expect(v.kind).toBe('no-event')
  })
})

describe('multiple events in one receipt', () => {
  it('one under-paid event among verified ones decides the verdict, worst deficit named', () => {
    const good = batchExecutedLog({ fundingTotal: 1_000_000n, fee: 4_000n })
    const bad = batchExecutedLog({ fundingTotal: 2_000_000n, fee: 1_000n }) // floor 8_000, deficit 7_000
    const worse = batchExecutedLog({ fundingTotal: 3_000_000n, fee: 0n }) // floor 12_000, deficit 12_000
    const v = verifyBatchFee({ logs: [good, bad, worse], batcher: BATCHER, expectedFeeBps: 40 })
    if (v.kind !== 'under-paid') throw new Error(`expected under-paid, got ${v.kind}`)
    expect(v.events).toHaveLength(3)
    expect(v.worst.deficit).toBe(12_000n)
  })
})
