// ─────────────────────────────────────────────────────────────────────────────
// THE AUTO-SWITCH LAW — the pure decision behind "one click, not two" in the
// two SEQUENTIAL ceremonies (PublishBundleModal · ReshapeThesisModal). No
// React, no wagmi, no wallet: this module only answers ASK or DON'T, so every
// law below is covered by node tests instead of a wallet nobody can mount.
//
// A SUPERSESSION, STATED (the house rule: never bury a reversal). Until
// 2026-08-13 both ceremonies' headers read "the switch is OFFERED, never
// taken": a lane became active, the creator clicked OUR button, and only then
// did the wallet ask its own question — two actions for one intent. the owner ruled
// the opposite for the in-ceremony lane advance: "can we auto switch them to
// the next chain, save them a click to switch to eth/base etc" (2026-08-13).
// So the ceremony now CALLS the switch itself.
//
// WHAT MAKES THAT SAFE IS THAT CONSENT DOES NOT MOVE. The wallet still shows
// its own prompt and that prompt is still the only thing that changes a
// network. We are saving OUR click, never the wallet's — which is why the call
// goes through the app's own useNetworkSwitch (wagmi switchChain) and never a
// raw window.ethereum.
//
// THE OFFER-NEVER-TAKE LAW STILL STANDS EVERYWHERE ELSE — WrongNetwork's
// notice (rule 3), the single-basket ReshapeBasketModal, CrownWinnings. This
// ruling is about the sequential ceremonies' lane advance and nothing else.
//
// FOUR LAWS, ALL ENFORCED HERE (the modals own only the memory and the call):
//  (a) ONCE PER LANE. `asked` is the memory — a chain is asked for at most once
//      per ceremony, so there is no retry loop; and `declined` refuses on top
//      of it, so a rejected switch is never re-asked even if the cursor's
//      inputs churn. A refusal is not a dead end: the manual offer button stays
//      exactly where it was, with its existing declined copy.
//  (b) NEVER WHILE A SIGNATURE IS OUT. A wallet already showing a signature
//      must not be interrupted by a second request.
//  (c) THE OBSERVATION REMAINS THE TRUTH. This decides only whether to ASK. The
//      sequencer still advances on the OBSERVED wallet chain (both modals'
//      switch → deploying effect), so a switch made inside the wallet and one
//      we called are indistinguishable downstream, by design.
//  (d) A WALKTHROUGH NEVER ASKS. Nothing about a demo run may touch a wallet.
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoSwitchInput {
  /** The ceremony is on its ship stage — an editor stage never asks. */
  shipping: boolean
  /** A walkthrough run — law (d). */
  demo: boolean
  /** The active lane's chain; null when no lane holds the cursor. */
  laneChainId: number | null
  /** The active lane's step. Both ceremonies name their switch step 'switch';
   *  every other step refuses (a deploy or a signature never asks). */
  laneState: string | null
  /** A wallet is connected. */
  connected: boolean
  /** The wallet's OBSERVED chain; null when unknown (an unknown chain is not a
   *  known mismatch, so it is never a reason to ask). */
  walletChainId: number | null
  /** A signature is out somewhere in this ceremony — law (b). */
  signing: boolean
  /** A switch call is already in flight (the wallet is showing its prompt). */
  switching: boolean
  /** The last call came back without landing — declined or refused by the
   *  wallet — law (a). */
  declined: boolean
  /** The chains this ceremony has ALREADY asked for — law (a)'s memory. */
  asked: readonly number[]
}

/** Why we are (not) asking. Every refusal is named, so the tests read as the
 *  laws they pin rather than as a pile of booleans. */
export type AutoSwitchVerdict =
  | 'ask'
  | 'walkthrough'
  | 'not-shipping'
  | 'no-lane'
  | 'not-the-switch-step'
  | 'signature-out'
  | 'no-wallet'
  | 'already-there'
  | 'already-asking'
  | 'declined'
  | 'already-asked'

/**
 * The one decision. Order is the laws' own priority: a walkthrough is refused
 * before anything else is even considered, and a signature outranks every
 * convenience.
 */
export function autoSwitchVerdict(i: AutoSwitchInput): AutoSwitchVerdict {
  if (i.demo) return 'walkthrough' // (d) — first, always
  if (!i.shipping) return 'not-shipping'
  if (i.laneChainId == null) return 'no-lane'
  if (i.laneState !== 'switch') return 'not-the-switch-step'
  if (i.signing) return 'signature-out' // (b)
  if (!i.connected || i.walletChainId == null) return 'no-wallet'
  if (i.walletChainId === i.laneChainId) return 'already-there' // (c) — nothing to ask
  if (i.switching) return 'already-asking'
  if (i.declined) return 'declined' // (a) — a refusal is never re-asked
  if (i.asked.includes(i.laneChainId)) return 'already-asked' // (a) — once per lane
  return 'ask'
}

/** The verdict as the boolean the effect acts on. */
export function shouldAutoSwitch(i: AutoSwitchInput): boolean {
  return autoSwitchVerdict(i) === 'ask'
}
