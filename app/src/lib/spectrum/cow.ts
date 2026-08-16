import type { Address, Hex } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// COW PROTOCOL — the limit-order rail (owner 2026-08-02: "lets do the limit
// orders indeed for base and eth").
//
// WHY THIS RAIL. Measured on Base the same day, not read from docs: 31 of 62
// recent CoW order owners are PLAIN EOAs signing eip712. There is no API key, no
// account, no Safe and NO CONTRACT OF OURS anywhere in the path. The user signs
// an order, we post it, CoW's solver competition fills it. The only on-chain
// transaction is the user's own ERC-20 approval to the vault relayer.
// Evidence: the ops repo/workspace/spectrum-demand/cow-rail-feasibility-2026-08-02.md
//
// WHAT THIS FILE IS: the pure half — types, addresses, the EIP-712 payload, the
// quote-request body, and the validation that keeps us from signing something
// wrong. No React, no fetch, no wallet. Kept React-free at runtime on purpose,
// the same rule exposure.ts and basket-data.ts follow, so it stays portable into
// a service worker if the extension lane ever wants it.
//
// TWAP IS NOT HERE and cannot be built on this file. A CoW TWAP is a
// ComposableCoW *conditional* order whose owner must be a contract that forwards
// signature validation — a Safe, or a custom EIP-7702 delegate we would have to
// write and audit. Measured: 36 conditional-order owners on Base, 29 Safes, 6
// other contracts, ZERO EOAs. Do not try to fake one by posting N orders at once;
// they would all be live immediately, which is a split order, not a TWAP.
// ─────────────────────────────────────────────────────────────────────────────

/** Chains where CoW is deployed AND we have verified it settling.
 *  Robinhood 4663 is deliberately absent: settlement, ComposableCoW and the TWAP
 *  handler all read NO CODE there (probed 2026-08-02). Never add a chain here on
 *  the strength of a docs page — probe `GPv2Settlement` first. */
export const COW_CHAIN_IDS = [1, 8453] as const
export type CowChainId = (typeof COW_CHAIN_IDS)[number]

export const cowSupportsChain = (chainId: number): chainId is CowChainId =>
  (COW_CHAIN_IDS as readonly number[]).includes(chainId)

/** GPv2Settlement — one address on every chain CoW supports. Verified deployed
 *  on 1 and 8453; it is also the EIP-712 `verifyingContract`. */
export const COW_SETTLEMENT: Address = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'

/** GPv2VaultRelayer — THE APPROVAL TARGET, and the single easiest thing to get
 *  wrong here. Tokens are pulled by the relayer, NOT by the settlement contract,
 *  so approving settlement leaves every order unfillable. Read from
 *  `GPv2Settlement.vaultRelayer()` on Base, 2026-08-02. */
export const COW_VAULT_RELAYER: Address = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'

/** CoW's sentinel for native ETH as a BUY token. Native ETH can be bought but
 *  never sold: an order selling ETH must sell WETH. */
export const COW_NATIVE_BUY: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const API_HOST: Record<CowChainId, string> = {
  1: 'https://api.cow.fi/mainnet/api/v1',
  8453: 'https://api.cow.fi/base/api/v1',
}

export const cowApiBase = (chainId: CowChainId) => API_HOST[chainId]

/** The EIP-712 domain. VERIFIED rather than copied: computing this domain's
 *  separator for chain 8453 reproduces `GPv2Settlement.domainSeparator()` read
 *  on-chain (0xd72ffa78…257b4b) exactly. A test pins that. */
export function cowDomain(chainId: CowChainId) {
  return { name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: COW_SETTLEMENT } as const
}

/** The Order struct, field order load-bearing — EIP-712 hashes by declared
 *  order, so reordering these silently changes the digest and every signature
 *  becomes invalid rather than wrong-looking. */
export const COW_ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const

export type CowOrderKind = 'sell' | 'buy'

export interface CowOrder {
  sellToken: Address
  buyToken: Address
  receiver: Address
  sellAmount: string
  buyAmount: string
  validTo: number
  appData: Hex
  /** Solver-determined since the fee overhaul; a signed order carries 0.
   *  Verified against a real fulfilled order on Base (feeAmount "0"). */
  feeAmount: string
  kind: CowOrderKind
  partiallyFillable: boolean
  sellTokenBalance: 'erc20'
  buyTokenBalance: 'erc20'
}

