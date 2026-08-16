import { describe, expect, it } from 'vitest'
import { shownFloorMismatch, type ShownFloor } from './shown-floor'

// ─────────────────────────────────────────────────────────────────────────────
// The gate has to fire on ONE case and stay silent on three, and every one of
// the silent three would, if collapsed into a comparison, refuse trades that are
// working today. So each exclusion gets a test that FAILS if someone "hardens"
// it — the tests are the reason the exclusions cannot be tidied away by a reader
// who sees three early returns and assumes they are timidity.
// ─────────────────────────────────────────────────────────────────────────────

const BASKET = '0x000000000000000000000000000000000000BA5E'
const shown = (over: Partial<ShownFloor> = {}): ShownFloor => ({
  minOutRaw: 1_000_000n,
  quotedInRaw: 500_000_000n,
  floorBasis: 'simulated',
  basket: BASKET,
  chainId: 8453,
  direction: 'buy',
  ...over,
})

describe('shownFloorMismatch — the promise it keeps', () => {
  it('SIGNS when the signed floor is exactly the painted one', () => {
    expect(shownFloorMismatch(shown(), 500_000_000n, 1_000_000n)).toBeNull()
  })

  it('REFUSES when the signed floor is BELOW the painted one — the whole point', () => {
    // the dangerous direction: the screen promised 1.000000, the signature
    // carries 0.999999, and the difference is the user's money
    const msg = shownFloorMismatch(shown(), 500_000_000n, 999_999n)
    expect(msg).toBeTruthy()
    expect(msg).toMatch(/price moved/i)
  })

  it('REFUSES when it is above too — a disagreement is never resolved by picking a side', () => {
    expect(shownFloorMismatch(shown(), 500_000_000n, 1_000_001n)).toBeTruthy()
  })

  it('refuses on a ONE-UNIT divergence, so nothing rounds its way past', () => {
    expect(shownFloorMismatch(shown({ minOutRaw: 2n }), 500_000_000n, 1n)).toBeTruthy()
  })
})

describe('shownFloorMismatch — the three cases that are not a broken promise', () => {
  it('1 · a minimum that was NEVER PAINTED promised nothing, so there is nothing to keep', () => {
    // ⚠️ this must stay null, not become a refusal: the fold ships CLOSED, so
    // this is the common path and refusing here blocks ordinary trades
    expect(shownFloorMismatch(null, 500_000_000n, 999_999n)).toBeNull()
    expect(shownFloorMismatch(undefined, 500_000_000n, 999_999n)).toBeNull()
  })

  it('1b · but a minimum PAINTED THEN HIDDEN is still a promise — the cold-pass finding', () => {
    // read the minimum, collapse the fold, swap. The claim reaching this
    // function at all is DexSwapCard's job (it holds it per quote, not per
    // fold); what this pins is that once it arrives, hiding is irrelevant —
    // there is no "was it still visible" input here, and there must not be
    expect(shownFloorMismatch(shown(), 500_000_000n, 900_000n)).toBeTruthy()
  })

  it('2 · a NAV floor is disclosed as an estimate, and is deliberately signed LOWER', () => {
    expect(shownFloorMismatch(shown({ floorBasis: 'nav' }), 500_000_000n, 1n)).toBeNull()
  })

  it('3 · a CHANGED input means the painted floor was for a different trade', () => {
    // multi-hop: the USDC reaching the basket leg is measured from the hub
    // swap's receipt, so it differs from the quote and the floor is rebuilt
    expect(shownFloorMismatch(shown(), 499_812_004n, 987_654n)).toBeNull()
  })

  it('3b · but the SAME input re-arms it — the exclusion is the input, not the route', () => {
    // the same trade as above with the hop delivering exactly what was quoted:
    // the floor is comparable again, so a divergence is a divergence
    expect(shownFloorMismatch(shown(), 500_000_000n, 987_654n)).toBeTruthy()
  })
})

describe('shownFloorMismatch — the exclusions are checked in the right order', () => {
  it('a NAV floor on a changed input is still silent, not double-counted', () => {
    expect(shownFloorMismatch(shown({ floorBasis: 'nav' }), 1n, 2n)).toBeNull()
  })

  it('a zero painted floor is still a claim, and a non-zero signature still breaks it', () => {
    // 0n is falsy — this pins that the gate reads the FIELD rather than the
    // truthiness of the amount, the coercion trap that recurs in this codebase
    expect(shownFloorMismatch(shown({ minOutRaw: 0n }), 500_000_000n, 5n)).toBeTruthy()
    expect(shownFloorMismatch(shown({ minOutRaw: 0n }), 500_000_000n, 0n)).toBeNull()
  })

  it('a zero input is compared as a value, not skipped for being falsy', () => {
    expect(shownFloorMismatch(shown({ quotedInRaw: 0n }), 0n, 999_999n)).toBeTruthy()
    expect(shownFloorMismatch(shown({ quotedInRaw: 0n }), 1n, 999_999n)).toBeNull()
  })
})

describe('a claim belongs to ONE trade', () => {
  const about = { basket: BASKET, chainId: 8453, direction: 'buy' as const }

  it('is used when it is about this trade', () => {
    expect(shownFloorMismatch(shown(), 500_000_000n, 1_000_000n, about)).toBeNull()
  })

  it('is REFUSED when it belongs to another basket — switching does not remount the card', () => {
    // the window: a previously-viewed basket returns from cache instantly while
    // the quote is still debouncing, so the claim, the painted number and the
    // trade being priced are briefly three different baskets
    const other = shown({ basket: '0x000000000000000000000000000000000000DEAD' })
    expect(shownFloorMismatch(other, 500_000_000n, 1_000_000n, about)).toMatch(/screen changed/i)
  })

  it('is REFUSED across a chain change and across a direction flip', () => {
    expect(shownFloorMismatch(shown({ chainId: 1 }), 500_000_000n, 1_000_000n, about)).toBeTruthy()
    expect(shownFloorMismatch(shown({ direction: 'sell' }), 500_000_000n, 1_000_000n, about)).toBeTruthy()
  })

  it('matches the basket case-insensitively — EIP-55 casing is not identity', () => {
    const lower = shown({ basket: BASKET.toLowerCase() })
    expect(shownFloorMismatch(lower, 500_000_000n, 1_000_000n, about)).toBeNull()
  })

  it('still works when no trade is supplied — the check is additive, not required', () => {
    // callers that cannot name the trade keep the old behaviour rather than
    // silently losing the gate
    expect(shownFloorMismatch(shown(), 500_000_000n, 900_000n)).toBeTruthy()
  })
})
