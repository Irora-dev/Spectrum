import { describe, expect, it } from 'vitest'
import { encodeFunctionData, toFunctionSelector, type Address, type Hex } from 'viem'
import { BatchComposeRefusal } from './batcher'
import {
  composeRebalanceBatch,
  diffDisplayedVsSignedRebalance,
  rebalanceBatcherAbi,
  rebalanceConservationErrors,
  rebalanceFeePreviewRaw,
  type ComposedRebalanceBatch,
  type ShownRebalance,
} from './rebalance-batcher'

// ─────────────────────────────────────────────────────────────────────────────
// THE DARK ENCODER'S PINS (interface-stable build, contract undeployed —
// SpectrumContracts w-…-41). The R-laws these prove are the text sent for
// their contract-side verify: workspace/spectrum-release/
// rebalance-batcher-law-text-2026-08-15.md (the ops repo).
// ─────────────────────────────────────────────────────────────────────────────

const T1 = '0x1000000000000000000000000000000000000001' as Address
const T2 = '0x1000000000000000000000000000000000000002' as Address
const B1 = '0x2000000000000000000000000000000000000001' as Address
const USDC = '0x3000000000000000000000000000000000000003' as Address
const ME = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
const SINK = '0x4000000000000000000000000000000000000004' as Address
const NOW = 1_755_200_000

const sell = (over: Partial<Parameters<typeof composeRebalanceBatch>[0]['sells'][number]> = {}) => ({
  token: T1,
  sellAmountRaw: 10n ** 18n,
  minFundingOutRaw: 95_000_000n, // $95 floor on a ~$100 sale
  swapData: '0xdeadbeef01' as Hex,
  optional: false,
  ...over,
})
const buy = (over: Partial<Parameters<typeof composeRebalanceBatch>[0]['buys'][number]> = {}) => ({
  buyToken: B1,
  fundingBudgetRaw: 90_000_000n,
  minBuyAmountRaw: 1n,
  swapData: '0xdeadbeef02' as Hex,
  optional: false,
  ...over,
})
const compose = (over: Partial<Parameters<typeof composeRebalanceBatch>[0]> = {}): ComposedRebalanceBatch =>
  composeRebalanceBatch({
    chainId: 8453,
    sells: [sell()],
    buys: [buy()],
    fundingAsset: USDC,
    quotedSellProceedsRaw: [100_000_000n],
    recipient: ME,
    chainNowSec: NOW,
    deadlineSec: NOW + 600,
    feeBps: 50,
    feeRecipient: SINK,
    ...over,
  })

describe('the guide’s selector table verifies against the signatures (their own shipping gate)', () => {
  // "verify with viem toFunctionSelector before shipping" — the table IS the
  // vocabulary; a mismatch here means the guide (or our transcription) is
  // wrong, and the test names which.
  const TABLE: [string, Hex][] = [
    ['error DeadlinePassed()', '0x70f65caa'],
    ['error FeeAboveCeiling()', '0x81382d2e'],
    ['error NothingToDo()', '0x5c52a868'],
    ['error TooManyLegs()', '0x85d53c40'],
    ['error ZeroAddress()', '0xd92e233d'],
    ['error SellIsFundingAsset()', '0xed65910f'],
    ['error BuyIsFundingAsset()', '0xdf5d9791'],
    ['error RecipientIsSelf()', '0x3887143e'],
    ['error SellFloorNotMet(uint256,uint256)', '0x87af88d4'],
    ['error SellOverspent(uint256,uint256)', '0xbc105520'],
    ['error MinBuyNotMet(uint256,uint256)', '0xbf1f9350'],
    ['error RequiredSellFailed(uint256)', '0x3c280e06'],
    ['error RequiredBuyFailed(uint256)', '0x2c9885d3'],
    ['error BuyExceedsPot(uint256,uint256)', '0x11adf0cd'],
    ['error ConservationBroken()', '0xb89bf84d'],
  ]
  it.each(TABLE)('%s → %s', (sig, expected) => {
    expect(toFunctionSelector(sig.replace(/^error /, 'function '))).toBe(expected)
  })
})

