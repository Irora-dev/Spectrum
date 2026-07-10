# 03 — IMPLEMENTATION: the go-live runbook

> **This is software, not advice.** This document is engineering guidance for
> deploying a *static frontend* that connects to already-deployed contracts. Operators who enable
> `WALLET` / `DEPLOY` / `TRADING` are responsible for whatever they stand up. Nothing is deployed by this
> package; the PRISM burn leg is **wired and in-flight, not a realised fact** (verify on-chain
> before repeating any burn claim). An **empty marketplace on a fresh deployment is correct
> behavior, not a bug.**

This is the do-this-then-that runbook for an operator standing up the Spectrum V2 frontend as
their own independent business. It assumes you have read, or will read alongside this:

- **`README.md`** — the index, reading order, and partition/status banner for this doc set.
- **`01-BUSINESS.md`** — what the product is, the operator roles, the kickback economics, the
  business risk register. Read this before you decide *which* surface to build.
- **`02-TECHNICAL.md`** — architecture, the contract-integration surface, every flag/env knob,
  NAV/fee/hookData/salt internals, and the known constraints. Keep it open while you configure.

This document takes you from a clean clone to a publicly hosted build, in order:

1. **Prerequisites** — what must already exist (and who owns it) before you start
2. **Fork & install** — clone, install, run the dev server
3. **Configure** — addresses, RPC, operator identity, the kickback tag
4. **Connect & verify on-chain** — prove the frontend points at the right, verified contracts
5. **Choose your surface / build** — the three flag tiers, one static artifact each
6. **Host** — IPFS/ENS canonical pattern, alternatives, the static-site access-control limitation
7. **Go-live QA** — per-tier smoke tests + the no-bug acceptance checklist you sign off
8. **Operations & maintenance** — RPC monitoring, re-pinning, address-book updates, cranks
9. **Troubleshooting** — the common failure modes and what they actually mean

Throughout, the product is **baskets** — never "indexes." Code identifiers may still carry
Index-era names; that does not change the product vocabulary.

Repo root for everything below: the repository root. The frontend app lives at
`app/`. Commands assume you are in `app/` unless stated otherwise.

---

## 1. PREREQUISITES

These are prerequisites for everything below. Confirm each before you write a single line of config.

### 1.1 A deployed factory lineage, and a filled `ADDRESSES.md`

**This is NOT your job as the operator.** Deploying the contracts is owned by **whoever owns and
deploys this repo** — the party who reviewed, hardened, re-derived, and deployed the
contracts. Your job is to *connect* a frontend to a lineage that already exists. You inherit two
artifacts from that party:

- A **deployed factory address** (per chain you intend to serve), plus the supporting
  infrastructure addresses (USDC, PoolManager, WETH, the Uniswap V2/V3 factories).
- A **filled factory deployment address book** — the
  canonical address file for that lineage. In this package it ships as a **deliberate
  placeholder, empty of values.** Whoever deploys the contracts fills and maintains it, not you.

> **For whoever deploys the contracts (not the operator):** this package
> ships **no FE deploy scripts and no contract deploy scripts**, deliberately. The contract
> deploy + verification sequence travels with the **contracts source** itself (a separate repo). There is no pause and no upgrade in this design — every shipped bug is
> permanent, so the deploying party should hold the final contracts to their own bar (a green
> Foundry invariant suite, on-chain verification, a permissive license, and reconciliation
> against their own build) before deploying. As of this package nothing is deployed.

What you, the operator, must obtain from the deploying party and treat as your source of truth:

| You need | From | You will use it in |
|---|---|---|
| `factory` address (per chain) | the deploying party's `ADDRESSES.md` + on-chain | §3 configure, §4 verify |
| `usdc` (canonical Base USDC) | same, verified against Circle's published address | §3, §4 |
| `poolManager`, `weth`, `uniV2Factory`, `uniV3Factory` | same | §3 (required only for the launch/pool-detection engine) |
| `aerodromeFactory` (optional) | same | §3 (detected only to WARN — never a routing venue) |
| source-verification confirmation | block explorer | §4 |

> **Re-seating implication (carry this forward).** Re-seating *any* compile-time contract
> constant changes the contract bytecode → a new init-code hash → **every mined hook salt is
> invalidated** and the in-browser salt miner must target the new build. This is why a "new
> factory generation" (§8.3) is a real event, not a cosmetic version bump.

### 1.2 Toolchain

- **Node** — Node 24.x (an LTS ≥ 20 is fine; the app is React 19 + Vite 6, ESM `"type":
  "module"`). The repo declares no `engines` pin; use a current LTS.
- **A package manager** — use whichever you prefer. The repo is set up for **pnpm** (the
  `.claude/launch.json` invocations assume it, and a `pnpm-lock.yaml` is checked in), but
  `package.json` declares no `packageManager` field and a `package-lock.json` is also present,
  so **npm and yarn work too** — the npm scripts (`dev`/`build`/`typecheck`/`preview`) are
  package-manager-agnostic. The commands below show `pnpm`; substitute `npm run …` / `yarn …`
  freely. If you do want pnpm and lack it: `npm i -g pnpm` (or `corepack enable pnpm`).
- A POSIX shell, `git`, and a browser for QA.

### 1.3 A wallet

A browser wallet (MetaMask, Rabby, Brave, Coinbase Wallet, or any EIP-6963 / injected wallet) is
required to test or run **any** transactional tier (`WALLET` / `DEPLOY` / `TRADING`). It is **not**
required for an info-only build (you can browse, read NAV, and view fee disclosures with no
wallet at all).

### 1.4 Optional keys

- **RPC key** (`VITE_ALCHEMY_API_KEY` or a custom `VITE_BASE_RPC_URL`) — *optional.* The build is
  keyless-first. The **only** thing a key buys you is complete Uniswap **V4 pool discovery** in
  the launch flow (wide filtered `getLogs`, which public RPCs cap) and long log lookbacks
  (old-basket inception timestamps). Browse / NAV / fee / holdings / discovery all work keyless.
  **Every `VITE_*` value ships publicly in the static bundle** — a key you set is a public key.
  Use an **origin-restricted** key or a read proxy you control (see §3.2).
- **WalletConnect projectId** (`VITE_WALLETCONNECT_PROJECT_ID`) — *optional.* Adds the
  WalletConnect connector. Injected / EIP-6963 wallets and Coinbase Wallet work without it.

### 1.5 The static-site access-control limitation

