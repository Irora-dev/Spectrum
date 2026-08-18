import { describe, expect, it } from 'vitest'
import { toFunctionSelector, zeroAddress, type Address } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { BatchComposeRefusal, asFundingRaw } from './batcher'
import { DEV_PREVIEW_ADDRESS } from './dev-preview'
import {
  PORTFOLIO_BATCH_BUY_SELECTOR,
  PORTFOLIO_MAX_FEE_BPS,
  PORTFOLIO_MAX_LEGS,
  QUOTE_DRIFT_BAND_BPS,
  ZEROEX_COMPOSE_ENABLED,
  assembleZeroExBatchBuyLive,
  assembleZeroExBatchBuyUnchecked,
  composePortfolioBatchBuy,
  maxCommittedFor,
  portfolioBatcherAbi,
  portfolioBatcherAbiGen2,
  PORTFOLIO_BATCH_BUY_SELECTOR_GEN2,
  type ComposePortfolioBatchBuyInput,
  type PortfolioAssetLeg,
  PORTFOLIO_MAX_DEADLINE_WINDOW_SEC,
  depthAwareExpectation,
  DEEP_MARKET_DRIFT_BPS,
  MAX_QUOTE_DRIFT_BPS,
  isThinMarketLeg,
  legToleranceCeilingBps,
  quoteDriftBpsFor,
  encodePortfolioBatchBuy,
} from './portfolio-batcher'
import { S_MAX_BPS, S_MAX_THIN_BPS } from './floor-discipline'
import type { PlanLegInput } from './plan-legs'
import { ALLOWANCE_HOLDER, type ZeroExFetcher, type ZeroExQuoteResponse } from './zeroex-quote'

// THE 0x COMPOSE PATH, AUDITED AT BIRTH (plan §8 2026-08-06). The contract's
// laws are MIRRORED from source at spectrum-contracts `0645ee2`; every mirror
// is pinned here so a drifted mirror fails a test, not a mainnet call.

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const AAVE = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
const ME = '0x1111111111111111111111111111111111111111' as Address
const SINK = '0x2222222222222222222222222222222222222222' as Address
const NOW = 1_754_500_000
const BATCHER = '0x3333333333333333333333333333333333333333' as Address
// a third routable token for the refusal tests — since the 2026-08-13 cap
// ruling a lone survivor is a 100% batch and the assembler refuses it, so a
// refusal test needs TWO survivors to keep its own law visible below the cap
const LINK = '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196' as Address

const leg = (over: Partial<PortfolioAssetLeg> = {}): PortfolioAssetLeg => ({
  symbol: 'AAVE',
  buyToken: AAVE,
  sellAmountRaw: asFundingRaw(1_000_000n),
  minBuyAmountRaw: 495_000n,
  swapData: '0x2213bc0bdeadbeef',
  optional: false,
  ...over,
})

const buy = (over: Partial<ComposePortfolioBatchBuyInput> = {}): ComposePortfolioBatchBuyInput => {
  // two balanced legs by default: a single leg is 100% of its batch and the
  // ruled concentration cap (now enforced at the compose gate too, audit F2)
  // refuses it, so a fixture exercising OTHER laws needs a sub-cap split
  const legs = over.legs ?? [leg(), leg({ buyToken: LINK, symbol: 'LINK' })]
  const committed = legs.reduce((s, l) => s + l.sellAmountRaw, 0n)
  return {
    legs,
    fundingAsset: USDC,
    // exact worst-case cover: committed + fee on all of it
    fundingTotalRaw: asFundingRaw(committed + (committed * 50n) / 10_000n),
    owner: ME,
    recipient: ME,
    chainNowSec: NOW,
    deadlineSec: NOW + 600,
    feeBps: 50,
    feeRecipient: SINK,
    ...over,
  }
}

describe('the ABI pin — paper encoding is never trusted without a selector', () => {
  it('the pinned selector matches the ABI shape (and the artifact-derived constant)', () => {
    const sig =
      'batchBuy((address,uint256,uint256,bytes,bool)[],address,uint256,(address,uint256,uint16,address,bytes))'
    expect(toFunctionSelector(sig)).toBe(PORTFOLIO_BATCH_BUY_SELECTOR)
  })

  it('the ceremony pin (2026-08-12): batchBuy IS 0x0c8ef5f9 — the burn-leg build, never the pre-burn 0x273d1ecf', () => {
    // The standing instruction was "pin nothing until the ceremony lands —
    // ABI + selectors + address arrive in one message". That message landed
    // 2026-08-12 (SpectrumPortfolioBatcher.rehearsal-2026-08-12.abi.json):
    // BatchParams gained `burnSwapData`, so the pre-burn `0645ee2` selector
    // 0x273d1ecf does not resolve against ANY deployed batcher.
    expect(PORTFOLIO_BATCH_BUY_SELECTOR).toBe('0x0c8ef5f9')
    // derived from the ABI OBJECT the module actually encodes with — the sig
    // string above could drift with the pin; the encoding ABI cannot
    expect(toFunctionSelector(portfolioBatcherAbi[0])).toBe('0x0c8ef5f9')
  })

  // ── GENERATION 2 (the production fee model, the owner 2026-08-16) ────────────
  it('gen-2: the pinned selector matches the gen-2 ABI object — mirror and constant cannot drift', () => {
    // SpectrumContracts' own measurement of the new tuple (their fee-model
    // brief): BatchParams drops feeRecipient, so the selector moves. The A1
    // gate re-derives this from the DEPLOYED artifact at seating; this pin
    // holds the mirror self-consistent until then.
    expect(toFunctionSelector(portfolioBatcherAbiGen2[0])).toBe(PORTFOLIO_BATCH_BUY_SELECTOR_GEN2)
    expect(PORTFOLIO_BATCH_BUY_SELECTOR_GEN2).toBe('0x2c84261e')
  })

  it('gen-2 compose: the params tuple carries NO feeRecipient, the stamp says generation 2, and the bytes encode through the gen-2 ABI', () => {
    const c = composePortfolioBatchBuy(buy({ generation: 2 }))
    expect(c.generation).toBe(2)
    expect('feeRecipient' in c.args[3]).toBe(false)
    const data = encodePortfolioBatchBuy(c)
    expect(data.slice(0, 10)).toBe(PORTFOLIO_BATCH_BUY_SELECTOR_GEN2)
  })

  it('gen-2 compose: a zero fee recipient does NOT refuse — the field does not exist to be zero (gen-1 keeps its refusal)', () => {
    expect(() => composePortfolioBatchBuy(buy({ generation: 2, feeRecipient: zeroAddress }))).not.toThrow()
    expect(() => composePortfolioBatchBuy(buy({ feeRecipient: zeroAddress }))).toThrow(BatchComposeRefusal)
  })

  it('gen-1 default: an unstamped compose is generation 1, byte-identical to the old shape', () => {
    const c = composePortfolioBatchBuy(buy())
    expect(c.generation).toBe(1)
    expect('feeRecipient' in c.args[3]).toBe(true)
    expect(encodePortfolioBatchBuy(c).slice(0, 10)).toBe(PORTFOLIO_BATCH_BUY_SELECTOR)
  })

  it('the self-call-only surface is noted, not wired: execBurn / execLeg', () => {
    // The shipping contract's other externals are OnlySelf-guarded; this
    // module deliberately does not surface them. Their selectors are pinned
    // here as ceremony documentation so any future surfacing starts from the
    // verified values, not a fresh derivation.
    expect(toFunctionSelector('execBurn(address,uint256,bytes)')).toBe('0x1afa9dc8')
    expect(toFunctionSelector('execLeg(address,(address,uint256,uint256,bytes,bool),address)')).toBe('0xafa10a1e')
  })

  it('composed args encode through the ABI, selector-first', () => {
    const c = composePortfolioBatchBuy(buy())
    const data = encodePortfolioBatchBuy(c)
    expect(data.startsWith(PORTFOLIO_BATCH_BUY_SELECTOR)).toBe(true)
  })

  it('the compose path is LIVE — flipped 2026-08-14 with the reviewed flip commit', () => {
    // The dark pin's job is done: the flip landed WITH SpectrumContracts' clean
    // row (findings: 0 @ the flipped-tree digest) under the owner's one-pass
    // ruling, the interlock enforcing. This pin now holds the LIVE state the
    // same way the old one held the dark: a re-darkening is a deliberate
    // sacred change (it would strand the mounted run surface on a refusal
    // sentence), never a drive-by revert.
    expect(ZEROEX_COMPOSE_ENABLED).toBe(true)
  })
})

