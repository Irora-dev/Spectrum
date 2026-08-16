import { encodeAbiParameters, zeroAddress, type Address, type Hex } from 'viem'
import { INTERFACE_TAG_ADDRESS } from '../config/operator'

// ─────────────────────────────────────────────────────────────────────────────
// The SINGLE hookData encoder for every transactional path.
// V2 contracts hard-revert on empty hookData; per-leg minimums (legMins)
// are the primary first-mint per-leg floor.
//
// SECURITY INVARIANT — no silent zero path, EVER:
//   • legMins are always derived from the live per-leg quote at sign time.
//   • There is no code path that encodes zero, empty, or placeholder legMins —
//     not for the first mint, not behind any "disable slippage protection"
//     toggle (none exists), not as a fallback. Callers without live quotes
//     cannot encode; encodeMintHookData throws instead of degrading.
// Do not add a bypass. The contract reverting on empty hookData is the backstop;
// the FE must never invite that revert nor work around it.
//
// Layout: abi.encode( uint256 minOut, uint256[] legMins, address frontend ).
// The `frontend` slot is the interface-kickback tag: address(0) = no tag
// → the kickback slice follows the creator's routing.
//
// ⛔ EACH legMins WORD IS TWO FIELDS ON A D-R1 BASKET — funding split in bits
// [255:240], anti-sandwich floor in [239:0] (SpectrumBasket SPLIT_SHIFT = 240).
// This encoder used to write PLAIN floors, i.e. a zero split on every leg, and
// contracts MEASURED what that does (their test/KitZeroSplitProbe.t.sol,
// 2026-08-05, default 3-leg basket at supply > 0):
//   · packed split           → fills, 4886 shares
//   · EMPTY hookData         → fills, 4901 shares (the factory derives the split)
//   · this kit's zero split  → REVERTS NoOutput (0x5a7cfa65)
// WHY: `_beforeSwap` consults `factory.bareLegMins` ONLY when hookData is empty
// (SpectrumBasket.sol:491). With a non-empty payload `_acquireBasket` reads the
// split straight out of `legMins[i] >> 240` (:616), so all-zero splits sum to
// `nonBufferWeight == 0`, the acquire loop returns early (:652), nothing is
// bought and the mint has no output. A HEALTHY basket reverts, not just a
// starved one. Same shape in the stocks/robinhood lineage.
//
// ⛔ AND THE SPLIT MAY NEVER BE DERIVED FROM TARGET WEIGHTS. It comes from
// `factory.bareLegMins(basket, amountIn)` and is passed through untouched
// (mint-funding.ts is the only producer; contract-split.ts decodes it).
// Contracts measured the difference on a basket whose first minter starved a
// leg, with $5,000 of attacker capital: a $10,000 buy funded at TARGET WEIGHTS
// ends with $4,255, the same buy funded at the lens split ends with $9,900.
// Their `_packTargetSplit` test helper is annotated as the exploitable shape;
// `_mintBasketLensSplit` is the safe reference.
//
// TWO EXCEPTIONS, and each is a separate `MintFunding` case so neither can ever
// be confused with a lens answer. Both are the SAME moment (the first mint on a
// packing deployment, where the lens refuses at supply 0 and the money being
// divided is the first minter's own); they differ only in where the weights are
// read, because at one of them the basket does not exist yet:
//   · `first-mint-weights`   — read off the deployed basket (first-mint-split.ts).
//   · `deploy-args-weights`  — read off the deployBasket ARGUMENTS, on the atomic
//                              launch only (launch-first-mint.ts). Sound because
//                              those arguments ARE the address: the factory
//                              abi.encodes the weights into the init code it
//                              CREATE2s from, so the split is bound to the basket
//                              being created in the same transaction.
// mint-funding.ts states the law and why neither exception widens.
// ─────────────────────────────────────────────────────────────────────────────

// Slippage here must absorb REAL execution friction, not just volatility: a sell
// unwinds every leg (asset→ETH, each pool's fee + price impact) and then the hub
// leg (ETH→settlement, again fee + impact), while the FE's expected-out is derived
// from the basket's FRICTIONLESS exchangeRate() NAV. Measured live on Robinhood
// 2026-07-14: realised proceeds land ~1.8% under NAV at ~1 share and degrade with
// size, so a 1% default made every sell above ~5 shares revert SlippageExceeded
// (the "cannot sell at all" report). 3% restores small/mid sells.
// NOTE: raising this does NOT fix large sells — past a few % of basket reserves the
// shortfall is structural price impact (measured −44% at 500/5452 shares), which no
// tolerance should paper over. The real fix is deriving minOut from a SIMULATED
// realised quote instead of NAV; see the 1400 redteam/bug note in the ops repo.
export const DEFAULT_SLIPPAGE_BPS = 300 // 3%
export const MAX_SLIPPAGE_BPS = 500 // hard UI cap: 5%
export const WARN_SLIPPAGE_BPS = 400 // entries above 4% warn in the UI (3% is now the default)

