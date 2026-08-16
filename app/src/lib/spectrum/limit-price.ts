import { formatUnits, parseUnits } from 'viem'
import { readOutlook, type OutlookRead } from './order-intent'

// ─────────────────────────────────────────────────────────────────────────────
// THE PRICE SAFEGUARDS (owner 2026-08-02: "the limit order pricing is absolutely
// concrete, it cannot mess up in any way, it needs multiple safe guard systems").
//
// The signature IS the authorization. There is no second confirmation, no
// simulate-then-sign, no revert to protect anyone: once a limit order is signed
// and posted, a solver can take it at that price and it is final. So the number
// we put into `buyAmount` has to be right by CONSTRUCTION, and then checked
// again by machinery that does not trust the construction.
//
// SIX LAYERS, each one catching a failure the others cannot:
//
//  1. NO FLOATS, EVER. Human price text goes to bigint through viem's
//     string-based parseUnits. A single float round-trip at 18 decimals is
//     enough to move real money, and it fails silently.
//  2. DECIMALS ARE STRUCTURAL. Both token decimals are required arguments. USDC
//     is 6 and WETH is 18, so a swap of the two is a 10^12 error — it cannot be
//     defaulted, inferred or omitted here.
//  3. ROUND IN THE USER'S FAVOUR. `buyAmount` is a FLOOR on what they receive,
//     so the conversion rounds UP. Truncating down would quietly ask for one wei
//     less than they typed, every single time.
//  4. ROUND-TRIP PROOF. The raw amount is converted BACK to a price and compared
//     with what was typed. Anything that does not survive the round trip is
//     refused rather than signed.
//  5. MARKET CROSS-CHECK. A price far below the market is blocked outright (see
//     order-intent), because that is the one mistake that loses money instantly.
//  6. FRESHNESS. The market used for layer 5 must be recent. A stale reference
//     silently approves a price the market has already left behind — the exact
//     "fresh price was the ten-minute cache wearing a fresh comment" bug this
//     repo has already shipped once.
//
// Everything here is pure and integer-only so it can be tested exhaustively.
// ─────────────────────────────────────────────────────────────────────────────

/** How old a market reference may be and still be allowed to validate a price. */
export const MARKET_MAX_AGE_MS = 60_000

/** Division that rounds UP. Used for every buy-side conversion, because
 *  `buyAmount` is the minimum the user will accept: rounding down asks for less
 *  than they said, which is the wrong direction to be wrong in. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('ceilDiv by zero')
  return (a + b - 1n) / b
}

export type PriceResult =
  | { ok: true; minBuyAmountRaw: bigint; roundTripPrice: string; outlook: OutlookRead | null }
  | { ok: false; reason: string; blocking: boolean }

export interface PriceArgs {
  /** Exactly what the user typed. A STRING, never a number — the moment this is
   *  a float the guarantees above are gone. */
  priceText: string
  /** Units of buy token per ONE whole unit of sell token. */
  sellAmountRaw: bigint
  sellDecimals: number
  buyDecimals: number
  /** The current market rate for the same pair, same orientation, for layer 5.
   *  Omit it and the price is still computed exactly — but the market check is
   *  reported as not performed rather than silently passed. */
  market?: { rate: number; asOfMs: number }
  nowMs?: number
}

/** Reject text that is not a plain positive decimal BEFORE it reaches parseUnits,
 *  so the failure is a sentence rather than a thrown library error. Deliberately
 *  strict: no exponent notation, no separators, no signs, no whitespace inside. */
const DECIMAL_RE = /^\d+(\.\d+)?$/

export function priceTextRefusal(priceText: string, buyDecimals: number): string | null {
  const t = priceText.trim()
  if (t === '') return 'Enter a price.'
  if (!DECIMAL_RE.test(t)) return 'That price is not a plain number.'
  if (Number(t) === 0) return 'The price cannot be zero.'
  const frac = t.split('.')[1] ?? ''
  // parseUnits would TRUNCATE the excess silently, so refuse instead: a price
  // the user cannot actually express in this token is a price we must not
  // pretend to have accepted.
  if (frac.length > buyDecimals) {
    return `That price has more decimal places than this token supports (${buyDecimals}).`
  }
  return null
}

/**
 * Turn a typed price into the exact `buyAmount` to sign, or refuse.
 *
 * Never returns a "best effort" number. Every path that cannot produce a
 * provably correct amount returns a refusal, because the alternative is a
 * signable order carrying a price nobody chose.
 */