A static IPFS/ENS site **has no server**, so it cannot enforce any server-side access controls. If
your situation needs access controls, that is an edge/CDN-layer decision outside this repo. The
info-only build (all flags off) is the lowest-surface option and the shipped default.

---

## 2. FORK & INSTALL

```bash
# 1. Get the frontend (clone the hand-off repo / subtree, or copy app/ into your own)
git clone <your-fork-or-the-handoff-repo> spectrum-fe
cd spectrum-fe/app

# 2. Install dependencies (pnpm shown; npm install / yarn also work — see §1.2)
pnpm install

# 3. Run the dev server (port 4022 is what the repo's launch.json pins)
pnpm dev --port 4022 --strictPort
# → open http://localhost:4022
```

`pnpm dev` runs Vite (the `dev` script is just `vite`). The repo's `.claude/launch.json` pins
port **4022** with `--strictPort`
(fail rather than silently pick another port); plain `pnpm dev` would use Vite's default 5173.
Use whichever you prefer for local work — the port is not load-bearing.

### What you will see in dev (the mock fixture)

The shipped config is **empty** (no factory in `deployments.json`). To keep the UI from rendering
blank during review, a **dev-only mock fixture** supplies two synthetic baskets ("Dev Sample
Basket" / DEVBKT and "Dev Sample Basket Two" / DEVTWO) with obviously-fake addresses
(`0x…ba5e01` / `0x…ba5e02`) and a fake deployer.

Three facts about the fixture you must internalize:

1. It is imported **only behind `import.meta.env.DEV`** (a dynamic import) — it is **never** in a
   production bundle.
2. It activates **only** when the active chain has **no factory configured**. The moment you fill
   a real factory address, a real deployment wins and the fixture goes inert.
3. The fake baskets are **not seeds, not curation, not data** — they exist solely so a reviewer
   sees a populated layout. Do not mistake them for content.

So: an unconfigured `pnpm dev` shows the mock baskets; a configured dev build (or any
`pnpm build`) shows real chain data or an honest empty state. See `02-TECHNICAL.md` for the
fixture's exact activation rule.

```bash
# Other scripts (exact npm-script bodies, package.json):
pnpm init:env      # init:env     → "node scripts/init-env.mjs"     (copy .env.example → .env.local)
pnpm check:config  # check:config → "node scripts/check-config.mjs" (validate config before build)
pnpm build         # build        → "tsc -b && vite build"          (typecheck THEN bundle into dist/)
                   #   prebuild    → "node scripts/check-config.mjs" (runs automatically before build)
pnpm typecheck     # typecheck    → "tsc -b"                         (typecheck only)
pnpm preview       # preview       → "vite preview"                  (serve built dist/ for a pre-host look)
# (The broken `bake:colors` baker was removed; the runtime hashed-hue fallback colors every token.)
```

---

## 3. CONFIGURE

Configuration is entirely yours. The package anoints nothing and points at no one. Copy the
template and fill it from your **verified** `ADDRESSES.md` (§1.1):

```bash
pnpm init:env                # copies .env.example → .env.local (idempotent; never clobbers)
# equivalently: cp .env.example .env.local   (.env.local is gitignored; never commit secrets)
```

> **Validate before you build.** After editing `.env.local`, run `pnpm check:config`
> (`node scripts/check-config.mjs`). It reports your build tier and flags the common
> footguns — a transactional flag without `WALLET` (fatal: blocks the build, the same
> invariant the app throws on at load), malformed/mistyped addresses, `SWAP` with no
> router, a chain activated with no factory, a missing `VITE_SITE_URL`, a stub sitemap.
> It also runs **automatically as a `prebuild` check**, so a fatal misconfig can't slip
> into a build (run `vite build` directly to skip it).

> **The cross-cutting security fact, stated once and repeated:** this is a **client-only static
> bundle**. Every `VITE_*` value is compiled into the public JavaScript and ships to anyone who
> loads the site. **There is no server-side secret.** Treat every value you set as public.

### 3.1 Addresses — fill `deployments.json` OR the `VITE_*` overrides

There are two injection mechanisms; you pick one (env wins over JSON for the default chain).

**Option A — edit `deployments.json`** (`src/lib/chain/deployments.json`). It ships empty:

```json
{
  "8453": {
    "factory": "",
    "usdc": "",
    "poolManager": "",
    "weth": "",
    "uniV2Factory": "",
    "uniV3Factory": "",
    "aerodromeFactory": ""
  }
}
```

Fill the fields for the chain you serve (`"8453"` = Base, the shipped default). An
empty/invalid string is coerced to `null` — with `factory` null the app is an honest empty
shell.

**Option B — `VITE_*` address overrides** (in `.env.local`). These override `deployments.json`
**for the default chain (Base 8453) only**; other chains read JSON only.

```bash
VITE_FACTORY_ADDRESS=0x...        # required to show any baskets / NAV / fees
VITE_USDC_ADDRESS=0x...           # required (canonical Base USDC, verified vs Circle)
VITE_POOL_MANAGER_ADDRESS=0x...   # required for launch/pool-detection only
VITE_SWAP_ROUTER_ADDRESS=0x...    # required for live buy/sell — YOUR own deployed router (DRAFT)
VITE_WETH_ADDRESS=0x...           # required for launch/pool-detection only
VITE_UNIV2_FACTORY_ADDRESS=0x...  # required for launch/pool-detection only
VITE_UNIV3_FACTORY_ADDRESS=0x...  # required for launch/pool-detection only
VITE_AERODROME_FACTORY_ADDRESS=0x... # optional — detected only to WARN (no V4 hook support)
```

**Minimum to connect** (browse / NAV / fee display): `factory` + `usdc` for Base. The
`poolManager` / `weth` / `uniV2Factory` / `uniV3Factory` set is **additionally** required only
for the **launch / pool-detection engine** — you do not need them for an info-only or
trading-only marketplace that does not host the basket builder's pool scan. `swapRouter` is
**additionally** required only for **live buy/sell** (the `/swap` page + Token `TradePanel`): with
it unset, buy/sell renders preview-only even on a trading build. It is **your own** deployed
swap router (a basket is its own V4 hook with no buy/sell method, and no generic aggregator
can route it — see §3.4b below); this repo ships no router and the
binding is a DRAFT until the router shape finalizes.

**Active networks — Base-only by default, opt into Ethereum.** The network switcher and wallet
network-switching cover whatever chains are *active*. The shipped default is **Base only**.
To also expose **Ethereum** (id `1`), set `VITE_EXTRA_CHAIN_IDS=1` (comma-separated for more
scaffolded chains). This activates a chain for viewing + wallet network-switching **without
shipping any addresses** — an activated chain with no deployment is an honest empty shell on that
network (lists / transacts nothing) until you fill its addresses. Base always leads the switcher.
The connect-wallet button itself is controlled separately by its own flag `VITE_ENABLE_WALLET` (see §5).

### 3.2 RPC (precedence + the public-key warning)

Per-chain precedence is identical for Base and Ethereum mainnet:

1. **Explicit endpoint** — `VITE_BASE_RPC_URL` / `VITE_MAINNET_RPC_URL` (highest precedence).
2. **Alchemy key** — `VITE_ALCHEMY_API_KEY` → builds `https://base-mainnet.g.alchemy.com/v2/<key>`
   (and the mainnet equivalent). Setting this also flips `hasAlchemyKey()` true, which enables
   the wide filtered `getLogs` needed for **complete V4 pool discovery** in the launch flow.
3. **Public node** — `https://base-rpc.publicnode.com` / `https://ethereum-rpc.publicnode.com`.

```bash
# Pick ONE pattern. All of these ship publicly.
VITE_BASE_RPC_URL=https://your-origin-restricted-proxy.example/base   # recommended for trading scale
# or
VITE_ALCHEMY_API_KEY=...   # origin-restricted key only — see warning
# or leave both empty → public node (works; V4 discovery degrades, see §9)
```

> **WARNING — every `VITE_*` value ships publicly.** A raw Alchemy key in this static bundle is a
> public key anyone can lift from your JS and abuse. If you need fast V4 discovery, use an
> **origin-restricted** key (locked to your domain in your RPC provider's dashboard) **or** a
> **read proxy you run** (set `VITE_BASE_RPC_URL` to your proxy, which holds the real key
> server-side). Never ship an unrestricted key.

### 3.3 Operator identity

```bash
# Your OWN origin — substituted into index.html OG/Twitter tags at build time (%VITE_SITE_URL%).
# Unset → relative tags (og:url="/", og:image="/og.png"). NEVER point at anyone else's property.
VITE_SITE_URL=https://your-origin.example

# OPTIONAL "Visit $SYMBOL" partner/trading-venue CTA on Token pages.
# Unset → no CTA renders. This package anoints no canonical venue.
VITE_PARTNER_APP_URL=
```

`VITE_SITE_URL` is replaced into `index.html` at build time by Vite's native HTML env
substitution (no plugin). Unset → empty string → relative OG URLs. (`robots.txt` and
`sitemap.xml` are **not** auto-rewritten — you regenerate those manually with your origin before
publishing; see §6.4.)

### 3.4 The interface-kickback tag

```bash
# OPTIONAL. Empty default is LOAD-BEARING: unset → address(0) → the 555bps interface slice is
# not carved and stays in the remainder (creator share + holders). There is NO default recipient
# anywhere, by design — never add one.
VITE_INTERFACE_TAG_ADDRESS=
```

- **Unset (the default)** → `INTERFACE_TAG_ADDRESS` is `null` → the encoder writes `address(0)`
  into the `frontend` slot of hookData → the protocol's `INTERFACE_SHARE_BPS` (555 bps) slice is
  **not carved** and stays in the non-burn remainder, flowing to the creator share + holders. You
  receive nothing, and you take nothing from flow you did not originate.
- **Set to your address** → your interface becomes a **protocol-fee recipient**: it receives the
  protocol's `INTERFACE_SHARE_BPS` (555 bps) slice of the *non-burn remainder* (`afterBurn`) on
  mint/redeem flows your interface originates (carved off `afterBurn` — never added on top of what
  the user pays, never from the PRISM burn). The interface slice is **per-TX / conditional** — it
  is carved only when a tagged frontend rode the call. The `FeePanel` discloses this to users
  automatically ("Disclosure, not promotion"). See `01-BUSINESS.md` for the economics and
  `02-TECHNICAL.md` for the waterfall.

> **Validated at module load.** A malformed value throws `Misconfigured build:
> VITE_INTERFACE_TAG_ADDRESS is not a valid address (...)` during `vite build` / dev startup — a
> typo'd fee recipient can never reach a transaction. **Receiving a kickback makes you a
> protocol-fee recipient — decide for yourself whether you want that.**

### 3.4a The launcher address (per-basket)

```bash
# OPTIONAL. Empty default is LOAD-BEARING: unset → address(0) → no launcher slice is carved
# (the 555bps stays in the remainder, flowing to creator share + holders). There is NO
# default recipient anywhere, by design — never add one.
VITE_LAUNCHER_ADDRESS=
```

- **Unset (the default)** → `LAUNCHER_ADDRESS` is `null` → the basket is deployed with
  `launcher = address(0)` → the protocol's `LAUNCHER_SHARE_BPS` (555 bps) slice is **not carved**
  and stays in the non-burn remainder, flowing to the creator share + holders.
- **Set to your address** → the launcher is named **once at deploy** and baked into the basket's
  `FeeConfig` (it is **per-basket**, not per-TX, and **never a creator dial**). When present, it
  receives the `LAUNCHER_SHARE_BPS` (555 bps) slice of the same `afterBurn` the interface slice is
  carved from (the two cuts do **not** compound — both carve off the same `afterBurn`). This is an
  **operator-injected** role.

> **Same consideration as the interface tag.** Naming a launcher makes that address a protocol-fee
> recipient on every flow through the basket — decide for yourself whether you want that. There is
> no default; leaving it empty is a complete, honest build.

### 3.4b The swap router (required only for live buy/sell)

```bash
# OPTIONAL for browse/launch; REQUIRED for live buy/sell. Empty default → buy/sell renders
# preview-only even with VITE_ENABLE_TRADING=true. NO default may ship here.
VITE_SWAP_ROUTER_ADDRESS=
```

**Why a router exists at all.** A Spectrum basket is its own Uniswap V4 hook + liquidity; there is
**no buy/sell function on the basket**. A trade is an external V4 `PoolManager.swap` into the
basket's hook, and the hook **hard-reverts** unless the swap carries the FE-encoded
`(minOut, legMins[], frontend)` payload (one non-zero minimum per constituent + your interface tag).
Consequences you must internalize:

- **A generic DEX aggregator (0x / 1inch / Uniswap routing API / Kyber / Odos / Paraswap) cannot
  trade these baskets** — it sends empty hookData and the pool reverts; it can't even quote it. Do
  not attempt to wire one as the buy/sell path. (A *bespoke* aggregator partnership that builds the
  Spectrum payload is the only re-entry, and that is a business decision.)
- **Live buy/sell needs a small swap router you deploy yourself** — the "Launch-Kit
  router" pattern. It calls `PoolManager.unlock`, runs the swap on the basket's self-pool, settles
  USDC / takes the basket token (and the reverse for a sell), and forwards the FE's hookData
  verbatim. This repo authors the reference FE binding but **never deploys a router**, and ships no
  address.

**What's wired today.** The FE binds a DRAFT entrypoint
`swapExactIn(basket, tokenIn, amountIn, minOut, hookData, to)` (`use-basket-swap.ts` + `swapRouterAbi`),
does an **exact-amount** ERC-20 approve to the router on the first trade per token (never infinite),
and broadcasts with the same simulate→sign→confirm flow as the deploy/flush surfaces. Buy/sell is
**hidden by default** behind its own `VITE_ENABLE_SWAP` flag (no `/swap` route, no nav link, no Token
trade panel until on), and the broadcast hard-checks that flag AND stays inert until
`VITE_SWAP_ROUTER_ADDRESS` is set (flag on + no router → preview-only). See the step-by-step in
`OPERATORS.md → "Buy/sell: the router, verifying it, scoping it off"`.

> **Bind the DRAFT before flipping `VITE_ENABLE_SWAP`.** The router's exact call/unlock-execute
> shape + the USDC approve target are **not yet final**. Freeze
> `swapRouterAbi` against your deployed router before arming `VITE_ENABLE_SWAP`.

### 3.5 Creator metadata host (optional — enables creator X profiles + version lineage)

```sh
# OPTIONAL. Base URL of a host that SERVES creator-published, deployer-signed basket
# metadata. The FE fetches `${base}/<chainId>/<basket>.json`, verifies the EIP-712
# signature against the basket's on-chain deployer, then renders the handle/avatar/
# banner + version `supersedes` (identity pointers only; no long-form prose). Unset → no metadata fetched → baskets show the
# deployer address (honest fallback). You serve signed content; you NEVER author it.
VITE_METADATA_BASE_URL=
# OPTIONAL. IPFS gateway used to resolve ipfs:// avatar/banner refs inside metadata.
# Unset → ipfs:// dropped; https:// images always work.
VITE_IPFS_GATEWAY_URL=
# OPTIONAL. Write-relay base URL. The creator's post-deploy publish ceremony POSTs the
# signed blob to `${base}/<chainId>/<basket>.json`. Unset → the ceremony only offers
# download + this-browser localStorage (no one-click submit). See the relay contract below.
VITE_METADATA_WRITE_URL=
```

This is the "metadata host / pinner" role (`01-BUSINESS.md §4.1`). Two things ride this one channel:
the **creator X profile** (surfaced on the basket page, the creator profile, and cards) and **basket
versioning** (the `supersedes` lineage that powers the version strip / diff / "newer version
available" upgrade). Both are deployer-signed and signature-verified client-side — there is no
platform store and **no on-chain version pointer**. The migrate-to-new-
version transaction is **inert** in this package (preview only) and rides `VITE_ENABLE_TRADING` plus a
migration router that is not deployed yet; the "New version" creator action rides `VITE_ENABLE_DEPLOY`
and is shown only to a basket's own deployer. Leaving these unset is a complete, honest build — every
basket simply attributes to its on-chain deployer address.

**The publish side (how a signed blob gets created and placed).** `VITE_METADATA_BASE_URL` is the
*read* host; the creator still needs a way to *produce* the signed blob and place it there. The FE now
ships the **publish ceremony** (`02-TECHNICAL.md §4.5`): right after a basket deploys, the creator
signs the blob in their own wallet and it persists down a ladder — **(1)** a one-click POST to your
optional **write-relay** (`VITE_METADATA_WRITE_URL`), **(2)** a **download** of the signed JSON with
the exact convention path to place it at, and **(3)** **this-browser localStorage** always, so the
creator sees their own profile/version immediately even before it is hosted anywhere. If you run a
write-relay, its contract is narrow and load-bearing: it accepts the POSTed blob, **re-verifies the
EIP-712 signature against `factory.tokens(basket)` server-side, refuses anything that fails**, and
persists it at `<chainId>/<basket>.json`. It holds **no signing key**, authors nothing, and lists/ranks
nothing (that would edge toward a curated store). A hostile or broken relay can only deny, never
forge. With no relay configured, download + self-host (or a manual submission to your host) is the
complete path.

---

## 4. CONNECT & VERIFY ON-CHAIN

Before you build anything public, prove the frontend is pointed at the *right*, *verified*
contracts and that reads return real data. Do this in dev against your filled config.

### 4.1 Confirm the FE is pointed at the right factory, and reads return real data

```bash
# Configure (real factory + usdc for Base), then run dev and open the app.
pnpm dev --port 4022 --strictPort
```

Acceptance checks (all in the browser):

- [ ] **Home / Explore** enumerate real baskets (or show the honest empty state — see below).
      The list is built from the factory's `allBasketsLength()` + `allBaskets(i)` enumeration —
      a keyless read, no log scan. The mock fixture is **gone** the moment a real factory is
      configured.
- [ ] **A Token page** (`/token?addr=0x…&chain=8453`) shows a NAV price and a NAV-source label.
      `exchangeRate()` → `navSource = "onchain"` is the healthy case; `reconstructed` means the
      static views were unavailable and the FE fell back to a DexScreener reconstruction.
- [ ] **The FeePanel** on a Token page shows the per-basket fee rate, the fixed PRISM burn,
      the creator share, the holder floor, and the conditional launcher / interface slices — all
      read from the basket on-chain (the FE hardcodes no fee number).
- [ ] **The Token page surfaces the contract chip + explorer link** and the note that *every
      operation works by direct contract access, including `redeemInKind`* — the unconditional,
      pro-rata, no-minimums in-kind exit that works even if every pool is dead. **Redemption can
      never be blocked.** Note: today this is a **documented direct-contract-access path, not a
      dedicated UI button** (no FE wiring is built into the trading components yet — see
      `02-TECHNICAL.md` §3.3). So QA verifies the *contract chip / explorer link + the note*
      render, **not** an in-app redeem button.
- [ ] **Creator pages** (`/creator/0x…`) attribute baskets to their on-chain deployer.

> **Empty marketplace = correct.** If the factory has launched no baskets yet, Home/Explore say
> so ("No baskets launched yet on this network… enumerated straight from the factory contract").
> That is **correct behavior on a fresh deployment, not a bug.** Do not "fix" it by adding seed
> lists.

### 4.2 Verify the contract source matches and the addresses match `ADDRESSES.md`

The trust model is "anyone can read the chain," so the chain must be readable. Verify it yourself.

- [ ] Every contract in the lineage (factory, code providers, the bootstrap basket) has its
      published source matching its deployed bytecode on the block explorer (Basescan for Base,
      Etherscan for mainnet).
- [ ] The `factory` / `usdc` / `poolManager` / `weth` addresses you configured **match the
      values in the deploying party's `ADDRESSES.md`** exactly (and re-verify that file's values
      on-chain yourself).
- [ ] `usdc` matches **Circle's published canonical Base USDC** address (do not trust any
      restatement — verify against Circle).

If a contract's published source does not match its bytecode, verify on-chain yourself before you
trust the lineage.

### 4.3 Sanity-check the kickback tag rides in `hookData`

Only relevant if you set `VITE_INTERFACE_TAG_ADDRESS`. The tag rides in the `frontend` slot of
the mint/redeem `hookData` and triggers the FeePanel disclosure. To confirm without broadcasting:

- [ ] On a Token page with `SWAP` enabled in a **local** build, open the TradePanel and the
      per-leg minimums preview. The `frontend` address surfaced in the encoded `hookData` should
      equal your configured tag (or `address(0)` if unset). With `SWAP` off, confirm the TradePanel
      and the `/swap` route do **not** render (hidden by default).
- [ ] The FeePanel renders the kickback disclosure line ("This interface receives X% of the
      non-burn fee remainder…") only when your tag is set and the protocol's interface-share
      constant reads non-null.

> **Never add a slippage bypass.** The hookData encoder always derives per-leg minimums from live
> per-leg quotes and **throws** rather than encode a zero/empty path. There is no "disable
> slippage" toggle and you must never add one. (State this affirmatively: V2 derives per-leg
> minimums from live quotes on every mint/redeem; there is no zero/empty-slippage path.)

---

## 5. CHOOSE YOUR SURFACE / BUILD

Three independent build-time flags, all OFF by default (the shipped build is information /
analytics only). Each reads only its own env var; truthiness is strict `=== 'true'` (anything
else, including empty, is off). You produce **one static artifact per surface** — these are
separate builds, not runtime toggles.

| Flag | Env var | Controls |
|---|---|---|
| `WALLET_ENABLED` | `VITE_ENABLE_WALLET` | Connect-wallet button + read-only wallet views (Portfolio). |
| `DEPLOY_ENABLED` | `VITE_ENABLE_DEPLOY` | The launch flow's on-chain **broadcast**. Salt mining, auction-price reads, and the dry-run simulation are read-only and run regardless of this flag. |
| `TRADING_ENABLED` | `VITE_ENABLE_TRADING` | The Flush **fee console** — holder fee-claim + the permissionless cranks. Off by default. Does **not** include buy/sell. |
| `SWAP_ENABLED` | `VITE_ENABLE_SWAP` | **Buy/sell** — the `/swap` page + the Token TradePanel. **Hidden by default**; also needs a deployed `VITE_SWAP_ROUTER_ADDRESS` (else preview-only). **Highest-risk surface; last to flip; needs your own router.** |

### The three intended artifacts

| Tier | Flags | What you build | Notes |
|---|---|---|---|
| **Info-only / analytics** | all off | Read-only directory, Token/NAV/fee/holdings pages, creator profiles. No wallet. | The shipped default; no transactional surface. |
| **Creation tool** | `WALLET=true` + `DEPLOY=true` | The above + the basket builder can broadcast a launch. The deployer is always the connected user signing for themselves. | Keep the deployer-is-issuer acknowledgment step. |
| **Fee console** | `WALLET=true` + `TRADING=true` | The above + the `/flush` fee console (holder claim + the permissionless cranks). No buy/sell. | Transactional. |
| **Marketplace with buy/sell** | `WALLET=true` + `SWAP=true` + a deployed `VITE_SWAP_ROUTER_ADDRESS` (usually + `TRADING=true`) | The above + buy/sell on `/swap` and the Token page. | Highest-risk surface; you must deploy your own swap router. |

> You *can* combine flags in one build (any transactional flag requires `WALLET`), but the
> single-purpose artifacts above are the intended shapes — one build decision per artifact. Buy/sell
> is the only one that also needs an extra deployed contract (the swap router), which is why it has
> its own flag and ships hidden.

### Build commands

```bash
# Info-only (the default — set nothing):
pnpm build

# Creation tool:
VITE_ENABLE_WALLET=true VITE_ENABLE_DEPLOY=true pnpm build
# (or put these in .env.local / .env.production and run pnpm build)

# Fee console (claim + cranks; no buy/sell):
VITE_ENABLE_WALLET=true VITE_ENABLE_TRADING=true pnpm build

# Marketplace with buy/sell (needs your deployed router — see OPERATORS.md):
VITE_ENABLE_WALLET=true VITE_ENABLE_SWAP=true VITE_SWAP_ROUTER_ADDRESS=0xYourRouter pnpm build
```

`pnpm build` runs `tsc -b && vite build` — it typechecks (strict, no-unused) **then** bundles
into `dist/`. Dead code or a type error fails the build here.

### Confirm the fail-fast invariant

A transactional surface without a wallet is a **misconfigured** build, not a degraded one. If you
set `DEPLOY` or `TRADING` true while `WALLET` is off, `features.ts` throws at **module load**:

```
Misconfigured build: VITE_ENABLE_DEPLOY / VITE_ENABLE_TRADING require VITE_ENABLE_WALLET=true.
```

In the app itself this is a **runtime guard, not a build-time check** — a top-level `throw` that
fires the instant the bundle is evaluated. `vite build` only *bundles* the modules (it never
executes the app graph), so calling the bundler **directly** on a misconfigured combo still exits
0; the throw would only fire when the app **loads** (browser / `pnpm dev` / `pnpm preview`).

The `prebuild` config check closes that gap for the normal path: `pnpm build` runs
`scripts/check-config.mjs` first, which checks the **same** flag-without-wallet invariant and
**fails the build (exit 1) before bundling**. So the misconfig is now caught at build time on the
`build` script; only a direct `vite build` (which skips the check) reaches the load-time-only behavior.

```bash
# 1) The misconfigured build is now BLOCKED by the prebuild check (exit 1, nothing bundled):
VITE_ENABLE_DEPLOY=true pnpm build       # ✗ check:config fails — fix it, or `vite build` to bypass

# 2) Bypassing the check, then loading it, still shows the throw (the app's own guard):
VITE_ENABLE_DEPLOY=true vite build       # exits 0 (check skipped)
VITE_ENABLE_DEPLOY=true pnpm dev         # → blank page + "Misconfigured build…" in the console
```

Because the guard is a load-time throw, your go-live QA (§7) **must open the actually-served build
and confirm there is no module-load error in the console** — that is the step that catches a flag
misconfiguration before users do.

A second guard backs the deploy path at runtime: `broadcast()` re-checks `DEPLOY_ENABLED` and
returns an error (`Basket deploy is disabled on this build (set VITE_ENABLE_DEPLOY).`) regardless
of UI state. Both guards are load-bearing; keep them through every refactor.

> **Bundle note.** When `WALLET` is off, only the lightweight `injected()` connector ships — the
> heavy Coinbase + WalletConnect SDKs tree-shake out of the build. WalletConnect is only
> added when `WALLET=true` **and** `VITE_WALLETCONNECT_PROJECT_ID` is set.

---

## 6. HOST

The build is a fully static SPA with **`base: './'`** (relative asset URLs), so it works under
any gateway path without modification. **Do not change `base` to an absolute path** — it is
load-bearing for IPFS hosting.

### 6.1 IPFS / ENS canonical pattern

```bash
pnpm build      # produces dist/
# Pin dist/ to IPFS (any pinning service or your own node), e.g.:
ipfs add -r dist/
# → note the root CID, then point an ENS name's contenthash at ipfs://<CID>.
```

Two things to get right for IPFS:

1. **Gateway-relative base** is already set (`base: './'`), so assets resolve under
   `https://<gateway>/ipfs/<CID>/`.
2. **SPA fallback.** Routing is client-side (BrowserRouter history), so deep links
   (`/explore`, `/token?addr=…`, `/creator/0x…`) need a catch-all rewrite to `index.html`.
   On a plain IPFS gateway this is the one rough edge: a hard-load of a deep path can 404 on
   gateways that do not serve `index.html` for unknown paths. Mitigations: serve behind a gateway
   / CDN that rewrites unknown paths to `index.html`, or use a host that supports SPA fallback
   natively (below). Clean per-route HTML for IPFS is a deploy-time concern, not a build-config
   one.

### 6.2 Alternatives

Any static host works (`dist/` is just files):

- **Netlify / Vercel / Cloudflare Pages** — add an SPA rewrite (`/* → /index.html`, 200) so deep
  links resolve. These give you SPA fallback, a CDN, and a place to put edge controls (§6.5).
- **S3 + CloudFront / any object store + CDN** — set the error document to `index.html` for SPA
  fallback.
- **Your own nginx/Caddy** — `try_files $uri /index.html;`.

### 6.3 Prune dev/prototype artifacts before publishing

- `public/proto/bg.html` is a **CDN-dependent design prototype** (loads three.js + fonts from
  external CDNs). It ships in `public/` and will be in `dist/` unless you remove it. It is not
  part of the app runtime — prune it before you publish.

### 6.4 Regenerate `robots.txt` and `sitemap.xml` with your origin

These ship as origin-less stubs and are **not** rewritten by the build:

- `public/robots.txt` — add your absolute `Sitemap:` URL.
- `public/sitemap.xml` — an empty `<urlset>` stub. Regenerate it with your origin and the
  documented routes: `/ /explore /launch /faq /learn /docs /terms /privacy /risk`.

> **Per-basket OG cards** need prerendering (a SPA limitation) — shared links show this single
> site card unless you add your own prerender step. That is your call.

### 6.5 The honest limitation: a static site has no server-side access control

There is **no server** in this package. A static IPFS/ENS site **cannot enforce any server-side
access controls**. If your situation (especially a `TRADING` build) requires access controls,
those are **edge/CDN-layer controls outside this repo** — and whether they are sufficient is
**your decision**, not something this package can provide or verify. The
package neither implements nor endorses any such control.

### 6.6 Third-party runtime hosts (for a fully self-contained / strict-CSP deploy)

Pruning `proto/bg.html` (§6.3) is not the whole story. If your goal is an air-gapped,
fully-on-IPFS, or strict-`Content-Security-Policy` deploy, know that **two third-party hosts are
reached at runtime by the app itself**, both of which **degrade gracefully** rather than break:

| Host | What hits it | Degrades to (if blocked / offline) |
|---|---|---|
| `fonts.googleapis.com` / `fonts.gstatic.com` | `index.html` `<link>`-loads the Google Fonts (Chakra Petch, JetBrains Mono, Space Grotesk) | System font stack — fully functional, just un-branded |
| `dd.dexscreener.com` (token icons) and `api.dexscreener.com` (asset pricing / pool-liquidity / NAV-reconstruction data) | `AssetLogo`, holdings/pool views, and the NAV-reconstruction fallback fetch from DexScreener | Hashed-hue initials for logos; on-chain reads remain the primary data path |

If you want true self-containment or a tight CSP, **self-hosting the fonts** (drop them in
`public/` and swap the `index.html` `<link>` for a local `@font-face`) and **proxying the
DexScreener data calls** through an endpoint you control are your optional hardening steps —
both are deploy-time changes, neither is required for the app to run. See
**`02-TECHNICAL.md` §7 (Known technical constraints), item 9** for the full inventory of
external runtime dependencies (DexScreener and the history price feeds).

---

## 7. GO-LIVE QA

Run the smoke tests for **your** tier against a production build (`pnpm build` then `pnpm
preview`, or your staged deploy). Then sign the no-bug acceptance checklist before public launch.

### 7.1 Info-only / analytics (all tiers run this baseline)

- [ ] Home and Explore enumerate real baskets from the factory (or show the honest empty state).
- [ ] Search / chain-filter / sort (TVL / 24h / name) work; sorts are objective-metric only (no
      featured lists, no platform taglines).
- [ ] A Token page shows NAV, NAV-source label, the chart, BasketStats, holdings, and the
      FeePanel. The `>2%` NAV-divergence warning surfaces when on-chain and reconstructed NAV
      diverge.
- [ ] FeePanel rows — fee rate, fixed PRISM burn, creator share, holder floor, and the
      conditional launcher / interface slices — match the basket's on-chain config (spot-check one
      against the explorer).
