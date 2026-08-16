import { decodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { BatchComposeRefusal } from './batcher'

// ─────────────────────────────────────────────────────────────────────────────
// SPECTRUM REBALANCE BATCHER — the DARK encoder (the owner greenlit the contract;
// SpectrumContracts' desk item w-…-41, 2026-08-15: "build against the STABLE
// interface now (don't wire live yet)"). ONE atomic tx per chain: sells fund
// buys internally; only the residual returns as cash.
//
// Interface source of truth: spectrum-contracts
// docs/REBALANCE-BATCHER-FE-INTEGRATION-2026-08-15.md (branch
// feature/rebalance-batcher). The law text this module implements — R1–R7 —
// lives in the ops repo workspace/spectrum-release/
// rebalance-batcher-law-text-2026-08-15.md, sent to SpectrumContracts for
// contract-side verification (the P6′ pattern).
//
// ⚠ DELIBERATELY OUTSIDE THE MONEY-CORE DIGEST SET, whole. The contract is
// undeployed and NOTHING here is reachable from a live path (no runner
// branch, no wiring import) — folding the R1 gate into displayed-vs-signed
// or the runner now would move the candidate digest under the reviewer
// mid-review for code that cannot execute. The fold-in lands WITH the
// contract's own seating + review ceremony, as its own digest event.
//
// ⚠ THE INTERFACE MAY STILL SHIFT at their review ceremony (their guide's
// closing warning). Build-to, expect confirm-or-amend.
// ─────────────────────────────────────────────────────────────────────────────

export const rebalanceBatcherAbi = parseAbi([
  'struct SellLeg { address token; uint256 sellAmount; uint256 minFundingOut; bytes swapData; bool optional; }',
  'struct BuyLeg { address buyToken; uint256 fundingBudget; uint256 minBuyAmount; bytes swapData; bool optional; }',
  'struct RebalanceParams { address recipient; uint256 deadline; uint16 feeBps; address feeRecipient; bytes burnSwapData; }',
  'function rebalance(SellLeg[] sells, BuyLeg[] buys, address fundingAsset, RebalanceParams p) returns (uint256[] sold, uint256[] bought, uint256 refunded)',
])

/** The contract's own leg ceiling and fee ceiling ride the shared constants:
 *  feeBps ≤ 200 per the guide — enforced here as the app's own compose law
 *  (R1: p.feeBps === the app constant, checked by the caller against theirs). */
export const REBALANCE_MAX_FEE_BPS = 200

export interface RebalanceSellLegInput {
  token: Address
  /** EXACT raw amount sold — the composer's own size, never USD-derived. */
  sellAmountRaw: bigint
  /** R4: the floor on funding RECEIVED (quote minus stated tolerance). The
   *  contract floors on its measured balance delta; zero never means
   *  "no floor" — a zero floor refuses at compose. */
  minFundingOutRaw: bigint
  /** The 0x allowance-holder quote's swapData, token → fundingAsset,
   *  taker = the batcher (the buy encoder MIRRORED — the guide's words). */
  swapData: Hex
  optional: boolean
}

export interface RebalanceBuyLegInput {
  buyToken: Address
  fundingBudgetRaw: bigint
  minBuyAmountRaw: bigint
  swapData: Hex
  optional: boolean
}

export interface ComposedRebalanceBatch {
  kind: 'rebalance-batch'
  chainId: number
  args: readonly [
    readonly { token: Address; sellAmount: bigint; minFundingOut: bigint; swapData: Hex; optional: boolean }[],
    readonly { buyToken: Address; fundingBudget: bigint; minBuyAmount: bigint; swapData: Hex; optional: boolean }[],
    Address,
    { recipient: Address; deadline: bigint; feeBps: number; feeRecipient: Address; burnSwapData: Hex },
  ]
  /** R2b: the preview fee — an ESTIMATE (realized fee floors on measured
   *  values); shown with the realized rule stated in words. */
  previewFeeRaw: bigint
}

/** R2b's arithmetic, exported bare for the preview surface: the fee estimates
 *  as feeBps of the LARGER side — every dollar that moves, taxed once; a dust
 *  buy cannot shrink the sell side's fee. */
export function rebalanceFeePreviewRaw(quotedSellProceedsRaw: readonly bigint[], buyBudgetsRaw: readonly bigint[], feeBps: number): bigint {
  const sells = quotedSellProceedsRaw.reduce((s, x) => s + x, 0n)
  const buys = buyBudgetsRaw.reduce((s, x) => s + x, 0n)
  const base = sells > buys ? sells : buys
  return (base * BigInt(feeBps)) / 10_000n
}

/**
 * Compose the atomic rebalance — every R-law that is checkable at compose
 * time, refused in words (BatchComposeRefusal, the shared review-grade class).
 */
export function composeRebalanceBatch(input: {
  chainId: number
  sells: readonly RebalanceSellLegInput[]
  buys: readonly RebalanceBuyLegInput[]
  fundingAsset: Address
  /** The quoted proceeds per sell (display/preview basis — R2b). */
  quotedSellProceedsRaw: readonly bigint[]
  recipient: Address
  chainNowSec: number
  deadlineSec: number
  feeBps: number
  feeRecipient: Address
  burnSwapData?: Hex
}): ComposedRebalanceBatch {
  const refuse = (why: string): never => {
    throw new BatchComposeRefusal(why)
  }
  const { sells, buys, fundingAsset } = input
  // R7: the entry point is chosen exactly when a sell leg exists — a pure buy
  // belongs to batchBuy (fee-identical by the contract's own rule).
  if (sells.length === 0) refuse('this intent carries no on-chain sells — pure buys encode batchBuy, never the rebalance entry point')
  if (sells.length !== input.quotedSellProceedsRaw.length) refuse('every sell leg needs its quoted proceeds for the fee preview — the two lists diverge')
  if (input.feeBps < 0 || !Number.isInteger(input.feeBps) || input.feeBps > REBALANCE_MAX_FEE_BPS)
    refuse(`the fee (${input.feeBps} bps) is outside the contract's ceiling (${REBALANCE_MAX_FEE_BPS})`)
  if (!(input.deadlineSec > input.chainNowSec)) refuse('the signing window has already passed on the chain clock')
  const fa = fundingAsset.toLowerCase()
  for (const [i, s] of sells.entries()) {
    // R6: cash is never a leg
    if (s.token.toLowerCase() === fa) refuse(`sell leg ${i + 1} sells the funding asset itself — a cash trim is funding, never a sale`)
    if (s.sellAmountRaw <= 0n) refuse(`sell leg ${i + 1} carries no readable amount`)
    // R4: zero never means "no floor"
    if (s.minFundingOutRaw <= 0n) refuse(`sell leg ${i + 1} has no floor on what it must yield — zero is not a floor`)
    if (s.swapData === '0x') refuse(`sell leg ${i + 1} carries no route`)
  }
  for (const [j, b] of buys.entries()) {
    if (b.buyToken.toLowerCase() === fa) refuse(`buy leg ${j + 1} buys the funding asset itself — remove that leg`)
    if (b.fundingBudgetRaw <= 0n) refuse(`buy leg ${j + 1} carries no readable budget`)
    if (b.minBuyAmountRaw <= 0n) refuse(`buy leg ${j + 1} has no floor — zero is not a floor`)
    if (b.swapData === '0x') refuse(`buy leg ${j + 1} carries no route`)
  }
  // R5's compose-time half: with NO external pull, required buys must fit the
  // pot the sells' own FLOORS guarantee (the honest lower bound). Optional
  // buys may reach past it — they skip at execution if the pot runs dry.
  const floorPot = sells.reduce((s, x) => s + x.minFundingOutRaw, 0n)
  const requiredBuys = buys.filter((b) => !b.optional).reduce((s, b) => s + b.fundingBudgetRaw, 0n)
  if (requiredBuys > floorPot)
    refuse(
      `the required buys need more funding than the sells' floors guarantee — a thin sell could strand a required buy on-chain; mark buys skippable, trim them, or sell more`,
    )
  return {
    kind: 'rebalance-batch',
    chainId: input.chainId,
    args: [
      sells.map((s) => ({ token: s.token, sellAmount: s.sellAmountRaw, minFundingOut: s.minFundingOutRaw, swapData: s.swapData, optional: s.optional })),
      buys.map((b) => ({ buyToken: b.buyToken, fundingBudget: b.fundingBudgetRaw, minBuyAmount: b.minBuyAmountRaw, swapData: b.swapData, optional: b.optional })),
      fundingAsset,
      {
        recipient: input.recipient,
        deadline: BigInt(input.deadlineSec),
        feeBps: input.feeBps,
        feeRecipient: input.feeRecipient,
        burnSwapData: input.burnSwapData ?? '0x',
      },
    ],
    previewFeeRaw: rebalanceFeePreviewRaw(input.quotedSellProceedsRaw, buys.map((b) => b.fundingBudgetRaw), input.feeBps),
  }
}

// ── R1: shown-is-signed, both leg sets ──────────────────────────────────────

export interface ShownRebalance {
  chainId: number
  fundingAsset: Address
  recipient: Address
  sells: readonly { token: Address; sellAmountRaw: bigint; minFundingOutRaw: bigint; optional: boolean }[]
  buys: readonly { buyToken: Address; fundingBudgetRaw: bigint; minBuyAmountRaw: bigint; optional: boolean }[]
  feeBps: number
}

/** Decode the calldata about to be signed and diff it against what the review
 *  RENDERED — both leg sets, byte-equal amounts and floors, same flags. Every
 *  divergence is named; empty = faithful. (Today's P8 gate, grown a second
 *  leg set — kept HERE, outside displayed-vs-signed.ts, until the contract's
 *  own seating ceremony folds it in as its own digest event.) */
export function diffDisplayedVsSignedRebalance(shown: ShownRebalance, calldata: Hex): string[] {
  const out: string[] = []
  let decoded: { functionName: string; args: readonly unknown[] }
  try {
    decoded = decodeFunctionData({ abi: rebalanceBatcherAbi, data: calldata })
  } catch {
    return ['the signed bytes do not decode as a rebalance call at all']
  }
  if (decoded.functionName !== 'rebalance') return [`the signed bytes call ${decoded.functionName}, not rebalance`]
  const [sells, buys, fundingAsset, p] = decoded.args as unknown as [
    readonly { token: Address; sellAmount: bigint; minFundingOut: bigint; optional: boolean }[],
    readonly { buyToken: Address; fundingBudget: bigint; minBuyAmount: bigint; optional: boolean }[],
    Address,
    { recipient: Address; deadline: bigint; feeBps: number },
  ]
  if (fundingAsset.toLowerCase() !== shown.fundingAsset.toLowerCase()) out.push('the funding asset differs from the one shown')
  if (p.recipient.toLowerCase() !== shown.recipient.toLowerCase()) out.push('the recipient differs from the account shown')
  if (Number(p.feeBps) !== shown.feeBps) out.push(`the fee differs from the one shown (${Number(p.feeBps)} vs ${shown.feeBps} bps)`)
  if (sells.length !== shown.sells.length) out.push(`the signed call carries ${sells.length} sell legs where the review showed ${shown.sells.length}`)
  else
    for (const [i, s] of sells.entries()) {
      const sh = shown.sells[i]
      if (s.token.toLowerCase() !== sh.token.toLowerCase()) out.push(`sell leg ${i + 1} sells a different token than shown`)
      if (s.sellAmount !== sh.sellAmountRaw) out.push(`sell leg ${i + 1}'s amount differs from the one shown`)
      if (s.minFundingOut !== sh.minFundingOutRaw) out.push(`sell leg ${i + 1}'s floor differs from the one shown`)
      if (s.optional !== sh.optional) out.push(`sell leg ${i + 1}'s skippability differs from the one shown`)
    }
  if (buys.length !== shown.buys.length) out.push(`the signed call carries ${buys.length} buy legs where the review showed ${shown.buys.length}`)
  else
    for (const [j, b] of buys.entries()) {
      const sh = shown.buys[j]
      if (b.buyToken.toLowerCase() !== sh.buyToken.toLowerCase()) out.push(`buy leg ${j + 1} buys a different token than shown`)
      if (b.fundingBudget !== sh.fundingBudgetRaw) out.push(`buy leg ${j + 1}'s budget differs from the one shown`)
      if (b.minBuyAmount !== sh.minBuyAmountRaw) out.push(`buy leg ${j + 1}'s floor differs from the one shown`)
      if (b.optional !== sh.optional) out.push(`buy leg ${j + 1}'s skippability differs from the one shown`)
    }
  return out
}

// ── R3: conservation, EXACT — asserted on preview and on the decoded return ─

export function rebalanceConservationErrors(input: {
  composed: ComposedRebalanceBatch
  sold: readonly bigint[]
  bought: readonly bigint[]
  refunded: bigint
  /** External top-up pulled from the user; 0 in a pure rebalance. The app
   *  carries this from its own approval intent — SpectrumContracts' law
   *  answer (2): X is NOT observable in the contract's return. */
  externalPullRaw?: bigint
}): string[] {
  const out: string[] = []
  const [sells, buys, , p] = input.composed.args
  if (input.sold.length !== sells.length) return [`the result reports ${input.sold.length} sells for ${sells.length} legs — unreadable, refuse whole`]
  if (input.bought.length !== buys.length) return [`the result reports ${input.bought.length} buys for ${buys.length} legs — unreadable, refuse whole`]
  const X = input.externalPullRaw ?? 0n
  let proceeds = 0n
  for (const [i, s] of sells.entries()) {
    const got = input.sold[i]
    if (got === 0n) {
      if (!s.optional) out.push(`required sell ${i + 1} was skipped — the contract must have reverted; this result is not trustable`)
      continue
    }
    if (got < s.minFundingOut) out.push(`sell ${i + 1} yielded under its floor — the contract should have reverted; refusing this result`)
    proceeds += got
  }
  let budgetCeiling = 0n
  for (const [j, b] of buys.entries()) {
    const got = input.bought[j]
    if (got === 0n) {
      if (!b.optional) out.push(`required buy ${j + 1} was skipped — the contract must have reverted; this result is not trustable`)
      continue
    }
    if (got < b.minBuyAmount) out.push(`buy ${j + 1} delivered under its floor — the contract should have reverted; refusing this result`)
    budgetCeiling += b.fundingBudget
  }
  // ── THE MEASURED-SPEND SOLVE (SpectrumContracts MED-2, 2026-08-15): the
  // contract's feeBase uses MEASURED buy spend (totalUsed), which the return
  // (sold[], bought[], refunded) never exposes — assuming Σ fundingBudget
  // false-refused every legitimate underspend. But conservation itself pins
  // the unknown: with proceeds P, pull X and refund R all measured,
  //   P + X = U + floor(feeBps × max(P, U) / 10000) + R
  // has at most one consistent U per branch (fee is monotonic in U), so R3
  // SOLVES for U and stays EXACT — their answer (3) confirms the fee-floor
  // dust rides `refunded`, so no dust term is needed. ──
  const fee = BigInt(p.feeBps)
  const inflow = proceeds + X
  let usedTotal: bigint | null = null
  // Case A — U ≤ P: the fee bases on the sells side.
  {
    const feeA = (proceeds * fee) / 10_000n
    const u = inflow - feeA - input.refunded
    if (u >= 0n && u <= proceeds) usedTotal = u
  }
  // Case B — U > P: the fee bases on the buys side; walk the integer edge
  // exactly as maxCommittedFor does.
  if (usedTotal == null) {
    const rhs = inflow - input.refunded
    if (rhs > 0n) {
      let u = (rhs * 10_000n) / (10_000n + fee)
      while (u + (u * fee) / 10_000n > rhs) u -= 1n
      while (u + 1n + ((u + 1n) * fee) / 10_000n <= rhs) u += 1n
      if (u > proceeds && u + (u * fee) / 10_000n === rhs) usedTotal = u
    }
  }
  if (usedTotal == null) {
    out.push(
      `conservation broke: no measured spend satisfies proceeds ${proceeds} + pull ${X} = used + fee + refunded ${input.refunded} — refuse and surface`,
    )
    return out
  }
  // the solved spend must fit what was signed: never beyond the executed
  // buys' budgets (the contract's own BuyExceedsPot/overspend laws)
  if (usedTotal > budgetCeiling)
    out.push(`the solved buy spend ${usedTotal} exceeds the executed legs' budgets ${budgetCeiling} — the pot law is broken`)
  return out
}
