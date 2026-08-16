// ─────────────────────────────────────────────────────────────────────────────
// Creator handles — the pure core (spec: workspace/spectrum-release/
// creator-handles-spec.md, ruled by the owner 2026-08-06).
//
// `/creator/0x0000…c0e2` becomes `/creator/basedresearch`, with NO backend.
// A claim is one `SpectrumNotes` note (kind "handle"), so it is an EVENT: block
// number + log index give a canonical ordering nobody can forge or reorder, and
// every client computes the same winner from public logs. This file holds the
// part that has to be right — normalization and the resolver — as pure
// functions over plain data, so the whole feature is testable with no chain.
// The chain half lives in handle-registry.ts.
//
// NOT the profile `handle` field (profile-registry.ts). That one is decorative
// free text a creator writes about themselves, unverified and not unique. THIS
// is the claimable, first-come, one-owner name that a URL resolves through.
// ─────────────────────────────────────────────────────────────────────────────

export const HANDLE_MIN_LENGTH = 3
export const HANDLE_MAX_LENGTH = 30

/** The one allowed final form (spec §4). An ALLOWLIST, deliberately: anything
 *  the folds below don't turn into plain ASCII is refused rather than guessed,
 *  so an unmapped lookalike can never become a second, separate name. */
export const HANDLE_SHAPE = /^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/

// ── normalization — A SECURITY CONTROL, not tidiness (spec §4) ───────────────
//
// Two strings that LOOK the same must never both exist, or a copycat
// impersonates a creator with a name nobody can tell apart. Uniqueness is
// judged on the normalized form; the typed casing survives for display only.
//
// The pipeline, in order (order is load-bearing):
//   1. trim, then NFKC          — folds fullwidth, math-alphanumeric, circled,
//                                 superscript and ligature forms to plain ASCII
//   2. lowercase                — case-folded, per the spec
//   3. strip invisibles         — zero-width, bidi, format, combining marks and
//                                 the Hangul fillers, ENTIRELY
//   4. fold fullwidth by range  — belt and braces over step 1
//   5. map confusables          — the lookalike table below
//   6. shape check              — the allowlist above
//
// Deliberately NOT folded: `0`/`o`, `1`/`l`/`i`, `rn`/`m`. Those are all legal
// ASCII a creator may genuinely want, and collapsing them would delete most of
// the namespace to defend against a lookalike a reader can actually tell apart
// in the site's own font. Diacritics are not folded either: a composed `á`
// simply fails the allowlist, which is the safe direction.

/** Invisible / non-spacing characters, stripped ENTIRELY (spec §4).
 *  - `\p{Cf}` — zero-width space and joiners, soft hyphen, bidi overrides, BOM
 *  - `\p{Mn}` / `\p{Me}` — combining marks. A mark on a Latin letter is a
 *    lookalike; stripping makes it COLLIDE with the plain name instead of
 *    becoming a second one.
 *  - U+115F/U+1160/U+3164/U+FFA0 — the Hangul fillers, the classic "invisible
 *    name" trick. U+3164 is a LETTER (category Lo), so `\p{Cf}` does not catch
 *    it, and NFKC turns it into U+1160, which is also invisible and also a
 *    letter.
 *  - U+2800 — braille blank, an invisible glyph that is neither. */
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0\u2800]/gu

/** Fullwidth ASCII → ASCII (U+FF01…U+FF5E are exactly ASCII + 0xFEE0). NFKC
 *  already does this; kept explicit so the fold survives a change to the
 *  normalization step and so the rule is visible where the spec claims it. */
function foldFullwidth(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    out += c >= 0xff01 && c <= 0xff5e ? String.fromCodePoint(c - 0xfee0) : ch
  }
  return out
}

/**
 * Lookalike → Latin. Keys are ESCAPES with the character named beside them: a
 * homoglyph table you cannot see the difference in is a table nobody can
 * review, which is the whole attack. Approximate shape matches are fine here —
 * a wrong-but-plausible mapping only changes WHICH real name a fake collides
 * with, and a collision is always refused.
 */
