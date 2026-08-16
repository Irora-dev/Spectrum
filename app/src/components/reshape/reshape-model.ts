import { getAddress, isAddress } from 'viem'
import {
  addAsset as addWeightSlot,
  adjustWeight,
  CAP,
  equalSplit,
  MAX_ASSETS,
  removeAsset as removeWeightAt,
  setWeight,
  STEP,
  sum,
} from '../../lib/spectrum/weights'
import { isDemoLegAddress } from '../../lib/spectrum/thesis-run-types'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import type { BasketData, Holding } from '../../lib/spectrum/basket-data'
import type { DeployInput } from '../../lib/spectrum/use-deploy'
import type { ReshapeDraft, ReshapeLeg, VersionSeedResult } from './reshape-types'

// ─────────────────────────────────────────────────────────────────────────────
// THE RESHAPE MODEL — every pure decision the reshape popup makes, in one
// tested module. The components render; this file decides. Three families:
//
//   · draft mutations — EVERY weight change goes through weights.ts ops
//     (MIN 5 · STEP 5 · ≤20 · Σ=100, borrow-from-largest), so a draft is
//     deployable by construction at all times (the contract's weight law).
//   · adapters — draft → DeployInput (useDeployBasket's shape; weights stay
//     whole percent, toBasketEntries owns the ×100 bps conversion) and
//     draft → BasketData (the shape computeBasketDiff reads: holdings[]
//     .targetWeightPct), so the review diff and the deploy args can never
//     disagree about what the draft says.
//   · the add-asset pipeline — BasketBuilder.add()'s validation order
//     (BasketBuilder.tsx:1123, the reference), extracted with injectable
//     effects so the refusals are hard-tested without an RPC in sight.
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const

// ── draft mutations (all through weights.ts — the deployable law) ────────────

/** Nudge leg `i` by `delta` percentage points (the list view's −/+ steppers). */
export function adjustDraftWeight(draft: ReshapeDraft, i: number, delta: number): ReshapeDraft {
  return { ...draft, weights: adjustWeight(draft.weights, i, delta) }
}

/** Set leg `i` to a raw percentage (the dial's TrimBar emits continuous
 *  values) — SNAPPED to the builder's STEP first, then rebalanced by
 *  setWeight so Σ re-lands on exactly CAP. */
export function setDraftWeightPct(draft: ReshapeDraft, i: number, rawPct: number): ReshapeDraft {
  const snapped = Math.round(rawPct / STEP) * STEP
  return { ...draft, weights: setWeight(draft.weights, i, snapped) }
}

/** Remove leg `i`; its weight hands back to the largest remaining. */
export function removeDraftLeg(draft: ReshapeDraft, i: number): ReshapeDraft {
  return {
    ...draft,
    legs: draft.legs.filter((_, k) => k !== i),
    weights: removeWeightAt(draft.weights, i),
  }
}

/** Append an already-validated leg at MIN weight (borrowed from the largest).
 *  Callers reach this ONLY through validateAddAsset's ok verdict. */
export function appendResolvedLeg(draft: ReshapeDraft, leg: ReshapeLeg): ReshapeDraft {
  if (draft.legs.length >= MAX_ASSETS) return draft
  return {
    ...draft,
    legs: [...draft.legs, leg],
    weights: draft.weights.length === 0 ? [CAP] : addWeightSlot(draft.weights),
  }
}

/** Even split across the current legs (the builder's "Even it out"). */
export function equalizeDraft(draft: ReshapeDraft): ReshapeDraft {
  return { ...draft, weights: equalSplit(draft.legs.length) }
}

/** The builder's own ticker clamp (BasketBuilder.tsx:2053): uppercase
 *  alphanumeric, 11 chars. */
export function clampSymbolInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 11)
}

/** A draft the ship stage will accept: identity present, 1–20 legs, weights
 *  index-aligned and exactly on the law. */
export function draftReadyToShip(draft: ReshapeDraft | null): draft is ReshapeDraft {
  if (!draft) return false
  if (!draft.name.trim() || !draft.symbol.trim()) return false
  if (draft.legs.length === 0 || draft.legs.length !== draft.weights.length) return false
  return sum(draft.weights) === CAP && draft.weights.every((w) => w > 0)
}

