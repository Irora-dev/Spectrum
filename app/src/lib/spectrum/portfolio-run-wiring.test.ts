import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { batchFeeBpsFor, normalizedTargets, emptyDraft, addTarget, setAmount, type AllocAsset } from './allocation'
import { DEFAULT_SLIPPAGE_BPS } from './hook-data'
import { curatedTaxBps } from './portfolio-run-market'
import { PRISM_CLAIM_CHAIN_ID, PRISM_V2_HOOK } from '../prism/claim'
import { COW_NATIVE_BUY } from './cow'
import { diffDisplayedVsSignedPortfolio, portfolioCompositionLawsBroken } from './displayed-vs-signed'
import { stepKeyOf } from './execution-runner'
import { assembleZeroExBatchBuyUnchecked, depthAwareExpectation, maxCommittedFor, encodePortfolioBatchBuy } from './portfolio-batcher'
import { S_MAX_BPS, S_MAX_THIN_BPS } from './floor-discipline'
import type { PerChainFunds } from './thesis-run-types'
import { ALLOWANCE_HOLDER, type ZeroExFetcher } from './zeroex-quote'
import {
  approvalsForFrom,
  buildRunReview,
  chainNeedsOf,
  chainSlicesOf,
  composeInputFor,
  composePortfolioStepFor,
  emptyPlanGate,
  inventoriesOf,
  rebalanceRunInput,
  SELL_FLOOR_DRIFT_BPS,
  shownForFrom,
  withPhaseDeadline,
  type MarketRow,
  walletCoverOfferFor,
} from './portfolio-run-wiring'

// ─────────────────────────────────────────────────────────────────────────────
// THE RUN WIRING'S OWN PINS. The modules it composes each carry their laws;
// what must be proven HERE is the seam itself: that the rows the station
// renders (and shownFor freezes) and the batch the assembler composes are the
// same numbers — through the REAL assembler, meeting at the REAL gate. A
// wiring that only agreed with itself would be the f(x)===f(x) trap this
// module's header disclaims.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
const BATCHER = '0x4200000000000000000000000000000000000606' as Address
const SETTLEMENT = '0x4200000000000000000000000000000000000006' as Address
const OP = '0x00000000000000000000000000000000000000fe' as Address
const ASSET_A = '0x1111111111111111111111111111111111111111' as Address
const ASSET_B = '0x2222222222222222222222222222222222222222' as Address
const T = 1_754_500_000

const asset = (address: Address, symbol: string, chainId = 8453): AllocAsset =>
  ({ address, symbol, name: symbol, chainId, decimals: 18 }) as AllocAsset

/** A draft the flow itself could hold: two 50/50 legs on one chain, $100. */
function normFor(amountUsd = 100) {
  let d = emptyDraft(T * 1000)
  d = addTarget(d, asset(ASSET_A, 'AAA'), T * 1000)
  d = addTarget(d, asset(ASSET_B, 'BBB'), T * 1000)
  d = setAmount(d, amountUsd, T * 1000)
  return { norm: normalizedTargets(d), amountCents: amountUsd * 100 }
}

const funds = (over: Partial<PerChainFunds> = {}): PerChainFunds => ({
  chainId: 8453,
  usdcRaw: 500_000_000n, // $500
  usdcCents: 50_000,
  nativeRaw: 10n ** 18n,
  gasNeedRaw: 10n ** 15n,
  ...over,
})

