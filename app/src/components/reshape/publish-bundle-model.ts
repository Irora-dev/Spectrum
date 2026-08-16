import type { BasketRoute } from '../../lib/pools'
import { chainCfg } from '../../lib/chain/chains'
import { shortAddr } from '../../lib/spectrum/format'
import { seedWeightsFromPredecessor } from '../../lib/spectrum/version-seed'
import { CAP, equalSplit, isValid, MAX_ASSETS as BASKET_MAX_ASSETS, MIN } from '../../lib/spectrum/weights'
import { chainLabel } from '../thesis/run-lanes'

// ─────────────────────────────────────────────────────────────────────────────
// THE PUBLISH-BUNDLE MODEL — the pure machine behind PublishBundleModal (no
// React, no chain, no storage), the thesis-reshape-model extraction applied to
// a FRESH bundle: the Composer picked assets on more than one network, so
// publishing is one REAL deploy per network, strictly sequential, under one
// shared name (the thesis grouper keys on (deployer, name) — thesis.ts).
//
// THE CEREMONY IS THE RESHAPE'S MINUS TWO THINGS, BY CONSTRUCTION:
//   · no predecessors — these baskets are born here, nothing is superseded, so
//     there is no lineage signature and no landed-deploy/failed-signature
//     retry fork. Per lane: [switch → deploy], done.
//   · no skips — a network is in the bundle because the creator put assets
//     there; the Composer is where a network leaves the draft (remove its
//     assets), never a ceremony toggle.
//
// THE SPLIT LAW (compilePlan's own create:<chainId> reality, allocation.ts):
// one basket per network, and each network's weights renormalize to 100 within
// its own basket. The renormalization runs through version-seed's
// seedWeightsFromPredecessor — the ONE weights.ts-law projection (clamp to
// MIN, remainder onto the largest leg, Σ = CAP exactly) — not a second one.
//
// FAILURE IS SIMPLER THAN THE RESHAPE'S AND SAYS SO: a fresh deploy that
// failed left nothing behind (retry re-queues: reset + re-prepare), and a
// deploy that CONFIRMED but whose receipt hid the address is DONE — the basket
// is live, and retrying it would ship a duplicate at a second deploy price.
// That lane completes with ADDRESS_UNREAD_NOTE instead of a link.
// ─────────────────────────────────────────────────────────────────────────────

/** One picked asset of the bundle draft, chain-tagged (the Composer's pick). */
export interface BundleDraftAsset {
  chainId: number
  address: string
  symbol: string
  decimals: number
  route: BasketRoute
}

/** One network's slice of the draft — the basket it will deploy. */
export interface BundleGroup {
  chainId: number
  /** Indices into the draft's asset/weight arrays, in pick order. */
  indices: number[]
  assets: BundleDraftAsset[]
  /** This network's share of the whole mix, whole % of the Composer weights. */
  mixSharePct: number
  /** The basket's own deploy weights — Σ=100 under the weights.ts law,
   *  aligned with `assets`. What actually ships. */
  deployWeights: number[]
  /** The builder's own fresh-deploy gates, per network. */
  ready: boolean
  blocker: string | null
}

/** Bundle mode is a DERIVATION from the draft — the picks span >1 network —
 *  never a toggle someone can leave stale. */
export function isBundleDraft(assets: readonly { chainId: number }[]): boolean {
  const seen = new Set<number>()
  for (const a of assets) {
    seen.add(a.chainId)
    if (seen.size > 1) return true
  }
  return false
}

/** Distinct chains in pick order — the bundle's networks. */
export function bundleChainIds(assets: readonly { chainId: number }[]): number[] {
  const out: number[] = []
  for (const a of assets) if (!out.includes(a.chainId)) out.push(a.chainId)
  return out
}

