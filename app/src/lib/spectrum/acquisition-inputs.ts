import type { Address } from 'viem'
import { assessPool, MIN_POOL_LIQUIDITY_USD, type PoolCandidate, type PoolVerdict } from './pool-safety'
import { sellPathFromNativeVenue, type SellPath, type ZeroExVerdict } from './acquisition-route'

// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCERS FOR `acquisitionRoute`'s INPUTS (2026-08-07, on the owner's "do
// what you can now").
//
// `acquisitionRoute` decides HOW an asset is acquired and is fully tested, but
// on 2026-08-07 it had no production caller and NONE of its three inputs had a
// producer anywhere in the app — so the tiering was a decision nothing could
// reach. This module closes the two that are ours to close, and states plainly
// why the third cannot be closed here.
//
// ⚠ WHAT THIS MODULE IS *NOT*: it does not execute, compose, or price
// anything. It reads a pool discovery result that already happened and
// classifies it. Every function here is pure — the network work belongs to
// `findBestPool`, which the launch surfaces already run in production.
//
// THE THIRD INPUT, AND WHY IT IS NOT HERE. `zeroEx: ZeroExVerdict` needs a
// live quote, the 0x API needs a key, and where each operator's key lives is
// an OPEN DEPLOYMENT QUESTION (zeroex-quote.ts's own header says so: the
// self-host kit is a static app and nothing in this repo ever holds the
// credential). So it is a PARAMETER here, never a default — see
// `ZEROEX_UNPROBED` for what to pass when no probe has run, and read its note:
// the BEHAVIOUR is right (fail closed, never a silent batch leg) and there is
// a stated residual in the COPY.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The value to pass for `zeroEx` when NO probe has run — because there is no
 * key configured, because the request failed, or because the caller has not
 * wired the probe yet.
 *
 * ⚠ IT WAS `'no-route'`, AND THE NOTE HERE ARGUED FOR A FOURTH VERDICT THAT
 * HAD SINCE SHIPPED (A6 review, 2026-08-07). The residual was stale in both
 * directions: it called the fix unbuilt when `read-failed` already existed
 * with exactly the sentence it asked for, and it justified the delay with
 * "acquisitionRoute has no production caller" — true, and not a reason to keep
 * asserting a market fact. `'no-route'` renders as "0x has no route for this
 * asset on this network", which we cannot know when we never asked.
 *
 * `read-failed` is the honest value: it fails closed exactly the same way (an
 * unprobed asset never becomes a silent batch leg) and says "we could not
 * check" instead. The copy leans on connectivity where the real cause may be
 * an unwired probe; that is a wording nit, not a reason to make a claim.
 */
export const ZEROEX_UNPROBED: ZeroExVerdict = 'read-failed'

/** The canonical quote assets a pool may be paired against on a chain — the
 *  identity anchor `assessPool` matches by ADDRESS. Callers pass what the
 *  deployment book says for the chain (weth + settlement); a missing entry
 *  narrows the allowlist rather than widening it. */
export function quoteAssetsFor(book: { weth: Address | null; usdc: Address | null }): readonly string[] {
  return [book.weth, book.usdc].filter((a): a is Address => !!a)
}

/**
 * ⚠⚠ THE GAP THAT BLOCKS THIS INPUT, FOUND BY TRYING TO WIRE IT (2026-08-07).
 *
 * The obvious wiring is `findBestPool(...).candidates` → `assessPool(...)`,
 * and it DOES NOT TYPE-CHECK, for a reason that matters rather than a cosmetic
 * one. There are two different `PoolCandidate` shapes in this app:
 *
 *   · `lib/pools/types.ts` — what discovery returns: venue, fee, tickSpacing,
 *     poolAddress OR poolId, an optional V4 `ethPoolKey`, depth.
 *   · `lib/spectrum/pool-safety.ts` — what the SAFETY SCREEN needs: the same
 *     depth and venue facts PLUS `token0` and `token1`, the pool's actual pair.
 *
 * The pools lib does not carry the pair for V2/V3 candidates (only the pool
 * address), and the pair is precisely what `assessPool` exists to check: it
 * matches the user's token BY ADDRESS and verifies the other side is a
 * canonical quote asset. That is the whole identity argument — an impostor
 * pool pairs a real-looking token against something worthless.
 *
 * SO A MAPPING WRITTEN TODAY WOULD HAVE TO INVENT THE PAIR, AND A SAFETY
 * SCREEN THAT CANNOT SEE IDENTITY IS THEATRE — worse than no screen, because
 * it returns `ok`. This module therefore takes SAFETY-SHAPED candidates and
 * makes the missing data a type error at the call site rather than a silent
 * `ok`. Closing it means teaching discovery to carry each candidate's pair
 * (additive to `lib/pools`, which the launch surfaces use in production, so it
 * is UIGuy's call) — filed on his desk, not guessed at here.
 */
