import { keccak256, toHex, type Hex } from 'viem'
import { appDataRefusal, SPECTRUM_APP_DATA } from './cow'

// ─────────────────────────────────────────────────────────────────────────────
// THE appData HASH — the one piece the surface needs that the rail does not
// already hand it. `buildLimitOrder` takes `appData` as a bytes32 Hex; this
// turns our inert document into that hash.
//
// WHY IT IS GUARDED RATHER THAN JUST HASHED: appData is signed as a HASH, so
// whatever is inside it is invisible in the wallet prompt. That is precisely
// what makes it the place a fee can hide — a real Base order in the wild
// carries `partnerFee: volumeBps 85`, a wallet skimming 0.85% through this
// exact field, and the user's prompt shows them a bytes32 either way.
//
// So the document goes through `appDataRefusal` EVERY time, not once at
// review: if anyone ever adds hooks, a partnerFee or a referrer to
// SPECTRUM_APP_DATA, this throws rather than quietly signing it. A crash in
// development is the cheapest possible outcome for that mistake.
//
// The serialisation must be byte-stable, because the hash is the identity: the
// document is a frozen literal and JSON.stringify preserves its key order.
//
// NOTE for UIGuy: this arguably belongs beside `appDataRefusal` in `cow.ts`,
// which is your module — I put it here rather than editing the rail. Move it
// in whenever you like; the surface imports it by name either way.
// ─────────────────────────────────────────────────────────────────────────────

/** The bytes32 our orders sign as `appData`. Throws if the document ever gains
 *  a field that could act on the user's behalf. */
export function spectrumAppDataHex(): Hex {
  const refusal = appDataRefusal(SPECTRUM_APP_DATA)
  if (refusal) throw new Error(`appData refused: ${refusal}`)
  return keccak256(toHex(JSON.stringify(SPECTRUM_APP_DATA)))
}
