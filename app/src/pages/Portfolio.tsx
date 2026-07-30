import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'

// The teaching walkthrough — a fresh wallet's empty portfolio is a natural
// "what even is this" moment (Colby 2026-07-29: every good surface). Lazy.
import { BundleShelf } from '../components/BundleShelf'
import { useActiveChainId } from '../lib/chain/active-chain'
const LearnWalkthrough = lazy(() =>
  import('../components/LearnWalkthrough').then((m) => ({ default: m.LearnWalkthrough })),
)
import { AddToWalletButton } from '../components/AddToWalletButton'
import { usePortfolioClaimables } from '../components/PortfolioClaims'
import { useReferralEarned } from '../components/ReferralCard'
import { refLinkFor } from '../lib/spectrum/referral'
import { useClaimAll } from '../lib/spectrum/use-fee-actions'
import { TRADING_ENABLED as TRADING_ON } from '../lib/config/features'
import { ShareEarnNudge } from '../components/ShareEarnNudge'
import { BasketBento } from '../components/BasketBento'
import { BasketWash } from '../components/BasketWash'
import { Link, Navigate } from 'react-router-dom'
import { useAccount, useEnsName } from 'wagmi'
import { DEPLOY_ENABLED, TRADING_ENABLED, WALLET_ENABLED } from '../lib/config/features'
import { usePortfolio, useLiveExposure, type Portfolio as PortfolioData, type PortfolioHolding } from '../lib/spectrum/hooks'
import { BasketCard } from '../components/BasketCard'
import { PortfolioExposure } from '../components/PortfolioExposure'
import { BasketAvatar } from '../components/BasketAvatar'
import { ChainBadge } from '../components/ChainBadge'
import { WalletButton } from '../components/WalletButton'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { chainCfg } from '../lib/chain/chains'
import { computeExposure, type WeightBasis } from '../lib/spectrum/exposure'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { formatGrouped, formatPct, formatUsdCompact, shortAddr } from '../lib/spectrum/format'
import portfolioHeroArt from '../assets/portfolio-hero.jpg'
import portfolioHeroArt1280 from '../assets/portfolio-hero.1280.jpg'

// Portfolio / "my positions": a summary rail (total balance, an allocation donut of
// the look-through, and stat tiles) beside the held baskets' asset-exposure bento
// and the held / created basket cards. Per-wallet balances are the only fresh read.

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-ink-faint">
      {children}
    </div>
  )
}

// h-14 = the ViewToggle row's exact height, so the two columns' bottom
// borders sit on ONE line (owner 17:08: "those lines are in line").
function SectionHeader({ title, right }: { title: string; right?: string }) {
  return (
    <div className="flex h-14 items-center justify-between border-b border-white/10">
      <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">{title}</h2>
      {right && <span className="font-mono text-xs uppercase tracking-[0.18em] text-ink-dim">{right}</span>}
    </div>
  )
}

type View = 'owned' | 'created'

// The view switch — the SAME tab idiom as Explore's Thesis/Baskets/Creators
// row (owner 16:48: "other toggle assets on the site" beat the cyan pills),
// with each side keeping its position count.
function ViewToggle({ view, setView, held, created }: { view: View; setView: (v: View) => void; held: number; created: number }) {
  const Tab = ({ id, label, count }: { id: View; label: string; count: number }) => {
    const active = view === id
    return (
      <button
        type="button"
        onClick={() => setView(id)}
        aria-pressed={active}
        className={`press flex items-center gap-2 rounded-xl px-5 py-2.5 font-display text-sm font-semibold uppercase tracking-[0.14em] transition-colors sm:px-6 ${
          active ? 'bg-white/10 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]' : 'text-ink-faint hover:text-ink-dim'
        }`}
      >
        {label}
        <span className={`font-mono text-[11px] tabular-nums ${active ? 'text-cyan' : 'text-ink-faint'}`}>{count}</span>
      </button>
    )
  }
  return (
    <div className="flex h-14 items-center gap-1 border-b border-white/10">
      <Tab id="owned" label="Owned" count={held} />
      <Tab id="created" label="Created" count={created} />
    </div>
  )
}

