import { beforeEach, describe, expect, it } from 'vitest'
import { __resetLastSeenForTests, readLastSeen, stampLastSeen } from './last-seen'

const fakeStorage = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe('last-seen (16:4x feature 4) — the remount-proof stamp', () => {
  beforeEach(() => __resetLastSeenForTests())

  it('a remount after stamping still reads the PREVIOUS visit (the veil-clobber bug)', () => {
    const s = fakeStorage()
    s.setItem('spectrum:lastseen:0xabc', '1000')
    // veiled first mount: read then stamp
    expect(readLastSeen('0xAbC', s)).toBe(1000)
    stampLastSeen('0xabc', 5000, s)
    // the reveal's remount reads again — and must still see 1000, not 5000
    expect(readLastSeen('0xABC', s)).toBe(1000)
    // next SESSION (caches reset) sees this visit
    __resetLastSeenForTests()
    expect(readLastSeen('0xabc', s)).toBe(5000)
  })

  it('stamps once per session, and stamping without a prior read still preserves the answer', () => {
    const s = fakeStorage()
    s.setItem('spectrum:lastseen:0xabc', '1000')
    stampLastSeen('0xabc', 5000, s) // no explicit read first
    expect(readLastSeen('0xabc', s)).toBe(1000) // the stamp cached it before writing
    stampLastSeen('0xabc', 9000, s) // second stamp same session: ignored
    __resetLastSeenForTests()
    expect(readLastSeen('0xabc', s)).toBe(5000)
  })

  it('first-ever visit reads null and junk reads as null', () => {
    const s = fakeStorage()
    expect(readLastSeen('0xabc', s)).toBeNull()
    __resetLastSeenForTests()
    s.setItem('spectrum:lastseen:0xdef', 'garbage')
    expect(readLastSeen('0xdef', s)).toBeNull()
  })
})
