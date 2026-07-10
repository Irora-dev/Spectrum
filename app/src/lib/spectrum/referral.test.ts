import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { captureRefFromUrl, getStoredRef, refLinkFor, resolveRefInput } from './referral'

// referral.ts persists to localStorage (guarded in try/catch). Vitest runs in the
// `node` environment (no DOM), so stub a minimal in-memory localStorage for the
// read/write/capture paths. The ENS branch of resolveRefInput hits the network and
// is intentionally not exercised here (only the 0x-address + invalid paths are).
const makeStorage = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = makeStorage()
})
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
})

// All-digit addresses: valid format, and no letters means no EIP-55 checksum to
// trip over regardless of viem's strict mode.
const A = `0x${'1'.repeat(40)}` as Address
const B = `0x${'2'.repeat(40)}` as Address
const ZERO = `0x${'0'.repeat(40)}` as Address

describe('captureRefFromUrl', () => {
  it('returns null with nothing stored', () => {
    expect(getStoredRef()).toBeNull()
  })

  it('captures a valid ?ref address', async () => {
    await captureRefFromUrl(`?ref=${A}`)
    expect(getStoredRef()?.toLowerCase()).toBe(A.toLowerCase())
  })

  it('is FIRST-touch: a later ref never overwrites the original', async () => {
    await captureRefFromUrl(`?ref=${A}`)
    await captureRefFromUrl(`?ref=${B}`)
    expect(getStoredRef()?.toLowerCase()).toBe(A.toLowerCase())
  })

  it('rejects the zero address (would blank the operator tag)', async () => {
    await captureRefFromUrl(`?ref=${ZERO}`)
    expect(getStoredRef()).toBeNull()
  })

  it('ignores a non-address ref', async () => {
    await captureRefFromUrl('?ref=notanaddress')
    expect(getStoredRef()).toBeNull()
  })

  it('no-ops when there is no ref param', async () => {
    await captureRefFromUrl('?foo=bar')
    expect(getStoredRef()).toBeNull()
  })
})

describe('getStoredRef self-guard', () => {
  it('suppresses a ref equal to the connected wallet (case-insensitive)', async () => {
    await captureRefFromUrl(`?ref=${A}`)
    expect(getStoredRef(A)).toBeNull()
    expect(getStoredRef(A.toUpperCase() as Address)).toBeNull()
  })

  it('returns the ref for a different wallet', async () => {
    await captureRefFromUrl(`?ref=${A}`)
    expect(getStoredRef(B)?.toLowerCase()).toBe(A.toLowerCase())
  })

  it('returns the ref when no self is passed', async () => {
    await captureRefFromUrl(`?ref=${A}`)
    expect(getStoredRef()?.toLowerCase()).toBe(A.toLowerCase())
  })
})

describe('resolveRefInput', () => {
  it('passes through a valid address', async () => {
    expect((await resolveRefInput(A))?.toLowerCase()).toBe(A.toLowerCase())
  })

  it('rejects the zero address', async () => {
    expect(await resolveRefInput(ZERO)).toBeNull()
  })

  it('rejects a non-address, non-ENS string', async () => {
    expect(await resolveRefInput('nope')).toBeNull()
  })
})

describe('refLinkFor', () => {
  it('builds an /explore link by default', () => {
    expect(refLinkFor(A, 'https://spectrum.xyz')).toBe(`https://spectrum.xyz/explore?ref=${A}`)
  })

  it('honors a custom path and ENS handle', () => {
    expect(refLinkFor('vitalik.eth', 'https://spectrum.xyz', '/token')).toBe('https://spectrum.xyz/token?ref=vitalik.eth')
  })
})
