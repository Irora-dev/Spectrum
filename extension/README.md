# Spectrum — Portfolio Lens (browser extension)

> status: derived · as-of: 2026-08-02 · source: the extension spec
> (`the ops repo` ledger 2026-08-02 0049 → `outputs/extension-spec.md`) ·
> commitment: exploratory — first build, unreleased

**The extension notices. The site executes.** A read-only MV3 extension that
watches a portfolio of Spectrum baskets across chains while the browser is
open, and hands every action off to the operator's site by deep link. It never
connects, never signs, never holds a key, and asks for nothing beyond
`alarms` + `storage` + `notifications` + the read endpoints the site itself
uses. No account, no server, no telemetry.

**White-label, in the kit** (the owner, 2026-08-02): like the site, the extension
carries the OPERATOR's brand — name and palette come from
`app/src/brand.config.ts` (manifest at build time, popup via `applyBrand` at
startup). Never hardcode "Spectrum" into an operator-facing string. A website
cannot install an extension (Chrome removed inline install in 2018) — the
achievable shape is: source ships in the kit · setup builds it as an artifact ·
the site detects its absence and links to a store listing. The
detect-and-offer content-script marker and the kit-build step are later
rounds; per-operator vs canonical publishing is an open question with the owner.

## What it does

- **Exposure lens** — held baskets decomposed into net per-asset exposure
  (`app/src/lib/spectrum/exposure.ts`, the same math as the site), with the
  deterministic per-asset colors so a basket looks like itself in both places.
- **Targets & drift** — per-asset target weights (stored in the user's own
  `storage.sync`), per-row deltas and one aggregate drift figure.
- **Alerts** — local rules evaluated each poll: drift ≥ N pts · total value
  crossing · a held basket moving ≥ N% in 24h. Per-rule-per-subject cooldowns,
  hard back-off on failure. Copy states facts, never advice, and never implies
  real-time ("checked every N minutes while your browser is open").
- **Freshness & degraded states** — every figure carries its age; a failed
  chain read is *named*, never rendered as a zero.

## Layout

```
manifest.config.ts     MV3 manifest (permissions are the security posture)
src/sw/                service worker: alarms → poll → rules → notifications
src/shared/            portfolio assembly · rules · storage · localStorage shim
src/popup/             the 380×600 UI (one scrolling column)
src/popup/preview.*    review harness: the popup in a plain tab with fixtures
```

The shared analytical core is **consumed via the `@app` alias**
(`../app/src`), never modified — `exposure.ts` and `basket-data.ts` are
React-free at runtime, which is exactly what makes them portable into a
service worker. The popup additionally consumes two visual sources of truth:
`theme/theme.ts` (`applyBrand`) and `components/BasketAvatar.tsx` (the basket
mark), so identity can't fork. The worker has no `window`, so `src/shared/localstorage-shim.ts`
backs the lib's `persist-cache` with `chrome.storage.local` (installed before
any lib import; without it every poll re-spends the whole discovery budget).

Design tokens are restated from `app/src/index.css` in `src/popup/theme.css`;
`theme-parity.test.ts` pins every token to the app's value so they cannot
drift silently. Fonts are bundled locally via `@fontsource` (Chakra Petch +
JetBrains Mono) — no CDN fetch ever leaves an extension page.

## Working on it

```sh
cd extension
npm install            # app/ must be installed too (the lib resolves from app/node_modules)
npm run dev            # crxjs dev — load dist/ as an unpacked extension
npm run build          # tsc -b && vite build → dist/
npm test               # rules · drift math · shim · cooldowns · token parity
```

Review without loading the extension: `npm run dev`, then open
`/src/popup/preview.html?state=full|empty|loading|degraded` (`&tall=1` unrolls
the column for full-page screenshots).

