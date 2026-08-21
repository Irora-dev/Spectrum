import { erc20Abi, formatUnits, type Address } from 'viem'
import { clientFor } from '../chain/rpc'
import { chainCfg } from '../chain/chains'
import { verifiedTokens } from './token-list'
import { describeTokens, dexscreenerSlugFor, discoverHeldTokens, priceDiscovered } from './token-discovery'
import { findBestPool } from '../pools/find-best-pool'
import { Venue } from '../pools/types'
import { nativeEthUsdOnChain, v4LegUsd } from '../pools/v4-usd'
import { v3LegUsd } from '../pools/v3-usd'
import type { AssetExposure, ExposureBreakdown } from './exposure'
import { PRISM_CLAIM_CHAIN_ID, PRISM_V2_HOOK } from '../prism/claim'
import { PRISM_POOL_KEY } from '../prism/pool'

// ─────────────────────────────────────────────────────────────────────────────
// RAW HOLDINGS — what the wallet holds DIRECTLY, before anything is minted.
// REACT-FREE BY CONTRACT (extension spec, 2026-08-02): pure viem + math only,
// like exposure.ts and basket-data.ts — the hook lives in use-raw-holdings.ts.
// This property keeps the analytical core portable to a service worker; do
// not import hooks here.
// (the owner, recording 2026-08-02 00:49: the portfolio should help with "really
// any asset you hold"). No database, no script, his constraint honored:
// one bounded balanceOf sweep per network (the per-chain client coalesces the
// concurrent reads into multicall), native ETH included, and only NONZERO
// holdings are priced.
//
// THE SWEPT SET IS TWO THINGS (2026-08-06 12:58, "we need to be so good at
// detecting new assets"): the curated verified list, plus whatever
// token-discovery.ts finds the wallet actually holding. The list alone could
// never see a token that launched this morning — the asset his users care most
// about — because it was not on any list to ask about. Listed tokens are priced
// through the launch page's own pool detection and the basket legs' USD
// helpers, exactly as before; discovered ones through one batched DexScreener
// read, for the reason stated at that call site.
//
// The honesty laws hold here exactly as everywhere: a token whose balance
// read FAILED is unreadable, never zero; a holding whose price cannot be
// found stays visible as UNPRICED, never dropped and never guessed.
// ─────────────────────────────────────────────────────────────────────────────

export interface RawHolding {
  chainId: number
  address: string
  symbol: string
  decimals: number
  /** Whole-token amount (display-grade; USD math uses it with the price). */
  amount: number
  /** Null = could not be priced (no routable pool found) — shown, not dropped. */
  usd: number | null
  native?: boolean
  /** FALSE = a DISCOVERED row whose identity rests on its own symbol() alone.
   *  asset-unify refuses to fold these into the symbol-keyed families (a scam
   *  "USDT" must not wear the real tile — audit 2026-08-06 #4). Listed,
   *  settlement and native rows are address-verified and fold as always. */
  verified?: boolean
  /** DEV-ONLY: this row came from the demo fixture, not from a chain read. Only
   *  `devRawHoldings` ever sets it, and that module is dynamically imported
   *  behind `import.meta.env.DEV`, so it cannot be true in a production build.
   *  The portfolio counts these as ADDED (it otherwise counts only what the
   *  user explicitly added, so a fixture holding would be invisible). */
  fixture?: true
  /** A BASKET TOKEN the wallet holds (folded in from the portfolio read, not
   *  from the raw sweep — the verified token lists can never contain one).
   *  Priced at the basket's own NAV. Surfaces use it to render the basket as
   *  ONE tile (never its look-through legs beside it) and to exclude it from
   *  seeding, since a basket is not a plain leg the picker can resolve. */
  basket?: boolean
  /** HAND-ADDED (manual-assets.ts, owner 2026-08-12): the user pasted this
   *  contract address because the sweep missed it. Counted as ADDED by the
   *  portfolio (like `fixture`) and EXEMPT from the dust fold — never fold
   *  what was explicitly asked for. */
  manual?: true
  /** NO CREDIBLE MARKET (the owner 2026-08-18: a scam airdrop "shows up in
   *  my portfolio — we need to filter out low liquidity tokens and
   *  honeypots"): a DISCOVERED, never-hand-added token whose priced sweep
   *  found no market at all. "Unpriced and visible" is the honest state for
   *  CURATED tokens; for an airdrop nobody asked for it is a scam's stage.
   *  Suspect rows leave every display surface and are COUNTED behind one
   *  quiet line; pasting the address (manual-assets) remains the door for
   *  the rare real token this bar catches early. */
  suspect?: true
  /** In a linked-wallet GROUP read: the wallets this merged row is made of.
   *  Set by the merge (use-raw-holdings) so attribution survives the one-book
   *  collapse; absent on single-wallet reads. */
  contributors?: { owner: string; amount: number; usd: number | null }[]
}

