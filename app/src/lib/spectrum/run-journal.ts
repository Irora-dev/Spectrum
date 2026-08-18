import { isAddress, type Address } from 'viem'
import type { StorageLike } from './allocation'
import type { AssembleZeroExBatchBuyInput, AssembledZeroExBatchBuy, ComposedPortfolioBatchBuy } from './portfolio-batcher'
import type { MoneyCallsVerdict } from './runner-effects'
import type { LiveSubmission } from './submission-store'

// ─────────────────────────────────────────────────────────────────────────────
// THE RUN JOURNAL — an append-only, device-local record of each portfolio
// run's FULL inputs and outcomes, so a live incident is replayed offline from
// one read instead of reconstructed by receipt archaeology. The motivating
// incident (2026-08-15): a batch's burn route went out EMPTY after a transient
// quote failure and the whole fee diverted to the fallback sink — diagnosed a
// day LATER by decoding the on-chain receipt by hand. This journal answers it
// in one read: the composed stage carries the exact burnSwapData bytes and the
// assembler's own 'BURN' refusal sentence, side by side.
//
// WHAT THIS RECORDS THAT ITS NEIGHBOURS DO NOT (their own headers say what
// they are): exec-log keeps display outcomes, failure-log the last refusal
// sentences, submission-store only live double-buy records — none captures the
// run's INPUTS. This journal keeps the full replay basis: quotes, plan facts,
// floors, the fee model + generation, the exact composed calldata signed,
// decoded receipt facts, and the later reconciliation verdict.
//
// LAWS (the storage seam's, inherited deliberately):
//  · APPEND-ONLY: begin → record → seal. A sealed run is immutable; any write
//    to it is REFUSED in a sentence (typed result — planExecutable's shape —
//    never a throw: a recorder that can fail a run is not worth having).
//  · ABSENCE MUST NEVER READ AS CLEANLINESS: the size bound evicts oldest runs
//    and every eviction is COUNTED in the journal itself — a missing run is a
//    disclosed eviction, never silent history (see evictionDisclosure).
//  · NO CLOCK, NO NETWORK: every timestamp arrives as an explicit `atMs`
//    parameter so replay is deterministic; the only IO is the JournalStore.
//  · ROWS WE CANNOT PARSE ARE CARRIED VERBATIM through writes and counted on
//    read (submission-store's erased-evidence lesson); a corrupt blob refuses
//    writes until a human quarantines it — stash, never destroy.
// ─────────────────────────────────────────────────────────────────────────────

/** The journal's storage contract IS the repo's own StorageLike (allocation.ts)
 *  — reuse, never a lookalike. Any getItem/setItem/removeItem triple serves. */
export type JournalStore = StorageLike

/** An isolated Map-backed store — the test seam, and an honest fallback for a
 *  session that wants journaling without persistence. */
export function createMemoryJournalStore(): JournalStore {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v)
    },
    removeItem: (k: string) => {
      m.delete(k)
    },
  }
}

/** The guarded localStorage adapter (exec-log's safeStorage idiom): importing
 *  this module in a non-browser context must never throw, so the window read
 *  happens lazily and a missing/blocked window answers null — writes then
 *  refuse in words instead of crashing the run they exist to record. */
export function journalLocalStorage(): JournalStore | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const KEY = 'spectrum:run-journal:v1'
const QUARANTINE_KEY = `${KEY}:quarantine`
export const RUN_JOURNAL_FORMAT = 'spectrum-run-journal/v1'

/** Most-recent-N bound on stored runs. Runs are FAT (full quotes + calldata),
 *  so this is sized for localStorage's ~5MB budget, not for row count — and
 *  eviction past it is disclosed, never silent (see evictionDisclosure). */
export const RUN_JOURNAL_LIMIT = 16
/** Per-run entry ceiling: a real run records a handful of stages per step; a
 *  count past this is a runaway recorder, refused rather than flooding. */
export const RUN_ENTRY_LIMIT = 64
const MAX_RUN_ID_LEN = 120

// ── The run's vocabulary — imported shapes, never re-declared ───────────────

