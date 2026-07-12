#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Sacred-systems diff — the ONE matcher both gates share.
//
//   node scripts/sacred-diff.mjs <baseRef> [headRef=HEAD]
//
// Diffs headRef against baseRef, intersects the changed paths with
// sacred-paths.json, and prints which sacred systems (launch / swap) the diff
// touches. Exit codes:
//
//   0 — consistent: either nothing sacred changed, or every touched system is
//       declared in version.json's `sacred` field (over-declaring is allowed —
//       caution never fails).
//   1 — could not run (bad ref, missing files).
//   2 — INCONSISTENT: the diff touches a sacred system that version.json does
//       not declare. On the public repo this fails the release commit's check;
//       at the source it means the release script's gate was bypassed.
//
// Used by: release tooling at the source (as the hard-stop's matcher) and the
// public repo's CI on every release commit (the builder-visible flag). Zero-dep.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal glob → RegExp: `**` crosses directories, `*` stays within one. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++ // `**/` also matches zero directories
      } else re += '[^/]*'
    } else if ('\\^$.|?+()[]{}'.includes(ch)) re += '\\' + ch
    else re += ch
  }
  return new RegExp(`^${re}$`)
}

/** Which sacred systems does this list of changed paths touch? */
export function touchedSystems(registry, changedPaths) {
  const hits = new Map() // system -> [paths]
  const reminders = []
  for (const [name, group] of Object.entries(registry.systems ?? {})) {
    const regexes = (group.paths ?? []).map(globToRegExp)
    const matched = changedPaths.filter((p) => regexes.some((re) => re.test(p)))
    if (!matched.length) continue
    // A `shared` group flags the systems it lists instead of itself.
    for (const flagAs of group.flags ?? [name]) {
      hits.set(flagAs, [...(hits.get(flagAs) ?? []), ...matched])
    }
  }
  const remGlobs = (registry.dependencyReminder?.paths ?? []).map(globToRegExp)
  for (const p of changedPaths) if (remGlobs.some((re) => re.test(p))) reminders.push(p)
  return { hits, reminders }
}

/** CI base resolution: the previous release = latest v* tag behind HEAD, else HEAD^ (on
 *  the public repo every commit IS a release), else no base at all (root commit). */
function autoBase() {
  const tryGit = (...a) => {
    try {
      return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  return tryGit('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD^') ?? tryGit('rev-parse', '--verify', 'HEAD^')
}

function main() {
  let [baseRef, headRef = 'HEAD'] = process.argv.slice(2)
  if (baseRef === '--auto-base') {
    baseRef = autoBase()
    if (!baseRef) {
      console.log('sacred-diff: no previous commit to diff against (root commit) — skipped.')
      process.exit(0)
    }
  }
  if (!baseRef) {
    console.error('usage: node scripts/sacred-diff.mjs <baseRef>|--auto-base [headRef]')
    process.exit(1)
  }

  let registry, manifest, changed
  try {
    registry = JSON.parse(readFileSync(resolve(ROOT, 'sacred-paths.json'), 'utf8'))
    manifest = JSON.parse(readFileSync(resolve(ROOT, 'version.json'), 'utf8'))
  } catch (e) {
    console.error(`sacred-diff: cannot read sacred-paths.json / version.json (${e?.message ?? e})`)
    process.exit(1)
  }
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${baseRef}..${headRef}`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    changed = out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (e) {
    console.error(`sacred-diff: git diff ${baseRef}..${headRef} failed (${e?.message ?? e})`)
    process.exit(1)
  }

  const { hits, reminders } = touchedSystems(registry, changed)
  const declared = Array.isArray(manifest.sacred) ? manifest.sacred.map(String) : []

  console.log(`sacred-diff: ${changed.length} file(s) changed ${baseRef}..${headRef}`)
  if (!hits.size) {
    console.log('Sacred systems touched: none')
  } else {
    console.log(`Sacred systems touched: ${[...hits.keys()].join(', ')}`)
    for (const [sys, paths] of hits) {
      for (const p of [...new Set(paths)]) console.log(`  [${sys}] ${p}`)
    }
  }
  if (reminders.length) {
    console.log(`Dependency reminder (${registry.dependencyReminder?.note ?? ''}):`)
    for (const p of reminders) console.log(`  ${p}`)
  }
  console.log(`Declared in version.json (sacred): ${declared.length ? declared.join(', ') : 'none'}`)

  const undeclared = [...hits.keys()].filter((s) => !declared.includes(s))
  if (undeclared.length) {
    console.error(
      `\nINCONSISTENT: the diff touches sacred system(s) [${undeclared.join(', ')}] that version.json does not declare. ` +
        'A sacred change must ship as a declared sacred release (see docs/RELEASES.md).',
    )
    process.exit(2)
  }
  console.log('\nConsistent: sacred declarations match the diff.')
}

// Run as CLI only (import-safe for the release tooling + tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