const BPS = 10_000n

/** SpectrumBasket.SPLIT_SHIFT — the funding split rides bits [255:240] of each word. */
export const SPLIT_SHIFT = 240n
/** Bits [239:0]: the per-leg anti-sandwich floor (SpectrumBasket.FLOOR_MASK). */
export const FLOOR_MASK = (1n << SPLIT_SHIFT) - 1n
/** A split is basis points of the whole buy, so 10000 is the whole trade. The
 *  contract reverts LegMinNotMet on a USDC leg above BPS (its phantom-reserve bound). */
export const MAX_SPLIT_BPS = 10_000

/** Pack one legMins word: split bps in the top 16 bits, floor in the low 240. */
export function packLegMin(splitBps: number, floor: bigint): bigint {
  if (!Number.isInteger(splitBps) || splitBps < 0 || splitBps > MAX_SPLIT_BPS) {
    throw new Error(`hook-data: a funding split of ${splitBps} is not a basis-point value in 0..${MAX_SPLIT_BPS}.`)
  }
  if (floor < 0n || floor > FLOOR_MASK) {
    throw new Error('hook-data: a per-leg floor does not fit the low 240 bits of its word.')
  }
  return (BigInt(splitBps) << SPLIT_SHIFT) | floor
}

/**
 * Where each leg's FUNDING SHARE comes from. Required on every mint payload, and
 * a discriminated union on purpose: the zero-split bug shipped because "no split"
 * was the silent default. Now a caller must name its source, and the only source
 * of a split is the factory's lens.
 */
export type MintFunding =
  | {
      /** `factory.bareLegMins(basket, amountIn)` splits, decoded and passed through
       *  UNTOUCHED (mint-funding.ts). Never target weights, never our own marks. */
      source: 'lens-split'
      splitBps: readonly number[]
    }
  | {
      /** THE FIRST MINT ON A PACKING DEPLOYMENT, AND NOTHING ELSE. The basket's own
       *  on-chain `basket(i).weight` values as the split (first-mint-split.ts). It is
       *  a SEPARATE case from `lens-split` on purpose: these numbers are weights, the
       *  one shape the security law forbids everywhere else, and a payload built from
       *  them must never be able to pass for a lens answer. Legal only because the
       *  money being divided is the first minter's own and there is no earlier holder
       *  to under-fund. From the second mint on, the lens answers and this is the
       *  starved-basket exploit — see mint-funding.ts. */
      source: 'first-mint-weights'
      splitBps: readonly number[]
    }
  | {
      /** THE ATOMIC LAUNCH'S FIRST MINT, AND NOTHING ELSE. The same first-mint
       *  exception one step earlier in time: the basket does not exist yet, so the
       *  weights come from the `deployBasket` arguments in the same batch rather
       *  than off the deployed basket. Sound because those arguments ARE the
       *  address (SpectrumFactory._buildInitCode abi.encodes the BasketEntry array
       *  into the init code it CREATE2s from), so the split is cryptographically
       *  bound to the basket being created, in one transaction, signed by the
       *  person funding it. This case exists so an ordinary buy cannot reach it:
       *  launch-first-mint.ts is its only producer and decideMintFunding never
       *  returns it. Same edges as `first-mint-weights` below in fundingSplits. */
      source: 'deploy-args-weights'
      splitBps: readonly number[]
    }
  | {
      /** No split rides the payload: the basket funds each leg from its OWN target
       *  weights and reads the whole word as the floor. Legal on exactly two
       *  deployments/moments, which is why the reason is mandatory. */
      source: 'basket-weights'
      because:
        /** The factory answers `bareLegMins` UNPACKED (or not at all), so this
         *  basket predates the split field and would read a packed word as an
         *  astronomically high floor — LegMinNotMet on every buy. */
        | 'pre-packing-deployment'
        /** effectiveSupply() == 0: the lens refuses (MissingHookData) because only
         *  the caller's independent price source may protect the first mint. */
        | 'first-mint'
    }

