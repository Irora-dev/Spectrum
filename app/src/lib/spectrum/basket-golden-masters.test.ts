// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN MASTERS — basket-side composition pinned byte-exact for the
// portfolio/basket separation.
//
// The standing guarantee of that separation is BASKETS NEVER BREAK: the basket
// side's money composition must be provably byte-identical across every
// refactor step. This file records the exact outputs of every PURE exported
// composition/encoding/derivation function on the basket money path, against
// fixed representative inputs. Expected values are literals, computed once at
// recording time (2026-08-18, on hardening/wave-a) and embedded — that is what
// a golden master is.
//
// A FAILURE HERE MEANS BASKET MONEY BYTES CHANGED — THAT IS THE ALARM WORKING.
// The failing assertion prints the two byte strings; diff them, find the edit
// that moved a byte, and decide on the EDIT. Do NOT re-record these literals
// without a recorded decision (the product-separation plan is the register
// for such decisions).
//
// DETERMINISM RULE (the trap a prior recording attempt named): the hook-data
// encoders fall back to the env-dependent INTERFACE_TAG_ADDRESS
// (config/operator.ts — VITE_INTERFACE_TAG_ADDRESS / site-config feeWallet)
// when no interfaceTag is passed, so EVERY golden encode below passes an
// explicit interfaceTag. Never add a fixture that omits it: the expected bytes
// would depend on the checkout's .env.local.
//
// The NOT-PINNED block at the end of this file lists the basket-side surface
// these masters do NOT cover, and why. Absence is stated there, never implied.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest'
import {
  clampSlippageBps,
  deriveLegMins,
  encodeMintHookData,
  encodeRedeemHookData,
  packLegMin,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  WARN_SLIPPAGE_BPS,
  SPLIT_SHIFT,
  FLOOR_MASK,
  MAX_SPLIT_BPS,
} from './hook-data'
import { buildSwapQuote, toRaw, DEFAULT_MAX_PRICE_AGE_MS, type SwapQuoteInput } from './swap-quote'
import { decideMintFunding, firstMintShapeGapSentence, fundingSplitBpsOf } from './mint-funding'
import { decideFirstMintSplit, firstMintSplitFromWeights, WEIGHT_TOTAL_BPS } from './first-mint-split'
import {
  BARE_SPLIT_NOT_DERIVABLE_SELECTOR,
  MISSING_HOOK_DATA_SELECTOR,
  decodeBareLegMin,
} from './contract-split'
import { shownFloorMismatch, type ShownFloor } from './shown-floor'
import {
  encodeV3Path,
  maxInFor,
  minOutFor,
  splitAmountByBudgets,
  splitPotByWeight,
  FEE_TIERS,
  DELTA_SLIPPAGE_BPS,
  EXACT_OUT_HEADROOM_BPS,
} from './delta-trade'
import {
  feeSplit,
  frontendFlushFloorUsdc,
  frontendPotFlushable,
  PROTOCOL_FEE_MODEL,
  FEE_BOUNDS,
  FRONTEND_FLUSH_FLOOR_USDC,
} from './fee-model'

// Fixed fixture identities. TAG is the same explicit interface tag the
// hook-data suite uses; the token addresses are real mainnet ones (valid
// checksums, realistic shapes) used purely as inert byte fixtures.
const TAG = '0x00000000000000000000000000000000000000A1' as const
const ZERO = '0x0000000000000000000000000000000000000000' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const UNI = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' as const

// The audit's worked USDC-buffer example (hook-data.test.ts): 1000 USDC in at a
// 1% fee ⇒ usdNet 990, split 40/30/30 — AAA @ $2 (18dp), BBB @ $50 (6dp),
// USDC 1:1 (6dp).
const QUOTED_BUFFER = [198n * 10n ** 18n, 594_000_000n, 297_000_000n]

// ═════════════════════════════════════════════════════════════════════════════
// hook-data.ts — the wire bytes every buy/sell carries
// ═════════════════════════════════════════════════════════════════════════════

