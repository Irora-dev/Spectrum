import { describe, expect, it } from 'vitest'
import { zeroAddress } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { BATCH_FEE_BPS, normalizedTargets, type AllocationDraft } from './allocation'
import { planToLegs } from './plan-legs'
import { buildFundingPlan, fundingConservationErrors } from './funding-plan'
import {
  asFundingRaw,
  composeBatchBuy,
  BatchComposeRefusal,
  feeCentsOfTotal,
  fundingTotalForLegCents,
  scaleLegBudgetsToRaw,
} from './batcher'

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM-CONSERVATION SWEEP — the round the module sweeps could not do.
//
// Eight audit rounds probed modules IN ISOLATION, and the two standing sweeps
// now do that automatically. But the worst bug of the whole day was never in a
// module: the cents/raw seam, where `plan-legs` spoke integer cents and
// `batcher` spoke raw units — both correct alone — composed wrong-money
// calldata that the displayed-vs-signed gate structurally could not catch,
// because display and calldata derived from the same wrong number.
//
// So this file asserts the invariant NO SINGLE MODULE OWNS: money is conserved
// across every handoff of the real pipeline.
//
//   draft dollars → normalizedTargets → planToLegs (cents)
//                → buildFundingPlan (cents) → composeBatchBuy (raw units)
//
// THE INVARIANT: the dollars a user typed equal the cents the plan budgets
// equal the raw units the calldata pulls — with the fee counted exactly ONCE,
// and every leg's budget traceable to a funded source.
//
// It found the fee seam on its first run: three modules each had a defensible
// idea of what "the funding total" meant, and no two of them agreed. See
// `feeCentsOfTotal` for the equation that was missing.
// ─────────────────────────────────────────────────────────────────────────────

const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
const ROUTE = { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress } as const
const WETH = '0x4200000000000000000000000000000000000006' as const
const AAVE = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const

const draftOf = (amountUsd: number, weights: [string, `0x${string}`, number][]): AllocationDraft => ({
  targets: weights.map(([symbol, address, weight]) => ({ asset: { chainId: 8453, address, symbol }, weight })),
  amountUsd,
  intent: 'keep',
  updatedAt: 1,
})

/** The whole pipeline, as the runner will thread it. Returns every seam's
 *  figure so the test can compare them rather than trust them. */
function pipeline(amountUsd: number, weights: [string, `0x${string}`, number][], decimals = 18) {
  // seam 1 — the draft's dollars become per-leg dollars
  const norm = normalizedTargets(draftOf(amountUsd, weights))
  const legDollars = norm.reduce((s, n) => s + n.usd, 0)

  // seam 2 — dollars become integer cents the legs will spend (NET of fee)
  const grossCents = Math.round(amountUsd * 100)
  const feeCents = feeCentsOfTotal(grossCents)
  const netCents = grossCents - feeCents
  const { legs: planned, refusals } = planToLegs(
    norm.map((n) => ({
      symbol: n.asset.symbol,
      asset: n.asset.address as `0x${string}`,
      decimals,
      weightPct: n.pct,
      priceUsd: 10,
      priceAgeMs: 1_000,
      liquidityUsd: 1e7,
      buyTokenTaxBps: 0,
      route: ROUTE,
    })),
    netCents,
  )
  // the runner's FLOOR step, stood in: these conservation fixtures predate the
  // floor plan, so they attach the 50-bps legacy haircut their pins assume
  const legs = planned.map((l) => ({ ...l, minOutRaw: (l.quotedOutRaw * 9_950n) / 10_000n }))
  const legCentsSum = legs.reduce((s, l) => s + l.budgetUsdCents, 0)

  // seam 3 — the funding plan funds buys + fee from real sources
  const plan = buildFundingPlan({
    chains: [{ chainId: 8453, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: grossCents, sellProceedsCents: 0, inboundRefuel: true }],
    needs: [{ chainId: 8453, buysCents: legCentsSum, feeCents }],
    newMoney: null,
  })
  const fundedCents = plan.steps
    .filter((s) => s.action.kind === 'batch')
    .flatMap((s) => (s.action as { fundedFrom: { cents: number }[] }).fundedFrom)
    .reduce((s, d) => s + d.cents, 0)

  // seam 4 — THE RUNNER'S SCALING STEP: cents become the funding asset's raw
  // units. This seam had no code at all, only a comment ("the runner scales"),
  // and it is where the cents/raw bug lived. It cannot be a multiplication:
  // the contract computes its fee in RAW, so a cents-domain fee disagrees by
  // up to half a cent and the composer refuses the plan. The budgets are
  // DISTRIBUTED from the raw spendable instead — conservation by construction.
  const RAW_PER_CENT = 10n ** BigInt(6) / 100n // USDC: 6 decimals
  const fundingTotalRaw = asFundingRaw(BigInt(grossCents) * RAW_PER_CENT)
  const legBudgetsRaw = scaleLegBudgetsToRaw(legs.map((l) => l.budgetUsdCents), fundingTotalRaw)

  return { norm, legDollars, grossCents, feeCents, netCents, legs, refusals, legCentsSum, plan, fundedCents, legBudgetsRaw, fundingTotalRaw, RAW_PER_CENT }
}

