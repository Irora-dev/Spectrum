// ─────────────────────────────────────────────────────────────────────────────
// THE /embed HEADER EXCEPTION (four-reviewer audit, 2026-08-07).
//
// The app's CSP bans framing globally — the right default for a wallet app,
// and the wrong one for the ONE route that exists to be framed: /embed is a
// chrome-less basket card creators paste on their own sites, and the launch
// banner mints its iframe snippet. Under the blanket ban every shipped embed
// goes blank the day the headers land on a line that serves them.
//
// WHY AN EDGE FUNCTION AND NOT A _headers BLOCK: Netlify applies every
// matching _headers rule and duplicate CSP headers INTERSECT — a per-path
// block can only tighten, never loosen. This function is the loosening
// mechanism: it lets the static response through and rewrites exactly two
// headers. The VALUES live in scripts/csp.mjs (EMBED_HEADER_OVERRIDES) with
// the reasoning and the stated residual; this file only applies them — but an
// edge function cannot import app scripts, so the check that the two stay in
// step is scripts/csp.test.mjs, not an import.
//
// frame-ancestors * : any creator's site may embed — that is the product.
// X-Frame-Options   : REMOVED, because it has no value that means "anyone".
// Everything else stays the strict policy, protecting the card itself.
// ─────────────────────────────────────────────────────────────────────────────
import type { Context } from '@netlify/edge-functions'

export default async function embedHeaders(_req: Request, context: Context) {
  const res = await context.next()
  const csp = res.headers.get('Content-Security-Policy')
  if (csp) res.headers.set('Content-Security-Policy', csp.replace("frame-ancestors 'none'", 'frame-ancestors *'))
  res.headers.delete('X-Frame-Options')
  return res
}

export const config = { path: '/embed' }
