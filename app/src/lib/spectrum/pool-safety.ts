// ─────────────────────────────────────────────────────────────────────────────
// POOL SAFETY — the gate that decides whether we are allowed to place at all.
//
// the owner, 2026-08-06 ~15:4x: "an extremely comprehensive and secure system for
// the LP system that guarantees we don't mess up placement, that we always try
// to ensure we have the right pool for each asset, that the system NEVER places
// an LP position that it cannot guarantee is correct / the largest proper pool.
// If doubt we ask the user to paste in the pool url."
//
// THIS MODULE IS NOT A POOL PICKER. A picker's job is to return its best guess;
// this one's job is to REFUSE. It answers exactly one question — "may we place
// here?" — with `ok`, `ask` or `refuse`, and the default on every unknown is not
// `ok`. Placing into the wrong pool is not a degraded experience, it is someone
// laddering their tokens out into an asset they never chose.
//
// THE FIVE WAYS THIS GOES WRONG, and the gate that stops each:
//
//  1. WRONG PAIR — TOKEN/SCAM instead of TOKEN/WETH. The catastrophic one: the
//     position converts real tokens into a worthless counter-asset. Gate: the
//     quote side must be one of THIS CHAIN'S OWN canonical assets from the
//     deployment book. Not "a token that looks like a quote asset" — the exact
//     addresses we already trust for pricing and settlement.
//  2. IMPOSTOR TOKEN — a pool for a different token wearing the same ticker.
//     Symbols are deployer-controlled text (the D2 audit's lesson). Gate: match
//     on the held token's ADDRESS, never its symbol.
//  3. WRONG TIER — the pair has four fee tiers and we pick a dead one, so the
//     order never fills. Gate: dominance. The winner must carry a decisive
//     majority of the pair's liquidity, or it is not obviously the right pool
//     and the answer is `ask`, not a coin flip.
//  4. WRONG VENUE — a range order needs CONCENTRATED liquidity. A V2 pool
//     cannot hold one at all. Gate: V3/V4 only, refuse otherwise with words.
//  5. DISAGREEING SOURCES — the chain says one pool is deepest, the indexer
//     says another. That is precisely the state where a confident answer is
//     least justified. Gate: corroboration, and `ask` when they diverge.
//
// AND THE PASTE IS NOT A BYPASS. When we ask the user for a pool URL, their
// answer resolves WHICH pool — it does not waive the checks. A pasted pool
// still has to be a real pool, from the canonical factory, containing the exact
// token they hold, quoted in an asset we recognise. "The user told us to" is
// not a safety argument; it is how a phishing link becomes a signed
// transaction.
// ─────────────────────────────────────────────────────────────────────────────

export type PoolVenue = 'v3' | 'v4' | 'v2' | 'unknown'

export interface PoolCandidate {
  /** Pool address (v3) or pool id (v4), lowercased. */
  id: string
  venue: PoolVenue
  /** The two sides, lowercased addresses. */
  token0: string
  token1: string
  /** Fee tier in hundredths of a bip (500 = 0.05%). */
  feeBps?: number
  /** Tick spacing, needed to snap a range. Absent = we cannot place. */
  tickSpacing?: number
  /** Quote-side depth in USD. Null = unreadable, which is NOT zero and NOT ok. */
  liquidityUsd: number | null
  /** Whether the on-chain factory confirmed this pool exists at this id. */
  onChainConfirmed: boolean
  /** Whether the indexer also reported it. Both true = corroborated. */
  indexerConfirmed: boolean
}

export interface PoolSafetyContext {
  /** The exact token the user holds — matched by ADDRESS, never symbol. */
  tokenAddress: string
  /** This chain's canonical quote assets, from the deployment book. */
  allowedQuoteAssets: readonly string[]
  /** Below this, a pool cannot be trusted to fill a real order. */
  minLiquidityUsd?: number
  /** How far ahead the winner must be to count as obviously right. */
  dominanceRatio?: number
}

export type AskReason =
  | 'two-pools-too-close'
  | 'sources-disagree'
  | 'depth-unreadable'
