#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// THE MUTATION SWEEP (gate A12) — "defeat the fix and watch the pin fail",
// automated over the whole money core instead of only the fresh fixes.
//
// Three times in one night an assertion here PINNED THE BUG; my own M4
// verification was wrong; a pin once proved the wrong thing while RED. The
// hand-discipline that catches those — mutate the code, expect the suite to
// object — is what this script does mechanically: one mutant at a time, the
// file's own scoped suites, restore, tally. EVERY SURVIVING MUTANT IS A
// FINDING: either a missing pin or dead code, and both are worth a row.
//
// Deliberately NOT in CI (minutes, not seconds) — run it after money-core
// changes: node scripts/mutation-sweep.mjs [fileKey ...]
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')

// ─── SWEPT_CLEAN — the sweep's own record of what it has actually measured ───
// Until 2026-08-07 the answer to "has the whole money core been swept?" lived in
// one sentence in ALLOCATOR-CHANGE-PROTOCOL.md. A sentence cannot tell you its
// own status — the exact reason the open-findings registry exists — and the
// registry row asking this question had no evidence to read, only that sentence.
// So the sweep now WRITES what it saw, and the row reads the record.
//
// A target is SWEPT_CLEAN when three things hold, all machine-checkable:
//   1. a run recorded it;
//   2. the recorded DIGEST still matches the file on disk — the same idea as the
//      review ledger's moneyDigest: editing a module EXPIRES its clean record,
//      because a sweep certifies the bytes it ran against and nothing later;
//   3. every survivor it found carries a triage entry in mutation-triage.json.
//
// The sweep can never write (3) itself. A survivor is an accepted equivalent, a
// missing pin, or dead code, and only a human can say which — a tool that
// triaged its own survivors would be a record agreeing with itself.
const STATE = join(APP, 'src/lib/spectrum/mutation-sweep-state.json')

const digestOf = (text) => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`

/** `target:line:col:operator` — stable only WITHIN one digest, which is exactly
 *  the window the digest check keeps open.
 *
 *  THE COLUMN IS LOAD-BEARING and the first cut omitted it. funding-plan:316 is
 *  `if (r.shortCents > 0 && newMoneyLeft > 0 && newMoneyChain != null)`: two
 *  DIFFERENT `>` mutants on one line collapsed to one signature, and since
 *  triage is keyed by signature, giving a verdict to either would have silently
 *  cleared the other. They are not the same finding — one is equivalent behind
 *  an upstream filter and the other pushes a zero-cent draw. Found by reading
 *  the survivor list and seeing the same key twice. */
const sigOf = (s) => `${s.key}:${s.line}:${s.col}:${s.name}`

/** Merge one target's result into the state, preserving every other target's
 *  record: a single-target re-run must not erase the other six. */
function recordSweep(key, record) {
  const state = existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, 'utf8'))
    : { note: 'WRITTEN BY scripts/mutation-sweep.mjs — do not hand-edit `swept`. Triage lives in mutation-triage.json.', swept: {} }
  state.swept[key] = record
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`)
}

/** file → the suites that must object to its mutants. The file's own suite
 *  plus the cross-module harnesses that exist precisely to catch what a
 *  module's own tests miss. */
