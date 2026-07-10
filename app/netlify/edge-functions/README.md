# OG edge function — social link previews

`og.ts` is a **Netlify Edge Function** that fixes per-URL link previews for a
client-rendered SPA. Social crawlers (X, Telegram, Discord, Slack, iMessage)
don't run JavaScript, so they only ever see the one generic card baked into
`index.html`. This runs at the edge, in front of the static site, and rewrites
the `og:`/`twitter:` tags per shared URL:

- **`/token?addr=&chain=`** — the basket's ticker + name (from `/tokenlist.json`).
- **`/creator/<address>`** — the creator's identity.
- **`/refer`** — the refer-&-earn hook.
- everything else is served untouched.

The meta-building + rewrite logic lives in `src/lib/og/meta.ts` (pure, unit-tested
in `meta.test.ts`); this file is just the thin edge handler.

## Deploy

**Nothing extra.** Connect the repo to Netlify — the repo-root `netlify.toml`
sets base `app`, build, and publish, and Netlify auto-detects this edge function
and its self-declared `path` filter (`export const config` in `og.ts`).
Unlike the standalone Cloudflare worker in `handover/og-worker/`, there
is no separate deploy and no route to configure — it ships with the site.
Verify the per-URL cards on your first deploy (share a `/token` link into a
crawler debugger) before relying on them.

`/tokenlist.json` must be live at the site root (regenerate with
`npm run build:tokenlist` when new baskets launch) or basket links fall back to
the generic card.

## Follow-up: per-basket card IMAGES

Right now `og:image` is the branded **generic** card (`/og.png`) for every URL —
the per-URL **title + description** is what's personalized. Real per-basket card
images (ticker + faux-bento, like the Cloudflare worker renders) are the next
step. The proven satori→resvg render already exists in
`handover/og-worker/src/card.mjs` (verified via its `test-render.mjs`).
Two Netlify-native options, both needing a preview deploy to validate:

1. **Static, at build** — render a PNG per basket/creator into `public/og/…`
   during the build (reusing the og-worker's render), then point `og:image` at
   the static file. No runtime rendering; served by the CDN. Regenerated with the
   tokenlist. (Recommended — lowest runtime risk, reuses proven code.)
2. **On-demand Netlify Function** — a Node function running satori→resvg per
   request. Standard Lambda where those libs work, but needs the wasm/font
   bundling validated on a preview.

Until then the generic image is a safe, branded default.
