import { describe, expect, it } from 'vitest'
import { pickBool, pickNumber, pickOne, readPrefs, writePrefs } from './view-prefs'

// view-prefs.ts remembers view state (QOL round 2026-08-05). Two things must
// hold or the page it feeds looks broken: a stale value never survives its
// options list, and no storage at all is just "no memory", never an exception.
// Vitest runs in the `node` environment (no DOM), so the default accessor sees no
// window — that IS the storage-unavailable case — and the injected fake covers
// the rest.
const fakeStorage = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m,
  }
}

const hostileStorage = () => ({
  getItem: (): string => {
    throw new Error('private browsing')
  },
  setItem: (): void => {
    throw new Error('quota exceeded')
  },
})

describe('storage access is best-effort', () => {
  it('reads nothing when there is no storage (private mode, SSR, node)', () => {
    expect(readPrefs('explore')).toEqual({})
    expect(readPrefs('explore', null)).toEqual({})
  })

  it('writes without throwing when there is no storage', () => {
    expect(() => writePrefs('explore', { view: 'creators' })).not.toThrow()
    expect(() => writePrefs('explore', { view: 'creators' }, null)).not.toThrow()
  })

  it('swallows a store that throws on both access paths', () => {
    const s = hostileStorage()
    expect(readPrefs('explore', s)).toEqual({})
    expect(() => writePrefs('explore', { view: 'creators' }, s)).not.toThrow()
  })

  it('round-trips under the spectrum namespace', () => {
    const s = fakeStorage()
    writePrefs('explore', { view: 'baskets', chain: 8453 }, s)
    expect(readPrefs('explore', s)).toEqual({ view: 'baskets', chain: 8453 })
    expect([...s.raw.keys()]).toEqual(['spectrum:view-prefs:v1:explore'])
  })

  it('merges a patch, so a key this visit could not validate survives', () => {
    const s = fakeStorage()
    writePrefs('explore', { view: 'baskets', tag: 'ai' }, s)
    writePrefs('explore', { view: 'creators' }, s) // tag omitted on purpose
    expect(readPrefs('explore', s)).toEqual({ view: 'creators', tag: 'ai' })
  })

  it('keeps surfaces apart', () => {
    const s = fakeStorage()
    writePrefs('explore', { view: 'baskets' }, s)
    writePrefs('portfolio', { view: 'creators' }, s)
    expect(readPrefs('explore', s)).toEqual({ view: 'baskets' })
  })
})

describe('a stored blob is hostile input', () => {
  it('falls back to empty on junk, an array, or a bare value', () => {
    for (const raw of ['not json at all', '[1,2,3]', '"creators"', 'null', '42']) {
      const s = fakeStorage()
      s.raw.set('spectrum:view-prefs:v1:explore', raw)
      expect(readPrefs('explore', s)).toEqual({})
    }
  })
})

describe('restoring is validated against the LIVE options', () => {
  const lenses = ['thesis', 'baskets', 'creators'] as const

  it('takes a value that is still an option', () => {
    expect(pickOne('creators', lenses)).toBe('creators')
  })

  it('drops a tab that no longer exists, so the default wins', () => {
    // e.g. an operator switched the bundles tab off since the last visit
    expect(pickOne('bundles', lenses)).toBeNull()
  })

  it('drops non-strings and empty option lists', () => {
    expect(pickOne(7, lenses)).toBeNull()
    expect(pickOne(null, lenses)).toBeNull()
    expect(pickOne(undefined, lenses)).toBeNull()
    expect(pickOne({ view: 'creators' }, lenses)).toBeNull()
    expect(pickOne('creators', [])).toBeNull()
  })

  it('drops a chain that has no baskets today (an empty page reads as broken)', () => {
    expect(pickNumber(8453, [1, 8453])).toBe(8453)
    expect(pickNumber(8453, [1])).toBeNull()
    expect(pickNumber(8453, [])).toBeNull()
  })

  it('drops number lookalikes and non-finite values', () => {
    expect(pickNumber('8453', [1, 8453])).toBeNull()
    expect(pickNumber(NaN, [1, 8453])).toBeNull()
    expect(pickNumber(Infinity, [1, 8453])).toBeNull()
  })

  it('takes only real booleans', () => {
    expect(pickBool(true)).toBe(true)
    expect(pickBool(false)).toBe(false)
    expect(pickBool('true')).toBeNull()
    expect(pickBool(1)).toBeNull()
    expect(pickBool(undefined)).toBeNull()
  })
})
