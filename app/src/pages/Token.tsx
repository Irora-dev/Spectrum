import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { Address } from 'viem'
import { useBasketData, useCreatorMeta, useLineage, useAllBaskets } from '../lib/spectrum/hooks'
import type { Holding } from '../lib/spectrum/basket-data'
import { useBasketFees } from '../lib/spectrum/use-basket-fees'
import { chainCfg } from '../lib/chain/chains'
import { BasketAvatar } from '../components/BasketAvatar'
import { AssetLogo } from '../components/AssetLogo'
import { ChainBadge } from '../components/ChainBadge'
import { BasketChart } from '../components/BasketChart'
import { BasketStats } from '../components/BasketStats'
import { HoldingsView } from '../components/HoldingsView'
import { HolderWall } from '../components/HolderWall'
import { useQueryClient } from '@tanstack/react-query'
import { usePublicClient, useWriteContract } from 'wagmi'
import { NOTE_KINDS, notesRegistryAbi } from '../lib/spectrum/profile-registry'
import { MAX_POST_CHARS, encodeUpdateNoteJson, useVersionNote } from '../lib/spectrum/notes-social'
import { DexSwapCard } from '../components/DexSwapCard'
import { FeePanel } from '../components/FeePanel'
import { VersionStrip } from '../components/VersionStrip'
import { VersionButton } from '../components/VersionButton'
import { LinkPredecessorButton } from '../components/LinkPredecessor'
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
import { useCountUp } from '../lib/motion'
import { resolveCreator } from '../lib/spectrum/creator'
import { DEPLOY_ENABLED, SWAP_ENABLED } from '../lib/config/features'
import { useAccount } from 'wagmi'
import { AddToWalletButton } from '../components/AddToWalletButton'
import { ListingPipeline } from '../components/ListingPipeline'
import { SeedBasketModal } from '../components/SeedBasketModal'
import { ThesisEditor } from '../components/ThesisEditor'
import { PoweredByPrism } from '../components/PoweredByPrism'
import { resolveAsset, seedLaunchDraft } from '../components/launch/BasketBuilder'
import { isRetryableDetection } from '../lib/pools'
import { setActiveChainId } from '../lib/chain/active-chain'
import brand from '../brand.config'
import { pageEnabled } from '../theme/brand'

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="py-10">
      <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-ink-faint">
        {children}
      </div>
    </div>
  )
}

// Opens the ShareModal — the same share surface deployers get post-launch,
// available to any viewer (holder or not).
function ShareButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] text-ink-dim press hover:border-cyan/50 hover:text-cyan"
    >
      Share
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 17L17 7M7 7h10v10" />
      </svg>
    </button>
  )
}

// Remix (lab 2026-07-28): seed the launch builder with THIS basket's recipe —
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
      navigate('/launch')
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
              A new version of ${predSymbol}. The previous version stays live and immutable; holders
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


