#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Spectrum V2 frontend — config doctor.
//
// Validates the operator's build config (`.env.local` + `deployments.json`)
// BEFORE `vite build`, turning footguns that today only surface at runtime /
// in-browser into a fast, pre-deploy check. It is the single thing that makes
// "did I wire this up right?" answerable without shipping and clicking around.
//
// Read-only. Prints a report and exits NON-ZERO only on a FATAL misconfiguration
// — a transactional flag without the wallet flag, or a malformed address — the
// same class of error the app throws on at module load (features.ts) or silently
// drops to null (deployments.ts). Warnings (checksum, an empty secondary chain,
// a missing site origin, a stub sitemap) never block the build.
//
//   node scripts/check-config.mjs      # run it directly
//   npm run check:config               # the same, as a named script
//   npm run build                      # runs automatically via the prebuild hook
//
// Bypass (escape hatch): run `vite build` directly — the prebuild hook only runs
// for the `build` script, so the raw bundler call skips this check.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { isAddress, getAddress } from 'viem'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── env resolution (mirror Vite: .env.local is loaded; a real shell var wins) ──
function parseEnvFile(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    } else {
      // Unquoted values: strip an inline `# comment`, as dotenv/Vite do — otherwise a
      // `VITE_X=   # note` line reads as the note text here while Vite reads it as empty,
      // and the checks silently diverge from the build.
      v = v.replace(/(^|\s)#.*$/, '').trim()
    }
    out[key] = v
  }
  return out
}

const env = parseEnvFile(resolve(APP_DIR, '.env.local'))
// A real shell var overrides .env.local (matches dotenv/Vite precedence), so an
// inline `VITE_ENABLE_WALLET=true npm run build` is validated correctly too.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('VITE_')) env[k] = process.env[k]
}
const val = (k) => (env[k] ?? '').trim()
const isOn = (k) => val(k) === 'true'
const validAddr = (v) => !!v && isAddress(v, { strict: false })

let deployments = {}
try {
  deployments = JSON.parse(readFileSync(resolve(APP_DIR, 'src/lib/chain/deployments.json'), 'utf8'))
} catch {
  /* no/invalid deployments.json — treated as empty, like the app does */
}

// The committed deploy identity (src/site.config.json: siteUrl + feeWallet) — the setup
// studio/wizard write it; the VITE_* env vars override it (same precedence as the app).
// The raw parse is kept separate so the schema-drift check (6c) can see which keys the
// operator's file ACTUALLY carries, not the defaults merged in here.
let siteCfgRaw = null
try {
  siteCfgRaw = JSON.parse(readFileSync(resolve(APP_DIR, 'src/site.config.json'), 'utf8'))
} catch {
  /* missing/invalid site.config.json — treated as empty */
}
const siteCfg = { siteUrl: '', feeWallet: '', ...(siteCfgRaw && typeof siteCfgRaw === 'object' ? siteCfgRaw : {}) }

const BASE = 8453
const SCAFFOLDED = new Set([8453, 1, 4663]) // chains.ts SCAFFOLDS
const CHAIN_NAME = { 8453: 'Base', 1: 'Ethereum', 4663: 'Robinhood' }

const errors = []
const warns = []
const infos = []

// Resolve an address field for a chain the way the app does: VITE_* overrides
// apply to the DEFAULT chain (Base) only; every other chain reads deployments.json.
function resolved(field, envVar, chainId = BASE) {
  if (chainId === BASE && validAddr(val(envVar))) return val(envVar)
  const entry = deployments[String(chainId)] || {}
  return validAddr(entry[field]) ? entry[field] : null
}

// ── 1. FATAL: a transactional flag without the wallet flag (mirrors features.ts) ──
// Flags resolve the way the app does: the env var when SET (override, incl. an
// explicit false) → else the committed site.config.json features.
const feats = siteCfg.features || {}
const flagOn = (k, committed) => (k in env ? String(env[k]).trim() === 'true' : committed === true)
const wallet = flagOn('VITE_ENABLE_WALLET', feats.wallet)
const deploy = flagOn('VITE_ENABLE_DEPLOY', feats.deploy)
const trading = flagOn('VITE_ENABLE_TRADING', feats.trading)
const swap = flagOn('VITE_ENABLE_SWAP', feats.swap)
if ((deploy || trading || swap) && !wallet) {
  errors.push(
    'VITE_ENABLE_DEPLOY / VITE_ENABLE_TRADING / VITE_ENABLE_SWAP require VITE_ENABLE_WALLET=true.\n' +
      '      This is the same invariant the app throws on at load — caught here before you ship.',
  )
}

