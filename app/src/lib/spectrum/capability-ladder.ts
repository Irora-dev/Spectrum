import type { Address } from 'viem'
import { showSymbol } from './safe-copy'

// E5'S LIFETIME HALF LIVES IN submission-store.ts (battle-test half-2 finding
// 1): this reducer is airtight within one instance, but a React instance is
// not a lifetime — the store persists every unresolved submission and
// `hydrateSubmission` is the runner's mandatory first move, so a remounted
// machine starts at `submitted` (resolve-first), never at a blank `idle`.

// ─────────────────────────────────────────────────────────────────────────────
// THE EXECUTION CAPABILITY LADDER — readiness §5b, the pure core (the owner ~21:3x
// "a system that tries all these levers but can fall back", built ~21:4x).
//
// Given one chain's signature-needs and the wallet's detected capabilities,
// resolve the best rung per item and the HONEST confirm count — the number the
// run panel states before anything runs. Detection and submission live in the
// runner (wagmi's stable 5792 hooks); this module is arithmetic + law, pinned.
//
// THE ONE SAFETY LAW (§5b): NEVER FALL BACK AFTER AN AMBIGUOUS SUBMIT. The
// submissionReducer below makes the forbidden transition UNREPRESENTABLE —
// from `submitted` the only exits are resolution; `fallback` is only legal
// from `attempting` on definitive non-support. A fallback fired after an
// ambiguous submission is a double-buy.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainSignatureNeeds {
  chainId: number
  /** Exact-amount sell approvals a rebalance needs (from recorded sellRaw). */
  sellApprovals: { token: Address; symbol: string; amountRaw: bigint }[]
  /** The ERC-20 funding approval; null = native funding (no approval exists).
   *  ⚠ ITS AMOUNT MUST COVER THE SIDE SWAPS TOO. Every side swap SELLS this
   *  same funding asset, which is exactly why they need no approval of their
   *  own — but it also means an allowance sized to the batch alone starves
   *  them. The caller sizes this; the ladder only counts confirmations. */
  fundingApproval: { token: Address; symbol: string; amountRaw: bigint } | null
  /** Narrow-C legs: assets 0x could not route, bought in their OWN transaction
   *  outside the batch (the owner's ruling, PLAN.md §8). Absent = none, and the
   *  resolution is then byte-identical to before this field existed. */
  sideSwaps?: { token: Address; symbol: string }[]
  /** True when EVERY asset fell out of the batch to a side swap, so there is
   *  no batch transaction to confirm. A real state on a thin chain, and it must
   *  not be counted as a phantom confirmation. Absent = there is a batch, which
   *  is every pre-narrow-C caller's truth. */
  batchIsEmpty?: boolean
}

export interface LadderCaps {
  /** EIP-5792 atomic batching on THIS chain (wallet_getCapabilities). */
  atomicBatch: boolean
  /** Permit2 rung armed on this chain: the batcher accepts permitTransferFrom
   *  AND Permit2 is deployed here. CONTRACTS-GATED — false until their side
   *  lands; the ladder degrades honestly meanwhile. */
  permit2: boolean
  /** Tokens already holding the one-time approval to Permit2. */
  permit2Approved: ReadonlySet<string>
  /** The funding token is on the KNOWN-GOOD 2612 list (never probed). */
  funding2612: boolean
}

// ⚠ EVERY LABEL BELOW IS TEXT A USER READS IMMEDIATELY BEFORE SIGNING, and its
// symbols are deployer-controlled. Found by extending this module for side
// swaps (2026-08-06): a 300-char symbol produced a 328-char wallet-prompt
// label, and it was already true of the sell/funding labels — so `showSymbol`
// is not decoration on any of them, it is what keeps a confirmation list from
// being restructured by a token's name.
export type ConfirmKind = 'bundle' | 'tx' | 'signature'

export interface ConfirmUnit {
  kind: ConfirmKind
  /** What the wallet prompt will say it is — review-grade words. */
  label: string
  /** Which rung produced it (for the panel's honesty line + telemetry). */
  rung: 'atomic' | 'permit2' | '2612' | 'plain'
}

