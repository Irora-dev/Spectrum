import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { Address } from 'viem'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { chainCfg } from '../lib/chain/chains'
import { useCreatorBundles, publishedBundleHref, type PublishedBundle } from '../lib/spectrum/notes-social'
import { BasketAvatar } from './BasketAvatar'
import { ChainBadge } from './ChainBadge'
import { formatUsdCompact } from '../lib/spectrum/format'

// ─────────────────────────────────────────────────────────────────────────────
// The BUNDLE SHELF — a creator's published bundles, rendered the same way in the
// two places they matter (owner 2026-07-29):
//   • the creator's public page  → marketing: "here is my thesis, packaged"
//   • the owner's portfolio      → management: publish, edit, retire
// A bundle is several single-chain basket tokens held as one allocation. It is
// never "one token", so a shelf row shows the leg count and chains up front.
// Renders nothing when the chain has no notes registry or nothing is published.
// ─────────────────────────────────────────────────────────────────────────────

function BundleRow({
  bundle,
  by,
  manage,
}: {
  bundle: PublishedBundle
  by: string
  /** Owner view: show the manage affordance instead of the follow framing. */
  manage?: boolean
}) {
  const { data: all } = useAllBaskets()
  const legs = useMemo(
    () =>
      bundle.legs.map((l) => ({
        ...l,
        ix: (all ?? []).find(
          (b) => b.chainId === l.chainId && b.address.toLowerCase() === l.address.toLowerCase(),
        ),
      })),
    [bundle.legs, all],
  )
  const chains = [...new Set(bundle.legs.map((l) => l.chainId))]
  // Combined TVL of the legs, when they resolve — the honest scale signal.
  // Legs that didn't resolve (incl. a whole chain whose read failed) contribute
  // nothing, so a partial sum must not be captioned as the total (audit R4).
  const tvl = legs.reduce((s, l) => s + (l.ix?.aumUsd ?? 0), 0)
  const unresolved = legs.filter((l) => !l.ix).length
  const totalWeight = bundle.legs.reduce((s, l) => s + l.weight, 0) || 1

  return (
    <Link
      to={publishedBundleHref(bundle, by)}
      className="group block rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4 press hover:border-cyan/40"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-base font-bold text-ink">
            {bundle.name || 'Untitled bundle'}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            <span>
              {bundle.legs.length} basket{bundle.legs.length === 1 ? '' : 's'}
            </span>
            <span>
              {chains.length} chain{chains.length === 1 ? '' : 's'}
            </span>
            {tvl > 0 && (
              <span className="tabular-nums text-ink-dim">
                {formatUsdCompact(tvl)}{unresolved > 0 ? '+' : ''} combined TVL
                {unresolved > 0 ? ` · ${unresolved} leg${unresolved === 1 ? '' : 's'} unpriced` : ''}
              </span>
            )}
          </div>
        </div>

        {/* the legs, with their weights — the composition IS the pitch */}
        <div className="flex items-center gap-2">
          {legs.slice(0, 4).map((l) => (
            <span key={`${l.chainId}:${l.address}`} className="flex items-center gap-1.5">
              {l.ix ? (
                <BasketAvatar address={l.ix.address} symbol={l.ix.symbol} size={26} />
              ) : (
                <span className="grid h-[26px] w-[26px] place-items-center rounded-lg bg-white/[0.06] font-mono text-[9px] text-ink-faint">
                  ?
                </span>
              )}
              <span className="font-num text-[10px] tabular-nums text-ink-faint">
                {Math.round((l.weight / totalWeight) * 100)}%
              </span>
            </span>
          ))}
          {legs.length > 4 && (
            <span className="font-mono text-[10px] text-ink-faint">+{legs.length - 4}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {chains.slice(0, 3).map((c) => (
            <ChainBadge key={c} chainId={c} />
          ))}
        </div>

        <span
          aria-hidden
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint transition-colors group-hover:text-cyan"
        >
          {manage ? 'Open / edit →' : 'View →'}
        </span>
      </div>
    </Link>
  )
}

export function BundleShelf({
  creator,
  chainId,
  manage,
  basketCount,
  className = '',
}: {
  creator: string
  chainId: number
  /** Owner view (portfolio / own creator page): different verbs + an empty
   *  state that invites publishing. */
  manage?: boolean
  /** How many baskets this creator has launched — shapes the manage-mode
   *  invite (first-basket-first, owner 2026-07-29): with ONE basket the nudge
   *  is "launch a second", only from two does "build a bundle" make sense. */
  basketCount?: number
  className?: string
}) {
  const registry = (() => {
    try {
      return chainCfg(chainId).notesRegistry
    } catch {
      return null
    }
  })()
  const { data, isLoading } = useCreatorBundles(chainId, creator)

  if (!registry) return null
  const bundles = data ?? []
  // A visitor should never see an empty section; the owner should see the invite.
  if (!isLoading && bundles.length === 0 && !manage) return null

  return (
    <section className={`space-y-4 ${className}`}>
      <div className="flex items-end justify-between border-b border-white/10 pb-3">
        <h2 className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-ink">
          {manage ? 'Your bundles' : 'Bundles'}
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          {manage ? 'published on-chain, editable' : 'several baskets, one allocation'}
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />
          ))}
        </div>
      ) : bundles.length > 0 ? (
        <div className="space-y-2">
          {bundles.map((b) => (
            <BundleRow key={b.slug} bundle={b} by={creator as Address} manage={manage} />
          ))}
        </div>
      ) : basketCount === 1 ? (
        // One basket launched: a bundle needs at least two, so the honest
        // invite here is the SECOND launch — the bundle is the reason to.
        <div className="rounded-2xl border border-dashed border-white/10 px-5 py-6 text-center">
          <p className="text-sm text-ink-dim">
            You&rsquo;ve launched one basket. Launch a second and you can bundle them, one allocation
            people follow from a single link.
          </p>
          <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-ink-faint">
            Volume through that link lands in baskets you already earn on.
          </p>
          <Link
            to="/launch"
            className="press mt-4 inline-block rounded-lg bg-cyan px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-black hover:opacity-90"
          >
            Launch another basket
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-white/10 px-5 py-6 text-center">
          <p className="text-sm text-ink-dim">
            No bundles published yet. A bundle packages several of your baskets, across chains, as one
            allocation people can follow from a single link.
          </p>
          <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-ink-faint">
            It is not a new token: followers buy each basket on its own chain, and volume through your
            link lands in baskets you already earn on.
          </p>
          <Link
            to="/bundle"
            className="press mt-4 inline-block rounded-lg bg-cyan px-5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-black hover:opacity-90"
          >
            Build one
          </Link>
        </div>
      )}
    </section>
  )
}
