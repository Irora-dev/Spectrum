import { tokenVisual } from './token-meta'

// One signature color per basket, reused on its card (accent glow) and detail
// page (accent lid) so the two read as the same object. Derived MECHANICALLY:
// the dominant holding's brand color, else a hue hashed from the address —
// the replacement for curated branding (no taxonomy colors).
const FALLBACK_PALETTE = ['#35e0ff', '#ff4db8', '#ff9248', '#a48bff', '#5cff8f', '#34d6c4']

export function basketSignatureColor(
  basketAddress: string,
  dominant?: { symbol?: string; address?: string },
): string {
  if (dominant?.address) return tokenVisual(dominant.symbol, dominant.address).color
  // Deterministic accent from the address — a mechanical fact, not curation.
  let h = 0
  const a = basketAddress.toLowerCase()
  for (let i = 2; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length]
}
