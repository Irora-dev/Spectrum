import type { BasketSummary } from '../../lib/spectrum/basket-data'
import type { Thesis } from '../../lib/spectrum/thesis'
import type { BundleGroup, PublishLane } from './publish-bundle-model'
import type { ReshapeDraft, ThesisReshapeLane } from './reshape-types'

// ─────────────────────────────────────────────────────────────────────────────
// THE SEED PLAN — the pure model behind the ceremonies' "Seed the bundle" door
// (owner 2026-08-12: after a publish or reshape each new version starts EMPTY;
// the first buy opens it, and the creator seeds the whole bundle straight from
// the success plate through the existing run overlay). No React, no chain, no
// storage — the thesis-reshape-model extraction pattern, again.
//
// THE ONE LAW THIS MODULE ENFORCES: only a lane that LANDED and whose new
// address was READ BACK may seed. A confirmed-but-unread lane (newAddress
// null, ADDRESS_UNREAD_NOTE) is a live basket nobody here can point money at —
// it is EXCLUDED and named, so the door can say it out loud instead of
// silently seeding a shorter bundle. Zero seedable lanes = no plan legs = the
// door does not render (never a dead button).
//
// SHARES ARE THE DEPLOY WEIGHTS, NOT LIVE AUM. thesisNeeds refuses a zero-AUM
// bundle by law (dividing evenly would invent intent); the ceremony holds the
// creator's own shipped split, and these functions derive each NETWORK's share
// of the whole bundle from it (one basket per network — the network share is
// the whole story):
//   · publish — the Composer's mixSharePct: the creator's one mix, grouped by
//     network, IS the cross-network allocation.
//   · reshape — each network's final-draft weight sum over the union total.
//     A reshape carries no cross-network preference (every draft renormalizes
//     to Σ=100 within its own basket), so the derived shares come out equal
//     across the shipped networks — stated here so nobody mistakes the
//     computation for a hidden signal. Computing it from the weights (rather
//     than hardcoding 1/N) keeps the derivation honest if the weight law ever
//     changes.
// thesisNeeds normalizes by the total, so shares here are any positive unit.
// ─────────────────────────────────────────────────────────────────────────────

/** One seedable leg of the just-shipped bundle. */
export interface SeedLeg {
  chainId: number
  /** The basket the seed run buys — the lane's read-back new address (real),
   *  or the predecessor in a walkthrough (nothing arms in demo). */
  address: `0x${string}`
  symbol: string
  /** This network's share of the whole bundle, any positive unit —
   *  thesisNeeds normalizes. */
  share: number
}

export interface SeedPlan {
  legs: SeedLeg[]
  /** Chains whose deploy landed but whose address could not be read back —
   *  stated on the door, never seeded. */
  excluded: number[]
}

/** The publish ceremony's plan: landed lanes with a read-back address seed,
 *  each at its network's share of the Composer mix. */
export function publishSeedPlan(
  lanes: readonly PublishLane[],
  tickers: Readonly<Record<number, string>>,
  groups: readonly Pick<BundleGroup, 'chainId' | 'mixSharePct'>[],
): SeedPlan {
  const legs: SeedLeg[] = []
  const excluded: number[] = []
  for (const lane of lanes) {
    if (lane.state !== 'done') continue
    if (lane.newAddress == null) {
      excluded.push(lane.chainId)
      continue
    }
    legs.push({
      chainId: lane.chainId,
      address: lane.newAddress,
      symbol: tickers[lane.chainId] ?? '',
      share: groups.find((g) => g.chainId === lane.chainId)?.mixSharePct ?? 0,
    })
  }
  return { legs, excluded }
}

/** The reshape ceremony's plan. Real: done lanes with a read-back new address
 *  seed over it. Demo: done lanes seed over their PREDECESSORS — the
 *  walkthrough needs legs to walk, and the run machine's own demo path never
 *  arms (buildThesisBuyRun demo:true; the overlay offers no executor). Skipped
 *  lanes kept their current version — they neither seed nor exclude. */
export function reshapeSeedPlan(
  lanes: readonly ThesisReshapeLane[],
  drafts: Readonly<Record<number, ReshapeDraft>>,
  demo: boolean,
): SeedPlan {
  const shipped = lanes.filter((l) => l.state === 'done')
  const shareOf = (chainId: number): number =>
    (drafts[chainId]?.weights ?? []).reduce((s, w) => s + (Number.isFinite(w) && w > 0 ? w : 0), 0)
  const legs: SeedLeg[] = []
  const excluded: number[] = []
  for (const lane of shipped) {
    const address = demo ? lane.predecessor : lane.newAddress
    if (address == null) {
      excluded.push(lane.chainId)
      continue
    }
    legs.push({
      chainId: lane.chainId,
      address,
      symbol: drafts[lane.chainId]?.symbol ?? '',
      share: shareOf(lane.chainId),
    })
  }
  return { legs, excluded }
}

/** Dress a seed plan as the run overlay's own input: a zero-AUM Thesis over
 *  the shipped legs plus the explicit share map thesisNeeds splits by. The
 *  summaries claim NOTHING a fresh basket does not have — zero AUM, no NAV, no
 *  series — because the overlay's live executors read the real basket from
 *  chain per leg; these rows only name the lanes. null when nothing seeds. */
export function seedThesisOf(
  plan: SeedPlan,
  name: string,
  deployer: string,
): { thesis: Thesis; seedShares: ReadonlyMap<number, number> } | null {
  if (plan.legs.length === 0) return null
  const who = deployer.toLowerCase()
  const legs: BasketSummary[] = plan.legs.map((l) => ({
    chainId: l.chainId,
    address: l.address,
    name,
    symbol: l.symbol,
    basketLength: 0,
    navPerToken: 0,
    aumUsd: 0,
    change24hPct: null,
    pricedCount: 0,
    top: [],
    navSeries: [],
    deployer: who,
  }))
  return {
    thesis: {
      deployer: who,
      name,
      legs,
      chainIds: plan.legs.map((l) => l.chainId),
      totalAumUsd: 0,
    },
    seedShares: new Map(plan.legs.map((l) => [l.chainId, l.share])),
  }
}