export type RefuseReason =
  | 'no-candidates'
  | 'no-recognised-quote-asset'
  | 'no-concentrated-venue'
  | 'token-not-in-pool'
  | 'below-liquidity-floor'
  | 'unusable-tick-spacing'
  | 'not-on-chain'
  /** A depth the source COULD state but that cannot describe a pool — negative,
   *  or above the plausible ceiling. Distinct from `depth-unreadable`, which is
   *  a read that did not land; see `assessPool` gate 5. */
  | 'depth-implausible'
  /** Our OWN safety thresholds did not arrive as numbers. Not a fact about the
   *  pool — a fact about this call, and the one refusal here that is our bug. */
  | 'unreadable-safety-threshold'
  | 'unusable-fee-tier'

export type PoolVerdict =
  | { kind: 'ok'; pool: PoolCandidate; why: string }
  | { kind: 'ask'; reason: AskReason; message: string; candidates: PoolCandidate[] }
  | { kind: 'refuse'; reason: RefuseReason; message: string }

/** A pool holding less than this cannot be trusted to fill a real order — and,
 *  more to the point, a deployer can stand up an empty pool for any pair, so a
 *  thin pool is as much an identity signal as a depth one. */
export const MIN_POOL_LIQUIDITY_USD = 25_000

/**
 * ⚠ AND A CEILING, because depth is an IDENTITY claim and this screen reads it
 * in both directions (hostile-number sweep, 2026-08-07). The floor stops a
 * deployer's empty pool; nothing stopped the opposite move — an INFLATED depth
 * clears the floor AND wins the dominance ratio, so a fake pool reporting an
 * impossible TVL becomes "obviously the right pool". Same shape as the
 * hop-reserve finding, where an inflated reserve switched off self-impact.
 *
 * $100B is deliberately generous rather than tuned: the deepest real Uniswap
 * pools have historically held low single-digit BILLIONS, so this sits ~20x
 * above anything genuine while still refusing the two shapes that matter — a
 * wei amount pasted into a dollar field (1e21) and a lying indexer. A number
 * above it is not a deep pool; it is a broken or hostile read.
 */
export const MAX_PLAUSIBLE_POOL_LIQUIDITY_USD = 100_000_000_000

/** The winner must carry this multiple of the runner-up's depth to count as
 *  "obviously the right pool". Below it we are choosing, not identifying — and
 *  the whole point of this module is that we do not choose. */
export const DOMINANCE_RATIO = 3

/** A fee tier above 100% is not a fee tier. V3 stores fee in hundredths of a
 *  bip, so 1e6 IS 100% and is already absurd; this exists to bound the field at
 *  all rather than to discriminate between real tiers. Note it deliberately
 *  refuses V4's dynamic-fee sentinel (0x800000): a pool whose fee is decided at
 *  swap time is not one we can snap a fixed range into and quote honestly. */
export const MAX_POOL_FEE_BPS = 1_000_000

/** Uniswap V3's own maximum tick spacing. A range is snapped to this grid, so a
 *  spacing beyond what the factory can hold means we are reading a different
 *  number than we think we are. */
export const MAX_TICK_SPACING = 16_384

/**
 * DEPTH, WITH ITS DENOMINATION IN THE TYPE (the `FundingRaw` precedent).
 *
 * ⚠ WHY NOW, AND WHY THIS FIELD. `lib/pools/types.ts` carries `depthUsd` and
 * `depthEth` ADJACENT IN ONE STRUCT, and this screen's whole argument rests on
 * depth being dollars: the floor is $25k, the ceiling is $100B, and the
 * dominance ratio compares two of them. Hand it an ETH figure and every one of
 * those comparisons still evaluates — a 12 ETH pool reads as $12 and refuses,
 * a 40,000 ETH pool reads as $40,000 and CLEARS the floor it should dwarf. The
 * wrong-field wiring is one keystroke away and no runtime check can see it,
 * because both fields are plain numbers.
 *
 * The moment is now because THE PRODUCER IS BEING WRITTEN RIGHT NOW: no
 * production code constructs a safety-shaped candidate today (the mapping
 * deliberately does not type-check — `acquisition-inputs.ts` explains why), and
 * UIGuy is adding the pair to discovery so it can. A brand added before that
 * mapping exists makes its author name the denomination once; added after, it
 * is a refactor nobody schedules.
 */
