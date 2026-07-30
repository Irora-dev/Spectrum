import { useQuery } from '@tanstack/react-query'
import { isAddress, getAddress, type Address, type PublicClient } from 'viem'
import { chainCfg } from '../chain/chains'
import { clientFor } from '../chain/rpc'
import { cacheGet, cacheSet } from './persist-cache'
import { NOTE_KINDS, fetchNotes, type NoteEvent } from './profile-registry'

// ─────────────────────────────────────────────────────────────────────────────
// The social layer over SpectrumNotes — envelopes, cached readers and hooks
// for the kinds beyond profile/thesis: reactions (the holder emoji wall),
// posts (creator feed), update (version notes), follow, announce. Everything
// here is read-on-chain / write-by-signing: one setNote tx per action, no
// backend, reader-side policy only (owner 2026-07-29).
//
// Free text from arbitrary wallets is a griefing surface, so the basket wall
// takes NO text: holders sign ONE emoji from the approved set below, and the
// wall renders it next to facts the chain proves (how long they've held, how
// much). Anything outside the set never renders (owner call, same recording).
// ─────────────────────────────────────────────────────────────────────────────

export const APPROVED_REACTIONS = ['🚀', '💎', '🔥', '📈', '🧺', '🤝', '⚡', '🫡'] as const
export type ApprovedReaction = (typeof APPROVED_REACTIONS)[number]

// ── incremental notes cache (append-only log ⇒ scan only NEW blocks) ─────────

interface NotesCache {
  upToBlock: string
  events: { author: Address; subject: Address; raw: string; blockNumber: string; logIndex: number }[]
}

function isNotesCache(v: unknown): v is NotesCache {
  if (!v || typeof v !== 'object') return false
  const c = v as NotesCache
  return typeof c.upToBlock === 'string' && Array.isArray(c.events)
}

/** Bound the persisted blob — a chatty subject must not blow localStorage.
 *  Audit H1: an EVENT cap silently deleted live notes (spam 500 rows from
 *  throwaway wallets and every returning visitor's real wall went blank,
 *  because the dropped rows sat below an advanced watermark and were never
 *  re-scanned). The cap is now on DISTINCT AUTHORS *after* collapsing to each
 *  author's latest note — the only rows that can ever render — and dropping
 *  anything at all REWINDS the watermark so history stays re-scannable. */
const MAX_CACHED_AUTHORS = 400

/**
 * fetchNotes with an incremental persisted cache: NoteSet is append-only, so a
 * repeat visit scans only blocks after the cached tip. `null` (couldn't read
 * AND nothing cached) stays distinct from "none".
 *
 * Two honesty rules the audit forced (H1/H2/H3):
 *   • the watermark is the block the scan ACTUALLY covered (fetchNotes reports
 *     it, held back by the reorg margin) — never a re-read chain tip, which
 *     recorded unqueried blocks and swallowed clears forever;
 *   • a PARTIAL read (range-capped RPC) is never cached as complete, and a
 *     truncated cache rewinds its watermark to the oldest row it kept.
 */
export async function fetchNotesCached(
  client: PublicClient,
  registry: Address,
  filter: { author?: Address; subject?: Address; kind: `0x${string}` },
  cacheKey: string,
  /** Floor for the scan (audit N-1): bounds an author-less read shape whose
   *  result set is otherwise unlimited. The incremental cache watermark still
   *  wins when it is HIGHER, so this never re-reads what we already have. */
  minFromBlock: bigint = 0n,
): Promise<NoteEvent[] | null> {
  const meta = await fetchNotesCachedMeta(client, registry, filter, cacheKey, minFromBlock)
  return meta === null ? null : meta.events
}

/** fetchNotesCached, WITH the completeness flag (audit): `partial` is true when
 *  the view may be missing notes — a range-capped read whose older blocks were
 *  never seen, or a failed fresh read served from the stale cache. Counts built
 *  on a partial view must say "N+", never pose as totals. */
