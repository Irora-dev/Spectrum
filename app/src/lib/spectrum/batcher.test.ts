import { describe, expect, it } from 'vitest'
import { getAbiItem, toFunctionSelector, zeroAddress } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import {
  asFundingRaw,
  BATCH_BUY_SELECTOR,
  BATCH_LEG_CAP,
  BATCH_REBALANCE_SELECTOR,
  BATCHER_VENUE,
  batcherAbi,
  MAX_PLAUSIBLE_DEADLINE_SEC,
  BatchComposeRefusal,
  batchCapCost,
  composeBatchBuy,
  composeLeg,
  simulateBatchBuy,
  feeCentsOfTotal,
  fundingTotalForLegCents,
  rebalanceEthNeedRaw,
  rebalanceFeeRawFromActual,
  rebalanceFeeRawOnBudget,
  rebalanceNeedCentsOnBudget,
  scaleLegBudgetsToRaw,
  skippedLegs,
  type BatcherLegInput,
  type ComposeBatchBuyInput,
} from './batcher'
import { BATCH_FEE_BPS } from './allocation'

const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
const A = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const

const leg = (over: Partial<BatcherLegInput> = {}): BatcherLegInput => ({
  symbol: 'AAVE',
  asset: A,
  route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
  budgetRaw: asFundingRaw(1_000_000n),
  quotedOutRaw: 500_000n,
  // the floor plan's number, pre-derived (50 bps off the quote basis here) —
  // composeLeg CARRIES it, floor derivation lives in floor-discipline
  minOutRaw: 497_500n,
  optional: false,
  ...over,
})

/** THE GROSS total that leaves exactly `legSum` spendable after the fee — the
 *  funding equation, inverted (seam round, 2026-08-04). These fixtures used to
 *  set `fundingTotalRaw = sum(legs)`, which encoded the law BEFORE it had a fee
 *  term: the batch would pull only the net and the contract's cut would come
 *  out of the legs, leaving every floor above what its leg could buy. */
const grossFor = (legSum: bigint): bigint => {
  if (legSum <= 0n) return 0n
  // ceil, then walk down: integer flooring means the exact inverse may not
  // exist, and over-funding refunds while under-funding starves a leg
  let t = (legSum * 10_000n + (10_000n - BigInt(BATCH_FEE_BPS) - 1n)) / (10_000n - BigInt(BATCH_FEE_BPS))
  for (let i = 0; i < 4; i += 1) {
    const spendable = t - (t * BigInt(BATCH_FEE_BPS)) / 10_000n
    if (spendable === legSum) return t
    t += spendable < legSum ? 1n : -1n
  }
  return t
}

/** A compose input satisfying the funding equation — tests that want a
 *  violation override fundingTotalRaw. */
const buy = (over: Partial<ComposeBatchBuyInput> = {}): ComposeBatchBuyInput => {
  const legs = over.legs ?? [leg()]
  return {
    chainId: 8453,
    legs,
    fundingAsset: zeroAddress,
    fundingTotalRaw: asFundingRaw(grossFor(legs.reduce((s, l) => s + l.budgetRaw, 0n))),
    recipient: A,
    owner: A,
    deadlineSec: 9,
    hubMinOutRaw: 1n,
    integrator: zeroAddress,
    ...over,
  }
}

