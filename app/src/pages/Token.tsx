import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import type { Address } from 'viem'
import { useBasketData, useCreatorMeta, useLineage, useAllBaskets, useNavHistory } from '../lib/spectrum/hooks'
import { computeReturns } from '../lib/spectrum/history'
import { MEASURABLE_TVL_FLOOR_USD } from '../lib/spectrum/leaderboard'
import type { BasketData, Holding } from '../lib/spectrum/basket-data'
import { useBasketFees } from '../lib/spectrum/use-basket-fees'
import { chainCfg } from '../lib/chain/chains'
import { BasketAvatar } from '../components/BasketAvatar'
import { AssetLogo } from '../components/AssetLogo'
import { ChainBadge } from '../components/ChainBadge'
import { BasketChart } from '../components/BasketChart'
import { BasketStats } from '../components/BasketStats'
import { HolderWall } from '../components/HolderWall'
import { useQueryClient } from '@tanstack/react-query'
import { usePublicClient, useWriteContract } from 'wagmi'
import { NOTE_KINDS, notesRegistryAbi } from '../lib/spectrum/profile-registry'
import { MAX_POST_CHARS, encodeUpdateNoteJson, useVersionNote } from '../lib/spectrum/notes-social'
import { DexSwapCard } from '../components/DexSwapCard'
import { PositionPnl } from '../components/PositionPnl'
import { FeePanel } from '../components/FeePanel'
import { VersionStrip } from '../components/VersionStrip'
import { VersionButton } from '../components/VersionButton'
import { LinkPredecessorButton } from '../components/LinkPredecessor'
import { clearVersionIntent, pendingVersionIntent } from '../lib/spectrum/version-intent'
import { BasketBento } from '../components/BasketBento'
import { BasketDiff } from '../components/BasketDiff'
import { MigrateModal } from '../components/MigrateModal'
import { LaunchBanner, ShareModal } from '../components/LaunchBanner'
import { FollowButton } from '../components/FollowButton'
import { WatchButton } from '../components/WatchButton'
import { CopyChip } from '../components/DocKit'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { readableInk, tokenVisual } from '../lib/spectrum/token-meta'
import { WarpIdentity } from '../components/WarpIdentity'
import { partnerAppUrl } from '../lib/config/operator'
import { formatNav, formatPct, formatPrice, formatUsdCompact, shortAddr } from '../lib/spectrum/format'
import { showName, showSymbol } from '../lib/spectrum/safe-copy'
import { useCountUp } from '../lib/motion'
import { resolveCreator } from '../lib/spectrum/creator'
import { DEPLOY_ENABLED, SWAP_ENABLED } from '../lib/config/features'
import { isLegacyLineage } from '../lib/spectrum/basket-data'
import { useAccount } from 'wagmi'
import { AddToWalletButton } from '../components/AddToWalletButton'
import { ListingPipeline } from '../components/ListingPipeline'
import { SeedBasketModal } from '../components/SeedBasketModal'
import { BasketJourneyCard } from '../components/launch/BasketJourneyCard'
import { markShared } from '../lib/spectrum/launch-journey'
import { ReshapeBasketModal } from '../components/reshape/ReshapeBasketModal'
import { JoinBundlePicker } from '../components/reshape/JoinBundlePicker'
import { ThesisEditor } from '../components/ThesisEditor'
import { PoweredByPrism } from '../components/PoweredByPrism'
import { BundleForge } from '../components/BundleForge'
import { resolveAsset, seedLaunchDraft } from '../components/launch/BasketBuilder'
import { flowHref } from '../lib/spectrum/flow-link'
import { seedPortfolioDraftFrom } from '../lib/spectrum/portfolio-handoff'
import { isRetryableDetection } from '../lib/pools'
import { setActiveChainId } from '../lib/chain/active-chain'
import { basketHref, chainFromSlug, resolveBasketRef } from '../lib/spectrum/short-url'
import { groupIntoTheses } from '../lib/spectrum/thesis'
import { isDemoLegAddress } from '../lib/spectrum/thesis-run-types'
import { thesisHref } from '../lib/spectrum/thesis-url'
import { DeadLegNotice } from '../components/DeadLegNotice'
import { ClaimHandle } from '../components/creator/ClaimHandle'
import { CreatorSetupModal } from '../components/creator/CreatorSetupModal'
import { markTickerDeployed } from '../lib/spectrum/launch-journey'
import { useHandleForAddress } from '../lib/spectrum/use-handles'
import { refLinkFor } from '../lib/spectrum/referral'
import { creatorPath } from '../lib/spectrum/handle-registry'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'
import { readBrandHex } from '../theme/brand-colors'

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="py-10">
      <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-ink-faint">
        {children}
      </div>
    </div>
  )
}

/* The header's Share button and the pill row's share icon both left on the
   owner's 2026-08-07 0903 note ("people have the URL anyway"). The ShareModal
   itself stays — the post-deploy launch banner still opens it. */

// Remix (lab 2026-07-28): seed the launch builder with THIS basket's recipe —
/** THE DISCOVERY→CREATION SEAM (owner ~17:0x): this basket's RECIPE becomes
 *  the visitor's own starting draft in the NEW flow — target weights (the
 *  creator's design), seeded through the same never-clobber path the homepage
 *  doors use, landing at /create where the flow's own stations take over.
 *  Distinct from Remix (the legacy /launch builder, page-gated): this is the
 *  funnel's live door. Hidden when the flow is off — never a dead door. */
function StartFromBasket({ holdings, chainId }: { holdings: Holding[]; chainId: number }) {
  const navigate = useNavigate()
  const { address, isConnected } = useAccount()
  if (!flowHref('keep') || holdings.length < 2) return null

  function start() {
    seedPortfolioDraftFrom(
      isConnected ? address : null,
      holdings.map((h) => ({ chainId, address: h.asset, symbol: h.symbol, weightPct: h.targetWeightPct })),
    )
    navigate('/create')
  }

  return (
    <button
      type="button"
      onClick={start}
      className="press inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
      title="Use this recipe as your own starting point"
    >
      Start from this basket
    </button>
  )
}

// constituents + target weights, re-resolved live (routes/depth re-checked at
// click time, not copied blind) — and hand off via the same seedLaunchDraft
// path the Composer uses. Name/ticker stay empty: a remix is the user's own
// basket, not a clone. Shown only when the launch page ships on this site.
function RemixButton({ holdings, chainId }: { holdings: Holding[]; chainId: number }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!pageEnabled(brand.pages, 'launch') || holdings.length < 2) return null

  async function remix() {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      const settled = await Promise.allSettled(
        holdings.map((h) => resolveAsset(h.asset, chainId, h.symbol)),
      )
      // "Could not CHECK" is a retry, never a verdict: silently remixing
      // without that leg ships a shorter recipe than the one on screen
      // (verify pass F5). Definitive no-pool rejections still drop the leg —
      // a since-dead pool has no place in a fresh remix.
      if (settled.some((r) => r.status === 'rejected' && isRetryableDetection(r.reason))) {
        setFailed(true)
        return
      }
      const assets = settled
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof resolveAsset>>> => r.status === 'fulfilled')
        .map((r) => r.value)
      const kept = holdings.filter((_, i) => settled[i].status === 'fulfilled')
      if (assets.length < 2) {
        setFailed(true)
        return
      }
      // Target weights (the creator's design, not live drift), re-normalized to
      // a 100 total over the legs that still resolve; the heaviest leg absorbs
      // the integer-rounding residual.
      const total = kept.reduce((s, h) => s + h.targetWeightPct, 0) || 1
      const weights = kept.map((h) => Math.max(1, Math.round((h.targetWeightPct / total) * 100)))
      const drift = 100 - weights.reduce((s, w) => s + w, 0)
      weights[weights.indexOf(Math.max(...weights))] += drift
      // The launch builder lives on the app's VIEWING network and restores the
      // draft keyed by that chain — remixing a basket moves the view to the
      // basket's chain first, or the seeded draft would never be found.
      setActiveChainId(chainId)
      seedLaunchDraft(chainId, { assets, weights })
      navigate('/create?studio=1')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={remix}
      disabled={busy}
      className={`inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] press ${
        failed ? 'text-magenta' : 'text-ink-dim hover:border-cyan/50 hover:text-cyan'
      } disabled:cursor-wait disabled:opacity-60`}
      title="Start your own basket from this recipe"
    >
      {busy ? 'Remixing…' : failed ? 'Remix unavailable' : 'Remix'}
      {!busy && !failed && (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3v6a3 3 0 0 0 3 3h6" />
          <path d="M18 3v14a4 4 0 0 1-4 4" />
          <path d="M15 9l3 3 3-3" />
        </svg>
      )}
    </button>
  )
}

// The deployer's own words about a version — an on-chain release note
// (kind "update", trust = authorship) rendered inside the WhatChanged fold;
// the composer shows only to the deployer. One setNote tx; latest wins.
function VersionNote({
  basket,
  chainId,
  deployer,
  isDeployer,
}: {
  basket: string
  chainId: number
  deployer: string | null
  isDeployer: boolean
}) {
  const registry = chainCfg(chainId).notesRegistry
  const note = useVersionNote(chainId, deployer, basket)
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!registry || !deployer) return null
  if (!note.data && !isDeployer) return null

  async function publish() {
    if (!publicClient || busy || !draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      const h = await writeContractAsync({
        address: registry as Address,
        abi: notesRegistryAbi,
        functionName: 'setNote',
        args: [basket as Address, NOTE_KINDS.update, encodeUpdateNoteJson(draft)],
        chainId,
      })
      await publicClient.waitForTransactionReceipt({ hash: h })
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: ['spectrum', 'version-note', chainId] })
    } catch (e) {
      setError(e instanceof Error ? (e.message.split('\n')[0] ?? 'Could not publish.') : 'Could not publish.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3">
      {note.data && !editing ? (
        <blockquote className="rounded-xl border border-cyan/20 bg-cyan/[0.04] px-4 py-3">
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink-dim">{note.data.text}</p>
          <footer className="mt-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wide text-ink-faint">
            <span>the creator, on-chain</span>
            {isDeployer && (
              <button
                type="button"
                onClick={() => {
                  setDraft(note.data!.text)
                  setEditing(true)
                }}
                className="press hover:text-cyan"
              >
                Edit
              </button>
            )}
          </footer>
        </blockquote>
      ) : isDeployer && !editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="press font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint hover:text-cyan"
        >
          + Add a release note (publishes on-chain)
        </button>
      ) : null}
      {editing && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, MAX_POST_CHARS))}
            rows={3}
            placeholder="What changed and why — sold X, added Y, because…"
            className="w-full resize-y rounded-lg border border-white/10 bg-black/25 px-3.5 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-cyan/50 focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
              className="press rounded-lg px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={publish}
              className="press rounded-lg bg-cyan px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Publishing…' : 'Publish'}
            </button>
          </div>
          {error && <p className="mt-2 font-mono text-[11px] text-magenta">{error}</p>}
        </div>
      )}
    </div>
  )
}

// "What changed in this version" as a collapsible callout behind a glowing
// spectral gradient border — visible enough to invite a click, folded so the
// diff table doesn't push the holdings below the fold. On-chain facts only
// plus, when published, the deployer's own on-chain release note.
function WhatChanged({
  predSymbol,
  prevAddr,
  nextAddr,
  chainId,
  deployer,
  isDeployer,
}: {
  predSymbol: string
  prevAddr: string
  nextAddr: string
  chainId: number
  deployer: string | null
  isDeployer: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="rounded-2xl p-[1.5px]"
      style={{
        background: 'linear-gradient(135deg,rgba(53,224,255,0.55),rgba(123,92,255,0.6),rgba(255,77,184,0.55))',
        boxShadow: '0 0 30px -8px rgba(123,92,255,0.5)',
      }}
    >
      <div className="rounded-[14.5px] bg-void/95">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="press flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
        >
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
            What changed in this version
          </span>
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            {open ? 'Hide' : 'Show'}
            <svg
              viewBox="0 0 24 24"
              className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
        </button>
        {open && (
          <div className="px-5 pb-5">
            <p className="mb-3 max-w-3xl font-mono text-[11px] leading-relaxed text-ink-faint">
              A new version of ${showSymbol(predSymbol)}. The previous version stays live and immutable; holders
              move only if they choose to.
            </p>
            <VersionNote basket={nextAddr} chainId={chainId} deployer={deployer} isDeployer={isDeployer} />
            <BasketDiff prevAddr={prevAddr} nextAddr={nextAddr} chainId={chainId} />
          </div>
        )}
      </div>
    </div>
  )
}


