// ─────────────────────────────────────────────────────────────────────────────
// Build a Uniswap-standard token list of every launched basket (adoption
// toolkit 2026-07-06 #2): wallets, aggregators, and the CoinGecko/DefiLlama
// submission kits all consume this format. Enumerates the factory's public
// append-only array per configured chain and writes `public/tokenlist.json`,
// served at <site>/tokenlist.json. Freshness model matches the site's other
// baked assets: regenerate per deploy (`npm run build:tokenlist`).
//
//   RPC: public endpoints by default; override with RPC_8453 / RPC_1 env vars.
//   Version: the patch number bumps only when the token set actually changes
//   (token-list consumers cache by version).
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, parseAbi } from 'viem'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOYMENTS = JSON.parse(readFileSync(join(ROOT, 'src/lib/chain/deployments.json'), 'utf8'))
const OUT = join(ROOT, 'public/tokenlist.json')

const RPC = {
  8453: process.env.RPC_8453 ?? 'https://mainnet.base.org',
  1: process.env.RPC_1 ?? 'https://ethereum-rpc.publicnode.com',
}

const factoryAbi = parseAbi([
  'function allBasketsLength() view returns (uint256)',
  'function allBaskets(uint256) view returns (address)',
])
const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])

const tokens = []
for (const [chainIdStr, cfg] of Object.entries(DEPLOYMENTS)) {
  const chainId = Number(chainIdStr)
  if (!cfg.factory || !RPC[chainId]) continue
  const client = createPublicClient({ transport: http(RPC[chainId]) })
  let n
  try {
    n = Number(await client.readContract({ address: cfg.factory, abi: factoryAbi, functionName: 'allBasketsLength' }))
  } catch (e) {
    console.warn(`chain ${chainId}: factory unreadable (${e.shortMessage ?? e.message}), skipped`)
    continue
  }
  for (let i = 0; i < n; i++) {
    const address = await client.readContract({ address: cfg.factory, abi: factoryAbi, functionName: 'allBaskets', args: [BigInt(i)] })
    const [name, symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ])
    // token-list schema caps: name ≤ 40, symbol ≤ 20
    tokens.push({
      chainId,
      address,
      symbol: String(symbol).slice(0, 20),
      name: String(name).slice(0, 40),
      decimals: Number(decimals),
    })
  }
  console.log(`chain ${chainId}: ${n} basket${n === 1 ? '' : 's'}`)
}
tokens.sort((a, b) => a.chainId - b.chainId || a.address.toLowerCase().localeCompare(b.address.toLowerCase()))

let version = { major: 1, minor: 0, patch: 0 }
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'))
    if (prev.version) version = prev.version
    if (JSON.stringify(prev.tokens) !== JSON.stringify(tokens)) version = { ...version, patch: version.patch + 1 }
  } catch {
    /* unreadable previous list — write fresh */
  }
}

const list = {
  name: 'Spectrum Baskets',
  timestamp: new Date().toISOString(),
  version,
  keywords: ['spectrum', 'basket', 'onchain index'],
  tokens,
}
writeFileSync(OUT, JSON.stringify(list, null, 2) + '\n')
console.log(`wrote ${tokens.length} token${tokens.length === 1 ? '' : 's'} -> public/tokenlist.json (v${version.major}.${version.minor}.${version.patch})`)
