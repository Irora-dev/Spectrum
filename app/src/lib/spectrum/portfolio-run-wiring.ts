import { zeroAddress, type Address } from 'viem'
import { feeGenerationFor, settlementDecimalsFor } from '../chain/deployments'
import { batchFeeBpsFor, type NormalizedTarget } from './allocation'
import { asFundingRaw, BatchComposeRefusal, scaleLegBudgetsToRaw } from './batcher'
import { buildFundingPlan, type ChainInventory, type ChainNeed, type FundingPlan, type FundingStep, type SellIntent } from './funding-plan'
import { DEFAULT_SLIPPAGE_BPS } from './hook-data'
import { lifiSupportsChain } from './lifi'
import { COW_NATIVE_BUY } from './cow'
import { centBudgets, planToLegs, type PlanLegInput } from './plan-legs'
import {
  assembleZeroExBatchBuyLive,
  isThinMarketLeg,
  legToleranceCeilingBps,
  maxCommittedFor,
  type ComposedPortfolioBatchBuy,
} from './portfolio-batcher'
import { singleSwapImpactBps } from './floor-discipline'
import { shownAtReviewSurface, type ShownStepReview } from './displayed-vs-signed'
import type { PerChainFunds } from './plan-shared-types'
import type { ZeroExFetcher } from './zeroex-quote'

// ─────────────────────────────────────────────────────────────────────────────
// THE PORTFOLIO RUN WIRING — the closures PortfolioFlow hands the execution
// runner (the owner, 2026-08-14: "do all the wiring now"). Everything lawful
// already lives in the modules this file composes; nothing here re-states a
// law. What this file owns is the SEAM: the same pure derivation feeding the
// review's rendered rows and the composer's inputs, so the two sides of the
// displayed-vs-signed gate meet over genuinely shared inputs — never over a
// review derived FROM the composition (the brand's f(x)===f(x) trap).
//
// V1 DECISIONS, stated rather than implied:
// · FLOORS ARE NOT SHOWN (ShownLeg.minOutRaw = null). Per-leg floors derive
//   from 0x quotes fetched at compose time, after the review has rendered —
//   the exact case the ShownLeg nullability exists for. A null-shown leg is
//   still fully covered: the composed floor must be > 0, the catch-all pins
//   the bytes, and the P6' conservation/fee/recipient laws bind regardless.
// · BUDGETS ARE SHOWN EXACTLY. The review recomputes the composer's own
//   derivation (maxCommittedFor → planToLegs → scaleLegBudgetsToRaw, all
//   exported pure functions) over the same inputs, so shown budgetRaw equals
//   composed sellAmount by construction — and any quote-time leg exclusion
//   changes legs.length and REFUSES at the gate (the safe direction; the user
//   re-reviews).
// · MARKET ROWS ARE FROZEN AT REVIEW BUILD. Compose reuses the review's own
//   PlanLegInput rows verbatim (seconds old on the intended path). The spot
//   only feeds drift-band width and optionality — execution floors derive
//   from the compose-time 0x quote basis — so a frozen row cannot loosen a
//   floor's anchor, only its width. priceAgeMs is stamped at the read.
// · BRIDGE-NEEDING PLANS REFUSE WHOLE, by the runner's own planExecutable law
//   ("this build cannot send those transfers yet"). The wiring builds the
//   honest plan; the refusal arrives in the runner's words, before any step.
// ─────────────────────────────────────────────────────────────────────────────

/** Cents → the chain's OWN settlement raw units, from the deployment book
 *  (cold-review INFO-1: a hardcoded 6dp here silently mis-sizes the batch
 *  pull for any non-6dp settlement token). The runner verifies the config
 *  against the chain's decimals() before the pull signs. */
const centRawFor = (chainId: number): bigint => 10n ** BigInt(settlementDecimalsFor(chainId) - 2)

/** Money time is chain time: each batch signs with chainNow + this window.
 *  15 minutes — comfortably past wallet-prompt dithering, well under the
 *  contract's 24h ceiling, and inside the review's own staleness tolerances. */
export const RUN_DEADLINE_WINDOW_SEC = 15 * 60

const key = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

// ── the market reader: one PlanLegInput per target, or a named refusal ───────

export type MarketRow = { ok: true; leg: PlanLegInput } | { ok: false; symbol: string; reason: string }

/** Reads everything PlanLegInput needs for each target. Injected so the whole
 *  wiring is testable without a network; the production reader lives in
 *  portfolio-run-market.ts (findBestPool + spotReadsFor + the curated tax set). */
export type MarketReader = (
  targets: { chainId: number; address: Address; symbol: string; weightPct: number }[],
) => Promise<Map<string, MarketRow>>

// ── the review model: what the station renders, and what the closures read ──