describe('the funding equation — the fee is a term, counted exactly once', () => {
  it('legs + fee = the total, at every size', () => {
    for (const gross of [100, 1_000, 100_000, 1, 7, 999_999, 12_345]) {
      const fee = feeCentsOfTotal(gross)
      const spendable = gross - fee
      // the same relationship composeBatchBuy enforces, in cents
      expect(fee + spendable).toBe(gross)
      expect(fee).toBeGreaterThanOrEqual(0)
      expect(fee).toBeLessThan(gross === 0 ? 1 : gross)
    }
  })

  it('fundingTotalForLegCents inverts it, rounding the SAFE way (over-fund, never under)', () => {
    for (const legCents of [1, 99, 100, 99_500, 1_234_567]) {
      const total = fundingTotalForLegCents(legCents)
      const spendable = total - feeCentsOfTotal(total)
      // never under-funds the legs; at most a cent over (which refunds)
      expect(spendable).toBeGreaterThanOrEqual(legCents)
      expect(spendable - legCents).toBeLessThanOrEqual(2)
    }
  })

  it('a zero fee degrades to the old identity — a sell-only batch pulls exactly its legs', () => {
    expect(feeCentsOfTotal(100_000, 0)).toBe(0)
    expect(fundingTotalForLegCents(100_000, 0)).toBe(100_000)
  })
})