const CONFUSABLES: Record<string, string> = {
  // ── Cyrillic — the classic attack ("bаsedresearch" with U+0430) ───────────
  '\u0430': 'a', // а CYRILLIC SMALL LETTER A
  '\u0432': 'b', // в CYRILLIC SMALL LETTER VE
  '\u0433': 'r', // г CYRILLIC SMALL LETTER GHE
  '\u0435': 'e', // е CYRILLIC SMALL LETTER IE
  '\u0451': 'e', // ё CYRILLIC SMALL LETTER IO
  '\u043A': 'k', // к CYRILLIC SMALL LETTER KA
  '\u043C': 'm', // м CYRILLIC SMALL LETTER EM
  '\u043D': 'h', // н CYRILLIC SMALL LETTER EN
  '\u043E': 'o', // о CYRILLIC SMALL LETTER O
  '\u043F': 'n', // п CYRILLIC SMALL LETTER PE
  '\u0440': 'p', // р CYRILLIC SMALL LETTER ER
  '\u0441': 'c', // с CYRILLIC SMALL LETTER ES
  '\u0442': 't', // т CYRILLIC SMALL LETTER TE
  '\u0443': 'y', // у CYRILLIC SMALL LETTER U
  '\u0445': 'x', // х CYRILLIC SMALL LETTER HA
  '\u0455': 's', // ѕ CYRILLIC SMALL LETTER DZE
  '\u0456': 'i', // і CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  '\u0457': 'i', // ї CYRILLIC SMALL LETTER YI
  '\u0458': 'j', // ј CYRILLIC SMALL LETTER JE
  '\u04BB': 'h', // һ CYRILLIC SMALL LETTER SHHA
  '\u04CF': 'l', // ӏ CYRILLIC SMALL LETTER PALOCHKA
  '\u04E9': 'o', // ө CYRILLIC SMALL LETTER BARRED O
  '\u0501': 'd', // ԁ CYRILLIC SMALL LETTER KOMI DE
  '\u051B': 'q', // ԛ CYRILLIC SMALL LETTER QA
  '\u051D': 'w', // ԝ CYRILLIC SMALL LETTER WE
  // Uppercase Cyrillic is folded by step 2 (lowercase) before it reaches this
  // table; listed anyway so the table stands alone if that order ever changes.
  '\u0405': 's', // Ѕ
  '\u0406': 'i', // І
  '\u0408': 'j', // Ј
  '\u0410': 'a', // А
  '\u0412': 'b', // В
  '\u0415': 'e', // Е
  '\u041A': 'k', // К
  '\u041C': 'm', // М
  '\u041D': 'h', // Н
  '\u041E': 'o', // О
  '\u0420': 'p', // Р
  '\u0421': 'c', // С
  '\u0422': 't', // Т
  '\u0423': 'y', // У
  '\u0425': 'x', // Х

  // ── Greek ────────────────────────────────────────────────────────────────
  '\u03B1': 'a', // α GREEK SMALL LETTER ALPHA
  '\u03B2': 'b', // β GREEK SMALL LETTER BETA
  '\u03B5': 'e', // ε GREEK SMALL LETTER EPSILON
  '\u03B7': 'n', // η GREEK SMALL LETTER ETA
  '\u03B9': 'i', // ι GREEK SMALL LETTER IOTA
  '\u03BA': 'k', // κ GREEK SMALL LETTER KAPPA
  '\u03BD': 'v', // ν GREEK SMALL LETTER NU
  '\u03BF': 'o', // ο GREEK SMALL LETTER OMICRON
  '\u03C1': 'p', // ρ GREEK SMALL LETTER RHO
  '\u03C4': 't', // τ GREEK SMALL LETTER TAU
  '\u03C5': 'u', // υ GREEK SMALL LETTER UPSILON
  '\u03C7': 'x', // χ GREEK SMALL LETTER CHI
  '\u03C2': 'c', // ς GREEK SMALL LETTER FINAL SIGMA (what U+03F2 lowercases to)
  '\u03BC': 'u', // μ GREEK SMALL LETTER MU (what U+039C lowercases to)
  '\u03F2': 'c', // ϲ GREEK LUNATE SIGMA SYMBOL
  '\u03F3': 'j', // ϳ GREEK LETTER YOT
  '\u0391': 'a', // Α
  '\u0392': 'b', // Β
  '\u0395': 'e', // Ε
  '\u0396': 'z', // Ζ
  '\u0397': 'h', // Η
  '\u0399': 'i', // Ι
  '\u039A': 'k', // Κ
  '\u039C': 'm', // Μ
  '\u039D': 'n', // Ν
  '\u039F': 'o', // Ο
  '\u03A1': 'p', // Ρ
  '\u03A4': 't', // Τ
  '\u03A5': 'y', // Υ
  '\u03A7': 'x', // Χ

  // ── Latin small capitals and phonetic lookalikes ─────────────────────────
  '\u0131': 'i', // ı LATIN SMALL LETTER DOTLESS I
  '\u0261': 'g', // ɡ LATIN SMALL LETTER SCRIPT G
  '\u0262': 'g', // ɢ LATIN LETTER SMALL CAPITAL G
  '\u0269': 'i', // ɩ LATIN SMALL LETTER IOTA
  '\u026A': 'i', // ɪ LATIN LETTER SMALL CAPITAL I
  '\u0274': 'n', // ɴ LATIN LETTER SMALL CAPITAL N
  '\u0280': 'r', // ʀ LATIN LETTER SMALL CAPITAL R
  '\u028F': 'y', // ʏ LATIN LETTER SMALL CAPITAL Y
  '\u0299': 'b', // ʙ LATIN LETTER SMALL CAPITAL B
  '\u029C': 'h', // ʜ LATIN LETTER SMALL CAPITAL H
  '\u029F': 'l', // ʟ LATIN LETTER SMALL CAPITAL L
  '\u1D00': 'a', // ᴀ LATIN LETTER SMALL CAPITAL A
  '\u1D04': 'c', // ᴄ LATIN LETTER SMALL CAPITAL C
  '\u1D05': 'd', // ᴅ LATIN LETTER SMALL CAPITAL D
  '\u1D07': 'e', // ᴇ LATIN LETTER SMALL CAPITAL E
  '\u1D0A': 'j', // ᴊ LATIN LETTER SMALL CAPITAL J
  '\u1D0B': 'k', // ᴋ LATIN LETTER SMALL CAPITAL K
  '\u1D0D': 'm', // ᴍ LATIN LETTER SMALL CAPITAL M
  '\u1D0F': 'o', // ᴏ LATIN LETTER SMALL CAPITAL O
  '\u1D18': 'p', // ᴘ LATIN LETTER SMALL CAPITAL P
  '\u1D1B': 't', // ᴛ LATIN LETTER SMALL CAPITAL T
  '\u1D1C': 'u', // ᴜ LATIN LETTER SMALL CAPITAL U
  '\u1D20': 'v', // ᴠ LATIN LETTER SMALL CAPITAL V
  '\u1D21': 'w', // ᴡ LATIN LETTER SMALL CAPITAL W
  '\u1D22': 'z', // ᴢ LATIN LETTER SMALL CAPITAL Z

  // ── Armenian ─────────────────────────────────────────────────────────────
  '\u0563': 'q', // գ ARMENIAN SMALL LETTER GIM
  '\u0566': 'q', // զ ARMENIAN SMALL LETTER ZA
  '\u056C': 'l', // լ ARMENIAN SMALL LETTER LIWN
  '\u0570': 'h', // հ ARMENIAN SMALL LETTER HO
  '\u0575': 'j', // յ ARMENIAN SMALL LETTER YI
  '\u0578': 'n', // ո ARMENIAN SMALL LETTER VO
  '\u057D': 'u', // ս ARMENIAN SMALL LETTER SEH
  '\u0585': 'o', // օ ARMENIAN SMALL LETTER OH

  // ── Cherokee. Both cases: the UPPERCASE block is the lookalike, and step 2
  //    lowercases it into the U+AB70 block first (Unicode 8 gave Cherokee case
  //    mappings), so the lowercase code points are the ones actually seen.
  '\u13A0': 'd', // CHEROKEE LETTER A (drawn like D); lowercase is U+AB70
  '\uAB70': 'd',
  '\u13A1': 'r', // CHEROKEE LETTER E (drawn like R); lowercase is U+AB71
  '\uAB71': 'r',
  '\u13A2': 't', // CHEROKEE LETTER I (drawn like T); lowercase is U+AB72
  '\uAB72': 't',
  '\u13A9': 'y', // CHEROKEE LETTER GI (drawn like y); lowercase is U+AB79
  '\uAB79': 'y',
  '\u13AA': 'a', // CHEROKEE LETTER GO (drawn like A); lowercase is U+AB7A
  '\uAB7A': 'a',
  '\u13AB': 'j', // CHEROKEE LETTER GU (drawn like J); lowercase is U+AB7B
  '\uAB7B': 'j',
  '\u13AC': 'e', // CHEROKEE LETTER GV (drawn like E); lowercase is U+AB7C
  '\uAB7C': 'e',
  '\u13B3': 'w', // CHEROKEE LETTER LA (drawn like W); lowercase is U+AB83
  '\uAB83': 'w',
  '\u13B7': 'm', // CHEROKEE LETTER LU (drawn like M); lowercase is U+AB87
  '\uAB87': 'm',
  '\u13BB': 'h', // CHEROKEE LETTER MI (drawn like H); lowercase is U+AB8B
  '\uAB8B': 'h',
  '\u13C0': 'g', // CHEROKEE LETTER NAH (drawn like G); lowercase is U+AB90
  '\uAB90': 'g',
  '\u13C2': 'h', // CHEROKEE LETTER NI (drawn like h); lowercase is U+AB92
  '\uAB92': 'h',
  '\u13C3': 'z', // CHEROKEE LETTER NO (drawn like Z); lowercase is U+AB93
  '\uAB93': 'z',
  '\u13CF': 'b', // CHEROKEE LETTER SI (drawn like b); lowercase is U+AB9F
  '\uAB9F': 'b',
  '\u13D2': 'r', // CHEROKEE LETTER SV (drawn like R); lowercase is U+ABA2
  '\uABA2': 'r',
  '\u13D9': 'v', // CHEROKEE LETTER DO (drawn like V); lowercase is U+ABA9
  '\uABA9': 'v',
  '\u13DA': 's', // CHEROKEE LETTER DU (drawn like S); lowercase is U+ABAA
  '\uABAA': 's',
  '\u13DE': 'l', // CHEROKEE LETTER TLE (drawn like L); lowercase is U+ABAE
  '\uABAE': 'l',
  '\u13DF': 'c', // CHEROKEE LETTER TLI (drawn like C); lowercase is U+ABAF
  '\uABAF': 'c',
  '\u13E6': 'k', // CHEROKEE LETTER TSO (drawn like K); lowercase is U+ABB6
  '\uABB6': 'k',

  // ── separator lookalikes — a hyphen twin splits a name in two ────────────
  '\u02D7': '-', // ˗ MODIFIER LETTER MINUS SIGN
  '\u058A': '-', // ֊ ARMENIAN HYPHEN
  '\u05BE': '-', // ־ HEBREW PUNCTUATION MAQAF
  '\u1400': '-', // ᐀ CANADIAN SYLLABICS HYPHEN
  '\u1806': '-', // ᠆ MONGOLIAN TODO SOFT HYPHEN
  '\u2010': '-', // ‐ HYPHEN
  '\u2011': '-', // ‑ NON-BREAKING HYPHEN
  '\u2012': '-', // ‒ FIGURE DASH
  '\u2013': '-', // – EN DASH
  '\u2014': '-', // — EM DASH
  '\u2015': '-', // ― HORIZONTAL BAR
  '\u2043': '-', // ⁃ HYPHEN BULLET
  '\u2212': '-', // − MINUS SIGN
  '\u2E17': '-', // ⸗ DOUBLE OBLIQUE HYPHEN
  '\u2E3A': '-', // ⸺ TWO-EM DASH
  '\u2E3B': '-', // ⸻ THREE-EM DASH
  '\u301C': '-', // 〜 WAVE DASH
  '\u3030': '-', // 〰 WAVY DASH
  '\u30A0': '-', // ゠ KATAKANA-HIRAGANA DOUBLE HYPHEN
  '\uFE58': '-', // ﹘ SMALL EM DASH
  '\uFE63': '-', // ﹣ SMALL HYPHEN-MINUS
  '\uFE4D': '_', // ﹍ DASHED LOW LINE
  '\uFE4E': '_', // ﹎ CENTRELINE LOW LINE
  '\uFE4F': '_', // ﹏ WAVY LOW LINE
}

