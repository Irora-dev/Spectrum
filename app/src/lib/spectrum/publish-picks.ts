import { assetKey, DEFAULT_SEED_PCT, emptyDraft, type AllocationDraft } from './allocation'
import type { PositionRow } from './position-intents'

// ─────────────────────────────────────────────────────────────────────────────
// PUBLISH PICKS (owner 2026-08-02 22:00): "when you actually go to publish…
// bring up the bento grid as a pop up, you see your bento grid and they're
// kind of dark, and then you actually select which ones you want to make
// public." This module is the React-free half: which positions CAN be picked,
// what the picked set looks like as shares, and the draft the flow adopts.
//
// WHAT CAN BE PICKED — directly-held tokens only:
//   · BASKETS are excluded: a published basket holding basket units is a
//     BUNDLE, and bundles are not greenlit (the shelf question, G4) — the
//     copy law is "not one token" until the owner opens it. The tile still shows,
//     dark, so the picture is the whole portfolio; it just isn't selectable.
//   · Unpriced positions never reach this module (page law: they are visible,
//     never traded blind).
//   · Cash/stables ARE pickable — they are ordinary tokens as basket legs.
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishPick {
  key: string
  row: PositionRow
  /** Share of the PICKED set, 0–100 — what the published basket would hold. */
  sharePct: number
}

/** Rows a publish can actually include (see header). */
export function publishableRows(rows: PositionRow[]): PositionRow[] {
  return rows.filter((r) => (r.kind ?? 'token') === 'token' && r.valueUsd > 0)
}

/** The picked set with each position's share of it — the "public box". */
export function picksWithShares(rows: PositionRow[], picked: ReadonlySet<string>): PublishPick[] {
  const rowsIn = publishableRows(rows).filter((r) => picked.has(assetKey(r.asset).toLowerCase()))
  const total = rowsIn.reduce((s, r) => s + r.valueUsd, 0)
  return rowsIn
    .map((r) => ({
      key: assetKey(r.asset).toLowerCase(),
      row: r,
      sharePct: total > 0 ? (r.valueUsd / total) * 100 : 0,
    }))
    .sort((a, b) => b.row.valueUsd - a.row.valueUsd)
}

/** Integer percentages summing exactly 100, by largest remainder — with every
 *  entry floored at 1: a position the user PICKED may not silently vanish
 *  because it rounds to zero (the excess comes off the largest legs instead).
 *  The weight station reads weights as literal percents and demands the sum
 *  be 100, so dollar-scale weights rendered as a 200% basket — this is the
 *  exact shape the flow's own pickers produce. */
export function integerShares(values: number[]): number[] {
  // A WEIGHT IS ALWAYS A NUMBER (audit round 5, 2026-08-04): one unreadable
  // value poisoned the total, `Math.floor(NaN)` is NaN, and the function
  // returned NaN weights — which land in a DRAFT and are what the weight
  // station and the composer read. Unreadable and negative values are treated
  // as zero share (they cannot be a proportion of anything) rather than
  // spreading their poison across every sibling.
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const total = clean.reduce((s, v) => s + v, 0)
  if (total <= 0 || clean.length === 0) return clean.map(() => 0)
  const exact = clean.map((v) => (v / total) * 100)
  // a row with no value gets no floor: floor-at-1 exists so a real pick is
  // never dust, not to invent a share for something worth nothing
  const shares = exact.map((e, i) => (clean[i] > 0 ? Math.max(1, Math.floor(e)) : 0))
  let sum = shares.reduce((s, f) => s + f, 0)
  const byFrac = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac)
  let k = 0
  while (sum < 100) {
    shares[byFrac[k % byFrac.length].i] += 1
    sum += 1
    k += 1
  }
  while (sum > 100) {
    const j = shares.indexOf(Math.max(...shares))
    if (shares[j] <= 1) break
    shares[j] -= 1
    sum -= 1
  }
  return shares
}

/** The draft the create flow adopts when the picker hands over. Weights are
 *  integer percents mirroring the picked positions' real proportions; the
 *  user re-weights on the flow's own station if they want something else.
 *  amountUsd is the picked total — the "make THESE public" reading — and
 *  stays editable there too. No `funding` block: this is not a rebalance,
 *  and the rebalance→publish guard must keep refusing drafts that carry one. */
export function buildPublishDraft(
  rows: PositionRow[],
  picked: ReadonlySet<string>,
  now: number,
  /** The address whose HOLDINGS these rows are (desk-204 provenance): stamped
   *  on the draft so real execution can refuse a demo-seeded plan even after
   *  a real wallet adopts it. Callers that read a book must pass it. */
  bookOwner?: string,
): AllocationDraft | null {
  const picks = picksWithShares(rows, picked)
  if (picks.length === 0) return null
  const shares = integerShares(picks.map((p) => p.row.valueUsd))
  return {
    ...emptyDraft(now),
    intent: 'publish',
    targets: picks.map((p, i) => ({ asset: p.row.asset, weight: shares[i] })),
    amountUsd: Math.round(picks.reduce((s, p) => s + p.row.valueUsd, 0) * 100) / 100,
    ...(bookOwner && /^0x[0-9a-fA-F]{40}$/.test(bookOwner) ? { seedBookOwner: bookOwner.toLowerCase() } : {}),
    // HOLDINGS-BACKED (freeze IN-item): the picked positions' held values ride
    // the draft so the review can say "from what you already hold — no new
    // money" and the completion can record the kept remainder.
    seedFrom: picks.map((p) => ({
      chainId: p.row.asset.chainId,
      address: p.row.asset.address.toLowerCase(),
      symbol: p.row.asset.symbol,
      heldUsd: Math.round(p.row.valueUsd * 100) / 100,
    })),
    seedPct: DEFAULT_SEED_PCT,
    updatedAt: now,
  }
}
