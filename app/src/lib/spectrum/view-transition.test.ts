import { describe, expect, it } from 'vitest'
import { vtName, withViewTransition } from './view-transition'

describe('the glide plumbing', () => {
  it('vtName makes a CSS-safe custom-ident, stable for the same id', () => {
    expect(vtName('canon:eth')).toBe('vt-canon-eth')
    expect(vtName('8453:0xAbC123')).toBe('vt-8453-0xAbC123')
    expect(vtName('canon:eth')).toBe(vtName('canon:eth'))
    // never a raw colon or dot — those break the CSS parser
    expect(vtName('1:0xee.ee')).not.toMatch(/[:.]/)
  })

  it('withViewTransition runs the update plainly when the platform lacks support', async () => {
    let ran = false
    withViewTransition(() => {
      ran = true
    })
    expect(ran).toBe(true) // vitest env has no startViewTransition — plain path
  })
})
