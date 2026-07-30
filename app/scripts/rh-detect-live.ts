// Live detection ground-truth probe (lab, 2026-07-29) — runs the launch page's
// REAL detection path (findBestPool) against Robinhood mainnet for the curated
// stock shelf, plus the ETH/USD hub anchor. Read-only; sequential to respect
// the rate-limited public RPC. Run: npx vite-node scripts/rh-detect-live.ts
import { findBestPool } from '../src/lib/pools'
import { PoolDetectionError, VENUE_LABEL } from '../src/lib/pools/types'
import { nativeEthUsdOnChain } from '../src/lib/pools/v4-usd'
import { stocksForChain } from '../src/lib/chain/stocks'
import type { Address } from 'viem'

const CHAIN = 4663

function usd(n: number | null): string {
  return n == null ? 'n/a' : `$${Math.round(n).toLocaleString('en-US')}`
}

async function main() {
  const ethUsd = await nativeEthUsdOnChain(CHAIN)
  console.log(`hub anchor ETH/USD (on-chain, {ETH,USDG} deepest pool): ${ethUsd == null ? 'NULL — hub anchor broken' : `$${ethUsd.toFixed(2)}`}`)
  console.log('')

  for (const s of stocksForChain(CHAIN)) {
    try {
      const r = await findBestPool(s.address as Address, CHAIN)
      const b = r.best
      const alts = r.candidates.slice(1).map((c) => `${VENUE_LABEL[c.venue]}@${c.fee} ${usd(c.depthUsd)}`).join(' · ')
      console.log(`${s.symbol.padEnd(6)} ${VENUE_LABEL[b.venue]} fee=${b.fee} tick=${b.tickSpacing} depth=${usd(b.depthUsd)} (${b.depthEth.toFixed(3)} ETH-side)${b.dexListed ? ' [dex]' : ''}`)
      if (alts) console.log(`       also: ${alts}`)
      for (const w of r.warnings) console.log(`       ⚠ ${w}`)
    } catch (e) {
      if (e instanceof PoolDetectionError) console.log(`${s.symbol.padEnd(6)} ✗ ${e.code}: ${e.message}`)
      else console.log(`${s.symbol.padEnd(6)} ✗ unexpected: ${(e as Error).message}`)
    }
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
