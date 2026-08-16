import { describe, expect, it } from 'vitest'
import { basketPnl, foldFlows, mergePnlIndexes, routersFor, type PnlIndex, type SwapFlow } from './pnl'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../chain/chains'

const B = '0xAaAa000000000000000000000000000000000001'
const b = B.toLowerCase()
const usdc = (n: number) => BigInt(Math.round(n * 1e6))
const shares = (n: number) => BigInt(Math.round(n * 1e18))

describe('foldFlows (average-cost basis)', () => {
  it('accumulates buys and removes proportional cost on sells, banking realized', () => {
    let pos = foldFlows({}, [
      { basket: B, kind: 'buy', amountIn: usdc(100), amountOut: shares(100) }, // $1.00 avg
      { basket: B, kind: 'buy', amountIn: usdc(300), amountOut: shares(200) }, // now 300 sh @ $400 → $1.333 avg
    ])
    expect(BigInt(pos[b].cost)).toBe(usdc(400))
    expect(BigInt(pos[b].shares)).toBe(shares(300))
    // sell 150 shares (half) for $260 → cost removed $200, realized +$60
    pos = foldFlows(pos, [{ basket: B, kind: 'sell', amountIn: shares(150), amountOut: usdc(260) }])
    expect(BigInt(pos[b].cost)).toBe(usdc(200))
    expect(BigInt(pos[b].shares)).toBe(shares(150))
    expect(BigInt(pos[b].realized)).toBe(usdc(60))
  })

  it('a sell of untracked shares invents no basis and no realized PnL', () => {
    // wallet sells 100 shares it never bought through the router
    const pos = foldFlows({}, [{ basket: B, kind: 'sell', amountIn: shares(100), amountOut: usdc(150) }])
    expect(pos[b].cost).toBe('0')
    expect(pos[b].realized).toBe('0')
  })

  it('caps a sell at the tracked shares — the covered slice books, the rest is ignored', () => {
    // bought 100 for $100; sells 200 (100 tracked + 100 transferred-in) for $300
    const pos = foldFlows(
      { [b]: { cost: usdc(100).toString(), shares: shares(100).toString(), realized: '0' } },
      [{ basket: B, kind: 'sell', amountIn: shares(200), amountOut: usdc(300) }],
    )
    // covered half: proceeds $150 − cost $100 = +$50 realized; basis fully consumed
    expect(pos[b].cost).toBe('0')
    expect(pos[b].shares).toBe('0')
    expect(BigInt(pos[b].realized)).toBe(usdc(50))
  })

  it('an ETH-out sell BOOKS realized once its proceeds carry a price (the owner 2026-08-02)', () => {
    // 0.05 ETH sold when ETH was $3,000 → $150 proceeds against $50 of basis.
    const pos = foldFlows(
      { [b]: { cost: usdc(100).toString(), shares: shares(100).toString(), realized: '0' } },
      [{
        basket: B,
        kind: 'sellEth',
        amountIn: shares(50),
        amountOut: 50_000_000_000_000_000n,
        proceedsUsd6: usdc(150),
      }],
    )
    expect(BigInt(pos[b].cost)).toBe(usdc(50))
    expect(BigInt(pos[b].shares)).toBe(shares(50))
    expect(BigInt(pos[b].realized)).toBe(usdc(100))
  })

  it('ETH-IN buy then priced ETH-OUT sell books NOTHING — no phantom profit from a missing basis', () => {
    // The dangerous asymmetry now that ETH-out sells book: ETH-IN buys are still
    // EXCLUDED (their dollar cost is unknowable), so those shares are uncovered.
    // If the sell booked full proceeds against a zero basis it would render the
    // entire sale as profit. The covered-fraction guard must scale it to zero.
    const pos = foldFlows(
      {},
      [{
        basket: B,
        kind: 'sellEth',
        amountIn: shares(50),
        amountOut: 50_000_000_000_000_000n,
        proceedsUsd6: usdc(150),
      }],
    )
    expect(pos[b].realized).toBe('0')
    expect(pos[b].cost).toBe('0')
  })

  it('an UNPRICED ETH-out sell still books nothing — a missing feed is not a verdict', () => {
    const pos = foldFlows(
      { [b]: { cost: usdc(100).toString(), shares: shares(100).toString(), realized: '0' } },
      // sells half for 0.05 ETH — amountOut is WEI and must never touch realized
      [{ basket: B, kind: 'sellEth', amountIn: shares(50), amountOut: 50_000_000_000_000_000n }],
    )
    expect(BigInt(pos[b].cost)).toBe(usdc(50))
    expect(BigInt(pos[b].shares)).toBe(shares(50))
    expect(pos[b].realized).toBe('0')
  })

  it('is resumable — folding in two batches equals one (the incremental top-up)', () => {
    const all: SwapFlow[] = [
      { basket: B, kind: 'buy', amountIn: usdc(50), amountOut: shares(40) },
      { basket: B, kind: 'sell', amountIn: shares(10), amountOut: usdc(20) },
      { basket: B, kind: 'buy', amountIn: usdc(30), amountOut: shares(25) },
    ]
    const once = foldFlows({}, all)
    const twice = foldFlows(foldFlows({}, all.slice(0, 1)), all.slice(1))
    expect(twice).toEqual(once)
  })
})

