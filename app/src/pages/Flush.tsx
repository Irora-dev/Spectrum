import { useMemo, useState, type ReactNode } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { DEV_PREVIEW_ADDRESS } from '../lib/spectrum/dev-preview'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useSearchParams } from 'react-router'
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { encodeFunctionData, isAddress, parseEther, type Address } from 'viem'
import { TRADING_ENABLED } from '../lib/config/features'
import { DEFAULT_CHAIN_ID, chainCfg } from '../lib/chain/chains'
import { usePortfolio, useBasketData, useAllBaskets } from '../lib/spectrum/hooks'
import { fetchFeeState, useFeeState, type FrontendAccrual } from '../lib/spectrum/use-fee-state'
import { useFeeActions, CLAIM_KEY, BURN_KEY, REDEEM_KEY, frontendKey, type TxState } from '../lib/spectrum/use-fee-actions'
import { PROTOCOL_FEE_MODEL, frontendFlushFloorUsdc, frontendPotFlushable } from '../lib/spectrum/fee-model'
import { basketAbi } from '../lib/spectrum/abis-v2'
import { fetchBurnEligible, fetchEthUsd, useBurnEligibility } from '../lib/spectrum/flush-eligibility'
import { probeBatchSupport, runBatch, type BatchCall, type Eip1193Like } from '../lib/spectrum/batch-calls'
import { useQueries } from '@tanstack/react-query'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { BasketAvatar } from '../components/BasketAvatar'
import { InfoDot } from '../components/InfoDot'
import { BasketBento } from '../components/BasketBento'
import { BasketWash } from '../components/BasketWash'
import { AuctionBurnCanvas } from '../components/AuctionBurnCanvas'
import { PageHeader } from '../components/PageHeader'
import { WalletButton } from '../components/WalletButton'
import { PoweredByPrism } from '../components/PoweredByPrism'
import { formatGrouped, shortAddr } from '../lib/spectrum/format'

// The Created-basket admin bar (Portfolio) and the standalone /flush nav both
// land here. With ?basket=&chain= we open that basket's fee console; without, a
// picker of the wallet's baskets. The whole surface is TRADING-gated (it signs
// txs); a direct URL with the flag off redirects home, page stays in the tree.

// Mirrors Portfolio's DEV preview wallet (= the dev fixture's MOCK_DEPLOYER) so
// `npm run dev` renders the console populated without a connected wallet.
const BOUNTY_PCT = PROTOCOL_FEE_MODEL.CRANK_BOUNTY_BPS / 100