// Build the replace expression FROM the table, never as a hand-kept second
// copy: a key the expression forgot would be a silent hole in a security
// control. Anything that is not one code point is dropped rather than guessed.
const CONFUSABLE_KEYS = Object.keys(CONFUSABLES).filter((k) => [...k].length === 1)
const CONFUSABLE_RE = new RegExp(
  `[${CONFUSABLE_KEYS.map((k) => `\\u{${k.codePointAt(0)!.toString(16)}}`).join('')}]`,
  'gu',
)

function mapConfusables(s: string): string {
  return s.replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] ?? ch)
}

/** Every way a typed name can be refused, in the words the UI needs. */
export type HandleFault =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'bad-characters'
  | 'edge-separator'
  | 'double-separator'
  | 'reserved'

/** Why a name was refused, in words a creator reads. USER-VISIBLE COPY: plain
 *  language, no jargon, and exhaustive by type, so a new fault cannot ship
 *  without something honest to say about it. */
export const HANDLE_FAULT_WORDS: Record<HandleFault, string> = {
  empty: 'that name is blank',
  'too-short': 'creator names are at least 3 characters',
  'too-long': 'creator names are at most 30 characters',
  'bad-characters': 'creator names use letters, numbers, dashes and underscores',
  'edge-separator': 'creator names cannot start or end with a dash or underscore',
  'double-separator': 'creator names cannot use two dashes or underscores in a row',
  reserved: 'that name is kept for the site itself',
}

