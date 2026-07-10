import type { DesignStyle } from './brand'

// The NON-colour half of a design style — surface treatment, RADII, and the full TYPE
// system — so a style reads DRASTICALLY different, not just recoloured. Emitted as `--st-*`
// + the Tailwind `--radius-*` scale (so every rounded-* reshapes) + `--font-*` (display/num/
// mono/body), applied at the app root by applyBrand(). spectral = the exact current look, so
// the default build is byte-identical; switching style transforms surface + shape + type.

export interface StyleRadii {
  md: string
  lg: string
  xl: string
  '2xl': string
  '3xl': string
}
export interface StyleStructure {
  cardBg: string
  cardBorder: string
  cardShadow: string
  cardBlur: string
  fieldBg: string
  fieldBorder: string
  /** Overrides the Tailwind radius scale → every rounded-{md,lg,xl,2xl,3xl} shifts. */
  radii: StyleRadii
  scheme: 'light' | 'dark'
  fonts?: { display?: string; numeric?: string; mono?: string; body?: string }
}

const CHAKRA = '"Chakra Petch", ui-sans-serif, system-ui, sans-serif'
const JETBRAINS = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const SPACE_GROTESK = '"Space Grotesk", ui-sans-serif, system-ui, sans-serif'
const INTER = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif"
const NEWSREADER = "'Newsreader', Georgia, 'Times New Roman', serif"

// Emitted for every style so switching AWAY from a custom-font/-radius style restores these
// (an inline override wouldn't otherwise clear). display/num/mono/body mirror index.css; the
// radii mirror Tailwind v4's defaults.
const DEFAULT_FONTS = { display: CHAKRA, numeric: SPACE_GROTESK, mono: JETBRAINS, body: JETBRAINS }
const DEFAULT_RADII: StyleRadii = { md: '0.375rem', lg: '0.5rem', xl: '0.75rem', '2xl': '1rem', '3xl': '1.5rem' }

const GLASS: StyleStructure = {
  cardBg: 'color-mix(in srgb, var(--color-ink) 4%, transparent)',
  cardBorder: '1px solid color-mix(in srgb, var(--color-ink) 12%, transparent)',
  cardShadow: 'inset 0 1px 0 0 color-mix(in srgb, var(--color-ink) 6%, transparent)',
  cardBlur: 'blur(12px)',
  fieldBg: 'color-mix(in srgb, var(--color-void) 40%, transparent)',
  fieldBorder: '1px solid color-mix(in srgb, var(--color-ink) 12%, transparent)',
  radii: DEFAULT_RADII,
  scheme: 'dark',
}

export const STRUCTURE_PRESETS: Record<DesignStyle, StyleStructure> = {
  // EXACT current values — the default build must not drift (radii = Tailwind defaults,
  // fonts = the app defaults, card = the reference glass).
  spectral: {
    cardBg: 'rgba(23, 23, 32, 0.78)',
    cardBorder: '1px solid rgba(255, 255, 255, 0.1)',
    cardShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
    cardBlur: 'blur(12px)',
    fieldBg: 'color-mix(in srgb, var(--color-void) 40%, transparent)',
    fieldBorder: '1px solid color-mix(in srgb, var(--color-ink) 12%, transparent)',
    radii: DEFAULT_RADII,
    scheme: 'dark',
  },
  prism: GLASS,
  aurora: GLASS,
  // Solid opaque card, heavy drop shadow, no blur, ROUND corners (bumped scale), clean sans
  // everywhere — the "Apple fintech" voice.
  umbra: {
    cardBg: 'var(--color-panel)',
    cardBorder: 'none',
    cardShadow: '0 20px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 0 color-mix(in srgb, var(--color-ink) 8%, transparent)',
    cardBlur: 'none',
    fieldBg: 'color-mix(in srgb, var(--color-void) 82%, #000)',
    fieldBorder: '1px solid color-mix(in srgb, var(--color-ink) 6%, transparent)',
    radii: { md: '8px', lg: '12px', xl: '16px', '2xl': '20px', '3xl': '28px' },
    scheme: 'dark',
    fonts: { display: INTER, numeric: INTER, body: INTER },
  },
  // Dark editorial — solid organic cards, hairline border, no blur, SHARP corners (2–4px,
  // like the Lumen reference), a SERIF display (Newsreader) over a sans body. Reads nothing
  // like the technical glass styles.
  sylvan: {
    cardBg: 'var(--color-panel)',
    cardBorder: '1px solid color-mix(in srgb, var(--color-ink) 8%, transparent)',
    cardShadow: 'none',
    cardBlur: 'none',
    fieldBg: 'var(--color-void)',
    fieldBorder: '1px solid color-mix(in srgb, var(--color-ink) 14%, transparent)',
    radii: { md: '2px', lg: '3px', xl: '4px', '2xl': '5px', '3xl': '8px' },
    scheme: 'dark',
    fonts: { display: NEWSREADER, numeric: SPACE_GROTESK, body: INTER },
  },
}

/** Project a style onto `--st-*` + the Tailwind `--radius-*` scale + `--font-*`. Total — an
 *  unknown style falls back to the glass structure. */
export function structureToCssVars(style: DesignStyle): Record<string, string> {
  const s = STRUCTURE_PRESETS[style] ?? GLASS
  return {
    '--st-card-bg': s.cardBg,
    '--st-card-border': s.cardBorder,
    '--st-card-shadow': s.cardShadow,
    '--st-card-blur': s.cardBlur,
    '--st-field-bg': s.fieldBg,
    '--st-field-border': s.fieldBorder,
    '--radius-md': s.radii.md,
    '--radius-lg': s.radii.lg,
    '--radius-xl': s.radii.xl,
    '--radius-2xl': s.radii['2xl'],
    '--radius-3xl': s.radii['3xl'],
    '--font-display': s.fonts?.display ?? DEFAULT_FONTS.display,
    '--font-num': s.fonts?.numeric ?? DEFAULT_FONTS.numeric,
    '--font-mono': s.fonts?.mono ?? DEFAULT_FONTS.mono,
    '--font-body': s.fonts?.body ?? DEFAULT_FONTS.body,
  }
}
