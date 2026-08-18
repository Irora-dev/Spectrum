import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { RANGE_ORDERS_ENABLED } from '../../lib/config/features'
import { clearLandedLanes, loadLandedLanes, recordLandedLane } from '../../lib/spectrum/landed-lanes'
import { RANGE_ORDER_FEE_BPS } from '../../lib/spectrum/range-order'
import { useMinWidth } from '../../lib/motion'
import { ZEROEX_COMPOSE_ENABLED } from '../../lib/spectrum/portfolio-batcher'
import { realExecutionArming, walkthroughAllowed, type ExecutionArming } from '../../lib/spectrum/execution-arming'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../../lib/chain/chains'
import { isRetryableDetection } from '../../lib/pools'
import { formatUnits, parseEther } from 'viem'
import type { FundingAction } from '../../lib/spectrum/funding-plan'
import { resolveAsset } from '../launch/BasketBuilder'
import { ThesisRunOverlay } from '../thesis/ThesisRunOverlay'
import { RunBeam, RunProgressStyles } from '../run-progress'
import { seedThesisOf } from '../reshape/seed-plan'
import { listBasketsForChain } from '../../lib/spectrum/basket-data'
import { thesisRef } from '../../lib/spectrum/thesis-url'
import { loadThesisRun, runProgress } from '../../lib/spectrum/thesis-run'
import { preflightLegs, preflightWords, shouldPreflight, type LegFillVerdict } from '../../lib/spectrum/leg-preflight'
import { createProxyZeroExFetcher } from '../../lib/spectrum/zeroex-quote'
import { batcherFor } from '../../lib/spectrum/execution-arming'
import { changeHeldBy } from '../../lib/spectrum/change-attribution'
import { walletName } from '../../lib/spectrum/wallet-names'
import { shortAddr } from '../../lib/spectrum/format'
import { directSwapWrapperFor, swapWithFeeCall, wrapperFeeBpsFor } from '../../lib/spectrum/direct-swap-wrapper'
import { discoverDirectRoute, quoteAndComposeDirectSwap } from '../../lib/spectrum/direct-swap-lane'
import { DirectLegCard, type DirectLegSpec } from './DirectLegCard'
import { INTERFACE_TAG_ADDRESS } from '../../lib/config/operator'
import { bridgeRows, pollBridge } from '../../lib/spectrum/bridge-pending'
import { announceRunLanded, writeRunLanded } from '../../lib/spectrum/run-landed'
import { stepKeyOf, type RunStepState } from '../../lib/spectrum/execution-runner'
import { PublishBundleModal } from '../reshape/PublishBundleModal'
import { groupBundleDraft, isBundleDraft, type BundleGroup } from '../reshape/publish-bundle-model'
import { AssetLogo } from '../AssetLogo'
import { unifyAssets } from '../../lib/spectrum/asset-unify'
import { appendExec } from '../../lib/spectrum/exec-log'
import { vtName } from '../../lib/spectrum/view-transition'
import { InfoDot } from '../InfoDot'
import { useCopy } from '../../lib/use-copy'
import { formatUsdCompact } from '../../lib/spectrum/format'
import { applyChanges, exitCost, toPlanChanges, type PlanLeg } from '../../lib/spectrum/insights'
import { ASSET_THEMES } from '../../lib/spectrum/asset-categories'
import { demoCatalog } from '../../lib/spectrum/demo-catalog'
import { integerShares } from '../../lib/spectrum/publish-picks'
import { useWalletGroup } from '../../lib/spectrum/use-wallet-group'
import { useRawHoldings } from '../../lib/spectrum/use-raw-holdings'
import { LinkedWallets } from '../portfolio/LinkedWallets'
import { TrimBar } from '../TrimBar'
import { LimitTicket } from './LimitTicket'
import { classifyTier } from '../../lib/spectrum/market-tiers'
import { seedGuard } from '../../lib/spectrum/seed-guard'
import { useMarketData } from '../../lib/spectrum/use-market-tiers'
import {
  addTarget,
  advancePlan,
  assetKey,
  clearDraft,
  clearExec,
  compilePlan,
  DEFAULT_SEED_PCT,
  currentStep,
  emptyDraft,
  evenSplit,
  GUEST_SCOPE,
  loadDraft,
  MAX_ALLOCATION_ASSETS,
  normalizedTargets,
  planProgress,
  removeTarget,
  requestStop,
  retryStep,
  saveDraft,
  saveExec,
  savePortfolio,
  savePublished,
  setAmount,
  setIntent,
  batchFeeBpsFor,
  ZEROEX_TAKER_FEE_BPS,
  allInFeeBps,
  feePctLabel,
  channelExecutable,
  setChannel,
  setName,
  setSeedPct,
  setTargetWeight,
  SIMULATED,
  startPlan,
  weightSum,
  type AllocAsset,
  type AllocationDraft,
  type ExecutionChannel,
  type ExecutionPlan,
  type FlowIntent,
} from '../../lib/spectrum/allocation'
import { BatchComposeRefusal, feeCentsOfTotal } from '../../lib/spectrum/batcher'
import { PORTFOLIO_MAX_FEE_BPS } from '../../lib/spectrum/portfolio-batcher'
import { useExecutionRunner } from '../../lib/spectrum/use-execution-runner'
import {
  approvalsForFrom,
  buildRunReview,
  composePortfolioStepFor,
  legacyComposeRefusal,
  rebalanceRunInput,
  shownForFrom,
  walletCoverOfferFor,
  withPhaseDeadline,
  SELL_FLOOR_DRIFT_BPS,
  type PortfolioRunReview,
  type WalletCoverOffer,
} from '../../lib/spectrum/portfolio-run-wiring'
import { DEFAULT_SLIPPAGE_BPS } from '../../lib/spectrum/hook-data'
import { useSendTransaction, useSwitchChain } from 'wagmi'
import { DEFAULT_CHAIN_ID, settlementDecimalsFor } from '../../lib/chain/deployments'
import { fetchLifiQuote } from '../../lib/spectrum/lifi'
import { PRISM_CLAIM_CHAIN_ID, PRISM_V2_HOOK } from '../../lib/prism/claim'
import { encodePrismPoolSwap, quotePrismPool } from '../../lib/prism/pool'
import { failuresAsText, recordFailure } from '../../lib/spectrum/failure-log'
import { clientFor } from '../../lib/chain/rpc'
import { TradePrism } from '../TradePrism'
import { BridgeRunnerGame } from '../BridgeRunnerGame'
import { defaultComposeDeps, defaultMarketReader, settlementFor } from '../../lib/spectrum/portfolio-run-market'
import { nativeEthUsdOnChain } from '../../lib/pools/v4-usd'
import type { MarketRow } from '../../lib/spectrum/portfolio-run-wiring'
import { readThesisFunds } from '../../lib/spectrum/thesis-funding'
import { mergeCrossChainHits, searchTokens, type TokenHit } from '../../lib/spectrum/token-search'
import { BasketBento, type BentoItem } from '../BasketBento'
import { ChainBadge } from '../ChainBadge'
import { DoorCard, SceneBasketToken, SceneReweight } from './DoorCards'

// ─────────────────────────────────────────────────────────────────────────────
// THE PORTFOLIO FLOW — the owner's five stations (docs/allocator/PORTFOLIO-FLOW.md):
// choose → weight → review → execute, opened from the portfolio home. Braindead
// law: the user decides assets, weights, amount — never a chain. Honest law:
// networks appear as quiet facts, every number is real or labeled simulation,
// and a read that failed is never a verdict.
//
// Phase 1 runs the engine fully SIMULATED (plan → approve → confirming → done
// on timers, persisted + resumable). Real legs arrive in Phase 3; the SHAPE of
// the run — grouped by network, funding made visible, one row per action — is
// the product and is what the owner iterates on here.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
/** Kit accents, cycled — the allocation's segment palette (reuse, never new). */
const SEG = ['var(--color-cyan)', 'var(--color-violet-bright)', 'var(--color-magenta)', 'var(--color-amber)', 'var(--color-teal)']
const EASE = [0.32, 0.72, 0, 1] as const
/** Fixture gates DATA (demo catalog vs live search) — never truth-labels;
 *  those key off SIMULATED, which is a property of the engine itself. */
const fixtureMode = import.meta.env.VITE_DEV_FIXTURE === '1'

/** A network name that can never blank the app: operator builds legitimately
 *  ship a SUBSET of chains and `chainCfg` throws on the rest (PM review,
 *  blocking finding 2). */
/** The nav's own compact chain labels (NetworkToggle's LABEL map) — one
 *  vocabulary for a chain across the app. */
const NET_SHORT: Record<number, string> = { 1: 'ETH', 8453: 'BASE', 4663: 'RH' }
const netShort = (cid: number) => NET_SHORT[cid] ?? netName(cid)
const netName = (cid: number) => {
  try {
    return chainCfg(cid).name
  } catch {
    return `Network ${cid}`
  }
}

/** Tiny chain glyphs for the filter pills (owner 20:54: icons with a little
 *  color "just to break it up"). Robinhood rides the kit's brand green — say
 *  the word for yellow. */

// ── THE LIVE STEPPING's words (the owner 2026-08-15 0008: real-time feedback,
// never protocol vocabulary). Pure; the card renders exactly these. ─────────
function runStepWords(s: RunStepState, action?: FundingAction): string {
  // a transfer's words LEAD with what it carries and the route — the state
  // sentence follows, so "still traveling" can never read as destinationless
  const route =
    s.kind === 'bridge' && action?.kind === 'bridge'
      ? `$${(action.amountCents / 100).toLocaleString()} · ${netShort(action.fromChainId)} → ${netShort(action.toChainId)} — `
      : ''
  return route + runStepStateWords(s)
}
function runStepStateWords(s: RunStepState): string {
  switch (s.status) {
    case 'pending':
      return 'waiting its turn'
    case 'simulating':
      return s.kind === 'sell' ? 'quoting the sale…' : s.kind === 'bridge' ? 'quoting the route…' : 'previewing the buys…'
    case 'awaiting-signature':
      return 'in your wallet — confirm to send'
    case 'submitted':
      return s.kind === 'bridge' ? 'traveling — arrival can take several minutes' : 'confirming on-chain…'
    case 'done':
      return s.kind === 'sell' ? 'sold — proceeds landed as cash' : s.kind === 'bridge' ? 'arrived' : 'bought'
    case 'skipped':
      return 'skipped'
    case 'unresolved':
      return s.kind === 'bridge'
        ? 'still traveling — run this plan again once it arrives; nothing re-sends'
        : (s.message ?? 'outcome unknown — check the wallet’s activity, then the portfolio’s release panel')
    case 'failed':
      return s.message ?? 'failed — nothing further was sent'
  }
}

function ChainIcon({ chainId }: { chainId: number }) {
  if (chainId === 1)
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
        <path d="M8 1l4.5 7L8 10.6 3.5 8z" fill="#a48bff" />
        <path d="M8 11.8l4.5-2.6L8 15 3.5 9.2z" fill="#a48bff" opacity="0.55" />
      </svg>
    )
  if (chainId === 8453)
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="#4d8bff" />
        <rect x="2.4" y="7" width="8.6" height="2" rx="1" fill="#07070b" />
      </svg>
    )
  if (chainId === 4663)
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="#5ac53a" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
        <path d="M12.5 2.5c-4 0-8 3.5-9 11 5.5-.5 9-4 9.5-8" />
        <path d="M3.5 13.5c2.5-3 5.5-6 8-9" />
      </svg>
    )
  return null
}

// ── the channel checkout (blend spec, the owner-confirmed 2026-08-02): HOW the
// diff fills is the LAST question at review — market now · limit at your
// price · slices over time. One pipeline; the old standalone Execution card
// is retired. Non-executable channels render their true state and are never
// a dead confirm. Beginner guidance lives AT the choice (his 12:36 ask).
const CHANNELS: {
  id: ExecutionChannel
  label: string
  line: string
  state?: string
  info: string
}[] = [
  {
    id: 'market',
    label: 'Market buy',
    line: 'fills immediately',
    info: 'Fills now, at the market’s price, one batched transaction per network. The simple choice for small changes.',
  },
  {
    id: 'limit',
    label: 'Only at your price',
    line: 'limit · or never',
    // the "posting next" chip is RETIRED: posting is live on ETH and Base as of
    // this build, so the chip would now be describing a state we left behind.
    // The per-chain truth is carried by the gate itself — an unsupported chain
    // disables the card rather than captioning it.
    state: undefined,
    info: 'Each buy or sell fills only at your price or better, or it expires unfilled. Solver networks watch and fill it on-chain; closing this tab cannot kill an order, and cancel is one transaction. Legs fill independently, so your mix passes through in-between states. People use it when they would rather wait than overpay.',
  },
  {
    // THE CLOCK IS GONE, because there is no clock (UIGuy's measurement, relayed
    // with the owner's "limit is useful to include too, it's sort of three options
    // right?"). A real TWAP on this rail is a ComposableCoW conditional order
    // whose owner must be a forwarding CONTRACT: of 36 conditional-order owners
    // measured on Base, 29 were Safes, 6 other contracts and ZERO EOAs. Our
    // users are EOAs, so "timed pieces" and "takes hours by design" described a
    // mechanism they cannot have — a schedule we could not keep.
    //
    // What IS true is one mechanism with three outcomes: the same signed,
    // partially-fillable order, and where your price sits against the market
    // decides whether it fills now, fills in pieces as the market reaches you,
    // or waits. This card is that middle outcome, worded without a clock.
    id: 'slices',
    label: 'Work it in pieces',
    line: 'limit · fills as the market reaches you',
    state: 'set a price just above the market',
    info: 'The same order as “only at your price”, set just above where the market is now, so it fills in pieces as the market comes to you rather than all at once. Anything the market never reaches simply expires; that is the order doing what you asked, not a failure. Nothing here runs on a timer, and no part of it promises you a better price.',
  },
]

