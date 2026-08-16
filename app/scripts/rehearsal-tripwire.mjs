#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// THE REHEARSAL TRIPWIRE — rehearsal/decoy contracts must never ship.
//
// During a mainnet rehearsal, deployments.json in the WORKING TREE is seated
// with throwaway decoy contracts, each labelled with a `_rehearsal` key
// ("REHEARSAL <chain-id> — … localhost only, never commit"). That dirty state
// is deliberate and correct — and the standing rule it lives under is strict:
// no commit containing a rehearsal address may reach a shared branch, and the
// live site must never point at one. An immutable decoy in production cannot
// be undone.
//
// Until 2026-08-13 that rule was enforced by discipline alone — nothing
// committed would object if the seated file were ever `git add`ed. This script
// is the committed objection. It runs first in `prebuild`, so every gated push
// (the four gates include `npm run build`) and every deploy build refuses
// rehearsal state at the boundary that matters.
//
// WHAT IT JUDGES — the content that would actually ship, never the scratch:
//   · HEAD's deployments.json      (what a push would publish)
//   · the git index's version      (what the next commit would contain —
//                                   trips at `git add` time, before the
//                                   commit even exists)
//   · the DISK file ONLY when git is unavailable (an exported archive, a
//     tarball deploy — contexts where the disk file IS the shipped content).
// With git present the working tree is deliberately NOT judged: it is dirty
// by design during rehearsals, and a tripwire that fires on the designed
// state is a control that gets switched off.
//
// THE DETECTOR is the label law itself: every rehearsal entry carries a
// /rehearsal/i key or value by rule, so the scan looks for exactly that. It
// cannot catch an UNLABELLED rehearsal address (this file must not contain
// the decoy hexes — listing them here would itself commit them), so the
// label rule and this tripwire only work together.
//
// Exit 1 on any finding, and on a self-check failure: the matcher is driven
// over a synthetic seated file every run, because a tripwire that cannot be
// shown to bite proves nothing by staying silent.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
// Repo-root-relative — a `<rev>:path` git spec resolves from the root
// whatever the cwd. If this file ever moves, the specs below move with it.
const REPO_REL = 'app/src/lib/chain/deployments.json'

function gitShow(spec) {
  try {
    return execFileSync('git', ['show', spec], {
      cwd: APP,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null // no repo, no commit yet, or the path is absent from this rev
  }
}

/** Every finding for one candidate file body. Pure, so the self-check below
 *  drives the exact code path the real sources go through. */
function scan(sourceName, text) {
  const found = []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return [`${sourceName}: deployments.json does not parse — an unreadable file cannot be certified rehearsal-free`]
  }
  const chains = Object.entries(parsed ?? {})
  if (chains.length === 0) {
    return [`${sourceName}: zero chain entries — an empty read certifies nothing`]
  }
  for (const [chain, entry] of chains) {
    for (const [key, value] of Object.entries(entry ?? {})) {
      if (/rehearsal/i.test(key)) {
        found.push(`${sourceName}: chain ${chain} carries the key "${key}" — rehearsal seating is working-tree-only and must never be committed or shipped`)
      } else if (typeof value === 'string' && /rehearsal/i.test(value)) {
        found.push(`${sourceName}: chain ${chain}'s "${key}" holds a rehearsal-labelled value — rehearsal seating is working-tree-only and must never be committed or shipped`)
      }
    }
  }
  return found
}

// ── self-check first: the matcher must bite before its silence means anything
const probe = scan('probe', JSON.stringify({ 1: { _rehearsal: 'REHEARSAL 1 — decoys', factory: '0x0' } }))
const probeValue = scan('probe', JSON.stringify({ 1: { factory: '0x0', note: 'REHEARSAL 1 decoy set' } }))
if (probe.length === 0 || probeValue.length === 0) {
  console.error('❌ rehearsal tripwire SELF-CHECK FAILED — the matcher no longer bites on a synthetic seated file, so a clean verdict from it is meaningless. Fix scan() before trusting any build.')
  process.exit(1)
}

// ── the real sources
const sources = []
const head = gitShow(`HEAD:${REPO_REL}`)
const staged = gitShow(`:${REPO_REL}`)
if (head !== null) sources.push(['HEAD (the committed file)', head])
if (staged !== null) sources.push(['the index (staged content)', staged])

const notes = []
if (sources.length === 0) {
  // No git answers here (an exported archive, a tarball deploy): the disk
  // file IS the shipped content, so it gets judged after all.
  let disk
  try {
    disk = readFileSync(join(APP, 'src/lib/chain/deployments.json'), 'utf8')
  } catch {
    console.error(`❌ rehearsal tripwire: git is unavailable AND ${REPO_REL} is unreadable — nothing was checked, which is not a pass.`)
    process.exit(1)
  }
  sources.push(['the working file (no git here, so this IS the shipped content)', disk])
  notes.push('git unavailable — judged the disk file directly')
} else {
  notes.push('the working tree is deliberately NOT judged — it is dirty by design during a rehearsal; committed and staged content is what must stay clean')
}

const findings = sources.flatMap(([name, text]) => scan(name, text))

console.log('rehearsal tripwire: judged ' + sources.map(([n]) => n).join(' · '))
for (const n of notes) console.log(`  · ${n}`)
if (findings.length) {
  console.error(`\n❌ ${findings.length} finding(s):`)
  for (const f of findings) console.error(`  ✗ ${f}`)
  console.error('\nUnstage / uncommit the rehearsal seating before building or pushing. The rehearsal state lives in the working tree ONLY.')
  process.exit(1)
}
console.log('  ✅ no rehearsal marker in anything that would ship')
