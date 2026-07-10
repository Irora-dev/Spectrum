import type { Address } from 'viem'
import { chainCfg, DEFAULT_CHAIN_ID } from '../chain/chains'
import { PROTOCOL_FEE_MODEL } from './fee-model'
import type { BasketData, BasketSummary, Holding, NavPoint } from './basket-data'
import type { VerifiedCreatorMeta } from './creator-metadata'
import type { FeeState, FrontendAccrual, FrontendRole } from './use-fee-state'
import type { BasketSnapshot, DeltaPreview, MigratePlanView, SnapLeg } from './use-migrate'
import { planRedeem } from './migrate-math'

// ─────────────────────────────────────────────────────────────────────────────
// DEV-ONLY mock basket fixture. The shipped default config is
// EMPTY (no factory, no baskets), which makes Home/Explore/Token blank.
// This fixture exists so reviewers can see a populated UI in `pnpm dev`/`npm run
// dev`. It is imported ONLY behind `import.meta.env.DEV` (dynamic import in
// basket-data.ts), so it is never part of a production bundle, and it only
// activates when the chain has NO factory configured — a configured deployment
// always wins.
//
// The mock basket addresses below are obviously synthetic. Constituents are
// well-known third-party Base tokens, used purely as cosmetic display facts
// (logos / brand colors) — they are not seeds, not curation, and not v1 data.
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_1 = '0x0000000000000000000000000000000000ba5e01'
const MOCK_2 = '0x0000000000000000000000000000000000ba5e02'
const MOCK_3 = '0x0000000000000000000000000000000000ba5e03' // v2 of MOCK_1 (same deployer)
const MOCK_DEPLOYER = '0x000000000000000000000000000000000000d0e0'
const MOCK_LAUNCHER = '0x000000000000000000000000000000000000d105'
// Design-review creators (each gets its own identity in MOCK_META below; C5
// stays metadata-less on purpose — the address-only, unverified path).
const MOCK_C1 = '0x000000000000000000000000000000000000c0e1'
const MOCK_C2 = '0x000000000000000000000000000000000000c0e2'
const MOCK_C3 = '0x000000000000000000000000000000000000c0e3'
const MOCK_C4 = '0x000000000000000000000000000000000000c0e4'
const MOCK_C5 = '0x000000000000000000000000000000000000c0e5'

interface MockLeg {
  asset: string
  symbol: string
  name: string
  decimals: number
  weightPct: number
  /** Current (drifted) pool weight; omitted ⇒ equals target. Normalized to 100 in holdings(). */
  liveWeightPct?: number
  priceUsd: number
  change24hPct: number
}

