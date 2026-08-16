#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// DEMAND AUDIT — the one number the whole strategy rests on.
//
// Everything the portfolio flow is for assumes people buy baskets they did NOT
// create. This measures whether that is true, from chain, with no analytics and
// no assumptions:
//
//   • enumerate every basket on every configured lineage (keyless factory reads)
//   • read each basket's on-chain deployer  (factory.tokens(basket))
//   • pull every router Swapped log         (basket + trader are both indexed)
//   • split buyers into CREATOR vs OUTSIDE, and count who came back
//
// Read-only. Public RPC, no key required. Run: node scripts/demand-audit.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { createPublicClient, http, parseAbi, getAddress } from 'viem'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOOK = JSON.parse(readFileSync(resolve(HERE, '../src/lib/chain/deployments.json'), 'utf8'))

const RPC = {
  1: process.env.RPC_1 || 'https://eth.llamarpc.com',
  8453: process.env.RPC_8453 || 'https://mainnet.base.org',
  4663: process.env.RPC_4663 || 'https://rpc.mainnet.chain.robinhood.com',
}
const NAME = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood' }

const factoryAbi = parseAbi([
  'function allBasketsLength() view returns (uint256)',
  'function allBaskets(uint256) view returns (address)',
  'function tokens(address) view returns (address)',
])
const routerAbi = parseAbi([
  'event Swapped(address indexed basket, address indexed trader, address tokenIn, uint256 amountIn, uint256 amountOut, address frontend)',
])
const erc20 = parseAbi(['function symbol() view returns (string)'])

const ZERO = '0x0000000000000000000000000000000000000000'
const lc = (a) => String(a).toLowerCase()

/** getLogs in descending-size windows: public endpoints cap ranges very differently. */
async function logsWindowed(client, params, fromBlock, toBlock) {
  for (const span of [1_000_000n, 100_000n, 10_000n, 2_000n, 500n]) {
    try {
      const out = []
      for (let start = fromBlock; start <= toBlock; start += span) {
        const end = start + span - 1n > toBlock ? toBlock : start + span - 1n
        out.push(...(await client.getLogs({ ...params, fromBlock: start, toBlock: end })))
      }
      return out
    } catch {
      /* window too wide for this endpoint — try a smaller one */
    }
  }
  throw new Error('every window size was rejected')
}

async function auditChain(chainId, cfg) {
  const client = createPublicClient({ transport: http(RPC[chainId], { timeout: 60_000, retryCount: 2 }) })
  const lineages = [
    { factory: cfg.factory, router: cfg.swapRouter },
    ...(cfg.legacy || []).map((l) => ({ factory: l.factory, router: l.swapRouter })),
  ].filter((l) => l.factory && l.router)

  const head = await client.getBlockNumber()
  const deployerOf = new Map() // basket → deployer
  const routers = new Set()

  for (const { factory, router } of lineages) {
    routers.add(getAddress(router))
    let n = 0n
    try {
      n = await client.readContract({ address: getAddress(factory), abi: factoryAbi, functionName: 'allBasketsLength' })
    } catch { continue }
    for (let i = 0n; i < n; i++) {
      try {
        const b = await client.readContract({ address: getAddress(factory), abi: factoryAbi, functionName: 'allBaskets', args: [i] })
        const dep = await client.readContract({ address: getAddress(factory), abi: factoryAbi, functionName: 'tokens', args: [b] })
        if (dep && lc(dep) !== lc(ZERO)) deployerOf.set(lc(b), lc(dep))
      } catch { /* skip an unreadable index */ }
    }
  }

  // Every trade through every router on this chain, in one pass per router.
  const trades = []
  const failedRouters = new Set()
  for (const router of routers) {
    let logs = []
    try {
      // Never scan from genesis. The routers are recent, so a bounded lookback
      // is both correct and the only thing a public endpoint will serve.
      const LOOKBACK = { 1: 400_000n, 8453: 4_000_000n, 4663: 20_000_000n }[chainId] ?? 1_000_000n
      const from = head > LOOKBACK ? head - LOOKBACK : 0n
      logs = await logsWindowed(client, { address: router, event: routerAbi[0] }, from, head)
    } catch (e) {
      console.error(`  ! ${NAME[chainId]} router ${router}: ${e.message}`)
      failedRouters.add(chainId)
      continue
    }
    for (const l of logs) {
      trades.push({ basket: lc(l.args.basket), trader: lc(l.args.trader) })
    }
  }

  return { chainId, head, baskets: deployerOf, trades, degraded: failedRouters.size > 0 }
}

