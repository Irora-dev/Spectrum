// ─────────────────────────────────────────────────────────────────────────────
// Remembered view preferences — the "where you were" layer (QOL round
// 2026-08-05: nothing on the site remembered a view, so whoever always reads
// Base re-picked the chip twice a day). One JSON blob per surface under the
// house `spectrum:` namespace, holding VIEW state only: which lens, which
// chain chip, which tag, which card face.
//
// Not stored, on purpose: the search box (a query typed yesterday quietly
// filtering today's page reads as a broken site, and it is not a preference),
// and anything that comes from a wallet or its holdings.
//
// Posture is persist-cache.ts / allocation.ts's: storage is reached through one
// guarded accessor, every read and write is try/catch-wrapped, an absent or
// hostile store degrades to "no memory", and nothing here throws to the caller.
// A preference is a convenience, never load-bearing.
//
// Reading back is VALIDATED, never trusted: localStorage is hand-editable and
// yesterday's chain or tag may not exist today. The pick* helpers check a stored
// value against the options that are LIVE on the page and return null when it no
// longer fits, so a stale preference falls back to the default instead of
// filtering everything out — an empty page looks like a broken deployment.
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = 'spectrum:view-prefs:v1:'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** One surface's stored blob. Values are `unknown` by design: they came from
 *  storage, so nothing may be believed before a pick* call vets it. */
export type StoredPrefs = Record<string, unknown>

function safeStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null // private browsing throws on the property itself
  }
}

/** Everything remembered for one surface — `{}` when there is nothing usable. */
export function readPrefs(surface: string, storage: StorageLike | null = safeStorage()): StoredPrefs {
  if (!storage) return {}
  try {
    const raw = storage.getItem(PREFIX + surface)
    if (!raw) return {}
    const v: unknown = JSON.parse(raw)
    // An array or a bare string parses fine and would break every read below.
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as StoredPrefs) : {}
  } catch {
    return {}
  }
}

/** Merge a patch into the surface's blob. Merging (not replacing) is the point:
 *  a caller that cannot validate one key this visit simply leaves it out, and
 *  the remembered value survives instead of being erased. */
export function writePrefs(surface: string, patch: StoredPrefs, storage: StorageLike | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.setItem(PREFIX + surface, JSON.stringify({ ...readPrefs(surface, storage), ...patch }))
  } catch {
    /* quota / blocked — the visit still works, it just won't be remembered */
  }
}

/** A stored string counts only while it is still one of the live options. */
export function pickOne<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : null
}

/** Same, for ids (a chain that no longer has baskets must not filter the page). */
export function pickNumber<T extends number>(raw: unknown, allowed: readonly T[]): T | null {
  return typeof raw === 'number' && Number.isFinite(raw) && (allowed as readonly number[]).includes(raw)
    ? (raw as T)
    : null
}

/** A real boolean or nothing — `"true"`, `1` and friends are not booleans. */
export function pickBool(raw: unknown): boolean | null {
  return raw === true || raw === false ? raw : null
}
