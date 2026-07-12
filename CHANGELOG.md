# Changelog

Newest first. Every release bumps `version.json` (the machine-read update manifest —
deployed sites compare their built-in version against the raw copy of that file) and adds
a section here. The two must always carry the same version string; the app reads its own
version FROM `version.json`, so bumping the json is the whole code-side release step.
Releases touching the launch/trading money paths carry a `Sacred:` line naming them
(how releases work end to end: `docs/RELEASES.md`).

## 2026.07.13

Sacred: launch — the launch page's pool discovery and token screening changed (coverage and
honesty fixes; the route convention itself is untouched). No action needed on your site
beyond the normal update; `impact: config` is the sacred-release floor, not a config change.

- **V4 pools are now discovered on ANY endpoint**: when the full V4 log scan can't run
  (no private RPC) or a provider refuses it (log-range caps — common outside Alchemy),
  the standard fee tiers are probed directly by computed pool id, which every endpoint
  serves. Builds that previously saw zero V4 venues now see the standard-tier pools with
  real depth; only exotic tick spacings still need the full scan.
- **Coverage warnings now state the actual cause**: a failed scan on your own provider no
  longer prints "no private RPC" (it says the scan failed and standard tiers were probed);
  the launch page's coverage banner only renders when the build truly lacks a private RPC.
- **Stale coverage banners are gone**: warnings persisted in a saved launch draft from an
  older/keyless build are dropped on restore when the current build can scan — the banner
  can no longer quote a scan from a previous configuration (reported live by a builder).
- **Token screening no longer mislabels real tokens on RPC blips**: a dropped/rate-limited
  `decimals()` read was hard-failing tokens as "not a standard ERC-20" (a real Base token
  hit it). Only a genuine contract revert is a verdict now; transport failures read as
  "couldn't check — add again to retry".
- The launch-block index and the portfolio's error hint now recognize any private RPC
  (provider URLs), not just an Alchemy key; all four RPC env values are trimmed at the
  read so stray whitespace can't arm a broken endpoint.

## 2026.07.12

Sacred: launch — the pool-route detection's V4-coverage gate changed (see the RPC bullet
below); routes themselves are untouched and the live sacred smoke passed on every chain.

- **Any RPC provider now unlocks full V4 coverage**: the complete V4 pool sweep used to
  arm only on an Alchemy key; a build configured with your own provider URL
  (`VITE_BASE_RPC_URL` / `VITE_MAINNET_RPC_URL` — QuickNode, Infura, self-hosted, any)
  now gets the full scan too, and the launch page's coverage banner says "no private
  RPC" with both fixes instead of assuming Alchemy. The any-provider rail is now a
  first-class citizen everywhere you configure RPC: the `/setup` studio grew per-chain
  provider-URL fields (either rail satisfies the requirement, and a URL pasted into the
  key field is caught with a pointer), the wizard accepts a full https URL in the RPC
  question (with a which-chain follow-up) plus `--rpc-url-*` flags, and the generated
  `.env.local` carries all four lines.
- **One-command site updates**: `node create/update.mjs` (or `npm run update:site`) — same
  on macOS, Windows, and Linux. It previews what's coming (version, impact, whether your
  version was recalled), snapshot-commits your local state, merges with your files winning on
  `brand.config.ts` / `site.config.json` / `metadata/**` (`.env.local` is gitignored —
  untouchable by updates), offers to add an RPC (key or any provider's URL) when none is
  configured, installs, runs the doctor, builds, and prints your host's exact redeploy
  commands. Every failure path prints its undo; your live site changes only when you redeploy.
- **Releases are now versioned, tagged, and proven**: every release is tagged `v<version>`
  with a GitHub Release; CI (`release-proof`) re-runs the full gate — typecheck, the whole
  test suite, the wizard suite, a production build, and a fresh-clone builder simulation —
  on every release commit, and a daily `canary` re-runs the live chain smoke so chain-side
  drift surfaces here first. The new `docs/RELEASES.md` explains all of it.
- **The launch and trading systems are guarded**: `sacred-paths.json` registers the code
  paths that move user money; a release touching them must declare it (manifest + changelog
  + CI cross-check) and pass a live read-only smoke (`npm run smoke:sacred`) — on every
  chain, an existing basket's own legs re-simulate a full `deployBasket`, the route
  convention and NAV/price surfaces are verified, and the LiFi hub quote must pass the
  app's own guards.
- **The update manifest grew** (`impact` / `sacred` / `yanked`): the operator notice and
  `npm run doctor` now say how much care an update needs, and can recall a bad version —
  if your built version is ever yanked, your `/setup` studio shows an urgent notice and
  the doctor fails until you update. Old builds ignore the new fields safely.
- **Indexing reference on `/docs` (chapter 11) and `/integrate`**: every canonical event with
  its full signature and topic0 hash (computed from the shipped ABI at render, so it can't
  drift), verified-source explorer links, and the edge cases that break standard indexer
  heuristics (two supply numbers, pull-based fees, auction-slot reverts, per-chain settlement
  asset, shared CREATE2 addresses, hook-owned liquidity).
- Fix: the wallet-connect button no longer disappears on browsers without an extension
  when features are configured via `site.config.json` (the connector set now reads the
  resolved flags).
- **Mobile wallet connect actually works**: on a phone browser (no extension, so the old
  "Injected" row did nothing) the connect dialog now offers "open in your wallet's app"
  deep links (MetaMask, Phantom, Trust) that reopen the site inside the wallet's dapp
  browser where connecting works, hides the dead injected row, and points Rainbow /
  Uniswap / Rabby users at their built-in browsers or the WalletConnect option when the
  site has a project id configured.
- `/integrate` now tells integrators where their fee accruals live and links the `/flush`
  console to claim them.

## 2026.07.11

- New canonical Spectrum contracts on Base and Ethereum (fresh factories + routers).
- Robinhood Chain (4663) ships live as a third chain: wallet connect + chain toggle,
  launch (Dutch auction), USDG-direct buy/sell and referral through the canonical
  router, contract verification, and the config/doctor/chain-smoke checks. USDG
  (Global Dollar) is the settlement asset there; labels follow the chain.
- V4-native pool detection: the launch page's asset validation now runs on any chain
  with a Uniswap V4 PoolManager (V2/V3/Aerodrome scans join in where that infra
  exists), and on chains no price indexer covers, ETH/USD and per-leg prices read
  straight from the pools on-chain (the settlement pool anchors $1).

## 2026.07.10

- First public release: the complete operator front end (React 19, zero backend), the
  in-site `/setup` studio, the agent-run setup flow (`START-HERE.md`), five design styles
  with per-style structure and fonts, the canonical Spectrum contracts wired by default
  on Base and Ethereum, `/verify` contract verification, zip-drop + VPS hosting paths,
  and the `doctor` / chain-smoke self-checks.
