import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Heatmap } from '@paper-design/shaders-react'

// ─────────────────────────────────────────────────────────────────────────────
// The homepage intro (owner spec 2026-07-06, choreography refined 16:44): the
// Spectrum LOGO (the prism triangle) as a paper-shaders HEATMAP on a black
// screen — the logo FADES IN, the heat sweeps, then the whole thing fades out
// (~3s from first paint) and the hero staggers in behind it (side animations
// first, then the text — Home consumes `onDone`). Shader parameters are the
// owner's shaders.paper.design/heatmap link (colors 111169→ff00a6, contour .5,
// glows .5, speed 1; scale walked .75→.55→.45→.38 — owner: smaller, centered).
//
// PORTALED to <body>: rendered in-tree, an ancestor's transform/filter turns
// `fixed` into ancestor-relative and the overlay stopped short of the viewport
// bottom (the 16:44 "gap at the bottom"). On body, inset-0 IS the viewport.
//
// Two hard-won constraints of the package (its preprocessing fills the canvas
// WHITE and takes LUMINANCE as the heightfield, then runs multi-pass blurs +
// a PNG re-encode asynchronously):
//   • the logo must be drawn BLACK on transparent — white shapes vanish;
//   • the shader is only visible AFTER processing — it suspends while
//     processing and a probe starts the choreography at actual first paint.
// ONCE PER BROWSER, not per load (owner 2026-07-07 16:11: "when you reload it
// gets a bit tedious seeing it every single time — just make that on first
// load"): a localStorage stamp gates it, the module flag still stops SPA
// replays within a load, and storage-less contexts (private mode) fall back
// to per-load. Decorative: aria-hidden, pointer-events-none, skipped under
// prefers-reduced-motion; any crash or stall hits the failsafe, never a
// stuck-black site.
// ─────────────────────────────────────────────────────────────────────────────

let playedThisLoad = false
const PLAYED_KEY = 'spectrum:hero-intro-played'

function playedBefore(): boolean {
  try {
    return window.localStorage.getItem(PLAYED_KEY) === '1'
  } catch {
    return false // no storage → per-load behavior (the old rule)
  }
}

function stampPlayed(): void {
  try {
    window.localStorage.setItem(PLAYED_KEY, '1')
  } catch {
    /* private mode — the module flag still covers this load */
  }
}

/** Will the intro run this load? (Home reads this to decide whether the hero
 *  should wait for `onDone` or show instantly.) */
export function heroIntroWillPlay(): boolean {
  return !playedThisLoad && !playedBefore() && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const IN_MS = 1500 // the logo fading in SLOWLY (owner 17:08: it 'just appeared')
const HOLD_MS = 1900 // the heat sweep
const FADE_MS = 600 // the overlay fading out — ≈4s visible in total
const FAILSAFE_MS = 7000 // absolute ceiling from mount — must clear the ~4s play + processing

const HEAT_COLORS = ['#111169', '#1f3ca3', '#3265e7', '#75daff', '#ffb87a', '#ff8c00', '#ff00a6']

// A decorative overlay must NEVER take the site down: any render/mount crash
// inside the shader renders nothing (and the failsafe clears the black).
class ShaderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

// Mounts only when the sibling Heatmap stops suspending = processing done.
function ReadyProbe({ onReady }: { onReady: () => void }) {
  useEffect(() => onReady(), [onReady])
  return null
}

/** The Spectrum LOGO — the prism triangle (the favicon/nav glyph's exact
 *  path, `M24 8 L41 38 L7 38 Z` in its 48-unit box) — as a PNG data-URI,
 *  solid BLACK on transparent (the package's luminance preprocessing needs a
 *  dark shape; see header note). */
async function drawLogo(): Promise<string | null> {
  try {
    const SIZE = 1000
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // triangle bbox: x 7…41 (center 24), y 8…38 (center 23) — scale it to
    // fill most of the square; the shader pads for its own glow
    const s = 26
    ctx.setTransform(s, 0, 0, s, SIZE / 2 - 24 * s, SIZE / 2 - 23 * s)
    ctx.fillStyle = '#000000'
    ctx.fill(new Path2D('M24 8 L41 38 L7 38 Z'))
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

export function HeroIntro({ onDone }: { onDone?: () => void }) {
  const [stage, setStage] = useState<'boot' | 'in' | 'fade' | 'gone'>(() => (heroIntroWillPlay() ? 'boot' : 'gone'))
  const [logo, setLogo] = useState<string | null>(null)
  const doneFired = useRef(false)

  // The hero starts animating the moment the overlay begins to FADE (it
  // reveals underneath), and exactly once — whatever path got us there.
  useEffect(() => {
    if ((stage === 'fade' || stage === 'gone') && !doneFired.current) {
      doneFired.current = true
      onDone?.()
    }
  }, [stage, onDone])

  // Draw the logo; a failure skips the intro entirely.
  useEffect(() => {
    if (stage === 'gone') return
    playedThisLoad = true
    stampPlayed()
    let stale = false
    void drawLogo().then((uri) => {
      if (stale) return
      if (!uri) setStage('gone')
      else setLogo(uri)
    })
    // FAILSAFE: whatever happens (the shader stalling silently, processing
    // hanging), the black screen clears — the intro may fail, the site may not.
    const bail = window.setTimeout(() => setStage('gone'), FAILSAFE_MS)
    return () => {
      stale = true
      window.clearTimeout(bail)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Choreography, clocked from the shader's first PAINT (the probe fires when
  // the Suspense boundary resolves): fade the logo in → sweep → fade out.
  const onPainted = () => {
    setStage((s) => (s === 'boot' ? 'in' : s))
  }
  useEffect(() => {
    if (stage !== 'in') return
    const t1 = window.setTimeout(() => setStage('fade'), IN_MS + HOLD_MS)
    const t2 = window.setTimeout(() => setStage('gone'), IN_MS + HOLD_MS + FADE_MS)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [stage])

  if (stage === 'gone') return null
  return createPortal(
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-0 z-[100] bg-black transition-opacity ease-out ${
        stage === 'fade' ? 'opacity-0' : 'opacity-100'
      }`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      {logo && (
        <ShaderBoundary>
          <Suspense fallback={null}>
            {/* the logo itself fades IN over the black, then sweeps */}
            <div
              className={`h-full w-full transition-opacity ease-in ${stage === 'boot' ? 'opacity-0' : 'opacity-100'}`}
              style={{ transitionDuration: `${IN_MS}ms` }}
            >
              <Heatmap
                image={logo}
                suspendWhenProcessingImage
                colors={HEAT_COLORS}
                colorBack="#000000"
                contour={0.5}
                angle={0}
                noise={0}
                innerGlow={0.5}
                outerGlow={0.5}
                speed={1}
                scale={0.38}
                rotation={0}
                style={{ width: '100%', height: '100%' }}
              />
            </div>
            <ReadyProbe onReady={onPainted} />
          </Suspense>
        </ShaderBoundary>
      )}
    </div>,
    document.body,
  )
}