const marketRow = (a: Address, symbol: string, weightPct = 1): MarketRow => ({
  ok: true,
  leg: {
    symbol,
    asset: a,
    decimals: 18,
    weightPct,
    priceUsd: 1,
    priceAgeMs: 0,
    liquidityUsd: 1_000_000,
    buyTokenTaxBps: 0,
    route: { venue: 4 as never, ethPool: { currency0: SETTLEMENT, currency1: a, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' } as never, v3Fee: 0, v2Pair: '0x0000000000000000000000000000000000000000' as Address },
  },
})

const market = new Map<string, MarketRow>([
  [`8453:${ASSET_A.toLowerCase()}`, marketRow(ASSET_A, 'AAA')],
  [`8453:${ASSET_B.toLowerCase()}`, marketRow(ASSET_B, 'BBB')],
])

const review = () => {
  const { norm, amountCents } = normFor()
  return buildRunReview({ norm, amountCents, funds: [funds()], market, settlementFor: () => SETTLEMENT })
}

describe('the cent laws — slices, needs, inventories', () => {
  it('chain slices conserve the amount exactly and keep first-appearance order', () => {
    const { norm, amountCents } = normFor(101) // odd cents force remainder math
    const slices = chainSlicesOf(norm, amountCents)
    expect(slices.map((s) => s.chainId)).toEqual([8453])
    expect(slices.reduce((s, c) => s + c.grossCents, 0)).toBe(amountCents)
  })

  it('needs speak the EXCLUSIVE fee equation: buys + fee == the pull, via the contract inverse', () => {
    const needs = chainNeedsOf([{ chainId: 8453, grossCents: 10_040 }], batchFeeBpsFor(8453))
    expect(needs).toHaveLength(1)
    expect(needs[0].buysCents + needs[0].feeCents).toBe(10_040)
    expect(BigInt(needs[0].buysCents)).toBe(maxCommittedFor(10_040n, batchFeeBpsFor(8453)))
  })

  it('one home per dollar: the richest chain funds newMoney ONLY, its local reads 0', () => {
    const inv = inventoriesOf([funds(), funds({ chainId: 1, usdcCents: 10_000, usdcRaw: 100_000_000n })], [8453, 1])
    expect(inv.newMoney).toEqual({ chainId: 8453, availableCents: 50_000 })
    expect(inv.chains.find((c) => c.chainId === 8453)?.localFundingCents).toBe(0)
    expect(inv.chains.find((c) => c.chainId === 1)?.localFundingCents).toBe(10_000)
  })

  it('a chain the wallet read missed reports unreadable gas, never a fine default', () => {
    const inv = inventoriesOf([funds()], [8453, 1])
    const missing = inv.chains.find((c) => c.chainId === 1)
    expect(missing?.gasNeedRaw).toBeNull()
    expect(missing?.nativeRaw).toBe(0n)
  })
})

describe('buildRunReview — the rendered model', () => {
  it('budgets conserve: leg cents sum to the spendable net, raws never exceed the raw net', () => {
    const r = review()
    expect(r.chains).toHaveLength(1)
    const c = r.chains[0]
    const spendableCents = Number(maxCommittedFor(BigInt(c.grossCents), batchFeeBpsFor(8453)))
    expect(c.legs.reduce((s, l) => s + l.budgetUsdCents, 0)).toBe(spendableCents)
    const spendableRaw = maxCommittedFor(c.fundingTotalRaw, batchFeeBpsFor(8453))
    expect(c.legs.reduce((s, l) => s + l.budgetRaw, 0n) <= spendableRaw).toBe(true)
    // the approval is the WHOLE pull, exactly
    expect(c.approval).toEqual({ token: SETTLEMENT, amountRaw: c.fundingTotalRaw })
  })

  it('a locally-funded single-chain plan carries ONE batch step and no bridge', () => {
    const r = review()
    expect(r.plan.steps).toHaveLength(1)
    expect(r.plan.steps[0].action.kind).toBe('batch')
    expect(r.plan.refusals).toEqual([])
  })

  it('a missing market row becomes a rendered refusal, never a silently thinner batch', () => {
    const { norm, amountCents } = normFor()
    const partial = new Map([[`8453:${ASSET_A.toLowerCase()}`, marketRow(ASSET_A, 'AAA')]])
    const r = buildRunReview({ norm, amountCents, funds: [funds()], market: partial, settlementFor: () => SETTLEMENT })
    expect(r.chains[0].refusals.some((x) => x.symbol === 'BBB' && /no market read/.test(x.reason))).toBe(true)
    expect(r.chains[0].legs.map((l) => l.symbol)).toEqual(['AAA'])
  })

  it('a chain with no settlement configured refuses by name at the chain level', () => {
    const { norm, amountCents } = normFor()
    const r = buildRunReview({ norm, amountCents, funds: [funds()], market, settlementFor: () => null })
    expect(r.chains).toHaveLength(0)
    expect(r.refusals.some((x) => /no settlement token/.test(x))).toBe(true)
  })

  // ── the silent empty plan (the owner's live "Run refused" with raw state
  // {steps:[],notes:[],refusals:[]}, 2026-08-14): a plan that composed to
  // nothing must SAY WHY at the review, and the gate must withhold the button.
  it('a trim-only intent (no new money) refuses WITH the reason, never silently', () => {
    const { norm } = normFor()
    const r = buildRunReview({ norm, amountCents: 0, funds: [funds()], market, settlementFor: () => SETTLEMENT })
    expect(r.plan.steps).toHaveLength(0)
    expect(r.refusals.some((x) => /no new money and sells nothing/.test(x))).toBe(true)
    const gate = emptyPlanGate(r.plan)
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.reason).toMatch(/nothing the engine can run/)
  })

  it('an empty target set states there is nothing to buy', () => {
    const r = buildRunReview({ norm: [], amountCents: 10_000, funds: [funds()], market, settlementFor: () => SETTLEMENT })
    expect(r.plan.steps).toHaveLength(0)
    expect(r.refusals.some((x) => /nothing to buy/.test(x))).toBe(true)
  })

  it('a review that already speaks is not double-sentenced, and a real plan clears the zero-step door', () => {
    const { norm, amountCents } = normFor()
    const spoken = buildRunReview({ norm, amountCents, funds: [funds()], market, settlementFor: () => null })
    expect(spoken.refusals.some((x) => /no settlement token/.test(x))).toBe(true)
    expect(spoken.refusals.some((x) => /survived to a runnable step/.test(x))).toBe(false)
    expect(emptyPlanGate(review().plan).ok).toBe(true)
  })
})

// ── cash-funded rebalances run today (the owner live 2026-08-14: "i had usdc/cash
// in the book??") — the decomposer's laws, then the seam into a real plan ────

describe('rebalanceRunInput — cash trims fund buys, sells wait', () => {
  const change = (address: Address, symbol: string, fromUsd: number, toUsd: number, chainId = 8453) => ({ chainId, address, symbol, fromUsd, toUsd })
  const settle = () => SETTLEMENT

  it('a buy funded exactly by a settlement-cash trim is RUNNABLE with the composed dollars', () => {
    const r = rebalanceRunInput({
      changes: [change(SETTLEMENT, 'USDC', 500, 300), change(ASSET_A, 'AAA', 0, 200)],
      netNewUsd: 0,
      settlementFor: settle,
    })
    expect(r.kind).toBe('runnable')
    if (r.kind !== 'runnable') return
    expect(r.amountCents).toBe(20_000)
    expect(r.cashDrawCents).toBe(20_000)
    expect(r.targets).toHaveLength(1)
    expect(r.targets[0].asset.address).toBe(ASSET_A)
    expect(r.targets[0].weight).toBe(200)
  })

  it('a non-settlement trim WITHOUT an exact size blocks by name (sells are live; unsized cannot sell)', () => {
    const r = rebalanceRunInput({
      changes: [change(ASSET_B, 'BBB', 500, 300), change(ASSET_A, 'AAA', 0, 200)],
      netNewUsd: 0,
      settlementFor: settle,
    })
    expect(r.kind).toBe('blocked')
    if (r.kind !== 'blocked') return
    expect(r.reason).toMatch(/\$BBB/)
    expect(r.reason).toMatch(/cannot be sold exactly/)
  })

  it('buys beyond TRIMMED cash still run — the held pile funds them; the funding plan judges affordability', () => {
    // the owner's second live find (2026-08-14): the composer draws from held
    // cash WITHOUT a trim row (the pile is not a position card), so a
    // trimmed-cash affordability gate here refused plans the wallet fully
    // covers. Shape says runnable; the wallet read says affordable.
    const r = rebalanceRunInput({
      changes: [change(SETTLEMENT, 'USDC', 400, 300), change(ASSET_A, 'AAA', 0, 300)],
      netNewUsd: 0,
      settlementFor: settle,
    })
    expect(r.kind).toBe('runnable')
    if (r.kind !== 'runnable') return
    expect(r.amountCents).toBe(30_000)
    expect(r.cashDrawCents).toBe(30_000)
    // a wallet holding the money composes a real step…
    const funded = buildRunReview({ norm: r.targets, amountCents: r.amountCents, funds: [funds()], market, settlementFor: () => SETTLEMENT })
    expect(funded.plan.steps).toHaveLength(1)
    // …and one that truly lacks it refuses at the PLAN with the plan's own sentence
    const broke = buildRunReview({
      norm: r.targets,
      amountCents: r.amountCents,
      funds: [funds({ usdcCents: 100, usdcRaw: 1_000_000n })],
      market,
      settlementFor: () => SETTLEMENT,
    })
    expect(broke.plan.steps).toHaveLength(0)
    expect(broke.plan.refusals.some((x) => /needs .* more to complete/.test(x.reason))).toBe(true)
    expect(emptyPlanGate(broke.plan).ok).toBe(false)
  })

  it('trims-only states there is nothing to buy; stated new money funds a pure add', () => {
    const trimsOnly = rebalanceRunInput({ changes: [change(SETTLEMENT, 'USDC', 500, 300)], netNewUsd: 0, settlementFor: settle })
    expect(trimsOnly.kind).toBe('blocked')
    if (trimsOnly.kind === 'blocked') expect(trimsOnly.reason).toMatch(/moves nothing the engine can act on/)
    const funded = rebalanceRunInput({ changes: [change(ASSET_A, 'AAA', 0, 200)], netNewUsd: 200, settlementFor: settle })
    expect(funded.kind).toBe('runnable')
  })

  it('the seam: a cash-funded rebalance composes a REAL one-step plan through buildRunReview', () => {
    const r = rebalanceRunInput({
      changes: [change(SETTLEMENT, 'USDC', 500, 400), change(ASSET_A, 'AAA', 0, 100)],
      netNewUsd: 0,
      settlementFor: settle,
    })
    expect(r.kind).toBe('runnable')
    if (r.kind !== 'runnable') return
    const rev = buildRunReview({ norm: r.targets, amountCents: r.amountCents, funds: [funds()], market, settlementFor: () => SETTLEMENT })
    expect(rev.plan.steps).toHaveLength(1)
    expect(rev.plan.steps[0].action.kind).toBe('batch')
    expect(rev.chains[0].grossCents).toBe(10_000)
    expect(emptyPlanGate(rev.plan).ok).toBe(true)
  })
})

// ── the seam: shown-from-the-review meets composed-through-the-REAL-assembler ─

/** A faithful fake 0x: echoes what was asked, prices at the $1 spot, and
 *  routes through the PINNED AllowanceHolder — the target-steering guard
 *  refuses anything else, which this suite proved by first faking it wrong. */
const fakeFetch: ZeroExFetcher = async ({ sellToken, buyToken, sellAmountRaw }) => ({
  liquidityAvailable: true,
  sellToken,
  buyToken,
  allowanceTarget: ALLOWANCE_HOLDER,
  sellAmount: sellAmountRaw.toString(),
  // $1 spot, 6dp funding → 18dp asset: raw out = sellRaw × 10^12
  buyAmount: (sellAmountRaw * 10n ** 12n).toString(),
  transaction: { to: ALLOWANCE_HOLDER, value: '0', data: `0xdeadbeef${sellAmountRaw.toString(16).padStart(8, '0')}` },
})

const approveAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

describe('the seam — the station’s rows and the assembler’s batch are the same numbers', () => {
  it('a faithful bundle composed from the review passes the REAL P8 gate against the review’s own shown record', async () => {
    const r = review()
    const chain = r.chains[0]
    const assembled = await assembleZeroExBatchBuyUnchecked(
      composeInputFor(chain, OWNER, {
        batcher: BATCHER,
        chainNowSec: T,
        // Base-shaped gas (~0.001 gwei): the REAL economic leg cap runs in this
        // test, and a $100 batch must be worth its gas under honest numbers
        gasPriceWei: 10n ** 6n,
        nativeUsd: 3_000,
        hopReserveUsd: 5_000_000,
        feeRecipient: OP,
      }),
      fakeFetch,
    )
    const composed = assembled.composed
    // the review promised these exact commitments
    expect(composed.args[0].map((l) => l.sellAmount)).toEqual(chain.legs.map((l) => l.budgetRaw))
    // and the gate — the REAL one — accepts the faithful bundle against the
    // review's own minted record
    const shown = shownForFrom(r, OWNER)(r.plan.steps[0])
    expect(shown).not.toBeNull()
    const calls = [
      { to: SETTLEMENT, data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [BATCHER, chain.approval.amountRaw] }), value: 0n },
      { to: BATCHER, data: encodePortfolioBatchBuy(composed) as Hex, value: 0n },
    ]
    expect(diffDisplayedVsSignedPortfolio(calls, 1, BATCHER, shown!, composed)).toBeNull()
  })

  it('bridge steps answer null shown and empty approvals — the runner refuses those plans whole anyway', () => {
    const r = review()
    const bridge = { order: 1, action: { kind: 'bridge', fromChainId: 1, toChainId: 8453, amountCents: 100, refuel: false, source: 'new-money' } } as never
    expect(shownForFrom(r, OWNER)(bridge)).toBeNull()
    expect(approvalsForFrom(r)(bridge)).toEqual([])
  })

  it('approvals per batch step are the review’s own disclosure object', () => {
    const r = review()
    expect(approvalsForFrom(r)(r.plan.steps[0])).toEqual([r.chains[0].approval])
  })
})

