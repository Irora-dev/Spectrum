import { useMemo, useState, type ReactNode } from 'react'
import { AddToWalletButton } from '../components/AddToWalletButton'
import { PageHeader } from '../components/PageHeader'
import { PortfolioClaims } from '../components/PortfolioClaims'
import { ReferralCard } from '../components/ReferralCard'
import { ShareEarnNudge } from '../components/ShareEarnNudge'
import { BasketBento } from '../components/BasketBento'
import { BasketWash } from '../components/BasketWash'
import { Link, Navigate } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { DEPLOY_ENABLED, TRADING_ENABLED, WALLET_ENABLED } from '../lib/config/features'
import { usePortfolio, useLiveExposure, type Portfolio as PortfolioData, type PortfolioHolding } from '../lib/spectrum/hooks'
import { BasketCard } from '../components/BasketCard'
import { PortfolioExposure } from '../components/PortfolioExposure'
import { BasketAvatar } from '../components/BasketAvatar'
import { ChainBadge } from '../components/ChainBadge'
import { WalletButton } from '../components/WalletButton'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { chainCfg } from '../lib/chain/chains'
import { computeExposure, type AssetExposure, type WeightBasis } from '../lib/spectrum/exposure'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { formatGrouped, formatPct, formatUsdCompact, shortAddr } from '../lib/spectrum/format'

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

// Compact summary stat: label over value (value styled by the caller).
function StatTile({ label, value, className = '' }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-white/[0.03] p-5 ${className}`}>
      <div className="font-mono text-xs uppercase tracking-[0.15em] text-ink-dim">{label}</div>
      <div className="mt-2">{value}</div>
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

// Allocation ring of the look-through — a conic-gradient of the real per-asset
// brand colours, with the asset count in the hole. Wears the bento tiles' slow
// hue sheen + a drop shadow so it pops off the summary card (owner 16:48).
function AllocationDonut({ assets }: { assets: AssetExposure[] }) {
  let acc = 0
  const stops = assets.length
    ? assets
        .map((a) => {
          const start = acc
          acc += a.pct
          return `${tokenVisual(a.symbol, a.address).color} ${start.toFixed(3)}% ${Math.min(acc, 100).toFixed(3)}%`
        })
        .join(', ')
    : 'rgba(255,255,255,0.06) 0% 100%'
  return (
    <div className="relative grid h-60 w-60 max-w-full place-items-center">
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(${stops})`,
          opacity: 0.9,
          boxShadow: '0 26px 60px -18px rgba(123,92,255,0.55), 0 0 50px rgba(123,92,255,0.22)',
        }}
      />
      {/* the bento sheen, clipped to the ring */}
      <div aria-hidden className="absolute inset-0 overflow-hidden rounded-full">
        <div
          className="bento-sheen absolute inset-0"
          style={{
            backgroundImage: 'linear-gradient(115deg, transparent 42%, rgba(255,255,255,0.16) 50%, transparent 58%)',
            animationDuration: '11s',
          }}
        />
      </div>
      <div className="absolute inset-[16px] grid place-items-center rounded-full border border-white/10 bg-void/90 backdrop-blur-sm">
        <div className="text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Assets</div>
          <div className="font-num text-4xl font-light leading-none tabular-nums text-ink">{assets.length}</div>
        </div>
      </div>
    </div>
  )
}

