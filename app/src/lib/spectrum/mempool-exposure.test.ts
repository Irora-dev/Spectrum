import { describe, expect, it } from 'vitest'
import { mempoolExposureOf } from './mempool-exposure'

// NOTE: hostile probes here use \u ESCAPES, not literal bytes — a file carrying
// real RTL/zero-width characters is invisible to a binary-skipping grep (the
// read-failed law wearing a grep, which bit this lane twice today).
const RTL = '\u202e'
const ZWSP = '\u200b'
const CTRL = /[\u0000-\u001f\u007f]/
const BIDI = /[\u202a-\u202e\u2066-\u2069]/
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/

describe('rule 6 — detect and DISCLOSE (no enforcement is claimed)', () => {
  const SYMS = ['AAVE', 'DEGEN', 'WELL', 'NVDA']

  it('the public path says what is actually revealed: the whole plan, in one object, tradeable ahead of', () => {
    const e = mempoolExposureOf({ symbols: SYMS, atomicBundle: false })
    expect(e.path).toBe('public-pool')
    expect(e.reducedExposure).toBe(false)
    expect(e.disclosure).toMatch(/visible in the public queue/)
    expect(e.disclosure).toMatch(/whole plan at once/)
    expect(e.disclosure).toMatch(/trade ahead of it/)
    // ⚠ AND IT MUST NOT OVERCLAIM THE FLOORS. They bound the loss; they do not
    // hide the plan, and saying otherwise would be the protection-that-never-
    // existed pattern this module's header exists to refuse.
    expect(e.disclosure).toMatch(/do not hide the plan/)
    expect(e.disclosure).not.toMatch(/protect(ed|s) (you|your) (from|against)/i)
    expect(e.disclosure).not.toMatch(/\b(safe|secure|prevents?)\b/i)
  })

  it('the bundler path states a FACT about the wallet, never a guarantee from us', () => {
    const e = mempoolExposureOf({ symbols: SYMS, atomicBundle: true })
    expect(e.path).toBe('wallet-bundler')
    expect(e.reducedExposure).toBe(true)
    expect(e.disclosure).toMatch(/its own bundler/)
    // "less visible" is the honest comparative; "private" or "hidden" would be a
    // claim about bundlers we cannot make (some forward to the public pool)
    expect(e.disclosure).toMatch(/less of it is visible/)
    expect(e.disclosure).not.toMatch(/\b(private|hidden|invisible|cannot be seen)\b/i)
    // the object still carries the whole plan — the bundler changes WHO sees it
    // waiting, not what it contains
    expect(e.disclosure).toMatch(/whole plan/)
  })

  it('symbols are bounded and inert — this text is a money surface', () => {
    const e = mempoolExposureOf({ symbols: ['A'.repeat(300), `X${RTL}evil`, `US${ZWSP}DC`], atomicBundle: false })
    for (const s of e.shownSymbols) expect(s.length).toBeLessThanOrEqual(24)
    expect(e.disclosure.length).toBeLessThanOrEqual(600)
    expect(CTRL.test(e.disclosure), 'control characters').toBe(false)
    expect(BIDI.test(e.disclosure), 'direction override').toBe(false)
    expect(ZERO_WIDTH.test(e.disclosure), 'zero-width').toBe(false)
  })

  it('a long list is summarised rather than dumped, and an empty one says the honest short thing', () => {
    const many = mempoolExposureOf({ symbols: ['A', 'B', 'C', 'D', 'E', 'F'], atomicBundle: false })
    expect(many.disclosure).toMatch(/and 3 more/)
    const none = mempoolExposureOf({ symbols: [], atomicBundle: false })
    expect(none.legCount).toBe(0)
    expect(none.disclosure).toMatch(/visible in the public queue/)
    expect(none.disclosure).not.toMatch(/whole plan/)
  })
})
