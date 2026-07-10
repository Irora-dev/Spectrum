import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { zeroAddress, type Address } from 'viem'
import {
  buildCreatorMetadata,
  hasPublishableMetadata,
  normalizeSectors,
  signCreatorMetadata,
  verifyCreatorMetadata,
  type SignedCreatorMetadata,
  sanitizePostUrl,
} from './creator-metadata'

// Deterministic local signer — the "deployer". No network anywhere in this file:
// verifyCreatorMetadata takes expectedDeployer explicitly (chain read is the
// caller's job), so the whole trust gate is testable as pure signature recovery.
const DEPLOYER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)
const OTHER = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
)
const BASKET = '0x74D8c56314d7310d491e1b271567Cf2283ed301B' as Address
const FACTORY = '0x00000000000000000000000000000000000fac70' as Address
const CHAIN_ID = 8453

const THESIS_INPUT = {
  name: 'spectrumdev.eth',
  tagline: 'Blue-chip DeFi in one basket.',
  thesis: 'A weighted core of the majors: deep liquidity, real fee flow, multi-cycle survival.',
  sectors: ['DeFi', 'Blue chip'],
  timeHorizon: 'long-term',
}

async function signedBlob(input = THESIS_INPUT): Promise<SignedCreatorMetadata> {
  const meta = buildCreatorMetadata(input, BASKET, 1_751_700_000)
  return signCreatorMetadata({
    meta,
    signer: DEPLOYER.address,
    chainId: CHAIN_ID,
    factory: FACTORY,
    signTypedDataAsync: (args) => DEPLOYER.signTypedData(args),
  })
}

describe('creator metadata v3 — signed thesis fields', () => {
  it('round-trips: deployer-signed blob with thesis fields verifies', async () => {
    const blob = await signedBlob()
    expect(blob.metadata.tagline).toBe(THESIS_INPUT.tagline)
    expect(blob.metadata.sectors).toEqual(['DeFi', 'Blue chip'])
    await expect(
      verifyCreatorMetadata(blob, {
        chainId: CHAIN_ID,
        factory: FACTORY,
        expectedDeployer: DEPLOYER.address,
      }),
    ).resolves.toBe(true)
  })

  it('rejects a spoof: signer ≠ on-chain deployer', async () => {
    const blob = await signedBlob()
    await expect(
      verifyCreatorMetadata(blob, {
        chainId: CHAIN_ID,
        factory: FACTORY,
        expectedDeployer: OTHER.address,
      }),
    ).resolves.toBe(false)
  })

  it('rejects tampering: thesis edited after signing fails recovery', async () => {
    const blob = await signedBlob()
    const tampered: SignedCreatorMetadata = {
      ...blob,
      metadata: { ...blob.metadata, thesis: 'Totally different words.' },
    }
    await expect(
      verifyCreatorMetadata(tampered, {
        chainId: CHAIN_ID,
        factory: FACTORY,
        expectedDeployer: DEPLOYER.address,
      }),
    ).resolves.toBe(false)
  })

  it('rejects a v2-shaped blob (thesis fields stripped) instead of crashing', async () => {
    const blob = await signedBlob()
    const legacy = JSON.parse(JSON.stringify(blob)) as SignedCreatorMetadata
    // Simulate a pre-v3 blob: the signed struct simply lacks the thesis fields.
    delete (legacy.metadata as Partial<typeof legacy.metadata>).tagline
    delete (legacy.metadata as Partial<typeof legacy.metadata>).thesis
    delete (legacy.metadata as Partial<typeof legacy.metadata>).sectors
    delete (legacy.metadata as Partial<typeof legacy.metadata>).timeHorizon
    await expect(
      verifyCreatorMetadata(legacy, {
        chainId: CHAIN_ID,
        factory: FACTORY,
        expectedDeployer: DEPLOYER.address,
      }),
    ).resolves.toBe(false)
  })

  it('binds the signature to chain + factory (no cross-deployment replay)', async () => {
    const blob = await signedBlob()
    await expect(
      verifyCreatorMetadata(blob, {
        chainId: 1, // signed for Base
        factory: FACTORY,
        expectedDeployer: DEPLOYER.address,
      }),
    ).resolves.toBe(false)
  })
})

