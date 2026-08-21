import { isAddress, type Address } from 'viem'
import raw from './deployments.json'

// ─────────────────────────────────────────────────────────────────────────────
// Per-chain deployment config. The checked-in deployments.json SHIPS the
// CANONICAL Spectrum address book (Base 8453 + Ethereum 1), so a zero-config
// build is a working site on the canonical deployment. Every field is an
// override point: set the VITE_* env vars (default chain only) or edit
// deployments.json to serve your OWN deployment instead. A chain with no entry
// is an honest empty shell (lists nothing, transacts nothing). The two
// fee-recipient vars (VITE_INTERFACE_TAG_ADDRESS / VITE_LAUNCHER_ADDRESS) are
// deliberately NOT part of this file and ship empty — no default fee
// recipient, ever.
//
// Env overrides (apply to the DEFAULT chain — Base 8453; static-bundle note in
// .env.example applies: every VITE_ value ships publicly):
//   VITE_FACTORY_ADDRESS, VITE_USDC_ADDRESS, VITE_POOL_MANAGER_ADDRESS,
//   VITE_SWAP_ROUTER_ADDRESS, VITE_WETH_ADDRESS, VITE_UNIV2_FACTORY_ADDRESS,
//   VITE_UNIV3_FACTORY_ADDRESS, VITE_AERODROME_FACTORY_ADDRESS,
//   VITE_UNIV3_SWAP_ROUTER_ADDRESS, VITE_UNIV3_QUOTER_ADDRESS,
//   VITE_V4_QUOTER_ADDRESS, VITE_UNIVERSAL_ROUTER_ADDRESS
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainDeployment {
  /** Spectrum V2 factory. deployments.json ships the canonical one; null = the chain is unconfigured. */
  factory: Address | null
  /** Canonical USDC for the chain (the V2 settlement asset). */
  usdc: Address | null
  /** ⚠ NAMING: unrelated to the rehearsal deploys labeled "GEN-2 decoys" in
   *  the local never-commit notes (those are a deploy-log ordinal, OLD fee
   *  model, throwaway burn sinks). THIS field names the FEE MODEL, and value 2
   *  is the PRODUCTION ceremony's model.
   *  THE FEE-MODEL GENERATION this chain's batcher+wrapper speak (the owner ruled
   *  the model 2026-08-16; contracts branch feature/no-integrator-100pct-burn):
   *    1 (default) = the shipping generation: batcher BatchParams carries a
   *      feeRecipient, wrapper swapWithFee takes 8 args, batch fee 40 bps
   *      (fee/8 integrator + 7/8 burn).
   *    2 = the PRODUCTION ceremony generation: feeRecipient GONE from both
   *      ABIs (selectors move), batch fee 25 bps, 100% of the fee buys and
   *      burns PRISM. Wrapper fee stays 40 bps.
   *  json-only, NO env override BY DESIGN (the same law as v4qLineage): the
   *  generation is a property of the deployed bytecode, so the flag must
   *  travel with the deployments.json edit that seats those addresses —
   *  an env flag could aim gen-2 calldata at a gen-1 contract, whose selector
   *  it does not have. Absent/malformed = 1: every deployed contract today. */
  feeGeneration: 1 | 2
  /** Decimals of `usdc`, carried NEXT TO the address it describes (cold-review
   *  INFO-1, 2026-08-16): every cents→raw conversion in the app derives from
   *  this instead of a hardcoded 6, so a future non-6dp settlement token works
   *  by config edit instead of silently mis-scaling the sell floor. json-only
   *  like the other integrity fields — it must travel with the json edit that
   *  points at the token (an env-swapped VITE_USDC_ADDRESS with stale decimals
   *  is caught by the runner's live decimals()-vs-config check before any
   *  money moves). Absent/malformed → 6, the value of every canonical
   *  settlement token today; the runner's on-chain verification is the
   *  enforcement either way. */
  settlementDecimals: number
  /** Uniswap V4 PoolManager singleton. */
  poolManager: Address | null
  /** Spectrum first-party swap router —
   *  the periphery that carries the (minOut, legMins[], frontend) hookData into a
   *  basket's V4 self-pool for buy/sell. deployments.json ships the CANONICAL
   *  router; override via env/json to route through your own. null (a chain with
   *  none configured) leaves the TradePanel + /swap broadcast inert —
   *  VITE_ENABLE_SWAP is the arm switch either way. */
  swapRouter: Address | null
  weth: Address | null
  uniV2Factory: Address | null
  uniV3Factory: Address | null
  /** Uniswap V3 SwapRouter02 (canonical) — executes the migrate modal's delta
   *  trades (sell dropped legs → buy added legs via the WETH hub). Optional:
   *  unset → in-kind migration still works for reweight/drop-a-leg versions,
   *  only the auto delta trade is unavailable. */
  uniV3SwapRouter: Address | null
  /** Uniswap V3 QuoterV2 (canonical) — balance-free quotes for those trades. */
  uniV3Quoter: Address | null
  /** Uniswap V4 Quoter (canonical) — quotes basket self-pools verbatim with
   *  empty hookData (the /integrate quoting path). Verified by matching the
   *  quoter's immutable poolManager() against this chain's poolManager. */
  v4Quoter: Address | null
  /** Uniswap Universal Router (canonical, v4-capable) — one standard fill path
   *  for basket self-pools (any unlock executor also works). Verified by the
   *  router bytecode embedding this chain's poolManager immutable. */
  universalRouter: Address | null
  /** Aerodrome PoolFactory (Base) — detected only to WARN (no hook support). */
  aerodromeFactory: Address | null
  /** SpectrumNotes (registry/SpectrumNotes.sol) — ownerless, event-only
   *  on-chain metadata store (creator profiles + basket theses). Optional:
   *  unset → metadata falls back to the signed-blob rungs. */
  notesRegistry: Address | null
  /** LeaguePool (registry/LeaguePool.sol; canonical home = spectrum-contracts
   *  V3) — the creator league's ownerless pool, which STREAMS each league fee
   *  slice to the current crown-holder (no prize pot, no settlement day).
   *  Optional: unset → no /league page, no league copy anywhere. */
  leaguePool: Address | null
  /** SpectrumDirectSwapWrapper — the fee rail for swaps OUTSIDE the batcher
   *  (fee/8 to the integrator, 7/8 to an immutable burn sink; see
   *  lib/spectrum/direct-swap-wrapper.ts for the call laws). Optional: unset →
   *  direct lanes keep their fee-less path. ⚠ ADDRESSES LIVE ONLY IN THE
   *  LOCAL never-commit deployments.json: the 4663/Base deploys are REHEARSAL
   *  DECOYS (Ⓡ w-385 — never a shared branch, never the live site); the
   *  mainnet one is REAL and burns real PRISM (the owner accepted, 2026-08-16). */
  directSwapWrapper: Address | null
  /** True when THIS chain's configured factory is the V4Q lineage (the stocks
   *  fork: its Venue enum adds V4Q = settlement-quoted hookless V4). Arms the
   *  detector's settlement-paired sweep, letting stocks whose depth lives
   *  USDG-side (AAPL/TSLA class) become venue-3 legs. json-only, NO env
   *  override BY DESIGN: lineage is a property of the factory, so the flag
   *  must travel with the deployments.json edit that points at that factory —
   *  a standalone env flag could arm venue 3 against a deployed V2-lineage
   *  factory, whose enum stops at V2, bricking every deploy at simulate. */
  v4qLineage: boolean
  /** True when THIS chain's configured factory is the PACKING generation: its
   *  baskets read a funding split out of bits [255:240] of each legMins word
   *  (hook-data.ts) instead of taking the whole word as the floor. Only the FIRST
   *  mint needs this flag — every later buy learns the generation from the lens's
   *  own answer (contract-split.ts), but at supply 0 the lens refuses on BOTH
   *  generations with the same MissingHookData, so nothing on-chain tells them
   *  apart there. json-only, NO env override BY DESIGN, and for the same reason as
   *  `v4qLineage`: the split field is compiled into the basket bytecode, so the
   *  flag must travel with the deployments.json edit that points at that factory.
   *  Wrong either way FAILS CLOSED at simulate (a split on a pre-packing basket is
   *  an astronomical floor → LegMinNotMet; no split on a packing basket acquires
   *  nothing → FirstMintUnderValued), and it is read for the CURRENT factory only —
   *  a superseded lineage keeps its own generation. Ships false everywhere: every
   *  live factory today is pre-packing. */
  packsFundingSplit: boolean
  /** True when THIS chain's configured factory REJECTS Uniswap V2 legs: its
   *  basket constructor reverts `InvalidEthPool` on venue 2 (contracts commit
   *  626b83a, "V2 gutted"). CREATE2 discards the inner reason, so the factory
   *  can only report `CREATE2Failed` — which means a V2-routed leg mines fine,
   *  prices fine, and then bricks the deploy at simulate behind a message that
   *  names no cause (diagnosed 2026-08-13, commit 6b2a185; it cost a live
   *  bundle publish on BOTH rehearsal chains). Armed here, the detector never
   *  RANKS a V2 pool on this chain and the resolve path REFUSES a V2-only token
   *  by name, so every add surface inherits the ruling at once (owner
   *  2026-08-13: "ensure the create page both routes to pools non v2 and also
   *  flags a warning to prevent a v2 pool being added to a basket").
   *
   *  json-only, NO env override BY DESIGN, and for the same reason as
   *  `v4qLineage`: the check is compiled into the basket bytecode, so the flag
   *  must travel with the deployments.json edit that points at that factory.
   *  Ships ABSENT everywhere and defaults FALSE — PRODUCTION STILL ACCEPTS V2
   *  (probe-verified 2026-08-13: the canonical factory simulates a V2 leg
   *  fine), so arming it globally would change production routing for a
   *  constraint production does not have. */
  rejectsV2Legs: boolean
  /** The creator-league slice this chain's baskets take OFF THE TOP of every fee,
   *  in bps (0 = this lineage has no league leg). Like `v4qLineage` this is
   *  json-only with NO env override BY DESIGN: it is a compile-time constant in
   *  the basket bytecode, so it must travel with the deployments.json edit that
   *  points at that factory. Getting it wrong doesn't break a transaction — it
   *  makes every DISPLAYED fee split wrong, which is why it is config and not a
   *  guess (a league chain showed the creator 24.00% where the contract paid
   *  22.80%, and the league slice nowhere at all). */
  leagueShareBps: number
  /** Superseded lineages whose baskets stay LISTED and TRADABLE through their
   *  own contracts (owner 2026-08-01: "the old baskets should continue to
   *  show, but every new launch is solely from the new contracts"). Each pair
   *  is a retired factory + the router its baskets trade through — discovery
   *  enumerates them, the trade path routes per basket, and the LAUNCH path
   *  never touches them (it reads only `factory`). json-only, no env override:
   *  a lineage is a fact about deployed history, not a per-site knob. */
  legacy: { factory: Address; swapRouter: Address }[]
  /** SpectrumBatcher — the one-tx-per-chain portfolio batch periphery. NULL
   *  until the owner's ceremony seats the address (a deployments.json row, not a
   *  code change). json-only with NO env override BY DESIGN and BY PIN
   *  (supply-chain S-pins, threat-model §3c): this contract moves money in
   *  one call, so its address must never be swappable by build environment —
   *  the runner refuses any chain where it is null. */
  batcher: Address | null
}

