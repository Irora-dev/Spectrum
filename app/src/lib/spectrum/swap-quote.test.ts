import { describe, expect, it } from 'vitest'
import { buildSwapQuote, toRaw, DEFAULT_MAX_PRICE_AGE_MS, type QuoteLeg, type SwapQuoteInput } from './swap-quote'

// Two legs of DIFFERENT decimals (18 and 6) to prove decimals-correctness.
const HOLDINGS = [
  { symbol: 'AAA', decimals: 18, targetWeightPct: 50, priceUsd: 2 },
  { symbol: 'BBB', decimals: 6, targetWeightPct: 50, priceUsd: 1 },
]

function base(overrides: Partial<SwapQuoteInput> = {}): SwapQuoteInput {
  return {
    side: 'buy',
    settlementDecimals: 6,
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

// The bound works when it is FED, and nothing feeds it: `priceAgeMs` is opt-in and
// no production caller supplies one (audit 2026-08-06 — swap-quote.ts's header says
// why none honestly can). Read these rows as "the opt-in behaves", never as
// "quotes are staleness-gated": real staleness is bounded by the click-time
// simulate and the aggregate minOut.
describe('buildSwapQuote — stale bound (opt-in, unarmed in production)', () => {
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

  // ADEQUACY, not just non-zero. Contracts' robinhood SPEC 380 makes this
  // derivation a Tier-1 security surface: a 1-wei floor satisfies
  // FirstMintLegMinRequired and protects nothing, so the contract waves through a
  // trade with no per-leg protection at all. A collapsed survival ratio is exactly
  // how that happens, and it must refuse rather than ship dust floors.
  it('REFUSES when the measured route survives less than a tenth of the expectation', () => {
    // ~1% survival: legs would still deflate to non-zero, which is the danger.
    expect(buildSwapQuote(base({ side: 'buy', realisedOutRaw: 10n * 10n ** 18n }))).toBeNull()
  })

  it('still allows the worst drift ever measured on a live basket (~72% survival)', () => {
    const q = buildSwapQuote(base({ side: 'buy', realisedOutRaw: 713n * 10n ** 18n }))
    expect(q).not.toBeNull()
    for (const l of q!.legs) expect(l.min).toBeGreaterThan(0n)
  })

  it('refuses a zero/negative realised output rather than emitting a zero floor', () => {
    // 0n is treated as "unpriced" ⇒ falls back to NAV, never a zero floor.
    const q = buildSwapQuote(sellBase({ realisedOutRaw: 0n }))!
    expect(q.basis).toBe('nav')
    expect(q.minOutRaw).toBeGreaterThan(0n)
  })
})

// ── THE SELL FLOOR IS THE SELLER'S ONLY PROTECTION (SpectrumContracts measured
//    it 2026-08-04: a bare sell with minOut=0 gave up 700 BPS to a sandwich —
//    attacker P&L +242 tka with a victim vs −91 without, so the extraction is
//    real and comes straight out of the seller's price impact). These rows pin
//    that this kit can never ship such a sell.
describe('a sell never ships a zero aggregate floor', () => {
  // sized so the SIMULATED basis sits in a realistic band vs the NAV estimate:
  // 6,342 shares × $2 × 0.99 = 12,557 USDC, i.e. their measured 12,558 clean fill
  const sellQuote = (o: Partial<SwapQuoteInput>) =>
    buildSwapQuote(base({ side: 'sell', amount: 6_342, navPerToken: 2, feeFrac: 0.01, ...o }))

  it('the floor is a strict haircut on the SIMULATED basis, never zero', () => {
    const q = sellQuote({ realisedOutRaw: 12_558_640_000n, slippageBps: 300 })
    expect(q).not.toBeNull()
    expect(q!.minOutRaw).toBe((12_558_640_000n * 9_700n) / 10_000n)
    expect(q!.minOutRaw).toBeGreaterThan(0n)
    expect(q!.basis).toBe('simulated')
  })

  it('a 700 BPS sandwich is REFUSED at the default tolerance (their measured case)', () => {
    // clean fill 12,558.64 USDC; sandwiched 879.44 less = 11,679.20
    const q = sellQuote({ realisedOutRaw: 12_558_640_000n, slippageBps: 300 })
    expect(11_679_200_000n < q!.minOutRaw).toBe(true) // the chain reverts rather than fills
  })

  it('100% tolerance produces NO QUOTE rather than a floorless sell (fails closed)', () => {
    expect(sellQuote({ realisedOutRaw: 12_558_640_000n, slippageBps: 10_000 })).toBeNull()
  })

  it('a non-finite tolerance takes NO haircut — the floor is the basis, never zero', () => {
    const q = sellQuote({ realisedOutRaw: 12_558_640_000n, slippageBps: Number.NaN })
    expect(q!.minOutRaw).toBe(12_558_640_000n)
  })
})

// ── A FLOOR MUST BIND TO THE FUNDING THE PAYLOAD COMMITS TO ──────────────────
// A D-R1 basket funds each leg from the split packed in its legMins word, NOT from
// the target weight. Pricing a leg at its weight while the payload funds it at the
// split is a self-inflicted revert: contracts measured target-weight funding running
// 28.0% off the value-proportional split on LPADS/4663, so the under-funded leg
// acquires far less than a weight-derived floor demands and trips LegMinNotMet on an
// honest buy. The PRICE stays ours; only the share comes from the chain.
describe('buildSwapQuote — floors follow the funding split', () => {
  it('prices each leg at its SPLIT share, not its target weight', () => {
    // Same 50/50 basket, funded 90/10 by the lens. usdNet = 990.
    const q = buildSwapQuote(base({ fundingSplitBps: [9000, 1000] }))!
    // leg A: 90% × 990 = 891 USD / $2 = 445.5 tokens @18dec
    expect(q.quotedLegAmounts[0]).toBe(445_500_000_000_000_000_000n)
    // leg B: 10% × 990 = 99 USD / $1 = 99 tokens @6dec
    expect(q.quotedLegAmounts[1]).toBe(99_000_000n)
    expect(q.legs[0].min).toBe((445_500_000_000_000_000_000n * 9_900n) / 10_000n)
    expect(q.legs[1].min).toBe((99_000_000n * 9_900n) / 10_000n)
  })

  it('is byte-identical to the weight path when the split equals the weights', () => {
    const weights = buildSwapQuote(base())!
    const split = buildSwapQuote(base({ fundingSplitBps: [5000, 5000] }))!
    expect(split.quotedLegAmounts).toEqual(weights.quotedLegAmounts)
    expect(split.legs.map((l) => l.min)).toEqual(weights.legs.map((l) => l.min))
  })

  it('ships NO floor for a leg the split funds with nothing, and keeps the other', () => {
    // The starved-leg basket the lens split exists for: the unfunded leg is skipped by
    // the acquire loop, so a floor there is a guaranteed LegMinNotMet.
    const q = buildSwapQuote(base({ fundingSplitBps: [10_000, 0] }))!
    expect(q.quotedLegAmounts[1]).toBe(0n)
    expect(q.legs[1].min).toBe(0n)
    expect(q.legs[0].min).toBeGreaterThan(0n)
  })

  it('refuses a split that cannot describe this basket rather than falling back to weights', () => {
    // Falling back would floor the wrong leg while the payload funds by the split.
    expect(buildSwapQuote(base({ fundingSplitBps: [10_000] }))).toBeNull()
    expect(buildSwapQuote(base({ fundingSplitBps: [5000, 5000, 0] }))).toBeNull()
    expect(buildSwapQuote(base({ fundingSplitBps: [10_001, 0] }))).toBeNull()
    expect(buildSwapQuote(base({ fundingSplitBps: [-1, 10_000] }))).toBeNull()
    expect(buildSwapQuote(base({ fundingSplitBps: [0, 0] }))).toBeNull()
  })

  it('keeps the survival-ratio deflation on top of the split share', () => {
    // 713e18 realised vs ~990e18 frictionless ≈ 72% survival (the worst live drift).
    const q = buildSwapQuote(base({ fundingSplitBps: [9000, 1000], realisedOutRaw: 713n * 10n ** 18n }))!
    const undeflated = buildSwapQuote(base({ fundingSplitBps: [9000, 1000] }))!
    expect(q.legs[0].min).toBeLessThan(undeflated.legs[0].min)
    expect(q.legs[0].min).toBeGreaterThan(0n)
    expect(q.basis).toBe('simulated')
  })

  it('a sell ignores the split entirely (no per-leg floors on that side)', () => {
    const q = buildSwapQuote(base({ side: 'sell', amount: 10, navPerToken: 2, fundingSplitBps: [9000, 1000] }))!
    expect(q.quotedLegAmounts).toEqual([])
    expect(q.minOutRaw).toBeGreaterThan(0n)
  })
})

// ── THE USDC BUFFER LEG ──────────────────────────────────────────────────────
// A basket usually holds a USDC leg, and the contract funds it by a DIFFERENT
// rule from every other leg (SpectrumBasket._acquireBasket ~:641):
//   · the BUFFER leg is credited `amt = usdcNet * sp / BPS` — the LITERAL 10000,
//     whatever the split sums to — and its legMin is measured against that USDC
//     amount 1:1 (6dp settlement units, never a token count).
//   · every OTHER leg divides what is LEFT by `sp / nonBufferWeight`, i.e. it
//     SELF-NORMALISES, so an honest split summing to 9999 funds it slightly MORE
//     than proportional.
// The kit prices every leg at `sp/10000 × usdNet`, so the buffer leg lands exactly
// on the contract's number and the others land at or under it — which is why an
// honest buy clears LegMinNotMet on all of them.
//
// ⚠ AUDIT 2026-08-06: this shape is the commonest basket in existence and had NO
// fixture anywhere in the kit, so nothing pinned any of the above. These rows are
// that fixture; the worked example below is the audit's own.
describe('buildSwapQuote — the USDC buffer leg', () => {
  const BUFFER = 2 // the settlement leg's index in BUFFER_BASKET
  const BUFFER_BASKET: QuoteLeg[] = [
    { symbol: 'AAA', decimals: 18, targetWeightPct: 40, priceUsd: 2 },
    { symbol: 'BBB', decimals: 8, targetWeightPct: 30, priceUsd: 50 },
    { symbol: 'USDC', decimals: 6, targetWeightPct: 30, priceUsd: 1 }, // the buffer
  ]
  const buffered = (o: Partial<SwapQuoteInput> = {}): SwapQuoteInput =>
    base({ holdings: BUFFER_BASKET, slippageBps: 300, ...o })

  /** What the CONTRACT hands each leg, by its own two rules. `usd` is the dollars
   *  each leg is funded with; `fills` is the same in the units `legMins[i]` is
   *  measured in on-chain — USDC 1:1 on the buffer leg, leg tokens elsewhere (at
   *  the kit's own independent mark, so the comparison is like for like). */
  function contractFunding(split: readonly number[], usdNet: number) {
    const usdcNetRaw = toRaw(usdNet, 6)
    const bufferRaw = (usdcNetRaw * BigInt(split[BUFFER])) / 10_000n // LITERAL BPS
    const potRaw = usdcNetRaw - bufferRaw
    const nonBufferWeight = split.reduce((s, sp, i) => (i === BUFFER ? s : s + sp), 0)
    const usd = split.map((sp, i) =>
      i === BUFFER ? Number(bufferRaw) / 1e6 : Number((potRaw * BigInt(sp)) / BigInt(nonBufferWeight)) / 1e6,
    )
    const fills = BUFFER_BASKET.map((h, i) =>
      i === BUFFER ? bufferRaw : toRaw(usd[i] / h.priceUsd, h.decimals),
    )
    return { usd, fills }
  }

  // 1000 USDC in at a 1% fee ⇒ usdNet = 990, at the 3% default tolerance.
  const USD_NET = 990
  const CASES = [
    // sums to exactly 10000: self-normalising is an identity, every leg funded as priced
    { name: 'a split that divides the whole buy', split: [4000, 3000, 3000], quoted: 297_000_000n, floor: 288_090_000n },
    // the honest lens shape (each leg rounded down, so the total falls short)
    { name: 'an honest lens split summing to 9999', split: [3333, 3333, 3333], quoted: 329_967_000n, floor: 320_067_990n },
    // half the buy sits in the buffer, still on a 9999 total
    { name: 'a 9999 split whose buffer takes half the buy', split: [2000, 3000, 4999], quoted: 494_901_000n, floor: 480_053_970n },
  ]

  it.each(CASES)('$name: the buffer quotes 1:1 in USDC, the rest in leg tokens', ({ split, quoted, floor }) => {
    const q = buildSwapQuote(buffered({ fundingSplitBps: split }))!
    // 1:1 — at the settlement asset's own $1 mark the raw quote IS the dollars the
    // payload funds it with, in 6dp USDC. Not a token count.
    expect(q.quotedLegAmounts[BUFFER]).toBe(quoted)
    expect(q.quotedLegAmounts[BUFFER]).toBe(toRaw((split[BUFFER] / 10_000) * USD_NET, 6))
    expect(q.legs[BUFFER].decimals).toBe(6)
    expect(q.legs[BUFFER].min).toBe(floor)
    // and the other legs are DENOMINATED IN THEIR OWN TOKEN, at their own decimals
    expect(q.quotedLegAmounts[0]).toBe(toRaw(((split[0] / 10_000) * USD_NET) / 2, 18))
    expect(q.quotedLegAmounts[1]).toBe(toRaw(((split[1] / 10_000) * USD_NET) / 50, 8))
  })

  it.each(CASES)('$name: every floor sits BELOW what the contract funds that leg with', ({ split }) => {
    const q = buildSwapQuote(buffered({ fundingSplitBps: split }))!
    const { fills } = contractFunding(split, USD_NET)
    for (let i = 0; i < BUFFER_BASKET.length; i++) {
      // strict: equality would leave an honest buy one rounding unit from LegMinNotMet
      expect(q.legs[i].min).toBeLessThan(fills[i])
      expect(q.legs[i].min).toBeGreaterThan(0n) // and never a silent zero
    }
  })

  it("the audit's worked example: 1000 USDC in, 1% fee, split 3000 on the buffer", () => {
    const q = buildSwapQuote(buffered({ fundingSplitBps: [4000, 3000, 3000] }))!
    // the contract credits usdcNet × 3000/10000 = 297.000000 USDC…
    expect(contractFunding([4000, 3000, 3000], USD_NET).fills[BUFFER]).toBe(297_000_000n)
    // …while the kit floors that leg at 288.090000, a 3% haircut and 8.910000 of headroom
    expect(q.legs[BUFFER].min).toBe(288_090_000n)
    expect(297_000_000n - q.legs[BUFFER].min).toBe(8_910_000n)
  })

  it('a 9999 total funds the NON-buffer legs MORE than proportional, the buffer exactly', () => {
    // The asymmetry itself: the buffer divides by the literal 10000 (so a short
    // total shrinks it pro rata), while the others share out whatever is left.
    const split = [3333, 3333, 3333]
    const { usd } = contractFunding(split, USD_NET)
    expect(usd[BUFFER]).toBeCloseTo((3333 / 10_000) * USD_NET, 6) // exactly proportional
    expect(usd[0]).toBeGreaterThan((3333 / 10_000) * USD_NET) // 330.0165 vs 329.967
    expect(usd[1]).toBeGreaterThan((3333 / 10_000) * USD_NET)
    // so the kit, which prices every leg at sp/10000, is CONSERVATIVE off-buffer
    const q = buildSwapQuote(buffered({ fundingSplitBps: split }))!
    expect(q.quotedLegAmounts[1]).toBeLessThan(toRaw(usd[1] / 50, 8))
  })

  it('refuses a buffer-leg split above 10000 before it can be encoded', () => {
    // The contract reverts LegMinNotMet on a USDC leg funded above BPS — that bound
    // is its phantom-reserve guard, and above it the credit is unbounded (the audit
    // measured a leg credited 6.5x what was received). Refuse here, never encode it.
    expect(buildSwapQuote(buffered({ fundingSplitBps: [4000, 3000, 10_001] }))).toBeNull()
    expect(buildSwapQuote(buffered({ fundingSplitBps: [10_001, 3000, 3000] }))).toBeNull()
    expect(buildSwapQuote(buffered({ fundingSplitBps: [4000, 3000, 10_000] }))).not.toBeNull()
  })

  it('keeps the survival deflation on the buffer leg, still below the contract fill', () => {
    // The deflation multiplies every leg, buffer included, so the headroom only grows.
    const split = [4000, 3000, 3000]
    const q = buildSwapQuote(buffered({ fundingSplitBps: split, realisedOutRaw: 713n * 10n ** 18n }))!
    const plain = buildSwapQuote(buffered({ fundingSplitBps: split }))!
    expect(q.legs[BUFFER].min).toBeLessThan(plain.legs[BUFFER].min)
    expect(q.legs[BUFFER].min).toBeGreaterThan(0n)
    expect(q.legs[BUFFER].min).toBeLessThan(contractFunding(split, USD_NET).fills[BUFFER])
  })
})
