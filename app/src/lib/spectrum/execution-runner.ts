import { keccak256, toHex, type Address } from 'viem'
import { isUserRejection } from './runner-effects'
import { type FundingPlan, type FundingStep } from './funding-plan'
import {
  ForbiddenFallback,
  submissionReducer,
  type SubmissionEvent,
  type SubmissionState,
} from './capability-ladder'
import { showChainId, showSymbol } from './safe-copy'
import {
  CLAIM_HEARTBEAT_MS,
  claimStep,
  clearSubmission,
  hydrateSubmission,
  markClaimAmbiguous,
  MAX_STEP_KEY_LEN,
  readSubmissions,
  recentCycleCompletionAt,
  recentStepCompletionAt,
  recordCycleCompletion,
  recordStepCompletion,
  recordSubmission,
  renewClaim,
  submissionSigner,
  sweepExpiredClaims,
} from './submission-store'

/** The storage seam (law 8): injectable so the guard is testable, and PROBED
 *  so its absence is loud. `null` = no storage at all. */
export type RunnerStore = Storage | null

// ─────────────────────────────────────────────────────────────────────────────
// THE EXECUTION RUNNER — the last dark brick of slice A. It threads the pieces
// that already exist (inventory reads → funding-plan → capability ladder →
// compose → simulate → sign) into ONE sequenced run whose every transition is
// a law rather than a hope.
//
// AUDITED AT BIRTH, as the threat model requires: the laws below were written
// before the code and each is pinned. Effects are INJECTED (`RunnerEffects`)
// so this core is pure and testable — the wallet plumbing lives in the hook
// that supplies them, and no test needs a browser to prove a law holds.
//
// THE LAWS:
//  1. ACTIVE-SCOPED ONLY (E13, board row p3-groupguard). The runner is
//     constructed with ONE address. Reads may merge a wallet group for
//     DISPLAY, but the runner never sees the group array: an intent against
//     holdings the active wallet cannot move is unrepresentable here, not
//     merely avoided. A mid-run account switch ABORTS (law 6).
//  2. HYDRATE BEFORE ATTEMPT (E5's lifetime half). Every step's machine starts
//     from `hydrateSubmission`, never from a blank idle. A live record means
//     the previous instance submitted and did not resolve — the machine starts
//     at `submitted`, where `attempt` throws by the reducer's own table.
//  3. RECORD IN THE SAME TICK (E5's write half). The submission record is
//     written the instant the id exists, BEFORE any await. A record written
//     after an await can be lost to the tab closing between them, which puts
//     us back in the double-buy.
//  4. SIMULATE THEN SIGN, SAME BYTES (E7). A step signs the object the
//     simulation returned, never a re-composition. A simulation failure is a
//     refusal with the chain's own message, never a retry at a lower rung.
//  5. EVERY OUTCOME LEAVES A RECORD (PM-ratified 3.2 gate). A run that stops
//     after moving money writes a PARTIAL exec-log entry with the steps that
//     finished and where it stopped — and never a guessed cause, because the
//     batcher discards a failed leg's inner reason.
//  6. STOP MEANS STOP, EXCEPT WHERE MONEY IS IN FLIGHT. A stop request halts
//     before the NEXT step; it never abandons a submitted-but-unresolved one
//     (that record must resolve or the store keeps it for the next instance).
//  7. NOTHING SIGNS WHILE SIMULATED. The interlock is checked at the entry
//     point, so a caller cannot reach the signing path by accident.
//  8. NO PERSISTENCE, NO RUN (found by auditing this module at birth). Laws 2
//     and 3 are only real if the submission record can actually be written:
//     with storage unavailable (private browsing, a dead quota, a storage-less
//     host) `hydrateSubmission` always answers `idle` and the remount
//     double-buy guard SILENTLY VANISHES. A safety mechanism that is absent
//     without saying so is the exact failure class this OS refuses, and the
//     money at stake is a duplicate buy — so the runner PROBES writability at
//     the door and refuses in plain words rather than running unprotected.
//
// AUDIT ROUND 2 (2026-08-04, "we need to continue auditing if we're finding
// issues" — four more, three of them serious enough to lose money or hammer a
// node). Each became a law:
//  9. A POLL IS BOUNDED AND PACED. The first cut polled `resolve` in a tight
//     `for(;;)` with no delay and no ceiling — measured 50,000 calls in 5ms,
//     which spins the CPU and hammers the RPC precisely while a real
//     transaction is pending (the fastest way to get rate-limited exactly when
//     confirmation matters). Polls now WAIT between attempts and STOP at a
//     budget, and stopping never guesses: the run ends `partial`, the record
//     STAYS (the no-TTL law — only a human clears an unresolved submission),
//     and the user is told to check their wallet activity.
// 10. A THROW IS NOT AN ANSWER. `resolve` throwing (an RPC blip mid-poll) used
//     to escape the whole runner: no exec-log row, an orphaned live record —
//     law 5 defeated by a dropped connection. A throw is now AMBIGUITY, which
//     the poll already knows how to hold.
// 11. NOBODY ELSE'S MONEY. The record carries `signer` and nothing compared it
//     (half-2 finding 6's law was documented and never enforced): a live
//     submission signed by another wallet would have been adopted and reported
//     as this run's completed step. A mismatch REFUSES by name.
// 12. UNKNOWN IS NOT IDLE. `hydrateSubmission` answers `idle` for both "no
//     record" and "records present but unparseable" — and from idle, `attempt`
//     is legal. So the runner reads the store's health FIRST and refuses when
//     any row is unreadable, the same shape as law 8. And not only at the
//     door (2026-08-07, found closing R6's pin): a row can appear MID-RUN, so
//     `claimStep` re-checks and answers `store-unreadable` rather than
//     claiming over what might be live money — the R6 race window, wearing a
//     row we cannot read.
// 13. CLAIM THE STEP BEFORE TOUCHING THE WALLET (round 10 — the multi-tab
//     race). Laws 2/3 assumed instances are SEQUENTIAL; tabs are CONCURRENT,
//     and localStorage is shared. Two tabs both hydrated `idle`, both legally
//     attempted, and both submitted the same money — the double-buy again,
//     through tabs instead of a remount, in the exact window a human spends
//     reading a wallet prompt. The runner now CLAIMS (a record with no id)
//     before it simulates, so a second tab sees the claim and refuses to
//     race. A claim may expire where a submission may not: no id means
//     nothing was sent, so there is no ambiguity to preserve.
// ─────────────────────────────────────────────────────────────────────────────

export type RunPhase =
  | 'idle'
  | 'planning'
  | 'running'
  | 'done'
  /** Stopped by the user, or by a refusal, AFTER some money may have moved. */
  | 'partial'
  /** Nothing moved: refused before the first signature. */
  | 'refused'

