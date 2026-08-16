import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLAIM_TTL_MS,
  claimStep,
  quarantineUnknownRows,
  quarantinedRaw,
  clearSubmission,
  hydrateSubmission,
  liveSubmissions,
  markClaimAmbiguous,
  readSubmissions,
  RECENT_COMPLETION_WINDOW_MS,
  recordCycleCompletion,
  recentCycleCompletionAt,
  recordStepCompletion,
  recentStepCompletionAt,
  recordSubmission,
  submissionSigner,
  sweepExpiredClaims,
  type LiveSubmission,
  renewClaim,
  probeWritable,
} from './submission-store'
import { ForbiddenFallback, submissionReducer } from './capability-ladder'

// E5's LIFETIME half (battle-test half-2 finding 1, HIGH): the reducer is
// airtight within one instance; the store is what makes a REMOUNTED machine
// start at `submitted` instead of a blank `idle` — the breaking sequence
// (attempt → submitted → silence → REMOUNT → attempt on a fresh machine)
// must die at hydration.

class FakeStorage implements Storage {
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

const A = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const

/** A stamp fixtures can use when they do not care about the value. `atMs: 1`
 *  used to serve here and is now correctly rejected: 1ms after the epoch is not
 *  a claim stamp, and the range check exists because a past stamp let another
 *  tab steal a LIVE claim (self-audit 2026-08-07). */
const PLAUSIBLE_MS = 1_800_000_000_000
const sub = (over: Partial<LiveSubmission> = {}): LiveSubmission => ({
  chainId: 8453,
  stepKey: 'batch',
  rung: 0,
  submissionId: 'calls-0xabc',
  signer: A,
  atMs: 1_700_000_000_000,
  ...over,
})

let store: FakeStorage
beforeEach(() => {
  store = new FakeStorage()
})

describe('the submission store — E5 across instance boundaries', () => {
  it('THE BREAKING SEQUENCE DIES: a remounted machine hydrates to submitted, where attempt THROWS', () => {
    // instance 1: attempt → submitted → ambiguous silence (holding, correct)
    let s = submissionReducer({ phase: 'idle', rung: 0 }, { type: 'attempt' })
    s = submissionReducer(s, { type: 'submitted', submissionId: 'calls-0xabc', signer: A })
    recordSubmission(sub(), store)
    s = submissionReducer(s, { type: 'ambiguous-silence' })
    expect(s.phase).toBe('submitted')
    // the REMOUNT: instance 2 must not start at idle
    const fresh = hydrateSubmission(8453, 'batch', store)
    expect(fresh.phase).toBe('submitted')
    // the double-buy move is unrepresentable again
    expect(() => submissionReducer(fresh, { type: 'attempt' })).toThrow(ForbiddenFallback)
    // and the held submission still resolves normally
    expect(submissionReducer(fresh, { type: 'resolved-success' }).phase).toBe('succeeded')
  })

  it('no live record hydrates to a blank idle at rung 0', () => {
    expect(hydrateSubmission(8453, 'batch', store)).toEqual({ phase: 'idle', rung: 0 })
  })

  it('hydration carries the recorded rung and submissionId — resolution polls the RIGHT id', () => {
    recordSubmission(sub({ rung: 2, submissionId: 'tx-0xdef' }), store)
    const s = hydrateSubmission(8453, 'batch', store)
    expect(s).toEqual({ phase: 'submitted', rung: 2, submissionId: 'tx-0xdef' })
  })

  it('resolution clears the record — the next run starts clean', () => {
    recordSubmission(sub(), store)
    clearSubmission(8453, 'batch', store)
    expect(hydrateSubmission(8453, 'batch', store).phase).toBe('idle')
    expect(liveSubmissions(store)).toHaveLength(0)
  })

  it('records key by (chain, step) — a Base batch does not shadow an Ethereum one', () => {
    recordSubmission(sub({ chainId: 8453 }), store)
    recordSubmission(sub({ chainId: 1, submissionId: 'other' }), store)
    expect(hydrateSubmission(1, 'batch', store)).toMatchObject({ submissionId: 'other' })
    expect(hydrateSubmission(8453, 'batch', store)).toMatchObject({ submissionId: 'calls-0xabc' })
  })

  it('the record carries the SIGNER — a mid-run wallet switch is detectable (finding 6)', () => {
    recordSubmission(sub(), store)
    expect(liveSubmissions(store)[0].signer).toBe(A)
  })

  it('submissionSigner answers PER (chain, stepKey) among many records — the mutation run caught both conjuncts untested', () => {
    // Path-3 survivor kill (Stryker, 2026-08-04): dropping EITHER half of the
    // find's `chainId === x && stepKey === y` survived the whole suite, because
    // every signer test used a single record. Law 11's guard reads this lookup
    // — with several live records, a wrong filter compares the wrong wallet.
    const B = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const C = '0x4200000000000000000000000000000000000006'
    recordSubmission(sub({ chainId: 8453, stepKey: 'batch:8453', signer: A }), store)
    recordSubmission(sub({ chainId: 1, stepKey: 'batch:1', signer: B, submissionId: 'tx-b' }), store)
    recordSubmission(sub({ chainId: 8453, stepKey: 'bridge:8453->1', signer: C, submissionId: 'tx-c' }), store)
    expect(submissionSigner(8453, 'batch:8453', store)).toBe(A)
    expect(submissionSigner(1, 'batch:1', store)).toBe(B)
    expect(submissionSigner(8453, 'bridge:8453->1', store)).toBe(C)
    // same stepKey, wrong chain — and same chain, wrong stepKey: both null
    expect(submissionSigner(1, 'batch:8453', store)).toBeNull()
    expect(submissionSigner(8453, 'batch:1', store)).toBeNull()
  })

  it('malformed rows are dropped at the boundary, never rendered (the storage-seam law)', () => {
    store.setItem(
      'spectrum:live-submission:v1',
      JSON.stringify([
        { chainId: 'not-a-number', stepKey: 'batch', rung: 0, submissionId: 'x', signer: A, atMs: PLAUSIBLE_MS },
        { chainId: 8453, stepKey: '', rung: 0, submissionId: 'x', signer: A, atMs: PLAUSIBLE_MS },
        { chainId: 8453, stepKey: 'ok', rung: 0, submissionId: 'x', signer: 'not-an-address', atMs: PLAUSIBLE_MS },
        sub(),
      ]),
    )
    const live = liveSubmissions(store)
    expect(live).toHaveLength(1)
    expect(live[0].stepKey).toBe('batch')
  })

  // ⚠⚠ THIS TEST PINNED THE CRITICAL AS INTENDED (adversarial pass, 2026-08-08).
  // It asserted recordSubmission stays SILENT on a store that cannot write —
  // "degrades to in-instance protection only" — which is safe ONLY if law 8
  // makes that state unreachable, and law 8's probe wrote ONE BYTE to certify a
  // 120-byte-per-row book. Measured: both probes passed on a nearly-full store,
  // claimStep said 'claimed' having written nothing, this returned normally
  // having written nothing, the run said done, and after a reload the next run
  // SUBMITTED THE SAME MONEY. A record of live money that did not persist must
  // be loud, because the caller's catch is the honest recovery — it marks the
  // claim ambiguous and stops the run.
  it('a quota-dead storage makes recordSubmission LOUD — silence was the double buy', () => {
    const dead = new FakeStorage()
    dead.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    expect(() => recordSubmission(sub(), dead)).toThrow(/did not persist/)
    expect(hydrateSubmission(8453, 'batch', dead).phase).toBe('idle')
  })
})

describe('audit round 3: nothing evicts live money', () => {
  it('a 13th unresolved submission does NOT push the first one out', () => {
    // Before: MAX_ROWS sliced the oldest away on write. Every row here is
    // unresolved money, so the cap could only ever evict a LIVE submission —
    // and an evicted record hydrates as idle, where attempt is legal. The TTL
    // mistake I rejected, reached by row count instead of a clock.
    for (let i = 0; i < 13; i += 1)
      recordSubmission(sub({ stepKey: `batch:${i}`, submissionId: `tx-${i}` }), store)
    expect(liveSubmissions(store)).toHaveLength(13)
    expect(hydrateSubmission(8453, 'batch:0', store)).toMatchObject({ phase: 'submitted', submissionId: 'tx-0' })
  })

  it('an absurd row count reads as CORRUPT — refuse, never trim', () => {
    for (let i = 0; i < 70; i += 1)
      recordSubmission(sub({ stepKey: `batch:${i}`, submissionId: `tx-${i}` }), store)
    const read = readSubmissions(store)
    expect(read.rows.length).toBe(70) // nothing was forgotten
    expect(read.corrupt).toBe(true) // and the runner's gate will refuse
  })

  it('a normal multi-chain plan is nowhere near the ceiling', () => {
    for (const k of ['batch:8453', 'bridge:8453->1', 'batch:1']) recordSubmission(sub({ stepKey: k }), store)
    expect(readSubmissions(store).corrupt).toBe(false)
  })
})

describe('mutation-survivor kills round 2 (path-3 triage) — the storage boundary zoo + the key filters', () => {
  const RAW_KEY = 'spectrum:live-submission:v1'
  const valid = { chainId: 1, stepKey: 'k', rung: 0, submissionId: 'id', signer: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', atMs: PLAUSIBLE_MS }

  it('parseRow accepts each field AT its bound and refuses just past it — dropped counts every reject', () => {
    const rows = [
      valid,
      { ...valid, stepKey: 'x'.repeat(80) }, // AT the step-key cap
      { ...valid, rung: 8 }, // AT the rung cap
      // AT the id cap — sized for EIP-5792's 4096-byte ids plus our prefix
      // (A6 review 2026-08-07: at 200, a spec-compliant wallet's id made the
      // runner's own record unreadable the moment it was written)
      { ...valid, submissionId: 'i'.repeat(4200) },
      { ...valid, submissionId: null }, // a claim row is a valid row
      { ...valid, ambiguous: true }, // an ambiguous claim is a valid row
      { ...valid, ambiguous: false },
      // AT each RANGE bound — the halves this test's own title promised and did
      // not have. The self-audit added the atMs range check with only its
      // REJECT side pinned (one ms outside, below), so nothing asserted the
      // bounds were INCLUSIVE, and the mutation sweep proved it on 2026-08-07:
      // flipping `<` to `<=` and `>` to `>=` in parseRow killed no test. That
      // check is what stops a claim stamped 0 or -1 reading as long-expired and
      // being stolen by another tab, so its edges are a money boundary.
      { ...valid, atMs: 1_577_836_800_000 }, // exactly the floor — legal
      { ...valid, atMs: 4_102_444_800_000 }, // exactly the ceiling — legal
      // one past each bound, plus the shapes a validator forgets:
      { ...valid, stepKey: 'x'.repeat(81) },
      { ...valid, stepKey: '' },
      { ...valid, rung: 9 },
      { ...valid, rung: -1 },
      { ...valid, rung: 1.5 },
      { ...valid, submissionId: '' },
      { ...valid, submissionId: 'i'.repeat(4201) },
      { ...valid, chainId: 0 },
      { ...valid, chainId: -5 },
      { ...valid, chainId: 1.5 },
      { ...valid, atMs: Number.POSITIVE_INFINITY },
      // the RANGE bounds, beside every other field's (self-audit 2026-08-07)
      { ...valid, atMs: 1_577_836_799_999 }, // one ms before the floor
      { ...valid, atMs: 4_102_444_800_001 }, // one ms past the ceiling
      { ...valid, ambiguous: 'yes' }, // a string is not a flag
    ]
    store.setItem(RAW_KEY, JSON.stringify(rows))
    const read = readSubmissions(store)
    expect(read.rows.length).toBe(9)
    expect(read.dropped).toBe(rows.length - 9)
    expect(read.corrupt).toBe(false)
  })

  it('the corrupt ceiling is EXACT: 64 readable rows are a book, 65 refuse (nothing trims either way)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...valid, stepKey: `k${i}` }))
    store.setItem(RAW_KEY, JSON.stringify(many(64)))
    expect(readSubmissions(store).corrupt).toBe(false)
    store.setItem(RAW_KEY, JSON.stringify(many(65)))
    const over = readSubmissions(store)
    expect(over.corrupt).toBe(true)
    expect(over.rows.length).toBe(65) // reported, never forgotten
  })

  it('clearSubmission removes ONE (chain, stepKey) row — neighbours sharing either half of the key survive', () => {
    recordSubmission(sub({ chainId: 8453, stepKey: 'a', submissionId: 't1' }), store)
    recordSubmission(sub({ chainId: 1, stepKey: 'a', submissionId: 't2' }), store)
    recordSubmission(sub({ chainId: 8453, stepKey: 'b', submissionId: 't3' }), store)
    clearSubmission(8453, 'a', store)
    const left = liveSubmissions(store).map((r) => `${r.chainId}:${r.stepKey}`)
    expect(left.sort()).toEqual(['1:a', '8453:b'])
  })

  it('claimStep collides only on ITS OWN (chain, stepKey) — a neighbour claim answers for nothing else', () => {
    const now = 1_700_000_000_000
    expect(claimStep(8453, 'a', A, now, store)).toBe('claimed')
    // same stepKey, other chain — and same chain, other stepKey: both free
    expect(claimStep(1, 'a', A, now, store)).toBe('claimed')
    expect(claimStep(8453, 'b', A, now, store)).toBe('claimed')
    // the exact key is genuinely held
    expect(claimStep(8453, 'a', A, now + 1, store)).toBe('held-by-other-tab')
    // and a SUBMITTED row answers already-submitted, not held
    recordSubmission(sub({ chainId: 8453, stepKey: 'c', submissionId: 'live' }), store)
    expect(claimStep(8453, 'c', A, now, store)).toBe('already-submitted')
  })

  it('the claim TTL boundary is EXACT: held one tick before 90s, takeable AT 90s', () => {
    const t0 = 1_700_000_000_000
    expect(claimStep(8453, 'edge', A, t0, store)).toBe('claimed')
    expect(claimStep(8453, 'edge', A, t0 + CLAIM_TTL_MS - 1, store)).toBe('held-by-other-tab')
    expect(claimStep(8453, 'edge', A, t0 + CLAIM_TTL_MS, store)).toBe('claimed')
  })
})

describe('the claim heartbeat (round-10 hole: 90s sat inside a human prompt dwell)', () => {
  const A2 = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const
  const B2 = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

  it('a renewed claim holds PAST the raw TTL — expiry measures liveness, not reading speed', () => {
    const t0 = 1_700_000_000_000
    expect(claimStep(8453, 'hb', A2, t0, store)).toBe('claimed')
    // heartbeat at 80s: the human is still reading the prompt
    expect(renewClaim(8453, 'hb', A2, t0 + 80_000, store)).toBe(true)
    // 91s after t0 (11s after the renewal): WITHOUT the heartbeat this was
    // takeover-eligible — the exact double-submit door. Now it is held.
    expect(claimStep(8453, 'hb', B2, t0 + 91_000, store)).toBe('held-by-other-tab')
    // the holder stops renewing (tab gone): takeable one TTL after the LAST beat
    expect(claimStep(8453, 'hb', B2, t0 + 80_000 + CLAIM_TTL_MS, store)).toBe('claimed')
  })

  it('renewClaim refuses to touch a SUBMISSION — expiry does not apply to money in flight', () => {
    const t0 = 1_700_000_000_000
    recordSubmission(sub({ chainId: 8453, stepKey: 'live', submissionId: 'id-1', atMs: t0 }), store)
    expect(renewClaim(8453, 'live', A2, t0 + 5_000, store)).toBe(false)
  })

  it("renewClaim refuses another signer's claim — not ours to extend", () => {
    const t0 = 1_700_000_000_000
    expect(claimStep(8453, 'other', A2, t0, store)).toBe('claimed')
    expect(renewClaim(8453, 'other', B2, t0 + 10_000, store)).toBe(false)
  })

  it('renewClaim on a missing record is false, never an invented row', () => {
    expect(renewClaim(8453, 'ghost', A2, 1_700_000_000_000, store)).toBe(false)
  })
})

describe('R4 — a malformed row is DROPPED, never an exception', () => {
  const raw = (v: unknown) => JSON.stringify(v)
  it('null, arrays and primitives inside the array do not crash the read', () => {
    for (const poison of [[null], [undefined], [[]], [1], ['x'], [true], [null, null]]) {
      const st = new FakeStorage()
      st.setItem('spectrum:live-submission:v1', raw(poison))
      expect(() => liveSubmissions(st), JSON.stringify(poison)).not.toThrow()
      expect(liveSubmissions(st)).toEqual([])
    }
  })
  it('a GOOD row beside a poisoned one still survives — one bad row is not a lost claim', () => {
    const st = new FakeStorage()
    recordSubmission(
      { chainId: 8453, stepKey: 'batch:8453:x', rung: 1, submissionId: 'tx:1', signer: '0x1111111111111111111111111111111111111111', atMs: PLAUSIBLE_MS },
      st,
    )
    const arr = JSON.parse(st.getItem('spectrum:live-submission:v1')!)
    st.setItem('spectrum:live-submission:v1', raw([null, ...arr, null]))
    expect(liveSubmissions(st)).toHaveLength(1)
  })
})

describe('A6 round (2026-08-07) — every write PRESERVES unknown rows: the evidence survives', () => {
  // The claim heartbeat used to destroy the very row law 12 refuses on, every
  // 15 seconds, while the user read the wallet prompt — and the next run's
  // door check then found a scrubbed store (both A6 lenses, independently).
  const RAW_KEY = 'spectrum:live-submission:v1'
  const plantPoison = () => {
    const raw = JSON.parse(store.getItem(RAW_KEY) ?? '[]') as unknown[]
    raw.push({ chainId: 8453, stepKey: 'poisoned', rung: 0, submissionId: 'POISON-TX', signer: 'not-an-address', atMs: PLAUSIBLE_MS })
    store.setItem(RAW_KEY, JSON.stringify(raw))
  }
  it('recordSubmission carries an unknown row through — it used to erase it', () => {
    plantPoison()
    recordSubmission(sub(), store)
    expect(store.getItem(RAW_KEY)).toContain('POISON-TX')
    expect(readSubmissions(store).dropped).toBe(1) // the door check still refuses
  })
  it('clearSubmission carries it through', () => {
    recordSubmission(sub(), store)
    plantPoison()
    clearSubmission(8453, 'batch', store)
    expect(store.getItem(RAW_KEY)).toContain('POISON-TX')
  })
  it('renewClaim — the 15s heartbeat, the erasure engine — carries it through', () => {
    expect(claimStep(8453, 'k', A, 1_700_000_000_000, store)).toBe('claimed')
    plantPoison()
    expect(renewClaim(8453, 'k', A, 1_700_000_010_000, store)).toBe(true)
    expect(store.getItem(RAW_KEY)).toContain('POISON-TX')
    expect(readSubmissions(store).dropped).toBe(1)
  })
  it('a corrupt BLOB is never written over — there is nothing to carry', () => {
    store.setItem(RAW_KEY, 'not json at all')
    clearSubmission(8453, 'batch', store)
    renewClaim(8453, 'k', A, 1, store)
    sweepExpiredClaims(1, store)
    expect(store.getItem(RAW_KEY)).toBe('not json at all')
  })
  it('recordSubmission on a corrupt blob writes the record alone — live money outranks a blob nothing can read', () => {
    store.setItem(RAW_KEY, 'not json at all')
    recordSubmission(sub(), store)
    expect(liveSubmissions(store)).toHaveLength(1)
  })
})

describe('A6 round — recordSubmission REFUSES a row its own read would drop (the silent-void class)', () => {
  it('an over-long stepKey throws instead of writing an unreadable record', () => {
    expect(() => recordSubmission(sub({ stepKey: 'x'.repeat(81) }), store)).toThrow(/could not be read back/)
    expect(liveSubmissions(store)).toHaveLength(0)
  })
  it('an over-long submissionId throws too', () => {
    expect(() => recordSubmission(sub({ submissionId: 'i'.repeat(4201) }), store)).toThrow(/could not be read back/)
  })
  it('a compliant 5792 id — 4096 bytes plus our prefix — round-trips (it used to be dropped at 200)', () => {
    const id = `calls:8453:${'a'.repeat(4096)}`
    recordSubmission(sub({ submissionId: id }), store)
    expect(hydrateSubmission(8453, 'batch', store)).toMatchObject({ phase: 'submitted', submissionId: id })
  })
})

describe('A6 round — ambiguity does not expire: the ambiguous claim', () => {
  const t0 = 1_700_000_000_000
  it('markClaimAmbiguous converts a held claim, and claimStep refuses it FOREVER — not for 90s', () => {
    expect(claimStep(8453, 'k', A, t0, store)).toBe('claimed')
    markClaimAmbiguous(8453, 'k', A, t0 + 1_000, store)
    expect(claimStep(8453, 'k', A, t0 + CLAIM_TTL_MS + 1, store)).toBe('held-ambiguous') // past the TTL
    expect(claimStep(8453, 'k', A, t0 + 1_000 * 60 * 60 * 24 * 365, store)).toBe('held-ambiguous') // a year later
  })
  it('re-marks a vanished row rather than demoting the ambiguity to nothing', () => {
    markClaimAmbiguous(8453, 'k', A, t0, store) // no row existed (a heartbeat write was lost)
    expect(claimStep(8453, 'k', A, t0 + CLAIM_TTL_MS * 10, store)).toBe('held-ambiguous')
  })
  it("never touches a real submission or another signer's claim", () => {
    recordSubmission(sub({ stepKey: 's1', submissionId: 'live-tx' }), store)
    markClaimAmbiguous(8453, 's1', A, t0, store)
    expect(hydrateSubmission(8453, 's1', store)).toMatchObject({ phase: 'submitted', submissionId: 'live-tx' })
    const B = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
    expect(claimStep(8453, 's2', B, t0, store)).toBe('claimed')
    markClaimAmbiguous(8453, 's2', A, t0 + 1, store) // not ours to mark
    // ⚠ THE `?.` USED TO BE THE WHOLE HOLE (independent pass, 2026-08-08).
    // `find(...)?.ambiguous` is undefined when find returns NOTHING, so this
    // assertion was satisfied both by leaving B's claim alone AND BY DELETING
    // IT OUTRIGHT — and deleting is the shape a refactor produces, since every
    // other mutator here uses the same `writeBook([...rows.filter(...)])`
    // idiom. Planted, it passed 65/65 in this file and 1963 across the tree.
    // The unprotected path is exactly what this module exists to close: tab B
    // holds a claim at the wallet prompt, tab A erases it, tab A claims and
    // submits the same money. GENERAL FORM: `?.` in an assertion about "did you
    // leave this alone" can ALWAYS be satisfied by deleting the thing.
    const s2 = liveSubmissions(store).find((r) => r.stepKey === 's2')
    expect(s2, 'B\'s claim must still EXIST — deleting it is not leaving it alone').toBeDefined()
    expect(s2?.signer).toBe(B)
    expect(s2?.ambiguous).toBeUndefined()
  })
})

describe('A6 round — expired plain claims are SWEPT; nothing else is', () => {
  const t0 = 1_700_000_000_000
  it('drops only the expired, non-ambiguous claims — abandoned tabs cannot ratchet toward the ceiling', () => {
    claimStep(8453, 'expired', A, t0 - CLAIM_TTL_MS, store) // expired plain claim
    claimStep(8453, 'fresh', A, t0 - 1_000, store) // fresh claim
    markClaimAmbiguous(8453, 'ambig', A, t0 - CLAIM_TTL_MS * 10, store) // old but AMBIGUOUS
    recordSubmission(sub({ stepKey: 'live', submissionId: 'tx' }), store) // a submission
    sweepExpiredClaims(t0, store)
    expect(liveSubmissions(store).map((r) => r.stepKey).sort()).toEqual(['ambig', 'fresh', 'live'])
  })
  it('changes nothing while unknown rows exist — a sweep must not write over evidence', () => {
    claimStep(8453, 'expired', A, t0 - CLAIM_TTL_MS, store)
    const raw = JSON.parse(store.getItem('spectrum:live-submission:v1')!) as unknown[]
    store.setItem('spectrum:live-submission:v1', JSON.stringify([...raw, null]))
    sweepExpiredClaims(t0, store)
    expect(store.getItem('spectrum:live-submission:v1')).toContain('expired')
    expect(readSubmissions(store).dropped).toBe(1)
  })
})

describe('law 12 at the CLAIM seam — claimStep refuses to claim over rows it cannot read', () => {
  // Found closing R6's pin (2026-08-07): the runner checks store health at the
  // DOOR, but a row can appear mid-run — and claimStep treated an unreadable
  // row as ABSENT, claimed, and its own write then rebuilt the blob from
  // parseable rows only, ERASING the evidence. Unknown is not absent.
  const RAW_KEY = 'spectrum:live-submission:v1'
  it('an unreadable row answers store-unreadable and WRITES NOTHING', () => {
    store.setItem(
      RAW_KEY,
      JSON.stringify([{ chainId: 8453, stepKey: 'k', rung: 0, submissionId: 'x', signer: 'not-an-address', atMs: PLAUSIBLE_MS }]),
    )
    const before = store.getItem(RAW_KEY)
    expect(claimStep(8453, 'k', A, 1_700_000_000_000, store)).toBe('store-unreadable')
    expect(store.getItem(RAW_KEY)).toBe(before) // the evidence is untouched
  })
  it('a corrupt blob answers the same — same class of unknown', () => {
    store.setItem(RAW_KEY, 'not json at all')
    expect(claimStep(8453, 'k', A, 1_700_000_000_000, store)).toBe('store-unreadable')
    expect(store.getItem(RAW_KEY)).toBe('not json at all')
  })
  it('a healthy book still claims normally — the gate is not a blanket refusal', () => {
    recordSubmission(sub({ stepKey: 'other-step' }), store)
    expect(claimStep(8453, 'k', A, 1_700_000_000_000, store)).toBe('claimed')
  })
})


describe('A6 verify pass — no writer may MINT a row its own read would drop', () => {
  // The verify pass proved claimStep could do it to itself: chainOf(step) can
  // carry NaN, JSON.stringify writes NaN as null, and the resulting row is
  // unparseable — refusing every future run, forever, from OUR OWN claim.
  it('claimStep refuses a non-finite chainId instead of writing poison', () => {
    expect(() => claimStep(Number.NaN, 'k', A, 1_700_000_000_000, store)).toThrow(/could not be read back/)
    expect(readSubmissions(store).dropped).toBe(0)
    expect(store.getItem('spectrum:live-submission:v1')).toBeNull()
  })
  it('claimStep refuses an over-long stepKey from any caller', () => {
    expect(() => claimStep(8453, 'x'.repeat(81), A, 1_700_000_000_000, store)).toThrow(/could not be read back/)
    expect(readSubmissions(store).dropped).toBe(0)
  })
  // ⚠ THIS TEST USED TO ASSERT A THROW, AND THE THROW WAS THE CRITICAL.
  // Both call sites are inside a catch for recordSubmission, validating the
  // same atMs — so throwing here did not report a second problem, it DELETED
  // the handling of the first, and the next run re-submitted and reported done
  // (independent pass, 2026-08-08). The law this test names is unchanged and is
  // still the one that matters — no writer may mint a row its own read would
  // drop. Only the mechanism moved, from throw to refuse.
  it('markClaimAmbiguous REFUSES rather than throws — every caller is a catch block', () => {
    expect(markClaimAmbiguous(Number.NaN, 'k', A, 1_700_000_000_000, store)).toBe(false)
    expect(readSubmissions(store).dropped).toBe(0)
    expect(store.getItem('spectrum:live-submission:v1')).toBeNull()
  })
  it('markClaimAmbiguous KEEPS the rung it is told, and the one already on the row', () => {
    const t0 = 1_700_000_000_000
    markClaimAmbiguous(8453, 'k', A, t0, store, 4)
    expect(liveSubmissions(store)[0]).toMatchObject({ ambiguous: true, rung: 4 })
    // an existing claim's rung survives a later mark that does not name one
    markClaimAmbiguous(8453, 'k', A, t0 + 1, store)
    expect(liveSubmissions(store)[0].rung).toBe(4)
  })
})

describe('A6 verify pass — unknown rows have an EXIT that is not "nuke everything"', () => {
  const RAW_KEY = 'spectrum:live-submission:v1'
  const plantPoison = () => {
    const raw = JSON.parse(store.getItem(RAW_KEY) ?? '[]') as unknown[]
    raw.push({ chainId: 8453, stepKey: 'poisoned', rung: 0, submissionId: 'POISON-TX', signer: 'not-an-address', atMs: PLAUSIBLE_MS })
    store.setItem(RAW_KEY, JSON.stringify(raw))
  }

  it('without an exit a poison row is IMMORTAL — every mutator preserves it (that is the point, and the problem)', () => {
    recordSubmission(sub({ stepKey: 'live', submissionId: 'tx' }), store)
    plantPoison()
    clearSubmission(8453, 'live', store)
    renewClaim(8453, 'live', A, 2, store)
    sweepExpiredClaims(9_999_999_999, store)
    expect(readSubmissions(store).dropped).toBe(1) // nothing removed it
  })

  it('quarantine moves the unknown rows OUT and leaves the real ones — the book heals, the evidence survives', () => {
    recordSubmission(sub({ stepKey: 'live', submissionId: 'tx' }), store)
    plantPoison()
    expect(quarantineUnknownRows(store)).toBe(1)
    const after = readSubmissions(store)
    expect(after.dropped).toBe(0) // the door check passes again
    expect(after.corrupt).toBe(false)
    expect(after.rows.map((r) => r.stepKey)).toEqual(['live']) // real money untouched
    expect(quarantinedRaw(store)).toContain('POISON-TX') // and nothing was destroyed
  })

  it('a corrupt blob quarantines whole, and the live key starts clean', () => {
    store.setItem(RAW_KEY, 'not json at all')
    expect(quarantineUnknownRows(store)).toBe(1)
    expect(readSubmissions(store)).toMatchObject({ dropped: 0, corrupt: false })
    expect(quarantinedRaw(store)).toContain('not json at all')
  })

  it('quarantining twice APPENDS — a second incident cannot erase the first one\'s evidence', () => {
    plantPoison()
    quarantineUnknownRows(store)
    store.setItem(RAW_KEY, JSON.stringify([{ chainId: 1, stepKey: 'second', rung: 0, submissionId: 'SECOND-TX', signer: 'nope', atMs: PLAUSIBLE_MS }]))
    quarantineUnknownRows(store)
    const raw = quarantinedRaw(store) ?? ''
    expect(raw).toContain('POISON-TX')
    expect(raw).toContain('SECOND-TX')
  })

  it('a healthy book quarantines nothing', () => {
    recordSubmission(sub(), store)
    expect(quarantineUnknownRows(store)).toBe(0)
    expect(liveSubmissions(store)).toHaveLength(1)
    expect(quarantinedRaw(store)).toBeNull()
  })

  it('the corrupt-blob record path STASHES before it overwrites — it used to erase and silently heal', () => {
    // A half-written foreign record + our own live submission arriving: the
    // record must win (money in flight), but the bytes must not vanish, and
    // the next door check must not pass on a store that was refusing.
    store.setItem(RAW_KEY, '[{"chainId":8453,"stepKey":"half-writ')
    recordSubmission(sub({ stepKey: 'ours', submissionId: 'ours-tx' }), store)
    expect(liveSubmissions(store).map((r) => r.stepKey)).toEqual(['ours'])
    expect(quarantinedRaw(store)).toContain('half-writ')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE CHAOS — promoted from the open-findings registry (desk-250-R7) the
// day probeWritable landed; the registry row flipped and these are its pins.
// ─────────────────────────────────────────────────────────────────────────────
describe('probeWritable — the mid-run door probe', () => {
  it('answers true on a store whose round-trip holds, and cleans its sentinel', () => {
    const s = new FakeStorage()
    expect(probeWritable(s)).toBe(true)
    expect(s.getItem('spectrum:live-submission:v1:probe')).toBeNull()
  })

  it('a QUOTA-DEAD store answers false — the R7 shape, caught before the wallet is asked', () => {
    const s = new FakeStorage()
    const dead = {
      getItem: (k: string) => s.getItem(k),
      removeItem: (k: string) => s.removeItem(k),
      setItem: () => {
        // DOMException in the browser; any throw is the same answer here
        throw new Error('QuotaExceededError: the quota has been exceeded')
      },
    } as unknown as Storage
    expect(probeWritable(dead)).toBe(false)
  })

  it('a store that WRITES but does not READ BACK is as dead as one that throws', () => {
    const s = new FakeStorage()
    const amnesiac = {
      getItem: () => null, // accepts writes, remembers nothing
      setItem: (k: string, v: string) => s.setItem(k, v),
      removeItem: (k: string) => s.removeItem(k),
    } as unknown as Storage
    expect(probeWritable(amnesiac)).toBe(false)
  })

  it('a stuck sentinel is NOT a failed probe — a record that persists is the property', () => {
    const s = new FakeStorage()
    const noRemove = {
      getItem: (k: string) => s.getItem(k),
      setItem: (k: string, v: string) => s.setItem(k, v),
      removeItem: () => {
        throw new Error('remove refused')
      },
    } as unknown as Storage
    expect(probeWritable(noRemove)).toBe(true)
  })

  it('a null store answers false — a run that cannot record may not submit', () => {
    expect(probeWritable(null)).toBe(false)
  })
})

describe('two-tab interleavings — the claim seam under company', () => {
  const TAB_A = '0x00000000000000000000000000000000000000aa' as const
  const TAB_B = '0x00000000000000000000000000000000000000bb' as const
  const NOW = 1_800_000_000_000

  it('tab B cannot claim a step tab A holds; a resolved claim frees it', () => {
    const s = new FakeStorage()
    expect(claimStep(1, 'batch:1:x', TAB_A, NOW, s)).toBe('claimed')
    expect(claimStep(1, 'batch:1:x', TAB_B, NOW + 1_000, s)).not.toBe('claimed')
    clearSubmission(1, 'batch:1:x', s)
    expect(claimStep(1, 'batch:1:x', TAB_B, NOW + 2_000, s)).toBe('claimed')
  })

  it('a foreign row landing BETWEEN read and claim still cannot be claimed over (law 12)', () => {
    const s = new FakeStorage()
    // tab A claims; then the raw blob gains an unknown row (another app
    // version writing a shape we cannot parse) — tab B must refuse the STORE,
    // not just the step
    expect(claimStep(1, 'batch:1:y', TAB_A, NOW, s)).toBe('claimed')
    const raw = s.getItem('spectrum:live-submission:v1')!
    const book = JSON.parse(raw) as unknown[]
    book.push({ mystery: true })
    s.setItem('spectrum:live-submission:v1', JSON.stringify(book))
    expect(claimStep(1, 'batch:1:z', TAB_B, NOW + 1_000, s)).toBe('store-unreadable')
  })
})

describe('the step key is COMPOSITE — both halves must match (gate A12 left this unpinned)', () => {
  // The sweep flipped `r.chainId === chainId && r.stepKey === stepKey` to `||`
  // in claimStep and renewClaim, and nothing objected: no test had two rows
  // differing in only ONE half of the key. With `||`, a claim on Base would
  // find Ethereum's row for the same step name — adopting another chain's live
  // submission as this one's, which is the double-buy shape the whole store
  // exists to prevent. The key's two halves each need a test that isolates it.
  const A = '0x00000000000000000000000000000000000000aa' as const
  const NOW = 1_800_000_000_000

  it('the same stepKey on a DIFFERENT chain is a different step', () => {
    const s = new FakeStorage()
    expect(claimStep(1, 'batch:x', A, NOW, s)).toBe('claimed')
    // same step name, other chain — must be claimable, not seen as taken
    expect(claimStep(8453, 'batch:x', A, NOW, s)).toBe('claimed')
    expect(readSubmissions(s).rows).toHaveLength(2)
  })

  it('…and under CONTENTION too — a different holder on another chain is still a different step', () => {
    // ⚠ THE SAME-SIGNER CASE ABOVE DOES NOT ISOLATE THE KEY (the sweep proved
    // it: one mutant survived that test). With `||`, a Base claim finds
    // Ethereum's row — and when the signer MATCHES, the TTL/renew branch still
    // answers 'claimed', so the bug hides. Two DIFFERENT holders is what
    // separates them: correct code sees no row and claims; the broken form sees
    // another holder's LIVE claim and refuses. Two tabs on two chains is also
    // the realistic shape, not a contrived one.
    const s = new FakeStorage()
    const B = '0x00000000000000000000000000000000000000bb' as const
    expect(claimStep(1, 'batch:x', A, NOW, s)).toBe('claimed')
    expect(claimStep(8453, 'batch:x', B, NOW + 1_000, s)).toBe('claimed')
    expect(readSubmissions(s).rows).toHaveLength(2)
    // and the two rows really belong to their own holders
    const rows = readSubmissions(s).rows
    expect(rows.find((r) => r.chainId === 1)!.signer.toLowerCase()).toBe(A)
    expect(rows.find((r) => r.chainId === 8453)!.signer.toLowerCase()).toBe(B)
  })

  it('a DIFFERENT stepKey on the same chain is a different step', () => {
    const s = new FakeStorage()
    expect(claimStep(1, 'batch:x', A, NOW, s)).toBe('claimed')
    expect(claimStep(1, 'batch:y', A, NOW, s)).toBe('claimed')
    expect(readSubmissions(s).rows).toHaveLength(2)
  })

  it('renewing a live claim is not blocked by a SUBMITTED neighbour sharing only the step name', () => {
    // ⚠ WHAT ACTUALLY ISOLATES renewClaim's FIND (the sweep's last survivor):
    // when both rows pass the same guards the `||` mutant is EQUIVALENT — the
    // found row is only read for guard checks, and the write still keyed
    // correctly. The rows must DIFFER in what a guard sees. Real shape: a
    // multi-chain run where Ethereum has already submitted and Base is still at
    // the wallet prompt. Correct code renews Base's claim; the broken form finds
    // Ethereum's SUBMITTED row, sees an id, and refuses to renew a live claim —
    // which expires it mid-prompt and invites the retry this store prevents.
    const s = new FakeStorage()
    expect(claimStep(1, 'batch:x', A, NOW, s)).toBe('claimed')
    // ⚠ recordSubmission, not hydrateSubmission — hydrate READS (3 args: chain,
    // key, store) and my first cut passed the id AS the store, so nothing was
    // marked submitted and the mutant stayed equivalent. The sweep was right and
    // my test was wrong; a survivor is a claim about the TEST as much as the code.
    recordSubmission({ chainId: 1, stepKey: 'batch:x', rung: 0, submissionId: '0xdeadbeef', signer: A, atMs: NOW }, s)
    expect(claimStep(8453, 'batch:x', A, NOW + 1_000, s)).toBe('claimed')
    expect(renewClaim(8453, 'batch:x', A, NOW + 6_000, s), 'the live claim must renew').toBe(true)
    const base = readSubmissions(s).rows.find((r) => r.chainId === 8453)!
    expect(base.atMs).toBe(NOW + 6_000)
  })

  it('renewing touches ONLY the row whose whole key matches', () => {
    const s = new FakeStorage()
    claimStep(1, 'batch:x', A, NOW, s)
    claimStep(8453, 'batch:x', A, NOW, s)
    renewClaim(8453, 'batch:x', A, NOW + 5_000, s)
    const rows = readSubmissions(s).rows
    const base = rows.find((r) => r.chainId === 8453)!
    const eth = rows.find((r) => r.chainId === 1)!
    expect(base.atMs, 'the matching row was renewed').toBe(NOW + 5_000)
    expect(eth.atMs, "the neighbour sharing only the step NAME must not be touched").toBe(NOW)
  })
})

describe('a claim stamp is RANGE-checked, not merely typed (self-audit, 2026-08-07)', () => {
  // ⚠ THE ASYMMETRY WAS THE TELL: `rung` was range-checked and `atMs` was not,
  // while atMs is the field that decides whether a claim is still LIVE. Same
  // shape as pool-safety's validated tickSpacing beside an unread feeBps, which
  // an independent reviewer had found earlier the same day.
  const KEY = 'spectrum:live-submission:v1'
  const A = '0x00000000000000000000000000000000000000aa' as const
  const B = '0x00000000000000000000000000000000000000bb' as const
  const NOW = 1_800_000_000_000
  const liveClaim = (atMs: unknown) =>
    JSON.stringify([{ chainId: 1, stepKey: 'batch:1:x', rung: 0, submissionId: null, signer: A, atMs }])

  it('a past or zero stamp CANNOT make another tab steal a live claim', () => {
    // MEASURED before the fix: both returned 'claimed' — two tabs, one batch.
    for (const atMs of [-1, 0, 1, 1_500_000_000_000]) {
      const s = new FakeStorage()
      s.setItem(KEY, liveClaim(atMs))
      expect(claimStep(1, 'batch:1:x', B, NOW + 1_000, s), `atMs=${atMs}`).toBe('store-unreadable')
    }
  })

  it('a far-future stamp is rejected too — it would wedge the step forever', () => {
    const s = new FakeStorage()
    s.setItem(KEY, liveClaim(9_999_999_999_999))
    expect(claimStep(1, 'batch:1:x', B, NOW, s)).toBe('store-unreadable')
  })

  it('an honest stamp still holds the claim against another tab', () => {
    const s = new FakeStorage()
    s.setItem(KEY, liveClaim(NOW))
    expect(claimStep(1, 'batch:1:x', B, NOW + 1_000, s)).toBe('held-by-other-tab')
  })

  it('and the holder can still renew its own honest claim', () => {
    const s = new FakeStorage()
    expect(claimStep(1, 'batch:1:y', A, NOW, s)).toBe('claimed')
    expect(renewClaim(1, 'batch:1:y', A, NOW + 5_000, s)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE STORE'S UNREADABLE VERDICTS (mutation run 6: submission-store at 86.44%
// with 16 mutants under NO coverage — the corruption and over-full paths among
// them).
//
// This store is the double-buy defence. `claimStep` is the last gate before a
// wallet is touched, and its refusal law is that UNKNOWN IS NOT ABSENT — an
// unreadable row might be a live submission of this very step, so claiming over
// it is the double-buy. Every branch that produces `store-unreadable` therefore
// has to be shown to actually produce it: a refusal that never fires in a test
// is indistinguishable from one that was deleted.
//
// The over-full branch was checked against the equivalent-mutant rule before
// being written: `readBook` sets `corrupt` only on parse and shape failures and
// does NOT fold the row cap in — that happens in a different function — so a
// well-formed book of 65 rows reaches the cap check with `corrupt` false. The
// branch is genuinely reachable rather than shadowed by the line above it.
// ─────────────────────────────────────────────────────────────────────────────

describe('claimStep — every route to store-unreadable actually fires', () => {
  const KEY = 'spectrum:live-submission:v1'
  const STEP = 'step-1'

  it('an OVER-FULL but well-formed book is evidence of corruption, not merely "a lot of rows"', () => {
    // 65 well-formed rows: nothing here fails to parse, so `corrupt` is false
    // and only the hard cap can catch it. A store this size means something
    // upstream is wrong, and claiming over it could be claiming over a live
    // submission of this step.
    const rows = Array.from({ length: 65 }, (_, i) => ({
      chainId: 8453,
      stepKey: `filler-${i}`,
      rung: 0,
      signer: A,
      atMs: 1_700_000_000_000,
      submissionId: null,
    }))
    store.setItem(KEY, JSON.stringify(rows))
    expect(claimStep(8453, STEP, A, 1_700_000_000_000, store)).toBe('store-unreadable')
  })

  it('a book at exactly the cap still claims — the boundary is >, not >=', () => {
    // the half that keeps this a corruption signal rather than a size limit: if
    // the cap itself refused, the store would brick one row before its own
    // documented maximum and nothing else here would say so
    const rows = Array.from({ length: 64 }, (_, i) => ({
      chainId: 8453,
      stepKey: `filler-${i}`,
      rung: 0,
      signer: A,
      atMs: 1_700_000_000_000,
      submissionId: null,
    }))
    store.setItem(KEY, JSON.stringify(rows))
    expect(claimStep(8453, STEP, A, 1_700_000_000_000, store)).not.toBe('store-unreadable')
  })

  it('UNPARSEABLE storage refuses — a claim is never granted over bytes we cannot read', () => {
    store.setItem(KEY, '{not json at all')
    expect(claimStep(8453, STEP, A, 1_700_000_000_000, store)).toBe('store-unreadable')
  })

  it('WELL-FORMED JSON OF THE WRONG SHAPE refuses too — parsing is not understanding', () => {
    // each of these parses cleanly and is not a row array; "it parsed" is not
    // the same claim as "we know what is in the store"
    for (const shape of ['{"rows":[]}', '"a string"', '42', 'null', 'true']) {
      store.setItem(KEY, shape)
      expect(claimStep(8453, STEP, A, 1_700_000_000_000, store), `shape ${shape}`).toBe('store-unreadable')
    }
  })

  it('an EMPTY store is not unreadable — absent really is absent, and a first claim must work', () => {
    // the boundary that keeps the refusals meaningful: if "nothing stored" read
    // as "unreadable", no first submission could ever be claimed and the whole
    // store would fail closed into uselessness
    expect(claimStep(8453, STEP, A, 1_700_000_000_000, store)).not.toBe('store-unreadable')
  })

  it('a NULL store CLAIMS — and now says so, which is what settled the argument', () => {
    // storage() returns null where localStorage throws: privacy modes, blocked
    // third-party contexts, a Storage quota that denies access outright. Every
    // OTHER route to this gate refuses on the principle that unknown is not
    // absent — but with no store at all the claim is GRANTED.
    //
    // ✅ RULED BY THE OWNER, 2026-08-08. UIGuy pinned this as BEHAVIOUR rather than
    // asserting it correct, and raised the product half rather than absorbing
    // it — which is the only reason it got decided instead of drifting. Both of
    // the arguments recorded here were sound, and neither won: the verdict was
    // OVERLOADED. 'claimed' asserted both "you may proceed" and "nobody else
    // holds this", and with no store the first is true while the second is
    // unknowable, so flipping it would only swap which half lies. The run
    // proceeds and the surface warns before a wallet is asked.
    //
    // The refusal argument still holds for a DIFFERENT case, and the two must
    // not be conflated: a store that EXISTS and silently drops the write is the
    // adversarial pass's CRITICAL, and it refuses. Asserted separately below.
    expect(claimStep(8453, STEP, A, 1_700_000_000_000, null)).toBe('claimed-unprotected')
  })
})

describe('CRITICAL (independent pass 2026-08-08): the heartbeat cannot poison its own claim', () => {
  const A2 = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const

  it('renewClaim REFUSES an implausible stamp instead of writing it, and leaves the last good one', () => {
    // The heartbeat was the one writer with no writability check. nowMs = 0 is
    // not hypothetical: it is what a stopped or unset clock hands you, and it
    // wrote straight through, after which the row could not be read back at all.
    recordSubmission(sub({ stepKey: 'beat', submissionId: null, signer: A2, atMs: PLAUSIBLE_MS }), store)
    expect(renewClaim(8453, 'beat', A2, 0, store)).toBe(false)
    // the CLAIM SURVIVES — refusing must not cost the user their live claim
    const after = readSubmissions(store).rows.find((r) => r.stepKey === 'beat')
    expect(after?.atMs).toBe(PLAUSIBLE_MS)
    expect(readSubmissions(store).dropped).toBe(0)
  })

  it('and it still renews a PLAUSIBLE stamp — the guard refuses garbage, not the heartbeat', () => {
    recordSubmission(sub({ stepKey: 'beat2', submissionId: null, signer: A2, atMs: PLAUSIBLE_MS }), store)
    expect(renewClaim(8453, 'beat2', A2, PLAUSIBLE_MS + 15_000, store)).toBe(true)
    expect(readSubmissions(store).rows.find((r) => r.stepKey === 'beat2')?.atMs).toBe(PLAUSIBLE_MS + 15_000)
  })

  it('a refused renewal never makes the claim unreadable — hydration still sees it', () => {
    // The measured consequence chain: a poisoned row fails parseRow, so
    // hydrateSubmission read idle and the claim vanished with no in-product exit.
    recordSubmission(sub({ stepKey: 'beat3', submissionId: null, signer: A2, atMs: PLAUSIBLE_MS }), store)
    renewClaim(8453, 'beat3', A2, Number.NaN, store)
    renewClaim(8453, 'beat3', A2, -1, store)
    expect(readSubmissions(store).rows.some((r) => r.stepKey === 'beat3')).toBe(true)
  })
})

describe('CRITICAL 2 (independent pass 2026-08-08): the recovery survives the clock that caused it', () => {
  const A3 = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const

  it('an out-of-window clock still marks the claim AMBIGUOUS, using the stamp already on the row', () => {
    // The shape: recordSubmission throws on an implausible atMs, its catch runs,
    // and markClaimAmbiguous validated the SAME atMs and threw again — deleting
    // the recovery. The flag is the safety property; the timestamp is not, so a
    // bad clock falls back to the stamp this module already validated.
    claimStep(8453, 'live', A3, PLAUSIBLE_MS, store)
    expect(markClaimAmbiguous(8453, 'live', A3, 0, store, 2)).toBe(true)
    const row = readSubmissions(store).rows.find((r) => r.stepKey === 'live')
    expect(row?.ambiguous).toBe(true)
    expect(row?.atMs).toBe(PLAUSIBLE_MS) // the good stamp survived, not the 0
  })

  it('AND THE MARK IS WHAT STOPS THE RETRY: the sweep may never drop it', () => {
    // This is the consequence the CRITICAL actually had. An unmarked claim is
    // parseable, so law 12 accepts it, the sweep drops it at +90s, and the next
    // run re-submits and reports done — with no attacker anywhere.
    claimStep(8453, 'live', A3, PLAUSIBLE_MS, store)
    markClaimAmbiguous(8453, 'live', A3, Number.NaN, store, 2)
    sweepExpiredClaims(PLAUSIBLE_MS + CLAIM_TTL_MS * 10, store)
    expect(readSubmissions(store).rows.some((r) => r.stepKey === 'live')).toBe(true)
  })

  it('with NO existing row and an unusable clock it refuses honestly — never a poisoned row', () => {
    // The remaining case has no validated stamp to fall back on. Refusing is
    // right; writing a row every read would drop is not. The caller says so in
    // words (execution-runner tells the user we could not record it at all).
    expect(markClaimAmbiguous(8453, 'nothing-here', A3, -1, store)).toBe(false)
    expect(readSubmissions(store).dropped).toBe(0)
  })
})

describe('CRITICAL (adversarial pass 2026-08-08): a write that did not land may never report success', () => {
  const A4 = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const

  /** A store with a few bytes of headroom: it ACCEPTS setItem and keeps less
   *  than it was given. This is the shape the whole finding turns on — not a
   *  store that refuses, but one that lies about having stored. */
  class TinyStorage extends FakeStorage {
    constructor(private cap: number) {
      super()
    }
    setItem(k: string, v: string) {
      if (v.length > this.cap) return // accepted, silently dropped
      super.setItem(k, v)
    }
  }

  it('claimStep REFUSES when the claim did not persist — it used to say claimed having written nothing', () => {
    // Measured: probes passed, claimStep returned 'claimed', the store held
    // nothing, the run reported done, and after a reload run 2 submitted the
    // same money. Every guard reported healthy throughout.
    const tiny = new TinyStorage(40)
    expect(claimStep(8453, 'k', A4, PLAUSIBLE_MS, tiny)).toBe('store-unreadable')
    expect(readSubmissions(tiny).rows).toHaveLength(0)
  })

  it('recordSubmission is LOUD when the record did not persist', () => {
    const tiny = new TinyStorage(40)
    expect(() => recordSubmission(sub({ signer: A4 }), tiny)).toThrow(/did not persist/)
  })

  it('renewClaim reports the WRITE, not the intent — a lying heartbeat let another tab take the claim', () => {
    const tiny = new TinyStorage(4000)
    expect(claimStep(8453, 'beat', A4, PLAUSIBLE_MS, tiny)).toBe('claimed')
    tiny.setItem = () => {} // the store starts silently dropping mid-run
    expect(renewClaim(8453, 'beat', A4, PLAUSIBLE_MS + 15_000, tiny)).toBe(false)
  })

  it('the probe is the SIZE of what it certifies — one byte vouched for a 120-byte row', () => {
    // A store that fits one byte and not a row must NOT certify the book.
    expect(probeWritable(new TinyStorage(1))).toBe(false)
    expect(probeWritable(new TinyStorage(4000))).toBe(true)
  })
})

describe('CRITICAL (adversarial pass 2026-08-08): a release may only release what the releaser holds', () => {
  const A5 = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const
  const B5 = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

  it("tab A's late rejection does not delete tab B's IN-FLIGHT submission record", () => {
    // The measured sequence, one wallet, two tabs: A claims and its prompt
    // opens, the tab suspends so the heartbeat stops; at +91s B sweeps A's
    // expired claim, claims and submits — B's money is in flight; at +96s A
    // wakes and the human hits Reject on the prompt that was open all along.
    // The rejection is definitive, so A cleared the row — leaving B's live
    // transaction with no record at all, and any reload re-submitting it.
    recordSubmission({ chainId: 8453, stepKey: 'step', rung: 0, submissionId: 'tx-B', signer: B5, atMs: PLAUSIBLE_MS }, store)
    clearSubmission(8453, 'step', store, A5) // A's late reject
    const still = readSubmissions(store).rows.find((r) => r.stepKey === 'step')
    expect(still, "B's in-flight record must survive A's rejection").toBeDefined()
    expect(still?.submissionId).toBe('tx-B')
  })

  it('the owner check reads the RIGHT row — a neighbour on the same chain must not veto the clear', () => {
    // `chainId === x && stepKey === y`, and the sweep caught the conjunction
    // unpinned in my own new lookup. Turned to `||`, the find matches any row
    // sharing EITHER field, so an unrelated step on the same chain owned by
    // another wallet would have its signer checked instead — and a legitimate
    // release would be silently refused, stranding the record it meant to free.
    recordSubmission({ chainId: 8453, stepKey: 'theirs', rung: 0, submissionId: 'tx-B', signer: B5, atMs: PLAUSIBLE_MS }, store)
    recordSubmission({ chainId: 8453, stepKey: 'ours', rung: 0, submissionId: 'tx-A', signer: A5, atMs: PLAUSIBLE_MS }, store)
    clearSubmission(8453, 'ours', store, A5)
    expect(readSubmissions(store).rows.find((r) => r.stepKey === 'ours')).toBeUndefined()
    expect(readSubmissions(store).rows.find((r) => r.stepKey === 'theirs')).toBeDefined()
  })

  it('but a signer still clears its OWN resolved submission — the fix must not strand real records', () => {
    recordSubmission({ chainId: 8453, stepKey: 'mine', rung: 0, submissionId: 'tx-A', signer: A5, atMs: PLAUSIBLE_MS }, store)
    clearSubmission(8453, 'mine', store, A5)
    expect(readSubmissions(store).rows.find((r) => r.stepKey === 'mine')).toBeUndefined()
  })
})

describe('three HIGHs of the same family (adversarial pass 2026-08-08)', () => {
  const A6 = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const
  const B6 = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

  it('recordSubmission REFUSES to overwrite another wallet’s live submission', () => {
    // Measured: after a claim is legitimately taken over, the original tab's
    // own submit landed and replaced the taker's record — two transactions
    // broadcast, one record kept, and the loser's money tracked by nothing.
    recordSubmission({ chainId: 8453, stepKey: 's', rung: 0, submissionId: 'tx-B', signer: B6, atMs: PLAUSIBLE_MS }, store)
    expect(() =>
      recordSubmission({ chainId: 8453, stepKey: 's', rung: 0, submissionId: 'tx-A', signer: A6, atMs: PLAUSIBLE_MS }, store),
    ).toThrow(/another wallet/)
    expect(readSubmissions(store).rows.find((r) => r.stepKey === 's')?.submissionId).toBe('tx-B')
  })

  it('but taking over an EXPIRED CLAIM still works — a bare claim has no money behind it', () => {
    // The path this must not break: no id means nothing was sent, so the claim
    // law explicitly permits the takeover.
    claimStep(8453, 'c', B6, PLAUSIBLE_MS, store)
    expect(() =>
      recordSubmission({ chainId: 8453, stepKey: 'c', rung: 0, submissionId: 'tx-A', signer: A6, atMs: PLAUSIBLE_MS }, store),
    ).not.toThrow()
    expect(readSubmissions(store).rows.find((r) => r.stepKey === 'c')?.signer).toBe(A6)
  })
})

describe("a null store CLAIMS, and says so (the owner's ruling 2026-08-08)", () => {
  const A7 = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const

  it('no storage at all is claimed-unprotected — permitted, and distinguishable', () => {
    // The verdict used to be a bare 'claimed', which asserted two things at
    // once: you may proceed, AND nobody else holds this. With no store the
    // first is true and the second is unknowable, so the value was overloaded
    // and flipping it would only swap which half lies. The run proceeds and the
    // surface warns — half-knowable means say the half you know.
    expect(claimStep(8453, 'k', A7, PLAUSIBLE_MS, null)).toBe('claimed-unprotected')
  })

  it('a WORKING store still answers plain claimed — the new verdict is for the missing case only', () => {
    expect(claimStep(8453, 'k', A7, PLAUSIBLE_MS, store)).toBe('claimed')
  })

  it('and a store that EXISTS but dropped the write still REFUSES — the two are different failures', () => {
    // The adversarial pass's CRITICAL: a store with a few bytes of headroom
    // accepted setItem and kept nothing, so ownership was claimed over nothing.
    // That is not the privacy-mode case and must not inherit its permission.
    const tiny = new FakeStorage()
    tiny.setItem = () => {}
    expect(claimStep(8453, 'k', A7, PLAUSIBLE_MS, tiny)).toBe('store-unreadable')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A12 SURVIVOR PINS (sweep, 2026-08-13). Two mutants survived every existing
// case in this file by producing the same observable outcome on every fixture
// the suite happened to hold — the boundary inputs below are the ones that
// tell the mutant and the law apart.
// ─────────────────────────────────────────────────────────────────────────────
describe('A12 pins — the row lookup is a PAIR key, and stamps must read back', () => {
  const t0 = 1_700_000_000_000

  it('marks step B ambiguous while step A holds a live submission on the SAME chain (kills :736 && → ||)', () => {
    // the OR-mutant finds A's row by bare chainId, sees its submissionId, and
    // walks away without writing B's mark — B's claim then expires into a
    // takeover-and-retry, the exact double-buy the mark exists to stop
    recordSubmission(sub({ stepKey: 'sA', submissionId: 'tx-a' }), store)
    expect(markClaimAmbiguous(8453, 'sB', A, t0, store)).toBe(true)
    expect(claimStep(8453, 'sB', A, t0 + CLAIM_TTL_MS * 10, store)).toBe('held-ambiguous')
    // and A's live submission was not touched
    expect(hydrateSubmission(8453, 'sA', store)).toMatchObject({ phase: 'submitted', submissionId: 'tx-a' })
  })

  it('marks the SAME step key ambiguous on another chain (the other half of the pair)', () => {
    recordSubmission(sub({ chainId: 1, stepKey: 'sK', submissionId: 'tx-1' }), store)
    expect(markClaimAmbiguous(8453, 'sK', A, t0, store)).toBe(true)
    expect(claimStep(8453, 'sK', A, t0 + CLAIM_TTL_MS * 10, store)).toBe('held-ambiguous')
    expect(hydrateSubmission(1, 'sK', store)).toMatchObject({ phase: 'submitted', submissionId: 'tx-1' })
  })

  it('a completion stamp WRITTEN is a completion stamp READ (kills readStamps :863 drop !)', () => {
    // the inverted-guard mutant answers {} for every REAL store, which erases
    // law 14/14b at read time: every window check sees a clean slate and the
    // re-arm double-buy comes back. The round-trip is the discriminating case.
    recordStepCompletion('step-x', t0, store)
    expect(recentStepCompletionAt('step-x', t0 + 1_000, store)).toBe(t0)
    recordCycleCompletion('digest-y', t0, store)
    expect(recentCycleCompletionAt('digest-y', t0 + 1_000, store)).toBe(t0)
    // and past the ruled window both answer null — recent means recent
    expect(recentStepCompletionAt('step-x', t0 + RECENT_COMPLETION_WINDOW_MS + 1, store)).toBeNull()
    expect(recentCycleCompletionAt('digest-y', t0 + RECENT_COMPLETION_WINDOW_MS + 1, store)).toBeNull()
  })

  it('the window boundary is INCLUSIVE — a completion exactly at the window still guards (kills :903 <= → <)', () => {
    recordStepCompletion('edge-w', t0, store)
    expect(recentStepCompletionAt('edge-w', t0 + RECENT_COMPLETION_WINDOW_MS, store)).toBe(t0)
  })

  it('a completion stamped THIS millisecond guards this millisecond (kills :902 < → <=)', () => {
    // the same-ms re-arm is the tightest race the guard exists for: nowMs ===
    // at must answer the stamp, not "a rewound clock proves nothing"
    recordStepCompletion('edge-now', t0, store)
    expect(recentStepCompletionAt('edge-now', t0, store)).toBe(t0)
  })

  it('the plausibility ceiling is INCLUSIVE — a stamp exactly at MAX records (kills :886 > → >=)', () => {
    // 4102444800000 = 2100-01-01, the ceiling itself: plausible by definition
    const MAX_PLAUSIBLE_MS = 4_102_444_800_000
    recordStepCompletion('edge-max', MAX_PLAUSIBLE_MS, store)
    expect(recentStepCompletionAt('edge-max', MAX_PLAUSIBLE_MS, store)).toBe(MAX_PLAUSIBLE_MS)
    // and one past it never records — the clamp is real in both directions
    recordStepCompletion('edge-max2', MAX_PLAUSIBLE_MS + 1, store)
    expect(recentStepCompletionAt('edge-max2', MAX_PLAUSIBLE_MS + 1, store)).toBeNull()
  })
})

describe('the flip-eve survivor round (2026-08-16) — the MIN-side boundary siblings of the MAX pins', () => {
  it('a step key EXACTLY at the cap still records — the bound is >, not >= (kills recordStamp :885 > → >=)', () => {
    const t0 = 1_700_000_000_000
    const key = 'k'.repeat(80) // MAX_STEP_KEY_LEN itself — legal by the module's own read filter
    recordStepCompletion(key, t0, store)
    expect(recentStepCompletionAt(key, t0, store)).toBe(t0)
  })

  it('a stamp EXACTLY at the plausibility floor records — 2020-01-01 itself is plausible (kills recordStamp :886 < → <=)', () => {
    const MIN_PLAUSIBLE_MS = 1_577_836_800_000 // 2020-01-01, the floor itself
    recordStepCompletion('edge-min', MIN_PLAUSIBLE_MS, store)
    expect(recentStepCompletionAt('edge-min', MIN_PLAUSIBLE_MS, store)).toBe(MIN_PLAUSIBLE_MS)
  })
})
