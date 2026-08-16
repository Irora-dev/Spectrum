import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { deploymentFor } from '../chain/deployments'
import type { ChainNeed } from './funding-plan'
import { FundingPlanContractError } from './funding-plan'
import { DEFAULT_SLIPPAGE_BPS } from './hook-data'
import { LIFI_NATIVE, type LifiQuote, type LifiQuoteArgs } from './lifi'
import {
  composePayFunding,
  firstBuyFloorLine,
  formatAssetCeil,
  formatAssetFloor,
  readPayAssetOptions,
  setThesisPayChoice,
  thesisPayChoice,
  thesisPayKey,
  type PayAssetIo,
  type PayAssetOption,
} from './thesis-pay-asset'
import type { PerChainFunds } from './thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// THE PAY-ASSET COMPOSER, PINNED. This is the module the 2026-08-13 ruling
// built ("you should probably be able to select the asset you want to swap out
// of here right?" — the owner's own 2026-08-11 question, ruled after an ETH-only
// wallet watched every leg refuse). The laws under test: only held+readable
// assets are offered; a conversion is sized so the QUOTE'S OWN floor covers
// the shortfall; a failed quote / unreadable price / unreadable balance is a
// NAMED refusal, never a guessed rate; a gap speaks in the pay asset's units;
// no refuel ever rides a conversion, so a gas-short destination refuses.
// The quote seam is scripted exactly the way use-bridge-leg's tests script
// their effects.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 8453
const ETH = 1
const RH = 4663
const HOLDER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address
const ONE_ETH = 10n ** 18n

const ethPay = (balanceRaw: bigint = ONE_ETH): PayAssetOption => ({
  chainId: ETH,
  address: LIFI_NATIVE,
  symbol: 'ETH',
  decimals: 18,
  balanceRaw,
})

const wethPay = (balanceRaw: bigint = ONE_ETH): PayAssetOption => ({
  chainId: ETH,
  address: deploymentFor(ETH).weth as Address,
  symbol: 'WETH',
  decimals: 18,
  balanceRaw,
})

const funds = (chainId: number, over: Partial<PerChainFunds> = {}): PerChainFunds => ({
  chainId,
  usdcRaw: 0n,
  usdcCents: 0,
  nativeRaw: ONE_ETH,
  gasNeedRaw: 10n ** 15n, // 0.001 ETH per leg's steps
  ...over,
})

const need = (chainId: number, buysCents: number): ChainNeed => ({ chainId, buysCents, feeCents: 0 })

/** Scripted quote seam: $2500/ETH at a 0.3% route fee, floor at the asked
 *  slippage — realistic shape, deterministic numbers. Per-destination
 *  overrides script failures and bad floors. */
function makeQuote(
  overrides: Partial<Record<number, ((args: LifiQuoteArgs) => LifiQuote | Error) | Error>> = {},
  priceUsd = 2500n,
) {
  const calls: LifiQuoteArgs[] = []
  const quote = async (args: LifiQuoteArgs): Promise<LifiQuote> => {
    calls.push(args)
    const over = overrides[args.chainId]
    if (over instanceof Error) throw over
    if (typeof over === 'function') {
      const r = over(args)
      if (r instanceof Error) throw r
      return r
    }
    // 18dp ETH-family → 6dp settlement at priceUsd, minus a 0.3% route fee.
    const gross = (args.fromAmount * priceUsd) / 10n ** 12n
    const toAmount = (gross * 9_970n) / 10_000n
    const toAmountMin = (toAmount * BigInt(10_000 - args.slippageBps)) / 10_000n
    return {
      tool: 'test-route',
      toAmount,
      toAmountMin,
      approvalAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address,
      tx: { to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address, data: '0xdeadbeef', value: 0n, gasLimit: null },
      nativeFeeRaw: 0n,
      gasCostUsd: 0.5,
      etaSec: null,
      crossChain: args.fromChainId !== args.chainId,
    }
  }
  return { quote, calls }
}

