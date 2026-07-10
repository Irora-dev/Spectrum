import {
  getAddress,
  isAddress,
  verifyTypedData,
  zeroAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem'
import { chainCfg } from '../chain/chains'
import { getDeployer } from './basket-data'
import { IPFS_GATEWAY_URL, METADATA_BASE_URL, metadataUrlFor } from '../config/operator'
import { normalizeXHandle } from './creator'
import { loadLocalMetadata } from './persist-metadata'
import { loadSiteMetadata } from './site-metadata'

// ─────────────────────────────────────────────────────────────────────────────
// Creator-published, DEPLOYER-SIGNED basket metadata (the
// "metadata host / pinner" operator role, handover/01-BUSINESS.md). A static,
// keyless, no-server site cannot fetch a creator's X profile, and a platform
// metadata store is forbidden. So the creator signs a metadata blob with
// their DEPLOY KEY (EIP-712) and publishes it to a host of their choosing; the
// FE fetches it by convention, verifies the signature against the basket's
// ON-CHAIN deployer, and only THEN renders any creator-supplied pixel.
//
// The SAME blob carries three things:
//   • social — handle / display name / avatar / banner (Phase 1; the current
//     builder publishes these as null/ENS-derived — legacy blobs still verify).
//   • thesis — tagline / thesis / sectors / timeHorizon (v3, per the social-layer
//     plan): the creator's own signed, attributed words about the basket. Carried
//     IN the signed payload (never as unsigned host columns) so the same
//     deployer-signature gate covers prose. Rendering stays operator-moderated
//     (VITE_HIDDEN_BASKETS + the operator's own host policy).
//   • lineage — `supersedes`, the predecessor a new version points back to. This
//     is the "social convention" the contracts prescribe for
//     versioning; there is NO on-chain successor pointer (that is a forbidden
//     controller). Lineage authority rests
//     on the deployer signature, verified client-side (see versioning.ts).
//
// Trust boundary: NOTHING here renders unless `verifyTypedData` passes AND the
// recovered signer equals `factory.tokens(basket) → deployer`. Absent/unset/
// invalid → the caller falls back to honest deployer-address attribution.
// ─────────────────────────────────────────────────────────────────────────────

const DOMAIN_NAME = 'Spectrum Creator Metadata'
// v2: dropped the prose fields (bio / tagline / description) from the signed
// struct — the type hash changed, so any v1 blob simply fails to verify and falls
// back to address attribution (intended). No v1 blobs exist in the wild (no host).
// v3: re-adds prose as SIGNED thesis fields (tagline / thesis / sectors /
// timeHorizon) per the social-layer plan (owner memo 2026-07-04, amended 07-05):
// a creator's thesis is first-class site content, feeding the token page and the
// discovery surfaces. Same version mechanics: a v2 blob fails to verify and falls
// back to address attribution (none are hosted anywhere — no host existed).
// v4: adds `postUrl` — the basket's LAUNCH POST on X, the only creator-controlled
// outbound link the site renders (owner call 2026-07-06). Strictly an
// x.com/<user>/status/<id> URL (see sanitizePostUrl): any other host or shape is
// rejected at build AND at render, so a hostile blob can't route visitors
// anywhere else. Same version mechanics: v3 blobs fall back to address
// attribution (Phase A localStorage only — creators simply re-sign).
const DOMAIN_VERSION = '4'

const TYPES = {
  CreatorMetadata: [
    { name: 'basket', type: 'address' },
    { name: 'supersedes', type: 'address' },
    { name: 'handle', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'avatarUrl', type: 'string' },
    { name: 'bannerUrl', type: 'string' },
    { name: 'tagline', type: 'string' },
    { name: 'thesis', type: 'string' },
    { name: 'sectors', type: 'string[]' },
    { name: 'timeHorizon', type: 'string' },
    { name: 'postUrl', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const
const PRIMARY_TYPE = 'CreatorMetadata' as const

// Render caps (defence-in-depth; the signer set these, but a host could serve a
// hostile blob with a valid signature — cap before display regardless).
const CAP = { name: 48, url: 2048, tagline: 140, thesis: 4000, sector: 24, horizon: 24 } as const
const MAX_SECTORS = 8
const MAX_BLOB_BYTES = 32_768
const FETCH_TIMEOUT_MS = 6_000

// ── Types ────────────────────────────────────────────────────────────────────

/** The signed message. Addresses are checksummed; `issuedAt` is unix seconds. */
export interface CreatorMetadata {
  basket: Address
  /** Predecessor this version supersedes; `address(0)` when none. */
  supersedes: Address
  handle: string
  name: string
  avatarUrl: string
  bannerUrl: string
  /** One-line pitch for the basket ('' when none). */
  tagline: string
  /** The creator's long-form thesis ('' when none). */
  thesis: string
  /** Sector tags, e.g. ['DeFi', 'AI'] (empty when none). */
  sectors: string[]
  /** Stated time horizon, e.g. 'long-term' ('' when none). */
  timeHorizon: string
  /** The basket's launch post on X ('' when none) — see sanitizePostUrl. */
  postUrl: string
  issuedAt: number
}

/** The published JSON blob: the message + who signed it + the signature. */
export interface SignedCreatorMetadata {
  metadata: CreatorMetadata
  signer: Address
  signature: Hex
}

/** What the creator fills in the builder / publish ceremony (all optional). */
export interface CreatorMetadataInput {
  handle?: string | null
  name?: string | null
  avatarUrl?: string | null
  bannerUrl?: string | null
  tagline?: string | null
  thesis?: string | null
  sectors?: string[] | null
  timeHorizon?: string | null
  /** Link to the basket's launch post on X (strictly validated). */
  postUrl?: string | null
  /** Set when deploying a new version (the predecessor address). */
  supersedes?: string | null
}

/** A verified, render-safe metadata view. Only produced after signature check. */
export interface VerifiedCreatorMeta {
  verified: true
  deployer: Address
  basket: Address
  /** Predecessor address, or null when this is a root basket. */
  supersedes: Address | null
  /** Canonical '@handle', or null. */
  handle: string | null
  /** x.com profile URL, or null. */
  xUrl: string | null
  name: string | null
  /** Resolved, https-only image URL (ipfs:// rewritten via the gateway), or null. */
  avatarUrl: string | null
  bannerUrl: string | null
  /** Signed thesis fields (v3), display-capped; null / [] when absent. */
  tagline: string | null
  thesis: string | null
  sectors: string[]
  timeHorizon: string | null
  /** The launch post on X (v4) — canonicalized https://x.com/<user>/status/<id>, or null. */
  postUrl: string | null
}

// ── Build / sign / verify ──────────────────────────────────────────────────

function domainFor(chainId: number, factory: Address): TypedDataDomain {
  // verifyingContract = the factory: a signature is bound to one factory (and
  // chainId), so it can't be replayed onto another deployment.
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: factory }
}

// The ONLY creator-controlled outbound LINK the site will render: one X post
// (the basket's launch post). Strictly x.com / twitter.com, strictly a
// /<user>/status/<id> path, https only — no other website can ever be smuggled
// in (the griefing surface the owner scoped out, 2026-07-06). Canonicalizes to
// https://x.com/… and drops query/hash. Shared by the publish form (live
// validation), buildCreatorMetadata (never sign junk) and toVerified (never
// render junk, even from a validly-signed hostile blob).
const X_POST_PATH_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/
export function sanitizePostUrl(raw: string): string | null {
  const s = (raw || '').trim()
  if (!s || s.length > CAP.url) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:') return null
    const host = u.hostname.toLowerCase()
    if (host !== 'x.com' && host !== 'www.x.com' && host !== 'twitter.com' && host !== 'www.twitter.com') return null
    const m = X_POST_PATH_RE.exec(u.pathname)
    if (!m) return null
    return `https://x.com/${m[1]}/status/${m[2]}`
  } catch {
    return null
  }
}

/** Trim/dedupe/cap sector tags before they enter the signed message. */
export function normalizeSectors(raw: string[] | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of raw ?? []) {
    const v = (s || '').trim().slice(0, CAP.sector)
    const key = v.toLowerCase()
    if (!v || seen.has(key)) continue
    seen.add(key)
    out.push(v)
    if (out.length >= MAX_SECTORS) break
  }
  return out
}

/** Assemble the immutable metadata message for a basket from builder input. */
export function buildCreatorMetadata(
  input: CreatorMetadataInput,
  basket: Address,
  issuedAt: number,
): CreatorMetadata {
  const sup = input.supersedes?.trim()
  return {
    basket: getAddress(basket),
    supersedes: sup && isAddress(sup, { strict: false }) ? getAddress(sup) : zeroAddress,
    handle: (input.handle ?? '').trim(),
    name: (input.name ?? '').trim(),
    avatarUrl: (input.avatarUrl ?? '').trim(),
    bannerUrl: (input.bannerUrl ?? '').trim(),
    tagline: (input.tagline ?? '').trim().slice(0, CAP.tagline),
    thesis: (input.thesis ?? '').trim().slice(0, CAP.thesis),
    sectors: normalizeSectors(input.sectors),
    timeHorizon: (input.timeHorizon ?? '').trim().slice(0, CAP.horizon),
    postUrl: sanitizePostUrl(input.postUrl ?? '') ?? '',
    issuedAt,
  }
}

/** True when the creator actually entered something worth signing/publishing. */
export function hasPublishableMetadata(meta: CreatorMetadata): boolean {
  return !!(
    meta.handle ||
    meta.name ||
    meta.avatarUrl ||
    meta.bannerUrl ||
    meta.tagline ||
    meta.thesis ||
    meta.sectors.length > 0 ||
    meta.timeHorizon ||
    meta.postUrl ||
    meta.supersedes !== zeroAddress
  )
}

function typedDataArgs(meta: CreatorMetadata, chainId: number, factory: Address) {
  return {
    domain: domainFor(chainId, factory),
    types: TYPES,
    primaryType: PRIMARY_TYPE,
    message: {
      basket: meta.basket,
      supersedes: meta.supersedes,
      handle: meta.handle,
      name: meta.name,
      avatarUrl: meta.avatarUrl,
      bannerUrl: meta.bannerUrl,
      tagline: meta.tagline,
      thesis: meta.thesis,
      sectors: meta.sectors,
      timeHorizon: meta.timeHorizon,
      postUrl: meta.postUrl,
      issuedAt: BigInt(meta.issuedAt),
    },
  } as const
}

/**
 * Sign a metadata blob with the connected (deployer) wallet. `signTypedDataAsync`
 * is wagmi's `useSignTypedData().signTypedDataAsync`. The FE owns no key — the
 * creator signs in their own wallet.
 */
export async function signCreatorMetadata(args: {
  meta: CreatorMetadata
  signer: Address
  chainId: number
  factory: Address
  signTypedDataAsync: (a: ReturnType<typeof typedDataArgs>) => Promise<Hex>
}): Promise<SignedCreatorMetadata> {
  const signature = await args.signTypedDataAsync(typedDataArgs(args.meta, args.chainId, args.factory))
  return { metadata: args.meta, signer: getAddress(args.signer), signature }
}

/**
 * The trust gate: the blob's signer must recover from the EIP-712 signature AND
 * equal the basket's on-chain deployer. Either failing → not verified.
 */
export async function verifyCreatorMetadata(
  blob: SignedCreatorMetadata,
  opts: { chainId: number; factory: Address; expectedDeployer: Address },
): Promise<boolean> {
  try {
    if (!isAddress(blob.signer, { strict: false })) return false
    if (blob.signer.toLowerCase() !== opts.expectedDeployer.toLowerCase()) return false
    return await verifyTypedData({
      address: blob.signer,
      signature: blob.signature,
      ...typedDataArgs(blob.metadata, opts.chainId, opts.factory),
    })
  } catch {
    return false
  }
}

// ── Sanitize ────────────────────────────────────────────────────────────────

// Render only https:// (and ipfs:// rewritten to the operator gateway). Reject
// javascript:/data:/http:/relative — the creator controls this string and it
// flows into <img src>. A bad value blanks just that field, never the render.
// Exported so the builder preview and deploy ceremony share one source of truth.
export function sanitizeImageUrl(raw: string): string | null {
  const s = (raw || '').trim()
  if (!s || s.length > CAP.url) return null
  let candidate = s
  if (s.toLowerCase().startsWith('ipfs://')) {
    if (!IPFS_GATEWAY_URL) return null
    candidate = `${IPFS_GATEWAY_URL}/${s.slice('ipfs://'.length).replace(/^\/+/, '')}`
  }
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

function cleanText(raw: string, max: number): string | null {
  const s = (raw || '').trim().slice(0, max)
  return s || null
}

function toVerified(meta: CreatorMetadata, deployer: Address): VerifiedCreatorMeta {
  const x = normalizeXHandle(meta.handle)
  return {
    verified: true,
    deployer: getAddress(deployer),
    basket: getAddress(meta.basket),
    supersedes:
      meta.supersedes && meta.supersedes !== zeroAddress && isAddress(meta.supersedes, { strict: false })
        ? getAddress(meta.supersedes)
        : null,
    handle: x?.handle ?? null,
    xUrl: x?.url ?? null,
    name: cleanText(meta.name, CAP.name),
    avatarUrl: sanitizeImageUrl(meta.avatarUrl),
    bannerUrl: sanitizeImageUrl(meta.bannerUrl),
    tagline: cleanText(meta.tagline, CAP.tagline),
    thesis: cleanText(meta.thesis, CAP.thesis),
    sectors: normalizeSectors(meta.sectors),
    timeHorizon: cleanText(meta.timeHorizon, CAP.horizon),
    postUrl: sanitizePostUrl(meta.postUrl ?? ''),
  }
}

// ── Fetch / resolve ──────────────────────────────────────────────────────────

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

/** Fetch + size/timeout-guard a signed metadata blob. Null on any failure. */
export async function fetchSignedMetadata(url: string): Promise<SignedCreatorMetadata | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    } finally {
      clearTimeout(t)
    }
    if (!res.ok) return null
    const len = Number(res.headers.get('content-length') || 0)
    if (len > MAX_BLOB_BYTES) return null
    const text = await res.text()
    if (text.length > MAX_BLOB_BYTES) return null
    const parsed: unknown = JSON.parse(text)
    return looksLikeBlob(parsed) ? parsed : null
  } catch {
    return null
  }
}

