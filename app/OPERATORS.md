# OPERATORS.md — hosting this frontend yourself

Plain-language notes for anyone who wants to host this Spectrum V2 frontend.
The kit is **operational by default**: `src/lib/chain/deployments.json` ships the
**canonical Spectrum address book** (Base, Ethereum + Robinhood Chain), every address overridable to
serve your own deployment. It ships **no curated lists and no default fee
recipient** — the two fee-recipient values are empty until you set your own wallet.
Whoever hosts it makes — and owns — every go-live choice, including **verifying any
contract address the site routes value through** (canonical included).

> **In a hurry?** [`SETUP.md`](SETUP.md) is the one-page clone → configure →
> validate → build → deploy checklist.
>
> **Full operator handover set:** this file is the quick hosting note. The
> complete documentation — business overview, technical reference, and the
> step-by-step go-live runbook — lives in
> [`handover/`](handover/README.md) (`handover/README.md` → `01-BUSINESS.md` →
> `02-TECHNICAL.md` → `03-IMPLEMENTATION.md`).

## What works with no keys at all

The build is keyless-first. With a plain public RPC:

- **Discovery**: every basket is enumerated straight from the factory's
  `allBaskets` / `allBasketsLength` views — no log scans, no archive node.
- **Reads**: NAV (`exchangeRate` / `totalReserve` static views), per-basket fee
  config, holdings, supply, deployer attribution.
- **Pricing/charts**: DexScreener (keyless, CORS-friendly) for constituent spot
  prices and the reconstructed history.
- **Launch search & token art**: DexScreener search + the Uniswap Labs token
  list (verified-badge identity for majors) + Coingecko contract lookups (logos,
  market-cap rank) — all keyless, CORS-open, cached in localStorage, and
  individually optional: any source failing just degrades that signal. Brand
  colors for ~450 major tokens ship pre-baked (`token-meta.generated.ts`);
  refresh the file anytime with `npm run bake:colors` (optional, no key).

What does NOT work keyless:

- **Wide V4 Initialize scans** in the launch flow's pool detection (public RPCs
  cap filtered `getLogs`). The builder shows a prominent "V4 venues were not
  scanned on this build" warning instead of pretending. An origin-restricted
  Alchemy-class key (`VITE_ALCHEMY_API_KEY`) or a read proxy you run restores
  full V4 coverage.
- **Long log lookbacks** (e.g. inception timestamps for very old baskets).

## Configuration is yours

- **Tooling.** `npm run init:env` copies `.env.example` → `.env.local` (Vite reads
  `.env.local`, not `.env.example`). `npm run check:config` validates your config
  before you build — it catches a transactional flag without `WALLET`, malformed or
  mistyped addresses, `VITE_ENABLE_SWAP` with no router, an activated chain with no
  factory, and a **missing site URL (a warning — fine for a first deploy**; your host
  assigns one, then set it in `src/site.config.json` or via `VITE_SITE_URL` and
  rebuild), and prints which build tier your flags express. It also runs automatically
  as a **prebuild check**, so a fatal misconfig can't slip into a build (run
  `vite build` directly to bypass).
- `src/lib/chain/deployments.json` ships the **canonical Spectrum addresses** for
  Base, Ethereum + Robinhood Chain — blank env = the canonical deployment. To serve **your own**
  deployment, use the `VITE_*` overrides in `.env.example` or edit the JSON.
  **The `VITE_*_ADDRESS` overrides apply to the default chain (Base) only** —
  every other chain reads `deployments.json` and ignores the env vars, so a
  non-Base chain's addresses must go in the JSON (or it stays an empty shell with
  no in-app warning; `check:config` flags this).
- `VITE_EXTRA_CHAIN_IDS` — **Base, Ethereum and Robinhood Chain are all live by default** (a chain
  with a `deployments.json` entry is active, and the canonical book ships both).
  This var exists only to activate a future scaffolded chain that has no
  `deployments.json` entry yet; it ships no addresses, and such a chain is an
  empty shell until you configure its deployment.
- **Every `VITE_` value ships publicly in the static bundle.** A key you set is
  a public key. Use origin-restricted keys or a proxy.

  **Restricting the key to your own domain is the right setup** — that is what
  makes a public key safe to ship, and it is exactly what an RPC provider's
  allowlist is for. Two things to get right when you do it:

  1. **Allowlist every origin the site is actually served from**, not just the
     final domain. If you deploy to Cloudflare Pages and keep the
     `*.pages.dev` URL alive, that is a second origin; preview deployments get
     their own hostnames too. And add **`http://localhost:5173`** (whatever port
     you run) or your own `npm run dev` stops working the moment the key is
     locked down — that surprise is usually the first thing people hit.
  2. **It is an allowlist, not a secret.** Providers enforce it on the browser's
     `Origin`/`Referer` header, so it stops your key being reused on somebody
     else's site — the thing that actually costs you money — but it is not a
     defence against someone crafting their own request. Never put a key with
     write access, billing rights, or admin scope in a `VITE_` value; if you need
     real secrecy, put a read proxy you control in front and point the kit at it
     with `VITE_BASE_RPC_URL` (etc.) instead of shipping the key at all.