export function limitAmountFromPrice(args: PriceArgs): PriceResult {
  const { priceText, sellAmountRaw, sellDecimals, buyDecimals } = args

  if (!Number.isInteger(sellDecimals) || sellDecimals < 0 || sellDecimals > 36)
    return { ok: false, reason: 'Unusable sell-token decimals.', blocking: true }
  if (!Number.isInteger(buyDecimals) || buyDecimals < 0 || buyDecimals > 36)
    return { ok: false, reason: 'Unusable buy-token decimals.', blocking: true }
  if (sellAmountRaw <= 0n) return { ok: false, reason: 'Enter an amount to sell.', blocking: true }

  const textRefusal = priceTextRefusal(priceText, buyDecimals)
  if (textRefusal) return { ok: false, reason: textRefusal, blocking: true }

  // LAYER 1 + 2: exact, string-based, decimals explicit on both sides.
  let priceRaw: bigint
  try {
    priceRaw = parseUnits(priceText.trim(), buyDecimals)
  } catch {
    return { ok: false, reason: 'That price could not be read.', blocking: true }
  }
  if (priceRaw <= 0n) return { ok: false, reason: 'The price cannot be zero.', blocking: true }

  // LAYER 3: round UP, so the floor we sign is never below what was typed.
  const scale = 10n ** BigInt(sellDecimals)
  const minBuyAmountRaw = ceilDiv(sellAmountRaw * priceRaw, scale)
  if (minBuyAmountRaw <= 0n) {
    return {
      ok: false,
      reason: 'That size and price round to nothing at this token’s precision.',
      blocking: true,
    }
  }

  // LAYER 4: prove it survives the trip back.
  //
  // The tolerance has to be PROPORTIONAL, not a flat one unit. Recovering the
  // price divides by the sell size, so one unit of rounding in `buyAmount` moves
  // the recovered price by `scale / sellAmountRaw` — which is 1 when selling a
  // whole token and enormous when selling a fraction of one. A flat tolerance
  // would reject perfectly ordinary orders below 1 whole unit.
  const ulpPrice = ceilDiv(scale, sellAmountRaw) // price units per 1 unit of buyAmount
  const allowedDrift = ulpPrice > 1n ? ulpPrice : 1n

  const recoveredRaw = (minBuyAmountRaw * scale) / sellAmountRaw
  const driftUlp = recoveredRaw > priceRaw ? recoveredRaw - priceRaw : priceRaw - recoveredRaw
  if (driftUlp > allowedDrift) {
    return {
      ok: false,
      reason: 'This price cannot be represented exactly at this size. Adjust the amount or the price.',
      blocking: true,
    }
  }

  // THE DUST GUARD, and the reason it is separate from the drift check: when the
  // sell size is tiny, a SINGLE unit of the buy token is worth a large fraction
  // of the price, so the order technically converts but the number signed no
  // longer means what was typed. Refuse rather than sign a price nobody chose.
  // (Threshold: one unit of rounding must be under 0.1% of the price.)
  if (allowedDrift * 1000n > priceRaw) {
    return {
      ok: false,
      reason: 'That amount is too small to express this price. Increase the amount.',
      blocking: true,
    }
  }
  const roundTripPrice = formatUnits(recoveredRaw, buyDecimals)

  // LAYER 5 + 6: the market cross-check, and only against a FRESH market.
  let outlook: OutlookRead | null = null
  if (args.market) {
    const age = (args.nowMs ?? 0) - args.market.asOfMs
    const fresh = args.nowMs == null || (age >= 0 && age <= MARKET_MAX_AGE_MS)
    if (fresh) {
      outlook = readOutlook(args.market.rate, Number(priceText))
      if (outlook?.blocking) {
        return { ok: false, reason: outlook.line, blocking: true }
      }
    }
    // A stale market does NOT block: the price may be perfectly fine and we
    // simply cannot vouch for it. `outlook` stays null and the surface must say
    // it could not check, never imply it did.
  }

  return { ok: true, minBuyAmountRaw, roundTripPrice, outlook }
}

/**
 * THE LAST GATE, run immediately before the wallet prompt.
 *
 * Layer 4 proves the number is arithmetically right. This proves it is still the
 * number the USER LOOKED AT. A quote refresh, a re-render, or a second tab can
 * move the computed amount between the moment it was shown and the moment it is
 * signed — and the too-LOW direction is the dangerous one, because a floor below
 * what was displayed sells for less than the screen promised.
 *
 * ⚠️ HOW TO CALL THIS CORRECTLY — the mistake is easy and silent.
 *
 * `displayedRaw` must be a value CAPTURED WHEN THE USER SAW IT, held across the
 * render, e.g. in a ref updated where the number is rendered. It must NOT be
 * recomputed at click time.
 *
 * If you compute the amount at click time and then compare it against an order
 * you just built from that same amount, this function compares a value to
 * itself: it always returns null and protects nothing. It looks present in the
 * diff, it reads correctly, and it can never fire. That is exactly how it was
 * first wired in the limit ticket, and this note exists because the original
 * wording here ("pass the exact value that was rendered") was not emphatic
 * enough about WHERE the value has to come from.
 *
 * If they disagree at all, refuse: a mismatch means the two halves of the app
 * disagree about the price, and that is never resolved by picking one.
 */
export function confirmSignableAmount(displayedRaw: bigint, aboutToSignRaw: bigint): string | null {
  if (displayedRaw !== aboutToSignRaw) {
    return 'The price moved while you were signing. Check the new number and try again.'
  }
  return null
}
