// The theming bridge: BrandConfig → OperatorTheme → the CSS custom properties the whole
// app already reads (index.css @theme tokens + Tailwind utilities like text-cyan/bg-void).
// Overriding the vars on :root at startup re-skins every token consumer at once.

import type { BrandConfig, OperatorTheme } from './brand'
import { STYLE_PRESETS } from './presets'
import { structureToCssVars } from './structure'

/** OperatorTheme field → the CSS variable it drives. Exhaustive over OperatorTheme. */
const VAR_MAP: Record<keyof OperatorTheme, string> = {
  fontDisplay: '--font-display',
  fontMono: '--font-mono',
  fontNum: '--font-num',
  void: '--color-void',
  panel: '--color-panel',
  panel2: '--color-panel-2',
  line: '--color-line',
  lineBright: '--color-line-bright',
  ink: '--color-ink',
  inkDim: '--color-ink-dim',
  inkFaint: '--color-ink-faint',
  violet: '--color-violet',
  violetBright: '--color-violet-bright',
  violetDeep: '--color-violet-deep',
  alert: '--color-alert',
  teal: '--color-teal',
  cyan: '--color-cyan',
  magenta: '--color-magenta',
  amber: '--color-amber',
}

/** Pure: pick the style preset, overlay the operator's gradient + optional accent. */
export function operatorBrandToTheme(brand: BrandConfig): OperatorTheme {
  const preset = STYLE_PRESETS[brand.style] ?? STYLE_PRESETS.spectral
  const p = brand.palette
  return {
    ...preset,
    amber: p.gradientFrom || preset.amber,
    magenta: p.gradientVia || preset.magenta,
    cyan: p.gradientTo || preset.cyan,
    violet: p.accent || preset.violet,
  }
}

/** Write the theme onto the root element's inline style (wins over the @theme defaults). */
export function applyBrandVars(
  theme: OperatorTheme,
  el: HTMLElement = document.documentElement,
): void {
  ;(Object.keys(VAR_MAP) as (keyof OperatorTheme)[]).forEach((k) => {
    el.style.setProperty(VAR_MAP[k], theme[k])
  })
}

/**
 * Apply a brand end-to-end: the colour tokens (operatorBrandToTheme → applyBrandVars) PLUS
 * the style's structural treatment (structureToCssVars → --st-* + per-style fonts) + a
 * `data-style` attribute. This is what makes switching style change the whole site — surface
 * treatment, depth, and type, not just colour. Use everywhere instead of applyBrandVars alone.
 */
export function applyBrand(brand: BrandConfig, el: HTMLElement = document.documentElement): void {
  applyBrandVars(operatorBrandToTheme(brand), el)
  const sv = structureToCssVars(brand.style)
  Object.keys(sv).forEach((k) => el.style.setProperty(k, sv[k]))
  el.setAttribute('data-style', brand.style)
  // CSS consumers of the vars retint by themselves; canvas/WebGL surfaces (the ambient
  // SpectrumBackground bands) cache resolved colors and need a poke to re-read them —
  // this is what makes the setup studio's live gradient picking reach the side glow.
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('spectrum:brandchange'))
}

export { VAR_MAP }
