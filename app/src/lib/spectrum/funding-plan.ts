// ─────────────────────────────────────────────────────────────────────────────
// THE FUNDING PLAN — the runner's second stage, built against the RULED §3
// (MONEY-PATHS-AUDIT, confirmed by the owner 2026-08-04; §3.1 records why each
// fork won and what it traded away). This is the module the ten audit findings
// F1–F10 exist to protect: it decides, per chain, where the money comes from,
// whether a bridge is needed, whether gas has to ride along, and in what order
// the user's transactions actually happen.
//
// PURE by construction — arithmetic and law, no clocks, no RNG, no reads. The
// runner supplies the inventory (its own reads) and consumes the steps.
//
// TWO UNIT AXES, deliberately never mixed:
//   · FUNDING is integer USD CENTS — it is compared across chains and across
//     assets, so dollars are the only common denominator. Raw scaling happens
//     later, at the batch composition step, where `FundingRaw` brands it (the
//     cents/raw seam that composed wrong-money calldata once already).
//   · GAS is per-chain NATIVE RAW (wei) — a chain's gas need against its own
//     native balance. Converting gas to dollars to compare it with funding
//     would invent a price where a balance comparison suffices.
//
// TWO KINDS OF FAILURE, deliberately different (self-audit round, 2026-08-04):
//   · A REFUSAL is a fact about the USER's money — not enough on a chain, no
//     gas reachable there. It travels as a review-grade sentence and the other
//     chains proceed.
//   · A CONTRACT ERROR is a fact about OUR code being wrong — the same dollars
//     handed in twice, a duplicated chain row. It THROWS, because the quiet
//     resolution of an ambiguous money input is a double-spend, and a caller
//     bug on a money path must be loud rather than absorbed.
//
// THE LAWS (each pinned):
//  1. COVERAGE ORDER (fork 1): local first → new money → cross-chain sell
//     proceeds LAST, because proceeds serialize (the sell must confirm before
//     a bridge can carry it). A proceeds-only chain SAYS it will wait.
//     · Within "local", CASH spends before PROCEEDS — leftover proceeds can
//       bridge to a deficit chain and leftover cash cannot, so burning the
//       bridgeable resource first would refuse plans that are fundable
//       (self-audit A3: it did exactly that).
//  2. CONSERVATION: what funds a chain sums EXACTLY to what that chain needs
//     (buys + fee — F9: the fee rides the funding total or the last leg
//     starves), and every drawn cent is RECORDED on the step, so the check
//     reads evidence instead of re-deriving it (the never-re-derive-money law
//     applied to my own checker — self-audit A6). A plan that cannot be funded
//     exactly refuses; it never half-funds and hopes.
//  3. GAS-FOLD (fork 2): a chain short on native gets its gas from an INBOUND
//     BRIDGE that also carries funding — one tx, not a local swap-for-gas's
//     two. A refuel rides a real transfer, never a zero-amount one (self-audit
//     A4: the fold emitted a bridge carrying nothing but gas, which the bridge
//     layer cannot execute), so such a chain is funded new-money-FIRST to give
//     the refuel something to ride. No carrier available ⇒ refuse by name.
//     A chain already holding enough native never refuels (like-with-like
//     quote comparison, the bridging law).
//  4. NO-REFUEL CHAINS (fork 3): where inbound refuel does not exist (4663
//     today, pending contracts' verdict), a gas-short chain REFUSES BY NAME —
//     never optional-legs (that would drop assets for a reason unrelated to
//     the asset) and never refuse-whole (that punishes the other chains).
//  5. UNREADABLE IS NOT FUNDED: a null gas estimate refuses the chain by name.
//     A chain we cannot size gas for is one we cannot promise executes.
// ─────────────────────────────────────────────────────────────────────────────

import { showChainId } from './safe-copy'
import { DEFAULT_SLIPPAGE_BPS } from './hook-data'

/** What the runner's reads found on one chain the plan touches. */
export interface ChainInventory {
  chainId: number
  /** Native balance, wei. */
  nativeRaw: bigint
  /** Estimated native needed for this chain's steps (approve+batch), wei.
   *  NULL = the estimate did not read — refuses by law 5, never assumed fine. */
  gasNeedRaw: bigint | null
  /** Funding dollars ALREADY spendable on this chain, integer cents, filtered
   *  to what `payWith` allows (auto = any settlement/stable + native; USDC =
   *  USDC only; ETH = native only).
   *
   *  ⚠ ONE HOME PER DOLLAR: money reported here must NOT also appear in
   *  `newMoney`. The same balance in both places spent twice across two chains
   *  in the audit probe, so the constructor throws on it rather than guessing
   *  which the caller meant (self-audit A2). On the `newMoney` chain, put the
   *  whole pool in `newMoney` and leave this 0. */
  localFundingCents: number
  /** Proceeds this plan's sells produce ON this chain, integer cents. They are
   *  spendable locally inside the same `batchRebalance` (the contract's own
   *  shape) and only leave the chain as a last-resort bridge. */
  sellProceedsCents: number
  /** Whether a bridge can deliver native gas INTO this chain (refuel).
   *  Defaults false for absence-by-default honesty: a chain we have not
   *  confirmed is treated as unable to receive gas (law 4). */
  inboundRefuel?: boolean
}

