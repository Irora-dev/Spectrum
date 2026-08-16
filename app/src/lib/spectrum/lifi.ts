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
// EXPORTED so the approvals ledger single-sources it (battle-test finding,
// 2026-08-04): allowances.ts kept its own copy of these addresses, and at a
// diamond migration one could update without the other — leaving a standing
// LiFi approval invisible in the ledger that exists to reveal it.
export const LIFI_TARGETS: Record<number, string> = {
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
  /** The route's own gas estimate in USD, as LiFi reports it
   *  (`estimate.gasCosts[].amountUSD` summed — never re-priced here). null
   *  whenever the answer is not WHOLE: no gasCosts, empty, or any entry
   *  unreadable. A partial sum would UNDERSTATE the route's gas and tilt a
   *  net-of-gas comparison toward the aggregator — so callers get the whole
   *  truth or an honest null, which the Phase-3 comparator treats as
   *  'direct wins uncontested' (specallocator B1), never as zero. */
  gasCostUsd: number | null
  /** True when settlement is asynchronous (see fetchLifiStatus). */
  crossChain?: boolean
  /** Native charged ON TOP of `fromAmount` by the route (messaging/relayer
   *  fees, `estimate.feeCosts` with included:false on the signing chain) —
   *  already inside `tx.value`, reconciled byte-exact at parse. 0n when none.
   *  Callers sizing a native spend against a balance must count it: the
   *  wallet will be asked for fromAmount PLUS this. */
  nativeFeeRaw: bigint
  /** The route's own duration estimate, whole seconds (LiFi
   *  `estimate.executionDuration`). null when absent/unreadable — an ETA is
   *  display truth, never a promise, and a missing one stays missing. */
  etaSec: number | null
}

export class LifiQuoteError extends Error {}

const ADDR = /^0x[0-9a-fA-F]{40}$/

export interface LifiQuoteArgs {
  chainId: number
  fromToken: Address
  toToken: Address
  fromAmount: bigint
  fromAddress: Address
  slippageBps: number
  /** Route ordering LiFi optimises for. DEFAULT 'CHEAPEST' (the owner 2026-08-09:
   *  cheapest — that one word is the kit-wide flip). A parameter so a future
   *  surface can differ DELIBERATELY, per call — never by editing the shared
   *  default out from under every other caller. */
  order?: 'CHEAPEST' | 'FASTEST'
  /** CROSS-CHAIN pay side (owner 2026-07-29). Omit for a same-chain swap — every
   *  existing caller does, and gets byte-identical behaviour. When set, the route
   *  starts on `fromChainId` and DELIVERS on `chainId`, which makes settlement
   *  ASYNCHRONOUS: the source-chain receipt says nothing about arrival, so a
   *  caller MUST track delivery with `fetchLifiStatus` before it can treat the
   *  funds as usable. */
  fromChainId?: number
  /** REFUEL (bridging ruling, the owner 2026-08-02): deliver this much of the
   *  bridged amount as destination NATIVE GAS, in fromToken raw units — so a
   *  fresh wallet can sign on arrival. Appended to the query ONLY when > 0:
   *  refuel coverage is not universal per route/tool, and sending the
   *  parameter unconditionally can turn a working route into an error.
   *  (4663 note, probed live 2026-08-02: bridge routes INTO 4663 exist via
   *  Relay, and ETH IS that chain's gas — an ETH-funded bridge needs no
   *  refuel there at all; refuel matters for settlement-denominated bridging
   *  into ETH/Base.) The value is the caller's to compute from
   *  SpectrumContracts' sizing rule (lib/spectrum/refuel.ts) — never a
   *  hardcoded figure, which goes stale and silently under-refuels into the
   *  exact wall this exists to close. KNOWN LIMIT: the quote response carries
   *  no verifiable refuel echo, so a route that silently ignores this
   *  parameter is undetectable client-side — Phase-3 callers must treat
   *  refuel as best-effort and verify DESTINATION NATIVE BALANCE on arrival
   *  before telling the user they can sign. */
  fromAmountForGas?: bigint
  signal?: AbortSignal
}

/** Pure query assembly for the quote endpoint (unit-tested; fetch-free). */
export function buildLifiQuoteQuery(args: Omit<LifiQuoteArgs, 'signal'>): URLSearchParams {
  const q = new URLSearchParams({
    fromChain: String(args.fromChainId ?? args.chainId),
    toChain: String(args.chainId),
    fromToken: args.fromToken,
    toToken: args.toToken,
    fromAmount: args.fromAmount.toString(),
    fromAddress: args.fromAddress,
    // Pin the recipient explicitly rather than relying on the service's
    // default-to-sender (F-5): asking for it is what makes the echo check
    // in parseLifiQuote meaningful.
    toAddress: args.fromAddress,
    slippage: (args.slippageBps / 10_000).toString(),
  })
  // Route order: CHEAPEST unless a surface deliberately differs (the owner
  // 2026-08-09 ruling — cheapest; flipping the kit's preference is this one
  // word, in this one place).
  q.set('order', args.order ?? 'CHEAPEST')
  // WHITE-LABEL LAW: this kit ships origin-less by design, so attribution to
  // LiFi is the OPERATOR'S choice — made only by setting VITE_LIFI_INTEGRATOR
  // in their own deployment env. Absent/empty ⇒ the parameter is OMITTED
  // entirely. NEVER hardcode an identity here: a baked-in integrator would
  // stamp every operator's traffic with someone else's name.
  const integrator: string | undefined = import.meta.env?.VITE_LIFI_INTEGRATOR
  if (typeof integrator === 'string' && integrator.trim() !== '') q.set('integrator', integrator.trim())
  // With refuel set, the quote's toAmount/toAmountMin remain the TOKEN delivery
  // alone — the gas portion rides beside it. A refuel-carrying quote therefore
  // shows a lower toAmount than a bare one for the same fromAmount; that is
  // honest (the gas has value), and quote races must compare like with like.
  if (args.fromAmountForGas != null && args.fromAmountForGas > 0n) {
    q.set('fromAmountForGas', args.fromAmountForGas.toString())
  }
  return q
}

