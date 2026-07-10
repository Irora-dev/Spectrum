#!/usr/bin/env node
// create-spectrum-mini — the Spectrum Mini onboarding wizard. Zero-dependency (Node
// built-ins only). Asks a short Q&A (or takes flags / --yes) and writes the three files
// the operator app reads: app/src/brand.config.ts + app/src/site.config.json + app/.env.local.
//
//   node create/index.mjs                 # interactive
//   node create/index.mjs --yes --name "Acme Baskets" --style aurora --rpc <key> --site-url https://acme.xyz
//   node create/index.mjs --help
//
// It never fabricates a contract address: blank address fields fall back to the canonical
// Spectrum deployment shipped in deployments.json; your factory + fee wallet are collected
// as overrides. The fee wallet is the one value with no default, ever.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, argv, exit } from 'node:process'
import { PAGE_KEYS, STYLES, GRADIENT_CATALOG, HOSTS, hostingGuide, resolveGradient, renderBrandConfig, renderEnv, renderSiteConfig, validateSiteName, SPECTRUM_DNA } from './render.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = resolve(ROOT, 'app')
// 'all' (the full site) leads and is the default; the narrower tiers scope down.
const TIERS = ['all', 'info', 'creation', 'fees', 'marketplace']

function parseFlags(args) {
  const f = { pagesOff: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--yes' || a === '-y') f.yes = true
    else if (a === '--force') f.force = true
    else if (a === '--help' || a === '-h') f.help = true
    else if (a.startsWith('--no-')) f.pagesOff.push(a.slice(5))
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true'
      f[key] = val
    }
  }
  return f
}

const HELP = `create-spectrum-mini — generate your Spectrum front end's brand + env.

Flags: --name --tagline --style(${STYLES.join('|')})
       --gradient(${GRADIENT_CATALOG.map((g) => g.id).join('|')}) or --from --via --to --accent
       --fee-wallet 0x.. --rpc <alchemy-key> --site-url <origin>
       --tier(${TIERS.join('|')})  default: all — the full site
       --host(${HOSTS.join('|')})  prints tailored deploy steps for that host
       --no-<page> (${PAGE_KEYS.join(',')})  --yes  --force
Contracts are the shipped canonical Spectrum deployment (Base + Ethereum, both live).
Writes app/src/brand.config.ts + app/src/site.config.json + app/.env.local.`

