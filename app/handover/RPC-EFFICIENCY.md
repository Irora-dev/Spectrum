# RPC EFFICIENCY — running this frontend cheaply on your own key

> **This is software, not advice.** How you provision, restrict, and pay for RPC access is your
> decision as an independent operator. Numbers below are estimates from provider price sheets that
> change — verify against your own dashboard.

This app is fully client-side: **by default every visitor's browser talks to your RPC directly**.
The build already minimizes that (Multicall3 batching, enumeration-based discovery, persisted
immutable caches, focused-tab-only polling, keyless price sources for decorative charts). This doc
covers the two things only you can do: **point the app at a snapshot** so global data is fetched
once per interval instead of once per visitor, and **harden your key**.

## 1. What talks to your RPC (as shipped)

| Surface | Cadence |
|---|---|
| Basket list (viewed chain) | every 5 min per focused tab (+15 min for the other chain) |
| Basket detail / portfolio balances | on view; 5 min while open |
| Launch-page deploy price | every 12 s while a fully-specified basket sits on the launch step |
| Launch-page pool detection | per candidate asset (first check per asset is the expensive one; repeats are incremental) |
| Trade paths (quotes → simulate → receipt) | user-action-bound |

Immutable facts (names, constituents, deployers, fee configs, launch dates) are read **once per
browser** and persisted; returning visitors re-read none of it.

Decorative sparklines use keyless public price APIs first; only detail-grade charts prefer your
key's price API (with a keyless fallback). Spot prices and pool liquidity come from DexScreener
(keyless) throughout.

## 2. The snapshot: decouple cost from traffic (recommended)

Without a snapshot, RPC spend scales with `visitors × baskets × minutes`. With one, it is **flat**:
one small poller — the only key-holder — reads the chain on a schedule and publishes a JSON; every
visitor reads that JSON from your static host/CDN. List and discovery surfaces render from it;
anything trade-critical (swap floors, click-time simulation, allowances, live fee state, wallet
balances) **always stays on live RPC by design** — a snapshot can never feed a trade.

**The app finds the snapshot by itself** — precedence:

1. `VITE_SNAPSHOT_URL` (explicit override, any host/CDN);
2. else, a `snapshot.json` served beside the app (same host as `index.html`).

Set one up with any scheduler (a GitHub Action cron, a Worker cron, or crontab):

```sh
# 1) produce the JSON on a 2–5 min cadence (server-side env, key never ships to browsers)
ALCHEMY_API_KEY=<your key> node scripts/build-snapshot.mjs --out public/snapshot.json
# (or SNAPSHOT_RPC_URL_8453 / SNAPSHOT_RPC_URL_1 for explicit endpoints)

# 2) publish public/snapshot.json next to your site's index.html — that's it
#    (auto-discovered; set VITE_SNAPSHOT_URL only for a different host/CDN)
```

Example GitHub Action (copy into `.github/workflows/snapshot.yml` on your fork and set the
`ALCHEMY_API_KEY` secret):

```yaml
name: snapshot
on:
  schedule: [{ cron: '*/5 * * * *' }]
  workflow_dispatch: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: cd app && npm ci --omit=dev --ignore-scripts
      - run: cd app && ALCHEMY_API_KEY=${{ secrets.ALCHEMY_API_KEY }} node scripts/build-snapshot.mjs --out snapshot.json
      - name: publish
        run: echo "upload app/snapshot.json to your host/CDN here"
```

Freshness contract: the app discards snapshots older than `VITE_SNAPSHOT_MAX_AGE_SEC` (default
900 s) and silently falls back to live reads — a dead poller degrades to exactly the no-snapshot
behavior, never to stale data.

With a 2–5 min cadence the poller's entire monthly usage sits comfortably inside typical provider
free tiers even at hundreds of baskets; visitor traffic no longer moves your bill at all.

## 3. Key hardening (do these regardless)

