import type { PoolVerdict } from './pool-safety'
import { showSymbol } from './safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// HOW AN ASSET GETS ACQUIRED — the tiering behind the owner's narrow-C ruling
// (2026-08-06, in-session; recorded in PLAN.md §8).
//
// THE RULING, in his words: use the narrow form of option C — a side swap
// outside the batch, permitted for assets that pass our own safety screen —
// "BUT if for some reason it doesn't pass the check we just tell users
// something like [Warning this is a new or experimental token that needs your
// approval to acquire it, ensure to check this is the correct token before
// swapping]".
//
// So a failed screen is NOT a dead end: it becomes an explicit, per-asset
// approval. This module decides which of those an asset gets, and never
// decides it from the asset's own claims about itself.
//
// ⚠ THE ONE LINE DRAWN INSIDE THE RULING, and why. `pool-safety.ts` says in its
// own header: "'The user told us to' is not a safety argument; it is how a
// phishing link becomes a signed transaction." That is right, and it is also
// not in conflict with the ruling — once you separate the two things a screen
// can fail on:
//
//   · UNCERTAINTY — we cannot tell which pool is right, or the token is too new
//     to say much about. The user CAN own that risk, because the warning states
//     the whole of what we know. ⇨ APPROVAL (the ruling's path).
//   · A MEASURED WRONG THING — there is no market at all, or the only pool pays
//     out in an asset we do not recognise. Approval cannot fix either: the
//     first buys a failed transaction, the second trades their money for
//     something nobody can price. Consent is meaningful about risk; it is not
//     meaningful about a mistake the user cannot see. ⇨ STILL REFUSED, in words
//     that say which.
//
// Every tier carries the SENTENCE it will be shown with, so the surface renders
// a decision rather than re-deriving one — the display never gets to disagree
// with the gate (a display that re-derives is how two truths appear).
// ─────────────────────────────────────────────────────────────────────────────

/** Can we establish that the user would be able to SELL this again? Buying
 *  something with no exit is the one harm that is invisible at purchase and
 *  total at exit, so 'unconfirmed' is a warning tier, never a silent pass.
 *
 *  ⚠⚠ NEVER DERIVED FROM THE AGGREGATOR — see `ZeroExVerdict` below and
 *  `sellPathFromNativeVenue`. This is the single most dangerous wiring
 *  mistake available in this module. */
export type SellPath = 'confirmed' | 'unconfirmed' | 'none'

/**
 * What the aggregator answered, and WHY — three states, not a boolean.
 *
 * ⚠⚠ IT WAS `zeroExRoutable: boolean`, AND THAT CONFLATED TWO OPPOSITE FACTS
 * (SpectrumContracts, 2026-08-07, measured live with the real key). 0x
 * categorically REFUSES every tokenized equity on 4663 — all eight of NVDA
 * AAPL TSLA MSFT GOOGL SPY QQQ SLV — with HTTP 422 and
 * `BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE` / `SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`:
 * "not authorized for trade due to legal restrictions". Control probes on
 * eight trending 4663 tokens quote fine on the same funding asset, so the
 * chain, the key and the funding asset all work — it is the ASSET CLASS. No
 * probe size, fee tier or volume changes it, because it is a compliance
 * deny-list rather than a depth reading.
 *
 * A boolean made that indistinguishable from "there is no market here", and
 * the two demand OPPOSITE handling: a depth refusal is evidence about the
 * asset, while a policy refusal is evidence about 0x — the asset may have
 * millions in native liquidity (starter-suggestions records NVDA at ~8.7M and
 * AAPL at ~5.3M in V4 USD-paired pools). the owner ruled on 2026-08-07 (via R)
 * that stocks are acquired as individual assets OUTSIDE the batcher, which is
 * exactly the side-swap path — so a policy refusal must arrive there
 * DELIBERATELY, with copy that is true, instead of arriving by accident
 * through a depth-shaped `false`.
 */
