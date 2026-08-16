import type { RawHolding } from './raw-holdings'
import { formatUsdCompact } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// THE FOUND BOOK — one derivation for every surface that shows "what you
// already hold" as the product's bento: the onboarding ceremony's found step
// and the homepage's get-started act (owner ~16:3x: the homepage face IS the
// onboarding). One source so the surfaces cannot disagree about the same
// wallet:
//  · majors: priced value first, unpriced last, top N — the raw-holdings law
//    (unpriced is not worthless, it is unpriced).
//  · DUST DOES NOT TILE (< $1 renders as a 0% sliver that reads as a bug) —
//    it stays in the remainder rows, honestly listed.
//  · ids are chain-qualified: native ETH shares one sentinel address across
//    chains and the bento keys by address unless told otherwise (the
//    tile-stacking bug, fixed 5ea8cb8 — pinned here for every consumer).
// ─────────────────────────────────────────────────────────────────────────────

export const BENTO_DUST_USD = 1

export interface FoundBookTile {
  id: string
  symbol: string
  address: string
  chainId: number
  weightPct: number
  footer: { amount: string }
}

export interface FoundBook {
  /** The majors, priced first — the found list's row source. */
  top: RawHolding[]
  /** Priced-and-tileable majors (the seed CTA's eligibility source). */
  priced: RawHolding[]
  /** The bento, value-share weighted with money footers. Empty when fewer
   *  than two holdings can tile — a one-tile picture says less than rows. */
  bentoItems: FoundBookTile[]
  /** What the picture cannot carry: unpriced holdings and dust. When the
   *  bento is empty, the whole top list (rows carry everything). */
  listRows: RawHolding[]
  /** Everything PRICED across the wallet(s) — the headline figure. */
  readableUsd: number
}

/** BASKET HOLDINGS AS BOOK ROWS (audit finding, 2026-08-04): the raw sweep
 *  reads the verified token lists, which can never contain a basket token — so
 *  a wallet holding only baskets was told "nothing readable in this wallet yet"
 *  on first open, the worst possible first run for exactly the person who
 *  already converted. The portfolio read already values every held basket at
 *  its own NAV (balance × navPerToken); this folds those rows into the same
 *  book the ceremony and the homepage draw.
 *
 *  Additive by construction — no double count is possible: the raw sweep cannot
 *  see the basket token, and a basket's constituents are held by the BASKET,
 *  not by the wallet. One representation per surface: the basket is ONE tile,
 *  never its look-through legs beside it (the portfolio page keeps the
 *  look-through view, which is a different question).
 *
 *  Pure: takes what usePortfolio already returned. */
export function basketRowsFromPortfolio(
  holdings: { basket: { address: string; symbol: string; chainId: number; decimals?: number }; balance: number; valueUsd: number }[],
): RawHolding[] {
  return holdings
    .filter((h) => h.balance > 0)
    .map((h) => ({
      chainId: h.basket.chainId,
      address: h.basket.address,
      symbol: h.basket.symbol,
      decimals: h.basket.decimals ?? 18,
      amount: h.balance,
      // A basket with an unreadable NAV prices as null (unpriced, not zero) —
      // the same law every other row obeys.
      usd: h.valueUsd > 0 ? h.valueUsd : null,
      basket: true,
    }))
}

/** The wallet's major assets: priced value first, unpriced shown last rather
 *  than dropped. */
export function majors(holdings: RawHolding[], n = 6): RawHolding[] {
  return [...holdings].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)).slice(0, n)
}

export function deriveFoundBook(holdings: RawHolding[], topN = 6): FoundBook {
  const top = majors(holdings, topN)
  const priced = top.filter((h) => h.usd != null && h.usd >= BENTO_DUST_USD)
  const pricedSum = priced.reduce((s, h) => s + (h.usd ?? 0), 0)
  const bentoItems: FoundBookTile[] =
    priced.length >= 2 && pricedSum > 0
      ? priced.map((h) => ({
          id: `${h.chainId}:${h.address.toLowerCase()}`,
          symbol: h.symbol,
          address: h.address,
          chainId: h.chainId,
          weightPct: ((h.usd ?? 0) / pricedSum) * 100,
          footer: { amount: formatUsdCompact(h.usd ?? 0) },
        }))
      : []
  const listRows =
    bentoItems.length >= 2 ? top.filter((h) => !(h.usd != null && h.usd >= BENTO_DUST_USD)) : top
  const readableUsd = holdings.reduce((s, h) => s + (h.usd ?? 0), 0)
  return { top, priced, bentoItems, listRows, readableUsd }
}
