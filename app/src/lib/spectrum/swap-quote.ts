import { parseUnits } from 'viem'
import { deriveLegMins, MAX_SPLIT_BPS } from './hook-data'
import type { Side } from './use-basket-swap'

// ─────────────────────────────────────────────────────────────────────────────
// swap-quote — the Tier-1 floor-derivation surface for the buy/sell swap path.
//
// This is the off-chain half of the slippage control. The first-mint floor
// derivation is a Tier-1 security surface (same review rigor as
// the contract): the on-chain check proves a per-leg floor EXISTS and is non-zero,
// never that it is ADEQUATE — adequacy lives here. The binding properties (all
// enforced below; see contracts/docs/SWAP-ROUTER-REFERENCE.md §5):
//
//   • INDEPENDENT price source — legs are priced from `priceUsd` (the basket
//     data's DexScreener-derived constituent spot, read off the constituents'
//     REAL pools), never the basket's own {BASKET,USDC} self-pool (which has no
//     real liquidity and is the thing a manipulated trade would move). This module
//     never reads the self-pool.
//   • DECIMALS-CORRECT — each leg scales to its OWN token decimals (toRaw clamps
//     only the toFixed fractional precision to 18; the integer scale stays full).
//     Do not re-clamp leg decimals to 18.
//   • ON-CHAIN BASKET ORDER — legs map positionally to the on-chain basket order
//     (the caller passes `holdings` in that order; the FE builds it from
//     basket(0..len-1)). A mis-ordered array silently floors the WRONG leg.
//   • NO SILENT ZERO, EVER — any unpriced leg, any amount that rounds to zero, or
//     any derived legMin that floor-rounds to zero ⇒ this returns `null` (the swap
//     is not encodable and the UI stays disabled). It NEVER fabricates a leg quote
//     or emits a zero/placeholder floor. This mirrors hook-data.ts's invariant; the
//     two are the only floor-touching code and must agree. Do not add a bypass.
//
// STALENESS IS NOT ON THAT LIST, AND MUST NOT BE PUT BACK ON IT. ⚠ AUDIT 2026-08-06:
// this header used to list a staleness REFUSAL as a binding property. It is not one.
// `priceAgeMs` below is optional, no production caller supplies it, and none honestly
// can, for two independent reasons. (1) Nothing timestamps a mark: `BasketData.updatedAt`
// is stamped when the whole read was assembled, while fetchDexPrices serves marks from a
// 30s cache without carrying their own `ts`, so it UNDERSTATES the mark age. (2) The read
// is not polled — `useBasketData` is staleTime-only with no refetchInterval — so at click
// time that stamp is routinely minutes old and unbounded above; feeding it to a 60s
// refusal would abort honest trades, and in use-dex-swap/use-sweep it would abort them
// AFTER the hub swap has already executed. What DOES bound staleness, and what the audit
// confirmed runs: the click-time on-chain simulate in use-basket-swap (a committed
// minimum that can no longer be met reverts before the wallet prompt) and the aggregate
// `minOut` the payload commits. The parameter stays as a working opt-in for a caller that
// ever holds a real mark timestamp; it is not a guarantee this module makes today.
//
// SWAP PATH ONLY. Legs are priced at the proportion the mint will ACTUALLY fund them
// with: `fundingSplitBps` when the payload carries a split (a D-R1 basket funds from
// bits [255:240] of each legMins word), otherwise the basket's TARGET weights (a
// pre-packing basket funds from `basket[i].weight` itself). Pricing a leg at a
// proportion the payload does not fund it with is how a floor becomes unreachable:
// contracts measured target-weight funding running 28.0% off the value-proportional
// split on LPADS/4663, so an under-funded leg would trip LegMinNotMet on an honest
// buy. The PRICE stays ours (independent, off the constituents' real pools) — only
// the share of the trade comes from the chain. The in-kind (mintInKind/redeemInKind)
// path is different — it prices off live idleHeld/effectiveSupply — and must NOT
// reuse this module.
// ─────────────────────────────────────────────────────────────────────────────

/** Default bound applied to a caller-supplied `priceAgeMs` (ms). DexScreener's own
 *  cache TTL is ~30s, so 60s leaves headroom. Nothing supplies that age today, so
 *  this refuses nothing in production — see the header. */
export const DEFAULT_MAX_PRICE_AGE_MS = 60_000

