import { parseAbi, type Address } from 'viem'
import { clientFor } from '../chain/rpc'
import { listAllBaskets, type BasketSummary } from './basket-data'
import { resolveCreatorMeta } from './creator-metadata'
import { findBestPool, hookedMarketDominates, PoolDetectionError } from '../pools'

// ─────────────────────────────────────────────────────────────────────────────
// UNSEEDED BASKETS — the recovery read (owner 2026-08-15 11:43: "I got bumped
// off of the seed process… now I can't actually find the basket I was about to
// seed"). A deployed basket whose ceremony died before the first buy is live
// on-chain but invisible in the UI: the create-page draft correctly retired
// when its ticker went live, and the seed door lived in the ceremony that
// closed. This module finds them from ON-CHAIN TRUTH — the factory registry's
// deployer and the basket's own effectiveSupply — never from local drafts
// (which are exactly what a refresh loses).
//
// "Remove" is an HONEST LOCAL DISMISSAL: an ownerless on-chain basket cannot
// be deleted, so removing hides it from this wallet's list on this browser and
// says so. Unreadable supply is treated as SEEDED (skipped): a wrong recovery
// banner over a healthy basket is worse than a missing one, and the next read
// heals it.
// ─────────────────────────────────────────────────────────────────────────────

const DISMISS_KEY = 'spectrum.unseeded.dismissed.v1'
const supplyAbi = parseAbi(['function effectiveSupply() view returns (uint256)'])

function dismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Hide one deployed-but-unseeded basket from this browser's recovery list.
 *  Local-only by construction — the on-chain basket stays. */
export function dismissUnseeded(chainId: number, address: string): void {
  try {
    const s = dismissed()
    s.add(`${chainId}:${address.toLowerCase()}`)
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...s]))
  } catch {
    /* storage unavailable — the row simply reappears; never a crash */
  }
}

/** One basket's effectiveSupply, or null when unreadable (never 0-by-guess). */
export async function basketSupply(chainId: number, address: string): Promise<bigint | null> {
  try {
    return await clientFor(chainId).readContract({ address: address as Address, abi: supplyAbi, functionName: 'effectiveSupply' })
  } catch {
    return null
  }
}

/** Every basket this wallet DEPLOYED whose first buy has not happened yet
 *  (effectiveSupply 0), minus local dismissals. On-chain truth only. */
export async function unseededBasketsOf(viewer: Address): Promise<BasketSummary[]> {
  const me = viewer.toLowerCase()
  const all = await listAllBaskets()
  const mine = all.filter((b) => b.deployer?.toLowerCase() === me)
  if (mine.length === 0) return []
  const hidden = dismissed()
  const out: BasketSummary[] = []
  await Promise.all(
    mine.map(async (b) => {
      if (hidden.has(`${b.chainId}:${b.address.toLowerCase()}`)) return
      try {
        const supply = await clientFor(b.chainId).readContract({
          address: b.address as Address,
          abi: supplyAbi,
          functionName: 'effectiveSupply',
        })
        if (supply === 0n) out.push(b)
      } catch {
        /* unreadable ≠ unseeded — skip; the next read heals */
      }
    }),
  )
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.chainId - b.chainId)
}


// ─────────────────────────────────────────────────────────────────────────────
// THE THESIS NUDGE READ (owner 2026-08-15, closing the A-to-Z's last hole:
// close the tab after seeding and nothing prompts the thesis). A basket this
// wallet DEPLOYED that is LIVE (seeded, supply > 0) but carries NO thesis in
// this browser's signed metadata still needs its words. Local-rung check by
// design: the words persist locally first (persist-metadata rung 3), so
// "no local thesis" is exactly the state the nudge exists to fix. Dismissable
// per ticker, separately from the seed dismissals.
// ─────────────────────────────────────────────────────────────────────────────

const THESIS_DISMISS_KEY = 'spectrum.thesis-nudge.dismissed.v1'

function thesisDismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(THESIS_DISMISS_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Hide one ticker's thesis nudge on this browser. */
export function dismissThesisNudge(symbol: string): void {
  try {
    const s = thesisDismissed()
    s.add(symbol.toUpperCase())
    localStorage.setItem(THESIS_DISMISS_KEY, JSON.stringify([...s]))
  } catch {
    /* storage unavailable — the nudge simply reappears */
  }
}

/** Every SEEDED basket this wallet deployed that has no thesis PUBLISHED yet
 *  (the verified resolve, on-chain rung included; dismissals per ticker). */
export async function seededNeedingThesis(viewer: Address): Promise<BasketSummary[]> {
  const me = viewer.toLowerCase()
  const all = await listAllBaskets()
  const mine = all.filter((b) => b.deployer?.toLowerCase() === me)
  if (mine.length === 0) return []
  const hidden = thesisDismissed()
  const out: BasketSummary[] = []
  await Promise.all(
    mine.map(async (b) => {
      if (hidden.has(b.symbol.toUpperCase())) return
      // the FULL resolve (on-chain rung included — publishing is on-chain now,
      // owner 2026-08-15): once the tx confirms, the nudge dies on EVERY device
      const meta = await resolveCreatorMeta(b.address as Address, b.chainId).catch(() => null)
      if (meta?.thesis?.trim()) return // words exist — nothing to nudge
      const supply = await basketSupply(b.chainId, b.address)
      if (supply != null && supply > 0n) out.push(b)
    }),
  )
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.chainId - b.chainId)
}


/** WHY a deployed basket cannot seed, when a leg's venue is the blocker —
 *  or null when nothing structural was found (the seed may simply await its
 *  money). Probes each leg's live routing (owner 2026-08-15, after TEST10006
 *  sat in the recovery banner with no way to know its FWA leg refuses every
 *  route): hook-dominant legs and no-pool legs are named, so the banner can
 *  say "this one can't seed" instead of nagging forever. Best-effort — an
 *  unreadable probe answers null, never a guessed verdict. */
export async function seedBlockerFor(b: BasketSummary): Promise<string | null> {
  for (const leg of (b.top ?? []).slice(0, 6)) {
    try {
      const pool = await findBestPool(leg.address as Address, b.chainId)
      if (pool.hookedMarket && hookedMarketDominates(pool.hookedMarket.hookedDepthEth, pool.hookedMarket.bestHooklessDepthEth)) {
        return `$${leg.symbol} trades only in its own hooked market — the seed's route will be refused`
      }
    } catch (e) {
      if (e instanceof PoolDetectionError) return `$${leg.symbol}: ${e.message}`
      /* transient read — say nothing rather than guess */
    }
  }
  return null
}
