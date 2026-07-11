import { describe, expect, it } from 'vitest'
import { addressFingerprint } from './fingerprint'
import { verdictFor, verifyChainConfig, DEPLOYER_ANCHOR_ENS } from './anchor'
import canonicalBook from '../chain/deployments.json'
import type { Address } from 'viem'

const CANON_FACTORY = (canonicalBook as Record<string, Record<string, string>>)['8453'].factory as Address

describe('addressFingerprint', () => {
  it('is deterministic and case-insensitive', () => {
    const a = addressFingerprint(CANON_FACTORY)
    const b = addressFingerprint(CANON_FACTORY.toLowerCase())
    expect(a).toEqual(b)
    expect(a.valid).toBe(true)
    expect(a.words.split('-')).toHaveLength(3)
  })

  it('an address-poisoning look-alike (same ends, different middle) fingerprints differently', () => {
    const real = CANON_FACTORY.toLowerCase()
    const poisoned = real.slice(0, 8) + 'deadbeefdeadbeefdeadbeefdead' + real.slice(-6)
    expect(poisoned).toHaveLength(42)
    expect(poisoned.slice(0, 8)).toBe(real.slice(0, 8))
    expect(poisoned.slice(-6)).toBe(real.slice(-6))
    const a = addressFingerprint(real)
    const b = addressFingerprint(poisoned)
    expect(b.valid).toBe(true)
    expect(a.emoji === b.emoji && a.words === b.words).toBe(false)
  })

  it('invalid input renders as unknown, never throws', () => {
    for (const bad of ['', '0x123', 'not-an-address', null, undefined]) {
      const fp = addressFingerprint(bad as string)
      expect(fp.valid).toBe(false)
      expect(fp.words).toBe('unknown')
    }
  })
})

describe('anchor verdicts', () => {
  it('the shipped canonical book verifies as canonical on every shipped chain', () => {
    for (const chainId of [8453, 1, 4663]) {
      const entry = (canonicalBook as Record<string, Record<string, string>>)[String(chainId)]
      const fields = verifyChainConfig(chainId, {
        factory: entry.factory as Address,
        swapRouter: entry.swapRouter as Address,
        usdc: entry.usdc as Address,
      })
      expect(fields.map((f) => f.verdict)).toEqual(['canonical', 'canonical', 'canonical'])
    }
  })

  it('an operator override is named override, never canonical', () => {
    expect(verdictFor('0x000000000000000000000000000000000000dEaD' as Address, CANON_FACTORY)).toBe('override')
  })

  it('nothing configured is unset — never a false genuine', () => {
    expect(verdictFor(null, CANON_FACTORY)).toBe('unset')
    const fields = verifyChainConfig(999999, { factory: null, swapRouter: null, usdc: null })
    expect(fields.every((f) => f.verdict === 'unset')).toBe(true)
  })

  it('the deployer anchor is an ENS name, never a baked address', () => {
    expect(DEPLOYER_ANCHOR_ENS.endsWith('.eth')).toBe(true)
    expect(/^0x[0-9a-fA-F]{40}$/.test(DEPLOYER_ANCHOR_ENS)).toBe(false)
  })
})

describe('v4PoolId (the on-chain pricing rung mapping key)', () => {
  it('is deterministic, 32 bytes, and sensitive to every PoolKey field', async () => {
    const { v4PoolId } = await import('../pools/v4-usd')
    const key = {
      currency0: '0x0000000000000000000000000000000000000000' as const,
      currency1: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const,
      fee: 500,
      tickSpacing: 10,
      hooks: '0x0000000000000000000000000000000000000000' as const,
    }
    const id = v4PoolId(key)
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(v4PoolId(key)).toBe(id)
    expect(v4PoolId({ ...key, fee: 3000 })).not.toBe(id)
    expect(v4PoolId({ ...key, tickSpacing: 60 })).not.toBe(id)
  })
})
