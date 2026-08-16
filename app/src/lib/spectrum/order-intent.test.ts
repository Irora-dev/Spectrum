import { describe, expect, it } from 'vitest'
import {
  fillFraction,
  fillProgressLine,
  markerPosition,
  readOutlook,
  GIVEAWAY_PCT,
  PATIENT_MAX_PCT,
  TARGET_MAX_PCT,
} from './order-intent'

describe('order-intent: the three outcomes of one mechanism', () => {
  it('reads a price AT the market as filling now', () => {
    expect(readOutlook(4000, 4000)?.outlook).toBe('immediate')
    // 3960 is -1%, inside normal fill tolerance. (This assertion used to read
    // 3900, i.e. -2.5%, which is now correctly called a `discount` — the old
    // value encoded the pre-guard assumption that anything under the market was
    // simply "fills now", which is exactly the blind spot the guard closes.)
    expect(readOutlook(4000, 3960)?.outlook).toBe('immediate')
  })

  it('reads a price just above the market as working in pieces', () => {
    const r = readOutlook(4000, 4020) // +0.5%
    expect(r?.outlook).toBe('patient')
    expect(r?.line).toMatch(/in pieces/i)
  })

  it('reads a price meaningfully above the market as a target', () => {
    const r = readOutlook(4000, 4400) // +10%
    expect(r?.outlook).toBe('target')
  })

  it('reads a far-off price as unlikely', () => {
    expect(readOutlook(4000, 8000)?.outlook).toBe('far')
  })

  it('puts the boundaries exactly where the constants say', () => {
    expect(readOutlook(100, 100 + PATIENT_MAX_PCT)?.outlook).toBe('patient')
    expect(readOutlook(100, 100 + PATIENT_MAX_PCT + 0.01)?.outlook).toBe('target')
    expect(readOutlook(100, 100 + TARGET_MAX_PCT)?.outlook).toBe('target')
    expect(readOutlook(100, 100 + TARGET_MAX_PCT + 0.01)?.outlook).toBe('far')
  })

  it('computes how far away the price is', () => {
    expect(readOutlook(4000, 4400)?.awayPct).toBeCloseTo(10, 6)
  })
})

// THE DANGEROUS DIRECTION. Everything above the market costs the user TIME (an
// order that never fills). A sell price BELOW the market costs them MONEY, the
// moment a solver takes it, irreversibly. A mistyped decimal is the single most
// likely mistake on this surface, so it must not merely warn.
describe('order-intent: a sell price BELOW the market', () => {
  it('BLOCKS a price far below the market instead of calling it a quick fill', () => {
    const r = readOutlook(4000, 400) // a dropped decimal
    expect(r?.outlook).toBe('giveaway')
    expect(r?.blocking).toBe(true)
    expect(r?.severity).toBe('danger')
    expect(r?.line).toMatch(/decimal/i)
  })

  it('never tells someone a giveaway price is fine', () => {
    const r = readOutlook(4000, 400)
    expect(r?.line).not.toMatch(/straight away|at the market/i)
    expect(r?.label).not.toMatch(/fills now/i)
  })

  it('names the haircut on a real but sub-market price, without blocking it', () => {
    const r = readOutlook(4000, 3800) // -5%
    expect(r?.outlook).toBe('discount')
    expect(r?.blocking).toBe(false)
    expect(r?.severity).toBe('caution')
    expect(r?.line).toMatch(/below the market/i)
  })

  it('treats normal fill tolerance as ordinary', () => {
    const r = readOutlook(4000, 3960) // -1%, inside tolerance
    expect(r?.outlook).toBe('immediate')
    expect(r?.blocking).toBe(false)
  })

  it('puts the block boundary exactly where the constant says', () => {
    expect(readOutlook(100, 100 - GIVEAWAY_PCT)?.blocking).toBe(false)
    expect(readOutlook(100, 100 - GIVEAWAY_PCT - 0.01)?.blocking).toBe(true)
  })

  // Nothing on the safe side of the market may ever block, or a legitimate price
  // target becomes unusable.
  it('never blocks anything at or above the market', () => {
    for (const p of [4000, 4001, 4400, 9000, 100000]) {
      expect(readOutlook(4000, p)?.blocking).toBe(false)
    }
  })
})

