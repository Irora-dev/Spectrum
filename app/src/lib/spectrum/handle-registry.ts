import { getAddress, isAddress, type Address, type PublicClient } from 'viem'
import { BASE_CHAIN_ID } from '../chain/constants'
import { chainCfg } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { cacheGet, cacheSet } from './persist-cache'
import { fetchNotes, noteKind, notesRegistryAbi, type NoteEvent } from './profile-registry'
import { listBasketsForChain } from './basket-data'
import {
  addressForIn,
  handleForIn,
  normalizeHandle,
  resolveHandles,
  type HandleClaim,
  type HandleMap,
  type HandleOwner,
} from './creator-handles'

// ─────────────────────────────────────────────────────────────────────────────
// Creator handles — the chain half (spec: workspace/spectrum-release/
// creator-handles-spec.md). Reads `NoteSet` events of kind "handle" from
// SpectrumNotes on ONE chain, feeds them to the pure resolver, and caches the
// answer. No server, no database, and the same claim resolves identically on
// every operator's self-hosted site.
//
// The one rule everything here bends to: A FAILED READ RETURNS "UNKNOWN",
// NEVER AN ANSWER. Handles are decided by the EARLIEST claim, so a scan that
// silently missed old blocks would hand a name to the second person who asked
// for it — worse than showing nothing. Every degraded path below reports
// `unknown` and the surfaces treat it as "we could not check", never as "free".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE CHAIN IS THE HANDLE AUTHORITY (spec §1). The registry is deployed on
 * Base, Ethereum and Robinhood; without this constant the same name could be
 * claimed by different people on different chains and every site would disagree
 * about who owns it. Base: cheap, durable, and the claim is read from every
 * site regardless of which network the visitor is browsing on.
 *
 * Trivially changed before launch. EFFECTIVELY PERMANENT AFTER IT — moving it
 * later re-decides every name that has already been claimed.
 */
export const HANDLE_AUTHORITY_CHAIN_ID = BASE_CHAIN_ID

/** kind topic for a claim. Deliberately NOT added to NOTE_KINDS in
 *  profile-registry.ts: that file is shared and this lane owns its own kind.
 *  Same derivation (keccak of the lowercase tag), so the topic is identical. */
export const HANDLE_KIND = noteKind('handle')

/** The claim envelope. `h` carries what the creator TYPED — the reader folds it
 *  for uniqueness and keeps the casing for display (creator-handles.ts). */
export interface HandleClaimJson {
  v: 1
  h: string
}

/** Calldata for `setNote(self, handle, …)`. Normalized first, so an invalid
 *  name can never reach the chain and sit there as permanent noise. */
export function encodeHandleClaim(typed: string): string | null {
  const handle = normalizeHandle(typed)
  if (!handle) return null
  return JSON.stringify({ v: 1, h: handle.display } satisfies HandleClaimJson)
}

/** The claimed name from a note, '' for the registry's own clear (a release),
 *  or null for anything that is not a claim at all. */
export function decodeHandleClaim(raw: string): string | null {
  if (raw === '') return '' // the contract's clear — releases the author's name
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const b = parsed as Record<string, unknown>
  if (b.v !== 1 || typeof b.h !== 'string') return null
  return b.h
}

/** The notes registry on the authority chain, or null when this build has none
 *  (an operator who never configured one simply has no handles). */
export function handleRegistryAddress(): Address | null {
  try {
    return chainCfg(HANDLE_AUTHORITY_CHAIN_ID).notesRegistry
  } catch {
    return null
  }
}

// ── the claim scan ───────────────────────────────────────────────────────────

interface HandleCache {
  upToBlock: string
  events: { author: Address; subject: Address; raw: string; blockNumber: string; logIndex: number }[]
}

function isHandleCache(v: unknown): v is HandleCache {
  if (!v || typeof v !== 'object') return false
  const c = v as HandleCache
  return typeof c.upToBlock === 'string' && Array.isArray(c.events)
}

/**
 * Cache bound. Unlike the social caches (notes-social.ts) this one CANNOT
 * collapse to the latest note per author: a rename is what retires the old
 * name, so dropping superseded rows would make a retired name look free and
 * hand it to the next person who asked. It keeps the OLDEST rows instead —
 * earliest-wins means old claims are the load-bearing ones — and truncating
 * rewinds the watermark so the dropped tail is re-scanned, never lost.
 */
const MAX_CACHED_CLAIMS = 4_000

/** A claim scan, WITH the flag that decides whether the answer may be used.
 *  `complete: false` means blocks were never seen; the map built from it can
 *  name the wrong owner, so callers must degrade to "unknown". */
export interface ClaimsRead {
  events: NoteEvent[]
  complete: boolean
}

/**
 * Every handle claim on the authority chain, oldest→newest, incrementally
 * cached (NoteSet is append-only, so a repeat visit scans only new blocks).
 *
 * NO block-range floor, deliberately — unlike the reaction wall, which bounds
 * its download with a window. The earliest claim wins, so a window would drop
 * exactly the rows that decide ownership. The bound here is the incremental
 * cache plus the row cap above, and a range-capped RPC is reported rather than
 * papered over.
 */
