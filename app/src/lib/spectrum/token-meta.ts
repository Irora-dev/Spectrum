import { BAKED } from './token-meta.generated'
import { SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { stocksForChain } from '../chain/stocks'
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
  // Robinhood Chain natives (owner 2026-07-11): the RH electric green/yellow
  // family, one shade apart. Addresses = the DEEPEST USDG pool per symbol
  // (each has on-chain copycats; the symbol fallback still colours those).
  CASHCAT: { address: '0x020bfc650a365f8bb26819deaabf3e21291018b4', color: '#CCFF00', ink: '#1C2A00' },
  HOODRAT: { address: '0x9771fe3a4b392a7dd5bba1ab19b1cc4996e4808a', color: '#AFF229', ink: '#1C2A00' },
  JUGGERNAUT: { address: '0xc93d3974ff99fdaafa8378a54c3262d1d838dc3c', color: '#8FE04A', ink: '#122000' },
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BRAND COLOUR BANK (the owner 2026-08-06: "we need to do a much better job of
// matching colours to tickers, especially for stocks — a bank of colours as a
// list, i.e. tesla deep red").
//
// Everything below is a HAND-CHECKED brand colour, not a logo extraction. The
// baked layer reads an average out of a logo image, which is why a
// predominantly-white logo came back grey and Tesla came back somewhere near
// beige — an average is not a brand.
//
// `ink` is omitted on purpose: readableInk() derives it from luminance, so a
// dark brand gets light text and a bright one gets dark text without anyone
// hand-pairing 90 rows and getting one wrong. That also keeps the contrast
// floor structural rather than a thing to remember.
//
// ⚠️ SYMBOLS ARE NOT IDENTITIES FOR TOKENS. This map is symbol-keyed, so a scam
// ERC-20 calling itself TSLA or AAVE inherits the brand colour. That is a
// pre-existing property of this map (LINK and AAVE were already here), and it
// is cosmetic rather than a money path — but it is the reason the token half
// below sticks to assets whose brand is unambiguous, and the reason the STOCK
// half is only ever applied to symbols the stock REGISTRY verified.
// ─────────────────────────────────────────────────────────────────────────────

/** Tokenised equities and ETFs. Applied only to registry-verified stock symbols
 *  (see stocksForChain) — a token calling itself NVDA never reaches this map. */
/** The symbols the stock registry actually lists, across every supported chain
 *  — the gate that keeps STOCK_BRAND off deployer-named tokens. */
const REGISTRY_STOCKS: Set<string> = new Set(
  SUPPORTED_CHAIN_IDS.flatMap((id) => {
    try {
      return stocksForChain(id).map((x) => x.symbol.toUpperCase())
    } catch {
      return []
    }
  }),
)

export const STOCK_BRAND: Record<string, string> = {
  // the eight the registry ships today
  TSLA: '#E82127', AAPL: '#1D1D1F', NVDA: '#76B900', MSFT: '#00A4EF',
  GOOGL: '#4285F4', SPY: '#C8102E', QQQ: '#003DA5', SLV: '#A6ADB4',
  // mega-cap tech, for when the registry grows
  AMZN: '#FF9900', META: '#0866FF', NFLX: '#E50914', AMD: '#ED1C24',
  INTC: '#0071C5', AVGO: '#CC092F', ORCL: '#C74634', CRM: '#00A1E0',
  ADBE: '#FA0F00', CSCO: '#1BA0D7', IBM: '#0F62FE', QCOM: '#3253DC',
  TXN: '#CC0000', MU: '#0084C9', ARM: '#0091BD', SMCI: '#0A6EB4',
  PLTR: '#101113', SNOW: '#29B5E8', DDOG: '#632CA6', NET: '#F38020',
  CRWD: '#E01A2B', PANW: '#FA582D', TEAM: '#0052CC', NOW: '#62D84E',
  MDB: '#00ED64', OKTA: '#007DC1', ZM: '#0B5CFF', TWLO: '#F22F46',
  // crypto-adjacent
  COIN: '#0052FF', HOOD: '#00C805', MSTR: '#F05A28',
  // consumer + platforms
  DIS: '#113CCF', SBUX: '#00704A', MCD: '#FFC72C', NKE: '#111111',
  KO: '#F40009', PEP: '#004B93', WMT: '#0071CE', TGT: '#CC0000',
  COST: '#E32831', HD: '#F96302', LOW: '#004990', SPOT: '#1DB954',
  UBER: '#10101B', ABNB: '#FF5A5F', DASH: '#FF3008', LYFT: '#FF00BF',
  RBLX: '#E2231A', SNAP: '#FFFC00', PINS: '#E60023', SHOP: '#95BF47',
  GME: '#EC1D24', AMC: '#C8102E',
  // industrials, energy, autos
  BA: '#0039A6', F: '#003478', GM: '#0170CE', XOM: '#E31837', CVX: '#0054A0',
  // financials
  V: '#1A1F71', MA: '#EB001B', PYPL: '#003087', JPM: '#005EB8',
  BAC: '#E31837', WFC: '#D71E28', GS: '#0033A0', MS: '#002B49',
  // health
  LLY: '#D52B1E', PFE: '#0093D0', JNJ: '#D51900', UNH: '#002677', MRNA: '#061F5C',
  // telco
  T: '#00A8E0', VZ: '#EE0000',
  // funds and commodities — deliberately quieter than the single names, so a
  // basket of ETFs does not read as louder than the companies inside it
  VOO: '#96151D', VTI: '#96151D', IWM: '#2B3A42', DIA: '#1B4E9B',
  GLD: '#D4AF37', TLT: '#4A6FA5', ARKK: '#2B2B2B',
}

/** Majors and well-known tokens whose brand colour is unambiguous. Merged into
 *  TOKEN_META below, so an entry there with a pinned ADDRESS still wins. */
const TOKEN_BRAND: Record<string, string> = {
  BTC: '#F7931A', WBTC: '#F7931A', CBBTC: '#F7931A',
  USDC: '#2775CA', USDT: '#26A17B', DAI: '#F5AC37', USDG: '#1652F0',
  PYUSD: '#0070E0', FDUSD: '#C7A26B', GHO: '#4ABDAC', LUSD: '#745DDF',
  SOL: '#14F195', BNB: '#F3BA2F', XRP: '#23292F', ADA: '#0033AD',
  DOT: '#E6007A', AVAX: '#E84142', TRX: '#EB0029', TON: '#0098EA',
  MATIC: '#8247E5', POL: '#8247E5', ARB: '#12AAFF', OP: '#FF0420',
  SUI: '#4DA2FF', APT: '#1A1A1A', SEI: '#9E1F19', TIA: '#7B2BF9',
  INJ: '#0F82FF', NEAR: '#00EC97', ATOM: '#2E3148', ICP: '#3B00B9',
  UNI: '#FF007A', SUSHI: '#FA52A0', CRV: '#3465A4', MKR: '#1AAB9B',
  COMP: '#00D395', LDO: '#00A3FF', SNX: '#00D1FF', PENDLE: '#33B3AE',
  ENA: '#1E1E24', ONDO: '#1B4EFF', ETHFI: '#2761E7', EIGEN: '#1A0C6D',
  GRT: '#6747ED', ENS: '#5298FF', BLUR: '#FF7B00', RNDR: '#CF1011',
  FET: '#1B1F3B', JUP: '#C7F284', RAY: '#3B82F6', CAKE: '#D1884F',
  DOGE: '#C2A633', SHIB: '#FFA409', PEPE: '#3D8130', BONK: '#FFAB01',
  WIF: '#C89B6D', FLOKI: '#F0A500', MOG: '#E8B84B',
  AERO: '#1F5EFF', DEGEN: '#A36EFD', BRETT: '#2151F5', TOSHI: '#1E7CF0',
  MORPHO: '#2E4DFF', SYRUP: '#F26522', WELL: '#1F7AE0', PRIME: '#1B1B1F',
  STETH: '#00A3FF', WSTETH: '#00A3FF', CBETH: '#0052FF', RETH: '#FF9776',
  SPX: '#C9A227', ZORA: '#000000', VIRTUAL: '#49A59F',
}

/** Company domains for tokenised equities — the key to a REAL logo.
 *
 *  Robinhood's own CDN serves the ROBINHOOD FEATHER for every tokenised stock
 *  (verified by fetching it: NVDA, AAPL and TSLA all return the same 180x180
 *  feather PNG). So the address-keyed source can never produce a company mark,
 *  and the only way to get one is to know the company. Hence a domain map.
 *
 *  Same registry gate as STOCK_BRAND: a token calling itself TSLA cannot reach
 *  tesla.com, because `stockLogoUrl` only answers for symbols the stock
 *  registry actually lists. */
const STOCK_DOMAIN: Record<string, string> = {
  TSLA: 'tesla.com', AAPL: 'apple.com', NVDA: 'nvidia.com', MSFT: 'microsoft.com',
  GOOGL: 'abc.xyz', AMZN: 'amazon.com', META: 'meta.com', NFLX: 'netflix.com',
  AMD: 'amd.com', INTC: 'intel.com', AVGO: 'broadcom.com', ORCL: 'oracle.com',
  CRM: 'salesforce.com', ADBE: 'adobe.com', CSCO: 'cisco.com', IBM: 'ibm.com',
  QCOM: 'qualcomm.com', TXN: 'ti.com', MU: 'micron.com', ARM: 'arm.com',
  SMCI: 'supermicro.com', PLTR: 'palantir.com', SNOW: 'snowflake.com',
  DDOG: 'datadoghq.com', NET: 'cloudflare.com', CRWD: 'crowdstrike.com',
  PANW: 'paloaltonetworks.com', TEAM: 'atlassian.com', NOW: 'servicenow.com',
  MDB: 'mongodb.com', OKTA: 'okta.com', ZM: 'zoom.us', TWLO: 'twilio.com',
  COIN: 'coinbase.com', HOOD: 'robinhood.com', MSTR: 'microstrategy.com',
  DIS: 'disney.com', SBUX: 'starbucks.com', MCD: 'mcdonalds.com', NKE: 'nike.com',
  KO: 'coca-colacompany.com', PEP: 'pepsico.com', WMT: 'walmart.com',
  TGT: 'target.com', COST: 'costco.com', HD: 'homedepot.com', LOW: 'lowes.com',
  SPOT: 'spotify.com', UBER: 'uber.com', ABNB: 'airbnb.com', DASH: 'doordash.com',
  LYFT: 'lyft.com', RBLX: 'roblox.com', SNAP: 'snap.com', PINS: 'pinterest.com',
  SHOP: 'shopify.com', GME: 'gamestop.com', AMC: 'amctheatres.com',
  BA: 'boeing.com', F: 'ford.com', GM: 'gm.com', XOM: 'exxonmobil.com',
  CVX: 'chevron.com', V: 'visa.com', MA: 'mastercard.com', PYPL: 'paypal.com',
  JPM: 'jpmorganchase.com', BAC: 'bankofamerica.com', WFC: 'wellsfargo.com',
  GS: 'goldmansachs.com', MS: 'morganstanley.com', LLY: 'lilly.com',
  PFE: 'pfizer.com', JNJ: 'jnj.com', UNH: 'unitedhealthgroup.com',
  MRNA: 'modernatx.com', T: 'att.com', VZ: 'verizon.com',
  SPY: 'ssga.com', QQQ: 'invesco.com', SLV: 'ishares.com', VOO: 'vanguard.com',
  VTI: 'vanguard.com', IWM: 'ishares.com', DIA: 'ssga.com', GLD: 'ssga.com',
  TLT: 'ishares.com', ARKK: 'ark-funds.com',
}

/** A real company logo for a REGISTRY-VERIFIED stock, or null.
 *
 *  Keyless and CORS-friendly (gstatic), returns PNG. It is a favicon service,
 *  so the mark is 48px — fine at the 20–40px we draw logos at, and infinitely
 *  better than the feather it replaces. Null for anything unlisted, which puts
 *  the caller straight back on the existing ladder. */
export function stockLogoUrl(symbol: string | undefined): string | null {
  const sym = symbol?.toUpperCase()
  if (!sym || !REGISTRY_STOCKS.has(sym)) return null
  const domain = STOCK_DOMAIN[sym]
  if (!domain) return null
  return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=128`
}

export function readableInk(hex: string): string {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? '#34203B' : '#F4F0F4'
}

// The brand bank fills every symbol the curated map above does not already
// pin. Address-pinned entries WIN — they exist because a specific contract
// needed a specific answer, and a generic brand colour must not undo that.
for (const [sym, color] of Object.entries(TOKEN_BRAND)) {
  if (!TOKEN_META[sym]) TOKEN_META[sym] = { color, ink: readableInk(color) }
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
  // REGISTRY-VERIFIED STOCKS get their brand colour. The gate is the stock
  // registry itself, not the symbol string, so an ERC-20 calling itself TSLA
  // never reaches Tesla red — it falls through to the hashed hue like any
  // other unknown token.
  const sym = symbol?.toUpperCase()
  if (sym && REGISTRY_STOCKS.has(sym) && STOCK_BRAND[sym]) {
    const color = STOCK_BRAND[sym]
    return { color, ink: readableInk(color) }
  }
  const ex = EXTRACTED.get(address.toLowerCase())
  if (ex) return ex
  const color = hslToHex(hashHue(address), 0.5, 0.42)
  return { color, ink: readableInk(color) }
}
