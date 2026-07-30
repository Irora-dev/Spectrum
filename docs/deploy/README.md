# Deploy your Spectrum Mini site

This is the **non-developer** guide to putting your site online. No terminal, no code — a
hosting account, a few values pasted into a dashboard, and (optionally) your own domain.

You'll be done in about 15 minutes.

> The generated app is a static front end (Vite + React). It talks straight to the live
> Spectrum basket contracts from the browser — there is no server for you to run or pay for.
> Both hosts below have a free tier that's plenty for this.
>
> **You own everything.** The repo lives in your GitHub, the site runs on your hosting account,
> the domain is yours, and fees go to your wallet. Spectrum Mini hosts nothing on your behalf —
> there is no Spectrum Mini server in the loop, by design.

---

## What you need before you start

1. A **GitHub account** (free) — your copy of the site lives here.
2. A **hosting account** — [Cloudflare Pages](cloudflare-pages.md) *or* [Vercel](vercel.md)
   (both free). Pick one; you can always move later.
3. Your own **RPC key**, restricted to your domain — see [RPC keys](#rpc-keys-public-vs-your-own) below.
4. *(Optional)* your **fee wallet address** — the wallet where your share of fees lands.

No contract addresses needed: the kit ships pointing at the canonical Spectrum deployment
(Base, Ethereum + Robinhood Chain, all live); the setup studio/wizard already wrote your choices into the repo.

You do **not** set a fee percentage anywhere — fees are fixed by the contracts. You configure
only your fee *wallet*.

---

## Pick your path

There are three ways in. They all produce the **same** site — choose by how hands-on you want to be.

| Path | Best for | Start here |
|---|---|---|
| **Deploy button** | "Just make it live" — one click clones + connects + builds | [deploy-button.md](deploy-button.md) |
| **Use this template** | You want your own GitHub repo first, then connect a host | [github-template.md](github-template.md) |
| **Host dashboard** | You already have the repo and just want the host's steps | [Cloudflare Pages](cloudflare-pages.md) · [Netlify](netlify.md) · [Vercel](vercel.md) |

Most non-developers should start with the **deploy button**. If it stalls on env vars or build
settings, fall back to **Use this template → connect host** (the steps are spelled out for each host).

> **Which host?** All three work and all are free to start — we suggest **Cloudflare Pages** as
> the default. Its free tier permits **commercial use** and isn't bandwidth-metered.
> **[Netlify](netlify.md)**'s free tier also allows commercial use (bandwidth metered at
> 100 GB/mo) and is the one host where the kit's **per-URL social cards deploy automatically**
> (the shipped edge function). **Vercel's** free "Hobby" tier is **non-commercial** per their
> terms, and a site that routes fees to your wallet is arguably commercial, so on Vercel you
> may need a paid plan. (Vercel's deploy button is a touch smoother — it prompts for every
> value inline; Cloudflare's takes one extra dashboard step.) You can move hosts later either
> way.

---

## The environment variables

Your tier, site URL and fee wallet travel **committed in the repo**
(`app/src/site.config.json` — the setup studio/wizard write it), so a git-connected
build needs exactly **one** dashboard variable:

| Variable | Required? | What to put | Example |
|---|---|---|---|
| `VITE_ALCHEMY_API_KEY` | **Required** | Your RPC key, **restricted to your domain** (every `VITE_` value ships in the public bundle — never a secret key) | `xxxxxxxx` |

Every other `VITE_*` var in `app/.env.example` is an optional **override** of the
committed config or the canonical contract addresses.

**Your tier travels committed too.** Setup wrote your feature set (the default is the full
site) into `app/src/site.config.json` — nothing to arm in the dashboard. To scope a live
deployment down later, either re-run setup or override per flag with `VITE_ENABLE_*=false`
dashboard vars and redeploy.

Notes that save you a support ticket:

- **These are build-time values, not server secrets.** Vite bakes anything starting with
  `VITE_` into the files it ships to the browser, so treat them as *public*. Never paste a
  private key, a seed phrase, or anything you wouldn't put on a billboard. (Your fee wallet
  *address* is fine and public by design.)
