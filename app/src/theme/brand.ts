// The kit's brand contract. An operator's chosen name + look lives in one
// `brand.config.ts`; this file is the type + the pure helpers around it. Shapes mirror
// `spectrum-mini/shared/brand.ts` so the two kits converge (the wizard writes this file).
//
// (Page toggles — which of the site's pages ship — are a separate concern added in the
// page-scope task; this file stays the look + identity contract.)

// Dark styles. `halation` (a LIGHT paper style from Mini) is deferred — the app is
// dark-built (color-scheme: dark), so light mode needs its own pass.
export type DesignStyle = 'spectral' | 'aurora' | 'prism' | 'umbra' | 'sylvan'

export interface BrandPalette {
  /** Gradient stops — drive the spectral optics tokens (amber / magenta / cyan). */
  gradientFrom: string
  gradientVia: string
  gradientTo: string
  /** Optional accent — overrides the preset's violet accent when set. */
  accent?: string
}

/**
 * Which pages an operator ships. Default-ON: omit a key (or set true) and it shows;
 * set false to drop its nav link + route. Superset of Mini's {launch,discover,trade};
 * the transactional ones also require their VITE_ENABLE_* build flag (this only hides,
 * it never arms a risk surface). Core pages (Home, token/creator detail, legal, embed)
 * are always on and have no toggle.
 */
export interface PageToggles {
  discover: boolean // /explore
  launch: boolean // /launch + /compose + /createbasket
  trade: boolean // /swap  (also needs VITE_ENABLE_SWAP)
  fees: boolean // /flush (also needs VITE_ENABLE_TRADING)
  portfolio: boolean // /portfolio (also needs VITE_ENABLE_WALLET)
  creators: boolean // /creators
  refer: boolean // /refer
  integrate: boolean // /integrate
  docs: boolean // /docs + /docs/valuation + /faq + /learn
}

export type PageKey = keyof PageToggles

/** Runtime list of the toggleable pages (order = how the setup studio lists them). */
// (Cross-chain bundles are HIDDEN for now — owner 2026-07-09: no route, no nav, not offered
// in setup. The code stays in the tree; re-add 'bundle' here + the Nav/App entries to revive.)
export const PAGE_KEYS: PageKey[] = [
  'discover', 'launch', 'trade', 'fees', 'portfolio', 'creators', 'refer', 'integrate', 'docs',
]

export interface BrandConfig {
  /** Text wordmark. MUST fail /spectrum/i (see validateSiteName) — no operator is "Spectrum". */
  name: string
  tagline?: string
  style: DesignStyle
  palette: BrandPalette
  /** Optional — omitted keys default ON. */
  pages?: Partial<PageToggles>
  /** The on-site /setup studio (the footer "Customize" page). Dev builds always serve it;
   *  on PRODUCTION builds it is default-ON — set false to lock a deployed site (drops the
   *  /setup route + the footer link). Visitors can never persist anything server-side
   *  either way (drafts are per-browser), so this is product posture, not security. */
  setupStudio?: boolean
}

/** Default-on: a page shows unless it is explicitly turned off. */
export function pageEnabled(pages: Partial<PageToggles> | undefined, key: PageKey): boolean {
  return pages?.[key] !== false
}

/** /setup availability: always served in dev; production default-ON unless `setupStudio: false`. */
export function setupStudioEnabled(config: Pick<BrandConfig, 'setupStudio'>): boolean {
  // Narrow probe instead of import.meta.env.DEV: this file is also loaded by vite.config
  // (the brandHtml plugin imports brand.config), where ImportMeta has no `env` typing.
  const env = (import.meta as { env?: { DEV?: boolean } }).env
  return env?.DEV === true || config.setupStudio !== false
}

/** The flat token record applyBrandVars writes onto :root — one field per `--*` var. */
export interface OperatorTheme {
  fontDisplay: string
  fontMono: string
  fontNum: string
  void: string
  panel: string
  panel2: string
  line: string
  lineBright: string
  ink: string
  inkDim: string
  inkFaint: string
  violet: string
  violetBright: string
  violetDeep: string
  alert: string
  teal: string
  cyan: string
  magenta: string
  amber: string
}

/** The house spectrum gradient (amber → magenta → cyan). Default palette for every style. */
export const SPECTRUM_DNA = {
  gradientFrom: '#ff9248',
  gradientVia: '#ff4db8',
  gradientTo: '#35e0ff',
} as const

export const MAX_SITE_NAME = 32

/** Required kit attribution shown in the footer of every generated site. */
export const ATTRIBUTION_TEXT = 'powered by Spectrum Mini'

/** Name guard — mirrors the Mini kit: non-empty, ≤32 chars, and never contains "Spectrum". */
export function validateSiteName(name: string): { ok: boolean; error?: string } {
  const n = (name || '').trim()
  if (!n) return { ok: false, error: 'Site name is required' }
  if (n.length > MAX_SITE_NAME)
    return { ok: false, error: `Site name must be ${MAX_SITE_NAME} characters or fewer` }
  if (/spectrum/i.test(n)) return { ok: false, error: 'Site name may not contain "Spectrum"' }
  return { ok: true }
}
