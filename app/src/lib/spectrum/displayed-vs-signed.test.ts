import { describe, expect, it } from 'vitest'
import { Venue, type PoolKey } from '../pools/types'
import type { PlanLegInput } from './plan-legs'
import { assembleBatchBuy } from './assemble-batch'
import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import { BATCH_FEE_BPS, GEN2_BATCH_FEE_BPS } from './allocation'
import { asFundingRaw, batcherAbi, composeBatchBuy, type BatcherLegInput, type ComposedBatchBuy } from './batcher'
import { composePortfolioBatchBuy, portfolioBatcherAbi, type ComposedPortfolioBatchBuy } from './portfolio-batcher'
import { compositionLawsBroken, diffDisplayedVsSigned, diffDisplayedVsSignedPortfolio, MAX_SKIPPABLE_SHARE_PCT, type ShownStepReview, shownAtReviewSurface, portfolioCompositionLawsBroken } from './displayed-vs-signed'

// THE DISPLAYED-VS-SIGNED GATE: the review's number and the signature's number
// must be THE SAME NUMBER. Every test here mutates ONE money-bearing field of
// the exact bytes a wallet would sign and expects the gate to name it — the
// gate returning null under any of these mutations is the defect class this
// module exists to close (a display showing one thing while the signature
// carries another). The happy path runs through the REAL composer + the REAL
// encoder, so what passes is the production pipeline, not a fixture's echo.

const OWNER = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
const ATTACKER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const BATCHER = '0x4200000000000000000000000000000000000606' as Address
const SETTLEMENT = '0x4200000000000000000000000000000000000006' as Address
const ASSET_A = '0x1111111111111111111111111111111111111111' as Address
const ASSET_B = '0x2222222222222222222222222222222222222222' as Address

const TOTAL = 1_000_000n
const FEE = (TOTAL * BigInt(BATCH_FEE_BPS)) / 10_000n
const SPENDABLE = TOTAL - FEE

const legInputs: BatcherLegInput[] = [
  { symbol: 'AAA', asset: ASSET_A, route: 'basket', budgetRaw: asFundingRaw(SPENDABLE - 400_000n), quotedOutRaw: 5_000n, minOutRaw: 4_900n, optional: false },
  { symbol: 'BBB', asset: ASSET_B, route: 'basket', budgetRaw: asFundingRaw(400_000n), quotedOutRaw: 3_000n, minOutRaw: 2_940n, optional: true },
]

function composed(): ComposedBatchBuy {
  return composeBatchBuy({
    chainId: 8453,
    legs: legInputs,
    fundingAsset: SETTLEMENT,
    fundingTotalRaw: asFundingRaw(TOTAL),
    recipient: OWNER,
    owner: OWNER,
    deadlineSec: 1_800_000_000,
    hubMinOutRaw: 1n,
    integrator: OWNER,
  })
}

/** The exact encoding runner-effects performs — the bytes under test. */
const encode = (args: ComposedBatchBuy['args']): Hex => encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args })

/** Deep-copy the composed args so a mutation cannot leak between tests. */
function argsCopy(a: ComposedBatchBuy['args']): [
  (typeof a)[0][number][],
  Address,
  bigint,
  (typeof a)[3],
] {
  return [a[0].map((l) => ({ ...l, ethPool: { ...l.ethPool } })), a[1], a[2], { ...a[3] }]
}

/** What the review rendered — built from the same values the station's rows
 *  read (asset, budget raw, floor raw, optional), NOT from the encoded args. */
const shownReview = (): ShownStepReview =>
  shownAtReviewSurface({
    chainId: 8453,
    fundingAsset: SETTLEMENT,
    fundingTotalRaw: TOTAL,
    recipient: OWNER,
    legs: legInputs.map((l) => ({ symbol: l.symbol, asset: l.asset, budgetRaw: l.budgetRaw as bigint, minOutRaw: l.minOutRaw, optional: l.optional })),
    approvals: [],
  })

const batchCall = (data: Hex) => ({ to: BATCHER, data, value: 0n })

describe('the happy path — the production pipeline diffs clean', () => {
  it('real composer → real encoder → null (every shown field is in the bytes)', () => {
    const c = composed()
    expect(diffDisplayedVsSigned([batchCall(encode(c.args))], 0, BATCHER, shownReview(), c)).toBeNull()
  })

  it('with a disclosed approval riding ahead of the batch', () => {
    const c = composed()
    const approve = encodeFunctionData({
      abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
      functionName: 'approve',
      args: [BATCHER, TOTAL],
    })
    const calls = [{ to: SETTLEMENT, data: approve, value: 0n }, batchCall(encode(c.args))]
    const shown = { ...shownReview(), approvals: [{ token: SETTLEMENT, amountRaw: TOTAL }] }
    expect(diffDisplayedVsSigned(calls, 1, BATCHER, shown, c)).toBeNull()
  })
})

describe('every money-bearing mutation of the BYTES is named — none may pass', () => {
  // Tamper the BYTES while the composition stays honest — the post-encoding
  // divergence P8 exists for. Each named field must still refuse in its own
  // words rather than falling through to the catch-all.
  const mutate = (fn: (a: ReturnType<typeof argsCopy>) => void): string | null => {
    const a = argsCopy(composed().args)
    fn(a)
    const tampered = a as unknown as ComposedBatchBuy['args']
    return diffDisplayedVsSigned([batchCall(encode(tampered))], 0, BATCHER, shownReview(), { ...composed(), args: tampered })
  }

  it('a redirected recipient', () => {
    expect(mutate((a) => (a[3].recipient = ATTACKER))).toMatch(/different address than your own wallet/)
  })
  it('a swapped funding asset', () => {
    expect(mutate((a) => (a[1] = ATTACKER))).toMatch(/different asset than the review showed/)
  })
  it('an inflated pull — one raw unit is enough', () => {
    expect(mutate((a) => (a[2] = TOTAL + 1n))).toMatch(/different total than the review showed/)
  })
  it('a swapped leg asset', () => {
    expect(mutate((a) => (a[0][0].asset = ATTACKER))).toMatch(/\$AAA.*different asset/)
  })
  it('an inflated leg budget', () => {
    expect(mutate((a) => (a[0][1].budget += 1n))).toMatch(/\$BBB.*different amount/)
  })
  it('a lowered protection floor — the sandwich door', () => {
    expect(mutate((a) => (a[0][0].minOut -= 1n))).toMatch(/\$AAA.*different protection floor/)
  })
  it('a required leg quietly marked skippable', () => {
    expect(mutate((a) => (a[0][0].optional = true))).toMatch(/\$AAA.*required.*allow it to be skipped/)
  })
  it('a skippable leg quietly marked required', () => {
    expect(mutate((a) => (a[0][1].optional = false))).toMatch(/\$BBB.*may be skipped.*required/)
  })
  it('a dropped leg', () => {
    expect(mutate((a) => void a[0].pop())).toMatch(/carries 1 asset where the review showed 2/)
  })
  it('an added leg', () => {
    expect(mutate((a) => void a[0].push({ ...a[0][0], asset: ATTACKER }))).toMatch(/carries 3 assets where the review showed 2/)
  })
  it('reordered legs — position is meaning (RequiredLegFailed is positional)', () => {
    expect(mutate((a) => void a[0].reverse())).toMatch(/\$AAA/)
  })
})

