// Publish to the Chrome Web Store in one command — upload the built zip to
// the operator's store item and submit it for review. After the ONE-TIME
// setup below, every release is:
//
//   node scripts/package.mjs && node scripts/publish-chrome.mjs
//
// One-time setup (the irreducible human part, ~15 minutes + Google's review
// wait — no API removes it):
//   1. Chrome Web Store developer account ($5 one-time):
//      https://chrome.google.com/webstore/devconsole
//   2. First submission: `--create` uploads the zip as a NEW item and prints
//      its id — then finish the listing in the dashboard once (paste
//      store/listing.md, upload store/screenshot-*.png, answer the privacy
//      tab, set visibility — Unlisted recommended for white-label).
//   3. API credentials (for this script): enable "Chrome Web Store API" on a
//      Google Cloud project, create an OAuth client (Desktop), mint a refresh
//      token with scope https://www.googleapis.com/auth/chromewebstore.
//
// Env (put them in extension/.env.local — gitignored):
//   CWS_CLIENT_ID · CWS_CLIENT_SECRET · CWS_REFRESH_TOKEN
//   CWS_ITEM_ID                (omit when using --create)
//   CWS_PUBLISH_TARGET         default | trustedTesters   (default: default)
//
// Flags: --create (new item) · --no-publish (upload only, submit manually)
//
// NOTE: written against the documented Chrome Web Store API v1.1; not
// executed here (needs real credentials) — the API's own responses are
// authoritative and are printed verbatim.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = new Set(process.argv.slice(2))

// .env.local (KEY=value lines) → env, without overriding real env vars.
const envFile = resolve(root, '.env.local')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}

const { CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_ITEM_ID } = process.env
if (!CWS_CLIENT_ID || !CWS_CLIENT_SECRET || !CWS_REFRESH_TOKEN) {
  console.error('Missing CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN (see header for the one-time setup).')
  process.exit(1)
}
const creating = args.has('--create')
if (!creating && !CWS_ITEM_ID) {
  console.error('CWS_ITEM_ID missing — pass --create for a first submission, which prints the new id.')
  process.exit(1)
}

// The store artifact: prefer artifacts/ (package.mjs output), else zip is the
// caller's job — fail plainly rather than zipping stale dist silently.
const artifacts = resolve(root, 'artifacts')
const zipName = existsSync(artifacts)
  ? (await import('node:fs')).readdirSync(artifacts).find((f) => f.endsWith('-extension-chrome.zip'))
  : null
if (!zipName) {
  console.error('No chrome zip in artifacts/ — run: node scripts/package.mjs')
  process.exit(1)
}
const zip = readFileSync(resolve(artifacts, zipName))

// 1 · OAuth: refresh token → access token.
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: CWS_CLIENT_ID,
    client_secret: CWS_CLIENT_SECRET,
    refresh_token: CWS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }),
})
const token = (await tokenRes.json())
if (!token.access_token) {
  console.error('OAuth failed:', JSON.stringify(token))
  process.exit(1)
}
const auth = { Authorization: `Bearer ${token.access_token}`, 'x-goog-api-version': '2' }

// 2 · Upload (new item, or a new version of the existing one).
const uploadUrl = creating
  ? 'https://www.googleapis.com/upload/chromewebstore/v1.1/items'
  : `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CWS_ITEM_ID}`
const upload = await fetch(uploadUrl, { method: creating ? 'POST' : 'PUT', headers: auth, body: zip })
const uploaded = await upload.json()
console.log('upload:', JSON.stringify(uploaded))
if (uploaded.uploadState !== 'SUCCESS' && uploaded.uploadState !== 'IN_PROGRESS') {
  console.error('Upload not accepted — itemError above is the store speaking.')
  process.exit(1)
}
const itemId = creating ? uploaded.id : CWS_ITEM_ID
if (creating) {
  console.log(`NEW ITEM: ${itemId} — save as CWS_ITEM_ID. Finish the listing once in the dashboard`)
  console.log('(store/listing.md + store/screenshot-*.png + privacy tab), then re-run without --create.')
}

// 3 · Publish (submits for review; the wait is Google's, not ours).
if (!args.has('--no-publish') && !creating) {
  const target = process.env.CWS_PUBLISH_TARGET || 'default'
  const pub = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${itemId}/publish?publishTarget=${target}`,
    { method: 'POST', headers: auth },
  )
  console.log('publish:', JSON.stringify(await pub.json()))
  console.log('Submitted for review. Status: https://chrome.google.com/webstore/devconsole')
}
