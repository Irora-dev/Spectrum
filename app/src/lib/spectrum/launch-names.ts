import { themeOf, type AssetTheme } from './asset-categories'

// ─────────────────────────────────────────────────────────────────────────────
// NAME SUGGESTIONS (the owner 2026-08-13, in the greenlit list: "name suggestions
// from the picked assets' sectors — editable, never enforced").
//
// EDITABLE, NEVER ENFORCED is the whole design. These are chips a creator can
// tap to fill the field; nothing here validates, blocks, or rewrites what they
// type. A creator who ignores every suggestion must meet no friction at all.
//
// The sector lens is the create flow's own (asset-categories' themeOf) — the
// same tags the picker's category pills light up on, so a suggestion can never
// name a sector the picker would not agree the basket is in. An UNTAGGED asset
// contributes nothing: a theme we do not know is never guessed, which is why a
// pick of three unknown tokens gets ticker-shaped suggestions instead of a
// confidently wrong sector.
//
// "Basket", never "index" — the house word (the copy screen auto-fixes
// index→basket everywhere, and a suggestion box handing out the wrong one
// would be seeding the exact thing that gets corrected downstream).
// ─────────────────────────────────────────────────────────────────────────────

const THEME_WORD: Record<AssetTheme, string> = {
  defi: 'DeFi',
  ai: 'AI',
  memes: 'Memes',
  stocks: 'Stocks',
}

/** Small counting words — "Core Three" reads like a name, "Core 3" does not. */
const COUNT_WORD = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

/** How long a suggested name may get. Well inside showName's 48-char bound, so
 *  a suggestion is never offered in a form the UI would have to clip. */
export const MAX_SUGGESTED_NAME = 32

/** The dominant tagged theme among the picks, or null when too few of them are
 *  tagged to say anything. "Dominant" needs a real plurality — one tagged asset
 *  out of six does not make a DeFi basket. */
export function dominantTheme(symbols: readonly string[]): AssetTheme | null {
  const counts = new Map<AssetTheme, number>()
  for (const s of symbols) {
    const t = themeOf(s)
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const [theme, n] = ranked[0]
  // Half the picks, and at least two — anything looser names the basket after
  // its smallest constituent group.
  return n >= 2 && n * 2 >= symbols.length ? theme : null
}

/**
 * A handful of name suggestions for these picks, best first. Never empty for a
 * non-empty pick, never longer than MAX_SUGGESTED_NAME, never duplicated.
 */
export function suggestNames(symbols: readonly string[]): string[] {
  const picks = symbols.map((s) => String(s ?? '').trim()).filter((s) => s.length > 0)
  if (picks.length === 0) return []
  const n = picks.length
  const count = COUNT_WORD[n] ?? null
  const theme = dominantTheme(picks)
  const out: string[] = []

  if (theme) {
    const word = THEME_WORD[theme]
    if (count) out.push(`${word} ${count}`)
    out.push(`${word} Basket`)
    out.push(`The ${word} Mix`)
  }
  if (n === 1) {
    out.push(`${picks[0]} Basket`)
  } else if (n === 2) {
    out.push(`${picks[0]} & ${picks[1]}`)
  } else {
    out.push(`${picks[0]} & Friends`)
    if (count) out.push(`Core ${count}`)
  }
  out.push(picks.slice(0, 3).join('-'))

  const seen = new Set<string>()
  return out
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_SUGGESTED_NAME)
    .filter((s) => {
      const k = s.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, 5)
}

/** A ticker suggestion to sit beside a chosen name. Letters only, ≤ 8 — the
 *  shape a token symbol takes. null when the name yields nothing usable, so
 *  the field is left alone rather than filled with junk. */
export function suggestTicker(name: string): string | null {
  const words = String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && w !== 'THE' && w !== 'AND')
  if (words.length === 0) return null
  const acronym = words.map((w) => w[0]).join('')
  const pick = words.length >= 2 && acronym.length >= 2 ? acronym : words[0]
  const cleaned = pick.replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return cleaned.length >= 2 ? cleaned : null
}