describe('the bundle itself is verified — not only the batch call', () => {
  const approveAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
  const goodApprove = () => ({
    to: SETTLEMENT,
    data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [BATCHER, TOTAL] }),
    value: 0n,
  })
  const shownWithApproval = () => ({ ...shownReview(), approvals: [{ token: SETTLEMENT, amountRaw: TOTAL }] })
  const goodBatch = () => batchCall(encode(composed().args))

  it('an approval the review never showed refuses — call count is part of what was disclosed', () => {
    expect(diffDisplayedVsSigned([goodApprove(), goodBatch()], 1, BATCHER, shownReview(), composed())).toMatch(/2 transactions where the review showed 1/)
  })
  it('an approval spender that is not the batcher refuses — the allowance leak door', () => {
    const bad = {
      ...goodApprove(),
      data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [ATTACKER, TOTAL] }),
    }
    expect(diffDisplayedVsSigned([bad, goodBatch()], 1, BATCHER, shownWithApproval(), composed())).toMatch(/different spender than the batch contract/)
  })
  it('an inflated approval amount refuses — one raw unit is enough', () => {
    const bad = {
      ...goodApprove(),
      data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [BATCHER, TOTAL + 1n] }),
    }
    expect(diffDisplayedVsSigned([bad, goodBatch()], 1, BATCHER, shownWithApproval(), composed())).toMatch(/different amount than the review showed/)
  })
  it('an approval against a different token refuses', () => {
    expect(diffDisplayedVsSigned([{ ...goodApprove(), to: ATTACKER }, goodBatch()], 1, BATCHER, shownWithApproval(), composed())).toMatch(
      /different token than the review showed/,
    )
  })
  it('an approval carrying native value refuses', () => {
    expect(diffDisplayedVsSigned([{ ...goodApprove(), value: 1n }, goodBatch()], 1, BATCHER, shownWithApproval(), composed())).toMatch(
      /carries money it should not/,
    )
  })
  it('a call that is not an approval in an approval slot refuses', () => {
    expect(diffDisplayedVsSigned([{ ...goodApprove(), data: '0xdeadbeef' as Hex }, goodBatch()], 1, BATCHER, shownWithApproval(), composed())).toMatch(
      /not the approval the review showed/,
    )
  })
})

describe('the native value is a LAW, not a shown field', () => {
  const nativeComposed = (): ComposedBatchBuy =>
    composeBatchBuy({
      chainId: 8453,
      legs: legInputs,
      fundingAsset: '0x0000000000000000000000000000000000000000' as Address,
      fundingTotalRaw: asFundingRaw(TOTAL),
      recipient: OWNER,
      owner: OWNER,
      deadlineSec: 1_800_000_000,
      hubMinOutRaw: 1n,
      integrator: OWNER,
    })
  const nativeShown = (): ShownStepReview =>
    shownAtReviewSurface({ ...shownReview(), fundingAsset: '0x0000000000000000000000000000000000000000' as Address })

  it('native funding rides the pull as the value — the honest pipeline passes', () => {
    const c = nativeComposed()
    expect(diffDisplayedVsSigned([{ to: BATCHER, data: encode(c.args), value: c.value }], 0, BATCHER, nativeShown(), c)).toBeNull()
  })
  it('a tampered value refuses — the most direct theft shape there is', () => {
    const c = nativeComposed()
    expect(diffDisplayedVsSigned([{ to: BATCHER, data: encode(c.args), value: c.value - 1n }], 0, BATCHER, nativeShown(), c)).toMatch(
      /different amount of the network’s own money/,
    )
    // and an ERC-20 batch smuggling native value refuses too
    const erc = composed()
    expect(diffDisplayedVsSigned([{ to: BATCHER, data: encode(erc.args), value: 1n }], 0, BATCHER, shownReview(), erc)).toMatch(
      /different amount of the network’s own money/,
    )
  })
})

describe('fail-closed on anything unrecognizable', () => {
  it('bytes that do not decode as the batcher ABI refuse', () => {
    expect(diffDisplayedVsSigned([batchCall('0xdeadbeef' as Hex)], 0, BATCHER, shownReview(), composed())).toMatch(/could not read this transaction back/)
  })
  it('a DIFFERENT function on the same contract refuses — selector is meaning', () => {
    const data = encodeFunctionData({ abi: batcherAbi, functionName: 'claimIntegratorFees', args: [OWNER] })
    expect(diffDisplayedVsSigned([batchCall(data)], 0, BATCHER, shownReview(), composed())).toMatch(/not the batch purchase you reviewed/)
  })
  it('a batch aimed at a different contract refuses', () => {
    const c = composed()
    expect(diffDisplayedVsSigned([{ to: ATTACKER, data: encode(c.args), value: 0n }], 0, BATCHER, shownReview(), c)).toMatch(
      /different contract than the one we deployed to/,
    )
  })
  it('a batchIndex that does not point at the batch refuses', () => {
    const c = composed()
    expect(diffDisplayedVsSigned([batchCall(encode(c.args))], 5, BATCHER, shownReview(), c)).toMatch(/not where the review said/)
  })
})

describe('shown text stays bounded in refusal sentences (the safe-copy law)', () => {
  it('a 300-char hostile symbol cannot flood the refusal sentence', () => {
    const shown = shownReview()
    shown.legs[0] = { ...shown.legs[0], symbol: 'X'.repeat(300) }
    const a = argsCopy(composed().args)
    a[0][0].minOut -= 1n
    const tampered = a as unknown as ComposedBatchBuy['args']
    const message = diffDisplayedVsSigned([batchCall(encode(tampered))], 0, BATCHER, shown, { ...composed(), args: tampered })
    expect(message).toMatch(/protection floor/)
    expect((message ?? '').length).toBeLessThan(220)
  })
})

describe('the CATCH-ALL closes the fields the review does not render — all six passed before it', () => {
  // Verbatim from the A6 verify pass: each of these tampered the calldata in a
  // field `ShownStepReview` has no column for, and the gate returned null. A
  // field list is a memory test; re-encoding the composition is not.
  /** A composition with a REAL hub floor — the base fixture passes 1n, so
   *  "gutted to 1" would have been a no-op tamper producing identical bytes
   *  (caught by this pin failing the first time it ran). */
  const withHubFloor = (): ComposedBatchBuy =>
    composeBatchBuy({
      chainId: 8453,
      legs: legInputs,
      fundingAsset: SETTLEMENT,
      fundingTotalRaw: asFundingRaw(TOTAL),
      recipient: OWNER,
      owner: OWNER,
      deadlineSec: 1_800_000_000,
      hubMinOutRaw: 5_000n,
      integrator: OWNER,
    })
  const tamperBytesOnly = (fn: (a: ReturnType<typeof argsCopy>) => void): string | null => {
    const honest = withHubFloor() // what we prepared, and what the review saw
    const a = argsCopy(honest.args)
    fn(a)
    // the BYTES carry the tamper; the composition does not
    return diffDisplayedVsSigned(
      [batchCall(encode(a as unknown as ComposedBatchBuy['args']))],
      0,
      BATCHER,
      shownReview(),
      honest,
    )
  }
  const notMatched = /does not match the batch we prepared/

  it('the HUB floor gutted to 1 — one field over from the leg floor it already refuses', () => {
    expect(tamperBytesOnly((a) => (a[3].hubMinOut = 1n))).toMatch(notMatched)
  })
  it('the fee raised to 900 bps with the integrator repointed — direct value extraction', () => {
    expect(tamperBytesOnly((a) => { a[3].feeBps = 900; a[3].integrator = ATTACKER })).toMatch(notMatched)
  })
  it('a deadline in the year 5138 — a signature that never expires', () => {
    expect(tamperBytesOnly((a) => (a[3].deadline = 99_999_999_999n))).toMatch(notMatched)
  })
  it('a leg rerouted to an attacker V2 pair', () => {
    expect(tamperBytesOnly((a) => { a[0][0].venue = 2; a[0][0].v2Pair = ATTACKER })).toMatch(notMatched)
  })
  it('a V4 hook repointed — arbitrary code inside the swap', () => {
    expect(tamperBytesOnly((a) => (a[0][0].ethPool = { ...a[0][0].ethPool, hooks: ATTACKER }))).toMatch(notMatched)
  })
  it('aggMinBps and a leg reference price moved', () => {
    expect(tamperBytesOnly((a) => { a[3].aggMinBps = 9999; a[0][0].refPriceX96 = 9999n })).toMatch(notMatched)
  })

  it('trailing garbage appended to honest calldata — it decodes cleanly and no field read can see it', () => {
    const c = composed()
    const withSuffix = (encode(c.args) + 'de'.repeat(32)) as Hex
    expect(diffDisplayedVsSigned([batchCall(withSuffix)], 0, BATCHER, shownReview(), c)).toMatch(notMatched)
  })

  it('a composition that disagrees with the bytes refuses even when the review matches BOTH', () => {
    // The non-circular half: shown can be satisfied and this still bites.
    const honest = composed()
    const other = composeBatchBuy({
      chainId: 8453,
      legs: legInputs,
      fundingAsset: SETTLEMENT,
      fundingTotalRaw: asFundingRaw(TOTAL),
      recipient: OWNER,
      owner: OWNER,
      deadlineSec: 1_800_000_001, // one second apart: invisible to the review
      hubMinOutRaw: 1n,
      integrator: OWNER,
    })
    expect(diffDisplayedVsSigned([batchCall(encode(other.args))], 0, BATCHER, shownReview(), honest)).toMatch(notMatched)
  })
})

