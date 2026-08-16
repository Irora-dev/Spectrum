import { recoverMessageAddress } from 'viem'
import type { Hex } from 'viem'
import { SUPPORTED_CHAIN_IDS } from '../chain/chains'
import type { ChainVerifier } from './wallet-links'

// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO SIGN-IN (the owner 2026-08-13: "ensure that you can 'log into' your
// portfolio by signing with one of your linked wallets, from both returning
// and also from the main onboarding flow" — he hit the loop live: onboarding
// revealed his book, Visit Portfolio landed him on "complete onboarding",
// round and round). The signature is the login: it proves the wallet is the
// visitor's — a connection alone can be a watch-only import — and the latch
// it sets is what /portfolio's gate honours from then on.
//
// Shape rules, inherited from the wallet-link ceremony (the audited sibling):
//  · the message is FROZEN-FORMAT, plain-language, scope-stamped (host + day)
//    so a signature pasted elsewhere reads as what it is;
//  · verify what actually came back BEFORE latching — EOA recovery first, the
//    chain's own verifyMessage (ERC-1271/6492) as the smart-wallet fallback;
//  · the latch is device-local and per-wallet, the onboarding-reveal list
//    shape (capped, healed by writes), and NOTHING stores the signature —
//    no server consumes it and an unreadable store must simply ask again.
// ─────────────────────────────────────────────────────────────────────────────

const norm = (a: string) => a.toLowerCase()

/** The message the signing wallet approves. Plain language, self-describing,
 *  scope-stamped. Format is FROZEN — tests pin it verbatim. */
export function signInMessage(owner: string, host: string, atMs: number): string {
  const day = new Date(atMs).toISOString().slice(0, 10)
  return [
    `Sign in to the portfolio of ${norm(owner)}`,
    `on ${host} (${day}).`,
    '',
    'This signature only proves the wallet is yours, so this browser can open its portfolio. It approves nothing, spends nothing, and stays on this device.',
  ].join('\n')
}

/** The chain fallback, wallet-links' exact dispatch: viem's verifyMessage on
 *  the chain's own client answers for deployed smart wallets (ERC-1271) and
 *  pre-deploy ones (ERC-6492) alike. Local because wallet-links keeps its
 *  verifier private; both are one delegating line to the same authority. */
const chainVerifier: ChainVerifier = async (chainId, args) => {
  const { clientFor } = await import('../chain/rpc')
  return clientFor(chainId).verifyMessage(args)
}

/** The message's scope stamp (host + day) is its only variable part — read it
 *  back and REBUILD the whole message through signInMessage, then compare
 *  verbatim. Mirrors wallet-links' linkFieldsMatchMessage exactly. */
function signInMessageMatches(owner: string, message: string): boolean {
  if (message.length > 4_096) return false // bound before regex on hostile input
  const stamp = /\non ([^\n]{1,255}) \((\d{4}-\d{2}-\d{2})\)\.\n/.exec(message)
  if (!stamp) return false
  const atMs = Date.parse(`${stamp[2]}T00:00:00.000Z`)
  if (!Number.isFinite(atMs)) return false
  return message === signInMessage(owner, stamp[1], atMs)
}

/** Does this signature verify as the owner's, over a message THIS APP would
 *  have produced? EOA recovery is the fast path; a smart-contract wallet
 *  (whose signature never RECOVERS to its address) falls through to on-chain
 *  verification on each supported chain until one vouches. `verify: null`
 *  forbids the chain fallback (pure tests).
 *
 *  ⚠ THE MESSAGE FORMAT IS PINNED FIRST (audit 2026-08-13, the exact class the
 *  2026-08-11 wallet-links bug taught): recovery alone would validate ANY
 *  message the owner ever signed — a wallet-link message, another dApp's SIWE
 *  "prove ownership" personal_sign — and mint a login latch from it. Not
 *  reachable while both callers build the message locally and nothing accepts
 *  an externally-supplied sign-in signature, but this is the guard that keeps
 *  it that way the moment a sign-in signature crosses a trust boundary. A
 *  signature over a message this app would not have produced is not a sign-in. */
export async function verifySignIn(
  owner: string,
  message: string,
  signature: Hex,
  verify: ChainVerifier | null = chainVerifier,
): Promise<boolean> {
  if (!signInMessageMatches(owner, message)) return false
  try {
    const recovered = await recoverMessageAddress({ message, signature })
    if (norm(recovered) === norm(owner)) return true
  } catch {
    /* not an EOA signature shape — the 1271 path below decides */
  }
  if (!verify) return false
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    try {
      if (await verify(chainId, { address: owner as `0x${string}`, message, signature })) return true
    } catch {
      /* this chain could not answer — the next may */
    }
  }
  return false
}

// The per-wallet login latch — onboarding-reveal's exact list shape: capped so
// a wallet-hopping session can't grow it unbounded, healed by writes (a
// corrupt row must never brick the write forever).
const SIGNIN_KEY = 'spectrum.portfolio-signin.v1'

function readList(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SIGNIN_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? (raw as string[]) : []
  } catch {
    return []
  }
}

/** Has this wallet signed in on this device? Storage unreadable → false: a
 *  login that cannot be remembered asks again — the safe direction here,
 *  OPPOSITE of the invite-dismissal latch (a gate that re-asks is a knock;
 *  an invite that re-asks is a nag). */
export function hasSignedIn(owner: string): boolean {
  return readList().includes(norm(owner))
}

/** THE GROUP LOGIN (the owner 2026-08-13: "can you sign with any of the linked
 *  wallets to login?" — yes): one member's sign-in vouches for the whole
 *  linked set, because membership itself is signature-verified (every link
 *  record was signed by the joining wallet and verified before storing —
 *  wallet-links' ceremony law). So the caller passes the group's member
 *  list and ANY latched member logs the book in; whichever member is
 *  CONNECTED is simply the one asked to sign when none has yet. */
export function anySignedIn(owners: readonly string[]): boolean {
  const list = readList()
  return owners.some((o) => list.includes(norm(o)))
}

export function markSignedIn(owner: string): void {
  const next = [...new Set([...readList(), norm(owner)])].slice(-20)
  try {
    window.localStorage.setItem(SIGNIN_KEY, JSON.stringify(next))
  } catch {
    /* private mode — it simply does not persist, and the gate asks again */
  }
}