/**
 * Group the draft per network and project each group's weights to its own
 * deployable basket. Composer weights are whole-% of the WHOLE mix (Σ=100
 * across every pick); within a group they renormalize to that group's own 100
 * through seedWeightsFromPredecessor — the same clamp-to-MIN /
 * remainder-onto-largest law every version draft already obeys.
 *
 * Readiness is the launch builder's own law for a fresh basket (≥2 assets,
 * ≤20, a valid Σ=100 vector) judged PER NETWORK — a network that fails states
 * why in plain words instead of disappearing from the plan.
 */
export function groupBundleDraft(
  assets: readonly BundleDraftAsset[],
  weights: readonly number[],
): BundleGroup[] {
  return bundleChainIds(assets).map((chainId) => {
    const indices = assets.reduce<number[]>((acc, a, i) => {
      if (a.chainId === chainId) acc.push(i)
      return acc
    }, [])
    const groupAssets = indices.map((i) => assets[i])
    const groupWeights = indices.map((i) => Math.max(0, weights[i] ?? 0))
    const groupSum = groupWeights.reduce((s, w) => s + w, 0)

    // The projection: each pick's share OF ITS GROUP, in percent, then the one
    // weights.ts-law rounding (MIN floor, remainder onto the largest, Σ=CAP).
    // A zero-mass group (unreachable through the Composer's min-1 weights) gets
    // an equal split rather than a division by zero.
    const deployWeights =
      groupSum > 0
        ? seedWeightsFromPredecessor(
            groupAssets,
            groupAssets.map((a, k) => ({ asset: a.address, targetWeightPct: (groupWeights[k] / groupSum) * CAP })),
          )
        : equalSplit(groupAssets.length)

    let blocker: string | null = null
    // ONE asset per network is contract-valid (SpectrumContracts verified
    // _validateBasket live 2026-08-15: len >= 1, weights sum to 100% — their
    // one-leg fixture SIMULATED DEPLOY OK on the gen-2 factories; the owner
    // ruled the FE floor relaxed the same hour). Zero still blocks.
    if (groupAssets.length < 1) {
      blocker = `${chainLabel(chainId)} has no assets — remove the network or add a pick there.`
    } else if (groupAssets.length > BASKET_MAX_ASSETS) {
      blocker = `A basket holds at most ${BASKET_MAX_ASSETS} assets — ${chainLabel(chainId)} has ${groupAssets.length}.`
    } else if (!isValid(deployWeights)) {
      // weights.ts's own refusal shape (Σ≠CAP / under-MIN) — unreachable from a
      // valid Composer mix, stated rather than shipped if a caller feeds one.
      blocker = `${chainLabel(chainId)}'s weights do not renormalize to a valid basket (each leg ≥${MIN}%, summing to ${CAP}%).`
    }

    return {
      chainId,
      indices,
      assets: groupAssets,
      mixSharePct: groupSum,
      deployWeights,
      ready: blocker == null,
      blocker,
    }
  })
}

// ── the ceremony's words ──────────────────────────────────────────────────────

/** The ship stage's interruption footer, word for word (the owner's contract).
 *  Two sentences, no em dash (the owner 2026-08-13: "center this text and remove em
 *  dash and make a little larger" — the centering and the type step live at the
 *  render site, PublishBundleModal's ship footer). */
export const PUBLISH_INTERRUPTION_NOTE =
  'If this closes mid-way, finished networks keep their baskets. The bundle recognises them the moment the rest ship.'

/** The grouping law, said in one line under the shared-name field. */
export const BUNDLE_NAME_LAW = 'one name is what makes them a bundle'

/** DEPLOY_ENABLED off — stated plainly, nothing offered (fresh creates have no
 *  demo lane to fall back to). */
export const DEPLOYS_DISABLED_NOTE =
  'Basket deploys are disabled on this build, so nothing can be published from here. Your bundle stays composed — nothing is lost.'

/** A deploy that CONFIRMED but whose receipt hid the new address: the basket
 *  is live and retrying would ship a paid duplicate, so the lane completes
 *  with this note instead of a link. */