export async function fetchNotesCachedMeta(
  client: PublicClient,
  registry: Address,
  filter: { author?: Address; subject?: Address; kind: `0x${string}` },
  cacheKey: string,
  minFromBlock: bigint = 0n,
): Promise<{ events: NoteEvent[]; partial: boolean } | null> {
  // The key carries the registry AND every pinned topic (audit M3): re-pointing
  // notesRegistry, or two authors over one subject, previously shared a
  // watermark and hid each other's history.
  const key = `notes:v2:${registry.toLowerCase()}:${cacheKey}`
  const cachedRaw = cacheGet<NotesCache>(key)
  const cached = cachedRaw && isNotesCache(cachedRaw) ? cachedRaw : null
  // the higher of the two wins: the cache watermark avoids re-reading, the
  // window floor bounds a first (uncached) read
  const from = cached
    ? maxBig(BigInt(cached.upToBlock) + 1n, minFromBlock)
    : minFromBlock
  const read = await fetchNotes(client, registry, filter, from)
  const prior: NoteEvent[] = (cached?.events ?? []).map((e) => ({
    ...e,
    author: e.author,
    subject: e.subject,
    blockNumber: BigInt(e.blockNumber),
  }))
  if (read === null) return cached ? { events: prior, partial: true } : null
  const all = [...prior, ...read.events]
  // A partial (range-capped) read means older notes were never seen — serve it,
  // never persist it as the whole truth.
  if (read.partial) return { events: all, partial: true }
  // Collapse to per-author latest, then bound by author count. Rows that can
  // never render (superseded by the same author) are dropped for free.
  const survivors = [...latestPerAuthor(all).values()].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber),
  )
  const kept = survivors.length > MAX_CACHED_AUTHORS ? survivors.slice(-MAX_CACHED_AUTHORS) : survivors
  // Collapsing superseded rows is loss-free by construction: each author's
  // LATEST survives, and a clear (raw === '') persists correctly as ABSENCE —
  // so a cleared note can never resurrect from behind the watermark. Only the
  // author-CAP truncation loses real state, and that rewinds the watermark to
  // just before the oldest kept row so the gap is re-scanned, never lost.
  const truncated = kept.length < survivors.length
  const watermark = truncated ? (kept[0].blockNumber > 0n ? kept[0].blockNumber - 1n : 0n) : read.upToBlock
  cacheSet(
    key,
    {
      upToBlock: watermark.toString(),
      events: kept.map((e) => ({ ...e, blockNumber: e.blockNumber.toString() })),
    } satisfies NotesCache,
    0,
  )
  return { events: all, partial: false }
}

/** Latest surviving note per author (the contract's replace semantics): later
 *  events win, "" clears. Events must be oldest→newest (fetchNotes order). */
export function latestPerAuthor(events: NoteEvent[]): Map<string, NoteEvent> {
  const m = new Map<string, NoteEvent>()
  for (const e of events) {
    if (e.raw === '') m.delete(e.author.toLowerCase())
    else m.set(e.author.toLowerCase(), e)
  }
  return m
}

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ── reactions — the holder emoji wall ────────────────────────────────────────

export interface ReactionJson {
  v: 1
  e: string
}

export function encodeReactionJson(emoji: ApprovedReaction): string {
  return JSON.stringify({ v: 1, e: emoji } satisfies ReactionJson)
}

export interface BasketReaction {
  holder: Address
  emoji: ApprovedReaction
  blockNumber: bigint
}

/** Reactions are the one open-author read on a hot subject, so it is bounded:
 *  every reactor costs the wall a balanceOf, and the holder filter can only run
 *  AFTER those reads (audit H4 — 10k spam signatures meant ~80 batched eth_calls
 *  per visitor every 30s). Newest-first, so a spam wave can bury older
 *  signatures but can never make the read unbounded. */
export const MAX_WALL_REACTORS = 200

