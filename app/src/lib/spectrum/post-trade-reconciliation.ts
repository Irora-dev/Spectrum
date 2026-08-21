import { decodeEventLog, toEventSelector } from 'viem'
import {
  BATCH_EXECUTED_TOPIC0,
  batchExecutedEvent,
  expectedBatchFee,
  type ReceiptLogLike,
} from './batch-fee-verification'
import { showChainId, showSymbol } from './safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// POST-TRADE RECONCILIATION — (what the run PROMISED) + (what the receipt SAYS)
// → typed verdicts, one per law, each a plain sentence a human can act on.
//
// WHY THIS EXISTS: the app holds every receipt at t=0 and asserts nothing about
// it; real incidents were found days later by humans decoding receipts by hand.
// The motivating one (the owner's Base decode, 2026-08-18 — cited at
// portfolio-batcher.ts:963): a batch charged its fee exactly, then emitted
// BurnDiverted for the WHOLE fee because the app supplied an empty burn route
// (portfolio-batcher.ts:481-484 — "the empty route DIVERTS the whole burn cut
// to the fallback sink … fail-closed, no loss, but no burn"). The receipt said
// so immediately; nobody read it. This module is the reader.
//
// WHAT IT BUILDS ON (reuse-never-recreate):
//  · batch-fee-verification.ts — the dormant fee-verification module. Reused
//    directly: `expectedBatchFee` (the exact fee floor, its law lines 17-23),
//    `batchExecutedEvent` + `BATCH_EXECUTED_TOPIC0` (the measured event shape,
//    its lines 31-37, 48-65) and `ReceiptLogLike`. NOT `verifyBatchFee`
//    wholesale: it binds decode+verdict to raw logs and answers the fee law
//    only, while reconciliation needs the same decoded facts across six laws —
//    so this module lifts its ABI + arithmetic and keeps its refusal posture
//    ("no matching event is a REFUSAL, never a clean result", its lines 28-29).
//  · settlement-verify.ts — pre-send decimals verification (RPC, refuses before
//    money moves). Orthogonal and composed with upstream, not duplicated: this
//    module runs strictly AFTER the trade, is pure, and never touches RPC.
//  · direct-swap-lane.ts:570-572 — `FeeCharged(address indexed burnSink,
//    uint256 burnCut)`. MIRRORED here (with a test pinning the mirror's topic0
//    against the real export, so they can never drift) rather than imported:
//    that module drags the RPC/pool stack into what must stay a pure module.
//
// THE LAWS, each derived from code, never invented:
//  · FEE EXACTNESS — fee == floor(fundingTotal_FROM_THE_EVENT · feeBps/10 000),
//    EXACT integer compare, never a tolerance (batch-fee-verification.ts:17-23;
//    runner-effects.ts:1291 — "fee = ONE floor over the sum"). Above the floor
//    is a stale-rate alarm, never a silent pass (batch-fee-verification.ts:113).
//  · BURN SHARE PER GENERATION — gen-1 splits 7:1, remainder-exact: burnCut ==
//    fee − fee/8 (direct-swap-wrapper.ts:38; runner-effects.ts:1292-1293); a
//    feeGeneration-2 (and every generation since) burns 100%: burnCut == fee
//    (direct-swap-lane.ts:570-572 "burnCut == fee on a feeGeneration-2 chain";
//    portfolio-batcher.ts:963-969; the 100%-burn ruling cited at
//    direct-swap-wrapper.ts:61-63). deployments.ts:273 types the config
//    discriminant 1|2 today; 3 is accepted here and carries gen-2's law.
//  · DIVERT HONESTY — BurnDiverted is a routing outcome, not a payment failure;
//    the fee was still charged (batch-fee-verification.ts:25-27) and the cut
//    parks at the fallback sink, fail-closed (decode-revert.ts:218). It yields
//    'divert-disclosed' naming the parked amount and sink — never a silent
//    pass, never a bare fail. NO EXPORT anywhere carries a BurnDiverted ABI
//    (only prose); the mirror below assumes FeeCharged's (address,uint256)
//    shape. The core is fact-shaped precisely so a corrected shape costs one
//    decode line — and a mismatched real shape decodes as an unknown money
//    event → 'unrecognized', fail-closed, never silently clean.
//  · FLOOR LAW — an executed leg is contract-bound to clear its floor and a
//    delivered amount below it means the guard did not hold; bought == 0 IS
//    the skip signal and only an `optional` leg may skip (runner-effects.ts:
//    1260-1281). A zero floor disables the only delivery guard
//    (portfolio-batcher.ts:418) — refused as unreadable, not scored.
//  · CONSERVATION — the contract's true identity telescopes over its own
//    MEASURED quantities: received == totalUsed + fee + refunded, with the
//    calldata pull standing in for `received` on the non-fee-on-transfer
//    settlement assets this app funds with (runner-effects.ts:1283-1311,
//    the cold reviewer's §P6′ answer). Checkable from receipt facts alone ONLY
//    when the expectations carry the pull; without it this module refuses
//    ('unrecognized') rather than guessing. Deployed-beyond-committed and
//    committed-money-vanished are checkable without the pull and fail hard.
//  · EVENT RECOGNITION — any event of the money contract this module does not
//    recognize yields 'unrecognized': absence of understanding must never read
//    as cleanliness (the same posture as batch-fee-verification.ts:102-109).
//
// PURE by construction: no RPC, no IO, no clock. The core takes DECODED facts
// and is total; `decodeReceiptFacts` is the small helper for callers holding
// raw logs, built on the existing ABI exports, and every undecodable
// money-contract log becomes an unknown fact, never a crash and never silence.
// ─────────────────────────────────────────────────────────────────────────────

