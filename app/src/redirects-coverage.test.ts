import { describe, expect, it } from 'vitest'
// ?raw, not node:fs — this is a browser project and its tsconfig carries no
// node types; Vite's raw import is the idiomatic way to read a file here and
// keeps the test inside the same transform pipeline as the app.
import appSource from './App.tsx?raw'
import redirectsSource from '../public/_redirects?raw'

// ─────────────────────────────────────────────────────────────────────────────
// EVERY NESTED ROUTE MUST HAVE ITS ASSET REWRITE.
//
// `vite.config.ts` sets `base: './'` so a build works under any subpath, which
// means index.html asks for `./assets/index-*.js` — resolved against the
// DOCUMENT's directory. On a nested route that is `/portfolio/assets/…`, which
// the SPA catch-all answers with index.html, so the browser is handed HTML
// where it expected a module and the page is blank. `public/_redirects` fixes
// it with one rewrite per nested route, and says so in its own header:
//
//     "Add a matching line whenever a new nested (multi-segment) route ships."
//
// That instruction had nothing enforcing it. This is the enforcement. It matters
// most for the SHORT LINKS (`/t/:chain/:ref`, `/c/…`, `/b/:creator/:slug`) —
// the forms the app MINTS and people paste into X and Telegram, where the
// failure is a white screen on a cold load while everything works in-app.
//
// Verified by construction: comment out any `/…/assets/*` line and the route it
// covers fails here.
// ─────────────────────────────────────────────────────────────────────────────

const routes = [...appSource.matchAll(/path="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => p.startsWith('/'))

const redirects = redirectsSource
  .split('\n')
  .map((l: string) => l.trim())
  .filter((l: string) => l && !l.startsWith('#'))

/** The directory a document at `route` is served from — what `./assets/…`
 *  resolves against. `/portfolio/classic` → `/portfolio`; `/` → ``. */
function documentDir(route: string): string {
  const segments = route.split('/').filter(Boolean)
  segments.pop() // the document itself, not a directory
  return segments.length ? `/${segments.join('/')}` : ''
}

/** Does any rule rewrite `${dir}/assets/*` back to the real bundle? A `:param`
 *  or `*` in the rule matches any single segment, exactly as the host treats it. */
function covered(dir: string): boolean {
  return redirects.some((line) => {
    const [from, to] = line.split(/\s+/)
    if (!from || !to || !/\/assets\/\*$/.test(from)) return false
    if (!to.startsWith('/assets/')) return false
    const pattern = from
      .replace(/\/assets\/\*$/, '')
      .split('/')
      .filter(Boolean)
      .map((seg) => (seg.startsWith(':') || seg === '*' ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')
    return new RegExp(`^/${pattern}$`).test(dir)
  })
}

describe('_redirects covers every nested route', () => {
  it('found the routes and the rules to check', () => {
    expect(routes.length).toBeGreaterThan(10)
    expect(redirects.length).toBeGreaterThan(1)
  })

  it('ends with the SPA catch-all, and the asset rules come before it', () => {
    const catchAll = redirects.findIndex((l) => l.startsWith('/*'))
    expect(catchAll, 'a /* catch-all must exist').toBeGreaterThanOrEqual(0)
    expect(catchAll, 'the catch-all must be LAST — a rule after it never runs').toBe(redirects.length - 1)
  })

  it('rewrites assets for every multi-segment route', () => {
    const missing = routes
      .map((route) => ({ route, dir: documentDir(route) }))
      // a single-segment route is served from `/`, where `./assets/…` is already right
      .filter(({ dir }) => dir !== '')
      .filter(({ dir }) => !covered(dir))
      .map(({ route, dir }) => `${route} → needs a rule for ${dir}/assets/*`)
    expect(missing).toEqual([])
  })
})