export type PoolDepthUsd = number & { readonly __brand: 'PoolDepthUsd' }

/** THE ONLY MINT for a depth we produced ourselves. Cheap by design — it
 *  asserts the DENOMINATION (that is the brand's job) and rejects the one shape
 *  that is nonsense in any unit. Plausibility belongs to gate 5, which is where
 *  an untrusted third party's number gets judged; use `readPoolDepthUsd` for
 *  that input rather than wrapping this in a try/catch. */
export function asPoolDepthUsd(usd: number): PoolDepthUsd {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`${usd} is not a USD pool depth`)
  return usd as PoolDepthUsd
}

/** Why a depth could not be used — and the distinction is load-bearing, because
 *  two of these mean "we could not read it" (ask the user) and two mean "the
 *  source told us something impossible" (refuse, and disbelieve the rest of
 *  what it said). */
export type DepthFault = 'absent' | 'unreadable' | 'negative' | 'implausible'

export type DepthReading = { readable: true; usd: PoolDepthUsd } | { readable: false; fault: DepthFault; raw: unknown }

/**
 * READ AN UNTRUSTED DEPTH — the checked mint.
 *
 * ⚠ `Number('')` IS 0, NOT NaN (found by UIGuy, 2026-08-07, while fixing this
 * same class in the launch flow — his own test caught his own first
 * implementation). So a blank field in an indexer response coerces to a
 * confident ZERO rather than to something a finiteness check would reject: it
 * would clear this reader, fail the floor, and refuse a pool that may be deep.
 * Non-numbers are therefore rejected BEFORE any numeric coercion, and `''` is
 * `absent`, never `0`.
 */
export function readPoolDepthUsd(raw: unknown): DepthReading {
  if (raw === null || raw === undefined || raw === '') return { readable: false, fault: 'absent', raw }
  if (typeof raw !== 'number') return { readable: false, fault: 'unreadable', raw }
  if (!Number.isFinite(raw)) return { readable: false, fault: 'unreadable', raw }
  if (raw < 0) return { readable: false, fault: 'negative', raw }
  if (raw > MAX_PLAUSIBLE_POOL_LIQUIDITY_USD) return { readable: false, fault: 'implausible', raw }
  return { readable: true, usd: raw as PoolDepthUsd }
}

/**
 * A THRESHOLD OF OURS, VALIDATED — `??` was never enough.
 *
 * ⚠⚠ `ctx.minLiquidityUsd ?? MIN_POOL_LIQUIDITY_USD` CATCHES null AND undefined
 * AND NOTHING ELSE, so a NaN threshold walked straight through into every
 * comparison below, where it made all of them false (independent review,
 * 2026-08-07 — HIGH, and the exact defect the gate-5 comment beside it
 * diagnoses in the DATA while repeating it in the CONFIG). Measured: a NaN
 * `minLiquidityUsd` with a one-dollar pool returned `ok`; two equal $400k pools
 * with a NaN `dominanceRatio` returned `ok` where an honest ratio asks.
 *
 * IT HEALS TO NOTHING, DELIBERATELY. Silently substituting the default would
 * make a caller's bug invisible for as long as it survives, while the verdict
 * kept looking authoritative — and this screen's verdict decides whether
 * someone's money goes into a pool. A range order being unavailable is
 * survivable; a safety screen returning `ok` off a threshold it could not read
 * is not. So an unreadable threshold REFUSES, loudly, naming itself as our bug.
 *
 * ZERO IS LEGITIMATE and must stay so: `verifyPastedPool` passes
 * `dominanceRatio: 0` on purpose, to waive the gate the user just answered.
 */
function readThreshold(given: number | undefined, fallback: number): number | null {
  if (given === undefined || given === null) return fallback
  if (!Number.isFinite(given) || given < 0) return null
  return given
}

const lower = (s: string) => String(s ?? '').toLowerCase()

