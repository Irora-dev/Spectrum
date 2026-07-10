import { useEffect, useRef } from 'react'
import { paletteShader, type PaletteShaderInstance } from '../lib/vendor/palette-shaders'

// Seeded warp backdrop (palette-shaders, TRIAL): a deterministic living texture
// derived from the basket — the address seeds the warp identity (same basket,
// same look, every load, every machine) and the palette is the basket's own
// signature + top-holding brand colors. Purely decorative: mounted best-effort
// and never load-bearing — a WebGL failure leaves the plain surface (the
// SpectrumBackground lesson: a throwing decoration must not unmount the page).
export function WarpIdentity({
  seed,
  colors,
  speed = 1,
  drift = true,
  className = '',
}: {
  seed: string
  colors: string[]
  /** Animation-speed multiplier — retargets the LIVE mount (no remount), so a
   *  host can swirl fast for an intro and ease back without identity flicker. */
  speed?: number
  /** true → seeded barely-there idle motion (identity posture); false → the
   *  warp's full preset animation (0.6 × speed): visibly flowing. */
  drift?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const fxRef = useRef<PaletteShaderInstance | null>(null)
  const speedRef = useRef(speed)
  const colorKey = colors.join(',')
  const colorsRef = useRef(colorKey)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let fx: PaletteShaderInstance | null = null
    try {
      fx = paletteShader({
        target: el,
        colors: colorsRef.current.split(','),
        shader: 'warp',
        seed,
        speed: speedRef.current,
        drift, // no pointer reactivity either way
      })
    } catch {
      return // no WebGL (or bad palette), skip the decoration entirely
    }
    fxRef.current = fx
    // Dev-only handle: headless tabs pause the shader (document.hidden), so
    // motion is asserted via `__warpFx.mount.speed`, not eyeballed (see the
    // palette-shaders guide). Stripped from production builds.
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__warpFx = fx
    return () => {
      fxRef.current = null
      fx?.dispose()
    }
  }, [seed, drift])

  // Palette changes RETINT the live mount (the library tweens the swap) —
  // no remount, no frame jump. This is what lets the warp double as the
  // loading state: it starts on a provisional palette the instant the page
  // mounts and eases into the basket's real colors when data lands.
  useEffect(() => {
    if (colorsRef.current === colorKey) return
    colorsRef.current = colorKey
    void fxRef.current?.setPalette(colorKey.split(','))
  }, [colorKey])

  useEffect(() => {
    speedRef.current = speed
    fxRef.current?.setSpeed(speed)
  }, [speed])

  return <div ref={ref} aria-hidden className={className} />
}
