import type { Address } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// BATCH FEE VERIFICATION — verify the MEASURED fee, never the calldata's feeBps
// (SpectrumContracts requirement, ruled by the owner 2026-08-10; the full analysis:
// spectrum-contracts/docs/BACKEND-FEE-VERIFICATION-REQUIREMENT-2026-08-10.md).
//
// THE ONE LINE: `p.feeBps` in batchBuy calldata is the CALLER'S OWN DECLARATION.
// The fee the protocol actually receives is whatever BatchExecuted reports.
// fee = totalUsed · feeBps / BPS, and totalUsed is a sum of per-leg NET deltas
// measured ACROSS THE CALLER'S OWN 0x ROUTE — a route that hands the pulled
// funding back inside the same call drives used→0, so fee→0 and nothing burns,
// while the buyer still receives the asset. Not fixable on-chain (every input
// to the fee base is caller-controlled; both candidate patches harm honest
// users); the contract is immutable. The receipt is the only honest witness.
//
// THE LAWS, from the requirement doc:
//   · expectedFee = floor(fundingTotal_FROM_THE_EVENT · feeBps / 10 000). The
//     event's own fundingTotal, never the value submitted — this module cannot
//     even be handed a submitted total, by API construction.
//   · EXACT integer comparison, never a tolerance — a tolerance hides deflation.
//   · fee == 0 with feeBps == 0 is a legitimate zero-rate integrator (the exact
//     compare already treats it as verified: floor(x·0) == 0).
//   · fee < expected with a NON-ZERO feeBps is the deflation path.
//   · BurnDiverted is a routing outcome, not a payment failure — a diverted
//     burn still charged the fee. The signal is `fee` itself; nothing here
//     reads burn events.
//   · No matching event is a REFUSAL, never a clean result — an unverifiable
//     batch reads exactly like an unpaid one until someone looks.
//
// EVENT SHAPE (measured on the built artifact, pre-ceremony, 2026-08-10):
//   event BatchExecuted(address indexed recipient, address indexed fundingAsset,
//                       uint256 fundingTotal, uint256 fee, uint256 refunded)
//   topic0 0xfac2c1a5…f500 — pinned in batch-fee-verification.test.ts by
//   recomputing it from the signature (the paper-encoded-interface law). When
//   the batcher ceremony lands, re-verify this topic against the one-message
//   ABI exactly like the batchBuy selector (bat-seat prestage).
//
// ENFORCEMENT is the consumer's job and lives where batches are relayed or
// attributed: verify every receipt, record divergence against the caller, and
// on repeat divergence STOP SERVING that caller — there is no other
// enforcement point. Exposure today is nil (feeBps is caller-supplied by
// standing ruling); it becomes real the moment a relayer/paymaster/AA flow
// fixes the rate server-side. This module is the machinery, kept pure so that
// backend, executor and tests all bind the same laws.
// ─────────────────────────────────────────────────────────────────────────────

export const BATCH_EXECUTED_SIGNATURE = 'BatchExecuted(address,address,uint256,uint256,uint256)'

/** keccak256 of the signature above — the test recomputes it via viem's
 *  toEventSelector and fails if the two ever disagree. */
export const BATCH_EXECUTED_TOPIC0 = '0xfac2c1a5b783482549787b80f5453260e6e32c4a49afa73d936f3412c285f500'

/** The event as a viem ABI item, for parseEventLogs at wiring time. */
export const batchExecutedEvent = {
  type: 'event',
  name: 'BatchExecuted',
  inputs: [
    { name: 'recipient', type: 'address', indexed: true },
    { name: 'fundingAsset', type: 'address', indexed: true },
    { name: 'fundingTotal', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
    { name: 'refunded', type: 'uint256', indexed: false },
  ],
} as const

const BPS = 10_000n

/** floor(fundingTotal · feeBps / 10 000) — the contract's own integer math.
 *  Refuses a rate that is not a whole bps in [0, 10 000]: a fractional or
 *  out-of-range rate here means the CALLER's configuration is broken, and
 *  scoring with it would make every comparison quietly wrong. */
export function expectedBatchFee(fundingTotal: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error(`expectedBatchFee: feeBps must be an integer in [0, 10000], got ${feeBps}`)
  }
  if (fundingTotal < 0n) throw new Error('expectedBatchFee: fundingTotal cannot be negative')
  return (fundingTotal * BigInt(feeBps)) / BPS
}

/** One decoded BatchExecuted, plus this module's verdict on it. */
export interface BatchExecutedCheck {
  recipient: Address
  fundingAsset: Address
  /** The MEASURED transfer-in — the event's own third field. */
  fundingTotal: bigint
  /** What was actually charged — the field that matters. */
  fee: bigint
  refunded: bigint
  expectedFee: bigint
  /** expectedFee − fee when under-paid; 0n otherwise. */
  deficit: bigint
}

