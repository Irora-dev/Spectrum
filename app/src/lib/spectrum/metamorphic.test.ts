import { describe, expect, it } from 'vitest'
import { zeroAddress } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { asFundingRaw, scaleLegBudgetsToRaw } from './batcher'
import { buildFundingPlan, type FundingPlan, type FundingPlanInput } from './funding-plan'
import { centBudgets } from './plan-legs'
import { integerShares } from './publish-picks'
import { pickRoute } from './routing'
import { assembleBatchBuy } from './assemble-batch'
import type { PlanLegInput } from './plan-legs'

// ─────────────────────────────────────────────────────────────────────────────
// METAMORPHIC TESTS (greenlit exotic path 2, the owner's "do all of these") — the
// structural gap the other suites share: they assert EXPECTED OUTPUTS, so the
// author's blind spots are the suite's. A metamorphic assertion compares
// RELATED RUNS and needs neither answer known: reorder the inputs, double the
// money, split a leg — and check the two answers agree in the way the algebra
// says they must. F1 (the fund step assumed money sat on the FIRST target
// chain by position) is precisely the class permutation-invariance catches
// mechanically, without anyone imagining the case.
//
// HONEST NOTE ON THE RELATIONS' SHAPE: largest-remainder allocation makes the
// NAIVE relations false by design — doubling the total does NOT exactly double
// every leg (floors redistribute), and permuting tied weights may move a
// remainder cent between equals. The TRUE relations are pinned instead: sums
// are exact, per-leg deviation is bounded by ONE allocation unit, and identity
// follows the leg, not the index. Where a naive relation held exactly (integer
// weight scaling), it is asserted exactly.
// ─────────────────────────────────────────────────────────────────────────────

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32

/** Deterministic shuffle with its inverse, so results can be un-permuted. */
function shuffled<T>(rnd: () => number, xs: T[]): { out: T[]; perm: number[] } {
  const perm = xs.map((_, i) => i)
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[perm[i], perm[j]] = [perm[j], perm[i]]
  }
  return { out: perm.map((i) => xs[i]), perm }
}
const unpermute = <T>(ys: T[], perm: number[]): T[] => {
  const out = new Array<T>(ys.length)
  perm.forEach((src, i) => (out[src] = ys[i]))
  return out
}

describe('metamorphic: centBudgets (the cent allocator)', () => {
  it('PERMUTATION: budgets follow their weight — un-permuted results agree within one remainder cent, sums exactly', () => {
    const rnd = lcg(2001)
    for (let i = 0; i < 2000; i++) {
      const n = 2 + Math.floor(rnd() * 10)
      const weights = Array.from({ length: n }, () => rnd() * 100)
      const total = 1 + Math.floor(rnd() * 10_000_000)
      const base = centBudgets(weights, total)
      const { out: pw, perm } = shuffled(rnd, weights)
      const back = unpermute(centBudgets(pw, total), perm)
      expect(back.reduce((s, v) => s + v, 0)).toBe(base.reduce((s, v) => s + v, 0))
      for (let k = 0; k < n; k++) expect(Math.abs(back[k] - base[k]), `seed case ${i} leg ${k}`).toBeLessThanOrEqual(1)
    }
  })

  it('INTEGER WEIGHT SCALING: ×k changes NOTHING — the ratios are the truth, exactly', () => {
    const rnd = lcg(2002)
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 10)
      const weights = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 1000))
      const total = 1 + Math.floor(rnd() * 10_000_000)
      const k = [2, 3, 7, 100][Math.floor(rnd() * 4)]
      expect(centBudgets(weights.map((w) => w * k), total)).toEqual(centBudgets(weights, total))
    }
  })

  it('DOUBLING THE MONEY: the sum doubles EXACTLY; each leg within one cent of double (largest remainder redistributes — by design)', () => {
    const rnd = lcg(2003)
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 10)
      const weights = Array.from({ length: n }, () => rnd() * 100)
      if (!weights.some((w) => w > 0)) continue
      const total = 1 + Math.floor(rnd() * 5_000_000)
      const once = centBudgets(weights, total)
      const twice = centBudgets(weights, total * 2)
      expect(twice.reduce((s, v) => s + v, 0)).toBe(2 * once.reduce((s, v) => s + v, 0))
      for (let k = 0; k < n; k++) expect(Math.abs(twice[k] - 2 * once[k]), `case ${i} leg ${k}`).toBeLessThanOrEqual(1)
    }
  })

  it('SPLITTING A WEIGHT IN HALF: the pair together stays within two cents of the whole; the total never moves', () => {
    const rnd = lcg(2004)
    for (let i = 0; i < 2000; i++) {
      const n = 2 + Math.floor(rnd() * 8)
      const weights = Array.from({ length: n }, () => 1 + rnd() * 100)
      const total = 1 + Math.floor(rnd() * 5_000_000)
      const base = centBudgets(weights, total)
      const splitIdx = Math.floor(rnd() * n)
      const split = [...weights.slice(0, splitIdx), weights[splitIdx] / 2, weights[splitIdx] / 2, ...weights.slice(splitIdx + 1)]
      const splitOut = centBudgets(split, total)
      expect(splitOut.reduce((s, v) => s + v, 0)).toBe(base.reduce((s, v) => s + v, 0))
      const pair = splitOut[splitIdx] + splitOut[splitIdx + 1]
      expect(Math.abs(pair - base[splitIdx]), `case ${i}`).toBeLessThanOrEqual(2)
    }
  })
})

