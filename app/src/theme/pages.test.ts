import { describe, it, expect } from 'vitest'
import { pageEnabled } from './brand'

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