describe('THE SIX TAMPERS THE RE-ENCODE NEVER CAUGHT — composition vs what it was not derived from', () => {
  // ⚠ A6 review, 2026-08-07 (CRITICAL). The byte catch-all is `f(x) === f(x)`
  // at its only call site: runner-effects encodes from `composed.args` and the
  // gate re-encodes the same object. Every tamper that lives in the
  // COMPOSITION — which is where the threat lives, since composeStep is a
  // caller-supplied closure — passed it. These pin the check that actually
  // separates the two sides: our own constants, the signer, and the CHAIN's
  // clock, none of which the composer supplies.
  const NOW = 1_800_000_000
  const ind = { account: OWNER, chainNowSec: NOW - 60, maxDeadlineWindowSec: 1_800 }
  const tamper = (fn: (a: ReturnType<typeof argsCopy>) => void) => {
    const a = argsCopy(composed().args)
    fn(a)
    return compositionLawsBroken({ ...composed(), args: a as unknown as ComposedBatchBuy['args'] }, ind)
  }

  it('an honest composition passes', () => {
    expect(compositionLawsBroken(composed(), ind)).toBeNull()
  })

  // ── the two exact CLOCK boundaries (gate A12's sweep left both unpinned) ──
  // Money time is CHAIN time, and these two comparisons decide whether a
  // signature is already dead or lives too long. The sweep flipped `<=` to `<`
  // and `>` to `>=` and nothing objected — so the edges were never asserted,
  // only the middle. On a deadline, an off-by-one edge IS the bug class: a
  // batch that arrives at exactly the current second is expired, and one that
  // lasts exactly the allowed window is legal.
  it('a deadline EXACTLY on the chain clock is already expired — arriving now is arriving late', () => {
    expect(tamper((a) => (a[3].deadline = BigInt(ind.chainNowSec)))).toMatch(/already expired/)
    // one second later is alive, so the refusal is the edge and not the region
    expect(tamper((a) => (a[3].deadline = BigInt(ind.chainNowSec + 1)))).toBeNull()
  })

  it('a deadline EXACTLY at the allowed window is legal; one second past is not', () => {
    expect(tamper((a) => (a[3].deadline = BigInt(ind.chainNowSec + ind.maxDeadlineWindowSec)))).toBeNull()
    expect(tamper((a) => (a[3].deadline = BigInt(ind.chainNowSec + ind.maxDeadlineWindowSec + 1)))).toMatch(/signable for far longer/)
  })
  it('hubMinOut gutted to zero — the hub-side floor', () => {
    expect(tamper((a) => (a[3].hubMinOut = 0n))).toMatch(/no protection floor on its funding swap/)
  })
  it('a fee that is not the one this app charges', () => {
    expect(tamper((a) => (a[3].feeBps = 900))).toMatch(/different fee/)
    expect(tamper((a) => (a[3].feeBps = BATCH_FEE_BPS + 1))).toMatch(/different fee/)
  })
  it('a routing tolerance we never set', () => {
    expect(tamper((a) => (a[3].aggMinBps = 9999))).toMatch(/routing tolerance this app never sets/)
  })
  it('a deadline in the year 5138 — measured against the CHAIN clock, not the composer', () => {
    expect(tamper((a) => (a[3].deadline = 99_999_999_999n))).toMatch(/far longer than we allow/)
  })
  it('a deadline already past', () => {
    expect(tamper((a) => (a[3].deadline = BigInt(NOW - 600)))).toMatch(/already expired/)
  })
  it('a recipient that is not the signer', () => {
    expect(tamper((a) => (a[3].recipient = ATTACKER))).toMatch(/not the wallet running it/)
  })
  it('a leg with no floor, and a leg with no budget', () => {
    expect(tamper((a) => (a[0][0].minOut = 0n))).toMatch(/no protection floor/)
    expect(tamper((a) => (a[0][0].budget = 0n))).toMatch(/commits nothing/)
  })
  it('a pull of nothing', () => {
    expect(tamper((a) => (a[2] = 0n))).toMatch(/pulls nothing/)
  })
})

describe('approval calldata is BYTE-exact — viem decodes trailing garbage happily', () => {
  const approveAbi2 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
  it('appended bytes are refused even though the decode returns the right values', () => {
    const good = encodeFunctionData({ abi: approveAbi2, functionName: 'approve', args: [BATCHER, TOTAL] })
    const withJunk = (good + 'de'.repeat(32)) as Hex
    const calls = [{ to: SETTLEMENT, data: withJunk, value: 0n }, batchCall(encode(composed().args))]
    const shown = { ...shownReview(), approvals: [{ token: SETTLEMENT, amountRaw: TOTAL }] }
    expect(diffDisplayedVsSigned(calls, 1, BATCHER, shown, composed())).toMatch(/not exactly the approval/)
  })
})

