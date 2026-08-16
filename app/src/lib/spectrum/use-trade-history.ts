import { useCallback, useState } from 'react'
import type { Address } from 'viem'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { cacheGet, cacheSet } from './persist-cache'
import { loadPnlIndex, pnlAvailable, readFlow, type SwapFlow } from './pnl'
import { buildTradeHistory, mergeGroupFlows, mergeHistories, type TradeHistory } from './trade-history'

// ─────────────────────────────────────────────────────────────────────────────
// THE EXPORT'S LOADER — the only place the trade-history feature spends RPC.
//
// ⚠ ON CLICK, NEVER ON MOUNT. Every visitor would otherwise fund a document
// most never open. The trades themselves cost NOTHING new: the PnL scan
// already fetches and caches them (pnl.ts persists `flows` in the same write
// as the fold). The one real cost is block→timestamp, and it is:
//   · one read per DISTINCT block, not per trade;
//   · BOUNDED to 6 in flight — the existing timestamp fetch in pnl.ts uses an
//     unbounded Promise.all, which is right for ETH-out sells ("the rare
//     flow") and would fire hundreds of simultaneous requests if reused for
//     every trade block. use-raw-holdings' bounded fan-out is the precedent;
//   · cached FOREVER — blocks are immutable, so a returning user pays nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** Blocks never change, so their timestamps never expire. */
const timeKey = (chainId: number, block: bigint) => `blocktime:v1:${chainId}:${block}`
const CONCURRENCY = 6

/** Resolve block→seconds for the blocks we do not already hold, 6 at a time.
 *  A block that will not read leaves its trades undated rather than dropped. */
async function resolveTimes(chainId: number, blocks: readonly bigint[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const missing: bigint[] = []
  for (const b of blocks) {
    const hit = cacheGet<number>(timeKey(chainId, b))
    if (typeof hit === 'number') out.set(b.toString(), hit)
    else missing.push(b)
  }
  if (missing.length === 0) return out

  const client = clientFor(chainId)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= missing.length) return
      const bn = missing[i]
      try {
        const b = await client.getBlock({ blockNumber: bn })
        const t = Number(b.timestamp)
        out.set(bn.toString(), t)
        cacheSet(timeKey(chainId, bn), t, 0) // immutable — no expiry
      } catch {
        /* unreadable: its trades stay undated, and the document says so */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker))
  return out
}

export interface TradeHistoryLoad {
  history: TradeHistory
  /** Chains that served history — the document names them, because a chain
   *  without a private RPC serves none and its absence must not read as
   *  "you never traded there". */
  chainsCovered: number[]
  /** Supported chains that could NOT serve history. */
  chainsMissing: number[]
  /** Trades whose date could not be resolved. */
  undated: number
}

/** Load the whole group's trade history across every chain that can serve it.
 *  Pure data — the caller renders or writes the file. */
export async function loadTradeHistory(
  wallets: readonly string[],
  opts: { fromMs?: number; toMs?: number } = {},
): Promise<TradeHistoryLoad> {
  const chainsCovered: number[] = []
  const chainsMissing: number[] = []
  const parts: TradeHistory[] = []

  for (const chainId of SUPPORTED_CHAIN_IDS) {
    if (!pnlAvailable(chainId)) {
      chainsMissing.push(chainId)
      continue
    }
    chainsCovered.push(chainId)
    // every wallet's trades on this chain, each from the index the PnL card
    // already built and cached — no new log calls
    const perWallet = await Promise.all(
      wallets.map(async (w) => {
        const idx = await loadPnlIndex(chainId, w as Address)
        return (idx?.flows ?? []).map(readFlow).filter((f): f is SwapFlow => f != null)
      }),
    )
    // ONE pool per basket across the whole group, so the merged stream must
    // read in chain order — wallet-after-wallet concatenation replays wallet
    // A's whole history before B's first trade and scrambles every running
    // basis the two share (audit 2026-08-12). mergeGroupFlows sorts by block.
    const flows = mergeGroupFlows(perWallet)
    if (flows.length === 0) continue

    const blocks = [...new Set(flows.map((f) => f.blockNumber).filter((b): b is bigint => b != null))]
    const times = await resolveTimes(chainId, blocks)
    parts.push(
      buildTradeHistory(chainId, flows, (b) => times.get(b.toString()) ?? null, opts),
    )
  }

  const history = mergeHistories(parts)
  return {
    history,
    chainsCovered,
    chainsMissing,
    undated: history.rows.filter((r) => r.ts == null).length,
  }
}

/** The React face: idle → loading → ready, so a button can say what it is
 *  doing. Never runs on mount. */
export function useTradeHistory() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (wallets: readonly string[], opts?: { fromMs?: number; toMs?: number }): Promise<TradeHistoryLoad | null> => {
      if (busy || wallets.length === 0) return null
      setBusy(true)
      setError(null)
      try {
        return await loadTradeHistory(wallets, opts)
      } catch {
        setError('Couldn’t read your trade history right now — the networks may be busy. Try again shortly.')
        return null
      } finally {
        setBusy(false)
      }
    },
    [busy],
  )

  return { load, busy, error }
}

/** A chain's display name, for the document. */
export const chainNameOf = (chainId: number): string => {
  try {
    return chainCfg(chainId).name
  } catch {
    return `chain ${chainId}`
  }
}
