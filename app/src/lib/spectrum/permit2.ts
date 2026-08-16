import type { Address, TypedDataDomain } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// PERMIT2 — the ladder's rung-2 builders (readiness §5b). Pure typed-data
// construction; signing and the on-chain deployment/allowance checks are the
// runner's. CONTRACTS-GATED end to end: nothing consumes these until the
// batcher speaks permitTransferFrom (their desk carries the ask).
//
// The flavor is SignatureTransfer's PermitBatchTransferFrom — EXACT amounts,
// UNORDERED nonces, a short deadline: one signature authorizes pulling every
// sold token once, and expires on its own. Deliberately NOT AllowanceTransfer
// (persistent sub-allowances): exact-and-expiring matches the seam law
// (approve only the winner, exact-amount) and leaves nothing standing.
//
// Wallet reality, stated where the code lives: Permit2 is a CONTRACT, not a
// wallet feature — any wallet that signs EIP-712 typed data can use it (that
// is effectively all of them; smart wallets verify via EIP-1271, which
// Permit2's SignatureVerification supports). The known drainer vector is
// users signing MALICIOUS permits on phishing sites — our surface only ever
// requests exact amounts, short deadlines, spender = the batcher; wallets
// increasingly decode Permit2 and show exactly that.
// ─────────────────────────────────────────────────────────────────────────────

/** The canonical deterministic deployment — same address on every chain it
 *  exists on. Whether it exists on 4663 is a contracts question, not a
 *  constant we assert. */
export const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

export const PERMIT2_TYPES = {
  PermitBatchTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions[]' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const

/** Permit2's domain has NO version field — {name, chainId, verifyingContract}
 *  only. Adding one changes the hash and every signature fails verification. */
export function permit2Domain(chainId: number): TypedDataDomain {
  return { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS }
}

export interface BatchPermitInput {
  chainId: number
  /** The sold tokens with their EXACT recorded amounts (sellRaw — never
   *  dollars divided by a price). */
  permitted: { token: Address; amountRaw: bigint }[]
  /** The batcher — the ONLY spender these builders will name. */
  spender: Address
  /** Unordered nonce — any never-used uint256. The runner derives it from
   *  randomness it injects; this module stays clock- and RNG-free. */
  nonce: bigint
  /** Absolute unix seconds. Callers pass chainNow + PERMIT2_DEADLINE_SECS. */
  deadlineSec: number
  /** THE CHAIN'S OWN CLOCK — the latest block timestamp, never Date.now()
   *  (threat-model P1, sharpened by battle-test half-2 finding 2): the
   *  window here is enforced RELATIVE to this value, but the chain honors
   *  the deadline against block.timestamp — so a device clock two days fast
   *  would mint a two-day standing grant that passes a Date.now() check.
   *  The only clock that bounds what the chain will accept is the chain's.
   *  The runner reads it at signing time; a proving-matrix row rehearses
   *  the skewed-clock refusal. */
  chainNowSec: number
}

/** Short by policy: a permit that outlives its run is a standing grant. */
export const PERMIT2_DEADLINE_SECS = 30 * 60

/** The exact object for signTypedData — and the same message the batcher
 *  call must carry, byte-for-byte (preview bytes = signature bytes). */
export function buildBatchPermit(input: BatchPermitInput) {
  if (input.permitted.length === 0) throw new Error('an empty permit authorizes nothing')
  if (input.permitted.some((p) => p.amountRaw <= 0n)) throw new Error('a permit amount must be positive and exact')
  if (!Number.isInteger(input.chainNowSec) || input.chainNowSec <= 0)
    throw new Error('the chain clock is not a whole unix second — the deadline window cannot be bounded without it')
  if (input.deadlineSec <= input.chainNowSec) throw new Error('a permit needs a future deadline')
  if (input.deadlineSec > input.chainNowSec + PERMIT2_DEADLINE_SECS)
    throw new Error(`a permit deadline past ${PERMIT2_DEADLINE_SECS}s is a standing grant wearing a signature — refused`)
  return {
    domain: permit2Domain(input.chainId),
    types: PERMIT2_TYPES,
    primaryType: 'PermitBatchTransferFrom' as const,
    message: {
      permitted: input.permitted.map((p) => ({ token: p.token, amount: p.amountRaw })),
      spender: input.spender,
      nonce: input.nonce,
      deadline: BigInt(input.deadlineSec),
    },
  }
}
