// ─────────────────────────────────────────────────────────────────────────────
// SPLIT CALIBRATION HARNESS (owner greenlight 2026-08-03 ~15:2x) — measures
// the real agreement band between the KIT's split derivation and the
// CONTRACT's bareLegMins, so CONTRACT_AGREE_PCT stops being a provisional 5%
// and becomes a constant picked from evidence. Run BEFORE anyone wires
// caller-split into a live buy path.
//
// WHAT IT DOES. For every live basket on the target chain, at a ladder of
// trade sizes: derive OUR split (value shares of the basket's own holdings —
// the marks the app itself reads) and read the CONTRACT's packed split via
// factory.bareLegMins. Report the per-leg disagreement in POINTS of the whole
// split (crossCheckSplit's own unit), the max band per basket/size, and the
// smallest CONTRACT_AGREE_PCT that would have passed every honest case.
//
// WHERE IT RUNS, honestly: bareLegMins exists only on the REV factory —
// the live 4663 book predates it, so against live the contract half reports
// UNAVAILABLE and the script emits our splits alone (half the band). Point it
// at contracts' rev fork to complete the measurement:
//
//   RPC_URL=<fork rpc> FACTORY=<rev factory> CHAIN_ID=4663 \
//     npx vite-node scripts/split-calibration.ts [basket ...]
//
// (vite-node, not tsx: the app libs read import.meta.env.)
//
// With no basket args it enumerates the chain's live registry.
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicClient, http, parseAbi, type Address } from 'viem'
import { deploymentFor } from '../src/lib/chain/deployments'
import { listBasketsForChain, getBasketData } from '../src/lib/spectrum/basket-data'
import { decodeBareLegMin } from '../src/lib/spectrum/contract-split'

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 4663)
const RPC = process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
/** Settlement-dollar ladder: dust, retail, whale-ish — the sizes that matter. */
const LADDER = [10, 100, 1_000, 10_000]

const bareAbi = parseAbi(['function bareLegMins(address basket, uint256 amountIn) view returns (uint256[])'])

async function main() {
  const dep = deploymentFor(CHAIN_ID)
  const factory = (process.env.FACTORY ?? dep.factory) as Address
  const client = createPublicClient({ transport: http(RPC) })
  const args = process.argv.slice(2).filter((a) => a.startsWith('0x')) as Address[]

  const baskets =
    args.length > 0
      ? args
      : (await listBasketsForChain(CHAIN_ID)).filter((b) => !b.supersededBy).map((b) => b.address as Address)
  console.log(`# split calibration · chain ${CHAIN_ID} · factory ${factory} · ${baskets.length} baskets · ladder ${LADDER.join('/')}`)

  let worstPts = 0
  let measured = 0
  let unavailable = 0

  for (const basket of baskets) {
    let ours: number[] | null = null
    let symbol = basket.slice(0, 8)
    try {
      const d = await getBasketData(basket, CHAIN_ID, { detail: true })
      symbol = d.symbol ?? symbol
      const values = d.holdings.map((h) => h.valueUsd ?? 0)
      const total = values.reduce((s, v) => s + v, 0)
      if (!(total > 0)) {
        console.log(`${symbol}: unpriced/unseeded — skipped`)
        continue
      }
      const raw = values.map((v) => Math.floor((v / total) * 10_000))
      raw[values.indexOf(Math.max(...values))] += 10_000 - raw.reduce((s, v) => s + v, 0)
      ours = raw
    } catch (e) {
      console.log(`${symbol}: kit derivation failed — ${(e as Error).message.slice(0, 60)}`)
      continue
    }

    for (const usd of LADDER) {
      const amountIn = BigInt(Math.round(usd * 1e6)) // settlement 6dp
      try {
        const words = (await client.readContract({
          address: factory,
          abi: bareAbi,
          functionName: 'bareLegMins',
          args: [basket, amountIn],
        })) as readonly bigint[]
        const theirs = words.map((w) => decodeBareLegMin(w).splitBps)
        // Pre-packing factory: bareLegMins answers with PLAIN floors (the rev
        // added the split bits), which decode to all-zero splits. The test is
        // EXACT (contracts 2026-08-03): all-zero [255:240] on a successful
        // answer proves pre-packing; one non-zero field proves packed.
        if (theirs.length > 0 && theirs.every((v) => v === 0)) {
          unavailable += 1
          console.log(`${symbol} @ $${usd}: bareLegMins answers UNPACKED (pre-packing factory) — ours [${ours.join(',')}]`)
          continue
        }
        if (theirs.length !== ours.length) {
          console.log(`${symbol} @ $${usd}: LEG COUNT MISMATCH ours ${ours.length} vs theirs ${theirs.length}`)
          continue
        }
        const deltas = ours.map((o, i) => Math.abs(o - theirs[i]) / 100)
        const worst = Math.max(...deltas)
        worstPts = Math.max(worstPts, worst)
        measured += 1
        console.log(
          `${symbol} @ $${usd}: max ${worst.toFixed(2)} pts · ours [${ours.join(',')}] theirs [${theirs.join(',')}]`,
        )
      } catch (e) {
        const msg = (e as Error).message
        // A fork whose UPSTREAM pruned the fork block answers -32603
        // "failed to get account …: metadata is not found" for any account
        // nobody warmed into anvil's cache — infrastructure starvation, not a
        // contract behaviour (measured 2026-08-03 on contracts' 8549 fork:
        // only the basket their own verification had touched still answered).
        if (/metadata is not found|failed to get account|-32603/i.test(msg)) {
          console.log(`${symbol} @ $${usd}: FORK STATE UNAVAILABLE (upstream pruned the fork block?) — restand the fork fresh`)
        } else if (/returned no data|reverted/i.test(msg) && !/BareSplit/i.test(msg)) {
          unavailable += 1
          console.log(`${symbol} @ $${usd}: bareLegMins UNAVAILABLE (pre-rev factory?) — ours [${ours.join(',')}]`)
        } else {
          console.log(`${symbol} @ $${usd}: contract refused — ${msg.slice(0, 80)}`)
        }
      }
    }
  }

  console.log('#')
  if (measured > 0) {
    console.log(`# measured ${measured} basket-size points · worst disagreement ${worstPts.toFixed(2)} pts`)
    console.log(`# smallest passing CONTRACT_AGREE_PCT: ${Math.ceil(worstPts)} (current provisional: 5)`)
  } else {
    console.log(`# no contract-side measurements (${unavailable} unavailable) — run against the REV fork to complete`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
