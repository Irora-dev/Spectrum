// ─────────────────────────────────────────────────────────────────────────────
// Address fingerprint — a deterministic, human-checkable identity for a contract
// address.
//
// Humans cannot meaningfully compare a 42-char hex address, and address-poisoning
// clones deliberately share the first/last few characters so a glance "matches".
// So instead we derive a memorable emoji + word codename + colour from the WHOLE
// address: a poisoned look-alike (same ends, different middle) yields a visibly
// different fingerprint, because every byte feeds the hash.
//
// Pure + dependency-free on purpose: it runs under `node --test` (no build) and
// renders identically everywhere the same address is shown, so a user can learn
// "the real router is 🦊🌊⚓ / otter-harbor-anchor" once and recognise it anywhere.
//
// NOTE: a fingerprint authenticates an ADDRESS; it is not a safety verdict about a
// basket or a site. The canonical source of truth for which addresses are genuine
// is the protocol's published anchor (see anchor.ts), never this kit.
// ─────────────────────────────────────────────────────────────────────────────

// Curated, visually-distinct emoji (no skin-tone / easily-confused glyphs).
const EMOJI = [
  '🦊', '🐙', '🦉', '🐝', '🦀', '🐬', '🦋', '🐢',
  '🦁', '🐺', '🦅', '🐉', '🌊', '🔥', '⚡', '🌙',
  '⭐', '❄️', '🍀', '🌸', '🍁', '⚓', '🔑', '🛡️',
  '💎', '🎯', '🧭', '🗝️', '🛰️', '🔭', '🏔️', '🌵',
] as const

// Short, distinct, easy-to-say words (no homophones / lookalikes).
const WORDS = [
  'amber', 'anchor', 'aspen', 'basalt', 'beacon', 'birch', 'cedar', 'cobalt',
  'copper', 'coral', 'cove', 'delta', 'dune', 'ember', 'fjord', 'flint',
  'garnet', 'glacier', 'granite', 'harbor', 'heron', 'indigo', 'ivory', 'jasper',
  'kelp', 'lagoon', 'lichen', 'maple', 'marble', 'meadow', 'onyx', 'opal',
  'otter', 'pewter', 'quartz', 'raven', 'reef', 'ridge', 'saffron', 'sage',
  'slate', 'spruce', 'summit', 'tide', 'timber', 'topaz', 'tundra', 'umber',
  'vellum', 'verdant', 'willow', 'zephyr', 'crest', 'drift', 'forge', 'haven',
  'lumen', 'nimbus', 'orbit', 'prism', 'quill', 'thorn', 'vertex', 'warden',
] as const

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

export interface Fingerprint {
  /** Whether the input was a well-formed 0x address. */
  valid: boolean
  /** Three emoji, e.g. "🦊🌊⚓". */
  emoji: string
  /** Three words, e.g. "otter-harbor-anchor". */
  words: string
  /** Two hues (0–359) for a deterministic gradient swatch. */
  hueA: number
  hueB: number
}

/** FNV-1a 32-bit. Cheap, dependency-free, good avalanche for short strings. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Deterministic, whole-address fingerprint. Invalid input returns a clearly-marked
 * placeholder (valid:false) rather than throwing — callers render it as "unknown".
 */
export function addressFingerprint(address: string | undefined | null): Fingerprint {
  const a = (address ?? '').trim().toLowerCase()
  if (!ADDR_RE.test(a)) {
    return { valid: false, emoji: '⬚⬚⬚', words: 'unknown', hueA: 0, hueB: 0 }
  }
  // Independent fields from independently-salted hashes of the full address.
  const pick = (salt: string, n: number) => fnv1a(salt + a) % n
  const emoji = [pick('e1', EMOJI.length), pick('e2', EMOJI.length), pick('e3', EMOJI.length)]
    .map((i) => EMOJI[i])
    .join('')
  const words = [pick('w1', WORDS.length), pick('w2', WORDS.length), pick('w3', WORDS.length)]
    .map((i) => WORDS[i])
    .join('-')
  const hueA = pick('hA', 360)
  const hueB = (hueA + 40 + pick('hB', 120)) % 360
  return { valid: true, emoji, words, hueA, hueB }
}
