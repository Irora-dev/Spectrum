import type { Address } from 'viem'
import { deploymentFor, settlementDecimalsFor } from '../chain/deployments'
import { clientFor } from '../chain/rpc'
import { erc20BalanceAbi } from './abis-v2'
import type { ChainNeed } from './funding-plan'
import { DEFAULT_SLIPPAGE_BPS } from './hook-data'
import { LIFI_NATIVE, type LifiQuote, type LifiQuoteArgs } from './lifi'
import { assertContract, chainWords } from './thesis-funding'
import type { LegFunding, PerChainFunds } from './thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// THESIS PAY ASSET — pay the whole-bundle buy out of an asset the wallet
// actually holds, instead of only each chain's settlement token.
//
// THE RULING (the owner 2026-08-13, looking at the buy plate's "You pay / 500 USD /
// 3 networks" console): "you should probably be able to select the asset you
// want to swap out of here right?" — his own 2026-08-11 question ("500 USD —
// should allow selecting which asset to sell from?"), answered-not-built then.
// It bit for real the same night: the deploy wallet held only ETH, the run
// pays ONLY from each chain's settlement token (thesis-funding reads
// deploymentFor(chainId).usdc and nothing else), so every leg refused while
// the wallet sat on 0.99 ETH.
//
// WHAT THIS MODULE IS: the funding composer for a chosen pay asset — the
// sibling of thesis-funding's legFundings, same laws, same input contract
// (assertContract is IMPORTED, not cloned), producing the same LegFunding rows
// the sequencer consumes, with `convert` filled where a sale covers a leg's
// shortfall. Plus the picker's inventory read and the console↔overlay choice
// hand-off.
//
// THE LAWS IT ADDS (everything else is inherited):
//   · CONSERVATIVE UNIVERSE — native ETH + WETH on the thesis's own chains,
//     and only what the wallet ACTUALLY holds with a READABLE balance. Both
//     price off the app's own on-chain native read (v4-usd); any wider
//     universe would need a per-token price source to size sales, and a made-
//     up price sizing a real sale is exactly the fabrication this kit refuses.
//     (Deliberately NOT offered in v1: arbitrary ERC-20s, stock tokens,
//     settlement-token cross-picks — the settlement path IS the default row.)
//   · SELLS RIDE THE EXISTING EXECUTOR — every conversion is a LI.FI quote
//     (same-chain sell, or cross-chain sell-and-bridge in ONE quote) executed
//     by use-bridge-leg's quoteAndSendToken. This module only SIZES and PLANS;
//     it never invents a second quote/execute path.
//   · SIZED TO THE QUOTE'S OWN FLOOR — a conversion is composed only when the
//     quote's toAmountMin covers the leg's shortfall, so the follow-on buy is
//     funded even at worst-case slippage. Typical delivery overshoots; the
//     excess lands as the user's own settlement, which beats an under-funded
//     buy reverting in the wallet.
//   · A FAILED QUOTE IS A NAMED REFUSAL for that leg — never a guessed rate.
//     An unreadable price, balance, or gas figure refuses the same way
//     (funding-plan law 5: unreadable is not zero, and never free).
//   · A GAP IS STATED IN THE PAY ASSET'S UNITS, rounded UP — the number in a
//     shortfall sentence must be enough to actually fix it.
//   · NO REFUEL RIDES A CONVERSION — use-bridge-leg's refuel conversion prices
//     the from-token at $1, which only settlement can promise. A destination
//     that cannot pay its own fee therefore refuses by name (with both fixes)
//     instead of stranding a conversion's proceeds there.
//   · DEMO NEVER QUOTES — nothing here runs for a walkthrough; the overlay's
//     demo path composes from demoFundings, which carries no converts.
// ─────────────────────────────────────────────────────────────────────────────

/** One offerable pay asset: a real holding on one of the thesis's own chains.
 *  address === LIFI_NATIVE ⇒ the chain's native coin. */
export interface PayAssetOption {
  chainId: number
  address: Address
  symbol: string
  decimals: number
  /** The balance as read when offered — display; plans re-read it fresh. */
  balanceRaw: bigint
}

// ── the console ↔ overlay hand-off ───────────────────────────────────────────
// The console (where the choice is made) and the run overlay (where the plan
// composes) are mounted by a page neither owns, so the choice travels through
// a session-scoped module store KEYED BY THE LEG SET — a stale pick from one
// bundle can never leak into another's run. Never persisted: a money-path
// default must be the settlement path on every fresh session.

