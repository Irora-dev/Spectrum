import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'wait-for-apply.mjs')

function tempApp() {
  const dir = mkdtempSync(join(tmpdir(), 'wfa-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'brand.config.ts'), 'export const brand = {}\n')
  return dir
}

function run(appDir, timeoutSec) {
  const child = spawn(process.execPath, [SCRIPT, '--app-dir', appDir, '--timeout', String(timeoutSec)])
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += c })
  const done = new Promise((res) => child.on('close', (code) => res({ code, out })))
  return { child, done }
}

test('exits 0 with next steps when a config write lands (studio Apply / wizard)', async () => {
  const app = tempApp()
  const { done } = run(app, 10)
  // Simulate the studio's Apply: .env.local appears (creation counts as the apply).
  setTimeout(() => writeFileSync(join(app, '.env.local'), 'VITE_ENABLE_WALLET=true\n'), 700)
  const { code, out } = await done
  assert.equal(code, 0)
  assert.match(out, /Setup applied/)
  assert.match(out, /check:config/)
})

test('exits 2 on timeout when nothing is applied', async () => {
  const app = tempApp()
  const { done } = run(app, 1)
  const { code, out } = await done
  assert.equal(code, 2)
  assert.match(out, /No apply detected/)
})