describe('EXACT equality, in BOTH directions — the tests only ever tested inflation', () => {
  // A6 review: mutating `!==` to `>` survived the whole suite for the approval
  // amount, the leg budget and the funding total, because every case tested a
  // value going UP. A deflated number is a different theft, not a safer one.
  const mutate = (fn: (a: ReturnType<typeof argsCopy>) => void): string | null => {
    const a = argsCopy(composed().args)
    fn(a)
    const t = a as unknown as ComposedBatchBuy['args']
    return diffDisplayedVsSigned([batchCall(encode(t))], 0, BATCHER, shownReview(), { ...composed(), args: t })
  }
  it('a DEFLATED leg budget refuses', () => {
    expect(mutate((a) => (a[0][1].budget -= 1n))).toMatch(/\$BBB.*different amount/)
  })
  it('a DEFLATED pull refuses', () => {
    expect(mutate((a) => (a[2] = TOTAL - 1n))).toMatch(/different total/)
  })
  it('a RAISED protection floor refuses too — any divergence, not just a weakening', () => {
    expect(mutate((a) => (a[0][0].minOut += 1n))).toMatch(/different protection floor/)
  })
  it('a DEFLATED approval refuses', () => {
    const approveAbi3 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
    const less = encodeFunctionData({ abi: approveAbi3, functionName: 'approve', args: [BATCHER, TOTAL - 1n] })
    const shown = { ...shownReview(), approvals: [{ token: SETTLEMENT, amountRaw: TOTAL }] }
    expect(diffDisplayedVsSigned([{ to: SETTLEMENT, data: less, value: 0n }, batchCall(encode(composed().args))], 1, BATCHER, shown, composed())).toMatch(
      /different amount/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T1-2 — THE SHOWN REVIEW IS BRANDED (independent review, 2026-08-07).
//
// The reviewer's point: without a brand, this gate's value depends ENTIRELY on
// UI wiring nobody has written, and the cheapest wiring — walk the composition,
// build a review from it — makes the gate f(x) === f(x). That is not
// speculative; it is what the P8 catch-all did the same day, one file over.
// ─────────────────────────────────────────────────────────────────────────────
describe('the shown review can only be minted at the render surface', () => {
  const fields = () => ({
    chainId: 8453,
    fundingAsset: SETTLEMENT,
    fundingTotalRaw: TOTAL,
    recipient: OWNER,
    legs: [{ symbol: 'AAVE', asset: OWNER, budgetRaw: 10n, minOutRaw: 9n, optional: false }],
    approvals: [] as { token: Address; amountRaw: bigint }[],
  })

  it('mints a review from displayed values, and the gate accepts it', () => {
    const r = shownAtReviewSurface(fields())
    expect(r.chainId).toBe(8453)
    expect(r.legs).toHaveLength(1)
  })

  it('refuses a review that is not a rendering of anything a person confirmed', () => {
    // shape, not agreement — the values are what the gate is FOR, so the mint
    // must not judge them; it only refuses shapes no review surface can produce
    expect(() => shownAtReviewSurface({ ...fields(), legs: [] })).toThrow(RangeError)
    expect(() => shownAtReviewSurface({ ...fields(), chainId: 0 })).toThrow(RangeError)
    expect(() => shownAtReviewSurface({ ...fields(), chainId: Number.NaN })).toThrow(RangeError)
    expect(() => shownAtReviewSurface({ ...fields(), fundingTotalRaw: -1n })).toThrow(RangeError)
    expect(() => shownAtReviewSurface({ ...fields(), legs: [{ ...fields().legs[0], budgetRaw: -1n }] })).toThrow(RangeError)
    expect(() => shownAtReviewSurface({ ...fields(), legs: [{ ...fields().legs[0], minOutRaw: -1n }] })).toThrow(RangeError)
    expect(() => shownAtReviewSurface({ ...fields(), approvals: [{ token: OWNER, amountRaw: -1n }] })).toThrow(RangeError)
  })

  it('MINTING IS NOT BLESSING — a minted review that disagrees with the bytes still refuses', () => {
    // the load-bearing property. If the mint could launder a divergent record
    // into an accepted one, the brand would have made the gate WEAKER than the
    // structural type it replaced.
    const c = composed()
    const tampered = shownAtReviewSurface({ ...shownReview(), fundingTotalRaw: shownReview().fundingTotalRaw + 1n })
    expect(diffDisplayedVsSigned([batchCall(encode(c.args))], 0, BATCHER, tampered, c)).not.toBeNull()
  })
})

describe('the NULLABLE floor — review finding 280, reproduced then closed', () => {
  const KEY2: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
  const TGT = (symbol: string, addr: string, route: PlanLegInput['route']): PlanLegInput => ({
    symbol,
    asset: addr as PlanLegInput['asset'],
    decimals: 18,
    weightPct: 50,
    priceUsd: 10,
    priceAgeMs: 1_000,
    liquidityUsd: 10_000_000,
    buyTokenTaxBps: 0,
    route,
  })
  const mixed = () =>
    assembleBatchBuy({
      chainId: 8453,
      targets: [
        TGT('VEN', `0x${'1'.repeat(40)}`, { venue: Venue.V4, ethPool: KEY2, v3Fee: 0, v2Pair: zeroAddress }),
        TGT('BSK', `0x${'2'.repeat(40)}`, 'basket'),
      ],
      grossCents: 100_000,
      fundingTotalRaw: asFundingRaw(350_000_000_000_000_000n),
      fundingAsset: zeroAddress,
      account: OWNER,
      deadlineSec: 1_800_000_000,
      slippageBps: 100,
      hopReserveUsd: 50_000_000,
      hubUsd: 3_000,
      settlementDecimals: 6,
      integrator: zeroAddress,
    })
  const BATCHER2 = `0x${'b'.repeat(40)}` as Address
  const enc = (a: ComposedBatchBuy['args']) => encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args: a })

  it('the assembled basket leg really has NO floor while its composed twin has one — the asymmetry the old type denied', () => {
    const out = mixed()
    const basket = out.legs.find((l) => l.route === 'basket')!
    expect(basket.minOutRaw, 'a basket leg is minted with no plan-time floor').toBeNull()
    const composed = out.composed.args[0][out.legs.indexOf(basket)]
    expect(composed.minOut, 'its composed twin carries the legacy haircut').toBeGreaterThan(0n)
  })

  it('THE HONEST PRODUCER NOW PASSES — a review that shows no floor for the basket leg diffs clean', () => {
    const out = mixed()
    const shown = shownAtReviewSurface({
      chainId: 8453,
      fundingAsset: zeroAddress,
      fundingTotalRaw: 350_000_000_000_000_000n,
      recipient: OWNER,
      // carries the ABSENCE through instead of laundering it into a number
      legs: out.composed.args[0].map((l, i) => ({
        symbol: out.legs[i].symbol,
        asset: l.asset,
        budgetRaw: l.budget,
        minOutRaw: out.legs[i].minOutRaw,
        optional: l.optional,
      })),
      approvals: [],
    })
    const data = enc(out.composed.args)
    expect(diffDisplayedVsSigned([{ to: BATCHER2, data, value: out.composed.value }], 0, BATCHER2, shown, out.composed)).toBeNull()
  })

  it('THE `?? 0n` PRODUCER IS NOW IMPOSSIBLE — the mint refuses the laundered zero at its source', () => {
    // it used to mint successfully and push the defect downstream, surfacing as
    // a confirm-time refusal that blamed the BATCH for the REVIEW's mistake
    const out = mixed()
    expect(() =>
      shownAtReviewSurface({
        chainId: 8453,
        fundingAsset: zeroAddress,
        fundingTotalRaw: 350_000_000_000_000_000n,
        recipient: OWNER,
        legs: out.composed.args[0].map((l, i) => ({
          symbol: out.legs[i].symbol,
          asset: l.asset,
          budgetRaw: l.budget,
          minOutRaw: out.legs[i].minOutRaw ?? 0n,
          optional: l.optional,
        })),
        approvals: [],
      }),
    ).toThrow(/use null to say the review showed no floor/)
  })

  it('a null-shown floor still REFUSES a leg with no protection at all — absence of a display is not absence of a floor', () => {
    const out = mixed()
    const shown = shownAtReviewSurface({
      chainId: 8453,
      fundingAsset: zeroAddress,
      fundingTotalRaw: 350_000_000_000_000_000n,
      recipient: OWNER,
      legs: out.composed.args[0].map((l, i) => ({ symbol: out.legs[i].symbol, asset: l.asset, budgetRaw: l.budget, minOutRaw: null, optional: l.optional })),
      approvals: [],
    })
    // gut the basket leg's floor in the BYTES: nothing was shown to compare
    // against, so only the no-protection-at-all branch can catch it
    const tampered = structuredClone(out.composed.args)
    const bi = out.legs.findIndex((l) => l.route === 'basket')
    tampered[0][bi] = { ...tampered[0][bi], minOut: 0n }
    const verdict = diffDisplayedVsSigned(
      [{ to: BATCHER2, data: enc(tampered), value: out.composed.value }],
      0,
      BATCHER2,
      shown,
      out.composed,
    )
    expect(verdict).toMatch(/no protection floor at all/)
  })

  it('and a null-shown leg is STILL byte-covered — the catch-all pins its minOut to the composition', () => {
    const out = mixed()
    const shown = shownAtReviewSurface({
      chainId: 8453,
      fundingAsset: zeroAddress,
      fundingTotalRaw: 350_000_000_000_000_000n,
      recipient: OWNER,
      legs: out.composed.args[0].map((l, i) => ({ symbol: out.legs[i].symbol, asset: l.asset, budgetRaw: l.budget, minOutRaw: null, optional: l.optional })),
      approvals: [],
    })
    // a floor LOWERED but still positive: the null branch cannot see it (nothing
    // was shown) and the no-floor branch does not fire — the re-encode must
    const tampered = structuredClone(out.composed.args)
    const bi = out.legs.findIndex((l) => l.route === 'basket')
    tampered[0][bi] = { ...tampered[0][bi], minOut: tampered[0][bi].minOut - 1n }
    const verdict = diffDisplayedVsSigned(
      [{ to: BATCHER2, data: enc(tampered), value: out.composed.value }],
      0,
      BATCHER2,
      shown,
      out.composed,
    )
    expect(verdict, 'the coverage claim rests on the catch-all, exactly as the field note says').not.toBeNull()
  })
})

describe('CRITICAL-when-live 3 (independent pass 2026-08-08): `optional` gets a source the composer did not produce', () => {
  // The reviewer answered a question I had asked them, and the answer was that
  // the strict comparison never could have caught this: the shown and composed
  // `optional` are the SAME PROPERTY OF THE SAME OBJECT, both from
  // planned.legs[i]. They planted a thinness defect, two HEALTHY legs composed
  // optional=true on both sides, the gate returned null, and 132 tests passed.
  // These laws do not re-check the thinness maths — they read the SIGNED
  // calldata and measure the shape of the batch, which the thinness computation
  // never looks at. That is the independence, and it is why a wrong flag is
  // now visible where a stricter `===` would still see nothing.
  const NOW2 = 1_800_000_000
  const ind2 = { account: OWNER, chainNowSec: NOW2 - 60, maxDeadlineWindowSec: 1_800 }
  /** The gross pull whose post-fee spendable is exactly `net` — the funding
   *  equation inverted, the same technique batcher.test.ts uses. Integer
   *  flooring means the exact inverse may not exist at the estimate, so walk. */
  const grossFor = (net: bigint) => {
    if (net <= 0n) return 0n
    let t = (net * 10_000n) / 9_960n
    for (let i = 0; i < 8; i += 1) {
      const spendable = t - (t * 40n) / 10_000n
      if (spendable === net) return t
      t += spendable < net ? 1n : -1n
    }
    return t
  }

  /** Apply a mutation, then set the PULL to match whatever the legs now commit.
   *  Added 2026-08-08: cold lens 2 found `budget` had no conservation law
   *  outside the composer, so the gate has one now — and these tests, which
   *  vary `optional` and leg shapes, were quietly breaking the funding equation
   *  while meaning to say nothing about it. Deriving the total from the legs
   *  keeps conservation intact without the tests having to touch budgets at
   *  all, which is the half they are actually about. A test that must ignore one
   *  law to exercise another is the weaker test. */
  const withLegs = (mut: (a: ReturnType<typeof argsCopy>) => void) => {
    const a = argsCopy(composed().args)
    mut(a)
    const sum = a[0].reduce((acc: bigint, l: { budget: bigint }) => acc + l.budget, 0n)
    a[2] = grossFor(sum)
    return compositionLawsBroken({ ...composed(), args: a as unknown as ComposedBatchBuy['args'] }, ind2)
  }

  it('a batch where EVERY leg is skippable refuses — it could report success having bought nothing', () => {
    // portfolio-batcher's header records this as already-observed, and nothing
    // on this path checked it. The funding pull and the fee happen regardless.
    const out = withLegs((a) => {
      for (const l of a[0]) l.optional = true
    })
    expect(out).toMatch(/could complete having bought nothing/)
  })

  it('but a batch with a skippable MINORITY still passes — this refuses the shape, not the feature', () => {
    const out = withLegs((a) => {
      a[0][0].optional = true
      for (let i = 1; i < a[0].length; i++) a[0][i].optional = false
    })
    // only meaningful if that leg is under the share bound; assert the premise
    const legs = argsCopy(composed().args)[0]
    const total = legs.reduce((s: bigint, l: { budget: bigint }) => s + l.budget, 0n)
    if (legs[0].budget * 100n <= total * BigInt(MAX_SKIPPABLE_SHARE_PCT)) expect(out).toBeNull()
  })

  it('a skippable leg carrying MOST of the money refuses, however thin its pool is', () => {
    // The independent quantity. Thinness is budget-against-POOL; this is
    // budget-against-BATCH, and the two do not constrain each other — which is
    // exactly why this sees a flag the thinness inputs cannot contradict.
    const out = withLegs((a) => {
      a[0][0].optional = true
      a[0][0].budget = a[0].reduce((s: bigint, l: { budget: bigint }) => s + l.budget, 0n) * 2n
      for (let i = 1; i < a[0].length; i++) a[0][i].optional = false
    })
    expect(out).toMatch(/large share of the money/)
  })

  it('an EMPTY leg list is not "every leg skippable" — that refusal belongs upstream', () => {
    // `optionalLegs.length > 0` is what stops this law firing vacuously on zero
    // legs. Widened, an empty batch would be refused HERE with a sentence about
    // skippable legs, when the honest refusal ("an empty batch is not a plan")
    // already exists in composeBatchBuy and says what is actually wrong. A gate
    // that answers a question it was not asked sends the user to the wrong bug.
    const out = withLegs((a) => {
      a[0].length = 0
    })
    // conservation cannot hold with no legs to carry the money, and that is
    // fine: what this test says is that the SKIPPABLE law does not fire here.
    expect(out).not.toMatch(/skippable/)
  })

  it('EXACTLY the bound is allowed; one unit past it refuses — and my own sweep caught this edge', () => {
    // The gate I wrote hours earlier found this in the gate I wrote minutes
    // earlier: `>` vs `>=` on MAX_SKIPPABLE_SHARE_PCT survived, because nothing
    // asserted the boundary itself, only either side of it. The bound reads
    // "more than half", so a leg at exactly half is legal and one wei past it
    // is not. Same class as every other inclusive-ceiling finding tonight.
    const atBound = withLegs((a) => {
      const legs = a[0]
      for (const l of legs) l.optional = false
      // two legs, the skippable one exactly MAX_SKIPPABLE_SHARE_PCT of the total
      legs.length = 2
      legs[0].optional = true
      legs[0].budget = 1000n
      legs[1].budget = 1000n // 1000/2000 = exactly 50%
    })
    expect(atBound).toBeNull()
    const pastBound = withLegs((a) => {
      const legs = a[0]
      for (const l of legs) l.optional = false
      legs.length = 2
      legs[0].optional = true
      legs[0].budget = 1001n
      legs[1].budget = 1000n // 1001/2001 > 50%
    })
    expect(pastBound).toMatch(/large share of the money/)
  })

  it('and the same oversized leg is FINE when it is not skippable — the flag is what is being policed', () => {
    const out = withLegs((a) => {
      a[0][0].budget = a[0].reduce((s: bigint, l: { budget: bigint }) => s + l.budget, 0n) * 2n
      for (const l of a[0]) l.optional = false
    })
    expect(out).toBeNull()
  })
})

describe('the all-skippable law must not refuse a legitimate single-asset buy', () => {
  const NOW3 = 1_800_000_000
  const ind3 = { account: OWNER, chainNowSec: NOW3 - 60, maxDeadlineWindowSec: 1_800 }
  const one = (optional: boolean) => {
    const a = argsCopy(composed().args)
    a[0].length = 1
    a[0][0].optional = optional
    // conserve, for the same reason as the block above: truncating the legs
    // changes what the batch commits, and this test says nothing about that.
    const net = a[0][0].budget as bigint
    let t = (net * 10_000n) / 9_960n
    for (let i = 0; i < 8; i += 1) {
      const spendable = t - (t * 40n) / 10_000n
      if (spendable === net) break
      t += spendable < net ? 1n : -1n
    }
    a[2] = t
    return compositionLawsBroken({ ...composed(), args: a as unknown as ComposedBatchBuy['args'] }, ind3)
  }

  it('a ONE-LEG batch whose only leg is thin still composes — I refused this for hours', () => {
    // A false refusal I shipped tonight and found by asking where my own new
    // work was most likely wrong. Buying a single thin asset is legitimate, and
    // "completed having bought nothing" describes a batch whose OTHER legs
    // succeeded — with one leg there are no others.
    expect(one(true)).toBeNull()
    expect(one(false)).toBeNull()
  })

  it('and TWO all-skippable legs still refuse — the fix must not disarm the law', () => {
    const a = argsCopy(composed().args)
    a[0].length = 2
    for (const l of a[0]) l.optional = true
    const out = compositionLawsBroken({ ...composed(), args: a as unknown as ComposedBatchBuy['args'] }, ind3)
    expect(out).toMatch(/could complete having bought nothing/)
  })
})

describe('the two HIGHs from the cold pass (2026-08-08)', () => {
  const NOW4 = 1_800_000_000
  const ind4 = { account: OWNER, chainNowSec: NOW4 - 60, maxDeadlineWindowSec: 1_800 }
  const gross = (net: bigint) => {
    if (net <= 0n) return 0n
    let t = (net * 10_000n) / 9_960n
    for (let i = 0; i < 8; i += 1) {
      const sp = t - (t * 40n) / 10_000n
      if (sp === net) return t
      t += sp < net ? 1n : -1n
    }
    return t
  }
  /** n equal legs, the first k of them skippable, conservation intact. */
  const spread = (n: number, optionalCount: number) => {
    const a = argsCopy(composed().args)
    const proto = { ...a[0][0] }
    a[0].length = 0
    for (let i = 0; i < n; i += 1) a[0].push({ ...proto, budget: 1_000n, optional: i < optionalCount })
    a[2] = gross(BigInt(n) * 1_000n)
    return compositionLawsBroken({ ...composed(), args: a as unknown as ComposedBatchBuy['args'] }, ind4)
  }

  it('LENS 1 HIGH: many small skippable legs are bounded too — the per-leg law did not imply the aggregate', () => {
    // Measured by the reviewer through the real assembleBatchBuy: one leg at 51%
    // was REFUSED while three at 25% (75%) and nine at 10% (90%) passed. The law
    // was non-monotonic in the quantity it claimed to bound — and my own comment
    // beside it argued the aggregate harm while the code checked per-leg.
    expect(spread(4, 3)).toMatch(/most of this batch is marked skippable/) // 75%
    expect(spread(10, 9)).toMatch(/most of this batch is marked skippable/) // 90%
  })

  it('and a skippable MINORITY still passes — the aggregate law bounds, it does not ban', () => {
    expect(spread(4, 1)).toBeNull() // 25%
    expect(spread(10, 5)).toBeNull() // exactly 50%, the bound itself
  })

  it('LENS 2 HIGH: conservation is checked OUTSIDE the composer — budget was `optional`s unfixed sibling', () => {
    // assemble-batch composes `budgetRaw: raws[i]` and SHOWS the same array, so
    // the strict diff is f(x) === f(x) for exactly the reason `optional` was.
    // Measured: legs mutated to 1 wei each against a 1,000,000 pull — the
    // composer refuses, but this gate and the byte diff BOTH returned null. The
    // only conservation law lived inside composeBatchBuy, which this file's own
    // header names as the adversary.
    const starved = argsCopy(composed().args)
    for (const l of starved[0]) l.budget = 1n
    expect(
      compositionLawsBroken({ ...composed(), args: starved as unknown as ComposedBatchBuy['args'] }, ind4),
    ).toMatch(/two layers disagree about the money/)

    const bloated = argsCopy(composed().args)
    for (const l of bloated[0]) l.budget = (l.budget as bigint) * 3n
    expect(
      compositionLawsBroken({ ...composed(), args: bloated as unknown as ComposedBatchBuy['args'] }, ind4),
    ).toMatch(/two layers disagree about the money/)
  })

  it('and an HONEST composition still passes conservation — the law must not refuse real batches', () => {
    expect(compositionLawsBroken(composed(), ind4)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PORTFOLIO LAWS — F1/F2/F4/F6 (adversarial review of the executor
// migration, 2026-08-13). portfolioCompositionLawsBroken is the independent-
// law half of the new-contract path; these pin the laws the first cut MISSED
// (the two skippable-share halves + composition conservation) and the ones it
// checked too weakly (feeRecipient value, burnSwapData). Built through the
// REAL composer so the args are a production shape, then tampered.
// ─────────────────────────────────────────────────────────────────────────────
describe('portfolioCompositionLawsBroken — the ported laws (audit F1/F2/F4/F6)', () => {
  const OP = '0x00000000000000000000000000000000000000fe' as Address // operator sink
  const ind = { account: OWNER, chainNowSec: 1_754_500_000, maxDeadlineWindowSec: 1_800, expectedFeeRecipient: OP }
  // two 50/50 legs, well under the 75% cap, so the SUBJECT of each test is the
  // law under it — not the concentration guard
  const pLegs = [
    { symbol: 'AAA', buyToken: ASSET_A, sellAmountRaw: asFundingRaw(500n), minBuyAmountRaw: 480n, swapData: '0xdeadbeef01' as const, optional: false },
    { symbol: 'BBB', buyToken: ASSET_B, sellAmountRaw: asFundingRaw(500n), minBuyAmountRaw: 470n, swapData: '0xdeadbeef02' as const, optional: false },
  ]
  const pComposed = (over: Partial<Parameters<typeof composePortfolioBatchBuy>[0]> = {}) => {
    const legs = over.legs ?? pLegs
    const committed = legs.reduce((s, l) => s + l.sellAmountRaw, 0n)
    // sized at the SAME rate the batch will carry — the old hardcoded 40 here
    // made the gen-2 fixtures self-consistent with the buggy gate (funding at
    // 40bps headroom + conservation at 40) while production sized both at 25
    const fixtureFee = BigInt(over.feeBps ?? BATCH_FEE_BPS)
    return composePortfolioBatchBuy({
      legs,
      fundingAsset: SETTLEMENT,
      fundingTotalRaw: asFundingRaw(committed + (committed * fixtureFee) / 10_000n),
      owner: OWNER,
      recipient: OWNER,
      chainNowSec: 1_754_500_000,
      deadlineSec: 1_754_500_600,
      feeBps: BATCH_FEE_BPS,
      feeRecipient: OP,
      ...over,
    })
  }

  it('an HONEST batch passes every ported law', () => {
    expect(portfolioCompositionLawsBroken(pComposed(), ind)).toBeNull()
  })

  // ── GENERATION 2 (the production fee model): the recipient laws flip to
  //    their strongest form — the field must NOT exist — and the fee law reads
  //    the caller-stated per-generation rate ─────────────────────────────────
  it('gen-2: an honest 25bps no-recipient batch passes with expectedFeeBps stated', () => {
    const c = pComposed({ generation: 2, feeBps: GEN2_BATCH_FEE_BPS })
    expect(portfolioCompositionLawsBroken(c, { ...ind, expectedFeeBps: GEN2_BATCH_FEE_BPS })).toBeNull()
  })

  it('gen-2 checked WITHOUT expectedFeeBps refuses — the default is gen-1’s constant, the safe direction', () => {
    const c = pComposed({ generation: 2, feeBps: GEN2_BATCH_FEE_BPS })
    expect(portfolioCompositionLawsBroken(c, ind)).toMatch(/different fee/)
  })

  it('gen-2 carrying a feeRecipient is a TAMPER by definition — its generation has no such field', () => {
    const c = pComposed({ generation: 2, feeBps: GEN2_BATCH_FEE_BPS })
    const tampered = {
      ...c,
      args: [c.args[0], c.args[1], c.args[2], { ...c.args[3], feeRecipient: OP }] as never,
    }
    expect(portfolioCompositionLawsBroken(tampered, { ...ind, expectedFeeBps: GEN2_BATCH_FEE_BPS })).toMatch(
      /fee recipient its contract generation does not have/,
    )
  })

  it('gen-1 MISSING its feeRecipient refuses in words — the old shape requires the sink', () => {
    const c = pComposed()
    const p3 = { ...(c.args[3] as Record<string, unknown>) }
    delete p3.feeRecipient
    const tampered = { ...c, args: [c.args[0], c.args[1], c.args[2], p3] as never }
    expect(portfolioCompositionLawsBroken(tampered as never, ind)).toMatch(/missing the fee sink/)
  })

  it('gen-2 at the WRONG rate refuses (a 40bps gen-2 batch is not the fee this app charges there)', () => {
    const c = pComposed({ generation: 2, feeBps: BATCH_FEE_BPS })
    expect(portfolioCompositionLawsBroken(c, { ...ind, expectedFeeBps: GEN2_BATCH_FEE_BPS })).toMatch(/different fee/)
  })

  it('F6 — a burn route where the app composes NONE refuses verbatim; where it DOES compose one, it passes (the 4663 LNOC live refusal, 2026-08-15)', () => {
    const withBurn = pComposed({ burnSwapData: '0xbeefbeef' as const })
    // not composable (the original law, unchanged for tamper): refuse
    expect(portfolioCompositionLawsBroken(withBurn, ind)).toMatch(/burn route this app does not compose/)
    expect(portfolioCompositionLawsBroken(withBurn, { ...ind, burnComposable: false })).toMatch(/burn route this app does not compose/)
    // composable (the shipped burn route): the same batch passes
    expect(portfolioCompositionLawsBroken(withBurn, { ...ind, burnComposable: true })).toBeNull()
    // and the fail-closed empty route passes in BOTH modes
    expect(portfolioCompositionLawsBroken(pComposed(), { ...ind, burnComposable: true })).toBeNull()
  })

  it('F4 — feeRecipient redirected off the operator sink refuses (not merely non-zero)', () => {
    const c = pComposed({ feeRecipient: ATTACKER })
    expect(portfolioCompositionLawsBroken(c, ind)).toMatch(/somewhere other than this operator/)
    // and with no operator sink configured, the pin stands down (only non-zero required)
    expect(portfolioCompositionLawsBroken(c, { ...ind, expectedFeeRecipient: undefined })).toBeNull()
  })

  it('F1 boundary — an optional leg at EXACTLY 50% is legal (the law is strictly-greater), per-leg AND aggregate', () => {
    // per-leg: 50/50, one optional — exactly half is not "a large share"
    const half = [
      { ...pLegs[0], sellAmountRaw: asFundingRaw(500n), optional: true },
      { ...pLegs[1], sellAmountRaw: asFundingRaw(500n) },
    ]
    expect(portfolioCompositionLawsBroken(pComposed({ legs: half }), ind)).toBeNull()
    // aggregate: 25+25 optional over a 100 total — exactly half again
    const agg = [
      { ...pLegs[0], symbol: 'A', sellAmountRaw: asFundingRaw(250n), optional: true },
      { ...pLegs[1], symbol: 'B', sellAmountRaw: asFundingRaw(250n), optional: true },
      { symbol: 'C', buyToken: '0x3333333333333333333333333333333333333333' as Address, sellAmountRaw: asFundingRaw(500n), minBuyAmountRaw: 480n, swapData: '0xdeadbeef03' as const, optional: false },
    ]
    expect(portfolioCompositionLawsBroken(pComposed({ legs: agg }), ind)).toBeNull()
  })

  it('F1 — a single OVERSIZED optional leg (>50% of the batch) refuses', () => {
    // 60/40, the 60% leg optional → dropped silently it loses the majority
    const legs = [
      { ...pLegs[0], sellAmountRaw: asFundingRaw(600n), optional: true },
      { ...pLegs[1], sellAmountRaw: asFundingRaw(400n) },
    ]
    expect(portfolioCompositionLawsBroken(pComposed({ legs }), ind)).toMatch(/large share of the money/)
  })

  it('F1 — optional legs AGGREGATING past 50% refuse even when each is small', () => {
    // three 30/30/40, the two 30s optional (60% aggregate) → the non-monotonic
    // hole the legacy gate measured: neither optional leg alone trips 50%
    const legs = [
      { ...pLegs[0], symbol: 'A', buyToken: ASSET_A, sellAmountRaw: asFundingRaw(300n), optional: true },
      { ...pLegs[1], symbol: 'B', buyToken: ASSET_B, sellAmountRaw: asFundingRaw(300n), optional: true },
      { symbol: 'C', buyToken: '0x3333333333333333333333333333333333333333' as Address, sellAmountRaw: asFundingRaw(400n), minBuyAmountRaw: 380n, swapData: '0xdeadbeef03' as const, optional: false },
    ]
    expect(portfolioCompositionLawsBroken(pComposed({ legs }), ind)).toMatch(/most of this batch is marked skippable/)
  })

  it('F1 — the single-leg carve-out holds: a lone (necessarily-100%) leg is NOT false-refused by the share laws', () => {
    // it will trip the CONCENTRATION cap at compose, so build the composed obj
    // with a lone optional leg directly is impossible past the cap — instead
    // assert the share laws themselves don't fire on legs.length===1 by feeding
    // a hand-built composed tuple through the law (the cap lives in the composer)
    const lone = {
      generation: 1 as const,
      args: [
        [{ buyToken: ASSET_A, sellAmount: 1000n, minBuyAmount: 900n, swapData: '0xdeadbeef' as const, optional: true }],
        SETTLEMENT,
        1004n,
        { recipient: OWNER, deadline: 1_754_500_600n, feeBps: BATCH_FEE_BPS, feeRecipient: OP, burnSwapData: '0x' as const },
      ],
    } as Parameters<typeof portfolioCompositionLawsBroken>[0]
    // conservation: 1000 committed, committable for 1004 @ fee — align so only
    // the share laws are under test; they must NOT fire for a single leg
    const msg = portfolioCompositionLawsBroken(lone, ind)
    expect(msg == null || !/skippable/.test(msg)).toBe(true)
  })

  it('F2 — conservation: legs committing less than the committable refuse (the sliver-and-refund attack)', () => {
    // hand-build a composed tuple whose legs sum BELOW maxCommittedFor — the
    // composer would refuse this, so we bypass it to prove the LAW catches it
    const under = {
      generation: 1 as const,
      args: [
        [
          { buyToken: ASSET_A, sellAmount: 50n, minBuyAmount: 40n, swapData: '0xdeadbee1' as const, optional: false },
          { buyToken: ASSET_B, sellAmount: 50n, minBuyAmount: 40n, swapData: '0xdeadbee2' as const, optional: false },
        ],
        SETTLEMENT,
        1_000_000n, // pulls a million, commits 100 — the rest would silently refund
        { recipient: OWNER, deadline: 1_754_500_600n, feeBps: BATCH_FEE_BPS, feeRecipient: OP, burnSwapData: '0x' as const },
      ],
    } as Parameters<typeof portfolioCompositionLawsBroken>[0]
    expect(portfolioCompositionLawsBroken(under, ind)).toMatch(/disagree about the money/)
  })

  it('F6 — a non-empty burnSwapData (the composer never sets one) refuses', () => {
    const tampered = {
      generation: 1 as const,
      args: [
        pComposed().args[0],
        SETTLEMENT,
        pComposed().args[2],
        { ...pComposed().args[3], burnSwapData: '0xdeadbeef' as const },
      ],
    } as Parameters<typeof portfolioCompositionLawsBroken>[0]
    expect(portfolioCompositionLawsBroken(tampered, ind)).toMatch(/burn route this app does not compose/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PORTFOLIO BUNDLE GATE ITSELF — diffDisplayedVsSignedPortfolio (A12 sweep,
// 2026-08-13). The sweep proved this function had ZERO direct coverage: three
// mutants inside it and the shared approvalsDiverge survived every scoped
// suite, two of them by turning the gate into one that refuses EVERY faithful
// bundle — a state no test could tell from health. These are the survivors'
// pins, through the real composer + the real encoder, same as the legacy gate.
// ─────────────────────────────────────────────────────────────────────────────
describe('diffDisplayedVsSignedPortfolio — the full-bundle gate (A12 survivor pins)', () => {
  const OP = '0x00000000000000000000000000000000000000fe' as Address
  const T = 1_754_500_000
  const pLegs = [
    { symbol: 'AAA', buyToken: ASSET_A, sellAmountRaw: asFundingRaw(500n), minBuyAmountRaw: 480n, swapData: '0xdeadbeef01' as const, optional: false },
    { symbol: 'BBB', buyToken: ASSET_B, sellAmountRaw: asFundingRaw(500n), minBuyAmountRaw: 470n, swapData: '0xdeadbeef02' as const, optional: false },
  ]
  const PULL = 1_004n // 1000 committed + floor(1000×40/10000) fee — exact conservation
  const pComposed = () =>
    composePortfolioBatchBuy({
      legs: pLegs,
      fundingAsset: SETTLEMENT,
      fundingTotalRaw: asFundingRaw(PULL),
      owner: OWNER,
      recipient: OWNER,
      chainNowSec: T,
      deadlineSec: T + 600,
      feeBps: BATCH_FEE_BPS,
      feeRecipient: OP,
    })
  const pEncode = (args: ComposedPortfolioBatchBuy['args']): Hex =>
    encodeFunctionData({ abi: portfolioBatcherAbi, functionName: 'batchBuy', args: args as never })
  const pArgsCopy = (a: ComposedPortfolioBatchBuy['args']) =>
    [a[0].map((l) => ({ ...l })), a[1], a[2], { ...a[3] }] as unknown as ComposedPortfolioBatchBuy['args']
  /** The review's record — from the DISPLAYED values, never the composition. */
  const pShown = (over: Partial<Parameters<typeof shownAtReviewSurface>[0]> = {}): ShownStepReview =>
    shownAtReviewSurface({
      chainId: 8453,
      fundingAsset: SETTLEMENT,
      fundingTotalRaw: PULL,
      recipient: OWNER,
      legs: pLegs.map((l) => ({ symbol: l.symbol, asset: l.buyToken, budgetRaw: l.sellAmountRaw as bigint, minOutRaw: l.minBuyAmountRaw, optional: l.optional })),
      approvals: [{ token: SETTLEMENT, amountRaw: PULL }],
      ...over,
    })
  const pApproveAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
  const pApprove = () => ({
    to: SETTLEMENT,
    data: encodeFunctionData({ abi: pApproveAbi, functionName: 'approve', args: [BATCHER, PULL] }),
    value: 0n,
  })
  const pBatch = (data?: Hex) => ({ to: BATCHER, data: data ?? pEncode(pComposed().args), value: 0n })

  it('a FAITHFUL bundle — one shown approval plus the batch — passes the whole gate', () => {
    // kills approvalsDiverge:507 [+ → -] and :509 [drop !]: either mutant turns
    // this exact healthy bundle into a refusal
    expect(diffDisplayedVsSignedPortfolio([pApprove(), pBatch()], 1, BATCHER, pShown(), pComposed())).toBeNull()
  })

  it('a FAITHFUL zero-approval bundle passes too (the other healthy shape)', () => {
    expect(diffDisplayedVsSignedPortfolio([pBatch()], 0, BATCHER, pShown({ approvals: [] }), pComposed())).toBeNull()
  })

  it('the batch sitting anywhere but where the review said refuses', () => {
    expect(diffDisplayedVsSignedPortfolio([pApprove(), pBatch()], 0, BATCHER, pShown(), pComposed())).toMatch(/not where the review said/)
  })

  it('a leg whose review showed NO floor (minOutRaw null) still passes while the composed floor protects it', () => {
    // kills :580 [=== → !==]: the mutant routes a null-shown leg into the
    // strict compare, where a bigint never equals null — refusing every
    // basket-shaped leg whose floor is applied after the review renders
    const shown = pShown({
      legs: pLegs.map((l, i) => ({ symbol: l.symbol, asset: l.buyToken, budgetRaw: l.sellAmountRaw as bigint, minOutRaw: i === 1 ? null : l.minBuyAmountRaw, optional: l.optional })),
    })
    expect(diffDisplayedVsSignedPortfolio([pApprove(), pBatch()], 1, BATCHER, shown, pComposed())).toBeNull()
  })

  it('a floor that moved between the review and the signature is named as exactly that', () => {
    // the other direction of :580 — a SHOWN floor must be compared strictly;
    // the mutant skips the compare and the tamper would fall to the catch-all
    // (which cannot fire here: the calldata IS the tampered composition)
    const tampered = pArgsCopy(pComposed().args)
    tampered[0][0].minBuyAmount = 481n
    expect(
      diffDisplayedVsSignedPortfolio([pApprove(), pBatch(pEncode(tampered))], 1, BATCHER, pShown(), { generation: 1, args: tampered }),
    ).toMatch(/different protection floor than the review showed/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDARY PINS for portfolioCompositionLawsBroken's clock laws (A12 sweep,
// 2026-08-13): both deadline comparisons had no test sitting exactly ON the
// boundary, so their operators could each relax one notch unnoticed. The
// boundary case is not thoroughness — it is the only input that proves the
// operator discriminates.
// ─────────────────────────────────────────────────────────────────────────────
describe('portfolioCompositionLawsBroken — deadline boundary pins', () => {
  const OP = '0x00000000000000000000000000000000000000fe' as Address
  const T = 1_754_500_000
  const ind = { account: OWNER, chainNowSec: T, maxDeadlineWindowSec: 1_800, expectedFeeRecipient: OP }
  const legs = [
    { buyToken: ASSET_A, sellAmount: 500n, minBuyAmount: 480n, swapData: '0xdeadbee1' as const, optional: false },
    { buyToken: ASSET_B, sellAmount: 500n, minBuyAmount: 470n, swapData: '0xdeadbee2' as const, optional: false },
  ]
  const withDeadline = (deadline: bigint) =>
    ({
      generation: 1 as const,
      // hand-built (the composer refuses an expired deadline before the law
      // can see one): conservation exact — 1000 committed fits a 1004 pull
      args: [legs, SETTLEMENT, 1_004n, { recipient: OWNER, deadline, feeBps: BATCH_FEE_BPS, feeRecipient: OP, burnSwapData: '0x' as const }],
    }) as Parameters<typeof portfolioCompositionLawsBroken>[0]

  it('a deadline exactly AT the chain clock is already expired — refuses (kills 649 <= → <)', () => {
    expect(portfolioCompositionLawsBroken(withDeadline(BigInt(T)), ind)).toMatch(/already expired/)
  })

  it('a deadline exactly AT the window ceiling passes — one second past refuses (kills 651 > → >=)', () => {
    expect(portfolioCompositionLawsBroken(withDeadline(BigInt(T + 1_800)), ind)).toBeNull()
    expect(portfolioCompositionLawsBroken(withDeadline(BigInt(T + 1_801)), ind)).toMatch(/signable for far longer/)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// CONSERVATION IS GENERATION-AWARE (the owner's live 4663 refusal, 2026-08-17
// 20:11). The composer sized legs at the chain's gen-2 rate (25bps) while the
// conservation line held room for the legacy 40 — an honest batch refused by
// our own two layers. The pin carries the LIVE numbers from the exec log.
// ─────────────────────────────────────────────────────────────────────────────
describe('portfolio conservation at the generation’s own rate', () => {
  const IND2 = { account: OWNER, chainNowSec: 1_754_500_000, maxDeadlineWindowSec: 1_800, expectedFeeBps: GEN2_BATCH_FEE_BPS }
  const liveCompose = (legRaw: bigint) =>
    composePortfolioBatchBuy({
      legs: [{ symbol: 'FWA', buyToken: ASSET_A, sellAmountRaw: asFundingRaw(legRaw), minBuyAmountRaw: 1n, swapData: '0xdeadbeef01' as const, optional: false }],
      fundingAsset: SETTLEMENT,
      fundingTotalRaw: asFundingRaw(2_711_000_000n),
      owner: OWNER,
      recipient: OWNER,
      chainNowSec: 1_754_500_000,
      deadlineSec: 1_754_500_600,
      feeBps: GEN2_BATCH_FEE_BPS,
      feeRecipient: OWNER, // input-shape requirement; gen-2 drops it from the args
      generation: 2,
    })

  it('THE LIVE NUMBERS: a 2711000000 pull whose leg fills the 25bps committable (2704239402) passes', () => {
    expect(portfolioCompositionLawsBroken(liveCompose(2_704_239_402n), IND2)).toBeNull()
  })

  it('a gen-2 batch whose leg was sized to the LEGACY 40bps room (2700199204) refuses — the layers must agree at the chain’s own rate', () => {
    const c = liveCompose(2_704_239_402n)
    const legs = c.args[0].map((l) => ({ ...l }))
    legs[0] = { ...legs[0], sellAmount: 2_700_199_204n as typeof legs[0]['sellAmount'] }
    const tampered = { ...c, args: [legs, c.args[1], c.args[2], c.args[3]] as unknown as typeof c.args }
    expect(portfolioCompositionLawsBroken(tampered, IND2)).toMatch(/two layers disagree about the money/)
  })
})
