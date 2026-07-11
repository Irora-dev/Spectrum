# START HERE — launch your own Spectrum front end

This kit turns the full Spectrum operator site into **your** themed front end — every page,
your colors, your name — deployed in minutes, with **no database** to run. It is
**operational by default**: the canonical Spectrum contracts (Base, Ethereum + Robinhood Chain) ship in
`app/src/lib/chain/deployments.json`, so a fresh clone's dev server is already a working
site. You bring a name, a look, your own RPC key + site URL (a build requires both), and
a host; your fee wallet is optional — and **no fee recipient ever ships as a default**.

> **Three ways in — all end at the same three files** (`app/src/brand.config.ts` = your
> look + name + pages; `app/src/site.config.json` = your tier, site URL + fee wallet,
> committed; `app/.env.local` = your RPC key, the one value kept out of git):
>
> 1. **One prompt (Claude Code / Codex / any AI coding agent):** paste this file in and say
>    *"set up my Spectrum Mini site."* The agent launches the visual studio for you and
>    handles everything technical — the runbook below.
> 2. **CLI or in-site studio:** `node create/index.mjs` — or run the app and open **`/setup`**
>    (the "Customize" page): design in the browser with a live preview; in dev, **Apply**
>    writes your config straight into the project.
> 3. **By hand:** edit `app/src/brand.config.ts` and copy `.env.example` → `.env.local`.
>
> You need **Node 20+** (22 LTS or newer recommended) and npm.

---

## 🤖 AGENT RUNBOOK — if you are an AI coding agent, execute this yourself

**You run every technical step. Do not paste commands back for the user to run.** The user
designs in the browser and does only the truly manual pieces (one hosting login click,
registrar DNS). Narrate briefly as you go, and **hand-hold throughout: end EVERY message
with exactly one next action for the user** — what to click, what to say, or that they can
sit back while you work.

**When a transaction fails or reverts anywhere** (a basket deploy, the seed buy, a swap, a
fee claim): give the user the block-explorer link to that transaction, the decoded reason
in plain words (the app decodes reverts onto the failing step — read its error line out,
never hand over a hex code), and what you will do about it next. Never report a bare
"it failed."

