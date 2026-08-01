# Changelog

Newest first. Every release bumps `version.json` (the machine-read update manifest —
deployed sites compare their built-in version against the raw copy of that file) and adds
a section here. The two must always carry the same version string; the app reads its own
version FROM `version.json`, so bumping the json is the whole code-side release step.
Releases touching the launch/trading money paths carry a `Sacred:` line naming them
(how releases work end to end: `docs/RELEASES.md`).

## 2026.08.01

Sacred: launch, swap — the canonical address book moves Ethereum and Base to the
launch-ceremony factories and routers, and the trade path now picks a basket's router
from its own lineage. **`impact: breaking`** — not because anything needs reconfiguring
to work, but because bundles ship disabled and an operator currently showing them must
add `bundle` back to `pages` to keep them. Read the last section before you update.

### Ethereum + Base are on the new contracts

The canonical book now points both chains at the launch-ceremony deployment (read back
live before seating, the same ritual as Robinhood's leg): flat **0.003 ETH** launch fee
from genesis, the burn machinery aimed at the **v2 PRISM** burner, community-created
baskets, and the notes registry live at the same CREATE2 address on all three chains.
The auction-burn console on the fee page drives the new burner with its mandatory
slippage floor and sized slices. Launch and trading on Ethereum and Base work exactly as
on Robinhood Chain.

### Superseded lineages keep their baskets

A chain's entry in the address book can now name the lineages it has retired
(`legacy: [{ factory, swapRouter }]`), and Ethereum and Base ship with theirs. Baskets
launched on a retired factory **stay listed and stay tradable** — discovery walks every
lineage, each basket remembers which one it belongs to, and its trades, deployer and
inception date are read from the contracts that actually minted it rather than from the
new factory, which knows nothing about them. A superseded basket keeps trading through
its **own** router: pairing an old basket with a new router is a combination nobody has
tested, and the money path does not gamble. Launching only ever uses the live factory,
so every new basket starts on the current contracts. Cost basis covers the old baskets
too — the position scan reads every lineage's router in the same single call.

### Your position, honestly measured

The Token page's right rail leads with a holdings card — current value, total invested,
net PnL with its percentage — and each Portfolio holding carries the same strip, with an
all-holdings summary under the Portfolio hero. The basis is average cost over what your
wallet traded through this site's routers, in settlement dollars: tokens that arrived any
other way are excluded rather than guessed, and the ⓘ says exactly what is covered. The
whole feature costs about one RPC call per wallet (one trader-filtered log scan, cached
and topped up incrementally).

### Holder fee claims, visible where you look

A holder asked how basket trading fees actually reach them — fair question, it was
undocumented. Now: the holdings card on every basket page shows your claimable fee
reserve with a one-click path to the fee console, the Portfolio summary aggregates it
across holdings, and the FAQ answers it plainly ("As a holder, how do I receive my share
of the fees?"): the holder share accrues per token to a reserve beside NAV — never
inside it — and you pull it to your wallet whenever you like; `claimableFees(you)` on
the basket contract is the same number.

### The basket page, rebuilt around the thing you came for

The card runs about 10% wider and all of the extra width goes to the chart, since the
swap rail is a fixed track. The creator and their thesis move out of that rail and into
the header, where a paragraph reads across the page instead of down a narrow column, and
the constituent logos move under the price. Both chart renderers gained a **left price
axis** — there was none before, on either. Under the price sits a **since-inception
return**: value per token today against its value at creation, which being a ratio cannot
be flattered by the size of the basket. Below the $1,000 measurability floor it renders
muted and says "too thin to call a track record", because one trade can move a thin
basket's price on its own.

### Shorter links, and every old one still works

A basket is now `/t/r/T2-29374eaa` rather than a 62-character query string; creators and
published bundles get `/c/…` and `/b/…`. **Every existing URL keeps resolving exactly as
before** — this is additive routing, never a rename, because links already shared are not
ours to expire. The reference is `SYMBOL-<8 hex>`: the symbol for people, the address for
the machine, and both halves must agree or the link is refused rather than guessed. A
bare ticker still works, and when one is ambiguous the page lists the candidates instead
of picking for you.

### Fixes from a day of real use

- **Info popups never get clipped.** Every ⓘ panel now escapes its card, so an explainer
  can't be cut off by the rounded corner it sits behind.
- **The quick swap lists the network you are on.** It was pinned to Base whenever the
  chain filter was "All", so on a Robinhood site the picker looked empty beside a full
  page of baskets.
- **One slow RPC no longer hides baskets.** A single throttled read could collapse
  discovery to a short recent-blocks scan, hiding retired-lineage baskets and anything
  older than about a day until the next poll happened to succeed.
- **`/earn` shows holder fees.** It claimed to list everything an address earns while
  only summing the fee-tag pots; the holder share is a separate per-basket reserve and
  was invisible there.
- **The browse floor is $10, down from $100.** The old floor was set when launching cost
  far more, and against a flat launch fee it was hiding real baskets rather than noise.
  Search always reached them; this is about the browsing surfaces.
- Cost basis now covers retired-lineage baskets, and a sell whose proceeds cannot be
  priced books nothing rather than guessing.

### Bundles are off by default

The cross-chain bundle idea is becoming its own product and is being rebuilt elsewhere,
so the `bundle` page ships **disabled**. Adding `bundle` back to `pages` in
`brand.config.ts` restores the pages exactly as they were — nothing was removed. If your
site currently shows bundles and you want to keep showing them, add that one entry when
you update; otherwise the routes, the nav link and the home and explore tabs simply do
not appear.

## 2026.07.31

Sacred: launch, swap — display surfaces on both paths changed (the launch popup's mining
readout; the swap console's error presentation). No calldata, floor, route or address
changed. `impact: config` is the sacred-release floor — there are no new keys and
nothing to reconfigure; update and redeploy.

The first live-launch-night feedback, fixed same-day:

- **The Explore chain filter now offers every chain that has baskets.** It was hardcoded
  to All / Base / ETH — on a Robinhood Chain site every chip filtered your baskets out and
  4663 had no chip at all. The row now derives from the chains actually holding baskets.
- **`LegMinNotMet` explains itself.** The trade revert now carries an ⓘ ranking its likely
  causes, most-likely first: a thin pool where your own trade's price impact exceeds the
  tolerance (deterministic at that size — a smaller amount is the test and the fix), the
  price moving between quote and signing, a refused sandwich, or a rare mid-trade rebase.
- **Basket-launch mining shows honest progress.** "Could take a few minutes…" at proper
  display size plus a pixel bar that fills with the cumulative probability of having found
  the salt (capped below 100% — the search is luck-of-the-draw, and the bar never lies).
- **Updating is spelled out for AI agents.** The install guide now says how an agent
  discovers a new version (`npm run doctor`) and guarantees what an update never touches:
  your name, colours, pages, site URL, fee wallet, RPC key, creator metadata — and your
  domain, DNS and HTTPS, which stay exactly as they are. `node create/update.mjs` remains
  the one-command path; you redeploy the same way you always deploy.
- Also: the README opens with the from-nothing one-liner (clone + wizard), and the stocks
  shelf's guidance stopped pinning per-ticker pool claims that age within hours.

## 2026.07.30

Sacred: launch, swap — the launch page's suggestion shelf changed, the swap console's
**displayed** receive estimate now comes from a simulated fill instead of NAV arithmetic,
and the canonical address book gained Robinhood Chain's new launch-ceremony contracts.
The signed **minimum received** is untouched on both paths and every per-leg minimum still
commits exactly as before. `impact: config` because there are new `brand.config.ts` keys —
all default-ON, so an existing config keeps behaving identically.

### Robinhood Chain contracts are LIVE in the canonical book

The 4663 entry now carries the launch-ceremony deployment, every address read back
on-chain before seating and proven by a real basket launch through this kit the same
night: the basket factory (flat **0.003 ETH** launch fee; baskets are community-created —
this kit is the creation surface), the swap router, the creator-league pool (the 5%
league carve now shows in every fee split there), and the notes registry (theses,
bundles and the social layer work on 4663). Launches respect the factory's 10-block
cooldown: while it's closed the builder shows **"next slot opens in ~N blocks"** read
from the chain, never a stale price, and launch-path reverts (`SlotNotOpen`,
`MaxCostExceeded`, `InsufficientPayment`) all decode to plain language. The launch copy
no longer says "auction" anywhere — the fee is read live either way. Base and Ethereum
stay on their existing live contracts until their ceremony legs land. Also new:
`npm run verify:deployments` reads the whole book back from the live chains (code at
every address, factory/league/notes invariants) so nobody ever trusts a pasted address.

### PRISM trading holds up when aggregator coverage blinks

The PRISM trade card quotes and fills the {ETH, PRISM} v4 pool **directly** (canonical
quoter + Universal Router, minimum enforced on-chain, Permit2 for sells) whenever the
routing service has no route — its coverage of the young pool proved transient within a
day. Every route, aggregator or pool, now simulates the exact transaction bytes before
your wallet sees them, the card gained the swap console's slippage knob, and the claim
page's network-fee estimate follows the wallet that actually pays.

### Fee pots under a chain's crank floor say so

On Ethereum the contracts refuse frontend-fee flushes at or under 10 USDC (the crank
bounty floor). Everywhere such a pot appears — /earn's claimable headline, claim-all,
the nav badges, both flush-console lists, the crank-all sweep — it now reads
**"accruing · flushes over $10"** instead of posing as claimable, and the sweep skips it
the way sub-threshold burns are skipped. Base and Robinhood have no floor; nothing
changes there.

### Mobile is a first-class surface now

Nothing to configure.

- **A bottom tab bar is the phone navigation** (Home · Explore · Swap · Portfolio · More),
  replacing the top burger menu. It reads the same gated link model as the desktop menu, so
  your `pages` choices govern both, and it hides once the full top menu fits. It steps out
  of the way while the on-screen keyboard is up, and re-tapping the active tab scrolls to
  top. More opens a bottom sheet with drag-to-dismiss.
- **The basket page grows a mini-buy bar** once the swap console scrolls out of reach — one
  tap back to the single console, never a second one.
- **Overlays are reachable on a phone.** A dialog taller than the viewport used to overflow
  off *both* ends with nowhere to scroll — the buy-success **Done** button was unreachable
  on most phones. Fixed for the buy overlay, the walkthrough and the share card, with
  safe-area padding so the last row clears the home indicator.
- Text inputs sit at the 16px floor iOS needs to stop auto-zooming on focus; numeric fields
  raise a Done key; token pickers no longer open the keyboard over the list you meant to
  browse; hidden-scrollbar rails carry an edge fade; the launch builder's rows breathe at
  375px; the quick-buy strip is container-queried so its controls can never overlap at any
  embedded width.
- **The animated background stops drawing** under `prefers-reduced-motion` (it used to
  redraw an identical frame ~60×/second) and in the flat design styles that hide it, and it
  no longer reallocates its buffer while the mobile URL bar collapses mid-scroll.
- **Hero art ships phone-sized variants**, so a phone stops decoding 4K images (the home
  hero drops ~1.2 MB → ~125 KB) and the below-fold league banner loads lazily.
- **Your PWA manifest is branded.** It said "Baskets" on every operator's Android install
  prompt regardless of your name, and its absolute URLs 404'd under IPFS/ENS gateway paths,
  which killed installability. Both fixed; the manifest is generated at build time.
- **Your browser tab carries your name.** Every route title hardcoded "Spectrum",
  overwriting the build-time branding one frame after load.

### New product knobs in `brand.config.ts`

All default-ON — omit a key and you get it; only an explicit `false` turns it off. The
`/setup` studio and the CLI wizard both set them. Full table: `app/OPERATORS.md` →
"Product knobs".

- `prismCredit` — a small "Powered by Prism" banner on the home, basket, swap and fee
  pages, linking out to Prism Beat. `false` removes every instance; the protocol's PRISM
  buy-and-burn leg is contract-side and unaffected either way.
- `starterTokens` — a small curated starter set the launch shelves fall back to before your
  chain has baskets of its own to learn from. `false` leaves the shelf purely organic.
- **`stocks: false` now also drops stock suggestions** from the launch shelf. It hid every
  stock *surface* while the shelf still suggested tokenized stocks.
- **The CLI wizard reached parity with the studio.** `--no-stocks` was parsed as a page name
  and silently ignored; `bundle` was missing from its page list; and it could not write
  `stocks` / `setupStudio` / `defaultChainId` at all, which the studio could. All fixed, and
  `--default-chain-id` is new. Both drift hazards are now pinned by tests.
- **The `/setup` studio's Apply no longer rejects the default site name.** The dev-server
  middleware still refused any name containing "Spectrum" after that rule was dropped and
  "Spectrum" became the shipped default — so following the documented onboarding with the
  default name failed with "invalid site name". The name is yours: up to 32 characters,
  "Spectrum" included.
- An operator who locked their site with `--no-setup-studio` and then pressed Apply on a dev
  build silently got `/setup` back on the next production build. The studio's exporter now
  round-trips that key.

### Drop-in setup for AI IDEs

Dropping this repo into an AI IDE is now enough on its own — no prompt needed. Trae reads
`.trae/rules/project_rules.md`, other agents read the new root `AGENTS.md`, and Claude Code
already read `CLAUDE.md`. All three point at `START-HERE.md`'s runbook rather than copying
it, and all three carry the red lines inline.

### Deploy: your own domain

`START-HERE.md`, `app/SETUP.md` and the wizard's own printed guide now spell out custom
domains per host, because one buried clause read as if it weren't supported. On **Cloudflare
Pages**, `npx wrangler pages domain add <project> <domain>` writes the DNS record and issues
HTTPS itself when the domain is already in that Cloudflare account — no registrar step.
**Then re-set your site URL to the custom domain and rebuild**, or link previews and the
sitemap keep advertising the host subdomain. Also: the sitemap now lists all 15 public
routes (it had drifted six behind) and drops any page you switched off.

### Displayed numbers say what they actually are

A full honesty pass. No math changed — the captions and the failure states did.

- **Earnings copy was overstating by 33–100×.** The `/earn` tiles read "~5% of every trade";
  the slice is ~5% of each trade's **fee**. Same class on the creators page: "30% of the fee
  pool" is 30% of what remains *after* the burn and interface/launcher slices, roughly a
  quarter of every fee — the split diagram beside it already said so.
- **A failed read no longer poses as a real zero.** The fee console showed "$0.00 · Nothing
  to claim" when an RPC merely blipped, and a failed lookup dropped a creator's pending row
  entirely. Likewise a chain whose basket list failed was indistinguishable from an empty
  chain, silently understating your portfolio total and earnings; those totals now say
  "1 network unavailable".
- **Partial sums are marked partial**: bundle "combined TVL" counts unpriced legs
  (`$40K+ · 1 leg unpriced`), and holder and follower counts read `N+` when the scan was
  windowed.
- **Dust can't fake performance**: a sub-floor basket could top the Today leaderboard on
  seed-size noise, and a drained superseded version showed absurd percentages on creator
  pages. Tag counts only count listable baskets, so a chip never promises results the click
  can't show.
- The swap console's receive estimate now moves with price impact (it was fee-only NAV
  arithmetic, mathematically incapable of it); a basket card's spark matches the 24h figure
  beside it; "earned" became "pending" for a balance that zeroes on claim.
- `check:config` now warns on a `defaultChainId` that no scaffolded chain matches — the app
  silently fell back to Base, so a typo looked like it worked.

### The creator league is a live stream (only where you configure a pool)

`leaguePool` is unset in the shipped deployment book, so **no league surfaces exist unless
you configure one** — this section only matters if you do.

The mechanism changed: there is **no prize pot and no season-end settlement**. Every basket
skims a league slice off each fee and cranks it to the pool, and whoever holds the crown
when a slice arrives is entitled to it immediately and can withdraw at any time. Seasons
still exist, but only as the **scoring window** — scores reset every 30 days while the crown
carries over, so the countdown reads "scores reset in", never "payout in". The page shows
the score to beat, a pixel crown on the current holder, and the gap each challenger must
close; crown earnings are withdrawable from `/earn` and the creator page too. Delivery is a
pull by design and there is deliberately no auto-payout.

Copy that is now false and was removed everywhere: pro-rata shares, √-weighted shares,
"your fees, your share", prize pools, claim-at-season-end, and any wash-proof or Sybil-proof
framing.

### Also

- The animated spectrum bands now render in the **foreground** over content, with their
  bright lanes stopping at the content gutter so cards clear them at every width; the main
  column is 1000px to match. The nav sits above the bands, and the bands no longer ship into
  third-party `/embed` iframes.
- The holder-wall reaction read is bounded by a block window. It was the one read shape that
  pins no author, so its result set grew without limit; the `kind` topic narrows by shape,
  not volume, and the holder checks bound what renders, not what downloads.
- The `/swap` page's what-you're-buying panel now renders on phones (it was desktop-only, so
  phone buyers got no thesis or composition context), and the console's connect button
  actually opens the wallet dialog instead of pointing at "top right".

### New page: `/claim` — PRISM v2 community-airdrop claim tool (+ the PRISM trade card)

The PRISM community's v2 launch includes a make-good allocation for 1,203 v1 holder
addresses in a permissionless Ethereum vault. `/claim` (page key `claim`, default-ON,
toggleable like every page, linked from the More menu) checks the public snapshot, shows
claimed/unclaimed state and a live network-fee estimate before any signature, claims for any
address (delivery always goes to the snapshot address), and walks large holders through the
fee-share NFT mirror top-up (`syncNFTs`) their claim needs. The page wears the site's hero
treatment (masked art, wordmark-sweep title) with a live vault-balance strip. A site-wide
banner points every visitor at the claim (generic line; personal once a snapshot wallet
connects; gone once that wallet is paid; session-dismissible). The snapshot rides in the
build as lazy chunks (53KB eligibility index; the 1MB proofs file loads on `/claim` alone).

Alongside it: a **PRISM trade card** — "the token that powers Spectrum" — on Home and under
the `/swap` console as a buy, and on `/claim` as a full buy/sell mini console (slippage knob,
route-enforced minimum, and a success line measured from the transaction rather than the
quote; selling approves the route exact-amount first). It rides the same guarded routing leg
as the any-token pay side and never touches the basket swap console. Gated by the
`prismCredit` knob + the swap flag, so operators who drop the ecosystem credit ship none of
it. The tool is neutral by design: the token is community-launched, and the page says so.

### Ship-readiness pass (a stranger's first deploy)

- **The social card (`public/og.png`) is name-neutral now.** The shipped art carried the
  package authors' wordmark, an outdated tagline and a chain list — every operator's shared
  links unfurled with it. The new card is neutral spectral art; your `og:title`/description
  text (branded from `brand.name` at build) carries your name. Replace the PNG for your own
  art (1200×630).
- **`sitemap.xml` can't go stale anymore.** It's regenerated by every build from your site
  URL — an origin-less build now writes the stub instead of leaving a previous build's
  origin in place — and it's no longer a tracked file.
- **`/bundle/<creator>/<slug>` deep links load** on Netlify/Vercel: the shipped
  `_redirects`/`vercel.json` gained the bundle asset remap (a hard refresh used to get
  `index.html` served as the page's JavaScript — a blank page).
- **`--tier info` now means what it says**: browse/read with no wallet. The wizard used to
  emit `wallet: true` for it.
- The fee-split shown on `/creators`, in the walkthrough and in the launch builder is
  league-aware on chains that carve the creator league (the split bar gained the league
  slice; FeePanel lists it as a row) — on every other chain the numbers are unchanged.
- Docs squared with reality: a missing site URL is a warning (not fatal), `docs/deploy/
  netlify.md` exists (with the per-URL OG cards it enables), dead anchors fixed, the two
  host docs stop telling you to overwrite the shipped SPA-fallback files with bare
  catch-alls, `.env.example` lists all real vars, README no longer forbids the default
  site name, and `npm run doctor` cross-checks "up to date" against the kit repo's actual
  commits, not just the version string.

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
