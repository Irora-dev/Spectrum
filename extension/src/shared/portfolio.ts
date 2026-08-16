// React-free portfolio assembly over the shared analytical core — the same
// read usePortfolio performs in the app (listBasketsForChain → getUserHoldings
// → holdings → computeExposure), shaped into a JSON snapshot both the service
// worker and the popup consume. app/src/lib is CONSUMED here, never modified;
// exposure.ts and basket-data.ts are React-free at runtime, which is precisely
// what makes this file possible.
//
// Today the input is the BASKET path (held baskets, decomposed into net
// per-asset exposure). When the app's raw-holdings work lands, that arrives
// here as an additional DATA SOURCE feeding the same snapshot shape — a change
// to this file, not to the views.

import type { Address } from 'viem'
import { getUserHoldings, listBasketsForChain, type BasketSummary } from '@app/lib/spectrum/basket-data'
import { computeExposure } from '@app/lib/spectrum/exposure'
import type { PortfolioHolding } from '@app/lib/spectrum/hooks'
import { SUPPORTED_CHAIN_IDS } from '@app/lib/chain/chains'

export interface SnapshotContribution {
  basketSymbol: string
  basketAddress: string
  chainId: number
  /** USD of the wallet's basket value attributed to this asset. */
  valueUsd: number
}

export interface SnapshotAsset {
  /** `${chainId}:${lowercased address}` — the exposure aggregation key. */
  key: string
  address: string
  symbol: string
  chainId: number
  /** Share of the looked-through total (0–100). */
  pct: number
  valueUsd: number
  /** How many held baskets contribute to this asset. */
  basketCount: number
  /** Which held baskets drive this line, largest first (the drill the site's
   *  exposure cards offer). Optional: snapshots stored by older builds lack it. */
  contributions?: SnapshotContribution[]
}

export interface SnapshotHolding {
  chainId: number
  address: string
  symbol: string
  name: string
  balance: number
  valueUsd: number
  change24hPct: number | null
}

export interface SnapshotCreated {
  chainId: number
  address: string
  symbol: string
  name: string
  aumUsd: number
  change24hPct: number | null
}

export interface PortfolioSnapshot {
  v: 1
  /** Epoch ms of the read — the freshness stamp. Cached data is presented as
   *  cached everywhere; a stale number shown as live is the one dishonesty
   *  this product forbids. */
  at: number
  address: string
  totalUsd: number
  /** Held-basket value-weighted 24h change (%), computed over the baskets that
   *  carry a 24h figure; null when none do. */
  change24hPct: number | null
  /** Held baskets excluded from the 24h figure (no 24h data) — surfaced, not
   *  hidden. */
  change24hExcluded: number
  heldCount: number
  createdCount: number
  /** Net per-asset exposure (target basis), largest first. */
  assets: SnapshotAsset[]
  held: SnapshotHolding[]
  created: SnapshotCreated[]
  /** Chains scanned this read. */
  chainIds: number[]
  /** Chains whose basket list could not be read — their holdings are MISSING
   *  from every figure above, and the UI must say so rather than render zeros. */
  chainsFailed: number[]
}

/** Value-weighted 24h change over holdings that carry one. */
export function aggregate24h(held: { valueUsd: number; change24hPct: number | null }[]): {
  pct: number | null
  excluded: number
} {
  let nowSum = 0
  let prevSum = 0
  let excluded = 0
  for (const h of held) {
    const c = h.change24hPct
    if (c == null || !isFinite(c) || c <= -100) {
      excluded += 1
      continue
    }
    nowSum += h.valueUsd
    prevSum += h.valueUsd / (1 + c / 100)
  }
  if (prevSum <= 0) return { pct: null, excluded }
  return { pct: ((nowSum - prevSum) / prevSum) * 100, excluded }
}

/**
 * One full read: every configured chain's basket list (each chain failing
 * independently and REPORTED, never zeroed), the wallet's balances, the
 * look-through exposure. Throws only when every chain failed — the caller
 * treats that as a failed poll and backs off.
 */