export interface RunStepState {
  /** Stable per (chain, kind) — the submission store's key and the panel's. */
  key: string
  chainId: number
  kind: 'bridge' | 'batch' | 'sell'
  /** What the panel says this step is, in the words the user already read. */
  label: string
  status:
    | 'pending'
    | 'simulating'
    | 'awaiting-signature'
    | 'submitted'
    | 'done'
    | 'failed'
    /** Submitted, and we stopped being able to say. NOT 'failed': the money may
     *  well have moved, and claiming failure is as wrong as claiming success
     *  (law 9's stop). The record survives for the next instance. */
    | 'unresolved'
    | 'skipped'
  /** Set on failure — the chain's own message or our refusal sentence. Never
   *  a diagnosis we did not make. */
  message?: string
  /** `RequiredLegFailed(index)` when the chain named a leg; no cause attached. */
  failedLegIndex?: number
  submissionId?: string
}

export interface RunState {
  phase: RunPhase
  steps: RunStepState[]
  /** Sentences the panel shows verbatim (the funding plan's notes + refusals). */
  notes: string[]
  /** True once any step has submitted — the boundary between "refused" (no
   *  money moved) and "partial" (some did). */
  moneyMoved: boolean
}

/** What one step's simulation produced — opaque to this core on purpose: the
 *  runner's job is sequencing and law, not calldata. */
export interface SimulatedStep {
  /** The exact request the signature must use (law 4). */
  request: unknown
  /** Our floor vs the simulated recipient delta (B2) — false REFUSES. */
  floorHolds: boolean
  /** Why the floor did not hold, in review words. */
  floorMessage?: string
}

/** The effects the runner cannot do itself. Every one is injectable, so every
 *  law above is provable without a wallet. */
export interface RunnerEffects {
  /** The account the wallet reports RIGHT NOW — checked before each step so a
   *  mid-run switch aborts rather than signing as someone else (law 1/6). */
  activeAccount: () => Address | null
  /** Compose + `eth_call` the step. Throws with the chain's message on revert. */
  simulate: (step: FundingStep) => Promise<SimulatedStep>
  /** Sign and submit the simulated request. Returns the id (tx hash or the
   *  5792 calls id) — the runner records it in the SAME TICK (law 3). */
  submit: (step: FundingStep, sim: SimulatedStep) => Promise<{ submissionId: string; rung: number }>
  /** Poll the submission to a terminal answer. `null` = still ambiguous, keep
   *  holding (never a fallback: law 4 + the ladder's own safety law). */
  /** `partial` = some of the money LANDED, so the record must be kept (R3). */
  resolve: (
    submissionId: string,
  ) => Promise<{ ok: true } | { ok: false; message: string; failedLegIndex?: number; partial?: boolean } | null>
  /** Persist the run's record — completed OR partial (law 5). */
  writeExecLog: (entry: {
    partial: boolean
    stoppedAt?: string
    failedLegIndex?: number
    completedSteps: string[]
  }) => void
  /** Optional: the panel re-renders from each snapshot. */
  onState?: (state: RunState) => void
  /** Optional cooperative stop (law 6). */
  shouldStop?: () => boolean
  /** Where submission records live (law 8). Omitted = the host's
   *  localStorage; pass one explicitly in tests and in any host whose storage
   *  is not `window.localStorage`. */
  store?: RunnerStore
  /** Injected clock, so this module stays clock-free (the purity law). */
  nowMs?: () => number
  /** Wait between poll attempts (law 9). Injected so tests are instant and the
   *  host owns the pacing; omitted = a real timer. */
  sleep?: (ms: number) => Promise<void>
}

/** Poll pacing (law 9). A confirmation takes seconds, not microseconds, and a
 *  pending transaction is exactly when NOT to get rate-limited. */
export const POLL_INTERVAL_MS = 2_000
/** ~4 minutes of honest waiting before we stop claiming to know. Past this the
 *  run ends `partial` with the record INTACT — only a human clears it. */
export const POLL_MAX_ATTEMPTS = 120
/** BRIDGE steps wait longer — ~15 minutes (the owner's greenlit follow-up to the
 *  <30s ruling, 2026-08-15: one click should carry through arrival into the
 *  buys). A transfer is EXPECTED to take minutes even on a FASTEST route, so
 *  ending partial at 4 minutes made the common case a two-click resume. The
 *  bound stays a bound: past it the same honest partial, record intact — and
 *  the live card shows elapsed-vs-ETA the whole time, so the wait is never a
 *  frozen screen. */
export const BRIDGE_POLL_MAX_ATTEMPTS = 450

/** Can we actually persist a submission? A write-read-delete round trip, not a
 *  presence check: Safari private mode exposes localStorage and throws on
 *  write, so "it exists" proves nothing (law 8). */
export function canPersistSubmissions(store: RunnerStore): boolean {
  try {
    const probe = 'spectrum:persist-probe'
    store?.setItem(probe, '1')
    const ok = store?.getItem(probe) === '1'
    store?.removeItem(probe)
    return ok
  } catch {
    return false
  }
}

/** OUR code handed the runner an impossible plan — loud, like the funding
 *  plan's own contract errors, because quietly running it risks money. */
export class RunnerContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerContractError'
  }
}

export class RunnerRefusal extends Error {
  constructor(
    message: string,
    readonly stoppedAt: string,
    /** ⚠ WHETHER WE KNOW NOTHING WAS SENT. 'nothing-sent' is a claim about the
     *  world, not a mood: the wallet answered definitively before submitting
     *  (declined, method unsupported), so the claim may be released and the
     *  step retried. 'unknown' means the wallet did not answer clearly and a
     *  transaction MAY be in flight — the claim must be KEPT, because releasing
     *  it invites a retry that buys the same thing twice.
     *
     *  ⚠⚠ THE DEFAULT IS 'unknown', AND IT USED TO BE THE OPPOSITE (A6 verify
     *  pass, 2026-08-07 — CRITICAL). Defaulting to 'nothing-sent' "so every
     *  existing call site keeps its meaning" meant the one refusal that
     *  actually needs ambiguity — runner-effects' own "Your wallet did not
     *  answer clearly" on the 5792 rung — took the DEFINITIVE branch, released
     *  its claim, and let the very next run buy the same batch again. The
     *  ambiguity machinery was DEAD CODE on the only production path it was
     *  built for, and the pin missed it by throwing a plain Error where
     *  production throws a RunnerRefusal.
     *
     *  A default decides what happens when someone forgets, and the two
     *  failure modes are NOT symmetric: forgetting now costs a locked step
     *  (recoverable), where before it cost a duplicate buy of real money (not
     *  recoverable). This is the effects layer's own stated law — "ambiguity
     *  must fail closed, even though that costs a retry" — finally applied to
     *  the type. Certainty is read ONLY on the submit path; a refusal thrown
     *  from `simulate` never reaches the classifier. */
    readonly certainty: 'nothing-sent' | 'unknown' = 'unknown',
  ) {
    super(message)
    this.name = 'RunnerRefusal'
  }
}

