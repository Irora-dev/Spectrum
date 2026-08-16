# Deploy on Netlify

Free to start (commercial use allowed on the free tier; bandwidth is metered at 100 GB/mo),
and the one host where the **per-URL social cards ship automatically** — the kit's Netlify
Edge Function rewrites each shared link's title/description, no separate deploy. ~10 minutes.

> New here? Skim [README.md](README.md) first for the values you'll need (fee wallet, factory
> address, chain). Then come back.

---

## 1. Get your own copy of the site

You need the project in **your** GitHub account first.

- Easiest: follow **[Use this template](github-template.md)** — one click makes your copy.

When you're done you'll have a repo like `your-name/my-spectrum-site` on GitHub.

## 2. Create the Netlify site

1. Sign in at **[app.netlify.com](https://app.netlify.com)** (free account is fine).
2. **Add new project** → **Import an existing project** → **GitHub**.
3. Authorize Netlify to see your GitHub, then pick your repo (`my-spectrum-site`).

## 3. Build settings — the repo configures itself

The repo ships a root **`netlify.toml`** that sets everything (base `app`, build
`npm run build`, publish `dist`), so Netlify's settings screen should already show those
values — don't override them in the UI. Base `app` is also what makes Netlify auto-detect
the **OG edge function** (`app/netlify/edge-functions/og.ts` — per-URL titles/descriptions
for shared basket, creator and refer links).

The Node version is pinned in the same file (`NODE_VERSION = "22"`), so there is nothing to
add for it.

## 4. Set the environment variable

Before the first deploy, open **Site configuration → Environment variables** and add the one
value that doesn't travel in the repo (your tier, site URL and fee wallet are committed
in `app/src/site.config.json` by the setup studio/wizard):

```
VITE_ALCHEMY_API_KEY = xxxx   # required — your RPC key, restricted to your domain (it ships publicly)
```

Then **Deploy**. The first build takes a minute or two; you'll get a `*.netlify.app` URL.

> Added or changed a variable later? Edit it, then **Deploys → Trigger deploy** (or push any
> change) to rebuild — values are baked at build time.

## 5. Add your custom domain

1. Open your site → **Domain management** → **Add a domain**.
2. Type your domain (e.g. `mybaskets.xyz`) → follow the prompt: Netlify shows the DNS
   record(s) to add at your registrar (or use Netlify DNS).
3. HTTPS is issued automatically once DNS resolves, usually within minutes.
4. CLI alternative: `npx netlify domains:add <domain>` from the repo.

Then set the domain as your **site URL** (setup studio, or `src/site.config.json`) and
redeploy so the social cards + sitemap carry it — and lock your RPC key to the domain (see
[README → RPC keys](README.md#rpc-keys-public-vs-your-own)).

## The per-URL social cards (why Netlify is recommended for this)

Nothing to configure: with base `app`, the edge function deploys with the site and rewrites
`<title>` + og/twitter tags per shared URL for `/token`, `/creator/<addr>` and `/refer`.
One upkeep note: it reads basket names from your live `/tokenlist.json` — regenerate it with
`npm run build:tokenlist` (from `app/`) when new baskets launch, or those links fall back to
the site's generic card. Details: `app/netlify/edge-functions/README.md`.

## Troubleshooting (Netlify-specific)

- **Deep links 404 (e.g. refreshing `/explore` fails).** Netlify reads SPA fallback rules
  from `_redirects` in the publish directory — the kit **ships it** at
  `app/public/_redirects` (the SPA catch-all plus the nested-route asset remaps; don't
  replace it with a bare catch-all or refreshing `/creator/…`, `/docs/…` and `/bundle/…`
  pages goes blank). If deep links 404, check the file reached your repo and the deployed
  `dist/`, then redeploy. (See
  [Deep links work out of the box](README.md#deep-links-work-out-of-the-box).)
- **Build settings look wrong / build runs in the repo root.** The root `netlify.toml` must
  be in your copy of the repo, and UI overrides beat it — clear any manually-set base/publish
  values so the file governs.
- **Build can't find `npm`/wrong Node.** Add env var `NODE_VERSION` = `20` and retry.
- **Social cards show the generic card for a new basket.** Regenerate `/tokenlist.json`
  (`npm run build:tokenlist`) and redeploy.

---

← Back to [README.md](README.md) · Other hosts: [Cloudflare Pages](cloudflare-pages.md) · [Vercel](vercel.md)
