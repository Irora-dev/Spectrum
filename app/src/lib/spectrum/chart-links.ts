import { chainCfg } from '../chain/chains'
import { brand } from '../../brand.config'
import dexscreenerMark from '../../assets/chartlink-dexscreener.png'

// ─────────────────────────────────────────────────────────────────────────────
// Outbound chart links (R/C daily 2026-08-02, the owner-signed: "a button to go to
// DexScreener and to go to Defined… this should be seen as the hub"). Pure
// helpers; the icons are the brands' REAL marks (their favicons, vendored —
// a wrong-looking logo reads as phishing on a crypto site, PM rule).
//
// Operator gate: third-party outbound links on an operator's site follow the
// prismCredit idiom — default-ON, `chartLinks: false` hides them. The key is
// typed on BrandConfig (theme/brand.ts).
//
// DEXSCREENER ONLY (the owner, 2026-08-02: "we can disable defined and just keep
// dexscreener" — settled after their WAF 403'd every probe I have and the
// shipped link landed nowhere). Its token page is the universally-used
// /{slug}/{address}; a chain with no slug (4663) simply gets no link, never a
// dead one.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChartLink {
  key: 'dexscreener'
  label: string
  href: string
  /** Vendored brand mark (data URL via the bundler). */
  mark: string
}

export function chartLinksEnabled(): boolean {
  return brand.chartLinks !== false
}


export function chartLinksFor(chainId: number, address: string): ChartLink[] {
  if (!chartLinksEnabled()) return []
  const out: ChartLink[] = []
  let slug = ''
  try {
    slug = chainCfg(chainId).dexscreenerSlug
  } catch {
    slug = ''
  }
  if (slug) {
    out.push({
      key: 'dexscreener',
      label: 'Open on DexScreener',
      href: `https://dexscreener.com/${slug}/${address}`,
      mark: dexscreenerMark,
    })
  }
  return out
}
