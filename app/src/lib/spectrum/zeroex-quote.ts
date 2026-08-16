import type { Address, Hex } from 'viem'
import { showSymbol } from './safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// THE 0x ALLOWANCE-HOLDER QUOTE CLIENT (plan §8, 2026-08-06 — built dark).
//
// One job: turn "buy this asset with this much funding" into calldata the
// SpectrumPortfolioBatcher can carry — and refuse everything else in a
// sentence. The batcher trusts NOTHING about this calldata (it measures
// deltas); the floor derived from this quote's `buyAmount` is the user's
// whole protection (BACKEND-FLOOR-DISCIPLINE rule 1). So this module treats
// the aggregator as an untrusted counterparty:
//
//  · THE TARGET IS PINNED. `transaction.to` and `allowanceTarget` must BOTH
//    equal the AllowanceHolder constant the contract baked in — the same
//    address on all three chains (verified live 2026-08-06, 1009 bytes on
//    8453/1/4663). A quote steering anywhere else is refused, whatever it
//    claims.
//  · THE VALUE MUST BE ZERO. Funding is ERC-20 only on this contract (no
//    native path exists), so a quote asking for native value is wrong by
//    construction.
//  · buyAmount IS BRACKETED AGAINST A DEPTH-AWARE EXPECTATION — spot minus
//    this asset's OWN measured price impact at this size, supplied by the
//    caller. It is deliberately NOT frictionless spot: an honest thin route
//    sits far below that, which used to force the bracket to ±2,000 bps, and
//    since whatever the bracket accepts becomes the FLOOR'S BASIS, that width
//    was itself the protection's real bound. The bracket and the floor compose
//    and nothing multiplied them (CRITICAL, review 2026-08-07).

//  · 0x's own minBuyAmount is never OUR FLOOR (rule 1): it lives inside opaque
//    calldata and the floor derives from `buyAmount` alone. But it is not inert
//    either, and reading it as inert cost three live reverts — it is a real
//    tolerance that reverts a real trade, and left unset it defaults to 100 bps,
//    TIGHTER than our own floor on a thin asset. So we now SET it (see
//    `slippageBps` on the fetcher) to the leg's ceiling, which keeps our floor
//    the binding constraint. Chosen and stated, rather than inherited and
//    invisible; still never the basis of any number we display.
//
// NO KEY LIVES HERE. The fetcher is injected: the 0x API needs a key
// (confirmed — no keyless routing), the self-host kit is a static app, and
// where each operator's key resides is an OPEN deployment question (plan §8).
// Tests inject fixtures; nothing in this repo ever holds the credential.
// ─────────────────────────────────────────────────────────────────────────────

/** The contract's baked constant, mirrored (SpectrumPortfolioBatcher.sol
 *  ALLOWANCE_HOLDER — identical on Base/Ethereum/Robinhood, Cancun build). */
export const ALLOWANCE_HOLDER: Address = '0x0000000000001fF3684f28c67538d4D072C22734'

/** buyAmount vs our expectation: refuse beyond ±4%.
 *
 *  ⚠ THIS WAS 2,000 BPS AND THAT WAS A CRITICAL DEFECT (independent review,
 *  2026-08-07). The bracket and the floor COMPOSE: whatever the validator
 *  accepts becomes the floor's basis, so a ±2,000 bps gate feeding a 30 bps
 *  floor permitted 2,024 bps of real shortfall while the surface reported 30 —
 *  67x the number shown to a human, and nothing anywhere computed the product.
 *
 *  It could not simply be tightened while the reference was FRICTIONLESS spot,
 *  because an honest thin route legitimately sits 500–1,500 bps under it: the
 *  same number was being asked to be both "plausible for a thin route" and
 *  "fair-value reference for a floor", and it cannot be both. The caller now
 *  supplies a DEPTH-AWARE expectation (spot minus this asset's own measured
 *  impact), which makes the honest band narrow — so the bracket can close to
 *  something that actually bounds the floor's basis. */
