import { describe, expect, it } from 'vitest'
import { S_MAX_BPS, S_MAX_THIN_BPS, deriveLegFloors, selfImpactBps, singleSwapImpactBps, type FloorLegInput } from './floor-discipline'

// The tests are named after the attack or the mistake, not the function —
// this file IS the security control, so it should read as one.

const leg = (over: Partial<FloorLegInput> = {}): FloorLegInput => ({
  key: 'WETH',
  quotedBuyAmount: 1_000_000n,
  notional: 1_000,
  marketSlippageBps: 30,
  buyTokenTaxBps: 0,
  ...over,
})

describe('rule 1 — the floor derives from the QUOTE, and is never zero', () => {
  it('floors at buyAmount × (1 − s)', () => {
    const { legs } = deriveLegFloors([leg({ marketSlippageBps: 100 })], { hopReserve: 1e9 })
    // 100 bps market + ~0 self-impact on a deep hop + 0 tax
    expect(legs[0].sBps).toBe(100)
    expect(legs[0].minBuyAmount).toBe(990_000n)
  })

  it('refuses a leg whose floor would round to zero — the 1-wei case by another route', () => {
    const { legs, refusals } = deriveLegFloors([leg({ quotedBuyAmount: 1n, marketSlippageBps: 9_000 })], { hopReserve: 1e9 })
    expect(legs).toHaveLength(0)
    expect(refusals[0].reason).toMatch(/exceeds-s-max|floor-rounds-to-zero/)
  })

  it('never emits a zero or negative floor for any accepted leg', () => {
    const many = Array.from({ length: 25 }, (_, i) => leg({ key: `A${i}`, quotedBuyAmount: BigInt(1_000 + i) }))
    const { legs } = deriveLegFloors(many, { hopReserve: 5e5 })
    for (const l of legs) expect(l.minBuyAmount).toBeGreaterThan(0n)
  })
})

describe('rule 2 — an UNMEASURED input is refused, never assumed', () => {
  it('refuses unmeasured pool depth rather than guessing a slippage', () => {
    const { legs, refusals } = deriveLegFloors([leg({ marketSlippageBps: null })], { hopReserve: 1e9 })
    expect(legs).toHaveLength(0)
    expect(refusals[0].reason).toBe('unmeasured-market-slippage')
  })

  it('an UNKNOWN tax composes at the TIGHT untaxed floor — the open long tail is buyable (the owner, 2026-08-15)', () => {
    // Superseded the refuse-on-unknown posture: "we can never track all
    // tokens." Fail-closed remains: the floor assumes zero tax, so a token
    // that actually taxes lands under it on-chain and skips/reverts —
    // MinBuyNotMet — never an under-delivered fill.
    const unknown = deriveLegFloors([leg({ buyTokenTaxBps: null, marketSlippageBps: 20 })], { hopReserve: 1e9 })
    const vetted = deriveLegFloors([leg({ buyTokenTaxBps: 0, marketSlippageBps: 20 })], { hopReserve: 1e9 })
    expect(unknown.refusals).toHaveLength(0)
    expect(unknown.legs).toHaveLength(1)
    expect(unknown.legs[0].minBuyAmount).toBe(vetted.legs[0].minBuyAmount) // tight, identical to untaxed
  })

  it('a claimed tax that is NONSENSE still refuses — null is unknown, NaN is hostile', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const { legs, refusals } = deriveLegFloors([leg({ buyTokenTaxBps: bad })], { hopReserve: 1e9 })
      expect(legs).toHaveLength(0)
      expect(refusals[0].reason).toBe('unknown-buy-token-tax')
    }
  })

  it('refuses an unreadable shared hop — an unmeasured hop is not a deep hop', () => {
    for (const bad of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { legs, refusals } = deriveLegFloors([leg()], { hopReserve: bad as number })
      expect(legs).toHaveLength(0)
      expect(refusals[0].reason).toBe('unreadable-hop-reserve')
    }
  })
})

