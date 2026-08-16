import { describe, expect, it } from 'vitest'
import { execEntryFor } from './use-execution-runner'

// The one law the wagmi hook carries in its own file — extracted pure and
// pinned here (audit round: a hook with zero tests held the exec-log write
// mapping, and the partial-row law lived only at READ-back).

const SHAPE = { kind: 'create' as const, totalUsd: 500, changes: undefined }

describe('execEntryFor — the exec-log write mapping', () => {
  it('a PARTIAL entry with no changes writes totalUsd NULL — never the intended figure (audit round 3, at write time)', () => {
    const e = execEntryFor(SHAPE, { partial: true, stoppedAt: 'the Base batch', completedSteps: [] }, 1_700)
    expect(e.totalUsd).toBeNull()
    expect(e.partial).toBe(true)
    expect(e.stoppedAt).toBe('the Base batch')
  })

  it('a PARTIAL entry WITH exact per-leg changes keeps the figure the changes back', () => {
    const shape = { kind: 'rebalance' as const, totalUsd: 120, changes: [{ symbol: 'AAVE', deltaUsd: 120 }] }
    const e = execEntryFor(shape, { partial: true, completedSteps: ['batch:8453'] }, 1_700)
    expect(e.totalUsd).toBe(120)
    expect(e.changes).toEqual(shape.changes)
  })

  it('a COMPLETE entry keeps the figure and carries no partial fields at all', () => {
    const e = execEntryFor(SHAPE, { partial: false, completedSteps: ['batch:8453'] }, 1_700)
    expect(e.totalUsd).toBe(500)
    expect('partial' in e).toBe(false)
    expect('stoppedAt' in e).toBe(false)
  })

  it('failedLegIndex 0 SURVIVES the mapping — leg 0 is a real leg, and a truthiness guard would drop it', () => {
    const e = execEntryFor(SHAPE, { partial: true, failedLegIndex: 0, completedSteps: [] }, 1_700)
    expect(e.failedLegIndex).toBe(0)
    // and an absent index stays absent, never becomes a claimed leg
    const none = execEntryFor(SHAPE, { partial: true, completedSteps: [] }, 1_700)
    expect('failedLegIndex' in none).toBe(false)
  })

  it('stamps the interlock constant and the caller clock verbatim', () => {
    const e = execEntryFor(SHAPE, { partial: false, completedSteps: [] }, 1_234_567)
    expect(e.ts).toBe(1_234_567)
    expect(typeof e.simulated).toBe('boolean')
  })
})