function ChannelGlyph({ id }: { id: ExecutionChannel }) {
  const common = { viewBox: '0 0 24 24', className: 'h-4 w-4 shrink-0', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (id === 'market')
    return (
      <svg {...common}><path d="M4 9h13M13 5l4 4-4 4" /><path d="M20 15H7M11 19l-4-4 4-4" /></svg>
    )
  if (id === 'limit')
    return (
      <svg {...common}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
    )
  return <svg {...common}><path d="M4 20v-6M10 20V10M16 20v-8M22 20V4" /></svg>
}

/** The channel row at review — Market selectable today; the rest true-state. */
function ChannelRow({ draft, onPick, owner }: { draft: AllocationDraft; onPick: (c: ExecutionChannel) => void; owner?: string }) {
  // THE PLAN'S CHAIN, for the now chain-aware gate (UIGuy: CoW has no code on
  // 4663 and every live basket is there). A plan can SPAN networks, so limit
  // qualifies only when EVERY leg could settle — one leg on an unsupported
  // chain and the order half-fills, which is worse than not offering it. Any
  // such leg yields undefined, and the gate fails closed on undefined.
  const planChains = [...new Set(draft.targets.map((t) => t.asset.chainId))]
  const gateChain = planChains.every((c) => channelExecutable('limit', c)) ? planChains[0] : undefined

  // THE LEG A LIMIT ORDER WOULD BE. A limit order is ONE pair, so this takes
  // the largest SELL the plan contains and pairs it with the largest ADD on the
  // same chain (falling back to the cash the plan credits). Only legs the
  // composer recorded an EXACT raw amount for qualify — a leg whose size had to
  // be guessed from dollars is not one we will sign.
  const limitLeg = useMemo(() => {
    const cs = draft.funding?.changes ?? []
    const sells = cs
      .filter((c) => c.sellRaw && c.decimals != null && c.toUsd < c.fromUsd)
      .sort((a, b) => b.fromUsd - b.toUsd - (a.fromUsd - a.toUsd))
    const sell = sells[0]
    if (!sell) return null
    const buy = cs
      .filter((c) => c.chainId === sell.chainId && c.toUsd > c.fromUsd && c.decimals != null)
      .sort((a, b) => b.toUsd - b.fromUsd - (a.toUsd - a.fromUsd))[0]
    if (!buy) return null
    return {
      chainId: sell.chainId,
      sellToken: sell.address as `0x${string}`,
      buyToken: buy.address as `0x${string}`,
      sellSymbol: sell.symbol,
      buySymbol: buy.symbol,
      sellDecimals: sell.decimals as number,
      buyDecimals: buy.decimals as number,
      sellAmountRaw: BigInt(sell.sellRaw as string),
    }
  }, [draft.funding])

  // a preset/persisted NON-executable channel never renders selected — the
  // engine executes market, and the label must never claim otherwise (PM
  // audit 4: the exact dead-confirm the doctrine forbids)
  const wanted: ExecutionChannel = draft.channel ?? 'market'
  const active: ExecutionChannel = channelExecutable(wanted, gateChain) ? wanted : 'market'
  // THE LIMIT CHANNELS ARE GATED TO COMING SOON (the owner 2026-08-06: "only at
  // your price and work in pieces we just have as coming soon… it's just a
  // bit too complicated" — market is the one live fill for launch). The
  // machinery stays built; this gate is presentation only, and the
  // executable gate underneath still fails closed exactly as before.
  const COMING_SOON = true
  return (
    <div className="mt-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">How it fills</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {CHANNELS.map((c) => {
          const gated = COMING_SOON && c.id !== 'market'
          const executable = !gated && channelExecutable(c.id, gateChain)
          const selected = active === c.id
          return (
            /* the ⓘ sits OUTSIDE the (possibly disabled) button: a disabled
               button's subtree is mouse-dead and button-in-button is invalid
               HTML (PM audit 7) */
            <div key={c.id} className="relative">
              <button
                type="button"
                disabled={!executable}
                aria-pressed={selected}
                onClick={() => onPick(c.id)}
                className={`press flex h-full w-full flex-col rounded-2xl border text-left transition-colors ${
                  c.id === 'market' ? 'p-5' : 'p-4'
                } ${
                  selected
                    ? 'border-cyan/60 bg-cyan/[0.08]'
                    : executable
                      ? 'border-white/12 bg-white/[0.02] hover:border-white/30'
                      : 'border-white/8 bg-white/[0.02] opacity-50'
                }`}
              >
                {/* the live channel speaks at reading size (the owner: "market
                    buy fills immediately… that text should be a bit larger,
                    make the symbol bigger") */}
                <span className={`flex items-center gap-2.5 ${selected ? 'text-cyan' : 'text-ink-dim'}`}>
                  <span className={c.id === 'market' ? 'scale-125' : undefined}>
                    <ChannelGlyph id={c.id} />
                  </span>
                  <span className={`font-display font-bold uppercase tracking-[0.1em] text-ink ${c.id === 'market' ? 'text-lg' : 'text-sm'}`}>
                    {c.label}
                  </span>
                </span>
                <span className={`mt-1 font-mono uppercase tracking-[0.12em] text-ink-faint ${c.id === 'market' ? 'text-[12px]' : 'text-[10px]'}`}>
                  {c.line}
                </span>
                {gated ? (
                  <span className="mt-2 inline-flex self-start rounded-full border border-white/15 bg-white/[0.04] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
                    coming soon
                  </span>
                ) : c.state ? (
                  <span className="mt-2 inline-flex self-start rounded-full border border-teal/30 bg-teal/[0.06] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-teal">
                    {c.state}
                  </span>
                ) : null}
              </button>
              <span className="absolute right-3 top-3">
                <InfoDot>{c.info}</InfoDot>
              </span>
            </div>
          )
        })}
      </div>

      {/* WAY less of this (owner 17:53: "the at-market/at-your-price/spread
          line and the first-time-here description — that's way too much
          information, way too much; remove it or make it far, far smaller as
          an insight"). The comparer line is GONE: it only restated the three
          card subtitles sitting directly above it. The explainer keeps the one
          fact a card subtitle cannot carry — where the order actually lives —
          and each card's ⓘ still holds its own mechanism in full. */}
      {/* THE TICKET — only when limit is the LIVE choice, so the price field
          can never appear for a channel that is not going to be used. It works
          the SELL legs of the plan: a limit order is one pair, and the rail
          does not route basket tokens (measured — a basket's only venue is a
          custom V4 hook with no visible liquidity). */}
      {active === 'limit' && owner && limitLeg && (
        <LimitTicket leg={limitLeg} owner={owner as `0x${string}`} />
      )}
      {active === 'limit' && owner && !limitLeg && (
        <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
          this plan has nothing to sell, so there is no price to set
        </p>
      )}

      {/* the orders-live-on-chain explainer + its Got-it are RETIRED
          (the owner 12:49: "this is just pointless") — each card's ⓘ still
          carries the mechanism in full */}
    </div>
  )
}

export type Station = 'choose' | 'weight' | 'outcome' | 'review' | 'execute'
const STATIONS: { id: Station; label: string }[] = [
  { id: 'choose', label: 'Choose' },
  { id: 'weight', label: 'Weight' },
  { id: 'outcome', label: 'Outcome' },
  { id: 'review', label: 'Review' },
  { id: 'execute', label: 'Execute' },
]

/** The demo catalog — real assets on their real networks (addresses are the
 *  chain truth; NVDA/AAPL come from the official stock registry). No depth or
 *  price numbers are invented here: in simulation the picker says "demo
 *  listing" instead of showing figures the chain hasn't confirmed. */
/** Theme lens for the filter pills (fixture browsing; live search results
 *  filter by network only — themes are a browsing aid, not chain truth).
 *  Single-sourced in asset-categories.ts since the 23:09 category pills: the
 *  portfolio/rebalance pills and this picker must agree on what "DeFi" is. */
const ASSET_TAGS: Record<string, 'defi' | 'ai' | 'memes' | 'stocks'> = ASSET_THEMES

/** The flow's example catalog — lives in demo-catalog.ts since the split's
 *  S7 (the picker was importing this whole component graph for one fixture
 *  list); imported for this flow's own use and re-exported so callers are
 *  unchanged. */
export { demoCatalog }

/** Outer shell + inner core (the forge's machined-hardware idiom). */
function Shell({ children, bare = false }: { children: ReactNode; bare?: boolean }) {
  // BARE: the host is already a panel (the rebalance popup). Nesting our card
  // inside theirs stacks three backgrounds for one surface — the owner: "why is
  // there two bg cards, just put the elements on the main bg."
  if (bare) return <>{children}</>
  return (
    <div className="rounded-[2rem] border border-white/10 bg-white/[0.03] p-1.5">
      <div className="relative overflow-hidden rounded-[calc(2rem-0.375rem)] bg-panel/70 shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)] backdrop-blur-md">
        <div
          aria-hidden
          className="h-1 w-full motion-reduce:[animation:none]"
          style={{ background: SPECTRAL, backgroundSize: '300% 100%', animation: 'spectrum-refract 16s ease-in-out infinite' }}
        />
        {children}
      </div>
    </div>
  )
}

function DemoChip() {
  // Keyed off the ENGINE, not the env — as long as the engine simulates, every
  // build says so, on every station (PM review, blocking finding 1).
  if (!SIMULATED) return null
  return (
    <span className="inline-flex items-center rounded-full border border-amber-300/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-300/90">
      Simulation · no funds move
    </span>
  )
}

/** The progress rail: one spectral thread burning through four stations. */
function Rail({ station }: { station: Station }) {
  const idx = STATIONS.findIndex((s) => s.id === station)
  return (
    <div className="mx-auto w-full max-w-[560px]">
      <div className="relative h-1 rounded-full bg-white/[0.07]">
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ background: SPECTRAL }}
          animate={{ width: `${(idx / (STATIONS.length - 1)) * 100}%` }}
          transition={{ duration: 0.6, ease: EASE }}
        />
        {STATIONS.map((s, i) => (
          <span key={s.id} className="absolute top-1/2 -translate-y-1/2" style={{ left: `calc(${(i / (STATIONS.length - 1)) * 100}% - 4px)` }}>
            {i === idx && (
              <span aria-hidden className="absolute -inset-2 animate-pulse rounded-full bg-cyan/40 blur-md" />
            )}
            <span
              className={`relative block h-2 w-2 rounded-full transition-colors duration-500 ${
                i <= idx ? 'bg-cyan shadow-[0_0_12px_var(--color-cyan)]' : 'bg-white/20'
              }`}
            />
          </span>
        ))}
      </div>
      {/* labels CENTRED over their own dot (owner 20:42) */}
      <div className="relative mt-3 h-4">
        {STATIONS.map((s, i) => (
          <span
            key={s.id}
            className={`absolute -translate-x-1/2 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-500 ${
              i === idx ? 'text-ink' : i < idx ? 'text-ink-dim' : 'text-ink-faint'
            }`}
            style={{ left: `${(i / (STATIONS.length - 1)) * 100}%` }}
          >
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** One pickable asset — a card, not a chip (owner 2026-08-01 17:14: the picker
 *  "really needs to be made absolutely beautiful").
 *  ⚠ CHAIN SHOWN since 2026-08-11 (the owner: "we should show the chain for each
 *  asset" — SUPERSEDES his 2026-08-01 "no chain shown anywhere"): with /create
 *  now publishing bundles, WHICH network a pick lives on decides whether the
 *  draft is a basket or a bundle, so the card says it up front. */
function AssetCard({ a, chosen, disabled, onPick, index }: { a: AllocAsset; chosen: boolean; disabled: boolean; onPick: () => void; index: number }) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled && !chosen}
      aria-pressed={chosen}
      className={`press enter group relative flex w-full items-center gap-4 overflow-hidden rounded-2xl border p-4 text-left transition-transform duration-500 disabled:cursor-not-allowed disabled:opacity-40 ${
        chosen ? 'border-cyan/50 bg-cyan/[0.08]' : 'border-white/10 bg-white/[0.02] hover:-translate-y-0.5 hover:border-white/25'
      }`}
      style={{ transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)', '--enter-i': Math.min(index, 12) } as CSSProperties}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full blur-2xl transition-opacity duration-500 ${
          chosen ? 'opacity-30' : 'opacity-0 group-hover:opacity-20'
        }`}
        style={{ background: 'var(--color-cyan)' }}
      />
      <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-base font-bold text-ink">${showSymbol(a.symbol)}</span>
        <span className="mt-1 flex items-center gap-2 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          <ChainBadge chainId={a.chainId} />
          {chosen ? 'added ✓' : 'tap to add'}
        </span>
      </span>
      <span
        className={`relative grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full border font-mono text-[14px] transition-colors ${
          chosen ? 'border-transparent text-void' : 'border-white/20 text-ink-faint group-hover:border-cyan/50 group-hover:text-cyan'
        }`}
      >
        {chosen && <span aria-hidden className="absolute inset-0" style={{ background: SPECTRAL }} />}
        <span className="relative">{chosen ? '✓' : '+'}</span>
      </span>
    </button>
  )
}

/** The weight station's add bar (desk 24: "a bar where you can type to add
 *  other assets") — the floating-results idiom: the card stays one row and
 *  the grid below never moves. Same search + cross-chain merge law as every
 *  other surface. */
function WeightAddBar({ taken, onAdd, disabled }: { taken: Set<string>; onAdd: (a: AllocAsset) => void; disabled: boolean }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<AllocAsset[]>([])
  const [busy, setBusy] = useState(false)
  // could-not-read ≠ empty (desk 224's pattern note): one chain failing must
  // only DEGRADE the merge, but EVERY chain failing is not "no market" — it
  // gets its own face instead of a false negative about the asset.
  const [unreachable, setUnreachable] = useState(false)
  useEffect(() => {
    const needle = q.trim()
    if (needle.length < 2) {
      setHits([])
      setBusy(false)
      setUnreachable(false)
      return
    }
    let stale = false
    setBusy(true)
    const t = window.setTimeout(() => {
      Promise.all(
        SUPPORTED_CHAIN_IDS.map((chainId) =>
          searchTokens(needle, chainId)
            .then((rows: TokenHit[]) => rows.map((h) => ({ h, chainId })))
            .catch(() => null),
        ),
      )
        .then((all) => {
          if (stale) return
          setUnreachable(all.every((rows) => rows === null))
          setHits(
            mergeCrossChainHits(all.filter((rows) => rows !== null).flat(), needle, 6).map(({ h, chainId }) => ({
              chainId,
              address: h.address,
              symbol: h.symbol,
              depthUsd: h.liquidityUsd,
            })),
          )
        })
        .finally(() => {
          if (!stale) setBusy(false)
        })
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [q])
  return (
    <div className="relative mt-3 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Add another</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && q.trim().length > 0) {
              e.stopPropagation()
              setQ('')
            }
          }}
          placeholder={disabled ? 'this mix is at the asset cap' : 'Search a ticker, or paste a contract address'}
          disabled={disabled}
          aria-label="Search a ticker to add"
          aria-expanded={q.trim().length >= 2}
          className="h-10 w-full min-w-0 flex-1 rounded-lg border border-white/12 bg-white/[0.03] px-3 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none disabled:opacity-50"
        />
      </div>
      {q.trim().length >= 2 && (
        <div className="absolute inset-x-0 top-full z-30 mt-2 rounded-2xl border border-white/12 bg-panel/95 p-3 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85)] backdrop-blur-xl">
          {busy && hits.length === 0 ? (
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint" role="status">
              searching every network…
            </p>
          ) : hits.length === 0 ? (
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              {unreachable ? 'couldn’t search any network — try again' : 'no routable market found'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {hits.map((a) => {
                const k = assetKey(a)
                const isTaken = taken.has(k)
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={isTaken}
                    onClick={() => {
                      onAdd(a)
                      setQ('')
                      setHits([])
                    }}
                    className="press inline-flex h-10 items-center gap-2 rounded-full border border-white/12 py-1 pl-1 pr-3 transition-colors hover:enabled:border-white/30 disabled:opacity-45"
                  >
                    <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={22} />
                    <span className="font-display text-sm font-bold text-ink">${showSymbol(a.symbol)}</span>
                    <ChainBadge chainId={a.chainId} />
                    <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">
                      {isTaken ? 'in the mix' : a.depthUsd != null ? formatUsdCompact(a.depthUsd) : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** THE PRESS-SCALE CLICK EATER, cured at the pointer level (the owner, 3rd live
 *  report 2026-08-14: Execute "still takes two attempts" + Run-for-real
 *  "nothing happens" — SURVIVING every code fix and hard reload, which ruled
 *  out staleness and pointed at the one constant: `.press:active{scale:.96}`.
 *  On pointerdown the button shrinks 4%; a press near the edge leaves the
 *  cursor OUTSIDE the shrunk bounds, mouseup retargets to the parent, and the
 *  click NEVER FIRES — reload-proof by construction). Capturing the pointer
 *  on pointerdown retargets the whole stream — click included — back to the
 *  button, whatever the scale does under the finger. Applied to the money
 *  buttons; the visual press is untouched. */
const capturePress = (e: { currentTarget: Element & { setPointerCapture?: (id: number) => void }; pointerId: number }) => {
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId)
  } catch {
    /* older engines without capture keep today's behavior */
  }
}

export function PortfolioFlow({
  address,
  walletUsd,
  onClose,
  onCreated,
  resumePlan,
  initialIntent,
  initialChannel,
  inline = false,
  chromeless = false,
  initialStation,
  onNeedConnect,
  onStation,
}: {
  address: string
  /** The wallet value the home band shows — the amount chips' reference. */
  walletUsd: number | null
  onClose: () => void
  onCreated: () => void
  /** A persisted mid-run execution to resume (loaded by the home band). */
  resumePlan?: ExecutionPlan | null
  /** Intent declared by the entry (a deep link or a seed): the outcome station
   *  is SKIPPED — picker-first law, the owner 20:26. */
  initialIntent?: FlowIntent
  /** Channel preset by the entry (?channel= URL-intent; blend spec). */
  initialChannel?: ExecutionChannel
  /** Render in the page (picker-first Create) instead of as an overlay. */
  inline?: boolean
  /** Mounted INSIDE a host panel that already supplies the card and the
   *  wayfinding (the rebalance popup). Drops our own card and the station
   *  rail — the owner: "remove the choose to execute bar here, it's not really
   *  needed, so everything else can be moved up". The SIMULATED chip stays:
   *  that one is an honesty label, not chrome. */
  chromeless?: boolean
  /** Resume at a given station (post-connect remount). */
  initialStation?: Station
  /** Guest mode hits Confirm → the page owns the connect beat. */
  onNeedConnect?: (resumeAt: Station) => void
  /** Which station the flow is on. A HOST that wraps the flow needs this: the
   *  rebalance popup must retire its "back to reshape" the moment the run
   *  starts, because going back unmounts the flow and would kill a run in
   *  flight (simulated today, signatures at Phase 3). */
  onStation?: (s: Station) => void
}) {
  const [diagCopied, setDiagCopied] = useState(false)

  const reduce = useReducedMotion()
  // the mobile sweep (2026-08-05): phone mounts read once, rotation reloads —
  // the chart-compact pattern; drives the outcome doors' compact size
  const isPhone = typeof window !== 'undefined' && window.innerWidth < 640
  const [station, setStation] = useState<Station>(resumePlan ? 'execute' : (initialStation ?? 'choose'))
  const isGuest = address.toLowerCase() === GUEST_SCOPE
  const [draft, setDraftState] = useState<AllocationDraft>(() => {
    let base = loadDraft(address) ?? emptyDraft()
    if (initialIntent) base = setIntent(base, initialIntent)
    if (initialChannel) base = setChannel(base, initialChannel)
    return base
  })
  const setDraft = (next: AllocationDraft) => {
    setDraftState(next)
    saveDraft(address, next)
  }

  // THE FUNDING BREAKDOWN FOLDS (the owner 2026-08-06 12:49 #15): collapsed it is
  // one line — what funds this plan and what you end up with — and the chevron
  // opens the legs in place. Closed by default: the review page's job is the
  // decision, and the legs are there for whoever wants to check the arithmetic.
  const [fundingOpen, setFundingOpen] = useState(false)

  // ── choose: search, paste, resolve ─────────────────────────────────────────
  // Phone: the search placeholder needs a shorter sentence (the long one hard-
  // cut mid-token at 390w). A hook, not a CSS trick — placeholder text is a
  // string, and CSS cannot choose between two of them.
  const phone = !useMinWidth(640)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [findError, setFindError] = useState<string | null>(null)
  const [found, setFound] = useState<AllocAsset | null>(null)
  const catalog = useMemo(demoCatalog, [])
  const [chainFilter, setChainFilter] = useState<number | 'all'>('all')
  const [catFilter, setCatFilter] = useState<'all' | 'defi' | 'ai' | 'memes' | 'stocks'>('all')
  const chosenKeys = useMemo(() => new Set(draft.targets.map((t) => assetKey(t.asset))), [draft])
  const needle = q.trim().toLowerCase()
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q.trim())
  const suggestions = useMemo(
    () =>
      catalog
        .filter((a) => !needle || a.symbol.toLowerCase().includes(needle))
        .filter((a) => chainFilter === 'all' || a.chainId === chainFilter)
        .filter((a) => catFilter === 'all' || ASSET_TAGS[a.symbol] === catFilter),
    [catalog, needle, chainFilter, catFilter],
  )
  const full = draft.targets.length >= MAX_ALLOCATION_ASSETS

  // LIVE type-to-search (the owner 18:41: "properly work with the rpc… type in any
  // asset") — the launch builder's own searchTokens, asked on EVERY network at
  // once and merged by real liquidity. Fixture mode keeps the demo catalog.
  const [liveHits, setLiveHits] = useState<AllocAsset[]>([])
  const [liveBusy, setLiveBusy] = useState(false)
  // could-not-read ≠ empty (desk 224's pattern note): every chain failing is
  // its own face below, never "nothing matches" — a false negative here tells
  // a creator their asset does not exist.
  const [liveUnreachable, setLiveUnreachable] = useState(false)
  useEffect(() => {
    if (fixtureMode || isAddr || needle.length < 2) {
      setLiveHits([])
      setLiveBusy(false)
      setLiveUnreachable(false)
      return
    }
    let stale = false
    setLiveBusy(true)
    const t = window.setTimeout(() => {
      Promise.all(
        SUPPORTED_CHAIN_IDS.map((chainId) =>
          searchTokens(q.trim(), chainId)
            .then((hits: TokenHit[]) => hits.map((h) => ({ h, chainId })))
            .catch(() => null),
        ),
      )
        .then((all) => {
          if (stale) return
          setLiveUnreachable(all.every((hits) => hits === null))
          // Same symbol on several networks → the shared cross-chain law
          // (mergeCrossChainHits): exact match pins, verified wins its
          // symbol, then the highest MARKET CAP takes the slot — liquidity
          // used to decide alone, and chains whose pairs measure 0 ETH-side
          // (Robinhood) lost to any same-ticker listing elsewhere.
          const merged = mergeCrossChainHits(all.filter((hits) => hits !== null).flat(), q, 12).map(({ h, chainId }) => ({
            chainId,
            address: h.address,
            symbol: h.symbol,
            depthUsd: h.liquidityUsd,
          }))
          setLiveHits(merged)
        })
        .finally(() => {
          if (!stale) setLiveBusy(false)
        })
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [q, needle, isAddr])

  const shown = fixtureMode
    ? suggestions
    : needle.length >= 2
      ? liveHits.filter((a) => chainFilter === 'all' || a.chainId === chainFilter)
      : suggestions

  // A pasted address resolves against EVERY network at once and the deepest
  // routable market wins — that is the "no chain specifics" law doing real
  // work. A detection that merely FAILED stays a retry, never a verdict.
  useEffect(() => {
    if (!isAddr) {
      setFound(null)
      setFindError(null)
      setBusy(false) // paste-then-edit left "Checking markets…" on forever (PM review)
      return
    }
    const raw = q.trim()
    if (fixtureMode) {
      const hit = catalog.find((a) => a.address.toLowerCase() === raw.toLowerCase())
      setFound(hit ?? null)
      setFindError(hit ? null : 'Not in the demo catalog; live lookups arrive with real wiring.')
      return
    }
    let stale = false
    setBusy(true)
    setFindError(null)
    Promise.all(
      SUPPORTED_CHAIN_IDS.map((chainId) =>
        resolveAsset(raw, chainId)
          .then((a) => ({ chainId, a }))
          .catch((e: unknown) => ({ chainId, err: e })),
      ),
    )
      .then(async (results) => {
        if (stale) return
        const hits = results.filter((r): r is { chainId: number; a: Awaited<ReturnType<typeof resolveAsset>> } => 'a' in r)
        if (hits.length > 0) {
          const best = hits.reduce((x, y) => ((y.a.depthUsd ?? 0) > (x.a.depthUsd ?? 0) ? y : x))
          setFound({
            chainId: best.chainId,
            address: best.a.address,
            symbol: best.a.symbol,
            venueLabel: best.a.venueLabel,
            depthUsd: best.a.depthUsd,
          })
          return
        }
        // A PASTED BASKET is a legal portfolio target (owner 2026-08-16:
        // "surely you can buy a basket from the portfolio system") — the
        // probe refuses it with the composer's anti-nesting code, but a
        // wallet holding a basket strands nothing. Resolve its identity from
        // the chain's own discovery list; the review carves it into the
        // bundle-buy lane.
        const basketErr = results.find(
          (r): r is { chainId: number; err: unknown } =>
            'err' in r && (r.err as { code?: string } | null)?.code === 'SPECTRUM_BASKET',
        )
        if (basketErr) {
          const list = await listBasketsForChain(basketErr.chainId).catch(() => [] as Awaited<ReturnType<typeof listBasketsForChain>>)
          if (stale) return
          const b = list.find((x) => x.address.toLowerCase() === raw.toLowerCase())
          if (b) {
            setFound({ chainId: b.chainId, address: b.address, symbol: b.symbol, venueLabel: 'the basket’s own mint', depthUsd: null })
            return
          }
        }
        const allRetryable = results.every((r) => 'err' in r && isRetryableDetection(r.err))
        setFound(null)
        setFindError(allRetryable ? 'Couldn’t check this asset right now; try again.' : 'No routable market found for this asset.')
      })
      .finally(() => {
        if (!stale) setBusy(false)
      })
    return () => {
      stale = true
    }
  }, [q, isAddr, catalog])

  const pick = (a: AllocAsset) => {
    if (chosenKeys.has(assetKey(a))) {
      setDraft(removeTarget(draft, a))
      return
    }
    setDraft(addTarget(draft, a))
    if (isAddr) {
      setQ('')
      setFound(null)
    }
  }

  // ── weight ─────────────────────────────────────────────────────────────────
  const norm = useMemo(() => normalizedTargets(draft), [draft])
  // THE GLIDE's new-side handles: the found book names its tiles by UNIFIED
  // asset id; here the same derivation names each unified group's DOMINANT
  // leg tile, so the browser morphs book tile -> station tile across the
  // route change. Non-dominant legs of a merged asset carry no name and
  // simply appear. (pct stands in for value: dominance is by share here.)
  const vtNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of unifyAssets(
      norm.map((t) => ({
        key: assetKey(t.asset),
        chainId: t.asset.chainId,
        address: t.asset.address,
        symbol: t.asset.symbol,
        valueUsd: t.pct,
      })),
    ))
      m.set(u.dominant.key, vtName(u.id))
    return m
  }, [norm])

  // ── THE BENTO WEIGHT STATION (desk 24, Ⓡ 08:45: "instead of investing…
  //    just SELECT THE WEIGHTS. And here we should actually have the bento
  //    grid EXACTLY like the reshape-your-portfolio popup: the grid, a bar to
  //    add other assets, and when you click one of the bento tiles you can
  //    reshuffle it"). Picture leads; the row editor stays as List. In the
  //    picture, weights are ALWAYS integer shares summing 100 (largest
  //    remainder), so the 100% gate is satisfied by construction.
  const [weightView, setWeightView] = useState<'picture' | 'list'>('picture')
  const [wDial, setWDial] = useState<string | null>(null)
  const [wDialing, setWDialing] = useState(false)
  const wDialTimer = useRef<number | null>(null)
  const markWDialing = () => {
    setWDialing(true)
    if (wDialTimer.current != null) window.clearTimeout(wDialTimer.current)
    wDialTimer.current = window.setTimeout(() => setWDialing(false), 220)
  }
  useEffect(
    () => () => {
      if (wDialTimer.current != null) window.clearTimeout(wDialTimer.current)
    },
    [],
  )
  /** Dial one asset's normalized share; the others scale proportionally and
   *  the whole set re-lands on exactly 100 (integer largest-remainder). */
  const setNormalizedPct = (key: string, pct: number) => {
    const capped = Math.min(97, Math.max(1, Math.round(pct)))
    const cur = norm
    const others = cur.filter((t) => assetKey(t.asset) !== key)
    const othersSum = others.reduce((t, x) => t + x.pct, 0)
    const values = cur.map((t) =>
      assetKey(t.asset) === key ? capped : othersSum > 0 ? (t.pct / othersSum) * (100 - capped) : (100 - capped) / Math.max(1, others.length),
    )
    const shares = integerShares(values)
    setDraft({
      ...draft,
      targets: draft.targets.map((t) => ({ ...t, weight: shares[cur.findIndex((c) => assetKey(c.asset) === assetKey(t.asset))] ?? t.weight })),
      updatedAt: Date.now(),
    })
  }
  /** Add an asset WITHOUT resetting custom weights (addTarget even-splits):
   *  the newcomer lands at ~5% and everyone else scales into the rest. */
  const addAssetPreserving = (asset: AllocAsset) => {
    if (draft.targets.some((t) => assetKey(t.asset) === assetKey(asset))) return
    if (draft.targets.length === 0) {
      setDraft(addTarget(draft, asset))
      return
    }
    const seed = Math.max(5, Math.round(100 / (norm.length + 1) / 2))
    const values = [...norm.map((t) => (t.pct / 100) * (100 - seed)), seed]
    const shares = integerShares(values)
    setDraft({
      ...draft,
      targets: [
        ...draft.targets.map((t) => ({ ...t, weight: shares[norm.findIndex((c) => assetKey(c.asset) === assetKey(t.asset))] ?? t.weight })),
        { asset, weight: shares[shares.length - 1] },
      ],
      // an added asset is not held — a holdings-backed publish degrades to
      // buy-shaped (same rule as addTarget; this path bypasses it)
      ...(draft.seedFrom ? { seedFrom: undefined } : {}),
      updatedAt: Date.now(),
    })
    setWDial(assetKey(asset).toLowerCase())
  }

  // ── MAJORS + LINKED WALLETS (desk 26 + 29): the connected group's top
  //    readable holdings seed a starting mix; reads take the GROUP, actions
  //    stay with the connected wallet (UIGuy's law, honored end to end).
  const isRealAddr = /^0x[0-9a-fA-F]{40}$/.test(address)
  const walletGroup = useWalletGroup(address)
  const majorsRaw = useRawHoldings(isRealAddr ? (walletGroup.isGroup ? walletGroup.addresses : address) : [])
  const majors = useMemo(() => {
    const rows = (majorsRaw.data?.holdings ?? []).filter((h) => h.usd != null && (h.usd as number) > 1)
    const inDraft = new Set(draft.targets.map((t) => assetKey(t.asset)))
    return [...rows]
      .sort((a, b) => (b.usd as number) - (a.usd as number))
      .filter((h) => !inDraft.has(`${h.chainId}:${h.address.toLowerCase()}`))
      .slice(0, 6)
  }, [majorsRaw.data, draft.targets])
  const seedFromMajors = () => {
    if (majors.length === 0) return
    const shares = integerShares(majors.map((h) => h.usd as number))
    setDraft({
      ...draft,
      targets: majors.map((h, i) => ({
        asset: { chainId: h.chainId, address: h.address, symbol: h.symbol },
        weight: shares[i],
      })),
      // a fresh majors mix replaces the picked set — the picker's marker
      // cannot describe it (same rule as addTarget)
      ...(draft.seedFrom ? { seedFrom: undefined } : {}),
      updatedAt: Date.now(),
    })
    setStation('weight')
  }
  /** How many networks this plan lands on — the batch count, and the test for
   *  whether naming the network on every row says anything at all. */
  const netCount = useMemo(() => new Set(norm.map((t) => t.asset.chainId)).size, [norm])

  // ── WHAT CHANGES (owner 17:53) ────────────────────────────────────────────
  // The review leads with the DIFF now. Both sides come from what the composer
  // RECORDED — `funding.before` and `funding.changes` — never from re-deriving
  // dollars out of the stored integer percentages, which invented moves on
  // positions the plan never touched. Display only; the money math still reads
  // the targets themselves.
  const beforeLegs: PlanLeg[] = useMemo(
    () =>
      (draft.funding?.before ?? []).map((b) => ({
        key: `${b.chainId}:${b.address.toLowerCase()}`,
        symbol: b.symbol,
        usd: b.usd,
      })),
    [draft.funding],
  )
  const changes = useMemo(
    () =>
      toPlanChanges(
        (draft.funding?.changes ?? []).map((c) => ({
          key: `${c.chainId}:${c.address.toLowerCase()}`,
          symbol: c.symbol,
          fromUsd: c.fromUsd,
          toUsd: c.toUsd,
          realizedUsd: c.realizedUsd,
        })),
      ),
    [draft.funding],
  )
  /** The exact after-picture: the before, with the recorded moves applied. Not
   *  re-derived from the stored percentages — that round-trip is what invented
   *  changes on untouched positions. */
  const afterLegs: PlanLeg[] = useMemo(() => applyChanges(beforeLegs, changes), [beforeLegs, changes])
  // Tier reads are fetched ONLY for a rebalance — with no before there is
  // nothing to compare, so a fresh /create build pays no query at all.
  const tierAssets = useMemo(
    () =>
      changes.length > 0
        ? [
            ...norm.map((t) => t.asset),
            ...(draft.funding?.before ?? []).map((b) => ({ chainId: b.chainId, address: b.address, symbol: b.symbol })),
          ]
        : [],
    [changes.length, norm, draft.funding],
  )
  const reviewMarket = useMarketData(tierAssets)
  /** Share of a side that sits in small caps and new tokens — his "your total
   *  risk goes up to this", served as the FACT it can honestly be. Null when
   *  no market cap reads, because a guess here would be the score his own
   *  facts-only rule bars. */
  const volatileShareOf = (legs: PlanLeg[]): number | null => {
    const total = legs.reduce((s, l) => s + l.usd, 0)
    if (total <= 0) return null
    let known = 0
    let vol = 0
    for (const l of legs) {
      const mcap = reviewMarket.get(l.key)?.mcapUsd
      if (mcap === undefined) continue
      known += l.usd
      const tier = classifyTier(l.symbol, mcap ?? null)
      if (tier === 'small' || tier === 'micro') vol += l.usd
    }
    // Most of the plan must be readable before the comparison means anything.
    if (known < total * 0.8) return null
    return (vol / total) * 100
  }
  const sum = weightSum(draft)
  const amount = draft.amountUsd
  // ── SEED GUARD (contracts' first-mint self-wreck, their RefusalGriefing
  //    suite): each leg's seed dollars checked against the leg's own deepest
  //    pool BEFORE the mint confirm. Market read is publish-only (the tier
  //    read's zero-cost-when-unused pattern); depth prefers the picker's own
  //    resolution and falls back to the review's live liquidity read —
  //    unreadable depth is a SAID warn, never silence. A block bars the mint
  //    unless explicitly overridden, and the override is tied to the exact
  //    verdict set it acknowledged: a consent captured against different
  //    verdicts is no consent (the displayed-vs-signed lesson class).
  const seedGuardAssets = useMemo(
    () => (draft.intent === 'publish' ? norm.map((t) => t.asset) : []),
    [draft.intent, norm],
  )
  const seedMarket = useMarketData(seedGuardAssets)
  const seedVerdicts = useMemo(() => {
    if (draft.intent !== 'publish') return []
    const pc = (draft.seedPct ?? DEFAULT_SEED_PCT) / 100
    const heldByKey = new Map((draft.seedFrom ?? []).map((r) => [`${r.chainId}:${r.address.toLowerCase()}`, r.heldUsd]))
    const verdicts = seedGuard(
      norm.map((t) => {
        const key = assetKey(t.asset)
        // holdings-backed: the row's own held value; new money: the typed
        // amount's share (no amount yet = no seed dollars yet, nothing to judge)
        const legUsd = heldByKey.size > 0 ? (heldByKey.get(key) ?? 0) : draft.amountUsd != null ? (draft.amountUsd * t.pct) / 100 : 0
        return {
          symbol: t.asset.symbol,
          seedUsd: legUsd * pc,
          depthUsd: t.asset.depthUsd ?? seedMarket.get(key)?.liquidityUsd ?? null,
        }
      }),
    )
    // ONE SENTENCE, SAID ONCE (the owner 2026-08-06: the could-not-read-depth
    // verdict "is shown twice"): the per-network split can carry one symbol
    // on two chains, and each leg earned its own identical sentence. An
    // identical reason is identical information — dedupe by the words.
    const seen = new Set<string>()
    return verdicts.filter((v) => {
      const key = v.reason ?? `${v.symbol}:${v.code}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [draft.intent, draft.seedPct, draft.seedFrom, draft.amountUsd, norm, seedMarket])
  const seedBlocks = seedVerdicts.filter((v) => v.severity === 'block')
  const seedBlockSig = seedBlocks.map((v) => `${showSymbol(v.symbol)}:${v.code}`).join('|')
  const [seedOverrideSig, setSeedOverrideSig] = useState<string | null>(null)
  const seedOverridden = seedBlockSig !== '' && seedOverrideSig === seedBlockSig
  // HOLDINGS-BACKED publish (the picker path): the money is what's already
  // held — no funding question exists on this path, so the weight station
  // states the held fact instead of asking "Pay with / Investing" (those are
  // new-money controls; loadDraft pins amountUsd to this sum).
  const heldSeed = useMemo(() => {
    const rows = draft.seedFrom
    if (!rows || rows.length === 0) return null
    return { usd: rows.reduce((t, r) => t + r.heldUsd, 0), count: rows.length }
  }, [draft.seedFrom])
  const [amountText, setAmountText] = useState(amount != null ? String(amount) : '')
  const [payWith, setPayWith] = useState<'auto' | 'USDC' | 'ETH'>('auto')
  // Export targets is the user's ONLY backup of a mix that lives on this device
  // alone, and it used to fire a bare clipboard write with no feedback either
  // way — so a denied or unavailable clipboard left them believing they had a
  // copy. The house hook flips `copied` only after the write resolves (QOL
  // round 2026-08-05 #6), which is exactly the guarantee this button needs.
  const { copied: targetsCopied, copy: copyTargets } = useCopy()
  const commitAmount = (text: string) => {
    setAmountText(text)
    const n = Number(text.replace(/[^0-9.]/g, ''))
    setDraft(setAmount(draft, Number.isFinite(n) && n > 0 ? n : null))
  }
  const chip = (frac: number) => {
    if (walletUsd == null) return
    const v = Math.floor(walletUsd * frac)
    setAmountText(String(v))
    setDraft(setAmount(draft, v))
  }

  // ── execute ───────────────────────────────────────────────────────────────
  // The simulated walk (timers) is the DEMO IDENTITY's walkthrough only. A
  // real wallet gets the ARMING VERDICT instead — armed, or a named refusal —
  // so the station never pretends to buy (the owner 2026-08-12: "…doesnt use the
  // demo, i need to be able to execute"). While the go-live interlock holds
  // the flags, the verdict is the honest blocked state, in words.
  const [computing, setComputing] = useState(false)
  const [arming, setArming] = useState<ExecutionArming | null>(null)
  // A persisted run resumes only for the walkthrough identity — a REAL wallet
  // must never resume a simulated walk as though it were its own money moving.
  const [plan, setPlanState] = useState<ExecutionPlan | null>(() =>
    resumePlan && walkthroughAllowed(address) ? resumePlan : null,
  )
  const setPlan = (p: ExecutionPlan) => {
    setPlanState(p)
    saveExec(address, p)
  }
  const savedRef = useRef(false)

  // ── THE REAL RUNNER (the wiring commit, the owner 2026-08-14: "do all the
  // wiring now"). Mounting is safe on every build: the runner refuses at the
  // door while SIMULATED (its law 7), and the engine choice is wired from
  // ZEROEX_COMPOSE_ENABLED so the flip commit only flips constants. The
  // armed review below is what the station RENDERS — shownFor mints from it,
  // which is the displayed-vs-signed brand's one honest place. ──
  const [runReview, setRunReview] = useState<PortfolioRunReview | null>(null)
  // Cash-funded rebalance: the cents this run draws from the book's cash
  // trims (rebalanceRunInput) — rendered as one quiet fact on the armed
  // review so the funding story is stated, never inferred.
  const [runCashDrawCents, setRunCashDrawCents] = useState(0)
  // THE BRIDGE WATCH (the owner 2026-08-15: "it didnt show any bridging process /
  // awaiting bridge / countdown / finalization"): a 1s tick keeps elapsed
  // honest while anything is in flight, and every 10th tick polls the
  // persisted transfer rows so ARRIVAL flips the card live — even after the
  // run itself ended partial. Arrival then offers the one-click continue.
  const [bridgeTick, setBridgeTick] = useState(0)
  const [bridgeArrivals, setBridgeArrivals] = useState<Record<string, bigint>>({})
  // BRIDGE CONSENT (the owner live 2026-08-15, "was never asked to bridge"): a
  // plan that composes transfers HOLDS for his choice — bridge, or rebuild
  // local-only. null = not yet asked / no bridges.
  const [bridgeChoice, setBridgeChoice] = useState<'bridge' | 'local' | null>(null)
  // THE WALLET-COVER DOOR (the owner live 2026-08-15, on the $PRISM refusal: "you
  // need to either deposit stables or trim another position like my eth in
  // wallet"): when a chain's buys refuse for money and the wallet's own native
  // ETH there can cover it, the refusal OFFERS the sale instead of dead-ending.
  // Offers are computed with the review (walletCoverOfferFor); an ACCEPTED
  // offer becomes a real native sale in the rebuilt review — the proven sell
  // lane, explicit consent, never silent.
  const [coverOffers, setCoverOffers] = useState<WalletCoverOffer[]>([])
  const [coverSells, setCoverSells] = useState<{ chainId: number; sellRaw: string }[]>([])
  // THE PRISM DIRECT LANE (owner ruling 2026-08-15: "we need to be able to
  // handle that leg ourselves without 0x and it needs to use the v4 pool" —
  // measured: 0x cannot route hooked v4 pools, its PRISM route runs v3).
  // PRISM legs are CARVED OUT at the review layer: the batch never budgets
  // their dollars and the money core never sees the leg; the card below fills
  // them DIRECT in PRISM's own pool through the existing trade machinery.
  const [directPrism, setDirectPrism] = useState<{ usdCents: number; ethAmount: string | null } | null>(null)
  const [directPrismOpen, setDirectPrismOpen] = useState(false)
  // THE GENERALIZED DIRECT-LANE LEGS (the owner 2026-08-17: LNOC/FWA buying
  // fixed for good) — legs the batch could not carry, carved BY THE USER'S
  // CLICK on a refusal/preflight door into their own wrapper transactions.
  // Keyed set; consent is the click, per leg, per review (cleared with the
  // carve states below on every arming change).
  const [directLegs, setDirectLegs] = useState<DirectLegSpec[]>([])
  const addDirectLeg = useCallback((leg: DirectLegSpec) => {
    setDirectLegs((prev) =>
      prev.some((p) => p.chainId === leg.chainId && p.asset.toLowerCase() === leg.asset.toLowerCase()) ? prev : [...prev, leg],
    )
  }, [])

  // THE MAIN BUTTON RUNS IT (owner 2026-08-15: "we should still facilitate the
  // execution direct from the main button, not needing to click buy from pool
  // as its own button"): once the run the user consented to reaches a terminal
  // state — or immediately, when the plan is PRISM-only — the direct pool buy
  // fires itself: fresh pool quote → floor at the house slippage → one wallet
  // prompt. The v4 POOL path only (his ruling: no 0x, no aggregator).
  const [directRun, setDirectRun] = useState<{ phase: 'idle' | 'quoting' | 'wallet' | 'confirming' | 'done' | 'failed'; hash?: string; note?: string }>({ phase: 'idle' })
  // THE BASKET DIRECT LANE (owner 2026-08-16: "surely you can buy a basket
  // from the portfolio system we have to allow for that"). Basket-token
  // targets are CARVED at the review layer exactly like PRISM — 0x cannot
  // route a basket token, and the anti-nesting law was written for baskets
  // INSIDE baskets, never for a wallet holding one — and they fill through
  // the REAL bundle-buy machinery (ThesisRunOverlay: pre-send simulation,
  // floors, bridges, refusal doors all ride). The overlay auto-opens after
  // the consented batch lands, or from the carved card's own button; its own
  // big button still holds the money consent, exactly as on the bundle page.
  // One basket per network per run — the thesis machine's own shape; a
  // second same-chain basket target keeps today's path and its refusal.
  const [directBaskets, setDirectBaskets] = useState<{ chainId: number; address: string; symbol: string; usdCents: number }[]>([])
  const [directBasketsOpen, setDirectBasketsOpen] = useState(false)
  const [directBasketsDone, setDirectBasketsDone] = useState(false)
  // …and the SELL side of the same lane (owner 2026-08-16: "basket sells
  // through the portfolio reshape — wire this up it needs to work too"):
  // basket TRIMS are carved out of the batch's changes BEFORE the funding
  // math (their proceeds land in the wallet, not in this batch, so they may
  // not fund adds), and each fills through the bundle machinery's own SELL
  // mode — fraction picker, floors and consent all the bundle page's.
  const [directBasketSells, setDirectBasketSells] = useState<{ chainId: number; address: string; symbol: string; freedUsd: number }[]>([])
  // SALES HELD BY ANOTHER LINKED WALLET (recording 1205): the run signs with
  // ONE wallet, so a trim of an asset the OTHER wallet holds cannot ride this
  // run — it partitions out BEFORE the funding math and renders as its own
  // named group ("signs with <wallet> — switch to it"), never a doomed step.
  // On the switch, the review rebuilds for the new signer and picks them up.
  const [otherWalletSells, setOtherWalletSells] = useState<{ chainId: number; symbol: string; owner: string; usd: number }[]>([])
  const [sellOverlayFor, setSellOverlayFor] = useState<null | { chainId: number; address: string; symbol: string }>(null)
  // THE CLOSE GUARD (flagged 2026-08-15, built on the next "any more qols"):
  // closing while the PRISM direct leg is mid-flight silently drops that leg —
  // money safe in the wallet, plan incomplete, nothing records it. Esc/✕ now
  // take TWO presses while it flies: the first says so, the second closes.
  const [closeArm, setCloseArm] = useState(false)
  const directStartedRef = useRef(false)
  const { sendTransactionAsync } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const runDirectPrism = useCallback(async () => {
    if (!directPrism?.ethAmount || directStartedRef.current) return
    directStartedRef.current = true
    try {
      setDirectRun({ phase: 'quoting' })
      const amountRaw = parseEther(directPrism.ethAmount)
      if (amountRaw <= 0n) throw new Error('this leg sizes to nothing readable')
      try {
        await switchChainAsync({ chainId: PRISM_CLAIM_CHAIN_ID })
      } catch {
        /* already there, or the wallet handles it at signing */
      }
      const out = await quotePrismPool(clientFor(PRISM_CLAIM_CHAIN_ID), 'buy', amountRaw)
      const minOut = (out * BigInt(10_000 - DEFAULT_SLIPPAGE_BPS)) / 10_000n
      if (minOut <= 0n) throw new Error('the pool quoted nothing for this size')
      const tx = encodePrismPoolSwap('buy', amountRaw, minOut)
      // THE FEE RAIL (owner 2026-08-16: fees must be kept on every lane
      // outside the batcher): when the chain's SpectrumDirectSwapWrapper is
      // seated, the SAME router calldata forwards through it — fee/8 to the
      // operator sink, 7/8 burned, floor measured on the wrapper's own delta.
      // Unseated → today's fee-less direct path, unchanged. ⚠ Native input
      // pays the fee ON TOP (the contract's exact-value law).
      const wrapped = swapWithFeeCall({
        chainId: PRISM_CLAIM_CHAIN_ID,
        sellToken: null,
        sellAmount: amountRaw,
        buyToken: PRISM_V2_HOOK,
        minBuyAmount: minOut,
        poolData: tx.data,
        // ⚠ the WRAPPER's rate, not the batcher's: 25 assumes 0x's own skim
        // inside the quote, and there is no 0x on this lane (the ruled fee
        // model, 2026-08-16 — this call undercharged at 25 until 2026-08-17)
        feeBps: wrapperFeeBpsFor(PRISM_CLAIM_CHAIN_ID),
        feeRecipient: INTERFACE_TAG_ADDRESS,
        nowSec: Math.floor(Date.now() / 1000),
      })
      const send = wrapped ?? tx
      setDirectRun({ phase: 'wallet' })
      const hash = await sendTransactionAsync({ to: send.to, data: send.data, value: send.value, chainId: PRISM_CLAIM_CHAIN_ID })
      setDirectRun({ phase: 'confirming', hash })
      await clientFor(PRISM_CLAIM_CHAIN_ID).waitForTransactionReceipt({ hash })
      setDirectRun({ phase: 'done', hash })
      // the direct lane joins the history like every other trade (owner
      // 2026-08-16: recent-transactions must show wrapper txs too)
      if (address && directPrism) {
        appendExec(address, {
          ts: Date.now(),
          kind: 'swap',
          totalUsd: directPrism.usdCents / 100,
          changes: [{ symbol: 'PRISM', deltaUsd: directPrism.usdCents / 100 }],
          simulated: false,
        })
      }
    } catch (e) {
      directStartedRef.current = false // a failure may retry
      setDirectRun({ phase: 'failed', note: e instanceof Error ? (e.message.split('\n')[0] ?? 'failed') : 'failed' })
    }
  }, [directPrism, sendTransactionAsync, switchChainAsync])

  // LEG PRE-FLIGHT VERDICTS (the dormant module, wired — owner's queue item):
  // keyed `${chainId}:${assetLower}`; only REFUSED verdicts render (unknown =
  // carry on, the module's own law). ⚠ HONEST SCOPE, stated where the wiring
  // lives: this probe is QUOTE-LEVEL (0x asked as the BATCHER at the leg's
  // exact size) — it catches route-dead and refused-at-size legs before
  // consent, but the batcher-vs-user SIM-ONLY class (the LNOC saga) is not
  // catchable pre-consent without the wrapper migration; a probe that cannot
  // fail is not evidence, so none is faked here.
  const [preflightMap, setPreflightMap] = useState<Map<string, LegFillVerdict>>(new Map())
  // THE POPUP SURVIVES A WALLET SWITCH (recording 1205: "keep the pop up
  // visible and loaded while they swap wallets"): the mount stays; what a
  // switch invalidates is the PLAN, which was funded and partitioned for the
  // OLD signer. A standing (idle/terminal) review clears and rebuilds for
  // the new signer — picking up the sales that named it. A RUNNING run is
  // never cleared: the runner's own per-step account law already refuses
  // cross-account steps, and its state is the user's receipt.
  const prevSignerRef = useRef<string | undefined>(address)
  useEffect(() => {
    if (prevSignerRef.current === address) return
    prevSignerRef.current = address
    const ph = runner.state?.phase
    if (ph === 'running') return
    runner.clear()
    autoRanRef.current = null
    setRunReview(null)
    setRunReviewError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])
  // stale covers must never ride a NEW plan: any arming change clears them
  const coverArmRef = useRef<unknown>(null)
  useEffect(() => {
    if (coverArmRef.current === arming) return
    coverArmRef.current = arming
    setCoverSells([])
    setCoverOffers([])
    setDirectPrism(null)
    setDirectPrismOpen(false)
    setDirectRun({ phase: 'idle' })
    setDirectLegs([])
    setCarveTurn(0)
    setDirectBaskets([])
    setDirectBasketsOpen(false)
    setDirectBasketsDone(false)
    setDirectBasketSells([])
    setSellOverlayFor(null)
    setOtherWalletSells([])
    setPreflightMap(new Map())
    directStartedRef.current = false
  }, [arming])
  // fire the probes once the review stands — thin required legs only
  // (shouldPreflight's gate), concurrent, bounded by the module's timeout;
  // verdicts land as they answer and never block the review
  useEffect(() => {
    if (!runReview) return
    const probes = runReview.chains.flatMap((c) =>
      c.legs
        .filter((l) => shouldPreflight({ thinMarket: l.thinMarket, optional: l.optional }))
        .map((l) => ({ chainId: c.chainId, fundingAsset: c.fundingAsset, symbol: l.symbol, asset: l.asset, sellAmountRaw: BigInt(l.budgetRaw), swapData: '0x' })),
    )
    if (probes.length === 0) return
    let dead = false
    const fetchQuote = createProxyZeroExFetcher()
    void (async () => {
      for (const p of probes) {
        const batcher = batcherFor(p.chainId)
        if (!batcher) continue
        const verdicts = await preflightLegs([p], async (leg) => {
          await fetchQuote({
            chainId: p.chainId,
            sellToken: p.fundingAsset,
            buyToken: leg.asset as `0x${string}`,
            sellAmountRaw: leg.sellAmountRaw,
            taker: batcher,
          })
        })
        if (dead) return
        setPreflightMap((prev) => {
          const next = new Map(prev)
          for (const [k, v] of verdicts) next.set(`${p.chainId}:${k}`, v)
          return next
        })
      }
    })()
    return () => {
      dead = true
    }
  }, [runReview])
  // ONE start per built review — the auto-run's guard (his 00:08 + tonight:
  // "after execute it just should go to buys" — no second confirm button).
  const autoRanRef = useRef<unknown>(null)
  // steps that LANDED before a retry-from-failed-step (audit 2026-08-16):
  // runner.clear() wipes state, so without this snapshot every completed
  // card visually reverted to "runs first" mid-retry — the screen told the
  // user their landed transactions were discarded. Display-only carry;
  // cleared whenever a FRESH review is built (setRunReview(null) paths).
  const landedStepsRef = useRef<Map<string, RunStepState>>(new Map())
  const [runReviewError, setRunReviewError] = useState<string | null>(null)
  // SYNCHRONOUS click feedback: the instant Run-for-real is pressed this goes
  // true, BEFORE any await — so no downstream hang (a stalling wallet
  // provider, a slow first simulate) can ever render as "nothing happened"
  // (the owner's exact words, twice, 13:09 + 13:19).
  const [runStarting, setRunStarting] = useState(false)
  // the run's own clock — the armed card must NEVER be silent after a click
  // (the owner, 4th live report: "IMPOSSIBLE to tell if it's doing something").
  // Set synchronously with runStarting; the ticker renders elapsed seconds so
  // a slow first quote reads as WAITING, never as dead.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState(0)
  useEffect(() => {
    if (runStartedAt == null) return
    const t = window.setInterval(() => setNowTick((v) => v + 1), 1000)
    return () => window.clearInterval(t)
  }, [runStartedAt])
  void nowTick
  // what the build is doing RIGHT NOW — a skeleton with no words taught a
  // live user "something's broken" (13:09 recording); each phase names itself
  const [runReviewPhase, setRunReviewPhase] = useState<string>('')
  // PER-LEG PROTECTION OVERRIDES (the owner 2026-08-17: "the user to override
  // the slippage settings… no protection to get it across the line"). Keyed
  // `${chainId}:${assetLower}`; consent is PER-RUN — cleared with every fresh
  // review, never persisted (a sticky no-floor default would be a footgun).
  const [floorOverrides, setFloorOverrides] = useState<Record<string, number | 'none'>>({})
  const floorOverridesRef = useRef(floorOverrides)
  floorOverridesRef.current = floorOverrides
  const runReviewRef = useRef<PortfolioRunReview | null>(null)
  runReviewRef.current = runReview
  // per-chain native-USD read at review build — the runner's refuel sizing
  // reads it synchronously (null = unreadable, never zero)
  const nativeUsdRef = useRef<Map<number, number>>(new Map())
  const runner = useExecutionRunner({

    // the legacy engine has no seated contract anywhere and this surface
    // arms the portfolio engine — never a silent stub if ever selected
    composeStep: () => legacyComposeRefusal(),
    composePortfolioStep: (step) => {
      const review = runReviewRef.current
      if (!review || !address)
        return Promise.reject(new BatchComposeRefusal('the review this run was confirmed from is gone — re-open the review'))
      return composePortfolioStepFor(review, address as `0x${string}`, {
        ...defaultComposeDeps(),
        // the review screen's per-leg protection consents overlay the frozen
        // review at compose time (chosen AFTER the review was built)
        floorOverridesFor: (cid) => {
          const out: Record<string, number | 'none'> = {}
          for (const [k, v] of Object.entries(floorOverridesRef.current)) {
            const [c, asset] = k.split(':')
            if (Number(c) === cid) out[asset] = v
          }
          return Object.keys(out).length > 0 ? out : undefined
        },
      })(step)
    },
    engine: ZEROEX_COMPOSE_ENABLED ? 'portfolio' : 'legacy',
    // THE SALE STEP'S WRAPPER LANE, armed EXPLICITLY (its presence-gate law):
    // sells whose route ends in settlement ride the fee wrapper first — 40
    // bps, 100% burn — and every lane refusal falls through to the routed
    // lanes unchanged (owner 2026-08-17: sells pay the product fee too).
    directLane: { discover: discoverDirectRoute, quoteAndCompose: quoteAndComposeDirectSwap },
    nativeUsd: (cid) => nativeUsdRef.current.get(cid) ?? null,
    shownFor: (step) => {
      const review = runReviewRef.current
      return review && address ? shownForFrom(review, address as `0x${string}`)(step) : null
    },
    approvalsFor: (step) => {
      const review = runReviewRef.current
      return review ? approvalsForFrom(review)(step) : []
    },
    logShape: {
      kind: 'rebalance',
      totalUsd: draft.amountUsd ?? null,
      // the LIVE review's ends, read at write time (the getter form): buys as
      // positive leg budgets, sales as negative estimates — what makes a
      // batcher run visible in recent-transactions (owner 2026-08-16)
      changes: () => {
        const review = runReviewRef.current
        if (!review) return undefined
        const rows = [
          ...review.chains.flatMap((c) => c.legs.map((l) => ({ symbol: l.symbol, deltaUsd: l.budgetUsdCents / 100 }))),
          ...review.sells.map((s) => ({ symbol: s.symbol, deltaUsd: -(s.estCents / 100) })),
        ].filter((r) => Math.abs(r.deltaUsd) > 0.005)
        return rows.length > 0 ? rows : undefined
      },
    },
  })
  // ⚠ CAPTURE EVERY REFUSAL AS IT HAPPENS, not when someone thinks to press a
  // button. The 2026-08-15 diagnosis cost an evening and five failed
  // reproductions because each occurrence's state was discarded; the paste that
  // finally solved it existed at every one of them. Keyed to the step messages
  // so one refusal records once, not once per render.
  const loggedRef = useRef<string>('')
  useEffect(() => {
    if (runner.state?.phase !== 'refused') return
    const msgs = (runner.state.steps ?? []).map((x) => x.message).filter(Boolean)
    const key = msgs.join('|')
    if (!key || loggedRef.current === key) return
    loggedRef.current = key
    recordFailure({
      at: new Date().toISOString(),
      surface: 'portfolio run',
      signer: address ?? null,
      chainId: runReview?.chains?.[0]?.chainId ?? null,
      message: String(msgs[0] ?? ''),
      detail: {
        phase: runner.state.phase,
        chains: (runReview?.chains ?? []).map((c) => ({
          chainId: c.chainId,
          grossCents: c.grossCents,
          fundingTotalRaw: c.fundingTotalRaw,
          legs: c.legs.map((l) => ({ symbol: l.symbol, asset: l.asset, budgetRaw: l.budgetRaw, toleranceBps: l.toleranceBps, optional: l.optional })),
          refusals: c.refusals,
        })),
        steps: (runner.state.steps ?? []).map((x) => ({ key: x.key, status: x.status, message: x.message ?? null })),
        notes: runner.state.notes ?? [],
      },
    })
  }, [runner.state, runReview, address])
  // THE LANDING WRITES ITSELF AT DONE (the owner live 2026-08-18: "run
  // completing doesn't have a pop up with success… and you don't see the
  // change in the bento"). The write lived ONLY inside one button's onClick —
  // every other way out of this flow lost the landing whole. Now done/partial
  // WRITES the landing (announce: false — storage only; the announce fires
  // when this flow actually leaves the screen, below, so a same-page
  // portfolio never spends it behind the overlay). Once per run.
  const landedWroteRef = useRef<unknown>(null)
  useEffect(() => {
    const ph = runner.state?.phase
    if ((ph !== 'done' && ph !== 'partial') || !runReview || landedWroteRef.current === runner.state) return
    landedWroteRef.current = runner.state
    const changed = new Set<string>()
    for (const c of draft.funding?.changes ?? []) {
      if (Math.abs(c.toUsd - c.fromUsd) > 0.5) changed.add(`${c.chainId}:${c.address.toLowerCase()}`)
    }
    for (const ch of runReview.chains) for (const l of ch.legs) changed.add(`${ch.chainId}:${l.asset.toLowerCase()}`)
    for (const sale of runReview.sells) changed.add(`${sale.chainId}:${sale.asset.toLowerCase()}`)
    writeRunLanded([...changed], [], { announce: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.state?.phase, runReview])
  // …and ANNOUNCES when the flow leaves the screen — the first moment the
  // picture is visible. Unmount covers every exit path (the ✕, Escape, the
  // backdrop, the button, an inline station change); a mounted portfolio
  // hears it then, a navigation reads storage at mount instead.
  useEffect(() => () => announceRunLanded(), [])
  // THE CARVE QUEUE (the owner 2026-08-18: "it should just happen auto as
  // part of the flow"): once the batch attempt is terminal, carved legs run
  // themselves one at a time — sequential because each is its own wallet
  // prompt, and a refused leg advances the queue rather than stalling it.
  const [carveTurn, setCarveTurn] = useState(0)
  const carveArmed = runner.state?.phase === 'done' || runner.state?.phase === 'partial' || runner.state?.phase === 'refused'
  // ROUTE-CLASS AUTO-CARVES — the machine's decision, never a door:
  // (a) a batch step failing with a NAMED leg (RequiredLegFailed at sim or on
  //     chain — the aggregator refusing the batcher-as-taker at size, the
  //     class the preflight's own honest-scope note says it cannot catch);
  useEffect(() => {
    const steps = runner.state?.steps
    const review = runReviewRef.current
    if (!steps || !review) return
    for (const stp of steps) {
      if (stp.status !== 'failed' || stp.failedLegIndex == null) continue
      const m = /^batch:(\d+):/.exec(stp.key)
      if (!m) continue
      const chain = review.chains.find((ch) => ch.chainId === Number(m[1]))
      const leg = chain?.legs[stp.failedLegIndex]
      if (chain && leg) addDirectLeg({ chainId: chain.chainId, asset: leg.asset, symbol: leg.symbol, usdCents: leg.budgetUsdCents })
    }
  }, [runner.state, addDirectLeg])
  // (b) a preflight verdict of REFUSED — the quote-level probe already asked
  //     the aggregator AS the batcher at the leg's exact size and was told no.
  useEffect(() => {
    const review = runReviewRef.current
    if (!review) return
    for (const ch of review.chains)
      for (const l of ch.legs) {
        if (preflightMap.get(`${ch.chainId}:${l.asset.toLowerCase()}`)?.kind === 'refused')
          addDirectLeg({ chainId: ch.chainId, asset: l.asset, symbol: l.symbol, usdCents: l.budgetUsdCents })
      }
  }, [preflightMap, addDirectLeg])
  // BASKET SELLS OPEN THEMSELVES (the owner 2026-08-18: no routing doors —
  // and his STONKMEME trim carved into a card while the emptied run said
  // "complete", a dead end wearing a button). When the run settles — or the
  // whole plan carved out and there is nothing to run — the first carved
  // sell's overlay raises itself; finishing one opens the next.
  useEffect(() => {
    if (directBasketSells.length === 0 || sellOverlayFor) return
    const ph = runner.state?.phase
    const planEmpty = !!runReview && runReview.plan.steps.length === 0
    if (ph === 'done' || ph === 'partial' || ph === 'refused' || planEmpty) setSellOverlayFor(directBasketSells[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.state?.phase, directBasketSells, sellOverlayFor, runReview])
  // fire the PRISM direct leg after the consented run lands (done/partial);
  // a refused run keeps the manual door — nothing cascades off a refusal
  useEffect(() => {
    if (!directPrism || directRun.phase !== 'idle') return
    const ph = runner.state?.phase
    if (ph === 'done' || ph === 'partial') void runDirectPrism()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.state?.phase, directPrism, directRun.phase])
  // ONE BUTTON DRIVES EVERY LANE (owner 2026-08-16: "buy the basket now …
  // should literally just be on the running button so its one button you use
  // for the entire batcher system"): after the consented batch lands the
  // PRISM leg fires itself, and after PRISM settles the basket run opens
  // itself — done OR failed, because a failed PRISM leg keeps its own retry
  // and must not strand the baskets behind it. With no PRISM leg the baskets
  // open straight off the batch; the card's button remains as a re-open door.
  useEffect(() => {
    if (directBaskets.length === 0 || directBasketsOpen || directBasketsDone) return
    if (directPrism) {
      if (directRun.phase === 'done' || directRun.phase === 'failed') setDirectBasketsOpen(true)
      return
    }
    const ph = runner.state?.phase
    if (ph === 'done' || ph === 'partial') setDirectBasketsOpen(true)
  }, [runner.state?.phase, directBaskets, directBasketsOpen, directBasketsDone, directPrism, directRun.phase])
  // Armed → build the run review: the wallet's measured funds + one market
  // read per leg → the funding plan + the exact rows this station renders.
  // Every failure is a sentence on screen, never a silent empty state.
  useEffect(() => {
    if (!arming?.armed || runReview || runReviewError || !address) return
    let dead = false
    ;(async () => {
      try {
        // A REBALANCE draft carries the composer's exact per-leg ends, and
        // cash-funded buys run TODAY (rebalanceRunInput — the owner live
        // 2026-08-14: "i had usdc/cash in the book??" — trimming the
        // settlement asset IS the funding; only real swap-sells wait). A
        // blocked shape surfaces ITS one true sentence, before any network
        // read is spent on a plan that cannot compose.
        // THE BASKET-SELL CARVE runs BEFORE the funding math (owner
        // 2026-08-16: "basket sells through the portfolio reshape — wire this
        // up it needs to work too"). A basket trim cannot ride the batch (0x
        // cannot route a basket token), so it fills through the bundle
        // machinery's own SELL mode instead — and because its proceeds land
        // in the WALLET, not in this batch, it must leave the changes before
        // rebalanceRunInput, or the plan would fund adds with money the batch
        // never receives.
        const changeRows = (draft.funding?.changes ?? []).map((c) => ({
          chainId: c.chainId,
          address: c.address,
          symbol: c.symbol,
          fromUsd: c.fromUsd,
          toUsd: c.toUsd,
          sellRaw: c.sellRaw,
          decimals: c.decimals,
        }))
        const foreignTrims: { chainId: number; symbol: string; owner: string; usd: number }[] = []
        let keptChanges = changeRows
        if (changeRows.some((c) => c.toUsd < c.fromUsd)) {
          const sellChainIds = [...new Set(changeRows.map((c) => c.chainId))]
          const sellBasketSets = new Map<number, Set<string>>()
          for (const cid of sellChainIds) {
            const list = await listBasketsForChain(cid).catch(() => [] as Awaited<ReturnType<typeof listBasketsForChain>>)
            sellBasketSets.set(cid, new Set(list.map((b) => b.address.toLowerCase())))
          }
          if (dead) return
          const isBasketTrim = (c: (typeof changeRows)[number]) =>
            c.toUsd < c.fromUsd && sellBasketSets.get(c.chainId)?.has(c.address.toLowerCase()) === true
          const trims = changeRows.filter(isBasketTrim)
          keptChanges = changeRows.filter((c) => !isBasketTrim(c))
          // THE TRIM RIDES THE WALLET THAT HOLDS IT (the owner live 2026-08-18:
          // the STONKMEME sell overlay answered "nothing sellable" — the plan
          // saw the GROUP's holding, the overlay reads the ACTIVE signer's
          // balance, and the trim never went through the other-wallet
          // partition the batch sells get). Same attribution, same card.
          {
            const me = (address as string).toLowerCase()
            const mineTrims: typeof trims = []
            for (const c of trims) {
              const saleUsd = Math.max(0, c.fromUsd - c.toUsd)
              const held = changeHeldBy(c.chainId, c.address)
              const mine = held?.find((h) => h.owner.toLowerCase() === me)?.usd ?? 0
              const biggest = held?.[0]
              if (!held || mine + 1 >= saleUsd || !biggest || biggest.owner.toLowerCase() === me) mineTrims.push(c)
              else foreignTrims.push({ chainId: c.chainId, symbol: c.symbol, owner: biggest.owner, usd: saleUsd })
            }
            setDirectBasketSells(
              mineTrims.map((c) => ({ chainId: c.chainId, address: c.address, symbol: c.symbol, freedUsd: Math.max(0, c.fromUsd - c.toUsd) })),
            )
          }
        } else {
          setDirectBasketSells([])
        }
        // THE OTHER-WALLET PARTITION (recording 1205): a sale whose asset the
        // ACTIVE wallet cannot cover — per the reshape's own attribution —
        // leaves this run's changes and joins the named group instead. No
        // attribution = today's behavior exactly (the sim stays the judge).
        {
          const me = (address as string).toLowerCase()
          const foreign: { chainId: number; symbol: string; owner: string; usd: number }[] = []
          keptChanges = keptChanges.filter((c) => {
            const saleUsd = c.fromUsd - c.toUsd
            if (saleUsd <= 0.5) return true // buys and no-ops always ride
            const held = changeHeldBy(c.chainId, c.address)
            if (!held) return true
            const mine = held.find((h) => h.owner.toLowerCase() === me)?.usd ?? 0
            if (mine + 1 >= saleUsd) return true // the signer covers it (±$1 read noise)
            const biggest = held[0]
            if (!biggest || biggest.owner.toLowerCase() === me) return true
            foreign.push({ chainId: c.chainId, symbol: c.symbol, owner: biggest.owner, usd: saleUsd })
            return false
          })
          setOtherWalletSells([...foreignTrims, ...foreign])
        }
        const reb = draft.funding
          ? rebalanceRunInput({
              // sellRaw/decimals ride through: a trim with the composer's
              // exact raw size becomes a REAL sale (the sell wiring pass)
              changes: keptChanges,
              netNewUsd: draft.amountUsd ?? 0,
              settlementFor,
            })
          : null
        if (reb && reb.kind === 'blocked') {
          const r = buildRunReview({ norm: [], amountCents: 0, funds: [], market: new Map(), settlementFor })
          r.refusals.length = 0
          r.refusals.push(reb.reason)
          setRunCashDrawCents(0)
          setCoverOffers([])
          landedStepsRef.current = new Map() // fresh review, fresh slate
          setRunReview(r)
          return
        }
        setRunCashDrawCents(reb && reb.kind === 'runnable' ? reb.cashDrawCents : 0)
        const rebSells = reb && reb.kind === 'runnable' ? reb.sells : []
        // ACCEPTED wallet-cover sales join as REAL native sales (the cover
        // door below; the consent was the offer button itself)
        const NATIVE_COVER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
        const allSells = [
          ...rebSells,
          ...coverSells.map((c) => ({ chainId: c.chainId, address: NATIVE_COVER, symbol: 'ETH', sellRaw: c.sellRaw, decimals: 18 })),
        ]
        // funds cover the UNION of arming chains and selling chains — a
        // sell-only chain must be read too, or its gas viability is a guess
        const fundChains = [...new Set([...arming.chains, ...allSells.map((s) => s.chainId)])]
        // every phase is deadlined and NAMES itself: a hung socket becomes a
        // sentence + the Try-again door, never a frozen skeleton (13:09)
        setRunReviewPhase(`reading your balances on ${fundChains.length} network${fundChains.length === 1 ? '' : 's'}…`)
        const funds = await withPhaseDeadline(readThesisFunds(fundChains, address as `0x${string}`), 25_000, 'reading your balances')
        if (dead) return
        // NATIVE-USD PER CHAIN, read ONCE here and handed to the runner as a
        // sync lookup (the owner live 2026-08-18: every refuel-carrying
        // bridge refused "could not read a native-gas price" — the runner's
        // nativeUsd seam existed and NOTHING in production supplied it, so
        // the top-up was unsizeable by construction). Best-effort per chain:
        // a failed read stays null and the runner's own covered-already
        // degrade or refusal speaks.
        await Promise.all(
          fundChains.map(async (cid) => {
            try {
              const v = await nativeEthUsdOnChain(cid)
              if (v != null && v > 0) nativeUsdRef.current.set(cid, v)
            } catch {
              /* stays null — the runner refuses or degrades honestly */
            }
          }),
        )
        if (dead) return
        let live = reb && reb.kind === 'runnable' ? reb.targets : norm.filter((t) => t.pct > 0)
        // NATIVE-ETH BUY TARGETS RESOLVE TO THE CHAIN'S WETH (the owner live
        // 2026-08-15: "$ETH: No contract exists at this address" — the 0xeee
        // sentinel is not a contract; WETH is the same exposure the batcher
        // CAN buy; the AssetLogo precedent, applied to the money path).
        const NATIVE_BUY = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
        let wethMapped = false
        live = live.map((t) => {
          if (t.asset.address.toLowerCase() !== NATIVE_BUY) return t
          try {
            const weth = chainCfg(t.asset.chainId).weth
            if (!weth) return t
            wethMapped = true
            return { ...t, asset: { ...t.asset, address: weth } }
          } catch {
            return t
          }
        })
        // THE PRISM CARVE (the direct-lane ruling): PRISM leaves the batch here,
        // before any budgeting — its dollars fill direct in its own pool.
        {
          const planCents = reb && reb.kind === 'runnable' ? reb.amountCents : Math.floor((draft.amountUsd ?? 0) * 100)
          let carvedCents = 0
          live = live.filter((t) => {
            const isPrism =
              t.asset.chainId === PRISM_CLAIM_CHAIN_ID && t.asset.address.toLowerCase() === PRISM_V2_HOOK.toLowerCase()
            // ⚠⚠ CARVE BY THE TARGET'S OWN DOLLARS, NEVER BY `pct` (the owner live
            // 2026-08-16: "why when i try to buy 1200+ usd of prism it only
            // prompts to buy 12$"). The rebalance path builds its rows with
            // `pct: 1` as a PLACEHOLDER and puts the real figure in `usd`
            // (portfolio-run-wiring's runnable targets), so `planCents * pct/100`
            // silently carved ONE PERCENT of the plan: $1,280 became $12.80,
            // exactly 100x light. Both paths populate `usd` — normalizedTargets
            // sets it too — so it is the field that means the same thing
            // everywhere, and pct is only a fallback for rows that lack it.
            if (isPrism)
              carvedCents +=
                typeof t.usd === 'number' && Number.isFinite(t.usd) && t.usd > 0
                  ? Math.round(t.usd * 100)
                  : Math.round(planCents * (t.pct / 100))
            return !isPrism
          })
          if (carvedCents > 0) {
            const ethUsd = await nativeEthUsdOnChain(PRISM_CLAIM_CHAIN_ID).catch(() => null)
            if (dead) return
            const ethAmount = ethUsd != null && ethUsd > 0 ? (carvedCents / 100 / ethUsd).toFixed(4) : null
            setDirectPrism({ usdCents: carvedCents, ethAmount })
          } else {
            setDirectPrism(null)
          }
        }
        // THE BASKET CARVE (owner 2026-08-16: "surely you can buy a basket
        // from the portfolio system"): a target that IS a Spectrum basket —
        // per the chain's own discovery list — leaves the batch here, the
        // PRISM carve's exact shape. 0x cannot route it and the market read
        // below would refuse it with the nesting sentence, which never
        // applied to a wallet buying one. Its dollars fill through the
        // bundle-buy machinery instead (the carved card + overlay below).
        {
          const planCents = reb && reb.kind === 'runnable' ? reb.amountCents : Math.floor((draft.amountUsd ?? 0) * 100)
          const chainsWithTargets = [...new Set(live.map((t) => t.asset.chainId))]
          const basketSets = new Map<number, Set<string>>()
          for (const cid of chainsWithTargets) {
            const list = await listBasketsForChain(cid).catch(() => [] as Awaited<ReturnType<typeof listBasketsForChain>>)
            basketSets.set(cid, new Set(list.map((b) => b.address.toLowerCase())))
          }
          if (dead) return
          const carved: { chainId: number; address: string; symbol: string; usdCents: number }[] = []
          live = live.filter((t) => {
            const isBasket = basketSets.get(t.asset.chainId)?.has(t.asset.address.toLowerCase()) === true
            if (!isBasket) return true
            // one basket per network per run — the thesis machine's own
            // shape (chain-keyed shares); a second same-chain basket target
            // keeps today's path, stated by its own refusal below
            if (carved.some((c) => c.chainId === t.asset.chainId)) return true
            carved.push({
              chainId: t.asset.chainId,
              address: t.asset.address,
              symbol: t.asset.symbol,
              // usd FIRST, pct only as fallback — the PRISM 100x lesson
              // (pct: 1 is a placeholder on the rebalance path)
              usdCents:
                typeof t.usd === 'number' && Number.isFinite(t.usd) && t.usd > 0
                  ? Math.round(t.usd * 100)
                  : Math.round(planCents * (t.pct / 100)),
            })
            return false
          })
          setDirectBaskets(carved.filter((c) => c.usdCents > 0))
        }
        // NATIVE ETH sells price via the chain's own native read — the token
        // reader refuses the 0xeee… sentinel ("no contract exists", the owner's
        // live find). The synthetic row is PRICING-ONLY: sells never reach
        // planToLegs, so its leg is never composed.
        const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
        const nativeSells = allSells.filter((s) => s.address.toLowerCase() === NATIVE)
        const erc20Sells = allSells.filter((s) => s.address.toLowerCase() !== NATIVE)
        // THE SALE FLOOR'S LIVE BASIS (the owner live 2026-08-18, the CASHCAT
        // wall): ask the routed lane for each sale's OWN enforced minimum at
        // build time, so the floor is a number a lane actually guarantees —
        // never only the indexer's laggy spot. A failed read costs nothing:
        // the est basis stands, exactly as before.
        setRunReviewPhase(`pricing ${erc20Sells.length || 'the'} sale${erc20Sells.length === 1 ? '' : 's'} on the live routes…`)
        await Promise.all(
          erc20Sells.map(async (se) => {
            try {
              const settlement = settlementFor(se.chainId)
              if (!settlement) return
              const q = await fetchLifiQuote({
                chainId: se.chainId,
                fromToken: se.address as `0x${string}`,
                toToken: settlement,
                fromAmount: BigInt(se.sellRaw),
                fromAddress: address as `0x${string}`,
                slippageBps: DEFAULT_SLIPPAGE_BPS,
              })
              const dec = settlementDecimalsFor(se.chainId)
              const cents = Number(q.toAmountMin / 10n ** BigInt(Math.max(0, dec - 2)))
              if (Number.isFinite(cents) && cents > 0) (se as { liveMinCents?: number }).liveMinCents = cents
            } catch {
              /* est basis stands — the routed lanes re-floor at run time anyway */
            }
          }),
        )
        if (dead) return
        setRunReviewPhase(`reading the market for ${live.length + allSells.length} asset${live.length + allSells.length === 1 ? '' : 's'}…`)
        const market = await withPhaseDeadline(
          defaultMarketReader([
            ...live.map((t) => ({ chainId: t.asset.chainId, address: t.asset.address as `0x${string}`, symbol: t.asset.symbol, weightPct: t.weight })),
            // ERC-20 SALES price through the same read (weightPct is unused
            // for pricing — 1 keeps the reader's own sanitizers quiet)
            ...erc20Sells.map((s) => ({ chainId: s.chainId, address: s.address as `0x${string}`, symbol: s.symbol, weightPct: 1 })),
          ]),
          60_000,
          'reading the markets',
        )
        if (dead) return
        for (const s of nativeSells) {
          const usd = await nativeEthUsdOnChain(s.chainId).catch(() => null)
          market.set(
            `${s.chainId}:${NATIVE}`,
            usd != null && usd > 0
              ? ({ ok: true, leg: { symbol: s.symbol, asset: s.address as `0x${string}`, decimals: 18, weightPct: 1, priceUsd: usd, priceAgeMs: 0, liquidityUsd: 0, buyTokenTaxBps: 0, route: undefined as never } } as MarketRow)
              : { ok: false, symbol: s.symbol, reason: `$${s.symbol}: no readable native price on this network` },
          )
        }
        if (dead) return
        const built = buildRunReview({
          norm: live,
          amountCents: reb && reb.kind === 'runnable' ? reb.amountCents : Math.floor((draft.amountUsd ?? 0) * 100),
          funds,
          market,
          settlementFor,
          ...(allSells.length > 0 ? { sells: allSells } : {}),
          ...(bridgeChoice === 'local' ? { localOnly: true } : {}),
        })
        if (wethMapped) built.refusals.push('your ETH buy arrives as wrapped ETH (WETH), the same asset, unwrap any time')
        // THE WALLET-COVER OFFERS: for each chain the PLAN refused on money,
        // if the wallet's own ETH there (above its gas reserve) covers the
        // whole local shortfall, the refusal renders WITH its door. Computed
        // beside the review so render stays pure; conservative local math
        // (need − held settlement) — under localOnly it is exact, otherwise
        // it at worst covers slightly more than the cross-chain optimum.
        const offers: WalletCoverOffer[] = []
        const offeredChains = new Set<number>()
        for (const r of built.plan.refusals) {
          if (offeredChains.has(r.chainId)) continue
          offeredChains.add(r.chainId)
          if (coverSells.some((c) => c.chainId === r.chainId)) continue // already covering — a repeat refusal is a new fact, not a re-offer
          const chainRow = built.chains.find((c) => c.chainId === r.chainId)
          const f = funds.find((x) => x.chainId === r.chainId)
          if (!chainRow || !f) continue
          const shortCents = Math.max(0, chainRow.grossCents - Math.max(0, Math.floor(f.usdcCents)))
          if (shortCents <= 0) continue
          const priceUsd = await nativeEthUsdOnChain(r.chainId).catch(() => null)
          if (dead) return
          const offer = walletCoverOfferFor({
            chainId: r.chainId,
            shortCents,
            priceUsd,
            nativeRaw: f.nativeRaw,
            gasReserveRaw: f.gasNeedRaw,
            slippageBps: DEFAULT_SLIPPAGE_BPS,
            driftBps: SELL_FLOOR_DRIFT_BPS,
          })
          if (offer) offers.push(offer)
        }
        setCoverOffers(offers)
        landedStepsRef.current = new Map() // fresh review, fresh slate
        setRunReview(built)
      } catch (e) {
        if (!dead) {
          setRunReviewPhase('')
          setRunReviewError(e instanceof Error ? e.message : 'the wallet or market read failed — try again')
        }
      }
    })()
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arming, runReview, runReviewError, address, bridgeChoice, coverSells])

  // THE AUTO-RUN (the owner 2026-08-15: "dont need the buy for real button in
  // this flow — after execute it just should go to buys"). Consent stays
  // real: Execute was the click, the review still RENDERS (shownFor mints
  // from its rows), and a plan that composes TRANSFERS holds for the bridge
  // choice above. One start per built review; a finished/partial run never
  // auto-restarts (resume is the explicit continue button).
  useEffect(() => {
    if (!runReview || runner.state || runStarting) return
    if (autoRanRef.current === runReview) return
    const upfront = runner.gate(runReview.plan)
    if (!upfront.ok) return
    const hasBridges = runReview.plan.steps.some((p) => p.action.kind === 'bridge')
    if (hasBridges && bridgeChoice !== 'bridge') return
    autoRanRef.current = runReview
    setRunStarting(true)
    setRunStartedAt(Date.now())
    runner
      .run(runReview.plan)
      .catch((e: unknown) => {
        setRunReviewError(e instanceof Error ? e.message : 'the run failed to start — try again')
      })
      .finally(() => setRunStarting(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runReview, bridgeChoice, runner.state, runStarting])

  // THE ARMED RUN'S COMPLETION (the get-ahead trace, 2026-08-15: nothing
  // consumed runner.state 'done' — the buys would land and the surface would
  // just sit there, the book still claiming the old mix). Once, on done:
  // the saved book records the EXECUTED intent (simulated: false — this run
  // genuinely happened; drift may now arm against these targets, correctly).
  // The exec-log row is the runner's own (writeExecLog) — not repeated here.
  const armedSavedRef = useRef(false)
  useEffect(() => {
    if (runner.state?.phase !== 'done' || armedSavedRef.current || !address) return
    armedSavedRef.current = true
    if (draft.intent === 'keep') {
      savePortfolio(address, {
        targets: draft.targets,
        // a pure rebalance has no NET new money — 0 is that truth in the
        // book's own type (the walkthrough path records the same way)
        amountUsd: draft.amountUsd ?? 0,
        executedAt: Date.now(),
        simulated: false,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.state?.phase, address])

  // The watch loop: alive while a run is on screen with anything in flight.
  useEffect(() => {
    const st = runner.state
    const inFlight = st != null && (st.phase === 'running' || (st.phase === 'partial' && st.steps.some((x) => x.kind === 'bridge' && (x.status === 'submitted' || x.status === 'unresolved'))))
    if (!inFlight || !address) return
    let dead = false
    const t = window.setInterval(() => {
      setBridgeTick((x) => x + 1)
      if (dead) return
      // every ~10s: ask the oracle about each unresolved transfer row of OURS
      if (Math.floor(Date.now() / 1000) % 10 !== 0) return
      for (const row of bridgeRows()) {
        if (row.holder.toLowerCase() !== address.toLowerCase()) continue
        if (runStartedAt != null && row.startedAt < runStartedAt - 60_000) continue
        const k = `${row.fromChainId}-${row.toChainId}`
        if (bridgeArrivals[k] != null) continue
        void pollBridge(row).then((d) => {
          if (!dead && d.state === 'done') setBridgeArrivals((m) => ({ ...m, [k]: d.toAmount }))
        }).catch(() => {})
      }
    }, 1_000)
    return () => {
      dead = true
      window.clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.state?.phase, address, runStartedAt])

  // Post-connect remount landing directly on the execute station: begin the
  // run at once — the user already confirmed; asking again was the bug.
  //
  // ⚠ ONLY ONCE THE CONNECT ACTUALLY LANDED (QOL 2026-08-07). The remount fires
  // when onNeedConnect sets resumeStation, which happens as the wallet dialog
  // OPENS — so the scope is still the guest at that moment. Unguarded, this ran
  // the whole thing for someone who never connected: dismiss the dialog and you
  // still arrived at "Your portfolio is live", and the guest draft was cleared
  // underneath you, so a later connect adopted nothing. The connected remount
  // (a different scope, hence a different key) is the one that may auto-run.
  //
  // The guest branch goes BACK to review rather than staying put: with no plan
  // and nothing computing, the execute station renders neither of its two
  // branches, so standing here would be a blank screen with no way out.
  useEffect(() => {
    if (initialStation !== 'execute' || plan || computing || arming) return
    if (isGuest) {
      setStation('review')
      return
    }
    if (!walkthroughAllowed(address)) {
      // A real wallet lands on the VERDICT, never on an auto-run — and a
      // stale persisted simulated run is void for it (it was never this
      // wallet's money moving). Same review-dies-with-the-intent law as
      // beginExecute: this remount is a fresh intent.
      if (resumePlan) clearExec(address)
      setRunReview(null)
      setRunReviewError(null)
      setArming(realExecutionArming(draft, address))
      return
    }
    if (!resumePlan) setComputing(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── THE REAL PUBLISH (the owner 2026-08-11: "condensed into one system …
  // /create should be the default for creating a basket and bundle and needs
  // to know when assets across chains are selected"). Fresh-money publishes
  // hand off to the machinery that already deploys for real — the launch
  // builder for one network, the bundle ceremony for several — instead of the
  // simulated walk. HOLDINGS-BACKED publishes (seedFrom, the mint-in-kind
  // promise) stay on the simulated path until that contract work is live:
  // the seam is the data (seedFrom present), never a mode toggle. ──
  const [pubHandoff, setPubHandoff] = useState<{ groups: BundleGroup[] } | null>(null)
  const publishedRef2 = useRef(false)
  const [pubBusy, setPubBusy] = useState(false)
  const [pubRefusal, setPubRefusal] = useState<string | null>(null)
  // The one derivation, shared with the Composer: picks spanning more than
  // one network make this draft a BUNDLE (one basket per network under one
  // name); a single-network draft is a plain basket. Never a toggle.
  const publishBundle = draft.intent === 'publish' && isBundleDraft(draft.targets.map((t) => t.asset))
  const realPublish = draft.intent === 'publish' && !(draft.seedFrom && draft.seedFrom.length > 0)
  // THE UI'S FEE RATE, per the deployed generation (flip: 40 -> 25). Derived
  // from the draft's own chains; mixed generations show the HIGHER rate (the
  // one direction a money display may round). All chains flip together in
  // practice, so this is a single number every real day.
  const uiFeeBps = useMemo(() => {
    const ids = [...new Set(draft.targets.map((t) => t.asset.chainId))]
    return ids.length === 0 ? batchFeeBpsFor(DEFAULT_CHAIN_ID) : Math.max(...ids.map((id) => batchFeeBpsFor(id)))
  }, [draft.targets])
  // The fresh-deploy shape law, PRE-STATED (the "blocker speaks where the fix
  // is" rule): a network holding one pick cannot ship a basket, and the review
  // is where adding the second pick happens — the ceremony must never be the
  // first to say so. Same words as publish-bundle-model's own blocker.
  const publishBlockers = useMemo(() => {
    if (draft.intent !== 'publish') return []
    const counts = new Map<number, number>()
    for (const t of draft.targets) counts.set(t.asset.chainId, (counts.get(t.asset.chainId) ?? 0) + 1)
    return [...counts.entries()]
      .filter(([, n]) => n < 2)
      .map(([cid, n]) => `A basket needs at least two assets — ${chainCfg(cid).name} has ${n === 1 ? 'one' : 'none'}.`)
  }, [draft.intent, draft.targets])

  // the ONE disabled law for both Execute buttons (top-right + foot) — audit
  // 2026-08-16: they computed it separately and disagreed in both directions
  // on a real publish (the foot fired with a publish blocker standing; the
  // foot demanded an amount a publish does not need)
  const executeDisabled = realPublish
    ? pubBusy || publishBlockers.length > 0
    : amount == null || (seedBlocks.length > 0 && !seedOverridden)

  const beginRealPublish = async () => {
    if (pubBusy) return
    setPubBusy(true)
    setPubRefusal(null)
    try {
      const norm = normalizedTargets(draft).filter((t) => t.pct > 0)
      // resolve every pick through the launch flow's own resolver — venue,
      // decimals and route come from ONE implementation, and an unroutable
      // pick is a named refusal here rather than a failed deploy later
      const settled = await Promise.allSettled(
        norm.map(async (t) => ({
          ...(await resolveAsset(t.asset.address, t.asset.chainId, t.asset.symbol)),
          chainId: t.asset.chainId,
        })),
      )
      const failed = settled
        .map((r, i) => (r.status === 'rejected' ? norm[i].asset.symbol : null))
        .filter((x): x is string => x != null)
      if (failed.length > 0) {
        setPubRefusal(`Couldn't route ${failed.map((f) => showSymbol(f)).join(', ')} for a real deploy — remove or retry.`)
        return
      }
      const resolved = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      const weights = norm.map((t) => t.pct)
      const chains = [...new Set(resolved.map((a) => a.chainId))]
      if (chains.length > 1) {
        // several networks → the bundle ceremony (per-network readiness,
        // sequential real deploys, one shared name)
        setPubHandoff({ groups: groupBundleDraft(resolved, weights) })
        return
      }
      // one network → the SAME ceremony, one lane (owner live 2026-08-14:
      // the legacy studio is never a landing again; deploy naked → seed →
      // thesis → share is the journey for every publish, single included)
      setPubHandoff({ groups: groupBundleDraft(resolved, weights) })
    } finally {
      setPubBusy(false)
    }
  }

  const beginExecute = () => {
    // The REAL publish path runs before the guest gate on purpose: the
    // ceremony and the builder each own their connect moment (the Composer's
    // exact posture) — readiness renders honestly disconnected, and the
    // wallet is asked for exactly when a signature is near.
    if (realPublish) {
      void beginRealPublish()
      return
    }
    if (isGuest) {
      // Money enters the picture HERE — and only here does a wallet matter
      // (picker-first law). Resume INTO the execution, not back onto review
      // (owner 20:54: the extra review step was a bug).
      onNeedConnect?.('execute')
      return
    }
    if (!walkthroughAllowed(address)) {
      // THE REAL PATH: no timers, no pretend. The verdict is computed at the
      // moment of intent and rendered as-is — armed, or the named refusal.
      // ⚠ THE REVIEW DIES WITH THE INTENT THAT BUILT IT (self-audit
      // 2026-08-14): runReview was built once and never invalidated, so
      // arm → back → EDIT the draft → execute again rendered and RAN the
      // PREVIOUS plan — shown and composed agreed with each other and both
      // disagreed with the user's latest intent, which the gate cannot see
      // (it compares shown to signed, not shown to intended). Every entry
      // here rebuilds from the CURRENT draft; the seconds of wallet+market
      // re-read are the price of executing what was actually asked.
      setRunReview(null)
      setRunReviewError(null)
      setArming(realExecutionArming(draft, address))
      setStation('execute')
      return
    }
    setStation('execute')
    setComputing(true)
  }

  useEffect(() => {
    onStation?.(station)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station])

  useEffect(() => {
    if (!computing) return
    const t = window.setTimeout(() => {
      setComputing(false)
      setPlan(startPlan(compilePlan(draft)))
    }, 1700)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computing])

  // The runner: approve → confirming → done on timers. The pauses are the
  // honest rhythm of the real thing (a wallet prompt, then a network) — what
  // Phase 3 replaces with real signatures, keeping these exact states.
  useEffect(() => {
    if (station !== 'execute' || !plan || plan.status !== 'running') return
    const step = currentStep(plan)
    if (!step || step.state === 'failed') return
    const delay = step.state === 'approve' ? 1500 : step.state === 'confirming' ? 1100 : 300
    const t = window.setTimeout(() => setPlan(advancePlan(plan)), delay)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, station])

  // Completion lands exactly once. Door A keeps: the portfolio saves (marked
  // simulated). Door B published: from the BUY path there is no private
  // portfolio to save — but a HOLDINGS-BACKED publish (the picker, seedFrom)
  // converts only the seeded portion, and the KEPT REMAINDER is a private
  // portfolio that must be recorded (the -36 finding's sibling: "nothing to
  // save" was the buy-path premise, false on this entry). Either way the
  // draft and the pending run clear.
  useEffect(() => {
    if (plan?.status !== 'done' || savedRef.current) return
    savedRef.current = true
    // THE EXECUTION LOG (features 1+7): every completed run appends one row
    // at this choke point — the chart's event markers and the CSV export
    // both read it. Changes are the composer's RECORDED ends, never re-
    // derived from stored percentages.
    appendExec(address, {
      ts: Date.now(),
      kind: draft.intent === 'publish' ? 'publish' : draft.funding ? 'rebalance' : 'create',
      // ONE semantic for the column (audit find): NET NEW MONEY in — create's
      // invested amount, a pure rebalance's 0. The resultUsd fallback would
      // have logged portfolio-value-after under the same header. Unknown = null.
      totalUsd: plan.amountUsd ?? null,
      changes: draft.funding?.changes?.map((c) => ({
        symbol: c.symbol,
        deltaUsd: Math.round((c.toUsd - c.fromUsd) * 100) / 100,
        realizedUsd: c.realizedUsd,
      })),
      simulated: SIMULATED,
    })
    if (draft.intent === 'keep') {
      savePortfolio(address, {
        targets: draft.targets,
        amountUsd: plan.amountUsd,
        executedAt: Date.now(),
        simulated: true,
      })
    } else {
      // The published snapshot anchors the post-publish loop: divergence
      // between the kept portfolio and this frozen mix drives the recurring
      // republish-as-v2 nudge (four-gaps item 4 + the recurrence addition).
      savePublished(address, {
        targets: draft.targets,
        name: draft.name,
        seedPct: draft.seedPct ?? DEFAULT_SEED_PCT,
        publishedAt: Date.now(),
        simulated: true,
      })
      if (draft.seedFrom && draft.seedFrom.length > 0) {
        const seedPct = draft.seedPct ?? DEFAULT_SEED_PCT
        const keptUsd = draft.seedFrom.reduce((t, r) => t + r.heldUsd, 0) * (1 - seedPct / 100)
        if (keptUsd > 0.5) {
          // same targets, same proportions — the remainder keeps the mix
          savePortfolio(address, {
            targets: draft.targets,
            amountUsd: Math.round(keptUsd * 100) / 100,
            executedAt: Date.now(),
            simulated: true,
          })
        }
      }
    }
    clearDraft(address)
    clearExec(address)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan])

  const stopRun = () => {
    if (!plan) return
    const next = requestStop(plan)
    if (next.status === 'cancelled') {
      // Nothing in flight — stopped at once.
      setPlanState(next)
      clearExec(address)
    } else {
      // A step is mid-confirmation: it FINISHES, then the run cancels — the
      // runner sees stopRequested and the reducer honors it (never abandon a
      // step the UI claims didn't happen).
      setPlan(next)
    }
  }

  // The runner persists the cancelled terminal state too; clear the pending
  // slot once a stop-after-step lands so the home band doesn't offer resume.
  useEffect(() => {
    if (plan?.status === 'cancelled') clearExec(address)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.status])

  const directInFlight = directRun.phase === 'quoting' || directRun.phase === 'wallet' || directRun.phase === 'confirming'
  useEffect(() => {
    if (!directInFlight) setCloseArm(false)
  }, [directInFlight])
  const guardedClose = useCallback(() => {
    if (directInFlight && !closeArm) {
      setCloseArm(true)
      return
    }
    onClose()
  }, [directInFlight, closeArm, onClose])

  // Escape closes the OVERLAY mount; the inline page mount ignores it.
  useEffect(() => {
    if (inline) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && guardedClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [guardedClose, inline])

  // Focus lives INSIDE the dialog (PM review): take it on open, keep Tab
  // cycling within, re-seat it when a station unmounts under the keyboard,
  // and hand it back to the opener on close.
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => opener?.focus?.()
  }, [])
  useEffect(() => {
    dialogRef.current?.focus()
  }, [station])
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, a[href], [tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const enter = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, x: 32, scale: 0.99 },
        animate: { opacity: 1, x: 0, scale: 1 },
        exit: { opacity: 0, x: -24, scale: 0.99 },
      }

  const spectralBtn =
    'press group inline-flex h-12 items-center gap-3 rounded-full pl-6 pr-2 font-display text-sm font-bold uppercase tracking-[0.14em] text-void transition-transform duration-500 hover:scale-[1.01] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40'
  const ghostBtn =
    'press inline-flex h-12 items-center rounded-full border border-white/15 px-6 font-mono text-[11px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan disabled:cursor-not-allowed disabled:opacity-40'
  const Arrow = () => (
    <span className="grid h-8 w-8 place-items-center rounded-full bg-black/15 transition-transform duration-500 group-hover:translate-x-0.5">
      →
    </span>
  )

  const body = (
    <div
      className={`mx-auto w-full ${
        chromeless ? 'max-w-none' : inline ? 'max-w-[1040px] px-4 pb-10 pt-2 sm:px-6' : 'max-w-[880px] px-4 py-10 sm:px-6'
      }`}
    >
      {/* header: what this is, the demo truth, the way out */}
      <div className={inline ? 'hidden' : 'flex items-start justify-between gap-4'}>
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
            Create your portfolio
          </h1>
          <DemoChip />
        </div>
        {!inline && (
          <button
            type="button"
            onClick={guardedClose}
            aria-label="Close"
            className="press grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/12 text-ink-dim hover:border-white/30 hover:text-ink"
          >
            ✕
          </button>
        )}
      </div>

      {closeArm && directInFlight && (
        <p role="status" className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-4 py-2.5 text-center font-mono text-[11px] leading-relaxed text-amber-200/90">
          The PRISM pool buy is still going — your wallet may be showing its prompt. Close again to leave
          anyway: your money stays in your wallet, but this plan lands without PRISM.
        </p>
      )}
      {/* inline: no Create header at all (owner 20:54) — the rail leads, the
          simulation chip rides with it (it must stay visible while SIMULATED) */}
      <div className={`${inline ? 'mt-0' : 'mt-8'} flex flex-col items-center gap-3`}>
        {inline && <DemoChip />}
        {/* the rail is WAYFINDING for someone walking all five stations; a
            rebalance enters at review, so inside the popup it describes steps
            the user never saw (the owner). The host owns the way back there. */}
        {!chromeless && (
          <div className="w-full max-w-[640px] rounded-2xl border border-white/10 bg-panel/70 px-8 py-5 backdrop-blur-md">
            <Rail station={station} />
          </div>
        )}
      </div>

      <div className={chromeless ? 'mt-6' : 'mt-8'}>
        <Shell bare={chromeless}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={station}
              {...enter}
              transition={{ duration: 0.45, ease: EASE }}
              className={chromeless ? '' : `${station === 'execute' ? 'min-h-0' : 'min-h-[600px]'} p-6 sm:p-10`}
            >
              {/* ── STATION 1 · CHOOSE ─────────────────────────────────────── */}
              {station === 'choose' && (
                <div>
                  {/* owner 2026-08-07: "on /create through ANY door this should
                      say 'Select Assets To Add To Your Basket'". One heading for
                      every entry (?door=keep, ?door=publish, the bare route and
                      the embedded mount all render this same station), so the
                      instruction is the same wherever you came in from. */}
                  <div className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
                    Select assets to add to your basket
                  </div>
                  {/* the bundle law, said where the picking happens (the owner
                      2026-08-11: /create must KNOW): a hint before it applies,
                      the live fact once picks span networks. Publish door
                      only — a kept portfolio spans chains without ceremony. */}
                  {draft.intent === 'publish' &&
                    (publishBundle ? (
                      <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-violet-bright">
                        picks span {new Set(draft.targets.map((t) => t.asset.chainId)).size} networks — this publishes
                        as a bundle, one basket per network
                      </p>
                    ) : (
                      <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                        pick on several networks and it publishes as a bundle
                      </p>
                    ))}

                  {/* START FROM WHAT YOU HOLD — RANKED FIRST (plan 0.3,
                      ratified 2026-08-04: "From your portfolio" leads when
                      connected-with-holdings; seeds, not defaults). The
                      probe is the same isRealAddr + majors gate the band
                      always had — guests and empty wallets never see it,
                      and scratch (the search below) stays fully first-class.
                      Desk 26 Ⓡ ~10:20 origin: "detecting their major assets
                      so we can help them build out". Reads take the group,
                      actions stay connected. */}
                  {isRealAddr && majors.length > 0 && draft.targets.length === 0 && (
                    <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                        From your portfolio
                      </span>
                      {majors.slice(0, 5).map((h) => (
                        <span key={`${h.chainId}:${h.address}`} className="inline-flex items-center gap-1.5 rounded-full border border-white/12 py-1 pl-1 pr-2.5">
                          <AssetLogo address={h.address} symbol={h.symbol} chainId={h.chainId} size={20} />
                          <span className="font-display text-xs font-bold text-ink">${showSymbol(h.symbol)}</span>
                          <span className="font-num text-[10px] font-semibold tabular-nums text-ink-faint">{formatUsdCompact(h.usd as number)}</span>
                        </span>
                      ))}
                      <button
                        type="button"
                        onClick={seedFromMajors}
                        className="press ml-auto inline-flex h-9 items-center gap-1.5 rounded-full border border-cyan/40 bg-cyan/[0.08] px-4 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan hover:border-cyan/70"
                      >
                        Start from these →
                      </button>
                      {/* the link ceremony, right where the holdings read from
                          (desk 29) — linking another wallet widens this list */}
                      <LinkedWallets group={walletGroup} active={address} />
                    </div>
                  )}

                  <div className="relative mt-6">
                    <svg
                      aria-hidden
                      viewBox="0 0 24 24"
                      className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <circle cx="11" cy="11" r="7" />
                      <path d="M21 21l-4.3-4.3" />
                    </svg>
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      /* the long placeholder hard-cut to "Search an asset · AA" at 390w
                         (mobile sweep 2026-08-06) — the phone gets a sentence that
                         FITS, the desktop keeps the examples */
                      placeholder={phone ? 'Ticker or address' : 'Search an asset · AAVE, NVDA… or paste an address'}
                      aria-label="Search assets"
                      spellCheck={false}
                      /* autoFocus makes the BROWSER SCROLL to the element on
                         load — right when the flow IS the page (/create),
                         wrong wherever it is embedded (UIGuy's homepage fix,
                         applied verbatim; also covers this lane's popup
                         hosts). */
                      autoFocus={!inline}
                      className="h-12 w-full rounded-full border border-white/12 bg-white/[0.03] pl-12 pr-5 font-mono text-[13px] text-ink outline-none transition-all placeholder:text-ink-faint focus:border-cyan/50 focus:shadow-[0_0_24px_rgba(53,224,255,0.2)]"
                    />
                  </div>

                  {/* filter pills — networks + themes (owner 20:42; his call
                      supersedes the earlier no-chain-pills stance for the
                      FILTER row: chains here are an optional lens, never a
                      required decision — auto-resolve by depth still rules) */}
                  {/* ONE SCROLLING ROW ON A PHONE (mobile sweep 2026-08-06):
                      wrapped, these eight pills stacked four rows deep (~340px),
                      so barely one asset card and none of the CTA sat above the
                      fold on the flow's first real step. Same rail-fade idiom as
                      Explore's lenses; wraps as before from sm up. */}
                  <div className="no-scrollbar rail-fade -mx-1 mt-4 flex items-center gap-2 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
                    <button
                      type="button"
                      onClick={() => setChainFilter('all')}
                      aria-pressed={chainFilter === 'all'}
                      className={`press h-10 shrink-0 rounded-full border px-4 font-mono text-[11px] uppercase tracking-wide ${chainFilter === 'all' ? 'border-cyan/60 bg-cyan/15 text-cyan' : 'border-white/12 text-ink-dim hover:border-white/30'}`}
                    >
                      All
                    </button>
                    {SUPPORTED_CHAIN_IDS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setChainFilter(chainFilter === c ? 'all' : c)}
                        aria-pressed={chainFilter === c}
                        className={`press h-10 shrink-0 rounded-full border px-4 font-mono text-[11px] uppercase tracking-wide ${chainFilter === c ? 'border-cyan/60 bg-cyan/15 text-cyan shadow-[0_0_16px_rgba(53,224,255,0.25)]' : 'border-white/12 text-ink-dim hover:border-white/30'}`}
                      >
                        <span className="inline-flex items-center gap-2">
                          <ChainIcon chainId={c} />
                          {/* SHORT FORM ON A PHONE (owner 2026-08-06 23:13:
                              "the All, Base and Ethereum — we need to have
                              Robinhood there as well, which is not shown at
                              the moment, which seems like a bug"). It was not
                              missing: four full names plus four themes
                              overflowed the row, so Robinhood sat past the
                              scroll. The nav's own BASE/ETH/RH labels fit all
                              four in view; the full names return at sm. */}
                          <span className="sm:hidden">{netShort(c)}</span>
                          <span className="hidden sm:inline">{netName(c)}</span>
                        </span>
                      </button>
                    ))}
                    {/* the group divider dangled alone at the end of a wrapped row on a
                        phone (mobile sweep 2026-08-06) — it separates groups on
                        one line, so it only exists where there is one line */}
                    <span aria-hidden className="mx-1 hidden h-6 w-px shrink-0 bg-white/10 sm:block" />
                    {(['defi', 'ai', 'memes', 'stocks'] as const).map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCatFilter(catFilter === cat ? 'all' : cat)}
                        aria-pressed={catFilter === cat}
                        className={`press h-10 shrink-0 rounded-full border px-4 font-mono text-[11px] uppercase tracking-wide ${catFilter === cat ? 'border-violet-bright/60 bg-violet-bright/15 text-[#cabdff] shadow-[0_0_16px_rgba(164,139,255,0.25)]' : 'border-white/12 text-ink-dim hover:border-white/30'}`}
                      >
                        {cat === 'defi' ? 'DeFi' : cat === 'ai' ? 'AI' : cat === 'memes' ? 'Memes' : 'Stocks'}
                      </button>
                    ))}
                  </div>

                  {/* FIXED-HEIGHT results region (the owner 18:41: "the card should
                      always be at a fixed length") — search results, the
                      resolved-address card, and the busy/refusal states all
                      live inside this box; the card never grows or jumps.
                      ⚠ IT SCROLLS, IT DOES NOT HIDE (mobile sweep 2026-08-06):
                      at 390w the grid is ONE column, so nine assets measured
                      789px inside this 264px box and six of them were simply
                      unreachable — no scroll, no pager, no affordance. The
                      fixed height is a LAYOUT promise, never a content cap:
                      overflow-y-auto keeps the card's length constant AND the
                      assets reachable, `overscroll-contain` stops the page
                      scrolling underneath it, and the phone gets a taller box
                      because a one-column list needs the room. */}
                  <div className="scrollbar-none mt-8 h-[336px] overflow-y-auto overscroll-contain pr-1 pt-1 sm:h-[264px]">
                    {(busy || liveBusy) && (
                      <p className="mb-3 flex items-center gap-2 font-mono text-[11px] text-ink-faint">
                        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-cyan shadow-[0_0_10px_var(--color-cyan)]" />
                        Checking markets…
                      </p>
                    )}
                    {findError && (
                      <p className="mb-3 rounded-xl border border-magenta/30 bg-magenta/[0.06] p-3 font-mono text-[11px] text-ink-dim">
                        {findError}
                      </p>
                    )}
                    {found && isAddr && (
                      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-cyan/40 bg-cyan/[0.06] p-4">
                        <div className="flex items-center gap-3">
                          <AssetLogo address={found.address} symbol={found.symbol} chainId={found.chainId} size={32} />
                          <div>
                            <div className="font-display text-lg font-bold text-ink">${showSymbol(found.symbol)}</div>
                            <div className="mt-1 font-mono text-[11px] text-ink-dim">
                              {fixtureMode
                                ? 'demo listing'
                                : `${found.venueLabel ?? 'routable market'}${
                                    found.depthUsd != null && found.depthUsd > 0
                                      ? ` · ${formatUsdCompact(found.depthUsd)} routable`
                                      : ''
                                  }`}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => pick(found)}
                          className="press h-10 shrink-0 rounded-full border border-cyan/50 bg-cyan/15 px-5 font-mono text-[11px] uppercase tracking-wide text-cyan hover:border-cyan"
                        >
                          Add
                        </button>
                      </div>
                    )}
                    {!isAddr && (
                      <div className="grid content-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {shown.slice(0, 9).map((a, i) => (
                          <AssetCard
                            key={assetKey(a)}
                            a={a}
                            index={i}
                            chosen={chosenKeys.has(assetKey(a))}
                            disabled={full}
                            onPick={() => pick(a)}
                          />
                        ))}
                        {shown.length === 0 && !liveBusy && (
                          <p className="col-span-full py-6 font-mono text-[11px] text-ink-faint">
                            {liveUnreachable
                              ? 'The search couldn’t reach any network just now — try again in a moment.'
                              : `Nothing matches “${q}”. Paste its contract address and we’ll find its market.`}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* the picks tray — ALWAYS rendered, height reserved, so
                      adding assets never moves the card */}
                  <div className="mt-6 min-h-24 border-t border-white/10 pt-6">
                    {draft.targets.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                          Your picks · <span className="text-ink">{draft.targets.length}</span>
                        </span>
                        {draft.targets.map((t, ti) => (
                          <span
                            key={assetKey(t.asset)}
                            className="enter inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] py-1 pl-1 pr-2"
                            style={{ '--enter-i': Math.min(ti, 8) } as CSSProperties}
                          >
                            <AssetLogo address={t.asset.address} symbol={t.asset.symbol} chainId={t.asset.chainId} size={22} />
                            <span className="font-mono text-[11px] text-ink">${showSymbol(t.asset.symbol)}</span>
                            <button
                              type="button"
                              onClick={() => setDraft(removeTarget(draft, t.asset))}
                              aria-label={`Remove ${showSymbol(t.asset.symbol)}`}
                              className="press grid h-5 w-5 place-items-center rounded-full text-ink-faint hover:text-magenta"
                            >
                              ✕
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="flex items-center gap-3">
                        {[0, 1, 2].map((g) => (
                          <span key={g} aria-hidden className="h-6 w-6 rounded-full border border-dashed border-white/15" />
                        ))}
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                          your picks land here
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="mt-8 flex flex-wrap items-center gap-4">
                    <button
                      type="button"
                      disabled={draft.targets.length === 0}
                      onClick={() => setStation('weight')}
                      className={spectralBtn}
                      style={{ background: SPECTRAL }}
                    >
                      Weight your assets
                      <Arrow />
                    </button>
                    <span className="font-mono text-[11px] text-ink-faint">
                      {draft.targets.length === 0
                        ? 'pick at least one asset'
                        : `${draft.targets.length} asset${draft.targets.length === 1 ? '' : 's'} chosen`}
                      {full && ' · that’s the cap'}
                    </span>
                  </div>
                </div>
              )}

              {/* ── STATION 2 · WEIGHT ─────────────────────────────────────── */}
              {station === 'weight' && (
                <div>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <div className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
                      Shape the mix
                    </div>
                    {/* his exact spec (live 2026-08-13): larger, right-aligned,
                        balanced across two lines, no em dashes, and it must say
                        MULTICHAIN BUNDLE OF BASKETS */}
                    {publishBundle && (
                      <span className="ml-auto max-w-[36ch] text-right font-mono text-[11px] uppercase leading-relaxed tracking-[0.14em] text-violet-bright [text-wrap:balance]">
                        A multichain bundle of baskets: weights shape the whole mix, and each network renormalizes at publish.
                      </span>
                    )}
                    {/* the reshape popup's own idiom (desk 24): picture leads */}
                    <span className="flex items-center gap-2">
                      {([
                        { id: 'picture' as const, label: 'Picture' },
                        { id: 'list' as const, label: 'List' },
                      ]).map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          aria-pressed={weightView === v.id}
                          onClick={() => setWeightView(v.id)}
                          className={`press rounded-full border px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors ${
                            weightView === v.id ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
                          }`}
                        >
                          {v.label}
                        </button>
                      ))}
                    </span>
                  </div>

                  {heldSeed ? (
                    /* HOLDINGS-BACKED (the picker path): no funding question
                       exists — the money is what's already held. State the
                       fact where the new-money controls would sit, in the
                       same teal voice as the review's seed strip so the two
                       pages tell one story. How much converts is the
                       review's choice (seedPct); nothing is typed here. */
                    <div className="mt-6 rounded-xl border border-teal/25 bg-teal/[0.04] px-4 py-3">
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-teal">
                        from what you already hold · no new money
                      </p>
                      <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-ink-dim">
                        <span className="font-num font-semibold tabular-nums text-ink">{formatUsdCompact(heldSeed.usd)}</span> across{' '}
                        {heldSeed.count} position{heldSeed.count === 1 ? '' : 's'} · shape the mix here; how much of it converts is set at
                        review
                      </p>
                    </div>
                  ) : draft.funding ? null : (
                    /* NO MONEY QUESTION HERE (the owner's ruling, 2026-08-03 ~23:1x:
                       "in the create flow you must choose an amount of money on
                       the weight page, which shouldnt happen") — weights are
                       pure proportions on EVERY path now; the amount and
                       pay-with ask lives at the review, where funding is the
                       subject. Same grammar as the held-seed fact above, so
                       both paths tell one story and the exit line's promise is
                       kept by the next page. A REBALANCE draft says nothing at
                       all: its funding was composed on the reshape board and
                       the review asks no money question there. */
                    <p className="mt-6 font-mono text-[11px] leading-relaxed text-ink-dim">
                      shape the mix here · how much you invest, and what you pay with, are set at review
                    </p>
                  )}

                  {/* THE PICTURE (desk 24): the draft as the reshape bento —
                      tiles sized by weight, tap to reshuffle in a fixed dial
                      slot, an add bar beneath. Weights re-land on exactly 100
                      every dial, so the balance gate is satisfied by
                      construction and the Total banner has nothing to say. */}
                  {weightView === 'picture' && (
                    <div className="mt-8">
                      <div className="h-[340px]">
                        <BasketBento
                          items={norm.map(
                            (t): BentoItem => ({
                              id: assetKey(t.asset),
                              symbol: t.asset.symbol,
                              address: t.asset.address,
                              chainId: t.asset.chainId,
                              weightPct: Math.max(t.pct, 1.6),
                              labelPct: t.pct,
                              transitionName: vtNames.get(assetKey(t.asset)),
                            }),
                          )}
                          fill
                          animateLayout
                          layoutMotion={wDialing ? 'live' : 'glide'}
                          selectedId={wDial}
                          onSelect={(id) => setWDial((k) => (k === id ? null : id))}
                        />
                      </div>
                      {/* the dial slot — fixed height, always there; the grid
                          below never reflows on tap (the reshape law) */}
                      <div
                        role={wDial ? 'group' : undefined}
                        aria-label={wDial ? `Reweight ${showSymbol(norm.find((t) => assetKey(t.asset).toLowerCase() === wDial)?.asset.symbol)}` : undefined}
                        className="relative mt-3 flex min-h-[64px] items-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-2 sm:h-[64px]"
                      >
                        {(() => {
                          const t = wDial ? norm.find((x) => assetKey(x.asset).toLowerCase() === wDial) : null
                          if (!t)
                            return (
                              <p className="flex items-center gap-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-ink-dim">
                                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-cyan" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <g>
                                    <animateTransform attributeName="transform" type="translate" values="0 0; 1.6 1.6; 0 0" keyTimes="0; 0.35; 1" dur="2.2s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" />
                                    <path d="M5 3l14 7-6.5 1.5L9 18z" fill="currentColor" fillOpacity="0.18" />
                                  </g>
                                </svg>
                                Tap a tile to set its share
                              </p>
                            )
                          const key = assetKey(t.asset)
                          return (
                            <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="flex min-w-0 items-center gap-2">
                                <AssetLogo address={t.asset.address} symbol={t.asset.symbol} chainId={t.asset.chainId} size={24} />
                                <span className="truncate font-display text-sm font-bold text-ink">${showSymbol(t.asset.symbol)}</span>
                                <span className="font-num text-sm font-semibold tabular-nums text-ink-dim">{t.pct.toFixed(0)}%</span>
                              </span>
                              <div className="min-w-[160px] flex-1">
                                <TrimBar
                                  symbol={t.asset.symbol}
                                  cur={0}
                                  target={t.pct}
                                  scaleUsd={100}
                                  isNew
                                  onTarget={(pct) => {
                                    markWDialing()
                                    setNormalizedPct(key, pct)
                                  }}
                                />
                              </div>
                              {amount != null && (
                                <span className="whitespace-nowrap font-num text-xs tabular-nums text-ink-faint">
                                  {formatUsdCompact((amount * t.pct) / 100)}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setDraft(removeTarget(draft, t.asset))
                                  setWDial(null)
                                }}
                                aria-label={`Remove ${showSymbol(t.asset.symbol)}`}
                                className="press grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-magenta/60 hover:text-magenta"
                              >
                                ✕
                              </button>
                              <button
                                type="button"
                                onClick={() => setWDial(null)}
                                aria-label={`Done reweighting ${showSymbol(t.asset.symbol)}`}
                                className="press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-teal/40 bg-teal/[0.08] px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-teal hover:border-teal/70"
                              >
                                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <path d="M5 13l4 4L19 7" />
                                </svg>
                                Done
                              </button>
                            </div>
                          )
                        })()}
                      </div>
                      {/* the add bar (his spec: "a bar where you can type to
                          add other assets") — floating results, the grid
                          never moves. Hidden on the picker-hosted publish
                          (heldSeed + chromeless): the picks page owns the
                          SET there ("Back to your picks"); an add would be
                          money the wallet doesn't hold. */}
                      {!(heldSeed && chromeless) && (
                        <WeightAddBar taken={new Set(draft.targets.map((t) => assetKey(t.asset)))} onAdd={addAssetPreserving} disabled={full} />
                      )}
                    </div>
                  )}

                  {/* Weights are ABSOLUTE percentages (the owner 18:41): a stepper
                      moves ONE row and never the others; the total is the
                      user's to land on 100, and the review gate holds until
                      it does. */}
                  {weightView === 'list' && (
                  <div className="mt-8 space-y-3">
                    {draft.targets.map((t, ti) => (
                      <div
                        key={assetKey(t.asset)}
                        className="group flex h-14 items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-4 transition-colors duration-500 hover:border-white/20 hover:bg-white/[0.04]"
                      >
                        <span className="flex w-32 items-center gap-3">
                          <AssetLogo address={t.asset.address} symbol={t.asset.symbol} chainId={t.asset.chainId} size={28} />
                          <span className="font-display text-sm font-bold text-ink">${showSymbol(t.asset.symbol)}</span>
                        </span>
                        <span className="relative hidden h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06] sm:block">
                          <span
                            aria-hidden
                            className="absolute inset-y-0 left-0 rounded-full transition-[width,background] duration-500"
                            style={{
                              width: `${Math.min(100, t.weight)}%`,
                              // over-allocated mixes say so in color, row by row;
                              // otherwise each asset wears ITS segment color —
                              // the same one it keeps on the review bar and the
                              // portfolio segments (one color story, end to end)
                              background:
                                sum > 100
                                  ? 'linear-gradient(90deg,var(--color-amber),var(--color-magenta))'
                                  : SEG[ti % SEG.length],
                              transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)',
                            }}
                          />
                        </span>
                        <span className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setDraft(setTargetWeight(draft, t.asset, t.weight - 5))}
                            aria-label={`Decrease ${showSymbol(t.asset.symbol)} weight`}
                            className="press grid h-8 w-8 place-items-center rounded-lg border border-white/15 font-mono text-[13px] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                          >
                            −
                          </button>
                          <span className="w-12 text-center font-num text-sm font-semibold tabular-nums text-ink">{t.weight}%</span>
                          <button
                            type="button"
                            onClick={() => setDraft(setTargetWeight(draft, t.asset, t.weight + 5))}
                            aria-label={`Increase ${showSymbol(t.asset.symbol)} weight`}
                            className="press grid h-8 w-8 place-items-center rounded-lg border border-white/15 font-mono text-[13px] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                          >
                            +
                          </button>
                        </span>
                        <span className="w-20 text-right font-num text-sm tabular-nums text-ink-dim">
                          {/* ⚠ THE NORMALIZED SHARE, the same number Picture shows and the
                              composer allocates (adversarial review, 2026-08-08). This read
                              `t.weight`, the RAW dial value, while Picture reads the
                              normalized pct — so with three assets dialled to 40 (sum 120)
                              on $10,000 the List said $4,000 each, i.e. $12,000 of a $10,000
                              investment, and toggling the view changed the figure for the
                              same asset. The Review button is gated on sum === 100 so it
                              could never reach a signature, but it was a wrong money figure
                              on screen for the whole dialling session. `norm` already carries
                              the usd the composer will use — read it rather than re-deriving. */}
                          {amount != null
                            ? formatUsdCompact(norm.find((n) => n.asset.address === t.asset.address)?.usd ?? 0)
                            : '—'}
                        </span>
                        {/* REVEAL ON HOVER ONLY WHERE HOVER EXISTS (QOL
                            2026-08-07). This was opacity-0 until group-hover, so
                            on a phone List view had NO visible way to drop an
                            asset at all — the same hover-only class the mobile
                            sweep found on the bento previews. The dial's own ✕ in
                            Picture view is always visible at 32px; this now
                            matches it on touch and keeps the quiet reveal on a
                            pointer device. */}
                        <button
                          type="button"
                          onClick={() => setDraft(removeTarget(draft, t.asset))}
                          aria-label={`Remove ${showSymbol(t.asset.symbol)}`}
                          className="press grid h-9 w-9 place-items-center rounded-full text-ink-faint transition-opacity hover:text-magenta focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                  )}

                  {/* the running total — teal when it lands, amber under, magenta over
                      (list only: the picture re-lands on exactly 100 every dial,
                      and a banner that always says 100% says nothing) */}
                  {weightView === 'list' && (
                  <div
                    className={`mt-6 flex h-12 items-center justify-between rounded-2xl border px-4 transition-all duration-500 ${
                      sum === 100
                        ? 'border-teal/40 bg-teal/[0.04] shadow-[0_0_20px_rgba(52,214,196,0.15)]'
                        : 'border-white/10 bg-white/[0.02]'
                    }`}
                  >
                    <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">Total</span>
                    <span
                      className={`font-num text-base font-semibold tabular-nums ${
                        sum === 100 ? 'text-teal' : sum < 100 ? 'text-amber-300/90' : 'text-magenta'
                      }`}
                    >
                      {sum}%
                      {sum !== 100 && (
                        <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em]">
                          {sum < 100 ? `add ${100 - sum}%` : `remove ${sum - 100}%`}
                        </span>
                      )}
                    </span>
                  </div>

                  )}

                  <div className="mt-8 flex flex-wrap items-center gap-4">
                    {/* picker-hosted publish: the host header's "Back to your
                        picks" owns set changes — the flow's choose station
                        would add assets the wallet doesn't hold */}
                    {!(heldSeed && chromeless) && (
                      <button type="button" onClick={() => setStation('choose')} className={ghostBtn}>
                        ← Back
                      </button>
                    )}
                    {draft.targets.length > 1 && (
                      <button type="button" onClick={() => setDraft(evenSplit(draft))} className={ghostBtn}>
                        Even it out
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void copyTargets(JSON.stringify({ targets: draft.targets, name: draft.name }))}
                      className={ghostBtn}
                    >
                      {targetsCopied ? 'Copied ✓' : 'Export targets'}
                    </button>
                    <span className="font-mono text-[10px] text-ink-faint">
                      targets live on THIS device
                      <InfoDot>
                        Your position is readable from your wallet on any device, but these
                        target weights are your intent and exist only here. Export copies them
                        as text you can keep or move; your holdings are never at risk either way.
                      </InfoDot>
                    </span>
                    <button
                      type="button"
                      /* weights-only gate (the 0.1 ruling): the amount is no
                         longer this station's business on any view */
                      disabled={draft.targets.length === 0 || sum !== 100}
                      onClick={() => setStation(initialIntent ? 'review' : 'outcome')}
                      className={`${spectralBtn} ml-auto`}
                      style={{ background: SPECTRAL }}
                    >
                      {sum !== 100 && draft.targets.length > 0 ? 'Balance to 100% first' : 'Review'}
                      <Arrow />
                    </button>
                  </div>
                </div>
              )}

              {/* ── STATION 3 · OUTCOME — the question, asked where it is
                     concrete (the owner 20:26: "is this just for yourself, or do
                     you want to create a basket token for other people to
                     trade?" — the mutable/immutable fork, after the mix). */}
              {station === 'outcome' && (
                <div>
                  <div className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
                    Who is this for?
                  </div>
                  <div className="mt-6 grid gap-4 sm:grid-cols-2">
                    <DoorCard
                      title="Build a portfolio"
                      tagline={
                        <>
                          just for yourself
                          <br />
                          rebalance anytime
                        </>
                      }
                      glow="var(--color-cyan)"
                      cta="Choose"
                      scene={() => <SceneReweight />}
                      enterIndex={0}
                      connecting={false}
                      /* the mobile sweep: two full doors stacked ~800px of
                         phone; compact (the homepage's phone mount) halves it */
                      size={isPhone ? 'compact' : 'full'}
                      onOpen={() => {
                        setDraft(setIntent(draft, 'keep'))
                        setStation('review')
                      }}
                    />
                    <DoorCard
                      title="Create a basket token"
                      tagline="for others to trade · you earn the fees"
                      glow="var(--color-magenta)"
                      cta="Choose"
                      scene={() => <SceneBasketToken />}
                      enterIndex={1}
                      connecting={false}
                      size={isPhone ? 'compact' : 'full'}
                      onOpen={() => {
                        setDraft(setIntent(draft, 'publish'))
                        setStation('review')
                      }}
                    />
                  </div>
                  <div className="mt-8 flex flex-wrap items-center gap-4">
                    <button type="button" onClick={() => setStation('weight')} className={ghostBtn}>
                      ← Back
                    </button>
                    <span className="font-mono text-[11px] text-ink-faint">
                      still flippable at review; nothing is final until you confirm
                    </span>
                  </div>
                </div>
              )}

              {/* ── STATION 4 · REVIEW ─────────────────────────────────────── */}
              {station === 'review' && (
                <div>
                  {/* THE EXECUTE BUTTON LIVES TOP-RIGHT (the owner 2026-08-06:
                      "there is no execution button… should be in the top
                      right, same structure as the page before" — the old
                      bottom placement sat below the popup's one-viewport
                      fold, i.e. functionally absent) */}
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
                      {draft.intent === 'publish'
                        ? publishBundle
                          ? 'Your bundle, before anything deploys'
                          : 'Your basket, before anything deploys'
                        : 'Your portfolio, before anything moves'}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {/* the EXACT page-1 button (the owner 12:49: "the execute
                          button has a different gradient… should be the same
                          as the first page, same spot") — the kit's
                          .spectral-btn class, page 1's own type scale */}
                      <button
                        type="button"
                        onPointerDown={capturePress}
                        onClick={beginExecute}
                        disabled={executeDisabled}
                        className="spectral-btn press inline-flex h-11 items-center gap-2 rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:opacity-50"
                      >
                        {pubBusy
                          ? 'Preparing deploys…'
                          : draft.intent === 'publish'
                            ? publishBundle
                              ? `Publish on ${new Set(draft.targets.map((t) => t.asset.chainId)).size} networks →`
                              : 'Confirm & create →'
                            : 'Execute →'}
                      </button>
                      {pubRefusal && (
                        <p className="max-w-[32ch] text-right font-mono text-[10px] leading-relaxed text-amber-200/90">{pubRefusal}</p>
                      )}
                      {realPublish && publishBlockers.length > 0 && (
                        <p className="max-w-[34ch] text-right font-mono text-[10px] leading-relaxed text-amber-200/90">{publishBlockers[0]}</p>
                      )}
                      {realPublish ? null : amount == null ? (
                        <span className="font-mono text-[10px] text-ink-faint">set an amount to confirm</span>
                      ) : seedBlocks.length > 0 && !seedOverridden ? (
                        /* the dead-confirm law: a disabled button states why */
                        <span className="font-mono text-[10px] text-ink-faint">a seed exceeds a leg&rsquo;s whole market</span>
                      ) : null}
                    </div>
                  </div>

                  {/* the door, still open — a starting posture, not a fork
                      (rework spec: flippable at review, reversible after).
                      NOT on a rebalance: a funding draft changes a portfolio
                      you already hold, `setIntent` refuses to publish it, and
                      rendering a switch that cannot throw is a dead control. */}
                  {!draft.funding && (
                  <div className="mt-6 flex flex-wrap gap-2">
                    {(
                      [
                        { v: 'keep' as FlowIntent, t: 'Keep it', s: 'an allocation for me' },
                        { v: 'publish' as FlowIntent, t: 'Publish it', s: 'baskets others can buy' },
                      ] as const
                    ).map((o) => (
                      <button
                        key={o.v}
                        type="button"
                        onClick={() => setDraft(setIntent(draft, o.v))}
                        aria-pressed={draft.intent === o.v}
                        className={`press flex items-baseline gap-2 rounded-full border px-5 py-2 transition-colors ${
                          draft.intent === o.v
                            ? 'border-cyan/60 bg-cyan/[0.10] text-ink'
                            : 'border-white/12 text-ink-dim hover:border-white/30'
                        }`}
                      >
                        <span className="font-display text-sm font-bold uppercase tracking-[0.1em]">{o.t}</span>
                        <span className="font-mono text-[10px] text-ink-faint">{o.s}</span>
                      </button>
                    ))}
                  </div>
                  )}

                  {/* ── WHAT CHANGES, FIRST (owner 17:53: "it's still a bit
                      confusing as to what's actually happening… this is the
                      summary, you're going to be decreasing these things,
                      adding a new asset, your total risk goes up to this").
                      The resulting mix answers "what will I hold"; this
                      answers "what is about to happen to me", which is the
                      question someone at this screen is actually asking. */}
                  {draft.intent === 'keep' && changes.length > 0 && (
                    <div className="mt-8">
                      {/* heading at reading size (13:19: "make the what-changes
                          text bigger") + the run's SHAPE beside it (his call:
                          "the three networks, three transactions, five assets
                          should sit at the top") */}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">What changes</p>
                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                          {netCount} network{netCount === 1 ? '' : 's'} · {netCount} transaction{netCount === 1 ? '' : 's'} · {norm.length} asset{norm.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {/* ONE LINE PER MOVE (the owner 2026-08-06: "a row of
                          different stuff with a nice little symbol, the
                          percentage change, the asset being changed and how
                          much it frees up or adds — it doesn't need to be a
                          table"): logo · verb $SYM · share from%→to% · the
                          uses/frees dollars. The magnitude fill stays (the
                          direction he liked); the from→to dollar column and
                          the realizes receipt ride the TITLE now — on screen
                          the row says exactly his four things. */}
                      <div className="mt-4 space-y-2">
                        {changes.map((c) => {
                          const freeing = c.deltaUsd < 0
                          const maxDelta = Math.max(...changes.map((x) => Math.abs(x.deltaUsd)), 1)
                          const fillPct = Math.max(6, (Math.abs(c.deltaUsd) / maxDelta) * 100)
                          const tone = freeing ? 'var(--color-cyan)' : 'var(--color-teal)'
                          const [cid, addr] = c.key.split(':')
                          const beforeTotal = beforeLegs.reduce((s, l) => s + l.usd, 0)
                          const afterTotal = draft.funding?.resultUsd ?? beforeTotal
                          const fromShare = beforeTotal > 0 ? (c.fromUsd / beforeTotal) * 100 : null
                          const toShare = afterTotal > 0 ? (c.toUsd / afterTotal) * 100 : null
                          const verb =
                            c.kind === 'exit'
                              ? 'Selling all of'
                              : c.kind === 'new'
                                ? 'Adding'
                                : c.kind === 'add'
                                  ? 'Adding to'
                                  : 'Trimming'
                          const receipt =
                            typeof c.realizedUsd === 'number' && Math.abs(c.realizedUsd) >= 0.01
                              ? ` · realizes ${c.realizedUsd >= 0 ? '+' : '−'}${formatUsdCompact(Math.abs(c.realizedUsd))} vs what you put in`
                              : ''
                          return (
                            <div
                              key={c.key}
                              title={`${formatUsdCompact(c.fromUsd)} → ${formatUsdCompact(c.toUsd)}${receipt}`}
                              className="relative flex h-12 items-center gap-3 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] pl-3 pr-4"
                            >
                              <span
                                aria-hidden
                                className="absolute inset-y-0 left-0 transition-[width] duration-700"
                                style={{
                                  width: `${fillPct}%`,
                                  background: `linear-gradient(90deg, color-mix(in srgb, ${tone} 4%, transparent), color-mix(in srgb, ${tone} 16%, transparent))`,
                                  transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)',
                                }}
                              />
                              <span
                                aria-hidden
                                className="absolute inset-y-0 w-px"
                                style={{ left: `${fillPct}%`, background: tone, opacity: 0.5 }}
                              />
                              <span className="relative shrink-0">
                                <AssetLogo address={addr} symbol={c.symbol} chainId={Number(cid)} size={24} />
                              </span>
                              <span className="relative min-w-0 flex-1 truncate text-[15px] text-ink">
                                {verb} <span className="font-display font-bold">${showSymbol(c.symbol)}</span>
                              </span>
                              {/* the share change reads at size, LEFT of the
                                  money (12:49: "the 13 to 12 needs to be a bit
                                  bigger and moved over to the left"); a rule
                                  line breaks it from the frees/uses */}
                              {fromShare != null && toShare != null && (fromShare >= 0.5 || toShare >= 0.5) && (
                                <span className="relative hidden font-num text-sm font-semibold tabular-nums text-ink sm:inline">
                                  {fromShare.toFixed(0)}% → {toShare.toFixed(0)}%
                                </span>
                              )}
                              <span aria-hidden className="relative hidden h-6 w-px bg-white/12 sm:block" />
                              {/* the WORD carries direction, never a minus */}
                              <span
                                className={`relative w-32 shrink-0 text-right font-num text-sm font-semibold tabular-nums ${freeing ? 'text-cyan' : 'text-teal'}`}
                              >
                                {freeing ? 'frees up ' : 'uses '}
                                {formatUsdCompact(Math.abs(c.deltaUsd))}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                      {(() => {
                        // WHAT IT COSTS TO GET OUT, the half that is knowable.
                        // The fee and the transaction count are already stated
                        // below as exact numbers. Slippage is NOT knowable
                        // without a live quote, so nothing here invents one —
                        // instead it states the FACT that decides it: whether a
                        // leg is a real slice of the pool it must trade through.
                        const thin = exitCost(
                          afterLegs.map((l) => ({
                            symbol: l.symbol,
                            usd: l.usd,
                            chainId: 0,
                            liquidityUsd: reviewMarket.get(l.key)?.liquidityUsd ?? null,
                          })),
                          uiFeeBps,
                        ).thin
                        if (thin.length === 0) return null
                        return (
                          <p className="mt-4 text-[13px] text-ink-dim">
                            {thin.slice(0, 2).map((t) => `$${showSymbol(t.symbol)} is ${t.poolSharePct.toFixed(0)}% of its pool`).join(' · ')}
                            <InfoDot>
                              How much of that pool&rsquo;s liquidity your position represents. A large
                              share means the price you get moves as you trade, in or out. The exact
                              cost comes from the quote at execution; nothing is estimated here.
                            </InfoDot>
                          </p>
                        )
                      })()}
                      {(() => {
                        // his "your total risk goes up to this", as the fact it
                        // can honestly be: the same tier read the portfolio
                        // page shows, before and after. Absent when the caps
                        // do not read, because a guess here would be exactly
                        // the score his own facts-only rule bars.
                        const was = volatileShareOf(beforeLegs)
                        const will = volatileShareOf(afterLegs)
                        if (was == null || will == null || Math.abs(will - was) < 1) return null
                        return (
                          <p className="mt-4 text-[13px] text-ink-dim">
                            Small caps &amp; new tokens:{' '}
                            <span className="font-num font-semibold tabular-nums text-ink">{was.toFixed(0)}%</span> →{' '}
                            <span className="font-num font-semibold tabular-nums text-ink">{will.toFixed(0)}%</span> of
                            your portfolio
                            <InfoDot>
                              Where this plan leaves your money on the market-cap spectrum. A measurement of
                              the mix, not a rating of it: nothing here scores the plan or tells you whether
                              to run it.
                            </InfoDot>
                          </p>
                        )
                      })()}
                    </div>
                  )}

                  {draft.intent === 'keep' && (() => {
                    // THE RESULTING MIX IS GONE ON A RESHAPE (the owner
                    // 2026-08-06: "kind of pointless — you already know what
                    // the mix is from the rebalance anyway"): What-Changes
                    // above names every acted-on row. A fresh create keeps
                    // the open list — there, every row IS the plan.
                    const rowsOpen = !draft.funding
                    return (
                    <div className="mt-8">
                      {/* the three count chips MOVED to the top of the review
                          (13:19) — one line beside the What-changes heading */}
                      {/* THE BREAKDOWN reads as a picture of the mix, not a
                          table of it (the owner: "beautify the way we show the
                          asset breakdown"). Each row is filled to its OWN
                          share in its segment colour, so the list can be
                          scanned down as a bar chart while the stacked bar
                          above still says it whole. The dot is retired — the
                          fill and the logo already carry identity, and three
                          identity marks on one row was the clutter. */}
                      {rowsOpen && (
                      <div className="space-y-2">
                        {norm.map((t, ti) => {
                          const c = SEG[ti % SEG.length]
                          let net = ''
                          try {
                            net = chainCfg(t.asset.chainId).name
                          } catch {
                            /* an unknown chain simply goes unnamed */
                          }
                          return (
                            <div
                              key={assetKey(t.asset)}
                              className="relative flex h-12 items-center gap-3 overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] pl-3 pr-4"
                            >
                              <span
                                aria-hidden
                                className="absolute inset-y-0 left-0 transition-[width] duration-700"
                                style={{
                                  width: `${t.pct}%`,
                                  background: c,
                                  opacity: 0.14,
                                  transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)',
                                }}
                              />
                              <span
                                aria-hidden
                                className="absolute inset-y-0 w-px transition-[left] duration-700"
                                style={{ left: `${t.pct}%`, background: c, opacity: 0.55, transitionTimingFunction: 'cubic-bezier(0.32,0.72,0,1)' }}
                              />
                              <span className="relative shrink-0">
                                <AssetLogo address={t.asset.address} symbol={t.asset.symbol} chainId={t.asset.chainId} size={24} />
                              </span>
                              <span className="relative font-display text-sm font-bold text-ink">${showSymbol(t.asset.symbol)}</span>
                              {/* The network earns a mention only when the plan
                                  actually spans networks (his board-only-on-
                                  change rule). It rides the RIGHT cluster, past
                                  the fill: a muted label sitting on a coloured
                                  wash is the contrast anti-pattern, and on a
                                  narrow row the fill's edge cut through it. */}
                              {/* ONE right-hand cluster owns the push (PM's
                                  finding). The push used to live on whichever
                                  optional child happened to render: the network
                                  label carried ml-auto but is display:none under
                                  sm, and the percent withheld ml-auto precisely
                                  when the network existed — so a MULTI-network
                                  plan under 640px had no pusher at all and the
                                  whole row packed left, while a single-network
                                  plan at the same width looked right. Alignment
                                  must not depend on WHICH children render, at
                                  any breakpoint, or the trap re-arms for the
                                  next optional child anyone adds. */}
                              <span className="relative ml-auto flex items-center gap-3">
                                {net && netCount > 1 && (
                                  <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim sm:inline">
                                    {net}
                                  </span>
                                )}
                                <span className="font-num text-xs tabular-nums text-ink-dim">{t.pct}%</span>
                                <span className="w-24 text-right font-num text-sm font-semibold tabular-nums text-ink">
                                  {/* on a rebalance the dollar base is the RESULTING
                                      portfolio value, not the new money (a pure-trim
                                      plan deploys $0 and would read as em-dashes) */}
                                  {draft.funding?.resultUsd
                                    ? formatUsdCompact((draft.funding.resultUsd * t.pct) / 100)
                                    : formatUsdCompact(t.usd)}
                                </span>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                      )}
                      {/* HOW IT FILLS — the channel checkout (blend spec):
                          the same diff, your choice of fill; the old
                          standalone Execution card is retired */}
                      <ChannelRow draft={draft} onPick={(c) => setDraft(setChannel(draft, c))} owner={address} />
                      {/* THE MONEY LINES, each on its own ground (owner 17:53:
                          "the screen's kind of dark, we need more padding for
                          how-it-fills and the other elements, and the funded
                          by / new money / batching fee — we can maybe have a
                          different background for each line to break it up").
                          Uniform panels with the result emphasised, not a
                          colour per line: these are neutral facts and colour
                          on a neutral fact reads as a verdict about it. */}
                      {/* compressed to h-9 rows (the owner 2026-08-06: the money
                          lines "need to be made smaller… everything needs to
                          fit in the viewport") */}
                      <div className="mt-5 space-y-1">
                      {/* THE FOLD'S HEAD (his #15): "Funded by · <number>" —
                          the money this plan draws on, trims plus anything new.
                          Only a rebalance has funding legs to fold; a plain buy
                          keeps its two lines as they were. */}
                      {draft.funding && (() => {
                        const fundedBy = (draft.funding.soldUsd ?? 0) + Math.max(0, amount ?? 0)
                        return (
                          <button
                            type="button"
                            onClick={() => setFundingOpen((v) => !v)}
                            aria-expanded={fundingOpen}
                            className="press flex h-9 w-full items-center gap-4 rounded-xl bg-white/[0.02] px-4 text-left transition-colors hover:bg-white/[0.04]"
                          >
                            <span className="flex flex-1 items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                              Funded by
                              <svg
                                viewBox="0 0 24 24"
                                className={`h-3.5 w-3.5 transition-transform duration-300 ${fundingOpen ? 'rotate-180' : ''}`}
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
                            <span className="font-num text-sm font-semibold tabular-nums text-ink">
                              {formatUsdCompact(fundedBy)}
                            </span>
                          </button>
                        )
                      })()}
                      {/* a positions-mode rebalance: the sell side SURVIVES the
                          handoff and the review states the funding honestly
                          (PM audit 2) */}
                      {draft.funding && fundingOpen && draft.funding.soldUsd > 0 && (
                        <div className="flex h-9 items-center gap-4 rounded-xl bg-white/[0.02] px-4">
                          <span className="flex flex-1 items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                            Funded by trims
                            <InfoDot>
                              {/* audit 2026-08-16: the old second clause ("in this
                                  preview nothing moves") predated the live
                                  sell-funds-buy lane and read as a denial of the
                                  sales this same screen signs */}
                              This plan sells {formatUsdCompact(draft.funding.soldUsd)} of what you
                              hold to fund the buys; anything beyond that is new money. The sales
                              run first, each with its own floor, and their proceeds fund the buys.
                            </InfoDot>
                          </span>
                          {/* no minus: "funded by trims" already carries the
                              direction, and his 16:22 ruling is that the WORD
                              does that job, never a negative number */}
                          <span className="font-num text-sm font-semibold tabular-nums text-magenta">
                            {formatUsdCompact(draft.funding.soldUsd)}
                          </span>
                        </div>
                      )}
                      {draft.funding && fundingOpen && (
                        <div className="flex h-9 items-center gap-4 rounded-xl bg-white/[0.02] px-4">
                          <span className="flex flex-1 items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                            New money
                            <InfoDot>
                              What this plan needs beyond your trims and cash. Settle it here:
                              fund the difference when the run asks for it, or step back and free
                              up more first; nothing is committed until you confirm.
                            </InfoDot>
                          </span>
                          <span className={`font-num text-sm font-semibold tabular-nums ${(amount ?? 0) > 0.5 ? 'text-amber-300/90' : 'text-ink'}`}>
                            {(amount ?? 0) < 0.005 ? '$0' : formatUsdCompact(amount ?? 0)}
                          </span>
                        </div>
                      )}
                      {/* THE TOP-UP SETTLES HERE (the owner 16:22: "that honestly
                          should be done in the review stage") — the plan says
                          plainly what it needs and where it comes from */}
                      {draft.funding && (amount ?? 0) > 0.5 && (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-amber-300/[0.06] px-4 py-3">
                          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-amber-300/90">
                            this plan needs {formatUsdCompact(amount ?? 0)} you don’t hold yet
                          </span>
                          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                            fund it when the run asks, or go back and free up more
                          </span>
                        </div>
                      )}
                      {/* the fee folds WITH the funding legs, and stands alone
                          on a plain buy — where there is no fold to hide it in */}
                      {(!draft.funding || fundingOpen) && (
                      <div className="flex h-9 items-center gap-4 rounded-xl bg-white/[0.02] px-4">
                        <span className="flex flex-1 items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                          Batching fee
                          {/* "never charged on exit" NARROWED to what it always
                              meant — redeeming a basket (the owner 2026-08-06
                              ~15:2x, ruling that range orders pay 0.50% on
                              realised withdrawals). The old wording was written
                              before range orders existed and would have read as
                              a promise this new product breaks; it says the
                              same thing about baskets and no longer implies
                              something we do not mean. */}
                          {/* ⚠ EVERY PERCENTAGE HERE IS COMPUTED, NEVER TYPED
                              (the owner's 2026-08-07 ruling moved this number and
                              the literal "0.50%" that used to sit in this
                              sentence is exactly how a shown fee drifts from a
                              charged one). The 0x line is gated on the COMPOSE
                              PATH, not on the constant existing: 0x's cut is
                              real only where 0x is in the route, so stating an
                              all-in figure while that path is dark would be a
                              false sentence about money. */}
                          <InfoDot>
                            A flat {feePctLabel(uiFeeBps)} on the buys, never capped by size
                            (the contract&rsquo;s hard ceiling is {feePctLabel(PORTFOLIO_MAX_FEE_BPS)}), never charged when you redeem
                            a basket, a rebalance charged once on the buys of the difference only.
                            On batched buys it is included INSIDE the price you&rsquo;re shown and any
                            route comparison; the one exception is a direct PRISM leg, whose card
                            states its {feePctLabel(batchFeeBpsFor(PRISM_CLAIM_CHAIN_ID))} on top. It buys
                            and burns PRISM rather than being revenue.
                            {ZEROEX_COMPOSE_ENABLED && (
                              <>
                                {' '}Where a buy routes through 0x, the aggregator takes a further{' '}
                                {feePctLabel(ZEROEX_TAKER_FEE_BPS)} of its own inside the quote —
                                not ours, and not something we can waive — so those legs cost{' '}
                                {feePctLabel(allInFeeBps(true, uiFeeBps))} all-in.
                              </>
                            )}
                            {RANGE_ORDERS_ENABLED && (
                              <>
                                {' '}A range order is its own product and prices separately:{' '}
                                {feePctLabel(RANGE_ORDER_FEE_BPS)} of what a position actually
                                converted, taken only when you withdraw it.
                              </>
                            )}
                          </InfoDot>
                        </span>
                        <span className="font-num text-sm font-semibold tabular-nums text-teal">
                          {/* fees charge the BUY side of the diff — gross buys
                              on a rebalance, the invested amount otherwise.
                              No base yet (no amount typed) → an unknown fee is
                              a dash, never "$0.00": zero reads as "free". */}
                          {/* ⚠ THROUGH feeCentsOfTotal, THE FUNCTION THAT CHARGES IT
                              (adversarial review, 2026-08-08). This was hand-rolled
                              arithmetic with toFixed(2), which ROUNDS while the charge
                              FLOORS — measured a cent high at $999.99, $1,234.56, $12.49
                              and $99,999.99. A shown fee derived independently of the
                              charged fee is the same defect class as the shown-vs-signed
                              floor, one surface over.
                              AND `?? amount` WAS WRONG ON A REBALANCE: amountUsd is NET
                              NEW MONEY there, so a pure rotation (sell $50k of A, buy
                              $50k of B) has amount 0 and rendered "$0.00" against a
                              charged $200 — the exact "zero reads as free" the comment
                              above forbids. grossBuysUsd missing now falls to the dash. */}
                          {(() => {
                            const base = draft.funding ? draft.funding.grossBuysUsd : amount
                            return base == null || !Number.isFinite(base)
                              ? '—'
                              : `$${(feeCentsOfTotal(Math.round(base * 100), uiFeeBps) / 100).toFixed(2)}`
                          })()}
                          {/* the same-row honesty (audit 2026-08-16): the dollar
                              is OUR charged pull; the tooltip's 0.55% all-in on
                              0x legs contradicted it silently. 0x's skim lives
                              INSIDE its quoted prices (a delivery haircut, not a
                              pull), so it cannot honestly join the dollar — it
                              gets named beside it instead. */}
                          {ZEROEX_COMPOSE_ENABLED && (
                            <span className="ml-1.5 font-mono text-[10px] font-normal text-ink-faint">
                              + 0x&rsquo;s {feePctLabel(ZEROEX_TAKER_FEE_BPS)} inside its quotes
                            </span>
                          )}
                        </span>
                      </div>
                      )}
                      <div className="flex h-14 items-center gap-4 rounded-xl bg-white/[0.05] px-4">
                        <span className="flex-1 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim">
                          {draft.funding ? 'Portfolio after this' : 'Total'}
                        </span>
                        <span className="font-num text-lg font-semibold tabular-nums text-ink">
                          {draft.funding?.resultUsd
                            ? formatUsdCompact(draft.funding.resultUsd)
                            : amount != null
                              ? formatUsdCompact(amount)
                              : '—'}
                        </span>
                      </div>
                      </div>
                    </div>
                    )
                  })()}

                  {draft.intent === 'publish' && (
                    <div className="mt-6">
                      {/* ONE basket on the front (the owner 18:41: "it's one
                          presentation… on the front end, but actually behind
                          the scenes it's two") — the product gets a name and
                          the whole mix; the per-network split is framed as
                          machinery, not as the thing itself.
                          BUNDLE MODE (the owner 2026-08-11): picks spanning
                          networks flip this card to bundle communication —
                          the Composer's exact grammar, derived from the
                          draft, never a toggle. */}
                      <div className={`rounded-2xl border p-5 ${publishBundle ? 'border-violet/25 bg-violet/[0.04]' : 'border-white/12 bg-white/[0.03]'}`}>
                        {publishBundle && (
                          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
                            <span className="font-display text-sm font-bold uppercase tracking-wide text-violet-bright">
                              You&rsquo;re composing a bundle
                            </span>
                            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim">
                              one basket per network · one name groups them
                            </span>
                          </div>
                        )}
                        {publishBundle && (
                          <div className="mb-4 flex flex-wrap gap-1.5">
                            {[...new Set(draft.targets.map((t) => t.asset.chainId))].map((cid) => {
                              const n = draft.targets.filter((t) => t.asset.chainId === cid).length
                              return (
                                <span key={cid} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/25 py-1 pl-1.5 pr-2.5">
                                  <ChainBadge chainId={cid} />
                                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim">
                                    {n === 1 ? 'one asset' : `${n} assets`} · its own basket
                                  </span>
                                </span>
                              )
                            })}
                          </div>
                        )}
                        <div className="relative max-w-[28ch]">
                          <input
                            value={draft.name ?? ''}
                            onChange={(e) => setDraft(setName(draft, e.target.value))}
                            maxLength={48}
                            placeholder={publishBundle ? 'Name your bundle' : 'Name your basket'}
                            aria-label={publishBundle ? 'Bundle name' : 'Basket name'}
                            className="w-full min-w-0 rounded-xl border border-cyan/40 bg-white/[0.04] px-4 py-2 font-display text-xl font-bold uppercase tracking-tight text-ink shadow-[0_0_20px_rgba(53,224,255,0.12)] outline-none transition-all placeholder:text-ink-faint/60 focus:border-cyan/80 focus:shadow-[0_0_28px_rgba(53,224,255,0.25)]"
                          />
                        </div>
                        {/* the REAL bento (owner 20:54) — the basket as it
                            will look, squarified by weight */}
                        {/* SEED DEPTH — the four-gaps fix: mintInKind CONVERTS
                            what it seeds; the choice keeps the private
                            portfolio alive alongside the published basket */}
                        {/* THE SEED, dialed not just picked (the owner 2026-08-06:
                            "how much of your individual [holdings] to put into
                            the basket vs just hold as assets… a slider and a
                            text button like 10/25/50/100 — a way nice slider
                            with the input area"). The drawn TrimBar is the
                            house money slider; presets snap it, the input
                            types it, one seedPct behind all three. The
                            thin-seed sentence is GONE (his call: "that
                            information is so confusing").
                            HIDDEN ON THE REAL PATH (2026-08-11): the ceremony
                            deploys unseeded and the single-network builder
                            owns its own real seed control — a live dial that
                            applies to neither would be a false promise. */}
                        {!realPublish && (
                        <div className="mt-5">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">Seed with</span>
                            <div className="min-w-[180px] flex-1">
                              <TrimBar
                                symbol="seed"
                                cur={0}
                                target={draft.seedPct ?? DEFAULT_SEED_PCT}
                                scaleUsd={100}
                                isNew
                                onTarget={(pct) => setDraft(setSeedPct(draft, Math.max(1, pct)))}
                              />
                            </div>
                            <span className="flex items-center gap-1 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-1.5">
                              <input
                                value={String(draft.seedPct ?? DEFAULT_SEED_PCT)}
                                onChange={(e) => {
                                  const n = Number(e.target.value.replace(/[^0-9]/g, ''))
                                  if (Number.isFinite(n)) setDraft(setSeedPct(draft, Math.min(100, Math.max(1, n))))
                                }}
                                inputMode="numeric"
                                aria-label="Seed percent"
                                className="w-10 bg-transparent text-right font-num text-sm font-semibold tabular-nums text-ink outline-none"
                              />
                              <span className="font-mono text-[11px] text-ink-faint">%</span>
                            </span>
                            <span className="flex gap-1.5">
                              {[10, 25, 50, 100].map((pc) => (
                                <button
                                  key={pc}
                                  type="button"
                                  onClick={() => setDraft(setSeedPct(draft, pc))}
                                  aria-pressed={(draft.seedPct ?? DEFAULT_SEED_PCT) === pc}
                                  className={`press h-8 rounded-full border px-3 font-mono text-[11px] uppercase tracking-wide ${
                                    (draft.seedPct ?? DEFAULT_SEED_PCT) === pc
                                      ? 'border-cyan/60 bg-cyan/15 text-cyan'
                                      : 'border-white/12 text-ink-dim hover:border-white/30'
                                  }`}
                                >
                                  {pc}%
                                </button>
                              ))}
                            </span>
                          </div>
                          {/* NUMBERS ONLY (his call: "just as the numbers —
                              how much will be put in versus how much is just
                              held individually; remove that text") */}
                          {draft.seedFrom && draft.seedFrom.length > 0 && (() => {
                            const held = draft.seedFrom.reduce((t, r) => t + r.heldUsd, 0)
                            const pc = (draft.seedPct ?? DEFAULT_SEED_PCT) / 100
                            return (
                              <div className="mt-4 grid grid-cols-2 gap-2">
                                <div className="rounded-xl border border-teal/25 bg-teal/[0.04] px-4 py-2.5">
                                  <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-teal">into the basket</p>
                                  <p className="font-num text-lg font-semibold tabular-nums text-ink">{formatUsdCompact(held * pc)}</p>
                                </div>
                                <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5">
                                  <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">stays held individually</p>
                                  <p className="font-num text-lg font-semibold tabular-nums text-ink">{formatUsdCompact(held * (1 - pc))}</p>
                                </div>
                              </div>
                            )
                          })()}
                        </div>
                        )}

                        {/* SEED-vs-DEPTH VERDICTS (the seed guard): the module's
                            own user-worded sentences, warns amber, blocks in the
                            refusal voice. A block bars Confirm below unless the
                            override is pressed — and the override acknowledges
                            THIS verdict set only; a changed mix re-asks. */}
                        {!realPublish && seedVerdicts.length > 0 && (
                          <div className="mt-4 space-y-2">
                            {seedVerdicts.map((v) => (
                              <p
                                key={`${v.symbol}:${v.code}`}
                                className={`rounded-xl border px-4 py-3 font-mono text-[11px] leading-relaxed ${
                                  v.severity === 'block'
                                    ? 'border-magenta/40 bg-magenta/[0.06] text-ink'
                                    : 'border-amber-300/30 bg-amber-300/[0.05] text-ink-dim'
                                }`}
                              >
                                {v.reason}
                              </p>
                            ))}
                            {seedBlocks.length > 0 && (
                              <button
                                type="button"
                                onClick={() => setSeedOverrideSig(seedOverridden ? null : seedBlockSig)}
                                aria-pressed={seedOverridden}
                                className={`press h-10 rounded-full border px-4 font-mono text-[11px] uppercase tracking-wide ${
                                  seedOverridden
                                    ? 'border-magenta/60 bg-magenta/10 text-magenta'
                                    : 'border-white/15 text-ink-dim hover:border-magenta/40'
                                }`}
                              >
                                {seedOverridden ? 'Proceeding despite the warnings above' : 'I understand · proceed anyway'}
                              </button>
                            )}
                          </div>
                        )}

                        {/* THE THESIS MOVED POST-SEED (the owner 2026-08-06:
                            "have the thesis stuff done once you've seeded —
                            there's a creator page setup [UIGuy] is working on
                            where everything would be done for the thesis
                            side"). The review asks only what launching needs;
                            the post-deploy ceremony + the creator page carry
                            the what-it-holds-and-why capture. The promotion
                            read's law (theses convert, hype doesn't) rides
                            THERE now, not here. */}
                        <div className="mt-4">
                          <BasketBento
                            items={norm.map((t) => ({
                              symbol: t.asset.symbol,
                              address: t.asset.address,
                              chainId: t.asset.chainId,
                              weightPct: t.pct,
                            }))}
                            aspect={2.8}
                          />
                        </div>
                      </div>

                      {new Set(norm.map((t) => t.asset.chainId)).size > 1 ? (
                        <div className="mt-3 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-4">
                          {/* less text, said as chips (the owner 2026-08-06) */}
                          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                            <span className="font-num text-sm font-semibold tabular-nums text-ink">
                              {new Set(norm.map((t) => t.asset.chainId)).size}
                            </span>
                            baskets under the hood · one per network · one basket on the front
                            <InfoDot>
                              Each asset trades on its own network, so the launch deploys one basket
                              per network and the site presents them as one. Buyers see and buy the
                              one basket.
                            </InfoDot>
                          </p>
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            {[...new Set(norm.map((t) => t.asset.chainId))].map((cid) => {
                              const group = norm.filter((t) => t.asset.chainId === cid)
                              const slice = group.reduce((s, t) => s + t.usd, 0)
                              return (
                                <div key={cid} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                                      <ChainIcon chainId={cid} />
                                      {netName(cid)}
                                    </span>
                                    <span className="font-num text-[12px] font-semibold tabular-nums text-ink-dim">{formatUsdCompact(slice)}</span>
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {group.map((t) => (
                                      <span key={assetKey(t.asset)} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] py-0.5 pl-0.5 pr-1.5">
                                        <AssetLogo address={t.asset.address} symbol={t.asset.symbol} chainId={t.asset.chainId} size={16} />
                                        <span className="font-mono text-[10px] text-ink-dim">${showSymbol(t.asset.symbol)}</span>
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : (
                        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                          one basket · every asset already trades on the same network
                        </p>
                      )}
                    </div>
                  )}

                  {draft.intent === 'publish' ? (
                    <p className="mt-6 text-center text-[13px] leading-relaxed text-ink-dim">
                      {new Set(norm.map((t) => t.asset.chainId)).size > 1
                        ? `Publishing freezes your mix as ${new Set(norm.map((t) => t.asset.chainId)).size} immutable basket tokens, one per network, that others can buy.`
                        : 'Publishing freezes your mix as an immutable basket token others can buy.'}
                      <InfoDot>
                        Your own holdings become the basket&rsquo;s first mint, deposited in
                        kind, nothing sold and bought back. If your holdings have drifted from
                        these targets, you balance first so the frozen mix is the one you chose.
                        Behind the scenes: one ordinary basket per network, each a real deploy;
                        your signature, a launch fee read live at signing (never quoted in
                        advance), same-network launches queueing behind a short cooldown shown
                        honestly, different networks in parallel. Never one cross-chain token.
                        Anything you keep stays yours to change.
                      </InfoDot>
                    </p>
                  ) : (
                    <p className="mt-6 flex items-center justify-center gap-3 text-center text-[14px] text-ink">
                      <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-teal" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M4 7h13" />
                        <path d="M13 3l4 4-4 4" />
                        <path d="M20 17H7" />
                        <path d="M11 13l-4 4 4 4" />
                      </svg>
                      {/* his words, verbatim (17:53), em-dash gone */}
                      This is a swap, not a deposit. Don&rsquo;t worry, everything lands in your own wallet.
                      <InfoDot>
                        Self-custody the whole way: you swap from your own funds into these
                        assets; no basket token is minted for a portfolio (that happens only if
                        you publish). Routing is handled for you across the networks where these
                        assets trade; your wallet approves each step. In this preview nothing is
                        spent and no cost is estimated; no number appears before the chain can
                        back it.
                      </InfoDot>
                    </p>
                  )}

                  {heldSeed == null && !draft.funding && (
                    /* THE FUNDING CLUSTER — the money question's ONE home (the
                       0.1 ruling: it left the weight station on every path;
                       here funding is the subject). Two paths never see it:
                       held-seed (their money is what's already held; the seed
                       strip's convert control answers funding) and REBALANCE
                       drafts (composeRebalance already recorded the net
                       new-money figure — an editable field here would clobber
                       the composed ends, the buildPublishDraft lesson class).
                       Always mounted on new-money reviews: the confirm gates
                       on the amount, so the amount stays on screen and
                       editable — and the old `amount == null` guard unmounted
                       the input at the FIRST keystroke (typing "500" stranded
                       the plan at $5), which this replaces. */
                    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-4">
                      <div className="flex flex-wrap items-end justify-between gap-4">
                        <div>
                          <label htmlFor="alloc-amount" className="font-display text-base font-bold uppercase tracking-[0.12em] text-ink">
                            Investing
                          </label>
                          {/* the glowing outline says "type here" (owner 20:42) */}
                          <div className="relative mt-2 flex h-12 w-[min(16rem,100%)] items-center rounded-2xl border border-cyan/40 bg-white/[0.04] px-4 shadow-[0_0_24px_rgba(53,224,255,0.15)] transition-all focus-within:border-cyan/80 focus-within:shadow-[0_0_32px_rgba(53,224,255,0.3)]">
                            <span className="mr-2 font-num text-xl text-ink-faint">$</span>
                            <input
                              id="alloc-amount"
                              value={amountText}
                              onChange={(e) => commitAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                              inputMode="decimal"
                              placeholder="0"
                              aria-label="Amount to invest in dollars"
                              className="w-full bg-transparent font-num text-2xl font-light tabular-nums text-ink outline-none placeholder:text-ink-faint/60"
                            />
                          </div>
                        </div>
                        {/* THE PERCENT CHIPS EXIST ONLY WHERE A WALLET TOTAL DOES
                            (QOL 2026-08-07). `walletUsd` is null for every live
                            user — useWalletValue deliberately reports no USD until
                            dollar pricing is wired — so these three rendered
                            permanently greyed under the caption "reading your
                            wallet…", an in-flight read that could never resolve.
                            Same rule ShareBasket states for a clipboard it cannot
                            reach: absent beats stuck, because a control that never
                            works teaches people the page is broken. A guest keeps
                            the honest line about connecting at the end. */}
                        <div className="pb-1">
                          {walletUsd != null && (
                            <div className="flex items-center gap-2">
                              {([0.25, 0.5, 1] as const).map((f) => (
                                <button
                                  key={f}
                                  type="button"
                                  onClick={() => chip(f)}
                                  className="press h-10 rounded-full border border-white/12 px-5 font-mono text-[12px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan"
                                >
                                  {f === 1 ? 'Max' : `${f * 100}%`}
                                </button>
                              ))}
                            </div>
                          )}
                          {(walletUsd != null || isGuest) && (
                            <p className="mt-2 text-right font-mono text-[10px] text-ink-faint">
                              {walletUsd != null
                                ? `of ${formatUsdCompact(walletUsd)} in your wallet`
                                : 'type any amount; you connect at the end'}
                            </p>
                          )}
                        </div>
                      </div>
                      {/* PAY WITH — his 20:54 ask, at its new home: choose what
                          you swap FROM. Auto (best available) is the braindead
                          default; real balances arrive with Phase-3 wiring. */}
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">Pay with</span>
                        {([['auto', 'Auto · best available'], ['USDC', 'USDC'], ['ETH', 'ETH']] as const).map(([v, o]) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setPayWith(v)}
                            aria-pressed={payWith === v}
                            className={`press h-10 rounded-full border px-4 font-mono text-[11px] uppercase tracking-wide ${
                              payWith === v
                                ? 'border-teal/60 bg-teal/10 text-teal'
                                : 'border-white/12 text-ink-dim hover:border-white/30'
                            }`}
                          >
                            {o}
                          </button>
                        ))}
                        {/* "the choice is recorded" was not true (QOL
                            2026-08-07): payWith is component state and nothing
                            reads it — not the draft, not the plan — so it is
                            discarded on every remount. Say what actually
                            happens rather than promise a memory we don't have. */}
                        <InfoDot>
                          What you swap FROM. Auto spends your most liquid funding assets first.
                          Nothing is read from your wallet in this preview, and the funding asset
                          is settled at execution — so this pick is a preference, not yet a
                          setting the plan carries.
                        </InfoDot>
                      </div>
                    </div>
                  )}

                  {/* ONE back button (the owner 12:49: "we have two back
                      buttons… should just have one, in the top"): a host
                      popup already carries BACK TO RESHAPE top-left, so the
                      flow's own Back renders only standalone (/create). */}
                  {/* ── CONFIRM SITS AT BOTH ENDS (the owner 2026-08-09: "needs to
                         be moved to the right hand side of the card in line
                         with the basket title entry area and also at the bottom
                         of the card right hand corner in line with back").
                         The top-right one is in line with the heading; this is
                         its twin at the foot, opposite Back — so a reader who
                         has scrolled the whole review does not have to scroll
                         back up to act on it. Same handler, same disabled
                         condition, same reason-when-disabled, because two
                         buttons that do one thing must never disagree about
                         whether that thing is available. ── */}
                  {!chromeless && (
                    <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
                      <button type="button" onClick={() => setStation(initialIntent ? 'weight' : 'outcome')} className={ghostBtn}>
                        ← Back
                      </button>
                      <div className="flex flex-col items-end gap-1.5">
                        <button
                          type="button"
                          onPointerDown={capturePress}
                          onClick={beginExecute}
                          disabled={executeDisabled}
                          className="spectral-btn press inline-flex h-11 items-center gap-2 rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:opacity-50"
                        >
                          {/* A DISABLED MONEY BUTTON MUST SAY WHY ON ITSELF (the owner, live
                              13:09: "I click Execute, nothing happens. I click it again,
                              then it works" — the amount was still indexing and the only
                              tell was an 11px caption). The button wears its own reason. */}
                          {amount == null
                            ? majorsRaw.isLoading
                              ? 'Reading your holdings…'
                              : 'Set an amount first'
                            : draft.intent === 'publish'
                              ? 'Confirm & create →'
                              : 'Execute →'}
                        </button>
                        {amount == null ? (
                          <span className="font-mono text-[10px] text-ink-faint">set an amount to confirm</span>
                        ) : seedBlocks.length > 0 && !seedOverridden ? (
                          <span className="font-mono text-[10px] text-ink-faint">a seed exceeds a leg&rsquo;s whole market</span>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── STATION 4 · EXECUTE ────────────────────────────────────── */}
              {station === 'execute' && (
                <div>
                  {/* THE REAL PATH'S VERDICT (a real wallet never sees the
                      simulated walk): armed — or the named refusal, with its
                      evidence. Nothing here runs timers; nothing pretends. */}
                  {arming && !computing && !plan && (
                    /* the tall centered shell fits a SPINNER, not the review:
                       once the armed review mounts, 72px of dead air above it
                       shoved the cards past the popup's foot (owner 2026-08-16:
                       "move it all up properly") — the review face sits at the
                       top with the section gap instead */
                    <div
                      className={arming.armed && runReview ? 'py-4' : 'grid place-items-center py-[72px] text-center'}
                      role="status"
                    >
                      {arming.armed ? (
                        <div className="mx-auto w-full max-w-[560px] text-left">
                          <div className="text-center font-display text-2xl font-bold uppercase tracking-tight text-ink">
                            Armed: this sends real transactions
                          </div>
                          {!runReview && !runReviewError && (
                            <div className="mt-4 text-center" role="status">
                              <span aria-hidden className="mx-auto block h-1 w-32 animate-pulse rounded-full bg-ink-faint/40" />
                              <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                                {runReviewPhase || 'reading your wallet and the markets…'}
                              </p>
                            </div>
                          )}
                          {runReviewError && (
                            <div className="mt-4 text-center">
                              <p className="text-[13px] leading-relaxed text-ink-dim">{runReviewError}</p>
                              <button type="button" onClick={() => setRunReviewError(null)} className={`${ghostBtn} mt-4`}>
                                Try again
                              </button>
                            </div>
                          )}
                          {runReview && (() => {
                            const rv = runReview // the guard's narrowing, captured for the closures
                            // landed-before-retry steps UNDER the live ones: a
                            // retried run's fresh state wins per key, the carried
                            // ✓s fill the keys the trimmed plan no longer runs
                            const stepByKey = new Map([
                              ...landedStepsRef.current,
                              ...(runner.state?.steps ?? []).map((x) => [x.key, x] as const),
                            ])
                            const liveStepFor = (pred: (q: (typeof rv.plan.steps)[number]) => boolean): RunStepState | undefined => {
                              const q = rv.plan.steps.find(pred)
                              return q ? stepByKey.get(stepKeyOf(q)) : undefined
                            }
                            const txHrefOf = (st: RunStepState | undefined): string | null => {
                              const id = st?.submissionId
                              if (!id) return null
                              try {
                                if (id.startsWith('tx:')) {
                                  const [, cid, hash] = id.split(':')
                                  return `${chainCfg(Number(cid)).explorer}/tx/${hash}`
                                }
                                if (id.startsWith('bridge:')) {
                                  const [, from, , hash] = id.split(':')
                                  return `${chainCfg(Number(from)).explorer}/tx/${hash}`
                                }
                              } catch {
                                return null
                              }
                              return null
                            }
                            const cardTone = (st: RunStepState | undefined): string => {
                              const active = st && (st.status === 'simulating' || st.status === 'awaiting-signature' || st.status === 'submitted')
                              const amber = st && (st.status === 'failed' || st.status === 'unresolved')
                              return amber
                                ? 'border-amber-300/30 bg-amber-300/[0.03]'
                                : st?.status === 'done'
                                  ? 'border-teal/30 bg-teal/[0.04]'
                                  : active
                                    ? 'scale-[1.005] border-cyan/40 bg-cyan/[0.05] shadow-[0_0_32px_rgba(53,224,255,0.12)]'
                                    : 'border-line/60 bg-white/[0.02]'
                            }
                            const isActive = (st: RunStepState | undefined) => !!st && (st.status === 'simulating' || st.status === 'awaiting-signature' || st.status === 'submitted')
                            return (
                            <div className="mt-5 space-y-3">
                              <RunProgressStyles />
                              {/* THE SALES, FIRST — the sell wiring pass
                                  (the owner's order, 2026-08-14): each sale is its
                                  own transaction; the plan spends only the
                                  FLOOR, and the router enforces it on-chain. */}
                              {runReview.sells.map((sale) => {
                                const st = liveStepFor((q) => q.action.kind === 'sell' && q.action.asset.toLowerCase() === sale.asset.toLowerCase() && q.action.chainId === sale.chainId && q.action.sellRaw === sale.sellRaw)
                                const href = txHrefOf(st)
                                return (
                                  <div key={`${sale.chainId}:${sale.asset}`} className={`relative overflow-hidden rounded-2xl border p-4 transition-all duration-500 sm:p-5 ${cardTone(st)}`}>
                                    {st?.status === 'done' && (
                                      <span key="done" aria-hidden className="trov-shimmer pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(100deg, transparent 35%, rgba(53,255,200,0.16) 50%, transparent 65%)', backgroundSize: '250% 100%' }} />
                                    )}
                                    <div className="relative flex items-end justify-between gap-3">
                                      <span className="inline-flex items-center gap-3">
                                        <ChainBadge chainId={sale.chainId} size="md" />
                                        <span className="font-display text-2xl font-bold tracking-tight text-ink">
                                          sell ${sale.symbol}
                                        </span>
                                        <span className="pb-1 font-num tabular-nums text-[14px] text-ink-dim">{Number(formatUnits(BigInt(sale.sellRaw), sale.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                                      </span>
                                      <span className="flex flex-col items-end pb-0.5">
                                        <span className="font-num text-[15px] tabular-nums text-ink-dim">≈ ${(sale.estCents / 100).toLocaleString()}</span>
                                        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">floor ${(sale.floorCents / 100).toLocaleString()}</span>
                                      </span>
                                    </div>
                                    <p className={`relative mt-2 text-[14px] leading-relaxed ${st?.status === 'done' ? 'text-teal' : st && (st.status === 'failed' || st.status === 'unresolved') ? 'text-amber-200/90' : isActive(st) ? 'text-ink' : 'text-ink-dim'}`}>
                                      {st ? runStepWords(st) : 'sells first · funds the buys'}
                                      {href && (
                                        <a href={href} target="_blank" rel="noreferrer" className="ml-2 font-mono text-[11px] text-cyan hover:underline">
                                          tx ↗
                                        </a>
                                      )}
                                    </p>
                                    {isActive(st) && <RunBeam accent="var(--color-cyan)" />}
                                  </div>
                                )
                              })}
                              {/* THE RENDERED REVIEW — these exact rows are what shownFor
                                  freezes at confirm; the gate refuses any signature that
                                  diverges from them. The approval line is the disclosure. */}
                              {/* TRANSFER CARDS — money traveling in, its whole story in-card */}
                              {runReview.plan.steps
                                .filter((q) => q.action.kind === 'bridge')
                                .map((q) => {
                                  const a = q.action as { fromChainId: number; toChainId: number; amountCents: number }
                                  const st = stepByKey.get(stepKeyOf(q))
                                  const href = txHrefOf(st)
                                  void bridgeTick
                                  const row = bridgeRows()
                                    .filter((r) => r.fromChainId === a.fromChainId && r.toChainId === a.toChainId && (runStartedAt == null || r.startedAt >= runStartedAt - 60_000))
                                    .sort((x, y) => y.startedAt - x.startedAt)[0]
                                  const landedRaw = bridgeArrivals[`${a.fromChainId}-${a.toChainId}`]
                                  const arrived = landedRaw != null
                                  let line: string
                                  if (arrived) line = `arrived — $${(Number(landedRaw) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} landed`
                                  else if (st && row && (st.status === 'submitted' || st.status === 'unresolved')) {
                                    const secs = Math.max(0, Math.floor((Date.now() - row.startedAt) / 1000))
                                    line = `${runStepWords(st)} · ${secs}s${row.etaSec != null ? ` of ~${row.etaSec}s` : ''}`
                                  } else if (st) line = runStepWords(st)
                                  else line = 'travels first'
                                  return (
                                    <div key={`${a.fromChainId}-${a.toChainId}`} className={`relative overflow-hidden rounded-2xl border p-4 transition-all duration-500 sm:p-5 ${arrived ? 'border-teal/30 bg-teal/[0.04]' : cardTone(st)}`}>
                                      <div className="relative flex items-end justify-between gap-3">
                                        <span className="inline-flex items-center gap-3">
                                          <ChainBadge chainId={a.fromChainId} size="md" />
                                          <span className="font-display text-2xl font-bold tracking-tight text-ink">${(a.amountCents / 100).toLocaleString()}</span>
                                          <span aria-hidden className="pb-0.5 text-[15px] text-ink-faint">→</span>
                                          <ChainBadge chainId={a.toChainId} size="md" />
                                        </span>
                                        {arrived && (
                                          <span className="text-lg text-teal" aria-hidden>
                                            ✓
                                          </span>
                                        )}
                                      </div>
                                      {!arrived && st && (st.status === 'submitted' || st.status === 'unresolved') && <BridgeRunnerGame />}
                                      <p className={`relative mt-2 text-[14px] leading-relaxed ${arrived ? 'text-teal' : st && (st.status === 'failed' || st.status === 'unresolved') ? 'text-amber-200/90' : isActive(st) ? 'text-ink' : 'text-ink-dim'}`}>
                                        {line}
                                        {href && (
                                          <a href={href} target="_blank" rel="noreferrer" className="ml-2 font-mono text-[11px] text-cyan hover:underline">
                                            tx ↗
                                          </a>
                                        )}
                                      </p>
                                      {isActive(st) && !arrived && <RunBeam accent="var(--color-cyan)" />}
                                    </div>
                                  )
                                })}
                              {/* ⚠ WHEN THE RUN IS DONE THE CARDS CONDENSE (the owner live
                                  2026-08-16: "the run complete stuff gets cut off on the
                                  card, when completed each of the buy phases should
                                  condense to make space"). A finished step's per-leg
                                  breakdown and running commentary were for WATCHING it;
                                  once it has landed the only facts that still matter are
                                  what filled and its receipt, and the space belongs to
                                  the completion plate the person is actually looking for.
                                  The popup does not scroll, so this is not cosmetic. */}
                              {/* CHAIN BUY CARDS — the pull, the approval fact, every leg,
                                  the live state and the tx: ONE card, nothing below it */}
                              {runReview.chains.map((c) => {
                                const st = liveStepFor((q) => q.action.kind === 'batch' && (q.action as { chainId: number }).chainId === c.chainId)
                                const href = txHrefOf(st)
                                const inbound = runReview.plan.steps.filter((q) => q.action.kind === 'bridge' && (q.action as { toChainId: number }).toChainId === c.chainId)
                                return (
                                  <div key={c.chainId} className={`relative overflow-hidden rounded-2xl border transition-all duration-500 ${runner.state?.phase === 'done' ? 'p-3' : 'p-4 sm:p-5'} ${cardTone(st)}`}>
                                    {st?.status === 'done' && (
                                      <span key="done" aria-hidden className="trov-shimmer pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(100deg, transparent 35%, rgba(53,224,255,0.18) 50%, transparent 65%)', backgroundSize: '250% 100%' }} />
                                    )}
                                    <div className="relative flex items-end justify-between gap-3">
                                      <span className="inline-flex items-center gap-3">
                                        <ChainBadge chainId={c.chainId} size="md" />
                                        <span className="font-display text-2xl font-bold tracking-tight text-ink">${(c.grossCents / 100).toLocaleString()}</span>
                                      </span>
                                      <span className="pb-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">approved exactly</span>
                                      {st?.status === 'done' && (
                                        <span className="text-lg text-teal" aria-hidden>
                                          ✓
                                        </span>
                                      )}
                                    </div>
                                    {/* watch-time context: gone once the step has landed */}
                                    {(runCashDrawCents > 0 || inbound.length > 0) && runner.state?.phase !== 'done' && (
                                      <div className="relative mt-2 flex flex-wrap items-center gap-2">
                                        {runCashDrawCents > 0 && (
                                          <span className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim">
                                            cash ${(runCashDrawCents / 100).toLocaleString()}
                                          </span>
                                        )}
                                        {inbound.map((q) => {
                                          const a = q.action as { fromChainId: number; amountCents: number }
                                          return (
                                            <span key={`in:${a.fromChainId}`} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim">
                                              ${(a.amountCents / 100).toLocaleString()} from {netShort(a.fromChainId)}
                                            </span>
                                          )
                                        })}
                                      </div>
                                    )}
                                    <div className={`relative space-y-2 ${runner.state?.phase === 'done' ? 'hidden' : 'mt-4'}`}>
                                      {c.legs.map((l) => (
                                        <div key={l.asset}>
                                          <div className="flex items-center justify-between text-[15px] text-ink-dim">
                                            <span className="inline-flex items-center gap-2 font-display font-bold uppercase tracking-wide text-ink">
                                              ${l.symbol}
                                              {l.symbol.toUpperCase() === 'ETH' && (
                                                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">arrives wrapped (WETH)</span>
                                              )}
                                            </span>
                                            <span className="font-num tabular-nums">
                                              ${(l.budgetUsdCents / 100).toLocaleString()}
                                              {st?.status === 'done' && <span className="ml-2 text-[12px] text-teal">bought ✓</span>}
                                              {l.optional && st?.status !== 'done' ? <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">skippable</span> : null}
                                            </span>
                                          </div>
                                          {/* THE SURFACED TOLERANCE (the owner's ruling, 2026-08-15: "for
                                              small caps we should allow open slippage but just surface
                                              it for people to be aware"). Only THIN legs say it: on a
                                              deep asset the tolerance is tens of bps and the line would
                                              be noise on every row. Stated in dollars because bps is
                                              not what a person is deciding with — the question they are
                                              actually answering is "what is the least I could walk away
                                              with", so that is the number shown. */}
                                          {l.thinMarket && l.toleranceBps != null && st?.status !== 'done' && (() => {
                                            const ovKey = `${c.chainId}:${l.asset.toLowerCase()}`
                                            const ov = floorOverrides[ovKey]
                                            const floorUsd = (
                                              (l.budgetUsdCents / 100) *
                                              (1 - (l.impactBps ?? 0) / 10_000) *
                                              (1 - (typeof ov === 'number' ? ov : l.toleranceBps) / 10_000)
                                            ).toLocaleString(undefined, { maximumFractionDigits: 0 })
                                            return (
                                              <div className="mt-1">
                                                <p className="text-[12px] leading-relaxed text-amber-200/70">
                                                  thin pool{l.impactBps != null ? ` — this size moves the price about ${Math.round(l.impactBps / 100)}%` : ''}, and it
                                                  can move again before it lands.{' '}
                                                  {ov === 'none'
                                                    ? 'NO FLOOR: you accept whatever the pool gives — possibly far less than shown, and no revert will save it.'
                                                    : `You get at least $${floorUsd} worth, or nothing is bought.`}
                                                </p>
                                                {/* the protection dial (the owner 2026-08-17): per-run
                                                    consent, offered ONLY on measured-thin legs — the
                                                    read-failed class never gets a dial, and nothing here
                                                    persists past this review */}
                                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">protection</span>
                                                  {([
                                                    ['standard', undefined],
                                                    ['loose · 20%', 2_000],
                                                    ['none', 'none'],
                                                  ] as const).map(([label, val]) => {
                                                    const active = val === undefined ? ov === undefined : ov === val
                                                    return (
                                                      <button
                                                        key={label}
                                                        type="button"
                                                        onPointerDown={capturePress}
                                                        onClick={() =>
                                                          setFloorOverrides((m) => {
                                                            const next = { ...m }
                                                            if (val === undefined) delete next[ovKey]
                                                            else next[ovKey] = val
                                                            return next
                                                          })
                                                        }
                                                        aria-pressed={active}
                                                        className={`press inline-flex h-7 items-center rounded-full border px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                                                          active
                                                            ? val === 'none'
                                                              ? 'border-alert/60 bg-alert/15 text-alert'
                                                              : 'border-amber-400/50 bg-amber-400/10 text-amber-200'
                                                            : 'border-white/10 text-ink-faint hover:border-white/30 hover:text-ink-dim'
                                                        }`}
                                                      >
                                                        {label}
                                                      </button>
                                                    )
                                                  })}
                                                </div>
                                              </div>
                                            )
                                          })()}
                                          {/* the pre-flight's REFUSED verdict, in the module's own
                                              words — the chain was asked before consent (unknown
                                              renders nothing, the module's law). THE DOOR RIDES IT
                                              (owner 2026-08-17, the LNOC wall): a leg the
                                              aggregator refuses at size can still fill on its own
                                              market through the fee wrapper — the click carves it
                                              into its own transaction, stated dollars and all. */}
                                          {(() => {
                                            const v = preflightMap.get(`${c.chainId}:${l.asset.toLowerCase()}`)
                                            const w = v ? preflightWords(l.symbol, v) : null
                                            if (!w || st?.status === 'done') return null
                                            const carved = directLegs.some((d) => d.chainId === c.chainId && d.asset.toLowerCase() === l.asset.toLowerCase())
                                            return (
                                              <div className="mt-1">
                                                <p className="text-[12px] leading-relaxed text-amber-200/90">{w}</p>
                                                {carved && (
                                                  <p className="mt-0.5 font-mono text-[11px] text-cyan/90">
                                                    ${showSymbol(l.symbol)} re-routes through its own market — runs with this plan ↓
                                                  </p>
                                                )}
                                              </div>
                                            )
                                          })()}
                                        </div>
                                      ))}
                                    </div>
                                    {/* the door also rides a PRE-FLIGHT refusal (audit
                                        2026-08-16): the leg rows above render preflightWords
                                        — "lower this holding or buy it on its own" — and a
                                        card with ONLY that refusal had no button at all;
                                        the same fresh rebuild is the same honest next move */}
                                    {(c.refusals.length > 0 ||
                                      c.legs.some((l) => preflightMap.get(`${c.chainId}:${l.asset.toLowerCase()}`)?.kind === 'refused')) && (
                                      <div className="relative mt-3 space-y-1.5">
                                        {c.refusals.map((r) => {
                                          // A refused leg with a nameable draft target AUTO-CARVES
                                          // (the owner 2026-08-18: routing decisions happen in the
                                          // background) — the effect below adds it to the direct
                                          // lane; this row states the re-route, never asks.
                                          const target = r.symbol
                                            ? norm.find((t) => t.asset.chainId === c.chainId && t.asset.symbol === r.symbol)
                                            : undefined
                                          const carved =
                                            !!target && directLegs.some((d) => d.chainId === c.chainId && d.asset.toLowerCase() === target.asset.address.toLowerCase())
                                          return (
                                            <div key={`${r.symbol}:${r.reason}`}>
                                              <p className="text-[13px] leading-relaxed text-amber-200/80">{r.reason}</p>
                                              {carved && (
                                                <p className="mt-0.5 font-mono text-[11px] text-cyan/90">
                                                  ${showSymbol(target!.asset.symbol)} re-routes through its own market — runs with this plan ↓
                                                </p>
                                              )}
                                            </div>
                                          )
                                        })}
                                        {/* THE DOOR RIDES EVERY REFUSAL ON THIS CARD, unconditionally
                                            (owner 2026-08-16, staring at a RequiredLegFailed preview
                                            refusal with no way forward: "also no retry button??").
                                            The runner card's door was prose-gated and this REVIEW
                                            surface had none at all — but every refusal here is
                                            pre-send by construction (the sim refused; nothing was
                                            signed), so a fresh rebuild is always safe and always
                                            the honest next move. The click IS the consent. */}
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => {
                                            runner.clear()
                                            autoRanRef.current = null
                                            setRunReview(null)
                                          }}
                                          title="Rebuilds the whole review on fresh quotes — the run already re-quoted a few times on its own before showing this."
                                          className="spectral-btn press mt-2 inline-flex h-10 items-center justify-center rounded-full px-5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-void"
                                        >
                                          Re-check on fresh prices and run →
                                        </button>
                                      </div>
                                    )}
                                    <p className={`relative mt-3 text-[14px] leading-relaxed ${st?.status === 'done' ? 'text-teal' : st && (st.status === 'failed' || st.status === 'unresolved') ? 'text-amber-200/90' : isActive(st) ? 'text-ink' : 'text-ink-dim'}`}>
                                      {st ? runStepWords(st) : runReview.sells.length > 0 || inbound.length > 0 ? 'runs after the money above' : 'runs first'}
                                      {href && (
                                        <a href={href} target="_blank" rel="noreferrer" className="ml-2 font-mono text-[11px] text-cyan hover:underline">
                                          tx ↗
                                        </a>
                                      )}
                                    </p>
                                    {/* THE SIM-ONLY CLASS RE-ROUTES ITSELF (the owner
                                        2026-08-18: "it should just do the decision/choice in
                                        the background… it should just happen auto as part of
                                        the flow"). RequiredLegFailed with the floor waived is
                                        the AGGREGATOR refusing the batcher-as-taker at size —
                                        an effect below auto-carves the named leg through the
                                        fee wrapper and runs it as part of this flow; this line
                                        only says where the leg went. */}
                                    {st?.status === 'failed' && st.failedLegIndex != null && c.legs[st.failedLegIndex] != null && (
                                      <p className="relative mt-1.5 font-mono text-[11px] text-cyan/90">
                                        ${showSymbol(c.legs[st.failedLegIndex].symbol)} re-routes through its own market — running below ↓
                                      </p>
                                    )}
                                    {isActive(st) && <RunBeam accent="var(--color-cyan)" />}
                                  </div>
                                )
                              })}
                              {directPrism && (
                                /* ONE LEG LIKE ANY OTHER (owner 2026-08-16: "way too much
                                   text and we shouldnt confuse the buyer by saying about
                                   running through its own pool it should be just part of
                                   the normal flow") — the routing mechanics left the card;
                                   what stays is the batch cards' own grammar: identity,
                                   money, one quiet status line. The fee stays because it
                                   is charged ON TOP of this leg (the number shown is the
                                   number that decides) — compressed to two words. */
                                <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                                  <div className="relative flex items-end justify-between gap-3">
                                    <span className="inline-flex items-center gap-3">
                                      <ChainBadge chainId={PRISM_CLAIM_CHAIN_ID} size="md" />
                                      <span className="font-display text-2xl font-bold tracking-tight text-ink">$PRISM</span>
                                    </span>
                                    <span className="font-num text-[15px] tabular-nums text-ink-dim">${(directPrism.usdCents / 100).toLocaleString()}</span>
                                  </div>
                                  <p className={`relative mt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] ${directRun.phase === 'done' ? 'text-teal' : directRun.phase === 'failed' ? 'text-amber-200/90' : directRun.phase === 'idle' ? 'text-ink-faint' : 'text-ink'}`}>
                                    {directRun.phase === 'idle' &&
                                      (directSwapWrapperFor(PRISM_CLAIM_CHAIN_ID) && INTERFACE_TAG_ADDRESS
                                        ? `runs last · +${(wrapperFeeBpsFor(PRISM_CLAIM_CHAIN_ID) / 100).toFixed(1)}% fee`
                                        : 'runs last')}
                                    {directRun.phase === 'quoting' && 'quoting…'}
                                    {directRun.phase === 'wallet' && 'check your wallet'}
                                    {directRun.phase === 'confirming' && 'confirming…'}
                                    {directRun.phase === 'done' && 'bought ✓'}
                                    {directRun.phase === 'failed' && (directRun.note ?? 'failed')}
                                    {directRun.hash && (
                                      <a href={`${chainCfg(PRISM_CLAIM_CHAIN_ID).explorer}/tx/${directRun.hash}`} target="_blank" rel="noreferrer" className="ml-2 font-mono text-[11px] normal-case text-cyan hover:underline">
                                        tx ↗
                                      </a>
                                    )}
                                  </p>
                                  {directRun.phase === 'failed' && (
                                    <div className="relative mt-2 flex flex-wrap items-center gap-2.5">
                                      <button
                                        type="button"
                                        onPointerDown={capturePress}
                                        onClick={() => void runDirectPrism()}
                                        className="press inline-flex h-10 items-center justify-center rounded-full border border-cyan/40 px-5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-cyan hover:border-cyan/70"
                                      >
                                        Try again →
                                      </button>
                                      <button
                                        type="button"
                                        onPointerDown={capturePress}
                                        onClick={() => setDirectPrismOpen((v) => !v)}
                                        className="press font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
                                      >
                                        {directPrismOpen ? 'hide manual buy' : 'manual buy'}
                                      </button>
                                    </div>
                                  )}
                                  {directPrismOpen && directRun.phase === 'failed' && (
                                    <div className="relative mt-3">
                                      <TradePrism buyOnly initialAmount={directPrism.ethAmount ?? undefined} />
                                    </div>
                                  )}
                                </div>
                              )}
                              {/* THE DIRECT-LANE LEGS the user carved by clicking a
                                  refusal/preflight door — each one leg like any other,
                                  filling through the fee wrapper on its own market */}
                              {directLegs.map((leg, i) => (
                                <DirectLegCard
                                  key={`${leg.chainId}:${leg.asset.toLowerCase()}`}
                                  spec={leg}
                                  autoRun={carveArmed && i === carveTurn}
                                  onTerminal={() => setCarveTurn((t) => (t === i ? t + 1 : t))}
                                />
                              ))}
                              {/* SALES THAT SIGN WITH ANOTHER WALLET (recording 1205) —
                                  named, grouped, with the switch instruction; they run
                                  when that wallet is the signer (the review rebuilds on
                                  the switch and picks them up) */}
                              {otherWalletSells.length > 0 && (
                                <div className="relative overflow-hidden rounded-2xl border border-violet-bright/25 bg-violet-bright/[0.04] p-5">
                                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-violet-bright">
                                    signs with {walletName(otherWalletSells[0].owner) ?? shortAddr(otherWalletSells[0].owner)}
                                  </p>
                                  <div className="mt-3 space-y-2">
                                    {otherWalletSells.map((o) => (
                                      <div key={`${o.chainId}:${o.symbol}`} className="flex items-center justify-between gap-3">
                                        <span className="inline-flex items-center gap-2.5">
                                          <ChainBadge chainId={o.chainId} size="sm" />
                                          <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">${showSymbol(o.symbol)}</span>
                                        </span>
                                        <span className="font-num text-[14px] tabular-nums text-ink-dim">
                                          sell ≈${o.usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                  <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] leading-relaxed text-ink-faint">
                                    that wallet holds these — switch to it in your wallet app and this review replans with them included
                                  </p>
                                </div>
                              )}
                              {/* THE CARVED BASKET SELLS (owner 2026-08-16: "wire this
                                  up it needs to work too") — each fills through the
                                  bundle machinery's own sell mode. Proceeds land in
                                  the WALLET, never in this batch, and the funding math
                                  above already excludes them. */}
                              {directBasketSells.map((b) => (
                                <div key={`sell:${b.chainId}:${b.address}`} className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                                  <div className="relative flex items-end justify-between gap-3">
                                    <span className="inline-flex items-center gap-3">
                                      <ChainBadge chainId={b.chainId} size="md" />
                                      <span className="font-display text-2xl font-bold tracking-tight text-ink">${showSymbol(b.symbol)}</span>
                                    </span>
                                    <span className="font-num text-[15px] tabular-nums text-ink-dim">sell ≈${b.freedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                                  </div>
                                  <div className="relative mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                                      runs on its own · proceeds land in your wallet
                                    </span>
                                    <button
                                      type="button"
                                      onPointerDown={capturePress}
                                      onClick={() => setSellOverlayFor({ chainId: b.chainId, address: b.address, symbol: b.symbol })}
                                      className="press inline-flex h-9 items-center rounded-full border border-cyan/40 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan hover:bg-cyan/10"
                                    >
                                      Sell now →
                                    </button>
                                  </div>
                                </div>
                              ))}
                              {/* THE CARVED BASKETS (owner 2026-08-16: "surely you can
                                  buy a basket from the portfolio system") — filled via
                                  the bundle-buy machinery, not the batch; the run opens
                                  itself after the batch lands, and this button is the
                                  door for basket-only plans (or a re-open). */}
                              {directBaskets.length > 0 && (
                                <div className="relative overflow-hidden rounded-2xl border border-cyan/30 bg-cyan/[0.04] p-5">
                                  <div className="space-y-2">
                                    {directBaskets.map((b) => (
                                      <div key={`${b.chainId}:${b.address}`} className="flex items-center justify-between gap-3">
                                        <span className="inline-flex items-center gap-3">
                                          <ChainBadge chainId={b.chainId} size="md" />
                                          <span className="font-display text-xl font-bold tracking-tight text-ink">${showSymbol(b.symbol)}</span>
                                        </span>
                                        <span className="font-num text-[15px] tabular-nums text-ink-dim">${(b.usdCents / 100).toLocaleString()}</span>
                                      </div>
                                    ))}
                                  </div>
                                  <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                                    {/* mechanics off the card, same ruling as the $PRISM leg */}
                                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                                      {directBasketsDone ? 'done ✓' : 'runs last'}
                                    </span>
                                    <button
                                      type="button"
                                      onPointerDown={capturePress}
                                      onClick={() => setDirectBasketsOpen(true)}
                                      className="press inline-flex h-9 items-center rounded-full border border-cyan/40 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-cyan hover:bg-cyan/10"
                                    >
                                      {/* a RE-OPEN door only — the main button drives this lane
                                          (owner 2026-08-16: one button for the whole system) */}
                                      {directBasketsDone ? 'Open the run again →' : 'Open the run →'}
                                    </button>
                                  </div>
                                </div>
                              )}
                              {[...runReview.refusals, ...runReview.plan.refusals.map((r) => r.reason), ...runReview.plan.notes]
                                .filter((line) => !line.startsWith('This plan first sells') && !line.includes('arrives as wrapped ETH'))
                                // the empty-batch sentence is TRUE OF THE BATCH but not of a
                                // plan whose content was carved to the basket/PRISM lanes —
                                // with a carved lane present, the lane's card speaks instead
                                .filter(
                                  (line) =>
                                    !(
                                      line.includes('no asset in this plan has a positive target') &&
                                      (directBaskets.length > 0 || directBasketSells.length > 0 || directPrism != null)
                                    ),
                                )
                                .map((line) => (
                                  <p key={line} className="text-[13px] leading-relaxed text-ink-faint">
                                    · {line}
                                  </p>
                                ))}
                              {!runner.state &&
                                coverOffers.map((o) => (
                                  <div key={o.chainId} className="rounded-2xl border border-cyan/30 bg-cyan/[0.05] px-4 py-4 text-center">
                                    <p className="text-[14px] leading-relaxed text-ink">
                                      Your ETH on {chainCfg(o.chainId).name} can cover this — sell ≈{(Number(o.sellRaw) / 1e18).toFixed(4)} ETH (at
                                      least ${(o.floorCents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} after slippage) and the
                                      buys run.
                                    </p>
                                    <button
                                      type="button"
                                      onPointerDown={capturePress}
                                      onClick={() => {
                                        setCoverSells((prev) => [...prev.filter((c) => c.chainId !== o.chainId), { chainId: o.chainId, sellRaw: o.sellRaw.toString() }])
                                        setCoverOffers((prev) => prev.filter((x) => x.chainId !== o.chainId))
                                        autoRanRef.current = null
                                        setRunReview(null) // rebuild with the cover sale; auto-runs when clean
                                      }}
                                      className="spectral-btn press mt-3 inline-flex h-11 items-center justify-center rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
                                    >
                                      Sell ETH &amp; run →
                                    </button>
                                  </div>
                                ))}
                              {!runner.state && (
                                <div className="flex flex-col items-center gap-2 pt-2">
                                  {(() => {
                                    const upfront = runner.gate(runReview.plan)
                                    // 13:19, the SECOND dead-button report in ten minutes:
                                    // a 50%-opacity spectral button with an 11px caption
                                    // reads as BROKEN, not refused. A plan the runner
                                    // cannot take gets NO button — the refusal speaks at
                                    // full size instead (the 13:09 lesson, finished).
                                    if (!upfront.ok && directPrism && runReview.plan.steps.length === 0)
                                      // PRISM-ONLY plan: the batch has nothing, the direct leg IS
                                      // the run — the main button fires it (his ruling)
                                      return (
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => void runDirectPrism()}
                                          disabled={directRun.phase !== 'idle' && directRun.phase !== 'failed'}
                                          className="spectral-btn press inline-flex h-12 items-center justify-center rounded-full px-7 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-wait disabled:opacity-60"
                                        >
                                          {directRun.phase === 'idle' || directRun.phase === 'failed'
                                            ? directBaskets.length > 0
                                              ? 'Run the plan →'
                                              : 'Run — buys PRISM in its own pool →'
                                            : 'running…'}
                                        </button>
                                      )
                                    if (!upfront.ok && directBaskets.length > 0 && runReview.plan.steps.length === 0)
                                      // BASKET-ONLY plan (owner live 2026-08-16: "cant buy the
                                      // basket from the port flow still?" — the empty-batch
                                      // refusal walled a plan whose whole content was carved):
                                      // the carved run IS the plan, so the main button opens it,
                                      // the PRISM-only precedent applied.
                                      return (
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => setDirectBasketsOpen(true)}
                                          className="spectral-btn press inline-flex h-12 items-center justify-center rounded-full px-7 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-void"
                                        >
                                          {directBasketsDone
                                            ? 'Open the basket run again →'
                                            : `Run — buys the basket${directBaskets.length === 1 ? '' : 's'} →`}
                                        </button>
                                      )
                                    if (!upfront.ok)
                                      return (
                                        <div className="w-full rounded-2xl border border-line/60 p-4 text-center" role="status">
                                          <div className="font-display text-sm font-bold uppercase tracking-[0.1em] text-ink">
                                            This plan can’t run yet
                                          </div>
                                          <p className="mx-auto mt-2 max-w-[52ch] text-[13px] leading-relaxed text-ink-dim">
                                            {/* the SPECIFIC sentence wins the loud spot: on an
                                                empty plan the review's refusal line says WHY
                                                (sells / shortfall / no buys) — the generic
                                                zero-step reason is the fallback, not the lead */}
                                            {(runReview.plan.steps.length === 0 && runReview.refusals[0]) || upfront.reason}
                                          </p>
                                          {/* the sentence names remedies that live on the review
                                              ("change an amount, or trim something") — this is the
                                              door back to where they are (audit 2026-08-16: the
                                              only escape was a ghost button labelled Close) */}
                                          <button
                                            type="button"
                                            onPointerDown={capturePress}
                                            onClick={() => {
                                              setArming(null)
                                              setStation('review')
                                            }}
                                            className="press mt-3 inline-flex h-10 items-center gap-2 rounded-full border border-white/15 px-5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-ink"
                                          >
                                            ← Back to the review to change it
                                          </button>
                                        </div>
                                      )
                                    if (runStarting) {
                                      const secs = runStartedAt != null ? Math.floor((Date.now() - runStartedAt) / 1000) : 0
                                      return (
                                        <div className="text-center" role="status">
                                          <span aria-hidden className="mx-auto block h-1 w-32 animate-pulse rounded-full bg-ink-faint/40" />
                                          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                                            starting the run — {secs < 3 ? 'contacting your wallet…' : `quoting your routes… ${secs}s`}
                                          </p>
                                          {secs >= 10 && (
                                            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                                              a first quote can take ~15s — nothing signs without your wallet prompt
                                            </p>
                                          )}
                                        </div>
                                      )
                                    }
                                    // THE BRIDGE QUESTION (the owner 2026-08-15: "was never asked
                                    // to bridge") — a plan that composes transfers HOLDS here
                                    // for his explicit choice. Everything else auto-runs (his
                                    // ruling: no second confirm — Execute was the click).
                                    const travels = runReview.plan.steps.filter((p) => p.action.kind === 'bridge')
                                    if (travels.length > 0 && bridgeChoice !== 'bridge')
                                      return (
                                        <div className="w-full rounded-2xl border border-cyan/30 bg-cyan/[0.04] p-6 text-center">
                                          <div className="font-display text-xl font-bold uppercase tracking-tight text-ink">
                                            Part of this money lives on another network
                                          </div>
                                          <p className="mx-auto mt-2 max-w-[52ch] text-[14px] leading-relaxed text-ink-dim">
                                            {travels
                                              .map((t) => {
                                                const a = t.action as { fromChainId: number; toChainId: number; amountCents: number }
                                                return `$${(a.amountCents / 100).toLocaleString()} would travel ${netShort(a.fromChainId)} → ${netShort(a.toChainId)} first (a few minutes)`
                                              })
                                              .join(' · ')}
                                          </p>
                                          <div className="mt-5 flex flex-col items-center justify-center gap-3 sm:flex-row">
                                            <button
                                              type="button"
                                              onPointerDown={capturePress}
                                              onClick={() => setBridgeChoice('bridge')}
                                              className="spectral-btn press inline-flex h-12 items-center gap-2 whitespace-nowrap rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.1em] text-void sm:px-7 sm:text-[13px] sm:tracking-[0.12em]"
                                            >
                                              Bridge it & run →
                                            </button>
                                            <button
                                              type="button"
                                              onPointerDown={capturePress}
                                              onClick={() => {
                                                setBridgeChoice('local')
                                                setRunReview(null) // rebuild local-only; auto-runs when clean
                                              }}
                                              className="press inline-flex h-12 items-center gap-2 whitespace-nowrap rounded-full border border-white/15 px-6 font-display text-[12px] font-bold uppercase tracking-[0.1em] text-ink-dim hover:border-cyan/50 hover:text-ink sm:px-7 sm:text-[13px] sm:tracking-[0.12em]"
                                            >
                                              Use each network’s own funds
                                            </button>
                                          </div>
                                        </div>
                                      )
                                    // no transfers (or consented): the auto-run effect is
                                    // starting the run — this frame is its click feedback
                                    return (
                                      <div className="text-center" role="status">
                                        <span aria-hidden className="mx-auto block h-1 w-32 animate-pulse rounded-full bg-ink-faint/40" />
                                        <p className="mt-3 font-mono text-[12px] uppercase tracking-[0.14em] text-ink-faint">starting the run…</p>
                                      </div>
                                    )
                                  })()}
                                </div>
                              )}
                              {runner.state && (
                                <div className="space-y-2 pt-2">
                                  <div className="flex items-end justify-between gap-3">
                                    <span className="font-display text-xl font-bold uppercase tracking-tight text-ink">
                                      {runner.state.phase === 'running' ? 'Running — live' : `Run ${runner.state.phase}`}
                                    </span>
                                    {runner.state.phase === 'running' && runStartedAt != null && (
                                      <span className="font-mono text-[13px] tabular-nums text-ink-dim">{Math.floor((Date.now() - runStartedAt) / 1000)}s</span>
                                    )}
                                  </div>
                                  {/* the run's own progress track — done over total, animated */}
                                  <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]">
                                    <span
                                      aria-hidden
                                      className="block h-full rounded-full bg-gradient-to-r from-cyan to-teal transition-all duration-700 ease-out"
                                      style={{ width: `${Math.round((runner.state.steps.filter((x) => x.status === 'done' || x.status === 'skipped').length / Math.max(1, runner.state.steps.length)) * 100)}%` }}
                                    />
                                  </div>
                                  {/* A REFUSAL SPEAKS AT READING SIZE (the owner, 5th live report:
                                      the card said "Run refused" and the WHY sat in 11px faint
                                      text — a refusal whose reason is skimmable is half a
                                      refusal). The runner's own sentences, prominent, plus the
                                      release-surface door when the reason is a held record —
                                      today's remount bug orphaned runs mid-claim, and those
                                      holds are exactly what the release panel exists to clear. */}
                                  {runner.state.phase === 'refused' && (
                                    <div className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.04] p-4">
                                      {(() => {
                                        // notes ONLY, deduped — each step's message already renders
                                        // on its own card (owner 2026-08-15: the same sell-floor
                                        // sentence printed three times)
                                        const sentences = [...new Set(runner.state.notes)]
                                        if (sentences.length === 0)
                                          // A REFUSED STATE WITH NO SENTENCE IS ITSELF A BUG —
                                          // never render an empty warning box (the 6th live
                                          // report: "a yellow bar" with nothing in it). Print
                                          // the raw state so the next report IS the diagnosis.
                                          return (
                                            <p className="break-all font-mono text-[11px] leading-relaxed text-ink">
                                              refused with no stated reason — raw state:{' '}
                                              {JSON.stringify({ phase: runner.state.phase, steps: runner.state.steps.map((x) => ({ k: x.key, s: x.status, m: x.message ?? null })), notes: runner.state.notes })}
                                            </p>
                                          )
                                        // ⚠ ONE LINE, NOT A PARAGRAPH (the owner live 2026-08-16:
                                        // "needs way way way less text btw" — and the popup does
                                        // not scroll, so a long refusal CLIPS and cannot be read
                                        // at all). The decoded sentences carry a headline clause
                                        // and then reassurance + next step; the headline is what a
                                        // person needs on a refused card, and the rest is one tap
                                        // away rather than pushing the doors off-screen.
                                        return sentences.map((n) => {
                                          const full = String(n)
                                          const head = full.split(/(?<=[.;])\s/)[0] ?? full
                                          return (
                                            <details key={full} className="group">
                                              <summary className="cursor-pointer list-none text-[14px] leading-relaxed text-ink marker:hidden">
                                                {head}
                                                {full.length > head.length && (
                                                  <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint group-open:hidden">
                                                    why
                                                  </span>
                                                )}
                                              </summary>
                                              {full.length > head.length && (
                                                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-dim">{full.slice(head.length).trim()}</p>
                                              )}
                                            </details>
                                          )
                                        })
                                      })()}
                                      {/* ⚠ CAPTURE THE FAILURE, because reconstructions keep
                                          PASSING (2026-08-16: five separate reproductions of
                                          the owner's exact trade all succeeded while his kept
                                          refusing). A refusal nobody can inspect is a refusal
                                          nobody can fix, and asking him to describe it has cost
                                          hours. This copies the state that distinguishes his run
                                          from mine — the signer, the chain, the leg sizes and the
                                          exact messages — and nothing else: no keys, no calldata,
                                          no balances beyond what the plan already displays. */}
                                      <button
                                        type="button"
                                        onPointerDown={capturePress}
                                        onClick={() => {
                                          const diag = {
                                            at: new Date().toISOString(),
                                            signer: address ?? null,
                                            phase: runner.state?.phase ?? null,
                                            chains: (runReview?.chains ?? []).map((c) => ({
                                              chainId: c.chainId,
                                              grossCents: c.grossCents,
                                              fundingTotalRaw: String(c.fundingTotalRaw),
                                              legs: c.legs.map((l) => ({
                                                symbol: l.symbol,
                                                asset: l.asset,
                                                budgetRaw: String(l.budgetRaw),
                                                toleranceBps: l.toleranceBps,
                                                optional: l.optional,
                                              })),
                                              refusals: c.refusals,
                                            })),
                                            steps: (runner.state?.steps ?? []).map((x) => ({ key: x.key, status: x.status, message: x.message ?? null })),
                                            notes: runner.state?.notes ?? [],
                                          }
                                          // hand over the RING, not just this one: the previous
                                          // refusals are what show whether it is a pattern
                                          void navigator.clipboard?.writeText(failuresAsText() || JSON.stringify(diag, null, 2))
                                          setDiagCopied(true)
                                          window.setTimeout(() => setDiagCopied(false), 2000)
                                        }}
                                        className="press mt-3 inline-flex h-9 items-center gap-2 rounded-full border border-white/15 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-cyan/50 hover:text-cyan"
                                      >
                                        {diagCopied ? 'copied ✓' : 'Copy diagnostics'}
                                      </button>
                                      {[...runner.state.notes, ...runner.state.steps.map((x) => x.message)].some((n) => /record|another tab|storage|mid-prompt|cannot read/i.test(String(n ?? ''))) && (
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => {
                                            // the release panel lives on the portfolio page under
                                            // this popup — close, and it renders (it self-hides
                                            // only when there is nothing to release)
                                            if (inline) setStation('review')
                                            else onClose()
                                          }}
                                          className="press mt-3 inline-flex h-9 items-center gap-2 rounded-full border border-amber-300/40 px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200 hover:border-amber-300/70"
                                        >
                                          Open the portfolio’s release panel →
                                        </button>
                                      )}
                                      {/* UNCONDITIONAL (owner 2026-08-16: "also no retry button??" —
                                          the fourth time a prose-keyed gate hid this door). Phase
                                          'refused' is pre-send by the runner's own semantics
                                          (on-chain reverts land in partial/done, which carry their
                                          own door below), so a fresh rebuild is always safe here
                                          and the door never again depends on which sentence the
                                          refusal happened to use. */}
                                      {(
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => {
                                            // the plan sat (a bridge wait, a wallet pause) and the
                                            // market moved past the frozen review anchor — one
                                            // explicit re-check rebuilds the review on fresh reads
                                            // and auto-runs when clean (never an auto-restart:
                                            // this click IS the consent)
                                            runner.clear()
                                            autoRanRef.current = null
                                            setRunReview(null)
                                          }}
                                          title="The run already re-quoted a few times on its own before showing you this, so this rebuilds the whole review rather than just the quote."

                                          className="spectral-btn press mt-3 inline-flex h-10 items-center justify-center rounded-full px-5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-void"
                                        >
                                          Re-check on fresh prices and run →
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {runner.state.phase !== 'refused' && runner.state.notes
                                    .filter((n) => !runReview.plan.notes.includes(n))
                                    .map((n) => (
                                      <p key={n} className="font-mono text-[11px] leading-relaxed text-ink-faint">
                                        · {n}
                                      </p>
                                    ))}
                                  {/* the re-quote door ALSO after an ON-CHAIN revert (2026-08-15,
                                      the owner's LNOC batch: signed, RequiredLegFailed, rolled back —
                                      phase 'partial', so the refused card's door never showed;
                                      the honest remedy is the same one click) */}
                                  {/* RETRY FROM THE FAILED STEP (owner 2026-08-16: "a retry
                                      button on the card itself … so it doesnt brick the
                                      portfolio execution"). Completed steps STAY DONE; the
                                      plan resumes at the failed step, which re-composes and
                                      re-quotes FRESH at execution (the runner's own per-step
                                      law), then everything after it runs in order. Strictly
                                      safer than a whole-plan re-run, which would redo what
                                      already landed. */}
                                  {/* AN UNRESOLVED STEP GETS ITS OWN DOORS (audit 2026-08-16):
                                      the copy told the user to "check the wallet's activity,
                                      then the portfolio's release panel" while the release door
                                      above was gated on phase 'refused' and the retry below on
                                      status 'failed' — the money-out/outcome-ambiguous state had
                                      NEITHER. Retry is deliberately absent here: re-running a
                                      step whose outcome is unknown risks a double-buy; the
                                      release panel (which reads the submission record) is the
                                      honest lever, so it gets the door. */}
                                  {runner.state.phase === 'partial' &&
                                    runner.state.steps.some((x) => x.status === 'unresolved') && (
                                      <div className="pt-1 text-center">
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => {
                                            if (inline) setStation('review')
                                            else onClose()
                                          }}
                                          className="press mt-1 inline-flex h-10 items-center gap-2 rounded-full border border-amber-300/40 px-5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200 hover:border-amber-300/70"
                                        >
                                          Open the portfolio’s release panel →
                                        </button>
                                        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                                          one step&rsquo;s outcome is unknown. check the wallet&rsquo;s activity; the release panel frees its record safely
                                        </p>
                                      </div>
                                    )}
                                  {runner.state.phase === 'partial' &&
                                    (() => {
                                      const failed = runner.state.steps.find((x) => x.status === 'failed')
                                      if (!failed) return null
                                      const idx = runReview.plan.steps.findIndex((s) => stepKeyOf(s) === failed.key)
                                      if (idx < 0) return null
                                      return (
                                        <div className="pt-1 text-center">
                                          <button
                                            type="button"
                                            onPointerDown={capturePress}
                                            onClick={() => {
                                              const remaining = { ...runReview.plan, steps: runReview.plan.steps.slice(idx) }
                                              // snapshot what LANDED before clear() wipes it — the
                                              // completed cards keep their ✓ through the retry
                                              for (const x of runner.state?.steps ?? [])
                                                if (x.status === 'done') landedStepsRef.current.set(x.key, x)
                                              runner.clear()
                                              setRunStarting(true)
                                              setRunStartedAt(Date.now())
                                              runner
                                                .run(remaining)
                                                .catch((e: unknown) => {
                                                  setRunReviewError(e instanceof Error ? e.message : 'the retry failed to start. Try again')
                                                })
                                                .finally(() => setRunStarting(false))
                                            }}
                                            className="spectral-btn press mt-1 inline-flex h-10 items-center justify-center rounded-full px-5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-void"
                                          >
                                            Retry from the failed step →
                                          </button>
                                          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                                            what completed stays done · the failed step re-quotes fresh
                                          </p>
                                        </div>
                                      )
                                    })()}
                                  {(runner.state.phase === 'partial' || runner.state.phase === 'done') &&
                                    // same prose-keyed matcher as the refused card above, and it
                                    // broke the same way when the copy was corrected — kept in step
                                    runner.state.steps.some((x) => String(x.message ?? '').includes('route refused')) && (
                                      <div className="pt-1 text-center">
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => {
                                            runner.clear()
                                            autoRanRef.current = null
                                            setRunReview(null)
                                          }}
                                          className="spectral-btn press mt-1 inline-flex h-10 items-center justify-center rounded-full px-5 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-void"
                                        >
                                          Nothing was bought. Re-quote and run again →
                                        </button>
                                      </div>
                                    )}
                                  {runner.state.phase === 'partial' && runner.state.steps.some((s) => s.kind === 'bridge' && s.status === 'unresolved') && (
                                    Object.keys(bridgeArrivals).length > 0 ? (
                                      <div className="pt-1 text-center">
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => {
                                            setRunStarting(true)
                                            setRunStartedAt(Date.now())
                                            runner
                                              .run(runReview.plan)
                                              .catch((e: unknown) => {
                                                setRunReviewError(e instanceof Error ? e.message : 'the run failed to start — try again')
                                              })
                                              .finally(() => setRunStarting(false))
                                          }}
                                          className="spectral-btn press inline-flex h-11 items-center gap-2 rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
                                        >
                                          Money landed. Continue the run →
                                        </button>
                                        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                                          resumes from the record · re-sends nothing
                                        </p>
                                      </div>
                                    ) : (
                                      <p className="font-mono text-[11px] leading-relaxed text-teal">
                                        the transfer keeps traveling on its own — this card flips the moment it lands, with a one-click continue.
                                      </p>
                                    )
                                  )}
                                  {runner.state.phase === 'running' && (
                                    <div className="pt-1 text-center">
                                      <button type="button" onClick={runner.stop} className={ghostBtn}>
                                        Stop after this step
                                      </button>
                                    </div>
                                  )}
                                  {/* ⚠ THE COMPLETION PLATE TAKES THE ROOM (the owner live 2026-08-16:
                                      "needs to use way more of the height of the card so much empty
                                      space, use more height always for this system"). Condensing the
                                      finished step cards freed vertical space and then left it
                                      empty, which reads as a broken layout rather than a finished
                                      run. min-h + centred content means the plate GROWS into
                                      whatever the steps gave back, at any viewport, without a fixed
                                      height that would clip on a phone. */}
                                  {/* THE PARTIAL PLATE (audit 2026-08-16): a half-landed run's
                                      whole disclosure used to be the protocol word "Run partial".
                                      Now it counts what landed off the runner's own steps, says
                                      where the money is (the wallet and the landed positions,
                                      never anywhere else), and opens the same portfolio door the
                                      done plate has — the landed half belongs in the book too.
                                      moneyMoved gates the money sentence: a partial where nothing
                                      moved must not claim otherwise. */}
                                  {runner.state.phase === 'partial' && (
                                    <div className="mt-2 rounded-2xl border border-amber-300/25 bg-amber-400/[0.05] px-5 py-4 text-center">
                                      <div className="font-display text-lg font-bold uppercase tracking-tight text-ink">
                                        {(() => {
                                          const landed = runner.state.steps.filter((x) => x.status === 'done').length
                                          return `${landed} of ${runner.state.steps.length} steps landed`
                                        })()}
                                      </div>
                                      <p className="mx-auto mt-1.5 max-w-[52ch] font-mono text-[11px] leading-relaxed text-ink-dim">
                                        {runner.state.moneyMoved
                                          ? 'What completed is yours: it sits in your wallet and your landed positions, nowhere else. The doors above finish or release the rest.'
                                          : 'Nothing moved yet. The doors above retry or release the plan.'}
                                      </p>
                                      {runner.state.moneyMoved && (
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => {
                                            onCreated()
                                            onClose()
                                          }}
                                          className="press mt-3 inline-flex h-10 items-center gap-2 rounded-full border border-white/15 px-6 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
                                        >
                                          View what landed in your portfolio →
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {runner.state.phase === 'done' && (
                                    <div className="relative flex min-h-[clamp(14rem,34vh,22rem)] flex-col items-center justify-center overflow-hidden rounded-2xl border border-teal/30 bg-teal/[0.06] px-6 py-10 text-center">
                                      <span
                                        aria-hidden
                                        className="trov-shimmer pointer-events-none absolute inset-0"
                                        style={{ background: 'linear-gradient(100deg, transparent 35%, rgba(53,255,200,0.16) 50%, transparent 65%)', backgroundSize: '250% 100%' }}
                                      />
                                      <div className="relative">
                                        <div className="font-display text-4xl font-bold uppercase tracking-tight text-ink">Run complete</div>
                                        <p className="mx-auto mt-2 max-w-[46ch] text-[14px] leading-relaxed text-ink-dim">
                                          every step landed on-chain · your book records this mix as executed
                                        </p>
                                        <button
                                          type="button"
                                          onPointerDown={capturePress}
                                          onClick={() => {
                                            // hand the portfolio page WHAT changed, so its bento
                                            // greets the landing (run-landed.ts's one job)
                                            const changed = new Set<string>()
                                            for (const c of draft.funding?.changes ?? []) {
                                              if (Math.abs(c.toUsd - c.fromUsd) > 0.5) changed.add(`${c.chainId}:${c.address.toLowerCase()}`)
                                            }
                                            for (const ch of runReview.chains) for (const l of ch.legs) changed.add(`${ch.chainId}:${l.asset.toLowerCase()}`)
                                            for (const sale of runReview.sells) changed.add(`${sale.chainId}:${sale.asset.toLowerCase()}`)
                                            writeRunLanded([...changed])
                                            // LAND ON THE PICTURE, WITH NOTHING
                                            // ON TOP OF IT (the owner 2026-08-15:
                                            // "it still keeps the pop up… it
                                            // should remove all pop ups and show
                                            // the portfolio bento screen").
                                            //
                                            // ⚠⚠ BOTH MOUNTS, BELT AND BRACES — and the
                                            // second half is a regression I caused.
                                            // Dropping `setStation` in favour of a bare
                                            // `onClose()` made this button DEAD on the
                                            // create surface, because that mount passes
                                            // `onClose={() => undefined}` (CreateSurface
                                            // .tsx): a no-op close plus a page that was
                                            // never left equals a button that does
                                            // nothing at all (the owner, 2026-08-16).
                                            //
                                            // So: reset the station (the inline surface's
                                            // way of standing down), call onClose (the
                                            // overlay's way), and navigate regardless —
                                            // the navigation is the part that actually
                                            // fulfils the button's promise, and it must
                                            // not depend on which mount we happen to be.
                                            // ⚠⚠ USE THE HOST'S OWN "WE ARE DONE" HATCH.
                                            // Two wrong attempts before this one, both
                                            // mine: `onClose()` is a NO-OP on the inline
                                            // mount (CreateSurface passes
                                            // `() => undefined`), so the button did
                                            // nothing; adding `setStation('review')`
                                            // then made it land on the review screen,
                                            // which is worse than nothing because it
                                            // looks like the run was undone.
                                            //
                                            // `onCreated` is the callback the host
                                            // already supplies for exactly this exit —
                                            // CreateSurface routes it to onDone() or
                                            // navigate('/portfolio'), and the overlay
                                            // mount closes on it. Using the host's hatch
                                            // instead of guessing at its internals is
                                            // the whole lesson of the last two tries.
                                            onCreated()
                                            onClose()
                                          }}
                                          className="spectral-btn press mt-5 inline-flex h-12 items-center gap-2 rounded-full px-8 font-display text-[13px] font-bold uppercase tracking-[0.12em] text-void"
                                        >
                                          View your portfolio →
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                            )
                          })()}
                        </div>
                      ) : (
                        <>
                          <div className="font-display text-2xl font-bold uppercase tracking-tight text-ink">
                            Real execution isn&rsquo;t armed
                          </div>
                          <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed text-ink-dim">{arming.reason}</p>
                          {/* the connect refusal carries the connect DOOR (audit
                              2026-08-16: the sentence said "connect a wallet" and
                              the only button said Close; the component already
                              holds the hatch for exactly this) */}
                          {/Connect a wallet/i.test(arming.reason) && onNeedConnect && (
                            <button
                              type="button"
                              onPointerDown={capturePress}
                              onClick={() => onNeedConnect('execute')}
                              className="spectral-btn press mt-4 inline-flex h-11 items-center rounded-full px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void"
                            >
                              Connect wallet →
                            </button>
                          )}
                          {arming.detail && arming.detail.length > 0 && (
                            <div className="mt-4 space-y-1.5 text-left">
                              {arming.detail.map((line) => (
                                <p key={line} className="font-mono text-[11px] text-ink-faint">
                                  · {line}
                                </p>
                              ))}
                            </div>
                          )}
                          <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                            nothing ran · no funds were touched
                          </p>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setArming(null)
                          if (inline) setStation('review')
                          else onClose()
                        }}
                        className={`${ghostBtn} mt-8`}
                      >
                        {inline ? 'Back to review' : 'Close'}
                      </button>
                    </div>
                  )}

                  {computing && (
                    <div className="grid place-items-center py-[72px] text-center" role="status">
                      <span aria-hidden className="h-1 w-40 animate-pulse rounded-full" style={{ background: SPECTRAL }} />
                      <div className="enter mt-6 font-display text-2xl font-bold uppercase tracking-tight text-ink" style={{ '--enter-i': 0 } as CSSProperties}>
                        {draft.intent === 'publish' ? 'Preparing your baskets…' : 'Preparing your buys…'}
                      </div>
                      <div className="mt-5 space-y-2 text-left">
                        {['resolving routes', 'grouping networks', 'simulating each step'].map((line, li) => (
                          <p key={line} className="enter flex items-center gap-3 font-mono text-[11px] text-ink-dim" style={{ '--enter-i': 2 + li * 2 } as CSSProperties}>
                            {li < 2 ? (
                              <span className="font-mono text-[12px] text-teal">✓</span>
                            ) : (
                              <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-cyan shadow-[0_0_10px_var(--color-cyan)]" />
                            )}
                            {line}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {!computing && plan && (
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="font-display text-xl font-bold uppercase tracking-[0.08em] text-ink-dim">
                          {plan.status === 'done'
                            ? 'Done'
                            : plan.status === 'cancelled'
                              ? 'Stopped'
                              : 'Building your portfolio'}
                        </div>
                        <span role="status" aria-live="polite" className="font-mono text-[11px] tabular-nums text-ink-faint">
                          {planProgress(plan).done}/{planProgress(plan).total} steps
                        </span>
                      </div>
                      <div className="relative mt-4 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                        <span
                          aria-hidden
                          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                          style={{
                            width: `${(planProgress(plan).done / Math.max(1, planProgress(plan).total)) * 100}%`,
                            background: SPECTRAL,
                          }}
                        />
                      </div>

                      {plan.status !== 'done' && (
                        <div className="mt-6 space-y-6">
                          {[...new Set(plan.steps.map((s) => s.chainId))].map((cid) => (
                            <div key={cid}>
                              {/* the network as a quiet fact — never a decision */}
                              <div className="flex items-center gap-3">
                                <ChainIcon chainId={cid} />
                                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">{netName(cid)}</span>
                                <span aria-hidden className="h-px flex-1 bg-white/8" />
                              </div>
                              <div className="mt-2 space-y-2">
                                {plan.steps
                                  .filter((s) => s.chainId === cid)
                                  .map((s) => (
                                    <div
                                      key={s.id}
                                      className={`flex h-14 items-center gap-4 rounded-2xl border px-4 transition-colors duration-500 ${
                                        s.state === 'approve' || s.state === 'confirming'
                                          ? 'border-cyan/25 bg-cyan/[0.04]'
                                          : s.state === 'done'
                                            ? 'border-white/8 bg-white/[0.02] opacity-70'
                                            : 'border-white/8 bg-white/[0.02]'
                                      }`}
                                    >
                                      <span className="grid w-8 place-items-center">
                                        {s.state === 'queued' && <span className="h-2 w-2 rounded-full bg-white/15" />}
                                        {s.state === 'approve' && <span className="h-3 w-3 animate-pulse rounded-full bg-amber-300 shadow-[0_0_12px_rgba(255,200,100,0.6)]" />}
                                        {s.state === 'confirming' && (
                                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-cyan/70 border-t-transparent" />
                                        )}
                                        {s.state === 'done' && <span className="font-mono text-[14px] text-teal">✓</span>}
                                        {s.state === 'failed' && <span className="font-mono text-[14px] text-magenta">!</span>}
                                      </span>
                                      <span className="flex-1 font-display text-sm font-bold text-ink">
                                        {s.kind === 'fund'
                                          ? 'Position funds & gas'
                                          : s.kind === 'batch'
                                            ? `Buy ${s.count} asset${s.count === 1 ? '' : 's'} · one transaction`
                                            : s.kind === 'create'
                                              ? 'Create basket'
                                              : s.kind === 'seedmint'
                                                ? draft.seedFrom
                                                  ? `Convert & seed from your holdings · ${draft.seedPct ?? DEFAULT_SEED_PCT}%`
                                                  : 'Seed first buy'
                                                : `Buy $${showSymbol(s.symbol)}`}
                                      </span>
                                      {s.state === 'approve' && (
                                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/90">
                                          {SIMULATED ? 'simulated · no wallet prompt' : 'approve in your wallet'}
                                        </span>
                                      )}
                                      {s.state === 'failed' && plan.status === 'running' && (
                                        <button
                                          type="button"
                                          onClick={() => setPlan(retryStep(plan, s.id))}
                                          className="press h-8 rounded-full border border-magenta/40 px-4 font-mono text-[10px] uppercase tracking-wide text-magenta hover:border-magenta"
                                        >
                                          Retry
                                        </button>
                                      )}
                                      <span className="w-20 text-right font-num text-sm tabular-nums text-ink-dim">
                                        {s.kind === 'seedmint' ? '—' : formatUsdCompact(s.usd)}
                                      </span>
                                    </div>
                                  ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {plan.status === 'running' && (
                        <div className="mt-8 flex items-center justify-between gap-4">
                          <button type="button" onClick={stopRun} disabled={!!plan.stopRequested} className={ghostBtn}>
                            {plan.stopRequested ? 'Stopping after this step…' : 'Stop after this step'}
                          </button>
                          <span className="font-mono text-[10px] text-ink-faint">
                            safe to close; this run resumes where it left off
                          </span>
                        </div>
                      )}

                      {plan.status === 'cancelled' && (
                        <div className="mt-8">
                          <p className="max-w-[62ch] text-[13px] leading-relaxed text-ink-dim">
                            Stopped. What already completed is yours — it’s in your wallet. The rest
                            was abandoned and nothing further will run.
                          </p>
                          {/* CLOSE IS NOT A WAY OUT ON THE PAGE MOUNT (QOL
                              2026-08-07): /create passes onClose={() => undefined}
                              and hides the header ✕ when inline, and this station
                              has no Back — so "Stop after this step" stranded the
                              user on a panel whose only button did nothing, until
                              they reloaded. Inline goes back to review, where the
                              draft still is; the popup mount keeps Close, which
                              there really does close something. */}
                          <button
                            type="button"
                            onClick={() => (inline ? setStation('review') : onClose())}
                            className={`${ghostBtn} mt-6`}
                          >
                            {inline ? 'Back to review' : 'Close'}
                          </button>
                        </div>
                      )}

                      {plan.status === 'done' && (
                        <div className="grid place-items-center py-14 text-center">
                          <span className="relative grid h-[72px] w-[72px] place-items-center rounded-2xl">
                            <span aria-hidden className="forge-add-ring absolute -inset-2 rounded-[1.25rem] opacity-70 blur-lg" />
                            <span aria-hidden className="forge-add-ring absolute inset-0 rounded-2xl" />
                            <span aria-hidden className="absolute inset-[2px] rounded-[calc(1rem-2px)] bg-panel" />
                            <span className="relative font-mono text-2xl text-teal">✓</span>
                          </span>
                          <div className="mt-6 font-display text-3xl font-bold uppercase tracking-tight text-ink">
                            {SIMULATED
                              ? 'Simulation complete'
                              : draft.intent === 'publish'
                                ? 'Your baskets are live'
                                : 'Your portfolio is live'}
                          </div>
                          <p className="mt-3 font-mono text-[11px] text-ink-faint">
                            {SIMULATED
                              ? 'simulated · nothing deployed, no funds moved'
                              : draft.intent === 'publish'
                                ? 'one per network, published in your name'
                                : 'every asset is in your own wallet'}
                          </p>
                          {draft.intent === 'keep' && norm.length > 0 && (
                            <div className="mt-6 w-full max-w-[360px]">
                              <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
                                {norm.map((t, i) => (
                                  <span key={assetKey(t.asset)} style={{ width: `${t.pct}%`, background: SEG[i % SEG.length] }} />
                                ))}
                              </div>
                              <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                                {norm.length} asset{norm.length === 1 ? '' : 's'} ·{' '}
                                {new Set(norm.map((t) => t.asset.chainId)).size} network
                                {new Set(norm.map((t) => t.asset.chainId)).size === 1 ? '' : 's'}
                              </p>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={onCreated}
                            className={`${spectralBtn} mt-8`}
                            style={{ background: SPECTRAL }}
                          >
                            {draft.intent === 'publish' ? 'Done' : 'See your portfolio'}
                            <Arrow />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </Shell>
      </div>

      {station !== 'review' && (
      <p className="mt-8 text-center text-[13px] leading-relaxed text-ink-dim">
        Routing is handled for you; every asset lands in your own wallet.
        <InfoDot>
          Nothing is pooled, wrapped, or held on your behalf. Your buys settle on the networks
          where the assets trade; your wallet approves each step. Your portfolio is a set of
          assets you own — not one token.
        </InfoDot>
      </p>
      )}
    </div>
  )

  // the bundle ceremony — the same modal the Composer mounts: per-network
  // readiness, then sequential REAL deploys under the one shared name. A
  // finished publish clears this draft (an accidental republish is a paid
  // duplicate). LANDED-LANE MEMORY (2026-08-12 audit): this mount passed no
  // alreadyLive at all, so closing mid-bundle and republishing re-armed
  // already-paid lanes — it now reads/writes the same persisted row the
  // Composer's mount does, so the two surfaces share one truth per name.
  const landedRow = pubHandoff ? loadLandedLanes() : null
  const ceremony = pubHandoff && (
    <PublishBundleModal
      groups={pubHandoff.groups}
      seedName={draft.name ?? ''}
      seedSymbol={''}
      alreadyLive={landedRow?.lanes ?? []}
      lockedName={landedRow?.name}
      onLaneDone={(chainId, newAddress, shippedName) => {
        recordLandedLane(shippedName, { chainId, newAddress })
      }}
      onPublished={() => {
        publishedRef2.current = true
        setDraft(emptyDraft())
        clearLandedLanes()
      }}
      onClose={() => {
        setPubHandoff(null)
        // the bundle is live and the draft cleared — a review station over
        // zero targets reads as broken, so the flow re-opens at the start
        if (publishedRef2.current) {
          publishedRef2.current = false
          setStation('choose')
        }
      }}
    />
  )

  // THE CARVED BASKETS' RUN — the REAL bundle-buy machine over a synthetic
  // one-leg-per-chain thesis (seedThesisOf's zero-AUM dress; the overlay's
  // live executors read each real basket from chain). It portals itself to
  // document.body, so mounting it here works from both return branches. Its
  // own big button holds the money consent, exactly as on the bundle page.
  const basketRun = directBasketsOpen && address && directBaskets.length > 0
    ? (() => {
        const seed = seedThesisOf(
          {
            legs: directBaskets.map((b) => ({ chainId: b.chainId, address: b.address as `0x${string}`, symbol: b.symbol, share: b.usdCents })),
            excluded: [],
          },
          directBaskets.length === 1 ? directBaskets[0].symbol : 'your baskets',
          address,
        )
        const cents = directBaskets.reduce((s, b) => s + b.usdCents, 0)
        return seed && cents > 0 ? (
          <ThesisRunOverlay
            thesis={seed.thesis}
            accent="var(--color-cyan)"
            mode="buy"
            amountCents={cents}
            seedShares={seed.seedShares}
            onClose={() => {
              setDirectBasketsOpen(false)
              setDirectBasketsDone(true)
              // THE DONE LOOP, KILLED (recording 1221: "when I clicked done,
              // it took me back onto the pop up of oh, continue to buy the
              // basket. That cannot happen… it needs to bring you back to the
              // portfolio, the main page, and show you that the buy went
              // through"). A FINISHED run exits the WHOLE flow through the
              // host's own hatch and hands the bento the bought baskets to
              // glow (run-landed.ts). An abandoned run keeps today's return
              // to the review, where the re-open door lives.
              const name = directBaskets.length === 1 ? directBaskets[0].symbol : 'your baskets'
              const run = address ? loadThesisRun(address, thesisRef(name), 'buy') : null
              const p = run ? runProgress(run) : null
              if (p && p.finished && p.done > 0) {
                writeRunLanded(directBaskets.map((b) => `${b.chainId}:${b.address.toLowerCase()}`))
                onCreated()
                onClose()
              }
            }}
          />
        ) : null
      })()
    : null

  // A carved basket TRIM's run — the bundle machinery's own SELL mode over a
  // synthetic one-leg thesis: its fraction picker, floors and per-step consent
  // are the bundle page's, verbatim. Proceeds land in the wallet.
  const basketSellRun =
    sellOverlayFor && address
      ? (() => {
          const seed = seedThesisOf(
            { legs: [{ chainId: sellOverlayFor.chainId, address: sellOverlayFor.address as `0x${string}`, symbol: sellOverlayFor.symbol, share: 1 }], excluded: [] },
            sellOverlayFor.symbol,
            address,
          )
          return seed ? (
            <ThesisRunOverlay
              thesis={seed.thesis}
              accent="var(--color-cyan)"
              mode="sell"
              onClose={() => {
                const subject = sellOverlayFor
                setSellOverlayFor(null)
                // same exit law as the buy lane (recording 1221): a finished
                // sale lands on the portfolio with the sold basket glowing —
                // and leaves the queue, so the next carved sell opens itself
                const run = address && subject ? loadThesisRun(address, thesisRef(subject.symbol), 'sell') : null
                const p = run ? runProgress(run) : null
                if (p && p.finished && p.done > 0 && subject) {
                  setDirectBasketSells((prev) => prev.filter((b) => !(b.chainId === subject.chainId && b.address.toLowerCase() === subject.address.toLowerCase())))
                  writeRunLanded([`${subject.chainId}:${subject.address.toLowerCase()}`])
                  onCreated()
                  onClose()
                }
              }}
            />
          ) : null
        })()
      : null

  if (inline)
    return (
      <div className="relative">
        {body}
        {ceremony}
        {basketRun}
        {basketSellRun}
      </div>
    )

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={trapTab}
      className="fixed inset-0 z-[92] overflow-y-auto bg-void/90 outline-none backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Create your portfolio"
    >
      {body}
      {ceremony}
      {basketRun}
      {/* audit 2026-08-16: the portal branch was missing this mount, so the
          carved basket-sell card's "Sell now →" set state nothing rendered on
          the portfolio home's popup — a dead button on a money door */}
      {basketSellRun}
    </div>,
    document.body,
  )
}
