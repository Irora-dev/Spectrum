import type { Address } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// THE THESIS RUN — shared contract for the one-flow cross-chain thesis buy/sell
// (the owner 2026-08-09: direct route greenlit — "yes direct route" · "wire smart
// gas routing for the user from day 1" · "yes selling from v1 too").
//
// THE ROUTE, measured before built (workspace/spectrum-release/
// thesis-buy-feasibility-2026-08-09.md in the ops repo): a thesis leg is ONE basket
// per chain, so the live `swapExactIn` path IS the per-chain step and the
// batcher is not involved. Bridges ride BridgeFund's proven LI.FI executor.
// The batch fee is a batcher-contract field, so the direct route charges NO
// batching fee — funding needs are buysCents only (thesisNeeds at feeBps 0).
//
// This file is TYPES + pure helpers only — no React, no chain, no imports
// beyond viem's Address. Five modules implement against it in parallel:
//   thesis-funding.ts   — per-chain inventory + shortfalls (PerChainFunds → LegFunding)
//   use-bridge-leg.ts   — the extracted LI.FI bridge executor (+ order/integrator)
//   thesis-sell.ts      — the sell plan (ThesisSellPlan)
//   thesis-run.ts       — the sequencer state machine + persistence (ThesisRun)
//   components/thesis/* — the run overlay (consumes all of the above)
// Change this file only with every consumer in view; it is the seam.
// ─────────────────────────────────────────────────────────────────────────────

export type ThesisRunDirection = 'buy' | 'sell'

// PerChainFunds lives in plan-shared-types.ts (the seam both planners share);
// re-exported so this module's callers are unchanged.
export { isDemoLegAddress, THESIS_DEMO_ADDR_RE, type PerChainFunds } from './plan-shared-types'

/** What one leg needs, after netting the wallet's own funds on its chain. */
export interface LegFunding {
  chainId: number
  /** The leg's share of the buy (direct route: no batch fee). */
  needCents: number
  /** Spendable settlement cents already on this chain. */
  haveCents: number
  /** max(0, need - have). Zero ⇒ no bridge step for this leg. */
  shortfallCents: number
  /** The bridge that covers the shortfall, or null when none is needed.
   *  refuelWeiNeeded > 0n ⇒ the quote must carry fromAmountForGas so the
   *  user lands with gas (the owner: smart gas routing from day 1). null = the
   *  need could not be read (state it, do not guess). */
  bridge: null | {
    fromChainId: number
    amountCents: number
    refuelWeiNeeded: bigint | null
  }
  /** PAY-ASSET route (the owner 2026-08-13, ruling his own 2026-08-11 question:
   *  "you should probably be able to select the asset you want to swap out of
   *  here"): the shortfall is covered by SELLING a chosen wallet asset into
   *  this leg's settlement token through the SAME LI.FI executor bridges ride
   *  (use-bridge-leg's quoteAndSendToken — never a second quote path).
   *  fromChainId MAY equal the leg's own chain (a same-chain sell). The quoted
   *  figures are PLAN-TIME truth, ≈-marked on screen; the executor re-quotes
   *  fresh at signing (the house law). Absent/null on settlement-funded rows —
   *  the default path composes byte-identically to before this field existed.
   *  A row never carries BOTH bridge and convert. */
  convert?: null | {
    fromChainId: number
    token: { address: Address; symbol: string; decimals: number }
    /** Pay-asset raw units this conversion sells — sized so the quote's OWN
     *  toAmountMin covers the shortfall (over-delivery stays in the wallet as
     *  settlement; under-funding a buy is the direction never allowed). */
    fromAmountRaw: bigint
    /** Plan-time quote's estimated delivery, settlement raw (display). */
    quotedToRaw: bigint
    /** Plan-time quote's guaranteed floor, settlement raw. */
    quotedToMinRaw: bigint
  }
  /** False when this chain cannot pay for its own steps and no refuel can
   *  reach it — the leg REFUSES rather than stranding money (funding-plan M8). */
  gasOk: boolean
  /** Human sentence when the leg cannot run (unreadable balances, no route,
   *  no gas). A leg with a note is shown, never silently dropped. */
  note: string | null
  /** THE STRUCTURED REFUSAL (owner's queue: the root fix for the prose-keyed-
   *  matcher class): the note's machine-readable identity. Doors key on THIS
   *  first and fall back to the sentence only for runs persisted before codes
   *  existed — so editing copy can never again silently unplug a door.
   *  'needs-funds' = the pay-asset door's case; shortCents carries the gap. */
  noteCode?: 'needs-funds' | 'gas-unsized' | 'gas-short'
  noteShortCents?: number
}

