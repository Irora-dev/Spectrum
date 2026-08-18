import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import bundleHeroArt1280 from '../assets/bundle-hero.1280.jpg'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchAssetHistory, type ChartRange } from '../lib/spectrum/history'
import { planPortfolioHistory } from '../lib/spectrum/portfolio-history'
import { computeWindowMove } from '../lib/spectrum/window-move'
import type { NavPoint } from '../lib/spectrum/basket-data'
import { DEV_PREVIEW_ADDRESS } from '../lib/spectrum/dev-preview'
import { buildLineageGraph } from '../lib/spectrum/versioning'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { useAccount, useEnsName, useSignMessage } from 'wagmi'
import { TRADING_ENABLED, WALLET_ENABLED } from '../lib/config/features'
import { useAllBaskets, usePortfolio } from '../lib/spectrum/hooks'
import { useExitCosts } from '../lib/spectrum/use-exit-costs'
import { useNavGaps } from '../lib/spectrum/use-nav-gaps'
import { loadExecLogGroup } from '../lib/spectrum/exec-log'
import { buildTradeHistoryCsv } from '../lib/spectrum/csv-export'
import { chainNameOf, useTradeHistory } from '../lib/spectrum/use-trade-history'
import { readLastSeen, stampLastSeen } from '../lib/spectrum/last-seen'
import { ApprovalsPanel } from '../components/portfolio/ApprovalsPanel'
import { computeExposure, type AssetExposure } from '../lib/spectrum/exposure'
import { chainTotals, unpricedChainIds } from '../lib/spectrum/chain-totals'
import { MoneyFacets, type MoneyFacet } from '../components/MoneyFacets'
import { combineExposure } from '../lib/spectrum/raw-holdings'
import { useRawHoldings } from '../lib/spectrum/use-raw-holdings'
import { cashPileSplit, foldCashPile, unifyAssets } from '../lib/spectrum/asset-unify'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { markSeenAndCollectNew } from '../lib/spectrum/seen-assets'
import { markWelcomed, shouldWelcome } from '../lib/spectrum/portfolio-welcome'
import { FirstVisitTour } from '../components/portfolio/FirstVisitTour'
import { browseWithoutOnboarding, shouldGatePortfolio } from '../lib/spectrum/onboarding-reveal'
import { anySignedIn, markSignedIn, signInMessage, verifySignIn } from '../lib/spectrum/portfolio-signin'
import { savePortfolioFromHoldings, topUpSeededPortfolio } from '../lib/spectrum/seed-from-holdings'
import { loadManualAssets } from '../lib/spectrum/manual-assets'
import { Bezel } from '../components/home/Spine'
import { foldDust } from '../lib/spectrum/dust-fold'
import { PasteToAdd } from '../components/portfolio/PasteToAdd'
import { ReleaseSurface } from '../components/portfolio/ReleaseSurface'
import { assetKey, GUEST_SCOPE, loadDraft, loadPortfolio, savePortfolioBand } from '../lib/spectrum/allocation'
import { basketPnl, pnlAvailable, usePnlIndexes } from '../lib/spectrum/pnl'
import { flowHref } from '../lib/spectrum/flow-link'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { BridgeBanner } from '../components/BridgeFund'
import { stocksForChain } from '../lib/chain/stocks'
import { basketHref, creatorHref } from '../lib/spectrum/short-url'
import { useHandleForAddress } from '../lib/spectrum/use-handles'
import { changeAccent, formatPrice, formatUsdCompact, formatUsdTight, moneyPrivacyOn, setMoneyPrivacy, shortAddr } from '../lib/spectrum/format'
import { AssetLogo } from '../components/AssetLogo'
import { BasketAvatar } from '../components/BasketAvatar'
import { BasketBento, BentoClassLegend, ClassSignalGlyph, type LegendClass } from '../components/BasketBento'
import { RunProgressStyles } from '../components/run-progress'
import { RUN_LANDED_EVENT, takeRunLanded } from '../lib/spectrum/run-landed'
import { classSignalFor } from '../lib/spectrum/class-signal'
import { CategoryPills } from '../components/CategoryPills'
import { Carousel } from '../components/Carousel'
import { CopyAddress } from '../components/CopyAddress'

/** Phone = UIGuy's shared Carousel rail; desktop keeps the caller's own
 *  layout. Exists because the insights strip's desktop state is wrap-grow
 *  FLEX (an odd last card grows to fill its row), which the Carousel's
 *  grid-at-breakpoint state cannot express — so the fork lives here, once. */
function MaybeCarousel({
  phone,
  label,
  peek,
  desktopClassName,
  children,
}: {
  phone: boolean
  label: string
  peek?: string
  desktopClassName: string
  children: ReactNode
}) {
  return phone ? (
    <Carousel label={label} gridFrom="never" peek={peek}>
      {children}
    </Carousel>
  ) : (
    <div className={desktopClassName}>{children}</div>
  )
}

/** Spotlight regions: lit tiles cluster first, dimmed follow (~23:2x). */
const SPOTLIGHT_ORDER = ['lit', 'dim']
import { categoryPills } from '../lib/spectrum/asset-categories'
import { PublishPicker } from '../components/PublishPicker'
import { BasketContents } from '../components/BasketContents'
import { ChainBadge, chainMeta } from '../components/ChainBadge'
import { MigrateModal } from '../components/MigrateModal'
import { groupIntoTheses } from '../lib/spectrum/thesis'
import { thesisHref } from '../lib/spectrum/thesis-url'
import { FreshDot } from '../components/FreshDot'
import { InfoDot } from '../components/InfoDot'
import { PortfolioChart, type ChartReadout } from '../components/PortfolioChart'
import { CASH_GREEN, CASH_SYMBOLS, capLabel, classifyTier, TIER_LABELS, TIER_ORDER, TIER_THRESHOLDS, type MarketTier } from '../lib/spectrum/market-tiers'
import { useMarketData } from '../lib/spectrum/use-market-tiers'
import { awayInsights, buildInsights, findDepegs, DRIFT_THRESHOLD_PP, DUST_CEILING_USD } from '../lib/spectrum/insights'
import {
  captureAwaySnapshot,
  diffAwaySnapshots,
  loadAwaySnapshot,
  saveAwaySnapshot,
  type AwaySnapshot,
} from '../lib/spectrum/away-diff'
import { buildPortfolioCsv } from '../lib/spectrum/csv-export'
import { useHistoryInsights } from '../lib/spectrum/use-history-insights'
import { drawShareCard, shareCardItems } from '../lib/spectrum/share-card'
import { InsightCard } from '../components/InsightCard'
import { RiskSpectrum, type SpectrumAsset } from '../components/RiskSpectrum'
import { chartLinksFor } from '../lib/spectrum/chart-links'
import { PositionsMode } from '../components/PositionsMode'
import type { PositionRow } from '../lib/spectrum/position-intents'
import { PortfolioClaims, usePortfolioClaimables } from '../components/PortfolioClaims'
import { useClaimAll } from '../lib/spectrum/use-fee-actions'
import { ReferIntro } from '../components/ReferIntro'
import { WalletButton } from '../components/WalletButton'
import { LinkedWallets } from '../components/portfolio/LinkedWallets'
import { LiquidityPositions } from '../components/portfolio/LiquidityPositions'
import { RecentTransactions } from '../components/portfolio/RecentTransactions'
import { walletName } from '../lib/spectrum/wallet-names'
import { readLpPositions, withLpExposure } from '../lib/spectrum/lp-positions'
import { RestoreBackup } from '../components/portfolio/RestoreBackup'
import { useWalletGroup } from '../lib/spectrum/use-wallet-group'

// ─────────────────────────────────────────────────────────────────────────────
// YOURS — the portfolio page. Round 4 (the owner 11:26): NOTHING LEAVES THE PAGE —
// Edit weights flips the weighting card into an inline target editor · Add
// opens the asset-search popup and lands picks in the weighting · Fees &
// claims opens a closeable on-page panel (the classic-page trip is dead) ·
// the hero tightens upward and gains the tracked INVESTED / net line beside
// the window delta · public baskets carry TVL/holders/pending-fee facts ·
// gentle facts-only insights under the weighting. Rail polish: Add is a
// rounded rectangle at rest, its open label reads as one phrase, and the
// spectral emphasis FOLLOWS the hovered action.
//
// Laws: one combined picture · facts only, no scores · failed reads are
// unreadable never zero · unpriced holdings visible, never weighted ·
// targets are device-local INTENT (executing happens in the flow) ·
// URL-INTENT contract for every flow link, via flowHref (flag-aware —
// UIGuy's convergence requirement: no CTA may silently land on Home).
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
const SEG = ['var(--color-cyan)', 'var(--color-violet-bright)', 'var(--color-magenta)', 'var(--color-amber)', 'var(--color-teal)']
// Category segments (composition): data colours, amber deliberately skipped —
// on a facts-only surface amber reads as caution (PM lesson, 10:19 round).
const CAT_COLORS = ['var(--color-cyan)', 'var(--color-violet-bright)', 'var(--color-magenta)', 'var(--color-teal)']

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDG', 'USDS', 'PYUSD', 'FDUSD', 'GHO', 'LUSD'])
const MAJORS = new Set(['ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC'])

function Shell({ children, enterIndex = 0, glow, bright = false }: { children: ReactNode; enterIndex?: number; glow?: string; bright?: boolean }) {
  return (
    <div className="enter rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5" style={{ '--enter-i': enterIndex } as CSSProperties}>
      <div className={`relative overflow-hidden rounded-[calc(2rem-0.375rem)] ${bright ? 'bg-panel/60' : 'bg-panel/70'} shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)] backdrop-blur-md`}>
        <div
          aria-hidden
          className="h-1 w-full motion-reduce:[animation:none]"
          style={{ background: SPECTRAL, backgroundSize: '300% 100%', animation: 'spectrum-refract 16s ease-in-out infinite' }}
        />
        {bright && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              background:
                'linear-gradient(120deg, color-mix(in srgb, var(--color-cyan) 10%, transparent) 0%, color-mix(in srgb, var(--color-violet-bright) 12%, transparent) 45%, transparent 80%)',
            }}
          />
        )}
        {glow && (
          <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full opacity-20 blur-3xl" style={{ background: glow }} />
        )}
        {children}
      </div>
    </div>
  )
}

function BigTotal({ usd }: { usd: number }) {
  const s = formatUsdCompact(usd)
  const m = /^\$([\d.,]+)([KMB])?$/.exec(s)
  if (!m) return <span className="font-num text-6xl font-light tabular-nums text-ink sm:text-8xl">{s}</span>
  return (
    <span className="flex items-baseline font-num text-6xl font-light leading-none tabular-nums text-ink sm:text-8xl">
      <span className="mr-2 text-4xl text-ink-faint">$</span>
      {m[1]}
      {m[2] && <span className="ml-2 text-4xl text-ink-faint">{m[2]}</span>}
    </span>
  )
}

const ICONS = {
  composition: (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" />
    </svg>
  ),
}

/** The previous visit's away snapshot, read ONCE per anchor per SESSION —
 *  the last-seen lesson verbatim: the portfolio REMOUNTS when the intro's
 *  veil lifts (the reveal's key flip; StrictMode doubles mounts in dev too),
 *  and a per-mount read lets the first mount's saver overwrite yesterday
 *  before the real mount ever reads it. The module-level cache means every
 *  remount gets the same yesterday, and the session's own saves can't eat
 *  the story it is telling. */
const awayPrevSession: Record<string, AwaySnapshot | null> = {}
function readAwayPrevOnce(anchor: string): AwaySnapshot | null {
  const k = anchor.toLowerCase()
  if (!(k in awayPrevSession)) awayPrevSession[k] = loadAwaySnapshot(anchor)
  return awayPrevSession[k]
}

/** Persists the away snapshot AFTER the paint that showed the briefing (desk
 *  46's own instruction: save after the render so a refresh does not eat the
 *  story). A null-rendering child so the effect lives in ITS hook order, not
 *  the page's — the insights zone sits below Yours' early returns, where a
 *  hook would be the hooks-order crash that once blanked this page. The
 *  briefing itself stays stable because the PREVIOUS snapshot is session-
 *  cached above, so this write cannot eat it. */
function AwaySnapSaver({ anchor, snap }: { anchor: string; snap: AwaySnapshot }) {
  // a cheap signature so routine re-renders (market refetches shuffling
  // object identity) don't rewrite storage every frame; value changes do
  const sig = `${anchor}|${snap.totalUsd ?? 'x'}|${Object.entries(snap.positions)
    .map(([k, p]) => `${k}:${p.pct.toFixed(2)}:${p.exitCostPct?.toFixed(2) ?? ''}`)
    .sort()
    .join(',')}`
  useEffect(() => {
    saveAwaySnapshot(anchor, snap)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  return null
}

function ActionIcon({ kind }: { kind: 'publish' | 'fees' }) {
  const common = { viewBox: '0 0 24 24', className: 'h-4 w-4 shrink-0', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (kind === 'publish')
    return (
      <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 16V8" /><path d="M8.5 11.5L12 8l3.5 3.5" /></svg>
    )
  return <svg {...common}><circle cx="9" cy="9" r="5" /><circle cx="15" cy="15" r="5" /></svg>
}

type Cat = [string, number]

/** Category rows — shared by the rail's expanded panel and the mobile card. */
function CompRows({ cats, top1, compact = false }: { cats: Cat[]; top1: AssetExposure | null; compact?: boolean }) {
  return (
    <div>
      {cats.map(([label, pct], i) => (
        <div key={label} className={compact ? 'py-2' : 'border-b border-white/8 py-3 last:border-b-0 last:pb-0'}>
          <div className="flex items-baseline justify-between gap-2">
            <span className={`inline-flex items-center gap-1.5 font-mono uppercase text-ink-dim ${compact ? 'text-[10px] tracking-[0.12em]' : 'text-[11px] tracking-[0.12em]'}`}>
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CAT_COLORS[i % CAT_COLORS.length] }} />
              {label}
            </span>
            <span className={`font-num font-semibold tabular-nums text-ink ${compact ? 'text-sm' : 'text-base'}`}>{pct.toFixed(0)}%</span>
          </div>
          <div className={`${compact ? 'mt-1.5 h-1' : 'mt-2 h-1'} w-full overflow-hidden rounded-full bg-white/[0.07]`}>
            <span className="block h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: CAT_COLORS[i % CAT_COLORS.length] }} />
          </div>
        </div>
      ))}
      {top1 && (
        /* div, not p — kit CSS had unlayered p{text-wrap:pretty} defeating
           truncate (fixed kit-side @ 4d253b7; div stays fine semantically).
           compact = the 264px rail: the long label truncated the PERCENT
           ("$WETH · 30…") — the number is the point, so the label yields. */
        <div className={`truncate font-mono uppercase tracking-[0.12em] text-ink-faint ${compact ? 'mt-2 text-[10px]' : 'mt-3 text-[10px]'}`}>
          {compact ? 'largest: ' : 'largest single position: '}
          <span className="text-ink">${showSymbol(top1.symbol)}</span>
          {compact ? ` · ${top1.pct.toFixed(0)}%` : ` at ${top1.pct.toFixed(0)}%`}
        </div>
      )}
    </div>
  )
}

/** THE ONBOARDING GATE (owner 2026-08-13: "if a person like me genuinely
 *  doesn't finish the signup, the portfolio page should just have a pretty
 *  card that says you must complete onboarding (it takes less than 5
 *  minutes)"). One card, one action — rendered INSTEAD of the page for a
 *  connected wallet that never had its arrival played. The quiet secondary is
 *  the same per-wallet dismissal the 2026-08-12 invite plate used, so the
 *  escape hatch survives without being the default experience. */
function OnboardingGateCard({
  owner,
  onBrowse,
  onSignedIn,
}: {
  owner: string
  onBrowse: () => void
  /** Fired after the signature VERIFIED and the latch is set — the page
   *  completes the add (holdings → saved allocation) and drops the gate. */
  onSignedIn: () => void
}) {
  // THE RETURNING DOOR (the owner 2026-08-13: "you can 'log into' your portfolio
  // by signing with one of your linked wallets, from both returning and also
  // from the main onboarding flow as right now it just goes to the portfolio
  // page and says complete onboarding"). Sign-in leads; the guided onboarding
  // stays as the quiet second door for a genuinely new wallet. Same ceremony
  // laws as the arrival's door: verify what came back before latching, and
  // every refusal states itself.
  const { signMessageAsync } = useSignMessage()
  const [state, setState] = useState<'idle' | 'signing' | 'declined' | 'unverified'>('idle')
  const signIn = async () => {
    setState('signing')
    const message = signInMessage(owner, window.location.host, Date.now())
    try {
      const signature = await signMessageAsync({ account: owner as `0x${string}`, message })
      if (!(await verifySignIn(owner, message, signature))) {
        setState('unverified')
        return
      }
      markSignedIn(owner)
      onSignedIn()
    } catch {
      setState('declined')
    }
  }
  return (
    <div className="grid min-h-[60vh] place-items-center px-4">
      <div className="w-full max-w-xl">
        <Bezel glow="var(--color-cyan)" panel="bg-panel/95">
          <div className="p-7 text-center sm:p-10">
            {/* way less text (owner 2026-08-13, on this card's first cut):
                the headline + one line carry it. */}
            <h1 className="font-display text-3xl font-bold uppercase leading-[0.95] tracking-tight text-ink sm:text-4xl">
              Sign in to
              <br />
              your portfolio
            </h1>
            <p className="mx-auto mt-5 max-w-[42ch] text-[14px] leading-relaxed text-ink-dim">
              One signature proves{' '}
              <span className="font-mono text-[13px] text-ink">{owner.slice(0, 6)}…{owner.slice(-4)}</span>{' '}
              is yours — it reads balances only, spends nothing.
            </p>
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => void signIn()}
                disabled={state === 'signing'}
                className="spectral-btn press inline-flex h-12 items-center rounded-xl px-8 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
              >
                {state === 'signing' ? 'Waiting for your wallet…' : 'Sign in with this wallet'}
              </button>
            </div>
            {(state === 'declined' || state === 'unverified') && (
              <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint" role="status">
                {state === 'declined'
                  ? 'The signature was declined — nothing signed in.'
                  : 'This signature could not be verified as this wallet’s, so it cannot sign in.'}
              </p>
            )}
            <p className="mt-7 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
              new here?{' '}
              <Link
                to="/onboarding"
                className="text-ink-dim underline decoration-white/20 underline-offset-4 hover:text-ink"
              >
                take the guided onboarding →
              </Link>
            </p>
            <button
              type="button"
              onClick={onBrowse}
              className="press mt-3 inline-flex min-h-[36px] items-center font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint underline decoration-white/20 underline-offset-4 hover:text-ink"
            >
              browse without signing in
            </button>
          </div>
        </Bezel>
      </div>
    </div>
  )
}

function ConnectGate() {
  return (
    <div className="grid min-h-[50vh] place-items-center">
      <div className="text-center">
        <h1 className="font-display text-3xl font-bold uppercase tracking-tight text-ink">Your portfolio</h1>
        <p className="mx-auto mt-3 max-w-[40ch] text-[13px] leading-relaxed text-ink-dim">
          Connect to see everything you hold, baskets looked through to their assets plus
          what sits in your wallet directly, as one picture.
        </p>
        <div className="mt-6 flex justify-center">
          <WalletButton />
        </div>
        {/* the recovery door, where a wiped browser actually lands */}
        <div className="mt-5 flex justify-center">
          <RestoreBackup />
        </div>
      </div>
    </div>
  )
}

