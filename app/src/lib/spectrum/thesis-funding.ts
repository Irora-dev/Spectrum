import type { Address } from 'viem'
import { chainCfg } from '../chain/chains'
import { deploymentFor, settlementDecimalsFor } from '../chain/deployments'
import { clientFor } from '../chain/rpc'
import { erc20BalanceAbi } from './abis-v2'
import { FundingPlanContractError, type ChainNeed } from './funding-plan'
import type { LegFunding, PerChainFunds } from './thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// THESIS FUNDING — the direct route's inventory + shortfall stage (module 1 of
// the thesis run; the seam is thesis-run-types.ts). Per chain it answers two
// questions the sequencer needs before anything is signed: what does the wallet
// already hold there (readThesisFunds), and what must therefore travel where
// (legFundings)?
//
// It inherits funding-plan's laws wholesale rather than restating its own:
//   · money in integer CENTS, gas in native WEI, never mixed;
//   · unreadable is NOT zero — a failed read omits/refuses by name (law 5);
//   · every drawn cent is tracked, so two legs can never be promised the same
//     dollars (law 2's conservation, applied to the surplus ledger here);
//   · an ambiguous or unreadable money INPUT is OUR bug and throws
//     (FundingPlanContractError — reused, not cloned, so one error class
//     means "the caller composed money wrong" everywhere);
//   · a bridge SOURCE must be able to pay for its own send (M8,
//     funding-plan.ts:427-441): moving money out of a chain is a transaction
//     ON that chain.
// Unlike buildFundingPlan this stage is single-asset (settlement token only)
// and one-bridge-per-leg — the direct route's whole point is that a leg is one
// swapExactIn, so its funding is one number.
// ─────────────────────────────────────────────────────────────────────────────

/** Settlement decimals come from the deployment book, PER CHAIN (cold-review
 *  INFO-1, 2026-08-16: the old local `= 6` silently mis-scaled every
 *  conversion if a non-6dp settlement token were ever wired). Config, not an
 *  on-chain probe, so these reads stay sync — the runner verifies the config
 *  against the chain's own decimals() before any money moves. */
const centsDivisorFor = (chainId: number): bigint => 10n ** BigInt(settlementDecimalsFor(chainId) - 2)

/** Unit budget for ONE leg's steps on its chain (approve + swapExactIn).
 *
 *  ⚠ SIZED TO THE BUY'S OWN SIGNING REQUIREMENT (audit G1, 2026-08-14 —
 *  MEDIUM, recoverable fund-stranding). The old figure was a fixed 1.6M:
 *  gas.ts's 1.5M floor + 100k approve. But the buy's REAL gas limit is
 *  max(2×estimate, 1.5M) (gasWithHeadroom), and an EIP-1559 transaction needs
 *  balance ≥ gasLimit × maxFee just to SIGN — a multi-leg basket estimating
 *  past 800k doubles past 1.6M, so the refuel under-covered exactly the
 *  no-gas-on-that-chain user it exists for, stranding freshly bridged funds
 *  until a manual top-up. The budget now covers the DOUBLED estimate's
 *  worst plausible case (the 2× headroom law's own ceiling for a deep
 *  basket, ~1.5M×2) plus the approve, and the price side carries the ×2
 *  fee-drift headroom refuel.ts already applies (a bridge takes minutes;
 *  EIP-1559 fees move) — divergent sibling budgets were the G1 finding's
 *  compounding half, so this constant now states BOTH halves in one place. */
export const THESIS_LEG_GAS_UNITS = 3_100_000n
/** Fee-drift headroom multiplier on the gas PRICE side (refuel.ts's own ×2:
 *  the fee can rise while the bridge is in flight; unused gas refunds). */
export const THESIS_GAS_DRIFT_X = 2n

/** A gas-only refuel still needs a real transfer to ride (funding-plan law 3 /
 *  self-audit A4: a zero-amount bridge is not executable), so it carries this
 *  minimal amount. The dollar is not a fee — it lands as the user's own
 *  settlement balance on the destination. */
export const CARRIER_CENTS = 100

/**
 * Read each chain's spendable state, fresh, in parallel.
 *
 * A chain whose settlement or native balance CANNOT be read is OMITTED from
 * the result — absent ≠ zero, and legFundings turns the absence into a named
 * refusal rather than planning against a guess. A failed GAS PRICE read keeps
 * the chain (its balances are real) with gasNeedRaw = null, never 0n:
 * unreadable must not read as free (funding-plan law 5).
 */
export async function readThesisFunds(chainIds: number[], holder: Address): Promise<PerChainFunds[]> {
  const rows = await Promise.all(chainIds.map((chainId) => readChainFunds(chainId, holder)))
  return rows.filter((r): r is PerChainFunds => r != null)
}

async function readChainFunds(chainId: number, holder: Address): Promise<PerChainFunds | null> {
  try {
    const usdc = deploymentFor(chainId).usdc
    // No configured settlement token = we cannot read what matters; the chain
    // is absent, not zero-funded.
    if (!usdc) return null
    const client = clientFor(chainId)
    const [usdcRaw, nativeRaw] = await Promise.all([
      client.readContract({ address: usdc, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [holder] }),
      client.getBalance({ address: holder }),
    ])
    const gasNeedRaw = await client
      .getGasPrice()
      .then((price) => price * THESIS_LEG_GAS_UNITS * THESIS_GAS_DRIFT_X)
      .catch(() => null)
    return { chainId, usdcRaw, usdcCents: rawToCents(usdcRaw, chainId), nativeRaw, gasNeedRaw }
  } catch {
    // Balance read failed (or the chain has no client at all) — each chain's
    // failure is its own; the others still report.
    return null
  }
}

/** Floor raw settlement units (the chain's OWN decimals) to integer cents.
 *  Clamped UNDER on the absurd tail (> 2^53 cents ≈ $90T): a Number()
 *  conversion up there can round UP, and overstating what the user holds is
 *  the one direction plan math must never err in. */
function rawToCents(raw: bigint, chainId: number): number {
  const cents = raw / centsDivisorFor(chainId)
  return cents > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(cents)
}

/**
 * Net each leg's need against the wallet's per-chain inventory and decide, per
 * leg, the ONE bridge (if any) that makes it runnable.
 *
 * Pure and deterministic: needs are processed in input order, and EVERY input
 * need appears in the output exactly once — a leg that cannot run says why in
 * plain words (note + gasOk=false) instead of disappearing.
 *
 * Shortfalls are funded from the chain with the largest FREE surplus, where
 * free = usdcCents − that chain's own need (when it is also a leg) − cents
 * already promised to earlier legs in this call. The draw ledger is what stops
 * two legs counting the same dollars. A leg's whole shortfall comes from one
 * source (LegFunding carries one bridge); if no single chain can cover it, the
 * leg refuses with the missing dollars named.
 *
 * @throws FundingPlanContractError on unreadable money inputs or duplicated
 *         chain rows — our code composed the call wrong, and a quiet resolution
 *         of an ambiguous money input is a double-spend (funding-plan's law).
 */
export function legFundings(needs: ChainNeed[], funds: PerChainFunds[]): LegFunding[] {
  assertContract(needs, funds)

  const fundsById = new Map(funds.map((f) => [f.chainId, f]))
  // Every leg chain's own total need is reserved out of that chain's surplus
  // unconditionally — even for a leg that ends up refusing. Conservative on
  // purpose: releasing a refused leg's reservation would let its dollars fund
  // a sibling, and a later retry of the refused leg would find them gone.
  const needTotalById = new Map(needs.map((n) => [n.chainId, whole(n.buysCents) + whole(n.feeCents)]))
  const drawnFrom = new Map<number, number>()

  const freeSurplus = (f: PerChainFunds): number =>
    whole(f.usdcCents) - (needTotalById.get(f.chainId) ?? 0) - (drawnFrom.get(f.chainId) ?? 0)

  // A source must hold the money free AND be able to pay for the send: a
  // bridge out of a chain is a transaction on that chain (M8), so a source
  // whose gas is unreadable or unpayable is no source. THESIS_LEG_GAS_UNITS
  // over-sizes a bridge send — the same safe-side reuse funding-plan's M8
  // check makes of its own per-chain estimate.
  const canSend = (f: PerChainFunds): boolean => f.gasNeedRaw != null && f.nativeRaw >= f.gasNeedRaw
  const pickSource = (
    legChainId: number,
    amountCents: number,
  ): { fromChainId: number } | { whyNot: 'no-money' | 'no-send-gas' | 'committed' } => {
    let best: PerChainFunds | null = null
    let moneyExistedSomewhere = false
    // ⚠⚠ "COMMITTED" IS A DIFFERENT ANSWER FROM "NO MONEY", and conflating them
    // told the owner he had none when he had thousands (2026-08-16: "why did the
    // bridging/routing for this basket just not happen"). `freeSurplus` is
    // balance MINUS this chain's own leg — so a wallet that is fully deployed
    // into the very basket being funded has no spare to send, which is not the
    // same fact as an empty wallet and has a completely different remedy.
    // Lowering the amount frees money; "add more" does not describe the world
    // he is in.
    let heldEnoughIgnoringOwnLeg = false
    for (const f of funds) {
      if (f.chainId === legChainId) continue // an inbound refuel is by definition from ANOTHER chain
      if (whole(f.usdcCents) - (drawnFrom.get(f.chainId) ?? 0) >= amountCents) heldEnoughIgnoringOwnLeg = true
      if (freeSurplus(f) < amountCents) continue
      moneyExistedSomewhere = true
      if (!canSend(f)) continue
      // strict >, walking input order: ties resolve to the earliest row, so the
      // same funds always pick the same source
      if (!best || freeSurplus(f) > freeSurplus(best)) best = f
    }
    if (best) return { fromChainId: best.chainId }
    if (moneyExistedSomewhere) return { whyNot: 'no-send-gas' }
    return { whyNot: heldEnoughIgnoringOwnLeg ? 'committed' : 'no-money' }
  }
  const draw = (fromChainId: number, cents: number) => drawnFrom.set(fromChainId, (drawnFrom.get(fromChainId) ?? 0) + cents)

  return needs.map((n): LegFunding => {
    const needCents = whole(n.buysCents) + whole(n.feeCents)
    const w = chainWords(n.chainId)
    const f = fundsById.get(n.chainId)

    if (!f) {
      return {
        chainId: n.chainId,
        needCents,
        haveCents: 0,
        shortfallCents: needCents,
        bridge: null,
        gasOk: false,
        note: `Could not read balances on ${w.name}, so this leg cannot be planned. Nothing is sent there.`,
      }
    }

    const haveCents = whole(f.usdcCents)
    const shortfallCents = Math.max(0, needCents - haveCents)
    const base = { chainId: n.chainId, needCents, haveCents, shortfallCents }

    // Law 5 outranks the money routing: a chain whose fee cannot be sized is
    // one we cannot promise executes, so no money is aimed at it — bridging
    // first and refusing later would strand the bridged dollars there.
    if (f.gasNeedRaw == null) {
      return {
        ...base,
        bridge: null,
        gasOk: false,
        noteCode: 'gas-unsized' as const,
        note: `We could not estimate the network fee on ${w.name}, so we cannot promise this leg's transactions will go through. Nothing is sent there.`,
      }
    }

    const gasDeficitWei = f.nativeRaw < f.gasNeedRaw ? f.gasNeedRaw - f.nativeRaw : 0n

    if (shortfallCents > 0) {
      const src = pickSource(n.chainId, shortfallCents)
      if ('whyNot' in src) {
        return {
          ...base,
          bridge: null,
          // gasOk stays a fact about THIS chain's fees, independent of the
          // money refusal — with no bridge to ride, a gas deficit is unmet.
          gasOk: gasDeficitWei === 0n,
          // NAME THE CURRENCY, THEN THE FIX (rehearsal 2026-08-13: a wallet
          // holding only ETH on all three chains read "needs $13 more on
          // Robinhood" as a bug, because every chain here shows a healthy
          // native balance). A leg spends its chain's SETTLEMENT token — the
          // native coin only pays the fee — so a shortfall sentence that omits
          // the symbol describes money the reader thinks they already have.
          // Both halves are stated: what is short, and what to do about it.
          noteCode: 'needs-funds' as const,
          noteShortCents: shortfallCents,
          note:
            src.whyNot === 'committed'
              ? `Needs ${usd(shortfallCents)} more on ${w.name}. Your other networks do hold enough, but it is already committed to this basket's own legs there, so nothing is spare to send across. Sell something to cover it, or lower the amount.`
              : src.whyNot === 'no-money'
                ? `Needs ${usd(shortfallCents)} more on ${w.name}; no other network holds enough to cover it. This leg spends ${w.settlement}, and ${w.gas} on ${w.name} only pays the network fee. Add ${w.settlement} on ${w.name}, or lower the amount.`
                : `Needs ${usd(shortfallCents)} more on ${w.name}; the networks holding enough cannot pay their own fee to send it. This leg spends ${w.settlement}, so add ${w.settlement} on ${w.name}, or lower the amount.`,
        }
      }
      draw(src.fromChainId, shortfallCents)
      // the owner's day-1 rule: a gas deficit rides the money bridge as
      // fromAmountForGas — reported here in wei; the bridge hook owns the
      // wei→from-units conversion. 0n = the chain pays its own fees.
      return {
        ...base,
        bridge: { fromChainId: src.fromChainId, amountCents: shortfallCents, refuelWeiNeeded: gasDeficitWei },
        gasOk: true,
        note: null,
      }
    }

    if (gasDeficitWei === 0n) return { ...base, bridge: null, gasOk: true, note: null }

    // Gas-only deficit: the money is already home, but a refuel cannot travel
    // alone (a zero-amount bridge is unexecutable — law 3/A4), so a minimal
    // carrier delivers it.
    const src = pickSource(n.chainId, CARRIER_CENTS)
    if ('whyNot' in src) {
      return {
        ...base,
        bridge: null,
        gasOk: false,
        // 'gas-short' was DECLARED in the union + whitelisted by the run-store
        // sanitizer but emitted by nothing (audit 2026-08-16) — the doors keyed
        // on it were structurally dead. This is its one producer.
        noteCode: 'gas-short' as const,
        note: `${w.name} needs ${w.gas} for network fees and no other network can carry it in, so this leg needs you to already hold ${w.gas} on ${w.name}.`,
      }
    }
    draw(src.fromChainId, CARRIER_CENTS)
    return {
      ...base,
      bridge: { fromChainId: src.fromChainId, amountCents: CARRIER_CENTS, refuelWeiNeeded: gasDeficitWei },
      gasOk: true,
      note: `Bridges ${usd(CARRIER_CENTS)} from ${chainWords(src.fromChainId).name} only so ${w.gas} for fees can ride along — it still lands as your ${w.settlement} on ${w.name}.`,
    }
  })
}

// ── the input contract (loud, never absorbed — funding-plan's posture) ───────
// Exported: thesis-pay-asset.ts composes against the same needs/funds inputs
// and must refuse the same garbage the same way — one contract, not a clone.

export function assertContract(needs: ChainNeed[], funds: PerChainFunds[]): void {
  const dupNeed = firstDuplicate(needs.map((n) => n.chainId))
  if (dupNeed != null)
    throw new FundingPlanContractError(
      `chain ${dupNeed} appears twice in the needs — sum them before planning; two rows would fund that leg twice`,
    )
  const dupFund = firstDuplicate(funds.map((f) => f.chainId))
  if (dupFund != null)
    throw new FundingPlanContractError(
      `chain ${dupFund} appears twice in the funds — merge the rows; two rows for one chain would promise its balance twice`,
    )
  for (const n of needs) {
    money('buysCents', n.chainId, n.buysCents)
    money('feeCents', n.chainId, n.feeCents)
  }
  for (const f of funds) {
    money('usdcCents', f.chainId, f.usdcCents)
    wei('usdcRaw', f.chainId, f.usdcRaw)
    wei('nativeRaw', f.chainId, f.nativeRaw)
    if (f.gasNeedRaw != null) wei('gasNeedRaw', f.chainId, f.gasNeedRaw)
  }
}

function money(label: string, chainId: number, v: unknown): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new FundingPlanContractError(
      `chain ${chainId}'s ${label} is ${String(v)}, which is not an amount of money — refusing to plan against a number we cannot read`,
    )
}