export interface MintHookDataInput {
  /** Live per-leg quoted amounts (raw units), exactly as quoted at sign time. */
  quotedLegAmounts: bigint[]
  /** Slippage tolerance in bps, 1..MAX_SLIPPAGE_BPS. */
  slippageBps: number
  /** Aggregate minimum out (raw units), already slippage-adjusted by the caller. */
  minOut: bigint
  /** Interface-kickback tag override; defaults to the operator env config. */
  interfaceTag?: Address | null
  /** Per-leg funding share, or the named reason there is none. No default exists. */
  funding: MintFunding
}

export interface EncodedHookData {
  hookData: Hex
  /** The per-leg FLOORS actually encoded — surface these in the review step. */
  legMins: bigint[]
  /** The words as they go on the wire: floor, plus the split when there is one. */
  words: bigint[]
  /** The funding split encoded per leg; all-zero only on a `basket-weights` payload. */
  splitBps: number[]
  minOut: bigint
  frontend: Address
}

export function clampSlippageBps(bps: number): number {
  if (!Number.isFinite(bps)) return DEFAULT_SLIPPAGE_BPS
  return Math.min(Math.max(Math.round(bps), 1), MAX_SLIPPAGE_BPS)
}

/** legMins[i] = quotedLeg[i] × (1 − slippageBps/10000), floor-rounded. */
export function deriveLegMins(quotedLegAmounts: bigint[], slippageBps: number): bigint[] {
  const s = BigInt(clampSlippageBps(slippageBps))
  return quotedLegAmounts.map((q) => (q * (BPS - s)) / BPS)
}

export function encodeMintHookData(input: MintHookDataInput): EncodedHookData {
  const { quotedLegAmounts, minOut, funding } = input
  if (quotedLegAmounts.length === 0) {
    throw new Error('hook-data: refusing to encode without live per-leg quotes (no zero/empty legMins path exists).')
  }
  if (
    funding == null ||
    (funding.source !== 'lens-split' &&
      funding.source !== 'basket-weights' &&
      funding.source !== 'first-mint-weights' &&
      funding.source !== 'deploy-args-weights')
  ) {
    // The zero-split payload that reverted NoOutput was reachable by OMISSION.
    // It no longer is: a buy states where its funding share came from, or nothing
    // is encoded at all.
    throw new Error('hook-data: a buy must state where its per-leg funding split comes from before it can be encoded.')
  }
  const splitBps = fundingSplits(funding, quotedLegAmounts.length)
  const slippageBps = clampSlippageBps(input.slippageBps)
  // A leg the split funds with NOTHING is skipped by the acquire loop, so a floor on
  // it is a guaranteed LegMinNotMet (SpectrumBasket.sol:667) — the factory's own lens
  // ships 0 there for the same reason. Nothing is unprotected: an unfunded leg is
  // never swapped, so it has no sandwich surface. Only the lens may declare this.
  const unfunded = (i: number) => funding.source === 'lens-split' && splitBps[i] === 0
  const funded = quotedLegAmounts.filter((_, i) => !unfunded(i))
  if (funded.length === 0) {
    throw new Error('hook-data: the funding split leaves every leg unfunded, so this buy would acquire nothing.')
  }
  if (funded.some((q) => q <= 0n)) {
    throw new Error('hook-data: every funded leg must have a positive live quote at sign time.')
  }
  const floors = deriveLegMins(quotedLegAmounts, slippageBps).map((m, i) => (unfunded(i) ? 0n : m))
  if (floors.some((m, i) => m <= 0n && !unfunded(i))) {
    // A floor-rounded zero min would silently disable the per-leg protection.
    throw new Error('hook-data: a derived leg minimum rounded to zero — quote too small to protect; aborting.')
  }
  const words = floors.map((floor, i) => packLegMin(splitBps[i], floor))
  const frontend = (input.interfaceTag ?? INTERFACE_TAG_ADDRESS ?? zeroAddress) as Address
  const hookData = encodeAbiParameters(
    [
      { name: 'minOut', type: 'uint256' },
      { name: 'legMins', type: 'uint256[]' },
      { name: 'frontend', type: 'address' },
    ],
    [minOut, words, frontend],
  )
  return { hookData, legMins: floors, words, splitBps, minOut, frontend }
}

/** Validate the funding and return the per-leg split to encode. Throws rather than
 *  emitting a payload the chain will refuse — the whole point of the fix. */