describe('buildCreatorMetadata — thesis normalization', () => {
  it('caps tagline/thesis lengths and sector count before signing', () => {
    const meta = buildCreatorMetadata(
      {
        tagline: 'x'.repeat(500),
        thesis: 'y'.repeat(10_000),
        sectors: Array.from({ length: 20 }, (_, i) => `Sector ${i}`),
        timeHorizon: 'z'.repeat(100),
      },
      BASKET,
      0,
    )
    expect(meta.tagline.length).toBe(140)
    expect(meta.thesis.length).toBe(4000)
    expect(meta.sectors.length).toBe(8)
    expect(meta.timeHorizon.length).toBe(24)
  })

  it('a thesis alone makes the blob publishable; nothing at all does not', () => {
    const withThesis = buildCreatorMetadata({ thesis: 'Because.' }, BASKET, 0)
    expect(hasPublishableMetadata(withThesis)).toBe(true)
    const empty = buildCreatorMetadata({}, BASKET, 0)
    expect(empty.supersedes).toBe(zeroAddress)
    expect(hasPublishableMetadata(empty)).toBe(false)
  })
})

describe('normalizeSectors', () => {
  it('trims, drops empties, dedupes case-insensitively, keeps first casing', () => {
    expect(normalizeSectors([' DeFi ', 'defi', '', '  ', 'AI'])).toEqual(['DeFi', 'AI'])
  })
  it('handles null/undefined', () => {
    expect(normalizeSectors(null)).toEqual([])
    expect(normalizeSectors(undefined)).toEqual([])
  })
})

// ── sanitizePostUrl — the ONLY creator-controlled outbound link (v4) ──────────
describe('sanitizePostUrl — strictly one X post, nothing else', () => {
  it('accepts x.com / twitter.com status links and canonicalizes them', () => {
    expect(sanitizePostUrl('https://x.com/spectrumdev/status/1811111111111111111')).toBe(
      'https://x.com/spectrumdev/status/1811111111111111111',
    )
    expect(sanitizePostUrl('https://twitter.com/Some_User/status/123/')).toBe('https://x.com/Some_User/status/123')
    expect(sanitizePostUrl('https://www.x.com/a/status/9?s=20&t=abc#frag')).toBe('https://x.com/a/status/9')
  })
  it('rejects every other website, path shape and protocol (the griefing surface)', () => {
    expect(sanitizePostUrl('https://evil.com/a/status/1')).toBeNull()
    expect(sanitizePostUrl('https://x.com.evil.com/a/status/1')).toBeNull()
    expect(sanitizePostUrl('https://x.com/spectrumdev')).toBeNull() // account, not a post
    expect(sanitizePostUrl('https://x.com/a/status/notanid')).toBeNull()
    expect(sanitizePostUrl('https://x.com/way-too-long-handle-here/status/1')).toBeNull()
    expect(sanitizePostUrl('http://x.com/a/status/1')).toBeNull() // not https
    expect(sanitizePostUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizePostUrl('')).toBeNull()
  })
  it('buildCreatorMetadata signs the canonical form and folds junk to empty', () => {
    const good = buildCreatorMetadata({ postUrl: 'https://twitter.com/dev/status/42?s=20' }, BASKET, 0)
    expect(good.postUrl).toBe('https://x.com/dev/status/42')
    expect(hasPublishableMetadata(good)).toBe(true)
    const junk = buildCreatorMetadata({ postUrl: 'https://mal.icio.us/x' }, BASKET, 0)
    expect(junk.postUrl).toBe('')
  })
})