describe('the closure goes through the LIVE door — the flag gate is not skippable by wiring', () => {
  it('post-flip, composePortfolioStepFor composes through the LIVE door (flipped 2026-08-14)', async () => {
    // Pre-flip this pinned the not-switched-on refusal; the flip commit flips
    // the pin with the flag, so the closure is proven to reach the real
    // assembler now the gate is open. Base-shaped gas keeps the economic
    // leg cap honest at the fixture's $100.
    const r = review()
    const compose = composePortfolioStepFor(r, OWNER, {
      batcherFor: () => BATCHER,
      chainNowSec: async () => T,
      gasPriceWei: async () => 10n ** 6n,
      nativeUsd: async () => 3_000,
      hopReserveUsd: async () => 5_000_000,
      fetchQuote: fakeFetch,
      feeRecipient: OP,
    })
    const composed = await compose(r.plan.steps[0])
    expect(composed.args[0].map((l) => l.sellAmount)).toEqual(r.chains[0].legs.map((l) => l.budgetRaw))
  })

  it('an unseated batcher refuses by name before any network read', async () => {
    const r = review()
    const compose = composePortfolioStepFor(r, OWNER, {
      batcherFor: () => null,
      chainNowSec: async () => T,
      gasPriceWei: async () => null,
      nativeUsd: async () => null,
      hopReserveUsd: async () => null,
      fetchQuote: fakeFetch,
      feeRecipient: OP,
    })
    await expect(compose(r.plan.steps[0])).rejects.toThrow(/no batch contract seated/)
  })

  it('a missing operator fee sink refuses by name — the contract would revert a zero sink', async () => {
    const r = review()
    const compose = composePortfolioStepFor(r, OWNER, {
      batcherFor: () => BATCHER,
      chainNowSec: async () => T,
      gasPriceWei: async () => null,
      nativeUsd: async () => null,
      hopReserveUsd: async () => null,
      fetchQuote: fakeFetch,
      feeRecipient: null,
    })
    await expect(compose(r.plan.steps[0])).rejects.toThrow(/no operator fee sink/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE FEE IS PINNED END-TO-END (pass-one INFO-2, 2026-08-14): the reviewer
// measured that a feeBps-50 assembly COMPOSES while the laws refuse it, and
// nothing pinned the wiring's fee to OUR constant through the real pipeline.
// Two halves: the input factory defaults to batchFeeBpsFor(8453), and a wrong-fee
// assembly is caught by the law net before any wallet.
// ─────────────────────────────────────────────────────────────────────────────
describe('the fee rides batchFeeBpsFor(8453) end to end', () => {
  it('composeInputFor defaults the fee to OUR constant — the wiring cannot drift it silently', () => {
    const r = review()
    const input = composeInputFor(r.chains[0], OWNER, {
      batcher: BATCHER,
      chainNowSec: T,
      gasPriceWei: 10n ** 6n,
      nativeUsd: 3_000,
      hopReserveUsd: 5_000_000,
      feeRecipient: OP,
    })
    expect(input.feeBps).toBe(batchFeeBpsFor(8453))
  })

  it('a wrong-fee assembly COMPOSES but the independent law refuses it — measured end to end', async () => {
    const r = review()
    const assembled = await assembleZeroExBatchBuyUnchecked(
      composeInputFor(r.chains[0], OWNER, {
        batcher: BATCHER,
        chainNowSec: T,
        gasPriceWei: 10n ** 6n,
        nativeUsd: 3_000,
        hopReserveUsd: 5_000_000,
        feeRecipient: OP,
        feeBps: 50, // clamp-legal for the contract, law-illegal for this app
      }),
      fakeFetch,
    )
    const verdict = portfolioCompositionLawsBroken(assembled.composed, {
      account: OWNER,
      chainNowSec: T,
      maxDeadlineWindowSec: 1_800,
      expectedFeeRecipient: OP,
    })
    expect(verdict).toMatch(/different fee than the one this app charges/)
  })
})

describe('withPhaseDeadline — a hung read becomes a sentence, never a frozen skeleton', () => {
  it('a resolving read passes through untouched', async () => {
    await expect(withPhaseDeadline(Promise.resolve(42), 5_000, 'reading')).resolves.toBe(42)
  })
  it('a hung read rejects NAMING the phase after the deadline', async () => {
    const never = new Promise<never>(() => {})
    await expect(withPhaseDeadline(never, 20, 'reading your balances')).rejects.toThrow(/reading your balances did not finish/)
  })
  it('a rejecting read keeps its own error — the deadline never masks a real failure', async () => {
    await expect(withPhaseDeadline(Promise.reject(new Error('real reason')), 5_000, 'x')).rejects.toThrow(/real reason/)
  })
})

describe('the step-key intent digest (audit LOW-MED, 2026-08-14) — same funding, different legs, different key', () => {
  it('two reviews with identical funding but different targets mint DIFFERENT batch keys', () => {
    const { norm, amountCents } = normFor()
    const a = buildRunReview({ norm, amountCents, funds: [funds()], market, settlementFor: () => SETTLEMENT })
    // same chain, same $100 funding — a THIRD asset replaces one leg
    const ASSET_C = '0x3333333333333333333333333333333333333333' as Address
    const market2 = new Map<string, MarketRow>([
      [`8453:${ASSET_A.toLowerCase()}`, marketRow(ASSET_A, 'AAA')],
      [`8453:${ASSET_C.toLowerCase()}`, marketRow(ASSET_C, 'CCC')],
    ])
    let d = emptyDraft(T * 1000)
    d = addTarget(d, asset(ASSET_A, 'AAA'), T * 1000)
    d = addTarget(d, asset(ASSET_C, 'CCC'), T * 1000)
    d = setAmount(d, 100, T * 1000)
    const b = buildRunReview({ norm: normalizedTargets(d), amountCents, funds: [funds()], market: market2, settlementFor: () => SETTLEMENT })
    const keyA = stepKeyOf(a.plan.steps[0])
    const keyB = stepKeyOf(b.plan.steps[0])
    expect(keyA).not.toBe(keyB)
    // and the digest is deterministic: rebuilding the same review re-mints the same key
    const a2 = buildRunReview({ norm, amountCents, funds: [funds()], market, settlementFor: () => SETTLEMENT })
    expect(stepKeyOf(a2.plan.steps[0])).toBe(keyA)
  })
})

// ── THE SELL WIRING PASS (the owner's order, 2026-08-14 ~20:0x): trims with the
// composer's exact raw size become REAL order-1 sales; the plan spends only
// the floored proceeds; every unsellable shape blocks or refuses BY NAME. ──

describe('the sell wiring — trims become real sales', () => {
  const change = (address: Address, symbol: string, fromUsd: number, toUsd: number, extra: { sellRaw?: string; decimals?: number } = {}, chainId = 8453) => ({ chainId, address, symbol, fromUsd, toUsd, ...extra })
  const settle = () => SETTLEMENT
  // 100 tokens at the fixture's $1 spot = $100 estimate
  const RAW_100 = (100n * 10n ** 18n).toString()

  it('a sized trim becomes a runnable SALE, floored through the live read, planned sell-then-batch', () => {
    const r = rebalanceRunInput({
      changes: [change(ASSET_B, 'BBB', 500, 400, { sellRaw: RAW_100, decimals: 18 }), change(ASSET_A, 'AAA', 0, 90)],
      netNewUsd: 0,
      settlementFor: settle,
    })
    expect(r.kind).toBe('runnable')
    if (r.kind !== 'runnable') return
    expect(r.sells).toHaveLength(1)
    expect(r.sells[0]).toMatchObject({ address: ASSET_B, sellRaw: RAW_100, decimals: 18 })
    const rev = buildRunReview({ norm: r.targets, amountCents: r.amountCents, funds: [funds({ usdcCents: 0, usdcRaw: 0n })], market, settlementFor: () => SETTLEMENT, sells: r.sells })
    // the rendered sale row: $100 estimate, floored by slippage + drift
    expect(rev.sells).toHaveLength(1)
    expect(rev.sells[0].estCents).toBe(10_000)
    const expectedFloor = Math.floor((10_000 * (10_000 - DEFAULT_SLIPPAGE_BPS - SELL_FLOOR_DRIFT_BPS)) / 10_000)
    expect(rev.sells[0].floorCents).toBe(expectedFloor)
    // the plan: the sale first, the batch drawing its proceeds waits on it
    expect(rev.plan.steps.map((s) => s.action.kind)).toEqual(['sell', 'batch'])
    expect(rev.plan.steps[1].waitsFor).toMatch(/sales confirming/)
    expect(emptyPlanGate(rev.plan).ok).toBe(true)
  })

  it('a pure cash-out — sales with no buys — is a complete runnable plan', () => {
    const r = rebalanceRunInput({
      changes: [change(ASSET_B, 'BBB', 500, 400, { sellRaw: RAW_100, decimals: 18 })],
      netNewUsd: 0,
      settlementFor: settle,
    })
    expect(r.kind).toBe('runnable')
    if (r.kind !== 'runnable') return
    expect(r.targets).toHaveLength(0)
    const rev = buildRunReview({ norm: [], amountCents: 0, funds: [funds()], market, settlementFor: () => SETTLEMENT, sells: r.sells })
    expect(rev.plan.steps.map((s) => s.action.kind)).toEqual(['sell'])
    expect(rev.plan.refusals).toEqual([])
    expect(emptyPlanGate(rev.plan).ok).toBe(true)
  })

  it('an UNSIZED trim blocks by name — a sale is never reconstructed from USD', () => {
    const r = rebalanceRunInput({
      changes: [change(ASSET_B, 'BBB', 500, 400), change(ASSET_A, 'AAA', 0, 90)],
      netNewUsd: 0,
      settlementFor: settle,
    })
    expect(r.kind).toBe('blocked')
    if (r.kind !== 'blocked') return
    expect(r.reason).toMatch(/\$BBB/)
    expect(r.reason).toMatch(/cannot be sold exactly/)
  })

  it('a sale the market cannot price is refused BY NAME and never planned', () => {
    const r = rebalanceRunInput({
      changes: [change(ASSET_B, 'BBB', 500, 400, { sellRaw: RAW_100, decimals: 18 })],
      netNewUsd: 0,
      settlementFor: settle,
    })
    expect(r.kind).toBe('runnable')
    if (r.kind !== 'runnable') return
    const noRead = new Map<string, MarketRow>()
    const rev = buildRunReview({ norm: [], amountCents: 0, funds: [funds()], market: noRead, settlementFor: () => SETTLEMENT, sells: r.sells })
    expect(rev.sells).toHaveLength(0)
    expect(rev.plan.steps).toHaveLength(0)
    expect(rev.refusals.some((x) => /\$BBB: no market read arrived for this sale/.test(x))).toBe(true)
    expect(emptyPlanGate(rev.plan).ok).toBe(false)
  })
})

// ── the tax vetting families (the owner live 2026-08-15: his PRISM buy refused
// on unknown tax — "we need to ensure v4 hooks can be bought") ──────────────
describe('curatedTaxBps — the vetted no-tax families', () => {
  it('PRISM v2 is vetted by the app’s own named constant, on its chain only', () => {
    expect(curatedTaxBps(PRISM_CLAIM_CHAIN_ID, PRISM_V2_HOOK)).toBe(0)
    expect(curatedTaxBps(PRISM_CLAIM_CHAIN_ID, PRISM_V2_HOOK.toUpperCase().replace('0X', '0x'))).toBe(0)
    expect(curatedTaxBps(8453, PRISM_V2_HOOK)).toBeNull()
  })

  it('an unknown token still answers null — the floor law keeps refusing it', () => {
    expect(curatedTaxBps(1, '0x9999999999999999999999999999999999999999')).toBeNull()
  })
})

// ── THE BURN ROUTE (the owner's order 2026-08-15, "do this so burn works" — his
// live tx proved the empty route diverts the whole cut). The assembler quotes
// the route on the GUARANTEED spend floor with the 0.5% haircut; no burn
// target keeps the fail-closed empty bytes. ──
describe('the burn route rides the composed batch', () => {
  const reads = { batcher: BATCHER, chainNowSec: T, gasPriceWei: 10n ** 6n, nativeUsd: 3_000, hopReserveUsd: 5_000_000, feeRecipient: OP }

  it('mainnet composes with a quoted burn route, sized UNDER the required-leg fee cut', async () => {
    const { norm, amountCents } = normFor()
    const market1 = new Map<string, MarketRow>([
      [`1:${ASSET_A.toLowerCase()}`, marketRow(ASSET_A, 'AAA')],
      [`1:${ASSET_B.toLowerCase()}`, marketRow(ASSET_B, 'BBB')],
    ])
    const norm1 = norm.map((t) => ({ ...t, asset: { ...t.asset, chainId: 1 } }))
    const r = buildRunReview({ norm: norm1, amountCents, funds: [funds({ chainId: 1 })], market: market1, settlementFor: () => SETTLEMENT })
    const calls: { buyToken: string; sellAmountRaw: bigint }[] = []
    const recorder: ZeroExFetcher = async (a) => {
      calls.push({ buyToken: a.buyToken, sellAmountRaw: a.sellAmountRaw })
      return fakeFetch(a)
    }
    const assembled = await assembleZeroExBatchBuyUnchecked(composeInputFor(r.chains[0], OWNER, reads), recorder)
    // NATIVE ETH, not PRISM (the top-up read's blocker-1: execBurn sells the
    // funding asset for native ETH and measures its own balance delta — the
    // PRISM buy-and-burn is the sink's downstream job; a PRISM-delivering
    // route measures ethGot≈0 and diverts the whole cut)
    const burnCall = calls.find((c) => c.buyToken.toLowerCase() === COW_NATIVE_BUY.toLowerCase())
    expect(burnCall, 'the burn quote must be fetched on mainnet, targeting native ETH').toBeTruthy()
    expect(calls.some((c) => c.buyToken.toLowerCase() === PRISM_V2_HOOK.toLowerCase())).toBe(false)
    const requiredCommitted = assembled.composed.args[0].filter((l) => !l.optional).reduce((t, l) => t + l.sellAmount, 0n)
    // GENERATION-AWARE CEILING (the owner's Base decode 2026-08-18): gen-1
    // burns 7/8 of the fee; a feeGeneration-2 contract burns ALL of it, so
    // the route sizes against the WHOLE cut there — and must still sit
    // UNDER it (over reverts on-chain; the 0.5% haircut is the margin).
    const gen2 = assembled.composed.generation === 2
    const fullCut = (requiredCommitted * BigInt(assembled.composed.args[3].feeBps)) / 10_000n
    const cutCeiling = gen2 ? fullCut : (fullCut * 7n) / 8n
    expect(burnCall!.sellAmountRaw <= cutCeiling).toBe(true) // under, never over — over reverts on-chain
    if (gen2) {
      // …and the eighth gen-1 left behind is RECLAIMED: a gen-2 route sized
      // at the old 7/8 would divert 12.5% of every fee by arithmetic
      expect(burnCall!.sellAmountRaw > (fullCut * 7n) / 8n).toBe(true)
    }
    expect(burnCall!.sellAmountRaw > 0n).toBe(true)
    expect(assembled.composed.args[3].burnSwapData).not.toBe('0x')
  })

  it('an input with NO burn target keeps the fail-closed empty route, byte-identical (all three seated chains burn now — SpectrumContracts w-66)', async () => {
    const r = review()
    const { burn: _dropped, ...noBurn } = composeInputFor(r.chains[0], OWNER, reads)
    const assembled = await assembleZeroExBatchBuyUnchecked(noBurn, fakeFetch)
    expect(assembled.composed.args[3].burnSwapData).toBe('0x')
  })

  it('a failed burn quote never blocks the batch — it composes with the divert said out loud', async () => {
    const { norm, amountCents } = normFor()
    const market1 = new Map<string, MarketRow>([
      [`1:${ASSET_A.toLowerCase()}`, marketRow(ASSET_A, 'AAA')],
      [`1:${ASSET_B.toLowerCase()}`, marketRow(ASSET_B, 'BBB')],
    ])
    const norm1 = norm.map((t) => ({ ...t, asset: { ...t.asset, chainId: 1 } }))
    const r = buildRunReview({ norm: norm1, amountCents, funds: [funds({ chainId: 1 })], market: market1, settlementFor: () => SETTLEMENT })
    const flaky: ZeroExFetcher = async (a) => {
      if (a.buyToken.toLowerCase() === COW_NATIVE_BUY.toLowerCase()) throw new Error('burn quote down')
      return fakeFetch(a)
    }
    const assembled = await assembleZeroExBatchBuyUnchecked(composeInputFor(r.chains[0], OWNER, reads), flaky)
    expect(assembled.composed.args[3].burnSwapData).toBe('0x')
    expect(assembled.refusals.some((x) => x.symbol === 'BURN' && /divert to the fallback sink/.test(x.reason))).toBe(true)
    expect(assembled.composed.args[0].length).toBeGreaterThan(0)
  })
})


describe('walletCoverOfferFor — the wallet-cover door sizes a native sale whose FLOOR covers the shortfall', () => {
  const base = {
    chainId: 1,
    shortCents: 35_800, // the live $358 PRISM case
    priceUsd: 1878.81,
    nativeRaw: 688_631_774_769_928_031n, // ~0.6886 ETH — the live wallet
    gasReserveRaw: 12_000_000_000_000_000n, // ~0.012 ETH reserve
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    driftBps: SELL_FLOOR_DRIFT_BPS,
  }
  const floorOf = (raw: bigint, priceUsd: number) => {
    const est = Math.floor((Number(raw) / 1e18) * priceUsd * 100)
    return Math.floor((est * (10_000 - DEFAULT_SLIPPAGE_BPS - SELL_FLOOR_DRIFT_BPS)) / 10_000)
  }
  it('covers: the returned raw, pushed through the SAME floor arithmetic, clears the shortfall', () => {
    const o = walletCoverOfferFor(base)
    expect(o).not.toBeNull()
    expect(floorOf(o!.sellRaw, base.priceUsd)).toBeGreaterThanOrEqual(base.shortCents)
    expect(o!.floorCents).toBe(floorOf(o!.sellRaw, base.priceUsd))
    // and never absurdly over: the sizing granularity is 1e-6 ETH ≈ fractions
    // of a cent, so the over-cover stays within a few cents
    expect(o!.floorCents - base.shortCents).toBeLessThanOrEqual(10)
  })
  it('respects the gas reserve: a wallet whose ETH sits at/below the reserve never offers', () => {
    expect(walletCoverOfferFor({ ...base, nativeRaw: base.gasReserveRaw })).toBeNull()
    expect(walletCoverOfferFor({ ...base, nativeRaw: base.gasReserveRaw - 1n })).toBeNull()
  })
  it('a shortfall the ETH above the reserve cannot FULLY cover never offers (partial cover still refuses the chain whole)', () => {
    // ~0.02 ETH above reserve ≈ $37 — cannot cover $358
    expect(walletCoverOfferFor({ ...base, nativeRaw: base.gasReserveRaw + 20_000_000_000_000_000n })).toBeNull()
  })
  it('unreadable inputs never offer: null price, null gas reserve, non-positive shortfall', () => {
    expect(walletCoverOfferFor({ ...base, priceUsd: null })).toBeNull()
    expect(walletCoverOfferFor({ ...base, priceUsd: 0 })).toBeNull()
    expect(walletCoverOfferFor({ ...base, gasReserveRaw: null })).toBeNull()
    expect(walletCoverOfferFor({ ...base, shortCents: 0 })).toBeNull()
    expect(walletCoverOfferFor({ ...base, shortCents: -5 })).toBeNull()
  })
  it('the boundary: exactly-coverable offers, one micro-ETH less does not', () => {
    const o = walletCoverOfferFor(base)!
    // cap the wallet at exactly the offered raw + reserve → still offers
    expect(walletCoverOfferFor({ ...base, nativeRaw: o.sellRaw + base.gasReserveRaw! })).not.toBeNull()
    // one wei under → the full cover no longer fits → no offer
    expect(walletCoverOfferFor({ ...base, nativeRaw: o.sellRaw + base.gasReserveRaw! - 1n })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SURFACED TOLERANCE — the half of the owner's thin-market ruling that is not
// arithmetic (2026-08-15: "allow open slippage but just surface it for people
// to be aware"). A widened tolerance the user is never shown is the thing the
// ruling forbids, so the review carries the number and it has to be the SAME
// number the composer will enforce — read from the same frozen market row.
// ─────────────────────────────────────────────────────────────────────────────
describe('the review states the tolerance it will actually ride', () => {
  const atDepth = (a: Address, symbol: string, liquidityUsd: number): MarketRow => {
    const row = marketRow(a, symbol)
    if (!row.ok) throw new Error('fixture builds an ok row')
    return { ok: true, leg: { ...row.leg, liquidityUsd } }
  }
  const thinMarket = (liquidityUsd: number) =>
    new Map<string, MarketRow>([
      [`8453:${ASSET_A.toLowerCase()}`, atDepth(ASSET_A, 'AAA', liquidityUsd)],
      [`8453:${ASSET_B.toLowerCase()}`, atDepth(ASSET_B, 'BBB', liquidityUsd)],
    ])
  const reviewAt = (liquidityUsd: number) => {
    const { norm, amountCents } = normFor()
    return buildRunReview({ norm, amountCents, funds: [funds()], market: thinMarket(liquidityUsd), settlementFor: () => SETTLEMENT })
  }

  it('every reviewed leg carries a tolerance — a leg with no stated worst case cannot be consented to', () => {
    for (const c of reviewAt(1_000_000).chains) for (const l of c.legs) expect(typeof l.toleranceBps).toBe('number')
  })

  it('⚠ the stated worst case composes BOTH costs — impact is already inside the quote the tolerance measures', () => {
    // the bug this pins: quoting only (1 − tolerance) off the budget reads as a
    // dollar promise, but the quote already paid impact, so the figure a person
    // sees would be better than anything they can actually receive
    const legs = reviewAt(30_000).chains.flatMap((c) => c.legs)
    expect(legs.length).toBeGreaterThan(0)
    for (const l of legs) {
      expect(l.impactBps).not.toBeNull()
      const toleranceOnly = (l.budgetUsdCents / 100) * (1 - l.toleranceBps! / 10_000)
      const bothCosts = toleranceOnly * (1 - l.impactBps! / 10_000)
      expect(bothCosts).toBeLessThan(toleranceOnly)
    }
  })

  it('impact is null exactly when depth is unreadable — never a silent zero standing in for a measurement', () => {
    const noDepth = new Map<string, MarketRow>([
      [`8453:${ASSET_A.toLowerCase()}`, atDepth(ASSET_A, 'AAA', Number.NaN)],
      [`8453:${ASSET_B.toLowerCase()}`, atDepth(ASSET_B, 'BBB', Number.NaN)],
    ])
    const { norm, amountCents } = normFor()
    const r = buildRunReview({ norm, amountCents, funds: [funds()], market: noDepth, settlementFor: () => SETTLEMENT })
    for (const l of r.chains.flatMap((c) => c.legs)) {
      expect(l.impactBps).toBeNull()
      expect(l.toleranceBps).toBeNull()
      expect(l.thinMarket).toBe(false)
    }
  })

  it('a DEEP leg is not flagged thin, and says nothing extra', () => {
    for (const c of reviewAt(50_000_000).chains) for (const l of c.legs) expect(l.thinMarket).toBe(false)
  })

  it('a MEASURED-THIN leg is flagged, and its stated tolerance is the wider ceiling', () => {
    const legs = reviewAt(2_000).chains.flatMap((c) => c.legs)
    expect(legs.length).toBeGreaterThan(0)
    for (const l of legs) {
      expect(l.thinMarket).toBe(true)
      expect(l.toleranceBps).toBe(S_MAX_THIN_BPS)
    }
  })

  it('the flag and the number agree — thin IFF the wider ceiling, on every depth', () => {
    for (const liq of [50_000_000, 1_000_000, 200_000, 50_000, 5_000, 500]) {
      for (const l of reviewAt(liq).chains.flatMap((c) => c.legs)) {
        expect(l.thinMarket).toBe(l.toleranceBps === S_MAX_THIN_BPS)
        expect([S_MAX_BPS, S_MAX_THIN_BPS]).toContain(l.toleranceBps)
      }
    }
  })

  it('⚠ THE STATED WORST CASE IS NEVER BETTER THAN THE COMPOSED FLOOR — the one direction a money surface must not round', async () => {
    for (const liq of [1_000_000, 40_000, 900]) {
      const r = reviewAt(liq)
      const chain = r.chains[0]
      const fetchQuote: ZeroExFetcher = async (args) => {
        const spotOut = (args.sellAmountRaw * 10n ** 12n) / 1n
        const notionalUsd = Number(args.sellAmountRaw) / 1e6
        const adjusted = depthAwareExpectation(spotOut, notionalUsd, liq)
        return {
          liquidityAvailable: true,
          sellToken: args.sellToken,
          buyToken: args.buyToken,
          sellAmount: args.sellAmountRaw.toString(),
          buyAmount: ((adjusted * 9_990n) / 10_000n).toString(),
          allowanceTarget: ALLOWANCE_HOLDER,
          transaction: { to: ALLOWANCE_HOLDER, value: '0', data: '0x2213bc0b' + 'ab'.repeat(64) },
          issues: { allowance: { spender: ALLOWANCE_HOLDER } },
        }
      }
      const out = await assembleZeroExBatchBuyUnchecked(
        {
          chainId: chain.chainId,
          targets: chain.targets,
          grossUsdCents: chain.grossCents,
          fundingTotalRaw: chain.fundingTotalRaw,
          fundingAsset: chain.fundingAsset,
          account: '0x1111111111111111111111111111111111111111' as Address,
          batcher: '0x2222222222222222222222222222222222222222' as Address,
          chainNowSec: 1_700_000_000,
          deadlineSec: 1_700_000_600,
          feeBps: batchFeeBpsFor(8453),
          feeRecipient: '0x3333333333333333333333333333333333333333' as Address,
          gasPriceWei: 10_000_000n,
          nativeUsd: 3_000,
          hopReserveUsd: 50_000_000,
        },
        fetchQuote,
      )
      for (const composed of out.legs) {
        const shown = chain.legs.find((l) => l.asset.toLowerCase() === composed.buyToken.toLowerCase())!
        // the card promises "at least (1 - toleranceBps)"; the batch enforces
        // (1 - sBps). Promising more than is enforced is the failure mode.
        expect(shown.toleranceBps).toBeGreaterThanOrEqual(composed.floor.sBps)
        expect(shown.toleranceBps).toBe(composed.floor.ceilingBps)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SIGNER-BALANCE PRE-FLIGHT. The page reads the linked-wallet GROUP but
// signs with the ACTIVE wallet, so a correct plan can be unfundable by the one
// address that will send it. Twice on 2026-08-15/16 that surfaced as an opaque
// route revert instead of one true sentence.
// ─────────────────────────────────────────────────────────────────────────────
describe('a plan the signer cannot fund refuses BEFORE any quote is spent', () => {
  const baseDeps = (over: Record<string, unknown> = {}) => ({
    batcherFor: () => '0x2222222222222222222222222222222222222222' as Address,
    chainNowSec: async () => 1_700_000_000,
    gasPriceWei: async () => 10_000_000n,
    nativeUsd: async () => 3_000,
    hopReserveUsd: async () => 50_000_000,
    feeRecipient: '0x3333333333333333333333333333333333333333' as Address,
    fetchQuote: (async () => {
      throw new Error('a quote must NEVER be fetched when the signer cannot fund the plan')
    }) as unknown as ZeroExFetcher,
    ...over,
  })
  const batchStep = (chainId: number) => ({ action: { kind: 'batch', chainId } }) as never

  it('names the shortfall in dollars and does not spend a single quote', async () => {
    const r = review()
    const chain = r.chains[0]
    const compose = composePortfolioStepFor(r, OWNER, baseDeps({
      settlementBalance: async () => chain.fundingTotalRaw - 30_000n, // 3 cents short
    }) as never)
    await expect(compose(batchStep(chain.chainId))).rejects.toThrow(/Needs \$0\.03 more/)
  })

  it('says WHY the money might be missing — the read/sign split the user cannot see', async () => {
    const r = review()
    const chain = r.chains[0]
    const compose = composePortfolioStepFor(r, OWNER, baseDeps({ settlementBalance: async () => 0n }) as never)
    await expect(compose(batchStep(chain.chainId))).rejects.toThrow(/only the connected one can sign/)
  })

  it('⚠ an UNREADABLE balance SKIPS the check — a failed read is not an empty wallet', async () => {
    const r = review()
    const chain = r.chains[0]
    let quoted = false
    const compose = composePortfolioStepFor(r, OWNER, baseDeps({
      settlementBalance: async () => null,
      fetchQuote: (async () => {
        quoted = true
        throw new Error('stop here')
      }) as unknown as ZeroExFetcher,
    }) as never)
    await expect(compose(batchStep(chain.chainId))).rejects.toThrow()
    expect(quoted).toBe(true) // it got PAST the balance gate
  })

  it('a THROWING balance reader also skips rather than refusing a fundable plan', async () => {
    const r = review()
    const chain = r.chains[0]
    let quoted = false
    const compose = composePortfolioStepFor(r, OWNER, baseDeps({
      settlementBalance: async () => { throw new Error('rpc down') },
      fetchQuote: (async () => { quoted = true; throw new Error('stop here') }) as unknown as ZeroExFetcher,
    }) as never)
    await expect(compose(batchStep(chain.chainId))).rejects.toThrow()
    expect(quoted).toBe(true)
  })

  it('EXACTLY enough is enough — the boundary is inclusive, not off by one wei', async () => {
    const r = review()
    const chain = r.chains[0]
    let quoted = false
    const compose = composePortfolioStepFor(r, OWNER, baseDeps({
      settlementBalance: async () => chain.fundingTotalRaw,
      fetchQuote: (async () => { quoted = true; throw new Error('stop here') }) as unknown as ZeroExFetcher,
    }) as never)
    await expect(compose(batchStep(chain.chainId))).rejects.toThrow()
    expect(quoted).toBe(true)
  })

  it('one wei short still refuses — the guard is not a rounded courtesy', async () => {
    const r = review()
    const chain = r.chains[0]
    const compose = composePortfolioStepFor(r, OWNER, baseDeps({
      settlementBalance: async () => chain.fundingTotalRaw - 1n,
    }) as never)
    await expect(compose(batchStep(chain.chainId))).rejects.toThrow(/Needs \$/)
  })

  it('no reader supplied = behaviour unchanged for every existing caller', async () => {
    const r = review()
    const chain = r.chains[0]
    let quoted = false
    const compose = composePortfolioStepFor(r, OWNER, baseDeps({
      fetchQuote: (async () => { quoted = true; throw new Error('stop here') }) as unknown as ZeroExFetcher,
    }) as never)
    await expect(compose(batchStep(chain.chainId))).rejects.toThrow()
    expect(quoted).toBe(true)
  })
})
