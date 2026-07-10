// Build a display-grade data snapshot the frontend can serve instead of having
// every visitor poll the RPC (src/lib/spectrum/snapshot.ts is the consumer).
//
//   node scripts/build-snapshot.mjs --out public/snapshot.json
//   node scripts/build-snapshot.mjs            # writes to stdout
//
// OPTIONAL for operators — nothing references the output unless the build sets
// VITE_SNAPSHOT_URL. Run it on any scheduler (GitHub Action cron, Cloudflare
// Worker cron, plain crontab) every 2–5 minutes and publish the JSON to any
// static host/CDN. THIS process is the only thing that needs your RPC key:
// visitors then read the JSON, and the key never ships in the bundle at all.
//
// RPC endpoints (server-side env, NOT VITE_*):
//   SNAPSHOT_RPC_URL_8453 / SNAPSHOT_RPC_URL_1   explicit per-chain URLs, else
//   ALCHEMY_API_KEY                               builds the Alchemy URLs, else
//   public keyless endpoints                      (inception dating skipped —
//                                                 wide getLogs needs a keyed RPC)
//
// The read set MIRRORS src/lib/spectrum/basket-data.ts (enumeration discovery,
// immutable meta, mutable NAV views, idleHeld reserves, DexScreener spot).
// Keep the two in lockstep — drift shows up as list cards disagreeing with
// detail pages. Incremental: with --out, the previous file's immutable fields
// (meta, deployers, inception) are reused, so a steady-state pass is a handful
// of multicalls + one bounded log scan per chain.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, formatUnits, parseAbi, parseAbiItem } from 'viem'
import { base, mainnet } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const deployments = JSON.parse(readFileSync(join(ROOT, 'src/lib/chain/deployments.json'), 'utf8'))

const OUT = (() => {
  const i = process.argv.indexOf('--out')
  return i >= 0 ? process.argv[i + 1] : null
})()

const CHAIN_META = {
  8453: { viem: base, slug: 'base', publicRpc: 'https://base-rpc.publicnode.com', alchemy: 'base-mainnet' },
  1: { viem: mainnet, slug: 'ethereum', publicRpc: 'https://ethereum-rpc.publicnode.com', alchemy: 'eth-mainnet' },
}

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || ''
function rpcUrlFor(chainId) {
  const explicit = process.env[`SNAPSHOT_RPC_URL_${chainId}`]
  if (explicit) return { url: explicit, keyed: true }
  const meta = CHAIN_META[chainId]
  if (ALCHEMY_KEY) return { url: `https://${meta.alchemy}.g.alchemy.com/v2/${ALCHEMY_KEY}`, keyed: true }
  return { url: meta.publicRpc, keyed: false }
}

// Minimal ABI mirror of src/lib/spectrum/abis-v2.ts (read surface only).
const factoryAbi = parseAbi([
  'function allBasketsLength() view returns (uint256)',
  'function allBaskets(uint256) view returns (address)',
  'function tokens(address) view returns (address)',
])
const basketAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function basketLength() view returns (uint256)',
  'function basket(uint256) view returns (address,uint24,int24,address,uint24,uint16,uint8)',
  'function totalSupply() view returns (uint256)',
  'function effectiveSupply() view returns (uint256)',
  'function exchangeRate() view returns (uint256,bool)',
  'function totalReserve() view returns (uint256,bool)',
  'function idleHeld(address) view returns (uint256)',
])
// Full signature exactly as in src/lib/spectrum/abis-v2.ts — topic0 is the
// keccak of the WHOLE signature, so a shortened mirror matches nothing.
const launchedEvent = parseAbiItem(
  'event Launched(address indexed basket, address indexed deployer, string name, string symbol, uint160 startSqrtPriceX96, uint256 ethPaid, uint16 basketFeeBps)',
)

const prior = (() => {
  if (!OUT) return null
  try {
    const p = JSON.parse(readFileSync(OUT, 'utf8'))
    return p && p.v === 1 && p.chains ? p : null
  } catch {
    return null
  }
})()

function priorBasket(chainId, addr) {
  const list = prior?.chains?.[String(chainId)]?.baskets
  return list?.find((b) => b.address.toLowerCase() === addr.toLowerCase()) ?? null
}

