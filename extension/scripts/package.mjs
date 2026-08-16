// Build every distributable the extension has, branded from the operator's
// own config — the wizard's one call:
//
//   node scripts/package.mjs [--into-site] [--no-build]
//
//   artifacts/<slug>-extension-chrome.zip    Chrome Web Store submission zip
//                                            (also what load-unpacked uses,
//                                            unzipped)
//   artifacts/<slug>-extension-firefox.zip   AMO submission zip
//   artifacts/*.xpi                          SIGNED self-hostable Firefox
//                                            build — produced only when AMO
//                                            credentials are present:
//                                            WEB_EXT_API_KEY + WEB_EXT_API_SECRET
//                                            (generated at
//                                            addons.mozilla.org/developers/addon/api/key/;
//                                            unlisted channel = automated
//                                            signing, no store listing)
//   artifacts/index.json                     What exists + versions, for the
//                                            site's /extension page to render
//
// --into-site additionally copies the artifacts into ../app/public/extension/
// so THE SITE ITSELF hosts its extension downloads — every deploy of the site
// distributes the lens. (A website can never install an extension — Chrome
// removed inline install in 2018 — so this is the honest maximum: the site
// serves the artifact + the store/xpi link, one browser confirmation away.)

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const artifacts = resolve(root, 'artifacts')
const args = new Set(process.argv.slice(2))

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: root, stdio: 'inherit', ...opts })

// 0 · Brand → slug (the operator's name, kebabed, same rules as the manifest).
const { default: brand } = await import('../../app/src/brand.config.ts').catch(() => ({ default: null }))
// brand.config is TypeScript; when node can't import it directly, fall back to
// the built manifest's name (present after the build step below).
const slugOf = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'spectrum'

// 1 · Fresh builds (skippable for CI that already built).
if (!args.has('--no-build')) {
  run('npm', ['run', 'build'])
  run('npm', ['run', 'build:firefox'])
}
if (!existsSync(resolve(root, 'dist/manifest.json')) || !existsSync(resolve(root, 'dist-firefox/manifest.json'))) {
  console.error('dist/ or dist-firefox/ missing — run without --no-build.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(resolve(root, 'dist/manifest.json'), 'utf8'))
const slug = slugOf(brand?.name ?? manifest.name.split('·')[0])
const version = manifest.version

// 2 · Zips.
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })
const chromeZip = `${slug}-extension-chrome.zip`
const firefoxZip = `${slug}-extension-firefox.zip`
run('zip', ['-qr', resolve(artifacts, chromeZip), '.'], { cwd: resolve(root, 'dist') })
run('zip', ['-qr', resolve(artifacts, firefoxZip), '.'], { cwd: resolve(root, 'dist-firefox') })

// 3 · Signed .xpi — only with the operator's AMO credentials in the env.
//     Unlisted signing is an AUTOMATED api step (minutes), not a store review;
//     the resulting .xpi self-hosts on the operator's site with one-click
//     install. Untested here (needs real credentials) — web-ext's own output
//     is authoritative.
let xpi = null
if (process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET) {
  run('npx', [
    '--yes',
    'web-ext@8',
    'sign',
    '--source-dir',
    'dist-firefox',
    '--channel',
    'unlisted',
    '--artifacts-dir',
    'artifacts',
  ])
  xpi = readdirSync(artifacts).find((f) => f.endsWith('.xpi')) ?? null
} else {
  console.log('AMO credentials absent (WEB_EXT_API_KEY/SECRET) — skipping the signed .xpi.')
}

// 4 · The descriptor the site's /extension page renders from.
writeFileSync(
  resolve(artifacts, 'index.json'),
  JSON.stringify({ name: manifest.name, version, chrome: chromeZip, firefox: firefoxZip, xpi }, null, 2),
)

// 5 · Into the site's own public dir, so the site hosts its extension.
if (args.has('--into-site')) {
  const siteDir = resolve(root, '../app/public/extension')
  rmSync(siteDir, { recursive: true, force: true })
  mkdirSync(siteDir, { recursive: true })
  cpSync(artifacts, siteDir, { recursive: true })
  // The signed .xpi moves under xpi/ in the SITE copy only: Netlify's _headers
  // syntax has no extension globs (a `*.xpi` segment is literal), so the
  // xpinstall MIME rule targets /extension/xpi/* as a trailing splat. The site
  // descriptor carries the subpath; artifacts/ keeps its flat layout.
  if (xpi) {
    mkdirSync(resolve(siteDir, 'xpi'), { recursive: true })
    renameSync(resolve(siteDir, xpi), resolve(siteDir, 'xpi', xpi))
    writeFileSync(
      resolve(siteDir, 'index.json'),
      JSON.stringify({ name: manifest.name, version, chrome: chromeZip, firefox: firefoxZip, xpi: `xpi/${xpi}` }, null, 2),
    )
  }
  console.log(`copied into app/public/extension/ (${chromeZip}, ${firefoxZip}${xpi ? `, xpi/${xpi}` : ''})`)
}

console.log(`packaged v${version} as "${manifest.name}" → artifacts/`)
