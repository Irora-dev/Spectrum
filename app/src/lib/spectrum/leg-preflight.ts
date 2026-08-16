// ─────────────────────────────────────────────────────────────────────────────
// LEG PRE-FLIGHT — ask the chain whether a leg can actually fill, BEFORE the
// review calls itself runnable.
//
// ⚠⚠ WHY THIS EXISTS. On 2026-08-15/16 the owner was refused roughly ten times
// in a row on one asset, at every size he tried, and each refusal arrived AFTER
// he had reviewed and consented. The cause turned out to be measurable in a
// single read: quoting as the batcher and executing as the batcher, that pool
// filled $100 and $200 and refused $400 and above, while the SAME pool filled
// $6,000 for an ordinary wallet. Nothing in the review knew that, so the app
// kept presenting an impossible plan as ready and discovering it at run time.
//
// A refusal the machine could have known before asking for consent is a bug in
// the asking, not in the run. This module is the read that closes that gap.
//
// WHAT IT IS NOT: it is not protection. The floors, the plausibility bracket and
// the contract's own MinBuyNotMet remain the security boundary, unchanged. This
// only decides whether to SHOW a leg as runnable, so its failure modes are
// deliberately soft: anything it cannot establish returns `unknown`, and an
// unknown leg is presented exactly as it is today. A pre-flight that refused on
// its own uncertainty would ground the whole app on one flaky endpoint.
//
// COST: one call per probed leg, and callers are expected to probe the legs
// most likely to fail rather than all of them (see `shouldPreflight`). The
// alternative is what happened: N wasted quotes, a wallet prompt, and a person
// re-pressing a door that could never work.
// ─────────────────────────────────────────────────────────────────────────────

/** What the chain said about this leg, right now. */
export type LegFillVerdict =
  /** The chain executed it. */
  | { kind: 'fillable' }
  /** The chain refused it, and the refusal is about THIS leg. */
  | { kind: 'refused'; reason: string }
  /** We could not establish either. Callers must treat this as "carry on". */
  | { kind: 'unknown'; why: string }

/** The single injected read: execute this leg's swap and resolve if it worked.
 *  Throwing (or resolving false) means the chain refused it. */
export type LegProber = (leg: { asset: string; sellAmountRaw: bigint; swapData: string }) => Promise<void>

/**
 * Should this leg be probed at all?
 *
 * Probing every leg would double the review's read cost for no benefit: a deep
 * major has never once failed this way. The signal that predicts failure is the
 * same one the tolerance already keys on — a leg whose own size moves its pool
 * — so `thinMarket` is the gate, and callers pass it straight through.
 *
 * Deliberately conservative: when in doubt, do not probe. A missed probe costs
 * the status quo; a gratuitous one costs every user latency on every review.
 */
export function shouldPreflight(leg: { thinMarket?: boolean; optional?: boolean }): boolean {
  // an optional leg already fails softly (skipped and refunded), so the cost of
  // discovering it late is small and the probe is not worth the round-trip
  if (leg.optional) return false
  return leg.thinMarket === true
}

/** A sentence a person can act on, per verdict. Kept here so the wording lives
 *  beside the law that produces it rather than in a component. */
export function preflightWords(symbol: string, verdict: LegFillVerdict): string | null {
  if (verdict.kind !== 'refused') return null
  return `$${symbol} can’t be filled at this size right now. The route accepts smaller amounts, so lower this holding or buy it on its own.`
}

/**
 * Probe one leg. Never throws: every failure of the PROBE ITSELF becomes
 * `unknown`, because a broken endpoint must not look like a broken market.
 */
export async function preflightLeg(
  leg: { symbol: string; asset: string; sellAmountRaw: bigint; swapData: string },
  probe: LegProber,
  opts: { timeoutMs?: number } = {},
): Promise<LegFillVerdict> {
  // ⚠ A PROBE MUST NOT BE ABLE TO HANG THE REVIEW. Without a bound, one slow
  // endpoint turns "your review is ready" into a spinner with no resolution —
  // and the review is the surface a person is waiting on.
  const timeoutMs = opts.timeoutMs ?? 6_000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      probe({ asset: leg.asset, sellAmountRaw: leg.sellAmountRaw, swapData: leg.swapData }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('__preflight_timeout__')), timeoutMs)
      }),
    ])
    return { kind: 'fillable' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === '__preflight_timeout__') return { kind: 'unknown', why: 'the check did not answer in time' }
    // ⚠⚠ DISTINGUISHING "THE MARKET REFUSED" FROM "WE COULD NOT ASK" IS THE
    // WHOLE JOB. A transport failure that reads as a market refusal would tell
    // a person their asset is untradeable when the truth is that our endpoint
    // blinked — the read-failed law, which this lane has broken before and
    // paid for. Only an actual execution revert counts as a refusal.
    if (/network|fetch|timeout|socket|econn|rate limit|429|502|503|504/i.test(msg))
      return { kind: 'unknown', why: 'we could not reach the network to check' }
    return { kind: 'refused', reason: msg.slice(0, 200) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Probe several legs concurrently, returning a verdict per leg keyed by asset.
 * Concurrency is bounded by the caller's leg count, which the economic leg cap
 * already holds to a small number.
 */
export async function preflightLegs(
  legs: readonly { symbol: string; asset: string; sellAmountRaw: bigint; swapData: string }[],
  probe: LegProber,
  opts: { timeoutMs?: number } = {},
): Promise<Map<string, LegFillVerdict>> {
  const out = new Map<string, LegFillVerdict>()
  const verdicts = await Promise.all(legs.map((l) => preflightLeg(l, probe, opts)))
  legs.forEach((l, i) => out.set(l.asset.toLowerCase(), verdicts[i]))
  return out
}
