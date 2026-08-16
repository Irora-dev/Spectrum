// ─────────────────────────────────────────────────────────────────────────────
// THE 0x PROXY'S REQUEST CONTRACT — pure, so the security-bearing half is unit
// tested rather than living inside an edge function nothing can run locally
// (the same split as `src/lib/og/meta.ts` behind the OG edge function).
//
// WHY A PROXY EXISTS AT ALL (the owner, 2026-08-07: "we need to fix this so no one
// can get our 0x key"). A static bundle cannot hold a secret — MEASURED, not
// assumed: building with a dummy value put the literal in `dist/assets/*.js`
// twice, and even obfuscated it would still travel as a plaintext header the
// network tab shows. And the key had NO origin binding: 0x answered 200 to a
// request carrying `Origin: https://totally-unrelated-attacker.example`, and
// 200 to curl with no origin at all, while the same request without the key
// answered 401. So the key alone authorises, from anywhere.
//
// The only fix that actually removes the key from reach is to stop shipping it:
// the browser talks to OUR origin, the key lives in a SERVER-side variable
// (never `VITE_*`, which is what publishes it), and the upstream call happens
// where the user cannot see it.
//
// ⚠⚠ AND A PROXY MOVES ONE PROBLEM WITHOUT SOLVING THE OTHER, which must be
// said plainly rather than discovered later: it protects the KEY, not the
// QUOTA. Our endpoint is reachable by anyone, so a determined actor can still
// spend our 0x allowance through it — they simply cannot walk away with the
// credential and use it elsewhere, forever, on their own products. An origin
// check raises the cost (it stops another *website* using us from a browser)
// but curl forges headers freely, so it is a speed bump, not a wall. Real
// quota protection needs per-caller rate limiting with state, which an edge
// function does not have — that belongs to the platform's own rate limiting
// and is a STATED RESIDUAL, not something this file pretends to cover.
//
// THE OTHER THING THIS FILE IS FOR: a proxy that forwards whatever it is handed
// is an open relay. Every upstream URL is REBUILT from an allowlist here — the
// path, the parameter names, the chain ids, the address shapes — so a caller
// cannot smuggle a parameter we never intended, point us at another host, or
// use us to probe chains we do not support.
// ─────────────────────────────────────────────────────────────────────────────

/** The only upstream host this proxy will ever contact. */
export const ZEROX_HOST = 'https://api.0x.org'

/** The route the edge function is mounted on. */
export const PROXY_PREFIX = '/api/zerox'

/**
 * Strip the proxy prefix, or refuse.
 *
 * ⚠ THIS LIVED IN THE EDGE FUNCTION AS A BARE `slice(PREFIX.length)`, which is
 * a guard resting on someone else's config. If the pathname does NOT start with
 * the prefix, slice does not fail — it returns a PLAUSIBLE-LOOKING path
 * (`/somewhere/else` becomes `/else`), and the code carries on as though it had
 * parsed something. Today Netlify's `config.path` makes that unreachable, but
 * an input derivation that is only correct because of external routing is the
 * kind of thing that stops being true quietly, on another platform or after a
 * config edit. It is also in the ONE file `tsc -b` does not check (tsconfig
 * includes `src` only), which is exactly why the logic belongs here instead.
 */
export function stripProxyPrefix(pathname: string): string | null {
  if (!pathname.startsWith(`${PROXY_PREFIX}/`)) return null
  return pathname.slice(PROXY_PREFIX.length)
}

/** The only two 0x endpoints the app uses. `price` is the indicative read the
 *  coverage/probe path wants; `quote` is the executable one. Anything else —
 *  including a cleverly-encoded traversal — is refused rather than forwarded. */
// ⚠ `/price` WAS ALLOWLISTED AND CALLED BY NOTHING (A6 review) — double the
// free-oracle surface for zero benefit. Removed; add it back WITH its caller.
export const ALLOWED_PATHS = ['/swap/allowance-holder/quote'] as const
export type ZeroxPath = (typeof ALLOWED_PATHS)[number]

/** Chains the app actually composes for. A proxy that answers for any chain is
 *  a free general-purpose 0x gateway. */
export const ALLOWED_CHAIN_IDS = [1, 8453, 4663] as const

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** A decimal integer, bounded: `sellAmount` is a raw token amount, so it is
 *  large, but it is never 400 digits. An unbounded numeric string is a cheap
 *  way to make us build an absurd upstream URL. */
const RAW_AMOUNT = /^[0-9]{1,40}$/

export type ProxyRequestResult =
  | { ok: true; url: string }
  /** `reason` is for OUR logs and the client's classifier — never a passthrough
   *  of anything the caller sent, so a hostile parameter cannot write our
   *  error text. */
  | { ok: false; status: 400 | 404; reason: string }

/**
 * Validate an inbound proxy request and REBUILD the upstream URL from scratch.
 *
 * `path` is the inbound pathname with the proxy prefix already stripped;
 * `params` is the inbound query. Nothing from `params` reaches the upstream URL
 * except the names below, each re-validated — so an unexpected parameter is
 * DROPPED rather than forwarded, and a malformed one refuses the whole request.
 */
