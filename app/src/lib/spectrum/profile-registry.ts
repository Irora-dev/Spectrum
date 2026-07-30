import { getAddress, isAddress, keccak256, parseAbi, parseAbiItem, parseEventLogs, stringToHex, type Address, type PublicClient } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// On-chain notes — the chain as the metadata store (lab 2026-07-28; kind
// topic 2026-07-29, pre-first-deploy).
//
// SpectrumNotes (registry/SpectrumNotes.sol) is ownerless and event-only:
// `setNote(subject, kind, json)` emits `NoteSet(indexed author, indexed
// subject, indexed kind, json)` and stores nothing. One tx = metadata every
// deployment of the kit can see; the tx SENDER is the whole authentication
// story, and author/subject/kind all being indexed means every surface reads
// EXACTLY its own shape — spam outside the asked topics is never even fetched.
// The kinds (readers define all semantics; the contract stays dumb):
//
//   profile  — subject == author (a note about yourself)
//   thesis   — subject == basket, honored only when author == the basket's
//              on-chain deployer (the READER enforces this vs the factory)
//   react    — subject == basket, ANY author; the holder emoji wall (readers
//              verify live balance + holding age, and honor ONLY the approved
//              emoji set — free text never renders)
//   post     — subject == author; the creator's public feed
//   update   — subject == basket, deployer-authored version/release notes
//   tags     — subject == basket, deployer-declared sectors
//   follow   — subject == the followed creator
//   announce — subject == the factory, author == the site's fee wallet
//   bundle   — subject == author; a published cross-chain BUNDLE (its legs and
//              weights), keyed by a stable slug so re-publishing edits in place
//
// This module is the core read/write seam (kind constants, latest-note and
// all-notes reads, profile/thesis envelopes); the social feature envelopes +
// readers live in notes-social.ts.
//
// The registry address ships per-chain in deployments.json (`notesRegistry`,
// optional + overridable like every other address there). No address → these
// rungs silently don't exist; the signed-blob rungs still work.
// ─────────────────────────────────────────────────────────────────────────────

export const notesRegistryAbi = parseAbi([
  'function setNote(address subject, bytes32 kind, string note) external',
  'event NoteSet(address indexed author, address indexed subject, bytes32 indexed kind, string note)',
])
const noteSetEvent = parseAbiItem(
  'event NoteSet(address indexed author, address indexed subject, bytes32 indexed kind, string note)',
)

/** kind topic = keccak256 of a short lowercase tag. */
export function noteKind(tag: string): `0x${string}` {
  return keccak256(stringToHex(tag))
}

export const NOTE_KINDS = {
  profile: noteKind('profile'),
  thesis: noteKind('thesis'),
  react: noteKind('react'),
  post: noteKind('post'),
  update: noteKind('update'),
  tags: noteKind('tags'),
  follow: noteKind('follow'),
  announce: noteKind('announce'),
  bundle: noteKind('bundle'),
} as const
export type NoteKindTag = keyof typeof NOTE_KINDS

// ── The PROFILE note (subject == author) ─────────────────────────────────────

/** The on-chain profile JSON envelope (unsigned — the tx sender authenticates). */
export interface OnchainProfileJson {
  v: 1
  name?: string
  handle?: string
  avatarUrl?: string
  bannerUrl?: string
  bio?: string
  picks?: string[]
  pickNotes?: string[]
  /** Declared posting delegate (a hot wallet allowed to write kind:"post"
   *  notes AS this creator — readers chip its posts "via delegate"). */
  delegate?: string
}

/** Serialize profile-editor state for `setNote(self, …)` calldata. */
export function encodeProfileJson(input: {
  name?: string
  handle?: string
  avatarUrl?: string
  bannerUrl?: string
  bio?: string
  picks?: { address: string; note?: string | null }[]
  delegate?: string
}): string {
  const picks = (input.picks ?? []).filter((p) => isAddress(p.address, { strict: false }))
  const out: OnchainProfileJson = { v: 1 }
  if (input.name?.trim()) out.name = input.name.trim()
  if (input.handle?.trim()) out.handle = input.handle.trim()
  if (input.avatarUrl?.trim()) out.avatarUrl = input.avatarUrl.trim()
  if (input.bannerUrl?.trim()) out.bannerUrl = input.bannerUrl.trim()
  if (input.bio?.trim()) out.bio = input.bio.trim()
  if (picks.length > 0) {
    out.picks = picks.map((p) => getAddress(p.address))
    out.pickNotes = picks.map((p) => (p.note ?? '').trim())
  }
  if (input.delegate && isAddress(input.delegate, { strict: false })) out.delegate = getAddress(input.delegate)
  return JSON.stringify(out)
}

const str = (x: unknown) => x === undefined || typeof x === 'string'
const strArr = (x: unknown) => x === undefined || (Array.isArray(x) && x.every((s) => typeof s === 'string'))

