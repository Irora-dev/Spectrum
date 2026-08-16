import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AWAY_MAX_DELTAS,
  AWAY_MIN_GAP_MS,
  AWAY_SHARE_PP,
  captureAwaySnapshot,
  diffAwaySnapshots,
  loadAwaySnapshot,
  saveAwaySnapshot,
} from './away-diff'

const at = (h: number) => h * 60 * 60 * 1000

const snap = (
  hours: number,
  positions: { key: string; symbol: string; pct: number; valueUsd: number; exitCostPct?: number | null }[],
  totalUsd: number | null = 10_000,
) => captureAwaySnapshot(positions, totalUsd, at(hours))

describe('the away diff: measured deltas, never advice', () => {
  it('a short gap is a refresh, not an absence — no story', () => {
    const a = snap(0, [{ key: 'k1', symbol: 'AAA', pct: 50, valueUsd: 5_000 }])
    const b = snap(1, [{ key: 'k1', symbol: 'AAA', pct: 90, valueUsd: 9_000 }])
    expect(diffAwaySnapshots(a, b)).toEqual([])
    expect(at(1)).toBeLessThan(AWAY_MIN_GAP_MS)
  })

  it('states a share crossing in the drift card’s own units', () => {
    const a = snap(0, [{ key: 'k1', symbol: 'AAA', pct: 30, valueUsd: 3_000 }])
    const b = snap(12, [{ key: 'k1', symbol: 'AAA', pct: 30 + AWAY_SHARE_PP, valueUsd: 4_000 }])
    const out = diffAwaySnapshots(a, b)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'share-moved', symbol: 'AAA' })
    expect(out[0].sentence).toMatch(/grew 5\.0 points/)
  })

  it('exit-cost stories need BOTH sides measured', () => {
    const a = snap(0, [{ key: 'k1', symbol: 'AAA', pct: 50, valueUsd: 5_000, exitCostPct: null }])
    const b = snap(12, [{ key: 'k1', symbol: 'AAA', pct: 50, valueUsd: 5_000, exitCostPct: 8 }])
    expect(diffAwaySnapshots(a, b)).toEqual([])
    const a2 = snap(0, [{ key: 'k1', symbol: 'AAA', pct: 50, valueUsd: 5_000, exitCostPct: 2 }])
    const out = diffAwaySnapshots(a2, b)
    expect(out[0]).toMatchObject({ kind: 'exit-cost-moved', fromPct: 2, toPct: 8 })
  })

  it('arrivals and departures are stories; slivers are not', () => {
    const a = snap(0, [{ key: 'k1', symbol: 'AAA', pct: 100, valueUsd: 10_000 }])
    const b = snap(12, [
      { key: 'k1', symbol: 'AAA', pct: 60, valueUsd: 6_000 },
      { key: 'k2', symbol: 'BBB', pct: 38, valueUsd: 3_800 },
      { key: 'k3', symbol: 'DUST', pct: 2, valueUsd: 200 },
    ])
    const kinds = diffAwaySnapshots(a, b).map((d) => d.kind)
    expect(kinds).toContain('position-new')
    expect(kinds).not.toContain('position-gone')
    expect(diffAwaySnapshots(b, snap(24, [{ key: 'k1', symbol: 'AAA', pct: 100, valueUsd: 10_000 }])).map((d) => d.kind)).toContain(
      'position-gone',
    )
    // DUST at 2% never arrived as a story
    expect(diffAwaySnapshots(a, b).find((d) => d.kind === 'position-new' && d.symbol === 'DUST')).toBeUndefined()
  })

  it('total movement is a story past the floor, silent under it', () => {
    const a = snap(0, [], 10_000)
    expect(diffAwaySnapshots(a, snap(12, [], 10_150))).toEqual([])
    const out = diffAwaySnapshots(a, snap(12, [], 10_300))
    expect(out[0]).toMatchObject({ kind: 'total-moved' })
    expect(out[0].sentence).toMatch(/up 3\.0%/)
  })

  it('ranks by magnitude and caps the briefing', () => {
    const a = snap(0, [
      { key: 'k1', symbol: 'A', pct: 30, valueUsd: 3_000 },
      { key: 'k2', symbol: 'B', pct: 30, valueUsd: 3_000 },
      { key: 'k3', symbol: 'C', pct: 20, valueUsd: 2_000 },
      { key: 'k4', symbol: 'D', pct: 10, valueUsd: 1_000 },
      { key: 'k5', symbol: 'E', pct: 10, valueUsd: 1_000 },
    ])
    const b = snap(12, [
      { key: 'k1', symbol: 'A', pct: 5, valueUsd: 500 },
      { key: 'k2', symbol: 'B', pct: 50, valueUsd: 5_000 },
      { key: 'k3', symbol: 'C', pct: 28, valueUsd: 2_800 },
      { key: 'k4', symbol: 'D', pct: 2, valueUsd: 200 },
      { key: 'k5', symbol: 'E', pct: 15, valueUsd: 1_500 },
    ], 9_500)
    const out = diffAwaySnapshots(a, b)
    expect(out.length).toBeLessThanOrEqual(AWAY_MAX_DELTAS)
    // biggest move (A, -25pp) leads
    expect(out[0]).toMatchObject({ kind: 'share-moved', symbol: 'A' })
  })

  it('sentences follow the copy rules', () => {
    const a = snap(0, [{ key: 'k1', symbol: 'AAA', pct: 30, valueUsd: 3_000, exitCostPct: 2 }], 10_000)
    const b = snap(12, [{ key: 'k1', symbol: 'AAA', pct: 40, valueUsd: 5_000, exitCostPct: 6 }], 12_000)
    for (const d of diffAwaySnapshots(a, b)) {
      expect(d.sentence).not.toMatch(/—/)
      expect(d.sentence).not.toMatch(/bps|oracle|slippage/i)
    }
  })
})