export type JournalStage = 'composed' | 'submitted' | 'receipt' | 'verdict'

/** What was true at plan time — the run's INPUT, captured whole. */
export interface RunPlanFacts {
  /** The signer the plan was sized against — the one field every record needs. */
  account: Address
  /** The assembler's OWN input per chain step, verbatim (portfolio-engine
   *  runs): targets, gross, funding, fee model + generation, floor overrides
   *  and the burn target all live inside it — THE replay basis. Absent only
   *  where no such object exists (a legacy-engine run). */
  assembly?: AssembleZeroExBatchBuyInput[]
  /** Whatever else was true at plan time (engine, plan name, funding route…). */
  detail?: Record<string, unknown>
}

export interface JournalStagePayload {
  /** The exact composition — the object AND the bytes, recorded, never
   *  re-derived at read time. `refusals` is where the empty-burn-route
   *  incident lives ('BURN' + the divert sentence beside burnSwapData: '0x'). */
  composed: {
    chainId: number
    composed: ComposedPortfolioBatchBuy
    /** encodePortfolioBatchBuy's output at compose time — the bytes signed. */
    calldata: `0x${string}`
    /** The assembler's audit trail where the caller holds it: per-leg quote,
     *  budget and floor breakdown (portfolio-batcher's own shape). */
    legs?: AssembledZeroExBatchBuy['legs']
    refusals?: AssembledZeroExBatchBuy['refusals']
  }
  /** submission-store's own record, verbatim — one vocabulary for "what was
   *  handed to the wallet", never a restatement. */
  submitted: LiveSubmission
  /** Decoded receipt facts — what the chain said, in the runner's own words. */
  receipt: {
    chainId: number
    submissionId: string | null
    transactionHash: `0x${string}` | null
    /** runner-effects' money-grade status parse. Null = never parsed. */
    verdict: MoneyCallsVerdict | null
    /** The portfolio engine's decoded outcome. Null = unread, never zeros. */
    portfolioResult: { bought: readonly bigint[]; refunded: bigint } | null
    /** RequiredLegFailed(index) when the chain named one — no cause attached. */
    failedLegIndex?: number
    /** Decoded log facts the caller extracted (fee sink, burn executed/diverted…). */
    detail?: Record<string, unknown>
  }
  /** The later reconciliation — what a human/monitor concluded actually
   *  happened to the money, recorded when it is known, not when it is hoped. */
  verdict: {
    conclusion: string
    classification?: string
    detail?: Record<string, unknown>
  }
}

export type JournalEntry = {
  [S in JournalStage]: { stage: S; atMs: number; payload: JournalStagePayload[S] }
}[JournalStage]

export interface JournalRun {
  runId: string
  beganAtMs: number
  planFacts: RunPlanFacts
  entries: JournalEntry[]
  /** null = still open; a number = sealed at that moment, immutable forever. */
  sealedAtMs: number | null
}

/** planExecutable's refusal shape (runner-effects) — a typed result carrying a
 *  human sentence, never a throw: refusing loudly must not crash the run. */
export type JournalWriteResult = { ok: true } | { ok: false; reason: string }
export type JournalExportResult = { ok: true; json: string } | { ok: false; reason: string }

// ── Lossless serialization — the bridge-pending bigint law, generalized ─────
// bridge-pending writes bigints with .toString() and reads them back with
// BigInt() at KNOWN field positions. The journal's payloads carry bigints at
// positions no schema pins (composed args, bought arrays, plan inputs), so the
// same toString/BigInt law rides an explicit tag instead of a field map — and
// a GENUINE string that happens to start with the tag is escaped, so the
// round-trip is lossless for hostile strings too, not just for bigints.

const TAG = '\u0001rj:' // U+0001 sentinel — unreachable from keyboards/UI text, and written as an escape so the byte survives editors and diffs

function toJournalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint' ? `${TAG}b${v.toString()}` : typeof v === 'string' && v.startsWith(TAG) ? `${TAG}s${v}` : v,
  )
}