export interface BuildLimitOrderArgs {
  sellToken: Address
  buyToken: Address
  /** Where the bought token lands. Defaults to the owner — we never default it
   *  to anything else, because a wrong receiver is an irreversible misdelivery. */
  owner: Address
  receiver?: Address
  sellAmountRaw: bigint
  /** The user's price, as the minimum they will accept. This IS the limit: CoW
   *  fills at or better, or never fills at all. */
  minBuyAmountRaw: bigint
  /** Seconds from `now` the order stays live. */
  validForSec: number
  nowSec: number
  appData: Hex
  /** Partial fills let a large order be worked in pieces instead of needing one
   *  counterparty for the whole size. Default TRUE for the same reason the
   *  in-the-wild accounts use it (40/40 on the busiest Base account measured). */
  partiallyFillable?: boolean
}

/** Refusals, not clamps. Every one of these would otherwise produce a
 *  *signable* order that is wrong — and a signed wrong order is the dangerous
 *  kind, because the signature makes it look deliberate. */
export function limitOrderRefusal(a: BuildLimitOrderArgs): string | null {
  if (a.sellToken.toLowerCase() === a.buyToken.toLowerCase()) return 'Cannot trade a token for itself'
  if (a.sellToken.toLowerCase() === COW_NATIVE_BUY.toLowerCase())
    return 'Native ETH cannot be sold on this rail, sell WETH instead'
  if (a.sellAmountRaw <= 0n) return 'Enter an amount to sell'
  if (a.minBuyAmountRaw <= 0n) return 'Set the price you want'
  if (a.validForSec <= 0) return 'The expiry has already passed'
  return null
}

/** Build the exact struct that gets signed and posted. Pure. Throws on a
 *  refusal rather than returning something signable — a caller that ignored
 *  `limitOrderRefusal` must not be able to reach a wallet prompt. */
export function buildLimitOrder(a: BuildLimitOrderArgs): CowOrder {
  const refusal = limitOrderRefusal(a)
  if (refusal) throw new Error(refusal)
  return {
    sellToken: a.sellToken,
    buyToken: a.buyToken,
    receiver: a.receiver ?? a.owner,
    sellAmount: a.sellAmountRaw.toString(),
    buyAmount: a.minBuyAmountRaw.toString(),
    validTo: Math.floor(a.nowSec) + Math.floor(a.validForSec),
    appData: a.appData,
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: a.partiallyFillable ?? true,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  }
}

/** The typed-data payload handed to the wallet. Split out from the signing call
 *  so it can be asserted in a test without a wallet anywhere near it. */
export function limitOrderTypedData(chainId: CowChainId, order: CowOrder) {
  return {
    domain: cowDomain(chainId),
    types: COW_ORDER_TYPES,
    primaryType: 'Order' as const,
    message: {
      ...order,
      sellAmount: BigInt(order.sellAmount),
      buyAmount: BigInt(order.buyAmount),
      feeAmount: BigInt(order.feeAmount),
    },
  }
}

/** A plain secp256k1 signature is exactly 65 bytes: r(32) + s(32) + v(1). */
const ECDSA_HEX_LEN = 2 + 65 * 2

/**
 * Which scheme the signature we just got back actually IS.
 *
 * DO NOT hardcode `eip712` here, which is what this file did until a research
 * pass caught it. A growing share of "EOAs" are smart accounts or EIP-7702
 * delegated accounts, and several of the common ones — MetaMask Smart Account,
 * Alchemy MA v2, ZeroDev Kernel v3, Biconomy Nexus — return `eth_signTypedData_v4`
 * WRAPPED in a nested ERC-7739 or validator-prefixed envelope. That blob does not
 * `ecrecover` to the signer, so posting it as `eip712` gets the order rejected
 * with a signature error that looks like our bug and is not.
 *
 * The discriminator is length, and it is the same one CoW's own SDK settled on:
 * 65 bytes is a raw ECDSA signature and recovers normally; anything else is an
 * account-abstraction envelope that only the account itself can validate, so it
 * goes as `eip1271` with the bytes forwarded verbatim. CoW then STATICCALLs
 * `isValidSignature` on the owner — which works, because the code lives at the
 * account's own address (verified on live Base state: a delegated EOA reports
 * EXTCODESIZE 23 and dispatches to its delegate, and a production delegate
 * returns the 0x1626ba7e magic value for its own key's signature).
 */
export function schemeForSignature(signature: Hex): 'eip712' | 'eip1271' {
  return signature.length === ECDSA_HEX_LEN ? 'eip712' : 'eip1271'
}