describe('the EXCLUSIVE funding equation — the fee rides ON TOP, integer-exact', () => {
  it('maxCommittedFor sits exactly at the contract edge', () => {
    for (const [funding, fee] of [
      [10_050n, 50],
      [1_000_000_000_000n, 50],
      [7n, 50],
      [999_999_999n, 200],
      [12_345_678_901n, 0],
    ] as const) {
      const c = maxCommittedFor(funding, fee)
      // passes the contract check…
      expect(c + (c * BigInt(fee)) / 10_000n <= funding).toBe(true)
      // …and one more unit would not
      const c1 = c + 1n
      expect(c1 + (c1 * BigInt(fee)) / 10_000n > funding).toBe(true)
    }
  })

  it('a batch committing one unit past the edge REFUSES with the equation in the sentence', () => {
    const committed = 1_000_000n
    const exact = committed + (committed * 50n) / 10_000n
    expect(() =>
      composePortfolioBatchBuy(buy({ legs: [leg({ sellAmountRaw: asFundingRaw(committed / 2n) }), leg({ buyToken: LINK, symbol: 'LINK', sellAmountRaw: asFundingRaw(committed / 2n) })], fundingTotalRaw: asFundingRaw(exact - 1n) })),
    ).toThrow(/exceeds the .* pull/)
    // the exact edge composes
    expect(() =>
      composePortfolioBatchBuy(buy({ legs: [leg({ sellAmountRaw: asFundingRaw(committed / 2n) }), leg({ buyToken: LINK, symbol: 'LINK', sellAmountRaw: asFundingRaw(committed / 2n) })], fundingTotalRaw: asFundingRaw(exact) })),
    ).not.toThrow()
  })

  it('the fee ceiling mirrors MAX_FEE_BPS — above it refuses, at it composes', () => {
    expect(() => composePortfolioBatchBuy(buy({ feeBps: PORTFOLIO_MAX_FEE_BPS + 1 }))).toThrow(BatchComposeRefusal)
    expect(() => composePortfolioBatchBuy(buy({ feeBps: Number.NaN }))).toThrow(BatchComposeRefusal)
    const committed = 1_000_000n
    expect(() =>
      composePortfolioBatchBuy(
        buy({
          feeBps: PORTFOLIO_MAX_FEE_BPS,
          legs: [leg({ sellAmountRaw: asFundingRaw(committed / 2n) }), leg({ buyToken: LINK, symbol: 'LINK', sellAmountRaw: asFundingRaw(committed / 2n) })],
          fundingTotalRaw: asFundingRaw(committed + (committed * 200n) / 10_000n),
        }),
      ),
    ).not.toThrow()
  })
})

describe('contract guards, mirrored — refused here in sentences, never reverted there', () => {
  it('the demo identity never composes — owner OR recipient (desk-204 backstop)', () => {
    expect(() => composePortfolioBatchBuy(buy({ owner: DEV_PREVIEW_ADDRESS as Address }))).toThrow(/demo book/i)
    expect(() => composePortfolioBatchBuy(buy({ recipient: DEV_PREVIEW_ADDRESS as Address }))).toThrow(/demo book/i)
  })
  it('ERC-20 only: native funding refuses (the contract has no native path)', () => {
    expect(() => composePortfolioBatchBuy(buy({ fundingAsset: zeroAddress }))).toThrow(/ERC-20 only/i)
  })
  it('a leg buying the funding asset refuses (BuyIsFundingAsset)', () => {
    expect(() => composePortfolioBatchBuy(buy({ legs: [leg({ buyToken: USDC })] }))).toThrow(/funding asset itself/i)
  })
  it('a zero floor refuses (ZeroFloor disables the only delivery guard)', () => {
    expect(() => composePortfolioBatchBuy(buy({ legs: [leg({ minBuyAmountRaw: 0n })] }))).toThrow(/no floor|zero floor/i)
  })
  it('a duplicate buyToken refuses — one asset, one leg (the basket-dial lesson)', () => {
    expect(() => composePortfolioBatchBuy(buy({ legs: [leg(), leg()] }))).toThrow(/appears twice/i)
  })
  it('the deadline is judged against the CHAIN clock: past refuses, past-24h refuses (DeadlineTooFar), inside composes', () => {
    expect(() => composePortfolioBatchBuy(buy({ deadlineSec: NOW }))).toThrow(/already expired/i)
    expect(() => composePortfolioBatchBuy(buy({ deadlineSec: NOW + 86_401 }))).toThrow(/24h ceiling/i)
    expect(() => composePortfolioBatchBuy(buy({ deadlineSec: NOW + 86_400 }))).not.toThrow()
    expect(() => composePortfolioBatchBuy(buy({ chainNowSec: Number.NaN }))).toThrow(/chain clock/i)
  })
  it('fee recipient and recipient are explicit; recipient must be the signer', () => {
    expect(() => composePortfolioBatchBuy(buy({ feeRecipient: zeroAddress }))).toThrow(/fee recipient/i)
    expect(() => composePortfolioBatchBuy(buy({ recipient: zeroAddress }))).toThrow(BatchComposeRefusal)
    expect(() => composePortfolioBatchBuy(buy({ recipient: SINK }))).toThrow(/your own wallet/i)
  })
  it('leg-count and empty-batch bounds', () => {
    expect(() => composePortfolioBatchBuy(buy({ legs: [] }))).toThrow(/empty batch/i)
    const many = Array.from({ length: PORTFOLIO_MAX_LEGS + 1 }, (_, i) =>
      leg({ buyToken: `0x${(i + 1).toString(16).padStart(40, '0')}` as Address, sellAmountRaw: asFundingRaw(1_000n) }),
    )
    expect(() => composePortfolioBatchBuy(buy({ legs: many, fundingTotalRaw: asFundingRaw(10n ** 18n) }))).toThrow(/must split/i)
  })
  it('calldata-less legs refuse — nothing signs a route that is not there', () => {
    expect(() => composePortfolioBatchBuy(buy({ legs: [leg({ swapData: '0x' })] }))).toThrow(/route calldata/i)
  })
})

