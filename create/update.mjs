#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Spectrum Mini — the one-command site update (owner 2026-07-12).
//
//   node create/update.mjs [--yes] [--host zip|cloudflare|netlify|vercel|vps|later]
//   npm run update:site               # the same, from app/
//
// Updates a git-cloned site to the latest kit release WITHOUT touching what
// makes the site yours. Cross-platform by construction: plain zero-dep Node
// (the same Node the kit already needs to build), so macOS, Windows, and Linux
// all run this exact file — no bash, no PowerShell.
//
// What it guards (the whole point — never "dump the new version over the old"):
//   • your identity files stay YOURS through the merge: app/src/brand.config.ts,
//     app/src/site.config.json, app/metadata/** (and .env.local is gitignored —
//     no update can touch it)
//   • your identity is snapshot-committed FIRST, so one command undoes anything
//   • it tells you what's coming before it starts (version, note, impact,
//     sacred/money-path flags, and whether YOUR version was recalled)
//   • doctor + a full build must pass BEFORE you're pointed at redeploy —
//     a failed update never reaches your live site
//   • your live site only changes when you redeploy the fresh dist/ the same
//     way you always deploy (host commands printed at the end)
//
// Undo ladder (printed on every failure): `git merge --abort` mid-merge, or
// `git reset --hard ORIG_HEAD` right after it — the snapshot commit means your
// identity survives either way. Zip-installed sites (no git): see the guidance
// this script prints when it finds no repository.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { hostingGuide } from './render.mjs'

// Ctrl+D / closed stdin at a prompt must read as "no answer", never a stack trace.
async function askSafe(rl, text, fallback = '') {
  try {
    return (await rl.question(text)).trim()
  } catch {
    return fallback
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'app')
const UPSTREAM_URL = 'https://github.com/Irora-dev/Spectrum'
const IDENTITY = ['app/src/brand.config.ts', 'app/src/site.config.json', 'app/metadata']

const args = process.argv.slice(2)
const YES = args.includes('--yes')
const hostIdx = args.indexOf('--host')
const HOST = hostIdx !== -1 ? args[hostIdx + 1] : null

const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
const tty = process.stdout.isTTY
const c = (k, s) => (tty ? C[k] + s + C.reset : s)
const step = (s) => console.log(`\n${c('bold', `── ${s} `.padEnd(58, '─'))}`)
const die = (msg, undo) => {
  console.error(`\n${c('red', '✗ ')}${msg}`)
  if (undo) console.error(`${c('yellow', '  undo: ')}${undo}`)
  process.exit(1)
}

// git is a real executable everywhere; npm needs a shell on Windows (npm.cmd).
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' })
const gitOut = (...a) => {
  const r = git(...a)
  return r.status === 0 ? r.stdout.trim() : null
}
const gitLoud = (label, ...a) => {
  console.log(c('dim', `$ git ${a.join(' ')}`))
  // Mutating git commands validate committer identity up front (merge included),
  // so they all get the no-identity fallback — see identityEnv below.
  const r = spawnSync('git', a, { cwd: ROOT, stdio: 'inherit', env: identityEnv() })
  return r.status === 0
}
const npmLoud = (label, argv, undo) => {
  console.log(c('dim', `$ npm ${argv.join(' ')}   (in app/)`))
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', argv, {
    cwd: APP,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) die(`${label} failed — your live site is untouched.`, undo)
}

// Git refuses to commit (and `git merge` refuses to even start) on a machine with
// no configured identity — which describes exactly the non-dev operators this
// script serves. Fall back per-invocation; never write to their config.
let identityEnvMemo = null
function identityEnv() {
  if (identityEnvMemo) return identityEnvMemo
  const email = gitOut('config', 'user.email')
  identityEnvMemo = email
    ? process.env
    : {
        ...process.env,
        GIT_AUTHOR_NAME: 'Site Operator',
        GIT_AUTHOR_EMAIL: 'operator@localhost',
        GIT_COMMITTER_NAME: 'Site Operator',
        GIT_COMMITTER_EMAIL: 'operator@localhost',
      }
  return identityEnvMemo
}
const gitCommit = (msg) =>
  spawnSync('git', ['commit', '-m', msg], { cwd: ROOT, stdio: 'inherit', env: identityEnv() }).status === 0

console.log(`\n${c('bold', 'Spectrum Mini — site update')}`)
console.log(c('dim', '  your identity files and .env.local survive; your live site changes only when you redeploy'))