export const QUOTE_PLAUSIBILITY_BRACKET_BPS = 400

/** What we require of a 0x /swap/allowance-holder/quote response. Shape
 *  confirmed live by the contracts lane (their 0x-coverage tool + a real
 *  quote): an unroutable pair answers HTTP 200 with liquidityAvailable:false. */
export interface ZeroExQuoteResponse {
  liquidityAvailable?: boolean
  buyAmount?: string
  sellAmount?: string
  buyToken?: string
  sellToken?: string
  allowanceTarget?: string
  transaction?: { to?: string; value?: string; data?: string }
  issues?: { allowance?: { spender?: string } | null }
  /** 0x's own error name on a non-200 (e.g. `BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE`).
   *  The fetcher seam passes it through so this module can CLASSIFY rather than
   *  collapse every failure into "no route" — see `classifyZeroExOutcome`. */
  name?: string
  /** The HTTP status the fetcher saw. 422 is 0x's policy refusal. */
  status?: number
  /** 0x's own fee breakdown. `zeroExFee` is a VOLUME fee it takes on the sell
   *  side — measured live on 4663 at 15 bps, to 0x's own sweeper — and we never
   *  requested it, never parsed it and therefore never showed it (found by
   *  SpectrumContracts decoding a real receipt, 2026-08-15: all-in cost was
   *  54.8 bps against the 40 bps our fee bar displays, a ~37% understatement).
   *  `integratorFee` is the one WE could configure and is null, which is how we
   *  know the sweeper is theirs and not ours. It does not weaken protection —
   *  it is taken before delivery, so it is already inside `buyAmount` and
   *  inside the floor we enforce — but a cost the user pays and cannot see
   *  breaks the house rule that the number shown is the number that decides. */
  fees?: {
    zeroExFee?: { amount?: string; token?: string; type?: string } | null
    integratorFee?: { amount?: string; token?: string; type?: string } | null
    gasFee?: { amount?: string; token?: string; type?: string } | null
  } | null
}

/**
 * WHY 0x SAID NO — a policy refusal and a depth refusal are opposite facts.
 *
 * ⚠ MEASURED, NOT GUESSED (SpectrumContracts, 2026-08-07, live key): 0x
 * refuses every tokenized equity on 4663 with HTTP 422 and
 * `BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE` / `SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE`
 * — "not authorized for trade due to legal restrictions" — while eight
 * trending tokens quote fine on the same chain, key and funding asset. It is a
 * compliance deny-list, so no probe size or fee tier changes it.
 *
 * Two consequences this function exists to prevent:
 *  1. THE COPY WOULD BE FALSE. "0x has no route for this asset on this network"
 *     is a wrong sentence for a stock: 0x demonstrably has a route and is
 *     declining it. A wrong sentence on a money surface is worse than a blunt
 *     one (acquisition-route's own law).
 *  2. THE TIERING WOULD BE BYPASSED. If the fetcher throws on a non-200, a
 *     stock leg surfaces as an opaque error instead of a classified route
 *     decision, so the narrow-C side-swap path the owner ruled for never runs.
 *
 * ⚠⚠ AND IT SAYS NOTHING ABOUT EXITS, IN EITHER DIRECTION. 0x's refusal is
 * bidirectional; a sell-side quote for NVDA fails the same way. Mapping that
 * to "no exit" refuses the entire stock registry. `sellPath` comes from the
 * native venue — see `sellPathFromNativeVenue`.
 */
export type ZeroExOutcome = 'routable' | 'no-route' | 'policy-refused' | 'read-failed'

/** Failures authored by US or by the transport, not by 0x — an operator with
 *  no key configured, a proxy that refused the request, an unreachable
 *  upstream, a rate limit, a body we could not parse. None is a fact about a
 *  market. */
