import type { BasketSummary } from './basket-data'
import { handleForAddressCached } from './handle-registry'
import { groupIntoTheses, type GroupOptions, type Thesis } from './thesis'

// ─────────────────────────────────────────────────────────────────────────────
// A THESIS'S ADDRESS — the naming half of `thesis.ts`, which owns the
// recognition half. Its own file so the grouping core and its suite stay
// untouched: nothing here changes what a thesis IS, only what it is called in
// an address bar.
//
// THE URL IS THE GROUPING KEY, WHICH IS WHY THE ROUTE CAN EXIST AT ALL.
// `groupIntoTheses` keys on (deployer, name), so `/thesis/<deployer>/<name>`
// carries the whole key and nothing else — there is no id to mint, no registry
// to write and no contract field to add. A thesis is recognised on read, so its
// link is derived on read too.
//
// ⚠ TWO NAMES CAN COLLIDE INTO ONE READABLE SLUG. "Bullish EVM" and
// "Bullish-EVM" are two theses to the grouper (its key keeps the hyphen,
// collapsing only whitespace) and one kebab slug here, because a path segment
// cannot keep a space. So the MINTED ref carries a hash of the name after it —
// `bullish-evm-3f2a1b04` — which is `short-url.ts`'s own `SYMBOL-<8hex>`
// doctrine one layer over: the readable half for humans, the machine half so
// the link can never change meaning.
//
// Resolution accepts BOTH, and the order matters. An exact ref is answered
// exactly. A bare readable slug (typed, or shared before this) is answered when
// it is unambiguous and REFUSED with its candidates when it is not — the
// posture `resolveBasketRef` takes on an ambiguous ticker, for the same reason:
// picking one would send a reader to a thesis they did not ask for, with money
// in hand. Those candidates are offered as full refs, so the way out of a tie
// always resolves.
// ─────────────────────────────────────────────────────────────────────────────

/** Longest slug we will mint. The same bound `safe-copy` puts on a shown name:
 *  a slug is a deployer-typed name rendered into a path, and a 300-character
 *  path segment is the same hostile string one layer down. */
const MAX_SLUG = 48

/** 8 hex of FNV-1a over a string. Written here rather than borrowed from
 *  `bundle.ts` because that one hashes a leg list; this one hashes a name. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** THE GROUPER'S OWN KEY, restated so the hash below is taken over exactly what
 *  decides whether two baskets are one thesis. `thesis.ts` keeps its copy
 *  private; if that fold ever changes, this one has to change with it, and the
 *  paired test is what says so. */
const nameKey = (name: string | null | undefined): string =>
  String(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The READABLE half of a thesis's address. Lowercased, non-alphanumerics folded
 * to single hyphens, clipped — so "Bullish EVM" and "  bullish   evm " agree,
 * exactly as they already agree inside the grouper.
 *
 * Empty for a name that survives none of that (all emoji, all CJK): the ref
 * below then stands on its hash alone, which is unreadable but permanent, and
 * beats a thesis with no address at all.
 */
export function thesisSlug(name: string | null | undefined): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, '')
}

/** The canonical ref the app MINTS: the readable slug plus the name's hash, so
 *  one link means one thesis forever. See the header on why both halves. */
export function thesisRef(name: string | null | undefined): string {
  const slug = thesisSlug(name)
  const h = fnv1a(nameKey(name))
  return slug ? `${slug}-${h}` : h
}

/** Where a thesis lives. The creator half PREFERS the claimed name when the
 *  handle registry has resolved this session (owner 2026-08-16: "the urls for
 *  baskets/bundles [should use] the creator url so its much shorter" —
 *  /thesis/iroradevtest/… instead of forty hex characters). Best-effort and
 *  lawful both ways: the Thesis route resolves names AND addresses, and
 *  before the registry's first resolve the address form mints, which always
 *  worked and always will. */
export function thesisHref(deployer: string, name: string | null | undefined): string {
  const handle = handleForAddressCached(deployer)
  return `/thesis/${handle ?? deployer.toLowerCase()}/${thesisRef(name)}`
}

export interface ThesisMatch {
  /** Exactly one thesis matched — render it. */
  hit: Thesis | null
  /** More than one did: the caller must ask, because choosing would be
   *  guessing which idea someone followed a link to. */
  ambiguous: Thesis[]
}

/**
 * Resolve `/thesis/:deployer/:slug` against the discovered basket list.
 *
 * HEADS ONLY, the same filter the creator profile applies: a superseded version
 * sharing its successor's name is a relaunch, and since the grouper keeps the
 * RICHER basket per chain, a fat retired v1 would otherwise stand in the thesis
 * in place of the live v2.
 *
 * `includeSingles` is forced ON, deliberately. A chain that did not answer
 * leaves a two-leg thesis reading as one leg, and a page that 404s in that gap
 * would be claiming the thesis does not exist when the truth is that we could
 * not read it. The page says what it found instead.
 */
export function resolveThesis(
  baskets: readonly BasketSummary[],
  deployer: string | null | undefined,
  ref: string | null | undefined,
  opts: GroupOptions = {},
): ThesisMatch {
  const none: ThesisMatch = { hit: null, ambiguous: [] }
  const who = String(deployer ?? '').trim().toLowerCase()
  const want = String(ref ?? '').trim().toLowerCase()
  if (!who || !want) return none

  const mine = baskets.filter((b) => b.deployer?.toLowerCase() === who && !b.supersededBy)
  const theses = groupIntoTheses(mine, { ...opts, includeSingles: true })

  // the exact ref first: it names one thesis and cannot mean another
  const exact = theses.find((t) => thesisRef(t.name) === want)
  if (exact) return { hit: exact, ambiguous: [] }

  // then the readable half alone, which may not be unique (see the header)
  const readable = theses.filter((t) => thesisSlug(t.name) === want)
  if (readable.length === 1) return { hit: readable[0], ambiguous: [] }
  if (readable.length > 1) return { hit: null, ambiguous: readable }
  return none
}