/**
 * A stable, INTENT-BOUND identity for a step.
 *
 * ⚠⚠ IT USED TO BE `batch:<chainId>` AND NOTHING ELSE (independent review,
 * 2026-08-07). Two different plans touching the same chain therefore shared a
 * key, so a submission record left unresolved by plan A was hydrated by plan B
 * days later, resolved against plan A's old receipt, and marked DONE — the
 * panel reported a completed run for a plan that was never composed, simulated
 * or sent, while the money the user believed they had allocated sat untouched.
 * The same collision is what let a planted record fabricate a finished run.
 *
 * A claim must name the thing it paid for. The key now carries the step's own
 * money-bearing content — for a batch, what it funds and with how much; for a
 * bridge, the route and the amount — so a record can only ever complete the
 * intent that created it.
 *
 * Deliberately NOT a hash of the composed calldata: that is not known when the
 * key is first needed (initialRunState runs before composition), and a key that
 * changes between planning and submitting is worse than a coarse one.
 */
/**
 * Can this step be given a stable identity at all? Amounts AND chain ids must
 * be finite: `Math.trunc(NaN)` stringifies to 'NaN', so two different
 * malformed intents would share a key token — and a non-finite chain id is
 * worse, because `chainOf(step)` carries it into `claimStep`, where
 * `JSON.stringify` writes NaN as `null`: our OWN claim becomes a row every
 * future read drops, refusing every later run with no way out (A6 verify
 * pass, 2026-08-07 — the first cut guarded only the amounts).
 *
 * A TOTAL PREDICATE, SEPARATE FROM `stepKeyOf`'s THROW, on purpose: the same
 * verify pass caught the guard throwing out of `initialRunState`, which a
 * panel may call during render and which runs BEFORE the SIMULATED interlock.
 * The runner's own contract is that it never throws for a money reason, so
 * both callers ask this first and refuse in a sentence instead.
 */
export function planStepIdentifiable(s: FundingStep): boolean {
  // A sale is identified by WHAT is sold and HOW MUCH of it (the exact raw
  // amount) — its floor is an estimate and estimates never make identity.
  if (s.action.kind === 'sell') {
    if (!Number.isFinite(s.action.chainId) || !Number.isFinite(s.action.floorProceedsCents)) return false
    try {
      return BigInt(s.action.sellRaw) > 0n && /^0x[0-9a-fA-F]{40}$/.test(s.action.asset)
    } catch {
      return false
    }
  }
  const chains = s.action.kind === 'bridge' ? [s.action.fromChainId, s.action.toChainId] : [s.action.chainId]
  const cents = s.action.kind === 'bridge' ? [s.action.amountCents] : s.action.fundedFrom.map((f) => f.cents)
  return [...chains, ...cents].every((n) => Number.isFinite(n))
}

export const stepKeyOf = (s: FundingStep): string => {
  // Loud for a DIRECT caller — this is our plan bug, not a market condition.
  // The runner and initialRunState never reach it: they ask
  // `planStepIdentifiable` first and refuse in words.
  if (!planStepIdentifiable(s))
    throw new RunnerContractError('a step whose amount or network is not a finite number cannot be identified by a key')
  const raw =
    s.action.kind === 'sell'
      ? // the sale's identity: this asset, this exact raw amount, this chain.
        // The floor is NOT in the key — a re-quote must not mint a fresh key
        // for the same sale, or the double-sell guard dissolves on every
        // price tick.
        `sell:${s.action.chainId}:${s.action.asset.toLowerCase()}:${s.action.sellRaw}`
      : s.action.kind === 'bridge'
      ? `bridge:${s.action.fromChainId}->${s.action.toChainId}:${Math.trunc(s.action.amountCents)}:${s.action.refuel ? 'r' : 'n'}:${s.action.source}`
      : // funding + INTENT identify the batch (audit 2026-08-14: "the funding
        // sources ARE the intent" was the questionable premise — funding does
        // not say WHICH baskets; two different portfolios with identical
        // funding collided to one key and the second false-refused for the
        // window). Sorted so ordering cannot mint a new key for the same plan;
        // the intent digest rides when the builder supplies it.
        `batch:${s.action.chainId}:${[...s.action.fundedFrom]
          .map((f) => `${f.source}@${f.fromChainId}:${Math.trunc(f.cents)}`)
          .sort()
          .join(',')}${s.action.intent ? `:i${s.action.intent}` : ''}`
  if (raw.length <= MAX_STEP_KEY_LEN) return raw
  // ⚠ THE KEY MUST FIT THE STORE (2026-08-07, found closing R6's pin). The
  // store's parseRow refuses a stepKey past MAX_STEP_KEY_LEN as hostile input,
  // so a longer key would make every row written for this step UNREADABLE:
  // hydrate answers idle, another tab's claim is invisible, and the double-buy
  // guard silently voids — for exactly the plans that move the most money (a
  // batch funded from local cash + new money + cross-chain proceeds already
  // passes the bound). A long intent therefore collapses to a deterministic
  // digest of the SAME raw string (sorted above, so order-insensitivity
  // survives), with the chain scope kept readable in the prefix. 16 digest
  // bytes is plenty: a collision would need two of ONE user's own intents to
  // agree by accident — an attacker who can write rows writes any key outright
  // and needs no collision.
  const digest = `:#${keccak256(toHex(raw)).slice(2, 34)}`
  const prefix =
    s.action.kind === 'sell'
      ? `sell:${s.action.chainId}`
      : s.action.kind === 'bridge'
      ? `bridge:${s.action.fromChainId}->${s.action.toChainId}`
      : `batch:${s.action.chainId}`
  // …and the digest form must fit too (A6 review, 2026-08-07: two EIP-2294-
  // legal 19-digit chain ids push the bridge prefix past the bound — the exact
  // bug, reintroduced at the edge). The chain scope in the prefix is cosmetic
  // (the store keys by (chainId, stepKey) regardless), so it is the part that
  // yields; the digest, which carries the whole identity, never does.
  return prefix.length + digest.length <= MAX_STEP_KEY_LEN
    ? `${prefix}${digest}`
    : `${s.action.kind === 'bridge' ? 'bridge' : s.action.kind === 'sell' ? 'sell' : 'batch'}${digest}`
}

const labelOf = (s: FundingStep): string =>
  s.action.kind === 'sell'
    ? // showSymbol: a deployer-controlled string on a rendered money surface
      // is bounded + inertized, never trusted (the D4-D8 law).
      `the sale of ${showSymbol(s.action.symbol)} on network ${showChainId(s.action.chainId)}`
    : s.action.kind === 'bridge'
    ? `the transfer to network ${showChainId(s.action.toChainId)}`
    : `the ${showChainId(s.action.chainId)} network transaction`

