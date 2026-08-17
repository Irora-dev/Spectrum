import { decodeFunctionData, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import { BATCH_FEE_BPS } from './allocation'
import { batcherAbi, type ComposedBatchBuy } from './batcher'
import { portfolioBatcherAbiGen2, maxCommittedFor, portfolioBatcherAbi, type ComposedPortfolioBatchBuy } from './portfolio-batcher'
import { showSymbol } from './safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// THE DISPLAYED-VS-SIGNED GATE (security queue item 1, 2026-08-07 — the
// review's number and the signature's number must be THE SAME NUMBER).
//
// The review station renders money from `AssembledBatchBuy.legs` (its
// documented data source); the wallet signs bytes encoded from
// `composed.args`. Those are two DIFFERENT projections of the plan, built by
// different code, and everything between them — the assembly's leg mapping,
// the composer, encodeFunctionData, any code that touches the prepared call
// afterwards — is surface where they can diverge, by bug or by compromise.
// This gate DECODES THE EXACT BYTES the wallet would sign and diffs every
// money-bearing field against what the review showed. A mismatch refuses in
// review words, before any signature exists.
//
// WHAT THIS GATE CANNOT SEE, stated plainly (batcher.ts's FundingRaw header
// says the same): a wrong number SHARED by display and calldata — both
// projections reading one poisoned source — matches perfectly here. That
// class is closed at the type layer (the FundingRaw brand, the floor
// discipline's own pins), not by this diff. This gate binds "what the review
// rendered from" to "what the wallet signs"; it does not re-audit the plan.
//
// DESIGN LAWS:
//  · DECODE THE BYTES, NEVER TRUST THE ARGS. The existing recipient check
//    reads `composed.args` — the object that PRODUCED the bytes. This gate
//    reads the bytes themselves with the pinned ABI, so a divergence in or
//    after encoding is caught too.
//  · FAIL CLOSED. No shown record, an unknown selector, an undecodable call,
//    an extra call in the bundle — each refuses. A verification that silently
//    skips when its input is missing is the law-8 failure wearing a new coat.
//  · EXACT EQUALITY ONLY. Raw bigints and lowercased addresses compare with
//    ===. There is no tolerance here by construction: the review renders from
//    the assembled legs, so any honest pipeline shows the exact raws it
//    composes. A tolerance would be a bracket, and brackets compose (the
//    2026-08-07 lesson: a leg reported 30 bps while permitting 2,024).
//  · SAME ORDER. Legs must match position by position — the chain reports
//    RequiredLegFailed(index) positionally, so order IS meaning.
//  · ⚠ AND A CATCH-ALL, BECAUSE A FIELD LIST IS A MEMORY TEST (A6 verify pass,
//    2026-08-07 — this gate shipped checking a strict SUBSET of the money in
//    the calldata while claiming to check all of it). `ShownStepReview` holds
//    only what the review renders, so the first cut waved through every field
//    it does not: `hubMinOut` gutted to 1 (the hub-side floor — one field over
//    from the leg floor whose single-unit change it refuses), `feeBps` 30→900
//    with `integrator` repointed, a `deadline` in the year 5138, and a leg's
//    whole ROUTE — `venue`, `v2Pair`, `ethPool.hooks` (a V4 hook is arbitrary
//    code inside the swap). All six passed.
//    So the last check RE-ENCODES the composition and demands the bytes equal
//    it EXACTLY. That closes the entire class without enumerating it — every
//    field, present and future — plus trailing-garbage calldata that decodes
//    cleanly and would otherwise slip past any field-by-field read. The named
//    checks stay, because they tell the user WHICH number moved; the catch-all
//    is what makes the coverage claim true.
// ─────────────────────────────────────────────────────────────────────────────

/** One leg as the review showed it — built from `AssembledBatchBuy.legs`
 *  (asset, budgetRaw, minOutRaw, optional are exactly what the station
 *  renders its rows from). `symbol` is for refusal sentences only and is
 *  bounded at display (safe-copy law). */
export interface ShownLeg {
  symbol: string
  asset: Address
  budgetRaw: bigint
  /**
   * The per-leg floor AS DISPLAYED — or `null` where the review showed none.
   *
   * ⚠⚠ THIS WAS NON-NULLABLE AND THAT INVERTED THIS MODULE'S WHOLE INTENT
   * (independent review, UIGuy 2026-08-07, on the shape rather than the logic).
   * Its documented source — `AssembledBatchBuy.legs` — is `bigint | null`, and a
   * BASKET leg is minted `minOutRaw: null` while its COMPOSED counterpart gets a
   * real floor (the legacy haircut, applied at composition, after the review has
   * rendered). So the two sides genuinely differ, and the old type forced the
   * producer to resolve `bigint | null` to `bigint` exactly where it had nothing
   * honest to put. Every way out was bad, and MEASURED end-to-end:
   *   · `?? 0n` — the idiomatic reach — made the strict compare below fire, so
   *     EVERY basket-containing batch was refused at confirm with "a different
   *     protection floor than the review showed" on a correctly composed run.
   *     (Reproduced: assembled `null`, composed `49301999999999997186`.) That is
   *     the guard-written-for-one-spelling-of-missing class again: `??` defends
   *     against null and then hands a confidently wrong number to a strict test.
   *   · reading the COMPOSED value — passes always, and is the `f(x) === f(x)`
   *     vacuity this file's brand exists to prevent.
   *   · omitting the leg — refused by the bundle-shape length check.
   * The type made the vacuous option the only one that compiled AND worked.
   *
   * So absence is expressible now and gets its OWN case. WHAT null COSTS, stated
   * narrowly because the honest claim is much smaller than the old type implied:
   * a null-floor leg is STILL fully covered against calldata tampering, because
   * the catch-all re-encode pins every leg's `minOut` to the composition
   * byte-for-byte. What is NOT covered is the comparison against WHAT THE USER
   * SAW — because nothing was shown. That is the same split this module already
   * names: the field checks say WHICH number moved, the catch-all makes the
   * coverage claim true.
   *
   * The better product fix — display the basket leg's floor so there IS a shown
   * value — is a composition-ordering change (the haircut happens after the
   * review renders) and is deliberately not coupled to this gate landing.
   */
  minOutRaw: bigint | null
  optional: boolean
}

/** What the review disclosed for one funding step, frozen at confirm time. */
export interface ShownStepReviewFields {
  chainId: number
  fundingAsset: Address
  fundingTotalRaw: bigint
  /** The account the run was constructed for — everything pays out here. */
  recipient: Address
  legs: ShownLeg[]
  /** The exact-amount ERC-20 approvals the review disclosed (empty when the
   *  funding asset is native). An approval the user never saw must not ride
   *  the bundle, and one they saw must not grow. */
  approvals: { token: Address; amountRaw: bigint }[]
}

/**
 * ⚠⚠ BRANDED, AND THE BRAND IS THIS GATE'S ENTIRE VALUE (T1-2, independent
 * review 2026-08-07).
 *
 * This whole module compares WHAT THE USER SAW against WHAT WILL BE SIGNED. That
 * comparison is worth exactly what its two sides INDEPENDENTLY know — and the
 * cheapest way to implement `shownFor` is to walk the composition and build a
 * review out of it, which produces `f(x) === f(x)`: a gate that passes every
 * tamper because both sides came from the tampered object. That is not a
 * hypothetical failure mode in this lane. It is what the P8 catch-all did the
 * same day, one file over: it re-encoded `composed.args` and compared the result
 * to the bytes encoded from `composed.args`, and all six tampers it claimed to
 * close were still open.
 *
 * SO THE TYPE MAKES THE SOURCE A DECISION. Nothing structurally shaped like a
 * review is a `ShownStepReview`; only `shownAtReviewSurface` mints one, it takes
 * the DISPLAYED values, and there is exactly one honest place to call it — the
 * component that rendered those numbers to a person, at the moment they
 * confirmed. A caller that wants to synthesise one from the composition has to
 * write that call itself, in a diff a reviewer can see, against a doc comment
 * that says not to.
 *
 * THE BRAND IS NOT A PROOF, and overclaiming it would be this lane's other
 * recurring sin: a determined caller can still assemble the fields from
 * anything. What it removes is the SILENT path — the accidental structural match
 * where nobody chose. `compositionLawsBroken` carries the half that does not
 * depend on the wiring at all, comparing the composition to things it was never
 * derived from (our fee constant, the signer, the chain's clock).
 *
 * WHY NOW: `shownFor` has NO production implementation yet — it is a required
 * argument of `useExecutionRunner` that no component supplies. The brand lands
 * before the producer, so its author meets the constraint once while writing it,
 * rather than as a refactor of working code nobody schedules.
 */
export type ShownStepReview = ShownStepReviewFields & { readonly __brand: 'ShownStepReview' }

/** THE ONLY MINT. Call it where the numbers were RENDERED — see the type's note
 *  on why deriving these fields from the composition makes the gate vacuous.
 *
 *  It validates the shape rather than the values, because the values are the
 *  thing under test: a review with no legs, or a leg whose budget is negative,
 *  is not a rendering of anything a person confirmed, and letting it through
 *  would give the gate a comparison it cannot fail. */
export function shownAtReviewSurface(fields: ShownStepReviewFields): ShownStepReview {
  if (!Number.isInteger(fields.chainId) || fields.chainId <= 0) throw new RangeError('a shown review needs the chain it was shown for')
  if (!Array.isArray(fields.legs) || fields.legs.length === 0) throw new RangeError('a shown review with no legs is not a rendering of anything')
  if (fields.fundingTotalRaw < 0n) throw new RangeError('a shown review cannot disclose a negative funding total')
  for (const l of fields.legs) {
    if (l.budgetRaw < 0n) throw new RangeError(`the shown leg for ${l.symbol} carries a negative raw amount`)
    if (l.minOutRaw !== null && l.minOutRaw < 0n) throw new RangeError(`the shown leg for ${l.symbol} carries a negative floor`)
    // ⚠ A LITERAL ZERO FLOOR IS NOW REJECTED (same review). It used to be
    // ACCEPTED as a valid rendering, which is how the `?? 0n` producer minted a
    // review successfully and pushed its own defect downstream to surface as a
    // confirm-time refusal blaming the BATCH for a divergence the REVIEW
    // introduced. Now that `null` says "no floor shown", `0n` can only mean the
    // other thing — a leg with no protection presented as protected — and this
    // mint is the one function that knows it is being handed a claim about what
    // a person saw.
    if (l.minOutRaw === 0n)
      throw new RangeError(
        `the shown leg for ${l.symbol} claims a zero protection floor — use null to say the review showed no floor, because zero says it showed one and it was nothing`,
      )
  }
  for (const a of fields.approvals ?? []) {
    if (a.amountRaw < 0n) throw new RangeError('a shown approval cannot be for a negative amount')
  }
  return fields as ShownStepReview
}

const approveAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const low = (a: string) => a.toLowerCase()

/** The largest share of a batch a SKIPPABLE leg may carry, in percent.
 *
 *  ⚠ THIS IS THE UNARGUABLE FLOOR, NOT A CALIBRATED THRESHOLD, and the
 *  distinction is deliberate. A leg carrying the MAJORITY of the batch that the
 *  contract may silently drop means most of someone's money can fail to be
 *  invested while the run reports success and the funding pull and fee both
 *  happen anyway — indefensible at any calibration, so it needs no live data to
 *  justify. A TIGHTER bound would protect more, and it is a genuine product
 *  decision rather than a module one: a leg can legitimately be both a large
 *  share of a small batch AND thin against an illiquid pool, and refusing that
 *  outright blocks an allocation the user may well want. The reviewer's own
 *  answer on the neighbouring question applies here too — the false-refusal
 *  side can be worse than what it prevents. It belongs with the owner beside the M2
 *  concentration threshold, which is the same family of question, and is on his
 *  desk as such. Do not quietly tune this into a policy nobody ruled. */
export const MAX_SKIPPABLE_SHARE_PCT = 50

/**
 * Diff the prepared calls against what the review rendered. `null` = every
 * money-bearing field in the bytes is the one the user saw. A string is the
 * refusal sentence, in review words, naming the FIRST divergence found.
 *
 * `calls` is the exact submission bundle (approvals then the batch, in
 * order); `batcher` is the seated batcher address for the chain; `composed`
 * is the composition those bytes were built from — REQUIRED, because it is
 * what makes the coverage complete rather than a list of remembered fields.
 */
export function diffDisplayedVsSigned(
  calls: { to: Address; data: Hex; value: bigint }[],
  batchIndex: number,
  batcher: Address,
  shown: ShownStepReview,
  composed: ComposedBatchBuy,
): string | null {
  // ── the bundle's shape: exactly the disclosed approvals, then the batch ──
  if (calls.length !== shown.approvals.length + 1)
    return `this would send ${calls.length} transaction${calls.length === 1 ? '' : 's'} where the review showed ${shown.approvals.length + 1} — nothing was signed.`
  if (batchIndex !== shown.approvals.length || !calls[batchIndex])
    return 'the batch is not where the review said it would be in this bundle — nothing was signed.'

  // ── each approval: the token shown, the batcher as spender, the exact amount ──
  for (const [i, expected] of shown.approvals.entries()) {
    const call = calls[i]
    if (low(call.to) !== low(expected.token))
      return 'a token approval in this bundle targets a different token than the review showed — nothing was signed.'
    if (call.value !== 0n) return 'a token approval in this bundle carries money it should not — nothing was signed.'
    let spender: Address
    let amount: bigint
    try {
      const dec = decodeFunctionData({ abi: approveAbi, data: call.data })
      spender = dec.args[0]
      amount = dec.args[1]
    } catch {
      return 'a call in this bundle is not the approval the review showed — nothing was signed.'
    }
    if (low(spender) !== low(batcher))
      return 'a token approval in this bundle names a different spender than the batch contract — nothing was signed.'
    if (amount !== expected.amountRaw)
      return 'a token approval in this bundle is for a different amount than the review showed — nothing was signed.'
    // ⚠ AND BYTE-EXACT. viem DECODES an approve with trailing garbage appended
    // and returns the right spender and amount, so the field checks above pass
    // on calldata that is not the call we meant (A6 review, 2026-08-07). The
    // batch has this pin; the approvals did not. Unlike the batch's re-encode
    // this is not a tautology: these bytes came from `approvalsFor`, and the
    // expectation comes from the REVIEW — two different objects.
    if (call.data !== encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [batcher, expected.amountRaw] }))
      return 'a token approval in this bundle is not exactly the approval the review showed — nothing was signed.'
  }

  // ── the batch call: decode the BYTES with the pinned ABI ──
  const batch = calls[batchIndex]
  if (low(batch.to) !== low(batcher)) return 'this batch would go to a different contract than the one we deployed to — nothing was signed.'
  // The native value is money too, and it is a LAW rather than a shown field:
  // native funding rides the pull as the call's value, ERC-20 funding rides
  // zero (composeBatchBuy's own equation). A diverging value is the most
  // direct theft shape there is.
  const expectedValue = low(shown.fundingAsset) === zeroAddress ? shown.fundingTotalRaw : 0n
  if (batch.value !== expectedValue)
    return 'this batch would send a different amount of the network’s own money than the review showed — nothing was signed.'
  let decoded: ReturnType<typeof decodeFunctionData<typeof batcherAbi>>
  try {
    decoded = decodeFunctionData({ abi: batcherAbi, data: batch.data })
  } catch {
    return 'we could not read this transaction back as the batch you reviewed — nothing was signed.'
  }
  if (decoded.functionName !== 'batchBuy')
    return 'this transaction is not the batch purchase you reviewed — nothing was signed.'

  const [legs, fundingAsset, fundingTotal, p] = decoded.args

  if (low(p.recipient) !== low(shown.recipient))
    return 'this batch would pay out to a different address than your own wallet — nothing was signed.'
  if (low(fundingAsset) !== low(shown.fundingAsset))
    return 'this batch would spend a different asset than the review showed — nothing was signed.'
  if (fundingTotal !== shown.fundingTotalRaw)
    return 'this batch would pull a different total than the review showed — nothing was signed.'

  if (legs.length !== shown.legs.length)
    return `this batch carries ${legs.length} asset${legs.length === 1 ? '' : 's'} where the review showed ${shown.legs.length} — nothing was signed.`
  for (const [i, shownLeg] of shown.legs.entries()) {
    const leg = legs[i]
    const name = `$${showSymbol(shownLeg.symbol)}`
    if (low(leg.asset) !== low(shownLeg.asset))
      return `${name}: this batch would buy a different asset than the review showed in its place — nothing was signed.`
    if (leg.budget !== shownLeg.budgetRaw)
      return `${name}: this batch commits a different amount than the review showed — nothing was signed.`
    if (shownLeg.minOutRaw === null) {
      // the review displayed no floor for this leg, so there is nothing to
      // compare it against — but a leg with NO protection at all is still
      // refused, and the catch-all below still pins this minOut to the
      // composition byte-for-byte (see the field's note on what null costs)
      if (leg.minOut <= 0n) return `${name}: this batch carries no protection floor at all — nothing was signed.`
    } else if (leg.minOut !== shownLeg.minOutRaw) {
      return `${name}: this batch carries a different protection floor than the review showed — nothing was signed.`
    }
    if (leg.optional !== shownLeg.optional)
      return shownLeg.optional
        ? `${name}: the review said this asset may be skipped, but the batch would treat it as required — nothing was signed.`
        : `${name}: the review said this asset is required, but the batch would allow it to be skipped — nothing was signed.`
  }

  // ── THE CATCH-ALL: the bytes must BE the composition, to the byte ──
  // Everything above names a divergence in the user's own terms, and covers
  // only what the review renders. This covers the rest — the hub floor, the
  // fee and its recipient, the deadline, every leg's route and reference
  // price, and any field this contract grows later — by re-encoding the
  // composition and demanding equality. It also catches calldata that decodes
  // cleanly with bytes appended, which no field-by-field read can see.
  let canonical: Hex
  try {
    canonical = encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args: composed.args })
  } catch {
    // ⚠ THIS THREW A RAW viem ERROR AT THE USER (A6 review). A mis-checksummed
    // address in the composition escaped as `Address "0x…" is invalid.
    // Version: viem@2.x` — a crash wearing a refusal's clothes, against this
    // module's own law that failures are sentences.
    return 'we could not re-check this transaction against the batch we prepared — nothing was signed.'
  }
  if (batch.data !== canonical)
    return 'this transaction does not match the batch we prepared for you, in a part of it we do not put on screen — nothing was signed.'
  if (batch.value !== composed.value)
    return 'this transaction carries a different amount of the network’s own money than the batch we prepared — nothing was signed.'

  return null
}