export function poolVerdictFrom(
  candidates: readonly PoolCandidate[] | null,
  tokenAddress: string,
  quoteAssets: readonly string[],
): PoolVerdict | null {
  // discovery did not complete: UNCERTAINTY, not a verdict. A read that FAILED
  // is not a verdict, and `acquisitionRoute` already warns on a null.
  if (!candidates) return null
  return assessPool(candidates, {
    tokenAddress,
    allowedQuoteAssets: quoteAssets,
    minLiquidityUsd: MIN_POOL_LIQUIDITY_USD,
  })
}

/**
 * Can this asset be SOLD again through its native venue?
 *
 * ⚠⚠ THIS IS THE INPUT THE AGGREGATOR MAY NEVER ANSWER (SpectrumContracts,
 * 2026-08-07): 0x refuses tokenized equities in BOTH directions, so deriving a
 * sell path from a 0x answer maps every stock to "no exit" and fires
 * `acquisitionRoute`'s un-overridable first tier — a blanket refusal of the
 * whole stock registry. Exits are established from the venue the exit would
 * actually use, and that is what this function reads.
 *
 * WHAT MAKES A SELL PATH 'confirmed' HERE, stated precisely so nobody reads
 * more into it than it proves: a cleared pool exists, paired against a
 * canonical quote asset, holding real depth, for a token that PASSED the
 * fee-on-transfer probe — because a fee-on-transfer token is the honeypot
 * shape that looks sellable and under-delivers on the way out, and
 * `findBestPool` already refuses those outright.
 *
 * WHAT IT DOES NOT PROVE, and the residual is real: this is a ROUTE existing,
 * not a simulated sale. A token whose transfer reverts only for a seller who
 * is not the deployer would still read 'confirmed' here. Closing that needs a
 * simulated sell against the pool (the same `eth_simulateV1` technique
 * `probeTransferFee` already uses), which is the honest upgrade path and is
 * NOT built. Stated rather than implied — gate A7.
 */
export function nativeSellPath(verdict: PoolVerdict | null): SellPath {
  // the screen could not decide, or never ran: uncertainty, which warns.
  // Never 'none' — "we could not look" is not "there is no exit".
  if (verdict == null) return sellPathFromNativeVenue(null)
  // a structural refusal IS a measured absence of a usable venue
  if (verdict.kind === 'refuse') return sellPathFromNativeVenue(false)
  // 'ask' means several pools and none decisive — a route exists, but which one
  // is uncertain, so the exit is unconfirmed rather than proven
  if (verdict.kind === 'ask') return sellPathFromNativeVenue(null)
  // ⚠⚠ THE 'ok' BRANCH IS NAMED, AND THE FALL-THROUGH IS NOW A COMPILE ERROR
  // (independent review, 2026-08-07 — MEDIUM). This function used to END with
  // `return sellPathFromNativeVenue(true)`, so it was exhaustive only by
  // if-chain: ANY PoolVerdict kind this chain does not recognise returned
  // 'confirmed'. Measured with a kind of 'stale': confirmed. That is the most
  // dangerous default in the module — acquisition-route's own header calls this
  // wiring the single most dangerous mistake available here — because a new
  // verdict kind added by someone reading only pool-safety.ts would silently
  // CONFIRM AN EXIT nothing had established, and 'confirmed' is the value that
  // lets an asset ride a batch.
  //
  // A `never` assert makes the same mistake fail to compile instead. It cannot
  // be a runtime-only check: the point is that the author of the next kind is
  // told at the moment they add it, not by a user whose money is in the pool.
  if (verdict.kind === 'ok') return sellPathFromNativeVenue(true)
  const unreachable: never = verdict
  throw new Error(`unhandled pool verdict: ${JSON.stringify(unreachable)}`)
}

/** The three inputs together, so a caller cannot assemble two of them and
 *  forget that the third is a decision. `zeroEx` is REQUIRED and has no
 *  default — pass `ZEROEX_UNPROBED` explicitly when no probe ran, so the
 *  absence is visible at the call site rather than implied by omission. */
export function acquisitionInputsFor(args: {
  symbol: string
  /** Safety-shaped candidates, or null when discovery did not complete. See
   *  `poolVerdictFrom` for why discovery's own shape cannot be passed here. */
  candidates: readonly PoolCandidate[] | null
  tokenAddress: string
  quoteAssets: readonly string[]
  zeroEx: ZeroExVerdict
}): { symbol: string; zeroEx: ZeroExVerdict; poolVerdict: PoolVerdict | null; sellPath: SellPath } {
  const poolVerdict = poolVerdictFrom(args.candidates, args.tokenAddress, args.quoteAssets)
  return { symbol: args.symbol, zeroEx: args.zeroEx, poolVerdict, sellPath: nativeSellPath(poolVerdict) }
}
