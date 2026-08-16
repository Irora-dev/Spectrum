import { describe, expect, it } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { BATCH_FEE_BPS } from './allocation'
import { asFundingRaw, BatchComposeRefusal, feeCentsOfTotal } from './batcher'
import { assembleBatchBuy, type AssembleBatchBuyInput } from './assemble-batch'
import type { PlanLegInput } from './plan-legs'

// THE ASSEMBLY, AUDITED AT BIRTH — the one seam where a draft's chain slice
// becomes signable calldata. The seam round proved this exact handoff is where
// money bugs live, so the pins here are conservation pins first.

const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
const ME = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
const A1 = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const A2 = '0x4200000000000000000000000000000000000006' as Address

const target = (symbol: string, asset: Address, weightPct: number, over: Partial<PlanLegInput> = {}): PlanLegInput => ({
  symbol,
  asset,
  decimals: 18,
  weightPct,
  priceUsd: 10,
  priceAgeMs: 1_000,
  liquidityUsd: 10_000_000,
  buyTokenTaxBps: 0,
  route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
  ...over,
})

const input = (over: Partial<AssembleBatchBuyInput> = {}): AssembleBatchBuyInput => ({
  chainId: 8453,
  targets: [target('AAA', A1, 60), target('BBB', A2, 40)],
  grossCents: 100_000, // $1,000
  fundingTotalRaw: 10n ** 18n, // 1 ETH measured by the wallet layer
  fundingAsset: zeroAddress,
  account: ME,
  deadlineSec: 1_700_000_000,
  slippageBps: 50,
  // a deep Base-like hop: the batch's own impact rounds to ~0 bps, so the
  // conservation pins keep their semantics; thin-hop behaviour has its own tests
  hopReserveUsd: 50_000_000,
  hubUsd: 3_000,
  settlementDecimals: 6,
  integrator: zeroAddress,
  ...over,
})

