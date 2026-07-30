import { getAddress, isAddress, verifyTypedData, type Address, type Hex, type TypedDataDomain } from 'viem'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { normalizeXHandle } from './creator'
import { sanitizeImageUrl } from './creator-metadata'
import { fetchOnchainProfile, onchainToIdentityMeta } from './profile-registry'
import { loadSiteCreatorIdentity } from './site-metadata'

// ─────────────────────────────────────────────────────────────────────────────
// Creator IDENTITY — a SELF-SIGNED, per-creator profile blob (lab 2026-07-28).
//
// The per-basket CreatorMetadata blob (creator-metadata.ts) carries a basket's
// social identity + thesis, anchored to the basket's on-chain deployer. This
// module is the per-CREATOR layer above it: one profile a creator signs for
// themselves — display name, bio, banner, and the tokens they're bullish on —
// rendered on their /creator/<address> page next to the on-chain facts (their
// baskets, TVL, performance).
//
// Deliberately a SEPARATE EIP-712 domain + struct from CreatorMetadata: existing
// basket blobs stay verifiable, and this struct can evolve on its own version.
//
// Trust boundary (simpler than the basket blob): the profile describes the SIGNER
// themselves, so the gate is `verifyTypedData` recovering to `metadata.creator` —
// no deployer read needed. A hostile blob for someone else's address cannot
// verify. Same render discipline: nothing paints unless the gate passes, every
// creator-controlled string is capped/sanitized at render regardless.
//
// Persistence = the SAME zero-backend ladder as basket metadata:
//   localStorage (the creator's own browser, live immediately) →
//   site-bundled `metadata/creators/<chainId>/<creator>.json` (operator commits
//   the downloaded blob; every visitor sees it, no DB) — see site-metadata.ts.
// ─────────────────────────────────────────────────────────────────────────────

const DOMAIN_NAME = 'Spectrum Creator Identity'
const DOMAIN_VERSION = '1'

