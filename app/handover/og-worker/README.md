# Spectrum OG worker

Per-basket link previews for the static site. Social crawlers (X, Discord,
Telegram) don't execute JavaScript, so an SPA can only ever show them the one
generic card baked into `index.html`. This worker sits in front of the site and
fixes that:

- **`/token?addr=…&chain=…`** — serves the site's own HTML with the og/twitter
  tags rewritten for that basket (title, description, image, url).
- **`/og/<chainId>/<address>.png`** — a 1200×630 card rendered on the edge
  (ticker + name + brand identity). Deliberately **no numbers**: crawlers cache
  images for days, and a stale NAV/performance figure in a social card is a
  misleading claim. Unknown baskets 302 to the site's generic `/og.png`.
- **Everything else** — passed through to the origin untouched.

Basket names come from the site's own `/tokenlist.json` (regenerate with
`npm run build:tokenlist` in `app` when new baskets launch).

## Deploy (Cloudflare Workers)

```sh
cd frontend/handover/og-worker
npm install
# set your deployed site URL:
#   wrangler.toml → [vars] SITE_ORIGIN = "https://your-site"
npx wrangler deploy
```

Then route your public hostname through the worker (Cloudflare dashboard →
Workers Routes, e.g. `yoursite.com/*`), or serve the site itself behind it.
DNS-only hosts can instead route just `/token*` and `/og/*` if the host
supports path rules.

## Local check (no deploy needed)

```sh
npm install
npm run test:render   # writes sample-og.png via the exact worker pipeline
```

Fonts: Chakra Petch (OFL) is bundled in `fonts/`. The worker itself has no
other config — `SITE_ORIGIN` is the only variable.