export function buildZeroxUpstream(path: string, params: URLSearchParams): ProxyRequestResult {
  if (!(ALLOWED_PATHS as readonly string[]).includes(path)) {
    return { ok: false, status: 404, reason: 'unsupported path' }
  }

  const chainId = params.get('chainId') ?? ''
  if (!/^[0-9]{1,7}$/.test(chainId) || !(ALLOWED_CHAIN_IDS as readonly number[]).includes(Number(chainId))) {
    return { ok: false, status: 400, reason: 'unsupported chainId' }
  }

  const sellToken = params.get('sellToken') ?? ''
  const buyToken = params.get('buyToken') ?? ''
  if (!ADDRESS.test(sellToken) || !ADDRESS.test(buyToken)) {
    return { ok: false, status: 400, reason: 'sellToken and buyToken must be addresses' }
  }
  // buying the funding asset with itself is never a real leg, and it is a cheap
  // way to burn quota on a no-op
  if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
    return { ok: false, status: 400, reason: 'sellToken and buyToken are the same asset' }
  }

  const sellAmount = params.get('sellAmount') ?? ''
  if (!RAW_AMOUNT.test(sellAmount) || /^0+$/.test(sellAmount)) {
    return { ok: false, status: 400, reason: 'sellAmount must be a positive raw integer' }
  }

  const taker = params.get('taker') ?? ''
  if (!ADDRESS.test(taker)) {
    return { ok: false, status: 400, reason: 'taker must be an address' }
  }

  // OPTIONAL and tightly bounded: the app sets the leg's slippage. Absent is
  // fine; present-and-malformed refuses rather than being silently dropped,
  // because a dropped slippage would quote a DIFFERENT trade than the caller
  // asked for.
  const slippageBps = params.get('slippageBps')
  if (slippageBps !== null && !/^[0-9]{1,4}$/.test(slippageBps)) {
    return { ok: false, status: 400, reason: 'slippageBps must be 0-9999' }
  }

  // OPTIONAL, and it exists for the SMART-CONTRACT TAKER case: when `taker` is
  // a contract (our batcher), 0x wants the EOA that will actually send the
  // transaction, because its Settler has confused-deputy protection that keys
  // off the caller. Same discipline as slippageBps — validated to an address,
  // present-and-malformed refuses rather than being dropped, because a silently
  // dropped txOrigin quotes a DIFFERENT trade than the caller asked for.
  const txOrigin = params.get('txOrigin')
  if (txOrigin !== null && !ADDRESS.test(txOrigin)) {
    return { ok: false, status: 400, reason: 'txOrigin must be an address' }
  }

  // Rebuilt from validated values only — the inbound query string is never
  // concatenated, so nothing unexpected rides along.
  // ⚠ FORWARD WHAT WE VALIDATED, not what we were sent (A6 review): `0008453`
  // passes the digit test, normalizes to 8453 for the allowlist check, and the
  // first cut then forwarded the RAW `0008453`. Two readings of one value, one
  // used to authorize and the other to act — the parse-differential shape this
  // allowlist exists to eliminate, even where the upstream happens to agree.
  const out = new URLSearchParams({ chainId: String(Number(chainId)), sellToken, buyToken, sellAmount, taker })
  if (slippageBps !== null) out.set('slippageBps', slippageBps)
  if (txOrigin !== null) out.set('txOrigin', txOrigin)
  return { ok: true, url: `${ZEROX_HOST}${path}?${out.toString()}` }
}

/**
 * Is this request coming from a page we serve?
 *
 * ⚠ A SPEED BUMP, NAMED AS ONE. `Origin` is set by browsers and forged freely
 * by anything that is not a browser, so this stops another SITE from using our
 * endpoint as a free gateway in a user's browser; it does not stop a script. It
 * is worth having for exactly that reason and worth nobody mistaking it for
 * access control. Absent origin (a same-origin fetch may omit it, and curl
 * always does) is ALLOWED — refusing it would break our own app for no gain,
 * since the case it would block is the one that forges the header anyway.
 */
export function originAllowed(origin: string | null, selfOrigin: string, extraAllowed: readonly string[] = []): boolean {
  if (!origin) return true
  const allowed = [selfOrigin, ...extraAllowed].map((o) => o.replace(/\/$/, '').toLowerCase())
  return allowed.includes(origin.replace(/\/$/, '').toLowerCase())
}

/**
 * The check that actually stops another website spending our quota.
 *
 * ⚠⚠ THE ORIGIN CHECK DOES NOT DO IT, AND I DESCRIBED IT AS IF IT DID (A6
 * review, 2026-08-07). Browsers send NO `Origin` header on `<img src>`,
 * `<script src>`, `<iframe>`, `<link rel=preload>` or navigation — so an
 * attacker page with two hundred `<img src="https://our-site/api/zerox/...">`
 * tags reaches the proxy with no Origin, passes `originAllowed`, and spends
 * our 0x allowance on every visitor they get. No JavaScript, no CORS, no
 * forged headers, no attacker infrastructure beyond a web page. The residual I
 * wrote ("curl forges headers freely, so it is a speed bump") understated it:
 * the bypass needs no forgery at all.
 *
 * `Sec-Fetch-*` is the fix, because it is set by the BROWSER and cannot be
 * forged from one — and it is present on exactly the subresource loads that
 * omit `Origin`. A cross-site request, or one whose destination is an image or
 * a script rather than a bare fetch, is refused.
 *
 * What this still does NOT do: stop a script or curl, which send neither
 * header. That is quota protection, it needs stateful rate limiting, and it
 * belongs to the platform — stated, not implied.
 */
export function browserFetchAllowed(secFetchSite: string | null, secFetchDest: string | null): boolean {
  // absent = not a browser (a script, curl, or an older browser). The origin
  // check and the platform's rate limiting are what cover that case.
  if (!secFetchSite && !secFetchDest) return true
  if (secFetchSite && !['same-origin', 'same-site', 'none'].includes(secFetchSite.toLowerCase())) return false
  // a quote is fetched, never rendered: `image`, `script`, `style`, `iframe`
  // are all the subresource-abuse shape
  if (secFetchDest && !['empty', 'document'].includes(secFetchDest.toLowerCase())) return false
  return true
}