function wei(label: string, chainId: number, v: unknown): void {
  if (typeof v !== 'bigint' || v < 0n)
    throw new FundingPlanContractError(
      `chain ${chainId}'s ${label} is ${String(v)}, which is not a raw balance — refusing to plan against a number we cannot read`,
    )
}

/** funding-plan's whole(): validated values may still be fractional cents;
 *  plan math floors them so the ledger stays in integers. */
const whole = (n: number) => Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))

/** A missing amount ROUNDS UP, always (funding-plan's usdShortfall law): the
 *  number in a shortfall sentence must be enough to actually fix it. */
const usd = (cents: number) => `$${Math.ceil(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

function firstDuplicate(ids: number[]): number | null {
  const seen = new Set<number>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return null
}

/** The words a sentence about a chain needs, from the operator's own book —
 *  never hardcoded. The fallback keeps this module total: a need row for a
 *  chain outside the book must produce its refusal sentence, not a throw
 *  while composing it. (Exported for thesis-pay-asset.ts — its refusals must
 *  speak in the same words, not a re-derivation that drifts.) */
export function chainWords(chainId: number): { name: string; gas: string; settlement: string } {
  try {
    const cfg = chainCfg(chainId)
    return { name: cfg.name, gas: cfg.viemChain.nativeCurrency.symbol, settlement: cfg.usdcSymbol }
  } catch {
    return { name: `network ${chainId}`, gas: 'gas', settlement: 'funds' }
  }
}