// ── the async assembly, driven from OUTSIDE with fixture quotes ─────────────

const KEY: PoolKey = { currency0: zeroAddress, currency1: WETH, fee: 500, tickSpacing: 10, hooks: zeroAddress }
const target = (symbol: string, asset: Address, weightPct: number, over: Partial<PlanLegInput> = {}): PlanLegInput => ({
  symbol,
  asset,
  decimals: 18,
  weightPct,
  priceUsd: 10,
  priceAgeMs: 1_000,
  liquidityUsd: 10_000_000,
  buyTokenTaxBps: 0,
  route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
  ...over,
})

/** An honest 0x answer for whatever was asked: echoes the request, quotes
 *  0.5% under the spot basis the plan states (10 USD/token → budget/10). */
const honestFetcher: ZeroExFetcher = async ({ sellToken, buyToken, sellAmountRaw }) => {
  // cents budgets scale to raw by the plan; this fixture prices tokens at $10
  // with USDC-raw 1e6/unit → tokens(1e18) = raw/1e6 / 10 × 1e18
  const spotOut = (sellAmountRaw * 10n ** 12n) / 10n
  const buyAmount = (spotOut * 9_950n) / 10_000n
  return {
    liquidityAvailable: true,
    sellToken,
    buyToken,
    sellAmount: sellAmountRaw.toString(),
    buyAmount: buyAmount.toString(),
    allowanceTarget: ALLOWANCE_HOLDER,
    transaction: { to: ALLOWANCE_HOLDER, value: '0', data: '0x2213bc0b' + 'ab'.repeat(64) },
    issues: { allowance: { spender: ALLOWANCE_HOLDER } },
  } satisfies ZeroExQuoteResponse
}

const assembleInput = (over: Partial<Parameters<typeof assembleZeroExBatchBuyUnchecked>[0]> = {}) => ({
  chainId: 8453,
  targets: [target('AAA', AAVE, 60), target('BBB', WETH, 40)],
  grossUsdCents: 100_000, // $1,000
  fundingTotalRaw: 1_000_000_000n, // $1,000 of USDC (6 decimals)
  fundingAsset: USDC,
  account: ME,
  batcher: BATCHER,
  gasPriceWei: 10_000_000n, // 0.01 gwei, a Base-like chain
  nativeUsd: 3_000,
  chainNowSec: NOW,
  deadlineSec: NOW + 600,
  feeBps: 50,
  feeRecipient: SINK,
  hopReserveUsd: 50_000_000,
  ...over,
})

describe('assembleZeroExBatchBuy — draft to calldata through quotes and floors', () => {
  it('composes: budgets sum to the EXCLUSIVE spendable, floors derive from the QUOTE basis, calldata encodes', async () => {
    const out = await assembleZeroExBatchBuyUnchecked(assembleInput(), honestFetcher)
    const committed = out.composed.args[0].reduce((s, l) => s + l.sellAmount, 0n)
    expect(committed).toBe(maxCommittedFor(1_000_000_000n, 50))
    expect(committed + (committed * 50n) / 10_000n <= 1_000_000_000n).toBe(true)
    // floors: buyAmount × (1 − (drift + selfImpact + tax)); deep hop ⇒ leg 1
    // gets exactly the drift band, later legs at least it
    for (const l of out.legs) {
      expect(l.floor.sBps).toBeGreaterThanOrEqual(QUOTE_DRIFT_BAND_BPS)
      expect(l.minBuyAmountRaw).toBe((l.buyAmountRaw * BigInt(10_000 - l.floor.sBps)) / 10_000n)
      expect(l.minBuyAmountRaw > 0n).toBe(true)
    }
    // the cent view budgets the exclusive net of the gross
    const cents = out.legs.reduce((s, l) => s + l.budgetUsdCents, 0)
    expect(cents).toBe(Number(maxCommittedFor(100_000n, 50)))
    const data = encodePortfolioBatchBuy(out.composed)
    expect(data.startsWith(PORTFOLIO_BATCH_BUY_SELECTOR)).toBe(true)
  })

  it('an unroutable asset (liquidityAvailable:false) refuses BY NAME', async () => {
    // single-target so the route refusal is the whole story — a MULTI-target
    // plan losing one leg would over-allocate the survivors and refuse on
    // consent divergence (the owner 2026-08-13), tested in its own block below.
    const fetcher: ZeroExFetcher = async () => ({ liquidityAvailable: false })
    await expect(
      assembleZeroExBatchBuyUnchecked(assembleInput({ targets: [target('BBB', WETH, 100)] }), fetcher),
    ).rejects.toThrow(/no route/i)
  })

  it('a quote steering off the pinned AllowanceHolder kills that leg, loudly', async () => {
    // single-target: the steered leg is the whole plan, so its refusal is what
    // the assembler throws (a multi-target survivor set would over-allocate →
    // consent-divergence refusal, its own block below)
    const fetcher: ZeroExFetcher = async (args) => {
      const q = await honestFetcher(args)
      return { ...q, transaction: { ...q.transaction, to: SINK } }
    }
    await expect(
      assembleZeroExBatchBuyUnchecked(assembleInput({ targets: [target('AAA', AAVE, 100)] }), fetcher),
    ).rejects.toThrow(/somewhere other than the pinned|no leg/i)
  })

  it('a wrong-decimals quote (1000x off spot) is refused by the plausibility bracket', async () => {
    const fetcher: ZeroExFetcher = async (args) => {
      const q = await honestFetcher(args)
      return { ...q, buyAmount: (BigInt(q.buyAmount!) / 1_000n).toString() }
    }
    await expect(assembleZeroExBatchBuyUnchecked(assembleInput(), fetcher)).rejects.toThrow(BatchComposeRefusal)
  })

  it('a transport failure refuses THAT leg with try-again words — never a verdict, never a crash', async () => {
    // single-target: the failing leg is the whole plan (a surviving multi-leg
    // set would over-allocate → consent-divergence refusal, its own block)
    const fetcher: ZeroExFetcher = async () => {
      throw new Error('ECONNRESET')
    }
    await expect(
      assembleZeroExBatchBuyUnchecked(assembleInput({ targets: [target('BBB', WETH, 100)] }), fetcher),
    ).rejects.toThrow(/did not answer|no leg/i)
  })

  it('an unmeasured hop refuses the whole batch — floors cannot be guessed', async () => {
    await expect(assembleZeroExBatchBuyUnchecked(assembleInput({ hopReserveUsd: null }), honestFetcher)).rejects.toThrow(BatchComposeRefusal)
  })

  it('every leg unroutable = a whole refusal carrying the first reason', async () => {
    const fetcher: ZeroExFetcher = async () => ({ liquidityAvailable: false })
    await expect(assembleZeroExBatchBuyUnchecked(assembleInput(), fetcher)).rejects.toThrow(/no route|no composable/i)
  })
})

