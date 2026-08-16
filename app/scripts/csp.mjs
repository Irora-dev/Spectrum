// ─────────────────────────────────────────────────────────────────────────────
// THE CONTENT SECURITY POLICY — the one control that lives OUTSIDE the bundle.
//
// WHY IT EXISTS, in this app's own words. `supply-chain.test.ts` opens with an
// honest admission: "this is a fully client-side bundle, so a compromised
// dependency executing in the page has TOTAL power — it can patch any module,
// hook fetch, and replace window.ethereum. No in-bundle test can defend against
// that." That is true, and the repo had NO Content-Security-Policy anywhere, so
// nothing outside the bundle was defending either.
//
// A CSP cannot stop a malicious dependency from running. What it CAN do is bound
// what that code reaches: an injected script cannot phone an attacker's server,
// cannot pull a second stage from an arbitrary origin, and cannot post the
// user's addresses or a signed payload somewhere we never talk to. For a
// SELF-HOST kit — where every operator serves this app themselves and a
// compromised host is the realistic catastrophe — that bound is the highest
// leverage per line in the repo.
//
// ⚠ THE ALLOWLIST IS DERIVED, NOT GUESSED. Every origin below was extracted
// from the source (the app's own fetch and RPC call sites) rather than written
// from memory, because a CSP that breaks the app gets switched off, and a CSP
// that is switched off protects nothing. When a new vendor is added, this list
// is where it must be declared — which is itself the point: a NEW EXTERNAL
// ORIGIN BECOMES A VISIBLE DECISION rather than a quiet import.
//
// ⚠ WHAT THIS DOES NOT DO, stated rather than implied (gate A7):
//   · `'unsafe-inline'` remains for STYLES. Vite injects styles inline and the
//     app sets inline `style=` on measured layout; removing it needs a nonce
//     pipeline and would be a lie to claim now.
//   · Scripts do NOT carry `'unsafe-inline'` or `'unsafe-eval'` — that is the
//     half that matters for injected code.
//   · A browser extension wallet injects into the page by design and is not
//     constrained by this policy. That is the intended trust relationship.
//   · This is a header, so it protects the SERVED app. It says nothing about
//     what an operator built. Build provenance is a separate control.
//   · ✅ THE ONE OPEN VIOLATION IS CLOSED AT ITS SOURCE (2026-08-07). The
//     inline script was the Coinbase Wallet SDK injecting its Amplitude
//     telemetry bootstrap at runtime (`ClientAnalytics` / `base_account_sdk`,
//     gated inside the SDK on `preference.telemetry !== false`). The fix is
//     NOT a hash — a hash would have BLESSED third-party analytics we never
//     wanted: `src/wagmi.ts` passes `telemetry: false`, so nothing is injected
//     and no device-id beacon is attempted. Verified by loading the BUILT app
//     under this exact header with wallets enabled: 1 inline-script violation
//     before, 0 after. `script-src` stays free of 'unsafe-inline'.
// ─────────────────────────────────────────────────────────────────────────────

/** Origins the app legitimately talks to, grouped by why. Adding one here is a
 *  security decision and should be reviewed as one. */
export const CONNECT_ORIGINS = [
  // chain RPC — the reads and the transactions themselves
  'https://*.g.alchemy.com',
  'https://base-rpc.publicnode.com',
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.mainnet.chain.robinhood.com',
  // explorers, used as a keyless fallback when an RPC will not answer
  'https://robinhoodchain.blockscout.com',
  'https://api.basescan.org',
  'https://api.etherscan.io',
  // market data: prices, depth, the shared-hop reserve
  'https://api.dexscreener.com',
  'https://coins.llama.fi',
  // routing + quotes
  'https://li.quest',
  'https://api.cow.fi',
  // ⚠ api.0x.org IS DELIBERATELY ABSENT (2026-08-07). The browser no longer
  // talks to the aggregator: quotes go to OUR OWN origin ('self', already
  // allowed) and netlify/edge-functions/zerox.ts adds the credential
  // server-side, because a static bundle cannot hold a secret. Removing the
  // origin makes that structural rather than conventional — if client code
  // ever calls 0x directly again it will need a key AND it will be refused by
  // this policy, so the leak fails closed twice. `scripts/no-client-secrets.mjs`
  // is the other half.
  // token lists
  'https://tokens.uniswap.org',
  'https://tokens.coingecko.com',
  // token-art's keyless Coingecko rung (`token-art.ts`) — MISSED by the first
  // allowlist because `assets.coingecko.com` was already allowed for IMAGES
  // and the API host reads as the same vendor at a glance. Found by loading
  // the built app under the real header (2026-08-07): every logo/rank lookup
  // was being refused by our own policy, silently degrading art to fallbacks.
  // Same lesson as the dd.→cdn. redirect below: a policy is only as good as
  // the surface you tested it on.
  'https://api.coingecko.com',
  // WalletConnect's relay, for phone wallets
  'wss://*.walletconnect.org',
  'https://*.walletconnect.org',
  'wss://*.walletconnect.com',
  'https://*.walletconnect.com',
  // the font CSS itself is fetched, not just linked
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
]