function fromJournalJson(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown) => {
    if (typeof v !== 'string' || !v.startsWith(TAG)) return v
    const body = v.slice(TAG.length)
    if (body.startsWith('b')) {
      const digits = body.slice(1)
      // digits-only, because BigInt('') is 0n and BigInt('0x10') is 16n — a
      // tampered mark must stay verbatim evidence, never become an invented value
      if (/^-?\d+$/.test(digits)) return BigInt(digits)
      return v
    }
    if (body.startsWith('s')) return body.slice(1)
    return v
  })
}

// ── The stored book ──────────────────────────────────────────────────────────

interface EvictedMark {
  count: number
  lastAtMs: number | null
}

/** A stored row is a parsed run OR bytes we could not parse, carried verbatim
 *  (the writeAll-erased-the-evidence lesson, submission-store 2026-08-07). */
type BookRow = { run: JournalRun } | { unknown: unknown }

interface Book {
  rows: BookRow[]
  evicted: EvictedMark
  corrupt: boolean
}

/** Frame-only validation: the run's SKELETON is checked; the payloads are
 *  never inspected, sanitized or trimmed — they are the evidence, and a
 *  "cleaned" payload is a destroyed one. A malformed frame moves the whole
 *  row to unknown (kept, counted), never silently away. */
function parseRun(r: unknown): JournalRun | null {
  if (r == null || typeof r !== 'object' || Array.isArray(r)) return null
  const o = r as Record<string, unknown>
  if (typeof o.runId !== 'string' || o.runId.length === 0 || o.runId.length > MAX_RUN_ID_LEN) return null
  if (typeof o.beganAtMs !== 'number' || !Number.isFinite(o.beganAtMs) || o.beganAtMs < 0) return null
  if (!(o.sealedAtMs === null || (typeof o.sealedAtMs === 'number' && Number.isFinite(o.sealedAtMs)))) return null
  if (o.planFacts == null || typeof o.planFacts !== 'object' || Array.isArray(o.planFacts)) return null
  if (!Array.isArray(o.entries)) return null
  const entries: JournalEntry[] = []
  for (const e of o.entries) {
    if (e == null || typeof e !== 'object') return null
    const en = e as Record<string, unknown>
    if (en.stage !== 'composed' && en.stage !== 'submitted' && en.stage !== 'receipt' && en.stage !== 'verdict') return null
    if (typeof en.atMs !== 'number' || !Number.isFinite(en.atMs)) return null
    if (!('payload' in en)) return null
    entries.push({ stage: en.stage, atMs: en.atMs, payload: en.payload } as JournalEntry)
  }
  return {
    runId: o.runId,
    beganAtMs: o.beganAtMs,
    planFacts: o.planFacts as RunPlanFacts,
    entries,
    sealedAtMs: o.sealedAtMs as number | null,
  }
}