// ── The event mirrors (each pinned by the test file) ─────────────────────────

/** The wrapper/batcher burn event — mirror of direct-swap-lane.ts:572's
 *  `feeChargedEventAbi` (see the header for why mirrored, not imported). */
export const FEE_CHARGED_SIGNATURE = 'FeeCharged(address,uint256)'
export const feeChargedEvent = {
  type: 'event',
  name: 'FeeCharged',
  inputs: [
    { name: 'burnSink', type: 'address', indexed: true },
    { name: 'burnCut', type: 'uint256', indexed: false },
  ],
} as const
export const FEE_CHARGED_TOPIC0 = toEventSelector(feeChargedEvent)

/** The divert disclosure — the incident's own event, now the REAL shape from
 *  abis-v2 (this module's first cut mirrored a guessed 2-arg form; the guess
 *  was fail-closed — a real divert decoded as unknown → unrecognized — and a
 *  live 2026-08-18 Base divert proved the actual 4-arg shape, so the mirror
 *  is retired for the export). `reason` carries the burn swap's own revert
 *  bytes; surfacing its selector names WHY the share diverted. */
export const BURN_DIVERTED_SIGNATURE = 'BurnDiverted(address,address,uint256,bytes)'
export { burnDivertedEvent } from './abis-v2'
import { burnDivertedEvent } from './abis-v2'
export const BURN_DIVERTED_TOPIC0 = toEventSelector(burnDivertedEvent)

/** Canonical ERC-20 Transfer — abis-v2.ts exports only function fragments
 *  (erc20BalanceAbi/erc20ApproveAbi, its lines 159-172), so the event lives
 *  here. Leg deliveries arrive as transfers TO the recipient. */
const transferEvent = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const
export const TRANSFER_TOPIC0 = toEventSelector(transferEvent)

// ── Inputs: what the run promised ────────────────────────────────────────────

/** The generation whose burn law binds. deployments.ts:273 types the shipped
 *  config 1|2; 3 is accepted and carries the same whole-fee law as 2. */
export type FeeGeneration = 1 | 2 | 3

export interface ExpectedLeg {
  /** The bought asset (BatchLeg.buyToken). */
  asset: string
  /** For sentences only — always rendered through showSymbol. */
  symbol: string
  /** OUR floor on measured delivery, raw units of the bought asset — the same
   *  number composition put on the leg (portfolio-batcher.ts:293-295). */
  floorRaw: bigint
  /** Thin-leg consent: this leg may lawfully skip and refund
   *  (runner-effects.ts:1271-1274). */
  optional: boolean
}

export interface RunExpectations {
  chainId: number
  /** The plan's deployed capital — the legs' committed sum, raw funding units
   *  (the composer fills it exactly; displayed-vs-signed.ts:747-748). */
  committedRaw: bigint
  /** The gross pull (calldata fundingTotal). OPTIONAL — without it the
   *  conservation identity is not checkable from receipt facts alone and that
   *  law answers 'unrecognized' rather than guessing. */
  pulledRaw?: bigint
  /** The operator's rate the run was composed at. */
  feeBps: number
  feeGeneration: FeeGeneration
  /** Product law: everything lands in the signer's own wallet
   *  (portfolio-batcher.ts:36-37). */
  recipient: string
  legs: readonly ExpectedLeg[]
}