// One deployer source for the whole app: basket-data's shared, persisted
// factory.tokens() cache (same on-chain read this module used to issue
// itself). Checksummed at this boundary because the verify gate compares it
// against a recovered signer address.
async function readDeployer(basket: Address, chainId: number): Promise<Address | null> {
  const d = await getDeployer(basket, chainId)
  return d && isAddress(d, { strict: false }) ? getAddress(d) : null
}

/** Run one fetched/loaded blob through the full verify gate → a render-safe view. */
async function verifyBlobFor(
  blob: SignedCreatorMetadata | null,
  basket: Address,
  chainId: number,
  factory: Address,
): Promise<VerifiedCreatorMeta | null> {
  if (!blob) return null
  // Bind the blob to the basket it claims to describe.
  if (!blob.metadata?.basket || blob.metadata.basket.toLowerCase() !== basket.toLowerCase()) return null
  const deployer = await readDeployer(basket, chainId)
  if (!deployer) return null
  if (!(await verifyCreatorMetadata(blob, { chainId, factory, expectedDeployer: deployer }))) return null
  return toVerified(blob.metadata, deployer)
}

/**
 * Resolve verified creator metadata for one basket, or null. Resolution ladder:
 * DEV fixture → THIS BROWSER's localStorage (Phase A publish, see use-publish.ts)
 * → SITE-BUNDLED blob (committed into the build, visible to every visitor with no
 * backend, see site-metadata.ts) → the operator metadata host. Every rung ends in
 * the SAME verify gate (signature recovers to the on-chain deployer); any miss →
 * null → honest address attribution.
 *
 * The localStorage rung sits first (after DEV) on purpose: a creator who just signed
 * their profile must see it immediately, before it's committed anywhere. Other
 * visitors have no such blob and fall through to the site-bundled rung — the
 * zero-backend way everyone sees a published thesis — then to the optional host for
 * any long-tail basket not bundled. Every rung is client-verified, never trusted.
 */
export async function resolveCreatorMeta(
  basket: Address,
  chainId: number,
): Promise<VerifiedCreatorMeta | null> {
  if (import.meta.env.DEV) {
    const { devCreatorMeta } = await import('./dev-fixture')
    const mock = devCreatorMeta(basket, chainId)
    if (mock) return mock
  }

  const factory = chainCfg(chainId).factory
  if (!factory) return null

  // localStorage rung — the creator's own just-published blob (Phase A).
  const local = await verifyBlobFor(loadLocalMetadata(chainId, basket), basket, chainId, factory)
  if (local) return local

  // site-bundled rung — blobs the operator committed into the build. This is what
  // makes a published thesis visible to EVERY visitor with no DB / host / server.
  const bundled = await verifyBlobFor(await loadSiteMetadata(chainId, basket), basket, chainId, factory)
  if (bundled) return bundled

  // convention host rung — optional external host, for baskets not bundled.
  if (!METADATA_BASE_URL) return null
  const url = metadataUrlFor(chainId, basket)
  if (!url) return null
  return verifyBlobFor(await fetchSignedMetadata(url), basket, chainId, factory)
}