const OUR_OWN_FAILURES = /^(PROXY_|UPSTREAM_|NO_UPSTREAM_KEY|ORIGIN_NOT_ALLOWED|BAD_PROXY_REQUEST|METHOD_NOT_ALLOWED)/

export function classifyZeroExOutcome(raw: ZeroExQuoteResponse): ZeroExOutcome {
  // the policy shape first: it is the one that must not read as thinness
  const name = typeof raw.name === 'string' ? raw.name.toUpperCase() : ''
  if (name.includes('NOT_AUTHORIZED_FOR_TRADE') || (raw.status === 422 && name.includes('NOT_AUTHORIZED'))) return 'policy-refused'

  // ⚠⚠ 'read-failed' EXISTS BECAUSE THE UNION HAD NO HONEST ANSWER (A6 review,
  // 2026-08-07 — HIGH). Every failure that is OURS rather than the market's —
  // the operator forgot the key (503), the proxy refused the request (400/403),
  // the upstream was unreachable (502), 0x rate-limited us (429), the body did
  // not parse — was being returned as 'no-route', which `acquisition-route`
  // renders as "0x has no route for this asset on this network". That is a
  // CLAIM ABOUT A MARKET made off a read that never happened, and it is the
  // read-failed law this module's own comment invoked while breaking it.
  //
  // The abuse chain made it worse: an unauthenticated third party can burn our
  // quota to a 429, and a 429 became a false market fact shown to every user.
  //
  // 'read-failed' behaves like 'no-route' where it must (an asset cannot ride
  // a batch on a quote we do not have) but SAYS something different, so the
  // surface can tell a person "we could not check" instead of lying about the
  // market.
  if (OUR_OWN_FAILURES.test(name)) return 'read-failed'
  if (raw.status === 429) return 'read-failed'
  // a non-200 we cannot name is not a policy refusal and not a market fact
  if (typeof raw.status === 'number' && raw.status >= 400) return 'read-failed'

  // ⚠⚠ ROUTABLE REQUIRES A QUOTE, NOT MERELY THE ABSENCE OF A REFUSAL (found
  // reviewing my own proxy change, 2026-08-07 — it was FAIL-OPEN).
  // The app now calls `/api/zerox` on its own origin. If that edge function is
  // absent or misrouted, the SPA catch-all (`/*  /index.html  200`) answers
  // with HTML at status **200**; the fetcher cannot parse it and yields an
  // essentially empty object. This function only looked for reasons to say no,
  // found none, and said `routable` — so a DEPLOYMENT GAP would have promoted
  // every asset to batch-eligible on no quote whatsoever. Composition would
  // still have refused downstream (`validateLegQuote` needs a buyAmount), but
  // the tiering a human reads would already have been wrong, and the
  // fail-closed property claimed for this path was simply not there.
  //
  // So the bar is POSITIVE EVIDENCE: a usable, positive `buyAmount`. Anything
  // else — an empty body, HTML, a 200 with no amount — is `no-route`, which
  // routes the asset to individual acquisition instead of into a batch.
  // ⚠ THE ONE MARKET FACT, and it is checked HERE rather than first (A6
  // review, 2026-08-07 — F5/F10). `no-route` means 0x looked and found no
  // route, so it may only be said when 0x SAYS SO at an otherwise clean
  // answer. Checking it before the failure branches let a 503 that also
  // carried `liquidityAvailable:false` read as a market fact.
  if (raw.liquidityAvailable === false) return 'no-route'

  // Everything left is an answer we cannot USE: an empty body, HTML, a 200
  // with no amount, an amount in a shape we do not accept. My commit message
  // claimed no-route was reserved for the market fact above, and the code
  // twenty lines down said otherwise — worse, `liquidityAvailable: true` with
  // an unusable amount was reported as "0x has no route", CONTRADICTING the
  // upstream's own answer, and a numeric (rather than string) buyAmount would
  // have made every asset on earth read as routeless.
  const amount = typeof raw.buyAmount === 'string' && /^[0-9]{1,40}$/.test(raw.buyAmount) ? BigInt(raw.buyAmount) : null
  if (amount == null || amount <= 0n) return 'read-failed'
  return 'routable'
}