/**
 * THE HALF THAT IS NOT A TAUTOLOGY — the composition against things it was
 * NOT derived from.
 *
 * ⚠⚠ WITHOUT THIS, THE BYTE CHECK ABOVE PROVES NOTHING AT ITS ONLY CALL SITE
 * (A6 review, 2026-08-07 — CRITICAL). `runner-effects` builds the calldata
 * with `encodeFunctionData({abi, functionName, args: composed.args})` and the
 * gate re-encodes the same object with the same expression: `f(x) === f(x)`.
 * Measured — all six tampers the PREVIOUS review found still returned `null`
 * once the tamper lived in the COMPOSITION, which is exactly where the threat
 * lives, because `composeStep` is a caller-supplied closure and the gate's own
 * threat list names "the composer".
 *
 * A comparison is only worth what its two sides independently know. So this
 * checks the composed values against the ones the gate can obtain WITHOUT the
 * composer: our own fee constant, the signer's address, the CHAIN's clock, and
 * the contract's own laws. That is what closes hubMinOut, feeBps, aggMinBps,
 * the deadline and the recipient — not the re-encode.
 */
export function compositionLawsBroken(
  composed: ComposedBatchBuy,
  independent: { account: Address; chainNowSec: number; maxDeadlineWindowSec: number },
): string | null {
  const [legs, , fundingTotal, p] = composed.args

  if (low(p.recipient) !== low(independent.account))
    return 'this batch would pay out to an address that is not the wallet running it — nothing was signed.'
  // the fee is OUR constant, not the composer's opinion
  if (p.feeBps !== BATCH_FEE_BPS) return 'this batch carries a different fee than the one this app charges — nothing was signed.'
  // the hub floor is the aggregate protection on the funding swap; zero is no protection
  if (!(p.hubMinOut > 0n)) return 'this batch carries no protection floor on its funding swap — nothing was signed.'
  // we never compose an aggregator tolerance; a non-zero one is not ours
  if (p.aggMinBps !== 0) return 'this batch carries a routing tolerance this app never sets — nothing was signed.'
  // money time is CHAIN time, and the chain clock is independent of the composer
  const deadline = Number(p.deadline)
  if (!Number.isFinite(deadline) || deadline <= independent.chainNowSec)
    return 'this batch would arrive already expired on the network’s own clock — nothing was signed.'
  if (deadline - independent.chainNowSec > independent.maxDeadlineWindowSec)
    return 'this batch would stay signable for far longer than we allow — nothing was signed.'
  if (!(fundingTotal > 0n)) return 'this batch pulls nothing — nothing was signed.'
  for (const leg of legs) {
    if (!(leg.budget > 0n)) return 'part of this batch commits nothing — nothing was signed.'
    if (!(leg.minOut > 0n)) return 'part of this batch carries no protection floor — nothing was signed.'
  }

  // ── `optional` — CRITICAL-when-live 3 (independent pass, 2026-08-08) ────────
  // The strict displayed-vs-signed comparison CANNOT police this flag, and the
  // reason is structural rather than a weak comparison: the shown side and the
  // composed side are the SAME PROPERTY OF THE SAME OBJECT. assemble-batch.ts
  // :301 and :363 both read `planned.legs[i]`, produced once at plan-legs.ts
  // :178-189, so `===` compares a value with itself. Measured by the reviewer:
  // a planted `>=`→`<` in the thinness test made two HEALTHY legs compose
  // `optional: true` on BOTH sides, the gate returned null, and 132 tests
  // passed. It cannot be closed by strengthening a comparison that is already
  // strict — only by a source the composer did not produce.
  //
  // These two laws are that source. Neither asks whether the thinness maths was
  // right; both read the SIGNED calldata and measure something the thinness
  // computation never looks at — the shape of the batch itself. `optional`
  // means the contract MAY SILENTLY SKIP this leg, so what matters here is not
  // whether a pool is deep but how much of someone's money can vanish quietly.
  const optionalLegs = legs.filter((l) => l.optional)
  // portfolio-batcher's own header records this outcome as already-observed —
  // "a batch of all-optional legs SUCCEEDED having bought nothing" — and
  // nothing on this path checked for it. Such a batch can report success having
  // done nothing, while the funding pull and the fee both still happen.
  // ⚠ `legs.length > 1` IS LOAD-BEARING, and leaving it out was a FALSE REFUSAL
  // I shipped for several hours (found 2026-08-08 by asking where tonight's own
  // work was most likely wrong). A user buying ONE thin asset gets a single-leg
  // batch whose only leg is marked skippable — and this law refused the entire
  // purchase. That is not the harm the sentence describes: "completed having
  // bought nothing" is about a batch whose OTHER legs succeeded while everything
  // was quietly dropped. With one leg there are no others, and skippability
  // exists precisely to stop one failing leg reverting the rest.
  //
  // Blocking a legitimate purchase is the worse error here — the reviewer's own
  // reject-don't-clamp answer, which I had quoted at them hours before walking
  // into it. The REAL question this exposes is upstream and is the owner's: should a
  // lone leg ever be marked skippable at all, given that skipping it converts a
  // revert (gas, no fee, nothing bought) into a silent fee-for-nothing? Asked on
  // his desk; not decided here.
  if (optionalLegs.length > 0 && legs.length > 1 && optionalLegs.length === legs.length)
    return 'every part of this batch is marked skippable, so it could complete having bought nothing — nothing was signed.'

  // A leg is "optional" because it is small against a POOL. That says nothing
  // about how large it is against the USER'S OWN BATCH, and those are
  // independent quantities — which is precisely why this catches a wrong flag
  // that the thinness inputs never could. Silently dropping a third of someone's
  // allocation is not a thin leg, whatever the depth maths concluded.
  // ⚠ AND `legs.length > 1` HERE FOR THE SAME REASON, which I found only after
  // fixing it one law above: a single-leg batch's only leg necessarily carries
  // 100% of that batch, so this comparison is trivially true and refuses every
  // legitimate single-asset buy. "A large share" is a statement about a leg
  // relative to OTHER legs; with none, it says nothing. Both of my new laws
  // false-refused the same case, and the second was invisible until the first
  // stopped firing — a fix can hide its own sibling.
  const totalBudget = legs.reduce((s, l) => s + l.budget, 0n)
  if (totalBudget > 0n && legs.length > 1) {
    for (const leg of optionalLegs)
      if (leg.budget * 100n > totalBudget * BigInt(MAX_SKIPPABLE_SHARE_PCT))
        return 'part of this batch is marked skippable while carrying a large share of the money — a leg that big must not be dropped silently. Nothing was signed.'

    // ⚠⚠ AND THE AGGREGATE, which the per-leg loop above does NOT imply (cold
    // lens 1, 2026-08-08 — HIGH, and it is this finding's own shape surviving
    // its own fix). The loop tests each leg individually, so the law was
    // non-monotonic in the very quantity it claims to bound. Measured through
    // the real assembleBatchBuy:
    //     1 optional leg  @51%              → REFUSED
    //     3 optional legs @25% (75% total)  → passed
    //     9 optional legs @10% (90% total)  → passed
    // 51% in one leg refused while 90% across nine did not. Worse, the comment
    // beside it argued the AGGREGATE harm — "silently dropping a third of
    // someone's allocation is not a thin leg" — while the code implemented a
    // per-leg bound. I wrote the right reason next to the wrong check.
    //
    // Both laws are kept: the per-leg one catches ONE oversized skippable leg,
    // this one catches MANY small ones, and neither subsumes the other.
    const optionalBudget = optionalLegs.reduce((s, l) => s + l.budget, 0n)
    if (optionalBudget * 100n > totalBudget * BigInt(MAX_SKIPPABLE_SHARE_PCT))
      return 'most of this batch is marked skippable, so the contract could drop the bulk of it and still report success — nothing was signed.'
  }

  // ⚠⚠ CONSERVATION, CHECKED OUTSIDE THE COMPOSER (cold lens 2, 2026-08-08 —
  // HIGH: `budget` is the `optional` finding's unfixed structural sibling).
  // assemble-batch composes `budgetRaw: raws[i]` and SHOWS `budgetRaw: raws[i]`
  // from the same array, so the strict diff is f(x) === f(x) for exactly the
  // reason `optional` was, and it never got the independent source that one did.
  // Measured with the composition's legs mutated to 1 wei each against a
  // 1,000,000 pull: composeBatchBuy refuses, but this gate and the byte diff
  // BOTH returned null. The only conservation law in the tree lives inside
  // composeBatchBuy (batcher.ts:447) — which is precisely the surface this
  // file's own header names as the adversary, since composeStep is a
  // caller-supplied closure.
  //
  // This is independent in the way that matters: it uses OUR fee constant and
  // the funding equation, not the composer's arithmetic, and it reads the
  // SIGNED tuple. A tamperer who changes leg budgets breaks the sum; one who
  // changes both consistently has to preserve the invariant, which is the whole
  // point of a conservation law rather than a comparison.
  const budgetSum = legs.reduce((s, l) => s + l.budget, 0n)
  const spendable = fundingTotal - (fundingTotal * BigInt(BATCH_FEE_BPS)) / 10_000n
  if (budgetSum !== spendable)
    return `this batch would pull ${fundingTotal} but its legs commit ${budgetSum} rather than the ${spendable} left after the fee — two layers disagree about the money. Nothing was signed.`

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PORTFOLIO-CONTRACT TWINS (the executor migration, the owner's runway order
// 2026-08-13). Same architecture as the legacy pair above — the field checks
// speak in the user's own terms, the catch-all re-encode pins the rest, and
// the LAWS half compares against sources the composer did not produce. Twinned
// rather than generalized: the two contracts genuinely differ (nonpayable,
// 0x swapData per leg, burnSwapData, no hub floor, no agg tolerance), and a
// shared function would need exactly the conditionals a tamper hides in.
// ─────────────────────────────────────────────────────────────────────────────

/** The bundle-shape + approvals half, shared verbatim by both gates: exactly
 *  the disclosed approvals, each to its shown token, the batcher as spender,
 *  the exact amount, BYTE-EXACT (viem decodes appended-garbage calldata
 *  cleanly, so field checks alone pass on bytes that are not the call). */
function approvalsDiverge(
  calls: { to: Address; data: Hex; value: bigint }[],
  batchIndex: number,
  batcher: Address,
  shown: ShownStepReview,
): string | null {
  if (calls.length !== shown.approvals.length + 1)
    return `this would send ${calls.length} transaction${calls.length === 1 ? '' : 's'} where the review showed ${shown.approvals.length + 1} — nothing was signed.`
  if (batchIndex !== shown.approvals.length || !calls[batchIndex])
    return 'the batch is not where the review said it would be in this bundle — nothing was signed.'
  for (const [i, expected] of shown.approvals.entries()) {
    const call = calls[i]
    if (low(call.to) !== low(expected.token))
      return 'a token approval in this bundle targets a different token than the review showed — nothing was signed.'
    if (call.value !== 0n) return 'a token approval in this bundle carries money it should not — nothing was signed.'
    let spender: Address
    let amount: bigint
    try {
      const dec = decodeFunctionData({ abi: approveAbi, data: call.data })
      spender = dec.args[0]
      amount = dec.args[1]
    } catch {
      return 'a call in this bundle is not the approval the review showed — nothing was signed.'
    }
    if (low(spender) !== low(batcher))
      return 'a token approval in this bundle names a different spender than the batch contract — nothing was signed.'
    if (amount !== expected.amountRaw)
      return 'a token approval in this bundle is for a different amount than the review showed — nothing was signed.'
    if (call.data !== encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [batcher, expected.amountRaw] }))
      return 'a token approval in this bundle is not exactly the approval the review showed — nothing was signed.'
  }
  return null
}