describe('metamorphic: scaleLegBudgetsToRaw (the cents→raw distributor)', () => {
  it('PERMUTATION: raw budgets follow their cent weight within one raw unit; the spendable is conserved exactly either way', () => {
    const rnd = lcg(2005)
    for (let i = 0; i < 1000; i++) {
      const n = 1 + Math.floor(rnd() * 12)
      const cents = Array.from({ length: n }, () => Math.floor(rnd() * 100_000))
      if (!cents.some((c) => c > 0)) continue
      const total = asFundingRaw(BigInt(1 + Math.floor(rnd() * 1_000_000)) * 10n ** 12n + BigInt(Math.floor(rnd() * 997)))
      const base = scaleLegBudgetsToRaw(cents, total)
      const { out: pc, perm } = shuffled(rnd, cents)
      const back = unpermute(scaleLegBudgetsToRaw(pc, total), perm)
      const sum = (xs: bigint[]) => xs.reduce((s, v) => s + v, 0n)
      expect(sum(back as bigint[])).toBe(sum(base as bigint[]))
      for (let k = 0; k < n; k++) {
        const d = (back[k] as bigint) - (base[k] as bigint)
        expect(d <= 1n && d >= -1n, `case ${i} leg ${k}: off by ${d}`).toBe(true)
      }
      // zero-weight legs stay zero under ANY order — a permutation must never
      // hand the remainder to a leg that asked for nothing
      for (let k = 0; k < n; k++) if (cents[k] === 0) expect(base[k]).toBe(0n)
    }
  })

  it('DOUBLING THE PULL: each leg lands within one raw unit of double; conservation stays exact at both sizes', () => {
    const rnd = lcg(2006)
    for (let i = 0; i < 1000; i++) {
      const n = 1 + Math.floor(rnd() * 12)
      const cents = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 100_000))
      const total = BigInt(1 + Math.floor(rnd() * 1_000_000)) * 10n ** 10n + BigInt(Math.floor(rnd() * 997))
      const once = scaleLegBudgetsToRaw(cents, asFundingRaw(total))
      const twice = scaleLegBudgetsToRaw(cents, asFundingRaw(total * 2n))
      for (let k = 0; k < n; k++) {
        const d = (twice[k] as bigint) - 2n * (once[k] as bigint)
        // the fee floors once per total, so doubling shifts each leg by at
        // most one unit plus the fee's own parity — bounded, never drifting
        expect(d <= 2n && d >= -2n, `case ${i} leg ${k}: off by ${d}`).toBe(true)
      }
    }
  })
})

describe('metamorphic: integerShares', () => {
  it('INTEGER SCALING of values changes nothing, exactly', () => {
    const rnd = lcg(2007)
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 12)
      const values = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 50_000))
      const k = [2, 3, 7, 1000][Math.floor(rnd() * 4)]
      expect(integerShares(values.map((v) => v * k))).toEqual(integerShares(values))
    }
  })
})