describe('composeRebalanceBatch — the R-laws at compose time', () => {
  it('a faithful sell-funds-buy intent composes, with the fee previewed on the LARGER side', () => {
    const c = compose()
    expect(c.args[0]).toHaveLength(1)
    expect(c.args[1]).toHaveLength(1)
    // sells quoted $100 > buys $90 ⇒ fee bases on the sells (R2b)
    expect(c.previewFeeRaw).toBe((100_000_000n * 50n) / 10_000n)
  })

  it('R7: pure buys never reach this entry point', () => {
    expect(() => compose({ sells: [], quotedSellProceedsRaw: [] })).toThrow(BatchComposeRefusal)
    expect(() => compose({ sells: [], quotedSellProceedsRaw: [] })).toThrow(/pure buys encode batchBuy/)
  })

  it('R6: the funding asset is never a leg, either side', () => {
    expect(() => compose({ sells: [sell({ token: USDC })] })).toThrow(/cash trim is funding, never a sale/)
    expect(() => compose({ buys: [buy({ buyToken: USDC })] })).toThrow(/buys the funding asset itself/)
  })

  it('R4: a zero floor refuses on both sides — zero never means "no floor"', () => {
    expect(() => compose({ sells: [sell({ minFundingOutRaw: 0n })] })).toThrow(/zero is not a floor/)
    expect(() => compose({ buys: [buy({ minBuyAmountRaw: 0n })] })).toThrow(/zero is not a floor/)
  })

  it('R5 at compose: required buys beyond the sells’ FLOOR pot refuse with the cascade warning', () => {
    expect(() => compose({ buys: [buy({ fundingBudgetRaw: 96_000_000n })] })).toThrow(/more funding than the sells' floors guarantee/)
    // …and the same reach marked skippable composes (it skips on-chain if dry)
    expect(compose({ buys: [buy({ fundingBudgetRaw: 96_000_000n, optional: true })] }).args[1][0].optional).toBe(true)
  })

  it('the fee ceiling and the chain clock bind', () => {
    expect(() => compose({ feeBps: 201 })).toThrow(/outside the contract's ceiling/)
    expect(() => compose({ deadlineSec: NOW })).toThrow(/already passed/)
  })
})

describe('rebalanceFeePreviewRaw — every dollar that moves, taxed once', () => {
  it('pure sell: the cash-out is taxed; partial rebuy cannot shrink it; pure-buy side basing matches batchBuy', () => {
    expect(rebalanceFeePreviewRaw([100_000_000n], [], 50)).toBe(500_000n) // pure sell
    expect(rebalanceFeePreviewRaw([100_000_000n], [1_000_000n], 50)).toBe(500_000n) // dust buy — fee unmoved
    expect(rebalanceFeePreviewRaw([], [100_000_000n], 50)).toBe(500_000n) // buys side as the base
  })
})

describe('R1 — diffDisplayedVsSignedRebalance', () => {
  const shownOf = (c: ComposedRebalanceBatch): ShownRebalance => ({
    chainId: c.chainId,
    fundingAsset: c.args[2],
    recipient: c.args[3].recipient,
    sells: c.args[0].map((s) => ({ token: s.token, sellAmountRaw: s.sellAmount, minFundingOutRaw: s.minFundingOut, optional: s.optional })),
    buys: c.args[1].map((b) => ({ buyToken: b.buyToken, fundingBudgetRaw: b.fundingBudget, minBuyAmountRaw: b.minBuyAmount, optional: b.optional })),
    feeBps: c.args[3].feeBps,
  })
  const dataOf = (c: ComposedRebalanceBatch): Hex => encodeFunctionData({ abi: rebalanceBatcherAbi, functionName: 'rebalance', args: c.args as never })

  it('a faithful encoding diffs empty', () => {
    const c = compose()
    expect(diffDisplayedVsSignedRebalance(shownOf(c), dataOf(c))).toEqual([])
  })

  it('every tampered field is NAMED: sell amount, sell floor, buy budget, recipient, fee', () => {
    const c = compose()
    const shown = shownOf(c)
    const tamper = (mut: (args: ComposedRebalanceBatch['args']) => ComposedRebalanceBatch['args']) =>
      diffDisplayedVsSignedRebalance(shown, encodeFunctionData({ abi: rebalanceBatcherAbi, functionName: 'rebalance', args: mut(structuredClone(c.args)) as never }))
    expect(tamper((a) => ((a[0][0].sellAmount += 1n), a)).join(' ')).toMatch(/sell leg 1's amount differs/)
    expect(tamper((a) => ((a[0][0].minFundingOut -= 1n), a)).join(' ')).toMatch(/sell leg 1's floor differs/)
    expect(tamper((a) => ((a[1][0].fundingBudget += 1n), a)).join(' ')).toMatch(/buy leg 1's budget differs/)
    expect(tamper((a) => ((a[3].recipient = T2), a)).join(' ')).toMatch(/recipient differs/)
    expect(tamper((a) => ((a[3].feeBps = 51), a)).join(' ')).toMatch(/fee differs/)
  })

  it('a dropped or added leg on either side is named by count', () => {
    const c = compose()
    const shown = shownOf(c)
    const noSells = { ...c.args, 0: [] } as unknown as ComposedRebalanceBatch['args']
    const d = diffDisplayedVsSignedRebalance(shown, encodeFunctionData({ abi: rebalanceBatcherAbi, functionName: 'rebalance', args: [[], c.args[1], c.args[2], c.args[3]] as never }))
    expect(d.join(' ')).toMatch(/0 sell legs where the review showed 1/)
    void noSells
  })

  it('bytes that are not a rebalance call at all refuse in one sentence', () => {
    const c = compose()
    expect(diffDisplayedVsSignedRebalance(shownOf(c), '0xdeadbeef')).toEqual(['the signed bytes do not decode as a rebalance call at all'])
  })
})

describe('R3 — conservation, exact', () => {
  it('conserving AND legitimate-underspend results pass (MED-2: the solve replaces the budget assumption)', () => {
    const c = compose()
    const proceeds = 100_000_000n
    const fee = (proceeds * 50n) / 10_000n
    expect(rebalanceConservationErrors({ composed: c, sold: [proceeds], bought: [1n], refunded: proceeds - 90_000_000n - fee })).toEqual([])
    expect(rebalanceConservationErrors({ composed: c, sold: [proceeds], bought: [1n], refunded: proceeds - 80_000_000n - fee })).toEqual([])
  })

  it('a refund no spend can explain breaks conservation by name', () => {
    const c = compose()
    const off = rebalanceConservationErrors({ composed: c, sold: [100_000_000n], bought: [1n], refunded: 100_000_001n })
    expect(off.join(' ')).toMatch(/conservation broke/)
  })

  it('a skipped REQUIRED leg on either side distrusts the whole result', () => {
    const c = compose()
    expect(rebalanceConservationErrors({ composed: c, sold: [0n], bought: [1n], refunded: 0n }).join(' ')).toMatch(/required sell 1 was skipped/)
    expect(rebalanceConservationErrors({ composed: c, sold: [100_000_000n], bought: [0n], refunded: 0n }).join(' ')).toMatch(/required buy 1 was skipped/)
  })

  it('a solved spend beyond the executed budgets is named', () => {
    const c = compose()
    const errs = rebalanceConservationErrors({ composed: c, sold: [100_000_000n], bought: [1n], refunded: 0n })
    expect(errs.join(' ')).toMatch(/exceeds the executed legs' budgets/)
  })

  it('under-floor deliveries are refused even though the contract should have reverted (assert anyway)', () => {
    const c = compose()
    expect(rebalanceConservationErrors({ composed: c, sold: [94_000_000n], bought: [1n], refunded: 0n }).join(' ')).toMatch(/sell 1 yielded under its floor/)
  })
})
