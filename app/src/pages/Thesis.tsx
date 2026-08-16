import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams, useSearchParams } from 'react-router'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { showName, showSymbol } from '../lib/spectrum/safe-copy'
import { useAllBaskets, useCreatorMeta } from '../lib/spectrum/hooks'
import { ensureLaunchIndex, type BasketSummary, type NavPoint } from '../lib/spectrum/basket-data'
import { CHART_RANGES, combineNavHistory, fetchAssetHistory, type ChartRange } from '../lib/spectrum/history'
import { launchTimeLookup } from '../lib/spectrum/basket-sort'
import { resolveThesis, thesisHref } from '../lib/spectrum/thesis-url'
import { groupIntoTheses, thesisBentoItems, thesisCombinedSeries, thesisNeeds, thesisOneOfEach } from '../lib/spectrum/thesis'
import { isDemoLegAddress } from '../lib/spectrum/thesis-run-types'
import { Bezel, Eyebrow } from '../components/home/Spine'
import { ThesisRunOverlay, type ThesisRunMode } from '../components/thesis/ThesisRunOverlay'
import { ThesisConsole } from '../components/thesis/ThesisConsole'
import { ReshapeBasketModal } from '../components/reshape/ReshapeBasketModal'
import { ReshapeThesisModal } from '../components/reshape/ReshapeThesisModal'
import { SectionBar } from '../components/SectionBar'
import { BasketCard, HeldMark } from '../components/BasketCard'
import { BasketSpark } from '../components/BasketSpark'
import { QuickBuy } from '../components/QuickBuy'
import { BasketBento, type BentoItem } from '../components/BasketBento'
import { ChainBadge, ChainLogo, chainMeta } from '../components/ChainBadge'
import { basketHref } from '../lib/spectrum/short-url'
import { ThesisDoorCard } from '../components/ThesisCard'
import { BasketAvatar } from '../components/BasketAvatar'
import { FollowButton } from '../components/FollowButton'
import { ShareAction } from '../components/ShareBasket'
import { isAddress } from 'viem'
import { addressForIn, checkHandle } from '../lib/spectrum/creator-handles'
import { creatorPath, ownerAddress } from '../lib/spectrum/handle-registry'
import { useHandleForAddress, useHandleRegistry } from '../lib/spectrum/use-handles'
import { resolveCreator } from '../lib/spectrum/creator'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { formatGrouped, formatNav, formatPct, formatUsdCompact } from '../lib/spectrum/format'
import { heldPosition, type HeldIndex, type HeldPosition } from '../lib/spectrum/held-baskets'
import { useHeldBaskets } from '../lib/spectrum/use-held-baskets'
import { basketPnl, usePnlIndexes, type BasketPnl } from '../lib/spectrum/pnl'
import { useWalletGroup } from '../lib/spectrum/use-wallet-group'
import { DEV_PREVIEW_ADDRESS } from '../lib/spectrum/dev-preview'
import { DEPLOY_ENABLED, SWAP_ENABLED } from '../lib/config/features'

// ─────────────────────────────────────────────────────────────────────────────
// THE THESIS PAGE — one idea, several chains, one page (the owner 2026-08-09: "a
// condensed cross-chain basket page where you can see a creator's multi-chain
// baskets they shipped via the create page in one flow that can be bought/sold
// in one flow" · "I don't think it needs to be communicated as multiple
// baskets. It should be: here's the thesis. Across multiple chains. The stuff
// I'm bullish on").
//
// THE WHOLE PAGE IS AN ARGUMENT ABOUT NUMBER. Picking assets across Base,
// Ethereum and Robinhood ships THREE baskets, because a basket lives on one
// chain and there is one factory per chain. That is plumbing, and the creator
// never chose it. So nothing here counts baskets at a reader: the name is the
// headline, the chains are a row of marks under it, the combined value is ONE
// number, and the per-chain baskets arrive last, framed by their share of the
// idea rather than as three products in a list.
//
// NOTHING HERE IS NEW MACHINERY. `lib/spectrum/thesis.ts` already recognises
// the group and already splits a buyer's dollars across it; this is the surface
// that reads them. Every card, badge, plate and eyebrow is the component the
// creator page and the basket page already use, for the reason the house rule
// gives: a lookalike is how one product becomes two.
//
// THE BUY BUYS NOW — the DIRECT ROUTE (the owner 2026-08-09, greenlit): "Buy the
// whole thesis" opens the run overlay (components/thesis/ThesisRunOverlay.tsx),
// one guided session of separate per-network transactions — an OFFERED wallet
// switch → a LI.FI bridge where a chain is short → the leg bought through the
// live swapExactIn path with every floor and gate intact. No batcher is
// involved, so the direct route charges NO batching fee. Selling mirrors it
// when the wallet holds a leg. The plan panel stays as the zero-wallet,
// read-only state; with SWAP_ENABLED off this page keeps the old plan-only
// behaviour and says so plainly. A demo thesis (synthetic legs) drives the
// SAME overlay as a timed walkthrough that arms nothing and says so on a chip.
// ─────────────────────────────────────────────────────────────────────────────

/** The page's own empty/error plate. Local, like the creator and basket pages'
 *  own: three surfaces each own this treatment today, and unifying them is a
 *  sweep of its own rather than a side effect of a new page. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/12 px-6 py-10 text-center text-sm leading-relaxed text-ink-dim">
      {children}
    </div>
  )
}

function ThesisSkeleton() {
  return (
    <div className="space-y-8 py-4">
      <div className="h-64 animate-pulse rounded-3xl border border-white/5 bg-white/[0.02] motion-reduce:animate-none" />
      <div className="h-40 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02] motion-reduce:animate-none" />
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-72 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02] motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  )
}

/** Who made this, in the shape the basket page's byline uses: the label, the
 *  heart, an explicit door to the profile, the avatar. Same identity
 *  precedence too (signed profile > claimed URL name > address), because a
 *  creator credited one way here and another way one click along is two
 *  creators to a reader. */
function CreatorByline({ deployer, lead }: { deployer: string; lead: BasketSummary }) {
  const { data: meta } = useCreatorMeta(lead.address, lead.chainId)
  const { lookup } = useHandleForAddress(deployer)
  const creator = resolveCreator({
    handle: meta?.handle,
    name: meta?.name,
    deployer,
    basketAddress: lead.address,
  })
  const href = creatorPath(deployer, lookup.status === 'found' ? lookup.owner : null)
  // A claimed name beats a bare address, and never beats a signed profile: the
  // creator chose the signed one more deliberately. Handles are charset-bound
  // at claim time, so the label is bounded by construction.
  const label = creator.kind === 'address' && lookup.status === 'found' ? lookup.owner.display : creator.label

  /* ONE LINE (owner 2026-08-11: "better lay this info out on one line and
     make it prettier") — a single pill: avatar · created by · name · heart ·
     a quiet divider · profile →. The whole pill is the door except the heart,
     which keeps its own press. */
  return (
    <div className="inline-flex max-w-full items-center gap-3 rounded-full border border-white/12 bg-white/[0.03] py-1.5 pl-1.5 pr-4 backdrop-blur">
      <div className="relative shrink-0 overflow-hidden rounded-full ring-2 ring-white/15">
        <BasketAvatar
          address={deployer}
          symbol={creator.kind === 'address' ? 'x' : creator.label.replace(/^@/, '')}
          imageUrl={meta?.avatarUrl ?? undefined}
          size={32}
        />
      </div>
      <span className="hidden whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint sm:inline">
        created by
      </span>
      <Link to={href} className="press min-w-0 truncate font-display text-base font-semibold leading-tight text-ink hover:text-cyan">
        {label}
      </Link>
      <FollowButton deployer={deployer} variant="heart" />
      <span aria-hidden className="h-4 w-px shrink-0 bg-white/12" />
      <Link
        to={href}
        className="press inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim transition-colors hover:text-cyan"
      >
        profile
        <span aria-hidden>→</span>
      </Link>
    </div>
  )
}

