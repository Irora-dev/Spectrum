import type { Address } from 'viem'
import type { SellStep, ThesisSellPlan } from './thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// THE SELL PLAN — the sell half of the thesis run (the owner 2026-08-09: "yes
// selling from v1 too"). Selling a thesis means selling the held amount of
// each leg on its own chain through the live protected-redeem path; proceeds
// land as each chain's settlement USDC. This module only decides WHAT to sell
// WHERE — pure and deterministic, no React, no chain reads, no clock — and the
// sequencer (thesis-run) executes what it returns.
//
// THE FRACTION IS PARTS-PER-MILLION, A CHOICE WITH A STATED ERROR BOUND.
// A raw token amount must never be float-multiplied: Number() of an 18dp
// balance silently rounds above 2^53, and a sell amount that is not the number
// the user asked for is a wrong trade. So the typed fraction is quantised ONCE
// to an integer numerator over 1_000_000n, and the amount is pure bigint math:
//
//     sellRaw = balanceRaw × ppm / 1_000_000n
//
// Bound: Math.round puts the quantised fraction within HALF A PPM (5e-7) of
// the typed one, and the integer division truncates under one raw unit
// (10^-18 of a token at 18dp). Round rather than floor because ordinary
// decimal fractions are not binary-exact — 0.29 × 1e6 is 289999.999…, and
// flooring would under-sell every such fraction by a ppm for no reason.
// fraction = 1 maps to 1_000_000/1_000_000, so SELL ALL is exact by
// construction: the full balanceRaw, no residue dust left in the wallet.
// ─────────────────────────────────────────────────────────────────────────────

const PPM = 1_000_000n

export interface ThesisSellInput {
  /** The thesis's legs (one basket per chain), in display order. */
  legs: { chainId: number; address: Address; decimals: number; navPerToken: number | null }[]
  /** The wallet's basket-token balances, raw, as read per chain. */
  held: { chainId: number; address: string; balanceRaw: bigint }[]
  /** Uniform share of each held leg to sell, in (0, 1]. 1 = sell everything. */
  fraction: number
  /** Bridge every chain's proceeds here afterwards; null = leave them where
   *  they land. */
  consolidateTo: number | null
}

/**
 * Build the sell plan, or null when there is nothing to sell — a plan with no
 * steps would render a runnable run that does nothing, so the caller gets null
 * and says "nothing to sell" instead.
 */
export function thesisSellPlan(input: ThesisSellInput): ThesisSellPlan | null {
  const ppm = fractionPpm(input.fraction)
  if (ppm == null) return null

  // Held balances keyed by (chain, lowercased address) — the only identity a
  // basket has. Casing differs between the registry read (legs, checksummed)
  // and a wallet read (held, often lowercased); a case-mismatched miss here
  // would silently sell none of a leg the user does hold.
  const balances = new Map<string, bigint>()
  for (const h of input.held) {
    const k = `${h.chainId}:${h.address.toLowerCase()}`
    // first read wins on a duplicate row: it is the same tokens read twice,
    // and summing a re-read would plan to sell more than the wallet holds
    if (!balances.has(k)) balances.set(k, h.balanceRaw)
  }

  const steps: SellStep[] = []
  const planned = new Set<string>()
  for (const leg of input.legs) {
    const k = `${leg.chainId}:${leg.address.toLowerCase()}`
    // one step per basket even if the caller repeats a leg — a duplicate step
    // would sign a second sell of a balance the first step already sold
    if (planned.has(k)) continue
    planned.add(k)

    const balance = balances.get(k)
    // a leg the wallet does not hold is not a step, and neither is a zero or
    // negative balance read — selling nothing is not a step
    if (balance == null || balance <= 0n) continue

    const sellRaw = (balance * ppm) / PPM
    // dust × a small fraction can quantise to zero raw units; omit — the
    // overlay explains dust from its own data
    if (sellRaw <= 0n) continue

    steps.push({
      chainId: leg.chainId,
      address: leg.address,
      sellRaw,
      estCents: estimateCents(sellRaw, leg.decimals, leg.navPerToken),
    })
  }

  if (steps.length === 0) return null

  return { steps, consolidate: resolveConsolidate(input.consolidateTo, steps) }
}

/** The fraction as an integer ppm numerator, or null when it is not one.
 *  REFUSES rather than clamps — NaN, zero, negative, >1 or non-finite is a
 *  wrong trade, and clamping would sell an amount the user never asked for. */
function fractionPpm(fraction: number): bigint | null {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return null
  const ppm = Math.round(fraction * 1e6)
  // below half a ppm the fraction quantises to selling nothing at all — that
  // is "nothing to sell", not a plan of zero-amount steps
  if (ppm <= 0) return null
  return BigInt(ppm)
}

/** Display-only estimate of what a step realises, floored to cents. Floats are
 *  acceptable HERE and only here — nothing signs this number; the live sell
 *  path floors for real at execution. The law it does keep: an unpriceable leg
 *  reads as null, never $0 — a zero standing in for could-not-price is a
 *  defect. 0 means "priced, under a cent". */
function estimateCents(sellRaw: bigint, decimals: number, navPerToken: number | null): number | null {
  if (navPerToken == null || !Number.isFinite(navPerToken) || navPerToken <= 0) return null
  const cents = Math.floor((Number(sellRaw) / 10 ** decimals) * navPerToken * 100)
  // also catches hostile decimals (NaN/negative) turning the estimate into
  // NaN/Infinity — an unreadable estimate is unknown, not a number
  return Number.isFinite(cents) ? cents : null
}

/** Post-sell consolidation. Bridging INTO a chain the run did not sell on is
 *  legitimate — it is the user's home chain. Bridging a single chain's
 *  proceeds to itself is a fee for nothing, so a self-target degrades to null:
 *  the proceeds are already home. */
function resolveConsolidate(toChainId: number | null, steps: SellStep[]): ThesisSellPlan['consolidate'] {
  if (toChainId == null) return null
  // a value that cannot name a chain cannot name a bridge destination; the
  // stated safe default is proceeds staying where they land
  if (!Number.isInteger(toChainId) || toChainId <= 0) return null
  const chains = new Set(steps.map((s) => s.chainId))
  if (chains.size === 1 && chains.has(toChainId)) return null
  return { toChainId }
}
