import { useEffect, useSyncExternalStore } from 'react'
import { setExtractedTokenColor } from './token-meta'
import { coingeckoLogoUrl, colorSources } from './token-art'

// ─────────────────────────────────────────────────────────────────────────────
// Dominant-color extraction from a token's logo (the same DexScreener CDN image
// AssetLogo renders). Unknown tokens otherwise get an address-hashed hue that
// can clash with the visible logo (a yellow bar under an orange logo). The
// extracted color feeds token-meta's EXTRACTED cache, which tokenVisual reads
// below the curated meta — curated brand colors stay authoritative.
//
// Mechanics: load with crossOrigin=anonymous → draw to a 24×24 canvas →
// saturation-weighted average of opaque, non-near-white/black pixels → clamp
// lightness into a readable band. CORS-blocked or logo-less tokens simply keep
// the hash color (best-effort polish, never load-bearing).
//
// Sources live in token-art.ts (shared with AssetLogo): TrustWallet first
// (GitHub raw sends ACAO:*), DexScreener second (their CDN refuses crossOrigin
// loads today — kept in case that changes), and a final async Coingecko
// contract-lookup rung (both its API and coin-images CDN send ACAO:*).
// ─────────────────────────────────────────────────────────────────────────────

const attempted = new Set<string>()
let version = 0
const listeners = new Set<() => void>()
const bump = () => {
  version++
  listeners.forEach((l) => l())
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  ;(r /= 255), (g /= 255), (b /= 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return [h, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0,
    g = 0,
    b = 0
  if (h < 60) ((r = c), (g = x))
  else if (h < 120) ((r = x), (g = c))
  else if (h < 180) ((g = c), (b = x))
  else if (h < 240) ((g = x), (b = c))
  else if (h < 300) ((r = x), (b = c))
  else ((r = c), (b = x))
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase()
}

/** Try one image URL; onFail advances the ladder (load error or CORS taint). */
function attempt(address: string, src: string, onFail: () => void): void {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onerror = onFail
  img.onload = () => {
    try {
      const N = 24
      const canvas = document.createElement('canvas')
      canvas.width = N
      canvas.height = N
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0, N, N)
      const { data } = ctx.getImageData(0, 0, N, N) // throws when CORS-tainted
      let r = 0,
        g = 0,
        b = 0,
        wsum = 0
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]
        if (a < 200) continue
        const [, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
        if (l > 0.92 || l < 0.08) continue // white rims / black outlines aren't "the color"
        const w = 0.05 + s * s // saturation-weighted: the brand hue dominates the average
        r += data[i] * w
        g += data[i + 1] * w
        b += data[i + 2] * w
        wsum += w
      }
      if (wsum < 8) return // not enough signal (mostly-transparent / monochrome logo)
      const [h, s, l] = rgbToHsl(r / wsum, g / wsum, b / wsum)
      // Clamp into a band that reads as a bar/tile fill on the dark surface.
      const color = hslToHex(h, Math.min(0.9, Math.max(0.35, s)), Math.min(0.62, Math.max(0.34, l)))
      setExtractedTokenColor(address, color)
      bump()
    } catch {
      // CORS-tainted canvas — this rung loaded but can't be read; try the next.
      onFail()
    }
  }
  img.src = src
}

function extract(address: string, chainId: number, srcIdx = 0): void {
  const key = address.toLowerCase()
  if (srcIdx === 0) {
    if (attempted.has(key) || typeof document === 'undefined') return
    attempted.add(key)
  }
  const srcs = colorSources(address, chainId)
  if (srcIdx < srcs.length) {
    attempt(address, srcs[srcIdx], () => extract(address, chainId, srcIdx + 1))
    return
  }
  // Static rungs exhausted → the cached Coingecko contract lookup (terminal).
  void coingeckoLogoUrl(address, chainId).then((u) => {
    if (u) attempt(address, u, () => {})
  })
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Kick off logo-color extraction for `assets` and re-render as colors land
 *  (tokenVisual then returns the extracted color automatically). Items may
 *  carry their own chainId (mixed-chain bentos); `defaultChainId` covers the rest. */
export function useTokenColors(
  assets: { address: string; chainId?: number }[],
  defaultChainId: number,
): number {
  const v = useSyncExternalStore(subscribe, () => version, () => 0)
  useEffect(() => {
    for (const a of assets) extract(a.address, a.chainId ?? defaultChainId)
  }, [assets, defaultChainId])
  return v
}
