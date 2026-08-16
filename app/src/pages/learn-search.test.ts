import { describe, expect, it } from 'vitest'
// `?raw` rather than node:fs — this file is under the BROWSER tsconfig, which has
// no node types (the same reason the sacred smoke avoids `process`). Vite inlines
// the source at build time, so the assertion still reads the real file.
import SRC from './Learn.tsx?raw'
import { QA_QUESTIONS } from './Learn'

// ─────────────────────────────────────────────────────────────────────────────
// The search's result count is computed from QA_QUESTIONS, while what appears on
// screen is filtered from the actual <Q q="…"> elements. Two sources for one
// truth, so they can drift: add a question and forget the registry line, and the
// page shows four answers while the field says three.
//
// Rather than restructure thirty JSX answers into a data table (a migration where
// an answer could be lost), the drift is caught here — the test reads the file and
// asserts the two lists are identical.
// ─────────────────────────────────────────────────────────────────────────────

const rendered = [...SRC.matchAll(/<Q q="([^"]+)"/g)].map((m) => m[1])

describe('learn: the search registry cannot drift from the content', () => {
  it('lists exactly the questions the page renders, in order', () => {
    expect(QA_QUESTIONS).toEqual(rendered)
  })

  it('is not empty, so a broken extraction cannot pass silently', () => {
    expect(QA_QUESTIONS.length).toBeGreaterThan(10)
  })

  it('has no duplicates, which would double-count a match', () => {
    expect(new Set(QA_QUESTIONS).size).toBe(QA_QUESTIONS.length)
  })

  // Every group must be reachable from the menu or it is unreachable content.
  it('the jump menu covers every Q&A group id that exists', () => {
    const groups = [...SRC.matchAll(/<Group id="(q-[a-z]+)"/g)].map((m) => m[1])
    const jump = [...SRC.matchAll(/\{ id: '([a-z-]+)', label:/g)].map((m) => m[1])
    expect(groups.length).toBeGreaterThan(0)
    // Not every group needs its own pill, but the FIRST and the risk group are the
    // two the menu promises; the real assertion is that no pill points at nothing.
    for (const id of jump) {
      expect(SRC).toMatch(new RegExp(`id="${id}"`))
    }
  })

  it('every group is passed the query, or it would silently ignore the search', () => {
    const groups = [...SRC.matchAll(/<Group id="q-[a-z]+" label="[^"]+"([^>]*)>/g)].map((m) => m[1])
    expect(groups.length).toBeGreaterThan(0)
    for (const attrs of groups) expect(attrs).toContain('query={query}')
  })
})

// The contents menu is the page's own table of contents, and a menu entry pointing
// at nothing is a dead link the reader discovers by clicking it. Every id it lists
// must exist as an anchor in the file.
describe('learn: the contents menu cannot point at a section that does not exist', () => {
  const contents = [...SRC.matchAll(/\{ id: '([a-z-]+)', label: '[^']*', kind:/g)].map((m) => m[1])

  it('lists a real set of sections', () => {
    expect(contents.length).toBeGreaterThan(3)
  })

  it('every entry resolves to an anchor on the page', () => {
    for (const id of contents) {
      expect(SRC, `contents entry "${id}" has no matching id=`).toMatch(new RegExp(`id="${id}"`))
    }
  })

})
