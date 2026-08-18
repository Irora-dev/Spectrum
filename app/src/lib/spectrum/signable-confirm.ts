// ─────────────────────────────────────────────────────────────────────────────
// THE LAST GATE, run immediately before the wallet prompt — shared.
//
// Born in the limit ticket's lane, adopted by the swap card's shown-floor law:
// both products need the same final question answered the same way, so it
// lives here in the seam rather than making the basket side import the
// portfolio's limit-order module for one function (the split's boundary work).
// limit-price re-exports it, so its callers are unchanged.
//
// Layer 4 proves the number is arithmetically right. This proves it is still
// the number the USER LOOKED AT. A quote refresh, a re-render, or a second tab
// can move the computed amount between the moment it was shown and the moment
// it is signed — and the too-LOW direction is the dangerous one, because a
// floor below what was displayed sells for less than the screen promised.
//
// ⚠️ HOW TO CALL THIS CORRECTLY — the mistake is easy and silent.
//
// `displayedRaw` must be a value CAPTURED WHEN THE USER SAW IT, held across the
// render, e.g. in a ref updated where the number is rendered. It must NOT be
// recomputed at click time.
//
// If you compute the amount at click time and then compare it against an order
// you just built from that same amount, this function compares a value to
// itself: it always returns null and protects nothing. It looks present in the
// diff, it reads correctly, and it can never fire. That is exactly how it was
// first wired in the limit ticket, and this note exists because the original
// wording here ("pass the exact value that was rendered") was not emphatic
// enough about WHERE the value has to come from.
//
// If they disagree at all, refuse: a mismatch means the two halves of the app
// disagree about the price, and that is never resolved by picking one.
// ─────────────────────────────────────────────────────────────────────────────
export function confirmSignableAmount(displayedRaw: bigint, aboutToSignRaw: bigint): string | null {
  if (displayedRaw !== aboutToSignRaw) {
    return 'The price moved while you were signing. Check the new number and try again.'
  }
  return null
}