// ── Inputs: what the receipt says (decoded facts — log-shape-agnostic) ───────

export type ReceiptFact =
  | {
      kind: 'batch-executed'
      recipient: string
      fundingAsset: string
      /** The MEASURED deployed total — the event's own third field, the fee's
       *  only honest base (batch-fee-verification.ts:18-21). */
      fundingTotal: bigint
      fee: bigint
      refunded: bigint
    }
  | { kind: 'fee-charged'; burnSink: string; burnCut: bigint }
  | { kind: 'burn-diverted'; sink: string; amount: bigint; fundingAsset: string; reason: `0x${string}` }
  /** An ERC-20 transfer of `asset` to `to` — a leg delivery when it matches. */
  | { kind: 'delivery'; asset: string; to: string; amount: bigint }
  /** A money-contract log this module could not read — law 6's raw material. */
  | { kind: 'unknown-money-event'; emitter: string; topic0: string | null }

export interface ReceiptFacts {
  status: 'success' | 'reverted'
  facts: readonly ReceiptFact[]
}

// ── Output: one verdict per law, sentences a human can act on ────────────────

export type ReconcileLaw =
  | 'receipt-status'
  | 'recipient'
  | 'fee-exactness'
  | 'burn-share'
  | 'divert-honesty'
  | 'leg-floor'
  | 'conservation'
  | 'event-recognition'

export type VerdictKind = 'pass' | 'fail' | 'divert-disclosed' | 'unrecognized'

export interface LawVerdict {
  law: ReconcileLaw
  verdict: VerdictKind
  /** What the law required — stated in words/raw numbers (strings so a verdict
   *  row survives JSON: bigint does not). */
  expected: string
  observed: string
  /** The plain-sentence one-liner — the thing a human reads at t=0. */
  sentence: string
}

// ── The burn law's own arithmetic ────────────────────────────────────────────

/** The generation's lawful burn cut of a charged fee. Gen-1: 7:1 remainder-
 *  exact split, burnCut == fee − fee/8 (direct-swap-wrapper.ts:38;
 *  runner-effects.ts:1292-1293 — "the 7:1 split is remainder-exact with both
 *  cuts exiting"). Gen-2/3: 100% burn, burnCut == fee (direct-swap-lane.ts:
 *  570-572; portfolio-batcher.ts:963-969). Floor division throughout — the
 *  contract's own integer math. */
export function expectedBurnCut(fee: bigint, generation: FeeGeneration): bigint {
  if (fee < 0n) throw new Error('expectedBurnCut: fee cannot be negative')
  return generation === 1 ? fee - fee / 8n : fee
}

// ── The core: expectations + facts → verdicts. Pure and total. ───────────────

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const genLawWords = (generation: FeeGeneration): string =>
  generation === 1 ? 'fee minus fee/8' : 'the whole fee'

