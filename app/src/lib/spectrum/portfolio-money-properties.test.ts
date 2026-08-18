import { describe, expect, it } from 'vitest'
import { buildFundingPlan, FundingPlanContractError, type ChainInventory, type ChainNeed, type FundingPlan } from './funding-plan'
import { deriveLegFloors, S_MAX_BPS, type FloorLegInput } from './floor-discipline'
import { expectedBurnCut } from './post-trade-reconciliation'

// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO MONEY PROPERTIES — the law families, not the examples.
//
// pipeline-properties.test.ts drives the cross-module pipeline (plan → floors
// → compose → displayed-vs-signed) over seeded random cases; every module
// suite pins its own known shapes. What NEITHER covers is asserted here: the
// family form of three laws whose single-case pins have each already caught a
// live bug —
//   · funding-plan's honest-answer law: every need is EITHER covered by steps
//     or refused BY NAME — across random inventories, never both, never
//     neither (absence read as coverage is bug-class 5's cousin);
//   · floor-discipline's direction laws: floors only ever bind DOWNWARD from
//     the quote and tighter caps only ever RAISE floors / grow refusals
//     (docs/MONEY-LAWS.md law 4 — the double-haircut and the cap-widening
//     near-miss were both direction failures);
//   · the burn-share generation law's arithmetic identities (law 2), via the
//     receipt-side mirror expectedBurnCut — the compose-side share is pinned
//     in portfolio-run-wiring.test.ts; the mirror must agree with the law for
//     EVERY fee, not the fixture's.
//
// Same idiom as the pipeline harness: seeded LCG, no Date/Math.random, every
// failure reproduces by its case seed.
// ─────────────────────────────────────────────────────────────────────────────

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
const CASES = 300

// ── funding-plan: the honest-answer family ───────────────────────────────────

function genPlanInput(rnd: () => number): { chains: ChainInventory[]; needs: ChainNeed[]; newMoney: { chainId: number; availableCents: number } | null } {
  const ids = [1, 8453, 4663].filter(() => rnd() < 0.85)
  if (ids.length === 0) ids.push(8453)
  const chains: ChainInventory[] = ids.map((chainId) => ({
    chainId,
    nativeRaw: BigInt(Math.floor(rnd() * 1e18)),
    // ~12% unreadable gas estimates — law 5's refusal path must show up in the sample
    gasNeedRaw: rnd() < 0.12 ? null : BigInt(Math.floor(rnd() * 1e16)),
    localFundingCents: Math.floor(rnd() * 500_000),
    sellProceedsCents: 0,
  }))
  const needs: ChainNeed[] = ids
    .filter(() => rnd() < 0.8)
    .map((chainId) => ({ chainId, buysCents: 100 + Math.floor(rnd() * 400_000), feeCents: Math.floor(rnd() * 2_000) }))
  const newMoney = rnd() < 0.6 ? { chainId: ids[Math.floor(rnd() * ids.length)], availableCents: Math.floor(rnd() * 600_000) } : null
  // the input contract: newMoney's host chain must not double-count local cash
  if (newMoney) for (const c of chains) if (c.chainId === newMoney.chainId) c.localFundingCents = 0
  return { chains, needs, newMoney }
}

const batchedCentsFor = (plan: FundingPlan, chainId: number): number =>
  plan.steps
    .filter((s) => s.action.kind === 'batch' && s.action.chainId === chainId)
    .flatMap((s) => (s.action.kind === 'batch' ? s.action.fundedFrom : []))
    .reduce((sum, d) => sum + d.cents, 0)

describe('funding-plan across random inventories — every need covered exactly or refused by name, money conserved', () => {
  it(`holds over ${CASES} seeded cases`, () => {
    const rnd = lcg(0xf00df00d)
    for (let i = 0; i < CASES; i++) {
      const input = genPlanInput(rnd)
      let plan: FundingPlan
      try {
        plan = buildFundingPlan({ ...input, sells: [] })
      } catch (e) {
        // the ONLY lawful throw is the input-contract error, and this
        // generator never violates the contract — anything thrown here is a
        // real finding, so let it fail with its own message
        expect(e).not.toBeInstanceOf(FundingPlanContractError)
        throw e
      }
      const label = `case ${i}`
      // HONEST ANSWER: each need chain is batched, or refused in a sentence
      // that names its chain — never both, never neither.
      for (const need of input.needs) {
        const batched = batchedCentsFor(plan, need.chainId)
        const named = plan.refusals.some((r) => r.chainId === need.chainId || r.reason.includes(String(need.chainId)))
        expect(batched > 0 || named, `${label}: need on chain ${need.chainId} neither batched nor refused by name`).toBe(true)
        // COVERED MEANS COVERED: a batched chain's draws sum to its whole need
        if (batched > 0)
          expect(batched, `${label}: chain ${need.chainId} batched ${batched} ≠ need ${need.buysCents + need.feeCents}`).toBe(
            need.buysCents + need.feeCents,
          )
      }
      // CONSERVATION: total drawn never exceeds total spendable
      const totalBatched = input.needs.reduce((s, n) => s + batchedCentsFor(plan, n.chainId), 0)
      const spendable =
        input.chains.reduce((s, c) => s + c.localFundingCents + c.sellProceedsCents, 0) + (input.newMoney?.availableCents ?? 0)
      expect(totalBatched, `${label}: drew ${totalBatched} of ${spendable} spendable`).toBeLessThanOrEqual(spendable)
      // PROVENANCE: every draw names a chain the plan was actually given
      const known = new Set(input.chains.map((c) => c.chainId))
      for (const step of plan.steps)
        if (step.action.kind === 'batch')
          for (const d of step.action.fundedFrom)
            expect(known.has(d.fromChainId), `${label}: draw from unknown chain ${d.fromChainId}`).toBe(true)
    }
  })

  it('the input contract still throws loud on a duplicated chain row (the lawful-throw boundary)', () => {
    const c: ChainInventory = { chainId: 8453, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: 1_000, sellProceedsCents: 0 }
    expect(() => buildFundingPlan({ chains: [c, { ...c }], needs: [], newMoney: null, sells: [] })).toThrow(FundingPlanContractError)
  })
})