export interface PortfolioReviewLeg {
  symbol: string
  asset: Address
  budgetUsdCents: number
  /** EXACTLY the sellAmount the composer will commit for this leg. */
  budgetRaw: bigint
  optional: boolean
  /** THE PRICE TOLERANCE THIS LEG WILL RIDE, bps — the surfacing half of
   *  the owner's thin-market ruling (2026-08-15: "allow open slippage but just
   *  surface it for people to be aware").
   *
   *  Derived HERE, at review time, from the same frozen market row the composer
   *  will reuse verbatim — so what the card states and what the batch enforces
   *  are the same number, not two estimates that happen to agree. Null when
   *  depth was unreadable: that leg refuses at compose time anyway, and a
   *  tolerance shown for a leg that cannot compose would be a promise about a
   *  trade that will not happen. */
  toleranceBps: number | null
  /** THIS SIZE'S OWN PRICE IMPACT in this pool, bps — the OTHER cost, and the
   *  one that made my first version of the surfaced sentence dishonest.
   *
   *  ⚠ The tolerance is measured against the QUOTE, and the quote ALREADY has
   *  impact inside it. So "you get at least budget × (1 − tolerance) worth" is
   *  only true if you read "worth" as post-impact — and a person reading a
   *  dollar figure next to the dollars they are spending does not read it that
   *  way. Measured on the owner's own leg: $3,154 into a $30k pool pays ~1,724 bps
   *  of impact, so the honest worst case at the price he sees is ~$2,300, not
   *  the ~$2,776 the tolerance alone implies. Overstating what a person
   *  receives is the one direction a money surface must never round, which is
   *  the same law I pinned for the tolerance itself and then broke one line
   *  later in the copy. Both terms now compose into the stated figure. */
  impactBps: number | null
  /** Is this leg riding the WIDER thin-market ceiling rather than the deep
   *  default? The card says so in words when it is — a widened tolerance the
   *  user is not told about is the exact thing the ruling forbids. */
  thinMarket: boolean
}

export interface PortfolioChainReview {
  chainId: number
  /** The chain's whole pull, integer cents (buys + fee — the funding view). */
  grossCents: number
  fundingAsset: Address
  /** The pull in settlement raw units — the approval amount, exactly. */
  fundingTotalRaw: bigint
  legs: PortfolioReviewLeg[]
  /** The market rows the composer will reuse VERBATIM (the frozen-read law). */
  targets: PlanLegInput[]
  /** Per-leg refusals, review-grade sentences — rendered, never swallowed. */
  refusals: { symbol: string; reason: string }[]
  /** The one exact-amount approval this chain's batch needs. */
  approval: { token: Address; amountRaw: bigint }
}

/** One RENDERED sale row — what the station shows and the plan carries. */
export interface PortfolioSellReview {
  chainId: number
  symbol: string
  asset: string
  sellRaw: string
  decimals: number
  /** Review-time estimate of the proceeds, integer cents (display). */
  estCents: number
  /** The FLOOR the plan draws on — estimate less slippage and drift. */
  floorCents: number
}

export interface PortfolioRunReview {
  plan: FundingPlan
  chains: PortfolioChainReview[]
  /** Chain-level refusals (no settlement configured, no market rows at all). */
  refusals: string[]
  /** The sales this plan executes first (the sell wiring pass, 2026-08-14).
   *  Empty on buy-only plans — every legacy caller. */
  sells: PortfolioSellReview[]
}

/** Group the normalized draft by chain, first-appearance order — the same
 *  grouping compilePlan renders, so the run's chains match the walkthrough's. */
export function chainSlicesOf(norm: NormalizedTarget[], amountCents: number): { chainId: number; members: NormalizedTarget[]; grossCents: number }[] {
  const chains: number[] = []
  for (const t of norm) if (!chains.includes(t.asset.chainId)) chains.push(t.asset.chainId)
  const groups = chains.map((chainId) => norm.filter((t) => t.asset.chainId === chainId))
  const slices = centBudgets(
    groups.map((g) => g.reduce((s, t) => s + (Number.isFinite(t.weight) && t.weight > 0 ? t.weight : 0), 0)),
    amountCents,
  )
  return chains.map((chainId, i) => ({ chainId, members: groups[i], grossCents: slices[i] }))
}

/** ChainNeed per funded chain: the pull is the user's dollars in; buys are the
 *  exclusive net the contract's own equation leaves (maxCommittedFor — the
 *  composer's identical derivation, in the cent domain). */
export function chainNeedsOf(slices: { chainId: number; grossCents: number }[], feeBps?: number): ChainNeed[] {
  return slices
    .filter((s) => s.grossCents > 0)
    .map((s) => {
      // per-CHAIN: each slice charges its own deployed generation's rate
      const bps = feeBps ?? batchFeeBpsFor(s.chainId)
      const buysCents = Number(maxCommittedFor(BigInt(s.grossCents), bps))
      return { chainId: s.chainId, buysCents, feeCents: s.grossCents - buysCents }
    })
}

/** Map the wallet's measured funds into the funding plan's inventory shape.
 *  ONE HOME PER DOLLAR: the whole settlement pool of the deepest chain is the
 *  plan's `newMoney` (bridgeable); every other chain's settlement is local
 *  cash. Chains in the plan with no funds row report empty-and-unreadable-gas
 *  honestly (law 5 refuses them rather than assuming fine). */
export function inventoriesOf(
  funds: PerChainFunds[],
  needChainIds: number[],
  /** FLOOR proceeds per selling chain (the sell wiring pass, 2026-08-14) —
   *  becomes the inventory's sellProceedsCents, which pass 0 requires to
   *  agree exactly with the sales the plan carries. */
  sellFloorCentsByChain?: Map<number, number>,
  /** LOCAL-ONLY (the owner live 2026-08-15: "was never asked to bridge") — every
   *  chain keeps its OWN settlement as local cash, no newMoney pool, so the
   *  plan can never compose a transfer; a chain short of its own funds
   *  refuses with the plan's own per-chain sentence instead. */
  localOnly?: boolean,
): { chains: ChainInventory[]; newMoney: { chainId: number; availableCents: number } | null } {
  const byChain = new Map(funds.map((f) => [f.chainId, f]))
  const richest = localOnly ? null : funds.reduce<PerChainFunds | null>((best, f) => (f.usdcCents > (best?.usdcCents ?? 0) ? f : best), null)
  const chainIds = [
    ...new Set([...needChainIds, ...funds.map((f) => f.chainId), ...(sellFloorCentsByChain ? [...sellFloorCentsByChain.keys()] : [])]),
  ]
  const chains: ChainInventory[] = chainIds.map((chainId) => {
    const f = byChain.get(chainId)
    return {
      chainId,
      nativeRaw: f?.nativeRaw ?? 0n,
      gasNeedRaw: f?.gasNeedRaw ?? null,
      localFundingCents: f && (localOnly || f.chainId !== richest?.chainId) ? f.usdcCents : 0,
      sellProceedsCents: sellFloorCentsByChain?.get(chainId) ?? 0,
      // the refuel lane (gas-deposit, 2026-08-14): a chain can receive
      // bridged gas exactly when a pinned LI.FI lane exists INTO it — the
      // bridge executor sizes fromAmountForGas per refuel.ts and refuses
      // honestly when the price cannot be read. Unpinned chains stay false
      // (absence-by-default, law 4).
      inboundRefuel: lifiSupportsChain(chainId),
    }
  })
  return { chains, newMoney: richest ? { chainId: richest.chainId, availableCents: richest.usdcCents } : null }
}

