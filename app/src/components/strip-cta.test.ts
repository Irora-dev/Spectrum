import { describe, expect, it } from 'vitest'
import { stripCtaLabel } from './DexSwapCard'

// The one-line quick-buy strip's CTA is `shrink-0 whitespace-nowrap` inside an
// UNCLIPPED card, so a long label doesn't truncate — it bleeds out of the card.
// The big console's state machine writes labels for a wide surface (up to 43
// chars), so the strip has to shorten them. These pin the real labels.
describe('stripCtaLabel', () => {
  it('is "Buy" before an amount is entered', () => {
    expect(stripCtaLabel('Swap', 0n, true)).toBe('Buy')
    expect(stripCtaLabel('Preview only · no router configured', 0n, true)).toBe('Buy')
  })

  it('passes short labels through untouched', () => {
    for (const short of ['Swap', 'Swapping…', 'Swap again', 'Connect']) {
      expect(stripCtaLabel(short, 100n, true)).toBe(short)
    }
  })

  it('shortens every long state the console can produce', () => {
    const longStates = [
      'Preview only · no router configured',
      'Switch wallet to Robinhood Chain',
      'First buy needs ≥ 10 USDG of liquidity',
      'Connect a wallet (top right)',
      'Insufficient ETH for gas and the deploy',
    ]
    for (const label of longStates) {
      const out = stripCtaLabel(label, 100n, true)
      expect(out.length, `"${label}" → "${out}" must stay short`).toBeLessThanOrEqual(16)
      expect(out.length).toBeGreaterThan(0)
      // Never chopped mid-word: either it's a rewritten stand-in (not a prefix of
      // the original), or it IS a prefix that ends on a word boundary.
      if (label.startsWith(out)) {
        const next = label.charAt(out.length)
        expect(next === '' || /[\s·—,(]/.test(next), `"${label}" → "${out}" chopped mid-word`).toBe(true)
      }
    }
  })

  it('never returns an empty label, whatever it is handed', () => {
    for (const weird of ['', '·', '   ', '·······················']) {
      expect(stripCtaLabel(weird, 100n, true).length).toBeGreaterThan(0)
    }
  })

  it('with no basket selected it does NOT force "Buy" (the label is the action)', () => {
    expect(stripCtaLabel('Select a basket', 0n, false)).toBe('Select a basket')
  })
})