// Total balance, with the $ and the K/M/B suffix dropped to a muted, smaller size.
function Balance({ usd }: { usd: number }) {
  const s = formatUsdCompact(usd)
  const m = /^\$([\d.,]+)([KMB])?$/.exec(s)
  if (!m) return <span className="font-num text-6xl font-light tabular-nums text-ink">{s}</span>
  return (
    <span className="flex items-baseline font-num text-6xl font-light leading-none tabular-nums text-ink">
      <span className="mr-1 text-3xl text-ink-faint">$</span>
      {m[1]}
      {m[2] && <span className="ml-1 text-3xl text-ink-faint">{m[2]}</span>}
    </span>
  )
}


// The MASTHEAD (owner 2026-07-29, "massive beautification"): the balance is
// the hero, full width, in the site's hero language — spectral hairline, corner
// glow, mono eyebrow with the live address, stat chips drawn by spacing. The
// earn stack (claims + referral) docks as a right column on lg.
function SummaryPanel({ p, shareArmed, onToggleShare, chainsFailed = 0 }: { p: PortfolioData; shareArmed: boolean; onToggleShare: () => void; chainsFailed?: number }) {
  // The greeting name: mainnet ENS when one resolves (ENS lives on chain 1
  // regardless of the wallet's active chain), the condensed address otherwise.
  const { data: ens } = useEnsName({ address: p.address as `0x${string}`, chainId: 1 })
  const claimBaskets = (() => {
    const seen = new Set<string>()
    return [...p.holdings.map((h) => h.basket), ...p.created].filter((b) => {
      const k = `${b.chainId}:${b.address.toLowerCase()}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  })()
  return (
    <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
      {/* the prismatic-knight art (owner 2026-07-29): full bleed under the nav,
          every edge masked into the page so the site's bands ride above it —
          the home/league hero treatment. Knight centre-right, so the text
          block owns the left over the rainbow beam. */}
      <img
        src={portfolioHeroArt}
        srcSet={`${portfolioHeroArt1280} 1280w, ${portfolioHeroArt} 2400w`}
        sizes="100vw"
        alt=""
        aria-hidden
        className="league-hero-in absolute inset-0 h-full w-full object-cover object-[center_22%]"
        style={{
          WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.4) 6%, black 14%, black 87%, rgba(0,0,0,0.45) 94%, transparent 100%), linear-gradient(180deg, black 0%, black 88%, transparent 100%)',
            WebkitMaskComposite: 'source-in',
            maskImage: 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.4) 6%, black 14%, black 87%, rgba(0,0,0,0.45) 94%, transparent 100%), linear-gradient(180deg, black 0%, black 88%, transparent 100%)',
            maskComposite: 'intersect',
        }}
      />
      <div className="relative z-10 mx-auto grid min-h-[50svh] w-full max-w-6xl items-center gap-7 px-4 pb-2 pt-6 sm:px-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-10">
        {/* ── the hero: eyebrow → balance → context chips, on a SOLID card
               (owner: the vignette alone still read see-through) ── */}
        <div className="flex flex-col justify-center">
          <section className="rounded-2xl border border-white/15 bg-panel p-6 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]">
          {/* the greeting leads (owner 2026-07-30): the wallet IS the person —
              "Welcome <ens or condensed address>", the portfolio facts below */}
          <h1 className="flex flex-wrap items-baseline gap-x-2.5 font-display text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            <span>Welcome</span>
            {ens ? (
              <span className="min-w-0 break-all">{ens}</span>
            ) : (
              <span className="font-mono text-[0.8em] font-semibold">{shortAddr(p.address)}</span>
            )}
          </h1>
          <div className="mt-4 font-mono text-[11px] uppercase tracking-[0.3em] text-ink-dim">
            Portfolio · total balance
          </div>
          <div className="mt-2">
            <Balance usd={p.totalValueUsd} />
          </div>
          {/* a failed chain used to vanish from this total silently (audit R7) */}
          {chainsFailed > 0 && (
            <p className="mt-2 font-mono text-[10px] text-amber">
              {chainsFailed} network{chainsFailed === 1 ? '' : 's'} unavailable right now — this total may
              exclude holdings there.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-baseline gap-2 rounded-xl border border-white/15 bg-void/75 px-5 py-2.5 backdrop-blur-sm">
              <span className="font-num text-lg font-light tabular-nums text-ink">{p.heldCount}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">holding</span>
            </span>
            <span className="inline-flex items-baseline gap-2 rounded-xl border border-white/15 bg-void/75 px-5 py-2.5 backdrop-blur-sm">
              <span className="font-num text-lg font-light tabular-nums text-ink">{p.createdCount}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">created</span>
            </span>
            {p.createdCount > 0 && (
              <Link
                to={`/creator/${p.address}`}
                className="press inline-flex items-center gap-2 rounded-xl border border-cyan/40 bg-void/75 px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-cyan backdrop-blur-sm transition-colors hover:border-cyan/70"
              >
                Your creator page <span aria-hidden>→</span>
              </Link>
            )}
          </div>
          </section>
        </div>

        {/* ── the ONE earn card, CONDENSED (owner 2026-07-29 "a complete
               mess"): one number, one Claim all, one earned line, two compact
               actions. Per-basket rows and mechanics live on /earn. */}
        <div className="flex flex-col justify-center">
          <EarnCard p={p} baskets={claimBaskets} shareArmed={shareArmed} onToggleShare={onToggleShare} />
        </div>
      </div>
    </section>
  )
}

// The condensed Earn card (owner 2026-07-29): everything earnable in four
// quiet lines — total claimable + Claim all, referral earned to date, copy
// link, activate. The breakdown and the mechanics live on /earn.
function EarnCard({ p, baskets, shareArmed, onToggleShare }: { p: PortfolioData; baskets: BasketSummary[]; shareArmed: boolean; onToggleShare: () => void }) {
  const ca = useClaimAll()
  const { items, totalUsdc, created, claimable, degraded } = usePortfolioClaimables(baskets)
  const { total: refEarned } = useReferralEarned()
  // Claim-all sweeps only the wallet's CURRENT chain (use-fee-actions) — the
  // condensation dropped the disclosure PortfolioClaims used to carry, so an
  // all-other-chain total was a dead click with nothing on screen (audit).
  const { chainId: walletChainId } = useAccount()
  const hereUsdc = [...claimable, ...created]
    .filter((x) => x.b.chainId === walletChainId)
    .reduce((s2, x) => s2 + x.usdc, 0)
  const elsewhereUsdc = Math.max(0, totalUsdc - hereUsdc)
  const [copied, setCopied] = useState(false)
  const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const link = refLinkFor(p.address, window.location.origin, p.createdCount > 0 ? `/creator/${p.address}` : '/explore')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard unavailable */ }
  }
  return (
    <section className="rounded-2xl border border-white/15 bg-panel p-6 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-teal">Earn</span>
        <Link to="/earn" className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan hover:underline">
          How it works →
        </Link>
      </div>

      <div className="mt-4 flex items-end justify-between gap-4">
        <div>
          <div className="font-num text-4xl font-light tabular-nums text-ink">{TRADING_ON ? fmt(totalUsdc) : '—'}</div>
          <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            {/* a blipped read used to be indistinguishable from a real zero here */}
            {degraded ? 'claimable so far — a balance could not be read' : 'claimable across your baskets'}
            {elsewhereUsdc > 0.005 && (
              <span className="text-amber-200/90"> · {fmt(elsewhereUsdc)} on another network</span>
            )}
          </div>
        </div>
        {TRADING_ON && items.length > 0 && (
          <button
            type="button"
            disabled={ca.running}
            onClick={() => void ca.claimAll(items)}
            className="press shrink-0 rounded-xl border border-teal/50 bg-teal/15 px-5 py-2.5 font-display text-xs font-bold uppercase tracking-[0.12em] text-teal hover:enabled:border-teal disabled:opacity-60"
          >
            {ca.running
              ? `Claiming ${ca.done + ca.failed}/${ca.total}…`
              : elsewhereUsdc > 0.005 && hereUsdc > 0.005
                ? `Claim ${fmt(hereUsdc)}`
                : 'Claim all'}
          </button>
        )}
      </div>
      {(ca.error || ca.skippedOtherChain > 0) && !ca.running && (
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-amber-200/90">
          {ca.error ?? ''}
          {ca.skippedOtherChain > 0
            ? ` ${ca.skippedOtherChain} on another network — switch networks to claim those.`
            : ''}
        </p>
      )}
      {/* audit #4: refEarned reads the SAME pending frontend-fee bucket the
          claimable total already includes for your own baskets — subtract the
          overlap, and say "pending" (it zeroes on claim), never "to date". */}
      {(() => {
        const overlap = created.reduce((s2, c) => s2 + c.usdc, 0)
        const linkPending = Math.max(0, refEarned - overlap)
        return linkPending > 0.005 ? (
          <div className="mt-2.5 font-num text-sm tabular-nums text-teal">
            + {fmt(linkPending)} <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-dim">pending through your link</span>
          </div>
        ) : null
      })()}

      {/* ONE action per journey stage (owner): before activation the only
          move is activating; after it, the only move is copying the link. */}
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-4">
        {shareArmed ? (
          <>
            <button
              type="button"
              onClick={copy}
              className="press rounded-xl border border-violet/40 bg-violet/10 px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-bright hover:border-violet/70"
            >
              {copied ? 'Copied ✓' : 'Copy your link'}
            </button>
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-teal">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal" /> active
            </span>
          </>
        ) : (
          <button
            type="button"
            onClick={onToggleShare}
            className="press rounded-xl border border-cyan/50 bg-cyan/[0.08] px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan shadow-[0_0_14px_-4px_rgba(53,224,255,0.6)] hover:border-cyan"
          >
            Activate your referral link →
          </button>
        )}
      </div>
      <p className="mt-3.5 text-sm leading-relaxed text-ink-dim">
        Your link pays you {p.createdCount > 0 ? 'your creator fee plus ~5% of' : '~5% of'} the trade fees it brings.
      </p>
    </section>
  )
}

// Held basket as the basket itself: avatar + ticker header, the basket's BENTO
// grid (owner 12:34 — each holding card wears its composition), then the
// position's USD value + token balance and the 24h NAV delta (cyan up / magenta
// down — the load-bearing site convention). Whole card links to the basket page.
function HoldingCard({ h, share }: { h: PortfolioHolding; share?: { url: string; xHref: string } | null }) {
  const ix = h.basket
  const change = ix.change24hPct
  const up = (change ?? 0) >= 0
  const accent = up ? 'var(--color-cyan)' : 'var(--color-magenta)'
  const sig = basketSignatureColor(ix.address, ix.top[0])
  // The card shell owns the surface/hover; the Link is the clickable content
  // region and the share-&-earn row is a SIBLING below it (a share affordance
  // can't be nested inside the card's <Link> — both are interactive).
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-3xl card-surface backdrop-blur-md transition-[transform,border-color] duration-300 hover:-translate-y-1 hover:border-white/25">
      <BasketWash ix={ix} opacity={0.28} />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-12 -right-12 h-40 w-40 rounded-full opacity-[0.13] blur-3xl transition-opacity duration-300 group-hover:opacity-30"
        style={{ background: sig }}
      />

      <Link
        to={`/token?addr=${ix.address}&chain=${ix.chainId}`}
        aria-label={`View $${ix.symbol}`}
        className="relative z-10 flex flex-col gap-4 p-5 sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <BasketAvatar address={ix.address} symbol={ix.symbol} size={44} />
            <div className="min-w-0">
              <div className="truncate font-display text-lg font-semibold leading-tight text-ink">${ix.symbol}</div>
              <div className="mt-0.5 truncate text-xs text-ink-dim">{ix.name?.trim() || '—'}</div>
            </div>
          </div>
          <span className="shrink-0"><ChainBadge chainId={ix.chainId} /></span>
        </div>

        {/* the composition, right on the card */}
        <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black/25 p-2.5">
          <BasketWash ix={ix} side="full" opacity={0.3} />
          <BasketBento
            items={ix.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct, chainId: ix.chainId }))}
            aspect={2.6}
          />
        </div>

        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="font-num text-2xl font-light leading-none tabular-nums text-ink">{formatUsdCompact(h.valueUsd)}</div>
            <div className="mt-1.5 truncate font-mono text-[10px] uppercase tracking-wide text-ink-faint">
              {formatGrouped(h.balance, h.balance < 1 ? 4 : 0)} ${ix.symbol}
            </div>
          </div>
          {change != null && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 font-num text-xs font-medium tabular-nums"
              style={{ color: accent, background: `${accent}1a`, border: `1px solid ${accent}33` }}
            >
              <svg viewBox="0 0 24 24" className={`h-3 w-3 ${up ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M7 17L17 7M9 7h8v8" />
              </svg>
              {formatPct(change)}
            </span>
          )}
        </div>
      </Link>

      {/* share & earn — sibling of the Link, hidden when share is null (a basket
          the viewer created themselves) */}
      {share && (
        <div className="relative z-10 border-t border-white/[0.08] px-5 pb-4 pt-3 sm:px-6">
          <ShareEarnNudge share={share} />
        </div>
      )}
    </div>
  )
}

// Owner controls rendered INSIDE each created basket's card footer (the Created
// view is deployer-scoped by construction). New version — the immutable-basket
// evolution path — is the headline action (shown only once the contracts are
// configured, behind the deploy feature flag, like VersionButton); fee-claim is
// behind the trading feature flag; Explorer + Copy are always available. The two
// text actions flex to share the row's width so every control fits at any card
// size. The footer container is pointer-events-none (so empty space still follows
// the card's whole-surface link); each control opts back into pointer events.
function BasketAdminBar({ ix }: { ix: BasketSummary }) {
  const [copied, setCopied] = useState(false)
  const explorer = chainCfg(ix.chainId).explorer
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ix.address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  const iconBtn =
    'pointer-events-auto grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/12 text-ink-dim transition-colors hover:border-white/30 hover:text-ink'
  return (
    // flex-wrap: at 375px the two nowrap labels + three icon buttons exceed the
    // card column and bled out of their pills (mobile audit M) — the label
    // buttons drop to a second row instead
    <div className="flex flex-wrap items-center gap-2">
      <AddToWalletButton address={ix.address} symbol={ix.symbol} chainId={ix.chainId} variant="icon" />
      {DEPLOY_ENABLED && (
        <Link
          to={`/launch?from=${ix.address}&chain=${ix.chainId}`}
          className="pointer-events-auto flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-cyan/40 bg-cyan/[0.08] px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-cyan transition-colors hover:border-cyan hover:bg-cyan/15"
        >
          <span aria-hidden className="text-[13px] leading-none">↻</span> New version
        </Link>
      )}
      {TRADING_ENABLED && (
        <Link
          to={`/flush?basket=${ix.address}&chain=${ix.chainId}`}
          className="pointer-events-auto flex h-9 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-xl border border-white/12 px-3 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim transition-colors hover:border-white/30 hover:text-ink"
        >
          Fees &amp; cranks
        </Link>
      )}
      <a
        href={`${explorer}/address/${ix.address}`}
        target="_blank"
        rel="noreferrer"
        title="View on explorer"
        aria-label="View on explorer"
        className={iconBtn}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M14 5h5v5" />
          <path d="M19 5l-8 8" />
          <path d="M19 13v5a1 1 0 01-1 1H6a1 1 0 01-1-1V6a1 1 0 011-1h5" />
        </svg>
      </a>
      <button type="button" onClick={copy} title="Copy address" aria-label="Copy address" className={iconBtn}>
        {copied ? (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-cyan" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6L9 17l-5-5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 012-2h8" />
          </svg>
        )}
      </button>
    </div>
  )
}

function ConnectGate() {
  return (
    <div className="py-16">
      <div className="mx-auto max-w-md rounded-3xl card-surface p-8 text-center backdrop-blur-md">
        <div aria-hidden className="h-1 w-full -mt-8 mb-7 rounded-t-3xl" style={{ background: 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-cyan))' }} />
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">Your portfolio</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-dim">
          Connect a wallet to see the baskets you hold and the ones you’ve launched.
        </p>
        <div className="mt-6 flex justify-center">
          <WalletButton />
        </div>
      </div>
    </div>
  )
}

function PortfolioSkeleton() {
  return (
    <div className="grid gap-6 py-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="h-[560px] animate-pulse rounded-3xl border border-white/5 bg-white/[0.02]" />
      <div className="space-y-10">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={`${i < 2 ? 'col-span-2 lg:col-span-3' : 'col-span-1 lg:col-span-2'} h-[140px] animate-pulse rounded-3xl border border-white/5 bg-white/[0.02]`} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[190px] animate-pulse rounded-3xl border border-white/5 bg-white/[0.02]" />
          ))}
        </div>
      </div>
    </div>
  )
}

