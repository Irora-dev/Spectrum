# 01 — BUSINESS

**Spectrum V2 frontend · operator handover · the business standpoint**

---

> **This is software, not advice.** This document is informational only. The choices in this
> document are yours to make and yours to own as an independent operator. Verify everything on-chain
> yourself before operating any surface that lets a user sign a transaction.

---

## How to read this document

This is the **business** doc in a handover set. Read it to decide **whether and how** you want to
run this frontend as your own business. Then:

| Doc | What it is | When you need it |
|---|---|---|
| `README.md` | Index, reading order, status banner, doc map | First — orientation |
| **`01-BUSINESS.md`** (this doc) | The product as a business, the feature catalog from a value lens, your roles, your economics, risks, precedents, the fork/configure/host and crank runbook in business terms | To decide if the business makes sense for you |
| `02-TECHNICAL.md` | Architecture, per-feature tech specs, contract-integration surface, config/flags/env, build, RPC, perf, a11y, known constraints | When you start building |
| `03-IMPLEMENTATION.md` | Step-by-step go-live runbook: setup → configure → connect → build → host → QA → operate | When you go live |

This doc is the single source of truth for someone who was in none of the conversations that
produced this software. It assumes you are a technically capable web3 operator who can run a
React/Vite build and reads wagmi/viem/EVM fluently.

**One audience note, up front.** You don't apply, register, or ask anyone for permission to run any
of this. You pick a role, run it, and (where applicable) the protocol pays you. There is no central
team behind the product. The author of this software designed the package, operates nothing,
holds no keys, pays/endorses/recruits no one, and is not your counterparty, partner, or principal.
**If anyone claims to speak for "the Spectrum team," be skeptical: there isn't one.**

---

## 1. Executive summary

### 1.1 What Spectrum V2 is, as a product

Spectrum V2 is a **permissionless on-chain basket primitive**. A "basket" is a single ERC-20 token
that holds a fixed set of underlying crypto assets at fixed weights, fully collateralised by those
assets. It is built on **Uniswap V4 hooks** — each basket token *is its own V4 hook and its own
liquidity pool*, paired against **USDC** on **Base**. USDC is the settlement asset for the whole
system; native ETH enters and exits only through ordinary market pools at the edges.

Practically, a basket behaves like this:

- A **creator** composes a basket once: pick assets, set weights, set an immutable fee
  configuration, name it, and deploy it. After deploy, **nothing about it can be changed** — not
  the assets, not the weights, not the fee. A "new version" is simply a new, separate deployment.
- Anyone can **mint** basket tokens (USDC in, the hook buys the constituents and issues shares) and
  **redeem** them (shares in, USDC or the underlying constituents out). Mints and redeems are
  Uniswap V4 swaps that the basket's own hook prices at the basket's net-asset value (NAV).
- A basket can always be exited **in kind** — `redeemInKind` hands the holder their pro-rata slice
  of the actual underlying tokens, touching no pool and no swap. This path cannot be blocked by any
  code, even if every market for the constituents dies.

There is **no central operator of the protocol**. There is no admin key, no upgrade switch, no
pause, no fee-setter, no registry curator, and no kill switch — from the moment a basket is born.
The product is the contracts plus whatever interface a user happens to load.

> **Terminology, load-bearing.** The product is always a **basket**. It is never an "index," a
> "fund," or an "ETF." The codebase still carries `Index`-era identifiers internally (a v1
> inheritance) — `02-TECHNICAL.md` names some of those symbols verbatim — but in everything a user
> reads, and in everything you publish, it is a basket.

### 1.2 What "running the frontend as your own business" means here

You are receiving a **fully static frontend** — a React 19 / Vite 6 / TypeScript build with no
server runtime — that talks directly to already-deployed, on-chain contracts. Running it as your
business means:

- **You are independent.** There is no central team you report to, no platform you join, no
  contract you sign, and no party who can switch you off. You pick which surfaces to enable, you
  host the build wherever you like (IPFS/ENS or otherwise), and you decide your own go-to-market.
- **You are non-custodial.** The frontend never holds user funds, never holds keys to user funds,
  and never signs on a user's behalf. Every state-changing action is a transaction the **user**
  signs with **their own** wallet. You build and present the transaction; the user authorizes it.
- **There is no central team behind the product, and no relationship with the package's author.**
  The author of this software operates nothing, holds no keys, is not your partner,
  principal, counterparty, or sponsor, and pays, endorses, and recruits no one. There is **no
  default recipient of anything** anywhere in this package, and you will never find one. If you ever
  see an address presented as a "default," treat it as a bug and do not ship it.
- **Your revenue, if any, is on-chain and permissionless.** The contracts pay an *interface
  kickback* to whatever address an interface tags onto the transactions it originates. You set your
  own tag; the bytecode pays you; nobody can revoke it and nobody promised it. **There is no
  registration, allowlist, contract, invoice, or counterparty — the bytecode pays you, nobody can
  revoke it, and nobody can promise you more.** (Section 4.)

You connect this frontend to a deployed contract set that the operator who owns the repo is
responsible for, by filling in an address book.
This document does **not** ask you to deploy the contracts; that is a separate role with its own
runbook. (See `03-IMPLEMENTATION.md` for how you connect, and the status caveats in §7.)

Canonical addresses and deployments live only in **the contracts repo's own `ADDRESSES.md`**,
maintained by the repo's owner and the operators who mirror it. There is no central address
authority. This document deliberately states no addresses — verify everything on-chain yourself.

---

## 2. The product's defining properties — from a business lens

These six properties are not feature decorations. They are the *reasons the business is defensible*.
Each is enforced in immutable bytecode, not by policy you or anyone else administers.

### 2.1 No admin, no keys — from birth

There is no factory owner, no pausing, no upgrading, no fee-setting, no privileged registry, and no
kill switch — not held by the author, not held by the contract developer, **and not held by you**.
Once deployed, nobody — including the deployer, including the author, including whoever wrote the
code — can change, censor, or stop it. A basket has **zero deployer-controlled
selectors over its live state** — not even its creator can change any fee parameter after deploy
(the old one-way `increaseBurnShare` burn ratchet was removed; the PRISM burn is now a fixed
protocol constant, uniform on every basket).

**Why it matters to your business:** you are not exposed to a third party who can change the rules,
revoke your access, alter fees against you, or shut the product off. Equally, *you* hold no such
lever over your users — which is the foundation of the credibly-neutral story you can tell. You are
running an interface to a fixed machine, not operating a platform you control.