/** Build the whole review: the funding plan + per-chain rendered legs, from
 *  the SAME pure derivations the composer runs. Every excluded leg's reason
 *  lands in a refusal list the station renders — nothing vanishes silently. */
export function buildRunReview(args: {
  norm: NormalizedTarget[]
  amountCents: number
  funds: PerChainFunds[]
  market: Map<string, MarketRow>
  settlementFor: (chainId: number) => Address | null
  feeBps?: number
  /** The sales this plan executes (the sell wiring pass, 2026-08-14): each is
   *  priced through the SAME market read the buys use, floored, and handed to
   *  the funding plan as a real order-1 step. Undefined = the legacy buy-only
   *  shape, byte-identical. */
  sells?: { chainId: number; address: string; symbol: string; sellRaw: string; decimals: number; liveMinCents?: number }[]
  /** the owner's bridge-consent ruling (2026-08-15): true = compose with each
   *  chain's own funds only — nothing travels, shortfalls refuse by chain. */
  localOnly?: boolean
}): PortfolioRunReview {
  // per-CHAIN fee: each slice charges its own deployed generation's rate
  // (args.feeBps stays as the test seam's global override)
  const feeBpsFor = (chainId: number) => args.feeBps ?? batchFeeBpsFor(chainId)
  const slices = chainSlicesOf(args.norm, args.amountCents)
  const refusals: string[] = []
  const chains: PortfolioChainReview[] = []

  // ── THE SALES: floor each sold leg from the live market read; the floor —
  // never the estimate — is the only number the plan may spend. A sale that
  // cannot be priced or sized is refused BY NAME and never planned; its
  // dependent buys then refuse through the funding plan's own affordability
  // sentences (an honest cascade, never a silent shrink). ──────────────────
  const sellRows: PortfolioSellReview[] = []
  const sellIntents: SellIntent[] = []
  const sellFloorByChain = new Map<number, number>()
  for (const s of args.sells ?? []) {
    const settlement = args.settlementFor(s.chainId)
    if (!settlement || settlement === zeroAddress) {
      refusals.push(`network ${s.chainId} has no settlement token configured here, so the sale of $${s.symbol} has nowhere to land — it is not planned`)
      continue
    }
    const row = args.market.get(key(s.chainId, s.address))
    if (!row) {
      refusals.push(`$${s.symbol}: no market read arrived for this sale — it cannot be floored, so it is not planned`)
      continue
    }
    if (!row.ok) {
      // the reader's reason already names the asset ("$ETH: no contract…") —
      // prefixing again printed "$ETH: $ETH:" on the owner's live screen
      refusals.push(`${row.reason} — its sale is not planned`)
      continue
    }
    if (row.leg.priceUsd == null || !(row.leg.priceUsd > 0)) {
      refusals.push(`$${s.symbol}: this sale has no readable price, so it cannot be floored — it is not planned`)
      continue
    }
    let raw = 0n
    try {
      raw = BigInt(s.sellRaw)
    } catch {
      raw = 0n
    }
    if (raw <= 0n || !Number.isInteger(s.decimals) || s.decimals < 0 || s.decimals > 36) {
      refusals.push(`$${s.symbol}: this sale carries no readable exact amount, so it is not planned`)
      continue
    }
    const estCents = Math.floor((Number(raw) / 10 ** s.decimals) * row.leg.priceUsd * 100)
    if (!Number.isFinite(estCents) || estCents <= 0) {
      refusals.push(`$${s.symbol}: this sale prices at nothing readable, so it is not planned`)
      continue
    }
    // THE FLOOR'S BASIS IS A NUMBER SOMEONE GUARANTEES (the owner live
    // 2026-08-18: a CASHCAT sale refused "market has moved" on every
    // re-check — the indexer's spot price lags a dumping market by minutes,
    // so an est-only floor was born unclearable and every rebuilt review
    // inherited the same stale-high basis). When the caller fetched the live
    // lane's own enforced minimum at build time, the floor is the LOWER of
    // the two bases, each with the drift allowance — the /swap page's own
    // floor→floor law, applied here. No live read → the est basis alone,
    // exactly as before.
    const estFloor = Math.floor((estCents * (10_000 - DEFAULT_SLIPPAGE_BPS - SELL_FLOOR_DRIFT_BPS)) / 10_000)
    const liveFloor =
      typeof s.liveMinCents === 'number' && Number.isFinite(s.liveMinCents) && s.liveMinCents > 0
        ? Math.floor((s.liveMinCents * (10_000 - SELL_FLOOR_DRIFT_BPS)) / 10_000)
        : null
    const floorCents = liveFloor != null && liveFloor < estFloor ? liveFloor : estFloor
    if (floorCents <= 0) {
      refusals.push(`$${s.symbol}: this sale is too small to clear its own slippage floor, so it is not planned`)
      continue
    }
    sellIntents.push({ chainId: s.chainId, asset: s.address, symbol: s.symbol, sellRaw: raw.toString(), decimals: s.decimals, floorProceedsCents: floorCents })
    sellFloorByChain.set(s.chainId, (sellFloorByChain.get(s.chainId) ?? 0) + floorCents)
    sellRows.push({ chainId: s.chainId, symbol: s.symbol, asset: s.address, sellRaw: raw.toString(), decimals: s.decimals, estCents, floorCents })
  }

  for (const slice of slices) {
    if (slice.grossCents <= 0) continue
    const settlement = args.settlementFor(slice.chainId)
    if (!settlement || settlement === zeroAddress) {
      refusals.push(`network ${slice.chainId} has no settlement token configured here, so its buys cannot be funded`)
      continue
    }
    const legRefusals: { symbol: string; reason: string }[] = []
    const targets: PlanLegInput[] = []
    for (const m of slice.members) {
      const row = args.market.get(key(m.asset.chainId, m.asset.address))
      if (!row) {
        legRefusals.push({ symbol: m.asset.symbol, reason: `$${m.asset.symbol}: no market read arrived for this asset — it cannot be budgeted` })
        continue
      }
      if (!row.ok) {
        legRefusals.push({ symbol: row.symbol, reason: row.reason })
        continue
      }
      targets.push(row.leg)
    }

    const fundingTotalRaw = BigInt(slice.grossCents) * centRawFor(slice.chainId)
    const feeBps = feeBpsFor(slice.chainId)
    const spendableCents = Number(maxCommittedFor(BigInt(slice.grossCents), feeBps))
    const spendableRaw = maxCommittedFor(fundingTotalRaw, feeBps)
    if (targets.length === 0 || spendableCents <= 0) {
      chains.push({
        chainId: slice.chainId,
        grossCents: slice.grossCents,
        fundingAsset: settlement,
        fundingTotalRaw,
        legs: [],
        targets,
        refusals: legRefusals.length
          ? legRefusals
          : [{ symbol: '', reason: 'the amount is too small to spend once the fee is provided for' }],
        approval: { token: settlement, amountRaw: fundingTotalRaw },
      })
      continue
    }

    // The composer's own derivation, verbatim (its round-0 view): cent budgets
    // over the survivors, then the one raw scaling. Quote-time exclusions can
    // still shrink the composed set later — legs.length then diverges and the
    // gate refuses, which is the safe direction.
    const planned = planToLegs(targets, spendableCents)
    for (const r of planned.refusals) legRefusals.push(r)
    const raws = scaleLegBudgetsToRaw(
      planned.legs.map((l) => l.budgetUsdCents),
      asFundingRaw(spendableRaw),
      0, // the fee is EXCLUSIVE here — maxCommittedFor already solved the pull down
    )
    chains.push({
      chainId: slice.chainId,
      grossCents: slice.grossCents,
      fundingAsset: settlement,
      fundingTotalRaw,
      legs: planned.legs.map((l, i) => {
        // the frozen row the composer will read for this same leg
        const liq = targets.find((t) => t.asset.toLowerCase() === l.asset.toLowerCase())?.liquidityUsd ?? null
        const notionalUsd = l.budgetUsdCents / 100
        return {
          symbol: l.symbol,
          asset: l.asset,
          budgetUsdCents: l.budgetUsdCents,
          budgetRaw: raws[i] as bigint,
          optional: l.optional,
          // THE CEILING, not the drift band — ONE number end to end. The band
          // is only part of `s`; self-impact is added to it at compose time and
          // is unknown here (it depends on execution order), so a band-based
          // sentence would promise MORE than the floor guarantees, which is the
          // one direction a money surface must never round. The ceiling bounds
          // the whole sum, is exactly what we ask 0x to embed, and is therefore
          // the honest worst case: the real floor may be tighter, never looser.
          toleranceBps: legToleranceCeilingBps(liq, notionalUsd),
          impactBps: singleSwapImpactBps(notionalUsd, liq),
          thinMarket: isThinMarketLeg(liq, notionalUsd),
        }
      }),
      targets,
      refusals: legRefusals,
      approval: { token: settlement, amountRaw: fundingTotalRaw },
    })
  }

  const funded = chains.filter((c) => c.legs.length > 0)
  const inv = inventoriesOf(args.funds, funded.map((c) => c.chainId), sellFloorByChain, args.localOnly)
  const plan = buildFundingPlan({
    chains: inv.chains,
    newMoney: inv.newMoney,
    needs: chainNeedsOf(
      funded.map((c) => ({ chainId: c.chainId, grossCents: c.grossCents })),
      args.feeBps,
    ),
    // sells travel ONLY when the caller entered the sells shape — the legacy
    // buy-only callers keep the plan's old model untouched (pass 0's rule).
    ...(args.sells !== undefined ? { sells: sellIntents } : {}),
  })
  // fold WHAT each batch buys into its step identity (the audit's key-collision
  // fix): same funding + different legs = different key = never a false
  // "already done". FNV over the sorted (asset,budget) rows — cheap, stable.
  for (const step of plan.steps) {
    if (step.action.kind !== 'batch') continue
    const chain = funded.find((c) => c.chainId === (step.action as { chainId: number }).chainId)
    if (!chain) continue
    const joined = chain.legs.map((l) => `${l.asset.toLowerCase()}:${l.budgetUsdCents}`).sort().join('|')
    let h = 0x811c9dc5
    for (let i = 0; i < joined.length; i++) {
      h ^= joined.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    ;(step.action as { intent?: string }).intent = (h >>> 0).toString(16).padStart(8, '0')
  }

  // A REVIEW THAT COMPOSED NOTHING MUST SAY WHY — this function's own header
  // promises nothing vanishes silently, and on 2026-08-14 something did: a
  // trim-only intent carries no new dollars, so amountCents is 0, every slice
  // is skipped before any refusal can be pushed, and the plan reached the
  // armed surface as {steps:[], notes:[], refusals:[]} — "Run refused" with
  // no stated reason. The reason lands here, in the list the station renders.
  if (plan.steps.length === 0 && refusals.length === 0 && plan.refusals.length === 0 && plan.notes.length === 0 && !chains.some((c) => c.refusals.length > 0)) {
    refusals.push(
      args.amountCents <= 0
        ? 'this change brings in no new money and sells nothing — there is nothing the engine can run. Change an amount, or trim something.'
        : args.norm.length === 0
          ? 'no asset in this plan has a positive target, so there is nothing to buy'
          : 'nothing in this plan survived to a runnable step',
    )
  }

  return { plan, chains, refusals, sells: sellRows }
}

/** The zero-step door. `planExecutable` asks every() over the steps, which
 *  passes VACUOUSLY on an empty plan — how a plan with nothing in it was
 *  offered a live "Run for real" button (the silent refusal, 2026-08-14).
 *  The hook asks this first, so the button never renders on nothing. */
export function emptyPlanGate(plan: FundingPlan): { ok: true } | { ok: false; reason: string } {
  if (plan.steps.length > 0) return { ok: true }
  return { ok: false, reason: 'This plan has nothing the engine can run — no buys were composed. Nothing would be sent.' }
}

// ── the rebalance run input: cash-funded buys run TODAY ─────────────────────
//
// the owner, live 2026-08-14 (~19:0x, on his refused buy): "i had usdc/cash in the
// book??" — and he was right. A rebalance whose trims fall on the SETTLEMENT
// asset is not waiting on the sell side at all: trimming a cash leg IS the
// funding (the engine's buys are settlement pulls — the USDC is already in
// the wallet; the book's cash row just shrinks when it is spent). The old
// wiring passed the rebalance's NET new money (0 on a cash-covered edit), so
// the one case the engine could run today was refused with the sell-side
// sentence.
//
// The changes rows are the composer's own EXACT ends (position-intents
// records them at compose time precisely so nothing re-derives different
// numbers from integer percentages). Reading them here graduates them from
// display-only to the run's input for the same reason they exist: the run
// must execute exactly the change that was shown.

export interface RebalanceChange {
  chainId: number
  address: string
  symbol: string
  fromUsd: number
  toUsd: number
  /** SELL legs only: the composer's exact raw amount (decimal string) and the
   *  token's decimals — absent on adds and on anything unpriced, in which
   *  case the trim cannot become a sale and blocks by name. */
  sellRaw?: string
  decimals?: number
}

const DUST_USD = 0.5

/** The floor's drift allowance beyond slippage: the plan spends
 *  estimate × (1 − slippage − drift), so a small market move between the
 *  review pricing and the executor's quote does not refuse a sale whose
 *  router minimum still comfortably covers the draws. One number, stated. */
export const SELL_FLOOR_DRIFT_BPS = 100

// ─────────────────────────────────────────────────────────────────────────────
// THE WALLET-COVER OFFER (owner 2026-08-15, live on the $PRISM refusal: "if im
// buying prism but dont have the cash/stables it needs to flag before you get
// to execute that you need to either deposit stables or trim another position
// like my eth in wallet"). When a chain's buys refuse for money, the wallet's
// own NATIVE ETH on that chain (above its gas reserve) can cover it — as a
// REAL sale the plan already knows how to run (native sales ride LIFI_NATIVE,
// proven live). This helper sizes that sale so the plan's FLOOR — the only
// number it may draw on — covers the shortfall. Construct-then-verify: the raw
// is derived, then pushed up in 1e-6-ETH steps until the same floor arithmetic
// buildRunReview applies actually clears the shortfall (the instrument proves
// it discriminates; no derivation is trusted bare).
// ─────────────────────────────────────────────────────────────────────────────

const MICRO_ETH = 10n ** 12n // 1e-6 ETH in wei — the offer's sizing granularity

export interface WalletCoverOffer {
  chainId: number
  /** EXACT native raw (wei) to sell — the amount the accepted sale carries. */
  sellRaw: bigint
  /** The floor the plan will draw on this sale (≥ coversCents, verified). */
  floorCents: number
  /** The shortfall this offer covers, integer cents. */
  coversCents: number
  /** Review-time estimate of the sale's proceeds, integer cents (display). */
  estCents: number
}

/** The floor buildRunReview derives for a native sale of `raw` wei at `priceUsd`
 *  — the SAME two-floor arithmetic, so the offer and the review cannot drift. */
function nativeSaleFloorCents(raw: bigint, priceUsd: number, slippageBps: number, driftBps: number): number {
  const estCents = Math.floor((Number(raw) / 1e18) * priceUsd * 100)
  if (!Number.isFinite(estCents) || estCents <= 0) return 0
  return Math.floor((estCents * (10_000 - slippageBps - driftBps)) / 10_000)
}

/** Size the native sale that covers `shortCents` on this chain, or `null` when
 *  the wallet honestly cannot: no readable price, no readable gas reserve
 *  (unreadable must not read as free — law 5), or not enough ETH above the
 *  reserve to cover the WHOLE shortfall (a partial cover still refuses the
 *  chain whole, so offering it would be a lie). */
export function walletCoverOfferFor(args: {
  chainId: number
  shortCents: number
  /** The chain's native/USD price; null = unreadable = no offer. */
  priceUsd: number | null
  /** The wallet's native balance on this chain, wei. */
  nativeRaw: bigint
  /** Wei this chain must keep for its own fees; null = unreadable = no offer. */
  gasReserveRaw: bigint | null
  slippageBps: number
  driftBps: number
}): WalletCoverOffer | null {
  const { chainId, shortCents, priceUsd, nativeRaw, gasReserveRaw, slippageBps, driftBps } = args
  if (!Number.isInteger(shortCents) || shortCents <= 0) return null
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) return null
  if (gasReserveRaw == null || gasReserveRaw < 0n) return null
  if (nativeRaw <= gasReserveRaw) return null
  const cap = nativeRaw - gasReserveRaw

  // Derive (denominator-inverted, +1 cent for the double floor), then verify.
  const denom = 10_000 - slippageBps - driftBps
  if (denom <= 0) return null
  const estCentsNeeded = Math.ceil((shortCents * 10_000) / denom) + 1
  const ethNeeded = estCentsNeeded / 100 / priceUsd
  if (!Number.isFinite(ethNeeded) || ethNeeded <= 0) return null
  let raw = BigInt(Math.ceil(ethNeeded * 1e6)) * MICRO_ETH
  for (let i = 0; i < 4 && nativeSaleFloorCents(raw, priceUsd, slippageBps, driftBps) < shortCents; i++) {
    raw += MICRO_ETH
  }
  const floorCents = nativeSaleFloorCents(raw, priceUsd, slippageBps, driftBps)
  if (floorCents < shortCents) return null // the verify failed — never offer a cover that cannot
  if (raw > cap) return null
  const estCents = Math.floor((Number(raw) / 1e18) * priceUsd * 100)
  return { chainId, sellRaw: raw, floorCents, coversCents: shortCents, estCents }
}

