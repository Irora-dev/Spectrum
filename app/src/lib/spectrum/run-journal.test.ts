import { beforeEach, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { AssembleZeroExBatchBuyInput } from './portfolio-batcher'
import type { PlanLegInput } from './plan-legs'
import {
  beginRun,
  createMemoryJournalStore,
  evictionDisclosure,
  exportRun,
  importRun,
  journalLocalStorage,
  quarantineCorruptJournal,
  readJournal,
  readJournalQuarantine,
  readRun,
  recordStage,
  RUN_ENTRY_LIMIT,
  RUN_JOURNAL_FORMAT,
  RUN_JOURNAL_LIMIT,
  sealRun,
  type JournalExportResult,
  type JournalStagePayload,
  type JournalStore,
  type JournalWriteResult,
  type RunPlanFacts,
} from './run-journal'

// THE RUN JOURNAL'S OWN CONTRACT, asserted: append-only (sealed = refused in a
// sentence), evictions counted out loud, bigints round-tripping losslessly,
// and a recorder that refuses in words rather than ever throwing on the run
// it exists to record. Every test asserts REAL values — a suite that only
// checks "doesn't throw" would certify a journal that records nothing.

/** The persistence contract: this exact key is where users' journals live.
 *  Renaming it orphans every stored journal, so the tests pin it. */
const STORE_KEY = 'spectrum:run-journal:v1'

const A = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const
const addr = (tail: string): Address => `0x${tail.padStart(40, '0')}`

const T0 = 1_755_400_000_000
const STEP = 1_000

const leg = (): PlanLegInput => ({
  symbol: 'PRISM',
  asset: addr('aa'),
  decimals: 18,
  weightPct: 100,
  priceUsd: 0.5,
  priceAgeMs: 5_000,
  liquidityUsd: 250_000,
  buyTokenTaxBps: 0,
  route: 'basket',
})

/** The assembler's REAL input type — the journal must swallow it whole
 *  (bigints and all), because it is the replay basis. */
const assembly = (): AssembleZeroExBatchBuyInput => ({
  chainId: 8453,
  targets: [leg()],
  grossUsdCents: 100_000,
  fundingTotalRaw: 1_000_000_000n,
  fundingAsset: addr('a1'),
  account: A,
  batcher: addr('b2'),
  chainNowSec: 1_755_400_000,
  deadlineSec: 1_755_400_900,
  feeBps: 100,
  feeRecipient: addr('fe'),
  generation: 2,
  gasPriceWei: 1_500_000_000n,
  nativeUsd: 3_200,
  hopReserveUsd: 5_000_000,
  burn: { asset: addr('bb') },
})

const facts = (): RunPlanFacts => ({
  account: A,
  assembly: [assembly()],
  detail: { engine: 'portfolio', planName: 'first gen-2 live batch' },
})

const composedPayload = (): JournalStagePayload['composed'] => ({
  chainId: 8453,
  composed: {
    generation: 2,
    args: [
      [{ buyToken: addr('aa'), sellAmount: 495_000_000n, minBuyAmount: 987_654_321_000_000_000n, swapData: '0xdeadbeef01', optional: false }],
      addr('a1'),
      1_000_000_000n,
      { recipient: A, deadline: 1_755_400_900n, feeBps: 100, burnSwapData: '0x' },
    ],
  },
  calldata: '0x2c84261e00aabb',
  // the motivating incident's one-read answer: the empty burn route AND the
  // assembler's own divert sentence, side by side in the same entry
  refusals: [{ symbol: 'BURN', reason: 'the burn route could not be quoted, so this run’s burn cut will divert to the fallback sink' }],
})

const submittedPayload = (): JournalStagePayload['submitted'] => ({
  chainId: 8453,
  stepKey: 'batch:8453',
  rung: 0,
  submissionId: 'calls:8453:0xabc123',
  signer: A,
  atMs: T0 + 2 * STEP,
})

const receiptPayload = (): JournalStagePayload['receipt'] => ({
  chainId: 8453,
  submissionId: 'calls:8453:0xabc123',
  transactionHash: '0x7d35360000000000000000000000000000000000000000000000000000000abc',
  verdict: { kind: 'success' },
  portfolioResult: { bought: [987_654_321_000_000_123n], refunded: 5_000_000n },
  detail: { burnExecuted: false, feeSink: 'fallback' },
})

const verdictPayload = (): JournalStagePayload['verdict'] => ({
  conclusion: 'the whole fee diverted to the fallback sink — burnSwapData was empty after a transient quote failure',
  classification: 'burn-diverted',
})

/** An expected refusal that came back ok is a guard that did not fire —
 *  fail loudly rather than reading `reason` off a success. */
const refusal = (r: JournalWriteResult | JournalExportResult): string => {
  if (r.ok) throw new Error('expected a refusal and got ok — the guard under test did not fire')
  return r.reason
}

let store: JournalStore
beforeEach(() => {
  store = createMemoryJournalStore()
})

/** begin → all four stages → seal, at deterministic stamps. */
function writeWholeRun(runId: string, s: JournalStore): void {
  expect(beginRun(runId, facts(), T0, s)).toEqual({ ok: true })
  expect(recordStage(runId, 'composed', composedPayload(), T0 + STEP, s)).toEqual({ ok: true })
  expect(recordStage(runId, 'submitted', submittedPayload(), T0 + 2 * STEP, s)).toEqual({ ok: true })
  expect(recordStage(runId, 'receipt', receiptPayload(), T0 + 3 * STEP, s)).toEqual({ ok: true })
  expect(recordStage(runId, 'verdict', verdictPayload(), T0 + 4 * STEP, s)).toEqual({ ok: true })
  expect(sealRun(runId, T0 + 5 * STEP, s)).toEqual({ ok: true })
}

describe('the run journal — one read answers the incident', () => {
  it('a full lifecycle survives the store: plan facts, all four stages, seal — bigints come back AS bigints', () => {
    writeWholeRun('run-1', store)
    const run = readRun('run-1', store)
    expect(run).not.toBeNull()
    expect(run!.runId).toBe('run-1')
    expect(run!.beganAtMs).toBe(T0)
    expect(run!.sealedAtMs).toBe(T0 + 5 * STEP)
    expect(run!.entries.map((e) => e.stage)).toEqual(['composed', 'submitted', 'receipt', 'verdict'])
    // the replay basis persisted whole — the assembler's own bigints included
    expect(run!.planFacts.account).toBe(A)
    expect(run!.planFacts.assembly?.[0].fundingTotalRaw).toBe(1_000_000_000n)
    expect(run!.planFacts.assembly?.[0].gasPriceWei).toBe(1_500_000_000n)
    // the incident's one-read answer: exact composed bytes + the divert refusal
    const composed = run!.entries[0]
    if (composed.stage !== 'composed') throw new Error('expected the composed entry first')
    expect(composed.payload.composed.args[2]).toBe(1_000_000_000n)
    expect(typeof composed.payload.composed.args[2]).toBe('bigint')
    expect(composed.payload.composed.args[3].burnSwapData).toBe('0x')
    expect(composed.payload.refusals?.[0].symbol).toBe('BURN')
    expect(composed.payload.calldata).toBe('0x2c84261e00aabb')
    const receipt = run!.entries[2]
    if (receipt.stage !== 'receipt') throw new Error('expected the receipt entry third')
    expect(receipt.payload.portfolioResult?.bought[0]).toBe(987_654_321_000_000_123n)
    expect(receipt.payload.portfolioResult?.refunded).toBe(5_000_000n)
  })

  it('the journal captures VALUES, not references — mutating the payload after recording changes nothing stored', () => {
    expect(beginRun('run-1', facts(), T0, store)).toEqual({ ok: true })
    const p = composedPayload()
    expect(recordStage('run-1', 'composed', p, T0 + STEP, store)).toEqual({ ok: true })
    p.calldata = '0x00tampered'
    const entry = readRun('run-1', store)!.entries[0]
    if (entry.stage !== 'composed') throw new Error('expected the composed entry')
    expect(entry.payload.calldata).toBe('0x2c84261e00aabb')
  })

  it('a stage for a run never begun has no home — refused in the sentence, and nothing appears', () => {
    const r = recordStage('ghost', 'verdict', verdictPayload(), T0, store)
    expect(refusal(r)).toContain("run 'ghost' was never begun here")
    expect(readJournal(store).runs).toHaveLength(0)
  })
})

describe('append-only: sealed is immutable', () => {
  it('a write to a sealed run is REFUSED on the sentence, and the record is bit-for-bit unchanged', () => {
    writeWholeRun('run-1', store)
    const before = readRun('run-1', store)!
    const r = recordStage('run-1', 'verdict', verdictPayload(), T0 + 9 * STEP, store)
    expect(refusal(r)).toBe(
      "run 'run-1' is sealed — a sealed record is immutable, so this verdict write was refused rather than rewriting history",
    )
    expect(readRun('run-1', store)).toEqual(before)
  })

  it('sealing twice refuses — a seal stamp is history and does not restamp', () => {
    writeWholeRun('run-1', store)
    const r = sealRun('run-1', T0 + 99 * STEP, store)
    expect(refusal(r)).toContain('already sealed')
    expect(readRun('run-1', store)!.sealedAtMs).toBe(T0 + 5 * STEP)
  })

  it('beginning the same runId twice refuses — a journal never rewrites what it witnessed', () => {
    expect(beginRun('run-1', facts(), T0, store)).toEqual({ ok: true })
    const r = beginRun('run-1', facts(), T0 + STEP, store)
    expect(refusal(r)).toContain("run 'run-1' is already in this journal")
    expect(readRun('run-1', store)!.beganAtMs).toBe(T0)
  })

  it('a run past the entry ceiling refuses the runaway recorder — counted in the sentence, nothing appended', () => {
    expect(beginRun('run-1', facts(), T0, store)).toEqual({ ok: true })
    for (let i = 0; i < RUN_ENTRY_LIMIT; i++)
      expect(recordStage('run-1', 'verdict', verdictPayload(), T0 + i, store)).toEqual({ ok: true })
    const r = recordStage('run-1', 'verdict', verdictPayload(), T0 + RUN_ENTRY_LIMIT, store)
    expect(refusal(r)).toContain(`already holds ${RUN_ENTRY_LIMIT} entries`)
    expect(readRun('run-1', store)!.entries).toHaveLength(RUN_ENTRY_LIMIT)
  })
})

describe('the size bound discloses itself — absence never reads as cleanliness', () => {
  it('filling past the cap evicts the OLDEST runs and the journal says so, counted', () => {
    const total = RUN_JOURNAL_LIMIT + 3
    for (let i = 0; i < total; i++) expect(beginRun(`run-${i}`, facts(), T0 + i, store)).toEqual({ ok: true })
    const j = readJournal(store)
    expect(j.runs).toHaveLength(RUN_JOURNAL_LIMIT)
    expect(j.runs[0].runId).toBe('run-3') // 0, 1, 2 evicted — oldest first
    expect(j.runs[j.runs.length - 1].runId).toBe(`run-${total - 1}`)
    expect(j.evicted.count).toBe(3)
    expect(j.evicted.lastAtMs).toBe(T0 + total - 1)
    expect(j.disclosure).toBe(
      `3 earlier runs were evicted to keep this journal inside its ${RUN_JOURNAL_LIMIT}-run bound — a run missing here is a counted eviction, never a clean history`,
    )
  })

  it('an unevicted journal carries NO disclosure — the line exists only when something is missing', () => {
    expect(beginRun('run-1', facts(), T0, store)).toEqual({ ok: true })
    expect(readJournal(store).disclosure).toBeNull()
    expect(evictionDisclosure({ count: 0 })).toBeNull()
    expect(evictionDisclosure({ count: 1 })).toContain('1 earlier run was evicted')
  })
})

describe('export / import — the paste-to-whoever-is-diagnosing form, lossless', () => {
  it('an exported run is strict JSON, tagged for bigints, and re-imports EXACTLY into a fresh store', () => {
    writeWholeRun('run-1', store)
    const exp = exportRun('run-1', store)
    if (!exp.ok) throw new Error(exp.reason)
    // strict JSON with the pinned format tag — a plain JSON.parse must read it
    const wire = JSON.parse(exp.json) as { format?: string }
    expect(wire.format).toBe(RUN_JOURNAL_FORMAT)
    // the wire form of a bigint is pinned — a silent encoding change would
    // orphan every export ever handed to a diagnosis. JSON.stringify escapes
    // the U+0001 sentinel, so the wire carries the six-character escape form.
    expect(exp.json).toContain('"\\u0001rj:b1000000000"')

    const fresh = createMemoryJournalStore()
    expect(importRun(exp.json, T0 + 10 * STEP, fresh)).toEqual({ ok: true })
    // the round trip is LOSSLESS: the re-read equals the original re-read,
    // bigint types included (toEqual distinguishes 5n from '5' and 5)
    expect(readRun('run-1', fresh)).toEqual(readRun('run-1', store))
    const receipt = readRun('run-1', fresh)!.entries[2]
    if (receipt.stage !== 'receipt') throw new Error('expected the receipt entry third')
    expect(receipt.payload.portfolioResult?.bought[0]).toBe(987_654_321_000_000_123n)
    expect(typeof receipt.payload.portfolioResult?.refunded).toBe('bigint')
    expect(readRun('run-1', fresh)!.sealedAtMs).toBe(T0 + 5 * STEP)
  })

  it('a GENUINE string that wears the bigint tag survives as the same string — the escape law', () => {
    expect(beginRun('run-1', facts(), T0, store)).toEqual({ ok: true })
    const hostile = { conclusion: 'ok', detail: { note: 'rj:b123', alsoRaw: 'rj:sneaky' } }
    expect(recordStage('run-1', 'verdict', hostile, T0 + STEP, store)).toEqual({ ok: true })
    const exp = exportRun('run-1', store)
    if (!exp.ok) throw new Error(exp.reason)
    const fresh = createMemoryJournalStore()
    expect(importRun(exp.json, T0 + 2 * STEP, fresh)).toEqual({ ok: true })
    const entry = readRun('run-1', fresh)!.entries[0]
    if (entry.stage !== 'verdict') throw new Error('expected the verdict entry')
    expect(entry.payload.detail).toEqual({ note: 'rj:b123', alsoRaw: 'rj:sneaky' })
    expect(typeof (entry.payload.detail as { note: unknown }).note).toBe('string')
  })

  it('importing a run this journal already holds refuses — history is not overwritten by a paste', () => {
    writeWholeRun('run-1', store)
    const exp = exportRun('run-1', store)
    if (!exp.ok) throw new Error(exp.reason)
    const r = importRun(exp.json, T0 + 10 * STEP, store)
    expect(refusal(r)).toContain("run 'run-1' is already in this journal")
  })

  it('garbage and foreign formats refuse in words, and exporting an absent run says so', () => {
    expect(refusal(importRun('not json {', T0, store))).toContain('not a run-journal export')
    expect(refusal(importRun(JSON.stringify({ format: 'someone-elses/v9', run: {} }), T0, store))).toContain(
      `not a '${RUN_JOURNAL_FORMAT}' export`,
    )
    expect(refusal(importRun(JSON.stringify({ format: RUN_JOURNAL_FORMAT, run: { nope: 1 } }), T0, store))).toContain(
      'does not carry a readable run',
    )
    expect(refusal(exportRun('ghost', store))).toContain("run 'ghost' is not in this journal")
  })
})

describe('the storage adapter contract', () => {
  it('the in-memory store honours JournalStore: set→get echoes, missing→null, remove→null, instances are isolated', () => {
    const a = createMemoryJournalStore()
    const b = createMemoryJournalStore()
    expect(a.getItem('k')).toBeNull()
    a.setItem('k', 'v1')
    expect(a.getItem('k')).toBe('v1')
    expect(b.getItem('k')).toBeNull() // isolation — no shared backing map
    a.removeItem('k')
    expect(a.getItem('k')).toBeNull()
  })

  it('a write the store swallowed is reported, never assumed — the read-back proof', () => {
    // accepts setItem and stores NOTHING (quota-zero shape): the journal must
    // refuse rather than report a record it never got
    const blackHole: JournalStore = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    expect(refusal(beginRun('run-1', facts(), T0, blackHole))).toBe(
      'the journal write did not persist — the store accepted nothing, so this run has no durable record of this moment',
    )
    // and a THROWING store refuses in the same words — never an escaped throw
    const denying: JournalStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {},
    }
    expect(refusal(beginRun('run-1', facts(), T0, denying))).toContain('did not persist')
  })

  it('a null store refuses writes in words and reads as an empty (not corrupt) journal', () => {
    expect(refusal(beginRun('run-1', facts(), T0, null))).toContain('no journal storage')
    const j = readJournal(null)
    expect(j.runs).toEqual([])
    expect(j.corrupt).toBe(false)
  })
})

