import type { Address } from 'viem'
import type { SignedCreatorMetadata } from './creator-metadata'

// ─────────────────────────────────────────────────────────────────────────────
// Site-bundled creator metadata — the zero-backend way to make a creator's thesis
// visible to EVERY visitor, not just the author's own browser.
//
// A signed metadata blob is a plain JSON file. The operator commits it into the
// app's own `metadata/<chainId>/<basket>.json` and it rides in the build: read
// with NO network request, NO database, and NO external service, yet still gated
// by the same on-chain signature check in resolveCreatorMeta (a committed file
// can no more forge attribution than a hosted one — the deployer signature is the
// anchor). Operator flow: publish → download the JSON → drop it at
// `metadata/<chainId>/<basket>.json` → redeploy.
//
// Lazy glob: each blob is a separate dynamic import (code-split), so only the ones
// actually viewed load. A discovery page of N baskets does N in-memory key lookups,
// not N network fetches — the reason this rung is bundled, not fetched same-origin.
// Keyed by the SAME convention as the host rung (conventionPath), project-root-
// absolute so the glob matches. Files live in `app/metadata/`, NOT `public/`
// (public/ is served as-is and is not importable → it could only be fetched).
// ─────────────────────────────────────────────────────────────────────────────

const MODULES = import.meta.glob('/metadata/**/*.json', { import: 'default' }) as Record<
  string,
  () => Promise<unknown>
>

/** The bundle key for a basket's blob — mirrors conventionPath, project-root-absolute. */
export function siteMetadataKey(chainId: number, basket: string): string {
  return `/metadata/${chainId}/${basket.toLowerCase()}.json`
}

function looksLikeBlob(v: unknown): v is SignedCreatorMetadata {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return (
    typeof b.signer === 'string' &&
    typeof b.signature === 'string' &&
    !!b.metadata &&
    typeof b.metadata === 'object'
  )
}

/**
 * Load the site-bundled signed blob for a basket, or null when none is committed.
 * Shape-guard only — the SIGNATURE is verified by the caller (resolveCreatorMeta),
 * never here. A missing key returns null with no import and no network.
 */
export async function loadSiteMetadata(chainId: number, basket: Address): Promise<SignedCreatorMetadata | null> {
  const loader = MODULES[siteMetadataKey(chainId, basket)]
  if (!loader) return null
  try {
    const v = await loader()
    return looksLikeBlob(v) ? v : null
  } catch {
    return null
  }
}
