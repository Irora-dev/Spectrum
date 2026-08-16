// ─────────────────────────────────────────────────────────────────────────────
// RANGE ORDERS — the maths behind "sell between $1M and $5M market cap".
//
// the owner, 2026-08-06 14:52 + his greenlight at ~15:1x: sell THROUGH a liquidity
// position rather than into the market, with the pool/tick/ratio complexity
// hidden, plus "how close to full buying/selling you are", the ability to
// withdraw, and a bento tile that fills up or down with the progress.
//
// REACT-FREE AND PURE, by the lane's money-path law — this is the module the
// preview number and the fill bar both read, so it has to be drivable from
// outside a component and gated against every unreadable input.
//
// THE ONE RESULT EVERYTHING RESTS ON. For a single-sided position of liquidity
// L over [Pa, Pb], the token amounts are:
//     below the range (all token0):  amount0 = L · (1/√Pa − 1/√Pb)
//     above the range (all token1):  amount1 = L · (√Pb − √Pa)
// Divide them and L cancels, leaving
//     average fill price = √(Pa · Pb)
// A FULLY-TRAVERSED RANGE ORDER FILLS AT THE GEOMETRIC MEAN OF ITS BOUNDS —
// not the midpoint. Selling between $1M and $5M mcap fills at ≈$2.24M, and
// showing the midpoint instead would overstate the proceeds by a third.
//
// WHAT THIS MODULE REFUSES TO DO: predict. Every number here is conditional
// arithmetic about a price path that may not happen, and the surface must say
// so — "if it trades through this range, the pool pays you X", never "you will
// make X" (the profit-projection red line).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE RANGE-ORDER FEE — 0.50% of what a position ACTUALLY CONVERTED, taken only
 * when it is withdrawn (the owner, 2026-08-06 ~15:2x). This SUPERSEDES his earlier
 * "maybe smaller than the full buy/sell tx" (14:52) — he ruled the full rate,
 * and the most recent decision governs.
 *
 * Two things the rate alone does not say, and both are the point:
 *   · REALISED ONLY. An order that never filled and is withdrawn pays nothing;
 *     a half-filled one pays on the half. You are never billed for a resting
 *     offer, which is what makes charging the full 0.50% fair here.
 *   · WITHDRAWAL, NOT EXIT-IN-GENERAL. Our fee copy long said "never charged on
 *     exit", which was written about redeeming a BASKET, before range orders
 *     existed. That wording is now narrowed to say what it always meant, rather
 *     than left to imply a promise this product breaks.
 */
export const RANGE_ORDER_FEE_BPS = 50

/** What the fee takes from a realised amount, and what lands. Finite-gated: an
 *  unreadable proceeds figure must never produce a confident fee. */
export function rangeOrderFee(realisedProceeds: number): { fee: number; net: number } | null {
  if (!Number.isFinite(realisedProceeds) || realisedProceeds <= 0) return null
  const fee = (realisedProceeds * RANGE_ORDER_FEE_BPS) / 10_000
  const net = realisedProceeds - fee
  return Number.isFinite(fee) && Number.isFinite(net) ? { fee, net } : null
}

/** A price range, in quote units per token. */
export interface PriceRange {
  lower: number
  upper: number
}

export type RangeOrderSide = 'sell' | 'buy'

/** Price implied by a market cap and a circulating supply. Null when either
 *  input is unreadable — a market cap we cannot convert is not a price, and a
 *  guessed supply would silently misprice the whole preview. */
export function priceForMcap(mcapUsd: number, circulatingSupply: number): number | null {
  if (!Number.isFinite(mcapUsd) || mcapUsd <= 0) return null
  if (!Number.isFinite(circulatingSupply) || circulatingSupply <= 0) return null
  const p = mcapUsd / circulatingSupply
  return Number.isFinite(p) && p > 0 ? p : null
}

/** The inverse — for labelling a price back in the units he thinks in. */
export function mcapForPrice(price: number, circulatingSupply: number): number | null {
  if (!Number.isFinite(price) || price <= 0) return null
  if (!Number.isFinite(circulatingSupply) || circulatingSupply <= 0) return null
  const m = price * circulatingSupply
  return Number.isFinite(m) && m > 0 ? m : null
}

/** Uniswap's tick for a price. Kept here so the mcap→tick path is one hop and
 *  one place; callers snap to the pool's tick spacing before minting. */
export function tickForPrice(price: number): number | null {
  if (!Number.isFinite(price) || price <= 0) return null
  const t = Math.log(price) / Math.log(1.0001)
  return Number.isFinite(t) ? Math.round(t) : null
}

