import { describe, expect, it, beforeEach } from 'vitest'
import type { Address } from 'viem'
import {
  discardQuarantine,
  readReleaseSurface,
  releaseStuckRecord,
  releaseSurfaceHasWork,
  sweepUnknownRows,
} from './release-surface'
import { recordSubmission, markClaimAmbiguous, claimStep, readQuarantineRaw } from './submission-store'

// The human release surface's model — the go-live interlock's precondition
// ("dup:/ambiguous/quarantined records would have NO exit except
// clear-site-data") built and pinned. Same MemStore idiom as the runner suite.

class MemStore implements Storage {
  private m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  clear() {
    this.m.clear()
  }
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
}

const ME = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const NOW = 1_700_000_600_000
const AT = 1_700_000_000_000 // ten minutes earlier

let store: MemStore
beforeEach(() => {
  store = new MemStore()
})

const submitted = (over: Partial<Parameters<typeof recordSubmission>[0]> = {}) => {
  recordSubmission(
    { chainId: 8453, stepKey: 'batch', rung: 0, submissionId: 'calls:8453:abc123def456', signer: ME, atMs: AT, ...over },
    store,
  )
}

describe('readReleaseSurface — what waits on a human, in plain words', () => {
  it('a submitted-unresolved record lists with its age, id and the re-run promise', () => {
    submitted()
    const s = readReleaseSurface(NOW, store)
    expect(s.records).toHaveLength(1)
    expect(s.records[0].kind).toBe('submitted')
    expect(s.records[0].words).toMatch(/10 minutes ago/)
    expect(s.records[0].words).toMatch(/never written down/)
    expect(s.records[0].releaseWarning).toMatch(/releasing forgets/)
  })

  it('an AMBIGUOUS claim lists as the may-have-moved case; a FRESH claim never lists', () => {
    // fresh claim: another tab mid-prompt — the surface must not invite a race
    expect(claimStep(1, 'bridge', ME, AT + 590_000, store)).toBe('claimed')
    // ambiguous claim: wallet never answered clearly
    expect(claimStep(8453, 'batch', ME, AT, store)).toBe('claimed')
    markClaimAmbiguous(8453, 'batch', ME, AT, store)
    const s = readReleaseSurface(NOW, store)
    expect(s.records).toHaveLength(1)
    expect(s.records[0].kind).toBe('ambiguous')
    // instruction-first copy (the owner live 2026-08-14: the old horror-tone
    // "money MAY have moved" read as a system failure, not a guard)
    expect(s.records[0].words).toMatch(/no clear answer came back/)
    expect(s.records[0].words).toMatch(/Check that wallet/)
    expect(s.records[0].words).toMatch(/keeps the same money from being sent twice/)
  })

  it('oldest first — the longest-stuck record is the one the human came for', () => {
    submitted({ stepKey: 'late', atMs: AT + 60_000 })
    submitted({ stepKey: 'early', atMs: AT })
    const s = readReleaseSurface(NOW, store)
    expect(s.records.map((r) => r.stepKey)).toEqual(['early', 'late'])
  })

  it('hasWork self-hides: empty store = nothing to say', () => {
    expect(releaseSurfaceHasWork(NOW, store)).toBe(false)
    submitted()
    expect(releaseSurfaceHasWork(NOW, store)).toBe(true)
  })
})

describe('releaseStuckRecord — the checked-wallet act, owner-gated', () => {
  it('the signer releases; the record and its protection go, and the words say so', () => {
    submitted()
    const rec = readReleaseSurface(NOW, store).records[0]
    const out = releaseStuckRecord(rec, ME, store)
    expect(out.ok).toBe(true)
    expect(out.words).toMatch(/double-buy protection/)
    expect(readReleaseSurface(NOW, store).records).toHaveLength(0)
  })

  it('another wallet CANNOT release — the record stays, the sentence names the fix', () => {
    submitted()
    const rec = readReleaseSurface(NOW, store).records[0]
    const out = releaseStuckRecord(rec, OTHER, store)
    expect(out.ok).toBe(false)
    expect(out.words).toMatch(/wallet that signed/)
    expect(readReleaseSurface(NOW, store).records).toHaveLength(1)
    // and no wallet at all is the same refusal
    expect(releaseStuckRecord(rec, undefined, store).ok).toBe(false)
  })
})

describe('the quarantine path — evidence shown, then discarded by a human only', () => {
  it('unknown rows sweep to quarantine on the named act, and the book heals', () => {
    submitted()
    // poison the book with an unparseable row beside the good one
    const raw = store.getItem('spectrum:live-submission:v1')!
    const rows = JSON.parse(raw) as unknown[]
    rows.push({ garbage: true })
    store.setItem('spectrum:live-submission:v1', JSON.stringify(rows))
    const before = readReleaseSurface(NOW, store)
    expect(before.unknownRows).toBe(1)
    expect(sweepUnknownRows(store)).toBe(1)
    const after = readReleaseSurface(NOW, store)
    expect(after.unknownRows).toBe(0)
    expect(after.quarantineRaw).not.toBeNull()
    expect(after.records).toHaveLength(1) // the good record survived the sweep
  })

  it('discard clears the quarantine — and only the quarantine', () => {
    submitted()
    store.setItem('spectrum:live-submission:v1:quarantine', '{"stashed":"bytes"}')
    expect(readQuarantineRaw(store)).not.toBeNull()
    discardQuarantine(store)
    expect(readQuarantineRaw(store)).toBeNull()
    expect(readReleaseSurface(NOW, store).records).toHaveLength(1)
  })
})
