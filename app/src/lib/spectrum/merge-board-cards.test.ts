import { describe, expect, it } from 'vitest'
import { mergeBoardCards } from './position-intents'

// the owner's live bug, pinned at the layer where it actually hurt. Dialling a
// basket showed "a ton of bento asset tiles for the one basket asset"; the
// tiles were the symptom, the composed plan was the injury.

type A = { chainId: number; address: string; symbol: string }
const key = (a: A) => `${a.chainId}:${a.address.toLowerCase()}`
const asset = (symbol: string, address = `0x${symbol.toLowerCase().padEnd(40, '0')}`): A => ({ chainId: 8453, address, symbol })
const pos = (a: A, valueUsd: number) => ({ asset: a, valueUsd, pct: 0 })

describe('the reshape board holds ONE card per asset', () => {
  it('an asset in BOTH the held book and the fresh picks yields one card, held winning', () => {
    const weth = asset('WETH')
    const cards = mergeBoardCards([pos(weth, 1000)], [weth], key)
    expect(cards).toHaveLength(1)
    expect(cards[0].isNew).toBe(false)
    // held wins: the true value survives, not the $0 placeholder
    expect(cards[0].p.valueUsd).toBe(1000)
  })

  it('THE MONEY CONSEQUENCE: a duplicate composed a sell AND a buy of one asset', () => {
    const weth = asset('WETH')
    const target = 500
    // what the old concatenation produced
    const naive = [{ p: pos(weth, 1000), isNew: false }, { p: pos(weth, 0), isNew: true }]
    const naiveDeltas = naive.map(({ p }) => target - p.valueUsd)
    expect(naiveDeltas).toEqual([-500, 500]) // opposing instructions, same asset
    expect(naiveDeltas.filter((d) => d > 0)).toHaveLength(1) // a phantom BUY —
    // and gross buys is the base the fee is charged on

    // what the guard produces
    const deltas = mergeBoardCards([pos(weth, 1000)], [weth], key).map(({ p }) => target - p.valueUsd)
    expect(deltas).toEqual([-500])
  })

  it('genuinely new picks still become cards, at $0', () => {
    const weth = asset('WETH')
    const aero = asset('AERO')
    const cards = mergeBoardCards([pos(weth, 1000)], [aero], key)
    expect(cards).toHaveLength(2)
    expect(cards.find((c) => c.p.asset.symbol === 'AERO')?.isNew).toBe(true)
    expect(cards.find((c) => c.p.asset.symbol === 'AERO')?.p.valueUsd).toBe(0)
  })

  it('repeated fresh entries collapse, however many times they were appended', () => {
    const aero = asset('AERO')
    expect(mergeBoardCards([], [aero, aero, aero, aero], key)).toHaveLength(1)
  })

  it('the same symbol on two chains is TWO assets, never merged', () => {
    const a = { chainId: 8453, address: '0xaaa', symbol: 'USDC' }
    const b = { chainId: 1, address: '0xaaa', symbol: 'USDC' }
    expect(mergeBoardCards([], [a, b], key)).toHaveLength(2)
  })

  it('matches on address, not symbol — an impostor is its own card', () => {
    const real = asset('PEPE', '0x1111111111111111111111111111111111111111')
    const fake = asset('PEPE', '0x2222222222222222222222222222222222222222')
    expect(mergeBoardCards([pos(real, 100)], [fake], key)).toHaveLength(2)
  })

  it('honours the skip predicate (cash is not a dialable card)', () => {
    const usdc = asset('USDC')
    const weth = asset('WETH')
    const cards = mergeBoardCards([pos(usdc, 500), pos(weth, 100)], [], key, (a) => a.symbol === 'USDC')
    expect(cards.map((c) => c.p.asset.symbol)).toEqual(['WETH'])
  })
})