export const ADDRESS_UNREAD_NOTE =
  'The deploy confirmed but the new address could not be read from the receipt — the basket is live; find it from your creator page before deploying again.'

// ── THE BUNDLE'S OTHER HALF OF ITS IDENTITY: ONE DEPLOYER ────────────────────

/**
 * A bundle IS the tuple (deployer, name) — thesis.ts's grouper keys on BOTH.
 * So a ceremony that deploys lane 1 from wallet A and lane 2 from wallet B does
 * not produce one bundle: it produces two fragments that will never group, each
 * leg carrying a different creator payout, and a creator page that shows half
 * of it. The run looks successful and the product is broken.
 *
 * (the owner 2026-08-13, from a live publish: "during the deploy of the bundle i
 * swapped wallet and was able to deploy only the base/rh leg from this new
 * wallet even tho another wallet i own was the creator, this messes up the flow
 * and shouldn't be possible.")
 *
 * THE ANCHOR IS THE WALLET THAT DEPLOYED THE FIRST LANDED LANE — the on-chain
 * fact, never an intention. Before any lane has landed nothing is committed and
 * any connected wallet may still become the creator, so switching then is free
 * and this refuses nothing. From the first landed basket onward it governs every
 * arm, every signature and every resume: the anchor rides with the landed lanes
 * in storage (landed-lanes.ts), because a reload plus a wallet switch is exactly
 * how this reappears.
 *
 * Returns the refusal sentence, or null when the connected wallet may proceed.
 */
export function deployerRefusal(
  anchor: string | null | undefined,
  connected: string | null | undefined,
): string | null {
  if (!anchor) return null // nothing has landed — there is no identity to break yet
  if (!connected) return null // no wallet at all: the connect CTA governs, not this
  if (anchor.toLowerCase() === connected.toLowerCase()) return null
  return `This bundle's first basket was deployed by ${shortAddr(anchor)}, but this wallet is ${shortAddr(connected)}. Reconnect ${shortAddr(anchor)} to finish the remaining networks, or close and start a new bundle.`
}

/** The set stage's honesty plate. n = the networks publishing. */
export function publishPlateWords(n: number): string {
  const networks = `${n} ${n === 1 ? 'network' : 'networks'}`
  const baskets = `${n} ${n === 1 ? 'basket' : 'baskets'}`
  return `This publishes ${baskets} — one per network, one at a time: a real deploy on each of ${networks}, each costing that network's own deploy price plus gas. Weights renormalize to 100% within each network's basket.`
}

// ── the lanes (the thesis-reshape machine minus lineage and skips) ────────────

export type PublishStepState = 'queued' | 'switch' | 'deploying' | 'done' | 'failed'

export interface PublishLane {
  chainId: number
  state: PublishStepState
  /** The deployed basket, parsed from the Launched event. May stay null on a
   *  DONE lane exactly when ADDRESS_UNREAD_NOTE applies. */
  newAddress: `0x${string}` | null
  note: string | null
}

/** Compose the ceremony's lanes, or refuse with a sentence. Refusals: no
 *  networks, a network that is not ready (compose re-checks what the set stage
 *  gates — belt and braces), and a duplicated chain (the grouper cannot emit
 *  one, so it is our bug, said plainly). */
export function composePublishLanes(
  groups: readonly Pick<BundleGroup, 'chainId' | 'ready' | 'blocker'>[],
): PublishLane[] | { refused: string } {
  if (groups.length === 0) return { refused: 'This bundle has no networks to publish.' }
  const seen = new Set<number>()
  for (const g of groups) {
    if (seen.has(g.chainId)) return { refused: `Chain ${g.chainId} appears twice in the plan — a bundle deploys one basket per network.` }
    seen.add(g.chainId)
    if (!g.ready) return { refused: g.blocker ?? `${chainLabel(g.chainId)} is not ready to publish.` }
  }
  return groups.map((g) => ({ chainId: g.chainId, state: 'queued' as const, newAddress: null, note: null }))
}