describe('ONE ABI, THREE CHAINS — the selector tripwire (contracts 2026-08-04, post-port)', () => {
  // forge inspect on both builds says all three chains share these. If a
  // struct field here drifts — width, order, count — the selector changes
  // and this fails, instead of the call reverting on chain. This exact
  // tripwire caught the morning's two-batchers divergence.
  it('batchBuy/batchRebalance selectors match forge inspect', () => {
    expect(toFunctionSelector(getAbiItem({ abi: batcherAbi, name: 'batchBuy' }) as never)).toBe(BATCH_BUY_SELECTOR)
    expect(toFunctionSelector(getAbiItem({ abi: batcherAbi, name: 'batchRebalance' }) as never)).toBe(BATCH_REBALANCE_SELECTOR)
  })
  it('claimIntegratorFees(address) matches its forge-inspected selector on the shared ABI', () => {
    expect(toFunctionSelector(getAbiItem({ abi: batcherAbi, name: 'claimIntegratorFees' }) as never)).toBe('0x242d665b')
  })
  it('an unmapped chain refuses at composition, never guesses a struct shape', () => {
    expect(() => composeBatchBuy(buy({ chainId: 999 }))).toThrow(/no known batcher build/i)
  })
  it('the integrator rides calldata on every batcher chain — 4663 included since the port', () => {
    for (const chainId of [1, 8453, 4663]) {
      const c = composeBatchBuy(buy({ chainId, integrator: A }))
      expect(c.args[3].integrator).toBe(A)
    }
  })
})

describe('the batcher venue mapping — enums that do not align are never cast', () => {
  it('maps V4/V3/V2 explicitly', () => {
    expect(composeLeg(leg()).venue).toBe(BATCHER_VENUE.V4)
    expect(composeLeg(leg({ route: { venue: Venue.V3, ethPool: KEY, v3Fee: 3000, v2Pair: zeroAddress } })).venue).toBe(BATCHER_VENUE.V3)
    expect(composeLeg(leg({ route: { venue: Venue.V2, ethPool: KEY, v3Fee: 0, v2Pair: A } })).venue).toBe(BATCHER_VENUE.V2)
  })

  it('REFUSES V4Q — the value 3 is a stocks venue on one side and a basket on the other', () => {
    expect(() => composeLeg(leg({ route: { venue: Venue.V4Q, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress } }))).toThrow(BatchComposeRefusal)
  })

  it('a basket leg takes the BASKET venue with a zeroed route', () => {
    const c = composeLeg(leg({ route: 'basket' }))
    expect(c.venue).toBe(BATCHER_VENUE.BASKET)
    expect(c.v2Pair).toBe(zeroAddress)
  })
})

describe('floors — never zero, always ours', () => {
  it('CARRIES the floor the plan derived — composition never re-derives one', () => {
    const c = composeLeg(leg({ minOutRaw: 9_750n }))
    expect(c.minOut).toBe(9_750n)
  })
  it('refuses a leg with no floor — a zero floor protects nothing', () => {
    expect(() => composeLeg(leg({ minOutRaw: 0n }))).toThrow(/no floor|zero floor/i)
  })
  it('refuses a zero hub floor at the batch level', () => {
    expect(() => composeBatchBuy(buy({ hubMinOutRaw: 0n }))).toThrow(/hub floor/i)
  })
})

describe('THE CENTS/RAW SEAM (battle-test half-1 finding 1)', () => {
  it('budgets that do not sum to the funding total REFUSE — the measured wrong-money case', () => {
    // the probe's own reproduction: cents-scale budgets against an 1e18 total
    const legs = [leg({ budgetRaw: asFundingRaw(60_000n) }), leg({ symbol: 'BBB', budgetRaw: asFundingRaw(40_000n) })]
    expect(() => composeBatchBuy(buy({ legs, fundingTotalRaw: asFundingRaw(10n ** 18n) }))).toThrow(/can only spend/i)
  })
  it('budgets summing to the SPENDABLE compose (the equation, not the identity)', () => {
    const legs = [leg({ budgetRaw: asFundingRaw(60n) }), leg({ symbol: 'BBB', budgetRaw: asFundingRaw(40n) })]
    const c = composeBatchBuy(buy({ legs }))
    const total = c.args[2]
    expect(total - (total * BigInt(BATCH_FEE_BPS)) / 10_000n).toBe(100n)
  })

  it('BELOW THE FEE FLOOR the equation degenerates honestly: total === legs, because the fee rounds to zero', () => {
    // Integer truth worth naming so a reader does not assume the fee term is
    // always non-zero: (100 raw × 50bps) / 10000 floors to 0, so a batch that
    // small charges nothing and the total IS the spendable. Found while
    // updating these fixtures — my own assumption was the wrong one.
    const legs = [leg({ budgetRaw: asFundingRaw(60n) }), leg({ symbol: 'BBB', budgetRaw: asFundingRaw(40n) })]
    expect(() => composeBatchBuy(buy({ legs, fundingTotalRaw: asFundingRaw(100n) }))).not.toThrow()
    // and at a size where the fee is real, the identity is refused
    const big = [leg({ budgetRaw: asFundingRaw(1_000_000n) })]
    expect(() => composeBatchBuy(buy({ legs: big, fundingTotalRaw: asFundingRaw(1_000_000n) }))).toThrow(/can only spend/)
  })
  it('asFundingRaw refuses a negative amount', () => {
    expect(() => asFundingRaw(-1n)).toThrow(/not an amount/i)
  })
})

