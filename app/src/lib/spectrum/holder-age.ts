import { parseAbiItem, type Address, type PublicClient } from 'viem'
import { cacheGet, cacheSet } from './persist-cache'

// ─────────────────────────────────────────────────────────────────────────────
// Holder age — "how long has this wallet held?" answered from the basket
// token's OWN Transfer history (lab 2026-07-29, for the holder emoji wall).
//
// One full Transfer scan per basket reconstructs every running balance
// (baskets are vanilla ERC-20s minted/burned via address(0) transfers, so the
// reconstruction is exact); a holder's age anchors at their LAST 0→positive
// crossing — sell out and rebuy, and the clock honestly restarts. The scan is
// append-only, so it persists incrementally (the v4scan pattern): repeat
// visits read only new blocks. Display uses the wall's LIVE balanceOf for
// "how much" — this module only answers "since when".
//
// Block→time: two real headers calibrate seconds/block (never hardcoded —
// chains differ and drift); ages are display-grade.
// ─────────────────────────────────────────────────────────────────────────────

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

interface HolderState {
  /** Raw balance as a decimal string (exact from event reconstruction). */
  bal: string
  /** Block of the last 0→positive crossing ('' while balance is zero). */
  sinceBlock: string
  /** Block of the last MATERIAL entry — a credit that more than doubled the
   *  position (prev < cur/2). This, not sinceBlock, is what the wall shows:
   *  audit M1 — anchoring on the first dust wei let 1 wei bought a year ago
   *  render "holding 1.0y" beside a position opened today. */
  bigBlock: string
}

interface HolderScanCache {
  upToBlock: string
  holders: Record<string, HolderState>
}

function isHolderScanCache(v: unknown): v is HolderScanCache {
  if (!v || typeof v !== 'object') return false
  const c = v as HolderScanCache
  return typeof c.upToBlock === 'string' && !!c.holders && typeof c.holders === 'object'
}

const ZERO = '0x0000000000000000000000000000000000000000'

/** Reorg margin — the cache watermark never rides the very tip (audit M4:
 *  a reorged block otherwise corrupted the running balances irreversibly). */
const AGE_CONFIRMATIONS = 6n

/** Cap the persisted holder map (audit H5): it grew one row per address that
 *  ever touched the token with no eviction, so a dust airdrop to 100k
 *  addresses blew the localStorage quota — and cacheSet swallows that error,
 *  silently degrading every page view to a full from-block-0 Transfer scan.
 *  Only positive balances are persisted, largest first. */
const MAX_CACHED_HOLDERS = 2_000

function applyTransfers(
  holders: Record<string, HolderState>,
  logs: { args: { from?: Address; to?: Address; value?: bigint }; blockNumber: bigint; logIndex?: number }[],
): void {
  // Order is load-bearing for a running-balance reconstruction and getLogs
  // ordering is not guaranteed across providers (audit L7) — sort explicitly.
  const ordered = [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
      : Number(a.blockNumber - b.blockNumber),
  )
  for (const l of ordered) {
    const { from, to, value } = l.args
    if (value === undefined) continue
    // A self-transfer is a no-op on the balance; running it through both
    // branches zeroed then re-anchored the age (audit L8).
    if (from && to && from.toLowerCase() === to.toLowerCase()) continue
    const bn = l.blockNumber.toString()
    if (from && from.toLowerCase() !== ZERO) {
      const k = from.toLowerCase()
      const cur = BigInt(holders[k]?.bal ?? '0') - value
      const alive = cur > 0n
      holders[k] = {
        bal: alive ? cur.toString() : '0',
        sinceBlock: alive ? (holders[k]?.sinceBlock ?? bn) : '',
        bigBlock: alive ? (holders[k]?.bigBlock ?? bn) : '',
      }
    }
    if (to && to.toLowerCase() !== ZERO) {
      const k = to.toLowerCase()
      const prev = BigInt(holders[k]?.bal ?? '0')
      const cur = prev + value
      holders[k] = {
        bal: cur.toString(),
        // the clock anchors at the last 0→positive crossing
        sinceBlock: prev === 0n ? bn : (holders[k]?.sinceBlock ?? bn),
        // …and the SHOWN age anchors at the last credit that more than
        // doubled the position (dust first, size later ⇒ size's clock wins)
        bigBlock: prev * 2n < cur ? bn : (holders[k]?.bigBlock ?? bn),
      }
    }
  }
}

