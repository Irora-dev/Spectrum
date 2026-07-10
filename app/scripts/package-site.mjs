#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Spectrum Mini — site packager (owner 2026-07-10). Turns the built site into a
// single drop-ready zip, so hosting is "drag this onto the host's upload page":
//
//   npm run package          # build + zip → app/<name>-site.zip
//
// The zip holds the CONTENTS of dist/ (index.html at the zip root — the layout
// Netlify Drop and Cloudflare's direct upload expect), including `_redirects`
// so deep links work on hosts that honor it. Drop targets:
//
//   • Netlify Drop — https://app.netlify.com/drop  (zip or folder)
//   • Cloudflare Pages — dashboard → Workers & Pages → Create → Pages →
//     "Upload assets"  (zip or folder)
//   • any static host with an upload box — or just drag the app/dist/ FOLDER
//
// Zipping uses the system archiver (`zip`, else bsdtar as `tar -a`) — no npm
// dependency. If neither exists, dist/ itself is already the drop-ready folder.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(APP, 'dist')

const C = { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
const tty = process.stdout.isTTY
const c = (k, s) => (tty ? C[k] + s + C.reset : s)

if (!existsSync(resolve(DIST, 'index.html'))) {
  console.error(c('red', '✗ No build found (dist/index.html missing). Run `npm run build` first — or use `npm run package`, which builds for you.'))
  process.exit(1)
}

// Name the zip after the site (brand.config name → slug), so the file on the
// operator's desktop says whose site it is.
let slug = 'site'
try {
  const m = readFileSync(resolve(APP, 'src/brand.config.ts'), 'utf8').match(/name:\s*("(?:[^"\\]|\\.)*")/)
  const name = m ? JSON.parse(m[1]) : ''
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (s) slug = s
} catch {
  /* unreadable brand config — generic name */
}
// "Acme Site" must not become acme-site-site.zip — the suffix dedupes.
const base = slug.replace(/-?site$/, '')
const zipName = base ? `${base}-site.zip` : 'site.zip'
const zipPath = resolve(APP, zipName)
rmSync(zipPath, { force: true })

// System archiver: `zip` (macOS/Linux; -X drops platform extras), else bsdtar
// (`tar -a` picks zip by extension — Windows 10+ and macOS tar are bsdtar; GNU
// tar is not, so probe for "bsdtar" before trusting -a).
function makeZip() {
  const zip = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: DIST, stdio: 'inherit' })
  if (!zip.error && zip.status === 0) return true
  const ver = spawnSync('tar', ['--version'], { encoding: 'utf8' })
  if (!ver.error && /bsdtar/.test(ver.stdout ?? '')) {
    const tar = spawnSync('tar', ['-a', '-cf', zipPath, '-C', DIST, '.'], { stdio: 'inherit' })
    if (!tar.error && tar.status === 0) return true
  }
  return false
}

console.log('')
console.log(c('bold', 'Spectrum Mini — package for zip-drop hosting'))
if (!makeZip()) {
  console.log(c('dim', '  No system zip tool found (`zip` or bsdtar). No problem — the folder itself is drop-ready:'))
  console.log(`  drag ${c('bold', 'app/dist/')} onto the host's upload page (Netlify Drop, Cloudflare Pages "Upload assets", …).`)
  process.exit(0)
}

const mb = (statSync(zipPath).size / 1_000_000).toFixed(1)
console.log(c('green', `  ✓ app/${zipName}`) + c('dim', ` (${mb} MB — dist/ contents, index.html at the zip root)`))
console.log('')
console.log('  Drop it (zip or the app/dist/ folder) onto:')
console.log(`  • ${c('bold', 'Netlify Drop')} — https://app.netlify.com/drop`)
console.log(`  • ${c('bold', 'Cloudflare Pages')} — dashboard → Workers & Pages → Create → Pages → Upload assets`)
console.log(`  • any static host with an upload box`)
console.log('')
console.log(c('dim', '  Deep links: `_redirects` ships inside (Netlify + Cloudflare honor it). On a host that'))
console.log(c('dim', '  ignores it, enable its own "SPA fallback to index.html" setting or deep links 404.'))
console.log(c('dim', '  Your own server (VPS/nginx/Apache/Caddy): unzip into the web root — the two rules you'))
console.log(c('dim', '  need are ready to paste in SETUP.md → "Your own server".'))
console.log(c('dim', '  If the final URL differs from your configured site URL, update it and rebuild.'))
console.log('')