// ChainNeed lives in plan-shared-types.ts (the seam both planners share);
// re-exported so this module's callers are unchanged.
export { FundingPlanContractError, type ChainNeed } from './plan-shared-types'
import { FundingPlanContractError, type ChainNeed } from './plan-shared-types'

/** One asset this plan physically sells into its chain's settlement (the owner's
 *  live order 2026-08-14: real sells). The plan's spendable credit for these
 *  is the inventory's `sellProceedsCents` — pass 0 enforces the two agree per
 *  chain, so the draw math cannot spend proceeds no sale produces. */
export interface SellIntent {
  chainId: number
  /** Sold asset's address (plain string — this module stays viem-free). */
  asset: string
  symbol: string
  /** EXACT raw amount to sell, decimal string (a proportion of a known
   *  holding, never reconstructed from USD; bigint does not survive JSON). */
  sellRaw: string
  decimals: number
  /** The FLOOR of what this sale yields, integer cents — the only number the
   *  plan may draw on. The optimistic quote never enters the plan. */
  floorProceedsCents: number
}

export interface FundingPlanInput {
  chains: ChainInventory[]
  needs: ChainNeed[]
  /** The new-money pool: which chain the payWith asset sits on and how much
   *  of it is spendable, integer cents. Null = no new money in this plan (a
   *  pure rebalance). Must not double-count that chain's `localFundingCents`. */
  newMoney: { chainId: number; availableCents: number } | null
  /** The sales that PRODUCE each chain's `sellProceedsCents`. Absent/empty =
   *  no sales (every existing caller) — and then every inventory row must
   *  report sellProceedsCents 0, which pass 0 enforces. */
  sells?: SellIntent[]
}

export type FundingSource = 'local-cash' | 'local-proceeds' | 'new-money' | 'sell-proceeds'

/** Exactly where each cent came from — recorded, never re-derived. */
export interface FundingDraw {
  source: FundingSource
  fromChainId: number
  cents: number
}

export type FundingAction =
  | {
      /** ONE swap-sell of one held asset into its chain's settlement — the
       *  physical producer of the proceeds the draws consume. Executed as a
       *  pinned-router same-chain swap under the bridge lane's own laws,
       *  minus the arrival oracle (a same-chain receipt IS the settlement).
       *  Added 2026-08-14 on the owner's live order: the SHIPPING batcher is
       *  buy-only (batchBuy at SpectrumPortfolioBatcher.sol:592, no
       *  batchRebalance), so sells are separate transactions, one per sold
       *  leg — the inventory comment's older "inside the same batchRebalance"
       *  shape is superseded by this step kind. */
      kind: 'sell'
      chainId: number
      asset: string
      symbol: string
      sellRaw: string
      decimals: number
      /** What the plan drew on from this sale — the floor, never the quote. */
      floorProceedsCents: number
    }
  | {
      kind: 'bridge'
      fromChainId: number
      toChainId: number
      /** Always > 0: a refuel rides a real transfer (law 3). */
      amountCents: number
      /** True when this bridge also carries native gas for the destination
       *  (`fromAmountForGas`, sized by contracts' rule at execution — never
       *  hardcoded here). */
      refuel: boolean
      source: Exclude<FundingSource, 'local-cash' | 'local-proceeds'>
    }
  | {
      kind: 'batch'
      chainId: number
      /** Every cent that funds this chain, with its origin. */
      fundedFrom: FundingDraw[]
      /** A cheap digest of WHAT this batch buys (sorted targets+weights) —
       *  audit 2026-08-14 LOW-MED: funding alone does not identify intent, so
       *  two DIFFERENT portfolios with byte-identical funding collided to one
       *  step key and the second false-refused as "already done" for the
       *  15-min window. Optional: plans built before this field keep their
       *  old keys (a key change must never straddle a live deploy). */
      intent?: string
    }

export interface FundingStep {
  /** 1-based. Steps sharing an order may run in PARALLEL (bridges do). */
  order: number
  action: FundingAction
  /** Plain words: what must confirm before this step can start. Absent = now. */
  waitsFor?: string
}

export interface FundingRefusal {
  chainId: number
  /** Review-grade sentence — refusals travel as words, not codes. */
  reason: string
}

export interface FundingPlan {
  steps: FundingStep[]
  /** The sentences the review states verbatim (honesty, not decoration). */
  notes: string[]
  refusals: FundingRefusal[]
  /** True when any bridge waits on a sell confirming first — the run has an
   *  extra leg of waiting and the review says so (fork 1's stated cost). */
  serialized: boolean
  /** User-signed transactions per chain, honestly counted. */
  txCountByChain: { chainId: number; txs: number }[]
}

// FundingPlanContractError moved to plan-shared-types.ts with ChainNeed (one
// error class for unreadable money inputs, both planners throw it) — the
// two-kinds-of-failure note above still governs WHEN it throws.

/** A SHORTFALL rounds UP, always and deliberately: "add $402" when the gap is
 *  $402.50 leaves the user fifty cents short and the plan still refusing. The
 *  number in a shortfall sentence must be enough to fix the shortfall. */