describe('rule 3 — self-impact grows along the batch, and a constant s is wrong', () => {
  it('matches the closed form and is zero only for the first leg', () => {
    expect(selfImpactBps(0, 250_000)).toBe(0)
    expect(selfImpactBps(5_000, 250_000)!).toBeGreaterThan(0)
  })

  it('reproduces their measured shape: later legs need MORE room than earlier ones', () => {
    const legs = Array.from({ length: 8 }, (_, i) => leg({ key: `L${i}`, notional: 1_250, marketSlippageBps: 10 }))
    const { legs: out } = deriveLegFloors(legs, { hopReserve: 250_000, sMaxBps: 10_000 })
    const s = out.map((l) => l.breakdown.selfImpactBps)
    expect(s[0]).toBe(0)
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1])
    // 8 x $1,250 over a $250k hop: their table says the LAST leg is ~662 bps
    // against its own quote. Ours is the cumulative-before term, so the last
    // leg's own figure lands in that neighbourhood rather than at zero.
    expect(s[s.length - 1]).toBeGreaterThan(400)
  })

  it('A THIN HOP IS THE DANGEROUS CASE: $50k hop drives legs past the cap and they are refused', () => {
    const legs = Array.from({ length: 32 }, (_, i) => leg({ key: `L${i}`, notional: 312, marketSlippageBps: 10 }))
    const deep = deriveLegFloors(legs, { hopReserve: 250_000 })
    const thin = deriveLegFloors(legs, { hopReserve: 50_000 })
    // the thin hop must submit strictly fewer legs — the rest are refused, not
    // silently floored at something that does not protect them
    expect(thin.legs.length).toBeLessThan(deep.legs.length)
    expect(thin.refusals.some((r) => r.reason === 'exceeds-s-max')).toBe(true)
  })

  it('a REFUSED leg does not move the hop for the legs after it', () => {
    const withRefusal = deriveLegFloors(
      [leg({ key: 'bad', marketSlippageBps: null, notional: 100_000 }), leg({ key: 'good', notional: 1_000 })],
      { hopReserve: 250_000 },
    )
    const alone = deriveLegFloors([leg({ key: 'good', notional: 1_000 })], { hopReserve: 250_000 })
    // the refused leg never executes, so it cannot inflate 'good'
    expect(withRefusal.legs[0].sBps).toBe(alone.legs[0].sBps)
  })
})

