// ─────────────────────────────────────────────────────────────────────────────
// PLAN-SHARED TYPES — the declared seam between the two products' planners.
//
// The portfolio system (the runner, funding plans, floors) and the basket
// product (theses, mint funding) genuinely share a handful of PLANNING SHAPES:
// what a chain needs, what a chain holds, the one error class unreadable money
// inputs throw, and the demo-leg sentinel test. Before this file, each side
// imported those names straight out of the other side's module — the basket
// thesis code reached into `funding-plan.ts` (portfolio money-core) for a type
// and an error class, and the portfolio compose path reached into
// `thesis-run-types.ts` (basket-shaped) for a type and a predicate. Those
// imports were product-boundary crossings for names that belong to NEITHER
// side: they belong to the seam.
//
// This file IS that seam, and since 2026-08-19 it DEFINES the names (the
// planned two-step completed: importers were repointed first under the review
// freeze; after the v2026.08.18 cut the definitions moved in and the old
// homes re-export back, so nobody's imports changed twice).
//
// Rules for this file: types, one error class, one pure predicate — never
// logic, never state, never a new derivation of any money number (the one-
// derivation rule in docs/MONEY-LAWS.md). If a name here grows behavior, it
// has picked a side and must move out.
// ─────────────────────────────────────────────────────────────────────────────

// ── The definitions themselves (moved here 2026-08-19, the deferred second
// step — importers were repointed first, under the review freeze; now the
// old homes re-export back so THEIR remaining callers are unchanged). ────────

/** What one chain must pay for: its buys plus its share of the fee (F9). */
export interface ChainNeed {
  chainId: number
  buysCents: number
  feeCents: number
}

/** OUR code is wrong, not the user's money — see funding-plan's
 *  two-kinds-of-failure note (the thrown half of the honest-answer law). */
export class FundingPlanContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FundingPlanContractError'
  }
}

/** One chain's spendable state, read fresh at plan time. Money in integer
 *  cents, gas in native wei — the funding-plan law: two unit axes, never mixed. */
export interface PerChainFunds {
  chainId: number
  /** Settlement-token balance, raw (6dp USDC-family). */
  usdcRaw: bigint
  /** The same, floored to integer cents for plan math. */
  usdcCents: number
  /** Native balance, wei. */
  nativeRaw: bigint
  /** Estimated wei this chain's steps will need. null = COULD NOT READ — the
   *  law from funding-plan: unreadable gas refuses the chain by name, never
   *  guesses. */
  gasNeedRaw: bigint | null
}

/** Synthetic demo-leg address mark. The regex is the single source; the demo
 *  fixture must MINT matching addresses (the paired guard in
 *  thesis-run-types.test.ts asserts mint and test agree, so a drift fails red
 *  instead of shipping a run that arms against a synthetic address). */
export const THESIS_DEMO_ADDR_RE = /de50([0-9a-f]{4})$/i

export function isDemoLegAddress(address: string): boolean {
  return THESIS_DEMO_ADDR_RE.test(address)
}
