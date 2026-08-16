import { describe, expect, it } from 'vitest'
import { freshLabel, msUntilLabelChange } from './FreshDot'

// The freshness caption is the only place this kit puts a TIME next to a money
// figure, and the owner's whole reason for it (2026-08-05) is that a stale read
// was indistinguishable from a fresh one. So the wording is a promise, and these
// pin it: plain words, real granularity, and nothing that could read as a claim
// about a read that never happened.
describe('freshLabel', () => {
  it('says "just now" for anything under a minute', () => {
    for (const ms of [0, 1, 999, 30_000, 59_999]) expect(freshLabel(ms)).toBe('just now')
  })

  it('counts whole minutes up to an hour', () => {
    expect(freshLabel(60_000)).toBe('read 1 min ago')
    expect(freshLabel(119_999)).toBe('read 1 min ago')
    expect(freshLabel(20 * 60_000)).toBe('read 20 min ago')
    expect(freshLabel(59 * 60_000)).toBe('read 59 min ago')
  })

  it('rolls over to hours and days rather than printing 430 min', () => {
    // Nothing polls these reads while a tab sits idle, so an hours-old read is
    // a real state — not a hypothetical.
    expect(freshLabel(60 * 60_000)).toBe('read 1 hour ago')
    expect(freshLabel(7 * 60 * 60_000 + 10 * 60_000)).toBe('read 7 hours ago')
    expect(freshLabel(24 * 60 * 60_000)).toBe('read 1 day ago')
    expect(freshLabel(3 * 24 * 60 * 60_000)).toBe('read 3 days ago')
  })

  it('never prints a future or nonsense read', () => {
    // A machine whose clock drifted behind the node's produces a negative age.
    for (const ms of [-1, -60_000, Number.NaN, Number.POSITIVE_INFINITY])
      expect(freshLabel(ms)).toBe('just now')
  })

  it('stays plain words: no em dashes, no jargon punctuation', () => {
    for (const ms of [0, 60_000, 90 * 60_000, 5 * 24 * 60 * 60_000])
      expect(freshLabel(ms)).toMatch(/^[a-z0-9 ]+$/)
  })
})

// The label must live-update without a render storm: one timer per VISIBLE
// change. These pin that the sleep lands ON the next boundary — too short is the
// storm we are avoiding, too long shows a caption that has gone wrong.
describe('msUntilLabelChange', () => {
  it('waits for the just-now boundary', () => {
    expect(msUntilLabelChange(0)).toBe(60_000)
    expect(msUntilLabelChange(59_000)).toBe(1_000)
  })

  it('waits for the next whole minute, then the next whole hour', () => {
    expect(msUntilLabelChange(90_000)).toBe(30_000)
    expect(msUntilLabelChange(60 * 60_000 + 90_000)).toBe(60 * 60_000 - 90_000)
  })

  it('waits for the next whole day past a day old', () => {
    const day = 24 * 60 * 60_000
    expect(msUntilLabelChange(day)).toBe(day)
    expect(msUntilLabelChange(day + 1_000)).toBe(day - 1_000)
  })

  it('never returns a non-positive wait, whatever it is handed', () => {
    for (const ms of [-5_000, Number.NaN, Number.POSITIVE_INFINITY])
      expect(msUntilLabelChange(ms)).toBeGreaterThan(0)
  })

  it('lands on a real boundary: sleeping that long always changes the caption', () => {
    const ages = [0, 45_000, 60_000, 61_000, 3_599_000, 3_600_000, 90 * 60_000, 25 * 60 * 60_000]
    for (const age of ages) {
      const wait = msUntilLabelChange(age)
      expect(freshLabel(age + wait)).not.toBe(freshLabel(age))
      // and not a millisecond sooner than it had to wake
      expect(freshLabel(age + wait - 1)).toBe(freshLabel(age))
    }
  })
})
