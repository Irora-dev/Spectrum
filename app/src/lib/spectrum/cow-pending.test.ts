import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetOrdersForTest,
  applyOrderState,
  forgetOrder,
  ordersFor,
  pruneOrders,
  SETTLED_TTL_MS,
  subscribeOrders,
  upsertOrder,
  workingOrders,
  type PendingOrder,
} from './cow-pending'

const A = '0x182e54f8011cb15887764E6D4a658cD9b96c8d8F' as const
const B = '0x00000000000000000000000000000000DeaDBeef' as const
const NOW = 1_780_000_000_000

const row = (over: Partial<PendingOrder> = {}): PendingOrder => ({
  uid: '0xUID',
  chainId: 8453,
  owner: A,
  sellToken: '0x4200000000000000000000000000000000000006',
  buyToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  sellSymbol: 'WETH',
  buySymbol: 'USDC',
  sellDecimals: 18,
  buyDecimals: 6,
  sellAmountRaw: 10n ** 18n,
  minBuyAmountRaw: 4000_000000n,
  validTo: 1_780_003_600,
  createdAtMs: NOW,
  status: 'open',
  executedSellRaw: 0n,
  executedBuyRaw: 0n,
  ...over,
})

beforeEach(() => __resetOrdersForTest())

describe('cow-pending: rows are per wallet', () => {
  it('never shows one account another account’s orders', () => {
    upsertOrder(row({ uid: '1', owner: A }))
    upsertOrder(row({ uid: '2', owner: B }))
    expect(ordersFor(A).map((r) => r.uid)).toEqual(['1'])
    expect(ordersFor(B).map((r) => r.uid)).toEqual(['2'])
  })

  it('matches the owner case-insensitively', () => {
    upsertOrder(row({ owner: A }))
    expect(ordersFor(A.toLowerCase() as `0x${string}`)).toHaveLength(1)
  })

  it('shows nothing with no wallet connected', () => {
    upsertOrder(row())
    expect(ordersFor(undefined)).toEqual([])
  })

  it('filters by chain when asked', () => {
    upsertOrder(row({ uid: '1', chainId: 8453 }))
    upsertOrder(row({ uid: '2', chainId: 1 }))
    expect(ordersFor(A, 1).map((r) => r.uid)).toEqual(['2'])
    expect(ordersFor(A)).toHaveLength(2)
  })
})

describe('cow-pending: upsert, not append', () => {
  it('replaces by uid so a re-post cannot double a row', () => {
    upsertOrder(row({ status: 'open' }))
    upsertOrder(row({ status: 'fulfilled' }))
    expect(ordersFor(A)).toHaveLength(1)
    expect(ordersFor(A)[0].status).toBe('fulfilled')
  })

  it('sorts newest first', () => {
    upsertOrder(row({ uid: 'old', createdAtMs: NOW - 5000 }))
    upsertOrder(row({ uid: 'new', createdAtMs: NOW }))
    expect(ordersFor(A).map((r) => r.uid)).toEqual(['new', 'old'])
  })
})

describe('cow-pending: folding in a fresh reading', () => {
  it('updates progress and notifies', () => {
    upsertOrder(row())
    let hits = 0
    const off = subscribeOrders(() => hits++)
    applyOrderState('0xUID', { status: 'open', executedSellRaw: 300n, executedBuyRaw: 1200n }, NOW)
    expect(ordersFor(A)[0].executedSellRaw).toBe(300n)
    expect(hits).toBe(1)
    off()
  })

  // A poll that returns identical data must not churn the list every tick.
  it('does NOT notify when nothing actually moved', () => {
    upsertOrder(row({ executedSellRaw: 300n, executedBuyRaw: 1200n }))
    let hits = 0
    const off = subscribeOrders(() => hits++)
    applyOrderState('0xUID', { status: 'open', executedSellRaw: 300n, executedBuyRaw: 1200n }, NOW)
    expect(hits).toBe(0)
    off()
  })

  it('ignores a reading for an order it does not know', () => {
    upsertOrder(row({ uid: 'known' }))
    applyOrderState('stranger', { status: 'fulfilled', executedSellRaw: 1n, executedBuyRaw: 1n }, NOW)
    expect(ordersFor(A)).toHaveLength(1)
  })

  // Ageing out must measure from when it SETTLED, not from the latest poll,
  // or a row that keeps being polled never ages out at all.
  it('stamps the settle time once and does not move it on later polls', () => {
    upsertOrder(row())
    applyOrderState('0xUID', { status: 'fulfilled', executedSellRaw: 10n ** 18n, executedBuyRaw: 4100_000000n }, NOW)
    const first = ordersFor(A)[0].settledAtMs
    applyOrderState('0xUID', { status: 'fulfilled', executedSellRaw: 10n ** 18n, executedBuyRaw: 4200_000000n }, NOW + 60_000)
    expect(ordersFor(A)[0].settledAtMs).toBe(first)
  })
})

describe('cow-pending: what counts as working', () => {
  it('counts open orders and excludes every terminal one', () => {
    upsertOrder(row({ uid: 'a', status: 'open' }))
    upsertOrder(row({ uid: 'b', status: 'fulfilled' }))
    upsertOrder(row({ uid: 'c', status: 'expired' }))
    upsertOrder(row({ uid: 'd', status: 'cancelled' }))
    expect(workingOrders(A).map((r) => r.uid)).toEqual(['a'])
  })
})

describe('cow-pending: pruning', () => {
  it('ages out a settled row once its TTL passes', () => {
    upsertOrder(row({ status: 'fulfilled', settledAtMs: NOW }))
    pruneOrders(NOW + SETTLED_TTL_MS + 1)
    expect(ordersFor(A)).toHaveLength(0)
  })

  it('keeps a settled row inside its TTL', () => {
    upsertOrder(row({ status: 'fulfilled', settledAtMs: NOW }))
    pruneOrders(NOW + 1000)
    expect(ordersFor(A)).toHaveLength(1)
  })

  // THE ONE THAT MATTERS. An order can sit unfilled for weeks and still be a
  // live commitment the user has money behind. Dropping it would hide that.
  it('NEVER prunes a working order, however old', () => {
    upsertOrder(row({ status: 'open', createdAtMs: 0, settledAtMs: undefined }))
    pruneOrders(NOW + SETTLED_TTL_MS * 1000)
    expect(ordersFor(A)).toHaveLength(1)
  })

  // Expired IS settled, and is exactly the case that could be confused with the
  // one above: old and unfilled, but finished.
  it('does prune an EXPIRED order, which is settled', () => {
    upsertOrder(row({ status: 'expired', settledAtMs: NOW }))
    pruneOrders(NOW + SETTLED_TTL_MS + 1)
    expect(ordersFor(A)).toHaveLength(0)
  })
})

describe('cow-pending: forgetting', () => {
  it('drops a row the orderbook has never heard of', () => {
    upsertOrder(row())
    forgetOrder('0xUID')
    expect(ordersFor(A)).toHaveLength(0)
  })

  it('does not notify when there was nothing to forget', () => {
    let hits = 0
    const off = subscribeOrders(() => hits++)
    forgetOrder('nope')
    expect(hits).toBe(0)
    off()
  })
})