export type RebalanceRunInput =
  | {
      kind: 'runnable'
      targets: NormalizedTarget[]
      amountCents: number
      cashDrawCents: number
      /** The trims that become REAL sales (the sell wiring pass) — sized by
       *  the composer's own exact raw amounts, priced/floored in
       *  buildRunReview through the live market read. */
      sells: { chainId: number; address: string; symbol: string; sellRaw: string; decimals: number }[]
    }
  | { kind: 'blocked'; reason: string }

/** Decompose a rebalance's composed changes into what the engine can honestly
 *  run — buys, cash draws and REAL sales — or the one true sentence about why
 *  it cannot. Pure; the flow's review effect calls it for rebalance drafts. */
export function rebalanceRunInput(args: {
  changes: RebalanceChange[]
  /** The draft's NET new money (amountUsd on a rebalance; 0/null valid). */
  netNewUsd: number
  settlementFor: (chainId: number) => Address | null
}): RebalanceRunInput {
  const buys = args.changes.filter((c) => c.toUsd - c.fromUsd > DUST_USD)
  const trims = args.changes.filter((c) => c.fromUsd - c.toUsd > DUST_USD)
  const isCash = (c: RebalanceChange) => {
    const s = args.settlementFor(c.chainId)
    return !!s && s.toLowerCase() === c.address.toLowerCase()
  }
  const cashDrawUsd = trims.filter(isCash).reduce((t, c) => t + (c.fromUsd - c.toUsd), 0)
  const sellTrims = trims.filter((c) => !isCash(c))
  const sellUsd = sellTrims.reduce((t, c) => t + (c.fromUsd - c.toUsd), 0)
  const buyUsd = buys.reduce((t, c) => t + (c.toUsd - c.fromUsd), 0)
  const netNewUsd = Number.isFinite(args.netNewUsd) && args.netNewUsd > 0 ? args.netNewUsd : 0

  // A trim can only become a SALE with the composer's exact raw size — a
  // sale reconstructed from USD would round someone's money (the sellRaw
  // field's own law). Unsized trims block BY NAME, never silently shrink.
  const unsized = sellTrims.filter((c) => {
    if (typeof c.sellRaw !== 'string' || !Number.isInteger(c.decimals)) return true
    try {
      return BigInt(c.sellRaw) <= 0n
    } catch {
      return true
    }
  })
  if (unsized.length > 0)
    return {
      kind: 'blocked',
      reason: `${unsized.map((c) => `$${c.symbol}`).join(', ')} cannot be sold exactly — the position has no readable on-chain amount (unpriced or unread). Re-open the edit, or remove that trim.`,
    }
  const sells = sellTrims.map((c) => ({
    chainId: c.chainId,
    address: c.address,
    symbol: c.symbol,
    sellRaw: c.sellRaw as string,
    decimals: c.decimals as number,
  }))

  if (buys.length === 0 && sells.length === 0)
    return {
      kind: 'blocked',
      reason: 'this change moves nothing the engine can act on — no buys compose and nothing is sold. Adjust the plan.',
    }

  // NO AFFORDABILITY CHECK HERE (the owner's second live find, 2026-08-14 ~19:4x:
  // "the portfolio does also have usdc / cash i dont know why this shows").
  // The composer funds buys from the HELD CASH PILE without emitting a trim
  // row — the pile is not a position card — so gating on trimmed cash refused
  // plans the wallet fully covers. Affordability is the funding plan's law:
  // it reads the wallet's REAL per-chain settlement balances and the sales'
  // FLOORED proceeds, and refuses with per-chain sentences when the money is
  // genuinely not there. This layer judges SHAPE only.
  const targets = buys.map((c) => {
    const usd = c.toUsd - c.fromUsd
    return {
      asset: { chainId: c.chainId, address: c.address, symbol: c.symbol, name: c.symbol, decimals: 18 },
      weight: usd,
      pct: 1,
      usd,
    } as NormalizedTarget
  })
  // The stated-cash story for the review's quiet line: whatever the buys need
  // beyond declared new money and the sales' own dollars is drawn from held
  // cash (explicit trims and the pile draw both land there — one pool).
  const cashStoryUsd = Math.max(0, buyUsd - netNewUsd - sellUsd)
  return {
    kind: 'runnable',
    targets,
    amountCents: Math.round(buyUsd * 100),
    cashDrawCents: Math.round(Math.max(cashDrawUsd, cashStoryUsd) * 100),
    sells,
  }
}