/** A name that passed every rule: what uniqueness is judged on, and what the
 *  creator typed (casing only — see the display rule below). */
export interface Handle {
  normalized: string
  display: string
}

/** The typed form is kept for display ONLY when it differs from the normalized
 *  form by CASE alone. Anything else (a Cyrillic letter, a zero-width space)
 *  would let the owner of `basedresearch` render a name the site itself cannot
 *  reproduce — the exact spoofing surface normalization exists to close — so
 *  those fall back to showing the normalized name. */
function displayFor(typed: string, normalized: string): string {
  return /^[A-Za-z0-9_-]+$/.test(typed) && typed.toLowerCase() === normalized ? typed : normalized
}

/**
 * The normalizer. Returns the normalized + display forms, or null when the
 * name cannot be a handle at all. Does NOT apply the reserved list — the
 * resolver drops reserved names separately, so a name reserved AFTER a claim
 * stops resolving without changing what normalization means (spec §3).
 */
export function normalizeHandle(raw: unknown): Handle | null {
  const checked = inspectHandle(raw)
  return checked.ok ? checked.handle : null
}

/** normalizeHandle + the reserved list + WHY it was refused — what the claim
 *  form needs to say something true to the creator as they type. */
export function checkHandle(raw: unknown): { ok: true; handle: Handle } | { ok: false; fault: HandleFault } {
  const checked = inspectHandle(raw)
  if (!checked.ok) return checked
  if (isReservedHandle(checked.handle.normalized)) return { ok: false, fault: 'reserved' }
  return checked
}

