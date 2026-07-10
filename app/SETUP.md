# SETUP.md — plug this frontend into your deployment (quick start)

The one-page checklist for an operator going from `git clone` to a hosted build.
This is the **fast path**; the full reasoning, options, and go-live QA live in
[`handover/03-IMPLEMENTATION.md`](handover/03-IMPLEMENTATION.md) (the runbook),
with the config model in [`handover/02-TECHNICAL.md`](handover/02-TECHNICAL.md)
and the plain-language hosting note in [`OPERATORS.md`](OPERATORS.md).

This package is **operational by default**: `src/lib/chain/deployments.json` ships the
**canonical Spectrum address book** (Base + Ethereum), so a zero-config build is a working
site on the canonical deployment. Every address is an **override point** for serving your
own deployment instead. The only values with **no default, ever**, are the two fee
recipients (`VITE_INTERFACE_TAG_ADDRESS` / `VITE_LAUNCHER_ADDRESS`) — unset, that fee
share simply isn't taken. **Verify any contract address you route value through**
(canonical included) against a canonical source before going live.

---

## Prerequisites

- [ ] **Node 20+** (22 LTS or newer recommended) and npm. The JS toolchain is all you need.
- [ ] Only if serving **your own** deployment: your factory + infra addresses.

## 1 · Install

```sh
git clone <your-fork>
cd <repo>/app
npm install
npm run dev      # http://localhost:5173 — live canonical Base data, zero config
```

The dev server shows **real baskets from the canonical factory** out of the box. (A
synthetic design-review dataset exists behind `VITE_DEV_FIXTURE=1`, dev-only — it never
ships in a build.)

## 2 · Configure

```sh
npm run init:env       # copies .env.example → .env.local (Vite reads .env.local, not .env.example)
```

> Prefer a visual path? With the dev server running, the **`/setup`** studio configures all
> of this in the browser and — in dev — its **Apply** button writes `brand.config.ts` +
> `.env.local` straight into the project (the server restarts itself with the new setup).

Edit `.env.local`. **On the canonical deployment there is no minimum** — leave every
address blank and the site runs on the shipped `deployments.json`. To serve **your own
deployment** instead, override:

- [ ] `VITE_FACTORY_ADDRESS` — your deployed factory.
- [ ] `VITE_USDC_ADDRESS` — the settlement asset your factory uses.
- [ ] `VITE_POOL_MANAGER_ADDRESS`, `VITE_WETH_ADDRESS`, `VITE_UNIV2_FACTORY_ADDRESS`,
      `VITE_UNIV3_FACTORY_ADDRESS` — the launch flow's pool detection.

> **Two ways to set addresses — pick one per chain.** The `VITE_*_ADDRESS`
> overrides apply to the **default chain (Base) only**. Any **other** chain
> (e.g. Ethereum via `VITE_EXTRA_CHAIN_IDS=1`) reads `src/lib/chain/deployments.json`
> and **ignores the env vars** — set a non-Base chain's addresses in the JSON, or it
> stays an empty shell with no in-app warning. `npm run check:config` flags this.

Your **site URL + fee wallet live in the committed `src/site.config.json`** (the
studio/wizard write it; both values are public by construction). The `VITE_SITE_URL` /
`VITE_INTERFACE_TAG_ADDRESS` / `VITE_LAUNCHER_ADDRESS` env vars override it. Optional,
per your business: `VITE_METADATA_BASE_URL` (+ write-relay / IPFS gateway) for creator
profiles, `VITE_ALCHEMY_API_KEY` (**required; the one value kept out of git** —
origin-restricted, since every `VITE_` value ships publicly). All documented inline in
`.env.example`.

## 3 · Validate

```sh
npm run check:config
```

This catches the footguns **before** you build: a transactional flag without the
wallet flag (the same invariant the app throws on at load), malformed/typo'd
addresses, `VITE_ENABLE_SWAP` with no router, an activated chain with no factory,
and a **missing site URL — that one is fatal** (set in `src/site.config.json` by the
studio/wizard, or via `VITE_SITE_URL`; a build needs it for the social cards +
sitemap). It also prints which **build tier** your flags express. Warnings don't
block; a fatal error does. It runs **automatically before every `npm run build`**
(via the `prebuild` hook).

## 4 · Choose your surface + build

**The default is the full site** — the studio/wizard write your tier into the committed
`src/site.config.json` (`features`), all four on by default. The `VITE_ENABLE_*` env vars
override it per flag (an explicit `false` scopes down); any transactional flag requires
the wallet flag. (The shipped `site.config.json` is all-off, so a clone with no config
artifact at all stays read-only — the deliberate safety net.)

| Tier | Flags | What it does |
|------|-------|--------------|
| **All features (default)** | all four `true` | Launch, buy/sell, fee console, portfolio — the full site on the canonical contracts. |
| Info-only | *(none)* | Browse / read. No wallet. |
| Creation tool | `WALLET` + `DEPLOY` | Creators launch baskets. |
| Fee console | `WALLET` + `TRADING` | Holders claim fees + permissionless cranks (`/flush`). No buy/sell. |
| Marketplace w/ buy/sell | `WALLET` + `SWAP` | Adds `/swap` + the Token buy/sell panel. **`SWAP` is the arm switch — live broadcast through the canonical router shipped in `deployments.json`** (override with `VITE_SWAP_ROUTER_ADDRESS` to use your own). See [`OPERATORS.md` → "Buy/sell: the router"](OPERATORS.md). |

