// Netlify Edge Function — per-URL OpenGraph/Twitter previews for shared links.
//
// Social crawlers (X, Telegram, Discord, Slack, iMessage) don't run JavaScript,
// so a client-rendered SPA can only ever show them the ONE generic card baked
// into index.html. This runs at the edge, IN FRONT of the static site, and
// rewrites the og/twitter tags per shared URL for the three surfaces people
// share: a basket (/token), a creator profile (/creator/:addr), and the refer
// page (/refer). Everything else is served untouched.
//
// Unlike the standalone Cloudflare worker (frontend/handover/og-worker), this
// ships and deploys WITH the app on Netlify — no separate deploy, no Workers
// Route to configure. The operator does nothing extra.
//
// The meta-building + rewrite logic is the pure, unit-tested module in
// src/lib/og/meta.ts (imported here with a .ts extension for Deno). og:image is
// the branded generic card for now; per-basket card IMAGES are the follow-up
// (see ./README.md).

import { basketMeta, creatorMeta, referMeta, rewriteOgHtml, type OgMeta } from '../../src/lib/og/meta.ts'

// Minimal shape of the Netlify edge Context (avoids a build-time dep on
// @netlify/edge-functions; Netlify injects the real one at deploy).
interface EdgeContext {
  next: () => Promise<Response>
}

interface TokenlistToken {
  chainId: number
  address: string
  symbol: string
  name: string
}

async function tokenFor(origin: string, chainId: number, address: string): Promise<TokenlistToken | null> {
  try {
    const res = await fetch(`${origin}/tokenlist.json`)
    if (!res.ok) return null
    const list = (await res.json()) as { tokens?: TokenlistToken[] }
    return (
      (list.tokens ?? []).find(
        (t) => t.chainId === chainId && t.address.toLowerCase() === address.toLowerCase(),
      ) ?? null
    )
  } catch {
    return null
  }
}

export default async (request: Request, context: EdgeContext): Promise<Response> => {
  const url = new URL(request.url)
  const res = await context.next()
  // Only HTML documents carry meta — pass assets/JSON straight through.
  if (!/text\/html/i.test(res.headers.get('content-type') ?? '')) return res

  let meta: OgMeta | null = null
  if (url.pathname === '/token') {
    const addr = url.searchParams.get('addr')
    const chain = Number(url.searchParams.get('chain')) || 8453
    if (addr) {
      const t = await tokenFor(url.origin, chain, addr)
      if (t) meta = basketMeta(t, chain, addr, url.origin)
    }
  } else {
    const creator = url.pathname.match(/^\/creator\/(0x[0-9a-fA-F]{40})$/)
    if (creator) meta = creatorMeta(creator[1], url.origin)
    else if (url.pathname === '/refer') meta = referMeta(url.origin)
  }

  // Unknown basket / unmatched → serve the origin untouched (generic site card).
  if (!meta) return res
  const html = await res.text()
  return new Response(rewriteOgHtml(html, meta), { status: res.status, headers: res.headers })
}

// Only run on the shareable surfaces; everything else skips the function entirely.
export const config = { path: ['/token', '/creator/*', '/refer'] }
