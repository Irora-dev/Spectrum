#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// DEPENDENCY INTEGRITY AT INSTALL — the half of supply chain that a bundle
// test cannot reach (security queue item 3, 2026-08-07).
//
// `supply-chain.test.ts` opens with an honest admission: this is a fully
// client-side bundle, so a compromised dependency executing in the page has
// TOTAL power — it can patch any module, hook fetch, and replace
// window.ethereum, and no in-bundle test can defend against that. The CSP
// bounds what such code can REACH. This script defends the other end: what
// gets installed in the first place, and what is allowed to execute on the
// machine that builds the app.
//
// It is deliberately NOT `npm audit`. Audit asks "does a database know about a
// CVE in what you have?" — useful, noisy, and it says nothing about the two
// attacks that actually matter for a self-host kit:
//   1. THE LOCKFILE STOPS PINNING. A dependency resolved without an integrity
//      hash, or from a registry that is not ours, is installed on trust. That
//      is how a hijacked mirror or a typosquat arrives.
//   2. A PACKAGE RUNS CODE AT INSTALL. `postinstall` executes with the
//      developer's full privileges before any test, review or build runs.
//      Most packages have no business doing that, and the ones here that do
//      have a REASON, named below. A new one appearing is a decision that must
//      be made by a human, not absorbed by an install.
//
// THE ALLOWLIST IS THE POINT (the CSP's own lesson, applied to npm): a new
// lifecycle script becomes a VISIBLE DECISION rather than a quiet addition.
//
// Usage: `node scripts/dep-integrity.mjs` — exit 0 clean, 1 on any finding.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://registry.npmjs.org/'

/** Packages permitted to run code at install time, each with the reason it is
 *  not a red flag. The SCRIPT TEXT is pinned too: a package keeping its name
 *  while changing what it executes is exactly the compromise this catches. */
const INSTALL_SCRIPT_ALLOWLIST = [
  {
    name: 'esbuild',
    lifecycle: 'postinstall',
    script: 'node install.js',
    why: 'fetches/links the platform-native binary it IS — esbuild cannot function without it, and the build depends on esbuild.',
  },
  {
    name: 'bufferutil',
    lifecycle: 'install',
    script: 'node-gyp-build',
    why: 'optional native speedup for ws (WalletConnect transport); an optional dependency, absent on platforms without a toolchain.',
  },
  {
    name: 'utf-8-validate',
    lifecycle: 'install',
    script: 'node-gyp-build',
    why: 'same origin as bufferutil — ws optional native validation.',
  },
]

const findings = []
const notes = []
const fail = (m) => findings.push(m)
const note = (m) => notes.push(m)

// ── 1. the lockfile pins everything, from the registry we expect ────────────
const lockPath = join(APP, 'package-lock.json')
if (!existsSync(lockPath)) {
  fail('there is no package-lock.json — an unpinned install resolves whatever the registry serves today')
} else {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  if ((lock.lockfileVersion ?? 0) < 3) {
    fail(`lockfileVersion is ${lock.lockfileVersion}; v3+ is required (older formats omit integrity for some trees)`)
  }
  const pkgs = Object.entries(lock.packages ?? {})
  const resolved = pkgs.filter(([name, v]) => name && v.resolved)
  const noIntegrity = resolved.filter(([, v]) => !v.integrity)
  const weakIntegrity = resolved.filter(([, v]) => v.integrity && !v.integrity.startsWith('sha512-'))
  const offRegistry = resolved.filter(([, v]) => !v.resolved.startsWith(REGISTRY))
  const localish = pkgs.filter(([name, v]) => name && typeof v.version === 'string' && /^(file:|link:|git\+|github:)/.test(v.version))

  if (noIntegrity.length) fail(`${noIntegrity.length} package(s) resolved with NO integrity hash: ${noIntegrity.slice(0, 5).map(([n]) => n).join(', ')}`)
  if (weakIntegrity.length) fail(`${weakIntegrity.length} package(s) pinned by something weaker than sha512: ${weakIntegrity.slice(0, 5).map(([n]) => n).join(', ')}`)
  if (offRegistry.length) fail(`${offRegistry.length} package(s) resolve OFF ${REGISTRY}: ${offRegistry.slice(0, 5).map(([n, v]) => `${n} <- ${v.resolved}`).join(', ')}`)
  if (localish.length) fail(`${localish.length} dependency(ies) resolve to a local path or a git ref, which no integrity hash covers: ${localish.map(([n]) => n).join(', ')}`)
  if (!noIntegrity.length && !weakIntegrity.length && !offRegistry.length && !localish.length)
    note(`${resolved.length} resolved packages, every one sha512-pinned to ${REGISTRY}`)
}

