import type { StorageLike } from './allocation'

// ─────────────────────────────────────────────────────────────────────────────
// LAST SEEN (16:4x feature 4) — the previous visit's stamp, with one subtlety
// that bit on the first live probe: the portfolio REMOUNTS after the intro's
// veil lifts (the reveal's key flip), and a naive read-then-stamp had the
// veiled first mount overwrite the stamp before the real page ever read it —
// the previous visit was destroyed by the act of arriving. So the first read
// per session is CACHED per scope and every remount gets that same answer,
// and the stamp writes once per session, after the read is safely cached.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = (addr: string) => `spectrum:lastseen:${addr.toLowerCase()}`

let readCache: Record<string, number | null> = {}
let stamped: Record<string, boolean> = {}

function safeStorage(): StorageLike | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The previous visit's timestamp (ms), stable for the whole session however
 *  many times the page remounts. Null on a first-ever visit. */
export function readLastSeen(addr: string, storage: StorageLike | null = safeStorage()): number | null {
  if (!addr) return null
  const k = addr.toLowerCase()
  if (k in readCache) return readCache[k]
  let v: number | null = null
  try {
    const raw = storage?.getItem(KEY(addr))
    const n = raw ? Number(raw) : NaN
    v = Number.isFinite(n) && n > 0 ? n : null
  } catch {
    v = null
  }
  readCache[k] = v
  return v
}

/** Stamp this visit — once per scope per session, and only after a read has
 *  cached the previous value (calling order is enforced here, not by hope). */
export function stampLastSeen(addr: string, now: number = Date.now(), storage: StorageLike | null = safeStorage()): void {
  if (!addr) return
  const k = addr.toLowerCase()
  if (stamped[k]) return
  readLastSeen(addr, storage) // cache the previous value first, always
  stamped[k] = true
  try {
    storage?.setItem(KEY(addr), String(now))
  } catch {
    /* private browsing: the stamp simply does not persist */
  }
}

/** Test seam. */
export function __resetLastSeenForTests(): void {
  readCache = {}
  stamped = {}
}