const usd = (n: number) =>
  '$' + (isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// min-h-[36px] sm:min-h-0 — a 32px-tall control is under the phone tap floor;
// desktop reverts to the exact box it had (owner 2026-08-06 23:13 raised this
// for the "Full console" link, and every button on the page had the same miss).
const BTN_PRIMARY =
  'press inline-flex min-h-[36px] items-center justify-center gap-2 rounded-xl border border-cyan/40 bg-cyan/[0.08] px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-cyan transition-colors hover:border-cyan hover:bg-cyan/15 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-cyan/[0.08] disabled:hover:border-cyan/40 sm:min-h-0'
const BTN_GHOST =
  'press inline-flex min-h-[36px] items-center justify-center gap-2 rounded-xl border border-white/12 px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-white/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0'
const CHIP = 'rounded-full border border-white/12 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.15em] text-ink-faint'
// A small link/toggle that must still be a real tap row on a phone.
const TAP_ROW = 'press inline-flex min-h-[36px] items-center sm:min-h-0'

function BountyChip() {
  return <span className={`${CHIP} border-cyan/25 text-cyan/80`}>{BOUNTY_PCT}% bounty</span>
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TEXT THAT MOVED BEHIND A DISCLOSURE (owner 2026-08-06 23:13: "way, way,
// way too much text… reduce it massively and make it way clearer what
// information is most important"). Every claim below was a paragraph printed
// in full on the page; none of it is deleted, it now lives behind the page's
// own ⓘ idiom so the numbers and the buttons carry the surface. Declared once
// because the board hero and the single-basket console both say them.
// ─────────────────────────────────────────────────────────────────────────────
const CLAIM_EXPLAINER =
  'Holders accrue a share of every fee. Claiming is a pull, no bounty, and a blocklisted holder only ever blocks their own claim.'
const CRANK_EXPLAINER = (
  <>
    Anyone may run these, they settle fees the protocol has already accrued and move no
    one&rsquo;s principal. The two flush cranks pay the caller a {BOUNTY_PCT}% bounty of the
    amount flushed; the redemption-claims crank is pure maintenance and pays none.
  </>
)

export function Flush() {
  const [params] = useSearchParams()
  // Constant per build — the redirect is consistent across renders, so the hook
  // above is never skipped conditionally.
  if (!TRADING_ENABLED) return <Navigate to="/" replace />

  const basketParam = params.get('basket')
  const chainId = Number(params.get('chain')) || DEFAULT_CHAIN_ID
  const basket = basketParam && isAddress(basketParam) ? (basketParam as Address) : null

  return basket ? <FeeConsole basket={basket} chainId={chainId} /> : <FlushPicker />
}

// ── Picker (no ?basket=) ─────────────────────────────────────────────────────

function FlushPicker() {
  const { address, isConnected } = useAccount()
  const effective = isConnected && address ? address : import.meta.env.DEV ? DEV_PREVIEW_ADDRESS : undefined
  const { data: p } = usePortfolio(effective)
  // GLOBAL flush (owner 15:47: "shouldn't the fees and cranks be seen by
  // everyone?") — yes, with the contracts as they are: fee state is public
  // per-basket views, so every directory basket gets a card. Personal rows
  // inside a card simply read zero for non-holders; the cranks are everyone's.
  const { data: all } = useAllBaskets()


  const created = p?.created ?? []
  // Held baskets the wallet didn't create (creators see theirs under "created").
  const heldOnly = (p?.holdings ?? [])
    .map((h) => h.basket)
    .filter((b) => !created.some((c) => c.address.toLowerCase() === b.address.toLowerCase()))
  // One global list, yours first (owner 16:06).
  const mineKeys = new Set([...created, ...heldOnly].map((b) => `${b.chainId}:${b.address.toLowerCase()}`))
  const sorted = (all ?? [])
    .map((b) => ({ b, mine: mineKeys.has(`${b.chainId}:${b.address.toLowerCase()}`) }))
    .sort((x, y) => Number(y.mine) - Number(x.mine))

  return (
    <div className="space-y-8">
      {/* Matches the menu entry, which dropped "Flush" precisely because crank
          jargon is not what someone looking for their fees searches for.
          The sub is GONE (owner 2026-08-06 23:13): it restated in a sentence
          exactly what the hero's two labelled numbers say one line below. */}
      <PageHeader title={<>Fees</>} />

      {/* COLUMNS (owner 15:47/15:55): GLOBAL flush leads the wide left column
          (it renders the moment the directory loads — never behind the
          portfolio's loading state, which once hid it entirely); your baskets
          fold into a dropdown beneath; the auction burn rides the right.
          The standalone connect card that used to sit here is folded into the
          hero's lead slot — it spent 29 words saying what the hero now says in
          one line, above the reader's own money. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-6">
          <PipelineHero baskets={all ?? []} holder={effective as Address | undefined} />
          <section className="space-y-3">
            {/* the bounty + "anyone can flush" claims are stated ONCE here
                instead of on a chip repeated down every card (owner 23:13) */}
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
              <h2 className="font-display text-sm font-bold uppercase tracking-[0.14em] text-ink">Every basket</h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                anyone can flush · caller keeps {BOUNTY_PCT}%
              </span>
            </div>
            {(all ?? []).length === 0 ? (
              <div className="rounded-2xl card-surface p-8 text-center text-sm text-ink-faint">Loading baskets…</div>
            ) : (
              <div className="space-y-3">
                {/* ONE list, YOURS pinned on top (owner 16:06: "your baskets
                    should appear at the top" — replaces the earlier fold) */}
                {sorted.map(({ b, mine }) => (
                  <BasketFeeCard key={`${b.chainId}:${b.address}`} b={b} holder={effective as Address} mine={mine} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* the protocol-level crank — permissionless, its own column */}
        <div className="min-w-0 space-y-4 lg:sticky lg:top-24">
          <AuctionBurnCanvas />
          {/* the auction buys and burns PRISM — credit sits where that leg is
              visible (owner 2026-07-30) */}
          <div className="flex justify-center">
            <PoweredByPrism />
          </div>
        </div>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// THE HERO (owner 2026-08-02: "a combined crank flow across all baskets… as
// simple and beautiful as possible"; re-ordered 2026-08-06 23:13: "way clearer
// on what information is most important"). It answers the reader's two
// questions in the order they arrive, and the LAYOUT is the answer:
//   1. "What can I claim right now?" — the reader's own total, at display size,
//      first thing on the page. Summed from fee state already being fetched.
//   2. "What is this crank thing?" — the public pots below a rule, at a third
//      the size, with the one button that runs them all.
// The honest mechanics stay reachable, they just stopped shouting: every crank
// pays the CALLER a bounty, thresholds retain value safely (nothing is lost by
// waiting), a pot that can't be cranked here says why — all of it now behind
// the two ⓘ dots rather than in six lines of standing prose.
// ─────────────────────────────────────────────────────────────────────────────
function PipelineHero({ baskets, holder }: { baskets: BasketSummary[]; holder?: Address }) {
  const feeStates = useQueries({
    queries: baskets.map((b) => ({
      queryKey: ['spectrum', 'feeState', b.chainId, b.address.toLowerCase(), holder?.toLowerCase()],
      queryFn: () => fetchFeeState(b.address as Address, b.chainId, holder),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    })),
  })
  const gates = useQueries({
    queries: baskets.map((b) => ({
      queryKey: ['spectrum', 'burnEligible', b.chainId, b.address.toLowerCase()],
      queryFn: () => fetchBurnEligible(b.address as Address, b.chainId),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    })),
  })

  const agg = useMemo(() => {
    let potUsd = 0
    let readyUsd = 0
    let readyCount = 0
    let buildingUsd = 0
    let buildingCount = 0
    // THE READER'S FIRST QUESTION (owner 2026-08-06 23:13). Nothing new is
    // fetched for this: fetchFeeState already returns claimableUsdc for the
    // holder we pass, it was just never summed — so "what can I claim right
    // now?" could only be answered by reading ten cards' worth of $0.00 rows.
    let claimUsd = 0
    let claimCount = 0
    // A degraded read is a best-effort MISS, not a zero. Counted so the lead
    // number can say it may be understated instead of posing as complete.
    let degraded = 0
    // Past threshold on MAINNET: real and crankable, just not by THIS runner
    // (its floor is PRISM-denominated; the basket card's console cranks it).
    // Calling it "building" was factually false.
    let consoleOnlyUsd = 0
    let consoleOnlyCount = 0
    let unreadable = 0
    const chains = new Set<number>()
    baskets.forEach((b, i) => {
      const fs = feeStates[i]?.data
      if (!fs) {
        // fetchFeeState signals failure by RESOLVING null (never throwing), and
        // null also covers legacy non-V2 baskets by design — the hero cannot
        // tell them apart, so both count into the not-counted badge rather
        // than silently shrinking the total.
        if (!feeStates[i]?.isLoading) unreadable += 1
        return
      }
      chains.add(b.chainId)
      if (fs.degraded) degraded += 1
      if (fs.claimableUsdc > 0) {
        claimUsd += fs.claimableUsdc
        claimCount += 1
      }
      if (fs.pendingBurnUsdc > 0) {
        potUsd += fs.pendingBurnUsdc
        if (gates[i]?.data === true && b.chainId !== 1) {
          readyUsd += fs.pendingBurnUsdc
          readyCount += 1
        } else if (gates[i]?.data === true) {
          consoleOnlyUsd += fs.pendingBurnUsdc
          consoleOnlyCount += 1
        } else {
          buildingUsd += fs.pendingBurnUsdc
          buildingCount += 1
        }
      }
      for (const fe of fs.frontend) {
        potUsd += fe.pendingUsdc
        if (frontendPotFlushable(b.chainId, fe.pendingUsdc)) {
          readyUsd += fe.pendingUsdc
          readyCount += 1
        } else {
          buildingUsd += fe.pendingUsdc
          buildingCount += 1
        }
      }
      if (fs.pendingClaimsTokens > 0) readyCount += 1 // queue settles free, no pot value
    })
    const loading = feeStates.some((q) => q.isLoading) || gates.some((q) => q.isLoading)
    return { potUsd, readyUsd, readyCount, buildingUsd, buildingCount, consoleOnlyUsd, consoleOnlyCount, unreadable, claimUsd, claimCount, degraded, chains: chains.size, loading }
  }, [baskets, feeStates, gates])

  const bountyUsd = agg.readyUsd * (BOUNTY_PCT / 100)

  return (
    <section className="enter relative overflow-hidden rounded-3xl card-surface p-6 sm:p-8">
      <span
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full opacity-15 blur-3xl"
        style={{ background: 'var(--color-cyan)' }}
      />
      {/* ─── TWO QUESTIONS, ANSWERED IN ORDER (owner 2026-08-06 23:13: "way
          clearer on what information is most important"). The reader arrives
          asking "what can I claim right now?" and only then "what is this
          crank thing?". Until now the pots aggregate — protocol money, not
          the reader's — was the only headline, and the reader's own figure was
          a $0.00 row repeated on every card below. Priority is now literally
          the reading order: personal money at display size on top, the public
          pots and their machinery under a rule. ─── */}
      <div className="relative">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          Yours to claim
          <InfoDot>{CLAIM_EXPLAINER}</InfoDot>
        </p>
        {holder ? (
          <>
            <div className="mt-3 font-num text-5xl font-light tabular-nums text-ink sm:text-6xl">
              {agg.loading && agg.claimUsd === 0 ? '…' : usd(agg.claimUsd)}
            </div>
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              {agg.claimCount > 0
                ? `across ${agg.claimCount} basket${agg.claimCount === 1 ? '' : 's'} · claim on its card below`
                : 'nothing to claim right now'}
            </p>
          </>
        ) : (
          <div className="mt-3">
            <p className="max-w-sm text-sm leading-relaxed text-ink-dim">
              Connect a wallet to claim your fees. The board below is public either way.
            </p>
            <div className="mt-4">
              <WalletButton />
            </div>
          </div>
        )}
        {/* a best-effort read that FAILED must not let the lead number pose as
            a complete total (the same honesty rule the cards already keep) */}
        {agg.degraded > 0 && (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-amber">
            {agg.degraded} basket{agg.degraded === 1 ? '' : 's'} read incompletely (RPC) — this total may be low
          </p>
        )}

        <div className="mt-6 border-t border-white/8 pt-6">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                In the public pots
                <InfoDot>
                  Fee value sitting in the protocol&rsquo;s public pots across all{' '}
                  {agg.chains || 'the'} networks: PRISM-burn shares and interface, launcher and
                  creator accruals. Every crank here is permissionless and pays whoever runs it a{' '}
                  {BOUNTY_PCT}% bounty. &ldquo;Building&rdquo; pots are below their flush threshold —
                  they keep accruing safely, nothing is lost by waiting. Pots marked
                  &ldquo;from the card&rdquo; are past their threshold but priced in PRISM, which
                  this button cannot quote — crank those from the basket&rsquo;s own card.
                </InfoDot>
              </p>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <span className="font-num text-3xl font-light tabular-nums text-ink-dim">
                  {agg.loading && agg.potUsd === 0 ? '…' : usd(agg.potUsd)}
                </span>
                <span className="font-mono text-[11px] tabular-nums">
                  <span className="font-semibold text-teal">{agg.readyCount}</span>
                  <span className="ml-1.5 uppercase tracking-[0.12em] text-ink-faint">ready · {usd(agg.readyUsd)}</span>
                </span>
                <span className="font-mono text-[11px] tabular-nums">
                  <span className="font-semibold text-ink-dim">{agg.buildingCount}</span>
                  <span className="ml-1.5 uppercase tracking-[0.12em] text-ink-faint">building · {usd(agg.buildingUsd)}</span>
                </span>
                {agg.consoleOnlyCount > 0 && (
                  <span className="font-mono text-[11px] tabular-nums">
                    <span className="font-semibold text-ink-dim">{agg.consoleOnlyCount}</span>
                    <span className="ml-1.5 uppercase tracking-[0.12em] text-ink-faint">from the card · {usd(agg.consoleOnlyUsd)}</span>
                  </span>
                )}
                {agg.unreadable > 0 && (
                  <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-amber-300/85">
                    {agg.unreadable} not counted: unreadable or legacy
                  </span>
                )}
              </div>
            </div>
            <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-start">
              <GlobalCrankButton baskets={baskets} />
              {bountyUsd > 0.005 && (
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  pays you <span className="font-num font-semibold tabular-nums text-teal">≈{usd(bountyUsd)}</span>
                  <InfoDot>
                    Each crank pays its caller a {BOUNTY_PCT}% bounty at the moment it lands,
                    straight from the pot it moves. The estimate covers the cranks that are ready
                    right now; one wallet prompt each, skip any of them, stop any time.
                  </InfoDot>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// One compact block inside a basket's fee card (owner 16:48 layout): the
// title reads big top-left, the ACTION sits top-right on every card alike,
// the chip drops under the title, the amount anchors bottom-left.
function FeeLine({
  label,
  chip,
  value,
  hot,
  action,
  tx,
  explorer,
}: {
  label: string
  chip?: string
  value: string
  hot?: boolean
  action: ReactNode
  tx: TxState
  explorer: string
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display text-[13px] font-semibold leading-tight text-ink">{label}</div>
          {chip && (
            <div className="mt-1">
              <span className={`${CHIP} border-cyan/25 text-cyan/80`}>{chip}</span>
            </div>
          )}
          <div className={`mt-2.5 font-num text-2xl leading-none tabular-nums ${hot ? 'text-ink' : 'text-ink-dim'}`}>{value}</div>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      <TxFeedback state={tx} explorer={explorer} idleHint={null} />
    </div>
  )
}

// Every basket's fees AND cranks, live on the index itself (owner 13:46) — no
// click-through needed to act; the full console (?basket=) keeps the advanced
// controls (MEV floor, flush-another-address) and stays deep-linkable.
function BasketFeeCard({ b, holder, mine = false }: { b: BasketSummary; holder?: Address; mine?: boolean }) {
  const cfg = chainCfg(b.chainId)
  const { data: fees, isLoading, refetch } = useFeeState(b.address as Address, b.chainId, holder)
  const { data: burnGate } = useBurnEligibility(b.address, b.chainId)
  const actions = useFeeActions(b.address as Address, b.chainId, () => void refetch())
  const busy = (s: TxState) => s.status === 'signing' || s.status === 'confirming'
  const claimState = actions.stateOf(CLAIM_KEY)
  const burnState = actions.stateOf(BURN_KEY)
  const redeemState = actions.stateOf(REDEEM_KEY)
  // The burn flush derives its floor from a price fetch BEFORE the tx state
  // arms — this covers that window (no double-fire) and names the one failure
  // busy() can't see (price source down = no floor basis = refuse to send).
  const [floorPhase, setFloorPhase] = useState<'idle' | 'pricing' | 'no-price'>('idle')

  // ONLY ROWS THAT HOLD MONEY (owner 2026-08-06 23:13). Every card printed
  // "Your accrued fees $0.00" and an empty PRISM-burn block whatever the state,
  // so ten baskets of nothing buried the one or two that could be acted on —
  // the single biggest source of text on the page. A clean zero is silence now.
  // EXCEPT when the read degraded: hiding a row we failed to read would turn a
  // best-effort miss into a confident "nothing here".
  const showClaim = !!fees && (fees.claimableUsdc > 0 || fees.degraded)
  const showBurn = !!fees && fees.pendingBurnUsdc > 0
  const showRedeem = !!fees && fees.pendingClaimsTokens > 0
  const nothingPending = !!fees && !showClaim && !showBurn && !showRedeem && fees.frontend.length === 0

  return (
    <section className="enter relative overflow-hidden rounded-2xl card-surface p-5">
      <BasketWash ix={b} opacity={0.26} />
      {/* gap-y-1 on phone: the console link wraps to its own 36px row, and a
          full 12px gap ON TOP of that row's own centering left it floating
          away from the basket it belongs to. sm: never wraps, so it keeps 12. */}
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1 sm:gap-y-3">
        <BasketAvatar address={b.address} symbol={b.symbol} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate font-display text-xl font-bold leading-tight text-ink">{b.name}</div>
            {mine && (
              <span className="shrink-0 rounded-full border border-cyan/40 bg-cyan/10 px-2 py-px font-mono text-[9px] uppercase tracking-[0.14em] text-cyan">
                yours
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-ink-faint">
            ${showSymbol(b.symbol)} · {shortAddr(b.address)} · {cfg.name}
          </div>
        </div>
        {/* THE CARD'S ONLY NAVIGATION, and it was a 15px-tall tap target
            (owner 2026-08-06 23:13). On a phone it takes its own full-width
            36px row at the end of the header; sm: reverts to the inline
            auto-width link desktop already had. */}
        <Link
          to={`/flush?basket=${b.address}&chain=${b.chainId}`}
          className={`${TAP_ROW} w-full shrink-0 justify-end font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors hover:text-cyan sm:w-auto`}
        >
          Full console →
        </Link>
      </div>

      {/* the basket's own bento, thin — the identity flavor of its token page
          on the fee card (owner 16:48) */}
      <div className="relative mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/25 p-1.5">
        <BasketWash ix={b} side="full" opacity={0.3} />
        <BasketBento
          items={b.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct, chainId: b.chainId }))}
          aspect={7}
        />
      </div>

      {isLoading ? (
        <div className="relative mt-4 rounded-xl border border-white/8 p-4 text-center font-mono text-[11px] text-ink-faint">
          Loading…
        </div>
      ) : !fees ? (
        <div className="relative mt-4 rounded-xl border border-dashed border-white/12 p-4 text-center font-mono text-[11px] text-ink-faint">
          No live fee state on {cfg.name}.
        </div>
      ) : nothingPending ? (
        <p className="relative mt-4 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          Nothing pending
        </p>
      ) : (
        <div className="relative mt-4 space-y-3">
          {fees.degraded && (
            <p className="font-mono text-[10px] text-amber">
              Some balances couldn&rsquo;t be read (RPC), figures may be incomplete.
            </p>
          )}
          {/* flex, not a 2-col grid: with the empty rows gone a card often has
              only ONE money row, and it should take the full width rather than
              sit beside a hole (owner 2026-08-06 23:13) */}
          <div className="flex flex-wrap gap-3">
            {showClaim && (
              <div className="min-w-0 flex-1 basis-[240px]">
                <FeeLine
                  label="Yours to claim"
                  value={usd(fees.claimableUsdc)}
                  hot={fees.claimableUsdc > 0}
                  tx={claimState}
                  explorer={cfg.explorer}
                  action={
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      disabled={!actions.enabled || fees.claimableUsdc <= 0 || busy(claimState)}
                      onClick={actions.claim}
                    >
                      {busy(claimState) ? 'Claiming…' : 'Claim'}
                    </button>
                  }
                />
              </div>
            )}
            {showBurn && (
            <div className="min-w-0 flex-1 basis-[240px]">
              <FeeLine
                label="PRISM burn"
                /* the bounty is stated once in the section header now; this
                   chip carries the one thing the row can't show otherwise —
                   WHY the Flush button is disabled (owner 2026-08-06 23:13) */
                chip={burnGate?.eligible ? 'ready' : 'accruing'}
                value={usd(fees.pendingBurnUsdc)}
                hot={fees.pendingBurnUsdc > 0}
                tx={burnState}
                explorer={cfg.explorer}
                action={
                  <button
                    type="button"
                    className={BTN_PRIMARY}
                    disabled={!actions.enabled || !burnGate?.eligible || busy(burnState) || floorPhase === 'pricing'}
                    onClick={() => {
                      // A REAL floor, never 0: live RH legs execute a zero floor
                      // UNPROTECTED (the sandwich pattern F8 forbids) and post-F8
                      // legs refuse it outright. Same derivation as the runner.
                      void (async () => {
                        setFloorPhase('pricing')
                        const ethUsd = await fetchEthUsd({ fresh: true })
                        if (!ethUsd || !fees) {
                          setFloorPhase('no-price') // said, not silent — the console's manual floor is the path
                          return
                        }
                        setFloorPhase('idle')
                        const expectedEth = (fees.pendingBurnUsdc * (1 - BOUNTY_PCT / 100)) / ethUsd
                        const floor = parseEther((expectedEth * 0.95).toFixed(18) as `${number}`)
                        if (floor > 0n) actions.flushBurn(floor)
                      })()
                    }}
                    title={burnGate?.eligible ? undefined : 'Below the flush threshold — accruing'}
                  >
                    {busy(burnState) ? 'Flushing…' : floorPhase === 'pricing' ? 'Pricing…' : 'Flush'}
                  </button>
                }
              />
              {floorPhase === 'no-price' && (
                <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-amber">
                  no live ETH price for a slippage floor — use the console&rsquo;s manual floor
                </p>
              )}
              {/* how close this basket is to a flushable burn (owner 16:06;
                  bigger + ETH-first per 16:23 — the gate is ETH-denominated,
                  ~0.31 ETH of spot value, so ETH is the stable way to read it).
                  The threshold is probed live off the contract's own gate; the
                  bar only draws when the boundary was VERIFIED (sub-1% pendings
                  render <1%, never a fake 41%). */}
              {burnGate && !burnGate.eligible && burnGate.thresholdUsdc != null && burnGate.thresholdUsdc > 0 && (() => {
                const pct = Math.min(100, (fees.pendingBurnUsdc / burnGate.thresholdUsdc) * 100)
                const pctLabel = pct > 0 && pct < 1 ? '<1' : String(Math.round(pct))
                return (
                  <div className="mt-3 px-0.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 font-mono text-[11px] tabular-nums">
                      <span className="font-semibold text-ink">{pctLabel}% to flush</span>
                      <span className="text-ink-faint">
                        needs ≈ {burnGate.thresholdEth != null ? `${burnGate.thresholdEth.toFixed(2)} ETH` : usd(burnGate.thresholdUsdc)}
                        {burnGate.thresholdEth != null ? ` (${usd(burnGate.thresholdUsdc)})` : ''}
                      </span>
                    </div>
                    <div className="mt-2 h-3 overflow-hidden rounded-full bg-white/8 ring-1 ring-inset ring-white/10">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-cyan to-violet transition-[width] duration-500"
                        style={{ width: `${Math.max(pct > 0 ? 1.5 : 0, pct)}%` }}
                      />
                    </div>
                  </div>
                )
              })()}
            </div>
            )}
          </div>
          {/* interface / launcher / creator shares — each recipient flushes here */}
          {fees.frontend.length > 0 && (
            <div className="rounded-xl border border-white/8 bg-black/20 px-4 py-1">
              <ul className="divide-y divide-white/8">
                {fees.frontend.map((r) => {
                  const state = actions.stateOf(frontendKey(r.address))
                  // A pot at or under the chain's crank floor is REFUSED by the
                  // contract (F-1) — never offer a button that no-ops.
                  const flushable = frontendPotFlushable(b.chainId, r.pendingUsdc)
                  return (
                    <li key={r.address} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={CHIP}>{r.role}</span>
                        <span className="truncate font-mono text-[11px] text-ink-faint">{shortAddr(r.address)}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-num text-sm tabular-nums text-ink">{usd(r.pendingUsdc)}</span>
                        {flushable ? (
                          <button
                            type="button"
                            className={BTN_PRIMARY}
                            disabled={!actions.enabled || busy(state)}
                            onClick={() => actions.flushFrontend(r.address)}
                          >
                            {busy(state) ? '…' : 'Flush'}
                          </button>
                        ) : (
                          <span
                            className="rounded-full border border-amber/30 bg-amber/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-amber"
                            title={`This chain refuses frontend-fee flushes at or under $${frontendFlushFloorUsdc(b.chainId)} — the pot keeps accruing and flushes once it clears the floor.`}
                          >
                            accruing · flushes over ${frontendFlushFloorUsdc(b.chainId)}
                          </span>
                        )}
                      </div>
                      <TxFeedback state={state} explorer={cfg.explorer} idleHint={null} />
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {showRedeem && (
            <FeeLine
              label="Redemption queue"
              /* "housekeeping" was an adjective; "no bounty" is the claim */
              chip="no bounty"
              value={`${formatGrouped(fees.pendingClaimsTokens, 0)} ${showSymbol(b.symbol)}`}
              tx={redeemState}
              explorer={cfg.explorer}
              action={
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  disabled={!actions.enabled || busy(redeemState)}
                  onClick={actions.redeemClaims}
                >
                  {busy(redeemState) ? 'Settling…' : 'Settle'}
                </button>
              }
            />
          )}
        </div>
      )}
    </section>
  )
}

// The standalone ConnectPrompt card lived here. It sat ABOVE the public board
// (never replacing it — a disconnected visitor must still see the board, since
// fee state is public per-basket views and BasketFeeCard's `holder` is optional
// by construction). Its whole job — "the board is public either way, connect to
// claim and to crank" — is now ONE line in the hero's lead slot, where the
// reader's own money belongs (owner 2026-08-06 23:13). Nothing it claimed was
// dropped: "anyone can flush" moved to the board's section header.

// ── Console (?basket=0x…) ────────────────────────────────────────────────────

function FeeConsole({ basket, chainId }: { basket: Address; chainId: number }) {
  const cfg = chainCfg(chainId)
  const { address, isConnected } = useAccount()
  const holder = isConnected && address ? address : import.meta.env.DEV ? (DEV_PREVIEW_ADDRESS as Address) : undefined
  const { data: bd } = useBasketData(basket, chainId)
  const { data: fees, isLoading, refetch } = useFeeState(basket, chainId, holder)
  const actions = useFeeActions(basket, chainId, () => void refetch())

  return (
    <div className="space-y-6">
      <div>
        <Link to="/flush" className={`${TAP_ROW} gap-2 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-faint transition-colors hover:text-ink`}>
          ← All baskets
        </Link>
      </div>

      {/* Header */}
      <header className="flex flex-wrap items-center gap-4 rounded-3xl card-surface p-5">
        <BasketAvatar address={basket} symbol={bd?.symbol ?? '—'} size={52} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-xl font-bold tracking-tight text-ink">{bd?.name ?? 'Basket'}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-faint">
            {bd?.symbol && <span className="text-ink-dim">${showSymbol(bd.symbol)}</span>}
            <span>{shortAddr(basket)}</span>
            <span className="rounded-full border border-white/10 px-1.5 py-px text-[9px] uppercase tracking-[0.15em]">{cfg.name}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/token?addr=${basket}&chain=${chainId}`} className={BTN_GHOST}>Basket page</Link>
          <a href={`${cfg.explorer}/address/${basket}`} target="_blank" rel="noreferrer" className={BTN_GHOST}>Explorer</a>
        </div>
      </header>

      {isLoading ? (
        <div className="rounded-2xl card-surface p-8 text-center text-sm text-ink-faint">Loading…</div>
      ) : !fees ? (
        <div className="rounded-2xl border border-dashed border-white/12 p-10 text-center text-sm text-ink-faint">
          No live fee state for this basket. It may not be a Spectrum V2 basket, or no deployment is configured on {cfg.name}.
        </div>
      ) : (
        <>
          {/* a failed best-effort read must not pose as a real zero on the
              console people sign against (honesty audit) — both claims kept,
              said in half the words (owner 2026-08-06 23:13) */}
          {fees.degraded && (
            <p className="rounded-xl border border-amber/25 bg-amber/[0.05] px-4 py-3 font-mono text-[11px] text-amber">
              Some balances couldn&rsquo;t be read (RPC), so figures here may be incomplete. Retrying.
            </p>
          )}
          <ClaimCard
            claimable={fees.claimableUsdc}
            reserve={fees.feeReserveUsdc}
            holderConnected={!!holder}
            enabled={actions.enabled}
            state={actions.stateOf(CLAIM_KEY)}
            explorer={cfg.explorer}
            onClaim={actions.claim}
            degraded={fees.degraded}
          />

          <CrankSection
            fees={fees}
            symbol={bd?.symbol ?? 'tokens'}
            chainId={chainId}
            chainName={cfg.name}
            explorer={cfg.explorer}
            actions={actions}
          />
        </>
      )}
    </div>
  )
}

// ── Holder claim ─────────────────────────────────────────────────────────────

function ClaimCard({
  claimable, reserve, holderConnected, enabled, state, explorer, onClaim, degraded = false,
}: {
  claimable: number; reserve: number; holderConnected: boolean; enabled: boolean
  state: TxState; explorer: string; onClaim: () => void; degraded?: boolean
}) {
  const busy = state.status === 'signing' || state.status === 'confirming'
  return (
    <section className="rounded-3xl card-surface p-6">
      {/* The paragraph that stood here is behind the ⓘ now — every word of it
          kept, none of it competing with the number the reader came for
          (owner 2026-08-06 23:13). */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-ink">
            Yours to claim
            <InfoDot>{CLAIM_EXPLAINER}</InfoDot>
          </h2>
          <p className="mt-2 font-mono text-[11px] text-ink-faint">
            Holder reserve backing claims <span className="tabular-nums text-ink-dim">{usd(reserve)}</span>
          </p>
        </div>
        <div className="text-right">
          <div className="font-num text-3xl font-light tabular-nums text-ink">{usd(claimable)}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">claimable now</div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-white/8 pt-4">
        {holderConnected ? (
          <button type="button" className={BTN_PRIMARY} disabled={!enabled || claimable <= 0 || busy} onClick={onClaim}>
            {busy ? 'Claiming…' : 'Claim fees'}
          </button>
        ) : (
          <WalletButton />
        )}
      </div>
      {holderConnected && claimable <= 0 && state.status === 'idle' && (
        <p className={`mt-2 text-right font-mono text-[10px] ${degraded ? 'text-amber' : 'text-ink-faint'}`}>
          {degraded ? 'Your balance could not be read just now, retrying.' : 'Nothing to claim right now.'}
        </p>
      )}
      <TxFeedback state={state} explorer={explorer} idleHint={null} />
    </section>
  )
}

// ── Permissionless cranks ────────────────────────────────────────────────────

function CrankSection({
  fees, symbol, chainId, chainName, explorer, actions,
}: {
  fees: { pendingBurnUsdc: number; pendingClaimsTokens: number; frontend: FrontendAccrual[] }
  symbol: string; chainId: number; chainName: string; explorer: string
  actions: ReturnType<typeof useFeeActions>
}) {
  return (
    <section className="space-y-3">
      {/* the 40-word standing explanation moved behind the ⓘ, verbatim
          (owner 2026-08-06 23:13) — the "permissionless" tag beside the
          heading is the one-word version that stays on the surface */}
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-semibold text-ink">
          Protocol cranks
          <InfoDot>{CRANK_EXPLAINER}</InfoDot>
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">permissionless</span>
      </div>

      <BurnCrankCard
        pending={fees.pendingBurnUsdc}
        enabled={actions.enabled}
        state={actions.stateOf(BURN_KEY)}
        explorer={explorer}
        onFlush={actions.flushBurn}
      />

      <FrontendFlushCard
        rows={fees.frontend}
        chainId={chainId}
        chainName={chainName}
        explorer={explorer}
        actions={actions}
      />

      <RedeemClaimsCard
        pendingTokens={fees.pendingClaimsTokens}
        symbol={symbol}
        enabled={actions.enabled}
        state={actions.stateOf(REDEEM_KEY)}
        explorer={explorer}
        onSettle={actions.redeemClaims}
      />
    </section>
  )
}

function RedeemClaimsCard({
  pendingTokens, symbol, enabled, state, explorer, onSettle,
}: {
  pendingTokens: number; symbol: string; enabled: boolean; state: TxState; explorer: string; onSettle: () => void
}) {
  const busy = state.status === 'signing' || state.status === 'confirming'
  return (
    <div className="rounded-2xl card-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-display text-sm font-semibold text-ink">
              Redemption claims
              {/* what it does, kept whole, behind the dot (owner 23:13) */}
              <InfoDot>
                Settles the lazy-burn queue (burns basket tokens already redeemed). Keeps
                redemption reachable for a frozen leg.
              </InfoDot>
            </h3>
            <span className={CHIP}>maintenance · no bounty</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-num text-xl font-light tabular-nums text-ink">{formatGrouped(pendingTokens, 0)}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">{symbol} queued</div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end border-t border-white/8 pt-3">
        <button type="button" className={BTN_GHOST} disabled={!enabled || pendingTokens <= 0 || busy} onClick={onSettle}>
          {busy ? 'Settling…' : 'Settle claims'}
        </button>
      </div>
      <TxFeedback state={state} explorer={explorer} idleHint={null} />
    </div>
  )
}

function BurnCrankCard({
  pending, enabled, state, explorer, onFlush,
}: {
  pending: number; enabled: boolean; state: TxState; explorer: string; onFlush: (minEthOut: bigint) => void
}) {
  const [showAdv, setShowAdv] = useState(false)
  const [minEth, setMinEth] = useState('')
  const busy = state.status === 'signing' || state.status === 'confirming'

  // Empty field = NO floor = refuse to send. A 0-floor flush executes
  // unprotected on live RH legs and reverts on post-F8 legs — either way it
  // must never leave this surface by default.
  let minWei: bigint | null = null
  let minErr = false
  if (minEth.trim()) {
    try { minWei = parseEther(minEth.trim() as `${number}`) } catch { minErr = true }
  }

  return (
    <div className="rounded-2xl card-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-display text-sm font-semibold text-ink">
              PRISM burn
              <InfoDot>Sells the accrued burn share to ETH and bridges it to the L1 PrismBurner.</InfoDot>
            </h3>
            <BountyChip />
          </div>
        </div>
        <div className="text-right">
          <div className="font-num text-xl font-light tabular-nums text-ink">{usd(pending)}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">pending</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-3">
        <button type="button" onClick={() => setShowAdv((v) => !v)} className={`${TAP_ROW} font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint transition-colors hover:text-ink`}>
          {showAdv ? '− Min ETH out' : '+ Min ETH out'}
        </button>
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={!enabled || pending <= 0 || busy || minErr || minWei == null || minWei === 0n}
          onClick={() => minWei != null && minWei > 0n && onFlush(minWei)}
        >
          {busy ? 'Flushing…' : 'Flush burn'}
        </button>
      </div>

      {showAdv && (
        <div className="mt-3 space-y-1.5">
          <label className="block font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint">Minimum ETH out (slippage floor)</label>
          <input
            value={minEth}
            onChange={(e) => setMinEth(e.target.value)}
            inputMode="decimal" enterKeyHint="done" autoComplete="off"
            placeholder="0.0"
            className="w-full rounded-lg border border-white/12 bg-black/20 px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-cyan/50"
          />
        </div>
      )}
      {minErr && (
        <p className="mt-2 font-mono text-[10px] text-magenta">
          The minimum-ETH floor isn&rsquo;t a valid amount{showAdv ? '.' : ' — open “Min ETH out” to fix it.'}
        </p>
      )}
      {/* Always visible (not nested in the advanced panel): the button now REFUSES
          to send without a floor — an unfloored flush accepts any ETH amount, the
          exact sandwich shape F8 forbids, and post-F8 legs revert it anyway. */}
      {pending > 0 && !minErr && (minWei == null || minWei === 0n) && (
        <p className="mt-2 font-mono text-[10px] text-amber">
          A slippage floor is required to flush.{' '}
          {showAdv ? 'Set the minimum ETH out above.' : 'Open “Min ETH out” to set one.'}
        </p>
      )}
      {pending > 0 && state.status === 'idle' && (
        <p className="mt-2 font-mono text-[10px] text-ink-faint">Very small balances revert until they clear the bridge threshold.</p>
      )}
      <TxFeedback state={state} explorer={explorer} idleHint={null} />
    </div>
  )
}

function FrontendFlushCard({
  rows, chainId, chainName, explorer, actions,
}: {
  rows: FrontendAccrual[]; chainId: number; chainName: string; explorer: string; actions: ReturnType<typeof useFeeActions>
}) {
  const [other, setOther] = useState('')
  const otherValid = isAddress(other.trim())

  return (
    <div className="rounded-2xl card-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-sm font-semibold text-ink">
          Interface, launcher &amp; creator fees
          <InfoDot>
            Pushes a recipient&rsquo;s accrued fee to them. The interface, launcher and creator
            shares all flush through here.
          </InfoDot>
        </h3>
        <BountyChip />
      </div>

      <ul className="mt-4 divide-y divide-white/8">
        {rows.length === 0 && (
          <li className="py-3 font-mono text-[11px] text-ink-faint">No interface / launcher / creator fees pending.</li>
        )}
        {rows.map((r) => {
          const state = actions.stateOf(frontendKey(r.address))
          const busy = state.status === 'signing' || state.status === 'confirming'
          // Refused by the contract at or under the chain's crank floor (F-1).
          const flushable = frontendPotFlushable(chainId, r.pendingUsdc)
          return (
            <li key={r.address} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border border-white/12 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.15em] text-ink-dim">{r.role}</span>
                    <span className="truncate font-mono text-[11px] text-ink-faint">{shortAddr(r.address)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-num text-sm tabular-nums text-ink">{usd(r.pendingUsdc)}</span>
                  {flushable ? (
                    <button type="button" className={BTN_GHOST} disabled={!actions.enabled || busy} onClick={() => actions.flushFrontend(r.address)}>
                      {busy ? '…' : 'Flush'}
                    </button>
                  ) : (
                    <span
                      className="rounded-full border border-amber/30 bg-amber/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-amber"
                      title={`This chain refuses frontend-fee flushes at or under $${frontendFlushFloorUsdc(chainId)} — the pot keeps accruing and flushes once it clears the floor.`}
                    >
                      accruing · flushes over ${frontendFlushFloorUsdc(chainId)}
                    </span>
                  )}
                </div>
              </div>
              <TxFeedback state={state} explorer={explorer} idleHint={null} />
            </li>
          )
        })}
      </ul>

      {/* Advanced: the crank is keyed by an arbitrary recipient. */}
      <details className="mt-4 border-t border-white/8 pt-3">
        {/* padding, not flex/min-h: a <summary> must stay display:list-item or
            it loses its disclosure triangle. py-3 → a 37px tap row on phone,
            sm:py-0 restores the desktop box exactly. */}
        <summary className="press cursor-pointer py-3 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-faint transition-colors hover:text-ink sm:py-0">
          Flush another address
        </summary>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-white/12 bg-black/20 px-3 py-2 font-mono text-xs text-ink outline-none transition-colors focus:border-cyan/50"
          />
          <button
            type="button"
            className={BTN_GHOST}
            disabled={!actions.enabled || !otherValid}
            onClick={() => otherValid && actions.flushFrontend(other.trim() as Address)}
          >
            Flush
          </button>
        </div>
        {/* already behind a disclosure, so it keeps all three claims:
            no-op is harmless · the chain's floor refusal · required network */}
        <p className="mt-2 font-mono text-[10px] text-ink-faint">
          Nothing pending is a harmless no-op
          {frontendFlushFloorUsdc(chainId) > 0
            ? `; this chain refuses pots at or under $${frontendFlushFloorUsdc(chainId)} (they keep accruing)`
            : ''}
          . Wallet must be on {chainName}.
        </p>
        {otherValid && <TxFeedback state={actions.stateOf(frontendKey(other.trim()))} explorer={explorer} idleHint={null} />}
      </details>
    </div>
  )
}

// ── Shared tx status line ────────────────────────────────────────────────────

function TxFeedback({ state, explorer, idleHint }: { state: TxState; explorer: string; idleHint: string | null }) {
  if (state.status === 'idle') return idleHint ? <p className="mt-2 font-mono text-[10px] text-ink-faint">{idleHint}</p> : null

  const txLink = state.hash ? (
    <a href={`${explorer}/tx/${state.hash}`} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-ink">
      {shortAddr(state.hash)}
    </a>
  ) : null

  return (
    <div className="enter mt-2 font-mono text-[11px]">
      {state.status === 'signing' && <span className="text-ink-dim">Confirm in your wallet…</span>}
      {state.status === 'confirming' && <span className="text-cyan">Confirming… {txLink}</span>}
      {state.status === 'success' && <span className="text-teal">Done. {txLink}</span>}
      {state.status === 'error' && <span className="text-magenta">{state.error ?? 'Transaction failed.'}</span>}
    </div>
  )
}


// ── "Crank everything" (owner 2026-07-07 16:00: "one click to do all of the
// baskets for anything that is global — not the fees, that's per person. If
// it's possible, build it"). One click scans every basket's PUBLIC fee state
// and walks every permissionless crank with a balance as sequential wallet
// prompts: flushPrismBurn (REAL price-derived floor; zero reverts post-F8),
// flushFrontendFees per accrued recipient, redeemClaims when the lazy-burn
// queue holds tokens. claimFees is deliberately absent (personal). A failed
// crank is skipped, never aborts the run.
interface CrankJob {
  basket: Address
  chainId: number
  symbol: string
  label: string
  fn: 'flushPrismBurn' | 'flushFrontendFees' | 'redeemClaims'
  args: readonly unknown[]
}

function GlobalCrankButton({ baskets }: { baskets: BasketSummary[] }) {
  const { isConnected, address, connector, chainId: walletChain } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()
  const qc = useQueryClient()
  const [run, setRun] = useState<{ phase: 'scan' | 'crank'; done: number; total: number; label: string } | null>(null)
  const [summary, setSummary] = useState<{ ok: number; failed: number; unfloorable: number; note?: string } | null>(null)

  // The passive "N flushable · N building" count that used to sit beside this
  // button (owner 16:06) is GONE — not for length, for correctness. It counted
  // BASKETS with an eligible burn gate while the hero two inches away counts
  // POTS crankable now, so the surface showed "0 flushable" beside
  // "22 ready · $13.43" and neither reading explained the other. The hero's is
  // the one that matches what the button runs (it also cranks frontend pots and
  // claim queues, which the gate count never saw). Its gate probe went with it;
  // PipelineHero already runs the identical query, same key, so nothing lost.
  // (owner 2026-08-06 23:13: "make it way clearer what information matters".)

  async function crankEverything() {
    if (!isConnected || run) return
    setSummary(null)
    setRun({ phase: 'scan', done: 0, total: baskets.length, label: 'Reading fee state…' })

    const jobs: CrankJob[] = []
    // ONE price for the whole run, read from the WIRE at run start ({fresh}
    // bypasses the 10-minute display cache — a floor from a stale price is
    // either too high, every job "skipped", or silently wider than the 5% it
    // claims). Null = burns can't be floored this run — counted and SAID in
    // the summary, never silently omitted.
    const runEthUsd = await fetchEthUsd({ fresh: true })
    let unfloorable = 0
    for (const [i, b] of baskets.entries()) {
      setRun({ phase: 'scan', done: i + 1, total: baskets.length, label: `Reading $${showSymbol(b.symbol)}…` })
      const fs = await fetchFeeState(b.address as Address, b.chainId).catch(() => null)
      if (!fs) continue
      const base = { basket: b.address as Address, chainId: b.chainId, symbol: b.symbol }
      // Burns queue only past the contract's own gate — a below-threshold
      // basket is SKIPPED here, not sent to revert (owner 16:06). The floor is
      // REAL (zero floors revert, F8): expected ETH out from the live price,
      // haircut 5% as sandwich protection. Mainnet's floor is denominated in
      // PRISM (minPrismOut) which this page cannot quote yet — those pots stay
      // crankable from their basket card's manual-floor field, never sent blind.
      if (fs.pendingBurnUsdc > 0 && b.chainId !== 1 && (await fetchBurnEligible(b.address as Address, b.chainId))) {
        if (runEthUsd) {
          const expectedEth = (fs.pendingBurnUsdc * (1 - BOUNTY_PCT / 100)) / runEthUsd
          const minEthOut = parseEther(((expectedEth * 0.95).toFixed(18)) as `${number}`)
          if (minEthOut > 0n)
            jobs.push({ ...base, label: `$${showSymbol(b.symbol)} · PRISM burn (${usd(fs.pendingBurnUsdc)})`, fn: 'flushPrismBurn', args: [minEthOut] })
        } else unfloorable += 1
      }
      // Sub-floor pots are SKIPPED like below-threshold burns — the contract
      // refuses them (F-1), and on the incumbent mainnet lineage a sub-floor
      // flush would pay the whole pot to the CRANKER instead of the recipient.
      for (const fe of fs.frontend)
        if (frontendPotFlushable(b.chainId, fe.pendingUsdc))
          jobs.push({ ...base, label: `$${showSymbol(b.symbol)} · ${fe.role} fees (${usd(fe.pendingUsdc)})`, fn: 'flushFrontendFees', args: [fe.address] })
      if (fs.pendingClaimsTokens > 0)
        jobs.push({ ...base, label: `$${showSymbol(b.symbol)} · settle claim queue`, fn: 'redeemClaims', args: [] })
    }

    if (jobs.length === 0) {
      setRun(null)
      setSummary({ ok: 0, failed: 0, unfloorable })
      return
    }

    let ok = 0
    let failed = 0
    let note: string | undefined
    // The render-time walletChain is a STALE CLOSURE after the first switch —
    // track the chain we actually switched to (this morning's fix), and GROUP
    // jobs per chain so a batching wallet takes each chain's cranks behind ONE
    // confirmation (EIP-5792; sequential prompts stay the fallback).
    let onChain = walletChain
    let doneCount = 0
    const runOne = async (j: CrankJob) => {
      try {
        if (onChain !== j.chainId) {
          await switchChainAsync({ chainId: j.chainId })
          onChain = j.chainId
        }
        const hash =
          j.fn === 'flushPrismBurn'
            ? await writeContractAsync({ address: j.basket, abi: basketAbi, functionName: 'flushPrismBurn', args: j.args as [bigint], chainId: j.chainId })
            : j.fn === 'flushFrontendFees'
              ? await writeContractAsync({ address: j.basket, abi: basketAbi, functionName: 'flushFrontendFees', args: j.args as [Address], chainId: j.chainId })
              : await writeContractAsync({ address: j.basket, abi: basketAbi, functionName: 'redeemClaims', chainId: j.chainId })
        await publicClient?.waitForTransactionReceipt({ hash })
        ok += 1
      } catch {
        failed += 1 // rejected in wallet or reverted — move on, the rest still cranks
      }
    }
    const jobCall = (j: CrankJob): BatchCall => ({
      to: j.basket,
      data:
        j.fn === 'flushPrismBurn'
          ? encodeFunctionData({ abi: basketAbi, functionName: 'flushPrismBurn', args: j.args as [bigint] })
          : j.fn === 'flushFrontendFees'
            ? encodeFunctionData({ abi: basketAbi, functionName: 'flushFrontendFees', args: j.args as [Address] })
            : encodeFunctionData({ abi: basketAbi, functionName: 'redeemClaims' }),
    })

    const provider = (await connector?.getProvider?.().catch(() => undefined)) as Eip1193Like | undefined
    const groups = new Map<number, CrankJob[]>()
    for (const j of jobs) {
      const g = groups.get(j.chainId)
      if (g) g.push(j)
      else groups.set(j.chainId, [j])
    }

    outer: for (const [gChain, group] of groups) {
      if (onChain !== gChain) {
        try {
          await switchChainAsync({ chainId: gChain })
          onChain = gChain
        } catch {
          failed += group.length // network switch refused — the whole group is unreachable
          doneCount += group.length
          continue
        }
      }
      const canBatch =
        group.length > 1 && provider && address ? await probeBatchSupport(provider, address, gChain) : false
      if (canBatch && provider && address) {
        setRun({
          phase: 'crank',
          done: doneCount,
          total: jobs.length,
          label: `one confirmation · ${group.length} cranks on ${chainCfg(gChain).name}`,
        })
        const outcome = await runBatch(provider, address, gChain, group.map(jobCall))
        if (outcome.kind === 'success') {
          ok += outcome.okCount
          failed += group.length - outcome.okCount
          doneCount += group.length
          continue
        }
        if (outcome.kind === 'timeout') {
          // The batch may still land — re-sending would double-crank. Stop here.
          failed += group.length
          doneCount += group.length
          note = 'a batch is still pending in your wallet — nothing was re-sent; check the wallet and rescan'
          break outer
        }
        // failure → the wallet refused or the batch reverted; independent calls
        // are safe to retry one at a time.
      }
      for (const j of group) {
        setRun({ phase: 'crank', done: doneCount, total: jobs.length, label: j.label })
        await runOne(j)
        doneCount += 1
      }
    }
    setRun(null)
    setSummary({ ok, failed, unfloorable, note })
    void qc.invalidateQueries({ queryKey: ['spectrum', 'feeState'] })
  }

  return (
    // full-width stack on a phone (a 160px button floating in a 358px card
    // reads as an afterthought), inline row from sm: as before
    <span className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row-reverse sm:items-center sm:gap-3">
      <button
        type="button"
        disabled={!isConnected || run != null || baskets.length === 0}
        onClick={() => void crankEverything()}
        className={BTN_PRIMARY}
        title={isConnected ? 'Run every public crank with a balance, one wallet prompt at a time' : 'Connect a wallet first'}
      >
        {run ? 'Cranking…' : 'Crank everything'}
      </button>
      {run && (
        <span className="font-mono text-[10px] tabular-nums text-ink-faint">
          {run.phase === 'scan' ? run.label : `${run.done + 1}/${run.total} · ${run.label}`}
        </span>
      )}
      {/* the run summary keeps every claim it made, including WHY a burn was
          held back (no live price = no floor = not sent) */}
      {summary && !run && (
        <span className="font-mono text-[10px] text-ink-faint">
          {summary.ok + summary.failed + summary.unfloorable === 0
            ? 'Nothing to crank — all clear.'
            : `✓ ${summary.ok} cranked${summary.failed ? ` · ${summary.failed} skipped` : ''}${
                summary.unfloorable
                  ? ` · ${summary.unfloorable} burn${summary.unfloorable === 1 ? '' : 's'} held: no live ETH price for a floor — retry, or use the basket card`
                  : ''
              }${summary.note ? ` · ${summary.note}` : ''}`}
        </span>
      )}
    </span>
  )
}
