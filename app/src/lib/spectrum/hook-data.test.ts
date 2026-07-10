import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, zeroAddress } from 'viem'
import { encodeMintHookData, encodeRedeemHookData } from './hook-data'

const TAG = '0x00000000000000000000000000000000000000A1' as const

function decode(hookData: `0x${string}`) {
  return decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256[]' }, { type: 'address' }], hookData) as readonly [
    bigint,
    readonly bigint[],
    string,
  ]
}

describe('encodeMintHookData (BUY — per-leg floors)', () => {
  it('encodes non-zero per-leg legMins + the frontend tag verbatim', () => {
    const r = encodeMintHookData({ quotedLegAmounts: [1000n, 2000n], slippageBps: 100, minOut: 5n, interfaceTag: TAG })
    expect(r.legMins).toEqual([990n, 1980n]) // ×(1 − 1%)
    const [minOut, legMins, frontend] = decode(r.hookData)
    expect(minOut).toBe(5n)
    expect(legMins).toEqual([990n, 1980n])
    expect(frontend.toLowerCase()).toBe(TAG.toLowerCase())
  })
  it('throws — no silent zero: empty quotes, a non-positive leg, or a rounded-zero floor', () => {
    expect(() => encodeMintHookData({ quotedLegAmounts: [], slippageBps: 100, minOut: 1n })).toThrow()
    expect(() => encodeMintHookData({ quotedLegAmounts: [0n], slippageBps: 100, minOut: 1n })).toThrow()
    // a 1-wei quote at 1% slippage floor-rounds to 0 → must abort, not ship a zero floor
    expect(() => encodeMintHookData({ quotedLegAmounts: [1n], slippageBps: 100, minOut: 1n })).toThrow()
  })
  it('defaults the frontend tag to address(0) when none is given', () => {
    const r = encodeMintHookData({ quotedLegAmounts: [1000n], slippageBps: 100, minOut: 1n })
    expect(r.frontend).toBe(zeroAddress)
  })
})

describe('encodeRedeemHookData (SELL — aggregate-minOut, zero per-leg floors)', () => {
  it('zero-fills legMins to the on-chain leg count + carries the aggregate minOut + tag', () => {
    const r = encodeRedeemHookData({ legCount: 3, minOut: 19_602_000n, interfaceTag: TAG })
    expect(r.legMins).toEqual([0n, 0n, 0n])
    expect(r.minOut).toBe(19_602_000n)
    const [minOut, legMins, frontend] = decode(r.hookData)
    expect(minOut).toBe(19_602_000n)
    expect(legMins).toEqual([0n, 0n, 0n]) // length matches basket; values 0 ⇒ no per-leg guard (by design)
    expect(frontend.toLowerCase()).toBe(TAG.toLowerCase())
  })
  it('requires a positive aggregate minOut (never an unprotected sell)', () => {
    expect(() => encodeRedeemHookData({ legCount: 3, minOut: 0n })).toThrow()
  })
  it('requires a positive on-chain leg count', () => {
    expect(() => encodeRedeemHookData({ legCount: 0, minOut: 1n })).toThrow()
  })
})