function readBook(store: JournalStore | null): Book {
  const none: EvictedMark = { count: 0, lastAtMs: null }
  if (!store) return { rows: [], evicted: none, corrupt: false }
  let raw: string | null = null
  try {
    raw = store.getItem(KEY)
  } catch {
    return { rows: [], evicted: none, corrupt: true }
  }
  if (!raw) return { rows: [], evicted: none, corrupt: false }
  let parsed: unknown
  try {
    parsed = fromJournalJson(raw)
  } catch {
    return { rows: [], evicted: none, corrupt: true }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { rows: [], evicted: none, corrupt: true }
  const o = parsed as { v?: unknown; evicted?: unknown; runs?: unknown }
  const ev = o.evicted as { count?: unknown; lastAtMs?: unknown } | null | undefined
  // A garbage eviction counter is CORRUPTION, not zero: defaulting it to 0
  // would make destroyed history read as clean — the exact lie this journal
  // exists to make impossible.
  if (
    o.v !== 1 ||
    !Array.isArray(o.runs) ||
    ev == null ||
    typeof ev !== 'object' ||
    typeof ev.count !== 'number' ||
    !Number.isInteger(ev.count) ||
    ev.count < 0 ||
    !(ev.lastAtMs === null || (typeof ev.lastAtMs === 'number' && Number.isFinite(ev.lastAtMs)))
  )
    return { rows: [], evicted: none, corrupt: true }
  const rows: BookRow[] = o.runs.map((r) => {
    const run = parseRun(r)
    return run ? { run } : { unknown: r }
  })
  return { rows, evicted: { count: ev.count, lastAtMs: ev.lastAtMs as number | null }, corrupt: false }
}

/** Returns whether the write LANDED (submission-store's writeBook lesson: a
 *  swallowed setItem must never let a caller report a record it never got),
 *  proven by reading the bytes back. Unknown rows ride through verbatim. */
function writeBook(rows: BookRow[], evicted: EvictedMark, store: JournalStore | null): boolean {
  if (!store) return false
  let payload: string
  try {
    payload = toJournalJson({ v: 1, evicted, runs: rows.map((r) => ('run' in r ? r.run : r.unknown)) })
  } catch {
    return false // a circular/unserialisable payload must be loud NOW, not a stored lie
  }
  try {
    store.setItem(KEY, payload)
  } catch {
    return false
  }
  try {
    return store.getItem(KEY) === payload
  } catch {
    return false
  }
}

/** Drop oldest parseable runs until one more fits the bound, COUNTING each —
 *  unknown rows are never evicted (they are evidence, and cheap). */
function evictToCap(rows: BookRow[], evicted: EvictedMark, atMs: number): void {
  let runCount = rows.filter((r) => 'run' in r).length
  while (runCount >= RUN_JOURNAL_LIMIT) {
    const i = rows.findIndex((r) => 'run' in r)
    if (i < 0) break
    rows.splice(i, 1)
    evicted.count += 1
    evicted.lastAtMs = atMs
    runCount -= 1
  }
}

// ── Shared refusal sentences (asserted in run-journal.test.ts) ───────────────

const NO_STORE = 'this context has no journal storage — nothing was recorded, so an incident here will have no replay record'
const NOT_PERSISTED = 'the journal write did not persist — the store accepted nothing, so this run has no durable record of this moment'
const CORRUPT_BOOK =
  'the run journal is unreadable and will not be written over — the bytes are evidence; quarantine them first (quarantineCorruptJournal), then record again'

/** The checks every mutator owes before touching the book. Null = pass. */
function gate(runId: string, atMs: number, store: JournalStore | null): string | null {
  if (!store) return NO_STORE
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > MAX_RUN_ID_LEN)
    return 'a run id must be a short non-empty name — nothing was recorded'
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < 0)
    return 'the journal stamp is not a readable moment — timestamps are the caller’s own so replay stays deterministic, and an unreadable one records nothing'
  return null
}

// ── The lifecycle: begin → record → seal ─────────────────────────────────────

/** Open a run's record with its full plan facts — the replay basis, captured
 *  BEFORE anything is quoted or signed so a run that dies early still has one. */
export function beginRun(
  runId: string,
  planFacts: RunPlanFacts,
  atMs: number,
  store: JournalStore | null = journalLocalStorage(),
): JournalWriteResult {
  const bad = gate(runId, atMs, store)
  if (bad) return { ok: false, reason: bad }
  if (planFacts == null || typeof planFacts !== 'object' || !isAddress(planFacts.account ?? '') || (planFacts.assembly != null && !Array.isArray(planFacts.assembly)))
    return { ok: false, reason: 'plan facts must carry the signing account — a journal entry that cannot say whose money ran is not a record' }
  const book = readBook(store)
  if (book.corrupt) return { ok: false, reason: CORRUPT_BOOK }
  if (book.rows.some((r) => 'run' in r && r.run.runId === runId))
    return { ok: false, reason: `run '${runId}' is already in this journal — a journal never rewrites what it witnessed, so begin a new run under its own id` }
  evictToCap(book.rows, book.evicted, atMs)
  book.rows.push({ run: { runId, beganAtMs: atMs, planFacts, entries: [], sealedAtMs: null } })
  if (!writeBook(book.rows, book.evicted, store)) return { ok: false, reason: NOT_PERSISTED }
  return { ok: true }
}

