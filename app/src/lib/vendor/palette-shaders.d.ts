// Hand-written declarations for the vendored palette-shaders bundle
// (dist/palette-shaders.js, palette-shaders v0.3.0) — only the
// surface this app uses. The bundle inlines @paper-design/shaders (PolyForm
// Shield 1.0.0 — see PALETTE-SHADERS-THIRD-PARTY-LICENSES.md alongside).

export interface PaletteShaderInstance {
  /** Resolves once the first mount (and `from` palette, if given) is applied. */
  ready: Promise<void>
  /** Current palette as hex strings, dominant first. */
  readonly palette: string[]
  setPalette(hexes: string[], opts?: { animate?: boolean; duration?: number }): Promise<void>
  setPaletteFrom(source: unknown, opts?: { animate?: boolean }): Promise<string[]>
  setSeed(seed: string): Promise<void>
  setSpeed(mult: number): void
  dispose(): void
}

export function paletteShader(opts: {
  target: string | HTMLElement
  from?: unknown
  colors?: string[]
  shader?: 'mesh' | 'staticMesh' | 'grain' | 'warp' | 'metaballs' | 'dots' | 'smoke' | 'border' | 'heatmap'
  seed?: string | null
  image?: string | HTMLImageElement
  speed?: number
  drift?: boolean
  pointer?: boolean
  pointerScope?: 'window'
  animate?: boolean
  duration?: number
  minPixelRatio?: number
  maxPixelCount?: number
}): PaletteShaderInstance