export function reconcileRun(expected: RunExpectations, receipt: ReceiptFacts): LawVerdict[] {
  const out: LawVerdict[] = []

  // A reverted run rolled back: no money moved, and a reverted receipt carries
  // no logs to reconcile — the one honest verdict is the status itself.
  if (receipt.status === 'reverted') {
    out.push({
      law: 'receipt-status',
      verdict: 'fail',
      expected: 'a successful transaction',
      observed: 'reverted',
      sentence: `this run reverted on chain ${showChainId(expected.chainId)} — no money moved, and there is nothing further to reconcile.`,
    })
    return out
  }

  const batches = receipt.facts.filter((f) => f.kind === 'batch-executed')
  const burns = receipt.facts.filter((f) => f.kind === 'fee-charged')
  const diverts = receipt.facts.filter((f) => f.kind === 'burn-diverted')
  const deliveries = receipt.facts.filter((f) => f.kind === 'delivery')
  const unknowns = receipt.facts.filter((f) => f.kind === 'unknown-money-event')

  // ── Every event-dependent law refuses together when the event is absent or
  //    ambiguous: an unverifiable batch reads exactly like an unpaid one until
  //    someone looks (batch-fee-verification.ts:28-29). ──
  const ev = batches.length === 1 ? batches[0] : null
  if (ev == null) {
    const observed = batches.length === 0 ? 'no batch event' : `${batches.length} batch events`
    const sentence =
      batches.length === 0
        ? 'no batch event reached these facts — an unverifiable run reads exactly like an unpaid one until someone looks.'
        : `this receipt carries ${batches.length} batch events — this module has no law for a multi-batch run, so nothing about the money is scored by guesswork.`
    for (const law of ['recipient', 'fee-exactness', 'burn-share', 'conservation'] as const) {
      out.push({ law, verdict: 'unrecognized', expected: 'exactly one BatchExecuted from the money contract', observed, sentence })
    }
  } else {
    // ── RECIPIENT — everything lands in the signer's own wallet. ──
    if (eq(ev.recipient, expected.recipient)) {
      out.push({
        law: 'recipient',
        verdict: 'pass',
        expected: expected.recipient.toLowerCase(),
        observed: ev.recipient.toLowerCase(),
        sentence: `everything this batch bought lands where the plan says — ${expected.recipient.toLowerCase()}.`,
      })
    } else {
      out.push({
        law: 'recipient',
        verdict: 'fail',
        expected: expected.recipient.toLowerCase(),
        observed: ev.recipient.toLowerCase(),
        sentence: `the batch delivered to ${ev.recipient.toLowerCase()}, not the ${expected.recipient.toLowerCase()} the plan named — money landed at the wrong address.`,
      })
    }

    // ── FEE EXACTNESS — the event's OWN base, exact to the wei. ──
    let lawfulFee: bigint | null = null
    try {
      lawfulFee = expectedBatchFee(ev.fundingTotal, expected.feeBps)
    } catch {
      out.push({
        law: 'fee-exactness',
        verdict: 'unrecognized',
        expected: 'a whole-bps rate in [0, 10000] and a non-negative measured total',
        observed: `feeBps ${expected.feeBps}, deployed ${ev.fundingTotal} raw`,
        sentence: 'these expectations cannot score a fee — the rate is not a whole bps in range (or the measure is negative), and a broken rate scores nothing.',
      })
    }
    if (lawfulFee != null) {
      if (ev.fee === lawfulFee) {
        out.push({
          law: 'fee-exactness',
          verdict: 'pass',
          expected: `${lawfulFee} raw`,
          observed: `${ev.fee} raw`,
          sentence: `the fee is exactly floor(${ev.fundingTotal} × ${expected.feeBps} / 10000) = ${ev.fee} raw — the contract's own equation, to the wei.`,
        })
      } else if (ev.fee < lawfulFee) {
        out.push({
          law: 'fee-exactness',
          verdict: 'fail',
          expected: `${lawfulFee} raw`,
          observed: `${ev.fee} raw`,
          sentence: `the batch charged ${ev.fee} raw where ${lawfulFee} raw was owed at ${expected.feeBps} bps on ${ev.fundingTotal} deployed — ${lawfulFee - ev.fee} raw short. Exact means exact.`,
        })
      } else {
        out.push({
          law: 'fee-exactness',
          verdict: 'fail',
          expected: `${lawfulFee} raw`,
          observed: `${ev.fee} raw`,
          sentence: `the batch charged ${ev.fee} raw where the ${expected.feeBps} bps law says ${lawfulFee} raw on ${ev.fundingTotal} deployed — above the floor is impossible at the true rate, so our rate assumption is stale. Never a silent pass.`,
        })
      }
    }

    // ── BURN SHARE — the generation's own cut of the charged fee. ──
    out.push(burnShareVerdict(expected, ev.fee, burns, diverts))

    // ── CONSERVATION — §P6′'s telescoping identity, only as far as the facts
    //    can carry it. ──
    out.push(conservationVerdict(expected, ev))
  }

  // ── DIVERT HONESTY — the disclosure is honored whenever it appears, batch
  //    event or not: never a silent pass, never a bare fail. ──
  for (const d of diverts) {
    out.push({
      law: 'divert-honesty',
      verdict: 'divert-disclosed',
      expected: 'the burn cut buys and burns',
      observed: `${d.amount} raw parked at ${d.sink.toLowerCase()}`,
      sentence: `the receipt says so itself: ${d.amount} raw of burn cut diverted to the fallback sink ${d.sink.toLowerCase()} instead of burning — fail-closed parking, no loss, no burn. It said so at t=0.`,
    })
  }

  // ── FLOOR LAW — per leg, from delivery facts. ──
  out.push(...legFloorVerdicts(expected, deliveries))

  // ── EVENT RECOGNITION — an unread money event is never cleanliness. ──
  for (const u of unknowns) {
    out.push({
      law: 'event-recognition',
      verdict: 'unrecognized',
      expected: 'an event this module recognizes',
      observed: `topic0 ${u.topic0 ?? 'unreadable'} from ${u.emitter.toLowerCase()}`,
      sentence: 'the money contract emitted something this module does not recognize — absence of understanding must never read as cleanliness. Decode it before calling this run clean.',
    })
  }

  return out
}