- [ ] Creator pages attribute to the on-chain deployer.
- [ ] **Empty-state correctness:** on a basket-less factory, the empty copy reads honestly. On a
      missing `?addr`, the Token page shows a Notice, not a crash.
- [ ] No console errors on load; the WebGL background degrades to nothing under
      `prefers-reduced-motion` and on weak GPUs (the page is fully functional without it).

### 7.2 Wallet (add when `WALLET=true`)

- [ ] Connect with an injected wallet; the button shows a shortened address; disconnect works.
- [ ] Portfolio (`/portfolio`) lists held baskets (balance × NAV) and created baskets
      (deployer-matched). A direct `/portfolio` URL on a **non-wallet** build redirects home.
- [ ] If you set `VITE_WALLETCONNECT_PROJECT_ID`, the WalletConnect connector appears.

### 7.3 Deploy / creation tool (add when `DEPLOY=true`)

- [ ] **Dry-run / simulate without broadcast:** walk the full 6-step builder. Confirm salt mining
      runs (`HookForge` shows a live probe count and locks onto a real `0x88`-tailed address), the
      live Dutch-auction price reads, and the deploy **simulates** (`simulateContract` dry-run)
      — all **without** any signature.
- [ ] The deployer self-attestation checkbox must be checked before the launch CTA enables (the
      acknowledgment is re-checked every session, never persisted).
