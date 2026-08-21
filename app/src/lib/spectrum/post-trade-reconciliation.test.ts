import { describe, expect, it } from 'vitest'
import { toEventSelector } from 'viem'
import { feeChargedEventAbi } from './direct-swap-lane'
import type { ReceiptLogLike } from './batch-fee-verification'
import { BATCH_EXECUTED_TOPIC0 } from './batch-fee-verification'
import {
  BURN_DIVERTED_SIGNATURE,
  BURN_DIVERTED_TOPIC0,
  burnDivertedEvent,
  decodeReceiptFacts,
  expectedBurnCut,
  FEE_CHARGED_SIGNATURE,
  FEE_CHARGED_TOPIC0,
  reconcileRun,
  summarizeRun,
  TRANSFER_TOPIC0,
  type LawVerdict,
  type ReceiptFact,
  type ReceiptFacts,
  type ReconcileLaw,
  type RunExpectations,
} from './post-trade-reconciliation'

// ─────────────────────────────────────────────────────────────────────────────
// Each law pinned by the case that must come out DIFFERENT (a check that cannot
// distinguish anything reports agreement with everything — the sibling test's
// own line). The anchor fixture is the REAL incident: 2026-08-18, Base — the
// fee charged exactly at 25 bps, then BurnDiverted for the WHOLE fee because
// the app supplied an empty burn route. The receipt said so at t=0; nobody
// read it. These tests are the reader's proof it now would be read.
// ─────────────────────────────────────────────────────────────────────────────

const BATCHER = '0x00000000000000000000000000000000000b47c4'
const RECIPIENT = '0x1111111111111111111111111111111111111111'
const FUNDING = '0x2222222222222222222222222222222222222222'
const SINK = '0x3333333333333333333333333333333333333333'
const WETH = '0x4444444444444444444444444444444444444444'
const LINK = '0x5555555555555555555555555555555555555555'

// The incident's own numbers: $6,645 deployed (USDC, 6 decimals) at 25 bps →
// fee floor(6_645_000_000 × 25 / 10_000) = 16_612_500 raw, whole fee diverted.
const DEPLOYED = 6_645_000_000n
const FEE = 16_612_500n
const PULLED = DEPLOYED + FEE // refunded 0