function burnShareVerdict(
  expected: RunExpectations,
  fee: bigint,
  burns: readonly Extract<ReceiptFact, { kind: 'fee-charged' }>[],
  diverts: readonly Extract<ReceiptFact, { kind: 'burn-diverted' }>[],
): LawVerdict {
  const gen = expected.feeGeneration
  let cut: bigint
  try {
    cut = expectedBurnCut(fee, gen)
  } catch {
    return {
      law: 'burn-share',
      verdict: 'unrecognized',
      expected: 'a non-negative charged fee',
      observed: `${fee} raw`,
      sentence: 'a negative measure is not a receipt fact — nothing about the burn is scored from it.',
    }
  }
  // The zero-rate integrator is legitimate: floor(x·0) has no cut to burn
  // (batch-fee-verification.ts:22-23).
  if (fee === 0n && burns.length === 0 && diverts.length === 0) {
    return {
      law: 'burn-share',
      verdict: 'pass',
      expected: '0 raw burn cut',
      observed: 'no burn fact',
      sentence: 'a zero fee has no burn cut — nothing burning is lawful at a zero rate.',
    }
  }
  if (burns.length > 0 && diverts.length > 0) {
    return {
      law: 'burn-share',
      verdict: 'unrecognized',
      expected: 'one burn fact — a burn OR a disclosed divert',
      observed: `${burns.length} burn + ${diverts.length} divert facts`,
      sentence: 'this receipt shows both a burn and a divert for one run — a split burn has no law here, so it is refused rather than guessed at.',
    }
  }
  if (burns.length === 1) {
    const got = burns[0].burnCut
    if (got === cut) {
      return {
        law: 'burn-share',
        verdict: 'pass',
        expected: `${cut} raw`,
        observed: `${got} raw`,
        sentence: `the burn cut is ${got} raw of a ${fee} raw fee — generation ${gen}'s own law (${genLawWords(gen)}).`,
      }
    }
    return {
      law: 'burn-share',
      verdict: 'fail',
      expected: `${cut} raw`,
      observed: `${got} raw`,
      sentence: `generation ${gen} burns ${cut} raw of this ${fee} raw fee (${genLawWords(gen)}); the receipt burned ${got} raw — the sizing is wrong by ${got > cut ? got - cut : cut - got} raw.`,
    }
  }
  if (burns.length > 1) {
    return {
      law: 'burn-share',
      verdict: 'unrecognized',
      expected: 'one FeeCharged for one run',
      observed: `${burns.length} FeeCharged facts`,
      sentence: `this receipt carries ${burns.length} burn events for one run — no law here covers that, so the cut is not scored by guesswork.`,
    }
  }
  if (diverts.length === 1) {
    const parked = diverts[0].amount
    if (parked === cut) {
      return {
        law: 'burn-share',
        verdict: 'divert-disclosed',
        expected: `${cut} raw burned`,
        observed: `${parked} raw parked`,
        sentence: `the ${parked} raw burn cut is sized to generation ${gen}'s law (${genLawWords(gen)}) but parked at the fallback sink instead of burning — disclosed, not clean.`,
      }
    }
    return {
      law: 'burn-share',
      verdict: 'fail',
      expected: `${cut} raw burned`,
      observed: `${parked} raw parked`,
      sentence: `the receipt parked ${parked} raw of burn cut where generation ${gen}'s law sizes the cut at ${cut} raw — mis-sized AND unburned.`,
    }
  }
  if (diverts.length > 1) {
    return {
      law: 'burn-share',
      verdict: 'unrecognized',
      expected: 'one divert disclosure for one run',
      observed: `${diverts.length} BurnDiverted facts`,
      sentence: `this receipt discloses ${diverts.length} diverts for one run — no law here covers that, so the cut is not scored by guesswork.`,
    }
  }
  return {
    law: 'burn-share',
    verdict: 'unrecognized',
    expected: `${cut} raw burned (generation ${gen}: ${genLawWords(gen)})`,
    observed: 'no burn fact in the receipt',
    sentence: `a ${fee} raw fee was charged but no burn fact reached these logs — a cut we cannot see burning must never read as burned.`,
  }
}