const usdShortfall = (cents: number) =>
  `$${Math.ceil(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

const whole = (n: number) => Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))

/**
 * Resolve a composed plan into per-chain funding actions.
 *
 * A chain that cannot be funded EXACTLY, cannot be given gas, or whose gas
 * cannot be sized, refuses — and the other chains proceed. Refusing one chain
 * is not refusing the plan (fork 3's reasoning, applied generally).
 *
 * @throws FundingPlanContractError on an ambiguous money input (see A2/A5).
 */
/**
 * ⚠⚠ A BRIDGE DELIVERS LESS THAN IT CARRIES, AND THE PLAN USED TO IGNORE THAT.
 *
 * the owner, live 2026-08-16, on a $16 Base leg: "bridging does exactly the amount
 * needed e.g 16$ but then that leaves less than the required amount on the
 * chain which forces an error". He is right, and the arithmetic was doing it on
 * purpose: a shortfall of N cents produced a bridge of exactly N cents, while
 * the route's own fee and slippage come out of the middle, so the destination
 * receives N minus something and the batch — which pulls the FULL amount and
 * approves it exactly — reverts on arrival.
 *
 * That is the third instance of one shape this week (a seed asked $60.00 of a
 * wallet holding $59.97; a plan sized against the linked group but signed by
 * one wallet): SIZED TO THE PENNY AGAINST A NUMBER THAT MOVES.
 *
 * So a bridged draw carries headroom. The pad is small, bounded, and NEVER
 * lost: it lands in the user's own wallet on the destination chain as ordinary
 * settlement balance, spendable by the next run. Overshooting by cents is free;
 * undershooting costs the entire batch and a bridge wait.
 *
 * It is a CEILING, not a multiplier applied blindly: it can never draw more
 * than the source actually has, so a plan that exactly exhausts its funding
 * still composes at the un-padded amount rather than refusing.
 *
 * ⚠⚠ HOW IT STAYS INSIDE THE CONSERVATION LAW, because the first attempt did
 * not. Padding the DRAW rows breaks law (a) — `fundedFrom` must sum EXACTLY to
 * the chain's need — and the self-audit caught it immediately, correctly.
 *
 * But the draw and the bridge are DIFFERENT FIELDS. Conservation reads the draw
 * rows; the bridge step carries its own `cents`. So the draw stays exact and
 * the PAD rides only on the bridge, which is the thing that actually loses money
 * in transit. Law (a) is untouched, and the pad is bounded by the surplus truly
 * left at the source so law (b) — never draw a source beyond its inventory —
 * holds too. The surplus is then consumed, so a later chain cannot spend the
 * same cents twice.
 */
// ⚠⚠ IT IS THE BRIDGE'S OWN TOLERANCE, NOT A NUMBER I LIKED. The first cut used
// a hand-picked 50 bps, which would have failed exactly as before on any route
// losing more than half a percent — and the bridge is quoted at
// DEFAULT_SLIPPAGE_BPS (300 bps), so the route is PERMITTED to deliver 3% less
// than it carries. Padding by less than the loss you already authorised is not
// a fix, it is the same bug with a smaller number.
//
// Derived rather than copied, for the reason this file has now been bitten by
// twice this week: a second copy of a fact is a second thing to forget. If the
// bridge's slippage is ever changed, this follows it.
export const BRIDGE_ARRIVAL_HEADROOM_BPS = DEFAULT_SLIPPAGE_BPS

/** The amount to actually move so that AT LEAST `needCents` lands, given only
 *  `availableCents` at the source. Integer cents throughout: the funding plan's
 *  own domain, and a float here would reintroduce the rounding it exists to
 *  avoid. */
export function bridgeDrawFor(needCents: number, availableCents: number): number {
  if (!Number.isFinite(needCents) || needCents <= 0) return 0
  if (!Number.isFinite(availableCents) || availableCents <= 0) return 0
  const padded = needCents + Math.ceil((needCents * BRIDGE_ARRIVAL_HEADROOM_BPS) / 10_000)
  return Math.min(padded, Math.floor(availableCents))
}

/** The EXTRA cents to send beyond the draw, given the surplus actually left at
 *  the source. Zero when there is no surplus — the pad is a courtesy, never a
 *  reason to over-draw a source or to refuse a plan that exactly fits. */
export function bridgePadFor(drawCents: number, surplusCents: number): number {
  if (!Number.isFinite(drawCents) || drawCents <= 0) return 0
  if (!Number.isFinite(surplusCents) || surplusCents <= 0) return 0
  return Math.min(Math.ceil((drawCents * BRIDGE_ARRIVAL_HEADROOM_BPS) / 10_000), Math.floor(surplusCents))
}

export function buildFundingPlan(input: FundingPlanInput): FundingPlan {
  // ── pass 0: the input contract. Loud, not absorbed (see the two-kinds note) ─
  const dupChain = firstDuplicate(input.chains.map((c) => c.chainId))
  if (dupChain != null)
    throw new FundingPlanContractError(
      `chain ${dupChain} appears twice in the inventory — merge the rows before planning; two rows for one chain would spend its balance twice`,
    )
  const dupNeed = firstDuplicate(input.needs.map((n) => n.chainId))
  if (dupNeed != null)
    throw new FundingPlanContractError(
      `chain ${dupNeed} appears twice in the needs — sum them before planning; two need rows would batch that chain twice`,
    )
  if (input.newMoney) {
    const host = input.chains.find((c) => c.chainId === input.newMoney!.chainId)
    if (host && whole(host.localFundingCents) > 0)
      throw new FundingPlanContractError(
        `chain ${host.chainId} reports ${host.localFundingCents}c of local funding AND hosts the new-money pool — one home per dollar, or the same balance funds two chains`,
      )
  }

  // ⚠ AN UNREADABLE DOLLAR AMOUNT IS A CALLER BUG AND MUST BE LOUD (adversarial
  // pass, 2026-08-08). `whole()` clamps with `Math.max(0, floor(finite ? n : 0))`,
  // so NaN, Infinity, null, undefined and -400 ALL resolved to "no fee" — a plan
  // drawing exactly the buys, with no error and no refusal. A negative
  // `buysCents` produced a LIVE batch step drawing only the fee. This module's
  // own doctrine two dozen lines up is that a caller bug on a money path is
  // loud rather than absorbed, and it already throws for a duplicated chain id;
  // an amount it cannot read is the same class and was the one being swallowed.
  //
  // Validated HERE rather than inside `whole()` on purpose: whole() is the
  // rounding rule and is used on values that are legitimately absent, while
  // this is the input contract, where "we cannot read what you asked for" has
  // somewhere honest to land. Zero stays legal — a zero fee is a real answer.
  const money = (label: string, chainId: number, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      throw new FundingPlanContractError(
        `chain ${chainId}'s ${label} is ${String(v)}, which is not an amount of money — refusing to plan against a number we cannot read`,
      )
  }
  for (const n of input.needs) {
    money('buysCents', n.chainId, n.buysCents)
    money('feeCents', n.chainId, n.feeCents)
  }
  for (const c of input.chains) {
    money('localFundingCents', c.chainId, c.localFundingCents)
    money('sellProceedsCents', c.chainId, c.sellProceedsCents)
  }
  if (input.newMoney) money('newMoney.availableCents', input.newMoney.chainId, input.newMoney.availableCents)

  // ── the sells contract (only when the caller SUPPLIES sells — legacy
  // callers omit the field and keep the old batch-carries-sells model
  // byte-identical). The rule that keeps the draw math honest: the inventory
  // credit a chain reports must be EXACTLY what its sales floor at — credit
  // without a producing sale (or vice versa) is money that will never move,
  // and this module refuses to bookkeep fiction (the A1/HIGH lesson class). ─
  const sells = input.sells ?? []
  if (input.sells !== undefined) {
    const seenSell = new Set<string>()
    const floorByChain = new Map<number, number>()
    for (const s of sells) {
      money('floorProceedsCents', s.chainId, s.floorProceedsCents)
      const k = `${s.chainId}:${s.asset.toLowerCase()}`
      if (seenSell.has(k))
        throw new FundingPlanContractError(
          `asset ${s.asset} on chain ${s.chainId} is sold twice — merge the rows before planning; two sales of one holding would race each other's balance`,
        )
      seenSell.add(k)
      let raw: bigint
      try {
        raw = BigInt(s.sellRaw)
      } catch {
        raw = -1n
      }
      if (raw <= 0n)
        throw new FundingPlanContractError(
          `chain ${s.chainId}'s sale of ${s.symbol} has sellRaw "${s.sellRaw}", which is not a positive raw amount — refusing to plan a sale we cannot size`,
        )
      if (!input.chains.some((c) => c.chainId === s.chainId))
        throw new FundingPlanContractError(
          `chain ${s.chainId} hosts a sale but reports no inventory row — every selling chain must be read before planning`,
        )
      floorByChain.set(s.chainId, (floorByChain.get(s.chainId) ?? 0) + whole(s.floorProceedsCents))
    }
    for (const c of input.chains) {
      const declared = whole(c.sellProceedsCents)
      const produced = floorByChain.get(c.chainId) ?? 0
      if (declared !== produced)
        throw new FundingPlanContractError(
          `chain ${c.chainId} reports ${declared}c of sale proceeds but its sales floor at ${produced}c — the credit and its producers must agree exactly, or the plan spends money no sale yields`,
        )
    }
  }

  const byId = new Map(input.chains.map((c) => [c.chainId, c]))
  const refusals: FundingRefusal[] = []
  const notes: string[] = []

  // ── pass 1: gas viability, BEFORE any funding decision (it changes routing) ─
  // A gas-short chain that CAN refuel must be funded new-money-first so the
  // refuel has a real transfer to ride (law 3); one that cannot refuel is
  // refused now and never allocated a cent.
  const needsCarrier = new Set<number>()
  const gasRefused = new Set<number>()
  for (const need of input.needs) {
    const inv = byId.get(need.chainId)
    if (!inv) continue // handled in pass 2 with its own sentence
    if (inv.gasNeedRaw == null) {
      refusals.push({
        chainId: need.chainId,
        reason: `We could not estimate the network fee on network ${showChainId(need.chainId)}, so we cannot promise this network's transaction will go through. Nothing is sent there.`,
      })
      gasRefused.add(need.chainId)
      continue
    }
    if (inv.nativeRaw >= inv.gasNeedRaw) continue
    if (!inv.inboundRefuel) {
      refusals.push({
        chainId: need.chainId,
        reason: `Network ${need.chainId} needs its own ETH for fees and we cannot bridge fees into it yet, so this network's part of the plan needs you to already hold ETH there.`,
      })
      gasRefused.add(need.chainId)
      continue
    }
    needsCarrier.add(need.chainId)
  }

  // ── pass 1b: gas viability for SELLING chains (a sale is a transaction on
  // its own chain — the bridge-source A4 lesson, applied to the new producer).
  // A gas-short selling chain cannot sell, and refuel cannot help it: refuel
  // arrives on transfers INTO a chain, and a seller's money flows OUT. Its
  // sales are refused whole and its proceeds credit is ZEROED before pass 2
  // ever reads it, so no draw is planned against money that cannot be made. ─
  const sellGasRefused = new Set<number>()
  if (sells.length > 0) {
    for (const chainId of new Set(sells.map((s) => s.chainId))) {
      const inv = byId.get(chainId)!
      if (inv.gasNeedRaw != null && inv.nativeRaw >= inv.gasNeedRaw) continue
      sellGasRefused.add(chainId)
      refusals.push({
        chainId,
        reason:
          inv.gasNeedRaw == null
            ? `We could not estimate the network fee on network ${showChainId(chainId)}, and this plan sells there — those sales are not planned. Nothing is sent from that network.`
            : `Network ${showChainId(chainId)} holds sales this plan needs, but not enough of its own ETH to pay for them — those sales are not planned. Add ETH there, or reshape the plan without selling on that network.`,
      })
    }
  }
  const liveSells = sells.filter((s) => !sellGasRefused.has(s.chainId))

  // ── pass 2: local coverage — CASH first, then proceeds (law 1's inner order) ─
  // Carrier chains take nothing locally yet: their funding must lead with new
  // money so the refuel bridge carries a real amount.
  let newMoneyLeft = input.newMoney ? whole(input.newMoney.availableCents) : 0
  const newMoneyChain = input.newMoney?.chainId ?? null
  /** EXACT unspent proceeds per chain — the only cross-chain source besides new
   *  money. Over-stating this bridged cash while calling it proceeds (A1).
   *  A sell-gas-refused chain's credit reads ZERO here: its sales will not
   *  happen, so its proceeds must not fund anything (pass 1b). */
  const proceedsLeft = new Map<number, number>()
  for (const inv of input.chains) proceedsLeft.set(inv.chainId, sellGasRefused.has(inv.chainId) ? 0 : whole(inv.sellProceedsCents))

  interface Resolved {
    chainId: number
    drawn: FundingDraw[]
    shortCents: number
  }
  const resolvedById = new Map<number, Resolved>()
  for (const need of input.needs) {
    if (gasRefused.has(need.chainId)) continue
    const inv = byId.get(need.chainId)
    const total = whole(need.buysCents) + whole(need.feeCents)
    if (!inv) {
      refusals.push({
        chainId: need.chainId,
        reason: `We could not read what you hold on network ${showChainId(need.chainId)}, so this network's part of the plan cannot be funded — nothing here is assumed.`,
      })
      continue
    }
    // ⚠ M9 (reviewer, desk 236; MEASURED 2026-08-07): the registration used to
    // happen BEFORE the zero check below, so a chain needing NOTHING still
    // landed in `resolvedById` → `live` → a `batch` step at order 1. Measured:
    // needs [{8453: 100_000}, {1: 0}] produced batch steps on BOTH chains — a
    // wallet prompt and real gas for a batch that buys nothing. The `continue`
    // correctly skipped the funding work; the ROW was already there.
    //
    // ⚠ AND THE NARROW VERSION IS THE CORRECT ONE — my first cut said "total 0
    // ⇒ no row" and BROKE A RULED DESIGN, caught by this module's own suite
    // (the fork-1 test): a chain that needs NO buys but holds SELLS still needs
    // its batch step, because that is where the sells execute — "a chain whose
    // sells FUND another chain must batch first" is order 1's whole point. So
    // the row is skipped only when the chain has NOTHING to do on either side:
    // no buys AND no proceeds to realize.
    //
    // A chain with nothing to do gets no step and no refusal: there is nothing
    // to tell the user about a network the plan does not touch (unlike a
    // zero-cent LEG, which the user asked for by name and which does refuse).
    //
    // WITH REAL SELLS (input.sells provided, 2026-08-14): sales are their own
    // order-1 steps, so a batch row exists only where there are real buys —
    // the fork-1 "sell-only chain still batches" shape belongs to the legacy
    // batch-carries-sells model and is preserved exactly for callers that
    // omit `sells`. A sell-gas-refused chain's credit counts as zero here
    // too, or a dead chain would still be handed a step (pass 1b).
    if (input.sells !== undefined) {
      if (total === 0) continue
    } else if (total === 0 && whole(inv.sellProceedsCents) === 0) continue
    const res: Resolved = { chainId: need.chainId, drawn: [], shortCents: total }
    resolvedById.set(need.chainId, res)
    if (needsCarrier.has(need.chainId)) continue
    // cash before proceeds: leftover proceeds can bridge, leftover cash cannot
    const cash = Math.min(whole(inv.localFundingCents), res.shortCents)
    if (cash > 0) {
      res.drawn.push({ source: 'local-cash', fromChainId: need.chainId, cents: cash })
      res.shortCents -= cash
    }
    const localProceeds = Math.min(proceedsLeft.get(need.chainId) ?? 0, res.shortCents)
    if (localProceeds > 0) {
      res.drawn.push({ source: 'local-proceeds', fromChainId: need.chainId, cents: localProceeds })
      proceedsLeft.set(need.chainId, (proceedsLeft.get(need.chainId) ?? 0) - localProceeds)
      res.shortCents -= localProceeds
    }
  }

  // ── pass 3: cover shortfalls — new money, then cross-chain proceeds ─────────
  // Largest shortfall first: with a bounded pool, funding the big deficit whole
  // and refusing a small one beats half-funding both (law 2). Carrier chains go
  // FIRST regardless of size — their new money is what makes the refuel legal.
  const bridges: { fromChainId: number; toChainId: number; cents: number; source: 'new-money' | 'sell-proceeds' }[] = []
  const shortfalls = [...resolvedById.values()]
    .filter((r) => r.shortCents > 0)
    .sort((a, b) => {
      const ca = needsCarrier.has(a.chainId) ? 1 : 0
      const cb = needsCarrier.has(b.chainId) ? 1 : 0
      return cb - ca || b.shortCents - a.shortCents
    })
  for (const r of shortfalls) {
    // (b) new money, bridged from wherever the funding asset actually sits
    if (r.shortCents > 0 && newMoneyLeft > 0 && newMoneyChain != null) {
      const take = Math.min(r.shortCents, newMoneyLeft)
      // THE DRAW IS EXACT — conservation law (a) reads these rows
      r.drawn.push({ source: 'new-money', fromChainId: newMoneyChain, cents: take })
      newMoneyLeft -= take
      if (newMoneyChain !== r.chainId) {
        // ...and the PAD rides on the bridge only, out of surplus that remains
        // after every draw is satisfied, so nothing is double-spent and no
        // source is drawn past its inventory (law (b))
        const pad = bridgePadFor(take, newMoneyLeft)
        bridges.push({ fromChainId: newMoneyChain, toChainId: r.chainId, cents: take + pad, source: 'new-money' })
        newMoneyLeft -= pad
      }
      r.shortCents -= take
    }
    // a carrier chain falls back to its own money for the remainder — the
    // bridge above already carries the refuel
    if (r.shortCents > 0 && needsCarrier.has(r.chainId)) {
      const inv = byId.get(r.chainId)!
      const cash = Math.min(whole(inv.localFundingCents), r.shortCents)
      if (cash > 0) {
        r.drawn.push({ source: 'local-cash', fromChainId: r.chainId, cents: cash })
        r.shortCents -= cash
      }
      const lp = Math.min(proceedsLeft.get(r.chainId) ?? 0, r.shortCents)
      if (lp > 0) {
        r.drawn.push({ source: 'local-proceeds', fromChainId: r.chainId, cents: lp })
        proceedsLeft.set(r.chainId, (proceedsLeft.get(r.chainId) ?? 0) - lp)
        r.shortCents -= lp
      }
    }
    // (c) cross-chain sell proceeds LAST — the serializing source, and never
    // more than actually remains unspent on the source chain (A1's fix)
    if (r.shortCents > 0) {
      for (const [srcChain, available] of [...proceedsLeft.entries()].sort((a, b) => b[1] - a[1])) {
        if (r.shortCents <= 0) break
        if (srcChain === r.chainId || available <= 0) continue
        const take = Math.min(r.shortCents, available)
        r.drawn.push({ source: 'sell-proceeds', fromChainId: srcChain, cents: take })
        bridges.push({ fromChainId: srcChain, toChainId: r.chainId, cents: take, source: 'sell-proceeds' })
        proceedsLeft.set(srcChain, available - take)
        r.shortCents -= take
      }
    }
    if (r.shortCents > 0) {
      refusals.push({
        chainId: r.chainId,
        reason: `This plan needs ${usdShortfall(r.shortCents)} more to complete its network ${showChainId(r.chainId)} buys than you have available, so that network's part is not funded. Add funds or trim its targets.`,
      })
      resolvedById.delete(r.chainId)
    }
  }

  // ── pass 4: the fold must have carried something (law 3's A4 fix) ──────────
  const refuelInto = new Set<number>()
  for (const chainId of needsCarrier) {
    if (!resolvedById.has(chainId)) continue
    const inbound = bridges.filter((b) => b.toChainId === chainId && b.cents > 0)
    if (inbound.length === 0) {
      refusals.push({
        chainId,
        reason: `Network ${chainId} needs ETH for fees and nothing in this plan travels there to carry it, so this network's part needs you to already hold ETH there.`,
      })
      resolvedById.delete(chainId)
      continue
    }
    refuelInto.add(chainId)
    const local = [...resolvedById.get(chainId)!.drawn].some((d) => d.fromChainId === chainId)
    if (local)
      notes.push(
        `Network ${chainId} has some of your money already but no ETH for fees, so the fees ride in on a bridge instead of costing an extra transaction there.`,
      )
  }

  // ── assemble the ordered steps ─────────────────────────────────────────────
  // ⚠⚠ M8 (reviewer, desk 236; MEASURED 2026-08-07 — worse than the note said).
  // The gas pass above iterates `input.needs`, so a chain that hosts NO buys
  // was never gas-checked — but a bridge OUT of a chain is a TRANSACTION ON
  // that chain, and it needs that chain's native asset to pay for it.
  // Measured: Ethereum holding bridgeable proceeds, no need of its own, and
  // `gasNeedRaw: null` (the estimate did not read) produced `bridge:1` with
  // ZERO refusals — the plan asked for a signature on the most expensive chain
  // there is, on a fee we never established could be paid. The gas pass's own
  // sentence ("we cannot promise this network's transaction will go through")
  // was exactly right and simply never applied to this chain.
  //
  // Checked HERE rather than by widening the gas pass, because which chains
  // source bridges is only known after pass 2 — and widening it to every
  // chain in the inventory would refuse chains that never transact at all.
  // Same law as the pass above: an unreadable estimate is NOT a passing one.
  const bridgeSourceRefused = new Set<number>()
  for (const b of bridges) {
    if (b.cents <= 0 || bridgeSourceRefused.has(b.fromChainId)) continue
    const src = byId.get(b.fromChainId)
    const unreadable = !src || src.gasNeedRaw == null
    if (unreadable || src.nativeRaw < src.gasNeedRaw!) {
      bridgeSourceRefused.add(b.fromChainId)
      refusals.push({
        chainId: b.fromChainId,
        reason: unreadable
          ? `We could not estimate the network fee on network ${showChainId(b.fromChainId)}, and moving money out of it needs a transaction there — so we will not plan one. Nothing is sent from that network.`
          : `Network ${showChainId(b.fromChainId)} does not hold enough of its own ETH to pay for moving money out of it, so we will not plan that transfer.`,
      })
    }
  }

  // ⚠⚠ HIGH — adversarial pass, 2026-08-08. A BATCH SURVIVED THE REFUSAL OF THE
  // BRIDGE THAT FUNDED IT. The loop above refuses a bridge SOURCE and drops its
  // bridges from `liveBridges`, but the DESTINATION stayed in `resolvedById`
  // with the sell-proceeds draw still recorded — and because no live bridge now
  // targeted it, the ordering below stopped treating it as waiting and promoted
  // it from order 3 to ORDER 1 WITH NO `waitsFor`. It read as executable
  // immediately. Measured: a batch on Base pulling $1,004, funded entirely by
  // money the same plan had just refused to move, with only the SOURCE named in
  // refusals and nothing said about the destination.
  //
  // The conservation checker could not see it, and that is the instructive
  // part: it compares RECORDED DRAWS to the need, and the draws were all still
  // there. A checker that reads the plan's own bookkeeping cannot notice that
  // the bookkeeping describes money which will never move.
  //
  // Same shape with two sources refused only one is worse, because it is quiet:
  // exactly half the funding never arrives and a FULL-SIZE batch is still
  // emitted. This module's own header says a chain that cannot be funded
  // EXACTLY refuses and never half-funds and hopes — so it refuses here too,
  // by the same rule, naming the destination rather than only the source.
  for (const r of [...resolvedById.values()]) {
    const stranded = r.drawn
      .filter((d) => d.fromChainId !== r.chainId && bridgeSourceRefused.has(d.fromChainId))
      .reduce((sum, d) => sum + d.cents, 0)
    if (stranded <= 0) continue
    refusals.push({
      chainId: r.chainId,
      reason: `${usdShortfall(stranded)} of this network's funding was going to travel from a network we will not move money out of, so network ${showChainId(r.chainId)} cannot be funded in full. Nothing is sent there.`,
    })
    resolvedById.delete(r.chainId)
  }

  const live = [...resolvedById.values()]
  const liveIds = new Set(live.map((r) => r.chainId))
  const liveBridges = bridges.filter((b) => liveIds.has(b.toChainId) && b.cents > 0 && !bridgeSourceRefused.has(b.fromChainId))
  const sellingChains = new Set(liveSells.map((s) => s.chainId))
  const serialized =
    liveBridges.some((b) => b.source === 'sell-proceeds') ||
    (liveSells.length > 0 && live.some((r) => sellingChains.has(r.chainId) && r.drawn.some((d) => d.source === 'local-proceeds')))
  const steps: FundingStep[] = []
  // With real sells the whole ladder shifts one rung: sales are order 1 (the
  // physical producers), everything else keeps its relative place. Without
  // sells the numbering is byte-identical to the legacy shape.
  const shift = liveSells.length > 0 ? 1 : 0

  // order 1 (sells live) — the sales, one step per sold leg, parallel per
  // chain. Unconditional among the live: a pure cash-out plan is sales with
  // no buys at all, and that is a complete, runnable plan.
  for (const s of liveSells) {
    steps.push({
      order: 1,
      action: {
        kind: 'sell',
        chainId: s.chainId,
        asset: s.asset,
        symbol: s.symbol,
        sellRaw: s.sellRaw,
        decimals: s.decimals,
        floorProceedsCents: whole(s.floorProceedsCents),
      },
    })
  }

  // next — chains that can act with what they already have. A chain whose
  // sells FUND another chain must act before the bridges rather than beside
  // them; a batch drawing its own chain's proceeds waits on those sales.
  for (const r of live) {
    if (liveBridges.some((b) => b.toChainId === r.chainId)) continue
    steps.push({
      order: 1 + shift,
      action: { kind: 'batch', chainId: r.chainId, fundedFrom: r.drawn },
      ...(sellingChains.has(r.chainId) && r.drawn.some((d) => d.source === 'local-proceeds')
        ? { waitsFor: `the network ${showChainId(r.chainId)} sales confirming` }
        : {}),
    })
  }

  // next — bridges, in parallel; a proceeds bridge waits on its source.
  const batchingChains = new Set(live.map((r) => r.chainId))
  for (const b of liveBridges) {
    steps.push({
      order: 2 + shift,
      action: {
        kind: 'bridge',
        fromChainId: b.fromChainId,
        toChainId: b.toChainId,
        amountCents: b.cents,
        refuel: refuelInto.has(b.toChainId),
        source: b.source,
      },
      ...(b.source === 'sell-proceeds' && (sellingChains.has(b.fromChainId) || batchingChains.has(b.fromChainId))
        ? { waitsFor: `the network ${showChainId(b.fromChainId)} sales confirming` }
        : {}),
    })
  }

  // last — destination batches, composed AT ARRIVAL from what actually
  // landed (F10: bridges deliver variable amounts; nothing is composed from a
  // quote and hoped for).
  for (const r of live) {
    if (!liveBridges.some((b) => b.toChainId === r.chainId)) continue
    steps.push({
      order: 3 + shift,
      action: { kind: 'batch', chainId: r.chainId, fundedFrom: r.drawn },
      waitsFor: `the bridge into network ${showChainId(r.chainId)} arriving`,
    })
  }

  if (liveSells.length > 0) {
    for (const chainId of [...sellingChains].sort((a, b) => a - b)) {
      const n = liveSells.filter((s) => s.chainId === chainId).length
      notes.push(
        `This plan first sells ${n} holding${n === 1 ? '' : 's'} on network ${showChainId(chainId)} into cash — each sale is its own transaction, and nothing downstream moves until the sales it draws on confirm.`,
      )
    }
  }
  for (const b of liveBridges.filter((x) => x.source === 'sell-proceeds')) {
    notes.push(
      `Your network ${showChainId(b.fromChainId)} sales fund the network-${b.toChainId} buys, so this run has an extra leg of waiting: the sales confirm, then the money moves, then the buys go in.`,
    )
  }

  // Honest tx counts: one batch per live chain, plus one per bridge SENT from
  // it, plus one per sale on it. Approvals are the ladder's business (it
  // knows the wallet's capabilities) — counting them here would double-count
  // what a capable wallet bundles into one confirm.
  const txCountByChain = [
    ...new Set([...live.map((r) => r.chainId), ...liveBridges.map((b) => b.fromChainId), ...liveSells.map((s) => s.chainId)]),
  ]
    .sort((a, b) => a - b)
    .map((chainId) => ({
      chainId,
      txs:
        (liveIds.has(chainId) ? 1 : 0) +
        liveBridges.filter((b) => b.fromChainId === chainId).length +
        liveSells.filter((s) => s.chainId === chainId).length,
    }))

  return { steps: steps.sort((a, b) => a.order - b.order), notes, refusals, serialized, txCountByChain }
}