describe('the batch composition', () => {
  it('native funding rides msg.value; ERC-20 funding sends zero value', () => {
    const native = composeBatchBuy(buy())
    // the GROSS is what msg.value carries — the legs spend what is left after
    // the fee, which is the funding equation's whole point
    expect(native.value).toBe(native.args[2])
    expect(native.value).toBeGreaterThan(1_000_000n)
    const erc = composeBatchBuy(buy({ fundingAsset: A }))
    expect(erc.value).toBe(0n)
  })

  it('carries the ruled fee in calldata (uint16 number, the deployed width) and an explicit recipient', () => {
    const c = composeBatchBuy(buy())
    expect(c.args[3].feeBps).toBe(BATCH_FEE_BPS)
    expect(() => composeBatchBuy(buy({ recipient: zeroAddress }))).toThrow(/recipient/i)
  })

  it('a fractional deadline refuses with a sentence, never a raw BigInt RangeError (finding 7)', () => {
    expect(() => composeBatchBuy(buy({ deadlineSec: 1723456789.5 }))).toThrow(/plausible unix second/i)
    expect(() => composeBatchBuy(buy({ deadlineSec: 0 }))).toThrow(/plausible unix second/i)
  })

  it('an ABSURDLY FUTURE deadline refuses too — a signature that never expires is a standing grant', () => {
    // The hostile-number sweep found this: `Number.isInteger(1e21)` is TRUE, so
    // a wei-scale value pasted into a seconds field composed a deadline ~30
    // trillion years out — the standing-grant shape P1 forbids on the permit
    // side, reached on the batch side.
    expect(() => composeBatchBuy(buy({ deadlineSec: 1e21 }))).toThrow(/never expires/i)
    expect(() => composeBatchBuy(buy({ deadlineSec: MAX_PLAUSIBLE_DEADLINE_SEC + 1 }))).toThrow(BatchComposeRefusal)
    // and a real one still composes
    expect(composeBatchBuy(buy({ deadlineSec: 1_800_000_000 })).args[3].deadline).toBe(1_800_000_000n)
  })

  it('a basket leg weighs 6 toward the 32 cap; over-budget plans refuse with the split sentence', () => {
    expect(batchCapCost([leg(), leg({ route: 'basket' })])).toBe(7)
    const legs = Array.from({ length: 6 }, () => leg({ route: 'basket' as const })) // 36 > 32
    expect(() => composeBatchBuy(buy({ legs }))).toThrow(new RegExp(`${BATCH_LEG_CAP}-leg`))
  })
})