const chainOf = (s: FundingStep): number => (s.action.kind === 'bridge' ? s.action.fromChainId : s.action.chainId)

/** The sentence for a plan our own code built wrong. Shown, not thrown — a
 *  panel calls `initialRunState` during render. */
export const UNIDENTIFIABLE_PLAN_NOTE =
  'We could not prepare this plan safely, because part of it does not describe an amount and a network we can pin down. Nothing was sent. Re-open the review to build it again.'

/** The initial state a panel can render before anything runs — refusals from
 *  the funding plan are already visible here, so a plan that cannot execute
 *  says so without a run being started.
 *
 *  ⚠ TOTAL BY CONTRACT (A6 verify pass, 2026-08-07): this must never throw.
 *  The new key guard did throw here, ahead of the SIMULATED interlock and the
 *  persistence law, turning a refusal into an unhandled rejection — and this
 *  helper is also reachable from a React render and from the hook's own
 *  `refuse()`. A malformed plan becomes a refusal WITH A SENTENCE instead. */
export function initialRunState(plan: FundingPlan): RunState {
  const notes = [...plan.notes, ...plan.refusals.map((r) => r.reason)]
  if (!plan.steps.every(planStepIdentifiable)) {
    return { phase: 'refused', steps: [], notes: [...notes, UNIDENTIFIABLE_PLAN_NOTE], moneyMoved: false }
  }
  return {
    phase: plan.steps.length === 0 ? 'refused' : 'idle',
    steps: plan.steps.map((s) => ({
      key: stepKeyOf(s),
      chainId: chainOf(s),
      kind: s.action.kind,
      label: labelOf(s),
      status: 'pending' as const,
    })),
    notes,
    moneyMoved: false,
  }
}

export interface RunOptions {
  /** LAW 1: exactly one address. Never a group array — the type says so. */
  account: Address
  plan: FundingPlan
  effects: RunnerEffects
  /** LAW 7: the launch interlock. The caller passes `SIMULATED`; true means
   *  nothing may sign, and the runner refuses at the door rather than trusting
   *  every downstream branch to remember. */
  simulated: boolean
}

/**
 * Execute a funding plan, one step at a time, in the plan's own order.
 *
 * Returns the final state. Never throws for a money reason — a refusal is a
 * state with a sentence, because a thrown error at a half-run is exactly the
 * record loss law 5 exists to prevent.
 */