// ── 2. nothing new runs code at install ──────────────────────────────────────
const found = []
function walk(dir, depth) {
  if (depth > 3 || !existsSync(dir)) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    if (e.name.startsWith('@')) {
      walk(p, depth) // a scope directory is not a package
      continue
    }
    try {
      const pj = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'))
      for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
        const script = pj.scripts?.[lifecycle]
        if (script) found.push({ name: pj.name ?? e.name, lifecycle, script: String(script) })
      }
    } catch {
      /* not a package dir */
    }
    const nested = join(p, 'node_modules')
    if (existsSync(nested)) walk(nested, depth + 1)
  }
}
const modules = join(APP, 'node_modules')
if (!existsSync(modules)) {
  note('node_modules is absent — the install-script check needs an installed tree, so it did not run')
} else {
  walk(modules, 0)
  const seen = new Set()
  for (const f of found) {
    const key = `${f.name}::${f.lifecycle}`
    seen.add(key)
    const allowed = INSTALL_SCRIPT_ALLOWLIST.find((a) => a.name === f.name && a.lifecycle === f.lifecycle)
    if (!allowed) {
      fail(`${f.name} runs a ${f.lifecycle} script that is NOT on the allowlist: ${JSON.stringify(f.script)} — a new one is a decision, not an install detail`)
    } else if (allowed.script !== f.script) {
      fail(
        `${f.name}'s ${f.lifecycle} script CHANGED — allowed ${JSON.stringify(allowed.script)}, found ${JSON.stringify(f.script)}. A package keeping its name while changing what it executes is the compromise shape.`,
      )
    }
  }
  // a stale exemption is a finding too (the A4 lesson: an exemption that is no
  // longer true is a claim nobody is checking)
  for (const a of INSTALL_SCRIPT_ALLOWLIST) {
    if (!seen.has(`${a.name}::${a.lifecycle}`))
      fail(`the allowlist still permits ${a.name}'s ${a.lifecycle} script, which is no longer present — drop the entry`)
  }
  if (found.length) note(`${found.length} install-time script(s), all allowlisted with a reason: ${found.map((f) => f.name).join(', ')}`)
}

// ── 3. the registry is pinned where npm will actually read it ────────────────
const npmrc = join(APP, '.npmrc')
if (!existsSync(npmrc)) {
  fail('there is no app/.npmrc pinning the registry — an environment or a hijacked default decides where packages come from')
} else {
  const text = readFileSync(npmrc, 'utf8')
  if (!text.includes(`registry=${REGISTRY}`)) fail(`.npmrc does not pin registry=${REGISTRY}`)
  else note('.npmrc pins the registry explicitly')
}

// ── report ───────────────────────────────────────────────────────────────────
const line = '─'.repeat(74)
console.log(`\n${line}\nDEPENDENCY INTEGRITY — what is installed, and what may execute\n${line}`)
for (const n of notes) console.log(`  · ${n}`)
if (findings.length) {
  console.log(`\n❌ ${findings.length} finding(s):`)
  for (const f of findings) console.log(`  ✗ ${f}`)
  console.log(
    `\n${line}\nA finding here is not "a vulnerability was published" — it is "the chain of\ncustody changed". Resolve it by understanding WHY, then either fixing the\ndependency or recording the decision in this script's allowlist.\n${line}\n`,
  )
  process.exit(1)
}
console.log(`\n✅ dependency integrity clean\n${line}\n`)
