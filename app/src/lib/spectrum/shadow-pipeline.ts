import type { Address, PublicClient } from 'viem'
import { decodeFunctionResult, encodeFunctionData } from 'viem'
import type { StorageLike } from './allocation'
import { batcherAbi, type BatchSimResult, type ComposedBatchBuy } from './batcher'
import { friendlyRevert } from './decode-revert'

// ─────────────────────────────────────────────────────────────────────────────
// SHADOW MODE (readiness §6b — its own phase between "runner built" and 3.2).
//
// The REAL pipeline (compose → eth_call the exact bytes → would-have-signed)
// runs SILENTLY beside the simulated engine for user actions on :5313/:5311,
// and this module is its record: every pass appends one device-local row —
// would-have-signed · would-have-refused · divergence — and the accumulated
// log IS the evidence base for the 3.2 go (exit criterion: N consecutive
// days with zero unexplained divergences, N = the owner's call).
//
// LAWS:
//  · NEVER A WALLET. A shadow pass is eth_call only — it cannot sign, prompt,
//    or submit, whatever state it finds. It runs while SIMULATED holds.
//  · NEVER A THROW. Shadow rides real user actions fire-and-forget; a shadow
//    failure is a shadow row ('would-have-refused' with the reason), not a
//    user-facing error.
//  · CLASSIFICATION IS CONSERVATIVE. 'divergence' means OUR COMPOSITION AND
//    THE CHAIN DISAGREE STRUCTURALLY (a required leg skipped, spend above
//    pull, an undecodable result) — the class the 3.2 gate cares about. A
//    plain revert is 'would-have-refused' (the pipeline working as designed);
//    a success records the worst leg's quoted-vs-simulated delta as evidence.
//  · THE LOG IS TELEMETRY, NOT MONEY. Unlike the exec-log it does not fight
//    tab races for a lost row — a dropped shadow row costs evidence density,
//    never money — but it shares the cap-and-append idiom.
// ─────────────────────────────────────────────────────────────────────────────

export interface ShadowRecord {
  at: number
  chainId: number
  intent: 'create' | 'rebalance'
  outcome: 'would-have-signed' | 'would-have-refused' | 'divergence'
  /** The refusal sentence or the divergence description — our words. */
  reason?: string
  /** The worst kept leg's headroom ABOVE the floor we composed, in bps of the
   *  floor (0 = one tick from a revert; large = comfortable). The §6b
   *  evidence figure: how close real pools run to our protection. Null when
   *  no leg was measurable. */
  worstLegFloorHeadroomBps?: number | null
}

const KEY = 'spectrum:shadowlog'
const MAX_ROWS = 500

function safeStorage(): StorageLike | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function appendShadow(rec: ShadowRecord, storage: StorageLike | null = safeStorage()): void {
  if (!storage) return
  try {
    const rows = loadShadowLog(storage)
    rows.push(rec)
    storage.setItem(KEY, JSON.stringify(rows.slice(-MAX_ROWS)))
  } catch {
    /* telemetry only — never worth throwing for */
  }
}

export function loadShadowLog(storage: StorageLike | null = safeStorage()): ShadowRecord[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is ShadowRecord =>
        !!r &&
        typeof r === 'object' &&
        Number.isFinite((r as ShadowRecord).at) &&
        Number.isFinite((r as ShadowRecord).chainId) &&
        typeof (r as ShadowRecord).outcome === 'string',
    )
  } catch {
    return []
  }
}

/** The §6b exit-criterion view: how many rows, how many divergences, and the
 *  time span — the panel the owner reads before calling the 3.2 go. */
export function shadowSummary(storage: StorageLike | null = safeStorage()): {
  rows: number
  signed: number
  refused: number
  divergences: number
  firstAt: number | null
  lastAt: number | null
} {
  const rows = loadShadowLog(storage)
  return {
    rows: rows.length,
    signed: rows.filter((r) => r.outcome === 'would-have-signed').length,
    refused: rows.filter((r) => r.outcome === 'would-have-refused').length,
    divergences: rows.filter((r) => r.outcome === 'divergence').length,
    firstAt: rows.length ? rows[0].at : null,
    lastAt: rows.length ? rows[rows.length - 1].at : null,
  }
}