describe('non-browser safety', () => {
  it('this suite runs where window does not exist, the import already succeeded, and the adapter answers null — writes refuse in words', () => {
    // the suite's environment IS the non-browser context under test (vitest.config: node)
    expect(typeof window).toBe('undefined')
    expect(journalLocalStorage()).toBeNull()
    // the DEFAULT store parameter — the guarded adapter — must refuse, not throw
    const r = beginRun('run-1', facts(), T0)
    expect(refusal(r)).toContain('no journal storage')
  })
})

describe('evidence is never erased', () => {
  it('a row this build cannot parse is COUNTED on read and carried VERBATIM through writes', () => {
    expect(beginRun('run-1', facts(), T0, store)).toEqual({ ok: true })
    const blob = JSON.parse(store.getItem(STORE_KEY)!) as { runs: unknown[] }
    blob.runs.unshift({ hostile: 'row', from: 'another build' })
    store.setItem(STORE_KEY, JSON.stringify(blob))
    const j = readJournal(store)
    expect(j.dropped).toBe(1)
    expect(j.runs.map((r) => r.runId)).toEqual(['run-1'])
    // a later write must carry the unknown row through, not scrub it
    expect(beginRun('run-2', facts(), T0 + STEP, store)).toEqual({ ok: true })
    expect(store.getItem(STORE_KEY)).toContain('"hostile":"row"')
    expect(readJournal(store).dropped).toBe(1)
  })

  it('a corrupt blob refuses writes until a HUMAN quarantines it — stash, never destroy', () => {
    store.setItem(STORE_KEY, 'not json {')
    const j = readJournal(store)
    expect(j.corrupt).toBe(true)
    expect(j.runs).toEqual([])
    expect(refusal(beginRun('run-1', facts(), T0, store))).toContain('quarantine')
    // the human's exit: the bytes MOVE, journaling resumes
    expect(quarantineCorruptJournal(store)).toBe(1)
    expect(readJournalQuarantine(store)).toBe('not json {')
    expect(quarantineCorruptJournal(store)).toBe(0) // nothing corrupt remains
    expect(beginRun('run-1', facts(), T0, store)).toEqual({ ok: true })
    expect(readRun('run-1', store)!.runId).toBe('run-1')
  })

  it('a garbage eviction counter reads as CORRUPT, never as zero — destroyed history must not read clean', () => {
    expect(beginRun('run-1', facts(), T0, store)).toEqual({ ok: true })
    const blob = JSON.parse(store.getItem(STORE_KEY)!) as { evicted: unknown }
    blob.evicted = { count: 'lots', lastAtMs: null }
    store.setItem(STORE_KEY, JSON.stringify(blob))
    expect(readJournal(store).corrupt).toBe(true)
  })
})

describe('hostile inputs refuse in words, never a throw', () => {
  it('an unreadable stamp records nothing — NaN would corrupt replay determinism', () => {
    expect(refusal(beginRun('run-1', facts(), Number.NaN, store))).toContain('not a readable moment')
    expect(refusal(recordStage('run-1', 'verdict', verdictPayload(), -5, store))).toContain('not a readable moment')
  })

  it('plan facts without a real signing account are not a record', () => {
    const junk = { account: '0xnope' } as unknown as RunPlanFacts
    expect(refusal(beginRun('run-1', junk, T0, store))).toContain('signing account')
    expect(readJournal(store).runs).toHaveLength(0)
  })

  it('a run id must be a short non-empty name', () => {
    expect(refusal(beginRun('', facts(), T0, store))).toContain('short non-empty name')
    expect(refusal(beginRun('x'.repeat(200), facts(), T0, store))).toContain('short non-empty name')
  })
})