/** Compose lanes for a run that may RESUME an interrupted ceremony: chains in
 *  `alreadyLive` seed as done lanes — they deployed in the earlier run, and a
 *  re-deploy is a paid duplicate (the exact loss the interruption note
 *  promises against). Only the still-pending groups must pass the fresh-deploy
 *  gates, so a landed group edited since (now blocker-invalid) cannot dead-end
 *  a run that will skip it anyway. Every chain landed → every lane done, and
 *  the ceremony opens straight onto the finished plate. */
export function seedPublishLanes(
  groups: readonly Pick<BundleGroup, 'chainId' | 'ready' | 'blocker'>[],
  alreadyLive: readonly { chainId: number; newAddress: `0x${string}` | null }[],
): PublishLane[] | { refused: string } {
  const liveOf = (chainId: number) => alreadyLive.find((x) => x.chainId === chainId)
  const pending = groups.filter((g) => !liveOf(g.chainId))
  const composed: PublishLane[] | { refused: string } = pending.length === 0 ? [] : composePublishLanes(pending)
  if ('refused' in composed) return composed
  return groups.map((g) => {
    const hit = liveOf(g.chainId)
    if (hit) {
      return {
        chainId: g.chainId,
        state: 'done' as const,
        newAddress: hit.newAddress,
        note: hit.newAddress ? 'landed in the interrupted run' : ADDRESS_UNREAD_NOTE,
      }
    }
    return composed.find((l) => l.chainId === g.chainId)!
  })
}

/** The strictly-sequential cursor: the FIRST lane not done, or null when the
 *  ceremony is over. A 'failed' lane HOLDS the cursor — retry is the only
 *  exit, and the lanes after it stay queued (never started around). */
export function activePublishLane(lanes: readonly PublishLane[]): PublishLane | null {
  return lanes.find((l) => l.state !== 'done') ?? null
}

export interface PublishLanePatch {
  state?: PublishStepState
  newAddress?: `0x${string}` | null
  note?: string | null
}

/** Patch ONE lane — and only the lane the cursor is on (same reference on a
 *  refused/no-op call, the reshape reducers' idiom). Refusals:
 *  - a chainId not in the lanes, or any lane that is not the active one (a
 *    stale executor callback after a re-mount must change nothing);
 *  - 'done' lanes are records and never the cursor — folded into the check;
 *  - a state change on a 'failed' lane — retryPublishLane is the only exit (a
 *    failed lane may still ENRICH its note: learning more about a failure is
 *    not a transition). */
export function advancePublishLane(
  lanes: readonly PublishLane[],
  chainId: number,
  patch: PublishLanePatch,
): PublishLane[] {
  const lane = lanes.find((l) => l.chainId === chainId)
  if (!lane) return lanes as PublishLane[]
  const active = activePublishLane(lanes)
  if (!active || active.chainId !== chainId) return lanes as PublishLane[]
  if (lane.state === 'failed' && patch.state !== undefined && patch.state !== 'failed') return lanes as PublishLane[]

  const next: PublishLane = { ...lane }
  if (patch.state !== undefined) next.state = patch.state
  if ('newAddress' in patch) next.newAddress = patch.newAddress ?? null
  if ('note' in patch) next.note = patch.note ?? null
  if (next.state === lane.state && next.newAddress === lane.newAddress && next.note === lane.note)
    return lanes as PublishLane[]
  return lanes.map((l) => (l.chainId === chainId ? next : l))
}

/** The ONLY exit from 'failed'. A fresh deploy that failed left nothing behind
 *  (no predecessor, no half-signed lineage), so retry always re-queues — the
 *  executor re-prepares from scratch. Note cleared; a confirmed-but-unread
 *  deploy never lands in 'failed' (it is DONE, see ADDRESS_UNREAD_NOTE). */
