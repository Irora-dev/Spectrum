import { useEffect, useRef, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// THE BRIDGE RUNNER (owner 2026-08-15, watching his $69 travel BASE → ETH:
// "while you wait for your asset to bridge you should be able to play a fun
// runner jumping game with spacebar… neatly in the middle as you show the
// bridging wait below it"). A tiny canvas runner: spacebar / tap to jump the
// bars, score is how far you get; hitting one just restarts the run — a wait
// filler must never add its own failure ceremony. Self-contained: no assets,
// no deps, house tokens read off the element, rAF stops on unmount. It only
// ANIMATES after the player's own first input (the reduced-motion-friendly
// default: opting in by playing IS the motion consent).
// ─────────────────────────────────────────────────────────────────────────────

const H = 132
const GROUND = H - 26

interface Bar {
  x: number
  w: number
  h: number
  passed?: boolean
}

export function BridgeRunnerGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [started, setStarted] = useState(false)
  const [best, setBest] = useState(0)
  const stateRef = useRef({ started: false, score: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const css = getComputedStyle(canvas)
    const accent = css.getPropertyValue('--color-cyan').trim() || '#35e0ff'
    const magenta = css.getPropertyValue('--color-magenta').trim() || '#ff4fd8'

    let w = 0
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const resize = () => {
      w = canvas.clientWidth
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    // ── the run ──
    let y = GROUND
    let vy = 0
    let bars: Bar[] = []
    let speed = 3.2
    let score = 0
    let sinceSpawn = 0
    let flash = 0
    let raf = 0
    let last = performance.now()

    const reset = () => {
      y = GROUND
      vy = 0
      bars = []
      speed = 3.2
      score = 0
      sinceSpawn = 0
      flash = 8
    }

    const jump = () => {
      if (!stateRef.current.started) {
        stateRef.current.started = true
        setStarted(true)
      }
      if (y >= GROUND - 0.5) vy = -7.6
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      jump()
    }
    const onPointer = (e: PointerEvent) => {
      e.preventDefault()
      jump()
    }
    window.addEventListener('keydown', onKey)
    canvas.addEventListener('pointerdown', onPointer)

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(2.5, (now - last) / 16.667)
      last = now
      ctx.clearRect(0, 0, w, H)

      // ground line + drifting ticks (the track)
      ctx.globalAlpha = 0.25
      ctx.fillStyle = accent
      ctx.fillRect(0, GROUND + 10, w, 1)
      ctx.globalAlpha = 1

      const runnerX = Math.max(40, w * 0.16)

      if (stateRef.current.started) {
        // physics
        vy += 0.44 * dt
        y = Math.min(GROUND, y + vy * dt)
        speed += 0.0011 * dt * 16
        sinceSpawn += speed * dt
        const gap = 190 + Math.random() * 90
        if (sinceSpawn > gap) {
          sinceSpawn = 0
          bars.push({ x: w + 20, w: 8 + Math.random() * 8, h: 16 + Math.random() * 22 })
        }
        for (const b of bars) b.x -= speed * dt
        bars = bars.filter((b) => b.x + b.w > -10)
        // collide / score
        for (const b of bars) {
          const top = GROUND + 10 - b.h
          if (!b.passed && b.x + b.w < runnerX - 5) {
            b.passed = true
            score += 1
            stateRef.current.score = score
            setBest((prev) => Math.max(prev, score))
          }
          if (b.x < runnerX + 5 && b.x + b.w > runnerX - 5 && y + 5 > top) {
            reset()
            break
          }
        }
      }

      // bars
      ctx.fillStyle = magenta
      for (const b of bars) ctx.fillRect(b.x, GROUND + 10 - b.h, b.w, b.h)

      // the runner — a glowing square with a little trail
      ctx.save()
      ctx.shadowColor = accent
      ctx.shadowBlur = 12
      ctx.fillStyle = accent
      ctx.fillRect(runnerX - 5, y - 5, 10, 10)
      ctx.restore()
      ctx.globalAlpha = 0.3
      ctx.fillStyle = accent
      ctx.fillRect(runnerX - 14, y - 2, 6, 4)
      ctx.globalAlpha = 1

      // score
      if (stateRef.current.started) {
        ctx.font = '11px ui-monospace, monospace'
        ctx.fillStyle = accent
        ctx.globalAlpha = 0.9
        ctx.textAlign = 'right'
        ctx.fillText(String(score), w - 10, 16)
        ctx.globalAlpha = 1
      }
      if (flash > 0) {
        flash -= dt
        ctx.globalAlpha = Math.max(0, flash / 8) * 0.25
        ctx.fillStyle = magenta
        ctx.fillRect(0, 0, w, H)
        ctx.globalAlpha = 1
      }
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      canvas.removeEventListener('pointerdown', onPointer)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative mt-4">
      <canvas ref={canvasRef} className="block h-[132px] w-full cursor-pointer touch-none rounded-xl bg-black/30" aria-label="Bridge runner — press space or tap to jump" />
      {!started && (
        <p className="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim">
          press space or tap to jump — a little game while it bridges
        </p>
      )}
      {started && best > 0 && (
        <span className="pointer-events-none absolute left-2 top-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">best {best}</span>
      )}
    </div>
  )
}