export type ZeroExVerdict =
  /** A usable route at this size: an ordinary leg of the atomic batch. */
  | 'routable'
  /** 0x has no route — a statement about the market. */
  | 'no-route'
  /** 0x DECLINES this asset (legal/compliance), while a market may well
   *  exist. A statement about 0x, and about nothing else. */
  | 'policy-refused'
  /** WE COULD NOT ASK — no key configured, the proxy refused or was
   *  unreachable, a rate limit, an unparseable answer. A statement about our
   *  own infrastructure, and about NOTHING else (A6 review, 2026-08-07): this
   *  used to arrive as `no-route`, so an operator's missing key told every
   *  user "0x has no route for this asset" about assets 0x routes fine. */
  | 'read-failed'

export interface AcquisitionInput {
  symbol: string
  /** What 0x answered, and why (zeroex-quote's `classifyZeroExOutcome`). */
  zeroEx: ZeroExVerdict
  /** Our own screen on the native route. Null = not assessed yet, which is
   *  treated as uncertainty, never as a pass. */
  poolVerdict: PoolVerdict | null
  /** ⚠ MUST come from the NATIVE venue, never from a 0x answer in either
   *  direction (`sellPathFromNativeVenue` is the only honest producer). */
  sellPath: SellPath
}

/**
 * The ONLY sanctioned way to establish a sell path — and it exists to make the
 * dangerous wiring hard rather than merely discouraged.
 *
 * ⚠⚠ THE TRAP IT CLOSES (SpectrumContracts, 2026-08-07): 0x's refusal is
 * BIDIRECTIONAL. A sell-side quote for NVDA answers
 * `SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`, so the obvious wiring — "ask 0x
 * whether it can sell this; if not, there is no exit" — maps every tokenized
 * equity to `sellPath: 'none'`, which fires this module's first and
 * deliberately un-overridable tier: "We could not find any way to sell $NVDA
 * again, so we will not buy it for you." That is a BLANKET REFUSAL OF THE
 * ENTIRE STOCK REGISTRY, and the exact opposite of what the owner ruled.
 *
 * The principle is the mirror of this module's own founding argument. It
 * already says aggregator COVERAGE cannot answer "can they get out"; the same
 * reasoning says aggregator REFUSAL cannot answer it either. An aggregator's
 * legal posture is not a property of the asset. Exits are established from the
 * venue the exit would actually use.
 *
 * `nativeSell` is our own measurement of the native route in the SELL
 * direction: true = we saw a way out, false = we looked and there is none,
 * null = not assessed (uncertainty, which warns rather than refuses).
 */
export function sellPathFromNativeVenue(nativeSell: boolean | null): SellPath {
  if (nativeSell === null) return 'unconfirmed'
  return nativeSell ? 'confirmed' : 'none'
}

export type AcquisitionRoute =
  /** 0x routes it: an ordinary leg of the atomic batch. */
  | { via: 'batch'; message: null }
  /** No 0x route, but our own screen says the native route is sound and the
   *  asset is sellable: a side swap outside the batch (narrow C). Costs its own
   *  signature and gas, which the surface states. */
  | { via: 'side-swap'; message: string }
  /** No 0x route and the screen did not clear it, but the failure is
   *  UNCERTAINTY: the ruling's explicit per-asset approval. */
  | { via: 'side-swap-on-approval'; message: string; approvalSubject: ApprovalSubject }
  /** Refused, because approval cannot fix what failed. */
  | { via: 'refused'; message: string }

/** What the approval is actually about — so the warning names the real thing
 *  rather than one generic line. A warning that says "new or experimental" when
 *  we measured something specific is a wrong sentence, and a wrong sentence on
 *  a money surface is worse than a blunt one. */