export async function fetchHandleClaims(
  client: PublicClient,
  registry: Address,
  chainId: number,
): Promise<ClaimsRead | null> {
  const key = `handles:v1:${registry.toLowerCase()}:${chainId}`
  const cachedRaw = cacheGet<HandleCache>(key)
  const cached = isHandleCache(cachedRaw) ? cachedRaw : null
  // The cache is only ever WRITTEN from a complete scan, so a cache existing
  // means "complete history from block 0 up to upToBlock" — which is what lets
  // this resume from the watermark instead of re-reading from genesis.
  const from = cached ? BigInt(cached.upToBlock) + 1n : 0n
  const read = await fetchNotes(client, registry, { kind: HANDLE_KIND }, from)
  const prior: NoteEvent[] = (cached?.events ?? []).map((e) => ({
    author: e.author,
    subject: e.subject,
    raw: e.raw,
    blockNumber: BigInt(e.blockNumber),
    logIndex: e.logIndex,
  }))

  if (read === null) {
    // Could not read at all. A stale cache still describes who owned what as of
    // its watermark, which is worth serving for a page LOAD, but it is not
    // complete, so nothing may be claimed against it.
    return cached ? { events: prior, complete: false } : null
  }
  const all = [...prior, ...read.events]
  // A range-capped RPC skipped blocks. Serve what we have, never persist it,
  // and above all never call it complete: the missing blocks may hold the
  // earliest claim on a name.
  if (read.partial) return { events: all, complete: false }

  const kept = all.length > MAX_CACHED_CLAIMS ? all.slice(0, MAX_CACHED_CLAIMS) : all
  const firstDropped = all[kept.length]
  const watermark = firstDropped
    ? firstDropped.blockNumber > 0n
      ? firstDropped.blockNumber - 1n
      : 0n
    : read.upToBlock
  cacheSet(
    key,
    {
      upToBlock: watermark.toString(),
      events: kept.map((e) => ({
        author: e.author,
        subject: e.subject,
        raw: e.raw,
        blockNumber: e.blockNumber.toString(),
        logIndex: e.logIndex,
      })),
    } satisfies HandleCache,
    0,
  )
  return { events: all, complete: true }
}

/** Note events → claims the resolver understands. Anything that is not a claim
 *  is dropped here rather than inside the resolver, which stays pure. */
export function claimsFromNotes(events: readonly NoteEvent[]): HandleClaim[] {
  const out: HandleClaim[] = []
  for (const e of events) {
    const name = decodeHandleClaim(e.raw)
    if (name === null) continue
    out.push({
      author: e.author,
      subject: e.subject,
      name,
      blockNumber: e.blockNumber,
      logIndex: e.logIndex,
    })
  }
  return out
}

// ── the anti-squat gate (spec §2) ────────────────────────────────────────────

/** The chains the gate counts, FIXED rather than "whatever this operator
 *  configured" (owner 2026-08-06: "should be eth or base or robinhood").
 *
 *  The fixed list is the whole point. Every self-hosted site must compute the
 *  SAME owner for a name, and operators enable different chain sets — a gate
 *  reading the local config would resolve differently from one site to the
 *  next, which is the one promise this design cannot break. A constant list
 *  keeps that determinism while counting a creator who shipped anywhere real,
 *  which the authority chain alone did not: a creator who has only launched on
 *  Robinhood is exactly the shape this product produces. */
export const GATE_CHAIN_IDS = [8453, 1, 4663] as const

/**
 * Wallets that have deployed a basket on ANY of the gate chains.
 *
 * null = could not tell. Never "nobody has deployed": that reading would
 * silently drop every handle on the site.
 *
 * ⚠ A PARTIAL ANSWER IS NOT AN ANSWER. If any gate chain fails to answer we
 * return null rather than a smaller set, because a creator missing from the
 * reachable chains is indistinguishable from a creator whose chain is down —
 * and under earliest-wins, dropping a real claimant hands their name to
 * whoever asked second. Refusing to resolve is recoverable; a wrong owner is
 * not.
 */
async function deployersOnGateChains(): Promise<Set<string> | null> {
  const reads = await Promise.all(
    GATE_CHAIN_IDS.map(async (id) => {
      try {
        return await listBasketsForChain(id)
      } catch {
        return null
      }
    }),
  )
  if (reads.some((r) => r == null)) return null
  const shipped = new Set<string>()
  for (const baskets of reads) {
    for (const b of baskets ?? []) if (b.deployer) shipped.add(b.deployer.toLowerCase())
  }
  return shipped.size > 0 ? shipped : null
}

// ── the resolved registry ────────────────────────────────────────────────────