const TARGETS = {
  'floor-discipline': ['floor-discipline.test.ts', 'hostile-numbers.test.ts', 'pipeline-properties.test.ts'],
  'plan-legs': ['plan-legs.test.ts', 'hostile-numbers.test.ts', 'pipeline-properties.test.ts', 'amount-sweep.test.ts'],
  'displayed-vs-signed': ['displayed-vs-signed.test.ts', 'hostile-strings.test.ts', 'pipeline-properties.test.ts'],
  batcher: ['batcher.test.ts', 'assemble-batch.test.ts', 'differential.test.ts', 'pipeline-properties.test.ts'],
  'submission-store': ['submission-store.test.ts'],
  'pool-safety': ['pool-safety.test.ts', 'hostile-numbers.test.ts'],
  // ⚠ ADDED 2026-08-07 after the coverage question was asked directly: this
  // module was NOT a target, and M3 (a finding I dropped for not reproducing)
  // lived here — the one place a survivor would have been most informative was
  // the one place the sweep never looked.
  'funding-plan': ['funding-plan.test.ts', 'hostile-numbers.test.ts'],
  // ⚠ ADDED 2026-08-14 (pass-one MED-1, SpectrumContracts): the interlock's
  // moneyDigest names 12 source modules while the sweep measured 7 — so
  // "moneyCoreNotClean = 0" read ABSENCE as cleanliness for exactly the
  // portfolio path being armed. The five join the census; the A12 fact now
  // measures what it claims.
  'runner-effects': ['runner-effects.test.ts'],
  'portfolio-batcher': ['portfolio-batcher.test.ts', 'portfolio-run-wiring.test.ts'],
  allocation: ['allocation.test.ts'],
  'execution-runner': ['execution-runner.test.ts'],
  'assemble-batch': ['assemble-batch.test.ts', 'differential.test.ts', 'pipeline-properties.test.ts'],
}

/** Operator mutations. Each returns the mutated text or null (no-op). The
 *  patterns are deliberately narrow: a mutant that does not PARSE wastes a
 *  vitest run, so we only swap tokens whose swap stays syntactic. */
const MUTATORS = [
  { name: '<= → <', re: /<=/g, to: '<' },
  { name: '< → <=', re: /(?<![<=])<(?![<=])/g, to: '<=' },
  { name: '>= → >', re: />=/g, to: '>' },
  { name: '> → >=', re: /(?<![>=])>(?![>=])/g, to: '>=' },
  { name: '=== → !==', re: /===/g, to: '!==' },
  { name: '&& → ||', re: /&&/g, to: '||' },
  { name: 'drop !', re: /(?<![=!])!(?=[a-zA-Z(])/g, to: '' },
  { name: '+ → -', re: /(?<=[\w)\]])\s\+\s(?=[\w(])/g, to: ' - ' },
]

/** ⚠ REAP ORPHANED VITEST WORKERS — this lane leaked 27 of them on 2026-08-07,
 *  holding ~10 of the machine's 18 cores for eight hours, and what the owner
 *  noticed was his battery draining. Every one had PPID 1: a worker whose
 *  parent is gone has no IPC channel to report to, so it is not producing
 *  anything for anyone, it is spinning.
 *
 *  THREE THINGS THIS GETS RIGHT BECAUSE THEY WERE MEASURED, not guessed.
 *  They do NOT die on SIGTERM — all 27 survived TERM and only SIGKILL took
 *  them, so a handler that sends TERM looks like it worked and leaves the
 *  machine loaded. The match requires `vitest` in the command, never bare
 *  `vite`, because five dev servers run from this tree and killing one is a
 *  worse outcome than the leak. And it runs BEFORE as well as after: the leak
 *  happens when a run is interrupted between the fork and the collect, which
 *  is exactly the case where the after-hook never executes.
 *
 *  Reaping is a backstop, not the cure — the cure is not orphaning them — but
 *  it is the half that can be automated, and it prints what it kills so the
 *  rate stays visible instead of being quietly absorbed. */
function reapOrphans(when) {
  let out = ''
  try {
    out = execFileSync('ps', ['-Ao', 'pid,ppid,command'], { encoding: 'utf8' })
  } catch {
    console.log(`  (${when}: could not list processes — skipping the reap, NOT claiming it was clean)`)
    return
  }
  const victims = out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && m[2] === '1' && m[3].includes('spectrum-mini-allocator') && /vitest|tinypool/.test(m[3]))
    .map((m) => m[1])
  if (victims.length === 0) return
  console.log(`  ${when}: reaping ${victims.length} orphaned vitest worker(s) — SIGKILL, they ignore TERM`)
  for (const pid of victims) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    } catch { /* already gone between the listing and the kill */ }
  }
}

const args = process.argv.slice(2)
const keys = args.length ? args : Object.keys(TARGETS)
reapOrphans('before')
process.on('exit', () => reapOrphans('after'))
const MAX_MUTANTS_PER_FILE = Number(process.env.MUTATION_CAP ?? 40)

