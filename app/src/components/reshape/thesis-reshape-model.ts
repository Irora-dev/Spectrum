import type { BasketData, Holding } from '../../lib/spectrum/basket-data'
import { isDemoLegAddress } from '../../lib/spectrum/thesis-run-types'
import { computeBasketDiff, type BasketDiff } from '../../lib/spectrum/versioning'
import { DEMO_DEPLOY_SCRIPT, type ReshapeDraft, type ThesisReshapeLane, type ThesisReshapeStepState } from './reshape-types'

// ─────────────────────────────────────────────────────────────────────────────
// THE THESIS-RESHAPE LANE MACHINE — the pure model behind ReshapeThesisModal's
// ship ceremony (no React, no chain, no storage), the same extraction the run
// overlay made into run-lanes.ts: the modal drives; this module only COMPOSES
// lanes, REDUCES transitions, and words the honest sentences, so the node test
// suite covers every headline state without mounting a component.
//
// THE MACHINE IS SIMPLER THAN THE RUN'S, BY DESIGN (the contract's own note):
// per chain the ceremony is [switch → deploy → sign-lineage], STRICTLY
// SEQUENTIAL — one lane at a time, one action at a time. There is no bridge
// phase, no interleaving, no persistence machinery in v1: a deploy leaves a
// durable artifact (the basket itself), and the interruption footer tells the
// recovery story instead of a resume record pretending to.
//
// THE REFUSAL LAW (thesis-run.ts:134's pattern, applied here): a REAL ceremony
// must never arm against a synthetic leg — compose returns { refused } before
// anything else is considered. demo: true composes the same lanes and the
// modal says so on its face (DEMO chip); nothing arms either way.
//
// FAILURE CARRIES ITS EVIDENCE: `newAddress` is the tell for what a failed
// lane actually did. null ⇒ the deploy itself failed (retry re-queues: reset +
// re-prepare). Set ⇒ THE NEW VERSION IS LIVE and only the lineage signature is
// missing (retry re-offers just the signature — redeploying would ship a THIRD
// version). retryLane is the only exit from 'failed', mirroring retryStep.
// ─────────────────────────────────────────────────────────────────────────────

/** Spec-exact refusal for a real ceremony against synthetic legs. */
export const DEMO_RESHAPE_REFUSAL = 'This bundle is a demo — its baskets are synthetic and cannot ship a new version.'

/** The skipped lane's honest sentence (skip is a plan-time verdict). */
export const SKIPPED_LANE_NOTE = "Keeping this network's current version — nothing ships here."

/** The lineage-refusal note — the contract's recovery story, said on the lane:
 *  a deployed leg whose signature was refused/lost is recoverable through
 *  LinkPredecessorButton on the new basket's own page. */
export const LINEAGE_REFUSED_NOTE =
  'The new version is live on this network — only the lineage signature is missing. Retry it here, or sign it any time from the new basket’s own page via “Link previous version”; until it is signed the two versions list as unrelated baskets.'

/** The ship stage's interruption footer, word for word. Two sentences, no em
 *  dash: the same treatment the owner gave the publish ceremony's note on
 *  2026-08-13 ("center this text and remove em dash and make a little larger"),
 *  applied here because it is the same sentence in the same place — the two
 *  ceremonies' footers must not drift apart. */
export const INTERRUPTION_NOTE =
  'If this closes mid-way, finished networks keep their new versions. An unsigned lineage can be linked later from the new basket’s own page.'

/** The review stage's honesty plate. n = the networks actually shipping. */
export function honestyPlateWords(n: number): string {
  const networks = `${n} ${n === 1 ? 'network' : 'networks'}`
  return `This ships a new version on ${networks}, one at a time — a deploy and a signature per network. The current baskets stay exactly as they are; holders can swap into each new version from its page. Costs are each network’s own deploy price plus gas.`
}

// ── the refusal law (shared by the modal's mount gate and compose) ───────────

/** Null when a real ceremony may arm; the refusal sentence otherwise. The one
 *  law, checked refusal-FIRST at mount, at compose, and again at the executor
 *  (belt and braces — an armed deploy against a synthetic address is the one
 *  mistake this feature must never make). */
export function demoReshapeRefusal(legs: readonly { address: string }[], demo: boolean): string | null {
  return !demo && legs.some((l) => isDemoLegAddress(l.address)) ? DEMO_RESHAPE_REFUSAL : null
}