- [ ] **Then** broadcast a real deploy **on a testnet, or with extreme care on mainnet** (it
      costs ETH and is irreversible). Confirm it lands on `/token?addr=…&deployed=1` with the
      celebratory banner and that the new basket enumerates in Explore.
- [ ] The per-leg liquidity warnings and the "V4 venues were not scanned" amber alert behave
      (the latter appears only on a keyless build — see §9).

### 7.4 Trading (add when `TRADING=true`)

- [ ] **Buy/sell on a testnet or with extreme care.** Confirm the TradePanel renders on Token
      pages, the fee math uses the on-chain fee (not a hardcoded number), and the per-leg minimums
      preview mirrors what `hook-data.ts` encodes at sign time.
- [ ] **Slippage controls:** presets (0.5% / 1%), custom field clamps to `[1, 500]` bps (5% hard
      cap), warn banner above 2%. Confirm there is **no** "disable slippage" toggle and no
      zero/empty-leg path (the encoder throws without live quotes — verify it refuses rather than
      degrades).
- [ ] **Fee disclosure correctness:** the FeePanel kickback line appears only when your tag is
      set; the disclosed interface-share % matches the on-chain `INTERFACE_SHARE_BPS`.
- [ ] **In-kind exit is reachable — by contract, not by button.** The unconditional
      `redeemInKind` exit (pro-rata constituents-out, no minimums, works even with every pool
      dead) has **no dedicated FE button in the trading components today**. QA confirms the
      Token page surfaces the contract chip / explorer link + the "works by direct contract
      access incl. `redeemInKind`" note (§4.1), and does **not** look for a redeem UI. The trust
      property holds affirmatively: **redemption can never be blocked.**
