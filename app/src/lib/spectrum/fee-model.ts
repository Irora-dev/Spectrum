// ─────────────────────────────────────────────────────────────────────────────
// Protocol fee-model constants — the fixed-slices + holder-floor form
// (fee-model redesign, on main).
//
// The fee engine is governed by FIXED PROTOCOL CONSTANTS, not per-basket dials:
//   • the PRISM burn share is a fixed `BURN_SHARE_BPS` (10% of every fee) —
//     uniform on every basket, no creator input, no ratchet (the basket has ZERO
//     deployer-controlled selectors over live state);
//   • the interface kickback is a fixed `INTERFACE_SHARE_BPS` slice of the
//     post-burn remainder (≈5% of every fee), taken per-tx when an interface tag
//     is present;
//   • the launcher/origination slice is a fixed `LAUNCHER_SHARE_BPS` of the SAME
//     post-burn base (≈5% of every fee), taken when the basket has a launcher;
//   • the creator may take up to `MAX_CREATOR_SHARE_BPS` (30%) of what remains
//     after burn/interface/launcher, paid to an immutable payout and removable
//     (0); HOLDERS are guaranteed the rest ⇒ ≥ 70% of the remainder;
//   • the per-basket fee rate `basketFeeBps` is bounded by
//     `[MIN_BASKET_FEE_BPS, MAX_BASKET_FEE_BPS]` (floor 1.00%).
//
// Why these live in the FE as constants (vs the v1 "read everything on-chain"
// rule): the burn/interface/launcher shares are compile-time `constant`s baked
// into the basket bytecode, identical across every basket and the factory — a
// verifiable protocol fact, not a mutable parameter. The launch builder needs
// the bounds on an EMPTY marketplace (no basket exists yet to read from), and the
// factory does not expose them. Mirroring an immutable constant is
// categorically different from hardcoding a settable value; the source of truth
// remains the deployed, verified bytecode. The genuinely per-basket fee fields —
// `basketFeeBps`, `creatorShareBps`, `creatorPayout`, `launcher` — are still READ
// from the basket contract (use-basket-fees.ts).
//
// Keep these in lockstep with the deployed bytecode. If a constant is re-pegged
// in the contracts, update HERE and nowhere else.
// ─────────────────────────────────────────────────────────────────────────────

const BPS = 10_000

export const PROTOCOL_FEE_MODEL = {
  /** Minimum per-basket fee (v1's flat 1.00% restored as the floor). */
  MIN_BASKET_FEE_BPS: 100,
  /** Maximum per-basket fee (3.00%). */
  MAX_BASKET_FEE_BPS: 300,
  /** PRISM burn share of every pool mint/redeem fee — FIXED, uniform, immutable (10%). */
  BURN_SHARE_BPS: 1_000,
  /** Interface kickback — FIXED slice of the post-burn remainder (≈5% of every fee). Per-tx tag. */
  INTERFACE_SHARE_BPS: 555,
  /** Launcher/origination slice — FIXED slice of the SAME post-burn base (≈5% of every fee). Per-basket. */
  LAUNCHER_SHARE_BPS: 555,
  /** Creator's maximum share of the post-burn-interface-launcher remainder (30%) ⇒ holder floor 70%. */
  MAX_CREATOR_SHARE_BPS: 3_000,
  /** Caller bounty on every flush crank (0.5% of the flushed amount). */
  CRANK_BOUNTY_BPS: 50,
  /** Creator-league slice, taken OFF THE TOP before every other split — but ONLY
   *  on a lineage whose baskets carry the league leg, and only when the basket has
   *  a `creatorPayout` (the pool refuses a zero creator, so a payout-less basket
   *  skips the league entirely and its slice flows through the normal waterfall).
   *  A chain opts in via `leagueShareBps` in its deployment entry; this is the
   *  value the league lineage compiles in. */
  LEAGUE_SHARE_BPS: 500,
} as const

/** Frontend-fee crank floor per chain, in WHOLE USDC — mirrors the mainnet
 *  lineage's MIN_FEE_CRANK_BOUNTY (10 USDC; Base + Robinhood floors are 0).
 *  A pot AT OR UNDER the floor is not usefully flushable on that chain, in
 *  EITHER lineage: the F-1 fix (2026-07-30) makes the contract REFUSE the
 *  call (silent no-op — the accrual retains and keeps growing), and the
 *  incumbent mainnet code pays the whole sub-floor pot to the CRANKER as
 *  bounty (the recipient gets zero). Both mean the UI must say "accruing",
 *  never offer a flush. ⚠ The 25/10 placeholder floors await Colby's
 *  keep/calibrate word before the salt re-mine — if they change, update this
 *  WITH the new address book, not before. */
export const FRONTEND_FLUSH_FLOOR_USDC: Record<number, number> = { 1: 10 }

export function frontendFlushFloorUsdc(chainId: number): number {
  return FRONTEND_FLUSH_FLOOR_USDC[chainId] ?? 0
}

/** True when a pending frontend-fee pot can actually be flushed on this chain
 *  (strictly above the floor — the contract refuses `<=`). */
export function frontendPotFlushable(chainId: number, potUsdc: number): boolean {
  return potUsdc > frontendFlushFloorUsdc(chainId)
}