// ── v2: a re-priced holding is not an arrival (specallocator's mount residual,
//    flagged 2026-08-04 — "a sayable lie", closed here in the module) ──────────
describe('unpricedKeys: pricing coming back is not news', () => {
  const pos = (key: string, symbol: string, pct: number) => ({ key, symbol, pct, valueUsd: pct * 10 })
  const DAY = 24 * 3600_000

  it('a position that was HELD-but-unpriced yesterday is not called new today', () => {
    const prev = captureAwaySnapshot([pos('8453:0xaa', 'AAA', 60)], 1_000, 0, ['8453:0xbb'])
    const next = captureAwaySnapshot([pos('8453:0xaa', 'AAA', 60), pos('8453:0xbb', 'BBB', 40)], 1_000, DAY)
    expect(diffAwaySnapshots(prev, next).some((d) => d.kind === 'position-new')).toBe(false)
  })

  it('a GENUINE arrival is still news', () => {
    const prev = captureAwaySnapshot([pos('8453:0xaa', 'AAA', 60)], 1_000, 0, ['8453:0xcc'])
    const next = captureAwaySnapshot([pos('8453:0xaa', 'AAA', 60), pos('8453:0xbb', 'BBB', 40)], 1_000, DAY)
    const d = diffAwaySnapshots(prev, next).find((x) => x.kind === 'position-new')
    expect(d && 'symbol' in d ? d.symbol : null).toBe('BBB')
  })

  it('a v1 snapshot (no unpricedKeys) suppresses nothing — unknown is not a claim', () => {
    const prev = { ...captureAwaySnapshot([pos('8453:0xaa', 'AAA', 60)], 1_000, 0), v: 1 as const }
    const next = captureAwaySnapshot([pos('8453:0xaa', 'AAA', 60), pos('8453:0xbb', 'BBB', 40)], 1_000, DAY)
    expect(diffAwaySnapshots(prev, next).some((d) => d.kind === 'position-new')).toBe(true)
  })
})

// ── storage round-trip: the loader must accept what capture WRITES. All the
//    tests above are pure-diff — none crossed localStorage, which is exactly
//    how a loader still gating on v:1 shipped green while capture wrote v:2
//    (every saved snapshot rejected on the next visit; the briefing dead) ─────
describe('storage round-trip: a saved snapshot loads on the next visit', () => {
  // Node env, no jsdom (vitest.config.ts) — stub the one surface the module
  // touches, Map-backed like the other storage tests in this directory.
  const stubStorage = (seed: Record<string, string> = {}) => {
    const m = new Map<string, string>(Object.entries(seed))
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
      },
    })
    return m
  }
  afterEach(() => vi.unstubAllGlobals())

  it('capture → save → load returns the snapshot, and it diffs a moved book', () => {
    stubStorage()
    const captured = captureAwaySnapshot(
      [{ key: 'k1', symbol: 'AAA', pct: 30, valueUsd: 3_000 }],
      10_000,
      at(0),
      ['8453:0xbb'],
    )
    saveAwaySnapshot('0xAnchor', captured)
    const loaded = loadAwaySnapshot('0xAnchor')
    // The defect this pins: capture writes v:2; a loader accepting only v:1
    // rejects its own build's snapshots, so the away briefing never runs.
    expect(loaded).not.toBeNull()
    expect(loaded).toEqual(captured)
    const next = snap(12, [{ key: 'k1', symbol: 'AAA', pct: 30 + AWAY_SHARE_PP, valueUsd: 4_000 }])
    const out = diffAwaySnapshots(loaded!, next)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'share-moved', symbol: 'AAA' })
  })

  it('a stored v1 row (no unpricedKeys) still loads — the promise the type comment makes', () => {
    stubStorage({
      'spectrum:away:v1:0xanchor': JSON.stringify({
        v: 1,
        atMs: at(0),
        totalUsd: 10_000,
        positions: { k1: { symbol: 'AAA', pct: 60, valueUsd: 6_000 } },
      }),
    })
    const loaded = loadAwaySnapshot('0xanchor')
    expect(loaded).not.toBeNull()
    expect(loaded).toMatchObject({ v: 1, atMs: at(0) })
    expect(loaded!.unpricedKeys).toBeUndefined()
    // absent unpricedKeys behaves as v1 always did: nothing suppressed, an
    // arrival is still news once loaded and diffed
    const next = snap(12, [
      { key: 'k1', symbol: 'AAA', pct: 60, valueUsd: 6_000 },
      { key: 'k2', symbol: 'BBB', pct: 40, valueUsd: 4_000 },
    ])
    expect(diffAwaySnapshots(loaded!, next).some((d) => d.kind === 'position-new')).toBe(true)
  })
})
