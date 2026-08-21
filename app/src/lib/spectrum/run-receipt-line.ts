import { toFunctionSelector } from 'viem'
import { batchFeeBpsFor } from './allocation'
import { expectedBatchFee } from './batch-fee-verification'
import { decodeReceiptFacts, type ReceiptFacts } from './post-trade-reconciliation'
import type { ReceiptLogLike } from './batch-fee-verification'

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT LINE — a landed batch step's receipt, read the moment it lands,
// summarized in one honest sentence for the completion card.
//
// The incident this exists for (2026-08-18, twice in one day live): the chain
// disclosed a diverted burn share in the run's own receipt — BurnDiverted,
// reason bytes carrying the burn swap's exact revert — and nothing read it.
// The first divert was found a day later by hand; the second was found on a
// block explorer because the deployed FRONT END was a stale build. Both were
// answerable at t=0 from the receipt alone. This module is that answer: fee
// exactness re-checked from the event's own numbers (the measured-fee law),
// the burn outcome named (executed, or diverted WITH the reason's error
// name), and anything unreadable said out loud — absence never reads as
// cleanliness (docs/BUG-CLASSES.md class 5).
//
// Scope, honestly: this reads the batcher's own receipt. Leg floors are
// enforced on-chain and proven pre-send by displayed-vs-signed; conservation
// needs the pull, which the receipt alone cannot state — both deliberately
// out of scope here (the full reconciliation module carries them for callers
// that hold expectations). Pure except the injected receipt fetch.
// ─────────────────────────────────────────────────────────────────────────────

/** The burn-route revert selectors the batcher's divert `reason` can carry
 *  (SpectrumPortfolioBatcher's own error set; computed, never hardcoded, so a
 *  signature drift here is a compile-visible edit, not a silent mismatch). */
const DIVERT_REASONS: Record<string, string> = Object.fromEntries(
  [
    'MinBurnNotMet(uint256,uint256)',
    'BurnSwapFailed()',
    'BurnTwapUnavailable()',
    'BurnFloorIsZero()',
    'BurnAssetNotPriceable()',
    'BurnSendFailed()',
    'AggCallFailed()',
  ].map((sig) => [toFunctionSelector(`function ${sig.replace(/\(.*/, '')}${sig.slice(sig.indexOf('('))}`), sig.replace(/\(.*/, '')]),
)

export interface ReceiptLine {
  /** 'clean' = fee exact + burn executed · 'diverted' = fee exact, burn share
   *  parked at the sink (disclosed, recoverable) · 'attention' = something the
   *  laws did not expect · 'unread' = the receipt was not readable this pass. */
  tone: 'clean' | 'diverted' | 'attention' | 'unread'
  /** One sentence in the run card's own register. */
  sentence: string
}

/** Name a divert's reason bytes: the leading selector, or the raw prefix when
 *  the selector is not one the batcher's burn route can throw. */
export function divertReasonName(reason: `0x${string}`): string {
  if (!reason || reason === '0x') return 'no reason bytes (the route was empty or the quote never ran)'
  const sel = reason.slice(0, 10)
  return DIVERT_REASONS[sel] ?? `reason ${sel}`
}

/** Summarize one landed batch receipt against the money laws that the receipt
 *  alone can answer. `fundingDecimals` scales the dollar figures (settlement
 *  raw units); pass the chain's settlement decimals. */
export function receiptLineFor(args: {
  chainId: number
  status: 'success' | 'reverted'
  logs: readonly ReceiptLogLike[]
  batcher: string
  recipient: string
  fundingDecimals: number
}): ReceiptLine {
  let facts: ReceiptFacts
  try {
    facts = decodeReceiptFacts({ status: args.status, logs: args.logs, moneyContract: args.batcher, recipient: args.recipient })
  } catch {
    return { tone: 'unread', sentence: 'the receipt could not be decoded — saying so rather than guessing' }
  }
  if (args.status === 'reverted') return { tone: 'attention', sentence: 'the chain reverted this step — nothing moved' }

  const executed = facts.facts.find((f) => f.kind === 'batch-executed')
  const divert = facts.facts.find((f) => f.kind === 'burn-diverted')
  const money = (raw: bigint) => `$${(Number(raw) / 10 ** args.fundingDecimals).toFixed(2)}`

  if (!executed) {
    // a landed batch with no BatchExecuted on the batcher is not this
    // contract's success shape — say it, never assume it
    return { tone: 'attention', sentence: 'landed, but the batcher’s own completion event is missing from the receipt — worth a look' }
  }
  const want = expectedBatchFee(executed.fundingTotal, batchFeeBpsFor(args.chainId))
  const feeExact = executed.fee === want
  const feeWords = feeExact
    ? `fee charged exactly — ${money(executed.fee)}`
    : `fee ${money(executed.fee)} ≠ the law’s ${money(want)} — the measured-fee law disagrees`

  if (divert) {
    return {
      tone: feeExact ? 'diverted' : 'attention',
      sentence: `${feeWords} · the burn share (${money(divert.amount)}) DIVERTED to the fallback sink — ${divertReasonName(divert.reason)}; disclosed and recoverable, nothing else affected`,
    }
  }
  if (!feeExact) return { tone: 'attention', sentence: feeWords }
  return { tone: 'clean', sentence: `${feeWords} · burn executed · refunded ${money(executed.refunded)}` }
}
