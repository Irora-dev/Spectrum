import { SUPPORTED_CHAIN_IDS, chainCfg } from '../chain/chains'
import { stocksForChain } from '../chain/stocks'

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY PILLS (owner 2026-08-02 23:09): "there's Base, Robinhood, Ethereum,
// and then also DeFi, AI, stocks — just a couple of pills, the big ones. When
// you click it, it keeps the matching ones alight and darkens the ones that
// aren't, like a light bulb goes off; click it off and they come back."
//
// Two kinds of category, two grades of truth:
//   · CHAIN pills are chain truth — an asset's chainId is a fact.
//   · THEME pills (DeFi / AI / Memes / Stocks) are a browsing aid riding the
//     same tag lens the create flow's picker uses (single source, moved here
//     from PortfolioFlow). An untagged asset simply never lights for a theme —
//     a label we don't know is never guessed. Stocks are the exception with
//     real registry truth behind them: the official stock listing.
//
// A pill only exists when it matches something on the surface it filters —
// a control with nothing to say is noise (his board-on-change rule).
// ─────────────────────────────────────────────────────────────────────────────

export type AssetTheme = 'defi' | 'ai' | 'memes' | 'stocks'

/** Theme lens — the create flow's picker tags, single-sourced here. A tag is
 *  a browsing aid, never chain truth. */
export const ASSET_THEMES: Record<string, AssetTheme> = {
  AAVE: 'defi',
  SYRUP: 'defi',
  UNI: 'defi',
  cbBTC: 'defi',
  NVDA: 'stocks',
  AAPL: 'stocks',
  PONS: 'memes',
  BANKR: 'ai',
  VIRTUAL: 'ai',
}

const THEME_LABELS: Record<AssetTheme, string> = {
  defi: 'DeFi',
  ai: 'AI',
  memes: 'Memes',
  stocks: 'Stocks',
}

/** Symbols the official stock registry lists (registry truth, not a tag). */
const stockSymbols: Set<string> = new Set(
  SUPPORTED_CHAIN_IDS.flatMap((id) => stocksForChain(id).map((s) => s.symbol.toUpperCase())),
)

export function themeOf(symbol: string): AssetTheme | null {
  const sym = symbol.toUpperCase()
  if (stockSymbols.has(sym)) return 'stocks'
  const tagged = Object.entries(ASSET_THEMES).find(([k]) => k.toUpperCase() === sym)
  return tagged ? tagged[1] : null
}

export interface CategoryPill {
  id: string
  label: string
  /** Set on chain pills — the pill renders the chain's house identity
   *  (dot + short code) instead of the full name, so the row stays one line. */
  chainId?: number
  matches: (a: { chainId: number; symbol: string }) => boolean
}

/** The pills for a surface, built from what that surface actually shows —
 *  chains first (in supported order), then themes; only pills that match at
 *  least one of the given assets exist at all. */
export function categoryPills(assets: { chainId: number; symbol: string }[]): CategoryPill[] {
  const chains: CategoryPill[] = SUPPORTED_CHAIN_IDS.map((id) => {
    let label = String(id)
    try {
      label = chainCfg(id).name
    } catch {
      /* an unknown chain still pills, under its id */
    }
    return { id: `chain:${id}`, label, chainId: id, matches: (a: { chainId: number; symbol: string }) => a.chainId === id }
  })
  const themes: CategoryPill[] = (Object.keys(THEME_LABELS) as AssetTheme[]).map((t) => ({
    id: `theme:${t}`,
    label: THEME_LABELS[t],
    matches: (a: { chainId: number; symbol: string }) => themeOf(a.symbol) === t,
  }))
  return [...chains, ...themes].filter((p) => assets.some((a) => p.matches(a)))
}
