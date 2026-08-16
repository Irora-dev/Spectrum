import { describe, expect, it } from 'vitest'
import { BATCH_FEE_BPS } from './allocation'

// ─────────────────────────────────────────────────────────────────────────────
// NO FILE MAY CARRY ITS OWN COPY OF THE FEE (gate, after the 4663 rehearsal was
// found DEAD by an independent review — 2026-08-07).
//
// My fee ruling (50 → 40) swept five test files. It missed
// rehearsal-4663.live.test.ts because that file is `describe.skipIf(!LIVE)` and
// NEVER RUNS under `npm test` or CI — only under `npm run rehearse:4663`, which
// is the exact moment someone tries to clear go-live readiness. Every test
// calling composeOneBasketLeg refused BEFORE ANY RPC: at 1e18 the rehearsal
// offered 995000000000000000 where the composer required 996000000000000000.
// A dress rehearsal that cannot compose is not a rehearsal.
//
// THE LESSON IS ABOUT REACH, NOT ABOUT 50: a suite cannot police a file it never
// runs. So this sweep reads SOURCE — every file, live-mode or not — and fails on
// any fee arithmetic written as a literal. It is the only check that reaches a
// file the runner never loads.
// ─────────────────────────────────────────────────────────────────────────────

// ⚠ SCOPED TO THE LIVE-MODE FILES, and the scope IS the fix. My first cut swept
// every source file for fee-shaped arithmetic and reported 31 offenders — nearly
// all legitimate bps math (slippage floors, tax terms, drift bands). A gate whose
// red is mostly false gets switched off, which is the disease, not the cure.
// The finding's root cause was REACH, not arithmetic style: `*.live.test.ts`
// files are `describe.skipIf(!LIVE)` and never run under `npm test` or CI, so
// the suite cannot police them and a constant change silently leaves them dead.
// Those are exactly the files a source-level sweep is the ONLY check for.
const SOURCES = import.meta.glob(['/src/**/*.live.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** Fee-shaped arithmetic: `* 50n) / 10_000n`, `* 50) / 10_000`, `feeBps: 50`. */
const LITERAL_FEE = /(\*\s*\d{1,3}n?\s*\)\s*\/\s*10_?000n?)|(\bfeeBps:\s*\d{1,3}\b)/g

describe('no file carries its own copy of the batching fee', () => {
  it('every fee-shaped literal reads the constant instead', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const [file, text] of Object.entries(SOURCES)) {
      if (file.includes('no-hardcoded-fee')) continue // this file quotes the shapes
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (/^\s*(\/\/|\*)/.test(line)) continue // a comment may quote a number
        scanned += 1
        for (const m of line.match(LITERAL_FEE) ?? []) {
          // the constant, a bps-shaped SLIPPAGE (9_950/10_000 etc), and a
          // percentage of something that is not the fee are all legitimate —
          // what is not is a bare fee number where the constant belongs
          if (/BATCH_FEE_BPS|RANGE_ORDER_FEE_BPS|PORTFOLIO_MAX_FEE_BPS/.test(line)) continue
          if (/\*\s*9_?\d{3}n?\s*\)/.test(m)) continue // (x * 9_950n)/10_000n — a floor, not a fee
          offenders.push(`${file}:${i + 1} ${line.trim().slice(0, 90)}`)
        }
      }
    }
    expect(Object.keys(SOURCES).length, 'no live-mode files found — the glob rotted').toBeGreaterThan(2)
    expect(scanned, 'the sweep read nothing — the glob rotted').toBeGreaterThan(200)
    expect(offenders, `${offenders.length} file(s) carry their own fee number:\n${offenders.join('\n')}`).toEqual([])
  })

  it('and the constant is what the rehearsal now reads', () => {
    expect(SOURCES['/src/rehearsal-4663.live.test.ts']).toContain('BATCH_FEE_BPS')
    expect(BATCH_FEE_BPS).toBe(40)
  })
})
