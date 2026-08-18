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
// This file IS that seam. Today it re-exports from the modules that still
// define the names — a deliberate two-step, because the definers are inside
// the attested money core and a review freeze is standing: (1) NOW, every
// cross-product importer points here and the boundary ratchet
// (import-boundary.guard.test.ts) ratchets those edges away; (2) AFTER the
// standing release cut, the definitions move here and the old modules
// re-export back (or drop the names), without any importer changing again.
//
// Rules for this file: types, one error class, one pure predicate — never
// logic, never state, never a new derivation of any money number (the one-
// derivation rule in docs/MONEY-LAWS.md). If a name here grows behavior, it
// has picked a side and must move out.
// ─────────────────────────────────────────────────────────────────────────────

export { FundingPlanContractError, type ChainNeed } from './funding-plan'
export { isDemoLegAddress, type PerChainFunds } from './thesis-run-types'