describe('the pipeline conserves money at every seam', () => {
  it('$1,000 across two assets: every seam agrees, and the fee is counted ONCE', () => {
    const p = pipeline(1_000, [
      ['WETH', WETH, 60],
      ['AAVE', AAVE, 40],
    ])
    // seam 1: the draft's dollars are not lost in normalization
    expect(p.legDollars).toBe(1_000)
    expect(p.refusals).toHaveLength(0)

    // seam 2: the legs spend exactly the net — no cent invented, none dropped
    expect(p.legCentsSum).toBe(p.netCents)
    expect(p.legCentsSum + p.feeCents).toBe(p.grossCents)

    // seam 3: the funding plan funds the gross, from real sources, exactly
    expect(p.fundedCents).toBe(p.grossCents)
    expect(fundingConservationErrors(
      {
        chains: [{ chainId: 8453, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: p.grossCents, sellProceedsCents: 0, inboundRefuel: true }],
        needs: [{ chainId: 8453, buysCents: p.legCentsSum, feeCents: p.feeCents }],
        newMoney: null,
      },
      p.plan,
    )).toEqual([])

    // seam 4: the raw the calldata carries equals EXACTLY what the contract
    // will leave spendable — the number that matters, in the domain the chain
    // computes in (not cents × a rate, which rounds differently)
    const rawSum = p.legBudgetsRaw.reduce((s, r) => s + r, 0n)
    const total = p.fundingTotalRaw as bigint
    expect(rawSum).toBe(total - (total * BigInt(BATCH_FEE_BPS)) / 10_000n)
    expect(p.fundingTotalRaw).toBe(BigInt(p.grossCents) * p.RAW_PER_CENT)

    // and THE WHOLE POINT: composing with those numbers is accepted, because
    // legs + fee = total is the law the composer now checks
    const composed = composeBatchBuy({
      chainId: 8453,
      legs: p.legs.map((l, i) => ({ ...l, budgetRaw: p.legBudgetsRaw[i] })),
      fundingAsset: WETH,
      fundingTotalRaw: p.fundingTotalRaw,
      recipient: AAVE,
      owner: AAVE,
      deadlineSec: 1_800_000_000,
      hubMinOutRaw: 1n,
      integrator: zeroAddress,
    })
    expect(composed.args[2]).toBe(p.fundingTotalRaw)
    expect(composed.args[3].feeBps).toBe(BATCH_FEE_BPS)
  })

  it('THE BUG THIS ROUND FOUND: pulling only the NET is refused, with the reason', () => {
    // Before the fee term, `sum(legs) === fundingTotal` FORCED this shape — the
    // batch pulled the net, the contract took its cut out of the legs, and
    // every floor sat ~50bps above what its leg could buy.
    const p = pipeline(1_000, [
      ['WETH', WETH, 60],
      ['AAVE', AAVE, 40],
    ])
    expect(() =>
      composeBatchBuy({
        chainId: 8453,
        legs: p.legs.map((l, i) => ({ ...l, budgetRaw: p.legBudgetsRaw[i] })),
        fundingAsset: WETH,
        fundingTotalRaw: asFundingRaw(BigInt(p.netCents) * p.RAW_PER_CENT), // the NET
        recipient: AAVE,
        owner: AAVE,
        deadlineSec: 1_800_000_000,
        hubMinOutRaw: 1n,
        integrator: zeroAddress,
      }),
    ).toThrow(/can only spend/)
  })

  it('conserves across many shapes, decimals, and awkward amounts', () => {
    const shapes: [number, [string, `0x${string}`, number][], number][] = [
      [1_000, [['WETH', WETH, 60], ['AAVE', AAVE, 40]], 18],
      [7, [['WETH', WETH, 50], ['AAVE', AAVE, 50]], 6],
      [999.99, [['WETH', WETH, 33], ['AAVE', AAVE, 67]], 8],
      [1, [['WETH', WETH, 100]], 18],
      [123_456.78, [['WETH', WETH, 1], ['AAVE', AAVE, 99]], 18],
      [50_000, [['WETH', WETH, 34], ['AAVE', AAVE, 33]], 18], // weights not summing 100
    ]
    for (const [amount, weights, decimals] of shapes) {
      const p = pipeline(amount, weights, decimals)
      const label = `$${amount} / ${weights.length} legs / ${decimals}dp`
      // no cent appears or vanishes between the plan and the calldata
      expect(p.legCentsSum + p.feeCents, `${label}: legs+fee ≠ gross`).toBe(p.grossCents)
      expect(p.fundedCents, `${label}: funding ≠ gross`).toBe(p.grossCents)
      const rawSum = p.legBudgetsRaw.reduce((s, r) => s + r, 0n)
      const tot = p.fundingTotalRaw as bigint
      expect(rawSum, `${label}: raw ≠ spendable`).toBe(tot - (tot * BigInt(BATCH_FEE_BPS)) / 10_000n)
      // and every leg keeps its share of the plan: no leg silently zeroed
      expect(p.legBudgetsRaw.filter((r) => r > 0n).length, `${label}: a leg lost its budget`).toBe(
        p.legs.filter((l) => l.budgetUsdCents > 0).length,
      )
      // and the composer accepts what the pipeline produced
      expect(() =>
        composeBatchBuy({
          chainId: 8453,
          legs: p.legs.map((l, i) => ({ ...l, budgetRaw: p.legBudgetsRaw[i] })),
          fundingAsset: WETH,
          fundingTotalRaw: p.fundingTotalRaw,
          recipient: AAVE,
          owner: AAVE,
          deadlineSec: 1_800_000_000,
          hubMinOutRaw: 1n,
          integrator: zeroAddress,
        }),
      ).not.toThrow()
    }
  })
})