/** A validated, composition-ready quote for one leg. */
export interface LegQuote {
  /** The asset this leg buys — echoed by 0x, verified against what we asked. */
  buyToken: Address
  /** Funding this quote prices, raw units — verified against what we asked. */
  sellAmountRaw: bigint
  /** 0x's quoted output, raw units — THE FLOOR BASIS (rule 1). */
  buyAmountRaw: bigint
  /** The calldata the batcher will fire at AllowanceHolder, unparsed. */
  swapData: Hex
  /** What 0x takes for itself on this leg, in SELL-token raw units. Null when
   *  the response carried no fee block or one we could not read — never 0,
   *  because "no fee" and "we could not see the fee" are different facts and
   *  only one of them is safe to display as a cost of zero. */
  zeroExFeeRaw: bigint | null
}

export class ZeroExQuoteRefusal extends Error {
  readonly symbol: string
  constructor(message: string, symbol: string) {
    super(message)
    this.name = 'ZeroExQuoteRefusal'
    this.symbol = symbol
  }
}

/** The network seam, injected. The runner supplies a fetcher that knows where
 *  the operator's key lives; tests supply fixtures. The client never builds
 *  URLs or headers — that keeps every key decision OUT of this repo. */
export type ZeroExFetcher = (args: {
  chainId: number
  sellToken: Address
  buyToken: Address
  sellAmountRaw: bigint
  taker: Address
  /** THE TOLERANCE 0x EMBEDS IN ITS OWN CALLDATA, bps — and the reason this
   *  field exists at all (the owner, live 2026-08-15, three on-chain
   *  `RequiredLegFailed` reverts on a $3,154 $LNOC leg).
   *
   *  ⚠⚠ MEASURED: with this ABSENT, 0x applies its OWN DEFAULT OF 100 BPS. A
   *  live probe against the real proxy confirmed it both ways — no param gave
   *  `minBuyAmount` at exactly 1.00% under `buyAmount`; passing 500 and 1500
   *  gave exactly those. So every portfolio leg this app has ever composed has
   *  ridden a 1% tolerance THAT WE NEVER CHOSE, buried inside opaque Settler
   *  calldata, and it is TIGHTER than our own floor (250–300 bps) on exactly
   *  the thin assets where drift is largest.
   *
   *  That is the whole shape of his bug: the binding constraint was not our
   *  floor, which we display and can explain — it was 0x's default, which we
   *  do not display and cannot explain, and it reverted first. The user saw a
   *  batch fail with no honest account of why, because the number that stopped
   *  it was never ours.
   *
   *  THE INVARIANT, and it is the point of the field: what we ask 0x to embed
   *  must always be **at least as wide as our own floor permits**, so OUR floor
   *  is the one that binds and the number a human was shown is the number that
   *  decided. Callers therefore pass the leg's CEILING (the most its floor
   *  could ever allow), never its exact derived tolerance.
   *
   *  Absent stays legal and means "0x's default" — every existing caller and
   *  every test fixture keeps its behaviour, and the burn route (which has no
   *  floor of ours to protect, only the contract's own) deliberately omits it.
   *
   *  ⚠ It does NOT move the quote: the same probe returned an IDENTICAL
   *  `buyAmount` at 100, 500 and 1500 bps, so this cannot alter the floor's
   *  basis (rule 1) or the plausibility bracket's subject. It sets a minimum,
   *  nothing else. */
  slippageBps?: number
}) => Promise<ZeroExQuoteResponse>

/** Where the browser sends quote requests: OUR origin, never api.0x.org.
 *  The edge function (netlify/edge-functions/zerox.ts) holds the key. */
export const ZEROX_PROXY_PREFIX = '/api/zerox'

