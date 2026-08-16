// ─────────────────────────────────────────────────────────────────────────────
// THE FAILURE LOG — a small ring buffer of the last few refusals, recorded
// WITHOUT anyone deciding to record them.
//
// ⚠ WHY THIS EXISTS, and it is worth stating because a log is easy to dismiss
// as bookkeeping: on 2026-08-15 a single refusal took an entire evening and
// FIVE failed reproductions to diagnose, because every reconstruction of the
// owner's trade succeeded while his kept failing. What finally cracked it was
// one paste of the actual run's state. The evidence had existed each time and
// had been thrown away each time.
//
// A capture that requires someone to press a button in the moment is a capture
// you get on the second occurrence at best — and by then the state that
// mattered (the signer, the sizes, the block) is gone. So this records every
// refusal as it happens and keeps the last few.
//
// WHAT IT DELIBERATELY DOES NOT HOLD: no keys, no calldata, no signatures, no
// balances beyond the plan figures already on screen. A diagnostic that carries
// secrets becomes a thing you cannot paste to anyone, which defeats its only
// purpose. Everything here is already visible to the person looking at the
// refusal — it is the ASSEMBLY of it that is valuable, not the secrecy.
//
// Storage is best-effort: a private-mode browser with no localStorage still
// gets the in-memory ring for this session, because a diagnostic that throws
// while recording a failure would be a bitter joke.
// ─────────────────────────────────────────────────────────────────────────────

/** How many refusals to keep. Small on purpose: the useful window is "the one
 *  that just happened and the couple before it", and an unbounded log in
 *  localStorage is a slow leak nobody audits. */
export const FAILURE_LOG_LIMIT = 8

const KEY = 'spectrum:failures'

export interface FailureRecord {
  /** ISO timestamp, supplied by the caller so this module stays pure-ish and
   *  testable without faking a clock. */
  at: string
  /** Where it happened, in one short phrase ('portfolio run', 'first deposit'). */
  surface: string
  /** The address that would have signed. The single most diagnostic field:
   *  a plan sized against one wallet and signed by another is a real failure
   *  mode here, and it is invisible in the message. */
  signer: string | null
  chainId: number | null
  /** The user-facing sentence, verbatim — never a summary of it. */
  message: string
  /** Anything the surface knows that the message does not: leg sizes, phase,
   *  step statuses. Free-form because each surface knows different things;
   *  serialised defensively so an exotic value cannot break the record. */
  detail?: Record<string, unknown>
}

let memory: FailureRecord[] = []

/** bigint and friends are ordinary in this codebase and fatal to JSON.stringify
 *  — a logger that throws on the very values it exists to capture is worse than
 *  no logger. Everything unserialisable degrades to a string. */
function safe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  if (depth >= 4) return '…'
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => safe(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) out[k] = safe(v, depth + 1)
    return out
  }
  return String(value)
}

function read(): FailureRecord[] {
  if (memory.length > 0) return memory
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    // hostile input: the store is user-writable, so a non-array or a row of the
    // wrong shape must yield an empty log, never a crash on a failure surface
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r): r is FailureRecord => !!r && typeof r === 'object' && typeof (r as FailureRecord).message === 'string')
  } catch {
    return []
  }
}

/** Record one refusal. Never throws — it is called from failure paths. */
export function recordFailure(rec: FailureRecord): void {
  try {
    const row: FailureRecord = {
      at: rec.at,
      surface: rec.surface,
      signer: rec.signer ?? null,
      chainId: rec.chainId ?? null,
      message: String(rec.message ?? ''),
      ...(rec.detail ? { detail: safe(rec.detail) as Record<string, unknown> } : {}),
    }
    // NEWEST FIRST, so the one that just happened is the one you read.
    memory = [row, ...read()].slice(0, FAILURE_LOG_LIMIT)
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(memory))
    } catch {
      // quota, private mode, or no storage at all — the in-memory ring stands
    }
  } catch {
    // a logger that can fail a run is not worth having
  }
}

export function readFailures(): FailureRecord[] {
  return read()
}

export function clearFailures(): void {
  memory = []
  try {
    globalThis.localStorage?.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}

/** The paste-ready form. One JSON blob, newest first — what a person hands to
 *  whoever is diagnosing, with no editing required. */
export function failuresAsText(): string {
  return JSON.stringify(read(), null, 2)
}