RPC configuration comes from **`app/.env.local`** (the extension build reads
the app's env dir — one config for both surfaces). Keyless builds use the
public endpoints; poll cadence floors at 5 minutes either way.

## Distribution — the install story

**The ceiling first: no website can install an extension.** Chrome removed
inline installation in 2018; anything that circumvents the browser's install
flow is malware-shaped and gets extensions killed remotely. The honest maximum
is: the kit builds the operator's branded artifacts, the site itself hosts
them, and the user is one browser-native confirmation away. That's what ships:

```sh
npm run package -- --into-site     # or: node scripts/package.mjs --into-site
```

builds both targets and produces `artifacts/` (and mirrors it into
`app/public/extension/` so **every deploy of the site distributes its own
extension**):

| File | Channel |
|---|---|
| `<slug>-extension-chrome.zip` | Chrome Web Store submission; unzipped = load-unpacked for operators/testers. Brave and Edge install from CWS too. |
| `<slug>-extension-firefox.zip` | AMO submission (`web-ext lint` passes: 0 errors). |
| `*.xpi` (with `WEB_EXT_API_KEY`/`SECRET` set) | **Signed, self-hostable Firefox build** — unlisted AMO signing is an automated API step, not a store review; the `.xpi` served from the operator's own site installs with one click. Serve it as `application/x-xpinstall`. |
| `index.json` | Name/version/file descriptor the site's `/extension` page renders from. |

Per-browser reality: **Chromium** (Chrome/Brave/Edge) one-click requires a
store listing — per-operator under white-label, $5 registration + a review
that is slow and often crypto-hostile; until then the site serves the zip with
a load-unpacked walkthrough. **Firefox** is the self-hosting exception and the
most automatable channel end-to-end. The Firefox build (`npm run
build:firefox`) is the Chrome dist with an event-page worker (`sw.js`, one
IIFE — Firefox MV3 has no service workers) and a stable per-operator
`gecko.id` derived from the site host.

### Chrome Web Store, one command (after a one-time ritual)

The store cannot be bypassed for normal Chrome/Brave users, so the kit makes
the *application* to it nearly free instead:

```sh
npm run store:assets      # store/listing.md (paste-ready, incl. permission
                          # justifications + privacy answers) + 1280×800
                          # screenshots rendered from YOUR branded popup
npm run package           # the submission zip
npm run publish:chrome -- --create   # first time: uploads as a new item, prints its id
npm run publish:chrome    # every later version: upload + submit for review
```

The irreducible one-time human part (~15 min + Google's review wait): the $5
developer account, pasting `store/listing.md` into the dashboard once,
uploading the generated screenshots, answering the privacy tab (answers are
in `listing.md`), and minting the API credentials (`CWS_CLIENT_ID` /
`CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` in `.env.local` — setup steps in
`scripts/publish-chrome.mjs`). Recommended visibility for white-label builds:
**Unlisted** — one-click install for anyone coming from your `/extension`
page, no store-search presence. `publish-chrome.mjs` is written against the
documented CWS API v1.1 but has not been run with real credentials here.

**Release rule:** any kit release that changes `extension/` must bump this
package's `version` — both stores reject a re-upload of an already-used
version number, so a same-version release silently strands operators on the
old extension.

**Setup-studio / update-flow contract:** `npm run status` (add `--json` for
the machine form) reports the whole distribution state — what's built,
packaged, site-hosted, store-packed, which credentials exist — plus a `next`
list of the exact commands a surface should offer, in order. The kit's
`/setup` extension panel and `update:site`'s what's-new step render from
this; keys are append-only.

**Detect-and-offer:** site-configured builds carry one content script,
scoped to the operator's own origin, that stamps
`document.documentElement.dataset.spectrumLens = <version>` (plus a
`spectrum-lens` CustomEvent). The site checks the attribute and offers the
install only when absent. Unconfigured builds ship **no content script at
all** — the minimal-permissions posture holds.

## For agents (Claude · Trae · Codex — whoever operates the kit for a human)

This flow is designed to be RUN BY YOU on the operator's behalf. The contract:

1. **`node extension/scripts/status.mjs --json` is your only interface** to
   the distribution state. Its `next[]` array lists the exact commands to run,
   in order. Bind to nothing else; keys are append-only.
2. Run the `next` commands as given (from `extension/`; both `app/` and
   `extension/` must be npm-installed). After any command, re-run status and
   report the new state to the human in plain words.
3. **Credentials come only from the human, verbatim** — `CWS_CLIENT_ID/SECRET/
   REFRESH_TOKEN`, `WEB_EXT_API_KEY/SECRET`, `CWS_ITEM_ID` — into the
   gitignored `extension/.env.local`. Never fabricate, guess, or autofill one;
   never print a received secret back. Same class as the kit's fee-wallet
   red line.
4. **Human-only steps — prepare for them, never attempt them:** creating the
   $5 Chrome Web Store account, the dashboard's privacy tab and first-listing
   assets (paste from `store/listing.md`), store review itself, and the store
   URL — which you accept from the human after review, never invent.
5. **Never try to bypass store installation** (sideload automation, CRX
   tricks, forced installs). Browsers block it and it is the shape of malware;
   the three honest channels are the store listing, the signed `.xpi`, and
   load-unpacked.
6. Copy you write anywhere in this flow keeps the product's honesty: alerts
   are "checked every N minutes while the browser is open" (never
   "real-time"), figures carry their age, facts never become advice.

## Deliberately not here

Signing, key custody, autonomous execution, `tabs`, `<all_urls>`, WebGL, any
content script beyond the own-origin marker above. Deep links carry **intent
only** (`/portfolio`, `/token?addr=&chain=`) — the site recomputes from live
state, and no link lands on a signature.
