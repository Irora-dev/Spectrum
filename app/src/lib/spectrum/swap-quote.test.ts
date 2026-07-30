import { describe, expect, it } from 'vitest'
import { buildSwapQuote, toRaw, DEFAULT_MAX_PRICE_AGE_MS, type SwapQuoteInput } from './swap-quote'

// Two legs of DIFFERENT decimals (18 and 6) to prove decimals-correctness.
const HOLDINGS = [
  { symbol: 'AAA', decimals: 18, targetWeightPct: 50, priceUsd: 2 },
  { symbol: 'BBB', decimals: 6, targetWeightPct: 50, priceUsd: 1 },
]

function base(overrides: Partial<SwapQuoteInput> = {}): SwapQuoteInput {
  return {
    side: 'buy',
    amount: 1000,
    navPerToken: 1,
    feeFrac: 0.01,
    slippageBps: 100, // 1%
    holdings: HOLDINGS,
    basketDecimals: 18,
    ...overrides,
  }
}

describe('toRaw', () => {
  it('scales to the token decimals (no clamp to 18 on the integer scale)', () => {
    expect(toRaw(250, 18)).toBe(250n * 10n ** 18n)
    expect(toRaw(500, 6)).toBe(500n * 10n ** 6n)
  })
  it('clamps fractional precision so a high-precision float never throws', () => {
    // parseUnits throws on >decimals fractional digits; toRaw floors them via toFixed first.
    const r = toRaw(1.123456789012345678901, 18)
    expect(r).toBeGreaterThan(0n)
    expect(r).toBeLessThan(2n * 10n ** 18n)
  })
  it('returns 0n on non-finite / non-positive input', () => {
    expect(toRaw(0, 18)).toBe(0n)
    expect(toRaw(-1, 18)).toBe(0n)
    expect(toRaw(Number.NaN, 18)).toBe(0n)
    expect(toRaw(Number.POSITIVE_INFINITY, 18)).toBe(0n)
  })
})

describe('buildSwapQuote — happy paths', () => {
  it('BUY: decimals-correct, basket-ordered legs + correct floors', () => {
    const q = buildSwapQuote(base())
    expect(q).not.toBeNull()
    // usdNet = 1000×(1−1%) = 990. leg A: 50%×990 = 495 USD / $2 = 247.5 tokens @18dec
    expect(q!.quotedLegAmounts[0]).toBe(247_500_000_000_000_000_000n)
    // leg B: 495 USD / $1 = 495 tokens @6dec (NOT 18 — no clamp)
    expect(q!.quotedLegAmounts[1]).toBe(495_000_000n)
    // legMin = quoted × (1 − 1%) = ×9900/10000
    expect(q!.legs[0].min).toBe(245_025_000_000_000_000_000n)
    expect(q!.legs[1].min).toBe(490_050_000n)
    // legs preserve on-chain basket order + symbols
    expect(q!.legs.map((l) => l.symbol)).toEqual(['AAA', 'BBB'])
    expect(q!.legCount).toBe(2)
    // tokenIn = USDC@6
    expect(q!.amountRaw).toBe(1000n * 10n ** 6n)
    // out = 1000×(1−1%)/nav(1) = 990 shares; minOut = 990×(1−1%) ≈ 980.1 @ 18dec
    // (range: float→toFixed(18) carries sub-wei noise the 18-dec scale preserves)
    expect(q!.minOutRaw).toBeGreaterThan(980_000_000_000_000_000_000n)
    expect(q!.minOutRaw).toBeLessThan(980_200_000_000_000_000_000n)
  })

  it('SELL: aggregate-minOut protected — NO per-leg floors, shares@18 in, USDC@6 out', () => {
    const q = buildSwapQuote(base({ side: 'sell', amount: 10, navPerToken: 2 }))
    expect(q).not.toBeNull()
    // sells protect via the aggregate USDC minOut, not per-leg floors
    expect(q!.quotedLegAmounts).toEqual([])
    expect(q!.legs).toEqual([])
    expect(q!.legCount).toBe(2) // still the on-chain leg count (the redeem encoder zero-fills it)
    // amountRaw = 10 shares @ 18dec
    expect(q!.amountRaw).toBe(10n * 10n ** 18n)
    // out = 10 × 2 × (1−1%) = 19.8 USDC; minOut = 19.8 × 0.99 ≈ 19.602 @ 6dec
    expect(q!.minOutRaw).toBeGreaterThan(19_600_000n)
    expect(q!.minOutRaw).toBeLessThan(19_604_000n)
  })

  it('SELL does not depend on per-leg prices (works even if a leg is unpriced)', () => {
    const holdings = [HOLDINGS[0], { ...HOLDINGS[1], priceUsd: 0 }]
    const q = buildSwapQuote(base({ side: 'sell', amount: 10, navPerToken: 2, holdings }))
    expect(q).not.toBeNull()
    expect(q!.minOutRaw).toBeGreaterThan(0n)
  })
})

