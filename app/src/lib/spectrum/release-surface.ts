import type { Address } from 'viem'
import {
  CLAIM_TTL_MS,
  clearSubmission,
  liveSubmissions,
  quarantineUnknownRows,
  readQuarantineRaw,
  clearQuarantine,
  readSubmissions,
  type LiveSubmission,
} from './submission-store'
import { showChainId } from './safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// THE HUMAN RELEASE SURFACE's model (the go-live interlock's precondition:
// "dup:/ambiguous/quarantined records would have NO exit except
// clear-site-data, which destroys live records" — and submission-store's own
// header has pointed at this exact surface since 2026-08-07: "the mechanism
// behind an acknowledgment surface the panel does not have yet").
//
// WHAT THIS IS: the reading and the vocabulary for the panel that lets a HUMAN
// resolve what no run may resolve for them. The store's no-TTL law says only a
// human clears an unresolved submission; until now that human had no hands.
//
// LAWS:
//  · READ-ONLY BY DEFAULT — the surface lists and explains; every mutation is
//    a separate, named act the component must put behind an explicit confirm
//    that repeats the record's own facts.
//  · RELEASE IS THE HUMAN SAYING "I CHECKED". Releasing a record deletes the
//    double-buy guard for that step — the words say so, and the act goes
//    through clearSubmission's owner-checked path (adversarial-pass law:
//    nobody releases another wallet's record).
//  · NOTHING AUTOMATIC. No TTL, no auto-sweep on mount, no "clean up all".
//    quarantineUnknownRows and clearQuarantine run only from a click.
//  · FRESH CLAIMS ARE NOT STUCK. A claim inside its TTL is another tab
//    mid-prompt (runner law 13) and expires on its own; listing it would
//    invite a human to race themselves. Expired claims self-sweep at the
//    runner's door, so claims never appear here at all — only records that
//    genuinely wait on a human: submitted-unresolved, ambiguous, and the
//    quarantine's raw evidence.
// ─────────────────────────────────────────────────────────────────────────────

export type StuckKind = 'ambiguous' | 'submitted'

export interface StuckRecord {
  kind: StuckKind
  chainId: number
  stepKey: string
  submissionId: string | null
  signer: Address
  atMs: number
  /** The plain-words explanation the panel renders — what this record means
   *  and what releasing it forfeits. */
  words: string
  /** What the confirm must say before release is allowed. */
  releaseWarning: string
}

export interface ReleaseSurfaceState {
  records: StuckRecord[]
  /** Raw quarantined evidence (unparseable rows stashed by the store), or
   *  null when the quarantine is empty. */
  quarantineRaw: string | null
  /** Unknown rows still sitting IN the live book (they refuse every run —
   *  law 12) that a human may sweep to quarantine. */
  unknownRows: number
  /** The whole live book is unreadable — the sweep offer covers it. */
  corrupt: boolean
}

/** Read everything a human may need to resolve. Pure read; never mutates. */
export function readReleaseSurface(nowMs: number, store: Storage | null): ReleaseSurfaceState {
  const health = readSubmissions(store)
  const rows = liveSubmissions(store)
  const records: StuckRecord[] = []
  for (const r of rows) {
    const rec = classify(r, nowMs)
    if (rec) records.push(rec)
  }
  // oldest first — the longest-stuck record is the one the human came for
  records.sort((a, b) => a.atMs - b.atMs)
  return {
    // CAP THE RENDER (audit F6): a real run makes a handful of records; the
    // store's own HARD_MAX_ROWS=64 is the "something is wrong" ceiling, so the
    // panel never renders more than that many cards even if a tampered
    // localStorage carries thousands. The corrupt/unreadable banner below is
    // what speaks for a book past the ceiling — not one card per poisoned row.
    records: records.slice(0, 64),
    quarantineRaw: readQuarantineRaw(store),
    unknownRows: health.dropped,
    corrupt: health.corrupt,
  }
}

function classify(r: LiveSubmission, nowMs: number): StuckRecord | null {
  const chain = showChainId(r.chainId)
  const age = agoWords(nowMs - r.atMs)
  if (r.submissionId == null) {
    // A CLAIM. Fresh = another tab mid-prompt (never listed). Ambiguous = the
    // wallet was asked and never answered clearly — money MAY be in flight
    // with no id recorded; only a human who checked can say.
    if (r.ambiguous !== true) return null
    return {
      kind: 'ambiguous',
      chainId: r.chainId,
      stepKey: r.stepKey,
      submissionId: null,
      signer: r.signer,
      atMs: r.atMs,
      words:
        `The wallet was asked to sign on ${chain} ${age} and no clear answer came back. ` +
        `Check that wallet's activity on ${chain} first: if the transaction is there, it went through — keep this until you see it confirmed. ` +
        `If nothing is there, nothing was sent — release this and run again. Until then it simply keeps the same money from being sent twice.`,
      releaseWarning:
        `Release only after you've looked at the wallet's ${chain} activity and the transaction is not there.`,
    }
  }
  // SUBMITTED and unresolved: an id exists, no terminal answer was recorded
  // (the tab closed mid-poll, the RPC went dark…). A run will try to resolve
  // it on the next attempt; it appears here because the no-TTL law means it
  // otherwise waits forever if no run ever comes back.
  return {
    kind: 'submitted',
    chainId: r.chainId,
    stepKey: r.stepKey,
    submissionId: r.submissionId,
    signer: r.signer,
    atMs: r.atMs,
    words:
      `A transaction on ${chain} was submitted ${age} (id ${shortId(r.submissionId)}) and its result was never written down — ` +
      `it almost certainly confirmed or failed long ago. Running the same plan again checks it first, automatically.`,
    releaseWarning:
      `Release only after you've looked at the wallet's ${chain} activity and know how it ended — releasing forgets that this was ever sent.`,
  }
}

/** Release one record — the human's checked-wallet act. Owner-checked: the
 *  connected wallet must BE the record's signer (clearSubmission's own law;
 *  passing the signer through is what arms that check). Returns words for the
 *  panel, never a throw. */
export function releaseStuckRecord(
  rec: Pick<StuckRecord, 'chainId' | 'stepKey' | 'signer'>,
  connected: Address | undefined,
  store: Storage | null,
): { ok: boolean; words: string } {
  if (!connected || connected.toLowerCase() !== rec.signer.toLowerCase()) {
    return {
      ok: false,
      words: 'Only the wallet that signed this record can release it — connect that wallet first.',
    }
  }
  clearSubmission(rec.chainId, rec.stepKey, store, connected)
  const gone = !liveSubmissions(store).some(
    (r) => r.chainId === rec.chainId && r.stepKey === rec.stepKey,
  )
  return gone
    ? { ok: true, words: 'Released. The record is gone — and so is its double-buy protection for that step.' }
    : { ok: false, words: 'The store refused the release (it may be unwritable in this browser). Nothing changed.' }
}

/** Sweep unreadable rows out of the live book into quarantine — the human's
 *  named act behind law 12's refusals. Returns how many moved. */
export function sweepUnknownRows(store: Storage | null): number {
  return quarantineUnknownRows(store)
}

/** Discard the quarantine's raw evidence — offered only AFTER the panel has
 *  shown it (download/copy is the component's job before this runs). */
export function discardQuarantine(store: Storage | null): void {
  clearQuarantine(store)
}

/** True when the surface has anything for a human at all — the panel's
 *  self-hide read (a surface with nothing to say must say nothing). */
export function releaseSurfaceHasWork(nowMs: number, store: Storage | null): boolean {
  const s = readReleaseSurface(nowMs, store)
  return s.records.length > 0 || s.quarantineRaw != null || s.unknownRows > 0 || s.corrupt
}

function agoWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'at a time this device’s clock disagrees about'
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'moments ago'
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  return `${Math.floor(h / 24)} days ago`
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`
}

/** Re-exported so the panel states the claim-vs-stuck boundary in its own
 *  copy without restating the number (link-don't-restate). */
export { CLAIM_TTL_MS }
