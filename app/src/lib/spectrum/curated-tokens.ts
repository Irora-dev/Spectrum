import { verifiedTokens } from './token-list'

// Curated STARTING POINTS for the Composer (owner 2026-07-07): neutral themed
// sets a creator can start a mix from, NOT recommendations to buy. Each set is a
// list of SYMBOLS; the actual token is resolved against the chain's verified
// token list at apply time (token-list.ts), so the address is always canonical
// and only tokens genuinely listed on the ACTIVE chain get added — a symbol that
// isn't listed there is simply skipped, never guessed.
export interface CuratedSet {
  id: string
  label: string
  blurb: string
  symbols: string[]
}

export const COMPOSER_TEMPLATES: CuratedSet[] = [
  {
    id: 'defi',
    label: 'DeFi blue chips',
    blurb: 'Majors of on-chain finance',
    symbols: ['UNI', 'AAVE', 'LINK', 'LDO', 'MKR', 'CRV'],
  },
  {
    id: 'ai',
    label: 'AI & agents',
    blurb: 'AI-themed tokens',
    symbols: ['VIRTUAL', 'AIXBT', 'FET', 'RENDER', 'TAO', 'AI16Z'],
  },
  {
    id: 'base',
    label: 'Base natives',
    blurb: 'Built on Base',
    symbols: ['AERO', 'DEGEN', 'BRETT', 'TOSHI', 'HIGHER', 'VIRTUAL'],
  },
  {
    id: 'memes',
    label: 'Memes',
    blurb: 'The culture coins',
    symbols: ['PEPE', 'SHIB', 'MOG', 'FLOKI', 'BRETT'],
  },
]

export interface CuratedToken {
  address: string
  symbol: string
}

/** Resolve a symbol list to canonical {address, symbol} on `chainId` via the
 *  verified token list. Only listed symbols come back; order follows the input.
 *  First listing per symbol wins (the verified list is collision-curated). */
export async function resolveCuratedSymbols(chainId: number, symbols: string[]): Promise<CuratedToken[]> {
  const list = await verifiedTokens(chainId)
  const bySym = new Map<string, CuratedToken>()
  for (const t of list) {
    const k = t.symbol.toUpperCase()
    if (!bySym.has(k)) bySym.set(k, { address: t.address, symbol: t.symbol })
  }
  const out: CuratedToken[] = []
  const seen = new Set<string>()
  for (const s of symbols) {
    const hit = bySym.get(s.toUpperCase())
    if (hit && !seen.has(hit.address.toLowerCase())) {
      seen.add(hit.address.toLowerCase())
      out.push(hit)
    }
  }
  return out
}
