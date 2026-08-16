import { describe, expect, it, vi } from 'vitest'
import { appendExec, loadExecLog, loadExecLogGroup } from './exec-log'

const fakeStorage = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe('the execution log (16:4x features 1+7)', () => {
  it('round-trips entries, case-insensitive scope, newest last', () => {
    const s = fakeStorage()
    appendExec('0xAbC', { ts: 1000, kind: 'create', totalUsd: 500, simulated: true }, s)
    appendExec('0xabc', { ts: 2000, kind: 'rebalance', totalUsd: null, changes: [{ symbol: 'WETH', deltaUsd: -120.5, realizedUsd: 14.2 }], simulated: true }, s)
    const rows = loadExecLog('0xABC', s)
    expect(rows).toHaveLength(2)
    expect(rows[1].kind).toBe('rebalance')
    expect(rows[1].changes![0]).toEqual({ symbol: 'WETH', deltaUsd: -120.5, realizedUsd: 14.2 })
  })

  it('sanitizes junk rows instead of throwing — storage is a trust boundary', () => {
    const s = fakeStorage()
    s.setItem('spectrum:execlog:0xabc', JSON.stringify([
      { ts: 1, kind: 'create', totalUsd: 10, simulated: true },
      { ts: 'NaN', kind: 'create', totalUsd: 10, simulated: true },
      { ts: 2, kind: 'hack', totalUsd: 10, simulated: true },
      { ts: 3, kind: 'publish', totalUsd: 'x', simulated: true },
      null,
    ]))
    const rows = loadExecLog('0xabc', s)
    expect(rows).toHaveLength(1)
    expect(rows[0].ts).toBe(1)
  })

  it('caps the log so a runaway writer cannot flood storage', () => {
    const s = fakeStorage()
    for (let i = 1; i <= 210; i++) appendExec('0xabc', { ts: i, kind: 'create', totalUsd: null, simulated: true }, s)
    const rows = loadExecLog('0xabc', s)
    expect(rows).toHaveLength(200)
    expect(rows[0].ts).toBe(11) // oldest dropped
  })
})

describe('the group timeline (one portfolio, one history — the owner 2026-08-11)', () => {
  it('merges every member newest-FIRST, each row tagged with the wallet that made it', () => {
    const s = fakeStorage()
    appendExec('0xAAA', { ts: 1000, kind: 'create', totalUsd: 500, simulated: true }, s)
    appendExec('0xBBB', { ts: 3000, kind: 'rebalance', totalUsd: null, simulated: true }, s)
    appendExec('0xAAA', { ts: 2000, kind: 'publish', totalUsd: 100, simulated: true }, s)

    const rows = loadExecLogGroup(['0xAAA', '0xBBB'], s)
    expect(rows.map((r) => r.ts)).toEqual([3000, 2000, 1000])
    expect(rows.map((r) => r.wallet)).toEqual(['0xbbb', '0xaaa', '0xaaa'])
    // the per-wallet read is untouched — the log is still keyed per wallet on
    // write, because which wallet SIGNED is a fact about the money
    expect(loadExecLog('0xAAA', s)).toHaveLength(2)
    expect(loadExecLog('0xBBB', s)).toHaveLength(1)
  })

  it('a wallet appearing twice in the group does not double its rows', () => {
    const s = fakeStorage()
    appendExec('0xAAA', { ts: 1000, kind: 'create', totalUsd: 1, simulated: true }, s)
    expect(loadExecLogGroup(['0xAAA', '0xaaa', ''], s)).toHaveLength(1)
  })

  it('unlinking a wallet drops its rows from the timeline but never destroys them', () => {
    const s = fakeStorage()
    appendExec('0xAAA', { ts: 1000, kind: 'create', totalUsd: 1, simulated: true }, s)
    appendExec('0xBBB', { ts: 2000, kind: 'create', totalUsd: 2, simulated: true }, s)
    // the group is now A alone (B unlinked)
    expect(loadExecLogGroup(['0xAAA'], s).map((r) => r.ts)).toEqual([1000])
    // …and B's own history survives for when it is linked again
    expect(loadExecLog('0xBBB', s)).toHaveLength(1)
  })
})

describe('tab-race convergence (audit follow-up)', () => {
  it('a clobbered append re-lands on the deferred read-back — both rows survive', async () => {
    const s = fakeStorage()
    appendExec('0xabc', { ts: 111, kind: 'create', totalUsd: 5, simulated: true }, s)
    // a concurrent tab's write lands WITHOUT our row (the race's loss mode)
    s.setItem('spectrum:execlog:0xabc', JSON.stringify([{ ts: 222, kind: 'rebalance', totalUsd: null, simulated: true }]))
    await new Promise((r) => setTimeout(r, 5)) // the deferred verify fires
    const rows = loadExecLog('0xabc', s)
    expect(rows.map((r) => r.ts).sort()).toEqual([111, 222])
  })
})

