// Produce dist-firefox/ from the Chrome build: same popup, same assets, with
// the two Firefox differences applied —
//   · background: an event-page script (sw.js, built as one IIFE by
//     vite.firefox.config.ts) instead of a module service worker;
//   · browser_specific_settings.gecko: a stable per-operator id (derived from
//     the configured site host) + the MV3 floor. minimum_chrome_version drops.
// The marker content script is re-emitted as a plain standalone file — its
// value is being trivially auditable, so it ships unbundled.
//
// Usage: node scripts/build-firefox.mjs   (expects dist/ to exist; run the
// Chrome build first — npm run build:all does both in order.)

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dist = resolve(root, 'dist')
const out = resolve(root, 'dist-firefox')

if (!existsSync(resolve(dist, 'manifest.json'))) {
  console.error('dist/ missing — run the Chrome build first (npm run build).')
  process.exit(1)
}

// 1 · Fresh copy of the Chrome dist (minus Vite metadata + the module SW loader).
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(dist, out, { recursive: true })
rmSync(resolve(out, '.vite'), { recursive: true, force: true })
rmSync(resolve(out, 'service-worker-loader.js'), { force: true })

// 2 · The event-page worker: one IIFE, dynamic imports inlined.
execFileSync('npx', ['vite', 'build', '--config', 'vite.firefox.config.ts'], {
  cwd: root,
  stdio: 'inherit',
})

// 3 · The manifest transform.
const manifest = JSON.parse(readFileSync(resolve(out, 'manifest.json'), 'utf8'))

manifest.background = { scripts: ['sw.js'] }
delete manifest.minimum_chrome_version

// Stable per-operator add-on id — AMO signing requires one, and deriving it
// from the operator's site host keeps every white-label build distinct.
const siteMatch = manifest.content_scripts?.[0]?.matches?.[0]
const siteHost = siteMatch ? new URL(siteMatch.replace(/\/\*$/, '/')).host : null
manifest.browser_specific_settings = {
  gecko: {
    id: `lens@${siteHost ?? 'unconfigured.spectrum-mini'}`,
    strict_min_version: '115.0',
  },
}

// The marker ships as a plain readable file (no bundler wrapper), so the
// content script entry — and its Chrome-side web_accessible_resources plumbing
// — is replaced wholesale.
if (manifest.content_scripts?.length) {
  const esbuild = await import('esbuild')
  const src = readFileSync(resolve(root, 'src/content/marker.ts'), 'utf8')
  const { code } = esbuild.transformSync(src, { loader: 'ts' })
  writeFileSync(resolve(out, 'content-marker.js'), code)
  manifest.content_scripts = manifest.content_scripts.map((cs) => ({
    ...cs,
    js: ['content-marker.js'],
  }))
  delete manifest.web_accessible_resources
}

writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`dist-firefox ready · gecko id: ${manifest.browser_specific_settings.gecko.id}`)