const TYPES = {
  CreatorIdentity: [
    { name: 'creator', type: 'address' },
    { name: 'handle', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'avatarUrl', type: 'string' },
    { name: 'bannerUrl', type: 'string' },
    { name: 'bio', type: 'string' },
    { name: 'picks', type: 'address[]' },
    { name: 'pickNotes', type: 'string[]' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const
const PRIMARY_TYPE = 'CreatorIdentity' as const

// Render caps (defence-in-depth, same doctrine as creator-metadata CAP).
const CAP = { name: 48, url: 2048, bio: 600, note: 80 } as const
export const MAX_PICKS = 12

// ── Types ────────────────────────────────────────────────────────────────────

/** The signed message. `picks`/`pickNotes` are index-aligned; issuedAt unix s. */
export interface CreatorIdentityMeta {
  creator: Address
  handle: string
  name: string
  avatarUrl: string
  bannerUrl: string
  bio: string
  picks: Address[]
  pickNotes: string[]
  issuedAt: number
  /** Declared posting delegate (on-chain profiles only — NOT part of the
   *  signed EIP-712 struct, so signed-blob identities never carry it): a hot
   *  wallet allowed to write kind:"post" notes AS this creator; readers chip
   *  its posts "via delegate". It can never edit the profile or thesis. */
  delegate?: Address | null
}

export interface SignedCreatorIdentity {
  metadata: CreatorIdentityMeta
  signer: Address
  signature: Hex
}

/** What the profile editor collects (all optional). */
export interface CreatorIdentityInput {
  handle?: string | null
  name?: string | null
  avatarUrl?: string | null
  bannerUrl?: string | null
  bio?: string | null
  /** Bullish-on tokens: address + an optional one-liner each. */
  picks?: { address: string; note?: string | null }[] | null
}

/** A verified, render-safe view. Only produced after the signature gate. */
export interface VerifiedCreatorIdentity {
  verified: true
  creator: Address
  handle: string | null
  name: string | null
  avatarUrl: string | null
  bannerUrl: string | null
  bio: string | null
  picks: { address: Address; note: string | null }[]
  issuedAt: number
  /** The chain whose factory the signature is bound to (where it resolved). */
  chainId: number
  /** Declared posting delegate (on-chain profiles only; see CreatorIdentityMeta). */
  delegate: Address | null
}

// ── Build / sign / verify ────────────────────────────────────────────────────

function domainFor(chainId: number, factory: Address): TypedDataDomain {
  // Bound to one factory+chain like the basket blob — a profile signed for this
  // site's lineage can't be replayed onto an unrelated deployment.
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: factory }
}

/** Trim/validate/dedupe the picks list before it enters the signed message. */
export function normalizePicks(
  raw: CreatorIdentityInput['picks'],
): { picks: Address[]; pickNotes: string[] } {
  const seen = new Set<string>()
  const picks: Address[] = []
  const pickNotes: string[] = []
  for (const p of raw ?? []) {
    const a = (p.address || '').trim()
    if (!isAddress(a, { strict: false })) continue
    const key = a.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    picks.push(getAddress(a))
    pickNotes.push((p.note ?? '').trim().slice(0, CAP.note))
    if (picks.length >= MAX_PICKS) break
  }
  return { picks, pickNotes }
}

/** Assemble the immutable identity message from editor input. */
export function buildCreatorIdentity(
  input: CreatorIdentityInput,
  creator: Address,
  issuedAt: number,
): CreatorIdentityMeta {
  const { picks, pickNotes } = normalizePicks(input.picks)
  return {
    creator: getAddress(creator),
    handle: (input.handle ?? '').trim(),
    name: (input.name ?? '').trim().slice(0, CAP.name),
    avatarUrl: (input.avatarUrl ?? '').trim(),
    bannerUrl: (input.bannerUrl ?? '').trim(),
    bio: (input.bio ?? '').trim().slice(0, CAP.bio),
    picks,
    pickNotes,
    issuedAt,
  }
}

/** True when the creator entered something worth signing. */
export function hasPublishableIdentity(meta: CreatorIdentityMeta): boolean {
  return !!(meta.handle || meta.name || meta.avatarUrl || meta.bannerUrl || meta.bio || meta.picks.length > 0)
}

function typedDataArgs(meta: CreatorIdentityMeta, chainId: number, factory: Address) {
  return {
    domain: domainFor(chainId, factory),
    types: TYPES,
    primaryType: PRIMARY_TYPE,
    message: {
      creator: meta.creator,
      handle: meta.handle,
      name: meta.name,
      avatarUrl: meta.avatarUrl,
      bannerUrl: meta.bannerUrl,
      bio: meta.bio,
      picks: meta.picks,
      pickNotes: meta.pickNotes,
      issuedAt: BigInt(meta.issuedAt),
    },
  } as const
}

/** Sign with the creator's own wallet (wagmi's signTypedDataAsync). */
export async function signCreatorIdentity(args: {
  meta: CreatorIdentityMeta
  signer: Address
  chainId: number
  factory: Address
  signTypedDataAsync: (a: ReturnType<typeof typedDataArgs>) => Promise<Hex>
}): Promise<SignedCreatorIdentity> {
  const signature = await args.signTypedDataAsync(typedDataArgs(args.meta, args.chainId, args.factory))
  return { metadata: args.meta, signer: getAddress(args.signer), signature }
}

/** The gate: recovered signer must equal the profile's own creator address. */
export async function verifyCreatorIdentity(
  blob: SignedCreatorIdentity,
  opts: { chainId: number; factory: Address },
): Promise<boolean> {
  try {
    if (!isAddress(blob.signer, { strict: false })) return false
    if (!blob.metadata?.creator || !isAddress(blob.metadata.creator, { strict: false })) return false
    if (blob.signer.toLowerCase() !== blob.metadata.creator.toLowerCase()) return false
    return await verifyTypedData({
      address: blob.signer,
      signature: blob.signature,
      ...typedDataArgs(blob.metadata, opts.chainId, opts.factory),
    })
  } catch {
    return false
  }
}

function cleanText(raw: string, max: number): string | null {
  const s = (raw || '').trim().slice(0, max)
  return s || null
}

function toVerified(meta: CreatorIdentityMeta, chainId: number): VerifiedCreatorIdentity {
  const x = normalizeXHandle(meta.handle)
  const { picks, pickNotes } = normalizePicks(
    meta.picks.map((a, i) => ({ address: a, note: meta.pickNotes[i] ?? '' })),
  )
  return {
    verified: true,
    creator: getAddress(meta.creator),
    handle: x?.handle ?? null,
    name: cleanText(meta.name, CAP.name),
    avatarUrl: sanitizeImageUrl(meta.avatarUrl),
    bannerUrl: sanitizeImageUrl(meta.bannerUrl),
    bio: cleanText(meta.bio, CAP.bio),
    picks: picks.map((address, i) => ({ address, note: pickNotes[i] || null })),
    issuedAt: meta.issuedAt,
    chainId,
    delegate: meta.delegate && isAddress(meta.delegate, { strict: false }) ? getAddress(meta.delegate) : null,
  }
}

// ── Persistence (localStorage rung) ──────────────────────────────────────────

const LS_PREFIX = 'spectrum:creator-identity:v1:'
const lsKey = (chainId: number, creator: string) => `${LS_PREFIX}${chainId}:${creator.toLowerCase()}`

export function saveLocalIdentity(chainId: number, creator: Address, blob: SignedCreatorIdentity): void {
  try {
    localStorage.setItem(lsKey(chainId, creator), JSON.stringify(blob))
  } catch {
    /* storage unavailable — download rung still applies */
  }
}

function looksLikeBlob(v: unknown): v is SignedCreatorIdentity {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return typeof b.signer === 'string' && typeof b.signature === 'string' && !!b.metadata && typeof b.metadata === 'object'
}

export function loadLocalIdentity(chainId: number, creator: Address): SignedCreatorIdentity | null {
  try {
    const raw = localStorage.getItem(lsKey(chainId, creator))
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    return looksLikeBlob(v) ? v : null
  } catch {
    return null
  }
}

export function clearLocalIdentity(chainId: number, creator: Address): void {
  try {
    localStorage.removeItem(lsKey(chainId, creator))
  } catch {
    /* ignore */
  }
}

/** The path an operator commits the downloaded blob at (under `app/metadata/`). */
export function identityConventionPath(chainId: number, creator: Address): string {
  return `creators/${chainId}/${creator.toLowerCase()}.json`
}

/** Pretty JSON for the download rung. */
export function identityBlobJson(blob: SignedCreatorIdentity): string {
  return JSON.stringify(blob, null, 2)
}

// ── Resolve ──────────────────────────────────────────────────────────────────

async function verifyBlobFor(
  blob: SignedCreatorIdentity | null,
  creator: Address,
  chainId: number,
  factory: Address,
): Promise<VerifiedCreatorIdentity | null> {
  if (!blob) return null
  if (!blob.metadata?.creator || blob.metadata.creator.toLowerCase() !== creator.toLowerCase()) return null
  if (!(await verifyCreatorIdentity(blob, { chainId, factory }))) return null
  return toVerified(blob.metadata, chainId)
}

/** Resolve a creator's verified identity on ONE chain. Rungs, in order:
 *  localStorage (the creator's own browser, instant) → ON-CHAIN registry (the
 *  canonical shared store — one tx, visible on every deployment of the kit;
 *  authenticated by the tx sender, so no signature envelope) → site-bundled
 *  (operator-committed fallback for chains without a registry). */
export async function resolveCreatorIdentity(
  creator: Address,
  chainId: number,
): Promise<VerifiedCreatorIdentity | null> {
  if (import.meta.env.DEV) {
    const { devCreatorIdentity } = await import('./dev-fixture')
    const mock = devCreatorIdentity(creator, chainId)
    if (mock) return mock
  }
  const cfg = chainCfg(chainId)
  const factory = cfg.factory
  if (!factory) return null

  const local = await verifyBlobFor(loadLocalIdentity(chainId, creator), creator, chainId, factory)
  if (local) return local

  if (cfg.notesRegistry) {
    try {
      const hit = await fetchOnchainProfile(clientFor(chainId), cfg.notesRegistry, creator)
      if (hit) return toVerified(onchainToIdentityMeta(hit.json, creator, hit.blockNumber), chainId)
    } catch {
      /* registry read failed (RPC hiccup) — the bundled rung still applies */
    }
  }

  return verifyBlobFor(await loadSiteCreatorIdentity(chainId, creator), creator, chainId, factory)
}

/** Resolve across every scaffolded chain (a profile signs against ONE factory;
 *  the viewer may be on another) — first verified hit wins, in registry order. */
export async function resolveCreatorIdentityAny(creator: Address): Promise<VerifiedCreatorIdentity | null> {
  for (const id of SUPPORTED_CHAIN_IDS) {
    const hit = await resolveCreatorIdentity(creator, id)
    if (hit) return hit
  }
  return null
}