// liveWeightPct drifts from the launch target as the winners' share grows (WETH up,
// AERO down…) — so the Portfolio look-through's Live basis visibly differs from Target.
const LEGS_1: MockLeg[] = [
  { asset: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, weightPct: 40, liveWeightPct: 44, priceUsd: 2600, change24hPct: 1.8 },
  { asset: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, weightPct: 35, liveWeightPct: 36, priceUsd: 67000, change24hPct: 0.9 },
  { asset: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', name: 'Aerodrome', decimals: 18, weightPct: 25, liveWeightPct: 20, priceUsd: 0.85, change24hPct: -2.4 },
]

const LEGS_2: MockLeg[] = [
  { asset: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN', name: 'Degen', decimals: 18, weightPct: 50, liveWeightPct: 53, priceUsd: 0.012, change24hPct: 4.2 },
  { asset: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT', name: 'Brett', decimals: 18, weightPct: 50, liveWeightPct: 47, priceUsd: 0.09, change24hPct: -1.1 },
]

const T = {
  WETH: { asset: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, priceUsd: 2600 },
  cbBTC: { asset: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, priceUsd: 67000 },
  cbETH: { asset: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', decimals: 18, priceUsd: 2810 },
  USDC: { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, priceUsd: 1 },
  AERO: { asset: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', name: 'Aerodrome', decimals: 18, priceUsd: 0.85 },
  DEGEN: { asset: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN', name: 'Degen', decimals: 18, priceUsd: 0.012 },
  BRETT: { asset: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT', name: 'Brett', decimals: 18, priceUsd: 0.09 },
} as const
/** Shorthand leg builder for the design-review mocks. */
function leg(t: (typeof T)[keyof typeof T], weightPct: number, change24hPct: number, liveWeightPct?: number): MockLeg {
  return { ...t, weightPct, liveWeightPct, change24hPct }
}

// v2 of LEGS_1: AERO dropped, DEGEN added, WETH/cbBTC reweighted (a clear diff).
const LEGS_3: MockLeg[] = [
  { asset: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, weightPct: 45, liveWeightPct: 44, priceUsd: 2600, change24hPct: 1.8 },
  { asset: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, weightPct: 30, liveWeightPct: 28, priceUsd: 67000, change24hPct: 0.9 },
  { asset: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN', name: 'Degen', decimals: 18, weightPct: 25, liveWeightPct: 28, priceUsd: 0.012, change24hPct: 4.2 },
]

function series(seed: number, drift: number): NavPoint[] {
  const nowSec = Math.floor(Date.now() / 1000)
  return Array.from({ length: 15 }, (_, i) => ({
    time: nowSec - (14 - i) * 3600,
    value: 100 + Math.sin(seed + i / 2.2) * 1.6 + (i / 14) * drift,
  }))
}

function holdings(legs: MockLeg[], aumUsd: number, seed: number): Holding[] {
  // Live weights drift from target as prices move; normalize defensively so they
  // sum to 100 even if the fixture's deltas don't add up exactly. valueUsd tracks
  // the live (current) split, so Σ valueUsd still equals aumUsd.
  const liveRaw = legs.map((l) => l.liveWeightPct ?? l.weightPct)
  const liveSum = liveRaw.reduce((s, w) => s + w, 0) || 1
  return legs.map((l, i) => {
    const liveWeightPct = (liveRaw[i] / liveSum) * 100
    const valueUsd = (liveWeightPct / 100) * aumUsd
    return {
      asset: l.asset,
      symbol: l.symbol,
      name: l.name,
      decimals: l.decimals,
      targetWeightPct: l.weightPct,
      balance: valueUsd / l.priceUsd,
      priceUsd: l.priceUsd,
      valueUsd,
      liveWeightPct,
      change24hPct: l.change24hPct,
      priced: true,
      series: series(seed + i, l.change24hPct),
    }
  })
}

interface MockBasket {
  address: string
  name: string
  symbol: string
  legs: MockLeg[]
  aumUsd: number
  navPerToken: number
  change24hPct: number
  seed: number
  /** Per-basket, creator-set fee (bps) — varied across [100,300] to show fees are
   *  per-basket, never a universal number. Real baskets read it on-chain. */
  feeBps: number
  /** The creator's chosen share of the post-burn remainder (bps, ≤ MAX_CREATOR_SHARE_BPS). */
  creatorShareBps: number
  /** Verified successor address (this version is superseded by it) — mirrors the
   *  metadata `supersedes` link so discovery + the creator page treat it as an
   *  older version (matches how production populates supersededBy from lineage). */
  supersededBy?: string
  /** Holder count — stands in for the indexer-provided figure so the UI's holders
   *  stat is demoable offline (real deployments get this from the operator DB). */
  holdersCount?: number
  /** Creator wallet; omitted ⇒ the original MOCK_DEPLOYER. */
  deployer?: string
  /** Age in days (inceptionTs derives from it); omitted ⇒ 6. */
  ageDays?: number
}

const ROTATE_V1 = '0x0000000000000000000000000000000000ba5e0b'
const ROTATE_V2 = '0x0000000000000000000000000000000000ba5e0c'

const MOCKS: MockBasket[] = [
  { address: MOCK_1, name: 'Dev Sample Basket', symbol: 'DEVBKT', legs: LEGS_1, aumUsd: 184_000, navPerToken: 1.042, change24hPct: 0.7, seed: 3, feeBps: 100, creatorShareBps: 1500, supersededBy: MOCK_3, holdersCount: 214 },
  { address: MOCK_2, name: 'Dev Sample Basket Two', symbol: 'DEVTWO', legs: LEGS_2, aumUsd: 42_000, navPerToken: 0.981, change24hPct: 1.6, seed: 11, feeBps: 250, creatorShareBps: 0, holdersCount: 63 },
  { address: MOCK_3, name: 'Dev Sample Basket v2', symbol: 'DEVBK2', legs: LEGS_3, aumUsd: 96_000, navPerToken: 1.083, change24hPct: 1.2, seed: 7, feeBps: 100, creatorShareBps: 3000, holdersCount: 128 },

  // ── design-review catalogue (VITE_DEV_FIXTURE=1): enough spread across
  //    creators / perf / value / age that Explore, the spotlight and the
  //    leaderboard all render populated. navPerToken vs the ~$1.00 launch is
  //    what drives the perf-to-date ranking. ──
  { address: '0x0000000000000000000000000000000000ba5e04', name: 'Agent Economy', symbol: 'AGENTS', deployer: MOCK_C2, legs: [leg(T.WETH, 30, 2.1, 34), leg(T.AERO, 30, 6.4, 27), leg(T.DEGEN, 25, 8.2, 26), leg(T.BRETT, 15, -1.3, 13)], aumUsd: 640_000, navPerToken: 2.41, change24hPct: 5.8, seed: 21, feeBps: 200, creatorShareBps: 2500, holdersCount: 927, ageDays: 61 },
  { address: '0x0000000000000000000000000000000000ba5e05', name: 'Base Core Majors', symbol: 'BASECORE', deployer: MOCK_C1, legs: [leg(T.WETH, 40, 1.8, 43), leg(T.cbBTC, 35, 0.9), leg(T.cbETH, 25, 1.6, 22)], aumUsd: 1_240_000, navPerToken: 1.86, change24hPct: 2.1, seed: 29, feeBps: 100, creatorShareBps: 1000, holdersCount: 1841, ageDays: 92 },
  { address: '0x0000000000000000000000000000000000ba5e06', name: 'Meme Melange', symbol: 'MEMEX', deployer: MOCK_C4, legs: [leg(T.DEGEN, 40, -4.1, 44), leg(T.BRETT, 35, -2.8, 33), leg(T.AERO, 25, 1.2, 23)], aumUsd: 205_000, navPerToken: 1.42, change24hPct: -3.2, seed: 37, feeBps: 300, creatorShareBps: 3000, holdersCount: 1204, ageDays: 35 },
  { address: '0x0000000000000000000000000000000000ba5e07', name: 'Yield Rotation', symbol: 'YIELDMAX', deployer: MOCK_C3, legs: [leg(T.USDC, 40, 0, 38), leg(T.AERO, 35, 1.9, 37), leg(T.WETH, 25, 1.8)], aumUsd: 310_000, navPerToken: 1.31, change24hPct: 0.6, seed: 43, feeBps: 150, creatorShareBps: 2000, holdersCount: 512, ageDays: 148 },
  { address: '0x0000000000000000000000000000000000ba5e08', name: 'Blue Base', symbol: 'BLUEBASE', deployer: MOCK_C1, legs: [leg(T.WETH, 50, 1.8, 52), leg(T.cbBTC, 50, 0.9, 48)], aumUsd: 152_000, navPerToken: 1.18, change24hPct: 1.4, seed: 53, feeBps: 100, creatorShareBps: 500, holdersCount: 240, ageDays: 120 },
  { address: '0x0000000000000000000000000000000000ba5e09', name: 'Stable Carry', symbol: 'STCARRY', deployer: MOCK_C3, legs: [leg(T.USDC, 70, 0, 69), leg(T.WETH, 30, 1.8, 31)], aumUsd: 178_000, navPerToken: 1.045, change24hPct: 0.1, seed: 59, feeBps: 100, creatorShareBps: 1500, holdersCount: 388, ageDays: 210 },
  { address: '0x0000000000000000000000000000000000ba5e0a', name: 'Degen Index', symbol: 'DEGENX', deployer: MOCK_C5, legs: [leg(T.DEGEN, 60, -7.2, 63), leg(T.BRETT, 40, -4.4, 37)], aumUsd: 88_000, navPerToken: 0.88, change24hPct: -6.1, seed: 61, feeBps: 300, creatorShareBps: 0, holdersCount: 451, ageDays: 28 },
  { address: '0x0000000000000000000000000000000000ba5e0d', name: 'Full Stack Base', symbol: 'BASEALL', deployer: MOCK_C1, legs: [leg(T.WETH, 22, 1.8, 24), leg(T.cbBTC, 20, 0.9), leg(T.cbETH, 14, 1.6), leg(T.USDC, 12, 0), leg(T.AERO, 12, 1.9, 11), leg(T.DEGEN, 11, 3.1, 12), leg(T.BRETT, 9, -1.3, 8)], aumUsd: 415_000, navPerToken: 1.24, change24hPct: 1.1, seed: 83, feeBps: 150, creatorShareBps: 1500, holdersCount: 693, ageDays: 104 },
  { address: ROTATE_V1, name: 'Sector Rotator', symbol: 'ROTATE', deployer: MOCK_C2, legs: [leg(T.AERO, 40, 1.9), leg(T.DEGEN, 30, 3.1), leg(T.WETH, 30, 1.8)], aumUsd: 44_000, navPerToken: 0.94, change24hPct: 0.8, seed: 67, feeBps: 250, creatorShareBps: 2500, supersededBy: ROTATE_V2, holdersCount: 97, ageDays: 77 },
  { address: ROTATE_V2, name: 'Sector Rotator v2', symbol: 'ROTATE2', deployer: MOCK_C2, legs: [leg(T.AERO, 30, 1.9, 28), leg(T.DEGEN, 30, 3.1, 33), leg(T.WETH, 40, 1.8, 39)], aumUsd: 71_000, navPerToken: 1.12, change24hPct: 1.9, seed: 71, feeBps: 250, creatorShareBps: 2500, holdersCount: 133, ageDays: 22 },
]

function active(chainId: number): boolean {
  // The fixture only stands in while the chain has no real deployment — unless
  // FORCED for design review (`VITE_DEV_FIXTURE=1` in .env.local): a populated
  // catalogue to style against, even on a testbed with real factories. The
  // module itself only loads behind `import.meta.env.DEV` (dynamic import), so
  // the force switch cannot exist in a production bundle.
  if (import.meta.env.VITE_DEV_FIXTURE === '1') return chainId === DEFAULT_CHAIN_ID
  try {
    return chainId === DEFAULT_CHAIN_ID && !chainCfg(chainId).factory
  } catch {
    return false
  }
}

// DEV-only sample wallet balances so the Portfolio (and its look-through) render
// populated — the shipped wallet holds nothing on these synthetic baskets. Same
// activation rule as the other fixtures. Balances span all three mock baskets so
// shared constituents (WETH in 1 & 3, cbBTC in 1 & 3, DEGEN in 2 & 3) aggregate
// across baskets in the look-through.
const MOCK_BALANCES: Record<string, number> = {
  [MOCK_1.toLowerCase()]: 9000,
  [MOCK_2.toLowerCase()]: 5000,
  [MOCK_3.toLowerCase()]: 7000,
}
export function devUserHoldings(
  baskets: { address: string; chainId: number }[],
): Map<string, number> | null {
  const out = new Map<string, number>()
  for (const b of baskets) {
    if (!active(b.chainId)) continue
    const bal = MOCK_BALANCES[b.address.toLowerCase()]
    if (bal != null) out.set(b.address.toLowerCase(), bal)
  }
  return out.size > 0 ? out : null
}

// ── DEV migrate preview ──────────────────────────────────────────────────────
// Demo baskets have no contracts, so the real migrate planner's chain reads
// revert ("balanceOf returned no data") and the upgrade popup used to flip from
// its summary to the error stepper (owner report 2026-07-06). This synthesizes
// a CONSISTENT display-only MigratePlanView from the mock catalogue — the exit
// haircut runs through the real planRedeem; the delta is the value-weighted
// rebalance the real flow would do. useMigrate short-circuits to it for fixture
// pairs and blocks execute (`preview`), so the popup holds its summary.

/** float → raw bigint at `d` decimals (multiply before divide keeps 9 sig digits). */
function rawUnits(n: number, d: number): bigint {
  if (!isFinite(n) || n <= 0) return 0n
  return (BigInt(Math.round(n * 1e9)) * 10n ** BigInt(d)) / 10n ** 9n
}

export function devMigratePreview(
  fromAddr: string,
  toAddr: string,
  chainId: number,
  amountRaw?: bigint,
): MigratePlanView | null {
  if (!active(chainId)) return null
  const fm = MOCKS.find((x) => x.address.toLowerCase() === fromAddr.toLowerCase())
  const tm = MOCKS.find((x) => x.address.toLowerCase() === toAddr.toLowerCase())
  if (!fm || !tm) return null

  const snap = (m: MockBasket): BasketSnapshot => ({
    address: m.address as Address,
    decimals: 18,
    effectiveSupply: rawUnits(m.aumUsd / m.navPerToken, 18),
    feeBps: m.feeBps,
    legs: m.legs.map(
      (l): SnapLeg => ({
        asset: l.asset as Address,
        symbol: l.symbol,
        decimals: l.decimals,
        idleHeld: rawUnits((m.aumUsd * l.weightPct) / 100 / l.priceUsd, l.decimals),
        weight: l.weightPct * 100, // bps, as the contract tuple carries it
      }),
    ),
  })
  const from = snap(fm)
  const to = snap(tm)

  const fromBalance = rawUnits(MOCK_BALANCES[fm.address.toLowerCase()] ?? 1_250, 18)
  const amount = amountRaw !== undefined && amountRaw > 0n && amountRaw <= fromBalance ? amountRaw : fromBalance
  const shares = Number(amount / 10n ** 9n) / 1e9
  const netValueUsd = shares * fm.navPerToken * (1 - fm.feeBps / 10_000)

  // pro-rata redeem preview — the same math the app ships
  const redeem = planRedeem(from.legs, from.effectiveSupply, from.feeBps, amount)

  // value-weighted rebalance delta: overweight legs sell into WETH, underweight buy
  const WETH_USD = 2_600 // the fixture's WETH price
  const weightOf = (legs: MockLeg[], asset: string) =>
    legs.find((x) => x.asset.toLowerCase() === asset.toLowerCase())?.weightPct ?? 0
  const sells: DeltaPreview['sells'] = []
  const buys: DeltaPreview['buys'] = []
  let potUsd = 0
  for (const l of fm.legs) {
    const overUsd = ((l.weightPct - weightOf(tm.legs, l.asset)) / 100) * netValueUsd
    if (overUsd > 0.005 * netValueUsd) {
      const leg = from.legs.find((x) => x.asset.toLowerCase() === l.asset.toLowerCase())!
      sells.push({ leg, amountIn: rawUnits(overUsd / l.priceUsd, l.decimals), fee: 3000, quotedWeth: rawUnits(overUsd / WETH_USD, 18) })
      potUsd += overUsd
    }
  }
  for (const l of tm.legs) {
    const underUsd = ((l.weightPct - weightOf(fm.legs, l.asset)) / 100) * netValueUsd
    if (underUsd > 0.005 * netValueUsd) {
      const leg = to.legs.find((x) => x.asset.toLowerCase() === l.asset.toLowerCase())!
      buys.push({ leg, budget: rawUnits(underUsd / WETH_USD, 18), fee: 3000, quotedOut: rawUnits(underUsd / l.priceUsd, l.decimals), mode: 'exact-in' })
    }
  }
  const delta: DeltaPreview | null =
    sells.length || buys.length
      ? { sells, buys, potWeth: rawUnits(potUsd / WETH_USD, 18), totalValueWeth: rawUnits(netValueUsd / WETH_USD, 18) }
      : null

  // the mint lands the full post-haircut value in the new version
  const targetShares = rawUnits((netValueUsd * (1 - tm.feeBps / 10_000)) / tm.navPerToken, 18)
  const mint = {
    ok: true,
    missing: [],
    maxShares: targetShares,
    targetShares,
    minShares: (targetShares * 9_900n) / 10_000n,
    amounts: to.legs.map((l) => {
      const lm = tm.legs.find((x) => x.asset.toLowerCase() === l.asset.toLowerCase())!
      return rawUnits(((lm.weightPct / 100) * netValueUsd) / lm.priceUsd, l.decimals)
    }),
    bindingIndex: 0,
  }

  // v1 legs the new version dropped entirely (projected redeem outputs)
  const dropped = redeem.outs
    .filter((o) => !tm.legs.some((x) => x.asset.toLowerCase() === o.leg.asset.toLowerCase()))
    .map((o) => ({ leg: from.legs.find((x) => x.asset.toLowerCase() === o.leg.asset.toLowerCase())!, out: o.out }))

  return { from, to, fromBalance, redeem, mint, delta, deltaKind: delta ? 'rebalance' : undefined, dropped }
}

export function devBasketSummaries(chainId: number): BasketSummary[] | null {
  if (!active(chainId)) return null
  return MOCKS.map((m) => ({
    chainId,
    address: m.address,
    name: m.name,
    symbol: m.symbol,
    basketLength: m.legs.length,
    navPerToken: m.navPerToken,
    aumUsd: m.aumUsd,
    change24hPct: m.change24hPct,
    pricedCount: m.legs.length,
    top: [...m.legs]
      .sort((a, b) => b.weightPct - a.weightPct)
      .map((l) => ({ address: l.asset, symbol: l.symbol, weightPct: l.weightPct })),
    navSeries: series(m.seed, m.change24hPct),
    deployer: m.deployer ?? MOCK_DEPLOYER,
    supersededBy: m.supersededBy ?? null,
    holdersCount: m.holdersCount ?? null,
  }))
}

export function devBasketData(address: Address, chainId: number): BasketData | null {
  if (!active(chainId)) return null
  const m = MOCKS.find((x) => x.address.toLowerCase() === address.toLowerCase())
  if (!m) return null
  const h = holdings(m.legs, m.aumUsd, m.seed)
  return {
    chainId,
    address: m.address,
    name: m.name,
    symbol: m.symbol,
    decimals: 18,
    totalSupply: m.aumUsd / m.navPerToken,
    aumUsd: m.aumUsd,
    navPerToken: m.navPerToken,
    navSource: 'onchain',
    fullyPriced: true,
    navDivergencePct: 0.3,
    change24hPct: m.change24hPct,
    holdings: h,
    navSeries: series(m.seed, m.change24hPct),
    pricedCount: h.length,
    totalCount: h.length,
    inceptionTs: Math.floor(Date.now() / 1000) - (m.ageDays ?? 6) * 86400,
    ageHours: (m.ageDays ?? 6) * 24,
    deployer: m.deployer ?? MOCK_DEPLOYER,
    effectiveSupply: m.aumUsd / m.navPerToken,
    updatedAt: new Date().toISOString(),
  }
}

/** DEV-only mock fee readout for the FeePanel (same activation rule). The burn /
 *  interface / launcher shares + creator cap are the FIXED protocol constants
 *  (sourced from PROTOCOL_FEE_MODEL — never hand-typed). The basket fee + creator
 *  share are PER-BASKET (creator-set): each mock carries its own `feeBps` (varied
 *  across [100,300]) so nothing reads as a universal hardcoded rate; a real basket
 *  reads these on-chain. */
export function devBasketFees(address: string, chainId: number) {
  if (!active(chainId)) return null
  const m = MOCKS.find((x) => x.address.toLowerCase() === address.toLowerCase())
  if (!m) return null
  return {
    basketFeeBps: m.feeBps,
    burnShareBps: PROTOCOL_FEE_MODEL.BURN_SHARE_BPS,
    interfaceShareBps: PROTOCOL_FEE_MODEL.INTERFACE_SHARE_BPS,
    launcherShareBps: PROTOCOL_FEE_MODEL.LAUNCHER_SHARE_BPS,
    creatorShareBps: m.creatorShareBps,
    maxCreatorShareBps: PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS,
    creatorPayout: MOCK_DEPLOYER,
    launcher: MOCK_LAUNCHER,
    deployer: MOCK_DEPLOYER,
  }
}

// DEV-only live fee state for the /flush creator console (same activation rule).
// Distinct from devBasketFees (the immutable config) — these figures move on
// every trade, so the fixture invents plausible USDC accruals per basket: a
// holder reserve, a pending PRISM-burn balance, the connected holder's claimable,
// and per-recipient frontend accruals (creator / launcher). All in USDC.
interface MockFeeState {
  feeReserveUsdc: number
  pendingBurnUsdc: number
  /** Basket tokens queued in the lazy-burn queue (settled by redeemClaims()). */
  pendingClaimsTokens: number
  /** What the preview holder can claim (shown when a holder is queried). */
  claimableUsdc: number
  /** [role, address, pending USDC] — creator/launcher accruals with a balance. */
  frontend: [FrontendRole, string, number][]
}

const FEE_STATE: Record<string, MockFeeState> = {
  [MOCK_1.toLowerCase()]: {
    feeReserveUsdc: 418.62,
    pendingBurnUsdc: 57.4,
    pendingClaimsTokens: 1280.5,
    claimableUsdc: 12.41,
    frontend: [
      ['Creator', MOCK_DEPLOYER, 31.18],
      ['Launcher', MOCK_LAUNCHER, 10.39],
    ],
  },
  // creatorShareBps 0 → no creator accrual; pending burn sits below the bridge
  // threshold (the crank stays disabled until it accumulates); nothing queued.
  [MOCK_2.toLowerCase()]: {
    feeReserveUsdc: 96.05,
    pendingBurnUsdc: 0,
    pendingClaimsTokens: 0,
    claimableUsdc: 3.07,
    frontend: [['Launcher', MOCK_LAUNCHER, 4.62]],
  },
  [MOCK_3.toLowerCase()]: {
    feeReserveUsdc: 209.88,
    pendingBurnUsdc: 143.2,
    pendingClaimsTokens: 642.0,
    claimableUsdc: 0,
    frontend: [
      ['Creator', MOCK_DEPLOYER, 88.5],
      ['Launcher', MOCK_LAUNCHER, 14.75],
    ],
  },
}

export function devFeeState(address: string, chainId: number, holder?: string): FeeState | null {
  if (!active(chainId)) return null
  const s = FEE_STATE[address.toLowerCase()]
  if (!s) return null
  const frontend: FrontendAccrual[] = s.frontend.map(([role, addr, pendingUsdc]) => ({
    role,
    address: addr as Address,
    pendingUsdc,
  }))
  return {
    feeReserveUsdc: s.feeReserveUsdc,
    pendingBurnUsdc: s.pendingBurnUsdc,
    pendingClaimsTokens: s.pendingClaimsTokens,
    claimableUsdc: holder ? s.claimableUsdc : 0,
    frontend,
  }
}

// ── DEV-only creator metadata ────────────────────────────────────────────────
// Self-contained SVG data URIs so reviewers see real imagery offline. The prod
// resolver only renders https/ipfs (creator.metadata.ts safeImageUrl); these
// data: URIs never touch that path — devCreatorMeta returns a pre-verified view.
const DEV_AVATAR =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#35e0ff"/><stop offset="0.55" stop-color="#a48bff"/><stop offset="1" stop-color="#ff4db8"/></linearGradient></defs><rect width="120" height="120" rx="28" fill="url(#g)"/><text x="60" y="78" font-family="sans-serif" font-size="58" font-weight="700" fill="#0b0b12" text-anchor="middle">S</text></svg>`,
  )
const DEV_BANNER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b0b12"/><stop offset="0.5" stop-color="#241b4d"/><stop offset="1" stop-color="#0b0b12"/></linearGradient><radialGradient id="c" cx="0.2" cy="0.3" r="0.8"><stop offset="0" stop-color="#35e0ff" stop-opacity="0.55"/><stop offset="1" stop-color="#35e0ff" stop-opacity="0"/></radialGradient><radialGradient id="p" cx="0.85" cy="0.7" r="0.7"><stop offset="0" stop-color="#ff4db8" stop-opacity="0.5"/><stop offset="1" stop-color="#ff4db8" stop-opacity="0"/></radialGradient></defs><rect width="900" height="300" fill="url(#b)"/><rect width="900" height="300" fill="url(#c)"/><rect width="900" height="300" fill="url(#p)"/></svg>`,
  )

/** Per-creator avatar (distinct gradient + initial), same data-URI approach. */
function avatarFor(letter: string, c1: string, c2: string): string {
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="120" height="120" rx="28" fill="url(#g)"/><text x="60" y="78" font-family="sans-serif" font-size="58" font-weight="700" fill="#0b0b12" text-anchor="middle">${letter}</text></svg>`,
    )
  )
}
const AV_C1 = avatarFor('O', '#35e0ff', '#2b6cff')
const AV_C2 = avatarFor('B', '#a48bff', '#5f3dff')
const AV_C3 = avatarFor('Y', '#3ef0c8', '#0e9f6e')
const AV_C4 = avatarFor('M', '#ff4db8', '#ff9248')

/** Identity block per design-review creator, merged into each basket's meta. */
const C1_ID = { handle: '@onchainmaxi', xUrl: 'https://x.com/onchainmaxi', name: 'Onchain Maxi', avatarUrl: AV_C1, bannerUrl: DEV_BANNER }
const C2_ID = { handle: '@basedresearch', xUrl: 'https://x.com/basedresearch', name: 'Based Research', avatarUrl: AV_C2, bannerUrl: DEV_BANNER }
const C3_ID = { handle: '@yieldsmith', xUrl: 'https://x.com/yieldsmith', name: 'Yieldsmith', avatarUrl: AV_C3, bannerUrl: null }
const C4_ID = { handle: '@memeticcap', xUrl: 'https://x.com/memeticcap', name: 'Memetic Capital', avatarUrl: AV_C4, bannerUrl: DEV_BANNER }

const MOCK_META: Record<string, VerifiedCreatorMeta> = {
  // ── design-review creators (C5 / DEGENX deliberately absent — unverified) ──
  '0x0000000000000000000000000000000000ba5e04': {
    verified: true, deployer: MOCK_C2 as Address, basket: '0x0000000000000000000000000000000000ba5e04' as Address, supersedes: null,
    ...C2_ID,
    tagline: 'The tokens the agent economy actually runs on.',
    thesis: 'Four liquid names with real agent-economy flow: settlement, routing, distribution and culture. Weighted by usage, not narrative, and re-versioned only when the stack itself changes.',
    sectors: ['AI', 'Base'], timeHorizon: 'mid-term',
    postUrl: 'https://x.com/basedresearch/status/1812030000000000003',
  },
  '0x0000000000000000000000000000000000ba5e05': {
    verified: true, deployer: MOCK_C1 as Address, basket: '0x0000000000000000000000000000000000ba5e05' as Address, supersedes: null,
    ...C1_ID,
    tagline: 'The Base majors, one token.',
    thesis: 'ETH, BTC and staked ETH exposure through the three deepest wrapped assets on Base. The boring core done properly: no rotation, no timing, one token that holds the majors.',
    sectors: ['Blue chip'], timeHorizon: 'long-term',
    postUrl: 'https://x.com/onchainmaxi/status/1809040000000000004',
  },
  '0x0000000000000000000000000000000000ba5e06': {
    verified: true, deployer: MOCK_C4 as Address, basket: '0x0000000000000000000000000000000000ba5e06' as Address, supersedes: null,
    ...C4_ID,
    tagline: 'Culture, weighted.',
    thesis: 'The meme complex as one position: attention rotates faster than anyone can trade it, so hold the complex and let the basket do the rotating. Sized for volatility, not against it.',
    sectors: ['Memes', 'Culture'], timeHorizon: 'short-term',
    postUrl: 'https://x.com/memeticcap/status/1813050000000000005',
  },
  '0x0000000000000000000000000000000000ba5e07': {
    verified: true, deployer: MOCK_C3 as Address, basket: '0x0000000000000000000000000000000000ba5e07' as Address, supersedes: null,
    ...C3_ID,
    tagline: 'Carry with a growth kicker.',
    thesis: 'A stable base earning the boring yield, an AERO sleeve for the fee flow, and an ETH sleeve so the carry never fully sits out a run.',
    sectors: ['Yield', 'DeFi'], timeHorizon: 'mid-term',
    postUrl: null,
  },
  '0x0000000000000000000000000000000000ba5e08': {
    verified: true, deployer: MOCK_C1 as Address, basket: '0x0000000000000000000000000000000000ba5e08' as Address, supersedes: null,
    ...C1_ID,
    tagline: 'Fifty-fifty, forever.',
    thesis: 'ETH and BTC, equal weight. The two assets everyone eventually ends up holding anyway, without picking a winner.',
    sectors: ['Blue chip'], timeHorizon: 'long-term',
    postUrl: null,
  },
  '0x0000000000000000000000000000000000ba5e09': {
    verified: true, deployer: MOCK_C3 as Address, basket: '0x0000000000000000000000000000000000ba5e09' as Address, supersedes: null,
    ...C3_ID,
    tagline: 'Mostly stable, never asleep.',
    thesis: 'Seventy percent settlement asset, thirty percent ETH. For the capital that wants to stay deployed without living on the volatility curve.',
    sectors: ['Yield'], timeHorizon: 'long-term',
    postUrl: null,
  },
  '0x0000000000000000000000000000000000ba5e0d': {
    verified: true, deployer: MOCK_C1 as Address, basket: '0x0000000000000000000000000000000000ba5e0d' as Address, supersedes: null,
    ...C1_ID,
    tagline: 'The whole Base stack, one token.',
    thesis: 'Every layer of the Base economy in one position: the majors for ballast, the DEX and distribution rails for flow, the culture coins for upside. Weighted so no single leg can sink the ship.',
    sectors: ['Base', 'Blue chip', 'DeFi'], timeHorizon: 'long-term',
    postUrl: 'https://x.com/onchainmaxi/status/1814060000000000006',
  },
  [ROTATE_V1.toLowerCase()]: {
    verified: true, deployer: MOCK_C2 as Address, basket: ROTATE_V1 as Address, supersedes: null,
    ...C2_ID,
    tagline: 'The rotation, v1.',
    thesis: 'First cut of the sector rotator: DEX flow, distribution and ETH beta in one basket.',
    sectors: ['DeFi', 'Base'], timeHorizon: 'mid-term',
    postUrl: null,
  },
  [ROTATE_V2.toLowerCase()]: {
    verified: true, deployer: MOCK_C2 as Address, basket: ROTATE_V2 as Address, supersedes: ROTATE_V1 as Address,
    ...C2_ID,
    tagline: 'The rotation, v2 — heavier ETH.',
    thesis: 'Second cut: the ETH sleeve earns its weight back, the meme sleeve gets a haircut. Same thesis, current market.',
    sectors: ['DeFi', 'Base'], timeHorizon: 'mid-term',
    postUrl: null,
  },

  [MOCK_1.toLowerCase()]: {
    verified: true,
    deployer: MOCK_DEPLOYER as Address,
    basket: MOCK_1 as Address,
    supersedes: null,
    handle: '@spectrumdev',
    xUrl: 'https://x.com/spectrumdev',
    name: 'Spectrum Dev',
    avatarUrl: DEV_AVATAR,
    bannerUrl: DEV_BANNER,
    tagline: 'Blue-chip DeFi in one basket.',
    thesis:
      'A weighted core of the DeFi majors I already hold and talk about: deep liquidity, real fee flow, and multi-cycle survival. One token instead of five tabs; rebalanced by shipping the next version when the landscape actually changes, not before.',
    sectors: ['DeFi', 'Blue chip'],
    timeHorizon: 'long-term',
    postUrl: null,
  },
  [MOCK_2.toLowerCase()]: {
    verified: true,
    deployer: MOCK_DEPLOYER as Address,
    basket: MOCK_2 as Address,
    supersedes: null,
    handle: '@spectrumdev',
    xUrl: 'https://x.com/spectrumdev',
    name: 'Spectrum Dev',
    avatarUrl: DEV_AVATAR,
    bannerUrl: null,
    // Deliberately thesis-less: exercises every empty state on the thesis surfaces.
    tagline: null,
    thesis: null,
    sectors: [],
    timeHorizon: null,
    postUrl: null,
  },
  [MOCK_3.toLowerCase()]: {
    verified: true,
    deployer: MOCK_DEPLOYER as Address,
    basket: MOCK_3 as Address,
    supersedes: MOCK_1 as Address,
    handle: '@spectrumdev',
    xUrl: 'https://x.com/spectrumdev',
    name: 'Spectrum Dev',
    avatarUrl: DEV_AVATAR,
    bannerUrl: DEV_BANNER,
    tagline: 'The DeFi core, v2 — leaner legs, same thesis.',
    thesis:
      'V2 of the DeFi core: drops the two legs whose fee flow stopped justifying their weight and concentrates the survivors. Same long-horizon read as V1 — this version exists because the market moved, and holders migrate on their own schedule.',
    sectors: ['DeFi', 'Blue chip'],
    timeHorizon: 'long-term',
    postUrl: null,
  },
}

/** DEV-only verified creator metadata (same activation rule as the basket mocks). */
export function devCreatorMeta(address: string, chainId: number): VerifiedCreatorMeta | null {
  if (!active(chainId)) return null
  return MOCK_META[address.toLowerCase()] ?? null
}
