import { describe, expect, it } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import {
  asFundingRaw,
  composeBatchBuy,
  BatchComposeRefusal,
  feeCentsOfTotal,
  fundingTotalForLegCents,
  rebalanceEthNeedRaw,
  rebalanceFeeRawFromActual,
  rebalanceFeeRawOnBudget,
  rebalanceNeedCentsOnBudget,
} from './batcher'
import { assembleBatchBuy } from './assemble-batch'
import { buildFundingPlan, FundingPlanContractError } from './funding-plan'
import { centBudgets, planToLegs } from './plan-legs'
import { composeRebalance } from './position-intents'
import { integerShares } from './publish-picks'
import { pickRoute } from './routing'
import { seedGuard } from './seed-guard'
import { buildInsights } from './insights'
import { chainTotals, unpricedChainIds } from './chain-totals'
import { classifyTier, isFreshlyLaunched } from './market-tiers'
import { cashPileSplit, foldCashPile, unifyAssets } from './asset-unify'
import { composePortfolioBatchBuy, maxCommittedFor } from './portfolio-batcher'
import { pickHopReserve } from './hop-reserve'
import { economicLegCap } from './economic-leg-cap'
import { skimSignal, bandSlackBps } from './realised-price'
import { deriveLegFloors } from './floor-discipline'
import { validateLegQuote } from './zeroex-quote'
import { resolveLadder } from './capability-ladder'
import { diffDisplayedVsSigned, type ShownStepReview } from './displayed-vs-signed'
import { acquisitionInputsFor, nativeSellPath, poolVerdictFrom } from './acquisition-inputs'
import { assessPool, MAX_PLAUSIBLE_POOL_LIQUIDITY_USD } from './pool-safety'
import { buildZeroxUpstream } from './zerox-proxy-request'
import type { ComposedBatchBuy } from './batcher'

// ─────────────────────────────────────────────────────────────────────────────
// THE HOSTILE-NUMBER SWEEP — the audit series' pattern, applied ONCE across
// every pure money module instead of module by module.
//
// Five hand-probing rounds found the same shape over and over: a guard written
// for one representation of "missing" (`null`) while another walked past it
// (NaN, Infinity, negative, unparseable). Each fix was local; this file is the
// GENERAL statement, so the next module to grow a money field inherits the
// check instead of waiting for someone to think of it.
//
// THE INVARIANT, in one sentence: given any hostile number a real read can
// produce, a pure money module must either REFUSE (a sentence, a throw, or a
// dropped row) or return only finite numbers. What it may never do is emit
// NaN, Infinity, or a negative amount into something a human then reads as a
// fact or a wallet signs as an instruction.
//
// Why these five values: every one has actually arrived. `NaN` from
// `Number('')` and from arithmetic on a failed read; `Infinity` from a divide
// by a zero balance; `-1` from a subtraction that assumed ordering; `null`
// from an honest unreadable; `1e21` from a wei amount pasted into a dollar
// field. The list is evidence, not imagination.
// ─────────────────────────────────────────────────────────────────────────────

const HOSTILE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1e21] as const