function profileShapeCheck(v: unknown): OnchainProfileJson | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  if (b.v !== 1) return null
  if (!str(b.name) || !str(b.handle) || !str(b.avatarUrl) || !str(b.bannerUrl) || !str(b.bio)) return null
  if (!strArr(b.picks) || !strArr(b.pickNotes)) return null
  if (!str(b.delegate)) return null
  return v as OnchainProfileJson
}

/** Adapt profile JSON to the CreatorIdentityMeta shape the render path caps. */
export function onchainToIdentityMeta(
  json: OnchainProfileJson,
  creator: Address,
  blockNumber: bigint,
): {
  creator: Address
  handle: string
  name: string
  avatarUrl: string
  bannerUrl: string
  bio: string
  picks: Address[]
  pickNotes: string[]
  issuedAt: number
  delegate: Address | null
} {
  // Zip THEN filter (audit L4): filtering first and indexing pickNotes by the
  // FILTERED position against the UNFILTERED notes array made a surviving pick
  // inherit an invalid pick's note.
  const zipped = (json.picks ?? [])
    .map((a, i) => ({ address: a, note: json.pickNotes?.[i] ?? '' }))
    .filter((p) => isAddress(p.address, { strict: false }))
  const picks = zipped.map((p) => getAddress(p.address))
  return {
    creator: getAddress(creator),
    handle: json.handle ?? '',
    name: json.name ?? '',
    avatarUrl: json.avatarUrl ?? '',
    bannerUrl: json.bannerUrl ?? '',
    bio: json.bio ?? '',
    picks,
    pickNotes: zipped.map((p) => p.note),
    // No wall-clock on-chain — the block height is the honest recency ordinal.
    issuedAt: Number(blockNumber),
    delegate:
      json.delegate && isAddress(json.delegate, { strict: false }) ? getAddress(json.delegate) : null,
  }
}

// ── The BASKET THESIS note (subject == basket, author must be the deployer) ──

/** The on-chain basket-metadata JSON envelope — mirrors the signed
 *  CreatorMetadata prose fields (creator-metadata.ts); authorship replaces
 *  the signature. `supersedes` intentionally ABSENT: lineage stays on the
 *  SIGNED channel only (versioning.ts trusts EIP-712 blobs; widening what can
 *  assert lineage is a separate decision, not a lab side effect). */
export interface OnchainBasketMetaJson {
  v: 1
  tagline?: string
  thesis?: string
  sectors?: string[]
  timeHorizon?: string
  postUrl?: string
}

/** Serialize launch-flow thesis input for `setNote(basket, …)` calldata. */
export function encodeBasketMetaJson(input: {
  tagline?: string | null
  thesis?: string | null
  sectors?: string[] | null
  timeHorizon?: string | null
  postUrl?: string | null
}): string {
  const out: OnchainBasketMetaJson = { v: 1 }
  if (input.tagline?.trim()) out.tagline = input.tagline.trim()
  if (input.thesis?.trim()) out.thesis = input.thesis.trim()
  const sectors = (input.sectors ?? []).map((s) => s.trim()).filter(Boolean)
  if (sectors.length > 0) out.sectors = sectors
  if (input.timeHorizon?.trim()) out.timeHorizon = input.timeHorizon.trim()
  if (input.postUrl?.trim()) out.postUrl = input.postUrl.trim()
  return JSON.stringify(out)
}

export function basketMetaShapeCheck(v: unknown): OnchainBasketMetaJson | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  if (b.v !== 1) return null
  if (!str(b.tagline) || !str(b.thesis) || !str(b.timeHorizon) || !str(b.postUrl)) return null
  if (!strArr(b.sectors)) return null
  return v as OnchainBasketMetaJson
}

// ── The shared read path ─────────────────────────────────────────────────────

/** One parsed note event, oldest→newest ordering handled by the fetchers. */
export interface NoteEvent {
  author: Address
  subject: Address
  raw: string
  blockNumber: bigint
  logIndex: number
}

/** A read's result WITH its own honesty flags — the caller must know how far
 *  back the scan actually reached before it may cache the answer. */
export interface NotesRead {
  events: NoteEvent[]
  /** The block this scan genuinely covered up to (never a re-read tip — audit
   *  H2: a second getBlockNumber recorded blocks that were never queried, so a
   *  note landing in the gap was skipped FOREVER). */
  upToBlock: bigint
  /** True when the RPC refused the asked range and a narrower window answered:
   *  older notes are missing, so the result must NOT be cached as complete
   *  (audit H3 — a public RPC otherwise froze a ~28h view permanently). */
  partial: boolean
}

/** Reorg safety margin: never treat the very tip as settled history (audit M4).
 *  A note in the last few blocks is still READ (the scan runs to the tip) —
 *  only the CACHE watermark holds back, so a reorg re-scans instead of
 *  poisoning the blob forever. */
export const NOTES_CONFIRMATIONS = 6n

function isKindTopic(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) && BigInt(v) !== 0n
}

