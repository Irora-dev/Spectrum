import type { Address } from 'viem'
import { metadataWriteUrlFor } from '../config/operator'
import type { SignedCreatorMetadata } from './creator-metadata'

// ─────────────────────────────────────────────────────────────────────────────
// Phase A persistence ladder for a creator's signed metadata blob
// (FE-VERSION-PUBLISH-DESIGN §5). Three rungs, all optional except the last:
//
//   1. operator WRITE-RELAY — a one-click POST, only when VITE_METADATA_WRITE_URL
//      is set. The relay re-verifies the signature server-side and persists at the
//      convention path; it can never forge (signature is the anchor). We treat a
//      2xx as "submitted" and let use-publish re-verify by reading it back.
//   2. DOWNLOAD — hand the creator the signed JSON + the exact convention path to
//      place it at, for self-host or a manual operator submission.
//   3. localStorage — ALWAYS. The creator's own browser shows their new version +
//      lineage immediately, even before the blob is hosted anywhere. resolveCreatorMeta
//      reads this rung (still behind the full on-chain verify gate).
//
// This module is storage-only: no signing, no chain reads, no verify. It imports
// only the convention-URL helpers + a type, so there is no runtime cycle with
// creator-metadata.ts (which imports the localStorage helpers below at runtime).
// ─────────────────────────────────────────────────────────────────────────────

const LS_PREFIX = 'spectrum:metadata:v1:'
const lsKey = (chainId: number, basket: string) => `${LS_PREFIX}${chainId}:${basket.toLowerCase()}`

/** Persist a signed blob in this browser, keyed `(chainId, basket)`. Best-effort. */
export function saveLocalMetadata(chainId: number, basket: Address, blob: SignedCreatorMetadata): void {
  try {
    localStorage.setItem(lsKey(chainId, basket), JSON.stringify(blob))
  } catch {
    /* storage full / unavailable — the download + relay rungs still apply */
  }
}

/** Read this browser's stored blob for a basket, or null. Shape-guarded only —
 *  the SIGNATURE is verified by the caller (resolveCreatorMeta), never here. */
export function loadLocalMetadata(chainId: number, basket: Address): SignedCreatorMetadata | null {
  try {
    const raw = localStorage.getItem(lsKey(chainId, basket))
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return null
    const b = v as Record<string, unknown>
    if (typeof b.signer !== 'string' || typeof b.signature !== 'string') return null
    if (!b.metadata || typeof b.metadata !== 'object') return null
    return v as SignedCreatorMetadata
  } catch {
    return null
  }
}

/** Drop this browser's stored blob for a basket (e.g. after a re-publish that fails). */
export function clearLocalMetadata(chainId: number, basket: Address): void {
  try {
    localStorage.removeItem(lsKey(chainId, basket))
  } catch {
    /* ignore */
  }
}

/** Pretty-printed JSON the creator places at the convention path. */
export function blobJson(blob: SignedCreatorMetadata): string {
  return JSON.stringify(blob, null, 2)
}

/**
 * The exact convention path (`<chainId>/<basket>.json`) the blob must be served
 * from, so download instructions can show it whether or not a base URL is set.
 */
export function conventionPath(chainId: number, basket: Address): string {
  return `${chainId}/${basket.toLowerCase()}.json`
}

/** Trigger a browser download of the signed blob as `<basket>.json`. No-op in non-DOM. */
export function downloadMetadataBlob(basket: Address, blob: SignedCreatorMetadata): void {
  try {
    const data = blobJson(blob)
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${basket.toLowerCase()}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoke on the next tick so the click has fired.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch {
    /* download is best-effort — localStorage already holds the blob */
  }
}

export type RelayOutcome = 'unconfigured' | 'submitted' | 'failed'

const RELAY_TIMEOUT_MS = 8_000

/**
 * POST the signed blob to the operator write-relay, if one is configured. Returns
 * `unconfigured` when no `VITE_METADATA_WRITE_URL` is set (the shipped default),
 * `submitted` on a 2xx, `failed` otherwise. The relay is expected to re-verify the
 * signature itself; the caller additionally re-reads the convention URL to confirm
 * the blob actually became servable before claiming success.
 */
export async function postToWriteRelay(
  chainId: number,
  basket: Address,
  blob: SignedCreatorMetadata,
): Promise<RelayOutcome> {
  const url = metadataWriteUrlFor(chainId, basket)
  if (!url) return 'unconfigured'
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: blobJson(blob),
      })
    } finally {
      clearTimeout(t)
    }
    return res.ok ? 'submitted' : 'failed'
  } catch {
    return 'failed'
  }
}