// ── floor-discipline: the direction family ───────────────────────────────────

function genFloorLegs(rnd: () => number): FloorLegInput[] {
  const n = 1 + Math.floor(rnd() * 7)
  return Array.from({ length: n }, (_, i) => ({
    key: `L${i}`,
    quotedBuyAmount: BigInt(1 + Math.floor(rnd() * 1e12)),
    notional: rnd() * 50_000,
    // nulls stay in the sample: unmeasured is not zero, and must refuse
    marketSlippageBps: rnd() < 0.12 ? null : Math.floor(rnd() * 220),
    buyTokenTaxBps: rnd() < 0.08 ? null : rnd() < 0.85 ? 0 : Math.floor(rnd() * 40),
  }))
}

describe('floor-discipline across random legs — floors bind downward, tighter caps only raise', () => {
  it(`holds over ${CASES} seeded cases`, () => {
    const rnd = lcg(0xbeefcafe)
    for (let i = 0; i < CASES; i++) {
      const legs = genFloorLegs(rnd)
      const hopReserve = rnd() < 0.1 ? null : 1_000_000 + rnd() * 9_000_000
      const loose = deriveLegFloors(legs, { hopReserve, sMaxBps: S_MAX_BPS })
      const tight = deriveLegFloors(legs, { hopReserve, sMaxBps: 100 })
      const label = `case ${i}`
      // PARTITION: every input key comes back exactly once, as a leg or a refusal
      for (const plan of [loose, tight]) {
        const seen = [...plan.legs.map((l) => l.key), ...plan.refusals.map((r) => r.key)].sort()
        expect(seen, `${label}: keys not partitioned`).toEqual(legs.map((l) => l.key).sort())
      }
      for (const out of loose.legs) {
        const input = legs.find((l) => l.key === out.key)!
        // DOWNWARD ONLY: a floor is positive and never above its own quote
        expect(out.minBuyAmount > 0n, `${label}/${out.key}: non-positive floor`).toBe(true)
        expect(out.minBuyAmount <= input.quotedBuyAmount, `${label}/${out.key}: floor above the quote`).toBe(true)
        // UNMEASURED SLIPPAGE IS NOT ZERO: a null-slippage leg never composes.
        // (Unknown TAX is different by the owner's 2026-08-15 ruling — it
        // composes at the untaxed floor, fail-closed at the contract's own
        // measurement; only a nonsense tax refuses. See the block comment in
        // deriveLegFloors.)
        expect(input.marketSlippageBps, `${label}/${out.key}: composed with unmeasured slippage`).not.toBeNull()
      }
      // TIGHTER CAP, HIGHER FLOOR: on legs surviving both caps, the 100-bps
      // floor is never below the 300-bps floor; and tightening only grows
      // the refusal set, never shrinks it.
      for (const t of tight.legs) {
        const l = loose.legs.find((x) => x.key === t.key)
        if (l) expect(t.minBuyAmount >= l.minBuyAmount, `${label}/${t.key}: tighter cap lowered the floor`).toBe(true)
      }
      // NOT asserted: refusal-set monotonicity. It is FALSE by design — the
      // hop impact accumulates over SUBMITTED legs only, so a tighter cap that
      // refuses an early leg lowers every later leg's self-impact and can
      // lawfully free one the loose cap refused (measured at seed 0xbeefcafe
      // case 1). That is the cumulative-hop law working, not a direction
      // violation; the direction laws that DO hold are asserted above.
    }
  })

  it('an unusable cap refuses every leg — present-but-broken never falls back to a laxer default', () => {
    const legs = genFloorLegs(lcg(7))
    for (const bad of [0, -5, Number.NaN, 10_001]) {
      const plan = deriveLegFloors(legs, { hopReserve: 1_000_000, sMaxBps: bad })
      expect(plan.legs).toEqual([])
      expect(plan.refusals.map((r) => r.reason)).toEqual(legs.map(() => 'unusable-cap'))
    }
  })
})

// ── the burn-share law: arithmetic identities over every fee ─────────────────

describe('the burn-share generation law holds for every fee, not the fixture', () => {
  it('gen-1 splits exactly (cut + eighth = fee), 100%-burn generations take it whole, never negative, monotone', () => {
    const rnd = lcg(0x5eed)
    for (let i = 0; i < 1_000; i++) {
      const fee = BigInt(Math.floor(rnd() * 1e15)) + BigInt(i)
      const g1 = expectedBurnCut(fee, 1)
      // the split is EXACT integer arithmetic, no dust unaccounted:
      expect(g1 + fee / 8n).toBe(fee)
      expect(g1 >= 0n && g1 <= fee).toBe(true)
      expect(expectedBurnCut(fee, 2)).toBe(fee)
      expect(expectedBurnCut(fee, 3)).toBe(fee)
      // monotone: one more wei of fee never burns less, on any generation
      expect(expectedBurnCut(fee + 1n, 1) >= g1).toBe(true)
      expect(expectedBurnCut(fee + 1n, 2) >= fee).toBe(true)
    }
    expect(() => expectedBurnCut(-1n, 2)).toThrow()
  })
})