export function retryPublishLane(lanes: readonly PublishLane[], chainId: number): PublishLane[] {
  const lane = lanes.find((l) => l.chainId === chainId)
  if (!lane || lane.state !== 'failed') return lanes as PublishLane[]
  return lanes.map((l) => (l.chainId === chainId ? { ...l, state: 'queued' as const, note: null } : l))
}

/** Progress over the lanes. finished = every lane done; a failed lane keeps
 *  the ceremony unfinished until retried or abandoned (the interruption note
 *  is the honest exit). */
export function publishProgress(lanes: readonly PublishLane[]): {
  done: number
  total: number
  failed: number
  finished: boolean
} {
  let done = 0
  let failed = 0
  for (const l of lanes) {
    if (l.state === 'done') done++
    else if (l.state === 'failed') failed++
  }
  return { done, total: lanes.length, failed, finished: lanes.length > 0 && done === lanes.length }
}

// ── the lane's two step marks (the reshape lane's StepMark grammar, minus
//    lineage — a fresh deploy has nothing to supersede) ───────────────────────

export type PublishMarkState = 'done' | 'active' | 'failed' | 'todo'
export interface PublishMark {
  key: 'switch' | 'deploy'
  label: string
  state: PublishMarkState
}

/** The [switch → deploy] marks, derived from the lane state alone. On 'failed'
 *  the deploy is what failed — the switch had been satisfied to get there. */
export function publishLaneMarks(lane: PublishLane): PublishMark[] {
  const marks = (a: PublishMarkState, b: PublishMarkState): PublishMark[] => [
    { key: 'switch', label: 'switch', state: a },
    { key: 'deploy', label: 'deploy', state: b },
  ]
  switch (lane.state) {
    case 'queued':
      return marks('todo', 'todo')
    case 'switch':
      return marks('active', 'todo')
    case 'deploying':
      return marks('done', 'active')
    case 'done':
      return marks('done', 'done')
    case 'failed':
      return marks('done', 'failed')
  }
}

/** One aria-live sentence per lane state (the ceremony reads transitions aloud). */
export function announcePublishLane(lane: PublishLane, chainName: string): string {
  switch (lane.state) {
    case 'switch':
      return `${chainName}: switch offered — switching signs nothing.`
    case 'deploying':
      return `${chainName}: deploying its basket.`
    case 'done':
      return `${chainName}: basket live.`
    case 'failed':
      return `${chainName}: needs a retry.`
    default:
      return `${chainName}: queued.`
  }
}

// ── per-network deploy readiness (the panel before the ceremony) ──────────────

/** use-deploy.ts prepare()'s own preflight headroom for the ~5.5M-gas deploy
 *  (its funds check: balance < priceWei + this ⇒ refuse before any signature).
 *  The panel mirrors that EXACT gate — one law, so "ready" here never bounces
 *  there — rather than re-deriving gas from a price feed of its own. */
export const DEPLOY_GAS_HEADROOM_WEI = 10_000_000_000_000_000n

const ethWords = (wei: bigint, gas: string) => `${(Number(wei) / 1e18).toFixed(4)} ${gas}`

/** The chain's gas-coin symbol from the operator's own book, never hardcoded
 *  (thesis-funding's chainWords posture — total, with a fallback). */
export function gasSymbol(chainId: number): string {
  try {
    return chainCfg(chainId).viemChain.nativeCurrency.symbol
  } catch {
    return 'gas'
  }
}

/** Every verdict carries the same facts twice: `words` is the sentence, `brief`
 *  is the SAME facts as a label — every figure kept, the teaching dropped
 *  (the owner 2026-08-13: "condense, use more width, remove text to make it fit the
 *  viewport"). The cards wear `brief` so three of them sit side by side; what
 *  `brief` drops — that the ≈figure is deploy price + gas — is stated once for
 *  the whole ceremony in the fact chips, never lost. */
