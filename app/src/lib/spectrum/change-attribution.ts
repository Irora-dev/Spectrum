// ─────────────────────────────────────────────────────────────────────────────
// CHANGE ATTRIBUTION — who holds each asset a reshape touches (recording 1205:
// "some assets will be on one wallet, some on another… you see, okay, these
// assets in the execution flow are on this wallet").
//
// WHY A SIDECAR: the reshape's changes travel to the review through the draft
// store, whose parser lives in the FROZEN money core (allocation.ts) and
// whitelists fields — a new field would be silently dropped there, and the
// freeze forbids widening it. Attribution is a ROUTING HINT, not money state:
// it is recomputed from live reads on every reshape, so sessionStorage — the
// pay-choice store's own precedent — is its honest home. Absent attribution
// degrades to today's behavior exactly (the run tries, the simulation
// refuses); it can gate DISPLAY and SPLITTING, never a send.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum:change-attribution:v1'
const MAX_ROWS = 128

export interface HeldBy {
  owner: string
  usd: number
}

function read(): Record<string, HeldBy[]> {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return {}
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {}
    const out: Record<string, HeldBy[]> = {}
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue
      const rows = v
        .filter(
          (r): r is HeldBy =>
            !!r &&
            typeof (r as HeldBy).owner === 'string' &&
            /^0x[0-9a-fA-F]{40}$/.test((r as HeldBy).owner) &&
            Number.isFinite((r as HeldBy).usd) &&
            (r as HeldBy).usd >= 0,
        )
        .slice(0, 8)
      if (rows.length > 0) out[k.toLowerCase()] = rows
    }
    return out
  } catch {
    return {}
  }
}

/** Write the attribution for the assets one reshape touches. Replaces the
 *  whole map — a reshape is the freshest read of who holds what. */
export function writeChangeAttribution(rows: { chainId: number; address: string; heldBy: HeldBy[] }[]): void {
  try {
    const out: Record<string, HeldBy[]> = {}
    for (const r of rows.slice(0, MAX_ROWS)) {
      if (r.heldBy.length > 0) out[`${r.chainId}:${r.address.toLowerCase()}`] = r.heldBy.slice(0, 8)
    }
    sessionStorage.setItem(KEY, JSON.stringify(out))
  } catch {
    /* storage unavailable — the review degrades to today's behavior */
  }
}

/** Who holds this asset, biggest first — or null when the reshape recorded
 *  nothing (older draft, cleared session, single-wallet book). */
export function changeHeldBy(chainId: number, address: string): HeldBy[] | null {
  const rows = read()[`${chainId}:${address.toLowerCase()}`]
  return rows && rows.length > 0 ? [...rows].sort((a, b) => b.usd - a.usd) : null
}
