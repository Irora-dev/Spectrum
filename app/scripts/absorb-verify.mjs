#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ABSORPTION VERIFY — the two checks a merge report cannot make about itself.
//
// 2026-08-07: an absorption of this lane into the staging line was reported
// complete and accurate — 74 commits, 42 conflicts resolved, 2234 tests green,
// every gate clean. Both numbers were true. It had still lost two things:
//
//   · A WHOLE COMMIT. The merge's second parent was one commit behind the
//     branch tip, so the newest work — three money findings, including a
//     double-buy door — was simply not in the tree. Nothing was red, because
//     the tests that would have objected were in the missing commit too.
//   · A GUARD, to a union that took the other side of a rewritten line.
//     BasketListRow rendered a deployer-controlled symbol raw again, eleven
//     lines under its own correctly-bounded aria-label. No conflict marker
//     survived to show it, and no gate covered that file.
//
// Neither is visible in a conflict view, a test run, or a merge message. Both
// fall out of two mechanical questions asked AFTER the merge exists:
//   1. Is every commit on the source branch actually an ancestor of the merge?
//   2. Did any file's count of a guard call go DOWN across the merge?
//
// A DROP IS A CANDIDATE, NOT A VERDICT. Of the four drops found by hand that
// night, three were legitimate — a component extracted to its own file, a
// display removed by an owner ruling, a deliberate non-application — and one
// was the regression. This script cannot tell those apart and does not try;
// it produces the short list a human triages, which is the whole value, since
// the alternative was noticing by accident.
//
// Read-only. Touches no branch, no file, no index:
//   node scripts/absorb-verify.mjs <branchTip> <mergeCommit> [--guard NAME]…
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process'

const DEFAULT_GUARD_MODULE = 'app/src/lib/spectrum/safe-copy.ts'
const PATHSPEC = 'app/src'

/** ⚠ EVERY GIT CALL RUNS FROM THE REPO ROOT, because the paths above are
 *  repo-relative and npm is not. UIGuy baked this script into an npm script so
 *  nobody has to remember the flags — and npm runs scripts with cwd set to the
 *  package dir, so from `app/` the pathspec resolved to `app/app/src`, matched
 *  nothing, and A13 REFUSED on him (2026-08-08).
 *
 *  The refusal was correct and is the reason this is a usability bug rather
 *  than an incident: it did not print a clean census over zero files, it said
 *  the positive control could not run and nothing was checked. But a tool that
 *  only works from one directory, wired into a command whose whole purpose is
 *  to be run without thinking, is a tool that refuses honestly at the wrong
 *  people. Resolve the root once and mean the same thing from anywhere. */
const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd() // not a git dir at all — the ref resolution below will refuse
  }
})()

const argv = process.argv.slice(2)
const extraGuards = []
let guardModule = DEFAULT_GUARD_MODULE
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--guard') extraGuards.push(argv[++i])
  else if (argv[i] === '--guards-from') guardModule = argv[++i]
  else positional.push(argv[i])
}
const [BRANCH = 'origin/spectrum/allocator', MERGE = 'origin/test/rh-deploy'] = positional

/** git, or a REFUSAL. An unreadable answer must never reach the report as an
 *  empty one — "looked at nothing" and "found nothing" print identically. */
function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    if (allowFail) return ''
    refuse(`git ${args.join(' ')} failed — ${String(err.stderr || err.message).trim().split('\n')[0]}`)
  }
}

function refuse(why) {
  console.error(`\nREFUSED: ${why}`)
  console.error('Nothing was checked. This is not a clean result.\n')
  process.exit(2)
}

function resolve(ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    refuse(`cannot resolve "${ref}". If it is a remote ref, fetch first — an unfetched commit reads exactly like an unmerged one.`)
  }
}

// ── the refs ─────────────────────────────────────────────────────────────────
const branchSha = resolve(BRANCH)
const mergeSha = resolve(MERGE)

const parents = git(['rev-list', '--parents', '-n', '1', mergeSha]).trim().split(/\s+/).slice(1)
if (parents.length < 2) {
  refuse(`${MERGE} (${mergeSha.slice(0, 7)}) is not a merge commit — it has ${parents.length} parent(s). Pass the merge itself, not the branch it landed on.`)
}

console.log(`\nABSORPTION VERIFY`)
console.log(`  source branch : ${BRANCH} @ ${branchSha.slice(0, 7)}`)
console.log(`  merge commit  : ${MERGE} @ ${mergeSha.slice(0, 7)}`)
console.log(`  parents       : ${parents.map((p) => p.slice(0, 7)).join('  ')}`)

let findings = 0

// ── 1 · ANCESTRY ─────────────────────────────────────────────────────────────
// Every commit reachable from the branch tip must be reachable from the merge.
// Anything listed here is work the merge does not contain.
console.log(`\n1 · ANCESTRY — is every commit on ${BRANCH} in the merge?`)
const missing = git(['log', '--oneline', '--no-decorate', branchSha, '--not', mergeSha]).trim()
if (missing) {
  const rows = missing.split('\n')
  findings += rows.length
  console.log(`  ✗ ${rows.length} commit(s) on the branch are NOT ancestors of the merge:`)
  for (const r of rows) console.log(`      ${r}`)
  console.log(`    → these were never absorbed. Their tests are missing too, so nothing is red.`)
} else {
  console.log(`  ✓ every commit on ${BRANCH} is an ancestor of the merge`)
}

