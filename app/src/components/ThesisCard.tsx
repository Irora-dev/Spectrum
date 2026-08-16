import { useMemo } from 'react'
import { Link } from 'react-router'
import { showName, showSymbol } from '../lib/spectrum/safe-copy'
import { thesisBentoItems, thesisCombinedSeries, thesisOneOfEach, type Thesis } from '../lib/spectrum/thesis'
import { thesisHref } from '../lib/spectrum/thesis-url'
import { ChainBadge, chainMeta } from './ChainBadge'
import { formatNav, formatPct, formatUsdCompact } from '../lib/spectrum/format'
import { BasketSpark } from './BasketSpark'
import { BasketBento } from './BasketBento'

// ─────────────────────────────────────────────────────────────────────────────
// THE THESIS DOOR CARD — one cross-chain idea, as the door to its own page.
//
// ONE implementation for every surface (Creator strip, Explore's Theses tab,
// the homepage rail) so they cannot drift. Two faces:
//   'sm' — the Creator strip's original compact face: eyebrow · name · split
//          bar · badges + TVL. Kept exactly as it shipped; a strip card has
//          no room for a chart.
//   'md' — THE FULL FACE (the owner 2026-08-10: "the way we display a theses
//          needs to be way way prettier … a global chart that counts the
//          total value across the three underlying baskets and also the
//          combined price … the bento grid layout of a normal basket but its
//          all assets from the 3 baskets"). A BasketCard-grade card: the
//          combined-value dither chart, the composite bento of EVERY leg's
//          assets, and the money row — one-of-each price · 24h · TVL.
//
// THE COMBINED FIGURES ARE THE HELPERS', NEVER LOCAL MATH: the chart series
// is thesisCombinedSeries (each leg's curve scaled to its own dollars,
// refused whole when any leg can't be read), the price is thesisOneOfEach
// (one token of each leg — the only per-unit figure honest across unrelated
// supplies; the label says so), the bento is thesisBentoItems (the thesis
// page's exact composite, chain marks on duplicated tickers included).
//
// NAMED ThesisDoorCard, not ThesisCard: pages/Explore.tsx already exports a
// `ThesisCard` — ONE BASKET's card face — and a second component under the
// same name would make every import site a guess.
//
// Layout stays at the call site: rail concerns (snap-start, flex basis) ride
// in via `className`.
// ─────────────────────────────────────────────────────────────────────────────

/** The grouper's own ticker fold, for duplicate-detection on the bento. */
const foldSymbol = (s: string) => showSymbol(s).toUpperCase()

// THE BUNDLE DRESS (the owner 2026-08-11: "a cool border / title that shows its a
// bundle") — every mount of this card wears it, so a bundle is recognisable as
// a bundle on every surface: a violet edge with a soft glow (bundle surfaces
// are violet), a faint violet wash instead of the basket cards' flat panel,
// and the BUNDLE chip leading the eyebrow. Hover deepens the violet — never
// cyan, which is the basket cards' hover and would dress this as one of them.
const BUNDLE_SHELL =
  'press group block rounded-2xl border border-violet/35 ' +
  'bg-[linear-gradient(160deg,rgba(164,139,255,0.09),rgba(255,255,255,0.02)_55%)] ' +
  'shadow-[0_0_28px_-10px_rgba(164,139,255,0.45)] transition-colors hover:border-violet-bright/70'

function BundleEyebrow({ chains }: { chains: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
      <span className="rounded-full border border-violet/45 bg-violet/10 px-2 py-0.5 text-[9px] font-bold tracking-[0.22em] text-violet-bright">
        Bundle
      </span>
      {/* wraps as one phrase under the chip, never mid-phrase */}
      <span className="whitespace-nowrap">one idea · {chains} networks</span>
    </div>
  )
}

