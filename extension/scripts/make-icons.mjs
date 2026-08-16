// Regenerate the extension icon set from the app's shipped icon so the two
// surfaces stay one product. macOS-only (uses `sips`, no dependencies); the
// generated PNGs are committed, so this only runs when the source icon changes.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../app/public/icon-512.png')
const outDir = resolve(here, '../public/icons')
mkdirSync(outDir, { recursive: true })

for (const size of [16, 32, 48, 128]) {
  const out = resolve(outDir, `icon-${size}.png`)
  execFileSync('sips', ['-z', String(size), String(size), src, '--out', out], { stdio: 'ignore' })
  console.log(`icon-${size}.png`)
}