- [ ] Flush page renders behind `TRADING` (currently a stub — confirm it does not present anyone
      as a sole/scheduled keeper; cranks are permissionless).

### 7.5 The no-bug acceptance checklist (operator sign-off)

Do not flip a public launch until you can truthfully sign **all** of:

- [ ] §4 on-chain verification passed: FE points at the right factory; every contract's published
      source matches its deployed bytecode; addresses match `ADDRESSES.md` and `usdc` matches Circle.
- [ ] The §5 build for my tier compiles clean (`tsc -b && vite build` green) and the fail-fast
      invariant fires when I deliberately misconfigure it.
- [ ] My tier's §7 smoke checklist is fully green on a production build (not just dev).
- [ ] My legal pages (`/terms`, `/privacy`, `/risk`) and the footer disclaimer are **my own
      finalized copy**, not the shipped placeholders.
- [ ] No console errors; empty states read honestly; no seed/curated/featured content was added;
      no address or default recipient appears anywhere; the kickback default is empty
      unless I deliberately set my own tag.
- [ ] I have not weakened any slippage guard, added a zero-legMins path, or hardcoded a fee.
- [ ] If I repeat any PRISM burn claim, it is phrased as **wired/in-flight** and I have verified
      lifetime burns on-chain (do not claim baskets "burn" as a present fact).