function addr(v: unknown): Address | null {
  return typeof v === 'string' && isAddress(v, { strict: false }) ? (v as Address) : null
}

const ENV_OVERRIDES: Partial<Record<AddressField, string | undefined>> = {
  factory: import.meta.env.VITE_FACTORY_ADDRESS,
  usdc: import.meta.env.VITE_USDC_ADDRESS,
  poolManager: import.meta.env.VITE_POOL_MANAGER_ADDRESS,
  swapRouter: import.meta.env.VITE_SWAP_ROUTER_ADDRESS,
  weth: import.meta.env.VITE_WETH_ADDRESS,
  uniV2Factory: import.meta.env.VITE_UNIV2_FACTORY_ADDRESS,
  uniV3Factory: import.meta.env.VITE_UNIV3_FACTORY_ADDRESS,
  uniV3SwapRouter: import.meta.env.VITE_UNIV3_SWAP_ROUTER_ADDRESS,
  uniV3Quoter: import.meta.env.VITE_UNIV3_QUOTER_ADDRESS,
  v4Quoter: import.meta.env.VITE_V4_QUOTER_ADDRESS,
  universalRouter: import.meta.env.VITE_UNIVERSAL_ROUTER_ADDRESS,
  aerodromeFactory: import.meta.env.VITE_AERODROME_FACTORY_ADDRESS,
  notesRegistry: import.meta.env.VITE_NOTES_REGISTRY_ADDRESS,
  leaguePool: import.meta.env.VITE_LEAGUE_POOL_ADDRESS,
  directSwapWrapper: import.meta.env.VITE_DIRECT_SWAP_WRAPPER_ADDRESS,
}

