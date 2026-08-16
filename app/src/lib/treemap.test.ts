import { describe, expect, it } from 'vitest'
import { reapportionStrips, squarify, type TmRect } from './treemap'

const area = (rs: TmRect[]) => rs.reduce((s, r) => s + r.w * r.h, 0)

describe('squarify', () => {
  it('tiles the whole box, weight-proportional', () => {
    const rs = squarify(
      [
        { ticker: 'a', weight: 3 },
        { ticker: 'b', weight: 1 },
      ],
      300,
      200,
    )
    expect(Math.round(area(rs))).toBe(60000)
    const a = rs.find((r) => r.ticker === 'a')!
    expect(a.w * a.h).toBeCloseTo(45000, 0)
  })
})

describe('reapportionStrips (the live dial law: only the dialed strip moves)', () => {
  // a hand-built two-strip layout: left column holds a+b (vertical strip),
  // right column holds c alone
  const rest: TmRect[] = [
    { ticker: 'a', x: 0, y: 0, w: 100, h: 120 },
    { ticker: 'b', x: 0, y: 120, w: 100, h: 80 },
    { ticker: 'c', x: 100, y: 0, w: 200, h: 200 },
  ]

  it('growing a re-divides ONLY its own strip; the other strip is byte-identical', () => {
    const out = reapportionStrips(rest, new Map([['a', 3], ['b', 1], ['c', 5]]))
    const a = out.find((r) => r.ticker === 'a')!
    const b = out.find((r) => r.ticker === 'b')!
    const c = out.find((r) => r.ticker === 'c')!
    expect(c).toEqual(rest[2]) // untouched strip: identical
    expect(a.h).toBeCloseTo(150, 5) // 3/4 of the strip's 200
    expect(b.h).toBeCloseTo(50, 5)
    expect(b.y).toBeCloseTo(150, 5) // stays flush under a
    expect(a.w).toBe(100) // run thickness never changes
    expect(Math.round(area(out))).toBe(Math.round(area(rest))) // still a full tiling
  })

  it('unchanged weights emit every rect byte-identical', () => {
    const out = reapportionStrips(rest, new Map([['a', 120], ['b', 80], ['c', 200]]))
    expect(out.find((r) => r.ticker === 'a')).toEqual(rest[0])
    expect(out.find((r) => r.ticker === 'b')).toEqual(rest[1])
  })

  it('a tile alone in its strip holds still whatever its weight does', () => {
    const out = reapportionStrips(rest, new Map([['a', 1], ['b', 1], ['c', 999]]))
    expect(out.find((r) => r.ticker === 'c')).toEqual(rest[2])
  })

  it('horizontal strips apportion widths', () => {
    const row: TmRect[] = [
      { ticker: 'x', x: 0, y: 0, w: 150, h: 100 },
      { ticker: 'y', x: 150, y: 0, w: 150, h: 100 },
    ]
    const out = reapportionStrips(row, new Map([['x', 2], ['y', 1]]))
    expect(out.find((r) => r.ticker === 'x')!.w).toBeCloseTo(200, 5)
    expect(out.find((r) => r.ticker === 'y')!.x).toBeCloseTo(200, 5)
    expect(out.every((r) => r.h === 100)).toBe(true)
  })

  it('col·pair·col: aligned but SEPARATED columns never merge (the dial stacking)', () => {
    // The homepage dial's rest layout, measured 2026-08-03: the flanking
    // columns are both full-height (share y+h) but a pair sits between them —
    // alignment without adjacency. The old grouping merged them into one fake
    // horizontal run and re-flowed it from x=0, teleporting the far column
    // ONTO the middle pair for the whole drag.
    const dial: TmRect[] = [
      { ticker: 'NVDA', x: 0, y: 0, w: 300, h: 400 },
      { ticker: 'CBETH', x: 300, y: 0, w: 350, h: 200 },
      { ticker: 'MSFT', x: 300, y: 200, w: 350, h: 200 },
      { ticker: 'AERO', x: 650, y: 0, w: 350, h: 400 },
    ]
    const out = reapportionStrips(dial, new Map([['NVDA', 9], ['CBETH', 1], ['MSFT', 1], ['AERO', 1]]))
    // each flanking column is ALONE in its strip: it holds, whatever its weight does
    expect(out.find((r) => r.ticker === 'NVDA')).toEqual(dial[0])
    expect(out.find((r) => r.ticker === 'AERO')).toEqual(dial[3])
    // and no tile overlaps any other
    for (const a of out)
      for (const b of out) {
        if (a === b) continue
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        expect(Math.min(ox, oy)).toBeLessThanOrEqual(0.5)
      }
  })

  it('a partially-contiguous alignment keeps only the run containing the tile', () => {
    const row: TmRect[] = [
      { ticker: 'p', x: 0, y: 0, w: 100, h: 100 },
      { ticker: 'q', x: 100, y: 0, w: 100, h: 100 },
      { ticker: 'r', x: 350, y: 0, w: 100, h: 100 }, // aligned, but a gap away
    ]
    const out = reapportionStrips(row, new Map([['p', 3], ['q', 1], ['r', 1]]))
    expect(out.find((t) => t.ticker === 'r')).toEqual(row[2]) // holds
    expect(out.find((t) => t.ticker === 'p')!.w).toBeCloseTo(150, 5) // 3/4 of the run's 200
    expect(out.find((t) => t.ticker === 'q')!.x).toBeCloseTo(150, 5)
  })
})
