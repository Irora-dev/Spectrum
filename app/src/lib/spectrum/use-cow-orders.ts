import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Address } from 'viem'
import { cowSupportsChain, isTerminalCowStatus } from './cow'
import { fetchCowOrder } from './cow-api'
import {
  allOrders,
  applyOrderState,
  forgetOrder,
  ordersFor,
  pruneOrders,
  subscribeOrders,
  workingOrders,
  type PendingOrder,
} from './cow-pending'

// ─────────────────────────────────────────────────────────────────────────────
// POLLING LIVE ORDERS (owner 2026-08-02, shipping limit orders).
//
// An order resolves on the ORDERBOOK'S schedule, not ours, so there is nothing
// to await — this is the polling half of the persisted-async shape, the same one
// bridge-pending needed for cross-chain transfers.
//
// THREE RULES, each of which is a bug this repo has already paid for once:
//
// 1. POLL ONLY WHAT CAN STILL MOVE. A terminal order is never re-read, so a list
//    of settled rows costs zero requests forever.
// 2. AN UNREACHABLE SERVICE IS NOT A DEAD ORDER. A failed poll leaves the row
//    exactly as it was and tries again. We never mark something cancelled or
//    gone because a request failed.
// 3. STOP WHEN NOBODY IS LOOKING. The interval is torn down on unmount and
//    while the tab is hidden, so a backgrounded tab does not sit hammering a
//    free public service for days.
// ─────────────────────────────────────────────────────────────────────────────

/** Fast enough to feel live on a surface someone is watching, slow enough to be
 *  a polite neighbour on a keyless public API. */
export const ORDER_POLL_MS = 20_000

const EMPTY: PendingOrder[] = []

/** Subscribe to the store. `useSyncExternalStore` keeps every mounted surface
 *  consistent — the same pattern the bridge list uses. */
function useOrderStore(): PendingOrder[] {
  return useSyncExternalStore(subscribeOrders, allOrders, () => EMPTY)
}

export interface CowOrdersView {
  /** This wallet's orders on this chain, newest first. */
  orders: PendingOrder[]
  /** Just the ones that can still fill — what a badge counts. */
  working: PendingOrder[]
  /** Poll now, e.g. right after signing so the row appears settled-or-not fast. */
  refresh: () => void
}

/**
 * Live view of one wallet's orders, polled while the surface is mounted.
 *
 * Chain-gated: on a chain where CoW is not deployed there is nothing to poll and
 * nothing to show, so the hook returns empty and never issues a request.
 */
export function useCowOrders(owner: Address | undefined, chainId: number | undefined): CowOrdersView {
  useOrderStore() // re-render on any store change
  const supported = chainId != null && cowSupportsChain(chainId)

  const orders = useMemo(
    () => (supported && owner ? ordersFor(owner, chainId) : EMPTY),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [owner, chainId, supported, allOrders()],
  )
  const working = useMemo(
    () => (supported && owner ? workingOrders(owner, chainId) : EMPTY),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [owner, chainId, supported, allOrders()],
  )

  // The set of uids to poll, as a stable string so the effect does not restart
  // on every render just because the array identity changed.
  const liveUids = working.map((o) => o.uid).join(',')

  // A ref so `poll` never goes stale inside the interval closure. This exact
  // class — a stale closure over chain state inside a long-lived runner — has
  // bitten the crank runner in this codebase before.
  const liveRef = useRef<PendingOrder[]>(working)
  liveRef.current = working

  const poll = useCallback(async () => {
    const rows = liveRef.current
    if (rows.length === 0) return
    await Promise.all(
      rows.map(async (o) => {
        const r = await fetchCowOrder(o.chainId, o.uid)
        if (r.ok) {
          applyOrderState(o.uid, r.value, Date.now())
          return
        }
        // Rule 2: only a definite "this order does not exist" removes a row, and
        // only when the SERVICE said so. An unreachable service changes nothing.
        if (r.kind === 'rejected' && /notfound/i.test(r.errorType)) forgetOrder(o.uid)
      }),
    )
  }, [])

  useEffect(() => {
    if (!supported || !owner || liveUids === '') return
    let timer: number | undefined
    const stop = () => {
      if (timer != null) window.clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      if (timer != null) return
      void poll()
      timer = window.setInterval(() => void poll(), ORDER_POLL_MS)
    }
    // Rule 3: a hidden tab stops entirely and resumes with an immediate read, so
    // coming back to the tab shows fresh state rather than a stale row.
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [supported, owner, liveUids, poll])

  // Housekeeping on mount only: settled rows age out, working ones never do.
  useEffect(() => {
    pruneOrders(Date.now())
  }, [])

  return { orders, working, refresh: () => void poll() }
}

/** Whether a row can still change. Re-exported so surfaces do not each reach
 *  for the status list and get the terminal set subtly wrong. */
export const orderIsWorking = (o: PendingOrder): boolean => !isTerminalCowStatus(o.status)