export type DeployReadiness =
  | { kind: 'unknown-balance'; words: string; brief: string }
  | { kind: 'unknown-price'; words: string; brief: string }
  | { kind: 'short'; needWei: bigint; missingWei: bigint; words: string; brief: string }
  | { kind: 'ready'; needWei: bigint; words: string; brief: string }

/**
 * One network's verdict: the wallet's gas coin against what the deploy will
 * ask for (the live factory price plus prepare()'s gas headroom). NEVER
 * fabricated: an unreadable balance or price is stated as unknown, not scored.
 * `nativeRaw` comes from readThesisFunds (absent chain ⇒ null); `priceWei`
 * from useDeployPrice (null during the factory's post-launch cooldown, or when
 * the price simply could not be read).
 */
export function deployReadiness(chainId: number, nativeRaw: bigint | null, priceWei: bigint | null): DeployReadiness {
  const w = chainLabel(chainId)
  const gas = gasSymbol(chainId)
  if (nativeRaw == null) {
    // The PRICE is a public read and often known even when the wallet isn't
    // (not connected yet) — say the cost, keep readiness honest.
    const cost =
      priceWei != null ? `Deploys at ≈${ethWords(priceWei + DEPLOY_GAS_HEADROOM_WEI, gas)} (deploy price + gas). ` : ''
    return {
      kind: 'unknown-balance',
      words: `${cost}Couldn't read this wallet's ${gas} on ${w} — readiness unknown.`,
      brief:
        priceWei != null
          ? `≈${ethWords(priceWei + DEPLOY_GAS_HEADROOM_WEI, gas)} to deploy · balance unreadable`
          : `${gas} balance unreadable — readiness unknown`,
    }
  }
  if (priceWei == null) {
    return {
      kind: 'unknown-price',
      words: `${w}'s deploy price isn't readable right now (the slot may be between deploys) — holds ${ethWords(nativeRaw, gas)}; the exact cost shows at deploy time.`,
      brief: `Holds ${ethWords(nativeRaw, gas)} · deploy price unreadable, shown at deploy time`,
    }
  }
  const needWei = priceWei + DEPLOY_GAS_HEADROOM_WEI
  if (nativeRaw < needWei) {
    const missingWei = needWei - nativeRaw
    return {
      kind: 'short',
      needWei,
      missingWei,
      words: `Holds ${ethWords(nativeRaw, gas)} on ${w} — the deploy needs ≈${ethWords(needWei, gas)} (deploy price + gas), about ${ethWords(missingWei, gas)} more.`,
      brief: `Holds ${ethWords(nativeRaw, gas)} · needs ≈${ethWords(needWei, gas)} — ${ethWords(missingWei, gas)} short`,
    }
  }
  return {
    kind: 'ready',
    needWei,
    words: `Holds ${ethWords(nativeRaw, gas)} on ${w} — covers the ≈${ethWords(needWei, gas)} deploy price + gas.`,
    brief: `Holds ${ethWords(nativeRaw, gas)} · covers the ≈${ethWords(needWei, gas)} deploy`,
  }
}

// ── ONE FUNDING ACTION, AND ONE HONEST SENTENCE ABOUT ITS REACH ──────────────

/** One short network's two currencies. They are NOT the same token, which is
 *  the whole point of this section. */
export interface FundingTarget {
  chainId: number
  /** What the deploy signs in — the network's native coin, what it is short OF. */
  gasSymbol: string
  /** What the ceremony's funding door can actually DELIVER there (that chain's
   *  settlement asset), or null when that chain has none configured — in which
   *  case the door cannot move anything to it at all. */
  settlementSymbol: string | null
}

