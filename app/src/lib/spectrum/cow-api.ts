import type { Address, Hex } from 'viem'
import {
  buildQuoteRequest,
  cowApiBase,
  orderPostBody,
  type CowChainId,
  type CowOrder,
  type CowOrderStatus,
} from './cow'

// ─────────────────────────────────────────────────────────────────────────────
// THE COW ORDERBOOK CLIENT — the impure half of the rail (owner 2026-08-02:
// "yes lets ship limit orders as the 712").
//
// Keyless by construction: no token, no account, no header. Verified against the
// live service, which answers 200 to an anonymous quote.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE, both learned the hard way in this repo:
//
// 1. A FAILED CALL IS NOT A VERDICT. "The network did not answer" and "the
//    protocol says no" are different facts and are returned as different values.
//    A rebalance that says "no route" when the wifi dropped is a lie that makes
//    users abandon a position.
// 2. NEVER ASSERT A CAUSE WE DID NOT READ. The `0x90bfb865` incident: our
//    fallback message named a cause it had guessed and sent a real user hunting
//    a minimum they had already cleared, and a unit test pinned the guess. Here,
//    an unrecognised `errorType` is surfaced verbatim rather than prettified
//    into a sentence we invented.
// ─────────────────────────────────────────────────────────────────────────────

/** Injected so tests never touch the network and so a caller can pass an
 *  abort-signalled fetch. Defaults to the global. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface CowApiOpts {
  fetchImpl?: FetchLike
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Every outcome of talking to the orderbook, as data. Callers switch on `ok`
 *  and then on `kind` — there is deliberately no thrown error for the "protocol
 *  said no" case, because that is a normal answer, not an exception. */
export type CowResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'rejected'; errorType: string; message: string }
  | { ok: false; kind: 'unreachable'; message: string }

/** Human sentences for the `errorType`s we have actually seen or that CoW
 *  documents. Anything absent from this map is surfaced raw — see rule 2. */
const KNOWN_ERRORS: Record<string, string> = {
  NoLiquidity: 'No route for this pair right now.',
  UnsupportedToken: 'This rail cannot trade one of these tokens.',
  SellAmountDoesNotCoverFee: 'Too small to be worth executing, the costs would eat it.',
  InsufficientBalance: 'Not enough of that token in the wallet.',
  InsufficientAllowance: 'This token still needs approving before it can be sold.',
  InvalidSignature: 'The wallet signature was not accepted.',
  DuplicatedOrder: 'That exact order is already live.',
  InsufficientValidTo: 'The expiry is too soon.',
  ExcessiveValidTo: 'The expiry is too far out.',
  ZeroAmount: 'Amount cannot be zero.',
  SameBuyAndSellToken: 'Cannot trade a token for itself.',
  UnsupportedBuyTokenDestination: 'That destination is not supported.',
}

export function describeCowError(errorType: string, description?: string): string {
  const known = KNOWN_ERRORS[errorType]
  if (known) return known
  // No invented cause. Say what it said, and say that we are quoting it.
  return description?.trim()
    ? `The orderbook refused it: ${description.trim()}`
    : `The orderbook refused it (${errorType}).`
}

