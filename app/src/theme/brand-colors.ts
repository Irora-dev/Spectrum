// Bridge for canvas / WebGL, which can't consume CSS custom properties directly:
// read a resolved brand token as normalized [r,g,b] (0..1) and feed it to a shader
// uniform or a 2D-canvas fill. Pure hex parse is split out so it's unit-testable.

export function hexToRgb01(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Resolve a `--color-*` var off the root element to [r,g,b] 0..1, or null if unset/malformed. */
export function readBrandRgb(
  varName: string,
  el: HTMLElement = document.documentElement,
): [number, number, number] | null {
  return hexToRgb01(getComputedStyle(el).getPropertyValue(varName))
}

/** The same bridge for the mounts that want a COLOUR STRING rather than a
 *  uniform. The palette shaders take `string[]`, and handing one
 *  `var(--color-violet)` makes it log "Unsupported color format" and drop that
 *  entry — the Token hero's pre-data warp palette did exactly that on every
 *  basket page load (found by the console smoke, 2026-08-07).
 *
 *  Falls back to a literal rather than returning null, because a decorative
 *  palette must never carry a hole: one wrong colour is a far better failure
 *  than a gap in the array or a throw. Guarded for a non-DOM caller (the unit
 *  tests and any node-side render) so it degrades to the fallback there. */
export function readBrandHex(
  varName: string,
  fallback: string,
  el?: HTMLElement,
): string {
  const root = el ?? (typeof document !== 'undefined' ? document.documentElement : null)
  if (!root || typeof getComputedStyle !== 'function') return fallback
  const raw = getComputedStyle(root).getPropertyValue(varName).trim()
  if (!hexToRgb01(raw)) return fallback
  return raw.startsWith('#') ? raw : `#${raw}`
}