/**
 * Fetch ALL notes matching the pinned topics (any of author/subject may be
 * left undefined to widen — kind is always pinned so a surface only ever
 * downloads its own shape). Oldest→newest. The client is a parameter (not
 * clientFor) so the path tests against anvil. Range strategy: the asked range
 * first (indexed-topic queries are cheap for nodes), then bounded retreats for
 * public RPCs that cap ranges — each retreat CLAMPED to the asked fromBlock
 * and flagged `partial` when it actually narrowed the window.
 */
export async function fetchNotes(
  client: PublicClient,
  registry: Address,
  filter: { author?: Address; subject?: Address; kind: `0x${string}` },
  fromBlock: bigint = 0n,
): Promise<NotesRead | null> {
  // An undefined/garbage kind is a WILDCARD at the getLogs boundary (viem drops
  // the topic) — the exact opposite of this design's safety property, and a
  // renamed constant would be silently `undefined`. Refuse loudly instead.
  if (!isKindTopic(filter.kind)) throw new Error('fetchNotes: kind must be a non-zero 32-byte topic')
  // cacheTime 0: the default ~4s block-number cache serves a STALE toBlock right
  // after a publish tx confirms — the author's own fresh note wouldn't be in
  // the queried range (caught live by the anvil E2E; real RPCs behave the same).
  const latest = await client.getBlockNumber({ cacheTime: 0 })
  const clamp = (back: bigint) => (latest > back ? latest - back : 0n)
  const windows: [bigint, bigint][] = [
    [fromBlock, latest],
    [bigIntMax(fromBlock, clamp(500_000n)), latest],
    [bigIntMax(fromBlock, clamp(50_000n)), latest],
  ]
  for (const [from, to] of windows) {
    try {
      const logs = await client.getLogs({
        address: registry,
        event: noteSetEvent,
        args: { author: filter.author, subject: filter.subject, kind: filter.kind },
        fromBlock: from,
        toBlock: to,
      })
      const parsed = parseEventLogs({ abi: notesRegistryAbi, logs })
        .filter((l) => l.eventName === 'NoteSet')
        .sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex - b.logIndex) : Number(a.blockNumber - b.blockNumber)))
      return {
        events: parsed.map((l) => ({
          author: (l.args as { author: Address }).author,
          subject: (l.args as { subject: Address }).subject,
          raw: (l.args as { note: string }).note,
          blockNumber: l.blockNumber,
          logIndex: Number(l.logIndex),
        })),
        // EXACTLY the block queried, held back by the reorg margin.
        upToBlock: to > NOTES_CONFIRMATIONS ? to - NOTES_CONFIRMATIONS : 0n,
        partial: from > fromBlock,
      }
    } catch {
      /* range too wide for this RPC — retreat to the next (clamped) window */
    }
  }
  return null // every window refused — "could not read", distinct from "none"
}

function bigIntMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

/**
 * Latest note by `author` about `subject` for `kind`, or null. All three
 * topics pinned — this read can only ever return the author's own words.
 */
export async function fetchNote(
  client: PublicClient,
  registry: Address,
  author: Address,
  subject: Address,
  kind: `0x${string}`,
  fromBlock: bigint = 0n,
): Promise<{ raw: string; blockNumber: bigint } | null> {
  const read = await fetchNotes(client, registry, { author, subject, kind }, fromBlock)
  if (!read || read.events.length === 0) return null
  const last = read.events[read.events.length - 1]
  return last.raw ? { raw: last.raw, blockNumber: last.blockNumber } : null // "" = cleared
}

/** Latest PROFILE for a creator (subject == author), parsed + shape-checked. */
export async function fetchOnchainProfile(
  client: PublicClient,
  registry: Address,
  creator: Address,
  fromBlock: bigint = 0n,
): Promise<{ json: OnchainProfileJson; blockNumber: bigint } | null> {
  const hit = await fetchNote(client, registry, creator, creator, NOTE_KINDS.profile, fromBlock)
  if (!hit) return null
  let json: unknown
  try {
    json = JSON.parse(hit.raw)
  } catch {
    return null
  }
  const checked = profileShapeCheck(json)
  return checked ? { json: checked, blockNumber: hit.blockNumber } : null
}

/** Latest BASKET THESIS by `author` (pass the basket's on-chain deployer —
 *  authorship IS the trust gate), parsed + shape-checked. */
export async function fetchOnchainBasketMeta(
  client: PublicClient,
  registry: Address,
  author: Address,
  basket: Address,
  fromBlock: bigint = 0n,
): Promise<{ json: OnchainBasketMetaJson; blockNumber: bigint } | null> {
  const hit = await fetchNote(client, registry, author, basket, NOTE_KINDS.thesis, fromBlock)
  if (!hit) return null
  let json: unknown
  try {
    json = JSON.parse(hit.raw)
  } catch {
    return null
  }
  const checked = basketMetaShapeCheck(json)
  return checked ? { json: checked, blockNumber: hit.blockNumber } : null
}
