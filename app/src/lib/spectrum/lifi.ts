// ─────────────────────────────────────────────────────────────────────────────
// LiFi hub leg — the external swap router for chains with NO canonical Uniswap
// periphery (Robinhood 4663). Tokens there pool on the V4 PoolManager, but a
// wallet cannot call the PoolManager directly (unlock-callback architecture) and
// Uniswap has not deployed its router periphery on 4663 — the ONLY verified
// router contract on the chain is LiFi's diamond (`LiFiDiamond`, source verified
// on RH Blockscout; every other active router there is anonymous bytecode).
//
// So on these chains the any-asset → settlement hop (the same job SwapRouter02
// does on Base/Ethereum) quotes and executes through LiFi's public API:
//   GET li.quest/v1/quote → { estimate, transactionRequest }
//   approve fromToken to estimate.approvalAddress (ERC-20 pay only)
//   send transactionRequest verbatim → measure delivery from receipt logs
// The basket leg is UNTOUCHED: it still recomputes its floors off the MEASURED
// settlement amount and rides Spectrum's own protected router.
//
// Trust posture: LiFi is a widely-audited aggregator and the target contract is
// source-verified; the response is still treated as hostile input — the guards
// below reject any quote whose execution target ≠ its own approval spender,
// whose echoed route ≠ what we asked, or whose value ≠ the ETH we offered.
// ─────────────────────────────────────────────────────────────────────────────

import type { Address, Hex } from 'viem'

const LIFI_API = 'https://li.quest/v1/quote'

// ── the execution-target allowlist (redteam 2026-07-29, F-4) ────────────────
// The guards below pin the PAIR, the SIZE, the CHAINS and the VALUE, and they
// pin approvalAddress === tx.to — but until this constant existed nothing
// pinned WHICH contract. A hostile response body (a li.quest compromise, a
// rogue operator, a TLS/DNS break, a malicious extension) could therefore
// hand us any {to, data} and we would approve it and send it FROM the user's
// EOA: `transfer(attacker, balance)` on any token they hold, unbounded by the
// trade size. Pinning the target collapses that to "a call into a known
// contract with hostile arguments, capped by the exact approval we grant".
//
// Values are EVIDENCE, not lore: probed live 2026-07-29 across 10 route
// shapes and 4 different routing tools (fly/okx/nordstern/across) via
// `app/scripts/lifi-target-probe.ts`; every route on a given SOURCE chain
// returned exactly one target, and it always equalled the approval spender.
// Keyed by SOURCE chain — that is where the transaction is signed.
// A chain absent here has NO LiFi path: fail closed, never fall through.
// If LiFi migrates a diamond this refuses routes until the constant is
// updated — deliberate for a money path; re-run the probe to refresh.
const LIFI_TARGETS: Record<number, string> = {
  1: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
  8453: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
  4663: '0xb477751b76cf82d00a686a1232f5fcd772414af3',
}

/** Is a LiFi route even offerable from this chain? (No pinned target = no.) */
export function lifiSupportsChain(chainId: number): boolean {
  return LIFI_TARGETS[chainId] != null
}

/** LiFi's sentinel for the chain's native asset (ETH on 4663). */
export const LIFI_NATIVE = '0x0000000000000000000000000000000000000000' as Address

export interface LifiQuote {
  /** Human tool name LiFi routed through (display only, e.g. "rialto"). */
  tool: string
  /** Estimated delivery, raw toToken decimals. */
  toAmount: bigint
  /** The router-enforced floor, raw toToken decimals. */
  toAmountMin: bigint
  /** The spender the payer must approve (ERC-20 pay); always the execution target. */
  approvalAddress: Address
  /** The transaction to send verbatim. */
  tx: { to: Address; data: Hex; value: bigint; gasLimit: bigint | null }
  /** True when settlement is asynchronous (see fetchLifiStatus). */
  crossChain?: boolean
}

export class LifiQuoteError extends Error {}

const ADDR = /^0x[0-9a-fA-F]{40}$/

/**
 * One same-chain quote: `fromToken` → `toToken` for `fromAmount` raw units.
 * `slippageBps` maps to LiFi's fractional slippage. Throws LifiQuoteError with
 * an honest message on no-route/failure — callers surface it, never guess.
 */
