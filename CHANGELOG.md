# Changelog

Newest first. Every release bumps `version.json` (the machine-read update manifest —
deployed sites compare their built-in version against the raw copy of that file) and adds
a section here. The two must always carry the same version string; the app reads its own
version FROM `version.json`, so bumping the json is the whole code-side release step.
Releases touching the launch/trading money paths carry a `Sacred:` line naming them
(how releases work end to end: `docs/RELEASES.md`).

## 2026.08.21

Sacred: executor, swap, launch — the trade card's pay side now honours a caller-stated
settlement context, the post-buy hand-off became host-decided, and the launch card's busy
state gained the first-deposit phase it was missing. No floor, approval, simulation or
byte-verification law moved; the sacred smoke and the money proof are green against live
chains.

**The product is operable by talking to it.** A chat surface runs every money flow in
place: buying, selling, creating a basket, launching one across chains, redeeming in kind,
migrating into a successor, publishing a bundle, recording a new version, and claiming the
fees a basket has accrued to you. Every one of them signs in the visitor's own wallet, and
none of them sends the reader to another page to finish. The brain is deterministic — a
regex intent layer over the app's own money modules, with the language pass, the QA bank
and an endless orientation catch-all so a question can never dead-end. An operator may
point `VITE_AGENT_ENDPOINT` at their own language model without giving up any of that: the
contract lets a remote brain speak, suggest, and delegate one message back through the
deterministic machinery, and carries no field in which an action payload could travel, so
it cannot fabricate a trade. Absent, erroring, or malformed all mean the deterministic
brain answers exactly as it would have.

**One flow, one button.** A reply never puts two armed money primaries on screen at once.
A cross-chain launch takes one press and then walks itself: each chain's basket mined,
signed and live in turn, the first deposit riding the same signature where the wallet can
batch, a bridge offered when a chain is short, the bundle wrap firing on its own, and the
share options at the end. A multi-buy is one press over one card at a time rather than
four cards at once. An escape hatch is a text link, never a rival button. Where a flow
still needs a second decision, that decision is the wallet's, which is consent, not
friction we forgot to remove.

**Agents can operate a site.** `mcp/` ships in the kit: a zero-dependency MCP server that
bundles the app's own money modules and exposes them as tools. It holds no keys and never
sends. Reads answer with provenance; composes return the calldata, the value, and review
sentences a person can check; refusals are sentences that fire before any chain read. A
Bankr skill and a deep-link lane ship beside it, and `/mcp` documents the surface from the
generated manifest rather than a hand-kept list.

**The enterprise light plane** is a designed second skin rather than an inversion: its own
ink family, plate and hairline ladders, focus and scrim roles audited separately, charts
and error voices resolving live tokens, and the WebGL edge standing down where paper is
opaque.

**Creator surfaces**: `/creators` is action-first — pick what you're bullish on with the
real picker, see how baskets work, create in one click — and `/creators/explore` ranks
creators by value created since launch, with rows that mount live content only in view.

Fixes worth naming. The launch card's busy state omitted the first-deposit phase, so its
primary re-armed mid-deposit and a second press could deploy a second basket and pay a
second launch fee; that phase is now part of busy. A multi-segment route shipped without
its asset rewrite and served the SPA fallback where a module was expected, which is a blank
page on a cold load and invisible to in-app navigation; the rule is added and a test now
enforces one for every nested route. A disambiguation rail sent bare tickers while its
ordinal path sent actions, so tapping and answering could resolve differently; both now
send the same thing. A pay-side preference outranked a caller's stated settlement context,
which could read a dollar amount as native coin; context is checked first. The bridge
modal promised a hand-back that only the standalone swap page provides; the sentence now
matches the host.

## 2026.08.18

Sacred: executor, swap, launch — the sale step gains a fee lane, the single-swap paths
route through the fee wrapper, and the pool-discovery read (find-best-pool) moved with the
live-day routing work; every floor, approval and byte-verification law holds.

Operator-file note: this release's diff carries the operator-file covenant migration
(kit policy moved out of the files forks own, into `theme/kit-defaults.ts`) — the one
release cut WITH `--allow-operator-files`, exactly once, for exactly that commit; the
gate arms against `STATE.sourceSha` from here on.