// ── the refusal law (thesis-run.ts:134's precedent, applied to a deploy) ─────

/** First line of the arm handler: REAL mode on a demo subject never arms.
 *  Returns the stated refusal, or null when shipping may proceed. */
export function demoSubjectRefusal(subject: string, demo: boolean): string | null {
  if (demo) return null
  if (!isDemoLegAddress(subject)) return null
  return 'This is a demo basket — it exists only in this preview, so there is nothing on-chain to supersede. A real deploy from here would mint a version of nothing. Open the reshape in demo mode to walk the ceremony.'
}

// ── the dropped-legs sentence (seed honesty, stated never silent) ────────────

/** The amber line over the shape stage: which of v1's legs the seed could not
 *  re-resolve today, and why. Null when nothing was dropped. */
export function droppedLine(dropped: VersionSeedResult['dropped']): string | null {
  if (dropped.length === 0) return null
  const listed = dropped.map((d) => `$${showSymbol(d.symbol)} (${d.reason})`).join(' · ')
  const n = dropped.length
  return `${n} of v1's legs cannot be re-resolved today and ${n === 1 ? 'is' : 'are'} not in this draft: ${listed}`
}

// ── adapters ─────────────────────────────────────────────────────────────────

/**
 * Draft → useDeployBasket's DeployInput. Weights stay WHOLE PERCENT — the
 * bps ×100 conversion belongs to toBasketEntries alone (converting here would
 * double it). Throws rather than shape a dishonest deploy: a caller that
 * reaches this with a broken draft has bypassed the stage gate.
 *
 * `launcher` is REQUIRED and overrides the carried feeConfig's: the contract
 * says the launcher field is re-derived at deploy, never carried from v1
 * (reshape-types.ts — carrying it would credit v1's origination context to a
 * deploy it did not originate).
 */
export function draftToDeployInput(draft: ReshapeDraft, opts: { launcher: `0x${string}` }): DeployInput {
  if (draft.legs.length === 0) throw new Error('An empty draft cannot deploy.')
  if (draft.legs.length !== draft.weights.length) {
    throw new Error(`legs/weights misaligned (${draft.legs.length} vs ${draft.weights.length}).`)
  }
  const total = sum(draft.weights)
  if (total !== CAP) throw new Error(`weights must sum to ${CAP}% (got ${total}%).`)
  return {
    name: draft.name.trim(),
    symbol: draft.symbol.trim(),
    assets: draft.legs.map((l) => ({ address: l.address, decimals: l.decimals, route: l.route })),
    weights: [...draft.weights],
    feeConfig: { ...draft.feeConfig, launcher: opts.launcher },
    // A reshape deploys WITHOUT a first deposit — the popup collects no money.
    // The first-mint window is therefore open on success, and the ship stage's
    // success plate says so out loud rather than leaving it to be discovered.
    seed: null,
  }
}

/**
 * Draft → the BasketData shape computeBasketDiff reads. Only `holdings[]`
 * (asset · symbol · targetWeightPct) carries meaning for the diff; every other
 * field is an honest zero/null so the object type-checks WITHOUT a cast that
 * could hide a future field the diff starts reading.
 */
export function draftToDiffSide(draft: ReshapeDraft, chainId: number, address?: string): BasketData {
  const holdings: Holding[] = draft.legs.map((l, i) => ({
    asset: l.address,
    symbol: l.symbol,
    name: l.name ?? l.symbol,
    decimals: l.decimals,
    targetWeightPct: draft.weights[i] ?? 0,
    balance: 0,
    priceUsd: 0,
    valueUsd: 0,
    liveWeightPct: draft.weights[i] ?? 0,
    change24hPct: null,
    priced: false,
    series: [],
  }))
  return {
    chainId,
    address: address ?? ZERO_ADDR,
    name: draft.name,
    symbol: draft.symbol,
    decimals: 18,
    totalSupply: 0,
    aumUsd: 0,
    navPerToken: 0,
    navSource: 'reconstructed',
    fullyPriced: false,
    navDivergencePct: null,
    change24hPct: null,
    holdings,
    navSeries: [],
    pricedCount: 0,
    totalCount: holdings.length,
    inceptionTs: null,
    ageHours: null,
    deployer: null,
    effectiveSupply: null,
    updatedAt: new Date(0).toISOString(),
  }
}