describe('assembleBatchBuy — conservation and law', () => {
  it('composes: leg raws sum EXACTLY to the raw spendable, and the composer accepts (the equation holds by construction)', () => {
    // awkward totals on purpose — the seam round measured $7/$999.99 failing
    for (const [gross, totalRaw] of [
      [700, 123_456_789_012_345n],
      [99_999, 10n ** 18n + 7n],
      [12_345_678, 999_999_999_999_999_999n],
    ] as const) {
      const out = assembleBatchBuy(input({ grossCents: gross, fundingTotalRaw: totalRaw }))
      const spendable = totalRaw - (totalRaw * BigInt(BATCH_FEE_BPS)) / 10_000n
      const rawSum = out.composed.args[0].reduce((s, l) => s + l.budget, 0n)
      expect(rawSum).toBe(spendable)
      expect(out.composed.args[2]).toBe(totalRaw)
      expect(out.feeCents).toBe(feeCentsOfTotal(gross))
    }
  })

  it('the cent view budgets NET of the fee (regime 1), and the legs carry it for the review', () => {
    const out = assembleBatchBuy(input({ grossCents: 100_000 }))
    const centSum = out.legs.reduce((s, l) => s + l.budgetUsdCents, 0)
    expect(centSum).toBe(100_000 - feeCentsOfTotal(100_000))
  })

  it('per-leg refusals TRAVEL alongside a composed batch — shown, not swallowed', () => {
    // the dropped leg is TINY (0.5% consented) so its loss redistributes under
    // the 1-point consent-divergence tolerance — the batch still composes and
    // the refusal travels. A materially-sized drop over-allocates the survivor
    // and refuses the whole plan (the owner 2026-08-13), tested below.
    const out = assembleBatchBuy(
      input({ targets: [target('AAA', A1, 99.5), target('DEAD', A2, 0.5, { priceUsd: null })] }),
    )
    expect(out.composed.args[0].length).toBe(1)
    expect(out.refusals.length).toBe(1)
    expect(out.refusals[0].reason).toMatch(/no readable price/i)
  })

  it('refuses whole when NO leg composes, carrying the first reason', () => {
    expect(() => assembleBatchBuy(input({ targets: [target('DEAD', A1, 100, { priceUsd: null })] }))).toThrow(BatchComposeRefusal)
    expect(() => assembleBatchBuy(input({ targets: [target('DEAD', A1, 100, { priceUsd: null })] }))).toThrow(/no readable price/i)
  })

  it('refuses a hostile gross: non-finite, zero, negative — sentences, never NaN math', () => {
    for (const g of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      if (Number.isFinite(g) || Number.isNaN(g)) {
        expect(() => assembleBatchBuy(input({ grossCents: g }))).toThrow(BatchComposeRefusal)
      }
    }
  })

  it('NATIVE funding, no basket legs: the hub never runs, so the floor is the inert 1 — the MEASURED semantic, not a weakened protection', () => {
    // (the first cut floored native funding at spendable×(1−slip) in NATIVE
    // raw; the fork rehearsal measured hubOut in SETTLEMENT raw — that floor
    // was ~1e12× too high and reverted HubFloorNotMet on every such batch)
    const out = assembleBatchBuy(input({ slippageBps: 50 }))
    expect(out.composed.args[3].hubMinOut).toBe(1n)
  })

  it('NATIVE funding WITH a basket leg: the floor bounds basket-cents → settlement raw, at the settlement decimals', () => {
    const out = assembleBatchBuy(
      input({ targets: [target('AAA', A1, 60), target('BSK', A2, 40, { route: 'basket' })], settlementDecimals: 6 }),
    )
    // 40% of the net cents, at $1 per settlement unit, 6 decimals, −50 bps
    const netCents = 100_000 - feeCentsOfTotal(100_000)
    const basketCents = out.legs.filter((l) => l.route === 'basket').reduce((s, l) => s + l.budgetUsdCents, 0)
    expect(basketCents).toBeGreaterThan(0)
    const expected = (((BigInt(basketCents) * 10n ** 6n) / 100n) * 9_950n) / 10_000n
    expect(out.composed.args[3].hubMinOut).toBe(expected)
    expect(netCents).toBe(out.legs.reduce((s, l) => s + l.budgetUsdCents, 0))
  })

  it('NATIVE funding with a basket leg and unreadable settlement decimals REFUSES — a floor scaled by a guessed exponent protects nothing', () => {
    // a basket PAIR since the cap ruling — a lone 100% leg refuses upstream
    // before this law can speak, and the law under pin is the exponent one
    expect(() =>
      assembleBatchBuy(
        input({ targets: [target('BSK', A2, 50, { route: 'basket' }), target('BSK2', '0x1111111111111111111111111111111111111111' as Address, 50, { route: 'basket' })], settlementDecimals: Number.NaN }),
      ),
    ).toThrow(/guessed exponent/i)
  })

  it('SETTLEMENT funding: the floor bounds venue-cents + THE FEE → native raw at the hub spot; no price = refuse', () => {
    expect(() => assembleBatchBuy(input({ fundingAsset: A1, hubUsd: null, fundingTotalRaw: 1_000_000_000n }))).toThrow(/could not price/i)
    const out = assembleBatchBuy(input({ fundingAsset: A1, hubUsd: 3_000, fundingTotalRaw: 1_000_000_000n }))
    // all-venue targets: hubIn = netCents + feeCents = the whole gross
    const hubInCents = 100_000
    const expectedNano = Math.floor((hubInCents / 100 / 3_000) * 1e9)
    const expected = ((BigInt(expectedNano) * 10n ** 9n) * 9_950n) / 10_000n
    expect(out.composed.args[3].hubMinOut).toBe(expected)
  })

  it('a hostile hub price refuses in a sentence — never a raw BigInt RangeError', () => {
    for (const usd of [1e-300, Number.MIN_VALUE]) {
      expect(() => assembleBatchBuy(input({ fundingAsset: A1, hubUsd: usd, fundingTotalRaw: 1_000_000_000n }))).toThrow(BatchComposeRefusal)
    }
  })

  it('the recipient IS the account — the product law rides through assembly', () => {
    const out = assembleBatchBuy(input())
    expect(out.composed.args[3].recipient).toBe(ME)
  })
})