const payChoices = new Map<string, PayAssetOption>()

export function thesisPayKey(legs: readonly { chainId: number; address: string }[]): string {
  return legs
    .map((l) => `${l.chainId}:${l.address.toLowerCase()}`)
    .sort()
    .join('|')
}

export function setThesisPayChoice(key: string, opt: PayAssetOption | null): void {
  if (opt == null) payChoices.delete(key)
  else payChoices.set(key, opt)
}

export function thesisPayChoice(key: string): PayAssetOption | null {
  return payChoices.get(key) ?? null
}

// ── the picker's inventory ───────────────────────────────────────────────────

/** The balance-reading boundary, injected so the node suite scripts it. */
export interface PayAssetIo {
  native(chainId: number, holder: Address): Promise<bigint>
  erc20(chainId: number, token: Address, holder: Address): Promise<bigint>
}

const liveIo: PayAssetIo = {
  native: (chainId, holder) => clientFor(chainId).getBalance({ address: holder }),
  erc20: (chainId, token, holder) =>
    clientFor(chainId).readContract({ address: token, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [holder] }),
}

/** The composer's live balance seam — a plan must re-read the pay balance
 *  fresh, never trust the picker's earlier figure. */
export function readPayBalanceLive(pay: PayAssetOption, holder: Address): Promise<bigint> {
  return pay.address === LIFI_NATIVE ? liveIo.native(pay.chainId, holder) : liveIo.erc20(pay.chainId, pay.address, holder)
}

/**
 * What the wallet can pay from, beyond settlement: native ETH + WETH on the
 * given (thesis) chains. An asset appears ONLY when its balance was READ and
 * is POSITIVE — an unreadable balance is never offered as available (absent ≠
 * zero, law 5), and an asset the wallet does not hold is never listed.
 * Order: input chain order, native before WETH.
 */
export async function readPayAssetOptions(
  chainIds: readonly number[],
  holder: Address,
  io: PayAssetIo = liveIo,
): Promise<PayAssetOption[]> {
  const probes = chainIds.flatMap((chainId) => {
    const w = chainWords(chainId)
    const out: { chainId: number; address: Address; symbol: string; read: Promise<bigint> }[] = [
      { chainId, address: LIFI_NATIVE, symbol: w.gas, read: io.native(chainId, holder) },
    ]
    const weth = deploymentFor(chainId).weth
    if (weth) out.push({ chainId, address: weth as Address, symbol: 'WETH', read: io.erc20(chainId, weth as Address, holder) })
    return out
  })
  const settled = await Promise.all(
    probes.map(async (p) => {
      try {
        const balanceRaw = await p.read
        if (typeof balanceRaw !== 'bigint' || balanceRaw <= 0n) return null
        return { chainId: p.chainId, address: p.address, symbol: p.symbol, decimals: 18, balanceRaw }
      } catch {
        return null // unreadable is not zero — and never offered
      }
    }),
  )
  return settled.filter((o): o is PayAssetOption => o != null)
}

// ── the funding composer ─────────────────────────────────────────────────────

/** Sizing pads, in bps. HEADROOM oversizes the first quote past slippage
 *  (DEFAULT_SLIPPAGE_BPS) + typical route fees so one quote usually suffices;
 *  RESIZE_PAD cushions the one permitted re-quote. Pads only ever OVERSIZE the
 *  sale (excess returns as the user's own settlement) — never the reverse. */
const SIZING_HEADROOM_BPS = 200n
const RESIZE_PAD_BPS = 100n
const BPS = 10_000n

/** Cents (integer USD cents) → settlement raw in the CHAIN'S OWN decimals
 *  (cold-review INFO-1: hardcoded 6dp here under-sized the toAmountMin cover
 *  check for any non-6dp settlement token). */
const centsToRaw = (cents: number, decimals: number): bigint =>
  BigInt(Math.max(0, Math.floor(cents))) * 10n ** BigInt(decimals - 2)

/** Cents → micro-USD (×10^4) — decimals-INDEPENDENT, for pricing math against
 *  priceMicro (USD × 1e6): sizing must never inherit the destination token's
 *  decimals, or an 8dp settlement would inflate every sale 100×. */
