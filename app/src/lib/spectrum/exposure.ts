import type { PortfolioHolding } from './hooks'

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio look-through: decompose the baskets a wallet holds into net per-asset
// exposure. Hold three baskets that each touch WETH → see one aggregate WETH line.
//
// This is the analysis a basket product can give that a flat token list cannot,
// and it is PURELY FACTUAL — a restatement of on-chain facts already loaded for the
// portfolio (each held basket's USD value × its constituents' weights). No prices
// are fetched here, no advice: it never ranks, recommends, or projects.
//
// Two weighting bases:
//   • 'target' (default, zero-fetch) — the basket's immutable designed composition
//     (`basket.top[].weightPct`), already on the cached summary.
//   • 'live' — the actual current pool weights (drift from target as prices move),
//     supplied per-basket by the caller from a fresh `getBasketData` read.
// When 'live' is requested but a basket's live legs are absent (still loading or a
// failed read), that basket falls back to its target legs — never dropped.
//
// Assets are keyed by `chainId:address` so the same symbol on different chains
// (e.g. Base WETH vs mainnet WETH — distinct tokens) is never silently merged.
// ─────────────────────────────────────────────────────────────────────────────

export type WeightBasis = 'target' | 'live'

/** A single constituent of a basket, in either basis (weightPct is target or live). */
export interface ExposureLeg {
  address: string
  symbol: string
  weightPct: number
}

export interface ExposureContribution {
  /** The held basket contributing this slice. */
  basketSymbol: string
  basketAddress: string
  chainId: number
  /** USD of this wallet's basket value attributed to the asset. */
  valueUsd: number
}

export interface AssetExposure {
  /** `${chainId}:${lowercased address}` — the aggregation key. */
  key: string
  address: string
  symbol: string
  chainId: number
  /** Net USD exposure to this asset across every held basket. */
  valueUsd: number
  /** Share of the looked-through total (0–100). */
  pct: number
  /** How many of the wallet's baskets contribute to this asset. */
  basketCount: number
  /** True when this row is a LIQUIDITY POSITION (lp-positions.ts) — a display
   *  exposure like any other tile, but never a tradeable token: trade/chart
   *  doors must gate on it. */
  lp?: boolean
  /** True when this row IS a held basket standing whole (basketFold: 'whole').
   *  Its designed legs ride along so display surfaces can draw the mix. */
  basket?: boolean
  basketLegs?: ExposureLeg[]
  /** Per-basket breakdown, largest first. */
  contributions: ExposureContribution[]
}

export interface ExposureBreakdown {
  assets: AssetExposure[]
  /** Sum of all attributed exposure (≈ total held basket value). */
  totalUsd: number
  /** Distinct chains the underlying assets sit on. */
  chainCount: number
  /** Which basis the weights were taken on. */
  basis: WeightBasis
  /** In 'live' basis: held baskets that fell back to target legs (live not ready). */
  fellBackCount: number
}

export interface ExposureOptions {
  /** Weighting basis. Default 'target' (zero-fetch). */
  basis?: WeightBasis
  /** 'live' legs per held basket, keyed `${chainId}:${lowercased basket address}`. */
  liveData?: Map<string, ExposureLeg[]>
  /** How a held basket lands in the rows (owner 2026-08-16: "the main
   *  portfolio doesnt show it as baskets like it should").
   *  · 'exploded' (default, the original look-through) — the basket dissolves
   *    into its constituents; three baskets touching WETH read as one WETH line.
   *  · 'whole' — the basket stands as ONE row under its own key, its designed
   *    legs carried on `basketLegs` so a tile can draw the composition. */
  basketFold?: 'exploded' | 'whole'
}

/**
 * Aggregate a wallet's basket holdings into net per-asset exposure.
 * Pure + synchronous: operates only on data already loaded for the portfolio
 * (plus, in 'live' basis, the per-basket legs the caller passes in `liveData`).
 */
