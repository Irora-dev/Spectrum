import { BAKED } from './token-meta.generated'
import { cacheGet, cacheSet, DAY_MS } from './persist-cache'

// Brand color per token. Base layer = auto-baked from logos (scripts/bake-token-meta.ts,
// run via `pnpm bake:colors`); the curated map below OVERRIDES it for hand-tuned /
// "liar" tokens (e.g. WETH renders grey → pinned periwinkle). `ink` is the readable
// text color on `color`. Unmapped tokens fall back to a deterministic hashed hue.

export interface TokenVisual {
  address?: string
  color: string
  ink: string
}

// Curated overrides (win over the baked values).
export const TOKEN_META: Record<string, TokenVisual> = {
  VVV: { address: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf', color: '#E1390B', ink: '#F4F0F4' },
  BNKR: { address: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', color: '#704AE9', ink: '#F4F0F4' },
  NOCK: { address: '0x9b5e262cf9bb04869ab40b19af91d2dc85761722', color: '#1E1E1E', ink: '#F4F0F4' },
  REI: { address: '0x6b2504a03ca4d43d0d73776f6ad46dab2f2a4cfd', color: '#9E6555', ink: '#F4F0F4' },
  VIRTUAL: { address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', color: '#49A59F', ink: '#F4F0F4' },
  POD: { address: '0xed664536023d8e4b1640c394777d34abaff1df8f', color: '#5E79DE', ink: '#F4F0F4' },
  GITLAWB: { address: '0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3', color: '#0C0C0B', ink: '#F4F0F4' },
  SURPLUS: { address: '0xc52aedec3374422d7510e294cfaa90799595cba3', color: '#346A9B', ink: '#F4F0F4' },
  AEON: { address: '0xbf8e8f0e8866a7052f948c16508644347c57aba3', color: '#3C3830', ink: '#F4F0F4' },
  // ETH blue-chips (logos that mis-extract → pinned)
  ETH: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', color: '#627EEA', ink: '#F4F0F4' },
  WETH: { address: '0x4200000000000000000000000000000000000006', color: '#627EEA', ink: '#F4F0F4' },
  LINK: { address: '0x514910771af9ca656af840dff83e8264ecf986ca', color: '#2152D4', ink: '#F4F0F4' },
  AAVE: { address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', color: '#8886F7', ink: '#F4F0F4' },
}

export function readableInk(hex: string): string {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? '#34203B' : '#F4F0F4'
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) ((r = c), (g = x))
  else if (h < 120) ((r = x), (g = c))
  else if (h < 180) ((g = c), (b = x))
  else if (h < 240) ((g = x), (b = c))
  else if (h < 300) ((r = x), (b = c))
  else ((r = c), (b = x))
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase()
}

// Address index: baked base, then curated overrides win.
const BY_ADDRESS: Record<string, TokenVisual> = { ...BAKED }
for (const m of Object.values(TOKEN_META)) if (m.address) BY_ADDRESS[m.address.toLowerCase()] = m

function hashHue(addr: string): number {
  let h = 0
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0
  return h % 360
}

// Colors extracted client-side from a token's actual logo (use-token-color.ts).
// Sits BELOW the curated meta (brand colors stay authoritative) but ABOVE the
// hash fallback, so an unknown token adopts its logo's dominant color instead
// of an arbitrary hue the moment the extraction lands. Persisted (30 days) so
// a revisit paints the real color on FIRST render instead of flashing the
// hash hue until extraction completes.
const EXTRACTED_CACHE_KEY = 'extracted-token-colors'
const EXTRACTED = new Map<string, { color: string; ink: string }>(
  Object.entries(cacheGet<Record<string, string>>(EXTRACTED_CACHE_KEY) ?? {}).map(([a, color]) => [
    a,
    { color, ink: readableInk(color) },
  ]),
)
export function setExtractedTokenColor(address: string, color: string): void {
  EXTRACTED.set(address.toLowerCase(), { color, ink: readableInk(color) })
  const flat: Record<string, string> = {}
  for (const [a, v] of EXTRACTED) flat[a] = v.color
  cacheSet(EXTRACTED_CACHE_KEY, flat, 30 * DAY_MS)
}

/** Brand color + readable ink for a token: curated address/symbol meta first,
 *  then a logo-extracted color, else hashed from the address. */
export function tokenVisual(symbol: string | undefined, address: string): { color: string; ink: string } {
  const m = BY_ADDRESS[address.toLowerCase()] ?? (symbol ? TOKEN_META[symbol.toUpperCase()] : undefined)
  if (m) return { color: m.color, ink: m.ink }
  const ex = EXTRACTED.get(address.toLowerCase())
  if (ex) return ex
  const color = hslToHex(hashHue(address), 0.5, 0.42)
  return { color, ink: readableInk(color) }
}
