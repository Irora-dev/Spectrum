// ─────────────────────────────────────────────────────────────────────────────
// WALLET NAMES (owner's queue: the linked-wallet manager should let you NAME
// wallets) — a local, display-only label per address. Never exported, never
// signed, never sent anywhere: a name is this browser's own shorthand, so
// localStorage is its honest home (the dismissals' precedent). One global
// map, not per-owner: the same hardware wallet keeps its name across groups.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum:wallet-names:v1'
export const WALLET_NAMES_CHANGED = 'spectrum:wallet-names-changed'
const MAX_NAME = 24

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k.toLowerCase()] = v.slice(0, MAX_NAME)
    }
    return out
  } catch {
    return {}
  }
}

export function walletName(address: string | null | undefined): string | null {
  if (!address) return null
  return read()[address.toLowerCase()] ?? null
}

/** Set (or clear, with '') a wallet's local name. Fires the change event so
 *  every mounted consumer re-reads. */
export function setWalletName(address: string, name: string): void {
  try {
    const m = read()
    const k = address.toLowerCase()
    const v = name.trim().slice(0, MAX_NAME)
    if (v) m[k] = v
    else delete m[k]
    localStorage.setItem(KEY, JSON.stringify(m))
    window.dispatchEvent(new Event(WALLET_NAMES_CHANGED))
  } catch {
    /* storage unavailable — the name just does not persist */
  }
}
