// A localStorage adapter for the MV3 service worker, which has no `window`.
//
// The shared lib's persist-cache.ts (and modules built on it: token-meta's
// extracted colors, basket-data's block-scan checkpoints, Coingecko lookups)
// call `window.localStorage` synchronously. In a service worker those calls
// land in persist-cache's own try/catch and silently degrade to "no cache" —
// nothing crashes, but every poll would then re-spend the whole discovery +
// pricing budget from scratch, which is exactly the RPC burn the extension
// must not have.
//
// So: an in-memory Map that implements the localStorage surface the lib uses,
// installed as `window.localStorage` BEFORE any lib module is imported
// (install is synchronous; lib modules run cache reads at import time), then
// hydrated from chrome.storage.local and written back through it. The popup
// has a real window and never needs this.

const BACKING_KEY = 'lscache/v1'
const FLUSH_DELAY_MS = 250

const mem = new Map<string, string>()
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | undefined
let hydrated: Promise<void> | undefined

function scheduleFlush(): void {
  dirty = true
  if (flushTimer !== undefined) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void flushLocalStorageShim()
  }, FLUSH_DELAY_MS)
}

/** Write pending shim state to chrome.storage.local now (poll end calls this
 *  so a service worker killed right after still keeps its caches). */
export async function flushLocalStorageShim(): Promise<void> {
  if (!dirty) return
  dirty = false
  const flat: Record<string, string> = {}
  for (const [k, v] of mem) flat[k] = v
  try {
    await chrome.storage.local.set({ [BACKING_KEY]: flat })
  } catch {
    dirty = true // quota — retry on the next flush; the cache stays best-effort
  }
}

const storageLike = {
  getItem(key: string): string | null {
    return mem.has(key) ? (mem.get(key) as string) : null
  },
  setItem(key: string, value: string): void {
    mem.set(key, String(value))
    scheduleFlush()
  },
  removeItem(key: string): void {
    if (mem.delete(key)) scheduleFlush()
  },
  clear(): void {
    mem.clear()
    scheduleFlush()
  },
  key(i: number): string | null {
    return [...mem.keys()][i] ?? null
  },
  get length(): number {
    return mem.size
  },
}

/** Synchronous: give the worker a `window.localStorage` (and bare
 *  `localStorage`) before any shared-lib module evaluates. Call at the very
 *  top of the service-worker entry. */
export function installLocalStorageShim(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g.window === 'undefined') g.window = globalThis
  const w = g.window as Record<string, unknown>
  if (!w.localStorage) w.localStorage = storageLike
  if (typeof g.localStorage === 'undefined') g.localStorage = storageLike
}

/** Load persisted cache entries into the in-memory map (idempotent; awaited
 *  before the first lib use so TTL caches survive service-worker restarts). */
export function hydrateLocalStorageShim(): Promise<void> {
  hydrated ??= (async () => {
    try {
      const got = await chrome.storage.local.get(BACKING_KEY)
      const flat = got[BACKING_KEY] as Record<string, string> | undefined
      if (flat) {
        for (const [k, v] of Object.entries(flat)) {
          if (!mem.has(k)) mem.set(k, v) // live writes win over hydrated state
        }
      }
    } catch {
      // best-effort cache — an unreadable backing store just means cold caches
    }
  })()
  return hydrated
}
