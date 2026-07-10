# 02 — TECHNICAL Reference & Per-Feature Tech Specs

> **This is software, not advice.** This document describes how the Spectrum V2 frontend is built and how to operate and extend it. It is engineering reference only. Any decision to enable a wallet, deploy, or trading surface is yours. The reference contracts this frontend targets are **not deployed yet**, and the PRISM burn leg is **wired and in-flight, not yet realised** (zero lifetime burns). Verify everything on-chain against your own deployed and verified contracts before relying on it.

This is the engineer's reference for the handover set. Read it alongside:

- **`README.md`** — index, reading order, status/partition banner, doc map.
- **`01-BUSINESS.md`** — the product, the operator business model & economics, the feature catalog from a value lens, risks, precedents.
- **`03-IMPLEMENTATION.md`** — the go-live runbook: prerequisites → setup → configure → connect-to-deployed-contracts → build (per flag tier) → host (IPFS/ENS) → QA smoke test → operations.

Throughout: the product is **baskets**, never "indexes." The code still carries Index-era identifiers (`useIndexData`-style names, `ix` prop aliases, `INDEX_ABI` in one script) because it was adapted from an earlier index codebase — where a symbol is named verbatim below it is a code identifier, not a product claim. All file paths are relative to the frontend app root unless noted:

