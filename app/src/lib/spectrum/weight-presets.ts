import { CAP, MAX_ASSETS, MIN, equalSplit } from './weights'

// ─────────────────────────────────────────────────────────────────────────────
// WEIGHT PRESETS — "Even it out", and now two more, both one click (the owner
// 2026-08-13, in the greenlit list).
//
// The numbers already exist: the picker's TokenHit carries `marketCapUsd` and
// `liquidityUsd` for every asset it offers. This module only turns them into a
// weight vector obeying the SAME laws the manual dials obey (weights.ts): whole
// numbers, Σ = CAP exactly, nothing below MIN, at most MAX_ASSETS.
//
// THE HONESTY RULE HERE IS `null`. A preset whose metric nobody could read must
// NOT quietly hand back an even split — it would be an even split wearing the
// label "by market cap", which is a lie about how the basket was built. No
// usable numbers = no preset = the button says why it cannot run.
//
// A PARTIAL answer is different from no answer, and is reported rather than
// hidden: an asset whose metric is 0/unknown lands at the floor and its index
// comes back in `unknown`, so the surface can name those assets instead of
// letting a creator think the machine had an opinion about them.
// ─────────────────────────────────────────────────────────────────────────────

export type PresetKind = 'even' | 'market-cap' | 'liquidity'

/** What a preset needs from one picked asset — the picker's own hit fields. */
export interface PresetAsset {
  marketCapUsd?: number | null
  liquidityUsd?: number | null
}

export interface PresetResult {
  /** Whole-number weights, Σ = CAP, every entry ≥ MIN. */
  weights: number[]
  /** Indices whose metric was missing or zero: they sit at the floor because
   *  nothing was known about them, NOT because they were judged small. */
  unknown: number[]
}

export const PRESET_LABEL: Record<PresetKind, string> = {
  even: 'Even it out',
  'market-cap': 'By market cap',
  liquidity: 'By liquidity',
}

export const PRESET_WHY: Record<PresetKind, string> = {
  even: 'every asset the same size',
  'market-cap': 'bigger coins carry more of the basket',
  liquidity: 'weight follows what can actually be traded',
}

const metricOf = (kind: PresetKind, a: PresetAsset): number => {
  const raw = kind === 'liquidity' ? a.liquidityUsd : a.marketCapUsd
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * Split CAP proportionally to `values`, as whole numbers, with every entry at
 * or above MIN.
 *
 * Largest-remainder over the budget ABOVE the floor: each asset is first given
 * MIN, and only what is left is shared out in proportion. That is what keeps
 * both laws true at once — a tiny asset cannot be rounded to 0, and the total
 * cannot drift off CAP, which is the failure the manual dials were hardened
 * against (weights.ts's Σ-exactness).
 */
export function proportionalWeights(values: readonly number[]): number[] | null {
  const n = values.length
  if (n === 0 || n > MAX_ASSETS) return null
  // With a floor of MIN each, more than CAP/MIN assets cannot be weighted at
  // all — arithmetic, not taste.
  if (n * MIN > CAP) return null
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const total = clean.reduce((s, v) => s + v, 0)
  if (total <= 0) return null // nothing to weigh BY — say so, never fake it

  const budget = CAP - MIN * n
  const exact = clean.map((v) => (v / total) * budget)
  const out = exact.map((v) => Math.floor(v))
  const short = budget - out.reduce((s, v) => s + v, 0)
  // Ties go to the earlier asset, so the same picks always produce the same
  // basket — a preset that shuffled under the creator would be its own bug.
  const byRemainder = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (let k = 0; k < short; k++) out[byRemainder[k % n].i] += 1
  return out.map((v) => v + MIN)
}

/** One preset, or null when it cannot run honestly. */
export function presetWeights(kind: PresetKind, assets: readonly PresetAsset[]): PresetResult | null {
  const n = assets.length
  if (n === 0 || n > MAX_ASSETS) return null
  if (kind === 'even') {
    const weights = equalSplit(n)
    // equalSplit can only go below the floor past CAP/MIN assets, which
    // MAX_ASSETS already forbids — asserted rather than assumed.
    return weights.every((w) => w >= MIN) ? { weights, unknown: [] } : null
  }
  const values = assets.map((a) => metricOf(kind, a))
  const weights = proportionalWeights(values)
  if (!weights) return null
  return { weights, unknown: values.map((v, i) => (v > 0 ? -1 : i)).filter((i) => i >= 0) }
}

/** Whether a preset can run at all — for a button that must not be a dead one. */
export function presetAvailable(kind: PresetKind, assets: readonly PresetAsset[]): boolean {
  return presetWeights(kind, assets) != null
}