The fee rail reaches every swap outside the batcher. Sells first: a sale whose asset
routes to settlement through the direct-swap wrapper rides it before the routing
services — the product fee (0.4%, 100% burns PRISM) charged on-chain with the plan's
numbers unmoved (the fee backs out of the outflow, the pull can never exceed what the
plan drew, and the floor still clears before anything signs). Any lane refusal falls
through to the routed lanes unchanged: honest feeless coverage beats a dead sale.

The protection dial, now fully pinned: per-leg floor overrides on measured-thin legs —
a consented looser ceiling, or no floor at all, per run, never persisted. One number
flows to all three surfaces (the asked slippage, the signed floor, the review sentence),
'none' floors at literally 1 wei and says NO FLOOR in words, and a leg whose depth
could not be read refuses even under consent — waiving is a choice about a measured
market, and an unreadable depth is not a measurement.

Refused legs get a door instead of a dead end. A leg the aggregator refuses at size
(the thin-book class — the same pool fills a wallet-taker fine) or declines outright
(hooked-market tokens) can be bought in its own transaction through the wrapper: one
click of consent per leg, quoted at click by simulating the real call, floored off the
measured output, re-proven, and signed byte-verbatim. Every route is proven against
the live chain before it carries money.

Restricted tokens are carried honestly: a token whose own transfer rule refuses the
wrapper (measured live on the hooked-market class) fills DIRECT through the router —
feeless because the token leaves no lawful way to charge, disclosed on the card in so
many words, with the floor still enforced on-chain by the router itself.

PRISM lanes stop undercharging: the wrapper's rate is 0.4% (the batcher's 0.25 assumes
the aggregator's own skim inside its quotes — no aggregator rides these lanes). Both
PRISM wrapper lanes now charge and DISPLAY the ruled rate. PRISM sells join the fee
rail through the fork-proven WETH-out payload: you part with exactly what you typed
(the fee comes out of it, stated), and proceeds arrive as WETH — the same asset as
ETH, unwrap any time — measured from the transaction's own logs.

From a full morning of live testing, the flow's remaining walls fell in place:

Routing is the machine's decision. The re-route consent doors lasted one session:
legs the aggregator refuses now carve themselves through the wrapper and run as part
of the same plan — one Run press covers the whole flow, carved legs execute one at a
time, and a refused one advances the queue instead of stalling it.

The sale floor gets a live basis. Sale floors were born from the indexer's spot
price, which lags a dumping market by minutes — unclearable at birth, inherited by
every rebuilt review. The review now asks the routed lane for each sale's own
enforced minimum at build time and floors on the lower basis. The sale lane also
signs the plan's own floor rather than double-haircutting itself out of the race.

The run's landing lands every time: written the moment the run completes, announced
when the flow leaves the screen (never spent behind its own overlay), and the book
settle-polls past the young chain's RPC lag so a just-bought asset tiles the first
moment the node can show it. Basket trims ride the wallet that actually holds them,
carved basket sells open their own overlay, and the bridge's mini-game can no longer
Space-click the flow closed. A transfer in flight now shows above the portfolio's
picture with its own Continue, surviving any close or refresh.

The gas top-up finds its price (the review reads native-USD per funded chain and
hands it to the runner — the seam existed and nothing supplied it), and a top-up the
destination already covers simply stands down instead of refusing the plan.

Airdropped tokens with no credible market no longer get a seat in the book: the
pricer demands real liquidity AND real trading from the deepest pool, and never-asked
-for tokens that fail it are hidden behind one counted line. Pasting an address
remains the door for a real token the bar catches early.

The basket page surfaces its share and referral doors as small controls in the
identity row, the thesis reads in body ink at a book measure, and the share card's
title and price fit their lanes with the price at two decimals.

The evening's hardening wave ships alongside, all additive: every run can now be
journaled for offline replay and its receipt reconciled against the money laws the
moment it lands (a diverted fee is a disclosed verdict in words, never archaeology);
an independent calldata lint re-judges the laws at the wallet seam; the basket
side's composition is pinned byte-exact by golden masters; an import-boundary
ratchet freezes the portfolio/basket cross-imports so the product line can only
tighten; and the money laws and measured bug classes are written down in docs/
(MONEY-LAWS.md, BUG-CLASSES.md). A handful of shared names moved to seam modules
(plan-shared-types, signable-confirm, run-progress, demo-catalog) with behavior
byte-identical and every attested money-core file untouched.

