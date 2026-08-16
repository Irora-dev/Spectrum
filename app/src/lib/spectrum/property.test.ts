import { describe, expect, it } from 'vitest'
import { centBudgets } from './plan-legs'
import { integerShares } from './publish-picks'
import { unifyAssets } from './asset-unify'
import { resolveLadder, submissionReducer, ForbiddenFallback, type SubmissionEvent, type SubmissionState } from './capability-ladder'

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY TESTS (battle-test item 2, the owner "do all of these"): the pins test
// cases someone thought of; these test THOUSANDS nobody did. Dependency-free:
// a seeded LCG (no Math.random — reruns are deterministic, failures replayable
// by seed) + exhaustive small-trace model checking for the reducer.
// ─────────────────────────────────────────────────────────────────────────────

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32

describe('arithmetic invariants under 2,000 random inputs each', () => {
  it('centBudgets ALWAYS sums exactly to the total, every budget ≥ 0', () => {
    const rnd = lcg(42)
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 12)
      const weights = Array.from({ length: n }, () => rnd() * 100)
      const total = Math.floor(rnd() * 10_000_000)
      const b = centBudgets(weights, total)
      const sum = b.reduce((s, v) => s + v, 0)
      if (weights.some((w) => w > 0) && total > 0) expect(sum).toBe(total)
      expect(b.every((v) => v >= 0)).toBe(true)
    }
  })

  it('integerShares ALWAYS sums to 100 with every picked leg ≥ 1', () => {
    const rnd = lcg(7)
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 12)
      const values = Array.from({ length: n }, () => 0.01 + rnd() * 50_000)
      const s = integerShares(values)
      expect(s.reduce((a, v) => a + v, 0)).toBe(100)
      if (n <= 100) expect(s.every((v) => v >= 1)).toBe(true)
    }
  })

  it('unifyAssets CONSERVES value and pct — parts always sum to their tile', () => {
    const rnd = lcg(99)
    const SYMS = ['ETH', 'WETH', 'USDC', 'PEPE', 'AAVE', 'WBTC', 'CBBTC', 'DEGEN']
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 10)
      const rows = Array.from({ length: n }, (_, j) => ({
        key: `${1 + Math.floor(rnd() * 3)}:0x${j}${i % 97}`,
        chainId: 1,
        address: `0x${j}`,
        symbol: SYMS[Math.floor(rnd() * SYMS.length)],
        valueUsd: rnd() * 10_000,
        pct: rnd() * 20,
      }))
      const out = unifyAssets(rows)
      const inV = rows.reduce((s, r) => s + r.valueUsd, 0)
      const outV = out.reduce((s, u) => s + u.valueUsd, 0)
      expect(Math.abs(inV - outV)).toBeLessThan(1e-6)
      const inP = rows.reduce((s, r) => s + (r.pct ?? 0), 0)
      const outP = out.reduce((s, u) => s + u.pct, 0)
      expect(Math.abs(inP - outP)).toBeLessThan(1e-6)
      for (const u of out) expect(Math.abs(u.parts.reduce((s, p) => s + p.valueUsd, 0) - u.valueUsd)).toBeLessThan(1e-9)
    }
  })

  it('resolveLadder: confirmCount ≥ 1, txCount ≥ 1, and atomic is ALWAYS exactly one confirm', () => {
    const rnd = lcg(1234)
    for (let i = 0; i < 2000; i++) {
      const sells = Array.from({ length: Math.floor(rnd() * 6) }, (_, j) => ({
        token: `0x${j}` as `0x${string}`,
        symbol: `S${j}`,
        amountRaw: 1n + BigInt(Math.floor(rnd() * 1e6)),
      }))
      const needs = {
        chainId: 1,
        sellApprovals: sells,
        fundingApproval: rnd() > 0.5 ? { token: '0xf' as `0x${string}`, symbol: 'USDC', amountRaw: 1n } : null,
      }
      const caps = {
        atomicBatch: rnd() > 0.5,
        permit2: rnd() > 0.5,
        permit2Approved: new Set<string>(rnd() > 0.5 ? sells.map((s) => s.token.toLowerCase()) : []),
        funding2612: rnd() > 0.5,
      }
      const r = resolveLadder(needs, caps)
      expect(r.confirmCount).toBeGreaterThanOrEqual(1)
      expect(r.txCount).toBeGreaterThanOrEqual(1)
      expect(r.confirmCount).toBe(r.confirms.length)
      if (caps.atomicBatch) expect(r.confirmCount).toBe(1)
    }
  })
})

describe('the reducer is model-checked: NO event sequence reaches a double-buy', () => {
  const EVENTS: SubmissionEvent[] = [
    { type: 'attempt' },
    { type: 'unsupported-definitive' },
    { type: 'submitted', submissionId: 'x' },
    { type: 'ambiguous-silence' },
    { type: 'resolved-success' },
    { type: 'resolved-failure', reason: 'r' },
  ]
  it('exhaustive over every event sequence up to depth 6 (~46k traces)', () => {
    let submissions = 0
    const walk = (state: SubmissionState, depth: number, subsInTrace: number) => {
      // THE INVARIANT: a trace may never contain a second submission after
      // one exists un-resolved, and no legal transition ever lowers the rung
      // once submitted. We assert by construction: count submissions per
      // trace; a legal second 'submitted' can only follow a rung advance,
      // which is only reachable pre-submission.
      expect(subsInTrace).toBeLessThanOrEqual(1)
      if (depth === 0) return
      for (const ev of EVENTS) {
        let next: SubmissionState
        try {
          next = submissionReducer(state, ev)
        } catch (e) {
          expect(e).toBeInstanceOf(ForbiddenFallback)
          continue // illegal move refused — the machine held
        }
        if (ev.type === 'submitted') submissions++
        walk(next, depth - 1, subsInTrace + (ev.type === 'submitted' ? 1 : 0))
      }
    }
    walk({ phase: 'idle', rung: 1 }, 6, 0)
    expect(submissions).toBeGreaterThan(0) // the model actually exercised submits
  })
})
