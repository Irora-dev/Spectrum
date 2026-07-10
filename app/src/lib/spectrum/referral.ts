import { isAddress, zeroAddress, type Address } from 'viem'
import { normalize } from 'viem/ens'
import { clientFor } from '../chain/rpc'
import { MAINNET_CHAIN_ID } from '../chain/constants'

// Phase-1 permissionless referral (owner 2026-07-07). A referral is an ADDRESS
// carried in a `?ref=` link; we persist it and the money paths tag it as the
// interface recipient on buys and the launcher on a deploy. Payout is on-chain,
// pull-claimable (flushFrontendFees) — no account, no backend.
//
// Attribution (owner 2026-07-07): FIRST-TOUCH — the first valid ref wins and is
// never overwritten. TRADES stay persistent (every trade tags the stored ref).
// The LAUNCHER credit applies only to the referred wallet's FIRST basket, gated
// on-chain (no existing baskets) + a one-shot `creatorUsed` flag here.
const REF_KEY = 'spectrum:ref'

interface StoredRef {
  address: Address
  at: number
  creatorUsed?: boolean
}

// A ref must be a real, non-zero address (a `?ref=0x0` would override the
// operator's interface tag with zero + print a bogus disclosure).
const isValidRef = (v: string): v is Address => isAddress(v) && v.toLowerCase() !== zeroAddress

function read(): StoredRef | null {
  try {
    const raw = localStorage.getItem(REF_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { address?: unknown; at?: unknown; creatorUsed?: unknown }
    return typeof p.address === 'string' && isValidRef(p.address)
      ? { address: p.address, at: typeof p.at === 'number' ? p.at : 0, creatorUsed: p.creatorUsed === true }
      : null
  } catch {
    return null
  }
}
function write(r: StoredRef): void {
  try {
    localStorage.setItem(REF_KEY, JSON.stringify(r))
  } catch {
    /* storage unavailable — referral is best-effort */
  }
}

/** The stored referrer address, or null. Pass the connected wallet as `self` to
 *  suppress SELF-referral: a stored ref equal to the current wallet returns null,
 *  so the money paths fall back to the operator tag instead of paying a user their
 *  own interface/launcher slice — which is trivially (and silently) triggered by
 *  opening your own share link, first-touch (audit 2026-07-07). */
export function getStoredRef(self?: Address | null): Address | null {
  const ref = read()?.address ?? null
  if (ref && self && ref.toLowerCase() === self.toLowerCase()) return null
  return ref
}

/** Has the launcher credit already been consumed (first basket)? */
export function hasCreatorRefBeenUsed(): boolean {
  return read()?.creatorUsed === true
}

/** Mark the launcher credit consumed — the referred wallet has launched its
 *  first basket, so later deploys no longer credit the referrer. */
export function markCreatorRefUsed(): void {
  const r = read()
  if (r) write({ ...r, creatorUsed: true })
}

/** Resolve a `?ref` value to a canonical address: a 0x address directly, or an
 *  `<name>.eth` via mainnet ENS. Null if invalid / unresolvable. */
export async function resolveRefInput(v: string): Promise<Address | null> {
  if (isValidRef(v)) return v
  if (!v.toLowerCase().endsWith('.eth')) return null
  try {
    const addr = await clientFor(MAINNET_CHAIN_ID).getEnsAddress({ name: normalize(v) })
    return addr && isValidRef(addr) ? addr : null
  } catch {
    return null
  }
}

/** Read `?ref=<address|name.eth>` from a URL and persist it FIRST-TOUCH (a ref
 *  already stored is never overwritten). Async for ENS. Safe on every load. */
export async function captureRefFromUrl(search: string): Promise<void> {
  if (read()) return // first-touch: keep the original referrer
  let v: string | null = null
  try {
    v = new URLSearchParams(search).get('ref')
  } catch {
    return
  }
  if (!v) return
  const addr = await resolveRefInput(v)
  // re-check after the await: another capture may have won the race.
  if (addr && !read()) write({ address: addr, at: Date.now() })
}

/** Build a shareable referral link for a referrer (address or ENS name). */
export function refLinkFor(handle: string, origin: string, path = '/explore'): string {
  return `${origin}${path}?ref=${handle}`
}
