// ─────────────────────────────────────────────────────────────────────────────
// FAIR-MINT PLANNER — the kit-side answer to the drift haircut (owner ruling
// 2026-08-02: "can we fix this to always provide an accurate non slipped
// outcome?"). Deployed baskets are immutable, so the ROUTER's buy path keeps
// splitting by original target weights forever — on a drifted basket the mint
// min-rule then keys on the worst leg and eats a CONSTANT slice of every buy
// (LPADS, measured live: −28% flat from $10 to $1,000).
//
// The escape hatch is already on-chain: mintInKind prices shares against
// CURRENT holdings (min over net_i × supply / held_i, SpectrumBasket.sol:764).
// Deposit legs exactly pro-rata to what the basket holds NOW and every leg
// binds equally — fair mint at NAV, minus only the basket fee and the real
// cost of acquiring the legs. This module is the PURE planner for that route:
// React-free, no I/O (the shared-core law) — callers feed live reads in.
//
// Honesty rules:
//  · every leg needs a live price and a positive holding; a basket with an
//    unreadable or drained leg is NOT plannable — refuse, never guess.
//  · shares are predicted with the contract's own math (fee rounds UP per
//    leg, share = mulDiv-down, min across legs) so minShares derived from the
//    prediction can only be pessimistic by the haircut the caller chooses.
//  · a live price is not necessarily a USABLE price: a mark can be absurd
//    against what the leg was funded with (contracts measured 509,250x) and
//    this planner would faithfully split by it. The EXECUTION half must run
//    the split guard over the same legs before signing (split-guard.ts, and
//    caller-split.ts composes the whole handshake) — planning is arithmetic,
//    guarding is a separate layer.
// ─────────────────────────────────────────────────────────────────────────────

export interface FairMintLeg {
  /** Leg asset address (basket order — amounts[] is positional). */
  address: string
  decimals: number
  /** The basket's CURRENT holding of this leg, raw units (idleHeld). */
  heldRaw: bigint
  /** Live unit price in settlement dollars (e.g. USDG) — display precision. */
  priceUsd: number
}

export interface FairMintPlan {
  /** Raw leg amounts to acquire + deposit, basket order (mintInKind input). */
  amountsRaw: bigint[]
  /** Settlement dollars to spend on each leg (the acquisition targets). */
  legBudgetsUsd: number[]
  /** Shares mintInKind would issue for exactly amountsRaw (contract math). */
  expectedSharesRaw: bigint
  /** Share of budget lost to the min-rule if deposits land as planned: 0 by
   *  construction up to integer rounding — exposed so tests can pin it. */
  roundingLossPct: number
}

const BPS = 10_000n

/** mulDiv floor with bigint (a*b/d). */
const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d
const mulDivUp = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d

/**
 * Split `budgetUsd` across legs pro-rata to CURRENT holding VALUE, convert to
 * raw leg amounts at live prices, and predict the mintInKind outcome with the
 * contract's own rounding (fee up, shares down, min across legs).
 * Returns null when the basket is not fairly plannable (any leg unpriced,
 * drained, or the budget rounds a leg to zero — a zero leg drives the no-skip
 * min-rule to zero shares and the whole mint reverts).
 */
export function planFairMint(
  legs: FairMintLeg[],
  budgetUsd: number,
  supplyRaw: bigint,
  basketFeeBps: number,
): FairMintPlan | null {
  if (legs.length === 0 || !(budgetUsd > 0) || supplyRaw <= 0n) return null
  if (legs.some((l) => l.heldRaw <= 0n || !(l.priceUsd > 0) || !Number.isFinite(l.priceUsd))) return null

  // Current value of each holding — the pro-rata basis.
  const heldUsd = legs.map((l) => Number(l.heldRaw) / 10 ** l.decimals * l.priceUsd)
  const totalUsd = heldUsd.reduce((s, v) => s + v, 0)
  if (!(totalUsd > 0)) return null

  const legBudgetsUsd = heldUsd.map((v) => (v / totalUsd) * budgetUsd)
  const amountsRaw = legs.map((l, i) => {
    const units = legBudgetsUsd[i] / l.priceUsd
    return BigInt(Math.floor(units * 10 ** l.decimals))
  })
  if (amountsRaw.some((a) => a <= 0n)) return null // dust leg → the no-skip rule zeroes the mint

  // Contract replay: slice = ceil(recv × fee/BPS); share_i = floor(net_i × S / held_i); min.
  const fee = BigInt(Math.max(0, Math.round(basketFeeBps)))
  let shares: bigint | null = null
  for (let i = 0; i < legs.length; i++) {
    const slice = mulDivUp(amountsRaw[i], fee, BPS)
    const net = amountsRaw[i] - slice
    if (net <= 0n) return null
    const s = mulDiv(net, supplyRaw, legs[i].heldRaw)
    shares = shares == null || s < shares ? s : shares
  }
  if (shares == null || shares <= 0n) return null

  // How much the min-rule discards under this plan (integer rounding only —
  // structurally ~0, which is the whole point; pinned by tests).
  let worstRatio = Number.POSITIVE_INFINITY
  let sumRatio = 0
  for (let i = 0; i < legs.length; i++) {
    const slice = mulDivUp(amountsRaw[i], fee, BPS)
    const ratio = Number(amountsRaw[i] - slice) / Number(legs[i].heldRaw)
    worstRatio = Math.min(worstRatio, ratio)
    sumRatio += ratio
  }
  const avgRatio = sumRatio / legs.length
  const roundingLossPct = avgRatio > 0 ? (1 - worstRatio / avgRatio) * 100 : 0

  return { amountsRaw, legBudgetsUsd, expectedSharesRaw: shares, roundingLossPct }
}

/** minShares for the deposit: the prediction with a caller haircut (bps) for
 *  acquisition slippage between quote and landing. */
export function fairMintMinShares(expectedSharesRaw: bigint, haircutBps: number): bigint {
  const h = BigInt(Math.min(Math.max(Math.round(haircutBps), 0), 5_000))
  return mulDiv(expectedSharesRaw, BPS - h, BPS)
}
