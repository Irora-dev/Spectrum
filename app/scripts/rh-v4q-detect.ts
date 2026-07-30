// Live proof of the V4Q settlement-paired sweep (lab, 2026-07-29): runs
// findV4Q — the exact detector code, flag forced — against Robinhood mainnet
// for the stock shelf. Read-only. The in-app path stays dark until a chain's
// deployments.json declares v4qLineage. Run: npx vite-node scripts/rh-v4q-detect.ts
import { findV4Q } from '../src/lib/pools/find-best-pool'
import { chainCfg } from '../src/lib/chain/chains'
import { clientFor } from '../src/lib/chain/rpc'
import { stocksForChain } from '../src/lib/chain/stocks'
import type { Address } from 'viem'

const CHAIN = 4663

async function main() {
  const cfg = chainCfg(CHAIN)
  const client = clientFor(CHAIN)
  for (const s of stocksForChain(CHAIN)) {
    const r = await findV4Q(
      client,
      { chainId: CHAIN, poolManager: cfg.poolManager!, usdc: cfg.usdc! },
      s.address as Address,
    )
    const rows = r.candidates
      .sort((a, b) => (b.depthUsd ?? 0) - (a.depthUsd ?? 0))
      .map((c) => `${c.fee}/${c.tickSpacing} $${Math.round(c.depthUsd ?? 0).toLocaleString('en-US')}`)
      .join(' · ')
    console.log(
      `${s.symbol.padEnd(6)} ${r.candidates.length} settlement pool(s)${r.partial ? ` [scan:${r.partial}]` : ''}${r.depthCheckFailed ? ' [DEPTH CHECK FAILED]' : ''}${rows ? `  ${rows}` : ''}`,
    )
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