```
app/        # the frontend app root (relative to the repo root)
```

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [Repository & directory map](#2-repository--directory-map)
3. [The contract-integration surface](#3-the-contract-integration-surface)
   - 3.1 [`abis-v2.ts` — the single integration point](#31-abis-v2ts--the-single-integration-point)
   - 3.2 [Factory views & calls](#32-factory-views--calls)
   - 3.3 [Per-basket views & calls](#33-per-basket-views--calls)
   - 3.4 [The NAV model](#34-the-nav-model)
   - 3.5 [The fee model](#35-the-fee-model)
   - 3.6 [The hookData encoder — never add a zero-slippage path](#36-the-hookdata-encoder--never-add-a-zero-slippage-path)
   - 3.7 [Salt mining (CREATE2 hook-address mask)](#37-salt-mining-create2-hook-address-mask)
   - 3.8 [The deploy engine](#38-the-deploy-engine)
   - 3.9 [Pool detection (the launch routing engine)](#39-pool-detection-the-launch-routing-engine)
4. [Per-feature tech specs](#4-per-feature-tech-specs)
   - 4.1 [App shell, routing, gating](#41-app-shell-routing-gating)
   - 4.2 [Pages](#42-pages)
   - 4.3 [Significant components & hooks](#43-significant-components--hooks)
   - 4.4 [The design system — brand tokens & the up/down color contract](#44-the-design-system--brand-tokens--the-updown-color-contract)
5. [Config & build system](#5-config--build-system)
6. [State management, routing, performance, accessibility, dev fixture](#6-state-management-routing-performance-accessibility-dev-fixture)
   - 6.1 [Testing & verification](#61-testing--verification)
7. [Known technical constraints & limitations](#7-known-technical-constraints--limitations)

---

## 1. Architecture overview

Spectrum V2's frontend is a **fully static, client-only single-page application**. There is **no server runtime** — no API routes, no SSR, no backend you operate. Everything ships as a folder of static assets you can pin to IPFS, publish under an ENS name, or drop on any static host. Every dynamic fact is fetched at runtime in the browser, directly from public RPC endpoints, DEX-data HTTP APIs, and on-chain contract views.

### 1.1 Stack

| Layer | Technology | Notes |
|---|---|---|
| Framework | **React 19** | `StrictMode`, function components + hooks, `React.lazy` code-splitting per route. |
| Build tool | **Vite 6** | Static bundle; `base: './'` for gateway-relative assets; native `%VITE_*%` HTML env substitution. Package manager is **pnpm**. |
| Language | **TypeScript 5.7** | Project-references build (`tsc -b`), `strict`, `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax`. Dead code fails the build. |
| Styling | **Tailwind v4** | CSS-first `@theme` in `src/index.css` (the single brand-token source). `@tailwindcss/vite` plugin, no separate Tailwind config file. |
| Wallet / EVM | **wagmi 2 + viem 2** | wagmi `Register`-typed hooks; viem `PublicClient`s for all reads, `useWriteContract` for the one write (deploy). |
| Data fetching | **TanStack Query (React Query 5)** | One `QueryClient`; reads cached/deduped/refetched on intervals. |
| Routing | **react-router-dom 7** | `BrowserRouter` (history API). Needs an SPA catch-all rewrite at the host (see `03-IMPLEMENTATION.md`). |
| Charts | **Recharts 3** | `BasketChart`/`BasketSpark` (animation disabled for perf); hand-rolled SVG used where Recharts is overkill. |
| 3D background | **three.js 0.184** | `SpectrumBackground`, lazy-loaded, reduced-motion-gated, fully decorative. |

### 1.2 Deploy target

The intended target is **IPFS / ENS** (e.g. an ENS name resolving a content hash to an IPFS CID served through a gateway), but the bundle is host-agnostic: anything that serves static files with an SPA fallback works (Netlify, Cloudflare Pages, S3+CloudFront, nginx). Two architectural decisions exist specifically to make IPFS work:

- **`base: './'`** in `vite.config.ts` so every asset URL is relative and the build resolves under any gateway path like `https://<gateway>/ipfs/<cid>/`. **Do not change this to an absolute base** — it would break gateway hosting.
- **Everything is self-contained SVG/CSS/GLSL** in the presentation layer (the prism glyph, the refracting wordmark, the spectral background) — no raster logos, no fonts shipped as required assets, system-font fallbacks in the stack. (Note: `index.html` does `<link>` Google Fonts as a progressive enhancement, and `AssetLogo` hotlinks the DexScreener token-icon CDN with an initials fallback; both degrade gracefully if blocked.)

### 1.3 Data flow

```
                         ┌───────────────────────────────────────────────┐
   Browser (static SPA)  │  React 19 + TanStack Query + wagmi/viem        │
                         └───────────────────────────────────────────────┘
        reads (no key needed)                         write (gated)
                │                                          │
                ▼                                          ▼
   viem PublicClient (per chain,                 wagmi useWriteContract
   Multicall3-batched, rpc.ts)                   (deployBasket only)
                │                                          │
   ┌────────────┼───────────────────────────┐             │
   ▼            ▼                             ▼             ▼
 FACTORY     BASKET token              V4 PoolManager   FACTORY
 (enumerate, (NAV views, fee config,   (extsload pool   (deployBasket,
  fee bounds, holdings, supply,         state, V4         CREATE2 deploy)
  auction     redeemInKind)             pool discovery)
  price)
   │            │
   └────────────┴──── cross-checked / enriched by ───►  DexScreener HTTP API
                                                          (keyless spot prices,
                                                           pool TVL, token search,
                                                           token icons)
                                                         Alchemy Prices / DefiLlama
                                                          (reconstructed NAV history)
```

Direction in one sentence: **the FE reads from RPC → contract views and from DexScreener; it cross-checks the two; and the only state-changing path is a single `deployBasket` write (gated) plus, when an operator enables trading, mint/redeem swaps that carry FE-encoded `hookData`.** No write happens silently and no transaction is ever signed without the user's wallet.

### 1.4 Three load-bearing architectural invariants

1. **Read-only by default; transactional surfaces are opt-in build flags.** Four independent flags (`WALLET`, `DEPLOY`, `TRADING`, `SWAP`), all OFF by default, gate every transactional surface. The shipped build is information/analytics only. See [§5.1](#51-feature-flags--four-independent-gates).
2. **No hardcoded variable economics.** The per-basket fee rate and auction prices are **read on-chain**. The fixed protocol constants (burn share, interface share, fee bounds, crank bounty) — immutable in the contracts — are mirrored in `fee-model.ts` as a documented mirror of verified bytecode, the one principled exception (the builder needs bounds on an empty marketplace; a `constant` is not a settable value). See [§3.5](#35-the-fee-model).
3. **No silent zero-slippage path.** Every transactional encode derives per-leg minimums from live quotes and *throws* rather than degrade. See [§3.6](#36-the-hookdata-encoder--never-add-a-zero-slippage-path). **Never add a bypass.**

---

## 2. Repository & directory map

```
app/
├─ index.html                 entry HTML; OG/Twitter tags with %VITE_SITE_URL% tokens
├─ vite.config.ts             base:'./', react+tailwind plugins, manual vendor chunks
├─ package.json               pnpm scripts: dev / init:env / check:config / build (+prebuild gate) / typecheck / preview / test
├─ tsconfig*.json             project-references (root → app + node), strict
├─ .env.example               every VITE_* documented; all public in a static build
├─ scripts/
│  ├─ init-env.mjs            copy .env.example → .env.local (npm run init:env)
│  └─ check-config.mjs        validate config before build; prebuild gate (§5.7)
├─ public/                    favicon, PWA icons, og.png, manifest, robots.txt, sitemap.xml stub,
│                             proto/bg.html (CDN-dependent prototype — prune before deploy)
└─ src/
   ├─ main.tsx                mounts <App/> in <StrictMode>
   ├─ App.tsx                 providers → BrowserRouter → Layout → Routes; route titles
   ├─ wagmi.ts                wagmi config: chains, transports, flag-conditional connectors
   ├─ index.css               Tailwind v4 @theme — single brand-token + keyframe source
   ├─ vite-env.d.ts           typed ImportMetaEnv for all VITE_* vars
   ├─ pages/                  one component per route (all React.lazy code-split)
   ├─ components/             app shell + basket visualizations + transactional surfaces
   │  └─ launch/              the 6-step basket builder + its sub-components
   ├─ hud/                    PrismMark glyph only (old HUD kit deleted — keep removed)
   └─ lib/                    all non-presentation logic ↓
      ├─ chain/               address injection, chain registry, RPC, active-chain store
      ├─ config/              feature flags + operator config (kickback tag, partner URL)
      ├─ pools/               Uniswap V2/V3/V4 + Aerodrome pool detection/routing
      ├─ spectrum/            the contract-integration surface + data/NAV/fee/deploy logic
      ├─ motion.ts            reduced-motion-safe animation hooks
      └─ treemap.ts           squarify() — the BasketBento layout algorithm
```

### 2.1 `lib/` module roles (the heart of the app)

**`lib/spectrum/` — contract integration + data layer.** Every contract interaction and all NAV/fee/deploy logic lives here.

| Module | Role |
|---|---|
| `abis-v2.ts` | **The single contract-integration point.** All ABIs (factory, basket, PoolManager), the `0x88` hook-flag constants, and the `BasketEntry`/`FeeConfig` tuple shapes. DRAFT — bind to the deployed deliverable. |
| `basket-data.ts` | Discovery (factory enumeration + log-scan fallback), immutable-meta reads (cached), mutable NAV/holdings/supply reads, the DexScreener cross-check, portfolio holdings, list/sort helpers. |
| `hooks.ts` | React Query hooks: `useAllBaskets`, `useBasketData`, `useCreatorProfile`, `usePortfolio`, `useLiveExposure`, `useDeployPrice`, `useNavHistory`/`useAssetHistory`. Refetch intervals + caches. |
| `use-deploy.ts` | `useDeployBasket` — the two-phase (`prepare`→`broadcast`) launch state machine + the `DEPLOY_ENABLED` runtime guard. |
| `deploy.ts` | Tx assembly: `toBasketEntries` (weights→bps), `startSqrtPriceX96ForDollarNav` ($1 NAV open price), bigint `isqrt`. |
| `salt-mining.ts` | `mineSalt` — Multicall3-batched CREATE2 salt brute-force against `predictTokenAddress`; `hasHookFlags`. |
| `hook-data.ts` | The `hookData` wire encoders. `encodeMintHookData` (BUY): derives non-zero per-leg minimums from live quotes so slippage is bounded on every leg; throws rather than encode a zero/empty payload. `encodeRedeemHookData` (SELL): zero-fills `legMins` to the on-chain leg count and requires a positive aggregate `minOut` (the binding sell protection). Security-critical. |
| `swap-quote.ts` | **Tier-1 floor-derivation SDK** (pure, unit-tested). `buildSwapQuote` produces the broadcast-grade inputs: BUY legs priced off **net** post-fee USDC (matches `_acquireBasket`), decimals-correct, basket-ordered, non-zero floors, no-silent-zero; SELL is aggregate-`minOut` protected (no per-leg floors). The one source for both the preview and the signed tx. |
| `use-basket-swap.ts` | `useBasketSwap` — the **buy/sell broadcast** state machine: exact-amount ERC-20 approve → `swapExactIn` via the operator's swap router, same simulate→sign→confirm pattern as `use-fee-actions.ts`. Encodes via `encodeMintHookData` (buy) / `encodeRedeemHookData` (sell). Hard `SWAP_ENABLED` gate; inert until `swapRouter` is configured. The ABI is reconciled against the shipped reference router (§3.3 / `SWAP-ROUTER-REFERENCE.md`). |
| `use-basket-fees.ts` + `fee-model.ts` | `useBasketFees` (per-basket fee rate + creator share, read on-chain) + `useFeeBounds` (fixed protocol constants from `fee-model.ts`). |
| `history.ts` | Reconstructed NAV history (`NAV(t) = navNow · Σ wᵢ·priceᵢ(t)/priceᵢ(t₀)`), per-asset prices from Alchemy Prices → DefiLlama fallback. |
| `creator.ts` | Pure client-side creator-attribution fallback chain (X handle → display name → deployer address → basket address). No OAuth. |
| `format.ts` | Pure display helpers (`formatNav`, `formatUsdCompact`, `formatPct`, `shortAddr`, `formatAge`, `changeAccent`). No chain access. |
| `token-meta.ts` / `token-meta.generated.ts` | Cosmetic brand color/ink per constituent token (baked → hashed-hue fallback). `signature.ts` derives a per-basket signature color. |
| `token-search.ts` | Keyless DexScreener token search for the launch builder; chain-filtered, relevance-gated, liquidity-ranked. |
| `dev-fixture.ts` | DEV-only mock baskets (only when no factory is configured). Never in a production bundle. |
| `weights.ts` | Pure weight math (whole-% summing to exactly 100); `equalSplit`, `adjustWeight`, `addAsset`, `removeAsset`, `isValid`. |

**`lib/chain/` — address injection, chain registry, RPC.**

| Module | Role |
|---|---|
| `deployments.json` | The per-chain address book. **Ships empty by design.** Keyed by chainId (`"8453"` = Base). |
| `deployments.ts` | Resolves addresses: `VITE_*_ADDRESS` env overrides (default chain only) → JSON → `null`. The `addr()` guard coerces invalid strings to `null`. Now carries `swapRouter` (the buy/sell periphery; `VITE_SWAP_ROUTER_ADDRESS`, ships empty). |
| `chains.ts` | The chain registry: SCAFFOLDS (Base, Ethereum: viem chain, explorer, DexScreener slug) merged with deployments. `CHAINS`, `SUPPORTED_CHAIN_IDS`, `DEFAULT_CHAIN_ID`, `chainCfg`, `isPoolReady`. Never ships a zero-chain build. |
| `constants.ts` | Chain-agnostic constants only — **no addresses**. `BASE_CHAIN_ID=8453`, `MAINNET_CHAIN_ID=1`, `V4_POOLS_SLOT=6n`, explorer bases, zero/dead addresses. Fees are NOT constants here. |
| `rpc.ts` | RPC precedence (`VITE_BASE_RPC_URL` → Alchemy key → public node), per-chain singleton Multicall3-batched `PublicClient`s, `hasAlchemyKey()`. |
| `active-chain.ts` | Provider-less `useSyncExternalStore` module store for the "viewing chain," persisted to `localStorage['spectrum.activeChainId']`, independent of the wallet's connected chain. |

**`lib/config/` — flags + operator knobs.** `features.ts` (the four flags + fail-fast invariant); `operator.ts` (the interface-tag, launcher, and partner-URL parsers, with the load-bearing `address(0)` defaults — an unset interface/launcher means its fixed slice is simply not carved on-chain).

**`lib/pools/` — the launch routing engine.** `find-best-pool.ts` (scan V2/V3/V4 + Aerodrome-to-reject, deepest-liquidity ranking), `abis.ts` (DEX ABIs), `types.ts` (`Venue`, `BasketRoute`, `PoolDetectionError`), `index.ts` (barrel).

---

## 3. The contract-integration surface

This is the "connect to the backend" core. The FE layer is **read-only by design**: every contract read goes through `abis-v2.ts` and a per-chain viem `PublicClient`. The only state-changing FE call is `deployBasket` (gated). Mint and redeem are **not** named-selector calls — they are Uniswap V4 swaps carrying the FE-encoded `hookData`; the FE's transactional job is to encode that data correctly.

> **DRAFT status (must understand before deploying).** The ABIs in `abis-v2.ts` are a **draft**; the names are decided where settled, the rest is a proposal whose *semantics are requirements*. Before any deployment, bind these ABIs to the actually-deployed, verified contracts. **The fee-model binding has been reconciled to the contracts:** `deployBasket` arg order is `(salt, name, symbol, basket, startSqrtPriceX96, maxCost, feeConfig)`, the `FeeConfig` field is `basketFeeBps`, the `Launched` event emits `basketFeeBps`, and the per-basket `burnShareBps` + `increaseBurnShare` ratchet are **gone** (the burn is a fixed protocol constant — see [§3.5](#35-the-fee-model)). Remaining draft gap: the per-entry `decimals` is zeroed/re-derived on-chain by the factory. If the deployed contracts cannot provide a view with these semantics, that is a package-level flag — do not silently absorb it in the FE.

### 3.1 `abis-v2.ts` — the single integration point

File: `src/lib/spectrum/abis-v2.ts`. This is the *only* place contract ABIs live. Everything else imports from here. The V2 truths it encodes:

- Settlement asset is canonical Base USDC; no dStable anywhere.
- Fee config is **per-basket and immutable**: the creator picks `basketFeeBps` (bounded by `[MIN,MAX]_BASKET_FEE_BPS`) + `creatorShareBps` (0–30%, bounded by `MAX_CREATOR_SHARE_BPS`) + `creatorPayout` — that is their only fee choice; the `launcher` slot is operator-injected at deploy, never a creator dial. The PRISM burn share + interface/launcher kickbacks are **fixed protocol constants** (`fee-model.ts`), identical on every basket. **No per-basket burn share, no ratchet.**
- NAV is **statically readable**: `exchangeRate()`/`totalReserve()` are non-reverting `(value, fullyPriced)` display-grade marks.
- Mint/redeem require **non-empty `hookData` with per-leg minimums** (see `hook-data.ts`). The FE has **no** zero/empty legMins path.
- `redeemInKind(amount, legMask, to)` is the **unconditional exit** — constituents-out only, never touches USDC/pools.
- The factory **enumerates** baskets (`allBaskets`/`allBasketsLength`), so a keyless public-RPC build lists everything without log scans.
- Deploys are priced by a **Dutch auction**; there is **no `deployEnabled()` view** in V2 — **do not re-add one.** Whether the deploy broadcast is available is purely the FE build flag.

**The two shared tuple shapes (used by salt mining, deploy, and reads):**

```
BASKET_ENTRY = (address asset, uint8 venue,
                (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) ethPool,
                uint24 v3Fee, address v2Pair, uint16 weight, uint8 decimals)

FEE_CONFIG   = (uint16 basketFeeBps, uint16 creatorShareBps,
                address creatorPayout, address launcher)
```

**The hook-flag constants** (single source of truth for the salt miner): `HOOK_FLAGS_SUFFIX = 0x88n`, `HOOK_FLAGS_MASK = 0x3fffn` (low 14 bits).

### 3.2 Factory views & calls

All factory addresses resolve from `chainCfg(chainId).factory`; **every call no-ops to empty/null when the factory is unset** (the shipped default).

**Enumeration — the PRIMARY discovery path (keyless):**
- `allBasketsLength() → uint256`, then `allBaskets(uint256) → address` per index. An append-only public array; a plain public RPC serves the whole list with no log scans. Driven by `discoverBaskets` in `basket-data.ts`.
- **Fallback** when enumeration is unavailable: a bounded `Launched` log scan over the last ~60,000 blocks.
- No seed lists, no allowlists. No factory → the list is honestly empty.

**Attribution:** `tokens(address) → address deployer` — basket→creator map. One cheap read, permanently cached; `address(0)` → `null`. This is the only attribution source in V2.

**Protocol fee-model constants — FIXED, not factory getters.** The fee-model constants (`MIN_BASKET_FEE_BPS = 100`, `MAX_BASKET_FEE_BPS = 300`, `BURN_SHARE_BPS = 1000`, `INTERFACE_SHARE_BPS = 555`, `LAUNCHER_SHARE_BPS = 555`, `MAX_CREATOR_SHARE_BPS = 3000`, `CRANK_BOUNTY_BPS = 50`) are compile-time `constant`s identical on every basket and the factory — the factory exposes no getter for them. The FE mirrors them in `fee-model.ts` (`PROTOCOL_FEE_MODEL` / `FEE_BOUNDS`), documented as a mirror of verified bytecode. This is the one principled exception to "read, never hardcode": the launch builder needs the bounds on an EMPTY marketplace (no basket to read from), and an immutable protocol constant is not a settable parameter. The only genuinely per-basket fee field, `basketFeeBps`, is still read from the basket contract.

**Dutch auction:**
- `currentDeployPrice() → uint256`. Polled every 6s by `useDeployPrice`: success → `{ priceWei, slotOpen: true }`; revert (`SlotNotOpen()` between slots) → `{ priceWei: null, slotOpen: false }`. (The previously-declared `auctionStartPrice/Floor/SlotDuration` getters never existed on-chain and were dropped — SPEC exposes only `currentDeployPrice()` plus public `slotStartPrice`/`lastDeployBlock`.)

**`Launched` event** (enrichment + tx parsing): `Launched(address indexed basket, address indexed deployer, string name, string symbol, uint160 startSqrtPriceX96, uint256 ethPaid, uint16 basketFeeBps)`. Used by `getInceptionTs` (windowed `getLogs` to find the inception block timestamp, permanently cached, default OFF for list views to avoid a scan storm) and by `broadcast()` to parse the deployed basket address. The burn + interface + launcher shares are fixed constants and are NOT emitted here; the per-basket `creatorShareBps`/`creatorPayout`/`launcher` come from the token's `FeeConfigured` event.

**Deploy + salt-mining surface (`factoryDeployAbi`):**
- `deployBasket(bytes32 salt, string name, string symbol, BasketEntry[] basket, uint160 startSqrtPriceX96, uint256 maxCost, FeeConfig feeConfig) payable → address` — the single state-mutating entry. **Arg order is load-bearing** — `predictTokenAddress` recomputes the init-code from this exact tuple, so a mismatch makes the mined salt predict the wrong address.
- `predictTokenAddress(bytes32 salt, BasketEntry[] basket, address deployer, FeeConfig feeConfig) view → address` — recomputes the CREATE2 address. **The fee config is CREATE2-committed**, so it is a salt-mining input.

### 3.3 Per-basket views & calls

ABI: `basketAbi`. The basket token IS its own V4 hook + ERC-20 + LP on a {BASKET, USDC} self-pool.

**Immutable identity (read once per session, cached `staleTime: Infinity`):**
- `name()` / `symbol()` / `decimals()` (ERC-20).
- `basketLength() → uint256`, then `basket(uint256) → BASKET_ENTRY` per leg. The FE extracts `asset` (index 0), `weight`/targetBps (index 5), `decimals` (index 6). **Leg order is the frozen on-chain order** — `legMins`/`legMask` map positionally to `basket[i]`. Read order from chain; never assume input order.

**Static NAV views (non-reverting display-grade marks — `(value, fullyPriced)` pairs):**
- `exchangeRate() → (uint256 rate1e18, bool fullyPriced)` — NAV-per-token, 1e18-scaled USDC-per-token vs `effectiveSupply`. PRIMARY NAV source.
- `totalReserve() → (uint256 usdcValue, bool fullyPriced)` — total AUM in USDC (6-dec).
- `quoteLeg(uint256 i) → (uint256 usdcValue, bool priced)` — per-leg spot value. **ABI-declared but not currently consumed by the display layer** (reserved); NAV is derived from `exchangeRate`/`totalReserve`, not per-leg `quoteLeg`.
- `effectiveSupply() → uint256` — NAV denominator (excludes tokens pending burn); falls back to `totalSupply` when it reverts.
- **Which views the FE actually reads:** `exchangeRate`, `totalReserve`, `effectiveSupply`, `totalSupply`, `idleHeld`, `claimableFees`, and the live fee-state getters `feeReserve`/`pendingPrismBurn`/`pendingBasketBurn`/`pendingFrontendFees` (the `/flush` console, [§4.2](#42-pages--what-each-route-renders)) are **live read paths**; `quoteLeg` is **declared in the ABI but not currently called** by the display layer. Knowing the live-vs-placeholder split sharpens the "bind the draft ABI" guidance ([§3.1](#31-abis-v2ts--the-single-integration-point)) — you must provide working views for the live reads; `quoteLeg` can be reconciled later.
- These are **spot marks, not oracles** — manipulable, never used by mint/redeem math (which is execution-based). Each FE read is still wrapped `.catch(() => null)` for draft-ABI/RPC safety.

**Holdings & supply:**
- `totalSupply() → uint256` (mutable; always re-read).
- `idleHeld(address asset) → uint256` — the basket's tracked reserve per constituent (the donation-immune `idleHeld` mapping getter in `SpectrumBasket`; raw asset decimals). FE falls back to the constituent's `balanceOf(basket)` via `erc20BalanceAbi` only when the view is unavailable — but `balanceOf` is donation-inflatable, so the fallback can overstate; `idleHeld` is the truth. (Was previously bound to a non-existent `totalHeld` getter, so the read silently fell through to `balanceOf` against the real contract — fixed.)
- `claimableFees(address holder) → uint256` — settled+pending holder fee accrual.

**Live (mutable) fee state — the `/flush` console (`use-fee-state.ts`, distinct from the immutable config above):** `feeReserve() → uint256` (USDC backing settled holder accruals), `pendingPrismBurn() → uint256` (USDC awaiting the burn crank), `pendingBasketBurn() → uint256` (basket tokens in the lazy-burn queue), `pendingFrontendFees(address fe) → uint256` (per-recipient interface/launcher/creator accrual). All read fresh (`staleTime: 15s`), USDC-denominated except `pendingBasketBurn` (basket-token units). The console probes `pendingFrontendFees` for the basket's `creatorPayout` + `launcher` and the operator's `INTERFACE_TAG_ADDRESS`; an arbitrary recipient can also be flushed by hand.

**Fee-action write surfaces (`use-fee-actions.ts`, all `TRADING`-gated, same simulate→sign→confirm pattern as `useDeployBasket`):** `claimFees()` (holder pull-claim, no bounty), `flushPrismBurn(uint256 minEthOut)` (permissionless burn crank; `minEthOut` is the caller's slippage floor — the FE never forces a zero floor silently, it warns), `flushFrontendFees(address fe)` (permissionless; interface/launcher/creator all flush through here), `redeemClaims()` (permissionless lazy-burn settle, no bounty). The two flush cranks pay the caller `CRANK_BOUNTY_BPS`. (`flushRoutes()` is **removed** — there is no routing table.)

**Per-basket immutable fee config:** `basketFeeBps() → uint16` (the creator's chosen rate), `creatorShareBps() → uint16` (the creator's share of the post-burn remainder, 0–30%), `creatorPayout() → address` (where that share is pushed), and `launcher() → address` (the operator-injected launcher slot; `address(0)` = none). These are the per-basket fee getters. The burn + interface + launcher shares are fixed protocol constants (`fee-model.ts`), not per-basket getters, and there is **no `burnShareBps()` getter**. (`routesLength()`/`routes(uint256)` are **removed** — there is no routing table.)

**Unconditional exit:** `redeemInKind(uint256 amount, bool[] legMask, address to)` — the **only redeem selector in the FE ABI**. Constituents-out only, touches no pool/PoolManager/swap, deterministic pro-rata, no `minOuts`. The `bool[] legMask` lets the caller explicitly skip a frozen/reverting leg (masked legs' pro-rata stays in reserve for remaining holders — never a silent donation). `legMask.length` must equal `basket.length` and map positionally to on-chain leg order. (FE wiring for this surface is not yet built into the trading components.)

**Buy/sell swap — the swap router (`swapRouterAbi`).** A basket has **no USDC buy/sell method**: a trade is an external V4 `PoolManager.swap` into the basket's own `_beforeSwap`, which hard-reverts `MissingHookData`/`BadLegMinsLength` unless it carries the FE-encoded `(minOut, legMins[], frontend)` payload (one non-zero min per leg) — so a **generic aggregator cannot route it** (it sends empty hookData and reverts). The reference FE therefore swaps through a **first-party periphery router**, referenced in the swap-router reference maintained alongside the **contracts source** (a separate repo; not shipped in this frontend kit); the operator deploys it (or their own). The FE binds the **reconciled** entrypoint `swapExactIn(address basket, address tokenIn, uint256 amountIn, uint256 minOut, bytes hookData, address to) → uint256 amountOut` (`tokenIn` = USDC for a buy, the basket token for a sell) plus a `Swapped` event; it forwards the hookData **verbatim**. The router pulls `tokenIn` via `transferFrom`, so `use-basket-swap.ts` does an **exact-amount** `erc20ApproveAbi.approve(router, amount)` first (never infinite). Hidden behind the dedicated `SWAP_ENABLED` flag (default off) and inert until `swapRouter` is configured (`deployments.ts` ships it empty); the broadcast also hard-gates on `SWAP_ENABLED`. The FE `swapRouterAbi` matches the reference router; only deployment remains (the operator's, not this repo's). BUY ships non-zero per-leg `legMins` that bound slippage on every leg (`encodeMintHookData`); SELL ships length-correct zero `legMins` + the aggregate `minOut` as the binding floor (`encodeRedeemHookData`). See that swap-router reference (with the contracts source).

**Pool-state read:** `poolManagerAbi.extsload(bytes32 slot) → bytes32` — the V4 PoolManager storage reader. Pools live at mapping `V4_POOLS_SLOT = 6n`; Slot0 at `keccak(poolId . slot)`. Used by the pool engine.

**Mint / redeem (not direct selectors):** a mint is an exact-input V4 swap USDC→basket; a redeem is an exact-input swap basket→USDC. The basket-hook's `_beforeSwap` does the work (takes USDC/basket, charges `ceilDiv(amount × basketFeeBps, BPS)`, buys/unwinds constituents via V4/V3/V2 with per-leg `legMins` enforced). The FE's job is encoding the mandatory `hookData` ([§3.6](#36-the-hookdata-encoder--never-add-a-zero-slippage-path)).

### 3.4 The NAV model

Implemented in `basket-data.ts` (`getBasketData`) and `history.ts`. The model is **static views primary, DexScreener cross-check, reconstructed history**.

**Live NAV (`getBasketData`):**
1. **PRIMARY:** `exchangeRate()` → `navPerToken = formatUnits(rate1e18, 18)`, `navSource = 'onchain'`, `fullyPriced = priced`. `totalReserve()` → `aumUsd = formatUnits(usdcValue, 6)`.
2. **ALONGSIDE:** a DexScreener aggregate-spot reconstruction — per-constituent USD price (`fetchDexPrices`, deepest-liquidity pair, 30s TTL cache, 3-retry with backoff on 429/5xx), `reconAum = Σ balance×price`, `reconNav = reconAum / navDenom` (navDenom = `effectiveSupply` if > 0 else `totalSupply`). Canonical USDC constituent is pinned to $1 when no pair lists.
3. **CROSS-CHECK:** the **data layer** (`basket-data.ts`) computes `navDivergencePct = |onchain − recon| / onchain × 100` — only when `navSource === 'onchain'` and `reconNav > 0`. The **~2% threshold is a UI decision in the Token page** (`Token.tsx`), not in the data computation: the page surfaces a "marks diverge" warning above ~2%. The data layer exposes the number; the page chooses the threshold.
4. **FALLBACK:** if the static views are unavailable/zero, `navSource = 'reconstructed'` uses the DexScreener recon directly.

**Reconstructed NAV history (`history.ts`):** the basket token isn't priced by any feed, so history is reconstructed: `NAV(t) = navNow · Σ wᵢ·priceᵢ(t)/priceᵢ(t₀)`, anchored so the final point equals the current `navPerToken`. Per-asset USD history comes from the **Alchemy Prices API** (keyless from the bundle if `VITE_ALCHEMY_API_KEY` is set) with a **keyless DefiLlama fallback** (`coins.llama.fi`). Throttled (max ~6 concurrent), React-Query-cached per chain/addr/range so baskets sharing assets collapse to a few calls. Because the static views make this reconstruction unnecessary for simple display, it remains primarily for historical charts; short-window display series are a cosmetic DexScreener-anchored interpolation.

> **Operator implication.** History is *reconstructed*, not a stored feed — it is anchored to the current NAV and approximated from constituent price ratios. Treat charts as illustrative reconstructions, not an authoritative price record. There is no projection or backtest of hypothetical baskets anywhere, and none may be added.

### 3.5 The fee model

Implemented in `use-basket-fees.ts` + `fee-model.ts`. The **per-basket fee fields** are read on-chain; the **fixed protocol shares** (burn, interface, launcher, bounds) are mirrored from `fee-model.ts` (a documented mirror of verified bytecode — see §3.2).

- **Per-basket (immutable, cached `staleTime: Infinity`):** `basketFeeBps` (read from the basket; bail to `null` → the panel hides on failure), `creatorShareBps`, `creatorPayout`, and `launcher`.
- **Fixed protocol constants (`fee-model.ts`, never read per-basket):** `BURN_SHARE_BPS = 1000` (10% PRISM burn), `INTERFACE_SHARE_BPS = 555` (interface kickback slice), `LAUNCHER_SHARE_BPS = 555` (launcher kickback slice), `MAX_CREATOR_SHARE_BPS = 3000` (30% creator-share cap), `MIN/MAX_BASKET_FEE_BPS = 100/300` (the rate bounds). `useFeeBounds` returns these synchronously — no chain read, available on an empty marketplace.
- **Fixed burn:** every basket burns exactly `BURN_SHARE_BPS` of every pool mint/redeem fee — uniform, no per-basket dial, no ratchet (the basket has no deployer-controlled selectors over live state).
- **The `_distributeFee` waterfall (exact as-built order):** `afterBurn = fee × (BPS − 1000) / BPS` (the burn takes 10% **plus all rounding dust**). If a `frontend` tag rode the call (`!= address(0)`), `interfaceCut = afterBurn × 555 / BPS` is carved off `afterBurn`. If `launcher != address(0)`, `launcherCut = afterBurn × 555 / BPS` is carved off the **same** `afterBurn` (no compounding). `remainder = afterBurn − the cuts that were present`. `creatorCut = remainder × creatorShareBps / BPS` (pushed to `creatorPayout`). `toHolders = remainder − creatorCut`. **An unused interface or launcher slice is NOT carved** — it simply stays in `remainder` and flows to creator + holders.
- **Interface vs launcher:** the interface slice is **per-TX / conditional** — a tagged `frontend` must have ridden the call. The launcher slice is **per-basket** — named once at deploy (operator-injected, never a creator dial; `address(0)` = none). The FeePanel renders the interface/launcher lines only when each is present, framed as "disclosure, not promotion."

> **Quarantine reminder for any prose you add.** The holder slice (`toHolders`) is "accrues to the basket's holder fee reserve (claimable)" — never "holders earn/are paid/yield." The PRISM burn is "a fixed share routes to the burn path, which is wired and in-flight" — never "baskets burn" as a present fact.

### 3.6 The hookData encoder — never add a zero-slippage path

File: `src/lib/spectrum/hook-data.ts`. Same wire layout (`abi.encode(minOut, legMins[], frontend)`) for both paths, but **two distinct encoders**: `encodeMintHookData` (BUY) refuses any zero/empty per-leg floor, so every leg carries a live-derived minimum; `encodeRedeemHookData` (SELL) zero-fills `legMins` to the on-chain leg count and instead requires a positive aggregate `minOut` (the binding sell protection — the contract's per-leg sell floors are ETH/USDC-denominated + optional). The per-leg derivation that feeds the BUY encoder lives in `swap-quote.ts` (the Tier-1 surface).

**Draft layout (bind to the deliverable):** `abi.encode(uint256 minOut, uint256[] legMins, address frontend)`.

**SECURITY INVARIANT — stated affirmatively: per-leg minimums are ALWAYS derived from live quotes, and there is NEVER a zero/empty path.**

- `legMins[i] = quotedLeg[i] × (BPS − slippageBps) / BPS`, floor-rounded (`deriveLegMins`). They are always derived from the live per-leg quote captured at sign time.
- `encodeMintHookData` **throws** rather than degrade:
  - empty `quotedLegAmounts` → throws (`"refusing to encode without live per-leg quotes (no zero/empty legMins path exists)"`).
  - any leg quote `≤ 0` → throws (`"every leg must have a positive live quote at sign time"`).
  - any derived leg min that rounds to `0` → throws (`"a derived leg minimum rounded to zero — quote too small to protect; aborting"`).
- There is **no** zero/empty/placeholder legMins path — not for the first mint, not behind any "disable slippage" toggle (none exists), not as a fallback. Callers without live quotes cannot encode.
- **Never add a bypass.** The contract reverting on empty `hookData` is the backstop; the FE must never invite that revert nor work around it. Additionally, the contract mandates a non-zero floor on every swapped leg of the *first* mint — the FE encoder upholds the same intentionality. (The *adequacy* of a floor — independent price source, decimal handling, stale-quote bounds — is an off-chain concern the operator owns; the gate guarantees intentionality, not adequacy.)

**Slippage constants:** `DEFAULT_SLIPPAGE_BPS = 100` (1%), `MAX_SLIPPAGE_BPS = 500` (hard UI cap, 5%), `WARN_SLIPPAGE_BPS = 200` (warn above 2%); `clampSlippageBps` bounds to `[1, 500]`.

**Interface-kickback tag rides here:** `frontend = input.interfaceTag ?? INTERFACE_TAG_ADDRESS ?? zeroAddress`. `address(0)` = no tag → the interface slice is not carved and stays in the post-burn remainder (flowing to creator + holders). The empty default is load-bearing; there is **no** default recipient anywhere. `encodeMintHookData` returns `{ hookData, legMins, minOut, frontend }` — `legMins` is surfaced in the trade review step.

### 3.7 Salt mining (CREATE2 hook-address mask)

File: `src/lib/spectrum/salt-mining.ts`. The deployed basket token **is its own V4 hook**, so its address must carry the hook permission bits the PoolManager checks: the miner targets the suffix `HOOK_FLAGS_SUFFIX = 0x88` under `HOOK_FLAGS_MASK = 0x3fff` (the **low 14 bits**). In the code's own annotation this is `BEFORE_SWAP (1<<7) | BEFORE_SWAP_RETURNS_DELTA (1<<3) = 0x88`.

> **Draft caveat (belt-and-suspenders).** The exact hook-permission bits are part of the **draft ABI surface**. `0x88`/`0x3fff` are reproduced verbatim from `salt-mining.ts`/`abis-v2.ts` and are the single source of truth for the in-browser miner, but the deployed factory's `predictTokenAddress` is the authoritative oracle (the miner only accepts a salt it confirms) — verify the required suffix against the deployed factory before relying on the literal `0x88`.

- CREATE2 makes the address a pure function of `(factory, salt, initCodeHash)`. The init-code hash is fixed by the **basket + deployer + fee config** (the fee config is CREATE2-committed, so it is a mining input). Only `salt` is free.
- `hasHookFlags(addr)` = `(BigInt(addr) & 0x3fff) === 0x88`.
- **The oracle is the factory's own `predictTokenAddress(salt, basket, deployer, feeConfig)` view** — it reuses the exact on-chain init code, so the mined address is *guaranteed* to match the real deploy. No client-side init-code-hash reconstruction.
- `mineSalt`: random 32-byte salt base (so concurrent miners don't collide), then probes **60 per Multicall3 round-trip** (`batchSize = 60`). One up-front single probe fails loudly on a malformed basket / fee config / wrong factory rather than masquerading as "no salt found." Hit rate **1/16384 → ~16k probes expected**; `maxAttempts = 200_000` safety cap; abortable via `AbortSignal`; reports cumulative `attempts` via `onProgress`.
- What forces re-mining is the **new init-code hash** — from any change to basket/weights/deployer/fee config. **It also re-mines on any change to the contract bytecode** (see the bytecode-change warning in [§7](#7-known-technical-constraints--limitations)).

Surfaced to the user as the `HookForge` component (hex scrambles while mining with a live probe count, then locks onto the real mined address with the `0x88` tail lit).

### 3.8 The deploy engine

Files: `src/lib/spectrum/use-deploy.ts` (state machine + guard), `deploy.ts` (tx assembly + NAV math), `components/launch/DeployPortal.tsx` (ceremony UX).

**$1.00-NAV open price (`deploy.ts`).** The basket opens its own USDC/BASKET V4 pool at a $1.00-NAV **start price** — at inception 1 basket token initializes against 1 USDC, and the price floats with the constituents from the first trade onward. This is the one-time deploy-time pool initialization, **not** a standing peg and **not** a one-to-one redemption right (the unconditional exit is the mechanical `redeemInKind` swap, [§3.3](#33-per-basket-views--calls)). Uniswap encodes `sqrtPriceX96 = sqrt(amount1/amount0)·2^96` over *raw* units, and V4 orders currencies by address. Since USDC is $1, equal dollar value means equal unit counts; only the **decimal gap** (USDC 6, basket 18) sets the ratio. `startSqrtPriceX96ForDollarNav` branches on `usdcAddr < basketAddr` to choose currency0, then computes `isqrt(10^dec1 · 2^192 / 10^dec0)` with a bigint Newton's-method `isqrt` (floors like Solidity). The basket address fed in **must be the mined one** — its sort order vs USDC decides currency0.

**Two-phase deploy (`useDeployBasket`).** State machine: `idle → mining → preparing → ready → signing → confirming → success | error`.

`prepare(input)` — read-only, runs the whole ceremony with no signature:
1. `toBasketEntries` (asserts Σ = 10000 bps).
2. `mineSalt` → `{ salt, predicted }` (a `0x88` address).
3. `startSqrtPriceX96ForDollarNav(predicted, usdc)`.
4. **Dutch-auction price read** via `currentDeployPrice()`. A revert (`SlotNotOpen()` between slots) surfaces as "Auction slot is not open yet — one deploy per slot."
5. **Simulate-then-broadcast:** `simulateContract(deployBasket, …, value: priceWei)` against the live factory + connected account, so a doomed deploy fails *here, before any signature*. Skipped if no wallet.
6. Stashes a `Prepared` value in a `useRef`, lands in `ready`.

`broadcast()` — the only state-changing call:
- **Hard runtime guard:** `if (!DEPLOY_ENABLED)` short-circuits to an error state with the exact message `Basket deploy is disabled on this build (set VITE_ENABLE_DEPLOY).` — independent of all UI gating, "the last line of defense against an accidental deploy — keep this guard through every refactor."
- Requires a wallet connected on the active chain.
- `writeContractAsync(deployBasket, args:[salt, name, symbol, basket, startSqrtPriceX96, priceWei, feeConfig], value: priceWei, chainId)` (`feeConfig` LAST, after the price args — matching the SPEC tuple order). **`maxCost == priceWei`** is a tight overpay guard: the Dutch price only *falls* within a slot, so the shown price lands; if a new slot opened it reverts (no overpay).
- Waits for the receipt, `parseEventLogs` the `Launched` event, extracts the deployed `token` (preferring the log whose `deployer` matches), lands in `success`. On success the flow navigates to `/token?addr=…&deployed=1`.

**The gate (`useDeployBasket`):** `enabled = DEPLOY_ENABLED && isConnected && walletChainId === chainId`. There is **no `deployEnabled()` contract view** — the gate is purely the FE build flag (plus the independent runtime guard above). The deploy ceremony (`DeployPortal`) narrates the live state and shows the real mined hook address + auction price even when `deploy.enabled` is false (an honest preview: *"Basket deploy is off on this build — but the hook address and auction price above are real, not a mock"*).

> **Known constraint (state it affirmatively in ops):** the `Prepared` value from `prepare()` is held in a ref; `broadcast()` re-checks `DEPLOY_ENABLED` and wallet/chain but does **not** re-verify that the Dutch price hasn't moved. It relies entirely on `maxCost == priceWei` (a reopened slot → revert, no overpay). This is by design and safe — a stale `ready` state simply reverts on broadcast; the recovery is to re-run `prepare()`.

### 3.9 Pool detection (the launch routing engine)

File: `src/lib/pools/find-best-pool.ts`. When an asset is added in the builder, `findBestPool(asset, chainId)`:

1. **Honest no-config failure:** if `deployments.json` ships empty (the default), `isPoolReady` is false and it throws a `PoolDetectionError('No chain deployment is configured…')` rather than silently degrading.
2. Rejects ETH/WETH as an asset.
3. **Scans V2/V3/V4 in parallel against ETH/WETH:** V2 (`getPair`, depth = real WETH reserve), V3 (sweeps the four standard fee tiers 100/500/3000/10000, depth = actual WETH balance), V4 (discovery by `Initialize` logs filtered on `(currency0=NATIVE_ETH, currency1=asset)`, depth from PoolManager `extsload` storage reads → a virtual ETH-side reserve).
4. **V4 rejections:** only **no-hook pools** (`hooks == 0x0`) can be routed (a hooked pool can't host Spectrum's own hook); **dynamic-fee pools are rejected** (`fee == DYNAMIC_FEE_FLAG`).
5. **Aerodrome detection-to-reject:** if no Uniswap pool is found, it checks Aerodrome and throws `ONLY_AERODROME` (*"Aerodrome can't host Spectrum's V4 hook"*). Aerodrome is never a routing venue; it is detected only to give an accurate error.
6. **Deepest-liquidity ranking:** `depthEth` is **not comparable across venues** (V2/V3 are real reserves; V4's virtual reserve inflates concentrated liquidity), so it fetches **real USD pool TVL from DexScreener** and ranks DexScreener-listed pools above unlisted dust, then deepest USD, falling back to on-chain ETH depth for unlisted pools.
7. Returns a `BasketRoute` — exactly the routing tuple a `deployBasket` entry needs.

**Keyless V4-scan degradation (load-bearing honesty mechanism).** V4 discovery needs a wide filtered `getLogs` over the full block range. Public RPCs choke on it; only Alchemy-class endpoints serve it fast. Without a key (`hasAlchemyKey()` false), V4 scanning is **skipped entirely** and a `partial: true` flag propagates into `warnings`, surfaced **prominently** in the weights step as an amber `role="alert"` box *above* the weighting controls (the depth ranking the creator is trusting may be missing whole V4 venues). Note: any Alchemy key in this static/IPFS build ships in the bundle and is therefore public — use an origin-restricted key or a read proxy.

---

## 4. Per-feature tech specs

### 4.1 App shell, routing, gating

**`main.tsx` → `App.tsx`.** `main.tsx` mounts `<App/>` in `<StrictMode>`. `App.tsx` wraps everything: `WagmiProvider` (config from `wagmi.ts`) → `QueryClientProvider` (one `QueryClient`) → `BrowserRouter` → a `RouteTitle` side-effect (sets `document.title` per path) → a lazy `SpectrumBackground` (WebGL, off the critical path, null fallback) → `<Layout>` wrapping `<Routes>`. Every page is `React.lazy` code-split with a spinner fallback (`RouteFallback`). Fully client-side SPA — **hosting needs a catch-all rewrite to `index.html`** (see `03-IMPLEMENTATION.md`).

**Route table:**

| Path | Page | Notes |
|---|---|---|
| `/` | Home | landing + TVL-sorted directory preview |
| `/explore` | Explore | full searchable catalogue |
| `/token?addr=0x…&chain=<id>` | Token | single-basket detail (query-param driven; `chain` defaults to 8453) |
| `/creator/:address` | Creator | dynamic path param = deployer address |
| `/portfolio` | Portfolio | **WALLET-gated** (redirects home when off) |
| `/launch` | Launch | basket builder (never hidden; only the broadcast is gated) |
| `/swap` | Swap | **SWAP-gated** (`VITE_ENABLE_SWAP`; redirects home when off — hidden by default); a basket picker (search over all baskets) + the same buy/sell `TradePanel` the Token page mounts. Inert until a `swapRouter` is configured |
| `/flush` | Flush | **TRADING-gated** (redirects home when off); per-basket fee console — holder claim + the four permissionless cranks, with a basket picker |
| `/faq`, `/learn` | Faq, Learn | static content |
| `/docs`, `/docs/valuation` | Docs | same component, two paths |
| `/terms`, `/privacy`, `/risk` | Terms, Privacy, Risk | placeholder pages |
| `/post-deploy-test` | PostDeployTest | **DEV-ONLY** — route + import both null in prod |
| `*` | NotFound | branded 404 |

Browser-tab titles come from a `ROUTE_TITLES` map; `/creator/*` falls back to "Creator · Spectrum," everything else to "Spectrum · onchain baskets." These are tab titles only — the static `index.html` title/OG is what crawlers see.

**`Layout.tsx`.** Flex column: `<Nav/>` (sticky) → `<main>` (centered, `max-w-6xl`) → `<footer>` (secondary nav + a site-wide disclaimer + a decorative "capture · launch · settle" left-rail on xl screens). Two design notes live here as comments: the removed "powered by PRISM" footer tagline (a promotional-surface concern — keep it removed) and the disclaimer placeholder.

**`Nav.tsx`.** Sticky, backdrop-blur header. Left: `PrismMark` glyph + `SpectrumWordmark` (the `PrismMark` is noted as a brand-coupling surface). Center (md+): flag-conditional menu — always Explore/Launch/FAQ; `/swap` only if `SWAP_ENABLED` (placed right after Explore); `/portfolio` only if `WALLET_ENABLED`; `/flush` only if `TRADING_ENABLED`. Right: `NetworkToggle`, then `WalletButton` only if `WALLET_ENABLED`, then a hamburger drawer (closes on route change / Escape). **Launch is always in the nav** regardless of `DEPLOY_ENABLED` (read-only/preview until the flag arms the broadcast).

**`NetworkToggle.tsx`.** Pill toggle over `SUPPORTED_CHAIN_IDS`, **Base-first** (Base `8453` leads as the primary chain; env-activated chains follow). Sets the app's viewing chain via `useActiveChain` and, if a wallet is connected, also calls wagmi `switchChain` (rejection swallowed; viewing chain still changes). **Auto-hides when ≤1 chain is active** — the shipped default is Base-only, so by default this control does not render. Activate a second chain via `VITE_EXTRA_CHAIN_IDS` (e.g. `=1` for Ethereum) to surface the Base⇄Ethereum toggle.

**`WalletButton.tsx`.** Rendered in Nav only under `WALLET_ENABLED` (reused inside Portfolio's connect-gate). Connected → shortened address, click disconnects. Disconnected → modal listing wagmi connectors (de-duped by lowercased name for EIP-6963), **ordered Rabby → MetaMask → other named wallets (Coinbase, …), with the WalletConnect QR and the generic "Injected" catch-all last** (a display preference via a local `rank()` map — named wallets appear only when actually installed). Empty state suggests installing Rabby/MetaMask/Coinbase Wallet. No WalletConnect project required; pure injected/EIP-6963 discovery (WalletConnect added only if `VITE_WALLETCONNECT_PROJECT_ID` is set).

**Gating behaviors differ by surface (memorize this matrix):**

| Surface | When its flag is OFF |
|---|---|
| Nav links (Portfolio→WALLET, Flush→TRADING) | **Hidden** |
| Portfolio page | Hard **redirect** `<Navigate to="/" replace/>` |
| Flush page | Hard **redirect** |
| Token page `TradePanel` | **Not rendered** (page still fully usable for read/analytics) |
| Launch page | **Never** hidden/redirected — preview+pipeline run read-only; only `broadcast()` is gated |

### 4.2 Pages

**`/` Home (`pages/Home.tsx`).** Cinematic hero (`ConceptOrbit` converging-assets animation behind the wordmark, "Onchain baskets · Base" badge), CTAs to Launch/Explore, then a directory preview. Data: `useAllBaskets()` (AUM-sorted across configured chains); renders the largest as a `TopBasket` bento + next 6 as a `BasketGrid` + "Explore all N →". Empty state (`!top`) is honest ("No baskets launched yet on this network… enumerated straight from the factory contract") — **on a fresh/empty deployment this is correct, not a bug**; in DEV the mock fixture fills it. No gating.

**`/explore` Explore (`pages/Explore.tsx`).** Search (name/ticker/address/deployer), chain filter (pills appear only if both Base and ETH baskets exist), sort (AUM / 24h change / name A–Z), grid⇄list toggle. Data: `useAllBaskets()`. TVL sort leads with a `TopBasket` bento; other sorts use `BasketGrid`; list view uses `BasketListRow`. Sorts are objective-metric only; filters are chain-only — no platform taxonomy. Error copy hints at RPC rate-limiting (use an origin-restricted key/read proxy). No gating.
  - **Masthead** is a two-column layout: the spectral "EXPLORE" title + intro on the left (eyebrow → title → copy stagger via the `.enter` cascade), and a **2×2 live-stat panel** on the right — Total value / Baskets / Creators / Networks, each with an accent icon (cyan / violet / teal / amber) and a hairline that fades in on hover. Values are `useCountUp` + `tabular-nums`. On mobile the panel drops full-width under the title.
  - **Toolbar** is one frosted `card-surface` bar (sticky under the nav) — search · sort · view in a single row on desktop (hairline dividers between segments), stacked on mobile. The search advertises a `⌘K` badge and **`⌘K`/`Ctrl-K` focuses + selects it** (a window keydown listener, cleaned up on unmount); a clear-✕ replaces the badge while typing and re-focuses the input.
  - **Results header** shows the live count and, when no filter is active, an objective sort caption (`SORT_CAPTION`: "Largest by total value" / "Biggest 24h move" / "Alphabetical") that stays truthful to the active sort — never an editorial pick; a Clear control replaces it while filtering.

**`/token Token (`pages/Token.tsx`).** One basket: signature-colored header, NAV price (count-up) + 24h change, NAV-source label (on-chain vs reconstructed, "not fully priced" flag, > 2% divergence warning), full-width `BasketChart`, `BasketStats`, `HoldingsView`, and a right rail (optional partner CTA, `TradePanel`, `FeePanel`, contract chip + explorer link + a note that everything works by direct contract access incl. `redeemInKind`). Data: reads `addr`/`chain` from the query string (`chain` defaults to 8453); `useBasketData(addr, chainId)`; creator via `resolveCreator`. Gating: `TradePanel` only if `SWAP_ENABLED` (its buy/sell button broadcasts via `use-basket-swap.ts`/the swap router when a `swapRouter` is configured, else it shows its preview-only state); the "Visit $SYMBOL" partner CTA only if `VITE_PARTNER_APP_URL` is set. No address-missing redirect — instead a Notice. If `?deployed=1`, shows a celebratory `LaunchBanner` at the top. This is also the landing spot after a launch.

**`/creator/:address` Creator (`pages/Creator.tsx`).** A deployer's profile: identity header (address copy chip + optional X link), stat tiles (Baskets, Total value, Chains), and a grid of every basket they launched. Data: `useCreatorProfile(address)` — pure aggregation over the cached `useAllBaskets()` list (no extra network). Identity is the on-chain deployer address only (no curated metadata registry). No gating.

**`/launch` Launch (`pages/Launch.tsx` → `components/launch/BasketBuilder.tsx`).** The most complex feature — a 6-step progressive-reveal builder. See [§4.3](#43-significant-components--hooks). Never hidden/redirected; only the final `broadcast()` is gated by `DEPLOY_ENABLED` + the runtime guard.

**`/swap` Swap (`pages/Swap.tsx`).** The dedicated buy/sell surface. Gating: `if (!SWAP_ENABLED) return <Navigate to="/" replace/>` (the page stays in the tree; hidden by default). Routes by `?basket=&chain=`: **without** a basket, a **picker** — `useAllBaskets()` heads (superseded versions rolled up) with a name/ticker/address search box, each row a NAV-priced deep-link; **with** a basket, a console (basket header + Basket-page/Explorer links) wrapping the **same `TradePanel`** the Token page mounts, in a centred `max-w-md` column. One shared `TradePanel` ⇒ the per-index widget and `/swap` never diverge. The broadcast itself rides `use-basket-swap.ts` (the swap router, [§3.3](#33-per-basket-views--calls)); inert until `swapRouter` is configured. In `npm run dev` the picker + console render off the mock fixture.

**`/portfolio` Portfolio (`pages/Portfolio.tsx`).** Held baskets (balance × NAV, total-value hero) + baskets the wallet deployed. Data: `useAccount()` + `usePortfolio(address)` — the per-wallet balances are the only fresh read; held/created lists and NAVs ride the cached `useAllBaskets()`. Gating: `if (!WALLET_ENABLED) return <Navigate to="/" replace/>`; when enabled-but-disconnected → `ConnectGate` (renders `WalletButton`). Read-only — gated on WALLET, **not** TRADING. Also renders an **asset look-through** (`PortfolioExposure` + the pure `computeExposure` in `lib/spectrum/exposure.ts`): the held baskets decomposed into net per-asset exposure (each holding's `valueUsd` × its constituents' weights, aggregated by `chainId:address`), shown as a stacked composition bar + a bento grid (the two largest assets get the wide tiles; each: net %, USD, basket-count, brand-colour glow), and summarised as an allocation donut (a conic-gradient ring of the per-asset brand colours) in the summary rail. **Two weighting bases, switched by a Target/Live segmented toggle on the section header:** *Target* (default, **zero-fetch** — the immutable designed `top` weights already on the cached summary) and *Live* (the actual current pool weights, which drift from target as prices move — one fresh `getBasketData` per held basket via `useLiveExposure(holdings, enabled)`, gated so it costs nothing until the user opts in, keyed identically to `useBasketData` so it dedupes with any open detail page). A basket whose live read isn't ready falls back to its target legs (never dropped); the caption flags it (`ExposureBreakdown.fellBackCount`). Each exposure card is **expandable** (the "in N baskets" chip is the toggle) into a **per-asset drill-down** — which held baskets contribute the asset, each as a `valueUsd` + share-of-asset row (a brand-coloured bar) linking to that basket's `/token` page (`AssetExposure.contributions`, already returned by `computeExposure`). Target basis stays pure/synchronous with **no extra reads** beyond what `usePortfolio` loads. The page sits in `Layout`'s standard `max-w-6xl` `<main>` (same width as every other page). A prominent top-centre **Owned / Created** toggle (`ViewToggle`, each tab carrying its count) switches the main column: **Owned** = the exposure bento + value-forward held-basket cards (`HoldingCard` — avatar, USD value, token balance, 24h delta in the cyan-up/magenta-down convention); **Created** = the launched-basket grid; each card renders an owner **Manage** bar (`BasketAdminBar`) inside `BasketCard`'s optional `footer` slot (a flush footer on the card surface, above its whole-card link) — self-actions: **New version** (`/launch?from=…`, shown only when the `DEPLOY` flag is on — the immutable-basket evolution path), **Claim fees** (`/flush`, shown only when the `TRADING` flag is on), **Explorer** link, **Copy address**. The toggle **smart-defaults to Created** when the wallet only launched and holds nothing (else Owned). A sticky left summary rail (total balance, the allocation donut, stat tiles for held / created / networks) persists across both views. Dev preview: `getUserHoldings` returns `devUserHoldings()` sample balances under `import.meta.env.DEV`, and Portfolio substitutes a `DEV_PREVIEW_ADDRESS` so the page renders populated in `npm run dev` — both prod-stripped (mirrors the basket fixtures).

**`/flush` Flush (`pages/Flush.tsx`).** A per-basket **fee console**, now wired (replacing the former stub). Routes by `?basket=&chain=` query params: with a basket, the console; without, a **picker** of the wallet's created + held baskets (`usePortfolio`), each deep-linking in. The Portfolio created-basket admin bar's "Fees & cranks" action deep-links here; in `npm run dev` it falls back to `DEV_PREVIEW_ADDRESS` so it renders populated. The console reads live state via `useFeeState` and acts via `useFeeActions` (the simulate→sign→confirm pattern; each action carries its own keyed tx state, so several flushes can be in flight). It surfaces:
- **Your accrued fees** — `claimableFees(holder)` → `claimFees()`. A pull, no bounty; a blocklisted holder blocks only their own claim. Shows the `feeReserve` backing claims.
- **PRISM burn** — `pendingPrismBurn` → `flushPrismBurn(minEthOut)`. The `minEthOut` slippage floor is an advanced input (ETH); left empty it's `0` (the FE passes `0n` verbatim — the contract treats it as no protection). The "no slippage floor set" MEV warning renders **always** (not gated behind the advanced panel) whenever a zero floor would be submitted, so a zero floor is never sent unwarned. Below the bridge threshold the contract reverts and the message surfaces.
- **Interface, launcher & creator fees** — `pendingFrontendFees(fe)` per known recipient (`creatorPayout`/`launcher`/`INTERFACE_TAG_ADDRESS`) → `flushFrontendFees(fe)`, plus an advanced free-form recipient input (the crank is keyed by an arbitrary `fe`).
- **Redemption claims** — `pendingBasketBurn` → `redeemClaims()`. Pure maintenance (settles the lazy-burn queue); no bounty.

The two flush cranks pay the caller a `CRANK_BOUNTY_BPS` bounty; `claimFees`/`redeemClaims` pay none. (`flushRoutes()` is **removed** — there is no routing table.) Hard-gated: `if (!TRADING_ENABLED) return <Navigate to="/" replace/>` in the page **and** a `TRADING_ENABLED` guard in `useFeeActions` (broadcast refuses regardless of UI state). Inert by default — actions are disabled until a wallet is connected on the right chain on a trading build.

**`/faq`, `/learn` (`pages/Faq.tsx`, `pages/Learn.tsx`).** Static informational copy (both carry quarantined-language banners reminding editors to keep the copy neutral). Learn = 6 sections (basket tokens, the token-is-the-pool mechanism, per-basket immutable fee = creator-set rate + fixed protocol burn + creator remainder, "built without the seam," launch, the PRISM burn mechanism — burn copy uses the routing/in-flight form, never present-tense "burns"). Faq = accordion groups. No data, no gating.

**`/docs`, `/docs/valuation` (`pages/Docs.tsx`).** Integrator/developer guide for reading a basket (static NAV views, aggregate-spot cross-check/fallback, per-basket fee ABI, hookData/legMins encoding, in-kind redemption, factory enumeration, direct contract access, gotchas). Copyable code blocks bound to the draft V2 ABI. §10 explicitly states the package ships no contract addresses and points to `OPERATORS.md`. Both routes render the same component. No data, no gating.

**`/terms`, `/privacy`, `/risk` (`Terms.tsx`, `Privacy.tsx`, `Risk.tsx`).** All use `LegalDoc`/`LegalSection` and carry explicit "PLACEHOLDER — not legal advice" banners. Terms includes a placeholder eligibility section (the doc notes a static site cannot enforce it). Risk covers loss/no-guarantees/smart-contract/creator-issuer/concentration-liquidity/pricing-data/exit-mechanics (framed as a mechanical `redeemInKind` swap, never a "fund redemption right"). **These are placeholders to finalize before any public build.** No data, no gating.

**`*` NotFound (`pages/NotFound.tsx`).** Branded 404 with `PrismMark` + Home/Explore buttons. No data, no gating.

### 4.3 Significant components & hooks

#### The basket builder — `components/launch/BasketBuilder.tsx`

A single ~1,500-line component holding all builder state. **No router stepper** — a monotonic progressive-reveal driven by data validity: a `level` (1–6) is computed each render and `maxStep` only ever increases. Each `Step` renders nothing until `maxStep >= index`. A `Stepper` rail gives keyboard-accessible jump-to anchors.

| # | Step | Reveal gate | "Done" condition |
|---|---|---|---|
| 1 | Add assets | always | `assets.length >= 2` |
| 2 | Set weights | ≥1 asset | weights valid + ≥2 assets |
| 3 | Set the fee | weights valid | `feeValid` |
| 4 | Review basket | fee valid | explicit "Confirm basket" click |
| 5 | Name your basket | confirmed | name ≥2 chars + symbol `^[A-Z0-9]{2,11}$` |
| 6 | Deploy | named | `readyToDeploy = canDeploy && acknowledged` |

- **Step 1 — assets:** `AssetSearch` (debounced 250ms DexScreener `/latest/dex/search`, chain-filtered, relevance-gated, dedup, liquidity-ranked; paste a full `0x…` to add directly) + `PopularAssets` (candidates = actual constituents of live baskets, re-ranked by deepest DexScreener liquidity; **deliberately no price-performance ranking / no "Trending +X%" badges** — an inducement, not information). Each added asset runs `findBestPool` ([§3.9](#39-pool-detection-the-launch-routing-engine)) with liquidity-tier warnings.
- **Step 2 — weights (`weights.ts` + `WeightStrip` + steppers):** pure functions over a `number[]` of whole-percent weights that always sum to exactly `CAP = 100` (`STEP = 5`, `MIN = 5`, `MAX_ASSETS = 20`). Three editing surfaces (± steppers + typeable cell, "Equal weight" button, the tactile `WeightStrip` drag-the-shared-edge). Because weights are whole-% summing to exactly 100, the bps conversion (`pct × 100`) has **no rounding drift** — Σ bps is exactly 10000 (asserted in `toBasketEntries`). The same array must feed both the salt miner and `deployBasket`. Per-leg liquidity warnings (`liqTier`) + a "Recheck pools" / "Set N%" nudge; `BasketHealth` shows mechanical concentration + an aggregate slippage estimate for a $1k reference mint — **factual liquidity math, not a performance projection** (keep that framing).
- **Step 3 — the immutable fee:** set once at deploy, **immutable forever** (CREATE2-committed). The creator sets **two** things: the total fee (bounded by `MIN`/`MAX_BASKET_FEE_BPS` = 100/300; the suggested midpoint is "your choice, not a recommendation") and a single `creatorShareBps` — the creator's share of the post-burn remainder, `0–30%` (capped by `MAX_CREATOR_SHARE_BPS`), pushed to `creatorPayout` — with **no default creator allocation and no recommended split** (neutrality); holders get the rest (a `≥70%` floor of the remainder). The **PRISM burn share is shown read-only** as a fixed protocol constant (`BURN_SHARE_BPS` = 10%, uniform on every basket — there is no per-basket input and no ratchet). Disclosure of the fixed `INTERFACE_SHARE_BPS` interface kickback and the `LAUNCHER_SHARE_BPS` launcher slice (both conditional, carved from the post-burn remainder). The interface-kickback default is empty (`address(0)`) → the slice stays in the remainder; never suggest a default recipient.
- **Step 4 — review:** renders the exact fee facts as the live Token `FeePanel` will ("what you see is what deploys"); the only non-reactive gate (a "Confirm basket" click).
- **Step 5 — name:** live token-card preview; ticker `^[A-Z0-9]{2,11}$`; optional creator handle/name/avatar/banner held in the **local draft** while editing (no tagline/description inputs — long-form prose lives off-platform on the creator's own channels). The on-chain name + ticker are always what other interfaces see; the profile fields become a creator-visible identity only once **published** (signed + persisted) in the post-deploy ceremony (§4.5) — until then a basket attributes to its deployer address. A `name`/`symbol` matching `\b(fund|etf|index)\b` triggers a **non-blocking** legal-risk hint ("the protocol does not censor names").
- **Step 6 — deploy:** checklist + `HookForge` salt-mining readout + a **deployer self-attestation checkbox** that gates the launch CTA (`readyToDeploy = canDeploy && acknowledged`). The checkbox copy is placeholder text and "must survive every refactor." On a successful on-chain deploy the `DeployPortal` then runs the skippable **publish ceremony** (§4.5) before navigating to the new basket.
- **Draft autosave:** the whole in-progress basket is persisted per chain to `localStorage['spectrum:launch-draft:v2:<chainId>']`, restored on mount/chain-switch, cleared on successful deploy or "Start fresh." **The legal acknowledgment is deliberately NOT persisted** — re-checked every session.
- **Deploy trigger:** "Deploy →" calls `startDeploy` → opens the `DeployPortal` ceremony and runs `useDeployBasket().prepare()` (all read-only). The actual `broadcast()` is double-gated (build flag + runtime guard, [§3.8](#38-the-deploy-engine)).

#### Launch sub-components

- **`HookForge.tsx`** — the salt-mining readout (scrambling hex → locked `0x88` address + live probe count).
- **`DeployPortal.tsx`** — a full-screen rAF-driven ceremony (orbs orbit → bunch → drop through a "portal" → "Basket Deployed" → reveal card). A **real-time backstop timer** forces the reveal even if rAF is throttled (backgrounded/headless tab). The reveal card narrates the live deploy state and shows the real mined hook address + auction price even when deploy is off. Navigates to `/token?addr=…&deployed=1` on real success.
- **`LiveTokenCard.tsx`** — the live name/ticker/color preview. **`WeightStrip.tsx`** — the drag-to-rebalance strip. **`AssetSearch.tsx`**, **`PopularAssets.tsx`**, **`BasketHealth.tsx`**, **`MintOrb.tsx`** — as described above.

#### Transactional surfaces (TRADING tier)

- **`TradePanel.tsx`** (gated by `SWAP_ENABLED`; not rendered otherwise — hidden by default). Local `side`/`amount`/`slippageBps` state. `useBasketFees` supplies the fee fraction (read from chain). Estimated out: buy = `amt·(1−feeFrac)/navPerToken`, sell = `amt·navPerToken·(1−feeFrac)`; aggregate `minOut = out·(1−slippageBps/10000)`. Slippage presets 0.5%/1% + custom, clamped to `[1, 500]`, warn above 2%. A collapsible **per-leg minimums preview** mirrors exactly what `hook-data.ts` encodes — one `trade` memo feeds both the preview and the signed tx. **There is no "disable slippage" toggle and no zero/empty-leg path.** The action button is wired (`SwapAction` → `use-basket-swap.ts`): with no `swapRouter` configured it stays **inert** ("Preview only — this build does not broadcast transactions"); with one configured it is approve→buy/sell with a tx-status line, and the side toggle + amount input lock while a tx is in flight (no double-submit).
- **`FeePanel.tsx`** (no flag — renders on every Token page; the *interface-kickback line* is config-gated by `INTERFACE_TAG_ADDRESS`). Reads via `useBasketFees`; renders the creator's total fee (the "creator-set" rate) alongside the fixed PRISM burn share (labelled "fixed · same on every basket" — no floor line, no ratchet chip), the conditional interface and launcher slices, the creator share (`creatorShareBps` → `creatorPayout`), and the holder floor (the remainder, "accrues to the holder fee reserve (claimable)"). The interface/launcher disclosures render only when each is present ("disclosure, not promotion").

#### Read-only / display components

- **`HoldingsView.tsx`** — a basket's constituent breakdown (bento/treemap + list). Symbol/price/24h/live-vs-target weight (drift label ≥0.5%)/per-leg USD; rows deep-link to DexScreener. No reads of its own.
- **`BasketBento.tsx`** — the flagship visualization: a basket as a squarified treemap (`lib/treemap.ts`, tile area scales by `weight^0.65` so a dominant holding doesn't eat a column while labels always show the true weight). `ResizeObserver`-measured. The reusable centerpiece (used by `TopBasket`, `BasketListRow`, `LaunchBanner`, and the builder).
- **`BasketCard.tsx` / `BasketGrid.tsx` / `BasketListRow.tsx` / `TopBasket.tsx`** — directory presentations. `TopBasket` is the "Largest by total value" spotlight — selection is **purely by the objective TVL metric**, framed factually with **no buy CTA** ("analytics display, not editorial curation" — the implementation of the no-curation rule).
- **`BasketChart.tsx` / `BasketSpark.tsx` / `SpectralSparkline.tsx`** — NAV charts (Recharts with `isAnimationActive={false}`; the sparkline is dependency-free SVG). **`BasketStats.tsx`** — 6-up metric grid incl. "Priced N/M" with an amber warning when not fully priced.
- **`BasketAvatar.tsx` / `AssetLogo.tsx` / `AssetHoverCard.tsx`** — identity/logos. `AssetLogo` hotlinks the DexScreener token-icon CDN (ethereum/base slugs only) with an initials fallback — a third-party runtime dependency.
- **`ChainBadge.tsx`** — cosmetic per-chain identity chip. **`SpectrumBackground.tsx`** — the lazy, reduced-motion-gated WebGL background (the main render cost on weak GPUs; the page is fully functional without it).
- **`DocKit.tsx`** — the in-app technical-doc toolkit (`CodeBlock`, `Callout`, `CopyChip`/`CopyButton`, `DocSection`, `Table`, `Checklist`, `Toc`, `IC`) used to render the in-app **Docs / Learn** pages. Pure presentation, no chain reads.
- **`ConceptReveal.tsx`** — exports `ConceptOrbit` (the homepage "many assets converge into one token" convergence animation behind the wordmark) and the `ConceptReveal` wrapper. Reduced-motion-safe and fully decorative.

#### Core hooks (`lib/spectrum/hooks.ts`)

| Hook | Reads | Refetch / cache |
|---|---|---|
| `useAllBaskets()` | `listAllBaskets` (factory enumeration → per-basket reads, AUM-sorted) | `staleTime 60s`, `refetchInterval 120s` |
| `useBasketData(addr, chainId)` | `getBasketData` (immutable cached + mutable NAV + DexScreener cross-check) | per-basket |
| `useCreatorProfile(address)` | pure aggregation over the cached `useAllBaskets()` | derived, no fetch |
| `usePortfolio(address)` | cached list + one fresh `getUserHoldings` (batched `balanceOf`) | balances `staleTime 60s` / `refetchInterval 120s` |
| `useDeployPrice(chainId, enabled)` | `currentDeployPrice()` | `refetchInterval 6s`, `staleTime 4s`; reports a closed slot when no factory |
| `useNavHistory` / `useAssetHistory` | reconstructed history (Alchemy Prices → DefiLlama) | per chain/addr/range |
| `useBasketFees(addr, chainId)` / `useFeeBounds(chainId)` | per-basket fee rate (on-chain) / fixed protocol constants (`fee-model.ts`) | `staleTime: Infinity` (immutable) |

### 4.4 The design system — brand tokens & the up/down color contract

`src/index.css` is the **single brand-token source**. There is no separate Tailwind config file; Tailwind v4's CSS-first `@theme` block defines every design token as a CSS custom property, and the whole palette + keyframe set lives in this one file. If you recolor or re-theme the app, this is the map:

- **Surface ramp** (`--color-void` → `--color-panel` → `--color-panel-2` → `--color-line` → `--color-line-bright`) — the dark backgrounds and hairline borders.
- **Ink ramp** (`--color-ink`, `--color-ink-dim`, `--color-ink-faint`) — primary/secondary/tertiary text.
- **Spectral optics palette** (`--color-violet`/`-bright`/`-deep`, `--color-teal`, `--color-cyan`, `--color-magenta`, `--color-amber`, `--color-alert`) — the prism/refraction accents used by the wordmark, focus ring, and backgrounds.
- **The load-bearing up/down color contract:** `cyan = #35e0ff` (up) and `magenta = #ff4db8` (down) is a **hardcoded convention that recurs across every chart and price element** — e.g. `BasketStats.tsx` colors a 24h change `change24hPct >= 0 ? '#35e0ff' : '#ff4db8'`, and the same hex pair appears directly in `BasketChart`, `BasketListRow`, `HoldingsView`, `AssetHoverCard`, `SpectralSparkline`, and others. (Note a parallel `format.ts` `changeAccent` helper returns the `teal`/`alert` token names for some surfaces; the recurring chart/price convention is the literal cyan/magenta hex.) If you change either hue, grep both the token in `index.css` **and** the literal `#35e0ff`/`#ff4db8` across `src/components/`.
- **Per-basket signature color (`signature.ts`):** each basket's accent is derived **mechanically** — the dominant holding's brand color (`tokenVisual`), else a hue hashed deterministically from the basket address (`FALLBACK_PALETTE`). This is the **replacement for curated branding**: a basket's color is a function of its constituents/address, never a platform-authored taxonomy color. Reuse it (don't hand-assign colors) so cards and detail pages read as the same object.

**Motion & interaction polish (make-interfaces-feel-better pass).** A site-wide tactile pass (lane `fe-feel-better`) applied the principles uniformly; the mechanics live in `index.css` so new UI inherits them:
- **`.press`** — `active:scale-[0.97]` + a snappy named transition (≈120ms) for every button/link/tappable. Replaces ad-hoc `transition-colors`; never combine with `transition: all`.
- **`.enter` / stagger** — opacity+translateY section/list entrance (honours `prefers-reduced-motion`).
- **`.img-outline` / `ring-1 ring-white/10`** — inset hairline so images/avatars never sit borderless on dark glass.
- **Hit areas ≥40px** — icon buttons became `h-10 w-10`.
- **No `transition: all`** — transitions name their properties (`transition-[translate,border-color,background-color]`) so paint stays cheap and intent is explicit.
- `tabular-nums`, concentric radii, font-smoothing were already global; left intact.

This pass touched ~30 components/pages (chrome, cards, launch flow, panels) + `index.css`. Purely presentational — no behaviour, data, or contract surface changed.

---

### 4.5 Creator metadata & basket versioning

Two creator-facing features share **one mechanism**: a deployer-signed (EIP-712) metadata blob,
resolved off-chain and verified client-side. There is **no new on-chain surface** for either (there is
no successor registry); the only contract touchpoint is binding the inert migrate modal
to the frozen `mintInKind` ABI.

- **`lib/spectrum/creator-metadata.ts`** — the EIP-712 schema (`CreatorMetadata`: basket, supersedes,
  handle, name, avatarUrl, bannerUrl, issuedAt; domain bound to
  `{name:'Spectrum Creator Metadata', version:'2', chainId, verifyingContract: factory}`). **The blob
  carries identity pointers only — no long-form prose (bio / tagline / description was dropped in v2):
  a creator's thesis lives off-platform (X, etc.); the site shows on-chain facts + the verified @handle
  that links out to it.** Plus
  `buildCreatorMetadata`, `signCreatorMetadata` (wraps wagmi `signTypedData`), `verifyCreatorMetadata`
  (viem `verifyTypedData` **and** signer == on-chain deployer), `sanitizeImageUrl` (https / ipfs-gateway
  only — never `javascript:`/`data:`/`http:` into an `<img>`), `fetchSignedMetadata` (timeout + 32 KB
  cap), and `resolveCreatorMeta(basket, chainId) → VerifiedCreatorMeta | null`. **Resolution ladder:**
  DEV fixture → **this-browser localStorage** (the creator's own just-published blob, see the publish
  ceremony below) → the convention metadata host. Every rung ends in the **same verify gate** (the
  shared `verifyBlobFor` helper); the localStorage rung sits *before* the `VITE_METADATA_BASE_URL`
  early-return so a creator sees their own profile immediately even on a host-less build. **Trust
  boundary: nothing renders unless the signature verifies AND the signer equals the on-chain deployer
  (`factory.tokens(basket)`) — localStorage is never trusted for correctness, only for immediacy.**
- **`lib/spectrum/use-publish.ts` + `lib/spectrum/persist-metadata.ts` — the publish ceremony (the
  missing write step).** The sign/verify/read primitives above had **zero callers**; `usePublish(chainId)`
  is the state machine that wires them: `build → sign (wagmi useSignTypedData, in the creator's own
  wallet — the FE owns no key) → persist → done/skipped/error`. `persist-metadata.ts` is the
  storage-only **fallback ladder**: **(1)** optional one-click POST to an operator write-relay
  (`VITE_METADATA_WRITE_URL`, `postToWriteRelay`) that the hook re-verifies by reading the blob back
  from the host before claiming success; **(2)** `downloadMetadataBlob` (the signed JSON to self-host
  at the convention path); **(3)** `saveLocalMetadata` (this-browser localStorage, keyed
  `spectrum:metadata:v1:<chainId>:<basket>`) — **always**, so the read ladder's localStorage rung
  lights up instantly. The ceremony runs **post-deploy inside `DeployPortal`** (the `publish` prop): on
  a successful deploy it shows a skippable "sign & publish your profile / version" panel and **holds the
  navigate to the basket page until the creator publishes or skips** (a root basket with no profile has
  nothing to publish → `publishEnabled` is false → it navigates straight through, the prior behaviour).
  In version mode the blob carries `supersedes = predecessor` (the lineage claim). Discovery is
  unchanged; no contracts change. The publish copy is placeholder text to finalize before a *public*
  build (like the deployer acknowledgment), not the build itself.
- **`lib/spectrum/versioning.ts`** — `buildLineageGraph(baskets)` reads each basket's verified
  `supersedes` (same-deployer guarded), assembles predecessor→successor edges (1:1, cycle/length
  capped), and exposes `headOf` / `lineageOf` / `successorOf` / `predecessorOf` / `hasSuccessor`.
  `computeBasketDiff(prev, next)` is a pure on-chain constituent/weight diff (no performance framing).
- **Hooks (`hooks.ts`):** `useCreatorMeta(basket, chainId)`; `useLineage(basket, chainId)` (builds the
  per-chain graph once, shared via the query cache — the perf lever); `useBasketDiff(prev, next, chainId)`.
- **Discovery rollup:** `listBasketsForChain` tags each `BasketSummary` with `supersededBy`; Home,
  Explore, the Creator profile, and Portfolio → Created filter `!supersededBy` so only heads list,
  while the FULL list stays available to the version strip + lineage graph.
- **Creator surfacing & follow:** `CreatorChip` is now rendered on **every discovery surface** — the `BasketGrid` cards (Home + Explore grid), `BasketListRow` (Explore list), `BasketCard` (Portfolio/Creator), and the `TopBasket` highlight — so the deployer is attributed everywhere baskets are enumerated (verified @handle when a signed blob resolves, else the on-chain address; on a host-less build `useCreatorMeta` short-circuits to null with no per-card fetch). A **client-local follow** (`lib/spectrum/follows.ts` — `localStorage` key `spectrum:follows:v1`, a `useSyncExternalStore`-backed `useFollows()` hook, **no server / no cookie / no cross-device sync / no who-to-follow suggestions**) powers a `FollowButton` on the `Creator` header and a **"Following" filter** on Explore (a personal filter over the same catalogue, not curation; empty-default, never seeds an address). Follow state never leaves the browser.
- **Components:** `CreatorChip` (now on cards + grid + list + Explore + Home); the creator **banner** is the hero on the
  `Creator` profile, while the `Token` page keeps a thin accent and instead shows a **single,
  enlarged creator identity** — the creator's profile photo is the only avatar in the header (the
  generated basket avatar is dropped there to avoid two competing circles), with name + X link below
  the basket name (no on-site "About"/bio — the @handle links out to the creator's own channels);
  `VersionStrip` + `BasketDiff` on `Token` (the fee panel is presented as a big fee figure + PRISM
  burn share, with the creator share + holder floor below); `MigrateModal` (Spectrum-themed; broadcast
  **inert** behind `TRADING_ENABLED`, encoder bound to frozen `mintInKind`, `frontend` kickback tag
  from `INTERFACE_TAG_ADDRESS`). Its cost copy is precise: the basket fee **still applies**
  on a migration (exit haircut + in-kind entry fee); the in-kind route only avoids the DEX round-trip
  (swap fees + slippage) on the assets both versions share — **not** the protocol fee. `VersionButton`
  (deployer + `DEPLOY_ENABLED` gated "New version" → `/launch?from=…`) sits beside the version strip in
  the `Token` header too — so a creator can start a new version **from the basket page itself**, mirroring
  the Creator-profile + Portfolio "Created" entry points (it renders `null` for everyone else, so no
  footprint on the public view). `BasketAvatar` hardened: `referrerPolicy="no-referrer"`, scheme allowlist,
  `onError` → deterministic default.
- **Builder version mode:** `Launch.tsx` reads `?from=&chain=`; `BasketBuilder` prefills assets
  (re-resolved against current pools when the chain is pool-ready — a since-dead pool is dropped, not
  kept; when pool detection is unavailable, e.g. a preview/not-yet-configured build, the predecessor's
  legs are carried over as-is, flagged `unverified` for re-check before deploy, so the version still
  prefills instead of dropping every leg), weights, fee config (the ticker prefills to the predecessor's
  symbol — edit freely), and the creator's signed profile text, under a predecessor-scoped draft key,
  behind a "New version of $SYM" banner. The deploy itself is unchanged (no on-chain version field); the lineage link is the
  signed `supersedes` published with the metadata.
- **DEV fixture:** a third mock basket is a **v2 of the first** (same deployer; AERO dropped, DEGEN
  added, WETH/cbBTC reweighted) plus sample verified creator metadata, so the social header, version
  strip, diff, migrate-modal preview and head-rollup are all reviewable with no chain config.

## 5. Config & build system

### 5.1 Feature flags — four independent gates

File: `src/lib/config/features.ts`. Four **fully independent** build-time switches, each reading **only** its own env var, **all OFF by default**. The shipped default is information/analytics only. All infra (wagmi provider, hooks, readers, tx builders, components) stays in the tree regardless; the flags only control what renders / what can broadcast. Truthiness is **strict `=== 'true'`** (any other string, including empty, is off).

| Export | Env var | Default | Controls |
|---|---|---|---|
| `WALLET_ENABLED` | `VITE_ENABLE_WALLET` | off | Connect button + read-only wallet views (Portfolio). Read-only on its own. |
| `DEPLOY_ENABLED` | `VITE_ENABLE_DEPLOY` | off | The launch broadcast (`useDeployBasket`). Irreversible + costs ETH. Salt mining, auction-price reads, and dry-run simulation are read-only and run regardless. Also has an independent hard runtime guard inside `broadcast()`. |
| `TRADING_ENABLED` | `VITE_ENABLE_TRADING` | off | The Flush fee console — holder fee-claim + the permissionless cranks. Transactional. Does **not** include buy/sell. |
| `SWAP_ENABLED` | `VITE_ENABLE_SWAP` | off | Buy/sell — the `/swap` page + the Token `TradePanel`. **Hidden by default** (the `/swap` page redirects home; no nav/panel until on). Also needs a deployed `VITE_SWAP_ROUTER_ADDRESS` to broadcast (else preview-only). Highest-risk surface; last to flip, once a router is deployed. |

**The four single-purpose build artifacts (one per deployment):**
- **info-only** — all off (no `VITE_*` set). The shipped default.
- **creation tool** — `VITE_ENABLE_WALLET=true` + `VITE_ENABLE_DEPLOY=true`.
- **fee console** — `VITE_ENABLE_WALLET=true` + `VITE_ENABLE_TRADING=true` (holders claim, anyone cranks).
- **marketplace with buy/sell** — `VITE_ENABLE_WALLET=true` + `VITE_ENABLE_SWAP=true` + a deployed `VITE_SWAP_ROUTER_ADDRESS`.

**Fail-fast invariant.** If `(DEPLOY_ENABLED || TRADING_ENABLED || SWAP_ENABLED) && !WALLET_ENABLED`, module load **throws**:

```
Misconfigured build: VITE_ENABLE_DEPLOY / VITE_ENABLE_TRADING / VITE_ENABLE_SWAP require VITE_ENABLE_WALLET=true.
```

This is thrown at module-evaluation (import) time — a **runtime guard, not a build-time check**. Because `vite build` only bundles and never executes the app graph, a misconfigured `npm run build` still **exits 0** (verified empirically); the throw fires when the bundle **loads** — in the browser and under `npm run dev` / `npm run preview`. A transactional surface without a wallet is treated as misconfigured, not silently degraded — independence means no silent implication in either direction. (`wagmi.ts` also reads `VITE_ENABLE_WALLET` independently: when off, the connector list is just `[injected()]` and the Coinbase + WalletConnect connectors are never instantiated — they are gated behind the `walletEnabled` ternary so the bundler can drop the heavy SDKs from a wallet-off build. The `coinbaseWallet`/`walletConnect` symbols are statically imported, so whether they fully tree-shake out depends on the bundler's dead-code elimination; confirm with a `npm run build` bundle inspection if a minimal info-only bundle size is a hard requirement.)

### 5.2 Every `VITE_*` env var

Declared/typed in `src/vite-env.d.ts`; template in `.env.example`.

> **Cross-cutting security fact (repeated from `01-BUSINESS.md` and `03-IMPLEMENTATION.md`):** this is a client-only static bundle, so **every `VITE_*` value is compiled into public JS and ships to anyone who loads the site.** There is no server-side secret. Treat every one of them as public. A key you set is a public key — use origin-restricted keys or a read proxy.

**RPC / network**

| Var | Purpose | Unset behavior |
|---|---|---|
| `VITE_ALCHEMY_API_KEY` | Builds Alchemy Base/ETH URLs; also flips `hasAlchemyKey()` true → enables wide filtered `getLogs` for complete V4 pool discovery and the Alchemy Prices history feed. | Falls to public node; `hasAlchemyKey()` false → narrower V4 discovery; history falls to DefiLlama. **PUBLIC if set.** |
| `VITE_BASE_RPC_URL` | Explicit Base RPC endpoint. | Alchemy key → else `https://base-rpc.publicnode.com`. Highest precedence for Base. |
| `VITE_MAINNET_RPC_URL` | Explicit Ethereum-mainnet RPC. | Alchemy key → else `https://ethereum-rpc.publicnode.com`. Highest precedence for mainnet. |

**Networks (active set):** `VITE_EXTRA_CHAIN_IDS` — comma-separated chain ids that activate additional *scaffolded* chains (currently `1` = Ethereum; Base `8453` is always on) for the network switcher **and** wallet network-switching, **without shipping any addresses**. Unset (shipped default) → Base-only. Ids with no `SCAFFOLDS` row are ignored, never guessed. An activated chain with no deployment configured is an honest empty shell on that network (lists / transacts nothing) until its addresses are set. Example: `VITE_EXTRA_CHAIN_IDS=1` exposes the Base⇄Ethereum switcher.

**Wallet:** `VITE_WALLETCONNECT_PROJECT_ID` — adds the `walletConnect` connector; only when `WALLET_ENABLED` is also true. Unset → connector omitted (`injected()` + Coinbase still work).

**Feature flags:** `VITE_ENABLE_WALLET`, `VITE_ENABLE_DEPLOY`, `VITE_ENABLE_TRADING`, `VITE_ENABLE_SWAP` (see [§5.1](#51-feature-flags--four-independent-gates)).

**Deployment addresses** (override `deployments.json` for the **DEFAULT chain Base 8453 only**): `VITE_FACTORY_ADDRESS`, `VITE_USDC_ADDRESS`, `VITE_POOL_MANAGER_ADDRESS`, `VITE_WETH_ADDRESS`, `VITE_UNIV2_FACTORY_ADDRESS`, `VITE_UNIV3_FACTORY_ADDRESS`, `VITE_AERODROME_FACTORY_ADDRESS`. Each: supply the on-chain address for that role; unset → falls back to the JSON entry (ships empty → `null`); invalid string → silently `null` via `addr()`. With `factory` null the app is an honest empty shell.

**Operator identity**

| Var | Purpose | Unset behavior |
|---|---|---|
| `VITE_SITE_URL` | Your own origin, substituted into `index.html` OG/Twitter tags at build time. | Tags render with an empty origin (`/`, `/og.png`). Set this to YOUR origin; never point it at any package-author property. |
| `VITE_PARTNER_APP_URL` | Optional partner/trading-app URL → "Visit $SYMBOL" CTA on Token pages. Trailing slash stripped; builds `<url>/token/?addr=<address>`. | CTA does NOT render. No canonical V2 trading app — the package anoints none. |
| `VITE_INTERFACE_TAG_ADDRESS` | Optional interface-kickback tag; rides in mint/redeem `hookData` and triggers a FeePanel disclosure. | **Load-bearing empty default:** unset (or `address(0)`) → `INTERFACE_TAG_ADDRESS = null` → the encoder uses `address(0)` → the interface slice is **not carved** and stays in the post-burn remainder (flowing to creator + holders). Validated strictly at module load: a non-address value throws `Misconfigured build: VITE_INTERFACE_TAG_ADDRESS is not a valid address (...)`. There is no default/fallback recipient anywhere. |
| `VITE_LAUNCHER_ADDRESS` | Optional launcher address; written into `FeeConfig.launcher` at deploy so the launcher earns `LAUNCHER_SHARE_BPS` of the post-burn remainder on every fee. Operator-injected, never a creator dial. | **Empty default:** unset (or `address(0)`) → `FeeConfig.launcher = address(0)` → no launcher slice is carved (it stays in the remainder for creator + holders). There is no default/fallback launcher recipient anywhere. |

**Creator metadata (optional — the "metadata host / pinner" role)**

| Var | Purpose | Unset behavior |
|---|---|---|
| `VITE_METADATA_BASE_URL` | Base URL of a host serving creator-published, **deployer-signed** basket metadata (X handle/name + avatar/banner + version `supersedes`; no long-form prose — that lives off-platform). The FE fetches `${base}/<chainId>/<basket>.json`, verifies the EIP-712 signature against the basket's on-chain deployer, then renders it. | Unset (shipped default) → no metadata fetched → baskets show the on-chain deployer address (honest fallback). You serve signed content; you never author it. No package-author/default endpoint may ship. |
| `VITE_IPFS_GATEWAY_URL` | Optional gateway to resolve `ipfs://` avatar/banner references inside metadata (prefixed before the CID/path). | Unset → `ipfs://` treated as unresolvable (that field dropped); `https://` images always work. |

### 5.3 RPC precedence & keyless degradation

File: `src/lib/chain/rpc.ts`. Per-chain precedence (identical for Base and mainnet): explicit `VITE_*_RPC_URL` → Alchemy key URL → public node. `rpcUrlFor(chainId)` routes mainnet (id 1) → `mainnetRpcUrl()`, everything else → `baseRpcUrl()`. `clientFor(chainId)` builds per-chain **singleton** `PublicClient`s with `batch: { multicall: true }` (coalesces concurrent `readContract` into one Multicall3 round-trip).

**The app works fully keyless.** The only loss without `VITE_ALCHEMY_API_KEY`: `hasAlchemyKey()` is false, so the pool engine cannot run wide full-range filtered `getLogs` for complete V4 discovery (public RPCs reject that range — the builder warns prominently instead of pretending), and long log lookbacks (e.g. inception timestamps for very old baskets) and the Alchemy Prices history feed are unavailable (history falls back to DefiLlama). All reads still function via multicall batching; discovery is just narrower.

### 5.4 wagmi / chain registry

**wagmi (`src/wagmi.ts`):** chains derived from the registry (`SUPPORTED_CHAIN_IDS.map(id => CHAINS[id].viemChain)`; shipped default Base-only, widened by `VITE_EXTRA_CHAIN_IDS`). Transports `http(rpcUrlFor(id))` per chain. Connectors: when `VITE_ENABLE_WALLET==='true'` → `injected()` + `coinbaseWallet({ appName: 'Spectrum' })` + `walletConnect({ projectId })` only if the project id is set; when off → only `injected()` (the Coinbase/WalletConnect connectors are never instantiated, gated behind the `walletEnabled` ternary so the bundler can drop the heavy SDKs from a wallet-off build — verify with a bundle inspection if minimal size is a hard requirement). Registers `config` on the wagmi `Register` interface for typed hooks.

**Chain registry (`chains.ts` + `deployments.ts` + `deployments.json` + `constants.ts` + `active-chain.ts`):** two layers per chain — a *scaffold* (`chainId`, `key`, `name`, `viemChain`, `dexscreenerSlug`, `explorer`; Base and Ethereum scaffolds exist) + a *deployment* (`factory`, `usdc`, `poolManager`, `weth`, `uniV2Factory`, `uniV3Factory`, `aerodromeFactory`). A chain becomes ACTIVE when `deployments.json` has an entry **or** its id is listed in `VITE_EXTRA_CHAIN_IDS`, AND a `SCAFFOLDS` row exists (an unknown chain id is ignored, not guessed). `deployments.json` **ships empty**; env address overrides apply only to the default chain (Base 8453), so a chain activated purely via `VITE_EXTRA_CHAIN_IDS` is viewable/switchable but address-less (honest empty shell) until configured. `buildChains()` never ships a zero-chain build (falls back to the empty-address Base scaffold). `SUPPORTED_CHAIN_IDS` is **Base-first** (Base leads the switcher as the primary chain; activated chains follow) and `DEFAULT_CHAIN_ID` = Base when present. `isPoolReady(cfg)` requires `weth` + `poolManager` + `uniV2Factory` + `uniV3Factory` all present (the pool-engine gate). Adding a future chain = one `SCAFFOLDS` row + either a `deployments.json` entry (with addresses) or a `VITE_EXTRA_CHAIN_IDS` listing (view/switch only, no addresses).

**Minimum to "connect" to a deployed factory:** populate `factory` and `usdc` for Base (`8453`). `poolManager`/`weth`/`uniV2Factory`/`uniV3Factory` are additionally required for the launch/pool-detection engine, not for browse/NAV/fee display. `aerodromeFactory` is detected only to warn. (Prerequisite owned by whoever owns the repo, not you: a deployed factory and a filled **factory deployment address book** — see `03-IMPLEMENTATION.md`. Re-seating any compile-time contract constant changes bytecode and invalidates every mined salt — see [§7](#7-known-technical-constraints--limitations).)

### 5.5 Build & dev commands

Package manager is **pnpm**; `"type": "module"` (Node ESM).

| Command | Action |
|---|---|
| `pnpm dev` | Vite dev server. (The repo's `.claude/launch.json` pins `pnpm dev --port 4022 --strictPort`.) |
| `pnpm init:env` | `node scripts/init-env.mjs` — copy `.env.example` → `.env.local` (idempotent). |
| `pnpm check:config` | `node scripts/check-config.mjs` — validate `.env.local` + `deployments.json` ([§5.7](#57-setup-scripts-and-the-config-check-gate)). |
| `pnpm build` | `prebuild` (`check:config`) THEN `tsc -b && vite build` — config gate, typecheck, bundle. A config error, flag throw, or bad interface-tag aborts here. |
| `pnpm typecheck` | `tsc -b` only. |
| `pnpm preview` | Serve the built `dist/` locally. |
| `pnpm test` | `vitest run` — the FE unit suites (`swap-quote` + `hook-data`). |

**TypeScript:** `tsconfig.json` is a project-references root (refs `app` + `node`). Both configs: `moduleResolution: bundler`, `verbatimModuleSyntax`, `noEmit`, `strict`, `noUnusedLocals`/`noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`. **Strict + no-unused means dead code fails the build.**

### 5.6 Vite config, gateway-relative base, OG substitution

**`vite.config.ts`:** `base: './'` (gateway-relative — **load-bearing for IPFS; do not change**). Plugins: `@vitejs/plugin-react`, `@tailwindcss/vite`. Manual vendor chunking splits node_modules into cacheable parallel chunks: `three`, `charts` (recharts/d3/victory-vendor/internmap), `react-vendor`, `web3` (wagmi/viem/ox/abitype/@tanstack/@coinbase/@walletconnect/@reown/@safe-global/@metamask).

**OG / social-tag substitution:** `index.html` carries static OG + Twitter `summary_large_image` tags whose four URLs use the `%VITE_SITE_URL%` placeholder (`og:url` = `%VITE_SITE_URL%/`, `og:image`/`twitter:image` = `%VITE_SITE_URL%/og.png`). The mechanism is **Vite's built-in HTML env replacement** — no custom plugin. **Unset → the token becomes an empty string**, yielding relative `og:url="/"` and `og:image="/og.png"`. Set `VITE_SITE_URL` to your own origin. (`public/sitemap.xml` is an empty stub and `public/robots.txt` has a commented `Sitemap:` placeholder — both need manual regeneration with your origin; no build step does this.)

### 5.7 Setup scripts and the config-check gate

Two zero-dependency Node scripts (`app/scripts/*.mjs`) smooth the clone → ship path:

- **`init-env.mjs` (`pnpm init:env`)** — copies `.env.example` → `.env.local` if it doesn't exist (idempotent; never clobbers). Vite reads `.env.local`, not `.env.example`, so this removes the "my env vars are ignored" surprise.
- **`check-config.mjs` (`pnpm check:config`, and the `prebuild` gate)** — reads `.env.local` (overlaid by any real shell `VITE_*` var, mirroring Vite precedence) + `deployments.json` and reports the build tier plus the common footguns: a transactional flag without `WALLET` (**fatal** — exits non-zero, the same invariant `features.ts` throws on at load, so it's caught at build time on the `build` script instead of only at load); a malformed address (**fatal** — would silently drop to `null`); an EIP-55 checksum miss on a mixed-case address (warn — likely typo); `VITE_ENABLE_SWAP` with no router (warn — preview-only); a chain in `VITE_EXTRA_CHAIN_IDS` with no factory in `deployments.json` (warn — the Base-only-env footgun); an unset `VITE_SITE_URL` (warn — relative OG tags); a stub `sitemap.xml` (warn). It imports viem's `isAddress`/`getAddress` for validation. Warnings never block; only a fatal error does. Wired as `prebuild`, so `pnpm build` runs it first — run `vite build` directly to bypass.

The previous `bake:colors` token-color baker (`scripts/bake-token-meta.ts`) was **removed**: it was broken-as-shipped (imported `SEED_INDEXES`/`ETH_SEED_INDEXES` symbols that no longer exist in the address-free `constants.ts`) and stale by design (the deployment is address-free; discovery is chain-derived). The **runtime hashed-hue fallback** (`token-meta.ts`) already colors every token, and the committed `token-meta.generated.ts` is unchanged. (Its sole `jimp` devDependency is now unused; left in `package.json` to avoid lockfile churn — safe to prune when cleaning up the toolchain.)

---

## 6. State management, routing, performance, accessibility, dev fixture

**State management.** No Redux/Zustand. Three layers: (1) **TanStack Query** for all server/chain state (one `QueryClient`, queries keyed by chain/address/range, deduped and refetched on intervals — see the hooks table in [§4.3](#43-significant-components--hooks)); (2) **wagmi** for wallet/account/chain connection state; (3) **local component state** for ephemeral UI (the builder's draft, trade inputs) plus two provider-less module stores — `active-chain.ts` (`useSyncExternalStore` + `localStorage`) for the viewing chain, and the builder's `localStorage` draft. There is no global app store beyond these.

**Routing.** `BrowserRouter` (history API), flat routes, one dynamic param (`/creator/:address`), one query-param-driven page (`/token`), one dev-only route. Because it is a history-API SPA, **the host must rewrite unknown paths to `index.html`** or deep links / refreshes 404 (see `03-IMPLEMENTATION.md`).

**Performance.**
- **Multicall3 batching:** every `PublicClient` uses `batch: { multicall: true }`, so the N immutable reads per basket and the 60-per-round salt-mining probes coalesce into single round-trips — critical over public RPCs.
- **Caching:** immutable data (`useBasketFees`, immutable meta) is `staleTime: Infinity`; the live list/basket/portfolio hooks (`useAllBaskets`, `useBasketData`, `usePortfolio`) refetch every **120s** (`refetchInterval: 120_000`, `staleTime 60s`); the deploy price (`useDeployPrice`) polls every **6s**; reconstructed history is React-Query-cached per chain/addr/range so baskets sharing assets collapse to a few price calls; DexScreener spot prices have a 30s TTL cache with retry/backoff.
- **Bundle:** every page is `React.lazy` code-split; manual vendor chunks download in parallel; three.js is both lazy-loaded and reduced-motion-gated so it stays off first paint; Recharts runs with `isAnimationActive={false}`; the heavy wallet connectors are gated behind the wallet flag so a wallet-off build can drop the Coinbase/WalletConnect SDKs.

**Accessibility.** Global `:focus-visible` ring (zero-specificity `:where()` so component styles still win); decorative layers are `aria-hidden` + `pointer-events-none`; expand/collapse uses real `<button>` + `aria-expanded`; charts mark `aria-busy`/`role=status` while loading; the connector picker and search are full keyboard combo-boxes. **Reduced motion is honored everywhere** — in the JS motion hooks (`lib/motion.ts`: `usePrefersReducedMotion`, `useInViewOnce`, `useCountUp` which snaps instantly), in the WebGL loop (holds a still frame), in the canvas `PixelDissolve` (bails immediately), and in **every CSS keyframe** (each has a matching `prefers-reduced-motion: reduce` override).

**Dev-only mock fixture (`lib/spectrum/dev-fixture.ts`).** The shipped default config is empty, which would make Home/Explore/Token/Creator blank. This fixture supplies two synthetic baskets ("Dev Sample Basket" DEVBKT, "Dev Sample Basket Two" DEVTWO) with obviously-fake addresses and a fake deployer; constituents are well-known Base tokens used only as cosmetic logo/color facts (not seeds, not curation). **Activation rule:** only when `chainId === DEFAULT_CHAIN_ID` AND that chain has **no factory configured**. A real deployment always wins. It is imported only behind `import.meta.env.DEV` (a dynamic import in `basket-data.ts`), so it is **never in a production bundle**. Net effect: `pnpm dev` against an unconfigured build shows reviewers a populated UI; a configured or production build renders an honest empty marketplace.

**The PostDeployTest dev harness (`pages/PostDeployTest.tsx`).** **DEV-ONLY, double-gated:** the component is `import.meta.env.DEV ? lazy(...) : null` and the route is rendered only inside `{import.meta.env.DEV && PostDeployTest && (…)}`. In any production build the component is never imported and `/post-deploy-test` falls through to the 404. It is governed purely by Vite's DEV mode (not WALLET/DEPLOY/TRADING). It is a standalone rehearsal of the deploy ceremony (orbit → gather → drop → "Basket Deployed") that hands off to the real Token page. **Stale-comment note:** `App.tsx`'s comment still says it "reproduces … a MOCK 'Buy' bar … so the public site has no buy path here," but the current `PostDeployTest.tsx` renders **no buy bar** — it is purely the deploy-ceremony animation. Either way it is dev-only and never in a production bundle, so it adds no buy path to the shipped site. (This is a stale comment worth cleaning up, not a behavior to document.)

### 6.1 Testing & verification

Be precise about what ships, so you know exactly what safety net you inherit and where you must add your own:

- **A narrow unit suite ships; there is no end-to-end suite.** `pnpm test` (`vitest run`) covers the pure swap/floor math (`swap-quote.test.ts` + `hook-data.test.ts`). The `package.json` scripts are `dev` / `init:env` / `check:config` / `build` (+ `prebuild`) / `typecheck` / `preview` / `test` — **no `jest`/`playwright`** and no component/e2e coverage. Do not read green units as full coverage; the read/UI surfaces are still verified manually (below).
- **The compile-time gate is the type system + the config gate.** The real safety net is the **strict project-references typecheck** (`tsc -b` with `strict`, `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`) that runs *before* the bundle in `pnpm build`, and the **`prebuild` config gate** (`check:config`, [§5.7](#57-setup-scripts-and-the-config-check-gate)) that runs before *that*. Dead code and type errors fail the build; a fatal misconfig (flag-without-wallet, malformed address) now fails the `build` script before bundling too. The fail-fast flag invariant ([§5.1](#51-feature-flags--four-independent-gates)) and the interface-tag validator ([§5.2](#52-every-vite_-env-var)) remain **runtime** guards inside the app — a direct `vite build` (skipping the gate) still exits 0 on a misconfigured combo, with the throw firing when the app *loads* (browser / `pnpm dev` / `pnpm preview`) — which is why the go-live QA still includes a console check (see `03-IMPLEMENTATION.md` §7).
- **The deploy path is dry-run-simulated before any signature.** `prepare()` runs `simulateContract(deployBasket, …)` as a read-only dry run against the live factory and connected account, so a doomed deploy fails *there*, before a wallet ever signs ([§3.8](#38-the-deploy-engine)). Pool detection and salt mining are likewise read-only and run before any state change. This is runtime verification, not a test suite, but it is the practical pre-flight check for the one write path.
- **How to test a change:** run `pnpm typecheck` (and `pnpm build`) for the compile-time gate, then `pnpm dev` and **manually walk the go-live QA smoke-test checklist** — that checklist is owned by **`03-IMPLEMENTATION.md` (§7, go-live QA)**, which is the authoritative manual-verification path for this frontend (read/analytics surfaces, the read-only launch preview, and — only if you enable them — the gated wallet/deploy/trading surfaces). For an unconfigured build, `pnpm dev` populates the UI via the DEV fixture so you can exercise the read surfaces without a deployed factory.
- **The contracts have their own test suite, separate from this.** The reference contracts carry a **Foundry** suite owned by whoever owns the repo — it lives with the contracts, not with this frontend, and verifying it is a prerequisite that owner holds, not the FE operator (see `03-IMPLEMENTATION.md` and the contracts deploy runbook). Nothing in `app` exercises the contracts directly.

---

## 7. Known technical constraints & limitations

State these affirmatively to whoever extends or operates this frontend.

1. **Static-site SEO / OG prerender limit.** A client-rendered SPA cannot emit per-basket Open Graph cards without prerendering. Every shared link (any basket, any page) shows the single site-level OG card from `index.html`. `sitemap.xml` ships as an empty stub and `robots.txt` has a placeholder `Sitemap:` line — both need manual regeneration with your origin; no build step does it. Per-basket OG cards and a populated sitemap are your own prerender/edge choice (see `03-IMPLEMENTATION.md`).

2. **Draft ABIs.** `abis-v2.ts` is a **draft** whose semantics are requirements, not the final wire format. Bind it to the deployed, verified contracts before any deployment. The fee-model binding is now reconciled to the contracts (`deployBasket` tuple order, `basketFeeBps` naming, `Launched` emits `basketFeeBps`, no per-basket burn share). Remaining gap: per-entry `decimals` is zeroed/re-derived on-chain by the factory. The frozen `mintInKind(amounts, minShares, to, frontend)` + its `MintedInKind(to, frontend, shares, feeUsdc)` event are built on-chain and bind the **inert** migrate modal (§4.5); the migration router is not deployed. **`MintedInKind` does not re-emit the per-leg `amounts[]`** — they ride in the tx calldata (the EIP-170 diet dropped them), so the event carries 4 args, not 5; keep `abis-v2.ts` in lockstep with `SpectrumBasket.sol`. Creator metadata and version lineage are entirely **off-chain** (deployer-signed, verified client-side) — there is no on-chain metadata pointer and **no on-chain successor pointer** (there is no successor registry that could act as a controller).

3. **Complete V4 discovery needs a key.** The launch flow's V4 pool scan requires a wide filtered `getLogs` that public RPCs reject. Without `VITE_ALCHEMY_API_KEY` (or a read proxy you run), V4 venues are skipped and the builder warns prominently — a deeper V4 pool may exist that the depth ranking didn't see. Any key in this static build is public; use an origin-restricted key or a proxy.

4. **NAV history is reconstructed, not stored.** History is anchored to the current NAV and approximated from constituent price ratios (`NAV(t) = navNow · Σ wᵢ·priceᵢ(t)/priceᵢ(t₀)`), with the price feed being Alchemy Prices → DefiLlama. Treat charts as illustrative reconstructions, not an authoritative record. Live NAV itself is sourced from the on-chain static views first, cross-checked against DexScreener (> 2% divergence warns), and only falls back to the DexScreener reconstruction when the views are unavailable.

5. **Salt re-mine on ANY contract bytecode change — including the two forward-looking changes below.** The mined hook address depends on the init-code hash, which is fixed by `(basket, deployer, feeConfig)` *and the contract creation code*. **Re-seating any compile-time contract constant — or any change to `SpectrumBasket` bytecode — changes the init-code hash and invalidates every previously mined salt.** Two specific forward-looking items are proposed but **not yet applied** (current shipped numbers are the as-built values):
   - **Raising the minimum trading-fee floor** is a compile-time constant change → new creation code → the FE's in-browser salt miner must target the new build. Not a blocker, but a hard FE dependency.
   - **An in-kind mint path** lives in a new `SpectrumBasket` build → new code-providers → new factory generation → re-mine all hook salts. It is forward-only (cannot retrofit live baskets). Because `predictTokenAddress` is the salt oracle, the miner picks up the new build automatically once the FE points at the new factory — but every existing mined salt is invalid for the new bytecode. (Note also: in-kind paths are burn-free and route-free entry/exit, an economic matter, not an FE code matter.)

6. **Stale `ready` deploy state re-prices by reverting, not by re-quoting.** `broadcast()` does not re-read the Dutch auction price after `prepare()`; it relies on the `maxCost == priceWei` overpay guard (a reopened slot reverts with no overpay). Recovery is to re-run `prepare()`. By design and safe.

7. **Config is validated, not enforced at runtime.** `pnpm check:config` (the `prebuild` gate, [§5.7](#57-setup-scripts-and-the-config-check-gate)) catches the common setup footguns at build time, but a static site still cannot verify that a configured address is the *right* live contract — that is the operator's on-chain check (§4 of `03-IMPLEMENTATION.md`). (The old broken `bake:colors` baker was removed; the runtime hashed-hue fallback covers every token.)

8. **Buy/sell is wired but hidden + inert by default, and depends on a router you deploy.** It is gated by the dedicated `SWAP_ENABLED` flag (default off → the `/swap` page redirects home, no nav link, no Token `TradePanel`) AND requires a configured `VITE_SWAP_ROUTER_ADDRESS` to broadcast (with the flag on but no router, the panel is preview-only). The `/flush` console is separately wired under `TRADING_ENABLED` (claim + the four cranks) — those are direct, hook-independent calls and do not touch the swap path. The swap router's exact shape is a **draft** the operator must bind to their deployed router before flipping `SWAP_ENABLED` (the reference shape travels with the contracts source, a separate repo). **Never add a zero/empty-`legMins` path or a "disable slippage" toggle** (see [§3.6](#36-the-hookdata-encoder--never-add-a-zero-slippage-path)).

9. **Two external runtime dependencies** beyond RPC: DexScreener (spot prices, pool TVL, token search, token-icon CDN) and the history price feeds (Alchemy Prices / DefiLlama). All are keyless and degrade with fallbacks, but they are third-party HTTP hosts your deployment depends on at runtime. `public/proto/bg.html` additionally loads three.js + fonts from external CDNs — it is a prototype shipped in `public/`; prune it before deploy if you want a fully self-contained bundle.

10. **Empty marketplace on a fresh deployment is correct behavior, not a bug.** The shipped config lists nothing; discovery is chain-derived; the empty state says so plainly. Do not "fix" it by adding seed lists, featured carousels, or curated metadata — those are removed by design and any curation/editorial is your own legal act.
