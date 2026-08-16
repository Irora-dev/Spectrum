import { describe, expect, it } from 'vitest'
import realIndexHtml from '../../../index.html?raw'
import { basketMeta, creatorMeta, referMeta, rewriteOgHtml } from './meta'

// A faithful slice of index.html's <head> (same attribute order the real file
// ships: property|name first, then content).
const SAMPLE = `<!doctype html><html><head>
<title>Spectrum · onchain baskets</title>
<meta name="description" content="Spectrum is software for creating and reading onchain basket tokens." />
<meta property="og:title" content="Spectrum · onchain baskets" />
<meta property="og:description" content="Spectrum is software for creating and reading onchain basket tokens." />
<meta property="og:url" content="/" />
<meta property="og:image" content="/og.png" />
<meta property="og:image:alt" content="Spectrum — onchain baskets." />
<meta name="twitter:title" content="Spectrum · onchain baskets" />
<meta name="twitter:description" content="Spectrum is software for creating and reading onchain basket tokens." />
<meta name="twitter:image" content="/og.png" />
</head><body></body></html>`

describe('rewriteOgHtml', () => {
  it('rewrites <title> + og/twitter tags for a basket URL', () => {
    const out = rewriteOgHtml(SAMPLE, basketMeta({ symbol: 'SYRUP', name: 'Sector Rotator' }, 8453, '0xABC', 'https://spectrum.xyz'))
    expect(out).toContain('<title>$SYRUP · Sector Rotator · Spectrum</title>')
    expect(out).toContain('property="og:title" content="$SYRUP · Sector Rotator · Spectrum"')
    expect(out).toContain('name="twitter:title" content="$SYRUP · Sector Rotator · Spectrum"')
    // & in the query is attribute-escaped
    expect(out).toContain('property="og:url" content="https://spectrum.xyz/token?addr=0xABC&amp;chain=8453"')
    // the generic site title is fully gone
    expect(out).not.toContain('Spectrum · onchain baskets')
  })

  it('rewrites for a creator URL', () => {
    const out = rewriteOgHtml(SAMPLE, creatorMeta('0x1111111111111111111111111111111111111111', 'https://spectrum.xyz'))
    expect(out).toContain('<title>0x1111…1111 · Spectrum creator</title>')
    expect(out).toContain('property="og:url" content="https://spectrum.xyz/creator/0x1111111111111111111111111111111111111111"')
  })

  it('rewrites for the refer page', () => {
    const out = rewriteOgHtml(SAMPLE, referMeta('https://spectrum.xyz'))
    expect(out).toContain('<title>Refer &amp; earn · Spectrum</title>')
    expect(out).toContain('property="og:image" content="https://spectrum.xyz/og.png"')
  })

  it('escapes quotes/amps/lt in attribute values', () => {
    const out = rewriteOgHtml(SAMPLE, { title: 'A & "B" <c>', description: 'd', image: 'i', url: 'u', imageAlt: 'a' })
    expect(out).toContain('content="A &amp; &quot;B&quot; &lt;c>"')
  })

  it('leaves the document untouched when no tags match', () => {
    const bare = '<html><head></head><body>hi</body></html>'
    expect(rewriteOgHtml(bare, referMeta('https://x'))).toBe(bare)
  })

  // Guard against the regex drifting from the ACTUAL shipped index.html head
  // (the edge function rewrites the real file, not this test's sample).
  it('rewrites the real index.html head', () => {
    const out = rewriteOgHtml(realIndexHtml, basketMeta({ symbol: 'SYRUP', name: 'Sector Rotator' }, 8453, '0xABC', 'https://spectrum.xyz'))
    expect(out).toContain('<title>$SYRUP · Sector Rotator · Spectrum</title>')
    expect(out).toContain('property="og:title" content="$SYRUP · Sector Rotator · Spectrum"')
    expect(out).toContain('name="twitter:image" content="https://spectrum.xyz/og.png"')
    expect(out).not.toContain('<title>Spectrum · onchain baskets</title>')
  })

  it('points og:image at the basket OWN card when one was rendered, and falls back when not', () => {
    // The fallback is the load-bearing half: a basket launched after the last
    // build has no card, and a stale-but-branded picture beats a broken image.
    const withCard = basketMeta({ symbol: 'LPADS', name: 'Launchpads' }, 4663, '0xAbCd', 'https://x.io', true)
    expect(withCard.image).toBe('https://x.io/og/4663/0xabcd.png')
    const without = basketMeta({ symbol: 'LPADS', name: 'Launchpads' }, 4663, '0xAbCd', 'https://x.io', false)
    expect(without.image).toBe('https://x.io/og.png')
    // and unspecified must behave as "no card"
    expect(basketMeta({ symbol: 'LPADS', name: 'Launchpads' }, 4663, '0xAbCd', 'https://x.io').image).toBe('https://x.io/og.png')
  })
})