export function ThesisDoorCard({
  thesis,
  size = 'sm',
  className = '',
}: {
  thesis: Thesis
  /** 'sm' = the Creator strip's compact face (default) · 'md' = the full
   *  BasketCard-grade face (Explore's grid, the homepage shelf). */
  size?: 'sm' | 'md'
  /** Layout-only classes from the call site (snap/basis in a rail, min-w-0 in a grid). */
  className?: string
}) {
  const md = size === 'md'
  const series = useMemo(() => (md ? thesisCombinedSeries(thesis.legs) : null), [md, thesis])
  const oneOfEach = md ? thesisOneOfEach(thesis.legs) : null
  const bento = useMemo(() => (md ? thesisBentoItems(thesis, foldSymbol) : []), [md, thesis])
  // The idea's own 24h move — each leg weighted by its share of the money,
  // only over legs where both halves are readable (the thesis page's rule).
  const change24h = useMemo(() => {
    if (!md) return null
    let wSum = 0
    let acc = 0
    for (const l of thesis.legs) {
      const chg = l.change24hPct
      if (chg == null || !Number.isFinite(chg) || !Number.isFinite(l.aumUsd) || l.aumUsd <= 0) continue
      wSum += l.aumUsd
      acc += chg * l.aumUsd
    }
    return wSum > 0 ? acc / wSum : null
  }, [md, thesis])

  const splitBar =
    thesis.totalAumUsd > 0 ? (
      <div className={`flex w-full gap-0.5 overflow-hidden rounded-full ${md ? 'h-2' : 'h-1.5'}`}>
        {thesis.legs.map((leg) => {
          const pct = Number.isFinite(leg.aumUsd) && leg.aumUsd > 0 ? (leg.aumUsd / thesis.totalAumUsd) * 100 : 0
          if (pct <= 0) return null
          return (
            <span
              key={leg.chainId}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${pct}%`, background: chainMeta(leg.chainId).color }}
            />
          )
        })}
      </div>
    ) : null

  if (!md)
    return (
      <Link
        to={thesisHref(thesis.deployer, thesis.name)}
        /* `block` is load-bearing: an <a> is inline by default, and only the
           flex mounts (the creator strip, the home rail) blockify it for free —
           in a GRID cell an inline card fragments its own border across line
           boxes and drops its padding (seen live, 2026-08-10). */
        className={`${BUNDLE_SHELL} p-4 ${className}`}
      >
        <BundleEyebrow chains={thesis.chainIds.length} />
        <div className="mt-2 truncate font-display text-base font-bold text-ink group-hover:text-violet-bright">
          {showName(thesis.name)}
        </div>
        <div className="mt-3">{splitBar}</div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {thesis.chainIds.map((id) => (
            <ChainBadge key={id} chainId={id} />
          ))}
          {thesis.totalAumUsd > 0 && (
            <span className="font-mono text-[11px] tabular-nums text-ink-dim">
              {formatUsdCompact(thesis.totalAumUsd)}
            </span>
          )}
        </div>
      </Link>
    )

  return (
    <Link
      to={thesisHref(thesis.deployer, thesis.name)}
      className={`${BUNDLE_SHELL} p-5 sm:p-6 ${className}`}
    >
      {/* head: the idea and where it lives */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <BundleEyebrow chains={thesis.chainIds.length} />
          <div className="mt-1.5 truncate font-display text-xl font-bold uppercase tracking-tight text-ink group-hover:text-violet-bright">
            {showName(thesis.name)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-1">
          {thesis.chainIds.map((id) => (
            <ChainBadge key={id} chainId={id} />
          ))}
        </div>
      </div>

      {/* THE GLOBAL CHART — the combined value curve, every leg scaled to its
          own dollars. Absent when any leg cannot be read (a partial total is
          a wrong chart); the split bar below still carries the shape. */}
      {series && (
        <div className="pointer-events-none mt-4 h-12">
          <BasketSpark
            chainId={thesis.legs[0].chainId}
            assets={[]}
            navPerToken={0}
            fallback={series}
            range="24H"
            interactive={false}
            address={thesis.legs[0].address}
            symbol={thesis.name}
            legs={bento.map((b) => ({ symbol: b.symbol, address: b.address, weightPct: b.weightPct }))}
          />
        </div>
      )}

      {/* THE COMPOSITE BENTO — every asset from every leg on one canvas, the
          basket card's own grid, weighted by real share of the whole idea. */}
      {bento.length > 0 && (
        <div className="pointer-events-none mt-4">
          <BasketBento items={bento} fill className="min-h-[150px]" />
        </div>
      )}

      {/* the money row — the basket card's own grammar: price left, move +
          size right. The price is ONE OF EACH leg summed, and the label says
          so: it is the only per-unit figure that is honest across baskets
          with unrelated supplies. */}
      <div className="mt-4 flex items-end justify-between gap-4">
        <div>
          {oneOfEach != null ? (
            <>
              <div className="font-num text-2xl leading-none tabular-nums text-ink">
                ${formatNav(oneOfEach, 4)}
                <span className="ml-1 text-xs text-ink-faint">USD</span>
              </div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                combined price
              </div>
            </>
          ) : (
            <div className="font-mono text-[11px] text-ink-faint">price unreadable right now</div>
          )}
        </div>
        <div className="text-right">
          {change24h != null && (
            <div className="font-num text-sm font-semibold tabular-nums" style={{ color: chainMeta(thesis.legs[0].chainId).color }}>
              {formatPct(change24h)}
            </div>
          )}
          {thesis.totalAumUsd > 0 && (
            <div className="mt-1 font-mono text-[11px] tabular-nums text-ink-faint">
              TVL {formatUsdCompact(thesis.totalAumUsd)}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4">{splitBar}</div>
    </Link>
  )
}