async function dexPrices(slug, addresses) {
  const out = new Map()
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30)
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${batch.join(',')}`, {
        headers: { Accept: 'application/json' },
      })
      if (!r.ok) continue
      const pairs = await r.json()
      const best = new Map()
      for (const p of pairs ?? []) {
        const a = p?.baseToken?.address?.toLowerCase()
        if (!a) continue
        const prev = best.get(a)
        if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) best.set(a, p)
      }
      for (const [a, p] of best) out.set(a, p)
    } catch {
      /* keep whatever priced */
    }
  }
  return out
}

async function launchIndex(client, factory, keyed, priorEntries) {
  // Wide filtered getLogs — keyed endpoints only (same rule as the app).
  if (!keyed) return priorEntries ?? {}
  try {
    const logs = await client.getLogs({ address: factory, event: launchedEvent, fromBlock: 0n, toBlock: 'latest' })
    const byBlock = new Map()
    for (const l of logs) {
      const arr = byBlock.get(l.blockNumber) ?? []
      arr.push(l)
      byBlock.set(l.blockNumber, arr)
    }
    const entries = { ...(priorEntries ?? {}) }
    for (const [bn, ls] of byBlock) {
      // Reuse prior timestamps (blocks are immutable) — only new blocks read.
      if (ls.every((l) => entries[l.args.basket?.toLowerCase()] != null)) continue
      const blk = await client.getBlock({ blockNumber: bn })
      for (const l of ls) {
        const basket = l.args.basket?.toLowerCase()
        if (basket) entries[basket] = Number(blk.timestamp)
      }
    }
    return entries
  } catch {
    return priorEntries ?? {}
  }
}

async function snapshotChain(chainId, dep) {
  const meta = CHAIN_META[chainId]
  if (!meta || !dep.factory) return null
  const { url, keyed } = rpcUrlFor(chainId)
  const client = createPublicClient({
    chain: meta.viem,
    transport: http(url, { retryCount: 3, retryDelay: 500 }),
    batch: { multicall: { batchSize: 16_384 } },
  })
  const factory = dep.factory

  const len = Number(await client.readContract({ address: factory, abi: factoryAbi, functionName: 'allBasketsLength' }))
  const addrs = await Promise.all(
    Array.from({ length: len }, (_, i) =>
      client.readContract({ address: factory, abi: factoryAbi, functionName: 'allBaskets', args: [BigInt(i)] }),
    ),
  )

  const priorInception = Object.fromEntries(
    (prior?.chains?.[String(chainId)]?.baskets ?? [])
      .filter((b) => b.inceptionTs != null)
      .map((b) => [b.address.toLowerCase(), b.inceptionTs]),
  )
  const inception = await launchIndex(client, factory, keyed, priorInception)

  const baskets = []
  for (const address of addrs) {
    try {
      const prev = priorBasket(chainId, address)
      // Immutable facts: reuse from the prior snapshot, read once when new.
      let imm = prev
        ? {
            name: prev.name,
            symbol: prev.symbol,
            decimals: prev.decimals,
            deployer: prev.deployer,
            legsImm: prev.legs.map((l) => ({ asset: l.asset, targetBps: l.targetBps, decimals: l.decimals })),
          }
        : null
      if (!imm) {
        const [name, symbol, decimals, lenRaw, deployer] = await Promise.all([
          client.readContract({ address, abi: basketAbi, functionName: 'name' }),
          client.readContract({ address, abi: basketAbi, functionName: 'symbol' }),
          client.readContract({ address, abi: basketAbi, functionName: 'decimals' }),
          client.readContract({ address, abi: basketAbi, functionName: 'basketLength' }),
          client
            .readContract({ address: factory, abi: factoryAbi, functionName: 'tokens', args: [address] })
            .then((d) => (d && d !== '0x0000000000000000000000000000000000000000' ? d : null))
            .catch(() => null),
        ])
        const entries = await Promise.all(
          Array.from({ length: Number(lenRaw) }, (_, i) =>
            client.readContract({ address, abi: basketAbi, functionName: 'basket', args: [BigInt(i)] }),
          ),
        )
        imm = {
          name,
          symbol,
          decimals: Number(decimals),
          deployer,
          legsImm: entries.map((e) => ({ asset: e[0], targetBps: Number(e[5]), decimals: Number(e[6]) })),
        }
      }

      // Mutable state — always read live (this IS the poll).
      const [supplyRaw, effRaw, exchangeRate, totalReserve] = await Promise.all([
        client.readContract({ address, abi: basketAbi, functionName: 'totalSupply' }),
        client.readContract({ address, abi: basketAbi, functionName: 'effectiveSupply' }).catch(() => null),
        client.readContract({ address, abi: basketAbi, functionName: 'exchangeRate' }).catch(() => null),
        client.readContract({ address, abi: basketAbi, functionName: 'totalReserve' }).catch(() => null),
      ])
      const balances = await Promise.all(
        imm.legsImm.map((l) =>
          client
            .readContract({ address, abi: basketAbi, functionName: 'idleHeld', args: [l.asset] })
            .catch(() => 0n)
            .then((b) => Number(formatUnits(b, l.decimals))),
        ),
      )

      const totalSupply = Number(formatUnits(supplyRaw, imm.decimals))
      const effectiveSupply = effRaw != null ? Number(formatUnits(effRaw, imm.decimals)) : null
      const navDenom = effectiveSupply && effectiveSupply > 0 ? effectiveSupply : totalSupply

      const dex = await dexPrices(meta.slug, imm.legsImm.map((l) => l.asset.toLowerCase()))
      const usdcLow = dep.usdc?.toLowerCase()
      const legs = imm.legsImm.map((l, i) => {
        const p = dex.get(l.asset.toLowerCase())
        let priceUsd = Number.parseFloat(p?.priceUsd ?? '')
        if (!(Number.isFinite(priceUsd) && priceUsd > 0)) priceUsd = 0
        if (usdcLow && l.asset.toLowerCase() === usdcLow && !priceUsd) priceUsd = 1
        return {
          asset: l.asset,
          symbol: p?.baseToken?.symbol ?? (usdcLow && l.asset.toLowerCase() === usdcLow ? 'USDC' : '?'),
          name: p?.baseToken?.name ?? '',
          decimals: l.decimals,
          targetBps: l.targetBps,
          balance: balances[i],
          priceUsd,
          ch1: p?.priceChange?.h1 ?? 0,
          ch6: p?.priceChange?.h6 ?? 0,
          ch24: p?.priceChange?.h24 ?? 0,
        }
      })

      const reconAum = legs.reduce((s, l) => s + l.balance * l.priceUsd, 0)
      let navPerToken = navDenom > 0 ? reconAum / navDenom : 0
      let aumUsd = reconAum
      let navSource = 'reconstructed'
      let fullyPriced = false
      if (exchangeRate != null) {
        const onchainNav = Number(formatUnits(exchangeRate[0], 18))
        if (onchainNav > 0) {
          navPerToken = onchainNav
          navSource = 'onchain'
          fullyPriced = exchangeRate[1]
        }
      }
      if (totalReserve != null && navSource === 'onchain') {
        const onchainAum = Number(formatUnits(totalReserve[0], 6))
        if (onchainAum > 0) aumUsd = onchainAum
      }

      baskets.push({
        address,
        name: imm.name,
        symbol: imm.symbol,
        decimals: imm.decimals,
        totalSupply,
        effectiveSupply,
        navPerToken,
        navSource,
        fullyPriced,
        aumUsd,
        deployer: imm.deployer,
        inceptionTs: inception[address.toLowerCase()] ?? null,
        legs,
      })
    } catch (err) {
      console.error(`skip ${chainId}:${address}: ${err?.message ?? err}`)
    }
  }
  return { baskets }
}

const chains = {}
for (const [idStr, dep] of Object.entries(deployments)) {
  const chainId = Number(idStr)
  const result = await snapshotChain(chainId, dep)
  if (result) chains[idStr] = result
}

const snapshot = { v: 1, generatedAt: Math.floor(Date.now() / 1000), chains }
const json = JSON.stringify(snapshot)
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, json)
  const count = Object.entries(chains)
    .map(([id, c]) => `${id}:${c.baskets.length}`)
    .join(' ')
  console.log(`wrote ${OUT} (${json.length}B, baskets ${count || 'none'})`)
} else {
  process.stdout.write(json)
}
