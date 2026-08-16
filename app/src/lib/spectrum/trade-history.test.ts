import { describe, expect, it } from 'vitest'
import { foldFlows, type SwapFlow } from './pnl'
import { buildTradeHistory, mergeGroupFlows, mergeHistories, sharesToString, EXPORT_CAVEATS } from './trade-history'

// Settlement is 6dp, shares are 18dp.
const usd = (n: number) => BigInt(Math.round(n * 1_000_000))
const sh = (n: number) => BigInt(Math.round(n * 1000)) * 10n ** 15n // 3dp of a share, exact

const B = '0x00000000000000000000000000000000000000b1'
const B2 = '0x00000000000000000000000000000000000000b2'

const buy = (settle: number, shares: number, block: number): SwapFlow => ({
  basket: B, kind: 'buy', amountIn: usd(settle), amountOut: sh(shares), blockNumber: BigInt(block), txHash: `0x${block}`,
})
const sell = (shares: number, settle: number, block: number): SwapFlow => ({
  basket: B, kind: 'sell', amountIn: sh(shares), amountOut: usd(settle), blockNumber: BigInt(block), txHash: `0x${block}`,
})

// blocks are 1 day apart from 2026-01-01, so windows are testable
const DAY = 86_400
const T0 = Math.floor(Date.UTC(2026, 0, 1) / 1000)
const timeOf = (b: bigint) => T0 + Number(b) * DAY
const msOf = (b: number) => (T0 + b * DAY) * 1000

describe('the replay agrees with the fold — ONE implementation of the maths', () => {
  // ⚠ THE INVARIANT THIS FEATURE RESTS ON. The export replays flows one at a
  // time to capture each disposal; the page folds them in one call. If those
  // two ever produce different totals, the document disagrees with the screen
  // about the user's money. Reusing foldFlows for the step is what makes them
  // one implementation — this test is what proves the reuse actually holds.
  it('stepping N flows one-at-a-time lands exactly where folding them together lands', () => {
    const flows = [buy(1000, 10, 1), buy(500, 4, 2), sell(6, 900, 3), buy(200, 1, 4), sell(3, 400, 5)]
    const oneShot = foldFlows({}, flows)
    let stepped = {}
    for (const f of flows) stepped = foldFlows(stepped, [f])
    expect(stepped).toEqual(oneShot)

    // …and the row the export prints for the LAST trade reports that same pool
    const h = buildTradeHistory(8453, flows, timeOf)
    const last = h.rows[h.rows.length - 1]
    expect(last.basisAfterUsd).toBeCloseTo(Number(BigInt(oneShot[B].cost)) / 1e6, 6)
    expect(last.sharesAfter).toBe(sharesToString(BigInt(oneShot[B].shares)))
  })

  it('realized in the report equals realized in the fold', () => {
    const flows = [buy(1000, 10, 1), sell(5, 700, 2), sell(5, 400, 3)]
    const folded = foldFlows({}, flows)
    const h = buildTradeHistory(8453, flows, timeOf)
    expect(h.realizedUsd).toBeCloseTo(Number(BigInt(folded[B].realized)) / 1e6, 6)
    // 10 shares cost 1000 → 100/share. Sold 5 for 700 (basis 500) = +200,
    // then 5 for 400 (basis 500) = −100. Net +100.
    expect(h.realizedUsd).toBeCloseTo(100, 6)
  })
})