const centsToMicroUsd = (cents: number): bigint => BigInt(Math.max(0, Math.floor(cents))) * 10_000n

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/** The quote boundary — fetchLifiQuote's exact shape, injected for tests the
 *  way use-bridge-leg's effects are. */
export type PayQuoteFn = (args: LifiQuoteArgs) => Promise<LifiQuote>

export interface ComposePayFundingArgs {
  needs: ChainNeed[]
  /** Fresh per-chain settlement/gas inventory (readThesisFunds' output). */
  funds: PerChainFunds[]
  pay: PayAssetOption
  holder: Address
  quote: PayQuoteFn
  /** The app's own on-chain native-USD read (v4-usd.ts) — null = unreadable. */
  nativeUsd: (chainId: number) => Promise<number | null>
  /** Fresh pay-asset balance read — the option's display balance is stale by
   *  definition. Reject-on-throw ⇒ every conversion refuses by name. */
  readBalance: (pay: PayAssetOption, holder: Address) => Promise<bigint>
}

export interface PayFundingPlan {
  legs: LegFunding[]
  /** Total pay-asset raw the composed conversions sell (Σ fromAmountRaw). */
  totalFromRaw: bigint
}

/**
 * Net each leg against its own chain's settlement (thesis-funding's netting,
 * unchanged) and cover every remaining shortfall by SELLING the chosen pay
 * asset into that leg's settlement — one LI.FI quote per short leg, sized so
 * the quote's own toAmountMin covers the need. Every input leg appears in the
 * output exactly once; a leg that cannot be covered says why in plain words.
 *
 * @throws FundingPlanContractError on unreadable money INPUTS (our bug, the
 *         thesis-funding contract — imported, not cloned).
 */