/** Human number → raw units, scaled to the token's TRUE decimals; 0n on any
 *  non-finite or non-positive input (those paths can't encode a swap). Only the
 *  toFixed FRACTIONAL precision is clamped to 18 — the integer scale stays full. */
export function toRaw(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n
  try {
    return parseUnits(value.toFixed(Math.min(decimals, 18)), decimals)
  } catch {
    return 0n
  }
}

/** Per-leg inputs, IN ON-CHAIN BASKET ORDER. */
export interface QuoteLeg {
  symbol: string
  decimals: number
  /** target weight, percent (0..100) */
  targetWeightPct: number
  /** independent spot price, USD per whole token (e.g. DexScreener). <=0 ⇒ unpriced. */
  priceUsd: number
}

export interface SwapQuoteInput {
  side: Side
  /** human input amount (USDC on a buy, basket shares on a sell) */
  amount: number
  /** basket NAV per share (USDC), > 0 */
  navPerToken: number
  /** basket fee as a fraction (e.g. 0.01 for 1%) */
  feeFrac: number
  /** slippage tolerance, bps */
  slippageBps: number
  /** basket constituents, in on-chain basket order */
  holdings: ReadonlyArray<QuoteLeg>
  /** basket share token decimals */
  basketDecimals: number
  /** Settlement-token decimals for THIS basket's chain — from the deployment
   *  book (settlementDecimalsFor), REQUIRED so no caller silently inherits a
   *  hardcoded 6 (cold-review INFO-1). */
  settlementDecimals: number
  /** Age (ms) of the spot quotes; when provided and > maxPriceAgeMs the quote is refused.
   *  OPT-IN, AND NO PRODUCTION CALLER SUPPLIES IT (audit 2026-08-06 — the header says
   *  why none honestly can). Do not read it as a guard that runs. */
  priceAgeMs?: number
  /** staleness bound (ms); defaults to DEFAULT_MAX_PRICE_AGE_MS */
  maxPriceAgeMs?: number
  /** BOTH SIDES — the REALISED tokenOut (raw: shares on a buy, settlement on a sell)
   *  from simulating the actual trade on-chain (swap-sim.ts). When present this REPLACES
   *  the frictionless estimate as the basis for `minOutRaw`, and on a BUY it also
   *  deflates the per-leg floors by the measured survival ratio. Spot/NAV charge nothing
   *  for the hub swap, each leg's swap, or the mint min-rule's discarded cross-leg
   *  imbalance. Measured live 2026-07-14: sells landed ~1.8% under NAV at 1 share and
   *  −43.6% at 500/5452; buys landed 10–18% under expectation at $1 and −68% at $1000 —
   *  so frictionless floors reverted sells above ~5 shares and buys at EVERY size.
   *  Absent (simulation unsupported/failed) ⇒ degrade to the frictionless estimate. */
  realisedOutRaw?: bigint
  /** BUY only — the per-leg funding split (bps, on-chain basket order) the payload will
   *  carry, straight from `factory.bareLegMins` via mint-funding.ts. Present ⇒ each leg
   *  is priced off ITS share of the trade instead of its target weight, because that is
   *  what the mint will hand it. A leg the split funds with 0 quotes 0 and ships no
   *  floor (the acquire loop skips it, so a floor there is a guaranteed LegMinNotMet and
   *  there is no swap to sandwich). Null/absent ⇒ target weights, exactly as before.
   *  NEVER pass a locally-derived split here: see mint-funding.ts. */
  fundingSplitBps?: readonly number[] | null
}

/** The broadcast-grade swap inputs — the SAME values previewed and signed. */
export interface SwapQuote {
  /** BUY: per-leg quoted acquired amounts (raw, each leg's own decimals), on-chain order.
   *  SELL: empty — the sell path is aggregate-minOut protected, not per-leg. */
  quotedLegAmounts: bigint[]
  /** tokenIn raw (USDC@6 on a buy, shares@min(decimals,18) on a sell) */
  amountRaw: bigint
  /** aggregate out floor raw (shares on a buy, USDC on a sell) — the BINDING sell protection */
  minOutRaw: bigint
  /** on-chain basket length (the redeem encoder zero-fills legMins to this length) */
  legCount: number
  /** BUY: per-leg minimums for the review UI. SELL: empty (no per-leg floors). */
  legs: { symbol: string; decimals: number; min: bigint }[]
  /** The expected (pre-slippage) output the floor was derived from, raw. Show THIS in the
   *  preview: when simulated it is achievable, unlike the frictionless estimate. */
  expectedOutRaw: bigint
  /** Where `expectedOutRaw` came from. 'simulated' = the real trade was priced on-chain
   *  (accurate). 'nav' = degraded frictionless estimate (may overstate). */
  basis: 'simulated' | 'nav'
}

