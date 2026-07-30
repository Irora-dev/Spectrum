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
  league: boolean // /league (renders only when the chain has a leaguePool configured)
  bundle: boolean // /bundle (cross-chain BUNDLES: several baskets, one allocation)
  claim: boolean // /claim (PRISM v2 community-airdrop claim tool, Ethereum mainnet) + its banner
  integrate: boolean // /integrate
  docs: boolean // /docs + /docs/valuation + /faq + /learn
}

export type PageKey = keyof PageToggles

/** Runtime list of the toggleable pages (order = how the setup studio lists them). */
// Cross-chain bundles were hidden 2026-07-09 and REVIVED 2026-07-29 (owner) under the
// portfolio-plus-completion framing: a bundle is ONE ALLOCATION made of several
// single-chain basket tokens the buyer holds themselves. Never "one token".
export const PAGE_KEYS: PageKey[] = [
  'discover', 'launch', 'trade', 'fees', 'portfolio', 'creators', 'refer', 'league', 'bundle', 'claim', 'integrate', 'docs',
]

export interface BrandConfig {
  /** Text wordmark. "Spectrum" is the recommended default (owner 2026-07-29) —
   *  a site on this kit is an interface to the Spectrum protocol. */
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
  /** Tokenized-stock surfaces (default ON; owner 2026-07-29): the launcher's
   *  stock shelf, the stocks+tokens banner on Robinhood Chain, stock badges.
   *  false hides every stock-specific SURFACE — it does not (cannot) block a
   *  pasted stock address; routability stays the chain's own truth. */
  stocks?: boolean
  /** First-visit viewing chain (must be a scaffolded chain id; ignored
   *  otherwise). Unset → the deployment book's default. A returning visitor's
   *  own persisted network choice always wins over this. */
  defaultChainId?: number
  /** The "Powered by Prism" ecosystem banner (default ON; owner 2026-07-30) —
   *  a small pill on Home / basket / swap / fees linking out to Prism Beat.
   *  It is an OUTBOUND third-party link on the operator's own site, so it has
   *  to be droppable: `false` removes every instance. The protocol's PRISM
   *  buy-and-burn leg is unaffected either way (it is contract-side). */
  prismCredit?: boolean
  /** Curated launch STARTER suggestions (default ON; owner 2026-07-30): the
   *  per-chain seed set the builder/composer shelves fall back to before a
   *  chain has organic basket data (see lib/chain/starter-suggestions.ts).
   *  These are THIRD-PARTY token addresses surfaced as suggestions on the
   *  operator's site, so `false` drops them and leaves the shelf purely
   *  organic (most-used constituents of live baskets, ranked by live market
   *  data). Stock entries additionally respect `stocks`. */
  starterTokens?: boolean
}

/** Default-on: a page shows unless it is explicitly turned off. */
export function pageEnabled(pages: Partial<PageToggles> | undefined, key: PageKey): boolean {
  return pages?.[key] !== false
}

/** Stock surfaces: default-ON unless `stocks: false`. */
export function stocksEnabled(config: Pick<BrandConfig, 'stocks'>): boolean {
  return config.stocks !== false
}

/** The Prism ecosystem credit banner: default-ON unless `prismCredit: false`. */
export function prismCreditEnabled(config: Pick<BrandConfig, 'prismCredit'>): boolean {
  return config.prismCredit !== false
}

/** Curated launch starter suggestions: default-ON unless `starterTokens: false`. */
export function starterTokensEnabled(config: Pick<BrandConfig, 'starterTokens'>): boolean {
  return config.starterTokens !== false
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

/** Name check: non-empty and within the wordmark's length budget.
 *
 *  The "may not contain Spectrum" rejection was REMOVED (owner 2026-07-29:
 *  "if someone launches I'd like it to be called Spectrum, in fact it should be
 *  the default recommendation"). Spectrum is the PROTOCOL; a site built on this
 *  kit is an interface to it, and naming the interface after the protocol is the
 *  owner's intended posture — the same way many interfaces to one protocol share
 *  its name. The footer attribution (ATTRIBUTION_TEXT) and the operator's public
 *  fee wallet remain the honest signals of who runs a given deployment. */
export function validateSiteName(name: string): { ok: boolean; error?: string } {
  const n = (name || '').trim()
  if (!n) return { ok: false, error: 'Site name is required' }
  if (n.length > MAX_SITE_NAME)
    return { ok: false, error: `Site name must be ${MAX_SITE_NAME} characters or fewer` }
  return { ok: true }
}