/** Protocol fee bounds + the fixed shares, in the shape the launch builder + readouts consume. */
export const FEE_BOUNDS = {
  minFeeBps: PROTOCOL_FEE_MODEL.MIN_BASKET_FEE_BPS,
  maxFeeBps: PROTOCOL_FEE_MODEL.MAX_BASKET_FEE_BPS,
  /** The fixed PRISM burn share (replaces the v1 per-basket floor + ratchet). */
  burnShareBps: PROTOCOL_FEE_MODEL.BURN_SHARE_BPS,
  interfaceShareBps: PROTOCOL_FEE_MODEL.INTERFACE_SHARE_BPS,
  launcherShareBps: PROTOCOL_FEE_MODEL.LAUNCHER_SHARE_BPS,
  /** Cap on the creator's share of the remainder (holder floor = 100% − this). */
  maxCreatorShareBps: PROTOCOL_FEE_MODEL.MAX_CREATOR_SHARE_BPS,
} as const

export type FeeBounds = typeof FEE_BOUNDS

/** The fee waterfall as fractions of the TOTAL fee (each sink's slice; sums to 1). */
export interface FeeSplit {
  /** Creator league, taken off the top BEFORE everything else. 0 on any chain
   *  whose lineage has no league leg, and on a basket with no creator payout. */
  league: number
  /** PRISM buy-and-burn (10% off the post-league base + all rounding dust). */
  burn: number
  /** Interface kickback (present only when a tx carries an interface tag). */
  interface: number
  /** Launcher/origination (present only when the basket has a launcher). */
  launcher: number
  /** Creator's share of the remainder. */
  creator: number
  /** Holders' share of the remainder (the guaranteed floor). */
  holders: number
}

/**
 * The fee waterfall expressed as fractions of the TOTAL fee, mirroring the
 * on-chain `_distributeFee` order EXACTLY — including the order of
 * the conditional skims and the rule that BURN is the RESIDUAL sink (it gets 10%
 * plus all rounding dust, computed last):
 *   league     = fee·LEAGUE/BPS              (off the top, league lineages only,
 *                                             and only with a creatorPayout)
 *   net        = fee − league                (what the pre-existing waterfall splits)
 *   afterBurn  = net·(BPS−BURN)/BPS          (burn ≈ 10% of the post-league base)
 *   interface  = afterBurn·INTERFACE/BPS     (only when a tx carries an interface tag)
 *   launcher   = afterBurn·LAUNCHER/BPS      (only when the basket has a launcher)
 *   remainder  = afterBurn − (present skims)
 *   creator    = remainder·creatorShareBps/BPS
 *   holders    = remainder − creator         (the guaranteed ≥70% floor)
 *   burn       = fee − league − interface − launcher − creator − holders  (residual + dust)
 *
 * Unused interface/launcher slices stay in the remainder, so dropping either one
 * grows the creator + holder shares (never the burn). `hasInterface` is per-tx
 * (an interface tag rode the call); `hasLauncher` is per-basket (a launcher was
 * named at deploy). The six slices sum to exactly 1. Pure; no chain read.
 *
 * The LEAGUE leg dilutes every other sink pro-rata — each receives exactly
 * (BPS−LEAGUE)/BPS of what it got pre-league — which is why it cannot be omitted
 * from a displayed split on a league chain: leaving it out overstated the creator
 * at 24.00% where the contract pays 22.80% (kit audit). It defaults to 0, so every
 * caller that has no league lineage keeps its previous numbers byte-for-byte.
 *
 * Integer (bps-of-1e18) arithmetic reproduces the contract's truncation so the
 * displayed split matches what actually accrues on-chain.
 */
export function feeSplit(
  creatorShareBps: number,
  opts: {
    hasInterface: boolean
    hasLauncher: boolean
    /** The chain's league slice in bps (`leagueShareBps` from its deployment
     *  entry). 0/omitted = this lineage's baskets have no league leg. */
    leagueBps?: number
    /** False for a basket with no `creatorPayout`: the contract skips the league
     *  carve entirely there, so the slice flows through the normal waterfall. */
    hasCreatorPayout?: boolean
  },
): FeeSplit {
  const { BURN_SHARE_BPS, INTERFACE_SHARE_BPS, LAUNCHER_SHARE_BPS, MAX_CREATOR_SHARE_BPS } =
    PROTOCOL_FEE_MODEL
  const bps = BigInt(BPS)
  const FEE = 1_000_000_000_000_000_000n // notional 1e18-wei fee
  // League FIRST, off the top — and skipped without a creatorPayout, exactly as
  // the contract does (a payout-less basket cannot be credited to the pool).
  const leagueBps = opts.hasCreatorPayout === false ? 0 : Math.max(0, Math.round(opts.leagueBps ?? 0))
  const leagueCut = leagueBps > 0 ? (FEE * BigInt(leagueBps)) / bps : 0n
  const net = FEE - leagueCut
  const afterBurn = (net * (bps - BigInt(BURN_SHARE_BPS))) / bps
  let remainder = afterBurn
  const interfaceCut = opts.hasInterface ? (afterBurn * BigInt(INTERFACE_SHARE_BPS)) / bps : 0n
  remainder -= interfaceCut
  const launcherCut = opts.hasLauncher ? (afterBurn * BigInt(LAUNCHER_SHARE_BPS)) / bps : 0n
  remainder -= launcherCut
  const creatorBps = BigInt(Math.max(0, Math.min(Math.round(creatorShareBps), MAX_CREATOR_SHARE_BPS)))
  const creatorCut = (remainder * creatorBps) / bps
  const holdersCut = remainder - creatorCut
  // burn stays the RESIDUAL sink: it absorbs the league carve's rounding dust too,
  // because that dust stayed in `net` on-chain.
  const burnCut = FEE - leagueCut - interfaceCut - launcherCut - creatorCut - holdersCut
  const f = (x: bigint) => Number(x) / Number(FEE)
  return {
    league: f(leagueCut),
    burn: f(burnCut),
    interface: f(interfaceCut),
    launcher: f(launcherCut),
    creator: f(creatorCut),
    holders: f(holdersCut),
  }
}
