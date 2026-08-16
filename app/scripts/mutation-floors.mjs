#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// A PER-MODULE MUTATION FLOOR, because the aggregate one cannot see a module
// getting worse.
//
// stryker's own `thresholds.break` is a single number over the whole configured
// set. On 2026-08-07 that passed at 81.70% — comfortably over the 79 floor and
// ABOVE the 81.21% baseline — while `assemble-batch.ts` fell from 87.4% to
// 78.0% behind other modules improving. The gate was green for a tree in which
// one money module's suites had measurably weakened. A mean cannot report its
// own worst term.
//
// This is the same shape as the deployer-string gate's six-file list, found the
// same evening: a check that passes while the thing it guards gets worse. There
// the reach was hand-written; here the resolution is. Both are gates whose
// FAILURE MODE IS SILENCE, which is the only kind worth adding machinery for.
//
// HOW IT IS MEANT TO BE USED: the floors are a ratchet. Raise one when a module
// improves and you intend to hold the gain; never lower one to make a commit
// pass — lowering it is the exact move this file exists to make visible, so it
// has to happen in a diff someone reads.
//
//   node scripts/mutation-floors.mjs           # check (exits 1 on a breach)
//   node scripts/mutation-floors.mjs --seed    # rewrite floors from the report
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPORT = path.join(here, '..', 'reports', 'mutation', 'mutation.json')
const FLOORS = path.join(here, '..', 'mutation-floors.json')

// How far a module may drift below its floor before this fails. Mutation score
// has real run-to-run jitter (timeouts land differently under load), and a gate
// that cries wolf gets disabled, which is worse than no gate.
const JITTER_PP = 1.5

function scores() {
  if (!existsSync(REPORT)) {
    console.error('no mutation report at reports/mutation/mutation.json — run `npm run test:mutation` first')
    process.exit(2)
  }
  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const out = {}
  for (const [file, data] of Object.entries(report.files ?? {})) {
    const m = data.mutants ?? []
    // ⚠ THE *TOTAL* SCORE, NOT THE "COVERED" ONE — NoCoverage stays in the
    // denominator. My first version divided by killed+timeout+survived, which
    // is stryker's `covered` column, and it read HIGHER than the real score on
    // every module: runner-effects showed 78.81 instead of 74.91 because its 28
    // uncovered mutants simply vanished from the arithmetic.
    //
    // A mutant with NO test coverage is the worst category there is — code no
    // test touches at all — so a floor that excludes it is a floor that hides
    // exactly what it should be loudest about. It would also have disagreed
    // with the global `break` threshold, so the two gates would have been
    // measuring different things while appearing to measure one.
    const killed = m.filter((x) => x.status === 'Killed' || x.status === 'Timeout').length
    const denom = m.filter((x) => ['Killed', 'Timeout', 'Survived', 'NoCoverage'].includes(x.status)).length
    if (denom === 0) continue
    out[path.basename(file)] = Number(((killed / denom) * 100).toFixed(2))
  }
  return out
}

// ⚠ THE REPORT IS OVERWRITTEN BY *ANY* RUN, INCLUDING A SCOPED ONE. This bit
// on the very first seed: `stryker run --mutate <one file>` had left a report
// covering 1 module of 8, and seeding from it would have written a floors file
// with a single entry — after which this gate would cheerfully print "all 1
// modules hold" while seven went unchecked. That is the same failure the gate
// exists to prevent, one level up. So the report is checked against the config's
// own mutate list before it is trusted for anything.
function configuredModules() {
  const cfg = JSON.parse(readFileSync(path.join(here, '..', 'stryker.config.json'), 'utf8'))
  return (cfg.mutate ?? []).map((p) => path.basename(p))
}
function assertFullReport(found) {
  const want = configuredModules()
  const missing = want.filter((m) => !(m in found))
  if (missing.length === 0) return
  console.error(`this report covers ${Object.keys(found).length} of ${want.length} configured modules — it is a PARTIAL run.`)
  console.error(`missing: ${missing.join(', ')}`)
  console.error('\nrun the full `npm run test:mutation` first; a scoped run overwrites the same report file.')
  process.exit(2)
}

const now = scores()
assertFullReport(now)

if (process.argv.includes('--seed')) {
  writeFileSync(FLOORS, `${JSON.stringify(now, null, 2)}\n`)
  console.log(`seeded ${Object.keys(now).length} module floors from the current report:`)
  for (const [k, v] of Object.entries(now)) console.log(`  ${k.padEnd(24)} ${v}%`)
  console.log('\nreview these before committing — a floor seeded from a bad run enshrines it.')
  process.exit(0)
}

if (!existsSync(FLOORS)) {
  console.error('no mutation-floors.json — run with --seed once, review it, and commit it')
  process.exit(2)
}
const floors = JSON.parse(readFileSync(FLOORS, 'utf8'))

const breaches = []
const moved = []
for (const [mod, floor] of Object.entries(floors)) {
  const score = now[mod]
  if (score == null) {
    // a module that vanished from the report is not a pass: either the config
    // stopped mutating it or the file was renamed, and both need a human
    breaches.push(`${mod}: NOT IN THE REPORT — floor ${floor}% cannot be checked (renamed, or dropped from stryker.config.json?)`)
    continue
  }
  if (score < floor - JITTER_PP) breaches.push(`${mod}: ${score}% is below its floor of ${floor}% (allowing ${JITTER_PP}pp jitter)`)
  else if (score > floor + JITTER_PP) moved.push(`${mod}: ${score}% is above its floor of ${floor}% — raise the floor to hold the gain`)
}

const unfloored = Object.keys(now).filter((m) => !(m in floors))
for (const m of unfloored) moved.push(`${m}: ${now[m]}% has NO floor — add one`)

for (const line of moved) console.log(`  ↑ ${line}`)
if (breaches.length === 0) {
  console.log(`\nmutation floors: all ${Object.keys(floors).length} modules hold.`)
  process.exit(0)
}
console.error('\nMUTATION FLOOR BREACH — a module’s suites got weaker even if the total did not:')
for (const line of breaches) console.error(`  ✗ ${line}`)
console.error('\nRaise the tests, not the floor. Lowering a floor is the move this gate exists to make visible.')
process.exit(1)
