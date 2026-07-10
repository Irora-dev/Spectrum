import { useEffect, useRef } from 'react'
import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from 'three'
import { readBrandRgb } from '../theme/brand-colors'

// Tuned values (from the in-prototype OPTICS·TUNE panel). Edge-spectrum curtains
// on the left/right margins fading to pure black through the center.
const SETTINGS: Record<string, number> = {
  uIntensity: 1.6,
  uBandWidth: 0.27,
  uFlowAmount: 0.43,
  uFlowSpeed: 0.76,
  uTwinkle: 0.3,
  uUndulation: 0.36,
  uUndSpeed: 0.12,
  uBreathe: 0.05,
  uGrain: 0.145,
  uCore: 0,
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }
`

const fragmentShader = /* glsl */ `
  uniform float uTime, uIntensity, uBandWidth, uFlowAmount, uFlowSpeed, uTwinkle, uUndulation, uUndSpeed, uBreathe, uGrain, uCore, uEdgeScale;
  uniform vec3 uCyan, uMagenta, uAmber;
  varying vec2 vUv;
  float random(vec2 st){ return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123); }
  float noise(in vec2 st){
    vec2 i = floor(st); vec2 f = fract(st);
    float a = random(i); float b = random(i + vec2(1.0,0.0));
    float c = random(i + vec2(0.0,1.0)); float d = random(i + vec2(1.0,1.0));
    vec2 u = f*f*(3.0-2.0*f);
    return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
  }
  void main(){
    vec2 uv = vUv;
    // 0 at edges, 0.5 at center. Dividing by uEdgeScale (≤1) narrows every band
    // proportionally on small viewports — the curtains are authored in fractions
    // of screen width, which on phones would otherwise bury edge content.
    float edgeDist = min(uv.x, 1.0 - uv.x) / uEdgeScale;

    float core = 1.0 - smoothstep(0.0, 0.008, edgeDist);
    vec3 coreColor = vec3(1.0, 0.92, 0.96) * core * uCore;

    vec3 spectralColor = vec3(0.0);
    spectralColor += uCyan    * smoothstep(0.004, 0.030, edgeDist) * (1.0 - smoothstep(0.025, 0.070, edgeDist));
    spectralColor += uMagenta * smoothstep(0.015, 0.050, edgeDist) * (1.0 - smoothstep(0.045, 0.100, edgeDist));
    spectralColor += uAmber   * smoothstep(0.040, 0.080, edgeDist) * (1.0 - smoothstep(0.075, 0.130, edgeDist));

    float barcodeNoise = noise(vec2(uv.x * 200.0 + uTime * uTwinkle, uv.y * 0.6));
    spectralColor *= barcodeNoise * uIntensity;

    float flow = (1.0 - uFlowAmount) + uFlowAmount * sin(uv.y * 5.0 - uTime * uFlowSpeed);
    spectralColor *= flow;

    float aurora = (1.0 - uUndulation) + uUndulation * noise(vec2(uv.y * 2.0, uTime * uUndSpeed));
    spectralColor *= aurora;

    float breathe = (1.0 - uBreathe) + uBreathe * sin(uTime * 0.18);
    spectralColor *= breathe; coreColor *= breathe;

    float vertFade = 0.55 + 0.45 * sin(uv.y * 3.1415);
    spectralColor *= vertFade; coreColor *= vertFade;

    float edgeMask = 1.0 - smoothstep(uBandWidth * 0.4, uBandWidth, edgeDist);
    vec3 bgColor = vec3(0.086, 0.070, 0.141) * edgeMask * 0.7;
    vec3 finalColor = bgColor + (coreColor + spectralColor) * edgeMask;

    float grain = random(uv + vec2(uTime * 0.08, uTime * 0.08));
    finalColor -= grain * uGrain * edgeMask;
    finalColor += grain * 0.04 * spectralColor;
    finalColor += grain * 0.012;

    gl_FragColor = vec4(finalColor, 1.0);
  }
`

/**
 * Full-viewport animated optics-lab background. Renders behind all content
 * (fixed, -z-10, non-interactive). Honors prefers-reduced-motion by holding a
 * still frame. To re-tune, use the dev-only sandbox at /proto/bg.html (lives in
 * app/proto/, served by the vite dev server, deliberately NOT in public/ so it
 * never ships in an operator's build).
 */
export function SpectrumBackground() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = ref.current
    if (!container) return

    const scene = new Scene()
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const renderer = new WebGLRenderer({ alpha: true, antialias: false })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.domElement.style.display = 'block'
    container.appendChild(renderer.domElement)

    const uniforms: Record<string, { value: number | Vector3 }> = { uTime: { value: 0 } }
    for (const [k, v] of Object.entries(SETTINGS)) uniforms[k] = { value: v }
    // The three edge bands adopt the operator's brand gradient (read off the resolved
    // CSS vars applyBrandVars set at startup); fall back to the reference spectral floats.
    const band = (v: string, fb: [number, number, number]) => new Vector3(...(readBrandRgb(v) ?? fb))
    uniforms.uCyan = { value: band('--color-cyan', [0.0, 0.94, 1.0]) }
    uniforms.uMagenta = { value: band('--color-magenta', [1.0, 0.0, 0.7]) }
    uniforms.uAmber = { value: band('--color-amber', [1.0, 0.5, 0.0]) }
    // Band widths are fractions of viewport width; ≥1024px renders unchanged
    // (scale 1), below that the curtains narrow so 16px content padding clears
    // the bright bands (floor 0.4 ≈ 19px reach at 375px wide).
    const edgeScaleFor = (w: number) => Math.min(1, Math.max(0.4, w / 1024))
    uniforms.uEdgeScale = { value: edgeScaleFor(window.innerWidth) }

    const material = new ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      depthWrite: false,
      depthTest: false,
    })
    const mesh = new Mesh(new PlaneGeometry(2, 2), material)
    scene.add(mesh)

    // Dev-only handle (debugging / future in-app tune panel).
    if (import.meta.env.DEV) {
      ;(globalThis as Record<string, unknown>).__spectrumBg = { uniforms, renderer, scene, camera }
    }

    const onResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight)
      uniforms.uEdgeScale.value = edgeScaleFor(window.innerWidth)
    }
    window.addEventListener('resize', onResize)

    // The setup studio re-skins live via applyBrand → CSS vars; uniforms hold RESOLVED
    // colors, so re-read the three bands whenever the brand changes (the same fallbacks
    // keep the reference spectral look when a var is unset).
    const onBrandChange = () => {
      uniforms.uCyan.value = band('--color-cyan', [0.0, 0.94, 1.0])
      uniforms.uMagenta.value = band('--color-magenta', [1.0, 0.0, 0.7])
      uniforms.uAmber.value = band('--color-amber', [1.0, 0.5, 0.0])
    }
    window.addEventListener('spectrum:brandchange', onBrandChange)

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const start = performance.now()
    let raf = 0
    const loop = () => {
      uniforms.uTime.value = reduceMotion ? 0 : (performance.now() - start) / 1000
      renderer.render(scene, camera)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('spectrum:brandchange', onBrandChange)
      mesh.geometry.dispose()
      material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
      if (import.meta.env.DEV) delete (globalThis as Record<string, unknown>).__spectrumBg
    }
  }, [])

  // `spectrum-webgl-bg` lets a design style drop this animated spectral backdrop entirely
  // (index.css [data-style] rules) — solid/editorial styles use a flat canvas instead.
  return <div ref={ref} aria-hidden className="spectrum-webgl-bg pointer-events-none fixed inset-0 -z-10" />
}