describe('buildSwapQuote — no silent zero / refusal paths', () => {
  it('returns null when any leg is unpriced (never fabricates a quote)', () => {
    const holdings = [HOLDINGS[0], { ...HOLDINGS[1], priceUsd: 0 }]
    expect(buildSwapQuote(base({ holdings }))).toBeNull()
  })
  it('returns null on a non-positive / non-finite amount or nav', () => {
    expect(buildSwapQuote(base({ amount: 0 }))).toBeNull()
    expect(buildSwapQuote(base({ navPerToken: 0 }))).toBeNull()
    expect(buildSwapQuote(base({ feeFrac: Number.NaN }))).toBeNull()
  })
  it('returns null on empty holdings', () => {
    expect(buildSwapQuote(base({ holdings: [] }))).toBeNull()
  })
  it('returns null when a tiny amount rounds a leg/amount to zero', () => {
    // 1e-9 USDC over two legs → each leg rounds to 0 raw → refused
    expect(buildSwapQuote(base({ amount: 0.000000001 }))).toBeNull()
  })
})

describe('buildSwapQuote — stale bound', () => {
  it('refuses a quote older than the bound', () => {
    expect(buildSwapQuote(base({ priceAgeMs: 90_000, maxPriceAgeMs: 60_000 }))).toBeNull()
  })
  it('accepts a quote within the bound', () => {
    expect(buildSwapQuote(base({ priceAgeMs: 30_000, maxPriceAgeMs: 60_000 }))).not.toBeNull()
  })
  it('uses the default bound when none is supplied', () => {
    expect(buildSwapQuote(base({ priceAgeMs: DEFAULT_MAX_PRICE_AGE_MS + 1 }))).toBeNull()
    expect(buildSwapQuote(base({ priceAgeMs: DEFAULT_MAX_PRICE_AGE_MS - 1 }))).not.toBeNull()
  })
})

