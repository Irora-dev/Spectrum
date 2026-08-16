import { isAddress, type Address } from 'viem'
import type { SubmissionState } from './capability-ladder'

// ─────────────────────────────────────────────────────────────────────────────
// THE SUBMISSION STORE — E5's missing lifetime half (battle-test half-2
// finding 1, HIGH). The ladder's reducer is airtight WITHIN one instance:
// from `submitted` the only exits are resolution, and the forbidden fallback
// throws. But a React instance is not a lifetime — the veil remount flips the
// portfolio subtree's key, StrictMode double-invokes in dev, a tab reloads —
// and a FRESH machine starts at `idle`, where `attempt` is legal. Holding a
// submission through `ambiguous-silence` and then remounting produced a
// second submission of the same money: exactly the double-buy E5 calls
// unrepresentable.
//
// bridge-pending.ts is the template ("so a reload, or a wallet popup eating
// the tab, never loses a live transfer") — same reasoning, applied to the
// ladder: an UNRESOLVED submission persists in localStorage the moment it
// exists, is sanitized on read like every storage seam, and `hydrateSubmission`
// is the runner's MANDATORY first move — a live record forces the machine to
// start at `submitted` (resolve-first), never at `idle`.
//
// The record carries the SIGNER (half-2 finding 6): a submission made by
// wallet A must never be resolved-and-acted-on as wallet B after a mid-run
// account switch — the runner compares record.signer to the active account
// and treats a mismatch as someone else's live money: report, never resume.
//
// SANITIZE-ON-READ IS WRONG FOR A SAFETY RECORD (audit round 2, 2026-08-04).
// Everywhere else in this codebase a malformed stored row is DROPPED — right for
// display data, where the cost of a bad row is a wrong pixel. Here the cost is a
// DOUBLE-BUY: a present-but-unreadable record read as "no record", and `attempt`
// is legal from idle. So this module distinguishes three answers, not two:
// a parsed record · genuinely nothing · PRESENT BUT UNREADABLE. The last one is
// UNKNOWN, and unknown must never resolve to idle — `readSubmissions` reports the
// dropped count and the runner refuses to run rather than run unprotected (the
// same shape as its no-persistence law).
//
// CLAIM BEFORE YOU ATTEMPT (round 10, 2026-08-04 — the multi-tab race). The
// remount analysis assumed instances are SEQUENTIAL. localStorage is shared
// across TABS, which are concurrent: two tabs both hydrate `idle`, both
// legally `attempt`, and both submit the same money. The store recorded only
// AFTER the wallet returned an id, so nothing owned the step during the exact
// window a human spends looking at a wallet prompt. So a row now exists from
// BEFORE the wallet is touched — a CLAIM (`submissionId: null`) that a second
// tab sees and refuses to race.
//
// A CLAIM MAY EXPIRE; A SUBMISSION MAY NOT. This looks like the TTL this
// module rejects, and the distinction is the whole point: a submission with an
// id means MONEY IS IN FLIGHT and time passing does not resolve that ambiguity.
// A claim carries no id — nothing was ever sent — so there is no ambiguity to
// preserve, only a tab that may have been closed. An expired claim is
// therefore safe to take over, and a claim that expires while its tab is
// genuinely still waiting is caught by the next hydrate: by then it has an id.
//
// AND NO EVICTION EITHER (audit round 3, 2026-08-04 — the same mistake wearing
// a row count instead of a clock). The cap used to `slice(-12)` on write, which
// silently dropped the OLDEST row — and every row in this store is BY
// DEFINITION unresolved money (a resolved one is cleared immediately), so the
// cap could only ever evict a LIVE submission. Evicted record -> hydrate says
// idle -> `attempt` is legal -> the double-buy, reached by row count. There is
// no principled way to choose which live money to forget, so nothing is
// forgotten: rows are ~120 bytes, a real plan makes a handful, and a count
// past HARD_MAX_ROWS is not "too many" but EVIDENCE OF CORRUPTION — reported
// as such so the runner's unknown-is-not-idle gate refuses the run.
//
// DELIBERATELY NO TTL (weighed against the parallel fix's 24h sweep and
// rejected): time passing does not resolve ambiguity — an auto-forgotten
// record is exactly the fallback-after-ambiguous-submit the law forbids,
// wearing a clock. A record whose id can no longer be resolved (wallet
// reinstalled, callsStatus lost it) is a RUNNER DUTY: poll diligently, then
// surface to the user ("we can't confirm whether this went through — check
// your wallet activity") and clear only on their explicit acknowledgment.
// The ladder staying shut until a human answers is the design, not a bug.
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveSubmission {
  /** One record per (chain, step) — the step key is the runner's stable id
   *  for the unit of money this submission moves (e.g. `batch`, `approve:0x…`). */
  chainId: number
  stepKey: string
  /** The ladder rung that submitted (0=atomic … 3=plain). */
  rung: number
  /** The id the wallet/RPC returned — what callsStatus/receipt polling needs.
   *  NULL = a CLAIM: this step is being attempted right now by some instance,
   *  and no money has been sent yet (see the header's claim/submission law). */
  submissionId: string | null
  /** The account that signed. A resumed session under a DIFFERENT account
   *  must not touch this record (finding 6). */
  signer: Address
  atMs: number
  /** TRUE = the wallet was asked to submit and never answered clearly, so a
   *  transaction MAY be in flight with no id we could record (A6 review,
   *  2026-08-07). Such a claim must NOT expire: the TTL measures holder
   *  liveness, but here the holder is GONE and the ambiguity remains — an
   *  expiring claim invited a retry at +90s that buys the same thing twice,
   *  and the header's "by then it has an id" consolation is structurally
   *  false on this path (no id will ever arrive). Only a human releases it. */
  ambiguous?: boolean
}

/** A claim stamp must be a plausible wall-clock moment. 2020-01-01 is before
 *  this product existed; 2100-01-01 is past any honest clock skew. The window
 *  is deliberately enormous — it exists to reject garbage (0, -1, 1e15), never
 *  to police clocks. */
