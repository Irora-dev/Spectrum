import { useMemo, useState, type CSSProperties } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { PageHeader } from '../components/PageHeader'
import { BasketBento } from '../components/BasketBento'
import { BasketWash } from '../components/BasketWash'
import { BasketAvatar } from '../components/BasketAvatar'
import { ChainBadge } from '../components/ChainBadge'
import { useAllBaskets } from '../lib/spectrum/hooks'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { squarify } from '../lib/treemap'
import { shortAddr } from '../lib/spectrum/format'
import {
  MAX_BUNDLE_LEGS,
  bundleChains,
  decodeBundle,
  encodeBundleParams,
  normalizedLegs,
  splitBudget,
  type Bundle as BundleT,
  type BundleLeg,
} from '../lib/spectrum/bundle'

// ─────────────────────────────────────────────────────────────────────────────
// /bundle — cross-chain BUNDLES (owner 2026-07-08). A bundle is a weighted set of
// single-chain baskets shown as one cross-chain allocation. A frontend construct:
// NOT a contract, NOT one token. A follower replicates it by buying each leg on
// its own chain — stated explicitly. A creator/KOL builds one from their baskets
// and shares the link; buys through it carry their ?ref.
//
// No `?b=` → the BUILDER (pick baskets across chains, weight them, share the link).
// `?b=…`   → the VIEW (the bento, the split, per-leg buy, the disclosure).
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

interface Resolved {
  leg: BundleLeg
  pct: number
  ix: BasketSummary | null
}

function useResolved(legs: BundleLeg[]): Resolved[] {
  const { data: all } = useAllBaskets()
  return useMemo(() => {
    const norm = normalizedLegs(legs)
    return norm.map((l) => ({
      leg: l,
      pct: l.pct,
      ix: (all ?? []).find((b) => b.chainId === l.chainId && b.address.toLowerCase() === l.address.toLowerCase()) ?? null,
    }))
  }, [legs, all])
}

// ── the centerpiece: a weighted BENTO OF BASKETS (squarified by weight) ────────
function BundleBento({ resolved, aspect = 2.2 }: { resolved: Resolved[]; aspect?: number }) {
  const VW = 300
  const VH = VW / aspect
  const rects = useMemo(
    () => squarify(resolved.filter((r) => r.pct > 0).map((r) => ({ ticker: `${r.leg.chainId}:${r.leg.address}`, weight: Math.pow(r.pct, 0.7) })), VW, VH),
    [resolved, VH],
  )
  const byKey = useMemo(() => new Map(resolved.map((r) => [`${r.leg.chainId}:${r.leg.address}`.toLowerCase(), r])), [resolved])
  if (rects.length === 0) return <div className="w-full rounded-2xl bg-white/[0.02]" style={{ aspectRatio: String(aspect) }} />
  return (
    <div className="relative w-full overflow-hidden rounded-2xl" style={{ aspectRatio: String(aspect) }}>
      {rects.map((r) => {
        const res = byKey.get(r.ticker.toLowerCase())
        if (!res) return null
        const { ix, leg, pct } = res
        const sig = ix ? basketSignatureColor(ix.address, ix.top[0]) : 'var(--color-violet)'
        const wFrac = r.w / VW
        const hFrac = r.h / VH
        const big = wFrac > 0.34 && hFrac > 0.4
        const symbol = ix?.symbol ?? '—'
        return (
          <div
            key={r.ticker}
            className="absolute p-1"
            style={{ left: `${(r.x / VW) * 100}%`, top: `${(r.y / VH) * 100}%`, width: `${wFrac * 100}%`, height: `${hFrac * 100}%` }}
          >
            <Link
              to={ix ? `/token?addr=${ix.address}&chain=${ix.chainId}` : '#'}
              className="group relative flex h-full w-full flex-col justify-between overflow-hidden rounded-xl border border-white/10 p-3 transition-[transform,border-color] duration-300 hover:-translate-y-0.5 hover:border-white/30"
              style={{ background: `linear-gradient(150deg, ${sig}2e, rgba(255,255,255,0.02) 62%)` }}
            >
              {ix && <BasketWash ix={ix} opacity={0.26} />}
              <span aria-hidden className="pointer-events-none absolute -bottom-10 -right-10 h-32 w-32 rounded-full opacity-20 blur-3xl transition-opacity duration-300 group-hover:opacity-35" style={{ background: sig }} />
              <div className="relative z-10 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {ix && <BasketAvatar address={ix.address} symbol={ix.symbol} size={big ? 30 : 22} />}
                  <span className="truncate font-display text-sm font-bold uppercase leading-none text-ink sm:text-base">${symbol}</span>
                </div>
                <ChainBadge chainId={leg.chainId} />
              </div>
              {big && ix && (
                <div className="relative z-10 my-1 overflow-hidden rounded-lg border border-white/10 bg-black/25 p-1.5">
                  <BasketBento items={ix.top.map((t) => ({ symbol: t.symbol, address: t.address, weightPct: t.weightPct, chainId: ix.chainId }))} aspect={3} compact />
                </div>
              )}
              <div className="relative z-10 flex items-baseline justify-between gap-2">
                <span className="font-num text-2xl font-light leading-none tabular-nums text-ink sm:text-3xl">{Math.round(pct)}%</span>
                <span className="truncate font-mono text-[9px] uppercase tracking-wide text-ink-faint">{chainCfg(leg.chainId).name}</span>
              </div>
            </Link>
          </div>
        )
      })}
    </div>
  )
}

