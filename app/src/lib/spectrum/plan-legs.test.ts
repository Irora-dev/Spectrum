import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_PRICE_AGE_MS } from './swap-quote'
import { zeroAddress } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { centBudgets, CONCENTRATION_POLICY, concentrationExceeds, concentrationOf, concentrationRefusal, decodeBatchResult, planToFlooredLegs, planToLegs, venueLegFeeBps, type PlanLegInput } from './plan-legs'

const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
const T = (symbol: string, weightPct: number, over: Partial<PlanLegInput> = {}): PlanLegInput => ({
  symbol,
  asset: `0x${symbol.toLowerCase().padEnd(4, '0').padEnd(40, '0')}` as PlanLegInput['asset'],
  decimals: 18,
  weightPct,
  priceUsd: 10,
  priceAgeMs: 5_000,
  liquidityUsd: 1_000_000,
  buyTokenTaxBps: 0,
  route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
  ...over,
})

describe('centBudgets — exact to the cent, largest remainder', () => {
  it('sums to the total exactly, however awkward the split', () => {
    const b = centBudgets([33.33, 33.33, 33.34], 10_000)
    expect(b.reduce((s, v) => s + v, 0)).toBe(10_000)
    const t = centBudgets([1, 1, 1], 100)
    expect(t.reduce((s, v) => s + v, 0)).toBe(100)
    expect(Math.max(...t) - Math.min(...t)).toBeLessThanOrEqual(1)
  })
  it('degenerate inputs produce zeros, never NaN', () => {
    expect(centBudgets([], 100)).toEqual([])
    expect(centBudgets([0, 0], 100)).toEqual([0, 0])
    expect(centBudgets([50, 50], 0)).toEqual([0, 0])
  })
})

describe('planToLegs — the bridge laws', () => {
  it('budgets are exact cents; the spot basis lands in the leg decimals', () => {
    const { legs, refusals } = planToLegs([T('AAVE', 60), T('UNI', 40)], 100_000) // $1,000
    expect(refusals).toEqual([])
    expect(legs.map((l) => l.budgetUsdCents).reduce((s, v) => s + v, 0)).toBe(100_000)
    // $600 at $10 = 60 tokens @18d
    expect(legs[0].quotedOutRaw).toBe(60_000000000000000000n)
  })

  it('an unpriceable leg REFUSES with its name — never silently shrinks the plan', () => {
    const { legs, refusals } = planToLegs([T('AAVE', 60), T('GHOST', 40, { priceUsd: null })], 100_000)
    expect(refusals).toHaveLength(1)
    expect(refusals[0].symbol).toBe('GHOST')
    expect(legs).toHaveLength(1) // the caller sees BOTH lists; nothing hides
  })

  it('thin legs mark optional (the consent surface); unreadable depth is NOT safe', () => {
    const { legs } = planToLegs(
      [
        T('DEEP', 40, { liquidityUsd: 10_000_000 }),
        T('THIN', 40, { liquidityUsd: 5_000 }), // $400 of a $5k pool = 8%
        T('DARK', 20, { liquidityUsd: null }),
      ],
      100_000,
    )
    expect(legs.find((l) => l.symbol === 'DEEP')!.optional).toBe(false)
    expect(legs.find((l) => l.symbol === 'THIN')!.optional).toBe(true)
    expect(legs.find((l) => l.symbol === 'DARK')!.optional).toBe(true)
  })

  it('a STALE or UNDATED price refuses — a floor off a dead read protects nothing (audit round)', () => {
    const { legs, refusals } = planToLegs(
      [T('FRESH', 40), T('STALE', 40, { priceAgeMs: 120_000 }), T('UNDATED', 20, { priceAgeMs: null })],
      100_000,
    )
    expect(legs.map((l) => l.symbol)).toEqual(['FRESH'])
    expect(refusals.map((r) => r.symbol).sort()).toEqual(['STALE', 'UNDATED'])
    expect(refusals.find((r) => r.symbol === 'UNDATED')!.reason).toContain('undated')
  })

  it('a zero-budget leg drops from the batch (nothing to spend is not a leg)', () => {
    const { legs } = planToLegs([T('AAVE', 100), T('DUSTY', 0.0001)], 100)
    expect(legs.map((l) => l.symbol)).toEqual(['AAVE'])
  })
})

describe('decodeBatchResult — the review reads the simulation, never re-derives', () => {
  it('skipped legs carry null out (a skipped out is not a number) and refunds stay denominated', () => {
    const legs = [
      { symbol: 'AAVE', budgetUsdCents: 60_000, optional: false },
      { symbol: 'THIN', budgetUsdCents: 40_000, optional: true },
    ]
    const review = decodeBatchResult(legs, {
      spentFunding: 123n,
      hubOut: 456n,
      feeEth: 7n,
      ethRefunded: 0n,
      usdcRefunded: 40_000n,
      outs: [999n, 0n],
      skippedBitmap: 0b10n,
    })
    expect(review.rows[0].outRaw).toBe(999n)
    expect(review.rows[1].skipped).toBe(true)
    expect(review.rows[1].outRaw).toBeNull()
    expect(review.skippedCount).toBe(1)
    expect(review.usdcRefunded).toBe(40_000n) // its own line, never netted
  })
})

describe('battle-test half-1 pins (2026-08-04): the seams a property suite cannot see', () => {
  it('a ZERO-depth pool is a DEAD pool — optional, never the safe-looking side (finding 3)', () => {
    // ⚠ TWO LEGS, not one, since the 2026-08-08 lone-leg ruling: a single-leg
    // batch's leg is always REQUIRED, so a one-leg fixture can no longer observe
    // the thinness flag at all. This test is about DETECTION, so it keeps a deep
    // companion leg and asserts on the thin one. The ruling narrowed where the
    // flag applies; it did not change what counts as thin.
    const dead = planToLegs([T('DEAD', 50, { liquidityUsd: 0 }), T('DEEP', 50, { liquidityUsd: 10_000_000 })], 100_000)
    expect(dead.legs.find((l) => l.symbol === 'DEAD')!.optional).toBe(true)
    const neg = planToLegs([T('NEG', 50, { liquidityUsd: -5 }), T('DEEP', 50, { liquidityUsd: 10_000_000 })], 100_000)
    expect(neg.legs.find((l) => l.symbol === 'NEG')!.optional).toBe(true)
  })

  it('a FUTURE-dated price refuses by name — a wrong clock is worse than no date (finding 4)', () => {
    const { legs, refusals } = planToLegs([T('SKEW', 100, { priceAgeMs: -600_000 })], 100_000)
    expect(legs).toHaveLength(0)
    expect(refusals[0].reason).toMatch(/future/i)
  })

  it('a corrupt weight refuses with a sentence, never a raw viem throw (finding 7)', () => {
    const { legs, refusals } = planToLegs([T('NAN', Number.NaN)], 100_000)
    expect(legs).toHaveLength(0)
    expect(refusals[0].reason).toMatch(/not a number/i)
  })

  it('centBudgets FLOORS a fractional total — over-allocation unrepresentable (finding 6)', () => {
    expect(centBudgets([50, 50], 1000.5).reduce((s, b) => s + b, 0)).toBe(1000)
    expect(centBudgets([60, 40], 999.9).reduce((s, b) => s + b, 0)).toBe(999)
  })

  it('a SHORT outs array refuses loudly — ABI drift is never a silent misrender (finding 5)', () => {
    const legs = [
      { symbol: 'A', budgetUsdCents: 50, optional: false },
      { symbol: 'B', budgetUsdCents: 50, optional: false },
    ]
    expect(() =>
      decodeBatchResult(legs, {
        spentFunding: 0n, hubOut: 0n, feeEth: 0n, ethRefunded: 0n, usdcRefunded: 0n,
        outs: [1n],
        skippedBitmap: 0n,
      }),
    ).toThrow(/disagree/i)
  })

  it('plan legs carry NO budgetRaw at all — cents cannot masquerade as raw (finding 1, type half)', () => {
    const { legs } = planToLegs([T('AAVE', 100)], 100)
    expect('budgetRaw' in legs[0]).toBe(false)
  })
})