export type HandleRegistryResult =
  /** Resolved. The map is what every other site computes from the same logs.
   *  `shipped` rides along so the claim form can say "you need a basket on this
   *  network first" in words, instead of refusing a name for no visible reason. */
  | { status: 'ok'; map: HandleMap; shipped: ReadonlySet<string> }
  /** This build has no notes registry on the authority chain: no handles here. */
  | { status: 'off' }
  /** Could not resolve. NOT "free", NOT "nobody" — the answer is not known. */
  | { status: 'unknown'; why: 'unreadable' | 'incomplete' | 'no-baskets' }

/** The LAST resolved map, module-level — a SYNC lookup for link BUILDERS
 *  (owner 2026-08-16: "cant we ensure the urls for baskets/bundles uses the
 *  creator url so its much shorter?"). Best-effort by design: before the
 *  first resolve, builders fall back to the address form, which always
 *  works — a link is display sugar, never a correctness dependency. */
let lastMap: HandleMap | null = null

/** The claimed display name for an address from the last resolved registry,
 *  or null (not resolved yet / unnamed). Sync, zero-cost, never fetches. */
export function handleForAddressCached(address: string | null | undefined): string | null {
  if (!lastMap || !address) return null
  return lastMap.byAddress.get(address.toLowerCase())?.display ?? null
}

/** Read the claims, apply the gate, resolve. The only chain-touching entry
 *  point; everything above it is pure and tested without a chain. */
export async function resolveHandleRegistry(): Promise<HandleRegistryResult> {
  const registry = handleRegistryAddress()
  if (!registry) return { status: 'off' }
  let client: PublicClient
  try {
    client = clientFor(HANDLE_AUTHORITY_CHAIN_ID)
  } catch {
    return { status: 'off' } // the authority chain is not configured in this build
  }

  const [read, shipped] = await Promise.all([
    fetchHandleClaims(client, registry, HANDLE_AUTHORITY_CHAIN_ID),
    deployersOnGateChains(),
  ])
  if (read === null) return { status: 'unknown', why: 'unreadable' }
  if (!read.complete) return { status: 'unknown', why: 'incomplete' }
  if (shipped === null) return { status: 'unknown', why: 'no-baskets' }

  const map = resolveHandles(claimsFromNotes(read.events), (a) => shipped.has(a))
  lastMap = map
  return { status: 'ok', map, shipped }
}

// ── lookups ──────────────────────────────────────────────────────────────────

export type HandleLookup =
  | { status: 'found'; owner: HandleOwner }
  /** Resolved, and nobody holds it: never claimed, or retired (spec §5). */
  | { status: 'none' }
  /** Resolved: held once, retired by a rename, and reserved for that wallet. */
  | { status: 'retired' }
  /** Not resolved. A page must still work by address when this comes back. */
  | { status: 'unknown' }

/** Name → the creator's address. */
export async function addressFor(handle: string): Promise<HandleLookup> {
  const result = await resolveHandleRegistry()
  if (result.status === 'off') return { status: 'none' }
  if (result.status === 'unknown') return { status: 'unknown' }
  return lookupHandle(result.map, handle)
}

/** The same lookup against an already-resolved map (no second read). */
export function lookupHandle(map: HandleMap, handle: string): HandleLookup {
  const owner = addressForIn(map, handle)
  if (owner) return { status: 'found', owner }
  const normalized = normalizeHandle(handle)
  if (normalized && map.retired.has(normalized.normalized)) return { status: 'retired' }
  return { status: 'none' }
}

/** Address → their current name, for links and cards that prefer the handle. */
export async function handleFor(address: string): Promise<HandleLookup> {
  const result = await resolveHandleRegistry()
  if (result.status === 'off') return { status: 'none' }
  if (result.status === 'unknown') return { status: 'unknown' }
  const owner = handleForIn(result.map, address)
  return owner ? { status: 'found', owner } : { status: 'none' }
}

/** Checksummed form of a resolved owner (the map keys in lowercase). */
export function ownerAddress(owner: HandleOwner): Address {
  return getAddress(owner.address)
}

/** The path a creator page lives at: the handle when there is one, the address
 *  otherwise. The address form ALWAYS works and every existing link keeps
 *  resolving, so this is a preference, never a migration. */
export function creatorPath(address: string, handle?: HandleOwner | null): string {
  if (handle) return `/creator/${handle.display}`
  return `/creator/${isAddress(address, { strict: false }) ? getAddress(address) : address}`
}

/** The transaction a claim IS: one `setNote` about yourself on the authority
 *  chain. Returned as data so the button stays thin and the args are testable. */
export function claimHandleCall(
  typed: string,
  claimant: Address,
): {
  address: Address
  abi: typeof notesRegistryAbi
  functionName: 'setNote'
  args: readonly [Address, `0x${string}`, string]
  chainId: number
} | null {
  const registry = handleRegistryAddress()
  const note = encodeHandleClaim(typed)
  if (!registry || note === null) return null
  return {
    address: registry,
    abi: notesRegistryAbi,
    functionName: 'setNote',
    // subject == author: you can only ever claim for yourself, which is what
    // makes impersonation structurally impossible rather than policed.
    args: [claimant, HANDLE_KIND, note],
    chainId: HANDLE_AUTHORITY_CHAIN_ID,
  }
}