// ── the closures the runner hook takes ───────────────────────────────────────

/** What the review RENDERED, frozen per step — minted from the review model
 *  the station itself renders (the brand's one honest place; the station must
 *  render these exact rows, including the approval line). Bridge steps answer
 *  null: the runner refuses bridge-carrying plans whole before this matters. */
export function shownForFrom(review: PortfolioRunReview, account: Address): (step: FundingStep) => ShownStepReview | null {
  return (step) => {
    if (step.action.kind !== 'batch') return null
    const chain = review.chains.find((c) => c.chainId === (step.action as { chainId: number }).chainId)
    if (!chain || chain.legs.length === 0) return null
    return shownAtReviewSurface({
      chainId: chain.chainId,
      fundingAsset: chain.fundingAsset,
      fundingTotalRaw: chain.fundingTotalRaw,
      recipient: account,
      legs: chain.legs.map((l) => ({
        symbol: l.symbol,
        asset: l.asset,
        budgetRaw: l.budgetRaw,
        // floors derive from compose-time quotes, after this review rendered —
        // the null case the ShownLeg law names (still guarded: >0n + catch-all)
        minOutRaw: null,
        optional: l.optional,
      })),
      approvals: [chain.approval],
    })
  }
}

/** The exact-amount ERC-20 approvals per step — the same object the review
 *  disclosed (settlement → batcher, the whole pull, never unlimited). */
