// ─────────────────────────────────────────────────────────────────────────────
// WHAT WILL ACTUALLY HAPPEN TO THIS ORDER (owner 2026-08-02: "limit is useful to
// include too, it is sort of three options right").
//
// He is right, and the reason is worth stating precisely because it drives the
// whole surface: a "work it patiently" order and a "only at my price" order are
// THE SAME SIGNED STRUCT. Both are a CoW limit order with partiallyFillable set.
// The only thing that differs is WHERE THE USER'S PRICE SITS RELATIVE TO THE
// MARKET — and that one fact decides whether the order almost certainly fills in
// pieces, or probably never fills at all.
//
// So the honest surface is not three mechanisms, it is one mechanism with three
// outcomes, and the UI's job is to tell the user which one they have just built
// BEFORE they sign it. That is what this module computes.
//
// THE AXIS IS PRICE, NOT TIME. A TWAP's mental model is a clock: n slices, one
// every t seconds. This has no clock at all — fills arrive when the market
// reaches your number, which might be twice in an hour or never. Every word and
// every pixel we spend on this must describe AMOUNT and PRICE. The moment we
// draw a timeline we are lying.
//
// Screening law applied here: never say "better price" (spreading a fill is a
// mechanism, "better" is a promise), never say TWAP for any of these, and never
// present an unfilled expiry as a failure — it is the order doing exactly what
// was asked.
// ─────────────────────────────────────────────────────────────────────────────

/** Where the user's limit sits against the current market, and therefore what
 *  they should expect. Ordered from most to least likely to complete. */
export type OrderOutlook =
  /** FAR below the market. Almost certainly a mistyped price, and it fills
   *  instantly at whatever was typed. This is the only outlook that can lose the
   *  user money the moment they sign, so it is the only one that BLOCKS. */
  | 'giveaway'
  /** Below the market by more than normal fill tolerance. Legitimate (accepting
   *  a little less to be sure of filling), but the size of the haircut is stated
   *  in money terms rather than buried. */
  | 'discount'
  /** At or through the market: expect it to fill, likely in one or two pieces. */
  | 'immediate'
  /** Just off the market: expect it to work in pieces as liquidity appears.
   *  This is the honest replacement for "spread over time". */
  | 'patient'
  /** Meaningfully away from the market: a price target. Fills only if the
   *  market comes to you, and may simply expire. That is the deal. */
  | 'target'
  /** So far from the market that promising anything would be misleading. */
  | 'far'

export interface OutlookRead {
  outlook: OrderOutlook
  /** How far the limit is from the market, in percent. Positive = the user is
   *  asking for more than the market currently offers. */
  awayPct: number
  /** The one sentence shown under the price field. States the MECHANISM, never
   *  a probability we cannot compute and never a promise. */
  line: string
  /** The short label for the chip beside the field. */
  label: string
  /** How loudly the surface should say it. `danger` MUST also block signing —
   *  see `blocking`. */
  severity: 'ok' | 'caution' | 'danger'
  /**
   * The order must not be signable in this state.
   *
   * There is exactly one such state and it is worth being explicit about why:
   * every other bad outcome here costs the user TIME (an order that never
   * fills). A sell price far below the market costs them MONEY, instantly, and
   * the loss is irreversible the moment a solver takes it. A warning is not
   * enough for that, because the whole point of a limit order is that people
   * type numbers into it, and a mistyped decimal is the single most likely
   * mistake on this surface.
   */
  blocking: boolean
}

/** Boundaries, deliberately named rather than inlined. These are presentation
 *  thresholds, not risk limits: they decide which honest sentence to show, so
 *  moving them changes wording only, never behaviour. */
export const PATIENT_MAX_PCT = 1
export const TARGET_MAX_PCT = 25

/** Below the market by more than this is a real haircut and gets named. Normal
 *  fill tolerance lives inside it. */
export const DISCOUNT_PCT = 2
/** Below the market by more than this is treated as a mistyped price and BLOCKS.
 *  Chosen well outside any legitimate "fill me now" tolerance: nobody knowingly
 *  gives away a tenth of a position to save a few minutes. */
export const GIVEAWAY_PCT = 10

/**
 * Classify a SELL order's limit against the market rate.
 *
 * `marketRate` and `limitRate` are both "units of buy token per one unit of
 * sell token" — the caller normalises decimals, because this module must not
 * know about token metadata (it stays React-free and dependency-free so it can
 * be lifted into a service worker like the other analytical modules).
 *
 * Returns null when there is no usable market rate. A missing quote is NOT a
 * verdict: the UI must say it could not read the market rather than implying
 * the price is fine.
 */
