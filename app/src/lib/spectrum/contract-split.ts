import { deploymentFor } from '../chain/deployments'
import { keccak256, parseAbi, toBytes, toHex } from 'viem'
import type { Address, PublicClient } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// contract-split — the read of the contract's OWN derived split. Shape per
// SpectrumContracts' handshake spec (2026-08-02, their DR1-CALLER-SPLIT-AUDIT
// doc): `factory.bareLegMins(basket, amountIn)` returns one PACKED word per leg
// — split bps in bits [255:240], floor in [239:0].
//
// This is now also the ONLY source of the split a buy payload may carry: see
// mint-funding.ts, which turns these words into the funding a mint encodes and
// passes the split through untouched. A split derived from target weights is
// exploitable on a starved basket (contracts measured $4,255 vs $9,900 on a
// $10,000 buy, 2026-08-05), so "the factory said so" is the only provenance the
// signing path accepts.
//
// Three outcomes, and the distinction is load-bearing:
//  · ok            — words read and decoded; compare with crossCheckSplit.
//  · unavailable   — the factory does not expose the function (every PRE-REV
//                    factory; a missing selector reverts with EMPTY data). The
//                    cross-check honestly did not run — callers proceed on the
//                    other layers, never pretend agreement.
//  · not-derivable — the factory HAS the function and REFUSED: either the named
//                    BareSplitNotDerivable error or any data-carrying revert.
//                    That is the contract saying its own split is untrustworthy
//                    — a HARD signal to surface, never an error to swallow.
//
// ⚠ Contracts' split derivation is mid-move (they are wiring it through the
// same friction machinery their floors use). The CALL SHAPE here is per their
// spec and pinned by tests; if their landing shifts it, this module is the only
// place that changes.
// ─────────────────────────────────────────────────────────────────────────────

export const bareLegMinsAbi = parseAbi([
  'function bareLegMins(address basket, uint256 amountIn) view returns (uint256[])',
])

/** keccak("BareSplitNotDerivable()")[0..4] — matched against revert data. Pinned
 *  by a test so a signature change on their side breaks loudly, not silently. */
export const BARE_SPLIT_NOT_DERIVABLE_SELECTOR = toHex(
  keccak256(toBytes('BareSplitNotDerivable()'), 'bytes').slice(0, 4),
)

/** keccak("MissingHookData()")[0..4]. The lens throws THIS at effectiveSupply() == 0
 *  (SpectrumFactory.sol:347) because only the caller's own price source may protect a
 *  first mint. It is a benign "not yet", not the factory distrusting its own split, so
 *  it is reported separately: a first buy must not read as a refusal to quote. */
export const MISSING_HOOK_DATA_SELECTOR = toHex(keccak256(toBytes('MissingHookData()'), 'bytes').slice(0, 4))

const FLOOR_MASK = (1n << 240n) - 1n

export interface ContractLegMin {
  /** The contract's derived share for this leg, basis points of the whole buy. */
  splitBps: number
  /** The contract's per-leg floor, raw units of the leg asset. */
  floorRaw: bigint
}

/** Unpack one bareLegMins word: split bps ride the top 16 bits, floor the rest. */
export function decodeBareLegMin(word: bigint): ContractLegMin {
  return { splitBps: Number(word >> 240n), floorRaw: word & FLOOR_MASK }
}

/** WHY a read produced no split. Same `kind` for all three (the cross-check did not
 *  run either way), but a signing path must tell them apart: `unpacked`/`no-function`
 *  are properties of the DEPLOYMENT (stable, decidable), while `read-failed` is a
 *  transport blip that must not be mistaken for a generation downgrade. */
export type SplitUnavailableWhy = 'unpacked' | 'no-function' | 'read-failed'

export type ContractSplitResult =
  | { kind: 'ok'; legs: ContractLegMin[] }
  | { kind: 'unavailable'; why?: SplitUnavailableWhy }
  | {
      kind: 'not-derivable'
      named: boolean
      /** Set when the refusal was the lens's first-mint rule (MissingHookData), which
       *  every unseeded basket hits by design. Callers treat it as "supply the first
       *  mint's own floors", never as a broken basket. */
      firstMint?: true
    }

/** Walk an unknown thrown shape for the deepest revert `data` hex it carries.
 *  viem nests the real signature under cause chains depending on transport. */
/** Did the CHAIN answer (a revert / empty return), or did we never reach it? Only the
 *  first is evidence about the deployment; a timeout says nothing about its generation.
 *  Message-shaped rather than instanceof-shaped so it holds for every viem transport
 *  wrapper (and for the plain shapes the unit tests throw). */
function looksLikeEvmAnswer(err: unknown): boolean {
  let node: unknown = err
  for (let depth = 0; depth < 8 && node != null; depth++) {
    if (typeof node !== 'object') break
    const e = node as { message?: unknown; shortMessage?: unknown; name?: unknown; cause?: unknown }
    const text = [e.message, e.shortMessage, e.name].filter((v) => typeof v === 'string').join(' ').toLowerCase()
    if (text.includes('revert') || text.includes('returned no data')) return true
    node = e.cause
  }
  return false
}

