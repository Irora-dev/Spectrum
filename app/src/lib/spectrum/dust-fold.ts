import { DUST_CEILING_USD } from './insights'

// ─────────────────────────────────────────────────────────────────────────────
// THE DUST FOLD (owner 2026-08-12: "the portfolio shouldn't show dust/spam
// like it does atm with this unity token — we should hide dust"). Positions
// under the floor leave the MAIN views (list + picture) and fold into one
// quiet expandable row at the card's foot — folded, never deleted: the row
// states the count and the folded total so the headline math visibly
// reconciles, and the expander shows every row.
//
// The floor is the house dust constant (insights.ts DUST_CEILING_USD, $10) —
// the same number the dust-sweep insight has always used, so "dust" means ONE
// thing on this page.
//
// Laws:
//  · UNPRICED is not dust — a null value is "could not be priced", and a real
//    position must never hide behind a price-feed gap. Nulls stay in main.
//  · EXEMPT keys (hand-added assets) never fold — the user explicitly asked
//    for that asset; folding it would un-answer them.
//  · Never fold the whole book — if everything under the roof is dust, the
//    book renders as-is (a fold row with an empty page behind it hides the
//    entire portfolio).
// ─────────────────────────────────────────────────────────────────────────────

export interface DustFoldableRow {
  /** `chainId:address` (lowercase) — the book's own row key. */
  key: string
  /** Null = unpriced (never dust). */
  valueUsd: number | null
}

export interface DustFold<T> {
  /** What the main views render. */
  main: T[]
  /** What folded — order preserved from the input. */
  dust: T[]
  /** The folded total, for the fold row's own honest arithmetic. */
  dustUsd: number
}

export function foldDust<T extends DustFoldableRow>(
  rows: readonly T[],
  opts: { exempt?: ReadonlySet<string>; floorUsd?: number } = {},
): DustFold<T> {
  const floor = opts.floorUsd ?? DUST_CEILING_USD
  const isDust = (r: T) =>
    r.valueUsd != null && r.valueUsd > 0 && r.valueUsd < floor && !(opts.exempt?.has(r.key) ?? false)
  const dust = rows.filter(isDust)
  // nothing to fold, or the WHOLE book is dust — render as-is
  if (dust.length === 0 || dust.length === rows.length) {
    return { main: [...rows], dust: [], dustUsd: 0 }
  }
  const dustKeys = new Set(dust.map((r) => r.key))
  return {
    main: rows.filter((r) => !dustKeys.has(r.key)),
    dust,
    dustUsd: dust.reduce((s, r) => s + (r.valueUsd ?? 0), 0),
  }
}
