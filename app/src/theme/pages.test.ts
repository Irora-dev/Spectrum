import { describe, it, expect } from 'vitest'
import { pageEnabled, prismCreditEnabled, starterTokensEnabled, stocksEnabled } from './brand'

describe('pageEnabled (default-on)', () => {
  it('undefined pages -> everything on', () => {
    expect(pageEnabled(undefined, 'refer')).toBe(true)
    expect(pageEnabled(undefined, 'trade')).toBe(true)
  })
  it('empty config -> everything on', () => {
    expect(pageEnabled({}, 'integrate')).toBe(true)
  })
  it('only an explicit false hides a page; true/omitted stay on', () => {
    const pages = { refer: false, docs: true }
    expect(pageEnabled(pages, 'refer')).toBe(false)
    expect(pageEnabled(pages, 'docs')).toBe(true)
    expect(pageEnabled(pages, 'integrate')).toBe(true) // omitted
  })
})

// (The CLI wizard mirrors PAGE_KEYS by hand and can't import from the app; that
// parity is pinned from the wizard's own node suite — create/render.test.mjs —
// where filesystem reads are available. This file's tsconfig has no node types.)

// Every default-ON feature knob: omission and `true` mean ON, only an explicit
// `false` turns it off — the contract the studio + wizard exporters rely on.
describe('feature knobs are default-ON', () => {
  const knobs = [
    ['stocks', stocksEnabled],
    ['prismCredit', prismCreditEnabled],
    ['starterTokens', starterTokensEnabled],
  ] as const
  for (const [key, fn] of knobs) {
    it(`${key}: omitted/true -> on, false -> off`, () => {
      expect(fn({})).toBe(true)
      expect(fn({ [key]: true })).toBe(true)
      expect(fn({ [key]: false })).toBe(false)
    })
  }
})