/** The portfolio contract's displayed-vs-signed gate (law P8, new shape). */
export function diffDisplayedVsSignedPortfolio(
  calls: { to: Address; data: Hex; value: bigint }[],
  batchIndex: number,
  batcher: Address,
  shown: ShownStepReview,
  composed: ComposedPortfolioBatchBuy,
): string | null {
  const bundle = approvalsDiverge(calls, batchIndex, batcher, shown)
  if (bundle) return bundle

  const batch = calls[batchIndex]
  if (low(batch.to) !== low(batcher)) return 'this batch would go to a different contract than the one we deployed to — nothing was signed.'
  // nonpayable, ERC-20 funding only: ANY native value is money the review
  // could never have shown (simpler and stricter than the legacy value law)
  if (batch.value !== 0n)
    return 'this batch would send the network’s own money where none belongs — nothing was signed.'

  // decode with the COMPOSED generation's ABI: gen-2 bytes read back only
  // through the gen-2 tuple, and a generation mismatch between what was
  // composed and what was signed must land here as unreadable, never as a
  // lucky parse
  let decoded: ReturnType<typeof decodeFunctionData<typeof portfolioBatcherAbi>>
  try {
    decoded =
      composed.generation === 2
        ? (decodeFunctionData({ abi: portfolioBatcherAbiGen2, data: batch.data }) as never)
        : decodeFunctionData({ abi: portfolioBatcherAbi, data: batch.data })
  } catch {
    return 'we could not read this transaction back as the batch you reviewed — nothing was signed.'
  }
  if (decoded.functionName !== 'batchBuy')
    return 'this transaction is not the batch purchase you reviewed — nothing was signed.'

  const [legs, fundingAsset, fundingTotal, p] = decoded.args

  if (low(p.recipient) !== low(shown.recipient))
    return 'this batch would pay out to a different address than your own wallet — nothing was signed.'
  if (low(fundingAsset) !== low(shown.fundingAsset))
    return 'this batch would spend a different asset than the review showed — nothing was signed.'
  if (fundingTotal !== shown.fundingTotalRaw)
    return 'this batch would pull a different total than the review showed — nothing was signed.'

  if (legs.length !== shown.legs.length)
    return `this batch carries ${legs.length} asset${legs.length === 1 ? '' : 's'} where the review showed ${shown.legs.length} — nothing was signed.`
  for (const [i, shownLeg] of shown.legs.entries()) {
    const leg = legs[i]
    const name = `$${showSymbol(shownLeg.symbol)}`
    if (low(leg.buyToken) !== low(shownLeg.asset))
      return `${name}: this batch would buy a different asset than the review showed in its place — nothing was signed.`
    if (leg.sellAmount !== shownLeg.budgetRaw)
      return `${name}: this batch commits a different amount than the review showed — nothing was signed.`
    if (shownLeg.minOutRaw === null) {
      // same semantics as the legacy gate: no floor was DISPLAYED, so there is
      // nothing to compare — but a leg with no protection at all still refuses,
      // and the catch-all pins these bytes to the composition regardless
      if (leg.minBuyAmount <= 0n) return `${name}: this batch carries no protection floor at all — nothing was signed.`
    } else if (leg.minBuyAmount !== shownLeg.minOutRaw) {
      return `${name}: this batch carries a different protection floor than the review showed — nothing was signed.`
    }
    if (leg.optional !== shownLeg.optional)
      return shownLeg.optional
        ? `${name}: the review said this asset may be skipped, but the batch would treat it as required — nothing was signed.`
        : `${name}: the review said this asset is required, but the batch would allow it to be skipped — nothing was signed.`
  }

  // THE CATCH-ALL — the bytes must BE the composition, to the byte. Covers
  // swapData, burnSwapData, the fee pair, the deadline, and any field this
  // contract grows later; catches appended-bytes calldata no field read sees.
  let canonical: Hex
  try {
    // the generation names the ABI (gen-2's params tuple has no feeRecipient
    // and a different selector) — encoding a composed batch with the OTHER
    // generation's ABI must fail this re-check, never pass it by luck
    canonical =
      composed.generation === 2
        ? encodeFunctionData({ abi: portfolioBatcherAbiGen2, functionName: 'batchBuy', args: composed.args as never })
        : encodeFunctionData({ abi: portfolioBatcherAbi, functionName: 'batchBuy', args: composed.args as never })
  } catch {
    return 'we could not re-check this transaction against the batch we prepared — nothing was signed.'
  }
  if (batch.data !== canonical)
    return 'this transaction does not match the batch we prepared for you, in a part of it we do not put on screen — nothing was signed.'

  return null
}