/** Where token and stock artwork may come from. Images cannot execute, so this
 *  is looser by nature — but still an allowlist, because an <img> to an
 *  arbitrary host is a beacon that leaks who is looking at what. */
export const IMG_ORIGINS = [
  "'self'",
  'data:',
  'blob:',
  'https://tokens.uniswap.org',
  'https://tokens.coingecko.com',
  // ⚠ THE LIVE COINGECKO IMAGE CDN IS `coin-images.` — `assets.` is the
  // pre-migration host and appears NOWHERE in src/ (2026-08-07). So this list
  // carried a guessed host and missed the real one, in a file whose header
  // says the allowlist is derived rather than guessed. It survived because the
  // API host itself was blocked one layer up: no lookup ever returned an image
  // URL, so the wrong image host could never be exercised. ONE
  // MISCONFIGURATION HID ANOTHER — unblocking the first is what exposed it.
  // `assets.` stays only for image URLs already cached in a user's browser
  // from before the migration; new lookups all answer `coin-images.`.
  'https://coin-images.coingecko.com',
  'https://assets.coingecko.com',
  'https://raw.githubusercontent.com',
  'https://ipfs.io',
  'https://t3.gstatic.com',
  'https://dd.dexscreener.com',
  // ⚠ dd.dexscreener.com REDIRECTS to cdn.dexscreener.com, and a CSP is applied
  // to the FINAL url after the redirect — so allowing only the origin the code
  // requests silently blocks every token logo. Found by loading the BUILT app
  // under the real header, not by reading the fetch call sites.
  'https://cdn.dexscreener.com',
]

export function cspValue() {
  return [
    "default-src 'self'",
    // THE HALF THAT MATTERS: no inline scripts, no eval. An injected <script>
    // or a string-to-code call is refused by the browser regardless of how it
    // got into the page.
    "script-src 'self'",
    "worker-src 'self' blob:",
    // styles keep unsafe-inline for now, stated in the header above
    // Google Fonts, which index.html loads directly — FOUND BY VERIFYING the
    // policy against the running app rather than by reading src/ alone. My
    // first allowlist was derived from the TypeScript only, so it would have
    // shipped a CSP that stripped every font from the deployed app. A policy is
    // only as good as the surface you tested it on.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src ${IMG_ORIGINS.join(' ')}`,
    `connect-src 'self' ${CONNECT_ORIGINS.join(' ')}`,
    // nothing may frame this app, and it frames nothing — a wallet drainer's
    // favourite two primitives. ⚠ ONE ROUTE IS THE DELIBERATE EXCEPTION:
    // /embed EXISTS to be framed (a chrome-less basket card creators paste on
    // their own sites; the launch banner mints the iframe snippet). The
    // four-reviewer audit caught this ban blanking every shipped embed the day
    // these headers land. Netlify's _headers cannot LOOSEN per-path (duplicate
    // CSP headers intersect, so the strict one still wins) — the exception
    // lives in netlify/edge-functions/embed-headers.ts, which rewrites these
    // two headers for /embed only, and in vercel.json's /embed rule. Both are
    // built from EMBED_HEADER_OVERRIDES below so the three surfaces cannot
    // drift. The residual is stated there: an embeddable route is the one
    // legitimate clickjacking foothold; the card carries no wallet action.
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    // a form post to an attacker's origin is an exfiltration channel with no
    // legitimate use here
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ')
}

/**
 * THE /embed EXCEPTION — what its headers override, single-sourced.
 *
 * frame-ancestors * because ANY creator's site may embed (that is the
 * product); X-Frame-Options is REMOVED, not set, because it has no value that
 * means "anyone" (ALLOWALL never standardized). Everything else — script-src
 * 'self', connect-src, object-src 'none' — stays the strict policy: it
 * protects the embedded card itself inside a hostile parent.
 *
 * THE RESIDUAL, stated rather than implied: an embeddable route is the one
 * legitimate clickjacking foothold in the app. Accepted because the card is
 * read-only — no wallet, no signing, its only click navigates TOP-LEVEL to
 * this origin where the strict policy resumes. If the card ever grows a money
 * action, this exception is the first thing to revisit.
 */
export const EMBED_HEADER_OVERRIDES = {
  'Content-Security-Policy': cspValue().replace("frame-ancestors 'none'", 'frame-ancestors *'),
  'X-Frame-Options': null, // null = REMOVE on this route
}

/** The other headers that cost nothing and close known classes. */
export const SECURITY_HEADERS = {
  'Content-Security-Policy': cspValue(),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // an address in a URL should not leak to a third party through the referer,
  // and no page here needs a camera, a microphone or a location
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Frame-Options': 'DENY',
}