/**
 * May we place a range order, and where?
 *
 * Every gate below is ordered so the CHEAPEST and most CATASTROPHIC checks run
 * first: a wrong-pair placement is unrecoverable, a wrong-tier one merely does
 * not fill. Nothing here returns `ok` on a maybe.
 */
export function assessPool(candidates: readonly PoolCandidate[], ctx: PoolSafetyContext): PoolVerdict {
  const token = lower(ctx.tokenAddress)
  const quotes = new Set((ctx.allowedQuoteAssets ?? []).map(lower).filter(Boolean))

  // GATE 0 — OUR OWN SETTINGS, before any claim about a pool. See
  // `readThreshold`: `??` let a NaN threshold through and a NaN threshold makes
  // every comparison below false, which returns `ok`.
  const floor = readThreshold(ctx.minLiquidityUsd, MIN_POOL_LIQUIDITY_USD)
  const ratio = readThreshold(ctx.dominanceRatio, DOMINANCE_RATIO)
  if (floor === null || ratio === null) {
    return {
      kind: 'refuse',
      reason: 'unreadable-safety-threshold',
      message: 'We could not read our own safety settings for this check, so we will not place anything. This is a fault on our side, not with your token.',
    }
  }

  if (!/^0x[0-9a-f]{40}$/.test(token)) {
    return { kind: 'refuse', reason: 'token-not-in-pool', message: 'We could not read which token this is, so we will not place anything.' }
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { kind: 'refuse', reason: 'no-candidates', message: 'We could not find a pool for this token, so there is nothing safe to place into.' }
  }

  // GATE 1 — the pool must actually contain the token they hold, by address.
  const holdsToken = candidates.filter((c) => lower(c.token0) === token || lower(c.token1) === token)
  if (holdsToken.length === 0) {
    return {
      kind: 'refuse',
      reason: 'token-not-in-pool',
      message: 'None of the pools we found actually hold this exact token, so we will not place into any of them.',
    }
  }

  // GATE 2 — THE CATASTROPHIC ONE. The other side must be an asset this chain
  // canonically settles in. A pool against an arbitrary counter-token would
  // ladder real holdings out into whatever that token is.
  const goodQuote = holdsToken.filter((c) => {
    const other = lower(c.token0) === token ? lower(c.token1) : lower(c.token0)
    return quotes.has(other)
  })
  if (goodQuote.length === 0) {
    return {
      kind: 'refuse',
      reason: 'no-recognised-quote-asset',
      message:
        'Every pool we found trades this token against something we do not recognise. Selling through one would turn your tokens into that asset, so we will not do it.',
    }
  }

  // GATE 3 — a range order is concentrated liquidity. V2 cannot hold one.
  const concentrated = goodQuote.filter((c) => c.venue === 'v3' || c.venue === 'v4')
  if (concentrated.length === 0) {
    return {
      kind: 'refuse',
      reason: 'no-concentrated-venue',
      message: 'This token only has an older-style pool, which cannot hold a ranged position. Selling through a range is not available for it.',
    }
  }

  // GATE 4 — it must exist on chain. An indexer row is a claim about the world;
  // the chain is the world. (The reverse is not fatal — see corroboration.)
  const real = concentrated.filter((c) => c.onChainConfirmed)
  if (real.length === 0) {
    return {
      kind: 'refuse',
      reason: 'not-on-chain',
      message: 'We could not confirm any of these pools on-chain, so we will not place into them.',
    }
  }

  // GATE 5 — an unreadable depth is not a small depth. If we cannot rank them,
  // we cannot claim the largest, and the honest move is to ask.
  //
  // ⚠⚠ THIS TESTED `== null` ONLY, AND NaN WALKED STRAIGHT PAST IT (found by
  // the hostile-number sweep the first time this module was swept,
  // 2026-08-07). The consequence was not cosmetic: every downstream comparison
  // on a NaN depth is FALSE, so `best.liquidityUsd < floor` did not fire, the
  // dominance ratio did not fire, and the screen returned **`ok`** — a pool of
  // unknown depth CLEARING the safety gate, and (via `nativeSellPath`)
  // confirming an exit that nothing had established. A depth arrives from a
  // third-party indexer or an on-chain estimate, so `Number('')`, a divide by
  // a zero reserve, or arithmetic on a failed read all produce exactly this.
  //
  // The field's own doc already said "Null = unreadable, which is NOT zero and
  // NOT ok" — the guard was written for one spelling of unreadable. A guard
  // written for `null` is a guard against `null` only.
  // ⚠ AND THE THREE FAULTS ARE NOT ONE FAULT (independent review, 2026-08-07).
  // The first cut of this gate answered `ask` for every unusable depth, which
  // was wrong in three separate ways:
  //
  //  · A NEGATIVE DEPTH WAS NOT CAUGHT AT ALL (HIGH). -1 is finite and under the
  //    ceiling, so it reached the ranking — and then gate 8's `runnerUp > 0`
  //    test is FALSE for it, which SWITCHES DOMINANCE OFF. Measured: a $30k best
  //    with a -1 runner-up returned `ok`, where an honest $29k runner-up asks.
  //    The wrong number bought a better verdict than the right one.
  //  · THE `ask` WAS A DEAD END (MEDIUM). An implausible depth asked the user to
  //    paste a pool; `verifyPastedPool` re-enters this same function, gate 5
  //    fires on the same unchanged number, and it asks again. NO pasteable value
  //    could ever resolve it — a question with no answer.
  //  · AND ITS SENTENCE WAS FALSE. "We cannot read how deep these pools are" for
  //    a read that SUCCEEDED and returned 1e15. Opposite implications: a source
  //    reporting 1e15 has not failed to answer, it has DISCREDITED ITSELF — and
  //    with it every other number it gave us, including the candidate list the
  //    `ask` was handing back for the user to choose from.
  //
  // So: a source that states something impossible REFUSES, and a read that did
  // not land ASKS. That is also why the ceiling being a strict `>` no longer
  // decides anything on its own — see `PoolDepthUsd` for the unit confusion the
  // ceiling alone could never close ($100k of 6-decimal USDC-raw is exactly
  // 1e11, which clears any ceiling set in dollars).
  const readings = real.map((c) => ({ c, d: readPoolDepthUsd(c.liquidityUsd) }))
  const discredited = readings.filter((r) => !r.d.readable && (r.d.fault === 'negative' || r.d.fault === 'implausible'))
  if (discredited.length > 0) {
    return {
      kind: 'refuse',
      reason: 'depth-implausible',
      message:
        'The depth reported for this token’s pools cannot be right, so we do not trust anything else that source told us about them and will not place into any of them.',
    }
  }
  if (readings.some((r) => !r.d.readable)) {
    return {
      kind: 'ask',
      reason: 'depth-unreadable',
      message: 'We cannot read how deep these pools are right now, so we cannot tell which is the right one. Paste the pool you want to use.',
      candidates: real,
    }
  }

  // every reading is `readable` past this point, so the depths below are the
  // BRANDED values rather than re-read raw fields — one read, one judgement.
  const ranked = [...readings]
    .map((r) => ({ c: r.c, usd: (r.d as { readable: true; usd: PoolDepthUsd }).usd }))
    .sort((a, b) => b.usd - a.usd)
  const best = ranked[0].c
  const bestUsd = ranked[0].usd
  const runnerUp = ranked[1]

  // GATE 6 — a floor, which is an identity check as much as a depth one.
  if (bestUsd < floor) {
    return {
      kind: 'refuse',
      reason: 'below-liquidity-floor',
      message: 'The deepest pool for this token is too thin to place into safely, so we will not.',
    }
  }

  // GATE 7 — we must be able to snap the range to the pool's own grid.
  //
  // ⚠ BOUNDED AT BOTH ENDS NOW (review, 2026-08-07): this had no upper bound, so
  // a tickSpacing of 1e9 returned `ok`. A spacing past what the factory can hold
  // means the number is not the thing we think it is, and we would snap a range
  // against a grid that does not exist.
  if (!Number.isInteger(best.tickSpacing) || (best.tickSpacing as number) <= 0 || (best.tickSpacing as number) > MAX_TICK_SPACING) {
    return {
      kind: 'refuse',
      reason: 'unusable-tick-spacing',
      message: 'We could not read this pool’s tick settings, so we cannot place an exact range in it.',
    }
  }

  // GATE 7b — AND THE FEE TIER, which this screen never read at all (review,
  // 2026-08-07). `feeBps` is half of a V3/V4 pool key: without it we cannot
  // identify the pool we claim to have chosen, let alone place into it. It was
  // asymmetric with `tickSpacing` — which IS validated — and rode out inside an
  // `ok` verdict as NaN or undefined, to be read by whoever built the key next.
  if (!Number.isInteger(best.feeBps) || (best.feeBps as number) < 0 || (best.feeBps as number) > MAX_POOL_FEE_BPS) {
    return {
      kind: 'refuse',
      reason: 'unusable-fee-tier',
      message: 'We could not read this pool’s fee setting, so we cannot identify it precisely enough to place into it.',
    }
  }

  // GATE 8 — DOMINANCE. Two comparable pools means we are choosing, not
  // identifying, and his instruction is that doubt goes to the user.
  if (runnerUp && runnerUp.usd > 0) {
    const lead = bestUsd / runnerUp.usd
    if (lead < ratio) {
      return {
        kind: 'ask',
        reason: 'two-pools-too-close',
        message:
          'This token has more than one pool of similar size, so we cannot be sure which one you mean. Paste the pool you want to use.',
        candidates: ranked.map((r) => r.c),
      }
    }
  }

  // GATE 9 — CORROBORATION. The chain found it and the indexer agrees. When
  // only one source knows about the pool we are relying on a single reading of
  // a fact that decides where someone's money goes.
  if (!best.indexerConfirmed) {
    return {
      kind: 'ask',
      reason: 'sources-disagree',
      message:
        'Only one of our two sources can see this pool, so we cannot confirm it is the main one. Paste the pool you want to use.',
      candidates: ranked.map((r) => r.c),
    }
  }

  return {
    kind: 'ok',
    pool: best,
    why: `Deepest pool by a clear margin, confirmed on-chain and by the index, quoted in a recognised asset.`,
  }
}

