# RPC audit — reads per load, per poll, and the 10k-user budget

> status: snapshot · as-of: 2026-08-06 · owner: specallocator · greenlit by the owner
> (2026-08-05 21:06 in-session ask + the standing next-step). Measured against
> the dev fixture book on :5313 @ lane `018dc14`; method + scripts:
> `rpc-audit.mjs` / `rpc-focus.mjs` (session scratchpad — re-runnable anywhere,
> they only need Playwright and a URL).

## Method

Playwright request interception on real page sessions. Every POST whose body
carries `jsonrpc` is counted twice: as an HTTP post, and as the individual
calls inside it (batched arrays unpacked). `eth_call` to
`0xcA11…CA11` is split out as `eth_call(multicall3)` so batching is visible.
Three measurements: cold load (first 20s), idle poll window (120s), and
tab-refocus cycles after 2s / 20s / 65s away.

## Measurements

| Surface | Load (20s) | Idle | Refocus |
|---|---|---|---|
| `/portfolio` | **46 calls** (42 = multicall3 aggregates · 3 getLogs · 1 blockNumber; 16 ETH / 20 RH / 10 Base) | **0** (120s) | **0** at 2s/20s/65s |
| `/baskets` (list) | **4 calls** (2 multicall3 Base · 1 getLogs + 1 blockNumber RH) | **0** (120s; the list re-polls every 300s active / 900s inactive — ~2 multicalls per cycle) | — |
| `/t/…` (basket detail) | **9 calls** (2 multicall3 · 4 getLogs · 3 blockNumber) | **0** (90s, anonymous) | — |
| `/creator/…` (profile: baskets + thesis) | **17 calls** (10 getLogs — notes/feed + launch index, one-shot · 4 multicall3 · 4 blockNumber) | **0** after the crown fix (was 3 multicalls/90s — see below) | — |
| `/` (homepage) | **9 calls** | **0** (bucketed: 0/0/0/0 per minute) | — |
| `/explore` | **62 calls** (heaviest cold surface — histories are HTTP, the chain part is 50 multicalls) | **0** after a ~30-call first-minute warm-up tail | — |
| `/swap` | **9 calls** | **0** | — |
| `/create` (choose station) | **4 calls** | **0** | — |

**Measurement discipline note:** a first pass ran four page audits in
parallel against the same public endpoints and recorded phantom "idle
burns" (135/90s on `/`) — that was probe contention: 429-retry storms
from my own four tabs, each retry counted as a post. Time-bucketed
solo re-runs showed the true zeros. Audits of shared public endpoints
must run one page at a time.

Connected-viewer coefficients on the detail page (wallet-gated, off when
anonymous): PositionPnl polls at 60s and the swap card's balance at 30s —
~1–3 calls/min while a connected viewer keeps the tab focused; both stop
unfocused.

Caveats, stated: the dev fixture short-circuits some fetchers (fee state
answers locally in dev), so these are the floor of chain traffic; a production
book adds real fee/basket reads **through the same batched path** — the shape
holds, coefficients grow with held-basket count. The refocus probe used
synthetic visibility events; the structural guard below doesn't depend on it.

## The read stack, mapped

- **`lib/chain/rpc.ts` `clientFor()`** — per-chain singletons, multicall batch
  16 KB, slow-start retry. Nearly every read fetcher rides it (raw holdings,
  fee state, basket data, history, pnl, pools, exit costs…). This is why a
  whole portfolio load is ~46 upstream calls instead of several hundred.
- **wagmi hooks** (`useReadContracts` in use-wallet-assets…) — multicall
  internally by default. Fine.
- **`getLogs`** — already one factory-wide scan, session-cached, rescan
  rate-limited, private-RPC-gated (basket-data.ts). The 3 at load are one-shot.
- **Pollers**: the baskets list at 300s active / 900s inactive (staleTime
  120s); the 12s auction-price watcher lives ONLY in the launch flow
  (`BasketBuilder`, gated on `canDeploy` — corrected from this doc's first
  draft, which placed it on basket detail; Token.tsx has zero standing
  intervals of its own). The wallet-gated per-position polls (60s/30s) are
  the connected-viewer coefficients above.
- **The creator profile** (`/creator/:address` — the baskets + thesis page):
  the basket list is the SHARED `useAllBaskets` cache (already warm coming
  from anywhere in the app; `/creators` derives from it too, zero extra
  reads), creator meta/identity sit on 5m/60s TTLs, the thesis + feed
  (notes-social) are staleTime-only, and the "bullish on" picks are a
  one-shot batched symbol read. **The page's one standing drain — found by
  this measurement — was `CrownWinnings` polling league accrual every 30s
  for ANY visitor on ANY profile.** Fixed: the interval is now
  viewer-gated (`isViewer ? 30_000 : false`) — live for the one person who
  can withdraw it (also the `/refer` mount, always self), staleTime-floor
  freshness for visitors. Re-measured idle: zero.
- **The two gaps found** (both fixed this commit):
  1. `new QueryClient()` stock defaults → staleTime 0 + refetchOnWindowFocus
     true: any query that forgot a staleTime refetched on EVERY tab focus.
     → global default `staleTime: 30_000`; queries with their own keep theirs.
  2. wagmi transports were bare `http()` → one POST per call on the
     action-side client (simulates, receipt waits). → `batch: true`.

## The 10k-user budget