export interface ChainRawHoldings {
  chainId: number
  holdings: RawHolding[]
  /** Tokens whose balance read failed — unreadable, NOT zero. */
  unreadable: number
  /** The unlisted-token DISCOVERY pass could not run (both rungs failed) or
   *  was truncated at its cap — either way this chain's book may be missing
   *  tokens nobody listed, and the caller must be able to SAY so (audit
   *  2026-08-06 #1/#2: the cap and the double-failure were silent). */
  discoveryGap: boolean
}

const NATIVE_KEY = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const ADDR_RE = /^0x[0-9a-f]{40}$/

/** Which addresses join the describe+price pass beyond the curated list:
 *  discovery's finds plus the user's HAND-ADDED tokens, deduped against
 *  everything already known. Pure — this is the manual-add merge seam, tested
 *  in isolation (raw-holdings.test) because the sweep itself needs a chain. */
export function planExtraTokens(
  known: ReadonlySet<string>,
  discovered: readonly string[],
  manual: readonly string[],
): { extras: string[]; manualSet: Set<string> } {
  const manualSet = new Set(manual.map((a) => a.toLowerCase()).filter((a) => ADDR_RE.test(a) && a !== NATIVE_KEY))
  const extras: string[] = []
  const seen = new Set<string>()
  for (const raw of [...discovered, ...manualSet]) {
    const a = raw.toLowerCase()
    if (a === NATIVE_KEY || known.has(a) || seen.has(a)) continue
    seen.add(a)
    extras.push(a)
  }
  return { extras, manualSet }
}

async function priceHolding(chainId: number, asset: Address, decimals: number, ethUsd: number | null): Promise<number | null> {
  if (ethUsd == null) return null
  const a = asset.toLowerCase()
  // the canonical wrap IS the quote asset every pool here prices against —
  // it can never route "against ETH", and it never needs to: 1 WETH = 1
  // native by construction (owner 2026-08-20 1033, via Daylight w-145)
  try {
    if (a === chainCfg(chainId).weth?.toLowerCase()) return ethUsd
  } catch {
    /* an unconfigured chain just falls through to discovery */
  }
  // a SELF-HOOKED v4 token (PRISM: token == hook == its only venue) never
  // surfaces in findBestPool's discovery — but the app already pins its pool
  // key, and a v4 pool prices off its own slot0 (the doctrine lp-positions
  // proves on the same pool). Reuse the real key, never re-derive.
  if (chainId === PRISM_CLAIM_CHAIN_ID && a === PRISM_V2_HOOK.toLowerCase()) {
    const p = await v4LegUsd(chainId, { ...PRISM_POOL_KEY }, decimals, ethUsd).catch(() => null)
    if (p != null) return p
  }
  try {
    const found = await findBestPool(asset, chainId)
    const best = found.best
    if (best.ethPoolKey) return await v4LegUsd(chainId, best.ethPoolKey, decimals, ethUsd)
    if (best.venue === Venue.V3 && best.fee > 0) return await v3LegUsd(chainId, asset, best.fee, decimals, ethUsd)
    return null
  } catch {
    return null // no routable pool (or a failed detection) — unpriced, never guessed
  }
}