// ── 0 · preflight ──
step('0 · preflight')
if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) {
  die('git is not installed — install git, or update by hand per START-HERE § Updating.')
}
if (gitOut('rev-parse', '--is-inside-work-tree') !== 'true') {
  console.error(`\n${c('yellow', 'This site was not set up from git')} (a zip download, most likely). The safe zip update:`)
  console.error('  1. Download a fresh copy of the kit (Code → Download ZIP, or a release tag).')
  console.error('  2. Copy YOUR four config pieces from this folder into it, same paths:')
  console.error('       app/src/brand.config.ts · app/src/site.config.json · app/metadata/ · app/.env.local')
  console.error('  3. In the fresh copy: cd app && npm install && npm run doctor && npm run build')
  console.error('  4. Redeploy its dist/ exactly as you deployed before (keep your previous zip as the rollback).')
  process.exit(2)
}
if (existsSync(join(ROOT, '.git', 'MERGE_HEAD'))) {
  die('a merge is already in progress — finish it (git add … && git commit) or `git merge --abort` first.')
}
console.log(c('green', '✓ ') + 'git checkout found.')

// ── 1 · what's new ──
step("1 · what's new")
const remotes = (gitOut('remote') ?? '').split('\n').filter(Boolean)
if (!remotes.includes('upstream')) {
  if (!gitLoud('add upstream', 'remote', 'add', 'upstream', UPSTREAM_URL)) die('could not add the upstream remote.')
}
if (!gitLoud('fetch', 'fetch', 'upstream', '--tags', '--quiet')) {
  die('could not fetch the kit repo — check your network and rerun.')
}
const ahead = Number(gitOut('rev-list', '--count', 'HEAD..upstream/main') ?? '0')
if (!ahead) {
  console.log(c('green', '✓ ') + 'Already up to date — nothing to do.')
  process.exit(0)
}

let local = {}
let remote = {}
try {
  local = JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8'))
} catch { /* pre-version checkouts: fine */ }
try {
  remote = JSON.parse(gitOut('show', 'upstream/main:version.json') ?? '{}')
} catch { /* manifest unreadable: continue with commit count only */ }

console.log(`${c('bold', `${local.version ?? 'your current version'} → ${remote.version ?? 'latest'}`)}   (${ahead} new commit${ahead === 1 ? '' : 's'})`)
if (remote.note) console.log(`  ${remote.note}`)
const recalled = Array.isArray(remote.yanked) && local.version && remote.yanked.includes(local.version)
if (recalled) {
  console.log(c('red', `  ⚠ your current version (${local.version}) was RECALLED — it shipped with a known issue. This update fixes it.`))
}
if (remote.impact === 'config') console.log(c('yellow', '  ⚠ this update changes configuration — read CHANGELOG.md before proceeding.'))
if (remote.impact === 'breaking') console.log(c('yellow', '  ⚠ this update needs manual steps — read CHANGELOG.md before proceeding.'))
if (Array.isArray(remote.sacred) && remote.sacred.length) {
  console.log(c('yellow', `  ⚠ it touches the ${remote.sacred.map((s) => (s === 'swap' ? 'trading' : s)).join(' and ')} path (declared + extra-checked upstream).`))
}
console.log(c('dim', '  full notes: CHANGELOG.md (upstream) · every release: https://github.com/Irora-dev/Spectrum/releases'))

if (!YES) {
  if (!process.stdin.isTTY) {
    die('stdin is not interactive — rerun with --yes to proceed non-interactively (agents: read the notes above first).')
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await askSafe(rl, '\nProceed with the update? [y/N] ')).toLowerCase()
  rl.close()
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Stopped — nothing was changed.')
    process.exit(0)
  }
}

// ── 2 · snapshot your local state ──
step('2 · snapshot your local state')
// Everything modified in the checkout is the operator's (identity files, a
// build-regenerated sitemap, hand edits) — snapshot ALL of it, not just the
// identity paths: a dirty tracked file would otherwise make git refuse the
// merge outright the moment upstream touches the same file. Untracked files
// don't block merges and stay as they are.
git('add', '-u')
if (gitOut('diff', '--cached', '--quiet') === null) {
  // non-zero exit = something staged → commit the snapshot
  if (!gitCommit('snapshot: local state before kit update')) die('could not write the snapshot commit.')
  console.log(c('green', '✓ ') + 'local state snapshot committed (your config/look/metadata are safe whatever happens next).')
} else {
  console.log(c('green', '✓ ') + 'everything already committed — nothing to snapshot.')
}