- **Default posture (shipped kit, public endpoints):** reads are client-side —
  each user hits public RPCs from their own IP. 10,000 users distribute as
  10,000 independent ≤46-call bursts; no shared key, no operator cost, far
  under public per-IP limits. The retry posture (4 tries, 400ms+ backoff)
  absorbs 429 weather. **Verdict: scales past 10k users as-is.**
- **Operator-keyed posture (env RPC override, CU-billed):** budget per user:
  ~46 call-units per portfolio load, ~4 per baskets-list load, +5/min per
  parked basket-detail tab. At Alchemy-class pricing (eth_call ≈ 26 CU) a
  portfolio load ≈ 1.2k CU → 10k users × 5 loads/day ≈ 60M CU/day — a paid
  tier, sized by one multiplication. Multicall keeps this flat in asset count.

## Verdicts on the two parked features

1. **Freshness whisper, focus-regain half — UNBLOCKED.** With the 30s default
   staleTime, refetch-on-focus now IS the feature with a measured budget: a
   regain re-reads only what's ≥30s stale (worst case one load's worth, ~46
   calls; typically a fraction). FreshDot already shows the age. Nothing more
   to build unless the owner wants a different TTL per surface.
2. **Always-on claimable ticking — NOT RECOMMENDED.** A standing
   `refetchInterval` on N basket fee-state queries buys ~2–3 calls/min per
   parked tab to animate a number that moves slowly; the shipped behavior
   (per-item invalidation during sweeps + stale-refresh on focus) already
   keeps it honest at every moment a human is looking. Recommend closing the
   TODO line as satisfied-by-design.

## The complete poller census (every `refetchInterval` in the tree)

| Poller | Mount | Cadence | Gate | Verdict |
|---|---|---|---|---|
| basket list | all list surfaces (shared cache) | 300s / 900s unfocused | — | fine |
| auction deploy price | launch flow only | 12s | `canDeploy` | deliberate CTA |
| `LeagueBanner` score | homepage | ~~60s~~ → **staleTime-only** (this audit) | pool configured | fixed — an advert must not poll; /league's own 30s feeds the shared key |
| league snapshot + owed | `/league` | 30s | pool / connected | live leaderboard — watching IS the page |
| `CrownWinnings` | creator profile · /refer | 30s **viewer-only** (this audit) | holder viewing self | fixed |
| auction burn canvas ×2 | `/flush` | 60s | factory | burn console — watching IS the page |
| PRISM trade quote | home/swap/claim panels | 30s | open ∧ connected ∧ amount>0 | mid-compose repricing, correct |
| swap balance / PnL | token page, swap | 30–60s | connected | wallet-gated, focus-stopped |
| claim vault balance | `/prism` claim page | 60s | page open | transactional page, minor |

## Left deliberately untouched

The 12s auction poller (CTA correctness, already gated) · the /league and
/flush watch-pages (live is their purpose) · getLogs posture (already
optimal) · per-query staleTimes that authors set knowingly · `clientFor`
batch size (16 KB is right) · the nav book total (a THIN COMPOSITION over
the portfolio's own query keys — zero additional reads by construction).

---

## Amendment — token discovery (2026-08-06 12:58 recording, specallocator)

`token-discovery.ts` widened the portfolio sweep from "the curated verified
list" to "the curated list **plus whatever the wallet actually holds**", because
a token that launched this morning is on no list and was therefore invisible by
construction — the exact asset the owner's low-cap users care most about.

**What it adds to the numbers above.** Per chain, per page load, and nothing on
a timer:

| Read | Count | Notes |
|---|---|---|
| `alchemy_getTokenBalances` | 1 | only where the resolved endpoint is Alchemy (`canDiscover`) |
| `symbol()` + `decimals()` on unlisted holdings | 2 × N | N ≤ `DISCOVERY_CAP` (60); coalesced into multicall3 by the transport |
| `balanceOf` on unlisted holdings | N | joins the existing sweep's multicall, not a new round trip |
| DexScreener price batch | ⌈N/30⌉ **HTTP, zero RPC** | discovered tokens only |

**The idle posture is unchanged: still zero.** Discovery rides the load the
sweep was already doing; it introduces no poller, no interval and no refetch.
The refocus behaviour is the global 30s staleTime's, as before.

**Why discovered tokens are NOT priced through the pool engine.** That path
costs a `findBestPool` detection per token. At the cap that is up to 60 extra
detections per chain per load — the single largest read-count regression
available on this surface, and it would buy nothing, since DexScreener indexes
precisely these tokens better than pool detection does. the owner named both tools
in one sentence ("with the Alchemy RPC key… and DexScreener as well"), and the
split follows that: chain reads discover, HTTP prices. **Listed tokens keep the
pool path byte-for-byte**, so nothing already measured above moved.

**The cap is a real bound and it is reported, not silent.** A wallet holding
more than 60 unlisted tokens gets 60 (`truncated: true`); the rest of the book
is unaffected. Robinhood Chain has no DexScreener slug, so discovered tokens
there arrive **unpriced and visible** — never zero.

**Worst case, measured against the shape above:** a Base wallet at the cap adds
1 + 1 multicall'd metadata batch + 2 DexScreener HTTP calls to that chain's
portion of the 46-call portfolio load. A wallet holding only listed tokens adds
exactly one call per chain (the discovery probe itself), and a keyless build
adds zero — `canDiscover` is false and the sweep is what it always was.