/** A single leg sell: the whole held amount or a uniform fraction of it. */
export interface SellStep {
  chainId: number
  address: Address
  /** Basket-token amount to sell, raw (18dp). */
  sellRaw: bigint
  /** What the leg is expected to realise, cents — display only, floors are
   *  the live sell path's job at execution time. */
  estCents: number | null
}

export interface ThesisSellPlan {
  steps: SellStep[]
  /** Optional post-sell consolidation: bridge each chain's proceeds home.
   *  null = proceeds stay where they land (the default; bridging costs money
   *  and the user is told where everything landed either way). */
  consolidate: null | { toChainId: number }
}

export type ThesisStepKind =
  | 'switch' // offer the wallet the leg's chain (never taken silently)
  | 'bridge' // send the LI.FI bridge covering a leg's shortfall
  | 'convert' // sell the chosen pay asset into a leg's settlement (LegFunding.convert)
  | 'await-bridge' // poll arrival (bridge-pending machinery)
  | 'buy' // the leg's swapExactIn via the live buy path
  | 'sell' // the leg's protected redeem via the live sell path
  | 'consolidate' // post-sell bridge of proceeds to the home chain

export type ThesisStepState =
  | 'queued'
  | 'active' // offered to the user (switch) or ready to sign
  | 'signing'
  | 'confirming'
  | 'awaiting' // bridge in flight; survives reload via bridge-pending
  | 'done'
  | 'failed' // shown with its note; retryable
  | 'skipped' // leg refused at plan time (note carries why)

export interface ThesisRunStep {
  /** Stable id: `${kind}:${chainId}` plus a discriminator where two of a kind
   *  can share a chain. Never index-derived — steps are looked up by id after
   *  a reload. */
  id: string
  kind: ThesisStepKind
  chainId: number
  legAddress?: Address
  /** Money this step moves, cents (buy/bridge; a convert carries the
   *  settlement cents it covers). Sells carry raw in sellRaw. */
  amountCents?: number
  sellRaw?: bigint
  bridgeFromChainId?: number
  /** The bridge tx hash once sent — the join key into bridge-pending. */
  bridgeTxHash?: string | null
  /** Convert steps only: the pay asset being sold (LIFI_NATIVE address for the
   *  chain's native coin) and how much of it, raw. Persisted so a resumed run
   *  can re-quote the SAME sale fresh — never a remembered rate. */
  payTokenAddress?: Address
  paySymbol?: string
  payDecimals?: number
  payAmountRaw?: bigint
  state: ThesisStepState
  /** Honest sentence for failed/skipped/awaiting states. */
  note?: string | null
  /** The structured refusal riding the step (see LegFunding.noteCode). */
  noteCode?: 'needs-funds' | 'gas-unsized' | 'gas-short'
  noteShortCents?: number
}

export interface ThesisRun {
  v: 1
  /** thesisRef(name) — with deployer+direction+signer, the persistence key. */
  ref: string
  deployer: string
  direction: ThesisRunDirection
  signer: Address
  /** Buy: the total the user typed, cents. Sell: 0 (amounts live per step). */
  amountCents: number
  steps: ThesisRunStep[]
  startedAt: number
  /** True ⇒ WALKTHROUGH ONLY: synthetic legs, nothing arms, every "signature"
   *  is a tick on a timer and the overlay says so on its face. */
  demo: boolean
}

// THESIS_DEMO_ADDR_RE + isDemoLegAddress moved to plan-shared-types.ts (the
// portfolio compose path arms against the same mark); the paired mint/test
// guard in thesis-run-types.test.ts still stands on the re-export above.

/** The persistence key for a run. Signer-scoped so one wallet's resume can
 *  never offer another wallet's half-finished money movement. */
export function thesisRunKey(signer: string, ref: string, direction: ThesisRunDirection): string {
  return `spectrum.thesis-run.v1:${signer.toLowerCase()}:${direction}:${ref}`
}