export async function composePayFunding(args: ComposePayFundingArgs): Promise<PayFundingPlan> {
  const { needs, funds, pay, holder } = args
  assertContract(needs, funds)

  const fundsById = new Map(funds.map((f) => [f.chainId, f]))
  const payWords = chainWords(pay.chainId)
  const asset = `${pay.symbol} on ${payWords.name}`

  // Shared plan facts, resolved once. Any failure here refuses every SHORT leg
  // by name (legs whose money is already home are untouched by it).
  let planRefusal: string | null = null
  let balanceRaw = 0n
  let priceMicro = 0n // pay-asset USD price × 1e6, integer — bigint sizing math
  const payRow = fundsById.get(pay.chainId)

  if (!payRow) {
    planRefusal = `Could not read balances on ${payWords.name}, where your ${pay.symbol} would be sold — nothing is planned from it.`
  } else if (payRow.gasNeedRaw == null) {
    planRefusal = `We could not estimate network fees on ${payWords.name}, where your ${pay.symbol} would be sold, so we cannot promise the sales go through — nothing is planned from it.`
  }
  if (planRefusal == null) {
    try {
      balanceRaw = await args.readBalance(pay, holder)
      if (typeof balanceRaw !== 'bigint' || balanceRaw < 0n) throw new Error('unreadable')
    } catch {
      planRefusal = `Could not re-read your ${asset} balance at planning time — nothing is planned from it. Try again in a moment.`
    }
  }
  if (planRefusal == null) {
    const price = await args.nativeUsd(pay.chainId).catch(() => null)
    // ETH and WETH are the same asset by construction; both price off the
    // app's own native read. An unreadable price refuses — never a guess.
    if (price == null || !Number.isFinite(price) || price <= 0) {
      planRefusal = `Could not read an ${payWords.gas} price on ${payWords.name} to size the sales — nothing is planned from your ${pay.symbol}. Try again in a moment.`
    } else {
      priceMicro = BigInt(Math.round(price * 1e6))
      if (priceMicro <= 0n) planRefusal = `Could not read an ${payWords.gas} price on ${payWords.name} to size the sales — nothing is planned from your ${pay.symbol}.`
    }
  }

  // Pre-size the gas reserve on the pay chain: each sale is its own
  // transaction there (approve + send for WETH; send for native), and the pay
  // chain's own leg — if it has one — still signs its buy there too. The
  // budget is thesis-funding's own conservative per-leg figure; unused gas
  // refunds, an under-reserved sale strands a plan.
  const shortLegs = needs.filter((n) => {
    const f = fundsById.get(n.chainId)
    const needCents = whole(n.buysCents) + whole(n.feeCents)
    return f != null && needCents - whole(f.usdcCents) > 0
  })
  const ownLegBudget = needs.some((n) => n.chainId === pay.chainId) ? 1n : 0n
  const gasReserveRaw = payRow?.gasNeedRaw != null ? payRow.gasNeedRaw * (BigInt(shortLegs.length) + ownLegBudget) : 0n

  if (planRefusal == null && pay.address !== LIFI_NATIVE && payRow != null && payRow.nativeRaw < gasReserveRaw) {
    planRefusal = `${payWords.name} does not hold enough ${payWords.gas} to pay the network fees of selling your ${pay.symbol} there — add ${payWords.gas} on ${payWords.name}, or pay with settlement balances instead.`
  }

  // The draw ledger on the pay balance — two legs can never sell the same
  // units (thesis-funding's conservation law, applied to the pay asset).
  // Native pay spends the same pot its sale fees come from, so the reserve
  // comes off the top before any leg draws.
  let availableRaw = balanceRaw - (pay.address === LIFI_NATIVE ? gasReserveRaw : 0n)
  if (availableRaw < 0n) availableRaw = 0n
  let totalFromRaw = 0n

  const legs: LegFunding[] = []
  for (const n of needs) {
    const needCents = whole(n.buysCents) + whole(n.feeCents)
    const w = chainWords(n.chainId)
    const f = fundsById.get(n.chainId)

    if (!f) {
      legs.push({
        chainId: n.chainId,
        needCents,
        haveCents: 0,
        shortfallCents: needCents,
        bridge: null,
        convert: null,
        gasOk: false,
        note: `Could not read balances on ${w.name}, so this leg cannot be planned. Nothing is sent there.`,
      })
      continue
    }

    const haveCents = whole(f.usdcCents)
    const shortfallCents = Math.max(0, needCents - haveCents)
    const base = { chainId: n.chainId, needCents, haveCents, shortfallCents, bridge: null as LegFunding['bridge'] }

    // Law 5 outranks the routing, exactly as in legFundings: an unsizeable fee
    // on the destination refuses before any money is aimed at it.
    if (f.gasNeedRaw == null) {
      legs.push({
        ...base,
        convert: null,
        gasOk: false,
        note: `We could not estimate the network fee on ${w.name}, so we cannot promise this leg's transactions will go through. Nothing is sent there.`,
      })
      continue
    }

    const gasDeficitWei = f.nativeRaw < f.gasNeedRaw ? f.gasNeedRaw - f.nativeRaw : 0n

    if (shortfallCents === 0) {
      // No refuel can ride a conversion, so ANY chain that cannot pay its own
      // fee refuses by name — the pay chain included (a carrier bridge is the
      // settlement path's trick, and the user chose the other path).
      if (gasDeficitWei > 0n) {
        legs.push({
          ...base,
          convert: null,
          gasOk: false,
          note: `${w.name} needs ${w.gas} for network fees, and a gas top-up cannot ride a ${pay.symbol} conversion — add ${w.gas} on ${w.name}, or pay with settlement balances instead.`,
        })
      } else {
        legs.push({ ...base, convert: null, gasOk: true, note: null })
      }
      continue
    }

    // ── a conversion must cover this leg ────────────────────────────────────
    if (planRefusal != null) {
      legs.push({ ...base, convert: null, gasOk: gasDeficitWei === 0n, note: planRefusal })
      continue
    }
    // Cross-chain: a destination that cannot pay its own fee refuses before
    // money is aimed at it (M8). The pay chain's own deficit is handled by the
    // reserve math below — its sales and its buy draw the same native pot.
    if (n.chainId !== pay.chainId && gasDeficitWei > 0n) {
      legs.push({
        ...base,
        convert: null,
        gasOk: false,
        note: `Needs ${w.gas} for network fees on ${w.name}, and a gas top-up cannot ride a ${pay.symbol} conversion — add ${w.gas} on ${w.name}, or pay with settlement balances instead.`,
      })
      continue
    }
    const destUsdc = deploymentFor(n.chainId).usdc
    if (!destUsdc) {
      legs.push({
        ...base,
        convert: null,
        gasOk: true,
        note: `No settlement asset is configured on ${w.name} — nothing can land there.`,
      })
      continue
    }

    const destDecimals = settlementDecimalsFor(n.chainId)
    // The COVER bar, in the destination token's own raw units (what the
    // quote's toAmountMin is denominated in).
    const shortfallRaw = centsToRaw(shortfallCents, destDecimals)
    // First sizing: the app's own price + headroom past slippage and fees.
    // Sized from micro-USD, never from shortfallRaw — the price math must not
    // inherit the destination token's decimals (INFO-1's class).
    let fromRaw = ceilDiv(
      centsToMicroUsd(shortfallCents) * 10n ** BigInt(pay.decimals) * (BPS + BigInt(DEFAULT_SLIPPAGE_BPS) + SIZING_HEADROOM_BPS),
      priceMicro * BPS,
    )

    const quoteFor = (amount: bigint) =>
      args.quote({
        chainId: n.chainId,
        fromChainId: pay.chainId,
        fromToken: pay.address,
        toToken: destUsdc,
        fromAmount: amount,
        fromAddress: holder,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      })

    try {
      if (fromRaw > availableRaw) {
        legs.push({ ...base, convert: null, gasOk: true, note: gapNote(fromRaw - availableRaw, pay, asset, w.name) })
        continue
      }
      let q = await quoteFor(fromRaw)
      if (q.toAmountMin < shortfallRaw) {
        // One precise resize off the quote's own rate, padded, re-verified.
        const resized = ceilDiv(fromRaw * shortfallRaw * (BPS + RESIZE_PAD_BPS), q.toAmountMin * BPS)
        if (resized > availableRaw) {
          legs.push({ ...base, convert: null, gasOk: true, note: gapNote(resized - availableRaw, pay, asset, w.name) })
          continue
        }
        const q2 = await quoteFor(resized)
        if (q2.toAmountMin < shortfallRaw) {
          legs.push({
            ...base,
            convert: null,
            gasOk: true,
            note: `The route could only guarantee ${usd(rawToCentsFloorLocal(q2.toAmountMin, destDecimals))} of the ${usd(shortfallCents)} this leg needs on ${w.name} — refused rather than under-funding the buy. Try again in a moment.`,
          })
          continue
        }
        fromRaw = resized
        q = q2
      }
      // THE TRUE OUTLAY counts the route's on-top native fee (lifi.ts
      // reconciles it into tx.value; owner 2026-08-16 — the RH leg's class).
      // A NATIVE pay draws principal AND fee from this same balance, so the
      // ledger must subtract both or the wallet is asked for more than the
      // gas set-asides left. A token pay's fee draws native gas instead —
      // it never touches availableRaw, and the send prompt states it.
      const outlay = fromRaw + (pay.address === LIFI_NATIVE ? q.nativeFeeRaw : 0n)
      if (outlay > availableRaw) {
        legs.push({ ...base, convert: null, gasOk: true, note: gapNote(outlay - availableRaw, pay, asset, w.name) })
        continue
      }
      availableRaw -= outlay
      totalFromRaw += fromRaw
      legs.push({
        ...base,
        convert: {
          fromChainId: pay.chainId,
          token: { address: pay.address, symbol: pay.symbol, decimals: pay.decimals },
          fromAmountRaw: fromRaw,
          quotedToRaw: q.toAmount,
          quotedToMinRaw: q.toAmountMin,
        },
        gasOk: true,
        note: null,
      })
    } catch (e) {
      // A failed quote is a NAMED refusal for this step — never a guessed
      // rate, and never a silent drop. The route service's own sentence rides.
      const why = e instanceof Error && e.message ? ` ${e.message}` : ''
      legs.push({
        ...base,
        convert: null,
        gasOk: true,
        note: `No conversion route right now for ${w.name}'s leg (${pay.symbol} → ${w.settlement}).${why} Nothing is planned from your ${pay.symbol} for it.`,
      })
    }
  }

  return { legs, totalFromRaw }
}