export async function runFundingPlan(opts: RunOptions): Promise<RunState> {
  const { account, plan, effects: fx } = opts
  const state = initialRunState(plan)
  const emit = () => fx.onState?.({ ...state, steps: state.steps.map((s) => ({ ...s })) })

  // LAW 8 — probe persistence BEFORE anything else touches a wallet.
  const store: RunnerStore = fx.store !== undefined ? fx.store : safeWindowStore()
  // LAW 12 — unknown is not idle. Any unreadable row means a submission may be
  // in flight that we cannot identify, and `attempt` from idle would double it.
  const health = readSubmissions(store)
  if (!opts.simulated && (health.dropped > 0 || health.corrupt)) {
    state.phase = 'refused'
    state.notes.push(
      'There is a saved record of a transaction here that we cannot read, so we cannot tell whether something is already in progress. Nothing was sent. Check your wallet activity before trying again.',
    )
    emit()
    return state
  }
  if (!opts.simulated && !canPersistSubmissions(store)) {
    state.phase = 'refused'
    state.notes.push(
      'This browser will not let us save a record of a transaction in progress, and that record is what stops a payment being sent twice if the page reloads. Nothing was sent. Turn off private browsing, or use a normal window, and try again.',
    )
    emit()
    return state
  }

  if (opts.simulated) {
    // LAW 7 — the interlock at the door. Not an assertion about intent: a
    // caller that reached here while SIMULATED holds is a bug, and the honest
    // response is to refuse before a wallet is ever touched.
    state.phase = 'refused'
    state.notes.push('This build simulates execution, so nothing can be signed. No wallet was contacted.')
    emit()
    return state
  }
  if (plan.steps.length === 0) {
    emit()
    return state
  }
  // A plan we cannot give stable identities to cannot be protected against a
  // double buy at all — `initialRunState` has already turned it into a refusal
  // with a sentence, and this is where the run stops on it: AFTER the
  // interlocks above, so the SIMULATED and no-persistence answers still win
  // when they apply (A6 verify pass, 2026-08-07).
  if (!plan.steps.every(planStepIdentifiable)) {
    state.phase = 'refused'
    emit()
    return state
  }

  // LAW 14 — THE RULED FULL-CYCLE WINDOW (the owner 2026-08-13; the constant and
  // its stamps live in submission-store). Law 13's claims protect every step
  // WHILE records exist; a cleanly COMPLETED run deletes them, which is the
  // one moment a second tab's stale confirm screen could arm the same plan
  // with nothing left to warn it. An identical plan (same step-key digest)
  // completed inside RECENT_COMPLETION_WINDOW_MS refuses at the door. Placed
  // AFTER the identity gate: a digest over unidentifiable steps is noise.
  const cycleDigest = planCycleDigest(state.steps)
  const completedAt = recentCycleCompletionAt(cycleDigest, nowMs(fx), store)
  if (completedAt != null) {
    const minutes = Math.max(1, Math.round((nowMs(fx) - completedAt) / 60_000))
    state.phase = 'refused'
    state.notes.push(
      `This exact plan already completed from this browser ${minutes} minute${minutes === 1 ? '' : 's'} ago, so it was not sent again — that is the double-buy guard, not an error. Check your wallet activity or the portfolio's history; to genuinely buy again this soon, change the plan (the amount or the legs).`,
    )
    emit()
    return state
  }
  // Two steps sharing a submission-store key would overwrite each other's
  // record, so the second one's money would be unprotected. The funding plan
  // cannot emit this today (it refuses duplicate chains), but the runner takes
  // ANY plan and this is a money path — loud, not absorbed.
  const keys = state.steps.map((s2) => s2.key)
  const dupKey = keys.find((k, i) => keys.indexOf(k) !== i)
  if (dupKey) throw new RunnerContractError(`two steps share the key "${dupKey}" — their submission records would overwrite each other`)

  // Expired, non-ambiguous claims are dead tabs' leftovers — swept here so
  // they cannot ratchet toward the corruption ceiling and a permanent refusal
  // (A6 review, 2026-08-07: intent-bound keys made abandoned claims immortal,
  // because a replanned run almost never reuses the exact key). Submissions
  // and ambiguous claims are never touched.
  sweepExpiredClaims(nowMs(fx), store)

  state.phase = 'running'
  emit()
  const completed: string[] = []

  for (const [i, step] of plan.steps.entries()) {
    const st = state.steps[i]
    const key = st.key

    // LAW 2 — hydrate first, ALWAYS. A live record from a previous instance
    // means money is already in flight for this step: resolve it, never
    // re-attempt it.
    let machine: SubmissionState = hydrateSubmission(chainOf(step), key, store)

    // LAW 14b — a step this browser COMPLETED inside the window is already
    // bought (audit F5). It has no live record (a resolved success clears it),
    // so hydrate reads idle and `attempt` would legally re-send it — the exact
    // partial-then-re-arm double-buy law 14's whole-plan stamp cannot see. Skip
    // it as done. Only when idle: a still-live record (submitted/ambiguous)
    // outranks this and must resolve through the paths below, never be skipped.
    if (machine.phase === 'idle' && recentStepCompletionAt(key, nowMs(fx), store) != null) {
      st.status = 'done'
      completed.push(key)
      recordStepCompletion(key, nowMs(fx), store) // LAW 14b — this leg is bought
      emit()
      continue
    }
    if (machine.phase === 'submitted') {
      // LAW 11 — nobody else's money. A record signed by another wallet is not
      // ours to resolve, adopt, or report as this run's progress.
      const owner = submissionSigner(chainOf(step), key, store)
      if (owner && owner.toLowerCase() !== account.toLowerCase()) {
        st.status = 'failed'
        st.message = `A transaction for ${st.label} was sent by a different wallet and has not finished. Nothing was sent from this wallet — reconnect the wallet that started it, or wait for it to settle.`
        return finishRefused(state, st.message, emit)
      }
      state.moneyMoved = true
      st.status = 'submitted'
      st.submissionId = machine.submissionId
      emit()
      const resumed = await resolveToTerminal(machine, key, chainOf(step), fx, store, account, step.action.kind === 'bridge' ? BRIDGE_POLL_MAX_ATTEMPTS : POLL_MAX_ATTEMPTS)
      machine = resumed.machine
      if (resumed.stop) {
        st.status = resumed.keepRecord ? 'unresolved' : 'failed'
        st.message = resumed.message ?? 'We could not confirm this step, so nothing further was sent.'
        st.failedLegIndex = resumed.failedLegIndex
        return finishPartial(state, st.label, completed, fx, resumed.failedLegIndex, emit)
      }
      st.status = 'done'
      completed.push(key)
      recordStepCompletion(key, nowMs(fx), store) // LAW 14b — this leg is bought
      emit()
      continue
    }

    // LAW 6 — a stop is honored BETWEEN steps, where no money is in flight.
    if (fx.shouldStop?.()) {
      return state.moneyMoved
        ? finishPartial(state, st.label, completed, fx, undefined, emit)
        : finishRefused(state, 'You stopped before anything was sent.', emit)
    }

    // LAW 1 — the account must still be the one we planned for.
    const now = fx.activeAccount()
    if (!now || now.toLowerCase() !== account.toLowerCase()) {
      return state.moneyMoved
        ? finishPartial(state, st.label, completed, fx, undefined, emit)
        : finishRefused(
            state,
            'The connected wallet changed, so this run stopped. Nothing was sent — reconnect the original wallet and review again.',
            emit,
          )
    }

    // LAW 4 — simulate, and let the floor check bite before any signature.
    st.status = 'simulating'
    emit()
    let sim: SimulatedStep
    try {
      sim = await fx.simulate(step)
    } catch (e) {
      st.status = 'failed'
      st.message = messageOf(e)
      return state.moneyMoved
        ? finishPartial(state, st.label, completed, fx, undefined, emit)
        : finishRefused(state, st.message, emit)
    }
    if (!sim.floorHolds) {
      st.status = 'failed'
      st.message = sim.floorMessage ?? 'This step would deliver less than the amount we showed you, so it was not sent.'
      return state.moneyMoved
        ? finishPartial(state, st.label, completed, fx, undefined, emit)
        : finishRefused(state, st.message, emit)
    }

    // LAW 13 — claim the step before the wallet is touched. Another tab holding
    // this step is not an error: it is the same person, mid-prompt, elsewhere.
    // ⚠⚠ THE CLAIM MAY THROW, AND NOTHING ANYWHERE CAUGHT IT (independent pass,
    // 2026-08-08). `claimStep` refuses a claim it could not read back by
    // THROWING — deliberately, so a poison row is never written — but its own
    // `ClaimResult` declares `store-unreadable` for precisely this outcome, and
    // no caller ever received it. Measured at epoch 0, the GPS epoch, 2000, 2016
    // and one millisecond below the plausible floor: all THREW. This line had no
    // try/catch, the step loop has no outer catch, and use-execution-runner has
    // no `.catch()`, so the last emitted state stayed `running` and the panel
    // sat on a spinner forever. It failed CLOSED — submit was called zero times,
    // nothing was sent — which is why this is an honesty bug rather than a money
    // one, and why the fix is to SAY SO rather than to loosen the refusal.
    //
    // A wrong clock is an environment condition, not a caller error, so it earns
    // the verdict the type already declares instead of an exception nobody
    // handles. The poison row is still never written — that guarantee lives in
    // claimStep and is untouched here.
    let claim: ReturnType<typeof claimStep>
    try {
      claim = claimStep(chainOf(step), key, account, nowMs(fx), store)
    } catch {
      claim = 'store-unreadable'
    }
    if (claim === 'already-submitted') {
      // it became a submission between our hydrate and now — resolve, never send
      //
      // ⚠ LAW 11 HAD NO COUNTERPART HERE (review 2026-08-07, R6). The
      // nobody-else's-money check lives on the hydrate path above and was
      // absent from this one, so a record that appeared in the RACE WINDOW —
      // another tab, connected as a different account, submitting between our
      // hydrate and our claim — was adopted as this run's own completed step,
      // logged, and spent past. The window is exactly where a second wallet is
      // most likely to be active, which is why the check belongs on both paths
      // rather than the one that happened to be written first.
      const raceOwner = submissionSigner(chainOf(step), key, store)
      if (raceOwner && raceOwner.toLowerCase() !== account.toLowerCase()) {
        st.status = 'failed'
        st.message = `A transaction for ${st.label} was just sent by a different wallet. Nothing was sent from this wallet — reconnect the wallet that started it, or wait for it to settle.`
        return state.moneyMoved
          ? finishPartial(state, st.label, completed, fx, undefined, emit)
          : finishRefused(state, st.message, emit)
      }
      // A submission record with an id exists for OUR signer: money moved,
      // whatever happens next — the hydrate path says so at its own version of
      // this line, and this path did not (A6 review, 2026-08-07: a later
      // refusal then ended the run 'refused — nothing moved' with a resolved
      // completion in the same state object and NO exec-log row, law 5's
      // record lost on exactly one of the two resolve paths).
      state.moneyMoved = true
      st.status = 'submitted'
      emit()
      // Re-read for the id — and if the record VANISHED between the claim
      // answer and this read (the other tab resolved and cleared it), say the
      // honest thing: the outcome is unknown, not 'done' (A6 review: the old
      // fall-through marked the step done with resolve() never called, even
      // when the other tab's resolution was a failure).
      const raceMachine = hydrateSubmission(chainOf(step), key, store)
      if (raceMachine.phase !== 'submitted') {
        st.status = 'unresolved'
        st.message = `A transaction for ${st.label} was just completed elsewhere, and we could not read its outcome. Check your recent wallet activity before running anything further.`
        return finishPartial(state, st.label, completed, fx, undefined, emit)
      }
      const late = await resolveToTerminal(raceMachine, key, chainOf(step), fx, store, account, step.action.kind === 'bridge' ? BRIDGE_POLL_MAX_ATTEMPTS : POLL_MAX_ATTEMPTS)
      if (late.stop) {
        st.status = late.keepRecord ? 'unresolved' : 'failed'
        st.message = late.message
        return finishPartial(state, st.label, completed, fx, late.failedLegIndex, emit)
      }
      st.status = 'done'
      completed.push(key)
      recordStepCompletion(key, nowMs(fx), store) // LAW 14b — this leg is bought
      emit()
      continue
    }
    if (claim === 'held-by-other-tab') {
      st.status = 'failed'
      st.message = `Another tab is already sending ${st.label}. Nothing was sent from here — finish it there, or close that tab and try again.`
      return state.moneyMoved
        ? finishPartial(state, st.label, completed, fx, undefined, emit)
        : finishRefused(state, st.message, emit)
    }
    // ⚠ CLAIMED, BUT UNPROTECTED (the owner's ruling, 2026-08-08). No storage at all
    // means no cross-tab protection exists to be had, so the run proceeds — but
    // it says so BEFORE the wallet is asked rather than implying an exclusivity
    // it cannot know. Refusing here would lock every privacy-mode user out to
    // prevent a case that needs two tabs in one such session, and the in-memory
    // reducer already makes the single-tab double buy unrepresentable. One note,
    // once per run: repeating it per step would train people to ignore it.
    if (claim === 'claimed-unprotected' && !state.notes.some((n) => n.includes('second tab'))) {
      state.notes.push(
        'This browser is not letting us save anything, so we cannot tell if you have this open in a second tab. Do not run this in more than one tab at a time — we would not be able to stop the same purchase happening twice.',
      )
      emit()
    }
    if (claim === 'store-unreadable') {
      // LAW 12, RE-CHECKED AT THE CLAIM SEAM (2026-08-07, found closing R6's
      // pin). The door check ran on the store as it stood BEFORE the run; this
      // row appeared during it — the same race window as R6, wearing a row we
      // cannot read (or a book past its ceiling). It may be a live submission
      // of this very step, so claiming over it is the double-buy. The message
      // does NOT suggest clearing saved data: mid-run, live money's record may
      // be among what would be cleared.
      st.status = 'failed'
      st.message =
        'The saved records of transactions here changed while this ran, in a way we cannot trust, so we cannot tell whether something is already in progress. Nothing further was sent. Check your wallet activity before trying again.'
      return state.moneyMoved
        ? finishPartial(state, st.label, completed, fx, undefined, emit)
        : finishRefused(state, st.message, emit)
    }
    if (claim === 'held-ambiguous') {
      // An earlier attempt asked a wallet to submit this very step and never
      // got an answer — a transaction MAY be in flight with no id to poll
      // (A6 review, 2026-08-07). Time does not resolve that, so the claim
      // does not expire, and running again here is the retry-that-buys-twice.
      st.status = 'failed'
      // ⚠ NOT "clear this site's data" (A6 verify pass, 2026-08-07): that is
      // the only release mechanism today, and it destroys every OTHER step's
      // live submission record in the same blob — advice that can lose real
      // in-flight money. The targeted per-step release is an acknowledgment
      // surface the panel does not have yet (filed with the `dup:` records and
      // the quarantine exit, which need the same one), so the sentence says
      // what is true and stops there.
      // ⚠ AND IT DOES NOT CLAIM WHOSE ATTEMPT IT WAS: the ambiguous hold is
      // signer-blind by design (fail closed), so "an earlier attempt" is the
      // honest phrasing — it may have been another wallet in another tab.
      st.message = `An earlier attempt to send ${st.label} never answered clearly, so its transaction may still be in flight. Nothing was sent from here. Check your wallet's activity — if the transaction is there, it went through.`
      return state.moneyMoved
        ? finishPartial(state, st.label, completed, fx, undefined, emit)
        : finishRefused(state, st.message, emit)
    }

    // sign — and LAW 3: the record is written in the same tick as the id.
    st.status = 'awaiting-signature'
    emit()
    machine = submissionReducer(machine, { type: 'attempt' })
    let submitted: { submissionId: string; rung: number }
    // THE CLAIM HEARTBEAT (UIGuy's round-10 finding): the prompt dwell
    // routinely outruns CLAIM_TTL_MS, so while OUR wallet promise is
    // unresolved the claim is renewed — expiry then measures holder
    // liveness (a dead tab stops renewing), not human reading speed. The
    // interval dies in finally on every path, including throw.
    const pulse =
      typeof setInterval === 'function'
        ? setInterval(() => {
            // ⚠ THE HEARTBEAT'S ANSWER WAS DISCARDED (adversarial pass,
            // 2026-08-08). renewClaim reports whether the renewal actually
            // persisted, and nothing read it — so on a store that had started
            // dropping writes the claim silently aged out while the prompt was
            // open, and another tab took it. We cannot fix the store from
            // inside a timer, but we can stop pretending: once a renewal
            // fails, the claim is no longer ours to rely on, so the pulse
            // stops rather than continuing to imply liveness it does not have.
            // The step still completes on its own terms; what ends is the
            // false signal to other tabs.
            if (!renewClaim(chainOf(step), key, account, nowMs(fx), store) && pulse != null) clearInterval(pulse)
          }, CLAIM_HEARTBEAT_MS)
        : null
    try {
      submitted = await fx.submit(step, sim)
    } catch (e) {
      // ⚠⚠ LAW 10 APPLIED TO submit(), WHICH IT NEVER WAS (review, 2026-08-07).
      // This catch released the claim on EVERY throw and reported the step
      // failed — so a transport error out of `sendTransaction` AFTER the wallet
      // broadcast read to the user as "nothing was sent", and the retry they
      // were invited to make submitted the same batch again. `resolve` has
      // always treated a throw as "no answer"; `submit` treated it as "no".
      //
      // A throw is only proof of nothing-sent when the thrower SAYS it is.
      // Definitive = the thrower said so, OR it is a user decline, which is
      // unambiguous however it is wrapped: the human answered before anything
      // was broadcast. Everything else is ambiguity and must hold the claim.
      const definitive =
        (e instanceof RunnerRefusal && e.certainty === 'nothing-sent') || isUserRejection(e)
      if (!definitive) {
        // AMBIGUOUS: something may be in flight. Keep the claim and the record,
        // say so plainly, and do NOT offer a clean retry — the next instance
        // hydrates and resolves rather than re-submitting.
        //
        // ⚠ AND THE CLAIM MUST NOT EXPIRE (A6 review, 2026-08-07). This run is
        // ending: no heartbeat will renew, no id will ever be recorded, and at
        // +90s the plain claim was legally taken over — the user, invited to
        // retry, bought the same thing twice. The store header's "by then it
        // has an id" consolation is structurally false on this path, so the
        // claim is marked AMBIGUOUS, which claimStep refuses to expire or
        // take over until a human releases it.
        // ⚠ THE ANSWER WAS IGNORED ON THE PRIMARY PATH (adversarial pass,
        // 2026-08-08). markClaimAmbiguous returns whether the mark landed, and
        // the OTHER call site reads it while this one — the production route
        // for "your wallet did not answer clearly" — threw it away. An
        // unmarked claim is one the sweep drops at +90s, after which a retry
        // buys the same thing twice, which is the exact outcome this block
        // exists to prevent.
        const markedHere = markClaimAmbiguous(chainOf(step), key, account, nowMs(fx), store)
        st.status = 'unresolved'
        st.message = markedHere
          ? messageOf(e)
          : `${messageOf(e)} We also could not record that this is unresolved, so nothing here will stop a second attempt — do not retry until you have checked your wallet activity.`
        // Treat the money as POSSIBLY MOVED, because we cannot prove it did
        // not — that is what makes this terminal `partial` rather than
        // `refused`, and it is what stops a later step spending again.
        state.moneyMoved = true
        return finishPartial(state, st.label, completed, fx, undefined, emit)
      }
      // RELEASE THE CLAIM: the wallet answered definitively before submitting,
      // so nothing is in flight and the step must not stay locked.
      clearSubmission(chainOf(step), key, store, account)
      st.status = 'failed'
      st.message = messageOf(e)
      return state.moneyMoved
        ? finishPartial(state, st.label, completed, fx, undefined, emit)
        : finishRefused(state, st.message, emit)
    } finally {
      if (pulse != null) clearInterval(pulse)
    }
    try {
      recordSubmission({
        chainId: chainOf(step),
        stepKey: key,
        rung: submitted.rung,
        submissionId: submitted.submissionId,
        signer: account,
        atMs: nowMs(fx),
      }, store)
    } catch {
      // The wallet ANSWERED — money is in flight — but the record failed its
      // own read-back validation (a non-compliant id past every bound we
      // sized for the spec; see recordSubmission). Nothing can protect this
      // submission from a remount now, so the run stops honestly instead of
      // proceeding on an unprotected book (A6 review, 2026-08-07) — and the
      // claim is marked AMBIGUOUS so it cannot expire into a retry that buys
      // the same thing twice at +90s.
      // ⚠⚠ THIS LINE COULD DELETE ITS OWN RECOVERY (CRITICAL, independent pass
      // 2026-08-08). It validated the SAME `nowMs(fx)` recordSubmission had just
      // rejected, and it THREW — so the throw escaped this catch and every line
      // below was skipped: no 'unresolved', no message, no surfaced id, and a
      // plain claim left behind that the sweep drops at +90s, after which the
      // next run re-submits and reports done. markClaimAmbiguous returns rather
      // than throws now, and falls back to the existing validated stamp,
      // because the FLAG is the safety property and the timestamp is not.
      const marked = markClaimAmbiguous(chainOf(step), key, account, nowMs(fx), store, submitted.rung)
      st.status = 'unresolved'
      // ⚠ SURFACE THE ID (A6 verify pass, 2026-08-07). The wallet DID answer
      // here — the id just failed the record's own bounds — and dropping it
      // told the user to "check your wallet activity" while withholding the
      // one identifier that would let them do it. It rides the panel's own
      // field, not the sentence, so nothing unbounded reaches shown text.
      st.submissionId = submitted.submissionId
      // AND THE TWO CASES READ DIFFERENTLY, because they are different amounts
      // of danger. Marked: the claim is held, so nothing here retries by itself.
      // Unmarked: we could not even record the ambiguity, so this step CAN
      // expire into a retry — the user is the only remaining guard and must be
      // told plainly rather than given the softer sentence.
      st.message = marked
        ? 'This went to your wallet, but we could not save the record that protects it from being sent twice. Check your wallet activity before running anything here again.'
        : 'This went to your wallet, and we could not save any record of it — not even a note that it is unresolved. Do not run this again until you have checked your wallet activity: we cannot stop a second attempt from sending the same money.'
      state.moneyMoved = true
      return finishPartial(state, st.label, completed, fx, undefined, emit)
    }
    machine = submissionReducer(machine, { type: 'submitted', submissionId: submitted.submissionId, signer: account })
    state.moneyMoved = true
    st.status = 'submitted'
    st.submissionId = submitted.submissionId
    emit()

    const done = await resolveToTerminal(machine, key, chainOf(step), fx, store, account, step.action.kind === 'bridge' ? BRIDGE_POLL_MAX_ATTEMPTS : POLL_MAX_ATTEMPTS)
    if (done.stop) {
      st.status = done.keepRecord ? 'unresolved' : 'failed'
      st.message = done.message ?? 'We could not confirm this step, so nothing further was sent.'
      st.failedLegIndex = done.failedLegIndex
      return finishPartial(state, st.label, completed, fx, done.failedLegIndex, emit)
    }
    st.status = 'done'
    completed.push(key)
    recordStepCompletion(key, nowMs(fx), store) // LAW 14b — this leg is bought
    emit()
  }

  state.phase = 'done'
  // LAW 14's write half: the full cycle is DONE, so it leaves the stamp its
  // own records can no longer provide. Partial runs never stamp — their
  // unresolved records are the guard, and stamping would double-refuse a
  // legitimate completion of the remainder.
  recordCycleCompletion(planCycleDigest(state.steps), nowMs(fx), store)
  fx.writeExecLog({ partial: false, completedSteps: completed })
  emit()
  return state
}