/** How far back the reaction wall reads. Bounds the DOWNLOAD (audit N-1), which
 *  no author pin or render-side holder check can do. Generous enough that a real
 *  basket's wall looks complete, small enough that a spam swarm can't turn one
 *  page load into an unbounded fetch. */
export const REACTION_WINDOW_BLOCKS = 2_000_000n

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b)

async function reactionWindowFrom(client: PublicClient): Promise<bigint> {
  try {
    const head = await client.getBlockNumber()
    return head > REACTION_WINDOW_BLOCKS ? head - REACTION_WINDOW_BLOCKS : 0n
  } catch {
    return 0n // a failed head read must not silently narrow the window
  }
}

/** Every current reaction on a basket — approved emoji only, latest per
 *  author, newest-first and capped; the HOLDER checks (live balance,
 *  held-since) happen in the UI layer where they batch with the page's reads.
 *
 *  BOUNDED FETCH (contracts audit N-1): this is the one documented read shape
 *  that pins NO author — "any author about this basket" — so its result set
 *  grows with the number of distinct reactors, without limit. The `kind` topic
 *  narrows by SHAPE, not by volume, and the holder checks bound what we RENDER,
 *  not what we DOWNLOAD: a spam swarm costs the full download either way
 *  (measured ~147k gas per 16KB note, so 10k notes ≈ 160MB per reader). A
 *  block-range window turns that into a bounded read — reactions are a live
 *  social signal, so only recent ones matter, and the cache still carries
 *  older ones forward for anyone who already fetched them. */
export async function fetchBasketReactions(
  client: PublicClient,
  registry: Address,
  chainId: number,
  basket: Address,
): Promise<BasketReaction[] | null> {
  const events = await fetchNotesCached(
    client,
    registry,
    { subject: basket, kind: NOTE_KINDS.react },
    `react:${chainId}:${basket.toLowerCase()}`,
    await reactionWindowFrom(client),
  )
  if (events === null) return null
  const out: BasketReaction[] = []
  for (const e of latestPerAuthor(events).values()) {
    const j = parseJson(e.raw) as ReactionJson | null
    if (!j || j.v !== 1 || typeof j.e !== 'string') continue
    // The approved set IS the content policy: anything else never renders.
    const emoji = APPROVED_REACTIONS.find((a) => a === j.e)
    if (!emoji) continue
    out.push({ holder: e.author, emoji, blockNumber: e.blockNumber })
  }
  return out.sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, MAX_WALL_REACTORS)
}

// ── posts — the creator feed ─────────────────────────────────────────────────

export interface PostJson {
  v: 1
  text?: string
  url?: string
  /** Tombstone: hides the post whose id matches (id = `block:logIndex`). */
  del?: string
}

/** Render cap — the contract caps bytes, the READER caps what a feed shows. */
export const MAX_POST_CHARS = 2_000

export function encodePostJson(text: string, url?: string): string {
  const out: PostJson = { v: 1, text: text.trim() }
  if (url?.trim()) out.url = url.trim()
  return JSON.stringify(out)
}

export function encodePostDeleteJson(id: string): string {
  return JSON.stringify({ v: 1, del: id } satisfies PostJson)
}

export interface CreatorPost {
  id: string
  author: Address
  /** Set when the post was written by the profile's declared delegate. */
  viaDelegate?: boolean
  text: string
  url: string | null
  blockNumber: bigint
}

/** A creator's feed: every post event (append semantics — history is the
 *  feature), minus tombstoned ids, newest first. Optionally merges posts
 *  written by the profile's declared DELEGATE key (subject == creator either
 *  way, so the feed stays one topic shape per author). */
