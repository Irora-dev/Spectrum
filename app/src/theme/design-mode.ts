// ─────────────────────────────────────────────────────────────────────────────
// THE VIEWER DESIGN MODE — a runtime, per-browser design switch (owner
// 2026-08-17: "build the switcher system, little toggle on menu, and ensure it
// works not just for colour but total design changes").
//
// It deliberately owns NO theming machinery of its own: it re-applies the
// operator's brand through applyBrand with the style swapped, which is the one
// seam that already changes EVERYTHING per style — colour tokens, structural
// vars (--st-* card/field/radii), fonts, `color-scheme`, the `data-style`
// attribute components and CSS branch on, and the brandchange event the WebGL
// surfaces re-read. A mode here is therefore as sweeping as a style is; the
// enterprise style carries its own structure, not a recolour.
//
// The operator's gradient/accent palette rides along unchanged (their brand is
// their brand in both modes); everything the PRESET owns — surfaces, ink,
// structure, scheme, type — swaps whole.
// ─────────────────────────────────────────────────────────────────────────────
import type { BrandConfig } from './brand'
import { applyBrand } from './theme'

export type ViewerDesignMode = 'default' | 'enterprise'

const KEY = 'spectrum:design-mode'

export function viewerDesignMode(): ViewerDesignMode {
  try {
    return localStorage.getItem(KEY) === 'enterprise' ? 'enterprise' : 'default'
  } catch {
    return 'default'
  }
}

/** The brand as this viewer's mode wants it rendered. Pure. */
export function brandForMode(brand: BrandConfig, mode: ViewerDesignMode): BrandConfig {
  return mode === 'enterprise' ? { ...brand, style: 'enterprise' } : brand
}

/** Persist + apply in one act — the toggle's whole job. */
export function setViewerDesignMode(mode: ViewerDesignMode, brand: BrandConfig): void {
  try {
    if (mode === 'default') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, mode)
  } catch {
    /* storage unavailable — the mode still applies for this page's life */
  }
  applyBrand(brandForMode(brand, mode))
}

/** Boot hook: honour a stored mode before first meaningful paint. Called from
 *  main.tsx right after the brand (and any setup draft) applies, with the SAME
 *  brand object, so the mode always re-skins what the visitor would otherwise
 *  see — never a stale copy of it. */
export function initViewerDesignMode(brand: BrandConfig): void {
  const mode = viewerDesignMode()
  if (mode !== 'default') applyBrand(brandForMode(brand, mode))
}