/**
 * The production fetcher — and the reason the app no longer talks to 0x
 * directly (the owner, 2026-08-07: "we need to fix this so no one can get our 0x
 * key").
 *
 * The key is NOT here, and cannot be: this module runs in the browser, so any
 * credential it held would ship in the bundle. Measured rather than assumed —
 * a build with a dummy `VITE_` value put the literal in `dist/assets/*.js`
 * twice — and the key had no origin binding, so 0x honoured it from a forged
 * origin and from curl. Requests go to our own origin; the edge function adds
 * the credential server-side.
 *
 * It preserves `status` and the error `name` because `classifyZeroExOutcome`
 * needs both to tell a POLICY refusal (bought individually) from a DEPTH
 * refusal from an unknown failure — collapsing those mis-tiers money.
 */
export function createProxyZeroExFetcher(fetchImpl: typeof fetch = fetch): ZeroExFetcher {
  return async ({ chainId, sellToken, buyToken, sellAmountRaw, taker, slippageBps }) => {
    const qs = new URLSearchParams({
      chainId: String(chainId),
      sellToken,
      buyToken,
      sellAmount: sellAmountRaw.toString(),
      taker,
    })
    // Only a usable integer is forwarded. A malformed one is DROPPED rather
    // than sent, because the proxy refuses the whole request on a malformed
    // `slippageBps` (deliberately — a silently dropped slippage would quote a
    // different trade) and losing the quote entirely is the worse failure: the
    // fallback is 0x's default, which is where we already were. The proxy's own
    // bound is 0–9999, so anything outside it would refuse there too.
    if (slippageBps != null && Number.isFinite(slippageBps) && slippageBps >= 0 && slippageBps <= 9_999)
      qs.set('slippageBps', String(Math.round(slippageBps)))
    // a timeout on this side too: without one the compose flow hangs with no
    // user-visible resolution while the batcher fires every leg concurrently
    const res = await fetchImpl(`${ZEROX_PROXY_PREFIX}/swap/allowance-holder/quote?${qs.toString()}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    let body: Record<string, unknown> = {}
    let parsed = false
    try {
      body = (await res.json()) as Record<string, unknown>
      // ⚠ `typeof [] === 'object'` — an ARRAY body was spread into index keys,
      // losing every field the classifier reads (A6 review, F6).
      parsed = body != null && typeof body === 'object' && !Array.isArray(body)
    } catch {
      parsed = false
    }
    // ⚠ A BODY WE COULD NOT PARSE IS NOT AN EMPTY SUCCESS. The realistic case
    // is our own SPA catch-all serving index.html at 200 when the proxy is
    // absent — which used to read as a quote with nothing in it. Say what
    // happened, so the classifier judges a failure rather than a silence.
    if (!parsed) return { name: 'PROXY_UNPARSEABLE_RESPONSE', status: res.status } as ZeroExQuoteResponse
    return { ...body, status: res.status } as ZeroExQuoteResponse
  }
}

function parseRawAmount(v: string | undefined): bigint | null {
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) return null
  try {
    return BigInt(v)
  } catch {
    return null
  }
}

/**
 * Validate one 0x quote into a composition-ready LegQuote, or refuse with a
 * review-grade sentence naming the asset. `expected` carries what WE asked
 * for; every echoed field is checked against it — a response is never trusted
 * to describe the request it answered.
 *
 * `spotOutRaw` is the page's own frictionless expectation for this sellAmount
 * (the same figure the review shows). Null = we have no independent read —
 * which refuses: an unverifiable quote cannot become a floor basis.
 */
export function validateLegQuote(
  raw: ZeroExQuoteResponse,
  expected: {
    symbol: string
    chainId: number
    sellToken: Address
    buyToken: Address
    sellAmountRaw: bigint
    /** The DEPTH-AWARE expectation — spot less this asset's own measured impact.
     *  Guards the LOW side, where a too-cheap quote would loosen the floor. */
    spotOutRaw: bigint | null
    /** FRICTIONLESS spot for this sellAmount. Guards the HIGH side. Optional so
     *  existing callers keep the old symmetric behaviour; supply it wherever the
     *  depth model is doing real work. */
    frictionlessOutRaw?: bigint | null
  },
): LegQuote {
  const sym = showSymbol(expected.symbol)
  // ⚠ NAME THE REASON (SpectrumContracts, 2026-08-07). This threw "0x has no
  // route for this asset on this network" for BOTH a genuine depth refusal and
  // a legal-policy refusal of a whole asset class — false for the second, and
  // it hid the case that must reach the side-swap path deliberately.
  const outcome = classifyZeroExOutcome(raw)
  if (outcome === 'policy-refused')
    throw new ZeroExQuoteRefusal(
      `$${sym}: the exchange we route through will not trade this asset, so it cannot ride this batch — it has to be bought on its own`,
      expected.symbol,
    )
  if (outcome === 'no-route')
    throw new ZeroExQuoteRefusal(`$${sym}: 0x has no route for this asset on this network — the leg cannot ride this batch`, expected.symbol)
  // ⚠⚠ WITHOUT THIS BRANCH A READ FAILURE FELL THROUGH TO THE ALLOWANCE-HOLDER
  // PIN (A6 review, 2026-08-07 — HIGH, and the worst sentence in the file).
  // A body with no `transaction.to` — which is every proxy failure — reached
  // the target check and told the user "this quote steers funds somewhere
  // other than the pinned AllowanceHolder", accusing the aggregator of
  // misdirecting money when the truth was that the operator had not set
  // ZEROX_API_KEY, or that an attacker had burned our quota to a 429. This
  // commit existed to stop proxy failures producing false claims, and on the
  // one path that renders them it had swapped a false claim for a scarier one.
  if (outcome === 'read-failed')
    throw new ZeroExQuoteRefusal(
      `$${sym}: we could not reach the exchange we route through, so this leg cannot ride the batch — try again in a moment`,
      expected.symbol,
    )

  const to = raw.transaction?.to?.toLowerCase()
  const spender = raw.allowanceTarget?.toLowerCase()
  const holder = ALLOWANCE_HOLDER.toLowerCase()
  // BOTH the call target and the approval target must be the baked constant.
  // issues.allowance.spender, when present, must agree too (their live quote
  // showed it echoing AllowanceHolder; a Settler here means a standing-
  // approval shape we never sign).
  const issueSpender = raw.issues?.allowance?.spender?.toLowerCase()
  if (to !== holder || spender !== holder || (issueSpender != null && issueSpender !== holder))
    throw new ZeroExQuoteRefusal(
      `$${sym}: this quote steers funds somewhere other than the pinned AllowanceHolder — refused, whatever it claims to be`,
      expected.symbol,
    )

  const value = raw.transaction?.value
  if (value != null && value !== '0')
    throw new ZeroExQuoteRefusal(
      `$${sym}: this quote asks for native value, but the batcher funds in ERC-20 only — a value-carrying quote is wrong by construction`,
      expected.symbol,
    )

  const data = raw.transaction?.data
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(data))
    throw new ZeroExQuoteRefusal(`$${sym}: the quote carries no executable calldata — nothing honest can be composed from it`, expected.symbol)

  // The echo checks: the response must describe the request we made.
  if (raw.buyToken?.toLowerCase() !== expected.buyToken.toLowerCase() || raw.sellToken?.toLowerCase() !== expected.sellToken.toLowerCase())
    throw new ZeroExQuoteRefusal(`$${sym}: the quote answers a different token pair than we asked for — refused`, expected.symbol)
  const sellEcho = parseRawAmount(raw.sellAmount)
  if (sellEcho == null || sellEcho !== expected.sellAmountRaw)
    throw new ZeroExQuoteRefusal(`$${sym}: the quote prices a different amount than this leg's budget — refused`, expected.symbol)

  const buyAmountRaw = parseRawAmount(raw.buyAmount)
  if (buyAmountRaw == null || buyAmountRaw <= 0n)
    throw new ZeroExQuoteRefusal(`$${sym}: the quote states no usable output amount — no honest floor can derive from it`, expected.symbol)

  // THE PLAUSIBILITY BRACKET. Directionality matters: a too-LOW buyAmount
  // would loosen the floor derived from it (the dangerous direction); a
  // too-HIGH one composes a floor the chain will revert (fail-closed but
  // wasteful, and just as surely a wrong quote). Both refuse.
  if (expected.spotOutRaw == null || expected.spotOutRaw <= 0n)
    throw new ZeroExQuoteRefusal(
      `$${sym}: we have no independent price to judge this quote against, so we will not build protection from it`,
      expected.symbol,
    )
  // ⚠⚠ THE BRACKET IS ASYMMETRIC, AND IT HAS TO BE (the owner live 2026-08-15: a
  // $1,598 $LNOC leg refused with "0x quotes 887133… but our own read expects
  // about 792012…" — a 1,201 bps gap on a quote that was FINE).
  //
  // The two sides guard opposite risks and must not share a reference:
  //  · LOW  — a quote under our depth-aware expectation is the DANGEROUS
  //    direction: whatever we accept becomes the floor's basis, so a cheap
  //    quote silently buys extractable room. Bracketed against the depth-aware
  //    figure, exactly as before. UNCHANGED.
  //  · HIGH — a quote ABOVE it is the model being pessimistic, not the
  //    aggregator lying, and `singleSwapImpactBps` is pessimistic BY
  //    CONSTRUCTION: it prices a constant-product curve, while V3/V4
  //    concentrated liquidity fills BETTER at the same TVL. floor-discipline's
  //    own comment says so ("errs TIGHT"). That error scales with the impact
  //    term, so on a thin pool at size it grows past 400 bps and starts
  //    refusing honest quotes — a false refusal produced entirely by our own
  //    conservatism. The ceiling therefore hangs off FRICTIONLESS SPOT, which
  //    is the real bound a route cannot beat: nobody fills you better than the
  //    market price plus a tolerance.
  //
  // Without the frictionless figure we fall back to the old symmetric shape, so
  // every existing caller keeps its behaviour exactly.
  const lo = (expected.spotOutRaw * BigInt(10_000 - QUOTE_PLAUSIBILITY_BRACKET_BPS)) / 10_000n
  const hiRef =
    expected.frictionlessOutRaw != null && expected.frictionlessOutRaw > expected.spotOutRaw
      ? expected.frictionlessOutRaw
      : expected.spotOutRaw
  const hi = (hiRef * BigInt(10_000 + QUOTE_PLAUSIBILITY_BRACKET_BPS)) / 10_000n
  if (buyAmountRaw < lo || buyAmountRaw > hi)
    throw new ZeroExQuoteRefusal(
      `$${sym}: 0x quotes ${buyAmountRaw} but our own read expects about ${expected.spotOutRaw} — a gap this size is a wrong quote, not slippage — or the market moved while this plan waited (re-checking with fresh prices is safe); refused`,
      expected.symbol,
    )

  // 0x's own cut, read so it can be SHOWN. Only counted when it is denominated
  // in the token we are selling — a fee in some other unit is not something we
  // can add to this leg's cost without a price, and guessing one would be worse
  // than saying nothing.
  const feeAmt = parseRawAmount(raw.fees?.zeroExFee?.amount ?? undefined)
  const feeTok = raw.fees?.zeroExFee?.token?.toLowerCase()
  const zeroExFeeRaw = feeAmt != null && feeAmt >= 0n && (feeTok == null || feeTok === expected.sellToken.toLowerCase()) ? feeAmt : null

  return {
    buyToken: expected.buyToken,
    sellAmountRaw: expected.sellAmountRaw,
    buyAmountRaw,
    swapData: data as Hex,
    zeroExFeeRaw,
  }
}