export async function fetchCreatorPosts(
  client: PublicClient,
  registry: Address,
  chainId: number,
  creator: Address,
  delegate?: Address | null,
): Promise<CreatorPost[] | null> {
  const authors: { author: Address; viaDelegate: boolean }[] = [{ author: creator, viaDelegate: false }]
  if (delegate && isAddress(delegate, { strict: false }) && delegate.toLowerCase() !== creator.toLowerCase()) {
    authors.push({ author: getAddress(delegate), viaDelegate: true })
  }
  const batches = await Promise.all(
    authors.map((a) =>
      fetchNotesCached(
        client,
        registry,
        { author: a.author, subject: creator, kind: NOTE_KINDS.post },
        `post:${chainId}:${creator.toLowerCase()}:${a.author.toLowerCase()}`,
      ).then((events) => ({ ...a, events })),
    ),
  )
  if (batches.every((b) => b.events === null)) return null
  // Tombstones are AUTHOR-SCOPED (audit M2): a flat delete set let a declared
  // delegate erase the creator's whole history — and let anyone pre-write
  // tombstones for a creator they hope to be delegated by. An author may only
  // retract their OWN posts; the creator revokes a bad delegate to undo the rest.
  const deleted = new Map<string, Set<string>>()
  const posts: CreatorPost[] = []
  for (const b of batches) {
    for (const e of b.events ?? []) {
      const j = parseJson(e.raw) as PostJson | null
      if (!j || j.v !== 1) continue
      const id = `${e.blockNumber}:${e.logIndex}`
      if (typeof j.del === 'string') {
        const who = b.author.toLowerCase()
        const set = deleted.get(who) ?? new Set<string>()
        set.add(j.del)
        deleted.set(who, set)
        continue
      }
      if (typeof j.text !== 'string' || !j.text.trim()) continue
      posts.push({
        id,
        author: b.author,
        viaDelegate: b.viaDelegate || undefined,
        text: j.text.slice(0, MAX_POST_CHARS),
        url: typeof j.url === 'string' && /^https:\/\//i.test(j.url) ? j.url : null,
        blockNumber: e.blockNumber,
      })
    }
  }
  return posts
    .filter((p) => !deleted.get(p.author.toLowerCase())?.has(p.id))
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
}

// ── version notes — deployer-authored release notes on a basket ──────────────

export interface UpdateNoteJson {
  v: 1
  text: string
}

export function encodeUpdateNoteJson(text: string): string {
  return JSON.stringify({ v: 1, text: text.trim() } satisfies UpdateNoteJson)
}

/** The deployer's release note for THIS basket version (latest wins). Trust
 *  gate = authorship: pass the basket's on-chain deployer as `author`. */
export async function fetchVersionNote(
  client: PublicClient,
  registry: Address,
  chainId: number,
  author: Address,
  basket: Address,
): Promise<{ text: string; blockNumber: bigint } | null> {
  const events = await fetchNotesCached(
    client,
    registry,
    { author, subject: basket, kind: NOTE_KINDS.update },
    `update:${chainId}:${basket.toLowerCase()}:${author.toLowerCase()}`, // author pinned in the key too (M3)
  )
  if (!events || events.length === 0) return null
  const last = latestPerAuthor(events).get(author.toLowerCase())
  if (!last) return null
  const j = parseJson(last.raw) as UpdateNoteJson | null
  if (!j || j.v !== 1 || typeof j.text !== 'string' || !j.text.trim()) return null
  return { text: j.text.slice(0, MAX_POST_CHARS), blockNumber: last.blockNumber }
}

// ── follows — the on-chain follow graph ──────────────────────────────────────

export function encodeFollowJson(): string {
  return JSON.stringify({ v: 1, on: true })
}

/** Wallets currently following a creator (latest per author, "" = unfollow).
 *  `partial` = the scan may have missed follows (range-capped/failed reads) —
 *  the count must render "N+", never as the total (audit). */
export async function fetchFollowers(
  client: PublicClient,
  registry: Address,
  chainId: number,
  creator: Address,
): Promise<{ list: Address[]; partial: boolean } | null> {
  const meta = await fetchNotesCachedMeta(
    client,
    registry,
    { subject: creator, kind: NOTE_KINDS.follow },
    `follow:${chainId}:${creator.toLowerCase()}`,
  )
  if (meta === null) return null
  const out: Address[] = []
  for (const e of latestPerAuthor(meta.events).values()) {
    const j = parseJson(e.raw) as { v?: number; on?: boolean } | null
    if (j?.v === 1 && j.on === true) out.push(e.author)
  }
  return { list: out, partial: meta.partial }
}

