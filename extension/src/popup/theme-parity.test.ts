// Anti-drift tripwire. The popup's theme.css restates the app's design tokens
// (CSS can't cleanly import across the packages without dragging the whole app
// stylesheet in), and restated values drift — so this test pins every token in
// the extension theme to the app's value. When the app changes a token, this
// fails, and the fix is to re-copy the value, never to fork it.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const appCss = readFileSync(resolve(here, '../../../app/src/index.css'), 'utf8')
const extCss = readFileSync(resolve(here, './theme.css'), 'utf8')

// Deliberate, documented divergences from the app's tokens.
const DIVERGENT = new Set([
  // Spec 2026-08-02 §3: extension numbers are Chakra Petch; Space Grotesk is
  // not bundled (two faces, both already local).
  '--font-num',
])

function themeTokens(css: string): Map<string, string> {
  const start = css.indexOf('@theme')
  const block = css.slice(start, css.indexOf('}', start))
  const out = new Map<string, string>()
  for (const m of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(m[1], m[2].replace(/\s+/g, ' ').trim())
  }
  return out
}

describe('design-token parity with the app', () => {
  const app = themeTokens(appCss)
  const ext = themeTokens(extCss)

  it('found both @theme blocks', () => {
    expect(app.size).toBeGreaterThan(10)
    expect(ext.size).toBeGreaterThan(10)
  })

  it('every extension token matches the app token it restates', () => {
    const mismatches: string[] = []
    for (const [name, value] of ext) {
      if (DIVERGENT.has(name)) continue
      const appValue = app.get(name)
      if (appValue === undefined) {
        mismatches.push(`${name}: not an app token (invented tokens break the shared language)`)
      } else if (appValue !== value) {
        mismatches.push(`${name}: app has "${appValue}", extension has "${value}"`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('never reintroduces the failed ink-faint (#565669 measured 2.81:1)', () => {
    expect(ext.get('--color-ink-faint')?.toLowerCase()).toBe('#7a7a8d')
    expect(extCss).not.toMatch(/565669/i)
  })

  it('carries the exact card-surface glass', () => {
    expect(extCss).toContain('rgba(23, 23, 32, 0.78)')
  })
})
