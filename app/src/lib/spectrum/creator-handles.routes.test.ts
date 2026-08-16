import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
// `?raw` rather than node:fs — this file is under the BROWSER tsconfig, which
// has no node types (same reason as pages/learn-search.test.ts). Vite inlines
// the source, so the assertion still reads the real router.
import appSource from '../../App.tsx?raw'
import { APP_ROUTE_SEGMENTS, isReservedHandle } from './creator-handles'

// THE DERIVATION (spec §3): the reserved route list is not hand-kept. This test
// reads the router itself, so adding `/newpage` without reserving `newpage`
// fails the build instead of silently letting a creator's handle collide with a
// page — or worse, letting a page swallow a name someone already owns.
//
// It lives in a test rather than at runtime because the app ships as a browser
// bundle, which cannot read its own source. Same guarantee, checked earlier.

/** Every first path segment the router serves, from `path="…"` in App.tsx. */
function routeSegmentsInRouter(): string[] {
  const found = new Set<string>()
  for (const m of appSource.matchAll(/path="([^"]+)"/g)) {
    const segment = m[1].replace(/^\//, '').split('/')[0]
    // Params (`:id`) and the catch-all (`*`) are not names anyone can type.
    if (!segment || segment.startsWith(':') || segment === '*') continue
    found.add(segment.toLowerCase())
  }
  return [...found].sort()
}

describe('reserved route segments are derived from the router', () => {
  it('finds the router (a rename must fail loudly, not silently pass)', () => {
    expect(appSource).toContain('<Routes>')
    expect(routeSegmentsInRouter().length).toBeGreaterThan(20)
  })

  it('reserves every segment the router serves', () => {
    const missing = routeSegmentsInRouter().filter((s) => !isReservedHandle(s))
    expect(missing).toEqual([])
  })

  it('lists the segments in APP_ROUTE_SEGMENTS, so the constant stays honest', () => {
    const listed = new Set<string>(APP_ROUTE_SEGMENTS)
    const missing = routeSegmentsInRouter().filter((s) => !listed.has(s))
    expect(missing).toEqual([])
  })
})

// The creator route resolves a NAME while the page below still reads
// `:address`, by re-matching against a synthetic location (see
// components/creator/CreatorRoute.tsx). Two library facts carry that, and both
// are asserted here rather than assumed — a parent route quietly changed back
// from `/creator/*` to `/creator/:address` would break it silently.
describe('the creator route shape', () => {
  it('keeps both creator paths as splats, which the resolver needs', () => {
    expect(appSource).toContain('path="/creator/*"')
    expect(appSource).toContain('path="/c/*"')
  })

  it('a splat parent matches a handle URL and bases at the parent path', () => {
    const matched = matchRoutes([{ path: '/creator/*' }], { pathname: '/creator/basedresearch' })
    expect(matched?.[0].params['*']).toBe('basedresearch')
    expect(matched?.[0].pathnameBase).toBe('/creator')
  })

  it('the synthetic location hands the page the address as `:address`', () => {
    // Exactly what a descendant <Routes location> computes: the parent's
    // pathnameBase is sliced off, and the rest is matched by the child route.
    const base = '/creator'
    const synthetic = `${base}/0x1111111111111111111111111111111111111111`
    expect(synthetic.startsWith(base)).toBe(true) // React Router asserts this
    const remaining = '/' + synthetic.replace(/^\//, '').split('/').slice(1).join('/')
    const matched = matchRoutes([{ path: ':address' }], { pathname: remaining })
    expect(matched?.[0].params.address).toBe('0x1111111111111111111111111111111111111111')
  })
})
