import { basketPnl, type BasketPnl, type PnlIndex } from './pnl'
import type { BasketData, Holding } from './basket-data'
import type { PortfolioHolding } from './hooks'

// ─────────────────────────────────────────────────────────────────────────────
// BASKET HOLDER STATS — what a person who BOUGHT a basket wants to know about
// it (the owner, 2026-08-15: "stats on your basket buys, like how much pnl you have
// since you bought it, what the best performing assets are in each of your
// baskets… done in an rpc efficient manner").
//
// ⚠ THIS MODULE MAKES NO NETWORK CALLS, BY DESIGN, AND THAT IS THE WHOLE
// "RPC-EFFICIENT" ANSWER. Every input it needs is already on the portfolio page
// before this section renders:
//   · `PortfolioHolding[]`      — usePortfolio (the held-basket list itself)
//   · `PnlIndex` per chain      — usePnlIndexes, ONE wide getLogs per wallet,
//                                 cached in localStorage and topped up
//   · `BasketData` per basket   — the ['spectrum','basket',chainId,addr] query
//                                 that useLiveExposure / useNavGaps already warm
// So the panel costs ZERO additional reads. The temptation was a per-basket
// constituent fetch; that would have been N baskets × M legs of price reads for
// numbers the basket query already carries (`Holding.change24hPct` is priced and
// dated at the same read that produced the NAV). If you ever add an input here,
// it must come from a query key that is ALREADY mounted, or the section stops
// being free and starts being a reason the portfolio page is slow.
//
// Pure and synchronous so it is testable without a chain, in the house pattern
// (lp-positions.ts's `withLpExposure` is the sibling).
// ─────────────────────────────────────────────────────────────────────────────

/** One constituent, reduced to what a holder is actually deciding with. */
export interface LegMove {
  symbol: string
  asset: string
  /** 24h move, percent. Null = unpriceable — NEVER coerced to 0, because "flat"
   *  and "we could not read it" are different facts and only one is news. */
  change24hPct: number | null
  /** Live weight, percent — how much of THIS holder's money rides on it. */
  liveWeightPct: number
  /** This holder's dollars in this leg (their share of the basket's holding). */
  valueUsd: number
}

export interface BasketHolderRow {
  key: string
  chainId: number
  symbol: string
  address: string
  /** Tokens held and their value at the current NAV. */
  balance: number
  valueUsd: number
  /** Null when the wallet has no cost basis on record for it (bought before the
   *  index's first block, received as a transfer, or bought via a path the
   *  router event does not cover). The row still renders — a position with no
   *  basis is still a position, and hiding it would under-report the book. */
  pnl: BasketPnl | null
  /** Best and worst 24h movers among the legs we could price. Null when NO leg
   *  is priceable — a basket of unpriceable legs has no best, and inventing one
   *  from unpriced rows would be a claim we cannot support. */
  best: LegMove | null
  worst: LegMove | null
  /** Every leg, sorted by weight — the detail behind best/worst. */
  legs: LegMove[]
  /** Legs whose price could not be read. Surfaced, never silently dropped: a
   *  "best performer" chosen from half the basket is a misleading number. */
  unpricedLegs: number
  /** The basket's own 24h move, percent (NAV-based). Null = unreadable. */
  change24hPct: number | null
}

export interface BasketHolderStats {
  rows: BasketHolderRow[]
  /** Totals across rows that HAVE a basis — never mixed with basis-less rows,
   *  which would make the percentage meaningless. */
  totalInvestedUsd: number
  totalCurrentUsd: number
  totalNetUsd: number
  totalNetPct: number
  totalRealizedUsd: number
  /** Rows carrying no cost basis, so the surface can say the totals are partial
   *  instead of quietly describing a subset as the whole book. */
  rowsWithoutBasis: number
}

const keyOf = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

/** A holder's slice of one constituent: the basket owns `h.valueUsd` of it
 *  across ALL holders, so this holder's share is their fraction of supply. */
