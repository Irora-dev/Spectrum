import { describe, expect, it } from 'vitest'
import { buildTradeHistoryCsv } from './csv-export'
import { buildTradeHistory, type TradeHistory } from './trade-history'
import type { SwapFlow } from './pnl'

const usd = (n: number) => BigInt(Math.round(n * 1_000_000))
const sh = (n: number) => BigInt(Math.round(n * 1000)) * 10n ** 15n
const B = '0x00000000000000000000000000000000de500015'

const T0 = Math.floor(Date.UTC(2026, 0, 1) / 1000)
const timeOf = (b: bigint) => T0 + Number(b) * 86_400

const FLOWS: SwapFlow[] = [
  { basket: B, kind: 'buy', amountIn: usd(1000), amountOut: sh(10), blockNumber: 10n, txHash: '0xaa' },
  { basket: B, kind: 'buy', amountIn: usd(500), amountOut: sh(4), blockNumber: 20n, txHash: '0xbb' },
  { basket: B, kind: 'sell', amountIn: sh(6), amountOut: usd(900), blockNumber: 30n, txHash: '0xcc' },
  // an ETH-out sale with no feed: a REAL disposal whose gain is unknown
  { basket: B, kind: 'sellEth', amountIn: sh(2), amountOut: 10n ** 18n, blockNumber: 40n, txHash: '0xdd' },
]

const build = (h: TradeHistory) =>
  buildTradeHistoryCsv({
    exportedAtIso: '2026-08-11T00:00:00.000Z',
    history: h,
    symbolOf: () => 'AICYCLE',
    chainNameOf: () => 'Robinhood',
    wallets: ['0xaaa', '0xbbb'],
  })

describe('the document an accountant opens', () => {
  const csv = build(buildTradeHistory(4663, FLOWS, timeOf))
  const lines = csv.split('\n')

  it('leads with the caveats — BEFORE any number', () => {
    const firstCaveat = lines.findIndex((l) => l.includes('READ THIS FIRST'))
    const firstNumber = lines.findIndex((l) => l.startsWith('SUMMARY'))
    expect(firstCaveat).toBeGreaterThan(-1)
    expect(firstCaveat).toBeLessThan(firstNumber)
    // the method and the jurisdiction warning are IN the file, not a tooltip
    expect(csv).toContain('average cost')
    expect(csv).toContain('NOT US FIFO')
  })

  it('names the wallets it covers — a group document must say whose trades', () => {
    expect(lines[1]).toContain('0xaaa 0xbbb')
  })

  it('prints every trade with its date, basis and gain', () => {
    const trades = lines.slice(lines.findIndex((l) => l.startsWith('date,timestamp_utc')) + 1).filter(Boolean)
    expect(trades).toHaveLength(4)
    expect(trades[0]).toContain('BUY')
    expect(trades[0]).toContain('2026-01-11') // block 10 = day 10
    // the settlement sale: 6 of 14 shares against a 1500 pool = 642.86 basis
    expect(trades[2]).toContain('SELL')
    expect(trades[2]).toContain('900.00')
    expect(trades[2]).toContain('642.86')
    expect(trades[2]).toContain('full')
    expect(trades[2]).toContain('0xcc')
  })

  it('an unpriced disposal prints the WORD unknown, never an empty cell', () => {
    // an empty cell sums as zero in a spreadsheet — that would silently
    // understate the gains, which is the exact failure this document exists
    // to avoid
    const ethRow = lines.find((l) => l.includes('SELL (paid in ETH)'))
    expect(ethRow).toBeDefined()
    expect(ethRow).toContain('unknown')
    expect(csv).toContain('Disposals with NO price,1')
    expect(csv).toContain('their gain is NOT in the figure above')
  })

  it('the summary realized figure excludes what it could not price', () => {
    // only the settlement sale books: 900 − 642.857142 = 257.14
    expect(csv).toContain('Realized gain/loss (USD),257.14')
  })

  it('a period-limited document says which period', () => {
    const scoped = buildTradeHistoryCsv({
      exportedAtIso: '2026-08-11T00:00:00.000Z',
      history: buildTradeHistory(4663, FLOWS, timeOf),
      symbolOf: () => 'AICYCLE',
      chainNameOf: () => 'Robinhood',
      wallets: ['0xaaa'],
      fromIso: '2026-01-01',
      toIso: '2026-12-31',
    })
    expect(scoped).toContain('Period,2026-01-01 to 2026-12-31')
  })

  it('a hostile ticker cannot execute in a spreadsheet', () => {
    const evil = buildTradeHistoryCsv({
      exportedAtIso: 'x',
      history: buildTradeHistory(4663, FLOWS.slice(0, 1), timeOf),
      symbolOf: () => '=cmd|calc',
      chainNameOf: () => 'Robinhood',
      wallets: ['0xaaa'],
    })
    // the $ prefix plus csvEscape's guard: no cell starts with a bare =
    for (const line of evil.split('\n')) {
      for (const cell of line.split(',')) expect(cell.startsWith('=')).toBe(false)
    }
  })
})