## 2026.08.17

Sacred: executor — the review-record surface (the waiver re-pins to this release's
digest under a recorded owner ruling; the reviewer's retroactive read stands welcome).

The portfolio-run repair release — every fix from one live evening of refusals, each
pinned with the exec log's own numbers.

Sales learned a second lane: when the routing service answers no-route (young chains,
thin coverage), the sale falls back to the 0x proxy the token page already trades
through. The laws hold unchanged on the fallback — pinned call target and approval
spender, the settler's own enforced minimum as the floor basis (a quote that cannot
state its minimum is refused), exact approvals, bytes signed verbatim. Native sales
never fall back; a double failure names both answers.

The batch conservation gate is generation-aware: it conserved against the legacy fee
constant while the composer sized legs at the chain's own gen-2 rate, so an honest
batch refused itself — two layers disagreeing where both were ours. It now reads the
same independent per-generation expectation the fee-equality law already pins.

The quote plausibility bracket's low side widened to carry the thin-book class: real
concentrated books at size can fill under the curve model's expectation (measured live
at 492bps on two independent sizes), and only the high side had been given that room.
Wrong-decimal and wrong-pair gaps still refuse — they miss by thousands of bps.

Gas readouts hold the null-never-zero law against hostile inputs: a negative or zero
native price can no longer become a displayed dollar figure.

## 2026.08.16d

The seed round, from the owner's live bundle test. Seeding no longer kicks you out
mid-run: the ceremony's seeded-watch used to swap the success face the moment supplies
read >0 — unmounting the live run overlay underneath you, right after the wallet handed
focus back — and now it waits until you close the run. A landed seed is celebrated as a
seed: the plate says "seeded", doors to the basket you just opened (not "View
portfolio"), and the backup "Now seed it" modal stands down for the session instead of
popping its buy console at the person who just seeded off a stale supply read.

The portfolio manage flow's Execute button ships ON by default. Its dark default was
written while the engine was simulated and carried its own retirement clause — "flip it
the release after the first real run" — and that run landed 2026-08-16. Operators who
want the flow dark write `create: false` in brand.config.

New: the update-from-spectrum action. Forks use GitHub's native sync (server-side,
workflow files included); template copies get a plain merge from the public repo. A
conflict stops with the exact local commands — your edits are never guessed at.

## 2026.08.16c

Sacred: launch, swap, executor — the deployment book's funding-split declaration and the
review-record surface.

The gen-3 deployment book now declares its packing factories: `packsFundingSplit` is true
on all three chains. The first live buy of this generation went out in the older no-split
payload shape and the basket refused it whole (the in-app probe measured the split-packed
shape succeeding — pools and amounts were fine); the seating template had missed the key
on every chain, so ETH and Base carried the same latent refusal. Money moved nowhere: the
refusal is the designed fail-closed behavior, and the fix is one declaration.

The 2026.08.16 review waiver now SHIPS with the tree, beside the review ledger it stands
in for, and joins the sacred registry under executor with the same F9 logic as the
ledger. It was created in the export-ignored release tooling, so the public
release-proof — which runs the interlock from a fresh clone — could not see it and
failed closed, exactly as the gate is built to do. A gate that is only green on the
maintainer's machine is not a gate: the waiver is public now, digest-pinned as before
(it voids the moment the money core moves), and a counter-ruling deletes one file to
restore the bar whole.

## 2026.08.16b

Deploy and CI fixes, no money-code changes. Netlify's edge-function bundling failed on
2026.08.16 because Deno requires extension-explicit imports and two files in the edge
graph (the OG meta module and the 0x-proxy handler) imported without `.ts` — the first
deploy since those modules were split out. Both imports now carry their extensions; the
functions' 43 tests and the app typecheck are unchanged-green. Separately, the
release-proof workflow could not prove 2026.08.16: its node-20 matrix leg cannot install
the locked tree at all (react-router 8.3 requires node >=22.22), and both build
simulations hit the new compose-enabled config check, which refuses any build with no
operator fee sink — correct behavior for a real deploy, so CI now simulates an operator
who configured one (a placeholder address; nothing deploys from CI).

## 2026.08.16

