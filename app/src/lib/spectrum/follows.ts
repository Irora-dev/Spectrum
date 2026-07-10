import { useSyncExternalStore } from 'react'
import { isAddress } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Client-local creator follows — a browser-only convenience set of deployer
// addresses. This is the ONLY posture-safe shape for a "social graph" here: the
// FE is keyless + fully static with NO server, so a follow must live in the
// user's own browser, never a platform DB, never a cookie, never synced. There is
// deliberately NO who-to-follow / suggested / popular surface (that would be the
// curated-store anti-pattern). Empty by default; never seeds any address.
// State never leaves the browser.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum:follows:v1'
const EVT = 'spectrum:follows-changed'

const norm = (addr: string | null | undefined): string | null => {
  const a = (addr ?? '').trim()
  return a && isAddress(a, { strict: false }) ? a.toLowerCase() : null
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
    /* storage full / unavailable — follows are best-effort */
  }
  // Notify same-tab subscribers (the `storage` event only fires in OTHER tabs).
  try {
    window.dispatchEvent(new Event(EVT))
  } catch {
    /* non-DOM */
  }
}

/** Lowercased deployer addresses the user follows in this browser. */
export function getFollows(): string[] {
  return read()
}

export function isFollowing(addr: string | null | undefined): boolean {
  const a = norm(addr)
  return a ? read().includes(a) : false
}

/** Toggle follow for a deployer address. No-op on a non-address. */
export function toggleFollow(addr: string | null | undefined): void {
  const a = norm(addr)
  if (!a) return
  const cur = read()
  write(cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a])
}

// ── React binding ────────────────────────────────────────────────────────────
// useSyncExternalStore needs a referentially-STABLE snapshot when nothing changed
// (else it re-renders forever). Cache the parsed Set keyed by the raw string, so
// snapshot() returns the same Set ref until the stored value actually changes.
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

export interface UseFollows {
  /** Lowercased addresses followed in this browser. */
  follows: ReadonlySet<string>
  count: number
  isFollowing: (addr: string | null | undefined) => boolean
  toggle: (addr: string | null | undefined) => void
}

/** Subscribe a component to the local follow set; re-renders on any change. */
export function useFollows(): UseFollows {
  const follows = useSyncExternalStore(subscribe, snapshot, () => EMPTY)
  return {
    follows,
    count: follows.size,
    isFollowing: (addr) => {
      const a = norm(addr)
      return a ? follows.has(a) : false
    },
    toggle: toggleFollow,
  }
}