export function approvalsForFrom(review: PortfolioRunReview): (step: FundingStep) => { token: Address; amountRaw: bigint }[] {
  return (step) => {
    if (step.action.kind !== 'batch') return []
    const chain = review.chains.find((c) => c.chainId === (step.action as { chainId: number }).chainId)
    return chain ? [chain.approval] : []
  }
}

/** Everything the portfolio composer must read at COMPOSE TIME — injected so
 *  tests drive the closure without a network. Production: defaultRunDeps(). */
export interface ComposeDeps {
  batcherFor: (chainId: number) => Address | null
  chainNowSec: (chainId: number) => Promise<number>
  gasPriceWei: (chainId: number) => Promise<bigint | null>
  nativeUsd: (chainId: number) => Promise<number | null>
  hopReserveUsd: (chainId: number) => Promise<number | null>
  fetchQuote: ZeroExFetcher
  /** The operator's batch fee sink (audit F4's pin target). Null refuses —
   *  the contract reverts a zero sink and the laws pin the operator's own. */
  feeRecipient: Address | null
  feeBps?: number
  /** THE SIGNER'S OWN settlement balance on this chain, raw units. Optional so
   *  existing callers and tests are unchanged; absent simply skips the check.
   *  Null from the reader means UNREADABLE, which must not be treated as zero —
   *  refusing a fundable plan because a balance read failed would be its own
   *  bug (the read-failed law). */
  settlementBalance?: (chainId: number, account: Address, token: Address) => Promise<bigint | null>
  /** The review screen's per-leg protection overrides for a chain (lowercase
   *  asset → consented ceiling bps | 'none'). Absent = no overrides. */
  floorOverridesFor?: (chainId: number) => Record<string, number | 'none'> | undefined
}

