import { useEffect, useMemo, useRef, useState } from 'react'
import { squarify } from '../lib/treemap'
import { AssetLogo } from './AssetLogo'
import { AssetHoverCard } from './AssetHoverCard'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { useTokenColors } from '../lib/spectrum/use-token-color'

export interface BentoItem {
  symbol: string
  address: string
  weightPct: number
  chainId: number
}

const VW = 300 // virtual width; height derives from the `aspect` prop (default 3:2)

// Tile AREA scales by weight^SIZE_EXP (< 1) so a dominant holding doesn't take a
// full-height column and the long tail stays legible. Labels show the TRUE weight.
const SIZE_EXP = 0.65

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// Deterministic 0..1 per asset — gives each tile its own sheen timing.
function hashUnit(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return (h % 997) / 997
}

// Basket as a squarified treemap; ticker/weight/logo scale to each block's real
// pixel size (measured) so a 12-token basket stays legible in a small card.
export function BasketBento({
  items,
  compact = false,
  className = '',
  reveal,
  show = true,
  aspect = 1.5,
  fill = false,
  expandable = false,
}: {
  items: BentoItem[]
  compact?: boolean
  className?: string
  // Optional staggered entrance: each tile pops in by weight rank when `show`
  // flips true. Omit for the default (all tiles visible immediately).
  reveal?: { delayMs: number; stepMs: number }
  show?: boolean
  // Layout aspect ratio (width / height). 1.5 = 3:2 (default); pass a larger
  // value (e.g. 3.2) for a wide, full-width strip of tiles.
  aspect?: number
  // Fill the parent's box (measures real width AND height) instead of imposing
  // `aspect`. Use when the bento sits in a flex/grid cell that owns the height.
  fill?: boolean
  // Hover-to-expand: hovering a tile dims the rest and pops a brand-colored
  // preview card (logo, price, 24h, sparkline) for that asset. Lazy-loaded.
  expandable?: boolean
}) {
  // Unknown tokens upgrade from hash colors to their logo's dominant color as
  // extractions land (items carry per-item chainId; 1 is just the fallback).
  useTokenColors(items, items[0]?.chainId ?? 1)
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hovered, setHovered] = useState<string | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setSize({ w: cr.width, h: cr.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const width = size.w
  const height = size.h

  const VH = fill && width > 0 && height > 0 ? VW * (height / width) : VW / aspect
  const rects = useMemo(
    () =>
      squarify(
        items.filter((i) => i.weightPct > 0).map((i) => ({ ticker: i.address, weight: Math.pow(i.weightPct, SIZE_EXP) })),
        VW,
        VH,
      ),
    [items, VH],
  )
  const byAddr = useMemo(() => new Map(items.map((i) => [i.address.toLowerCase(), i])), [items])
  // Weight rank (0 = largest) drives the staggered reveal order.
  const rankByAddr = useMemo(() => {
    const m = new Map<string, number>()
    ;[...items]
      .filter((i) => i.weightPct > 0)
      .sort((a, b) => b.weightPct - a.weightPct)
      .forEach((it, i) => m.set(it.address.toLowerCase(), i))
    return m
  }, [items])

  if (rects.length === 0) {
    return fill ? (
      <div className={`h-full w-full rounded-xl bg-white/[0.02] ${className}`} />
    ) : (
      <div className={`w-full rounded-xl bg-white/[0.02] ${className}`} style={{ aspectRatio: String(aspect) }} />
    )
  }

  const cW = width || 320
  const cH = fill && height > 0 ? height : cW * (VH / VW)

  // Expanded preview placement: center the card on the hovered tile, then clamp
  // so it never spills outside the bento box. Dimensions track AssetHoverCard.
  const HOVER_W = 208
  const HOVER_H = 150
  const hoveredItem = expandable && hovered ? byAddr.get(hovered) : null
  const hoveredRect = expandable && hovered ? rects.find((rr) => rr.ticker.toLowerCase() === hovered) : null
  const hoverPos =
    hoveredRect && cW > 0
      ? {
          left: clamp(((hoveredRect.x + hoveredRect.w / 2) / VW) * cW - HOVER_W / 2, 4, Math.max(4, cW - HOVER_W - 4)),
          top: clamp(((hoveredRect.y + hoveredRect.h / 2) / VH) * cH - HOVER_H / 2, 4, Math.max(4, cH - HOVER_H - 4)),
        }
      : null

  return (
    <div
      ref={ref}
      className={`relative w-full ${fill ? 'h-full' : ''} ${className}`}
      style={fill ? undefined : { aspectRatio: String(aspect) }}
    >
      {rects.map((r) => {
        const it = byAddr.get(r.ticker.toLowerCase())
        if (!it) return null
        const bW = (r.w / VW) * cW
        const bH = (r.h / VH) * cH
        const minDim = Math.min(bW, bH)
        const tickerFont = clamp(minDim * 0.15, 6.5, 13)
        const weightFont = clamp(minDim * 0.17, 8, 14)
        const logoSize = Math.round(clamp(minDim * 0.42, 14, 40))
        const showTicker = minDim > 19
        const showLogo = !compact && minDim > 46 && bW > 50
        const vis = tokenVisual(it.symbol, it.address)
        // Per-tile sheen: bigger tiles get a broader band; each tile is phase-
        // and speed-offset by a hash of its address so glints don't march in sync.
        const seed = hashUnit(it.address)
        const sheenBand = clamp(4 + ((minDim - 30) / 170) * 6, 4, 10)
        const sheenDur = 9 + seed * 5
        // % normally sits inline to the right of the ticker; if the box is too
        // narrow to fit both side-by-side (and there's vertical room for it),
        // drop the % BELOW the ticker so the ticker keeps its full width instead
        // of being truncated by the percentage.
        const pctText = `${Math.round(it.weightPct)}%`
        const innerW = bW - 12
        // Approx rendered pill width (Chakra Petch bold uppercase + tracking is wide).
        const tickerW = it.symbol.length * tickerFont * 0.78 + 12
        // The inline ticker pill is capped at max-w-[76%], so it truncates once its
        // natural width passes ~68% of the inner width — at that point stack the %
        // beneath it (full-width ticker), provided there's room for two short lines.
        const stackPct = showTicker && tickerW > innerW * 0.68 && bH - 12 >= tickerFont + weightFont + 6
        // When stacked, only keep the logo if it ALSO fits below the ticker + %;
        // otherwise drop it so the now-full-width ticker stays readable.
        const showLogoFinal = showLogo && (!stackPct || bH - 12 >= tickerFont + weightFont + logoSize + 14)
        // Optional pop-in, sequenced by weight rank.
        const rank = rankByAddr.get(it.address.toLowerCase()) ?? 0
        const revealStyle = reveal
          ? {
              opacity: show ? 1 : 0,
              transform: show ? 'scale(1)' : 'scale(0.82)',
              transition: 'opacity 0.4s ease, transform 0.5s cubic-bezier(0.34,1.56,0.64,1)',
              transitionDelay: `${reveal.delayMs + rank * reveal.stepMs}ms`,
            }
          : undefined
        // When a tile is hovered (expandable mode), fade the others back so the
        // expanded preview reads clearly; lift the active tile above its siblings.
        const addrLower = it.address.toLowerCase()
        const isHovered = hovered === addrLower
        const dimStyle =
          expandable && hovered
            ? { opacity: isHovered ? 1 : 0.35, transition: 'opacity 0.2s ease', zIndex: isHovered ? 30 : undefined }
            : undefined
        return (
          <div
            key={r.ticker}
            className="absolute p-0.5"
            onMouseEnter={expandable ? () => setHovered(addrLower) : undefined}
            onMouseLeave={expandable ? () => setHovered((h) => (h === addrLower ? null : h)) : undefined}
            style={{
              left: `${(r.x / VW) * 100}%`,
              top: `${(r.y / VH) * 100}%`,
              width: `${(r.w / VW) * 100}%`,
              height: `${(r.h / VH) * 100}%`,
              ...revealStyle,
              ...dimStyle,
            }}
          >
            <div
              className="relative h-full w-full overflow-hidden rounded-xl"
              style={{
                background: vis.color,
                // raised tile: bright top edge + soft inner bottom shade
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -3px 7px rgba(0,0,0,0.22)',
              }}
              title={`${it.symbol} · ${it.weightPct.toFixed(1)}%`}
            >
              {/* vertical light → shade gives the block dimension (3D tile) */}
              <div
                aria-hidden
                className="absolute inset-0"
                style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0) 34%, rgba(0,0,0,0.16))' }}
              />
              {/* diagonal sheen — slowly sweeps across, staggered by x so the
                  highlight travels over the whole card */}
              <div
                aria-hidden
                className="bento-sheen absolute inset-0"
                style={{
                  backgroundImage: `linear-gradient(115deg, transparent ${(50 - sheenBand).toFixed(1)}%, rgba(255,255,255,0.14) 50%, transparent ${(50 + sheenBand).toFixed(1)}%)`,
                  animationDuration: `${sheenDur.toFixed(1)}s`,
                  animationDelay: `${(-seed * sheenDur).toFixed(2)}s`,
                }}
              />
              {compact
                ? minDim > 30 && (
                    <span
                      className="absolute left-1.5 top-1 font-display font-bold uppercase leading-none text-white/95"
                      style={{ fontSize: clamp(minDim * 0.14, 7, 11) }}
                    >
                      {it.symbol}
                    </span>
                  )
                : (showTicker || showLogoFinal) && (
                    <div className="absolute inset-0 flex flex-col justify-between p-1.5">
                      <div
                        className={`flex ${
                          stackPct ? 'flex-col items-start gap-0.5' : 'items-start justify-between gap-1'
                        }`}
                      >
                        {showTicker ? (
                          <span
                            className={`${
                              stackPct ? 'max-w-full' : 'max-w-[76%]'
                            } truncate rounded-md bg-white/90 px-1.5 py-0.5 font-display font-bold uppercase leading-none tracking-wide text-black shadow-[0_2px_8px_rgba(0,0,0,0.45)]`}
                            style={{ fontSize: tickerFont }}
                          >
                            {it.symbol}
                          </span>
                        ) : (
                          <span />
                        )}
                        {showTicker && (
                          <span
                            className="font-num font-semibold leading-none tabular-nums"
                            style={{ fontSize: weightFont, color: vis.ink }}
                          >
                            {pctText}
                          </span>
                        )}
                      </div>
                      {showLogoFinal && (
                        <div className="mb-1 mr-1 self-end">
                          <AssetLogo
                            address={it.address}
                            symbol={it.symbol}
                            chainId={it.chainId}
                            size={logoSize}
                            discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`}
                          />
                        </div>
                      )}
                    </div>
                  )}
            </div>
          </div>
        )
      })}

      {expandable && hoveredRect && hoveredItem && hoverPos && (
        <div
          key={hoveredItem.address}
          className="pointer-events-none absolute z-50"
          style={{ left: hoverPos.left, top: hoverPos.top, width: HOVER_W }}
        >
          <AssetHoverCard
            chainId={hoveredItem.chainId}
            address={hoveredItem.address}
            symbol={hoveredItem.symbol}
            weightPct={hoveredItem.weightPct}
          />
        </div>
      )}
    </div>
  )
}