// ── bundles — a creator's PUBLISHED cross-chain allocations ──────────────────
// Before this, a bundle existed only as a URL: nothing listed a creator's
// bundles, and one lost link lost the bundle. Publishing it as a note makes it
// durable, listed on the creator's own page, portable to every Spectrum site,
// and editable — all for one signature and no backend.
//
// Keyed by a stable `slug`, so re-publishing the same slug EDITS in place
// (latest wins) rather than piling up duplicates; `del: true` retires one.

export interface BundleNoteJson {
  v: 1
  /** Stable per-creator id; re-publishing the same slug replaces it. */
  slug: string
  name?: string
  /** Legs as [chainId, address, weight] triples — compact on purpose (calldata). */
  legs?: [number, string, number][]
  /** Retire this slug. */
  del?: boolean
}

export interface PublishedBundle {
  slug: string
  name: string
  legs: { chainId: number; address: string; weight: number }[]
  blockNumber: bigint
}

/** Max legs mirrors the UI's own cap (a bento stays legible to ~6). */
export const MAX_BUNDLE_NOTE_LEGS = 6

export function encodeBundleNote(input: {
  slug: string
  name?: string
  legs: { chainId: number; address: string; weight: number }[]
}): string {
  const legs = input.legs
    .filter((l) => isAddress(l.address, { strict: false }) && l.chainId > 0 && l.weight > 0)
    .slice(0, MAX_BUNDLE_NOTE_LEGS)
    .map((l) => [l.chainId, getAddress(l.address), Math.round(l.weight)] as [number, string, number])
  const out: BundleNoteJson = { v: 1, slug: input.slug.slice(0, 32), legs }
  if (input.name?.trim()) out.name = input.name.trim().slice(0, 48)
  return JSON.stringify(out)
}

export function encodeBundleRetire(slug: string): string {
  return JSON.stringify({ v: 1, slug: slug.slice(0, 32), del: true } satisfies BundleNoteJson)
}

/** A creator's live published bundles, newest first. Latest note per slug wins;
 *  retired slugs drop out. */
export async function fetchCreatorBundles(
  client: PublicClient,
  registry: Address,
  chainId: number,
  creator: Address,
): Promise<PublishedBundle[] | null> {
  const events = await fetchNotesCached(
    client,
    registry,
    { author: creator, subject: creator, kind: NOTE_KINDS.bundle },
    `bundle:${chainId}:${creator.toLowerCase()}`,
  )
  if (events === null) return null
  // Oldest→newest, so a later note for the same slug simply overwrites.
  const bySlug = new Map<string, PublishedBundle | null>()
  for (const e of events) {
    const j = parseJson(e.raw) as BundleNoteJson | null
    if (!j || j.v !== 1 || typeof j.slug !== 'string' || !j.slug) continue
    if (j.del === true) {
      bySlug.set(j.slug, null)
      continue
    }
    const legs = (j.legs ?? [])
      .filter((t) => Array.isArray(t) && t.length === 3 && isAddress(String(t[1]), { strict: false }))
      .map((t) => ({ chainId: Number(t[0]), address: String(t[1]), weight: Number(t[2]) }))
      .filter((l) => l.chainId > 0 && l.weight > 0)
    if (legs.length === 0) continue
    bySlug.set(j.slug, {
      slug: j.slug,
      name: (j.name ?? '').slice(0, 48),
      legs,
      blockNumber: e.blockNumber,
    })
  }
  return [...bySlug.values()]
    .filter((b): b is PublishedBundle => b !== null)
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
}

/** A published bundle's OWN page — stable, shareable, no query soup. The legacy
 *  `?b=…` form still works (an unpublished bundle is only a link), but a
 *  published one gets a real URL. */