function revertDataOf(err: unknown): string | null {
  let node: unknown = err
  for (let depth = 0; depth < 8 && node != null; depth++) {
    if (typeof node === 'object') {
      const data = (node as { data?: unknown }).data
      if (typeof data === 'string' && data.startsWith('0x')) return data
      if (typeof data === 'object' && data != null) {
        // ContractFunctionRevertedError keeps the raw hex beside the decoded form.
        const raw = (data as { data?: unknown }).data
        if (typeof raw === 'string' && raw.startsWith('0x')) return raw
      }
      const name = (node as { errorName?: unknown }).errorName
      if (name === 'BareSplitNotDerivable') return BARE_SPLIT_NOT_DERIVABLE_SELECTOR
      if (name === 'MissingHookData') return MISSING_HOOK_DATA_SELECTOR
      node = (node as { cause?: unknown }).cause
      continue
    }
    break
  }
  return null
}

/**
 * Read the contract's derived split for `amountIn` of settlement into `basket`.
 *
 * Never throws: every failure mode is a typed outcome, because the CALLER must
 * branch on them differently (skip the cross-check vs refuse to quote) and a
 * thrown error collapses that distinction into whatever the catch site guesses.
 */
export async function readContractSplit(
  client: PublicClient,
  factory: Address,
  basket: Address,
  amountIn: bigint,
  /** The chain whose address book states this factory's generation. Optional so
   *  every existing caller compiles unchanged; without it the ambiguous-error
   *  classification behaves exactly as it did before (audit F3). */
  chainId?: number,
): Promise<ContractSplitResult> {
  // Nothing was asked of the chain, so nothing is known about it — `why` stays unset
  // (callers that must DECIDE a payload shape guard amountIn > 0 before calling).
  if (amountIn <= 0n) return { kind: 'unavailable' }
  try {
    const words = (await client.readContract({
      address: factory,
      abi: bareLegMinsAbi,
      functionName: 'bareLegMins',
      args: [basket, amountIn],
    })) as readonly bigint[]
    const legs = words.map(decodeBareLegMin)
    // PRE-PACKING factories exist and ANSWER: bareLegMins predates the rev —
    // the rev only added the split packing to the top 16 bits. The two formats
    // are EXACTLY distinguishable (SpectrumContracts 2026-08-03, from the wire
    // format — replaces the earlier sum<5000 tolerance heuristic): the split
    // field starts at 2^240 (~1.8e72) while the largest realistic 18-decimal
    // floor is ~1e30 (~2^100), so a floor can never reach the top field — ANY
    // non-zero [255:240] is only ever a split. And a packing factory that
    // SUCCEEDS never answers all-zero splits: it reverts BareSplitNotDerivable
    // when a reserve-holding leg would get zero, MissingHookData earlier when
    // nothing holds reserves. All-zero top fields on a successful answer
    // therefore PROVE the pre-packing format (measured on live 4663: 12/12
    // baskets answer plain floors) — the cross-check honestly cannot run.
    if (legs.length > 0 && legs.every((l) => l.splitBps === 0)) return { kind: 'unavailable', why: 'unpacked' }
    return { kind: 'ok', legs }
  } catch (err) {
    const data = revertDataOf(err)
    // Empty revert data = the selector does not exist there (pre-rev factory) — but
    // only if the chain actually answered. A transport failure lands here with the
    // same empty data and must NOT be read as a pre-rev factory: a signing path that
    // conflates the two silently downgrades the payload shape on a flaky RPC.
    if (data == null || data === '0x') {
      // ⚠ AUDIT F3 (2026-08-06): 'the chain answered' was inferred from the word
      // "revert" in the error chain, which a PACKING factory also produces when an
      // RPC strips revert data (common on public endpoints, and what a bare revert
      // or an out-of-gas view returns). Read as 'no-function' that shipped a
      // zero-split payload to a D-R1 basket — the original NoOutput bug, re-armed by
      // a transport property rather than a code change. It failed closed, but a
      // signing path must not infer a DEPLOYMENT SHAPE from a transport symptom.
      //
      // Where the address book states the generation, it wins: a factory we KNOW
      // packs can never be demoted to pre-packing by an ambiguous error, so the
      // honest answer there is 'read-failed' — refuse and retry.
      const packs = chainId != null && deploymentFor(chainId).packsFundingSplit === true
      const answered = looksLikeEvmAnswer(err)
      return { kind: 'unavailable', why: answered && !packs ? 'no-function' : 'read-failed' }
    }
    if (data.startsWith(MISSING_HOOK_DATA_SELECTOR)) return { kind: 'not-derivable', named: false, firstMint: true }
    return { kind: 'not-derivable', named: data.startsWith(BARE_SPLIT_NOT_DERIVABLE_SELECTOR) }
  }
}