function inspectHandle(raw: unknown): { ok: true; handle: Handle } | { ok: false; fault: HandleFault } {
  if (typeof raw !== 'string') return { ok: false, fault: 'empty' }
  const typed = raw.trim().replace(/^@/, '') // people type the @; it is not part of the name
  if (!typed) return { ok: false, fault: 'empty' }

  let s = typed.normalize('NFKC').toLowerCase()
  // Lowercasing can DECOMPOSE (İ becomes i + combining dot above), so the
  // invisible strip runs after it, not before.
  s = s.replace(INVISIBLE, '')
  s = mapConfusables(foldFullwidth(s))
  // A second strip: a fold can expose a mark that was part of a composed
  // character a moment ago.
  s = s.replace(INVISIBLE, '')

  if (!s) return { ok: false, fault: 'empty' }
  // Charset first: "you used a character we cannot accept" is more useful than
  // a length complaint about a name whose length is not the problem.
  if (!/^[a-z0-9_-]+$/.test(s)) return { ok: false, fault: 'bad-characters' }
  if (s.length < HANDLE_MIN_LENGTH) return { ok: false, fault: 'too-short' }
  if (s.length > HANDLE_MAX_LENGTH) return { ok: false, fault: 'too-long' }
  if (/^[_-]|[_-]$/.test(s)) return { ok: false, fault: 'edge-separator' }
  if (/[_-]{2}/.test(s)) return { ok: false, fault: 'double-separator' }
  // Defence in depth: the checks above and the published shape must agree, and
  // if they ever drift the allowlist is the one that wins.
  if (!HANDLE_SHAPE.test(s)) return { ok: false, fault: 'bad-characters' }

  return { ok: true, handle: { normalized: s, display: displayFor(typed, s) } }
}