describe('planToFlooredLegs — the floor discipline wired at the plan seam', () => {
  // The fixture arithmetic, stated so the pins are checkable by hand:
  //   $1,000 over equal legs at price $10, pool $1M (funding side $500k),
  //   V4 fee tier 500 → 5 bps; drift band 50 bps; tax 0.
  //   own impact for a $500 leg: 500/500,500 → 9.99 → ceil 10 bps.

  it('DEEP hop: floors are per-leg and near-flat — market term 65 bps, self-impact ~0', () => {
    const { legs, refusals } = planToFlooredLegs([T('A', 50), T('B', 50)], 100_000, { hopReserveUsd: 50_000_000 })
    expect(refusals).toHaveLength(0)
    expect(legs).toHaveLength(2)
    expect(legs[0].floor).toEqual({ sBps: 65, marketBps: 65, selfImpactBps: 0, taxBps: 0 })
    // leg 2 sees the batch's own $500 through a $50M hop — ceil rounds the
    // honest sliver UP to 1 bp, never down to a flattering zero
    expect(legs[1].floor).toEqual({ sBps: 66, marketBps: 65, selfImpactBps: 1, taxBps: 0 })
    // the floor NUMBER is the quote basis with exactly that tolerance off it
    expect(legs[0].minOutRaw).toBe((50n * 10n ** 18n * 9_935n) / 10_000n)
    expect(legs[1].minOutRaw).toBe((50n * 10n ** 18n * 9_934n) / 10_000n)
  })

  it('THIN hop: the third leg exceeds the s-max cap and REFUSES on floor; the survivors would then over-allocate, so the WHOLE plan refuses on consent divergence', () => {
    const { legs, refusals, floorRefusals } = planToFlooredLegs(
      [T('A', 33.33), T('B', 33.33), T('C', 33.34)],
      100_000,
      { hopReserveUsd: 50_000 },
    )
    // the third leg's accumulated self-impact (262 bps) pushed its total to
    // 324 bps — over the 300 cap → REFUSED, never clamped (the floor-discipline
    // subject, unchanged)…
    expect(floorRefusals.some((r) => r.reason === 'exceeds-s-max' && r.neededBps === 324)).toBe(true)
    expect(refusals.some((r) => /324 bps.*300 bps cap/.test(r.reason))).toBe(true)
    // …and now (the owner 2026-08-13) the survivors A+B would redistribute from 33%
    // each to 50% each — more than consented — so the plan REFUSES rather than
    // composing a spread the user did not choose. Nothing composes.
    expect(legs).toHaveLength(0)
    expect(refusals.some((r) => /more than you chose|re-edit/i.test(r.reason))).toBe(true)
  })

  it('an UNMEASURED hop refuses every venue leg — and a basket leg, outside the floor plan, survives', () => {
    const all = planToFlooredLegs([T('A', 100)], 100_000, { hopReserveUsd: null })
    expect(all.legs).toHaveLength(0)
    expect(all.floorRefusals.every((r) => r.reason === 'unreadable-hop-reserve')).toBe(true)

    // basket legs bypass the floor plan and compose — shown on an ALL-basket
    // plan whose legs each realise their consented share (no venue leg drops,
    // so no redistribution, so no consent divergence). A mixed plan where the
    // venue leg dropped and redistributed onto the baskets would refuse on
    // divergence (the owner 2026-08-13) — that is the collapse case, tested above.
    const baskets = planToFlooredLegs(
      [T('BSK', 50, { route: 'basket' }), T('BSK2', 50, { route: 'basket' })],
      100_000,
      { hopReserveUsd: null },
    )
    expect(baskets.legs).toHaveLength(2)
    for (const leg of baskets.legs) {
      expect(leg.route).toBe('basket')
      expect(leg.minOutRaw).toBeNull()
      expect(leg.floor).toBeNull()
    }
    expect(baskets.legs.reduce((s, l) => s + l.budgetUsdCents, 0)).toBe(100_000)
  })

  it('a KNOWN transfer tax is REFUSED (it cannot be floored here); an UNKNOWN one composes TIGHT (the owner, 2026-08-15)', () => {
    // ⚠ THIS TEST PREVIOUSLY PINNED THE INVERTED SIGN — it asserted the tax
    // "widens the floor by exactly its bps", i.e. LOWERED it, which handed the
    // route extra room before a skim that lands on top. The contract floors on
    // what the swap produced BEFORE the forward, so no floor here can cover a
    // fee-on-transfer buyToken; it is refused instead.
    const taxed = planToFlooredLegs([T('A', 100, { buyTokenTaxBps: 100 })], 100_000, { hopReserveUsd: 50_000_000 })
    expect(taxed.legs).toHaveLength(0)
    expect(taxed.floorRefusals[0].reason).toBe('buy-token-taxes-the-forward')

    // UNKNOWN is not KNOWN-taxed: the open long tail composes at the untaxed
    // (tight) floor and a lying token refuses ITSELF on-chain (MinBuyNotMet)
    // — his ruling: "we can never track all tokens."
    const unknown = planToFlooredLegs(
      [T('A', 50, { buyTokenTaxBps: null }), T('B', 50, { buyTokenTaxBps: 0 })],
      100_000,
      { hopReserveUsd: 50_000_000 },
    )
    expect(unknown.floorRefusals).toHaveLength(0)
    expect(unknown.legs).toHaveLength(2)
    // tight: the unknown-tax leg floors with ZERO tax allowance — byte-same
    // treatment as a vetted 0-tax leg in the same seat
    expect(unknown.legs[0].floor?.taxBps).toBe(0)
    expect(unknown.legs[0].minOutRaw).not.toBeNull()

    // and a NORMAL pair still floors, so the refusal is not swallowing
    // everything (a pair since the 2026-08-13 cap ruling — one leg alone is
    // 100% of its batch and the ruled policy refuses that shape)
    const ok = planToFlooredLegs(
      [T('A', 50, { buyTokenTaxBps: 0 }), T('B', 50, { buyTokenTaxBps: 0 })],
      100_000,
      { hopReserveUsd: 50_000_000 },
    )
    expect(ok.legs).toHaveLength(2)
    expect(ok.legs[0].floor).not.toBeNull()
    expect(ok.legs[1].floor).not.toBeNull()
  })

  it('UNREADABLE pool depth refuses the leg — optional-marking is consent, not a floor', () => {
    const { legs, floorRefusals } = planToFlooredLegs([T('A', 100, { liquidityUsd: null })], 100_000, { hopReserveUsd: 50_000_000 })
    expect(legs).toHaveLength(0)
    expect(floorRefusals[0].reason).toBe('unmeasured-market-slippage')
  })

  it('a route whose venue fee cannot be read refuses — V4Q and a dynamic-fee V4 tier', () => {
    const v4q = planToFlooredLegs(
      [T('A', 100, { route: { venue: Venue.V4Q, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress } })],
      100_000,
      { hopReserveUsd: 50_000_000 },
    )
    expect(v4q.legs).toHaveLength(0)
    expect(v4q.floorRefusals[0].reason).toBe('unmeasured-market-slippage')

    const dyn = planToFlooredLegs(
      [T('A', 100, { route: { venue: Venue.V4, ethPool: { ...KEY, fee: 0x800000 }, v3Fee: 0, v2Pair: zeroAddress } })],
      100_000,
      { hopReserveUsd: 50_000_000 },
    )
    expect(dyn.legs).toHaveLength(0)
    expect(dyn.floorRefusals[0].reason).toBe('unmeasured-market-slippage')
  })

  it('the venue fee is IN the floor: a 30-bps V3 tier floors 25 bps looser than a 5-bps V4 tier', () => {
    // pairs since the 2026-08-13 cap ruling (a lone leg is a 100% batch and
    // refuses); the fee-tier delta reads off the first leg either way
    const v3route = { venue: Venue.V3, ethPool: KEY, v3Fee: 3000, v2Pair: zeroAddress } as const
    const v4 = planToFlooredLegs([T('A', 50), T('B', 50)], 100_000, { hopReserveUsd: 50_000_000 })
    const v3 = planToFlooredLegs(
      [T('A', 50, { route: v3route }), T('B', 50, { route: v3route })],
      100_000,
      { hopReserveUsd: 50_000_000 },
    )
    expect(v3.legs[0].floor!.sBps - v4.legs[0].floor!.sBps).toBe(25)
  })

  it('plan-time refusals and floor refusals ride ONE channel, each a sentence with its symbol', () => {
    const { refusals } = planToFlooredLegs(
      [T('DEAD', 50, { priceUsd: null }), T('THIN', 50, { liquidityUsd: null })],
      100_000,
      { hopReserveUsd: 50_000_000 },
    )
    expect(refusals.some((r) => r.symbol === 'DEAD' && /no readable price/.test(r.reason))).toBe(true)
    expect(refusals.some((r) => r.symbol === 'THIN' && /depth could not be measured/.test(r.reason))).toBe(true)
  })
})