const word = (v: bigint): string => v.toString(16).padStart(64, '0')
const addressTopic = (a: string): string => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`

function batchExecutedLog(args: { fundingTotal: bigint; fee: bigint; refunded?: bigint; address?: string }): ReceiptLogLike {
  return {
    address: args.address ?? BATCHER,
    topics: [BATCH_EXECUTED_TOPIC0, addressTopic(RECIPIENT), addressTopic(FUNDING)],
    data: `0x${word(args.fundingTotal)}${word(args.fee)}${word(args.refunded ?? 0n)}`,
  }
}

function feeChargedLog(burnCut: bigint): ReceiptLogLike {
  return { address: BATCHER, topics: [FEE_CHARGED_TOPIC0, addressTopic(SINK)], data: `0x${word(burnCut)}` }
}

function burnDivertedLog(amount: bigint, reason: `0x${string}` = '0x'): ReceiptLogLike {
  // the REAL 4-arg shape (live-proven 2026-08-18): indexed sink + fundingAsset,
  // data = (amount, bytes reason) ABI-encoded — offset 0x40, then length+bytes
  const rbytes = reason.slice(2)
  const rlen = rbytes.length / 2
  const padded = rbytes.padEnd(Math.ceil(rlen / 32) * 64, '0')
  const data = `0x${word(amount)}${word(64n)}${word(BigInt(rlen))}${rlen ? padded : ''}` as `0x${string}`
  return { address: BATCHER, topics: [BURN_DIVERTED_TOPIC0, addressTopic(SINK), addressTopic(FUNDING)], data }
}

function transferLog(token: string, to: string, value: bigint): ReceiptLogLike {
  return { address: token, topics: [TRANSFER_TOPIC0, addressTopic(BATCHER), addressTopic(to)], data: `0x${word(value)}` }
}

function expectations(over: Partial<RunExpectations> = {}): RunExpectations {
  return {
    chainId: 8453,
    committedRaw: DEPLOYED,
    pulledRaw: PULLED,
    feeBps: 25,
    feeGeneration: 3,
    recipient: RECIPIENT,
    legs: [
      { asset: WETH, symbol: 'WETH', floorRaw: 400n, optional: false },
      { asset: LINK, symbol: 'LINK', floorRaw: 500n, optional: true },
    ],
    ...over,
  }
}

const success = (facts: ReceiptFact[]): ReceiptFacts => ({ status: 'success', facts })

const batchFact = (over: Partial<Extract<ReceiptFact, { kind: 'batch-executed' }>> = {}): ReceiptFact => ({
  kind: 'batch-executed',
  recipient: RECIPIENT,
  fundingAsset: FUNDING,
  fundingTotal: DEPLOYED,
  fee: FEE,
  refunded: 0n,
  ...over,
})

const deliveryFacts: ReceiptFact[] = [
  { kind: 'delivery', asset: WETH, to: RECIPIENT, amount: 450n },
  { kind: 'delivery', asset: LINK, to: RECIPIENT, amount: 700n },
]

function row(verdicts: LawVerdict[], law: ReconcileLaw): LawVerdict {
  const r = verdicts.find((v) => v.law === law)
  if (!r) throw new Error(`no ${law} verdict among: ${verdicts.map((v) => v.law).join(', ')}`)
  return r
}

describe('the event mirrors — pinned against the real exports (the paper-encoded-interface law)', () => {
  it('the FeeCharged mirror derives the SAME topic0 as direct-swap-lane’s own export', () => {
    // The mirror exists so a pure module does not drag the lane's RPC stack in;
    // this pin is what makes the mirror unable to drift from the real thing.
    expect(FEE_CHARGED_TOPIC0).toBe(toEventSelector(feeChargedEventAbi[0]))
  })

  it('the FeeCharged signature string and ABI item agree', () => {
    expect(toEventSelector(FEE_CHARGED_SIGNATURE)).toBe(FEE_CHARGED_TOPIC0)
  })

  it('the BurnDiverted signature and ABI item agree (no repo export exists to pin against — stated in the module header)', () => {
    expect(toEventSelector(BURN_DIVERTED_SIGNATURE)).toBe(BURN_DIVERTED_TOPIC0)
    expect(toEventSelector(burnDivertedEvent)).toBe(BURN_DIVERTED_TOPIC0)
  })

  it('the Transfer topic0 is the canonical ERC-20 hash', () => {
    expect(TRANSFER_TOPIC0).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
  })
})

describe('expectedBurnCut — the generation law, derived from the code, not invented', () => {
  it('generation 1 burns fee minus fee/8, floor division (the 7:1 remainder-exact split)', () => {
    // 16_612_500 / 8 = 2_076_562.5 → floor 2_076_562; cut = 14_535_938
    expect(expectedBurnCut(FEE, 1)).toBe(14_535_938n)
    expect(expectedBurnCut(9n, 1)).toBe(8n) // 9 − floor(9/8) = 8, NOT floor(7·9/8) = 7
  })

  it('generations 2 and 3 burn the whole fee', () => {
    expect(expectedBurnCut(FEE, 2)).toBe(FEE)
    expect(expectedBurnCut(FEE, 3)).toBe(FEE)
  })

  it('a negative fee is refused, never scored', () => {
    expect(() => expectedBurnCut(-1n, 2)).toThrow()
  })
})

describe('the incident — 2026-08-18, fee exact, the WHOLE fee diverted (fixture a)', () => {
  const receipt = decodeReceiptFacts({
    status: 'success',
    logs: [
      batchExecutedLog({ fundingTotal: DEPLOYED, fee: FEE }),
      burnDivertedLog(FEE),
      transferLog(WETH, RECIPIENT, 450n),
      transferLog(LINK, RECIPIENT, 700n),
    ],
    moneyContract: BATCHER,
    recipient: RECIPIENT,
  })
  const verdicts = reconcileRun(expectations(), receipt)

  it('the fee is exact at 25 bps — the incident really did charge correctly', () => {
    const fee = row(verdicts, 'fee-exactness')
    expect(fee.verdict).toBe('pass')
    expect(fee.expected).toBe('16612500 raw')
    expect(fee.observed).toBe('16612500 raw')
  })

  it('the divert is DISCLOSED, naming the parked amount and the sink — never a silent pass, never a bare fail', () => {
    const divert = row(verdicts, 'divert-honesty')
    expect(divert.verdict).toBe('divert-disclosed')
    expect(divert.sentence).toContain('16612500')
    expect(divert.sentence).toContain(SINK)
  })

  it('the burn-share law reads the parked cut as sized-lawfully-but-parked, not as burned', () => {
    const burn = row(verdicts, 'burn-share')
    expect(burn.verdict).toBe('divert-disclosed')
    expect(burn.expected).toBe('16612500 raw burned')
    expect(burn.observed).toBe('16612500 raw parked')
  })

  it('the run is NOT clean and the headline says the burn diverted', () => {
    const summary = summarizeRun(verdicts)
    expect(summary.clean).toBe(false)
    expect(summary.headline).toMatch(/divert/i)
  })

  it('nothing FAILS and nothing is unrecognized — this is disclosure, not breakage', () => {
    expect(verdicts.filter((v) => v.verdict === 'fail')).toHaveLength(0)
    expect(verdicts.filter((v) => v.verdict === 'unrecognized')).toHaveLength(0)
  })

  it('conservation telescopes: deployed + fee + refunded equals the pull', () => {
    const c = row(verdicts, 'conservation')
    expect(c.verdict).toBe('pass')
    expect(c.expected).toBe('6661612500 raw pulled')
  })
})

describe('burn share per generation (fixture b — the sizing-bug shape)', () => {
  it('a fee-minus-fee/8 cut on a whole-fee generation FAILS with both numbers in the sentence', () => {
    const verdicts = reconcileRun(
      expectations({ feeGeneration: 2 }),
      success([batchFact(), { kind: 'fee-charged', burnSink: SINK, burnCut: 14_535_938n }, ...deliveryFacts]),
    )
    const burn = row(verdicts, 'burn-share')
    expect(burn.verdict).toBe('fail')
    expect(burn.sentence).toContain('16612500')
    expect(burn.sentence).toContain('14535938')
    expect(summarizeRun(verdicts).clean).toBe(false)
  })

  it('the SAME cut on generation 1 passes — it is that generation’s own law', () => {
    const verdicts = reconcileRun(
      expectations({ feeGeneration: 1 }),
      success([batchFact(), { kind: 'fee-charged', burnSink: SINK, burnCut: 14_535_938n }, ...deliveryFacts]),
    )
    expect(row(verdicts, 'burn-share').verdict).toBe('pass')
  })

  it('a whole-fee cut on generation 1 fails — over-burning is a wrong sizing too', () => {
    const verdicts = reconcileRun(
      expectations({ feeGeneration: 1 }),
      success([batchFact(), { kind: 'fee-charged', burnSink: SINK, burnCut: FEE }, ...deliveryFacts]),
    )
    const burn = row(verdicts, 'burn-share')
    expect(burn.verdict).toBe('fail')
    expect(burn.sentence).toContain('14535938')
    expect(burn.sentence).toContain('16612500')
  })
})

describe('a fully clean run (fixture c)', () => {
  const clean = reconcileRun(
    expectations({ committedRaw: 1_000_000n, pulledRaw: 1_002_500n, feeGeneration: 2 }),
    success([
      batchFact({ fundingTotal: 1_000_000n, fee: 2_500n, refunded: 0n }),
      { kind: 'fee-charged', burnSink: SINK, burnCut: 2_500n },
      ...deliveryFacts,
    ]),
  )

  it('every law answers pass — six verdicts, zero anything-else', () => {
    expect(clean).toHaveLength(6) // recipient, fee, burn, conservation, two legs
    for (const v of clean) expect(v.verdict).toBe('pass')
  })

  it('clean is true and the headline says so', () => {
    const summary = summarizeRun(clean)
    expect(summary.clean).toBe(true)
    expect(summary.headline).toContain('clean')
  })
})

describe('the floor law (fixture d)', () => {
  it('a floor breach on one leg FAILS naming the leg and both numbers', () => {
    const verdicts = reconcileRun(
      expectations(),
      success([
        batchFact(),
        { kind: 'fee-charged', burnSink: SINK, burnCut: FEE },
        { kind: 'delivery', asset: WETH, to: RECIPIENT, amount: 399n }, // floor 400
        { kind: 'delivery', asset: LINK, to: RECIPIENT, amount: 700n },
      ]),
    )
    const breach = verdicts.filter((v) => v.law === 'leg-floor' && v.verdict === 'fail')
    expect(breach).toHaveLength(1)
    expect(breach[0].sentence).toContain('WETH')
    expect(breach[0].sentence).toContain('399')
    expect(breach[0].sentence).toContain('400')
    expect(summarizeRun(verdicts).clean).toBe(false)
  })

  it('an optional leg that bought nothing is a lawful skip — bought-nothing IS the skip signal', () => {
    const verdicts = reconcileRun(
      expectations(),
      success([batchFact(), { kind: 'delivery', asset: WETH, to: RECIPIENT, amount: 450n }]),
    )
    const link = verdicts.filter((v) => v.law === 'leg-floor')[1]
    expect(link.verdict).toBe('pass')
    expect(link.sentence).toContain('skipped')
  })

  it('a REQUIRED leg that bought nothing fails', () => {
    const verdicts = reconcileRun(
      expectations(),
      success([batchFact(), { kind: 'delivery', asset: LINK, to: RECIPIENT, amount: 700n }]),
    )
    const weth = verdicts.filter((v) => v.law === 'leg-floor')[0]
    expect(weth.verdict).toBe('fail')
    expect(weth.sentence).toContain('not skippable')
  })

  it('no transfer facts at all refuses the whole law — undecoded is not delivered', () => {
    const verdicts = reconcileRun(expectations(), success([batchFact()]))
    const floors = verdicts.filter((v) => v.law === 'leg-floor')
    expect(floors).toHaveLength(1)
    expect(floors[0].verdict).toBe('unrecognized')
    expect(floors[0].sentence).toContain('undecoded is not delivered')
  })
})

describe('exactness means exact (fixture f)', () => {
  it('ONE WEI short of the fee floor fails, both numbers named', () => {
    const verdicts = reconcileRun(
      expectations({ committedRaw: 1_000_000n, pulledRaw: undefined, feeGeneration: 2, legs: [] }),
      success([batchFact({ fundingTotal: 1_000_000n, fee: 2_499n })]),
    )
    const fee = row(verdicts, 'fee-exactness')
    expect(fee.verdict).toBe('fail')
    expect(fee.sentence).toContain('2499')
    expect(fee.sentence).toContain('2500')
  })

  it('one wei OVER the floor fails too — impossible at the true rate, so our rate is stale', () => {
    const verdicts = reconcileRun(
      expectations({ committedRaw: 1_000_000n, pulledRaw: undefined, feeGeneration: 2, legs: [] }),
      success([batchFact({ fundingTotal: 1_000_000n, fee: 2_501n })]),
    )
    const fee = row(verdicts, 'fee-exactness')
    expect(fee.verdict).toBe('fail')
    expect(fee.sentence).toContain('stale')
  })

  it('a zero fee at a zero rate is legitimate — fee and burn both pass', () => {
    const verdicts = reconcileRun(
      expectations({ committedRaw: 1_000_000n, pulledRaw: 1_000_000n, feeBps: 0, feeGeneration: 2, legs: [] }),
      success([batchFact({ fundingTotal: 1_000_000n, fee: 0n })]),
    )
    expect(row(verdicts, 'fee-exactness').verdict).toBe('pass')
    expect(row(verdicts, 'burn-share').verdict).toBe('pass')
    expect(summarizeRun(verdicts).clean).toBe(true)
  })
})

describe('unrecognized events (fixture e) — absence of understanding never reads as cleanliness', () => {
  const alienTopic = `0x${'ab'.repeat(32)}`

  it('an alien event FROM the money contract yields unrecognized and the run is not clean', () => {
    const receipt = decodeReceiptFacts({
      status: 'success',
      logs: [
        batchExecutedLog({ fundingTotal: DEPLOYED, fee: FEE }),
        feeChargedLog(FEE),
        transferLog(WETH, RECIPIENT, 450n),
        transferLog(LINK, RECIPIENT, 700n),
        { address: BATCHER, topics: [alienTopic], data: '0x' },
      ],
      moneyContract: BATCHER,
      recipient: RECIPIENT,
    })
    const verdicts = reconcileRun(expectations(), receipt)
    const unknown = row(verdicts, 'event-recognition')
    expect(unknown.verdict).toBe('unrecognized')
    expect(unknown.observed).toContain(alienTopic)
    expect(summarizeRun(verdicts).clean).toBe(false)
  })

  it('the same alien event from ANOTHER contract is not the money contract’s business', () => {
    const receipt = decodeReceiptFacts({
      status: 'success',
      logs: [batchExecutedLog({ fundingTotal: DEPLOYED, fee: FEE }), { address: RECIPIENT, topics: [alienTopic], data: '0x' }],
      moneyContract: BATCHER,
      recipient: RECIPIENT,
    })
    expect(reconcileRun(expectations(), receipt).filter((v) => v.law === 'event-recognition')).toHaveLength(0)
  })

  it('a spoofed BatchExecuted from another address never enters the census — the address filter is load-bearing', () => {
    const receipt = decodeReceiptFacts({
      status: 'success',
      logs: [batchExecutedLog({ fundingTotal: DEPLOYED, fee: FEE, address: RECIPIENT })],
      moneyContract: BATCHER,
      recipient: RECIPIENT,
    })
    expect(row(reconcileRun(expectations(), receipt), 'fee-exactness').verdict).toBe('unrecognized')
  })

  it('a money-contract log wearing the right topic0 but the wrong bytes becomes an unknown fact, never a crash', () => {
    const truncated = { ...batchExecutedLog({ fundingTotal: DEPLOYED, fee: FEE }), data: `0x${word(DEPLOYED)}` } // 1 word, not 3
    const receipt = decodeReceiptFacts({ status: 'success', logs: [truncated], moneyContract: BATCHER, recipient: RECIPIENT })
    expect(receipt.facts[0].kind).toBe('unknown-money-event')
  })
})

describe('the refusal postures — silence is never proof', () => {
  it('a reverted receipt is ONE status fail and nothing else', () => {
    const verdicts = reconcileRun(expectations(), { status: 'reverted', facts: [] })
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].law).toBe('receipt-status')
    expect(verdicts[0].verdict).toBe('fail')
    expect(summarizeRun(verdicts).clean).toBe(false)
  })

  it('no batch event refuses every event-dependent law — an unverifiable run reads exactly like an unpaid one', () => {
    const verdicts = reconcileRun(expectations(), success([]))
    for (const law of ['recipient', 'fee-exactness', 'burn-share', 'conservation'] as const) {
      expect(row(verdicts, law).verdict).toBe('unrecognized')
    }
    expect(summarizeRun(verdicts).clean).toBe(false)
  })

  it('two batch events refuse the same way — no law covers a multi-batch run', () => {
    const verdicts = reconcileRun(expectations(), success([batchFact(), batchFact(), ...deliveryFacts]))
    expect(row(verdicts, 'fee-exactness').verdict).toBe('unrecognized')
    expect(row(verdicts, 'fee-exactness').observed).toBe('2 batch events')
  })

  it('conservation without the pull refuses and names exactly what is missing', () => {
    const verdicts = reconcileRun(
      expectations({ pulledRaw: undefined }),
      success([batchFact(), { kind: 'fee-charged', burnSink: SINK, burnCut: FEE }, ...deliveryFacts]),
    )
    const c = row(verdicts, 'conservation')
    expect(c.verdict).toBe('unrecognized')
    expect(c.sentence).toContain('pulledRaw')
    expect(summarizeRun(verdicts).clean).toBe(false)
  })

  it('a broken telescoping identity fails — one raw unit unaccounted is a defect, not rounding', () => {
    const verdicts = reconcileRun(
      expectations({ pulledRaw: PULLED + 1n }),
      success([batchFact(), ...deliveryFacts]),
    )
    const c = row(verdicts, 'conservation')
    expect(c.verdict).toBe('fail')
    expect(c.sentence).toContain('1 raw of the pull is unaccounted')
  })

  it('deploying beyond the committed plan fails with both numbers', () => {
    const verdicts = reconcileRun(
      expectations({ committedRaw: DEPLOYED - 1n }),
      success([batchFact(), ...deliveryFacts]),
    )
    const c = row(verdicts, 'conservation')
    expect(c.verdict).toBe('fail')
    expect(c.sentence).toContain(`${DEPLOYED}`)
    expect(c.sentence).toContain(`${DEPLOYED - 1n}`)
  })

  it('money landing at the wrong recipient fails', () => {
    const verdicts = reconcileRun(expectations(), success([batchFact({ recipient: SINK }), ...deliveryFacts]))
    const r = row(verdicts, 'recipient')
    expect(r.verdict).toBe('fail')
    expect(r.sentence).toContain(SINK)
  })

  it('a charged fee with NO burn fact refuses — a cut we cannot see burning must never read as burned', () => {
    const verdicts = reconcileRun(expectations(), success([batchFact(), ...deliveryFacts]))
    const burn = row(verdicts, 'burn-share')
    expect(burn.verdict).toBe('unrecognized')
    expect(burn.sentence).toContain('never read as burned')
  })

  it('a burn AND a divert in one run refuses — a split burn has no law here', () => {
    const verdicts = reconcileRun(
      expectations(),
      success([
        batchFact(),
        { kind: 'fee-charged', burnSink: SINK, burnCut: FEE },
        { kind: 'burn-diverted', sink: SINK, amount: 1n, fundingAsset: FUNDING, reason: '0x' },
        ...deliveryFacts,
      ]),
    )
    expect(row(verdicts, 'burn-share').verdict).toBe('unrecognized')
  })

  it('an empty verdict list is never clean — unproven is not clean', () => {
    const summary = summarizeRun([])
    expect(summary.clean).toBe(false)
    expect(summary.headline).toContain('proves nothing')
  })
})
