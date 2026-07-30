import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount, usePublicClient, useSignTypedData, useWriteContract } from 'wagmi'
import { isAddress, parseAbi, type Address } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import { encodeProfileJson, fetchOnchainProfile, NOTE_KINDS, onchainToIdentityMeta, notesRegistryAbi } from '../../lib/spectrum/profile-registry'
import {
  buildCreatorIdentity,
  clearLocalIdentity,
  hasPublishableIdentity,
  identityBlobJson,
  identityConventionPath,
  loadLocalIdentity,
  MAX_PICKS,
  saveLocalIdentity,
  signCreatorIdentity,
  type SignedCreatorIdentity,
} from '../../lib/spectrum/creator-identity'
import { useActiveChainId } from '../../lib/chain/active-chain'
import { chainCfg } from '../../lib/chain/chains'
import { clientFor } from '../../lib/chain/rpc'
import { AssetLogo } from '../AssetLogo'
import { WalletButton } from '../WalletButton'
import { WALLET_ENABLED } from '../../lib/config/features'
import { shortAddr } from '../../lib/spectrum/format'

// ─────────────────────────────────────────────────────────────────────────────
// Creator sign-up (lab 2026-07-28) — the /creators self-serve profile editor.
// Connect a wallet → fill a profile (name, @handle, avatar/banner, bio, the
// tokens you're bullish on) → SIGN it (EIP-712, creator-identity.ts) → the
// profile is live on /creator/<you> in this browser at once (localStorage rung),
// and the downloaded JSON is what the operator commits at
// app/metadata/creators/<chainId>/<address>.json to make it live for everyone.
// The FE owns no key and no DB; the signature is the whole trust story.
// ─────────────────────────────────────────────────────────────────────────────

const symbolAbi = parseAbi(['function symbol() view returns (string)'])

interface PickDraft {
  address: string
  note: string
  symbol: string | null // resolved live; null = unresolved/pending
}

const field =
  'w-full rounded-lg border border-white/12 bg-black/30 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none'
const label = 'font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint'

function draftFromExisting(blob: SignedCreatorIdentity | null): {
  name: string
  handle: string
  avatarUrl: string
  bannerUrl: string
  bio: string
  picks: PickDraft[]
  delegate: string
} {
  const m = blob?.metadata
  return {
    name: m?.name ?? '',
    handle: m?.handle ?? '',
    avatarUrl: m?.avatarUrl ?? '',
    bannerUrl: m?.bannerUrl ?? '',
    bio: m?.bio ?? '',
    picks: (m?.picks ?? []).map((a, i) => ({ address: a, note: m?.pickNotes[i] ?? '', symbol: null })),
    delegate: m?.delegate ?? '',
  }
}

