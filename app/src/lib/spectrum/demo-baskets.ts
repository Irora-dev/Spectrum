import type { Address } from 'viem'
import { showSymbol } from './safe-copy'
import type { BasketData, BasketSummary, Holding, NavPoint } from './basket-data'
import type { ChartRange } from './history'
import type { VerifiedCreatorMeta } from './creator-metadata'

// ─────────────────────────────────────────────────────────────────────────────
// TRAILER DEMO BASKETS (owner 2026-07-30: "create a bunch of demo baskets I can
// open on different tabs, lots of different assets, bento colours, dither chart
// colours, names, tickers — say 20").
//
// Twenty HAND-COMPOSED baskets, not random seeds, plus one THESIS TRIPLET
// (owner 2026-08-09: a demo thesis of three baskets across three chains so the
// /thesis page and its flow are walkable — see the triplet's own note at the
// bottom of the list). Each single is a deliberate look, so every tab in the
// trailer is visibly a different site. Variety is engineered along the axes
// that actually show on camera:
//   · asset mix — blue chips · memes · AI · DeFi · LSTs · RWA · tokenized stocks
//   · palette   — every basket's legs are chosen for a distinct colour family,
//                 because the bento tiles AND the dither chart fill are built
//                 from the LEG colours (weight-proportioned gradient)
//   · leg count — 2 to 7, so the bento geometry differs page to page
//   · chain     — Base, Ethereum and Robinhood (stock+crypto mixes)
//   · shape     — NAV curves are per-basket (trend, chop, one optional swing)
//
// Addresses are REAL for the legs (so real logos + the repo's own baked brand
// colours resolve), synthetic for the baskets themselves: `…de50NNNN`. DEV-ONLY,
// reached through dev-fixture's dynamic import and self-gated on that pattern.
//
// Open them from `npm run dev` with:  /token?addr=<addr>&chain=<chain>
// `demoBasketUrls()` prints the full list (scripts/demo-basket-urls.ts).
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_RE = /de50([0-9a-f]{4})$/i
const RH = 4663
const ETH = 1
const BASE = 8453

/** The synthetic address for demo N. */
export function demoAddress(n: number): Address {
  return `0x${'0'.repeat(32)}de50${(n & 0xffff).toString(16).padStart(4, '0')}` as Address
}