describe('metamorphic: buildFundingPlan (the F1 class, mechanically)', () => {
  const chainPool = [1, 8453, 4663, 10, 42161]

  function randomInput(rnd: () => number): FundingPlanInput {
    const chainCount = 2 + Math.floor(rnd() * 3)
    const ids = [...chainPool].sort(() => rnd() - 0.5).slice(0, chainCount)
    const newMoneyChain = ids[Math.floor(rnd() * ids.length)]
    const chains = ids.map((chainId) => ({
      chainId,
      nativeRaw: 10n ** 18n,
      gasNeedRaw: 10n ** 15n,
      localFundingCents: chainId === newMoneyChain ? 0 : Math.floor(rnd() * 200_000),
      sellProceedsCents: Math.floor(rnd() * 100_000),
      inboundRefuel: rnd() > 0.5,
    }))
    const needs = ids
      .filter(() => rnd() > 0.3)
      .map((chainId) => ({ chainId, buysCents: Math.floor(rnd() * 150_000), feeCents: Math.floor(rnd() * 750) }))
    return {
      chains,
      needs,
      newMoney: rnd() > 0.3 ? { chainId: newMoneyChain, availableCents: Math.floor(rnd() * 300_000) } : null,
    }
  }

  /** A plan's money movements as an order-independent fingerprint. */
  function fingerprint(plan: FundingPlan): string {
    const rows: string[] = []
    for (const s of plan.steps) {
      if (s.action.kind === 'bridge') rows.push(`bridge ${s.action.fromChainId}->${s.action.toChainId} ${s.action.amountCents} ${s.action.source} ${s.action.refuel}`)
      else if (s.action.kind === 'sell') rows.push(`sell ${s.action.chainId} ${s.action.asset.toLowerCase()} ${s.action.sellRaw} ${s.action.floorProceedsCents}`)
      else {
        const drawn = [...s.action.fundedFrom].map((d) => `${d.source}:${d.fromChainId}:${d.cents}`).sort().join(',')
        rows.push(`batch ${s.action.chainId} [${drawn}]`)
      }
    }
    rows.push(...plan.refusals.map((r) => `refuse ${r.chainId}`))
    return rows.sort().join('\n')
  }

  it('PERMUTING chains[] and needs[] changes NO money movement — funding follows the chain, never the array index', () => {
    const rnd = lcg(2008)
    for (let i = 0; i < 1000; i++) {
      const input = randomInput(rnd)
      let base: FundingPlan
      try {
        base = buildFundingPlan(input)
      } catch {
        continue // a contract-error input is out of scope for this relation
      }
      const permuted: FundingPlanInput = {
        chains: shuffled(rnd, input.chains).out,
        needs: shuffled(rnd, input.needs).out,
        newMoney: input.newMoney,
      }
      const again = buildFundingPlan(permuted)
      expect(fingerprint(again), `case ${i}`).toBe(fingerprint(base))
    }
  })

  it('ADDING A CHAIN WITH NOTHING (no need, no money) perturbs no other chain — presence is not participation', () => {
    const rnd = lcg(2009)
    for (let i = 0; i < 1000; i++) {
      const input = randomInput(rnd)
      let base: FundingPlan
      try {
        base = buildFundingPlan(input)
      } catch {
        continue
      }
      const withGhost: FundingPlanInput = {
        ...input,
        chains: [...input.chains, { chainId: 999, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: 0, sellProceedsCents: 0, inboundRefuel: true }],
      }
      const again = buildFundingPlan(withGhost)
      // the ghost contributes nothing and needs nothing: every original chain's
      // movement is untouched (the ghost itself may appear in NO row)
      expect(fingerprint(again), `case ${i}`).toBe(fingerprint(base))
    }
  })

  it('A ZERO NEED is the same as NO need — asking for nothing moves nothing', () => {
    const rnd = lcg(2010)
    for (let i = 0; i < 1000; i++) {
      const input = randomInput(rnd)
      const spare = [...chainPool, 999].find((id) => !input.needs.some((n) => n.chainId === id) && !input.chains.some((c) => c.chainId === id))!
      let base: FundingPlan
      try {
        base = buildFundingPlan(input)
      } catch {
        continue
      }
      const withZero: FundingPlanInput = {
        ...input,
        chains: [...input.chains, { chainId: spare, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: 0, sellProceedsCents: 0, inboundRefuel: true }],
        needs: [...input.needs, { chainId: spare, buysCents: 0, feeCents: 0 }],
      }
      const again = buildFundingPlan(withZero)
      const stripGhost = (fp: string) =>
        fp
          .split('\n')
          .filter((row) => !row.includes(` ${spare} `) && !row.endsWith(` ${spare}`) && !row.includes(`batch ${spare} `))
          .join('\n')
      expect(stripGhost(fingerprint(again)), `case ${i}`).toBe(fingerprint(base))
    }
  })
})