- Your **site URL + fee wallet** live in the committed `src/site.config.json` (the
  setup studio/wizard write it; public by construction — every `VITE_` value ships in
  the bundle anyway). `VITE_SITE_URL` / the two fee vars override it. A build REQUIRES
  a site URL; point it at your own property only. The **RPC values are the ones kept
  out of git** (gitignored `.env.local`; on git-connected CI set them in the host
  dashboard/CLI): an Alchemy key (`VITE_ALCHEMY_API_KEY`) or full per-chain endpoint
  URLs from any provider (`VITE_BASE_RPC_URL` / `VITE_MAINNET_RPC_URL` /
  `VITE_ROBINHOOD_RPC_URL` — QuickNode, Infura, your own node; a URL beats the key).
- `VITE_PARTNER_APP_URL` — optional "Visit $SYMBOL" link target. Unset, the CTA
  simply doesn't render; this package does not anoint a trading venue.

## Product knobs in `brand.config.ts`

Separate from the env/address config above: `src/brand.config.ts` carries your
**look and which surfaces exist**. Everything here is **default-ON** — omit a key
and you get it; only an explicit `false` turns it off. The **`/setup` studio**
(footer → Customize) edits all of it visually and downloads the file, and the
**CLI wizard** takes the matching `--no-*` flags — you never have to hand-edit.

| Key | Default | What `false` does | CLI flag |
|---|---|---|---|
| `pages` | all on | Drops a page from the nav, the routes and the footer (`discover`, `launch`, `trade`, `fees`, `portfolio`, `creators`, `refer`, `league`, `bundle`, `integrate`, `docs`) | `--no-<page>` |
| `stocks` | on | Hides every tokenized-stock **surface**: the launcher's stock shelf, the stocks-and-tokens banner, stock badges. It cannot block a pasted stock address — routability stays the chain's own truth | `--no-stocks` |
| `starterTokens` | on | Drops the small curated **starter suggestions** the launch shelves fall back to before your chain has baskets of its own. These are third-party token addresses suggested on your site; off leaves the shelf purely organic (most-used constituents of live baskets, ranked by live market data) | `--no-starter-tokens` |
| `prismCredit` | on | Removes the **"Powered by Prism"** banner (home, basket, swap, fees) that links out to Prism Beat. The protocol's PRISM buy-and-burn leg is contract-side and unaffected either way | `--no-prism-credit` |
| `setupStudio` | **off** | OPT-IN: serves the `/setup` studio and the footer Customize link on your DEPLOYED site. **Dev servers always serve it regardless**, so setting up and updating are unaffected. Flipped to off-by-default 2026-08-02 — a live site should not offer visitors a customiser. Drafts were never server-side and the write-back endpoint is dev-only, so this is product posture, not security | `--setup-studio` |
| `defaultChainId` | book default | Sets the **first-visit** network (must be a scaffolded chain id). A returning visitor's own network choice always wins | — |

`style` + `palette` are the visual identity (5 drastically different styles, 14
gradient presets); `name` is a text wordmark (no logo), up to 32 characters.
"Spectrum" is allowed — a site built on this kit *is* an interface to the Spectrum
protocol, and it ships as the default. Keep it short: the home hero renders the
name very large, and a single word beyond ~11 characters starts getting clipped on
a narrow phone.

## Mobile

The kit is mobile-first out of the box; there is nothing to configure.

- **A bottom tab bar is the phone navigation** (Home · Explore · Swap · Portfolio
  · More), with the remaining enabled pages in a bottom sheet. It renders the
  same gated link model as the desktop menu, so your `pages` choices govern
  both, and it hides itself once the full top menu fits. It also gets out of the
  way while the on-screen keyboard is up.
- **The basket page grows a mini-buy bar** on phones once the swap console
  scrolls out of reach — one tap back to the single console, not a second one.
- Safe areas (notch, home indicator) are respected throughout, inputs are at the
  16px floor iOS needs to stop auto-zooming on focus, and the hero art ships
  phone-sized variants so a phone never decodes a 4K image.