/** The exact assembler input for one reviewed chain — PURE, exported so the
 *  seam test can drive the REAL assembler over the identical inputs the
 *  closure uses and prove shown-vs-composed meet at the gate. */
export function composeInputFor(
  chain: PortfolioChainReview,
  account: Address,
  reads: { batcher: Address; chainNowSec: number; gasPriceWei: bigint | null; nativeUsd: number | null; hopReserveUsd: number | null; feeRecipient: Address; feeBps?: number },
  /** The review screen's per-leg protection overrides for THIS chain (keyed
   *  by lowercase asset) — consent chosen after the review was built, so it
   *  overlays here rather than riding the frozen review object. */
  floorOverrides?: Record<string, number | 'none'>,
): Parameters<typeof assembleZeroExBatchBuyLive>[0] {
  return {
    ...(floorOverrides && Object.keys(floorOverrides).length > 0 ? { floorOverrides } : {}),
    chainId: chain.chainId,
    targets: chain.targets,
    grossUsdCents: chain.grossCents,
    fundingTotalRaw: chain.fundingTotalRaw,
    fundingAsset: chain.fundingAsset,
    account,
    batcher: reads.batcher,
    chainNowSec: reads.chainNowSec,
    deadlineSec: reads.chainNowSec + RUN_DEADLINE_WINDOW_SEC,
    feeBps: reads.feeBps ?? batchFeeBpsFor(chain.chainId),
    feeRecipient: reads.feeRecipient,
    generation: feeGenerationFor(chain.chainId),
    gasPriceWei: reads.gasPriceWei,
    nativeUsd: reads.nativeUsd,
    hopReserveUsd: reads.hopReserveUsd,
    ...(burnAssetFor(chain.chainId) ? { burn: { asset: burnAssetFor(chain.chainId) as Address } } : {}),
  }
}

