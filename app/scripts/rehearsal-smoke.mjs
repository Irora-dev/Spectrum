#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// REHEARSAL SMOKE — an end-to-end pre-release probe against REHEARSAL DECOY
// contracts (real, deployed, throwaway instances on live chains, used only for
// testing). Full contract: docs/REHEARSAL-SMOKE.md.
//
// WHY: the two bug classes unit tests cannot see (docs/BUG-CLASSES.md #1, #2)
// live in the wiring and the world — a seam production never supplies, an RPC
// that lacks a method, a contract generation the code's arithmetic outgrew.
// This probe measures the world the release is about to trust.
//
// SAFETY TIERS (in order; the default is the safest):
//   1. SKIP      — no env configured → print what WOULD run, exit 0 (CI-safe).
//   2. READ-ONLY — env + --live → reachability, code-presence, generation and
//                  simulate-support probes. No key touched, nothing sent.
//   3. SEND      — deliberately NOT IMPLEMENTED here: landing real rehearsal
//                  transactions needs the owner's wallet and an explicit go.
//                  The stub below refuses with a pointer at the doc.
//
// ⛔ ADDRESS RULES (standing, verbatim in spirit): rehearsal addresses live in
// env / a gitignored .env.local ONLY — never committed, never hardcoded, and
// never printed in full (short forms only: 0xAB…CD). If one ever heads toward
// a shared branch or the live site, stop and raise it loudly.
// ─────────────────────────────────────────────────────────────────────────────
import { createPublicClient, http } from 'viem'

const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const SEND = args.includes('--send')

const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a)
const env = (k) => (process.env[k] ?? '').trim() || null

if (SEND) {
  console.error('rehearsal-smoke: the send tier is deliberately not implemented — sending real rehearsal')
  console.error('transactions needs the owner wallet and an explicit go. See docs/REHEARSAL-SMOKE.md.')
  process.exit(1)
}

const chainList = (env('REHEARSAL_CHAINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)

if (!LIVE || chainList.length === 0) {
  console.log('rehearsal-smoke: SKIP (safe default — this is not a failure)')
  console.log('  would probe, per chain in REHEARSAL_CHAINS: RPC reachability + chainId match,')
  console.log('  code presence at REHEARSAL_BATCHER_<id> / REHEARSAL_WRAPPER_<id> / REHEARSAL_COLLECTOR_<id>,')
  console.log('  batcher liveness (a revert-tolerant eth_call), and eth_simulateV1 support.')
  console.log(`  enable: REHEARSAL_CHAINS=8453,4663 REHEARSAL_RPC_8453=… ${LIVE ? '' : '--live '}(read-only tier)`)
  process.exit(0)
}

/** One revert-tolerant eth_call: a revert WITH data/reason proves a contract
 *  is alive and talking; only transport-level failure is a dead probe. */
async function livenessProbe(client, address) {
  try {
    await client.call({ to: address, data: '0x00000000' })
    return 'answers'
  } catch (e) {
    const msg = String(e?.shortMessage ?? e?.message ?? e)
    if (/revert|invalid|function|selector|returned no data/i.test(msg)) return 'answers (revert-with-reason)'
    return null
  }
}

let failed = 0
const rows = []
for (const chainId of chainList) {
  const rpc = env(`REHEARSAL_RPC_${chainId}`)
  const row = { chainId, rpc: !!rpc, chainOk: false, sim: 'unprobed', contracts: [] }
  if (!rpc) {
    console.error(`✗ chain ${chainId}: REHEARSAL_RPC_${chainId} is not set but the chain is enabled`)
    failed += 1
    rows.push(row)
    continue
  }
  const client = createPublicClient({ transport: http(rpc, { timeout: 8_000 }) })
  try {
    const got = await client.getChainId()
    row.chainOk = got === chainId
    if (!row.chainOk) {
      console.error(`✗ chain ${chainId}: RPC answers chainId ${got} — the env points at the wrong network`)
      failed += 1
    }
  } catch (e) {
    console.error(`✗ chain ${chainId}: RPC unreachable (${String(e?.message ?? e).slice(0, 80)})`)
    failed += 1
    rows.push(row)
    continue
  }
  // eth_simulateV1 support is a per-chain fact the app's proofs depend on —
  // some RPCs lack it, and that changes what can be proven there (class 4:
  // measure the assumption, don't remember it).
  try {
    await client.simulateCalls({ calls: [{ to: '0x0000000000000000000000000000000000000000', value: 0n }] })
    row.sim = 'supported'
  } catch (e) {
    row.sim = /method|not found|not supported|-32601/i.test(String(e?.message ?? e)) ? 'ABSENT' : 'supported (probe reverted)'
  }
  for (const kind of ['BATCHER', 'WRAPPER', 'COLLECTOR']) {
    const addr = env(`REHEARSAL_${kind}_${chainId}`)
    if (!addr) continue // mainnet legitimately has no collector; absence of an env row is not a failure
    const entry = { kind, addr: shortAddr(addr), code: false, alive: null }
    const code = await client.getBytecode({ address: addr }).catch(() => null)
    entry.code = !!code && code !== '0x'
    if (!entry.code) {
      console.error(`✗ chain ${chainId} ${kind} ${shortAddr(addr)}: NO CODE — never deployed, or destroyed; a decoy that is not there proves nothing`)
      failed += 1
    } else if (kind === 'BATCHER') {
      entry.alive = await livenessProbe(client, addr)
      if (!entry.alive) {
        console.error(`✗ chain ${chainId} BATCHER ${shortAddr(addr)}: transport-dead to a liveness call`)
        failed += 1
      }
    }
    row.contracts.push(entry)
  }
  rows.push(row)
}

console.log('\nchain  · rpc · chainId · simulateV1 · contracts')
for (const r of rows) {
  const contracts = r.contracts.map((c) => `${c.kind}:${c.addr} code=${c.code ? 'yes' : 'NO'}${c.alive ? ` ${c.alive}` : ''}`).join(' · ') || '(none configured)'
  console.log(`${String(r.chainId).padEnd(6)} · ${r.rpc ? 'set' : 'MISSING'} · ${r.chainOk ? 'match' : 'WRONG'} · ${r.sim} · ${contracts}`)
}
if (failed > 0) {
  console.error(`\nrehearsal-smoke: ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\nrehearsal-smoke: read-only tier clean')
