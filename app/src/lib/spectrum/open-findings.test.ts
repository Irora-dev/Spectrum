import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// THE OPEN-FINDINGS REGISTRY — known defects, each holding its own status.
//
// WHY THIS FILE EXISTS (2026-08-07): findings lived as prose in desk notes,
// which rot in BOTH directions at once — three of four "still open" criticals
// I checked today were already fixed, while a live CRITICAL (M2) sat one
// bullet away from fixed items and stayed invisible for a day. A paragraph
// cannot tell you its own status. A test can.
//
// THE MECHANISM: each OPEN finding is an `it.fails` test asserting the
// DESIRED state — it "passes" exactly while the defect exists. The moment the
// fix lands, the `.fails` wrapper fails loudly ("expected test to fail, but
// it passed"), forcing the fixer to promote the case into the owning module's
// suite as a real pin and delete the row here. Status = one command; nothing
// here can silently rot in either direction.
//
// RULES: one finding per row, named for its desk id and severity · the row's
// flip condition must be UNAMBIGUOUS (a named symbol or field the fix will
// introduce — the row is allowed to be that name's spec) · a row that cannot
// reproduce its finding does NOT belong here (M3 was dropped on exactly that:
// two fixtures built from the reviewer's own words both behaved correctly —
// see the 2026-08-07 registry commit) · nothing here may encode a POLICY that
// is an open human decision — those are asks on the owner's desk, not rows.
// ─────────────────────────────────────────────────────────────────────────────

// Only what the surviving rows read. The desk-236 row's whole-tree glob, its
// sweep-state and triage imports and its digest helper went WITH that row when
// it closed on 2026-08-07 — its check now lives in the go-live interlock, where
// a byte-level digest costs friction only at the flip. Dead scaffolding left
// behind by a closed row is how the next reader learns the wrong thing.
const SOURCES = import.meta.glob(
  ['/src/lib/spectrum/allocation.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

describe('OPEN findings — each row passes only while its defect exists', () => {
  // ── CLOSED 2026-08-07: desk-236-M10/M11, the unreachable guards ────────────
  // The reviewer reported "several unreachable guards" without naming them, and
  // the note could not be verified from its own text: an unreachable guard is
  // either dead code or a guard whose reachability nobody has proven, and those
  // want opposite fixes. A12's mutation sweep answered it. All seven money-core
  // targets are swept, every survivor carries a verdict in mutation-triage.json,
  // and the eleven that were real are pinned in their own modules' suites. The
  // standing check moved to the go-live interlock (`moneyCoreNotClean`) rather
  // than living here, because the digest is byte-level and a suite that reddens
  // on a comment edit is a control that gets switched off.
  //
  // ── CLOSED 2026-08-12: desk-204, the provenance half — with the execute-
  // station arming, exactly where the row said the fix would land. The draft
  // now records `seedBookOwner` at the seeding seams (positions mode + the
  // publish picker, stamped from Yours' effectiveAddress), loadDraft
  // sanitizes it, and REAL execution refuses a demo-seeded draft by name
  // (execution-arming.ts). Promoted pins: allocation.test.ts (the field's
  // life across the storage seam and adoptGuestDraft — the laundering seam)
  // and execution-arming.test.ts (the refusal under a real signer, ranked
  // above the global flags). The registry is EMPTY.
  it('the registry is empty — every past row is promoted into its owning module’s suite', () => {
    // A registry file with no tests would error as "no test found", and a
    // bare empty describe would say nothing. This row is the registry's own
    // status: the desk-204 field exists where its row demanded it.
    expect(SOURCES['/src/lib/spectrum/allocation.ts']).toContain('seedBookOwner')
  })
})