export function Yours() {
  const { address, isConnected } = useAccount()
  // THE DEMO DOOR (owner 2026-08-05: "load a local with a demo portfolio"):
  // /portfolio?demo=1 forces the preview book EVEN WHILE CONNECTED — before
  // this, the fixtures only answered when no wallet was connected, and an
  // auto-connecting wallet made the demo unreachable. Dev-gated twice over:
  // the flag only reads in dev, and the fixtures themselves answer only for
  // DEV_PREVIEW_ADDRESS in dev builds. Production cannot show a fake book.
  const [searchParams] = useSearchParams()
  const demoRequested = import.meta.env.DEV && searchParams.get('demo') === '1'
  const effectiveAddress = demoRequested
    ? DEV_PREVIEW_ADDRESS
    : isConnected && address
      ? address
      : import.meta.env.DEV
        ? DEV_PREVIEW_ADDRESS
        : undefined
  // The linked-wallet GROUP (wallet-links.ts): the READ merges every member;
  // acting, drafts, targets and pnl stay keyed to the ACTIVE wallet — the only
  // one that can sign.
  const walletGroup = useWalletGroup(effectiveAddress)
  const readAddresses = walletGroup.isGroup ? walletGroup.addresses : effectiveAddress
  // SINCE YOU WERE AWAY (desk 46): the previous visit's snapshot, session-
  // cached per anchor (readAwayPrevOnce) — the veil remount and the saver's
  // own writes must never eat the story mid-session. Keyed to the GROUP
  // anchor so the briefing follows the BOOK, not the device's connection
  // order.
  const awayAnchor = walletGroup.group.anchor || effectiveAddress || null
  const awayPrev = useMemo(() => (awayAnchor ? readAwayPrevOnce(awayAnchor) : null), [awayAnchor])

  const { data: p, isLoading, isError, chainsFailed: basketChainsFailed, refetch: refetchPortfolio } = usePortfolio(readAddresses)
  const { data: ens } = useEnsName({ address: effectiveAddress as `0x${string}`, chainId: 1 })
  // The wallet's CLAIMED NAME, for the invite link (desk 202, my call on the
  // owner's short-links note): a named creator's ref link carries their name —
  // resolveRefInput resolves it back through the registry on capture, so the
  // money paths are untouched. Falls through name → ENS → address; the shared
  // registry query costs nothing new (same cache the titles/claim form read).
  const { lookup: myHandle } = useHandleForAddress(effectiveAddress)
  const claimedName = myHandle.status === 'found' ? myHandle.owner.display : null
  const navigate = useNavigate()
  const raw = useRawHoldings(readAddresses)

  // SUPERSEDED HELD BASKETS (Ⓡ the owner ruled 2026-08-04, model-review #3): the
  // deployer-signed lineage graph, built per chain the held baskets live on
  // (UIGuy's versioning.ts — the same graph the basket page's useLineage
  // reads, same cache keys' 5-min staleness). Hook lives ABOVE the early
  // returns (the hooks-order law); the card derivation joins the strip below.
  const allBaskets = useAllBaskets()
  const heldForLineage = useMemo(
    () =>
      (p?.holdings ?? []).map((h) => ({
        chainId: h.basket.chainId,
        address: h.basket.address.toLowerCase(),
        symbol: h.basket.symbol,
        valueUsd: h.valueUsd,
      })),
    [p],
  )
  const lineageSig = heldForLineage.map((h) => `${h.chainId}:${h.address}`).sort().join('|')
  const supersededQuery = useQuery({
    queryKey: ['spectrum', 'held-superseded', lineageSig],
    enabled: heldForLineage.length > 0 && allBaskets.data != null,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const all = allBaskets.data ?? []
      const bySymbol = new Map(all.map((b) => [`${b.chainId}:${b.address.toLowerCase()}`, b.symbol]))
      const chains = [...new Set(heldForLineage.map((h) => h.chainId))]
      const out: NonNullable<Parameters<typeof buildInsights>[0]['superseded']> = []
      for (const chainId of chains) {
        const refs = all
          .filter((b) => b.chainId === chainId)
          .map((b) => ({ address: b.address, chainId: b.chainId, deployer: b.deployer }))
        if (refs.length === 0) continue
        const graph = await buildLineageGraph(refs)
        for (const h of heldForLineage) {
          if (h.chainId !== chainId || !graph.hasSuccessor(h.address)) continue
          const succ = graph.successorOf(h.address)
          if (!succ) continue
          const newSymbol = bySymbol.get(`${chainId}:${succ}`)
          if (!newSymbol) continue // an unnamed successor is not a sayable fact
          out.push({
            key: `${chainId}:${h.address}`,
            oldSymbol: h.symbol,
            newSymbol,
            newAddress: succ,
            oldAddress: h.address,
            chainId,
            valueUsd: h.valueUsd,
          })
        }
      }
      return out
    },
  })

  // On-page surfaces (owner 11:26: "so you don't have to leave the page")
  const [feesOpen, setFeesOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  /** The supersession card's one-click swap (owner 2026-08-16) — the REAL
   *  MigrateModal mounted from the insight strip; null = closed. */
  const [migrateFor, setMigrateFor] = useState<null | {
    fromAddr: string
    fromSymbol: string
    toAddr: string
    toSymbol: string
    chainId: number
  }>(null)
  /** The publish picker popup (owner 22:00: the publish button "just takes
   *  you to a random page" — it opens the dark-tile selection popup now).
   *  With nothing held there is no mix to pick from, so the button falls
   *  back to the create flow's own publish door. */
  const [publishOpen, setPublishOpen] = useState(false)
  /** The category spotlight (owner 23:09) — one pill at a time; null = off. */
  // the spotlight pick is remembered per device, same rule as the chart
  // window (touch round 3) — the page opens exactly as you left it
  const [catFilter, setCatFilter] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem('spectrum:spotlight') || null
    } catch {
      return null
    }
  })
  useEffect(() => {
    try {
      if (catFilter) window.localStorage.setItem('spectrum:spotlight', catFilter)
      else window.localStorage.removeItem('spectrum:spotlight')
    } catch {
      /* private browsing: the pick just does not persist */
    }
  }, [catFilter])
  /** Privacy mode (feature 5) — mirrors the module flag so toggling re-renders. */
  const [privacy, setPrivacy] = useState(moneyPrivacyOn())
  /** Your public baskets, collapsible (owner ~11:2x note). */
  const [basketsOpen, setBasketsOpen] = useState(true)
  /** Drift-alert band (feature 3) — mirrors the saved plan's bandPp; the
   *  effective value derives below once `saved` exists. */
  const [bandState, setBandState] = useState<number | null>(null)
  // the band's settings-cog popover (12:18) — closed on Escape/outside via
  // the button's own toggle; transient UI, never persisted
  const [bandOpen, setBandOpen] = useState(false)
  /** Targets the reshape mode should open WITH — set by an insight card's
   *  one-tap action, cleared when the mode closes so a later manual open
   *  starts clean. */
  const [seedTargets, setSeedTargets] = useState<Map<string, number> | null>(null)
  // the preset's NAME travels with its targets (the owner 2026-08-06: "it should
  // show the preset thing of what you recommended" — a silently-staged change
  // reads as nothing happening), shown as a banner in the mode
  const [seedNote, setSeedNote] = useState<string | null>(null)
  /** HOW THE POSITIONS ARE DRAWN (owner ~21:0x: "instead of cramming the bento
   *  next to the portfolio table, have it as a toggle between the card layout
   *  and the bento layout so each can take up full width and be genuinely
   *  beautiful; default to the table but make the switch pill obvious").
   *  Side by side, the list was squeezed to a column and the bento to 320px and
   *  neither was good. One at a time, both get the whole width. */
  // DEFAULT IS THE PICTURE (owner ~21:2x: "have that grid layout as default as
  // it's certainly beautiful, and you can see the positions increasing in size
  // / moving up the ladder as they get bigger"). It only earns the default now
  // that a tile carries its own amount — before, it was shares without money.
  const [mixView, setMixView] = useState<'list' | 'bento'>('bento')
  // SORT-BY-WALLET (owner's queue item): the picture regroups by WHO HOLDS
  // each tile — basket rows carry contributors since the fold stopped
  // dropping them; raw token rows always did. A tile's home = its biggest
  // contributor; unattributable tiles group under 'elsewhere', said, never
  // guessed. Display-only: totals, weights and stores never move.
  const [groupByWallet, setGroupByWallet] = useState(false)
  const [readout, setReadout] = useState<ChartReadout | null>(null)
  const [railFocus, setRailFocus] = useState<null | 'publish' | 'fees'>(null)
  // The extension stamps its marker at document_start (site-configured builds
  // only), so a mount-time read never races it — event listening unnecessary
  // (SpecExt hand-off, 2026-08-02; offer only to those WITHOUT it).
  // the extension ships later (the owner 2026-08-06 12:18) — flip when it does
  const LENS_OFFER_ENABLED = false
  const [lensInstalled] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.spectrumLens != null,
  )

  // ONLY what was ADDED into the system counts here (the owner 2026-08-02: "it
  // should purely show stats based on what you have added" — supersedes the
  // broader any-asset framing; the full-wallet sweep stays as machinery for
  // add-from-wallet UX, never for these stats). Scope = the saved allocation's
  // targets, valued by the wallet's actual balances.
  // savedTick: the sign-in add writes the saved allocation IN PLACE (no
  // navigate-away-and-back remount like the flow's add), so the tick re-keys
  // every memo that reads the store.
  const [savedTick, setSavedTick] = useState(0)
  const saved = useMemo(
    () => (effectiveAddress ? loadPortfolio(effectiveAddress) : null),
    [effectiveAddress, savedTick],
  )
  const allocKeys = useMemo(
    () => new Set((saved?.targets ?? []).map((t) => assetKey(t.asset))),
    [saved],
  )
  // What the portfolio COUNTS: only what was added into the system (his own
  // scope correction). The DEV fixture's demo tokens count too — they exist so
  // the surface can be reviewed with tokens AND baskets in one portfolio, and
  // `fixture` can only be set by a module that is dynamically imported behind
  // import.meta.env.DEV, so no operator build can reach this branch.
  const addedHoldings = useMemo(
    // manual rows count as ADDED by definition (owner 2026-08-12: pasted
    // addresses ARE the explicit add) — same clause the fixture rides.
    // A NATIVE row matches through its WETH form (the owner live 2026-08-13:
    // "not detecting eth" — the seeded add writes the WRAPPED form, the
    // tradeable leg, so the sentinel-address key never matched its own
    // target and the wallet's biggest holding vanished from the book the
    // reveal had just played).
    () =>
      (raw.data?.holdings ?? []).filter((h) => {
        if (h.fixture === true || h.manual === true) return true
        if (allocKeys.has(assetKey(h))) return true
        if (h.native) {
          try {
            const weth = chainCfg(h.chainId).weth
            return !!weth && allocKeys.has(assetKey({ chainId: h.chainId, address: weth }))
          } catch {
            return false // unknown chain: no wrap form to match through
          }
        }
        // DISCOVERED REAL MONEY DISPLAYS (owner 2026-08-15, live: "the
        // portfolio doesnt seem to track my NVDA position" — 16 NVDA bought
        // AFTER the book was seeded, on a book he had since composed, was
        // invisible BY CONSTRUCTION: the store top-up never touches a
        // user-composed book, correctly, but this gate then hid the holding
        // from the DISPLAY too). The page's identity is "everything you
        // hold": a priced discovered holding above the house dust floor
        // shows — the STORE stays chosen (the composed-book ruling stands),
        // the dust floor keeps spam out, unpriced stays under the honest
        // unpriced note rather than wearing a fake zero.
        return h.usd != null && h.usd >= DUST_CEILING_USD
      }),
    [raw.data, allocKeys],
  )

  // Per-wallet readable totals off the merge's own attribution (group pill).
  // BOTH HALVES NOW (2026-08-11): the raw-token sweep always carried
  // `contributors`, and the basket read learned to as well — so a member row
  // shows what that wallet actually holds instead of tokens only with a
  // footnote apologising for the missing half.
  const readableByWallet = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of raw.data?.holdings ?? [])
      for (const c of h.contributors ?? []) {
        if (c.usd != null && c.usd > 0) m.set(c.owner, (m.get(c.owner) ?? 0) + c.usd)
      }
    for (const [owner, usd] of p?.basketUsdByWallet ?? []) {
      if (usd > 0) m.set(owner, (m.get(owner) ?? 0) + usd)
    }
    return m
  }, [raw.data, p?.basketUsdByWallet])

  // WHOLE BASKETS, not look-through (owner 2026-08-16, comparing this bento to
  // the reshape picture: "the main portfolio doesnt show it as baskets like it
  // should") — each held basket is ONE row under its own key, legs riding for
  // the tile's nested mini-map. The bento's basket machinery (heldBasketKeys,
  // basketLegsByKey, the basket class signal) keys on exactly these rows.
  const exposure = useMemo(() => (p ? computeExposure(p.holdings, { basketFold: 'whole' }) : null), [p])
  const combinedBase = useMemo(
    () => (exposure ? combineExposure(exposure, addedHoldings) : null),
    [exposure, addedHoldings],
  )
  // LP positions fold into the book's exposure LIKE ANY OTHER ASSET (owner
  // 2026-08-15: bento tile + counted in the total) — the same append/re-total/
  // re-weight doctrine combineExposure applies to direct holdings. Display
  // layer only: nothing here reaches the allocation store or any trade path.
  const lpRead = useQuery({
    queryKey: ['lp-positions', effectiveAddress],
    queryFn: () => readLpPositions(effectiveAddress as `0x${string}`, [...SUPPORTED_CHAIN_IDS]),
    enabled: !!effectiveAddress,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  const combined = useMemo(() => withLpExposure(combinedBase, lpRead.data), [combinedBase, lpRead.data])
  const stockSyms = useMemo(() => new Set(stocksForChain(4663).map((s) => s.symbol)), [])

  // Tracked cost basis (pnl.ts: router-traded baskets only — transfers and
  // in-kind mints have no knowable price and are EXCLUDED; never a guess).
  // the total COUNTS UP on reveal (the owner: "more interesting intro animations
  // for the card and stats") — cubic ease-out, once per target, reduced-motion
  // and zero-safe (shows the final number immediately)
  const totalTarget = combined?.totalUsd ?? 0
  const [animatedTotal, setAnimatedTotal] = useState(0)
  const animatedRef = useRef(0)
  animatedRef.current = animatedTotal
  useEffect(() => {
    // Ease from the CURRENTLY SHOWN value, not from zero: the effect re-fires
    // on every refetch that moves totalUsd (staleTime makes that routine), and
    // a from-zero ease made the total visibly collapse to $0 and re-count on
    // each one. First reveal still counts up from 0 (ref starts there); a
    // target of 0 shows 0 immediately (never a stale number).
    if (!(totalTarget > 0)) {
      setAnimatedTotal(0)
      return
    }
    const from = animatedRef.current
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setAnimatedTotal(totalTarget)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 900)
      setAnimatedTotal(from + (totalTarget - from) * (1 - Math.pow(1 - k, 3)))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [totalTarget])

  // THE ACCOUNTANT'S DOCUMENT (the owner 2026-08-11). On click only — see
  // use-trade-history for why it never runs on mount.
  const tradeHistory = useTradeHistory()
  const [taxYear, setTaxYear] = useState<number | 'all'>('all')
  // an export attempt that came back EMPTY — a real answer, said out loud as a
  // quiet note under the header, never a silent return (audit 2026-08-12)
  const [tradeHistoryEmpty, setTradeHistoryEmpty] = useState(false)
  // Whether ANY chain can serve trade history on this build (a keyless build
  // serves none — pnl.ts refuses wide public-RPC scans). When false, the
  // export button hides outright, the Invested line's own self-hide precedent:
  // never render a control that cannot produce its document.
  const tradeHistoryPossible = SUPPORTED_CHAIN_IDS.some((id) => pnlAvailable(id))

  const pnlIdx = usePnlIndexes(readAddresses)
  const pnlTotals = useMemo(() => {
    const holdings = p?.holdings ?? []
    let invested = 0
    let current = 0
    let counted = 0
    let partial = false
    for (const h of holdings) {
      const pnl = basketPnl(pnlIdx[h.basket.chainId], h.basket.address, h.basket.navPerToken, h.balance)
      if (!pnl || pnl.investedUsd <= 0) continue
      counted++
      invested += pnl.investedUsd
      current += pnl.currentUsd
      if (pnl.coverage < 0.99) partial = true
    }
    if (counted === 0 || invested <= 0) return null
    if (counted < holdings.length) partial = true
    const net = current - invested
    return { invested, net, netPct: (net / invested) * 100, partial }
  }, [p, pnlIdx])

  // Claimables (holder + creator buckets) — feeds the fees panel AND the
  // public-baskets tally, one set of reads.
  const claimAgg = usePortfolioClaimables(useMemo(() => (p?.holdings ?? []).map((h) => h.basket), [p]))
  // the insta-claim beside the tally (owner 2106): the same guarded sweep the
  // fees panel runs — one press, every claimable basket
  const tallyClaim = useClaimAll()
  const createdByBasket = useMemo(() => {
    const m = new Map<string, number>()
    for (const { b, usdc } of claimAgg.created) m.set(`${b.chainId}:${b.address.toLowerCase()}`, usdc)
    return m
  }, [claimAgg.created])

  // HOOKS stay above the early returns (loading/error) — useMarketTiers wraps
  // useQueries; empty input while loading keeps the call unconditional.
  const histAssets = useMemo(
    () => (combined?.assets ?? []).map((a) => ({ chainId: a.chainId, address: a.address, valueUsd: a.valueUsd, symbol: a.symbol })),
    [combined],
  )
  // ── THE MOVERS FOLLOW THE WINDOW (2106 board, last named item) ─────────────
  // The chart lifts its range up (onRange); seeded from the chart's OWN
  // device-local pref so the first render already agrees before the lift fires.
  const [chartRange, setChartRange] = useState<ChartRange>(() => {
    try {
      const saved = window.localStorage.getItem('spectrum:chart-range')
      return saved === '24H' || saved === '7D' || saved === '30D' ? saved : '7D'
    } catch {
      return '7D'
    }
  })
  // The SAME plan the chart's history hook runs (native→WETH mapping and the
  // per-key dollar merge come with it), the SAME query keys — so on any range
  // the chart has shown, every one of these is a cache hit: zero extra RPC.
  // 24H needs none of this (the strip's live market source is better there).
  const histSig = histAssets.map((a) => `${a.chainId}:${a.address.toLowerCase()}:${Math.round(a.valueUsd)}`).join('|')
  const windowPlan = useMemo(() => planPortfolioHistory(histAssets), [histSig]) // eslint-disable-line react-hooks/exhaustive-deps
  const windowResults = useQueries({
    queries: windowPlan.fetches.map((f) => ({
      queryKey: ['spectrum', 'assetHist', f.chainId, f.address, chartRange],
      queryFn: () => fetchAssetHistory(f.chainId, f.address, chartRange, null),
      enabled: chartRange !== '24H' && (combined?.totalUsd ?? 0) > 0,
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
    })),
  })
  const windowSettled = chartRange !== '24H' && windowResults.length > 0 && windowResults.every((r) => !r.isLoading)
  const windowUpdatedKey = windowResults.map((r) => r.dataUpdatedAt).join(',')
  const windowMove = useMemo(() => {
    if (chartRange === '24H' || !windowSettled) return null
    // the plan already named each key with its dominant contributor's symbol
    const inputs = windowPlan.fetches.map((f, i) => ({
      key: f.key,
      symbol: f.symbol ?? '?',
      valueUsd: windowPlan.inputs[i]?.weight ?? 0,
    }))
    const series = new Map<string, NavPoint[]>()
    windowPlan.fetches.forEach((f, i) => series.set(f.key, windowResults[i]?.data ?? []))
    return computeWindowMove(inputs, series)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartRange, windowSettled, windowUpdatedKey, histSig])
  // ONE read now carries both: the cap that sets the tier and the pool depth
  // the exit facts need. Same query, same cache — depth was being discarded.
    // features 2+7: history-derived facts (hook above the early returns; empty
  // inputs while loading keep the call unconditional)
  // 16:4x feature 4 — SINCE YOU LAST LOOKED. The helper is remount-proof:
  // the intro's veil flips the page's key, and a naive read-then-stamp had
  // the veiled mount destroy the previous visit before the real page read it
  // (caught on the first live probe). Only a gap past 26h earns the line;
  // the daily today-move already covers anything closer.
  const lastSeenMs = effectiveAddress ? readLastSeen(effectiveAddress) : null
  useEffect(() => {
    if (effectiveAddress) stampLastSeen(effectiveAddress)
  }, [effectiveAddress])
  const sinceSec = lastSeenMs != null && Date.now() - lastSeenMs > 26 * 3_600_000 ? lastSeenMs / 1000 : null
  const historyFacts = useHistoryInsights(histAssets, saved, sinceSec)
  const market = useMarketData(histAssets)
  // feature 4 of the freeze amendment (desk 34): measured exit costs for the
  // held baskets — a real sell of each position's full size, simulated
  // through its own route. Hook above the early returns; empty holdings
  // while loading keep the call unconditional.
  const exitCosts = useExitCosts(p?.holdings ?? [], effectiveAddress, (p?.holdings.length ?? 0) > 0)
  // 16:4x feature 2: mark uncertainty per held basket — reads the SAME
  // basket-detail cache the page already fills; hook above the early returns.
  const navGaps = useNavGaps(p?.holdings ?? [])
  // RESUME YOUR MIX, cached (audit follow-up): the line used to re-parse the
  // stored draft on EVERY render. The memo re-reads only when a popup that
  // can write drafts closes (same-tab) or a storage event lands (cross-tab).
  // Keep-shaped drafts only — a rebalance draft's lifecycle is the popup's.
  const [draftVer, setDraftVer] = useState(0)
  // the strip shows the top four (the owner's anti-clutter law) — sixteen
  // fact kinds now compete for those slots, so the rest live behind the
  // house fold (the baskets-fold idiom): nothing acted-on hides, facts are
  // facts, and the quiet "+N more" keeps the law without burying the tail
  const [insightsOpen, setInsightsOpen] = useState(false)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return
      if (e.key.startsWith('spectrum:allocation:draft:')) setDraftVer((v) => v + 1)
      // the execlog listener retired with the hero's run markers (12:18);
      // the CSV export reads the log fresh at click time
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const resumeDraft = useMemo(() => {
    const d = loadDraft(isConnected && address ? address : GUEST_SCOPE)
    return d && d.targets.length >= 1 && !d.funding ? d : null
    // modeOpen/publishOpen: the same-tab draft writers close through these
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, modeOpen, publishOpen, draftVer])
  const mcaps = useMemo(() => {
    const m = new Map<string, number | null>()
    for (const [k, v] of market) m.set(k, v.mcapUsd)
    return m
  }, [market])

  // ── EVERY hook lives ABOVE the early returns (the house hook law) ──────────
  // The evening's sprint had grown a second hook field below the loading gate:
  // a fresh load rendered the skeleton with N hooks, then the read landed and
  // rendered N+7 — "rendered more hooks than during the previous render", the
  // whole page error-boundaried. None of tsc/vitest/build walks a component
  // THROUGH its loading gate, so the gates stayed green while every cold visit
  // crashed.
  // legend hover → class spotlight (touch round, 2026-08-05): the key asks
  // the picture questions; transient, beats the pill spotlight while held
  const [legendClass, setLegendClass] = useState<LegendClass | null>(null)
  // mover-pill hover → tile spotlight (touch round 3): the strip becomes
  // navigation; matches the unified tile by canon OR any merged part
  // GENERALIZED to a symbol SET (QOL round 6): movers pass one symbol,
  // insight cards pass the symbols their fact is about — one spotlight
  // machinery for every surface that names assets (the house one-component
  // law). The setter keeps the movers' old single-symbol call shape.
  const [hoverSpot, setHoverSpot] = useState<string[] | null>(null)
  const setMoverSym = useCallback(
    (v: string | null | ((prev: string | null) => string | null)) =>
      setHoverSpot((prev) => {
        const prevSingle = prev && prev.length === 1 ? prev[0] : null
        const next = typeof v === 'function' ? v(prevSingle) : v
        return next == null ? null : [next]
      }),
    [],
  )
  // the double-click door: bento tile id → the position key the mode scrolls to
  const [modeFocusKey, setModeFocusKey] = useState<string | null>(null)
  const tileOpenKey = useRef(new Map<string, string>())
  // movers strip: the "+N more" tail becomes a door (QOL round 5) — expanded
  // shows EVERY mover as a pill, not just the top three each way
  const [moversOpen, setMoversOpen] = useState(false)
  // the insta-claim's completion beat (QOL round 5): a successful sweep used
  // to end by the button VANISHING (the tally drops below the gate) — now a
  // quiet "✓ claimed" holds the spot for a few seconds first
  const [claimBeat, setClaimBeat] = useState(false)
  const claimBeatTimer = useRef<number | undefined>(undefined)
  const claimWasRunning = useRef(false)
  useEffect(() => {
    if (tallyClaim.running) {
      claimWasRunning.current = true
      return
    }
    // only a run that ACTUALLY finished cleanly earns the beat — a mount, a
    // refusal, or a partial failure never says "claimed"
    if (claimWasRunning.current && tallyClaim.done > 0 && tallyClaim.failed === 0) {
      claimWasRunning.current = false
      setClaimBeat(true)
      window.clearTimeout(claimBeatTimer.current)
      claimBeatTimer.current = window.setTimeout(() => setClaimBeat(false), 5000)
    } else {
      claimWasRunning.current = false
    }
  }, [tallyClaim.running, tallyClaim.done, tallyClaim.failed])
  useEffect(() => () => window.clearTimeout(claimBeatTimer.current), [])
  // newer-version lookup for the bento badge (owner 2106): key → successor
  const successorByKey = useMemo(
    () => new Map((supersededQuery.data ?? []).map((r) => [r.key.toLowerCase(), r.newSymbol])),
    [supersededQuery.data],
  )
  // THE TAB TITLE CARRIES THE TOTAL (touch round 3, 2026-08-05): glance the
  // book from another tab entirely. Only a REAL readable total writes it (a
  // zero from failed reads must never retitle the tab — the read-failed law
  // reaches the browser chrome too, and pre-gate combined is null, which is
  // the same "not a total" verdict); the brand's own title returns on leave.
  const pristineTitle = useRef<string | null>(null)
  const readableTotal = combined?.totalUsd ?? 0
  useEffect(() => {
    // PRIVACY REACHES THE TAB (QOL round 5): privacy mode masks every
    // on-screen dollar for screen shares — while the browser TAB still
    // announced the real total to the whole call. Under privacy the tab
    // wears only the brand; restoring (not masking) because "$•••• ·
    // Spectrum" would advertise that something is hidden.
    if (!(readableTotal > 0) || privacy) return
    // capture the brand's own title ONCE — re-runs must never capture an
    // already-retitled value, or unmount restores a stale total
    if (pristineTitle.current == null) pristineTitle.current = document.title
    document.title = `$${Math.round(readableTotal).toLocaleString('en-US')} · ${pristineTitle.current}`
    return () => {
      if (pristineTitle.current != null) document.title = pristineTitle.current
    }
  }, [readableTotal, privacy])

  // WHAT ARRIVED SINCE YOU LAST LOOKED (the owner 12:58: a newly detected position
  // "glows for the first time in your positions in the bento"). Committed once
  // per settled read — never while the sweep is still landing, or a chain that
  // answers late would mark its assets seen before they were ever shown, and
  // the arrival would be silently spent. Held in state because the marking
  // WRITES: recomputing it per render would clear the glow on the next paint.
  // THE ARRIVAL GREETING (the owner 14:21 via UIGuy's desk) — decided ONCE at
  // mount, so a mid-session storage write can never make it appear or vanish
  // under the reader; spent only after the book has actually landed, or a slow
  // read would burn the greeting on a page that never showed it.
  const [welcome] = useState(() => shouldWelcome())
  // THE RUN LANDING (the owner 2026-08-15): the completion plate hands over what
  // changed; those tiles glow with the bento's own arrival ring, once.
  // SAME-PAGE DELIVERY TOO (the owner live 2026-08-18: "run completing… you
  // don't see the change in the portfolio bento grid"): the manage flow runs
  // ON this page, so a mount-time read alone never heard those landings — the
  // flow now announces on its way off the screen and this listener spends the
  // handoff the moment it can actually be seen.
  const [landedKeys, setLandedKeys] = useState(() => takeRunLanded().keys)
  useEffect(() => {
    const onLanded = () => {
      const more = takeRunLanded()
      if (more.keys.size > 0) setLandedKeys((prev) => new Set([...prev, ...more.keys]))
    }
    window.addEventListener(RUN_LANDED_EVENT, onLanded)
    return () => window.removeEventListener(RUN_LANDED_EVENT, onLanded)
  }, [])
  // the run moved real money — the book must not keep quoting the old mix.
  // A SETTLE-POLL, not a fixed pair of shots (the owner live 2026-08-18:
  // "just bought lienfi and it doesn't show up in the bento immediately —
  // needs to be instant"): public-RPC balance reads lag receipts by an
  // unbounded-ish window on the young chain, so after a landing the book
  // refetches every 3s for 30s — the tile appears the first poll after the
  // node catches up, and the polling stops itself either way.
  const qcLanded = useQueryClient()
  useEffect(() => {
    if (landedKeys.size === 0) return
    void qcLanded.invalidateQueries({ queryKey: ['spectrum', 'raw-holdings'] })
    const started = Date.now()
    const id = window.setInterval(() => {
      if (Date.now() - started > 30_000) {
        window.clearInterval(id)
        return
      }
      void qcLanded.invalidateQueries({ queryKey: ['spectrum', 'raw-holdings'] })
    }, 3_000)
    return () => window.clearInterval(id)
  }, [landedKeys, qcLanded])
  // ⚠ LAND ON THE PICTURE, NOT THE TOP OF THE PAGE (the owner 2026-08-15: "View
  // your portfolio… should take you immediately back to the bento grid… and you
  // see the new assets/reweighting happen live"). `landedKeys` is already the
  // signal that we arrived from a finished run — it is consumed once at mount —
  // so it doubles as the scroll trigger and needs no new plumbing. Guarded on
  // there being keys, so an ordinary visit still opens where the user left it.
  const bentoRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (landedKeys.size === 0) return
    // one frame, so the tiles exist before we measure them
    const id = requestAnimationFrame(() => {
      bentoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(id)
  }, [landedKeys])
  // THE FULL-PAGE ONBOARDING GATE (owner 2026-08-13: "if a person like me
  // genuinely doesn't finish the signup, the portfolio page should just have a
  // pretty card that says you must complete onboarding (it takes less than 5
  // minutes)"). Supersedes the 2026-08-12 top-of-page invite plate — right
  // idea, too subtle: a connected wallet that never had its arrival played
  // saw the whole empty chrome with the plate lost above it. Now that wallet
  // sees ONE card (OnboardingGateCard below) and nothing else; the render
  // matrix is shouldGatePortfolio (unit-pinned), the escape hatch is the same
  // per-wallet dismissal, and once revealed or dismissed the full page returns
  // forever. A render swap, never a redirect (anti-loop laws). Memoized off a
  // dismissal tick: this page re-renders per animation frame during the
  // count-up, and the decision reads localStorage.
  const gateOwner = address ?? null
  const [gateSpent, setGateSpent] = useState<string | null>(null)
  // THE OUTCOME KEY (owner 2026-08-13, second report: his wallet was marked
  // revealed without the add ever completing — ceremony done, book empty,
  // full empty chrome. "we cannot have this limbo state be possible"). The
  // book is empty when BOTH device-local stores say so: no saved allocation
  // (the add step writes it) and no hand-added assets. Sync reads, so the
  // gate can outrank the loading skeleton without waiting on a chain.
  const gateBookEmpty = useMemo(
    () =>
      gateOwner != null && loadPortfolio(gateOwner) == null && loadManualAssets(gateOwner).length === 0,
    // gateSpent re-runs this after the browse/sign-in click; savedTick after
    // the in-place sign-in add. The flow's own add still remounts the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateOwner, gateSpent, savedTick],
  )
  // THE GROUP LOGIN LATCH (the owner 2026-08-13: "can you sign with any of the
  // linked wallets to login?" — yes): any VERIFIED member's sign-in vouches
  // for the set, because membership itself is signature-verified. The
  // connected wallet is simply the one asked to sign when none has yet.
  const gateSignedIn = useMemo(
    () =>
      gateOwner != null &&
      anySignedIn(walletGroup.isGroup ? walletGroup.addresses : [gateOwner]),
    // gateSpent ticks after the card's sign-in latches; the latch is a sync
    // localStorage read, same shape as gateBookEmpty above
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateOwner, gateSpent, walletGroup],
  )
  const showOnboardingGate = useMemo(
    () =>
      gateOwner != null &&
      gateSpent !== gateOwner.toLowerCase() &&
      shouldGatePortfolio({
        connected: isConnected,
        owner: gateOwner,
        demo: demoRequested,
        bookEmpty: gateBookEmpty,
        signedIn: gateSignedIn,
      }),
    [gateOwner, gateSpent, isConnected, demoRequested, gateBookEmpty, gateSignedIn],
  )
  // SIGNED-IN ⇒ ADD ATTEMPTED (the group-login seam): a wallet that rides a
  // linked member's login — or whose own sign-in outran a failed read — must
  // not land on empty chrome. The moment the raw read settles while the book
  // is empty and the wallet is signed in, the holdings become its saved
  // allocation. Never clobbers (savePortfolioFromHoldings refuses over an
  // existing book); a genuinely empty wallet writes nothing and the page's
  // own empty states stand.
  useEffect(() => {
    if (!gateOwner || !gateSignedIn) return
    if (raw.isLoading) return
    // empty book: the first add. Seeded book: the top-up — a partial read at
    // add time must not freeze a partial book forever (the owner, live: the page
    // showed less than the reveal detected). Both are no-ops when there is
    // nothing true to write, and a user-composed book is never touched.
    const res = gateBookEmpty
      ? savePortfolioFromHoldings(gateOwner, raw.data?.holdings ?? [])
      : topUpSeededPortfolio(gateOwner, raw.data?.holdings ?? [])
    if (res.added) setSavedTick((t) => t + 1)
  }, [gateOwner, gateSignedIn, gateBookEmpty, raw.isLoading, raw.data])
  // the failure state's own pending flag — the portfolio queries stay in `error`
  // while a retry is in flight (isLoading only covers a first read), so nothing
  // else on that screen can say "working on it"
  const [retrying, setRetrying] = useState(false)
  const [freshKeys, setFreshKeys] = useState<Set<string>>(new Set())
  const settledBook = !raw.isFetching && !raw.isLoading && (combined?.assets.length ?? 0) > 0
  // an EMPTY read that settled also spends the greeting (audit 2026-08-12:
  // it repeated forever for empty wallets — "once" must mean once)
  const settledEmpty = !raw.isFetching && !raw.isLoading && combined != null && combined.assets.length === 0
  const bookSig = (combined?.assets ?? []).map((a) => a.key).sort().join('|')
  const seenAnchor = walletGroup.isGroup ? walletGroup.group.anchor : effectiveAddress
  // THE DUST FOLD's expander state (owner 2026-08-12: "hide dust") — persisted
  // per anchor, so each book reopens the way its owner left it. Collapsed by
  // default: the fold row itself carries the count + total, nothing hides.
  const [dustOpen, setDustOpen] = useState(false)
  useEffect(() => {
    if (!seenAnchor) return
    try {
      setDustOpen(window.localStorage.getItem(`spectrum:dust-open:${seenAnchor.toLowerCase()}`) === '1')
    } catch {
      /* private mode — session default (closed) stands */
    }
  }, [seenAnchor])
  const toggleDust = useCallback(() => {
    setDustOpen((v) => {
      const next = !v
      try {
        if (seenAnchor) window.localStorage.setItem(`spectrum:dust-open:${seenAnchor.toLowerCase()}`, next ? '1' : '0')
      } catch {
        /* private mode — the toggle still works this session */
      }
      return next
    })
  }, [seenAnchor])
  useEffect(() => {
    if (!settledBook || !seenAnchor) return
    const { fresh } = markSeenAndCollectNew(seenAnchor, bookSig ? bookSig.split('|') : [])
    if (fresh.size > 0) setFreshKeys((cur) => new Set([...cur, ...fresh]))
  }, [settledBook, bookSig, seenAnchor])
  useEffect(() => {
    // spend the greeting once the book is really on screen; `welcome` itself
    // stays true for this visit so the line does not vanish mid-read
    if (welcome && (settledBook || settledEmpty)) markWelcomed()
  }, [welcome, settledBook, settledEmpty])
  // THE GUIDED FIRST VISIT (owner 2026-08-16: the first open should "genuinely
  // guide the user's hand properly in a beautiful way") — the welcome line's
  // active half: three spotlit beats over the real page (FirstVisitTour).
  // Armed once, only when there is a real BOOK to point at (an empty book's
  // first visit is the empty state's job) and only after the read settles so
  // every anchor exists. Any exit spends it, same one-shot as the greeting.
  // ?tour=1 is the REPLAY door (owner 2026-08-16: "load local host with a demo
  // of this") — it forces the tour regardless of the latch and never spends
  // it, so a demo/replay can run forever while a real first visit stays
  // once-only. Works with ?demo=1, so the whole show runs wallet-free in dev.
  const tourRequested = searchParams.get('tour') === '1'
  const [tourOpen, setTourOpen] = useState(false)
  const tourArmed = useRef(false)
  useEffect(() => {
    if ((!welcome && !tourRequested) || tourArmed.current || !settledBook) return
    tourArmed.current = true
    setTourOpen(true)
  }, [welcome, tourRequested, settledBook])

  if (!WALLET_ENABLED) return <Navigate to="/" replace />
  if (!effectiveAddress) return <ConnectGate />
  // The gate outranks even the read states: a never-onboarded wallet's truth
  // is "unfinished", not "empty" or "unreadable" — no read error or staleness
  // note belongs on this card (they describe a book that isn't set up yet).
  if (showOnboardingGate && gateOwner)
    return (
      <OnboardingGateCard
        owner={gateOwner}
        onBrowse={() => {
          browseWithoutOnboarding(gateOwner)
          setGateSpent(gateOwner.toLowerCase())
        }}
        onSignedIn={() => {
          // the latch is set (the card verified before firing); spending the
          // gate re-renders, gateSignedIn re-reads, and the add-attempted
          // effect above completes the book the moment the read allows
          setGateSpent(gateOwner.toLowerCase())
        }}
      />
    )
  if (isError)
    return (
      <div className="flex flex-col items-center gap-5 py-10 text-center font-mono text-[12px] text-ink-dim">
        <p className="max-w-md leading-relaxed">
          Couldn’t load your portfolio; the public RPC may be rate-limiting. It reads reliably
          with your own RPC key.
        </p>
        {/* the apology used to BE the page (audit 2026-08-07) — an RPC blip
            replaced the whole portfolio with one paragraph and no way out but a
            browser reload. Same try-again idiom the raw-holdings failure got on
            Onboarding, and the button carries its own in-flight label: a retry
            that looks dead is the fault we are here to fix, not repeat. */}
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true)
            void refetchPortfolio().finally(() => setRetrying(false))
          }}
          className="press rounded-lg border border-cyan/50 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-cyan hover:enabled:bg-cyan/10 disabled:opacity-60"
        >
          {retrying ? 'Trying…' : 'Try again'}
        </button>
      </div>
    )
  if (isLoading || !p || !combined)
    return (
      <div className="space-y-6 py-10" role="status" aria-label="Loading">
        <div className="h-40 animate-pulse rounded-[2rem] bg-white/[0.04]" />
        <div className="h-72 animate-pulse rounded-[2rem] bg-white/[0.04]" />
      </div>
    )

  const assets: AssetExposure[] = combined.assets
  // EVERY asset shows (owner ~19:0x: "all assets on your positions should show
  // without needing to scroll") — AMENDED by his 2026-08-12 ruling ("the
  // portfolio shouldn't show dust/spam like it does atm with this unity
  // token"): positions under the house dust floor ($10, the same
  // DUST_CEILING_USD the dust-sweep insight uses) leave the main views and
  // fold into one expandable row at the card's foot — folded, never deleted;
  // the row states the count and total so the headline math still reconciles.
  // Unpriced rows never fold (could-not-price is not dust) and hand-added
  // assets never fold (the user explicitly asked for them). The tier bar,
  // facts, insights, exports and the hero keep counting the WHOLE book.
  const manualKeys = new Set(
    (raw.data?.holdings ?? []).filter((h) => h.manual === true).map((h) => `${h.chainId}:${h.address.toLowerCase()}`),
  )
  const dustFold = foldDust(assets, { exempt: manualKeys })
  const shown = dustFold.main
  const networks = combined.chainCount
  const unpriced = addedHoldings.filter((h) => h.usd == null)
  // the BASKET half's unreadable rows count too (audit 2026-08-11): a
  // rate-limited balance read used to become a 0 and drop the position out of
  // the book silently, so this note spoke only for the raw-token sweep while
  // the basket sweep lied by omission.
  const unreadableBaskets = p?.unreadableCount ?? 0
  const anyUnreadable =
    (raw.data?.chainsFailed ?? 0) > 0 || (raw.data?.unreadable ?? 0) > 0 || basketChainsFailed > 0 || unreadableBaskets > 0
  // THE CAVEAT BELONGS ON THE PAGE, not folded into the ⓘ (audit 2026-08-07):
  // the hero total was printing at full confidence while `anyUnreadable` said
  // money was missing from it, and the only disclosure sat inside a tooltip
  // nobody opens. The classic Portfolio has printed this under its own number
  // since audit R7. No chain COUNT here on purpose: one dark network can fail
  // both the basket-list read and the raw sweep, so adding the two counts would
  // report two outages where there is one — the row count is exact, so it stays.
  const darkChains = (raw.data?.chainsFailed ?? 0) > 0 || basketChainsFailed > 0
  // THE STANDING BANNER IS GONE (the owner live 2026-08-13: "remove this text" —
  // supersedes his 2026-08-11 both-pages ruling; a wallet with a few dead
  // spam rows wore the caveat FOREVER, a nag not a disclosure). The DARK
  // NETWORK case keeps a line — a whole chain missing is money-shaped news —
  // but per-row read misses now disclose only where the rows themselves show
  // (unpriced/unreadable rows still render in the book; MoneyFacets marks the
  // failed chain).
  const unreadableNote = !anyUnreadable
    ? null
    : darkChains
      ? 'A network isn’t answering right now — this total leaves out anything held there.'
      : null
  // WHERE THE MONEY LIVES (the owner 12:53). Built off `assets` — the same combined
  // exposure rows the hero total counts — so the parts sum to the whole instead
  // of quietly disagreeing with the number above them.
  const chainRows: MoneyFacet[] = chainTotals(assets, {
    failedChainIds: raw.data?.failedChainIds,
    unpricedChainIds: unpricedChainIds(addedHoldings),
  }).map((r) => ({ key: `c${r.chainId}`, chainId: r.chainId, usd: r.usd, state: r.state }))

  // Composition by FACTUAL category (stablecoins detected by registry; "safe"
  // is advice language and deliberately not used).
  const catPct: Record<string, number> = { Stablecoins: 0, 'ETH & BTC': 0, Stocks: 0, Other: 0 }
  for (const a of assets) {
    const sym = a.symbol.toUpperCase()
    if (STABLES.has(sym)) catPct.Stablecoins += a.pct
    else if (MAJORS.has(sym)) catPct['ETH & BTC'] += a.pct
    else if (stockSyms.has(a.symbol)) catPct.Stocks += a.pct
    else catPct.Other += a.pct
  }
  const cats: Cat[] = Object.entries(catPct).filter(([, pct]) => pct > 0.5)
  const top1 = assets[0] ?? null
  // MARKET TIERS (13:57): group by market value, safer-reading tiers first —
  // labels are FACTS (large caps), never advice; unreadable caps = unranked
  // ULTRA SMALL CAPS ride the same read (the owner 12:58) — the launch date comes
  // back in the DexScreener response the tier already asks for, so the extra
  // band costs no extra call.
  const tierOf = (a: AssetExposure): MarketTier =>
    classifyTier(a.symbol, mcaps.get(a.key) ?? null, {
      isStock: stockSyms.has(a.symbol),
      firstSeenMs: market.get(a.key)?.firstSeenMs ?? null,
    })
  const tierRows = assets.map((a) => ({ tier: tierOf(a), pct: a.pct }))
  const tierGroups = TIER_ORDER.map((tier) => ({
    tier,
    assets: shown.filter((a) => tierOf(a) === tier),
    pct: tierRows.filter((r) => r.tier === tier).reduce((s, r) => s + r.pct, 0),
  })).filter((g) => g.assets.length > 0)
  const tierBar = TIER_ORDER.map((tier) => {
    const rows = assets.filter((a) => tierOf(a) === tier)
    return {
      tier,
      pct: rows.reduce((s, a) => s + a.pct, 0),
      usd: rows.reduce((s, a) => s + a.valueUsd, 0),
    }
  }).filter((g) => g.usd > 0.005)
  // The assets as they stand on the market-cap axis (owner 18:51). A HELD
  // BASKET is one mark wearing its own avatar — it is a position you hold, and
  // its legs are exposure, which is the model his own ruling set; the exposure
  // rows the page looks through are what the tier bar beneath already counts.
  const heldBasketKeys = new Set(p.holdings.map((h) => `${h.basket.chainId}:${h.basket.address.toLowerCase()}`))
  // the basket tiles' nested legs (owner 2026-08-05): keyed the same way as
  // heldBasketKeys so a bento tile can look its contents up by its own key
  const basketLegsByKey = new Map(
    p.holdings.map((h) => [
      `${h.basket.chainId}:${h.basket.address.toLowerCase()}`,
      (h.basket.top ?? []).map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct })),
    ]),
  )
  // WHO HOLDS EACH TILE (sort-by-wallet): key → the biggest contributor's
  // label. Basket rows carry contributors from the fold; raw token rows from
  // the sweep. Names come from the local wallet-names store; unnamed wallets
  // wear their short address. Derived from reads already on the page.
  const walletLabelOf = (owner: string) => walletName(owner) ?? shortAddr(owner)
  const walletOfKey = new Map<string, string>()
  for (const h of p.holdings) {
    const top = h.contributors?.[0]
    if (top) walletOfKey.set(`${h.basket.chainId}:${h.basket.address.toLowerCase()}`, walletLabelOf(top.owner))
  }
  for (const h of addedHoldings) {
    const cs = (h as { contributors?: { owner: string; usd: number | null }[] }).contributors
    if (!cs?.length) continue
    const top = [...cs].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0]
    if (top) walletOfKey.set(`${h.chainId}:${h.address.toLowerCase()}`, walletLabelOf(top.owner))
  }
  const walletGroupOfTile = (keys: string[]): string | null => {
    for (const k of keys) {
      const hit = walletOfKey.get(k.toLowerCase())
      if (hit) return hit
    }
    return null
  }
  const walletGroupOrder = [...new Set([...walletOfKey.values()])].sort()

  // UNIT PRICES for the bento footer stack (the owner 2026-08-06: "the price of
  // the asset and 24hr performance" under the amount): the holding's own
  // implied price — usd/amount for tokens, navPerToken for baskets. Derived
  // from reads already on the page, never a second fetch; no readable price
  // = no line, never a guess.
  const priceByKey = new Map<string, number>()
  for (const h of addedHoldings) {
    if (h.usd != null && h.usd > 0 && h.amount > 0) priceByKey.set(`${h.chainId}:${h.address.toLowerCase()}`, h.usd / h.amount)
  }
  for (const h of p.holdings) {
    if (h.basket.navPerToken > 0) priceByKey.set(`${h.basket.chainId}:${h.basket.address.toLowerCase()}`, h.basket.navPerToken)
  }
  // the dust-FOLDED set (the owner live 2026-08-13: "ultra small caps still shows
  // dust on the risk curve remove") — the curve's chips follow the fold like
  // the main views; the tierBar beside it still counts the WHOLE book, the
  // fold row still discloses what folded, so no money goes unaccounted.
  const spectrumAssets: SpectrumAsset[] = shown.map((a) => ({
    key: a.key,
    symbol: a.symbol,
    address: a.address,
    chainId: a.chainId,
    valueUsd: a.valueUsd,
    pct: a.pct,
    tier: tierOf(a),
    isBasket: heldBasketKeys.has(a.key),
  }))

  // ── TODAY'S MOVE, EXPLAINED (feature 1, greenlit ~11:2x): the hero says
  //    +$412; this names WHY. Pure arithmetic on data already fetched — each
  //    position's dollar move over 24h from its current value and 24h change
  //    (past = value / (1 + chg/100); move = value − past). Facts, signed,
  //    biggest movers first; positions whose change is unreadable are counted
  //    and said, never guessed.
  const dayMove = (() => {
    const rows: { symbol: string; usd: number }[] = []
    let unreadable = 0
    const unreadableSyms: string[] = []
    for (const a of assets) {
      const chg = market.get(a.key)?.change24hPct
      if (typeof chg !== 'number' || !Number.isFinite(chg)) {
        if (a.valueUsd > 0.005) {
          unreadable++
          unreadableSyms.push(a.symbol)
        }
        continue
      }
      const past = a.valueUsd / (1 + chg / 100)
      const usd = a.valueUsd - past
      if (Math.abs(usd) > 0.005) rows.push({ symbol: a.symbol, usd })
    }
    rows.sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd))
    return { rows, totalUsd: rows.reduce((t, r) => t + r.usd, 0), unreadable, unreadableSyms }
  })()
  // THE STRIP FOLLOWS THE WINDOW (the board's last named item): 24H keeps the
  // live market source (fresher than history for a day); 7D/30D read the
  // window math off the chart's own cached series. While a fresh window's
  // histories land, the strip says so instead of showing the WRONG window.
  const stripMove = chartRange === '24H' ? dayMove : windowMove
  const stripWindowWord = chartRange === '24H' ? 'Today' : chartRange === '7D' ? 'Past 7d' : 'Past 30d'
  const stripQuietWord = chartRange === '24H' ? 'day' : chartRange === '7D' ? 'week' : 'month'

  // ── CATEGORY SPOTLIGHT + RISK READOUT (owner 23:09). Pills exist only for
  //    categories at least one shown asset matches; the readout is his three
  //    ("mid caps, low caps, stocks"), dollars off the SAME tier reads the
  //    spectrum above stands on — one classification, two renderings.
  const catPills = categoryPills(assets)
  const activePill = catFilter ? catPills.find((p) => p.id === catFilter) ?? null : null
  const litKeys: Set<string> | null = activePill ? new Set(assets.filter((a) => activePill.matches(a)).map((a) => a.key)) : null
  const riskReadout = tierBar.filter((g) => g.tier === 'mid' || g.tier === 'small' || g.tier === 'micro' || g.tier === 'stocks')

  // ── THE INSIGHTS STRIP (owner 17:53: "below positions we should have an
  //    individual little area above public baskets, which is insights… little
  //    cards that pop up with unique information"). Facts only, ranked by
  //    magnitude, and the band does not render at all when there is nothing
  //    true to say. NOT memoised deliberately: this sits below the early
  //    returns, so a hook here would be a hooks-order crash (it cost me the
  //    whole page once). buildInsights is pure and cheap over ≤12 rows.
  //
  //    Drift is measured ONLY on assets held purely directly (basketCount 0):
  //    the baseline is the target weight you SET, so an asset whose share also
  //    comes through a basket is not a like-for-like comparison, and a wrong
  //    number here would be worse than no card.
  const directKeys = new Set(assets.filter((a) => a.basketCount === 0).map((a) => a.key))
  const savedWeight = (saved?.targets ?? []).reduce((s, t) => s + t.weight, 0)
  // A SEEDED book has no baseline (the owner 2026-08-13, day-one drift cards on
  // his own sign-in-seeded wallet: "you didn't 'set' it to a fixed number").
  // The machine recorded what the wallet HELD; "you set it at 9%" was a lie,
  // and every partial read then screamed drift against a denominator the
  // user never chose. Drift arms the moment the USER sets weights — a flow
  // save replaces the record and drops the seeded flag.
  const insightBaseline =
    saved && !saved.seededFromHoldings && Number.isFinite(saved.executedAt) && savedWeight > 0
      ? {
          at: saved.executedAt,
          shares: Object.fromEntries(
            (saved.targets ?? [])
              .map((t) => [assetKey(t.asset), (t.weight / savedWeight) * 100] as const)
              .filter(([k]) => directKeys.has(k)),
          ),
          bandPp: bandState ?? saved.bandPp,
        }
      : null
  const band = bandState ?? saved?.bandPp ?? DRIFT_THRESHOLD_PP
  const setBand = (pp: number) => {
    setBandState(pp)
    if (effectiveAddress) savePortfolioBand(effectiveAddress, pp)
  }
  const insightCards = buildInsights({
    positions: assets.map((a) => ({
      key: a.key,
      symbol: a.symbol,
      valueUsd: a.valueUsd,
      pct: a.pct,
      tier: tierOf(a),
      // how many DISTINCT holdings reach you to this asset (direct + each
      // basket carrying it) — the look-through fact behind the overlap card
      sourceCount: a.contributions.length,
      liquidityUsd: market.get(a.key)?.liquidityUsd ?? null,
    })),
    totalUsd: combined.totalUsd,
    networks,
    unpricedCount: unpriced.length,
    baseline: insightBaseline,
    planVs: historyFacts.planVs,
    together: historyFacts.together,
    exitCosts,
    navGaps,
    bets: historyFacts.bets,
    swing: historyFacts.swing,
    // 16:4x feature 3: the depeg watch — unit prices measured from the same
    // raw-holdings read that values the page (pure, floors inside)
    depegs: findDepegs(addedHoldings.map((h) => ({ symbol: h.symbol, amount: h.amount, usd: h.usd }))),
    // Ⓡ ruled 2026-08-04: held baskets with a verified successor — the fact
    // reaches the book instead of living only on a page nobody revisits
    superseded: supersededQuery.data ?? null,
    // owner 2026-08-16 (after a refused conversion leg stranded a 2-of-3
    // buy): bundles this wallet holds PART of — some legs, not all. Derived
    // from the catalog's own grouping vs the held set, so it catches
    // partials however they happened, not just refused runs.
    partialBundles: (() => {
      const all = allBaskets.data ?? []
      if (all.length === 0) return null
      const rows: NonNullable<Parameters<typeof buildInsights>[0]['partialBundles']> = []
      const heldUsdByKey = new Map((p?.holdings ?? []).map((h) => [`${h.basket.chainId}:${h.basket.address.toLowerCase()}`, h.valueUsd]))
      for (const t of groupIntoTheses(all)) {
        const held = t.legs.filter((l) => heldBasketKeys.has(`${l.chainId}:${l.address.toLowerCase()}`))
        if (held.length === 0 || held.length === t.legs.length) continue
        const missing = t.legs.filter((l) => !heldBasketKeys.has(`${l.chainId}:${l.address.toLowerCase()}`))
        rows.push({
          name: t.name,
          heldCount: held.length,
          totalCount: t.legs.length,
          missingWords: missing.map((l) => chainMeta(l.chainId).short).join(' · '),
          href: thesisHref(t.deployer, t.name),
          heldUsd: held.reduce((s2, l) => s2 + (heldUsdByKey.get(`${l.chainId}:${l.address.toLowerCase()}`) ?? 0), 0),
        })
      }
      return rows.length > 0 ? rows : null
    })(),
    // 16:4x feature 6: direct token scraps under the ceiling — the sweep
    // stages their trims through the same rail as the drift card's restore
    dust: (() => {
      const rows = addedHoldings.filter((h) => h.usd != null && h.usd > 0 && (h.usd as number) < DUST_CEILING_USD)
      return rows.length > 0
        ? {
            count: rows.length,
            totalUsd: rows.reduce((s2, h) => s2 + (h.usd as number), 0),
            keys: rows.map((h) => `${h.chainId}:${h.address.toLowerCase()}`),
          }
        : null
    })(),
  })

  // The old in-card insights list is RETIRED (owner 17:5x/18:5x: "we have the
  // same content in so many places, it should be moved to one — the insights
  // card"). Its facts now live once, in the insights strip below positions.

  // ── SINCE YOU WERE AWAY (desk 46, the owner's greenlit mount): capture the same
  //    inputs the insights read, diff against the last visit, LEAD the strip
  //    with the deltas. Hook-free here on purpose (below the early returns);
  //    the save rides the AwaySnapSaver child after paint. THE READ-FAILED
  //    LAW, applied per lie it could tell: a FAILED CHAIN vanishes positions
  //    wholesale, so it gates everything (no capture, no diff, no save — a
  //    poisoned snapshot lies tomorrow). An UNPRICED ROW is narrower — some
  //    books carry permanently-unpriceable dust, and gating on it would
  //    disable the briefing forever — so it degrades only the stories it
  //    poisons: the total is handed over as null (an incomplete total is not
  //    a total; the module's both-sides law silences total stories), and a
  //    position that merely STOPPED PRICING is dropped from yesterday before
  //    the diff, so "left the book" is never said about a price-feed hiccup.
  const awayHealthy = (raw.data?.chainsFailed ?? 1) === 0 && basketChainsFailed === 0 && combined.totalUsd > 0

  const exitCostByKey = new Map((exitCosts ?? []).map((e) => [e.key, e.costPct]))
  const awayNext =
    awayAnchor && awayHealthy
      ? captureAwaySnapshot(
          assets.map((a) => ({
            key: a.key,
            symbol: a.symbol,
            pct: a.pct,
            valueUsd: a.valueUsd,
            exitCostPct: exitCostByKey.get(a.key) ?? null,
          })),
          unpriced.length === 0 ? combined.totalUsd : null,
        )
      : null
  const awayPrevUsable = (() => {
    if (!awayPrev || !awayNext) return null
    const unpricedNow = new Set(unpriced.map((h) => `${h.chainId}:${h.address.toLowerCase()}`))
    if (unpricedNow.size === 0) return awayPrev
    const positions = Object.fromEntries(Object.entries(awayPrev.positions).filter(([k]) => !unpricedNow.has(k)))
    return { ...awayPrev, positions }
  })()
  const awayDeltas = awayPrevUsable && awayNext ? diffAwaySnapshots(awayPrevUsable, awayNext) : []
  // the strip's list: the briefing first (his mount instruction), the standing
  // facts after; the fold and the band-absent rule read the combined length
  const stripAll = [...awayInsights(awayDeltas), ...insightCards]
  // THE STRIP'S HEAD ORDER (owner 2026-08-16: "the top priority insight
  // should be when a creator has updated a new version of a basket/bundle the
  // person holds" — this supersedes the 2026-08-05 dust-always-leads rule):
  // superseded first, the incomplete-bundle prompt second, dust third, the
  // measured facts after.
  const headKinds = ['superseded', 'partial-bundle', 'dust'] as const
  const stripCards = [
    ...headKinds.flatMap((k) => stripAll.filter((c) => c.kind === k)),
    ...stripAll.filter((c) => !(headKinds as readonly string[]).includes(c.kind)),
  ]

  // ── POSITIONS MODE (recording 13:00): the takeover replaces the inline
  // editor — per-position actions, one queue, executed through the flow. ──
  // ── POSITIONS vs EXPOSURE (the owner's ruling, 2026-08-02: "a basket is a
  //    position you hold; its contents are exposure you carry"). The mode may
  //    only offer what the chain lets you trade: DIRECTLY-HELD tokens as rows,
  //    plus each held BASKET as ONE row (trimming it sells shares through the
  //    redeem path, never its legs). The looked-through exposure stays exactly
  //    where it is — the tier bar, the facts, the insights — because that is
  //    understanding, not trading. Building these from `assets` (the exposure
  //    output) let the mode draw a bar on WETH the user does not own; that
  //    plan could never execute, and baskets could not be trimmed at all.
  const positionRows: PositionRow[] = [
    // DUST STAYS OUT OF THE RESHAPE (the owner 2026-08-13, on his seeded book's
    // tile grid full of $0.01 rows: "shouldnt show the dust assets") — the
    // house floor, the same DUST_CEILING_USD the page's fold and the seeded
    // add use. Hand-added rows are exempt (the page's own fold law: an
    // explicit ask is never dust); the book itself still shows everything,
    // folded.
    ...addedHoldings
      .filter((h) => h.usd != null && h.usd > 0 && (h.usd >= DUST_CEILING_USD || h.manual === true))
      .map((h) => ({
        asset: { chainId: h.chainId, address: h.address, symbol: h.symbol },
        valueUsd: h.usd as number,
        pct: combined.totalUsd > 0 ? ((h.usd as number) / combined.totalUsd) * 100 : 0,
        kind: 'token' as const,
        decimals: h.decimals,
        amount: h.amount,
        heldBy: ((h as { contributors?: { owner: string; usd: number | null }[] }).contributors ?? [])
          .filter((c) => c.usd != null && c.usd > 0)
          .map((c) => ({ owner: c.owner, usd: c.usd as number })),
      })),
    ...p.holdings
      .filter((h) => h.valueUsd >= DUST_CEILING_USD)
      .map((h) => ({
        asset: { chainId: h.basket.chainId, address: h.basket.address, symbol: h.basket.symbol },
        valueUsd: h.valueUsd,
        pct: combined.totalUsd > 0 ? (h.valueUsd / combined.totalUsd) * 100 : 0,
        // cost basis where the pnl index KNOWS it — feeds the trim receipt
        investedUsd:
          basketPnl(pnlIdx[h.basket.chainId], h.basket.address, h.basket.navPerToken, h.balance)?.investedUsd ||
          undefined,
        kind: 'basket' as const,
        heldBy: h.contributors ?? [],
        contents: (h.basket.top ?? []).map((t) => ({
          symbol: t.symbol,
          address: t.address,
          chainId: h.basket.chainId,
          weightPct: t.weightPct,
        })),
      })),
  ]
  // LP rows for the reshape flow — VIEW-ONLY cards (owner 2026-08-15): one per
  // pair, same grouping as the bento fold; passed on a separate prop so the
  // mode's math can never see them.
  // NOT a hook — this sits below the page's early returns, where a hook is a
  // hooks-order crash (this file's own documented trap); a plain loop over a
  // handful of positions costs nothing.
  const lpModeRows = (() => {
    const byPair = new Map<string, { symbol: string; chainId: number; valueUsd: number; count: number }>()
    for (const lpP of lpRead.data?.positions ?? []) {
      if (lpP.valueUsd == null || lpP.valueUsd <= 0) continue
      const k = `${lpP.chainId}:${lpP.token0.symbol}/${lpP.token1.symbol}`
      const row = byPair.get(k) ?? { symbol: `${lpP.token0.symbol}/${lpP.token1.symbol} LP`, chainId: lpP.chainId, valueUsd: 0, count: 0 }
      row.valueUsd += lpP.valueUsd
      row.count += 1
      byPair.set(k, row)
    }
    return [...byPair.values()].sort((a, b) => b.valueUsd - a.valueUsd)
  })()
  const hasPositions = positionRows.length > 0

  const keepHref = flowHref('keep')
  const publishHref = flowHref('publish')

  const railAddCore = (
    <>
      {/* crossfading labels — one phrase when open, no orphaned gap (11:26) */}
      <span className="grid w-14 shrink-0 place-items-center text-[11px] tracking-[0.08em] opacity-100 transition-opacity duration-300 group-focus-within/rail:opacity-0 group-hover/rail:opacity-0">
        Add
      </span>
      <span className="pointer-events-none absolute left-4 whitespace-nowrap text-[12px] tracking-[0.1em] opacity-0 transition-opacity duration-300 group-focus-within/rail:opacity-100 group-hover/rail:opacity-100">
        Add or rebalance →
      </span>
    </>
  )
  const railAddClass =
    'press relative flex h-12 w-full items-center rounded-2xl font-display font-bold uppercase transition-all duration-500'
  const railAddStyle: CSSProperties = railFocus
    ? { background: 'rgba(255,255,255,0.06)', color: 'var(--color-ink)' }
    : { color: 'var(--color-void)' }
  const railAddClassFull = railFocus ? railAddClass : `spectral-btn ${railAddClass}`
  // ── PHONE LAYOUTS (the owner's mobile sweep, 2026-08-05 22:38 via R): the bento
  //    goes VERTICAL, wide rows become CAROUSELS not stacks, rhythm tightens.
  //    Read-once like the chart's compact flag — a rotation reloads. ──────────
  const isPhone = typeof window !== 'undefined' && window.innerWidth < 640
  // ── THE BENTO ITEMS, hoisted from the JSX (touch round 2: the legend census
  //    derives from the same list the picture draws — one universe, counted
  //    where it is built, never a second classification that could drift) ──
  // BOTH VIEWS FOLD (his ruling is about the book, not one layout): the
  // picture draws the same `shown` set the list does, so switching List↔Picture
  // can never resurrect the dust he asked to hide.
  const bentoItems = foldCashPile(
    unifyAssets(
      shown.map((a) => ({
        key: a.key,
        chainId: a.chainId,
        address: a.address,
        symbol: a.symbol,
        valueUsd: a.valueUsd,
        pct: a.pct,
        change24hPct: market.get(a.key)?.change24hPct ?? null,
        // a held basket wearing a token's ticker never folds
        basket: heldBasketKeys.has(a.key),
      })),
    ),
    // ONE GREEN CASH TILE (the owner 2026-08-06 12:49 #7) — the stables stop being
    // five separate small tiles and become the pile, the same object the
    // reshape popup has always drawn.
    (sym) => CASH_SYMBOLS.has(sym.toUpperCase()),
  )
    // 50, was 12 (the owner 2026-08-06: "there are three you literally cannot
    // see… support up to like 25 to 50 assets") — the same ruling that moved
    // MAX_ALLOCATION_ASSETS. The readability floor below is what makes the
    // widened cap honest: without it, +N tiles are +N invisible slivers.
    .slice(0, 50)
    .map((u) => {
      // an LP tile is an exposure, not a token — no chart door exists for it
      const link = u.parts.some((pt) => pt.key.includes(':lp:')) ? undefined : chartLinksFor(u.dominant.chainId, u.dominant.address)[0]
      // ── the class signal (owner 2026-08-05): the tier of
      //    the DOMINANT part speaks for a merged tile (its
      //    parts are one asset in different homes, so the
      //    tier is the same fact); the basket KIND beats
      //    any tier. A basket tile also carries its legs
      //    for the nested mini-map — drawn only when the
      //    tile's measured box earns it.
      const uKeys = u.parts.map((pt) => pt.key)
      const uIsBasket = uKeys.some((k) => heldBasketKeys.has(k))
      // THE PILE (his #7): one tile standing for every stable, so its identity
      // comes from the KIND rather than from whichever stable happens to be
      // biggest — a green CASH tile, not a USDC tile wearing extra rows.
      const isCashPile = u.id === 'canon:cash-pile'
      const cashSplit = isCashPile ? cashPileSplit(u) : []
      const dominantAsset = assets.find((x) => x.key === uKeys[0]) ?? null
      const legs = uIsBasket
        ? (basketLegsByKey.get(uKeys.find((k) => heldBasketKeys.has(k)) ?? '') ?? undefined)
        : undefined
      const signal = isCashPile
        ? classSignalFor('cash', false)
        : classSignalFor(dominantAsset ? tierOf(dominantAsset) : null, uIsBasket)
      // does this tile answer the legend's hovered class?
      const legendMatch =
        legendClass == null
          ? null
          : legendClass === 'basket' || legendClass === 'cash' || legendClass === 'stock'
            ? signal.kind === legendClass
            : signal.kind === 'crypto' && signal.capBars === (legendClass === 'high' ? 3 : legendClass === 'mid' ? 2 : 1)
      tileOpenKey.current.set(u.id.toLowerCase(), uKeys[0] ?? u.id)
      const moverMatch =
        hoverSpot == null ? null : hoverSpot.includes(u.canon) || u.parts.some((pt) => hoverSpot.includes(pt.symbol))
      const hoverMatch = moverMatch != null ? moverMatch : legendMatch
      // one asset, wherever it lives (owner ~15:0x): the
      // same asset across chains and wrap-forms (eth/weth)
      // is ONE tile; the BREAKDOWN rows carry where it's
      // held — chain and form, each with its dollars.
      // Unified ids are stable (canon:eth), so the merge
      // can never collide two chains' native sentinels —
      // the class UIGuy flagged on the unqualified keys.
      return {
        id: u.id,
        symbol: u.canon,
        address: u.dominant.address,
        chainId: u.dominant.chainId,
        // the reshape popup's own cash green, so the same object reads the
        // same on both surfaces (one grammar, mounted twice)
        color: isCashPile ? CASH_GREEN : undefined,
        // JUST ARRIVED (12:58) — a merged tile counts as new when ANY of its
        // parts is, since the tile IS that asset wherever it turned up. The
        // cash pile never glows: stables moving around is not a discovery.
        isNew: (!isCashPile && uKeys.some((k) => freshKeys.has(k))) || uKeys.some((k) => landedKeys.has(k.toLowerCase())),
        logoCluster: isCashPile
          ? cashSplit.map((c) => ({ address: c.part.address, symbol: c.part.symbol, chainId: c.part.chainId }))
          : undefined,
        // LAYOUT floor (the owner 2026-08-06: dust tiles were "tiny little dots…
        // you literally cannot see" — every tile earns at least a readable
        // sliver of the map; labelPct keeps the TRUE share on the tile, so
        // the floor bends geometry only, never a stated number)
        weightPct: Math.max(u.pct, 1.4),
        labelPct: u.pct,
        // the spotlight darkens what doesn't match (23:09)
        // AND clusters the lit ones together (~23:2x) — a
        // merged asset is lit when ANY of its parts is
        dim: hoverMatch != null ? !hoverMatch : litKeys ? !u.parts.some((p) => litKeys.has(p.key)) : false,
        group: groupByWallet
          ? (walletGroupOfTile(uKeys) ?? 'elsewhere')
          : hoverMatch != null
            ? hoverMatch
              ? 'lit'
              : 'dim'
            : litKeys
              ? u.parts.some((p) => litKeys.has(p.key))
                ? 'lit'
                : 'dim'
              : undefined,
        // the tile carries what it is WORTH, what it did,
        // and a way out to a chart — a null change is
        // omitted rather than drawn as flat; merged
        // changes are value-weighted over priced parts
        footer: {
          amount: formatUsdCompact(u.valueUsd),
          change24hPct: u.change24hPct,
          // the dominant part's unit price speaks for a merged tile — the
          // parts are one asset in different homes, same fact
          price: (() => {
            const unit = priceByKey.get(uKeys[0] ?? '')
            return unit != null ? formatPrice(unit) : undefined
          })(),
          /* NO CHART LINK ON THE PILE (the owner 14:24: "the cash shouldn't have a
             dexscreener button, by the way") — a stablecoin's price chart is a
             flat line, and the pile is several of them at once, so the link
             would open a page about whichever stable happened to be biggest. */
          href: isCashPile ? undefined : link?.href,
          hrefLabel: isCashPile || !link ? undefined : `${link.label}: $${u.canon}`,
          markSrc: isCashPile ? undefined : link?.mark,
          breakdown: isCashPile
            ? /* WHAT THE CASH IS MADE OF — by stablecoin, the pile's own
                 question (where it sits is the hero's per-chain line now).
                 One stable reads as a plain label rather than its own total
                 repeated: the popup's grammar, kept verbatim. */
              cashSplit.length === 1
              ? [{ label: `all $${showSymbol(cashSplit[0].symbol)}` }]
              : cashSplit.map((c) => ({
                  /* through safe-copy even though the curated cash registry is
                     what actually admits a symbol here — the guarantee should
                     be structural, not a property of a list someone may widen */
                  label: `$${showSymbol(c.symbol)}`,
                  /* tight money here ONLY (his "2.5k USDC, 3k USDG"): three
                     figures share one bar, and the grouped form truncated to
                     "$4,0…" — an unreadable number is worse than a rounded one */
                  amount: formatUsdTight(c.usd),
                  amountUsd: c.usd,
                  share: u.valueUsd > 0 ? c.usd / u.valueUsd : undefined,
                }))
            : u.merged
            ? (() => {
                // chain-only labels so the AMOUNTS fit on
                // the bar (owner: the numbers are the
                // point); the form symbol returns only
                // when two parts share a chain and the
                // chain alone would be ambiguous
                const chainCounts = new Map<number, number>()
                for (const part of u.parts) chainCounts.set(part.chainId, (chainCounts.get(part.chainId) ?? 0) + 1)
                return u.parts.map((p) => ({
                  label:
                    (chainCounts.get(p.chainId) ?? 1) > 1
                      ? `${chainMeta(p.chainId).short} · ${showSymbol(p.symbol)}`
                      : chainMeta(p.chainId).short,
                  amount: formatUsdCompact(p.valueUsd),
                  // raw dollars ride along so the bar can count up at
                  // entrance; the formatted string stays the landing value
                  amountUsd: p.valueUsd,
                  share: u.valueUsd > 0 ? p.valueUsd / u.valueUsd : undefined,
                }))
              })()
            : undefined,
        },
        classSignal: signal,
        innerLegs: legs,
        badge: (() => {
          if (!uIsBasket) return undefined
          const hit = uKeys.map((k) => successorByKey.get(k)).find(Boolean)
          return hit
            ? {
                label: '↑ new version',
                title: `$${hit} succeeds this basket — this one stays fully functional; migrate from its page`,
              }
            : undefined
        })(),
      }
    })
  // the census the legend wears (touch round 2) — counted with the SAME
  // matcher the spotlight uses, so the number and the hover always agree
  const legendCounts: Partial<Record<LegendClass, number>> = {}
  for (const it of bentoItems) {
    const s = it.classSignal
    const k: LegendClass | null =
      s.kind === 'basket' || s.kind === 'cash' || s.kind === 'stock'
        ? s.kind
        : s.capBars === 3
          ? 'high'
          : s.capBars === 2
            ? 'mid'
            : s.capBars === 1
              ? 'low'
              : null
    if (k) legendCounts[k] = (legendCounts[k] ?? 0) + 1
  }
  return (
    /* Breakout: the shell centres a 1000px column — this page needs the room
       (owner 10:32: "use more width"). Centered, capped, viewport-safe. */
    <div className="relative left-1/2 w-[min(1340px,calc(100vw_-_2rem))] -translate-x-1/2">
      {/* top tightened + rail higher: the shell's banner region collapsed to
          ONE rotating slot (UIGuy kit change, the owner's ask) — every page gained
          ~a strip of room, worst case constant now */}
      {/* The 2026-08-12 invite plate lived here — superseded 2026-08-13 by the
          full-page OnboardingGateCard (the early return above the read states):
          the plate was the right idea, too subtle over a page of empty chrome. */}
      {/* pb-6, not pb-32 (mobile sweep 2026-08-06): the dock clearance moved to
          the shell's root padding, where it actually clears the footer; keeping
          it here too just painted ~190px of dead black before the footer. */}
      <div className="grid items-start gap-6 pb-6 pt-2 lg:grid-cols-[72px_minmax(0,1fr)]">
        {/* ── THE RAIL, lg+: icons hard left; spectral emphasis FOLLOWS the
              hovered action; composition rides below ────────────────────── */}
        <aside className="enter relative z-30 hidden self-start lg:sticky lg:top-20 lg:block" style={{ '--enter-i': 0 } as CSSProperties}>
          <nav
            aria-label="Portfolio actions"
            onMouseLeave={() => setRailFocus(null)}
            className="group/rail w-[72px] overflow-hidden rounded-[1.75rem] border border-white/10 bg-panel/95 p-2 shadow-[0_16px_48px_-24px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-[width] duration-500 focus-within:w-[264px] hover:w-[264px] motion-reduce:transition-none"
            style={{ transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)' }}
          >
            {/* hover-return fix (12:02): re-entering Add clears the focus so
                the spectral comes back — not only on leaving the rail */}
            {hasPositions ? (
              <button type="button" onClick={() => setModeOpen(true)} onMouseEnter={() => setRailFocus(null)} className={railAddClassFull} style={railAddStyle}>
                {railAddCore}
              </button>
            ) : keepHref ? (
              <Link to={keepHref} onMouseEnter={() => setRailFocus(null)} className={railAddClassFull} style={railAddStyle}>
                {railAddCore}
              </Link>
            ) : null}
            <div className="mt-2 space-y-1">
              {publishHref &&
                (() => {
                  const inner = (
                    <>
                      <span
                        className={`grid h-9 w-9 shrink-0 translate-x-2.5 place-items-center rounded-lg transition-all duration-300 ${
                          railFocus === 'publish' ? 'text-void' : 'text-ink-faint'
                        }`}
                        style={railFocus === 'publish' ? { background: SPECTRAL } : undefined}
                      >
                        <ActionIcon kind="publish" />
                      </span>
                      <span className="ml-5 w-[176px] min-w-0 whitespace-nowrap text-left opacity-0 transition-opacity duration-300 group-focus-within/rail:opacity-100 group-hover/rail:opacity-100">
                        <span className="block font-display text-[13px] font-bold uppercase tracking-[0.1em] text-ink">Publish</span>
                        <span className="block font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">your mix as a basket</span>
                      </span>
                    </>
                  )
                  const cls = 'press group/item flex h-12 w-full items-center rounded-xl transition-colors hover:bg-white/[0.04]'
                  // With positions the button opens the PICKER POPUP (22:00);
                  // with nothing held there is no mix, so the create flow's
                  // publish door stays the entry.
                  return hasPositions ? (
                    <button type="button" onClick={() => setPublishOpen(true)} onMouseEnter={() => setRailFocus('publish')} className={cls}>
                      {inner}
                    </button>
                  ) : (
                    <Link to={publishHref} onMouseEnter={() => setRailFocus('publish')} className={cls}>
                      {inner}
                    </Link>
                  )
                })()}
              <button
                type="button"
                onClick={() => setFeesOpen(true)}
                onMouseEnter={() => setRailFocus('fees')}
                className="press group/item flex h-12 w-full items-center rounded-xl text-left transition-colors hover:bg-white/[0.04]"
              >
                <span
                  className={`grid h-9 w-9 shrink-0 translate-x-2.5 place-items-center rounded-lg transition-all duration-300 ${
                    railFocus === 'fees' ? 'text-void' : 'text-ink-faint'
                  }`}
                  style={railFocus === 'fees' ? { background: SPECTRAL } : undefined}
                >
                  <ActionIcon kind="fees" />
                </span>
                <span className="ml-5 w-[176px] min-w-0 whitespace-nowrap opacity-0 transition-opacity duration-300 group-focus-within/rail:opacity-100 group-hover/rail:opacity-100">
                  <span className="block font-display text-[13px] font-bold uppercase tracking-[0.1em] text-ink">Fees &amp; claims</span>
                  <span className="block font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">appears right here</span>
                </span>
              </button>
            </div>
            {cats.length > 0 && (
              <>
                <div aria-hidden className="mx-3 my-4 border-t border-white/8" />
                {/* roomier per 12:02: more height, sits lower, larger type.
                    THE OPEN PANEL IS THE IN-FLOW CHILD (owner ~23:5x: the
                    largest-position line "gets cut off on the bottom") — it
                    was an absolute overlay inside a fixed 240px box, and an
                    absolute child can never grow its parent, so a fourth
                    category row pushed the last line past the clip. Now its
                    own content defines the height (min 240) and the at-rest
                    bar is the overlay. */}
                <div className="relative min-h-[240px]">
                  {/* at rest: the glyph + the mix as a slim segmented bar */}
                  <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col items-center gap-3 pt-3 opacity-100 transition-opacity duration-300 group-focus-within/rail:opacity-0 group-hover/rail:opacity-0">
                    <span className="text-ink-faint">{ICONS.composition}</span>
                    <span className="flex h-48 w-1.5 flex-col gap-0.5 overflow-hidden rounded-full">
                      {cats.map(([label, pct], i) => (
                        <span key={label} style={{ height: `${pct}%`, background: CAT_COLORS[i % CAT_COLORS.length] }} />
                      ))}
                      <span className="min-h-0 flex-1 bg-white/[0.06]" />
                    </span>
                  </div>
                  {/* open: the real category rows (fixed width — the rail clips it at rest) */}
                  <div className="w-[232px] px-3 py-3 opacity-0 transition-opacity duration-300 group-focus-within/rail:opacity-100 group-hover/rail:opacity-100">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Composition · facts</p>
                    <div className="mt-2">
                      <CompRows cats={cats} top1={top1} compact />
                    </div>
                  </div>
                </div>
              </>
            )}
          </nav>
        </aside>

        <div className="min-w-0 space-y-6">
          {/* ── THE HERO — tightened upward; invested line beside the delta ── */}
          <Shell enterIndex={0} glow="var(--color-cyan)" bright>
            {/* pf-hero: the first-visit tour's opening spotlight */}
            <div id="pf-hero" className="relative p-5 sm:p-9">
              <div className="relative grid items-end gap-8 xl:grid-cols-[minmax(0,1fr)_auto]">
                <div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    {/* THE ARRIVAL (the owner 14:21, via UIGuy's desk): someone
                        landing here straight off onboarding is greeted once,
                        and the greeting sits where the page's own name is
                        rather than as a banner above it — the handoff reads as
                        "this is yours now", not as another notice to dismiss. */}
                    {welcome && (
                      <p className="mb-2 w-full font-display text-[15px] font-bold uppercase tracking-[0.12em] text-cyan">
                        Welcome to your portfolio
                      </p>
                    )}
                    {/* "Everything you hold" → "Your portfolio", a step up in
                        size (the owner 12:49 #11) — the shorter phrase is his
                        standing "way less text" rule applied to the one line
                        that names the whole page. */}
                    {/* a div, not a p: the cog's popover root is a div, and a
                        div inside p auto-closes the p (browser reparenting) */}
                    <div className="flex items-center gap-2 font-mono text-[13px] uppercase tracking-[0.2em] text-ink-dim">
                      <span>
                        Your portfolio ·{' '}
                        {/* every truncated address is the SAME control (the
                            QOL convergence law): the header's identity is now
                            the shared copy chip — an ENS name stays a name,
                            with the chip beside it carrying the hex */}
                        {walletGroup.isGroup ? (
                          <span className="text-ink">{walletGroup.addresses.length} wallets</span>
                        ) : ens ? (
                          <>
                            <span className="text-ink">{ens}</span>{' '}
                            <CopyAddress address={effectiveAddress} what="your wallet address" size="xs" className="align-middle" />
                          </>
                        ) : (
                          <CopyAddress address={effectiveAddress} what="your wallet address" size="xs" className="align-middle" />
                        )}
                        <InfoDot>
                          Baskets you hold, looked through to their underlying assets, plus the assets
                          sitting directly in your wallet across every network; one total, no double
                          counting. Unpriced holdings are listed but never counted or guessed.
                          {walletGroup.isGroup &&
                            ' Linked wallets are read as one portfolio; trades and claims always come from the wallet that is connected.'}
                          {anyUnreadable &&
                            ' Right now a network or price feed isn’t answering, so this total reflects the readable part.'}
                        </InfoDot>
                      </span>
                      {/* PRIVACY MODE (feature 5): masks every holdings dollar
                          as $•••• — percentages stay — for screen shares and
                          demos. Device-local, survives reloads. */}
                      <button
                        type="button"
                        onClick={() => {
                          setMoneyPrivacy(!privacy)
                          setPrivacy(!privacy)
                        }}
                        aria-pressed={privacy}
                        aria-label={privacy ? 'Show dollar amounts' : 'Hide dollar amounts'}
                        title={privacy ? 'Show dollar amounts' : 'Hide dollar amounts'}
                        /* THE PAINTED CIRCLE MATCHES THE ⓘ (the owner 12:49: "the
                           two should read the same size"). Same split InfoDot
                           uses: an unpainted 32px tap target — the mobile
                           audit's floor — with the drawn 15.5px circle inside,
                           and -m-2 so the bigger box never moves this line. */
                        className="press -m-2 grid min-h-[32px] min-w-[32px] shrink-0 place-items-center"
                      >
                        <span
                          className={`grid h-[15.5px] w-[15.5px] place-items-center rounded-full border transition-colors ${
                            privacy ? 'border-cyan/50 text-cyan' : 'border-white/25 bg-white/[0.07] text-ink-dim hover:border-white/40'
                          }`}
                        >
                          {privacy ? (
                            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                              <line x1="1" y1="1" x2="23" y2="23" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                              <circle cx="12" cy="12" r="2.5" />
                            </svg>
                          )}
                        </span>
                      </button>
                      {/* THE SETTINGS COG (the owner, live 16:3x via UIGuy's desk):
                          the persistent wallet-management door — see, unlink,
                          add — in the identity cluster it manages. Same
                          machine as the rail pill (one hook instance in this
                          page), deliberately never auto-opened. */}
                      {effectiveAddress && (
                        <LinkedWallets trigger="cog" group={walletGroup} active={address} readableByWallet={readableByWallet} />
                      )}
                    </div>
                    {/* (BackupNudge removed — the owner 2026-08-13: "this can be
                        removed since its on the link wallet menu"; the export
                        lives in LinkedWallets' panel, one door per act.) */}
                  </div>
                  {/* READ FRESHNESS, standing beside the number it describes
                      (QOL round, owner 2026-08-05: "a page open for twenty
                      minutes shows twenty-minute-old numbers with no
                      timestamp"). Fed by the raw-holdings query's OWN isFetching
                      + dataUpdatedAt: that is the wallet-side chain read behind
                      this total and the one input here carrying a real landed-at
                      time. usePortfolio hands back a derived shape with no
                      timestamp on it, and stamping this from the wall clock
                      instead would be precisely the guess FreshDot exists to
                      refuse — so the caption is honest about a read that did
                      happen rather than confident about one nobody can date. */}
                  <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <BigTotal usd={animatedTotal} />
                    <FreshDot
                      fetching={raw.isFetching}
                      updatedAt={raw.dataUpdatedAt}
                      reading="your holdings"
                      /* the age is a door (QOL round 6): tap re-reads now —
                         user-initiated, zero standing budget */
                      onRefresh={() => void raw.refetch()}
                    />
                  </div>
                  {/* the degraded-read caveat, in the amber this file already
                      uses for one (the fees panel's) — under the number it
                      qualifies, where the reader is looking */}
                  {unreadableNote && (
                    <p className="mt-1.5 max-w-[520px] font-mono text-[10px] leading-relaxed text-amber-300/85">
                      {unreadableNote}
                    </p>
                  )}
                  {pnlTotals && (
                    <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                        Invested
                        <InfoDot>
                          The cost basis of what this wallet bought through the protocol&rsquo;s own
                          router; tokens that arrived by transfer or in-kind mint have no knowable
                          price here and are excluded, never guessed. Net compares that basis with
                          the covered shares&rsquo; value now.
                        </InfoDot>
                      </span>
                      <span className="font-num text-sm font-semibold tabular-nums text-ink">{formatUsdCompact(pnlTotals.invested)}</span>
                      {/* up/down tone rides the kit's changeAccent (teal/alert),
                          not a third pairing (PM review); literal classes so
                          Tailwind's scanner sees them */}
                      <span
                        className={`font-num text-sm font-semibold tabular-nums ${
                          changeAccent(pnlTotals.net) === 'teal' ? 'text-teal' : changeAccent(pnlTotals.net) === 'alert' ? 'text-alert' : 'text-ink'
                        }`}
                      >
                        {pnlTotals.net >= 0 ? '+' : '−'}{Math.abs(pnlTotals.netPct).toFixed(1)}%
                      </span>
                      <span className="font-num text-xs tabular-nums text-ink-dim">
                        ({pnlTotals.net >= 0 ? '+' : '−'}{formatUsdCompact(Math.abs(pnlTotals.net))} all-time)
                      </span>
                      {pnlTotals.partial && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">· covers the tracked part only</span>
                      )}
                    </div>
                  )}
                  {assets.length > 0 && (
                    <div className="mt-4 flex h-1.5 w-full max-w-[420px] gap-0.5 overflow-hidden rounded-full">
                      {assets.slice(0, 5).map((a, i) => (
                        <span key={a.key} className="seg-grow" style={{ width: `${a.pct}%`, background: SEG[i % SEG.length], '--seg-i': i } as CSSProperties} />
                      ))}
                      <span className="seg-grow flex-1 bg-white/[0.06]" style={{ '--seg-i': 5 } as CSSProperties} />
                    </div>
                  )}
                  {/* MONEY PER CHAIN (the owner 2026-08-06 12:53) — this is what
                      replaced the chart's "Progress" caption and its ⓘ, which
                      had been labelling nothing since the readout moved up to
                      the right block: an orphan word, in his words "just
                      pointless". It sits here instead of down there because he
                      asked for it "a bit closer to the bar", and the bar is the
                      other half of the same sentence — that strip says how the
                      money is split by asset, this line says where it lives. */}
                  <MoneyFacets rows={chainRows} className="mt-3" />
                </div>
                {/* the right block (13:57): count chips were "pointless
                    information" — the started-with story lives here instead,
                    plus the tier fact; counts demoted to the positions card.
                    The wallet-link door heads the column (owner 2026-08-05
                    #10: "top right, above Started with"). */}
                <div className="flex w-full flex-col items-end gap-3 xl:max-w-[300px] xl:justify-self-end">
                  {/* visible with the dev-preview identity too (the owner
                      2026-08-06 12:18: "have a little check… so I can see it
                      here as well" — connect-gated, he could never see the
                      door on the demo book; the ceremony's signing still
                      requires a real wallet, the PANEL is what shows) */}
                  {/* the utility PAIR as symbols side by side (the owner live
                      2026-08-13: "these can just be made nice symbols and
                      moved next to each other") — words live on title/aria */}
                  {effectiveAddress && (
                    <div className="flex items-center gap-2">
                      <LinkedWallets icon group={walletGroup} active={address} readableByWallet={readableByWallet} />
                      <PasteToAdd icon owners={readAddresses} onAdded={() => void raw.refetch()} />
                    </div>
                  )}
                  {/* (Add-by-address rides the icon pair above — owner
                      2026-08-13, symbols side by side; its open editor still
                      fills this column.) */}
                  {/* THE HUMAN RELEASE SURFACE (interlock precondition, built
                      on the owner's runway order) — SELF-HIDING: renders nothing
                      until a record genuinely waits on a human. */}
                  <ReleaseSurface connected={address} />
                  {/* THE CARD HOLDS ITS PLACE WHILE THE READOUT LANDS (the owner
                      12:49 #8). Rendering nothing until the history resolved
                      made the wallet-link door above it jump down the moment
                      the numbers arrived — the reload feel the bento's glide
                      exists to avoid. Same box, same rhythm, waving. */}
                  {!readout && combined.totalUsd > 0 && (
                    <div
                      className="w-full rounded-2xl border border-white/8 bg-white/[0.02] p-5"
                      role="status"
                      aria-label="Reading your history"
                    >
                      <div className="h-2.5 w-28 animate-pulse rounded-full bg-white/[0.07]" />
                      <div className="mt-4 h-8 w-36 animate-pulse rounded-lg bg-white/[0.06]" />
                      <div className="mt-4 h-4 w-44 animate-pulse rounded-full bg-white/[0.05]" />
                    </div>
                  )}
                  {readout && (
                  <div className="chip-pop relative w-full overflow-hidden rounded-2xl border border-white/12 bg-white/[0.04] p-5" style={{ '--chip-i': 0 } as CSSProperties}>
                    <span
                      aria-hidden
                      className="absolute inset-x-0 top-0 h-px"
                      style={{ background: readout.deltaUsd >= 0 ? 'var(--color-teal)' : 'var(--color-alert)', opacity: 0.7 }}
                    />
                    {/* the caveat rides with the numbers it qualifies: it used
                        to hang off the chart's "Progress" label, and that label
                        retired (12:53) — a caveat orphaned from its figures is
                        how a load-bearing one goes missing */}
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                      started with · past {readout.range}
                      <InfoDot>
                        What today&rsquo;s mix was worth at the window&rsquo;s open, from real
                        per-asset price history — the move is how it travelled to now. Money added
                        or removed inside the window isn&rsquo;t netted out, and unreadable assets
                        are excluded, never guessed.
                      </InfoDot>
                    </p>
                    <p className="mt-2 font-num text-3xl font-semibold tabular-nums text-ink">{formatUsdCompact(readout.startUsd)}</p>
                    <p className="mt-2 flex items-center gap-2.5">
                      <svg
                        viewBox="0 0 24 24"
                        className={`h-4 w-4 shrink-0 ${readout.deltaUsd >= 0 ? 'text-teal' : 'text-alert'}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                        style={{ transform: readout.deltaUsd >= 0 ? 'none' : 'scaleY(-1)' }}
                      >
                        <path d="M4 17l6-6 4 4 6-7" /><path d="M14 8h6v6" />
                      </svg>
                      <span className={`font-num text-lg font-semibold tabular-nums ${readout.deltaUsd >= 0 ? 'text-teal' : 'text-alert'}`}>
                        {readout.deltaUsd >= 0 ? '+' : '−'}{formatUsdCompact(Math.abs(readout.deltaUsd))}
                      </span>
                      {/* a zero-base window has no percent (the 1e27% card):
                          the delta stands alone, which is the whole truth */}
                      {readout.changePct != null && (
                        <span className={`font-num text-lg font-semibold tabular-nums ${readout.deltaUsd >= 0 ? 'text-teal' : 'text-alert'}`}>
                          {readout.changePct >= 0 ? '+' : ''}{readout.changePct.toFixed(2)}%
                        </span>
                      )}
                    </p>
                    {/* the small-caps share used to sit here TOO — a third
                        copy, and this one still quoted the old $1B threshold
                        hours after the mid floor moved. It lives once now, on
                        the risk spectrum and its insight card, which is his
                        own ruling: same content in many places, moved to one. */}
                  </div>
                  )}
                </div>
              </div>
              {combined.totalUsd > 0 && (
                <div className="relative mt-6">
                  {/* the run markers are OFF the hero (the owner 2026-08-06
                      12:18: the clamped tick read as "a weird blue dot with
                      a line… remove it") — the machinery stays for a
                      legend-carrying return */}
                  {/* THE COVERAGE LINE IS OFF (the owner 2026-08-06 14:10: "the
                      curve tracks 66% of today's value, the rest has no
                      readable history — remove that text"). It was a real
                      caveat on a money chart, so I checked where the fact
                      still lives before dropping the sentence: the
                      started-with ⓘ beside the figures now carries "unreadable
                      assets are excluded, never guessed". The caveat moved to
                      a disclosure; it did not disappear. */}
                  <PortfolioChart
                    assets={histAssets}
                    totalUsd={combined.totalUsd}
                    heightClass="h-48"
                    indexing={raw.isLoading}
                    onReadout={setReadout}
                    onRange={setChartRange}
                    hideCoverage
                  />
                  {/* SINCE YOU LAST LOOKED (16:4x feature 4) — the returning
                      user's question, answered once: today's holdings priced
                      at the previous visit (the chart's own constant-quantity
                      read). Renders only past a 26h gap and 80% coverage;
                      the today-line below covers anything closer. */}
                  {historyFacts.since && lastSeenMs != null && (() => {
                    const d = historyFacts.since.nowUsd - historyFacts.since.thenUsd
                    const pct = historyFacts.since.thenUsd > 0 ? (d / historyFacts.since.thenUsd) * 100 : null
                    const when = new Date(lastSeenMs).toLocaleString([], {
                      ...(Date.now() - lastSeenMs < 6 * 86_400_000 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }),
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                    return (
                      <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                        <span>Since you last looked · {when}</span>
                        <span className="font-num font-semibold tabular-nums" style={{ color: changeAccent(d) }}>
                          {d < 0 ? '-' : '+'}
                          {formatUsdCompact(Math.abs(d)).replace(/^\$/, '$')}
                        </span>
                        {pct != null && (
                          <span className="font-num tabular-nums" style={{ color: changeAccent(d) }}>
                            {d < 0 ? '' : '+'}
                            {pct.toFixed(1)}%
                          </span>
                        )}
                        {historyFacts.since.coveredSharePct < 99 && (
                          <span>covers {historyFacts.since.coveredSharePct}% of today&rsquo;s value</span>
                        )}
                      </p>
                    )
                  })()}
                  {/* TODAY'S MOVE, EXPLAINED (feature 1) — one quiet line:
                      the 24h net and the three biggest movers, signed in the
                      established change colours. Absent when nothing reads. */}
                  {/* TODAY'S MOVERS (owner 2106 + touch rounds): centered on
                      its own quiet background, pill-based WINNERS and LOSERS
                      with the day's net leading; hovering a pill spotlights
                      its tile in the picture below (the strip is navigation).
                      All movers rounding to nothing = "a quiet day so far" —
                      three grey zeros are noise, one honest sentence is not.
                      WINDOW-FOLLOWING (the board's last named item): the
                      chart lifts its range; 7D/30D pills come off the same
                      cached series the curve drew. */}
                  {chartRange !== '24H' && stripMove == null ? (
                    /* a fresh window's histories are landing — say so, never
                       show the WRONG window's pills under the new label */
                    <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] px-5 py-4">
                      <p className="flex items-center justify-center gap-2 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan" aria-hidden />
                        {stripWindowWord} · reading the window…
                      </p>
                    </div>
                  ) : stripMove != null && stripMove.rows.length > 0 ? (() => {
                    const quiet = Math.abs(stripMove.totalUsd) < 1 && stripMove.rows.every((r) => Math.abs(r.usd) < 0.5)
                    // "+N more" is a DOOR, not a dead fact (QOL round 5):
                    // open shows every mover as a pill, both directions
                    const winners = stripMove.rows.filter((r) => r.usd > 0).slice(0, moversOpen ? undefined : 3)
                    const losers = stripMove.rows.filter((r) => r.usd < 0).slice(0, moversOpen ? undefined : 3)
                    const shown = winners.length + losers.length
                    // hover spotlights; CLICK IS A DOOR (QOL round 6): every
                    // surface that names an asset opens the mode standing at it
                    const openAt = (sym: string) => {
                      const hit = assets.find((x) => x.symbol === sym)
                      if (!hit || !hasPositions) return
                      setModeFocusKey(hit.key)
                      setModeOpen(true)
                    }
                    const pill = (r: { symbol: string; usd: number }) => (
                      <button
                        type="button"
                        key={r.symbol}
                        onMouseEnter={() => setMoverSym(r.symbol)}
                        onMouseLeave={() => setMoverSym((v) => (v === r.symbol ? null : v))}
                        onFocus={() => setMoverSym(r.symbol)}
                        onBlur={() => setMoverSym((v) => (v === r.symbol ? null : v))}
                        onClick={() => openAt(r.symbol)}
                        aria-label={`$${showSymbol(r.symbol)} — open positions at this asset`}
                        className="press inline-flex items-baseline gap-1.5 rounded-full border px-3 py-1.5 transition-colors"
                        style={{
                          borderColor: r.usd >= 0 ? 'color-mix(in srgb, var(--color-teal) 35%, transparent)' : 'color-mix(in srgb, var(--color-magenta) 35%, transparent)',
                          background: r.usd >= 0 ? 'color-mix(in srgb, var(--color-teal) 8%, transparent)' : 'color-mix(in srgb, var(--color-magenta) 8%, transparent)',
                        }}
                      >
                        <span className="font-display text-[11px] font-bold uppercase tracking-wide text-ink">${showSymbol(r.symbol)}</span>
                        <span
                          className="font-num text-xs font-semibold tabular-nums"
                          style={{ color: r.usd >= 0 ? 'var(--color-teal)' : 'var(--color-magenta)' }}
                        >
                          {r.usd >= 0 ? '\u25b2 +' : '\u25bc '}
                          {formatUsdCompact(Math.abs(r.usd))}
                        </span>
                      </button>
                    )
                    return (
                      <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] px-5 py-4">
                        {quiet ? (
                          <p className="text-center font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                            {stripWindowWord} · a quiet {stripQuietWord} so far
                          </p>
                        ) : (
                          /* phones: ONE scrollable pill row, never a 4-deep
                             stack (the mobile sweep's carousel rule) */
                          <div
                            className={
                              isPhone
                                ? '-mx-5 flex items-center gap-2 overflow-x-auto px-5 [&>*]:shrink-0'
                                : 'flex flex-wrap items-center justify-center gap-2'
                            }
                          >
                            <span className="mr-1 inline-flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                              {stripWindowWord}
                              <span
                                className="font-num text-sm font-semibold tabular-nums"
                                style={{ color: stripMove.totalUsd >= 0 ? 'var(--color-teal)' : 'var(--color-magenta)' }}
                              >
                                {stripMove.totalUsd >= 0 ? '+' : '\u2212'}
                                {formatUsdCompact(Math.abs(stripMove.totalUsd))}
                              </span>
                            </span>
                            {winners.map(pill)}
                            {losers.map(pill)}
                            {(stripMove.rows.length > shown || moversOpen) && (
                              <button
                                type="button"
                                onClick={() => setMoversOpen((v) => !v)}
                                aria-expanded={moversOpen}
                                className="press rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors hover:border-cyan/40 hover:text-ink"
                              >
                                {moversOpen ? 'fewer' : `+${stripMove.rows.length - shown} more`}
                              </button>
                            )}
                            {stripMove.unreadable > 0 && (
                              /* the honesty count is a DOOR too (QOL round 6):
                                 hover names WHO could not be read */
                              <span
                                title={`No readable ${chartRange === '24H' ? '24h change' : 'price history'} for: ${stripMove.unreadableSyms.map((s2) => `$${s2}`).join(', ')}`}
                                className="cursor-help font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint underline decoration-dotted decoration-white/25 underline-offset-2"
                              >
                                · {stripMove.unreadable} unreadable
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })() : null}
                </div>
              )}
            </div>
          </Shell>

          {/* ── FEES & CLAIMS — a POPUP now (the owner 2026-08-06: "have this as
                a pop up rather than an area that shows on the page… way less
                text"), the same overlay grammar the positions mode wears ── */}
          {/* the supersession card's one-click swap — the token page's exact
              MigrateModal, mounted from the strip (owner 2026-08-16) */}
          {migrateFor && (
            <MigrateModal
              open
              onClose={() => setMigrateFor(null)}
              fromAddr={migrateFor.fromAddr}
              fromSymbol={migrateFor.fromSymbol}
              toAddr={migrateFor.toAddr}
              toSymbol={migrateFor.toSymbol}
              chainId={migrateFor.chainId}
            />
          )}
          {feesOpen &&
            createPortal(
              <div
                className="fixed inset-0 z-[92] overflow-y-auto bg-void/90 backdrop-blur-sm"
                role="dialog"
                aria-modal="true"
                aria-label="Fees and claims"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setFeesOpen(false)
                }}
              >
                <div className="mx-auto my-10 w-full max-w-2xl overflow-hidden rounded-3xl border border-white/12 bg-panel shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
                  {/* the banner (the owner 2026-08-06 12:18: "have some kind of
                      banner behind it — take it from the create page, make it
                      dark so it's like 20% visible") — the create flow's own
                      art, dimmed to a fifth, fading into the panel */}
                  <div className="relative flex h-24 items-end justify-between gap-4 px-6 pb-4 sm:px-8">
                    <img
                      src={bundleHeroArt1280}
                      alt=""
                      aria-hidden
                      className="absolute inset-0 h-full w-full object-cover opacity-20"
                    />
                    <span aria-hidden className="absolute inset-0 bg-gradient-to-b from-transparent to-panel" />
                    <h2 className="relative font-display text-xl font-bold uppercase tracking-tight text-ink">Fees &amp; claims</h2>
                    <button
                      type="button"
                      onClick={() => setFeesOpen(false)}
                      className="press relative grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
                      aria-label="Close fees panel"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="p-6 pt-0 sm:p-8 sm:pt-0">
                  <div className="mt-5">
                    {!TRADING_ENABLED ? (
                      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">fee claiming is switched off on this site</p>
                    ) : claimAgg.claimable.length + claimAgg.created.length > 0 ? (
                      <PortfolioClaims baskets={p.holdings.map((h) => h.basket)} bare />
                    ) : (
                      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">nothing claimable yet</p>
                    )}
                    {claimAgg.degraded && (
                      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/85">
                        some fee reads failed; these figures may be incomplete
                      </p>
                    )}
                    {/* THE EARN INVITE (owner ~19:3x) — refer to MANAGE A
                        PORTFOLIO, never to build a basket (the freeze). */}
                    <div className="mt-6">
                      <ReferIntro handle={claimedName ?? ens ?? effectiveAddress} href={keepHref ? '/create' : '/explore'} />
                    </div>
                  </div>
                  </div>
                </div>
              </div>,
              document.body,
            )}

          {/* ── YOUR POSITIONS — full width; the deep-dive is the MODE (13:00:
                "instead of your weighting… it needs to be your positions and
                then you deep dive into executing in one pane") ─────────────── */}
          <Shell enterIndex={1} glow="var(--color-violet-bright)">
            <div className="p-5 sm:p-10">
              <div className="flex flex-wrap items-center justify-between gap-4">
                {/* THE TOTAL RIDES THE TITLE (owner 17:53: "under your
                    positions I'd like to have the number of the portfolio
                    there as well, next to the title, just so you see it when
                    you scroll down as well") — the hero's count-up total is
                    off-screen by the time you reach the list. */}
                <h2 className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-display text-3xl font-bold uppercase tracking-tight text-ink sm:text-4xl">
                  Your positions
                  {combined.totalUsd > 0 && (
                    <span className="font-num text-2xl font-semibold tabular-nums text-ink-dim sm:text-3xl">
                      {formatUsdCompact(combined.totalUsd)}
                    </span>
                  )}
                </h2>
                <span className="flex items-center gap-3">
                  {/* the assets-across-networks line is GONE (the owner 2026-08-06
                      12:18: "we already have it with the basket · cash ·
                      stock · high cap… we show the composition" — the class
                      legend's census carries the same fact) */}
                  {/* the small twin of the card-foot CTA (owner ~10:2x: "a
                      small button also in the top right of the card so
                      there's easy access") */}
                  {hasPositions && (
                    <>
                      {/* SHARE YOUR MIX (feature 9): a percent-only bento
                          image — no dollars on it, nothing private to leak */}
                      <button
                        type="button"
                        onClick={() => {
                          const items = shareCardItems(assets)
                          if (items.length === 0) return
                          const canvas = document.createElement('canvas')
                          drawShareCard(canvas, items)
                          canvas.toBlob((blob) => {
                            if (!blob) return
                            const file = new File([blob], 'my-mix.png', { type: 'image/png' })
                            const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean }
                            if (nav.share && nav.canShare?.({ files: [file] })) {
                              nav.share({ files: [file], title: 'My mix' }).catch(() => undefined)
                            } else {
                              const url = URL.createObjectURL(blob)
                              const a = document.createElement('a')
                              a.href = url
                              a.download = 'my-mix.png'
                              a.click()
                              URL.revokeObjectURL(url)
                            }
                          }, 'image/png')
                        }}
                        aria-label="Share your mix as an image (percentages only)"
                        title="Share your mix (percentages only)"
                        className="press grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/12 text-ink-faint hover:border-cyan/50 hover:text-cyan"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
                          <path d="M12 3v13" />
                          <path d="M8 7l4-4 4 4" />
                        </svg>
                      </button>
                      {/* EXPORT WHAT HAPPENED (16:4x feature 7): positions +
                          this device's recorded activity, as a CSV. Real
                          numbers regardless of the privacy eye — an explicit
                          export is the user asking for their own data. */}
                      <button
                        type="button"
                        onClick={() => {
                          const csv = buildPortfolioCsv({
                            exportedAtIso: new Date().toISOString(),
                            positions: [
                              ...positionRows.map((r) => ({
                                symbol: r.asset.symbol,
                                kind: r.kind ?? 'token',
                                chain: chainMeta(r.asset.chainId).short,
                                amount: r.kind === 'token' ? r.amount : undefined,
                                priceUsd: r.kind === 'token' && r.amount && r.amount > 0 ? r.valueUsd / r.amount : undefined,
                                valueUsd: r.valueUsd,
                                sharePct: r.pct,
                              })),
                              // LP counts like any other asset (owner 2026-08-15)
                              ...lpModeRows.map((r) => ({
                                symbol: r.symbol,
                                kind: 'lp' as const,
                                chain: chainMeta(r.chainId).short,
                                amount: undefined,
                                priceUsd: undefined,
                                valueUsd: r.valueUsd,
                                sharePct: combined.totalUsd > 0 ? (r.valueUsd / combined.totalUsd) * 100 : 0,
                              })),
                            ],
                            // the whole group's history, one timeline
                            // (2026-08-11): the book merges, so the record of
                            // what made it must merge too
                            activity: loadExecLogGroup(walletGroup.addresses),
                          })
                          const blob = new Blob([csv], { type: 'text/csv' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `spectrum-portfolio-${new Date().toISOString().slice(0, 10)}.csv`
                          a.click()
                          URL.revokeObjectURL(url)
                        }}
                        aria-label="Export positions and recorded activity as CSV"
                        title="Export CSV"
                        className="press grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/12 text-ink-faint hover:border-cyan/50 hover:text-cyan"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
                          <path d="M12 16V3" />
                          <path d="M8 12l4 4 4-4" />
                        </svg>
                      </button>
                      {/* the period the document covers. A tax year is the
                          reason anyone exports this, so it is a control, not a
                          buried option — and "all time" stays the default
                          because a wrong year silently omits disposals.
                          The whole control hides when NO chain can serve
                          history (keyless build) — never a button that cannot
                          produce its document (audit 2026-08-12). */}
                      {tradeHistoryPossible && (
                      <>
                      <label className="sr-only" htmlFor="tax-year">Period for the trade history export</label>
                      <select
                        id="tax-year"
                        value={String(taxYear)}
                        onChange={(e) => {
                          setTaxYear(e.target.value === 'all' ? 'all' : Number(e.target.value))
                          // the empty note described the OLD period's attempt
                          setTradeHistoryEmpty(false)
                        }}
                        title="Period for the trade history export"
                        /* px-4, not 2.5 — "all time" needs the room beside the
                           platform's own select chevron (owner 2026-08-16:
                           "needs a wider pill for the all time pill") */
                        className="press h-9 shrink-0 rounded-full border border-white/12 bg-transparent px-4 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint outline-none transition-colors hover:border-teal/50 hover:text-teal"
                      >
                        <option value="all">all time</option>
                        {[0, 1, 2].map((back) => {
                          const y = new Date().getUTCFullYear() - back
                          return (
                            <option key={y} value={y}>
                              {y}
                            </option>
                          )
                        })}
                      </select>
                      {/* THE TRADE HISTORY & COST BASIS (the owner 2026-08-11):
                          every router trade, dated, with the basis each
                          disposal consumed — the document you hand an
                          accountant. Deliberately not called a tax report;
                          the file states its method and its gaps up top. */}
                      <button
                        type="button"
                        disabled={tradeHistory.busy}
                        onClick={() => {
                          void (async () => {
                            const year = taxYear
                            const range =
                              year === 'all'
                                ? {}
                                : { fromMs: Date.UTC(year, 0, 1), toMs: Date.UTC(year + 1, 0, 1) - 1 }
                            setTradeHistoryEmpty(false)
                            const load = await tradeHistory.load(walletGroup.addresses, range)
                            // failed: the hook's error copy renders under the
                            // header — a spinner blink is not an answer
                            if (!load) return
                            if (load.history.rows.length === 0) {
                              // empty is a real answer, and it is said
                              setTradeHistoryEmpty(true)
                              return
                            }
                            const symbolOf = (basket: string) =>
                              p?.holdings.find((h) => h.basket.address.toLowerCase() === basket)?.basket.symbol ?? basket.slice(0, 8)
                            const csv = buildTradeHistoryCsv({
                              exportedAtIso: new Date().toISOString(),
                              history: load.history,
                              symbolOf,
                              chainNameOf,
                              wallets: walletGroup.addresses,
                              ...(year === 'all'
                                ? {}
                                : { fromIso: `${year}-01-01`, toIso: `${year}-12-31` }),
                            })
                            const blob = new Blob([csv], { type: 'text/csv' })
                            const url = URL.createObjectURL(blob)
                            const a = document.createElement('a')
                            a.href = url
                            a.download = `spectrum-trades-${year === 'all' ? 'all' : year}.csv`
                            a.click()
                            URL.revokeObjectURL(url)
                          })()
                        }}
                        aria-label="Export your trade history and tracked cost basis as CSV"
                        title="Trade history & cost basis — for your accountant"
                        className="press grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/12 text-ink-faint transition-colors hover:border-teal/50 hover:text-teal disabled:opacity-50"
                      >
                        {tradeHistory.busy ? (
                          <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                        ) : (
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M14 3v5h5" />
                            <path d="M19 8v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8Z" />
                            <path d="M9 13h6M9 17h4" />
                          </svg>
                        )}
                      </button>
                      </>
                      )}
                      <button
                        type="button"
                        id="pf-rebalance"
                        onClick={() => setModeOpen(true)}
                        className="press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-cyan/40 bg-cyan/[0.08] px-4 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan hover:border-cyan/70"
                      >
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                          <path d="M4 8h10M4 16h7" /><circle cx="17" cy="8" r="2.5" /><circle cx="14" cy="16" r="2.5" />
                        </svg>
                        Rebalance
                      </button>
                    </>
                  )}
                </span>
              </div>

              {/* the export's own two answers (audit 2026-08-12): a failure
                  speaks in the hook's user-worded copy, an empty result is a
                  real answer said out loud — never a spinner blink that reads
                  as a broken button. The amber idiom is the page's existing
                  couldn't-be-read note. */}
              {tradeHistory.error && (
                <p className="mt-3 font-mono text-[11px] leading-relaxed text-amber-200/90">{tradeHistory.error}</p>
              )}
              {!tradeHistory.error && tradeHistoryEmpty && (
                <p className="mt-3 font-mono text-[11px] leading-relaxed text-ink-faint">
                  No router trades on record for this portfolio{taxYear === 'all' ? '' : ` in ${taxYear}`} — nothing to export yet.
                </p>
              )}

                  {/* THE RISK SPECTRUM (owner 18:51): the assets themselves
                      stand where they sit on the market-cap axis, drawn to
                      their share, with the tier bar beneath as the aggregate.
                      The dollar sentence and the top-two chip that used to sit
                      here live in the insight cards now, once each. */}
                  <div className="mt-4">
                    <RiskSpectrum assets={spectrumAssets} tierBar={tierBar} />
                  </div>

                  {/* The side-by-side is RETIRED (owner ~21:0x). The daily's
                      "bento box layout on the right" gave the list a column and
                      the bento 320px, and squeezed both; one at a time, each
                      gets the whole width. */}
                  {/* THE SWITCH — stated as a choice, not hidden behind an
                      icon: two pills that name what you get. */}
                  {/* ONE ROW: Show-as · the category pills · (right) the risk
                      readout — his 23:09 layout, verbatim. The pills are a
                      SPOTLIGHT: matching holdings stay lit, the rest darken,
                      second click brings everything back. (mt: his "tiny bit
                      more above this" — one step up the scale.) */}
                  <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Show as</span>
                      {([
                        { id: 'list' as const, label: 'List' },
                        { id: 'bento' as const, label: 'Picture' },
                      ]).map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          aria-pressed={mixView === v.id}
                          onClick={() => setMixView(v.id)}
                          /* 36px on phone (mobile sweep 2026-08-06 measured
                             28) — this is the control that switches how you
                             read your own book, not a decoration */
                          className={`press inline-flex min-h-[36px] items-center rounded-full border px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors sm:min-h-0 ${
                            mixView === v.id ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
                          }`}
                        >
                          {v.label}
                        </button>
                      ))}
                      {/* group the picture by WHO HOLDS each tile — only a
                          real choice when the book reads more than one wallet */}
                      {mixView === 'bento' && walletGroup.isGroup && (
                        <button
                          type="button"
                          aria-pressed={groupByWallet}
                          onClick={() => setGroupByWallet((v) => !v)}
                          className={`press inline-flex min-h-[36px] items-center rounded-full border px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors sm:min-h-0 ${
                            groupByWallet ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
                          }`}
                        >
                          By wallet
                        </button>
                      )}
                    </div>
                    {/* the label only exists to introduce its pills — with an
                        empty set it rendered as the orphan word "Spotlight"
                        beside nothing (mobile sweep 2026-08-06) */}
                    {catPills.length > 0 && (
                      <>
                        <span aria-hidden className="hidden h-4 w-px bg-white/10 sm:block" />
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Spotlight</span>
                          <CategoryPills pills={catPills} active={catFilter} onToggle={setCatFilter} />
                        </div>
                      </>
                    )}
                    {/* the risk-tolerance readout (his three: mid, low, stocks) —
                        dollars from the same tier reads the spectrum stands on */}
                    {riskReadout.length > 0 && (
                      <span className="ml-auto flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                        {riskReadout.map((r) => (
                          <span key={r.tier}>
                            {TIER_LABELS[r.tier]}{' '}
                            <span className="font-num text-xs font-semibold tabular-nums text-ink-dim">{formatUsdCompact(r.usd)}</span>
                          </span>
                        ))}
                      </span>
                    )}
                  </div>

                  {/* THE LIST. Every asset visible, no inner scroll (owner
                      ~19:0x), and groups carry NO trailing margin — the sticky
                      header separates them, and a bottom margin made the LAST
                      row of each group read taller than its siblings. */}
                  <div className="mt-5">
                  {mixView === 'list' && (
                  <div>
                    {tierGroups.map((g) => (
                      <div key={g.tier}>
                        <div className="sticky top-0 z-10 bg-panel/95 pb-1.5 pt-3 backdrop-blur-sm">
                          <div className="flex items-baseline justify-between gap-3">
                          {/* the group titles carry the list, so they read at
                              size (owner: "the titles can be a little larger
                              and easier to read") — up from 10px/0.18em, and
                              off the faint ink onto the readable step */}
                          <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink">
                            {TIER_LABELS[g.tier]}
                            {g.tier === 'large' && (
                              <InfoDot>
                                {/* capLabel picks the unit — hardcoding "B" here
                                    printed "$0B" the moment the large floor
                                    moved to $200M */}
                                Tokens with at least {capLabel(TIER_THRESHOLDS.large)} of market
                                value. Mid caps sit above {capLabel(TIER_THRESHOLDS.mid)},
                                small caps above {capLabel(TIER_THRESHOLDS.small)}, new &amp;
                                micro below that. Grouped by market size; a fact, never a rating.
                              </InfoDot>
                            )}
                            {g.tier === 'unranked' && (
                              <InfoDot>No readable market value right now; listed, never guessed into a tier.</InfoDot>
                            )}
                          </span>
                          <span className="font-num text-xs font-semibold tabular-nums text-ink">{g.pct.toFixed(1)}%</span>
                          </div>
                          {/* the tier's share as a hairline — the list reads
                              as a risk picture at a glance */}
                          <div className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                            <span className="block h-full rounded-full bg-white/25" style={{ width: `${Math.min(100, g.pct)}%` }} />
                          </div>
                        </div>
                        {g.assets.map((a) => {
                          const i = assets.indexOf(a)
                          const direct = a.contributions.some((c) => c.basketSymbol === 'held directly')
                          const both = direct && a.basketCount > 0
                          return (
                            /* the row is a DOOR (QOL round 5, parity with the
                               bento's double-click): tap opens the positions
                               mode standing at this asset — inner links and
                               buttons keep their own clicks */
                            <div
                              key={a.key}
                              role={hasPositions ? 'button' : undefined}
                              tabIndex={hasPositions ? 0 : undefined}
                              aria-label={hasPositions ? `$${showSymbol(a.symbol)} — open positions at this asset` : undefined}
                              onClick={
                                hasPositions
                                  ? (e) => {
                                      if ((e.target as HTMLElement).closest('a,button')) return
                                      setModeFocusKey(a.key)
                                      setModeOpen(true)
                                    }
                                  : undefined
                              }
                              onKeyDown={
                                hasPositions
                                  ? (e) => {
                                      if (e.key !== 'Enter' && e.key !== ' ') return
                                      if ((e.target as HTMLElement).closest('a,button')) return
                                      e.preventDefault()
                                      setModeFocusKey(a.key)
                                      setModeOpen(true)
                                    }
                                  : undefined
                              }
                              className={`group flex h-11 items-center gap-3 border-b border-white/8 transition-[opacity,background-color] duration-300 last:border-b-0 hover:bg-white/[0.02] sm:gap-4 ${
                                hasPositions ? 'cursor-pointer' : ''
                              } ${litKeys && !litKeys.has(a.key) ? 'opacity-30' : ''}`}
                            >
                              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SEG[i % SEG.length] }} />
                              <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={28} />
                              {/* THE ROW READS AS A SENTENCE (owner 20:20: "the
                                  amount you have should go right next to the
                                  ticker, with a nice little bit of space behind
                                  it, and then you have the held directly. The
                                  percentages are the last thing on the right").
                                  Ticker, then what it is worth at the SAME
                                  weight as the ticker — his "the same size or a
                                  little bit larger" — then how it reaches you.
                                  The value used to sit at the far right as a
                                  column, which read as a spreadsheet. */}
                              <span className="flex min-w-0 flex-1 items-baseline gap-4">
                                <span className="shrink-0 font-display text-sm font-bold text-ink">${showSymbol(a.symbol)}</span>
                                <span className="shrink-0 font-num text-[15px] font-semibold tabular-nums text-ink">
                                  {formatUsdCompact(a.valueUsd)}
                                </span>
                                {/* HOW IT REACHES YOU is grey text in every
                                    case (owner ~20:3x: "direct + 2 baskets
                                    shouldn't show in a pill, it should just
                                    show like if it's just a basket or just a
                                    token, as grey text"). A pill on only the
                                    mixed case made one row shout while its
                                    neighbours whispered the same kind of fact. */}
                                <span className="min-w-0 shrink truncate font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                                  {both
                                    ? `direct + ${a.basketCount} basket${a.basketCount === 1 ? '' : 's'}`
                                    : a.basketCount > 0
                                      ? `via ${a.basketCount} basket${a.basketCount === 1 ? '' : 's'}`
                                      : direct
                                        ? 'held directly'
                                        : ''}
                                </span>
                              </span>
                              {/* the right cluster still owns the push, so the
                                  columns cannot fall out of line when an
                                  optional child does not render (PM's finding) */}
                              <span className="ml-auto flex shrink-0 items-center gap-2">
                                {/* the class signal (touch round 2: list-view
                                    parity) — the SAME glyph the picture and its
                                    key wear, in a reserved slot so unranked
                                    rows (glyph absent, honestly) stay aligned */}
                                <span className="flex w-8 justify-center text-ink-faint">
                                  <ClassSignalGlyph signal={classSignalFor(tierOf(a), heldBasketKeys.has(a.key))} />
                                </span>
                                <span className="hidden w-14 items-center justify-center gap-1.5 sm:flex">
                                  {chartLinksFor(a.chainId, a.address).map((l) => (
                                    <a
                                      key={l.key}
                                      href={l.href}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      aria-label={`${l.label}: $${showSymbol(a.symbol)}`}
                                      title={l.label}
                                      className="press grid h-6 w-6 place-items-center rounded-md border border-white/10 bg-white/[0.03] opacity-60 transition-opacity hover:opacity-100"
                                    >
                                      <img src={l.mark} alt="" className="h-3.5 w-3.5 rounded-[3px]" />
                                    </a>
                                  ))}
                                </span>
                                <span className="hidden w-20 justify-center md:inline-flex">
                                  <ChainBadge chainId={a.chainId} className="w-full justify-center" />
                                </span>
                                {/* the percentage is the LAST thing on the right, his words */}
                                <span className="w-16 text-right font-num text-sm tabular-nums text-ink-dim">{a.pct.toFixed(1)}%</span>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                  )}

                  {/* CONTINUE WHERE YOU LEFT OFF (the owner 2026-08-18: a
                      closed/refreshed mid-bridge flow "should be able to
                      continue from the portfolio bento grid"). The pending
                      store survives reloads by design; this mounts the SAME
                      banner the swap console trusts, one per network, right
                      above the picture — each renders nothing when that
                      chain has no transfer in flight, and Continue reopens
                      the flow, which replans on the arrived funds. */}
                  <div className="space-y-2">
                    {SUPPORTED_CHAIN_IDS.map((cid) => (
                      <BridgeBanner key={`bb:${cid}`} chainId={cid} {...(keepHref ? { onUse: () => void navigate(keepHref) } : {})} />
                    ))}
                  </div>

                  {/* THE PICTURE, at full width — weight-proportioned squares.
                      It used to live in a 320px rail beside the list, where a
                      5% holding was a stamp. Given the whole width it is a
                      readable map of the mix, which is the only reason to draw
                      it as squares at all. A wide, shallow aspect suits a
                      full-width block; the old 0.9 was for a narrow column. */}
                  {mixView === 'bento' && landedKeys.size > 0 && (
                    /* one spectral pass over the whole map the moment you land
                       from a completed run — celebration, not a state */
                    <RunProgressStyles />
                  )}
                  {mixView === 'bento' && (
                    <div id="bento-grid" ref={bentoRef} className="scroll-mt-24">
                    <BasketBento
                      items={bentoItems}
                      /* hover pops the chart card (the owner 12:18: the % shows
                         THERE, not on the tile) */
                      expandable
                      hoverShareLabel="of portfolio"
                      /* phones get a VERTICAL map (the owner's mobile sweep,
                         2026-08-05: "the bento in a vertical layout rather
                         than horizontal on mobile") — portrait aspect, tiles
                         stack down the page and each gets real height, so the
                         height-gated footers (dollars, where-held bars) all
                         seat. Supersedes the 1.15 squarer box from audit
                         round 4 — same read-once pattern, a rotation reloads. */
                      /* the map GROWS DOWN as the book widens (the 50-asset
                         ruling): more holdings buy more height, so the average
                         tile keeps a readable floor instead of every tile
                         shrinking to fit a fixed band */
                      aspect={isPhone ? 0.72 : bentoItems.length <= 14 ? 2.6 : bentoItems.length <= 26 ? 1.9 : 1.35}
                      animateLayout
                      groupOrder={groupByWallet ? walletGroupOrder : SPOTLIGHT_ORDER}
                      onOpen={
                        hasPositions
                          ? (id) => {
                              setModeFocusKey(tileOpenKey.current.get(id) ?? null)
                              setModeOpen(true)
                            }
                          : undefined
                      }
                    />
                    </div>
                  )}
                  {/* the class-signal key (owner 2026-08-05) — always visible
                      under the picture: a grammar nobody can read is
                      decoration, and hover-taught keys are invisible on touch */}
                  {mixView === 'bento' && <BentoClassLegend className="mt-3" onHover={setLegendClass} counts={legendCounts} />}
                  </div>

                  {/* ── THE DUST FOLD (owner 2026-08-12: "we should hide dust")
                      — folded, never deleted. The row states what it is holding
                      back, so the hero total visibly reconciles; the expander
                      shows every folded row with its dollars. */}
                  {dustFold.dust.length > 0 && (
                    <div className="mt-5 border-t border-white/8 pt-3">
                      <button
                        type="button"
                        onClick={toggleDust}
                        aria-expanded={dustOpen}
                        className="press flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-white/[0.02]"
                      >
                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                          {dustFold.dust.length} small position{dustFold.dust.length === 1 ? '' : 's'}
                          {' · '}
                          {/* cents, not rounded dollars: this row exists FOR small
                              money, and the dust insight beside it says $13.80 —
                              two roundings of one number read as two numbers */}
                          <span className="font-num tabular-nums text-ink-dim">{formatUsdCompact(dustFold.dustUsd)}</span>
                          {' total · under '}
                          {formatUsdCompact(DUST_CEILING_USD)}
                          <InfoDot>
                            Positions worth less than {formatUsdCompact(DUST_CEILING_USD)} are folded here to keep the
                            book readable — they are still counted in your total, your percentages and every export.
                            Holdings that could not be priced are never folded, and an asset you added by address
                            never folds.
                          </InfoDot>
                        </span>
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan">
                          {dustOpen ? 'hide' : 'show'}
                        </span>
                      </button>
                      {dustOpen && (
                        <div className="mt-1.5">
                          {dustFold.dust.map((a) => (
                            <div key={a.key} className="flex h-9 items-center gap-3 border-b border-white/[0.06] last:border-b-0">
                              <AssetLogo address={a.address} chainId={a.chainId} symbol={a.symbol} size={18} />
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-dim">
                                ${showSymbol(a.symbol)}
                              </span>
                              <ChainBadge chainId={a.chainId} />
                              <span className="font-num text-[11px] tabular-nums text-ink-dim">{formatUsdCompact(a.valueUsd)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* THE AIRDROP CUT, SAID OUT LOUD (the owner 2026-08-18: a
                      scam token "shows up in my portfolio — filter out low
                      liquidity tokens and honeypots"): discovered tokens with
                      no credible market leave the book at the source; this
                      one line is the no-silent-hiding half. Paste-to-add (the
                      hero's utility column) remains the door for a real token
                      the bar catches early. */}
                  {(raw.data?.suspectCount ?? 0) > 0 && (
                    <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                      {raw.data!.suspectCount} airdropped token{raw.data!.suspectCount === 1 ? '' : 's'} hidden — no credible market · add by address to show one
                    </p>
                  )}

                  {/* (the paste-to-add door moved to the hero's utility column,
                      2026-08-13 — ONE seat, not three: a second copy of an
                      input that writes the same store is scatter, and this one
                      was strictly dominated by a seat 1400px higher.) */}

                  {/* the entry UNDER the last asset (12:02) now opens the
                      POSITIONS MODE (13:00) — the one deep-dive pane */}
                  {hasPositions ? (
                    /* a REAL button — CENTERED at the card's foot (owner
                       ~10:2x: "on portfolio we should center this at the
                       bottom"); the small twin lives in the header's top
                       right for easy access */
                    <div className="mt-6 flex justify-center">
                      <button
                        type="button"
                        onClick={() => setModeOpen(true)}
                        className="spectral-btn press group inline-flex h-11 items-center gap-2.5 rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void transition-transform duration-500 hover:scale-[1.02]"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                          <path d="M4 8h10M4 16h7" /><circle cx="17" cy="8" r="2.5" /><circle cx="14" cy="16" r="2.5" />
                        </svg>
                        Add · rebalance · execute
                        <span aria-hidden className="transition-transform duration-500 group-hover:translate-x-1">→</span>
                      </button>
                    </div>
                  ) : keepHref ? (
                    <Link
                      to={keepHref}
                      className="press mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                        <path d="M4 8h10M4 16h7" /><circle cx="17" cy="8" r="2.5" /><circle cx="14" cy="16" r="2.5" />
                      </svg>
                      Add or reweight
                    </Link>
                  ) : null}

                  {unpriced.length > 0 && (
                    <div className="mt-6 border-t border-white/8 pt-5">
                      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Unpriced · visible, never guessed</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {unpriced.map((h) => (
                          <span key={`${h.chainId}:${h.address}`} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-1 pr-3">
                            <AssetLogo address={h.address} symbol={h.symbol} chainId={h.chainId} size={20} />
                            <span className="font-mono text-[11px] text-ink-dim">${showSymbol(h.symbol)}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                

            </div>
          </Shell>

          {/* ── COMPOSITION, small screens — the rail carries it on lg+ ───── */}
          {cats.length > 0 && (
            <div className="lg:hidden">
              <Shell enterIndex={2}>
                <div className="p-6">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="font-display text-base font-bold uppercase tracking-[0.08em] text-ink">Composition</h2>
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                      facts
                      <InfoDot>
                        Category shares of the combined weighting. Stablecoins and stocks are
                        detected from their registries; ETH &amp; BTC cover the majors and their
                        wrapped forms. Facts about what you hold, never a rating of it.
                      </InfoDot>
                    </span>
                  </div>
                  <div className="mt-2">
                    <CompRows cats={cats} top1={top1} />
                  </div>
                </div>
              </Shell>
            </div>
          )}

          {/* ── RESUME YOUR MIX (the first-run ruling, ~15:5x): a shaped-but-
                unshipped draft lives device-local and nothing ever pointed
                back to it — a silent funnel leak. One quiet dashed line; the
                flow loads the draft itself at keepHref. Keep-shaped drafts
                only (a rebalance draft has its own popup lifecycle); no
                dollars on it, count only. ─────────────────────────────────── */}
          {resumeDraft && keepHref && (
            <Link
              to={keepHref}
              className="enter press mt-6 flex h-12 items-center justify-center gap-2.5 rounded-2xl border border-dashed border-cyan/25 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
              style={{ '--enter-i': 3 } as CSSProperties}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M4 8h10M4 16h7" />
                <circle cx="17" cy="8" r="2.5" />
                <circle cx="14" cy="16" r="2.5" />
              </svg>
              you have an unfinished mix · {resumeDraft.targets.length} asset{resumeDraft.targets.length === 1 ? '' : 's'} · continue
              shaping →
            </Link>
          )}

          {/* the away snapshot persists AFTER paint — outside the strip gate,
              because a first visit with nothing to say still records today
              so tomorrow has a yesterday */}
          {awayAnchor && awayNext && <AwaySnapSaver anchor={awayAnchor} snap={awayNext} />}

          {/* ── INSIGHTS — his own band, between positions and public baskets
                (17:53). Each card is one fact with the measurement behind it;
                the band is absent entirely when nothing is true enough to say,
                because a strip that pads itself out is noise. No colour is
                spent here: these are neutral facts, and a tint on a neutral
                fact reads as a verdict about it. The away BRIEFING leads the
                band when a return has news (desk 46). ───────────────────── */}
          {/* THE ONE DOOR TO BASKET MANAGEMENT (owner 2026-08-16, pasting the
              seed walls, thesis nudges and holder-stats run that stacked here:
              "all of this shouldnt be showing on the portfolio page just have
              the link to the creator page to manage baskets"). UnseededBaskets,
              ThesisNudge and BasketHolderStats all came off this page on that
              word — every seed/thesis action now rides its product's card
              footer on the creator page, which this link opens. */}
          {address && (
            <Link
              to={`/creator/${address}`}
              className="press mt-6 flex h-12 items-center justify-center gap-2 rounded-2xl border border-white/10 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim hover:border-white/25 hover:text-ink"
            >
              manage your baskets on your creator page →
            </Link>
          )}
          {/* recent transactions — the slideshow between the baskets and the
              LP section (recording 1221: see the trade land, pretty, not
              text-heavy); the just-landed row wears the arrival ring */}
          <RecentTransactions
            wallets={[readAddresses].flat().filter((w): w is string => typeof w === 'string' && w.length > 0)}
            symbolOf={(cid, addr) =>
              (allBaskets.data ?? []).find((b) => b.chainId === cid && b.address.toLowerCase() === addr)?.symbol ?? null
            }
          />
          {/* the LP detail rows (per-position range state); the TILES above are
              the summary — same read, lifted once */}
          <LiquidityPositions data={lpRead.data} />
          {stripCards.length > 0 && (
            <div className="mt-6">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <h2 className="font-display text-[13px] font-bold uppercase tracking-[0.18em] text-ink-dim">Insights</h2>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  facts about your mix, as it stands
                </span>
                {/* THE BAND LIVES BEHIND A COG NOW (the owner 2026-08-06 12:18:
                    "the 5 percentage point [stepper] is just a bit confusing —
                    I'd rather that in a settings cog you can tweak and save").
                    The saved-with-your-plan persistence is unchanged; only
                    the door moved. Escape and outside-click close it. */}
                {insightBaseline && (
                  <span className="relative ml-auto">
                    <button
                      type="button"
                      onClick={() => setBandOpen((v) => !v)}
                      aria-expanded={bandOpen}
                      aria-label="Insight settings"
                      className="press grid h-7 w-7 place-items-center rounded-full border border-white/12 text-ink-faint transition-colors hover:border-cyan/50 hover:text-cyan"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                      </svg>
                    </button>
                    {bandOpen && (
                      <span className="absolute right-0 top-9 z-40 block w-64 rounded-xl border border-white/12 bg-panel p-4 shadow-2xl">
                        <span className="block font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim">Drift alerts fire beyond</span>
                        <span className="mt-2.5 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setBand(Math.max(1, band - 1))}
                            aria-label="Narrow the drift band"
                            className="press grid h-7 w-7 place-items-center rounded-full border border-white/12 text-ink-faint hover:border-cyan/50 hover:text-cyan"
                          >
                            −
                          </button>
                          <span className="min-w-[64px] text-center font-num text-lg font-semibold tabular-nums text-ink">±{band}pp</span>
                          <button
                            type="button"
                            onClick={() => setBand(Math.min(25, band + 1))}
                            aria-label="Widen the drift band"
                            className="press grid h-7 w-7 place-items-center rounded-full border border-white/12 text-ink-faint hover:border-cyan/50 hover:text-cyan"
                          >
                            +
                          </button>
                        </span>
                        <span className="mt-2.5 block text-[11px] leading-relaxed text-ink-faint">
                          A position inside this band of its set share stays quiet. Saved with your
                          plan on this device.
                        </span>
                      </span>
                    )}
                  </span>
                )}
              </div>
              {/* wrapping flex, not a grid: an odd last card GROWS to fill its
                  row instead of leaving a half-width orphan beside a hole
                  (surveyed at 820px with three cards). PHONES ride UIGuy's
                  shared Carousel instead of a stack (the mobile sweep) —
                  gridFrom='never' because the desktop wrap-grow layout is
                  flex, which his grid-state can't express; every card rides
                  the rail, so the fold button retires there. */}
              <MaybeCarousel
                phone={isPhone}
                label="Portfolio insights"
                peek="78%"
                desktopClassName="flex flex-wrap gap-3"
              >
                {(isPhone || insightsOpen ? stripCards : stripCards.slice(0, 4)).map((c, i) => (
                  <div key={c.id} className={isPhone ? undefined : 'contents'}>
                  <InsightCard
                    insight={c}
                    /* the away pulse (touch round 2): one glow on the strip's
                       lead card when the briefing found changes — the glance
                       that says "start here" without stealing the page */
                    pulseOnMount={i === 0 && awayDeltas.length > 0}
                    /* cards that name assets light their tiles (QOL round 6) */
                    onHover={c.spot?.length ? (on) => setHoverSpot(on ? c.spot! : null) : undefined}
                    onAct={(a) => {
                      // goto routes to a page that already owns the act (the
                      // partial-bundle card → the bundle's own page)
                      if (a.kind === 'goto') {
                        navigate(a.href)
                        return
                      }
                      // the supersession card's one-click swap (owner
                      // 2026-08-16): the REAL migrate review opens right
                      // here — it holds every signature, as on the token page
                      if (a.kind === 'migrate') {
                        setMigrateFor({ fromAddr: a.fromAddr, fromSymbol: a.fromSymbol, toAddr: a.toAddr, toSymbol: a.toSymbol, chainId: a.chainId })
                        return
                      }
                      // one tap: the mode opens already holding the staged
                      // change — the drift card's correction, or the dust
                      // sweep's trims to zero. Confirming stays in the mode.
                      setSeedTargets(
                        a.kind === 'sweep' ? new Map(a.keys.map((k) => [k, 0])) : new Map([[a.key, a.toUsd]]),
                      )
                      setSeedNote(a.label)
                      setModeOpen(true)
                    }}
                  />
                  </div>
                ))}
              </MaybeCarousel>
              {!isPhone && stripCards.length > 4 && (
                <button
                  type="button"
                  onClick={() => setInsightsOpen((v) => !v)}
                  aria-expanded={insightsOpen}
                  className="press mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:border-cyan/50 hover:text-cyan"
                >
                  {insightsOpen ? 'fewer facts' : `+${stripCards.length - 4} more fact${stripCards.length - 4 === 1 ? '' : 's'}`}
                  <svg viewBox="0 0 24 24" className={`h-3 w-3 transition-transform ${insightsOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* ── YOUR PUBLIC BASKETS — bentos + the money/holder facts ─────── */}
          {p.holdings.length > 0 && (
            <Shell enterIndex={3} glow="var(--color-teal)">
              <div className="p-5 sm:p-10">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">Your public baskets</h2>
                  <span className="flex items-center gap-3">
                    {/* THE DOOR TO YOUR OWN CREATOR PAGE (the owner, 2026-08-07:
                        "in the top right there should be a button to visit
                        their creator page"). These baskets are PUBLISHED — the
                        creator page is where anyone else sees them, and until
                        now the person who made them had no way to reach it from
                        the place that lists them. Uses the same short-url the
                        rest of the app links creators with, so the address form
                        stays in one place. */}
                    {effectiveAddress && (
                      <Link
                        to={creatorHref(effectiveAddress)}
                        className="press inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/12 bg-white/[0.04] px-3.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-teal/50 hover:text-ink"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <path d="M15 3h6v6M10 14 21 3" />
                        </svg>
                        your creator page
                      </Link>
                    )}
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                      {/* a blipped fee read must not pass for a complete one:
                          `degraded` was already surfaced in the fees panel but
                          not HERE, beside the number it actually undercuts —
                          and with the tally under the gate, silence read as
                          "nothing to claim" rather than "could not check"
                          (audit 2026-08-07). Same wording the classic Earn
                          card uses for the same flag. */}
                      {claimAgg.totalUsdc > 0.005 ? (
                        <>
                          claimable across your baskets:{' '}
                          <span className="font-num text-xs font-semibold tabular-nums text-teal">
                            ${claimAgg.totalUsdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                          {claimAgg.degraded && (
                            <span className="text-amber-300/85"> · so far — a balance could not be read</span>
                          )}
                        </>
                      ) : claimAgg.degraded ? (
                        <span className="text-amber-300/85">a fee balance could not be read — the claimable total is unknown</span>
                      ) : (
                        'their assets count in your weighting above'
                      )}
                    </span>
                    {/* the completion beat (QOL round 5): a clean sweep used
                        to end by the button VANISHING — say it, briefly */}
                    {claimBeat && (
                      <span className="intro-step-in font-mono text-[10px] uppercase tracking-[0.14em] text-teal">
                        ✓ claimed
                      </span>
                    )}
                    {/* the little button that just claims (owner 2106:
                        "insta triggers the claim there") — the guarded
                        sweep, right where the number is */}
                    {claimAgg.totalUsdc > 0.005 && claimAgg.items.length > 0 && (
                      <button
                        type="button"
                        disabled={tallyClaim.running}
                        onClick={() => void tallyClaim.claimAll(claimAgg.items)}
                        title={tallyClaim.error ?? undefined}
                        className="press rounded-lg border border-teal/50 bg-teal/15 px-3 py-1.5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-teal hover:enabled:border-teal disabled:opacity-60"
                      >
                        {tallyClaim.running ? `Claiming ${tallyClaim.done + tallyClaim.failed}/${tallyClaim.total}…` : 'Claim'}
                      </button>
                    )}
                    {/* collapsible (owner ~11:2x): the card keeps its header
                        facts either way; only the basket grid folds */}
                    <button
                      type="button"
                      onClick={() => setBasketsOpen((v) => !v)}
                      aria-expanded={basketsOpen}
                      aria-controls="public-baskets-body"
                      aria-label={basketsOpen ? 'Collapse your public baskets' : 'Expand your public baskets'}
                      className="press grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/12 text-ink-faint hover:border-cyan/50 hover:text-cyan"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className={`h-3.5 w-3.5 transition-transform duration-300 ${basketsOpen ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  </span>
                </div>
                {/* THE TAP HAS TO SAY SOMETHING (audit 2026-08-07). When every
                    claimable fee sits on another network useClaimAll returns
                    before it ever starts — `running` never flips — so this
                    button was a dead click whose only account of itself was a
                    `title=` no touch device will ever show. A partial failure
                    was silent for the same reason: the ✓ beat is (rightly)
                    gated on failed === 0, which leaves nothing to say when some
                    failed. Same line the classic Earn card prints. */}
                {(tallyClaim.error || tallyClaim.skippedOtherChain > 0) && !tallyClaim.running && (
                  <p className="mt-2 font-mono text-[10px] leading-relaxed text-amber-300/85">
                    {tallyClaim.error ?? ''}
                    {tallyClaim.skippedOtherChain > 0
                      ? ` ${tallyClaim.skippedOtherChain} on another network — switch networks to claim those.`
                      : ''}
                  </p>
                )}
                <div
                  id="public-baskets-body"
                  className="grid transition-[grid-template-rows,opacity] duration-500 motion-reduce:transition-none"
                  style={{ gridTemplateRows: basketsOpen ? '1fr' : '0fr', opacity: basketsOpen ? 1 : 0 }}
                >
                <div className="overflow-hidden">
                {/* phones swipe these as a CAROUSEL, not a stack (the mobile
                    sweep) — UIGuy's shared rail; desktop keeps the grid via
                    its grid-at-breakpoint state */}
                <Carousel
                  label="Your public baskets"
                  gridFrom="sm"
                  gridClassName="gap-4 sm:grid-cols-2 xl:grid-cols-3"
                  peek="85%"
                  className="mt-6"
                >
                  {p.holdings.map((h) => {
                    const tvl = h.basket.aumUsd
                    const pendingFees = createdByBasket.get(`${h.basket.chainId}:${h.basket.address.toLowerCase()}`)
                    return (
                      <Link
                        key={`${h.basket.chainId}:${h.basket.address}`}
                        to={basketHref(h.basket)}
                        className="press group block rounded-2xl border border-white/10 bg-white/[0.02] p-4 transition-transform duration-500 hover:-translate-y-0.5 hover:border-white/25"
                        style={{ transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)' }}
                      >
                        <div className="flex items-center gap-3">
                          <BasketAvatar address={h.basket.address} symbol={h.basket.symbol} size={32} />
                          <span className="min-w-0 flex-1">
                            <span className="font-display text-sm font-bold text-ink">${showSymbol(h.basket.symbol)}</span>
                            <span className="ml-2 align-middle"><ChainBadge chainId={h.basket.chainId} /></span>
                          </span>
                          <span className="font-num text-sm tabular-nums text-ink-dim">{formatUsdCompact(h.valueUsd)}</span>
                        </div>
                        <div className="mt-3">
                          {(h.basket.top ?? []).length > 0 ? (
                            <BasketBento
                              items={(h.basket.top ?? []).map((t) => ({
                                symbol: t.symbol,
                                address: t.address,
                                chainId: h.basket.chainId,
                                weightPct: t.weightPct,
                              }))}
                              aspect={2.4}
                            />
                          ) : (
                            /* legs unreadable just now (an on-chain basket
                               always HAS legs, so an empty top is a failed
                               read, not a fact): words, never a blank panel
                               that reads as broken */
                            <div className="grid min-h-[96px] place-items-center rounded-xl border border-white/8 bg-white/[0.02] font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                              composition unreadable just now
                            </div>
                          )}
                        </div>
                        {/* what it holds, in words (owner: "each basket token
                            should show the assets within it and their %s so
                            people have a good idea of what that exposure
                            means") — the SAME component the reshape mode uses,
                            so the two can never disagree */}
                        <div className="mt-3 border-t border-white/8 pt-3">
                          <BasketContents
                            legs={(h.basket.top ?? []).map((t) => ({
                              symbol: t.symbol,
                              address: t.address,
                              chainId: h.basket.chainId,
                              weightPct: t.weightPct,
                            }))}
                            max={5}
                          />
                        </div>
                        {/* the basket's own facts (11:26): TVL always readable;
                            holders only where the chain's indexing supports it;
                            pending creator fees when any have accrued */}
                        <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-white/8 pt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                          <span>
                            TVL <span className="font-num text-[11px] font-semibold tabular-nums text-ink-dim">{tvl > 0 ? formatUsdCompact(tvl) : '—'}</span>
                          </span>
                          {h.basket.holdersCount != null && (
                            <span>
                              holders <span className="font-num text-[11px] font-semibold tabular-nums text-ink-dim">{h.basket.holdersCount}</span>
                            </span>
                          )}
                          {pendingFees != null && pendingFees > 0.005 && (
                            <span>
                              fees pending <span className="font-num text-[11px] font-semibold tabular-nums text-teal">${pendingFees.toFixed(2)}</span>
                            </span>
                          )}
                        </div>
                      </Link>
                    )
                  })}
                </Carousel>
                </div>
                </div>
              </div>
            </Shell>
          )}
          {/* the extension's detect-and-offer (SpecExt hand-off): a QUIET
              affordance, never a banner; absent marker = not installed; the
              card leads to the install page — the site itself installs
              nothing (Chrome killed inline install in 2018) */}
          {/* APPROVALS — wallet hygiene as a portfolio surface (~21:5x):
              live allowance reads for held tokens vs the product's known
              spenders, one-tap revoke. Self-hides when nothing stands. */}
          <ApprovalsPanel
            owner={effectiveAddress}
            held={
              // REAL wallets only (the depeg law, applied to reads): fixture
              // tokens and the preview identity's mock baskets don't exist
              // on-chain, so feeding them here produced 20 honest-but-noisy
              // "couldn't be checked" failures on the demo. The panel simply
              // doesn't exist until a real wallet connects.
              isConnected && address && address.toLowerCase() === (effectiveAddress ?? '').toLowerCase()
                ? [
                    ...addedHoldings
                      .filter((h) => !h.native && !h.fixture && h.usd != null && h.usd > 0)
                      .map((h) => ({ chainId: h.chainId, token: h.address as `0x${string}`, symbol: h.symbol })),
                    ...p.holdings.map((h) => ({
                      chainId: h.basket.chainId,
                      token: h.basket.address as `0x${string}`,
                      symbol: h.basket.symbol,
                    })),
                  ]
                : []
            }
          />
          {/* THE LENS OFFER IS GATED OFF (the owner 2026-08-06 12:18: "the
              extension is going to come later… hide anything about the lens
              on the site") — LENS_OFFER_ENABLED flips it back on when the
              extension ships; the detect half (lensInstalled) keeps reading
              so an installed lens still integrates silently. */}
          {LENS_OFFER_ENABLED && !lensInstalled && (
            <Link
              to="/extension"
              className="enter press flex h-12 items-center justify-center gap-2.5 rounded-2xl border border-dashed border-white/10 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint transition-colors hover:border-cyan/40 hover:text-cyan"
              style={{ '--enter-i': 4 } as CSSProperties}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.5" />
              </svg>
              watch this portfolio from your browser · get the Spectrum lens →
            </Link>
          )}
        </div>
      </div>

      {/* ── THE MOBILE DOCK (owner: "the left menu bar instead shows up as a
            bottom mobile bar that's beautiful") — portaled to body (the
            breakout wrapper is transformed; fixed inside it would trap), a
            floating glass pill above the shell's tab bar, safe-area aware ── */}
      {createPortal(
        <>
          {/* UIGuy's --intro-dock-clearance seam: while this dock is mounted the
              intro's scroller clears it. Media-scoped to the dock's own lg:hidden
              visibility — a bare :root set would sink the intro's centered content
              on desktop, where no dock shows; unmounted = unset = byte-identical. */}
          {/* --page-dock-pad: the shell's root padding adds this to its tab-bar
              clearance, so the LAST thing on the page (the footer, which lives
              outside this page) clears the floating dock too — it used to sit
              on the legal text at max scroll (mobile sweep 2026-08-06). */}
          <style>{'@media (max-width: 1023.98px){:root{--intro-dock-clearance:130px;--page-dock-pad:72px}}'}</style>
        <nav
          aria-label="Portfolio actions"
          className="fixed inset-x-0 z-40 flex justify-center px-4 lg:hidden"
          style={{ bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))' }}
        >
          <div className="flex items-center gap-1.5 rounded-full border border-white/12 bg-panel/90 p-1.5 shadow-[0_16px_48px_-16px_rgba(0,0,0,0.85)] backdrop-blur-xl">
            {hasPositions ? (
              <button
                type="button"
                onClick={() => setModeOpen(true)}
                className="spectral-btn press flex h-11 items-center gap-2 rounded-full px-5 font-display text-[12px] font-bold uppercase tracking-[0.1em] text-void"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M4 8h10M4 16h7" /><circle cx="17" cy="8" r="2.5" /><circle cx="14" cy="16" r="2.5" />
                </svg>
                Add · rebalance
              </button>
            ) : keepHref ? (
              <Link
                to={keepHref}
                className="spectral-btn press flex h-11 items-center gap-2 rounded-full px-5 font-display text-[12px] font-bold uppercase tracking-[0.1em] text-void"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M4 8h10M4 16h7" /><circle cx="17" cy="8" r="2.5" /><circle cx="14" cy="16" r="2.5" />
                </svg>
                Add · rebalance
              </Link>
            ) : null}
            {publishHref &&
              (hasPositions ? (
                <button
                  type="button"
                  onClick={() => setPublishOpen(true)}
                  aria-label="Publish your mix as a basket"
                  className="press grid h-11 w-11 place-items-center rounded-full text-ink-dim transition-colors hover:bg-white/[0.06] hover:text-cyan"
                >
                  <ActionIcon kind="publish" />
                </button>
              ) : (
                <Link
                  to={publishHref}
                  aria-label="Publish your mix as a basket"
                  className="press grid h-11 w-11 place-items-center rounded-full text-ink-dim transition-colors hover:bg-white/[0.06] hover:text-cyan"
                >
                  <ActionIcon kind="publish" />
                </Link>
              ))}
            <button
              type="button"
              onClick={() => setFeesOpen(true)}
              aria-label="Fees and claims"
              className="press grid h-11 w-11 place-items-center rounded-full text-ink-dim transition-colors hover:bg-white/[0.06] hover:text-cyan"
            >
              <ActionIcon kind="fees" />
            </button>
          </div>
        </nav>
        </>,
        document.body,
      )}

      {/* THE FIRST-VISIT TOUR — three spotlit beats over the real page, once
          ever (the welcome latch). Beats resolve their anchors live; a beat
          whose section is not on this book's page (no rebalance door on a
          bare book) skips itself. */}
      {tourOpen && (
        <FirstVisitTour
          onExit={() => {
            setTourOpen(false)
            // a forced replay (?tour=1) is a showroom — it never spends the
            // real first-visit latch
            if (!tourRequested) markWelcomed()
          }}
          beats={[
            {
              key: 'hero',
              anchor: () => document.getElementById('pf-hero'),
              title: 'This is your whole book',
              body: 'Every wallet you linked, every chain, one number. The curve is its history, and the total updates itself as markets move. Nothing here needs maintaining.',
            },
            {
              key: 'positions',
              anchor: () => document.getElementById('bento-grid'),
              title: 'Everything you hold, sized by weight',
              body: 'Each tile is a position, sized by its share of the book. Tap any tile to act on it: buy more, sell, or open its own page for the full story.',
            },
            {
              key: 'rebalance',
              anchor: () => document.getElementById('pf-rebalance'),
              title: 'Move weights, not positions',
              body: 'When you want the book to look different, press Rebalance: set the weights you want and it plans every trade for you. You review and sign, it does the legwork.',
            },
          ]}
        />
      )}

      {/* mode scope: GUEST_SCOPE until a real connect — the flow resolves
          guest, so a draft saved under the dev-preview address would arrive
          empty (PM audit 8); adoptGuestDraft carries it across the connect */}
      {modeOpen && hasPositions && (
        <PositionsMode
          positions={positionRows}
          lpRows={lpModeRows}
          scope={isConnected && address ? address : GUEST_SCOPE}
          bookOwner={effectiveAddress}
          initialTargets={seedTargets ?? undefined}
          initialNote={seedNote ?? undefined}
          initialFocusKey={modeFocusKey ?? undefined}
          onClose={() => {
            setModeOpen(false)
            setSeedTargets(null)
            setSeedNote(null)
            setModeFocusKey(null)
          }}
        />
      )}
      {publishOpen && hasPositions && (
        <PublishPicker
          positions={positionRows}
          scope={isConnected && address ? address : GUEST_SCOPE}
          bookOwner={effectiveAddress}
          onClose={() => setPublishOpen(false)}
        />
      )}
    </div>
  )
}