function SummaryPanel({ p, assets }: { p: PortfolioData; assets: AssetExposure[] }) {
  return (
    <aside className="relative flex flex-1 flex-col overflow-hidden rounded-3xl card-surface p-8 backdrop-blur-md">
      <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-violet),var(--color-cyan))' }} />
      <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-violet opacity-15 blur-3xl" />

      <div className="relative flex items-center justify-between">
        <span className="font-mono text-sm uppercase tracking-[0.2em] text-ink-dim">Summary</span>
        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-teal" />
          </span>
          <span className="font-mono text-xs text-ink-dim">{shortAddr(p.address)}</span>
        </div>
      </div>

      <div className="relative mt-8 flex flex-col items-center">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-ink-dim">Total balance</span>
        <div className="mt-2">
          <Balance usd={p.totalValueUsd} />
        </div>
      </div>

      {/* Networks card removed (owner 16:48) — the pie moves up in its place */}
      <div className="relative mt-8 grid grid-cols-2 gap-3">
        <StatTile label="Holding" value={<span className="font-num text-3xl font-light tabular-nums text-ink">{p.heldCount}</span>} />
        <StatTile label="Created" value={<span className="font-num text-3xl font-light tabular-nums text-ink">{p.createdCount}</span>} />
      </div>

      {/* mt-auto: the pie rides the card bottom as it stretches level with
          the holdings rows */}
      <div className="relative mt-auto flex justify-center pt-6">
        <AllocationDonut assets={assets} />
      </div>
    </aside>
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
    <div className="flex items-center gap-2">
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
  const { data: p, isLoading, isError } = usePortfolio(effectiveAddress)

  // Read-only holdings view — needs a connected wallet but no trading. Gated on
  // WALLET_ENABLED so it's available in deploy-only mode; direct URLs redirect home
  // when wallets are off. The page + infra stay in the tree regardless.
  if (!WALLET_ENABLED) return <Navigate to="/" replace />

  if (!effectiveAddress) return <ConnectGate />
  if (isError) return <div className="py-10"><Notice>Couldn’t load your portfolio, the public RPC may be rate-limiting. With an Alchemy key it’s reliable.</Notice></div>
  if (isLoading || !p) return <PortfolioSkeleton />

  return <PortfolioView p={p} />
}

// Body, rendered only once the portfolio has loaded — so the view's smart default
// (start on Created when the wallet only launched and holds nothing) can read the
// counts. The summary rail persists; the toggle switches the main column between
// Owned (exposure + holdings) and Created (launched baskets).
function PortfolioView({ p }: { p: PortfolioData }) {
  const [basis, setBasis] = useState<WeightBasis>('target')
  const live = useLiveExposure(p.holdings, basis === 'live')
  const exposure = useMemo(
    () => computeExposure(p.holdings, basis === 'live' ? { basis: 'live', liveData: live.legsByKey } : {}),
    [p.holdings, basis, live.legsByKey],
  )
  const empty = p.heldCount === 0 && p.createdCount === 0
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
    <div className="py-4">
      {/* the big masthead (owner 16:48: Explore/Swap-size, eyebrow gone) with
          the claimable-fees panel docked to its right — it self-hides when
          there is nothing to claim, so the row is just the title then */}
      <PageHeader
        size="lg"
        className="mb-6"
        title="Portfolio"
        actions={<PortfolioClaims baskets={p.holdings.map((h) => h.basket)} className="max-w-xl" />}
      />
      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {!empty && <ViewToggle view={view} setView={setView} held={p.heldCount} created={p.createdCount} />}
          <SummaryPanel p={p} assets={exposure.assets} />
          <ReferralCard />
        </div>

        <div className="space-y-10">
          {empty && (
            <Notice>
              No positions yet.{' '}
              <Link to="/" className="text-cyan hover:underline">Explore baskets</Link> or{' '}
              <Link to="/launch" className="text-cyan hover:underline">launch your own</Link>.
            </Notice>
          )}

          {!empty && view === 'owned' &&
            (p.heldCount > 0 ? (
              <>
                {/* positions first, look-through analysis after (owner order) */}
                <section className="space-y-5">
                  <SectionHeader title="Holdings" right={`${p.heldCount} held`} />
                  {/* two per row (owner 12:34) — each card carries its bento,
                      so the pair fills the row and fits nicely */}
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    {p.holdings.map((h) => (
                      <HoldingCard key={`${h.basket.chainId}:${h.basket.address}`} h={h} share={shareFor(h.basket)} />
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