### 2.2 Immutable baskets

A basket's assets, weights, and fee configuration are fixed at deploy. There is no rebalancing, no
manager discretion, and no way to mutate a live basket. CREATE2 commits the configuration into the
token's very address (see `02-TECHNICAL.md` on salt mining) — the address itself is a proof of the
basket's birth terms. "Versions" happen by deploying a new basket; each basket's deployer is its
issuer.

**Why it matters to your business:** the thing your users hold cannot be changed against them after
the fact. That is a clean, simple, honest story to tell and to display. It also means your
discovery/analytics surfaces are showing facts that do not silently shift under you.

### 2.3 Redemption is sacred — always reachable

`redeemInKind(amount, legMask, to)` returns the holder's pro-rata constituents directly. It touches
no pool, no PoolManager, no swap, and has no minimum-output dependence on any market. A holder can
also explicitly skip a single frozen or reverting leg via `legMask` without forfeiting the rest. **No
code path can block redemption.** Even if every market for every constituent dies — and whatever
happens to any operator, including you — the in-kind exit still works and users can always exit.

**Why it matters to your business:** "you can always get your assets out" is the single most
important trust property of any holdings product, and here it is mechanical and unconditional. Your
disclosure surfaces should state it affirmatively and frame it precisely — it is a mechanical
contract swap that returns underlying tokens, **never** a "fund redemption right."

### 2.4 Per-basket immutable fees

Each basket carries its **own** fee, set by its creator within protocol bounds and fixed forever.
There is no universal platform fee, and the frontend **hardcodes no fee number anywhere** — every
fee figure you display is read live from the basket's own contract. One documented exception worth
knowing: the in-kind redemption's exit haircut stays in the basket's reserves for remaining holders
— it routes to no one.

**Why it matters to your business:** you never have to maintain a fee table, and you can never
accidentally misstate a fee — the number on screen is the number on chain. It also means your
revenue (the kickback, §4) varies basket by basket, because it is a slice of a number the creator
chose, not a number you or the protocol set.

### 2.5 Creator-as-issuer

The person who deploys a basket is its issuer — not the protocol, not any frontend, not the author,
and not you. The deployer is always the connected user signing for themselves; the creation tool
deploys nothing on anyone's behalf. The frontend makes this explicit: the launch flow requires a
**self-attestation checkbox** — "I'm the creator and issuer of this basket and responsible for my
own legal and marketing obligations" — that gates the deploy button and is deliberately re-checked
every session (never silently remembered).

**Why it matters to your business:** if you run the creation tool, you are a tool that helps a user
issue their own token — not the issuer. Preserving the attestation step and the issuer framing is
load-bearing for that distinction.

### 2.6 Settlement in canonical USDC on Base

The system settles in **canonical Base USDC**. Native ETH enters and exits only through ordinary
market pools at the edges — there is no protocol special path for ETH and no synthetic stable
machinery. The shipped default is **Base-only**; a second chain is one configuration entry away
(see `02-TECHNICAL.md`), but you do not get one for free, and standing one up means accepting that
chain's market context.

**Why it matters to your business:** a single, well-understood settlement asset on a single L2
keeps your operational and pricing surface small and legible, and keeps your hosting and RPC costs
near zero.

---

## 3. The feature catalog — from a business / value lens

This is the feature-by-feature tour. For each feature: **what it does for the user**, and **why it
matters to your business.** Technical specifications for every one of these live in `02-TECHNICAL.md`;
the build-tier mechanics are summarized in §3.0 and detailed in `02-TECHNICAL.md` and `03-IMPLEMENTATION.md`.

### 3.0 The three build tiers (which features you ship)

The whole frontend is one codebase, but it ships as one of **three single-purpose artifacts**,
chosen by three independent build-time flags. **All three flags are OFF by default — the shipped
build is information / analytics only.** This matters to the business because *each flag you turn on
is a separate decision with a separate risk profile.*

| Tier | Flags on | What renders | Risk weight |
|---|---|---|---|
| **Information / analytics** | none (default) | Discovery, basket detail, holdings, fee disclosure, analytics, the launch flow as a read-only preview | Lowest |
| **Creation tool** | `WALLET` + `DEPLOY` | All of the above **plus** the live wallet-connected launch broadcast | Medium |
| **Fee console** | `WALLET` + `TRADING` | All of the above **plus** the `/flush` fee console (holder fee-claim + the permissionless cranks). No buy/sell. | High |
| **Marketplace with buy/sell** | `WALLET` + `SWAP` (+ a deployed swap router; usually + `TRADING`) | All of the above **plus** buy/sell on `/swap` and the Token page | Highest |

A transactional flag without the wallet flag is treated as a **misconfigured build and fails at
build time** — by design, so a transactional surface with no wallet can never silently ship.
Info-only / deploy-only / trading builds are separate static artifacts, so **what you didn't enable
literally isn't in your bundle** — your surface is your bundle. Read `03-IMPLEMENTATION.md` for the
exact env settings per tier.

