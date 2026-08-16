import type { MarketTier } from './market-tiers'

// ─────────────────────────────────────────────────────────────────────────────
// THE TILE CLASS SIGNAL (owner 2026-08-05, option A confirmed from previews:
// "an at a glance way of telling which bento asset is cash, which is stock,
// high caps, mid caps, low caps and a basket — maybe a subtle shape change or
// border?"). The grammar is GEOMETRY WITH MEANING, deliberately color-free:
//
//   basket = DOUBLE BORDER   (a container, drawn literally)
//   cash   = PILL CORNERS    (liquid, at rest)
//   stock  = SHARP CORNERS   (the certificate)
//   crypto = CAP METER       (1–3 bars: ordinal counting is preattentive and
//                             needs no hue — 3 = high incl. ETH/BTC majors,
//                             2 = mid, 1 = low/new; NO meter = unranked,
//                             because absence is honest and a guessed bar is
//                             a claimed fact)
//
// Color-free because three laws point the same way: neutral facts wear
// neutral ink, ~1 in 12 users lose hue signals to colorblindness, and the
// tiles already carry per-asset identity colors that any class tint would
// fight. Signals render AT REST (no hover — phones), in both themes.
// ─────────────────────────────────────────────────────────────────────────────

export interface TileClassSignal {
  kind: 'cash' | 'stock' | 'crypto' | 'basket'
  /** crypto only. Absent = unranked (no meter drawn). */
  capBars?: 1 | 2 | 3
}

/** Map the market tier + the basket kind flag to the tile's signal. The
 *  basket KIND beats any tier (a basket is a position; its tier would be a
 *  category error — the contents' tiers live in the look-through views). */
export function classSignalFor(tier: MarketTier | null | undefined, isBasket: boolean): TileClassSignal {
  if (isBasket) return { kind: 'basket' }
  switch (tier) {
    case 'cash':
      return { kind: 'cash' }
    case 'stocks':
      return { kind: 'stock' }
    case 'majors':
    case 'large':
      return { kind: 'crypto', capBars: 3 }
    case 'mid':
      return { kind: 'crypto', capBars: 2 }
    case 'small':
    case 'micro':
    case 'ultra':
      // one bar is the meter's floor, and 'ultra' is a floor-band too — the
      // thing that distinguishes it is the LAUNCH DATE, which a cap meter
      // cannot say. The tier label and the risk curve carry that; inventing a
      // fourth bar state here would encode newness as a cap reading.
      return { kind: 'crypto', capBars: 1 }
    default:
      return { kind: 'crypto' } // unranked: no meter — absence is honest
  }
}

/** NESTED LEGS THRESHOLD (owner 2026-08-05: "when a basket is a big enough
 *  portion of the portfolio, the basket bento should show the bento assets
 *  within the bento"). "Big enough" is the tile's MEASURED BOX, never its
 *  percentage — a 20% tile is a stamp on a phone and a wall on a desktop,
 *  and the question is legibility, not share. The bounds: a mini-map needs
 *  room for at least a 2×2 of readable cells under the ticker band. */
export function innerLegsFit(tilePxW: number, tilePxH: number, legCount: number): boolean {
  return legCount >= 2 && tilePxW >= 120 && tilePxH >= 96
}