/** The shape a receipt log needs — viem's TransactionReceipt.logs satisfies it. */
export interface ReceiptLogLike {
  address: string
  topics: readonly string[]
  data: string
}

export type BatchFeeVerdict =
  /** No BatchExecuted from the named batcher in these logs. A batch that
   *  cannot be verified is NOT verified — treat as a divergence to
   *  investigate, never as clean. */
  | { kind: 'no-event' }
  /** A log matched the batcher + topic0 but would not decode. Same refusal
   *  posture: nothing was checked. */
  | { kind: 'unreadable'; reason: string }
  /** At least one event paid less than the exact floor — the deflation path.
   *  `worst` is the largest deficit. */
  | { kind: 'under-paid'; events: BatchExecutedCheck[]; worst: BatchExecutedCheck }
  /** fee ABOVE the exact floor: mathematically impossible against the true
   *  rate, so OUR expectedFeeBps is stale — a configuration alarm, not money
   *  lost, and still never silently passed. */
  | { kind: 'rate-mismatch'; events: BatchExecutedCheck[] }
  /** Every event's fee equals the exact floor at the expected rate. */
  | { kind: 'verified'; events: BatchExecutedCheck[] }

const hexToBigInt = (h: string): bigint => BigInt(`0x${h}`)

/** Strict manual decode — the doc's own byte map ("fee is data[32:64]"), with
 *  every length checked so a malformed log becomes a refusal, not a zero. The
 *  test cross-checks this parse against viem's decodeEventLog on the same
 *  fixture, so the hand map cannot drift from the ABI item above. */
function decodeBatchExecuted(log: ReceiptLogLike): BatchExecutedCheck | { error: string } {
  if (log.topics.length !== 3) return { error: `expected 3 topics (topic0 + 2 indexed), got ${log.topics.length}` }
  const t1 = log.topics[1]
  const t2 = log.topics[2]
  if (!/^0x[0-9a-fA-F]{64}$/.test(t1) || !/^0x[0-9a-fA-F]{64}$/.test(t2)) {
    return { error: 'indexed topics are not 32-byte words' }
  }
  const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data
  if (!/^[0-9a-fA-F]*$/.test(data)) return { error: 'data is not hex' }
  if (data.length !== 64 * 3) return { error: `expected 96 data bytes (3 words), got ${data.length / 2}` }
  return {
    recipient: `0x${t1.slice(26)}` as Address,
    fundingAsset: `0x${t2.slice(26)}` as Address,
    fundingTotal: hexToBigInt(data.slice(0, 64)),
    fee: hexToBigInt(data.slice(64, 128)),
    refunded: hexToBigInt(data.slice(128, 192)),
    expectedFee: 0n, // filled by the caller once the rate is applied
    deficit: 0n,
  }
}

/**
 * Verify every BatchExecuted the named batcher emitted in these logs against
 * the exact fee floor at `expectedFeeBps`.
 *
 * The address filter is load-bearing: any contract can emit an event with this
 * topic0, so only logs FROM the batcher count — a spoofed fat-fee event from
 * another address must not vouch for an under-paid real one.
 */
export function verifyBatchFee(args: {
  logs: readonly ReceiptLogLike[]
  batcher: string
  expectedFeeBps: number
}): BatchFeeVerdict {
  const batcher = args.batcher.toLowerCase()
  const matching = args.logs.filter(
    (l) => l.address.toLowerCase() === batcher && l.topics[0]?.toLowerCase() === BATCH_EXECUTED_TOPIC0,
  )
  if (matching.length === 0) return { kind: 'no-event' }

  const events: BatchExecutedCheck[] = []
  for (const log of matching) {
    const decoded = decodeBatchExecuted(log)
    if ('error' in decoded) return { kind: 'unreadable', reason: decoded.error }
    const expectedFee = expectedBatchFee(decoded.fundingTotal, args.expectedFeeBps)
    const deficit = decoded.fee < expectedFee ? expectedFee - decoded.fee : 0n
    events.push({ ...decoded, expectedFee, deficit })
  }

  const underpaid = events.filter((e) => e.fee < e.expectedFee)
  if (underpaid.length > 0) {
    const worst = underpaid.reduce((w, e) => (e.deficit > w.deficit ? e : w), underpaid[0])
    return { kind: 'under-paid', events, worst }
  }
  if (events.some((e) => e.fee > e.expectedFee)) return { kind: 'rate-mismatch', events }
  return { kind: 'verified', events }
}