/**
 * Conservation check the runner asserts BEFORE signing anything — law 2 made
 * verifiable rather than trusted. It reads the RECORDED draws on each batch
 * step (never re-derives them from inventory: re-deriving money is what
 * invented "$3.63 of DEGEN" once, and a checker that recomputes is checking
 * its own arithmetic rather than the plan's). Also catches a source drawn
 * beyond what existed. Empty array = sound.
 */
export function fundingConservationErrors(
  input: FundingPlanInput,
  plan: FundingPlan,
): { chainId: number; needCents: number; fundedCents: number; note: string }[] {
  const out: { chainId: number; needCents: number; fundedCents: number; note: string }[] = []
  const needById = new Map(input.needs.map((n) => [n.chainId, whole(n.buysCents) + whole(n.feeCents)]))

  // (a) every live chain's recorded draws equal its need, exactly
  for (const step of plan.steps) {
    if (step.action.kind !== 'batch') continue
    const need = needById.get(step.action.chainId) ?? 0
    const funded = step.action.fundedFrom.reduce((s, d) => s + d.cents, 0)
    if (funded !== need)
      out.push({
        chainId: step.action.chainId,
        needCents: need,
        fundedCents: funded,
        note: funded < need ? 'under-funded: the plan would half-fill' : 'over-funded: the plan draws more than the chain needs',
      })
  }

  // (b) no source is drawn beyond what the inventory said existed
  const drawnBySource = new Map<string, number>()
  for (const step of plan.steps) {
    if (step.action.kind !== 'batch') continue
    for (const d of step.action.fundedFrom) {
      const key = `${d.source}:${d.fromChainId}`
      drawnBySource.set(key, (drawnBySource.get(key) ?? 0) + d.cents)
    }
  }
  for (const inv of input.chains) {
    const cash = drawnBySource.get(`local-cash:${inv.chainId}`) ?? 0
    if (cash > whole(inv.localFundingCents))
      out.push({
        chainId: inv.chainId,
        needCents: whole(inv.localFundingCents),
        fundedCents: cash,
        note: 'over-drawn: more local cash spent than the chain holds',
      })
    const proceeds =
      (drawnBySource.get(`local-proceeds:${inv.chainId}`) ?? 0) + (drawnBySource.get(`sell-proceeds:${inv.chainId}`) ?? 0)
    if (proceeds > whole(inv.sellProceedsCents))
      out.push({
        chainId: inv.chainId,
        needCents: whole(inv.sellProceedsCents),
        fundedCents: proceeds,
        note: 'over-drawn: more sale proceeds spent than the sales produce',
      })
  }
  if (input.newMoney) {
    const nm = drawnBySource.get(`new-money:${input.newMoney.chainId}`) ?? 0
    if (nm > whole(input.newMoney.availableCents))
      out.push({
        chainId: input.newMoney.chainId,
        needCents: whole(input.newMoney.availableCents),
        fundedCents: nm,
        note: 'over-drawn: more new money spent than was made available',
      })
  }
  return out
}

function firstDuplicate(ids: number[]): number | null {
  const seen = new Set<number>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return null
}