- **Origin-restrict the key.** A `VITE_ALCHEMY_API_KEY` ships readable in the bundle. In your
  provider dashboard, restrict it to your site's origin(s) so it is useless elsewhere. With the
  snapshot configured you can omit the browser key entirely (keyless fallbacks cover the residual
  live reads, minus V4 pool discovery depth on the launch page).
- **Split keys per surface** (site vs snapshot poller vs any scripts) so a spike is attributable
  and a leak is revocable without downtime.
- **Set spend/throughput alerts** in the provider dashboard before launch. Free tiers meter both
  monthly usage AND requests-per-second — a launch-day burst can rate-limit (HTTP 429) a free key
  even when the monthly total looks safe. Plan a paid tier for high-traffic windows; downgrade
  after, once your dashboard shows steady usage.
- **Rotate any key you did not create yourself** (e.g. one inherited with a repo or hand-off).

## 4. Measured cost profile (so you can budget)

Measured 2026-07-05 with a method-counting proxy in front of both chain endpoints, driving every
page of a production build headless against the live contracts (2-basket fleet; grows with fleet
size). Provider CU prices: `eth_call` 26, `eth_getLogs` 60, Prices API 40/request.

| Scenario | Measured |
|---|---|
| Full 9-page browse session, fresh browser | **~1,600 CU** (was ~2,500 before this efficiency pass) |
| Same session, returning browser (persisted caches) | lower — immutables, launch dates and deployers re-read **zero** |
| Same session with the snapshot configured | **~410 CU** (all list surfaces: 0 RPC; only the open detail page + its charts read live) |
| Idle focused tab (list page) | ~12–24 calls/hr ≈ 0.3–0.6k CU/hr (viewed chain every 300 s, other chain every 900 s; unfocused tabs poll nothing) |

Where the cost actually goes, ranked (no snapshot):

1. **The basket-list poll** — discovery + per-basket NAV/supply/reserves on the viewed chain,
   every 5 min per focused tab. This is the one line that scales with `visitors × baskets`;
   the snapshot (§2) takes it to zero.
2. **Detail-page charts** — Prices API, 40 CU × unique constituent per range (5-min cache).
3. **Token-detail live reads** — 2–3 batched calls per open basket (trade-adjacent freshness; by design never cached).
4. **Launch-page pool detection** — ~300–500 CU the first time a creator checks an asset, then
   incremental (scan results persist per browser).
5. **Deploy-price poll** — 26 CU / 12 s, only while a fully-specified basket sits on the launch step.

One-time-per-browser (then never again): basket immutable metadata, deployer lookups, launch-date
index, fee configs. Not on your bill at all: spot prices and pool depth (DexScreener), fallback
chart history (DefiLlama), token logos.

**Throughput note:** free tiers cap burst rate (e.g. 500 CU/s) as well as monthly volume. A single
first-paint is a ~200–400 CU burst, so a handful of simultaneous brand-new visitors can hit a free
tier's rate limit even at trivial monthly usage. For a launch window or a marketing spike, run a
paid/pay-as-you-go tier (or the snapshot, which removes visitor bursts from your key entirely),
then settle back once your dashboard shows steady state.

## 5. Config reference

| Env | Effect |
|---|---|
| `VITE_SNAPSHOT_URL` | explicit snapshot source (unset = auto-resolve: same-origin `snapshot.json` → live reads) |
| `VITE_SNAPSHOT_MAX_AGE_SEC` | staleness gate for the snapshot (default 900) |
| `VITE_ALCHEMY_API_KEY` | browser RPC + detail-chart prices; origin-restrict it (optional with a snapshot) |
| `VITE_BASE_RPC_URL` / `VITE_MAINNET_RPC_URL` | explicit browser RPC endpoints (override the key) |
| `ALCHEMY_API_KEY` / `SNAPSHOT_RPC_URL_<chainId>` | **poller-side** (never `VITE_`) endpoints for `scripts/build-snapshot.mjs` |
