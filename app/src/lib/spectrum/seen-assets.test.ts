import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetSeen, markSeenAndCollectNew } from './seen-assets'

// The module reads the bare `localStorage` global per call (no module-level
// cache), so a Map-backed stub exercises real persistence — the wallet-links
// suite's pattern.
function fakeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => void m.clear(),
    key: () => null,
    get length() {
      return m.size
    },
    _map: m,
  }
}

const ANCHOR = '0xAbCd' // mixed case on purpose: the record's key folds it
const KEY = 'spectrum:seen-assets:v1:0xabcd'

let storage: ReturnType<typeof fakeStorage>
beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
})
afterEach(() => vi.unstubAllGlobals())

describe('seen-assets — a glow is "this browser has not shown you this position"', () => {
  it('a first-ever load marks everything seen and glows nothing', () => {
    const r = markSeenAndCollectNew(ANCHOR, ['a', 'b'])
    expect(r.firstRun).toBe(true)
    expect(r.fresh.size).toBe(0)
    // and the record committed: the same book re-read still glows nothing
    const again = markSeenAndCollectNew(ANCHOR, ['a', 'b'])
    expect(again.firstRun).toBe(false)
    expect(again.fresh.size).toBe(0)
  })

  it('an arrival glows once, then is committed', () => {
    markSeenAndCollectNew(ANCHOR, ['a'])
    expect([...markSeenAndCollectNew(ANCHOR, ['a', 'b']).fresh]).toEqual(['b'])
    expect(markSeenAndCollectNew(ANCHOR, ['a', 'b']).fresh.size).toBe(0)
  })

  it('sold then re-bought glows again — a sale ALONE must rewrite the record', () => {
    markSeenAndCollectNew(ANCHOR, ['a', 'b']) // first run: both known
    // b is sold. Nothing new arrived, but the record must shed b on the read
    // that shows the sale (the write-side bound: "anything sold simply falls
    // out and would glow again if re-bought") — not wait for an unrelated
    // arrival to force a rewrite.
    expect(markSeenAndCollectNew(ANCHOR, ['a']).fresh.size).toBe(0)
    expect(JSON.parse(storage._map.get(KEY)!)).toEqual(['a'])
    // b re-bought: genuinely fresh again
    expect([...markSeenAndCollectNew(ANCHOR, ['a', 'b']).fresh]).toEqual(['b'])
  })

  it('forgetSeen clears the record: the next load is a first run again', () => {
    markSeenAndCollectNew(ANCHOR, ['a'])
    forgetSeen(ANCHOR)
    const r = markSeenAndCollectNew(ANCHOR, ['a'])
    expect(r.firstRun).toBe(true)
    expect(r.fresh.size).toBe(0)
  })
})