export interface ShadowPassInput {
  client: PublicClient
  batcher: Address
  /** The connected account the eth_call runs as (no wallet interaction). */
  account: Address
  composed: ComposedBatchBuy
  intent: 'create' | 'rebalance'
  nowMs: () => number
  storage?: StorageLike | null
}

/**
 * Run one shadow pass: eth_call the EXACT bytes the runner would sign and
 * append the honest classification. Resolves to the record it wrote (for
 * tests and the panel); never throws, never prompts.
 */
export async function runShadowPass(input: ShadowPassInput): Promise<ShadowRecord> {
  const chainId = input.composed.args ? numberOfChain(input) : 0
  const base = { at: input.nowMs(), chainId, intent: input.intent }
  let rec: ShadowRecord
  try {
    const data = encodeFunctionData({ abi: batcherAbi, functionName: 'batchBuy', args: input.composed.args })
    const res = await input.client.call({ to: input.batcher, data, value: input.composed.value, account: input.account })
    if (!res.data) {
      rec = { ...base, outcome: 'divergence', reason: 'the call succeeded but returned no result — an undecodable success' }
    } else {
      let result: BatchSimResult | null = null
      try {
        result = decodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', data: res.data }) as BatchSimResult
      } catch {
        result = null
      }
      if (!result) {
        rec = { ...base, outcome: 'divergence', reason: 'the result did not decode as a BatchResult — struct drift is exactly what shadow mode exists to catch' }
      } else {
        rec = classifySuccess(base, input.composed, result)
      }
    }
  } catch (e) {
    rec = { ...base, outcome: 'would-have-refused', reason: friendlyRevert(e, 'the network refused this batch in simulation') }
  }
  appendShadow(rec, input.storage === undefined ? safeStorage() : input.storage)
  return rec
}

function classifySuccess(
  base: { at: number; chainId: number; intent: 'create' | 'rebalance' },
  composed: ComposedBatchBuy,
  result: BatchSimResult,
): ShadowRecord {
  const legs = composed.args[0]
  // structural disagreements first — the divergence class
  for (let i = 0; i < legs.length; i++) {
    const skipped = ((result.skippedBitmap >> BigInt(i)) & 1n) === 1n
    if (skipped && !legs[i].optional)
      return { ...base, outcome: 'divergence', reason: `a required leg (index ${i}) was skipped in simulation — our plan and the chain disagree` }
  }
  if (result.spentFunding > (composed.args[2] as bigint))
    return { ...base, outcome: 'divergence', reason: 'the simulation spent more than the batch pulls' }

  // evidence: the worst kept leg's headroom above the floor we composed
  let worstHeadroom: number | null = null
  for (let i = 0; i < legs.length; i++) {
    const skipped = ((result.skippedBitmap >> BigInt(i)) & 1n) === 1n
    if (skipped) continue
    const out = result.outs[i]
    const minOut = legs[i].minOut
    if (out == null || minOut <= 0n) continue
    if (out < minOut) {
      // the contract enforces floors, so this is unreachable on a success —
      // if it ever shows up, it is the divergence class, said plainly
      return { ...base, outcome: 'divergence', reason: `leg ${i} simulated below the floor we composed, on a successful call` }
    }
    const headroomBps = Number(((out - minOut) * 10_000n) / minOut)
    worstHeadroom = worstHeadroom == null ? headroomBps : Math.min(worstHeadroom, headroomBps)
  }
  return { ...base, outcome: 'would-have-signed', worstLegFloorHeadroomBps: worstHeadroom }
}

function numberOfChain(input: ShadowPassInput): number {
  const id = input.client.chain?.id
  return typeof id === 'number' ? id : 0
}
