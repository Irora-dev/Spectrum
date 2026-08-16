// Live ground truth for the V2 REJECTION ruling (2026-08-13) — runs the launch
// page's REAL detection path (findBestPool) against the configured chain AND
// prints the raw per-venue probe underneath it, so "why did this token pick that
// pool?" is answered with numbers instead of inference. Read-only.
//
//   npx vite-node scripts/v2-reject-live.ts                 # chain 1, MKR + controls
//   npx vite-node scripts/v2-reject-live.ts 1 0x9f8F…79A2   # explicit chain + tokens
//
// Run it once with `rejectsV2Legs` absent and once with it seated to read the
// before/after off the same probe.
import { formatUnits, zeroAddress, type Address } from 'viem'
import { findBestPool } from '../src/lib/pools'
import { PoolDetectionError, VENUE_LABEL } from '../src/lib/pools/types'
import { chainCfg } from '../src/lib/chain/chains'
import { clientFor } from '../src/lib/chain/rpc'
import { v2FactoryAbi, v2PairAbi, v3FactoryAbi, erc20MetaAbi } from '../src/lib/pools/abis'

const V3_TIERS = [100, 500, 3000, 10000]

/** Mainnet majors, so a mis-rank shows up as a pattern rather than one token. */
const DEFAULT_TOKENS: Record<number, Address[]> = {
  1: [
    '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', // MKR  — the reported V2 route
    '0x514910771AF9Ca656af840dff83E8264EcF986CA', // LINK — control, deep V3
    '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // UNI  — control
    '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI  — control
  ],
}

const usd = (n: number | null | undefined) => (n == null ? 'n/a' : `$${Math.round(n).toLocaleString('en-US')}`)

async function dexPairs(slug: string, asset: Address): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  try {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/${slug}/${asset}`, {
      headers: { Accept: 'application/json' },
    })
    if (!r.ok) return map
    const pairs = (await r.json()) as { pairAddress?: string; dexId?: string; labels?: string[]; liquidity?: { usd?: number } }[]
    for (const p of Array.isArray(pairs) ? pairs : []) {
      if (p.pairAddress) map.set(p.pairAddress.toLowerCase(), Number(p.liquidity?.usd ?? 0))
    }
  } catch {
    /* indexer down — on-chain numbers below still stand */
  }
  return map
}

async function probe(chainId: number, asset: Address) {
  const cfg = chainCfg(chainId)
  const client = clientFor(chainId)
  const weth = cfg.weth as Address
  const listed = await dexPairs(cfg.dexscreenerSlug, asset)

  let symbol = '?'
  try {
    symbol = (await client.readContract({ address: asset, abi: erc20MetaAbi, functionName: 'symbol' })) as string
  } catch {
    /* unnamed is fine */
  }
  console.log(`\n══ ${symbol} ${asset} · chain ${chainId} (rejectsV2Legs=${cfg.rejectsV2Legs === true}) ══`)

  // ── RAW V2 ──
  if (cfg.uniV2Factory) {
    const pair = (await client.readContract({
      address: cfg.uniV2Factory,
      abi: v2FactoryAbi,
      functionName: 'getPair',
      args: [asset, weth],
    })) as Address
    if (pair && pair.toLowerCase() !== zeroAddress) {
      const [reserves, token0] = await Promise.all([
        client.readContract({ address: pair, abi: v2PairAbi, functionName: 'getReserves' }),
        client.readContract({ address: pair, abi: v2PairAbi, functionName: 'token0' }),
      ])
      const wethRes = (token0 as string).toLowerCase() === weth.toLowerCase() ? reserves[0] : reserves[1]
      console.log(
        `  V2  pair ${pair}  ETH-side ${Number(formatUnits(wethRes, 18)).toFixed(3)}  dexTVL ${usd(listed.get(pair.toLowerCase()))}`,
      )
    } else {
      console.log('  V2  no pair')
    }
  }

  // ── RAW V3, every tier the detector probes ──
  for (const fee of V3_TIERS) {
    const pool = (await client.readContract({
      address: cfg.uniV3Factory as Address,
      abi: v3FactoryAbi,
      functionName: 'getPool',
      args: [asset, weth, fee],
    })) as Address
    if (!pool || pool.toLowerCase() === zeroAddress) {
      console.log(`  V3  ${String(fee).padStart(5)}  —`)
      continue
    }
    const bal = (await client.readContract({
      address: weth,
      abi: erc20MetaAbi,
      functionName: 'balanceOf',
      args: [pool],
    })) as bigint
    console.log(
      `  V3  ${String(fee).padStart(5)}  ${pool}  ETH-side ${Number(formatUnits(bal, 18)).toFixed(3)}  dexTVL ${usd(listed.get(pool.toLowerCase()))}`,
    )
  }

  // ── THE DETECTOR'S OWN VERDICT ──
  try {
    const r = await findBestPool(asset, chainId)
    console.log(
      `  →  ${VENUE_LABEL[r.best.venue]} fee=${r.best.fee} ${r.best.poolAddress ?? r.best.poolId} depth=${usd(r.best.depthUsd)}${r.best.dexListed ? ' [dex]' : ''}`,
    )
    for (const c of r.candidates.slice(1)) console.log(`     also: ${VENUE_LABEL[c.venue]}@${c.fee} ${usd(c.depthUsd)}`)
    for (const w of r.warnings) console.log(`     ⚠ ${w}`)
  } catch (e) {
    if (e instanceof PoolDetectionError) console.log(`  →  ✗ REFUSED ${e.code}: ${e.message}`)
    else console.log(`  →  ✗ unexpected: ${(e as Error).message}`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const chainId = Number(argv[0] ?? 1)
  const tokens = (argv.length > 1 ? argv.slice(1) : (DEFAULT_TOKENS[chainId] ?? [])) as Address[]
  if (tokens.length === 0) throw new Error(`no default token list for chain ${chainId} — pass addresses`)
  for (const t of tokens) await probe(chainId, t)
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