describe('GOLDEN hook-data — layout constants', () => {
  it('pins the word-layout and slippage constants', () => {
    expect(SPLIT_SHIFT).toBe(240n)
    expect(FLOOR_MASK).toBe(1766847064778384329583297500742918515827483896875618958121606201292619775n)
    expect(MAX_SPLIT_BPS).toBe(10_000)
    expect(DEFAULT_SLIPPAGE_BPS).toBe(300)
    expect(MAX_SLIPPAGE_BPS).toBe(500)
    expect(WARN_SLIPPAGE_BPS).toBe(400)
  })
})

describe('GOLDEN packLegMin', () => {
  it('pins the packed word for a mid split + small floor', () => {
    expect(packLegMin(3400, 123n)).toBe(
      6007280020246506720583211502525922953813445249377104457613461084394907238523n,
    )
  })
  it('pins the all-max word (split 10000, floor = FLOOR_MASK)', () => {
    expect(packLegMin(10_000, FLOOR_MASK)).toBe(
      17670237494848621680162558304929928076790666452653065200174183619127490379775n,
    )
  })
  it('pins the zero word', () => {
    expect(packLegMin(0, 0n)).toBe(0n)
  })
})

describe('GOLDEN clampSlippageBps', () => {
  it('pins the clamp at every edge', () => {
    expect(clampSlippageBps(Number.NaN)).toBe(300)
    expect(clampSlippageBps(0)).toBe(1)
    expect(clampSlippageBps(250)).toBe(250)
    expect(clampSlippageBps(799.6)).toBe(500)
    expect(clampSlippageBps(-5)).toBe(1)
    expect(clampSlippageBps(3.4)).toBe(3)
  })
})

describe('GOLDEN deriveLegMins', () => {
  it('pins the 1%-haircut floors', () => {
    expect(deriveLegMins([1000n, 2000n], 100)).toEqual([990n, 1980n])
  })
  it('pins the 3%-haircut floors on the buffer-basket quote', () => {
    expect(deriveLegMins(QUOTED_BUFFER, 300)).toEqual([
      192_060_000_000_000_000_000n,
      576_180_000n,
      288_090_000n,
    ])
  })
  it('pins the clamp path: 9999 bps clamps to the 500 cap', () => {
    expect(deriveLegMins([10n ** 18n], 9999)).toEqual([950_000_000_000_000_000n])
  })
})