describe('order-intent: honesty rules the copy must never break', () => {
  const all = [readOutlook(4000, 400), readOutlook(4000, 3800), readOutlook(4000, 4000), readOutlook(4000, 4020), readOutlook(4000, 4400), readOutlook(4000, 9000)]

  // The whole point of this module. A clock implies a schedule we do not have.
  it('never implies a schedule or a time-slicing mechanism', () => {
    for (const r of all) {
      expect(r).not.toBeNull()
      expect(r!.line).not.toMatch(/twap|over time|schedule|every \d|per hour|per day|slice/i)
    }
  })

  // Screening law: spreading a fill is a mechanism, "better" is a promise.
  it('never promises a better price or a guaranteed outcome', () => {
    for (const r of all) {
      expect(r!.line).not.toMatch(/better price|guarantee|will fill|best price|save you/i)
    }
  })

  it('states the failure mode wherever the order might not complete', () => {
    expect(readOutlook(4000, 4400)!.line).toMatch(/expire/i)
    expect(readOutlook(4000, 9000)!.line).toMatch(/expire/i)
  })

  it('has no em dashes in any shown line', () => {
    for (const r of all) expect(r!.line).not.toMatch(/—/)
  })
})

describe('order-intent: a missing market is not a verdict', () => {
  it('returns null rather than guessing, so the UI can say it could not read the market', () => {
    expect(readOutlook(0, 4000)).toBeNull()
    expect(readOutlook(4000, 0)).toBeNull()
    expect(readOutlook(Number.NaN, 4000)).toBeNull()
    expect(readOutlook(4000, Number.POSITIVE_INFINITY)).toBeNull()
    expect(readOutlook(-1, 4000)).toBeNull()
  })
})

describe('order-intent: the marker never leaves its track', () => {
  it('centres at the market', () => {
    expect(markerPosition(0)).toBeCloseTo(0.5, 6)
  })

  it('moves right as the ask rises', () => {
    expect(markerPosition(10)).toBeGreaterThan(0.5)
    expect(markerPosition(-10)).toBeLessThan(0.5)
  })

  // A marker outside its own box is the clipping class of bug. Clamp, and let
  // the stated percentage carry the truth.
  it('clamps rather than running off the end', () => {
    expect(markerPosition(10_000)).toBe(1)
    expect(markerPosition(-10_000)).toBe(0)
  })

  it('survives nonsense input', () => {
    expect(markerPosition(Number.NaN)).toBe(0.5)
    expect(markerPosition(10, 0)).toBe(0.5)
  })
})

describe('order-intent: fill fraction', () => {
  it('reports partial progress with real precision', () => {
    expect(fillFraction(3_200000000000000000n, 10_000000000000000000n)).toBeCloseTo(0.32, 4)
  })

  it('handles a one-third fill without truncating to zero', () => {
    // The bigint trap: Number(a/b) would be 0 here.
    expect(fillFraction(1n, 3n)).toBeCloseTo(0.3333, 3)
  })

  it('is 0 for an untouched order and 1 for a complete one', () => {
    expect(fillFraction(0n, 10n)).toBe(0)
    expect(fillFraction(10n, 10n)).toBe(1)
  })

  // Solvers may beat the limit, so executed can exceed the signed amount. A bar
  // past 100% reads as a bug rather than as good news.
  it('caps a surplus fill at 1 instead of overflowing the bar', () => {
    expect(fillFraction(11n, 10n)).toBe(1)
  })

  it('never divides by zero', () => {
    expect(fillFraction(5n, 0n)).toBe(0)
  })
})

describe('order-intent: the live sentence', () => {
  it('says nothing has filled without implying failure', () => {
    expect(fillProgressLine(0, false)).toMatch(/waiting/i)
  })

  it('reports pieces, never an ETA', () => {
    const s = fillProgressLine(0.4, false)
    expect(s).toMatch(/40%/)
    expect(s).toMatch(/pieces/i)
    expect(s).not.toMatch(/soon|eta|minutes|expected by/i)
  })

  // An unfilled expiry did exactly what was asked. It must never read as an error.
  it('frames an unfilled expiry as the order honouring the instruction', () => {
    const s = fillProgressLine(0, true)
    expect(s).toMatch(/never reached/i)
    expect(s).not.toMatch(/fail|error|problem|went wrong/i)
  })

  it('reports a partial expiry with the amount that did happen', () => {
    expect(fillProgressLine(0.6, true)).toMatch(/60%/)
  })

  it('reports completion', () => {
    expect(fillProgressLine(1, false)).toMatch(/completely/i)
  })
})
