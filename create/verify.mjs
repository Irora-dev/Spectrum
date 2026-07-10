#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Spectrum Mini — first-run chain smoke (owner 2026-07-09, improvement set #2).
//
// Answers, before anything ships: will this site actually have live data?
//   • the RPC endpoint is reachable and is the network it claims to be
//   • the factory address holds code AND enumerates (allBasketsLength answers)
//   • the other canonical addresses the app transacts through hold code
// …for every chain configured in app/src/lib/chain/deployments.json (the kit
// ships Base + Ethereum canonical). Run it after setup, before the build:
//
//   node create/verify.mjs            # from the repo root
//   npm run verify:chain              # the same, from app/
//
// Zero-dep like the rest of create/ (plain fetch JSON-RPC). Reads the same
// config the app does: app/.env.local + real VITE_* shell vars override it;
// explicit VITE_*_RPC_URL beats the Alchemy key beats the public fallback, and
// the VITE_*_ADDRESS overrides apply to Base only (mirrors lib/chain/rpc.ts +
// deployments.ts). Read-only; exits non-zero when any configured chain fails.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = resolve(ROOT, 'app')

// viem toFunctionSelector('function allBasketsLength() view returns (uint256)')
// — precomputed so this script stays dependency-free.
const SEL_ALL_BASKETS_LENGTH = '0xd63c961d'

const BASE = 8453
const CHAIN_NAME = { 8453: 'Base', 1: 'Ethereum' }
const PUBLIC_RPC = { 8453: 'https://base-rpc.publicnode.com', 1: 'https://ethereum-rpc.publicnode.com' }
const ALCHEMY_HOST = { 8453: 'base-mainnet', 1: 'eth-mainnet' }
const RPC_URL_VAR = { 8453: 'VITE_BASE_RPC_URL', 1: 'VITE_MAINNET_RPC_URL' }

// ── env (same precedence as the app: .env.local, real shell vars win) ──
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/(^|\s)#.*$/, '').trim()
    out[key] = v
  }
  return out
}
const env = parseEnvFile(resolve(APP, '.env.local'))
for (const k of Object.keys(process.env)) if (k.startsWith('VITE_')) env[k] = process.env[k]
const val = (k) => (env[k] ?? '').trim()
const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(v ?? '')

let deployments = {}
try {
  deployments = JSON.parse(readFileSync(resolve(APP, 'src/lib/chain/deployments.json'), 'utf8'))
} catch {
  /* absent/invalid → treated as empty, like the app */
}

// Base-only env overrides, every other chain reads deployments.json (deployments.ts).
function resolved(field, envVar, chainId) {
  if (chainId === BASE && isAddr(val(envVar))) return val(envVar)
  const entry = deployments[String(chainId)] || {}
  return isAddr(entry[field]) ? entry[field] : null
}

function rpcUrlFor(chainId) {
  const explicit = val(RPC_URL_VAR[chainId])
  if (explicit) return { url: explicit, kind: 'explicit URL' }
  const key = val('VITE_ALCHEMY_API_KEY')
  if (key) return { url: `https://${ALCHEMY_HOST[chainId]}.g.alchemy.com/v2/${key}`, kind: 'your RPC key' }
  return { url: PUBLIC_RPC[chainId], kind: 'public fallback' }
}

async function rpc(url, method, params, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    if (j.error) throw new Error(j.error.message || 'RPC error')
    return j.result
  } finally {
    clearTimeout(t)
  }
}

const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
const tty = process.stdout.isTTY
const c = (k, s) => (tty ? C[k] + s + C.reset : s)
const ok = (s) => console.log(c('green', '  ✓ ') + s)
const bad = (s) => console.log(c('red', '  ✗ ') + s)
const info = (s) => console.log(c('dim', '  · ') + s)

async function checkChain(chainId) {
  const name = CHAIN_NAME[chainId] ?? String(chainId)
  const { url, kind } = rpcUrlFor(chainId)
  const factory = resolved('factory', 'VITE_FACTORY_ADDRESS', chainId)
  console.log('')
  console.log(c('bold', `  ${name} (${chainId})`) + c('dim', ` — via ${kind}`))

  if (!factory) {
    info('No factory configured for this chain — nothing to verify (an honest empty shell here).')
    return true
  }

  let failed = false

  // 1 · RPC reachable + the network it claims to be
  try {
    const idHex = await rpc(url, 'eth_chainId', [])
    const got = Number(idHex)
    if (got !== chainId) {
      bad(`RPC answers as chain ${got}, expected ${chainId} — the endpoint points at the wrong network.`)
      return false
    }
    ok('RPC reachable, network confirmed.')
  } catch (e) {
    bad(`RPC unreachable (${e?.message ?? e}). ${kind === 'public fallback' ? 'Public endpoints rate-limit; set your RPC key and rerun.' : 'Check the key/URL.'}`)
    return false
  }

  // 2 · the factory holds code and ENUMERATES (the read Explore is built on)
  try {
    const code = await rpc(url, 'eth_getCode', [factory, 'latest'])
    if (!code || code === '0x') {
      bad(`Factory ${factory} holds no code on ${name} — Explore would list nothing. Wrong address or wrong chain.`)
      failed = true
    } else {
      const out = await rpc(url, 'eth_call', [{ to: factory, data: SEL_ALL_BASKETS_LENGTH }, 'latest'])
      if (typeof out === 'string' && out.startsWith('0x') && out.length >= 3) {
        ok(`Factory enumerates: ${Number(BigInt(out))} basket(s) live.`)
      } else {
        bad('Factory answered eth_getCode but allBasketsLength() returned nothing — not a Spectrum factory?')
        failed = true
      }
    }
  } catch (e) {
    bad(`Factory enumeration failed (${e?.message ?? e}).`)
    failed = true
  }

  // 3 · the other canonical addresses the app transacts through
  for (const [field, envVar, label] of [
    ['usdc', 'VITE_USDC_ADDRESS', 'USDC'],
    ['swapRouter', 'VITE_SWAP_ROUTER_ADDRESS', 'swap router'],
  ]) {
    const addr = resolved(field, envVar, chainId)
    if (!addr) {
      info(`No ${label} configured — the surfaces that need it stay off.`)
      continue
    }
    try {
      const code = await rpc(url, 'eth_getCode', [addr, 'latest'])
      if (!code || code === '0x') {
        bad(`${label} ${addr} holds no code on ${name}.`)
        failed = true
      } else ok(`${label} responds (code present).`)
    } catch (e) {
      bad(`${label} check failed (${e?.message ?? e}).`)
      failed = true
    }
  }

  return !failed
}

console.log('')
console.log(c('bold', 'Spectrum Mini — chain smoke'))
console.log(c('dim', '  proves the configured chains answer before you build/ship · read-only'))

const chainIds = Object.keys(deployments)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0)
if (!chainIds.includes(BASE) && isAddr(val('VITE_FACTORY_ADDRESS'))) chainIds.push(BASE)

let allOk = true
for (const id of chainIds.sort((a, b) => b - a)) {
  // sequential on purpose: public endpoints rate-limit bursts
  allOk = (await checkChain(id)) && allOk
}

console.log('')
if (!chainIds.length) {
  info('No chains configured at all (empty deployments.json and no overrides) — nothing to verify.')
  process.exit(0)
}
if (allOk) {
  console.log(c('green', '  All configured chains answer. The site will have live data.'))
  console.log('')
  process.exit(0)
}
console.log(c('red', '  At least one configured chain failed — fix it before shipping (see the lines above).'))
console.log('')
process.exit(1)