export async function readPortfolio(address: string): Promise<PortfolioSnapshot> {
  const chainIds = [...SUPPORTED_CHAIN_IDS]
  const chainsFailed: number[] = []

  const perChain = await Promise.all(
    chainIds.map(async (id) => {
      try {
        return await listBasketsForChain(id)
      } catch {
        chainsFailed.push(id)
        return [] as BasketSummary[]
      }
    }),
  )
  if (chainsFailed.length === chainIds.length) {
    throw new Error('every chain read failed')
  }

  const all = perChain.flat()
  const balances = await getUserHoldings(address as Address, all)

  const holdings: PortfolioHolding[] = all
    .map((basket) => {
      const balance = balances.get(basket.address.toLowerCase()) ?? 0
      return { basket, balance, valueUsd: balance * basket.navPerToken }
    })
    .filter((h) => h.balance > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd)

  const addr = address.toLowerCase()
  const created = all.filter((b) => b.deployer?.toLowerCase() === addr && !b.supersededBy)

  const exposure = computeExposure(holdings)
  const totalUsd = holdings.reduce((s, h) => s + h.valueUsd, 0)
  const held = holdings.map((h) => ({
    chainId: h.basket.chainId,
    address: h.basket.address,
    symbol: h.basket.symbol,
    name: h.basket.name,
    balance: h.balance,
    valueUsd: h.valueUsd,
    change24hPct: h.basket.change24hPct,
  }))
  const day = aggregate24h(held)

  return {
    v: 1,
    at: Date.now(),
    address,
    totalUsd,
    change24hPct: day.pct,
    change24hExcluded: day.excluded,
    heldCount: holdings.length,
    createdCount: created.length,
    assets: exposure.assets.map((a) => ({
      key: a.key,
      address: a.address,
      symbol: a.symbol,
      chainId: a.chainId,
      pct: a.pct,
      valueUsd: a.valueUsd,
      basketCount: a.basketCount,
      contributions: a.contributions.map((c) => ({
        basketSymbol: c.basketSymbol,
        basketAddress: c.basketAddress,
        chainId: c.chainId,
        valueUsd: c.valueUsd,
      })),
    })),
    held,
    created: created.map((b) => ({
      chainId: b.chainId,
      address: b.address,
      symbol: b.symbol,
      name: b.name,
      aumUsd: b.aumUsd,
      change24hPct: b.change24hPct,
    })),
    chainIds,
    chainsFailed,
  }
}

// ── drift ────────────────────────────────────────────────────────────────────
// Drift is the product thesis in one number: how far what you HOLD sits from
// what you SAID you wanted. Purely factual — a restatement of the user's own
// target against the current weights. No ranking, no recommendation.

export interface AssetDrift {
  key: string
  symbol: string
  targetPct: number
  currentPct: number
  /** currentPct − targetPct, in percentage points. */
  deltaPts: number
}

export interface DriftReport {
  perAsset: AssetDrift[]
  /** Σ|delta| / 2 — the share of the portfolio that sits away from target. */
  aggregatePts: number | null
  /** Exposure assets with no target set (not counted). */
  untargeted: number
}

export function computeDrift(
  assets: Pick<SnapshotAsset, 'key' | 'symbol' | 'pct'>[],
  targets: Record<string, number>,
): DriftReport {
  const perAsset: AssetDrift[] = []
  let untargeted = 0
  let sumAbs = 0
  const seen = new Set<string>()
  for (const a of assets) {
    const t = targets[a.key]
    seen.add(a.key)
    if (!Number.isFinite(t)) {
      untargeted += 1
      continue
    }
    const deltaPts = a.pct - (t as number)
    perAsset.push({ key: a.key, symbol: a.symbol, targetPct: t as number, currentPct: a.pct, deltaPts })
    sumAbs += Math.abs(deltaPts)
  }
  // A targeted asset the wallet no longer holds is 100% drifted from its
  // target's point of view: count it (current 0) rather than losing it.
  for (const [key, t] of Object.entries(targets)) {
    if (seen.has(key) || !Number.isFinite(t) || t <= 0) continue
    const addr = key.slice(key.indexOf(':') + 1)
    perAsset.push({ key, symbol: `${addr.slice(0, 6)}…`, targetPct: t, currentPct: 0, deltaPts: -t })
    sumAbs += t
  }
  const targeted = perAsset.length
  return {
    perAsset: perAsset.sort((a, b) => Math.abs(b.deltaPts) - Math.abs(a.deltaPts)),
    aggregatePts: targeted > 0 ? sumAbs / 2 : null,
    untargeted,
  }
}