/** Append one stage record to an OPEN run. Refused (in a sentence) on a run
 *  this journal never began, on a sealed run, and past the entry ceiling. */
export function recordStage<S extends JournalStage>(
  runId: string,
  stage: S,
  payload: JournalStagePayload[S],
  atMs: number,
  store: JournalStore | null = journalLocalStorage(),
): JournalWriteResult {
  const bad = gate(runId, atMs, store)
  if (bad) return { ok: false, reason: bad }
  if (stage !== 'composed' && stage !== 'submitted' && stage !== 'receipt' && stage !== 'verdict')
    return { ok: false, reason: `'${String(stage)}' is not a journal stage — nothing was recorded` }
  if (payload == null || typeof payload !== 'object')
    return { ok: false, reason: 'a stage record with no payload is not a record — nothing was written' }
  const book = readBook(store)
  if (book.corrupt) return { ok: false, reason: CORRUPT_BOOK }
  const row = book.rows.find((r): r is { run: JournalRun } => 'run' in r && r.run.runId === runId)
  if (!row)
    return { ok: false, reason: `run '${runId}' was never begun here — the journal records only what it witnessed, so this ${stage} entry has no home` }
  if (row.run.sealedAtMs != null)
    return { ok: false, reason: `run '${runId}' is sealed — a sealed record is immutable, so this ${stage} write was refused rather than rewriting history` }
  if (row.run.entries.length >= RUN_ENTRY_LIMIT)
    return {
      ok: false,
      reason: `run '${runId}' already holds ${RUN_ENTRY_LIMIT} entries — a run this long is a runaway recorder, so the write was refused rather than flooding the store`,
    }
  row.run.entries.push({ stage, atMs, payload } as JournalEntry)
  if (!writeBook(book.rows, book.evicted, store)) return { ok: false, reason: NOT_PERSISTED }
  return { ok: true }
}