/** A pool address parsed out of something the user pasted. Null when the paste
 *  contains no address at all — we never "interpret" a paste beyond finding a
 *  well-formed address in it. */
export function parsePastedPool(input: string): string | null {
  const m = String(input ?? '').match(/0x[0-9a-fA-F]{40}/)
  return m ? m[0].toLowerCase() : null
}

/**
 * THE PASTE IS VERIFIED, NOT TRUSTED.
 *
 * When we ask someone which pool they mean, their answer settles the ambiguity
 * that made us ask — it does not settle whether the pool is safe. So the pasted
 * pool runs the SAME identity gates: real on-chain, concentrated venue, holds
 * their exact token, quoted in an asset we recognise, deep enough, snappable.
 * Only the dominance and corroboration gates are waived, because those existed
 * to answer "which one", and the user just answered it.
 *
 * A paste we cannot find among the candidates we actually looked up is refused
 * rather than fetched blind: that is the path where a pasted link from a
 * stranger becomes a signed transaction.
 */
export function verifyPastedPool(
  pasted: string,
  candidates: readonly PoolCandidate[],
  ctx: PoolSafetyContext,
): PoolVerdict {
  const id = parsePastedPool(pasted)
  if (!id) {
    return { kind: 'refuse', reason: 'no-candidates', message: 'That does not contain a pool address we can read.' }
  }
  const hit = candidates.find((c) => lower(c.id) === id)
  if (!hit) {
    return {
      kind: 'refuse',
      reason: 'not-on-chain',
      message: 'We could not find that pool among the pools for this token, so we will not place into it.',
    }
  }
  // Re-run the identity gates against this ONE candidate. Same function, same
  // rules — there is no second, laxer code path for a user-chosen pool.
  const single = assessPool([hit], { ...ctx, dominanceRatio: 0 })
  if (single.kind === 'ok') {
    return { kind: 'ok', pool: single.pool, why: 'You chose this pool, and it passed every safety check.' }
  }
  return single
}