Sacred: launch, swap, executor — this release changes the fee model, both money contracts'
call shapes, and the portfolio executor's money path. Read the first two sections before
updating, and run the live micro-test.

### The fee model: 0.25% batching, 0.4% direct, and 100% of it buys & burns PRISM

The portfolio batching fee is now 0.25%, down from 0.40%. Where a buy routes through the
0x aggregator, 0x takes a further ~0.15% of its own inside the quote — not ours, and not
something we can waive — so those legs cost about 0.4% all-in. Swaps outside the batcher
carry a 0.4% fee. There is no integrator split anymore: 100% of every Spectrum fee buys
and burns PRISM, and the screens say so where the fee is charged.

Both money contracts are a NEW deployed generation with new call shapes (the fee-recipient
field is gone from each, so their selectors moved). Which generation a chain speaks is a
fact of the deployment book (`feeGeneration` in deployments.json, seated beside the
addresses), and every safety gate is generation-aware: the shown-vs-signed laws enforce
the right fee and refuse a recipient field on a generation that has none, the selector is
pinned against the mirrored ABI and re-derived from the deployed artifact at seating, and
a batch encoded for the wrong generation fails its own re-check rather than reaching a
wallet.

### Settlement decimals are verified against the token itself

Every conversion between dollars and settlement raw units used to assume six decimals in
the arithmetic. The decimals now live in the deployment book next to the settlement
address, every conversion in the app reads them from there, and before any sale, bridge,
or console swap signs, the token's own `decimals()` is read once and compared against the
config — a disagreement refuses in plain words instead of silently mis-scaling a floor.

### Version upgrades that in-kind cannot serve now run as a protected swap route

When a new version adds an asset your redemption cannot supply (and nothing dropped can
fund it), the upgrade no longer dead-ends: it sells the old version through its own pool,
measures the settlement that actually lands, and buys the new version with exactly that —
both trades floored and simulated before your wallet is asked. The buy spends only the
measured proceeds (bounded, so unrelated money arriving mid-migration is never swept in),
and if the second trade fails, your proceeds sit in your own wallet with a retry that
never re-sells.

### The first open guides your hand

The portfolio's first open now walks three spotlit beats over the real page — your whole
book, the positions grid, the rebalance door — once, ever. The onboarding arrival ends in
two numbered acts: link the rest of your wallets, then one free signature signs you in.
Discovery surfaces stop listing unseeded bundles under $100 of value.

### Every refusal carries its door

A sweep of every buy, sell, and migration surface removed the dead ends: refusals that
named a remedy now carry the button that does it (retry, re-quote, bridge, connect, buy
on the asset's own page), partial runs state what landed and where the money sits, the
fee shown and the fee charged can no longer disagree on the same screen, and a run's
completed steps keep their checkmarks through a retry.

## 2026.08.09

Sacred: launch, swap, executor — this release changes the SHAPE of the mint payload,
the address book, and the portfolio executor's money path. Read the first two sections
before updating, and run the live micro-test.

### The batching fee is 0.40%, and the screen can no longer disagree with the signature

The portfolio batching fee is now 0.40%, down from 0.50%. Where a buy routes through the
0x aggregator, 0x takes a further 0.15% of its own inside the quote — not ours, and not
something we can waive — so those legs cost 0.55% all in. Every percentage you see is now
computed from the one constant that is actually charged, so a fee shown and a fee taken
cannot drift apart again.

The same rule now covers the protection floor on the swap card. It showed you a minimum
and then signed a floor rebuilt at the moment you clicked, which on a moving market could
land below the number you read. It refuses now rather than signing, and it checks the
figure that actually reaches the contract rather than the one that was quoted. If your
quote moves between reading it and confirming, you get a plain sentence and a fresh look
instead of a signature you did not agree to.

If you sell for ETH or any token other than the settlement asset, that path works again —
a units mistake in the first version of this check refused every such sale.

### Your money cannot be sent twice, on a stricter definition of cannot

The record that stops a payment being sent twice after a reload used to report success it
had never verified: on a browser with almost no storage left, every check passed, nothing
was written, and a reload could re-send. It now proves the record survived its own read
before letting anything reach your wallet, and refuses honestly when it cannot.

Two browser tabs are handled properly too. Releasing a step no longer deletes a record
belonging to another tab's live transaction, and a claim on one trade can no longer be
mistaken for a claim on a different basket.

Under the hood the router and wallet libraries moved to their next major versions, which
clears every outstanding high-severity advisory.

### Buying a basket works again (it did not, on any basket with more than one leg)

A buy's payload carries a per-leg minimum AND the funding split that says how the
buyer's money divides across the legs. The kit wrote the minimums and left the split
empty, and the contract only derives the split itself when the payload is completely
empty. So nothing was funded and every multi-leg buy reverted. It is fixed: the split
now comes from the factory's own lens and is passed through untouched, and the
minimums follow it rather than the basket's target weights (those two were measured
28 percent apart, which would have turned one revert into another).

