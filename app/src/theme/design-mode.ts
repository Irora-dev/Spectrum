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

/** THE PLANE A VISITOR LANDS ON (owner 2026-08-21: "light mode should be
 *  default"). Only an untouched toggle reads this — a viewer who has chosen is
 *  obeyed in both directions, which is why the choice is now stored EXPLICITLY
 *  either way. The toggle's other end stays the operator's own brand.config
 *  style, so pressing it still reaches the design the operator shipped.
 *
 *  ⚠ THE ONE CONSTANT AN OPERATOR FLIPS. Self-hosting a dark brand and want it
 *  to greet visitors? Set this to 'default' and brand.config governs again. */
const DEFAULT_MODE: ViewerDesignMode = 'enterprise'

/** What the viewer CHOSE, or null when they have never touched the toggle —
 *  the distinction DEFAULT_MODE needs and a plain mode getter cannot make. */
function storedMode(): ViewerDesignMode | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'enterprise' || v === 'default' ? v : null
  } catch {
    return null
  }
}

export function viewerDesignMode(): ViewerDesignMode {
  return storedMode() ?? DEFAULT_MODE
}

/** The brand as this viewer's mode wants it rendered. Pure. */
export function brandForMode(brand: BrandConfig, mode: ViewerDesignMode): BrandConfig {
  return mode === 'enterprise' ? { ...brand, style: 'enterprise' } : brand
}

/** Persist + apply in one act — the toggle's whole job. */
export function setViewerDesignMode(mode: ViewerDesignMode, brand: BrandConfig): void {
  try {
    // BOTH ENDS ARE STORED. 'default' used to clear the key, which was fine
    // while absent meant default — now that absent means DEFAULT_MODE, clearing
    // would throw the viewer's choice away on their next visit.
    localStorage.setItem(KEY, mode)
  } catch {
    /* storage unavailable — the mode still applies for this page's life */
  }
  applyBrand(brandForMode(brand, mode))
}

/** Boot hook: settle the mode before first meaningful paint. Called from
 *  main.tsx right after the brand (and any setup draft) applies, with the SAME
 *  brand object, so the mode always re-skins what the visitor would otherwise
 *  see — never a stale copy of it. It runs before createRoot().render(), which
 *  is what keeps DEFAULT_MODE from costing a flash of the other plane. */
export function initViewerDesignMode(brand: BrandConfig, opts?: { honourBrandStyle?: boolean }): void {
  // A SETUP DRAFT OUTRANKS THE DEFAULT. The studio's one job is showing an
  // operator the design they are building, and DEFAULT_MODE would re-skin their
  // draft to the light plane on every reload — the tool would be lying about
  // its own output. An explicit viewer choice still wins, because they asked.
  const mode = storedMode() ?? (opts?.honourBrandStyle ? 'default' : DEFAULT_MODE)
  if (mode !== 'default') applyBrand(brandForMode(brand, mode))
}