/**
 * Held-since block per holder for `token`, from an incrementally-cached full
 * Transfer scan. Returns null when the scan can't run (range-capped RPC with
 * no cache) — callers show the wall without ages rather than fabricating.
 */
export async function fetchHolderAges(
  client: PublicClient,
  chainId: number,
  token: Address,
): Promise<Map<string, { sinceBlock: bigint }> | null> {
  const key = `holdage:v2:${chainId}:${token.toLowerCase()}` // v2: bigBlock + caps
  const cachedRaw = cacheGet<HolderScanCache>(key)
  const cached = cachedRaw && isHolderScanCache(cachedRaw) ? cachedRaw : null
  const holders: Record<string, HolderState> = cached ? { ...cached.holders } : {}
  try {
    const latest = await client.getBlockNumber({ cacheTime: 0 })
    const fromBlock = cached ? BigInt(cached.upToBlock) + 1n : 0n
    if (!cached || fromBlock <= latest) {
      const logs = await client.getLogs({ address: token, event: transferEvent, fromBlock, toBlock: latest })
      applyTransfers(holders, logs)
      // Persist only LIVE holders, largest first, bounded — and hold the
      // watermark back by the reorg margin so the last few blocks re-scan
      // instead of freezing a phantom balance into the blob forever.
      const live = Object.entries(holders)
        .filter(([, st]) => BigInt(st.bal) > 0n)
        .sort((a, b) => (BigInt(b[1].bal) > BigInt(a[1].bal) ? 1 : -1))
        .slice(0, MAX_CACHED_HOLDERS)
      const settled = latest > AGE_CONFIRMATIONS ? latest - AGE_CONFIRMATIONS : 0n
      // A truncated map is no longer a faithful replay base: rewind to 0 so the
      // next visit rebuilds from scratch rather than compounding on a subset.
      const truncated = live.length < Object.values(holders).filter((st) => BigInt(st.bal) > 0n).length
      cacheSet(
        key,
        {
          upToBlock: truncated ? '0' : settled.toString(),
          holders: Object.fromEntries(truncated ? [] : live),
        } satisfies HolderScanCache,
        0,
      )
    }
  } catch {
    if (!cached) return null // no data at all — say so, never guess
    // stale-but-real cache still answers; ages just lag the newest blocks
  }
  const out = new Map<string, { sinceBlock: bigint }>()
  for (const [addr, st] of Object.entries(holders)) {
    // The SHOWN anchor is the material-entry block (see HolderState.bigBlock).
    const anchor = st.bigBlock || st.sinceBlock
    if (anchor && BigInt(st.bal) > 0n) out.set(addr, { sinceBlock: BigInt(anchor) })
  }
  return out
}

/** Two real headers → a block clock: age of ANY block without more reads
 *  (call once per surface, derive ages client-side). */
export async function fetchBlockClock(
  client: PublicClient,
): Promise<{ latest: bigint; ageOf: (block: bigint) => number }> {
  const head = await client.getBlock()
  const span = head.number > 200_000n ? 200_000n : head.number > 1n ? head.number - 1n : 0n
  const probe = span > 0n ? await client.getBlock({ blockNumber: head.number - span }) : head
  const dt = Number(head.timestamp - probe.timestamp)
  const rate = dt > 0 ? Number(head.number - probe.number) / dt : 1
  return {
    latest: head.number,
    ageOf: (block: bigint) => (block >= head.number ? 0 : Number(head.number - block) / rate),
  }
}

/** "3w" / "5d" / "2h" — the wall's compact age chip. */
export function formatAge(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`
  if (seconds < 365 * 86_400) return `${Math.floor(seconds / (7 * 86_400))}w`
  return `${(seconds / (365 * 86_400)).toFixed(1)}y`
}