---

## 8. OPERATIONS & MAINTENANCE

### 8.1 RPC monitoring

- Watch your RPC for rate-limiting. Symptoms surface in the UI as error notices that suggest an
  origin-restricted key / read proxy. If you run an origin-restricted Alchemy key or a proxy,
  monitor its quota and rotate as needed (a leaked public key in the bundle can be abused — see
  §3.2).
- The app is keyless-first; if your key/proxy fails, reads fall back to the public node (slower,
  narrower V4 discovery) rather than going dark.

### 8.2 Re-pinning (IPFS)

- Each `pnpm build` produces a new CID. Re-pin `dist/` and update your ENS `contenthash` to the
  new CID on every release. Keep prior CIDs pinned long enough that cached links resolve, or
  garbage-collect deliberately.

### 8.3 Address-book updates when a new factory generation ships

When the deploying party ships a **new factory generation** (e.g. the forward-looking changes —
a raised fee floor, or an in-kind mint path — described in `01-BUSINESS.md`):

- Update `deployments.json` (or your `VITE_*` overrides) to the new factory address and re-run
  §4 verification (source-matches-bytecode, `ADDRESSES.md` match) before pointing your public build at it.
- **Salt-remine implication.** Any change to a compile-time contract constant changes the
  bytecode → new init-code hash → **every mined hook salt is invalidated.** The frontend's
  in-browser salt miner reads the oracle from the live factory (`predictTokenAddress`), so it
  automatically targets whatever factory you configure — but a **creation-tool** build must be
  pointed at the **new** factory for new deploys to mine valid salts. Old baskets are not
  retrofitted; a new generation is a parallel lineage, not an upgrade.

