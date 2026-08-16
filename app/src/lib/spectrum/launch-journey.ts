// ─────────────────────────────────────────────────────────────────────────────
// THE LAUNCH JOURNEY — a basket launch is not a transaction, it is a JOURNEY.
//
// the owner, 2026-08-13: "this flow of the create basket is crucial, you should
// ALWAYS be guided through the entire setup, and even if you accidentally
// refresh or click off you should always be able to resume from your creator
// page or /create."
//
// Every step of that journey already existed — pick assets, shape weights, name
// it, deploy, seed it (a fresh basket has ZERO supply and cannot be entered
// in-kind until somebody buys), write its thesis, share it. Nothing tracked the
// WHOLE, so a refresh mid-way lost the thread and a deployed-but-unseeded
// basket looked finished when it was not. This module is the whole.
//
// ── THE CRITICAL LAW: DERIVE FROM TRUTH, NOT FROM A LOCAL CHECKLIST ──────────
// A local flag that says "seeded" LIES after a device switch or a failed tx. So
// every step's completion is read where that step is actually knowable, and
// this module never reads chain state itself — the caller hands it READINGS,
// each of which can say "I did not answer":
//
//   deployed  ← the basket exists on chain, with this wallet as the factory's
//               registered deployer (BasketSummary.deployer, from the factory's
//               `tokens(address)` view).
//   seeded    ← BasketData.effectiveSupply — the house's own unseeded predicate
//               (SeedBasketModal, TradePanel and DexSwapCard all test
//               `effectiveSupply === 0`). It is chosen over totalSupply for one
//               reason that is the whole point of this module: effectiveSupply
//               is `null` when the view REVERTED and `0` when the basket is
//               genuinely empty, so it can tell "could not read" from "nobody
//               has bought in". aumUsd and navPerToken cannot — both read 0 on
//               an unseeded basket AND on a basket whose pricing simply failed,
//               which is exactly how a surface starts lying.
//   thesis    ← the SpectrumNotes registry, read as EVENTS (notes-social's
//               fetchNotesCached, kind `thesis`, author = the deployer). NOT
//               useCreatorMeta: resolveCreatorMeta catches a failed registry
//               read and falls through to `null`, so its null means both "no
//               thesis" and "the read failed" — it has already thrown away the
//               distinction this module exists to keep. The event read returns
//               `null` for could-not-read and `[]` for genuinely-none.
//   shared    ← THE ONLY LOCAL ONE. A stamp on this device, labelled as a local
//               nicety in its own evidence string, never as a fact about the
//               world, and never allowed to hold a journey open (it is the one
//               `optional` step).
//
// localStorage may hold the DRAFT (pre-deploy, where it is the only truth there
// is) and pointers. It may never hold a claim about chain state.
//
// A read that DID NOT ANSWER produces status 'unknown', never 'done' and never
// 'todo' — the house honesty law: an absent read is not a zero, and a surface
// is told to say "couldn't read" instead of naming a next step as fact.
//
// Shape follows handle-registry's HandleLookup: a discriminated union whose
// 'unknown' arm carries its own `why`.
// ─────────────────────────────────────────────────────────────────────────────

/** A fact that came from somewhere that can fail to answer. */
export type Reading<T> = { status: 'read'; value: T } | { status: 'unread'; why: string }

export const read = <T>(value: T): Reading<T> => ({ status: 'read', value })
export const unread = <T>(why: string): Reading<T> => ({ status: 'unread', why })

/** The journey, in order. `build` and `deploy` are one act from the outside
 *  (you are building until it is on chain) but they are separate truths: a
 *  draft has neither, a deployed basket has both. */
export const STEP_ORDER = ['build', 'deploy', 'seed', 'thesis', 'share'] as const
export type StepId = (typeof STEP_ORDER)[number]

/** 'unknown' is a first-class outcome, not an error: it is what an unanswered
 *  read produces, and it is why a surface can be honest instead of guessing. */
export type StepStatus = 'done' | 'todo' | 'unknown'

export interface JourneyStep {
  id: StepId
  status: StepStatus
  /** WHERE this status came from — the receipt. Every status names its source,
   *  so nothing in this model can present a guess as a fact. */
  evidence: string
  /** A step whose absence does not hold the launch open. Only `share`: it is
   *  local-only, so leaving it undone must never keep a resume banner up
   *  forever on a basket that is fully live. */
  optional?: true
}

/** What one journey is about. */
export type JourneySubject =
  | { kind: 'draft'; draft: DraftRef }
  | { kind: 'basket'; basket: BasketRef }