// ── composition ──────────────────────────────────────────────────────────────

export interface ComposeReshapeArgs {
  /** The thesis's legs, in the order the ceremony will walk them. */
  legs: readonly { chainId: number; address: `0x${string}` }[]
  /** Chains the creator chose to keep as-is ("keep this network's current
   *  version"). Skipped legs COMPOSE — as terminal 'skipped' lanes with the
   *  honest note — so the ceremony shows the whole bundle, never a shortened
   *  list that hides what was left alone (the run overlay's own rule: every
   *  leg in the input appears). */
  skipped: ReadonlySet<number> | readonly number[]
  demo: boolean
}

/** Compose the ceremony's lanes, or refuse with a sentence. Refusals: the demo
 *  law (first, always), no legs, two legs sharing a chain (a thesis holds one
 *  leg per chain — the grouper's law), and every leg skipped (the ≥1 rule: an
 *  all-skipped ceremony has nothing to ship and must not open). */
export function composeReshapeLanes(args: ComposeReshapeArgs): ThesisReshapeLane[] | { refused: string } {
  const { legs, demo } = args

  const refusal = demoReshapeRefusal(legs, demo)
  if (refusal) return { refused: refusal }

  if (legs.length === 0) return { refused: 'This bundle has no legs to reshape.' }
  const seen = new Set<number>()
  for (const l of legs) {
    if (seen.has(l.chainId)) return { refused: `Two legs share chain ${l.chainId} — a thesis holds one leg per chain.` }
    seen.add(l.chainId)
  }

  const skippedSet = args.skipped instanceof Set ? args.skipped : new Set(args.skipped)
  const lanes: ThesisReshapeLane[] = legs.map((l) => {
    const skip = skippedSet.has(l.chainId)
    return {
      chainId: l.chainId,
      predecessor: l.address,
      state: skip ? 'skipped' : 'queued',
      newAddress: null,
      note: skip ? SKIPPED_LANE_NOTE : null,
    }
  })

  if (lanes.every((l) => l.state === 'skipped'))
    return { refused: 'Every network is set to keep its current version — there is nothing to ship.' }

  return lanes
}

/** The lanes that will actually deploy (skipped excluded). */
export function runnableLanes(lanes: readonly ThesisReshapeLane[]): ThesisReshapeLane[] {
  return lanes.filter((l) => l.state !== 'skipped')
}

// ── the cursor + reducers (pure; SAME reference on a refused/no-op call, so a
//    caller detects refusal by identity — the thesis-run reducers' idiom) ─────

const TERMINAL: ReadonlySet<ThesisReshapeStepState> = new Set(['done', 'skipped'])

/** The strictly-sequential cursor: the FIRST lane not in a terminal state, or
 *  null when the ceremony is over. A 'failed' lane HOLDS the cursor — retry is
 *  the only exit, and the lanes after it stay queued (never started around). */
export function activeLane(lanes: readonly ThesisReshapeLane[]): ThesisReshapeLane | null {
  return lanes.find((l) => !TERMINAL.has(l.state)) ?? null
}

export interface LanePatch {
  state?: ThesisReshapeStepState
  newAddress?: `0x${string}` | null
  note?: string | null
}

/** Patch ONE lane — and only the lane the cursor is on. Refusals (same ref):
 *  - a chainId not in the lanes, or any lane that is not the active one — the
 *    ceremony is strictly sequential, so a driver for a lane that is not
 *    current (a stale executor callback after a re-mount) must change nothing;
 *  - terminal lanes ('done'/'skipped' are records, and records do not get
 *    rewritten) — folded into the active check, since a terminal lane is
 *    never the cursor;
 *  - any transition INTO 'skipped' — skip is a plan-time verdict (the
 *    contract: "the creator chose not to reshape this leg"), and a runtime
 *    skip would erase a money step from the ceremony;
 *  - a state change on a 'failed' lane — retryLane is the only exit (a failed
 *    lane may still ENRICH its note/newAddress: learning more detail about a
 *    failure is not a transition). */
