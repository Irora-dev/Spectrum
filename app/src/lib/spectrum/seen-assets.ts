// ─────────────────────────────────────────────────────────────────────────────
// WHAT'S NEW IN YOUR BOOK (the owner 2026-08-06 12:58: "when you see a new position
// which detected it glows for the first time in your positions in the bento, so
// you can really see").
//
// The problem this answers is his own: a trencher buys across three chains all
// day and "genuinely has no clue what's being added where". A position that
// arrived since you last looked should announce itself once, then stop.
//
// DEVICE-LOCAL AND PER-WALLET. The ledger is a set of asset keys per anchor
// address, in localStorage — no server, no read, no cost. It is a record of
// what this browser has SHOWN you, which is exactly the question ("have I seen
// this before?"), and it must never be confused with when a token launched:
// that is the market's fact and lives on the tier.
//
// TWO RULES THAT KEEP IT HONEST:
//   · A FIRST-EVER LOAD MARKS EVERYTHING SEEN AND GLOWS NOTHING. Otherwise a
//     new browser lights every position you own as "new", which is both false
//     and useless — the signal is only worth anything if it is rare.
//   · A GLOW IS EARNED ONCE. The keys are committed as soon as they have been
//     shown, so a refresh does not re-announce the same arrival.
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = 'spectrum:seen-assets:v1:'

function keyFor(anchor: string): string {
  return `${PREFIX}${anchor.toLowerCase()}`
}

function read(anchor: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(keyFor(anchor))
    if (raw == null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.filter((k): k is string => typeof k === 'string'))
  } catch {
    // unreadable or unavailable storage: treated as "we have no record", which
    // the caller resolves to the safe branch (mark, glow nothing)
    return null
  }
}

function write(anchor: string, keys: Set<string>): void {
  try {
    // Bounded: a book of thousands of dust keys must not grow the record
    // without limit. Newest wins — the set is rebuilt from what is held now,
    // so anything sold simply falls out and would glow again if re-bought,
    // which is the honest answer to "have I seen this position before".
    const list = [...keys].slice(-2000)
    localStorage.setItem(keyFor(anchor), JSON.stringify(list))
  } catch {
    /* private browsing / quota: the glow just does not persist */
  }
}

export interface NewAssetsResult {
  /** Keys to light up — empty on a first-ever load, by design. */
  fresh: Set<string>
  /** True the first time this anchor is recorded (nothing glows). */
  firstRun: boolean
}

/**
 * Which of these keys this browser has never shown for this wallet — and
 * commit the whole current set as seen in the same breath.
 *
 * Called once per settled read, not per render: it WRITES.
 */
export function markSeenAndCollectNew(anchor: string | undefined, keys: readonly string[]): NewAssetsResult {
  const present = new Set(keys.filter((k) => typeof k === 'string' && k.length > 0))
  if (!anchor) return { fresh: new Set(), firstRun: false }
  const known = read(anchor)
  if (known == null) {
    // First time we have ever recorded this wallet on this device. Everything
    // it holds is "new" to the RECORD and none of it is new to the OWNER.
    write(anchor, present)
    return { fresh: new Set(), firstRun: true }
  }
  const fresh = new Set<string>()
  for (const k of present) if (!known.has(k)) fresh.add(k)
  // Commit on ANY drift, not only arrivals. The guard used to be
  // `fresh.size > 0`, which meant a sale alone never rewrote the record: a
  // sold asset stayed "seen" until an unrelated arrival forced a write, so
  // sell-then-re-buy never glowed — contradicting write()'s own bound
  // ("anything sold simply falls out and would glow again if re-bought").
  // No fresh keys ⇒ present ⊆ known, so a size mismatch is exactly
  // "something fell out"; equal sets still skip the write.
  if (fresh.size > 0 || known.size !== present.size) write(anchor, present)
  return { fresh, firstRun: false }
}

/** Forget this wallet's record — a fresh eye on the next load (used by tests
 *  and by anything that wants to replay the arrival). */
export function forgetSeen(anchor: string): void {
  try {
    localStorage.removeItem(keyFor(anchor))
  } catch {
    /* nothing to do */
  }
}
