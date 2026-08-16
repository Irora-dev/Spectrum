import { describe, expect, it } from 'vitest'
import { SEED_DEPTH_BLOCK_PCT, SEED_DEPTH_WARN_PCT, seedGuard } from './seed-guard'

describe('the seed guard (contracts desk 36: the self-wreck at first mint)', () => {
  it('BLOCKS the measured wreck shape: a leg buy thousands of times its pool', () => {
    // Their fixture: 40% of a seed against a pool ~a millionth the siblings'.
    const out = seedGuard([
      { symbol: 'THIN', seedUsd: 4_000, depthUsd: 2 },
      { symbol: 'B', seedUsd: 4_000, depthUsd: 4_000_000 },
      { symbol: 'C', seedUsd: 2_000, depthUsd: 4_000_000 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ symbol: 'THIN', severity: 'block', code: 'depth' })
    expect(out[0].reason).toMatch(/times its whole market/)
  })

  it('passes the healthy 1/100th shape contracts measured behaving fine', () => {
    expect(seedGuard([{ symbol: 'OK', seedUsd: 1_000, depthUsd: 100_000 }])).toEqual([])
  })

  it('WARNS between the tiers, with INCLUSIVE boundaries', () => {
    const warn = seedGuard([{ symbol: 'X', seedUsd: SEED_DEPTH_WARN_PCT + 1, depthUsd: 100 }])
    expect(warn[0]?.severity).toBe('warn')
    // SUPERSEDED 2026-08-04 (audit): this asserted that a seed exactly AT the
    // floor said nothing. Exclusive boundaries meant the block tier excluded
    // its own worst case (a seed the size of the whole pool merely warned), and
    // plan-legs already reads depth with `>=`. One comparison grammar across
    // the depth surfaces; the tiers are inclusive at both ends now.
    expect(seedGuard([{ symbol: 'X', seedUsd: SEED_DEPTH_WARN_PCT, depthUsd: 100 }])[0]?.severity).toBe('warn')
    const block = seedGuard([{ symbol: 'X', seedUsd: SEED_DEPTH_BLOCK_PCT + 1, depthUsd: 100 }])
    expect(block[0]?.severity).toBe('block')
  })

  it('unreadable depth is SAID (warn), never treated as zero', () => {
    const out = seedGuard([{ symbol: 'X', seedUsd: 100, depthUsd: null }])
    expect(out[0]).toMatchObject({ severity: 'warn', code: 'no-depth-data' })
  })

  it('a zero-depth pool blocks: there is no market to seed against', () => {
    expect(seedGuard([{ symbol: 'X', seedUsd: 100, depthUsd: 0 }])[0]?.code).toBe('dust-pool')
  })

  it('a zero seed leg is not judged; an UNREADABLE one is said', () => {
    expect(seedGuard([{ symbol: 'X', seedUsd: 0, depthUsd: 5 }])).toEqual([])
    // SUPERSEDED 2026-08-04 (audit): this asserted silence for a NaN seed —
    // an unreadable amount reading as clean, on the surface whose whole job is
    // refusing. Nothing seeded is nothing to judge; something we cannot
    // MEASURE is a said warn, exactly like unreadable depth beside it.
    expect(seedGuard([{ symbol: 'X', seedUsd: Number.NaN, depthUsd: 5 }])[0]?.severity).toBe('warn')
  })

  it('shown sentences follow the house copy rules', () => {
    for (const v of seedGuard([
      { symbol: 'A', seedUsd: 5_000, depthUsd: 2 },
      { symbol: 'B', seedUsd: 50, depthUsd: 100 },
      { symbol: 'C', seedUsd: 100, depthUsd: null },
    ])) {
      expect(v.reason).toBeTruthy()
      expect(v.reason!).not.toMatch(/—/)
      expect(v.reason!).not.toMatch(/bps|basis point|oracle|slippage/i)
    }
  })
})

describe('the audit round (2026-08-04): unreadable is said, and the boundary includes its worst case', () => {
  it('an unreadable seed amount WARNS instead of passing silently', () => {
    // Before: a non-finite seedUsd was skipped, so a leg whose seed dollars
    // could not be computed produced no verdict — the read-failed law inverted
    // on the surface that exists to refuse.
    const v = seedGuard([{ symbol: 'X', seedUsd: Number.NaN, depthUsd: 100 }])
    expect(v).toHaveLength(1)
    expect(v[0].severity).toBe('warn')
    expect(v[0].reason).toMatch(/could not work out how much/)
  })

  it('a seed exactly the size of the whole pool BLOCKS — it was the worst case and it warned', () => {
    const v = seedGuard([{ symbol: 'X', seedUsd: 100, depthUsd: 100 }])
    expect(v[0].severity).toBe('block')
    expect(v[0].reason).toMatch(/the size of its whole market/)
  })

  it('a seed exactly at the warn floor warns — the boundary is inclusive both ends', () => {
    expect(seedGuard([{ symbol: 'X', seedUsd: 10, depthUsd: 100 }])[0].severity).toBe('warn')
  })

  it('a zero or negative seed is still nothing to judge — silence is right there', () => {
    expect(seedGuard([{ symbol: 'X', seedUsd: 0, depthUsd: 100 }])).toEqual([])
    expect(seedGuard([{ symbol: 'X', seedUsd: -5, depthUsd: 100 }])).toEqual([])
  })
})