/** Every number reachable in a value, however deep. */
function numbersIn(v: unknown, path = '', out: { path: string; n: number }[] = []): { path: string; n: number }[] {
  if (typeof v === 'number') out.push({ path, n: v })
  else if (Array.isArray(v)) v.forEach((x, i) => numbersIn(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) numbersIn(x, `${path}.${k}`, out)
  return out
}

/** The assertion itself: nothing non-finite escapes, whatever the shape. */
function allFinite(label: string, value: unknown) {
  for (const { path, n } of numbersIn(value)) {
    expect(Number.isFinite(n), `${label}${path} = ${n}`).toBe(true)
  }
}

const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
const ADDR = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const

describe('the hostile-number sweep: no pure money module emits a non-finite figure', () => {
  it('integerShares — a weight is always a number', () => {
    for (const h of HOSTILE) {
      allFinite('integerShares', integerShares([h, 50, 50]))
      allFinite('integerShares', integerShares([50, h]))
      allFinite('integerShares', integerShares([h, h]))
    }
  })

  it('centBudgets — a budget is always a number, and never over-allocates', () => {
    for (const h of HOSTILE) {
      const a = centBudgets([h, 50, 50], 10_000)
      allFinite('centBudgets', a)
      expect(a.reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(10_000)
      allFinite('centBudgets/total', centBudgets([50, 50], h))
    }
  })

  it('pickRoute — the margin is finite or null, never NaN', () => {
    for (const h of HOSTILE) {
      for (const v of [
        pickRoute({ outUsd: 100, gasCostUsd: h }, { outUsd: 100, gasCostUsd: 5 }),
        pickRoute({ outUsd: 100, gasCostUsd: 5 }, { outUsd: h, gasCostUsd: 5 }),
        pickRoute({ outUsd: h, gasCostUsd: h }, { outUsd: h, gasCostUsd: h }),
      ]) {
        expect(v.marginUsd === null || Number.isFinite(v.marginUsd)).toBe(true)
      }
    }
  })

  it('seedGuard — every verdict is a sentence, and hostile input never passes silently', () => {
    for (const h of HOSTILE) {
      const withBadSeed = seedGuard([{ symbol: 'X', seedUsd: h, depthUsd: 1000 }])
      const withBadDepth = seedGuard([{ symbol: 'X', seedUsd: 100, depthUsd: h }])
      for (const set of [withBadSeed, withBadDepth]) {
        allFinite('seedGuard', set)
        for (const v of set) expect(typeof v.reason === 'string' && v.reason.length > 0).toBe(true)
      }
      // a POSITIVE hostile seed (1e21) must not read as clean against a real pool
      if (h > 0) expect(withBadSeed.length).toBeGreaterThan(0)
    }
  })

  it('composeRebalance — every emitted figure is finite', () => {
    const P = (symbol: string, valueUsd: number) => ({
      asset: { chainId: 8453, address: `0x${symbol.toLowerCase().padEnd(40, '0')}` as `0x${string}`, symbol },
      valueUsd,
      pct: 0,
      kind: 'token' as const,
    })
    for (const h of HOSTILE) {
      allFinite(
        'composeRebalance/intent',
        composeRebalance([P('WETH', 1000), P('USDC', 500)], [
          { kind: 'sell', asset: P('WETH', 0).asset, usd: h },
          { kind: 'buy', asset: P('AERO', 0).asset, usd: h },
        ]),
      )
      allFinite(
        'composeRebalance/position',
        composeRebalance([P('WETH', h), P('USDC', 500)], [{ kind: 'buy', asset: P('AERO', 0).asset, usd: 100 }]),
      )
    }
  })

  it('planToLegs — a hostile plan REFUSES in sentences; nothing composed is non-finite', () => {
    const T = (over: Record<string, unknown> = {}) => ({
      symbol: 'X',
      asset: ADDR,
      decimals: 18,
      weightPct: 100,
      priceUsd: 10,
      priceAgeMs: 5_000,
      liquidityUsd: 1_000_000,
      buyTokenTaxBps: 0,
      route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
      ...over,
    })
    for (const h of HOSTILE) {
      for (const field of ['weightPct', 'priceUsd', 'priceAgeMs', 'liquidityUsd', 'buyTokenTaxBps'] as const) {
        const { legs, refusals } = planToLegs([T({ [field]: h })], 100_000)
        // budgetUsdCents is the only number legs carry; quotedOutRaw is a bigint
        for (const l of legs) expect(Number.isFinite(l.budgetUsdCents)).toBe(true)
        for (const r of refusals) expect(r.reason.length).toBeGreaterThan(0)
      }
      // a hostile funding total never yields a leg claiming impossible money
      const { legs } = planToLegs([T()], h)
      for (const l of legs) expect(Number.isFinite(l.budgetUsdCents)).toBe(true)
    }
  })

  it('composeBatchBuy — hostile input REFUSES with a sentence, never composes bad calldata', () => {
    const leg = (over: Record<string, unknown> = {}) => ({
      symbol: 'AAVE',
      asset: ADDR,
      route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress } as const,
      budgetRaw: asFundingRaw(1_000n),
      quotedOutRaw: 500n,
      minOutRaw: 495n,
      optional: false,
      ...over,
    })
    // A hostile FLOOR (zero/negative — bigints cannot be NaN) is a refusal in
    // words, never calldata carrying an unprotected leg. Floor DERIVATION is
    // floor-discipline's job and swept there; here the composer must refuse to
    // CARRY a floor that protects nothing.
    for (const badFloor of [0n, -1n]) {
      expect(() =>
        composeBatchBuy({
          chainId: 8453,
          legs: [leg({ minOutRaw: badFloor })],
          fundingAsset: zeroAddress,
          fundingTotalRaw: asFundingRaw(1_000n),
          recipient: ADDR,
          owner: ADDR,
          deadlineSec: 1_700_000_000,
          hubMinOutRaw: 1n,
          integrator: zeroAddress,
        }),
      ).toThrow(BatchComposeRefusal)
    }
    for (const h of HOSTILE) {
      // a hostile DEADLINE is a refusal, in words
      expect(() =>
        composeBatchBuy({
          chainId: 8453,
          legs: [leg()],
          fundingAsset: zeroAddress,
          fundingTotalRaw: asFundingRaw(1_000n),
          recipient: ADDR,
          owner: ADDR,
          deadlineSec: h,
          hubMinOutRaw: 1n,
          integrator: zeroAddress,
        }),
      ).toThrow(BatchComposeRefusal)
    }
  })

  it('buildFundingPlan — hostile inventory either refuses in sentences or throws, never emits bad steps', () => {
    for (const h of HOSTILE) {
      for (const field of ['localFundingCents', 'sellProceedsCents'] as const) {
        // ⚠ THE TITLE PROMISED A DISJUNCTION THE BODY NEVER ALLOWED. It says
        // "either refuses in sentences OR THROWS" and then called the planner
        // bare, so the throwing half was untested — and when funding-plan
        // started refusing unreadable amounts loudly (adversarial pass,
        // 2026-08-08, replacing a silent clamp to zero) this sweep failed for
        // doing exactly what its own name says is acceptable. Same shape as the
        // atMs bounds earlier: read a test's title as a spec and check it has
        // both halves.
        let plan: ReturnType<typeof buildFundingPlan>
        try {
          plan = buildFundingPlan({
            chains: [{ chainId: 8453, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: 0, sellProceedsCents: 0, inboundRefuel: true, [field]: h }],
            needs: [{ chainId: 8453, buysCents: 10_000, feeCents: 50 }],
            newMoney: null,
          })
        } catch (e) {
          // a CONTRACT error is the loud half and is a pass; anything else is not
          expect(e, `fundingPlan/${field} threw a non-contract error`).toBeInstanceOf(FundingPlanContractError)
          continue
        }
        allFinite(`fundingPlan/${field}`, plan)
        for (const r of plan.refusals) expect(r.reason.length).toBeGreaterThan(0)
      }
      // a hostile NEED, and a hostile new-money pool. The new-money case below
      // already allowed the throwing half; this one did not, which is why the
      // contract check surfaced here first.
      try {
        allFinite(
          'fundingPlan/need',
          buildFundingPlan({
            chains: [{ chainId: 8453, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: 100_000, sellProceedsCents: 0, inboundRefuel: true }],
            needs: [{ chainId: 8453, buysCents: h, feeCents: h }],
            newMoney: null,
          }),
        )
      } catch (e) {
        expect(e).toBeInstanceOf(FundingPlanContractError)
      }
      try {
        allFinite(
          'fundingPlan/newMoney',
          buildFundingPlan({
            chains: [
              { chainId: 8453, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: 0, sellProceedsCents: 0, inboundRefuel: true },
              { chainId: 1, nativeRaw: 10n ** 18n, gasNeedRaw: 10n ** 15n, localFundingCents: 0, sellProceedsCents: 0, inboundRefuel: true },
            ],
            needs: [{ chainId: 8453, buysCents: 10_000, feeCents: 0 }],
            newMoney: { chainId: 1, availableCents: h },
          }),
        )
      } catch (e) {
        // a contract error is an acceptable answer; a bad number is not
        expect(e).toBeInstanceOf(FundingPlanContractError)
      }
    }
  })

  it('the fee-regime functions — hostile budgets and hostile bps never emit a bad figure (three regimes, contracts 2026-08-04)', () => {
    // These have no string inputs and no shown-text surface, so the strings
    // sweep has nothing real to assert on them — the numeric axis is the
    // whole attack surface.
    for (const h of HOSTILE) {
      // cents domain: a hostile budget answers 0, a hostile bps is clamped
      for (const v of [feeCentsOfTotal(h), fundingTotalForLegCents(h), rebalanceNeedCentsOnBudget(h), feeCentsOfTotal(10_000, h), fundingTotalForLegCents(10_000, h), rebalanceNeedCentsOnBudget(10_000, h)]) {
        expect(Number.isFinite(v) && v >= 0).toBe(true)
      }
      // raw domain: bigints cannot be NaN, but the bps parameter is a number —
      // clamped, so the fee stays within [0, a full-fee bound] whatever arrives
      const fee = rebalanceFeeRawOnBudget(10_000n, h)
      expect(fee >= 0n && fee <= 10_000n).toBe(true)
      const need = rebalanceEthNeedRaw(10_000n, h)
      expect(need >= 10_000n && need <= 20_000n).toBe(true)
      const actual = rebalanceFeeRawFromActual(10_000n, h)
      expect(actual >= 0n && actual <= 10_000n).toBe(true)
    }
    // a negative raw amount is not an amount: answers 0, never a negative fee
    expect(rebalanceFeeRawOnBudget(-5n)).toBe(0n)
    expect(rebalanceEthNeedRaw(-5n)).toBe(0n)
    expect(rebalanceFeeRawFromActual(-5n)).toBe(0n)
  })

  it('assembleBatchBuy — hostile money inputs refuse in sentences or compose finite figures, never crash raw', () => {
    const base = {
      chainId: 8453,
      targets: [
        {
          symbol: 'AAA',
          asset: ADDR,
          decimals: 18,
          weightPct: 100,
          priceUsd: 10,
          priceAgeMs: 1_000,
          liquidityUsd: 1_000_000,
          buyTokenTaxBps: 0,
          route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress } as const,
        },
      ],
      grossCents: 100_000,
      hopReserveUsd: 50_000_000,
      fundingTotalRaw: 10n ** 18n,
      fundingAsset: zeroAddress as `0x${string}`,
      account: ADDR,
      deadlineSec: 1_700_000_000,
      slippageBps: 50,
      hubUsd: 3_000,
      settlementDecimals: 6,
      integrator: zeroAddress as `0x${string}`,
    }
    for (const h of HOSTILE) {
      // hopReserveUsd and buyTokenTaxBps are MONEY FIELDS on the floor path
      // (the sweep law: a new money field gets a case here, or its
      // unreadable-input handling is untested by construction)
      for (const patch of [
        { grossCents: h },
        { slippageBps: h },
        { hubUsd: h, fundingAsset: ADDR as `0x${string}` },
        { settlementDecimals: h },
        { hopReserveUsd: h },
        { targets: [{ ...base.targets[0], buyTokenTaxBps: h }] },
      ]) {
        try {
          const out = assembleBatchBuy({ ...base, ...patch })
          allFinite('assemble', { feeCents: out.feeCents, legCents: out.legs.map((l) => l.budgetUsdCents) })
        } catch (e) {
          expect(e).toBeInstanceOf(BatchComposeRefusal)
          expect((e as Error).message.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('buildInsights — no card ever states a non-finite number', () => {
    const one = {
      positions: [{ key: '8453:0xa', symbol: 'X', valueUsd: 1000, pct: 100, tier: 'majors' as const, sourceCount: 1, liquidityUsd: null }],
      totalUsd: 1000,
      networks: 1,
      unpricedCount: 0,
    }
    for (const h of HOSTILE) {
      const inputs = [
        { ...one, baseline: { at: 1, shares: { '8453:0xa': h }, bandPp: 5 } },
        { ...one, exitCosts: [{ key: '8453:0xa', symbol: 'X', costUsd: h, costPct: h, sizeUsd: 1000, route: 'v4' }] },
        { ...one, depegs: [{ symbol: 'USDC', priceUsd: h, offPct: h, valueUsd: 5000 }] },
        { ...one, bets: { bets: h, included: 2, considered: 2, coveredSharePct: 100 } },
        { ...one, swing: { worstPct: h, bestPct: 1, included: 2, considered: 2, coveredSharePct: 100, days: 30 } },
        { ...one, navGaps: [{ key: '8453:0xa', symbol: 'X', divergencePct: h, valueUsd: 5000 }] },
        { ...one, positions: [{ ...one.positions[0], valueUsd: h, pct: h }], totalUsd: 1000 },
      ]
      for (const [i, input] of inputs.entries()) {
        const cards = buildInsights(input)
        allFinite(`insights[case${i}]`, cards.map((c) => ({ mark: c.mark, magnitude: c.magnitude })))
        // and no SHOWN string may contain the literal word — the numbers reach
        // the user as text, so the text is the real surface
        for (const c of cards) {
          const shown = `${c.headline} ${c.detail} ${c.subject} ${c.stat}`
          expect(shown).not.toMatch(/NaN|Infinity|undefined|null/)
        }
      }
    }
  })

  it('chainTotals — a hostile value never poisons its chain, and a failed chain never carries a figure', () => {
    for (const h of HOSTILE) {
      const rows = chainTotals([
        { chainId: 8453, valueUsd: h },
        { chainId: 8453, valueUsd: 1000 },
        { chainId: 1, valueUsd: h },
      ])
      allFinite('chainTotals', rows)
      // a hostile CHAIN ID cannot mint a row of its own
      allFinite('chainTotals/badChain', chainTotals([{ chainId: h, valueUsd: 500 }]))
      allFinite('chainTotals/badFailed', chainTotals([], { failedChainIds: [h] }))

      // UNREADABLE means dropped, not absorbed: only the values a read cannot
      // state (NaN, ±Infinity) and non-positive ones are excluded. A merely
      // ENORMOUS figure is finite and is the read's own answer — this module
      // reports what was read, it does not invent a ceiling.
      if (!Number.isFinite(h) || h <= 0) {
        expect(rows.find((r) => r.chainId === 8453)?.usd).toBe(1000)
        // a chain whose ONLY row was unreadable has nothing true to say, so it
        // is absent rather than present at zero — "$0 on Ethereum" is a claim
        expect(rows.some((r) => r.chainId === 1)).toBe(false)
      }

      // A FAILED CHAIN IS NEVER A ZERO: even with a stale row still in hand,
      // the row reports `failed` and its figure stays out of the sentence.
      const failed = chainTotals([{ chainId: 8453, valueUsd: 4200 }], { failedChainIds: [8453] })
      expect(failed).toHaveLength(1)
      expect(failed[0].state).toBe('failed')
      expect(failed[0].usd).toBe(0)
    }
    // unpricedChainIds survives an unreadable chain id without inventing one
    expect(unpricedChainIds([{ chainId: Number.NaN, usd: null }])).toEqual([])
    expect(unpricedChainIds([{ chainId: 1, usd: null }, { chainId: 1, usd: 5 }])).toEqual([1])
  })

  it('classifyTier — a hostile cap or launch date never mints an ultra small cap', () => {
    const NOW = 1_754_000_000_000
    for (const h of HOSTILE) {
      // a hostile CAP is unrankable, never a band
      expect(classifyTier('PEPE', h, { firstSeenMs: NOW - 1000, nowMs: NOW })).toBe(h > 0 ? 'large' : 'unranked')
      // a hostile AGE never qualifies: unknown is not new, and the ultra band
      // is the one place a wrong answer says "this is a fresh launch"
      expect(classifyTier('PEPE', 500_000, { firstSeenMs: h, nowMs: NOW })).toBe('micro')
      expect(isFreshlyLaunched(h, NOW)).toBe(false)
    }
    // a FUTURE date is not "launched moments ago" — a bad feed does produce it
    expect(isFreshlyLaunched(NOW + 86_400_000, NOW)).toBe(false)
    // and the band itself: both conditions, never either
    expect(classifyTier('PEPE', 500_000, { firstSeenMs: NOW - 86_400_000, nowMs: NOW })).toBe('ultra')
    expect(classifyTier('PEPE', 500_000, { firstSeenMs: NOW - 30 * 86_400_000, nowMs: NOW })).toBe('micro')
    expect(classifyTier('PEPE', 40_000_000, { firstSeenMs: NOW - 86_400_000, nowMs: NOW })).toBe('small')
  })

  it('foldCashPile — one unreadable stable never turns the whole pile into NaN', () => {
    const isCash = (s: string) => ['USDC', 'USDT', 'USDG'].includes(s.toUpperCase())
    for (const h of HOSTILE) {
      const units = unifyAssets([
        { key: '1:0xa', chainId: 1, address: '0xa', symbol: 'USDT', valueUsd: h, pct: h },
        { key: '8453:0xb', chainId: 8453, address: '0xb', symbol: 'USDC', valueUsd: 2500, pct: 25 },
        { key: '8453:0xc', chainId: 8453, address: '0xc', symbol: 'WETH', valueUsd: 1000, pct: 10 },
      ])
      const folded = foldCashPile(units, isCash)
      allFinite('foldCashPile', folded.map((u) => ({ valueUsd: u.valueUsd, pct: u.pct })))
      const pile = folded.find((u) => u.id === 'canon:cash-pile')
      expect(pile, `pile missing for ${h}`).toBeTruthy()
      const split = cashPileSplit(pile!)
      allFinite('cashPileSplit', split.map((r) => r.usd))
      // THE HEADLINE EQUALS ITS OWN LEGS, whatever the hostile value was: the
      // tile states one total above a breakdown, and the two are read together.
      expect(pile!.valueUsd).toBeCloseTo(split.reduce((s, r) => s + r.usd, 0), 6)
      if (!Number.isFinite(h) || h <= 0) {
        // the readable stable's dollars survive its unreadable neighbour intact
        expect(pile?.valueUsd).toBe(2500)
        expect(split.map((r) => r.symbol)).toEqual(['USDC'])
      }
      // WETH is not cash and never joins the pile (it stands under its own
      // canonical form, ETH — the wrap fold, untouched by the cash fold)
      expect(folded.some((u) => u.canon === 'ETH')).toBe(true)
      expect(pile?.parts.every((p) => isCash(p.symbol))).toBe(true)
    }
  })
})

describe('the portfolio-batcher path (plan §8, 2026-08-06) — hostile money in, sentences out', () => {
  it('maxCommittedFor never answers past the edge, whatever the fee', () => {
    for (const h of HOSTILE) {
      // a hostile fee is refused at composition; the solver clamps to the
      // contract range and never returns a committed the equation rejects
      const c = maxCommittedFor(1_000_000_000n, h)
      expect(c >= 0n).toBe(true)
    }
    expect(maxCommittedFor(0n, 50)).toBe(0n)
    expect(maxCommittedFor(-5n, 50)).toBe(0n)
  })

  it('composePortfolioBatchBuy — every hostile number field refuses in a sentence, never composes bad calldata', () => {
    const pleg = {
      symbol: 'AAVE',
      buyToken: ADDR,
      sellAmountRaw: asFundingRaw(1_000_000n),
      minBuyAmountRaw: 495_000n,
      swapData: ('0x2213bc0b' + 'ab'.repeat(32)) as `0x${string}`,
      optional: false,
    }
    const base = {
      legs: [pleg],
      fundingAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
      fundingTotalRaw: asFundingRaw(1_005_000n),
      owner: ADDR,
      recipient: ADDR,
      chainNowSec: 1_754_500_000,
      deadlineSec: 1_754_500_600,
      feeBps: 50,
      feeRecipient: '0x2222222222222222222222222222222222222222' as `0x${string}`,
    }
    for (const h of HOSTILE) {
      for (const patch of [{ feeBps: h }, { chainNowSec: h }, { deadlineSec: h }]) {
        expect(() => composePortfolioBatchBuy({ ...base, ...patch })).toThrow(BatchComposeRefusal)
      }
    }
    // bigint money fields cannot be NaN — zero/negative are the hostile forms
    for (const bad of [0n, -1n]) {
      expect(() => composePortfolioBatchBuy({ ...base, legs: [{ ...pleg, sellAmountRaw: asFundingRaw(bad) }] })).toThrow(BatchComposeRefusal)
      expect(() => composePortfolioBatchBuy({ ...base, legs: [{ ...pleg, minBuyAmountRaw: bad }] })).toThrow(BatchComposeRefusal)
      expect(() => composePortfolioBatchBuy({ ...base, fundingTotalRaw: asFundingRaw(bad) })).toThrow(BatchComposeRefusal)
    }
  })
})

describe('hop-reserve (the floor formula\'s last input) — a hostile depth is never a depth', () => {
  it('pickHopReserve answers null for every hostile side amount, never a flattering reserve', () => {
    const FUND = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const W = '0x4200000000000000000000000000000000000006'
    for (const h of [...HOSTILE, 0]) {
      const read = pickHopReserve(
        [{ baseToken: { address: FUND, symbol: 'USDC' }, quoteToken: { address: W, symbol: 'WETH' }, liquidity: { usd: 1e6, base: h, quote: 1 } }],
        FUND,
        W,
      )
      // 1e21 is a hostile-but-finite POSITIVE number: it may read, but it must
      // never read as anything non-finite
      if (read != null) expect(Number.isFinite(read.reserveUsd)).toBe(true)
      else expect(read).toBeNull()
    }
  })
  it('a hostile USD ranking figure cannot poison the chosen reserve', () => {
    const FUND = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const W = '0x4200000000000000000000000000000000000006'
    for (const h of HOSTILE) {
      const read = pickHopReserve(
        [{ baseToken: { address: FUND, symbol: 'USDC' }, quoteToken: { address: W, symbol: 'WETH' }, liquidity: { usd: h, base: 250_000, quote: 80 } }],
        FUND,
        W,
      )
      expect(read?.reserveUsd).toBe(250_000)
    }
  })
})

describe('gate A4 — the money modules the gate found missing from this sweep', () => {
  it('floor-discipline: a hostile bps or reserve refuses, and never emits a loose floor', () => {
    const leg = (o = {}) => ({ key: 'a', quotedBuyAmount: 1_000_000n, notional: 1_000, marketSlippageBps: 30, buyTokenTaxBps: 0, ...o })
    for (const h of HOSTILE) {
      for (const plan of [
        deriveLegFloors([leg({ marketSlippageBps: h })], { hopReserve: 250_000 }),
        deriveLegFloors([leg({ buyTokenTaxBps: h })], { hopReserve: 250_000 }),
        deriveLegFloors([leg({ notional: h })], { hopReserve: 250_000 }),
        deriveLegFloors([leg()], { hopReserve: h }),
        deriveLegFloors([leg()], { hopReserve: 250_000, sMaxBps: h }),
      ]) {
        allFinite('floor-discipline', plan.legs.map((l) => ({ s: l.sBps, ...l.breakdown })))
        // THE INVARIANT THAT MATTERS: a hostile input may refuse, but it must
        // never widen a floor past the cap (the loose direction)
        for (const l of plan.legs) expect(l.sBps).toBeLessThanOrEqual(300)
        for (const l of plan.legs) expect(l.minBuyAmount > 0n).toBe(true)
      }
    }
  })

  it('zeroex-quote: a hostile quoted amount or spot basis refuses, never floors off it', () => {
    const AH = '0x0000000000001fF3684f28c67538d4D072C22734'
    const ok = (o = {}) => ({
      liquidityAvailable: true, sellToken: ADDR, buyToken: '0x4200000000000000000000000000000000000006',
      sellAmount: '1000', buyAmount: '500', allowanceTarget: AH,
      transaction: { to: AH, value: '0', data: '0x2213bc0b' + 'ab'.repeat(32) }, ...o,
    })
    const want = (o = {}) => ({ symbol: 'X', chainId: 8453, sellToken: ADDR, buyToken: '0x4200000000000000000000000000000000000006' as `0x${string}`, sellAmountRaw: 1000n, spotOutRaw: 500n, ...o })
    for (const h of HOSTILE) {
      // a hostile SPOT basis has no honest bracket to judge against
      try {
        const q = validateLegQuote(ok(), want({ spotOutRaw: BigInt(Math.trunc(Number.isFinite(h) ? h : 0)) }))
        expect(q.buyAmountRaw > 0n).toBe(true)
      } catch (e) { expect((e as Error).message.length).toBeGreaterThan(10) }
      // a hostile buyAmount STRING must never parse into a floor basis
      try {
        validateLegQuote(ok({ buyAmount: String(h) }), want())
        expect.unreachable('a hostile buyAmount must refuse')
      } catch (e) { expect((e as Error).message.length).toBeGreaterThan(10) }
    }
  })

  it('capability-ladder: the confirm COUNT is finite and never under-reports', () => {
    const caps = { atomicBatch: false, permit2: false, permit2Approved: new Set<string>(), funding2612: false }
    for (const n of [0, 1, 5, 32]) {
      const r = resolveLadder(
        {
          chainId: 8453,
          sellApprovals: [],
          fundingApproval: { token: ADDR, symbol: 'USDC', amountRaw: 1n },
          sideSwaps: Array.from({ length: n }, (_, i) => ({ token: ADDR, symbol: `T${i}` })),
        },
        caps,
      )
      expect(Number.isFinite(r.confirmCount)).toBe(true)
      // the count must equal the list a user will actually be shown
      expect(r.confirmCount).toBe(r.confirms.length)
      expect(r.confirmCount).toBeGreaterThanOrEqual(n)
    }
  })
})

describe('economic-leg-cap — a hostile price never buys extra legs', () => {
  it('every hostile gas price or native price yields a usable integer, never a bigger plan', () => {
    for (const h of HOSTILE) {
      const a = economicLegCap({ contractMaxLegs: 32, gasPriceWei: 10_000_000n, nativeUsd: h, feeUsd: 50 })
      const b = economicLegCap({ contractMaxLegs: h, gasPriceWei: 10_000_000n, nativeUsd: 3_000, feeUsd: 50 })
      const c = economicLegCap({ contractMaxLegs: 32, gasPriceWei: 10_000_000n, nativeUsd: 3_000, feeUsd: h })
      for (const v of [a, b, c]) {
        expect(Number.isInteger(v.maxLegs)).toBe(true)
        expect(v.maxLegs).toBeGreaterThanOrEqual(0)
        expect(v.maxLegs).toBeLessThanOrEqual(32)
      }
    }
  })
})

describe('realised-price — a hostile fill never reports calm', () => {
  it('unmeasurable legs are excluded, never counted as clean', () => {
    const bad = Array.from({ length: 20 }, (_, i) => ({
      key: `B${i}`, fundingUsed: 0n, delivered: -1n, minBuyAmount: 0n, quotedBuyAmount: 0n,
    }))
    for (const l of bad) expect(bandSlackBps(l)).toBeNull()
    const v = skimSignal(bad)
    expect(v.kind).toBe('insufficient-sample')
  })
  it('every slack reading is a finite bps inside the band', () => {
    for (const delivered of [0n, 1n, 10n ** 30n]) {
      const s = bandSlackBps({ key: 'x', fundingUsed: 1n, delivered, minBuyAmount: 900_000n, quotedBuyAmount: 1_000_000n })
      if (s == null) continue
      expect(Number.isFinite(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(10_000)
    }
  })
})

describe('displayed-vs-signed — a hostile batch position refuses, never skips verification', () => {
  it('NaN, ±Infinity, -1, 1e21 and a fraction as batchIndex each refuse in a sentence', () => {
    // the danger shape: an index that answers false to every honest comparison
    // could route AROUND the diff (nothing at calls[NaN]) — the gate must treat
    // "the batch is not where the review said" as a refusal, never a skip
    const ADDR2 = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const
    const shown = {
      chainId: 8453,
      fundingAsset: zeroAddress,
      fundingTotalRaw: 100n,
      recipient: ADDR2,
      legs: [],
      approvals: [],
      // ⚠ DELIBERATELY NOT MINTED through `shownAtReviewSurface`, which refuses
      // an empty-leg review — and that is the point of this case. The property
      // under test is that a hostile INDEX never routes around verification
      // WHATEVER the review holds, so the gate must hold it without leaning on
      // the mint's validation. A cast here is defence in depth, not a shortcut.
    } as unknown as ShownStepReview
    // the bundle-shape check fires before anything decodes, so the
    // composition here only has to exist — a hostile INDEX must never route
    // around verification, whatever it points at
    const anyComposed = { args: [[], zeroAddress, 0n, {}], value: 0n, capCost: 0 } as unknown as ComposedBatchBuy
    for (const idx of [...HOSTILE, 1.5]) {
      const out = diffDisplayedVsSigned([{ to: ADDR2, data: '0x00', value: 0n }], idx, ADDR2, shown, anyComposed)
      expect(typeof out).toBe('string')
      expect(out).toMatch(/nothing was signed/)
    }
  })
})


describe('acquisition-inputs — a hostile DEPTH never clears an exit', () => {
  // liquidityUsd is a third-party number feeding a safety threshold, and the
  // output gates whether we buy at all. The invariant is one-directional: no
  // hostile depth may produce 'ok' / 'confirmed'.
  const TOK = '0x1111111111111111111111111111111111111111'
  const WETH9 = '0x4200000000000000000000000000000000000006'
  const pool = (liquidityUsd: number | null) => ({
    id: '0xpool', venue: 'v3' as const, token0: TOK, token1: WETH9,
    feeBps: 500, tickSpacing: 10, liquidityUsd,
    onChainConfirmed: true, indexerConfirmed: true,
  })

  it('NaN, ±Infinity, -1, 1e21 and null depth never clear the pool or confirm the exit', () => {
    for (const h of [...HOSTILE, null]) {
      const v = poolVerdictFrom([pool(h as number | null)], TOK, [WETH9])
      const path = nativeSellPath(v)
      // an unreadable or absurd depth may REFUSE or ASK; it may never say ok
      expect(v?.kind, `depth=${h}`).not.toBe('ok')
      expect(path, `depth=${h}`).not.toBe('confirmed')
    }
  })

  it('assessPool itself: no hostile depth returns ok — read DIRECTLY, not only through the adapter', () => {
    // A4 wants this module swept on its own terms: the adapter could stop
    // passing hostile values through and the hole here would reopen unseen.
    const CTX = { tokenAddress: TOK, allowedQuoteAssets: [WETH9], minLiquidityUsd: 25_000 }
    for (const h of [...HOSTILE, null, MAX_PLAUSIBLE_POOL_LIQUIDITY_USD + 1]) {
      const v = assessPool([pool(h as number | null)], CTX)
      expect(v.kind, `depth=${h}`).not.toBe('ok')
      // and every verdict still carries a sentence, whatever the input
      if (v.kind !== 'ok') expect(v.message.length).toBeGreaterThan(0)
    }
  })

  it('a hostile depth never turns the whole bundle into a batch leg', () => {
    for (const h of HOSTILE) {
      const inputs = acquisitionInputsFor({
        symbol: 'X', candidates: [pool(h)], tokenAddress: TOK, quoteAssets: [WETH9], zeroEx: 'routable',
      })
      // 'routable' is the ONLY input that could produce a silent batch leg, so
      // this is the cell that matters: a bad depth must still not clear it.
      expect(inputs.sellPath, `depth=${h}`).not.toBe('confirmed')
    }
  })
})


describe('zerox-proxy-request — a hostile NUMBER never reaches the upstream URL', () => {
  // The proxy holds the credential, so its numeric inputs (chainId,
  // sellAmount, slippageBps) are the surface a caller controls. The invariant
  // is one-directional: a hostile number must REFUSE, never be forwarded and
  // never be silently normalised into something we did not validate.
  const TOK_A = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const TOK_B = '0x4200000000000000000000000000000000000006'
  const TKR = '0x0fe4223AD99dF788A6Dcad148eB4086E6389cEB6'
  const PATH = '/swap/allowance-holder/quote'
  const q = (over: Record<string, string> = {}) =>
    new URLSearchParams({ chainId: '8453', sellToken: TOK_A, buyToken: TOK_B, sellAmount: '250000000', taker: TKR, ...over })

  it('a hostile chainId refuses — we are not a general-purpose gateway', () => {
    for (const h of [...HOSTILE, 0, 1.5]) {
      expect(buildZeroxUpstream(PATH, q({ chainId: String(h) })).ok, `chainId=${h}`).toBe(false)
    }
  })

  it('a hostile sellAmount refuses, and a valid one is never mutated', () => {
    for (const h of [...HOSTILE, 0, 1.5]) {
      expect(buildZeroxUpstream(PATH, q({ sellAmount: String(h) })).ok, `sellAmount=${h}`).toBe(false)
    }
    const good = buildZeroxUpstream(PATH, q({ sellAmount: '250000000' }))
    expect(good.ok && new URL(good.url).searchParams.get('sellAmount')).toBe('250000000')
  })

  it('a hostile slippage refuses rather than being dropped — a dropped bound quotes a DIFFERENT trade', () => {
    for (const h of [...HOSTILE, 1.5, 10_000]) {
      expect(buildZeroxUpstream(PATH, q({ slippageBps: String(h) })).ok, `slippageBps=${h}`).toBe(false)
    }
  })

  it('no refusal ever emits a non-finite figure or echoes the hostile value', () => {
    for (const h of HOSTILE) {
      const r = buildZeroxUpstream(PATH, q({ chainId: String(h), sellAmount: String(h) }))
      expect(r.ok).toBe(false)
      if (!r.ok) {
        allFinite('zerox-proxy-request', r)
        expect(r.reason).not.toContain(String(h))
      }
    }
  })
})

describe('the ??-for-numbers class, swept after UIGuy reproduced it in the launch flow (2026-08-07)', () => {
  const T = () => ({
    symbol: 'X',
    asset: ADDR,
    decimals: 18,
    weightPct: 100,
    priceUsd: 10,
    priceAgeMs: 5_000,
    liquidityUsd: 1_000_000,
    buyTokenTaxBps: 0,
    route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
  })

  it('planToLegs: an unmeasurable depth NEVER lands on the required side', () => {
    // ⚠ THE SWEEP ABOVE WAS GREEN WHILE THIS HOLE WAS LIVE, because it asserted
    // budget finiteness and never CONSENT: a NaN liquidityUsd passed `== null`,
    // failed `<= 0`, failed the ratio (every NaN comparison is false) — and the
    // leg composed REQUIRED, with no thin-leg consent. A sweep that checks the
    // wrong property is a green banner over the defect.
    for (const h of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { legs } = planToLegs([{ ...T(), liquidityUsd: h }], 100_000)
      expect(legs).toHaveLength(1)
      expect(legs[0].optional, `liquidityUsd=${h}`).toBe(true)
    }
    // and a real, deep pool still lands required — the fix must not blanket-flip
    const { legs } = planToLegs([T()], 100_000)
    expect(legs[0].optional).toBe(false)
  })

  it('haircut: an unreadable slippage REFUSES rather than composing a floor that cannot fill', () => {
    // reviewer M4: the old `: 0` fallback demanded 100% of the frictionless
    // quote — a guaranteed revert shipped as a safe-looking number. The
    // conservative-sounding default was the dangerous one. The fixture is the
    // module's own (my first cut invented an input shape and pinned an
    // UPSTREAM refusal instead — a pin can prove the wrong thing while red).
    for (const h of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        assembleBatchBuy({
          chainId: 8453,
          // a basket PAIR since the 2026-08-13 cap ruling: a lone 100% leg
          // refuses upstream and the law under pin here is the SLIPPAGE one
          targets: [
            {
              symbol: 'AAA',
              asset: ADDR,
              decimals: 18,
              weightPct: 50,
              priceUsd: 10,
              priceAgeMs: 1_000,
              liquidityUsd: 10_000_000,
              buyTokenTaxBps: 0,
              route: 'basket',
            },
            {
              symbol: 'BBB',
              asset: '0x2222222222222222222222222222222222222222' as Address,
              decimals: 18,
              weightPct: 50,
              priceUsd: 10,
              priceAgeMs: 1_000,
              liquidityUsd: 10_000_000,
              buyTokenTaxBps: 0,
              route: 'basket',
            },
          ],
          grossCents: 100_000,
          fundingTotalRaw: 10n ** 18n,
          fundingAsset: zeroAddress,
          account: ADDR,
          deadlineSec: 1_700_000_000,
          slippageBps: h,
          hopReserveUsd: 50_000_000,
          hubUsd: 3_000,
          settlementDecimals: 6,
          integrator: zeroAddress,
        }),
      ).toThrow(/slippage setting is unreadable/)
    }
  })
})
