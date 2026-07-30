import { describe, expect, it } from 'vitest'
import { PRISM_CLAIM_ROOT, isInClaimSnapshot, lookupClaim, syncGap, wholeTokens } from './claim'
import claimsFile from '../../data/prism-claims.json'
import indexFile from '../../data/prism-claim-index.json'

// The vendored snapshot is load-bearing money data: pin it against the root R
// verified on-chain, and pin the banner's compact index against the full file
// so the two can never drift (scripts/build-prism-claim-index.mjs regenerates).
const claims = (claimsFile as { merkleRoot: string; claims: Record<string, { amount: string; proof: string[] }> })
const index = indexFile as string[]

// The largest holder — R's spec cites it (287.24 PRISM → 128-NFT claim, 3 sync presses).
const LARGEST = '0x8347Ca89C40b139e8E9b38d82d7B799A3dB68605'

describe('vendored PRISM snapshot', () => {
  it('carries the exact root the vault verifies against', () => {
    expect(claims.merkleRoot).toBe(PRISM_CLAIM_ROOT)
  })

  it('the banner index matches the proofs file address-for-address', () => {
    expect(index.length).toBe(1203)
    const fromClaims = new Set(Object.keys(claims.claims).map((a) => a.toLowerCase()))
    expect(new Set(index)).toEqual(fromClaims)
  })
})

describe('lookupClaim / isInClaimSnapshot normalize case', () => {
  // File keys are EIP-55 checksummed; wallets hand us lowercase or checksummed.
  it('finds a claim regardless of query casing', async () => {
    for (const q of [LARGEST, LARGEST.toLowerCase(), LARGEST.toUpperCase().replace('0X', '0x')]) {
      const row = await lookupClaim(q)
      expect(row).not.toBeNull()
      expect(row!.amount).toBe(287239345896629340786n)
      expect(row!.proof.length).toBeGreaterThan(0)
      expect(await isInClaimSnapshot(q)).toBe(true)
    }
  })

  it('an address outside the snapshot is null / false, not an error', async () => {
    const stranger = '0x0000000000000000000000000000000000000001'
    expect(await lookupClaim(stranger)).toBeNull()
    expect(await isInClaimSnapshot(stranger)).toBe(false)
  })
})

describe('syncGap mirrors the hook math (target = floor(balance/1e18))', () => {
  const E18 = 10n ** 18n
  it("R's worked example: the largest holder needs 3 presses (128 → 256 → 287)", () => {
    const bal = 287239345896629340786n // 287.239… PRISM
    expect(syncGap(bal, 0n)).toBe(287n)
    expect(syncGap(bal, 128n)).toBe(159n)
    expect(syncGap(bal, 256n)).toBe(31n)
    expect(syncGap(bal, 287n)).toBe(0n)
  })
  it('dust holders (783 of 1203) never see a gap: floor(<1 PRISM) = 0', () => {
    expect(syncGap(999999999999999999n, 0n)).toBe(0n)
    expect(wholeTokens(999999999999999999n)).toBe(0n)
  })
  it('over-mirrored never goes negative', () => {
    expect(syncGap(1n * E18, 5n)).toBe(0n)
  })
})
