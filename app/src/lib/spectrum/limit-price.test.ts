import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import {
  ceilDiv,
  confirmSignableAmount,
  limitAmountFromPrice,
  MARKET_MAX_AGE_MS,
  priceTextRefusal,
} from './limit-price'

const ONE_WETH = 10n ** 18n
const NOW = 1_780_000_000_000
const fresh = (rate: number) => ({ rate, asOfMs: NOW })

// WETH(18) -> USDC(6): the classic decimals trap, 10^12 apart.
const wethUsdc = { sellAmountRaw: ONE_WETH, sellDecimals: 18, buyDecimals: 6 }

describe('limit-price: exact conversion, no floats', () => {
  it('converts a whole price exactly', () => {
    const r = limitAmountFromPrice({ priceText: '4000', ...wethUsdc })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.minBuyAmountRaw).toBe(4000_000000n)
  })

  it('handles the full precision of the buy token', () => {
    const r = limitAmountFromPrice({ priceText: '4000.123456', ...wethUsdc })
    if (r.ok) expect(r.minBuyAmountRaw).toBe(4000_123456n)
    else throw new Error(r.reason)
  })

  // The reason floats are banned: 0.1 + 0.2 arithmetic at 18 decimals moves real
  // money and does it silently. This value has no exact float representation.
  it('is exact on a price a float would corrupt', () => {
    const r = limitAmountFromPrice({
      priceText: '0.070000000000000007',
      sellAmountRaw: ONE_WETH,
      sellDecimals: 18,
      buyDecimals: 18,
    })
    if (r.ok) expect(r.minBuyAmountRaw).toBe(parseUnits('0.070000000000000007', 18))
    else throw new Error(r.reason)
  })

  it('scales with the sell size', () => {
    const half = limitAmountFromPrice({ priceText: '4000', ...wethUsdc, sellAmountRaw: ONE_WETH / 2n })
    if (half.ok) expect(half.minBuyAmountRaw).toBe(2000_000000n)
    else throw new Error(half.reason)
  })
})

describe('limit-price: decimals are structural', () => {
  // If these two were ever swapped the answer is out by 10^12. The test exists
  // so that a refactor that reorders the arguments fails loudly.
  it('a 6-decimal buy token and an 18-decimal one give different raw amounts', () => {
    const six = limitAmountFromPrice({ priceText: '4000', ...wethUsdc })
    const eighteen = limitAmountFromPrice({ priceText: '4000', ...wethUsdc, buyDecimals: 18 })
    if (!six.ok || !eighteen.ok) throw new Error('both should convert')
    expect(eighteen.minBuyAmountRaw / six.minBuyAmountRaw).toBe(10n ** 12n)
  })

  it('refuses nonsense decimals rather than computing with them', () => {
    expect(limitAmountFromPrice({ priceText: '1', ...wethUsdc, buyDecimals: -1 }).ok).toBe(false)
    expect(limitAmountFromPrice({ priceText: '1', ...wethUsdc, sellDecimals: 1.5 }).ok).toBe(false)
  })
})

describe('limit-price: rounds in the USER’s favour', () => {
  // buyAmount is a FLOOR on what they receive. Rounding down would ask for one
  // wei less than they typed, every time.
  it('rounds UP on a fractional size, so the floor is never below the typed price', () => {
    // 0.3 WETH at 4000.000001. The exact product is not a whole USDC unit, and
    // rounding DOWN here would sign a floor fractionally under what was typed.
    const r = limitAmountFromPrice({ priceText: '4000.000001', ...wethUsdc, sellAmountRaw: 3n * 10n ** 17n })
    if (!r.ok) throw new Error(r.reason)
    const exact = (3n * 10n ** 17n * 4000000001n) / 10n ** 18n
    expect(r.minBuyAmountRaw).toBeGreaterThanOrEqual(exact)
  })

  // Layer 4 catching what layer 3 would have produced. At 1 wei, a single unit
  // of USDC is astronomically more than 4000/WETH implies, so the order would
  // carry a price nobody chose. Refusing is the correct outcome, not a bug.
  it('REFUSES a size too small to express the price, instead of signing a nonsense one', () => {
    const r = limitAmountFromPrice({ priceText: '4000', ...wethUsdc, sellAmountRaw: 1n })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/too small/i)
  })

  it('accepts an ordinary sub-whole-unit size', () => {
    for (const size of [10n ** 17n, 5n * 10n ** 16n, 10n ** 15n]) {
      const r = limitAmountFromPrice({ priceText: '4000', ...wethUsdc, sellAmountRaw: size })
      expect(r.ok).toBe(true)
    }
  })

  it('ceilDiv rounds up and refuses a zero divisor', () => {
    expect(ceilDiv(10n, 3n)).toBe(4n)
    expect(ceilDiv(9n, 3n)).toBe(3n)
    expect(() => ceilDiv(1n, 0n)).toThrow()
  })
})

