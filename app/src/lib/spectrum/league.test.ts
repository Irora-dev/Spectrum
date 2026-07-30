import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { buildStandings } from './league'

const A = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa' as Address
const B = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb' as Address
const C = '0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc' as Address

// The league is a LIVE STREAM to the crown-holder (contract f71ef4b): no pot, no
// season-end settlement. Scores reset every 30 days but the CROWN PERSISTS, so
// the single most important property here is that the crown comes from the
// contract and is never inferred from rank — at a season's opening the incumbent
// holds the crown while every score, including theirs, is 0.
describe('league leaderboard (stream model)', () => {
  it('orders by score descending and marks the CONTRACT champion, not rank 0', () => {
    const s = buildStandings(
      [
        { creator: B, credited: 100n },
        { creator: A, credited: 400n },
        { creator: C, credited: 250n },
      ],
      C, // the contract says C holds the crown even though A leads on score
      250n,
    )
    expect(s.map((r) => r.creator.toLowerCase())).toEqual([A.toLowerCase(), C.toLowerCase(), B.toLowerCase()])
    expect(s.filter((r) => r.leader)).toHaveLength(1)
    expect(s.find((r) => r.leader)!.creator.toLowerCase()).toBe(C.toLowerCase())
  })

  it('season opening: the incumbent keeps the crown while every score is 0', () => {
    const s = buildStandings([{ creator: A, credited: 0n }], A, 0n)
    expect(s).toHaveLength(1)
    expect(s[0].leader).toBe(true)
    expect(s[0].toBeat).toBe(0n)
  })

  it('puts the champion on the board even with no score this season', () => {
    const s = buildStandings([{ creator: A, credited: 500n }], B, 0n)
    expect(s).toHaveLength(2)
    expect(s.find((r) => r.creator.toLowerCase() === B.toLowerCase())?.leader).toBe(true)
  })

  it('toBeat needs to STRICTLY exceed the champion — matching is not enough', () => {
    const s = buildStandings(
      [
        { creator: A, credited: 300n },
        { creator: B, credited: 100n },
      ],
      A,
      300n,
    )
    const b = s.find((r) => r.creator.toLowerCase() === B.toLowerCase())!
    expect(b.toBeat).toBe(201n) // 100 + 201 = 301 > 300
    expect(s.find((r) => r.leader)!.toBeat).toBe(0n) // the champion needs nothing
  })

  it('a challenger already above the champion owes nothing more', () => {
    const s = buildStandings([{ creator: A, credited: 900n }], B, 400n)
    expect(s.find((r) => r.creator.toLowerCase() === A.toLowerCase())!.toBeat).toBe(0n)
  })

  it('dedupes case-variant creators', () => {
    const s = buildStandings(
      [
        { creator: A, credited: 150n },
        { creator: A.toLowerCase() as Address, credited: 150n },
        { creator: B, credited: 200n },
      ],
      B,
      200n,
    )
    expect(s).toHaveLength(2)
    expect(s[0].creator.toLowerCase()).toBe(B.toLowerCase())
  })

  it('no champion yet → nobody wears the crown', () => {
    const s = buildStandings([{ creator: A, credited: 10n }], null, 0n)
    expect(s.some((r) => r.leader)).toBe(false)
  })

  it('empty board stays empty', () => {
    expect(buildStandings([], null, 0n)).toEqual([])
  })
})