export async function fetchChainRawHoldings(
  owner: Address,
  chainId: number,
  /** HAND-ADDED token addresses for this chain (manual-assets.ts) — they join
   *  the describe+price pass like discovered tokens and their rows wear
   *  `manual: true`. Empty for callers that predate paste-to-add. */
  manual: readonly string[] = [],
): Promise<ChainRawHoldings> {
  const client = clientFor(chainId)
  const [listed, nativeWei, ethUsd, found] = await Promise.all([
    verifiedTokens(chainId),
    client.getBalance({ address: owner }),
    nativeEthUsdOnChain(chainId).catch(() => null),
    // WHAT NOBODY LISTED (the owner 2026-08-06 12:58) — see token-discovery.ts.
    // A curated sweep can only ever find curated tokens, which made the
    // freshly-launched low cap invisible BY CONSTRUCTION. Rides this same load;
    // adds no standing reads. Unavailable → the curated sweep alone, as before.
    discoverHeldTokens(owner, chainId).catch(() => ({ addresses: [], truncated: false, ok: false })),
  ])

  // THE SETTLEMENT TOKEN ALWAYS JOINS THE SWEEP (owner 2026-08-06 1603: "it's
  // not detecting USDG"): it is config-known (deployments.json), so missing it
  // was never a discovery problem — it just wasn't in any curated list on
  // chains like 4663. One config-derived row closes that for every chain.
  const cfg = chainCfg(chainId)
  // decimals READ from the contract, not assumed (audit 2026-08-06 #5): every
  // other hardcoded 6 sits in a transaction path that fails closed at
  // simulate — this one PRINTS a number, and an operator-configured
  // 18-decimal settlement would inflate the headline 10^12×. describeTokens
  // also bounds the symbol; config's usdcSymbol wins for the display name.
  const settlementListed = cfg.usdc && listed.some((t) => t.address.toLowerCase() === cfg.usdc!.toLowerCase())
  const settlementDesc = cfg.usdc && !settlementListed ? await describeTokens(chainId, [cfg.usdc]) : []
  const settlement = settlementDesc.map((d) => ({
    address: d.address,
    symbol: cfg.usdcSymbol ?? d.symbol,
    decimals: d.decimals,
  }))
  // The discovered + hand-added set minus everything the list already covers,
  // described from the contracts so an unlisted token can render as itself.
  const known = new Set([...listed, ...settlement].map((t) => t.address.toLowerCase()))
  const { extras: unlisted, manualSet } = planExtraTokens(known, found.addresses, manual)
  const described = unlisted.length > 0 ? await describeTokens(chainId, unlisted) : []
  const tokens = [...listed, ...settlement, ...described.map((d) => ({ address: d.address, symbol: d.symbol, decimals: d.decimals }))]

  // Concurrent reads coalesce into multicall at the transport; a FAILED read
  // is marked unreadable (null), never folded to zero.
  const balances = await Promise.all(
    tokens.map((t) =>
      client
        .readContract({ address: t.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
        .then((v) => v as bigint)
        .catch(() => null),
    ),
  )

  let unreadable = 0
  const nonzero: { token: (typeof tokens)[number]; wei: bigint }[] = []
  balances.forEach((wei, i) => {
    if (wei === null) unreadable += 1
    else if (wei > 0n) nonzero.push({ token: tokens[i], wei })
  })

  const holdings: RawHolding[] = []
  const nativeAmt = Number(formatUnits(nativeWei, 18))
  if (nativeWei > 0n) {
    holdings.push({
      chainId,
      address: NATIVE_KEY,
      symbol: 'ETH',
      decimals: 18,
      amount: nativeAmt,
      usd: ethUsd != null ? nativeAmt * ethUsd : null,
      native: true,
      verified: true,
    })
  }

  // TWO PRICING PATHS, on purpose. Listed tokens keep the kit's own pool
  // detection, byte-for-byte as before. DISCOVERED ones go through one batched
  // DexScreener read instead: there can be sixty of them, a detection each
  // would be sixty extra round trips per chain per load against the budget in
  // docs/allocator/RPC-AUDIT.md, and these are the tokens that endpoint is best
  // at anyway. Either way an unreadable price is UNPRICED, never a zero.
  const discovered = new Set(described.map((d) => d.address))
  const dexPrices = await priceDiscovered(
    dexscreenerSlugFor(chainId),
    nonzero.filter(({ token }) => discovered.has(token.address.toLowerCase())).map(({ token }) => token.address),
  )

  // Price only what is actually held — a handful in practice, each through the
  // kit's own detection + leg-USD path.
  const priced = await Promise.all(
    nonzero.map(async ({ token, wei }) => {
      const amount = Number(formatUnits(wei, token.decimals))
      const isDiscovered = discovered.has(token.address.toLowerCase())
      const price = isDiscovered
        ? (dexPrices.get(token.address.toLowerCase()) ?? null)
        : await priceHolding(chainId, token.address as Address, token.decimals, ethUsd)
      const isManual = manualSet.has(token.address.toLowerCase())
      return {
        chainId,
        address: token.address.toLowerCase(),
        symbol: token.symbol,
        decimals: token.decimals,
        amount,
        usd: price != null ? amount * price : null,
        verified: !isDiscovered,
        // hand-added rows keep their provenance whether the list, discovery,
        // or the paste itself surfaced them — the dust fold reads this flag
        ...(isManual ? { manual: true as const } : {}),
        // the airdrop bar: discovered + no credible market + nobody asked
        ...(isDiscovered && price == null && !isManual ? { suspect: true as const } : {}),
      } satisfies RawHolding
    }),
  )
  holdings.push(...priced)
  return { chainId, holdings, unreadable, discoveryGap: !found.ok || found.truncated }
}

export interface RawHoldingsResult {
  holdings: RawHolding[]
  /** Networks whose sweep failed entirely — part of the balance is unreadable. */
  chainsFailed: number
  /** The identities behind that count. A per-chain figure needs to know WHICH
   *  network is silent so it can withhold that row instead of printing a zero
   *  that reads as "you hold nothing there". */
  failedChainIds: number[]
  /** Individual token reads that failed across the readable networks. */
  unreadable: number
  /** Chains whose unlisted-token discovery failed or hit its cap — books
   *  there may be missing tokens nobody listed. */
  discoveryGaps: number
  /** Holdings visible but unpriceable right now. */
  unpriced: number
  /** Discovered rows hidden by the no-credible-market bar (the airdrop/spam
   *  cut) — surfaced as one quiet count line, never silently. */
  suspectCount?: number
}

// ── pure combine: raw holdings join the basket look-through ────────────────

export function rawToExposureRows(raw: RawHolding[]): AssetExposure[] {
  return raw
    .filter((h) => h.usd != null && h.usd > 0)
    .map((h) => ({
      key: `${h.chainId}:${h.address.toLowerCase()}`,
      address: h.address,
      symbol: h.symbol,
      chainId: h.chainId,
      valueUsd: h.usd as number,
      pct: 0,
      basketCount: 0,
      contributions: [
        {
          basketSymbol: 'held directly',
          basketAddress: h.address,
          chainId: h.chainId,
          valueUsd: h.usd as number,
        },
      ],
    }))
}

/** Merge direct wallet holdings into the basket look-through: same asset on
 *  the same chain adds up (with a "held directly" contribution line), new
 *  assets append, percentages recompute over the combined total. Purely
 *  factual — the same doctrine as computeExposure itself. */
export function combineExposure(base: ExposureBreakdown, raw: RawHolding[]): ExposureBreakdown {
  const rows = rawToExposureRows(raw)
  if (rows.length === 0) return base
  const byKey = new Map(base.assets.map((a) => [a.key, { ...a, contributions: [...a.contributions] }]))
  for (const r of rows) {
    const hit = byKey.get(r.key)
    if (hit) {
      hit.valueUsd += r.valueUsd
      hit.contributions.push(r.contributions[0])
      hit.contributions.sort((a, b) => b.valueUsd - a.valueUsd)
    } else {
      byKey.set(r.key, r)
    }
  }
  const assets = [...byKey.values()].sort((a, b) => b.valueUsd - a.valueUsd)
  const totalUsd = assets.reduce((s, a) => s + a.valueUsd, 0)
  for (const a of assets) a.pct = totalUsd > 0 ? (a.valueUsd / totalUsd) * 100 : 0
  return {
    ...base,
    assets,
    totalUsd,
    chainCount: new Set(assets.map((a) => a.chainId)).size,
  }
}