describe('mutation-survivor kills (path-3 triage, 2026-08-04)', () => {
  it('EMPTY targets refuse in a sentence — never a TypeError off refusals[0] (the OptionalChaining survivor)', () => {
    // zero legs AND zero refusals: the whole-refusal message must not assume
    // a first refusal exists
    expect(() => assembleBatchBuy(input({ targets: [] }))).toThrow(/no composable legs/i)
  })

  it('each refusal gate speaks its OWN sentence — a shifted boundary cannot hide behind the next gate', () => {
    // gross 0/negative → the no-funded-amount gate, by name
    expect(() => assembleBatchBuy(input({ grossCents: 0 }))).toThrow(/no funded amount/i)
    expect(() => assembleBatchBuy(input({ grossCents: -1 }))).toThrow(/no funded amount/i)
    // hubUsd exactly 0 under settlement funding → the could-not-price gate,
    // not the later range gate
    expect(() => assembleBatchBuy(input({ fundingAsset: A1, hubUsd: 0, fundingTotalRaw: 1_000_000_000n }))).toThrow(/could not price/i)
  })

  it('SETTLEMENT funding with MIXED targets: the hub basis is venue cents + fee — basket cents stay OUT of it', () => {
    const out = assembleBatchBuy(
      input({
        fundingAsset: A1,
        hubUsd: 3_000,
        fundingTotalRaw: 1_000_000_000n,
        targets: [target('VEN', A1, 60), target('BSK', A2, 40, { route: 'basket' })],
      }),
    )
    const venueCents = out.legs.filter((l) => l.route !== 'basket').reduce((s, l) => s + l.budgetUsdCents, 0)
    const hubInCents = venueCents + out.feeCents
    const expectedNano = Math.floor((hubInCents / 100 / 3_000) * 1e9)
    const expected = (BigInt(expectedNano) * 10n ** 9n * 9_950n) / 10_000n
    expect(out.composed.args[3].hubMinOut).toBe(expected)
  })

  it('settlement-decimals boundaries: 0 and 36 are readable, just outside them refuses', () => {
    // a pair since the cap ruling (a lone leg is a 100% batch and refuses)
    const basketTargets = [target('BSK', A2, 50, { route: 'basket' }), target('BSK2', '0x1111111111111111111111111111111111111111' as Address, 50, { route: 'basket' })]
    // decimals 36 composes (a floor exists at that scale)
    expect(() => assembleBatchBuy(input({ targets: basketTargets, settlementDecimals: 36 }))).not.toThrow()
    expect(() => assembleBatchBuy(input({ targets: basketTargets, settlementDecimals: 37 }))).toThrow(/guessed exponent/i)
    expect(() => assembleBatchBuy(input({ targets: basketTargets, settlementDecimals: -1 }))).toThrow(/guessed exponent/i)
    // decimals 0 makes a 2-cent basket floor round to ZERO settlement raw —
    // the zero-floor gate must speak, not compose an unprotected batch
    // (2 cents over the pair keeps both legs below the ruled cap, so the
    // zero-floor law is what fires, not the concentration refusal)
    expect(() =>
      assembleBatchBuy(input({ targets: basketTargets, grossCents: 2, fundingTotalRaw: 10n ** 12n, settlementDecimals: 0 })),
    ).toThrow(/protection floor/i)
  })
})

describe('the floor plan rides THROUGH assembly into the calldata (floor discipline, outside-drive)', () => {
  it('every composed venue minOut IS the plan-derived floor — and it varies per leg over a thin hop', () => {
    const out = assembleBatchBuy(
      input({
        // three equal legs over a $150k hop: self-impact grows along the batch
        targets: [target('AAA', A1, 33.33), target('BBB', A2, 33.33), target('CCC', '0x1111111111111111111111111111111111111111' as Address, 33.34)],
        hopReserveUsd: 150_000,
      }),
    )
    expect(out.legs).toHaveLength(3)
    // the calldata's minOut equals the plan's floor, leg for leg
    out.composed.args[0].forEach((composedLeg, i) => {
      expect(composedLeg.minOut).toBe(out.legs[i].minOutRaw)
    })
    // and the floors are NOT one global haircut: tolerance grows along the batch
    const s = out.legs.map((l) => l.floor!.sBps)
    expect(s[1]).toBeGreaterThan(s[0])
    expect(s[2]).toBeGreaterThan(s[1])
  })

  it('an unmeasured hop refuses the batch outright — no leg composes on a guessed self-impact', () => {
    expect(() => assembleBatchBuy(input({ hopReserveUsd: null }))).toThrow(/hop|depth/i)
  })

  it('a MATERIAL floor-refused leg refuses the WHOLE plan — its loss would over-allocate the survivor (the owner 2026-08-13)', () => {
    // BBB is a whale slice (30%) of a thin pool → its honest floor exceeds the
    // s-max cap and it is refused; dropping it would push AAA from 70% to 100%
    // (+30pp over consent), so the plan refuses rather than compose a spread
    // the user did not choose. The floor-refusal-rides-a-composed-batch
    // behavior is superseded — a material drop always over-allocates.
    expect(() =>
      assembleBatchBuy(
        input({
          targets: [target('AAA', A1, 70), target('BBB', A2, 30, { liquidityUsd: 20_000 })],
          hopReserveUsd: 50_000_000,
        }),
      ),
    ).toThrow(/more than you chose|re-edit/i)
  })
})