// The single-purpose surface this flag combo expresses.
let tier
if (!wallet && !deploy && !trading && !swap) {
  tier = 'info-only (browse / read; no wallet) — the no-env fallback; onboarding configs default to all features'
} else {
  const parts = []
  if (deploy) parts.push('creation tool')
  if (trading) parts.push('fee console')
  if (swap) parts.push('buy/sell')
  const base = wallet ? 'wallet' : 'NO-WALLET (invalid)'
  tier = parts.length ? `${base} + ${parts.join(' + ')}` : `${base} (read-only)`
}

// ── 2. address fields: format (fatal) + EIP-55 checksum (warn) ──
const ADDR_VARS = [
  'VITE_FACTORY_ADDRESS',
  'VITE_USDC_ADDRESS',
  'VITE_POOL_MANAGER_ADDRESS',
  'VITE_SWAP_ROUTER_ADDRESS',
  'VITE_WETH_ADDRESS',
  'VITE_UNIV2_FACTORY_ADDRESS',
  'VITE_UNIV3_FACTORY_ADDRESS',
  'VITE_UNIV3_SWAP_ROUTER_ADDRESS',
  'VITE_UNIV3_QUOTER_ADDRESS',
  'VITE_AERODROME_FACTORY_ADDRESS',
  'VITE_INTERFACE_TAG_ADDRESS',
  'VITE_LAUNCHER_ADDRESS',
]
for (const k of ADDR_VARS) {
  const v = val(k)
  if (!v) continue
  if (!isAddress(v, { strict: false })) {
    errors.push(`${k} is not a valid address ("${v}"). The app silently drops it to null → the surface that needs it looks misconfigured.`)
    continue
  }
  // Only flag a checksum miss when the operator clearly intended a checksummed
  // (mixed-case) address — all-lowercase is valid + common and must not warn.
  const body = v.slice(2)
  if (/[a-f]/.test(body) && /[A-F]/.test(body)) {
    let ok = false
    try {
      ok = getAddress(v) === v
    } catch {
      ok = false
    }
    if (!ok) warns.push(`${k} fails its EIP-55 checksum ("${v}") — likely a typo. (All-lowercase is accepted; a mixed-case address must checksum.)`)
  }
}

// ── 2b. VITE_HIDDEN_BASKETS: an address LIST (operator list-curation). A
//        malformed entry is silently dropped by the app — i.e. the basket you
//        meant to hide STAYS LISTED — so format errors here are fatal. ──
const hiddenRaw = val('VITE_HIDDEN_BASKETS')
if (hiddenRaw) {
  for (const part of hiddenRaw.split(',')) {
    const v = part.trim()
    if (!v) continue
    if (!isAddress(v, { strict: false })) {
      errors.push(
        `VITE_HIDDEN_BASKETS entry "${v}" is not a valid address. The app drops it → that basket is NOT hidden.`,
      )
      continue
    }
    const body = v.slice(2)
    if (/[a-f]/.test(body) && /[A-F]/.test(body)) {
      let ok = false
      try {
        ok = getAddress(v) === v
      } catch {
        ok = false
      }
      if (!ok)
        warns.push(
          `VITE_HIDDEN_BASKETS entry "${v}" fails its EIP-55 checksum — likely a typo. (All-lowercase is accepted; a mixed-case address must checksum.)`,
        )
    }
  }
}

// ── 3. factory presence: signpost the intentional empty shell ──
if (!resolved('factory', 'VITE_FACTORY_ADDRESS', BASE)) {
  infos.push('No factory configured for Base → the app is an honest empty shell (lists / transacts nothing). Intentional for an info-only build. To connect a deployment, set VITE_FACTORY_ADDRESS or fill src/lib/chain/deployments.json.')
}

// ── 4. swap flag without a router → preview-only, not a broadcast ──
if (swap && !resolved('swapRouter', 'VITE_SWAP_ROUTER_ADDRESS', BASE)) {
  warns.push('VITE_ENABLE_SWAP=true but no swap router is configured → buy/sell renders preview-only (no broadcast) until you deploy + set VITE_SWAP_ROUTER_ADDRESS. See OPERATORS.md → "Buy/sell: the router, verifying it, scoping it off".')
}