const MIN_PLAUSIBLE_MS = 1_577_836_800_000
const MAX_PLAUSIBLE_MS = 4_102_444_800_000

const KEY = 'spectrum:live-submission:v1'
/** Not a cap that evicts — a ceiling that means something is WRONG. A real
 *  multi-chain plan makes a handful of unresolved rows; dozens means a bug or
 *  a tampered store, and the honest answer is to refuse, not to trim. */
const HARD_MAX_ROWS = 64
/** EIP-5792 permits a calls id up to 4096 bytes, and the runner prefixes it
 *  (`calls:<chainId>:<id>`) — so the ceiling must clear what a COMPLIANT
 *  wallet can hand us (A6 review, 2026-08-07: at 200, a spec-legal id made
 *  the runner's own record unreadable the moment it was written). Past this
 *  is tamper-grade, and `recordSubmission` refuses it LOUDLY at the write
 *  seam rather than writing a row every read will drop. */
const MAX_ID_LEN = 4200
/** SHARED LAW, two enforcement sites: `parseRow` below REFUSES a longer
 *  stepKey as hostile input, and `stepKeyOf` (execution-runner) GUARANTEES a
 *  shorter one by construction — a long intent collapses to a digest form. If
 *  these ever diverge, every record for a long-key step becomes unreadable:
 *  hydrate answers idle, claims turn invisible to other tabs, and the
 *  double-buy guard silently voids — which is exactly how R6's pin failed to
 *  reproduce (2026-08-07: the R5 intent-bound keys had already crossed this
 *  bound for a batch funded from three ordinary sources). */
export const MAX_STEP_KEY_LEN = 80

type Stored = Record<string, unknown>