/** The portfolio contract's independent-laws half — the composition against
 *  what the gate can know WITHOUT the composer: our own fee constant, the
 *  signer, the CHAIN's clock, and the contract's own shape. */
export function portfolioCompositionLawsBroken(
  composed: ComposedPortfolioBatchBuy,
  independent: {
    account: Address
    chainNowSec: number
    maxDeadlineWindowSec: number
    /** The operator's configured batch fee sink. When supplied, the composed
     *  feeRecipient must EQUAL it — a compromised composer cannot redirect the
     *  fee to itself (audit F4, 2026-08-13). Omitted keeps only the zero-sink
     *  refusal below, so an unwired caller is no worse than before, never
     *  silently permissive of an ARBITRARY recipient at a live call site. */
    expectedFeeRecipient?: Address
    /** The fee THIS chain's generation charges (batchFeeBpsFor(chainId)).
     *  Absent = generation 1's constant, so every existing caller keeps its
     *  exact old law. A gen-2 batch checked without this still refuses (25 ≠
     *  40) — the safe direction. */
    expectedFeeBps?: number
    /** True when THIS APP composed a burn route for this chain (the caller
     *  reads its own config — burnAssetFor(chainId) != null — never the
     *  composed object, or the check would be self-referential). Absent/false
     *  keeps the original F6: any non-empty burnSwapData is a tamper. */
    burnComposable?: boolean
  },
): string | null {
  const [legs, , fundingTotal, p] = composed.args

  if (low(p.recipient) !== low(independent.account))
    return 'this batch would pay out to an address that is not the wallet running it — nothing was signed.'
  // the fee is OUR constant, not the composer's opinion — per GENERATION
  // (gen-2 charges GEN2_BATCH_FEE_BPS; the caller states which via
  // expectedFeeBps, defaulting to gen-1's constant)
  if (p.feeBps !== (independent.expectedFeeBps ?? BATCH_FEE_BPS))
    return 'this batch carries a different fee than the one this app charges — nothing was signed.'
  // THE RECIPIENT LAWS ARE GENERATION-DISCRIMINATED ON THE ARGS' OWN SHAPE:
  // gen-2's tuple has NO feeRecipient field (100% burn, no integrator — the
  // strongest form of F4: there is nothing to redirect), and a gen-2 batch
  // that somehow CARRIES one is a tamper by definition. Gen-1 keeps its exact
  // zero-sink + operator-sink laws.
  if ('feeRecipient' in p) {
    if (composed.generation === 2)
      return 'this batch names a fee recipient its contract generation does not have — nothing was signed.'
    // the contract reverts a zero fee sink; the law states it independently so
    // a composer that zeroed it refuses BEFORE a wallet is contacted
    if (low(p.feeRecipient) === zeroAddress)
      return 'this batch names nowhere for its fee to go, which the contract itself refuses — nothing was signed.'
    // AND it must be the OPERATOR's sink, not merely non-zero (audit F4): the
    // legacy batcher's fee went to a protocol constant; this contract takes a
    // per-batch recipient, so a composer could redirect operator revenue to
    // any address it liked and pass every other law. Pinned the way feeBps is.
    if (independent.expectedFeeRecipient != null && low(p.feeRecipient) !== low(independent.expectedFeeRecipient))
      return 'this batch would send its fee somewhere other than this operator’s own account — nothing was signed.'
  } else if (composed.generation !== 2) {
    // a gen-1 batch MISSING the field is equally a tamper (the old shape
    // requires it; encode would throw later, but the law refuses in words)
    return 'this batch is missing the fee sink its contract generation requires — nothing was signed.'
  }
  // THE F6 BURN LAW, LOOSENED DELIBERATELY IN A VISIBLE DIFF — exactly as the
  // original comment prescribed (2026-08-15, the day it fired live: the burn
  // route SHIPPED in the storm round but this law was never loosened, so the
  // first chain to compose a real burn — 4663, LNOC — refused its own batch
  // at signing). The law now: a non-empty burnSwapData is legal EXACTLY when
  // the app's own config composes a burn for this chain (burnComposable, read
  // from the caller's config, never from the composed object — a tamperer who
  // injects a burn where none is composable still refuses verbatim). The
  // burn BYTES stay covered by the P8 verbatim re-assert at submit; a failed
  // burn quote still ships '0x' (the fail-closed divert), which passes here
  // in both modes.
  if (p.burnSwapData !== '0x' && independent.burnComposable !== true)
    return 'this batch carries a burn route this app does not compose — nothing was signed.'
  const deadline = Number(p.deadline)
  if (!Number.isFinite(deadline) || deadline <= independent.chainNowSec)
    return 'this batch would arrive already expired on the network’s own clock — nothing was signed.'
  if (deadline - independent.chainNowSec > independent.maxDeadlineWindowSec)
    return 'this batch would stay signable for far longer than we allow — nothing was signed.'
  if (!(fundingTotal > 0n)) return 'this batch pulls nothing — nothing was signed.'
  for (const leg of legs) {
    if (!(leg.sellAmount > 0n)) return 'part of this batch commits nothing — nothing was signed.'
    if (!(leg.minBuyAmount > 0n)) return 'part of this batch carries no protection floor — nothing was signed.'
    // every live leg executes THROUGH its 0x route; a leg with no route
    // calldata at all would burn gas doing nothing the review described
    if (!leg.swapData || leg.swapData === '0x')
      return 'part of this batch carries no route to execute — nothing was signed.'
  }

  // ── THE SKIPPABLE-SHARE LAWS (audit F1, 2026-08-13 — a HIGH REGRESSION I
  //    OVERCLAIMED as inherited and did NOT port). `optional` is one value on
  //    both the shown and composed sides, so the byte diff is f(x)===f(x) for
  //    it (the legacy gate's own rationale, :385-394): only an INDEPENDENT law
  //    catches a wrong/tampered flag on a big leg. Both halves are ported,
  //    with the legacy's hard-won `legs.length > 1` carve-out — a single-leg
  //    batch's only leg is trivially 100% of it, and refusing that false-
  //    refuses every single-asset buy (the sibling-hiding-a-sibling lesson).
  const optionalLegs = legs.filter((l) => l.optional)
  if (optionalLegs.length > 0 && legs.length > 1 && optionalLegs.length === legs.length)
    return 'every part of this batch is marked skippable, so it could complete having bought nothing — nothing was signed.'
  const totalCommit = legs.reduce((s, l) => s + l.sellAmount, 0n)
  if (totalCommit > 0n && legs.length > 1) {
    // one oversized skippable leg — a big allocation the contract may silently drop
    for (const leg of optionalLegs)
      if (leg.sellAmount * 100n > totalCommit * BigInt(MAX_SKIPPABLE_SHARE_PCT))
        return 'part of this batch is marked skippable while carrying a large share of the money — a leg that big must not be dropped silently. Nothing was signed.'
    // AND the aggregate (the per-leg loop does not imply it — the non-monotonic
    // bug the legacy gate measured: 51% in one refused while 90% across nine did not)
    const optionalCommit = optionalLegs.reduce((s, l) => s + l.sellAmount, 0n)
    if (optionalCommit * 100n > totalCommit * BigInt(MAX_SKIPPABLE_SHARE_PCT))
      return 'most of this batch is marked skippable, so the contract could drop the bulk of it and still report success — nothing was signed.'
  }

  // ── COMPOSITION CONSERVATION (audit F2, 2026-08-13 — the other HIGH
  //    regression). The legs' committed sum must be exactly the committable
  //    against OUR fee constant, so a composer cannot pull the full amount,
  //    deploy a sliver, and let the contract refund the rest while every other
  //    law and P6′ (which reads the contract's own `refunded`) still balance.
  //    EXCLUSIVE fee, unlike the legacy inclusive equation: the contract
  //    charges the fee ON TOP of what deploys, so the committable is
  //    maxCommittedFor and the composer fills it exactly (largest-remainder). */
  // GENERATION-AWARE (the owner's live 4663 refusal, 2026-08-17 20:11): the
  // composer sizes legs at the CHAIN's fee (gen-2 = 25bps) while this line
  // held room for the legacy 40 — the exact two-layer disagreement this gate
  // exists to catch, except both layers were ours. The fee-equality law above
  // already pins p.feeBps to the independent expectation, so conserving
  // against that same expectation keeps the gate independent of the payload.
  const committable = maxCommittedFor(fundingTotal, independent.expectedFeeBps ?? BATCH_FEE_BPS)
  if (totalCommit !== committable)
    return `this batch pulls ${fundingTotal} but its legs commit ${totalCommit} rather than the ${committable} that leaves room for the fee — two layers disagree about the money. Nothing was signed.`

  return null
}