describe('metamorphic: assembleBatchBuy (identity follows the asset through the whole assembly)', () => {
  const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
  const ME = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const
  const ASSETS = [
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    '0x4200000000000000000000000000000000000006',
    '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  ] as const

  it('PERMUTING targets changes no asset budget, no fee, no total — order is presentation, never money', () => {
    const rnd = lcg(2011)
    for (let i = 0; i < 400; i++) {
      const n = 2 + Math.floor(rnd() * 4)
      const targets: PlanLegInput[] = Array.from({ length: n }, (_, j) => ({
        symbol: `T${j}`,
        asset: ASSETS[j % ASSETS.length] as PlanLegInput['asset'],
        decimals: [6, 8, 18][Math.floor(rnd() * 3)],
        weightPct: 1 + rnd() * 60,
        priceUsd: 0.01 + rnd() * 3000,
        priceAgeMs: 1_000,
        liquidityUsd: 10_000_000,
        buyTokenTaxBps: 0,
        route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
      }))
      const grossCents = 1_000 + Math.floor(rnd() * 10_000_000)
      // the raw side stays CONSISTENT with the dollar side (the M7 band now
      // refuses nonsense pairs): ~gross at the fixture's hub price, jittered
      // ×[0.25, 4]. The law under test is permutation-invariance, which the
      // tie-in does not weaken — magnitude coverage still comes from gross.
      const fairNano = Math.floor((grossCents / 100 / 3_000) * 1e9)
      const totalRaw = BigInt(Math.max(1, Math.floor(fairNano * (0.25 + rnd() * 3.75)))) * 10n ** 9n
      const args = {
        chainId: 8453,
        grossCents,
        fundingTotalRaw: totalRaw,
        fundingAsset: zeroAddress as `0x${string}`,
        account: ME as `0x${string}`,
        deadlineSec: 1_700_000_000,
        slippageBps: 50,
        hopReserveUsd: 50_000_000,
        hubUsd: 3_000,
        settlementDecimals: 6,
        integrator: zeroAddress as `0x${string}`,
      }
      // Since the 2026-08-13 concentration ruling some random draws
      // legitimately REFUSE (a dominant weight past the 75% cap). The
      // property strengthens rather than shrinks: a refusal must be
      // permutation-invariant too — same plan, any order, same answer.
      let base: ReturnType<typeof assembleBatchBuy>
      try {
        base = assembleBatchBuy({ ...args, targets })
      } catch (e) {
        const msg = (e as Error).message
        let permutedMsg = ''
        try {
          assembleBatchBuy({ ...args, targets: shuffled(rnd, targets).out })
        } catch (e2) {
          permutedMsg = (e2 as Error).message
        }
        expect(permutedMsg, `case ${i}: a refusal must not depend on target order`).toBe(msg)
        continue
      }
      const again = assembleBatchBuy({ ...args, targets: shuffled(rnd, targets).out })
      expect(again.feeCents).toBe(base.feeCents)
      const byAsset = (out: typeof base) => {
        const m = new Map<string, { cents: number; raw: bigint }>()
        for (const l of out.legs) {
          const prev = m.get(l.symbol) ?? { cents: 0, raw: 0n }
          m.set(l.symbol, { cents: prev.cents + l.budgetUsdCents, raw: prev.raw + l.budgetRaw })
        }
        return m
      }
      const a = byAsset(base)
      const b = byAsset(again)
      expect(b.size).toBe(a.size)
      for (const [sym, v] of a) {
        const w = b.get(sym)!
        expect(w.cents, `case ${i} ${sym} cents`).toBe(v.cents)
        const d = w.raw - v.raw
        // the raw remainder walk may hand ±1 unit differently between equals
        expect(d <= 1n && d >= -1n, `case ${i} ${sym} raw off by ${d}`).toBe(true)
      }
      const sumRaw = (out: typeof base) => out.legs.reduce((s, l) => s + l.budgetRaw, 0n)
      expect(sumRaw(again)).toBe(sumRaw(base))
    }
  })
})

describe('metamorphic: pickRoute (monotonicity — a verdict cannot flip toward a worse arm)', () => {
  it('improving the winner never dethrones it; worsening the loser never crowns it', () => {
    const rnd = lcg(2012)
    for (let i = 0; i < 2000; i++) {
      const direct = { outUsd: rnd() * 1000, gasCostUsd: rnd() * 20 }
      const agg = { outUsd: rnd() * 1000, gasCostUsd: rnd() * 20 }
      const v = pickRoute(direct, agg)
      if (!v.raced) continue
      const bump = 0.02 + rnd() * 5
      if (v.winner === 'direct') {
        expect(pickRoute({ ...direct, outUsd: direct.outUsd + bump }, agg).winner).toBe('direct')
        expect(pickRoute(direct, { ...agg, gasCostUsd: agg.gasCostUsd + bump }).winner).toBe('direct')
      } else {
        expect(pickRoute(direct, { ...agg, outUsd: agg.outUsd + bump }).winner).toBe('aggregator')
        // worsening DIRECT's gas cannot flip the verdict back to direct
        expect(pickRoute({ ...direct, gasCostUsd: direct.gasCostUsd + bump }, agg).winner).toBe('aggregator')
      }
    }
  })
})