export interface Journey {
  /** Stable identity for keys and dedupe: `draft:<storage key>` for a draft,
   *  `<chainId>:<address lowercased>` for a basket. */
  id: string
  subject: JourneySubject
  steps: JourneyStep[]
  /** The first step that is not done, `share` INCLUDED — what the post-deploy
   *  card points at. null when literally everything is done. */
  next: StepId | null
  /** The first step that is not done and not optional — what a RESUME surface
   *  offers. null when nothing required is outstanding. */
  resumeAt: StepId | null
  /** A required step could not be read. A surface showing this journey must say
   *  so; it may not name a next step as fact. */
  uncertain: boolean
  /** Every required step is done AND nothing is unknown. */
  complete: boolean
}

// ── the inputs ───────────────────────────────────────────────────────────────

/** A standing pre-deploy draft, as found in storage. */
export interface DraftRef {
  /** 'composer' — the cross-network mix (`spectrum:composer-draft:v1`).
   *  'builder' — the deploy studio's chain-scoped draft. */
  kind: 'composer' | 'builder'
  /** The exact storage key it was read from — this draft's receipt. */
  key: string
  /** A builder draft's chain. null for a composer draft, which spans chains. */
  chainId: number | null
  /** The predecessor a version-mode builder draft descends from, else null. */
  predecessor: string | null
  name: string
  symbol: string
  assetCount: number
  /** The picked tickers, for the card's one line. Raw — the surface bounds
   *  them through showSymbol, the way every other shown symbol is bounded. */
  symbols: string[]
  /** Unix ms the draft was written, when the row carried one. */
  savedAt: number | null
}

/** A deployed basket of the wallet's own, plus the readings that say how far
 *  its journey got. The caller does the reading; this module does the judging. */
export interface BasketRef {
  chainId: number
  address: string
  name: string
  symbol: string
  /** effectiveSupply() — THE seed truth. `unread` when the view reverted or the
   *  basket read never landed; a failed read is never a zero. */
  supply: Reading<number>
  /** The basket's on-chain note text ('' when the registry answered and there
   *  is none) — THE thesis truth. `unread` when it did not answer. */
  thesis: Reading<string>
  /** A stamp on THIS DEVICE saying the creator shared it. A local nicety. */
  sharedLocally: boolean
}

// ── the judging ──────────────────────────────────────────────────────────────