describe('the rows an accountant reads', () => {
  it('a buy records what was paid and no gain', () => {
    const [row] = buildTradeHistory(8453, [buy(1000, 10, 1)], timeOf).rows
    expect(row.kind).toBe('buy')
    expect(row.settlementUsd).toBe(1000)
    expect(row.realizedUsd).toBeNull()
    expect(row.basisUsd).toBeNull()
    expect(row.shares).toBe('10')
    expect(row.ts).toBe(timeOf(1n))
    expect(row.txHash).toBe('0x1')
  })

  it('a sale states proceeds, the basis it consumed, and the gain', () => {
    const h = buildTradeHistory(8453, [buy(1000, 10, 1), sell(4, 500, 2)], timeOf)
    const s = h.rows[1]
    expect(s.settlementUsd).toBe(500)
    expect(s.basisUsd).toBeCloseTo(400, 6) // 4/10 of a 1000 pool
    expect(s.realizedUsd).toBeCloseTo(100, 6)
    expect(s.partiallyCovered).toBe(false)
    expect(s.basisAfterUsd).toBeCloseTo(600, 6)
  })

  it('an UNCOVERED sale books only the covered part and is marked partial', () => {
    // 2 shares bought; 5 sold — 3 arrived by transfer and carry no basis here
    const h = buildTradeHistory(8453, [buy(200, 2, 1), sell(5, 1000, 2)], timeOf)
    const s = h.rows[1]
    expect(s.partiallyCovered).toBe(true)
    expect(h.partiallyCoveredDisposals).toBe(1)
    // the pool is emptied, never driven negative
    expect(s.sharesAfter).toBe('0')
    expect(s.basisAfterUsd).toBeCloseTo(0, 6)
  })

  it('an ETH-out sale with NO price is listed as a real disposal with the gain unknown', () => {
    // the disposal happened and the basis left with the shares — the document
    // must not hide it just because no feed could price it
    const ethSell: SwapFlow = { basket: B, kind: 'sellEth', amountIn: sh(5), amountOut: 10n ** 18n, blockNumber: 2n }
    const h = buildTradeHistory(8453, [buy(1000, 10, 1), ethSell], timeOf)
    const s = h.rows[1]
    expect(s.kind).toBe('sell-eth')
    expect(s.settlementUsd).toBeNull()
    expect(s.realizedUsd).toBeNull()
    expect(s.basisUsd).toBeCloseTo(500, 6) // basis still left with the shares
    expect(h.unpricedDisposals).toBe(1)
    // …and its unknown gain is NOT folded into the headline as a zero
    expect(h.realizedUsd).toBe(0)
  })

  it('an ETH-out sale WITH a block price books like any other sale', () => {
    const priced: SwapFlow = {
      basket: B, kind: 'sellEth', amountIn: sh(5), amountOut: 10n ** 18n, blockNumber: 2n, proceedsUsd6: usd(700),
    }
    const h = buildTradeHistory(8453, [buy(1000, 10, 1), priced], timeOf)
    expect(h.rows[1].realizedUsd).toBeCloseTo(200, 6) // 700 − 500
    expect(h.unpricedDisposals).toBe(0)
  })
})

describe('the tax-year window', () => {
  // ⚠ THE CASE THAT MUST COME OUT DIFFERENT. Filtering the FLOWS instead of the
  // ROWS would price this year's sales against a pool that never saw last
  // year's buys — reporting the entire proceeds as gain. The window filters
  // the report; the replay always runs from the beginning.
  it('a sale in range is priced against basis built BEFORE the range', () => {
    const flows = [buy(1000, 10, 1), sell(5, 800, 400)] // buy day 1, sell day 400
    const h = buildTradeHistory(8453, flows, timeOf, { fromMs: msOf(300), toMs: msOf(500) })
    expect(h.rows).toHaveLength(1) // the buy is out of the window
    expect(h.rows[0].kind).toBe('sell')
    expect(h.rows[0].basisUsd).toBeCloseTo(500, 6) // …but its basis is not
    expect(h.realizedUsd).toBeCloseTo(300, 6) // NOT 800
  })

  it('an undated row is never silently dropped by a window', () => {
    const undated: SwapFlow = { basket: B, kind: 'sell', amountIn: sh(1), amountOut: usd(50) }
    const h = buildTradeHistory(8453, [buy(1000, 10, 1), undated], () => null, { fromMs: msOf(300) })
    expect(h.rows.some((r) => r.ts == null)).toBe(true)
  })
})