**Why the split is never computed from weights:** on a basket whose first depositor
starved a leg, a weight-derived split lets an attacker take a large share of a later
buyer's money. Measured by the contract authors: an attacker with 5,000 dollars turns
a 10,000 dollar buy into 4,255. The module that produces the split takes no weights,
no prices and no marks, so there is nothing in it a split could be derived from.

**Launching on a future contract generation** needs its address-book entry to say so
(`packsFundingSplit: true`). The generations are indistinguishable on chain at zero
supply, so this cannot be detected and must be declared. Every current entry is
correctly `false`.

### Everything else

The homepage leads with what you already hold and its doors open the real flows, the
mobile bottom menu carries the core places with a big-button drawer, long card lists
become swipeable rails on a phone, and the section rhythm is tighter throughout.
Baskets can be sorted by value, holders and age, cards mark the ones you hold, and
Command-K opens search from anywhere. Wallets can be linked into one portfolio,
everything a browser knows can be exported and restored as one file, and a wrong
network is now named before you sign rather than after it fails.


### Your book knows what you hold — including baskets

A wallet holding only basket tokens used to be told "nothing readable in this
wallet yet" the first time it opened the portfolio — the worst possible first
run for exactly the person who had already converted. Held baskets now join the
book the onboarding and the homepage draw, priced at their own value per token,
shown as one tile rather than doubled by their look-through legs. Seeding a
weighting draft still leaves them alone (a basket is not a plain leg the picker
can resolve) and says so instead of dropping them silently.

### One link for the life of a basket family, and one motion to extend it

Cutting a new version is now one flow: the creator's own basket seeds the new
recipe, and when the new basket lands, one signature links the lineage — after
which every link ever shared keeps answering with the current version. Older
versions stay fully inspectable forever, and holders of one get their upgrade
door where they arrive rather than somewhere they have to find.

### Honest by default, in the small places

Selling: the trade's tolerance is the seller's only protection on that side, so
a wide one is now marked as the exposure it is — and the guidance that used to
suggest widening it says plainly that smaller size is the answer on a sell.
Buying: a refusal after a burst of one-way buying reads as the transient it is
("the price moved while you were buying — this usually heals within ~30
minutes"), never as a dead end or a raw error code, and the fee is quoted in
dollars on the live quote rather than as a percentage to apply yourself. The
away briefing no longer calls a holding "new since your last visit" when all
that changed was our ability to price it.

### One link, every version

A basket link now keeps answering with the creator's **current** version: any
version's URL canonicalizes forward through the deployer-signed lineage (the
same-deployer `supersedes` claims — no registry, no curation). An honest strip
names the version the link carried, holders of the old version get their
upgrade door right there (migration runs FROM the version they arrived by),
and `?v=exact` keeps every superseded version fully inspectable forever — the
version strip's older pills use it. Creators share one URL for the life of a
basket family.

### The basket page reads in plain money

The hero is half its height with a real hierarchy: price · 24h · since-launch
on one row, the creator top-right beneath the price, the thesis directly under
the ticker pills, and "what is a basket" collapsed to a three-word chip whose
ⓘ carries the mechanics. THE MONEY STORY answers the first real question in
dollars — $100 in this basket since launch → what it reads as today, beside
the same $100 just holding the launch mix (absent unless every constituent's
history answered; window stated plainly; thin baskets say so). Holdings have
ONE home: the portfolio's own bento with money footers and hover 7d previews
over the numbers table. The console says what a buy does in one line and
prices the fee in dollars on the live quote. Display-side plain words:
"Total in basket", "Share of basket", "Value held".

