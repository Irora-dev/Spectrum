#!/usr/bin/env node
// THE SEAM-SUPPLY GATE — CI wrapper for seam-supply.guard.test.ts.
//
// The guard itself is a vitest source-scan: every optional member of the
// runner's money context must be supplied at the composition roots, or be an
// allowlisted seen decision (docs/BUG-CLASSES.md class 1 — the unsupplied
// seam, measured live twice in one week). This wrapper exists so a pipeline
// can run the one gate by name and read ONE exit code — vitest's own, passed
// through untouched (never through a pipe; a piped exit code is class 5).
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
console.log('seam-supply gate: every optional runner-context member is supplied at the composition roots, or is a seen decision')
const r = spawnSync('npx', ['vitest', 'run', 'src/lib/spectrum/seam-supply.guard.test.ts'], {
  cwd: APP,
  stdio: 'inherit',
})
process.exit(r.status ?? 1)