describe('the flag is a GATE, not a convention — and it is now OPEN', () => {
  it('the live entry COMPOSES now the feature is on — the door pin flipped with the flip', async () => {
    // Pre-flip this asserted the refusal sentence; the gate mechanism itself
    // is still pinned (the flag read is anchored single-match in the
    // interlock, and re-darkening flips this test red so the transition stays
    // deliberate in BOTH directions).
    const out = await assembleZeroExBatchBuyLive(assembleInput(), honestFetcher)
    expect(out.composed.args[0].length).toBeGreaterThan(0)
  })
  it('and the ungated path keeps its honest name even with the gate open', () => {
    expect(ZEROEX_COMPOSE_ENABLED).toBe(true)
    expect(typeof assembleZeroExBatchBuyUnchecked).toBe('function')
  })
})

describe('S1 — the quote must settle to THE BATCHER, not the signer', () => {
  it('every quote names the batcher as taker, never the account', async () => {
    const takers: string[] = []
    const spy: ZeroExFetcher = async (a) => { takers.push(a.taker); return honestFetcher(a) }
    await assembleZeroExBatchBuyUnchecked(assembleInput(), spy)
    expect(takers.length).toBeGreaterThan(0)
    for (const t of takers) expect(t).toBe(BATCHER)
    for (const t of takers) expect(t).not.toBe(ME)
  })
  it('no batcher address = refuse BEFORE any quote is spent', async () => {
    const calls: string[] = []
    const spy: ZeroExFetcher = async (a) => { calls.push(a.taker); return honestFetcher(a) }
    await expect(assembleZeroExBatchBuyUnchecked(assembleInput({ batcher: zeroAddress }), spy)).rejects.toThrow(/no batcher address/i)
    expect(calls).toHaveLength(0)
  })
  it('an out-of-range fee refuses BEFORE any quote, and commits nothing (S6)', async () => {
    const calls: string[] = []
    const spy: ZeroExFetcher = async (a) => { calls.push(a.taker); return honestFetcher(a) }
    await expect(assembleZeroExBatchBuyUnchecked(assembleInput({ feeBps: 500 }), spy)).rejects.toThrow(/ceiling/i)
    expect(calls).toHaveLength(0)
    // and the solver never answers ABOVE the pull for an unusable fee
    for (const bad of [201, 500, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(maxCommittedFor(1_000_000_000n, bad)).toBe(0n)
    }
  })
})

describe('the ECONOMIC leg cap binds composition — the bound the contract delegated to us', () => {
  it('an expensive chain refuses the plan BEFORE any quote is spent', async () => {
    const calls: string[] = []
    const spy: ZeroExFetcher = async (a) => { calls.push(a.taker); return honestFetcher(a) }
    // 200 gwei against a $50 batch: gas would dwarf the fee
    await expect(
      assembleZeroExBatchBuyUnchecked(assembleInput({ gasPriceWei: 200_000_000_000n, grossUsdCents: 5_000 }), spy),
    ).rejects.toThrow(/fees|one go/i)
    expect(calls).toHaveLength(0)
  })
  it('an unreadable gas price refuses rather than assuming a cheap chain', async () => {
    for (const over of [{ gasPriceWei: null }, { nativeUsd: null }]) {
      await expect(assembleZeroExBatchBuyUnchecked(assembleInput(over), honestFetcher)).rejects.toThrow(BatchComposeRefusal)
    }
  })
  it('a cheap chain composes exactly as before — the cap is inert when it should be', async () => {
    const out = await assembleZeroExBatchBuyUnchecked(assembleInput(), honestFetcher)
    expect(out.legs).toHaveLength(2)
  })
})

describe('the refusals nobody had read back (M12 — the every-refusal sweep found these unasserted)', () => {
  it('too many legs refuses with the count and the ceiling, so the user knows to split', () => {
    const many = Array.from({ length: PORTFOLIO_MAX_LEGS + 1 }, (_, i) =>
      leg({ buyToken: `0x${(i + 1).toString(16).padStart(40, '0')}` as `0x${string}` }),
    )
    expect(() => composePortfolioBatchBuy(buy({ legs: many }))).toThrow(/carries 33 legs — the batcher takes 32; it must split/)
  })

  it('a deadline past the contract 24h ceiling refuses — a signature must expire', () => {
    expect(() => composePortfolioBatchBuy(buy({ deadlineSec: NOW + PORTFOLIO_MAX_DEADLINE_WINDOW_SEC + 1 }))).toThrow(
      /deadline sits past the contract 24h ceiling/,
    )
    // and exactly AT the ceiling composes — "past" means past
    expect(() => composePortfolioBatchBuy(buy({ deadlineSec: NOW + PORTFOLIO_MAX_DEADLINE_WINDOW_SEC }))).not.toThrow()
  })

  it('a leg with no route calldata refuses, naming the leg', () => {
    expect(() => composePortfolioBatchBuy(buy({ legs: [leg({ swapData: '0x' })] }))).toThrow(/this leg carries no executable route calldata/)
  })
})

// ── CONSENT DIVERGENCE AT THE ASSEMBLER (the owner 2026-08-13) ───────────────────
describe('the consent-divergence policy binds the 0x path before any calldata exists', () => {
  it('a survivor set that would OVER-ALLOCATE past consent throws BatchComposeRefusal', async () => {
    // BBB refuses at quote time; AAA+CCC re-budget and over-allocate past what
    // they consented — the exact cascade the ruling governs. The sentence is
    // concentrationRefusal's own (shared with plan-legs).
    const fetcher: ZeroExFetcher = async (args) =>
      args.buyToken.toLowerCase() === WETH.toLowerCase() ? { liquidityAvailable: false } : honestFetcher(args)
    await expect(assembleZeroExBatchBuyUnchecked(assembleInput(), fetcher)).rejects.toThrow(
      /more than you chose|re-edit/i,
    )
    await expect(assembleZeroExBatchBuyUnchecked(assembleInput(), fetcher)).rejects.toThrow(BatchComposeRefusal)
  })

  it('a faithful batch whose legs each realise their consented share composes untouched', async () => {
    const out = await assembleZeroExBatchBuyUnchecked(
      assembleInput({ targets: [target('AAA', AAVE, 34), target('BBB', WETH, 33), target('CCC', LINK, 33)] }),
      honestFetcher,
    )
    expect(out.legs).toHaveLength(3)
  })

  it('a DELIBERATE single-asset buy COMPOSES — the owner 2026-08-13 exempts single-asset intent', async () => {
    const out = await assembleZeroExBatchBuyUnchecked(assembleInput({ targets: [target('AAA', AAVE, 100)] }), honestFetcher)
    expect(out.legs).toHaveLength(1)
  })
})

// ── the compose gate NO LONGER caps concentration (the owner 2026-08-13) ─────────
describe('composePortfolioBatchBuy — a lone leg is a legitimate single-asset buy, not a cap breach', () => {
  it('a lone leg (100%) COMPOSES — the divergence guard needs consent context and lives at the assembler', () => {
    expect(() => composePortfolioBatchBuy(buy({ legs: [leg()] }))).not.toThrow()
  })
  it('a deliberate 80/20 composes — the old absolute cap is gone', () => {
    // 80/20 → composes (consent is 80/20; nothing over-allocates)
    expect(() =>
      composePortfolioBatchBuy(
        buy({ legs: [leg({ sellAmountRaw: asFundingRaw(800n) }), leg({ buyToken: LINK, symbol: 'LINK', sellAmountRaw: asFundingRaw(200n) })] }),
      ),
    ).not.toThrow()
    // 70/30 → composes
    expect(() =>
      composePortfolioBatchBuy(
        buy({ legs: [leg({ sellAmountRaw: asFundingRaw(700n) }), leg({ buyToken: LINK, symbol: 'LINK', sellAmountRaw: asFundingRaw(300n) })] }),
      ),
    ).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A12 SURVIVOR PINS (the five-module sweep, 2026-08-14): four compose
// boundaries and one expectation boundary sat exactly where a comparison
// operator could relax unnoticed. The boundary input is the only input that
// proves the operator discriminates.
// ─────────────────────────────────────────────────────────────────────────────
describe('A12 pins — compose boundaries', () => {
  it('exactly PORTFOLIO_MAX_LEGS legs COMPOSE — the cap refuses at max+1, never at max (kills :245 > → >=)', () => {
    const at = Array.from({ length: PORTFOLIO_MAX_LEGS }, (_, i) =>
      leg({ buyToken: `0x${(i + 1).toString(16).padStart(40, '0')}` as Address, symbol: `T${i}`, sellAmountRaw: asFundingRaw(100n) }),
    )
    expect(() => composePortfolioBatchBuy(buy({ legs: at }))).not.toThrow()
  })

  it('a ZERO fee composes — zero-rate is a legal setting, not an implausible one (kills :251 < → <=)', () => {
    // the fixture's funding covers committed + 50bps, which more than covers 0bps
    expect(() => composePortfolioBatchBuy(buy({ feeBps: 0 }))).not.toThrow()
  })

  it('a ZERO chain-clock reading refuses — epoch 0 is an unread clock, not a time (kills :264 <= → <)', () => {
    expect(() => composePortfolioBatchBuy(buy({ chainNowSec: 0, deadlineSec: 600 }))).toThrow(/chain clock/i)
  })

  it('a ZERO-budget leg refuses by name (kills :274 <= → <)', () => {
    // funding stated explicitly — a zero-leg fixture otherwise dies earlier on 'no funding to batch'
    expect(() => composePortfolioBatchBuy(buy({ legs: [leg({ sellAmountRaw: asFundingRaw(0n) })], fundingTotalRaw: asFundingRaw(1_000n) }))).toThrow(/no budget/i)
  })

  it('depthAwareExpectation at EXACTLY 100% impact falls back to spot — never a zero expectation (kills :97 >= → >)', () => {
    // liquidity chosen so notional/liquidity crosses the impact formula's own
    // 10_000 bps ceiling exactly; the guard must treat degenerate impact as
    // unusable (spot passthrough), not scale the expectation to zero
    const spot = 1_000_000n
    expect(depthAwareExpectation(spot, 1_000_000, 1)).toBe(spot) // absurd impact → passthrough
    expect(depthAwareExpectation(spot, 0, 1_000_000)).toBe(spot) // zero impact → passthrough (<= 0 edge)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE FULL-CAP SWEEP'S SIX (2026-08-15, the top-up read's blocker-2: the burn
// lines had zero mutation coverage; the 70/70 re-sweep surfaced 14 survivors —
// 8 verdicted equivalent in mutation-triage.json, these 6 were REAL missing
// pins). Every test here is the exactly-at-the-boundary case: an instrument
// that cannot distinguish the boundary reports agreement with everything.
// ─────────────────────────────────────────────────────────────────────────────
import { economicLegCap } from './economic-leg-cap'

describe('the sweep’s six — boundaries the suite could not previously see', () => {
  it(':473 — a ZERO fee is a legal setting and composes (only out-of-range refuses)', async () => {
    const out = await assembleZeroExBatchBuyUnchecked(assembleInput({ feeBps: 0 }), honestFetcher)
    expect(out.composed.args[3].feeBps).toBe(0)
    expect(out.composed.args[0].length).toBeGreaterThan(0)
  })

  it(':477 — hop depth of EXACTLY ZERO refuses with the named unreadable-depth sentence', async () => {
    await expect(assembleZeroExBatchBuyUnchecked(assembleInput({ hopReserveUsd: 0 }), honestFetcher)).rejects.toThrow(
      /could not measure how deep/,
    )
  })

  it(':485 — a ZERO gross refuses as "no funded amount", never as the too-small-after-fee sentence', async () => {
    await expect(
      assembleZeroExBatchBuyUnchecked(assembleInput({ grossUsdCents: 0, fundingTotalRaw: 1_000_000n }), honestFetcher),
    ).rejects.toThrow(/no funded amount to spend/)
  })

  it(':500 — a refusal repeating across exclusion rounds lands EXACTLY once, and none is suppressed', async () => {
    // leg B's quote lands 50% under spot → its floor refuses → excluded →
    // round 2 re-plans; leg C's dust weight refuses identically in BOTH
    // rounds — the dedup must keep one copy and lose none.
    const fetcher: ZeroExFetcher = async (args) => {
      const q = await honestFetcher(args)
      if (args.buyToken.toLowerCase() === WETH.toLowerCase()) {
        return { ...q, buyAmount: ((BigInt(q.buyAmount ?? '0') * 5_000n) / 10_000n).toString() }
      }
      return q
    }
    const out = await assembleZeroExBatchBuyUnchecked(
      assembleInput({
        // BBB small enough that excluding it keeps AAA inside the +1pp
        // consent tolerance; CCC's dust budget refuses in EVERY round
        targets: [target('AAA', AAVE, 99.5), target('BBB', WETH, 0.498), target('CCC', '0xCCcCCcCC00000000000000000000000000000088' as Address, 0.001, { priceUsd: null }), target('DDD', '0xDDddDDdD00000000000000000000000000000088' as Address, 0.001, { priceUsd: null })],
      }),
      fetcher,
    )
    const sigs = out.refusals.map((r) => `${r.symbol}|${r.reason}`)
    expect(new Set(sigs).size, `duplicated refusals: ${sigs.join(' · ')}`).toBe(sigs.length)
    // TWO symbols sharing ONE reason text must BOTH stay: the dedup key is
    // (symbol AND reason) — an ||-keyed dedup suppresses the second symbol's
    // honest refusal (the exact surviving mutant this pins)
    expect(out.refusals.some((r) => r.symbol === 'CCC')).toBe(true)
    expect(out.refusals.some((r) => r.symbol === 'DDD')).toBe(true)
  })

  it(':521 — a plan with EXACTLY the leg cap composes (the cap is inclusive)', async () => {
    const input = assembleInput()
    const spendableCents = Number(maxCommittedFor(BigInt(input.grossUsdCents), input.feeBps))
    const cap = economicLegCap({
      contractMaxLegs: 32,
      gasPriceWei: input.gasPriceWei,
      nativeUsd: input.nativeUsd,
      feeUsd: (spendableCents / 100) * (input.feeBps / 10_000),
    })
    expect(cap.maxLegs).toBeGreaterThan(1)
    const n = cap.maxLegs
    const targets = Array.from({ length: n }, (_, i) =>
      target(`T${i}`, `0x${(i + 1).toString(16).padStart(2, '0')}${'a'.repeat(38)}` as Address, 100 / n),
    )
    const out = await assembleZeroExBatchBuyUnchecked(assembleInput({ targets }), honestFetcher)
    expect(out.composed.args[0].length).toBe(n)
  })

  it(':695 — a ZERO burn estimate (all-optional plan) fetches NO burn quote and stays silently empty', async () => {
    const calls: string[] = []
    const recorder: ZeroExFetcher = async (args) => {
      calls.push(args.buyToken.toLowerCase())
      const q = await honestFetcher(args)
      // a THIN pool's honest fill sits near the depth-adjusted expectation,
      // not near frictionless spot — quote inside the bracket
      const notionalUsd = Number(args.sellAmountRaw) / 1e6
      const spotOut = (args.sellAmountRaw * 10n ** 12n) / 10n
      const adjusted = depthAwareExpectation(spotOut, notionalUsd, 900)
      return { ...q, buyAmount: ((adjusted * 9_990n) / 10_000n).toString() }
    }
    const BURN_TARGET = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address
    // two THIN legs (budget ≫ pool depth) → both optional → requiredCommitted
    // 0 → burnEstRaw 0 → the original skips the quote entirely; the >= mutant
    // fires a doomed zero-sell fetch and emits a divert note
    const out = await assembleZeroExBatchBuyUnchecked(
      assembleInput({
        chainId: 1,
        burn: { asset: BURN_TARGET },
        targets: [target('AAA', AAVE, 60, { liquidityUsd: 900 }), target('BBB', WETH, 40, { liquidityUsd: 900 })],
      }),
      recorder,
    )
    expect(calls).not.toContain(BURN_TARGET.toLowerCase())
    expect(out.composed.args[3].burnSwapData).toBe('0x')
    expect(out.refusals.some((r) => r.symbol === 'BURN')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE TOLERANCE WE ASK 0x TO EMBED — the fix for the owner's three on-chain
// RequiredLegFailed reverts on $LNOC (live 2026-08-15). Left unset, 0x embeds
// its OWN 100-bps default inside opaque Settler calldata; on a thin asset that
// is TIGHTER than our floor, so the trade was stopped by a number we never
// chose, do not display and cannot explain. These pin the invariant that fixes
// it: what 0x embeds is always >= what our floor permits, so OUR floor binds.
// ─────────────────────────────────────────────────────────────────────────────
describe('the 0x slippage seam — our floor is the binding constraint, never 0x’s default', () => {
  const seen: { buyToken: string; slippageBps: number | undefined }[] = []
  // records the tolerance we asked for, and answers like an HONEST route at
  // this depth — a thin leg's real fill sits near the depth-adjusted
  // expectation, not near frictionless spot, or the plausibility bracket
  // refuses it before any floor derives (the :695 fixture's own trick)
  const recording = (liquidityUsd: number): ZeroExFetcher => async (args) => {
    seen.push({ buyToken: args.buyToken.toLowerCase(), slippageBps: args.slippageBps })
    const q = await honestFetcher(args)
    const notionalUsd = Number(args.sellAmountRaw) / 1e6
    const spotOut = (args.sellAmountRaw * 10n ** 12n) / 10n
    const adjusted = depthAwareExpectation(spotOut, notionalUsd, liquidityUsd)
    return { ...q, buyAmount: ((adjusted * 9_990n) / 10_000n).toString() }
  }
  const recordingFetcher = recording(10_000_000)

  it('EVERY asset leg carries an explicit slippageBps — an absent one silently inherits 0x’s 100 bps', async () => {
    seen.length = 0
    await assembleZeroExBatchBuyUnchecked(assembleInput(), recordingFetcher)
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) expect(typeof s.slippageBps).toBe('number')
  })

  it('what we ask 0x to embed is NEVER TIGHTER than the floor we then enforce', async () => {
    for (const liquidityUsd of [10_000_000, 250_000, 40_000, 9_000, 900]) {
      seen.length = 0
      const out = await assembleZeroExBatchBuyUnchecked(
        assembleInput({ targets: [target('AAA', AAVE, 60, { liquidityUsd }), target('BBB', WETH, 40, { liquidityUsd })] }),
        recording(liquidityUsd),
      )
      expect(out.legs.length).toBeGreaterThan(0)
      for (const leg of out.legs) {
        const asked = seen.find((s) => s.buyToken === leg.buyToken.toLowerCase())!.slippageBps
        // the whole point: 0x may fill down to `asked`, our floor decides at
        // `sBps`, and sBps <= asked means WE are the one that reverts it
        expect(asked).toBeGreaterThanOrEqual(leg.floor.sBps)
        expect(leg.floor.ceilingBps).toBe(asked)
      }
    }
  })

  it('a DEEP asset still rides the deep ceiling — the ruling reaches only what it measured thin', async () => {
    seen.length = 0
    await assembleZeroExBatchBuyUnchecked(assembleInput({ targets: [target('AAA', AAVE, 100, { liquidityUsd: 50_000_000 })] }), recordingFetcher)
    expect(seen[0].slippageBps).toBe(S_MAX_BPS)
  })

  it('a MEASURED-THIN asset rides the wider ceiling — and it is the number the review states', async () => {
    seen.length = 0
    const out = await assembleZeroExBatchBuyUnchecked(
      assembleInput({ targets: [target('AAA', AAVE, 100, { liquidityUsd: 2_000 })] }),
      recording(2_000),
    )
    expect(seen[0].slippageBps).toBe(S_MAX_THIN_BPS)
    expect(out.legs[0].floor.ceilingBps).toBe(S_MAX_THIN_BPS)
  })

  it('the BURN route deliberately asks for no tolerance — it has no floor of ours to protect', async () => {
    seen.length = 0
    await assembleZeroExBatchBuyUnchecked(
      assembleInput({ chainId: 1, burn: { asset: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address } }),
      recordingFetcher,
    )
    const burn = seen.find((s) => s.buyToken === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    expect(burn).toBeDefined()
    expect(burn!.slippageBps).toBeUndefined()
  })

  it('the ceiling is a STEP at the deep/thin boundary, not a slope — one bps of depth cannot half-widen a leg', () => {
    expect(legToleranceCeilingBps(null, 1_000)).toBeNull()
    // walk depth from deep to thin; every answer is one of exactly two values
    for (const liq of [1e9, 1e7, 1e6, 5e5, 1e5, 5e4, 1e4, 5e3, 1e3, 1]) {
      const c = legToleranceCeilingBps(liq, 1_000)
      expect([S_MAX_BPS, S_MAX_THIN_BPS]).toContain(c)
      expect(isThinMarketLeg(liq, 1_000)).toBe(c === S_MAX_THIN_BPS)
    }
  })

  it('EXACTLY AT the deep/thin boundary the leg stays DEEP — the whole backward-compat claim lives on this bps', () => {
    // ⚠ the mutant this kills flips `>` to `>=` at the boundary, which would
    // hand the WIDER ceiling to exactly the legs that used to saturate the old
    // 250-bps cap — i.e. it would change behaviour for the very legs
    // DEEP_MARKET_DRIFT_BPS exists to leave untouched. Found by the sweep, not
    // by me; it is the third time this class has bitten in this one change.
    const notional = 1_000
    // depth chosen so the drift band lands exactly ON the boundary
    const atBoundary = 88_910
    expect(quoteDriftBpsFor(atBoundary, notional)).toBe(DEEP_MARKET_DRIFT_BPS)
    expect(legToleranceCeilingBps(atBoundary, notional)).toBe(S_MAX_BPS)
    expect(isThinMarketLeg(atBoundary, notional)).toBe(false)
    // and one bps of drift thinner flips it — the boundary bites in both
    // directions, so the pin cannot pass by the predicate being constant
    const justThinner = 88_700
    expect(quoteDriftBpsFor(justThinner, notional)).toBe(DEEP_MARKET_DRIFT_BPS + 1)
    expect(legToleranceCeilingBps(justThinner, notional)).toBe(S_MAX_THIN_BPS)
    expect(isThinMarketLeg(justThinner, notional)).toBe(true)
  })

  it('the thin ceiling leaves REAL headroom above the drift band’s own cap (the :695 regression)', () => {
    // a saturated band plus any self-impact must still fit, or the second thin
    // leg of every batch refuses — which is what my first cut did
    expect(S_MAX_THIN_BPS).toBeGreaterThan(MAX_QUOTE_DRIFT_BPS)
    expect(S_MAX_THIN_BPS - MAX_QUOTE_DRIFT_BPS).toBeGreaterThanOrEqual(S_MAX_BPS - DEEP_MARKET_DRIFT_BPS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PROTECTION DIAL (the owner, live 2026-08-17: "we need the user to
// override the slippage settings… so you can have no protection to get it
// across the line" — a 17%-impact $LNOC leg was un-fillable at any honest
// floor). An override replaces legToleranceCeilingBps at the SINGLE derivation
// point, so the tolerance 0x embeds, the bound the floor derives under and the
// number the review states cannot disagree. Four laws: a NUMBER keeps the whole
// floor discipline inside the user's consented ceiling; 'none' floors at 1 wei
// and says so in words; the read-failed law OUTRANKS consent; no override is
// the pre-dial path untouched. (Restored pins — the first write was lost to a
// refused write; the dial itself shipped in 5f5ad0db with these laws stated.)
// ─────────────────────────────────────────────────────────────────────────────
describe('the protection dial — per-leg floor overrides, consent-scoped, read-failed law untouched', () => {
  const seen: { buyToken: string; slippageBps: number | undefined }[] = []
  // records what was asked and answers like an HONEST route at this depth —
  // the plausibility bracket judges the quote regardless of any override, so
  // a thin (or unreadable → spot-passthrough) leg must fill near its
  // depth-adjusted expectation (the 0x-seam block's own trick, one closure up)
  const dialRecorder = (liquidityUsd: number | null): ZeroExFetcher => async (args) => {
    seen.push({ buyToken: args.buyToken.toLowerCase(), slippageBps: args.slippageBps })
    const q = await honestFetcher(args)
    const notionalUsd = Number(args.sellAmountRaw) / 1e6
    const spotOut = (args.sellAmountRaw * 10n ** 12n) / 10n
    const adjusted = depthAwareExpectation(spotOut, notionalUsd, liquidityUsd)
    return { ...q, buyAmount: ((adjusted * 9_990n) / 10_000n).toString() }
  }
  const thinTargets = { targets: [target('AAA', AAVE, 100, { liquidityUsd: 2_000 })] }

  it('a NUMERIC override replaces the thin ceiling at THE one seam — asked slippage, floor bound and review number are ONE number', async () => {
    // un-overridden, this exact leg rides S_MAX_THIN_BPS (the natural ruling) —
    // the dial must REPLACE that ceiling, not decorate alongside it
    seen.length = 0
    const natural = await assembleZeroExBatchBuyUnchecked(assembleInput(thinTargets), dialRecorder(2_000))
    expect(seen[0].slippageBps).toBe(S_MAX_THIN_BPS)
    expect('floorOverride' in natural.legs[0]).toBe(false)

    seen.length = 0
    const out = await assembleZeroExBatchBuyUnchecked(
      assembleInput({ ...thinTargets, floorOverrides: { [AAVE.toLowerCase()]: 2_500 } }),
      dialRecorder(2_000),
    )
    // surface 1 — the tolerance 0x is asked to embed in its calldata
    expect(seen[0].slippageBps).toBe(2_500)
    // surface 2 — the bound the floor derived under, on the audit trail
    expect(out.legs[0].floor.ceilingBps).toBe(2_500)
    // surface 3 — the consent marker the review face states
    expect(out.legs[0].floorOverride).toBe(2_500)
    // and the floor discipline still ran INSIDE the consented ceiling — a
    // number is the same law at the user's own bound, never protection-off
    expect(out.legs[0].floor.sBps).toBeLessThanOrEqual(2_500)
    expect(out.legs[0].minBuyAmountRaw).toBe((out.legs[0].buyAmountRaw * BigInt(10_000 - out.legs[0].floor.sBps)) / 10_000n)
    expect(out.legs[0].minBuyAmountRaw > 1n).toBe(true)
  })

  it("override 'none': the composed floor is EXACTLY 1 wei, the route is asked for 9,999 bps, and the marker carries NO FLOOR for the face to say in words", async () => {
    // the un-waived leg carries a REAL floor — the contrast that keeps the
    // 1-wei sentinel below meaning "consented", never "computed"
    const guarded = await assembleZeroExBatchBuyUnchecked(assembleInput(thinTargets), dialRecorder(2_000))
    expect(guarded.legs[0].minBuyAmountRaw > 1n).toBe(true)

    seen.length = 0
    const out = await assembleZeroExBatchBuyUnchecked(
      assembleInput({ ...thinTargets, floorOverrides: { [AAVE.toLowerCase()]: 'none' } }),
      dialRecorder(2_000),
    )
    // 1 wei satisfies the contract's "must state a floor" shape while
    // protecting nothing — exactly what was consented to…
    expect(out.legs[0].minBuyAmountRaw).toBe(1n)
    // …in the bytes the chain actually settles, not only the audit view
    expect(out.composed.args[0][0].minBuyAmount).toBe(1n)
    // the route is asked for maximum tolerance — whatever the pool gives
    expect(seen[0].slippageBps).toBe(9_999)
    // the face keys on THIS marker to state NO FLOOR in words (PortfolioFlow's
    // no-floor sentence renders from floorOverride === 'none', never from a bps)
    expect(out.legs[0].floorOverride).toBe('none')
    // and the audit trail says no-protection honestly — 10,000 bps consumed
    // under the 9,999 ask, never a flattering derived-looking number
    expect(out.legs[0].floor.sBps).toBe(10_000)
    expect(out.legs[0].floor.ceilingBps).toBe(9_999)
  })

  it("an UNREADABLE depth still refuses under consent — the read-failed law outranks the dial, for 'none' AND for a number", async () => {
    // "no protection" is a choice about a MEASURED market, not a blindfold:
    // waiving on a depth we could not read hits the waive guard's own sentence
    const unreadable = { targets: [target('AAA', AAVE, 100, { liquidityUsd: null })] }
    await expect(
      assembleZeroExBatchBuyUnchecked(
        assembleInput({ ...unreadable, floorOverrides: { [AAVE.toLowerCase()]: 'none' } }),
        dialRecorder(null),
      ),
    ).rejects.toThrow(/cannot be waived on a depth we could not read/)
    // a NUMERIC override fares no better — the floor stage refuses the
    // unmeasured market term exactly as it did before the dial existed
    await expect(
      assembleZeroExBatchBuyUnchecked(
        assembleInput({ ...unreadable, floorOverrides: { [AAVE.toLowerCase()]: 2_500 } }),
        dialRecorder(null),
      ),
    ).rejects.toThrow(/could not be measured/)
    await expect(
      assembleZeroExBatchBuyUnchecked(
        assembleInput({ ...unreadable, floorOverrides: { [AAVE.toLowerCase()]: 'none' } }),
        dialRecorder(null),
      ),
    ).rejects.toThrow(BatchComposeRefusal)
  })

  it('NO override = the pre-dial path byte-for-byte — the overlay absent, empty, or aimed at an asset not in the plan changes NOTHING', async () => {
    const base = await assembleZeroExBatchBuyUnchecked(assembleInput(), honestFetcher)
    const empty = await assembleZeroExBatchBuyUnchecked(assembleInput({ floorOverrides: {} }), honestFetcher)
    const elsewhere = await assembleZeroExBatchBuyUnchecked(
      // LINK is not in this plan — a consent for an absent asset reaches nothing
      assembleInput({ floorOverrides: { [LINK.toLowerCase()]: 'none' } }),
      honestFetcher,
    )
    const bytes = encodePortfolioBatchBuy(base.composed)
    expect(encodePortfolioBatchBuy(empty.composed)).toBe(bytes)
    expect(encodePortfolioBatchBuy(elsewhere.composed)).toBe(bytes)
    // and the audit trail is the PRE-DIAL derivation, absolutely, not merely
    // self-consistent: deep ceilings at S_MAX_BPS (the before-the-dial number),
    // the floor equation intact, no consent marker anywhere
    for (const out of [base, empty, elsewhere]) {
      for (const l of out.legs) {
        expect('floorOverride' in l).toBe(false)
        expect(l.floor.ceilingBps).toBe(S_MAX_BPS)
        expect(l.minBuyAmountRaw).toBe((l.buyAmountRaw * BigInt(10_000 - l.floor.sBps)) / 10_000n)
      }
    }
  })
})