// ── the SELL floor basis (the "cannot sell" regression) ──────────────────────
// navPerToken (exchangeRate()) is FRICTIONLESS: it charges nothing for the per-leg
// asset→ETH swaps or the hub ETH→settlement swap. Deriving the floor from it made
// realised proceeds fall short and every non-trivial sell revert SlippageExceeded.
// When a simulated realised output is supplied it MUST become the basis.
describe('buildSwapQuote — sell floor basis', () => {
  const sellBase = (o: Partial<SwapQuoteInput> = {}) =>
    base({ side: 'sell', amount: 10, navPerToken: 2, feeFrac: 0.01, slippageBps: 300, ...o })

  it('haircuts the SIMULATED realised output when given, not NAV', () => {
    // NAV would imply 10 × 2 × 0.99 = 19.8 USDC; the chain will really pay 15.
    const realised = 15_000_000n // 15 USDC @6dp
    const q = buildSwapQuote(sellBase({ realisedOutRaw: realised }))!
    expect(q.basis).toBe('simulated')
    expect(q.expectedOutRaw).toBe(realised)
    // floor = realised × (1 − 3%), exact bigint math (no float drift above the payable amount)
    expect(q.minOutRaw).toBe((realised * 9_700n) / 10_000n)
    // and it must sit BELOW what the chain pays — the whole point
    expect(q.minOutRaw).toBeLessThan(realised)
  })

  it('degrades to the NAV estimate when no simulation is available', () => {
    const q = buildSwapQuote(sellBase())!
    expect(q.basis).toBe('nav')
    expect(q.expectedOutRaw).toBe(toRaw(10 * 2 * 0.99, 6))
  })

  it('a NAV-derived floor can exceed the realised output (the bug being fixed)', () => {
    const realised = 15_000_000n
    const navQuote = buildSwapQuote(sellBase())!
    // This is exactly the failure: the NAV floor is above what the sell returns,
    // so the basket reverts SlippageExceeded before paying out.
    expect(navQuote.minOutRaw).toBeGreaterThan(realised)
    const simQuote = buildSwapQuote(sellBase({ realisedOutRaw: realised }))!
    expect(simQuote.minOutRaw).toBeLessThan(realised)
  })

  it('a BUY also haircuts the SIMULATED shares (buys reverted at every size on NAV)', () => {
    // frictionless would be 1000 x 0.99 / 1 = 990 shares; the chain really mints 800.
    const realised = 800n * 10n ** 18n
    const q = buildSwapQuote(base({ side: 'buy', slippageBps: 300, realisedOutRaw: realised }))!
    expect(q.basis).toBe('simulated')
    expect(q.expectedOutRaw).toBe(realised)
    expect(q.minOutRaw).toBe((realised * 9_700n) / 10_000n)
    expect(q.minOutRaw).toBeLessThan(realised)
  })

  it('a BUY deflates the per-leg floors by the MEASURED survival ratio', () => {
    // The encoder re-derives legMins from quotedLegAmounts, so the deflation must be
    // visible THERE or the broadcast would still ship frictionless floors.
    const frictionless = buildSwapQuote(base({ side: 'buy', slippageBps: 300 }))!
    const realised = 800n * 10n ** 18n // ~80.8% of the frictionless 990 shares
    const simulated = buildSwapQuote(base({ side: 'buy', slippageBps: 300, realisedOutRaw: realised }))!
    for (let i = 0; i < frictionless.quotedLegAmounts.length; i++) {
      expect(simulated.quotedLegAmounts[i]).toBeLessThan(frictionless.quotedLegAmounts[i])
      expect(simulated.quotedLegAmounts[i]).toBeGreaterThan(0n) // never a zero floor
      expect(simulated.legs[i].min).toBeLessThan(frictionless.legs[i].min)
    }
  })

  it('a better-than-expected fill never TIGHTENS the per-leg floors above the quote', () => {
    const frictionless = buildSwapQuote(base({ side: 'buy', slippageBps: 300 }))!
    const generous = buildSwapQuote(
      base({ side: 'buy', slippageBps: 300, realisedOutRaw: 5_000n * 10n ** 18n }),
    )!
    // survival ratio is capped at 1x
    expect(generous.quotedLegAmounts).toEqual(frictionless.quotedLegAmounts)
  })

  it('refuses (null) when the realised fill is so small a leg floor rounds to zero', () => {
    // 123 wei of shares vs a ~990e18 expectation ⇒ deflated legs round to 0 ⇒ the
    // never-a-zero-floor invariant must win over emitting an unprotected quote.
    expect(buildSwapQuote(base({ side: 'buy', realisedOutRaw: 123n }))).toBeNull()
  })

  it('refuses a zero/negative realised output rather than emitting a zero floor', () => {
    // 0n is treated as "unpriced" ⇒ falls back to NAV, never a zero floor.
    const q = buildSwapQuote(sellBase({ realisedOutRaw: 0n }))!
    expect(q.basis).toBe('nav')
    expect(q.minOutRaw).toBeGreaterThan(0n)
  })
})