/** The POST body for `/orders`. `from` and `signature` come from the wallet;
 *  everything else is decided here, including the scheme (see above — it is
 *  derived, never assumed). */
export function orderPostBody(order: CowOrder, owner: Address, signature: Hex) {
  return { ...order, from: owner, signature, signingScheme: schemeForSignature(signature) }
}

export interface CowQuoteRequest {
  sellToken: Address
  buyToken: Address
  from: Address
  receiver: Address
  kind: CowOrderKind
  sellAmountBeforeFee: string
  appData: Hex
  /** CoW prices for a real signer; a quote asked for the zero address can be
   *  refused. The caller passes the connected wallet. */
  signingScheme: 'eip712'
  onchainOrder: false
}

/** Pure builder for the quote request — the price we SHOW comes from here, and
 *  the price we SIGN is the user's own limit, never this. Keeping them separate
 *  is the point: a quote is information, a limit is an instruction. */
export function buildQuoteRequest(args: {
  sellToken: Address
  buyToken: Address
  owner: Address
  receiver?: Address
  sellAmountRaw: bigint
  appData: Hex
}): CowQuoteRequest {
  return {
    sellToken: args.sellToken,
    buyToken: args.buyToken,
    from: args.owner,
    receiver: args.receiver ?? args.owner,
    kind: 'sell',
    sellAmountBeforeFee: args.sellAmountRaw.toString(),
    appData: args.appData,
    signingScheme: 'eip712',
    onchainOrder: false,
  }
}

// ── appData ──────────────────────────────────────────────────────────────────
//
// `appData` is a bytes32 the user signs, and it is the hash of a JSON document.
// Two things live in that document, and one of them is dangerous:
//
//   · metadata — app code, order class, and PARTNER FEE. Verified in the wild:
//     a real filled Base order carries `partnerFee: { volumeBps: 85 }`, i.e. a
//     wallet skimming 0.85% through this field. So this is the standard fee
//     mechanism on the rail, and anything we ever charge would go here.
//   · HOOKS — arbitrary pre/post interactions executed as part of settlement.
//
// The hazard is that the wallet shows a HASH. A user cannot see a hook, so a
// compromised build could attach one and the signature would look ordinary. Our
// document is therefore a fixed, inert constant, and `appDataRefusal` exists so
// that a future edit adding hooks fails a test instead of shipping.
//
// The fee model says NO Spectrum fee on orders in v1. If that ever changes it is
// a deliberate decision recorded against the fee model, added explicitly here.

export interface CowAppDataDoc {
  version: string
  appCode: string
  metadata: Record<string, unknown>
}

/** The only document we sign. Inert by construction: no hooks, no fee, no
 *  recipient, nothing that moves value or calls anything. */
export const SPECTRUM_APP_DATA: CowAppDataDoc = {
  version: '1.1.0',
  appCode: 'Spectrum',
  metadata: { orderClass: { orderClass: 'limit' } },
}

/** Keys that must never appear. `hooks` executes arbitrary calls; the fee keys
 *  move value. Any of them turns a signature the user reads as "sell at my
 *  price" into something else. */
const FORBIDDEN_APP_DATA_KEYS = ['hooks', 'partnerFee', 'referrer']

/**
 * Refuse an appData document that can do anything other than describe the order.
 *
 * Checked on the DOCUMENT, because by the time it is a hash it is unreadable —
 * which is precisely why this guard has to exist upstream of the hash.
 */
export function appDataRefusal(doc: CowAppDataDoc): string | null {
  if (!doc || typeof doc !== 'object') return 'appData must be a document.'
  const meta = doc.metadata ?? {}
  for (const key of FORBIDDEN_APP_DATA_KEYS) {
    if (key in meta) return `appData must not carry \`${key}\`: it would make the signature do more than the user can see.`
    if (key in (doc as unknown as Record<string, unknown>)) return `appData must not carry \`${key}\`.`
  }
  return null
}

/** Order states the API reports. `expired` and `cancelled` are terminal and are
 *  NOT failures — an unfilled limit order that expires did exactly what the user
 *  asked ("at my price, or never"), and the UI must say so in those words. */
export type CowOrderStatus = 'open' | 'fulfilled' | 'cancelled' | 'expired' | 'presignaturePending'

export const COW_TERMINAL_STATUSES: CowOrderStatus[] = ['fulfilled', 'cancelled', 'expired']

export const isTerminalCowStatus = (s: string): boolean =>
  (COW_TERMINAL_STATUSES as string[]).includes(s)