function legFor(h: Holding, shareOfBasket: number): LegMove {
  return {
    symbol: h.symbol,
    asset: h.asset,
    // `priced` is the read's own verdict; trust it over a zero that may be real
    change24hPct: h.priced ? h.change24hPct : null,
    liveWeightPct: h.liveWeightPct,
    valueUsd: h.valueUsd * shareOfBasket,
  }
}

/**
 * Build the per-basket rows from data the page already has.
 *
 * `pnlByChain` is keyed by chainId; a missing or null index simply means no
 * basis for that chain's baskets (the wide-log scan is unavailable on some
 * RPCs — `pnlAvailable` decides that upstream), which yields `pnl: null` rather
 * than a zeroed row that would read as "you are exactly break-even".
 *
 * `dataByKey` is keyed `chainId:address` (lowercased).
 */
export function buildBasketHolderStats(
  holdings: readonly PortfolioHolding[],
  pnlByChain: Readonly<Record<number, PnlIndex | null | undefined>>,
  dataByKey: ReadonlyMap<string, BasketData | null | undefined>,
): BasketHolderStats {
  const rows: BasketHolderRow[] = []

  for (const h of holdings) {
    const chainId = h.basket.chainId
    const address = h.basket.address
    const k = keyOf(chainId, address)
    const data = dataByKey.get(k) ?? null

    // A holder's share of the basket = their tokens / effective supply. Guarded
    // both ways: a zero or unreadable supply must not divide, and a share above
    // 1 (a stale supply read against a fresh balance) is clamped — the leg
    // dollars are a display of THEIR money and must never exceed the basket's.
    const supply = data?.effectiveSupply ?? 0
    const share = supply > 0 ? Math.min(1, h.balance / supply) : 0

    const legs = (data?.holdings ?? []).map((leg) => legFor(leg, share)).sort((a, b) => b.liveWeightPct - a.liveWeightPct)
    const priced = legs.filter((l) => l.change24hPct != null)
    const unpricedLegs = legs.length - priced.length

    // best/worst over the PRICED legs only, and null when none are priced
    let best: LegMove | null = null
    let worst: LegMove | null = null
    for (const l of priced) {
      if (best == null || (l.change24hPct as number) > (best.change24hPct as number)) best = l
      if (worst == null || (l.change24hPct as number) < (worst.change24hPct as number)) worst = l
    }
    // ⚠ ONE PRICED LEG IS NOT A BEST AND A WORST. With a single readable leg
    // the same row would appear twice under opposite labels, which reads as two
    // findings when it is one. Show it as the mover it is; the pair needs two.
    if (priced.length < 2) worst = null

    rows.push({
      key: k,
      chainId,
      symbol: h.basket.symbol,
      address,
      balance: h.balance,
      valueUsd: h.valueUsd,
      pnl: basketPnl(pnlByChain[chainId] ?? null, address, h.basket.navPerToken, h.balance),
      best,
      worst,
      legs,
      unpricedLegs,
      change24hPct: h.basket.change24hPct ?? null,
    })
  }

  // biggest position first — the money order, not alphabetical
  rows.sort((a, b) => b.valueUsd - a.valueUsd)

  let totalInvestedUsd = 0
  let totalCurrentUsd = 0
  let totalRealizedUsd = 0
  let rowsWithoutBasis = 0
  for (const r of rows) {
    if (!r.pnl) {
      rowsWithoutBasis++
      continue
    }
    totalInvestedUsd += r.pnl.investedUsd
    totalCurrentUsd += r.pnl.currentUsd
    totalRealizedUsd += r.pnl.realizedUsd
  }
  const totalNetUsd = totalCurrentUsd - totalInvestedUsd

  return {
    rows,
    totalInvestedUsd,
    totalCurrentUsd,
    totalNetUsd,
    totalNetPct: totalInvestedUsd > 0 ? totalNetUsd / totalInvestedUsd : 0,
    totalRealizedUsd,
    rowsWithoutBasis,
  }
}
