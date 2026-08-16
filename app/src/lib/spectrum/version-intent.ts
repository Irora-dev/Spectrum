// ─────────────────────────────────────────────────────────────────────────────
// VERSION INTENT (ratified plan #1, 2026-08-04) — the creator's iterate loop,
// made one motion. Clicking "New version" on a basket records that the NEXT
// basket this deployer publishes is meant to supersede it; when the deployed
// basket's page opens, the pending intent pre-wires the lineage signature
// instead of leaving the supersedes claim as a separate after-the-fact chore.
//
// Deliberately a HINT, never an authority: the actual lineage is only ever the
// deployer-SIGNED supersedes claim (versioning.ts) — an intent that is stale,
// mismatched, or abandoned simply never becomes one. Browser-local, per
// deployer, freshness-capped so an intent from weeks ago cannot mislabel an
// unrelated launch.
// ─────────────────────────────────────────────────────────────────────────────

// Keyed per deployer AND chain (audit C4): one pending intent per chain —
// recording on Base must never clobber a pending Robinhood intent.
const KEY = (deployer: string, chainId: number) => `spectrum.version-intent.${deployer.toLowerCase()}.${chainId}`

/** An abandoned intent must not outlive the session it made sense in. */
export const VERSION_INTENT_TTL_MS = 7 * 24 * 3600_000

export interface VersionIntent {
  /** The basket the next publish is meant to supersede. */
  predecessor: string
  chainId: number
  at: number
}

export function recordVersionIntent(
  deployer: string,
  intent: { predecessor: string; chainId: number },
  now: number = Date.now(),
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeStorage(),
): void {
  if (!deployer || !intent.predecessor) return
  try {
    storage?.setItem(
      KEY(deployer, intent.chainId),
      JSON.stringify({ predecessor: intent.predecessor.toLowerCase(), chainId: intent.chainId, at: now }),
    )
  } catch {
    /* storage unavailable: the loop degrades to the manual link button */
  }
}

/** The pending intent for this deployer on this chain — fresh ones only. */
export function pendingVersionIntent(
  deployer: string | null | undefined,
  chainId: number,
  now: number = Date.now(),
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeStorage(),
): VersionIntent | null {
  if (!deployer) return null
  try {
    const raw = storage?.getItem(KEY(deployer, chainId))
    if (!raw) return null
    const v = JSON.parse(raw) as VersionIntent
    if (typeof v?.predecessor !== 'string' || !/^0x[0-9a-f]{40}$/.test(v.predecessor)) return null
    if (v.chainId !== chainId) return null
    if (!(typeof v.at === 'number') || now - v.at > VERSION_INTENT_TTL_MS) return null
    return v
  } catch {
    return null
  }
}

export function clearVersionIntent(
  deployer: string | null | undefined,
  chainId: number,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeStorage(),
): void {
  if (!deployer) return
  try {
    storage?.removeItem(KEY(deployer, chainId))
  } catch {
    /* nothing to clear */
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