export function computeExposure(
  holdings: PortfolioHolding[],
  opts: ExposureOptions = {},
): ExposureBreakdown {
  const basis: WeightBasis = opts.basis ?? 'target'
  const liveData = opts.liveData
  const map = new Map<string, AssetExposure>()
  let fellBackCount = 0

  for (const h of holdings) {
    const { chainId, top, symbol: basketSymbol, address: basketAddress } = h.basket
    if (h.valueUsd <= 0) continue

    // WHOLE-BASKET FOLD: the position stands as one row under the basket's own
    // key — same shape as the unknowable-contents branch below, plus the legs
    // for the tile's mix. Same basket held from two linked wallets merges into
    // one row via the shared key, exactly like any other asset.
    if (opts.basketFold === 'whole') {
      const key = `${chainId}:${basketAddress.toLowerCase()}`
      let e = map.get(key)
      if (!e) {
        e = {
          key,
          address: basketAddress.toLowerCase(),
          symbol: basketSymbol,
          chainId,
          valueUsd: 0,
          pct: 0,
          basketCount: 0,
          basket: true,
          basketLegs: top ?? [],
          contributions: [],
        }
        map.set(key, e)
      }
      e.valueUsd += h.valueUsd
      e.contributions.push({ basketSymbol, basketAddress, chainId, valueUsd: h.valueUsd })
      continue
    }

    // Pick the legs for this basket in the requested basis. Live with no resolved
    // data falls back to target so the basket is never silently dropped.
    let legs: ExposureLeg[] | undefined
    if (basis === 'live') {
      legs = liveData?.get(`${chainId}:${basketAddress.toLowerCase()}`)
      if (!legs || legs.length === 0) {
        legs = top
        if (top?.length) fellBackCount += 1
      }
    } else {
      legs = top
    }
    if (!legs?.length) {
      // A HELD BASKET WITH UNKNOWABLE CONTENTS STAYS WHOLE (UIGuy's class-
      // signal review, 2026-08-06): this used to `continue`, which DROPPED
      // the position — the book's total silently lost real money whenever a
      // basket's legs could not be read. Half-knowable = say the half you
      // know: the position's value is a fact even when its contents aren't,
      // so it stands as its own row under the basket's own key. This is also
      // the only row the bento can honestly draw as a BASKET tile — a
      // registered basket always explodes into its legs.
      const key = `${chainId}:${basketAddress.toLowerCase()}`
      let e = map.get(key)
      if (!e) {
        e = { key, address: basketAddress.toLowerCase(), symbol: basketSymbol, chainId, valueUsd: 0, pct: 0, basketCount: 0, contributions: [] }
        map.set(key, e)
      }
      e.valueUsd += h.valueUsd
      e.contributions.push({ basketSymbol, basketAddress, chainId, valueUsd: h.valueUsd })
      continue
    }

    for (const c of legs) {
      const slice = h.valueUsd * (c.weightPct / 100)
      if (!(slice > 0)) continue // skip zero / NaN / negative / unpriced legs defensively

      const address = c.address.toLowerCase()
      const key = `${chainId}:${address}`
      let e = map.get(key)
      if (!e) {
        e = { key, address, symbol: c.symbol, chainId, valueUsd: 0, pct: 0, basketCount: 0, contributions: [] }
        map.set(key, e)
      }
      e.valueUsd += slice
      e.contributions.push({ basketSymbol, basketAddress, chainId, valueUsd: slice })
    }
  }

  const assets = [...map.values()]
  const totalUsd = assets.reduce((s, a) => s + a.valueUsd, 0)
  for (const a of assets) {
    a.pct = totalUsd > 0 ? (a.valueUsd / totalUsd) * 100 : 0
    a.basketCount = a.contributions.length
    a.contributions.sort((x, y) => y.valueUsd - x.valueUsd)
  }
  assets.sort((a, b) => b.valueUsd - a.valueUsd)

  const chainCount = new Set(assets.map((a) => a.chainId)).size
  return { assets, totalUsd, chainCount, basis, fellBackCount }
}