describe('rule 4 — a fee-on-transfer buyToken CANNOT be floored here, so it is refused', () => {
  // ⚠ THIS TEST PREVIOUSLY PINNED THE DEFECT. It asserted the taxed floor was
  // LOWER than the untaxed one and was named as if that cured looseness. It did
  // the opposite: the contract floors on what the swap produced BEFORE the
  // forward, so lowering the floor by the tax handed the route extra room and
  // the skim then applied on top — measured at 394 bps of unprotected value on
  // a leg certified inside the 300-bps cap. The honest floor would be
  // Q(1−s)/(1−tax), which sits ABOVE the quote for any real tax; rule 5's logic
  // then says refuse rather than promise a number we cannot hold.
  it('a taxed token is REFUSED, and the untaxed one still floors', () => {
    const plain = deriveLegFloors([leg({ marketSlippageBps: 20, buyTokenTaxBps: 0 })], { hopReserve: 1e9 })
    expect(plain.legs[0].sBps).toBe(20)
    for (const tax of [1, 200, 500]) {
      const taxed = deriveLegFloors([leg({ marketSlippageBps: 20, buyTokenTaxBps: tax })], { hopReserve: 1e9, sMaxBps: 10_000 })
      expect(taxed.legs, `tax ${tax} must not compose`).toHaveLength(0)
      expect(taxed.refusals[0].reason).toBe('buy-token-taxes-the-forward')
    }
  })
  it('NO TAX EVER LOOSENS A FLOOR — and this time the assertion actually RUNS', () => {
    // ⚠ THE FIRST VERSION OF THIS TEST WAS VACUOUS and review caught it: it
    // looped `for (const l of t.legs)` where `t.legs` is empty for every taxed
    // input, so it executed ZERO assertions while its name claimed a property.
    // That is the tautology class this lane's protocol exists to prevent, and I
    // wrote it in the commit that cited the rule. Asserted directly now.
    const base = deriveLegFloors([leg({ marketSlippageBps: 20, buyTokenTaxBps: 0 })], { hopReserve: 1e9 })
    expect(base.legs).toHaveLength(1)
    let checked = 0
    for (const tax of [1, 50, 200, 500, 9_000]) {
      const t = deriveLegFloors([leg({ marketSlippageBps: 20, buyTokenTaxBps: tax })], { hopReserve: 1e9, sMaxBps: 10_000 })
      // a taxed leg either does not ship, or ships no looser than the untaxed one
      if (t.legs.length === 0) {
        expect(t.refusals[0].reason).toBe('buy-token-taxes-the-forward')
      } else {
        expect(t.legs[0].minBuyAmount).toBeGreaterThanOrEqual(base.legs[0].minBuyAmount)
      }
      checked += 1
    }
    expect(checked, 'the loop must actually run').toBe(5)
  })
  it('A-8: AN UNUSABLE CAP REFUSES — it must never be widened to the default', () => {
    // ⚠ MY OWN FIX FOR THE NaN HOLE INTRODUCED A LOOSENING, caught by review:
    // `> 0 ? cap : DEFAULT` silently widened a cap of 0 or -5 up to 300, so a
    // 250-bps leg that REFUSED before the fix SHIPPED after it. The fixture used
    // then (market 5,000) refused under both semantics and could not see it —
    // the same can-the-harness-express-the-failure mistake, twice in one night.
    // This fixture uses 250, which is the value that distinguishes them.
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY, 10_001]) {
      const { legs, refusals } = deriveLegFloors(
        [leg({ marketSlippageBps: 250 })],
        { hopReserve: 1e9, sMaxBps: bad as number },
      )
      expect(legs, `cap ${String(bad)} must not ship a leg`).toHaveLength(0)
      expect(refusals[0].reason, `cap ${String(bad)}`).toBe('unusable-cap')
    }
    // an ABSENT cap is a different question and still takes the product default
    const absent = deriveLegFloors([leg({ marketSlippageBps: 250 })], { hopReserve: 1e9 })
    expect(absent.legs).toHaveLength(1)
    // and a cap ABOVE the leg's need still ships it
    const generous = deriveLegFloors([leg({ marketSlippageBps: 250 })], { hopReserve: 1e9, sMaxBps: 400 })
    expect(generous.legs).toHaveLength(1)
  })
})

describe('rule 5 — the cap is a REFUSAL, never a clamp', () => {
  it('a leg needing more room than the cap is dropped, and says by how much', () => {
    const { legs, refusals } = deriveLegFloors([leg({ marketSlippageBps: S_MAX_BPS + 50 })], { hopReserve: 1e9 })
    expect(legs).toHaveLength(0)
    expect(refusals[0].reason).toBe('exceeds-s-max')
    expect(refusals[0].neededBps).toBe(S_MAX_BPS + 50)
  })

  it('NEVER emits a leg whose tolerance exceeds the cap — the property that matters', () => {
    const legs = Array.from({ length: 40 }, (_, i) =>
      leg({ key: `L${i}`, notional: 2_000, marketSlippageBps: 40 + i, buyTokenTaxBps: i % 3 === 0 ? 100 : 0 }),
    )
    for (const reserve of [1e9, 250_000, 50_000, 10_000]) {
      const { legs: out } = deriveLegFloors(legs, { hopReserve: reserve })
      for (const l of out) expect(l.sBps).toBeLessThanOrEqual(S_MAX_BPS)
    }
  })

  it('a clamp would have produced a floor here; we produce nothing instead', () => {
    // market-only now (a tax refuses earlier and for its own reason), so this
    // still exercises the CAP rather than the tax path
    const { legs, refusals } = deriveLegFloors(
      [leg({ marketSlippageBps: 450, buyTokenTaxBps: 0 })],
      { hopReserve: 1e9 },
    )
    expect(legs).toHaveLength(0)
    expect(refusals[0].neededBps).toBe(450)
    expect(refusals[0].message).toMatch(/does not protect/)
  })
})