const shortAddr = (a: string) => (a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/** A standing draft: nothing is on chain, so nothing downstream is readable.
 *  Every step past `build` is `todo` because the basket does not exist yet —
 *  that is a fact about the draft, not a guess about a basket. */
export function journeyOfDraft(draft: DraftRef): Journey {
  const where = draft.kind === 'composer' ? 'the composer mix' : 'the deploy studio'
  const steps: JourneyStep[] = [
    {
      id: 'build',
      status: 'todo',
      evidence: `a draft stands in ${draft.key} (${where}, ${draft.assetCount} asset${draft.assetCount === 1 ? '' : 's'})`,
    },
    { id: 'deploy', status: 'todo', evidence: `nothing deployed from this draft — the flow clears it when it does` },
    { id: 'seed', status: 'todo', evidence: 'no basket yet — nothing to read' },
    { id: 'thesis', status: 'todo', evidence: 'no basket yet — nothing to read' },
    { id: 'share', status: 'todo', evidence: 'no basket yet — nothing to share', optional: true },
  ]
  return assemble(`draft:${draft.key}`, { kind: 'draft', draft }, steps)
}

/** A deployed basket: build and deploy are settled by its EXISTENCE, and the
 *  two steps that follow are settled by the two reads. */
export function journeyOfBasket(basket: BasketRef): Journey {
  const on = `the basket exists on chain (${shortAddr(basket.address)}, chain ${basket.chainId})`
  const steps: JourneyStep[] = [
    { id: 'build', status: 'done', evidence: on },
    { id: 'deploy', status: 'done', evidence: on },
    seedStep(basket.supply),
    thesisStep(basket.thesis),
    {
      id: 'share',
      status: basket.sharedLocally ? 'done' : 'todo',
      evidence: basket.sharedLocally
        ? 'a stamp on this device only — a local nicety, not a fact about the world'
        : 'not stamped on this device (a local nicety; other devices are not consulted)',
      optional: true,
    },
  ]
  return assemble(`${basket.chainId}:${basket.address.toLowerCase()}`, { kind: 'basket', basket }, steps)
}

function seedStep(supply: Reading<number>): JourneyStep {
  if (supply.status === 'unread')
    return { id: 'seed', status: 'unknown', evidence: `effectiveSupply could not be read (${supply.why})` }
  // NaN is neither > 0 nor a trustworthy zero — a decoder that hands one over
  // must produce 'unknown', never "nobody has bought in".
  if (!Number.isFinite(supply.value))
    return { id: 'seed', status: 'unknown', evidence: 'effectiveSupply came back as a non-number' }
  // A negative supply is not a thing on chain, but one arriving must not read
  // as "seeded" — anything not strictly positive is "nobody has bought in".
  if (supply.value > 0)
    return { id: 'seed', status: 'done', evidence: `effectiveSupply is ${supply.value} — it has been bought into` }
  return { id: 'seed', status: 'todo', evidence: 'effectiveSupply is 0 — nobody has bought in yet' }
}

function thesisStep(thesis: Reading<string>): JourneyStep {
  if (thesis.status === 'unread')
    return { id: 'thesis', status: 'unknown', evidence: `the note registry could not be read (${thesis.why})` }
  if (thesis.value.trim().length > 0)
    return { id: 'thesis', status: 'done', evidence: 'a note is published on chain for this basket' }
  return { id: 'thesis', status: 'todo', evidence: 'the note registry answered — no thesis published yet' }
}

function assemble(id: string, subject: JourneySubject, steps: JourneyStep[]): Journey {
  const required = steps.filter((s) => !s.optional)
  const next = steps.find((s) => s.status !== 'done')?.id ?? null
  const resumeAt = required.find((s) => s.status !== 'done')?.id ?? null
  const uncertain = required.some((s) => s.status === 'unknown')
  return {
    id,
    subject,
    steps,
    next,
    resumeAt,
    uncertain,
    complete: !uncertain && required.every((s) => s.status === 'done'),
  }
}

// ── the wallet's whole picture ───────────────────────────────────────────────

/** Seed first, then thesis — a creator with several loose ends is offered the
 *  one that blocks the basket, not the one that happens to sort first. */
const URGENCY: Record<string, number> = { seed: 0, thesis: 1, build: 2, deploy: 2, share: 3 }

/** …and anything UNREADABLE sorts behind all of it. "We couldn't check" is
 *  worth saying, and it is never worth saying FIRST: a creator with one real
 *  loose end and one basket on a quiet RPC should be handed the loose end. It
 *  stays in the list so a creator whose only news is "we couldn't read your
 *  basket" still hears it rather than meeting a silent page. */
const rank = (j: Journey): number => (j.uncertain ? 100 : (URGENCY[j.resumeAt ?? 'share'] ?? 9))

/**
 * Every launch this wallet has in flight, freshest draft first and then the
 * deployed baskets by what they still need. Drafts lead because a draft is the
 * one thing that disappears if it is forgotten.
 */
export function launchJourneys(input: {
  drafts: readonly DraftRef[]
  baskets: readonly BasketRef[]
}): Journey[] {
  // A DRAFT WHOSE BASKET WENT LIVE IS FINISHED BUSINESS (the owner live
  // 2026-08-15: TEST100 deployed, and the card still said "finish building
  // it"). A live basket wearing the draft's ticker — the launch's own
  // grouping key — retires the draft from every resume surface; the basket's
  // journey (seed → thesis → share) takes over. Case-insensitive; an empty
  // draft ticker never matches anything.
  const liveTickers = new Set(input.baskets.map((b) => b.symbol.trim().toUpperCase()).filter((x) => x.length > 0))
  for (const t of deployedTickerSet()) liveTickers.add(t)
  const drafts = [...input.drafts]
    .filter((d) => {
      const t = (d.symbol ?? '').trim().toUpperCase()
      return t.length === 0 || !liveTickers.has(t)
    })
    .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
    .map(journeyOfDraft)
  const baskets = input.baskets.map(journeyOfBasket).sort((a, b) => rank(a) - rank(b))
  return [...drafts, ...baskets]
}

/** The subset a resume surface offers: something required is outstanding, or
 *  something required could not be read (which is itself worth saying). */
export function inProgressLaunches(input: {
  drafts: readonly DraftRef[]
  baskets: readonly BasketRef[]
}): Journey[] {
  return launchJourneys(input).filter((j) => j.resumeAt != null || j.uncertain)
}

export function stepOf(journey: Journey, id: StepId): JourneyStep {
  // STEP_ORDER is the whole domain and every constructor emits all of it, so
  // this cannot miss — the fallback exists so callers need no null check.
  return journey.steps.find((s) => s.id === id) ?? { id, status: 'unknown', evidence: 'step not modelled' }
}

// ── the copy ─────────────────────────────────────────────────────────────────

/** What each step IS, in the creator's words. */
export const STEP_LABEL: Record<StepId, string> = {
  build: 'Finish building it',
  deploy: 'Deploy it',
  seed: 'Seed it — make the first buy',
  thesis: 'Write its thesis',
  share: 'Share it',
}

/** Why the step matters — the one line under the title. */
export const STEP_WHY: Record<StepId, string> = {
  build: 'your picks and weights are saved',
  deploy: 'ship it on chain as an immutable basket',
  seed: 'the first buy opens it',
  thesis: 'say what it holds and why',
  share: 'the link carries the whole basket',
}

// ── the storage half: DRAFTS (where localStorage IS the truth) ───────────────
//
// A pre-deploy draft is the one thing localStorage may legitimately speak for:
// nothing is on chain yet, so the browser is not a cache of a fact, it IS the
// fact. Both keys below already exist and already persist — this module only
// FINDS them; it does not write them and does not own their shapes.
//
//   spectrum:composer-draft:v1                    pages/Composer.tsx (its
//                                                 COMPOSER_DRAFT_KEY, ~line 112)
//   spectrum:launch-draft:v2:<chainId>            components/launch/
//   spectrum:launch-draft:v2:<chainId>:from:<pred>  BasketBuilder.tsx (its
//                                                 DRAFT_PREFIX/draftKey, ~442)
//
// Both owners keep their loaders module-private, so the key STRINGS are the
// shared contract. They are restated here once, next to the file and symbol
// that own them, and pinned by a test — which is the cheapest drift alarm
// available short of those files exporting them.

export const COMPOSER_DRAFT_KEY = 'spectrum:composer-draft:v1'

// ── THE DEPLOYED-TICKER STAMP (the owner live 2026-08-15, twice: "I already
// deployed it and it hasn't detected it"). The live-list retirement is right
// but not sufficient — on a DEV surface the basket list can serve fixtures,
// and any list read LAGS the deploy by construction. So the deploy moment
// itself writes the ticker here, and journeys retire drafts against the
// UNION of live tickers and this stamp. localStorage: surviving a reload is
// the whole point. Capped so it can never grow unbounded. ──
const DEPLOYED_TICKERS_KEY = 'spectrum:deployed-tickers:v1'

export function markTickerDeployed(symbol: string): void {
  const t = symbol.trim().toUpperCase()
  if (!t) return
  try {
    const cur = deployedTickerSet()
    cur.add(t)
    localStorage.setItem(DEPLOYED_TICKERS_KEY, JSON.stringify([...cur].slice(-200)))
  } catch {
    /* storage unavailable — the live-list retirement still applies */
  }
  // and the composer draft dies WITH the deploy when it wears this ticker —
  // hiding the card while the row survived was the ghost's second life.
  //
  // ⚠ UNLESS AN INTERRUPTED PUBLISH RUN IS RIDING ON IT (create-flow recovery
  // audit, 2026-08-15): on a multi-network publish this stamp used to fire on
  // the FIRST lane landing and delete the draft — but the draft is exactly
  // what the ceremony's resume needs to recompute the subject match, so a
  // refresh mid-run orphaned the remaining lanes (deploys 2..N unreachable).
  // While a persisted landed-lanes row holds an unfinished run, the draft IS
  // the resume door and stays; the row clears on publish completion and the
  // ghost protection resumes. Reads the sibling module's storage row directly
  // rather than importing it (keeps both modules import-free).
  try {
    const rowRaw = localStorage.getItem('spectrum:landed-lanes:v1')
    if (rowRaw) {
      const row = JSON.parse(rowRaw) as { lanes?: unknown[] }
      if (Array.isArray(row.lanes) && row.lanes.length > 0) return
    }
  } catch {
    /* unreadable row = no run to protect — fall through to the deletion */
  }
  try {
    const raw = localStorage.getItem(COMPOSER_DRAFT_KEY)
    if (raw) {
      const d = JSON.parse(raw) as { symbol?: unknown }
      if (typeof d.symbol === 'string' && d.symbol.trim().toUpperCase() === t) localStorage.removeItem(COMPOSER_DRAFT_KEY)
    }
  } catch {
    /* unreadable draft rows are someone else's problem, not this stamp's */
  }
}

export function deployedTickerSet(): Set<string> {
  try {
    const raw = localStorage.getItem(DEPLOYED_TICKERS_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
export const BUILDER_DRAFT_PREFIX = 'spectrum:launch-draft:v2:'
/** The local "I shared it" stamps. Local by nature — see the `share` step. */
export const SHARE_STAMP_KEY = 'spectrum:launch-shared:v1'

/** Just enough of Storage to read every key — allocation.ts's StorageLike, plus
 *  the enumeration the chain-scoped builder keys need. */
export type JourneyStorage = Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>

function safeStorage(): JourneyStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // Safari private mode, an embed with storage denied, SSR
  }
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Read one row into a DraftRef, or null when it is absent, corrupt or empty.
 *  Deliberately more forgiving than either owner's own validator: this decides
 *  whether to OFFER A RESUME, and a row too odd to describe is simply not
 *  offered — it is never repaired, and never handed on as a launch. */
function draftFromRow(key: string, raw: string | null): DraftRef | null {
  if (!raw) return null
  let row: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    row = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const assets = Array.isArray(row.assets) ? (row.assets as Record<string, unknown>[]) : null
  if (!assets) return null
  const name = asString(row.name)
  const symbol = asString(row.symbol)
  // BasketBuilder's own draftIsEmpty: no assets and no words is not a draft,
  // it is the residue of one. Offering it would be a door to a blank page.
  if (assets.length === 0 && !name.trim() && !symbol.trim()) return null

  const composer = key === COMPOSER_DRAFT_KEY
  let chainId: number | null = null
  let predecessor: string | null = null
  if (!composer) {
    // `<prefix><chainId>` or `<prefix><chainId>:from:<predecessor>`
    const tail = key.slice(BUILDER_DRAFT_PREFIX.length)
    const [chainPart, ...rest] = tail.split(':from:')
    const n = Number(chainPart)
    if (!Number.isInteger(n)) return null
    chainId = n
    predecessor = rest.length > 0 && rest[0] ? rest[0] : null
  }

  return {
    kind: composer ? 'composer' : 'builder',
    key,
    chainId,
    predecessor,
    name,
    symbol,
    assetCount: assets.length,
    symbols: assets.map((a) => asString(a?.symbol)).filter((s) => s.length > 0),
    savedAt: typeof row.savedAt === 'number' && Number.isFinite(row.savedAt) ? row.savedAt : null,
  }
}

/** Every standing pre-deploy draft in this browser, composer first. */
export function readLaunchDrafts(storage: JourneyStorage | null = safeStorage()): DraftRef[] {
  if (!storage) return []
  const out: DraftRef[] = []
  try {
    const composer = draftFromRow(COMPOSER_DRAFT_KEY, storage.getItem(COMPOSER_DRAFT_KEY))
    if (composer) out.push(composer)
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (!key || !key.startsWith(BUILDER_DRAFT_PREFIX)) continue
      const row = draftFromRow(key, storage.getItem(key))
      if (row) out.push(row)
    }
  } catch {
    return out // a storage that throws mid-enumeration yields what it gave
  }
  return out
}

const stampKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

/** The local share stamps, as a set of `<chainId>:<address>`. */
export function readShareStamps(storage: JourneyStorage | null = safeStorage()): Set<string> {
  if (!storage) return new Set()
  try {
    const raw = storage.getItem(SHARE_STAMP_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Stamp a basket as shared FROM THIS DEVICE. Never a claim about the world —
 *  see the `share` step's evidence string, which says so on the surface. */
export function markShared(
  chainId: number,
  address: string,
  storage: JourneyStorage | null = safeStorage(),
): void {
  if (!storage) return
  try {
    const stamps = readShareStamps(storage)
    stamps.add(stampKey(chainId, address))
    storage.setItem(SHARE_STAMP_KEY, JSON.stringify([...stamps]))
  } catch {
    /* storage unavailable — the stamp is a nicety, never a gate */
  }
}

export function hasShareStamp(stamps: ReadonlySet<string>, chainId: number, address: string): boolean {
  return stamps.has(stampKey(chainId, address))
}

/**
 * The one honest sentence a resume surface leads with — tested, because this is
 * exactly where a guess would show up as a fact. An unreadable journey says it
 * could not read, and names NO next step.
 */
export function resumeHeadline(journey: Journey): string {
  const subject =
    journey.subject.kind === 'draft'
      ? journey.subject.draft.name.trim() || 'your unnamed draft'
      : journey.subject.basket.name.trim() || journey.subject.basket.symbol.trim() || 'your basket'
  if (journey.uncertain) return `We couldn’t read where ${subject} got to — try again in a moment`
  if (journey.resumeAt == null) return `${subject} is live, seeded and has its thesis`
  return `${subject} — next: ${STEP_LABEL[journey.resumeAt].toLowerCase()}`
}
