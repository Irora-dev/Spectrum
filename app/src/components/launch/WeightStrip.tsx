import { useRef } from 'react'
import { AssetLogo } from '../AssetLogo'
import { tokenVisual, readableInk } from '../../lib/spectrum/token-meta'

// Stable, ordered weight editor: each asset is a tile whose width = its weight, and
// the shared edge between two adjacent tiles is a draggable handle. Pull an edge left
// or right to transfer weight between just those two neighbours — tiles never reorder
// or reflow, so it reads like resizing panes. The per-asset steppers remain the
// precise fallback; this is the tactile one.
export function WeightStrip({
  assets,
  weights,
  min,
  chainId,
  onResize,
}: {
  assets: { symbol: string; address: string }[]
  weights: number[]
  min: number
  chainId: number
  // Transfer between adjacent tiles: the pair's sum is preserved, others untouched.
  onResize: (leftIndex: number, leftWeight: number, rightWeight: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ k: number; startX: number; a: number; b: number; widthPx: number } | null>(null)

  const onDown = (k: number) => (e: React.PointerEvent) => {
    const widthPx = ref.current?.clientWidth ?? 1
    ref.current?.setPointerCapture?.(e.pointerId)
    drag.current = { k, startX: e.clientX, a: weights[k] ?? 0, b: weights[k + 1] ?? 0, widthPx }
    e.preventDefault()
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dxPct = ((e.clientX - d.startX) / d.widthPx) * 100
    const sum = d.a + d.b
    const newA = Math.max(min, Math.min(sum - min, Math.round(d.a + dxPct)))
    onResize(d.k, newA, sum - newA)
  }
  const onUp = () => {
    drag.current = null
  }

  if (assets.length === 0) return null

  // Render RELATIVE shares: tiles fill the strip even if Σ drifts from 100 (the Σ
  // readout below the strip is the honest imbalance signal; a data drift must never
  // shrink the whole editor to a sliver).
  const total = weights.slice(0, assets.length).reduce((s, x) => s + (x > 0 ? x : 0), 0) || 1

  return (
    <div
      ref={ref}
      className="relative flex h-[88px] w-full select-none overflow-hidden rounded-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {assets.map((a, i) => {
        const w = weights[i] ?? 0
        const vis = tokenVisual(a.symbol, a.address)
        const ink = readableInk(vis.color)
        const wide = w >= 12
        const last = i === assets.length - 1
        return (
          <div
            key={a.address}
            className="relative h-full min-w-0 transition-[width] duration-150 ease-out"
            style={{ width: `${((w > 0 ? w : 0) / total) * 100}%`, background: vis.color }}
          >
            <div
              aria-hidden
              className="absolute inset-0"
              style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0) 38%, rgba(0,0,0,0.2))' }}
            />
            <div className="relative flex h-full flex-col items-center justify-center gap-1 px-1 text-center">
              {w >= 7 && (
                <AssetLogo
                  address={a.address}
                  symbol={a.symbol}
                  chainId={chainId}
                  size={wide ? 26 : 20}
                  discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`}
                />
              )}
              {wide && (
                <span className="max-w-full truncate font-display text-[11px] font-bold uppercase leading-none" style={{ color: ink }}>
                  {a.symbol}
                </span>
              )}
              {w >= 9 && (
                <span className="font-num text-xs font-bold tabular-nums leading-none" style={{ color: ink }}>
                  {Math.round(w)}%
                </span>
              )}
            </div>

            {/* draggable shared edge (this tile ↔ the next) */}
            {!last && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Reweight ${a.symbol} and ${assets[i + 1].symbol}`}
                onPointerDown={onDown(i)}
                className="group absolute -right-2 top-0 z-10 flex h-full w-4 cursor-ew-resize touch-none items-center justify-center"
              >
                <span
                  aria-hidden
                  className="h-9 w-[3px] rounded-full bg-white/80 shadow-[0_0_6px_rgba(0,0,0,0.7)] transition-[height,width,background-color] duration-150 group-hover:h-12 group-hover:w-[4px] group-hover:bg-white"
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