/** The gap, in the pay asset's units, rounded UP at display precision — the
 *  stated number must be enough to actually fix it. */
function gapNote(gapRaw: bigint, pay: PayAssetOption, asset: string, destName: string): string {
  return `Covering ${destName}'s leg needs ≈${formatAssetCeil(gapRaw, pay.decimals)} ${pay.symbol} more than your ${asset} can spare (after gas set-asides) — add ${pay.symbol}, or lower the amount.`
}

/** Local copy of the floor-direction cents read for refusal sentences only
 *  (run-lanes' rawToCentsFloor lives in a component dir this lib must not
 *  import from). Floors — a guaranteed figure is never rounded up. Takes the
 *  token's decimals: this reads DESTINATION-settlement raw (INFO-1's class). */
function rawToCentsFloorLocal(raw: bigint, decimals: number): number {
  if (raw <= 0n) return 0
  const cents = raw / 10n ** BigInt(decimals - 2)
  return cents > 9_007_199_254_740_991n ? Number.MAX_SAFE_INTEGER : Number(cents)
}

/** thesis-funding's whole(): floor validated-but-fractional cents. */
const whole = (n: number) => Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))

/** Shortfall dollars ROUND UP (thesis-funding's usd law). */
const usd = (cents: number) => `$${Math.ceil(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

// ── display formatting for pay-asset amounts ─────────────────────────────────
// Two directions, never mixed: a COST rounds UP (never understate what the
// user pays), a HOLDING rounds DOWN (never overstate what they have).

export function formatAssetCeil(raw: bigint, decimals: number, dp = 6): string {
  return formatScaled(raw, decimals, dp, 'up')
}

export function formatAssetFloor(raw: bigint, decimals: number, dp = 4): string {
  return formatScaled(raw, decimals, dp, 'down')
}

function formatScaled(raw: bigint, decimals: number, dp: number, mode: 'up' | 'down'): string {
  if (raw <= 0n) return '0'
  const cut = Math.max(0, decimals - dp)
  const scale = 10n ** BigInt(cut)
  const units = mode === 'up' ? ceilDiv(raw, scale) : raw / scale
  const keep = decimals - cut // fractional digits that survive
  const s = units.toString().padStart(keep + 1, '0')
  const intPart = s.slice(0, s.length - keep) || '0'
  const frac = keep > 0 ? s.slice(s.length - keep).replace(/0+$/, '') : ''
  const intWords = intPart.length <= 15 ? Number(intPart).toLocaleString('en-US') : intPart
  return frac ? `${intWords}.${frac}` : intWords
}

// ── the first-buy floor line (display honesty — the refusal stays the owner's) ──
// A zero-supply basket's first mint reverts under MIN_FIRST_DEPOSIT
// (launch-first-mint.ts) while the seed plan never checked it — a $30 stake on
// 29% legs signs and reverts. These helpers let the plan SAY it before
// anything is signed. They take the ALLOCATOR as an argument (the overlay
// passes thesisNeeds itself) so the split law lives in exactly one place.

export interface FloorLine {
  under: { chainId: number; buysCents: number }[]
  /** The smallest whole-dollar total whose every leg clears the floor, or
   *  null when no bounded total does (degenerate splits). */
  raiseToCents: number | null
}

export function firstBuyFloorLine(
  needs: readonly ChainNeed[],
  allocate: (totalCents: number) => readonly ChainNeed[] | null,
  floorCents: number,
): FloorLine | null {
  const under = needs.filter((n) => n.buysCents > 0 && n.buysCents < floorCents).map((n) => ({ chainId: n.chainId, buysCents: n.buysCents }))
  if (under.length === 0) return null
  const total = needs.reduce((s, n) => s + n.buysCents, 0)
  let raiseToCents: number | null = null
  if (total > 0) {
    // Analytic candidate off the observed shares, then VERIFY with the real
    // allocator — rounding lives there, so the sentence's number must too.
    const minShareCents = Math.min(...needs.filter((n) => n.buysCents > 0).map((n) => n.buysCents))
    const clears = (cents: number): boolean => {
      const alloc = allocate(cents)
      return alloc != null && alloc.length > 0 && alloc.every((n) => n.buysCents >= floorCents)
    }
    let candidate = Math.ceil((floorCents * total) / minShareCents / 100) * 100
    for (let i = 0; i < 60; i++) {
      if (clears(candidate)) {
        raiseToCents = candidate
        break
      }
      candidate += 100
    }
    // The analytic candidate derives from integer-cent shares, which UNDER-
    // state the smallest share and so OVER-shoot the raise (equal thirds of
    // $29 read as 966/2900, pointing at $31 when $30 already clears). The
    // field's contract is the SMALLEST clearing whole-dollar total, so walk
    // back down while the real allocator keeps clearing — bounded like the
    // walk up; if the bound cuts the walk short the figure is still a
    // clearing total, merely not proven minimal.
    for (let i = 0; raiseToCents != null && raiseToCents > 100 && i < 60; i++) {
      if (!clears(raiseToCents - 100)) break
      raiseToCents -= 100
    }
  }
  return { under, raiseToCents }
}