describe('GOLDEN encodeMintHookData — explicit interfaceTag on every fixture', () => {
  it('pins the lens-split buffer-basket payload byte-exact', () => {
    const r = encodeMintHookData({
      quotedLegAmounts: QUOTED_BUFFER,
      slippageBps: 300,
      minOut: 950_000_000_000_000_000_000n,
      interfaceTag: TAG,
      funding: { source: 'lens-split', splitBps: [4000, 3000, 3000] },
    })
    expect(r.hookData).toBe(
      '0x0000000000000000000000000000000000000000000000337fe5feaf2d180000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000000000030fa00000000000000000000000000000000000000000000a695e306c298600000bb800000000000000000000000000000000000000000000000000002257cf200bb80000000000000000000000000000000000000000000000000000112be790',
    )
    expect(r.legMins).toEqual([192_060_000_000_000_000_000n, 576_180_000n, 288_090_000n])
    expect(r.words).toEqual([
      7067388259113537318333190002971674063309935587502475832678484805170479104000n,
      5300541194335152988749892502228755547482451690626856874364818603878435508000n,
      5300541194335152988749892502228755547482451690626856874364818603878147418000n,
    ])
    expect(r.splitBps).toEqual([4000, 3000, 3000])
    expect(r.minOut).toBe(950_000_000_000_000_000_000n)
    expect(r.frontend).toBe(TAG)
  })

  it('pins the first-mint-weights payload byte-exact (split totals the whole buy)', () => {
    const r = encodeMintHookData({
      quotedLegAmounts: [1000n, 2000n, 4000n],
      slippageBps: 100,
      minOut: 7n,
      interfaceTag: TAG,
      funding: { source: 'first-mint-weights', splitBps: [4000, 4000, 2000] },
    })
    expect(r.hookData).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000000000030fa00000000000000000000000000000000000000000000000000000000003de0fa00000000000000000000000000000000000000000000000000000000007bc07d0000000000000000000000000000000000000000000000000000000000f78',
    )
    expect(r.legMins).toEqual([990n, 1980n, 3960n])
    expect(r.words).toEqual([
      7067388259113537318333190002971674063309935587502475832486424805170479104990n,
      7067388259113537318333190002971674063309935587502475832486424805170479105980n,
      3533694129556768659166595001485837031654967793751237916243212402585239555960n,
    ])
    expect(r.splitBps).toEqual([4000, 4000, 2000])
    expect(r.minOut).toBe(7n)
    expect(r.frontend).toBe(TAG)
  })

  it('pins the legacy (basket-weights) payload byte-exact — nothing in the top bits', () => {
    // The generation every pre-packing basket reads: the whole word is the floor.
    const r = encodeMintHookData({
      quotedLegAmounts: [1000n, 2000n, 4000n],
      slippageBps: 250,
      minOut: 42n,
      interfaceTag: TAG,
      funding: { source: 'basket-weights', because: 'pre-packing-deployment' },
    })
    expect(r.hookData).toBe(
      '0x000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a1000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000003cf000000000000000000000000000000000000000000000000000000000000079e0000000000000000000000000000000000000000000000000000000000000f3c',
    )
    expect(r.legMins).toEqual([975n, 1950n, 3900n])
    expect(r.words).toEqual([975n, 1950n, 3900n])
    expect(r.splitBps).toEqual([0, 0, 0])
    expect(r.minOut).toBe(42n)
    expect(r.frontend).toBe(TAG)
  })

  it('pins the unfunded-leg payload byte-exact — a zero-split leg ships an all-zero word', () => {
    const r = encodeMintHookData({
      quotedLegAmounts: [1000n, 0n, 2000n],
      slippageBps: 100,
      minOut: 1n,
      interfaceTag: TAG,
      funding: { source: 'lens-split', splitBps: [4000, 0, 6000] },
    })
    expect(r.hookData).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a100000000000000000000000000000000000000000000000000000000000000030fa00000000000000000000000000000000000000000000000000000000003de000000000000000000000000000000000000000000000000000000000000000017700000000000000000000000000000000000000000000000000000000007bc',
    )
    expect(r.legMins).toEqual([990n, 0n, 1980n])
    expect(r.words).toEqual([
      7067388259113537318333190002971674063309935587502475832486424805170479104990n,
      0n,
      10601082388670305977499785004457511094964903381253713748729637207755718657980n,
    ])
    expect(r.splitBps).toEqual([4000, 0, 6000])
    expect(r.frontend).toBe(TAG)
  })
})