- The animated spectral background **stops drawing** under
  `prefers-reduced-motion` and in the flat design styles that hide it, so it
  costs an idle phone nothing.

## Social link previews (OG cards)

Social crawlers (X, Telegram, Discord, Slack) don't run JavaScript, so a
client-rendered SPA can only ever show them the single generic card in
`index.html`. Two tiers, pick one:

- **Baseline — no extra infra.** Set `VITE_SITE_URL` (above) and every shared link
  unfurls as the shipped generic card (`public/og.png` — name-neutral spectral art;
  your site's NAME rides in the og:title/description text, which the build brands
  from `brand.name`). Perfectly fine to launch with; the preview just isn't
  personalised per basket. Want your own art? Replace `public/og.png` (1200×630).
- **Per-URL cards (recommended) — a Netlify Edge Function that ships with the app.**
  `app/netlify/edge-functions/og.ts` (wired by the repo-root `netlify.toml`)
  rewrites the `<title>` + og/twitter tags per shared URL for `/token`,
  `/creator/<addr>` and `/refer`. **If you host on Netlify with base
  `app`, it deploys WITH the app automatically — no separate deploy, no
  route to configure** (dashboard walkthrough: `docs/deploy/netlify.md`). It
  reads basket names from a live `/tokenlist.json`
  (regenerate with `npm run build:tokenlist` when baskets launch). Its `og:image`
  is the generic card today; per-basket card *images* are a documented follow-up
  (`app/netlify/edge-functions/README.md`).
- **Not on Netlify?** The standalone Cloudflare Worker in `handover/og-worker/`
  does the same per-URL rewrite AND renders per-basket / creator / refer card
  *images*; deploy it with `wrangler` and route your public hostname through it
  (`SITE_ORIGIN` = your origin). See its README.

## Feature flags = your risk surface

**The onboarding default is all four ON**, written into the committed
`src/site.config.json` (`features`) by the studio/wizard; the `VITE_ENABLE_*` env vars
override per flag (an explicit `false` scopes down). The shipped file is all-off, so a
clone with no config artifact stays read-only — the deliberate safety net:

- `VITE_ENABLE_WALLET` — read-only wallet connect (portfolio view).
- `VITE_ENABLE_DEPLOY` — arms the launch broadcast (creator acts for themselves).
- `VITE_ENABLE_TRADING` — the `/flush` **fee console**: holder fee-claim + the
  permissionless cranks. Does **not** include buy/sell.
- `VITE_ENABLE_SWAP` — **buy/sell** (the `/swap` page + the Token panel). The
  highest-risk surface and **the arm switch**: on means live trades through the
  resolved swap router — the canonical Spectrum router ships in
  `deployments.json`, so this is live **without** setting any address (next
  section). Set it `false` and buy/sell disappears entirely — no `/swap` route,
  no nav link, no panel anywhere.

The flags are fully independent; any deploy/trading/swap flag without the wallet
flag fails the build on purpose. **Whoever enables WALLET / DEPLOY / TRADING /
SWAP owns the consequences of running those surfaces.** This is software, not
advice.

Buy/sell is split out from the fee console deliberately: it is the surface where a
visitor's value moves through a swap contract, so it has its own flag — the first
one to set `false` when you want a narrower site.

## The swap router (live buy/sell)

The swap router is the small periphery that actually executes a buy/sell. It exists
because a Spectrum basket is its own Uniswap V4 hook with **no buy/sell function**:
a trade is a V4 swap into the basket's hook, and the hook rejects any swap that
doesn't carry a per-trade payload (an aggregate minimum + one minimum per
constituent + your interface tag). Two consequences:

- **A generic DEX aggregator cannot trade these baskets** — it can't build that
  payload, so the swap just reverts. Don't wire one as your buy/sell path.
- **The canonical Spectrum router ships** in `src/lib/chain/deployments.json`
  (all shipped chains) — with `VITE_ENABLE_SWAP` on and nothing else set, trades
  broadcast through it. Set `VITE_SWAP_ROUTER_ADDRESS` (or edit the JSON) only to
  route through a router **you** deployed. On a chain with no router configured
  anywhere, buy/sell stays preview-only.

The router design is documented in full and the frontend `swapRouterAbi` is
**reconciled** against it. Whichever router your build resolves — canonical or your
own — **verify it against a canonical source before arming the flag**: enabling
buy/sell makes it the contract your visitors' trades approve and route through.

> **The full build-to spec for the router** — the V4
> `unlock`/`unlockCallback` flow, the Tier-1 floor SDK, the first-mint floor rules, the buy/sell
> protection models, the safety red-lines, and the wire-to-FE checklist — travels
> with the **contracts source** (the Spectrum swap-router reference), a separate repo that
> does not ship in this frontend kit.

