// The extension's introspection contract — what the kit's setup studio and
// update flow render their "extension" panel from. Read-only, no side
// effects, one JSON object with everything a surface needs to say "here's
// where you are, here's the next command":
//
//   node scripts/status.mjs          human summary
//   node scripts/status.mjs --json   machine form (the studio/update contract)
//
// Consumed by (kit lane): create/update.mjs's what's-new step and the /setup
// studio's extension panel. Keys are append-only; never repurpose one.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// .env.local (KEY=value) — presence only; values never leave this process.
const env = { ...process.env }
try {
  for (const line of readFileSync(resolve(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
    if (m && !(m[1] in env)) env[m[1]] = m[2]
  }
} catch {
  /* no .env.local */
}

const pkg = readJson(resolve(root, 'package.json'))
const chrome = readJson(resolve(root, 'dist/manifest.json'))
const firefox = readJson(resolve(root, 'dist-firefox/manifest.json'))
const artifactsDir = resolve(root, 'artifacts')
const artifacts = existsSync(artifactsDir) ? readdirSync(artifactsDir).sort() : []
const siteDir = resolve(root, '../app/public/extension')
// One level of xpi/ expansion: the packaging step nests the signed file
// (Netlify header reach), and 'xpi' as a bare dir entry told consumers nothing.
const siteHosted = existsSync(siteDir)
  ? readdirSync(siteDir)
      .flatMap((f) => {
        try {
          return readdirSync(resolve(siteDir, f)).map((inner) => `${f}/${inner}`)
        } catch {
          return [f]
        }
      })
      .sort()
  : []
const store = resolve(root, 'store')

const status = {
  v: 1,
  version: pkg?.version ?? null,
  name: chrome?.name ?? null,
  /** Site origin the build is bound to (drives the detect marker + deep links). */
  siteConfigured: Boolean(chrome?.content_scripts?.length),
  built: {
    chrome: Boolean(chrome),
    firefox: Boolean(firefox),
    /** Chrome + Brave + Edge install from the same artifact. */
    firefoxGeckoId: firefox?.browser_specific_settings?.gecko?.id ?? null,
  },
  packaged: {
    artifacts,
    /** The site is hosting its own extension downloads (deploys with it). */
    intoSite: siteHosted.length > 0,
    siteHosted,
    signedXpi: artifacts.find((f) => f.endsWith('.xpi')) ?? null,
  },
  storeAssets: {
    listing: existsSync(resolve(store, 'listing.md')),
    screenshots: existsSync(store) ? readdirSync(store).filter((f) => f.endsWith('.png')).length : 0,
  },
  credentials: {
    /** Firefox self-host signing (WEB_EXT_API_KEY/SECRET). */
    amo: Boolean(env.WEB_EXT_API_KEY && env.WEB_EXT_API_SECRET),
    /** Chrome Web Store publish API (CWS_CLIENT_ID/SECRET/REFRESH_TOKEN). */
    cws: Boolean(env.CWS_CLIENT_ID && env.CWS_CLIENT_SECRET && env.CWS_REFRESH_TOKEN),
    cwsItemId: env.CWS_ITEM_ID ?? null,
  },
  /** The next command a surface should offer, in order. */
  next: [],
}

if (!status.built.chrome) status.next.push({ run: 'npm run build', why: 'no Chrome build yet' })
else if (!status.built.firefox) status.next.push({ run: 'npm run build:firefox', why: 'no Firefox build yet' })
else if (status.packaged.artifacts.length === 0)
  status.next.push({ run: 'npm run package -- --into-site', why: 'nothing packaged — the site is not hosting its extension yet' })
if (!status.storeAssets.listing)
  status.next.push({ run: 'npm run store:assets', why: 'no store submission pack yet' })
if (status.credentials.cws && !status.credentials.cwsItemId)
  status.next.push({ run: 'npm run publish:chrome -- --create', why: 'CWS credentials present, no store item yet' })
if (!status.credentials.amo && !status.packaged.signedXpi)
  status.next.push({
    run: 'add WEB_EXT_API_KEY/SECRET to .env.local, then npm run package',
    why: 'no signed .xpi — Firefox one-click self-hosting is waiting on AMO keys',
  })

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(status, null, 2))
} else {
  const yn = (b) => (b ? 'yes' : 'no')
  console.log(`${status.name ?? '(unbuilt)'} v${status.version}`)
  console.log(`site-bound build: ${yn(status.siteConfigured)} · chrome built: ${yn(status.built.chrome)} · firefox built: ${yn(status.built.firefox)}`)
  console.log(`packaged: ${status.packaged.artifacts.length ? status.packaged.artifacts.join(', ') : 'no'} · hosted by site: ${yn(status.packaged.intoSite)}`)
  console.log(`store pack: listing ${yn(status.storeAssets.listing)}, ${status.storeAssets.screenshots} screenshot(s)`)
  console.log(`creds: AMO ${yn(status.credentials.amo)} · CWS ${yn(status.credentials.cws)}${status.credentials.cwsItemId ? ` (item ${status.credentials.cwsItemId})` : ''}`)
  for (const n of status.next) console.log(`→ ${n.run}   (${n.why})`)
}