// ── the add-asset pipeline (BasketBuilder.add()'s order, effects injected) ───

/** What resolution must answer for a candidate leg (BuilderAsset's relevant
 *  slice — the live implementation is BasketBuilder's exported resolveAsset). */
export interface ResolvedLegInput {
  address: string
  symbol: string
  decimals: number
  route: ReshapeLeg['route']
  name?: string | null
}

export interface AddAssetEffects {
  /** token0() probe — true = a liquidity-pool token, refused. A thrown probe
   *  is treated as NOT a pool (the builder's fail-open on RPC blips). */
  isPoolToken(address: string, chainId: number): Promise<boolean>
  /** lineageFor — non-null = the address is a Spectrum basket, refused (F7,
   *  basket-as-leg). A FAILED READ IS NOT A VERDICT: throws are allowed
   *  through rather than blocking a legitimate token on an RPC hiccup. */
  basketLineage(chainId: number, address: string): Promise<unknown | null>
  /** findBestPool + symbol/decimals — throws (PoolDetectionError or other)
   *  when the asset cannot be validated on this chain. */
  resolve(address: string, chainId: number, knownSymbol?: string): Promise<ResolvedLegInput>
}

export type AddAssetVerdict = { ok: true; leg: ReshapeLeg } | { ok: false; reason: string }

/**
 * The builder's validation order, verbatim: isAddress → duplicate →
 * MAX_ASSETS → pool-token probe → basket-as-leg refusal → live resolution
 * (decimals + route from findBestPool's verdict, never copied from v1).
 * Refusals return stated reasons; only a fully-resolved leg comes back ok.
 */
export async function validateAddAsset(
  draft: ReshapeDraft,
  rawAddr: string,
  chainId: number,
  fx: AddAssetEffects,
  knownSymbol?: string,
): Promise<AddAssetVerdict> {
  const raw = rawAddr.trim()
  if (!isAddress(raw)) return { ok: false, reason: 'Enter a valid token contract address (0x…).' }
  if (draft.legs.some((l) => l.address.toLowerCase() === raw.toLowerCase())) {
    return { ok: false, reason: 'That asset is already in the basket.' }
  }
  if (draft.legs.length >= MAX_ASSETS) {
    return { ok: false, reason: `A basket holds up to ${MAX_ASSETS} assets.` }
  }
  if (await fx.isPoolToken(raw, chainId).catch(() => false)) {
    return {
      ok: false,
      reason:
        'That address is a liquidity-pool token (e.g. an Aerodrome LP), not the asset itself — paste the underlying token’s contract address instead.',
    }
  }
  // F7 — a basket can't be a leg of another basket: it would be priced through
  // a thin unrelated pool rather than by what it actually holds.
  const lineage = await fx.basketLineage(chainId, raw).catch(() => null)
  if (lineage) {
    return {
      ok: false,
      reason:
        'That address is a Spectrum basket, not a plain asset. A basket can’t be a leg of another basket: it would be priced through a thin unrelated pool rather than by what it actually holds, so buyers would get a wrong price. Add the underlying assets instead.',
    }
  }
  try {
    const a = await fx.resolve(raw, chainId, knownSymbol)
    return {
      ok: true,
      leg: {
        address: getAddress(a.address) as `0x${string}`,
        symbol: a.symbol,
        name: a.name ?? null,
        decimals: a.decimals,
        route: a.route,
      },
    }
  } catch (e) {
    // PoolDetectionError carries its own honest sentence (no pool on this
    // chain, only-Aerodrome, screened-out token…); anything else gets the
    // builder's generic line. Matched by name — importing the class here
    // would drag the pool module graph into this pure file.
    const detection = e instanceof Error && e.name === 'PoolDetectionError'
    return {
      ok: false,
      reason: detection && e instanceof Error && e.message
        ? e.message
        : 'Could not validate this asset, check the address and the selected network.',
    }
  }
}