## Buy/sell: the router, verifying it, scoping it off

Buy/sell is **on by default** in every onboarding-generated config (`VITE_ENABLE_SWAP`
is the arm switch; `false` removes the surface entirely). Before you ship a build with
it on, walk these steps:

1. **Decide the router your build will use.** The **canonical Spectrum router ships**
   in `deployments.json` — using it means steps 2–3 reduce to *verify it against a
   canonical source*. Running **your own** instead: the router design carries the trade's
   `(minOut, legMins[], frontend)` payload (the "hookData") into a basket's V4 self-pool: it
   takes an exact-input `tokenIn` (USDC on a buy, the basket token on a sell) by `transferFrom`
   (the trader approves the router), enters the V4 PoolManager's `unlock`, runs the swap on the
   basket's own pool **forwarding the hookData verbatim**, settles `tokenIn` and sends the output
   to the trader, and enforces an aggregate `minOut`. The off-chain per-leg floor derivation
   (the first-mint per-leg minimum that bounds slippage end-to-end) lives in the Tier-1 SDK
   `app/src/lib/spectrum/swap-quote.ts`. **Full build-to spec:** the swap-router reference that
   travels with the contracts source (a separate repo; not shipped in this frontend kit).
2. **The ABI already matches.** The FE `swapRouterAbi` —
   `swapExactIn(basket, tokenIn, amountIn, minOut, hookData, to)` — is reconciled against the
   reference router design. If you adapt the contract,
   re-check the `swapExactIn` signature + the `Swapped` event against the binding before going live.
3. **Set the address (own-router builds only).** `VITE_SWAP_ROUTER_ADDRESS=<your router>` —
   blank resolves to the canonical router. With an address set but the flag still off,
   nothing changes — buy/sell stays hidden.
4. **Flip the flag and rebuild.**
   `VITE_ENABLE_WALLET=true VITE_ENABLE_SWAP=true npm run build`
   Now the `Swap` nav link, the `/swap` page, and the Token buy/sell panel render and
   broadcast through the resolved router. (If you also want holders to claim fees, add
   `VITE_ENABLE_TRADING=true`.)
5. **Verify.** With the flag off, confirm there is no `/swap` route and no trade
   panel. With it on, confirm a small buy on a testnet/forked build goes
   approve → trade and the minimum-received shown matches what you sign. (Only a
   chain with no router configured anywhere shows "Preview only.")

## The interface tag

`VITE_INTERFACE_TAG_ADDRESS` makes your interface a recipient of the protocol's
fixed interface share (`INTERFACE_SHARE_BPS` ≈ 5% of the fee) on transactions
routed through it (the FeePanel discloses this to users automatically). It is a
per-transaction tag. The shipped default is empty — which means `address(0)`
on-chain, and the interface slice is then **not carved at all**: it stays in the
post-burn remainder and flows to the creator share + basket holders. Receiving
the slice makes you a protocol-fee recipient.

## The launcher slice

`VITE_LAUNCHER_ADDRESS` is a **per-basket origination** slot. When set, the launch
builder injects it into `FeeConfig.launcher` on every basket you deploy, so that
basket pays the fixed launcher share (`LAUNCHER_SHARE_BPS` ≈ 5% of the fee) to
your address for as long as it trades. It is **never shown to or set by the
creator** — it is your attribution as the deploying integrator. The shipped
default is empty — `address(0)` → no launcher, and that fixed slice stays in the
remainder (creator + holders). Same red line as the interface tag: no default
address may ever ship here. Receiving the slice makes you a protocol-fee
recipient, the same as the interface tag.

## Creator metadata (optional)

`VITE_METADATA_BASE_URL` (and optionally `VITE_IPFS_GATEWAY_URL`) point the FE at
a host that **serves creator-published, deployer-signed** basket metadata — the
creator's ENS name shown on basket and creator pages, the `supersedes` link that
powers basket versioning, (v3) the creator's own **thesis**: a tagline,
long-form thesis prose, sector tags, and a time horizon — and (v4) an optional
**launch post** link: strictly a single `x.com/<user>/status/<id>` URL (any
other website or path shape is rejected at signing AND at render, so the one
creator-controlled outbound link can never point anywhere else). All of it is carried
*inside the signed payload*, so the same deployer-signature gate covers the prose —
the FE verifies each blob's signature against the basket's on-chain deployer before
rendering anything. You host/serve signed content, you never author it; and you
retain editorial control over what your instance *displays* via `VITE_HIDDEN_BASKETS`
without ever gaining protocol control. The
shipped default is empty → no metadata is fetched and every basket attributes to its
on-chain deployer address (ENS name, else the raw address). There is no
package-author/default endpoint, by design — set your own. The "upgrade to a new
version" action is preview-only here (it rides `VITE_ENABLE_TRADING` and a migration
router that is not deployed); the "New version" creator action rides
`VITE_ENABLE_DEPLOY`.

