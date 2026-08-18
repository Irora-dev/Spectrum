// ─────────────────────────────────────────────────────────────────────────────
// KIT POLICY DEFAULTS — the upstream-owned layer under every operator's brand.
//
// WHY THIS FILE EXISTS (2026-08-17, the fork-conflict ruling): kit policy used
// to live inside app/src/brand.config.ts — the file the create wizard REWRITES
// on every fork. Every policy change upstream shipped was therefore a merge
// conflict waiting in every fork's update. Policy now lives HERE (a file no
// operator edits and no wizard writes), the operator file carries only the
// operator's own choices, and release/check-operator-owned.mjs refuses any
// future upstream commit that touches the operator files at all.
//
// Precedence: the operator's explicit value always wins; these fill the gaps.
// ─────────────────────────────────────────────────────────────────────────────
import type { PageKey, PageToggles } from './brand'

/** Pages the KIT ships dark until their systems are ready — the operator turns
 *  them on (or off) in their own brand.config; absence there falls through to
 *  this layer, then to default-ON.
 *
 *  `bundle` OFF as of 2026-08-01 (the owner): gates only the OLD hand-picked
 *  allocations surfaces (BundleGrid, BundleShelf, FeaturedBundle, the forge
 *  doors) — the published cross-chain Bundle system that later shipped is not
 *  page-gated at all (scope narrowed 2026-08-11).
 *
 *  `create` retired FROM this layer 2026-08-16: its dark default was written
 *  for the simulated era and carried its own retirement clause ("flip it the
 *  release after the first real run"); the first real run landed that night.
 */
export const KIT_PAGE_DEFAULTS: Partial<Record<PageKey, boolean>> = {
  bundle: false,
}

export type { PageToggles }
