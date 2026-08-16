import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// EVERY SYMBOL REACHING A CSS-UNREACHABLE SURFACE IS BOUNDED (desk 232, turned
// from a 250-site manual audit into a gate — the every-write-names-its-chain
// pattern, applied).
//
// A token symbol is deployer-controlled text. In JSX it is a text node, so
// React escapes it and the risk is LAYOUT — and most of those elements already
// carry a truncate class, which is why I refused to mass-apply showSymbol
// across ~250 sites: an unreviewable diff changing displayed text everywhere,
// for a risk already handled in an unknown fraction of cases.
//
// BUT THE SUBSET THAT CSS CANNOT REACH IS DIFFERENT IN KIND, and it is the
// subset a visual check can never catch: aria-label, title, alt,
// document.title, and anything copied to the clipboard or a CSV. No truncate
// class bounds those; a 300-char symbol becomes a 300-char accessible name,
// and a newline in one becomes a forged line in a share string. Those sites
// must go through safe-copy.
//
// So the sweep is SCOPED to that subset rather than to every interpolation —
// which is the difference between a gate people keep and a gate people switch
// off. Site 251 is now safe by construction; the wide truncate-audit remains a
// judgement call per surface, as it should.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCES = import.meta.glob(['/src/**/*.ts', '/src/**/*.tsx', '!/src/**/*.test.*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Attributes and sinks CSS cannot bound. */
const UNREACHABLE_SINK = /(aria-label|title|alt|placeholder)\s*=\s*[{"'`]|document\.title\s*=|clipboard\.writeText\(/

/** A raw symbol interpolation — `${x.symbol}` or `${symbol}` NOT already
 *  wrapped by a safe-copy helper. `showSymbol(...)`/`showName(...)` inside the
 *  interpolation is the accepted form. */
const RAW_SYMBOL = /\$\{[^}]*\bsymbol\b[^}]*\}/g
const SAFE = /show(Symbol|Name|ChainId)\s*\(/

describe('every symbol on a CSS-unreachable surface is bounded', () => {
  it('no aria-label / title / alt / document.title / clipboard string interpolates a RAW symbol', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const [file, text] of Object.entries(SOURCES)) {
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!UNREACHABLE_SINK.test(line)) continue
        scanned += 1
        // the sink and the interpolation may sit on the same line, or the
        // interpolation may follow on the next (prettier wraps long attrs)
        const window = `${line}\n${lines[i + 1] ?? ''}`
        for (const m of window.match(RAW_SYMBOL) ?? []) {
          if (!SAFE.test(m)) offenders.push(`${file}:${i + 1} ${m.slice(0, 60)}`)
        }
      }
    }
    // the sweep must have LOOKED — zero sink lines means the pattern rotted,
    // not that the app stopped having accessible names
    expect(scanned, 'no CSS-unreachable sinks found at all — the pattern rotted').toBeGreaterThan(20)
    expect(offenders, `${offenders.length} unbounded symbol(s) on surfaces CSS cannot reach:\n${offenders.join('\n')}`).toEqual([])
  })
})