describe('hostile numbers reach this module the same as any other money path', () => {
  const HOSTILE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1e21]
  it('emits only finite bps and positive floors, or refuses with a sentence', () => {
    for (const h of HOSTILE) {
      for (const plan of [
        deriveLegFloors([leg({ marketSlippageBps: h })], { hopReserve: 250_000 }),
        deriveLegFloors([leg({ buyTokenTaxBps: h })], { hopReserve: 250_000 }),
        deriveLegFloors([leg({ notional: h }), leg({ key: 'next' })], { hopReserve: 250_000 }),
        deriveLegFloors([leg()], { hopReserve: h }),
      ]) {
        for (const l of plan.legs) {
          expect(Number.isFinite(l.sBps)).toBe(true)
          expect(l.sBps).toBeLessThanOrEqual(S_MAX_BPS)
          expect(l.minBuyAmount).toBeGreaterThan(0n)
        }
        for (const r of plan.refusals) expect(r.message.length).toBeGreaterThan(20)
      }
    }
  })

  it('a hostile notional cannot poison the legs that follow it', () => {
    const { legs } = deriveLegFloors(
      [leg({ key: 'a', notional: Number.NaN }), leg({ key: 'b', notional: 1_000 }), leg({ key: 'c', notional: 1_000 })],
      { hopReserve: 250_000 },
    )
    for (const l of legs) expect(Number.isFinite(l.breakdown.selfImpactBps)).toBe(true)
  })
})

describe('singleSwapImpactBps — the own-size term (rule 2)', () => {
  it('a swap the size of the funding-side reserve loses half its spot expectation', () => {
    // liquidity $1M both sides → funding side $500k; v = $500k → v/(R+v) = 0.5
    expect(singleSwapImpactBps(500_000, 1_000_000)).toBe(5_000)
  })
  it('a tiny swap against a deep pool rounds UP to 1 bp, never to a flattering 0', () => {
    expect(singleSwapImpactBps(100, 10_000_000)).toBe(1)
  })
  it('zero notional is zero impact — the only honest 0', () => {
    expect(singleSwapImpactBps(0, 1_000_000)).toBe(0)
  })
  it('unreadable depth is null, never a guess', () => {
    expect(singleSwapImpactBps(1_000, null)).toBeNull()
    expect(singleSwapImpactBps(1_000, 0)).toBeNull()
    expect(singleSwapImpactBps(1_000, -5)).toBeNull()
    expect(singleSwapImpactBps(1_000, Number.NaN)).toBeNull()
    expect(singleSwapImpactBps(1_000, Number.POSITIVE_INFINITY)).toBeNull()
  })
  it('an unreadable notional is null — NaN money never becomes a floor input', () => {
    expect(singleSwapImpactBps(Number.NaN, 1_000_000)).toBeNull()
    expect(singleSwapImpactBps(-1, 1_000_000)).toBeNull()
    expect(singleSwapImpactBps(Number.POSITIVE_INFINITY, 1_000_000)).toBeNull()
  })
})

