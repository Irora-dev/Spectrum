// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO HANDOFF — the declared bridge between the basket surfaces and the
// portfolio system's persistence.
//
// Two basket-side features genuinely reach across the product line, and both
// are features worth keeping: a token/basket page can seed "buy this
// composition as your own portfolio" (the cross-sell into the carve flow), and
// the creator studio resumes a standing draft. Before this file, those pages
// imported the portfolio's persistence internals directly (`allocation.ts`'s
// scope + draft store, `seed-from-holdings.ts`'s seeder) — product-boundary
// crossings into the attested money core's neighbors, invisible until the
// boundary ratchet froze them.
//
// This file is the bridge those features go through instead. Same rules as
// plan-shared-types.ts: thin, no new derivations, no state of its own — it
// wraps the portfolio-owned functions so the basket side depends on ONE
// declared seam rather than on the portfolio's internal layout. When the
// portfolio system moves to its own package, this file is the import the
// basket product keeps.
// ─────────────────────────────────────────────────────────────────────────────

import { GUEST_SCOPE, loadDraft, type AllocationDraft } from './allocation'
import { seedDraftFromComposition, type CompositionLeg } from './seed-from-holdings'

/** Seed the portfolio draft from a composition shown on a basket surface —
 *  the "make this your portfolio" cross-sell. `scopeAddress` is the connected
 *  wallet, or null/undefined when browsing signed-out (the guest scope). */
export function seedPortfolioDraftFrom(
  scopeAddress: string | null | undefined,
  legs: CompositionLeg[],
): { draft: AllocationDraft; seeded: boolean } | null {
  return seedDraftFromComposition(scopeAddress || GUEST_SCOPE, legs)
}

/** Read the standing portfolio draft for an address — the studio's resume
 *  point. Null when there is none (or no address). */
export function readPortfolioDraft(address: string | null | undefined): AllocationDraft | null {
  return address ? loadDraft(address) : null
}

// ── The holdings reads (added with the graduation bridge, 2026-08-19): the
// basket side prefills pay tokens and shows wallet context from the
// portfolio's own-wallet holdings model. Same deal as above — one declared
// door, re-exported unchanged, so the basket product never depends on the
// holdings model's internal layout. ──────────────────────────────────────────
export { deriveFoundBook } from './found-book'
export { useRawHoldings } from './use-raw-holdings'
export type { RawHolding } from './raw-holdings'