function conservationVerdict(
  expected: RunExpectations,
  ev: Extract<ReceiptFact, { kind: 'batch-executed' }>,
): LawVerdict {
  const committed = expected.committedRaw
  if (committed <= 0n) {
    return {
      law: 'conservation',
      verdict: 'unrecognized',
      expected: 'a positive committed amount',
      observed: `${committed} raw committed`,
      sentence: 'these expectations commit nothing — a plan with no committed amount cannot be reconciled against money that moved.',
    }
  }
  if (ev.fundingTotal < 0n || ev.fee < 0n || ev.refunded < 0n) {
    return {
      law: 'conservation',
      verdict: 'unrecognized',
      expected: 'non-negative measured quantities',
      observed: `deployed ${ev.fundingTotal}, fee ${ev.fee}, refunded ${ev.refunded}`,
      sentence: 'a negative measure is not a receipt fact — nothing about the money is scored from it.',
    }
  }
  // Deployed beyond the plan is checkable with no pull at all.
  if (ev.fundingTotal > committed) {
    return {
      law: 'conservation',
      verdict: 'fail',
      expected: `deployed ≤ ${committed} raw committed`,
      observed: `${ev.fundingTotal} raw deployed`,
      sentence: `the batch deployed ${ev.fundingTotal} raw where the plan committed ${committed} — more money moved than was ever committed.`,
    }
  }
  // So is committed money vanishing: what deployed plus what came back must
  // cover the committed amount, because the fee is charged ON TOP of what
  // deploys (portfolio-batcher.ts:24-27) and the pull covers committed + fee
  // by composition law (displayed-vs-signed.ts:747-748).
  if (ev.fundingTotal + ev.refunded < committed) {
    return {
      law: 'conservation',
      verdict: 'fail',
      expected: `deployed + refunded ≥ ${committed} raw committed`,
      observed: `${ev.fundingTotal} deployed + ${ev.refunded} refunded`,
      sentence: `of the ${committed} raw committed, ${ev.fundingTotal} deployed and ${ev.refunded} came back — ${committed - ev.fundingTotal - ev.refunded} raw is unaccounted even before the fee.`,
    }
  }
  const pulled = expected.pulledRaw
  if (pulled == null) {
    return {
      law: 'conservation',
      verdict: 'unrecognized',
      expected: 'the pull, to close received == deployed + fee + refunded',
      observed: 'expectations carry no pulledRaw',
      sentence: 'deployed-within-committed holds, but the receipt alone cannot account the full outflow — the identity received == deployed + fee + refunded needs the pull, and these expectations do not carry it. Supply pulledRaw to close it.',
    }
  }
  const accounted = ev.fundingTotal + ev.fee + ev.refunded
  if (accounted === pulled) {
    return {
      law: 'conservation',
      verdict: 'pass',
      expected: `${pulled} raw pulled`,
      observed: `${ev.fundingTotal} deployed + ${ev.fee} fee + ${ev.refunded} refunded = ${accounted}`,
      sentence: `${ev.fundingTotal} deployed + ${ev.fee} fee + ${ev.refunded} refunded = ${pulled} pulled — every raw unit accounted on chain ${showChainId(expected.chainId)}.`,
    }
  }
  const gap = accounted - pulled
  return {
    law: 'conservation',
    verdict: 'fail',
    expected: `${pulled} raw pulled`,
    observed: `${ev.fundingTotal} deployed + ${ev.fee} fee + ${ev.refunded} refunded = ${accounted}`,
    sentence:
      gap < 0n
        ? `the pull does not telescope: deployed + fee + refunded is ${accounted} raw against a ${pulled} raw pull — ${-gap} raw of the pull is unaccounted. That is a defect, not rounding.`
        : `the pull does not telescope: deployed + fee + refunded is ${accounted} raw against a ${pulled} raw pull — ${gap} raw more came out than went in, a defect to catch, not tolerate.`,
  }
}