`VITE_METADATA_BASE_URL` is the *read* host. To make the creator's **publish step**
one click, you may optionally run a **write-relay** and point `VITE_METADATA_WRITE_URL`
at it. The FE's post-deploy publish ceremony POSTs the creator's signed blob to
`${VITE_METADATA_WRITE_URL}/<chainId>/<basket>.json`. Your relay's contract is
narrow and load-bearing:

- **Re-verify the EIP-712 signature server-side** against `factory.tokens(basket)`
  and **reject anything that fails.** The relay holds no key and can never forge —
  the signature is the only authority. A hostile or buggy relay can deny, never forge.
- **Persist** the verified blob at the convention path so the read host serves it.
- **Author nothing, list nothing, rank nothing** — that would edge toward a curated
  store. It is a dumb, signature-gated content sink.

Leave `VITE_METADATA_WRITE_URL` unset (the default) and the ceremony still works:
it offers the creator a **download** of the signed JSON (to self-host at the
convention path, or hand to you) plus **this-browser localStorage** so they see
their own profile immediately. No relay is required to publish.

**Zero-backend, visible to every visitor:** you don't need any external host at all. Commit that
downloaded blob into the site-bundled `app/metadata/<chainId>/<basket>.json` path and redeploy —
it ships **inside the build** and is read in-memory (no database, no server, no external service),
so the thesis/profile is visible to **all** visitors. This site-bundled rung takes precedence over
`VITE_METADATA_BASE_URL` for the same basket. See [`metadata/README.md`](metadata/README.md).

## No social DB — the kit is DB-less

The optional Supabase social-DB layer (computed creator/basket leaderboards, durable
long-range NAV history, version-series adoption) was **removed**. There is no
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` and no `src/lib/social-db/`; discovery,
charts, leaderboards, launch, flush, and referrals all run on **chain data alone**, and a
unit test guards the removal (`.env.example` documents it). Creator thesis/identity persist
per-browser, with the optional site-bundled `app/metadata/` files or an external metadata host
(above) for cross-browser visibility. To keep list/discovery surfaces cheap at scale, use the
DB-less **snapshot** poller instead (`scripts/build-snapshot.mjs` + `VITE_SNAPSHOT_URL`; see
[`handover/RPC-EFFICIENCY.md`](handover/RPC-EFFICIENCY.md)).

## Honest limitations

- **A static IPFS/ENS site cannot enforce any server-side access controls.**
  There is no server. If you need access controls, they have to live in an
  edge layer (CDN/gateway) outside this repo.
- The shipped default lists whatever the **canonical factory** enumerates on
  chain — no seed lists, no curation. Pointed at your **own** fresh factory, an
  empty marketplace is correct behavior, not a bug.
- Per-basket OG cards need prerendering — a SPA limitation; your call.

## The onboarding, linked wallets, and backups

Three visitor-facing systems your site carries with zero configuration:

- **The first-open ceremony.** A visitor's first /portfolio plays a three-step
  intro (the story → connect → their real holdings) and the homepage's
  get-started act is the same system inline. Both are strictly
  connection-honest: nothing renders under "What you already hold" without a
  real wallet. `/portfolio?intro=replay` re-plays it for demos.
- **Linked wallets.** Visitors can sign once per wallet to read several wallets
  as one portfolio. The links live in THEIR browser (nothing on your site, no
  database), travel as a signature-verified file, and never let one wallet act
  for another — trades and claims always come from the connected wallet.
- **Backup / restore.** "Full backup" in the wallet panel downloads everything
  a browser accumulates (targets, drafts, records, links) as one JSON file;
  restore lives on the portfolio's connect gate and never overwrites newer
  local work. There is nothing operator-side to run — it is all client-local.

## The browser extension

Your site can hand visitors a read-only portfolio lens for their toolbar, carrying
your wordmark. Package it (`cd extension && npm run package -- --into-site`),
rebuild, redeploy: the install page appears at `/extension`, serving files your own
site hosts. The `/setup` studio's Extension panel shows where you are and the next
command at every step. Trust posture, verbatim on the page: that URL is the only
official source, and the lens never connects, never signs, never asks for a seed
phrase. A website cannot install an extension for the visitor; the honest ceiling
is one click plus the browser's own confirmation, and the kit's copy never implies
more.