export function readOutlook(marketRate: number, limitRate: number): OutlookRead | null {
  if (!Number.isFinite(marketRate) || !Number.isFinite(limitRate)) return null
  if (marketRate <= 0 || limitRate <= 0) return null

  const awayPct = ((limitRate - marketRate) / marketRate) * 100

  // ── BELOW the market ──────────────────────────────────────────────────────
  // The dangerous direction, and the one a naive implementation gets wrong: a
  // sell price under the market fills IMMEDIATELY, so "it will fill" is true and
  // completely beside the point. What matters is how much is being left behind.

  if (awayPct < -GIVEAWAY_PCT) {
    return {
      outlook: 'giveaway',
      awayPct,
      label: 'check this price',
      line: `This is ${fmtPct(awayPct)} BELOW the market. It would fill immediately and you would get ${fmtPct(awayPct)} less than selling right now. Check the decimal point.`,
      severity: 'danger',
      blocking: true,
    }
  }

  if (awayPct < -DISCOUNT_PCT) {
    return {
      outlook: 'discount',
      awayPct,
      label: 'under the market',
      line: `${fmtPct(awayPct)} below the market. It should fill quickly, and you accept ${fmtPct(awayPct)} less than selling right now.`,
      severity: 'caution',
      blocking: false,
    }
  }

  // At the market, within normal fill tolerance. The user is not really setting
  // a limit, they are accepting what is there. Say so plainly.
  if (awayPct <= 0) {
    return {
      outlook: 'immediate',
      awayPct,
      label: 'fills now',
      line: 'Your price is at the market, so this should fill straight away.',
      severity: 'ok',
      blocking: false,
    }
  }

  // ── ABOVE the market ──────────────────────────────────────────────────────
  // The safe direction: the worst case is that nothing happens.

  if (awayPct <= PATIENT_MAX_PCT) {
    return {
      outlook: 'patient',
      awayPct,
      label: 'works in pieces',
      line: 'Just above the market. Expect it to fill in pieces as the market reaches it, rather than all at once.',
      severity: 'ok',
      blocking: false,
    }
  }

  if (awayPct <= TARGET_MAX_PCT) {
    return {
      outlook: 'target',
      awayPct,
      label: 'waits for your price',
      // The failure mode is stated in the SAME breath as the upside. A user who
      // only reads one sentence must still learn that this can end in nothing.
      line: `${fmtPct(awayPct)} above the market. It fills only if the market reaches your price, and any part that never does simply expires.`,
      severity: 'ok',
      blocking: false,
    }
  }

  return {
    outlook: 'far',
    awayPct,
    label: 'unlikely',
    line: `${fmtPct(awayPct)} above the market. Nothing will happen unless the market moves a long way, and the order expires untouched if it does not.`,
    severity: 'caution',
    blocking: false,
  }
}

function fmtPct(p: number): string {
  const a = Math.abs(p)
  return `${a >= 10 ? Math.round(a) : a.toFixed(1)}%`
}

/** Marker position (0-1) for drawing the limit against the market on a scale.
 *  The scale spans market ± `spanPct`, and the value CLAMPS rather than running
 *  off the end — a marker outside its own track is the clipping class of bug,
 *  and a clamped marker plus the stated percentage tells the truth anyway. */
export function markerPosition(awayPct: number, spanPct = TARGET_MAX_PCT): number {
  if (!Number.isFinite(awayPct) || spanPct <= 0) return 0.5
  const t = 0.5 + awayPct / (spanPct * 2)
  return Math.min(1, Math.max(0, t))
}

/** How much of an order has been filled, 0-1. Guards the shapes the API can
 *  actually return: a zero total (nothing to divide by) and an executed amount
 *  that exceeds it (surplus fills are real on CoW — the solver may beat the
 *  limit, and a bar past 100% would look like a bug). */
export function fillFraction(executedSellRaw: bigint, totalSellRaw: bigint): number {
  if (totalSellRaw <= 0n) return 0
  if (executedSellRaw <= 0n) return 0
  if (executedSellRaw >= totalSellRaw) return 1
  // Scale to basis points before converting: Number(bigint/bigint) truncates to
  // 0 or 1 for anything but exact multiples.
  return Number((executedSellRaw * 10_000n) / totalSellRaw) / 10_000
}

/** The live sentence for a working order. Deliberately mentions PIECES and never
 *  a schedule, an ETA or a completion estimate — we cannot know any of those and
 *  a guess would read as a promise. */
export function fillProgressLine(fraction: number, expired: boolean): string {
  const pct = Math.round(fraction * 100)
  if (expired) {
    if (fraction <= 0) return 'Expired without filling. Your price was never reached, so nothing moved.'
    return `Expired after filling ${pct}%. The rest never reached your price, so it did not happen.`
  }
  if (fraction <= 0) return 'Waiting for your price. Nothing has filled yet.'
  if (fraction >= 1) return 'Filled completely at your price or better.'
  return `${pct}% filled so far, in pieces, at your price or better. The rest is still working.`
}