/** What the batcher's burn STEP buys — NATIVE ETH, on EVERY chain: execBurn
 *  sells the funding asset and measures its own ETH balance delta, then sends
 *  the ETH to BURN_SINK; the PRISM buy-and-burn is the SINK's downstream job,
 *  never the batcher's (SpectrumContracts, 2026-08-15: "there is NO per-chain
 *  burn target token — a per-chain ERC-20 map would be the PRISM mistake
 *  generalised"). The chain-verified immutables back it: 4663's batcher reads
 *  BURN_ASSET = USDG (the settlement our composer always funds in, so the
 *  fundingAsset == BURN_ASSET gate holds by construction here), BURN_SINK =
 *  the rehearsal collector, BURN_TWAP_POOL supplies the contract-side floor.
 *  A chain with NO seated batcher composes no burn and the contract's
 *  fail-closed divert stands. */
export function burnAssetFor(chainId: number): Address | null {
  return chainId === 1 || chainId === 8453 || chainId === 4663 ? COW_NATIVE_BUY : null
}

/** The PORTFOLIO engine's composeStep: one funding step → the composed batch,
 *  through the live 0x assembler (which owns the flag gate, the fixpoint, the
 *  floors and the consent-divergence refusal). */
export function composePortfolioStepFor(
  review: PortfolioRunReview,
  account: Address,
  deps: ComposeDeps,
): (step: FundingStep) => Promise<ComposedPortfolioBatchBuy> {
  return async (step) => {
    if (step.action.kind !== 'batch')
      throw new BatchComposeRefusal('only a batch step composes — a transfer between networks is not a batch')
    const chainId = step.action.chainId
    const chain = review.chains.find((c) => c.chainId === chainId)
    if (!chain || chain.targets.length === 0)
      throw new BatchComposeRefusal(`network ${chainId} has nothing reviewed to compose — re-open the review`)
    const batcher = deps.batcherFor(chainId)
    if (!batcher || batcher === zeroAddress)
      throw new BatchComposeRefusal(`network ${chainId} has no batch contract seated in this deployment — nothing can compose`)
    if (!deps.feeRecipient || deps.feeRecipient === zeroAddress)
      throw new BatchComposeRefusal(
        'this deployment has no operator fee sink configured (VITE_INTERFACE_TAG_ADDRESS), and the contract refuses a zero fee sink — nothing was composed',
      )
    // ⚠⚠ THE SIGNER'S OWN BALANCE, CHECKED BEFORE ANY QUOTE IS SPENT.
    //
    // Twice in one evening a plan was sized against money the signer does not
    // hold, and both times it surfaced as an opaque route revert rather than
    // the one-line truth (the owner, 2026-08-15/16): a seed asked $60.00 of a
    // wallet holding $59.97, and a portfolio batch that passes from one wallet
    // fails from another with `TransferFromFailed` wrapped as a leg failure.
    //
    // The structural reason it can happen at all: this page READS balances
    // across the whole linked-wallet group but SIGNS with the active wallet
    // only (Yours.tsx's own note — "acting… stays keyed to the ACTIVE wallet").
    // So a perfectly correct plan can be unfundable by the one address that
    // will actually send it, and nothing before the chain notices.
    //
    // Checked HERE, before the quotes: a shortfall is arithmetic, it costs one
    // read, and discovering it on-chain wastes N live quotes to deliver a worse
    // sentence. Unreadable (null) SKIPS rather than refuses — a failed balance
    // read is not evidence of an empty wallet.
    if (deps.settlementBalance) {
      const held = await deps.settlementBalance(chainId, account, chain.fundingAsset).catch(() => null)
      if (held != null && held < chain.fundingTotalRaw) {
        const usd = (v: bigint) => `$${(Number(v) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        throw new BatchComposeRefusal(
          `Needs ${usd(chain.fundingTotalRaw - held)} more on this network. This buy costs ${usd(chain.fundingTotalRaw)} and the wallet signing it holds ${usd(held)}. If the rest is in another of your wallets, switch to it: the plan reads all of them, but only the connected one can sign.`,
        )
      }
    }
    const assembled = await assembleZeroExBatchBuyLive(
      composeInputFor(
        chain,
        account,
        {
          batcher,
          chainNowSec: await deps.chainNowSec(chainId),
          gasPriceWei: await deps.gasPriceWei(chainId),
          nativeUsd: await deps.nativeUsd(chainId),
          hopReserveUsd: await deps.hopReserveUsd(chainId),
          feeRecipient: deps.feeRecipient,
          feeBps: deps.feeBps,
        },
        deps.floorOverridesFor?.(chainId),
      ),
      deps.fetchQuote,
    )
    return assembled.composed
  }
}

/** The legacy engine's composeStep slot, which this surface deliberately does
 *  not wire: the retired batcher has no seated contract anywhere and the flip
 *  selects the portfolio engine. Unreachable by construction (SIMULATED
 *  refuses at the door today; the flip sets engine='portfolio') — but never a
 *  silent stub: if it is ever selected, it says exactly what it is. */
export function legacyComposeRefusal(): Promise<never> {
  return Promise.reject(
    new BatchComposeRefusal(
      'the legacy batch engine is not wired on this surface — this build composes through the portfolio engine only',
    ),
  )
}

/** A deadline around one build phase — the armed screen must never hold a
 *  skeleton forever (the owner, live 2026-08-14 13:09: "it says reading your
 *  wallets and markets, and then nothing happens"). One hung socket in a
 *  market read left the screen frozen with zero feedback; a read that cannot
 *  finish is an ANSWER (the read-failed law), so it becomes a sentence naming
 *  the phase, and the Try-again door stays live. */
export async function withPhaseDeadline<T>(work: Promise<T>, ms: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${phase} did not finish in ${Math.round(ms / 1000)}s — a network endpoint is slow or unreachable. Nothing ran; try again.`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
