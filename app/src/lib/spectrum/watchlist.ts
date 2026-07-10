import { useSyncExternalStore } from 'react'
import { isAddress } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Client-local basket watchlist — the basket-side sibling of follows.ts (which
// tracks creator/deployer addresses). Same posture: the FE is keyless + fully
// static with NO server, so a watch lives in the user's own browser, never a
// platform DB, never a cookie, never synced. Empty by default; never seeds any
// basket. State never leaves the browser.
//
// Keys are `${chainId}:${address}` — a basket address is chain-scoped (follows
// are not: a deployer wallet is the same entity on every chain).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum:watchlist:v1'
const EVT = 'spectrum:watchlist-changed'

const norm = (chainId: number, addr: string | null | undefined): string | null => {
  const a = (addr ?? '').trim()
  if (!a || !isAddress(a, { strict: false })) return null
  if (!Number.isInteger(chainId) || chainId <= 0) return null
  return `${chainId}:${a.toLowerCase()}`
}

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function write(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage full / unavailable — watches are best-effort */
  }
  // Notify same-tab subscribers (the `storage` event only fires in OTHER tabs).
  try {
    window.dispatchEvent(new Event(EVT))
  } catch {
    /* non-DOM */
  }
}

/** `chainId:address` keys watched in this browser. */
export function getWatchlist(): string[] {
  return read()
}

export function isWatched(chainId: number, addr: string | null | undefined): boolean {
  const k = norm(chainId, addr)
  return k ? read().includes(k) : false
}

/** Toggle watch for a basket. No-op on a non-address. */
export function toggleWatch(chainId: number, addr: string | null | undefined): void {
  const k = norm(chainId, addr)
  if (!k) return
  const cur = read()
  write(cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k])
}

// ── React binding ────────────────────────────────────────────────────────────
// Same stable-snapshot pattern as follows.ts: cache the parsed Set keyed by the
// raw string so snapshot() returns the same ref until the value actually changes.
let rawCache: string | null = null
let setCache: ReadonlySet<string> = new Set()
const EMPTY: ReadonlySet<string> = new Set()

function snapshot(): ReadonlySet<string> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return EMPTY
  }
  if (raw !== rawCache) {
    rawCache = raw
    setCache = new Set(read())
  }
  return setCache
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVT, cb)
    window.removeEventListener('storage', cb)
  }
}

export interface UseWatchlist {
  /** `chainId:address` keys watched in this browser. */
  watched: ReadonlySet<string>
  count: number
  isWatched: (chainId: number, addr: string | null | undefined) => boolean
  toggle: (chainId: number, addr: string | null | undefined) => void
}

/** Subscribe a component to the local watchlist; re-renders on any change. */
export function useWatchlist(): UseWatchlist {
  const watched = useSyncExternalStore(subscribe, snapshot, () => EMPTY)
  return {
    watched,
    count: watched.size,
    isWatched: (chainId, addr) => {
      const k = norm(chainId, addr)
      return k ? watched.has(k) : false
    },
    toggle: toggleWatch,
  }
}
