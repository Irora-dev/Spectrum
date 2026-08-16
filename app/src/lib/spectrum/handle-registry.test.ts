import { describe, expect, it } from 'vitest'
import {
  claimsFromNotes,
  creatorPath,
  decodeHandleClaim,
  encodeHandleClaim,
  HANDLE_AUTHORITY_CHAIN_ID,
  HANDLE_KIND,
  lookupHandle,
} from './handle-registry'
import { resolveHandles, type HandleClaim } from './creator-handles'
import type { NoteEvent } from './profile-registry'

const A = '0x1111111111111111111111111111111111111111' as const
const B = '0x2222222222222222222222222222222222222222' as const

function note(author: string, raw: string, blockNumber: number, logIndex = 0): NoteEvent {
  return {
    author: author as `0x${string}`,
    subject: author as `0x${string}`,
    raw,
    blockNumber: BigInt(blockNumber),
    logIndex,
  }
}

describe('the claim envelope', () => {
  it('normalizes before writing, so nothing invalid can reach the chain', () => {
    expect(encodeHandleClaim('BasedResearch')).toBe('{"v":1,"h":"BasedResearch"}')
    expect(encodeHandleClaim('  @BasedResearch ')).toBe('{"v":1,"h":"BasedResearch"}')
    expect(encodeHandleClaim('ab')).toBeNull()
    expect(encodeHandleClaim('bad name')).toBeNull()
    expect(encodeHandleClaim('-nope-')).toBeNull()
  })

  it('keeps the typed casing on the wire and folds it on the way back', () => {
    const raw = encodeHandleClaim('BasedResearch')!
    expect(decodeHandleClaim(raw)).toBe('BasedResearch')
    const map = resolveHandles(
      [{ author: A, subject: A, name: decodeHandleClaim(raw)!, blockNumber: 1n, logIndex: 0 }],
      () => true,
    )
    expect(map.byHandle.get('basedresearch')?.display).toBe('BasedResearch')
  })

  it('reads the clear as a release and anything else as noise', () => {
    expect(decodeHandleClaim('')).toBe('')
    expect(decodeHandleClaim('not json')).toBeNull()
    expect(decodeHandleClaim('{"v":2,"h":"x"}')).toBeNull()
    expect(decodeHandleClaim('{"v":1}')).toBeNull()
    expect(decodeHandleClaim('{"v":1,"h":42}')).toBeNull()
    expect(decodeHandleClaim('[]')).toBeNull()
    expect(decodeHandleClaim('null')).toBeNull()
  })

  it('drops notes that are not claims, and keeps ordering', () => {
    const claims: HandleClaim[] = claimsFromNotes([
      note(A, '{"v":1,"h":"alpha"}', 10, 1),
      note(B, 'garbage from another surface', 11),
      note(B, '{"v":1,"h":"beta"}', 12, 4),
      note(A, '', 13),
    ])
    expect(claims.map((c) => c.name)).toEqual(['alpha', 'beta', ''])
    expect(claims[1]).toMatchObject({ blockNumber: 12n, logIndex: 4 })
  })

  it('pins one kind topic, so the scan can only ever see handle claims', () => {
    expect(HANDLE_KIND).toMatch(/^0x[0-9a-f]{64}$/)
    expect(BigInt(HANDLE_KIND)).not.toBe(0n)
  })

  it('names one authority chain (spec §1)', () => {
    expect(HANDLE_AUTHORITY_CHAIN_ID).toBe(8453) // Base
  })
})

describe('lookupHandle', () => {
  const map = resolveHandles(
    [
      { author: A, subject: A, name: 'alpha', blockNumber: 1n, logIndex: 0 },
      { author: A, subject: A, name: 'beta', blockNumber: 2n, logIndex: 0 },
      { author: B, subject: B, name: 'gamma', blockNumber: 3n, logIndex: 0 },
    ],
    () => true,
  )

  it('finds a live name', () => {
    expect(lookupHandle(map, 'beta')).toMatchObject({ status: 'found' })
    expect(lookupHandle(map, 'BETA')).toMatchObject({ status: 'found' })
  })

  it('says RETIRED rather than none, so the page can explain itself', () => {
    expect(lookupHandle(map, 'alpha')).toEqual({ status: 'retired' })
  })

  it('says none for a name nobody ever claimed, and for a reserved one', () => {
    expect(lookupHandle(map, 'nobodyhasthis')).toEqual({ status: 'none' })
    expect(lookupHandle(map, 'spectrum')).toEqual({ status: 'none' })
    expect(lookupHandle(map, 'x')).toEqual({ status: 'none' })
  })
})

describe('creatorPath', () => {
  it('prefers the handle and checksums the address fallback', () => {
    const owner = { address: A, handle: 'beta', display: 'Beta', blockNumber: 1n, logIndex: 0 }
    expect(creatorPath(A, owner)).toBe('/creator/Beta')
    expect(creatorPath(A, null)).toBe('/creator/0x1111111111111111111111111111111111111111')
    expect(creatorPath('not-an-address', null)).toBe('/creator/not-an-address')
  })
})