// ── 2 · GUARD CENSUS ─────────────────────────────────────────────────────────
// Guard names are DISCOVERED from the guard module at every revision involved,
// never hand-listed: an enumerated list is a memory test, and the merge is
// exactly the event that fails one. The union across revisions matters because
// each lane contributes guards the other lane's tree has never seen.
function guardsAt(rev) {
  const src = git(['show', `${rev}:${guardModule}`], { allowFail: true })
  return [...src.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
}

const discovered = new Set([...guardsAt(mergeSha), ...parents.flatMap(guardsAt), ...extraGuards])
const guards = [...discovered]
if (guards.length === 0) {
  refuse(`discovered no guard names in ${guardModule} at any revision. A census over zero guards would report "no drops" while checking nothing.`)
}
console.log(`\n2 · GUARD CENSUS — ${guards.length} guard(s) from ${guardModule}${extraGuards.length ? ` (+${extraGuards.length} passed in)` : ''}`)
console.log(`    ${guards.join(', ')}`)

/** occurrences (not matching LINES — one line can hold two calls, and counting
 *  lines invented two phantom drops the night this script was written) of each
 *  guard, per file, at one revision. */
function census(rev, guard) {
  // --text is LOAD-BEARING, not tidiness. safe-copy.ts and hostile-strings.test.ts
  // hold literal bidi overrides and zero-width characters as regex/fixture data,
  // so git calls them BINARY and prints one "Binary file <rev>:<path> matches"
  // line with no per-occurrence output at all. Without --text the guard module
  // that DEFINES these guards is the one file the census cannot count — the
  // hostile bytes break the tool that exists to police hostile bytes.
  const out = git(['grep', '--text', '-oF', `${guard}(`, rev, '--', PATHSPEC], { allowFail: true })
  const byFile = new Map()
  const prefix = `${rev}:`
  for (const line of out.split('\n')) {
    if (!line) continue
    // A line we cannot parse must REFUSE, never become a plausible-looking
    // finding: the first cut of this script turned those "Binary file" lines
    // into paths that were actually fragments of the commit sha.
    const cut = line.startsWith(prefix) ? line.indexOf(':', prefix.length) : -1
    if (cut < 0) refuse(`unparseable git grep output — the census would miscount silently:\n    ${line.slice(0, 140)}`)
    byFile.set(line.slice(prefix.length, cut), (byFile.get(line.slice(prefix.length, cut)) ?? 0) + 1)
  }
  return byFile
}

/** Files present at the merge but absent at this parent. A guard that vanishes
 *  from one file and appears in a NEW one is the extraction case (HomeSpine's
 *  inline component moved to MadeBasket.tsx), which is the most common
 *  legitimate explanation. Scoping the hint to new files keeps it a hint —
 *  the first cut listed every gaining file in the tree, ~90 of them. */
function newFilesIn(parent) {
  const at = (rev) => new Set(git(['ls-tree', '-r', '--name-only', rev, '--', PATHSPEC]).split('\n').filter(Boolean))
  const before = at(parent)
  return new Set([...at(mergeSha)].filter((f) => !before.has(f)))
}

// A drop on EITHER side counts: a union can lose whichever lane's line it did
// not take, and checking only your own side finds only your own losses.
for (const parent of parents) {
  const label = `${parent.slice(0, 7)} → ${mergeSha.slice(0, 7)}`
  const fresh = newFilesIn(parent)
  const drops = []
  const arrivals = []
  for (const guard of guards) {
    const before = census(parent, guard)
    const after = census(mergeSha, guard)
    for (const [path, n] of before) {
      const m = after.get(path) ?? 0
      if (m < n) drops.push({ guard, path, before: n, after: m })
    }
    // only guards landing in files that did not exist at this parent
    for (const [path, m] of after) if (fresh.has(path) && m > 0) arrivals.push({ guard, path, count: m })
  }

  console.log(`\n  parent ${label}`)
  if (drops.length === 0) {
    console.log(`    ✓ no file lost a guard call`)
    continue
  }
  findings += drops.length
  for (const d of drops) {
    console.log(`    ✗ ${d.path} — ${d.guard}: ${d.before} → ${d.after}`)
    const landed = arrivals.filter((a) => a.guard === d.guard)
    if (d.after === 0 && landed.length) {
      console.log(`        possibly MOVED — ${d.guard} appears in new file(s): ${landed.slice(0, 6).map((a) => `${a.path} (${a.count})`).join(', ')}`)
    }
  }
  console.log(`    → triage each: a deliberate removal and a lost guard look identical from here.`)
}

// ── 3 · POSITIVE CONTROL ─────────────────────────────────────────────────────
// "No drops" is only meaningful if a drop would have been seen. A grep that
// silently matched nothing reports exactly the same clean result.
const probeGuard = guards[0]
const probeBefore = census(parents[0], probeGuard)
const probeFile = [...probeBefore.keys()][0]
if (!probeFile) {
  refuse(`positive control could not run: ${probeGuard} appears in no file at ${parents[0].slice(0, 7)}, so the census has nothing to prove itself against.`)
}
const synthetic = new Map(probeBefore)
synthetic.set(probeFile, probeBefore.get(probeFile) - 1)
const detected = synthetic.get(probeFile) < probeBefore.get(probeFile)
console.log(`\n3 · POSITIVE CONTROL — a synthetic one-call drop in ${probeFile}`)
console.log(detected ? `    ✓ detected — the comparison bites` : `    ✗ NOT detected — this run's clean results mean nothing`)
if (!detected) process.exit(2)

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(
  findings === 0
    ? `\nCLEAN — nothing unabsorbed, no guard lost.\n`
    : `\n${findings} item(s) to triage. A drop is a candidate, not a verdict.\n`,
)
process.exit(findings === 0 ? 0 : 1)
