import { useEffect, useState } from 'react'
import { Link as RouterLink, useNavigate } from 'react-router'
import { useAccount, useReadContract } from 'wagmi'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { writeRunLanded } from '../lib/spectrum/run-landed'
import { useBasketData } from '../lib/spectrum/hooks'
import { basketPnl, usePnlIndexes } from '../lib/spectrum/pnl'
import { erc20BalanceAbi } from '../lib/spectrum/abis-v2'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { formatUnits } from 'viem'
import { settlementDecimalsFor } from '../lib/chain/deployments'
import type { DexStep, DexTxState } from '../lib/spectrum/use-dex-swap'
import { AddToWalletButton } from './AddToWalletButton'
import { AssetLogo } from './AssetLogo'
import { BasketAvatar } from './BasketAvatar'
import { BasketBento, type BentoItem } from './BasketBento'
import { ShareEarnNudge } from './ShareEarnNudge'
import { RevertCauses } from './RevertCauses'

// A pop-up shown while a buy/sell is in flight — a Spectrum-flavoured prism
// refraction to pass the wait, over the live step progress. Purely presentational:
// it reads the swap's per-step tx state, never drives it. Mounted from DexSwapCard,
// so it covers both the token-page rail and /swap. Motion respects
// prefers-reduced-motion (the spinners freeze, the layout stays).

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

function stepState(tx: DexTxState): 'pending' | 'active' | 'done' | 'error' {
  if (tx.status === 'success') return 'done'
  if (tx.status === 'error') return 'error'
  if (tx.status === 'signing' || tx.status === 'confirming') return 'active'
  return 'pending'
}

// ── the animation: the basket's own identity (or a refracting prism when we
//    have no basket) inside spinning spectral rings ────────────────────────────
// Exported (the owner 2026-08-13: the create flow's add wants "that little pop up
// card we have in the system … asset and a rainbow loading circle") — the
// Composer mounts THIS, never a lookalike; one ring, every wait.
export function PrismAnim({ celebrate, logo }: { celebrate?: boolean; logo?: ReactNode }) {
  return (
    <div className="relative mx-auto h-36 w-36">
      {/* soft spectral bloom */}
      <div
        aria-hidden
        className={`absolute inset-0 rounded-full blur-2xl transition-opacity duration-500 ${celebrate ? 'opacity-70' : 'opacity-40'}`}
        style={{ background: SPECTRAL }}
      />
      {/* outer conic ring, spinning; the inner disc masks it into a ring */}
      <div
        aria-hidden
        className="absolute inset-0 animate-spin rounded-full motion-reduce:animate-none"
        style={{ background: 'conic-gradient(from 0deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta),var(--color-cyan))', animationDuration: '2.8s' }}
      />
      <div aria-hidden className="absolute inset-[7px] rounded-full bg-panel" />
      {/* faint counter ring for depth */}
      <div
        aria-hidden
        className="absolute inset-[14px] animate-spin rounded-full border border-white/10 motion-reduce:animate-none"
        style={{ animationDuration: '6s', animationDirection: 'reverse' }}
      />
      {/* orbiting spark */}
      <div aria-hidden className="absolute inset-0 animate-spin motion-reduce:animate-none" style={{ animationDuration: '3.4s' }}>
        <span className="absolute left-1/2 top-1 h-2 w-2 -translate-x-1/2 rounded-full bg-cyan shadow-[0_0_10px_var(--color-cyan)]" />
      </div>
      {/* center: the basket's logo when trading a basket (owner 2026-07-07:
          "the logo there should be the basket's logo"), else the prism */}
      <div className="absolute inset-0 grid place-items-center">
        {logo && !celebrate ? (
          <div className="animate-pulse motion-reduce:animate-none">{logo}</div>
        ) : (
        <svg viewBox="0 0 64 64" className={`h-16 w-16 ${celebrate ? '' : 'animate-pulse'} motion-reduce:animate-none`} fill="none">
          {celebrate ? (
            <path d="M18 33l10 10 20-22" stroke="var(--color-teal)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <>
              {/* incoming white beam */}
              <path d="M4 32h20" stroke="var(--color-ink)" strokeWidth="2.5" strokeLinecap="round" />
              {/* prism triangle */}
              <path d="M26 16L46 32 26 48z" stroke="url(#pg)" strokeWidth="2.5" strokeLinejoin="round" fill="rgba(164,139,255,0.10)" />
              {/* refracted spectral fan */}
              <path d="M46 32l16-8" stroke="var(--color-cyan)" strokeWidth="2" strokeLinecap="round" />
              <path d="M46 32l16 0" stroke="var(--color-violet-bright)" strokeWidth="2" strokeLinecap="round" />
              <path d="M46 32l16 8" stroke="var(--color-magenta)" strokeWidth="2" strokeLinecap="round" />
              <defs>
                <linearGradient id="pg" x1="26" y1="16" x2="46" y2="48" gradientUnits="userSpaceOnUse">
                  <stop stopColor="var(--color-cyan)" /><stop offset="0.5" stopColor="var(--color-violet-bright)" /><stop offset="1" stopColor="var(--color-magenta)" />
                </linearGradient>
              </defs>
            </>
          )}
        </svg>
        )}
      </div>
    </div>
  )
}