// DEV-only placeholder viewer so the Portfolio renders populated in `npm run dev`
// (the shipped wallet holds nothing on the mock baskets). Mirrors the basket
// fixtures' philosophy and is stripped from production builds. The mock-deployer
// address also lights up the "Created" section.
const DEV_PREVIEW_ADDRESS = '0x000000000000000000000000000000000000d0e0'

export function Portfolio() {
  const { address, isConnected } = useAccount()
  // In production this is exactly the connected address (undefined → ConnectGate);
  // only `npm run dev` substitutes the preview viewer.
  const effectiveAddress =
    isConnected && address ? address : import.meta.env.DEV ? DEV_PREVIEW_ADDRESS : undefined
  const { data: p, isLoading, isError, chainsFailed } = usePortfolio(effectiveAddress)

  // Read-only holdings view — needs a connected wallet but no trading. Gated on
  // WALLET_ENABLED so it's available in deploy-only mode; direct URLs redirect home
  // when wallets are off. The page + infra stay in the tree regardless.
  if (!WALLET_ENABLED) return <Navigate to="/" replace />

  if (!effectiveAddress) return <ConnectGate />
  if (isError) return <div className="py-10"><Notice>Couldn’t load your portfolio, the public RPC may be rate-limiting. With your own RPC (a key or your provider’s URL) it’s reliable.</Notice></div>
  if (isLoading || !p) return <PortfolioSkeleton />

  return <PortfolioView p={p} chainsFailed={chainsFailed} />
}