function compose(over: Partial<Parameters<typeof composePayFunding>[0]> = {}) {
  const q = makeQuote()
  return composePayFunding({
    needs: [need(ETH, 1_167), need(BASE, 1_167), need(RH, 1_166)],
    funds: [funds(ETH), funds(BASE), funds(RH)],
    pay: ethPay(),
    holder: HOLDER,
    quote: q.quote,
    nativeUsd: async () => 2500,
    readBalance: async () => ONE_ETH,
    ...over,
  })
}

describe('composePayFunding — the worked ruling case: ETH-only wallet, $35, 3 networks', () => {
  it('covers every leg with a sized sale whose quoted floor clears the shortfall', async () => {
    const q = makeQuote()
    const plan = await compose({ quote: q.quote })
    expect(plan.legs).toHaveLength(3)
    for (const leg of plan.legs) {
      expect(leg.note).toBeNull()
      expect(leg.gasOk).toBe(true)
      expect(leg.bridge).toBeNull()
      expect(leg.convert).not.toBeNull()
      const cv = leg.convert!
      expect(cv.fromChainId).toBe(ETH) // every sale signs where the ETH lives
      expect(cv.token).toEqual({ address: LIFI_NATIVE, symbol: 'ETH', decimals: 18 })
      expect(cv.fromAmountRaw > 0n).toBe(true)
      // THE SIZING LAW: the quote's own floor covers the shortfall.
      expect(cv.quotedToMinRaw >= BigInt(leg.shortfallCents) * 10_000n).toBe(true)
      expect(cv.quotedToRaw >= cv.quotedToMinRaw).toBe(true)
    }
    // Same-chain sale for the Ethereum leg; sell-and-bridge for the others.
    expect(plan.legs.find((l) => l.chainId === ETH)!.convert!.fromChainId).toBe(ETH)
    expect(plan.legs.find((l) => l.chainId === BASE)!.convert!.fromChainId).toBe(ETH)
    // The total is the exact sum of the sales, conserved.
    expect(plan.totalFromRaw).toBe(plan.legs.reduce((s, l) => s + (l.convert?.fromAmountRaw ?? 0n), 0n))
    // ≈$35 at $2500/ETH ≈ 0.014 ETH — sized with headroom, bounded (< 0.02).
    expect(plan.totalFromRaw > 12n * 10n ** 15n).toBe(true)
    expect(plan.totalFromRaw < 20n * 10n ** 15n).toBe(true)
    // The quotes asked exactly the sale we planned: ETH → each dest settlement.
    expect(q.calls).toHaveLength(3)
    for (const call of q.calls) {
      expect(call.fromChainId).toBe(ETH)
      expect(call.fromToken).toBe(LIFI_NATIVE)
      expect(call.toToken).toBe(deploymentFor(call.chainId).usdc)
      expect(call.fromAddress).toBe(HOLDER)
      expect(call.slippageBps).toBe(DEFAULT_SLIPPAGE_BPS)
    }
  })

  it('nets each leg against its own chain settlement first — a covered leg sells nothing', async () => {
    const plan = await compose({
      funds: [funds(ETH, { usdcCents: 5_000, usdcRaw: 50_000_000n }), funds(BASE, { usdcCents: 400, usdcRaw: 4_000_000n }), funds(RH)],
    })
    const eth = plan.legs.find((l) => l.chainId === ETH)!
    expect(eth.shortfallCents).toBe(0)
    expect(eth.convert).toBeNull()
    expect(eth.note).toBeNull()
    const base = plan.legs.find((l) => l.chainId === BASE)!
    expect(base.shortfallCents).toBe(767) // 1167 − 400: only the gap is sold for
    expect(base.convert!.quotedToMinRaw >= 7_670_000n).toBe(true)
  })

  it('resizes ONCE off the quote’s own rate when the first floor lands short, then composes the second quote', async () => {
    const firstCalls: bigint[] = []
    const q = makeQuote({
      [BASE]: (args) => {
        firstCalls.push(args.fromAmount)
        const shrink = firstCalls.length === 1 ? 80n : 100n // first quote 20% under
        const gross = (args.fromAmount * 2500n * shrink) / (10n ** 12n * 100n)
        const toAmount = (gross * 9_970n) / 10_000n
        const toAmountMin = (toAmount * BigInt(10_000 - args.slippageBps)) / 10_000n
        return {
          tool: 'test-route',
          toAmount,
          toAmountMin,
          approvalAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address,
          tx: { to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address, data: '0xdeadbeef', value: 0n, gasLimit: null },
          nativeFeeRaw: 0n,
          gasCostUsd: 0.5,
          etaSec: null,
          crossChain: true,
        }
      },
    })
    const plan = await compose({ quote: q.quote })
    const base = plan.legs.find((l) => l.chainId === BASE)!
    expect(base.convert).not.toBeNull()
    expect(firstCalls).toHaveLength(2)
    expect(firstCalls[1] > firstCalls[0]).toBe(true)
    expect(base.convert!.fromAmountRaw).toBe(firstCalls[1])
    expect(base.convert!.quotedToMinRaw >= BigInt(base.shortfallCents) * 10_000n).toBe(true)
  })

  it('refuses a leg whose route still cannot guarantee the need after the resize — never under-funds the buy', async () => {
    const q = makeQuote({
      [BASE]: (args) => {
        // A broken route: floor stuck near zero regardless of size.
        void args
        return {
          tool: 'test-route',
          toAmount: 1_000n,
          toAmountMin: 900n,
          approvalAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address,
          tx: { to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address, data: '0xdeadbeef', value: 0n, gasLimit: null },
          nativeFeeRaw: 0n,
          gasCostUsd: 0.5,
          etaSec: null,
          crossChain: true,
        }
      },
    })
    // A huge balance so the resize is not read as a balance gap.
    const plan = await compose({ quote: q.quote, pay: ethPay(1_000n * ONE_ETH), readBalance: async () => 1_000n * ONE_ETH })
    const base = plan.legs.find((l) => l.chainId === BASE)!
    expect(base.convert).toBeNull()
    expect(base.note).toMatch(/could only guarantee/i)
    expect(base.note).toMatch(/refused rather than under-funding/i)
    // The other legs still composed — one broken route poisons one leg only.
    expect(plan.legs.find((l) => l.chainId === ETH)!.convert).not.toBeNull()
  })
})

