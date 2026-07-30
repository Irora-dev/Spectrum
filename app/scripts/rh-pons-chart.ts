// One-off live proof (F2 fix): PONS is V3-best on 4663 — its pool-spot chart
// must sample the V3 pool. Read-only. Run: npx vite-node scripts/rh-pons-chart.ts
import { findBestPool } from '../src/lib/pools'
import { VENUE_LABEL } from '../src/lib/pools/types'
import { fetchPoolSpotHistory } from '../src/lib/spectrum/pool-spot-history'

const PONS = '0x39dBED3a2bd333467115dE45665cC57F813C4571'

async function main() {
  const best = await findBestPool(PONS as `0x${string}`, 4663)
  console.log(`PONS best: ${VENUE_LABEL[best.best.venue]} fee=${best.best.fee} depthUsd=$${Math.round(best.best.depthUsd ?? 0).toLocaleString('en-US')}`)
  const start = Math.floor(Date.now() / 1000) - 24 * 3600
  const series = await fetchPoolSpotHistory(4663, PONS, start)
  console.log(`chart points (24h window): ${series.length}`)
  if (series.length >= 2) {
    const first = series[0]
    const last = series[series.length - 1]
    console.log(`first $${first.value.toFixed(6)} @ ${new Date(first.time * 1000).toISOString()}`)
    console.log(`last  $${last.value.toFixed(6)} @ ${new Date(last.time * 1000).toISOString()}`)
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
