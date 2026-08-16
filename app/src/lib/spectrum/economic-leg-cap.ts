// ─────────────────────────────────────────────────────────────────────────────
// THE ECONOMIC LEG CAP — the bound the CONTRACT DELEGATES TO US, in writing.
//
// `SpectrumPortfolioBatcher.MAX_LEGS = 32` carries this notice above it:
//
//   "Griefing bound only. ⚠ NOT an economically usable ceiling, and deliberately
//    NOT per-chain (round-3 E7). A 32-leg batch is ~7–12.5M gas with real 0x
//    routes, which on Ethereum costs more than this product's entire fee above
//    ~2.2 gwei, and EIP-7825 caps a single transaction at 16,777,216 gas
//    regardless of block limits. The usable leg count is therefore a PER-CHAIN
//    ECONOMIC decision, and it belongs in the backend — encoding it here would
//    fork this contract's bytecode per chain and destroy the chain-agnostic
//    property for a bound the backend can enforce better."
//
// We are the backend. Until this module existed the app mirrored 32 and stopped
// there — enforcing the griefing bound while the economic bound, explicitly
// assigned to us, was enforced by nobody. Found by applying the rule the
// 2026-08-07 audit earned: **when a contract states an obligation in prose, A1's
// constant-diff cannot see it, so the obligation is a test and a module.**
//
// TWO SEPARATE CEILINGS, and they fail differently:
//
//  1. THE PROTOCOL CEILING (EIP-7825): one transaction may not exceed
//     16,777,216 gas, whatever the block limit. Exceeding it is not expensive,
//     it is IMPOSSIBLE — the transaction is invalid. This bound is absolute and
//     chain-independent.
//  2. THE ECONOMIC CEILING: the batch's own gas cost, in dollars, versus what
//     the user pays us to run it. A batch that costs more in gas than the fee it
//     charges is one the user should have been told to split, and on Ethereum
//     the contract measured that crossover at ~2.2 gwei.
//
// ⚠ THE PER-LEG GAS FIGURE IS THE TAIL, NOT THE MEDIAN. Their own E6 withdrawal
// records that taking a bound from "a reasoned range" instead of a measured tail
// is how that gate failed: a 180k–350k estimate was the median, and 0x's own
// published snapshot for the most liquid pair on mainnet is 1,835,703 gas. So
// this module uses the TOP of the contract's measured range (12.5M / 32 legs)
// and states that it is doing so. A cap derived from the optimistic end would be
// a guess wearing a measurement's clothes.
// ─────────────────────────────────────────────────────────────────────────────

/** EIP-7825's per-transaction gas cap. Absolute: above this the transaction is
 *  invalid, not merely expensive. */
export const MAX_TX_GAS = 16_777_216

/** Per-leg gas, from the contract's own measured range for real 0x routes
 *  (~7–12.5M for 32 legs). We take the PESSIMISTIC end deliberately — see the
 *  header's note on how the E6 bound died. */
export const GAS_PER_LEG_TAIL = Math.floor(12_500_000 / 32) // 390,625

/** Fixed overhead outside the per-leg work: the funding pull, the fee transfer,
 *  the refund, and the transaction's own 21k. Rounded up. */
export const BATCH_BASE_GAS = 120_000

/** How much of the operating fee the network may eat before the batch is a bad
 *  deal for the user. 1.0 would mean "gas may consume the ENTIRE fee", which is
 *  the crossover the contract calls out rather than a target; 0.5 keeps the
 *  product's own cut at least equal to what the chain takes.
 *  ⚠ A DESIGN CONSTANT, not a measurement — the one number here that is a
 *  judgement, so it is named, exported, and stated as such rather than buried. */
export const MAX_GAS_SHARE_OF_FEE = 0.5

/** A plausible leg count. ⚠ `Number.isInteger(1e21)` is TRUE — the same trap
 *  that once composed a deadline ~30 trillion years out — so "is it an integer"
 *  does NOT bound a count. Without this ceiling a hostile `contractMaxLegs`
 *  walked the guard and the protocol ceiling (42) became the answer, ABOVE the
 *  real contract's 32. Caught by the standing hostile-number sweep on this
 *  module's first run. */
export const MAX_PLAUSIBLE_LEGS = 1_024