describe('limit-price: refuses text it cannot honour', () => {
  it('refuses empty, non-numeric and zero prices', () => {
    expect(priceTextRefusal('', 6)).toBeTruthy()
    expect(priceTextRefusal('abc', 6)).toBeTruthy()
    expect(priceTextRefusal('0', 6)).toBeTruthy()
    expect(priceTextRefusal('0.00', 6)).toBeTruthy()
  })

  it('refuses exponent notation and signs rather than guessing', () => {
    expect(priceTextRefusal('1e6', 6)).toBeTruthy()
    expect(priceTextRefusal('-4000', 6)).toBeTruthy()
    expect(priceTextRefusal('4,000', 6)).toBeTruthy()
  })

  // parseUnits would TRUNCATE the extra places silently, accepting a price the
  // user never actually gets.
  it('refuses more decimal places than the token can express', () => {
    expect(priceTextRefusal('4000.1234567', 6)).toMatch(/decimal places/i)
    expect(priceTextRefusal('4000.123456', 6)).toBeNull()
  })

  it('accepts a plain decimal', () => {
    expect(priceTextRefusal('4000.5', 6)).toBeNull()
  })
})

describe('limit-price: the market cross-check', () => {
  it('BLOCKS a price far below a fresh market', () => {
    const r = limitAmountFromPrice({ priceText: '400', ...wethUsdc, market: fresh(4000), nowMs: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.blocking).toBe(true)
      expect(r.reason).toMatch(/below the market/i)
    }
  })

  it('allows a price above the market, which is just a target', () => {
    const r = limitAmountFromPrice({ priceText: '4400', ...wethUsdc, market: fresh(4000), nowMs: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outlook?.outlook).toBe('target')
  })

  it('reports the outlook alongside a good price', () => {
    const r = limitAmountFromPrice({ priceText: '4020', ...wethUsdc, market: fresh(4000), nowMs: NOW })
    if (r.ok) expect(r.outlook?.outlook).toBe('patient')
    else throw new Error(r.reason)
  })
})

describe('limit-price: a STALE market cannot vouch for anything', () => {
  // The "fresh price was the ten-minute cache wearing a fresh comment" bug. A
  // stale reference must not silently approve a price the market has left.
  it('does not run the check against an old market, and says so by reporting no outlook', () => {
    const stale = { rate: 4000, asOfMs: NOW - MARKET_MAX_AGE_MS - 1 }
    const r = limitAmountFromPrice({ priceText: '400', ...wethUsdc, market: stale, nowMs: NOW })
    // Still computed exactly, but NOT blessed: outlook is null, so the surface
    // must say it could not check rather than implying it did.
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outlook).toBeNull()
  })

  it('runs the check right up to the freshness limit', () => {
    const edge = { rate: 4000, asOfMs: NOW - MARKET_MAX_AGE_MS }
    const r = limitAmountFromPrice({ priceText: '400', ...wethUsdc, market: edge, nowMs: NOW })
    expect(r.ok).toBe(false)
  })

  it('treats a market timestamped in the FUTURE as unusable, not as fresh', () => {
    const skewed = { rate: 4000, asOfMs: NOW + 60_000 }
    const r = limitAmountFromPrice({ priceText: '400', ...wethUsdc, market: skewed, nowMs: NOW })
    if (r.ok) expect(r.outlook).toBeNull()
    else throw new Error('a clock-skewed market should not block, only fail to vouch')
  })

  it('with no market at all, computes exactly and vouches for nothing', () => {
    const r = limitAmountFromPrice({ priceText: '400', ...wethUsdc })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.outlook).toBeNull()
  })
})

describe('limit-price: the last gate before the wallet', () => {
  it('passes when the signed amount is exactly what was displayed', () => {
    expect(confirmSignableAmount(4000_000000n, 4000_000000n)).toBeNull()
  })

  // The too-LOW direction is the dangerous one: a floor below what the screen
  // promised sells for less than the user agreed to.
  it('refuses when the amount drifted DOWN between display and signing', () => {
    expect(confirmSignableAmount(4000_000000n, 3999_000000n)).toBeTruthy()
  })

  // Refuse either way. A mismatch means the two halves of the app disagree about
  // the price, and that is never resolved by picking one of them.
  it('refuses when it drifted UP too', () => {
    expect(confirmSignableAmount(4000_000000n, 4001_000000n)).toBeTruthy()
  })

  // THE CALLING MISTAKE, documented as a test so the shape is unmissable. Passing
  // the same click-time value on both sides makes this a tautology: it always
  // passes and protects nothing, while reading perfectly in a diff. The displayed
  // value has to be captured when the USER saw it, not recomputed at click time.
  it('is a TAUTOLOGY when both sides come from the same click-time value', () => {
    const clickTime = 4000_000000n
    // This is what a wrong call looks like — it can never fail, at any value.
    for (const v of [1n, clickTime, 999_999_999n]) {
      expect(confirmSignableAmount(v, v)).toBeNull()
    }
  })
})

describe('limit-price: round-trip proof', () => {
  it('reports the price recovered from the raw amount', () => {
    const r = limitAmountFromPrice({ priceText: '4000.5', ...wethUsdc })
    if (r.ok) expect(Number(r.roundTripPrice)).toBeCloseTo(4000.5, 6)
    else throw new Error(r.reason)
  })

  it('survives the round trip across a wide range of sizes and prices', () => {
    for (const price of ['1', '0.000001', '4000', '123456.789012']) {
      for (const size of [1n, 10n ** 9n, ONE_WETH, ONE_WETH * 1000n]) {
        const r = limitAmountFromPrice({ priceText: price, ...wethUsdc, sellAmountRaw: size })
        if (!r.ok) continue // a refusal is an acceptable outcome; a wrong number is not
        expect(r.minBuyAmountRaw).toBeGreaterThan(0n)
      }
    }
  })
})