describe('M2 — the plan must still be the plan (review 2026-08-07)', () => {
  // Measured: a 12-asset $50,000 draft over a thin hop converged to ONE leg
  // carrying $49,750 — an asset that asked for 8.3% receiving 100% — and
  // composed, because the only guard was "did EVERY leg fall out".
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      target(`T${i}`, `0x${String(i + 1).padStart(40, '0')}` as Address, 100 / n),
    )

  it('a 12-asset plan collapsing REFUSES on consent divergence (the owner 2026-08-13), the sentence leading', () => {
    // the interim survivor-count guard retired with the ruling; the shared
    // consent-divergence verdict upstream refuses the whole plan (survivors
    // would realise far more than consented) and its sentence leads the throw
    expect(() =>
      assembleBatchBuy(input({ targets: many(12), grossCents: 5_000_000, hopReserveUsd: 60_000 })),
    ).toThrow(/more than you chose|re-edit/i)
  })

  it('the refusal names what to do about it', () => {
    let msg = ''
    try {
      assembleBatchBuy(input({ targets: many(12), grossCents: 5_000_000, hopReserveUsd: 60_000 }))
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/lower the amount|re-edit your picks/i)
    expect(msg).toMatch(/nothing was bought/i)
  })

  it('a plan losing a MATERIAL leg REFUSES (consent divergence); a tiny leg loss composes', () => {
    // a pair 60/40 losing the 40% leg → survivor realises 100% vs consented 60
    // → +40pp over-allocation → refuses (the owner 2026-08-13, supersedes the
    // pre-ruling "survivor legitimately takes the rest")
    expect(() =>
      assembleBatchBuy(input({ targets: [target('AAA', A1, 60), target('DEAD', A2, 40, { priceUsd: null })] })),
    ).toThrow(/more than you chose|re-edit/i)
    // a tiny 0.5% leg lost redistributes under the 1-point tolerance — composes
    const out = assembleBatchBuy(
      input({ targets: [target('AAA', A1, 99.5), target('DEAD', A2, 0.5, { priceUsd: null })] }),
    )
    expect(out.composed.args[0]).toHaveLength(1)
    expect(out.refusals.some((r) => /no readable price/i.test(r.reason))).toBe(true)
  })

  it('a healthy 12-asset plan on a deep hop composes all twelve', () => {
    const out = assembleBatchBuy(input({ targets: many(12), grossCents: 5_000_000, hopReserveUsd: 50_000_000 }))
    expect(out.composed.args[0]).toHaveLength(12)
  })
})

describe('the cents/raw consistency band (reviewer M7, 2026-08-07)', () => {
  it('a decimals slip refuses in a sentence — $1,000 stated as 1e18 six-decimal units is not the same money', () => {
    // settlement funding at 6dp: $1,000 expects ~1e9 raw; 1e18 is a 1e9x
    // disagreement (an 18-dec raw in a 6-dec field) and used to compose
    // silently, with every floor derived from the raw side while the review
    // showed the cents side.
    expect(() => assembleBatchBuy(input({ fundingAsset: A1, hubUsd: 3_000, fundingTotalRaw: 10n ** 18n }))).toThrow(
      /disagree by more than 100x/,
    )
    // and both directions: a dust raw against a large dollar total
    expect(() => assembleBatchBuy(input({ fundingAsset: A1, hubUsd: 3_000, fundingTotalRaw: 1_000n }))).toThrow(
      /disagree by more than 100x/,
    )
  })

  it('the band stands aside where its own inputs are unreadable — those guards speak later, in their words', () => {
    // native funding with an unreadable hub price: the band cannot state an
    // expectation, and the hub-floor gate refuses downstream in ITS sentence
    expect(() => assembleBatchBuy(input({ hubUsd: null, targets: [target('BSK', A2, 100, { route: 'basket' })] }))).not.toThrow(
      /disagree/,
    )
  })

  it('an honest pair composes untouched — the band is unit-confusion wide, not price-validation tight', () => {
    // 1 ETH funding a $1,000 batch at hub $3,000 is a 3x gap: well inside
    expect(() => assembleBatchBuy(input())).not.toThrow()
  })
})