let killed = 0
const survivors = []
for (const key of keys) {
  const suites = TARGETS[key]
  if (!suites) {
    console.error(`unknown target ${key}; known: ${Object.keys(TARGETS).join(', ')}`)
    process.exit(2)
  }
  const file = join(APP, 'src/lib/spectrum', `${key}.ts`)
  const original = readFileSync(file, 'utf8')
  // never mutate comments or strings-heavy lines: split by line, skip lines
  // that are comments or contain quotes (sentences are not logic)
  const lines = original.split('\n')
  const sites = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || /['"`]/.test(line)) continue
    for (const m of MUTATORS) {
      m.re.lastIndex = 0
      let match
      while ((match = m.re.exec(line)) !== null) {
        sites.push({ line: i, col: match.index, len: match[0].length, to: m.to, name: m.name })
        if (m.re.lastIndex === match.index) m.re.lastIndex++
      }
    }
  }
  // spread the budget across the whole file rather than saturating the top
  const step = Math.max(1, Math.floor(sites.length / MAX_MUTANTS_PER_FILE))
  const chosen = sites.filter((_, i) => i % step === 0).slice(0, MAX_MUTANTS_PER_FILE)
  console.log(`\n${key}: ${sites.length} mutable sites, running ${chosen.length}`)
  const survivorsBefore = survivors.length

  for (const s of chosen) {
    const mutatedLines = [...lines]
    const l = mutatedLines[s.line]
    mutatedLines[s.line] = l.slice(0, s.col) + s.to + l.slice(s.col + s.len)
    writeFileSync(file, mutatedLines.join('\n'))
    let dead = false
    try {
      execFileSync('npx', ['vitest', 'run', ...suites.map((t) => `src/lib/spectrum/${t}`)], {
        cwd: APP,
        stdio: 'pipe',
        timeout: 120_000,
      })
    } catch {
      dead = true // the suite objected (or the mutant did not compile) — killed
    }
    if (dead) killed++
    else survivors.push({ key, line: s.line + 1, col: s.col, name: s.name, text: lines[s.line].trim().slice(0, 90) })
    process.stdout.write(dead ? '·' : 'S')
  }
  writeFileSync(file, original)
  // paranoia: the restore must be byte-exact
  if (readFileSync(file, 'utf8') !== original) {
    console.error(`\nRESTORE FAILED for ${file} — fix by hand from git NOW`)
    process.exit(3)
  }

  // Record AFTER the restore, and digest the ORIGINAL bytes — digesting a file
  // that still held a mutant would certify a tree that never existed.
  const mine = survivors.slice(survivorsBefore)
  // Two survivors sharing a signature would let ONE triage verdict silently
  // clear BOTH — the defect that made the column part of the signature. Refuse
  // rather than write a record whose keys cannot address their own findings.
  const sigs = mine.map(sigOf)
  const dupes = sigs.filter((s, i) => sigs.indexOf(s) !== i)
  if (dupes.length) {
    console.error(`\nDUPLICATE SURVIVOR SIGNATURES in ${key} — a verdict on one would clear the other:\n  ${[...new Set(dupes)].join('\n  ')}`)
    process.exit(4)
  }
  recordSweep(key, {
    at: new Date().toISOString().slice(0, 10),
    digest: digestOf(original),
    sites: sites.length,
    mutants: chosen.length,
    killed: chosen.length - mine.length,
    // capped runs are stated, never implied: a sweep that saw 40 of 67 sites has
    // not swept the module, and the row must be able to tell those apart
    partial: chosen.length < sites.length,
    survivors: mine.map((s) => ({ sig: sigOf(s), line: s.line, col: s.col, op: s.name, text: s.text })),
  })
}

console.log(`\n\n${killed} killed, ${survivors.length} survived`)
if (survivors.length) {
  console.log('\nSURVIVORS — each is a missing pin or dead code, and both are findings:')
  for (const s of survivors) console.log(`  ${s.key}.ts:${s.line} [${s.name}] ${s.text}`)
  process.exit(1)
}
