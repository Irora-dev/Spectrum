import { describe, expect, it } from 'vitest'
import { buildPortfolioCsv, csvEscape } from './csv-export'

describe('csv export (16:4x feature 7)', () => {
  it('escapes commas, quotes and newlines — a symbol cannot break the sheet', () => {
    expect(csvEscape('plain')).toBe('plain')
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape(null)).toBe('')
  })

  it('positions block always; activity block only when the log has rows, one row per change leg', () => {
    const out = buildPortfolioCsv({
      exportedAtIso: '2026-08-03T15:00:00.000Z',
      positions: [
        { symbol: 'WETH', kind: 'token', chain: 'BASE', amount: 1.5, priceUsd: 3550.123456, valueUsd: 5325.19, sharePct: 33.33 },
        { symbol: 'DEVBKT', kind: 'basket', chain: 'BASE', valueUsd: 9378, sharePct: 58.71 },
      ],
      activity: [
        {
          ts: Date.UTC(2026, 7, 3, 14, 0, 0),
          kind: 'rebalance',
          totalUsd: null,
          simulated: true,
          changes: [
            { symbol: 'WETH', deltaUsd: -120.5, realizedUsd: 14.2 },
            { symbol: 'USDC', deltaUsd: 120.5 },
          ],
        },
      ],
    })
    expect(out).toContain('POSITIONS')
    expect(out).toContain('$WETH,token,BASE,1.5,3550.123456,5325.19,33.33')
    expect(out).toContain('$DEVBKT,basket,BASE,,,9378.00,58.71')
    expect(out).toContain('ACTIVITY (recorded on this device)')
    expect(out).toContain('2026-08-03T14:00:00.000Z,rebalance,,true,$WETH,-120.50,14.20')
    expect(out).toContain(',true,$USDC,120.50,')
    const empty = buildPortfolioCsv({ exportedAtIso: 'x', positions: [], activity: [] })
    expect(empty).not.toContain('ACTIVITY')
  })
})

describe('audit pins (2026-08-03 self-review)', () => {
  it('a sub-cent price keeps its significance — 3e-8 must never print as 0.000000', () => {
    const out = buildPortfolioCsv({
      exportedAtIso: 'x',
      positions: [{ symbol: 'MICRO', kind: 'token', chain: 'BASE', amount: 1e9, priceUsd: 3e-8, valueUsd: 30, sharePct: 1 }],
      activity: [],
    })
    expect(out).not.toContain('0.000000')
    expect(out).toContain('3.00000e-8')
  })
})

describe('audit round 2: formula injection', () => {
  it('leading = + - @ get the apostrophe guard — a symbol cannot execute in a spreadsheet', () => {
    expect(csvEscape('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`)
    expect(csvEscape('@cmd')).toBe(`'@cmd`)
    expect(csvEscape('+1')).toBe(`'+1`)
    expect(csvEscape('plain')).toBe('plain')
  })
})
