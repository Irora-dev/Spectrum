// Cross-chain BUNDLE — a pure frontend construct (owner 2026-07-08). A bundle is
// a weighted set of single-chain baskets (legs) presented as one cross-chain
// allocation. It is NOT a contract and NOT one token: a follower replicates it by
// buying each leg on its own chain (disclosed explicitly in the UI). This module
// is the pure, URL-serialisable core — no React/DOM — so it's unit-tested.
//
// URL form (short + URL-safe; 0x addresses contain no `-`/`_`):
//   /bundle?b=<chainId>-<addr>-<weight>_<chainId>-<addr>-<weight>…&by=<creator>&n=<name>
// `by` is the creator/KOL (drives attribution + the referral tag on each leg buy);
// `n` is an optional display name. Weights are relative — normalised for display.

/** A bento of baskets stays legible up to a handful of legs. */
export const MAX_BUNDLE_LEGS = 6

const isAddr = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s)

export interface BundleLeg {
  chainId: number
  address: string
  /** Relative weight (any positive scale); normalised for display/splits. */
  weight: number
}

export interface Bundle {
  legs: BundleLeg[]
  /** Creator/KOL address, or null. */
  by: string | null
  /** Optional display name. */
  name: string | null
}

export interface NormalizedLeg extends BundleLeg {
  /** Weight as a percentage of the bundle (sums to ~100 across legs). */
  pct: number
}

/** Build the query params for a bundle link (drops invalid/zero legs, caps count). */
export function encodeBundleParams(b: Bundle): URLSearchParams {
  const p = new URLSearchParams()
  const legs = b.legs.filter((l) => isAddr(l.address) && l.chainId > 0 && l.weight > 0).slice(0, MAX_BUNDLE_LEGS)
  if (legs.length) {
    p.set('b', legs.map((l) => `${l.chainId}-${l.address}-${Math.round(l.weight)}`).join('_'))
  }
  if (b.by && isAddr(b.by)) p.set('by', b.by)
  if (b.name && b.name.trim()) p.set('n', b.name.trim().slice(0, 48))
  return p
}

/** Parse a bundle from a URL query string; invalid legs are dropped, not thrown. */
export function decodeBundle(search: string): Bundle {
  const p = new URLSearchParams(search)
  const legs: BundleLeg[] = []
  for (const seg of (p.get('b') ?? '').split('_')) {
    if (legs.length >= MAX_BUNDLE_LEGS) break
    const [chainStr, address, wStr] = seg.split('-')
    const chainId = Number(chainStr)
    const weight = Number(wStr)
    if (
      Number.isInteger(chainId) &&
      chainId > 0 &&
      address &&
      isAddr(address) &&
      Number.isFinite(weight) &&
      weight > 0 &&
      !legs.some((l) => l.chainId === chainId && l.address.toLowerCase() === address.toLowerCase())
    ) {
      legs.push({ chainId, address, weight })
    }
  }
  const by = p.get('by')
  const name = p.get('n')
  return { legs, by: by && isAddr(by) ? by : null, name: name ? name.trim().slice(0, 48) : null }
}

/** Legs with weights normalised to percentages summing to ~100. */
export function normalizedLegs(legs: BundleLeg[]): NormalizedLeg[] {
  const total = legs.reduce((s, l) => s + Math.max(l.weight, 0), 0)
  return legs.map((l) => ({ ...l, pct: total > 0 ? (Math.max(l.weight, 0) / total) * 100 : 0 }))
}

/** Per-leg USD for a total budget, split by normalised weight (aligned with `legs`). */
export function splitBudget(legs: BundleLeg[], budgetUsd: number): number[] {
  const b = Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : 0
  return normalizedLegs(legs).map((l) => (l.pct / 100) * b)
}

/** Distinct chains the bundle spans, in first-seen order. */
export function bundleChains(legs: BundleLeg[]): number[] {
  const seen: number[] = []
  for (const l of legs) if (!seen.includes(l.chainId)) seen.push(l.chainId)
  return seen
}
