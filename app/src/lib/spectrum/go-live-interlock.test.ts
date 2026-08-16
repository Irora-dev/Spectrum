import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// THE GO-LIVE INTERLOCK — the wiring commit cannot skip its preconditions.
//
// Everything dangerous in this lane is LATENT: SIMULATED = true and the 0x
// compose path is dark, so every known defect waits for one wiring commit and
// lands at once. "The checklist lives in the dossier" is a sentence; this file
// is the checklist as a GATE. The moment either flag flips in source, the
// suite fails unless every precondition below is met — so the flip and the
// preconditions must land together, reviewed together.
//
// THE CHECKER IS PURE and unit-tested against synthetic inputs (flip + unmet →
// fail; flip + met → pass; flags safe → pass), because the real flags are safe
// today and a gate that has never fired is a banner (A3's lesson: bite-test
// the gates). The integration half binds it to the REAL source text.
//
// NOT CHECKED HERE, stated per the output-grammar law: the d2b87be step-key
// deploy caveat (long-intent keys must not straddle a live deploy) is an
// OPERATIONAL ordering, invisible to source; it stays in the release ritual.
// ─────────────────────────────────────────────────────────────────────────────

// ⚠ THE DIGEST'S SCOPE IS ITS CLAIM (F2). These are the money-core modules a
// review of this lane actually reads; a clean row vouches for THIS set, and any
// change to any of them expires the streak. Widening the set makes reviews
// expire more often, which is the safe direction; narrowing it would let a
// clean row vouch for code nobody read.
const SRC = import.meta.glob(
  [
    '/src/lib/spectrum/allocation.ts',
    '/src/lib/spectrum/portfolio-batcher.ts',
    '/src/lib/spectrum/open-findings.test.ts',
    '/src/lib/spectrum/plan-legs.ts',
    '/src/lib/spectrum/execution-runner.ts',
    '/src/lib/spectrum/submission-store.ts',
    '/src/lib/spectrum/assemble-batch.ts',
    '/src/lib/spectrum/batcher.ts',
    '/src/lib/spectrum/floor-discipline.ts',
    '/src/lib/spectrum/displayed-vs-signed.ts',
    '/src/lib/spectrum/funding-plan.ts',
    '/src/lib/spectrum/pool-safety.ts',
    '/src/lib/spectrum/runner-effects.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

/** The ledger's RAW text — the parsed object cannot reveal a duplicated key. */
const LEDGER_RAW = import.meta.glob(['/src/lib/spectrum/review-ledger.json'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** The sacred-systems registry (F9): the two constants that gate all live money
 *  were absent from it while a feature toggle was present. */
const SACRED = import.meta.glob(['/../sacred-paths.json'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** The owner's digest-pinned review waiver, when one exists (2026-08-16 ruling,
 *  recorded in the ops harness decisions log). Absent or unreadable = no waiver — the bar
 *  stands. It lives BESIDE the ledger it stands in for and SHIPS with the tree
 *  on purpose: the public release-proof runs this same suite from a fresh
 *  clone, and a gate that is only green on the maintainer's machine is not a
 *  gate. Sacred path, same F9 logic as the ledger. */
const WAIVER = import.meta.glob(['/src/lib/spectrum/review-waiver.json'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const glob2 = import.meta.glob(['/src/**/release-surface*', '/src/components/**/ReleaseSurface*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

import reviewLedger from './review-ledger.json'
import sweepStateRaw from './mutation-sweep-state.json?raw'
import triageRaw from './mutation-triage.json?raw'
import sweepScriptRaw from '/scripts/mutation-sweep.mjs?raw'

/** How many A12 targets are NOT swept-clean, computed the same way the closed
 *  desk-236 registry row computed it. Web Crypto, not node:crypto — a browser
 *  tsconfig carries no node types, and the suite going green while `tsc -b`
 *  fails is a lesson this repo has already paid for twice. */
async function countNotCleanTargets(): Promise<number | null> {
  try {
    const state = JSON.parse(sweepStateRaw) as {
      swept: Record<string, { digest: string; survivors: { sig: string }[] }>
    }
    const triage = JSON.parse(triageRaw) as { triaged: Record<string, unknown> }
    const targets = [...sweepScriptRaw.matchAll(/^ {2}'?([a-z-]+)'?:\s*\[/gm)].map((m) => m[1])
    // a target list we could not parse would score ZERO not-clean and read as a
    // pass — refuse instead
    if (targets.length < 5) return null
    let notClean = 0
    for (const t of targets) {
      const rec = state.swept?.[t]
      const src = SRC[`/src/lib/spectrum/${t}.ts`]
      if (!rec || src === undefined) { notClean += 1; continue }
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src))
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
      if (`sha256:${hex.slice(0, 16)}` !== rec.digest) { notClean += 1; continue }
      if (rec.survivors.some((s) => !/^[a-z-]+:\d+:\d+:.+$/.test(s.sig) || !(s.sig in triage.triaged))) notClean += 1
    }
    return notClean
  } catch {
    return null // unreadable is a violation, never a pass
  }
}
const notCleanTargets = await countNotCleanTargets()

export interface InterlockFacts {
  simulated: boolean
  zeroexComposeEnabled: boolean
  openFindingRows: number
  m2PolicyRuled: boolean
  fullCyclePolicyRuled: boolean
  releaseSurfaceExists: boolean
  /** EVERY ledger row, unfiltered and untyped, newest last — or null when the
   *  ledger is not an array at all. Unfiltered because F4 measured what
   *  pre-filtering costs: self rows were dropped BEFORE the streak was read, so
   *  a self row WITH FINDINGS was deleted rather than resetting anything. */
  lastTwoReviews: LedgerRow[] | null
  /** A change-digest of the money core as it stands NOW (F2). */
  moneyDigest: string
  /** How many top-level `"rows"` keys the RAW ledger text has (F8). null = not
   *  supplied by this caller. */
  ledgerRawRowsKeys: number | null
  /** Money-core targets that are NOT swept-clean by A12: never recorded,
   *  recorded against bytes that have since changed, or holding a survivor with
   *  no verdict in mutation-triage.json. **null = could not be established**,
   *  which is a violation and never a pass — the read-failed law.
   *
   *  Arrived when the desk-236-M10/M11 registry row closed (2026-08-07). That
   *  row's own rule is that a closed finding is promoted into a real pin and the
   *  row deleted — and deleting it without a home would have retired the only
   *  thing checking the sweep had run at all. It belongs HERE rather than in the
   *  standing suite because the digest is byte-level: a comment edit in
   *  batcher.ts expires its record, and a suite that goes red on a comment until
   *  someone spends minutes re-sweeping is a control that gets switched off. At
   *  the flip, that same strictness is exactly what you want. */
  moneyCoreNotClean: number | null
  /** The owner's DIGEST-PINNED waiver of precondition 5 (2026-08-16 ruling,
   *  recorded in the ops harness decisions log; file: review-waiver.json beside the ledger).
   *  null = no waiver or unreadable — fail closed, the bar stands. It waives
   *  ONLY the clean-row demand, only while the money core still digests to the
   *  ruled value — the F2 law applied to the waiver itself. */
  reviewWaiverDigest: string | null
}

/** The pure law: which preconditions block a live flip, and why. */
export function interlockViolations(f: InterlockFacts): string[] {
  const wantsLive = !f.simulated || f.zeroexComposeEnabled
  if (!wantsLive) return []
  const v: string[] = []
  if (f.openFindingRows > 0)
    v.push(`the open-findings registry still holds ${f.openFindingRows} row(s) — a known defect may not go live latently; fix it or get it explicitly accepted and remove the row`)
  if (!f.m2PolicyRuled)
    v.push('the M2 concentration policy is unruled — the fixpoint can hand one leg the whole batch and nothing decides what happens then (ask q-1786112460254-114)')
  if (!f.fullCyclePolicyRuled)
    v.push('the full-cycle-inside-simulate guard is unruled — two tabs can buy the same intent twice (ask q-1786112477630-115)')
  if (!f.releaseSurfaceExists)
    v.push('the human release surface does not exist — dup:/ambiguous/quarantined records would have NO exit except clear-site-data, which destroys live records')
  if (f.moneyCoreNotClean == null)
    v.push('the A12 sweep state could not be read — "we cannot tell whether the money core was swept" is not "it was swept"')
  else if (f.moneyCoreNotClean > 0)
    v.push(`${f.moneyCoreNotClean} money-core target(s) are not swept-clean — unswept, swept against bytes that have since changed, or holding a survivor nobody has given a verdict (run scripts/mutation-sweep.mjs, then triage into mutation-triage.json)`)
  // ── PRECONDITION 5 — TWO CONSECUTIVE INDEPENDENT CLEAN PASSES ─────────────
  // R's go-live bar, made structural — and rewritten after SpectrumContracts
  // measured FIVE ways the first cut could be satisfied without one. Each
  // guard below names the finding it closes, because every one of them was a
  // shape someone would write in good faith, not an attack.
  //
  // The ledger must be READABLE at all (F8/shape): a duplicated top-level
  // "rows" key parses last-wins, so the parsed object cannot reveal it.
  if (f.lastTwoReviews == null) {
    v.push('the review ledger has no readable rows — an unreadable ledger is not a clean streak')
    return v
  }
  if (f.ledgerRawRowsKeys != null && f.ledgerRawRowsKeys !== 1) {
    v.push(`the review ledger declares "rows" ${f.ledgerRawRowsKeys} times — a duplicated key parses last-wins, so what the gate reads is not what a human reads`)
    return v
  }

  // ── THE 2026-08-16 OWNER WAIVER (digest-pinned, one-shot) ──────────────────
  // "i dont want an independent review just scrub it now and then push" — the
  // owner, 2026-08-16, recorded in the ops harness decisions log. The same lawful
  // amendment channel as the 2026-08-14 one-pass ruling: the bar's TEXT changes
  // in the open, its INPUTS are never forged (the 08-14 fabricate-a-row order
  // was refused; this is the ruling mechanism that replaced it). The waiver
  // carries the exact money digest it was ruled against and is void the moment
  // the core moves — F2 applied to the waiver itself, so it can never become a
  // permanent global token. It stands in for the STREAK only: the ledger-shape
  // integrity checks above still bind (corruption is not a review demand), and
  // every other precondition bites unchanged. R counter-rules by deleting
  // review-waiver.json (it lives beside review-ledger.json); this branch then
  // never fires and the bar is back, whole, with all its fixtures still live below.
  if (f.reviewWaiverDigest != null && f.reviewWaiverDigest === f.moneyDigest) return v

  // ⚠ NO PRE-FILTERING (F4). The tail rows are taken AS THEY STAND, so a
  // self row with findings RESETS the streak instead of vanishing from it. A
  // self row can never SATISFY the bar; it can absolutely BREAK it, which is
  // the honest reading of "the streak resets on any real finding" — a sentence
  // my own doc made and the old code falsified.
  //
  // ⚠ THE BAR IS ONE PASS — RULED (the owner, 2026-08-14, decisions/LOG.md:
  // "I rule the rehearsal flip's review precondition down to ONE pass,
  // superseding R's two-pass structure pending his objection"). This amends
  // R's 2026-08-07 two-consecutive-passes design IN THE OPEN — the gate's
  // text changed by a recorded ruling, its inputs were not forged. Everything
  // else the streak law learned (F2 digest pinning, F3 numeric findings, F4
  // self-row resets, F5 allowlist, F7 chronology) binds unchanged on the one
  // row. If R counter-rules, this constant and its fixtures revert together.
  const REQUIRED_CLEAN_PASSES = 1
  const lastTwo = f.lastTwoReviews.slice(-REQUIRED_CLEAN_PASSES)
  if (lastTwo.length < REQUIRED_CLEAN_PASSES) {
    v.push(`the go-live bar is ${REQUIRED_CLEAN_PASSES} INDEPENDENT clean pass(es) (the owner ruling 2026-08-14, supersedes the two-pass structure pending R) — the review ledger holds only ${lastTwo.length} row(s)`)
    return v
  }

  // F7: rows must be CHRONOLOGICAL, or the streak can be produced by reordering
  // rows that already exist. `at` must be present and non-decreasing across the
  // whole ledger, not just the tail.
  const stamps = f.lastTwoReviews.map((r) => (typeof r.at === 'string' ? r.at : ''))
  if (stamps.some((t) => t === '')) v.push('a review-ledger row has no readable date — without chronology the last two rows are just the last two LINES, and reordering would manufacture a streak')
  else if (stamps.some((t, i) => i > 0 && t < stamps[i - 1])) v.push('the review-ledger rows are not in chronological order — the streak must be the two most recent passes, not the two bottom lines')

  for (const [i, r] of lastTwo.entries()) {
    const who = norm(r.reviewer)
    // F3: `findings > 0` permitted "3 (all fixed)", "three", null and an ABSENT
    // key. My own existing row is findings:3 with "(all fixed)" in its notes,
    // so annotating the number is the natural thing to write.
    if (typeof r.findings !== 'number' || !Number.isFinite(r.findings)) {
      v.push(`review-ledger row ${i + 1} of the last two has no numeric findings count (${JSON.stringify(r.findings)}) — a count that is not a number cannot be zero`)
      continue
    }
    if (r.findings !== 0) {
      v.push('the last two passes did not both come back clean — the streak resets on any real finding, so a fresh pass is owed before a live flip')
      continue
    }
    // F5: an ALLOWLIST, because a self: prefix is a convention the reviewer
    // applies to itself, and the authoring lane unprefixed satisfied the old bar.
    if (who === AUTHORING_LANE || !INDEPENDENT_REVIEWERS.includes(who as (typeof INDEPENDENT_REVIEWERS)[number])) {
      v.push(`review-ledger row ${i + 1} names "${String(r.reviewer)}", which is not a recognised INDEPENDENT reviewer — a clean row can only come from a lens that is not this one`)
      continue
    }
    // F2: a findings:0 row was a PERMANENT GLOBAL TOKEN — it vouched for all
    // future commits, including the wiring commit, which by construction cannot
    // have been reviewed because it does not exist when the review is written.
    // The row must carry the money core AS REVIEWED, and it must still match.
    if (typeof r.moneyDigest !== 'string' || r.moneyDigest === '') {
      v.push(`review-ledger row ${i + 1} carries no moneyDigest — a clean pass that does not say WHICH code it read vouches for code nobody looked at`)
    } else if (r.moneyDigest !== f.moneyDigest) {
      v.push(`review-ledger row ${i + 1} reviewed a different money core (${String(r.moneyDigest)} vs ${f.moneyDigest} now) — the code moved after the pass, so the pass no longer covers it`)
    }
  }

  // F6 (distinct lenses) applies only when the bar wants MORE than one pass —
  // with the ruled one-pass bar there is no pair to compare. The normalised
  // comparison is kept for the day R restores the two-pass structure.
  if (REQUIRED_CLEAN_PASSES > 1 && norm(lastTwo[0].reviewer) === norm(lastTwo[1].reviewer) && norm(lastTwo[0].reviewer) !== '')
    v.push(`both clean passes on record are from the SAME reviewer (${String(lastTwo[0].reviewer)}) — the bar wants DISTINCT lenses, because repeated eyes share blind spots`)
  return v
}

/** Read the facts from real source text. Named markers are the contract:
 *  CONCENTRATION_POLICY / RECENT_COMPLETION_WINDOW_MS are what the rulings
 *  will land as (the interlock is those names' spec, same as the registry). */
/**
 * READ A BOOLEAN FLAG FROM SOURCE — and the hard part is not reading it.
 *
 * ⚠⚠ F1 CRITICAL (SpectrumContracts, 2026-08-07, REPRODUCED in their own node
 * run): the old reader used `.exec()` on an UNANCHORED pattern, so it took the
 * FIRST TEXTUAL MATCH rather than the effective declaration. Write the flip the
 * way a human documents a flip —
 *
 *     // was: export const SIMULATED = true   (pre-Phase-3)
 *     export const SIMULATED = false
 *
 * — and the reader returns "true", `wantsLive` is false, and
 * `interlockViolations` returns `[]` AT ITS FIRST LINE. All five preconditions
 * skipped, the ledger never even read, the suite green. ONE COMMENT LINE, in the
 * same commit as the flip, converted a five-part gate into decoration.
 *
 * AND MY ROT-DETECTOR COULD NOT SEE IT, which is the lesson: it asserted only
 * that the pattern MATCHED, and the decoy makes it match. The COUNT was the
 * check that was missing. `portfolio-batcher.ts` had the mirror image (a
 * commented `= false` above a real `= true`).
 *
 * So: ANCHOR to a line start (which excludes comment and string lines, because
 * `// was: export …` does not begin with `export`), and demand EXACTLY ONE
 * match. Zero matches or two-or-more is UNREADABLE, and unreadable is LIVE —
 * that asymmetry is what held in the review (24 of 27 constructed forms armed
 * the gate correctly), so it is preserved deliberately.
 */
export function readFlag(text: string, name: string): 'true' | 'false' | 'unreadable' {
  const pattern = new RegExp(`^[\\t ]*export const ${name} = (true|false)\\b`, 'gm')
  const hits = [...text.matchAll(pattern)]
  if (hits.length !== 1) return 'unreadable' // 0 = gone/renamed, 2+ = a decoy
  return hits[0][1] as 'true' | 'false'
}

/** Reviewers whose rows may satisfy the streak. An ALLOWLIST, because F5
 *  measured the alternative: `/^self:/i` is a convention the reviewer applies to
 *  ITSELF, and " self:harness" (one leading space), "self-harness",
 *  "selfharness", null, and even `[specallocator:0, SpectrumContracts:0]` — the
 *  authoring lane unprefixed — all PERMITTED a flip. The gate did not know what
 *  the authoring lane is called. Now it does, and anything unrecognised cannot
 *  satisfy the bar (it still RESETS it — see F4). */
// 'owner'/'cofounder' are the two human principals' review seats (renamed from
// personal names 2026-08-16, public-repo hygiene; NO ledger row had used either
// id, so no history moved — the append-only law is untouched).
export const INDEPENDENT_REVIEWERS = ['spectrumcontracts', 'coldreviewer', 'bulletrain', 'marlo', 'zane', 'owner', 'cofounder'] as const
/** This lane — the AUTHOR of the money core, whose rows can never satisfy the
 *  bar. ⚠ MOVED 2026-08-14: the owner reassigned the whole portfolio-execution
 *  build to UIGuy (2026-08-13, "do all of the execution/portfolio code needed
 *  here instead of on specallocator") and retired specallocator outright the
 *  next day — so 'uiguy' is now the authoring lane and came OFF the reviewer
 *  list, where it had legitimately sat while specallocator authored. The two
 *  principals joined the list instead: either human can take a review seat
 *  (they did not write this code). A lane that inherits authorship must make
 *  this same swap in the SAME commit as the inheritance — a stale authoring
 *  constant quietly re-admits author-self-review. */
export const AUTHORING_LANE = 'uiguy'

const norm = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase() : '')

export interface LedgerRow {
  at?: unknown
  reviewer?: unknown
  findings?: unknown
  /** A change-digest of the money core AS REVIEWED (F2). */
  moneyDigest?: unknown
}

/** FNV-1a over the money-core sources. A CHANGE detector, not a cryptographic
 *  seal — it exists so a clean row cannot vouch for code that has moved since.
 *  Stated plainly because calling it a seal would be this lane's usual sin. */
export function moneyCoreDigest(src: Record<string, string>): string {
  const keys = Object.keys(src).sort()
  let h = 0x811c9dc5
  for (const k of keys) {
    for (const ch of `${k}\u0000${src[k] ?? ''}\u0001`) {
      h ^= ch.charCodeAt(0)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return h.toString(16).padStart(8, '0')
}

export function readInterlockFacts(
  src: Record<string, string>,
  surfaces: Record<string, string>,
  rawLedger?: string,
  moneyCoreNotClean: number | null = null,
  rawWaiver?: string,
): InterlockFacts {
  // the waiver parses STRICTLY or not at all — a malformed waiver is no waiver
  let reviewWaiverDigest: string | null = null
  try {
    const w = JSON.parse(rawWaiver ?? '') as { digest?: unknown }
    if (typeof w.digest === 'string' && /^[0-9a-f]{8}$/.test(w.digest)) reviewWaiverDigest = w.digest
  } catch {
    /* absent or corrupt = the bar stands */
  }
  const alloc = src['/src/lib/spectrum/allocation.ts'] ?? ''
  const pb = src['/src/lib/spectrum/portfolio-batcher.ts'] ?? ''
  const registry = src['/src/lib/spectrum/open-findings.test.ts'] ?? ''
  // an unreadable flag is a LIVE flag — fail closed, never "could not check"
  const simulated = readFlag(alloc, 'SIMULATED')
  const compose = readFlag(pb, 'ZEROEX_COMPOSE_ENABLED')
  const rows = (reviewLedger as { rows?: unknown }).rows
  return {
    simulated: simulated === 'true',
    zeroexComposeEnabled: compose !== 'false',
    openFindingRows: (registry.match(/it\.fails\(/g) ?? []).length,
    m2PolicyRuled: /CONCENTRATION_POLICY/.test(src['/src/lib/spectrum/plan-legs.ts'] ?? ''),
    fullCyclePolicyRuled: /RECENT_COMPLETION_WINDOW_MS/.test((src['/src/lib/spectrum/execution-runner.ts'] ?? '') + (src['/src/lib/spectrum/submission-store.ts'] ?? '')),
    releaseSurfaceExists: Object.keys(surfaces).length > 0,
    lastTwoReviews: Array.isArray(rows) ? (rows as LedgerRow[]) : null,
    moneyDigest: moneyCoreDigest(src),
    // F8: a duplicated top-level "rows" key parses as last-wins, so the parsed
    // object cannot show it. Only the RAW text can.
    ledgerRawRowsKeys: rawLedger == null ? null : (rawLedger.match(/^\s*"rows"\s*:/gm) ?? []).length,
    moneyCoreNotClean,
    reviewWaiverDigest,
  }
}

describe('the interlock law itself (pure, so the gate is proven to bite before it is ever needed)', () => {
  const DIGEST = 'deadbeef'
  const clean = (reviewer: string, at: string) => ({ at, reviewer, findings: 0, moneyDigest: DIGEST })
  const MET: InterlockFacts = {
    simulated: false,
    zeroexComposeEnabled: true,
    openFindingRows: 0,
    m2PolicyRuled: true,
    fullCyclePolicyRuled: true,
    releaseSurfaceExists: true,
    lastTwoReviews: [clean('SpectrumContracts', '2026-08-08'), clean('ColdReviewer', '2026-08-09')],
    moneyDigest: DIGEST,
    ledgerRawRowsKeys: 1,
    moneyCoreNotClean: 0,
    reviewWaiverDigest: null,
  }

  it('a live flip with every precondition met passes', () => {
    expect(interlockViolations(MET)).toEqual([])
  })

  it('a live flip with ANY precondition unmet names each violation in a sentence', () => {
    expect(interlockViolations({ ...MET, openFindingRows: 2 })).toHaveLength(1)
    expect(interlockViolations({ ...MET, m2PolicyRuled: false })[0]).toMatch(/concentration policy/)
    expect(interlockViolations({ ...MET, fullCyclePolicyRuled: false })[0]).toMatch(/full-cycle/)
    expect(interlockViolations({ ...MET, releaseSurfaceExists: false })[0]).toMatch(/release surface/)
    expect(interlockViolations({ ...MET, moneyCoreNotClean: 3 })[0]).toMatch(/3 money-core target\(s\) are not swept-clean/)
  })

  it('an UNREADABLE sweep state blocks the flip — not knowing is not knowing it is fine', () => {
    // The read-failed law on the newest precondition. null is the value a
    // corrupt state file, a renamed target list or a parse error produces, and
    // every one of them must refuse rather than score zero not-clean and pass.
    expect(interlockViolations({ ...MET, moneyCoreNotClean: null })[0]).toMatch(/could not be read/)
    expect(interlockViolations({ ...MET, moneyCoreNotClean: 0 })).toEqual([])
  })

  it('EITHER flag alone arms the gate — the 0x path going live is a live flip', () => {
    expect(interlockViolations({ ...MET, simulated: true, zeroexComposeEnabled: true, openFindingRows: 1 })).toHaveLength(1)
    expect(interlockViolations({ ...MET, simulated: false, zeroexComposeEnabled: false, openFindingRows: 1 })).toHaveLength(1)
  })

  it('while both flags are safe the gate stands down — it exists for the flip, not for today', () => {
    expect(
      interlockViolations({ ...MET, simulated: true, zeroexComposeEnabled: false, openFindingRows: 9, m2PolicyRuled: false, releaseSurfaceExists: false, lastTwoReviews: [] }),
    ).toEqual([])
  })

  // ─── EVERY SHAPE SpectrumContracts MEASURED AS PERMITTING A FLIP ───────────
  // Each of these PASSED the first cut. They are not adversarial curiosities:
  // every one is what somebody writes in good faith, which is what made the
  // gate dangerous rather than merely incomplete.
  describe('F3 — a findings count that is not the number zero', () => {
    it('rejects an annotated count, a word, null, and an ABSENT key', () => {
      for (const bad of ['3 (all fixed)', '2 open / 1 fixed', 'three', null, undefined, 0.5, Number.NaN]) {
        const rows = [clean('ColdReviewer', '2026-08-08'), { ...clean('SpectrumContracts', '2026-08-09'), findings: bad }]
        const v = interlockViolations({ ...MET, lastTwoReviews: rows as never })
        expect(v.length, `findings=${JSON.stringify(bad)} must not permit`).toBeGreaterThan(0)
      }
      // and the KEY absent entirely — my own row style annotates the number, so
      // this is the natural thing to write, not a hostile one
      const noKey = [clean('ColdReviewer', '2026-08-08'), { at: '2026-08-09', reviewer: 'SpectrumContracts', moneyDigest: DIGEST }]
      expect(interlockViolations({ ...MET, lastTwoReviews: noKey as never }).length).toBeGreaterThan(0)
    })
  })

  describe('F4 — a self row must RESET the streak, not vanish from it', () => {
    it('two clean rows followed by a self row WITH findings does not permit', () => {
      const rows = [clean('SpectrumContracts', '2026-08-08'), clean('ColdReviewer', '2026-08-09'), { at: '2026-08-10', reviewer: 'self:mutation-sweep', findings: 5, moneyDigest: DIGEST }]
      const v = interlockViolations({ ...MET, lastTwoReviews: rows })
      expect(v.length, 'the old code DELETED this row instead of letting it break the streak').toBeGreaterThan(0)
    })
    it('and a self row with ZERO findings still cannot satisfy the bar', () => {
      const rows = [clean('SpectrumContracts', '2026-08-08'), { at: '2026-08-09', reviewer: 'self:pipeline-harness', findings: 0, moneyDigest: DIGEST }]
      expect(interlockViolations({ ...MET, lastTwoReviews: rows }).length).toBeGreaterThan(0)
    })
  })

  describe('F5 — the reviewer must be a RECOGNISED independent lens', () => {
    it('rejects the self: convention being dodged by spacing or spelling', () => {
      for (const who of [' self:harness', 'self-harness', 'selfharness', 'harness (self:pipeline)', '', null]) {
        const rows = [clean('SpectrumContracts', '2026-08-08'), { at: '2026-08-09', reviewer: who, findings: 0, moneyDigest: DIGEST }]
        expect(interlockViolations({ ...MET, lastTwoReviews: rows as never }).length, `reviewer=${JSON.stringify(who)}`).toBeGreaterThan(0)
      }
    })
    it('rejects THE AUTHORING LANE naming itself, which the old bar accepted unprefixed', () => {
      const rows = [clean('SpectrumContracts', '2026-08-08'), { at: '2026-08-09', reviewer: 'specallocator', findings: 0, moneyDigest: DIGEST }]
      expect(interlockViolations({ ...MET, lastTwoReviews: rows }).length).toBeGreaterThan(0)
    })
  })

  describe('F6 — distinct lenses, DORMANT at the ruled one-pass bar', () => {
    it('with one required pass there is no pair to compare — the check stands down, documented, not deleted', () => {
      // the owner's 2026-08-14 ruling took the bar to ONE pass; a same-named pair
      // is no longer a violation because only the tail row is the bar. The
      // comparison survives in code behind REQUIRED_CLEAN_PASSES > 1 so R's
      // counter-ruling restores it by changing one constant.
      for (const twin of ['SpectrumContracts ', 'spectrumcontracts', 'SPECTRUMCONTRACTS']) {
        const rows = [clean('SpectrumContracts', '2026-08-08'), { at: '2026-08-09', reviewer: twin, findings: 0, moneyDigest: DIGEST }]
        expect(interlockViolations({ ...MET, lastTwoReviews: rows }).some((x) => /SAME reviewer/.test(x)), `twin=${twin}`).toBe(false)
      }
    })
  })

  describe('F2 — a clean row vouches for the code it READ, not for all future code', () => {
    it('a row whose moneyDigest no longer matches does not permit', () => {
      expect(interlockViolations({ ...MET, moneyDigest: 'c0ffee11' }).some((x) => /reviewed a different money core/.test(x))).toBe(true)
    })
    it('a row with NO moneyDigest does not permit — it cannot say what it read', () => {
      const rows = [clean('ColdReviewer', '2026-08-08'), { at: '2026-08-09', reviewer: 'SpectrumContracts', findings: 0 }]
      expect(interlockViolations({ ...MET, lastTwoReviews: rows as never }).some((x) => /no moneyDigest/.test(x))).toBe(true)
    })
  })

  describe('F7 — the streak is the two most recent passes, not the two bottom lines', () => {
    it('rows out of chronological order do not permit', () => {
      const rows = [clean('SpectrumContracts', '2026-08-09'), clean('ColdReviewer', '2026-08-08')]
      expect(interlockViolations({ ...MET, lastTwoReviews: rows }).some((x) => /chronological/.test(x))).toBe(true)
    })
    it('a row with no date does not permit — reordering would manufacture a streak', () => {
      const rows = [{ reviewer: 'SpectrumContracts', findings: 0, moneyDigest: DIGEST }, clean('ColdReviewer', '2026-08-09')]
      expect(interlockViolations({ ...MET, lastTwoReviews: rows as never }).some((x) => /no readable date/.test(x))).toBe(true)
    })
  })

  describe('F8 — a duplicated rows key parses last-wins', () => {
    it('the gate refuses when the RAW ledger declares "rows" more than once', () => {
      expect(interlockViolations({ ...MET, ledgerRawRowsKeys: 2 }).some((x) => /declares "rows" 2 times/.test(x))).toBe(true)
    })
    it('and refuses an unreadable ledger outright', () => {
      expect(interlockViolations({ ...MET, lastTwoReviews: null }).some((x) => /no readable rows/.test(x))).toBe(true)
    })
  })

  describe('the 2026-08-16 owner waiver — digest-pinned, never a permanent token', () => {
    // a ledger whose newest row reviewed a DIFFERENT core: exactly tonight's
    // shape, and exactly what the waiver was ruled to stand in for
    const STALE: InterlockFacts = {
      ...MET,
      lastTwoReviews: [clean('SpectrumContracts', '2026-08-08'), { at: '2026-08-09', reviewer: 'SpectrumContracts', findings: 0, moneyDigest: '0ld1d1g3' }],
    }
    it('a waiver at EXACTLY the live digest stands in for the row', () => {
      expect(interlockViolations({ ...STALE, reviewWaiverDigest: DIGEST })).toEqual([])
    })
    it('a waiver for a DIFFERENT digest waives nothing — the core moved, the waiver died (F2 for waivers)', () => {
      expect(interlockViolations({ ...STALE, reviewWaiverDigest: 'c0ffee11' }).length).toBeGreaterThan(0)
    })
    it('no waiver = the bar stands — fail closed, absent and unreadable are the same answer', () => {
      expect(interlockViolations({ ...STALE, reviewWaiverDigest: null }).length).toBeGreaterThan(0)
    })
    it('the waiver waives ONLY the row — every other precondition still bites', () => {
      expect(interlockViolations({ ...STALE, reviewWaiverDigest: DIGEST, openFindingRows: 1 })).toHaveLength(1)
      expect(interlockViolations({ ...STALE, reviewWaiverDigest: DIGEST, moneyCoreNotClean: 2 }).length).toBeGreaterThan(0)
      expect(interlockViolations({ ...STALE, reviewWaiverDigest: DIGEST, ledgerRawRowsKeys: 2 }).length).toBeGreaterThan(0)
      expect(interlockViolations({ ...STALE, reviewWaiverDigest: DIGEST, lastTwoReviews: null }).length).toBeGreaterThan(0)
    })
  })
})

// ─── F1 — THE FLAG READER, the CRITICAL ─────────────────────────────────────
describe('readFlag — the decoy that made the whole gate a no-op', () => {
  it('THE REPRODUCTION: a commented "was:" line above the real flip', () => {
    const decoyed = ['// was: export const SIMULATED = true   (pre-Phase-3)', 'export const SIMULATED = false', ''].join('\n')
    // the OLD reader took the first textual match and returned "true", which
    // made wantsLive false and skipped all five preconditions
    expect(/export const SIMULATED = (true|false)/.exec(decoyed)?.[1], 'the old reader, for the record').toBe('true')
    // the new one sees TWO candidate lines… no: the comment line is not
    // anchored-matchable, so it sees exactly one — the real one
    expect(readFlag(decoyed, 'SIMULATED')).toBe('false')
  })

  it('a REAL second declaration is unreadable, not first-wins', () => {
    const two = ['export const SIMULATED = true', 'export const SIMULATED = false'].join('\n')
    expect(readFlag(two, 'SIMULATED')).toBe('unreadable')
  })

  it('comment and string decoys in every arrangement cannot be read as the flag', () => {
    for (const decoy of [
      '// export const SIMULATED = true',
      '  // was: export const SIMULATED = true',
      '/* export const SIMULATED = true */',
      ' * export const SIMULATED = true',
      'const doc = "export const SIMULATED = true"',
      '// export const ZEROEX_COMPOSE_ENABLED = false',
    ]) {
      const text = [decoy, 'export const SIMULATED = false', 'export const ZEROEX_COMPOSE_ENABLED = true'].join('\n')
      expect(readFlag(text, 'SIMULATED'), decoy).toBe('false')
    }
  })

  it('an absent or renamed flag is UNREADABLE, which the law treats as LIVE', () => {
    expect(readFlag('', 'SIMULATED')).toBe('unreadable')
    expect(readFlag('export const SIMULATED_V2 = true', 'SIMULATED')).toBe('unreadable')
    expect(readFlag('export let SIMULATED = true', 'SIMULATED')).toBe('unreadable')
    expect(readFlag('export const SIMULATED = someExpr', 'SIMULATED')).toBe('unreadable')
  })

  it('leading tabs/spaces on the real declaration still read', () => {
    expect(readFlag('\texport const SIMULATED = false', 'SIMULATED')).toBe('false')
    expect(readFlag('   export const SIMULATED = true', 'SIMULATED')).toBe('true')
  })

  it('and it does not confuse one flag for another', () => {
    const both = ['export const SIMULATED = true', 'export const ZEROEX_COMPOSE_ENABLED = false'].join('\n')
    expect(readFlag(both, 'SIMULATED')).toBe('true')
    expect(readFlag(both, 'ZEROEX_COMPOSE_ENABLED')).toBe('false')
  })
})

describe('the interlock bound to the REAL source', () => {
  const facts = readInterlockFacts(SRC, glob2, Object.values(LEDGER_RAW)[0], notCleanTargets, Object.values(WAIVER)[0])

  it('the flags read as EXACTLY ONE declaration each — the count is the check the old canary was missing', () => {
    // ⚠ THE OLD CANARY ASSERTED ONLY THAT THE PATTERN MATCHED, and the F1 decoy
    // makes it match. Asserting the resolved VALUE (not the match) is what makes
    // this a canary rather than a comfort: a decoy line now yields 'unreadable'
    // or the wrong literal here, loudly, in the file being edited.
    // FLIPPED 2026-08-14 with the flip commit: the canary now pins the LIVE
    // values — a decoy still reads 'unreadable', and a silent re-darkening
    // reads as the wrong literal here, loudly, in the file being edited.
    expect(readFlag(SRC['/src/lib/spectrum/allocation.ts'], 'SIMULATED')).toBe('false')
    expect(readFlag(SRC['/src/lib/spectrum/portfolio-batcher.ts'], 'ZEROEX_COMPOSE_ENABLED')).toBe('true')
  })

  it('PRINTS THE MONEY-CORE DIGEST a reviewer must record — otherwise the requirement is unmeetable', () => {
    // A gate that demands a value nobody can obtain is a gate that gets worked
    // around. Run the suite, copy this line into the ledger row.
    // eslint-disable-next-line no-console
    console.log(`\n  moneyDigest for a ledger row written against THIS tree: ${facts.moneyDigest}\n`)
    expect(facts.moneyDigest).toMatch(/^[0-9a-f]{8}$/)
  })

  it('F9 — the two constants that gate all live money are SACRED paths', () => {
    // they were absent while features.ts WAS present: a feature toggle carried
    // more release ceremony than the flags that decide whether real money moves
    const sacred = Object.values(SACRED)[0] ?? ''
    expect(sacred, 'sacred-paths.json not readable from here').not.toBe('')
    for (const path of ['app/src/lib/spectrum/allocation.ts', 'app/src/lib/spectrum/portfolio-batcher.ts', 'app/src/lib/spectrum/review-ledger.json']) {
      expect(sacred.includes(path), `${path} must be a sacred path — it gates live money`).toBe(true)
    }
  })

  it('GO-LIVE PRECONDITIONS — fails on the wiring commit until each is met', () => {
    const violations = interlockViolations(facts)
    expect(violations, violations.join('\n')).toEqual([])
  })

  // ── THE RATCHET (item 6) ────────────────────────────────────────────────────
  // "2 expected fail" in the gate line must not normalize upward silently. The
  // count is pinned to a LITERAL: retiring a row means lowering the literal in
  // the same commit as the fix; ADDING a row means raising it with the finding
  // stated in the commit message. Either way the change is visible and chosen.
  it('the open-findings registry holds exactly the acknowledged count', () => {
    // 1 → 0 on 2026-08-12: desk-204 (provenance half) closed with the
    // execute-station arming — seedBookOwner landed in allocation.ts and the
    // pins were promoted (allocation.test.ts + execution-arming.test.ts).
    expect(facts.openFindingRows).toBe(0)
  })
})