/** LAW 14's plan identity: the step keys, sorted and digested. Two arms are
 *  "the same plan" exactly when they would make the same steps — stepKeyOf
 *  already binds each step's action, chain, asset and amount, so a changed
 *  amount or leg set changes the digest and passes the guard. Sorted: the
 *  guard asks "same money", and order is not money.
 *
 *  ⚠ 64-BIT, NOT 32 (audit F1, 2026-08-13). A single 32-bit FNV collided among
 *  ORDINARY dollar amounts (a $4,882.89 and a $10,755.14 buy hashed equal), and
 *  on a money guard a collision is a FALSE REFUSAL of a genuinely different
 *  buy. Two FNV passes with different seeds give 64 bits — collision space
 *  ~2^-64, negligible for the handful of plans one browser ever completes —
 *  and 16 hex chars stays well under the stamp's MAX_STEP_KEY_LEN bound. */
function planCycleDigest(steps: readonly { key: string }[]): string {
  const joined = steps.map((s) => s.key).sort().join('|')
  const fnv = (seed: number): string => {
    let h = seed
    for (let i = 0; i < joined.length; i++) {
      h ^= joined.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  return `cycle:${fnv(0x811c9dc5)}${fnv(0x9e3779b1)}`
}

/** Poll a submitted step to a terminal answer. NEVER falls back to another
 *  rung: an ambiguous submission holds (the ladder's own safety law), and a
 *  resolved failure is final on its rung because the money may have partially
 *  moved. The record clears only on a terminal answer. */
async function resolveToTerminal(
  machine: SubmissionState,
  key: string,
  chainId: number,
  fx: RunnerEffects,
  store: RunnerStore,
  /** The account whose step this is — threaded through so the record it clears
   *  is proven to be ITS OWN (adversarial pass, 2026-08-08: a release with no
   *  owner check deleted another tab's in-flight submission record). */
  account: Address,
  /** Per-kind budget: bridges pass BRIDGE_POLL_MAX_ATTEMPTS (they are slow by
   *  nature); everything else defaults to the 4-minute bound. */
  maxAttempts: number = POLL_MAX_ATTEMPTS,
): Promise<{
  machine: SubmissionState
  stop: boolean
  message?: string
  failedLegIndex?: number
  /** True when the submission is still unresolved: the record must SURVIVE so
   *  the next instance can resolve it (law 9's stop + the no-TTL law). */
  keepRecord?: boolean
}> {
  if (machine.phase !== 'submitted') return { machine, stop: false }
  const id = machine.submissionId
  for (let attempt = 0; ; attempt += 1) {
    if (attempt >= maxAttempts) {
      // LAW 9's stop: we do not know, and time passing has not made us know.
      // The record STAYS (no-TTL law) so the next instance resolves it, and we
      // say the honest thing rather than guessing either outcome.
      return {
        machine,
        stop: true,
        message:
          'We could not confirm whether this went through. It may still be pending — check your wallet activity before trying again; nothing further was sent.',
        keepRecord: true,
      }
    }
    if (attempt > 0) await pause(fx, POLL_INTERVAL_MS)
    // LAW 10 — a throw is ambiguity, not an answer. An RPC blip must not end
    // the run: it used to escape the runner entirely, leaving no record.
    let answer: Awaited<ReturnType<RunnerEffects['resolve']>>
    try {
      answer = await fx.resolve(id)
    } catch {
      answer = null
    }
    if (answer === null) {
      // still unknown — HOLD. The reducer rejects anything else from here, and
      // that rejection is the double-buy guard, so we let it enforce itself.
      try {
        machine = submissionReducer(machine, { type: 'ambiguous-silence' } as SubmissionEvent)
      } catch (e) {
        if (e instanceof ForbiddenFallback) return { machine, stop: true, message: e.message }
        throw e
      }
      continue
    }
    if (answer.ok) {
      machine = submissionReducer(machine, { type: 'resolved-success' })
      clearSubmission(chainId, key, store, account)
      return { machine, stop: false }
    }
    machine = submissionReducer(machine, { type: 'resolved-failure', reason: answer.message })
    // ⚠ R3 (review 2026-08-07): this cleared the record on EVERY resolved
    // failure — including the wallet's own "part of this batch went through"
    // code and a confirmed batch whose receipts show a revert. In both, money
    // MOVED, and clearing the record let a retry re-send the legs that already
    // landed. A partial failure keeps its record; only a total one releases.
    // The reducer's own comment already said "the money may have partially
    // moved; the runner surfaces it and the user decides" — but the store, the
    // only thing with a lifetime, had already forgotten by the time they did.
    //
    // ⚠ TWO DIFFERENT THINGS, and conflating them mislabels the step: the step
    // genuinely FAILED (we resolved it; the outcome is known), while the RECORD
    // must survive (money moved, so a retry must not re-send). `keepRecord`
    // drives the 'unresolved' label and is for AMBIGUITY, so it stays false
    // here — we simply skip the clear.
    const partiallyExecuted = answer.partial === true || answer.failedLegIndex != null
    if (!partiallyExecuted) clearSubmission(chainId, key, store, account)
    return { machine, stop: true, message: answer.message, failedLegIndex: answer.failedLegIndex }
  }
}

function finishPartial(
  state: RunState,
  stoppedAt: string,
  completed: string[],
  fx: RunnerEffects,
  failedLegIndex: number | undefined,
  emit: () => void,
): RunState {
  // LAW 5 — money moved, so a record exists no matter how this ended. No cause
  // is claimed: the leg index is all the chain gives us.
  state.phase = 'partial'
  state.notes.push(
    failedLegIndex != null
      ? `This run stopped at ${stoppedAt}. One part of it (leg ${failedLegIndex + 1}) did not go through, and the chain does not tell us why. What completed before it is recorded below.`
      : `This run stopped at ${stoppedAt}. What completed before it is recorded below; nothing after it was sent.`,
  )
  fx.writeExecLog({ partial: true, stoppedAt, failedLegIndex, completedSteps: completed })
  emit()
  return state
}

function finishRefused(state: RunState, message: string, emit: () => void): RunState {
  // Nothing moved, so nothing is logged — a run that never started is not
  // history, and an empty row would pollute the record the chart reads.
  state.phase = 'refused'
  state.notes.push(message)
  emit()
  return state
}

function messageOf(e: unknown): string {
  if (e instanceof RunnerRefusal) return e.message
  if (e instanceof Error && e.message) return e.message
  return 'This step could not be completed, and no reason was reported.'
}

/** The clock, injected via the effects' own boundary so this module stays
 *  clock-free for tests (the house purity law). */
function nowMs(fx: RunnerEffects): number {
  return fx.nowMs?.() ?? Date.now()
}

async function pause(fx: RunnerEffects, ms: number): Promise<void> {
  if (fx.sleep) return fx.sleep(ms)
  await new Promise<void>((r) => setTimeout(r, ms))
}

function safeWindowStore(): RunnerStore {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