/** Snap to the pool's tick spacing. Direction matters: a SELL range must not
 *  quietly widen downward past the floor the user set (they would fill cheaper
 *  than they asked), so the lower bound rounds UP and the upper rounds DOWN.
 *  The surface then shows the snapped market caps, never the typed ones. */
export function snapTick(tick: number, spacing: number, mode: 'up' | 'down'): number | null {
  if (!Number.isFinite(tick) || !Number.isInteger(spacing) || spacing <= 0) return null
  return (mode === 'up' ? Math.ceil(tick / spacing) : Math.floor(tick / spacing)) * spacing
}

export interface RangeOrderPreview {
  /** Average price the position fills at IF price traverses the whole range. */
  avgFillPrice: number
  /** Quote received for the whole size at that average — the headline number. */
  proceeds: number
  /** The average expressed as a market cap, when supply is known. */
  effectiveMcap: number | null
  /** How the average compares with selling at the range floor (×). Always ≥ 1
   *  for a valid range: this is the honest form of "why bother". */
  upliftVsFloor: number
}

/**
 * What a fully-traversed range order pays.
 *
 * CONDITIONAL, and the caller must present it as such. Returns null rather than
 * a number whenever an input cannot carry one — a preview that quietly shows a
 * wrong figure on someone's whole position is the worst failure available here.
 */
export function previewRangeOrder(
  amount: number,
  range: PriceRange,
  circulatingSupply?: number | null,
): RangeOrderPreview | null {
  const { lower, upper } = range
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null
  if (lower <= 0 || upper <= 0) return null
  // A zero-width or inverted range is not a range. Equal bounds would divide by
  // zero in the uplift below and, more importantly, cannot be minted.
  if (upper <= lower) return null

  const avgFillPrice = Math.sqrt(lower * upper)
  const proceeds = amount * avgFillPrice
  if (!Number.isFinite(avgFillPrice) || !Number.isFinite(proceeds)) return null

  return {
    avgFillPrice,
    proceeds,
    effectiveMcap:
      circulatingSupply != null && Number.isFinite(circulatingSupply) && circulatingSupply > 0
        ? mcapForPrice(avgFillPrice, circulatingSupply)
        : null,
    upliftVsFloor: avgFillPrice / lower,
  }
}

export type RangeOrderState = 'waiting' | 'filling' | 'filled'

export interface RangeOrderProgress {
  /** 0 → nothing converted · 1 → fully converted. */
  fraction: number
  state: RangeOrderState
  /** TRUE while the position can still reverse — i.e. always, until withdrawn.
   *  A filled range order is NOT a completed sale, and this flag exists so no
   *  surface can forget that. */
  canUnfill: boolean
}

/**
 * How far through the range the price has carried the position — the number
 * behind "how close to full buying/selling you are" and behind the bento tile
 * filling up or down.
 *
 * Derived from the position's own arithmetic rather than from where the price
 * sits between the bounds: the amount remaining at price P is
 * L·(1/√P − 1/√Pb), so the converted fraction is
 *     1 − (1/√P − 1/√Pb) / (1/√Pa − 1/√Pb)
 * A LINEAR READ OF THE PRICE WOULD BE WRONG — conversion is not linear in
 * price, and a bar that says "half sold" when it is not is a lie about money.
 *
 * `canUnfill` is true at every state including `filled`, because a range order
 * is not a limit order: until the position is withdrawn, a price that comes
 * back down spends the proceeds buying the tokens back.
 */
export function rangeOrderProgress(
  currentPrice: number,
  range: PriceRange,
  side: RangeOrderSide = 'sell',
): RangeOrderProgress | null {
  const { lower, upper } = range
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= 0) return null
  if (upper <= lower) return null

  // A BUY order is the mirror image: it converts as price falls THROUGH the
  // range from above, so its progress runs the other way along the same maths.
  const p = Math.min(Math.max(currentPrice, lower), upper)
  const invP = 1 / Math.sqrt(p)
  const invA = 1 / Math.sqrt(lower)
  const invB = 1 / Math.sqrt(upper)
  const span = invA - invB
  if (!Number.isFinite(span) || span <= 0) return null

  const remaining = (invP - invB) / span
  const sold = 1 - remaining
  const raw = side === 'sell' ? sold : remaining
  // clamp defensively: floating error at the bounds must not print 100.0001%
  const fraction = Math.min(1, Math.max(0, raw))
  if (!Number.isFinite(fraction)) return null

  return {
    fraction,
    state: fraction <= 0 ? 'waiting' : fraction >= 1 ? 'filled' : 'filling',
    // ALWAYS true until withdrawn — see the doc comment. This is the flag the
    // UI must not be allowed to ignore.
    canUnfill: true,
  }
}