/** Who made this basket and why — the header's width-based content block
 *  (owner 2026-08-01). This used to sit in the swap rail, where a paragraph of
 *  thesis had one narrow column to fall down; in the header it gets the card's
 *  width and reads across. Same signed source as before: the DEPLOYER-SIGNED
 *  metadata blob, attributed and verifiable — never operator-written copy. */
/** The byline — top right, under the price (owner 2026-08-03 live). Compact:
 *  avatar, who, follow; the launch-post link keeps riding along. Right-aligned
 *  to share the price's edge. */
function CreatorByline({
  basket,
  chainId,
  creator,
  meta,
  deployer,
  sig,
  viewer,
}: {
  basket: string
  chainId: number
  creator: NonNullable<ReturnType<typeof resolveCreator>>
  meta: ReturnType<typeof useCreatorMeta>['data']
  deployer: string | null
  sig: string
  viewer?: string
}) {
  // A named creator's byline links by NAME (the URL system's display half):
  // the address form always works and every old link keeps resolving —
  // creatorPath is a preference, never a migration. One shared 5-min query
  // site-wide; the token page is high-intent, so the resolve is warranted
  // here (list chips deliberately still link by address — a per-row resolve
  // would re-run 3-chain discovery per visitor, the audit's storm class).
  const { lookup: deployerHandle } = useHandleForAddress(deployer)
  const creatorHref = creatorPath(
    deployer ?? '',
    deployerHandle.status === 'found' ? deployerHandle.owner : null,
  )
  // A claimed name beats a bare address in the byline too — but never beats a
  // signed profile's identity (X handle / display name), which the creator
  // chose more deliberately. Identity precedence: signed > claimed URL name >
  // address. (Resolved handles are charset-constrained at claim time, so the
  // label is bounded by construction — no clip needed.)
  const bylineLabel =
    creator.kind === 'address' && deployerHandle.status === 'found'
      ? deployerHandle.owner.display
      : creator.label
  // The deployer's corner belongs to the Edit pen — visitors get the launch-post
  // link instead. On a chain with NO notes registry the pen never renders, so
  // the deployer keeps the link too (audit). The bare profile fallback ("On X")
  // is gone (owner 0903: "we don't have the X links anymore") — only a signed
  // launch post earns a link here.
  const showPostLink =
    meta?.postUrl &&
    !(chainCfg(chainId).notesRegistry && viewer && deployer && viewer.toLowerCase() === deployer.toLowerCase())
  return (
    <div className="mt-6 flex items-center gap-3 sm:justify-end">
      {showPostLink && (
        <a
          href={meta?.postUrl ?? '#'}
          target="_blank"
          rel="noreferrer"
          className="press inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan hover:underline"
        >
          Launch post
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 17L17 7M7 7h10v10" />
          </svg>
        </a>
      )}
      <div className="min-w-0 sm:text-right">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-dim">Created by</div>
        <span className="flex items-center gap-1.5 sm:justify-end">
          {deployer ? (
            <Link
              to={creatorHref}
              className="press block truncate font-display text-base font-semibold leading-tight text-ink hover:text-cyan"
            >
              {bylineLabel}
            </Link>
          ) : (
            <span className="block truncate font-display text-base font-semibold leading-tight text-ink">{bylineLabel}</span>
          )}
          {/* the small heart, right beside the name (owner 2026-08-03) */}
          {deployer && <FollowButton deployer={deployer} variant="heart" />}
        </span>
        {/* ── AN EXPLICIT DOOR TO THE PROFILE (owner 2026-08-09: "there needs to
               be a button to visit the creators profile"). The name above has
               always been a link, but a name styled as a name does not read as
               somewhere to GO — the only cue was a hover colour, which does not
               exist on touch at all. This is the same destination, stated. ── */}
        {deployer && (
          <Link
            to={creatorHref}
            className="press mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/12 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-ink sm:ml-auto"
          >
            View profile
            <span aria-hidden>→</span>
          </Link>
        )}
      </div>
      <div className="relative shrink-0">
        <div aria-hidden className="absolute -inset-1 rounded-full opacity-60 blur-[9px]" style={{ background: sig }} />
        <div className="relative overflow-hidden rounded-full ring-2 ring-white/15">
          <BasketAvatar
            address={creator.address ?? basket}
            symbol={creator.kind === 'address' ? 'x' : creator.label.replace(/^@/, '')}
            imageUrl={meta?.avatarUrl ?? undefined}
            size={40}
          />
        </div>
      </div>
    </div>
  )
}

/** THE REFERRAL DOOR IN THE PILL ROW (owner 2026-08-18 0929: "a little click
 *  to share your referral link… smallish icons with maybe like one word of
 *  text"). One word, one icon, copies THIS basket's page with the viewer's
 *  own ref — the sharer's claimed name when they have one, address otherwise
 *  (ReferralCard's exact builder law; resolveRefInput has taken names since
 *  desk 202). Hidden when no wallet is connected: with no identity there is
 *  no referral, and a door to nowhere is worse than no door. */
function RefLinkChip({ basket, chainId }: { basket: string; chainId: number }) {
  const { address, isConnected } = useAccount()
  const { lookup } = useHandleForAddress(address)
  const [copied, setCopied] = useState(false)
  if (!isConnected || !address) return null
  const refWord = lookup.status === 'found' ? lookup.owner.display : address
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const path = typeof window !== 'undefined' ? window.location.pathname : `/basket/${chainId}/${basket}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(refLinkFor(refWord, origin, path))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="Copy your referral link for this basket"
      title="Copy this page with your referral attached — buys through it credit you"
      className={`press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 font-mono text-[13px] transition-colors ${
        copied ? 'border-teal/50 bg-teal/10 text-teal' : 'border-white/12 bg-white/[0.04] text-ink-dim hover:border-cyan/50 hover:text-cyan'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
      {copied ? 'Copied ✓' : 'Referral'}
    </button>
  )
}

/** The thesis alone — the byline moved to the hero's right column under the
 *  price (owner 2026-08-03 live: "created by can go in top right below price…
 *  horizontally with the thesis"). One component per hero column. */