describe('GOLDEN encodeRedeemHookData — explicit interfaceTag on every fixture', () => {
  it('pins the 3-leg sell payload byte-exact (zero per-leg floors, aggregate minOut)', () => {
    const r = encodeRedeemHookData({ legCount: 3, minOut: 19_602_000n, interfaceTag: TAG })
    expect(r.hookData).toBe(
      '0x00000000000000000000000000000000000000000000000000000000012b1a50000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a10000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    )
    expect(r.legMins).toEqual([0n, 0n, 0n])
    expect(r.words).toEqual([0n, 0n, 0n])
    expect(r.splitBps).toEqual([0, 0, 0])
    expect(r.minOut).toBe(19_602_000n)
    expect(r.frontend).toBe(TAG)
  })

  it('pins the 5-leg sell payload with an explicit zero tag byte-exact', () => {
    // An explicit address(0) is a DETERMINISTIC input (?? passes any string
    // through) — distinct from omitting the tag, which reads env and is banned here.
    const r = encodeRedeemHookData({ legCount: 5, minOut: 123_456_789n, interfaceTag: ZERO })
    expect(r.hookData).toBe(
      '0x00000000000000000000000000000000000000000000000000000000075bcd1500000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    )
    expect(r.legMins).toEqual([0n, 0n, 0n, 0n, 0n])
    expect(r.minOut).toBe(123_456_789n)
    expect(r.frontend).toBe(ZERO)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// swap-quote.ts — the floor derivation the encoder is fed from
// ═════════════════════════════════════════════════════════════════════════════

describe('GOLDEN toRaw', () => {
  it('pins the raw scalings, including the float-precision artifact', () => {
    expect(toRaw(250, 18)).toBe(250_000_000_000_000_000_000n)
    expect(toRaw(0.1, 6)).toBe(100_000n)
    // The IEEE-754/toFixed artifact IS part of the pinned bytes: a refactor that
    // changes the float pathway changes floors, and must fail here.
    expect(toRaw(1.123456789012345678901, 18)).toBe(1_123_456_789_012_345_691n)
    expect(toRaw(0.000000001, 6)).toBe(0n)
  })
  it('pins the exported staleness default beside it', () => {
    expect(DEFAULT_MAX_PRICE_AGE_MS).toBe(60_000)
  })
})

describe('GOLDEN buildSwapQuote', () => {
  // 3-leg buffer basket, mixed decimals — same economics as QUOTED_BUFFER:
  // $1000 buy, 1% fee, 3% slippage, NAV $1/share.
  const HOLDINGS = [
    { symbol: 'AAA', decimals: 18, targetWeightPct: 40, priceUsd: 2 },
    { symbol: 'BBB', decimals: 6, targetWeightPct: 30, priceUsd: 50 },
    { symbol: 'USDC', decimals: 6, targetWeightPct: 30, priceUsd: 1 },
  ]
  const BASE: SwapQuoteInput = {
    side: 'buy',
    amount: 1000,
    navPerToken: 1,
    feeFrac: 0.01,
    slippageBps: 300,
    holdings: HOLDINGS,
    basketDecimals: 18,
    settlementDecimals: 6,
  }

  it('pins the frictionless (nav-basis) BUY quote in full', () => {
    expect(buildSwapQuote(BASE)).toEqual({
      quotedLegAmounts: [198_000_000_000_000_000_000n, 5_940_000n, 297_000_000n],
      amountRaw: 1_000_000_000n,
      minOutRaw: 960_300_000_000_000_000_000n,
      legCount: 3,
      legs: [
        { symbol: 'AAA', decimals: 18, min: 192_060_000_000_000_000_000n },
        { symbol: 'BBB', decimals: 6, min: 5_761_800n },
        { symbol: 'USDC', decimals: 6, min: 288_090_000n },
      ],
      expectedOutRaw: 990_000_000_000_000_000_000n,
      basis: 'nav',
    })
  })

  it('pins the split-priced BUY quote in full — legs funded by the SPLIT, not the weights', () => {
    expect(buildSwapQuote({ ...BASE, fundingSplitBps: [5000, 2000, 3000] })).toEqual({
      quotedLegAmounts: [247_500_000_000_000_000_000n, 3_960_000n, 297_000_000n],
      amountRaw: 1_000_000_000n,
      minOutRaw: 960_300_000_000_000_000_000n,
      legCount: 3,
      legs: [
        { symbol: 'AAA', decimals: 18, min: 240_075_000_000_000_000_000n },
        { symbol: 'BBB', decimals: 6, min: 3_841_200n },
        { symbol: 'USDC', decimals: 6, min: 288_090_000n },
      ],
      expectedOutRaw: 990_000_000_000_000_000_000n,
      basis: 'nav',
    })
  })

  it('pins the simulated-basis BUY quote in full — survival-deflated floors', () => {
    // realised 900e18 vs frictionless 990e18 ⇒ every leg scaled by 900/990.
    expect(
      buildSwapQuote({ ...BASE, fundingSplitBps: [4000, 3000, 3000], realisedOutRaw: 900n * 10n ** 18n }),
    ).toEqual({
      quotedLegAmounts: [180_000_000_000_000_000_000n, 5_400_000n, 270_000_000n],
      amountRaw: 1_000_000_000n,
      minOutRaw: 873_000_000_000_000_000_000n,
      legCount: 3,
      legs: [
        { symbol: 'AAA', decimals: 18, min: 174_600_000_000_000_000_000n },
        { symbol: 'BBB', decimals: 6, min: 5_238_000n },
        { symbol: 'USDC', decimals: 6, min: 261_900_000n },
      ],
      expectedOutRaw: 900_000_000_000_000_000_000n,
      basis: 'simulated',
    })
  })

  it('pins the SELL quote in full — aggregate-minOut protected, no per-leg floors', () => {
    expect(
      buildSwapQuote({
        side: 'sell',
        amount: 10,
        navPerToken: 2,
        feeFrac: 0.01,
        slippageBps: 100,
        holdings: HOLDINGS,
        basketDecimals: 18,
        settlementDecimals: 6,
      }),
    ).toEqual({
      quotedLegAmounts: [],
      amountRaw: 10_000_000_000_000_000_000n,
      minOutRaw: 19_602_000n,
      legCount: 3,
      legs: [],
      expectedOutRaw: 19_800_000n,
      basis: 'nav',
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// mint-funding.ts — the provenance decision the payload is built on
// ═════════════════════════════════════════════════════════════════════════════

describe('GOLDEN decideMintFunding', () => {
  it('pins the lens answer passed through untouched', () => {
    expect(
      decideMintFunding(
        { kind: 'ok', legs: [{ splitBps: 2500, floorRaw: 990n }, { splitBps: 7500, floorRaw: 1980n }] },
        { legCount: 2, firstMint: false },
      ),
    ).toEqual({
      ok: true,
      packed: true,
      funding: { source: 'lens-split', splitBps: [2500, 7500] },
    })
  })

  it('pins the packing first mint carrying the design-weight split', () => {
    expect(
      decideMintFunding(
        { kind: 'unavailable' },
        {
          legCount: 2,
          firstMint: true,
          firstMintSplit: { source: 'basket-design-weights', splitBps: [6000, 4000] },
        },
      ),
    ).toEqual({
      ok: true,
      packed: true,
      funding: { source: 'first-mint-weights', splitBps: [6000, 4000] },
    })
  })

  it('pins the pre-packing deployment landing on the legacy shape', () => {
    expect(
      decideMintFunding({ kind: 'unavailable', why: 'no-function' }, { legCount: 2, firstMint: false }),
    ).toEqual({
      ok: true,
      packed: false,
      funding: { source: 'basket-weights', because: 'pre-packing-deployment' },
    })
  })

  it('pins the named refusal verbatim', () => {
    expect(decideMintFunding({ kind: 'not-derivable', named: true }, { legCount: 2, firstMint: false })).toEqual({
      ok: false,
      reason:
        'This basket cannot be funded safely right now: the contract could not work out how much of your buy each holding should get.',
      retryable: true,
    })
  })

  it('pins the read-failed refusal verbatim (never a generation downgrade)', () => {
    expect(
      decideMintFunding({ kind: 'unavailable', why: 'read-failed' }, { legCount: 2, firstMint: false }),
    ).toEqual({
      ok: false,
      reason: 'Could not read how this basket splits a buy across its holdings. Check your connection and try again.',
      retryable: true,
    })
  })
})

describe('GOLDEN fundingSplitBpsOf', () => {
  it('pins the pricing-side view of each funding case', () => {
    expect(fundingSplitBpsOf({ source: 'lens-split', splitBps: [2500, 7500] })).toEqual([2500, 7500])
    expect(fundingSplitBpsOf({ source: 'basket-weights', because: 'first-mint' })).toBeNull()
    expect(fundingSplitBpsOf({ source: 'first-mint-weights', splitBps: [6000, 4000] })).toEqual([6000, 4000])
  })
})

describe('GOLDEN firstMintShapeGapSentence', () => {
  it('pins the mislabeled-deployment sentence verbatim', () => {
    expect(
      firstMintShapeGapSentence({
        firstMint: true,
        funding: { source: 'basket-weights', because: 'first-mint' },
        resolvedProbeAnswered: false,
        weightsProbeAnswered: true,
      }),
    ).toBe(
      'This first buy went out without its funding split: the deployment entry for this chain is not marked as a packing factory (deployments.json packsFundingSplit), so the payload used the older no-split shape, and this basket generation then buys nothing and refuses. ' +
        'A probe with the split packed succeeds, so the pools and the amount are fine. ' +
        'Set packsFundingSplit to true on this chain’s deployments entry and retry.',
    )
  })
  it('pins the quiet path (resolved payload probes fine → no sentence)', () => {
    expect(
      firstMintShapeGapSentence({
        firstMint: true,
        funding: { source: 'basket-weights', because: 'first-mint' },
        resolvedProbeAnswered: true,
        weightsProbeAnswered: true,
      }),
    ).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// first-mint-split.ts — the one lawful weight→split conversion
// ═════════════════════════════════════════════════════════════════════════════

describe('GOLDEN firstMintSplitFromWeights', () => {
  it('pins the constant + the identity case (on-chain weights already total 10000)', () => {
    expect(WEIGHT_TOTAL_BPS).toBe(10_000)
    expect(firstMintSplitFromWeights([4000, 3500, 2500], 3)).toEqual({
      source: 'basket-design-weights',
      splitBps: [4000, 3500, 2500],
    })
  })
  it('pins the residual landing on the heaviest leg (earliest on ties)', () => {
    expect(firstMintSplitFromWeights([3333, 3333, 3333], 3)).toEqual({
      source: 'basket-design-weights',
      splitBps: [3334, 3333, 3333],
    })
  })
  it('pins the scale-up of small integer weights', () => {
    expect(firstMintSplitFromWeights([1, 1, 2], 3)).toEqual({
      source: 'basket-design-weights',
      splitBps: [2500, 2500, 5000],
    })
  })
})

describe('GOLDEN decideFirstMintSplit', () => {
  const FACTORY = '0xfac70fac70fac70fac70fac70fac70fac70fac7' as const
  it('pins the packing factory (case-insensitive match) handing over the split', () => {
    expect(
      decideFirstMintSplit({
        packsFundingSplit: true,
        currentFactory: FACTORY,
        factory: '0xFAC70FAC70FAC70FAC70FAC70FAC70FAC70FAC7',
        weightsBps: [4000, 3500, 2500],
        legCount: 3,
      }),
    ).toEqual({
      kind: 'ok',
      split: { source: 'basket-design-weights', splitBps: [4000, 3500, 2500] },
    })
  })
  it('pins the not-packing outcomes: flag off, and a lineage/factory mismatch', () => {
    expect(
      decideFirstMintSplit({
        packsFundingSplit: false,
        currentFactory: FACTORY,
        factory: FACTORY,
        weightsBps: [4000, 3500, 2500],
        legCount: 3,
      }),
    ).toEqual({ kind: 'not-packing' })
    expect(
      decideFirstMintSplit({
        packsFundingSplit: true,
        currentFactory: '0x1111111111111111111111111111111111111111',
        factory: FACTORY,
        weightsBps: [4000, 3500, 2500],
        legCount: 3,
      }),
    ).toEqual({ kind: 'not-packing' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// contract-split.ts — the pure decode of the chain's own words
// ═════════════════════════════════════════════════════════════════════════════

describe('GOLDEN decodeBareLegMin', () => {
  it('pins the decode of a packed word, a plain floor, and the max-split word', () => {
    expect(decodeBareLegMin((2500n << 240n) | 990n)).toEqual({ splitBps: 2500, floorRaw: 990n })
    expect(decodeBareLegMin(123_456_789n)).toEqual({ splitBps: 0, floorRaw: 123_456_789n })
    expect(decodeBareLegMin((10_000n << 240n) | 10n ** 30n)).toEqual({
      splitBps: 10_000,
      floorRaw: 1_000_000_000_000_000_000_000_000_000_000n,
    })
  })
})

describe('GOLDEN revert selectors', () => {
  it('pins the 4-byte selectors matched against revert data', () => {
    expect(BARE_SPLIT_NOT_DERIVABLE_SELECTOR).toBe('0xebb958bd')
    expect(MISSING_HOOK_DATA_SELECTOR).toBe('0x59fa5efa')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// shown-floor.ts — the displayed-vs-signed gate's exact answers
// ═════════════════════════════════════════════════════════════════════════════

describe('GOLDEN shownFloorMismatch', () => {
  const CLAIM: ShownFloor = {
    minOutRaw: 1_000_000n,
    quotedInRaw: 500_000_000n,
    floorBasis: 'simulated',
    basket: '0x000000000000000000000000000000000000BA5E',
    chainId: 8453,
    direction: 'buy',
  }
  it('pins the broken-promise refusal verbatim', () => {
    expect(shownFloorMismatch(CLAIM, 500_000_000n, 999_999n)).toBe(
      'The price moved while you were signing. Check the new number and try again.',
    )
  })
  it('pins the wrong-trade refusal verbatim', () => {
    expect(
      shownFloorMismatch(CLAIM, 500_000_000n, 1_000_000n, {
        basket: '0x000000000000000000000000000000000000D1FF',
        chainId: 8453,
        direction: 'buy',
      }),
    ).toBe('The screen changed while you were confirming. Check the amounts and try again.')
  })
  it('pins the four sign-paths (no claim / nav basis / input changed / exact match) as null', () => {
    expect(shownFloorMismatch(null, 1n, 2n)).toBeNull()
    expect(shownFloorMismatch({ ...CLAIM, floorBasis: 'nav' }, 500_000_000n, 999_999n)).toBeNull()
    expect(shownFloorMismatch(CLAIM, 400_000_000n, 999_999n)).toBeNull()
    expect(shownFloorMismatch(CLAIM, 500_000_000n, 1_000_000n)).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// delta-trade.ts — migration delta math + V3 path bytes
// ═════════════════════════════════════════════════════════════════════════════

describe('GOLDEN delta-trade constants', () => {
  it('pins the tiers and slippage/headroom guards', () => {
    expect([...FEE_TIERS]).toEqual([500, 3000, 10000])
    expect(DELTA_SLIPPAGE_BPS).toBe(100n)
    expect(EXACT_OUT_HEADROOM_BPS).toBe(100n)
  })
})

describe('GOLDEN encodeV3Path', () => {
  it('pins the single-hop packed path byte-exact', () => {
    expect(encodeV3Path([USDC, WETH], [500])).toBe(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb480001f4c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    )
  })
  it('pins the two-hop packed path byte-exact', () => {
    expect(encodeV3Path([USDC, WETH, UNI], [500, 3000])).toBe(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb480001f4c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000bb81f9840a85d5af5bf1d1762f925bdaddc4201f984',
    )
  })
})

describe('GOLDEN minOutFor / maxInFor', () => {
  it('pins the default-slippage guards and their rounding directions', () => {
    expect(minOutFor(1_000_000n)).toBe(990_000n)
    expect(minOutFor(999n)).toBe(989n) // floor
    expect(maxInFor(1_000_000n)).toBe(1_010_000n)
    expect(maxInFor(999n)).toBe(1_009n) // ceil
  })
  it('pins an explicit-slippage pair', () => {
    expect(minOutFor(1_000_000n, 250n)).toBe(975_000n)
    expect(maxInFor(1_000_000n, 250n)).toBe(1_025_000n)
  })
})

describe('GOLDEN splitPotByWeight / splitAmountByBudgets', () => {
  it('pins the pot split with an awkward remainder (last leg takes it)', () => {
    expect(splitPotByWeight(10n ** 18n + 7n, [2500, 2500, 5000])).toEqual([
      250_000_000_000_000_001n,
      250_000_000_000_000_001n,
      500_000_000_000_000_005n,
    ])
    expect(splitPotByWeight(123n, [4000])).toEqual([123n])
  })
  it('pins the budget split (last NON-ZERO budget takes the remainder)', () => {
    expect(splitAmountByBudgets(10n ** 18n + 7n, [10n ** 18n, 10n ** 18n, 2n * 10n ** 18n, 0n])).toEqual([
      250_000_000_000_000_001n,
      250_000_000_000_000_001n,
      500_000_000_000_000_005n,
      0n,
    ])
    expect(splitAmountByBudgets(123n, [7n])).toEqual([123n])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// fee-model.ts — the waterfall the basket's fee actually pays
// ═════════════════════════════════════════════════════════════════════════════

describe('GOLDEN fee-model constants', () => {
  it('pins the protocol constants object in full', () => {
    expect(PROTOCOL_FEE_MODEL).toEqual({
      MIN_BASKET_FEE_BPS: 100,
      MAX_BASKET_FEE_BPS: 300,
      BURN_SHARE_BPS: 2_500,
      INTERFACE_SHARE_BPS: 555,
      LAUNCHER_SHARE_BPS: 555,
      MAX_CREATOR_SHARE_BPS: 3_000,
      CRANK_BOUNTY_BPS: 50,
      LEAGUE_SHARE_BPS: 500,
    })
    expect(FEE_BOUNDS).toEqual({
      minFeeBps: 100,
      maxFeeBps: 300,
      burnShareBps: 2_500,
      interfaceShareBps: 555,
      launcherShareBps: 555,
      maxCreatorShareBps: 3_000,
    })
    expect(FRONTEND_FLUSH_FLOOR_USDC).toEqual({ 1: 10 })
  })
})

describe('GOLDEN feeSplit', () => {
  it('pins the full waterfall, interface + launcher present, no league', () => {
    expect(feeSplit(3000, { hasInterface: true, hasLauncher: true })).toEqual({
      league: 0,
      burn: 0.25,
      interface: 0.041625,
      launcher: 0.041625,
      creator: 0.200025,
      holders: 0.466725,
    })
  })
  it('pins the league-diluted waterfall (500 bps off the top)', () => {
    expect(feeSplit(3000, { hasInterface: true, hasLauncher: true, leagueBps: 500 })).toEqual({
      league: 0.05,
      burn: 0.2375,
      interface: 0.03954375,
      launcher: 0.03954375,
      creator: 0.19002375,
      holders: 0.44338875,
    })
  })
  it('pins the bare waterfall (no skims, no creator share)', () => {
    expect(feeSplit(0, { hasInterface: false, hasLauncher: false })).toEqual({
      league: 0,
      burn: 0.25,
      interface: 0,
      launcher: 0,
      creator: 0,
      holders: 0.75,
    })
  })
})

describe('GOLDEN frontend flush floor', () => {
  it('pins the per-chain floors and the flushability decision', () => {
    expect(frontendFlushFloorUsdc(1)).toBe(10)
    expect(frontendFlushFloorUsdc(8453)).toBe(0)
    expect(frontendPotFlushable(1, 10)).toBe(false) // AT the floor is not flushable
    expect(frontendPotFlushable(1, 10.5)).toBe(true)
    expect(frontendPotFlushable(8453, 0.01)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// NOT PINNED — the basket-side surface these golden masters do NOT cover.
// The uncovered surface is stated here so absence never reads as coverage.
//
// · use-basket-swap.ts — useBasketSwap, the entire hook. React/wagmi state
//   machine: allowance reads, approve/simulate/broadcast lifecycle, and the
//   final assembly of the swapExactIn callArgs (basket, tokenIn, amountRaw,
//   minOutRaw, hookData, to) happen only with a connected client + wallet.
//   Its interfaceTag comes from getStoredRef (localStorage) and its decimals
//   law from verifiedSettlementDecimals (a chain read). The ENCODERS it drives
//   are pinned above via hook-data.ts, but the hook's own arg composition is
//   not — a refactor could reorder/replace those args without failing this
//   file. Cover it at the integration layer, not by faking wagmi here.
// · hook-data.ts — the interfaceTag DEFAULT path (input.interfaceTag ??
//   INTERFACE_TAG_ADDRESS ?? zeroAddress). Deliberately unpinned: it resolves
//   from VITE_INTERFACE_TAG_ADDRESS / site-config feeWallet, so its output is
//   a property of the checkout's env, not of the code. Every fixture above
//   passes an explicit tag instead (the determinism trap this file's header
//   names).
// · swap-sim.ts — simulateSwapOut and findMaxSafe: eth_call simulations
//   against a live router (impure). Their internal probe-payload assembly and
//   the allowanceSlot storage-slot derivation are module-private (not
//   exported), so the probe bytes cannot be pinned without a network mock,
//   which would pin the mock rather than the wire.
// · mint-funding.ts — lensFactoryFor and resolveMintFunding: on-chain lineage
//   + lens reads. Their pure decision core (decideMintFunding) IS pinned.
// · first-mint-split.ts — firstMintSplitFor: deployments.json + on-chain
//   weight read. Its pure core (decideFirstMintSplit, firstMintSplitFromWeights)
//   IS pinned.
// · contract-split.ts — readContractSplit: network read plus classification of
//   live viem/transport error shapes (looksLikeEvmAnswer/revertDataOf are
//   module-private). The pure word decode and both revert selectors ARE pinned.
// · delta-trade.ts — quoteExactInPath, bestExactInTier, bestExactOutTier,
//   quoteBuyLegFills: QuoterV2 lens calls (impure). The pure path encoding,
//   slippage guards and pot/budget splits ARE pinned.
// · buildSwapQuote's refusal (null) paths and the encoders' throw paths are
//   behaviour, not bytes — they are asserted exhaustively in the modules' own
//   test files (hook-data.test.ts, swap-quote.test.ts), not re-pinned here.
// ─────────────────────────────────────────────────────────────────────────────
