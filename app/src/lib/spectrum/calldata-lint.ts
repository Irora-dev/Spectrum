import { decodeFunctionData, zeroAddress } from 'viem'
import type { Abi, Address, DecodeFunctionDataReturnType, Hex } from 'viem'
import { BATCH_FEE_BPS, GEN2_BATCH_FEE_BPS } from './allocation'
import {
  PORTFOLIO_BATCH_BUY_SELECTOR,
  PORTFOLIO_BATCH_BUY_SELECTOR_GEN2,
  PORTFOLIO_MAX_DEADLINE_WINDOW_SEC,
  PORTFOLIO_MAX_FEE_BPS,
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

// ─────────────────────────────────────────────────────────────────────────────
// THE CALLDATA LINT (hardening wave A) — an INDEPENDENT decoder that re-checks
// composed money calldata against the money laws right before a wallet prompt.
//
// This is a DELIBERATE SECOND DERIVATION, used ONLY as a cross-check and never
// as a source of numbers: the composer derives the call, this module decodes
// the finished bytes with the same pinned ABIs and re-judges them against the
// laws. Nothing decoded here may flow back into composition — a lint that
// feeds the pipeline becomes the pipeline, and the independence is the point.
// It complements displayed-vs-signed.ts (which binds the bytes to what the
// REVIEW showed); this gate binds the bytes to the LAWS themselves, so it
// catches a pipeline that displayed the same wrong number it signed.
//
// PURE by construction: no IO, no RPC, no clock reads — the caller supplies
// nowSeconds (money time is chain time, portfolio-batcher.ts:314-316).
// FAIL CLOSED: an unknown selector or undecodable bytes are NEVER clean
// (displayed-vs-signed.ts:33-35 states the same law for the sibling gate).
// Scope v1 = the two call families this app signs into its own fee rails:
// the portfolio batcher's batchBuy and the direct-swap wrapper's swapWithFee,
// each on both fee generations (the calldata's own selector says which —
// batch gen-1 0x0c8ef5f9 / gen-2 0x2c84261e, portfolio-batcher.ts:224/:275).
//
// THE LAWS, each with its source (file:line as of the wave-A reading):
//  1 fee-bounds ......... batch gen-1 charges BATCH_FEE_BPS (allocation.ts:70),
//                         gen-2 GEN2_BATCH_FEE_BPS (allocation.ts:72-77); the
//                         wrapper charges WRAPPER_FEE_BPS on EVERY generation
//                         and deliberately NOT the batcher's number
//                         (direct-swap-wrapper.ts:61-68). The contracts cannot
//                         enforce the rate — their ceiling permits 5× policy
//                         and calldata is trusted for it (allocation.ts:63-69,
//                         portfolio-batcher.ts:66, direct-swap-wrapper.ts:26).
//  2 native-value ....... wrapper native sell (sellToken address(0),
//                         direct-swap-wrapper.ts:21): msg.value MUST equal
//                         sellAmount + fee EXACTLY or the contract reverts
//                         WrongNativeValue (direct-swap-wrapper.ts:18-20); the
//                         fee formula is the contract's own floor division,
//                         imported here as wrapperFeeRaw (:87-91). An ERC-20
//                         sell carries 0 (:96-98). batchBuy is nonpayable and
//                         funding is ERC-20 only — value 0 always
//                         (portfolio-batcher.ts:28-29, :338-339).
//  3 floor-present ...... a zero/one-wei minBuy is a gutted floor, not a small
//                         one: the never-a-zero-floor invariant
//                         (swap-quote.ts:254, :261-263) and the one-wei-gutting
//                         precedent (displayed-vs-signed.ts:46-48). Passing one
//                         takes EXPLICIT consent ({ allowNoFloor: true }) — the
//                         same shape as the app's consent surfaces (thin-leg
//                         `optional`, portfolio-batcher.ts:298-299): chosen out
//                         loud, scoped to one law, never a silent default.
//  4 burn-route-present . generation-2 burns ALL of the fee, so an empty
//                         burnSwapData diverts the WHOLE fee to the fallback
//                         sink instead of burning (portfolio-batcher.ts:963-969
//                         — the owner's Base decode 2026-08-18; the divert must
//                         be said out loud, :1013-1018). Explicit consent
//                         ({ allowDivert: true }) is the only pass. Gen-1's 7/8
//                         divert stays a compose-time surfaced refusal — not
//                         this law's business (v1 scope: the 100%-burn
//                         generation, where the incident class lives).
//  5 deadline-sane ...... strictly ahead of the caller's clock, and bounded
//                         above: batch now+24h max, DeadlineTooFar
//                         (portfolio-batcher.ts:32-33, :69); wrapper inclusive
//                         and capped 24h (direct-swap-wrapper.ts:26, :78) — a
//                         far deadline makes the signature a standing grant.
//  6 recipient-match .... batch recipient is the signer, product law
//                         (portfolio-batcher.ts:35-38, :311-313). The wrapper
//                         has NO recipient param — everything lands in
//                         msg.sender (direct-swap-wrapper.ts:24-25) — so on
//                         that lane this law pins the gen-1 fee sink when the
//                         caller declares it (the destination the contract
//                         validates only against zero, allocation.ts:63-69).
//  7 unrecognized ....... what cannot be read is never clean — fail closed
//                         (displayed-vs-signed.ts:33-35).
// ─────────────────────────────────────────────────────────────────────────────

export type LintLaw =
  | 'fee-bounds'
  | 'native-value'
  | 'floor-present'
  | 'burn-route-present'
  | 'deadline-sane'
  | 'recipient-match'
  | 'unrecognized'

export interface LintFinding {
  law: LintLaw
  /** 'violation' = decoded fine and breaks a law; 'unrecognized' = could not
   *  be read at all (which is itself never clean — law 7). */
  level: 'violation' | 'unrecognized'
  /** Plain words, self-contained, naming the numbers — refusals are sentences,
   *  never crashes (portfolio-batcher.ts:37-38's own grammar). */
  sentence: string
  /** The lawful value, stringified (decimal for amounts/bps, an inclusive
   *  `lo..hi` window for deadlines, verbatim address for recipients). */
  expected?: string
  /** What the bytes actually carry, stringified the same way. */
  observed?: string
}

/** Explicit consent, scoped one flag per law — nothing here weakens any other
 *  check, and absence of a flag is always the strict path. */
export interface LintConsent {
  /** The caller chose a floorless call out loud (the protection-dial 'none'
   *  shape) — law 3 stands down for THIS call only. */
  allowNoFloor?: boolean
  /** The caller accepts this run's fee diverting to the fallback sink instead
   *  of burning — law 4 stands down for THIS call only. */
  allowDivert?: boolean
}

export interface BatchLintExpectation {
  /** The signer's own address — recipient == signer is product law. */
  recipient: Address
  /** The caller's clock, seconds — supplied, never read (pure module). */
  nowSeconds: number
  /** Ceiling for how far ahead a deadline may sit, inclusive. Absent = the
   *  contract's own cap (PORTFOLIO_MAX_DEADLINE_WINDOW_SEC); a caller may pass
   *  a TIGHTER product horizon, never a wider one usefully (the chain still
   *  enforces its own). */
  maxHorizonSeconds?: number
  /** Gen-1 only: the declared fee sink. Compared when BOTH declared and
   *  present in the decoded shape (gen-2 has no such field — 100% burn). */
  feeRecipient?: Address
}

export interface WrapperLintExpectation {
  nowSeconds: number
  /** Absent = the wrapper's own inclusive 24h cap (WRAPPER_MAX_DEADLINE_SEC). */
  maxHorizonSeconds?: number
  /** Gen-1 only: the declared integrator sink (fee/8 lands there). */
  feeRecipient?: Address
}

export interface BatchLintInput {
  /** The exact bytes the wallet will be asked to sign. */
  data: Hex
  /** The tx's native value; absent = 0n (what a valueless tx sends). */
  value?: bigint
  expected: BatchLintExpectation
  consent?: LintConsent
}

export interface WrapperLintInput {
  data: Hex
  value?: bigint
  expected: WrapperLintExpectation
  consent?: LintConsent
}

/** decodeFunctionData that answers null instead of throwing — the lint's
 *  boundary between "readable" and law 7. Built on the SAME imported ABIs the
 *  composers encode with; never a re-declared fragment. */
export function decodeOrNull<const abi extends Abi | readonly unknown[]>(
  abi: abi,
  data: Hex,
): DecodeFunctionDataReturnType<abi> | null {
  try {
    return decodeFunctionData({ abi, data })
  } catch {
    return null
  }
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const emptyBytes = (b: Hex | null | undefined): boolean => b == null || b === '0x'

/** Law 5, shared by both lanes: strictly ahead of now, inclusively within the
 *  horizon (the wrapper's cap is stated inclusive, direct-swap-wrapper.ts:26;
 *  the batch cap is a window above now, portfolio-batcher.ts:32-33). */
function deadlineFinding(deadline: bigint, nowSeconds: number, horizonSeconds: number): LintFinding | null {
  const now = BigInt(Math.trunc(nowSeconds))
  const horizon = BigInt(Math.trunc(horizonSeconds))
  const lawful = `${(now + 1n).toString()}..${(now + horizon).toString()}`
  if (deadline <= now) {
    return {
      law: 'deadline-sane',
      level: 'violation',
      sentence: `the deadline (${deadline.toString()}s) is not strictly ahead of the caller's clock (${now.toString()}s) — an expired deadline reverts on arrival`,
      expected: lawful,
      observed: deadline.toString(),
    }
  }
  if (deadline > now + horizon) {
    return {
      law: 'deadline-sane',
      level: 'violation',
      sentence: `the deadline (${deadline.toString()}s) sits past the ${horizon.toString()}s horizon after the caller's clock (${now.toString()}s) — deadlines are bounded above (the 24h cap), and a farther one turns the signature into a standing grant`,
      expected: lawful,
      observed: deadline.toString(),
    }
  }
  return null
}

interface DecodedBatchBuy {
  generation: 1 | 2
  legs: readonly { buyToken: Address; sellAmount: bigint; minBuyAmount: bigint; swapData: Hex; optional: boolean }[]
  recipient: Address
  deadline: bigint
  feeBps: number
  /** null on gen-2 — the tuple has no such field (100% burn, no integrator). */
  feeRecipient: Address | null
  burnSwapData: Hex
}

/** Try gen-2 first (the production ceremony), then gen-1 — the selectors are
 *  disjoint, so exactly one ABI can read a given call. */
function decodeBatchBuy(data: Hex): DecodedBatchBuy | null {
  const gen2 = decodeOrNull(portfolioBatcherAbiGen2, data)
  if (gen2 != null) {
    const [legs, , , p] = gen2.args
    return {
      generation: 2,
      legs,
      recipient: p.recipient,
      deadline: p.deadline,
      feeBps: p.feeBps,
      feeRecipient: null,
      burnSwapData: p.burnSwapData,
    }
  }
  const gen1 = decodeOrNull(portfolioBatcherAbi, data)
  if (gen1 != null) {
    const [legs, , , p] = gen1.args
    return {
      generation: 1,
      legs,
      recipient: p.recipient,
      deadline: p.deadline,
      feeBps: p.feeBps,
      feeRecipient: p.feeRecipient,
      burnSwapData: p.burnSwapData,
    }
  }
  return null
}

/**
 * Re-check composed batchBuy bytes against the money laws. Clean = [] —
 * anything else must stop the wallet prompt (or be shown, per the caller's
 * surface; this module only judges, it never prompts or blocks by itself).
 */
export function lintBatchCalldata(input: BatchLintInput): LintFinding[] {
  const decoded = decodeBatchBuy(input.data)
  if (decoded == null) {
    return [
      {
        law: 'unrecognized',
        level: 'unrecognized',
        sentence: `this calldata does not decode as batchBuy on either generation's ABI (${PORTFOLIO_BATCH_BUY_SELECTOR} / ${PORTFOLIO_BATCH_BUY_SELECTOR_GEN2}) — an unreadable call is never clean, and must not reach a wallet prompt`,
      },
    ]
  }
  const findings: LintFinding[] = []
  const consent = input.consent ?? {}
  const value = input.value ?? 0n

  // 1 · fee-bounds — the lane's own constant per the generation THE BYTES
  // speak (allocation.ts:70 gen-1, :72-77 gen-2; the contract trusts calldata
  // for the rate, allocation.ts:63-69).
  const laneFeeBps = decoded.generation === 2 ? GEN2_BATCH_FEE_BPS : BATCH_FEE_BPS
  if (decoded.feeBps !== laneFeeBps) {
    findings.push({
      law: 'fee-bounds',
      level: 'violation',
      sentence: `this generation-${decoded.generation} batch charges a ${decoded.feeBps} bps fee where the lane's ruled rate is ${laneFeeBps} bps — the contract's ceiling (${PORTFOLIO_MAX_FEE_BPS} bps) cannot enforce policy, so the calldata's number is the only one that matters`,
      expected: String(laneFeeBps),
      observed: String(decoded.feeBps),
    })
  }

  // 2 · native-value — batchBuy is nonpayable, ERC-20 funding only
  // (portfolio-batcher.ts:28-29, :338-339).
  if (value !== 0n) {
    findings.push({
      law: 'native-value',
      level: 'violation',
      sentence: `batchBuy is nonpayable — funding is ERC-20 only — but this call carries ${value.toString()} wei of native value`,
      expected: '0',
      observed: value.toString(),
    })
  }

  // 3 · floor-present — per leg (swap-quote.ts:254, :261-263;
  // displayed-vs-signed.ts:46-48 for the one-wei form).
  if (consent.allowNoFloor !== true) {
    decoded.legs.forEach((leg, i) => {
      if (leg.minBuyAmount <= 1n) {
        findings.push({
          law: 'floor-present',
          level: 'violation',
          sentence: `leg ${i} (buying ${leg.buyToken}) carries a minBuyAmount of ${leg.minBuyAmount.toString()} wei — a zero/one-wei floor is a gutted floor, not a small one, and no floorless consent was given for this call`,
          expected: '> 1',
          observed: leg.minBuyAmount.toString(),
        })
      }
    })
  }

  // 4 · burn-route-present — the 100%-burn generation only
  // (portfolio-batcher.ts:963-969, :1013-1018).
  if (decoded.generation === 2 && emptyBytes(decoded.burnSwapData) && consent.allowDivert !== true) {
    findings.push({
      law: 'burn-route-present',
      level: 'violation',
      sentence: `this generation-2 batch carries an empty burnSwapData — on the 100%-burn generation that diverts the WHOLE fee to the fallback sink instead of burning it, and no divert consent was given for this call`,
      expected: 'a non-empty burn route',
      observed: '0x',
    })
  }

  // 5 · deadline-sane (portfolio-batcher.ts:32-33, :69).
  const deadlineIssue = deadlineFinding(
    decoded.deadline,
    input.expected.nowSeconds,
    input.expected.maxHorizonSeconds ?? PORTFOLIO_MAX_DEADLINE_WINDOW_SEC,
  )
  if (deadlineIssue != null) findings.push(deadlineIssue)

  // 6 · recipient-match — recipient is the signer, product law
  // (portfolio-batcher.ts:35-38, :311-313).
  if (!sameAddress(decoded.recipient, input.expected.recipient)) {
    findings.push({
      law: 'recipient-match',
      level: 'violation',
      sentence: `this batch delivers to ${decoded.recipient} where the declared recipient is ${input.expected.recipient} — the recipient is the signer by product law, and a redirected recipient is the theft this lint exists to catch`,
      expected: input.expected.recipient,
      observed: decoded.recipient,
    })
  }
  // …and the gen-1 fee sink, when the caller declared one (the destination the
  // contract validates only against zero, allocation.ts:63-69).
  if (
    input.expected.feeRecipient != null &&
    decoded.feeRecipient != null &&
    !sameAddress(decoded.feeRecipient, input.expected.feeRecipient)
  ) {
    findings.push({
      law: 'recipient-match',
      level: 'violation',
      sentence: `this batch's fee sink is ${decoded.feeRecipient} where the declared sink is ${input.expected.feeRecipient} — the contract checks the destination only against zero, so the declared sink is the only law`,
      expected: input.expected.feeRecipient,
      observed: decoded.feeRecipient,
    })
  }

  return findings
}

interface DecodedSwapWithFee {
  generation: 1 | 2
  sellToken: Address
  sellAmount: bigint
  minBuyAmount: bigint
  feeBps: number
  /** null on gen-2 — the arg no longer exists (100% burn). */
  feeRecipient: Address | null
  deadline: bigint
}

function decodeSwapWithFee(data: Hex): DecodedSwapWithFee | null {
  const gen2 = decodeOrNull(directSwapWrapperAbiGen2, data)
  if (gen2 != null) {
    const [sellToken, sellAmount, , minBuyAmount, , feeBps, deadline] = gen2.args
    return { generation: 2, sellToken, sellAmount, minBuyAmount, feeBps, feeRecipient: null, deadline }
  }
  const gen1 = decodeOrNull(directSwapWrapperAbi, data)
  if (gen1 != null) {
    const [sellToken, sellAmount, , minBuyAmount, , feeBps, feeRecipient, deadline] = gen1.args
    return { generation: 1, sellToken, sellAmount, minBuyAmount, feeBps, feeRecipient, deadline }
  }
  return null
}

/**
 * Re-check composed swapWithFee bytes against the money laws. Clean = [].
 * There is no burn-route law on this lane (the burn sink is immutable in the
 * contract itself, direct-swap-wrapper.ts:10-12 — nothing in calldata routes
 * it) and no recipient param (everything lands in msg.sender, :24-25).
 */
export function lintWrapperCalldata(input: WrapperLintInput): LintFinding[] {
  const decoded = decodeSwapWithFee(input.data)
  if (decoded == null) {
    return [
      {
        law: 'unrecognized',
        level: 'unrecognized',
        sentence: `this calldata does not decode as swapWithFee on either generation's ABI — an unreadable call is never clean, and must not reach a wallet prompt`,
      },
    ]
  }
  const findings: LintFinding[] = []
  const consent = input.consent ?? {}
  const value = input.value ?? 0n

  // 1 · fee-bounds — WRAPPER_FEE_BPS on every generation, deliberately NOT the
  // batcher's rate (direct-swap-wrapper.ts:61-68).
  if (decoded.feeBps !== WRAPPER_FEE_BPS) {
    findings.push({
      law: 'fee-bounds',
      level: 'violation',
      sentence: `this swap charges a ${decoded.feeBps} bps fee where the wrapper's product rate is ${WRAPPER_FEE_BPS} bps on every generation — the batcher's rate does not apply on this lane`,
      expected: String(WRAPPER_FEE_BPS),
      observed: String(decoded.feeBps),
    })
  }

  // 2 · native-value — exactness judged with the CALLDATA'S OWN feeBps because
  // that is the contract's own equation (it computes the fee from what it was
  // handed, direct-swap-wrapper.ts:18-20, :87-91); a wrong rate is law 1's
  // finding, and the two fire independently.
  const native = sameAddress(decoded.sellToken, zeroAddress)
  if (native) {
    const lawfulValue = decoded.sellAmount + wrapperFeeRaw(decoded.sellAmount, decoded.feeBps)
    if (value !== lawfulValue) {
      findings.push({
        law: 'native-value',
        level: 'violation',
        sentence: `a native sell must carry sellAmount + fee EXACTLY — ${decoded.sellAmount.toString()} + ${wrapperFeeRaw(decoded.sellAmount, decoded.feeBps).toString()} = ${lawfulValue.toString()} wei — but this call carries ${value.toString()} wei; the contract reverts WrongNativeValue on any other number`,
        expected: lawfulValue.toString(),
        observed: value.toString(),
      })
    }
  } else if (value !== 0n) {
    findings.push({
      law: 'native-value',
      level: 'violation',
      sentence: `an ERC-20 sell carries no native value, but this call sends ${value.toString()} wei along with the token pull — there is nowhere lawful for it to land`,
      expected: '0',
      observed: value.toString(),
    })
  }

  // 3 · floor-present — the measured-delta floor is the only protection on
  // this lane (direct-swap-wrapper.ts:24; swap-quote.ts:261-263).
  if (decoded.minBuyAmount <= 1n && consent.allowNoFloor !== true) {
    findings.push({
      law: 'floor-present',
      level: 'violation',
      sentence: `this swap's minBuyAmount is ${decoded.minBuyAmount.toString()} wei — the measured-delta floor is the only protection on this lane, a zero/one-wei floor guts it, and no floorless consent was given`,
      expected: '> 1',
      observed: decoded.minBuyAmount.toString(),
    })
  }

  // 5 · deadline-sane (direct-swap-wrapper.ts:26, :78 — inclusive cap).
  const deadlineIssue = deadlineFinding(
    decoded.deadline,
    input.expected.nowSeconds,
    input.expected.maxHorizonSeconds ?? WRAPPER_MAX_DEADLINE_SEC,
  )
  if (deadlineIssue != null) findings.push(deadlineIssue)

  // 6 · recipient-match — no recipient param exists on this lane; the gen-1
  // integrator sink is pinned when declared (allocation.ts:63-69's destination
  // law, worn by the wrapper's gen-1 tuple).
  if (
    input.expected.feeRecipient != null &&
    decoded.feeRecipient != null &&
    !sameAddress(decoded.feeRecipient, input.expected.feeRecipient)
  ) {
    findings.push({
      law: 'recipient-match',
      level: 'violation',
      sentence: `this swap's integrator sink is ${decoded.feeRecipient} where the declared sink is ${input.expected.feeRecipient} — fee/8 lands there on generation 1, so a repointed sink is skimmed money`,
      expected: input.expected.feeRecipient,
      observed: decoded.feeRecipient,
    })
  }

  return findings
}
