import { parseUnits } from 'viem'
import { deriveLegMins } from './hook-data'
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
//   • STALE-BOUNDED — if the caller supplies the age of the spot quotes
//     (`priceAgeMs`) and it exceeds `maxPriceAgeMs`, the quote is REFUSED (null).
//     The binding real-time backstop remains the click-time on-chain simulate in
//     use-basket-swap (a committed minimum that can no longer be met reverts
//     before the wallet prompt) — this bound is the cheap first check.
//   • ON-CHAIN BASKET ORDER — legs map positionally to the on-chain basket order
//     (the caller passes `holdings` in that order; the FE builds it from
//     basket(0..len-1)). A mis-ordered array silently floors the WRONG leg.
//   • NO SILENT ZERO, EVER — any unpriced leg, any amount that rounds to zero, or
//     any derived legMin that floor-rounds to zero ⇒ this returns `null` (the swap
//     is not encodable and the UI stays disabled). It NEVER fabricates a leg quote
//     or emits a zero/placeholder floor. This mirrors hook-data.ts's invariant; the
//     two are the only floor-touching code and must agree. Do not add a bypass.
//
// SWAP PATH ONLY. Legs are priced at TARGET weights because a swap-mint acquires
// constituents at target weights (SpectrumBasket._acquireBasket). The in-kind
// (mintInKind/redeemInKind) path is different — it prices off live
// idleHeld/effectiveSupply, never target weights — and must NOT reuse this module.
// ─────────────────────────────────────────────────────────────────────────────

/** USDC is the settlement asset, 6-decimal on Base. */
const USDC_DECIMALS = 6

/** Default staleness bound for the spot quotes backing a floor (ms). DexScreener's
 *  own cache TTL is ~30s; 60s leaves headroom while still refusing clearly-stale marks. */
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
  /** age (ms) of the spot quotes; when provided and > maxPriceAgeMs the quote is refused */
  priceAgeMs?: number
  /** staleness bound (ms); defaults to DEFAULT_MAX_PRICE_AGE_MS */
  maxPriceAgeMs?: number
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
}

/**
 * Derive the broadcast-grade swap inputs + per-leg floors, or `null` when a
 * protected swap is NOT encodable (any unpriced/zero leg, a rounds-to-zero amount,
 * a rounded-zero floor, or a stale quote). Pure — no React, no network, no wallet;
 * unit-testable like deriveLegMins. NEVER fabricates a leg or emits a zero floor.
 */
export function buildSwapQuote(input: SwapQuoteInput): SwapQuote | null {
  const { side, amount, navPerToken, feeFrac, slippageBps, holdings, basketDecimals } = input
  if (!(amount > 0) || !(navPerToken > 0) || !Number.isFinite(feeFrac)) return null
  if (holdings.length === 0) return null

  // stale-bounded: refuse floors derived off a quote older than the bound.
  const maxAge = input.maxPriceAgeMs ?? DEFAULT_MAX_PRICE_AGE_MS
  if (input.priceAgeMs != null && input.priceAgeMs > maxAge) return null

  const out = side === 'buy' ? (amount * (1 - feeFrac)) / navPerToken : amount * navPerToken * (1 - feeFrac)
  const minOut = out * (1 - clampForFloor(slippageBps) / 10_000)
  const shareDecimals = Math.min(basketDecimals, 18)
  const amountRaw = side === 'buy' ? toRaw(amount, USDC_DECIMALS) : toRaw(amount, shareDecimals)
  const minOutRaw = side === 'buy' ? toRaw(minOut, shareDecimals) : toRaw(minOut, USDC_DECIMALS)
  if (amountRaw <= 0n || minOutRaw <= 0n) return null

  const legCount = holdings.length

  if (side === 'sell') {
    // SELL is protected by the AGGREGATE USDC minOut (minOutRaw) — enforced by the basket's
    // _sellFlow (SlippageExceeded) AND the router's own backstop. The contract's per-leg sell
    // floors (in _unwindToUsdc) are ETH/USDC-denominated and OPTIONAL; the FE does not
    // reconstruct those units, so the redeem encoder ships length-correct ZERO per-leg floors.
    // No per-leg preview on a sell.
    return { quotedLegAmounts: [], amountRaw, minOutRaw, legCount, legs: [] }
  }

  // BUY: per-leg floors in constituent-token units, priced off NET (post-fee) USDC. The
  // contract acquires constituents from usdcNet (SpectrumBasket._acquireBasket: per-leg USD =
  // net × weight/BPS), so pricing off GROSS would leave the buffer leg's floor with no
  // headroom against the fee and revert honest buys (effective protection = slip − fee).
  const usdNet = amount * (1 - feeFrac)
  const quotedLegAmounts = holdings.map((h) => {
    if (!(h.priceUsd > 0)) return 0n // INDEPENDENT source (off the constituents' real pools)
    const legUsd = (h.targetWeightPct / 100) * usdNet
    return toRaw(legUsd / h.priceUsd, h.decimals) // decimals-correct, ON-CHAIN basket order
  })
  if (quotedLegAmounts.some((q) => q <= 0n)) return null

  const legMins = deriveLegMins(quotedLegAmounts, slippageBps)
  // A rounded-zero floor would silently disable the per-leg protection — abort.
  if (legMins.some((m) => m <= 0n)) return null

  return {
    quotedLegAmounts,
    amountRaw,
    minOutRaw,
    legCount,
    legs: holdings.map((h, i) => ({ symbol: h.symbol, decimals: h.decimals, min: legMins[i] })),
  }
}

/** Local mirror of hook-data's slippage clamp shape for the human-`minOut` preview
 *  (deriveLegMins re-clamps for the on-chain floors; this keeps the previewed
 *  minOut consistent with a clamped slippage). */
function clampForFloor(bps: number): number {
  if (!Number.isFinite(bps)) return 0
  return Math.min(Math.max(Math.round(bps), 0), 10_000)
}
