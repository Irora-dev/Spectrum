// ─────────────────────────────────────────────────────────────────────────────
// HELD BASKETS — "you hold this", as a lookup (QOL round 2026-08-05).
//
// Explore showed watchlist stars but nothing about the viewer's own book, so a
// basket already in the wallet looked identical to one never touched: discovery
// was disconnected from what you own. This is the derivation behind the card
// marker, kept pure so the two card surfaces (BasketCard, Explore's ThesisCard)
// cannot disagree about the same wallet.
//
// ONE READ, AT THE PAGE: the index is built ONCE from what usePortfolio already
// returned (see use-held-baskets.ts) and passed down. A card must never start its
// own portfolio query — N cards × the whole catalogue is a page-sized waste of
// exactly the read the page already holds.
//
// HONESTY, the same law found-book.ts obeys: a holding whose value cannot be
// priced is NULL, never 0. The marker states only the FACT of holding, so it
// still shows for an unpriced position; the value beside it is simply absent.
// "$0" next to "You hold this" reads as "your position is worthless", which is a
// lie we cannot tell. Absent beats guessed.
//
// Pure by design (no React, no storage, no network) — structural inputs only, so
// the node-environment test suite can drive it directly.
// ─────────────────────────────────────────────────────────────────────────────

/** What the viewer holds of ONE basket. */
export interface HeldPosition {
  /** Basket tokens held across the wallet group. Always > 0 — a zero balance is
   *  not a holding, and the marker must not appear for one. */
  balance: number
  /** Priced dollars, or null when the basket's NAV could not be priced. Never 0. */
  valueUsd: number | null
}

/** Held positions keyed by basket. Absent key = not held (or nothing read yet). */
export type HeldIndex = ReadonlyMap<string, HeldPosition>

/** The key both card surfaces resolve through: chain-qualified, lowercased — a
 *  basket address alone is ambiguous across chains (the same tile-stacking trap
 *  found-book.ts pins for the bento). */
export function heldKey(basket: { chainId: number; address: string }): string {
  return `${basket.chainId}:${basket.address.toLowerCase()}`
}

/** Fold the portfolio's holdings into the lookup. Takes the shape usePortfolio
 *  already returns; a row with no real balance is dropped rather than indexed as
 *  a $0 position. Later rows for one basket sum, so a linked-wallet group reads
 *  as ONE book (wallet-links.ts) even if the merge ever hands us duplicates. */
export function indexHeldBaskets(
  holdings:
    | readonly { basket: { chainId: number; address: string }; balance: number; valueUsd: number }[]
    | null
    | undefined,
): HeldIndex {
  const out = new Map<string, HeldPosition>()
  for (const h of holdings ?? []) {
    if (!Number.isFinite(h.balance) || h.balance <= 0) continue
    const key = heldKey(h.basket)
    const prev = out.get(key)
    // balance × NAV: > 0 means something priced actually came back. Anything
    // else (0, negative, NaN, a basket whose NAV is unreadable) is unpriced.
    const priced = Number.isFinite(h.valueUsd) && h.valueUsd > 0 ? h.valueUsd : null
    out.set(key, {
      balance: (prev?.balance ?? 0) + h.balance,
      valueUsd: priced == null && prev?.valueUsd == null ? null : (prev?.valueUsd ?? 0) + (priced ?? 0),
    })
  }
  return out
}

/** This basket's position, or null when the viewer does not hold it. The cards
 *  take the resolved position, never the whole book — a card has no business
 *  knowing what else is in the wallet. */
export function heldPosition(
  index: HeldIndex | null | undefined,
  basket: { chainId: number; address: string },
): HeldPosition | null {
  return index?.get(heldKey(basket)) ?? null
}

/** The dollars a marker may STATE, or null to show the fact alone.
 *
 *  Two ways a figure is withheld: nothing priced (the law above), and a real but
 *  sub-cent position — formatUsdCompact rounds those to "$0", and a rendered "$0"
 *  is the exact claim this module refuses to make. */
export function heldValueUsd(position: HeldPosition | null | undefined): number | null {
  const usd = position?.valueUsd
  return usd != null && Number.isFinite(usd) && usd >= 0.01 ? usd : null
}

/** The marker's words, in ONE place so both card surfaces say the same thing.
 *  Plain and factual, no jargon (house rule): it states the holding and stops
 *  there. True of a linked wallet's holding too, which is why it says "you" and
 *  not "this wallet". */
export const HELD_LABEL = 'You hold this'
