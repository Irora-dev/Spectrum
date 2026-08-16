import { describe, expect, it } from 'vitest'
import {
  duplicateWarning,
  findDuplicates,
  foldName,
  type CandidateBasket,
  type ExistingBasket,
} from './launch-duplicates'

const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const DAI = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb'

const existing = (over: Partial<ExistingBasket> = {}): ExistingBasket => ({
  chainId: 8453,
  address: '0xaaa',
  name: 'Blue Chips',
  symbol: 'BLUE',
  basketLength: 2,
  top: [
    { address: WETH, weightPct: 60 },
    { address: USDC, weightPct: 40 },
  ],
  ...over,
})

const candidate = (over: Partial<CandidateBasket> = {}): CandidateBasket => ({
  chainId: 8453,
  name: 'Something Else',
  symbol: 'ELSE',
  assets: [{ address: DAI, weightPct: 100 }],
  ...over,
})

describe('what counts as a collision', () => {
  it('the same name, however it was typed', () => {
    const r = findDuplicates(candidate({ name: '  blue   chips ' }), [existing()])
    expect(r.hits[0].reasons).toEqual(['name'])
  })

  it('the same ticker, however it was cased', () => {
    expect(findDuplicates(candidate({ symbol: 'blue' }), [existing()]).hits[0].reasons).toEqual(['ticker'])
  })

  it('the same assets at the same weights, in any order', () => {
    const r = findDuplicates(
      candidate({
        assets: [
          { address: USDC.toUpperCase(), weightPct: 40 },
          { address: WETH, weightPct: 60 },
        ],
      }),
      [existing()],
    )
    expect(r.hits[0].reasons).toEqual(['mix'])
  })

  it('the same assets at DIFFERENT weights is not a duplicate mix', () => {
    const r = findDuplicates(
      candidate({
        assets: [
          { address: WETH, weightPct: 50 },
          { address: USDC, weightPct: 50 },
        ],
      }),
      [existing()],
    )
    expect(r.hits).toEqual([])
  })

  it('reports every reason at once, not a winner', () => {
    const r = findDuplicates(candidate({ name: 'Blue Chips', symbol: 'BLUE' }), [existing()])
    expect(r.hits[0].reasons).toEqual(['name', 'ticker'])
  })
})

describe('what is deliberately NOT a collision', () => {
  it('a basket on another network', () => {
    expect(findDuplicates(candidate({ name: 'Blue Chips' }), [existing({ chainId: 1 })]).hits).toEqual([])
  })

  it('a superseded version — that is the version system working', () => {
    expect(
      findDuplicates(candidate({ name: 'Blue Chips' }), [existing({ supersededBy: '0xbbb' })]).hits,
    ).toEqual([])
  })

  it('an empty candidate name or ticker never matches an empty existing one', () => {
    const r = findDuplicates(candidate({ name: '   ', symbol: '' }), [existing({ name: '', symbol: '  ' })])
    expect(r.hits).toEqual([])
  })

  it('nothing to compare against is no hits, not a crash', () => {
    expect(findDuplicates(candidate(), []).hits).toEqual([])
  })
})

describe('it will not claim a mix match it cannot see', () => {
  it('a truncated leg list is never compared, and says so', () => {
    const truncated = existing({ basketLength: 9, top: [{ address: WETH, weightPct: 60 }] })
    const r = findDuplicates(candidate({ assets: [{ address: WETH, weightPct: 60 }] }), [truncated])
    expect(r.hits).toEqual([])
    expect(r.mixCheckable).toBe(false)
  })

  it('a truncated row can still collide on name — the cheap facts still work', () => {
    const truncated = existing({ basketLength: 9, top: [], name: 'Blue Chips' })
    const r = findDuplicates(candidate({ name: 'Blue Chips' }), [truncated])
    expect(r.hits[0].reasons).toEqual(['name'])
    expect(r.mixCheckable).toBe(false)
  })

  it('whole leg lists report the mix as checkable', () => {
    expect(findDuplicates(candidate(), [existing()]).mixCheckable).toBe(true)
  })
})

describe('the warning sentence', () => {
  it('is null when there is nothing to warn about', () => {
    expect(duplicateWarning(findDuplicates(candidate(), [existing()]))).toBeNull()
  })

  it('never says the deploy is blocked — the creator still decides', () => {
    const w = duplicateWarning(findDuplicates(candidate({ name: 'Blue Chips' }), [existing()]))!
    expect(w).toContain('you can still deploy')
  })

  it('leads with the strongest reason and counts the rest', () => {
    const two = [existing(), existing({ address: '0xccc' })]
    const w = duplicateWarning(findDuplicates(candidate({ name: 'Blue Chips' }), two))!
    expect(w).toContain('the same name')
    expect(w).toContain('and 1 more')
  })

  it('a mix match outranks a name match in the wording', () => {
    const w = duplicateWarning(
      findDuplicates(
        candidate({
          name: 'Blue Chips',
          assets: [
            { address: WETH, weightPct: 60 },
            { address: USDC, weightPct: 40 },
          ],
        }),
        [existing()],
      ),
    )!
    expect(w).toContain('the same assets at the same weights')
  })
})

describe('the name fold matches the thesis grouper', () => {
  it('lowercases, collapses whitespace and trims — nothing else', () => {
    expect(foldName('  Blue   Chips \n')).toBe('blue chips')
    expect(foldName(null)).toBe('')
    expect(foldName('Blue-Chips')).toBe('blue-chips')
  })
})
