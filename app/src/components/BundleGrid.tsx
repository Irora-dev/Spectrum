import { useMemo } from 'react'
import { Link } from 'react-router'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { useAllBundles, publishedBundleHref, type DiscoveredBundle } from '../lib/spectrum/notes-social'
import { BundleBento } from './BundleBento'
import { ChainBadge } from './ChainBadge'
import { CreatorChip } from './CreatorChip'
import { formatUsdCompact } from '../lib/spectrum/format'
import type { BasketSummary } from '../lib/spectrum/basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// Bundle DISCOVERY (owner 2026-07-29): published bundles as browsable cards, on
// Explore and the home preview.
//
// Publishing is permissionless, so this list is open by construction. The
// quality gate is here, not on-chain: a bundle only surfaces when at least two
// of its legs RESOLVE to real baskets on this build, and ranking is by the
// combined TVL of those legs. A bundle of invented addresses shows up nowhere.
// ─────────────────────────────────────────────────────────────────────────────

export interface RankedBundle {
  bundle: DiscoveredBundle
  legs: { chainId: number; address: string; weight: number; ix?: BasketSummary }[]
  resolvedCount: number
  tvlUsd: number
  chains: number[]
}

/** Published bundles whose legs are real, best-first. */
export function useRankedBundles(chainId: number, limit?: number): { ranked: RankedBundle[]; isLoading: boolean } {
  const { data: bundles, isLoading } = useAllBundles(chainId)
  const { data: all } = useAllBaskets()
  const ranked = useMemo(() => {
    const heads = all ?? []
    const out: RankedBundle[] = []
    for (const b of bundles ?? []) {
      const legs = b.legs.map((l) => ({
        ...l,
        ix: heads.find((x) => x.chainId === l.chainId && x.address.toLowerCase() === l.address.toLowerCase()),
      }))
      const resolvedCount = legs.filter((l) => l.ix).length
      if (resolvedCount < 2) continue // the gate: a bundle must be made of real baskets
      out.push({
        bundle: b,
        legs,
        resolvedCount,
        tvlUsd: legs.reduce((s, l) => s + (l.ix?.aumUsd ?? 0), 0),
        chains: [...new Set(b.legs.map((l) => l.chainId))],
      })
    }
    out.sort((a, b) => b.tvlUsd - a.tvlUsd)
    return limit ? out.slice(0, limit) : out
  }, [bundles, all, limit])
  return { ranked, isLoading }
}

export function BundleCard({ r }: { r: RankedBundle }) {
  const { bundle, legs, chains, tvlUsd } = r
  // A leg that didn't resolve contributes $0 — mark the sum partial rather
  // than captioning it as the total (same pattern as BundleShelf, audit R4)
  const unresolved = legs.length - r.resolvedCount
  return (
    <Link
      to={publishedBundleHref(bundle, bundle.by)}
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/[0.12] bg-white/[0.02] p-5 press hover:border-cyan/40"
    >
      <div aria-hidden className="ambient-bloom pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-cyan/[0.07] blur-3xl transition-opacity group-hover:opacity-150" />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-ink-faint">Bundle</div>
          <h3 className="mt-1 truncate font-display text-lg font-bold leading-tight text-ink">
            {bundle.name || 'Untitled bundle'}
          </h3>
        </div>
        <div className="flex shrink-0 gap-1">
          {chains.slice(0, 3).map((c) => (
            <ChainBadge key={c} chainId={c} />
          ))}
        </div>
      </div>

      {/* the composition IS the pitch — the bundle's own bento-of-bentos, the
          same visual language as its page (owner 2026-07-29: bentos in a grid,
          not a list). Legs don't link: the whole card is already a link. */}
      <div className="relative mt-4">
        <BundleBento legs={legs} aspect={1.9} compact linkLegs={false} />
      </div>

      <div className="relative mt-auto flex items-end justify-between gap-3 pt-4">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
            combined TVL{unresolved > 0 ? ` · ${unresolved} unpriced` : ''}
          </div>
          <div className="font-num text-xl tabular-nums text-ink">
            {tvlUsd > 0 ? `${formatUsdCompact(tvlUsd)}${unresolved > 0 ? '+' : ''}` : '—'}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
            {bundle.legs.length} baskets · {chains.length} chain{chains.length === 1 ? '' : 's'}
          </div>
          <div className="mt-1">
            <CreatorChip deployer={bundle.by} basket={legs[0]?.address ?? ''} chainId={chains[0] ?? 8453} />
          </div>
        </div>
      </div>
    </Link>
  )
}

export function BundleGrid({
  chainId,
  limit,
  emptyHint = true,
}: {
  chainId: number
  limit?: number
  emptyHint?: boolean
}) {
  const { ranked, isLoading } = useRankedBundles(chainId, limit)

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-44 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />
        ))}
      </div>
    )
  }
  if (ranked.length === 0) {
    if (!emptyHint) return null
    return (
      <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center">
        <p className="text-sm text-ink-dim">No bundles published yet on this network.</p>
        <p className="mx-auto mt-1.5 max-w-lg font-mono text-[10px] leading-relaxed text-ink-faint">
          A bundle packages several baskets, across chains, as one allocation people follow from a
          single link. It is not a new token — each basket is held in the buyer's own wallet.
        </p>
        <Link
          to="/bundle"
          className="press mt-4 inline-block rounded-lg border border-cyan/40 bg-cyan/[0.08] px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-cyan hover:border-cyan"
        >
          Build the first
        </Link>
      </div>
    )
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {ranked.map((r) => (
        <BundleCard key={`${r.bundle.by}:${r.bundle.slug}`} r={r} />
      ))}
    </div>
  )
}
