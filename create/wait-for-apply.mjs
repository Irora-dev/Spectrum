#!/usr/bin/env node
// wait-for-apply — the terminal side of the browser→terminal baton pass. Blocks until the
// /setup studio's Apply (or any write of the config files: a wizard run, a hand edit)
// lands, then prints the next steps and exits 0 — so an agent that ran this command wakes
// up the moment the user presses Apply, with zero user action in the terminal.
//
//   node create/wait-for-apply.mjs                       # waits up to 30 min
//   node create/wait-for-apply.mjs --timeout 600         # seconds; exits 2 on timeout
//
// Zero-dep (Node built-ins). Watches mtimes of app/src/brand.config.ts + app/.env.local
// by polling (portable; fs.watch is unreliable across editors/platforms for this).
import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argv, exit } from 'node:process'

const args = argv.slice(2)
const flagVal = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const APP = resolve(flagVal('app-dir', resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app')))
const timeoutSec = Math.max(1, Number(flagVal('timeout', '1800')) || 1800)
const FILES = ['src/brand.config.ts', 'src/site.config.json', '.env.local'].map((f) => resolve(APP, f))

const mtime = (p) => {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0 // not there yet (a fresh clone has no .env.local) — its creation counts as the apply
  }
}

const startAt = FILES.map(mtime)
const t0 = Date.now()
console.log('Waiting for Apply in the setup studio (watching brand.config.ts + site.config.json + .env.local)…')

const tick = () => {
  if (FILES.some((f, i) => mtime(f) > startAt[i])) {
    console.log('')
    console.log('✓ Setup applied — the config landed in the project.')
    console.log('Next steps:')
    console.log('  1. cd app && npm run check:config    validate; fix anything red')
    console.log('  2. npm run build                     bakes exactly this setup into app/dist/')
    console.log('  3. put it online                     START-HERE.md Stage 3 (an agent can run it)')
    exit(0)
  }
  if (Date.now() - t0 > timeoutSec * 1000) {
    console.error('⚠ No apply detected within the timeout. Re-run me, or ask the user whether they pressed Apply.')
    exit(2)
  }
  setTimeout(tick, 500)
}
tick()
