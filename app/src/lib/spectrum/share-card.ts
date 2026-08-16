import { squarify } from '../treemap'
import { showSymbol } from './safe-copy'
import { tokenVisual } from './token-meta'

// ─────────────────────────────────────────────────────────────────────────────
// SHARE-YOUR-MIX CARD (feature 9, greenlit ~11:2x): a percent-only bento
// image — never a dollar on it, so there is nothing private to leak and
// nothing the copy screen's red lines could catch. Tiles are drawn from the
// identity colours (no remote logos: a cross-origin image taints the canvas
// and blocks export). The layout is the SAME squarify the live bento uses.
// ─────────────────────────────────────────────────────────────────────────────

export interface ShareItem {
  symbol: string
  pct: number
  color: string
}

/** Percent-only, normalized, top 12 by share — the pure half, tested. */
export function shareCardItems(assets: { symbol: string; address: string; valueUsd: number }[]): ShareItem[] {
  const held = assets.filter((a) => a.valueUsd > 0)
  const total = held.reduce((s, a) => s + a.valueUsd, 0)
  if (total <= 0) return []
  return [...held]
    .sort((a, b) => b.valueUsd - a.valueUsd)
    .slice(0, 12)
    .map((a) => ({
      symbol: a.symbol.slice(0, 12),
      pct: Math.round((a.valueUsd / total) * 1000) / 10,
      color: tokenVisual(a.symbol, a.address).color,
    }))
}

const SIZE_EXP = 0.65

export function drawShareCard(canvas: HTMLCanvasElement, items: ShareItem[]): void {
  const W = 1200
  const H = 630
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  // ground
  ctx.fillStyle = '#0c0a18'
  ctx.fillRect(0, 0, W, H)
  // header
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = '700 34px "Chakra Petch", "Arial Black", sans-serif'
  ctx.fillText('MY MIX', 48, 64)
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.font = '600 20px "Space Mono", monospace'
  const wm = 'SPECTRUM'
  ctx.fillText(wm, W - 48 - ctx.measureText(wm).width, 62)
  // the grid
  const pad = 48
  const top = 96
  const rects = squarify(
    items.map((i) => ({ ticker: i.symbol, weight: Math.pow(Math.max(i.pct, 0.5), SIZE_EXP) })),
    W - pad * 2,
    H - top - pad,
  )
  const bySym = new Map(items.map((i) => [i.symbol, i]))
  for (const r of rects) {
    const it = bySym.get(r.ticker)
    if (!it) continue
    const x = pad + r.x + 3
    const y = top + r.y + 3
    const w = r.w - 6
    const h = r.h - 6
    ctx.fillStyle = it.color
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 18)
    ctx.fill()
    // top sheen
    const grad = ctx.createLinearGradient(0, y, 0, y + h)
    grad.addColorStop(0, 'rgba(255,255,255,0.16)')
    grad.addColorStop(0.4, 'rgba(255,255,255,0)')
    grad.addColorStop(1, 'rgba(0,0,0,0.18)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 18)
    ctx.fill()
    const minDim = Math.min(w, h)
    if (minDim < 40) continue
    const fs = Math.max(14, Math.min(30, minDim * 0.18))
    ctx.fillStyle = 'rgba(255,255,255,0.96)'
    ctx.font = `700 ${fs}px "Chakra Petch", "Arial Black", sans-serif`
    ctx.fillText(`$${showSymbol(it.symbol)}`, x + 14, y + 14 + fs)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = `600 ${fs * 0.9}px "Space Mono", monospace`
    ctx.fillText(`${Math.round(it.pct)}%`, x + 14, y + h - 14)
  }
}