/**
 * One same-chain quote: `fromToken` → `toToken` for `fromAmount` raw units.
 * `slippageBps` maps to LiFi's fractional slippage. Throws LifiQuoteError with
 * an honest message on no-route/failure — callers surface it, never guess.
 */
export async function fetchLifiQuote(args: LifiQuoteArgs): Promise<LifiQuote> {
  const fromChainId = args.fromChainId ?? args.chainId
  const q = buildLifiQuoteQuery(args)
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
  // ── the value check reconciles against the route's OWN fee accounting ──
  // (owner 2026-08-16, live: the RH leg's ETH→USDG conversion died here.
  // Cross-chain tools may charge a native MESSAGING fee ON TOP of fromAmount,
  // disclosed in estimate.feeCosts with included:false — the old strict
  // equality rejected every such honest route, for token pays too, where the
  // fee makes value nonzero. The law is unchanged in spirit: the number the
  // response DISCLOSES must be the number the transaction ASKS FOR, byte-
  // exact. An undisclosed wei of value still rejects.)
  const feeCosts = Array.isArray(est.feeCosts) ? (est.feeCosts as Record<string, unknown>[]) : []
  let nativeFeeRaw = 0n
  for (const f of feeCosts) {
    if (f?.included !== false) continue // included fees already live inside fromAmount
    const tok = f?.token as Record<string, unknown> | undefined
    const addr = String(tok?.address ?? '').toLowerCase()
    if (addr !== LIFI_NATIVE && addr !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') continue
    // a destination-side fee entry never rides THIS transaction's value
    const feeChain = tok?.chainId != null ? Number(tok.chainId) : signingChain
    if (feeChain !== signingChain) continue
    let amt: bigint
    try {
      amt = BigInt(String(f?.amount ?? ''))
    } catch {
      throw new LifiQuoteError('Malformed route response (fee costs).')
    }
    if (amt < 0n) throw new LifiQuoteError('Malformed route response (fee costs).')
    nativeFeeRaw += amt
  }
  const isNative = asked.fromToken.toLowerCase() === LIFI_NATIVE
  // A native "fee" exceeding the principal is not a fee — no honest route
  // charges more to carry the money than the money.
  if (isNative && nativeFeeRaw > asked.fromAmount)
    throw new LifiQuoteError('Route response rejected: its native fee exceeds the amount being sent.')
  const expectedValue = (isNative ? asked.fromAmount : 0n) + nativeFeeRaw
  if (value !== expectedValue)
    throw new LifiQuoteError('Route response rejected: unexpected transaction value.')

  const gasRaw = tx.gasLimit != null ? BigInt(String(tx.gasLimit)) : null
  const data = String(tx.data ?? '')
  if (!data.startsWith('0x') || data.length < 10) throw new LifiQuoteError('Malformed route response (calldata).')

  // Gas in USD as LiFi reports it — whole-or-null (see the interface note).
  // Display/comparison data, not an execution guard: a bad value degrades to
  // null, never throws a route away.
  const gasCosts = Array.isArray(est.gasCosts) ? (est.gasCosts as Record<string, unknown>[]) : null
  let gasCostUsd: number | null = null
  if (gasCosts && gasCosts.length > 0) {
    let sum = 0
    for (const g of gasCosts) {
      const raw = g?.amountUSD
      // Number('') is 0 — an empty string would read as FREE gas, so only a
      // non-empty string or a plain number counts as readable at all.
      const v =
        typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN
      if (!Number.isFinite(v) || v < 0) {
        sum = NaN
        break
      }
      sum += v
    }
    gasCostUsd = Number.isFinite(sum) ? sum : null
  }

  return {
    tool: String(body.tool ?? 'LiFi'),
    toAmount,
    toAmountMin,
    approvalAddress: approvalAddress as Address,
    tx: { to: to as Address, data: data as Hex, value, gasLimit: gasRaw },
    nativeFeeRaw,
    gasCostUsd,
    // A cross-chain route does NOT settle in the signed transaction — the caller
    // must poll fetchLifiStatus before spending the proceeds.
    crossChain: askedFromChain !== asked.chainId,
    etaSec: (() => {
      const d = (est as { executionDuration?: unknown }).executionDuration
      return typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.round(d) : null
    })(),
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
