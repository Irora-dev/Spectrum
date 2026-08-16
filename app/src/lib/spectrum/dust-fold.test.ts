import { describe, expect, it } from 'vitest'
import { foldDust } from './dust-fold'
import { DUST_CEILING_USD } from './insights'

const row = (key: string, valueUsd: number | null) => ({ key, valueUsd })

describe('foldDust (the $10 fold law)', () => {
  it('folds strictly below the floor; AT the floor stays in main', () => {
    const rows = [
      row('1:0xbig', 147_000),
      row('1:0xatfloor', DUST_CEILING_USD), // exactly $10 — not dust
      row('4663:0xunity', 5.18), // the reported UNITY row
      row('4663:0xbelow', 9.99),
    ]
    const f = foldDust(rows)
    expect(f.main.map((r) => r.key)).toEqual(['1:0xbig', '1:0xatfloor'])
    expect(f.dust.map((r) => r.key)).toEqual(['4663:0xunity', '4663:0xbelow'])
    expect(f.dustUsd).toBeCloseTo(15.17, 2)
  })

  it('UNPRICED is never dust — a null value stays in main', () => {
    const rows = [row('1:0xbig', 1_000), row('1:0xunpriced', null), row('1:0xdust', 2)]
    const f = foldDust(rows)
    expect(f.main.map((r) => r.key)).toEqual(['1:0xbig', '1:0xunpriced'])
    expect(f.dust.map((r) => r.key)).toEqual(['1:0xdust'])
  })

  it('exempt keys (hand-added assets) never fold, whatever their size', () => {
    const rows = [row('1:0xbig', 500), row('1:0xmanual', 0.42), row('1:0xdust', 3)]
    const f = foldDust(rows, { exempt: new Set(['1:0xmanual']) })
    expect(f.main.map((r) => r.key)).toEqual(['1:0xbig', '1:0xmanual'])
    expect(f.dust.map((r) => r.key)).toEqual(['1:0xdust'])
  })

  it('never folds the whole book — an all-dust portfolio renders as-is', () => {
    const rows = [row('1:0xa', 4), row('1:0xb', 2.5)]
    const f = foldDust(rows)
    expect(f.main).toHaveLength(2)
    expect(f.dust).toHaveLength(0)
    expect(f.dustUsd).toBe(0)
  })

  it('zero/negative values are not dust (they are not positions), empty input holds', () => {
    expect(foldDust([]).main).toEqual([])
    const f = foldDust([row('1:0xzero', 0), row('1:0xbig', 100)])
    expect(f.main).toHaveLength(2)
    expect(f.dust).toHaveLength(0)
  })

  it('the fold arithmetic reconciles: main + dust = input, dustUsd = sum of folded', () => {
    const rows = [row('1:0xa', 100), row('1:0xb', 1), row('1:0xc', 9), row('1:0xd', null)]
    const f = foldDust(rows)
    expect(f.main.length + f.dust.length).toBe(rows.length)
    expect(f.dustUsd).toBe(10) // 1 + 9
  })
})
