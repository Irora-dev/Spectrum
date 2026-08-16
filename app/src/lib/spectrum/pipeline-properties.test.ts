import { describe, expect, it } from 'vitest'
import { encodeFunctionData, zeroAddress } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { BATCH_FEE_BPS } from './allocation'
import { assembleBatchBuy, type AssembleBatchBuyInput } from './assemble-batch'
import { batcherAbi, BatchComposeRefusal, type ComposedBatchBuy } from './batcher'
import { diffDisplayedVsSigned, shownAtReviewSurface } from './displayed-vs-signed'
import type { PlanLegInput } from './plan-legs'

// ─────────────────────────────────────────────────────────────────────────────
// PIPELINE PROPERTIES — the laws that hold ACROSS modules, driven end-to-end.
//
// Every suite here pins one module; the worst class we have seen lives BETWEEN
// them (the bracket×floor CRITICAL was a cross-module PRODUCT nobody computed —
// "tolerances compose; something must multiply them"). This harness drives the
// real pipeline — plan → floors → compose → displayed-vs-signed — over seeded
// random inputs and asserts the GLOBAL laws on every case:
//
//   · conservation: composed leg raws sum EXACTLY to the raw spendable
//   · floors bound: every venue leg's minOut ≤ its own quote basis, > 0
//   · consent: a leg whose INPUT depth was thin/unreadable is optional — the
//     expectation is derived from the INPUT side, never recomputed from the
//     output (a same-side comparison is f(x) === f(x))
//   · concentration: rows describe the composed set exactly (shares sum to
//     100, worst ≥ 1 − ε, excluded = consented − composed)
//   · displayed-vs-signed closes end-to-end: a review minted from the
//     assembly's own legs diffs NULL against the real encoding, and a
//     one-unit floor tamper diffs NON-NULL
//   · refusals are SENTENCES: hostile single-field mutations either refuse as
//     BatchComposeRefusal with readable words or compose lawfully — never a
//     raw TypeError, never NaN in anything shown
//
// Seeded LCG, no Date/Math.random — every failure reproduces by its case id.
// ─────────────────────────────────────────────────────────────────────────────

const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32

let assetN = 0
function genTargets(rnd: () => number): PlanLegInput[] {
  const n = 1 + Math.floor(rnd() * 8)
  return Array.from({ length: n }, (_, i) => ({
    symbol: `G${i}`,
    asset: `0x${(++assetN).toString(16).padStart(40, '0')}` as PlanLegInput['asset'],
    decimals: [6, 8, 18][Math.floor(rnd() * 3)],
    weightPct: 1 + Math.floor(rnd() * 60),
    priceUsd: 10 ** (rnd() * 6 - 2), // $0.01 … $10,000
    priceAgeMs: Math.floor(rnd() * 60_000),
    liquidityUsd: rnd() < 0.15 ? null : 10 ** (rnd() * 5 + 3), // $1k … $100M, 15% unreadable
    buyTokenTaxBps: 0,
    route: rnd() < 0.2 ? ('basket' as const) : { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
  }))
}

function genInput(rnd: () => number): AssembleBatchBuyInput {
  const grossCents = 1_000 + Math.floor(rnd() * 5_000_000) // $10 … $50k
  const hubUsd = 1_000 + rnd() * 4_000
  const fairNano = Math.floor((grossCents / 100 / hubUsd) * 1e9)
  return {
    chainId: 8453,
    targets: genTargets(rnd),
    grossCents,
    fundingTotalRaw: BigInt(Math.max(1, Math.floor(fairNano * (0.25 + rnd() * 3.75)))) * 10n ** 9n,
    fundingAsset: zeroAddress,
    account: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    deadlineSec: 1_700_000_000,
    slippageBps: 10 + Math.floor(rnd() * 290),
    hopReserveUsd: rnd() < 0.1 ? null : 10 ** (rnd() * 4 + 4), // $10k … $100M, 10% unread
    hubUsd,
    settlementDecimals: 6,
    integrator: zeroAddress,
  }
}

const encode = (args: ComposedBatchBuy['args']) => encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args })