export interface ResolvedChainExecution {
  chainId: number
  confirms: ConfirmUnit[]
  /** Wallet interactions total (bundles + txs + signatures). */
  confirmCount: number
  /** On-chain transactions among them (gas-bearing). */
  txCount: number
  /** ⚠ THE HONEST WORST CASE (independent review, 2026-08-07): the atomic rung
   *  states 1, but the runner's DESIGNED fallback legally moves
   *  attempting → unsupported-definitive → next rung on a method-not-found —
   *  reachable after getCapabilities said yes, because capabilities flap. The
   *  reviewer measured stated-1/faced-7, and this struct carried no figure the
   *  surface could show. This is what the user faces if the designed fallback
   *  fires: equal to `confirmCount` when there is no higher rung to fall to. */
  worstCaseConfirms: number
}

/** Resolve one chain's needs down the ladder. Pure; the runner supplies caps. */
export function resolveLadder(needs: ChainSignatureNeeds, caps: LadderCaps): ResolvedChainExecution {
  const confirms: ConfirmUnit[] = []
  const sells = needs.sellApprovals
  const funding = needs.fundingApproval
  const sideSwaps = needs.sideSwaps ?? []

  if (caps.atomicBatch) {
    // Rung 1: everything — approvals (incl. any one-time Permit2 grants some
    // future run would want) + the batch + EVERY SIDE SWAP — as ONE atomic
    // bundle. This is the answer to "can we batch approvals": on a wallet that
    // speaks 5792, narrow-C costs no extra confirmations at all, however many
    // assets fell out of the aggregator's coverage.
    const parts = [
      ...sells.map((s) => `approve $${showSymbol(s.symbol)}`),
      ...(funding ? [`approve $${showSymbol(funding.symbol)}`] : []),
      ...(needs.batchIsEmpty ? [] : ['batch']),
      ...sideSwaps.map((s) => `buy $${showSymbol(s.symbol)}`),
    ]
    confirms.push({ kind: 'bundle', label: `${parts.length} action${parts.length === 1 ? '' : 's'}, one confirmation`, rung: 'atomic' })
    // the worst case is THIS SAME resolution one rung down — computed by the
    // same function so the two can never drift (a hand-summed copy of the
    // rung-2 arithmetic here would be the restate-don't-derive trap)
    const fallback = resolveLadder(needs, { ...caps, atomicBatch: false })
    return { chainId: needs.chainId, confirms, confirmCount: 1, txCount: 1, worstCaseConfirms: fallback.confirmCount }
  }

  // Rung 2: Permit2 batch signature for the sells (contracts-gated). Tokens
  // missing the one-time grant fall to plain approves — stated, not hidden.
  let sellsCovered = false
  if (caps.permit2 && sells.length > 0) {
    const missing = sells.filter((s) => !caps.permit2Approved.has(s.token.toLowerCase()))
    for (const m of missing)
      confirms.push({ kind: 'tx', label: `one-time Permit2 approval for $${showSymbol(m.symbol)}`, rung: 'permit2' })
    confirms.push({
      kind: 'signature',
      label: `one signature covers selling ${sells.length} token${sells.length === 1 ? '' : 's'}`,
      rung: 'permit2',
    })
    sellsCovered = true
  }
  if (!sellsCovered) for (const s of sells) confirms.push({ kind: 'tx', label: `approve $${showSymbol(s.symbol)} (exact amount)`, rung: 'plain' })

  // Rung 3: the funding approval as a 2612 permit signature — known-good only.
  if (funding) {
    if (caps.funding2612) confirms.push({ kind: 'signature', label: `permit $${showSymbol(funding.symbol)} by signature`, rung: '2612' })
    else confirms.push({ kind: 'tx', label: `approve $${showSymbol(funding.symbol)} (exact amount)`, rung: 'plain' })
  }

  // The batch itself — one tx on this rung set, unless every asset left it.
  if (!needs.batchIsEmpty) confirms.push({ kind: 'tx', label: 'the batch transaction', rung: 'plain' })

  // Narrow-C legs, one transaction each on a wallet without atomic batching.
  // NO APPROVAL PER ASSET: they all sell the SAME funding asset, whose single
  // allowance is already counted above — so the honest cost of an unroutable
  // asset here is one transaction, not two, and never a second allowance.
  for (const s of sideSwaps)
    confirms.push({ kind: 'tx', label: `buy $${showSymbol(s.symbol)} in its own transaction`, rung: 'plain' })

  return {
    chainId: needs.chainId,
    confirms,
    confirmCount: confirms.length,
    txCount: confirms.filter((c) => c.kind !== 'signature').length,
    // no atomic rung above this resolution, so there is nothing to fall FROM:
    // what is stated is the worst case. (Permit2/2612 signature rungs falling
    // to plain approves are already stated as their own confirm rows, not
    // hidden behind a smaller number.)
    worstCaseConfirms: confirms.length,
  }
}

