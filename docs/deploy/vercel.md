# Deploy on Vercel

Free, and the env-var prompts are the friendliest — Vercel asks you for each value during
setup. ~10 minutes.

> New here? Skim [README.md](README.md) first for the values you'll need (fee wallet, factory
> address, chain). Then come back.

> **Heads-up on plans:** Vercel's free **Hobby** tier is for **non-commercial** use per their
> terms. A site that routes fees to your wallet is arguably commercial, so you may need a paid
> Vercel plan — or use **[Cloudflare Pages](cloudflare-pages.md)**, whose free tier allows
> commercial use. It's the same site either way.

---

## 1. Get your own copy of the site

You need the project in **your** GitHub account first.

- Easiest: follow **[Use this template](github-template.md)** — one click makes your copy.
- Or use the **[Deploy button](deploy-button.md)** — on Vercel the button clones the repo *and*
  prompts you for every env var in one flow (then skip to step 4 to confirm them).

When you're done you'll have a repo like `your-name/my-spectrum-site` on GitHub.

## 2. Import the project

1. Sign in at **[vercel.com](https://vercel.com)** with GitHub (free "Hobby" plan is fine).
2. **Add New… → Project**.
3. Find your repo (`my-spectrum-site`) → **Import**.

## 3. Build settings

Vercel detects Vite automatically — confirm under **Build & Output Settings**:

| Field | Value |
|---|---|
| **Framework Preset** | `Vite` |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |
| **Install Command** | `npm install` |
| **Root Directory** | leave as `./` (set it only if the app is in a subfolder) |

## 4. Set the environment variable

Still on the import screen, open **Environment Variables** and add the one value that
doesn't travel in the repo (your tier, site URL and fee wallet are committed in
`app/src/site.config.json` by the setup studio/wizard):

```
VITE_ALCHEMY_API_KEY = xxxx   # required — your RPC key, restricted to your domain (it ships publicly)
```

Then **Deploy**. The build takes a minute or two; you'll get a `*.vercel.app` URL.

> Changed a variable later? **Settings → Environment Variables** → edit → then **Deployments →
> ⋯ → Redeploy** (env vars are baked at build time, so a redeploy is required).

## 5. Add your custom domain

1. Open your project → **Settings → Domains**.
2. Type your domain (e.g. `mybaskets.xyz`) → **Add**.
3. Vercel shows the DNS record to create — usually:
   - an **A record** for the apex (`mybaskets.xyz` → the IP Vercel gives), or
   - a **CNAME** for a subdomain (`www` → `cname.vercel-dns.com`).
   Add it at your registrar's DNS page exactly as shown.
4. Vercel verifies and provisions HTTPS automatically, usually within minutes.
5. **Make the site know its own domain** — the step people skip: set the **site URL** to the
   custom domain (setup studio, or `src/site.config.json` → `siteUrl`), commit, and let it
   redeploy. Until you do, social cards and the sitemap keep advertising the `*.vercel.app`
   subdomain instead of your domain.

Now go lock your RPC key to this domain if you added one (see
[README → RPC keys](README.md#rpc-keys-public-vs-your-own)).

## Troubleshooting (Vercel-specific)

- **Deep links 404 (e.g. refreshing `/explore` fails).** A Vite SPA needs a rewrite —
  the kit **ships one** at `app/vercel.json` (the SPA catch-all plus the nested-route
  asset remaps; don't replace it with a bare catch-all or refreshing `/creator/…`,
  `/docs/…` and `/bundle/…` pages goes blank). If deep links 404, check the file is at
  your deploy root (project root if you deploy from the repo root), then redeploy. (See
  [Deep links work out of the box](README.md#deep-links-work-out-of-the-box).)
- **Blank page after deploy.** Output directory must be `dist`. Re-check Build & Output Settings.
- **Env var changes not showing.** They're build-time — **Redeploy** after editing.

---

← Back to [README.md](README.md) · Other hosts: [Cloudflare Pages](cloudflare-pages.md) · [Netlify](netlify.md)