/** Close a run's record forever. From here every write to it refuses. */
export function sealRun(runId: string, atMs: number, store: JournalStore | null = journalLocalStorage()): JournalWriteResult {
  const bad = gate(runId, atMs, store)
  if (bad) return { ok: false, reason: bad }
  const book = readBook(store)
  if (book.corrupt) return { ok: false, reason: CORRUPT_BOOK }
  const row = book.rows.find((r): r is { run: JournalRun } => 'run' in r && r.run.runId === runId)
  if (!row) return { ok: false, reason: `run '${runId}' was never begun here — there is nothing to seal` }
  if (row.run.sealedAtMs != null)
    return { ok: false, reason: `run '${runId}' is already sealed — sealing it again would restamp history, so nothing changed` }
  row.run.sealedAtMs = atMs
  if (!writeBook(book.rows, book.evicted, store)) return { ok: false, reason: NOT_PERSISTED }
  return { ok: true }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface JournalRead {
  runs: JournalRun[]
  evicted: EvictedMark
  /** Rows present in the store that could not be read as runs — evidence,
   *  counted here and carried verbatim through every write, never erased. */
  dropped: number
  corrupt: boolean
  /** The counted eviction line — null only when nothing was ever evicted. */
  disclosure: string | null
}

export function readJournal(store: JournalStore | null = journalLocalStorage()): JournalRead {
  const book = readBook(store)
  const runs = book.rows.filter((r): r is { run: JournalRun } => 'run' in r).map((r) => r.run)
  return {
    runs,
    evicted: book.evicted,
    dropped: book.rows.length - runs.length,
    corrupt: book.corrupt,
    disclosure: evictionDisclosure(book.evicted),
  }
}

export function readRun(runId: string, store: JournalStore | null = journalLocalStorage()): JournalRun | null {
  return readJournal(store).runs.find((r) => r.runId === runId) ?? null
}

/** THE COUNTED LINE — this journal's law is that absence must never read as
 *  cleanliness, so eviction speaks for itself wherever the journal is shown. */
export function evictionDisclosure(evicted: { count: number }): string | null {
  const n = evicted.count
  if (!Number.isInteger(n) || n <= 0) return null
  return `${n} earlier run${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} evicted to keep this journal inside its ${RUN_JOURNAL_LIMIT}-run bound — a run missing here is a counted eviction, never a clean history`
}

// ── Export / import — the paste-to-whoever-is-diagnosing form ────────────────

/** One run as a lossless JSON string (bigints tagged; importRun revives them
 *  exactly). This is the failure-log's paste-ready idea, run-sized. */
export function exportRun(runId: string, store: JournalStore | null = journalLocalStorage()): JournalExportResult {
  const book = readBook(store)
  if (book.corrupt) return { ok: false, reason: CORRUPT_BOOK }
  const row = book.rows.find((r): r is { run: JournalRun } => 'run' in r && r.run.runId === runId)
  if (!row) return { ok: false, reason: `run '${runId}' is not in this journal — nothing to export` }
  try {
    return { ok: true, json: toJournalJson({ format: RUN_JOURNAL_FORMAT, run: row.run }) }
  } catch {
    return { ok: false, reason: 'this run could not be serialized — nothing was exported' }
  }
}

/** Bring an exported run into THIS journal (an offline replay context, a fresh
 *  device). Append-only like everything else: a runId already here refuses. */
export function importRun(json: string, atMs: number, store: JournalStore | null = journalLocalStorage()): JournalWriteResult {
  if (!store) return { ok: false, reason: NO_STORE }
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < 0)
    return { ok: false, reason: 'the journal stamp is not a readable moment — timestamps are the caller’s own so replay stays deterministic, and an unreadable one records nothing' }
  let parsed: unknown
  try {
    parsed = fromJournalJson(json)
  } catch {
    return { ok: false, reason: 'this is not a run-journal export — nothing was imported' }
  }
  const o = (parsed ?? {}) as { format?: unknown; run?: unknown }
  if (o.format !== RUN_JOURNAL_FORMAT) return { ok: false, reason: `this is not a '${RUN_JOURNAL_FORMAT}' export — nothing was imported` }
  const run = parseRun(o.run)
  if (!run) return { ok: false, reason: 'this export does not carry a readable run — nothing was imported' }
  const book = readBook(store)
  if (book.corrupt) return { ok: false, reason: CORRUPT_BOOK }
  if (book.rows.some((r) => 'run' in r && r.run.runId === run.runId))
    return { ok: false, reason: `run '${run.runId}' is already in this journal — importing over it would rewrite witnessed history, so nothing changed` }
  evictToCap(book.rows, book.evicted, atMs)
  book.rows.push({ run })
  if (!writeBook(book.rows, book.evicted, store)) return { ok: false, reason: NOT_PERSISTED }
  return { ok: true }
}

// ── The corrupt-blob exit — a HUMAN's decision, never a run's ────────────────

/** The quarantined raw bytes, for inspection before any discard. Never parsed. */
export function readJournalQuarantine(store: JournalStore | null = journalLocalStorage()): string | null {
  try {
    return store?.getItem(QUARANTINE_KEY) ?? null
  } catch {
    return null
  }
}

/** Move an UNREADABLE journal blob to the quarantine key (appending — nothing
 *  already stashed is lost) so journaling can resume without destroying the
 *  evidence (submission-store's stash-never-destroy idiom). Returns 1 when a
 *  corrupt blob was moved, 0 when the journal was readable and nothing moved.
 *  Nothing in any run calls this; it is a person's remedy for a poison blob. */
export function quarantineCorruptJournal(store: JournalStore | null = journalLocalStorage()): number {
  if (!store) return 0
  if (!readBook(store).corrupt) return 0
  try {
    const raw = store.getItem(KEY)
    if (raw != null) {
      const prior = store.getItem(QUARANTINE_KEY)
      store.setItem(QUARANTINE_KEY, prior ? `${prior}\n${raw}` : raw)
    }
    store.removeItem(KEY)
    return 1
  } catch {
    return 0 // a store that will not answer keeps its bytes — nothing was lost
  }
}