// The explicit cross-chain disclosure — the honesty rail for this whole feature.
function CrossChainNote({ chains }: { chains: number[] }) {
  return (
    <p className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-amber-200/90">
      A bundle is <span className="text-ink">not one token</span> — it's {chains.length} baskets across{' '}
      {chains.map((c, i) => (
        <span key={c}>
          {i > 0 ? ' + ' : ''}
          <span className="text-ink">{chainCfg(c).name}</span>
        </span>
      ))}
      . You buy each leg separately on its own chain (you'll need funds + gas on each). It tracks the target
      weights; it doesn't auto-rebalance.
    </p>
  )
}

// ── VIEW: an existing bundle ───────────────────────────────────────────────────
function BundleView({ bundle, dropped }: { bundle: BundleT; dropped: number }) {
  const resolved = useResolved(bundle.legs)
  const chains = bundleChains(bundle.legs)
  const [budget, setBudget] = useState('1000')
  const budgetNum = Number(budget) || 0
  const splits = splitBudget(bundle.legs, budgetNum)
  const refq = bundle.by ? `&ref=${bundle.by}` : ''
  const [copied, setCopied] = useState(false)
  const shareUrl = typeof window !== 'undefined' ? window.location.href : ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }
  const xText = `${bundle.name || 'A cross-chain bundle'} on Spectrum — ${bundle.legs.length} baskets across ${chains.length} chains, one weighted allocation.`
  const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(xText)}&url=${encodeURIComponent(shareUrl)}`

  return (
    <div className="py-4">
      <PageHeader size="lg" className="mb-2" title={bundle.name || 'Cross-chain bundle'} />
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-dim">
        <span>{bundle.legs.length} baskets · {chains.length} chains</span>
        {bundle.by && (
          <span>
            by{' '}
            <Link to={`/creator/${bundle.by}`} className="text-cyan hover:underline">{shortAddr(bundle.by)}</Link>
          </span>
        )}
      </div>

      {dropped > 0 && (
        <p className="mb-5 font-mono text-[10px] text-amber-200/80">
          {dropped} leg{dropped > 1 ? 's' : ''} on a network this site hasn’t enabled {dropped > 1 ? 'are' : 'is'} hidden.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <BundleBento resolved={resolved} />
          <CrossChainNote chains={chains} />
        </div>

        {/* allocate a budget → the per-leg split + guided buys */}
        <aside className="flex flex-col gap-4 rounded-3xl card-surface p-5 backdrop-blur-md sm:p-6">
          <div aria-hidden className="h-1 w-full -mt-5 mb-1 rounded-t-3xl sm:-mt-6" style={{ background: SPECTRAL }} />
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-dim">Get this allocation</div>
            <label className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5">
              <span className="font-num text-xl text-ink-faint">$</span>
              <input
                value={budget}
                onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                aria-label="Budget in USD"
                className="min-w-0 flex-1 bg-transparent font-num text-2xl font-light tabular-nums text-ink outline-none"
              />
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">to allocate</span>
            </label>
          </div>

          <div className="flex flex-col divide-y divide-white/8 border-y border-white/10">
            {resolved.map((r, i) => (
              <div key={`${r.leg.chainId}:${r.leg.address}`} className="flex items-center gap-3 py-2.5">
                {r.ix && <BasketAvatar address={r.ix.address} symbol={r.ix.symbol} size={30} />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-display text-sm font-bold text-ink">${r.ix?.symbol ?? shortAddr(r.leg.address)}</span>
                    <ChainBadge chainId={r.leg.chainId} />
                  </div>
                  <div className="font-mono text-[10px] tabular-nums text-ink-faint">{Math.round(r.pct)}% · {chainCfg(r.leg.chainId).name}</div>
                </div>
                <div className="text-right">
                  <div className="font-num text-sm tabular-nums text-ink">{budgetNum > 0 ? `$${splits[i].toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}</div>
                  <Link
                    to={`/swap?basket=${r.leg.address}&chain=${r.leg.chainId}${refq}`}
                    className="press mt-0.5 inline-block rounded-md border border-cyan/40 bg-cyan/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-cyan hover:border-cyan"
                  >
                    Buy on {chainCfg(r.leg.chainId).key ?? chainCfg(r.leg.chainId).name}
                  </Link>
                </div>
              </div>
            ))}
          </div>
          <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
            Buy each leg on its chain, in any order. Amounts are your budget split by the target weights.
          </p>

          <div className="mt-1 flex flex-wrap gap-2">
            <a href={xHref} target="_blank" rel="noreferrer" className="press inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3.5 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan">
              Share on X
            </a>
            <button type="button" onClick={() => void copy()} className="press rounded-lg border border-white/15 px-3.5 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan">
              {copied ? 'Link copied' : 'Copy link'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}

