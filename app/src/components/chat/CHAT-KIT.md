# The Chat Kit — the conversational surface as a reusable system

status: canonical (for this module) · as-of: 2026-08-20 · source: this directory + `app/src/pages/Chat.tsx`

One page, two boxes, one seam. The LEFT box is a conversation that operates the
whole product; the RIGHT box is a stage that shows whatever the conversation is
about. Everything between them is standardized here so another site can adopt
the system whole and swap only its domain.

## The three layers (what is reusable vs what is yours)

**1. THE SHELL (reusable as-is)** — `pages/Chat.tsx` minus the card renderers.
- Layout: chat column LEFT; right column is ONE glass card, the STAGE, over the
  mascot corner. Mobile: the sheet goes standalone full-height with a stage
  strip and safe-area padding.
- The message loop: bounded log (200 messages), thinking bubble with a
  550-1000ms floor so the dots read, 45s turn timeout that answers in words and
  offers a "Try again" chip (resends the last real text), timestamps, entrance
  animations, chips as ONE horizontal pill rail (wheel scrolls it sideways).
- Session persistence (`specter-chat-v1` pattern): messages, ctx (chain, last
  basket, per-chain draft buckets, deployed-this-session), and the stage
  survive refresh; a restored session ACKNOWLEDGES what survived out loud; the
  New-chat button resets; a fresh session gets the cinematic entrance.
- The cinematic entrance overlay (intro → wave → twirl → exit-dissolve; click
  skips; reduced-motion skips) and page entrance staggers (the house
  `.enter` / `--enter-i` classes, `index.css`).
- The backdrop layer: `body::after` painted via `--chat-bg-url` +
  `--chat-bg-live` (a transformed route wrapper re-scopes in-tree fixed
  layers, so the page paints on body). Per-plane caps are CSS vars.
- Event buses (window events, no prop drilling): `specter:cheer` (confirmed
  small win → thumbs-up), `specter:traded` (a completed swap narrates BACK
  into the conversation with next-step chips).

**2. THE BRAIN (the seam — replace the domain, keep the machinery)** —
`agent.ts` exports `handle(text, ctx) → { actions, ctx, chips?, celebrate? }`.
Deterministic, no LLM (owner ruling; the signature is deliberately the future
LLM seam). The machinery worth keeping in ANY domain:
- The language layer: `normalize` (contractions, punctuation), `coreOf`
  (leading-filler strip for OPERATIONAL detectors only — the bank and money
  verbs read the full text so question-shaped commands stay questions),
  bounded-Levenshtein `hasWord` typo tolerance with a COMMON-word blocklist,
  `hasPhrase`, ordinals against the last rail, the interrogative guard.
