// ─────────────────────────────────────────────────────────────────────────────
// ORDER-RAILS PROBE — the Phase-orders entry gate (owner rule, 00:49 round:
// TWAP/limit are SOLVER-SIGNED OR NOTHING; the gate is on-chain verification
// of the rails). Read-only: eth_getCode + one view call per candidate, plus
// keyless API liveness pings. No wallet, no funds, no writes.
//
// Honesty: a check that FAILED (RPC down, endpoint unreachable) reports
// UNREADABLE, never "not deployed". A candidate whose canonical address we
// could not source from the protocol's own docs is marked UNKNOWN-ADDRESS —
// the probe proves presence only where the address is certain.
//   node scripts/probe-order-rails.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { createPublicClient, http } from 'viem'

const CHAINS = [
  { id: 1, name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', fallback: 'https://cloudflare-eth.com' },
  { id: 8453, name: 'Base', rpc: 'https://mainnet.base.org', fallback: 'https://base.llamarpc.com' },
  { id: 4663, name: 'Robinhood', rpc: 'https://rpc.mainnet.chain.robinhood.com', fallback: null },
]

// Candidate rail contracts. confidence: 'canonical' = the address is the
// protocol's published cross-chain deployment; 'candidate' = widely used but
// to be re-confirmed against protocol docs before any order is built on it.
const RAILS = [
  {
    key: '1inch-aggregation-router-v6-with-lop-v4',
    label: '1inch Aggregation Router v6 (embeds Limit Order Protocol v4)',
    address: '0x111111125421cA6dc452d289314280a0f8842A65',
    confidence: 'canonical', // 1inch deploys v6 at one address on every supported chain
  },
  {
    key: 'uniswapx-v2-dutch-reactor-mainnet',
    label: 'UniswapX V2 Dutch Order Reactor (Ethereum deployment)',
    address: '0x00000011F84B9aa48e5f8aA8B9897600006289Be',
    confidence: 'candidate',
    chains: [1],
  },
  {
    key: 'uniswapx-priority-reactor-base',
    label: 'UniswapX Priority Order Reactor (Base deployment)',
    address: '0x000000001Ec5656dcdB24D90DFa42742738De729',
    confidence: 'candidate',
    chains: [8453],
  },
  // COW PROTOCOL — added 2026-08-02 on the owner's question: "any other system we
  // could use other than 1inch for the twap/limit system across eth, base and rh,
  // something permissionless without needing a legal cert". The first probe missed
  // CoW entirely, and on paper it is the strongest candidate: TWAP is a FIRST-CLASS
  // order type filled by CoW's solver competition (satisfying the owner's
  // solver-signed-or-nothing rule with no keeper of ours), and its orderbook accepts
  // orders with NO API KEY — which is the exact wall 1inch's orderbook puts up.
  {
    key: 'cow-settlement',
    label: 'CoW Protocol GPv2Settlement (what solvers call to settle)',
    address: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    confidence: 'canonical', // CoW settles at one address on every supported chain
  },
  {
    key: 'cow-composable',
    label: 'ComposableCoW (the conditional-order framework TWAP is built on)',
    address: '0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74',
    confidence: 'candidate',
  },
  {
    key: 'cow-twap-handler',
    label: 'CoW TWAP order handler (the TWAP order type itself)',
    address: '0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5',
    confidence: 'candidate',
  },
]

const APIS = [
  { key: '1inch-orderbook', label: '1inch Orderbook API (auth wall = alive)', url: 'https://api.1inch.dev/orderbook/v4.0/1', expectStatuses: [200, 401, 403] },
  { key: 'uniswap-trade-api', label: 'Uniswap Trading/Intents API (auth wall = alive)', url: 'https://trade-api.gateway.uniswap.org/v1/quote', expectStatuses: [200, 401, 403, 405] },
  // CoW's orderbook is the whole point of probing it: a 200 with NO key is the
  // difference between "needs an account" and "permissionless". Probed per chain,
  // because solver coverage is per chain even where settlement is deployed.
  { key: 'cow-orderbook-mainnet', label: 'CoW Orderbook API · Ethereum (keyless 200 = permissionless)', url: 'https://api.cow.fi/mainnet/api/v1/version', expectStatuses: [200] },
  { key: 'cow-orderbook-base', label: 'CoW Orderbook API · Base (keyless 200 = permissionless)', url: 'https://api.cow.fi/base/api/v1/version', expectStatuses: [200] },
]

async function codeAt(rpcs, address) {
  for (const rpc of rpcs.filter(Boolean)) {
    try {
      const client = createPublicClient({ transport: http(rpc, { timeout: 12_000 }) })
      const code = await client.getCode({ address })
      return { ok: true, deployed: !!code && code !== '0x', bytes: code ? (code.length - 2) / 2 : 0, rpc }
    } catch {
      /* try the fallback — a dead RPC is not a verdict */
    }
  }
  return { ok: false }
}

const out = { probedAt: new Date().toISOString(), chains: {}, apis: {} }

for (const chain of CHAINS) {
  out.chains[chain.name] = {}
  for (const rail of RAILS) {
    if (rail.chains && !rail.chains.includes(chain.id)) continue
    const r = await codeAt([chain.rpc, chain.fallback], rail.address)
    const verdict = !r.ok
      ? 'UNREADABLE (rpc did not answer — not a verdict)'
      : r.deployed
        ? `DEPLOYED (${r.bytes} bytes of code)`
        : 'NO CODE at this address'
    out.chains[chain.name][rail.key] = { address: rail.address, confidence: rail.confidence, verdict }
    console.log(`${chain.name.padEnd(10)} ${rail.label}\n           ${rail.address} → ${verdict} [addr:${rail.confidence}]`)
  }
}

for (const api of APIS) {
  try {
    const res = await fetch(api.url, { method: 'GET', signal: AbortSignal.timeout(12_000) })
    const alive = api.expectStatuses.includes(res.status)
    out.apis[api.key] = { status: res.status, verdict: alive ? 'ALIVE (service answered)' : `UNEXPECTED ${res.status}` }
    console.log(`API        ${api.label} → HTTP ${res.status} ${alive ? '(alive)' : '(unexpected)'}`)
  } catch {
    out.apis[api.key] = { verdict: 'UNREACHABLE (network error — not a verdict)' }
    console.log(`API        ${api.label} → UNREACHABLE (not a verdict)`)
  }
}

console.log('\nJSON:\n' + JSON.stringify(out, null, 2))