describe('unreadable-quote — the guard the gate found unasserted', () => {
  // The reason existed and fired; nothing ever proved it. An unproven guard is
  // the contracts lane's GATE 1 class: it reads as protection in review while
  // its reachability is nobody's knowledge. Gate A2 now demands the assertion.
  it('a quote that is absent, zero, negative or the wrong TYPE refuses by name, and never floors', () => {
    for (const quotedBuyAmount of [0n, -1n, undefined, null, 500, '500'] as unknown[]) {
      const { legs, refusals } = deriveLegFloors(
        [{ key: 'a', quotedBuyAmount: quotedBuyAmount as bigint, notional: 100, marketSlippageBps: 30, buyTokenTaxBps: 0 }],
        { hopReserve: 1_000_000 },
      )
      expect(legs, `quote ${String(quotedBuyAmount)} must not floor`).toHaveLength(0)
      expect(refusals[0].reason).toBe('unreadable-quote')
      expect(refusals[0].message.length).toBeGreaterThan(0)
    }
  })
  it('a leg that IS floorable still floors, so the guard is not simply refusing everything', () => {
    const { legs } = deriveLegFloors(
      [{ key: 'a', quotedBuyAmount: 1_000_000n, notional: 100, marketSlippageBps: 30, buyTokenTaxBps: 0 }],
      { hopReserve: 1_000_000 },
    )
    expect(legs).toHaveLength(1)
  })
})

describe('exact boundaries — the mutation sweep’s six survivors, each now a chosen line (A12)', () => {
  const LEG = (over: Record<string, unknown> = {}) => ({
    key: '0xa',
    quotedBuyAmount: 1_000_000n,
    notional: 1_000,
    marketSlippageBps: 30,
    buyTokenTaxBps: 0,
    ...over,
  })

  it('a ZERO hop reserve is unreadable, not a thin hop — and exactly zero is the boundary', () => {
    // hopReserve <= 0 → selfImpact null → every leg refuses unreadable-hop
    const z = deriveLegFloors([LEG()] as never, { hopReserve: 0, sMaxBps: 300 })
    expect(z.refusals.some((r) => r.reason === 'unreadable-hop-reserve')).toBe(true)
    // …and the smallest positive reserve is a REAL (terrible) hop: it may
    // refuse for exceeding s-max, but never for being unreadable
    const tiny = deriveLegFloors([LEG()] as never, { hopReserve: 1e-9, sMaxBps: 300 })
    expect(tiny.refusals.some((r) => r.reason === 'unreadable-hop-reserve')).toBe(false)
  })

  it('a NEGATIVE market slippage is unmeasured; EXACTLY zero is a real, perfect market', () => {
    const neg = deriveLegFloors([LEG({ marketSlippageBps: -1 })] as never, { hopReserve: 50_000_000, sMaxBps: 300 })
    expect(neg.refusals.some((r) => r.reason === 'unmeasured-market-slippage')).toBe(true)
    const zero = deriveLegFloors([LEG({ marketSlippageBps: 0 })] as never, { hopReserve: 50_000_000, sMaxBps: 300 })
    expect(zero.refusals.some((r) => r.reason === 'unmeasured-market-slippage')).toBe(false)
  })

  it('sBps EXACTLY at s-max ships; one past refuses — "exceeds" means exceeds', () => {
    // deep hop ⇒ self-impact ~0; tax 0 ⇒ sBps = market. sMax = that exactly.
    const at = deriveLegFloors([LEG({ marketSlippageBps: 300 })] as never, { hopReserve: 50_000_000_000, sMaxBps: 300 })
    expect(at.refusals).toEqual([])
    const past = deriveLegFloors([LEG({ marketSlippageBps: 301 })] as never, { hopReserve: 50_000_000_000, sMaxBps: 300 })
    expect(past.refusals.some((r) => r.reason === 'exceeds-s-max')).toBe(true)
  })

  it('a floor that rounds to EXACTLY zero refuses; one raw unit of protection ships', () => {
    // quote 1n at 30bps: floor = 1×(10000−s)/10000 → 0 → refuse
    const zero = deriveLegFloors([LEG({ quotedBuyAmount: 1n })] as never, { hopReserve: 50_000_000_000, sMaxBps: 300 })
    expect(zero.refusals.some((r) => r.reason === 'floor-rounds-to-zero' || /zero/.test(r.message))).toBe(true)
    // a big quote keeps a positive floor
    const one = deriveLegFloors([LEG()] as never, { hopReserve: 50_000_000_000, sMaxBps: 300 })
    expect(one.legs[0]?.minBuyAmount ?? 0n).toBeGreaterThan(0n)
  })

  it('a ZERO-notional leg adds nothing to the shared-hop accumulation — and a NaN notional adds nothing, not everything', () => {
    // two legs: first zero-notional, second real. If zero (or NaN) leaked into
    // `cumulative`, the second leg's self-impact would shift — pin equality
    // against a run where the first leg is absent.
    const dirtyZero = deriveLegFloors([LEG({ key: '0x1', notional: 0 }), LEG({ key: '0x2' })] as never, { hopReserve: 100_000, sMaxBps: 5_000 })
    const dirtyNaN = deriveLegFloors([LEG({ key: '0x1', notional: Number.NaN }), LEG({ key: '0x2' })] as never, { hopReserve: 100_000, sMaxBps: 5_000 })
    const clean = deriveLegFloors([LEG({ key: '0x2' })] as never, { hopReserve: 100_000, sMaxBps: 5_000 })
    const floorOf = (r: ReturnType<typeof deriveLegFloors>) => r.legs.find((l) => l.key === '0x2')?.minBuyAmount
    expect(floorOf(dirtyZero)).toBe(floorOf(clean))
    expect(floorOf(dirtyNaN)).toBe(floorOf(clean))
    // …and a NEGATIVE notional adds nothing (it is the case that separates
    // the guard from `isFinite || > 0`, which would subtract shared-hop room)
    const dirtyNeg = deriveLegFloors([LEG({ key: '0x1', notional: -500 }), LEG({ key: '0x2' })] as never, { hopReserve: 100_000, sMaxBps: 5_000 })
    expect(floorOf(dirtyNeg)).toBe(floorOf(clean))
  })
})

