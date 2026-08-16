import { SUPPORTED_CHAIN_IDS, chainCfg } from '../chain/chains'
import { PoolDetectionError, Venue } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// THE V2 LAW — one module, so no surface can invent a softer version of it.
//
// WHAT IS TRUE ON-CHAIN: on a chain configured `rejectsV2Legs` (deployments.ts)
// the basket constructor reverts `InvalidEthPool` on venue 2. CREATE2 discards
// the inner reason, so the factory reports only `CREATE2Failed` — which is why
// a V2 leg mines fine, prices fine, and dies at simulate behind a message that
// names no cause. It cost a live bundle publish on both rehearsal chains
// (2026-08-13, kit commit 6b2a185).
//
// WHY IT NEEDS ITS OWN MODULE, not just a branch inside the detector. A leg can
// enter a basket by more routes than the add box: a deep link (?tokens=), a
// curated template, a bundle union, a reshape editor, a predecessor version
// seed — and, the case the owner actually hit, a DRAFT SAVED BEFORE THE RULE
// EXISTED, whose stored route is trusted on restore. The detector closes the
// front door; this module is what the other doors and the last step before the
// wallet share, so the rule is one implementation rather than six.
//
// TWO SENTENCES, ONE CLAUSE — deliberately. They state two DIFFERENT facts and
// collapsing them would make one of them a lie:
//   · v2OnlyMessage    — "there is nowhere else for this token to go". True at
//                        ADD time, when detection has just swept every venue.
//   · v2LegBlockedMessage — "this leg CARRIES a V2 route". True of a stale
//                        draft, and says nothing about where the token can
//                        trade — MKR has a deep V3 pool and still arrived here
//                        as a V2 leg out of a saved draft. Telling that user
//                        "MKR only trades through V2" would be false.
// The shared clause below is the part that must never be reworded, so both
// sentences accuse the DEPLOYMENT rather than the token.
// ─────────────────────────────────────────────────────────────────────────────

/** The one clause. Every V2 refusal anywhere in the app contains exactly this. */
export const V2_REJECTION_CLAUSE = "this deployment's contracts reject Uniswap V2 legs"

/** ADD TIME — detection swept every venue and a V2 pair is all there is. */
export function v2OnlyMessage(subject = 'This token'): string {
  return `${subject} only trades through a Uniswap V2 pool, and ${V2_REJECTION_CLAUSE} — pick this asset on a network where it has a V3 or V4 market, or choose another asset.`
}

/** The add-time sentence with no token named (the detector knows the address,
 *  not the symbol — the user just typed or clicked it). */
export const V2_REJECTED_MESSAGE = v2OnlyMessage()

/** STALE-LEG TIME — the leg carries a V2 route from before the rule. */
export function v2LegBlockedMessage(names: readonly string[]): string {
  const many = names.length > 1
  const who = names.length ? names.join(', ') : 'A leg in this basket'
  return `${who} ${many ? 'carry' : 'carries'} a Uniswap V2 route, and ${V2_REJECTION_CLAUSE} — remove ${
    many ? 'those legs' : 'that leg'
  } and add ${many ? 'them' : 'it'} again to re-route, or pick this asset on a network where it has a V3 or V4 market.`
}

/** Does this chain's configured factory reject venue 2? The ONE read of the
 *  flag — every surface asks here rather than reaching into the config itself,
 *  so "which chains reject V2" has a single answer. Unknown chain ⇒ false: an
 *  unconfigured chain deploys nothing, and guessing `true` would refuse legs on
 *  a chain we know nothing about. */
export function chainRejectsV2(chainId: number): boolean {
  try {
    return chainCfg(chainId).rejectsV2Legs === true
  } catch {
    return false
  }
}

/** True when NO chain this build offers accepts a V2 leg.
 *
 *  This is the backstop the last-line-before-money guard uses when its caller
 *  never says which chain the basket is for (`toBasketEntries` takes assets and
 *  weights, and the one call site that has the chain lives in another lane's
 *  file). It is EXACT for both configurations that exist: the canonical book
 *  ships no rejecting chain at all, so this is false and production is
 *  untouched; the rehearsal seating arms all three, so this is true and a V2
 *  entry cannot be built no matter which surface produced it. On a MIXED book
 *  it is deliberately permissive — it only ever refuses what is provably
 *  refusable everywhere, and the per-chain check above is what surfaces that
 *  know their chain use. */
export function everyChainRejectsV2(): boolean {
  const ids = SUPPORTED_CHAIN_IDS
  return ids.length > 0 && ids.every((id) => chainRejectsV2(id))
}

/** The minimum a leg must show to be judged: the venue it will be deployed
 *  with. `symbol` is used only to name it in the sentence. */
export interface V2CheckableLeg {
  route: { venue: number }
  symbol?: string
  address?: string
}

/** The legs this chain will refuse. Empty everywhere V2 is legal — which is
 *  every chain in the shipped book. */
export function rejectedV2Legs<T extends V2CheckableLeg>(legs: readonly T[], chainId?: number): T[] {
  const rejects = chainId == null ? everyChainRejectsV2() : chainRejectsV2(chainId)
  if (!rejects) return []
  return legs.filter((l) => l?.route?.venue === Venue.V2)
}

/** THE LAST LINE. Throws before anything is mined, signed or sent.
 *
 *  A PoolDetectionError (not a bare Error) on purpose: every add surface
 *  already renders that family's `message` verbatim, and `isRetryableDetection`
 *  correctly reads this as a VERDICT — a retry cannot help a leg whose route
 *  the contracts refuse. */
export function assertNoRejectedV2Legs(legs: readonly V2CheckableLeg[], chainId?: number): void {
  const bad = rejectedV2Legs(legs, chainId)
  if (bad.length === 0) return
  const names = bad.map((l) => l.symbol || l.address || 'a leg')
  throw new PoolDetectionError(v2LegBlockedMessage(names), 'V2_LEG_REJECTED')
}