type AddressField = Exclude<
  keyof ChainDeployment,
  'v4qLineage' | 'packsFundingSplit' | 'rejectsV2Legs' | 'leagueShareBps' | 'legacy' | 'settlementDecimals' | 'feeGeneration'
>

const FIELDS: AddressField[] = [
  'factory',
  'usdc',
  'poolManager',
  'swapRouter',
  'weth',
  'uniV2Factory',
  'uniV3Factory',
  'uniV3SwapRouter',
  'uniV3Quoter',
  'v4Quoter',
  'universalRouter',
  'aerodromeFactory',
  'notesRegistry',
  'leaguePool',
  'directSwapWrapper',
]

/** The default chain env overrides apply to (Base). */
export const DEFAULT_CHAIN_ID = 8453

export function deploymentFor(chainId: number): ChainDeployment {
  const entry = (raw as Record<string, Record<string, unknown>>)[String(chainId)] ?? {}
  const out = {} as ChainDeployment
  for (const f of FIELDS) {
    const env = chainId === DEFAULT_CHAIN_ID ? addr(ENV_OVERRIDES[f]) : null
    out[f] = env ?? addr(entry[f])
  }
  // Not addresses — and json-only (see the field docs for why no env override).
  out.v4qLineage = entry.v4qLineage === true
  // Strict `=== true`: an absent or malformed value means the legacy payload shape,
  // which is what every deployed basket reads today.
  out.packsFundingSplit = entry.packsFundingSplit === true
  // Strict `=== true` again, and the direction of the default is the point: an
  // absent, misspelled or stringy value must mean "this factory takes V2" —
  // which is what every canonical factory does. The flag may only ever ADD a
  // restriction, never silently remove one chain's venue because a JSON edit
  // went wrong.
  out.rejectsV2Legs = entry.rejectsV2Legs === true
  const league = Number(entry.leagueShareBps)
  // Bounded: a malformed or absurd value must degrade to "no league leg" rather
  // than silently rewrite every displayed fee split.
  out.leagueShareBps = Number.isFinite(league) && league > 0 && league <= 2_000 ? Math.round(league) : 0
  // Legacy lineages: validated pairs only — a malformed entry is dropped, and a
  // pair missing either address is dropped whole (a factory whose baskets have
  // no router would list things the site can't trade).
  out.legacy = Array.isArray(entry.legacy)
    ? (entry.legacy as unknown[]).flatMap((l) => {
        const rec = (l ?? {}) as Record<string, unknown>
        const factory = addr(rec.factory)
        const swapRouter = addr(rec.swapRouter)
        return factory && swapRouter ? [{ factory, swapRouter }] : []
      })
    : []
  // The batcher seats from deployments.json ONLY — never the environment (the
  // S-pin above deploymentFor asserts the override block cannot name it).
  out.batcher = addr(entry.batcher)
  // Settlement decimals: bounded to [2, 36] integers (a value below 2 would
  // make the cents divisor 10^negative; above 36 is nothing on any chain).
  // Malformed/absent → 6, and the runner's live decimals() check refuses a
  // lying config before money moves, so the default can never silently
  // mis-scale a floor.
  const dec = Number(entry.usdcDecimals)
  out.settlementDecimals = Number.isInteger(dec) && dec >= 2 && dec <= 36 ? dec : 6
  // Strict === 1: anything else (absent, "1", junk, a FUTURE 3) is treated as
  // the 100%-burn generation. ⚠ THE DIRECTION FLIPPED 2026-08-19 — the old
  // unknown→1 default was the DANGEROUS direction, measured live: gen-1
  // arithmetic against a 100%-burn contract sizes the burn route at 7/8 and
  // diverts an eighth of every fee BY CONSTRUCTION (the 2026-08-18 incident's
  // second defect). Unknown→2 fail-closes instead: an over-sized route on a
  // true gen-1 chain trips the contract's own burn floor and the whole share
  // diverts LOUDLY (disclosed, recoverable at the sink) rather than leaking
  // silently. Every seated chain declares its generation explicitly (all 2
  // today), so this default only ever meets junk or the future.
  out.feeGeneration = entry.feeGeneration === 1 ? 1 : 2
  return out
}

/** The fee-model generation this chain's money contracts speak — see the
 *  field doc. Every gen-discriminated call site resolves through THIS. */
export function feeGenerationFor(chainId: number): 1 | 2 {
  return deploymentFor(chainId).feeGeneration
}

/** Decimals of `chainId`'s settlement token — THE one source every cents↔raw
 *  conversion must use (never a local `= 6`; cold-review INFO-1). Verified
 *  against the chain by the runner before anything signs. */
export function settlementDecimalsFor(chainId: number): number {
  return deploymentFor(chainId).settlementDecimals
}

/** Chain ids present in deployments.json (the shipped canonical book: Base, Ethereum + Robinhood). */
export function configuredChainIds(): number[] {
  return Object.keys(raw as Record<string, unknown>)
    .map(Number)
    .filter((n) => Number.isInteger(n))
}
