import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AssetExposure, ExposureBreakdown, WeightBasis } from '../lib/spectrum/exposure'
import { AssetLogo } from './AssetLogo'
import { ChainBadge } from './ChainBadge'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { formatUsdCompact } from '../lib/spectrum/format'

// Portfolio look-through: the wallet's held baskets decomposed into net per-asset
// exposure (the one view a basket product can show that a token list can't). A
// stacked "spectrum" bar of the whole, then a bento of per-asset cards (the two
// largest get the wide tiles). Purely factual — holdings × each basket's weights;
// no ranking-as-recommendation, no projection, no advice.
//
// Two reads: target weight (the designed composition, zero-fetch) or live pool
// weight (actual drift; one fresh read per held basket). Each card expands to show
// WHICH held baskets contribute the asset (the per-basket breakdown).

const BAR_MAX = 8 // distinct segments before the rest fold into "other"

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className={`h-2.5 w-2.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ExposureCard({ a, big, multiChain }: { a: AssetExposure; big: boolean; multiChain: boolean }) {
  const vis = tokenVisual(a.symbol, a.address)
  const [open, setOpen] = useState(false)
  const drillId = `exposure-drill-${a.key.replace(/[^a-z0-9]/gi, '-')}`

  return (
    <div
      className={`group relative flex flex-col justify-between overflow-hidden rounded-3xl card-surface backdrop-blur-md transition-[transform,border-color] duration-300 hover:-translate-y-1 hover:border-white/25 ${
        big ? 'col-span-2 min-h-[150px] p-6 lg:col-span-3' : 'col-span-1 min-h-[132px] p-5 lg:col-span-2'
      }`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-20 blur-3xl transition-opacity duration-300 group-hover:opacity-40"
        style={{ background: vis.color }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 opacity-60"
        style={{ background: vis.color, height: big ? 3 : 2 }}
      />

      <div className="relative z-10 flex items-center gap-3">
        <AssetLogo
          address={a.address}
          symbol={a.symbol}
          chainId={a.chainId}
          size={big ? 40 : 28}
          discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`truncate font-display font-semibold leading-none text-ink ${big ? 'text-lg' : 'text-sm'}`}>
              {a.symbol}
            </span>
            {multiChain && <ChainBadge chainId={a.chainId} />}
          </div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={drillId}
            className="press mt-1 inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] tracking-wide text-ink-faint transition-colors hover:bg-white/10 hover:text-ink-dim"
          >
            in {a.basketCount} basket{a.basketCount === 1 ? '' : 's'}
            <Chevron open={open} />
          </button>
        </div>
      </div>

      <div className="relative z-10 mt-6 flex items-end justify-between gap-2">
        <div className={`font-num font-light leading-none tabular-nums text-ink ${big ? 'text-4xl' : 'text-3xl'}`}>
          {a.pct.toFixed(1)}
          <span className={`${big ? 'text-xl' : 'text-sm'} text-ink-faint`}>%</span>
        </div>
        <span className="font-num text-xs tabular-nums text-ink-dim">{formatUsdCompact(a.valueUsd)}</span>
      </div>

      {/* drill-down: which held baskets contribute this asset */}
      {open && (
        <div id={drillId} className="relative z-10 mt-4 space-y-1.5 border-t border-white/10 pt-3">
          {a.contributions.map((c) => {
            const share = a.valueUsd > 0 ? (c.valueUsd / a.valueUsd) * 100 : 0
            return (
              <Link
                key={`${c.chainId}:${c.basketAddress}`}
                to={`/token?addr=${c.basketAddress}&chain=${c.chainId}`}
                className="group/row flex items-center gap-2.5 rounded-lg px-1 py-0.5 transition-colors hover:bg-white/5"
              >
                <span className="w-16 shrink-0 truncate font-mono text-[11px] text-ink-dim group-hover/row:text-ink">
                  {c.basketSymbol}
                </span>
                <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: `${share}%`, background: vis.color }}
                  />
                </span>
                <span className="w-12 shrink-0 text-right font-num text-[11px] tabular-nums text-ink-dim">
                  {formatUsdCompact(c.valueUsd)}
                </span>
                <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-faint">
                  {share.toFixed(0)}%
                </span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function BasisToggle({
  basis,
  setBasis,
}: {
  basis: WeightBasis
  setBasis: (b: WeightBasis) => void
}) {
  const Opt = ({ id, label }: { id: WeightBasis; label: string }) => {
    const active = basis === id
    return (
      <button
        type="button"
        onClick={() => setBasis(id)}
        aria-pressed={active}
        className={`relative rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
          active ? 'text-void' : 'text-ink-faint hover:text-ink'
        }`}
      >
        {active && <span aria-hidden className="absolute inset-0 rounded-full bg-cyan" />}
        <span className="relative">{label}</span>
      </button>
    )
  }
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.03] p-0.5 backdrop-blur-md">
      <Opt id="target" label="Target" />
      <Opt id="live" label="Live" />
    </div>
  )
}

export function PortfolioExposure({
  exposure,
  basis,
  setBasis,
  liveLoading = false,
}: {
  exposure: ExposureBreakdown
  basis: WeightBasis
  setBasis: (b: WeightBasis) => void
  liveLoading?: boolean
}) {
  const { assets, chainCount, fellBackCount } = exposure
  if (assets.length === 0) return null

  const multiChain = chainCount > 1
  const barAssets = assets.slice(0, BAR_MAX)
  const otherPct = assets.slice(BAR_MAX).reduce((s, a) => s + a.pct, 0)
  const live = basis === 'live'
  const partial = live && !liveLoading && fellBackCount > 0

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-ink">Asset exposure</h2>
          <p className="mt-1 max-w-md text-pretty text-xs leading-relaxed text-ink-faint">
            Held baskets, decomposed into net exposure per underlying asset, by each basket&rsquo;s{' '}
            {live ? 'live pool weight (drift from target as prices move)' : 'target weight'}.
            {partial && ' Some baskets show target weight, a live read was unavailable.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <BasisToggle basis={basis} setBasis={setBasis} />
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            {liveLoading ? (
              <span className="text-cyan">updating…</span>
            ) : (
              <span>
                {assets.length} asset{assets.length === 1 ? '' : 's'}
              </span>
            )}
            <span className="h-1 w-1 rounded-full bg-white/20" />
            <span>look-through</span>
          </span>
        </div>
      </div>

      {/* stacked spectrum bar — the portfolio refracted into its constituents */}
      <div className="relative h-2.5 w-full overflow-hidden rounded-full ring-1 ring-inset ring-white/10">
        <div className="flex h-full w-full">
          {barAssets.map((a) => (
            <div
              key={a.key}
              title={`${a.symbol} · ${a.pct.toFixed(1)}%`}
              style={{ width: `${a.pct}%`, background: tokenVisual(a.symbol, a.address).color }}
              className="h-full transition-[width] duration-500 ease-out"
            />
          ))}
          {otherPct > 0.05 && (
            <div title={`Other · ${otherPct.toFixed(1)}%`} style={{ width: `${otherPct}%` }} className="h-full bg-white/20 transition-[width] duration-500 ease-out" />
          )}
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0) 45%, rgba(0,0,0,0.22))' }}
        />
      </div>

      {/* bento — the two largest assets get the wide tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        {assets.map((a, i) => (
          <ExposureCard key={a.key} a={a} big={i < 2} multiChain={multiChain} />
        ))}
      </div>
    </section>
  )
}