export function publishedBundleHref(b: PublishedBundle, by: string): string {
  return `/bundle/${by.toLowerCase()}/${b.slug}`
}

/** The legacy query form — still the canonical shape for an UNPUBLISHED bundle. */
export function bundleQueryHref(
  legs: { chainId: number; address: string; weight: number }[],
  by?: string | null,
  name?: string | null,
): string {
  const p = new URLSearchParams({ b: legs.map((l) => `${l.chainId}-${l.address}-${l.weight}`).join('_') })
  if (by) p.set('by', by)
  if (name) p.set('n', name)
  return `/bundle?${p.toString()}`
}

export interface DiscoveredBundle extends PublishedBundle {
  by: Address
}

/** EVERY published bundle on this chain — the discovery read (kind pinned, author
 *  open). Anyone can publish a bundle about themselves, so this list is
 *  inherently open; the QUALITY GATE is at the caller, which keeps only bundles
 *  whose legs resolve to real baskets and ranks them by combined TVL. A bundle
 *  of invented addresses therefore surfaces nowhere. */
export async function fetchAllBundles(
  client: PublicClient,
  registry: Address,
  chainId: number,
): Promise<DiscoveredBundle[] | null> {
  const events = await fetchNotesCached(
    client,
    registry,
    { kind: NOTE_KINDS.bundle },
    `bundles-all:${chainId}`,
  )
  if (events === null) return null
  // (author, slug) → latest wins; a retire removes it.
  const byKey = new Map<string, DiscoveredBundle | null>()
  for (const e of events) {
    // A bundle is a note about YOURSELF; anything else is not a creator's shelf.
    if (e.author.toLowerCase() !== e.subject.toLowerCase()) continue
    const j = parseJson(e.raw) as BundleNoteJson | null
    if (!j || j.v !== 1 || typeof j.slug !== 'string' || !j.slug) continue
    const key = `${e.author.toLowerCase()}:${j.slug}`
    if (j.del === true) {
      byKey.set(key, null)
      continue
    }
    const legs = (j.legs ?? [])
      .filter((t) => Array.isArray(t) && t.length === 3 && isAddress(String(t[1]), { strict: false }))
      .map((t) => ({ chainId: Number(t[0]), address: String(t[1]), weight: Number(t[2]) }))
      .filter((l) => l.chainId > 0 && l.weight > 0)
    if (legs.length < 2) continue // a "bundle" of one is just a basket
    byKey.set(key, {
      by: e.author,
      slug: j.slug,
      name: (j.name ?? '').slice(0, 48),
      legs,
      blockNumber: e.blockNumber,
    })
  }
  return [...byKey.values()]
    .filter((b): b is DiscoveredBundle => b !== null)
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
}

// ── announcements — the operator's zero-backend site banner ──────────────────

export interface AnnounceJson {
  v: 1
  text: string
  level?: 'info' | 'warn'
  /** Epoch seconds after which the banner self-expires. */
  until?: number
}

export function encodeAnnounceJson(input: { text: string; level?: 'info' | 'warn'; until?: number }): string {
  const out: AnnounceJson = { v: 1, text: input.text.trim() }
  if (input.level === 'warn') out.level = 'warn'
  if (input.until && Number.isFinite(input.until)) out.until = Math.floor(input.until)
  return JSON.stringify(out)
}

/** The site announcement: authored by THIS SITE's fee wallet about THIS
 *  chain's factory — both pinned, so no other wallet can put words in the
 *  operator's banner. Latest wins; "" or expiry clears. */
