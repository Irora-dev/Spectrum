import { confirmSignableAmount } from './limit-price'

/**
 * THE SWAP CARD'S HALF OF THE DISPLAYED-VS-SIGNED LAW (audit 2026-08-07, closed
 * 2026-08-07 evening).
 *
 * `confirmSignableAmount` is the comparison; this module decides WHEN the
 * comparison is a law and when it would be a lie. The swap card had the defect
 * that gate exists for — it printed `quote.minOutRaw` under the words "Minimum
 * received" and then signed a floor rebuilt from a FRESH simulation at click
 * time, with nothing between the two. But the naive fix (compare them always)
 * refuses honest trades, and the three cases have to be separated by hand
 * because only one of them is a broken promise.
 */
export interface ShownFloor {
  /** The floor exactly as PAINTED. Captured in an effect where the number is
   *  rendered — never recomputed at click, or the comparison is f(x) === f(x)
   *  and can never fire (the failure that made the limit ticket's first
   *  version a no-op). */
  minOutRaw: bigint
  /** The input that painted floor was quoted FOR. The gate binds only when the
   *  leg about to be signed spends this same number. */
  quotedInRaw: bigint
  /** `'nav'` floors are shown as "Expected minimum" beside copy saying the
   *  signed floor is measured at confirm and can land below — disclosed, not
   *  promised.
   *
   *  Deliberately the real union rather than `string`: a typo'd basis would
   *  otherwise disable the gate silently, and a THIRD basis added later falls
   *  through to being gated, which is the safe direction. */
  floorBasis: 'simulated' | 'nav'
  /** ⚠ WHAT TRADE THIS CLAIM IS ABOUT (adversarial review, 2026-08-08).
   *
   *  Without these the struct is three bare numbers, and a claim painted for
   *  one basket stays armed for the next: switching baskets does not remount
   *  the card, and a previously-viewed basket's data returns from cache
   *  instantly while the quote is still debouncing — so for that window the
   *  claim, the number on screen and the trade being priced are three
   *  different baskets.
   *
   *  It resolved to a REFUSAL rather than a bad signature, so it was a
   *  soundness gap and not a money path — but the gate was armed by a raw
   *  number matching and nothing else, and "it happened to fail safe" is not
   *  the property we want to rely on. A claim now says what it is a claim
   *  ABOUT, and the gate refuses to use one belonging to a different trade. */
  basket: string
  chainId: number
  direction: 'buy' | 'sell'
}

/**
 * `null` = sign. A string = the refusal sentence, in the user's own words.
 *
 * THE THREE CASES THAT ARE *NOT* A BROKEN PROMISE, each for its own reason —
 * every one of these was measured in the code before being excluded, and
 * collapsing any of them into a comparison breaks working trades:
 *
 *  1. `shown == null` — THE MINIMUM WAS NEVER PAINTED. The trade-details fold
 *     ships closed (owner ask 2026-07-05: the rail stays clean until the numbers
 *     are asked for), so on the common path no minimum is ever shown. Nothing
 *     was promised, so there is nothing to keep. ⚠️ DO NOT "harden" this into a
 *     refusal the way the limit ticket refuses on a null ref — there the ticket
 *     is always on screen, so null means something broke; here null is the
 *     DEFAULT and refusing would block every trade whose user never opened the
 *     fold. The on-chain floor still protects them; what is absent is only the
 *     screen's claim about it.
 *
 *     ⚠️⚠️ "NEVER PAINTED" IS NOT "NOT CURRENTLY VISIBLE" — the distinction is
 *     the caller's job and it was wrong in the first version (specallocator's
 *     cold pass, 2026-08-07). Clearing the claim when the fold CLOSES discards a
 *     promise that was made: read the minimum, collapse the fold, swap, and the
 *     gate silently stopped applying. DexSwapCard now holds the claim per QUOTE
 *     rather than per fold, so hiding the number does not unsee it and only a
 *     newer quote retires it.
 *
 *  2. `floorBasis === 'nav'` — the card already tells the truth here. The label
 *     reads "Expected minimum" and the line beneath says the signed floor is
 *     measured at confirm and can land below. A NAV floor ignores the two-hop
 *     acquisition cost, so signing it would revert honest buys; the execute path
 *     deliberately signs LOWER. Disclosed divergence is not a broken promise.
 *
 *  3. `quotedInRaw !== actualInRaw` — THE INPUT ITSELF CHANGED, so the painted
 *     floor was for a different trade. On a multi-hop buy the USDC reaching the
 *     basket leg is MEASURED from the hub swap's own receipt rather than
 *     assumed, so it legitimately differs from the quote and the floor must be
 *     rebuilt for the size actually arriving. Comparing across two different
 *     input sizes would refuse essentially every multi-hop buy. Equality of the
 *     input is what makes the floors comparable at all, and it is checked
 *     rather than inferred from the route, so a new route cannot quietly opt
 *     itself out.
 *
 * WHAT IS LEFT IS EXACTLY THE PROMISE: the minimum was painted, the card said
 * "Minimum received", and the leg about to be signed spends the same input the
 * painted floor was quoted for. If the numbers still differ, the quote moved
 * under the user between reading and confirming — refuse, and let them look at
 * the new one. Never resolve it by picking a side.
 *
 * IT REFUSES IN BOTH DIRECTIONS, INCLUDING WHEN THE FLOOR IMPROVES, and that is
 * deliberate rather than an oversight (raised as a calibration question by
 * specallocator's cold pass, 2026-08-07). The argument for letting a better
 * floor through is real: this card's quote refreshes continuously, so a refresh
 * between paint and click can move the floor either way, and refusing an
 * improvement blocks a trade that got strictly better for the user.
 *
 * We keep it bidirectional anyway, for the reason `confirmSignableAmount`'s own
 * doctrine gives: a divergence here means the two halves of the app disagree
 * about the price, and WHICH WAY it disagreed is not evidence about why. An
 * improvement and a theft are the same signal at this layer — the direction is
 * an output of the same broken assumption, not a reason to trust one of them.
 * A one-way gate would also be strictly harder to reason about later, because
 * it would pass silently in exactly the cases nobody thought to test. The cost
 * is availability on a surface that refreshes often; the user loses a click and
 * sees the better number, rather than signing against a floor the app cannot
 * account for.
 */
export function shownFloorMismatch(
  shown: ShownFloor | null | undefined,
  actualInRaw: bigint,
  aboutToSignRaw: bigint,
  /** The trade about to be signed. A claim for a different one is not evidence
   *  about this one, and using it either way — passing or refusing — would be
   *  reading the wrong screen. */
  about?: { basket: string; chainId: number; direction: 'buy' | 'sell' },
): string | null {
  if (!shown) return null
  if (
    about &&
    (shown.basket.toLowerCase() !== about.basket.toLowerCase() ||
      shown.chainId !== about.chainId ||
      shown.direction !== about.direction)
  )
    return 'The screen changed while you were confirming. Check the amounts and try again.'
  if (shown.floorBasis === 'nav') return null
  if (shown.quotedInRaw !== actualInRaw) return null
  return confirmSignableAmount(shown.minOutRaw, aboutToSignRaw)
}