export interface LegCapInputs {
  /** The griefing bound mirrored from the contract — never exceeded. */
  contractMaxLegs: number
  /** Gas price in wei. Null = unreadable, which REFUSES rather than assuming a
   *  cheap chain: an unmeasured gas price is not a low gas price, and the whole
   *  point of this bound is that it bites exactly when gas is expensive. */
  gasPriceWei: bigint | null
  /** USD per whole native token. Null = unreadable → refuse, same reasoning. */
  nativeUsd: number | null
  /** What the user pays us for this batch, USD (feeBps on deployed capital). */
  feeUsd: number
}

export interface LegCapVerdict {
  /** The most legs this batch may carry. 0 = do not submit at all. */
  maxLegs: number
  /** Which ceiling bound it — for the review's sentence and the audit trail. */
  bound: 'contract' | 'protocol-gas' | 'economics' | 'unreadable'
  /** Plain words, shown when the cap actually cuts the plan. */
  message: string | null
}

/**
 * The usable leg count for THIS batch on THIS chain right now.
 *
 * Pure: every input is measured elsewhere. Returns the binding ceiling and says
 * which one it was, because "your plan was split" and "your plan was split
 * because gas is expensive on this network today" are different sentences and
 * only the second one is useful.
 */
export function economicLegCap(input: LegCapInputs): LegCapVerdict {
  const hard =
    Number.isInteger(input.contractMaxLegs) && input.contractMaxLegs > 0 && input.contractMaxLegs <= MAX_PLAUSIBLE_LEGS
      ? input.contractMaxLegs
      : 0
  if (hard === 0) {
    return { maxLegs: 0, bound: 'unreadable', message: 'We could not read this network’s batch limit, so we will not compose a batch against a guess.' }
  }

  // THE PROTOCOL CEILING first: it is absolute, and it does not depend on price.
  const byProtocol = Math.floor((MAX_TX_GAS - BATCH_BASE_GAS) / GAS_PER_LEG_TAIL)
  let maxLegs = Math.min(hard, Math.max(0, byProtocol))
  let bound: LegCapVerdict['bound'] = byProtocol < hard ? 'protocol-gas' : 'contract'

  // THE ECONOMIC CEILING. Unreadable inputs refuse — an unmeasured gas price is
  // not a cheap one, and this bound exists precisely for the expensive case.
  if (input.gasPriceWei == null || input.gasPriceWei < 0n || input.nativeUsd == null || !Number.isFinite(input.nativeUsd) || input.nativeUsd <= 0) {
    return {
      maxLegs: 0,
      bound: 'unreadable',
      message: 'We could not read what this network charges right now, so we cannot tell you whether the fees would be worth it. Try again in a moment.',
    }
  }
  if (!Number.isFinite(input.feeUsd) || input.feeUsd <= 0) {
    // No fee revenue to weigh gas against: the economic bound has no meaning
    // here, so the protocol/contract ceiling stands alone rather than a
    // division by zero deciding how many assets someone may buy.
    return { maxLegs, bound, message: null }
  }

  const gasBudgetUsd = input.feeUsd * MAX_GAS_SHARE_OF_FEE
  // wei → USD without floats losing the exponent: gwei-scale intermediate.
  const perLegUsd = (Number(input.gasPriceWei) / 1e18) * GAS_PER_LEG_TAIL * input.nativeUsd
  const baseUsd = (Number(input.gasPriceWei) / 1e18) * BATCH_BASE_GAS * input.nativeUsd
  if (!Number.isFinite(perLegUsd) || perLegUsd <= 0) return { maxLegs, bound, message: null }

  const byEconomics = Math.floor((gasBudgetUsd - baseUsd) / perLegUsd)
  if (byEconomics < maxLegs) {
    maxLegs = Math.max(0, byEconomics)
    bound = 'economics'
  }

  if (maxLegs === 0) {
    return {
      maxLegs: 0,
      bound,
      message:
        bound === 'economics'
          ? 'Network fees on this chain are currently higher than this purchase is worth. Wait for them to fall, or buy a larger amount at once.'
          : 'This batch cannot fit in a single transaction on this network.',
    }
  }
  return {
    maxLegs,
    bound,
    message:
      bound === 'contract'
        ? null
        : bound === 'economics'
          ? `Network fees are high right now, so this network can take ${maxLegs} asset${maxLegs === 1 ? '' : 's'} in one go before the fees outweigh the purchase.`
          : `A single transaction on this network fits ${maxLegs} asset${maxLegs === 1 ? '' : 's'}.`,
  }
}
