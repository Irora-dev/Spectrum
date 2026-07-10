// ─────────────────────────────────────────────────────────────────────────────
// Natural-language search for Explore (owner ask 2026-07-06): typing
// "i'm interested in agents" should FIND agent baskets, not string-match the
// whole sentence against names. Conversational filler drops out, the remaining
// terms match plural-leniently with AND semantics across ticker/name/address/
// tags. Plain string logic, deterministic, no NLP dependency.
// ─────────────────────────────────────────────────────────────────────────────

// Filler that carries no search intent — including contraction fragments
// ("i'm" splits to i + m) and the domain's own generic nouns.
const STOPWORDS = new Set([
  'i', 'im', 'am', 'me', 'my', 'we', 'you', 'u', 'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'in', 'on', 'of', 'to', 'for', 'with', 'and', 'or', 'is', 'are', 'it', 'its', 'at', 'by', 'about',
  'show', 'find', 'give', 'get', 'want', 'wanna', 'like', 'love', 'need', 'looking', 'look',
  'interested', 'search', 'searching', 'see', 'browse', 'explore',
  'all', 'any', 'some', 'something', 'anything', 'everything',
  'what', 'whats', 'which', 'who', 'whos', 'where', 'best', 'top', 'good', 'great', 'nice',
  'basket', 'baskets', 'token', 'tokens', 'index', 'indexes', 'indices', 'coin', 'coins',
  'please', 'hey', 'ok', 'okay', 'just', 'really', 'very',
  // contraction fragments left by the splitter (i'm / what's / they're / i'll…)
  'm', 's', 't', 'd', 're', 've', 'll',
])

/** Naive singular fold: "agents" ≈ "agent". Leaves short words and -ss alone. */
export function foldPlural(w: string): string {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w
}

/** The meaning-bearing terms of a free-text query, singular-folded. When every
 *  word was filler (someone literally searched "baskets"), the raw words come
 *  back instead so the search still does something. */
export function parseQueryTerms(q: string): string[] {
  const words = q
    .toLowerCase()
    .split(/[^a-z0-9$#.]+/)
    .map((w) => w.replace(/^[#$]+/, ''))
    .filter(Boolean)
  const terms = words.filter((w) => !STOPWORDS.has(w))
  return (terms.length ? terms : words).map(foldPlural)
}

/** True when EVERY term appears in the haystack (AND), plural-lenient on both
 *  sides. Empty terms = no filter. */
export function matchesTerms(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) return true
  const hay = haystack.toLowerCase()
  const folded = hay
    .split(/[^a-z0-9$#.]+/)
    .map(foldPlural)
    .join(' ')
  return terms.every((t) => hay.includes(t) || folded.includes(t))
}

/** Does the query name this tag? (For flagging the matching chips under the
 *  search bar.) Compared compact so "agents" hits "AI Agents". */
export function termsHitLabel(label: string, terms: string[]): boolean {
  if (terms.length === 0) return false
  const compact = foldPlural(label.toLowerCase().replace(/\s+/g, ''))
  return terms.some((t) => compact.includes(t) || t.includes(compact))
}