// ── 3 · merge the update ──
step('3 · merge the update')
const merged = gitLoud('merge', 'merge', '--no-commit', '--no-ff', 'upstream/main')
if (!merged) {
  const conflicts = (gitOut('diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean)
  if (!conflicts.length) {
    // The merge failed for a non-conflict reason (git printed it above) — a
    // fall-through here would surface as a confusing "could not commit".
    die('the merge itself failed — see git\'s message above; nothing was changed.', 'git merge --abort   (if a merge was left in progress)')
  }
  const isIdentity = (f) => IDENTITY.some((p) => f === p || f.startsWith(`${p}/`))
  for (const f of conflicts.filter(isIdentity)) {
    // theirs-wins on the identity files — YOUR site's identity, kept verbatim
    git('checkout', '--ours', '--', f)
    git('add', '--', f)
  }
  const remaining = (gitOut('diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean)
  if (remaining.length) {
    console.error(`\n${c('red', '✗ ')}the merge needs a human decision in ${remaining.length} file(s):`)
    for (const f of remaining) console.error(`    ${f}`)
    die(
      'resolve those files, then: git add -A && git commit — then finish by hand:\n' +
        '    cd app && npm install && npm run doctor && npm run build\n' +
        '  and redeploy the same way you always deploy.',
      'git merge --abort   (returns you to exactly before the update)',
    )
  }
}
if (!gitCommit(`kit update: ${remote.version ?? 'upstream/main'}`)) {
  // A fully clean merge with nothing to commit can only mean HEAD already had it —
  // step 1's ahead-count makes that impossible; any failure here is real.
  die('could not commit the merge.', 'git merge --abort')
}
console.log(c('green', '✓ ') + 'merged — your identity files kept, the kit\'s code updated.')

// ── 3.5 · RPC check (your .env.local is gitignored — updates can never touch it;
// but a site that never had RPC configured should get the chance NOW, before the
// build bakes another keyless bundle). Skipped silently when any rail is set. ──
const envPath = join(APP, '.env.local')
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const envHas = (k) => new RegExp(`^${k}=.+$`, 'm').test(envText)
const hasRpc =
  envHas('VITE_ALCHEMY_API_KEY') || envHas('VITE_BASE_RPC_URL') || envHas('VITE_MAINNET_RPC_URL') || envHas('VITE_ROBINHOOD_RPC_URL')
if (!hasRpc) {
  if (!YES && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log(`\n${c('yellow', '⚠ ')}No RPC configured in app/.env.local (fine on git-connected CI where it lives in the host dashboard).`)
    const rpc = await askSafe(rl, 'Paste an Alchemy key, or a full https endpoint URL from any provider (Enter to skip): ')
    let lines = null
    if (/^https?:\/\//i.test(rpc)) {
      const chain = (await askSafe(rl, 'Which chain is that URL for? base/ethereum/robinhood (base): ')).toLowerCase()
      const varName = chain.startsWith('e') ? 'VITE_MAINNET_RPC_URL' : chain.startsWith('r') ? 'VITE_ROBINHOOD_RPC_URL' : 'VITE_BASE_RPC_URL'
      lines = `${varName}=${rpc}`
    } else if (rpc) {
      lines = `VITE_ALCHEMY_API_KEY=${rpc}`
    }
    rl.close()
    if (lines) {
      writeFileSync(
        envPath,
        (envText ? envText.replace(/\n*$/, '\n\n') : '') +
          '# Added by create/update.mjs — ships in the public bundle; restrict it to your domain.\n' +
          lines +
          '\n',
      )
      console.log(c('green', '✓ ') + 'RPC written to app/.env.local (stays out of git).')
    } else {
      console.log(c('dim', '  · skipped — the site keeps running on public endpoints (V4 pool coverage stays partial).'))
    }
  } else {
    console.log(`${c('yellow', '⚠ ')}No RPC configured in app/.env.local — the site runs on public endpoints (V4 pool coverage partial). Add an Alchemy key or provider URL there (or in the host dashboard on CI) and rebuild.`)
  }
}

// ── 4 · install · check · build ──
const UNDO = 'git reset --hard ORIG_HEAD   (undoes the update; your identity snapshot survives)'
step('4 · install · check · build')
npmLoud('dependency install', ['install'], UNDO)
npmLoud('doctor (config + live chain + version)', ['run', 'doctor'], UNDO)
npmLoud('production build', ['run', 'build'], UNDO)

// ── 5 · redeploy (the only step that touches your live site) ──
step('5 · redeploy')
console.log(c('green', '✓ ') + `updated to ${remote.version ?? 'the latest kit'} and built. Your LIVE site still runs the old build.`)
let host = HOST
if (!host && !YES && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  host = (await askSafe(rl, 'How is this site hosted? [zip/cloudflare/netlify/vercel/vps/later] ', 'later')).toLowerCase()
  rl.close()
}
console.log('')
for (const line of hostingGuide(host || 'later')) console.log(line)
console.log(`\n${c('dim', 'Rollback insurance: your host keeps previous deploys (one-click restore on Pages/Netlify/Vercel;')}`)
console.log(c('dim', 'on a VPS keep the previous dist/ beside the live one). Undo the checkout itself anytime with:'))
console.log(c('dim', `  ${UNDO}`))
