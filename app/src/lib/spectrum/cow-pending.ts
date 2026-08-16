import type { Address } from 'viem'
import { isTerminalCowStatus, type CowChainId, type CowOrderStatus } from './cow'

// ─────────────────────────────────────────────────────────────────────────────
// LIVE ORDERS, PERSISTED (owner 2026-08-02, shipping limit orders).
//
// A limit order is NOT a transaction. A transaction confirms in a block and the
// flow's ExecutionPlan models exactly that: queued -> approve -> confirming ->
// done. An order is signed once and then LIVES — minutes, days, or until it
// expires unfilled — so it needs the same shape the cross-chain work needed:
// state that survives a reload, is polled rather than awaited, and never
// declares something dead because a request failed.
//
// Deliberately the same idiom as bridge-pending.ts (module store + listeners, so
// every mounted surface re-renders together) rather than a second pattern.
//
// WHAT THIS IS NOT: a source of truth. The ORDERBOOK is. This is a local index of
// "orders this browser signed", so we can show them and poll them. Anything here
// may be stale, and a row that the API has never heard of is dropped rather than
// believed — a user could have cancelled from another device.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'spectrum:cow-orders:v1'

/** How long a settled order stays visible before it stops being news. Its real
 *  record is the chain; this list is a working surface, not history. */
export const SETTLED_TTL_MS = 24 * 60 * 60 * 1000

export interface PendingOrder {
  /** The orderbook's uid — the identity, and the handle for cancelling. */
  uid: string
  chainId: CowChainId
  /** The wallet that signed. Rows are filtered by this, never merged across
   *  wallets: two accounts in one browser must not see each other's orders. */
  owner: Address
  sellToken: Address
  buyToken: Address
  sellSymbol: string
  buySymbol: string
  sellDecimals: number
  buyDecimals: number
  /** The full size signed, raw units. */
  sellAmountRaw: bigint
  /** The user's limit, raw units of the buy token. */
  minBuyAmountRaw: bigint
  /** Unix seconds. */
  validTo: number
  createdAtMs: number
  status: CowOrderStatus
  /** Fee-exclusive, so a progress bar reflects the user's own order. */
  executedSellRaw: bigint
  executedBuyRaw: bigint
  /** When the row reached a terminal status, so settled rows can age out. */
  settledAtMs?: number
}

type Stored = Omit<PendingOrder, 'sellAmountRaw' | 'minBuyAmountRaw' | 'executedSellRaw' | 'executedBuyRaw'> & {
  sellAmountRaw: string
  minBuyAmountRaw: string
  executedSellRaw: string
  executedBuyRaw: string
}

const serialize = (r: PendingOrder): Stored => ({
  ...r,
  sellAmountRaw: r.sellAmountRaw.toString(),
  minBuyAmountRaw: r.minBuyAmountRaw.toString(),
  executedSellRaw: r.executedSellRaw.toString(),
  executedBuyRaw: r.executedBuyRaw.toString(),
})

/** Parse defensively: a row we cannot read is DROPPED, never half-restored.
 *  A half-parsed order would render a control that acts on a uid we do not
 *  actually have. */
function parse(o: unknown): PendingOrder | null {
  try {
    const s = o as Stored
    if (!s || typeof s.uid !== 'string' || !s.uid) return null
    if (typeof s.chainId !== 'number' || typeof s.owner !== 'string') return null
    return {
      ...s,
      sellAmountRaw: BigInt(s.sellAmountRaw ?? '0'),
      minBuyAmountRaw: BigInt(s.minBuyAmountRaw ?? '0'),
      executedSellRaw: BigInt(s.executedSellRaw ?? '0'),
      executedBuyRaw: BigInt(s.executedBuyRaw ?? '0'),
    }
  } catch {
    return null
  }
}

function load(): PendingOrder[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.map(parse).filter((r): r is PendingOrder => r != null)
  } catch {
    return []
  }
}

let rows: PendingOrder[] = load()
const listeners = new Set<() => void>()

function save(): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(rows.map(serialize)))
  } catch {
    /* storage unavailable — the in-memory list still works this session */
  }
}

const notify = () => listeners.forEach((l) => l())

export function subscribeOrders(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Every row this browser knows about, newest first. */
export function allOrders(): PendingOrder[] {
  return rows
}

/** The rows a given wallet should see on a given chain. Filtered by owner,
 *  because a shared browser must never show one account another's orders. */
export function ordersFor(owner: Address | undefined, chainId?: number): PendingOrder[] {
  if (!owner) return []
  const o = owner.toLowerCase()
  return rows
    .filter((r) => r.owner.toLowerCase() === o && (chainId == null || r.chainId === chainId))
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
}

/** Orders still capable of filling — what a "you have N working" badge counts. */
export const workingOrders = (owner: Address | undefined, chainId?: number): PendingOrder[] =>
  ordersFor(owner, chainId).filter((r) => !isTerminalCowStatus(r.status))

/** Insert or replace by uid. Upsert rather than push, so a re-post or a
 *  double-mount cannot produce two rows for one order. */
export function upsertOrder(row: PendingOrder): void {
  const i = rows.findIndex((r) => r.uid === row.uid)
  if (i >= 0) rows = rows.map((r, n) => (n === i ? row : r))
  else rows = [row, ...rows]
  save()
  notify()
}

/**
 * Fold a fresh reading from the orderbook into a stored row.
 *
 * Returns the row unchanged when nothing moved, so callers can skip a re-render
 * — and, more importantly, so a poll that returns identical data cannot churn
 * the list on every tick.
 */
export function applyOrderState(
  uid: string,
  next: { status: CowOrderStatus; executedSellRaw: bigint; executedBuyRaw: bigint },
  nowMs: number,
): void {
  const i = rows.findIndex((r) => r.uid === uid)
  if (i < 0) return
  const cur = rows[i]
  const same =
    cur.status === next.status &&
    cur.executedSellRaw === next.executedSellRaw &&
    cur.executedBuyRaw === next.executedBuyRaw
  if (same) return
  const terminal = isTerminalCowStatus(next.status)
  rows = rows.map((r, n) =>
    n === i
      ? {
          ...r,
          ...next,
          // Stamp the settle time ONCE, so ageing out is measured from when it
          // actually settled rather than from the most recent poll.
          settledAtMs: terminal ? (r.settledAtMs ?? nowMs) : undefined,
        }
      : r,
  )
  save()
  notify()
}

/** Drop a row. Used when the orderbook has never heard of it (cancelled from
 *  another device) — we trust the service over our own cache. */
export function forgetOrder(uid: string): void {
  const before = rows.length
  rows = rows.filter((r) => r.uid !== uid)
  if (rows.length === before) return
  save()
  notify()
}

/**
 * Age out settled rows.
 *
 * ONLY settled ones: a working order is never pruned no matter how old, because
 * an order can legitimately sit unfilled for weeks and silently dropping it
 * would hide a live commitment the user still has money behind. An EXPIRED order
 * is settled and ages out; an OPEN one from last month does not.
 */
export function pruneOrders(nowMs: number): void {
  const keep = rows.filter((r) => {
    if (!isTerminalCowStatus(r.status)) return true
    if (r.settledAtMs == null) return true
    return nowMs - r.settledAtMs < SETTLED_TTL_MS
  })
  if (keep.length === rows.length) return
  rows = keep
  save()
  notify()
}

/** Test seam — resets the module store. Not exported to app code paths. */
export function __resetOrdersForTest(seed: PendingOrder[] = []): void {
  rows = seed
  save()
  notify()
}