describe('venueLegFeeBps — the fee a route certainly charges', () => {
  it('maps the tiers: V2 is the 30-bps constant, V3/V4 read their own tier', () => {
    expect(venueLegFeeBps({ venue: Venue.V2, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress })).toBe(30)
    expect(venueLegFeeBps({ venue: Venue.V3, ethPool: KEY, v3Fee: 3000, v2Pair: zeroAddress })).toBe(30)
    expect(venueLegFeeBps({ venue: Venue.V3, ethPool: KEY, v3Fee: 500, v2Pair: zeroAddress })).toBe(5)
    expect(venueLegFeeBps({ venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress })).toBe(5)
    expect(venueLegFeeBps({ venue: Venue.V4, ethPool: { ...KEY, fee: 100 }, v3Fee: 0, v2Pair: zeroAddress })).toBe(1)
  })
  it('refuses what it cannot read: V4Q, basket, the dynamic-fee flag, implausible tiers', () => {
    expect(venueLegFeeBps('basket')).toBeNull()
    expect(venueLegFeeBps({ venue: Venue.V4Q, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress })).toBeNull()
    expect(venueLegFeeBps({ venue: Venue.V4, ethPool: { ...KEY, fee: 0x800000 }, v3Fee: 0, v2Pair: zeroAddress })).toBeNull()
    expect(venueLegFeeBps({ venue: Venue.V3, ethPool: KEY, v3Fee: -1, v2Pair: zeroAddress })).toBeNull()
    expect(venueLegFeeBps({ venue: Venue.V3, ethPool: KEY, v3Fee: 1_000_001, v2Pair: zeroAddress })).toBeNull()
    expect(venueLegFeeBps({ venue: Venue.V3, ethPool: KEY, v3Fee: 30.5, v2Pair: zeroAddress })).toBeNull()
  })
})

