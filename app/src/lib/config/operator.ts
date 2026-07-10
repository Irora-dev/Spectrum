import { isAddress, zeroAddress, type Address } from 'viem'
import siteConfig from '../../site.config.json'

// ─────────────────────────────────────────────────────────────────────────────
// Operator-level configuration. Everything here is the HOSTING OPERATOR's choice,
// never this repo's. See OPERATORS.md. The fee wallet's primary home is the
// COMMITTED src/site.config.json (the setup studio/wizard write it; public by
// construction) — the VITE_* env vars remain as overrides.
//
// RULE (non-negotiable): no default, company, or other-party address may ever be
// a default or fallback recipient of anything in this repo — the operator supplies
// their own. The empty defaults below are load-bearing: an unset tag means
// address(0), so the corresponding fixed protocol slice (interface or launcher) is
// simply NOT carved on-chain and stays in the post-burn remainder, flowing to the
// creator share + holders. There is no routing table and no default recipient.
// ─────────────────────────────────────────────────────────────────────────────

function parseFeeAddress(raw: string | undefined, varName: string): Address | null {
  if (!raw) return null
  const v = raw.trim()
  if (!v) return null
  if (!isAddress(v, { strict: false })) {
    // Fail fast at module load: a typo'd fee recipient must never reach a tx.
    throw new Error(`Misconfigured build: ${varName} is not a valid address (${v}).`)
  }
  if (v.toLowerCase() === zeroAddress) return null
  return v as Address
}

/**
 * Optional interface-kickback tag (per-tx). When set by the operator, it rides in
 * the mint/redeem hookData (hook-data.ts) and the FeePanel renders a disclosure;
 * the basket then carves the fixed INTERFACE_SHARE_BPS (≈5% of the fee) to this
 * address on trades made through this interface. When unset (the shipped default),
 * the encoder uses address(0) and the interface slice is NOT carved at all — it
 * stays in the post-burn remainder and flows to the creator share + holders.
 * Receiving the slice makes the operator a protocol-fee recipient.
 */
export const INTERFACE_TAG_ADDRESS: Address | null = parseFeeAddress(
  import.meta.env.VITE_INTERFACE_TAG_ADDRESS || siteConfig.feeWallet,
  'VITE_INTERFACE_TAG_ADDRESS',
)

/**
 * Optional per-basket LAUNCHER address. When set by the operator, the launch
 * builder injects it into every basket's immutable `FeeConfig.launcher` at
 * deploy, so the basket pays the fixed protocol launcher slice (≈5% of the fee)
 * to this address forever. It is NEVER shown to or set by the creator — it is the
 * deploying integrator's origination attribution. Unset (the shipped default) →
 * address(0): no launcher, and that fixed slice stays in the remainder (→ creator
 * + holders) on-chain. Like the interface tag, receiving the launcher slice makes
 * the operator a protocol-fee recipient. No default, company, or other-party
 * address may ever ship here; the operator supplies their own.
 */
export const LAUNCHER_ADDRESS: Address | null = parseFeeAddress(
  import.meta.env.VITE_LAUNCHER_ADDRESS || siteConfig.feeWallet,
  'VITE_LAUNCHER_ADDRESS',
)

/**
 * Optional partner/trading app URL for the "Visit $SYMBOL" CTA on Token pages.
 * Unset (the shipped default) → the CTA does not render. There is no canonical
 * trading app for V2 baskets and this package must not anoint one; a
 * marketplace operator may point this at a venue of their own choosing.
 */
export const PARTNER_APP_URL: string | null =
  (import.meta.env.VITE_PARTNER_APP_URL || '').trim().replace(/\/$/, '') || null

/** Partner-app URL for one basket, or null when no partner app is configured. */
export function partnerAppUrl(address: string): string | null {
  return PARTNER_APP_URL ? `${PARTNER_APP_URL}/token/?addr=${address}` : null
}

// ── Creator metadata (the "metadata host / pinner" operator role, see
//    frontend/handover/01-BUSINESS.md). Creators publish a metadata
//    blob signed with their deploy key (EIP-712); the FE verifies the signature
//    against the on-chain deployer before rendering anything. The host/gateway
//    only SERVES that signed content — it never authors it. ──

/**
 * Optional base URL of a host that serves creator-published, deployer-signed
 * basket metadata. Resolution is by convention: `${base}/${chainId}/${basket}.json`.
 * Unset (the shipped default) → no metadata is fetched and every basket falls
 * back to the honest on-chain deployer-address attribution. The host is the
 * operator's own; no default or company endpoint may ever ship here.
 */
export const METADATA_BASE_URL: string | null =
  (import.meta.env.VITE_METADATA_BASE_URL || '').trim().replace(/\/$/, '') || null

/**
 * Optional IPFS HTTP gateway used to resolve `ipfs://…` references inside
 * creator metadata (avatar/banner). Unset → `ipfs://` URLs are treated as
 * unresolvable (the field is dropped); plain `https://` references always work.
 * Operator's own gateway; no default.
 */
export const IPFS_GATEWAY_URL: string | null =
  (import.meta.env.VITE_IPFS_GATEWAY_URL || '').trim().replace(/\/$/, '') || null

/**
 * Optional base URL of an operator WRITE-RELAY that accepts a creator's signed
 * metadata blob and persists it at the convention path. The relay is NEVER
 * authoritative and holds NO key — it MUST re-verify the EIP-712 signature
 * against the basket's on-chain deployer and refuse anything that fails (a
 * hostile/buggy relay can only deny, never forge — the signature is the anchor).
 * Unset (the shipped default) → the publish ceremony offers only download +
 * localStorage; there is no one-click submit. Operator's own endpoint; no
 * default or company endpoint may ship here. See OPERATORS.md.
 */
export const METADATA_WRITE_URL: string | null =
  (import.meta.env.VITE_METADATA_WRITE_URL || '').trim().replace(/\/$/, '') || null

/** Convention URL of the signed metadata blob for one basket, or null when unset. */
export function metadataUrlFor(chainId: number, basket: string): string | null {
  return METADATA_BASE_URL ? `${METADATA_BASE_URL}/${chainId}/${basket.toLowerCase()}.json` : null
}

/**
 * Convention POST URL on the write-relay for one basket, or null when unset.
 * Mirrors `metadataUrlFor` so a relay can route by `(chainId, basket)`.
 */
export function metadataWriteUrlFor(chainId: number, basket: string): string | null {
  return METADATA_WRITE_URL ? `${METADATA_WRITE_URL}/${chainId}/${basket.toLowerCase()}.json` : null
}