// ── the reserved list (spec §3) ──────────────────────────────────────────────

/** Ruled by the owner 2026-08-06. Names that impersonate the site or its staff. */
const RESERVED_RULED = [
  'spectrum',
  'admin',
  'support',
  'help',
  'supportdesk',
  'official',
  'team',
  'mod',
  'moderator',
  'staff',
  'security',
  'billing',
  'wallet',
  'claim',
  'airdrop',
] as const

/**
 * Every first path segment the router serves. DERIVED, not hand-kept (spec §3):
 * creator-handles.routes.test.ts parses App.tsx and fails if a route segment is
 * missing here, so a page added next month cannot collide with a name someone
 * already owns. It is a literal rather than a runtime scan because this ships
 * in a browser bundle, which has no way to read its own source.
 */
export const APP_ROUTE_SEGMENTS = [
  'b',
  'buy-success-test',
  'bundle',
  'c',
  'claim',
  'compose',
  'create',
  'createbasket',
  'creator',
  'creators',
  'docs',
  'earn',
  'embed',
  'explore',
  'extension',
  'faq',
  'flush',
  'integrate',
  'launch',
  'league',
  'learn',
  'manager',
  'onboarding',
  'portfolio',
  'post-deploy-test',
  'privacy',
  'refer',
  'risk',
  'setup',
  'swap',
  't',
  'terms',
  'thesis',
  'token',
  'verify',
] as const

export const RESERVED: ReadonlySet<string> = new Set<string>([...RESERVED_RULED, ...APP_ROUTE_SEGMENTS])

/** Refused at CLAIM time and ignored at RESOLVE time, so a claim made before a
 *  name was reserved cannot keep working (spec §3). */
export function isReservedHandle(normalized: string): boolean {
  return RESERVED.has(normalized)
}

// ── the resolver (spec: "What the reader does") ──────────────────────────────

/** One claim as it appears on-chain. `name` is exactly what the note carried;
 *  '' is the registry's own "clear" and releases the author's current name. */
export interface HandleClaim {
  author: string
  subject: string
  name: string
  blockNumber: bigint
  logIndex: number
}

export interface HandleOwner {
  /** Lowercased — the map's own key space. Callers checksum for display. */
  address: string
  handle: string
  display: string
  blockNumber: bigint
  logIndex: number
}

export interface HandleMap {
  /** normalized name → its one owner. */
  byHandle: ReadonlyMap<string, HandleOwner>
  /** lowercased address → that creator's current name. */
  byAddress: ReadonlyMap<string, HandleOwner>
  /** normalized name → the lowercased address that may reclaim it. A retired
   *  name resolves to NOBODY (spec §5) and is in neither map above. */
  retired: ReadonlyMap<string, string>
}

/**
 * The whole algorithm, as a pure function over claims.
 *
 *   1. order by (block, log index) — the canonical, unforgeable ordering
 *   2. drop author != subject     — impersonation is structurally impossible
 *   3. drop non-deployers         — the anti-squat gate (spec §2)
 *   4. normalize, drop reserved   — spec §3/§4
 *   5. earliest valid claim wins
 *   6. a later claim by the SAME author retires their previous name
 *
 * `hasDeployed` is handed a LOWERCASED address and answers whether that wallet
 * has shipped a basket. It is a parameter so this file never touches a chain.
 */
