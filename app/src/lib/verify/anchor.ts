// ─────────────────────────────────────────────────────────────────────────────
// Canonical anchor — what /verify compares a build's wired addresses against.
//
// Ported from the pre-merge kit's Ring-1 verification branch and ADAPTED to
// this tree's reality: that branch predates the "contracts ship by default"
// decision, so its anchor was empty-by-red-line. THIS kit commits the canonical Spectrum address
// book (lib/chain/deployments.json) — the confirmed set — so the anchor IS that
// book, named as exactly that. The comparison stays pure and honest:
//   • effective == canonical  → 'canonical' (the shipped Spectrum deployment)
//   • effective ≠ canonical   → 'override'  (the operator wired their OWN deployment
//                                            — legitimate, but users should see it)
//   • nothing configured      → 'unset'
// It never renders a false "genuine": an override is stated, not condemned; an
// unreadable anchor never upgrades to a match.
//
// The deployer identity anchor (`0xsolazy.eth`) is the protocol dev's published
// ENS. It is resolved LIVE (mainnet ENS, never hard-coded to an address) and
// shown as provenance next to explorer links, so a user can check the factory's
// creation transaction against it themselves. The factory exposes no self-
// deployer view, so the kit displays the anchor + the way to check — it does not
// assert an on-chain equality it cannot read.
// ─────────────────────────────────────────────────────────────────────────────

import type { Address } from 'viem'
import canonicalBook from '../chain/deployments.json'

/** The protocol dev's published deployer identity — resolved live, never baked. */
export const DEPLOYER_ANCHOR_ENS = '0xsolazy.eth'

export type AddressVerdict = 'canonical' | 'override' | 'unset'

export interface VerifiedField {
  key: 'factory' | 'swapRouter' | 'usdc'
  label: string
  /** The address THIS BUILD actually uses (env override else the shipped book). */
  effective: Address | null
  /** The shipped canonical address for the chain (null = chain not in the book). */
  canonical: Address | null
  verdict: AddressVerdict
}

const eqAddr = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

function canonicalFor(chainId: number, key: 'factory' | 'swapRouter' | 'usdc'): Address | null {
  const entry = (canonicalBook as Record<string, Record<string, string>>)[String(chainId)]
  const v = entry?.[key]
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null
}

/** Pure verdict for one field: what this build wires vs the shipped canonical book. */
export function verdictFor(effective: Address | null | undefined, canonical: Address | null): AddressVerdict {
  if (!effective) return 'unset'
  return eqAddr(effective, canonical) ? 'canonical' : 'override'
}

/** The three user-facing contract fields /verify authenticates, for one chain. */
export function verifyChainConfig(
  chainId: number,
  effective: { factory: Address | null; swapRouter: Address | null; usdc: Address | null },
): VerifiedField[] {
  return (
    [
      ['factory', 'Basket factory'],
      ['swapRouter', 'Swap router'],
      ['usdc', 'USDC'],
    ] as const
  ).map(([key, label]) => {
    const canonical = canonicalFor(chainId, key)
    return { key, label, effective: effective[key], canonical, verdict: verdictFor(effective[key], canonical) }
  })
}