describe('the refusal nobody had read back (M12)', () => {
  it('a leg with no usable quote says so — no honest floor can be built for it', () => {
    const r = deriveLegFloors(
      [{ key: '0xa', quotedBuyAmount: 0n, notional: 1_000, marketSlippageBps: 30, buyTokenTaxBps: 0 }] as never,
      { hopReserve: 50_000_000, sMaxBps: 300 },
    )
    expect(r.refusals.some((x) => x.reason === 'unreadable-quote')).toBe(true)
    expect(r.refusals.find((x) => x.reason === 'unreadable-quote')!.message).toMatch(/No usable quote for this leg, so no honest floor/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PER-LEG CEILING — the owner's thin-market ruling, live 2026-08-15, after
// three on-chain RequiredLegFailed reverts on a $3,154 $LNOC leg. The measured
// case: that pool's quote moved 854 bps peak-to-trough in four minutes, 722 of
// it inside ONE 12-second interval. These pin the two directions that matter —
// the widening is real where it was ruled, and it reaches NOTHING else.
// ─────────────────────────────────────────────────────────────────────────────
describe('the per-leg ceiling (the owner’s thin-market ruling) widens exactly one thing', () => {
  it('a leg carrying its own wider ceiling composes where the batch cap alone would refuse', () => {
    const thin = leg({ marketSlippageBps: 900, sMaxBps: S_MAX_THIN_BPS })
    const { legs, refusals } = deriveLegFloors([thin], { hopReserve: 1e9 })
    expect(refusals).toHaveLength(0)
    expect(legs[0].sBps).toBe(900)
    // and the SAME leg without the ceiling still refuses — the widening comes
    // from the caller's measurement, never from the module deciding on its own
    const { legs: none, refusals: refused } = deriveLegFloors([leg({ marketSlippageBps: 900 })], { hopReserve: 1e9 })
    expect(none).toHaveLength(0)
    expect(refused[0].reason).toBe('exceeds-s-max')
  })

  it('the wider ceiling does NOT leak to the legs beside it in the same batch', () => {
    const { legs, refusals } = deriveLegFloors(
      [leg({ key: 'THIN', marketSlippageBps: 900, sMaxBps: S_MAX_THIN_BPS }), leg({ key: 'DEEP', marketSlippageBps: 400 })],
      { hopReserve: 1e9 },
    )
    expect(legs.map((l) => l.key)).toEqual(['THIN'])
    // the deep leg is held to the batch cap exactly as before the ruling
    expect(refusals.find((r) => r.key === 'DEEP')!.reason).toBe('exceeds-s-max')
    expect(refusals.find((r) => r.key === 'DEEP')!.message).toContain(`${S_MAX_BPS} bps cap`)
  })

  it('a ceiling BELOW the batch cap tightens rather than widens — direction is the caller’s to choose', () => {
    const { legs, refusals } = deriveLegFloors([leg({ marketSlippageBps: 200, sMaxBps: 100 })], { hopReserve: 1e9 })
    expect(legs).toHaveLength(0)
    expect(refusals[0].reason).toBe('exceeds-s-max')
    expect(refusals[0].neededBps).toBe(200)
  })

  it('a ceiling of EXACTLY 10,000 bps is usable — the bound is inclusive, as it is for the batch cap', () => {
    // the mutant this kills flips `<= 10_000` to `< 10_000`, which would make
    // the widest legal ceiling read as unreadable and refuse the leg
    const { legs, refusals } = deriveLegFloors([leg({ marketSlippageBps: 30, sMaxBps: 10_000 })], { hopReserve: 1e9 })
    expect(refusals).toHaveLength(0)
    expect(legs[0].sBps).toBe(30)
  })

  it('an UNUSABLE per-leg ceiling refuses that leg — never a silent fall back to a laxer cap', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10_001]) {
      const { legs, refusals } = deriveLegFloors([leg({ marketSlippageBps: 30, sMaxBps: bad })], { hopReserve: 1e9 })
      expect(legs).toHaveLength(0)
      expect(refusals[0].reason).toBe('unusable-cap')
    }
  })

  it('an unusable ceiling on ONE leg does not take the batch down with it', () => {
    const { legs, refusals } = deriveLegFloors(
      [leg({ key: 'BAD', marketSlippageBps: 30, sMaxBps: Number.NaN }), leg({ key: 'GOOD', marketSlippageBps: 30 })],
      { hopReserve: 1e9 },
    )
    expect(legs.map((l) => l.key)).toEqual(['GOOD'])
    expect(refusals.map((r) => r.key)).toEqual(['BAD'])
  })

  it('EXACTLY AT the ceiling composes; one bps over refuses (the boundary a clamp would blur)', () => {
    const at = deriveLegFloors([leg({ marketSlippageBps: S_MAX_THIN_BPS, sMaxBps: S_MAX_THIN_BPS })], { hopReserve: 1e9 })
    expect(at.legs).toHaveLength(1)
    expect(at.legs[0].sBps).toBe(S_MAX_THIN_BPS)
    const over = deriveLegFloors([leg({ marketSlippageBps: S_MAX_THIN_BPS + 1, sMaxBps: S_MAX_THIN_BPS })], { hopReserve: 1e9 })
    expect(over.legs).toHaveLength(0)
    expect(over.refusals[0].reason).toBe('exceeds-s-max')
  })

  it('the ceiling still bounds the FLOOR, so a wider tolerance is still a real number', () => {
    const { legs } = deriveLegFloors([leg({ quotedBuyAmount: 1_000_000n, marketSlippageBps: 1_000, sMaxBps: S_MAX_THIN_BPS })], { hopReserve: 1e9 })
    // 1,000 bps of tolerance = a floor at 90% of the quote, not "no floor"
    expect(legs[0].minBuyAmount).toBe(900_000n)
  })

  it('a leg with NO ceiling behaves bit-for-bit as it did before the ruling', () => {
    const before = deriveLegFloors([leg({ marketSlippageBps: 250 })], { hopReserve: 50_000 })
    const after = deriveLegFloors([leg({ marketSlippageBps: 250, sMaxBps: S_MAX_BPS })], { hopReserve: 50_000 })
    expect(after.legs[0].minBuyAmount).toBe(before.legs[0].minBuyAmount)
    expect(after.legs[0].sBps).toBe(before.legs[0].sBps)
  })
})
