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
