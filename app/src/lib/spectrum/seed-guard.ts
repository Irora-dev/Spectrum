// ─────────────────────────────────────────────────────────────────────────────
// SEED GUARD (contracts' ask, desk 36, from their RefusalGriefing suite 6/6):
// a basket seeded against a negligible-depth leg pool WRECKS ITS OWN VALUATION
// at the first mint — their measured case: a 40/40/20 basket whose first leg
// sat in a pool ~a millionth its siblings' depth derived a 9996/2/1 funding
// split straight out of its own bootstrap, because the leg buy was thousands
// of times the pool's depth and filled at a catastrophic average price. The
// cost falls on the bootstrapper; the remedy is BEFORE the mint, here.
//
// Pure arithmetic on data the seeding surfaces already fetch (each leg's
// deepest-pool depth rides resolution as depthUsd). Same verdict language as
// split-guard: refuse-grade blocks, warn-grade warns, unreadable is SAID.
//
// Thresholds, honestly held: contracts measured 1/100th depth behaving fine
// and a millionth catastrophic, and offered to measure the curve between.
// Until that lands: a leg buy above 10% of its pool's depth WARNS (the house
// DEPTH_MAX_TRADE_SHARE_PCT posture — the buy moves the price it fills at),
// and a leg buy EXCEEDING the pool's whole depth blocks (past 100% the fill
// price is not a price; their wreck case was thousands of times over).
// Calibration note filed with contracts; constants are exports so the curve,
// when measured, lands in one place.
//
// AUDIT ROUND (specallocator, 2026-08-04 — two findings on the wired module):
//  · AN UNREADABLE SEED AMOUNT READ AS CLEAN. A non-finite `seedUsd` was
//    `continue`d silently, so a leg whose seed dollars could not be computed
//    produced NO verdict — the read-failed law inverted on the exact surface
//    that exists to refuse. Unreadable is now a SAID warn, like unreadable
//    depth beside it.
//  · THE BLOCK BOUNDARY EXCLUDED ITS OWN WORST CASE. `> 100%` meant a seed
//    exactly equal to the pool's whole depth WARNED instead of blocking, and
//    a seed exactly at the 10% floor said nothing at all. Both thresholds are
//    inclusive now, matching plan-legs' own `>= DEPTH_FLOOR_PCT` convention —
//    one comparison grammar across the depth surfaces.
// ─────────────────────────────────────────────────────────────────────────────

import type { LegVerdict } from './split-guard'
import { showSymbol } from './safe-copy'

export const SEED_DEPTH_WARN_PCT = 10
export const SEED_DEPTH_BLOCK_PCT = 100

export interface SeedLeg {
  symbol: string
  /** Settlement dollars this leg's seed buy will push into its pool. */
  seedUsd: number
  /** Deepest single pool for the leg, USD. Null = unreadable (NOT zero). */
  depthUsd: number | null
}

/** Verdicts for a proposed seed, one entry per leg that is not clean. */
export function seedGuard(legs: SeedLeg[]): LegVerdict[] {
  const out: LegVerdict[] = []
  for (const leg of legs) {
    const { symbol, seedUsd, depthUsd } = leg
    if (!Number.isFinite(seedUsd)) {
      // unreadable is SAID, never skipped (audit 2026-08-04)
      out.push({
        symbol,
        severity: 'warn',
        code: 'no-depth-data',
        reason: `We could not work out how much of ${showSymbol(symbol)} this seed would buy, so it cannot be checked against ${showSymbol(symbol)}'s market.`,
      })
      continue
    }
    if (seedUsd <= 0) continue // nothing seeded here is nothing to judge
    if (depthUsd == null || !Number.isFinite(depthUsd)) {
      out.push({
        symbol,
        severity: 'warn',
        code: 'no-depth-data',
        reason: `Could not read how deep ${showSymbol(symbol)}'s market is, so this seed cannot be checked against it.`,
      })
      continue
    }
    if (depthUsd <= 0) {
      out.push({
        symbol,
        severity: 'block',
        code: 'dust-pool',
        reason: `${showSymbol(symbol)} has no market to seed against, and the first mint would price the whole basket off that.`,
      })
      continue
    }
    const sharePct = (seedUsd / depthUsd) * 100
    if (sharePct >= SEED_DEPTH_BLOCK_PCT) {
      out.push({
        symbol,
        severity: 'block',
        code: 'depth',
        reason: `${showSymbol(symbol)}'s seed buy is ${sharePct >= 200 ? Math.round(sharePct / 100) + ' times' : 'the size of'} its whole market. The first mint would fill at a broken price and misprice the basket from birth.`,
      })
    } else if (sharePct >= SEED_DEPTH_WARN_PCT) {
      out.push({
        symbol,
        severity: 'warn',
        code: 'depth',
        reason: `${showSymbol(symbol)}'s seed buy is ${Math.round(sharePct)}% of its whole market, so the seed itself will move the price it fills at.`,
      })
    }
  }
  return out
}