async function call<T>(
  url: string,
  init: RequestInit,
  opts: CowApiOpts | undefined,
  parse: (body: unknown) => T,
): Promise<CowResult<T>> {
  const f = opts?.fetchImpl ?? (globalThis.fetch as FetchLike | undefined)
  if (!f) return { ok: false, kind: 'unreachable', message: 'No fetch available in this environment.' }
  let res: Response
  try {
    res = await f(url, {
      ...init,
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (e) {
    // Network error, DNS, CORS, abort. NOT a protocol verdict.
    return { ok: false, kind: 'unreachable', message: e instanceof Error ? e.message : 'Could not reach the orderbook.' }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* an empty or non-JSON body is normal on some 2xx replies */
  }

  if (!res.ok) {
    const b = (body ?? {}) as { errorType?: string; description?: string }
    // A 5xx is the SERVICE failing, not the protocol rejecting. Distinguishing
    // them is the difference between "try again" and "this cannot work".
    if (res.status >= 500 && !b.errorType) {
      return { ok: false, kind: 'unreachable', message: `The orderbook is having trouble (HTTP ${res.status}).` }
    }
    const errorType = b.errorType ?? `http_${res.status}`
    return { ok: false, kind: 'rejected', errorType, message: describeCowError(errorType, b.description) }
  }

  try {
    return { ok: true, value: parse(body) }
  } catch (e) {
    return { ok: false, kind: 'unreachable', message: e instanceof Error ? e.message : 'Unreadable reply.' }
  }
}

export interface CowQuote {
  /** What the solvers say this size fetches right now, raw units. This is the
   *  MARKET reference we show; it is never what we sign. */
  buyAmountRaw: bigint
  /** The sell amount the quote is actually for, which may differ from what was
   *  asked once costs are accounted. */
  sellAmountRaw: bigint
  /** Solver-side costs, informational. */
  feeAmountRaw: bigint
}

/** Ask what the market is. Used to show the user where their limit sits — the
 *  price we SIGN is always the user's own number, never this one. */
export async function fetchCowQuote(
  chainId: CowChainId,
  args: { sellToken: Address; buyToken: Address; owner: Address; receiver?: Address; sellAmountRaw: bigint; appData: Hex },
  opts?: CowApiOpts,
): Promise<CowResult<CowQuote>> {
  return call(
    `${cowApiBase(chainId)}/quote`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildQuoteRequest(args)),
    },
    opts,
    (body) => {
      const q = (body as { quote?: Record<string, string> }).quote
      if (!q?.buyAmount) throw new Error('Quote reply had no price in it.')
      return {
        buyAmountRaw: BigInt(q.buyAmount),
        sellAmountRaw: BigInt(q.sellAmount ?? '0'),
        feeAmountRaw: BigInt(q.feeAmount ?? '0'),
      }
    },
  )
}

/** Post a signed order. Returns its uid, which is the handle for everything
 *  afterwards (status, cancellation, the pending store). */
export async function postCowOrder(
  chainId: CowChainId,
  order: CowOrder,
  owner: Address,
  signature: Hex,
  opts?: CowApiOpts,
): Promise<CowResult<string>> {
  return call(
    `${cowApiBase(chainId)}/orders`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPostBody(order, owner, signature)),
    },
    opts,
    (body) => {
      // The endpoint returns the uid as a bare JSON string.
      const uid = typeof body === 'string' ? body : (body as { uid?: string })?.uid
      if (!uid) throw new Error('The orderbook accepted it but returned no order id.')
      return uid
    },
  )
}

export interface CowOrderState {
  uid: string
  status: CowOrderStatus
  /** How much of the sell side has actually executed. The ONLY honest source of
   *  "how far along is this" — there is no schedule to read progress from. */
  executedSellRaw: bigint
  executedBuyRaw: bigint
  totalSellRaw: bigint
}

/** Read one order's live state. */
export async function fetchCowOrder(
  chainId: CowChainId,
  uid: string,
  opts?: CowApiOpts,
): Promise<CowResult<CowOrderState>> {
  return call(`${cowApiBase(chainId)}/orders/${uid}`, { method: 'GET' }, opts, (body) => {
    const o = body as Record<string, string>
    if (!o?.status) throw new Error('Order reply had no status.')
    return {
      uid,
      status: o.status as CowOrderStatus,
      // `executedSellAmount` INCLUDES fees on some replies; the fee-exclusive
      // figure is what a progress bar should use, so prefer it when present.
      executedSellRaw: BigInt(o.executedSellAmountBeforeFees ?? o.executedSellAmount ?? '0'),
      executedBuyRaw: BigInt(o.executedBuyAmount ?? '0'),
      totalSellRaw: BigInt(o.sellAmount ?? '0'),
    }
  })
}

/**
 * Cancel live orders. This is an OFF-CHAIN signed request, so it costs no gas —
 * worth saying in the UI, because users assume cancelling a trade costs money.
 *
 * The caller signs the `OrderCancellations` struct; this only transports it.
 * Deliberately takes an array because CoW's endpoint does, and cancelling a
 * whole set in one signature is better than one prompt per order.
 */
export async function cancelCowOrders(
  chainId: CowChainId,
  uids: string[],
  signature: Hex,
  opts?: CowApiOpts,
): Promise<CowResult<true>> {
  return call(
    `${cowApiBase(chainId)}/orders`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderUids: uids, signature, signingScheme: 'eip712' }),
    },
    opts,
    () => true as const,
  )
}

/** The EIP-712 payload for an off-chain cancellation. Same domain as the order
 *  itself, so a signature is bound to the chain and cannot be replayed. */
export const COW_CANCELLATIONS_TYPES = {
  OrderCancellations: [{ name: 'orderUids', type: 'bytes[]' }],
} as const
