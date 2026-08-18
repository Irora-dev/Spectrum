#!/usr/bin/env node
// THE SPLIT GATE — one command for the product-separation transition.
//
// While the portfolio system is being extracted in place (the site keeps
// serving it; a second product vendors the core), every kit commit should be
// able to answer four questions in one call:
//   1. did the product boundary grow?           (import-boundary ratchet)
//   2. did basket money bytes change?           (golden masters)
//   3. did a money seam ship unwired?           (seam-supply guard)
//   4. do the money law families still hold?    (portfolio-money-properties)
// …then the typecheck, exit code read directly (a piped exit code is
// bug-class 5; docs/BUG-CLASSES.md).
//
// This gate is ADVISORY tooling for the transition — it does not replace the
// release ceremony (interlock, sweeps, the external row), it just makes the
// everyday loop cheap.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (label, cmd, args) => {
  console.log(`\n── ${label}`)
  const r = spawnSync(cmd, args, { cwd: APP, stdio: 'inherit' })
  if ((r.status ?? 1) !== 0) {
    console.error(`\nsplit-gate: FAILED at ${label}`)
    process.exit(r.status ?? 1)
  }
}

run('boundary + goldens + seams + properties', 'npx', [
  'vitest',
  'run',
  'src/lib/spectrum/import-boundary.guard.test.ts',
  'src/lib/spectrum/basket-golden-masters.test.ts',
  'src/lib/spectrum/seam-supply.guard.test.ts',
  'src/lib/spectrum/portfolio-money-properties.test.ts',
])
run('typecheck', 'npm', ['run', 'typecheck'])
console.log('\nsplit-gate: clean')