describe('basketPnl (display derivation)', () => {
  const index: PnlIndex = {
    upToBlock: '100',
    positions: { [b]: { cost: usdc(200).toString(), shares: shares(150).toString(), realized: usdc(60).toString() } },
  }
  it('invested = remaining basis, current = covered shares × nav, net + pct follow', () => {
    const p = basketPnl(index, B, 2, 150)! // nav $2
    expect(p.investedUsd).toBe(200)
    expect(p.currentUsd).toBe(300)
    expect(p.netUsd).toBe(100)
    expect(p.netPct).toBeCloseTo(0.5)
    expect(p.realizedUsd).toBe(60)
    expect(p.coverage).toBe(1)
  })
  it('flags partial coverage and values only the covered shares', () => {
    // wallet holds 300 but only 150 are basis-covered (150 transferred in)
    const p = basketPnl(index, B, 2, 300)!
    expect(p.coverage).toBeCloseTo(0.5)
    expect(p.currentUsd).toBe(300) // 150 covered × $2, never the transferred half
    expect(p.investedUsd).toBe(200) // the full basis still covers the held 150
  })

  it('a transfer-OUT takes its slice of basis along — never full cost vs a partial holding', () => {
    // basis covers 150 shares at $200; the wallet moved 100 away and holds 50:
    // invested must be the held third (~$66.67), not $200-vs-$100 fake loss
    const p = basketPnl(index, B, 2, 50)!
    expect(p.investedUsd).toBeCloseTo(200 / 3)
    expect(p.currentUsd).toBe(100)
    expect(p.netUsd).toBeCloseTo(100 - 200 / 3)
  })

  it('balance 0 with realized only → still reports the realized line', () => {
    const soldOut: PnlIndex = {
      upToBlock: '9',
      positions: { [b]: { cost: '0', shares: '0', realized: usdc(40).toString() } },
    }
    const p = basketPnl(soldOut, B, 2, 0)!
    expect(p.investedUsd).toBe(0)
    expect(p.realizedUsd).toBe(40)
  })
  it('null without a position — the UI self-hides', () => {
    expect(basketPnl(index, '0xBbBb000000000000000000000000000000000002', 2, 10)).toBeNull()
    expect(basketPnl(null, B, 2, 10)).toBeNull()
  })
})

describe('routersFor (the scan covers every lineage)', () => {
  it.each(SUPPORTED_CHAIN_IDS)('chain %i scans the live router plus every legacy one', (chainId) => {
    const cfg = chainCfg(chainId)
    const routers = routersFor(chainId).map((r) => r.toLowerCase())
    if (cfg.swapRouter) expect(routers[0]).toBe(cfg.swapRouter.toLowerCase())
    // A kept-listed superseded basket trades through its OWN router; miss it
    // and that basket silently has no cost basis at all.
    for (const l of cfg.legacy) expect(routers).toContain(l.swapRouter.toLowerCase())
  })

  it.each(SUPPORTED_CHAIN_IDS)('chain %i lists each router once', (chainId) => {
    // getLogs over a repeated address can return the log twice, and foldFlows
    // is not idempotent — a duplicated buy would inflate the basis outright.
    const routers = routersFor(chainId).map((r) => r.toLowerCase())
    expect(new Set(routers).size).toBe(routers.length)
  })
})

describe('mergePnlIndexes (the wallet group)', () => {
  const idx = (block: string, positions: Record<string, { cost: string; shares: string; realized: string }>) => ({
    upToBlock: block,
    positions,
  })

  it('sums positions per basket across members', () => {
    const merged = mergePnlIndexes([
      idx('100', { '0xb1': { cost: '1000000', shares: '2000000000000000000', realized: '50000' } }),
      idx('90', { '0xb1': { cost: '500000', shares: '1000000000000000000', realized: '0' } }),
    ])
    expect(merged?.positions['0xb1']).toEqual({
      cost: '1500000',
      shares: '3000000000000000000',
      realized: '50000',
    })
  })

  it('keeps the OLDEST block: merged freshness is the stalest member', () => {
    const merged = mergePnlIndexes([idx('100', {}), idx('90', {})])
    expect(merged?.upToBlock).toBe('90')
  })

  it('a basket held by one member alone passes through untouched', () => {
    const merged = mergePnlIndexes([
      idx('5', { '0xb1': { cost: '7', shares: '8', realized: '9' } }),
      idx('5', { '0xb2': { cost: '1', shares: '2', realized: '3' } }),
    ])
    expect(merged?.positions['0xb1'].cost).toBe('7')
    expect(merged?.positions['0xb2'].cost).toBe('1')
  })

  it('nulls collapse honestly: none → null, one → itself', () => {
    expect(mergePnlIndexes([null, undefined])).toBeNull()
    const only = idx('7', {})
    expect(mergePnlIndexes([null, only])).toBe(only)
  })
})