export async function fetchLifiQuote(args: {
  chainId: number
  fromToken: Address
  toToken: Address
  fromAmount: bigint
  fromAddress: Address
  slippageBps: number
  /** CROSS-CHAIN pay side (owner 2026-07-29). Omit for a same-chain swap — every
   *  existing caller does, and gets byte-identical behaviour. When set, the route
   *  starts on `fromChainId` and DELIVERS on `chainId`, which makes settlement
   *  ASYNCHRONOUS: the source-chain receipt says nothing about arrival, so a
   *  caller MUST track delivery with `fetchLifiStatus` before it can treat the
   *  funds as usable. */
  fromChainId?: number
  signal?: AbortSignal
}): Promise<LifiQuote> {
  const fromChainId = args.fromChainId ?? args.chainId
  const q = new URLSearchParams({
    fromChain: String(fromChainId),
    toChain: String(args.chainId),
    fromToken: args.fromToken,
    toToken: args.toToken,
    fromAmount: args.fromAmount.toString(),
    fromAddress: args.fromAddress,
    // Pin the recipient explicitly rather than relying on the service's
    // default-to-sender (F-5): asking for it is what makes the echo check
    // below meaningful.
    toAddress: args.fromAddress,
    slippage: (args.slippageBps / 10_000).toString(),
  })
  let res: Response
  try {
    res = await fetch(`${LIFI_API}?${q}`, { headers: { Accept: 'application/json' }, signal: args.signal })
  } catch (e) {
    if (args.signal?.aborted) throw e
    throw new LifiQuoteError('The swap-routing service is unreachable — try again in a moment.')
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !body) {
    const msg = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`
    throw new LifiQuoteError(`No route for this swap right now (${msg}).`)
  }
  return parseLifiQuote(body, { ...args, fromChainId })
}

/** Pure parse + hostile-input guards (unit-tested; fetch-free). */
export function parseLifiQuote(
  body: Record<string, unknown>,
  asked: {
    chainId: number
    fromToken: Address
    toToken: Address
    fromAmount: bigint
    /** Source chain; defaults to `chainId` (same-chain swap). */
    fromChainId?: number
    /** The payer — proceeds must be delivered here (F-5). Omit only in tests
     *  that predate the check; a real caller always has it. */
    fromAddress?: Address
  },
): LifiQuote {
  const est = body.estimate as Record<string, unknown> | undefined
  const tx = body.transactionRequest as Record<string, unknown> | undefined
  const action = body.action as Record<string, unknown> | undefined
  if (!est || !tx) throw new LifiQuoteError('Malformed route response (no estimate/transaction).')

  const approvalAddress = String(est.approvalAddress ?? '')
  const to = String(tx.to ?? '')
  if (!ADDR.test(approvalAddress) || !ADDR.test(to)) throw new LifiQuoteError('Malformed route response (addresses).')
  // The execution target must BE the approval spender — one audited entity holds
  // both roles (the LiFi diamond). A response splitting them is rejected.
  if (approvalAddress.toLowerCase() !== to.toLowerCase())
    throw new LifiQuoteError('Route response rejected: execution target does not match the approval spender.')

  // …and that entity must be the KNOWN target for the chain we are signing on
  // (F-4). Fail closed on an unlisted chain.
  const signingChain = asked.fromChainId ?? asked.chainId
  const pinned = LIFI_TARGETS[signingChain]
  if (!pinned)
    throw new LifiQuoteError('No verified swap-routing contract is pinned for this network.')
  if (to.toLowerCase() !== pinned)
    throw new LifiQuoteError('Route response rejected: unrecognised execution target.')

  // The echoed route must be exactly what we asked (same chain, same pair, same size).
  const aFrom = action?.fromToken as Record<string, unknown> | undefined
  const aTo = action?.toToken as Record<string, unknown> | undefined
  // Cross-chain widens WHICH chains are legal, never the strictness: both ends
  // must still echo exactly what we asked for.
  const askedFromChain = asked.fromChainId ?? asked.chainId
  // The proceeds must be delivered to the payer (F-5). This is a verifiable
  // ECHO, not proof: the calldata itself is opaque to us, so an honest router
  // executing a hostile `receiver` argument cannot be caught client-side. That
  // limit is real — write it down rather than imply it away.
  if (
    asked.fromAddress &&
    String(action?.toAddress ?? '').toLowerCase() !== asked.fromAddress.toLowerCase()
  ) {
    throw new LifiQuoteError('Route response rejected: it does not deliver to your wallet.')
  }
  if (
    Number(action?.fromChainId) !== askedFromChain ||
    Number(action?.toChainId) !== asked.chainId ||
    String(aFrom?.address ?? '').toLowerCase() !== asked.fromToken.toLowerCase() ||
    String(aTo?.address ?? '').toLowerCase() !== asked.toToken.toLowerCase() ||
    String(action?.fromAmount ?? '') !== asked.fromAmount.toString()
  ) {
    throw new LifiQuoteError('Route response rejected: it does not match the requested swap.')
  }

  const toAmount = BigInt(String(est.toAmount ?? '0'))
  const toAmountMin = BigInt(String(est.toAmountMin ?? '0'))
  if (toAmountMin <= 0n || toAmount <= 0n) throw new LifiQuoteError('Route quoted zero output.')

  const value = BigInt(String(tx.value ?? '0x0'))
  // Native pay: the transaction may carry exactly the ETH we offered, never more.
  const isNative = asked.fromToken.toLowerCase() === LIFI_NATIVE
  if (isNative ? value !== asked.fromAmount : value !== 0n)
    throw new LifiQuoteError('Route response rejected: unexpected transaction value.')

  const gasRaw = tx.gasLimit != null ? BigInt(String(tx.gasLimit)) : null
  const data = String(tx.data ?? '')
  if (!data.startsWith('0x') || data.length < 10) throw new LifiQuoteError('Malformed route response (calldata).')

  return {
    tool: String(body.tool ?? 'LiFi'),
    toAmount,
    toAmountMin,
    approvalAddress: approvalAddress as Address,
    tx: { to: to as Address, data: data as Hex, value, gasLimit: gasRaw },
    // A cross-chain route does NOT settle in the signed transaction — the caller
    // must poll fetchLifiStatus before spending the proceeds.
    crossChain: askedFromChain !== asked.chainId,
  }
}

// ── delivery tracking (cross-chain only) ─────────────────────────────────────
// A same-chain swap settles in the transaction we signed, so its receipt is the
// whole truth. A cross-chain route does not: the source tx only STARTS it, and
// arrival on the destination chain happens later (seconds to minutes). This is
// the honest read of "did my money land yet", and it is the reason a cross-chain
// pay side is a two-phase flow rather than a wider dropdown.

export type LifiDelivery =
  | { state: 'pending' }
  /** Landed. `toAmount` is what actually ARRIVED (may differ from the quote). */
  | { state: 'done'; toAmount: bigint }
  /** The bridge refunded on the SOURCE chain — the user keeps their funds there. */
  | { state: 'refunded' }
  | { state: 'failed'; reason: string }
  /** The status service could not answer — retry, never a verdict. */
  | { state: 'unknown' }

const LIFI_STATUS = 'https://li.quest/v1/status'

/** Poll one cross-chain transfer by its SOURCE-chain tx hash. Never throws:
 *  an unreachable service is 'unknown', which callers must treat as retryable
 *  rather than as a failure (declaring a live transfer dead is the worst
 *  possible lie here). */
export async function fetchLifiStatus(args: {
  txHash: Hex
  fromChainId: number
  toChainId: number
  signal?: AbortSignal
}): Promise<LifiDelivery> {
  const q = new URLSearchParams({
    txHash: args.txHash,
    fromChain: String(args.fromChainId),
    toChain: String(args.toChainId),
  })
  try {
    const res = await fetch(`${LIFI_STATUS}?${q}`, { headers: { Accept: 'application/json' }, signal: args.signal })
    if (!res.ok) return { state: 'unknown' }
    const body = (await res.json()) as Record<string, unknown> | null
    return parseLifiStatus(body)
  } catch {
    return { state: 'unknown' }
  }
}

/** Pure parse of a status body (unit-tested; fetch-free). */
export function parseLifiStatus(body: Record<string, unknown> | null): LifiDelivery {
  if (!body) return { state: 'unknown' }
  const status = String(body.status ?? '')
  const substatus = String(body.substatus ?? '')
  if (status === 'DONE') {
    const receiving = body.receiving as Record<string, unknown> | undefined
    const amt = receiving?.amount != null ? BigInt(String(receiving.amount)) : 0n
    // DONE with a partial/refund substatus is NOT a clean delivery.
    if (substatus === 'REFUNDED') return { state: 'refunded' }
    if (amt <= 0n) return { state: 'unknown' }
    return { state: 'done', toAmount: amt }
  }
  if (status === 'FAILED') {
    return { state: 'failed', reason: substatus || 'The transfer failed on the bridge.' }
  }
  if (status === 'PENDING' || status === 'NOT_FOUND') return { state: 'pending' }
  return { state: 'unknown' }
}