export async function fetchAnnouncement(
  client: PublicClient,
  registry: Address,
  chainId: number,
  feeWallet: Address,
  factory: Address,
): Promise<{ text: string; level: 'info' | 'warn' } | null> {
  const events = await fetchNotesCached(
    client,
    registry,
    { author: feeWallet, subject: factory, kind: NOTE_KINDS.announce },
    `announce:${chainId}:${feeWallet.toLowerCase()}:${factory.toLowerCase()}`, // subject pinned too (M3)
  )
  if (!events || events.length === 0) return null
  const last = latestPerAuthor(events).get(feeWallet.toLowerCase())
  if (!last) return null
  const j = parseJson(last.raw) as AnnounceJson | null
  if (!j || j.v !== 1 || typeof j.text !== 'string' || !j.text.trim()) return null
  if (j.until && Date.now() / 1000 > j.until) return null
  return { text: j.text.slice(0, 280), level: j.level === 'warn' ? 'warn' : 'info' }
}

// ── hooks ────────────────────────────────────────────────────────────────────

function registryFor(chainId: number): Address | null {
  try {
    return chainCfg(chainId).notesRegistry
  } catch {
    return null
  }
}

export function useBasketReactions(chainId: number, basket: string | undefined) {
  const registry = registryFor(chainId)
  return useQuery({
    queryKey: ['spectrum', 'reactions', chainId, basket?.toLowerCase()],
    queryFn: () => fetchBasketReactions(clientFor(chainId), registry!, chainId, basket as Address),
    enabled: !!registry && !!basket,
    staleTime: 30_000,
  })
}

export function useCreatorPosts(chainId: number, creator: string | undefined, delegate?: string | null) {
  const registry = registryFor(chainId)
  return useQuery({
    queryKey: ['spectrum', 'posts', chainId, creator?.toLowerCase(), delegate?.toLowerCase() ?? ''],
    queryFn: () =>
      fetchCreatorPosts(clientFor(chainId), registry!, chainId, creator as Address, delegate as Address | null),
    enabled: !!registry && !!creator,
    staleTime: 30_000,
  })
}

export function useVersionNote(chainId: number, deployer: string | null | undefined, basket: string | undefined) {
  const registry = registryFor(chainId)
  return useQuery({
    queryKey: ['spectrum', 'version-note', chainId, basket?.toLowerCase()],
    queryFn: () => fetchVersionNote(clientFor(chainId), registry!, chainId, deployer as Address, basket as Address),
    enabled: !!registry && !!deployer && !!basket,
    staleTime: 120_000,
  })
}

export function useFollowers(chainId: number, creator: string | undefined) {
  const registry = registryFor(chainId)
  return useQuery({
    queryKey: ['spectrum', 'followers', chainId, creator?.toLowerCase()],
    queryFn: () => fetchFollowers(clientFor(chainId), registry!, chainId, creator as Address),
    enabled: !!registry && !!creator,
    staleTime: 60_000,
  })
}

export function useCreatorBundles(chainId: number, creator: string | undefined) {
  const registry = registryFor(chainId)
  return useQuery({
    queryKey: ['spectrum', 'bundles', chainId, creator?.toLowerCase()],
    queryFn: () => fetchCreatorBundles(clientFor(chainId), registry!, chainId, creator as Address),
    enabled: !!registry && !!creator,
    staleTime: 60_000,
  })
}

export function useAllBundles(chainId: number) {
  const registry = registryFor(chainId)
  return useQuery({
    queryKey: ['spectrum', 'bundles-all', chainId],
    queryFn: () => fetchAllBundles(clientFor(chainId), registry!, chainId),
    enabled: !!registry,
    staleTime: 60_000,
  })
}

export function useAnnouncement(chainId: number, feeWallet: string | null | undefined) {
  const registry = registryFor(chainId)
  const factory = (() => {
    try {
      return chainCfg(chainId).factory
    } catch {
      return null
    }
  })()
  return useQuery({
    queryKey: ['spectrum', 'announce', chainId, feeWallet?.toLowerCase()],
    queryFn: () =>
      fetchAnnouncement(clientFor(chainId), registry!, chainId, feeWallet as Address, factory as Address),
    enabled: !!registry && !!feeWallet && !!factory,
    staleTime: 300_000,
  })
}