### 8.4 Running cranks (optional keeper role)

Each basket exposes permissionless cranks — anyone may call them, and the burn leg pays the
caller an immutable `CRANK_BOUNTY_BPS` bounty deducted from the flushed amount (spec default
0.5% / 50 bps; the deployed value is fixed forever — **read `CRANK_BOUNTY_BPS()` from the
bytecode**, do not assume):

| Crank | What it settles |
|---|---|
| `flushPrismBurn(minEthOut)` | Sweeps the accrued burn-leg USDC, swaps to ETH (slippage-guarded by your `minEthOut`), and bridges it toward the L1 PrismBurner. Fires only once the accrued amount clears a configured threshold. |
| `flushFrontendFees(fe)` | Pays out the accrued pull-fees that all accrue into `pendingFrontendFees` — the **interface** (kickback), the **launcher**, and the **creator** cuts. If you set a kickback tag, this is how you collect **your own** accrued interface fees — call it with your tag address. |
| `claimFees()` | The **holder pull** — settles each holder's accrued (quarantined) fee share. |
| `redeemClaims()` | Settles **parked / queued pro-rata redeem claims** — the lazy-burn path that finalizes pending in-kind redemptions against the dead pool. This is part of why **redemption is always reachable**: claims accrue and any caller can settle them. |

