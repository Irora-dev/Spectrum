#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Read the kit's canonical address book (src/lib/chain/deployments.json) back
// from the LIVE chains before trusting it — built for seating day (the new
// spectrum contracts on Base / Ethereum / Robinhood), useful any day.
//
//   node scripts/verify-deployments.mjs          # verify every chain in the book
//   npm run verify:deployments                   # the same, as a named script
//
// What it checks, per chain entry:
//   · every configured address HAS CODE (a typo'd address is the expensive
//     mistake this exists to catch — it would silently read as null/empty)
//   · usdc answers decimals() (6 expected; warn otherwise — RH's USDG is 6)
//   · factory answers allBasketsLength() (the cheapest canonical read)
//   · leaguePool, where set, answers champion() (the live-stream ABI — the
//     podium/pot models are SUPERSEDED and would revert here)
//   · notesRegistry code is BYTE-IDENTICAL across every chain that sets it
//     (the CREATE2 same-address invariant)
//   · on Ethereum: the L1 PrismBurner named in src/lib/prism/burn.ts has code,
//     and — when that file says BURNER_V2 — answers PRISM() with the v2 hook
//
// Zero-dep (bare eth_call/eth_getCode over fetch). RPC per chain: the kit's
// public fallbacks, overridable via RPC_<chainId> env vars. Exit 1 on any
// FAIL; warnings never block. Read-only; never writes anything anywhere.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const book = JSON.parse(readFileSync(resolve(APP, 'src/lib/chain/deployments.json'), 'utf8'))

const RPC = {
  1: process.env.RPC_1 || 'https://ethereum-rpc.publicnode.com',
  8453: process.env.RPC_8453 || 'https://mainnet.base.org',
  4663: process.env.RPC_4663 || 'https://rpc.mainnet.chain.robinhood.com',
}

const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
const tty = process.stdout.isTTY
const c = (k, s) => (tty ? C[k] + s + C.reset : s)

let fails = 0
let warns = 0
const ok = (label) => console.log(`  ${c('green', '✓')} ${label}`)
const warn = (label) => {
  warns++
  console.log(`  ${c('yellow', '⚠')} ${label}`)
}
const fail = (label) => {
  fails++
  console.log(`  ${c('red', '✗')} ${label}`)
}

let rpcId = 0
async function rpc(chainId, method, params) {
  const url = RPC[chainId]
  if (!url) throw new Error(`no RPC configured for chain ${chainId} (set RPC_${chainId})`)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(body.error.message || 'rpc error')
  return body.result
}

const getCode = (chainId, addr) => rpc(chainId, 'eth_getCode', [addr, 'latest'])
const call = (chainId, to, data) => rpc(chainId, 'eth_call', [{ to, data }, 'latest'])

// Selectors (first 4 bytes of keccak256(signature)) — computed with `cast sig`,
// never hand-derived (a wrong selector reads as "the contract reverted" and
// fails an address that is actually fine).
const SEL = {
  decimals: '0x313ce567', // decimals()
  allBasketsLength: '0xd63c961d', // allBasketsLength()
  champion: '0x44866955', // champion()
  PRISM: '0xfe274971', // PRISM()
}

// Address fields a book entry may carry (v4qLineage / leagueShareBps are knobs).
const ADDR_FIELDS = [
  'factory', 'usdc', 'poolManager', 'swapRouter', 'weth',
  'uniV2Factory', 'uniV3Factory', 'uniV3SwapRouter', 'uniV3Quoter',
  'v4Quoter', 'universalRouter', 'aerodromeFactory',
  'notesRegistry', 'leaguePool',
]

console.log('')
console.log(c('bold', 'Spectrum Mini — deployments.json read-back'))

const notesCode = new Map() // chainId -> code, for the CREATE2 invariant