export type ApprovalSubject =
  /** No aggregator route and nothing else is wrong: genuinely just new/thin. */
  | 'unindexed'
  /** Several pools and none is decisively the right one. */
  | 'pool-unclear'
  /** We could not establish a sell path. Stated as its own subject because it
   *  is the risk a buyer least expects and can least reverse. */
  | 'exit-unconfirmed'
  /** We could not reach the aggregator at all, and have not screened the
   *  native pool either. Named separately from `unindexed` for the same reason
   *  that one exists: calling an asset "new or thinly traded" when we simply
   *  failed to look is a wrong sentence on a money surface. */
  | 'aggregator-unreachable'
  /** 0x DECLINES the asset class and we have not screened its native pool.
   *  ⚠ Its own subject because `unindexed` would say "new or thinly traded"
   *  about a blue-chip equity with an eight-figure pool (SpectrumContracts'
   *  item 3, 2026-08-07) — measurably untrue, and this module's header already
   *  says a wrong sentence on a money surface is worse than a blunt one. */
  | 'aggregator-declines'

/**
 * Decide how (or whether) an asset is acquired. Pure — every input is measured
 * elsewhere and passed in.
 *
 * ORDER MATTERS AND IS DELIBERATE — and the aggregator does NOT win first.
 * `zeroExRoutable` is BUY-SIDE evidence: we quote funding->asset, so it says a
 * route exists to get IN. It cannot answer "can they get out" (sellPath) or "is
 * this the right pool" (poolVerdict), so it must not override either. Order:
 * no-exit refusal > structural pool refusal > exit uncertainty > the aggregator
 * batch > pool uncertainty > the cleared side swap.
 * (This paragraph previously said the aggregator wins first, eight lines above
 * code that had been changed to say otherwise — a header contradicting its own
 * module is how the next reader inherits the bug.)
 */
