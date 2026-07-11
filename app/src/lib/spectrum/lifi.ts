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
  signal?: AbortSignal
}): Promise<LifiQuote> {
  const q = new URLSearchParams({
    fromChain: String(args.chainId),
    toChain: String(args.chainId),
    fromToken: args.fromToken,
    toToken: args.toToken,
    fromAmount: args.fromAmount.toString(),
    fromAddress: args.fromAddress,
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
  return parseLifiQuote(body, args)
}

/** Pure parse + hostile-input guards (unit-tested; fetch-free). */
export function parseLifiQuote(
  body: Record<string, unknown>,
  asked: { chainId: number; fromToken: Address; toToken: Address; fromAmount: bigint },
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

  // The echoed route must be exactly what we asked (same chain, same pair, same size).
  const aFrom = action?.fromToken as Record<string, unknown> | undefined
  const aTo = action?.toToken as Record<string, unknown> | undefined
  if (
    Number(action?.fromChainId) !== asked.chainId ||
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
  }
}