export function resolveHandles(
  claims: readonly HandleClaim[],
  hasDeployed: (lowercasedAddress: string) => boolean,
): HandleMap {
  const byHandle = new Map<string, HandleOwner>()
  const byAddress = new Map<string, HandleOwner>()
  const retired = new Map<string, string>()

  // Step 1. Sorted HERE and never trusted from the caller: the ordering is the
  // only thing deciding who owns a name, so it comes from the events alone.
  const ordered = [...claims].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  )

  for (const claim of ordered) {
    const author = claim.author.toLowerCase()
    // Step 2. A claim only counts when you claimed it for yourself — which is
    // why no signature, allowlist or moderator appears anywhere in this file.
    if (author !== claim.subject.toLowerCase()) continue
    // Step 3. Turns "grab every good name" into "earn a name by shipping one".
    if (!hasDeployed(author)) continue

    // The registry's clear ('') is a release, and a release RETIRES like any
    // rename: never freed, so a link shared last month cannot silently point
    // at someone else (spec §5).
    if (claim.name === '') {
      retireCurrent(author, byHandle, byAddress, retired)
      continue
    }

    const handle = normalizeHandle(claim.name)
    // Step 4. A malformed or reserved name is noise: it changes nothing, and
    // above all it must not destroy the name this author already holds.
    if (!handle || isReservedHandle(handle.normalized)) continue

    // Step 5. Earliest wins. Re-claiming what you already hold is a no-op, and
    // must NOT retire it.
    if (byHandle.has(handle.normalized)) continue
    const retiredBy = retired.get(handle.normalized)
    // The one ruled exception: a retired name is reclaimable by the wallet that
    // last held it and by nobody else. One comparison, per the owner's ruling.
    if (retiredBy !== undefined && retiredBy !== author) continue

    retireCurrent(author, byHandle, byAddress, retired)
    retired.delete(handle.normalized) // live again
    const owner: HandleOwner = {
      address: author,
      handle: handle.normalized,
      display: handle.display,
      blockNumber: claim.blockNumber,
      logIndex: claim.logIndex,
    }
    byHandle.set(handle.normalized, owner)
    byAddress.set(author, owner)
  }

  return { byHandle, byAddress, retired }
}

/** Step 6, the half that runs on every successful claim: whatever this author
 *  held stops resolving, and becomes theirs alone to take back. */
function retireCurrent(
  author: string,
  byHandle: Map<string, HandleOwner>,
  byAddress: Map<string, HandleOwner>,
  retired: Map<string, string>,
): void {
  const previous = byAddress.get(author)
  if (!previous) return
  byHandle.delete(previous.handle)
  byAddress.delete(author)
  retired.set(previous.handle, author)
}

/** An empty map — the honest answer for a site with no registry configured. */
export function emptyHandleMap(): HandleMap {
  return { byHandle: new Map(), byAddress: new Map(), retired: new Map() }
}

// ── lookups over a resolved map (pure) ───────────────────────────────────────

/** What a typed name is, for the claim form and the creator route. */
export type HandleState =
  | { state: 'free' }
  | { state: 'taken'; owner: HandleOwner }
  | { state: 'yours'; owner: HandleOwner }
  | { state: 'retired'; by: string }
  | { state: 'reclaimable'; by: string }
  | { state: 'invalid'; fault: HandleFault }

/** The one place the claim form and the route agree about what a name is.
 *  `viewer` (a connected wallet) turns "taken" into "yours" and "retired" into
 *  "reclaimable" — the only difference the ruled exception makes. */
export function handleStateIn(map: HandleMap, raw: unknown, viewer?: string | null): HandleState {
  const checked = checkHandle(raw)
  if (!checked.ok) return { state: 'invalid', fault: checked.fault }
  const name = checked.handle.normalized
  const me = viewer ? viewer.toLowerCase() : null
  const owner = map.byHandle.get(name)
  if (owner) return owner.address === me ? { state: 'yours', owner } : { state: 'taken', owner }
  const by = map.retired.get(name)
  if (by !== undefined) return by === me ? { state: 'reclaimable', by } : { state: 'retired', by }
  return { state: 'free' }
}

/** Name → owner. null covers both "never claimed" and "retired": a retired
 *  name resolves to NOBODY, which is the whole point of retiring it. */
export function addressForIn(map: HandleMap, raw: unknown): HandleOwner | null {
  const handle = normalizeHandle(raw)
  if (!handle || isReservedHandle(handle.normalized)) return null
  return map.byHandle.get(handle.normalized) ?? null
}

/** Address → their current name, or null when they have none. */
export function handleForIn(map: HandleMap, address: string | null | undefined): HandleOwner | null {
  if (!address) return null
  return map.byAddress.get(address.toLowerCase()) ?? null
}