- **Change a variable → you must redeploy.** Because they're baked at build time, editing a
  value in the dashboard only takes effect on the next deploy. Each guide shows the "Redeploy"
  button.
- **Buy/sell is on in the default tier** and broadcasts through the canonical Spectrum
  router that ships with the kit (`VITE_SWAP_ROUTER_ADDRESS` overrides it). Scope it off
  with the `info`/`creation`/`fees` tiers in setup, or `VITE_ENABLE_SWAP=false` — a fine
  choice if your jurisdiction means browse-only. The `trade` page toggle in
  `brand.config.ts` only hides the page; the tier is what arms the risk surface.
- **You never paste a fee percentage.** It isn't a setting — the contracts fix it.

You don't need your own factory / router to launch — the kit ships pointing at the canonical
Spectrum deployment for Base, Ethereum and Robinhood Chain. Set these only to run the site on your OWN deployment,
and verify any address you set against a canonical source before routing value through it.

### Optional extras

Not required for a working site, but available:

| Variable | What it does |
|---|---|
| Preview mode | To see your theme on synthetic sample data, run the **dev server** with `VITE_DEV_FIXTURE=1` (`npm run dev`). It is DEV-only and **cannot be built into a shipped site** — a production build always uses live chain data. |
| Public swap infra | `VITE_USDC_ADDRESS`, `VITE_POOL_MANAGER_ADDRESS`, `VITE_WETH_ADDRESS`, `VITE_UNIV2_FACTORY_ADDRESS`, `VITE_UNIV3_FACTORY_ADDRESS`, `VITE_AERODROME_FACTORY_ADDRESS`, `VITE_UNIVERSAL_ROUTER_ADDRESS`, `VITE_V4_QUOTER_ADDRESS` (and more — see `app/.env.example`). The canonical addresses ship in `deployments.json` — set these only to point buy/sell routing and the Launch asset picker at your **own** deployment. |

The authoritative list of every variable the app reads is **`app/.env.example`** in the repo —
if anything here ever drifts from that file, the file wins.

---

## RPC keys: public vs. your own

The site reads the chain through an **RPC endpoint**. You have two options:

**1. Public node (default — do nothing).** Leave `VITE_ALCHEMY_API_KEY` blank and the app falls
back to a free public endpoint. Costs nothing, needs no account. Good enough to launch and for
low traffic; public nodes can rate-limit or slow down under load.

**2. Your own key (recommended for reliability).** Free, ~3 minutes:

- Make a free account at **[Alchemy](https://alchemy.com)**.
- Create an app/key with **Base Mainnet, Ethereum Mainnet and Robinhood Chain** enabled —
  all three are live by default, and the one key serves them all.
- Copy the **API key** and set it as `VITE_ALCHEMY_API_KEY`. (Prefer full URLs from another
  provider? `VITE_BASE_RPC_URL` / `VITE_MAINNET_RPC_URL` / `VITE_ROBINHOOD_RPC_URL` each
  override per chain.)

> ⚠️ **Lock your key to your domain.** Because the URL ships in the browser bundle, anyone can
> read it. That's normal for a static site — but turn on the provider's origin/referrer
> allowlist so only *your* domain can use it:
> - **Alchemy:** your app → *Security / Allowlists* → add your domain(s).
> - **Infura:** your API key → *Settings → Allowlist / Referrers* → add your domain(s).
>
> Add the custom domain first (below), then lock the key to it.

---

## What this costs, and surviving real traffic

**The only thing you have to buy is the domain.** The site is fully static, so the free hosting
tiers carry it: Cloudflare Pages' free plan has no bandwidth metering on static assets, allows
commercial use, and includes the custom domain + HTTPS (Netlify's free tier meters at 100 GB/mo;
Vercel's free tier is non-commercial — see "Which host?"). No hosting upgrade, no premium plan,
no server. The optional per-URL social cards also fit free tiers (the Netlify edge function, or
the standalone Cloudflare Worker inside the free 100k requests/day).

**Traffic doesn't hit your host — it hits your RPC.** The CDN absorbs any number of visitors;
what scales with traffic is each browser reading the chain. Three levers, in order:

1. **Set your own origin-restricted RPC key** (above). Free tiers are fine to launch; the key is
   also the first thing to upgrade if reads ever throttle.
2. **Publish a snapshot — the big one.** `npm run build:snapshot` (on a schedule: cron, CI, or
   your laptop) writes a JSON that list/discovery surfaces render from, so global data is read
   once per interval instead of once per visitor — RPC cost goes **flat** no matter the traffic.
   Anything trade-critical (floors, simulations, allowances, balances) always stays on live RPC
   by design. Full guide: `app/handover/RPC-EFFICIENCY.md`.
3. **Robinhood Chain rides the same key** — Alchemy serves it too, so the one
   `VITE_ALCHEMY_API_KEY` covers all three chains (its keyless public node is rate-limited;
   `VITE_ROBINHOOD_RPC_URL` still overrides per chain if you prefer another provider).

---

## Deep links work out of the box

A Spectrum Mini site is a single-page app: the server has one real page (`index.html`) and the
app draws `/explore`, `/portfolio`, the token page, etc. on top. So the host must serve
`index.html` for any path, or refreshing / sharing a deep link would 404.

**The kit ships both fallback files**, so this just works on either host:

- **Cloudflare Pages** — `app/public/_redirects` (`/*  /index.html  200`), copied into the build output.
- **Vercel** — `app/vercel.json` (a catch-all rewrite to `/index.html`).

Each host ignores the other's file, so one repo deploys cleanly to either. You only need to touch
these if you host somewhere else, or if you removed them.

---

## Add your custom domain

Both hosts make this a dashboard step — no DNS expertise needed. The short version:

- **Cloudflare Pages:** project → **Custom domains** → *Set up a domain* → type your domain. If
  the domain's DNS is already on Cloudflare it's automatic; otherwise it shows you the one
  record to add. Full steps: [cloudflare-pages.md → Custom domain](cloudflare-pages.md#5-add-your-custom-domain).
- **Vercel:** project → **Settings → Domains** → add your domain → copy the A/CNAME record it
  shows into your registrar. Full steps: [vercel.md → Custom domain](vercel.md#5-add-your-custom-domain).

HTTPS is provisioned automatically on both, usually within minutes.

---

## After it's live — the 30-second check

1. Open your URL. You should see your site, your name up top, **"powered by Spectrum Mini"** beneath.
2. Open **Discover** — it lists baskets read live from the factory. (Every Spectrum Mini site
   shows every basket; that's by design, not a setting.)
3. If you set the swap router, **Trade** should be in the nav; if you left it blank, it won't be.
4. **On your custom domain?** Confirm the loop is closed: the site URL is set to the domain
   (share any page into a chat — the link preview should show *your* domain, not
   `*.pages.dev`/`*.netlify.app`) and your RPC key's allowlist includes it.
5. Empty or erroring? Jump to **Troubleshooting**.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails immediately | Wrong build settings | Framework **Vite**, build `npm run build`, output `dist`. See your host guide. |
| Site loads but Discover is empty / spinning | Bad or missing `VITE_FACTORY_ADDRESS` | Recheck it (and `VITE_EXTRA_CHAIN_IDS` if you meant to add a 2nd chain), then **Redeploy**. |
| Changed a value but nothing changed | Env vars are baked at build time | Hit **Redeploy** after editing. |
| Deep links / refresh show **404** | The shipped SPA routing file didn't reach the deploy | Check `public/_redirects` (Cloudflare) or `vercel.json` (Vercel) made it into your repo/build — see [Deep links work out of the box](#deep-links-work-out-of-the-box). |
| No buy/sell on the token page | Missing one of `VITE_ENABLE_WALLET` / `VITE_ENABLE_SWAP` / `VITE_SWAP_ROUTER_ADDRESS`, or the `trade` toggle is off | Set all three (+ the `trade` toggle in `brand.config.ts`), then redeploy — or leave off on purpose. |
| Slow / intermittent data | Public RPC rate-limiting | Add your own Alchemy/Infura key (above). |
| RPC key stopped working after going live | Allowlist set before the domain existed | Add the domain, then add it to the key's allowlist. |

---

*Generated sites always carry the **"powered by Spectrum Mini"** line ("Spectrum" is the
shipped default site name; rename it freely). Fees are fixed by the contracts; you set only
your fee wallet.*
