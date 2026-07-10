import { useMemo } from 'react'
import type { BasketSummary } from '../lib/spectrum/basket-data'
import { basketSignatureColor } from '../lib/spectrum/signature'
import { tokenVisual } from '../lib/spectrum/token-meta'

// ─────────────────────────────────────────────────────────────────────────────
// The CSS echo of the Token hero's WebGL warp (WarpIdentity) for surfaces that
// REPEAT — rows, cards, list entries. Same deterministic identity: the basket
// address seeds it, the palette is the basket signature + its top holdings'
// brand colors (exactly what the hero's shader uses) — but rendered as seeded,
// layered radial-gradients. A page of rows would exhaust the browser's WebGL
// context budget (~8–16 per page); this costs nothing and never dies.
//
// Masked toward one side (`side` = where the color LIVES) so text on the other
// side keeps full contrast; `mix-blend-screen` over the dark card keeps the
// wash luminous without ever muddying ink. Purely decorative (aria-hidden).
// ─────────────────────────────────────────────────────────────────────────────

function hashUnit(s: string, salt: number): number {
  let h = salt >>> 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return (h % 1013) / 1013
}

// The peak sits INSIDE the row (25–60%), not at the edge: numbers/actions hug
// the far edge, so it stays quieter there (adversarial-contrast pass 2026-07-06).
// `full` skips the mask — for washes UNDER another layer (e.g. behind a bento's
// tiles) where no text needs a quiet side.
const MASKS = {
  right: 'linear-gradient(to left, rgba(0,0,0,0.3) 0%, black 25%, rgba(0,0,0,0.5) 58%, transparent 84%)',
  left: 'linear-gradient(to right, rgba(0,0,0,0.3) 0%, black 25%, rgba(0,0,0,0.5) 58%, transparent 84%)',
  full: undefined,
} as const

export function BasketWash({
  ix,
  side = 'right',
  opacity = 0.38,
  className = '',
}: {
  ix: Pick<BasketSummary, 'address' | 'chainId' | 'top'>
  /** Which side the color clusters on — text lives on the other; `full` = everywhere, unmasked. */
  side?: 'left' | 'right' | 'full'
  opacity?: number
  className?: string
}) {
  const background = useMemo(() => {
    const seed = `${ix.chainId}:${ix.address.toLowerCase()}`
    const palette = [
      basketSignatureColor(ix.address, ix.top[0]),
      ...ix.top.slice(0, 3).map((t) => tokenVisual(t.symbol, t.address).color),
    ]
    return palette
      .map((color, i) => {
        const u = hashUnit(seed, i * 7 + 1)
        const v = hashUnit(seed, i * 13 + 3)
        const r = 36 + hashUnit(seed, i * 17 + 5) * 38 // blob radius 36–74%
        const x = side === 'full' ? u * 100 : side === 'right' ? 55 + u * 45 : u * 45 // cluster on the visible side
        const y = v * 100
        return `radial-gradient(${r.toFixed(0)}% ${(r * 1.5).toFixed(0)}% at ${x.toFixed(0)}% ${y.toFixed(0)}%, ${color} 0%, transparent 70%)`
      })
      .join(', ')
  }, [ix.address, ix.chainId, ix.top, side])

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 rounded-[inherit] mix-blend-screen ${className}`}
      style={{ background, opacity, maskImage: MASKS[side], WebkitMaskImage: MASKS[side] }}
    />
  )
}