// ── the buy swirl: the launch portal's converge moment, for buys ──────────────
// The basket's constituents orbit its avatar while the buy runs (staggered
// radii/speeds/phases); on success the orbit layer collapses INTO the center —
// the assets visibly "drop in" — and the celebration heading takes over.
function BuySwirl({
  constituents,
  chainId,
  center,
  celebrate,
}: {
  constituents: { address: string; symbol: string }[]
  chainId: number
  center: ReactNode
  celebrate: boolean
}) {
  const orbs = constituents.slice(0, 7)
  return (
    <div className="relative mx-auto h-44 w-44">
      {/* soft spectral bloom behind everything */}
      <div
        aria-hidden
        className={`absolute inset-0 rounded-full blur-2xl transition-opacity duration-500 ${celebrate ? 'opacity-70' : 'opacity-35'}`}
        style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
      />
      {/* faint guide ring */}
      <div aria-hidden className="absolute inset-[10px] rounded-full border border-white/10" />
      {/* the orbiting constituents — collapse into the center on success */}
      <div className={`absolute inset-0 ${celebrate ? 'buy-collapse' : ''}`}>
        {orbs.map((c, i) => {
          const r = 56 + (i % 3) * 14
          const t = 2.6 + (i % 4) * 0.7
          const phase = (360 / orbs.length) * i
          return (
            <div
              key={c.address}
              className="absolute left-1/2 top-1/2 -ml-[14px] -mt-[14px]"
              style={{ transform: `rotate(${phase}deg)` }}
            >
              <div
                className="buy-orbit"
                style={{ '--orbit-r': `${r}px`, '--orbit-t': `${t}s` } as React.CSSProperties}
              >
                <span className="block rounded-full shadow-[0_6px_18px_rgba(0,0,0,0.45)] ring-1 ring-white/20">
                  <AssetLogo address={c.address} symbol={c.symbol} chainId={chainId} size={28} />
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {/* the basket identity at the center — pulses as the assets land */}
      <div className="absolute inset-0 grid place-items-center">
        <div className={celebrate ? 'portal-success-pulse rounded-full' : 'animate-pulse motion-reduce:animate-none'}>{center}</div>
      </div>
    </div>
  )
}

// ── the buy success card: the bento you just bought + the handy actions ───────
// Replaces the old text-only buy success (owner 2026-07-09): once the receipt
// lands, the popup becomes the basket itself — the weighted bento grid front and
// center — with Add to wallet / Share on X / Copy referral link beneath. Share
// buttons render only when `share` is set (the deployer keeps their own creator
// surfaces; the suppression rule is the caller's, unchanged).
function BuySuccessCard({
  symbol,
  seeding,
  token,
  decimals,
  bentoItems,
  usdRaw,
  txHash,
  explorer,
  share,
  onClose,
  previewWallet,
  stayHere,
}: {
  symbol: string
  seeding?: boolean
  token: { address: string; chainId: number }
  decimals?: number
  bentoItems: BentoItem[]
  usdRaw?: bigint | null
  txHash: string
  explorer: string
  share?: { url: string; xHref: string } | null
  onClose: () => void
  previewWallet?: boolean
  /** The host keeps the user after a buy (the chat owns the whole flow), so
   *  Done is the primary and the portfolio becomes the quiet link. Default
   *  false preserves the owner's 2026-08-16 ruling everywhere else. */
  stayHere?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!share) return
    try {
      await navigator.clipboard.writeText(share.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }
  const usd = usdRaw != null && usdRaw > 0n ? Number(formatUnits(usdRaw, 6)) : null
  // Match AddToWalletButton's lg chip grammar exactly — one uniform action row
  // (owner 2026-07-09: the three action buttons a bit bigger).
  const chip =
    'press inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 font-mono text-xs text-ink-dim transition-colors hover:border-cyan/50 hover:text-ink'

  return (
    <div>
      {/* Sizing pass (owner 2026-07-09 18:01): eyebrow + dollar line + referral
          copy all a step bigger; the card itself gains width and height. */}
      <div className="font-mono text-xs uppercase tracking-[0.2em] text-teal">
        ✓ {seeding ? 'Seeded, first buy in' : 'Purchase confirmed'}
      </div>
      <h3 className="mt-2 font-display text-3xl font-bold tracking-tight text-ink">
        {seeding ? `$${showSymbol(symbol)} is live` : `You now hold $${showSymbol(symbol)}`}
      </h3>
      <p className="mt-2 font-mono text-sm leading-relaxed text-ink-dim">
        {usd != null
          ? `≈ $${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })} across ${bentoItems.length} assets, in one token.`
          : `${bentoItems.length} assets, in one token.`}
      </p>

      {/* the thing you bought — tiles sized by weight, staggered in */}
      <div className="mt-5 overflow-hidden rounded-xl border border-white/10 bg-black/25 p-3">
        <BasketBento items={bentoItems} aspect={2.1} reveal={{ delayMs: 120, stepMs: 90 }} />
      </div>

      {/* YOUR POSITION, not just the receipt (owner 2026-08-16: after a buy
          "it should just show your holdings of the asset, how much it was
          valued at purchase, how much its worth now and pnl %") — the
          basket-holder math the portfolio already trusts (basketPnl over the
          cached flow index). Absent facts leave no gap: rows render only
          when their read answers. */}
      <PositionStrip token={token} decimals={decimals} justPaidRaw={usdRaw ?? null} />


      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <AddToWalletButton
          address={token.address}
          symbol={symbol}
          decimals={decimals}
          chainId={token.chainId}
          requireBalance={false}
          preview={previewWallet}
          size="lg"
        />
        {share && (
          <>
            <a href={share.xHref} target="_blank" rel="noreferrer" className={chip}>
              Share on X
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M7 17L17 7M7 7h10v10" />
              </svg>
            </a>
            <button type="button" onClick={() => void copy()} className={chip}>
              {copied ? 'Link copied ✓' : 'Copy referral link'}
            </button>
          </>
        )}
      </div>
      {share && (
        <p className="mt-3 font-mono text-xs leading-relaxed text-teal/90">
          Your link earns ~5% of the fee on buys through it.{' '}
          <a href="/earn" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-cyan">
            Learn more about the refer system
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
            </svg>
          </a>
        </p>
      )}

      <a
        href={`${explorer}/tx/${txHash}`}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-block font-mono text-[11px] text-cyan hover:underline"
      >
        view final tx ↗
      </a>
      {/* THE PRIMARY LANDS ON THE PORTFOLIO (owner 2026-08-16: after a buy,
          Done "should auto default to see your asset in your portfolio…
          which then takes you to your portfolio page") — the bought basket's
          key rides run-landed so its tile glows on arrival, and /portfolio's
          own onboarding gate covers a first-timer. A quiet stay-here escape
          keeps the old close for whoever wants this page. */}
      {/* HOST DECIDES (owner 2026-08-21, the one-button audit). His 2026-08-16
          ruling — the primary lands on the portfolio — still governs the swap
          and token pages, where navigating onward IS the next step. In a host
          that owns the whole flow (the chat), leaving mid-flow is the one thing
          the primary must not do, so the two swap places. */}
      {stayHere ? (
        <>
          <button
            type="button"
            onClick={onClose}
            className="press mt-3 w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black"
            style={{ background: 'linear-gradient(90deg,var(--color-teal),var(--color-cyan))' }}
          >
            Done
          </button>
          <SeePortfolioLink token={token} onClose={onClose} />
        </>
      ) : (
        <>
          <SeePortfolioButton token={token} onClose={onClose} />
          <button
            type="button"
            onClick={onClose}
            className="press mt-2 w-full py-2 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
          >
            stay on this page
          </button>
        </>
      )}
    </div>
  )
}

function PositionStrip({
  token,
  decimals,
  justPaidRaw = null,
}: {
  token: { address: string; chainId: number }
  decimals?: number
  /** What THIS buy just paid (settlement raw) — the fallback basis while the
   *  cached PnL index (60s stale, history-derived) cannot yet contain the buy
   *  that landed seconds ago (audit 2026-08-16: a first-time buyer read
   *  "at purchase —" and "pnl —" on the exact numbers the app already knew). */
  justPaidRaw?: bigint | null
}) {
  const { address: wallet } = useAccount()
  const { data: ix } = useBasketData(token.address, token.chainId)
  const { data: balRaw } = useReadContract({
    address: token.address as `0x${string}`,
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: [wallet ?? '0x0000000000000000000000000000000000000000'],
    chainId: token.chainId,
    query: { enabled: !!wallet },
  })
  const pnlIdx = usePnlIndexes(wallet)
  if (!wallet || balRaw == null || ix == null) return null
  const balance = Number(formatUnits(balRaw as bigint, decimals ?? 18))
  if (!(balance > 0)) return null
  const pnl = basketPnl(pnlIdx[token.chainId] ?? null, token.address, ix.navPerToken, balance)
  const nowUsd = Number.isFinite(ix.navPerToken) && ix.navPerToken > 0 ? balance * ix.navPerToken : null
  // the just-paid fallback: THIS purchase's own cost, marked "this buy" so it
  // never claims to be the whole position's basis
  const paidUsd =
    justPaidRaw != null && justPaidRaw > 0n ? Number(formatUnits(justPaidRaw, settlementDecimalsFor(token.chainId))) : null
  const investedUsd = pnl ? pnl.investedUsd : paidUsd
  const investedLabel = pnl ? 'at purchase' : 'this buy'
  const pnlPct =
    pnl != null ? pnl.netPct * 100 : paidUsd != null && paidUsd > 0 && nowUsd != null ? ((nowUsd - paidUsd) / paidUsd) * 100 : null
  const money = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return (
    <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left sm:grid-cols-4">
      <div>
        <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">you hold</div>
        <div className="mt-1 font-num text-base tabular-nums text-ink">
          {balance.toLocaleString('en-US', { maximumFractionDigits: balance >= 1 ? 2 : 5 })}
        </div>
      </div>
      <div>
        <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">{investedLabel}</div>
        <div className="mt-1 font-num text-base tabular-nums text-ink">{investedUsd != null ? money(investedUsd) : '—'}</div>
      </div>
      <div>
        <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">worth now</div>
        <div className="mt-1 font-num text-base tabular-nums text-ink">{nowUsd != null ? money(nowUsd) : '—'}</div>
      </div>
      <div>
        <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">pnl</div>
        <div
          className="mt-1 font-num text-base font-semibold tabular-nums"
          style={{ color: pnlPct == null ? undefined : pnlPct >= 0 ? 'var(--color-teal)' : 'var(--color-magenta)' }}
        >
          {pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : '—'}
        </div>
      </div>
    </div>
  )
}

function SeePortfolioButton({ token, onClose }: { token: { address: string; chainId: number }; onClose: () => void }) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => {
        writeRunLanded([`${token.chainId}:${token.address.toLowerCase()}`])
        onClose()
        navigate('/portfolio')
      }}
      className="press mt-3 w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black"
      style={{ background: 'linear-gradient(90deg,var(--color-teal),var(--color-cyan))' }}
    >
      See it in your portfolio →
    </button>
  )
}

/** The same destination as SeePortfolioButton, demoted to a quiet link for a
 *  host that keeps the user (the chat owns the whole flow). Same run-landed
 *  write, so the tile still glows whenever they do go. */
function SeePortfolioLink({ token, onClose }: { token: { address: string; chainId: number }; onClose: () => void }) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => {
        writeRunLanded([`${token.chainId}:${token.address.toLowerCase()}`])
        onClose()
        navigate('/portfolio')
      }}
      className="press mt-2 w-full py-2 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink"
    >
      see it in your portfolio ↗
    </button>
  )
}