describe('pipeline properties — 250 seeded cases through the REAL pipeline', () => {
  it('every case either refuses in a sentence or satisfies every global law at once', () => {
    const rnd = lcg(0xa11c47)
    let composedCount = 0
    let refusedCount = 0
    for (let caseId = 0; caseId < 250; caseId++) {
      const input = genInput(rnd)
      let out
      try {
        out = assembleBatchBuy(input)
      } catch (e) {
        // LAW: a refusal is a BatchComposeRefusal with readable words — never
        // a raw TypeError, never NaN leaking into the sentence
        expect(e, `case ${caseId}: wrong throw shape ${String(e)}`).toBeInstanceOf(BatchComposeRefusal)
        expect((e as Error).message.length, `case ${caseId}`).toBeGreaterThan(20)
        expect((e as Error).message, `case ${caseId}`).not.toMatch(/NaN|undefined|Infinity/)
        refusedCount++
        continue
      }
      composedCount++

      // LAW: conservation — leg raws sum EXACTLY to the raw spendable
      const spendable = input.fundingTotalRaw - (input.fundingTotalRaw * BigInt(BATCH_FEE_BPS)) / 10_000n
      const rawSum = out.composed.args[0].reduce((s, l) => s + l.budget, 0n)
      expect(rawSum, `case ${caseId}: conservation`).toBe(spendable)

      // LAW: floors bound — every venue leg's minOut ∈ (0, quote basis]
      for (const l of out.legs) {
        if (l.route === 'basket') continue
        expect(l.minOutRaw != null && l.minOutRaw > 0n, `case ${caseId}: ${l.symbol} floor missing`).toBe(true)
        expect(l.minOutRaw! <= l.quotedOutRaw, `case ${caseId}: ${l.symbol} floor above its own quote`).toBe(true)
      }

      // LAW: consent from the INPUT side — an unreadable/thin input depth may
      // never produce a required leg (the independent expectation)
      const targetByAsset = new Map(input.targets.map((t) => [t.asset.toLowerCase(), t]))
      for (const l of out.legs) {
        const t = targetByAsset.get(l.asset.toLowerCase())!
        const unreadable = t.liquidityUsd == null || !Number.isFinite(t.liquidityUsd) || t.liquidityUsd <= 0
        if (unreadable) expect(l.optional, `case ${caseId}: ${l.symbol} unreadable depth composed required`).toBe(true)
      }

      // LAW: the concentration fact describes the composed set exactly
      const c = out.concentration
      if (out.legs.length > 0) {
        const share = c.rows.reduce((s, r) => s + r.realisedPct, 0)
        expect(Math.abs(share - 100), `case ${caseId}: realised shares sum ${share}`).toBeLessThan(1e-6)
        expect(c.worst!.ratio, `case ${caseId}`).toBeGreaterThanOrEqual(1 - 1e-9)
        const composedAssets = new Set(out.legs.map((l) => l.asset.toLowerCase()))
        const consented = new Set(input.targets.map((t) => t.asset.toLowerCase()))
        expect(c.excludedCount, `case ${caseId}`).toBe([...consented].filter((a) => !composedAssets.has(a)).length)
      }

      // LAW: displayed-vs-signed closes end-to-end.
      //
      // ⚠⚠ THIS LAW COULD NOT FAIL, and an independent review found it HERE —
      // in the harness I built to catch exactly this (2026-08-07, HIGH). The
      // review was minted from `out.composed.args[0]`, THE SAME OBJECT the bytes
      // are encoded from, so "honest bytes diff null" was `f(x) === f(x)`: it
      // passed 250 cases by construction and would have passed them with the
      // gate deleted. The tamper half below was real; this half was scenery.
      //
      // The two sides must know the money INDEPENDENTLY. `out.legs` is the
      // ASSEMBLY's own cent-domain view — what a review surface actually renders
      // from — while `out.composed.args` is the calldata. Pairing them by index
      // is the real comparison the gate exists to make, and it now also exercises
      // the nullable-floor branch, because a basket leg's `minOutRaw` is null on
      // this side and a real haircut on the other.
      const shown = shownAtReviewSurface({
        chainId: input.chainId,
        fundingAsset: input.fundingAsset,
        fundingTotalRaw: input.fundingTotalRaw,
        recipient: input.account,
        legs: out.legs.map((l) => ({
          symbol: l.symbol,
          asset: l.asset,
          budgetRaw: l.budgetRaw,
          minOutRaw: l.minOutRaw,
          optional: l.optional,
        })),
        approvals: [],
      })
      const calls = [{ to: '0x00000000000000000000000000000000000b47c4' as const, data: encode(out.composed.args), value: out.composed.value }]
      expect(diffDisplayedVsSigned(calls, 0, calls[0].to, shown, out.composed), `case ${caseId}: honest bytes refused`).toBeNull()

      // …AND THE TWO SIDES ARE PROVABLY INDEPENDENT: perturb the SHOWN side
      // (the assembly's own leg view) and the gate must object. Under the old
      // wiring this case was impossible to write — `shown` WAS the calldata, so
      // no perturbation of it could ever disagree. That impossibility is what
      // made the law scenery, and this assertion is what stops it returning:
      // deleting a named field check is still covered by the catch-all
      // re-encode, so tampering the BYTES cannot prove independence — only
      // moving the review can.
      if (out.legs.length > 0) {
        const drifted = shownAtReviewSurface({
          chainId: input.chainId,
          fundingAsset: input.fundingAsset,
          fundingTotalRaw: input.fundingTotalRaw,
          recipient: input.account,
          legs: out.legs.map((l, i) => ({
            symbol: l.symbol,
            asset: l.asset,
            budgetRaw: i === 0 ? l.budgetRaw + 1n : l.budgetRaw, // the review claims one unit more
            minOutRaw: l.minOutRaw,
            optional: l.optional,
          })),
          approvals: [],
        })
        expect(
          diffDisplayedVsSigned(calls, 0, calls[0].to, drifted, out.composed),
          `case ${caseId}: a review that disagrees with the calldata must be caught — if this passes, the two sides are the same object again`,
        ).not.toBeNull()
      }

      // …and a ONE-UNIT floor tamper in the bytes diffs NON-NULL
      const tampered = structuredClone(out.composed.args)
      tampered[0][0] = { ...tampered[0][0], minOut: tampered[0][0].minOut + 1n }
      const tamperedCalls = [{ to: calls[0].to, data: encode(tampered), value: out.composed.value }]
      expect(diffDisplayedVsSigned(tamperedCalls, 0, calls[0].to, shown, out.composed), `case ${caseId}: tamper passed`).not.toBeNull()
    }
    // the harness must have EXERCISED both outcomes — 250 refusals is a broken
    // generator wearing a green suite (the coverage-denominator law). The
    // compose floor dropped 50 → 20 with the owner's consent-divergence ruling
    // (2026-08-13): a random multi-leg plan with any thin/unreadable leg now
    // over-allocates its survivors and REFUSES, so refusal is the common
    // outcome for random inputs; ~29 still genuinely exercises the compose path
    // (single-asset + all-survive-faithful cases), which is what this proves.
    expect(composedCount, `composed ${composedCount} / refused ${refusedCount}`).toBeGreaterThan(20)
    expect(refusedCount).toBeGreaterThan(10)
  })

  it('hostile single-field mutations: refuse in words or compose lawfully — never crash raw', () => {
    const rnd = lcg(0xdead17)
    const HOSTILE = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1e21]
    let mutated = 0
    for (let caseId = 0; caseId < 60; caseId++) {
      const input = genInput(rnd)
      const fields = ['grossCents', 'slippageBps', 'hubUsd', 'hopReserveUsd'] as const
      const field = fields[Math.floor(rnd() * fields.length)]
      const evil = HOSTILE[Math.floor(rnd() * HOSTILE.length)]
      mutated++
      try {
        const out = assembleBatchBuy({ ...input, [field]: evil })
        // composing is legal ONLY if every law still holds
        const spendable = input.fundingTotalRaw - (input.fundingTotalRaw * BigInt(BATCH_FEE_BPS)) / 10_000n
        expect(out.composed.args[0].reduce((s, l) => s + l.budget, 0n), `case ${caseId} ${field}=${evil}`).toBe(spendable)
        for (const l of out.legs) if (l.route !== 'basket') expect(l.minOutRaw! > 0n).toBe(true)
      } catch (e) {
        expect(e, `case ${caseId} ${field}=${evil}: ${String(e)}`).toBeInstanceOf(BatchComposeRefusal)
        expect((e as Error).message, `case ${caseId}`).not.toMatch(/NaN|undefined/)
      }
    }
    expect(mutated).toBe(60)
  })
})
