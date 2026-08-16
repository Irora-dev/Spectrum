import { describe, expect, it } from 'vitest'
import { computeWindowMove, type WindowMoveInput } from './window-move'
import type { NavPoint } from './basket-data'

const pts = (...values: number[]): NavPoint[] => values.map((value, i) => ({ time: i, value }))
const input = (key: string, symbol: string, valueUsd: number): WindowMoveInput => ({ key, symbol, valueUsd })

describe('computeWindowMove — the strip follows the chart window', () => {
  it('states the constant-quantity move: today valued at the window open', () => {
    // price doubled over the window: a $200 position gained $100 of it
    const m = computeWindowMove([input('1:a', 'AAA', 200)], new Map([['1:a', pts(1, 1.5, 2)]]))
    expect(m.rows).toEqual([{ symbol: 'AAA', usd: 100 }])
    expect(m.totalUsd).toBe(100)
    expect(m.unreadable).toBe(0)
  })

  it('signs losers and ranks by magnitude, biggest first', () => {
    const m = computeWindowMove(
      [input('1:a', 'AAA', 100), input('1:b', 'BBB', 400)],
      new Map([
        ['1:a', pts(2, 1)], // halved → −$100
        ['1:b', pts(1, 1.1)], // +10% → +$36.36
      ]),
    )
    expect(m.rows[0].symbol).toBe('AAA')
    expect(m.rows[0].usd).toBeCloseTo(-100)
    expect(m.rows[1].usd).toBeCloseTo(400 - 400 / 1.1)
  })

  it('a series that cannot state a ratio is UNREADABLE and NAMED, never guessed', () => {
    const m = computeWindowMove(
      [input('1:a', 'NOPE', 50), input('1:b', 'ONE', 50), input('1:c', 'ZERO', 50)],
      new Map([
        // 1:a absent entirely
        ['1:b', pts(1)], // one point — no window
        ['1:c', pts(0, 2)], // zero first — division would lie
      ]),
    )
    expect(m.rows).toEqual([])
    expect(m.unreadable).toBe(3)
    expect(m.unreadableSyms).toEqual(['NOPE', 'ONE', 'ZERO'])
  })

  it('finite-gates hostile series (the clamp law): NaN and Infinity never reach a pill', () => {
    const m = computeWindowMove(
      [input('1:a', 'NAN', 100), input('1:b', 'INF', 100)],
      new Map([
        ['1:a', pts(NaN, 2)],
        ['1:b', pts(Number.MIN_VALUE, Infinity)],
      ]),
    )
    expect(m.rows).toEqual([])
    expect(m.unreadable).toBe(2)
    expect(Number.isFinite(m.totalUsd)).toBe(true)
  })

  it('drops dust deltas and zero-value positions without counting them unreadable', () => {
    const m = computeWindowMove(
      [input('1:a', 'FLAT', 100), input('1:b', 'GONE', 0)],
      new Map([['1:a', pts(1, 1.00001)]]),
    )
    expect(m.rows).toEqual([])
    expect(m.unreadable).toBe(0)
  })
})
