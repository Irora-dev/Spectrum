import { describe, expect, it } from 'vitest'
import { execEntryFor } from './use-execution-runner'

describe('execEntryFor — the changes GETTER (owner 2026-08-16: batcher runs were invisible in recent-transactions)', () => {
  it('resolves a getter at write time, exactly like a static array', () => {
    const e = execEntryFor(
      { kind: 'rebalance', totalUsd: 100, changes: () => [{ symbol: 'PONS', deltaUsd: 554.75 }] },
      { partial: false, completedSteps: [] },
      1_000,
    )
    expect(e.changes).toEqual([{ symbol: 'PONS', deltaUsd: 554.75 }])
    expect(e.totalUsd).toBe(100)
  })

  it('a getter answering undefined leaves the row change-free, and partial-without-changes still nulls the total', () => {
    const e = execEntryFor(
      { kind: 'rebalance', totalUsd: 100, changes: () => undefined },
      { partial: true, completedSteps: [] },
      1_000,
    )
    expect(e.changes).toBeUndefined()
    expect(e.totalUsd).toBeNull()
  })
})