describe('M1 — two legs on one asset must never share one floor', () => {
  // Measured by the reviewer on a 99/1 split: the join Map keyed by asset
  // collapsed two floor results into one, so the small leg carried a floor at
  // 99.15% of its own quote and the BIG one carried 1.002% — $9,752 of a
  // $9,950 batch sitting below its own composed floor, which is exactly the
  // round-3 attack the floor discipline exists to stop.
  const dup = (): PlanLegInput[] => [
    { ...T('BIG', 99), asset: '0x0700000000000000000000000000000000000007' },
    { ...T('SMALL', 1), asset: '0x0700000000000000000000000000000000000007' },
  ]

  it('a duplicated asset REFUSES rather than deriving one floor for two legs', () => {
    expect(() => planToFlooredLegs(dup(), 1_000_000, { hopReserveUsd: 50_000_000 })).toThrow(/twice in one plan/i)
  })

  it('and the refusal does not depend on the order they arrive in', () => {
    expect(() => planToFlooredLegs(dup().reverse(), 1_000_000, { hopReserveUsd: 50_000_000 })).toThrow(/twice in one plan/i)
  })

  it('distinct assets are unaffected — the guard is about identity, not count', () => {
    const out = planToFlooredLegs([T('A', 50), T('B', 50)], 1_000_000, { hopReserveUsd: 50_000_000 })
    expect(out.legs).toHaveLength(2)
    // and each leg's floor is derived from ITS OWN quote
    for (const l of out.legs) {
      expect(l.minOutRaw).toBe((l.quotedOutRaw * BigInt(10_000 - l.floor!.sBps)) / 10_000n)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M2 — THE CONSENT DIVERGENCE, measured 2026-08-07 and carried as a fact.
//
// The fixpoint re-budgets the FULL funding over survivors, so refusals
// CASCADE. The reviewer's case reproduced: 12 equal targets, one deep asset,
// a $50k hop → ONE leg composed carrying 100% where it asked for 8.33%. That
// batch is correctly floored and composes happily; what broke was consent.
// These pins hold the DETECTION honest. The POLICY (refuse / re-confirm /
// warn at some threshold) is the owner's open decision — no test here may assert
// one, or it becomes the silent policy.
// ─────────────────────────────────────────────────────────────────────────────
describe('planToFlooredLegs — the consent divergence is carried, not judged', () => {
  let n = 100
  const M = (symbol: string, liquidityUsd: number): PlanLegInput => ({
    symbol,
    asset: `0x${(++n).toString(16).padStart(40, '0')}` as PlanLegInput['asset'],
    decimals: 18,
    weightPct: 100 / 12,
    priceUsd: 10,
    priceAgeMs: 5_000,
    liquidityUsd,
    buyTokenTaxBps: 0,
    route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
  })

  it('REPRODUCES the measured case: asked 8.33%, would receive 100% — CONSENT DIVERGENCE refuses it (the owner 2026-08-13), fact attached', () => {
    // The canonical over-allocation case: 11 thin legs floor-refuse, DEEP
    // absorbs the whole batch — realising 100% where it consented 8.33%. That
    // is "putting more into an asset than you specified", which the owner's
    // consent-divergence ruling refuses (supersedes the same-day absolute 75%
    // cap). The fact still says exactly what almost happened.
    const targets = [M('DEEP', 5_000_000), ...Array.from({ length: 11 }, (_, i) => M(`T${i}`, 20_000))]
    const out = planToFlooredLegs(targets, 1_000_000, { hopReserveUsd: 50_000 })
    expect(out.legs).toHaveLength(0)
    expect(out.concentration.worst).not.toBeNull()
    expect(out.concentration.worst!.symbol).toBe('DEEP')
    expect(out.concentration.worst!.realisedPct).toBeCloseTo(100, 5)
    expect(out.concentration.worst!.consentedPct).toBeCloseTo(100 / 12, 5)
    expect(out.concentration.excludedCount).toBe(11)
    // the sentence names the leg, the consented vs realised shares, and offers re-edit
    expect(out.refusals.some((r) => /\$DEEP/.test(r.reason) && /put 100%/.test(r.reason))).toBe(true)
    expect(out.refusals.some((r) => /re-edit|more than you chose/i.test(r.reason))).toBe(true)
  })

  it('CONSENT DIVERGENCE, not an absolute cap: a deliberate 90/10 COMPOSES; a collapse that over-allocates REFUSES', () => {
    // a DELIBERATE two-asset split, both deep, both survive → realised ==
    // consented (divergence 0) → composes, EVEN at 90/10 (the old 75% cap
    // would have wrongly refused it; consent-divergence does not)
    const deliberate = planToFlooredLegs(
      [{ ...M('BIGW', 5_000_000), weightPct: 90 }, { ...M('SMALLW', 5_000_000), weightPct: 10 }],
      1_000_000,
      { hopReserveUsd: 50_000_000 },
    )
    expect(deliberate.legs).toHaveLength(2)
    expect(deliberate.refusals.filter((r) => /more than you chose/.test(r.reason))).toHaveLength(0)
    // a COLLAPSE: three equal, one thin leg drops, survivors over-allocate
    // (33→50) → refuses on divergence, naming the over-allocated leg
    const collapse = planToFlooredLegs(
      [{ ...M('KEEP1', 5_000_000), weightPct: 100 / 3 }, { ...M('KEEP2', 5_000_000), weightPct: 100 / 3 }, { ...M('THIN', 15_000), weightPct: 100 / 3 }],
      1_000_000,
      { hopReserveUsd: 50_000 },
    )
    expect(collapse.legs).toHaveLength(0)
    expect(collapse.refusals.some((r) => /more than you chose|re-edit/i.test(r.reason))).toBe(true)
  })

  it('a faithful batch reports ratio ≈ 1 for every leg', () => {
    const targets = Array.from({ length: 4 }, (_, i) => M(`E${i}`, 5_000_000))
    const out = planToFlooredLegs(targets, 1_000_000, { hopReserveUsd: 50_000_000 })
    expect(out.legs).toHaveLength(4)
    for (const r of out.concentration.rows) expect(r.ratio).toBeCloseTo(1, 3)
    expect(out.concentration.excludedCount).toBe(0)
  })

  it('nothing composed → worst is null, never a crash or a fabricated row', () => {
    const targets = Array.from({ length: 3 }, (_, i) => M(`X${i}`, 20_000))
    const out = planToFlooredLegs(targets, 1_000_000, { hopReserveUsd: 5_000 })
    expect(out.legs).toHaveLength(0)
    expect(out.concentration.worst).toBeNull()
    expect(out.concentration.rows).toEqual([])
  })

  it('concentrationOf: EVERY composed leg gets a row — an unreadable consent is the WORST ratio, not an absent one', () => {
    // ⚠ MY OWN EARLIER TEST HERE PINNED THE BUG AS CORRECT. It asserted the
    // NaN-weight leg got NO row and that every ratio was finite — encoding a
    // silent omission as the desired behaviour. Self-audit measurement: three
    // composed legs produced ONE row, realisedPct summed to 30, excludedCount
    // said 0, and worst.ratio reported 0.30 — APPARENT SAFETY while 70% of the
    // batch sat in legs the fact could not see. A policy threshold is about to
    // be set on that number.
    const c = concentrationOf(
      [
        { symbol: 'A', asset: '0xa', weightPct: 50 },
        { symbol: 'B', asset: '0xb', weightPct: Number.NaN },
      ],
      [
        { asset: '0xa', budgetUsdCents: 3_000 },
        { asset: '0xb', budgetUsdCents: 3_000 },
        { asset: '0xc', budgetUsdCents: 4_000 }, // composed, never consented
      ],
    )
    expect(c.rows).toHaveLength(3)
    expect(c.rows.reduce((s, r) => s + r.realisedPct, 0)).toBeCloseTo(100, 6)
    // a leg that received money it never consented to is the worst kind of
    // concentration, not the absence of any — and its ratio is NULL, not
    // Infinity (independent pass 2026-08-08: Infinity ties every unconsented
    // leg, so the comparator returns NaN and the sort degenerates to insertion
    // order; it also stringifies to null and reads back as 0).
    expect(c.worst!.ratio).toBeNull()
    // ⚠ AND THIS IS THE ASSERTION THIS TEST WAS MISSING, which is why it
    // exhibited the bug it was written to catch. B and 0xc are BOTH unconsented,
    // so `ratio === Infinity` was satisfied by either — and insertion order
    // named B, at 30%, while 0xc quietly held 40%. `worst` must name the leg
    // carrying the MOST money nobody consented to, or the fact understates
    // itself exactly where it matters most.
    expect(c.worst!.asset).toBe('0xc')
    expect(c.worst!.realisedPct).toBeCloseTo(40, 6)
    // the unconsented rows lead, ordered by how much of the batch they took
    expect(c.rows.slice(0, 2).map((r) => r.asset)).toEqual(['0xc', '0xb'])
    expect(c.unconsentedCount).toBe(2)
    // and the honest leg still reports its own true share
    const a = c.rows.find((r) => r.symbol === 'A')!
    expect(a.consentedPct).toBeCloseTo(100, 6)
    expect(a.realisedPct).toBeCloseTo(30, 6)
  })

  it('concentrationOf: honest weights are unaffected by the change', () => {
    const rows = concentrationOf(
      [
        { symbol: 'A', asset: '0xa', weightPct: 50 },
        { symbol: 'B', asset: '0xb', weightPct: Number.NaN },
        { symbol: 'C', asset: '0xc', weightPct: 50 },
      ],
      [
        { asset: '0xa', budgetUsdCents: 5_000 },
        { asset: '0xb', budgetUsdCents: 5_000 },
        { asset: '0xc', budgetUsdCents: 5_000 },
      ],
    )
    // every composed leg is represented; the two honest ones share the readable
    // weight, and the NaN-weight leg is surfaced as unconsented rather than dropped
    expect(rows.rows.map((r) => r.symbol).sort()).toEqual(['A', 'B', 'C'])
    expect(rows.unconsentedCount).toBe(1)
    for (const r of rows.rows.filter((x) => x.consentedPct > 0)) expect(Number.isFinite(r.ratio)).toBe(true)
  })
})

describe('a zero-cent leg is a refusal, not a disappearance (reviewer M5, 2026-08-07)', () => {
  it('the rounded-out leg gets a row naming it; the user is never silently down an asset', () => {
    // $1.00 across a 99.9/0.1 split: the small leg's largest-remainder share
    // rounds to zero cents — it used to vanish with no sentence
    const { legs, refusals } = planToLegs([T('BIG', 99.9), T('DUST', 0.1)], 100)
    expect(legs.map((l) => l.symbol)).toEqual(['BIG'])
    expect(refusals.some((r) => r.symbol === 'DUST' && /zero cents/.test(r.reason))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE REAL BOUNDARIES (gate A12's plan-legs sweep). Its other survivors
// are degenerate-guard equivalents (`x <= 0` → `x < 0` where zero produces the
// same output either way); these three are money decisions at an exact edge,
// and every one was unasserted — only the middle of each range was tested.
// ─────────────────────────────────────────────────────────────────────────────
describe('exact edges: depth, staleness, and the stored-bps bound', () => {
  it('a position EXACTLY at the depth floor is thin — the floor is the start of thin, not past it', () => {
    // DEPTH_FLOOR_PCT is 5: a $500 leg in a $10,000 pool is exactly 5%.
    // `>=` means that leg is optional (consent required); `>` would have shipped
    // it as REQUIRED, which is the whole difference the flag exists to carry.
    // Two legs for the same reason as the dead-pool test above: since the
    // lone-leg ruling a single-leg batch is always required, so the boundary is
    // asserted with a deep companion. $500 of a $10,000 pool is still exactly 5%.
    const at = planToLegs(
      [T('AT', 50, { liquidityUsd: 10_000, priceUsd: 10 }), T('COMPANION', 50, { liquidityUsd: 10_000_000, priceUsd: 10 })],
      100_000,
    )
    expect(at.legs.find((l) => l.symbol === 'AT')!.optional, 'exactly at the floor is thin').toBe(true)
    // and comfortably deeper is not thin
    expect(at.legs.find((l) => l.symbol === 'COMPANION')!.optional).toBe(false)
  })

  it('a price EXACTLY at the max age still counts; one millisecond older refuses', () => {
    const at = planToLegs([T('AT', 100, { priceAgeMs: DEFAULT_MAX_PRICE_AGE_MS })], 100_000)
    expect(at.refusals, 'exactly at the limit is still fresh enough').toEqual([])
    const over = planToLegs([T('OVER', 100, { priceAgeMs: DEFAULT_MAX_PRICE_AGE_MS + 1 })], 100_000)
    expect(over.legs).toHaveLength(0)
    expect(over.refusals[0].reason).toMatch(/stale/)
  })

  it('a ZERO weight is legal input; a NEGATIVE one is refused', () => {
    // the boundary between "asked for nothing" (which the zero-cent refusal
    // handles downstream, with its own sentence) and "asked for something
    // impossible" (refused here, as unreadable intent)
    const zero = planToLegs([T('ZERO', 0), T('REAL', 100)], 100_000)
    expect(zero.legs.map((l) => l.symbol)).toEqual(['REAL'])
    expect(zero.refusals.some((r) => r.symbol === 'ZERO' && /zero cents/.test(r.reason))).toBe(true)
    const neg = planToLegs([T('NEG', -1), T('REAL', 100)], 100_000)
    expect(neg.legs.map((l) => l.symbol)).toEqual(['REAL'])
    expect(neg.refusals.some((r) => r.symbol === 'NEG')).toBe(true)
  })
})

describe('the exactly-zero and exactly-at-the-ceiling boundaries (mutation triage, 2026-08-07)', () => {
  // Six survivors here were real, and every one is a boundary VALUE nothing
  // asserted — the guards were right, but any of them could have been widened
  // or narrowed by one character with the suite staying green. Found by a
  // differential probe rather than by reading: apply the mutant, run a boundary
  // battery, diff. The first version of that probe called two of these
  // functions with the WRONG SHAPE, so every case returned null or threw and
  // all their mutants looked equivalent — a probe that never reaches the code
  // reports equivalence for everything, which is the same lie as a grep for the
  // wrong string. Four of these six were recovered only after fixing it.

  it('a price of exactly 0 is NOT a readable price — a floor cannot be stated from it', () => {
    // `!(t.priceUsd > 0)` widened to `>= 0` accepts zero as a price, and a leg
    // whose price is zero prices its own floor at zero.
    const { legs, refusals } = planToLegs([T('ZERO', 50, { priceUsd: 0 }), T('AAVE', 50)], 100_000)
    expect(legs.map((l) => l.symbol)).toEqual(['AAVE'])
    expect(refusals[0]).toMatchObject({ symbol: 'ZERO' })
    expect(refusals[0].reason).toMatch(/no readable price/)
  })

  it('a price quoted THIS INSTANT is the freshest possible, not an invalid age', () => {
    // `t.priceAgeMs < 0` narrowed to `<= 0` refuses age zero — the one age that
    // is definitionally perfect. Only a negative age is impossible.
    const { legs, refusals } = planToLegs([T('FRESH', 50, { priceAgeMs: 0 }), T('AAVE', 50)], 100_000)
    expect(legs.map((l) => l.symbol).sort()).toEqual(['AAVE', 'FRESH'])
    expect(refusals).toEqual([])
    const neg = planToLegs([T('NEG', 100, { priceAgeMs: -1 })], 100_000)
    expect(neg.legs).toEqual([])
  })

  it('venueLegFeeBps: a 0% pool reads as 0 bps, and 1e6 is an INCLUSIVE ceiling', () => {
    // Both ends were unpinned: `raw < 0` narrowed to `<= 0` turns a legitimate
    // zero-fee pool unreadable, and `raw > 1_000_000` widened to `>=` rejects
    // exactly 100%, which the comment beside it calls the ceiling — not one
    // past it. A null here drops the leg's fee from the floor arithmetic.
    const v3 = (v3Fee: number) => venueLegFeeBps({ venue: Venue.V3, ethPool: KEY, v3Fee, v2Pair: zeroAddress })
    expect(v3(0)).toBe(0)
    expect(v3(1_000_000)).toBe(10_000)
    expect(v3(-1)).toBeNull()
    expect(v3(1_000_001)).toBeNull()
    // the V4 half reads a different field and needs its own case
    const v4 = (fee: number) => venueLegFeeBps({ venue: Venue.V4, ethPool: { ...KEY, fee }, v3Fee: 0, v2Pair: zeroAddress })
    expect(v4(0)).toBe(0)
    expect(v4(1_000_000)).toBe(10_000)
    expect(v4(1_000_001)).toBeNull()
    // IT ROUNDS UP, AND EVERY FIXTURE HID THAT. `ceil` -> `floor` survived the
    // whole suite because every fee tier used here (0, 500, 3000, 1e6) divides
    // by 100 exactly, so the two agree on all of them (independent pass,
    // 2026-08-08). A tier that does not divide is the only case that can tell
    // them apart, and rounding UP is the conservative direction: this number
    // feeds a floor, and understating a fee overstates what a leg can buy.
    expect(v3(250)).toBe(3) // 2.5 bps -> 3, not 2
    expect(v4(250)).toBe(3)
    expect(v3(1)).toBe(1) // 0.01 bps is still a fee, never rounded away to 0
  })

  it('concentrationOf: a NEGATIVE consent contributes NOTHING to the consented total', () => {
    // `Number.isFinite(w) && w > 0` turned `||` lets a negative weight into the
    // sum, which shrinks the denominator every consentedPct is measured against
    // — a silent re-scaling of the number a policy threshold will read.
    const c = concentrationOf(
      [
        { symbol: 'A', asset: '0xa', weightPct: -1 },
        { symbol: 'B', asset: '0xb', weightPct: 100 },
      ],
      [
        { asset: '0xa', budgetUsdCents: 100 },
        { asset: '0xb', budgetUsdCents: 0 },
      ],
    )
    const b = c.rows.find((r) => r.symbol === 'B')
    expect(b?.consentedPct).toBe(100)
    expect(c.rows.find((r) => r.symbol === 'A')?.consentedPct).toBe(0)
  })

  it('concentrationOf: a batch composing ZERO cents reports no rows, never a NaN share', () => {
    // `totalCents > 0` widened to `>= 0` divides every realisedPct by zero and
    // emits rows reading NaN%. This is the fact the owner is about to set the M2
    // threshold on, and a NaN there compares false against every bound — the
    // shape that once shipped "-Infinity%" as a statement about someone's money.
    const c = concentrationOf(
      [{ symbol: 'A', asset: '0xa', weightPct: 100 }],
      [{ asset: '0xa', budgetUsdCents: 0 }],
    )
    expect(c.rows).toEqual([])
    expect(c.worst).toBeNull()
    // ZERO, not one: nothing was excluded, the whole fact was declined. Measured
    // rather than assumed — my first draft asserted 1 and was wrong about which
    // of the two honest answers this returns.
    expect(c.excludedCount).toBe(0)
    for (const r of c.rows) expect(Number.isFinite(r.realisedPct)).toBe(true)
  })
})

describe('the concentration fact survives being written down (independent pass 2026-08-08)', () => {
  const twoUnconsented = () =>
    concentrationOf(
      [{ symbol: 'A', asset: '0xa', weightPct: 100 }],
      [
        { asset: '0xa', budgetUsdCents: 2_000 },
        { asset: '0xb', budgetUsdCents: 100 }, // unconsented, small
        { asset: '0xc', budgetUsdCents: 7_900 }, // unconsented, LARGE
      ],
    )

  it('a ROUND TRIP through JSON changes nothing — Infinity became 0 and inverted the verdict', () => {
    // Measured by the reviewer: JSON.stringify writes Infinity as null and it
    // reads back as 0, so a batch that REFUSES in memory PASSES after any
    // serialization — and drafts already go to localStorage through
    // JSON.stringify. structuredClone preserves Infinity, so this would never
    // have surfaced in local testing. Null is JSON-native and survives.
    const before = twoUnconsented()
    const after = JSON.parse(JSON.stringify(before)) as typeof before
    expect(after).toEqual(before)
    expect(after.worst!.ratio).toBeNull()
    expect(after.worst!.asset).toBe('0xc')
  })

  it('worst names the LARGEST unconsented leg, not the first one composed', () => {
    // The severity ordering, stated on its own so it cannot be lost again.
    const c = twoUnconsented()
    expect(c.worst!.asset).toBe('0xc')
    expect(c.rows.map((r) => r.asset)).toEqual(['0xc', '0xb', '0xa'])
  })

  it('no ratio is NaN or Infinity — a safety number must not poison an aggregate', () => {
    // NaN > threshold is FALSE, which is fail-OPEN on the exact comparison a
    // policy will make. Nothing here may produce a value that does that.
    for (const r of twoUnconsented().rows)
      expect(r.ratio === null || Number.isFinite(r.ratio)).toBe(true)
  })

  it('a fully consented, faithful plan still reports finite ratios near 1', () => {
    const c = concentrationOf(
      [
        { symbol: 'A', asset: '0xa', weightPct: 50 },
        { symbol: 'B', asset: '0xb', weightPct: 50 },
      ],
      [
        { asset: '0xa', budgetUsdCents: 5_000 },
        { asset: '0xb', budgetUsdCents: 5_000 },
      ],
    )
    expect(c.unconsentedCount).toBe(0)
    for (const r of c.rows) expect(r.ratio).toBeCloseTo(1, 6)
  })
})

describe('unconsented money cannot make an over-filled leg look faithful (independent pass 2026-08-08)', () => {
  const overFilled = (extra: { asset: string; budgetUsdCents: number }[] = []) =>
    concentrationOf(
      [
        { symbol: 'A', asset: '0xa', weightPct: 50 },
        { symbol: 'B', asset: '0xb', weightPct: 50 },
      ],
      [{ asset: '0xa', budgetUsdCents: 10_000 }, { asset: '0xb', budgetUsdCents: 0 }, ...extra],
    )

  it("a 2x over-fill reads as 2x whether or not a ghost leg is beside it", () => {
    // MEASURED BEFORE THE FIX: ratio 2 alone, ratio 1.0 once an equal
    // unconsented leg was added — the same leg, holding the same money,
    // reported as perfectly faithful. Mixed denominators: realisedPct divided
    // by the WHOLE batch while consentedPct divided by the consented targets,
    // so unconsented money deflated every honest leg's ratio. Fail-open on the
    // exact number a policy reads, and the more money went astray the more
    // innocent everything looked.
    const alone = overFilled().rows.find((r) => r.asset === '0xa')!
    const withGhost = overFilled([{ asset: '0xz', budgetUsdCents: 10_000 }]).rows.find((r) => r.asset === '0xa')!
    expect(alone.ratio).toBeCloseTo(2, 6)
    expect(withGhost.ratio).toBeCloseTo(2, 6) // was 1.0 — the whole finding
  })

  it('and realisedPct still means share of the WHOLE batch, which is what the surface shows', () => {
    // The ratio changed universe; this number did not. A leg holding half the
    // batch says 50, ghost money included, because that is what a user sees.
    const withGhost = overFilled([{ asset: '0xz', budgetUsdCents: 10_000 }]).rows.find((r) => r.asset === '0xa')!
    expect(withGhost.realisedPct).toBeCloseTo(50, 6)
  })
})

describe('the consented universe excludes zero-weight targets (my own new code, caught by the sweep)', () => {
  it('a target consented at ZERO does not join the consented denominator', () => {
    // `t.weightPct > 0` in the consentedCents reduce. Widened to `>= 0`, a
    // target the user weighted at zero — i.e. asked for NONE of — has its
    // composed budget counted into the consented universe, which inflates the
    // denominator and DEFLATES every honest leg's ratio. That is the same
    // fail-open the denominator fix just closed, re-entering through the fix
    // itself. Caught by the mutation sweep on code written minutes earlier,
    // for the third time tonight.
    const c = concentrationOf(
      [
        { symbol: 'A', asset: '0xa', weightPct: 50 },
        { symbol: 'B', asset: '0xb', weightPct: 50 },
        { symbol: 'Z', asset: '0xz', weightPct: 0 }, // asked for none
      ],
      [
        { asset: '0xa', budgetUsdCents: 10_000 },
        { asset: '0xb', budgetUsdCents: 0 },
        { asset: '0xz', budgetUsdCents: 10_000 }, // got half the batch anyway
      ],
    )
    // A still over-filled 2x against what IT consented to; Z's money is not
    // consented money and must not dilute that.
    expect(c.rows.find((r) => r.asset === '0xa')!.ratio).toBeCloseTo(2, 6)
    // and Z itself asked for nothing and received something — the worst kind
    expect(c.worst!.asset).toBe('0xz')
    expect(c.worst!.ratio).toBeNull()
  })
})

describe('the two counters read consent the SAME way (independent pass 2026-08-08)', () => {
  it("a target weighted ZERO is not 'consented' to either counter — the reviewer's exact case", () => {
    // Measured: targets A(100), Z(0), Y(0), where Z composes and Y does not.
    // unconsentedCount called Z not-consented (weight 0), while excludedCount
    // called Y consented-and-dropped (no weight predicate at all) — the same
    // input classified oppositely by nothing but whether it composed.
    // Resolved toward what the weight MEANS: zero is the user saying "none of
    // this", so Y's absence is the plan working, not a target dropped.
    const c = concentrationOf(
      [
        { symbol: 'A', asset: '0xa', weightPct: 100 },
        { symbol: 'Z', asset: '0xz', weightPct: 0 },
        { symbol: 'Y', asset: '0xy', weightPct: 0 },
      ],
      [
        { asset: '0xa', budgetUsdCents: 5_000 },
        { asset: '0xz', budgetUsdCents: 5_000 }, // composed, never consented
      ],
    )
    expect(c.unconsentedCount).toBe(1) // Z got money it never asked for
    expect(c.excludedCount).toBe(0) // Y asked for none and got none — working
  })

  it('a genuinely dropped target still counts — the fix must not silence the real case', () => {
    const c = concentrationOf(
      [
        { symbol: 'A', asset: '0xa', weightPct: 50 },
        { symbol: 'B', asset: '0xb', weightPct: 50 }, // consented, never composed
      ],
      [{ asset: '0xa', budgetUsdCents: 10_000 }],
    )
    expect(c.excludedCount).toBe(1)
    expect(c.unconsentedCount).toBe(0)
  })
})

describe("a lone leg is never skippable (the owner's ruling 2026-08-08)", () => {
  it('a single thin asset composes as REQUIRED, not skippable', () => {
    // `optional` exists so one failing buy does not revert the others. With no
    // others it protects nothing and only chooses the failure: skippable means
    // the fee is paid and the batch reports success having bought nothing;
    // required means a revert, gas only, unambiguous.
    const { legs } = planToLegs([T('THIN', 100, { liquidityUsd: 5_000 })], 100_000)
    expect(legs).toHaveLength(1)
    expect(legs[0].optional).toBe(false)
  })

  it('and it is the RESULTING legs that count — five targets reduced to one is a lone leg', () => {
    const { legs } = planToLegs(
      [T('THIN', 20, { liquidityUsd: 5_000 }), ...Array.from({ length: 4 }, (_, i) => T(`G${i}`, 20, { priceUsd: null }))],
      100_000,
    )
    expect(legs).toHaveLength(1)
    expect(legs[0].optional).toBe(false)
  })

  it('but an UNREADABLE depth stays skippable even alone — the ruling does not overturn the read-failed law', () => {
    // the owner ruled on a THIN leg: one whose depth we measured and found shallow.
    // A leg whose depth could not be READ is a different case with an older
    // ruling — an unmeasurable depth never lands on the required side, because
    // a read that failed is not a verdict. Two cross-module sweeps hold that
    // law and caught this the moment the first cut applied the ruling to both.
    // The interaction is real and is on the owner's desk: a lone unreadable-depth
    // leg stays skippable, so its failure still costs the fee.
    const { legs } = planToLegs([T('DARK', 100, { liquidityUsd: null })], 100_000)
    expect(legs).toHaveLength(1)
    expect(legs[0].optional).toBe(true)
  })

  it('but with a SECOND leg beside it, thinness still marks it skippable', () => {
    // The ruling narrows the flag; it does not remove it.
    const { legs } = planToLegs([T('THIN', 50, { liquidityUsd: 5_000 }), T('DEEP', 50, { liquidityUsd: 10_000_000 })], 100_000)
    expect(legs.find((l) => l.symbol === 'THIN')!.optional).toBe(true)
    expect(legs.find((l) => l.symbol === 'DEEP')!.optional).toBe(false)
  })
})

describe('the concentration policy reads the SHARE, not the ratio (measured 2026-08-08)', () => {
  const spread = (n: number, survive: number) => {
    const targets = Array.from({ length: n }, (_, i) => ({ symbol: `A${i}`, asset: `0x${i}`, weightPct: 100 / n }))
    const composed = Array.from({ length: survive }, (_, i) => ({ asset: `0x${i}`, budgetUsdCents: Math.floor(10_000 / survive) }))
    return concentrationOf(targets, composed)
  }

  it('THE MEASUREMENT THAT SETTLED IT: a HIGHER ratio can be the SAFER plan', () => {
    // 3 legs collapsing to 1 → ratio 3.00 and one asset holds EVERYTHING.
    // 10 legs collapsing to 3 → ratio 3.33 and the largest holds a third.
    // A gate on ratio refuses the second and permits the first.
    const collapsed = spread(3, 1)
    const spreadOut = spread(10, 3)
    expect(collapsed.worst!.ratio).toBeCloseTo(3, 3)
    expect(collapsed.worst!.realisedPct).toBeCloseTo(100, 3)
    expect(spreadOut.worst!.ratio).toBeCloseTo(10 / 3, 3)
    expect(spreadOut.worst!.realisedPct).toBeCloseTo(100 / 3, 3)
    expect(spreadOut.worst!.ratio!).toBeGreaterThan(collapsed.worst!.ratio!) // the trap, stated
  })

  it('and the policy gets it the right way round', () => {
    expect(concentrationExceeds(spread(3, 1), 50).exceeded).toBe(true) // 100% > 50%
    expect(concentrationExceeds(spread(10, 3), 50).exceeded).toBe(false) // 33% is fine
  })

  it('compares WITH TOLERANCE — a bare integer misses the case it was written for', () => {
    // The canonical case measures 11.999999999999996 against a 12, and a
    // faithful plan measures 1.0000000009999999 against a 1. Exactly at the
    // bound is allowed; float noise at the bound must not trip it.
    const exact = concentrationOf(
      [{ symbol: 'A', asset: '0xa', weightPct: 50 }, { symbol: 'B', asset: '0xb', weightPct: 50 }],
      [{ asset: '0xa', budgetUsdCents: 5_000 }, { asset: '0xb', budgetUsdCents: 5_000 }],
    )
    expect(concentrationExceeds(exact, 50).exceeded).toBe(false) // exactly 50 is not "over 50"
    expect(concentrationExceeds(exact, 49.9).exceeded).toBe(true)
  })

  it('a TIE names the FIRST leg, not the last — which leg gets blamed must be deterministic', () => {
    // `r.realisedPct > worst.realisedPct` decides this, and the sweep caught it
    // unpinned in code I had just written. With `>=` the tie flips to the last
    // row, so the policy sentence would blame a different asset run to run for
    // identical inputs. Same class as the batcher remainder tie-break.
    const tied = concentrationOf(
      [{ symbol: 'FIRST', asset: '0xa', weightPct: 50 }, { symbol: 'SECOND', asset: '0xb', weightPct: 50 }],
      [{ asset: '0xa', budgetUsdCents: 5_000 }, { asset: '0xb', budgetUsdCents: 5_000 }],
    )
    expect(concentrationExceeds(tied, 10).symbol).toBe('FIRST')
  })

  it('EXACTLY at the bound plus tolerance is not over it', () => {
    // The razor edge of the comparison itself: `share > max + tol`. Widened to
    // `>=`, a share landing precisely on the tolerated bound would trip.
    const half = concentrationOf(
      [{ symbol: 'A', asset: '0xa', weightPct: 50 }, { symbol: 'B', asset: '0xb', weightPct: 50 }],
      [{ asset: '0xa', budgetUsdCents: 5_000 }, { asset: '0xb', budgetUsdCents: 5_000 }],
    )
    expect(concentrationExceeds(half, 50 - 1e-6).exceeded).toBe(false) // exactly max+tol
    expect(concentrationExceeds(half, 50 - 1e-5).exceeded).toBe(true) // past it
  })

  it('an empty fact exceeds nothing, and names nothing', () => {
    const none = concentrationOf([], [])
    expect(concentrationExceeds(none, 50)).toEqual({ exceeded: false, worstSharePct: 0, symbol: null })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A12 SURVIVOR PINS on the M2 consent-divergence policy (sweep, 2026-08-13).
// The ruled tolerance had no test sitting exactly ON its boundary — the one
// input that proves the `<=` discriminates — and the shared fact could emit a
// non-finite ratio through a zero-cent consented leg. Both boundaries derive
// from CONCENTRATION_POLICY so the owner's open tolerance question (Q2: is 1pp the
// number?) retunes the constant without breaking the pin.
// ─────────────────────────────────────────────────────────────────────────────
describe('concentrationRefusal — the ruled tolerance boundary (A12 pins)', () => {
  const factWith = (realisedPct: number) => {
    const row = { symbol: 'AAA', asset: '0xaaa', consentedPct: 50, realisedPct, ratio: realisedPct / 50 }
    return { rows: [row], worst: row, excludedCount: 0, unconsentedCount: 0 }
  }

  it('a one-sided unreadable pct falls to the GENERIC sentence, never "null%" (kills :588 && → ||)', () => {
    // a row can carry a real realisedPct with an unreadable consentedPct (the
    // four-lens fix made unreadable-consent rows VISIBLE in the fact); the
    // sentence must then use the generic form — the mutant would render
    // "You asked for null% of $AAA"
    const row = { symbol: 'AAA', asset: '0xaaa', consentedPct: Number.NaN, realisedPct: 90, ratio: null }
    const refusal = concentrationRefusal({ rows: [row], worst: row, excludedCount: 0, unconsentedCount: 1 } as never)
    expect(refusal).toMatch(/more into \$AAA than you asked/)
    expect(refusal).not.toMatch(/null/)
  })

  it('over-allocation exactly AT the tolerance composes; past it refuses (kills plan-legs:579 <= → <)', () => {
    // integers keep the subtraction FP-exact: (50 + pp) - 50 === pp precisely
    expect(concentrationRefusal(factWith(50 + CONCENTRATION_POLICY.maxOverAllocationPp))).toBeNull()
    const refusal = concentrationRefusal(factWith(50 + CONCENTRATION_POLICY.maxOverAllocationPp + 0.5))
    expect(refusal).toMatch(/more than you chose/)
  })

  it('a zero-cent consented leg cannot poison the fact with a non-finite ratio (kills plan-legs:419 > → >=)', () => {
    // consented AAA composed at 0 cents leaves consentedCents 0 while its
    // consentedPct is 100 — the divide-anyway mutant turns its ratio into NaN,
    // a non-finite number in a fact the policy and the sort both read
    const fact = concentrationOf(
      [{ symbol: 'AAA', asset: '0xaaa', weightPct: 100 }],
      [{ asset: '0xaaa', budgetUsdCents: 0 }, { asset: '0xbbb', budgetUsdCents: 500 }],
    )
    for (const r of fact.rows) expect(r.ratio === null || Number.isFinite(r.ratio)).toBe(true)
    // and the unconsented leg that took the whole batch still refuses
    expect(concentrationRefusal(fact)).toMatch(/more than you chose/)
  })
})

describe('the flip-eve survivor round (2026-08-16) — the two real gaps', () => {
  it('a LONE leg whose depth reads ZERO stays skippable — zero depth is the read-failed class, and the lone-leg ruling must not claim it (kills plan-legs:186 <= → <)', () => {
    // the module's own comment leaves this interaction on the owner's desk: an
    // unmeasurable market must not become the leg the whole batch is REQUIRED
    // to fill. liquidityUsd: 0 is "could not read", never "read shallow".
    const solo = planToLegs([T('SOLO', 100, { liquidityUsd: 0 })], 100_000)
    expect(solo.legs).toHaveLength(1)
    expect(solo.legs[0].optional).toBe(true)
  })

  it('a ZERO-WEIGHT target is not "an asset you asked for" — excludedCount ignores it (kills plan-legs:462 > → >=)', () => {
    const c = concentrationOf(
      [
        { symbol: 'A', asset: '0xa', weightPct: 60 },
        { symbol: 'B', asset: '0xb', weightPct: 40 },
        { symbol: 'Z', asset: '0xz', weightPct: 0 },
      ],
      [
        { asset: '0xa', budgetUsdCents: 6_000 },
        { asset: '0xb', budgetUsdCents: 4_000 },
      ],
    )
    expect(c.excludedCount).toBe(0)
  })
})