export function SwapPendingOverlay({
  open,
  dir,
  symbol,
  steps,
  txOf,
  running,
  done,
  error,
  explorer,
  onClose,
  token,
  seeding,
  constituents,
  share,
  bentoItems,
  decimals,
  usdRaw,
  previewWallet,
  onRetry,
  stayHere,
}: {
  open: boolean
  dir: 'buy' | 'sell'
  symbol: string
  steps: DexStep[]
  txOf: (key: string) => DexTxState
  running: boolean
  done: { hash: string } | null
  error: string | null
  explorer: string
  onClose: () => void
  /** Re-fires the swap from the host (its own runSwap). When present, the
   *  error face's primary button IS the retry the copy promises (audit
   *  2026-08-16: "you can close and retry" rendered beside only a Close). */
  onRetry?: () => void
  /** The host owns the whole flow and must not hand the user off mid-way (the
   *  chat). Flips the post-buy primary from "see it in your portfolio" to
   *  "Done"; everywhere else the owner's 2026-08-16 ruling stands. */
  stayHere?: boolean
  /** The basket being traded — its identity is the overlay's centerpiece, and
   *  the done state offers "Add to wallet". */
  token?: { address: string; chainId: number }
  /** First buy of an unseeded basket — it was assembled at deploy; this SEEDS it. */
  seeding?: boolean
  /** The basket's constituents — buys get the portal-style swirl (owner 13:57). */
  constituents?: { address: string; symbol: string }[]
  /** Share-&-earn nudge for a completed BUY — its link carries the buyer's ?ref
   *  so buys through it pay them the interface slice (~5%). Null hides it (owner
   *  2026-07-07: suppressed when the buyer is the basket's own deployer). */
  share?: { url: string; xHref: string } | null
  /** Weighted constituents — with these, a completed buy shows the bento success
   *  card (owner 2026-07-09) instead of the text-only celebration. */
  bentoItems?: BentoItem[]
  /** Basket token decimals, for wallet_watchAsset. */
  decimals?: number
  /** The buy's USDC leg (raw 6dp) — grounds the success card in dollars. */
  usdRaw?: bigint | null
  /** DEV preview page only: show wallet actions without a connected wallet. */
  previewWallet?: boolean
}) {
  // Escape, on exactly the backdrop's terms below (`running ? undefined :
  // onClose`) — a running swap is not dismissible by either. Every sibling
  // dialog here closes on Escape (PayTokenPicker, BridgeFund, DexSwapCard's
  // basket picker) and this one, the dialog that stays up longest, had no key
  // handler at all. Registered above the `open` early return: hooks can't sit
  // behind it.
  useEffect(() => {
    if (!open || running) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, running, onClose])

  if (!open) return null
  const active = steps.find((s) => stepState(txOf(s.key)) === 'active')
  const doneCount = steps.filter((s) => stepState(txOf(s.key)) === 'done').length
  // The bento success takeover: a completed buy with weighted constituents in
  // hand becomes the "here is what you now own" card (wider dialog below).
  const buySuccess =
    !!done && dir === 'buy' && !error && !!token && !!bentoItems && bentoItems.length > 0
  const heading = done
    ? dir === 'buy'
      ? seeding
        ? `$${showSymbol(symbol)} is seeded`
        : `Congratulations — you now hold $${showSymbol(symbol)}`
      : 'Swap complete'
    : error
      ? dir === 'buy'
        ? `Couldn’t buy $${showSymbol(symbol)}`
        : 'Swap needs another try'
      : dir === 'buy'
        ? seeding
          ? `Seeding $${showSymbol(symbol)}`
          : `Assembling $${showSymbol(symbol)}`
        : `Selling $${showSymbol(symbol)}`

  return createPortal(
    // Scrollable overlay + m-auto card (mobile audit H): flex-centering a card
    // taller than the viewport overflowed it off BOTH ends with no scroll path
    // — the buy-success Done button was unreachable on most phones. Bottom
    // padding respects the home-indicator zone.
    <div
      className="fixed inset-0 z-[95] flex overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      onClick={running ? undefined : onClose}
    >
      <div className="fixed inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(e) => e.stopPropagation()}
        className={`search-pop relative m-auto w-full overflow-hidden rounded-3xl card-surface text-center backdrop-blur-md ${buySuccess ? 'max-w-xl p-9' : 'max-w-sm p-7'}`}
      >
        <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: SPECTRAL }} />

        {buySuccess ? (
          <BuySuccessCard
            symbol={symbol}
            seeding={seeding}
            token={token!}
            decimals={decimals}
            bentoItems={bentoItems!}
            usdRaw={usdRaw}
            txHash={done!.hash}
            explorer={explorer}
            share={share}
            onClose={onClose}
            previewWallet={previewWallet}
            stayHere={stayHere}
          />
        ) : (
        <>
        {dir === 'buy' && token && constituents && constituents.length > 0 && !error ? (
          <BuySwirl
            constituents={constituents}
            chainId={token.chainId}
            celebrate={!!done}
            center={<BasketAvatar address={token.address} symbol={symbol || 'x'} size={64} />}
          />
        ) : (
          <PrismAnim
            celebrate={!!done}
            logo={
              token ? (
                <BasketAvatar address={token.address} symbol={symbol || 'x'} size={64} />
              ) : undefined
            }
          />
        )}

        <h3 className="mt-5 font-display text-xl font-bold text-ink">{heading}</h3>
        <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-ink-dim">
          {done
            ? 'All steps confirmed on-chain.'
            : error
              ? 'One step didn’t go through, you can close and retry.'
              : 'This runs as a few signed steps. Keep this open, refracting the light while the chain confirms.'}
        </p>

        {/* live steps */}
        {steps.length > 0 && (
          <div className="mt-5 space-y-2 text-left">
            {steps.map((s) => {
              const st = stepState(txOf(s.key))
              const tx = txOf(s.key)
              return (
                <div key={s.key} className="flex items-center gap-2.5">
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] ${
                      st === 'done'
                        ? 'border border-teal/50 bg-teal/15 text-teal'
                        : st === 'error'
                          ? 'border border-magenta/50 bg-magenta/15 text-magenta'
                          : st === 'active'
                            ? 'relative border border-cyan/60 bg-cyan/15 text-cyan'
                            : 'border border-white/12 text-ink-faint'
                    }`}
                  >
                    {st === 'active' && <span aria-hidden className="absolute inset-0 animate-ping rounded-full border border-cyan/50 motion-reduce:animate-none" />}
                    {st === 'done' ? '✓' : st === 'error' ? '✕' : ''}
                  </span>
                  <span className={`flex-1 font-mono text-[11px] ${st === 'pending' ? 'text-ink-faint' : 'text-ink-dim'}`}>{s.label}</span>
                  {/* the signed tx itself — every step is checkable on the
                      explorer (owner 2026-07-07: "see the transaction activity,
                      so you can see if everything went through") */}
                  {tx.hash && (
                    <a
                      href={`${explorer}/tx/${tx.hash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[10px] text-cyan/80 hover:text-cyan hover:underline"
                    >
                      {tx.hash.slice(0, 6)}…{tx.hash.slice(-4)} ↗
                    </a>
                  )}
                  <span className="font-mono text-[10px] text-ink-faint">
                    {st === 'active' ? (tx.status === 'signing' ? 'sign…' : 'confirming…') : st === 'done' ? '✓' : st === 'error' ? 'failed' : ''}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* the actual reason (owner live 2026-07-28): a failed step must say WHY.
            The generic retry line hid every real revert reason (slippage, balance,
            RPC) — the message was already captured per step, just never shown. */}
        {error && !done && (
          <div className="mt-4 rounded-lg border border-magenta/40 bg-magenta/[0.08] px-3 py-2.5 text-left">
            <p className="break-words font-mono text-[11px] leading-relaxed text-magenta">
              {steps.map((s) => txOf(s.key).error).find(Boolean) ?? error}
              <RevertCauses error={steps.map((s) => txOf(s.key).error).find(Boolean) ?? error} />
            </p>
          </div>
        )}

        {!done && !error && steps.length > 0 && (
          <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.round((doneCount / steps.length) * 100)}%`, background: SPECTRAL }} />
          </div>
        )}

        {active && running && (
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan">{active.label}…</p>
        )}

        {(done || error) && (
          <div className="mt-5 flex flex-col gap-2">
            {/* you just bought it — track it (owner 2026-07-06); un-gated here
                because the balance read can lag the mint by a block */}
            {done && dir === 'buy' && token && (
              <div className="flex justify-center">
                <AddToWalletButton address={token.address} symbol={symbol} chainId={token.chainId} requireBalance={false} />
              </div>
            )}
            {done && (
              <a href={`${explorer}/tx/${done.hash}`} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-cyan hover:underline">
                view final tx ↗
              </a>
            )}
            {/* Share & earn — a fresh holder can spread the basket; their link
                carries their ?ref for the interface slice. Renders nothing when
                share is null (the basket's own deployer). */}
            {done && dir === 'buy' && (
              <ShareEarnNudge share={share} center className="mt-1 border-t border-white/[0.08] pt-3" />
            )}
            {/* a completed SELL changed the book too (audit 2026-08-16: every
                post-action door was buy-gated; a sale ended at a bare Done) */}
            {done && dir === 'sell' && (
              <RouterLink
                to="/portfolio"
                className="press w-full rounded-xl border border-white/15 py-3 text-center font-display text-sm font-bold uppercase tracking-[0.15em] text-ink-dim hover:border-cyan/50 hover:text-ink"
              >
                See it in your portfolio →
              </RouterLink>
            )}
            {error && onRetry && (
              <button
                type="button"
                onClick={() => {
                  onClose()
                  onRetry()
                }}
                className="spectral-btn press w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-void"
              >
                Try again →
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="press w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black"
              style={{ background: done ? 'linear-gradient(90deg,var(--color-teal),var(--color-cyan))' : 'rgba(255,255,255,0.1)' }}
            >
              {done ? 'Done' : 'Close'}
            </button>
          </div>
        )}
        </>
        )}
      </div>
    </div>,
    document.body,
  )
}
