import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// THE /embed EXCEPTION'S THREE SURFACES CANNOT DRIFT (audit 2026-08-07).
//
// The exception lives in three places that cannot import each other: the
// Netlify edge function (rewrites headers at serve time), vercel.json's
// /embed rule (emitted), and the strict default everywhere else. A loosening
// that exists on one host and not the other is a policy an operator cannot
// rely on — and a drifted default (frames allowed globally) would be the
// wallet-drainer primitive the CSP exists to deny.
// ─────────────────────────────────────────────────────────────────────────────

const RAW = import.meta.glob(['/netlify/edge-functions/embed-headers.ts', '/public/_headers', '/vercel.json'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('the /embed header exception', () => {
  it('the DEFAULT stays strict: _headers global block denies framing twice over', () => {
    const h = RAW['/public/_headers']
    expect(h).toContain("frame-ancestors 'none'")
    expect(h).toContain('X-Frame-Options: DENY')
    // and _headers must NOT carry an /embed loosening — Netlify duplicate CSP
    // headers INTERSECT, so a block here would be a no-op wearing a fix
    expect(h).not.toMatch(/\n\/embed\n/)
  })

  it('the edge function rewrites exactly the strings the strict policy emits', () => {
    const fn = RAW['/netlify/edge-functions/embed-headers.ts']
    const headers = RAW['/public/_headers']
    // the replace target must literally appear in the emitted policy, or the
    // rewrite silently matches nothing and every embed stays blank
    expect(fn).toContain(`"frame-ancestors 'none'"`)
    expect(headers).toContain("frame-ancestors 'none'")
    expect(fn).toContain("'frame-ancestors *'")
    expect(fn).toContain("res.headers.delete('X-Frame-Options')")
    expect(fn).toContain("path: '/embed'")
  })

  it('the Vercel half says the same thing: /embed framable, no X-Frame-Options, everything else strict', () => {
    const v = JSON.parse(RAW['/vercel.json']) as {
      headers: { source: string; headers: { key: string; value: string }[] }[]
    }
    const embed = v.headers.find((h) => h.source === '/embed')
    expect(embed).toBeDefined()
    const csp = embed!.headers.find((h) => h.key === 'Content-Security-Policy')
    expect(csp!.value).toContain('frame-ancestors *')
    expect(csp!.value).not.toContain("frame-ancestors 'none'")
    expect(embed!.headers.some((h) => h.key === 'X-Frame-Options')).toBe(false)
    // and the global rule stays strict
    const all = v.headers.find((h) => h.source === '/(.*)')
    expect(all!.headers.find((h) => h.key === 'Content-Security-Policy')!.value).toContain("frame-ancestors 'none'")
    expect(all!.headers.some((h) => h.key === 'X-Frame-Options' && h.value === 'DENY')).toBe(true)
  })
})