export function advanceLane(
  lanes: readonly ThesisReshapeLane[],
  chainId: number,
  patch: LanePatch,
): ThesisReshapeLane[] {
  const lane = lanes.find((l) => l.chainId === chainId)
  if (!lane) return lanes as ThesisReshapeLane[]
  const active = activeLane(lanes)
  if (!active || active.chainId !== chainId) return lanes as ThesisReshapeLane[]
  if (patch.state === 'skipped') return lanes as ThesisReshapeLane[]
  if (lane.state === 'failed' && patch.state !== undefined && patch.state !== 'failed') return lanes as ThesisReshapeLane[]

  const next: ThesisReshapeLane = { ...lane }
  if (patch.state !== undefined) next.state = patch.state
  if ('newAddress' in patch) next.newAddress = patch.newAddress ?? null
  if ('note' in patch) next.note = patch.note ?? null
  if (next.state === lane.state && next.newAddress === lane.newAddress && next.note === lane.note)
    return lanes as ThesisReshapeLane[]
  return lanes.map((l) => (l.chainId === chainId ? next : l))
}

/** The ONLY exit from 'failed', and it reads the lane's own evidence:
 *  - newAddress set ⇒ the deploy LANDED and only the signature failed — retry
 *    returns to 'signing-lineage' (re-deploying would ship a third version);
 *  - newAddress null ⇒ the deploy itself failed — back to 'queued', and the
 *    executor re-prepares from scratch (reset + re-prepare).
 *  Note cleared either way; newAddress kept — it is evidence, not state. */
export function retryLane(lanes: readonly ThesisReshapeLane[], chainId: number): ThesisReshapeLane[] {
  const lane = lanes.find((l) => l.chainId === chainId)
  if (!lane || lane.state !== 'failed') return lanes as ThesisReshapeLane[]
  const state: ThesisReshapeStepState = lane.newAddress != null ? 'signing-lineage' : 'queued'
  return lanes.map((l) => (l.chainId === chainId ? { ...l, state, note: null } : l))
}

/** Progress over the RUNNABLE lanes (skipped excluded — a leg the creator kept
 *  was never work to do). finished = every runnable lane done; a failed lane
 *  keeps the ceremony unfinished until retried or abandoned (the interruption
 *  note is the honest exit). */
export function reshapeProgress(lanes: readonly ThesisReshapeLane[]): {
  done: number
  total: number
  failed: number
  finished: boolean
} {
  let done = 0
  let total = 0
  let failed = 0
  for (const l of lanes) {
    if (l.state === 'skipped') continue
    total++
    if (l.state === 'done') done++
    else if (l.state === 'failed') failed++
  }
  return { done, total, failed, finished: done === total }
}

// ── the lane's three step marks (the run overlay's StepMark grammar) ─────────

export type LaneMarkState = 'done' | 'active' | 'failed' | 'todo'
export interface LaneMark {
  key: 'switch' | 'deploy' | 'lineage'
  label: string
  state: LaneMarkState
}

/** The [switch → deploy → sign lineage] marks, derived from the lane state
 *  alone. On 'failed' the mark that failed is read off the lane's own
 *  evidence: newAddress set ⇒ the deploy landed, the LINEAGE failed;
 *  null ⇒ the DEPLOY failed (the switch had been satisfied to get there). */
export function laneMarks(lane: ThesisReshapeLane): LaneMark[] {
  const mk = (key: LaneMark['key'], label: string, state: LaneMarkState): LaneMark => ({ key, label, state })
  const marks = (a: LaneMarkState, b: LaneMarkState, c: LaneMarkState): LaneMark[] => [
    mk('switch', 'switch', a),
    mk('deploy', 'deploy', b),
    mk('lineage', 'sign lineage', c),
  ]
  switch (lane.state) {
    case 'queued':
    case 'skipped':
      return marks('todo', 'todo', 'todo')
    case 'switch':
      return marks('active', 'todo', 'todo')
    case 'deploying':
      return marks('done', 'active', 'todo')
    case 'signing-lineage':
      return marks('done', 'done', 'active')
    case 'done':
      return marks('done', 'done', 'done')
    case 'failed':
      return lane.newAddress != null ? marks('done', 'done', 'failed') : marks('done', 'failed', 'todo')
  }
}

// ── words (deploy stages, aria announcements) ────────────────────────────────

/** The deploy executor's status stages, surfaced in the lane in plain words —
 *  ONE map for the real hook and the demo script, so the walkthrough shows
 *  exactly the words the real ceremony shows. null = the stage is a lane
 *  TRANSITION (success/error/idle), not a sentence. */