describe('audit round 3: a PARTIAL row may not claim money it never moved', () => {
  const mem = fakeStorage
  const A = '0xAbC'
  it('forces totalUsd to null when a partial entry has no changes to back it', () => {
    // Before: a partial `create` kept the full intended $500, so a run that
    // stopped at the bridge still told the chart and the CSV it brought that in.
    const s = mem()
    appendExec(A, { ts: 1, kind: 'create', totalUsd: 500, simulated: false, partial: true, stoppedAt: 'the bridge' }, s)
    expect(loadExecLog(A, s)[0].totalUsd).toBeNull()
  })

  it('keeps totalUsd when the partial row CARRIES the changes that back it', () => {
    const s = mem()
    appendExec(
      A,
      { ts: 1, kind: 'create', totalUsd: 200, simulated: false, partial: true, changes: [{ symbol: 'WETH', deltaUsd: 200 }] },
      s,
    )
    expect(loadExecLog(A, s)[0].totalUsd).toBe(200)
  })

  it('a COMPLETE row is untouched — the clamp is only about partials', () => {
    const s = mem()
    appendExec(A, { ts: 1, kind: 'create', totalUsd: 500, simulated: false }, s)
    expect(loadExecLog(A, s)[0].totalUsd).toBe(500)
  })

  it('the partial markers survive the seam (stoppedAt, failedLegIndex)', () => {
    const s = mem()
    appendExec(A, { ts: 1, kind: 'rebalance', totalUsd: null, simulated: false, partial: true, stoppedAt: 'the Base transaction', failedLegIndex: 2 }, s)
    expect(loadExecLog(A, s)[0]).toMatchObject({ partial: true, stoppedAt: 'the Base transaction', failedLegIndex: 2 })
  })
})

describe('mutation-survivor kills round 3 — the two untested PROTECTIONS', () => {
  it('THE CAP IS REAL: a runaway writer is bounded at 200 rows, keeping the NEWEST (the slice mutant survived — nothing tested the flood guard)', () => {
    const s = fakeStorage()
    for (let i = 0; i < 205; i++) appendExec('0xabc', { ts: i, kind: 'create', totalUsd: 1, simulated: true }, s)
    const rows = loadExecLog('0xabc', s)
    expect(rows).toHaveLength(200)
    expect(rows[0].ts).toBe(5) // the five OLDEST fell off
    expect(rows[199].ts).toBe(204)
  })

  it('THE TAB-RACE RE-APPEND CONVERGES: a concurrent clobber loses the row for 0ms, not forever', async () => {
    vi.useFakeTimers()
    try {
      const s = fakeStorage()
      appendExec('0xabc', { ts: 111, kind: 'create', totalUsd: 5, simulated: true }, s)
      // the slower tab's write lands AFTER ours and drops our row — exactly the
      // race the deferred read-back exists for
      s.setItem('spectrum:execlog:0xabc', JSON.stringify([{ ts: 999, kind: 'rebalance', totalUsd: null, simulated: true }]))
      await vi.runAllTimersAsync()
      const rows = loadExecLog('0xabc', s)
      expect(rows.map((r) => r.ts).sort((a, b) => a - b)).toEqual([111, 999]) // both tabs' rows survive
    } finally {
      vi.useRealTimers()
    }
  })

  it('the re-append identity is (ts AND kind): a same-ts different-kind row is NOT ours, so ours is restored beside it', async () => {
    vi.useFakeTimers()
    try {
      const s = fakeStorage()
      appendExec('0xabc', { ts: 111, kind: 'create', totalUsd: 5, simulated: true }, s)
      s.setItem('spectrum:execlog:0xabc', JSON.stringify([{ ts: 111, kind: 'rebalance', totalUsd: null, simulated: true }]))
      await vi.runAllTimersAsync()
      const kinds = loadExecLog('0xabc', s).map((r) => r.kind).sort()
      expect(kinds).toEqual(['create', 'rebalance'])
      // and when OUR row is genuinely present, the read-back does NOT duplicate it
      const s2 = fakeStorage()
      appendExec('0xabc', { ts: 222, kind: 'publish', totalUsd: 9, simulated: true }, s2)
      await vi.runAllTimersAsync()
      expect(loadExecLog('0xabc', s2)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the kind whitelist keeps all three kinds and drops strangers; empty addr and dead storage are no-ops', () => {
    const s = fakeStorage()
    s.setItem(
      'spectrum:execlog:0xabc',
      JSON.stringify([
        { ts: 1, kind: 'create', totalUsd: 1, simulated: true },
        { ts: 2, kind: 'rebalance', totalUsd: 1, simulated: true },
        { ts: 3, kind: 'publish', totalUsd: 1, simulated: true },
        { ts: 4, kind: 'garbage', totalUsd: 1, simulated: true },
      ]),
    )
    expect(loadExecLog('0xabc', s).map((r) => r.kind)).toEqual(['create', 'rebalance', 'publish'])
    expect(loadExecLog('', s)).toEqual([])
    expect(() => appendExec('', { ts: 5, kind: 'create', totalUsd: 1, simulated: true }, s)).not.toThrow()
    expect(loadExecLog('0xabc', s)).toHaveLength(3) // the empty-addr write went nowhere
    s.setItem('spectrum:execlog:0xdef', '{{{ not json')
    expect(loadExecLog('0xdef', s)).toEqual([])
  })
})