export function CreatorSignup() {
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const chainId = useActiveChainId()
  const cfg = chainCfg(chainId)
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId })
  const queryClient = useQueryClient()

  // On-chain registry configured → publishing is ONE tx, live for everyone on
  // every site instantly. No registry on this chain → signed-blob fallback
  // (localStorage + download for the operator to commit).
  const registry = cfg.notesRegistry
  const [draft, setDraft] = useState(() => draftFromExisting(null))
  const [pickInput, setPickInput] = useState('')
  const [pickError, setPickError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [signing, setSigning] = useState(false)
  const [published, setPublished] = useState<SignedCreatorIdentity | null>(null)
  const [publishedOnchain, setPublishedOnchain] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prefill: this browser's draft first, else the creator's LIVE on-chain
  // profile (so "edit" from another device starts from what everyone sees).
  useEffect(() => {
    if (!address) return
    const existing = loadLocalIdentity(chainId, address)
    setDraft(draftFromExisting(existing))
    setPublished(null)
    setPublishedOnchain(false)
    setError(null)
    if (!existing && registry && publicClient) {
      void fetchOnchainProfile(publicClient, registry, address)
        .then((hit) => {
          if (!hit) return
          const m = onchainToIdentityMeta(hit.json, address, hit.blockNumber)
          setDraft((d) =>
            d.name || d.bio || d.picks.length > 0
              ? d // the user already started typing — never clobber
              : {
                  name: m.name,
                  handle: m.handle,
                  avatarUrl: m.avatarUrl,
                  bannerUrl: m.bannerUrl,
                  bio: m.bio,
                  picks: m.picks.map((a, i) => ({ address: a, note: m.pickNotes[i] ?? '', symbol: null })),
                  delegate: m.delegate ?? '',
                },
          )
        })
        .catch(() => {})
    }
  }, [address, chainId, registry, publicClient])

  // Resolve pick symbols live (display-only; junk stays visible as an address).
  useEffect(() => {
    const unresolved = draft.picks.filter((p) => p.symbol === null && isAddress(p.address, { strict: false }))
    if (unresolved.length === 0) return
    let stale = false
    void Promise.all(
      unresolved.map(async (p) => {
        const symbol = await clientFor(chainId)
          .readContract({ address: p.address as Address, abi: symbolAbi, functionName: 'symbol' })
          .then((s) => (typeof s === 'string' && s ? s.slice(0, 16) : '?'))
          .catch(() => '?')
        return { address: p.address, symbol }
      }),
    ).then((resolved) => {
      if (stale) return
      setDraft((d) => ({
        ...d,
        picks: d.picks.map((p) => {
          const hit = resolved.find((r) => r.address === p.address)
          return hit ? { ...p, symbol: hit.symbol } : p
        }),
      }))
    })
    return () => {
      stale = true
    }
  }, [draft.picks, chainId])

  function addPick() {
    const a = pickInput.trim()
    if (!isAddress(a, { strict: false })) {
      setPickError('That is not a token address (0x…40 hex).')
      return
    }
    if (draft.picks.some((p) => p.address.toLowerCase() === a.toLowerCase())) {
      setPickError('Already in your list.')
      return
    }
    if (draft.picks.length >= MAX_PICKS) {
      setPickError(`Up to ${MAX_PICKS} tokens.`)
      return
    }
    setPickError(null)
    setPickInput('')
    setResolving(true)
    setDraft((d) => ({ ...d, picks: [...d.picks, { address: a, note: '', symbol: null }] }))
    setResolving(false)
  }

  const [avatarNote, setAvatarNote] = useState<string | null>(null)
  /** Downscale an uploaded image to a 64px raster data URI small enough to live
   *  INSIDE the on-chain profile note (the registry caps notes at 16KB; the
   *  sanitizer accepts raster data URIs to ~10KB). SVG never accepted. */
  async function inlineAvatar(file: File) {
    setAvatarNote(null)
    try {
      const bmp = await createImageBitmap(file)
      const side = 64
      const canvas = document.createElement('canvas')
      canvas.width = side
      canvas.height = side
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no canvas')
      // cover-crop to square
      const s = Math.min(bmp.width, bmp.height)
      ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, side, side)
      let uri = canvas.toDataURL('image/webp', 0.82)
      if (!uri.startsWith('data:image/webp')) uri = canvas.toDataURL('image/jpeg', 0.82)
      if (uri.length > 14_000) {
        uri = canvas.toDataURL('image/jpeg', 0.6)
      }
      if (uri.length > 14_000) {
        setAvatarNote('That image will not compress small enough to store on-chain — use a URL instead.')
        return
      }
      setDraft((d) => ({ ...d, avatarUrl: uri }))
      setAvatarNote(`Inlined at 64px (${(uri.length / 1024).toFixed(1)}KB) — travels inside your on-chain profile.`)
    } catch {
      setAvatarNote('Could not read that image.')
    }
  }

  async function publish() {
    if (!address) return
    const factory = cfg.factory
    if (!factory) {
      setError(`No factory is configured for ${cfg.name} — a profile signs against this site's deployment.`)
      return
    }
    const meta = buildCreatorIdentity(
      {
        name: draft.name,
        handle: draft.handle,
        avatarUrl: draft.avatarUrl,
        bannerUrl: draft.bannerUrl,
        bio: draft.bio,
        picks: draft.picks.map((p) => ({ address: p.address, note: p.note })),
      },
      address,
      Math.floor(Date.now() / 1000),
    )
    if (!hasPublishableIdentity(meta)) {
      setError('Add at least one thing — a name, a bio, or a token pick.')
      return
    }
    setSigning(true)
    setError(null)
    try {
      if (registry && publicClient) {
        // ── ON-CHAIN publish: one tx, live for everyone on every site ──
        if (walletChainId !== chainId) {
          setError(`Switch your wallet to ${cfg.name} to publish (the registry lives there).`)
          return
        }
        // Encode from the CAPPED meta, not the raw draft (audit L5) — the
        // signed path already applied the caps, and the URL fields have no
        // maxLength, so a pasted data-URI could sail past them.
        const json = encodeProfileJson({
          name: meta.name,
          handle: meta.handle,
          avatarUrl: meta.avatarUrl,
          bannerUrl: meta.bannerUrl,
          bio: meta.bio,
          picks: meta.picks.map((a, i) => ({ address: a, note: meta.pickNotes[i] ?? '' })),
          delegate: draft.delegate, // posting key only — validated in the encoder
        })
        // Pre-check the contract's byte cap so an oversized note fails HERE
        // with a readable reason instead of as an opaque revert after gas.
        const noteBytes = new TextEncoder().encode(json).length
        if (noteBytes > 16_384) {
          setError(
            `This profile is ${(noteBytes / 1024).toFixed(1)}KB — the on-chain limit is 16KB. Shorten the bio or use image URLs instead of pasted image data.`,
          )
          return
        }
        const h = await writeContractAsync({
          address: registry,
          abi: notesRegistryAbi,
          functionName: 'setNote',
          args: [address, NOTE_KINDS.profile, json], // a profile is a note about yourself
          chainId,
        })
        await publicClient.waitForTransactionReceipt({ hash: h })
        clearLocalIdentity(chainId, address) // the chain is now the source of truth
        setPublishedOnchain(true)
        setPublished(null)
      } else {
        // ── fallback: signed blob (this browser now; operator commits for all) ──
        const blob = await signCreatorIdentity({
          meta,
          signer: address,
          chainId,
          factory,
          signTypedDataAsync: (args) => signTypedDataAsync(args as never),
        })
        saveLocalIdentity(chainId, address, blob)
        setPublished(blob)
      }
      // The creator page reads this query — refresh it so /creator/<me> is live now.
      void queryClient.invalidateQueries({ queryKey: ['spectrum', 'creatorIdentity', address.toLowerCase()] })
    } catch (e) {
      setError(e instanceof Error ? (e.message.split('\n')[0] ?? 'Publishing failed.') : 'Publishing failed.')
    } finally {
      setSigning(false)
    }
  }

  function downloadBlob(blob: SignedCreatorIdentity) {
    try {
      const url = URL.createObjectURL(new Blob([identityBlobJson(blob)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${blob.metadata.creator.toLowerCase()}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch {
      /* best-effort — localStorage already holds it */
    }
  }

  if (!WALLET_ENABLED) return null

  return (
    <div className="rounded-3xl card-surface backdrop-blur-md">
      <div className="p-6 sm:p-8">
        {!isConnected || !address ? (
          <div className="flex flex-col items-start gap-4">
            <p className="max-w-xl text-sm leading-relaxed text-ink-dim">
              Connect the wallet you launch baskets with. Your page lives at your address — the profile
              you sign here is what visitors see on it.
            </p>
            <WalletButton />
          </div>
        ) : publishedOnchain ? (
          <div className="space-y-4">
            <h3 className="font-display text-xl font-bold uppercase tracking-tight text-teal">Profile published on-chain — live everywhere</h3>
            <p className="max-w-2xl text-sm leading-relaxed text-ink-dim">
              Your profile now lives on {cfg.name} itself. Every visitor — on this site and on any other
              site running this kit — reads it straight from the chain. No account, no database, no
              operator step; update it any time with another transaction.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to={`/creator/${address}`}
                className="rounded-lg bg-cyan px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-black press hover:opacity-90"
              >
                View your page →
              </Link>
              <button
                type="button"
                onClick={() => setPublishedOnchain(false)}
                className="rounded-lg border border-white/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.14em] text-ink-faint press hover:text-ink"
              >
                Edit again
              </button>
            </div>
          </div>
        ) : published ? (
          <div className="space-y-4">
            <h3 className="font-display text-xl font-bold uppercase tracking-tight text-teal">Profile signed — you're live</h3>
            <p className="max-w-2xl text-sm leading-relaxed text-ink-dim">
              This browser shows it immediately. To make it visible to <span className="text-ink">everyone</span>,
              download the signed file and have the site operator commit it at{' '}
              <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-cyan">
                app/metadata/{identityConventionPath(chainId, address)}
              </code>{' '}
              — it ships in the next build. No account, no database; the signature is the proof it's yours.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to={`/creator/${address}`}
                className="rounded-lg bg-cyan px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-black press hover:opacity-90"
              >
                View your page →
              </Link>
              <button
                type="button"
                onClick={() => downloadBlob(published)}
                className="rounded-lg border border-white/15 px-4 py-2 font-mono text-xs uppercase tracking-[0.14em] text-ink-dim press hover:border-cyan/50 hover:text-cyan"
              >
                Download signed profile
              </button>
              <button
                type="button"
                onClick={() => setPublished(null)}
                className="rounded-lg border border-white/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.14em] text-ink-faint press hover:text-ink"
              >
                Edit again
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-ink-dim">
                Signing as <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-ink">{shortAddr(address)}</code>{' '}
                on {cfg.name} — <Link to={`/creator/${address}`} className="text-cyan hover:underline">your page</Link>
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className={label}>Display name</div>
                <input className={field} maxLength={48} placeholder="Basket Chef" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <div className={label}>X handle (shown, never linked)</div>
                <input className={field} maxLength={20} placeholder="@basketchef" value={draft.handle} onChange={(e) => setDraft({ ...draft, handle: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <div className={label}>Avatar (url, ipfs, or upload — stored on-chain)</div>
                <div className="flex items-center gap-2">
                  <input className={field} placeholder="https://…/avatar.png" value={draft.avatarUrl} onChange={(e) => setDraft({ ...draft, avatarUrl: e.target.value })} />
                  <label className="press shrink-0 cursor-pointer rounded-lg border border-white/15 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan">
                    Upload
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void inlineAvatar(f)
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
                {avatarNote && <p className="font-mono text-[10px] text-amber-300/90">{avatarNote}</p>}
              </div>
              <div className="space-y-1.5">
                <div className={label}>Banner image URL</div>
                <input className={field} placeholder="https://…/banner.png" value={draft.bannerUrl} onChange={(e) => setDraft({ ...draft, bannerUrl: e.target.value })} />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className={label}>Bio — who you are, what you build baskets around</div>
              <textarea
                className={`${field} min-h-[90px] resize-y`}
                maxLength={600}
                placeholder="I build narrative baskets around infra and AI. Long horizons, no leverage."
                value={draft.bio}
                onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
              />
            </div>

            {/* posting delegate — only meaningful for the on-chain profile
                (the signed-blob fallback has no post feed to delegate) */}
            {registry && (
              <div className="space-y-1.5">
                <div className={label}>Posting wallet (optional)</div>
                <input
                  className={field}
                  placeholder="0x… a hot wallet allowed to post updates as you"
                  value={draft.delegate}
                  onChange={(e) => setDraft({ ...draft, delegate: e.target.value })}
                />
                <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
                  Lets a day-to-day wallet publish feed updates while this identity stays on your cold
                  key. It can never edit this profile or your theses; its posts are labeled &ldquo;via
                  delegate&rdquo;. Clear the field and republish to revoke.
                </p>
                {draft.delegate.trim() && !isAddress(draft.delegate.trim(), { strict: false }) && (
                  <p className="font-mono text-[10px] text-magenta">Not a valid address.</p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className={label}>Tokens you're bullish on (up to {MAX_PICKS})</div>
              <div className="flex gap-2">
                <input
                  className={field}
                  placeholder="0x… token address"
                  value={pickInput}
                  onChange={(e) => setPickInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addPick())}
                />
                <button
                  type="button"
                  onClick={addPick}
                  disabled={resolving}
                  className="shrink-0 rounded-lg border border-white/15 px-4 font-mono text-xs uppercase tracking-[0.14em] text-ink-dim press hover:border-cyan/50 hover:text-cyan"
                >
                  Add
                </button>
              </div>
              {pickError && <p className="font-mono text-[11px] text-magenta">{pickError}</p>}
              {draft.picks.length > 0 && (
                <div className="space-y-2 pt-1">
                  {draft.picks.map((p, i) => (
                    <div key={p.address} className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                      <AssetLogo address={p.address} symbol={p.symbol ?? '?'} chainId={chainId} size={22} />
                      <span className="w-20 shrink-0 truncate font-mono text-xs font-semibold text-ink">
                        {p.symbol ?? shortAddr(p.address)}
                      </span>
                      <input
                        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-ink-dim placeholder:text-ink-faint focus:border-white/15 focus:outline-none"
                        maxLength={80}
                        placeholder="why? (optional one-liner)"
                        value={p.note}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            picks: d.picks.map((q, j) => (j === i ? { ...q, note: e.target.value } : q)),
                          }))
                        }
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${p.symbol ?? p.address}`}
                        onClick={() => setDraft((d) => ({ ...d, picks: d.picks.filter((_, j) => j !== i) }))}
                        className="shrink-0 font-mono text-xs text-ink-faint press hover:text-magenta"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="font-mono text-[11px] text-magenta">{error}</p>}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={publish}
                disabled={signing}
                className="rounded-lg bg-cyan px-5 py-2.5 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-black press hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                {signing ? 'Check your wallet…' : registry ? 'Publish on-chain' : 'Sign & publish profile'}
              </button>
              <span className="font-mono text-[10px] text-ink-faint">
                {registry
                  ? `One small transaction on ${cfg.name} — your profile lives on the chain itself, visible on every site.`
                  : 'A signature, not a transaction — free, nothing leaves your wallet.'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
