import { describe, expect, it } from 'vitest'
import { BATCH_EXECUTED_TOPIC0, expectedBatchFee, type ReceiptLogLike } from './batch-fee-verification'
import { BURN_DIVERTED_TOPIC0 } from './post-trade-reconciliation'
import { batchFeeBpsFor } from './allocation'
import { divertReasonName, receiptLineFor } from './run-receipt-line'

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT LINE'S PINS. The anchor fixture is the LIVE incident: the
// 2026-08-18 Base batch whose burn share diverted with MinBurnNotMet reason
// bytes (tx 0xa4770b8e…, selector 0xddafd724 measured off the chain itself) —
// the line must name that reason, not just say "diverted".
// ─────────────────────────────────────────────────────────────────────────────

const BATCHER = '0x2ec8c0c87946ead5f9ae436374f6a6d0191c6803'
const ME = '0x40b1e5818b449db3a7bb0fe482b5784f77fcd2c0'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const SINK = '0x2f2508e334bd34015e5fda79c9d2c0555096c572'

const word = (v: bigint) => v.toString(16).padStart(64, '0')
const addressTopic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`

function batchExecutedLog(fundingTotal: bigint, fee: bigint, refunded = 0n): ReceiptLogLike {
  return {
    address: BATCHER,
    topics: [BATCH_EXECUTED_TOPIC0, addressTopic(ME), addressTopic(USDC)],
    data: `0x${word(fundingTotal)}${word(fee)}${word(refunded)}`,
  }
}

function burnDivertedLog(amount: bigint, reason: `0x${string}` = '0x'): ReceiptLogLike {
  const rbytes = reason.slice(2)
  const rlen = rbytes.length / 2
  const padded = rbytes.padEnd(Math.ceil(rlen / 32) * 64, '0')
  return {
    address: BATCHER,
    topics: [BURN_DIVERTED_TOPIC0, addressTopic(SINK), addressTopic(USDC)],
    data: `0x${word(amount)}${word(64n)}${word(BigInt(rlen))}${rlen ? padded : ''}` as `0x${string}`,
  }
}

const CHAIN = 8453
const TOTAL = 141_131_0000n // $1,411.31 at 6dp — the live batch's own scale
const FEE = expectedBatchFee(TOTAL, batchFeeBpsFor(CHAIN))
const line = (logs: ReceiptLogLike[], status: 'success' | 'reverted' = 'success') =>
  receiptLineFor({ chainId: CHAIN, status, logs, batcher: BATCHER, recipient: ME, fundingDecimals: 6 })

describe('the receipt line — the landed batch summarized in one honest sentence', () => {
  it('the LIVE incident shape: fee exact, burn share diverted with MinBurnNotMet reason bytes → diverted tone, reason NAMED', () => {
    // the measured selector from the live tx, plus its two uint words
    const reason = `0xddafd724${word(1601700000000000n)}${word(1657200000000000n)}` as `0x${string}`
    const r = line([batchExecutedLog(TOTAL, FEE), burnDivertedLog(FEE, reason)])
    expect(r.tone).toBe('diverted')
    expect(r.sentence).toContain('fee charged exactly')
    expect(r.sentence).toContain('DIVERTED')
    expect(r.sentence).toContain('MinBurnNotMet')
    expect(r.sentence).toContain('recoverable')
  })
  it('an EMPTY reason (the morning incident: no route supplied) says so in words', () => {
    const r = line([batchExecutedLog(TOTAL, FEE), burnDivertedLog(FEE, '0x')])
    expect(r.tone).toBe('diverted')
    expect(r.sentence).toContain('no reason bytes')
  })
  it('a clean landing: fee exact, no divert → clean, with the refund stated', () => {
    const r = line([batchExecutedLog(TOTAL, FEE, 5_0000n)])
    expect(r.tone).toBe('clean')
    expect(r.sentence).toContain('fee charged exactly')
    expect(r.sentence).toContain('burn executed')
  })
  it('one wei of fee drift is attention — the measured-fee law is exact', () => {
    const r = line([batchExecutedLog(TOTAL, FEE + 1n)])
    expect(r.tone).toBe('attention')
    expect(r.sentence).toContain('≠')
  })
  it('a reverted step and a missing completion event each say exactly what they are', () => {
    expect(line([], 'reverted').sentence).toContain('reverted')
    const missing = line([])
    expect(missing.tone).toBe('attention')
    expect(missing.sentence).toContain('completion event is missing')
  })
  it('divertReasonName pins the LIVE selector and refuses to guess unknowns', () => {
    expect(divertReasonName('0xddafd724')).toBe('MinBurnNotMet')
    expect(divertReasonName('0xdeadbeef')).toBe('reason 0xdeadbeef')
    expect(divertReasonName('0x')).toContain('no reason bytes')
  })
})
