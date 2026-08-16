// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE CHECK BEFORE PAYING (the owner 2026-08-13, in the greenlit list) — read
// whether a basket with this name, this ticker, or this exact mix already
// exists on this chain, BEFORE the gas is spent.
//
// A WARNING, NEVER A BLOCK. Two baskets may legitimately share a name (a
// creator shipping the same idea for a different audience) or a mix (two people
// arriving at the same three blue chips). The creator decides; this only makes
// sure they decide KNOWING. Nothing here refuses a deploy.
//
// It costs no new network: `useAllBaskets` is already in cache on every surface
// that could host this, so the candidate is compared against rows the page
// already has.
//
// THE ONE THING IT WILL NOT DO IS CLAIM A MIX MATCH IT CANNOT SEE. A row's
// `top` is the full leg list on the shipped path (basket-data builds it from
// every leg), but a row whose `top` is shorter than its own `basketLength` has
// been truncated by whatever produced it — and comparing a truncated list would
// report "same assets" off a prefix. Those rows are reported as name/ticker
// only, and `mixCheckable` says the mix could not be compared.
// ─────────────────────────────────────────────────────────────────────────────

export type DuplicateReason = 'name' | 'ticker' | 'mix'

/** The shape this needs from a discovered basket — a subset of BasketSummary,
 *  so a `BasketSummary[]` from useAllBaskets passes straight in. */
export interface ExistingBasket {
  chainId: number
  address: string
  name: string
  symbol: string
  basketLength: number
  top: readonly { address: string; weightPct: number }[]
  supersededBy?: string | null
}

export interface CandidateBasket {
  chainId: number
  name: string
  symbol: string
  /** The picked assets and their whole-number weights. */
  assets: readonly { address: string; weightPct: number }[]
}

export interface DuplicateHit {
  basket: ExistingBasket
  /** Every way this one collides — a name AND ticker match reads differently
   *  from a name alone, so the surface gets both rather than a winner. */
  reasons: DuplicateReason[]
}

export interface DuplicateReport {
  hits: DuplicateHit[]
  /** False when at least one candidate row could not have its mix compared —
   *  the surface may then say "no name or ticker match", never "no duplicate". */
  mixCheckable: boolean
}

/** The thesis grouper's own name fold — membership must key the way grouping
 *  does, or "Blue  Chips" and "blue chips" would read as different baskets. */
export const foldName = (s: string | null | undefined): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const foldTicker = (s: string | null | undefined): string => String(s ?? '').trim().toUpperCase()

/** A mix as a comparable key: address → weight, order-independent. */
const mixKey = (legs: readonly { address: string; weightPct: number }[]): string =>
  legs
    .map((l) => `${l.address.toLowerCase()}@${Math.round(l.weightPct)}`)
    .sort()
    .join(',')

/**
 * Everything on this chain that collides with the candidate.
 *
 * Heads only: a superseded version sharing its successor's name is the version
 * system working, not a duplicate, and warning about it would train creators to
 * ignore the warning.
 */
export function findDuplicates(
  candidate: CandidateBasket,
  existing: readonly ExistingBasket[],
): DuplicateReport {
  const name = foldName(candidate.name)
  const ticker = foldTicker(candidate.symbol)
  const mix = candidate.assets.length > 0 ? mixKey(candidate.assets) : null

  const sameChain = existing.filter((b) => b.chainId === candidate.chainId && !b.supersededBy)
  let mixCheckable = true
  const hits: DuplicateHit[] = []

  for (const b of sameChain) {
    const reasons: DuplicateReason[] = []
    if (name && foldName(b.name) === name) reasons.push('name')
    if (ticker && foldTicker(b.symbol) === ticker) reasons.push('ticker')
    // Only compare a mix against a leg list that is demonstrably WHOLE.
    const whole = b.top.length > 0 && b.top.length === b.basketLength
    if (!whole) mixCheckable = false
    else if (mix && mixKey(b.top) === mix) reasons.push('mix')
    if (reasons.length > 0) hits.push({ basket: b, reasons })
  }
  return { hits, mixCheckable }
}

/** The warning's one sentence, or null when there is nothing to warn about. */
export function duplicateWarning(report: DuplicateReport): string | null {
  const [first] = report.hits
  if (!first) return null
  const what = first.reasons.includes('mix')
    ? 'the same assets at the same weights'
    : first.reasons.includes('name') && first.reasons.includes('ticker')
      ? 'the same name and ticker'
      : first.reasons.includes('name')
        ? 'the same name'
        : 'the same ticker'
  const more = report.hits.length > 1 ? ` (and ${report.hits.length - 1} more)` : ''
  return `A basket with ${what} already exists on this network${more} — you can still deploy this one.`
}