function legFloorVerdicts(
  expected: RunExpectations,
  deliveries: readonly Extract<ReceiptFact, { kind: 'delivery' }>[],
): LawVerdict[] {
  if (expected.legs.length === 0) return []
  // No delivery facts of any kind: the class is undecoded, and undecoded is
  // not delivered — one refusal for the law rather than a guess per leg.
  const toRecipient = deliveries.filter((d) => eq(d.to, expected.recipient))
  if (deliveries.length === 0) {
    return [
      {
        law: 'leg-floor',
        verdict: 'unrecognized',
        expected: `${expected.legs.length} legs with decoded deliveries`,
        observed: 'no transfer facts',
        sentence: 'no delivery transfers reached these facts, so no floor can be checked — undecoded is not delivered.',
      },
    ]
  }
  const out: LawVerdict[] = []
  for (const leg of expected.legs) {
    const sym = showSymbol(leg.symbol)
    if (leg.floorRaw <= 0n) {
      // A zero floor disables the only delivery guard (portfolio-batcher.ts:418)
      // — composition refuses it, so an expectation carrying one is broken.
      out.push({
        law: 'leg-floor',
        verdict: 'unrecognized',
        expected: 'a positive floor',
        observed: `${leg.floorRaw} raw floor on $${sym}`,
        sentence: `$${sym}: this leg's expectation carries no floor — a zero floor disables the only delivery guard, so there is nothing to check against.`,
      })
      continue
    }
    let delivered = 0n
    for (const d of toRecipient) if (eq(d.asset, leg.asset)) delivered += d.amount
    if (delivered === 0n) {
      if (leg.optional) {
        out.push({
          law: 'leg-floor',
          verdict: 'pass',
          expected: `≥ ${leg.floorRaw} raw, or a lawful skip`,
          observed: 'no delivery',
          sentence: `$${sym}: skipped and refunded — a skippable leg that bought nothing is lawful (bought-nothing IS the skip signal).`,
        })
      } else {
        out.push({
          law: 'leg-floor',
          verdict: 'fail',
          expected: `≥ ${leg.floorRaw} raw`,
          observed: 'no delivery',
          sentence: `$${sym}: this leg is not skippable yet nothing arrived — expected at least ${leg.floorRaw} raw, received none.`,
        })
      }
    } else if (delivered < leg.floorRaw) {
      out.push({
        law: 'leg-floor',
        verdict: 'fail',
        expected: `≥ ${leg.floorRaw} raw`,
        observed: `${delivered} raw`,
        sentence: `$${sym}: delivered ${delivered} raw against a ${leg.floorRaw} raw floor — below the floor the contract was bound to enforce; the guard did not hold.`,
      })
    } else {
      out.push({
        law: 'leg-floor',
        verdict: 'pass',
        expected: `≥ ${leg.floorRaw} raw`,
        observed: `${delivered} raw`,
        sentence: `$${sym}: delivered ${delivered} raw, at or above its ${leg.floorRaw} raw floor.`,
      })
    }
  }
  return out
}

// ── The run-level summary ────────────────────────────────────────────────────

/** Clean is strict: EVERY verdict must be 'pass'. Zero 'fail' and zero
 *  'unrecognized' are necessary but not sufficient — a disclosed divert is
 *  disclosed, not clean (the burn is the reason the fee exists;
 *  direct-swap-wrapper.ts:41-42). An empty verdict list proves nothing and
 *  nothing-proven is never clean. */
export function summarizeRun(verdicts: readonly LawVerdict[]): { clean: boolean; headline: string } {
  if (verdicts.length === 0) {
    return { clean: false, headline: 'nothing was reconciled — an empty verdict list proves nothing, and unproven is not clean.' }
  }
  const fails = verdicts.filter((v) => v.verdict === 'fail')
  const unrecognized = verdicts.filter((v) => v.verdict === 'unrecognized')
  const diverted = verdicts.filter((v) => v.verdict === 'divert-disclosed')
  if (fails.length > 0) {
    return {
      clean: false,
      headline: `this run is not clean — ${fails.length} law${fails.length === 1 ? '' : 's'} broken. First: ${fails[0].sentence}`,
    }
  }
  if (unrecognized.length > 0) {
    return {
      clean: false,
      headline: `this run is not proven — ${unrecognized.length} check${unrecognized.length === 1 ? '' : 's'} could not be read, and absence of understanding never reads as cleanliness. First: ${unrecognized[0].sentence}`,
    }
  }
  if (diverted.length > 0) {
    return {
      clean: false,
      headline: `every scored law holds except the burn: the burn cut diverted instead of burning. ${diverted[0].sentence}`,
    }
  }
  return {
    clean: true,
    headline: `clean — every law this receipt can answer holds (${verdicts.length} checks: fee exact, burn lawful, floors cleared, money accounted).`,
  }
}