describe('composePayFunding — the honesty laws', () => {
  it('a failed quote is a NAMED refusal for that leg, with the service’s own sentence — never a guessed rate', async () => {
    const q = makeQuote({ [RH]: new Error('No route for this swap right now (HTTP 500).') })
    const plan = await compose({ quote: q.quote })
    const rh = plan.legs.find((l) => l.chainId === RH)!
    expect(rh.convert).toBeNull()
    expect(rh.note).toMatch(/no conversion route right now/i)
    expect(rh.note).toMatch(/No route for this swap right now/)
    expect(rh.note).toMatch(/nothing is planned from your ETH/i)
    expect(plan.legs.filter((l) => l.convert != null)).toHaveLength(2)
  })

  it('an unreadable ETH price refuses every sale by name, before any quote is asked', async () => {
    const q = makeQuote()
    const plan = await compose({ quote: q.quote, nativeUsd: async () => null })
    expect(q.calls).toHaveLength(0)
    for (const leg of plan.legs) {
      expect(leg.convert).toBeNull()
      expect(leg.note).toMatch(/could not read an ETH price/i)
    }
  })

  it('an unreadable pay balance refuses by name — absent is not zero, and never a plan', async () => {
    const q = makeQuote()
    const plan = await compose({
      quote: q.quote,
      readBalance: async () => {
        throw new Error('rpc down')
      },
    })
    expect(q.calls).toHaveLength(0)
    for (const leg of plan.legs) {
      expect(leg.convert).toBeNull()
      expect(leg.note).toMatch(/could not re-read your ETH on Ethereum balance/i)
    }
  })

  it('a balance that cannot cover states the gap in the PAY asset’s units, rounded up', async () => {
    // ≈$35 needs ≈0.0144 ETH incl. headroom; hand the wallet 0.006 ETH spendable
    // after the gas reserve (0.001 × (3 sales + 1 own leg) = 0.004).
    const tiny = 10n * 10n ** 15n // 0.01 ETH
    const plan = await compose({ pay: ethPay(tiny), readBalance: async () => tiny })
    const short = plan.legs.filter((l) => l.convert == null && l.note != null)
    expect(short.length).toBeGreaterThan(0)
    for (const leg of short) {
      expect(leg.note).toMatch(/≈[\d.,]+ ETH more/)
      expect(leg.note).toMatch(/add ETH, or lower the amount/i)
    }
    // Conservation: what DID compose never exceeds the spendable balance.
    expect(plan.totalFromRaw <= tiny).toBe(true)
  })

  it('a gas-short DESTINATION refuses by name — no refuel can ride a conversion', async () => {
    const plan = await compose({ funds: [funds(ETH), funds(BASE, { nativeRaw: 0n }), funds(RH)] })
    const base = plan.legs.find((l) => l.chainId === BASE)!
    expect(base.convert).toBeNull()
    expect(base.gasOk).toBe(false)
    expect(base.note).toMatch(/needs ETH for network fees on Base/i)
    expect(base.note).toMatch(/cannot ride a ETH conversion/i)
    expect(base.note).toMatch(/pay with settlement balances instead/i)
  })

  it('an unsizeable DESTINATION fee refuses the leg (law 5) before money aims at it', async () => {
    const plan = await compose({ funds: [funds(ETH), funds(BASE, { gasNeedRaw: null }), funds(RH)] })
    const base = plan.legs.find((l) => l.chainId === BASE)!
    expect(base.convert).toBeNull()
    expect(base.gasOk).toBe(false)
    expect(base.note).toMatch(/could not estimate the network fee on Base/i)
  })

  it('a missing funds row for a leg refuses it by name (absent ≠ zero), others untouched', async () => {
    const plan = await compose({ funds: [funds(ETH), funds(RH)] })
    const base = plan.legs.find((l) => l.chainId === BASE)!
    expect(base.convert).toBeNull()
    expect(base.note).toMatch(/could not read balances on Base/i)
    expect(plan.legs.find((l) => l.chainId === ETH)!.convert).not.toBeNull()
  })

  it('WETH pay: the sales sign on the pay chain, and a native-gas shortage THERE refuses whole', async () => {
    const ok = await compose({ pay: wethPay(), readBalance: async () => ONE_ETH })
    expect(ok.legs.every((l) => l.convert != null)).toBe(true)
    expect(ok.legs[0].convert!.token.symbol).toBe('WETH')

    const gasless = await compose({
      pay: wethPay(),
      readBalance: async () => ONE_ETH,
      funds: [funds(ETH, { nativeRaw: 0n }), funds(BASE), funds(RH)],
    })
    for (const leg of gasless.legs) {
      expect(leg.convert).toBeNull()
      expect(leg.note).toMatch(/does not hold enough ETH to pay the network fees of selling your WETH/i)
    }
  })

  it('inherits thesis-funding’s input contract — duplicated chains throw, never absorb', async () => {
    await expect(
      compose({ needs: [need(ETH, 100), need(ETH, 100)] }),
    ).rejects.toThrowError(FundingPlanContractError)
  })

  it('a zero-shortfall leg with no gas deficit is untouched by any plan-wide refusal', async () => {
    const plan = await compose({
      funds: [funds(ETH), funds(BASE, { usdcCents: 5_000, usdcRaw: 50_000_000n }), funds(RH)],
      nativeUsd: async () => null, // sales refuse…
    })
    const base = plan.legs.find((l) => l.chainId === BASE)!
    expect(base.note).toBeNull() // …but money already home stays runnable
    expect(base.gasOk).toBe(true)
  })
})

