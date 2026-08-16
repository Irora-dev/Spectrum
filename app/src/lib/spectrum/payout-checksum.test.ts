import { describe, expect, it } from 'vitest'
import { getAddress, isAddress } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// THE CHECKSUM ON A PERMANENT MONEY DESTINATION IS EVIDENCE — READ IT.
//
// The creator payout is the one address a human types by hand that becomes an
// immutable destination: creator fees route there from deploy, forever. It was
// validated with `isAddress(v, { strict: false })` and then passed through
// viem's `getAddress()`, and the trap is that getAddress RE-DERIVES the
// checksum rather than verifying it. So a mixed-case address with one
// transposed character passed validation, got silently re-checksummed into a
// perfectly valid-looking address, and the fees went to whoever owns it.
//
// The rule these pin: a LOWERCASE address carries no checksum information, so
// demanding one would reject a legitimate paste. MIXED CASE means EIP-55 is
// present, and a present checksum that does not verify is a typo.
// ─────────────────────────────────────────────────────────────────────────────

// A real checksummed address, and the same one with two characters transposed.
const GOOD = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const TYPO = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96054'

const hasCase = (a: string) => /[a-f]/.test(a.slice(2)) && /[A-F]/.test(a.slice(2))
/** The rule as BasketBuilder applies it. */
const payoutValid = (a: string) => isAddress(a, { strict: hasCase(a) })

describe('viem behaviour this depends on', () => {
  it('getAddress RE-DERIVES rather than verifies — the whole reason strict matters', () => {
    // The typo'd address is silently returned as a valid checksummed address.
    expect(() => getAddress(TYPO.toLowerCase())).not.toThrow()
    expect(getAddress(TYPO.toLowerCase())).not.toBe(GOOD)
  })

  it('strict:false accepts a mixed-case address whose checksum is wrong', () => {
    expect(isAddress(TYPO, { strict: false })).toBe(true)
  })
})

describe('the payout rule', () => {
  it('accepts a correctly checksummed address', () => {
    expect(payoutValid(GOOD)).toBe(true)
  })

  it('REJECTS the transposed one, which is the bug it exists for', () => {
    expect(payoutValid(TYPO)).toBe(false)
  })

  it('still accepts an all-lowercase paste — no checksum present, nothing to verify', () => {
    expect(payoutValid(GOOD.toLowerCase())).toBe(true)
  })

  it('still accepts an all-uppercase paste for the same reason', () => {
    expect(payoutValid(`0x${GOOD.slice(2).toUpperCase()}`)).toBe(true)
  })

  it('rejects anything that is not an address at all', () => {
    for (const bad of ['', '0x', 'not-an-address', GOOD.slice(0, -1), `${GOOD}00`]) {
      expect(payoutValid(bad)).toBe(false)
    }
  })
})