/** THE ADD-TO-BUNDLE PICKER (the owner 2026-08-10; faces redone 2026-08-12: "it
 *  needs to show the baskets as beautiful bento grids exactly like how their
 *  baskets are shown on their creator page") — which of the creator's baskets
 *  ships a version under this thesis's name. Each candidate is the REAL
 *  BasketCard, the exact component + props the creator page's grid mounts
 *  (the house rule: a lookalike is how one product becomes two), wrapped in a
 *  capture-phase pick target so clicking the card — anywhere, including its
 *  own inner link and buttons — picks it instead of navigating. A candidate
 *  on an already-covered chain dims, wears the chip phrase, and keeps the
 *  full richer-leg sentence as its tooltip; it stays pickable, exactly as
 *  before. Picking opens the single-basket reshape popup in join mode for
 *  THAT basket — the rename is the entire mechanism (reshape-types.ts). */
function AddNetworkPicker({
  thesisName,
  thesisChainIds,
  candidates,
  heldIndex,
  onPick,
  onClose,
}: {
  thesisName: string
  thesisChainIds: number[]
  candidates: BasketSummary[]
  /** The page's ONE portfolio read (use-held-baskets), threaded through so the
   *  cards show "you hold this" exactly as they do on the creator page. */
  heldIndex: HeldIndex
  onPick: (b: BasketSummary) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  const covered = new Set(thesisChainIds)
  return createPortal(
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-void/60 backdrop-blur-[6px]"
      role="dialog"
      aria-modal="true"
      aria-label={`Add a basket to ${showName(thesisName)}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* 920px — the reshape modal's own width: two real card faces per row
          need the room the old 480px rows never did */}
      <div className="mx-auto my-16 w-[min(920px,calc(100vw_-_2rem))]">
        <div
          ref={panelRef}
          className="panel-in rounded-2xl border border-white/12 bg-panel/95 p-6 shadow-[0_48px_128px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">add to bundle</p>
              <h2 className="mt-2 font-display text-xl font-bold uppercase leading-tight tracking-tight text-ink">
                Which basket joins {showName(thesisName)}?
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="press grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
            >
              ✕
            </button>
          </div>
          {/* one column on phones, the creator grid's two-up from sm */}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {candidates.map((b) => {
              const sameChain = covered.has(b.chainId)
              return (
                /* the pick target: capture-phase, so the card's own whole-card
                   link and inner buttons all resolve to "pick this basket" —
                   in a chooser the card has exactly one job. A div, not a
                   button: the real card carries buttons of its own, and
                   buttons cannot nest. */
                <div
                  key={`${b.chainId}:${b.address}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Add $${showSymbol(b.symbol)} to ${showName(thesisName)}`}
                  title={
                    sameChain
                      ? 'this bundle already has a leg on this chain — it shows one per chain, the richer one'
                      : undefined
                  }
                  onClickCapture={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onPick(b)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onPick(b)
                    }
                  }}
                  className={`press relative cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-cyan/60 ${sameChain ? 'opacity-55' : ''}`}
                >
                  {/* THE REAL CARD — the creator page's exact mount */}
                  <BasketCard ix={b} held={heldPosition(heldIndex, b)} />
                  {/* top edge, not bottom: at the foot it sat on the card's
                      24h % — the chip must never cover a number */}
                  {sameChain && (
                    <span className="pointer-events-none absolute inset-x-0 -top-2 z-20 grid place-items-center">
                      <span className="rounded-full border border-amber-200/40 bg-black/75 px-3 py-1 font-mono text-[10px] text-amber-200/90 backdrop-blur">
                        already on this network
                      </span>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          {/* THE HONESTY LINE, quiet-footnote length (the join picker's exact
              idiom, owner 2026-08-12: less text) */}
          <p className="mt-4 font-mono text-[10px] leading-relaxed text-ink-dim">
            ships a <span className="text-ink">new version</span> of the chosen basket under this bundle&rsquo;s
            name — its current one stays live
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// The window word the chart caption speaks — it names the WINDOW SHOWN, so it
// must follow the pill selection (a "24h" sitting over a month of curve would
// be a quiet lie).
// ── THE NETWORK LEG CARD (owner 2026-08-16: the full BasketCard mounts down
// here were "an absolute mess, way too much clutter") ─────────────────────────
// The page already states identity, creator, contract and composition ONCE in
// the hero, so a leg card repeats none of it. It carries only what DIFFERS per
// network: the chain, your position there (with its PnL, when the flow ledger
// can actually price one — absent beats guessed, the held-baskets law), the
// leg's own 24h shape, its price + move, the money seated on that network, and
// the one action. The whole card is a door to the leg's page — BasketCard's
// exact inset-link + pointer-events grammar, so the two surfaces cannot drift.
function BundleLegCard({
  leg,
  pct,
  held,
  pnl,
}: {
  leg: BasketSummary
  pct: number | null
  held: HeldPosition | null
  pnl: BasketPnl | null
}) {
  const up = (leg.change24hPct ?? 0) >= 0
  const accent = up ? 'var(--color-cyan)' : 'var(--color-magenta)'
  return (
    <div className="group relative flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-white/15 bg-white/[0.045] p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] backdrop-blur-md transition-[translate,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-white/30 hover:bg-white/[0.06] sm:p-5">
      <Link
        to={basketHref(leg)}
        aria-label={`View the ${chainMeta(leg.chainId).short} basket`}
        className="absolute inset-0 z-0"
      />
      <div className="pointer-events-none relative z-10 flex flex-1 flex-col">
        {/* the network, your stake there, and its share of the idea — the
            share is the hero number because it is the one fact this section
            was built to say (framed by share, never by count) */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col items-start gap-1.5">
            <ChainBadge chainId={leg.chainId} size="md" />
            {held && <HeldMark position={held} />}
          </div>
          {pct != null && (
            <div className="shrink-0 text-right">
              <div className="font-num text-2xl font-light leading-none tabular-nums text-ink">{pct.toFixed(0)}%</div>
              <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">of the bundle</div>
            </div>
          )}
        </div>

        {/* the leg's own 24h shape — non-interactive: the card is one door,
            and a tooltip layer would punch a dead spot in it */}
        <div className="mt-4 h-12">
          <BasketSpark
            chainId={leg.chainId}
            assets={leg.top.map((t) => ({ address: t.address, weight: t.weightPct }))}
            navPerToken={leg.navPerToken}
            fallback={leg.navSeries}
            range="24H"
            interactive={false}
            address={leg.address}
            symbol={leg.symbol}
            legs={leg.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct }))}
          />
        </div>

        {/* your result on this leg (owner 2026-08-16: "showcase the pnl of
            each asset better") — the portfolio's own basketPnl math, teal/
            magenta by outcome. Renders only when a real basis exists: a
            transferred-in position or an unindexed chain has no honest
            figure, and the held chip above already states the fact. */}
        {pnl && (
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg border border-white/10 bg-black/25 px-3 py-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">your pnl</span>
            <span
              className="font-num text-sm font-semibold tabular-nums"
              style={{ color: pnl.netUsd >= 0 ? 'var(--color-teal)' : 'var(--color-magenta)' }}
            >
              {pnl.netUsd >= 0 ? '+' : '−'}${Math.abs(pnl.netUsd).toFixed(2)}
              <span className="ml-2">{formatPct(pnl.netPct * 100, 1)}</span>
            </span>
          </div>
        )}

        {/* foot on the shared bottom line: the leg's price and move, the
            money seated on this network, the one action */}
        <div className="mt-auto flex items-end justify-between gap-3 pt-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-num text-xl leading-none tabular-nums text-ink">
                ${formatNav(leg.navPerToken, 4)}
                <span className="ml-1 text-[10px] text-ink-faint">USD</span>
              </span>
              <span className="font-num text-sm font-semibold tabular-nums" style={{ color: accent }}>
                {formatPct(leg.change24hPct)}
              </span>
            </div>
            {Number.isFinite(leg.aumUsd) && leg.aumUsd > 0 && (
              <div className="mt-1 font-mono text-[10px] tabular-nums text-ink-faint">
                ≈{formatUsdCompact(leg.aumUsd)} on this network
              </div>
            )}
          </div>
          <div className="pointer-events-auto shrink-0">
            <QuickBuy address={leg.address} chainId={leg.chainId} symbol={leg.symbol} />
          </div>
        </div>
      </div>
    </div>
  )
}

const RANGE_WORD: Record<ChartRange, string> = { '24H': '24h', '7D': '7d', '30D': '30d', ALL: 'all time' }

// ── the combined curve at a CHOSEN window (owner 2026-08-13: the buy plate's
// chart grew range pills) ─────────────────────────────────────────────────────
// No new math on either axis — only the range threaded through the two laws
// that already exist: each leg's curve is rebuilt by combineNavHistory (the
// exact reconstruction the per-network basket page draws with, from the same
// per-asset cache keys BasketSpark's spark fetch uses, so sparks and this page
// share entries), and the legs then combine through thesisCombinedSeries (scale
// to real dollars, sum, refuse partial totals). '24H' asks the network for
// nothing: it IS the summaries' own navSeries — the page's default render costs
// zero new requests. A DEMO bundle stages its window from the walk generator
// via the dev-only dynamic import instead (its legs can be local-only paper —
// RH stocks — with no fetchable history anywhere); real legs never touch the
// stage path. A window no leg can fill returns null and the caller shows the
// honest empty line — never a flat invention, never a two-of-three total.
function useThesisRangeSeries(
  legs: readonly BasketSummary[],
  range: ChartRange,
  isDemo: boolean,
): { series: NavPoint[] | null; loading: boolean } {
  const wantsFetch = range !== '24H' && !isDemo && legs.length > 0
  const wanted = useMemo(() => {
    if (!wantsFetch) return []
    const seen = new Set<string>()
    const out: { chainId: number; addr: string }[] = []
    for (const leg of legs)
      for (const t of leg.top) {
        const key = `${leg.chainId}:${t.address.toLowerCase()}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ chainId: leg.chainId, addr: t.address.toLowerCase() })
        }
      }
    return out
  }, [wantsFetch, legs, range]) // eslint-disable-line react-hooks/exhaustive-deps

  const results = useQueries({
    queries: wanted.map(({ chainId, addr }) => ({
      queryKey: ['spectrum', 'assetHist', chainId, addr, range, 'spark'],
      queryFn: () => fetchAssetHistory(chainId, addr, range, null, { preferKeyless: true }),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
    })),
  })
  const updatedKey = results.map((r) => r.dataUpdatedAt).join(',')

  // The stage path rides the SAME dev-only dynamic import chain dev-fixture
  // uses (demo-baskets is never in the shipped bundle; in a prod build this
  // query stays disabled and the window reads honestly empty).
  const demoQ = useQuery({
    queryKey: ['spectrum', 'thesisDemoRange', legs.map((l) => l.address.toLowerCase()).join('|'), range],
    queryFn: async () => {
      const { demoRangeSeries } = await import('../lib/spectrum/demo-baskets')
      return thesisCombinedSeries(legs.map((leg) => ({ ...leg, navSeries: demoRangeSeries(leg.address, range) ?? [] })))
    },
    enabled: import.meta.env.DEV && isDemo && range !== '24H' && legs.length > 0,
    staleTime: Infinity,
  })

  const series = useMemo(() => {
    if (legs.length === 0) return null
    if (range === '24H') return thesisCombinedSeries(legs)
    if (isDemo) return demoQ.data ?? null
    const byKey = new Map<string, NavPoint[]>()
    wanted.forEach((w, i) => byKey.set(`${w.chainId}:${w.addr}`, results[i]?.data ?? []))
    return thesisCombinedSeries(
      legs.map((leg) => {
        const own = new Map<string, NavPoint[]>()
        for (const t of leg.top) {
          const a = t.address.toLowerCase()
          own.set(a, byKey.get(`${leg.chainId}:${a}`) ?? [])
        }
        return {
          ...leg,
          navSeries: combineNavHistory(
            leg.top.map((t) => ({ address: t.address, weight: t.weightPct })),
            own,
            leg.navPerToken,
          ),
        }
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, range, isDemo, wanted, updatedKey, demoQ.data])

  return { series, loading: results.some((r) => r.isLoading) || demoQ.isLoading }
}

export function Thesis() {
  const { deployer: deployerParam, slug } = useParams()
  const { data: all, isLoading, isError, chainsFailed } = useAllBaskets()
  // THE CREATOR SEGMENT ACCEPTS A CLAIMED NAME (owner 2026-08-16: short
  // bundle URLs — /thesis/iroradevtest/… — instead of forty hex characters).
  // An address resolves with ZERO lookups exactly as before; a name spends
  // one handle-registry read (cached 5 min, shared with every other name
  // surface). While the name is still resolving the page shows its skeleton,
  // never a not-found verdict.
  const paramIsAddress = isAddress(deployerParam ?? '', { strict: false })
  const handleReg = useHandleRegistry(!!deployerParam && !paramIsAddress)
  const nameResolving = !!deployerParam && !paramIsAddress && handleReg.data == null
  const deployer = useMemo(() => {
    if (!deployerParam) return deployerParam
    if (paramIsAddress) return deployerParam
    if (handleReg.data?.status !== 'ok') return deployerParam
    const gate = checkHandle(deployerParam)
    if (!gate.ok) return deployerParam
    const owner = addressForIn(handleReg.data.map, gate.handle.normalized)
    return owner ? ownerAddress(owner) : deployerParam
  }, [deployerParam, paramIsAddress, handleReg.data])
  // The viewer's own positions in these baskets, from the ONE portfolio read
  // every card surface shares, so "you hold this" reads identically here.
  const heldIndex = useHeldBaskets()
  // The run overlay's door. null = closed; the mode decides which session the
  // overlay walks (real buy · real sell · timed demo).
  const [runMode, setRunMode] = useState<ThesisRunMode | null>(null)
  const [payNudge, setPayNudge] = useState(0)
  // The how-it-works popup (owner 2026-08-10: a door beside the eyebrow that
  // teaches what this system is).
  const [howOpen, setHowOpen] = useState(false)
  // The reshape popup's door, and the viewer identity that gates it — this
  // page had no creator detection until the edit entry needed one.
  const { address: viewerAddr, isConnected } = useAccount()
  // The flow ledger behind each leg card's PnL row — the SAME identity chain
  // useHeldBaskets resolves (connected wallet, dev preview fallback, linked
  // group), so "you hold this" and "your pnl" can never describe two books.
  const pnlViewer = isConnected && viewerAddr ? viewerAddr : import.meta.env.DEV ? DEV_PREVIEW_ADDRESS : undefined
  const pnlGroup = useWalletGroup(pnlViewer)
  const pnlIdx = usePnlIndexes(pnlViewer ? pnlGroup.addresses : undefined)
  const [reshapeOpen, setReshapeOpen] = useState(false)
  // The join doors (the owner 2026-08-10: adding an existing basket to this
  // thesis). The picker chooses WHICH of the creator's baskets; the chosen one
  // then opens the single-basket reshape popup in join mode — shipping a
  // version renamed to THIS thesis's name is the whole mechanism.
  const [addOpen, setAddOpen] = useState(false)
  const [joinPick, setJoinPick] = useState<{ address: `0x${string}`; chainId: number } | null>(null)

  // ⛔ EVERY HOOK ABOVE THE GATES. They return early, and a hook below one runs
  // on some renders and not others — the crash the basket page carries its own
  // note about. Nothing here may move under the `if`s further down.

  // Launch times, resolved exactly the way the creator page resolves them (one
  // shared react-query key, so the two mounts cost one build). ⚠ The grouper's
  // launch window is INERT now (thesis.ts, 2026-08-10 — a joined leg arrives
  // months late by design, and the old window dropped the whole thesis for
  // it), so nothing load-bearing reads these times today; the plumbing stays
  // because the option is still accepted and the shared index build feeds
  // other surfaces at no extra cost here.
  const chainIds = useMemo(() => [...new Set((all ?? []).map((b) => b.chainId))], [all])
  const idxQueries = useQueries({
    queries: chainIds.map((id) => ({
      queryKey: ['spectrum', 'launch-index', id],
      queryFn: () => ensureLaunchIndex(id),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    })),
  })
  const datedTick = idxQueries.filter((q) => q.data === true).length
  const launchedAt = useMemo(
    () => launchTimeLookup(chainIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chainIds, datedTick],
  )

  const match = useMemo(
    () => resolveThesis(all ?? [], deployer, slug, { launchedAt }),
    [all, deployer, slug, launchedAt],
  )
  const thesis = match.hit
  const legs = useMemo(() => thesis?.legs ?? [], [thesis])
  const lead = legs[0] ?? null
  // The creator's own words for the hero (owner 2026-08-09: the explainer
  // "should be the thesis … obviously set by the creator"). Same signed
  // metadata the token page's thesis card reads, resolved off the lead leg —
  // and the same react-query key CreatorByline uses, so the hero costs no
  // second fetch.
  const { data: heroMeta } = useCreatorMeta(lead?.address ?? undefined, lead?.chainId)

  // THE COMPOSITE PICTURE: every leg's holdings on one canvas, each weighted by
  // its own share of its basket AND its basket's share of the whole. That is
  // the one honest way to draw "what the thesis holds" from parts that live on
  // different chains. It needs a readable total to weight against, so with none
  // the picture is ABSENT rather than drawn on equal shares we invented.
  //
  // The same asset on two chains stays two tiles, deliberately: they are two
  // positions bought with different money, and merging them would hide the
  // cross-chain fact this page exists to state. `id` is what keeps their keys
  // apart in the treemap.
  // The composite picture + the combined figures come from thesis.ts's own
  // helpers — the door card draws the identical chart/bento from the same
  // functions, so the two surfaces cannot drift (the one-implementation law).
  const bento = useMemo<BentoItem[]>(
    () => (thesis ? thesisBentoItems(thesis, (sym) => showSymbol(sym).toUpperCase()) : []),
    [thesis],
  )
  const combinedSeries = useMemo(() => (thesis ? thesisCombinedSeries(thesis.legs) : null), [thesis])
  const oneOfEach = thesis ? thesisOneOfEach(thesis.legs) : null

  // The split preview (read-only) AND the run's input amount share this field.
  // feeBps 0: the DIRECT ROUTE charges no batching fee — the batch fee is a
  // batcher-contract field and no batcher is involved (thesis-run-types.ts).
  // ?amount=250 deep-links a prefilled figure (shared plans, the bot) — read
  // once, positive finite only; a hostile param falls back to the default.
  const [searchParams] = useSearchParams()
  const [amount, setAmount] = useState(() => {
    const raw = Number((searchParams.get('amount') ?? '').replace(/[$,\s]/g, ''))
    return Number.isFinite(raw) && raw > 0 && raw <= 10_000_000 ? String(raw) : '500'
  })
  const amountUsd = Number(amount.replace(/[$,\s]/g, ''))
  const needs = useMemo(
    () => (thesis ? thesisNeeds(thesis, amountUsd, 0) : null),
    [thesis, amountUsd],
  )
  // A thesis with ANY synthetic leg is a demo thesis: the run builder refuses
  // to arm it, and the page offers the walkthrough instead of a buy.
  const isDemo = useMemo(() => legs.some((l) => isDemoLegAddress(l.address)), [legs])

  // The combined chart's window. '24H' is the default the page always had —
  // the summaries' own spark series, zero extra requests on load.
  const [chartRange, setChartRange] = useState<ChartRange>('24H')
  const { series: rangeSeries, loading: rangeLoading } = useThesisRangeSeries(legs, chartRange, isDemo)
  // THE RETURN FIGURE (owner 2026-08-16: "show the performance … so people can
  // see the success") — the chart drew the shape but never said the number.
  // Endpoint over endpoint of the exact series on screen, so figure and curve
  // cannot disagree; refused unless both ends are real positive values (a
  // zero/unpriced end would render an invented ±100%-flavoured claim).
  const windowReturn = useMemo(() => {
    if (!rangeSeries || rangeSeries.length < 2) return null
    const first = rangeSeries[0]?.value
    const last = rangeSeries[rangeSeries.length - 1]?.value
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last <= 0) return null
    return (last / first - 1) * 100
  }, [rangeSeries])

  // The creator's OTHER cross-chain ideas — discovery at the page's end. The
  // same fold the grouper uses keys the exclusion, so the current thesis
  // never lists itself under a case variant.
  const otherTheses = useMemo(() => {
    if (!thesis || !all) return []
    const mine = all.filter((b) => b.deployer?.toLowerCase() === thesis.deployer && !b.supersededBy)
    const fold = (n: string) => n.toLowerCase().replace(/\s+/g, ' ').trim()
    return groupIntoTheses(mine).filter((t) => fold(t.name) !== fold(thesis.name))
  }, [thesis, all])
  // The creator, by wallet: thesis.deployer is ALREADY lowercase (thesis.ts
  // normalises it at grouping), so only the viewer's side needs the fold.
  const isCreator = !!viewerAddr && thesis != null && viewerAddr.toLowerCase() === thesis.deployer

  // WHAT COULD JOIN THIS THESIS (the owner 2026-08-10): the creator's other live
  // heads. A basket already sharing the name is never offered — to the grouper
  // sharing the name IS membership (or its same-chain shadow), so that row
  // would sell a join to nowhere. Chains the thesis does not cover yet lead
  // the list (they are the join this entry exists for); same-chain heads stay
  // listed after them, each carrying the richer-leg caveat on its row.
  const joinCandidates = useMemo(() => {
    if (!thesis || !all) return []
    const fold = (s: string | null | undefined) =>
      String(s ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
    const tname = fold(thesis.name)
    const covered = new Set(thesis.chainIds)
    return all
      .filter((b) => b.deployer?.toLowerCase() === thesis.deployer && !b.supersededBy && fold(b.name) !== tname)
      .sort((a, b) => {
        const aCovered = covered.has(a.chainId) ? 1 : 0
        const bCovered = covered.has(b.chainId) ? 1 : 0
        if (aCovered !== bCovered) return aCovered - bCovered
        return (Number.isFinite(b.aumUsd) ? b.aumUsd : 0) - (Number.isFinite(a.aumUsd) ? a.aumUsd : 0)
      })
  }, [thesis, all])

  // The tab names the idea (Yours.tsx's pristine-restore idiom): a shared
  // thesis link that opens as the site's generic title is a link that loses
  // its subject in a tab row.
  const pristineTitle = useRef<string | null>(null)
  useEffect(() => {
    if (!thesis) return
    if (pristineTitle.current == null) pristineTitle.current = document.title
    document.title = `${showName(thesis.name)} — a bundle on ${thesis.chainIds.length} ${
      thesis.chainIds.length === 1 ? 'network' : 'networks'
    }`
    return () => {
      if (pristineTitle.current != null) document.title = pristineTitle.current
    }
  }, [thesis])

  if (!deployer || !slug) return <Notice>No bundle in this link.</Notice>
  if (isError)
    return <Notice>Could not load this bundle. The public data source may be busy, so try again in a moment.</Notice>
  if (isLoading || !all || nameResolving) return <ThesisSkeleton />

  // Two names, one address (see thesis-url.ts). Say which ones, never pick.
  if (match.ambiguous.length > 1) {
    return (
      <div className="py-10">
        <div className="mx-auto max-w-md rounded-2xl border border-white/12 bg-white/[0.03] p-6">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            Two bundles share that name
          </div>
          <p className="mt-2 text-sm text-ink-dim">Pick the one you meant. The link you followed did not say.</p>
          <div className="mt-4 space-y-2">
            {match.ambiguous.map((t) => (
              <Link
                key={t.name}
                to={thesisHref(t.deployer, t.name)}
                className="press flex items-center justify-between gap-3 rounded-xl border border-white/10 px-3 py-2.5 text-[13px] text-ink-dim hover:border-cyan/50 hover:text-ink"
              >
                <span className="truncate font-semibold">{showName(t.name)}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">{t.legs.length} networks</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!thesis || !lead) {
    // "There is no such thesis" may only be ASSERTED when the whole registry
    // answered. A failed chain contributes nothing to the list, and this
    // thesis's every leg could be hiding in that gap.
    const unverified = (chainsFailed ?? 0) > 0
    return (
      <div className="space-y-6 py-4">
        <Notice>
          {unverified
            ? 'Could not check for this bundle just now. Part of the network did not answer, so nothing is being claimed either way. Try again in a moment.'
            : 'No bundle by that name from this creator. It may have been renamed, or its baskets may have been superseded by newer versions.'}
        </Notice>
        <div className="text-center">
          <Link
            to={creatorPath(deployer)}
            className="press inline-flex h-9 items-center rounded-full border border-white/12 px-4 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim hover:border-white/30 hover:text-ink"
          >
            See everything this creator made →
          </Link>
        </div>
      </div>
    )
  }

  const accent = basketSignatureColor(lead.address, lead.top[0])
  const total = thesis.totalAumUsd
  // What the run overlay is handed: the typed amount as integer cents, 0 when
  // the field does not hold a positive number (the button disables on 0).
  const amountCents = Number.isFinite(amountUsd) && amountUsd > 0 ? Math.round(amountUsd * 100) : 0
  const shareOf = (leg: BasketSummary): number | null =>
    total > 0 && Number.isFinite(leg.aumUsd) ? (leg.aumUsd / total) * 100 : null
  // Holders summed over the legs that report one — a floor when some leg's
  // count is unknown, a dash when none is. Never a zero standing in for
  // "could not read".
  const holders = legs.reduce<number | null>(
    (s, l) => (l.holdersCount != null && Number.isFinite(l.holdersCount) ? (s ?? 0) + l.holdersCount : s),
    null,
  )
  // What the VIEWER holds of this idea — the page already reads the shared
  // held index; the hero says so when it is non-empty. Dollars only when
  // every held leg is priced (a partial sum shown as the total is a lie);
  // otherwise the count of networks alone, which is still a fact.
  const heldLegs = legs.map((l) => heldPosition(heldIndex, l)).filter((p): p is NonNullable<typeof p> => p != null)
  const heldUsd = heldLegs.length > 0 && heldLegs.every((p) => p.valueUsd != null)
    ? heldLegs.reduce((s2, p) => s2 + (p.valueUsd ?? 0), 0)
    : null

  // The idea's own 24h move: each leg's change weighted by its share of the
  // money, over the legs where both halves are readable.
  const change24h = (() => {
    let wSum = 0
    let acc = 0
    for (const l of legs) {
      const chg = l.change24hPct
      const aum = l.aumUsd
      if (chg == null || !Number.isFinite(chg) || !Number.isFinite(aum) || aum <= 0) continue
      wSum += aum
      acc += chg * aum
    }
    return wSum > 0 ? acc / wSum : null
  })()
  // A partial read is stated, never smoothed over: with a chain silent, this
  // page is showing part of an idea and the reader is owed that sentence.
  const partial = (chainsFailed ?? 0) > 0

  return (
    // 32/40 on the house scale, the same between-region rhythm the creator page
    // runs: on a phone the next thing should be on screen within a second of
    // scrolling away from the last one.
    <div className="space-y-8 pb-4 pt-6 sm:space-y-10">
      <Link
        to={creatorPath(deployer)}
        className="press inline-flex min-h-[36px] items-center font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint hover:text-ink sm:min-h-0"
      >
        ← The creator
      </Link>

      {/* ── THE THESIS HERO — built around the chart (owner 2026-08-10:
          "way more beautiful and way more centered around the chart, the
          total price of all 3 baskets combined in one price, the composition
          breakdown across the three chains, the % performance of the thesis
          for each chain and combined"). Reading order: who and what → the
          combined money line → THE CHART → the per-chain breakdown with each
          network's own move → the creator's words. No basket count anywhere
          — the framing the owner ruled out. ── */}
      <Bezel glow={accent}>
        <div className="p-6 sm:p-10">
          {/* identity left · WHO MADE IT + their tools right, CENTERED against
              the title block (the owner 2026-08-12: "this needs to go on the
              right hand side centered with the title and pill above"; the
              byline joined it 2026-08-13: "the created by needs to go on
              right hand side above the your creator profile") — items-center
              is what centers the right column on the left column's height; on
              phones the right column's w-full wraps below the title block
              whole instead of squeezing. */}
          <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-6">
            {/* flex-1 basis-0, not natural width: the identity column YIELDS
                width (the title wraps, Share drops a line) rather than forcing
                the creator column onto its own row — natural widths here sum
                past the card's ~860px and flex-wrap would stack the two. */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <Eyebrow tone="spectral">
                  a bundle on {legs.length} {legs.length === 1 ? 'network' : 'networks'}
                </Eyebrow>
                <button
                  type="button"
                  onClick={() => setHowOpen(true)}
                  className="press inline-flex min-h-[28px] items-center rounded-full border border-white/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint transition-colors hover:border-cyan/50 hover:text-cyan"
                >
                  how it works
                </button>
              </div>
              <h1 className="mt-4 break-words font-display text-4xl font-bold uppercase leading-[0.92] tracking-tight text-ink sm:text-5xl">
                {showName(thesis.name)}
              </h1>
              {/* Share stays with the identity — it is the VISITOR's action on
                  this page (take this bundle elsewhere), and the right column
                  is now purely the creator's: who made it, and, if it's yours,
                  what you can do to it. */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <ShareAction
                  url={`${typeof window !== 'undefined' ? window.location.origin : ''}${thesisHref(thesis.deployer, thesis.name)}`}
                  sheetTitle={`${showName(thesis.name)} — a bundle on ${thesis.chainIds.length} networks`}
                />
              </div>
            </div>
            {/* THE CREATOR COLUMN — the byline on top, the owner's tools
                beneath it (the owner 2026-08-13, reading the header: "the created
                by needs to go on right hand side above the your creator
                profile"). The byline is a SIBLING of the tools gate, never a
                child of it: the tools are owner-only, the byline is for
                everyone, and nesting it would delete a visitor's only door to
                the creator on this page. w-full → sm:w-auto is the header's
                own phone grammar (390px, seen live 2026-08-11): the pair
                drops whole under the title block, byline still above tools.
                sm:items-end right-aligns the pair against the card edge. */}
            <div className="flex w-full min-w-0 flex-col items-start gap-3 sm:w-auto sm:shrink-0 sm:items-end">
              <CreatorByline deployer={thesis.deployer} lead={lead} />
              {/* YOUR CREATOR TOOLS (the owner 2026-08-12: "group the creator
                  actions in their own shared little pill" · "right hand side
                  centered") — grouping only: the gate is the exact one both
                  buttons always had, and Add keeps its own has-candidates
                  condition inside. */}
              {((DEPLOY_ENABLED && isCreator) || isDemo) && (
                <div className="w-full min-w-0 sm:w-auto">
                  <div className="inline-flex flex-wrap items-center gap-2 rounded-full border border-white/12 bg-white/[0.03] py-1 pl-3 pr-1">
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">
                      your creator tools
                    </span>
                    {/* Edit bundle — the creator's reshape door (the owner
                        2026-08-10): ships a NEW version per chain, never a
                        mutation. Creator-only on a real thesis; a demo thesis
                        shows it to anyone so the walkthrough stays reachable. */}
                    <button
                      type="button"
                      onClick={() => setReshapeOpen(true)}
                      className="press inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
                      title="Reweight or edit this bundle — ships a new version holders can swap into"
                    >
                      Edit bundle
                    </button>
                    {joinCandidates.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setAddOpen(true)}
                        className="press inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
                        title="Ship one of your baskets as a new version carrying this bundle's name — the name is what adds it"
                      >
                        Add to bundle
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* THE MONEY LINE — the combined price is the headline: one token
              of each leg, summed (the only per-unit figure honest across
              unrelated supplies; the label says so), the combined move beside
              it, TVL and holders as quiet qualifiers. Absent pieces show a
              dash — a zero standing in for "unreadable" is a claim. */}
          {/* ONE GRID, TWO ROWS (owner 2026-08-11: "still need to be
              horizontally aligned" — the flex blocks only top-aligned the
              numbers, so the 6xl price sat baseline-ragged against the 2xl
              stats and phones wrapped the row into a stack): labels fill row
              one, numbers fill row two, and items-baseline makes each ROW
              share one true baseline whatever the font sizes. Phone sizes
              shrink a step so the row genuinely holds one line; a connected
              phone's extra You-hold cell scrolls sideways rather than
              breaking the line. */}
          <div className="mt-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
            <div className="no-scrollbar grid min-w-0 grid-flow-col grid-rows-[auto_auto] items-baseline gap-x-2.5 gap-y-3 overflow-x-auto sm:gap-x-12">
              <div
                title="one token of each basket, summed — the per-unit figure that is honest across baskets with unrelated supplies"
                className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint sm:tracking-[0.22em]"
              >
                Combined price
              </div>
              <div className="flex items-baseline gap-1.5 sm:gap-4">
                <span className="font-num text-2xl font-light leading-none tabular-nums text-ink sm:text-6xl">
                  {oneOfEach != null ? `$${formatNav(oneOfEach, 4)}` : '—'}
                </span>
                {change24h != null && (
                  <span
                    title="each network's move, weighted by its share of the money"
                    className="font-num text-xs font-semibold tabular-nums sm:text-xl"
                    style={{ color: accent }}
                  >
                    {formatPct(change24h)}
                  </span>
                )}
              </div>
              {total > 0 && (
                <>
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint sm:tracking-[0.22em]">TVL</div>
                  <div className="font-num text-lg font-light leading-none tabular-nums text-ink sm:text-2xl">
                    {formatUsdCompact(total)}
                  </div>
                </>
              )}
              <div title="summed across every network that reports a count" className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint sm:tracking-[0.22em]">
                Holders
              </div>
              <div className="font-num text-lg font-light leading-none tabular-nums text-ink sm:text-2xl">
                {holders != null ? formatGrouped(holders) : '—'}
              </div>
              {/* the viewer's own stake, when they have one — dollars only when
                  every held leg is priced; the network count is honest alone */}
              {heldLegs.length > 0 && (
                <>
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan sm:tracking-[0.22em]">You hold</div>
                  <div className="font-num text-lg font-light leading-none tabular-nums text-ink sm:text-2xl">
                    {heldUsd != null
                      ? formatUsdCompact(heldUsd)
                      : `${heldLegs.length} ${heldLegs.length === 1 ? 'network' : 'networks'}`}
                  </div>
                </>
              )}
            </div>
            {/* the one action the page exists for, one glance from the price —
                a jump, not a duplicate control: the console below owns the
                amount, the modes and every honesty rail. items-end on the row
                seats its bottom on the numbers' line, no phantom label needed. */}
            <a
              href="#thesis-buy"
              className="spectral-btn press inline-flex h-12 items-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
            >
              Buy the whole bundle ↓
            </a>
          </div>

          {/* THE CHART — the hero's centre: the combined value curve, every
              leg's history scaled to its own dollars, ending exactly at the
              TVL above. Refused whole when any leg cannot be read — a
              two-of-three "total" is a wrong chart. The split bar underneath
              is the same money cut by network, so the curve and the
              composition read as one object. */}
          {combinedSeries && (
            <div className="mt-8">
              {/* the curve NAMES ITSELF: the headline above is a PRICE and
                  this is VALUE — one quiet caption keeps the two apart. The
                  window pills are the composer chart's own idiom, and the
                  caption's window word follows the selection. The block is
                  gated on the 24H curve existing (can this thesis chart at
                  all?), never on the selected window's — an empty week must
                  not take the pills down with it. */}
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                  combined value · every network · {RANGE_WORD[chartRange]}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {/* the window's RESULT, said in one number (owner
                      2026-08-16) — the shape below shows how it moved, this
                      says what it did. Absent when either end is unreadable. */}
                  {windowReturn != null && (
                    <span className="flex items-baseline gap-1.5">
                      <span
                        className="font-num text-xl font-semibold leading-none tabular-nums sm:text-2xl"
                        style={{ color: windowReturn >= 0 ? 'var(--color-cyan)' : 'var(--color-magenta)' }}
                      >
                        {formatPct(windowReturn, 1)}
                      </span>
                      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                        {chartRange === 'ALL' ? 'since launch' : `past ${RANGE_WORD[chartRange]}`}
                      </span>
                    </span>
                  )}
                  <div className="flex items-center gap-1.5">
                    {CHART_RANGES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setChartRange(r)}
                        aria-pressed={chartRange === r}
                        className={`press rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wide ${
                          chartRange === r ? 'bg-white/12 text-ink' : 'text-ink-faint hover:text-ink-dim'
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-2 h-40 sm:h-52">
                {rangeSeries ? (
                  <BasketSpark
                    chainId={lead.chainId}
                    assets={[]}
                    navPerToken={0}
                    fallback={rangeSeries}
                    range={chartRange}
                    address={lead.address}
                    symbol={thesis.name}
                    legs={bento.map((b) => ({ symbol: b.symbol, address: b.address, weightPct: b.weightPct }))}
                  />
                ) : (
                  /* the honest empty: this window has no readable total —
                     said in the caption's own register, never a flat line */
                  <div className="grid h-full place-items-center font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                    {rangeLoading ? 'reading history…' : 'no readable history in this window'}
                  </div>
                )}
              </div>
            </div>
          )}
          {total > 0 && (
            <div
              role="img"
              aria-label={`Value split across networks: ${legs
                .map((l) => {
                  const p = shareOf(l)
                  return p != null ? `${chainMeta(l.chainId).short} ${p.toFixed(0)}%` : null
                })
                .filter(Boolean)
                .join(', ')}`}
              className="mt-4 flex h-2.5 w-full gap-1 overflow-hidden rounded-full"
            >
              {legs.map((leg) => {
                const pct = shareOf(leg)
                if (pct == null || pct <= 0) return null
                return (
                  <div
                    key={leg.chainId}
                    title={`${chainMeta(leg.chainId).short} · ${pct.toFixed(0)}% of the bundle`}
                    className="h-full first:rounded-l-full last:rounded-r-full"
                    style={{ width: `${pct}%`, background: chainMeta(leg.chainId).color }}
                  />
                )
              })}
            </div>
          )}

          {/* THE BREAKDOWN — one compact tile per network, side by side
              (owner 2026-08-10: "more visual and less height"): the chain's
              own colour as a top bar, its share big, ITS OWN 24h beside it,
              TVL quiet, the asset mix one clamped line. The whole tile is the
              door to that network's basket. ── */}
          <div className="-mx-4 mt-6 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:grid sm:snap-none sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0">
            {legs.map((leg) => {
              const pct = shareOf(leg)
              const chg = leg.change24hPct
              const top = leg.top ?? []
              const parts = top
                .slice(0, 4)
                .map((t) => `${showSymbol(t.symbol)} ${Math.round(t.weightPct)}%`)
                .join(' · ')
              const more = top.length - 4
              return (
                <Link
                  key={leg.chainId}
                  to={basketHref(leg)}
                  className="press group relative min-w-0 shrink-0 basis-[78%] snap-start overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] p-4 transition-colors hover:border-cyan/50 sm:basis-auto sm:shrink"
                >
                  <span
                    aria-hidden
                    className="absolute inset-x-0 top-0 h-1"
                    style={{ background: chainMeta(leg.chainId).color }}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <ChainBadge chainId={leg.chainId} size="md" />
                    <span aria-hidden className="font-mono text-[11px] text-ink-faint transition-colors group-hover:text-cyan">
                      →
                    </span>
                  </div>
                  <div className="mt-3 flex items-baseline gap-3">
                    {pct != null && (
                      <span className="font-num text-2xl font-light leading-none tabular-nums text-ink">
                        {pct.toFixed(0)}%
                      </span>
                    )}
                    <span
                      className="font-num text-sm font-semibold tabular-nums"
                      style={{ color: chg != null && Number.isFinite(chg) ? chainMeta(leg.chainId).color : undefined }}
                    >
                      {chg != null && Number.isFinite(chg) ? formatPct(chg) : <span className="text-ink-faint">—</span>}
                    </span>
                    {Number.isFinite(leg.aumUsd) && leg.aumUsd > 0 && (
                      <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-faint">
                        {formatUsdCompact(leg.aumUsd)}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim">
                    {parts}
                    {more > 0 ? ` +${more}` : ''}
                  </div>
                </Link>
              )
            })}
          </div>

          {/* THE CREATOR'S OWN WORDS — the pitch closes the hero, on the token
              page's inner-card treatment. Falls back to the plumbing explainer
              only when nothing signed exists. */}
          {heroMeta?.thesis || heroMeta?.tagline ? (
            /* THE THESIS SPEAKS AT QUOTE SCALE (owner 2026-08-15: "the bundle
               page rendering the thesis prominently" — the signing path
               shipped the same day, so these words finally exist): spectral
               rule, display-size words, the creator's own attribution. */
            <div className="relative mt-8 overflow-hidden rounded-2xl border border-white/10 bg-black/30 p-6 backdrop-blur-md sm:p-8">
              <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: 'linear-gradient(180deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                the thesis, in their words
              </div>
              {heroMeta.tagline && (
                <p className="mt-4 max-w-[64ch] font-display text-2xl font-bold leading-snug tracking-tight text-ink sm:text-3xl">
                  {heroMeta.tagline}
                </p>
              )}
              {heroMeta.thesis && (
                <p className={`mt-4 max-w-[68ch] whitespace-pre-line leading-[1.75] ${heroMeta.tagline ? 'text-[15px] text-ink-dim' : 'font-display text-xl font-semibold leading-relaxed tracking-tight text-ink sm:text-2xl'}`}>
                  {heroMeta.thesis}
                </p>
              )}
              {/* the signed sectors + horizon, the token page's own pill
                  grammar — real metadata, not invented tags */}
              {((heroMeta.sectors && heroMeta.sectors.length > 0) || heroMeta.timeHorizon) && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {heroMeta.sectors?.map((sct) => (
                    <span
                      key={sct}
                      className="rounded-full border border-violet/30 bg-violet/[0.07] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-violet-bright"
                    >
                      {sct}
                    </span>
                  ))}
                  {heroMeta.timeHorizon && (
                    <span className="rounded-full border border-white/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim">
                      {heroMeta.timeHorizon}
                    </span>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="mt-8 max-w-[62ch] text-sm leading-relaxed text-ink-dim">
              One idea, held across {legs.length === 1 ? 'one network' : `${legs.length} networks`}. Each network
              has its own basket because a basket lives on a single chain, so this page reads them back as the one
              thing they were made to be.
            </p>
          )}
          {partial && (
            <p className="mt-5 max-w-[62ch] font-mono text-[11px] leading-relaxed text-amber-200/90">
              Part of the network did not answer, so a chain of this bundle may be missing from this page.
            </p>
          )}
        </div>
      </Bezel>

      {/* ── WHAT IT HOLDS ──────────────────────────────────────────────────
          "The stuff I'm bullish on", drawn as one picture instead of three.
          The real bento, so it is the same treemap the basket page and the
          cards use. ── */}
      {bento.length > 0 && (
        <section className="space-y-4">
          <SectionBar title="What it holds" meta="every network, weighted by its share" />
          {/* expandable (the owner 2026-08-11: "hover these individually to have
              their price pop up like other bento grids") — items carry per-tile
              chainId, so the popup prices each leg on ITS network */}
          <BasketBento items={bento} aspect={3.2} expandable hoverShareLabel="of bundle" />
        </section>
      )}

      {/* ── BUYING THE WHOLE THING ─────────────────────────────────────────
          The page's one action. The direct route is live (see the header
          note): the primary opens the run overlay — real buy, real sell when
          held, or the timed walkthrough on a demo thesis. The split preview
          stays as the zero-wallet read-only state, and with SWAP_ENABLED off
          this plate degrades to exactly the old plan-only surface. ── */}
      <section id="thesis-buy" className="scroll-mt-24">
      <Bezel glow={accent} panel="bg-panel/80">
        {/* TWO TRACKS: the pitch and what this is NOT on the left, the control
            and its answer on the right. One column left the plate's right half
            empty, because prose caps at a reading measure long before the plate
            runs out of width, and the page's biggest surface should not be its
            emptiest. min-w-0 on both, or the split rows widen their own track. */}
        {/* items-center, because the control track is short until the split is
            asked for, and a plate whose right half stops halfway up reads as
            unfinished rather than as waiting. */}
        <div className="grid gap-8 p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start lg:gap-12">
          <div className="min-w-0">
            {/* ONE heading tier, not two (owner 2026-08-13: "way too much text
                here imo"): the pill and the h2 stacked two titles on one plate,
                so the section's name moves into the h2 and the pill goes. The
                old subtitle — "One amount, split the way it was shipped" — was
                teaching, and the split rows opposite already show it happening
                with real figures. */}
            <h2 className="font-display text-2xl font-bold uppercase leading-[1.05] tracking-tight text-ink sm:text-3xl">
              Buy the whole bundle
            </h2>

            {/* THE FLOW AS A PICTURE, not a paragraph (owner 2026-08-10: "way
                way way less text and make it a bit more visual"): three steps,
                the middle one carrying the thesis's own split bar — the split
                IS the explanation. Each step is a CARD on a connected spine
                (owner 2026-08-11: "this needs to use more of the height of the
                card" — three thin rows floated in the plate's tall left track;
                the stack now fills it, one visual per step at real size).
                LABELS ONLY as of owner 2026-08-13 ("way too much text here
                imo"): each step's subtitle sentence is gone — they narrated
                what the picture beside them already shows. The 08-11 height
                ruling still holds, so the rows take back in padding and gap
                what the dropped line gave up, and each step keeps its visual
                at full size. The one subtitle that was a FACT rather than
                narration — minimums being enforced — now lives once, in the
                quietest tier, under the button in ThesisConsole. */}
            {/* TITLES ARE TWO HAND-SET LINES (owner 2026-08-13: "balance the
                titles here on two lines"): at full width the three labels sat
                one-line/one-line/ragged-two, so the cards read as different
                animals. Each title is now a lines PAIR broken at its phrase
                joint — One/amount in (never the orphan "amount in / in"),
                Split by/real weight, A signature or two/per network — so the
                second lines land at 9/11/11 characters and the three blocks
                carry an even bottom edge. Spans, not a max-width: a width
                constraint is a font-metric magic number that re-rags on the
                next copy edit, while the pair makes the break an editorial
                decision the editor re-takes with the words. Same words as the
                08-13 trim — nothing added, nothing cut. */}
            <div className="relative mt-8 flex flex-col gap-4">
              {/* the spine: one hairline through the step discs */}
              <span aria-hidden className="absolute bottom-8 left-[26px] top-8 w-px bg-white/10" />
              {[
                {
                  n: 1,
                  lines: ['One', 'amount in'],
                  vis: <span className="font-num text-2xl font-light tabular-nums text-ink">$</span>,
                },
                {
                  n: 2,
                  lines: ['Split by', 'real weight'],
                  vis: (
                    <span className="flex w-28 flex-col gap-1.5 sm:w-32">
                      <span className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
                        {legs.map((leg) => {
                          const pct = shareOf(leg)
                          if (pct == null || pct <= 0) return null
                          return (
                            <span
                              key={leg.chainId}
                              className="h-full first:rounded-l-full last:rounded-r-full"
                              style={{ width: `${pct}%`, background: chainMeta(leg.chainId).color }}
                            />
                          )
                        })}
                      </span>
                      <span className="flex justify-between font-num text-[10px] tabular-nums text-ink-faint">
                        {legs.map((leg) => {
                          const pct = shareOf(leg)
                          if (pct == null || pct <= 0) return null
                          return <span key={leg.chainId}>{Math.round(pct)}%</span>
                        })}
                      </span>
                    </span>
                  ),
                },
                {
                  n: 3,
                  lines: ['A signature or two', 'per network'],
                  vis: (
                    <span className="flex items-center gap-1.5">
                      {legs.map((leg) => (
                        <ChainLogo key={leg.chainId} chainId={leg.chainId} size={22} />
                      ))}
                    </span>
                  ),
                },
              ].map((step) => (
                /* One grammar per breakpoint: a phone card is disc + title on
                   top with the visual on its own row beneath (the split bar at
                   full width squeezed the title track to 66px at 390, which
                   triple-wrapped the hand-set lines); sm+ is the one row it
                   always was, visual hugging the right edge. Grid, so the
                   title cell keeps min-width:0 via minmax and the disc stays
                   put for the spine at every width. */
                <div
                  key={step.n}
                  className="relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:py-6"
                >
                  <span className="relative z-10 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-panel font-num text-sm text-ink-dim">
                    {step.n}
                  </span>
                  <span className="font-display text-sm font-bold uppercase leading-snug tracking-wide text-ink">
                    {step.lines.map((line) => (
                      <span key={line} className="block">
                        {line}
                      </span>
                    ))}
                  </span>
                  <span className="col-start-2 flex items-center sm:col-start-3">{step.vis}</span>
                </div>
              ))}
            </div>

            {/* the fact chips are GONE (owner 2026-08-10: "we can just remove
                this") — the steps above carry the flow, the console's footer
                carries the signing line. Only the cannot-act state still
                speaks, because that one is load-bearing. */}
            {!SWAP_ENABLED && !isDemo && (
              <p className="mt-8 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-amber-200/90">
                Buying in one flow is <span className="text-ink">not live on this deployment</span> — the split is a
                plan. To act, open a network&rsquo;s basket on its own page.
              </p>
            )}
          </div>

          <div className="min-w-0">
            {/* THE CONSOLE — the swap page's own pay/flip/receive grammar over
                the whole thesis (owner 2026-08-09: "the actual nice buy/sell
                swap ui from the swap page in place of the current 500/1000
                etc"). Its receive panel IS the live split, which is why the
                old preview toggle and plan block are gone: the answer is on
                screen the whole time. It never executes — the run overlay
                below owns every signature. */}
            {needs != null || amountCents <= 0 ? (
              <ThesisConsole
                payNudge={payNudge}
                legs={legs}
                needs={needs}
                amount={amount}
                setAmount={setAmount}
                amountCents={amountCents}
                isDemo={isDemo}
                heldIndex={heldIndex}
                shareOf={shareOf}
                onRun={setRunMode}
              />
            ) : (
              <p className="text-sm leading-relaxed text-ink-dim">
                We cannot read how much sits on each network right now, so there is no honest way to divide an
                amount between them. Splitting it evenly would be inventing the creator&rsquo;s intent, so nothing
                is shown.
              </p>
            )}
          </div>
        </div>
      </Bezel>
      </section>

      {/* ── THE NETWORKS ───────────────────────────────────────────────────
          Last, and framed by share rather than by count. A slideshow on phones,
          a grid above (the creator page's own idiom, the owner 2026-08-09: "make
          that a slideshow for mobile"): stacked, three cards each carrying a
          basket is a very long scroll, and one per screen keeps each whole.
          Snap rather than a carousel widget, so it has the platform's momentum,
          respects reduced motion and needs no library. From lg every snap class
          stops applying and it is a plain grid. ── */}
      <section className="space-y-4">
        <SectionBar
          title="One token on each network"
          meta={legs.length === 1 ? 'together, the bundle' : 'together, they are the bundle'}
        />
        {/* THREE UP, SIDE BY SIDE (owner 2026-08-10, superseding the earlier
            two-up call): the width is BOUGHT rather than squeezed — the
            section breaks out of the column at xl (the Token page's own
            -mx idiom) and the card wrapper slims to p-3, which keeps each
            BasketCard above the ~245px floor where its buy chip once clipped.
            Verified rendered at 1280w. Phones keep the snap slideshow.
            `items-start` because a grid cell defaults to stretch. */}
        {/* items-STRETCH + flex columns (owner 2026-08-11: "these cards should
            always end at the bottom horizontally aligned"): the grid equalizes
            the wrappers, each wrapper is a column, and mt-auto seats the card
            block on the shared bottom line — the 4-asset card no longer leaves
            its 3-asset siblings ending ragged. */}
        <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:grid lg:snap-none lg:grid-cols-3 lg:items-stretch lg:gap-x-5 lg:gap-y-10 lg:overflow-visible lg:px-0 lg:pb-0 xl:-mx-[50px]">
          {legs.map((leg) => {
            const pct = shareOf(leg)
            const held = heldPosition(heldIndex, leg)
            const pnl = held ? basketPnl(pnlIdx[leg.chainId] ?? null, leg.address, leg.navPerToken, held.balance) : null
            return (
              /* basis + shrink-0 is what makes each a full-width page on a
                 phone; both are dropped at lg. The card is the compact
                 page-local face (BundleLegCard above) — the full BasketCard
                 restated the hero's identity block three times over. */
              <div
                key={`${leg.chainId}:${leg.address}`}
                className="flex min-w-0 shrink-0 basis-[86%] snap-start flex-col sm:basis-[62%] lg:basis-auto lg:shrink"
              >
                <BundleLegCard leg={leg} pct={pct} held={held} pnl={pnl} />
              </div>
            )
          })}
        </div>
      </section>

      {/* ── MORE FROM THIS CREATOR ─────────────────────────────────────────
          Their other cross-chain ideas in the SHOWCASE'S OWN md face (owner
          2026-08-16: the compact-card wall "looks super ugly" — same ruling
          as the creator page: one card language, the info on the card). Four
          at most; "everything they made →" is the door to the rest, so the
          cap is stated, never silent. Absent when they have none. ── */}
      {otherTheses.length > 0 && (
        <section className="space-y-4">
          <SectionBar
            title="More from this creator"
            meta={
              <Link to={creatorPath(deployer)} className="press text-cyan hover:text-ink">
                everything they made →
              </Link>
            }
          />
          <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:grid lg:snap-none lg:grid-cols-2 lg:items-start lg:gap-x-5 lg:gap-y-5 lg:overflow-visible lg:px-0 lg:pb-0">
            {otherTheses.slice(0, 4).map((t) => (
              <ThesisDoorCard
                key={`${t.deployer}::${t.name}`}
                thesis={t}
                size="md"
                className="min-w-0 shrink-0 basis-[86%] snap-start sm:basis-[62%] lg:basis-auto lg:shrink"
              />
            ))}
          </div>
        </section>
      )}

      {/* ── THE RUN ────────────────────────────────────────────────────────
          Portal overlay; the page underneath keeps its state, so closing the
          run lands the user exactly where they left. The overlay owns resume,
          refusal and every honesty rail — this mount is just the door. */}
      {howOpen && (
        /* the teaching popup: three beats, bundle language, nothing else —
           a reader should leave knowing what they are looking at and what
           pressing buy actually does */
        <div
          className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto p-4"
          role="dialog"
          aria-modal="true"
          aria-label="How bundles work"
          onClick={() => setHowOpen(false)}
        >
          <div className="absolute inset-0 bg-void/80 backdrop-blur-sm" aria-hidden />
          <div
            className="relative w-full max-w-md rounded-2xl border border-white/12 bg-panel/95 p-6 shadow-[0_40px_90px_-20px_rgba(0,0,0,0.85)] backdrop-blur-xl sm:p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">how bundles work</div>
            <h2 className="mt-3 font-display text-2xl font-bold uppercase leading-[1.05] tracking-tight text-ink">
              One idea, every network it lives on
            </h2>
            <div className="mt-6 space-y-5">
              {[
                {
                  n: 1,
                  head: 'A bundle is one idea on several networks',
                  body: 'A basket lives on a single network, so publishing an idea to three networks ships three basket tokens. The bundle reads them back as the one product they were meant to be.',
                },
                {
                  n: 2,
                  head: 'One price, one chart, one picture',
                  body: 'The combined price is one token of each basket added together, the chart is their total value, and the grid shows every asset weighted by its real share of the whole.',
                },
                {
                  n: 3,
                  head: 'Buy it in one go',
                  body: 'One amount splits across the networks by where the money actually sits, and each network\u2019s token is bought in a guided session \u2014 a signature or two per network, minimums enforced at signing.',
                },
              ].map((b) => (
                <div key={b.n} className="flex gap-4">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/15 font-num text-sm text-ink-dim">
                    {b.n}
                  </span>
                  <div className="min-w-0">
                    <div className="font-display text-sm font-bold uppercase tracking-wide text-ink">{b.head}</div>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">{b.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setHowOpen(false)}
              className="spectral-btn press mt-8 inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {runMode && (
        <ThesisRunOverlay
          thesis={thesis}
          accent={accent}
          mode={runMode}
          amountCents={amountCents}
          held={heldIndex}
          onClose={() => setRunMode(null)}
          onOfferPayAsset={() => setPayNudge((n) => n + 1)}
        />
      )}

      {/* the reshape popup — the thesis modal owns the per-chain tabs and the
          sequential deploy ceremony; this mount is just the door, like the
          run overlay's above. */}
      {reshapeOpen && (
        <ReshapeThesisModal
          deployer={thesis.deployer}
          name={thesis.name}
          legs={legs.map((l) => ({ address: l.address as `0x${string}`, chainId: l.chainId, symbol: l.symbol }))}
          demo={isDemo}
          onClose={() => setReshapeOpen(false)}
        />
      )}

      {/* the add-a-network doors: the picker chooses the basket, then the
          single-basket reshape opens in join mode for it — carrying THIS
          thesis's name, which is what adds it (reshape-types.ts). The demo
          rule is per SUBJECT, exactly the token page's: a demo basket walks
          the scripted ceremony, a real one deploys. */}
      {addOpen && (
        <AddNetworkPicker
          thesisName={thesis.name}
          thesisChainIds={thesis.chainIds}
          candidates={joinCandidates}
          heldIndex={heldIndex}
          onPick={(b) => {
            setAddOpen(false)
            setJoinPick({ address: b.address as `0x${string}`, chainId: b.chainId })
          }}
          onClose={() => setAddOpen(false)}
        />
      )}
      {joinPick && (
        <ReshapeBasketModal
          address={joinPick.address}
          chainId={joinPick.chainId}
          demo={isDemoLegAddress(joinPick.address)}
          joinThesis={{ name: thesis.name }}
          onClose={() => setJoinPick(null)}
        />
      )}
    </div>
  )
}
