import { zeroAddress, type Address } from 'viem'
import {
  asFundingRaw,
  composeBatchBuy,
  feeCentsOfTotal,
  scaleLegBudgetsToRaw,
  BatchComposeRefusal,
  type BatcherLegInput,
  type ComposedBatchBuy,
} from './batcher'
import { planToFlooredLegs, type FlooredPlanLeg, type PlanConcentration, type PlanLegInput, type PlanLegsRefusal } from './plan-legs'
import type { FloorRefusal } from './floor-discipline'
import { showSymbol } from './safe-copy'
import { mempoolExposureOf, type MempoolExposure } from './mempool-exposure'
import { isDevPreview } from './dev-preview'

// ─────────────────────────────────────────────────────────────────────────────
// DRAFT → CALLDATA ASSEMBLY (the wallet plumbing's pure half, 2026-08-04).
//
// The pipeline pieces existed and nothing threaded them: plan-legs budgets in
// CENTS (display + floor basis), the batcher signs RAW units, and the seam
// round proved the conversion cannot be a per-leg multiplication. This module
// is the ONE place a draft's chain slice becomes a composed batch:
//
//   targets ──planToLegs──▶ cent legs + refusals
//          ──scaleLegBudgetsToRaw──▶ raw budgets (conservation by construction)
//          ──composeBatchBuy──▶ the exact args a wallet will sign
//
// LAWS THIS MODULE OWNS:
//  · THE RAW MINT HAPPENS HERE. `asFundingRaw` is called at exactly one seam —
//    the funding total the wallet layer measured (native wei or settlement
//    raw). Leg raws are DISTRIBUTED from it, never re-derived from cents.
//  · CENT VIEW AND RAW VIEW MAY DIFFER BY THE FEE'S HALF-CENT (seam round):
//    cents are the floor/display basis, raw is what the contract sees, and
//    the fee floors differently in each domain. Floors derive from the cent
//    quotes; raw budgets conserve exactly. Any figure exchanged with the
//    chain compares RAW (readiness 1e).
//  · THE HUB FLOOR BOUNDS THE HUB SWAP, IN THE SWAP'S OWN OUT-ASSET — the
//    semantic MEASURED off the deployed batcher (fork rehearsal 2026-08-04 +
//    SpectrumBatcher.sol L351-380; the first cut guessed an identity basis
//    and the rehearsal's hubOut=19,081,541 for a 0.01-native pull proved the
//    out-asset is SETTLEMENT raw — the guessed floor was ~1e12× too high and
//    would have reverted HubFloorNotMet on every native+basket batch):
//      · NATIVE funding: the hub converts ONLY the basket-leg budget into
//        settlement (venue legs spend native directly), so the floor is the
//        basket cents' settlement value × (1 − slippage), in settlement raw.
//        With NO basket legs the contract never runs the hub and never reads
//        the floor — an inert 1 is passed, source-cited.
//      · SETTLEMENT funding: the hub converts venue budgets + THE FEE into
//        native (basket legs spend settlement directly), so the floor is
//        that sum's native value at the hub spot × (1 − slippage), in native
//        raw — which needs `hubUsd`; without it the assembly REFUSES (a zero
//        hub floor protects nothing where the swap runs).
//    The settlement leg of either conversion assumes the settlement asset at
//    $1 (it is the chain's dollar stable); the floor is a slippage bound on
//    the swap, not an oracle claim.
//  · REFUSALS TRAVEL, NEVER VANISH. planToLegs' per-leg refusals ride the
//    result so the review can show which assets fell out and why, even when
//    the rest of the batch composes.
//  · VENUE FLOORS ARE PER-LEG, DERIVED, AND REFUSED OVER CLAMPED (the floor
//    discipline, wired 2026-08-06 — BACKEND-FLOOR-DISCIPLINE.md is binding):
//    each venue leg's minOut is venue fee + own-size impact vs its measured
//    pool depth + the batch's own accumulated hop impact + known transfer
//    tax, capped by REFUSAL at 300 bps. The global `slippageBps` input now
//    governs ONLY the hub floor and the basket leg's legacy haircut — both
//    die with the hub-less AssetLeg refit.
// ─────────────────────────────────────────────────────────────────────────────