function fundingSplits(funding: MintFunding, legCount: number): number[] {
  if (funding.source === 'basket-weights') return new Array<number>(legCount).fill(0)
  const { splitBps } = funding
  if (splitBps.length !== legCount) {
    throw new Error(
      `hook-data: the funding split does not match this basket (${legCount} legs quoted, ${splitBps.length} in the split).`,
    )
  }
  for (const s of splitBps) {
    if (!Number.isInteger(s) || s < 0 || s > MAX_SPLIT_BPS) {
      throw new Error(`hook-data: a funding split of ${s} is not a basis-point value in 0..${MAX_SPLIT_BPS}.`)
    }
  }
  // THE MEASURED BUG, made unreachable: all-zero splits sum to nonBufferWeight == 0,
  // the acquire loop returns early, and the mint reverts NoOutput with nothing bought.
  if (splitBps.every((s) => s === 0)) {
    throw new Error('hook-data: the funding split is zero on every leg, which would buy nothing; refusing to encode.')
  }
  if (funding.source === 'first-mint-weights' || funding.source === 'deploy-args-weights') {
    // The first mint's OWN two extra rules, re-checked at the last gate before the
    // wire, and they bind BOTH first-mint cases: the atomic launch's split is the
    // same numbers read one step earlier, so it inherits the same edges rather than
    // a looser copy of them.
    // (1) No leg may be unfunded: a zero-split leg is skipped by the acquire
    // loop, while the first mint REQUIRES a non-zero floor on every non-USDC leg
    // (FirstMintLegMinRequired) — together those revert. (2) The total must be the
    // whole trade: the USDC buffer leg takes `usdcNet × sp / 10000` literally, so a
    // short total quietly leaves it under-funded. A basket's own weights already
    // total 10000 (its constructor requires it), so this fails loudly rather than
    // paper over a set that does not.
    if (splitBps.some((s) => s <= 0)) {
      throw new Error('hook-data: a first mint cannot leave a holding unfunded; refusing to encode.')
    }
    if (splitBps.reduce((sum, s) => sum + s, 0) !== MAX_SPLIT_BPS) {
      throw new Error("hook-data: a first mint's funding split must divide the whole buy; refusing to encode.")
    }
  }
  return [...splitBps]
}

export interface RedeemHookDataInput {
  /** Number of legs = the on-chain basket length (the per-leg array is zero-filled). */
  legCount: number
  /** Aggregate minimum USDC out (raw) — the BINDING sell protection. */
  minOut: bigint
  interfaceTag?: Address | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Redeem (sell) hookData — DIFFERENT protection model from mint.
//
// On a sell, the binding protection is the AGGREGATE USDC `minOut`: SpectrumBasket
// `_sellFlow` reverts `SlippageExceeded` when the realized USDC is below it, and the
// swap router backstops the same floor. The per-leg `legMins` consumed by `_unwindToUsdc`
// are OPTIONAL there and ETH/USDC-denominated (NOT constituent-token counts like the mint
// path) — the FE does not reconstruct those units, so it ships length-correct ZERO per-leg
// floors. The hook accepts this: `BadLegMinsLength` is a LENGTH check, and zero values
// simply skip the per-leg guard.
//
// This is NOT a violation of the mint-path "no silent zero" invariant (that is the
// first-mint per-leg-floor invariant, which is mint-only). A sell is protected by the aggregate
// `minOut` it commits here — which this function REQUIRES to be non-zero.
// ─────────────────────────────────────────────────────────────────────────────
export function encodeRedeemHookData(input: RedeemHookDataInput): EncodedHookData {
  if (!Number.isInteger(input.legCount) || input.legCount <= 0) {
    throw new Error('hook-data: redeem requires a positive on-chain leg count.')
  }
  if (input.minOut <= 0n) {
    // The aggregate minOut IS the sell protection — never ship an unprotected sell.
    throw new Error('hook-data: redeem requires a positive aggregate minOut (the binding sell floor).')
  }
  const legMins = new Array<bigint>(input.legCount).fill(0n)
  const frontend = (input.interfaceTag ?? INTERFACE_TAG_ADDRESS ?? zeroAddress) as Address
  const hookData = encodeAbiParameters(
    [
      { name: 'minOut', type: 'uint256' },
      { name: 'legMins', type: 'uint256[]' },
      { name: 'frontend', type: 'address' },
    ],
    [input.minOut, legMins, frontend],
  )
  // No split on a sell, ever: `_unwindToUsdc` masks bits [239:0] as the floor and has
  // no funding to divide — all value converges on the aggregate USDC minOut above.
  return { hookData, legMins, words: legMins, splitBps: legMins.map(() => 0), minOut: input.minOut, frontend }
}