export function deployStageWords(status: string, attempts?: number): string | null {
  switch (status) {
    case 'mining':
      return attempts != null && attempts > 0
        ? `mining the new address… (${attempts.toLocaleString('en-US')} tries)`
        : 'mining the new address…'
    case 'preparing':
      return 'pricing + simulating…'
    case 'ready':
      return 'ready — the deploy signature is next'
    case 'signing':
      return 'deploy signature in the wallet…'
    case 'confirming':
      return 'confirming on the network…'
    case 'seeding':
      return 'first deposit…'
    default:
      return null
  }
}

/** The lineage beat's demo words. */
export const DEMO_LINEAGE_NOTE = 'lineage signature — the supersedes claim, signed off-chain (free)'

/** One aria-live sentence per lane state (the overlay reads transitions aloud). */
export function announceLane(lane: ThesisReshapeLane, chainName: string): string {
  switch (lane.state) {
    case 'switch':
      return `${chainName}: switch offered — switching signs nothing.`
    case 'deploying':
      return `${chainName}: shipping the new version.`
    case 'signing-lineage':
      return `${chainName}: lineage signature.`
    case 'done':
      return `${chainName}: new version live and linked.`
    case 'failed':
      return `${chainName}: needs a retry.`
    case 'skipped':
      return `${chainName}: keeping its current version.`
    default:
      return `${chainName}: queued.`
  }
}

// ── the demo ceremony's beats ────────────────────────────────────────────────

export interface DemoLaneBeat {
  /** How long to sit in the CURRENT state before applying — the pacing that
   *  makes the walkthrough watchable (the run overlay's demoTick contract). */
  waitMs: number
  patch: LanePatch
}

const DEMO_ENTER_MS = 500
const DEMO_SWITCH_HOLD_MS = 1300 // the run walkthrough's switch beat
const DEMO_LINEAGE_HOLD_MS = 1600

/** One lane's walkthrough, derived from DEMO_DEPLOY_SCRIPT (the contract's own
 *  pacing): queued → switch → deploying (each script beat surfacing its stage
 *  words) → signing-lineage (on the script's 'success') → done. Each beat's
 *  waitMs is the hold in the PREVIOUS state — the script's ms travel exactly.
 *  Pure, so the pacing and the terminal guarantee are testable without timers. */
export function demoLaneScript(): DemoLaneBeat[] {
  const beats: DemoLaneBeat[] = [{ waitMs: DEMO_ENTER_MS, patch: { state: 'switch', note: null } }]
  let hold = DEMO_SWITCH_HOLD_MS
  for (const row of DEMO_DEPLOY_SCRIPT) {
    if (row.status === 'success') {
      beats.push({ waitMs: hold, patch: { state: 'signing-lineage', note: DEMO_LINEAGE_NOTE } })
    } else {
      beats.push({ waitMs: hold, patch: { state: 'deploying', note: deployStageWords(row.status) } })
    }
    hold = row.ms > 0 ? row.ms : DEMO_LINEAGE_HOLD_MS
  }
  beats.push({ waitMs: hold, patch: { state: 'done', note: null } })
  return beats
}

// ── the review diff, prev version vs draft ───────────────────────────────────

/** Diff a live basket against the EDITED draft, through versioning.ts's own
 *  computeBasketDiff — the draft is dressed as a holdings list (weights are
 *  the only field the diff reads) so there is ONE diff law, not two.
 *
 *  ⚠ DUPLICATION, STATED FOR THE INTEGRATOR: the contract expects the basket
 *  modal's sibling (reshape-model.ts) to grow the canonical draft-diff
 *  adapter. It had not landed when this was written, so this thin adapter
 *  exists here; when reshape-model.ts exports one, import it there and delete
 *  this. */
export function draftDiffFrom(prev: BasketData, draft: ReshapeDraft): BasketDiff {
  const holdings: Holding[] = draft.legs.map((l, i) => ({
    asset: l.address,
    symbol: l.symbol,
    name: l.name ?? l.symbol,
    decimals: l.decimals,
    targetWeightPct: draft.weights[i] ?? 0,
    // Display stubs — computeBasketDiff reads asset/symbol/targetWeightPct
    // only; a draft has no balances and claims none.
    balance: 0,
    priceUsd: 0,
    valueUsd: 0,
    liveWeightPct: 0,
    change24hPct: null,
    priced: false,
    series: [],
  }))
  return computeBasketDiff(prev, { ...prev, holdings })
}