// ── 5. the silent secondary-chain footgun ──
const extra = val('VITE_EXTRA_CHAIN_IDS')
if (extra) {
  for (const part of extra.split(',')) {
    const id = Number(part.trim())
    if (!Number.isInteger(id) || id <= 0) continue
    if (!SCAFFOLDED.has(id)) {
      warns.push(`VITE_EXTRA_CHAIN_IDS lists chain ${id}, which has no scaffold in chains.ts → it is ignored (never guessed). Scaffolded ids: 8453 (Base), 1 (Ethereum).`)
      continue
    }
    if (id === BASE) continue
    const entry = deployments[String(id)] || {}
    if (!validAddr(entry.factory)) {
      warns.push(`Chain ${id} (${CHAIN_NAME[id] ?? id}) is activated via VITE_EXTRA_CHAIN_IDS but has no factory in deployments.json. The VITE_*_ADDRESS overrides apply to Base ONLY — a non-Base chain must be configured in deployments.json, or it stays an empty shell with no in-app warning.`)
    }
  }
}

// ── 6. site URL — REQUIRED for a build (owner 2026-07-09): it brands the og:url /
//       og:image tags and generates the sitemap. Committed home = site.config.json;
//       VITE_SITE_URL overrides. (Escape hatch: raw `vite build` skips this check.) ──
if (!(val('VITE_SITE_URL') || String(siteCfg.siteUrl ?? '').trim())) {
  // Warn, never block (owner 2026-07-11 — supersedes the 07-09 fatal): drop-hosting
  // (Cloudflare Pages / Netlify) assigns the URL on the FIRST deploy, so a first
  // build legitimately has none. Set it after deploy and rebuild.
  warns.push('No site URL yet — fine for a first deploy (your host assigns one). Social cards + the sitemap stay unbranded until you set it (setup studio or src/site.config.json) and rebuild.')
}

// ── 6b. the committed fee wallet must be well-formed when set ──
{
  const fw = String(siteCfg.feeWallet ?? '').trim()
  if (fw && !isAddress(fw, { strict: false })) {
    errors.push(`site.config.json feeWallet is not a valid address ("${fw}"). The app drops it to null → no fee share is carved.`)
  }
}

// ── 6c. schema drift: a site.config.json written by an OLDER kit ──
// The update path keeps the operator's three identity files (theirs-wins), so after
// a kit update the committed json can predate fields the current code reads. Missing
// fields fall back to safe defaults at runtime (forward-compat guard in the readers)
// — but silently, so the operator is running knobs they never chose. Name the gaps.
// Grow this list whenever the site.config.json schema grows.
if (siteCfgRaw && typeof siteCfgRaw === 'object') {
  const missing = []
  if (!('siteUrl' in siteCfgRaw)) missing.push('siteUrl')
  if (!('feeWallet' in siteCfgRaw)) missing.push('feeWallet')
  if (!('features' in siteCfgRaw) || typeof siteCfgRaw.features !== 'object' || siteCfgRaw.features === null) {
    missing.push('features')
  } else {
    for (const k of ['wallet', 'deploy', 'trading', 'swap']) {
      if (!(k in siteCfgRaw.features)) missing.push(`features.${k}`)
    }
  }
  if (missing.length) {
    warns.push(
      `src/site.config.json predates this kit's schema — missing: ${missing.join(', ')}. ` +
        'The app quietly uses safe defaults for those. After a kit update, re-run the /setup studio Apply (or add the fields by hand) to bring the file current.',
    )
  }
}

// ── 7. sitemap still the shipped stub ──
try {
  const sm = readFileSync(resolve(APP_DIR, 'public/sitemap.xml'), 'utf8')
  if (!/<url>/.test(sm)) {
    warns.push('public/sitemap.xml is still the empty stub (no <url> entries). Regenerate it with your origin before publishing (see OPERATORS.md / SETUP.md).')
  }
} catch {
  /* no sitemap — skip */
}

// ── report ──
const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
const tty = process.stdout.isTTY
const c = (k, s) => (tty ? C[k] + s + C.reset : s)

console.log('')
console.log(c('bold', 'Spectrum V2 — frontend config check'))
console.log(c('dim', '  validates .env.local + deployments.json before build · warnings never block'))
console.log('')
console.log('  Build tier: ' + c('bold', tier))
console.log('')

for (const e of errors) console.log(c('red', '  ✗ ') + e)
for (const w of warns) console.log(c('yellow', '  ⚠ ') + w)
for (const i of infos) console.log(c('dim', '  · ') + i)
if (!errors.length && !warns.length) console.log(c('green', '  ✓ ') + 'No problems found.')
console.log('')

if (errors.length) {
  console.log(c('red', `  Build blocked: ${errors.length} fatal config error(s). Fix the above, or run \`vite build\` directly to bypass this check.`))
  console.log('')
  process.exit(1)
}
process.exit(0)
