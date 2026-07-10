import { useEffect, useRef } from 'react'

// Pixel-dissolve overlay — the dissolve phase of Prismbeat's PixelReveal, adapted to
// run standalone as an EXIT. Fills its positioned parent's footprint with a grid of
// pixels that pop, drift up, shrink and fade out in a staggered wave, so the host
// appears to disintegrate into pixels. One <canvas>, not hundreds of DOM nodes.

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const int = parseInt(n, 16)
  if (Number.isNaN(int)) return [53, 224, 255]
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

interface Pix {
  x: number
  y: number
  delay: number
  drift: number
  rgb: [number, number, number]
}

export function PixelDissolve({
  colors = ['#35e0ff'],
  maxPixels = 260,
  duration = 620,
  spread = 340,
  onDone,
}: {
  /** pixel palette — each cell picks one at random (Spectrum passes the spectral set) */
  colors?: string[]
  /** rough cap on pixel count; spacing scales to the host so big cards stay light */
  maxPixels?: number
  /** a single pixel's dissolve (ms) */
  duration?: number
  /** random per-pixel stagger across the field (ms) */
  spread?: number
  onDone?: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    const reduced =
      typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!canvas || !host || reduced) {
      doneRef.current?.()
      return
    }
    const rect = host.getBoundingClientRect()
    const W = Math.round(rect.width)
    const H = Math.round(rect.height)
    const ctx = canvas.getContext('2d')
    if (W < 4 || H < 4 || !ctx) {
      doneRef.current?.()
      return
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    ctx.scale(dpr, dpr)

    const rgbs = colors.map(hexRgb)
    const spacing = Math.max(12, Math.sqrt((W * H) / maxPixels))
    const cols = Math.ceil(W / spacing)
    const rows = Math.ceil(H / spacing)
    const size = Math.max(4, Math.min(Math.round(spacing * 0.62), 16))
    const radius = Math.min(2, size / 4)

    const pix: Pix[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        pix.push({
          x: Math.round(c * spacing + (spacing - size) / 2),
          y: Math.round(r * spacing + (spacing - size) / 2),
          delay: Math.random() * spread,
          drift: 5 + Math.random() * 14,
          rgb: rgbs[(Math.random() * rgbs.length) | 0],
        })
      }
    }

    let raf = 0
    let startTs = 0
    let cancelled = false
    const end = duration + spread + 80

    const frame = (ts: number) => {
      if (cancelled) return
      if (!startTs) startTs = ts
      const el = ts - startTs
      ctx.clearRect(0, 0, W, H)
      for (let i = 0; i < pix.length; i++) {
        const p = pix[i]
        const dp = (el - p.delay) / duration
        if (dp <= 0 || dp >= 1) continue // not started, or gone
        const e = easeOutExpo(dp)
        const alpha = 1 - dp
        const s = size * (1 - 0.45 * e)
        const y = p.y - p.drift * e
        if (alpha <= 0.01) continue
        ctx.globalAlpha = alpha
        ctx.fillStyle = `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})`
        const ox = p.x + (size - s) / 2
        const oy = y + (size - s) / 2
        if (ctx.roundRect) {
          ctx.beginPath()
          ctx.roundRect(ox, oy, s, s, radius)
          ctx.fill()
        } else {
          ctx.fillRect(ox, oy, s, s)
        }
      }
      ctx.globalAlpha = 1
      if (el >= end) {
        doneRef.current?.()
        return
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [colors, maxPixels, duration, spread])

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 z-40 h-full w-full" />
}