Operational notes:

- **Anyone may run the keeper; never present yourself as the sole or scheduled keeper** (the
  no-keys doctrine — the role's value is precisely that it is nobody's job). If one keeper stops,
  the next caller collects the same bounty.
- **No FE crank wiring exists in these components yet** (the contract surface is real, but there
  is no button in this UI for any of these cranks). A keeper today is a **script you run** against
  the deployed bytecode, not an in-app action.
- The PRISM burn leg specifically is **wired and in-flight, not a realised fact** (zero lifetime
  burns so far). The 10% PRISM burn share is the wired fee sink; the L1 `flush()` continuation
  completes the burn. Verify lifetime burns on-chain before repeating any burn claim.

---

## 9. TROUBLESHOOTING

| Symptom | Cause | What to do |
|---|---|---|
| **`Misconfigured build: VITE_ENABLE_DEPLOY / VITE_ENABLE_TRADING require VITE_ENABLE_WALLET=true.`** at build/dev start | You set `DEPLOY` or `TRADING` true without `WALLET`. This is the **fail-fast invariant**, working as designed. | Set `VITE_ENABLE_WALLET=true`, or unset the transactional flag. A transactional surface with no wallet is misconfigured, not degraded. |
| **`Misconfigured build: VITE_INTERFACE_TAG_ADDRESS is not a valid address (...)`** at build/dev start | Typo in your kickback tag. Validated at module load so a bad fee recipient never reaches a tx. | Fix the address, or leave it empty (empty → `address(0)` → the 555bps interface slice is not carved and stays in the remainder: creator share + holders). |
| **Empty marketplace** — Home/Explore show "No baskets launched yet…" | Either no factory configured, **or** a real factory with zero baskets. | **Not a bug.** On a fresh deployment this is correct. If you expected baskets: confirm `factory`/`usdc` are filled and verified (§4). The dev mock fixture only appears with **no** factory configured, in **dev** only. |
| **"V4 venues were not scanned on this build (keyless RPC)"** amber alert in the launch builder | No `VITE_ALCHEMY_API_KEY` (or custom RPC) — public RPCs cap the wide filtered `getLogs` V4 discovery needs. | Expected on a keyless build. Set an **origin-restricted** key or a read proxy to restore full V4 coverage (§3.2). The depth ranking the creator is trusting may be missing whole V4 venues until then. |
| **Deploy CTA inert** — `Basket deploy is disabled on this build (set VITE_ENABLE_DEPLOY).` | `DEPLOY_ENABLED` is false; the hard runtime guard in `broadcast()` is firing. The mined hook address and auction price shown are still **real** (mined + read live), not a mock. | Build with `VITE_ENABLE_WALLET=true VITE_ENABLE_DEPLOY=true` if you intend a creation tool. |
| **TradePanel / `/swap` missing** | `SWAP_ENABLED` false (the default — buy/sell is hidden). The page is fully usable for read/analytics without it. | Build with `VITE_ENABLE_WALLET=true VITE_ENABLE_SWAP=true` + a deployed `VITE_SWAP_ROUTER_ADDRESS` if you intend a buy/sell surface (router first). |
| **Buy/sell shows "Preview only" even with `SWAP` on** | No `VITE_SWAP_ROUTER_ADDRESS` configured — the panel renders but can't broadcast. | Deploy your swap router and set `VITE_SWAP_ROUTER_ADDRESS` (see OPERATORS.md → "Buy/sell: the router, verifying it, scoping it off"). |
| **NAV-divergence warning (>2%)** on a Token page | On-chain NAV (`exchangeRate`) and the DexScreener reconstruction diverge by more than 2%. | A surfaced data-quality signal, not a crash. Investigate whether a constituent is thinly/oddly priced; the on-chain view is the primary mark. |
| **Not sure your config is right before building** | No quick way to know if addresses/flags are wired correctly without loading the app. | Run `pnpm check:config` — it reports your build tier and flags malformed/typo'd addresses, a transactional flag without `WALLET`, `SWAP` with no router, a chain activated with no factory, a missing `VITE_SITE_URL`, and a stub sitemap. (The old broken `bake:colors` baker was removed; the runtime hashed-hue fallback colors every token.) |
| **Deep links 404 on an IPFS gateway** | Client-side BrowserRouter routing with no SPA fallback rewrite. | Serve behind a gateway/CDN/host that rewrites unknown paths to `index.html` (§6.1/§6.2). |
| **RPC rate-limit error notices** in the UI | Public RPC throttling under load. | Set an origin-restricted key or a read proxy (§3.2). Reads fall back to the public node rather than going dark. |
| **OG/social card shows no image or wrong origin** | `VITE_SITE_URL` unset → relative OG URLs; `sitemap.xml`/`robots.txt` not regenerated. | Set `VITE_SITE_URL` to your origin (§3.3) and regenerate the sitemap/robots stubs with your origin (§6.4). |

---

## Appendix — quick command reference

```bash
# Install + dev
pnpm install
pnpm dev --port 4022 --strictPort

# Configure + validate
pnpm init:env             # copy .env.example → .env.local
pnpm check:config         # validate .env.local + deployments.json (also runs as a prebuild check)

# Builds (one artifact per surface)
pnpm build                                                   # info-only (default)
VITE_ENABLE_WALLET=true VITE_ENABLE_DEPLOY=true  pnpm build  # creation tool
VITE_ENABLE_WALLET=true VITE_ENABLE_TRADING=true pnpm build  # marketplace + trading

# Verify + preview
pnpm typecheck            # tsc -b only
pnpm preview              # serve dist/ locally for a final look
```

> Commands show `pnpm`; `npm run …` / `yarn …` work identically (§1.2).

**Cross-references:** product/economics → `01-BUSINESS.md`; architecture, the contract-integration
surface, every env knob and known constraint → `02-TECHNICAL.md`; index/status/partition →
`README.md`. The operator's sources of truth are the contracts, `ADDRESSES.md`, on-chain data,
and this handover set — never any internal/privileged document.

*This is software, not advice. You are responsible for whatever transactional surface you stand up.*