describe('the seams BITE when broken — each proof, not a hope', () => {
  const base = () =>
    pipeline(1_000, [
      ['WETH', WETH, 60],
      ['AAVE', AAVE, 40],
    ])

  it('a leg budget scaled by the WRONG decimals is refused (the cents/raw bug, re-armed)', () => {
    const p = base()
    const wrong = p.legs.map((l) => asFundingRaw(BigInt(l.budgetUsdCents))) // cents as raw
    expect(() =>
      composeBatchBuy({
        chainId: 8453,
        legs: p.legs.map((l, i) => ({ ...l, budgetRaw: wrong[i] })),
        fundingAsset: WETH,
        fundingTotalRaw: p.fundingTotalRaw,
        recipient: AAVE,
        owner: AAVE,
        deadlineSec: 1_800_000_000,
        hubMinOutRaw: 1n,
        integrator: zeroAddress,
      }),
    ).toThrow(BatchComposeRefusal)
  })

  it('ONE cent added to a single leg is refused — the check is exact, not approximate', () => {
    const p = base()
    const legs = p.legs.map((l, i) => ({ ...l, budgetRaw: asFundingRaw(p.legBudgetsRaw[i] + (i === 0 ? 1n : 0n)) }))
    expect(() =>
      composeBatchBuy({
        chainId: 8453,
        legs,
        fundingAsset: WETH,
        fundingTotalRaw: p.fundingTotalRaw,
        recipient: AAVE,
        owner: AAVE,
        deadlineSec: 1_800_000_000,
        hubMinOutRaw: 1n,
        integrator: zeroAddress,
      }),
    ).toThrow(/can only spend/)
  })

  it('the funding plan catches a chain funded for the buys but NOT the fee (F9)', () => {
    const p = base()
    const short = buildFundingPlan({
      chains: [{ chainId: 8453, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: p.legCentsSum, sellProceedsCents: 0, inboundRefuel: true }],
      needs: [{ chainId: 8453, buysCents: p.legCentsSum, feeCents: p.feeCents }],
      newMoney: null,
    })
    // funding only the legs leaves the fee unfunded: refused, with the gap named
    expect(short.steps.filter((s) => s.action.kind === 'batch')).toHaveLength(0)
    expect(short.refusals[0].reason).toMatch(/needs \$\d+ more/)
  })
})

describe('the scaling step: conservation by construction, not by luck', () => {
  const total = (cents: number) => asFundingRaw(BigInt(cents) * (10n ** 6n / 100n))
  const spendableOf = (t: bigint) => t - (t * BigInt(BATCH_FEE_BPS)) / 10_000n

  it('sums to the raw spendable EXACTLY, including the shapes that could not compose before', () => {
    // Measured before the fix: $7, $1, $999.99 and $123,456.78 all refused,
    // because a cents-domain fee rounds differently from the chain's raw one.
    for (const [cents, legs] of [
      [700, [349, 348]],
      [100, [100]],
      [99_999, [32_835, 66_665]],
      [12_345_678, [122_840, 12_161_110]],
      [5_000_000, [4_975_000]],
    ] as [number, number[]][]) {
      const t = total(cents)
      const raw = scaleLegBudgetsToRaw(legs, t)
      expect(raw.reduce((a, b) => a + b, 0n), `${cents}c`).toBe(spendableOf(t as bigint))
    }
  })

  it('never zeroes a leg that had a budget — a pick may not vanish in the scaling', () => {
    const t = total(1_000_000)
    const raw = scaleLegBudgetsToRaw(Array(32).fill(100), t)
    expect(raw.every((r) => r > 0n)).toBe(true)
    expect(raw.reduce((a, b) => a + b, 0n)).toBe(spendableOf(t as bigint))
  })

  it('a zero-cent leg stays zero — and the others absorb the whole spendable', () => {
    const t = total(1_000_000)
    const raw = scaleLegBudgetsToRaw([100, 0, 100], t)
    expect(raw[1]).toBe(0n)
    expect(raw.reduce((a, b) => a + b, 0n)).toBe(spendableOf(t as bigint))
  })

  it('degenerate inputs produce zeros, never a fabricated distribution', () => {
    expect(scaleLegBudgetsToRaw([0, 0], total(1_000)).every((r) => r === 0n)).toBe(true)
    expect(scaleLegBudgetsToRaw([100], asFundingRaw(0n)).every((r) => r === 0n)).toBe(true)
    expect(scaleLegBudgetsToRaw([Number.NaN, 100], total(1_000)).reduce((a, b) => a + b, 0n)).toBe(
      spendableOf(total(1_000) as bigint),
    )
  })
})
