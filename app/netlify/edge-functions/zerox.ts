// Netlify Edge Function — THE 0x PROXY. Netlify is the hosting platform
// (the owner, 2026-08-07), so this is the one adapter.
//
// ⚠ DELIBERATELY THIN. Everything with a decision in it lives in
// `src/lib/spectrum/zerox-proxy-handler.ts`, because THIS file is checked by
// nothing: `tsconfig.app.json` includes `src` only and `npm run lint` is
// `eslint src`. Review found that in 2026-08-07 while the whole request
// lifecycle — the env read, both origin checks, the upstream call, the
// response passthrough — sat here uncovered, in the one file that touches the
// credential. A renamed export or a typo'd variable would have shipped green
// and surfaced as a runtime 500. An adapter this thin can only fail in ways a
// deploy surfaces at once; anything subtler is in `src`, where tsc, eslint and
// vitest all see it.
//
// WHY A PROXY AT ALL (the owner: "fix this so no one can get our 0x key"): a
// static bundle cannot hold a secret — MEASURED, a dummy `VITE_` value landed
// in `dist/assets/*.js` twice — and the key had no origin binding, so 0x
// answered 200 to a forged Origin and 200 to curl with none. The key is read
// from `ZEROX_API_KEY`, a SERVER-side variable; it must never wear the `VITE_`
// prefix, which is what inlines a value into the client bundle.
// `scripts/no-client-secrets.mjs` runs as postbuild and fails the build if that regresses.

import { handleZeroxProxy } from '../../src/lib/spectrum/zerox-proxy-handler.ts'

interface EdgeContext {
  next: () => Promise<Response>
}

/** Netlify publishes the site's real URL; prefer it over the inbound host,
 *  which a request can claim for itself — comparing against the request's own
 *  host is self-satisfying and makes every preview deploy a working public
 *  proxy on the production key. */
const canonicalOrigin = (() => {
  const raw = Deno.env.get('URL') ?? Deno.env.get('DEPLOY_PRIME_URL') ?? ''
  try {
    return raw ? new URL(raw).origin : null
  } catch {
    return null
  }
})()

export default async function handler(req: Request, _ctx: EdgeContext): Promise<Response> {
  return handleZeroxProxy(req, {
    apiKey: Deno.env.get('ZEROX_API_KEY') ?? null,
    canonicalOrigin,
    extraOrigins: (Deno.env.get('ZEROX_ALLOWED_ORIGINS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  })
}

export const config = { path: '/api/zerox/*' }