export type FundingPlan =
  | {
      kind: 'door'
      /** The network the door opens on: the first short one it can reach. */
      openChainId: number
      shortChainIds: number[]
      /** The main button's words. */
      label: string
      /** The line under it: what the door does, and what it does not. */
      note: string
    }
  | { kind: 'no-route'; shortChainIds: number[]; note: string }

const listWords = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/**
 * THE ACTION MOVES TO THE MAIN BUTTON, AND THE BUTTON TELLS THE TRUTH.
 *
 * the owner 2026-08-13: "this system has the deploy funds on the base bit but it
 * should just do the right fund movements via the main button not on each
 * individual basket area." So the diagnosis stays on each card and the door
 * moves to the ceremony's one primary CTA.
 *
 * The honesty this cost us: THE DOOR CANNOT DELIVER GAS. deployReadiness's
 * 'short' is ALWAYS a native-coin shortfall (it weighs the wallet's gas coin
 * against the deploy price plus prepare()'s gas headroom), and BridgeFund's
 * destination token is ALWAYS the destination chain's settlement asset — its
 * quote asks for `toToken: deploymentFor(dest).usdc`, never the native coin. So
 * the button opens a door that delivers the WRONG currency for the problem it
 * is named after, and saying "move funds, then publish" would promise a fix
 * this flow does not perform. It says what it will actually do instead, and
 * publishing stays reachable beside it: readiness is advisory here (the gate
 * that really refuses is use-deploy's own preflight), a balance read can be
 * stale, and a creator may be funding from somewhere we cannot see.
 *
 * Returns null when nothing is short.
 */
export function fundingPlan(shorts: readonly FundingTarget[]): FundingPlan | null {
  if (shorts.length === 0) return null
  const shortChainIds = shorts.map((s) => s.chainId)
  const open = shorts.find((s) => s.settlementSymbol != null)
  if (!open || open.settlementSymbol == null) {
    // Nowhere to send anything: every short network is one this app has no
    // settlement asset configured for. Stating that beats a button that opens
    // a door and immediately refuses inside itself.
    return {
      kind: 'no-route',
      shortChainIds,
      note: `${listWords(shortChainIds.map(chainLabel))} ${shortChainIds.length === 1 ? 'is' : 'are'} short for the deploy, and this app has no way to move funds there — top up that wallet yourself, or publish anyway and let the deploy refuse if it is still short.`,
    }
  }
  const others = shortChainIds.filter((id) => id !== open.chainId)
  const alsoWords = others.length > 0 ? ` ${listWords(others.map(chainLabel))} ${others.length === 1 ? 'is' : 'are'} short too.` : ''
  return {
    kind: 'door',
    openChainId: open.chainId,
    shortChainIds,
    label: `Move funds to ${chainLabel(open.chainId)} — sends ${open.settlementSymbol}, not ${open.gasSymbol} →`,
    note: `${chainLabel(open.chainId)} is short of ${open.gasSymbol}, which is what the deploy signs in. This door bridges ${open.settlementSymbol} to ${chainLabel(open.chainId)} — it cannot deliver ${open.gasSymbol}, so swap or send that yourself before this network can publish.${alsoWords}`,
  }
}

// ── ticker + name laws (the launch builder's own, single-sourced here for the
//    modal's per-network fields) ───────────────────────────────────────────────

/** BasketBuilder's own symbol law (its symbolValid gate). */
export const TICKER_RE = /^[A-Z0-9]{2,11}$/

export function cleanTicker(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11)
}

/** Every network seeds from the one ticker the creator typed (distinct chains
 *  cannot collide the way two same-chain versions can — the reshape's bump has
 *  no job here); each stays editable per network. */
export function defaultTickers(chainIds: readonly number[], seed: string): Record<number, string> {
  const t = cleanTicker(seed)
  const out: Record<number, string> = {}
  for (const id of chainIds) out[id] = t
  return out
}

/** BasketBuilder's own name law (nameValid). */
export function bundleNameOk(name: string): boolean {
  return name.trim().length >= 2
}
