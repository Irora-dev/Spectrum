import type { Address } from 'viem'
import { showSymbol } from './safe-copy'
import { isTerminalCowStatus } from './cow'
import type { PendingOrder } from './cow-pending'

// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS ALREADY SPOKEN FOR, AND WHAT TO APPROVE (owner 2026-08-02: "do all to
// the best design and security practices, for maximum safety").
//
// These two live in ONE module on purpose. An ERC-20 allowance is a SINGLE
// number per (owner, token, spender) — it is not per order. So "approve exactly
// this order's amount" is not merely imprecise, it is a BUG: it would lower the
// allowance below what an already-open order needs and silently break it. The
// only correct input to an approval is the TOTAL still owed across every open
// order, which is what the ledger here computes. Splitting these into two
// modules is what would let them drift apart.
//
// Everything is pure and integer-only. No React, no chain calls, no floats.
// ─────────────────────────────────────────────────────────────────────────────

/** `${chainId}:${lowercased token}` — the same keying convention exposure.ts
 *  uses, so Base WETH and mainnet WETH can never be summed together. */
export type TokenKey = string

export const tokenKey = (chainId: number, token: Address): TokenKey =>
  `${chainId}:${token.toLowerCase()}`

export interface Commitment {
  chainId: number
  token: Address
  symbol: string
  decimals: number
  /** Still owed to open orders: for a partially filled order this is the
   *  REMAINDER, not the original size. A half-filled order only needs its other
   *  half, and treating it as whole would over-approve and overstate what the
   *  user has locked up. */
  committedRaw: bigint
  /** How many open orders make up this total, for "committed to N orders". */
  orderCount: number
}

/**
 * Total still owed per token across every WORKING order.
 *
 * Terminal orders commit nothing — a filled, expired or cancelled order has no
 * further claim on the balance, and counting it would permanently inflate the
 * figure.
 */
export function commitmentsByToken(orders: PendingOrder[]): Map<TokenKey, Commitment> {
  const out = new Map<TokenKey, Commitment>()
  for (const o of orders) {
    if (isTerminalCowStatus(o.status)) continue
    // Guard the subtraction: a surplus fill can report executed > signed, and an
    // unsigned bigint underflow would produce an astronomically large number.
    const remaining = o.executedSellRaw >= o.sellAmountRaw ? 0n : o.sellAmountRaw - o.executedSellRaw
    if (remaining <= 0n) continue
    const k = tokenKey(o.chainId, o.sellToken)
    const cur = out.get(k)
    if (cur) {
      out.set(k, { ...cur, committedRaw: cur.committedRaw + remaining, orderCount: cur.orderCount + 1 })
    } else {
      out.set(k, {
        chainId: o.chainId,
        token: o.sellToken,
        symbol: o.sellSymbol,
        decimals: o.sellDecimals,
        committedRaw: remaining,
        orderCount: 1,
      })
    }
  }
  return out
}

/** How much of one token is spoken for. Zero when nothing is open. */
export function committedOf(orders: PendingOrder[], chainId: number, token: Address): bigint {
  return commitmentsByToken(orders).get(tokenKey(chainId, token))?.committedRaw ?? 0n
}

export interface BalanceRead {
  /** What the wallet actually holds, raw. */
  balanceRaw: bigint
  /** Already spoken for by open orders, raw. */
  committedRaw: bigint
  /** Free to commit to something new. Never negative. */
  freeRaw: bigint
  /** True when open orders already exceed the balance. */
  overCommitted: boolean
}

export function readBalance(balanceRaw: bigint, committedRaw: bigint): BalanceRead {
  const free = balanceRaw > committedRaw ? balanceRaw - committedRaw : 0n
  return { balanceRaw, committedRaw, freeRaw: free, overCommitted: committedRaw > balanceRaw }
}

/**
 * WARN, DO NOT BLOCK, when a new order would over-commit.
 *
 * Over-committing is frequently DELIBERATE: "sell at 4,500 or at 5,000,
 * whichever comes first" is a normal ladder where only one leg is meant to fill.
 * Blocking it would break a real strategy to prevent something that is not even
 * a loss — an under-funded order simply fails to settle and nothing moves.
 *
 * Returns null when there is nothing to say.
 */
export function overCommitWarning(
  read: BalanceRead,
  addingRaw: bigint,
  symbol: string,
): string | null {
  const total = read.committedRaw + addingRaw
  if (total <= read.balanceRaw) return null
  if (read.committedRaw === 0n) {
    return `This order is for more ${showSymbol(symbol)} than the wallet holds, so it can only fill up to the balance.`
  }
  return `Your open orders would then claim more ${showSymbol(symbol)} than the wallet holds. That is fine if only one is meant to fill, but they cannot all complete.`
}

// ── APPROVALS ────────────────────────────────────────────────────────────────

/**
 * Tokens whose `approve` REVERTS when moving from one non-zero allowance to
 * another, so the allowance must be zeroed first.
 *
 * A known-address list rather than a probe, because the quirk is not detectable
 * through any interface. Mainnet USDT is the canonical case. Keyed the same way
 * as everything else so a bridged token on another chain is a separate entry and
 * is never assumed to share the behaviour of its mainnet namesake — that
 * assumption is exactly how a "safe" list becomes wrong.
 */
export const ZERO_FIRST_TOKENS: ReadonlySet<TokenKey> = new Set([
  tokenKey(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7'), // USDT, mainnet
])

export type ApprovalPlan =
  /** The existing allowance already covers everything. Do nothing. */
  | { kind: 'none'; requiredRaw: bigint }
  /** One approve, to the total required. */
  | { kind: 'approve'; requiredRaw: bigint }
  /** Two transactions: zero the allowance, then set it. See ZERO_FIRST_TOKENS. */
  | { kind: 'reset-then-approve'; requiredRaw: bigint }

/**
 * What approval a new order needs, given what is already committed.
 *
 * THE RULE THAT MATTERS: the target is `committed + adding`, never `adding`
 * alone. Approving just the new order's size would set the allowance BELOW what
 * open orders already rely on and break them.
 *
 * This function also never proposes LOWERING an allowance. A larger existing
 * allowance is left exactly as it is: reducing it is a separate, deliberate act
 * (see `revokePlan`), not a side effect of placing an order.
 */
export function planApproval(args: {
  currentAllowanceRaw: bigint
  committedRaw: bigint
  addingRaw: bigint
  chainId: number
  token: Address
}): ApprovalPlan {
  const requiredRaw = args.committedRaw + args.addingRaw
  if (args.currentAllowanceRaw >= requiredRaw) return { kind: 'none', requiredRaw }
  const zeroFirst =
    ZERO_FIRST_TOKENS.has(tokenKey(args.chainId, args.token)) && args.currentAllowanceRaw > 0n
  return { kind: zeroFirst ? 'reset-then-approve' : 'approve', requiredRaw }
}

/**
 * A standing allowance with nothing open behind it.
 *
 * An approval OUTLIVES the order that needed it: when a limit order expires
 * unfilled, the allowance it required is still sitting there granting a spender
 * rights over the balance. Surfacing that is the difference between least
 * privilege as a principle and least privilege in practice.
 *
 * Never automatic. Revoking costs gas and is the user's call.
 */
export function revokePlan(currentAllowanceRaw: bigint, committedRaw: bigint): { suggest: boolean; reason?: string } {
  if (currentAllowanceRaw <= 0n) return { suggest: false }
  if (committedRaw > 0n) return { suggest: false }
  return {
    suggest: true,
    reason: 'No open orders need this approval any more. Revoking it costs a transaction and removes the standing permission.',
  }
}