// Body, rendered only once the portfolio has loaded — so the view's smart default
// (start on Created when the wallet only launched and holds nothing) can read the
// counts. The summary rail persists; the toggle switches the main column between
// Owned (exposure + holdings) and Created (launched baskets).
function PortfolioView({ p, chainsFailed = 0 }: { p: PortfolioData; chainsFailed?: number }) {
  const [basis, setBasis] = useState<WeightBasis>('target')
  const live = useLiveExposure(p.holdings, basis === 'live')
  const exposure = useMemo(
    () => computeExposure(p.holdings, basis === 'live' ? { basis: 'live', liveData: live.legsByKey } : {}),
    [p.holdings, basis, live.legsByKey],
  )
  const empty = p.heldCount === 0 && p.createdCount === 0
  const activeChainId = useActiveChainId()
  const [learnOpen, setLearnOpen] = useState(false)
  const [shareArmed, setShareArmed] = useState(() => {
    try {
      return window.localStorage.getItem('spectrum:ref-links-armed') === '1'
    } catch {
      return false
    }
  })
  const toggleShare = () => {
    setShareArmed((v) => {
      try {
        window.localStorage.setItem('spectrum:ref-links-armed', v ? '0' : '1')
      } catch { /* privacy mode — session-only then */ }
      return !v
    })
  }
  const [view, setView] = useState<View>(() =>
    p.heldCount === 0 && p.createdCount > 0 ? 'created' : 'owned',
  )

  // Per-holding share-&-earn link: carries the viewer's ?ref so buys through it
  // pay them the interface slice. Null (hidden) for a basket the viewer created
  // themselves — creators have their own share/earn surfaces (same rule as the
  // swap-success nudge, owner 2026-07-07).
  const viewer = p.address
  const shareFor = (ix: BasketSummary): { url: string; xHref: string } | null => {
    if (ix.deployer && viewer.toLowerCase() === ix.deployer.toLowerCase()) return null
    const url = `${window.location.origin}/token?addr=${ix.address}&chain=${ix.chainId}&ref=${viewer}`
    const text = `$${ix.symbol}, ${ix.name}: ${ix.basketLength} assets in one onchain basket token.`
    const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
    return { url, xHref }
  }

  return (
    <div className="pb-4">
      {/* the big masthead (owner 16:48: Explore/Swap-size, eyebrow gone) with
          the claimable-fees panel docked to its right — it self-hides when
          there is nothing to claim, so the row is just the title then */}
      <div className="space-y-2">
        <SummaryPanel p={p} shareArmed={shareArmed} onToggleShare={toggleShare} chainsFailed={chainsFailed} />
        {!empty && <ViewToggle view={view} setView={setView} held={p.heldCount} created={p.createdCount} />}

        <div className="space-y-10">
          {empty && (
            <Notice>
              No positions yet.{' '}
              <Link to="/" className="text-cyan hover:underline">Explore baskets</Link>,{' '}
              <Link to="/launch" className="text-cyan hover:underline">launch your own</Link>, or{' '}
              <button type="button" onClick={() => setLearnOpen(true)} className="text-cyan hover:underline">
                learn how Spectrum works
              </button>.
            </Notice>
          )}

          {learnOpen && (
            <Suspense fallback={null}>
              <LearnWalkthrough onClose={() => setLearnOpen(false)} />
            </Suspense>
          )}

          {!empty && view === 'owned' &&
            (p.heldCount > 0 ? (
              <>
                {/* positions first, look-through analysis after (owner order) */}
                <section className="space-y-5">
                  <SectionHeader title="Holdings" right={`${p.heldCount} held`} />
                  {/* two per row (owner 12:34) — each card carries its bento,
                      so the pair fills the row and fits nicely */}
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                    {p.holdings.map((h) => (
                      <HoldingCard key={`${h.basket.chainId}:${h.basket.address}`} h={h} share={shareArmed ? shareFor(h.basket) : null} />
                    ))}
                  </div>
                </section>
              </>
            ) : (
              <Notice>
                You don’t hold any baskets yet.{' '}
                <Link to="/" className="text-cyan hover:underline">Explore baskets</Link>.
              </Notice>
            ))}

          {!empty && view === 'created' &&
            (p.createdCount > 0 ? (
              <section className="space-y-5">
                <SectionHeader title="Created" right={`${p.createdCount} launched`} />
                {/* 2-up (not 3) — created cards carry the admin footer, so they get
                    the width for all its controls to breathe */}
                <div className="grid gap-5 sm:grid-cols-2">
                  {p.created.map((ix) => (
                    <BasketCard key={`${ix.chainId}:${ix.address}`} ix={ix} footer={<BasketAdminBar ix={ix} />} />
                  ))}
                </div>
              </section>
            ) : (
              <Notice>
                You haven’t launched any baskets yet.{' '}
                <Link to="/launch" className="text-cyan hover:underline">Launch one</Link>.
              </Notice>
            ))}

          {/* MANAGE your bundles — the creator-admin surface (owner 2026-07-29).
              Lives under Created because a bundle packages what you launched:
              publish, open to edit, retire. Only the wallet's own view — and
              only once a first basket EXISTS (first-basket-first, owner: a
              zero-basket creator sees one message, launch, not a bundles ad). */}
          {view === 'created' && p.createdCount > 0 && (
            <BundleShelf creator={p.address} chainId={activeChainId} manage basketCount={p.createdCount} />
          )}
        </div>
      </div>

      {/* the look-through, FULL page width (owner 17:08) — it opens wide */}
      {!empty && view === 'owned' && p.heldCount > 0 && (
        <details className="group mt-6 overflow-hidden rounded-2xl border border-cyan/20 bg-cyan/[0.03] transition-colors hover:border-cyan/40">
          <summary className="press flex cursor-pointer list-none items-center justify-between gap-3 px-6 py-5">
            <span className="flex items-center gap-3">
              <span aria-hidden className="h-2 w-2 rounded-full bg-cyan shadow-[0_0_10px_var(--color-cyan)]" />
              <span className="font-display text-base font-bold uppercase tracking-tight text-ink">Asset exposure</span>
              <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">the look-through of everything you hold</span>
            </span>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-cyan transition-transform duration-200 group-open:rotate-180"><path d="M6 9l6 6 6-6" /></svg>
          </summary>
          <div className="px-5 pb-5">
            <PortfolioExposure exposure={exposure} basis={basis} setBasis={setBasis} liveLoading={live.isLoading} />
          </div>
        </details>
      )}
    </div>
  )
}