> **The honest empty state is correct.** On a fresh deployment with no baskets yet launched, your
> discovery surfaces will be **empty**, and they will say so plainly ("No baskets launched yet on
> this network … enumerated straight from the factory contract"). That is correct behavior, not a
> bug. What a deployment shows is chain-derived; what you add is your own act.

---

### 3.1 Discovery — Home & Explore

**What it does for the user.** The front door. `/` (Home) lands on a cinematic hero and a preview of
the largest baskets by total value. `/explore` is the full searchable catalogue: search by name,
ticker, address, or deployer; filter by chain; sort by total value, 24h change, or name; toggle a
grid or list view; and read live count-up stats (total value, basket count, creator count,
networks). The masthead leads with those four live stats beside the title, and a single frosted
toolbar carries the search (with a `⌘K` shortcut to jump to it), the sort, and the view toggle; the
header line under it simply names the active sort ("largest by total value", etc.) — analytics
display, never an editorial pick.

**Why it matters to your business.** This is your top of funnel. Critically, discovery is **derived
entirely from the chain** — the catalogue is enumerated straight from the factory contract (or its
`Launched` events), and the only "ranking" is an **objective metric** (total value, volume, age).
There are **no featured lists, no platform-authored taglines, no seed lists, and no projections or
backtests of hypothetical baskets.** The "largest by total value" spotlight is explicitly framed in
the code as analytics display, not editorial curation.

This is a deliberate business stance, not a missing feature. **Mechanical neutrality is your armour,
not a style guide** — curation and promotion are where interface operators take on representational
risk. If you *choose* to add curation, editorial picks, or "featured" placement, understand that
**curation is your own act** and the package anoints nothing. (The engineered-neutrality rules below
are the business red lines that keep the default build light.)

The neutrality rules baked into the default build, which deviate-knowingly-or-not-at-all:

- **Discovery is chain-derived.** Baskets appear because the factory says they exist, not because
  anyone listed them. No allowlist, no delisting. You *may* filter (e.g. by asset), but filtering
  policy is your own editorial act — own it.
- **Ranking is objective-metric only.** TVL, volume, age — mechanical sorts a user can verify. No
  "featured," no "top picks," no platform-authored taglines, no editorial ordering. (The v1 codebase
  contains a dead "featured carousel" component — it was deliberately abandoned; **leave it dead.**)
- **Metadata is creator-published, deployer-signature-gated.** You render and attribute; you don't
  author, edit, or enrich. Display provenance — factory address, chain, deployer — on everything.
- **Facts, not forecasts.** Real history of deployed baskets is factual. Projections, backtests of
  hypothetical baskets, and "expected returns" of any kind are claims you should not make — the
  kit had a backtest feature once and **deleted it on purpose.**
- **Win attention mechanically:** better data, faster loads, clearer provenance, lower friction.
  That is the competition the kickback funds.

### 3.2 Basket detail — the Token page

**What it does for the user.** `/token?addr=…` is the canonical per-basket page: a signature-colored
header, the live NAV price and 24h change, a labeled NAV source (on-chain view vs. a reconstructed
cross-check, with a "not fully priced" flag and a divergence warning when the two disagree by more
than ~2%), an interactive price chart, a metric strip, the full holdings
breakdown, a fee disclosure panel, and a contract chip linking to the block explorer with a note
that everything works by direct contract access (including `redeemInKind`). On a trading build it
also shows the buy/sell panel; this is also the page a user lands on right after launching a basket.

**Why it matters to your business.** This is your conversion and trust page — the place a user
decides whether a basket is real and what it costs. The honesty machinery here (labeled NAV source,
the divergence warning, the "value works by direct contract access" note) is a *feature*, not a
hedge: it tells the user the interface is not the custodian of truth, the chain is. That posture is
what lets you present value without making yourself a guarantor of it.

### 3.3 Holdings — the "what's inside" view

**What it does for the user.** On the Token page, a constituent breakdown — a visual treemap
(the signature `BasketBento`) and a list view showing each asset's symbol, price, 24h change, live
weight vs. target weight (with a drift label), and per-leg USD value, deep-linking to market data.

**Why it matters to your business.** This is the substance behind a basket — the difference between
"a token with a name" and "a thing a user can understand." It is purely factual: weights and prices
are objective on-chain and market facts. Keep it factual; do not bolt projections or "this basket
will…" framing onto it.

### 3.4 Creation / launch tool

**What it does for the user.** `/launch` is a guided six-step basket builder: (1) add assets with
search and pool auto-detection; (2) set weights with draggable, always-valid controls; (3) set the
immutable fee: the total fee (1–3%) + a single creator share of the post-burn remainder
(`creatorShareBps`, 0–30%, paid to `creatorPayout`, removable) — holders get the rest. The
burn/interface/launcher slices are fixed protocol constants; the launcher recipient is
operator-injected. (4) review the exact fee facts as they
will appear post-launch; (5) name the basket with a live token-card preview; (6) deploy, behind a
salt-mining "forge" readout and the creator self-attestation checkbox. The deploy is priced live by
an on-chain Dutch auction, dry-run-simulated so a doomed deploy fails for free, and wrapped in a
confidence-building ceremony. The salt-mining mines against the factory's `predictTokenAddress`
view; the deployer-is-issuer acknowledgment step is part of the kit — **keep it.**

**Why it matters to your business.** This is the supply side. Every basket a creator launches
through your tool is a basket your users can then discover and trade through your interface — and
flows the tool originates can carry your kickback tag. The tool removes the genuinely intimidating
parts of "deploy your own token" (DEX plumbing, the cryptographic hook-address requirement, the
irreversible on-chain act) and makes them a guided, autosaved, reversible-until-the-last-step
composition. Note that **the launch page is always visible and fully usable as a read-only preview
even on a non-deploy build** — only the final broadcast is gated — so you can demonstrate the entire
flow safely on an information-tier site.

Running the creation tool is a **medium-weight** decision, with irreversible deploys. Keep the
issuer attestation step. See §2.5.

### 3.5 Trading — buy / sell

**What it does for the user.** On a buy/sell build (the `SWAP` flag on — see below), the Token page
shows a buy/sell panel, and there is a dedicated **`/swap` page** (a basket picker + the same panel)
reachable from a `Swap` nav link. With `SWAP` off (the default) none of this renders — buy/sell is
hidden entirely. Pick a side, enter an amount, see the estimated output and the fee (read from the basket's own
contract, never hardcoded), choose a slippage tolerance with sane presets and a hard cap, and
preview the exact per-leg minimums that will protect the trade. A mint is a USDC→basket swap; a
redeem is a basket→USDC swap; both ride the basket hook.

**How the buy/sell actually executes (why it needs a router you supply).** A Spectrum basket is its
own Uniswap V4 hook + liquidity — there is **no "buy" or "sell" function on the basket**. A trade is
an external V4 swap into the basket's hook, and that hook *hard-reverts* unless the swap carries a
per-trade payload (an aggregate minimum + one minimum per constituent + your interface tag). This is
why a **generic DEX aggregator can never trade these baskets** (it can't build that payload — it
would just revert), and why buy/sell needs a small **swap router you deploy** that forwards the
payload. The reference FE is now fully wired to such a router (the buy/sell button does
approve→trade with live tx status), but it stays **hidden by default** behind the dedicated `SWAP`
flag and **inert** until you also set `VITE_SWAP_ROUTER_ADDRESS` to your own router — see
`../OPERATORS.md → "Buy/sell: the router, verifying it, scoping it off"` for the step-by-step. The router's exact shape is still being
finalized (the binding is a documented DRAFT), so treat it as not-yet-final.

**Why buy/sell is its own flag.** Unlike the fee console (which is `TRADING`), buy/sell needs an
extra contract you deploy, so it ships HIDDEN by default behind its own `SWAP`
(`VITE_ENABLE_SWAP`) flag — enabling `TRADING` does **not** surface buy/sell. This keeps the
highest-weight surface off until you deliberately turn it on.

**Why it matters to your business.** This is where the kickback is earned — the mint/redeem flow
your interface originates is the flow that pays you (§4). It is also the **highest-weight** surface:
offering buy/sell of these instruments to the public is the heaviest surface of all the roles, which
is why `SWAP` is the last flag to flip and should flip only after you have deployed a router.

Two load-bearing properties to preserve exactly as shipped:

- **There is no zero/empty-slippage path, and you must never add one.** Per-leg minimums are always
  derived from live quotes at signing time; the encoder *throws* rather than build a transaction
  without live quotes, and the contract reverts on missing protection as a backstop. There is no
  "disable slippage protection" toggle and you must never introduce one.
- The broadcast is now **wired but hidden + inert by default**. With `SWAP` off (the default),
  buy/sell does not render at all (no `/swap` route, no nav link, no Token trade panel). With `SWAP`
  on but no `VITE_SWAP_ROUTER_ADDRESS` set, the panel shows "Preview only — this build does not
  broadcast transactions." With `SWAP` on *and* a router configured, the button becomes a real
  approve→buy/sell (exact-amount approvals only, never infinite); the broadcast is still hard-refused
  in the hook unless `SWAP` is on. Arming it is your build plus your own deployed router.

### 3.6 Portfolio — the holder's "my baskets" view

**What it does for the user.** `/portfolio` connects a wallet (read-only) and shows the baskets that
wallet holds (balance × NAV, with a total) and the baskets that wallet deployed — switchable via a
prominent **Owned / Created** toggle that defaults to whichever you have (Created first if you have
only launched and hold nothing). It also shows an
**asset look-through**: the held baskets decomposed into net exposure per underlying asset (hold two
baskets that both hold WETH → one aggregate WETH line), as an allocation donut plus a bento of
per-asset cards (each: net %, USD value, and how many of your baskets contribute it). This is the analysis a basket product
can give that a flat token list cannot — and it is a restatement of facts already on screen (each
basket's value × its target weights), not a new data source.

**Why it matters to your business.** A retention and orientation surface. It needs a wallet but no
trading, so it is available even on a creation-tool build, and it is read-only and low-weight. Note
the framing discipline: the on-screen label is "Portfolio," but in everything *you* publish, describe
it as a "my-positions" or "held-baskets" view and avoid investment-product framing. There are no
return, yield, or performance claims here beyond neutral 24h price deltas — the look-through reports
composition/exposure (weights and USD), never returns.

### 3.7 Fee claim / flush

**What it does for the user.** `/flush` is a per-basket **fee console** where two economic mechanisms
live: holders claiming accrued fees from a basket's holder reserve, and the permissionless "cranks"
that move a basket's accrued amounts to their immutable destinations. Open it with a basket selected
(the Portfolio "Fees & cranks" admin action deep-links here) or pick from your held/created baskets.
It surfaces four contract surfaces: the holder pull-claim `claimFees()` (no bounty); and the
permissionless cranks `flushPrismBurn(minEthOut)` (the PRISM burn leg), `flushFrontendFees(fe)`
(flushes all pull accruals — interface, launcher **and** creator, which all accrue into
`pendingFrontendFees`), and `redeemClaims()` (settles the lazy-burn queue — pure maintenance). The
**two flush cranks pay their caller a fixed `CRANK_BOUNTY_BPS` bounty** out of the amount flushed;
`claimFees` and `redeemClaims` pay none.

**Why it matters to your business.** Two things. First, the crank bounty is a **separate revenue
role** you can run with almost no operational surface (the keeper role, §4.1) — any address can call
the flush cranks and collect the bounty; no custody, no users, no interface. Second, `flushFrontendFees`
is how *your* accrued kickback gets swept to you. Current status: **the console is now wired** (the
claim + all four cranks, with live pending-amount reads and per-action tx feedback), replacing the
former stub. It remains `TRADING`-flagged, so it appears only on a trading build and stays inert
(read-only, actions disabled) until you arm `VITE_ENABLE_TRADING`.

(Running cranks as a standalone keeper business — setup, the bounty constant, and the burn-path
status — is covered in §4.7.)

### 3.8 Analytics — the read-only value layer

**What it does for the user.** Across the discovery and detail surfaces: live NAV (read from
non-reverting on-chain views), reconstructed price history and charts, composition, total value, and
24h flows. Because V2 exposes static NAV views directly, *no off-chain NAV reconstruction is needed
for display* — the chain prices the basket for you.

**Why it matters to your business.** This is the **lowest-weight** surface and a perfectly good
standalone business: factual display of on-chain data. You can run an information/analytics-only
site with no wallet and no transactions at all, build an audience, and decide later
whether to add a transactional tier. There is no direct revenue from pure analytics — monetization
there is your own (e.g. an API/indexer subscription if you build one) — but it is the cheapest,
safest way to establish a presence. Keep it to objective facts: no projections, no backtests of
hypothetical baskets — factual past performance of deployed baskets only.

### 3.8.1 In-app content — Learn, FAQ, and the integrator Docs

**What it does for the user.** Three shipped, always-on content surfaces that sit alongside the app
chrome: **Learn** (`/learn`) — six plain-language explainer sections (basket tokens; "the token is
the pool"; the fee and where it goes; why it's different; anyone can launch one; and the PRISM burn
mechanism); **FAQ** (`/faq`) — a tap-to-expand accordion of common questions; and **Docs**
(`/docs`, plus `/docs/valuation`) — a mechanism-factual integrator guide that explains how to read
NAV, the keyless discovery/read model, the no-API-key reads, the V4 pool-detection caveat, and the
draft V2 ABI to integrate against (*"integrate against the contracts, not against any website"*).

**Why it matters to your business.** These are your trust-and-education layer and a real asset to an
information-tier operator: Learn and FAQ are how a non-expert visitor comes to understand what a
basket is before they ever connect a wallet, and the Docs guide is the onboarding path for the
indexer / API / analytics roles (§4.1) — it is what a developer reads to build plumbing against the
contracts. All three are pure content surfaces with no transactional weight. **Each ships with an
explicit review banner** in the source flagging that the public copy — and especially the
burn/PRISM language — should be kept in the honest *routing* form (never "baskets burn" as a present
fact; see §3.9, R-5, §7). Treat this copy as useful drafts you should review before publishing, not
finished claims you can ship as-is.

### 3.9 The visual / brand experience

**What it does for the user.** A cohesive "optics / spectrum" identity: a prism logo glyph, a
refracting wordmark, an animated edge-dispersal background, and per-basket signature colors derived
from each basket's dominant holding. The `BasketBento` treemap renders "many assets in one token"
legible at a glance, at any size. Everything is SVG / CSS / WebGL — no raster logos and no external
brand assets. No font CDN is *required*: `index.html` links Google Fonts (Chakra Petch, JetBrains
Mono, Space Grotesk) as a progressive enhancement that degrades cleanly to the system-font stack if
the request is blocked. If you are targeting a strict-CSP or fully-offline IPFS deploy, know that
those font links are present by default and either self-host the faces or accept the system-font
fallback (see `02-TECHNICAL.md`).

**Why it matters to your business.** You inherit a premium, distinctive, defensible look **out of
the box**, and because it is all vector/shader and otherwise self-contained, it is IPFS/ENS-friendly
and costs you nothing to ship. Two business-relevant disciplines are baked in:

- The look is **neutral by construction**: colors and the "largest by total value"
  spotlight are derived *mechanically*, not curated — so the brand never implicitly editorializes.
- The disclaimer chrome ships with explicit "placeholder copy" banners, so you cannot mistake
  placeholder copy for finished terms.

One brand caveat (do not silently "fix" it): the prism glyph and a previously-removed "powered by
PRISM" footer tagline ride on a real honest-status fact — PRISM does **not** "power" baskets; a
fixed share of fees is *routed* toward a buy-and-burn path that is wired and in-flight, not a
realized fact. The tagline was deliberately removed and **must not be reintroduced** without
sign-off. This ties to the honest-status line in §7.

### 3.10 Creator social identity (X profile)

**What it does for the user.** A basket creator can attach an X (Twitter) handle, display name,
sector tags, and avatar + banner images — identity pointers only, **no long-form prose**. A creator's thesis or
write-up lives on their own channels (X, etc.); the site never hosts that content, it links out to it
via the @handle. When present, the FE surfaces the identity to full effect: a banner + avatar +
handle hero on the **creator profile** (`/creator/:deployer`), a verified handle + X link on the
**basket detail** page, and a compact creator chip on Explore, Home, and every basket card. Each
basket gets a recognisable, human face — without any platform-curated or platform-hosted content.

Users can also **follow** a creator (a "Follow" button on the creator profile) and flip a **"Following"
filter** on Explore to show only baskets from creators they follow. This is a personal bookmark stored
**in the user's own browser only** — no account, no server, no cross-device sync, and crucially **no
"suggested/who-to-follow" surface** (that would be the curated-store anti-pattern). It implies nothing
about a creator and is never visible to anyone else; it is purely a convenience filter over the same
objective catalogue.

**How the data flows (read before you wire publishing).** The data is **creator-published, not
platform-authored**: the creator signs a metadata blob with their *deploy key* (EIP-712), and the FE
renders it only after verifying that signature against the basket's on-chain deployer. As a "metadata
host / pinner" operator (§4.1) you only *serve* signed content; you **render and attribute — you
never author, edit, or enrich**, and you display provenance (factory address, chain, deployer) on
everything (the §12.1 design — see `02-TECHNICAL.md §4.5`). With no metadata host configured
(`VITE_METADATA_BASE_URL` unset — the shipped default) nothing is fetched and every basket shows the
honest on-chain deployer address; the feature degrades cleanly to today's attribution. Creator bios
are the creator's own statements, shown as attribution and neither vetted nor endorsed (a review
marker flags that copy — keep it in the honest form).

**The creator's publish step (now built).** Right after a creator deploys, the builder offers a
skippable **"sign & publish your profile"** step: they sign the blob in their own wallet and it is
persisted three ways — a one-click submit to your optional **write-relay** (if you run one), a
**download** of the signed file with the exact path to host it at, and **this-browser localStorage** so
they see their own profile immediately. This is the only way profile/version data ever gets created —
the FE owns no key and writes nothing on the creator's behalf. As an operator you may run a
**write-relay** (a thin endpoint that re-verifies the signature and stores the blob; it never authors,
lists, or ranks) to make publishing one click, or leave it unset and let creators self-host.

### 3.11 Basket versioning (immutable + opt-in upgrade)

**What it does for the user.** Baskets are immutable (§2.2), so a creator "updates" one by deploying a
**new, separate immutable version** and anointing it the successor. The FE makes this legible: the
creator opens **"New version"** on a basket they deployed (the basket's own detail page, Portfolio →
Created, or their creator profile — all gated to the deployer) → the launch builder opens **prefilled** with the old basket's
constituents, weights and fee config → they edit and deploy. On the basket detail page a **version
strip** shows the lineage (v1 · v2 · …), a **diff** shows exactly what changed (added / removed /
reweighted constituents — on-chain facts only), and discovery (Home/Explore) shows only the **latest**
version so a lineage never double-lists. A holder of an older version sees a quiet "a newer version is
available" note and can review an **opt-in upgrade** modal.

**How it stays neutral.** The version link is **not** an on-chain pointer or registry — the
contracts deliberately reject any successor registry as a controller (verify against the deployed
contracts). It is a
deployer-signed `supersedes` claim carried in the same signed creator metadata, verified the same way
(the same deployer signed both). "Successorship is social," exactly as the protocol prescribes. The
upgrade itself is the in-kind delta migration (`mintInKind`): overlapping assets move in kind,
only the changed delta is traded, and the same fee/burn waterfall as a swap-mint applies (no
fee-avoidance bypass). It is always the holder's explicit choice — nothing rebalances automatically.
**The upgrade transaction ships INERT** (preview only): it is a transactional surface, behind the
`VITE_ENABLE_TRADING` flag, and the migration router + `mintInKind` are not deployed yet — wiring
the broadcast is the flag-flipper's act, exactly like buy/sell (§3.5).

---

## 4. The operator business model & economics

### 4.1 The roles you can run

You do not apply, register, or ask anyone to run any of these. You pick a role (or several) and run
it. There are **no keys** to any of these roles and **no counterparty**. The weight notes below are
one-line orientation pointers only.

| Role | What it is | How it can pay | Weight |
|---|---|---|---|
| **Trading interface** | A site/app where users mint, redeem, and swap baskets. Non-custodial — users sign their own transactions; you never touch funds. | The interface kickback (§4.2) — this is what the kickback is primarily for. | **Heaviest.** |
| **Creation tool** | The basket builder: search, pool validation, weight design, salt mining, the deploy transaction. The deployer is always the connected user signing for themselves. | Tag your kickback address on flows the tool originates; creators often keep trading through your interface. | **Medium.** Keep the issuer-attestation step. |
| **Marketplace / discovery** | Listing and search over all baskets, objective rankings, creator profiles. | Kickback on mint/redeem flow you originate (add the buttons); otherwise reputation, ads, or an API. | **Medium**, almost entirely self-inflicted via curation. Stay mechanical. |
| **Analytics** | Read-only NAV, history, composition, flows, dashboards. | Usually none directly; API subscriptions if you build an indexer. Adding transactional buttons drifts you toward "trading interface." | **Lowest.** Factual display of on-chain data. |
| **Keeper / crank runner** | Bots calling the public maintenance functions (flushing accrued fees to their fixed destinations, executing the burn path). All permissionless — any address may call. | A fixed-bps caller bounty on every flush crank, paid from the flushed amount. | **Near-zero.** No custody, no discretion, no users, no interface. |
| **Metadata host / pinner** | Serving creator-published basket metadata (logos, descriptions, sector tags) and/or pinning frontend builds to IPFS. Optionally a thin **write-relay** (`VITE_METADATA_WRITE_URL`) that accepts the creator's signed blob, re-verifies the signature server-side, and stores it. Metadata writes require the basket deployer's signature — you validate signatures, you never author, list, or rank content. | None directly; usually bundled with another role. | **Low**, content-shaped — as long as you never editorialize. |
| **Indexer / API provider** | A subgraph/API over factory `Launched` events, NAV series, OHLC — plumbing the other roles consume. | Subscriptions, or run as a public good. | **Lowest.** |

The frontend in this package most directly equips the first four roles (and now the keeper role too —
the Flush console wires the permissionless cranks). You can combine roles; the economics and the
weight stack accordingly. There is no registration, allowlist, contract, invoice, or
counterparty for any of them — the bytecode pays you, nobody can revoke it, and nobody can promise
you more.

### 4.2 The interface kickback — how it pays you

This is the core on-chain revenue line for an interface operator. The mechanics:

- Every mint and redeem transaction accepts an **optional frontend address tag**, carried in the
  swap's hookData. Your interface inserts **your own** address into the transactions **it builds**.
- A **protocol-defined, immutable slice** accrues to the tagged address. The protocol constant is
  `INTERFACE_SHARE_BPS` — `555` bps of the post-burn amount (`afterBurn`).
- The slice is **carved out of the post-burn (creator-side) amount** — never from the PRISM burn,
  and **never added on top of what the user pays.** *The user pays the exact same fee whether or not
  a tag is present.* "Creator-side" means the entire non-burn remainder, however the creator routed
  it — so even a 100%-to-holders basket pays its interfaces. You are competing on UX, not on price to
  the user.
- **The interface slice is conditional on a frontend tag being present.** A separate, fixed
  **launcher** slice (also `555` bps of `afterBurn`) is carved when a basket's `FeeConfig.launcher`
  is set — that recipient is **operator-injected** at deploy, never a creator dial. The remainder
  after burn and any present interface/launcher cuts is then split between the creator (up to
  `creatorShareBps`, capped at 30%) and the holders, who get the rest.
- **No tag (`address(0)`) means the interface slice is simply not carved** — it stays in the
  remainder and flows to the creator and holders. You are paid only for the flow you actually
  originate, and you take nothing from flow you did not.
- **No registration, no allowlist, no contract, no invoice, no counterparty.** The bytecode pays
  the tagged address; nobody can revoke it and nobody can promise you more. Your accrued fees are
  swept to you permissionlessly via the `flushFrontendFees` crank.

> **Verify the deployed constants — do not trust this prose.** The protocol
> economics are **fixed constants**, not creator dials: `BURN_SHARE_BPS = 1000` (10% of every fee),
> `INTERFACE_SHARE_BPS = 555` and `LAUNCHER_SHARE_BPS = 555` (each ≈5.55% of the post-burn amount ≈
> 5% of every fee, and each carved only when present), `MAX_CREATOR_SHARE_BPS = 3000` (30%),
> `MIN_BASKET_FEE_BPS = 100` / `MAX_BASKET_FEE_BPS = 300` (the rate band), `CRANK_BOUNTY_BPS = 50`.
> The frontend mirrors these in `fee-model.ts` and shows them on screen; the only per-basket figure —
> the fee rate — is read live from the basket. The *authoritative* values are whatever the deployed
> bytecode says; read it (and your `ADDRESSES.md`) for the figures you will run against. The
> numbers below are **illustrative arithmetic only.**

### 4.3 Worked illustrative arithmetic

Take a basket with a **1.00% mint/redeem fee**. The PRISM burn is a fixed 10% of the fee, leaving 90%
as the post-burn (creator-side) amount. The interface kickback is `INTERFACE_SHARE_BPS` (≈5.55%) of
that post-burn amount — which works out to **≈5% of every fee** — and is carved only when a frontend
tag rode the call:

```
kickback share of the fee  = 5.55% × 90%    ≈ 5% of the fee
kickback as % of volume    = 5% × 1.00%     = 0.05% of tagged volume

On $1,000,000 / month of tagged mint+redeem volume:
  monthly kickback          ≈ 0.05% × $1,000,000  ≈ $500 / month
```

Against hosting costs near zero (§4.5), that is roughly $500/month of gross margin on a million
dollars of monthly tagged volume — and it scales **linearly** with the volume your UX actually wins.
Double the tagged volume and you double the kickback; win none and you receive none.

> **The 1% is illustrative; the fee rate varies per basket.** A creator picks each basket's fee
> within the fixed `MIN_BASKET_FEE_BPS` / `MAX_BASKET_FEE_BPS` band — **1.00%–3.00%** (the floor
> restored v1's flat 1%). A basket at the 1% floor pays the kickback above; a 3% basket pays ~3×.
> The per-basket fee is read live on screen — never model a single fee across all baskets. (The
> earlier design-draft figures — a ~$1,800/month example and a 10–30% creator-side kickback band —
> predate the fixed-constant model above and are superseded by the deployed constants; always read
> the bytecode.)

### 4.4 What you must understand before building on the kickback

- **Per-basket variance is real.** Creators choose their own fee rate (within the 1.00%–3.00% band);
  the burn (10%) and the interface share are fixed protocol constants, so there is always a non-zero
  creator-side remainder and the old "100% burn → zero kickback" edge case **can no longer arise**.
  Your expected revenue still varies by *which baskets your users actually trade* (a 3% basket pays
  ~3× a 1% basket per dollar of volume). The contracts make every basket's fee breakdown readable,
  and the frontend displays it; your coverage is your own affair.
- **Only primary mint/redeem flow pays.** Swaps routed through aggregators or other venues do not
  carry your tag. You are paid only for the mint/redeem you originate — which is why your UX and
  your audience are the whole game.
- **Volume risk is yours.** At launch, volume is approximately zero (§4.6). Nobody — least of all
  the package author — promises you traffic, listings, growth, or any minimum. Read the prior art
  (Liquity's frontend ecosystem, §5) and price your own bet.
- **Receiving the kickback makes you a protocol-fee recipient.** Be aware of that when you decide how
  to operate.

### 4.5 Cost structure

The build is **keyless-first** — it works against a plain public RPC, and every cost below is
optional or near-zero. Keyless operation works; it is just slower for discovery.

| Role | Typical cost |
|---|---|
| Trading interface / creation tool | Static hosting (IPFS or any host) ≈ **$0–20/mo**; an optional RPC/indexer key for faster discovery ≈ **$0–200/mo** |
| Keeper / crank runner | Gas on Base (cents per crank) plus a small server or cron job |
| Metadata host / pinner | A pinning service ≈ a few dollars a month |
| Indexer / API | Optional infra you choose to stand up |

What works keyless, against a plain public RPC: **discovery** (factory enumeration — no log scans,
no archive node), **reads** (NAV via static views, per-basket fee config, holdings, supply, deployer
attribution), and **pricing/charts** (keyless, CORS-friendly market data). What does *not* work
keyless: the wide V4 pool scan in the launch flow's pool detection (public RPCs cap the required log
query — the builder shows a prominent "V4 venues were not scanned on this build" warning, and an
origin-restricted key or your own read proxy restores full coverage) and very long historical log
lookbacks.

> **Every `VITE_` value ships publicly in the static bundle.** There is no server-side secret in
> this architecture. Any RPC key you set is a public key the moment you build — use an
> origin-restricted key or a read proxy, never a privileged one. `02-TECHNICAL.md` and
> `03-IMPLEMENTATION.md` cover this in full.

### 4.6 Revenue expectations & the honest cold-start reality

The shipped default config lists **nothing** — an empty address book, no seed lists, no curated
metadata. A fresh deployment shows an **empty marketplace, and that is correct behavior, not a
bug.** The empty state says so plainly.

Be clear-eyed about the implication: **on day one your tagged volume is zero, and therefore your
kickback is zero.** Revenue is a pure function of the tagged mint/redeem volume your interface wins
(the interface slice is carved from the post-burn amount on every tagged flow). There is no floor, no
guarantee, no referral pool, and no central party seeding traffic to you. The realistic path is the
ordinary one for any independent web3 frontend: build a credible, fast, honest interface; cultivate
an audience and a base of creators who launch and trade through you; and let the linear kickback
compound as your tagged volume grows. The analytics-only tier (§3.8) is the cheapest, lowest-risk way
to establish presence before you ever flip a transactional flag — run it **dark** (info-only) until
you are satisfied. A historical note worth keeping in mind: major established interfaces have refused
to list basket-class tokens before; your independent interface exists precisely because access
shouldn't depend on anyone's listing policy — **including yours.**

### 4.7 Running the frontend in practice — fork, configure, host, crank

The FE is one open-source codebase, designed to be operated by strangers. The business-relevant shape
(full mechanics in `02-TECHNICAL.md` and `03-IMPLEMENTATION.md`):

1. **Fork it.** Vite + React, fully client-side, static build — no server runtime.
   `pnpm install && pnpm build` produces a directory you can host anywhere; IPFS + ENS is the
   canonical pattern (`base: './'` is already set for gateway-relative assets).
2. **Pick your surface with build-time flags.** The three independent flags — `WALLET`, `DEPLOY`,
   `TRADING` (plus `SWAP` for buy/sell) — all default **off** (info-only build). Each flag is a
   separate decision; info-only / deploy-only / trading builds are separate static artifacts, so what
   you didn't enable literally isn't in your bundle. (See §3.0 and `../SETUP.md`.)
3. **Configure, don't inherit.** Set your own RPC key (or run keyless — slower discovery, fully
   functional), your own kickback address, your own chain/factory list (a plain, user-editable
   versions file — you decide which factory deployments you index; verify addresses against the
   evidence repo and on-chain). The shipped default config contains **no seed lists and no curated
   metadata**: what your deployment shows is chain-derived, and what you add is yours.
4. **Host it yourself.** Your domain or ENS, your pin, your keys to nothing. If you stop pinning, the
   protocol doesn't notice — and redemption survives you at the contract level regardless.
5. **Direct-contract access is always documented** in the package — your users (and you) can verify
   that everything your interface does is reproducible with a block explorer and a wallet.

**Running cranks permissionlessly (the keeper business).** The maintenance functions (forwarder-fee
flush, the PRISM burn path, plus whatever else the final contracts expose) are public: any address
can call them; outcomes are fixed by bytecode (accrued amounts go to their immutably-routed
destinations — the caller can't redirect anything). A reverting fee-sink can **never brick the
system** by design (fees accrue and are flushed asynchronously), so your crank failing — or nobody
ever running one — degrades nothing critical; it just delays routing. Practical setup: a cron job or
bot, a wallet with gas (Base fees are cents), and the contract ABIs from the package. **Simulate
before sending.** The flush cranks pay an immutable fixed-bps caller bounty out of the amount flushed
(`CRANK_BOUNTY_BPS` — read the deployed bytecode for the exact value before pricing the role; it is
immutable, so what you read is what you get, forever). This is the lowest-commitment way to keep the
ecosystem autonomous, and a natural fit if you already run a basket or an interface.

> **Burn-crank caution.** If you take up the burn-crank role you may be the one to complete the
> first cycle — the burn path has zero lifetime executions and is unexercised in reality (§7). Treat
> the burn path as unexercised, not a formality — and **never present yourself as the sole or
> scheduled keeper.**

---

## 5. Precedents that de-risk the bet

You can verify each of these independently; none of them depend on anything in this package.

- **Multi-frontend kickbacks (the Liquity pattern, live since 2021).** Liquity's protocol pays a
  kickback to independent frontends, and its authoring team never operated a frontend of its own —
  the same shape as the interface kickback here. Spectrum V2's distinction is that its kickback
  slice, its neutrality, and the absence of any default recipient are **immutable bytecode**, not
  DAO-adjustable policy.
- **Fee-floor-to-burn (live, shipped prior art).** Routing a protocol fee floor into a token burn is
  not novel: Reserve's Index DTFs burn their staking token (RSR) from a protocol fee floor, and
  Uniswap routes protocol fees toward UNI post-UNIfication. Again, the V2 distinction is that the
  floor is immutable bytecode, not a tunable DAO policy lever.

The takeaway for your decision: the *economic model* (independent frontends receiving a protocol-paid
slice of fees, and a fee floor feeding a burn) is established and has run in production elsewhere for
years. What is unproven here is **this specific, not-yet-deployed implementation** — which is exactly
what §6 and §7 are about.

---

## 6. Business risk register

| # | Risk | What it is | What you do about it |
|---|---|---|---|
| **R-1** | **Volume / cold-start** | Day-one tagged volume is zero, so kickback revenue is zero. No party seeds traffic to you; growth is yours to win. | Treat the kickback as upside on volume you win, not a baseline. Start on the cheap analytics tier (run it dark); build audience and creator supply before leaning on transactional revenue. (§4.6) |
| **R-2** | **Per-basket fee variance** | Your revenue is a slice of a fee the *creator* set; fee rates vary across the 1.00%–3.00% band (the burn + interface shares are now fixed, so every basket pays a non-zero kickback). | Your revenue is portfolio-of-baskets dependent. Read the on-chain fee breakdown (the frontend displays it) and understand your actual coverage; never model a single assumed fee across all baskets. (§4.4) |
| **R-4** | **Reliance on a deployed contract lineage** | You connect to contracts someone else deploys. Their verification and address correctness are prerequisites you depend on but do not control. | Connect only to contracts that meet the go-live bar (§7), with a filled and verified `ADDRESSES.md`. Verify on-chain yourself per `03-IMPLEMENTATION.md`. Re-seating any compile-time contract constant changes bytecode and invalidates every mined salt — so a contracts change is a hard frontend dependency, not a free swap. |
| **R-5** | **Burn-leg status** | The PRISM burn mechanism is **wired and in-flight, not realized.** Zero lifetime burns; the burn path is unexercised in reality. | **Never present baskets as "burning" as a present fact.** Describe the mechanism as wired/in-flight and tell users to verify on-chain. Do not reintroduce the "powered by PRISM" tagline. Before any public claim that the flywheel works, require at least one observed end-to-end burn — and you must never present yourself as the sole or scheduled keeper. (§7) |
| **R-6** | **In-kind paths and the burn narrative (forward-looking)** | A proposed in-kind mint path, combined with the existing in-kind redeem, means a predominantly in-kind basket could run at ~zero burn while charging full fees. This is *proposed, not applied.* | Treat the burn flywheel claim as qualified to **every pool/swap mint/redeem fee**, not literally every fee. As the frontend operator, keep your burn copy in the wired/in-flight form and do not overclaim. (The contract-owner strategy question sits with them.) |
| **R-7** | **Public RPC key exposure** | Any key you put in a `VITE_` var ships in the public bundle. | Use only origin-restricted keys or a read proxy; never a privileged key. The build works keyless. (§4.5) |
| **R-8** | **Curation as self-inflicted risk** | The default is mechanical, non-curated discovery. If you add featured lists, editorial picks, or taglines, you take on issuer-adjacent representational risk. | If you curate, do it as a deliberate, reviewed act and own it. The package gives you no curation to inherit and anoints no venue. (§3.1) |

---

## 7. Honest status & what you never get from anyone "central"

State all of the following affirmatively and never overclaim. These are the load-bearing
honest-status lines for the whole product.

- **The reference contracts are a reference implementation.** Green local tests are not a guarantee
  of correctness — verify on-chain yourself.
- **Nothing is deployed yet.** The go-live bar for the contracts (owned by the operator who owns the
  repo, not by you) is absolute and does not negotiate down — because there is no pause or upgrade,
  every shipped bug is permanent. It includes, at minimum: a green invariant suite, a permissive
  license, and a matched-pair reconciliation against the developer's own build. **You connect only
  to contracts that have cleared that bar.**
- **The PRISM burn leg is wired and in-flight, not realized.** Zero lifetime completed burns; the
  burn path is unexercised in reality. It has no privileged control by construction (a single
  permissionless flush, no owner, no withdraw, no upgrade) but unexercised in reality. **Never say baskets "burn"
  as a present fact** — say the mechanism is wired/in-flight and tell readers to verify on-chain.
- **An empty marketplace on a fresh deployment is correct, not a bug.**
- **The integration surface is a draft until bound to the deployed deliverable.** The frontend's
  contract interface (ABIs and one event signature) is explicitly a draft; it must be reconciled
  against the actually-deployed contracts before any deployment. (See `02-TECHNICAL.md`.)
- **Placeholder copy.** The terms/risk/privacy pages in this package are placeholders you must
  finalize before any public build. They are placeholder text, not advice.

**What you never get from anyone "central" — because there is no central party:**

- No traffic, no listings, no growth, no minimum revenue, and no referral pool.
- No partner, principal, counterparty, sponsor, or support desk. The package author operates
  nothing, holds no keys, is not your counterparty, and pays/endorses/recruits no one. **What you
  will never get from the author or anyone "central": payment, endorsement, indemnity, a support
  contract, a takedown order, or a rescue.** What you *can* rely on: immutable verified contracts,
  open-source code, and this documentation — plan accordingly, including your own honourable
  wind-down (an exit-only build that keeps redemption reachable; redemption survives you at the
  contract level regardless).
- No default recipient of fees, no default RPC key, no default trading venue, no default curation,
  and no default address of any kind. The empty interface-tag default (unset → `address(0)` → the
  interface slice is not carved and stays in the remainder shared by creator and holders) is
  load-bearing. The same is true of the new launcher default (`VITE_LAUNCHER_ADDRESS` unset →
  `address(0)` → no launcher slice). If you ever encounter something presented as a "default
  recipient," it is wrong — do not ship it.
- No on-chain admin lever over your users, and none held over you. You run an interface to a fixed,
  ownerless machine. The independence is the product. **Tell no one you're "official." There is no
  official. That's the feature.**

---

> **This is software, not advice.** This document is informational only. Verify everything on-chain
> yourself before operating any surface that lets a user sign a transaction. The decisions here are
> yours to make and yours to own.

*See also: `README.md` (index & status), `02-TECHNICAL.md` (architecture, per-feature specs,
config/flags/env, integration surface), `03-IMPLEMENTATION.md` (go-live runbook: setup → configure
→ connect → build → host → QA → operate),
`../OPERATORS.md` and `../SETUP.md` (operator fork/configure/host detail), and
the **contracts source** (a separate repo, with its own address book).*