```sh
# example — a creation-tool build
VITE_ENABLE_WALLET=true VITE_ENABLE_DEPLOY=true npm run build
npm run preview        # load it and confirm no module-load error in the console
```

## 5 · Deploy

- [ ] Your site URL (collected at setup, `src/site.config.json`) brands the OG/social
      tags and the `prebuild` hook **auto-generates** `public/sitemap.xml` from it — a
      build without one fails the config check.
- [ ] Host `dist/` anywhere static — `public/_redirects` (Cloudflare Pages / Netlify) and
      `vercel.json` ship the SPA fallback; on other hosts add a catch-all rewrite to
      `index.html`.
- [ ] No-CLI option: `npm run package` emits a drop-ready `<name>-site.zip` (dist/
      contents, `_redirects` inside) — drag it or the `dist/` folder onto Netlify Drop
      (https://app.netlify.com/drop) or Cloudflare Pages → Upload assets.
- [ ] **Your own server (VPS — nginx / Apache / Caddy):** the build is plain static
      files — no Node, no process manager. Upload the *contents* of `dist/` to your
      web root (`rsync -av --delete app/dist/ user@server:/var/www/your-site/` —
      `--delete` clears old hashed bundles on redeploys), then configure below.
      Two rules are load-bearing everywhere: the SPA catch-all, and an asset remap
      so a hard refresh of a nested route (`/creator/0x…`, `/docs/valuation`)
      doesn't resolve its script relative to the path and get index.html back as JS.

      **Easiest — Caddy (HTTPS is automatic, this is the whole config):**

      ```caddy
      # /etc/caddy/Caddyfile — replace the domain; certs are issued automatically
      your-site.xyz {
          root * /var/www/your-site
          encode gzip
          @nestedAssets path_regexp na ^/.+/(assets/.+)$
          rewrite @nestedAssets /{re.na.1}
          @assets path /assets/*
          header @assets Cache-Control "public, max-age=31536000, immutable"
          try_files {path} /index.html
          header /index.html Cache-Control "no-cache"
          file_server
      }
      ```

      **nginx — complete server block** (then `certbot --nginx` for HTTPS):

      ```nginx
      server {
          listen 80;
          server_name your-site.xyz;
          root /var/www/your-site;
          index index.html;
          gzip on;
          gzip_types application/javascript text/css application/json image/svg+xml;

          # nested-route asset remap (must come before the catch-all)
          location ~ ^/.+/(assets/.+)$ { try_files /$1 =404; }

          # hashed bundles never change — cache forever
          location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }

          # the SPA catch-all; index.html must NOT be cached or deploys go stale
          location / { try_files $uri $uri/ /index.html; }
          location = /index.html { add_header Cache-Control "no-cache"; }
      }
      ```

      ```apache
      # Apache — .htaccess in the web root (mod_rewrite + mod_headers)
      RewriteEngine On
      RewriteRule ^.+/(assets/.+)$ /$1 [L]
      RewriteCond %{REQUEST_FILENAME} !-f
      RewriteCond %{REQUEST_FILENAME} !-d
      RewriteRule . /index.html [L]
      <FilesMatch "\.(js|css|woff2?)$">
        Header set Cache-Control "public, max-age=31536000, immutable"
      </FilesMatch>
      <Files "index.html">
        Header set Cache-Control "no-cache"
      </Files>
      ```

      **The cache rule matters:** the JS/CSS bundles are content-hashed (safe to cache
      forever), but a cached `index.html` keeps pointing at OLD bundles — without
      `no-cache` on it, a redeploy can take days to appear for returning visitors.

      **HTTPS is required**, not a nicety — wallet connections and the clipboard API
      only work in a secure context (Caddy: automatic; nginx/Apache: `certbot`).

      Host at the domain **root** (or a subdomain). Serving from a subdirectory
      (`your-site.xyz/app/`) technically builds (relative assets) but the rules above,
      OG URLs and the sitemap all assume root — not worth it.

      **Self-check when done** (the same bar the runbook holds hosts to):

      ```sh
      curl -sS -o /dev/null -w '%{http_code}\n' https://your-site.xyz/          # 200
      curl -sS https://your-site.xyz/ | grep -io '<title>[^<]*</title>'          # YOUR name
      curl -sS -o /dev/null -w '%{http_code}\n' https://your-site.xyz/explore   # 200 (SPA rule)
      curl -sS -o /dev/null -w '%{content_type}\n' \
        "https://your-site.xyz/creator/assets/$(basename $(ls app/dist/assets/index-*.js))"
      # must say javascript, NOT text/html (the remap rule)
      ```
- [ ] **Link previews.** The generic card works once `VITE_SITE_URL` is set (above).
      For per-URL cards (basket / creator / refer), connect the repo to **Netlify** —
      the repo-root `netlify.toml` sets base/build/publish and the OG edge function
      deploys automatically, nothing extra to wire. Detail + non-Netlify options:
      `OPERATORS.md` → *Social link previews (OG cards)*.
- [ ] Confirm: Home/Explore enumerate your real baskets (or show the honest "no
      baskets yet" if the factory is empty), a Token page's NAV matches on-chain.

Going live with any transactional surface is **your own decision** — flipping a flag
does not change that you are responsible for the contracts you connect to and how
you operate them. See [`handover/03-IMPLEMENTATION.md`](handover/03-IMPLEMENTATION.md) §7.