describe('readPayAssetOptions — only held, only readable', () => {
  const io = (script: Record<string, bigint | Error>): PayAssetIo => ({
    native: async (chainId) => {
      const v = script[`native:${chainId}`]
      if (v instanceof Error) throw v
      return v ?? 0n
    },
    erc20: async (chainId, token) => {
      const v = script[`erc20:${chainId}:${token.toLowerCase()}`]
      if (v instanceof Error) throw v
      return v ?? 0n
    },
  })

  it('offers native + WETH where held, with the read balance', async () => {
    const weth = (deploymentFor(ETH).weth as string).toLowerCase()
    const opts = await readPayAssetOptions([ETH, BASE], HOLDER, io({ [`native:${ETH}`]: ONE_ETH, [`erc20:${ETH}:${weth}`]: 5n * 10n ** 17n }))
    expect(opts).toHaveLength(2)
    expect(opts[0]).toMatchObject({ chainId: ETH, address: LIFI_NATIVE, symbol: 'ETH', decimals: 18, balanceRaw: ONE_ETH })
    expect(opts[1]).toMatchObject({ chainId: ETH, symbol: 'WETH', decimals: 18, balanceRaw: 5n * 10n ** 17n })
  })

  it('never lists a zero balance, and NEVER lists an unreadable one as available', async () => {
    const opts = await readPayAssetOptions(
      [ETH, BASE],
      HOLDER,
      io({ [`native:${ETH}`]: 0n, [`native:${BASE}`]: new Error('rpc down') }),
    )
    expect(opts).toEqual([])
  })
})

