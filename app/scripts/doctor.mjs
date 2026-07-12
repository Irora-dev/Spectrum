#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Spectrum Mini — doctor (owner 2026-07-09, improvement set #7). One command
// that answers "is this site healthy?" end to end:
//
//   1. config   — scripts/check-config.mjs   (the build's own fatal/warn gate)
//   2. chain    — ../create/verify.mjs       (live: RPC + factory + canonicals)
//   3. version  — repo version.json vs the published manifest (dormant until
//                 `updateManifestUrl` is set at the public flip)
//
//   npm run doctor
//
// The runbook (START-HERE.md) runs it after every update and points issue
// reporters at it. Exit is non-zero when config or chain fail; a version-check
// NETWORK failure only warns (a manifest fetch flake must not block a build).
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = resolve(APP, '..')

const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
const tty = process.stdout.isTTY
const c = (k, s) => (tty ? C[k] + s + C.reset : s)

console.log('')
console.log(c('bold', 'Spectrum Mini — doctor'))
console.log(c('dim', '  config check · live chain smoke · version check'))

const run = (label, script) => {
  console.log('')
  console.log(c('bold', `── ${label} `.padEnd(40, '─')))
  const r = spawnSync(process.execPath, [script], { cwd: APP, stdio: 'inherit' })
  return r.status === 0
}

const configOk = run('1 · config', resolve(APP, 'scripts/check-config.mjs'))
const chainOk = run('2 · chain', resolve(ROOT, 'create/verify.mjs'))

// ── 3 · version ──
console.log(c('bold', `── 3 · version `.padEnd(40, '─')))
let versionOk = true
let local = null
try {
  local = JSON.parse(readFileSync(resolve(ROOT, 'version.json'), 'utf8'))
} catch {
  /* absent — reported below */
}
if (!local?.version) {
  console.log(c('yellow', '  ⚠ ') + 'version.json is missing or unreadable at the repo root.')
} else {
  const url = String(local.updateManifestUrl ?? '').trim()
  if (!url) {
    console.log(c('dim', '  · ') + `Kit version ${local.version}. Update check dormant (no public manifest URL set yet).`)
  } else {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(url, { signal: ctrl.signal })
      clearTimeout(t)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const remote = await res.json()
      if (Array.isArray(remote?.yanked) && remote.yanked.includes(local.version)) {
        // The one version state that fails the doctor: this exact version was
        // recalled after shipping (docs/RELEASES.md). The site keeps serving,
        // but the operator should update before doing anything else.
        console.log(
          c('red', '  ✗ ') +
            `Kit version ${local.version} was RECALLED (a known issue shipped and was rolled back)` +
            `${remote.version && remote.version !== local.version ? ` — fixed in ${remote.version}` : ''}. ` +
            'Update now: node create/update.mjs (or the runbook\'s Updating section).',
        )
        versionOk = false
      } else if (remote?.version && remote.version !== local.version) {
        const care = []
        if (remote.impact === 'config') care.push('changes configuration — read the changelog first')
        if (remote.impact === 'breaking') care.push('needs manual steps — read the changelog first')
        if (Array.isArray(remote.sacred) && remote.sacred.length) {
          care.push(`touches the ${remote.sacred.map((s) => (s === 'swap' ? 'trading' : s)).join(' + ')} path`)
        }
        console.log(
          c('yellow', '  ⚠ ') +
            `Kit update available: ${local.version} → ${remote.version}${remote.note ? ` (${remote.note})` : ''}.` +
            `${care.length ? ` It ${care.join('; ')}.` : ''} Run node create/update.mjs, or the runbook's Updating section walks the merge.`,
        )
      } else {
        console.log(c('green', '  ✓ ') + `Kit version ${local.version} — up to date.`)
      }
    } catch (e) {
      // Network-flake tolerance: report, never block.
      console.log(c('yellow', '  ⚠ ') + `Could not reach the update manifest (${e?.message ?? e}) — skipped.`)
    }
  }
}

console.log('')
if (configOk && chainOk && versionOk) {
  console.log(c('green', '  Doctor: healthy.'))
  console.log('')
  process.exit(0)
}
console.log(c('red', `  Doctor: ${[!configOk && 'config', !chainOk && 'chain', !versionOk && 'version'].filter(Boolean).join(' + ')} failed — fix the sections above.`))
console.log('')
process.exit(1)