export interface AssembleBatchBuyInput {
  chainId: number
  /** The chain's slice of the draft — market reads + routes, flow-normalized. */
  targets: PlanLegInput[]
  /** The GROSS pull for this chain in integer cents (buys + fee — the funding
   *  plan's ChainNeed view). The legs spend what the fee leaves. */
  grossCents: number
  /** The GROSS pull in the funding asset's raw units, measured by the wallet
   *  layer (native wei, or settlement raw). The one real conversion — minted
   *  here. */
  fundingTotalRaw: bigint
  /** zeroAddress = native; else the chain's settlement asset. */
  fundingAsset: Address
  /** The signer — recipient by product law (composeBatchBuy enforces). */
  account: Address
  /** From the CHAIN's clock (chainNowSec + the policy window) — the factory
   *  re-verifies against the chain at simulate time. */
  deadlineSec: number
  /** Governs the HUB swap floor and the basket leg's legacy haircut ONLY —
   *  venue legs derive per-leg floors via the floor discipline. */
  slippageBps: number
  /** The shared funding hop's funding-side reserve, USD — MEASURED per chain
   *  by the caller (canonical USDC/WETH pool on Base+Ethereum, the USDG side
   *  on 4663), per BACKEND-FLOOR-DISCIPLINE rule 3. Null = unreadable, and
   *  every venue leg REFUSES: an unmeasured hop is not a deep hop (4663
   *  measured 700–3,000 bps of batch self-impact on plausible depths). */
  hopReserveUsd: number | null
  /** USD per whole NATIVE token (the hub's out-asset under settlement
   *  funding). Null + a settlement-funded plan with a hub swap = refuse. */
  hubUsd: number | null
  /** The settlement asset's decimals (the hub's out-asset under native
   *  funding — USDG/USDC are 6 on every batcher chain, but it is READ, never
   *  assumed: a wrong exponent here mis-scales a floor by 10^n). */
  settlementDecimals: number
  /** Explicit, never defaulted (composer law). */
  integrator: Address
}

export interface AssembledBatchBuy {
  composed: ComposedBatchBuy
  /** The legs as composed, cent view + the floor audit trail — the review's
   *  data. `minOutRaw` is null only on a basket leg (legacy haircut, applied
   *  at composition). */
  legs: (FlooredPlanLeg & { budgetRaw: bigint })[]
  /** Per-leg refusals from planning AND the floor plan — shown, not
   *  swallowed. */
  refusals: PlanLegsRefusal[]
  /** The floor layer's structured refusals (reason codes, needed bps) — the
   *  same events as their sentences in `refusals`, kept for the audit trail. */
  floorRefusals: FloorRefusal[]
  /** The cent-domain fee stated on the review (raw-domain truth may differ by
   *  the seam's half-cent; RAW is what the chain settles). */
  feeCents: number
  /** WHAT SIGNING THIS REVEALS (rule 6 — detect and disclose; desk 250). A dapp
   *  cannot force a private mempool for an EOA, so this is a FACT to show, never
   *  a protection we claim.
   *
   *  ⚠ DEFAULTED FAIL-CLOSED TO THE PUBLIC POOL. Composition does not know the
   *  wallet's 5792 capability — that is the ladder's answer, resolved later — and
   *  the two errors are not symmetric: telling someone their plan is less
   *  visible than it is under-discloses, while assuming the public pool merely
   *  over-warns a bundler user. The runner re-derives with the real capability
   *  once it knows it (`mempoolExposureOf`); until then this is the honest worst
   *  case rather than an optimistic guess. */
  mempoolExposure: MempoolExposure
  /** The consent divergence (M2's detection half) — carried FROM the fixpoint,
   *  never recomputed here. The pipeline property harness caught this struct
   *  DROPPING the field on its very first run (2026-08-07): detection wired
   *  into the fixpoint but not through this composer is detection the surface
   *  never sees. */
  concentration: PlanConcentration
}

/** 18 decimals — the hub is the chain's native asset on every batcher chain. */
const HUB_DECIMALS = 18n

/**
 * Assemble one chain's batch buy. Throws `BatchComposeRefusal` with a
 * review-grade sentence when the batch cannot be composed AT ALL; per-leg
 * planning refusals return alongside a composed batch of the legs that
 * survived.
 */