const rows = []
let totalBaskets = 0, totalTrades = 0
const outsideBuyers = new Set()
const creatorOnlyBaskets = []
const unmeasured = []
const bought = []

for (const [idStr, cfg] of Object.entries(BOOK)) {
  const chainId = Number(idStr)
  process.stderr.write(`scanning ${NAME[chainId] ?? chainId}…\n`)
  let r
  try { r = await auditChain(chainId, cfg) } catch (e) { console.error(`  ! ${NAME[chainId]}: ${e.message}`); continue }

  totalBaskets += r.baskets.size
  totalTrades += r.trades.length

  const perBasket = new Map()
  for (const t of r.trades) {
    if (!perBasket.has(t.basket)) perBasket.set(t.basket, { creator: 0, outside: new Map() })
    const rec = perBasket.get(t.basket)
    const dep = r.baskets.get(t.basket)
    if (dep && t.trader === dep) rec.creator++
    else rec.outside.set(t.trader, (rec.outside.get(t.trader) || 0) + 1)
  }

  for (const [basket, dep] of r.baskets) {
    const rec = perBasket.get(basket) || { creator: 0, outside: new Map() }
    let sym = '?'
    try {
      const c = createPublicClient({ transport: http(RPC[chainId]) })
      sym = await c.readContract({ address: getAddress(basket), abi: erc20, functionName: 'symbol' })
    } catch { /* unnamed */ }
    const outsiders = rec.outside.size
    const repeat = [...rec.outside.values()].filter((n) => n > 1).length
    for (const a of rec.outside.keys()) outsideBuyers.add(a)
    if (r.degraded) unmeasured.push(`${NAME[chainId]}/${sym}`)
    else if (outsiders === 0) creatorOnlyBaskets.push(`${NAME[chainId]}/${sym}`)
    else bought.push({ chain: NAME[chainId], sym, outsiders, repeat, creatorTrades: rec.creator })
    rows.push({ chain: NAME[chainId], sym, basket, deployer: dep, creatorTrades: rec.creator, outsiders, repeat })
  }
}

const withOutside = rows.filter((r) => r.outsiders > 0).length
console.log('\n════════ DEMAND AUDIT ════════')
console.log(`baskets on chain            ${totalBaskets}`)
console.log(`router trades, all time     ${totalTrades}`)
console.log(`baskets bought by an OUTSIDER ${withOutside}  (${totalBaskets ? Math.round((withOutside / totalBaskets) * 100) : 0}% of all baskets)`)
console.log(`distinct outside buyers     ${outsideBuyers.size}`)
console.log(`baskets NOBODY but the creator ever traded  ${creatorOnlyBaskets.length}`)
console.log('\n── baskets with genuine outside demand ──')
if (!bought.length) console.log('  (none)')
for (const b of bought.sort((x, y) => y.outsiders - x.outsiders)) {
  console.log(`  ${b.chain.padEnd(10)} ${String(b.sym).padEnd(14)} ${String(b.outsiders).padStart(3)} outside buyer(s), ${b.repeat} repeat`)
}
console.log('\n── UNMEASURED (log scan failed — NOT zero demand) ──')
console.log('  ' + (unmeasured.join(', ') || '(none)'))
console.log('\n── creator-only (measured, genuinely nobody outside) ──')
console.log('  ' + (creatorOnlyBaskets.join(', ') || '(none)'))