describe('audit round: the recipient-is-owner law', () => {
  it('a recipient that is not the signer REFUSES — outputs cannot be pointed elsewhere', () => {
    expect(() => composeBatchBuy(buy({ recipient: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE0' }))).toThrow(/your own wallet/i)
  })
})

describe('the consent surface decode', () => {
  it('reads skipped legs out of the bitmap', () => {
    expect(skippedLegs({ skippedBitmap: 0b101n }, 4)).toEqual([0, 2])
    expect(skippedLegs({ skippedBitmap: 0n }, 4)).toEqual([])
  })
})

describe('THE THREE FEE REGIMES — measured off SpectrumBatcher.sol (contracts desk note, 2026-08-04 16:02)', () => {
  it('regime 1 (batchBuy, L352-353): the scaling step spends exactly T − floor(T·f/BPS) — the contract arithmetic, not an approximation', () => {
    for (const t of [1n, 3n, 700n, 99_999n, 12_345_678n, 10n ** 18n + 7n]) {
      const contractFee = (t * BigInt(BATCH_FEE_BPS)) / 10_000n
      const [only] = scaleLegBudgetsToRaw([100], asFundingRaw(t))
      expect(only).toBe(t - contractFee)
    }
  })

  it('regime 2 (funded rebalance, L524-525): fee ADDITIVE on venueBuyBudget — B + floor(B·f/BPS), the opposite direction from batchBuy', () => {
    // ⚠ THE FEE IS PASSED EXPLICITLY, AND THAT IS THE POINT. These four numbers
    // were hand-computed off the contract source, and they read the DEFAULT fee
    // until the owner's 2026-08-07 ruling moved it and broke them. The tempting fix
    // — rewrite each expectation as (B · BATCH_FEE_BPS)/10_000 — would have made
    // both sides compute from the same constant by the same formula, i.e.
    // f(x) === f(x), which is exactly the tautology that let six calldata
    // tampers through the P8 gate a day earlier. What this test asserts is the
    // contract's SHAPE (additive, and floored so a sub-unit fee rounds to zero
    // in the user's favour) — a property true at any f, so it is pinned at a
    // FIXED f against literals nobody can silently move.
    const f = 50
    expect(rebalanceFeeRawOnBudget(10_000n, f)).toBe(50n)
    expect(rebalanceEthNeedRaw(10_000n, f)).toBe(10_050n)
    // an odd value, so the floor visibly bites: 199·50/10000 = 0.995 → 0
    expect(rebalanceFeeRawOnBudget(199n, f)).toBe(0n)
    expect(rebalanceEthNeedRaw(199n, f)).toBe(199n)
  })

  it('regime 2 holds at the SHIPPED fee too — the coverage gap the ruling exposed', () => {
    // every regime number above is pinned at a fixed f, so after the ruling
    // nothing exercised this arithmetic at the fee we actually charge.
    expect(rebalanceFeeRawOnBudget(10_000n)).toBe(BigInt(BATCH_FEE_BPS))
    expect(rebalanceEthNeedRaw(10_000n)).toBe(10_000n + BigInt(BATCH_FEE_BPS))
    // and regime 3's inverse still closes at it
    expect(rebalanceFeeRawFromActual(rebalanceEthNeedRaw(10_000n))).toBe(rebalanceFeeRawOnBudget(10_000n))
  })

  it('regime 3 (L561-565) IS regime 2’s exact integer inverse at the fully-funded boundary — a property, not prose', () => {
    // write B·f = a·BPS + r with r < BPS; then (B+a)·f = a·(BPS+f) + r, so
    // floor((B+a)·f/(BPS+f)) = a exactly — the two formulas never disagree
    // when the ETH side arrives whole
    for (const b of [1n, 7n, 199n, 10_000n, 123_456_789n, 10n ** 18n + 12_345n, 99_999_999_999_999_999n]) {
      expect(rebalanceFeeRawFromActual(rebalanceEthNeedRaw(b))).toBe(rebalanceFeeRawOnBudget(b))
    }
  })

  it('when sells come in LIGHT, regime 2’s prediction is a CEILING on the actual fee — the safe sizing direction, never the exact charge', () => {
    const b = 123_456_789n
    const need = rebalanceEthNeedRaw(b)
    const predicted = rebalanceFeeRawOnBudget(b)
    for (const have of [1n, 17n, need / 3n, need - 1n]) {
      expect(rebalanceFeeRawFromActual(have) <= predicted).toBe(true)
    }
  })

  it('SELLS ARE NEVER TAXED: venueBuyBudget 0 ⇒ fee 0 (contract-side pin: BatcherVenueSells.t.sol) — an earnings line multiplying exit volume by feeBps is wrong by model', () => {
    expect(rebalanceFeeRawOnBudget(0n)).toBe(0n)
    expect(rebalanceEthNeedRaw(0n)).toBe(0n)
    expect(rebalanceFeeRawFromActual(0n)).toBe(0n)
  })

  it('MIXING THE BASES IS DIRECTIONAL: the inclusive gross-up ≥ the additive need everywhere (over-funds → refund; the reverse under-funds → revert)', () => {
    for (const s of [1, 7, 99, 700, 99_999, 12_345_678]) {
      expect(fundingTotalForLegCents(s)).toBeGreaterThanOrEqual(rebalanceNeedCentsOnBudget(s))
    }
  })

  it('the cents-domain rebalance need rounds the fee UP — a cent under-reserved demotes a "fully funded" plan into regime 3', () => {
    // fixed f for the same reason as regime 2: the ROUNDING DIRECTION is the
    // claim, and it must be pinned against literals rather than recomputed from
    // whatever the policy currently is.
    const f = 50
    expect(rebalanceNeedCentsOnBudget(199, f)).toBe(200) // raw truth floors to 0; planning reserves the cent
    expect(rebalanceNeedCentsOnBudget(10_000, f)).toBe(10_050)
    // the direction survives the ruling: at 40 bps, 199·40/10000 = 0.796, and a
    // reserved cent is still a whole cent — under-reserving is the failure that
    // demotes a funded plan, so this may only ever round up.
    expect(rebalanceNeedCentsOnBudget(199)).toBe(200)
    expect(rebalanceNeedCentsOnBudget(10_000)).toBe(10_000 + BATCH_FEE_BPS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE DEGENERATE-INPUT FAMILY (gate A12's batcher sweep left 18 survivors, and
// they were one class wearing eighteen hats).
//
// Every cent/raw helper here early-returns zero for input that cannot describe
// money. The sweep flipped `<= 0` to `< 0`, `>= 10_000` to `> 10_000`, `&&` to
// `||` and dropped `!`s across all of them, and nothing objected — not because
// the guards are wrong but because NOTHING ASSERTED THE FAMILY. Pinning
// eighteen mutants one at a time would be eighteen tests saying the same thing
// badly; this says it once, over every helper and every degenerate shape.
//
// WHY IT MATTERS BEYOND THE SWEEP: these helpers feed the funding seam, so a
// helper that returned a NUMBER for a nonsense input would put that number into
// a budget. Zero is the only safe answer, and "returns zero" is exactly the
// property no individual test was making.
// ─────────────────────────────────────────────────────────────────────────────
describe('every money helper returns ZERO for input that cannot describe money', () => {
  const DEGENERATE = [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]

  it('the cents-domain helpers', () => {
    for (const d of DEGENERATE) {
      expect(feeCentsOfTotal(d), `feeCentsOfTotal(${d})`).toBe(0)
      expect(fundingTotalForLegCents(d), `fundingTotalForLegCents(${d})`).toBe(0)
      expect(rebalanceNeedCentsOnBudget(d), `rebalanceNeedCentsOnBudget(${d})`).toBe(0)
    }
  })

  it('the raw-domain helpers', () => {
    for (const d of [0n, -1n]) {
      expect(rebalanceFeeRawOnBudget(d), `rebalanceFeeRawOnBudget(${d})`).toBe(0n)
      expect(rebalanceEthNeedRaw(d), `rebalanceEthNeedRaw(${d})`).toBe(0n)
      expect(rebalanceFeeRawFromActual(d), `rebalanceFeeRawFromActual(${d})`).toBe(0n)
    }
  })

  it('a degenerate FEE clamps to ZERO rather than charging something invented', () => {
    // clampBps: non-finite → 0, then bounded to [0, 10_000]. So an unreadable
    // fee charges NOTHING; it never falls back to the default (which would
    // charge a number the caller did not ask for) and never overflows.
    for (const f of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      expect(feeCentsOfTotal(100_000, f), `feeCentsOfTotal(fee=${f})`).toBe(0)
      expect(rebalanceFeeRawOnBudget(10_000n, f), `rebalanceFeeRawOnBudget(fee=${f})`).toBe(0n)
    }
    // +Infinity clamps UP to the 100% ceiling, which the callers then refuse
    expect(feeCentsOfTotal(100_000, Number.POSITIVE_INFINITY)).toBe(0)
    // ⚠ AND A 100% FEE IS NOT "ZERO FEE" — my third wrong assertion in this
    // block, corrected by the suite: at 10_000 bps the FEE IS THE WHOLE TOTAL
    // (nothing left for legs), which is arithmetically right. The helper that
    // refuses is the INVERSE one, because there is no gross total that leaves a
    // positive spendable at a 100% fee. Writing a family law over helpers I had
    // not read closely produced three wrong expectations; each is now the
    // helper's actual contract rather than my assumed uniformity.
    expect(feeCentsOfTotal(100_000, 10_000)).toBe(100_000)
    expect(fundingTotalForLegCents(100_000, 10_000)).toBe(0)
    // a huge FINITE fee clamps to that same 100% ceiling (it is not non-finite,
    // so it is bounded rather than zeroed)
    expect(feeCentsOfTotal(100_000, 1e9)).toBe(100_000)
  })

  it('scaleLegBudgetsToRaw: NO usable weight means every leg zero; ONE usable weight takes it all', () => {
    // ⚠ MY FIRST ASSERTION HERE WAS WRONG and the suite said so: [NaN, 1] does
    // NOT zero the plan — a bad weight zeroes ITS OWN leg and the survivors
    // share the spendable, which is the documented behaviour and the right one
    // (voiding a whole plan because one weight is unreadable would be worse).
    // The family law is narrower than I first wrote it.
    for (const none of [[], [0, 0], [-1, -1], [Number.NaN, Number.NaN]]) {
      const out = scaleLegBudgetsToRaw(none as number[], asFundingRaw(10n ** 18n))
      expect(out.every((v) => v === 0n), `weights ${JSON.stringify(none)}`).toBe(true)
    }
    const mixed = scaleLegBudgetsToRaw([Number.NaN, 1], asFundingRaw(10n ** 18n))
    expect(mixed[0], 'the unreadable weight gets nothing').toBe(0n)
    const total = 10n ** 18n
    expect(mixed[1], 'the readable one gets the whole spendable').toBe(total - (total * BigInt(BATCH_FEE_BPS)) / 10_000n)
  })
})

describe('the thin-leg CONSENT flag is validated like the floor beside it (self-audit, 2026-08-07)', () => {
  // The asymmetry was the tell: composeLeg refuses a zero floor two lines above
  // and passed `optional` through untouched. That flag decides whether the
  // contract may SILENTLY SKIP the leg — the difference between "the user
  // agreed this may be dropped" and "the user required it".
  it('a non-boolean consent refuses rather than riding into the calldata', () => {
    for (const bad of [undefined, null, 'yes', 1, 0, 'false']) {
      expect(() => composeLeg(leg({ optional: bad as never })), `optional=${JSON.stringify(bad)}`).toThrow(/not a consent/)
    }
  })

  it('both real answers still compose, and reach the calldata unchanged', () => {
    expect(composeLeg(leg({ optional: true })).optional).toBe(true)
    expect(composeLeg(leg({ optional: false })).optional).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TWO REFUSALS THAT NO TEST REACHED (mutation run 4: batcher.ts at 80.38% with
// 10 mutants under NO COVERAGE, these among them).
//
// Both were checked against the equivalent-mutant rule before writing a line:
// each is the FIRST statement of its function, with nothing layered above it to
// refuse identically if it were deleted — so unlike assemble-batch's survivors,
// these are real gaps rather than the cost of defensive layering.
// ─────────────────────────────────────────────────────────────────────────────

describe('composeLeg — a leg with nothing in it', () => {
  it('refuses a zero budget, and a negative one, in the review-grade sentence', () => {
    for (const budgetRaw of [0n, -1n]) {
      expect(() => composeLeg(leg({ budgetRaw: asFundingRaw(budgetRaw) })), `budget ${budgetRaw}`).toThrow(BatchComposeRefusal)
    }
    expect(() => composeLeg(leg({ budgetRaw: asFundingRaw(0n) }))).toThrow(/no budget cannot be composed/i)
  })

  it('names the LEG in its refusal — a composition failure the user can act on', () => {
    // the sentence carries the symbol because "a leg" is not actionable and
    // "$AAVE" is; and it goes through showSymbol, so a hostile ticker cannot
    // reshape the sentence it appears in
    expect(() => composeLeg(leg({ budgetRaw: asFundingRaw(0n), symbol: 'AAVE' }))).toThrow(/\$AAVE/)
  })

  it('still composes the ordinary case — the guard refuses nothing it should not', () => {
    expect(() => composeLeg(leg({ budgetRaw: asFundingRaw(1n) }))).not.toThrow()
  })
})

describe('simulateBatchBuy — the signer must be the recipient', () => {
  const OTHER = '0x000000000000000000000000000000000000dEaD' as const
  // a client that would answer if it were ever reached; the point of these two
  // is that the first one never reaches it
  const client = { simulateContract: async () => ({ result: null }) } as never

  it('refuses to SIMULATE a batch whose outputs land somewhere the signer never named', async () => {
    const composed = composeBatchBuy(buy())
    await expect(simulateBatchBuy(client, A, OTHER, composed)).rejects.toThrow(BatchComposeRefusal)
    await expect(simulateBatchBuy(client, A, OTHER, composed)).rejects.toThrow(/not the composed recipient/i)
  })

  it('is case-insensitive on the address — EIP-55 casing is checksum data, not identity', async () => {
    // the recipient composed here is `A`; handing the same address in a
    // different case must NOT read as a different account, or the guard refuses
    // every honest batch whose address arrived checksummed from one layer and
    // lowercased from another
    const composed = composeBatchBuy(buy())
    await expect(simulateBatchBuy(client, A, A.toLowerCase() as typeof A, composed)).resolves.toBeDefined()
  })
})

describe('the inclusive ceilings and the tie-break (mutation triage, 2026-08-07)', () => {
  // Five of batcher's fifteen survivors were real. Three were found by a
  // differential probe (apply the mutant, run a boundary battery, diff); the
  // other two live inside composeBatchBuy, which that probe never called — so
  // their "identical" result measured NOTHING and they are pinned here on the
  // strength of the shape rather than of that run. Both turned out real.

  it('a batch weighing EXACTLY the leg cap composes — the cap is inclusive', () => {
    // `capCost > BATCH_LEG_CAP` narrowed to `>=` refuses a plan that fits
    // exactly. Nothing asserted the boundary itself, only one past it.
    const legs = Array.from({ length: BATCH_LEG_CAP }, () => leg())
    expect(batchCapCost(legs)).toBe(BATCH_LEG_CAP)
    expect(() => composeBatchBuy(buy({ legs }))).not.toThrow()
    expect(() => composeBatchBuy(buy({ legs: [...legs, leg()] }))).toThrow(/must split/i)
  })

  it('a deadline of EXACTLY the plausible ceiling composes — one past it refuses', () => {
    // Same shape on the clock bound: `> MAX` widened to `>=` refuses the last
    // legal second. The refusal past it was pinned; the boundary was not.
    expect(() => composeBatchBuy(buy({ deadlineSec: MAX_PLAUSIBLE_DEADLINE_SEC }))).not.toThrow()
    expect(() => composeBatchBuy(buy({ deadlineSec: MAX_PLAUSIBLE_DEADLINE_SEC + 1 }))).toThrow(/plausible unix second/i)
  })

  it('a NEGATIVE leg budget weighs zero — it never rides through as a negative amount', () => {
    // `Number.isFinite(c) && c > 0` turned `||` lets -5 reach Math.floor and
    // become a negative weight, which the FundingRaw brand then refuses
    // outright. Measured: the same call goes from a clean split to a throw.
    const out = scaleLegBudgetsToRaw([-5, 100], asFundingRaw(1000n))
    expect(out.map(String)).toEqual(['0', '996'])
  })

  it('equal fractions break toward the EARLIER leg — the odd unit has one home', () => {
    // The largest-remainder comparator. Flipping `<` to `<=` reverses ties, so
    // the spare unit silently moves to a different leg. Nothing pinned which
    // leg receives it, and with two equal legs and an odd total that IS the
    // whole question.
    expect(scaleLegBudgetsToRaw([100, 100], asFundingRaw(1n)).map(String)).toEqual(['1', '0'])
    expect(scaleLegBudgetsToRaw([100, 100], asFundingRaw(3n)).map(String)).toEqual(['2', '1'])
    expect(scaleLegBudgetsToRaw([1, 1, 1], asFundingRaw(1n)).map(String)).toEqual(['1', '0', '0'])
  })

  it('skippedLegs never reads a bit beyond the declared leg count', () => {
    // `i < legCount` widened to `<=` reads one bit past the end, so a bitmap
    // with bit 0 set reports leg 0 skipped on a batch that has NO legs. A
    // skipped-leg list is read back as "this leg did not execute".
    expect(skippedLegs({ skippedBitmap: 1n } as never, 0)).toEqual([])
    expect(skippedLegs({ skippedBitmap: 2n } as never, 1)).toEqual([])
    expect(skippedLegs({ skippedBitmap: 3n } as never, 2)).toEqual([0, 1])
  })
})

describe('the semantics nobody asserted (independent pass 2026-08-08, FINDINGS-TESTS)', () => {
  // Four mutations that survived all 1963 tests, each because the value was
  // COMPOSED correctly and then never read back by anything. A field that is
  // always right by construction and never asserted is not protected — it is
  // unobserved, and the next refactor is what discovers the difference.

  it('refPriceX96 is ZERO on every composed leg, basket and venue alike', () => {
    // Asserted in none of the 141 test files: 0n -> 12345n survived everything.
    // batcher.ts own header calls this field's semantics contracts-owed, which
    // is exactly why it must read zero until they are owed no longer — a
    // non-zero reference price is a claim about pricing we have not made.
    const venueLeg = composeLeg(leg())
    expect(venueLeg.refPriceX96).toBe(0n)
    const basketLeg = composeLeg(leg({ route: 'basket' }))
    expect(basketLeg.refPriceX96).toBe(0n)
  })

  it('a BASKET leg zeroes its whole route, even when the input carries a real one', () => {
    // The "zeroed route" law was stated in the composer and enforced nowhere:
    // v3Fee 0 -> 999 and ethPool ZERO_KEY -> an attacker-shaped key both
    // survived 1963 tests. A basket leg does not swap on a pool, so any pool
    // data riding in its calldata is at best meaningless and at worst a route
    // the contract might act on.
    const out = composeLeg(leg({ route: 'basket' }))
    expect(out.v3Fee).toBe(0)
    expect(out.v2Pair).toBe(zeroAddress)
    expect(out.ethPool.currency0).toBe(zeroAddress)
    expect(out.ethPool.currency1).toBe(zeroAddress)
    expect(out.ethPool.fee).toBe(0)
    expect(out.ethPool.tickSpacing).toBe(0)
    expect(out.ethPool.hooks).toBe(zeroAddress)
  })

  it('BATCH_FEE_BPS is pinned against a LITERAL, and the batch carries that exact fee', () => {
    // 40 -> 45 survived all four target suites, because every assertion that
    // touches the fee DERIVES from the constant — f(x) === f(x). A policy value
    // is pinned against a literal nobody can move; only a conservation law may
    // derive. Both halves are asserted here on purpose.
    expect(BATCH_FEE_BPS).toBe(40)
    const c = composeBatchBuy(buy())
    expect(c.args[3].feeBps).toBe(40)
  })
})