// ── BUILDER: assemble + weight a bundle, get a shareable link ───────────────────
function BundleBuilder() {
  const { data: all } = useAllBaskets()
  const { address } = useAccount()
  const [, setSearchParams] = useSearchParams()
  const [legs, setLegs] = useState<BundleLeg[]>([])
  const [name, setName] = useState('')
  const [q, setQ] = useState('')

  const heads = useMemo(() => (all ?? []).filter((b) => !b.supersededBy), [all])
  const chosen = useMemo(() => new Set(legs.map((l) => `${l.chainId}:${l.address.toLowerCase()}`)), [legs])
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return heads
      .filter((b) => !chosen.has(`${b.chainId}:${b.address.toLowerCase()}`))
      .filter((b) => !needle || b.symbol.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle))
      .slice(0, 24)
  }, [heads, chosen, q])

  const resolved = useResolved(legs)
  const add = (b: BasketSummary) => {
    if (legs.length >= MAX_BUNDLE_LEGS) return
    setLegs((prev) => [...prev, { chainId: b.chainId, address: b.address, weight: 100 }])
  }
  const setWeight = (i: number, w: number) => setLegs((prev) => prev.map((l, k) => (k === i ? { ...l, weight: Math.max(1, w) } : l)))
  const remove = (i: number) => setLegs((prev) => prev.filter((_, k) => k !== i))

  const link = useMemo(() => {
    const params = encodeBundleParams({ legs, by: address ?? null, name: name.trim() || null } as BundleT)
    return `${typeof window !== 'undefined' ? window.location.origin : ''}/bundle?${params.toString()}`
  }, [legs, address, name])
  const [copied, setCopied] = useState(false)
  const share = legs.length >= 2
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="pb-12">
      {/* ── HERO (full-bleed marketing) ── */}
      <section className="relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet/15 blur-[130px]" />
          <div className="absolute left-[18%] top-[26%] h-72 w-72 rounded-full bg-cyan/12 blur-[120px]" />
          <div className="absolute right-[16%] top-[44%] h-72 w-72 rounded-full bg-magenta/12 blur-[130px]" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(125% 85% at 50% 42%, rgba(5,5,11,0.6) 0%, rgba(5,5,11,0.2) 46%, transparent 78%)' }} />
        <div className="relative z-10 mx-auto flex min-h-[52svh] max-w-4xl flex-col items-center justify-center px-4 pt-6 text-center">
          <div className="enter inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-ink-dim backdrop-blur" style={{ '--enter-i': 0 } as CSSProperties}>
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan" />
            Bundles · cross-chain · permissionless
          </div>
          <h1 className="enter mt-7 font-display text-6xl font-bold uppercase leading-[0.9] tracking-tight text-ink sm:text-7xl md:text-8xl" style={{ '--enter-i': 1 } as CSSProperties}>
            Curate a bundle,<br />earn the <span className="spectral-text">fees</span>.
          </h1>
          <p className="enter mx-auto mt-7 max-w-xl text-base leading-snug text-ink-dim sm:text-lg" style={{ '--enter-i': 2 } as CSSProperties}>
            Weight any baskets, yours or anyone’s, into one cross-chain allocation. Share the link and earn a
            slice of the fee on every buy through it, at no extra cost to them. You never have to launch your own.
          </p>
          <a href="#build" className="enter press mt-9 inline-flex items-center gap-2 rounded-xl px-6 py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black" style={{ background: SPECTRAL, '--enter-i': 3 } as CSSProperties}>
            Build yours
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14m0 0l-6-6m6 6l6-6" /></svg>
          </a>
        </div>
      </section>

      <div className="mx-auto max-w-5xl space-y-16 px-1">
        {/* ── WHY CURATE ── */}
        <section className="grid gap-4 sm:grid-cols-3">
          {[
            { t: 'Curate, don’t create', c: 'var(--color-cyan)', d: 'You don’t have to launch a basket to earn. Bundle the ones you rate and get paid for the volume you bring.' },
            { t: 'One link, every leg', c: 'var(--color-violet-bright)', d: 'Your link tags every buy across every basket in it. It’s the protocol fee slice redirected to you, so buyers pay nothing extra and each basket’s creator keeps theirs.' },
            { t: 'Cross-chain, one set', c: 'var(--color-magenta)', d: 'Mix Ethereum and Base baskets into one weighted allocation your followers get in a few clicks.' },
          ].map((card) => (
            <div key={card.t} className="relative overflow-hidden rounded-3xl border border-white/[0.12] bg-white/[0.02] p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
              <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${card.c}, transparent)` }} />
              <div className="font-display text-base font-bold uppercase tracking-tight text-ink">{card.t}</div>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">{card.d}</p>
            </div>
          ))}
        </section>

        {/* ── THE BUILDER (functional generator) ── */}
        <section id="build" className="scroll-mt-6">
          <h2 className="text-center font-display text-4xl font-bold uppercase leading-tight tracking-tight text-ink sm:text-5xl">Build your bundle</h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-sm leading-relaxed text-ink-dim">Pick baskets across chains, set the weights, get your link. Up to {MAX_BUNDLE_LEGS} baskets.</p>
          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* pick + weight */}
        <div className="flex flex-col gap-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your bundle (optional)"
            maxLength={48}
            className="w-full rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 font-display text-lg text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
          />

          {legs.length > 0 && (
            <div className="flex flex-col gap-2 rounded-2xl card-surface p-3 backdrop-blur-md">
              {resolved.map((r, i) => (
                <div key={`${r.leg.chainId}:${r.leg.address}`} className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-black/20 px-2.5 py-2">
                  {r.ix && <BasketAvatar address={r.ix.address} symbol={r.ix.symbol} size={26} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-display text-sm font-bold text-ink">${r.ix?.symbol ?? shortAddr(r.leg.address)}</span>
                      <ChainBadge chainId={r.leg.chainId} />
                    </div>
                    <div className="font-mono text-[9px] tabular-nums text-ink-faint">{Math.round(r.pct)}% of bundle</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setWeight(i, r.leg.weight - 10)} className="press grid h-6 w-6 place-items-center rounded-md border border-white/10 text-ink-dim hover:border-white/30 hover:text-ink">−</button>
                    <span className="w-8 text-center font-num text-sm tabular-nums text-ink">{r.leg.weight}</span>
                    <button type="button" onClick={() => setWeight(i, r.leg.weight + 10)} className="press grid h-6 w-6 place-items-center rounded-md border border-white/10 text-ink-dim hover:border-white/30 hover:text-ink">+</button>
                  </div>
                  <button type="button" onClick={() => remove(i)} aria-label="Remove" className="press grid h-6 w-6 place-items-center rounded-md text-ink-faint hover:bg-white/10 hover:text-ink">✕</button>
                </div>
              ))}
            </div>
          )}

          {legs.length < MAX_BUNDLE_LEGS && (
            <div className="rounded-2xl card-surface p-3 backdrop-blur-md">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Add a basket — search ticker or name (any chain)"
                className="w-full rounded-xl border border-white/10 bg-void/40 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
              />
              <div className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
                {matches.length === 0 && <p className="px-2 py-4 text-center font-mono text-[11px] text-ink-faint">No baskets match.</p>}
                {matches.map((b) => (
                  <button key={`${b.chainId}:${b.address}`} type="button" onClick={() => add(b)} className="press flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.05]">
                    <BasketAvatar address={b.address} symbol={b.symbol} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-sm font-semibold text-ink">${b.symbol}</span>
                      <span className="block truncate font-mono text-[10px] text-ink-faint">{b.name}</span>
                    </span>
                    <ChainBadge chainId={b.chainId} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* live preview + link */}
        <div className="flex flex-col gap-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-dim">Live preview</div>
          {legs.length > 0 ? <BundleBento resolved={resolved} /> : (
            <div className="grid aspect-[2.2/1] w-full place-items-center rounded-2xl border border-dashed border-white/12 text-center font-mono text-xs text-ink-faint">
              Add baskets to see your bundle
            </div>
          )}
          <div className="rounded-2xl border border-cyan/20 bg-cyan/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan">Your bundle link</div>
            {share ? (
              <>
                <code className="mt-2 block truncate rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-ink-dim" title={link}>{link}</code>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void copy()} className="press rounded-lg border border-cyan/40 bg-cyan/10 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-cyan hover:border-cyan">{copied ? 'Copied' : 'Copy link'}</button>
                  <button type="button" onClick={() => setSearchParams(encodeBundleParams({ legs, by: address ?? null, name: name.trim() || null } as BundleT))} className="press rounded-lg border border-white/15 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim hover:border-cyan/50 hover:text-cyan">Preview it</button>
                </div>
                {!address && <p className="mt-2 font-mono text-[9px] text-ink-faint">Connect a wallet so buys through your link are tagged to you.</p>}
              </>
            ) : (
              <p className="mt-2 font-mono text-[11px] text-ink-faint">Add at least 2 baskets to get a shareable link.</p>
            )}
          </div>
        </div>
          </div>
        </section>

        {/* ── HOW IT WORKS ── */}
        <section>
          <h2 className="text-center font-display text-4xl font-bold uppercase leading-tight tracking-tight text-ink sm:text-5xl">Three steps</h2>
          <div className="mt-9 grid gap-4 sm:grid-cols-3">
            {[
              { n: '01', t: 'Pick + weight', d: 'Choose baskets on any chain and set how much of each.' },
              { n: '02', t: 'Share your link', d: 'It unfurls as a card and carries your wallet as the referrer.' },
              { n: '03', t: 'Earn on every trade', d: 'Every buy through it pays you the interface fee slice, onchain in USDC.' },
            ].map((s) => (
              <div key={s.n} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <div className="font-num text-2xl font-light text-cyan">{s.n}</div>
                <div className="mt-2 font-display text-base font-bold uppercase tracking-tight text-ink">{s.t}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">{s.d}</p>
              </div>
            ))}
          </div>
        </section>

        <p className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-3 text-center font-mono text-[11px] leading-relaxed text-amber-200/90">
          A bundle is a shared allocation, not one token. Followers buy each basket on its own chain, and the fee
          you earn is a redirected protocol slice, never an extra charge. It tracks the weights, it doesn’t auto-rebalance.
        </p>
      </div>
    </div>
  )
}

export function Bundle() {
  const [params] = useSearchParams()
  // Filter to chains THIS build supports — `chainCfg` throws on an unknown chain,
  // and a shared bundle link could name one this deployment hasn't enabled.
  const { bundle, dropped } = useMemo(() => {
    const b = decodeBundle(params.toString())
    const supported = new Set(SUPPORTED_CHAIN_IDS as readonly number[])
    const legs = b.legs.filter((l) => supported.has(l.chainId))
    return { bundle: { ...b, legs }, dropped: b.legs.length - legs.length }
  }, [params])
  return bundle.legs.length > 0 ? <BundleView bundle={bundle} dropped={dropped} /> : <BundleBuilder />
}
