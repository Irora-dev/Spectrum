// Live proof for the launch starter suggestions (owner 2026-07-30: "ensure the
// suggestions genuinely work — nvda, apple, pons and stonkbrokers to begin").
// Runs the kit's OWN detection (findBestPool — the same judge the builder uses)
// over the four starters, plus the STONKBROKERS impostor field so the shipped
// address is provably the real one. Read-only.
// Run from the test worktree (4663 test-lineage config): npx vite-node scripts/rh-starter-suggestions-check.ts
import { findBestPool } from '../src/lib/pools'
import { VENUE_LABEL } from '../src/lib/pools/types'

const CANDIDATES: { label: string; address: string }[] = [
  { label: 'NVDA (official registry)', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' },
  { label: 'AAPL (official registry)', address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' },
  { label: 'PONS', address: '0x39dBED3a2bd333467115dE45665cC57F813C4571' },
  { label: 'STONKBROKER 9987 holders', address: '0xe934e36A439C94017B64a3FecE66AF12099aBF50' },
  { label: 'STONKBROKER 5143 holders', address: '0x70028969f8129042A4Ef6718245F5809334610cB' },
  { label: 'STONKBROKER 1005 holders', address: '0x3A7303485E63CCcb9C9fA74fB72b4fB8A224541F' },
]

async function main() {
  for (const c of CANDIDATES) {
    try {
      const r = await findBestPool(c.address as `0x${string}`, 4663)
      const depth = r.best.depthUsd
      console.log(
        `${c.label.padEnd(28)} ${c.address}  venue=${VENUE_LABEL[r.best.venue]} fee=${r.best.fee}  depthUsd=${depth == null ? 'n/a' : '$' + Math.round(depth).toLocaleString('en-US')}`,
      )
    } catch (e) {
      console.log(`${c.label.padEnd(28)} ${c.address}  NO ROUTE (${(e as Error).message.slice(0, 80)})`)
    }
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