- Conversational memory on ctx: `lastBasket` (anaphora: "buy $25 of it"),
  `lastTrade` ("make it $100"), `lastList` (ordinals), `lastIntent`
  (elliptical "and on robinhood?"), `lastOffer` (a spoken "yes" accepts the
  reply's first chip), per-chain draft buckets, `pending` slots.
- The endless catch-all: ORIENT family + orientation map card; any
  question-shaped message that survives every intent, the bank, and
  did-you-mean gets the map, never a shrug.
- The QA bank: declarative rows (regex → answer/hero/steps/compare + chips),
  evaluated AFTER every operational intent so a question can never shadow a
  trade. Two asks in one message answer both.
- Hardening: 400-char input bound, 60s movers cache, name clamps on every
  chain-sourced string (bidi/control strip, 64ch), unverified-candidate
  caution, cross-chain settling with exact-symbol-only candidates.

**2b. THE OPERATOR LLM SEAM (optional, off by default)** — an operator may
point `VITE_AGENT_ENDPOINT` at their own language brain without forfeiting
the money guarantees. The contract is structural, not policy: the endpoint
receives `{ v: 'specter-brain-1', text, chainId, draft, lastBasket }` (POST,
6s timeout) and may return ONLY `{ say?: string[], sendThrough?: string,
chips?: string[] }`. It can speak, suggest chips, and delegate ONE message
back through the deterministic machinery — there is no field in which an
action payload can travel, so a remote brain structurally cannot fabricate a
trade, create, redeem, or migrate; every money action still flows through
the same simulated, floor-protected paths as a typed message. Absent env,
HTTP error, timeout, or a malformed reply all mean the regex brain answers
exactly as it would have. The env is read per call, so node hosts (the
driver, tests) can flip it live while browser builds inline it.

**3. THE CARDS (domain renderers — swap for your product's)** — the
`ActionBlock` switch in `Chat.tsx` maps action kinds to REAL components (the
house rule: reuse the real thing, never a lookalike): trade cards, read
cards, create/deploy (`DeployCard.tsx`), bundles (`BundleCard.tsx`), exits
(`RedeemCard.tsx`), thesis/profile (`ThesisCard.tsx`, `ProfileCard.tsx`),
the visual create ask (`AssetPickerCard.tsx`), the cross-chain draft
(`CrossChainDraftCard.tsx`) and the one-button launch it finalizes into
(`CrossChainLaunchFlow.tsx` — deploy every chain, then the first deposit with
a bridge door when a chain is short, then the wrap, then the share options),
the fee claim (`ClaimCard.tsx` — one press claims every accrual on the chain),
an orchestrated multi-buy (`MultiBuyCard.tsx` — one press, then the real trade
card walks the order ONE leg at a time), a linked new version
(`VersionCard.tsx` — the predecessor's legs carried across, deployed, and the
successor link signed), positions, movers, candidates rails,
share/referral (`CopyRow.tsx`), hero / steps / compare showcase kinds.

**THE ONE-BUTTON LAW** (owner 2026-08-21) governs every card above: a reply
never puts two armed money primaries on screen at once, and a flow carries the
reader through to its end (deploy → fund → share) rather than stopping at the
transaction. An escape hatch is a text link, never a button beside the primary;
a capability you can ASK for is not the same as an option put in front of you.
The authoritative file list is `scripts/chat-kit/manifest.json`, guarded by
`chat-kit-manifest.test.ts` (every vendored import must be listed). Every action kind is plain JSON (no bigints)
so persistence and drivers stay trivial.

## The mascot rig (optional but it is the feel)

`ChatMascot.tsx` + `assets/mascot/` (18 animated WebP states, 416px, true
frame replacement — mux via node-webpmux with dispose+no-blend; ffmpeg alone
STACKS frames) + `sfx.ts` (8 mastered cues, -6dBFS, OFF by default behind a
click gesture; the header speaker button is the one control). Cue map:
thinking = answering base · typing while the user types · party = creations ·
confused = refusals/errors · thumbsup = confirmed wins (`specter:cheer`) ·
lightbulb = a live read landed (polite: yields while busy so data streaks do
not strobe) · sleeping after ~100s (any interaction wakes with a blink) ·
BOOP on click (squash + giggle) · idle showcase rotation. Reduced-motion
renders a still frame.

## The house rules (owner-ratified, apply to ANY adoption)

1. Buttons BELOW info, always. 2. Small text is one line, max. 3. NO em
dashes in chat prose. 4. Less text, more visual. 5. The primary flow never
leaves the chat (external pages are optional receipts). 6. Regex over LLM
until the owner says otherwise. 7. Every money action signs in the USER'S
wallet; the chat holds no keys and says so.

## The proof harness (adopt this too, or regressions are invisible)

`app/scripts/chat-drive/` — build-agent.mjs bundles the REAL agent node-side
(esbuild define map + prelude + nodePaths); drive.mjs runs the whole
conversation graph as turns with expectations (146 turns as of 2026-08-20; a
generic fallback or off-intent reply is a FINDING). `npm run chat:drive`
(live) / `chat:drive:fast` (offline, network severed deterministically,
~0.2s). Port the driver with the page: every live bug this system has had was
caught or reproduced by it same-day.

## Adoption seams (in order)

1. Vendor the file set (`app/scripts/chat-kit/resync.mjs` copies it; the
   manifest is the shopping list). Files stay read-only in the consumer —
   fixes flow through this source and re-sync (the napkyn resync contract).
2. Replace the brain's DOMAIN: your intents + QA bank rows + action kinds,
   keeping the machinery layers above.
3. Replace the cards with YOUR real components; keep ActionBlock's shape.
4. Re-skin: the shell reads theme tokens (`--color-*`, panel/ink families) —
   restyle by tokens, not by editing the shell.
5. Mascot optional: keep, re-art (the playback contract is per-state
   fps/loop/oneShot/pingpong/seam in the muxer), or drop (the shell runs
   without it).
6. Run the driver against YOUR brain before anything ships.