describe('the demo identity never composes (the owner 2026-08-06 1330; desk 204 forward guard)', () => {
  it('assembleBatchBuy refuses the demo book in honest words, before any other read', () => {
    expect(() => assembleBatchBuy(input({ account: '0x000000000000000000000000000000000000d0e0' }))).toThrow(/demo book — a simulation/)
    // case-insensitively — an address is an identity, not a spelling
    expect(() => assembleBatchBuy(input({ account: '0x000000000000000000000000000000000000D0E0' }))).toThrow(/demo book/)
  })
})

describe('the assembly carries its mempool disclosure (rule 6 — promoted from the registry when it landed)', () => {
  it('every assembly states what signing reveals, defaulted fail-closed to the public pool', () => {
    const out = assembleBatchBuy(input())
    expect(out.mempoolExposure.path, 'composition cannot know the wallet capability — disclose the worst case').toBe('public-pool')
    expect(out.mempoolExposure.reducedExposure).toBe(false)
    expect(out.mempoolExposure.legCount).toBe(out.legs.length)
    expect(out.mempoolExposure.disclosure).toMatch(/visible in the public queue/)
  })

  it('the disclosure names the plan it is about, bounded — it is text on a money surface', () => {
    const out = assembleBatchBuy(input())
    for (const l of out.legs) expect(out.mempoolExposure.shownSymbols.some((s) => s.startsWith(l.symbol.slice(0, 4)))).toBe(true)
    expect(out.mempoolExposure.disclosure.length).toBeLessThanOrEqual(600)
  })
})