// ── the leg library: real addresses, so logos + baked colours are real ───────
// The comment on each is the colour the kit already resolves for it, which is
// how the palettes below were composed.
type Leg = { asset: string; symbol: string; name: string; decimals: number; priceUsd: number }
const T = {
  // blue chips / L1s
  WETH: { asset: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, priceUsd: 2600 }, // periwinkle
  WBTC: { asset: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, priceUsd: 67000 }, // orange
  LINK: { asset: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', name: 'Chainlink', decimals: 18, priceUsd: 14.2 }, // blue
  ARB: { asset: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', symbol: 'ARB', name: 'Arbitrum', decimals: 18, priceUsd: 0.62 }, // steel blue
  POL: { asset: '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6', symbol: 'POL', name: 'Polygon', decimals: 18, priceUsd: 0.38 }, // violet
  // DeFi
  UNI: { asset: '0xc3De830EA07524a0761646a6a4e4be0e114a3C83', symbol: 'UNI', name: 'Uniswap', decimals: 18, priceUsd: 8.9 }, // pink
  AAVE: { asset: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', symbol: 'AAVE', name: 'Aave', decimals: 18, priceUsd: 142 }, // slate blue
  CRV: { asset: '0xD533a949740bb3306d119CC777fa900bA034cd52', symbol: 'CRV', name: 'Curve', decimals: 18, priceUsd: 0.42 }, // olive
  COMP: { asset: '0xc00e94Cb662C3520282E6f5717214004A7f26888', symbol: 'COMP', name: 'Compound', decimals: 18, priceUsd: 48 }, // green
  SNX: { asset: '0x22e6966B799c4D5B13BE962E1D117b56327FDa66', symbol: 'SNX', name: 'Synthetix', decimals: 18, priceUsd: 1.9 }, // deep blue
  PENDLE: { asset: '0x808507121B80c02388fAd14726482e061B8da827', symbol: 'PENDLE', name: 'Pendle', decimals: 18, priceUsd: 4.3 }, // navy
  MORPHO: { asset: '0x58D97B57BB95320F9a05dC918Aef65434969c2B2', symbol: 'MORPHO', name: 'Morpho', decimals: 18, priceUsd: 1.6 }, // bright blue
  AERO: { asset: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', name: 'Aerodrome', decimals: 18, priceUsd: 0.85 }, // dusty rose
  // staking / LST + restaking
  LDO: { asset: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', symbol: 'LDO', name: 'Lido DAO', decimals: 18, priceUsd: 1.1 }, // clay
  ETHFI: { asset: '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB', symbol: 'ETHFI', name: 'ether.fi', decimals: 18, priceUsd: 1.4 }, // indigo
  EIGEN: { asset: '0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83', symbol: 'EIGEN', name: 'EigenLayer', decimals: 18, priceUsd: 2.7 }, // indigo
  // memes
  PEPE: { asset: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE', name: 'Pepe', decimals: 18, priceUsd: 0.0000098 }, // green
  SHIB: { asset: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', symbol: 'SHIB', name: 'Shiba Inu', decimals: 18, priceUsd: 0.0000162 }, // orange
  MOG: { asset: '0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a', symbol: 'MOG', name: 'Mog Coin', decimals: 18, priceUsd: 0.0000012 }, // deep blue
  DEGEN: { asset: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN', name: 'Degen', decimals: 18, priceUsd: 0.012 }, // violet
  TOSHI: { asset: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', symbol: 'TOSHI', name: 'Toshi', decimals: 18, priceUsd: 0.00042 }, // sky blue
  SPX: { asset: '0x50dA645f148798F68EF2d7dB7C1CB22A6819bb2C', symbol: 'SPX', name: 'SPX6900', decimals: 8, priceUsd: 0.72 }, // gold
  // AI
  VIRTUAL: { asset: '0x44ff8620b8cA30902395A7bD3F2407e1A091BF73', symbol: 'VIRTUAL', name: 'Virtuals Protocol', decimals: 18, priceUsd: 1.9 }, // mint
  AIXBT: { asset: '0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825', symbol: 'AIXBT', name: 'aixbt', decimals: 18, priceUsd: 0.28 }, // purple
  FET: { asset: '0x74F804B4140ee70830B3Eef4e690325841575F89', symbol: 'FET', name: 'Artificial Superintelligence', decimals: 18, priceUsd: 1.3 }, // slate
  // RWA / yield-bearing
  ONDO: { asset: '0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3', symbol: 'ONDO', name: 'Ondo', decimals: 18, priceUsd: 0.98 }, // periwinkle
  SKY: { asset: '0x56072C95FAA701256059aa122697B133aDEd9279', symbol: 'SKY', name: 'Sky', decimals: 18, priceUsd: 0.078 }, // lilac
  MKR: { asset: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', symbol: 'MKR', name: 'Maker', decimals: 18, priceUsd: 1420 }, // teal
  RSR: { asset: '0xaB36452DbAC151bE02b16Ca17d8919826072f64a', symbol: 'RSR', name: 'Reserve Rights', decimals: 18, priceUsd: 0.0091 }, // blue
  DIA: { asset: '0x84cA8bc7997272c7CfB4D0Cd3D55cd942B3c9419', symbol: 'DIA', name: 'DIA', decimals: 18, priceUsd: 0.42 }, // magenta
  // stables
  USDC: { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, priceUsd: 1 },
  DAI: { asset: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai', decimals: 18, priceUsd: 1 }, // amber
  // Robinhood Chain natives + settlement
  USDG: { asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', name: 'Global Dollar', decimals: 6, priceUsd: 1 },
  RHWETH: { asset: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, priceUsd: 2600 },
  CASHCAT: { asset: '0x020bfC650A365f8BB26819deAAbF3E21291018b4', symbol: 'CASHCAT', name: 'CashCat', decimals: 18, priceUsd: 0.0021 }, // acid green
  HOODRAT: { asset: '0x9771fE3a4b392A7Dd5Bba1aB19B1Cc4996E4808A', symbol: 'HOODRAT', name: 'Hoodrat', decimals: 18, priceUsd: 0.00087 }, // lime
  // tokenized stocks (official Robinhood Chain registry — see chain/stocks.ts)
  NVDA: { asset: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', symbol: 'NVDA', name: 'NVIDIA', decimals: 18, priceUsd: 128 },
  AAPL: { asset: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', symbol: 'AAPL', name: 'Apple', decimals: 18, priceUsd: 232 },
  TSLA: { asset: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', symbol: 'TSLA', name: 'Tesla', decimals: 18, priceUsd: 248 },
  MSFT: { asset: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', symbol: 'MSFT', name: 'Microsoft', decimals: 18, priceUsd: 428 },
  GOOGL: { asset: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', symbol: 'GOOGL', name: 'Alphabet', decimals: 18, priceUsd: 178 },
  SPY: { asset: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', symbol: 'SPY', name: 'SPDR S&P 500 ETF', decimals: 18, priceUsd: 560 },
  QQQ: { asset: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', symbol: 'QQQ', name: 'Invesco QQQ ETF', decimals: 18, priceUsd: 495 },
  SLV: { asset: '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f', symbol: 'SLV', name: 'iShares Silver ETF', decimals: 18, priceUsd: 28 },
} satisfies Record<string, Leg>

interface DemoSpec {
  name: string
  symbol: string
  chainId: number
  /** [leg, target weight %] — weights are normalised, so they need not sum to 100. */
  legs: [Leg, number][]
  navPerToken: number
  aumUsd: number
  change24hPct: number
  /** NAV curve character: total drift % over the window, and how choppy. */
  drift: number
  chop: number
  tagline: string
  thesis: string
  sectors: string[]
  /** Which of the five demo creators deployed it (varies the creator chip). */
  creator: number
}

// The thesis triplet shares ONE pitch, stated once — the same product on three
// chains restated three times is three literals waiting to diverge (the exact
// shape of the 40bps fee drift: two independent statements of one fact).
const AICYCLE_TAGLINE = 'One idea, every venue it trades on.'
const AICYCLE_THESIS =
  'AI exposure wherever it actually lives: the tokenized megacaps building the compute, the mainnet networks pricing it, and the Base agent economy spending it. One thesis, shipped to three chains, weighted by where the money already is.'

// The twenty, then the triplet. Ordered so consecutive tabs look maximally
// different — colour family and leg count both change every row, which is what
// a cut between tabs actually shows. APPEND ONLY: an address is its index
// (…de50NNNN), so inserting mid-list would silently re-point every demo URL
// after the insertion at a different basket.
const DEMO: DemoSpec[] = [
  {
    name: 'Bedrock Majors', symbol: 'BEDROCK', chainId: BASE,
    legs: [[T.WETH, 45], [T.WBTC, 35], [T.LINK, 20]],
    navPerToken: 1.184, aumUsd: 612_400, change24hPct: 2.4, drift: 18, chop: 0.8,
    tagline: 'The two that matter, plus the oracle.',
    thesis: 'The most liquid onchain assets in one token, weighted once at launch and never touched again. No rotation, no discretion, no drift.',
    sectors: ['Blue chip'], creator: 0,
  },
  {
    name: 'Frog Season', symbol: 'FROGS', chainId: ETH,
    legs: [[T.PEPE, 40], [T.SHIB, 25], [T.MOG, 20], [T.SPX, 15]],
    navPerToken: 0.842, aumUsd: 88_900, change24hPct: -6.8, drift: -12, chop: 3.1,
    tagline: 'All of it, or none of it.',
    thesis: 'The four memes with real volume and real holders, held as one position so you stop picking. Volatile on purpose.',
    sectors: ['Memes', 'Culture'], creator: 3,
  },
  {
    name: 'Agent Complex', symbol: 'AGENTS', chainId: BASE,
    legs: [[T.VIRTUAL, 40], [T.AIXBT, 32], [T.FET, 28]],
    navPerToken: 2.106, aumUsd: 241_800, change24hPct: 9.1, drift: 44, chop: 2.6,
    tagline: 'The agent economy, one ticker.',
    thesis: 'Onchain AI is a basket trade: nobody knows which agent framework wins, and the whole sector re-rates together. Sized for that.',
    sectors: ['AI', 'Base'], creator: 1,
  },
  {
    name: 'Money Legos', symbol: 'LEGOS', chainId: ETH,
    legs: [[T.UNI, 26], [T.AAVE, 24], [T.MORPHO, 20], [T.PENDLE, 16], [T.CRV, 8], [T.COMP, 6]],
    navPerToken: 1.061, aumUsd: 398_200, change24hPct: 1.2, drift: 9, chop: 1.2,
    tagline: 'The protocols the rest of DeFi is built on.',
    thesis: 'Six lending and trading venues that have survived every cycle since 2020, weighted by how much of DeFi actually routes through them.',
    sectors: ['DeFi'], creator: 0,
  },
  {
    name: 'Stocks And Chain', symbol: 'STKCHN', chainId: RH,
    legs: [[T.NVDA, 30], [T.MSFT, 22], [T.AAPL, 20], [T.RHWETH, 18], [T.USDG, 10]],
    navPerToken: 1.318, aumUsd: 724_600, change24hPct: 0.7, drift: 22, chop: 0.6,
    tagline: 'Big tech and blockspace in one position.',
    thesis: 'Tokenized megacaps beside the asset that settles them. The same basket a normal portfolio would want, except it clears onchain and never closes.',
    sectors: ['Stocks', 'Onchain'], creator: 2,
  },
  {
    name: 'Liquid Staking', symbol: 'LSTACK', chainId: ETH,
    legs: [[T.LDO, 38], [T.ETHFI, 34], [T.EIGEN, 28]],
    navPerToken: 0.918, aumUsd: 156_300, change24hPct: -2.1, drift: -8, chop: 1.6,
    tagline: 'Everyone staking everyone else.',
    thesis: 'The businesses that route staked ETH and restaked security. One bet, three balance sheets.',
    sectors: ['DeFi'], creator: 4,
  },
  {
    name: 'Silicon Seven', symbol: 'SIL7', chainId: RH,
    legs: [[T.NVDA, 22], [T.MSFT, 18], [T.AAPL, 16], [T.GOOGL, 16], [T.TSLA, 14], [T.QQQ, 14]],
    navPerToken: 1.472, aumUsd: 1_140_000, change24hPct: 1.9, drift: 31, chop: 0.7,
    tagline: 'The index everyone owns, held properly.',
    thesis: 'The names that carry the market, weighted at launch and left alone. Trades whenever you are awake, not when the exchange is.',
    sectors: ['Stocks', 'Macro'], creator: 2,
  },
  {
    name: 'Base Natives', symbol: 'BASENAT', chainId: BASE,
    legs: [[T.AERO, 34], [T.DEGEN, 24], [T.TOSHI, 22], [T.VIRTUAL, 20]],
    navPerToken: 1.664, aumUsd: 132_700, change24hPct: 7.3, drift: 52, chop: 2.9,
    tagline: 'Built here, stays here.',
    thesis: 'Four tokens that only exist because Base does: the DEX, the culture coin, the mascot and the agent launchpad.',
    sectors: ['Base', 'Culture'], creator: 1,
  },
  {
    name: 'Hard Money', symbol: 'HARD', chainId: ETH,
    legs: [[T.WBTC, 60], [T.WETH, 40]],
    navPerToken: 1.291, aumUsd: 2_480_000, change24hPct: 3.1, drift: 26, chop: 0.9,
    tagline: 'Two assets. Nothing else.',
    thesis: 'The simplest basket that exists, and the one most portfolios actually want: sixty forty, rebalanced never.',
    sectors: ['Blue chip', 'Macro'], creator: 0,
  },
  {
    name: 'Real World Yield', symbol: 'RWYLD', chainId: ETH,
    legs: [[T.ONDO, 32], [T.SKY, 26], [T.MKR, 24], [T.RSR, 18]],
    navPerToken: 1.052, aumUsd: 287_500, change24hPct: 0.4, drift: 6, chop: 0.5,
    tagline: 'The boring core, done properly.',
    thesis: 'Protocols whose revenue comes from treasuries and credit rather than speculation. The least exciting basket here on purpose.',
    sectors: ['Macro'], creator: 4,
  },
  {
    name: 'Robinhood Street', symbol: 'RHST', chainId: RH,
    legs: [[T.CASHCAT, 34], [T.HOODRAT, 28], [T.RHWETH, 22], [T.USDG, 16]],
    navPerToken: 0.774, aumUsd: 41_200, change24hPct: -9.4, drift: -22, chop: 3.8,
    tagline: 'The chain’s own degens.',
    thesis: 'Robinhood Chain natives with a stable floor underneath. Small, loud, and entirely onchain.',
    sectors: ['Memes', 'Onchain'], creator: 3,
  },
  {
    name: 'Oracle And Order', symbol: 'ORACLE', chainId: ETH,
    legs: [[T.LINK, 46], [T.PENDLE, 28], [T.DIA, 26]],
    navPerToken: 1.208, aumUsd: 198_400, change24hPct: 2.8, drift: 17, chop: 1.4,
    tagline: 'Nothing prices without them.',
    thesis: 'Data and rates infrastructure. Unglamorous, load bearing, and paid on volume rather than narrative.',
    sectors: ['DeFi'], creator: 0,
  },
  {
    name: 'Chips And Cars', symbol: 'CHIPS', chainId: RH,
    legs: [[T.NVDA, 52], [T.TSLA, 30], [T.USDG, 18]],
    navPerToken: 1.906, aumUsd: 508_900, change24hPct: 4.6, drift: 63, chop: 2.2,
    tagline: 'The two most argued about tickers.',
    thesis: 'A concentrated pair with a cash sleeve, for the view that the compute build out and the fleet are the same trade.',
    sectors: ['Stocks', 'Growth'], creator: 2,
  },
  {
    name: 'Layer Two', symbol: 'L2', chainId: ETH,
    legs: [[T.ARB, 40], [T.POL, 34], [T.WETH, 26]],
    navPerToken: 0.881, aumUsd: 119_600, change24hPct: -3.7, drift: -14, chop: 1.9,
    tagline: 'Blockspace, wholesale.',
    thesis: 'Scaling tokens beside the asset they scale. Held as one line because their fortunes move together and nobody calls the winner early.',
    sectors: ['Onchain'], creator: 1,
  },
  {
    name: 'Cash And Carry', symbol: 'CARRY', chainId: BASE,
    legs: [[T.USDC, 50], [T.WETH, 30], [T.WBTC, 20]],
    navPerToken: 1.094, aumUsd: 946_300, change24hPct: 1.1, drift: 11, chop: 0.4,
    tagline: 'Half asleep, half awake.',
    thesis: 'A stable half with a blue chip half. The basket to hold when you want exposure without the whole heart rate.',
    sectors: ['Blue chip', 'Macro'], creator: 4,
  },
  {
    name: 'Perp Desk', symbol: 'PERPS', chainId: ETH,
    legs: [[T.SNX, 38], [T.PENDLE, 34], [T.MORPHO, 28]],
    navPerToken: 1.376, aumUsd: 173_800, change24hPct: 5.2, drift: 29, chop: 2.4,
    tagline: 'Where the leverage lives.',
    thesis: 'The venues that price risk onchain. Cyclical by nature, so it is sized for volatility instead of against it.',
    sectors: ['DeFi', 'Growth'], creator: 3,
  },
  {
    name: 'Silver Lining', symbol: 'SILVER', chainId: RH,
    legs: [[T.SLV, 44], [T.SPY, 32], [T.USDG, 24]],
    navPerToken: 1.121, aumUsd: 364_100, change24hPct: 0.9, drift: 13, chop: 0.7,
    tagline: 'Metal, market, money.',
    thesis: 'A hedge sleeve and a market sleeve in the same token, for the view that you should own some of both and rebalance neither.',
    sectors: ['Macro', 'Stocks'], creator: 2,
  },
  {
    name: 'Everything Base', symbol: 'ALLBASE', chainId: BASE,
    legs: [[T.WETH, 24], [T.AERO, 18], [T.VIRTUAL, 16], [T.DEGEN, 14], [T.TOSHI, 12], [T.USDC, 10], [T.MORPHO, 6]],
    navPerToken: 1.238, aumUsd: 219_700, change24hPct: 3.9, drift: 24, chop: 2.1,
    tagline: 'One token for the whole chain.',
    thesis: 'Seven legs across trading, culture, agents and settlement. The widest basket here, and the closest thing to owning Base itself.',
    sectors: ['Base', 'Onchain'], creator: 1,
  },
  {
    name: 'Stable Curve', symbol: 'SCURVE', chainId: ETH,
    legs: [[T.DAI, 55], [T.CRV, 25], [T.MKR, 20]],
    navPerToken: 1.017, aumUsd: 431_200, change24hPct: 0.2, drift: 3, chop: 0.3,
    tagline: 'Flat on purpose.',
    thesis: 'A stablecoin core with the two protocols that issue and route it. Built to be dull and to keep being dull.',
    sectors: ['DeFi', 'Macro'], creator: 4,
  },
  {
    name: 'Nightcap', symbol: 'NIGHT', chainId: BASE,
    legs: [[T.DEGEN, 46], [T.TOSHI, 30], [T.SPX, 24]],
    navPerToken: 0.694, aumUsd: 27_800, change24hPct: -11.2, drift: -31, chop: 4.2,
    tagline: 'Not for the faint of heart.',
    thesis: 'The high beta corner, held small and honestly labelled. Three culture tokens with nothing defensive underneath.',
    sectors: ['Memes', 'Culture'], creator: 3,
  },

  // ── THE THESIS TRIPLET (owner 2026-08-09: "a demo thesis with 3 demo baskets
  // cross chain so I can see the page/flow"). ONE create session's output: the
  // SAME name, ticker and creator on three chains — exactly what the create
  // flow ships when a draft spans networks (one AllocationDraft carries one
  // name + one symbol), so the thesis grouper's (deployer, name) key recognises
  // them as one product with no special-casing. AUMs are DISTINCT on purpose:
  // thesisNeeds() splits a buy by each leg's share of the total, and equal legs
  // would render a 33/33/33 split that reads like a default instead of a
  // computation. Legs differ per chain because that is the honest cross-chain
  // story — the same idea expressed in each network's own assets. ──
  {
    name: 'AI Supercycle', symbol: 'AICYCLE', chainId: RH,
    legs: [[T.NVDA, 45], [T.MSFT, 25], [T.GOOGL, 20], [T.USDG, 10]],
    navPerToken: 1.242, aumUsd: 868_000, change24hPct: 1.8, drift: 21, chop: 0.9,
    tagline: AICYCLE_TAGLINE, thesis: AICYCLE_THESIS,
    sectors: ['AI', 'Cross-chain'], creator: 1,
  },
  {
    name: 'AI Supercycle', symbol: 'AICYCLE', chainId: BASE,
    legs: [[T.VIRTUAL, 45], [T.AIXBT, 35], [T.WETH, 20]],
    navPerToken: 1.579, aumUsd: 412_000, change24hPct: 6.2, drift: 38, chop: 2.4,
    tagline: AICYCLE_TAGLINE, thesis: AICYCLE_THESIS,
    sectors: ['AI', 'Cross-chain'], creator: 1,
  },
  {
    name: 'AI Supercycle', symbol: 'AICYCLE', chainId: ETH,
    legs: [[T.FET, 40], [T.LINK, 35], [T.WETH, 25]],
    navPerToken: 1.104, aumUsd: 236_000, change24hPct: 3.1, drift: 16, chop: 1.7,
    tagline: AICYCLE_TAGLINE, thesis: AICYCLE_THESIS,
    sectors: ['AI', 'Cross-chain'], creator: 1,
  },
]

const CREATORS = [
  { handle: '@fixedweights', name: 'Fixed Weights' },
  { handle: '@basedresearch', name: 'Based Research' },
  { handle: '@onchainmaxi', name: 'Onchain Maxi' },
  { handle: '@memeticcap', name: 'Memetic Capital' },
  { handle: '@yieldsmith', name: 'Yieldsmith' },
] as const

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A NAV walk with the spec's character — deterministic per basket, so a retake
 *  films the same chart. 15 hourly points by default, one optional swing; the
 *  window generalizes through (points, stepSec) for the range picker, with the
 *  rng call order and the per-step drift share (drift/(points-1) = /14 at the
 *  default) kept EXACTLY as they were, so every existing demo curve is
 *  byte-identical. */
function series(seed: number, drift: number, chop: number, points = 15, stepSec = 3600): NavPoint[] {
  const rng = mulberry32(seed * 2654435761)
  const nowSec = Math.floor(Date.now() / 1000)
  const swingSlot = rng() < 0.5 ? 4 + Math.floor(rng() * 8) : -1
  const swingAt = swingSlot < 0 ? -1 : Math.round((swingSlot / 14) * (points - 1))
  const swing = (rng() - 0.45) * chop * 3
  let v = 100
  const out: NavPoint[] = []
  for (let i = 0; i < points; i++) {
    v += (rng() - 0.5) * chop + drift / (points - 1)
    if (i === swingAt) v += swing
    out.push({ time: nowSec - (points - 1 - i) * stepSec, value: Math.max(1, v) })
  }
  return out
}

/** The walk over a CHOSEN chart window — the thesis page's range pills on a
 *  demo bundle. Nothing about a demo basket is fetchable (its legs can be
 *  local-only paper like the RH stocks), so the stage extends the walk in
 *  kind instead of dead-ending every pill in "no readable history": same
 *  deterministic character per basket, a per-range seed salt so a week is
 *  not a stretched photocopy of the day, drift scaled up with the window so
 *  longer roads travel further, and the ALL window bounded by the same
 *  ageDays law demoBasket states. '24H' returns the exact series the
 *  summaries already carry. DEV-only like everything here — reach it through
 *  a dynamic import, never statically. */
export function demoRangeSeries(address: string, range: ChartRange): NavPoint[] | null {
  const i = indexOf(address)
  if (i == null) return null
  const spec = DEMO[i]
  if (range === '24H') return series(i + 1, spec.drift, spec.chop)
  const ageDays = 11 + i * 17
  const plan =
    range === '7D'
      ? { points: 42, stepSec: 4 * 3600, driftX: 2, salt: 101 }
      : range === '30D'
        ? { points: Math.min(30, ageDays), stepSec: 86400, driftX: 3, salt: 211 }
        : { points: Math.min(ageDays, 120), stepSec: 86400, driftX: 4, salt: 307 }
  return series(i + 1 + plan.salt, spec.drift * plan.driftX, spec.chop, plan.points, plan.stepSec)
}

function indexOf(address: string): number | null {
  const m = DEMO_RE.exec(address)
  if (!m) return null
  const i = parseInt(m[1], 16)
  return i < DEMO.length ? i : null
}

/** Which chain a demo basket lives on (the runner and the fixture must agree). */
export function demoChain(i: number): number | null {
  return DEMO[i]?.chainId ?? null
}

export function demoBasket(address: Address, chainId: number): BasketData | null {
  const i = indexOf(address)
  if (i == null) return null
  const spec = DEMO[i]
  if (spec.chainId !== chainId) return null

  const rng = mulberry32((i + 1) * 7919)
  const weightSum = spec.legs.reduce((s, [, w]) => s + w, 0) || 1
  const holdings: Holding[] = spec.legs.map(([leg, w], li) => {
    const targetWeightPct = Math.round((w / weightSum) * 1000) / 10
    // live weights drift a little off target — that is what the strip shows
    const liveWeightPct = targetWeightPct * (0.9 + rng() * 0.2)
    const valueUsd = (liveWeightPct / 100) * spec.aumUsd
    return {
      asset: leg.asset,
      symbol: leg.symbol,
      name: leg.name,
      decimals: leg.decimals,
      targetWeightPct,
      balance: valueUsd / leg.priceUsd,
      priceUsd: leg.priceUsd,
      valueUsd,
      liveWeightPct,
      change24hPct: Math.round((rng() * 18 - 8) * 10) / 10,
      priced: true,
      series: series(i * 31 + li + 1, spec.drift * (0.6 + rng() * 0.9), spec.chop),
    }
  })
  const liveSum = holdings.reduce((s, h) => s + h.liveWeightPct, 0) || 1
  for (const h of holdings) {
    h.liveWeightPct = (h.liveWeightPct / liveSum) * 100
    h.valueUsd = (h.liveWeightPct / 100) * spec.aumUsd
    h.balance = h.valueUsd / h.priceUsd
  }

  const ageDays = 11 + i * 17
  return {
    chainId,
    address,
    name: spec.name,
    symbol: spec.symbol,
    decimals: 18,
    totalSupply: spec.aumUsd / spec.navPerToken,
    aumUsd: spec.aumUsd,
    navPerToken: spec.navPerToken,
    navSource: 'onchain',
    fullyPriced: true,
    navDivergencePct: Math.round(rng() * 9) / 10,
    change24hPct: spec.change24hPct,
    holdings,
    navSeries: series(i + 1, spec.drift, spec.chop),
    pricedCount: holdings.length,
    totalCount: holdings.length,
    inceptionTs: Math.floor(Date.now() / 1000) - ageDays * 86400,
    ageHours: ageDays * 24,
    deployer: `0x${'0'.repeat(36)}d0e${spec.creator + 1}` as Address,
    effectiveSupply: spec.aumUsd / spec.navPerToken,
    updatedAt: new Date().toISOString(),
  }
}

/** The signed creator thesis for a demo basket — so the thesis card reads alive
 *  on camera instead of "not published yet". */
export function demoMeta(address: string, chainId: number): VerifiedCreatorMeta | null {
  const i = indexOf(address)
  if (i == null) return null
  const spec = DEMO[i]
  if (spec.chainId !== chainId) return null
  const c = CREATORS[spec.creator]
  return {
    verified: true,
    deployer: `0x${'0'.repeat(36)}d0e${spec.creator + 1}` as Address,
    basket: address as Address,
    supersedes: null,
    handle: c.handle,
    xUrl: `https://x.com/${c.handle.slice(1)}`,
    name: c.name,
    avatarUrl: null,
    bannerUrl: null,
    tagline: spec.tagline,
    thesis: spec.thesis,
    sectors: [...spec.sectors],
    timeHorizon: spec.chop > 2.5 ? 'short-term' : spec.chop < 1 ? 'long-term' : 'mid-term',
    postUrl: null,
  } as VerifiedCreatorMeta
}

/** The demo fee config — so surfaces that READ the immutable fee shape (the
 *  fee panel, the reshape popup's verbatim carry) work on a demo subject.
 *  Deterministic per index, varied so nothing reads as a universal rate; the
 *  payout is the demo creator's own address, like every other demo identity. */
export function demoFees(address: string, chainId: number) {
  const i = indexOf(address)
  if (i == null) return null
  const spec = DEMO[i]
  if (spec.chainId !== chainId) return null
  return {
    basketFeeBps: 100 + (i % 3) * 50,
    creatorShareBps: (spec.creator + 1) * 500,
    creatorPayout: `0x${'0'.repeat(36)}d0e${spec.creator + 1}`,
    launcher: null,
    deployer: `0x${'0'.repeat(36)}d0e${spec.creator + 1}`,
  }
}

/** The demo baskets as DIRECTORY rows for a chain, so they appear everywhere the
 *  site lists baskets: Explore's grids and tabs, Home's spotlight + thesis grid,
 *  the swap picker, creator pages. Without this they existed only at their own
 *  URLs and nothing on the site linked to them (owner 2026-07-30: "where do I
 *  see these on the site"). Empty for a chain none of them live on. */
export function demoSummaries(chainId: number): BasketSummary[] {
  return DEMO.map((spec, i) => ({ spec, i }))
    .filter(({ spec }) => spec.chainId === chainId)
    .map(({ spec, i }) => {
      const weightSum = spec.legs.reduce((s, [, w]) => s + w, 0) || 1
      return {
        chainId,
        address: demoAddress(i),
        name: spec.name,
        symbol: spec.symbol,
        basketLength: spec.legs.length,
        navPerToken: spec.navPerToken,
        aumUsd: spec.aumUsd,
        change24hPct: spec.change24hPct,
        pricedCount: spec.legs.length,
        top: [...spec.legs]
          .sort((a, b) => b[1] - a[1])
          .map(([leg, w]) => ({
            address: leg.asset,
            symbol: leg.symbol,
            weightPct: Math.round((w / weightSum) * 1000) / 10,
          })),
        navSeries: series(i + 1, spec.drift, spec.chop),
        deployer: `0x${'0'.repeat(36)}d0e${spec.creator + 1}` as Address,
        supersededBy: null,
        // varied holder counts so the discovery rows don't all read identically
        holdersCount: 40 + i * 37,
      }
    })
}

/** Every demo basket as an openable dev URL — one per trailer tab. */
export function demoBasketUrls(origin = 'http://localhost:5311'): { label: string; url: string }[] {
  return DEMO.map((spec, i) => ({
    label: `${spec.name} ($${showSymbol(spec.symbol)}) · ${spec.legs.length} legs · chain ${spec.chainId}`,
    url: `${origin}/token?addr=${demoAddress(i)}&chain=${spec.chainId}`,
  }))
}

/** Count, for scripts + the fixture's summary listing. */
export const DEMO_COUNT = DEMO.length
