import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import {
  buildCreatorIdentity,
  hasPublishableIdentity,
  normalizePicks,
  signCreatorIdentity,
  verifyCreatorIdentity,
  MAX_PICKS,
  type SignedCreatorIdentity,
} from './creator-identity'

// Deterministic local signer — the creator signs for THEMSELVES. No network
// anywhere: the gate is pure signature recovery == metadata.creator.
const CREATOR = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)
const IMPOSTOR = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
)
const FACTORY = '0x00000000000000000000000000000000000fac70' as Address
const CHAIN_ID = 8453
const TOKEN_A = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
const TOKEN_B = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'

const INPUT = {
  name: 'Basket Chef',
  handle: '@basketchef',
  bio: 'I build narrative baskets.',
  picks: [
    { address: TOKEN_A, note: 'the settlement rail' },
    { address: TOKEN_B, note: '' },
  ],
}

async function signedBlob(
  input = INPUT,
  signer = CREATOR,
  creator: Address = CREATOR.address,
): Promise<SignedCreatorIdentity> {
  const meta = buildCreatorIdentity(input, creator, 1_753_700_000)
  return signCreatorIdentity({
    meta,
    signer: signer.address,
    chainId: CHAIN_ID,
    factory: FACTORY,
    signTypedDataAsync: (args) => signer.signTypedData(args),
  })
}

describe('creator identity — self-signed profile blob', () => {
  it('round-trips: a self-signed profile verifies', async () => {
    const blob = await signedBlob()
    expect(blob.metadata.picks).toHaveLength(2)
    await expect(verifyCreatorIdentity(blob, { chainId: CHAIN_ID, factory: FACTORY })).resolves.toBe(true)
  })

  it('rejects an impostor: signature from a different key than metadata.creator', async () => {
    const blob = await signedBlob(INPUT, IMPOSTOR, CREATOR.address) // impostor signs a profile claiming CREATOR
    await expect(verifyCreatorIdentity(blob, { chainId: CHAIN_ID, factory: FACTORY })).resolves.toBe(false)
  })

  it('rejects a signer field that does not match the creator field', async () => {
    const blob = await signedBlob()
    const forged = { ...blob, signer: IMPOSTOR.address }
    await expect(verifyCreatorIdentity(forged, { chainId: CHAIN_ID, factory: FACTORY })).resolves.toBe(false)
  })

  it('rejects tampered content (bio swapped after signing)', async () => {
    const blob = await signedBlob()
    const tampered = { ...blob, metadata: { ...blob.metadata, bio: 'rug incoming' } }
    await expect(verifyCreatorIdentity(tampered, { chainId: CHAIN_ID, factory: FACTORY })).resolves.toBe(false)
  })

  it('rejects a wrong domain (other chain / other factory)', async () => {
    const blob = await signedBlob()
    await expect(verifyCreatorIdentity(blob, { chainId: 1, factory: FACTORY })).resolves.toBe(false)
    await expect(
      verifyCreatorIdentity(blob, {
        chainId: CHAIN_ID,
        factory: '0x00000000000000000000000000000000000fac71' as Address,
      }),
    ).resolves.toBe(false)
  })

  it('normalizePicks dedupes, drops junk addresses, caps at MAX_PICKS, aligns notes', () => {
    const raw = [
      { address: TOKEN_A, note: 'first' },
      { address: TOKEN_A.toLowerCase(), note: 'dupe' },
      { address: 'not-an-address', note: 'junk' },
      ...Array.from({ length: 20 }, (_, i) => ({
        address: `0x${String(i + 1).padStart(40, '0')}`,
        note: `n${i}`,
      })),
    ]
    const { picks, pickNotes } = normalizePicks(raw)
    expect(picks).toHaveLength(MAX_PICKS)
    expect(pickNotes).toHaveLength(MAX_PICKS)
    expect(picks[0].toLowerCase()).toBe(TOKEN_A.toLowerCase())
    expect(pickNotes[0]).toBe('first')
  })

  it('hasPublishableIdentity: empty input is not publishable, any field is', () => {
    expect(hasPublishableIdentity(buildCreatorIdentity({}, CREATOR.address, 1))).toBe(false)
    expect(hasPublishableIdentity(buildCreatorIdentity({ bio: 'hi' }, CREATOR.address, 1))).toBe(true)
    expect(
      hasPublishableIdentity(buildCreatorIdentity({ picks: [{ address: TOKEN_A }] }, CREATOR.address, 1)),
    ).toBe(true)
  })

  it('caps prose at build time (bio 600, note 80)', () => {
    const meta = buildCreatorIdentity(
      { bio: 'x'.repeat(2000), picks: [{ address: TOKEN_A, note: 'y'.repeat(500) }] },
      CREATOR.address,
      1,
    )
    expect(meta.bio).toHaveLength(600)
    expect(meta.pickNotes[0]).toHaveLength(80)
  })
})