// ── The decode helper — raw logs → facts, on the existing ABI exports ────────

type EventTopics = [`0x${string}`, ...`0x${string}`[]]

/**
 * Decode a receipt's logs into facts for `reconcileRun`. Built on the existing
 * exports: `batchExecutedEvent`/`BATCH_EXECUTED_TOPIC0` (batch-fee-
 * verification.ts) plus the pinned mirrors above. The address filter is
 * load-bearing, exactly as in verifyBatchFee (its lines 151-154): only logs
 * FROM the money contract are its events — a spoofed event from another
 * address never enters the census. Transfers TO the recipient (from any token
 * contract) become delivery facts. A money-contract log that will not decode
 * becomes an unknown fact — refusal downstream, never a crash, never silence.
 */
export function decodeReceiptFacts(args: {
  status: 'success' | 'reverted'
  logs: readonly ReceiptLogLike[]
  /** The batcher (or wrapper) whose events are law for this run. */
  moneyContract: string
  recipient: string
}): ReceiptFacts {
  const money = args.moneyContract.toLowerCase()
  const recipient = args.recipient.toLowerCase()
  const facts: ReceiptFact[] = []
  for (const log of args.logs) {
    const topic0 = log.topics[0]?.toLowerCase() ?? null
    if (log.address.toLowerCase() === money) {
      const unknown: ReceiptFact = { kind: 'unknown-money-event', emitter: log.address, topic0 }
      if (topic0 === BATCH_EXECUTED_TOPIC0.toLowerCase()) {
        try {
          const d = decodeEventLog({
            abi: [batchExecutedEvent],
            data: log.data as `0x${string}`,
            topics: log.topics as EventTopics,
          }).args as { recipient: string; fundingAsset: string; fundingTotal: bigint; fee: bigint; refunded: bigint }
          facts.push({
            kind: 'batch-executed',
            recipient: d.recipient.toLowerCase(),
            fundingAsset: d.fundingAsset.toLowerCase(),
            fundingTotal: d.fundingTotal,
            fee: d.fee,
            refunded: d.refunded,
          })
        } catch {
          facts.push(unknown)
        }
      } else if (topic0 === FEE_CHARGED_TOPIC0.toLowerCase()) {
        try {
          const d = decodeEventLog({
            abi: [feeChargedEvent],
            data: log.data as `0x${string}`,
            topics: log.topics as EventTopics,
          }).args as { burnSink: string; burnCut: bigint }
          facts.push({ kind: 'fee-charged', burnSink: d.burnSink.toLowerCase(), burnCut: d.burnCut })
        } catch {
          facts.push(unknown)
        }
      } else if (topic0 === BURN_DIVERTED_TOPIC0.toLowerCase()) {
        try {
          const d = decodeEventLog({
            abi: [burnDivertedEvent],
            data: log.data as `0x${string}`,
            topics: log.topics as EventTopics,
          }).args as { sink: string; fundingAsset: string; amount: bigint; reason: `0x${string}` }
          facts.push({ kind: 'burn-diverted', sink: d.sink.toLowerCase(), amount: d.amount, fundingAsset: d.fundingAsset.toLowerCase(), reason: d.reason })
        } catch {
          facts.push(unknown)
        }
      } else {
        facts.push(unknown)
      }
    } else if (topic0 === TRANSFER_TOPIC0.toLowerCase()) {
      // Another contract's Transfer — a delivery only when it lands on the
      // recipient. Anything else (ERC-721 Transfers decode differently, other
      // parties' movements) is other contracts' business, not a money event.
      try {
        const d = decodeEventLog({
          abi: [transferEvent],
          data: log.data as `0x${string}`,
          topics: log.topics as EventTopics,
        }).args as { from: string; to: string; value: bigint }
        if (d.to.toLowerCase() === recipient) {
          facts.push({ kind: 'delivery', asset: log.address.toLowerCase(), to: d.to.toLowerCase(), amount: d.value })
        }
      } catch {
        /* not an ERC-20 transfer shape — not a leg delivery */
      }
    }
  }
  return { status: args.status, facts }
}
