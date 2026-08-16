import { isAddress, type Address, type Hex } from 'viem'
import { SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { fetchLifiStatus, type LifiDelivery } from './lifi'

// ─────────────────────────────────────────────────────────────────────────────
// Persisted cross-chain funding transfers (owner 2026-07-29, phase 2 of the
// cross-chain pay side). A cross-chain move only STARTS in the transaction the
// user signs — arrival happens later on the destination chain. That makes it a
// two-phase product: this module is the state between the phases, persisted in
// localStorage so a reload (or a wallet popup eating the tab) never loses a
// live transfer. Funds always travel wallet→same wallet (the destination
// settlement asset), so an abandoned phase 2 strands nothing.
//
// Honesty rules (mirror lifi.ts): 'done' carries the amount that ACTUALLY
// arrived; DONE+REFUNDED is a refund; an unreachable status service is
// 'unknown' and keeps polling — a live transfer is never declared dead.
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingBridge {
  /** Source-chain transaction hash — the transfer's identity. */
  txHash: Hex
  fromChainId: number
  toChainId: number
  /** The wallet that signed (funds arrive to the same wallet). */
  holder: Address
  /** Display facts about what was sent. */
  fromSymbol: string
  fromAmountRaw: bigint
  fromDecimals: number
  /** Quoted settlement arrival (display; the real figure comes from status). */
  quotedToAmountRaw: bigint
  startedAt: number
  /** Route ETA in seconds at quote time (display only; absent = unknown). */
  etaSec?: number
  /** Terminal state, cached once observed so resolved rows stop polling. */
  resolved?:
    | { state: 'done'; toAmount: bigint }
    | { state: 'refunded' }
    | { state: 'failed'; reason: string }
}

const KEY = 'spectrum:bridge-pending'
const MAX_ROWS = 8
const HASH = /^0x[0-9a-fA-F]{64}$/

type Stored = Record<string, unknown>

function parseRow(o: Stored): PendingBridge | null {
  try {
    if (
      typeof o.txHash !== 'string' ||
      !HASH.test(o.txHash) ||
      typeof o.holder !== 'string' ||
      !isAddress(o.holder) ||
      typeof o.fromChainId !== 'number' ||
      typeof o.toChainId !== 'number' ||
      typeof o.fromSymbol !== 'string' ||
      o.fromSymbol.length === 0 ||
      o.fromSymbol.length > 24 ||
      // bounded: an unbounded fromDecimals makes formatUnits quadratic, and the
      // row PERSISTS — a forged one wedges the app on every load (F-6)
      !Number.isInteger(o.fromDecimals) ||
      (o.fromDecimals as number) < 0 ||
      (o.fromDecimals as number) > 36 ||
      typeof o.startedAt !== 'number' ||
      !Number.isFinite(o.startedAt) ||
      (o.startedAt as number) <= 0 ||
      (o.startedAt as number) > Date.now() + 60_000 ||
      // chain ids must be ones this build actually knows (H-5): chainCfg throws
      // on an unknown id, and the banner calls it while rendering
      !SUPPORTED_CHAIN_IDS.includes(o.fromChainId as number) ||
      !SUPPORTED_CHAIN_IDS.includes(o.toChainId as number)
    ) {
      return null
    }
    const row: PendingBridge = {
      txHash: o.txHash as Hex,
      fromChainId: o.fromChainId as number,
      toChainId: o.toChainId as number,
      holder: o.holder as Address,
      fromSymbol: o.fromSymbol,
      fromAmountRaw: BigInt(String(o.fromAmountRaw ?? '0')),
      fromDecimals: o.fromDecimals as number,
      quotedToAmountRaw: BigInt(String(o.quotedToAmountRaw ?? '0')),
      startedAt: o.startedAt as number,
    }
    const r = o.resolved as Stored | undefined
    if (r && typeof r.state === 'string') {
      if (r.state === 'done') row.resolved = { state: 'done', toAmount: BigInt(String(r.toAmount ?? '0')) }
      else if (r.state === 'refunded') row.resolved = { state: 'refunded' }
      else if (r.state === 'failed') row.resolved = { state: 'failed', reason: String(r.reason ?? 'The transfer failed.') }
    }
    return row
  } catch {
    return null
  }
}

function serializeRow(r: PendingBridge): Stored {
  return {
    ...r,
    fromAmountRaw: r.fromAmountRaw.toString(),
    quotedToAmountRaw: r.quotedToAmountRaw.toString(),
    resolved:
      r.resolved?.state === 'done' ? { state: 'done', toAmount: r.resolved.toAmount.toString() } : r.resolved,
  }
}

// Module store with listeners (the active-chain pattern) so every mounted
// surface re-renders together when a transfer resolves.
let rows: PendingBridge[] = load()
const listeners = new Set<() => void>()

function load(): PendingBridge[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.map((o) => parseRow(o as Stored)).filter((r): r is PendingBridge => r != null)
  } catch {
    return []
  }
}

function save(): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows.map(serializeRow)))
  } catch {
    /* storage unavailable — the in-memory list still works this session */
  }
}

function notify(): void {
  listeners.forEach((l) => l())
}

export function bridgeRows(): PendingBridge[] {
  return rows
}

export function addBridge(row: PendingBridge): void {
  rows = [row, ...rows.filter((r) => r.txHash.toLowerCase() !== row.txHash.toLowerCase())].slice(0, MAX_ROWS)
  save()
  notify()
}

export function dismissBridge(txHash: Hex): void {
  rows = rows.filter((r) => r.txHash.toLowerCase() !== txHash.toLowerCase())
  save()
  notify()
}

export function subscribeBridges(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Poll one unresolved row; caches a terminal state. Non-terminal results
 *  ('pending'/'unknown') change nothing — the next tick retries. */
export async function pollBridge(row: PendingBridge, signal?: AbortSignal): Promise<LifiDelivery> {
  const status = await fetchLifiStatus({
    txHash: row.txHash,
    fromChainId: row.fromChainId,
    toChainId: row.toChainId,
    signal,
  })
  if (status.state === 'done' || status.state === 'refunded' || status.state === 'failed') {
    rows = rows.map((r) =>
      r.txHash.toLowerCase() === row.txHash.toLowerCase()
        ? {
            ...r,
            resolved:
              status.state === 'done'
                ? { state: 'done', toAmount: status.toAmount }
                : status.state === 'refunded'
                  ? { state: 'refunded' }
                  : { state: 'failed', reason: status.reason },
          }
        : r,
    )
    save()
    notify()
  }
  return status
}