export function acquisitionRoute(input: AcquisitionInput): AcquisitionRoute {
  const sym = showSymbol(input.symbol)

  // ⚠ NO EXIT OUTRANKS THE AGGREGATOR (found by independent review, 2026-08-07).
  // This check used to sit BELOW the zeroExRoutable short-circuit, so an asset
  // with no way out became an ordinary batch leg with no warning and no
  // approval — the exact silent pass this module's own header forbids. The
  // reason the short-circuit is wrong here: `zeroExRoutable` is BUY-SIDE
  // evidence only (we quote funding→asset), and a buy-only honeypot quotes
  // perfectly in that direction. Aggregator coverage cannot answer "can they
  // get out", so it must not override the answer.
  if (input.sellPath === 'none') {
    return {
      via: 'refused',
      message: `We could not find any way to sell $${sym} again, so we will not buy it for you. Buying something with no way out is not a risk you can check afterwards.`,
    }
  }

  const v = input.poolVerdict

  // ⚠ THE SAME REASONING, APPLIED TO ALL THREE CELLS (review, 2026-08-07). My
  // first pass moved only `sellPath === 'none'` above the short-circuit and left
  // two cells behind, so `unconfirmed` and a structural pool refusal STILL
  // became silent batch legs whenever 0x happened to quote them. The argument
  // does not distinguish between them: aggregator coverage is buy-side evidence,
  // and it cannot answer "can they get out" or "is this pool the right one".
  // A STRUCTURAL REFUSAL OUTRANKS EXIT UNCERTAINTY: refusing is stronger than
  // warning, and offering someone an approval for a thing we have already
  // decided cannot work is incoherent. (My first ordering had these swapped and
  // an existing test caught it — the test was right.)
  if (v?.kind === 'refuse') {
    return { via: 'refused', message: `$${sym}: ${v.message}` }
  }
  if (input.sellPath === 'unconfirmed') {
    return {
      via: 'side-swap-on-approval',
      approvalSubject: 'exit-unconfirmed',
      // ⚠ THIS OPENED WITH "We can buy $X" IN TWELVE CELLS, INCLUDING ONES
      // WHERE NOTHING ESTABLISHED THAT (A6 review, 2026-08-07). This tier
      // outranks the aggregator branch, so it also fires when 0x has
      // explicitly DECLINED the asset and when we never managed to ask — and
      // it stated the opposite of both. The exit is the point of the sentence;
      // the buy-side claim was never load-bearing and is gone.
      message: `We could not confirm you would be able to sell $${sym} again. Check this is the token you mean before approving it.`,
    }
  }

  // The aggregator batch, once nothing above has objected. Everything that
  // outranks it — no exit, an unconfirmed exit, a structural pool refusal — has
  // already returned, and TypeScript proves it: the duplicate checks that used
  // to sit BELOW this line are now unreachable and were deleted rather than
  // left as reassuring dead code.
  if (input.zeroEx === 'routable') return { via: 'batch', message: null }

  // ── the approval tier: real uncertainty, owned by the user ────────────────
  if (v == null || v.kind === 'ask') {
    // ⚠ A POLICY REFUSAL IS NOT THINNESS (SpectrumContracts' item 3). With no
    // pool screen, `unindexed` would call a blue-chip equity "new or thinly
    // traded" — measurably untrue when its V4 pool holds eight figures. The
    // honest sentence names what actually happened: our aggregator will not
    // handle this KIND of asset, and we have not checked its own market yet.
    if (input.zeroEx === 'policy-refused' && v == null) {
      return {
        via: 'side-swap-on-approval',
        approvalSubject: 'aggregator-declines',
        message: `$${sym} cannot be bought through the exchange we route through, so it is bought in its own transaction and needs your approval. We have not checked its market yet, so check this is the token you mean.`,
      }
    }
    // ⚠ WE FAILED TO LOOK — say that, and nothing about the asset.
    if (input.zeroEx === 'read-failed' && v == null) {
      return {
        via: 'side-swap-on-approval',
        approvalSubject: 'aggregator-unreachable',
        message: `We could not check how to buy $${sym} just now, so it would be bought in its own transaction and needs your approval. This is about our connection, not about the token.`,
      }
    }
    return {
      via: 'side-swap-on-approval',
      approvalSubject: v == null ? 'unindexed' : 'pool-unclear',
      message:
        v == null
          ? `$${sym} is new or thinly traded, so it needs your approval to buy. Check this is the correct token before approving it.`
          : `$${sym} has more than one market and none is clearly the main one, so it needs your approval to buy. Check this is the correct token before approving it.`,
    }
  }

  // ── cleared by our own screen: the narrow-C path ──────────────────────────
  // A policy refusal lands here too, and that is the owner's 2026-08-07 ruling
  // working as intended: stocks are acquired as individual assets outside the
  // batcher. The sentence says WHY it is separate rather than implying the
  // asset is marginal — the pool cleared our screen and the exit is confirmed.
  if (input.zeroEx === 'policy-refused') {
    return {
      via: 'side-swap',
      message: `$${sym} cannot be bought through the exchange we route through, so it is bought in its own transaction. That needs a second signature and its own network fee.`,
    }
  }
  if (input.zeroEx === 'read-failed') {
    // the pool screen cleared it and the exit is confirmed, so buying it
    // individually is honest — we just cannot say the aggregator had no route
    return {
      via: 'side-swap',
      message: `We could not check the exchange we usually route through, so $${sym} is bought in its own transaction. That needs a second signature and its own network fee.`,
    }
  }
  return {
    via: 'side-swap',
    message: `$${sym} is bought in its own transaction, so it needs a second signature and its own network fee.`,
  }
}

/** Does this plan need the extra-signature explanation at all? The surface
 *  should say "some of these are bought separately" ONCE, not per row. */
export function needsSideSwaps(routes: readonly AcquisitionRoute[]): boolean {
  return routes.some((r) => r.via === 'side-swap' || r.via === 'side-swap-on-approval')
}

/** The approvals a plan is waiting on. Nothing executes while this is
 *  non-empty and unapproved — the caller's gate, stated here so both the
 *  surface and the runner read the same list. */
export function pendingApprovals(routes: readonly AcquisitionRoute[]): AcquisitionRoute[] {
  return routes.filter((r) => r.via === 'side-swap-on-approval')
}