describe('the console ↔ overlay hand-off store', () => {
  it('is keyed by the LEG SET — one bundle’s pick can never leak into another’s run', () => {
    const a = thesisPayKey([
      { chainId: ETH, address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { chainId: BASE, address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
    ])
    // order-insensitive, case-insensitive: both sides derive it from their own leg arrays
    const aAgain = thesisPayKey([
      { chainId: BASE, address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      { chainId: ETH, address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    ])
    const b = thesisPayKey([{ chainId: ETH, address: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' }])
    expect(aAgain).toBe(a)
    expect(b).not.toBe(a)
    setThesisPayChoice(a, ethPay())
    expect(thesisPayChoice(a)?.symbol).toBe('ETH')
    expect(thesisPayChoice(b)).toBeNull()
    setThesisPayChoice(a, null)
    expect(thesisPayChoice(a)).toBeNull()
  })
})

describe('firstBuyFloorLine — the display-honesty line (never a refusal of ours)', () => {
  // the owner's exact case: 29/31/40 shares, $30 stake → the 29% leg lands at $8.70.
  const shares = [
    { chainId: ETH, share: 29 },
    { chainId: BASE, share: 31 },
    { chainId: RH, share: 40 },
  ]
  const allocate = (totalCents: number): ChainNeed[] => {
    const exact = shares.map((s) => (totalCents * s.share) / 100)
    const floors = exact.map(Math.floor)
    let left = totalCents - floors.reduce((s, n) => s + n, 0)
    const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac)
    for (const { i } of order) {
      if (left <= 0) break
      floors[i] += 1
      left -= 1
    }
    return shares.map((s, i) => ({ chainId: s.chainId, buysCents: floors[i], feeCents: 0 }))
  }
  const FLOOR = 1_000 // $10, MIN_FIRST_DEPOSIT_USDC × 100

  it('a $30 stake names the $8.70 leg and says: raise to at least $35', () => {
    const line = firstBuyFloorLine(allocate(3_000), allocate, FLOOR)
    expect(line).not.toBeNull()
    expect(line!.under).toEqual([
      { chainId: ETH, buysCents: 870 },
      { chainId: BASE, buysCents: 930 },
    ])
    expect(line!.raiseToCents).toBe(3_500) // $35 — verified against the allocator itself
  })

  it('disappears exactly at the threshold — $35 clears every leg', () => {
    expect(firstBuyFloorLine(allocate(3_500), allocate, FLOOR)).toBeNull()
    expect(firstBuyFloorLine(allocate(3_400), allocate, FLOOR)).not.toBeNull()
  })

  it('equal thirds under $30 flag all three; $30 exactly clears', () => {
    const even = (totalCents: number): ChainNeed[] => [
      { chainId: ETH, buysCents: Math.floor(totalCents / 3) + (totalCents % 3), feeCents: 0 },
      { chainId: BASE, buysCents: Math.floor(totalCents / 3), feeCents: 0 },
      { chainId: RH, buysCents: Math.floor(totalCents / 3), feeCents: 0 },
    ]
    expect(firstBuyFloorLine(even(3_000), even, FLOOR)).toBeNull()
    const under = firstBuyFloorLine(even(2_900), even, FLOOR)
    expect(under!.under.length).toBeGreaterThanOrEqual(2)
    expect(under!.raiseToCents).toBe(3_000)
  })
})

describe('pay-amount formatting — costs round up, holdings round down', () => {
  it('formatAssetCeil never understates: the last shown digit rounds toward the payer paying', () => {
    expect(formatAssetCeil(10n ** 12n, 18)).toBe('0.000001')
    expect(formatAssetCeil(10n ** 12n + 1n, 18)).toBe('0.000002')
    // an EXACT value renders exactly — padding it up would OVERSTATE the
    // cost, the opposite lie; one wei past exact rounds the shown digit up
    expect(formatAssetCeil(1_444_000_000_000_000_0n, 18)).toBe('0.01444')
    expect(formatAssetCeil(1_444_000_000_000_000_1n, 18)).toBe('0.014441')
  })

  it('formatAssetFloor never overstates a holding', () => {
    expect(formatAssetFloor(999_999_999_999_999_999n, 18)).toBe('0.9999')
    expect(formatAssetFloor(ONE_ETH, 18)).toBe('1')
    expect(formatAssetFloor(0n, 18)).toBe('0')
  })
})

describe('composePayFunding — the route’s on-top native fee joins the ledger (owner 2026-08-16, the RH leg class)', () => {
  it('a modest on-top fee composes every leg and never inflates totalFromRaw (fee is not sale money)', async () => {
    const q = makeQuote()
    const FEE = 10n ** 12n
    const plan = await compose({ quote: async (a) => ({ ...(await q.quote(a)), nativeFeeRaw: FEE }) })
    expect(plan.legs.every((l) => l.convert != null)).toBe(true)
    expect(plan.totalFromRaw).toBe(plan.legs.reduce((s, l) => s + (l.convert?.fromAmountRaw ?? 0n), 0n))
  })

  it('a native pay budgets principal PLUS fee — legs the fee-laden balance cannot carry refuse with the gap', async () => {
    const q = makeQuote()
    const FEE = 9n * 10n ** 17n // 0.9 ETH per route, on top — only one such outlay fits in 1 ETH
    const plan = await compose({ quote: async (a) => ({ ...(await q.quote(a)), nativeFeeRaw: FEE }) })
    const composed = plan.legs.filter((l) => l.convert != null)
    const refused = plan.legs.filter((l) => l.convert == null)
    expect(composed).toHaveLength(1)
    expect(refused).toHaveLength(2)
    for (const leg of refused) expect(leg.note).toMatch(/can spare/)
  })
})