function CreatorThesis({
  basket,
  chainId,
  meta,
  deployer,
}: {
  basket: string
  chainId: number
  meta: ReturnType<typeof useCreatorMeta>['data']
  deployer: string | null
}) {
  return (
    // INNER CARD (owner 2026-08-03 live: "add an inner card on the thesis
    // area in the basket hero") — a quiet glass surface lifting the creator's
    // words off the warp behind them. gap-6: within-card group step.
    // LEGIBILITY PASS (owner 2026-08-18 0929 follow-up: "make the thesis text
    // easier to read"): the thesis is the creator's words — the page's second
    // read — and it sat in DIM ink at 15px on glass the warp bled through.
    // Body ink, one step up in size, a book measure (62ch), steadier glass.
    <div className="flex max-w-2xl flex-col gap-6 rounded-2xl border border-white/10 bg-black/45 p-5 backdrop-blur-md sm:p-6">
      <div>
        {meta?.tagline && (
          <p className="max-w-[62ch] font-display text-lg font-bold leading-snug tracking-tight text-ink">{meta.tagline}</p>
        )}
        {meta?.thesis ? (
          <p className={`max-w-[62ch] whitespace-pre-line text-[16px] leading-[1.7] text-ink ${meta?.tagline ? 'mt-3' : ''}`}>
            {meta.thesis}
          </p>
        ) : !meta?.tagline ? (
          // pr-24 clears ThesisEditor's absolutely-positioned Write button
          // (the owner live 2026-08-15: "the write button overlaps the thesis")
          <p className="max-w-[70ch] pr-24 pt-1 text-sm leading-relaxed text-ink-faint">
            No thesis published yet — the creator hasn&rsquo;t written one for this basket. Only the
            on-chain facts are shown.
          </p>
        ) : null}
        {/* the launch journey's thesis door lands here (scroll-mt so the
            heading is not tucked under the sticky header) */}
        {deployer && (
          <div id="thesis-editor" className="scroll-mt-24">
            <ThesisEditor basket={basket} chainId={chainId} deployer={deployer} meta={meta} />
          </div>
        )}
      </div>

      {((meta?.sectors && meta.sectors.length > 0) || meta?.timeHorizon) && (
        <div className="flex flex-wrap items-center gap-2">
          {meta?.sectors?.map((sct) => (
            <span
              key={sct}
              className="rounded-full border border-violet/30 bg-violet/[0.07] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-violet-bright"
            >
              {sct}
            </span>
          ))}
          {meta?.timeHorizon && (
            <span className="rounded-full border border-cyan/30 bg-cyan/[0.07] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan">
              {meta.timeHorizon}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** THE MONEY STORY (owner 2026-08-03: "how much $ would I have gotten if I
 *  bought this at the beginning vs the underlying assets — simplify"). The
 *  page's plainest sentence: $100 in, what it reads as now — beside the same
 *  $100 just HOLDING the launch mix, never rebalanced. Percentages ask the
 *  reader to do math; dollars are the answer already.
 *
 *  Honesty rules, all inherited from the numbers this page already shows:
 *  · The basket side is the SAME ratio as "Since inception" (navSeries when
 *    real, the reconstructed curve else) — restated in dollars, never a new
 *    number. $100 is stated as the hypothetical it is.
 *  · The hold side is the launch-designed weights over the constituents' own
 *    price histories — fixed mix, what buy-and-hold-yourself would have read.
 *    If ANY constituent's history is unreadable the line is ABSENT — a partial
 *    mix compared against a whole one is a lie with an axis.
 *  · The window is said plainly: the label always names the DATE the readable
 *    history starts from, so it never claims a beginning it cannot see.
 *  · Below the measurability floor the whole story mutes and says why (the
 *    same MEASURABLE_TVL_FLOOR_USD every performance surface here obeys). */
function MoneyStory({ ix, chainId }: { ix: BasketData; chainId: number }) {
  const ageSec = ix.ageHours != null ? ix.ageHours * 3600 : null
  // Basket side: live weights (what the basket actually held through the
  // window) — the same inputs the hero chart reads, so the two never disagree.
  const basketAll = useNavHistory({
    chainId,
    assets: ix.holdings.map((h) => ({
      address: h.asset,
      weight: h.liveWeightPct > 0 ? h.liveWeightPct : h.targetWeightPct,
    })),
    navPerToken: ix.navPerToken,
    ageSec,
    range: 'ALL',
  })
  // Hold side: the launch DESIGN, fixed forever — the "just buy the assets" mix.
  const holdAll = useNavHistory({
    chainId,
    assets: ix.holdings.map((h) => ({ address: h.asset, weight: h.targetWeightPct })),
    navPerToken: ix.navPerToken,
    ageSec,
    range: 'ALL',
  })

  const basketSeries = basketAll.data.length >= 2 ? basketAll.data : ix.navSeries
  const basketRet = computeReturns(basketSeries, ageSec).find((r) => r.range === 'ALL')
  if (!basketRet) return null

  // Suppress the range unless EVERY constituent answered with history — a
  // best/worst read off a partial set could name the wrong asset entirely.
  const holdWhole =
    holdAll.data.length >= 2 && holdAll.perAsset.length > 0 && holdAll.perAsset.every((a) => a.pct != null)

  const basketUsd = 100 * (1 + basketRet.pct / 100)
  // The RANGE (owner 2026-08-03 live): what $100 in only the WORST pick and
  // only the BEST pick would read — the basket sits between them, which is
  // the whole point of holding a mix, shown rather than claimed. Same gate
  // as the hold line: every constituent must have answered.
  const symbolByAddr = new Map(ix.holdings.map((h) => [h.asset.toLowerCase(), h.symbol]))
  const extremes = holdWhole
    ? [...holdAll.perAsset].sort((x, y) => (x.pct ?? 0) - (y.pct ?? 0))
    : []
  const worst = extremes.length >= 2 ? extremes[0] : null
  const best = extremes.length >= 2 ? extremes[extremes.length - 1] : null

  // The window is named by its DATE, always (owner 0903: "$100 in this basket
  // since July 8th") — the first readable point IS the claim's start, whether
  // or not it reaches launch, so the label stays exact with no caveat prose.
  const sinceDate = new Date(basketSeries[0].time * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })

  const solid = (ix.aumUsd || 0) >= MEASURABLE_TVL_FLOOR_USD
  const money = (v: number) =>
    `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const tone = (v: number) => (!solid ? 'text-ink-dim' : v >= 100 ? 'text-cyan' : 'text-magenta')

  // One heading, then today · worst · best ALL ON ONE ROW (owner 0903: the old
  // three labelled columns were "jumbled purely from text volume"). The pick
  // labels are cut to the ticker. Three figures + inline labels measure ~540px,
  // so a phone CANNOT carry the inline form — below sm each figure stacks its
  // tiny label beneath it instead, which keeps the figures themselves on one
  // row at any width; sm+ shares one baseline, labels inline.
  return (
    <div className="border-b border-white/10 px-6 py-4 sm:px-10">
      <div className="text-center font-mono text-[11px] uppercase tracking-[0.22em] text-ink-dim">
        $100 in this basket since {sinceDate}
      </div>
      <div className="mt-1.5 flex items-start justify-center gap-x-6 text-center sm:items-baseline sm:gap-x-10">
        <div>
          <div className={`font-num text-xl font-light tabular-nums sm:text-2xl ${tone(basketUsd)}`}>
            {money(basketUsd)}
            <span className="ml-1.5 hidden font-mono text-xs text-ink-faint sm:inline">today</span>
          </div>
          <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint sm:hidden">
            today
          </div>
        </div>
        {worst?.pct != null && best?.pct != null && (
          <>
            <div>
              <div className="font-num text-lg font-light tabular-nums text-ink-dim sm:text-xl">
                {money(100 * (1 + worst.pct / 100))}
                <span className="ml-1.5 hidden font-mono text-xs text-ink-faint sm:inline">
                  only ${symbolByAddr.get(worst.address.toLowerCase()) ?? '?'}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint sm:hidden">
                only ${symbolByAddr.get(worst.address.toLowerCase()) ?? '?'}
              </div>
            </div>
            <div>
              <div className="font-num text-lg font-light tabular-nums text-ink-dim sm:text-xl">
                {money(100 * (1 + best.pct / 100))}
                <span className="ml-1.5 hidden font-mono text-xs text-ink-faint sm:inline">
                  only ${symbolByAddr.get(best.address.toLowerCase()) ?? '?'}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint sm:hidden">
                only ${symbolByAddr.get(best.address.toLowerCase()) ?? '?'}
              </div>
            </div>
          </>
        )}
      </div>
      {/* the thin-book caveat line left on the owner's 2026-08-18 word
          ("remove … text on the basket / bundle individual pages") — the
          numbers stand on their own; the depth story lives in the docs */}
    </div>
  )
}

/* The since-launch chip (InceptionReturn) left the price row on the owner's
   2026-08-07 0903 note — the same ratio still reads in dollars in the money
   story above the chart, honesty rules identical. */

/** ── LOADING SKELETONS (QOL round 2026-08-05) ───────────────────────────────
 *  The portfolio surfaces have loaded into skeletons for a while; this page had
 *  none, so a slow chain read left everything under the hero as empty space —
 *  which reads as broken rather than as pending. These stand in the regions the
 *  basket page is made of (identity · the numbers · the chart · the
 *  composition), in the SAME visual language the rest of the site loads in
 *  (Yours, HomeOnboarding): faint white blocks, staggered pulse, static under
 *  reduced motion. One product, one loading posture.
 *
 *  Two rules they obey, both load-bearing:
 *  · A pulse means "we are still READING" — never "there is nothing here". It
 *    keys off the page's own query state (`ix`), never a timer, and anything
 *    genuinely absent, unpriced or failed keeps the honest treatment it already
 *    has: the em-dash in the assets table, the "not fully priced" note, the
 *    error Notice. A shimmer that can never resolve would be a lie.
 *  · They hold roughly the space the real content lands in, so nothing jumps —
 *    and the pulse STOPS the moment the data is in hand, so through the hero's
 *    short reveal the blocks are only holding geometry, not claiming a read.
 *  No chrome (no card surface, no section rules): the card is deliberately
 *  invisible until the content rises, so the blocks sit on the bare page the
 *  way the portfolio's do. */
function Skel({
  className,
  delay = 0,
  reading = true,
}: {
  className: string
  delay?: number
  reading?: boolean
}) {
  return (
    <div
      aria-hidden
      className={`bg-white/[0.04] ${reading ? 'animate-pulse motion-reduce:animate-none' : ''} ${className}`}
      style={reading && delay ? { animationDelay: `${delay}ms` } : undefined}
    />
  )
}

/** The hero's identity block, unresolved: name → pills → the thesis card on the
 *  left, the price readout + constituent discs on the right. Mirrors the real
 *  block's flex layout so the swap between them is a swap in place. The warp
 *  keeps its job behind this — it was always the loading state's colour, and
 *  now the shapes say which parts are still coming. */
function HeroSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading this basket"
      className="relative z-10 flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between sm:gap-12"
    >
      <div className="flex min-w-0 flex-col gap-5">
        <Skel className="h-11 w-[min(20rem,80%)] rounded-xl sm:h-12 md:h-14" />
        <div className="flex flex-wrap items-center gap-2.5">
          {['w-20', 'w-28', 'w-32', 'w-16', 'w-8'].map((w, i) => (
            <Skel key={w} className={`h-8 rounded-full ${w}`} delay={i * 120} />
          ))}
        </div>
        {/* the thesis inner card arrives with its own glass chrome — it is what
            lifts the creator's words off the warp, so the placeholder wears it */}
        <div className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-white/10 bg-black/30 p-5 backdrop-blur-md sm:p-6">
          <Skel className="h-5 w-3/4 rounded-md" />
          <Skel className="h-3.5 w-full rounded-md" delay={140} />
          <Skel className="h-3.5 w-[88%] rounded-md" delay={280} />
          <Skel className="h-3.5 w-[62%] rounded-md" delay={420} />
        </div>
      </div>

      <div className="shrink-0">
        <div className="flex items-center gap-2.5 sm:justify-end">
          <Skel className="h-3 w-10 rounded-md" />
          <Skel className="h-6 w-16 rounded-full" delay={120} />
          <Skel className="h-3 w-8 rounded-md" delay={240} />
        </div>
        <Skel className="mt-3 h-12 w-52 rounded-xl sm:ml-auto sm:h-14 md:h-16" delay={80} />
        <Skel className="mt-4 h-4 w-36 rounded-md sm:ml-auto" delay={200} />
        <div className="mt-12 flex items-center sm:justify-end">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skel
              key={i}
              className={`h-[52px] w-[52px] rounded-full ring-[3px] ring-panel/90 ${i > 0 ? '-ml-4' : ''}`}
              delay={i * 130}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Everything under the hero, unresolved: the money story's numbers, the chart
 *  beside the swap rail on the same two-track grid, the composition bento + its
 *  table, and the key stats. `reading` false = the data has landed and these are
 *  purely holding the geometry through the reveal, so they stop pulsing. Hidden
 *  from assistive tech throughout — the hero's one live region says "loading",
 *  and a second announcement of the same fact is just noise. */
function BasketBodySkeleton({ reading }: { reading: boolean }) {
  return (
    <div aria-hidden>
      {/* the money story: three plain numbers, centred */}
      <div className="flex flex-wrap items-end justify-center gap-x-12 gap-y-3 px-6 py-4 sm:px-10">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <Skel className="h-3 w-40 rounded-md" delay={i * 140} reading={reading} />
            <Skel className="h-8 w-24 rounded-lg" delay={i * 140 + 70} reading={reading} />
          </div>
        ))}
      </div>

      {/* chart column · swap rail — the same grid, so the tracks don't shift */}
      <div className="grid lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 px-4 py-5 sm:px-6">
          <Skel className="h-64 w-full rounded-2xl sm:h-72 lg:h-[432px]" reading={reading} />
        </div>
        <div className="min-w-0 space-y-4 p-4 sm:p-6">
          <Skel className="h-20 w-full rounded-2xl" delay={120} reading={reading} />
          {SWAP_ENABLED && <Skel className="h-[320px] w-full rounded-2xl" delay={240} reading={reading} />}
        </div>
      </div>

      {/* composition: the weight-true bento (its own 3.2 aspect) + the numbers */}
      <div className="px-4 py-5 sm:px-6">
        <div className="mb-4 flex items-baseline justify-between gap-2">
          <Skel className="h-4 w-44 rounded-md" reading={reading} />
          <Skel className="h-3 w-52 rounded-md" delay={120} reading={reading} />
        </div>
        <Skel className="aspect-[16/5] w-full rounded-xl" reading={reading} />
        <div className="mt-5 space-y-2.5">
          {[0, 1, 2, 3].map((i) => (
            <Skel key={i} className="h-10 w-full rounded-lg" delay={i * 160} reading={reading} />
          ))}
        </div>
      </div>

      {/* key stats */}
      <div className="grid grid-cols-2 gap-4 px-6 py-5 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skel key={i} className="h-[86px] w-full rounded-2xl" delay={i * 140} reading={reading} />
        ))}
      </div>
    </div>
  )
}

/* THE JOIN PICKER moved to components/reshape/JoinBundlePicker.tsx
   (2026-08-10) — the creator page mounts the same flow, so the picker + its
   join-mode reshape mount live as ONE shared component now. This page keeps
   only the door state and the joinable list. */

export function Token() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  // TWO shapes reach this page and both are permanent (owner 2026-08-01):
  //   /token?addr=0x…&chain=4663   the original, still minted by nothing but
  //                                shared everywhere — it must never break
  //   /t/r/T2-29374eaa             the short form the app mints from now on
  // The short one resolves against the discovered list, so it stays in the
  // address bar rather than bouncing through a redirect.
  const route = useParams()
  const { data: allBaskets } = useAllBaskets()
  const routeChain = route.chain ? chainFromSlug(route.chain) : null
  const match = route.ref ? resolveBasketRef(route.ref, routeChain, allBaskets ?? []) : null
  const shortPending = !!route.ref && !allBaskets
  // ONE LINK, EVERY VERSION (owner 2026-08-03): a basket link keeps answering
  // with the creator's CURRENT version. The address someone was given stays in
  // the URL (a shared link is a fact); the VIEW canonicalizes forward through
  // the deployer-signed lineage (versioning.ts — same-deployer, cycle-capped).
  // ?v=exact opts out: the version strip's older pills use it, and it is how a
  // superseded version stays fully inspectable forever.
  const arrived = match?.hit?.address ?? params.get('addr') ?? undefined
  const chainId = match?.hit?.chainId ?? (Number(params.get('chain')) || routeChain || 8453)
  const exact = params.get('v') === 'exact'
  const arrivedLineage = useLineage(arrived, chainId)
  const addr = !exact && arrived && arrivedLineage.head ? arrivedLineage.head : arrived
  // True when this render shows a NEWER version than the link that led here.
  const forwarded = !exact && !!arrived && !!addr && arrived.toLowerCase() !== addr.toLowerCase()
  const { data: ix, isLoading, isError } = useBasketData(addr, chainId)
  // count the headline price up once the basket resolves (hook stays unconditional)
  const navUp = useCountUp(ix?.navPerToken ?? 0, !!ix)
  // Verified, deployer-signed creator metadata (null until published + verified).
  const { data: meta } = useCreatorMeta(addr, chainId)
  // Version lineage of the VIEWED basket (deployer-signed `supersedes` claims);
  // `allBaskets` above doubles as the symbol table for the lineage strip.
  const lineage = useLineage(addr, chainId)
  // The headline fee % is surfaced in the hero; the full waterfall reads at
  // the bottom of the card (FeePanel re-uses the same cached query).
  const { data: fees } = useBasketFees(addr, chainId)
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  /** Where closing the share card LANDS (owner 2026-08-16: after the drawn
   *  card, "it should take you to the bundle/basket page" — the ceremony's
   *  share door landed on the LEG's page and stayed there). Carried in by
   *  `?then=<internal path>`; internal paths only, so a crafted link cannot
   *  bounce a visitor off-site. Null = stay here, unchanged. */
  const [shareThen, setShareThen] = useState<string | null>(null)
  // THE CREATOR SETUP CEREMONY (the owner 2026-08-15): pops ONCE at the seeding
  // moment — the page's own supply read flipping 0 → >0 while the deployer
  // watches. Session-stamped per basket so a re-render can never re-ask.
  const [creatorSetupOpen, setCreatorSetupOpen] = useState(false)
  const prevSupplyRef = useRef<number | null | undefined>(undefined)
  // ?share=1 — the journey's share door (launch-doors.ts). The standalone
  // Share button left this page on the owner's 2026-08-07 note, which quietly
  // made the share step's door a dead end; the owner's 2026-08-14 recording
  // (create → seed → SHARE as the flow's third step) re-opens it as a URL
  // fact any page can point at. Opening stamps the journey's one local step,
  // exactly as the launch banner's own door does; the param is stripped so
  // back/refresh does not re-raise a modal nobody re-asked for.
  useEffect(() => {
    if (params.get('share') !== '1' || !addr) return
    markShared(chainId, addr)
    setShareOpen(true)
    // THE SHARE DOOR WINS (owner 2026-08-16: "i clicked see and share your
    // card and it didnt show the bento image card it just showed ✓ seeded /
    // You're live") — the seed-moment setup ceremony stood over the share
    // card, so the card the click asked for was never seen. Opening share
    // closes it.
    setCreatorSetupOpen(false)
    // the close destination (internal only — never a crafted off-site bounce)
    const then = params.get('then')
    setShareThen(then && then.startsWith('/') && !then.startsWith('//') ? then : null)
    const next = new URLSearchParams(params)
    next.delete('share')
    next.delete('then')
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, addr, chainId])
  const [forgeOpen, setForgeOpen] = useState(false)
  // The reshape popup's door (reshape-types.ts — editing IS shipping a new
  // version). State lives up here with the page's other modal doors, above the
  // gates like every hook on this page; the pill renders in the actions row and
  // the modal mounts with the others at the end of the page JSX.
  const [reshapeOpen, setReshapeOpen] = useState(false)
  // The join door (the owner 2026-08-10: "an easy way for a creator to add an
  // existing basket into a multichain bundle"). One state — the shared
  // JoinBundlePicker owns both steps (choose WHICH bundle, then the same
  // reshape popup in join mode; the rename is the whole mechanism).
  const [joinOpen, setJoinOpen] = useState(false)
  const { address: viewer } = useAccount()
  // The viewer's claimed creator name, for the launch moment's claim act
  // (called unconditionally — every hook on this page lives above the gates).
  const myHandle = useHandleForAddress(viewer)
  // And the DEPLOYER's, for the drawn share image's by-line — same shared
  // 5-minute query as the byline's read, so this costs nothing extra.
  const { lookup: deployerName } = useHandleForAddress(ix?.deployer)
  // THE STAMP BACKFILL (the TEST100 ghost's last life): a deployer looking at
  // their own LIVE basket is on-chain proof it deployed — stamp the ticker so
  // every resume surface retires its drafts, including deploys that predate
  // the stamp. Idempotent; markTickerDeployed also clears a matching
  // composer-draft row.
  useEffect(() => {
    if (!ix || !viewer || !ix.deployer || viewer.toLowerCase() !== ix.deployer.toLowerCase()) return
    markTickerDeployed(ix.symbol)
  }, [ix, viewer])
  useEffect(() => {
    const supply = ix?.effectiveSupply
    const prev = prevSupplyRef.current
    prevSupplyRef.current = supply
    if (prev !== 0 || typeof supply !== 'number' || supply <= 0) return
    if (!viewer || !ix?.deployer || viewer.toLowerCase() !== ix.deployer.toLowerCase()) return
    if (shareOpen) return // the share card is up — never raise a ceremony over it
    try {
      const k = `spectrum:creator-setup-shown:${addr?.toLowerCase()}`
      if (sessionStorage.getItem(k) === '1') return
      sessionStorage.setItem(k, '1')
    } catch {
      /* storage unavailable — still show once this render */
    }
    setCreatorSetupOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ix?.effectiveSupply, viewer, ix?.deployer, addr])

  // Phone mini-buy bar (mobile UX review 1): below lg the grid linearizes and
  // the swap rail lands 3-4 screens deep on the page whose job is converting.
  // A slim fixed bar above the tab bar appears once the console has scrolled
  // out of reach; tapping it scrolls back to the console. Observation, not a
  // second console — one state machine, no keyboard fights.
  const [buyBarShow, setBuyBarShow] = useState(false)
  const buyIoRef = useRef<IntersectionObserver | null>(null)
  // ⚠ THIS NEVER RAN (mobile sweep 2026-08-06: the bar was absent at every
  // scroll on a phone — the conversion affordance missing from the page whose
  // job is converting). It was an effect keyed `[addr, !!ix]` calling
  // getElementById: the console mounts behind `bodyReady` (ix AND creator AND
  // intro==='done'), so when ix resolved the element did not exist yet, the
  // effect bailed, and no later dep change re-ran it.
  // A CALLBACK REF instead — it fires whenever the node itself appears, so no
  // gate upstream can starve it. (Same class as the bento's never-measured
  // box, fixed in the allocator lane the same day.)
  const buyConsoleRef = useCallback((node: HTMLDivElement | null) => {
    buyIoRef.current?.disconnect()
    buyIoRef.current = null
    if (!node || !SWAP_ENABLED || typeof IntersectionObserver === 'undefined') {
      setBuyBarShow(false)
      return
    }
    const io = new IntersectionObserver(([e]) => setBuyBarShow(!e.isIntersecting), { rootMargin: '0px 0px -20% 0px' })
    io.observe(node)
    buyIoRef.current = io
  }, [])
  useEffect(() => () => buyIoRef.current?.disconnect(), [])

  // Intro: the hero opens as the basket's colors ALONE (the warp doubles as
  // the loading state), then eases to its resting subtlety while the hero
  // text and the content below fade in. The fixed hold AFTER data lands is
  // short — the data fetch itself already provides the swirl time on real
  // loads. Reduced-motion viewers skip straight to the settled state.
  const [intro, setIntro] = useState<'swirl' | 'done'>('swirl')
  const loaded = !!ix
  useEffect(() => {
    if (!loaded) return
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setIntro('done')
      return
    }
    const t = window.setTimeout(() => setIntro('done'), 500)
    return () => window.clearTimeout(t)
  }, [loaded])

  // ⛔ EVERY HOOK MUST BE ABOVE THE GATES BELOW. The gates return early, so a
  // hook placed after them runs on some renders and not others, and React
  // throws on the render where the count changes. That crashed this page on
  // the arrival shape we mint most: a cold short link renders the pending
  // notice first (no `allBaskets` yet), then the full page once discovery
  // answers — more hooks on the second render. The mirror case is a loaded
  // page whose refetch errors into the gate at :964 — fewer hooks.
  // The state below belongs to the iterate loop, read ~70 lines down.
  const [intentDismissed, setIntentDismissed] = useState(false)
  useEffect(() => {
    // Clear ONLY on consummation (audit C1): this basket's signed predecessor
    // IS the intended one. Clearing on any linked basket silently killed a
    // fresh intent the moment the creator browsed an existing v2 elsewhere.
    if (!ix?.deployer || !lineage.predecessor) return
    const pending = pendingVersionIntent(ix.deployer, chainId)
    if (pending && lineage.predecessor === pending.predecessor) clearVersionIntent(ix.deployer, chainId)
  }, [ix?.deployer, lineage.predecessor, chainId])

  // THE THESIS THIS LEG BELONGS TO, when it belongs to one: the same
  // (deployer, name) recognition the thesis page runs, over the directory
  // already in hand — so a leg is never a dead end for the wider idea. No
  // launch-time lookup here (this page builds none), so grouping degrades to
  // name+deployer — the grouper's documented honest fallback.
  const partOfThesis = useMemo(() => {
    if (!ix?.deployer || !allBaskets || allBaskets.length === 0 || !addr) return null
    const mine = allBaskets.filter(
      (b) => b.deployer?.toLowerCase() === ix.deployer!.toLowerCase() && !b.supersededBy,
    )
    const theses = groupIntoTheses(mine)
    return (
      theses.find((t) =>
        t.legs.some((l) => l.chainId === chainId && l.address.toLowerCase() === addr.toLowerCase()),
      ) ?? null
    )
  }, [ix?.deployer, allBaskets, addr, chainId])

  // THE THESES THIS BASKET COULD JOIN (the owner 2026-08-10): the creator's OTHER
  // multi-chain groups. includeSingles stays false — a lone basket is not yet
  // a thesis to join — and a thesis whose name this basket already shares is
  // never offered: to the grouper, sharing the name IS membership (or the
  // same-chain shadow of it), so offering it would sell a join to nowhere.
  const joinableTheses = useMemo(() => {
    if (!ix?.deployer || !allBaskets || allBaskets.length === 0) return []
    const fold = (s: string | null | undefined) =>
      String(s ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
    const mine = allBaskets.filter(
      (b) => b.deployer?.toLowerCase() === ix.deployer!.toLowerCase() && !b.supersededBy,
    )
    const myName = fold(ix.name)
    return groupIntoTheses(mine).filter((t) => fold(t.name) !== myName)
  }, [ix?.deployer, ix?.name, allBaskets])

  // A short link can't be judged until discovery has answered — a pending list
  // is not a missing basket.
  if (shortPending) return <Notice>Finding this basket…</Notice>
  // A bare ticker with a twin: say which ones, never pick. Guessing here sends
  // someone to the wrong basket with money in hand.
  if (match && !match.hit && match.ambiguous.length > 1) {
    return (
      <div className="py-10">
        <div className="mx-auto max-w-md rounded-2xl border border-white/12 bg-white/[0.03] p-6">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Two baskets share that ticker</div>
          <p className="mt-2 text-sm text-ink-dim">Pick the one you meant — the link you followed didn&rsquo;t say.</p>
          <div className="mt-4 space-y-2">
            {match.ambiguous.map((c) => (
              <Link
                key={`${c.chainId}:${c.address}`}
                to={basketHref(c)}
                className="press flex items-center justify-between rounded-xl border border-white/10 px-3 py-2.5 font-mono text-[12px] text-ink-dim hover:border-cyan/50 hover:text-ink"
              >
                <span className="font-semibold">${showSymbol(c.symbol)}</span>
                <span className="text-ink-faint">{shortAddr(c.address)}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    )
  }
  if (!addr) return <Notice>No basket address provided (?addr=0x…).</Notice>
  if (isError || (!ix && !isLoading)) return <Notice>Couldn&rsquo;t load this basket. Try again, or check the RPC configuration.</Notice>

  // The hero warp is mounted immediately on a provisional palette (the
  // address-seeded signature + brand hues) and retinted live to the basket's
  // real colors the moment data lands — it has always been the loading state's
  // COLOUR. QOL round 2026-08-05: colour alone left the rest of the card as
  // blank space on a slow chain read, which reads as broken rather than as
  // pending, so the skeletons above now stand in the regions that are still
  // coming while the warp keeps swirling behind them.
  const holdings = ix?.holdings ?? []
  // Attribution: verified creator metadata (handle/name) when published + signed
  // by the on-chain deployer, else the deployer address (the honest fallback).
  const creator = ix
    ? resolveCreator({ handle: meta?.handle, name: meta?.name, deployer: ix.deployer, basketAddress: addr })
    : null
  // The body's gate, named once so the skeleton can render its EXACT complement
  // (QOL 2026-08-05): no frame where both are mounted, none where neither is.
  const bodyReady = !!ix && !!creator && intro === 'done'
  const isDeployer = !!viewer && !!ix?.deployer && viewer.toLowerCase() === ix.deployer.toLowerCase()
  // A demo basket (…de50NNNN — dev-only fixtures): the reshape ceremony runs as
  // a scripted walkthrough that arms nothing, so its entry shows without a
  // wallet match (the review path) while real baskets stay creator-only.
  const isDemoAddr = isDemoLegAddress(addr)
  const accent = (ix?.change24hPct ?? 0) >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)'
  const dom = holdings.reduce(
    (a, b) => (b.targetWeightPct > (a?.targetWeightPct ?? -1) ? b : a),
    holdings[0] as (typeof holdings)[number] | undefined,
  )
  const sig = basketSignatureColor(addr, dom ? { symbol: dom.symbol, address: dom.asset } : undefined)
  const buyInk = /^#[0-9a-fA-F]{6}$/.test(sig) ? readableInk(sig) : '#0b0b12'
  // Warp palette: the basket's signature + its top holdings' brand colors —
  // the same colors the bento renders, so the backdrop is always on-palette.
  // Pre-data it's the signature + brand hues; the retint eases the real ones in.
  const warpPalette = ix
    ? [
        sig,
        ...[...holdings]
          .sort((a, b) => b.targetWeightPct - a.targetWeightPct)
          .slice(0, 3)
          .map((h) => tokenVisual(h.symbol, h.asset).color),
      ]
    : // RESOLVED, not `var(--color-…)` (console smoke, 2026-08-07): this array
      // goes to a WebGL palette shader, which cannot read a CSS custom property
      // and logged "Unsupported color format" twice per frame on every basket
      // page while the data was still in flight. readBrandHex takes the value
      // from the same token the CSS var names, so the brand stays single-sourced
      // and a restyled build follows it; the literals are only the unresolvable
      // fallback.
      [sig, readBrandHex('--color-violet', '#7b5cff'), readBrandHex('--color-magenta', '#ff4db8')]
  const explorerName = chainId === 1 ? 'Etherscan' : chainId === 4663 ? 'Blockscout' : 'Basescan'
  const justDeployed = params.get('deployed') === '1'
  const partnerUrl = partnerAppUrl(addr)
  const diverged = ix != null && ix.navDivergencePct != null && ix.navDivergencePct > 2
  const symbolOf = (a?: string | null) =>
    a ? allBaskets?.find((b) => b.address.toLowerCase() === a.toLowerCase())?.symbol : undefined
  // THE ITERATE LOOP's landing half (ratified plan #1): a pending "new version
  // of X" intent, recorded when the creator clicked ↻ on the old basket,
  // pre-wires the lineage signature here on the NEW basket's page. Hint only —
  // the lineage is real only once SIGNED; a linked page clears the hint (the
  // signature happened, here or manually), and dismiss withdraws it.
  // `intentDismissed` and the clear-on-consummation effect are hoisted above
  // the page's gates — see the hook note there.
  const versionIntent =
    isDeployer && ix && !lineage.hasPredecessor && !intentDismissed
      ? pendingVersionIntent(ix.deployer, chainId)
      : null
  // FRESH DEPLOYS ONLY (audit C1): the intent is deployer-global, so without
  // an age guard the strip would claim "you cut this as a new version of $X"
  // on ANY predecessor-less basket the creator browses. A basket older than
  // a day cannot be the deploy the click meant.
  const intentApplies =
    !!versionIntent &&
    versionIntent.predecessor !== addr?.toLowerCase() &&
    (justDeployed || (ix?.ageHours != null && ix.ageHours <= 24))
  const headSymbol = symbolOf(lineage.head) ?? '?'
  const predSymbol = symbolOf(lineage.predecessor) ?? '?'

  return (
    // The basket page runs ~10% wider than the site's 1000px column (owner
    // 2026-08-01) — the extra 100px all goes to the chart, since the swap rail
    // is a fixed track. Breakout starts at xl, not lg: at 1024px the column is
    // already within 48px of the viewport and -50px a side would overflow.
    <div className="py-6 xl:-mx-[50px]">
      {/* the creator's unseeded basket demands its first buy (R+C 18:26) */}
      {ix && <SeedBasketModal ix={ix} chainId={chainId} />}
      {justDeployed && ix && (
        <LaunchBanner
          symbol={ix.symbol}
          name={ix.name || ix.symbol}
          addr={addr}
          chainId={chainId}
          sig={sig}
          buyInk={buyInk}
          holdings={ix.holdings}
          onShare={() => {
            // The journey's ONE local step, stamped where it actually happens.
            // A stamp on this device — never a claim that anybody saw it, and
            // never allowed to hold a launch open (launch-journey's `share` is
            // the one optional step). It only stops the finished card
            // re-offering "share it" forever on the machine you shared from.
            markShared(chainId, addr)
            setShareOpen(true)
          }}
        />
      )}
      {/* THE CLAIM ACT (owner 2026-08-06, "mount the claimhandle"): launching
          is the exact moment a wallet becomes ELIGIBLE to claim a name (the
          registry's shipped gate), so the offer lives on the launch landing —
          for the DEPLOYER only (this page renders for anyone holding the
          deployed=1 link), and only while they verifiably have no name yet
          ('unknown' adds no UI — a flaky read must not pitch a rename to an
          already-named creator). The creator page's studio is the second
          mount, for everyone who launched before this existed. */}
      {/* ⚠ NO LONGER GATED ON ?deployed=1 (the owner 2026-08-06 23:2x, off a live
          outside user: "the screen refreshed between post-deploy and seeding",
          he re-found the basket by pasting its address, and the setup was
          simply gone). A query param is the most losable state there is — one
          refresh, one shared link, one crashed tab and the ceremony evaporates.
          The conditions underneath were always the real gate and they are
          DURABLE FACTS rather than navigation: you ARE the deployer, and you
          have no claimed name yet. */}
      {isDeployer && !myHandle.loading && myHandle.lookup.status === 'none' && (
        <ClaimHandle className="mb-4" />
      )}

      {/* AND THE OTHER HALF HE LOST — the seed prompt, now the WHOLE journey
          (the owner 2026-08-13: "you should ALWAYS be guided through the entire
          setup, and even if you accidentally refresh or click off you should
          always be able to resume from your creator page or /create").

          A basket with no value is not finished: the first deposit sets its
          opening composition, and until it lands anyone else can make that
          deposit instead (the first mint is PERMISSIONLESS — contracts measured
          it). That was true, and it was only ever a quarter of the story —
          seeding is one of four steps, and this page said nothing about the
          rest.

          ⚠ IT ALSO SAID IT ON THE WRONG EVIDENCE. The block that stood here
          gated on `ix.aumUsd <= 0`. aumUsd reads 0 on an unseeded basket AND on
          a seeded one whose pricing did not come back — so a live, fully-seeded
          basket on a quiet RPC told its own creator it held nothing. The
          journey card reads `effectiveSupply` instead: the only value that
          separates "empty" (0) from "could not read" (null), and the predicate
          every other seeding surface here already uses (SeedBasketModal,
          TradePanel, DexSwapCard). An unreadable one now draws as "couldn't
          read" rather than as either answer.

          Same doors, in place: seeding still scrolls to this page's own buy
          console rather than growing a second one, and the thesis step scrolls
          to the editor that was already below. Deployer-only and self-hiding,
          exactly as before. */}
      {ix && (
        <BasketJourneyCard
          chainId={chainId}
          address={addr}
          name={ix.name}
          symbol={ix.symbol}
          effectiveSupply={ix.effectiveSupply}
          deployer={ix.deployer}
          anchors={{ seed: '#buy-console', thesis: '#thesis-editor', share: '?share=1' }}
          className="mb-4"
        />
      )}
      {/* flex-wrap (mobile sweep 2026-08-06): this row overran a 358px box and
          cut its last control off at the screen edge. Wrapping lets the action
          cluster drop to its own line rather than run off — still load-bearing
          now that Share has gone and Bundle/Start-from/Remix remain. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Link
          to="/"
          className="inline-flex min-h-[36px] items-center font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint press hover:text-ink sm:min-h-0"
        >
          ← All baskets
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {/* YOUR CREATOR TOOLS (the owner 2026-08-12: "group the creator actions
              in their own shared little pill" — the thesis page carries the
              same group) — the two owner doors labeled as one thing, apart
              from the visitor actions beside them. Grouping only: the gate is
              the exact one both buttons always shared, and Add keeps its own
              has-bundles condition inside. */}
          {/* the creator-tools chip moved into the Holdings header
              (the owner live 2026-08-15: "needs to go on the right hand side in
              line with 'holdings'… right hand side of hover a tile") */}
          {/* Bundle this basket (owner 2026-08-01). The basket page had ZERO
              bundle references, which made "create a bundle from the one basket
              they have" impossible from the one place you'd try it. Opens the
              forge over this page with this basket already in it. */}
          {ix && pageEnabled(brand.pages, 'bundle') && (
            <button
              type="button"
              onClick={() => setForgeOpen(true)}
              className="press inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] text-ink-dim hover:border-violet-bright/50 hover:text-[#cabdff]"
              title="Build a bundle starting from this basket"
            >
              Bundle
            </button>
          )}
          {ix && <StartFromBasket holdings={ix.holdings} chainId={chainId} />}
          {ix && <RemixButton holdings={ix.holdings} chainId={chainId} />}
        </div>
      </div>

      {/* LAYOUT: one card. Full-width hero (identity · price · fee), then the
          chart column beside the swap rail, then fee detail + contract at the
          very bottom, everything on the same surface. During the intro swirl
          the card chrome is invisible (only the hero's colors exist); the
          surface fades in with the content. */}
      <div
        className="mt-4 overflow-hidden rounded-2xl card-surface backdrop-blur-md transition-[background-color,border-color,box-shadow] duration-700"
        style={intro === 'swirl' ? { backgroundColor: 'transparent', borderColor: 'transparent', boxShadow: 'none' } : undefined}
      >
        <div
          aria-hidden
          className={`h-1 w-full transition-opacity duration-700 ${intro === 'swirl' ? 'opacity-0' : 'opacity-100'}`}
          style={{ background: sig }}
        />

        {/* ── header (restructured on the owner's 2026-08-01 read-order): the
               left column carries identity → pills → WHO MADE IT + THE THESIS
               (width-based, where the constituent discs used to sit); the right
               column carries the price with the discs right-aligned beneath it;
               the version controls get their own centred row underneath both.
               The hero keeps its breathing room: taller padding, wider gaps. ── */}
        <div className={`relative min-h-[260px] overflow-hidden border-b px-6 py-8 transition-colors duration-700 sm:px-10 sm:py-12 ${intro === 'swirl' ? 'rounded-2xl border-transparent' : 'border-white/10'}`}>
          {/* signature glow */}
          <div
            aria-hidden
            className="pointer-events-none absolute -top-20 left-1/4 h-52 w-2/3 -translate-x-1/4 rounded-full blur-[100px]"
            style={{ background: sig, opacity: 0.16 }}
          />
          {/* TRIAL: seeded warp identity (palette-shaders) behind the info — the
              basket address is the seed, its signature + top holdings the palette;
              masked toward the bottom/left so the identity block stays readable */}
          <WarpIdentity
            seed={`${chainId}:${addr.toLowerCase()}`}
            colors={warpPalette}
            drift={false} // full warp animation (owner call): visibly flowing, not idle drift
            speed={intro === 'swirl' ? 1.75 : 1}
            className={`pointer-events-none absolute inset-0 mix-blend-screen transition-opacity duration-[1500ms] ease-out ${
              intro === 'swirl'
                ? 'opacity-100' // the forming: full-bleed color, fast swirl, no mask
                : 'opacity-[0.35] [mask-image:linear-gradient(100deg,transparent_6%,rgba(0,0,0,0.55)_38%,black_58%,rgba(0,0,0,0.2)_92%)]'
            }`}
          />
          {/* still reading → the skeleton stands exactly where the identity
              will, so the hero doesn't resize under the reader when it lands */}
          {(!ix || !creator) && <HeroSkeleton />}
          {/* identity — absent until data lands, hidden while the intro swirls */}
          {ix && creator && (<>
          <div className="relative z-10 flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between sm:gap-12">
          <div className={`flex min-w-0 flex-col gap-5 transition-opacity duration-700 ${intro === 'swirl' ? 'opacity-0' : 'opacity-100'}`}>
            {/* BOUNDED AND INERT (go-live hardening 2026-08-07). This h1 is the
                largest deployer-controlled string on the busiest page, and it
                rendered raw — so a bidi override reversed the visible title and
                a 300-char symbol was a wall of text. The audit's string sweep
                caught the embed/wallet surfaces and missed this one; the
                hostile-deployer fixture + console smoke are what surfaced it.
                showName falls back through the symbol the same way `|| ` did. */}
            <h1 className="break-words font-display text-4xl font-bold uppercase leading-[0.92] tracking-tight text-ink sm:text-5xl md:text-6xl">
              {ix.name?.trim() ? showName(ix.name) : showSymbol(ix.symbol)}
            </h1>

            {/* LEGACY LINEAGE — say it where someone decides to buy.
                SpectrumContracts, 2026-08-02: a retired lineage's PRISM burner is
                a compile-time constant in the basket's bytecode and no admin
                exists anywhere in the system by design, so its burn leg can never
                be repointed — ~10% of every fee accumulates at an address nobody
                can spend from instead of buying and burning PRISM.
                Stated, not hidden, and stated with its BOUND: NAV, redemption,
                holder fees and creator fees all work normally, so a holder is not
                harmed. the owner's call was to keep these listed (delisting punishes a
                real holder for the kit's own stale config) — which only stays
                honest if the page says what is different about them. */}
            {isLegacyLineage(ix.chainId, ix.router) && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-300/25 bg-amber-300/[0.06] px-3 py-2">
                <span className="mt-px font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/90">Legacy lineage</span>
                <span className="min-w-0 text-[12px] leading-relaxed text-ink-dim">
                  This basket was created by a superseded factory, and its PRISM burn leg is
                  inoperative — the burn share of its fees accumulates at an unspendable address
                  instead of buying and burning PRISM. Everything else works normally: its value,
                  its in-kind exit, and both the holder and creator fee shares are unaffected.
                </span>
              </div>
            )}

            {/* pill family under the title: ticker · chain · copyable address ·
                headline fee, one 24px rounded-full badge set. The address is
                the basket's one unforgeable identity; the full fee waterfall
                reads at the card's bottom. */}
            {/* 32px pills at 13px, up from 24px at 11px (owner 2026-08-01:
                "a little bigger and easier to read") — this row carries the
                ticker, the chain and the basket's one unforgeable identity,
                so it should not be the smallest type on the page. */}
            {/* ONE STANDARDIZED PILL FAMILY on one line (owner 2026-08-03
                live): every chip 32px / 13px mono / rounded-full — ticker,
                the chain's mark, address, fee — with the watch icon closing
                the row. Wraps only when a phone forces it. */}
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="inline-flex h-8 items-center rounded-full border border-cyan/30 bg-cyan/10 px-3 font-mono text-[13px] font-semibold text-cyan">
                ${showSymbol(ix.symbol)}
              </span>
              <ChainBadge chainId={chainId} size="logo" />
              {/* the door UP to the whole idea, when this basket is one leg of
                  a cross-chain thesis — the strip's own eyebrow language, as a
                  pill in the identity row (owner 2026-08-09: the thesis flow
                  exists; a leg should never hide it). */}
              {partOfThesis && (
                <Link
                  to={thesisHref(partOfThesis.deployer, partOfThesis.name)}
                  className="press inline-flex h-8 items-center gap-1.5 rounded-full border border-violet/30 bg-violet/[0.08] px-3 font-mono text-[13px] text-violet-bright transition-colors hover:border-violet/60"
                >
                  one idea · {partOfThesis.chainIds.length} networks
                  <span aria-hidden>→</span>
                </Link>
              )}
              <CopyChip text={addr} label={shortAddr(addr)} pill size="md" />
              {fees && (
                <span className="inline-flex h-8 items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] px-3 font-mono text-[13px] text-ink-dim">
                  <span className="font-semibold text-ink">
                    {(fees.basketFeeBps / 100).toFixed(2).replace(/\.?0+$/, '')}%
                  </span>
                  fee
                </span>
              )}
              {/* the "N assets · one token" pill left on the owner's 0903 note —
                  the fee pill beside the address is the row's fourth fact now,
                  and the holdings header still counts the assets. */}
              {/* personal watchlist toggle for this basket (browser-only) */}
              <WatchButton basket={addr} chainId={chainId} variant="icon" className="h-8 w-8" />
              {/* SHARE, RE-SURFACED IN THE ROW (owner 2026-08-18 0929, on
                  creator-flow feedback: the share and referral doors are "too
                  hidden" here). The standalone Share button left this page on
                  the 2026-08-07 "people have the URL anyway" note; this is the
                  recorded reversal, small — one icon in the pill family that
                  raises the SAME ShareModal the launch banner and the ?share=1
                  journey door raise. One surface, three doors. */}
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                aria-label="Share this basket"
                title="Share this basket — the card, share on X, copy the link"
                className="press inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
                  <path d="M16 6l-4-4-4 4" />
                  <path d="M12 2v13" />
                </svg>
              </button>
              <RefLinkChip basket={addr} chainId={chainId} />
            </div>

            {/* THE THESIS rides directly under the pills now (owner 2026-08-03
                live: "The Big Three… should go where the sentence currently
                is") — the creator's words are the page's second read.
                ⚠ The what-is-a-basket sentence used to live in the ⓘ on the
                assets-count pill, and that pill left on 2026-08-07 — so this
                page no longer explains anywhere what a basket IS. That was a
                side effect of removing the pill, not a decision to drop the
                explanation; it needs an owner call on whether it re-homes
                (the fee pill's ⓘ is the obvious host) or stays gone. */}
            <CreatorThesis basket={addr} chainId={chainId} meta={meta} deployer={ix.deployer} />
          </div>

          {/* price — the label row is 24h + the percent and NOTHING else (owner
              2026-08-07 0903: no "Price" word, no since-launch, no ⓘ) */}
          <div className={`relative z-10 shrink-0 transition-opacity duration-700 sm:text-right ${intro === 'swirl' ? 'opacity-0' : 'opacity-100'}`}>
            <div className="flex items-center gap-2.5 sm:justify-end">
              <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-ink-dim">24h</span>
              <span
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-num text-sm font-semibold tabular-nums"
                style={{ color: accent, background: `${accent}1f` }}
              >
                {ix.change24hPct != null && (
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden>
                    <path d={(ix.change24hPct ?? 0) >= 0 ? 'M12 5l7 10H5z' : 'M12 19L5 9h14z'} />
                  </svg>
                )}
                {formatPct(ix.change24hPct)}
              </span>
            </div>
            <div className="mt-3 font-num text-5xl font-light leading-[0.95] tabular-nums text-ink sm:text-6xl md:text-7xl">
              ${formatNav(navUp)}
            </div>
            {ix.navSource === 'onchain' && !ix.fullyPriced && (
              <div className="mt-1.5 font-mono text-[10px] text-amber-300/80">Not fully priced</div>
            )}
            {diverged && (
              <div className="mt-1.5 font-mono text-[10px] text-alert">
                Diverges {ix.navDivergencePct!.toFixed(1)}% from spot · see docs
              </div>
            )}

            {/* who made it — top right, under the price (owner 2026-08-03) */}
            <CreatorByline
              basket={addr}
              chainId={chainId}
              creator={creator}
              meta={meta}
              deployer={ix.deployer}
              sig={sig}
              viewer={viewer}
            />

            {/* the constituents at a glance: overlapping logo discs, heaviest
                first (and on top), dark rims lifting them off the warp. They
                now hang under the price on the RIGHT, sharing its alignment
                (owner 2026-08-01) — the left column is the reading column. */}
            <div className="mt-12 flex items-center sm:justify-end">
              {[...holdings]
                .sort((a, b) => b.targetWeightPct - a.targetWeightPct)
                .slice(0, 7)
                .map((h, i, top) => (
                  <span
                    key={h.asset}
                    title={`${showSymbol(h.symbol)} · ${h.targetWeightPct.toFixed(0)}%`}
                    className={`relative rounded-full ring-[3px] ring-panel/90 shadow-[0_4px_14px_rgba(0,0,0,0.5)] transition-transform duration-200 hover:-translate-y-0.5 ${i > 0 ? '-ml-4' : ''}`}
                    style={{ zIndex: top.length - i }}
                  >
                    <AssetLogo address={h.asset} symbol={h.symbol} chainId={chainId} size={52} />
                  </span>
                ))}
              {holdings.length > 7 && (
                <span className="z-0 -ml-4 grid h-[52px] w-[52px] place-items-center rounded-full bg-white/10 font-mono text-[12px] font-semibold text-ink ring-[3px] ring-panel/90 backdrop-blur-sm">
                  +{holdings.length - 7}
                </span>
              )}
            </div>
          </div>
          </div>

          {/* version controls, centred on their own header row (owner
              2026-08-01). The deployer's two actions — link the predecessor
              when the launch-time publish was skipped, or cut a new version —
              sit above the public lineage strip. Both are deployer-restricted
              and render null for everyone else, so the row itself only exists
              when there is something in it. */}
          {((DEPLOY_ENABLED && isDeployer) || lineage.count > 1) && (
            <div className={`relative z-10 mt-8 flex flex-col items-center gap-3 border-t border-white/10 pt-6 transition-opacity duration-700 ${intro === 'swirl' ? 'opacity-0' : 'opacity-100'}`}>
              {DEPLOY_ENABLED && isDeployer && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <LinkPredecessorButton
                    basket={addr}
                    deployer={ix.deployer}
                    chainId={chainId}
                    hasPredecessor={lineage.hasPredecessor}
                    meta={meta ?? null}
                  />
                  <VersionButton
                    basket={addr}
                    deployer={ix.deployer}
                    chainId={chainId}
                    prominent
                    holdings={ix.holdings.map((h) => ({ chainId, address: h.asset, symbol: h.symbol, weightPct: h.targetWeightPct }))}
                  />
                </div>
              )}
              {lineage.count > 1 && (
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <VersionStrip lineage={lineage} current={addr} chainId={chainId} />
                </div>
              )}
            </div>
          )}
          </>)}
        </div>

        {/* everything below the hero mounts only AFTER the intro settles — the
            hero (swirl included) is the whole page until then, and the chart /
            swap / holdings rise in beneath it. Until that moment the skeleton
            holds those regions (QOL 2026-08-05): pulsing while the read is in
            flight, then still for the half-second of reveal, so the page never
            shows the reader an empty card. */}
        {!bodyReady && <BasketBodySkeleton reading={!loaded} />}
        {bodyReady && (
        <div className="content-rise">

        {/* THE ITERATE LOOP's completion strip: one signature turns the
            recorded intent into the signed lineage. Deployer-only by
            construction (versionIntent derives behind isDeployer). */}
        {intentApplies && versionIntent && (
          <div
            className="relative flex flex-col items-start gap-3 overflow-hidden border-b border-white/10 px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
            style={{ background: 'linear-gradient(90deg, rgba(53,224,255,0.08), rgba(164,139,255,0.06) 60%, transparent)' }}
          >
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1 opacity-60" style={{ background: 'linear-gradient(180deg,var(--color-cyan),var(--color-violet-bright))' }} />
            <span className="relative text-sm leading-relaxed text-ink">
              You cut this as a new version of{' '}
              <span className="font-semibold text-cyan">
                ${symbolOf(versionIntent.predecessor) ?? shortAddr(versionIntent.predecessor)}
              </span>
              {' '}— one signature links the lineage, and this site&rsquo;s old links start answering with this page.
            </span>
            <span className="relative flex shrink-0 items-center gap-3">
              <LinkPredecessorButton
                basket={addr}
                deployer={ix.deployer}
                chainId={chainId}
                hasPredecessor={lineage.hasPredecessor}
                meta={meta ?? null}
                initialPredecessor={versionIntent.predecessor}
              />
              <button
                type="button"
                onClick={() => {
                  clearVersionIntent(ix.deployer, chainId)
                  setIntentDismissed(true)
                }}
                className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:text-ink"
              >
                not a version
              </button>
            </span>
          </div>
        )}

        {/* ONE LINK, EVERY VERSION — the honest strip when a shared link to an
            older version landed here and the page canonicalized forward: say
            which version the link named, offer the exact view of it, and give
            holders of the old version their upgrade door in place. */}
        {forwarded && arrived && (
          <div
            className="relative flex flex-col items-start gap-3 overflow-hidden border-b border-white/10 px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
            style={{ background: 'linear-gradient(90deg, rgba(164,139,255,0.10), rgba(53,224,255,0.05) 60%, transparent)' }}
          >
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1 opacity-60" style={{ background: 'linear-gradient(180deg,var(--color-violet-bright),var(--color-cyan))' }} />
            <span className="relative text-sm leading-relaxed text-ink">
              Your link named{' '}
              <span className="font-semibold">v{arrivedLineage.version} · ${showSymbol(symbolOf(arrived) ?? '?')}</span> — this is the
              creator&rsquo;s current version, <span className="font-semibold text-cyan">v{lineage.count} · ${showSymbol(ix.symbol)}</span>.
              The old version keeps trading through its own contracts.
            </span>
            <span className="relative flex shrink-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setMigrateOpen(true)}
                className="press rounded-xl border border-cyan/40 px-4 py-2 font-display text-xs font-bold uppercase tracking-[0.14em] text-cyan transition-colors hover:border-cyan hover:bg-cyan/10"
              >
                Hold ${symbolOf(arrived) ?? '?'}? Upgrade →
              </button>
              <Link
                to={`${basketHref({ symbol: symbolOf(arrived) ?? '', address: arrived, chainId })}?v=exact`}
                className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:text-ink"
              >
                view v{arrivedLineage.version} exactly
              </Link>
            </span>
          </div>
        )}

        {/* a newer version exists → opt-in upgrade (read-only callout) — bigger,
            brighter bar with a prominent CTA (owner ask) */}
        {lineage.hasSuccessor && lineage.head && (
          <div className="relative flex flex-col items-start gap-3 overflow-hidden border-b border-cyan/20 px-6 py-4 sm:flex-row sm:items-center sm:justify-between" style={{ background: 'linear-gradient(90deg, rgba(53,224,255,0.14), rgba(164,139,255,0.08) 60%, transparent)' }}>
            <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1" style={{ background: 'linear-gradient(180deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
            <span className="relative flex items-center gap-2.5 text-sm leading-relaxed text-ink">
              <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-cyan/20 text-cyan">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </span>
              <span>
                <span className="font-semibold text-cyan">${showSymbol(headSymbol)}</span> (v{lineage.count}) is available, swap at your discretion.
              </span>
            </span>
            <button
              type="button"
              onClick={() => setMigrateOpen(true)}
              className="press relative shrink-0 rounded-xl px-5 py-2.5 font-display text-sm font-bold uppercase tracking-[0.14em] text-black shadow-[0_0_24px_-6px_rgba(62,240,200,0.7)] transition-transform hover:scale-[1.02]"
              style={{ background: 'linear-gradient(90deg,#3ef0c8,#0e9f6e)' }}
            >
              Review upgrade →
            </button>
          </div>
        )}

        {/* THE MONEY STORY — the page's plainest sentence, first thing after
            identity: $100 in, what it reads as now, beside just-holding. */}
        <MoneyStory ix={ix} chainId={chainId} />

        {/* ── chart column (left) · swap rail (right), same card ────── */}
        <div className="grid lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 lg:border-r lg:border-white/10">
        <div className="border-b border-white/10 px-4 py-5 sm:px-6">
          <BasketChart
            chainId={chainId}
            address={ix.address}
            assets={ix.holdings.map((h) => ({
              address: h.asset,
              weight: h.liveWeightPct > 0 ? h.liveWeightPct : h.targetWeightPct,
            }))}
            navPerToken={ix.navPerToken}
            ageSec={ix.ageHours != null ? ix.ageHours * 3600 : null}
            symbol={`$${showSymbol(ix.symbol)}`}
            fallback={ix.navSeries}
            underlyingAssets={ix.holdings.map((h) => ({ address: h.asset, symbol: h.symbol, change24hPct: h.change24hPct }))}
            change24hPct={ix.change24hPct}
            // Taller on desktop (owner 2026-08-01: "make the chart area a bit
            // bigger"). It also keeps the grid honest now that the assets table
            // and stats moved out from under it — otherwise the chart column
            // ends well short of the swap rail beside it. 432 = 18 × the 24px
            // vertical rhythm.
            heightClass="h-64 sm:h-72 lg:h-[432px]"
            className="w-full"
          />
        </div>

        {/* what changed vs the previous version — ABOVE the assets on a new-version
            basket (owner 2026-07-07); on-chain facts only, hidden otherwise */}
        {lineage.hasPredecessor && lineage.predecessor && (
          <div className="border-b border-white/10 px-4 py-5 sm:px-6">
            <WhatChanged predSymbol={predSymbol} prevAddr={lineage.predecessor} nextAddr={addr} chainId={chainId} deployer={ix.deployer} isDeployer={isDeployer} />
          </div>
        )}

        {/* The assets table and the stats row used to live here, inside the
            chart column; they run FULL WIDTH below the grid now (owner
            2026-08-01) so they carry on under the swap rail too. */}

        </div>

        {/* ── swap rail: beside the chart, same card (sticky within).
               min-w-0 is load-bearing: without it the rail's min-content (the
               amount input's intrinsic width) inflates the shared grid track
               past narrow viewports ─── */}
        <div className="min-w-0 border-t border-white/10 p-4 sm:p-6 lg:border-t-0">
          <div className="space-y-4 lg:sticky lg:top-24">
            {/* your holdings — top of the rail, buy/sell right below (owner
                2026-08-01: chart left, holdings right, console beneath).
                Shows whenever the connected wallet owns this basket. */}
            <PositionPnl basket={addr} chainId={chainId} navPerToken={ix.navPerToken} symbol={ix.symbol} />

            {/* optional operator-configured external app link (VITE_PARTNER_APP_URL);
                unset by default → no CTA renders (the package anoints no venue). */}
            {partnerUrl && (
              <a
                href={partnerUrl}
                target="_blank"
                rel="noreferrer"
                className="flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 font-display text-sm font-bold uppercase tracking-wide transition-transform hover:scale-[1.01] active:scale-[0.96]"
                style={{ background: sig, color: buyInk }}
              >
                Visit ${showSymbol(ix.symbol)}
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 17L17 7M7 7h10v10" />
                </svg>
              </a>
            )}

            {/* the full DEX console, locked to this basket (replaces the old
                fixed-direction TradePanel). id anchors the phone mini-buy bar's
                scroll (below). */}
            {SWAP_ENABLED && (
              <div id="buy-console" ref={buyConsoleRef} className="scroll-mt-24 space-y-3">
                {/* mint pre-flight: a structurally dead constituent makes every
                    buy revert — say so BEFORE money is typed in (renders
                    nothing while healthy or unknowable) */}
                <DeadLegNotice address={addr} chainId={chainId} />
                <DexSwapCard chainId={chainId} fixedBasket={ix} />
              </div>
            )}


            {/* add-to-wallet right under the swap (owner 2026-07-06) — the
                natural next step after a buy; self-hides without a wallet */}
            <div className="flex justify-center">
              <AddToWalletButton address={addr} symbol={ix.symbol} chainId={chainId} />
            </div>

            {/* the quiet create door (owner 1826: "below the swap area… just a
                very subtle create your own basket"). A footnote, not a CTA —
                this rail's job is converting THIS basket, so the door whispers.
                Rides the flow's own gate; ships dark with it. */}
            {pageEnabled(brand.pages, 'launch') && (
              <div className="text-center">
                {/* the footnote keeps its whisper but gets a thumb (mobile
                    sweep 2026-08-06: 178×13px, floating in a 40px dead band) */}
                <Link
                  to="/create"
                  className="inline-flex min-h-[36px] items-center px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors hover:text-ink"
                >
                  create your own basket →
                </Link>
              </div>
            )}

            {/* created-by + the thesis used to close this rail; both moved into
                the header on 2026-08-01 so the thesis reads across the card's
                width instead of down a 380px column. */}
          </div>
        </div>
        </div>

        {/* ── HOLDINGS, one home (owner 2026-08-03 live: "we show the bento
               grid twice, remove the bottom bento grid" — HoldingsView's
               visual/list section is gone; this block carries the job). The
               bento is the portfolio system's own picture — weight-true tiles,
               money footers, hover 7d previews (`expandable`) — and the table
               below it is the numbers' home. FULL WIDTH under both columns
               (owner 2026-08-01). ─────────── */}
        <div className="border-t border-white/10 px-4 py-5 sm:px-6">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-sm font-bold uppercase tracking-[0.18em] text-ink">
              Holdings <span className="font-mono text-[11px] font-normal normal-case tracking-normal text-ink-faint">· {ix.holdings.length} assets</span>
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              {/* a hover instruction on a touch device is a promise the device
                  cannot keep (mobile sweep 2026-08-06) — sm+ only */}
              <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">hover a tile to preview its 7d chart</span>
              {ix && ((DEPLOY_ENABLED && isDeployer) || isDemoAddr) && (
            <div className="inline-flex flex-wrap items-center gap-2 rounded-xl border border-white/12 bg-white/[0.03] py-1 pl-3 pr-1">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">
                your creator tools
              </span>
              {/* Reshape — the creator's edit door (the owner 2026-08-10):
                  reweight or edit THIS basket in a popup. Shipping is a NEW
                  immutable version (never mutation); the old basket's page
                  grows the version strip and holders migrate on their own
                  schedule. Creator-only on real baskets (and only on builds
                  that can deploy, VersionButton's own gate); a demo subject
                  shows it to anyone so the scripted walkthrough stays
                  reachable. */}
              <button
                type="button"
                onClick={() => setReshapeOpen(true)}
                className="press inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
                title="Reweight or edit this basket — ships a new version holders can swap into"
              >
                Reshape
              </button>
              {/* Add to a bundle (the owner 2026-08-10) — the join door, beside
                  the reshape it rides on, plus one more fact: the creator
                  must HAVE another multi-chain thesis this basket isn't
                  already part of, or the pill sells an empty picker. Violet,
                  because the thesis surfaces are violet (the "one idea ·
                  N chains" pill above). */}
              {joinableTheses.length > 0 && (
                <button
                  type="button"
                  onClick={() => setJoinOpen(true)}
                  className="press inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] text-ink-dim transition-colors hover:border-violet/60 hover:text-violet-bright"
                  title="Ship a version of this basket under one of your bundles' names — the name is what joins it"
                >
                  Add to a bundle
                </button>
              )}
            </div>
          )}
            </div>
          </div>
          <BasketBento
            items={ix.holdings.map((h) => ({
              symbol: h.symbol,
              address: h.asset,
              chainId,
              id: `${chainId}:${h.asset.toLowerCase()}`,
              weightPct: h.liveWeightPct > 0 ? h.liveWeightPct : h.targetWeightPct,
              footer:
                h.valueUsd > 0
                  ? { amount: formatUsdCompact(h.valueUsd), change24hPct: h.change24hPct }
                  : undefined,
            }))}
            aspect={3.2}
            expandable
          />
          <div className="mt-5">
            <AssetsTable holdings={ix.holdings} chainId={chainId} />
          </div>
        </div>

        {/* ── key stats + returns, full width on the same rule ───────── */}
        <div className="border-t border-white/10 px-6 py-5">
          <BasketStats ix={ix} chainId={chainId} />
        </div>


        {/* ── the holder wall: emoji signatures from wallets that hold this
               basket, with chain-proven age + size (owner 2026-07-29). Renders
               nothing until the chain has a notes registry configured. ── */}
        {chainCfg(chainId).notesRegistry && (
          <div className="border-t border-white/10 p-4 sm:p-6">
            <HolderWall
              basket={addr as Address}
              chainId={chainId}
              symbol={ix.symbol}
              decimals={ix.decimals}
              totalSupply={ix.totalSupply}
            />
          </div>
        )}

        {/* ── deployer-only: get this basket listed & discoverable (owner
               2026-07-07). Same isDeployer gate as the version actions; renders
               nothing for everyone else. Also lives in the creator dashboard. ── */}
        {isDeployer && (
          <div className="border-t border-white/10 p-4 sm:p-6">
            <ListingPipeline addr={addr} symbol={ix.symbol} name={ix.name} decimals={ix.decimals} chainId={chainId} />
          </div>
        )}

        {/* ── the card's bottom: full fee waterfall + contract facts — reference
               material, folded behind one disclosure so the page ends at the
               holdings unless you ask for the fine print (owner ask 2026-07-05). ── */}
        <details className="group border-t border-white/10">
          <summary className="press flex cursor-pointer list-none items-center justify-between gap-3 p-4 hover:bg-white/[0.015] sm:px-6 sm:py-5">
            <span className="flex min-w-0 items-baseline gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Fees &amp; contract</span>
              <span className="hidden truncate font-mono text-[10px] text-ink-faint sm:inline">
                {fees ? `basket fee ${(fees.basketFeeBps / 100).toFixed(2)}% · ` : ''}where it goes · addresses · the redemption guarantee
              </span>
            </span>
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="shrink-0 text-ink-faint transition-transform duration-200 group-open:rotate-180"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </summary>
          <div className="grid gap-4 px-4 pb-4 sm:px-6 sm:pb-6 lg:grid-cols-2">
          <FeePanel address={addr} chainId={chainId} />

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <div className="mb-4 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Contract</span>
              <span className="rounded-full border border-white/12 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
                fully onchain
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyChip text={addr} label={shortAddr(addr)} />
              <a
                href={`${chainCfg(chainId).explorer}/token/${addr}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-ink-dim press hover:border-cyan/50 hover:text-ink"
              >
                View on {explorerName}
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 17L17 7M7 7h10v10" />
                </svg>
              </a>
              {ix && <AddToWalletButton address={addr} symbol={ix.symbol} chainId={chainId} />}
            </div>
            <div className="mt-4 space-y-2.5 border-t border-white/10 pt-3.5">
              <p className="text-[13px] leading-relaxed text-ink-dim">
                This basket is a token that lives entirely onchain. This website is just a window onto it,
                every action works directly against the contract, with or without us.
              </p>
              <p className="text-[13px] leading-relaxed text-ink-dim">
                Your tokens can <span className="font-semibold text-ink">always</span> be redeemed for their share
                of the underlying assets, straight from the contract, even if every trading pool disappears.
              </p>
            </div>
          </div>
          </div>
        </details>
        </div>
        )}
      </div>

      {/* ecosystem credit — links out to PrismBeat (owner 2026-07-30) */}
      <div className="mt-8 flex justify-center">
        <PoweredByPrism />
      </div>

      {/* phone mini-buy: fixed above the tab bar once the console is out of
          view; tap scrolls back to the one real console (mobile UX review 1) */}
      {SWAP_ENABLED && ix && buyBarShow && (
        <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-40 border-t border-line bg-void/90 px-4 py-2.5 backdrop-blur-xl lg:hidden">
          <div className="mx-auto flex max-w-md items-center gap-3">
            <BasketAvatar address={ix.address} symbol={ix.symbol} size={30} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate font-display text-sm font-bold text-ink">${showSymbol(ix.symbol)}</div>
              <div className="font-num text-[11px] tabular-nums text-ink-dim">${formatNav(navUp, 4)}</div>
            </div>
            <button
              type="button"
              onClick={() => document.getElementById('buy-console')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="press shrink-0 rounded-xl px-5 py-2 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-black"
              style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
            >
              Buy ${showSymbol(ix.symbol)}
            </button>
          </div>
        </div>
      )}

      {ix && (
        <>
          <MigrateModal
            open={migrateOpen}
            onClose={() => setMigrateOpen(false)}
            // Forward-resolved view: the visitor's held tokens are the OLD
            // version their link named — migrate FROM that, TO the head shown.
            fromAddr={forwarded && arrived ? arrived : addr}
            fromSymbol={forwarded && arrived ? (symbolOf(arrived) ?? '?') : ix.symbol}
            toAddr={lineage.head ?? addr}
            toSymbol={forwarded ? ix.symbol : headSymbol}
            chainId={chainId}
          />

          {/* the forge, over this page, with this basket already loaded */}
          {forgeOpen && (
            <BundleForge seed={{ chainId, address: addr }} overlay onClose={() => setForgeOpen(false)} />
          )}

          <CreatorSetupModal
            open={creatorSetupOpen}
            onClose={() => setCreatorSetupOpen(false)}
            symbol={ix.symbol}
            handle={myHandle.lookup.status === 'found' ? myHandle.lookup.owner.display : null}
            creatorHref={myHandle.lookup.status === 'found' ? `/creator/${myHandle.lookup.owner.display}` : null}
          />
          <ShareModal
            open={shareOpen}
            onClose={() => {
              setShareOpen(false)
              // the ceremony's share journey ENDS on the bundle's page
              // (owner 2026-08-16) — only when the door said so via ?then=
              if (shareThen) {
                setShareThen(null)
                navigate(shareThen)
              }
            }}
            symbol={ix.symbol}
            name={ix.name || ix.symbol}
            addr={addr}
            chainId={chainId}
            sig={sig}
            buyInk={buyInk}
            holdings={ix.holdings}
            navPerToken={ix.navPerToken}
            ageHours={ix.ageHours}
            by={deployerName.status === 'found' ? deployerName.owner.display : null}
            navSeries={ix.navSeries}
          />
        </>
      )}

      {/* the reshape popup — mounted with the page's other modals. Demo
          subjects run the scripted ceremony; real ones deploy the new version
          and sign its lineage (the modal owns every stage and honesty rail). */}
      {reshapeOpen && (
        <ReshapeBasketModal
          address={addr as `0x${string}`}
          chainId={chainId}
          demo={isDemoAddr}
          onClose={() => setReshapeOpen(false)}
        />
      )}

      {/* the join doors — the shared picker owns both steps: choose the
          bundle, then the same reshape popup in join mode carrying the picked
          name (the rename IS the join). */}
      {joinOpen && ix && (
        <JoinBundlePicker
          bundles={joinableTheses}
          subject={{ address: addr as `0x${string}`, chainId, symbol: ix.symbol }}
          demo={isDemoAddr}
          onClose={() => setJoinOpen(false)}
        />
      )}
    </div>
  )
}


// ── per-asset detail: the holdings as facts — live price, 24h, weight, value ──
function AssetsTable({ holdings, chainId }: { holdings: Holding[]; chainId: number }) {
  const rows = [...holdings].sort((a, b) => b.valueUsd - a.valueUsd)
  return (
    <div>
      {/* the section title moved to the Holdings header above (one home,
          owner 2026-08-03) — the table opens straight into its rows. */}
      {/* THE TABLE SCROLLS AND SAYS SO (mobile sweep 2026-08-06): five columns
          at min-w-26rem (416px) inside a 324px scroller put "Share of basket"
          and "Value held" fully off-screen with no affordance, and scrolling
          right left rows reading "ROKER" because the asset column was not
          sticky. Now: the asset column pins, the headers keep their words
          (nowrap — they crushed to "SHAR/BA"), and a fade at the right edge
          says there is more. */}
      <div className="relative">
        <div className="scrollbar-none overflow-x-auto">
        <table className="w-full min-w-[26rem] border-separate border-spacing-0 text-left">
          <thead>
            <tr className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
              {/* card-mask, NOT bg-panel: the pinned cells must hide rows
                  scrolling beneath them without painting a darker box on the
                  card (the 0903 "black square" — panel ≠ the glass's pixel) */}
              <th className="card-mask sticky left-0 z-10 pb-2 pr-3 font-normal">Asset</th>
              {/* pl-4: nowrap headers with no inset ran together ("24HSHARE") */}
              <th className="whitespace-nowrap pb-2 pl-4 text-right font-normal">Price</th>
              <th className="whitespace-nowrap pb-2 pl-4 text-right font-normal">24h</th>
              <th className="whitespace-nowrap pb-2 pl-4 text-right font-normal">Share of basket</th>
              <th className="whitespace-nowrap pb-2 pl-4 text-right font-normal">Value held</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => {
              const w = h.liveWeightPct > 0 ? h.liveWeightPct : h.targetWeightPct
              return (
                <tr key={h.asset} className="group">
                  {/* sticky: scrolling to the money columns used to leave the
                      rows anonymous ("ROKER", "binhood Token") */}
                  <td className="card-mask sticky left-0 z-10 border-t border-white/[0.06] py-2.5 pr-3">
                    <span className="flex items-center gap-2.5">
                      <AssetLogo address={h.asset} symbol={h.symbol} chainId={chainId} size={24} />
                      <span className="min-w-0">
                        <span className="block font-display text-sm font-semibold uppercase tracking-wide text-ink">{showSymbol(h.symbol)}</span>
                        <span className="block truncate font-mono text-[9px] text-ink-faint">{h.name}</span>
                      </span>
                    </span>
                  </td>
                  <td className="border-t border-white/[0.06] py-2.5 pl-4 text-right font-num text-sm tabular-nums text-ink">
                    {h.priced ? formatPrice(h.priceUsd) : '—'}
                  </td>
                  <td className={`border-t border-white/[0.06] py-2.5 pl-4 text-right font-num text-sm tabular-nums ${
                    h.change24hPct == null ? 'text-ink-faint' : h.change24hPct >= 0 ? 'text-teal' : 'text-magenta'
                  }`}>
                    {h.change24hPct == null ? '—' : `${h.change24hPct >= 0 ? '+' : ''}${h.change24hPct.toFixed(1)}%`}
                  </td>
                  <td className="border-t border-white/[0.06] py-2.5 pl-4 text-right font-num text-sm tabular-nums text-ink-dim">
                    {w.toFixed(1)}%
                  </td>
                  <td className="border-t border-white/[0.06] py-2.5 pl-4 text-right font-num text-sm tabular-nums text-ink-dim">
                    {h.priced && h.valueUsd > 0 ? formatUsdCompact(h.valueUsd) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
        {/* the "there is more to the right" mark — decorative, never over the
            sticky asset column, and gone from sm up where the table fits */}
        <span
          aria-hidden
          className="card-mask card-mask-fade-l pointer-events-none absolute inset-y-0 right-0 w-10 sm:hidden"
        />
      </div>
    </div>
  )
}