export function Token() {
  const [params] = useSearchParams()
  const addr = params.get('addr') ?? undefined
  const chainId = Number(params.get('chain')) || 8453
  const { data: ix, isLoading, isError } = useBasketData(addr, chainId)
  // count the headline price up once the basket resolves (hook stays unconditional)
  const navUp = useCountUp(ix?.navPerToken ?? 0, !!ix)
  // Verified, deployer-signed creator metadata (null until published + verified).
  const { data: meta } = useCreatorMeta(addr, chainId)
  // Version lineage (deployer-signed `supersedes` claims) + the full list for symbols.
  const lineage = useLineage(addr, chainId)
  const { data: allBaskets } = useAllBaskets()
  // The headline fee % is surfaced in the hero; the full waterfall reads at
  // the bottom of the card (FeePanel re-uses the same cached query).
  const { data: fees } = useBasketFees(addr, chainId)
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const { address: viewer } = useAccount()

  // Phone mini-buy bar (mobile UX review 1): below lg the grid linearizes and
  // the swap rail lands 3-4 screens deep on the page whose job is converting.
  // A slim fixed bar above the tab bar appears once the console has scrolled
  // out of reach; tapping it scrolls back to the console. Observation, not a
  // second console — one state machine, no keyboard fights.
  const [buyBarShow, setBuyBarShow] = useState(false)
  useEffect(() => {
    if (!SWAP_ENABLED) return
    const el = document.getElementById('buy-console')
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setBuyBarShow(!e.isIntersecting), { rootMargin: '0px 0px -20% 0px' })
    io.observe(el)
    return () => io.disconnect()
    // re-observe when the basket resolves (the console mounts with ix)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addr, !!ix])

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

  if (!addr) return <Notice>No basket address provided (?addr=0x…).</Notice>
  if (isError || (!ix && !isLoading)) return <Notice>Couldn&rsquo;t load this basket. Try again, or check the RPC configuration.</Notice>

  // NO loading skeleton: while the basket loads, the hero warp IS the loading
  // state — mounted immediately on a provisional palette (the address-seeded
  // signature + brand hues) and retinted live to the basket's real colors the
  // moment data lands. Everything data-dependent below simply waits.
  const holdings = ix?.holdings ?? []
  // Attribution: verified creator metadata (handle/name) when published + signed
  // by the on-chain deployer, else the deployer address (the honest fallback).
  const creator = ix
    ? resolveCreator({ handle: meta?.handle, name: meta?.name, deployer: ix.deployer, basketAddress: addr })
    : null
  const isDeployer = !!viewer && !!ix?.deployer && viewer.toLowerCase() === ix.deployer.toLowerCase()
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
    : [sig, 'var(--color-violet)', 'var(--color-magenta)']
  const explorerName = chainId === 1 ? 'Etherscan' : chainId === 4663 ? 'Blockscout' : 'Basescan'
  const justDeployed = params.get('deployed') === '1'
  const partnerUrl = partnerAppUrl(addr)
  const diverged = ix != null && ix.navDivergencePct != null && ix.navDivergencePct > 2
  const symbolOf = (a?: string | null) =>
    a ? allBaskets?.find((b) => b.address.toLowerCase() === a.toLowerCase())?.symbol : undefined
  const headSymbol = symbolOf(lineage.head) ?? '?'
  const predSymbol = symbolOf(lineage.predecessor) ?? '?'

  return (
    <div className="py-6">
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
          onShare={() => setShareOpen(true)}
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <Link
          to="/"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint press hover:text-ink"
        >
          ← All baskets
        </Link>
        <div className="flex items-center gap-2">
          {ix && <RemixButton holdings={ix.holdings} chainId={chainId} />}
          <ShareButton onClick={() => setShareOpen(true)} />
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

        {/* ── header: identity (left) · price (right) — the hero gets real
               breathing room: taller padding, wider gaps, larger scale ──── */}
        <div className={`relative flex min-h-[260px] flex-col gap-8 overflow-hidden border-b px-6 py-8 transition-colors duration-700 sm:flex-row sm:items-start sm:justify-between sm:gap-12 sm:px-10 sm:py-12 ${intro === 'swirl' ? 'rounded-2xl border-transparent' : 'border-white/10'}`}>
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
          {/* identity — absent until data lands, hidden while the intro swirls */}
          {ix && creator && (<>
          <div className={`relative z-10 flex flex-col gap-5 transition-opacity duration-700 ${intro === 'swirl' ? 'opacity-0' : 'opacity-100'}`}>
            <h1 className="break-words font-display text-4xl font-bold uppercase leading-[0.92] tracking-tight text-ink sm:text-5xl md:text-6xl">
              {ix.name || ix.symbol}
            </h1>

            {/* pill family under the title: ticker · chain · copyable address ·
                headline fee, one 24px rounded-full badge set. The address is
                the basket's one unforgeable identity; the full fee waterfall
                reads at the card's bottom. */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-6 items-center rounded-full bg-white/10 px-2.5 font-mono text-[11px] font-semibold text-cyan">
                ${ix.symbol}
              </span>
              <ChainBadge chainId={chainId} className="h-6 px-2.5" />
              <CopyChip text={addr} label={shortAddr(addr)} pill />
              {fees && (
                <span className="inline-flex h-6 items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] px-2.5 font-mono text-[11px] text-ink-dim">
                  <span className="font-semibold text-ink">
                    {(fees.basketFeeBps / 100).toFixed(2).replace(/\.?0+$/, '')}%
                  </span>
                  fee
                </span>
              )}
              {/* personal watchlist toggle for this basket (browser-only) */}
              <WatchButton basket={addr} chainId={chainId} variant="icon" className="h-6 w-6" />
            </div>

            {/* the constituents at a glance: overlapping logo discs, heaviest
                first (and on top), dark rims lifting them off the warp — with the
                deployer's version actions riding the SAME row on the right
                (owner 2026-07-07: side by side next to the token icons, matched
                pills, never stacking under the hero and pushing it down). Both
                are deployer-restricted and render null for everyone else. */}
            <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center">
                {[...holdings]
                  .sort((a, b) => b.targetWeightPct - a.targetWeightPct)
                  .slice(0, 7)
                  .map((h, i, top) => (
                    <span
                      key={h.asset}
                      title={`${h.symbol} · ${h.targetWeightPct.toFixed(0)}%`}
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
              {DEPLOY_ENABLED && isDeployer && (
                <div className="flex items-center gap-2 sm:ml-auto">
                  {/* Repair path: declare this basket's predecessor when the
                      launch-time publish was skipped/lost. */}
                  <LinkPredecessorButton
                    basket={addr}
                    deployer={ix.deployer}
                    chainId={chainId}
                    hasPredecessor={lineage.hasPredecessor}
                    meta={meta ?? null}
                  />
                  <VersionButton basket={addr} deployer={ix.deployer} chainId={chainId} prominent />
                </div>
              )}
            </div>

            {/* Version lineage strip (public, only when a chain of versions exists). */}
            {lineage.count > 1 && (
              <div className="flex w-full flex-wrap items-center gap-3">
                <VersionStrip lineage={lineage} current={addr} chainId={chainId} />
              </div>
            )}
          </div>

          {/* price — the 24h change chip rides the "Price" LABEL row, not the number */}
          <div className={`relative z-10 shrink-0 transition-opacity duration-700 sm:text-right ${intro === 'swirl' ? 'opacity-0' : 'opacity-100'}`}>
            <div className="flex items-center gap-2.5 sm:justify-end">
              <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-ink-dim">Price</span>
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
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-dim">24h</span>
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
          </div>
          </>)}
        </div>

        {/* everything below the hero mounts only AFTER the intro settles — the
            hero (swirl included) is the whole page until then, and the chart /
            swap / holdings rise in beneath it */}
        {ix && creator && intro === 'done' && (
        <div className="content-rise">
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
                <span className="font-semibold text-cyan">${headSymbol}</span> (v{lineage.count}) is available, swap at your discretion.
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
            symbol={`$${ix.symbol}`}
            fallback={ix.navSeries}
            underlyingAssets={ix.holdings.map((h) => ({ address: h.asset, symbol: h.symbol, change24hPct: h.change24hPct }))}
            change24hPct={ix.change24hPct}
            heightClass="h-64 sm:h-72"
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

        {/* ── the assets themselves: price, movement, weight, value (owner
               15:32: "details on the actual assets being held and their current
               price and the individual asset performance") ──────────────── */}
        <div className="border-b border-white/10 px-4 py-5 sm:px-6">
          <AssetsTable holdings={ix.holdings} chainId={chainId} />
        </div>

        {/* ── key stats + returns ─────────────────────────────────── */}
        <div className="border-b border-white/10 px-6 py-5">
          <BasketStats ix={ix} chainId={chainId} />
        </div>

        {/* The creator's thesis renders below (the thesis card), from the DEPLOYER-
            SIGNED metadata blob (v3), attributed, verifiable, operator-moderated.
            The verified @handle (CreatorChip) still links out to their own feed.
            "What changed in this version" moved ABOVE the assets (owner 2026-07-07). */}

        </div>

        {/* ── swap rail: beside the chart, same card (sticky within).
               min-w-0 is load-bearing: without it the rail's min-content (the
               amount input's intrinsic width) inflates the shared grid track
               past narrow viewports ─── */}
        <div className="min-w-0 border-t border-white/10 p-4 sm:p-6 lg:border-t-0">
          <div className="space-y-4 lg:sticky lg:top-24">
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
                Visit ${ix.symbol}
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 17L17 7M7 7h10v10" />
                </svg>
              </a>
            )}

            {/* the full DEX console, locked to this basket (replaces the old
                fixed-direction TradePanel). id anchors the phone mini-buy bar's
                scroll (below). */}
            {SWAP_ENABLED && (
              <div id="buy-console" className="scroll-mt-24">
                <DexSwapCard chainId={chainId} fixedBasket={ix} />
              </div>
            )}

            {/* add-to-wallet right under the swap (owner 2026-07-06) — the
                natural next step after a buy; self-hides without a wallet */}
            <div className="flex justify-center">
              <AddToWalletButton address={addr} symbol={ix.symbol} chainId={chainId} />
            </div>

            {/* the human behind the basket — created-by, then their thesis
                right below, beside the assets (owner 16:59: "created by and
                the address, and below that the thesis, next to the assets
                and underneath the swap column") */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex items-center gap-3.5">
                <div className="relative shrink-0">
                  <div aria-hidden className="absolute -inset-1 rounded-full opacity-60 blur-[9px]" style={{ background: sig }} />
                  <div className="relative overflow-hidden rounded-full ring-2 ring-white/15">
                    <BasketAvatar
                      address={creator.address ?? addr}
                      symbol={creator.kind === 'address' ? 'x' : creator.label.replace(/^@/, '')}
                      imageUrl={meta?.avatarUrl ?? undefined}
                      size={48}
                    />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-dim">Created by</div>
                  <div className="mt-0.5 flex items-center gap-2.5">
                    {ix.deployer ? (
                      <Link
                        to={`/creator/${ix.deployer}`}
                        className="truncate font-display text-lg font-semibold leading-tight text-ink press hover:text-cyan"
                      >
                        {creator.label}
                      </Link>
                    ) : (
                      <span className="truncate font-display text-lg font-semibold leading-tight text-ink">{creator.label}</span>
                    )}
                  </div>
                  {ix.deployer && <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">{shortAddr(ix.deployer)}</div>}
                </div>
                {ix.deployer && <FollowButton deployer={ix.deployer} />}
              </div>

              <div className="relative mt-3.5 min-h-[240px] border-t border-white/10 pt-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                    The creator&rsquo;s thesis
                  </div>
                  {/* the deployer's corner belongs to the Edit pen — visitors get the
                      launch-post link. On a chain with NO notes registry the pen never
                      renders, so the deployer keeps the link too (audit). */}
                  {(meta?.postUrl || meta?.xUrl) &&
                    !(chainCfg(chainId).notesRegistry && viewer && ix.deployer && viewer.toLowerCase() === ix.deployer.toLowerCase()) && (
                    <a
                      href={meta.postUrl ?? meta.xUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan press hover:underline"
                    >
                      {meta.postUrl ? 'Launch post' : 'On X'}
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 17L17 7M7 7h10v10" />
                      </svg>
                    </a>
                  )}
                </div>
                {meta?.tagline && (
                  <p className="mt-3.5 font-display text-lg font-bold leading-snug tracking-tight text-ink">{meta.tagline}</p>
                )}
                {meta?.thesis ? (
                  <p className="mt-3 max-w-[62ch] whitespace-pre-line text-[15px] leading-[1.7] text-ink-dim">{meta.thesis}</p>
                ) : !meta?.tagline ? (
                  <p className="mt-3 text-sm leading-relaxed text-ink-faint">
                    Not published yet. The creator hasn&rsquo;t written a thesis for this basket. Only the
                    on-chain facts are shown.
                  </p>
                ) : null}
                {/* deployer-only: write/edit the thesis as an on-chain note */}
                {ix.deployer && (
                  <ThesisEditor basket={addr} chainId={chainId} deployer={ix.deployer} meta={meta} />
                )}
                {((meta?.sectors && meta.sectors.length > 0) || meta?.timeHorizon) && (
                  <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/[0.07] pt-4">
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
            </div>
          </div>
        </div>
        </div>


        {/* ── holdings: full width, under chart AND swap ──────────────── */}
        <div className="border-t border-white/10 p-4 sm:p-6">
          <HoldingsView holdings={ix.holdings} chainId={chainId} />
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
              <div className="truncate font-display text-sm font-bold text-ink">${ix.symbol}</div>
              <div className="font-num text-[11px] tabular-nums text-ink-dim">${formatNav(navUp, 4)}</div>
            </div>
            <button
              type="button"
              onClick={() => document.getElementById('buy-console')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="press shrink-0 rounded-xl px-5 py-2 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-black"
              style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
            >
              Buy ${ix.symbol}
            </button>
          </div>
        </div>
      )}

      {ix && (
        <>
          <MigrateModal
            open={migrateOpen}
            onClose={() => setMigrateOpen(false)}
            fromAddr={addr}
            fromSymbol={ix.symbol}
            toAddr={lineage.head ?? addr}
            toSymbol={headSymbol}
            chainId={chainId}
          />

          <ShareModal
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            symbol={ix.symbol}
            name={ix.name || ix.symbol}
            addr={addr}
            chainId={chainId}
            sig={sig}
            buyInk={buyInk}
            holdings={ix.holdings}
            navPerToken={ix.navPerToken}
            ageHours={ix.ageHours}
            navSeries={ix.navSeries}
          />
        </>
      )}
    </div>
  )
}


// ── per-asset detail: the holdings as facts — live price, 24h, weight, value ──
function AssetsTable({ holdings, chainId }: { holdings: Holding[]; chainId: number }) {
  const rows = [...holdings].sort((a, b) => b.valueUsd - a.valueUsd)
  return (
    <div>
      {/* section title, not a whisper (owner 16:59: "way bigger, way more
          readable and brighter") */}
      <h2 className="font-display text-xl font-bold uppercase tracking-tight text-ink">Assets</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[26rem] border-separate border-spacing-0 text-left">
          <thead>
            <tr className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
              <th className="pb-2 font-normal">Asset</th>
              <th className="pb-2 text-right font-normal">Price</th>
              <th className="pb-2 text-right font-normal">24h</th>
              <th className="pb-2 text-right font-normal">Weight</th>
              <th className="pb-2 text-right font-normal">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => {
              const w = h.liveWeightPct > 0 ? h.liveWeightPct : h.targetWeightPct
              return (
                <tr key={h.asset} className="group">
                  <td className="border-t border-white/[0.06] py-2.5 pr-3">
                    <span className="flex items-center gap-2.5">
                      <AssetLogo address={h.asset} symbol={h.symbol} chainId={chainId} size={24} />
                      <span className="min-w-0">
                        <span className="block font-display text-sm font-semibold uppercase tracking-wide text-ink">{h.symbol}</span>
                        <span className="block truncate font-mono text-[9px] text-ink-faint">{h.name}</span>
                      </span>
                    </span>
                  </td>
                  <td className="border-t border-white/[0.06] py-2.5 text-right font-num text-sm tabular-nums text-ink">
                    {h.priced ? formatPrice(h.priceUsd) : '—'}
                  </td>
                  <td className={`border-t border-white/[0.06] py-2.5 text-right font-num text-sm tabular-nums ${
                    h.change24hPct == null ? 'text-ink-faint' : h.change24hPct >= 0 ? 'text-teal' : 'text-magenta'
                  }`}>
                    {h.change24hPct == null ? '—' : `${h.change24hPct >= 0 ? '+' : ''}${h.change24hPct.toFixed(1)}%`}
                  </td>
                  <td className="border-t border-white/[0.06] py-2.5 text-right font-num text-sm tabular-nums text-ink-dim">
                    {w.toFixed(1)}%
                  </td>
                  <td className="border-t border-white/[0.06] py-2.5 text-right font-num text-sm tabular-nums text-ink-dim">
                    {h.priced && h.valueUsd > 0 ? formatUsdCompact(h.valueUsd) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
