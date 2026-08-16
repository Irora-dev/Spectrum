import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, encodeAbiParameters, zeroAddress } from 'viem'
import {
  encodeMintHookData,
  encodeRedeemHookData,
  packLegMin,
  FLOOR_MASK,
  SPLIT_SHIFT,
  type MintFunding,
  type MintHookDataInput,
} from './hook-data'
import { decodeBareLegMin } from './contract-split'
import { INTERFACE_TAG_ADDRESS } from '../config/operator'

const TAG = '0x00000000000000000000000000000000000000A1' as const

/** The legacy shape: no split rides the payload (pre-packing basket, or a first mint). */
const NO_SPLIT: MintFunding = { source: 'basket-weights', because: 'pre-packing-deployment' }
const lens = (splitBps: number[]): MintFunding => ({ source: 'lens-split', splitBps })

function decode(hookData: `0x${string}`) {
  return decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256[]' }, { type: 'address' }], hookData) as readonly [
    bigint,
    readonly bigint[],
    string,
  ]
}

describe('encodeMintHookData (BUY — per-leg floors)', () => {
  it('encodes non-zero per-leg legMins + the frontend tag verbatim', () => {
    const r = encodeMintHookData({
      quotedLegAmounts: [1000n, 2000n],
      slippageBps: 100,
      minOut: 5n,
      interfaceTag: TAG,
      funding: NO_SPLIT,
    })
    expect(r.legMins).toEqual([990n, 1980n]) // ×(1 − 1%)
    const [minOut, legMins, frontend] = decode(r.hookData)
    expect(minOut).toBe(5n)
    expect(legMins).toEqual([990n, 1980n])
    expect(frontend.toLowerCase()).toBe(TAG.toLowerCase())
  })
  it('throws — no silent zero: empty quotes, a non-positive leg, or a rounded-zero floor', () => {
    expect(() => encodeMintHookData({ quotedLegAmounts: [], slippageBps: 100, minOut: 1n, funding: NO_SPLIT })).toThrow()
    expect(() => encodeMintHookData({ quotedLegAmounts: [0n], slippageBps: 100, minOut: 1n, funding: NO_SPLIT })).toThrow()
    // a 1-wei quote at 1% slippage floor-rounds to 0 → must abort, not ship a zero floor
    expect(() => encodeMintHookData({ quotedLegAmounts: [1n], slippageBps: 100, minOut: 1n, funding: NO_SPLIT })).toThrow()
  })
  it("defaults the frontend tag to the BUILD's tag, else address(0)", () => {
    // The fallback chain is input.interfaceTag ?? the build's configured tag ??
    // zero — pinning a bare zero made this fail on any checkout whose
    // .env.local sets VITE_INTERFACE_TAG_ADDRESS (vitest loads vite env).
    const r = encodeMintHookData({ quotedLegAmounts: [1000n], slippageBps: 100, minOut: 1n, funding: NO_SPLIT })
    expect(r.frontend).toBe(INTERFACE_TAG_ADDRESS ?? zeroAddress)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE ZERO-SPLIT BUG (contracts' test/KitZeroSplitProbe.t.sol, 2026-08-05).
//
// The kit sent plain floors in a NON-EMPTY payload. `_beforeSwap` reads
// `factory.bareLegMins` only when hookData is EMPTY, so `_acquireBasket` took the
// split from `legMins[i] >> 240` — zero on every leg — summed nonBufferWeight to
// zero, returned early and minted nothing: NoOutput (0x5a7cfa65) on a HEALTHY
// multi-leg basket. Measured beside it: the packed shape mints 4886 shares, empty
// hookData mints 4901. These tests exist so that shape cannot come back.
// ─────────────────────────────────────────────────────────────────────────────
describe('encodeMintHookData — the funding split rides bits [255:240]', () => {
  it('packs split and floor into one word per leg, and the word round-trips', () => {
    const r = encodeMintHookData({
      quotedLegAmounts: [1000n, 2000n, 4000n],
      slippageBps: 100,
      minOut: 7n,
      interfaceTag: TAG,
      funding: lens([2500, 2500, 5000]),
    })
    expect(r.legMins).toEqual([990n, 1980n, 3960n]) // the floors are untouched by packing
    const [, words] = decode(r.hookData)
    // Decoded by the module that reads the CHAIN's words: same layout both directions.
    expect(words.map((w) => decodeBareLegMin(w))).toEqual([
      { splitBps: 2500, floorRaw: 990n },
      { splitBps: 2500, floorRaw: 1980n },
      { splitBps: 5000, floorRaw: 3960n },
    ])
    expect(r.words).toEqual([...words])
  })

  it('NEVER encodes all-zero splits on a multi-leg buy (the measured revert)', () => {
    const r = encodeMintHookData({
      quotedLegAmounts: [1000n, 2000n],
      slippageBps: 100,
      minOut: 1n,
      funding: lens([4000, 6000]),
    })
    const [, words] = decode(r.hookData)
    expect(words.every((w) => w >> SPLIT_SHIFT === 0n)).toBe(false)
    expect(words.reduce((sum, w) => sum + (w >> SPLIT_SHIFT), 0n)).toBe(10_000n)
    // And a caller that hands over an all-zero split gets a throw, not a doomed payload.
    expect(() =>
      encodeMintHookData({ quotedLegAmounts: [1000n, 2000n], slippageBps: 100, minOut: 1n, funding: lens([0, 0]) }),
    ).toThrow(/zero on every leg/)
  })

  it('refuses to encode a buy that does not say where its funding split came from', () => {
    // The bug was reachable by OMISSION, so omission must be a throw — including
    // from JS callers that never see the type.
    const input = { quotedLegAmounts: [1000n, 2000n], slippageBps: 100, minOut: 1n } as unknown as MintHookDataInput
    expect(() => encodeMintHookData(input)).toThrow(/where its per-leg funding split comes from/)
    const bogus = { ...input, funding: { source: 'weights-i-made-up' } } as unknown as MintHookDataInput
    expect(() => encodeMintHookData(bogus)).toThrow(/where its per-leg funding split comes from/)
  })

  it('rejects a split that cannot describe this basket', () => {
    const base = { quotedLegAmounts: [1000n, 2000n], slippageBps: 100, minOut: 1n }
    expect(() => encodeMintHookData({ ...base, funding: lens([10_000]) })).toThrow(/does not match this basket/)
    expect(() => encodeMintHookData({ ...base, funding: lens([5000, 5000, 0]) })).toThrow(/does not match this basket/)
    for (const bad of [-1, 10_001, 65_535, 1.5, Number.NaN]) {
      expect(() => encodeMintHookData({ ...base, funding: lens([bad, 5000]) })).toThrow(/basis-point value/)
    }
  })

  it('ships NO floor on a leg the lens funds with nothing, and keeps the others', () => {
    // A zero-split leg is skipped by the acquire loop, so a floor there is a
    // guaranteed LegMinNotMet — the factory's own lens returns 0 for it too. Nothing
    // is unprotected: an unfunded leg is never swapped.
    const r = encodeMintHookData({
      quotedLegAmounts: [1000n, 0n, 2000n],
      slippageBps: 100,
      minOut: 1n,
      funding: lens([4000, 0, 6000]),
    })
    expect(r.legMins).toEqual([990n, 0n, 1980n])
    const [, words] = decode(r.hookData)
    expect(words[1]).toBe(0n) // no split, no floor: nothing rides an unfunded leg
    expect(decodeBareLegMin(words[2])).toEqual({ splitBps: 6000, floorRaw: 1980n })
  })

  it('still refuses when EVERY leg is unfunded, whatever the quotes say', () => {
    expect(() =>
      encodeMintHookData({ quotedLegAmounts: [1000n, 2000n], slippageBps: 100, minOut: 1n, funding: lens([0, 0]) }),
    ).toThrow()
  })

  it('FIRST MINT ON A PACKING DEPLOYMENT: packs the basket own weights, totalling 10000', () => {
    // The exception (mint-funding.ts). The lens refuses at supply 0 and zeros acquire
    // nothing, so the creator's own design weights ride the top bits — and they must
    // divide the WHOLE buy, because the USDC buffer leg takes `usdcNet × sp / 10000`
    // literally.
    const r = encodeMintHookData({
      quotedLegAmounts: [1000n, 2000n, 4000n],
      slippageBps: 100,
      minOut: 7n,
      interfaceTag: TAG,
      funding: { source: 'first-mint-weights', splitBps: [4000, 4000, 2000] },
    })
    expect(r.splitBps).toEqual([4000, 4000, 2000])
    expect(r.legMins).toEqual([990n, 1980n, 3960n]) // every leg keeps its floor
    const [, words] = decode(r.hookData)
    expect(words.reduce((sum, w) => sum + (w >> SPLIT_SHIFT), 0n)).toBe(10_000n)
    expect(words.map((w) => decodeBareLegMin(w))).toEqual([
      { splitBps: 4000, floorRaw: 990n },
      { splitBps: 4000, floorRaw: 1980n },
      { splitBps: 2000, floorRaw: 3960n },
    ])
  })

  it('a first mint refuses an unfunded leg or a split that does not divide the whole buy', () => {
    // A zero-split leg is skipped by the acquire loop while the first mint REQUIRES a
    // non-zero floor on every non-USDC leg (FirstMintLegMinRequired) — together they
    // revert. And a short total leaves the USDC buffer leg under-funded.
    const base = { quotedLegAmounts: [1000n, 2000n], slippageBps: 100, minOut: 1n }
    expect(() =>
      encodeMintHookData({ ...base, funding: { source: 'first-mint-weights', splitBps: [10_000, 0] } }),
    ).toThrow(/cannot leave a holding unfunded/)
    expect(() =>
      encodeMintHookData({ ...base, funding: { source: 'first-mint-weights', splitBps: [4000, 4000] } }),
    ).toThrow(/divide the whole buy/)
    expect(() =>
      encodeMintHookData({ ...base, funding: { source: 'first-mint-weights', splitBps: [6000, 5000] } }),
    ).toThrow(/divide the whole buy/)
    // and the ordinary guards still apply to this case
    expect(() =>
      encodeMintHookData({ ...base, funding: { source: 'first-mint-weights', splitBps: [10_000] } }),
    ).toThrow(/does not match this basket/)
    expect(() =>
      encodeMintHookData({ ...base, funding: { source: 'first-mint-weights', splitBps: [10_001, 1] } }),
    ).toThrow(/basis-point value/)
  })

  it('writes NOTHING in the top bits on a pre-packing deployment', () => {
    // A pre-D-R1 basket reads the WHOLE word as the floor: a packed split there is an
    // astronomical floor and LegMinNotMet on every buy. So the legacy shape must stay
    // byte-identical to plain floors.
    for (const because of ['pre-packing-deployment', 'first-mint'] as const) {
      const r = encodeMintHookData({
        quotedLegAmounts: [1000n, 2000n],
        slippageBps: 100,
        minOut: 1n,
        funding: { source: 'basket-weights', because },
      })
      expect(r.words).toEqual([990n, 1980n])
      expect(r.splitBps).toEqual([0, 0])
      expect(r.words.every((w) => w <= FLOOR_MASK)).toBe(true)
    }
  })

  it('a NON-PACKING first mint is byte-identical to the payload that shipped before', () => {
    // The regression pin for every basket live today. Adding the packing case must not
    // move a single byte on the generation that cannot read one.
    const args = { quotedLegAmounts: [1000n, 2000n, 4000n], slippageBps: 250, minOut: 42n, interfaceTag: TAG }
    const firstMint = encodeMintHookData({ ...args, funding: { source: 'basket-weights', because: 'first-mint' } })
    const prePacking = encodeMintHookData({
      ...args,
      funding: { source: 'basket-weights', because: 'pre-packing-deployment' },
    })
    expect(firstMint.hookData).toBe(prePacking.hookData)
    expect(firstMint.hookData).toBe(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256[]' }, { type: 'address' }],
        [42n, [975n, 1950n, 3900n], TAG],
      ),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE USDC BUFFER LEG — the commonest basket shape, and the one the contract
// funds by a different rule (SpectrumBasket._acquireBasket ~:641): the buffer leg
// is credited `usdcNet * sp / BPS` off the LITERAL 10000 and its floor is measured
// against that USDC amount 1:1 (6dp), while every other leg self-normalises
// against `nonBufferWeight`. Nothing about it rides in the ENCODER — one word
// layout serves every leg — and that is exactly what these rows pin, because the
// tempting "fixes" (top a short split up to 10000, let a split past BPS through)
// both break the buffer leg specifically.
//
// ⚠ AUDIT 2026-08-06: the shape had no fixture anywhere in the kit.
// ─────────────────────────────────────────────────────────────────────────────
describe('encodeMintHookData — a basket with a USDC buffer leg', () => {
  // 1000 USDC in at a 1% fee ⇒ usdNet = 990, priced by swap-quote at the 3%
  // default: AAA @ $2 and BBB @ $50 in leg tokens, USDC 1:1 at 6dp.
  const QUOTED = [198n * 10n ** 18n, 594_000_000n, 297_000_000n] // 40/30/30 of 990
  const BUFFER = 2

  it('packs the buffer leg USDC floor in the low 240 bits, beside its own split', () => {
    const r = encodeMintHookData({
      quotedLegAmounts: QUOTED,
      slippageBps: 300,
      minOut: 1n,
      interfaceTag: TAG,
      funding: lens([4000, 3000, 3000]),
    })
    // 288.090000 USDC: the audit's worked example, and what the contract's 297.000000
    // credit is checked against. Six-decimal settlement units, not a token count.
    expect(r.legMins[BUFFER]).toBe(288_090_000n)
    const [, words] = decode(r.hookData)
    expect(decodeBareLegMin(words[BUFFER])).toEqual({ splitBps: 3000, floorRaw: 288_090_000n })
    // a 6dp floor is nowhere near the split field, so nothing bleeds either way
    expect(words[BUFFER] & FLOOR_MASK).toBe(288_090_000n)
    expect(r.legMins[0]).toBe((QUOTED[0] * 9_700n) / 10_000n)
  })

  it('ships a 9999 lens split VERBATIM — topping it up would over-credit the buffer', () => {
    // The buffer leg takes its share off the literal 10000, so any "helpful"
    // normalisation hands it money the contract never derived for it. The lens
    // rounds each leg down and the contract expects the short total.
    const r = encodeMintHookData({
      quotedLegAmounts: QUOTED,
      slippageBps: 300,
      minOut: 1n,
      funding: lens([3333, 3333, 3333]),
    })
    expect(r.splitBps).toEqual([3333, 3333, 3333])
    const [, words] = decode(r.hookData)
    expect(words.reduce((sum, w) => sum + (w >> SPLIT_SHIFT), 0n)).toBe(9_999n)
  })

  it('refuses a buffer-leg split above 10000 before anything is encoded', () => {
    // The contract bounds a USDC leg at BPS (its phantom-reserve guard) and reverts
    // LegMinNotMet above it; unbounded, the audit measured a leg credited 6.5x what
    // was received. Both gates say no: the split validator and the word packer.
    const base = { quotedLegAmounts: QUOTED, slippageBps: 300, minOut: 1n }
    expect(() => encodeMintHookData({ ...base, funding: lens([4000, 3000, 10_001]) })).toThrow(/basis-point value/)
    expect(() => packLegMin(10_001, 288_090_000n)).toThrow(/basis-point value/)
    // and the legal edge still encodes (a buffer-only basket funded by the whole buy)
    expect(encodeMintHookData({ ...base, funding: lens([0, 0, 10_000]) }).splitBps).toEqual([0, 0, 10_000])
  })

  it('a FIRST MINT with a buffer leg must divide the whole buy, to the bps', () => {
    // Same rule, seen from the buffer leg: 9999 leaves it funded 999.9 bps short of
    // what the creator's own weights say, with nobody to make it up.
    const base = { quotedLegAmounts: QUOTED, slippageBps: 300, minOut: 1n }
    const ok = encodeMintHookData({ ...base, funding: { source: 'first-mint-weights', splitBps: [4000, 3000, 3000] } })
    expect(ok.legMins[BUFFER]).toBe(288_090_000n)
    expect(() =>
      encodeMintHookData({ ...base, funding: { source: 'first-mint-weights', splitBps: [3333, 3333, 3333] } }),
    ).toThrow(/divide the whole buy/)
  })
})

describe('packLegMin — the word layout itself', () => {
  it('puts the split in the high 16 bits and the floor in the low 240', () => {
    expect(packLegMin(3400, 123n)).toBe((3400n << 240n) | 123n)
    expect(decodeBareLegMin(packLegMin(425, FLOOR_MASK))).toEqual({ splitBps: 425, floorRaw: FLOOR_MASK })
    expect(packLegMin(0, 0n)).toBe(0n)
  })
  it('refuses values that would corrupt the other field', () => {
    expect(() => packLegMin(10_001, 1n)).toThrow(/basis-point value/)
    expect(() => packLegMin(-1, 1n)).toThrow(/basis-point value/)
    expect(() => packLegMin(1, FLOOR_MASK + 1n)).toThrow(/low 240 bits/)
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
  it('never packs a split on a sell (there is no funding to divide)', () => {
    const r = encodeRedeemHookData({ legCount: 3, minOut: 1n })
    expect(r.words).toEqual([0n, 0n, 0n])
    expect(r.splitBps).toEqual([0, 0, 0])
  })
})