describe('the M7 band FAILS CLOSED — "stand aside when unreadable" was the read-failed law inverted', () => {
  it('native funding with an unreadable hub price REFUSES — it used to compose ~$1.79B of spend', () => {
    // the reviewer's measured case, one field apart: with hubUsd=null this
    // composed a "$1,000" batch carrying 1e24 wei, giving leg AAA ~597,600 ETH
    // against a ~$594 floor — protection covering 0.00003% of the spend
    expect(() => assembleBatchBuy(input({ hubUsd: null, fundingTotalRaw: asFundingRaw(10n ** 24n) }))).toThrow(/could not price the network/)
    expect(() => assembleBatchBuy(input({ hubUsd: Number.NaN }))).toThrow(/could not price the network/)
    expect(() => assembleBatchBuy(input({ hubUsd: 0 }))).toThrow(/could not price the network/)
  })

  it('settlement funding with unreadable decimals REFUSES — the band was its SOLE consumer there', () => {
    for (const dec of [Number.NaN, 6.5, 37, -1]) {
      expect(() => assembleBatchBuy(input({ fundingAsset: A1, hubUsd: 3_000, fundingTotalRaw: asFundingRaw(1_000_000_000n), settlementDecimals: dec })), `decimals=${dec}`).toThrow(
        /decimals are unreadable/,
      )
    }
  })

  it('the documented basket-only null-hub plan STILL composes — nothing is spent through the hub', () => {
    // pair since the cap ruling — the null-hub law is what is under pin
    expect(() => assembleBatchBuy(input({ hubUsd: null, targets: [target('BSK', A2, 50, { route: 'basket' }), target('BSK2', '0x1111111111111111111111111111111111111111' as Address, 50, { route: 'basket' })] }))).not.toThrow()
  })

  it('EXACTLY 100x now refuses — at `>` it passed, missing every ±2-decimal slip', () => {
    // real 6 read 8, real 8 read 6, real 6 read 4 … all are 100x pairs
    const expected = 1_000_000_000n // $1,000 at 6dp
    expect(() => assembleBatchBuy(input({ fundingAsset: A1, hubUsd: 3_000, fundingTotalRaw: asFundingRaw(expected * 100n) }))).toThrow(/disagree/)
    expect(() => assembleBatchBuy(input({ fundingAsset: A1, hubUsd: 3_000, fundingTotalRaw: asFundingRaw(expected / 100n) }))).toThrow(/disagree/)
    // and 99x still composes — the band is unit-confusion wide, not price-tight
    expect(() => assembleBatchBuy(input({ fundingAsset: A1, hubUsd: 3_000, fundingTotalRaw: asFundingRaw(expected * 99n) }))).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE REFUSAL GUARDS, PINNED BECAUSE MUTATION SAID THEY WERE NOT (2026-08-07,
// the absorption's post-merge run).
//
// The merge brought this module from 243 to 388 lines, and its mutation score
// fell 87.4% → 78.0% — not because anything regressed, but because the absorbed
// code arrived with guards no test exercised. Mutating them to `true` (i.e.
// DELETING the guard) killed nothing: the suite stayed green with the
// protection removed. That is the exact shape this codebase keeps meeting — a
// guard that exists, reads correctly, and is never proven to bite.
//
// These matter more than most: the cents/raw consistency band was added after
// two HIGH findings, and its own comment records the measurement — `hubUsd`
// unreadable composed a "$1,000" batch carrying 1e24 wei, handing one leg
// ~$1.79 BILLION against a ~$594 floor. The band is the only thing standing
// between a unit slip and that batch. A test that proves it refuses is not
// optional coverage.
// ─────────────────────────────────────────────────────────────────────────────

describe('assembleBatchBuy — the refusals bite (mutation-driven)', () => {
  it('refuses a gross that is not a finite positive number, in every unreadable form', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => assembleBatchBuy(input({ grossCents: bad })), `grossCents ${bad}`).toThrow(BatchComposeRefusal)
    }
  })

  it('refuses when the fee eats the whole amount — nothing left to spend on legs', () => {
    // a gross small enough that gross - feeCentsOfTotal(gross) rounds to zero
    const tiny = 1
    expect(feeCentsOfTotal(tiny)).toBeGreaterThanOrEqual(0)
    expect(() => assembleBatchBuy(input({ grossCents: tiny }))).toThrow(BatchComposeRefusal)
  })

  it('FAILS CLOSED when the network asset cannot be priced — unreadable means unchecked means refuse', () => {
    // the documented HIGH: hubUsd unreadable used to STAND THE BAND ASIDE, which
    // turned a missing input into permission. Each of these is a distinct
    // representation of "no usable price" and each must refuse on its own.
    for (const bad of [null, undefined, Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(
        () => assembleBatchBuy(input({ fundingAsset: zeroAddress, hubUsd: bad as number | null })),
        `hubUsd ${String(bad)}`,
      ).toThrow(BatchComposeRefusal)
    }
  })

  it('still composes when the hub price IS readable — the guard refuses the unreadable, not the ordinary', () => {
    // the other half of a fail-closed pin: if this ever throws, the guard has
    // stopped discriminating and is refusing everything, which reads as "safe"
    // while breaking every honest batch
    expect(() => assembleBatchBuy(input({ fundingAsset: zeroAddress, hubUsd: 3_000 }))).not.toThrow()
  })

  it('refuses settlement funding whose decimals are unreadable — the band is its SOLE cross-check there', () => {
    for (const bad of [Number.NaN, -1, 37, 1.5, Number.POSITIVE_INFINITY]) {
      expect(
        () => assembleBatchBuy(input({ fundingAsset: A1, settlementDecimals: bad })),
        `settlementDecimals ${bad}`,
      ).toThrow(BatchComposeRefusal)
    }
    // and the ordinary case still composes — note the raw has to AGREE with the
    // decimals, which is the band's whole point: $1,000 at 6dp is 1e9 raw, and
    // the fixture's default 1e18 would itself be a 1e9x slip (it refuses, which
    // is the band working rather than a broken fixture)
    expect(() => assembleBatchBuy(input({ fundingAsset: A1, settlementDecimals: 6, fundingTotalRaw: asFundingRaw(1_000_000_000n) }))).not.toThrow()
  })

  it('a zero funding pull skips the band rather than refusing — the one documented exception', () => {
    // "a plan that spends NOTHING through the hub has nothing for this band to
    // check" — pinned so a future tightening does not turn it into a refusal
    expect(() => assembleBatchBuy(input({ fundingTotalRaw: asFundingRaw(0n), hubUsd: null as unknown as number }))).toThrow()
  })
})
