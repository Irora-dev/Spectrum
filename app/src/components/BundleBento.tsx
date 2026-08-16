import { useMemo } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { Link } from 'react-router'
import { BasketAvatar } from './BasketAvatar'
import { BasketBento } from './BasketBento'
import { BasketWash } from './BasketWash'
import { ChainBadge } from './ChainBadge'
import { chainCfg } from '../lib/chain/chains'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { squarify } from '../lib/treemap'
import type { BasketSummary } from '../lib/spectrum/basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// The BUNDLE BENTO — a bundle rendered as a weighted treemap of its baskets,
// each tile carrying that basket's OWN bento when there's room. One shared
// component so a bundle looks the same everywhere it appears (owner 2026-07-29:
// discovery shows bentos in a grid, not a list): the /bundle page uses the big
// interactive version, discovery cards use `compact`.
//
// Tile area is weight^0.7, not weight — pure weight makes a 60/20/20 bundle
// read as one slab with slivers; the softened exponent keeps every leg legible
// while preserving the visual ranking.
// ─────────────────────────────────────────────────────────────────────────────

export interface BundleBentoLeg {
  chainId: number
  address: string
  /** Relative weight (any scale). */
  weight: number
  ix?: BasketSummary | null
}

export function BundleBento({
  legs,
  aspect = 2.2,
  compact = false,
  linkLegs = true,
}: {
  legs: BundleBentoLeg[]
  aspect?: number
  /** Card-sized: no inner bentos, smaller type, no chain badges. */
  compact?: boolean
  /** Whether a tile links to its basket (off inside a card that is itself a link). */
  linkLegs?: boolean
}) {
  const VW = 300
  const VH = VW / aspect
  const total = legs.reduce((s, l) => s + Math.max(l.weight, 0), 0) || 1
  const withPct = useMemo(
    () => legs.map((l) => ({ ...l, pct: (Math.max(l.weight, 0) / total) * 100 })),
    [legs, total],
  )
  const rects = useMemo(
    () =>
      squarify(
        withPct
          .filter((l) => l.pct > 0)
          .map((l) => ({ ticker: `${l.chainId}:${l.address}`, weight: Math.pow(l.pct, 0.7) })),
        VW,
        VH,
      ),
    [withPct, VH],
  )
  const byKey = useMemo(
    () => new Map(withPct.map((l) => [`${l.chainId}:${l.address}`.toLowerCase(), l])),
    [withPct],
  )

  if (rects.length === 0) {
    return <div className="w-full rounded-2xl bg-white/[0.02]" style={{ aspectRatio: String(aspect) }} />
  }

  return (
    <div className="relative w-full overflow-hidden rounded-2xl" style={{ aspectRatio: String(aspect) }}>
      {rects.map((r) => {
        const leg = byKey.get(r.ticker.toLowerCase())
        if (!leg) return null
        const { ix, pct } = leg
        const sig = ix ? basketSignatureColor(ix.address, ix.top[0]) : 'var(--color-violet)'
        const wFrac = r.w / VW
        const hFrac = r.h / VH
        const big = !compact && wFrac > 0.34 && hFrac > 0.4
        const symbol = ix?.symbol ?? '—'
        const Tile = linkLegs && ix ? Link : 'div'
        const tileProps = linkLegs && ix ? { to: `/token?addr=${ix.address}&chain=${ix.chainId}` } : {}
        return (
          <div
            key={r.ticker}
            className={compact ? 'absolute p-0.5' : 'absolute p-1'}
            style={{
              left: `${(r.x / VW) * 100}%`,
              top: `${(r.y / VH) * 100}%`,
              width: `${wFrac * 100}%`,
              height: `${hFrac * 100}%`,
            }}
          >
            <Tile
              {...(tileProps as { to: string })}
              className={`group/tile relative flex h-full w-full flex-col justify-between overflow-hidden border border-white/10 ${
                compact ? 'rounded-lg p-2' : 'rounded-xl p-3'
              } ${linkLegs && ix ? 'transition-[transform,border-color] duration-300 hover:-translate-y-0.5 hover:border-white/30' : ''}`}
              style={{ background: `linear-gradient(150deg, ${sig}2e, rgba(255,255,255,0.02) 62%)` }}
            >
              {ix && <BasketWash ix={ix} opacity={0.26} />}
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-10 -right-10 h-32 w-32 rounded-full opacity-20 blur-3xl"
                style={{ background: sig }}
              />
              <div className="relative z-10 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {ix && <BasketAvatar address={ix.address} symbol={ix.symbol} size={big ? 30 : compact ? 16 : 22} />}
                  <span
                    className={`truncate font-display font-bold uppercase leading-none text-ink ${
                      compact ? 'text-[10px]' : 'text-sm sm:text-base'
                    }`}
                  >
                    ${showSymbol(symbol)}
                  </span>
                </div>
                {!compact && <ChainBadge chainId={leg.chainId} />}
              </div>

              {/* the leg's own bento — the "bentos in a grid" read */}
              {big && ix && (
                <div className="relative z-10 my-1 overflow-hidden rounded-lg border border-white/10 bg-black/25 p-1.5">
                  <BasketBento
                    items={ix.top.map((t) => ({
                      symbol: t.symbol,
                      address: t.address,
                      weightPct: t.weightPct,
                      chainId: ix.chainId,
                    }))}
                    aspect={3}
                    compact
                  />
                </div>
              )}
              {compact && ix && hFrac > 0.5 && (
                <div className="relative z-10 overflow-hidden rounded-md border border-white/10 bg-black/25 p-1">
                  <BasketBento
                    items={ix.top.map((t) => ({
                      symbol: t.symbol,
                      address: t.address,
                      weightPct: t.weightPct,
                      chainId: ix.chainId,
                    }))}
                    aspect={3.4}
                    compact
                  />
                </div>
              )}

              <div className="relative z-10 flex items-baseline justify-between gap-2">
                <span
                  className={`font-num font-light leading-none tabular-nums text-ink ${
                    compact ? 'text-sm' : 'text-2xl sm:text-3xl'
                  }`}
                >
                  {Math.round(pct)}%
                </span>
                {!compact && (
                  <span className="truncate font-mono text-[9px] uppercase tracking-wide text-ink-faint">
                    {chainCfg(leg.chainId).name}
                  </span>
                )}
              </div>
            </Tile>
          </div>
        )
      })}
    </div>
  )
}