// ── The submission state machine (the safety law, unrepresentable-bad) ──────

export type SubmissionState =
  | { phase: 'idle'; rung: number }
  | { phase: 'attempting'; rung: number }
  /** `signer` (half-2 finding 6): the account that made this submission. A
   *  mid-run wallet switch must not let account B resolve-and-act-on a
   *  submission account A signed — the runner compares this to the active
   *  account and a mismatch is someone else's live money: report, never
   *  resume. Optional because a hydrated pre-store record may predate it. */
  | { phase: 'submitted'; rung: number; submissionId: string; signer?: Address }
  | { phase: 'succeeded'; rung: number }
  | { phase: 'failed'; rung: number; reason: string }

export type SubmissionEvent =
  | { type: 'attempt' }
  | { type: 'unsupported-definitive' } // method-not-found / capability "no" / pre-submit rejection
  | { type: 'submitted'; submissionId: string; signer?: Address }
  | { type: 'resolved-success' }
  | { type: 'resolved-failure'; reason: string }
  | { type: 'ambiguous-silence' } // an id exists but status is unknown — KEEP POLLING

export class ForbiddenFallback extends Error {}

/** The only legal moves. From `submitted` there is NO path to a lower rung —
 *  resolution first, always. `unsupported-definitive` only counts BEFORE a
 *  submission exists. Anything else throws so a bug cannot double-buy. */
export function submissionReducer(state: SubmissionState, ev: SubmissionEvent): SubmissionState {
  switch (ev.type) {
    case 'attempt':
      if (state.phase === 'idle') return { phase: 'attempting', rung: state.rung }
      throw new ForbiddenFallback(`attempt from ${state.phase}`)
    case 'unsupported-definitive':
      if (state.phase === 'attempting') return { phase: 'idle', rung: state.rung + 1 } // the NEXT rung may try
      throw new ForbiddenFallback(`fallback from ${state.phase} — after a submission exists, resolve; never fall back`)
    case 'submitted':
      if (state.phase === 'attempting') return { phase: 'submitted', rung: state.rung, submissionId: ev.submissionId, signer: ev.signer }
      throw new ForbiddenFallback(`submitted from ${state.phase}`)
    case 'ambiguous-silence':
      if (state.phase === 'submitted') return state // hold; the runner keeps polling callsStatus
      throw new ForbiddenFallback(`ambiguous-silence from ${state.phase}`)
    case 'resolved-success':
      if (state.phase === 'submitted') return { phase: 'succeeded', rung: state.rung }
      throw new ForbiddenFallback(`resolve from ${state.phase}`)
    case 'resolved-failure':
      // a RESOLVED failure is a real outcome, not ambiguity: the step failed
      // on this rung and the run's failure honesty takes over (no auto-retry
      // on a lower rung either — the money may have partially moved; the
      // runner surfaces it and the user decides)
      if (state.phase === 'submitted') return { phase: 'failed', rung: state.rung, reason: ev.reason }
      throw new ForbiddenFallback(`resolve from ${state.phase}`)
  }
}