/**
 * Derive the broadcast-grade swap inputs + per-leg floors, or `null` when a
 * protected swap is NOT encodable (any unpriced/zero leg, a rounds-to-zero amount,
 * a rounded-zero floor, or — where a caller supplies its marks' age — a stale
 * quote). Pure — no React, no network, no wallet;
 * unit-testable like deriveLegMins. NEVER fabricates a leg or emits a zero floor.
 */
export function buildSwapQuote(input: SwapQuoteInput): SwapQuote | null {
  const { side, amount, navPerToken, feeFrac, slippageBps, holdings, basketDecimals } = input
  if (!(amount > 0) || !(navPerToken > 0) || !Number.isFinite(feeFrac)) return null
  if (holdings.length === 0) return null

  // Refuse floors derived off a quote older than the bound — for a caller that can
  // honestly measure the age of ITS marks. None can today (header), so this is inert
  // in production: staleness is bounded by the click-time simulate and by minOut.
  const maxAge = input.maxPriceAgeMs ?? DEFAULT_MAX_PRICE_AGE_MS
  if (input.priceAgeMs != null && input.priceAgeMs > maxAge) return null

  const out = side === 'buy' ? (amount * (1 - feeFrac)) / navPerToken : amount * navPerToken * (1 - feeFrac)
  const shareDecimals = Math.min(basketDecimals, 18)
  const amountRaw = side === 'buy' ? toRaw(amount, input.settlementDecimals) : toRaw(amount, shareDecimals)
  const bps = BigInt(10_000 - clampForFloor(slippageBps))

  // BASIS (both sides): the SIMULATED realised output when we have it, else the
  // frictionless spot/NAV estimate (degraded). Slippage is applied in raw bigint units
  // so the floor is exactly a haircut on the simulated number — no float round-trip to
  // drift it above what the chain will actually pay.
  const outDecimals = side === 'buy' ? shareDecimals : input.settlementDecimals
  const frictionlessOutRaw = toRaw(out, outDecimals)
  const useSim = input.realisedOutRaw != null && input.realisedOutRaw > 0n
  const expectedOutRaw = useSim ? (input.realisedOutRaw as bigint) : frictionlessOutRaw
  const minOutRaw = (expectedOutRaw * bps) / 10_000n
  if (amountRaw <= 0n || minOutRaw <= 0n || expectedOutRaw <= 0n) return null
  const basis: 'simulated' | 'nav' = useSim ? 'simulated' : 'nav'

  // How much of the frictionless expectation actually survives execution. On a BUY this
  // captures BOTH the two-hop swap friction AND the mint min-rule's discarded
  // cross-leg imbalance, so it is the honest factor to deflate the per-leg floors by:
  // floors derived from raw spot were 10–68% above what the legs really acquire, which
  // reverted LegMinNotMet on every buy. Capped at 1× — a better-than-expected fill must
  // never TIGHTEN the floors above the quote the user was shown.
  const survivalNum = useSim && frictionlessOutRaw > 0n
    ? (expectedOutRaw < frictionlessOutRaw ? expectedOutRaw : frictionlessOutRaw)
    : 0n
  const survivalDen = survivalNum > 0n ? frictionlessOutRaw : 0n

  // ADEQUACY, not merely non-zero.
  //
  // The contracts' robinhood SPEC (§380) designates THIS derivation a Tier-1
  // security surface, in its own words: "the gate guarantees INTENTIONALITY, not
  // ADEQUACY… a garbage legMins[i] = 1 wei satisfies the gate and protects
  // nothing… the effective first-mint floor guarantee is therefore only as strong
  // as the weakest floor the launching tooling produces."
  //
  // So `> 0n` is not enough by itself. A collapsed survival ratio deflates the
  // floors toward dust: still non-zero, so FirstMintLegMinRequired is satisfied
  // and the contract waves it through, while the per-leg protection is gone and a
  // sandwich takes everything. Refuse instead — if the simulation says the route
  // delivers under a tenth of the frictionless expectation, those two numbers
  // disagree so badly that no floor derived from them is worth signing.
  //
  // 10% sits well below any real case: the worst drift measured on a live basket
  // was ~28% loss, i.e. 72% survival.
  if (survivalDen > 0n && survivalNum * 10n < survivalDen) return null

  const legCount = holdings.length

  if (side === 'sell') {
    // SELL is protected by the AGGREGATE USDC minOut (minOutRaw) — enforced by the basket's
    // _sellFlow (SlippageExceeded) AND the router's own backstop. The contract's per-leg sell
    // floors (in _unwindToUsdc) are ETH/USDC-denominated and OPTIONAL; the FE does not
    // reconstruct those units, so the redeem encoder ships length-correct ZERO per-leg floors.
    // No per-leg preview on a sell.
    return { quotedLegAmounts: [], amountRaw, minOutRaw, legCount, legs: [], expectedOutRaw, basis }
  }

  // BUY: per-leg floors in constituent-token units, priced off NET (post-fee) USDC. The
  // contract acquires constituents from usdcNet (SpectrumBasket._acquireBasket: per-leg USD =
  // net × split/BPS), so pricing off GROSS would leave the buffer leg's floor with no
  // headroom against the fee and revert honest buys (effective protection = slip − fee).
  const usdNet = amount * (1 - feeFrac)
  const split = input.fundingSplitBps ?? null
  // A split that does not describe THIS basket would floor the wrong leg — refuse rather
  // than fall back to weights, because the payload will fund by the split regardless.
  if (split && split.length !== holdings.length) return null
  if (split && split.some((s) => !Number.isInteger(s) || s < 0 || s > MAX_SPLIT_BPS)) return null
  /** Legs the payload funds with nothing: no floor, no protection to lose (no swap). */
  const unfunded = (i: number) => split != null && split[i] === 0
  const quotedLegAmounts = holdings.map((h, i) => {
    if (unfunded(i)) return 0n
    if (!(h.priceUsd > 0)) return 0n // INDEPENDENT source (off the constituents' real pools)
    // The share the MINT will fund this leg with: the payload's split when there is one.
    const legUsd = split ? (split[i] / MAX_SPLIT_BPS) * usdNet : (h.targetWeightPct / 100) * usdNet
    return toRaw(legUsd / h.priceUsd, h.decimals) // decimals-correct, ON-CHAIN basket order
  })
  if (quotedLegAmounts.some((q, i) => q <= 0n && !unfunded(i))) return null
  if (quotedLegAmounts.every((q) => q <= 0n)) return null

  // Deflate the per-leg expectations by the MEASURED survival ratio before applying
  // slippage, so the floors bind to what the acquisition really delivers. Without this
  // they are raw-spot amounts the two-hop route + min-rule can never reach. The
  // aggregate `minOutRaw` (simulated) remains the binding sandwich protection — shares
  // are minted from MEASURED balance deltas via the min-rule, so a starved leg shows up
  // there — and these stay non-zero so the never-a-zero-floor invariant holds.
  const adjustedLegAmounts = survivalDen > 0n
    ? quotedLegAmounts.map((q) => (q * survivalNum) / survivalDen)
    : quotedLegAmounts
  if (adjustedLegAmounts.some((q, i) => q <= 0n && !unfunded(i))) return null

  const legMins = deriveLegMins(adjustedLegAmounts, slippageBps)
  // A rounded-zero floor would silently disable the per-leg protection — abort. An
  // UNFUNDED leg is the one exception and only the chain's own split may declare it.
  if (legMins.some((m, i) => m <= 0n && !unfunded(i))) return null

  return {
    // ADJUSTED, not raw-spot: encodeMintHookData re-derives the legMins from this
    // field, so the survival-deflated amounts must be what leaves here.
    quotedLegAmounts: adjustedLegAmounts,
    amountRaw,
    minOutRaw,
    legCount,
    legs: holdings.map((h, i) => ({ symbol: h.symbol, decimals: h.decimals, min: legMins[i] })),
    expectedOutRaw,
    basis,
  }
}

/** Local mirror of hook-data's slippage clamp shape for the human-`minOut` preview
 *  (deriveLegMins re-clamps for the on-chain floors; this keeps the previewed
 *  minOut consistent with a clamped slippage). */
function clampForFloor(bps: number): number {
  if (!Number.isFinite(bps)) return 0
  return Math.min(Math.max(Math.round(bps), 0), 10_000)
}