export function assembleBatchBuy(input: AssembleBatchBuyInput): AssembledBatchBuy {
  // ⚠ THE DEMO IDENTITY NEVER COMPOSES (the owner's 1330 ruling, 2026-08-06: the
  // demo stays a simulation — nothing on it may execute; forward guard filed
  // by UIGuy, desk 204, to land BEFORE the live executor rather than with it).
  // Today the demo is double-gated in dev and the executor is SIMULATED, so
  // this refusal is a backstop — but it is the backstop that holds if either
  // gate slips at go-live. The other half (a draft SEEDED from demo holdings,
  // signed by a real wallet) needs provenance recorded at the seeding seam and
  // lands with the executor wiring; tracked in the open-findings registry.
  if (isDevPreview(input.account))
    throw new BatchComposeRefusal('this is the demo book — a simulation. Nothing here can be bought for real; connect your own wallet to build a portfolio.')
  if (!Number.isFinite(input.grossCents) || input.grossCents <= 0)
    throw new BatchComposeRefusal('this network has no funded amount to spend — nothing to compose')
  const gross = Math.floor(input.grossCents)
  const feeCents = feeCentsOfTotal(gross)
  const legCents = gross - feeCents
  if (legCents <= 0) throw new BatchComposeRefusal('the amount is too small to spend after the fee — nothing to compose')

  // ⚠ THE CENTS/RAW CONSISTENCY BAND (reviewer M7, 2026-08-07): `grossCents`
  // and `fundingTotalRaw` describe the SAME money in two denominations, and
  // nothing cross-checked them — a 1000x mismatch (a decimals slip, a wei
  // amount in a dollar field) composed silently, with every floor derived from
  // the raw side while the review showed the cents side. The band is WIDE
  // (100x) on purpose: it exists to catch unit confusion, not to re-validate
  // prices — hub volatility and rounding sit far inside it. Where the input
  // needed to state the expectation is itself unreadable, the band stands
  // aside: those inputs' own guards refuse later, in their own words.
  //
  // ⚠⚠ THAT LAST SENTENCE WAS FALSE, AND IT COST THE WHOLE CHECK (independent
  // review, 2026-08-07 — two HIGHs). There IS no later guard on either side:
  //  · NATIVE funding with `hubUsd` unreadable — hubUsd is read in exactly two
  //    places, this band and the settlement-funding hub branch, and with no
  //    basket legs that branch takes `basketCents === 0 ⇒ hubMinOutRaw = 1n`
  //    and never reads it again. MEASURED, one field apart: hubUsd=null
  //    COMPOSES a "$1,000" batch carrying 1e24 wei — leg AAA gets ~597,600 ETH
  //    (~$1.79 BILLION at $3,000) against a floor of ~$594, so the on-chain
  //    protection covers 0.00003% of the spend. hubUsd=3000 refuses the same
  //    input.
  //  · SETTLEMENT funding with `settlementDecimals` unreadable — the band is
  //    its SOLE consumer there, so an unreadable value removes the only
  //    cross-check ON ITSELF. Measured: decimals=NaN with a 1e12x mismatch
  //    composes; decimals=6 refuses.
  //
  // "Stand aside when the input is unreadable" is the read-failed law inverted:
  // it turned a missing input into permission. The band now FAILS CLOSED —
  // unreadable means unchecked means refuse — with ONE exception that keeps the
  // documented `hubUsd: null` case alive: a plan that spends NOTHING through
  // the hub has nothing for this band to check.
  //
  // ⚠ AND THE BOUND IS `>=` NOT `>` (F3): at `>` exactly 100x passed, which
  // misses EVERY plus-or-minus-two-decimal slip — 6↔8 (USDC against any
  // 8-decimal asset) is the most plausible pair left and it was measured as a
  // clean miss in both directions.
  if (input.fundingTotalRaw > 0n) {
    let expectedRaw: bigint | null = null
    let unreadable: string | null = null
    if (input.fundingAsset === zeroAddress) {
      if (input.hubUsd != null && Number.isFinite(input.hubUsd) && input.hubUsd > 0) {
        const nano = Math.floor((gross / 100 / input.hubUsd) * 1e9)
        if (Number.isFinite(nano) && nano > 0 && nano <= Number.MAX_SAFE_INTEGER) expectedRaw = BigInt(nano) * 10n ** (HUB_DECIMALS - 9n)
        else unreadable = 'the network asset’s price does not convert this amount into a checkable figure'
      } else {
        unreadable = 'we could not price the network’s own asset, so we cannot tell whether the amount being pulled matches the amount shown'
      }
    } else if (!(Number.isInteger(input.settlementDecimals) && input.settlementDecimals >= 0 && input.settlementDecimals <= 36)) {
      unreadable = 'the funding asset’s decimals are unreadable, so we cannot tell whether the amount being pulled matches the amount shown'
    }
    // the ONLY honest stand-aside: nothing is being spent through the hub, so
    // there is no raw/cents pair for this band to relate (the documented
    // basket-only `hubUsd: null` plan)
    const venueSpend = input.targets.some((t) => t.route !== 'basket')
    if (unreadable != null && (venueSpend || input.fundingAsset !== zeroAddress))
      throw new BatchComposeRefusal(`${unreadable} — refusing rather than composing a batch whose two halves cannot be compared`)
    if (input.fundingAsset !== zeroAddress && Number.isInteger(input.settlementDecimals) && input.settlementDecimals >= 0 && input.settlementDecimals <= 36) {
      expectedRaw = (BigInt(gross) * 10n ** BigInt(input.settlementDecimals)) / 100n
    }
    if (expectedRaw != null && expectedRaw > 0n) {
      const BAND = 100n
      if (input.fundingTotalRaw >= expectedRaw * BAND || expectedRaw >= input.fundingTotalRaw * BAND)
        throw new BatchComposeRefusal(
          'this batch’s dollar total and its funded amount disagree by more than 100x — the same money stated in two units that cannot both be right; nothing was composed',
        )
    }
  }

  const planned = planToFlooredLegs(input.targets, legCents, { hopReserveUsd: input.hopReserveUsd })
  if (planned.legs.length === 0) {
    const why = planned.refusals[0]?.reason
    throw new BatchComposeRefusal(
      why ? `no leg of this network's plan can compose — the first reason: ${why}` : 'this network has no composable legs',
    )
  }

  // THE RAW MINT — the wallet layer measured this total; leg raws are
  // distributed from it (one scaling, one derivation — never per-leg math).
  const totalRaw = asFundingRaw(input.fundingTotalRaw)
  const raws = scaleLegBudgetsToRaw(
    planned.legs.map((l) => l.budgetUsdCents),
    totalRaw,
  )

  // THE INTERIM CONCENTRATION GUARD RETIRED HERE (2026-08-13). Its own scoping
  // note said the small-plan case was "a product decision nobody has made" —
  // the owner made it: the RULED 75% cap (CONCENTRATION_POLICY, plan-legs.ts,
  // decisions/LOG.md) binds every plan size at planToFlooredLegs' own exit,
  // upstream of this function, one shared verdict with the 0x path. The
  // survivor-halving and 90%-of-batch checks that lived here were both weaker
  // than and redundant with the ruling — an over-concentrated plan now arrives
  // as ZERO legs with the cap sentence leading its refusals, and the
  // no-composable-legs throw below surfaces it as the first reason.

  const legs: BatcherLegInput[] = planned.legs.map((l, i) => {
    // Venue legs carry the floor plan's derived minOut; basket legs take the
    // legacy global haircut (the basket's inner acquisition — a path that
    // dies with the hub-less refit, stated in the header law).
    const minOutRaw = l.route === 'basket' ? haircut(l.quotedOutRaw, input.slippageBps) : l.minOutRaw
    if (minOutRaw == null)
      throw new BatchComposeRefusal(
        `$${showSymbol(l.symbol)}: this leg reached assembly without a floor — refusing to compose an unprotected leg`,
      )
    return {
      symbol: l.symbol,
      asset: l.asset,
      route: l.route,
      budgetRaw: raws[i],
      quotedOutRaw: l.quotedOutRaw,
      minOutRaw,
      optional: l.optional,
    }
  })

  // THE HUB FLOOR — in the hub swap's own out-asset (the MEASURED semantic;
  // see the header law and the rehearsal record).
  const basketCents = planned.legs.filter((l) => l.route === 'basket').reduce((s, l) => s + l.budgetUsdCents, 0)
  const venueCents = planned.legs.filter((l) => l.route !== 'basket').reduce((s, l) => s + l.budgetUsdCents, 0)
  let hubMinOutRaw: bigint
  if (input.fundingAsset === zeroAddress) {
    // native funding: the hub converts basket budgets → settlement. No basket
    // legs ⇒ the contract never runs the hub nor reads this floor (L355-361);
    // 1 is inert by measured semantics, never a weakened protection.
    if (basketCents === 0) {
      hubMinOutRaw = 1n
    } else {
      const dec = Number.isInteger(input.settlementDecimals) && input.settlementDecimals >= 0 && input.settlementDecimals <= 36 ? input.settlementDecimals : null
      if (dec == null)
        throw new BatchComposeRefusal('the settlement asset’s decimals are unreadable — a floor scaled by a guessed exponent protects nothing')
      // cents → settlement raw at $1 (the chain's dollar stable), then the haircut
      const settlementRaw = (BigInt(basketCents) * 10n ** BigInt(dec)) / 100n
      hubMinOutRaw = haircut(settlementRaw, input.slippageBps)
    }
  } else {
    // settlement funding: the hub converts venue budgets + THE FEE → native.
    const hubInCents = venueCents + feeCents
    if (hubInCents === 0) {
      hubMinOutRaw = 1n // basket-only, fee floored to zero: no hub swap runs
    } else {
      if (input.hubUsd == null || !Number.isFinite(input.hubUsd) || input.hubUsd <= 0)
        throw new BatchComposeRefusal(
          'we could not price the network’s own asset just now, so we cannot set the protection floor for this batch — try again in a moment',
        )
      // cents → native raw at the hub spot, then the same haircut law as legs.
      // The float product is range-guarded before it becomes a BigInt: a hostile
      // spot price must refuse in a sentence, never crash on BigInt(Infinity).
      const hubNano = Math.floor((hubInCents / 100 / input.hubUsd) * 1e9)
      if (!Number.isFinite(hubNano) || hubNano <= 0 || hubNano > Number.MAX_SAFE_INTEGER)
        throw new BatchComposeRefusal(
          'the network’s own asset priced at a value we cannot state a floor against — refusing rather than composing an unprotected batch',
        )
      const hubRaw = BigInt(hubNano) * 10n ** (HUB_DECIMALS - 9n)
      hubMinOutRaw = haircut(hubRaw, input.slippageBps)
    }
  }
  if (hubMinOutRaw <= 0n)
    throw new BatchComposeRefusal('the amount is too small to state a protection floor — a zero floor protects nothing')

  const composed = composeBatchBuy({
    chainId: input.chainId,
    legs,
    fundingAsset: input.fundingAsset,
    fundingTotalRaw: totalRaw,
    recipient: input.account,
    owner: input.account,
    deadlineSec: input.deadlineSec,
    hubMinOutRaw,
    integrator: input.integrator,
  })

  return {
    composed,
    legs: planned.legs.map((l, i) => ({ ...l, budgetRaw: raws[i] as bigint })),
    refusals: planned.refusals,
    floorRefusals: planned.floorRefusals,
    feeCents,
    concentration: planned.concentration,
    mempoolExposure: mempoolExposureOf({
      symbols: planned.legs.map((l) => l.symbol),
      // see the field's note: the capability is unknown here, and the
      // fail-closed direction is to disclose the MORE exposing truth
      atomicBundle: false,
    }),
  }
}

function haircut(raw: bigint, slippageBps: number): bigint {
  // ⚠ AN UNREADABLE TOLERANCE REFUSES — the old `: 0` fallback (reviewer M4,
  // 2026-08-07) composed the floor at 100% of the frictionless quote: a leg
  // that CANNOT fill, shipped as a safe-looking number, surfacing later as an
  // on-chain revert blamed on the route. A conservative-sounding default was
  // the dangerous one. Only a constant feeds this today; the throw is for the
  // refactor that changes that.
  if (!Number.isFinite(slippageBps))
    throw new BatchComposeRefusal('this batch’s slippage setting is unreadable — refusing to derive any floor from it')
  const bps = Math.min(Math.max(Math.round(slippageBps), 0), 10_000)
  return (raw * BigInt(10_000 - bps)) / 10_000n
}
