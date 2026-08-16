import { describe, expect, it } from 'vitest'
import { boundedBuyIn, PROCEEDS_HEADROOM_BPS } from './use-swap-migrate'

// ─────────────────────────────────────────────────────────────────────────────
// THE HAND-OFF LAW (use-swap-migrate.ts): the swap-route migration's buy
// spends the sale's MEASURED settlement delta, bounded by the quote's expected
// output plus a small positive-slippage headroom. The bound is the consent
// line — "buy $NEW with the proceeds" must never quietly sweep money the sale
// did not produce (an unrelated inbound transfer landing between the two
// balance reads). These pins hold both directions of the bound.
// ─────────────────────────────────────────────────────────────────────────────

describe('boundedBuyIn — the measured-proceeds consent bound', () => {
  const EXPECTED = 1_000_000_000n // $1,000 in 6dp settlement

  it('a delta at or under the expectation passes through untouched (the normal fill)', () => {
    expect(boundedBuyIn(999_000_000n, EXPECTED)).toBe(999_000_000n)
    expect(boundedBuyIn(EXPECTED, EXPECTED)).toBe(EXPECTED)
  })

  it('positive slippage inside the headroom is real proceeds and rides whole', () => {
    const cap = EXPECTED + (EXPECTED * PROCEEDS_HEADROOM_BPS) / 10_000n
    expect(boundedBuyIn(cap, EXPECTED)).toBe(cap) // exactly at the cap is accepted
    expect(boundedBuyIn(cap - 1n, EXPECTED)).toBe(cap - 1n)
  })

  it('a delta past the headroom is NOT attributed to the sale — the buy is capped, the excess stays untouched', () => {
    // the class: an unrelated $500 inbound lands between the two balance reads
    const cap = EXPECTED + (EXPECTED * PROCEEDS_HEADROOM_BPS) / 10_000n
    expect(boundedBuyIn(EXPECTED + 500_000_000n, EXPECTED)).toBe(cap)
  })

  it('zero and negative deltas spend nothing — a sale that measured no proceeds must not buy', () => {
    expect(boundedBuyIn(0n, EXPECTED)).toBe(0n)
    expect(boundedBuyIn(-5n, EXPECTED)).toBe(0n)
  })

  it('a zero expectation caps everything to zero — no quote, no consent, no spend', () => {
    expect(boundedBuyIn(123n, 0n)).toBe(0n)
  })
})
