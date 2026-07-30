import { parseAbi, type Address, type PublicClient } from 'viem'
import type { NavPoint } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// Chainlink price history — the Robinhood Chain backtest source (lab
// 2026-07-29). Chain 4663 is unindexed by every offchain price API (no Alchemy
// tier, no DexScreener, no DefiLlama), so the composer's backtester had NO
// source there — stocks looked "broken". But the chain publishes Chainlink
// feeds (per-stock `Robinhood <TICKER>/USD`, plus ETH/USD and USDG/USD), and an
// aggregator's past ROUNDS are readable on-chain: walking roundIds back through
// the current phase reconstructs real oracle history with no API at all.
//
// Feed addresses below come from the OFFICIAL registry
// (reference-data-directory.vercel.app/feeds-robinhood-mainnet.json), fetched +
// cross-checked 2026-07-29 against the 2026-07-04 research capture. All 8 dec,
// 24h heartbeat / 0.5% deviation ⇒ roughly daily-or-better points: coarse but
// HONEST for a weighted-replay backtest.
//
// Limits, stated: rounds are walked within the CURRENT aggregator phase (a
// proxy phase flip truncates older history — fails toward shorter, never
// wrong); reads batch through the site's multicall client (concurrent fan-out,
// a handful of round-trips). Tokens without feeds on 4663 still have no
// source — that honesty gap stays until an indexer exists.
// ─────────────────────────────────────────────────────────────────────────────

const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

/** asset address (lowercased) → its USD feed proxy, Robinhood Chain only. */
const FEEDS_4663: Record<string, Address> = {
  // tokenized stocks (official registry addresses, stocks.ts is the asset side)
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15', // NVDA
  '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9': '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0', // AAPL
  '0x322f0929c4625ed5bad873c95208d54e1c003b2d': '0x4A1166a659A55625345e9515b32adECea5547C38', // TSLA
  '0xe93237c50d904957cf27e7b1133b510c669c2e74': '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E', // MSFT
  '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3': '0xF6f373a037c30F0e5010d854385cA89185AE638b', // GOOGL
  '0x117cc2133c37b721f49de2a7a74833232b3b4c0c': '0x319724394D3A0e3669269846abE664Cd621f9f6A', // SPY
  '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68': '0x80901d846d5D7B030F26B480776EE3b29374C2ae', // QQQ
  '0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f': '0x209b73908e92Ae021826eD79609845451Ecba2ce', // SLV
  // the chain's majors — WETH backtests via ETH/USD; USDG via its own feed
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', // WETH → ETH/USD
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2', // USDG
}

export function chainlinkFeedFor(chainId: number, asset: string): Address | null {
  if (chainId !== 4663) return null
  return FEEDS_4663[asset.toLowerCase()] ?? null
}

/** How many rounds to fan out per request wave (multicall-batched anyway). */
const WAVE = 60
/** Absolute cap on rounds walked — bounds RPC work on deviation-chatty feeds. */
const MAX_ROUNDS = 480

/**
 * Reconstruct `[start..now]` history from a feed's on-chain rounds, oldest
 * first. Walks roundIds backwards in concurrent waves until the window is
 * covered, the phase ends (revert), or MAX_ROUNDS.
 */
export async function fetchChainlinkHistory(
  client: PublicClient,
  feed: Address,
  startSec: number,
): Promise<NavPoint[]> {
  const latest = await client.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' })
  const [latestId, latestAnswer, , latestUpdated] = latest
  if (latestAnswer <= 0n) return []
  const points: { time: number; value: number }[] = [
    { time: Number(latestUpdated), value: Number(latestAnswer) / 1e8 },
  ]

  let cursor = latestId
  let walked = 0
  let reachedStart = Number(latestUpdated) <= startSec
  while (!reachedStart && walked < MAX_ROUNDS) {
    const ids: bigint[] = []
    for (let i = 1n; i <= BigInt(WAVE); i++) {
      if (cursor <= i) break
      ids.push(cursor - i)
    }
    if (ids.length === 0) break
    const wave = await Promise.all(
      ids.map((id) =>
        client
          .readContract({ address: feed, abi: aggregatorAbi, functionName: 'getRoundData', args: [id] })
          .catch(() => null), // phase boundary / pruned round → stop below
      ),
    )
    for (const r of wave) {
      if (!r) {
        reachedStart = true // the phase ended — truncate honestly
        break
      }
      const [, answer, , updatedAt] = r
      const t = Number(updatedAt)
      if (t === 0 || answer <= 0n) continue
      points.push({ time: t, value: Number(answer) / 1e8 })
      if (t <= startSec) {
        reachedStart = true
        break
      }
    }
    walked += ids.length
    cursor = ids[ids.length - 1]
  }

  return points
    .filter((p) => p.time >= startSec - 86_400) // keep one pre-window anchor
    .sort((a, b) => a.time - b.time)
}
