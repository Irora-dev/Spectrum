// Bake brand colors for major tokens into src/lib/spectrum/token-meta.generated.ts
// so first paint shows real colors with zero runtime network work.
//
//   pnpm bake:colors             add colors for new tokens (existing entries kept)
//   pnpm bake:colors --refresh   recompute every entry from scratch
//
// OPTIONAL for operators — the generated file ships committed, so this only
// needs running to refresh coverage (e.g. after the Uniswap list gains tokens
// you care about). Keyless; sources are the Uniswap Labs token list (which
// tokens to bake + their logoURI), then TrustWallet / DexScreener logo CDNs.
//
// The extraction mirrors src/lib/spectrum/use-token-color.ts EXACTLY
// (saturation-weighted average of opaque, non-near-white/black pixels at 24×24,
// lightness clamped into a readable band) so baked and runtime-extracted colors
// agree. Keep the two in lockstep.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Jimp } from 'jimp'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/spectrum/token-meta.generated.ts')
const LIST_URL = 'https://tokens.uniswap.org'
const CHAINS = { 1: 'ethereum', 8453: 'base' }
const CONCURRENCY = 8
const REFRESH = process.argv.includes('--refresh')

// ── color math (mirrors use-token-color.ts / token-meta.ts) ──────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return [h, s, l]
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  const to = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase()
}

const readableInk = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? '#34203B' : '#F4F0F4'
}

/** The shared extractor: dominant saturated color of a 24×24 downsample, or null. */
function dominantColor(image) {
  image.resize({ w: 24, h: 24 })
  const { data } = image.bitmap
  let r = 0, g = 0, b = 0, wsum = 0
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a < 200) continue
    const [, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
    if (l > 0.92 || l < 0.08) continue // white rims / black outlines aren't "the color"
    const w = 0.05 + s * s // saturation-weighted: the brand hue dominates
    r += data[i] * w
    g += data[i + 1] * w
    b += data[i + 2] * w
    wsum += w
  }
  if (wsum < 8) return null // not enough signal (mostly-transparent / monochrome)
  const [h, s, l] = rgbToHsl(r / wsum, g / wsum, b / wsum)
  return hslToHex(h, Math.min(0.9, Math.max(0.35, s)), Math.min(0.62, Math.max(0.34, l)))
}

// ── logo sources (list logoURI first, then the runtime ladder's rungs) ───────
const gateway = (uri) => (uri?.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri)
const checksumless = (a) => a.toLowerCase()
function sources(token, slug) {
  const out = []
  const lg = gateway(token.logoURI)
  if (lg) out.push(lg)
  out.push(
    `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${slug}/assets/${token.address}/logo.png`,
    `https://dd.dexscreener.com/ds-data/tokens/${slug}/${checksumless(token.address)}.png?size=lg`,
  )
  return out
}

async function fetchImage(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return null
    return await Jimp.read(Buffer.from(await res.arrayBuffer()))
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function bakeOne(token, slug) {
  for (const url of sources(token, slug)) {
    const img = await fetchImage(url)
    if (!img) continue
    try {
      const color = dominantColor(img)
      if (color) return { color, ink: readableInk(color) }
    } catch {
      /* undecodable image — next rung */
    }
  }
  return null
}

// ── main ──────────────────────────────────────────────────────────────────────
const existing = new Map()
if (!REFRESH) {
  const src = readFileSync(OUT, 'utf8')
  for (const m of src.matchAll(/'(0x[0-9a-f]{40})': \{ color: '(#[0-9A-F]{6})', ink: '(#[0-9A-F]{6})' \},? \/\/ (.*)/g)) {
    existing.set(m[1], { color: m[2], ink: m[3], symbol: m[4] })
  }
  console.log(`keeping ${existing.size} existing entries (use --refresh to recompute)`)
}

const list = await (await fetch(LIST_URL, { headers: { Accept: 'application/json' } })).json()
const tokens = list.tokens.filter((t) => CHAINS[t.chainId] && t.address && t.symbol)
const todo = tokens.filter((t) => !existing.has(t.address.toLowerCase()))
console.log(`list: ${tokens.length} tokens (chains ${Object.keys(CHAINS).join(', ')}) · to bake: ${todo.length}`)

const baked = new Map(existing)
let done = 0
const queue = [...todo]
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const t = queue.shift()
      if (!t) return
      const res = await bakeOne(t, CHAINS[t.chainId])
      done++
      if (res) baked.set(t.address.toLowerCase(), { ...res, symbol: t.symbol })
      if (done % 25 === 0) console.log(`  ${done}/${todo.length} (${baked.size} baked)`)
    }
  }),
)

const rows = [...baked.entries()]
  .sort(([, a], [, b]) => a.symbol.localeCompare(b.symbol))
  .map(([addr, v]) => `  '${addr}': { color: '${v.color}', ink: '${v.ink}' }, // ${v.symbol}`)
  .join('\n')

writeFileSync(
  OUT,
  `// AUTO-GENERATED by scripts/bake-token-meta.mjs — brand colors extracted from
// token logos (dominant vibrant hue). Re-run: pnpm bake:colors. Do not edit by hand.

export const BAKED: Record<string, { color: string; ink: string }> = {
${rows}
}
`,
)
console.log(`wrote ${baked.size} entries → ${OUT}`)