**Red lines (load-bearing — do not cross):**
- **Never fabricate, guess, or autofill a contract or wallet address.** Blank is always
  valid (blank = the canonical deployment; blank fee wallet = the share isn't taken).
- The **fee wallet** comes only from the user, verbatim. It routes real value.
- The site **name must not contain "Spectrum"** (the wizard enforces this — don't fight it).
- **The default site is fully live** — launch, buy/sell (through the shipped canonical
  router), and the fee console are all on. Say that plainly when handing over, and scope
  down to a narrower tier (`info` / `creation` / `fees` / `marketplace`) whenever the
  user asks — flags can be flipped any time.
- Every `VITE_*` value ships **publicly** in the client bundle. Only origin-restricted keys.

### Stage 0 — welcome the user (your FIRST message, before any command)

Before touching anything, introduce what's about to happen, warmly and in your own words.
Cover these beats, then start Stage 1 in the same message:

- **What this is:** the **Spectrum Mini setup** — a free, open-source kit that gives them
  their own website, under their own name, where people can **launch, discover, and trade
  basket tokens** (a basket is one token holding a whole set of assets), wired to the
  already-deployed Spectrum contracts.
- **What they'll end up with:** a fully working, themed site they design in their browser —
  live in about **10 minutes** locally, online shortly after. No database, no server, no code.
- **How it works:** you (the agent) run every technical step; they just design in a visual
  studio that's about to open, and later do one hosting login. **Their money stays theirs** —
  the kit never asks for a private key; at most they'll paste a wallet *address* if they want
  the operator fee share.
- **What to have handy:** a free RPC key (you'll point them to one when needed) and, optionally,
  the wallet address that should receive their fee share.
- Close the welcome with the one next action: *"I'm getting your site ready now — takes about
  a minute, then your browser opens."*

### Stage 1 — launch the studio first (the user designs everything visually)

The **first thing the user should see is the site itself with the `/setup` studio open** —
they pick and type everything there, live, instead of answering terminal questions:

```sh
node --version            # must be 20+; tell the user to install Node 22 LTS if not
cd app
npm install
npm run dev               # leave it running
open http://localhost:5173/setup     # macOS · Linux: xdg-open · else print the URL big
```

Tell the user: *"Design your site here — name, style, colors, pages — and fill the
Deployment section — the default tier is the full site; it needs your own RPC key
(domain-restricted, it ships public) and your site URL, and takes your fee wallet if you
want the fee share (the ⓘ explains it). The whole site re-skins
live as you click. When it's right, press **Apply to this project**."*

**Apply writes both config files straight into the checkout** (a dev-only endpoint; it
doesn't exist on deployed sites) and the dev server **restarts itself with the new setup —
look and deployment both live**. The studio then shows the user a popup sending them back
to you.

**Wait for the click automatically** — run the waiter; it blocks until their Apply lands,
prints the next steps, and exits 0:

```sh
node create/wait-for-apply.mjs       # exits 0 the moment Apply writes the config; 2 on timeout
```

Run it in the background if your harness notifies you on completion; otherwise run it in
the foreground and re-run on timeout (default 30 min; `--timeout <seconds>`). The
dev-server log's `[setup] applied` line is the same signal. End your hand-off message with
the comeback line anyway — *"press **Apply**, then come back here and type **done**"* — so
the user knows the way back even without the waiter. They can iterate: change → Apply →
the site reloads as theirs; continue when the waiter fires or they return.

Before Stage 3, tell the user plainly what their tier ships — with the default, a fully
live site (launch + buy/sell + fees on the canonical contracts).

**Fallback — no browser / headless / user prefers Q&A:** ask the ten setup questions in
one batch (name · tagline · style · gradient or three hexes · pages to drop · tier,
default `all` = the full site · fee wallet, optional · RPC key, required · site URL,
required) and run the wizard yourself:

```sh
node create/index.mjs --yes --name "<name>" --style <style> \
  [--tagline "…"] [--gradient <id> | --from <hex> --via <hex> --to <hex>] \
  [--no-<page> …] [--tier <tier>] [--fee-wallet 0x…] \
  [--rpc <alchemy-key>] [--site-url https://…] \
  [--host zip|cloudflare|netlify|vercel|vps]   # prints that host's deploy steps
```

### Stage 2 — validate (you run this)

```sh
npm run check:config      # fix anything red; read the warnings to the user in plain words
npm run verify:chain      # live chain smoke: RPC answers, the factory enumerates,
                          # the canonical addresses hold code — on every configured chain.
                          # Read-only; non-zero exit = fix before building.
```

### Stage 3 — verify + hand off the manual steps

```sh
npm run build             # auto-runs check:config + the sitemap generator
npm run preview           # smoke-check the production build, then stop it
```

Then put it online — **CLI-first: after ONE login click per host, you run the entire
hookup yourself.** Ask which host (or recommend Cloudflare Pages), have them do the login
click, then drive:

- **Cloudflare Pages (recommended — fully agent-runnable):**
  `npx wrangler login` (the user's one click in the browser) →
  `npx wrangler pages project create <name>` → from `app/`:
  `npx wrangler pages deploy dist --project-name <name>`.
  That is a LIVE `<name>.pages.dev` URL with zero dashboard work — this path deploys your
  local build, so `.env.local` is already baked in and no dashboard env vars exist at all.
  Redeploy after any change with the same deploy command.
- **Netlify:** `npx netlify login` → `npx netlify init` → `npx netlify deploy --build
  --prod` (the repo-root `netlify.toml` drives base/build and auto-deploys the per-URL
  OG-card edge function).
- **Vercel:** `npx vercel login` → `npx vercel --prod` from `app/` (framework Vite;
  `vercel.json` ships). Its free tier is non-commercial per its ToS — say so.
- **Zip-drop (no CLI, no login for you at all):** `npm run package` builds and produces
  `app/<name>-site.zip` — the user drags it (or the `app/dist/` folder itself) onto
  **Netlify Drop** (https://app.netlify.com/drop) or **Cloudflare Pages → Upload assets**,
  or any static host with an upload box. `_redirects` ships inside so deep links work on
  those two; on a host that ignores it, point the user at its own SPA-fallback setting.
  Redeploy = rebuild, re-drop.
- **The user's own server (VPS):** upload the contents of `dist/` (or unzip the package
  there) and paste the two server rules from `app/SETUP.md` → *Your own server* (nginx /
  Apache / Caddy: the SPA catch-all + the nested-route asset remap). HTTPS required
  (wallets need a secure context).
- **Git-connected auto-redeploys (optional upgrade, dashboard-only):** if the user wants
  pushes to redeploy, push to their GitHub (`gh repo create --private --push` when
  authenticated) and walk them through the host's *Connect to Git* clicks — settings:
  root `app` · build `npm run build` · output `dist`. The tier, site URL and fee wallet
  are all committed (`src/site.config.json`), so CI needs exactly ONE env var,
  `VITE_ALCHEMY_API_KEY`: set it via the host CLI (`vercel env add` / `netlify env:set`)
  or print it ready to paste.
- **Custom domain**: the host dashboard walks the DNS (on Cloudflare-managed domains
  `npx wrangler pages domain add` works too; a domain elsewhere means one registrar
  visit). If the final URL differs from the site URL setup collected, update
  `VITE_SITE_URL=` in `app/.env.local`, rebuild, redeploy.

**Deployed ≠ done — verify the LIVE site before you say "deployed":**

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://<live-url>/           # expect 200
curl -sS https://<live-url>/ | grep -io '<title>[^<]*</title>'          # expect THEIR site name,
                                                                        # never a host placeholder
curl -sS -o /dev/null -w '%{http_code}\n' https://<live-url>/explore    # expect 200 — deep links
                                                                        # work (the SPA fallback)
npm run verify:chain          # the chain config baked into that build still answers live
```

If you can drive a browser, also load `/explore` on the live URL and confirm basket cards
paint with data. Only after these pass do you tell the user their site is deployed — a 404,
a placeholder title, or a failing chain smoke is your next action, not a success report.

**What stays truly manual for the user:** the one CLI login click per host · registrar
DNS when their domain lives elsewhere · buying a domain. Everything else is yours.

**Post-deploy, on request:** when a creator publishes a basket thesis, the app offers a
signed-JSON download; commit it to `app/metadata/<chainId>/<basket-address-lowercase>.json`
and redeploy — the thesis becomes visible to every visitor, still no backend
(`app/metadata/README.md`). To lock the public site's `/setup` page, set
`setupStudio: false` in `brand.config.ts`.

Typical run: **under 10 minutes** of agent work; the user's dashboard steps add 10–20.

### Updating — when the user says "update my site" (you run all of it)

The kit ships improvements over time; the user's identity lives in exactly three files the
kit never needs back (`app/src/brand.config.ts`, `app/src/site.config.json`,
`app/metadata/**`) plus the gitignored `app/.env.local` — so updates are a merge where
**theirs wins on those files, the kit's wins everywhere else**:

```sh
git remote add upstream https://github.com/Irora-dev/Spectrum   # once; skip if it exists
git fetch upstream
git log --oneline HEAD..upstream/main                 # tell the user what's new, briefly
git add app/src/brand.config.ts app/src/site.config.json app/metadata
git diff --cached --quiet || git commit -m "snapshot: site identity before kit update"
                                                      # their identity is safely committed FIRST,
                                                      # so a bad update is one command to undo
git merge upstream/main                               # on conflict: keep THEIRS for the three
                                                      # identity files; take UPSTREAM for the rest
cd app && npm install                                 # dependencies may have moved
npm run doctor                                        # config check + live chain smoke + version
                                                      # check in one pass; catches anything new
                                                      # the update expects
npm run build
```

If the update misbehaves, undo it on the spot with `git reset --hard ORIG_HEAD` (run it
right after the merge, before anything else) — the snapshot commit means their identity
files survive either way.

Then redeploy exactly as they deployed: the same one CLI command
(`wrangler pages deploy dist` / `netlify deploy --build --prod` / `vercel --prod`) — or on
a git-connected host, just push and CI redeploys. Never auto-update on your own initiative:
fetch, say what changed, and let the user say go. If `check:config` asks for something new,
collect it the same way setup did (or re-run the `/setup` studio and Apply).

---

## Doing it by hand instead

**1 · Generate your config**

```sh
node create/index.mjs
# or non-interactive, e.g.:
node create/index.mjs --yes --name "Acme Baskets" --style aurora   # full site by default
```

The wizard overwrites the pristine shipped default config; it refuses to touch a config
you've already customized unless you pass `--force`. You choose the same things the
interview above lists: name, style, colors, pages, tier, and the optional addresses — and
it ends by asking **where you'll host** (drag-and-drop zip · Cloudflare · Netlify ·
Vercel · your own VPS) and printing that host's exact deploy steps, VPS server rules
included.

**2 · Preview and iterate**

```sh
cd app
npm install
npm run dev               # http://localhost:5173 — live canonical Base data, zero config
```

Prefer clicking to typing? Open **/setup** and design in the browser — in dev, **Apply to
this project** writes both config files into the checkout and the server restarts itself
with your setup (a deployed site's studio offers downloads instead). Overrides (own
factory, RPC key, hidden baskets, metadata host) are all documented inline in
`app/.env.example` — `npm run check:config` validates whatever you set.

**3 · Build + deploy**

```sh
npm run build             # validates config, generates the sitemap, emits app/dist/
npm run package           # the same build + a drop-ready app/<name>-site.zip
```

The zero-CLI way online: drag the zip (or the `app/dist/` folder) onto **Netlify Drop**
(https://app.netlify.com/drop) or **Cloudflare Pages → Upload assets** — live in under a
minute, deep links included. Otherwise host `app/dist/` anywhere static — the Cloudflare
Pages / Netlify / Vercel CLI specifics, including the SPA fallback and env vars, are
exactly as in Stage 3 of the agent runbook above. Full hosting/RPC/IPFS detail: [`app/OPERATORS.md`](app/OPERATORS.md) ·
[`app/SETUP.md`](app/SETUP.md) · [`app/handover/`](app/handover/README.md). Every
generated site carries a small "powered by Spectrum Mini" line in its footer.

## No database

This kit ships **DB-less**: discovery, charts, leaderboards, launch, flush, and referrals all
run on chain data alone. Creator thesis/identity persist per-browser, plus two zero-backend
ways to show them to everyone: commit the signed blob into `app/metadata/` (ships in the
build), or point `VITE_METADATA_BASE_URL` at a static file host you control. The wizard
never asks for a database because there isn't one.
