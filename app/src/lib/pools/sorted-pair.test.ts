import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { sortedPair } from './find-best-pool'

// ─────────────────────────────────────────────────────────────────────────────
// THE PAIR ON A CANDIDATE IS AN IDENTITY ANCHOR, NOT A CONVENIENCE FIELD.
// A safety screen's one real check is "is one side the token the user actually
// asked for, BY ADDRESS, and is the other side a canonical quote asset" —
// symbol matching is what lets a scam token wear a real tile. So the ordering
// has to be right for the same reason the addresses do.
//
// The trap this pins: an Ethereum address's CASE is EIP-55 checksum
// information, not value. Two spellings of one address are the same address,
// but they are NOT the same string, and '0xA…' < '0xa…' in JS string order
// because uppercase letters sort before lowercase. A raw a < b comparison would
// therefore order the same pair differently depending on which spelling each
// side happened to arrive in — silently swapping token0 and token1.
// ─────────────────────────────────────────────────────────────────────────────

// deliberately chosen so the two differ in a HEX LETTER, where case exists
const LOW = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
const HIGH = '0xffffffffffffffffffffffffffffffffffffffff' as const

describe('sortedPair — the venue ordering', () => {
  it('puts the numerically lower address first, whichever way it is handed in', () => {
    expect(sortedPair(LOW, HIGH)).toEqual({ token0: LOW, token1: HIGH })
    expect(sortedPair(HIGH, LOW)).toEqual({ token0: LOW, token1: HIGH })
  })

  it('orders IDENTICALLY regardless of the case each side arrives in — the real trap', () => {
    // the same two addresses, spelled four ways. A case-sensitive comparison
    // gets at least one of these backwards.
    const orders = [
      sortedPair(LOW, HIGH),
      sortedPair(LOW.toUpperCase().replace('0X', '0x') as typeof LOW, HIGH),
      sortedPair(LOW, HIGH.toUpperCase().replace('0X', '0x') as typeof HIGH),
      sortedPair(getAddress(LOW), getAddress(HIGH)),
    ]
    for (const o of orders) {
      expect(o.token0.toLowerCase()).toBe(LOW)
      expect(o.token1.toLowerCase()).toBe(HIGH)
    }
  })

  it('is the ordering a raw string compare would GET WRONG, so the test is not vacuous', () => {
    // proof the case handling is load-bearing rather than decorative: with a
    // checksummed high address and a lowercase low one, the naive comparison
    // disagrees with the correct answer
    const checksummedHigh = getAddress(HIGH)
    const naive = LOW < checksummedHigh ? LOW : checksummedHigh
    const correct = sortedPair(LOW, checksummedHigh).token0
    expect(correct.toLowerCase()).toBe(LOW)
    // if this ever stops differing the fixture has lost its teeth, not the code
    expect(naive.toLowerCase()).not.toBe(correct.toLowerCase())
  })

  it('never loses or duplicates a side', () => {
    const { token0, token1 } = sortedPair(HIGH, LOW)
    expect(new Set([token0.toLowerCase(), token1.toLowerCase()])).toEqual(new Set([LOW, HIGH]))
  })
})