async function main() {
  const f = parseFlags(argv.slice(2))
  if (f.help) { console.log(HELP); return }

  // The wizard itself runs on older Nodes, but the app's install/build needs 20+ —
  // say so here, at the very first command, instead of failing cryptically later.
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 20) {
    console.error(`⚠ Node ${process.versions.node} detected. The app needs Node 20+ (22 LTS or newer recommended) — install/build will fail on this version. Continuing to write your config…`)
  }

  const plan = {
    name: f.name,
    tagline: f.tagline,
    style: f.style,
    palette: (() => {
      const g = f.gradient ? resolveGradient(f.gradient) : null // --gradient <id> from the catalog
      return { from: f.from || g?.from, via: f.via || g?.via, to: f.to || g?.to, accent: f.accent }
    })(),
    pagesOff: f.pagesOff,
    // Power overrides — accepted but undocumented (canonical ships; own-deployment is a
    // hand-edit path). --factory / --swap-router / --wallet-connect-id still work.
    factory: f.factory,
    feeWallet: f['fee-wallet'],
    swapRouter: f['swap-router'],
    rpcKey: f.rpc,
    siteUrl: f['site-url'],
    walletConnectId: f['wallet-connect-id'],
    tier: f.tier || 'all',
    host: f.host,
  }

  if (!f.yes) {
    // Interactive mode needs a real terminal. With piped stdin, readline drops the
    // burst of buffered lines + EOF between questions and node exits 0 mid-wizard,
    // silently writing NOTHING (found in the 2026-07-10 terminal-only dry run) —
    // fail loudly instead and point at the scripted path.
    if (!stdin.isTTY) {
      console.error('✗ Interactive setup needs a real terminal (stdin is a pipe). For scripted use, pass the answers as flags with --yes — see node create/index.mjs --help.')
      exit(2)
    }
    const rl = createInterface({ input: stdin, output: stdout })
    const ask = async (q, def) => (await rl.question(`${q}${def ? ` (${def})` : ''}: `)).trim() || def || ''
    plan.name = plan.name || (await ask('Site name (text wordmark, not "Spectrum")'))
    plan.tagline = plan.tagline || (await ask('Tagline (optional)'))
    plan.style = plan.style || (await ask(`Design style ${STYLES.join('/')}`, 'spectral'))
    plan.palette.from = plan.palette.from || (await ask('Gradient from', SPECTRUM_DNA.from))
    plan.palette.via = plan.palette.via || (await ask('Gradient via', SPECTRUM_DNA.via))
    plan.palette.to = plan.palette.to || (await ask('Gradient to', SPECTRUM_DNA.to))
    plan.tier = f.tier || (await ask(`Feature tier ${TIERS.join('/')} (all = the full site)`, 'all'))
    plan.feeWallet = plan.feeWallet || (await ask('Fee wallet (your own; blank = no fee carve)'))
    plan.rpcKey = plan.rpcKey || (await ask('RPC key (required; ships public, use a domain-restricted key)'))
    if (!plan.rpcKey) plan.rpcKey = await ask('RPC key is required. Your own provider key, restricted to your domain')
    plan.siteUrl = plan.siteUrl || (await ask('Site URL (required; https://your-site.xyz)'))
    if (!plan.siteUrl) plan.siteUrl = await ask('Site URL is required. The public address your site will live at')
    // Hosting pick drives the tailored walkthrough printed at the end — guidance
    // only, it writes nothing (owner 2026-07-10).
    plan.host = plan.host || (await ask('Where will you host it? zip = drag-and-drop / cloudflare / netlify / vercel / vps / later', 'zip'))
    rl.close()
  }

  const check = validateSiteName(plan.name)
  if (!check.ok) { console.error(`✗ ${check.error}`); exit(1) }

  const brandPath = resolve(APP, 'src/brand.config.ts')
  const sitePath = resolve(APP, 'src/site.config.json')
  const envPath = resolve(APP, '.env.local')
  // The repo ships default configs (the app needs them to build). The pristine brand
  // default is marked and safe to overwrite; the shipped site.config.json is all-empty
  // values. Anything user-owned is only overwritten with --force.
  const SHIPPED_MARKER = 'SHIPPED DEFAULT — the create wizard may overwrite'
  const brandIsUsers = existsSync(brandPath) && !readFileSync(brandPath, 'utf8').includes(SHIPPED_MARKER)
  const siteIsUsers = (() => {
    try {
      const sc = JSON.parse(readFileSync(sitePath, 'utf8'))
      return Boolean((sc.siteUrl || '').trim() || (sc.feeWallet || '').trim())
    } catch { return false }
  })()
  if (!f.force && (brandIsUsers || siteIsUsers || existsSync(envPath))) {
    console.error('✗ Your own brand.config.ts, site.config.json or .env.local already exists — re-run with --force to overwrite.')
    exit(1)
  }

  // The studio blocks on these two; the CLI warns loudly instead of refusing, so
  // scripted (--yes) runs still complete and the operator fixes .env.local before deploy.
  if (!plan.rpcKey) console.error('⚠ No RPC key set (VITE_ALCHEMY_API_KEY) — required before you deploy; it ships public, use a domain-restricted key.')
  if (!plan.siteUrl) console.error('⚠ No site URL set (VITE_SITE_URL) — required before you deploy (social cards + sitemap).')

  mkdirSync(dirname(brandPath), { recursive: true })
  writeFileSync(brandPath, renderBrandConfig(plan))
  writeFileSync(sitePath, renderSiteConfig(plan))
  writeFileSync(envPath, renderEnv(plan))

  console.log(`✓ Wrote src/brand.config.ts (${plan.name}, ${STYLES.includes(plan.style) ? plan.style : 'spectral'}) + src/site.config.json + .env.local (tier: ${plan.tier}).`)
  console.log('The site ships on the canonical Spectrum deployment — set addresses in .env.local only to')
  console.log('point at your own. Preview any time:  cd app && npm install && npm run dev')
  console.log('')
  for (const line of hostingGuide(plan.host)) console.log(line)
}

main().catch((e) => { console.error(e); exit(1) })
