import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { encodeBasketMetaJson, encodeProfileJson, basketMetaShapeCheck, onchainToIdentityMeta, type OnchainProfileJson } from './profile-registry'

const CREATOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address
const TOKEN = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'

describe('profile-registry encode/adapt (the pure halves; chain path covered by the anvil E2E)', () => {
  it('encodeProfileJson: emits v1, drops empty fields and junk pick addresses', () => {
    const json = JSON.parse(
      encodeProfileJson({ name: ' Chef ', bio: '', picks: [{ address: TOKEN, note: 'rail' }, { address: 'junk' }] }),
    ) as OnchainProfileJson
    expect(json.v).toBe(1)
    expect(json.name).toBe('Chef')
    expect(json.bio).toBeUndefined()
    expect(json.picks).toEqual([TOKEN])
    expect(json.pickNotes).toEqual(['rail'])
  })

  it('onchainToIdentityMeta: aligns notes to surviving picks, block height as issuedAt', () => {
    const meta = onchainToIdentityMeta(
      { v: 1, name: 'Chef', picks: [TOKEN, 'not-an-address'], pickNotes: ['rail', 'junknote'] },
      CREATOR,
      42n,
    )
    expect(meta.creator).toBe(CREATOR)
    expect(meta.picks).toEqual([TOKEN])
    expect(meta.pickNotes).toEqual(['rail'])
    expect(meta.issuedAt).toBe(42)
  })

  it('round-trip: encode → parse → adapt preserves the profile', () => {
    const json = JSON.parse(
      encodeProfileJson({ name: 'Chef', handle: '@chef', bio: 'baskets', picks: [{ address: TOKEN, note: 'rail' }] }),
    ) as OnchainProfileJson
    const meta = onchainToIdentityMeta(json, CREATOR, 7n)
    expect(meta.name).toBe('Chef')
    expect(meta.handle).toBe('@chef')
    expect(meta.bio).toBe('baskets')
    expect(meta.picks).toHaveLength(1)
  })
})

describe('basket-thesis note encode/shape (authorship enforced by the read path; see anvil E2E)', () => {
  it('encodeBasketMetaJson: v1 envelope, empty fields dropped', () => {
    const json = JSON.parse(encodeBasketMetaJson({ thesis: ' Long the majors. ', tagline: '', sectors: ['DeFi', ' '] })) as Record<string, unknown>
    expect(json.v).toBe(1)
    expect(json.thesis).toBe('Long the majors.')
    expect(json.tagline).toBeUndefined()
    expect(json.sectors).toEqual(['DeFi'])
  })

  it('basketMetaShapeCheck: accepts the envelope, rejects wrong version/shape', () => {
    expect(basketMetaShapeCheck({ v: 1, thesis: 'x' })).not.toBeNull()
    expect(basketMetaShapeCheck({ v: 2, thesis: 'x' })).toBeNull()
    expect(basketMetaShapeCheck({ v: 1, sectors: 'not-an-array' })).toBeNull()
    expect(basketMetaShapeCheck('junk')).toBeNull()
  })
})