for (const [chainStr, entry] of Object.entries(book)) {
  const chainId = Number(chainStr)
  console.log('')
  console.log(c('bold', `── chain ${chainId} `.padEnd(46, '─')) + c('dim', ` ${RPC[chainId] ?? 'NO RPC'}`))
  for (const field of ADDR_FIELDS) {
    const addr = entry[field]
    if (!addr) continue
    try {
      const code = await getCode(chainId, addr)
      if (!code || code === '0x') {
        fail(`${field} ${addr} has NO CODE`)
        continue
      }
      ok(`${field} ${addr.slice(0, 10)}… has code (${(code.length - 2) / 2} bytes)`)
      if (field === 'usdc') {
        const d = Number(BigInt(await call(chainId, addr, SEL.decimals)))
        if (d === 6) ok(`  usdc.decimals() = 6`)
        else warn(`  usdc.decimals() = ${d} (expected 6 — check the settlement token)`)
      }
      if (field === 'factory') {
        try {
          const n = Number(BigInt(await call(chainId, addr, SEL.allBasketsLength)))
          ok(`  factory.allBasketsLength() = ${n}`)
        } catch {
          fail(`  factory.allBasketsLength() reverted — is this address really the basket factory?`)
        }
      }
      if (field === 'leaguePool') {
        try {
          const champ = await call(chainId, addr, SEL.champion)
          ok(`  leaguePool.champion() answers (0x…${champ.slice(-8)}) — live-stream ABI confirmed`)
        } catch {
          fail(`  leaguePool.champion() reverted — a podium/pot-model pool is SUPERSEDED; do not seat it`)
        }
      }
      if (field === 'notesRegistry') notesCode.set(chainId, code)
    } catch (e) {
      fail(`${field} ${addr}: ${e.message}`)
    }
  }
}

// CREATE2 invariant: the notes registry must be byte-identical everywhere it's set.
if (notesCode.size > 1) {
  console.log('')
  console.log(c('bold', '── cross-chain invariants '.padEnd(46, '─')))
  const codes = [...notesCode.values()]
  if (codes.every((x) => x === codes[0])) ok(`notesRegistry byte-identical across ${notesCode.size} chains (CREATE2)`)
  else fail('notesRegistry BYTECODE DIFFERS between chains — the CREATE2 invariant is broken')
}

// The L1 burner the Flush canvas drives (src/lib/prism/burn.ts is the seam).
console.log('')
console.log(c('bold', '── L1 auction burner (src/lib/prism/burn.ts) '.padEnd(46, '─')))
try {
  const burnTs = readFileSync(resolve(APP, 'src/lib/prism/burn.ts'), 'utf8')
  // Anchor on the export — a bare /BURNER_V2 = true/ matched the phrase inside
  // the file's own header COMMENT and verified the wrong burner.
  const v2 = /export const BURNER_V2 = true/.test(burnTs)
  const m = burnTs.match(/BURNER[^=]*=\s*BURNER_V2\s*\?\s*'(0x[0-9a-fA-F]{40})'\s*:\s*'(0x[0-9a-fA-F]{40})'/)
  if (!m) {
    warn('could not parse BURNER from burn.ts — verify it by hand')
  } else {
    const active = v2 ? m[1] : m[2]
    const code = await getCode(1, active)
    if (!code || code === '0x') fail(`active burner ${active} has NO CODE on Ethereum`)
    else ok(`active burner ${active.slice(0, 10)}… (${v2 ? 'V2' : 'incumbent'}) has code`)
    if (v2) {
      try {
        const prism = '0x' + (await call(1, active, SEL.PRISM)).slice(-40)
        if (prism.toLowerCase() === '0xcf4d29f14cc585ddd1167f956092852af844e040') ok('  burner.PRISM() == PRISM v2 hook')
        else fail(`  burner.PRISM() = ${prism} — NOT the v2 hook`)
      } catch {
        fail('  burner.PRISM() reverted — v2 flag set but the address does not answer the v2 surface')
      }
    }
  }
} catch (e) {
  warn(`burner check skipped: ${e.message}`)
}

console.log('')
if (fails) {
  console.log(c('red', `  ${fails} FAILURE${fails === 1 ? '' : 'S'}${warns ? ` · ${warns} warning${warns === 1 ? '' : 's'}` : ''} — do NOT seat this book.`))
  console.log('')
  process.exit(1)
}
console.log(c('green', `  Book verified against the live chains${warns ? ` · ${warns} warning${warns === 1 ? '' : 's'}` : ''}.`))
console.log('')
