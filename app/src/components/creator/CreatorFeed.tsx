import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePublicClient, useWriteContract } from 'wagmi'
import type { Address } from 'viem'
import { chainCfg } from '../../lib/chain/chains'
import { clientFor } from '../../lib/chain/rpc'
import { NOTE_KINDS, notesRegistryAbi } from '../../lib/spectrum/profile-registry'
import {
  MAX_POST_CHARS,
  encodePostDeleteJson,
  encodePostJson,
  useCreatorPosts,
  type CreatorPost,
} from '../../lib/spectrum/notes-social'
import { fetchBlockClock, formatAge } from '../../lib/spectrum/holder-age'
import { useQuery } from '@tanstack/react-query'

// ─────────────────────────────────────────────────────────────────────────────
// The creator feed (owner 2026-07-29): a creator's public posts, straight from
// the chain — each post one setNote tx (kind "post", subject == the author),
// history append-only, deletes are tombstones. The composer renders only for
// the page owner (or their declared delegate wallet — the "via delegate" chip
// keeps authorship honest). No backend, no moderation queue; the reader caps
// length and renders plain text only.
// ─────────────────────────────────────────────────────────────────────────────

/** The link LABEL is the host only (audit M5): showing a truncated full path
 *  turned `https://app.uniswap.org.claim.evil.com/…` into "app.uniswap.org.claim…"
 *  and `https://x.com@evil.com/` into "x.com@evil.com" — a phishing surface
 *  under a "posted by the creator" heading. Full URL stays in the title. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function PostBody({ post }: { post: CreatorPost }) {
  return (
    <>
      <p className="whitespace-pre-line text-sm leading-relaxed text-ink-dim">{post.text}</p>
      {post.url && (
        <a
          href={post.url}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          title={post.url}
          className="mt-1.5 inline-block max-w-full truncate font-mono text-[11px] text-cyan hover:underline"
        >
          {hostOf(post.url)} ↗
        </a>
      )}
    </>
  )
}

export function CreatorFeed({
  creator,
  chainId,
  /** The viewer may compose: they ARE the creator, or its declared delegate. */
  canPost,
  /** The profile's declared delegate (posts by it render with a chip). */
  delegate,
}: {
  creator: Address
  chainId: number
  canPost: boolean
  delegate?: string | null
}) {
  const registry = (() => {
    try {
      return chainCfg(chainId).notesRegistry
    } catch {
      return null
    }
  })()
  const posts = useCreatorPosts(chainId, creator, delegate)
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'post' | string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  // One block clock per feed → "3d ago" chips without per-post reads.
  const clock = useQuery({
    queryKey: ['spectrum', 'block-clock', chainId],
    queryFn: () => fetchBlockClock(clientFor(chainId)),
    staleTime: 60_000,
    enabled: (posts.data?.length ?? 0) > 0,
  })

  if (!registry) return null
  // Nothing to show, nothing to say — but a FAILED read is not an empty feed,
  // and silently deleting the whole section tells a visitor this creator never
  // posts. On an error the section stays and says it could not read.
  if (!canPost && !posts.isError && (posts.data?.length ?? 0) === 0) return null

  async function write(note: string, busyKey: 'post' | string) {
    if (!publicClient || busy) return
    setBusy(busyKey)
    setError(null)
    try {
      const h = await writeContractAsync({
        address: registry as Address,
        abi: notesRegistryAbi,
        functionName: 'setNote',
        args: [creator, NOTE_KINDS.post, note],
        chainId,
      })
      await publicClient.waitForTransactionReceipt({ hash: h })
      if (busyKey === 'post') setDraft('')
      void queryClient.invalidateQueries({ queryKey: ['spectrum', 'posts', chainId] })
    } catch (e) {
      setError(e instanceof Error ? (e.message.split('\n')[0] ?? 'Could not publish.') : 'Could not publish.')
    } finally {
      setBusy(null)
    }
  }

  const shown = expanded ? posts.data ?? [] : (posts.data ?? []).slice(0, 5)

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between border-b border-white/10 pb-3">
        <h2 className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-ink">Updates</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          posted on-chain by the creator
        </span>
      </div>

      {canPost && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, MAX_POST_CHARS))}
            rows={3}
            placeholder="Share a call, a rotation, a why — it publishes on-chain, on every Spectrum site."
            className="w-full resize-y rounded-lg border border-white/10 bg-black/25 px-3.5 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-cyan/50 focus:outline-none"
          />
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="font-num text-[10px] tabular-nums text-ink-faint">
              {draft.length}/{MAX_POST_CHARS}
            </span>
            <button
              type="button"
              disabled={!draft.trim() || busy !== null}
              onClick={() => write(encodePostJson(draft), 'post')}
              className="press rounded-lg bg-cyan px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'post' ? 'Publishing…' : 'Publish'}
            </button>
          </div>
          {error && <p className="mt-2 font-mono text-[11px] text-magenta">{error}</p>}
        </div>
      )}

      {posts.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl border border-white/5 bg-white/[0.02]" />
          ))}
        </div>
      ) : shown.length > 0 ? (
        <div className="space-y-2">
          {shown.map((p) => (
            <article key={p.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  {clock.data ? `${formatAge(clock.data.ageOf(p.blockNumber))} ago` : `block ${p.blockNumber}`}
                  {p.viaDelegate && <span className="ml-2 rounded border border-white/15 px-1.5 py-px text-[9px] text-ink-faint">via delegate</span>}
                </span>
                {canPost && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => write(encodePostDeleteJson(p.id), p.id)}
                    className="press font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-magenta disabled:opacity-50"
                  >
                    {busy === p.id ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>
              <div className="mt-1.5">
                <PostBody post={p} />
              </div>
            </article>
          ))}
        </div>
      ) : posts.isError ? (
        // "Could not read" must never render as "there is nothing": before this
        // branch a failed read fell through and told a creator their own feed was
        // empty. Checked after the list so a background failure over cached posts
        // still shows the posts we have.
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-4 text-center">
          <p className="font-mono text-xs leading-relaxed text-ink-faint">
            We could not read the updates just now. This is a read failure, not an empty feed.
          </p>
          <button
            type="button"
            onClick={() => void posts.refetch()}
            className="press mt-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan"
          >
            Try again
          </button>
        </div>
      ) : (
        canPost && (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-4 text-center font-mono text-xs text-ink-faint">
            Nothing posted yet. Your first update publishes to every Spectrum site.
          </p>
        )
      )}

      {(posts.data?.length ?? 0) > 5 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="press w-full rounded-lg border border-white/10 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint hover:border-white/25 hover:text-ink"
        >
          Show all {posts.data!.length} updates
        </button>
      )}
    </section>
  )
}