function parseRow(o: Stored): LiveSubmission | null {
  // ⚠ A NULL ROW USED TO CRASH THE WHOLE READ (review 2026-08-07, R4). Every
  // field check below dereferences `o`, and `JSON.parse('[null]')` is one
  // keystroke of tampering — `null` is also exactly what a serializer emits for
  // a dropped row. The throw escaped `readSubmissions`, whose own guards cover
  // getItem and JSON.parse but not the map, and reached the runner: at the door
  // it made law 12's refusal sentence unreachable, and MID-RUN it threw AFTER
  // the wallet had returned an id — no record, no exec-log row, an orphaned
  // in-flight transaction. A malformed row is a DROPPED row, never an
  // exception.
  if (o == null || typeof o !== 'object' || Array.isArray(o)) return null
  if (
    typeof o.chainId !== 'number' ||
    !Number.isInteger(o.chainId) ||
    o.chainId <= 0 ||
    typeof o.stepKey !== 'string' ||
    o.stepKey.length === 0 ||
    o.stepKey.length > MAX_STEP_KEY_LEN ||
    typeof o.rung !== 'number' ||
    !Number.isInteger(o.rung) ||
    o.rung < 0 ||
    o.rung > 8 ||
    !(o.submissionId === null || (typeof o.submissionId === 'string' && o.submissionId.length > 0 && o.submissionId.length <= MAX_ID_LEN)) ||
    typeof o.signer !== 'string' ||
    !isAddress(o.signer) ||
    typeof o.atMs !== 'number' ||
    !Number.isFinite(o.atMs) ||
    // ⚠⚠ RANGE, NOT JUST TYPE — this field decides whether a claim is still
    // LIVE, and a finite number was enough to defeat it (self-audit,
    // 2026-08-07, hunting the asymmetry the independent pass taught me: `rung`
    // three lines up is range-checked and this was not).
    //
    // MEASURED, a live claim with `submissionId: null` (the wallet is being
    // asked RIGHT NOW): atMs = -1 or 0 makes the TTL comparison read it as
    // long expired, so ANOTHER TAB CLAIMS OVER IT — 'claimed', two tabs, one
    // batch, the double buy this whole module exists to prevent. A string was
    // already caught by the type test; a NUMBER walked straight through.
    //
    // Both directions are rejected rather than clamped: a past/zero stamp fails
    // OPEN (steals a live claim) and a far-future one fails CLOSED (a claim
    // that never expires, wedging the step). An implausible stamp is an
    // unreadable ROW, which law 12 already refuses on — the safe landing.
    o.atMs < MIN_PLAUSIBLE_MS ||
    o.atMs > MAX_PLAUSIBLE_MS ||
    !(o.ambiguous === undefined || typeof o.ambiguous === 'boolean')
  )
    return null
  return {
    chainId: o.chainId,
    stepKey: o.stepKey,
    rung: o.rung,
    submissionId: o.submissionId as string | null,
    signer: o.signer,
    atMs: o.atMs,
    ...(o.ambiguous === true ? { ambiguous: true as const } : {}),
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The three-answer read. `dropped` > 0 means rows EXIST that we cannot
 *  understand — treat as unknown, never as absent (see the header). `corrupt`
 *  means the blob itself is unreadable, which is the same class. */
export interface SubmissionsRead {
  rows: LiveSubmission[]
  dropped: number
  corrupt: boolean
}

export function readSubmissions(store: Storage | null = storage()): SubmissionsRead {
  const book = readBook(store)
  // Past the ceiling we do not trim (that would forget live money) — we report
  // corruption, which the runner turns into a refusal.
  return { rows: book.rows, dropped: book.unknown.length, corrupt: book.corrupt || book.rows.length > HARD_MAX_ROWS }
}

/** The full book: parsed rows AND the raw entries we could not parse. Unknown
 *  entries are EVIDENCE (law 12 refuses runs on them) and possibly live money
 *  written by another build — every write carries them through VERBATIM.
 *  ⚠ THE WRITES USED TO ERASE THEM (A6 review, 2026-08-07, both lenses):
 *  writeAll rebuilt the blob from parsed rows only, so the claim heartbeat
 *  destroyed the very row law 12 exists to refuse on, every 15 seconds, while
 *  the user read the wallet prompt — and the next run's door check then found
 *  a scrubbed store. */
interface Book {
  rows: LiveSubmission[]
  unknown: unknown[]
  /** The blob itself was unreadable (or not an array). There is nothing to
   *  carry through — mutators must not write over what they cannot read. */
  corrupt: boolean
}

function readBook(store: Storage | null): Book {
  let raw: string | null = null
  try {
    raw = store?.getItem(KEY) ?? null
  } catch {
    return { rows: [], unknown: [], corrupt: true }
  }
  if (!raw) return { rows: [], unknown: [], corrupt: false }
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return { rows: [], unknown: [], corrupt: true }
  }
  if (!Array.isArray(arr)) return { rows: [], unknown: [], corrupt: true }
  const rows: LiveSubmission[] = []
  const unknown: unknown[] = []
  for (const entry of arr) {
    const parsed = parseRow(entry as Stored)
    if (parsed != null) rows.push(parsed)
    else unknown.push(entry)
  }
  return { rows, unknown, corrupt: false }
}

function readAll(store: Storage | null = storage()): LiveSubmission[] {
  return readBook(store).rows
}

/** Where evidence goes when it must leave the live book without being
 *  destroyed — see `quarantineUnknownRows` and the corrupt-blob branch of
 *  `recordSubmission`. Append-only; nothing here is ever read back as a
 *  submission, and nothing in the runner clears it. */
const QUARANTINE_KEY = 'spectrum:live-submission:v1:quarantine'

/** A row this module writes must survive its OWN read (A6 verify pass,
 *  2026-08-07). Every writer used to be free to mint a row that `parseRow`
 *  drops forever after — and `claimStep` actually could: `chainOf(step)` can
 *  carry NaN, which `JSON.stringify` serialises as `null`, so our own claim
 *  became an unparseable row that refuses every future run and has no exit.
 *  A write that cannot be read back is OUR bug, and it must be loud at the
 *  moment it happens rather than permanent and mysterious afterwards. */
/** The submission record could not be STORED — distinct from unparseable. */
const NOT_PERSISTED =
  'refusing to report a submission as protected when its record did not persist — the store accepted nothing'

function assertWritable(row: LiveSubmission): void {
  if (parseRow(row as unknown as Stored) == null)
    throw new Error('refusing to write a submission row that could not be read back — every read would silently drop it')
}

/** Move the live book's raw bytes to the quarantine key, appending rather than
 *  replacing so nothing already stashed is lost. Used where a write must
 *  proceed over something unreadable: the evidence survives somewhere it can
 *  be inspected, instead of being overwritten into nonexistence. */
function stashRaw(store: Storage | null): void {
  try {
    const raw = store?.getItem(KEY)
    if (!raw) return
    const prior = store?.getItem(QUARANTINE_KEY)
    store?.setItem(QUARANTINE_KEY, prior ? `${prior}\n${raw}` : raw)
  } catch {
    /* a store that will not answer cannot be stashed to either — the caller's
       own write is about to fail the same way, and it handles that */
  }
}

/** THE EXIT FOR UNKNOWN ROWS, and the only one (A6 verify pass, 2026-08-07:
 *  preserving unparseable rows through every write — correct on its own —
 *  left them IMMORTAL, so one poison entry refuses every future run forever
 *  and the only remedy anyone could offer was "clear this site's data", which
 *  destroys real in-flight records in the same blob).
 *
 *  Moves unknown entries to the quarantine key and leaves the parseable rows
 *  alone, so the book heals while the evidence stays inspectable. Returns how
 *  many were moved.
 *
 *  ⚠ THIS IS A HUMAN'S DECISION, NOT A RUN'S. Nothing in the runner calls it,
 *  and nothing may: automatically clearing what law 12 refuses on is exactly
 *  the fallback-after-ambiguity this store exists to forbid. It is the
 *  mechanism behind an acknowledgment surface the panel does not have yet —
 *  the same surface the `dup:` records and the ambiguous claims are waiting
 *  on, which is why it is built once, here, rather than three times later. */
/** The quarantine's raw evidence, for the release surface to SHOW before any
 *  discard is offered. Null = empty. Read-only; nothing parses it — it is
 *  bytes that failed parsing, kept inspectable. */
export function readQuarantineRaw(store: Storage | null = storage()): string | null {
  try {
    const raw = store?.getItem(QUARANTINE_KEY)
    return raw ? raw : null
  } catch {
    return null
  }
}

/** Discard the quarantine — a HUMAN's act on the release surface, offered
 *  only after the evidence was shown. Nothing in any run calls this. */
export function clearQuarantine(store: Storage | null = storage()): void {
  try {
    store?.removeItem(QUARANTINE_KEY)
  } catch {
    /* unwritable store: the evidence simply stays */
  }
}

export function quarantineUnknownRows(store: Storage | null = storage()): number {
  const book = readBook(store)
  if (book.corrupt) {
    // nothing parseable to keep: stash the whole blob and start clean
    stashRaw(store)
    try {
      store?.removeItem(KEY)
    } catch {
      /* unwritable store: nothing to do, and nothing was lost */
    }
    return 1
  }
  if (book.unknown.length === 0) return 0
  const moved = book.unknown.length
  try {
    const prior = store?.getItem(QUARANTINE_KEY)
    const payload = JSON.stringify(book.unknown)
    store?.setItem(QUARANTINE_KEY, prior ? `${prior}\n${payload}` : payload)
  } catch {
    // if the evidence cannot be stashed, it must NOT be dropped from the book
    return 0
  }
  writeBook(book.rows, [], store)
  return moved
}

/** What is sitting in quarantine, as raw text — for a support surface or a
 *  bug report. Never parsed back into submissions. */
export function quarantinedRaw(store: Storage | null = storage()): string | null {
  try {
    return store?.getItem(QUARANTINE_KEY) ?? null
  } catch {
    return null
  }
}

function writeBook(rows: LiveSubmission[], unknown: unknown[], store: Storage | null): boolean {
  // ⚠⚠ CRITICAL — adversarial pass, 2026-08-08. This SWALLOWED the throw and
  // returned void, so every caller reported success for a write that never
  // landed. Measured on a store with a few bytes of headroom: both probes said
  // writable, `claimStep` returned 'claimed' having written NOTHING,
  // `recordSubmission` returned normally and wrote nothing, the run reported
  // done — and on reload `hydrate` said idle and run 2 SUBMITTED THE SAME MONEY
  // AGAIN. Every guard in the module reported healthy throughout. The only
  // write that landed was `clearSubmission`'s "[]": THE DELETIONS FIT AND THE
  // PROTECTION DID NOT.
  //
  // Two changes. It RETURNS whether the write landed, so no caller can report a
  // success it never got. And it READS BACK what it wrote, because a store can
  // accept `setItem` and keep less than it was given — parseability was already
  // checked by assertWritable, but this module's stated law is that a row it
  // writes survives its OWN READ, and only re-reading the bytes proves that.
  const payload = JSON.stringify([...rows, ...unknown])
  try {
    // EVERY row is unresolved money — write them ALL, and carry the unknown
    // entries through verbatim (they may be another build's live money, and
    // they are the evidence the door check refuses on). Trimming here is what
    // made the double-buy reachable by row count (audit round 3).
    store?.setItem(KEY, payload)
  } catch {
    return false // quota, private browsing, a store that denies writes outright
  }
  if (!store) return false
  // an empty book is a legitimate write (clearSubmission), and it must still
  // prove it landed — the measured failure had exactly that write succeeding
  // while the ones carrying protection did not
  return store.getItem(KEY) === payload
}

/** Record a submission THE MOMENT it exists — called in the same tick the
 *  wallet returns an id, before any await that could lose the tab.
 *
 *  REFUSES (throws) a row that would not survive its own read-back: writing a
 *  record every read drops is the silent-void class (the R5 length hole,
 *  found 2026-08-07) — with the bounds sized for everything a compliant
 *  wallet can produce, a failure here is OUR bug or tamper-grade input, and
 *  it must be loud. The runner converts the throw into an honest partial. */
/**
 * THE MID-RUN DOOR PROBE (desk 250 item 4 — R7's quota half; the registry row
 * that specified this name). The runner's door check reads store health ONCE,
 * before the run — but a QuotaExceededError inside a LATER write degrades
 * silently: the record simply does not persist and only the in-instance guard
 * remains, so an in-flight transaction can end the run with no durable record.
 *
 * Same shape as the law-8 door probe, applied AT THE SUBMIT SEAM: write a
 * sentinel, read it back, remove it. Called BEFORE the wallet is asked, so a
 * false answer refuses with 'nothing-sent' certainty — the store being full is
 * survivable exactly while nothing is in flight yet. Probing after would be
 * measuring the door from inside the burning room.
 *
 * A probe that cannot CLEAN UP its sentinel still answers true if the
 * round-trip held: a leftover sentinel is noise; a record that cannot persist
 * is money with no memory. The two failure modes are not equal.
 */
/** One row's worth of bytes, rounded up. A real row is ~120: chain id, step
 *  key, rung, submission id, a 42-char address and a 13-digit stamp. */
const PROBE_BYTES = 160

export function probeWritable(store: Storage | null = storage()): boolean {
  if (!store) return false
  const key = `${KEY}:probe`
  // ⚠⚠ THE PROBE MUST BE THE SIZE OF THE THING IT CERTIFIES (adversarial pass,
  // 2026-08-08). It wrote ONE BYTE and certified a book whose rows are ~120
  // bytes each — so a store with a few bytes of headroom passed every gate and
  // then silently dropped every real write. A probe smaller than the write it
  // vouches for is not a probe, it is a formality.
  //
  // Sized at one row plus the current book: that is what the NEXT write
  // actually needs. Probing a full 64-row book would refuse stores that can
  // serve this run perfectly well, and a gate that refuses working sessions is
  // the one that gets switched off.
  const sentinel = 'x'.repeat(PROBE_BYTES) + (store.getItem(KEY) ?? '')
  try {
    store.setItem(key, sentinel)
    const ok = store.getItem(key) === sentinel
    try {
      store.removeItem(key)
    } catch {
      /* a stuck sentinel is not a failed probe */
    }
    return ok
  } catch {
    return false
  }
}

export function recordSubmission(sub: LiveSubmission, store: Storage | null = storage()): void {
  assertWritable(sub)
  const book = readBook(store)
  if (book.corrupt) {
    // The blob is unreadable as a whole: there is nothing to preserve, and
    // this record is live money that must not go unrecorded. The runner's
    // door check refuses to START on a corrupt blob, so reaching here means
    // it corrupted mid-run — the record wins.
    //
    // ⚠ BUT THE EVIDENCE IS STASHED, NOT DESTROYED (A6 verify pass,
    // 2026-08-07). Overwriting outright erased a blob that might have held a
    // half-written foreign record, AND it healed the store — so the next
    // run's door check PASSED on a store that was refusing a moment earlier,
    // the exact erasure class the rest of this module closes. The raw string
    // moves to the quarantine key first, where it stays readable evidence and
    // keeps refusing nothing.
    stashRaw(store)
    if (!writeBook([sub], [], store)) throw new Error(NOT_PERSISTED)
    return
  }
  // ⚠ AND IT OVERWROTE ANY ROW AT THE KEY WITH NO OWNER CHECK (adversarial
  // pass, 2026-08-08). renewClaim, markClaimAmbiguous and clearSubmission all
  // check the owner; this did not. Measured: after a claim is legitimately
  // taken over, the original tab's own submit lands and REPLACES the taker's
  // record — two transactions broadcast, one record kept, and whichever wallet
  // lost the race has live money nothing is tracking.
  //
  // A LIVE SUBMISSION OF ANOTHER SIGNER IS NEVER OURS TO REPLACE. A bare claim
  // is: taking over an expired claim is legal by the claim law (no id means
  // nothing was sent), and that is the path this must not break.
  const priorAtKey = book.rows.find((r) => r.chainId === sub.chainId && r.stepKey === sub.stepKey)
  if (
    priorAtKey &&
    priorAtKey.submissionId != null &&
    priorAtKey.signer.toLowerCase() !== sub.signer.toLowerCase()
  )
    throw new Error(
      'refusing to overwrite another wallet\'s live submission record — its money is in flight and this record is the only thing tracking it',
    )
  const rest = book.rows.filter((r) => !(r.chainId === sub.chainId && r.stepKey === sub.stepKey))
  // ⚠⚠ A LIVE-MONEY RECORD THAT DID NOT PERSIST MUST BE LOUD (adversarial pass,
  // 2026-08-08). This returned normally on a swallowed write, so the runner
  // believed the submission was protected against a remount when nothing had
  // been stored — and the next run submitted the same money. Throwing is the
  // right shape here and nowhere else in this module: the caller's catch is the
  // recovery path that marks the claim ambiguous and stops the run honestly,
  // which is exactly what should happen when the protection cannot be written.
  if (!writeBook([...rest, sub], book.unknown, store)) throw new Error(NOT_PERSISTED)
}

/** A submission RESOLVED (success or failure — either is a real outcome and
 *  ends the record's life; the exec log carries what happened). */
export function clearSubmission(
  chainId: number,
  stepKey: string,
  store: Storage | null = storage(),
  /** The account releasing it. Omitted only by callers that have no signer in
   *  scope; supplying it is what makes the release safe. */
  signer?: Address,
): void {
  const book = readBook(store)
  if (book.corrupt) return // never write over what we cannot read
  // ⚠⚠ CRITICAL — adversarial pass, 2026-08-08. This deleted by (chainId,
  // stepKey) alone: no owner check, no id check, while renewClaim and
  // markClaimAmbiguous both check owner AND id. It took no signer parameter at
  // all.
  //
  // MEASURED, one wallet, two tabs, the real runner: tab A claims and its
  // prompt opens; the tab is suspended so the heartbeat stops. At +91s tab B
  // sweeps A's expired claim, claims, submits — B's money is IN FLIGHT. At +96s
  // tab A wakes and the human hits Reject on the prompt that was open all
  // along; the rejection is definitive, so this wiped the row. The store is
  // then empty, hydrate says idle, claimStep says claimed — and B's in-flight
  // transaction is completely unprotected, so any reload or third tab
  // re-submits it.
  //
  // A RELEASE MAY ONLY RELEASE WHAT THE RELEASER HOLDS. Another signer's row is
  // not ours to delete, and a row carrying a submissionId is LIVE MONEY whose
  // record must outlive our own step — clearing it is what this whole module
  // exists to prevent. Both refusals leave the row exactly as it stands.
  const existing = book.rows.find((r) => r.chainId === chainId && r.stepKey === stepKey)
  if (existing) {
    // ONE check, not two: my first cut wrote a second guard narrowed by
    // `submissionId != null`, which the line above already subsumes entirely —
    // dead code found by bite-testing this very fix (removing the first guard
    // changed nothing, because the redundant one still caught the case).
    // A releaser may only release its OWN row, whether that row is a bare claim
    // or a live submission; someone else's is never ours to delete.
    if (signer && existing.signer.toLowerCase() !== signer.toLowerCase()) return
  }
  writeBook(
    book.rows.filter((r) => !(r.chainId === chainId && r.stepKey === stepKey)),
    book.unknown,
    store,
  )
}

/** Every unresolved submission — the runner's boot read, and the read a host
 *  shell can gate its remount-causing ceremonies on (UIGuy's key-flip). */
export function liveSubmissions(store: Storage | null = storage()): LiveSubmission[] {
  return readAll(store)
}

/** How long a CLAIM (no id yet) holds a step against another tab WITHOUT a
 *  renewal. The TTL measures HOLDER LIVENESS, not human reading speed (UIGuy's
 *  round-10 finding: a prompt dwell routinely outruns any fixed TTL — at 91s a
 *  second tab could legally claim-over while the first tab's prompt was still
 *  open, and a wallet approval cannot be unsent). The claiming tab HEARTBEATS
 *  (`renewClaim`, every ~CLAIM_HEARTBEAT_MS) for as long as its wallet promise
 *  is unresolved, so an expired claim means "the holder stopped renewing" ≈
 *  the tab is actually gone. Only claims expire — never submissions.
 *
 *  ⚠ THE WALLETCONNECT RESIDUAL (client-side unfixable): a phone prompt
 *  OUTLIVES the tab. Tab dies at the prompt → heartbeats stop → the claim
 *  expires → another tab may take over — and the human can STILL approve on
 *  the phone later: an in-flight transaction with no claim and no id ever
 *  written. The resolve-first hydrate is the only net under that case; the
 *  heartbeat is NOT a complete answer and must not be mistaken for one. */
export const CLAIM_TTL_MS = 90_000
export const CLAIM_HEARTBEAT_MS = 15_000

/** Renew a claim this signer already holds — the heartbeat. Refuses (returns
 *  false) unless the record is STILL a claim (no id) held by THIS signer:
 *  a submission must never have its timestamp touched (expiry does not apply
 *  to it), and another signer's claim is not ours to extend. */
export function renewClaim(
  chainId: number,
  stepKey: string,
  signer: Address,
  nowMs: number,
  store: Storage | null = storage(),
): boolean {
  const book = readBook(store)
  if (book.corrupt) return false // never write over what we cannot read
  const existing = book.rows.find((r) => r.chainId === chainId && r.stepKey === stepKey)
  if (!existing || existing.submissionId != null) return false
  if (existing.signer.toLowerCase() !== signer.toLowerCase()) return false
  // ⚠⚠ CRITICAL — independent pass 2026-08-08 (SpectrumContracts, lens 3).
  // This was the ONE writer with no writability check: recordSubmission,
  // claimStep and markClaimAmbiguous all validate, and the 15-second HEARTBEAT
  // wrote `atMs` straight through. Measured: renewClaim(nowMs = 0) returned TRUE
  // while poisoning its own live claim — the row then fails parseRow's range
  // check, so hydrateSubmission reads idle, claimStep answers store-unreadable,
  // and later runs report refused with the book unchanged. There is NO
  // in-product exit: sweepExpiredClaims cannot see it, renewClaim itself returns
  // false, and the only escape is clearing site data, which destroys real
  // in-flight records. The entire hole was untested — the fix left all existing
  // tests passing, which is the tell that nothing covered it.
  //
  // VALIDATE-AND-REFUSE, NEVER THROW: this runs inside a setInterval callback,
  // where a throw is unhandled, and renewClaim already has a boolean contract.
  // Refusing leaves the LAST GOOD STAMP in place — the claim then expires
  // honestly instead of becoming unreadable, which is strictly better than
  // poisoning it. (Their remedy caveat, and it is the right shape.)
  const renewed = { ...existing, atMs: nowMs }
  if (parseRow(renewed as unknown as Stored) == null) return false
  // and the heartbeat reports the WRITE, not the intent (adversarial pass,
  // 2026-08-08): returning true on a swallowed write told the runner the claim
  // was alive while it was silently expiring, and another tab took it mid-prompt.
  return writeBook(
    book.rows.map((r) => (r.chainId === chainId && r.stepKey === stepKey ? renewed : r)),
    book.unknown,
    store,
  )
}

export type ClaimResult =
  | 'claimed'
  /** Claimed, but there is NO storage at all, so no cross-tab protection exists
   *  to be had — the run may proceed and the surface must SAY SO before a wallet
   *  is asked (the owner's ruling, 2026-08-08).
   *
   *  This exists because `'claimed'` was overloaded: it asserted both "you may
   *  proceed" AND "nobody else holds this", and with no store the first is true
   *  while the second is unknowable. Flipping the verdict to a refusal only
   *  swaps which half lies, and locks every privacy-mode user out to prevent a
   *  case that needs two tabs in one such session — the single-tab double buy is
   *  already unrepresentable by the in-memory reducer. Half-knowable means say
   *  the half you know. */
  | 'claimed-unprotected'
  | 'held-by-other-tab'
  | 'already-submitted'
  | 'held-ambiguous'
  | 'store-unreadable'

/**
 * Claim a step BEFORE touching the wallet. This is what narrows the
 * cross-tab double-buy to the width of one synchronous read-then-write (a
 * localStorage race two tabs can still lose in the same microsecond —
 * browsers grant no storage mutex, so "unreachable" would be an overclaim;
 * the heartbeat and the resolve-first hydrate are the nets behind it).
 *
 * `already-submitted` = a real submission exists (resolve it, never re-attempt).
 * `held-by-other-tab` = another instance is at the wallet prompt right now.
 * `held-ambiguous`   = an earlier attempt never answered — a transaction may
 *                      be in flight with NO id to poll. Never expires; only a
 *                      human releases it (time does not resolve ambiguity).
 * `store-unreadable` = a row exists that we cannot parse — refuse the step.
 */
export function claimStep(
  chainId: number,
  stepKey: string,
  signer: Address,
  nowMs: number,
  store: Storage | null = storage(),
): ClaimResult {
  // ONE read backs the whole decision, and the write happens in the same
  // synchronous tick (A6 review, 2026-08-07: the old shape read once to
  // decide and AGAIN inside the write, so a row landing between the two was
  // silently replaced — including a live submission replaced by our id-less
  // claim).
  const book = readBook(store)
  // LAW 12 AT THE CLAIM SEAM (2026-08-07, found closing R6's pin). The
  // runner's door check reads the store's health once, before the run — but
  // rows can appear DURING it (another tab, another app version, tampering),
  // and this claim is the last gate before a wallet is touched. An unreadable
  // row might be a live submission of THIS step: claiming over it is the
  // double-buy. Unknown is not absent — refuse, and write nothing. (Writes
  // now carry unknown rows through verbatim, so the evidence also survives
  // everyone ELSE's writes — but a claim over a possibly-live submission is
  // still the double-buy, so the refusal stands regardless.)
  if (book.corrupt || book.unknown.length > 0) return 'store-unreadable'
  if (book.rows.length > HARD_MAX_ROWS) return 'store-unreadable'
  const existing = book.rows.find((r) => r.chainId === chainId && r.stepKey === stepKey)
  if (existing) {
    if (existing.submissionId != null) return 'already-submitted'
    // AMBIGUITY DOES NOT EXPIRE (A6 review, 2026-08-07): this claim's wallet
    // was asked and never answered, so money may be in flight with no id to
    // ever hydrate — the TTL below measures a holder's liveness, and this
    // holder is gone while the ambiguity is not. Taking the claim over is
    // the retry-that-buys-twice.
    if (existing.ambiguous === true) return 'held-ambiguous'
    if (nowMs - existing.atMs < CLAIM_TTL_MS) return 'held-by-other-tab'
    // an EXPIRED claim: no id ever existed, so no money was sent — safe to take
  }
  const claim: LiveSubmission = { chainId, stepKey, rung: 0, submissionId: null, signer, atMs: nowMs }
  assertWritable(claim) // our own claim must not be the poison row (see assertWritable)
  // ⚠⚠ A CLAIM THAT DID NOT PERSIST IS NOT A CLAIM (adversarial pass,
  // 2026-08-08). This used to return 'claimed' regardless, so on a nearly-full
  // store the runner proceeded to the wallet believing it owned the step while
  // the store held nothing — and after a reload the next run submitted the same
  // money. `store-unreadable` is the honest verdict: we cannot establish
  // ownership, so we do not touch the wallet. The caller already renders it.
  const landed = writeBook([...book.rows.filter((r) => !(r.chainId === chainId && r.stepKey === stepKey)), claim], book.unknown, store)
  // ⚠ THE NULL-STORE PATH IS A RULED-PENDING EXCEPTION, NOT AN OVERSIGHT.
  // With NO store at all there is no cross-tab protection to be had, so
  // refusing does not prevent a double buy — it only stops privacy-mode users
  // trading. UIGuy pinned today's behaviour and the product half is an open
  // question on the owner's desk (2026-08-08): may a user knowingly trade
  // unprotected? Until he rules, this path answers exactly as it did.
  // A store that EXISTS and dropped the write is the opposite case and the one
  // the adversarial pass measured — there, ownership was claimed over nothing
  // and the next run bought again, so it refuses.
  if (!landed && store != null) return 'store-unreadable'
  // NO STORE AT ALL is the ruled case above: proceed, and tell the truth about
  // what is missing rather than claiming an exclusivity we cannot know.
  return store == null ? 'claimed-unprotected' : 'claimed'
}

/** Mark the claim this signer holds as AMBIGUOUS: the wallet was asked to
 *  submit and never answered clearly, so a transaction may be in flight with
 *  no id we could record. The mark is what stops the claim expiring into a
 *  takeover-and-retry at +90s (A6 review, 2026-08-07). Writes a fresh
 *  ambiguous claim if the row vanished (a lost heartbeat write must not
 *  demote the ambiguity to nothing). */
export function markClaimAmbiguous(
  chainId: number,
  stepKey: string,
  signer: Address,
  nowMs: number,
  store: Storage | null = storage(),
  /** The ladder rung the attempt reached, when the caller knows it. */
  rung?: number,
): boolean {
  const book = readBook(store)
  if (book.corrupt) return false // never write over what we cannot read
  const existing = book.rows.find((r) => r.chainId === chainId && r.stepKey === stepKey)
  // a real submission (an id exists) outranks the mark — nothing to do; and
  // another signer's row is not ours to touch
  if (existing && (existing.submissionId != null || existing.signer.toLowerCase() !== signer.toLowerCase())) return false
  // keep what the vanished/replaced row knew: the rung it reached, and any id
  // the wallet did hand back before the record failed to save (A6 verify pass
  // — dropping the id left the user told to "check your wallet activity"
  // without the one identifier that would let them)
  const mark: LiveSubmission = {
    chainId,
    stepKey,
    rung: existing?.rung ?? rung ?? 0,
    submissionId: null,
    signer,
    atMs: nowMs,
    ambiguous: true,
  }
  // ⚠⚠ CRITICAL — independent pass 2026-08-08 (SpectrumContracts). Both call
  // sites are INSIDE a catch for recordSubmission, and both functions validated
  // the SAME `nowMs`. So when the clock left the plausible window AFTER the
  // wallet had answered, recordSubmission threw, the catch ran, and this threw
  // again — **the recovery was skipped by the very failure it exists to
  // recover from**. Measured with money in flight: submit called once, zero
  // exec-log rows, the tx id nowhere, and a plain never-upgraded claim left
  // behind. That claim is PARSEABLE, so law 12 accepts it, sweepExpiredClaims
  // drops it at +90s, and THE NEXT RUN RE-SUBMITS AND REPORTS DONE. The atMs
  // theft needed an attacker to plant a stamp; this needs none.
  //
  // THE FLAG IS THE SAFETY PROPERTY; THE TIMESTAMP IS NOT. `ambiguous` is what
  // stops the sweep expiring this into a retry, and it does not need a fresh
  // clock to be true. So an unwritable stamp falls back to the stamp the
  // EXISTING row already carries — a value this module validated when it wrote
  // it — rather than losing the mark over the one field that is broken.
  // Refusing to restamp is not refusing to protect.
  const writable = (m: LiveSubmission) => parseRow(m as unknown as Stored) != null
  const candidate = writable(mark)
    ? mark
    : existing != null && writable({ ...mark, atMs: existing.atMs })
      ? { ...mark, atMs: existing.atMs }
      : null
  // AND IT RETURNS RATHER THAN THROWS, because every caller is a catch block:
  // a throw here does not report a second problem, it DELETES the handling of
  // the first. The caller must say so in words instead (execution-runner).
  if (candidate == null) return false
  return writeBook([...book.rows.filter((r) => !(r.chainId === chainId && r.stepKey === stepKey)), candidate], book.unknown, store)
}

/** Drop EXPIRED, NON-AMBIGUOUS claims — dead tabs' leftovers. Safe by the
 *  claim law itself (no id ever existed, so no money was sent), and needed
 *  because intent-bound keys made abandoned claims immortal: a replanned run
 *  almost never reuses the exact key, so each abnormal end leaked a row
 *  toward the corruption ceiling and a permanent refusal (A6 review,
 *  2026-08-07). Submissions and ambiguous claims are never touched — time
 *  resolves neither. */
export function sweepExpiredClaims(nowMs: number, store: Storage | null = storage()): void {
  const book = readBook(store)
  if (book.corrupt || book.unknown.length > 0) return // unknown rows: change nothing
  const kept = book.rows.filter(
    (r) => !(r.submissionId == null && r.ambiguous !== true && nowMs - r.atMs >= CLAIM_TTL_MS),
  )
  if (kept.length !== book.rows.length) writeBook(kept, book.unknown, store)
}

/** THE MANDATORY FIRST MOVE: the machine for (chain, step) starts from what
 *  the store remembers, never from a blank `idle`. A live record forces
 *  `submitted` — resolve first; `attempt` throws there by the reducer's own
 *  law, which is the point.
 *
 *  ⚠ This returns `idle` for BOTH "nothing recorded" and "records unreadable"
 *  — the caller must check `readSubmissions().dropped/corrupt` first, which is
 *  why the runner does exactly that before its first step (audit round 2). The
 *  ambiguity is kept OUT of the state type on purpose: SubmissionState is the
 *  ladder's vocabulary and an "unknown" phase there would need a transition in
 *  a reducer whose whole value is having no unsafe transitions. */
export function hydrateSubmission(chainId: number, stepKey: string, store: Storage | null = storage()): SubmissionState {
  const live = readAll(store).find((r) => r.chainId === chainId && r.stepKey === stepKey)
  // A CLAIM is not a submission: nothing was sent, so the machine stays `idle`
  // and the RUNNER decides via claimStep whether it may proceed. Reporting a
  // claim as `submitted` would make the runner poll an id that does not exist.
  if (live && live.submissionId != null) return { phase: 'submitted', rung: live.rung, submissionId: live.submissionId }
  return { phase: 'idle', rung: 0 }
}

/** Whose submission is this? The runner compares against the ACTIVE account and
 *  refuses to adopt another wallet's live money (half-2 finding 6's law, which
 *  was documented on the record's `signer` field but never enforced — audit
 *  round 2). Null when no record exists for that step. */
export function submissionSigner(chainId: number, stepKey: string, store: Storage | null = storage()): string | null {
  return readAll(store).find((r) => r.chainId === chainId && r.stepKey === stepKey)?.signer ?? null
}

// ── THE RULED FULL-CYCLE WINDOW (the owner 2026-08-13 — ask q-1786112477630-115
// closed; the standing 15-minute recommendation adopted verbatim; his ruling
// logged in the OS repo's decisions/LOG.md) ──────────────────────────────────
//
// A COMPLETED run resolves and clears its submission records — which is
// exactly why the claim law (runner law 13) cannot see the LAST double-buy
// window: a second tab sitting on an already-rendered confirm screen arms the
// SAME plan a minute after the first tab finished, and every record that
// could have warned it is gone, because the run ended cleanly. A completed
// full cycle now leaves a STAMP keyed by the plan's digest, and the runner's
// door refuses to arm an identical plan while the stamp is inside the window.
// Change the plan — amount, legs, anything the digest covers — and the digest
// changes with it: only the literal repeat is caught, which is the ruling.
//
// The stamp is deliberately NOT a LiveSubmission row: those mean "money may be
// in flight, only a terminal answer clears me"; this means "money finished
// moving, and finished RECENTLY". Collapsing the two vocabularies would give
// the reducer an unsafe transition, the exact thing it exists not to have.
export const RECENT_COMPLETION_WINDOW_MS = 15 * 60_000

const CYCLE_KEY = 'spectrum:completed-cycle:v1'
/** Per-STEP completion stamps (audit F5, 2026-08-13): a PARTIAL run resolves
 *  and CLEARS the records of its finished steps, and law 14 only stamps at a
 *  clean full `done` — so re-arming the identical plan after a partial would
 *  re-buy an already-completed step, guarded by neither law 13 (record gone)
 *  nor law 14 (no whole-plan stamp). Stamping each completed STEP closes that:
 *  the runner skips a step whose key completed inside the window. Separate map
 *  from the cycle stamps so step keys never evict plan digests or vice versa. */
const STEP_KEY = 'spectrum:completed-step:v1'
/** Newest-N cap — a browser that completes N distinct plans/steps inside one
 *  window is not a scenario; the cap only stops unbounded growth. Steps get a
 *  larger cap (a real multi-chain plan has several legs; 32 plans × a few legs). */
const MAX_CYCLE_ROWS = 32
const MAX_STEP_ROWS = 128

function readStamps(store: Storage | null, storeKey: string): Record<string, number> {
  if (!store) return {}
  try {
    const raw = store.getItem(storeKey)
    if (!raw) return {}
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, number> = {}
    for (const [k, at] of Object.entries(v as Record<string, unknown>)) {
      // the same plausibility law as atMs: garbage stamps read as no stamp,
      // never as a lock (a corrupt row must not brick arming forever)
      if (typeof k === 'string' && k.length > 0 && k.length <= MAX_STEP_KEY_LEN &&
          typeof at === 'number' && Number.isFinite(at) && at >= MIN_PLAUSIBLE_MS && at <= MAX_PLAUSIBLE_MS) {
        out[k] = at
      }
    }
    return out
  } catch {
    return {}
  }
}

function recordStamp(store: Storage | null, storeKey: string, id: string, atMs: number, cap: number): void {
  if (!store || !id || id.length > MAX_STEP_KEY_LEN) return
  if (!Number.isFinite(atMs) || atMs < MIN_PLAUSIBLE_MS || atMs > MAX_PLAUSIBLE_MS) return
  try {
    const stamps = readStamps(store, storeKey)
    stamps[id] = atMs
    const kept = Object.entries(stamps)
      .sort((a, b) => b[1] - a[1])
      .slice(0, cap)
    store.setItem(storeKey, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    /* quota/private mode — the guard loses one window, nothing else */
  }
}

function recentStampAt(store: Storage | null, storeKey: string, id: string, nowMs: number): number | null {
  const at = readStamps(store, storeKey)[id]
  if (at == null) return null
  if (!Number.isFinite(nowMs) || nowMs < at) return null // a rewound clock proves nothing
  return nowMs - at <= RECENT_COMPLETION_WINDOW_MS ? at : null
}

/** Stamp a COMPLETED full cycle. Best-effort by design: the runner only runs
 *  at all where persistence was proven at the door (its law 8), and a failed
 *  stamp write costs the guard one window, never the run its record. */
export function recordCycleCompletion(planDigest: string, atMs: number, store: Storage | null): void {
  recordStamp(store, CYCLE_KEY, planDigest, atMs, MAX_CYCLE_ROWS)
}

/** When did an identical plan last COMPLETE from this browser, if inside the
 *  ruled window? Null = no recent completion (or no readable stamp — an
 *  unreadable stamp is no stamp, never a lock). */
export function recentCycleCompletionAt(planDigest: string, nowMs: number, store: Storage | null): number | null {
  return recentStampAt(store, CYCLE_KEY, planDigest, nowMs)
}

/** Stamp ONE completed step (audit F5). Called wherever a step resolves to a
 *  terminal success — the money moved, and a re-arm of the same plan must not
 *  send it again inside the window. */
export function recordStepCompletion(stepKey: string, atMs: number, store: Storage | null): void {
  recordStamp(store, STEP_KEY, stepKey, atMs, MAX_STEP_ROWS)
}

/** When did THIS step last complete from this browser, if inside the window?
 *  The runner skips (marks done, never re-sends) a step this answers for. */
export function recentStepCompletionAt(stepKey: string, nowMs: number, store: Storage | null): number | null {
  return recentStampAt(store, STEP_KEY, stepKey, nowMs)
}
