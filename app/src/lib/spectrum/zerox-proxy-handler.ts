import { browserFetchAllowed, buildZeroxUpstream, originAllowed, stripProxyPrefix } from './zerox-proxy-request.ts'

// ─────────────────────────────────────────────────────────────────────────────
// THE 0x PROXY'S HANDLER — the whole request lifecycle, in a file that is
// TYPECHECKED AND TESTED.
//
// ⚠ IT USED TO LIVE ENTIRELY INSIDE THE EDGE FUNCTION (A6 review, 2026-08-07).
// `tsconfig.app.json` includes `src` only and `npm run lint` is `eslint src`,
// so `netlify/edge-functions/*.ts` was checked by NOTHING — no tsc, no lint,
// no test — and it is the one file that touches the credential. A renamed
// export, a typo'd env var or a wrong import path shipped green and surfaced
// as a runtime 500 in production. Only the URL builder was covered; the env
// read, the origin checks, the upstream call and the response passthrough
// were not.
//
// So the platform adapter is now three lines that supply an env and call this.
// Everything with a decision in it is here, behind an injectable `fetchImpl`,
// so the 405/403/404/503/502 envelopes and the exact upstream request are
// assertable without deploying anything.
// ─────────────────────────────────────────────────────────────────────────────

export interface ZeroxProxyEnv {
  /** The credential. Absent = the deployment was not configured. */
  apiKey: string | null
  /** The site's own canonical origin, from the platform rather than from the
   *  inbound request — a check against the request's own host is
   *  self-satisfying and makes every preview deploy a working public proxy. */
  canonicalOrigin: string | null
  /** Extra origins the operator declared (a custom domain, a preview URL). */
  extraOrigins: readonly string[]
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // a quote is a moment in time, and a cached 200 for one caller is a free
      // answer for the next
      'cache-control': 'no-store',
      // the static _headers file is applied by the CDN to static responses,
      // not to this function's own
      'x-content-type-options': 'nosniff',
    },
  })

export async function handleZeroxProxy(req: Request, env: ZeroxProxyEnv): Promise<Response> {
  const url = new URL(req.url)
  const doFetch = env.fetchImpl ?? fetch

  // GET only. A proxy that accepts any verb invites use as a general relay.
  if (req.method !== 'GET') return json(405, { name: 'METHOD_NOT_ALLOWED', message: 'GET only' })

  if (!originAllowed(req.headers.get('origin'), env.canonicalOrigin ?? url.origin, env.extraOrigins)) {
    return json(403, { name: 'ORIGIN_NOT_ALLOWED', message: 'This endpoint serves its own site only.' })
  }
  // the check that actually stops an <img>-tag quota drain: browsers omit
  // Origin on subresource loads but always send Sec-Fetch-*, and a page cannot
  // forge them
  if (!browserFetchAllowed(req.headers.get('sec-fetch-site'), req.headers.get('sec-fetch-dest'))) {
    return json(403, { name: 'ORIGIN_NOT_ALLOWED', message: 'This endpoint serves its own site only.' })
  }

  const path = stripProxyPrefix(url.pathname)
  if (path === null) return json(404, { name: 'BAD_PROXY_REQUEST', message: 'unsupported path' })

  const built = buildZeroxUpstream(path, url.searchParams)
  if (!built.ok) return json(built.status, { name: 'BAD_PROXY_REQUEST', message: built.reason })

  if (!env.apiKey) {
    // Say so rather than degrading quietly. The client classifies this as
    // read-failed — "we could not check" — never as a fact about the market.
    return json(503, { name: 'NO_UPSTREAM_KEY', message: 'This deployment has no 0x API key configured.' })
  }

  let upstream: Response
  try {
    upstream = await doFetch(built.url, {
      method: 'GET',
      headers: { '0x-api-key': env.apiKey, '0x-version': 'v2' },
      // ⚠⚠ NEVER FOLLOW A REDIRECT — a credential control, not a preference.
      // The fetch spec strips Authorization/Cookie/Proxy-Authorization on a
      // cross-origin redirect, but `0x-api-key` is a CUSTOM header and is not
      // covered, so a 3xx would re-send the key to whatever it pointed at.
      // The pinned-host allowlist cannot see that: the redirect happens after
      // the URL is built.
      redirect: 'manual',
      // without a timeout a slow upstream pins one invocation per leg for the
      // platform's full wall-clock limit — a cheap denial of service that is
      // independent of the 0x quota (and the house idiom already uses this)
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    return json(502, { name: 'UPSTREAM_UNREACHABLE', message: 'Could not reach the quote service.' })
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, { name: 'UPSTREAM_REDIRECTED', message: 'The quote service tried to redirect; refusing rather than following it.' })
  }

  // ⚠ ONLY CLAIM JSON WHEN THE UPSTREAM SENT JSON. Relabelling an HTML WAF or
  // challenge page as application/json destroys the client's ability to tell
  // "0x refused" from "something in front of 0x refused" — the exact
  // distinction the read-failed verdict rests on.
  if (!(upstream.headers.get('content-type') ?? '').includes('json')) {
    return json(502, { name: 'UPSTREAM_UNPARSEABLE', message: 'The quote service answered in a shape we do not recognise.' })
  }

  // Pass through the STATUS and the JSON body, and nothing else. The status is
  // load-bearing: the client separates a 422 policy refusal from a depth
  // refusal from an unknown failure, and collapsing those mis-tiers money. No
  // upstream header is echoed, so nothing can leak the credential or a
  // rate-limit token back to the caller.
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
}