describe('merging a group of wallets on one chain (audit 2026-08-12)', () => {
  // ⚠ THE DEFECT THIS PINS. Per-wallet flow lists used to be concatenated
  // wallet-after-wallet with no re-sort, so two linked wallets trading the
  // SAME basket replayed A's whole history before B's first trade. Every
  // disposal's basisUsd/realizedUsd then booked against a pool missing the
  // buys that chronologically preceded it, and the running columns read
  // scrambled. The replay must consume the merged stream in chain order.
  it("a disposal's basis includes the OTHER wallet's chronologically-earlier buy", () => {
    // wallet A: buys 10 shares for $1000 at block 1 · sells 5 for $900 at block 3
    // wallet B: buys 10 shares for $3000 at block 2
    // chronological pool at the block-3 sale: 20 shares costing $4000
    //   → basis consumed = 5/20 × $4000 = $1000 · realized = $900 − $1000 = −$100
    // (the unsorted replay reads 5/10 × $1000 = $500 and books +$400)
    const walletA = [buy(1000, 10, 1), sell(5, 900, 3)]
    const walletB = [buy(3000, 10, 2)]
    const h = buildTradeHistory(8453, mergeGroupFlows([walletA, walletB]), timeOf)
    const disposal = h.rows.find((r) => r.kind === 'sell')!
    expect(disposal.basisUsd).toBeCloseTo(1000, 6)
    expect(disposal.realizedUsd).toBeCloseTo(-100, 6)
    expect(h.realizedUsd).toBeCloseTo(-100, 6)
  })

  it('same-block ties keep wallet order, and an undated flow replays last', () => {
    const aDated = buy(100, 1, 5)
    const aUndated: SwapFlow = { basket: B, kind: 'sell', amountIn: sh(1), amountOut: usd(9) }
    const bTie: SwapFlow = { basket: B2, kind: 'buy', amountIn: usd(1), amountOut: sh(1), blockNumber: 5n }
    const merged = mergeGroupFlows([[aDated, aUndated], [bTie]])
    expect(merged[0]).toBe(aDated) // block 5 — first wallet wins the tie
    expect(merged[1]).toBe(bTie) // block 5 — second wallet
    expect(merged[2]).toBe(aUndated) // no block: after everything datable
  })

  it('a single wallet with dated flows passes through unchanged', () => {
    const one = [buy(1000, 10, 1), sell(6, 900, 3), buy(200, 1, 4)]
    expect(mergeGroupFlows([one])).toEqual(one)
  })
})

describe('merging chains', () => {
  it('orders one timeline by date and sums the totals', () => {
    const a = buildTradeHistory(8453, [buy(100, 1, 5), sell(1, 200, 9)], timeOf)
    const b = buildTradeHistory(1, [{ basket: B2, kind: 'buy', amountIn: usd(50), amountOut: sh(1), blockNumber: 7n }], timeOf)
    const m = mergeHistories([a, b])
    expect(m.rows.map((r) => r.chainId)).toEqual([8453, 1, 8453]) // days 5, 7, 9
    expect(m.realizedUsd).toBeCloseTo(a.realizedUsd, 6)
  })
})

describe('exactness at the display boundary', () => {
  it('share counts survive 18 decimals — a float would not', () => {
    expect(sharesToString(1234567890123456789n)).toBe('1.234567890123456789')
    expect(sharesToString(10n ** 18n)).toBe('1')
    expect(sharesToString(0n)).toBe('0')
    expect(sharesToString(1n)).toBe('0.000000000000000001')
  })
})

describe('the caveats travel with the numbers', () => {
  it('states the method, the coverage limit, and that it is not a filing', () => {
    const all = EXPORT_CAVEATS.join(' ').toLowerCase()
    expect(all).toContain('average cost')
    expect(all).toContain('not us fifo')
    expect(all).toContain('router')
    expect(all).toContain('tax advice')
    // the group is pooled, and the document says so (audit 2026-08-12)
    expect(all).toContain('one pool across all of the group’s wallets')
  })
})