### The basket page draws its book

The composition now renders as the portfolio system's own picture — the same
weight-true bento tiles with money footers from the basket's priced legs and
hover previews — above the assets table. Native ETH also seeds as its WETH
form in "start from what you hold" (a mostly-ETH wallet no longer seeds a
draft missing its biggest holding), and the empty-wallet found step gained a
"Build a portfolio" door into the flow.


### The homepage is the onboarding

The homepage was rebuilt around the manage-first funnel: a rolling two-proposition
hero over one wide live panel (the bento leads — real assets picked by measured
7-day performance, money on the tiles, the portfolio page's own chart beside the
total), a visual portfolio intro (the book as a bento, a live reweight dial, a
real composition arc), the loop stated as the one thing it produces (a real
published basket with its ticker and address), and a **get-started act that IS
the onboarding**: connect-first, the visitor's real cross-chain book drawn by
the product's own tiles, and two doors — *Build your portfolio* (opens the
portfolio's first-open ceremony) and *Create a basket token* (opens the flow
with the visitor's holdings riding along as a draft). Basket pages gain
**Start from this basket** (the recipe seeds a draft); a successful buy now
points at the portfolio; /learn's acts end in doors (the publish door
previously pointed at the retired /launch page).

### The portfolio's first-open ceremony

Opening /portfolio for the first time plays a three-step ceremony — the story,
connect, and *What you already hold* (the wallet's real major assets, drawn as
the product's bento) — ending in a reveal where the page builds itself. One
localStorage showing; `/portfolio?intro=replay` replays it, and "replay the
intro" in the wallet panel makes that findable. Strictly connection-honest: no
placeholder data ever stands under "What you already hold."

### Link wallets into one portfolio

Sign once per wallet to read them as ONE book: the ceremony summons the
wallet's own account picker, each joining wallet signs a plain-language
ownership message (EOA recovery, or on-chain ERC-1271/6492 verification for
smart wallets), and the portfolio merges balances, holdings and cost-basis PnL
across the group — while **acting always stays with the connected wallet**.
Groups live in the browser, travel as a signature-verified export/import file,
and resolve transitively across devices. Merged rows keep per-wallet
attribution (identity dots); the panel states when a stored link could not be
verified that session (kept, said, never silently dropped).

### Back up the browser, restore anywhere

One file now carries everything a browser accumulates — targets, drafts,
executed/published records, PnL cost-basis indexes, wallet links (re-verified
on import). Restore is additive and never overwrites newer local work. The
restore door sits on the portfolio's connect gate (where a wiped browser
lands); a one-time nudge offers the download once there is genuinely something
to lose.

### Pricing defence, seeding guard, and fixes

The D-R1 caller-split handshake is built end to end (absurdity detection,
packed `bareLegMins` reader — including classifying pre-rev factories that
answer with unpacked floors — and refuse-to-quote on disagreement), with a
calibration harness (`scripts/split-calibration.ts`). A **seed guard** warns or
blocks when a new basket's leg buy would swamp its own pool (the measured
first-mint self-wreck). Keyless Base/Ethereum sites get the ETH price anchor
back (the storage probe now runs where wide log scans are refused — every
ETH-paired price on those chains depended on it). WETH no longer shows an
unpriced dash when a rate-limited feed walk leaves a single live round.


### Your site can ship a browser extension

The kit now carries `extension/` — a read-only portfolio lens for the visitor's
toolbar, built with the operator's own wordmark and HOSTED BY THE SITE: one
packaging command (`cd extension && npm run package -- --into-site`) drops the
Chrome and Firefox artifacts into `app/public/extension/`, and the new
`/extension` page serves them with a browser-detected install walkthrough. The
`/setup` studio gains an Extension panel that shows packaging state and the next
command at each step; `update:site` now surfaces the changelog sections you
crossed and announces the extension when your checkout gains it. The lens never
connects a wallet, never signs, and never asks for a seed phrase — and the
install page states that it is the site's only official source. New optional
brand key: `extensionStoreUrl` (your own Chrome Web Store listing; Unlisted
visibility recommended for white-label). `.xpi` files are served with the
`application/x-xpinstall` MIME type on Netlify (`public/_headers`) and Vercel
(`vercel.json`).

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
