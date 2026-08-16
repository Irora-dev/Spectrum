# The portfolio flow — Phase 1 spec (station by station)

> status: derived · as-of: 2026-08-01 · owner: specallocator · PM: UIGuy ·
> commitment: **exploratory until the owner confirms** (then dated in PLAN.md §8)
> source: the owner, 2026-08-01 in-session — *"as braindead and easy to use as possible, no
> chain specifics, it shows the value in your wallet, an empty portfolio / create your
> onchain portfolio → choose the assets → weighting → confirm or go back → it computes the
> logic behind the scenes and starts the buying execution. Nail the frontend flow first
> before we do any contract work."*

## The two laws of this flow

1. **Braindead.** The user makes exactly three kinds of decision — which assets, what
   weights, how much — and nothing else. Chains, venues, routing, bridging, sequencing are
   computed behind the scenes. **No chain pills, no chain pickers, no addresses required
   anywhere in the flow.**
2. **Honest.** Behind-the-scenes ≠ hidden truths: costs are stated before confirm,
   networks appear as fine print (never as decisions), every on-chain step is the user's
   own signature ("you approve every step; assets land in your wallet — nothing is pooled
   or held for you"), and a read that FAILED never renders as a zero, a "not held", or a
   failed step.

## Station 0 — Portfolio home

**Empty state (no allocation yet):**
- **The value in your wallet** — ONE number, summed across all supported networks behind
  the scenes. While any network is still answering: a quiet "reading your wallet…" shimmer
  on that portion — never a partial total presented as final, never $0 from an error. If a
  network stays unreachable: "part of your balance can't be read right now — retry", no
  chain jargon.
- An empty-portfolio object (the visual seat the portfolio will occupy — not a lecture).
- One primary CTA: **"Create your onchain portfolio"**.

**Filled state (allocation exists):** the portfolio view — target vs actual, one value,
one PnL (Phase 2 completes this; Phase 1 ships a v0: the allocation + its live value).

⚙ CONFIRM (default stands unless redlined): mounts as the **top state of `/portfolio`**.
The page's existing holdings/claims content stays (it is real information) below the
portfolio object; full merge of the two stories is Phase 2 work.

## Station 1 — Choose assets

- One search box + curated suggestions (the starter-suggestion machinery, merged across
  networks). Type "AAVE" → the asset, not a chain question. Multi-select; chosen assets
  collect in a tray that persists through the flow.
- Behind the scenes each pick resolves through the launch page's own `resolveAsset`
  (venue + routable depth — never a second implementation). **A symbol that trades in
  several places auto-resolves to the deepest routable market. The user never chooses.**
- Power users may paste a contract address (works, never required). Behind the scenes it
  is checked on every network; ambiguity resolves by depth.
- Refusals are honest and friendly: "no routable market found for this" (with the
  failed-read distinction: "couldn't check right now — try again" when the read errored).
- **v0 accepts raw assets only.** A basket token pasted here is refused kindly and pointed
  at baskets/bundles (the F7-echo guard). ⚙ CONFIRM default.
- CTA: **"Next — weight your assets (N)"**. Back = close, tray kept (draft persists
  locally; refresh-safe).

## Station 2 — Weight the assets

- Every asset starts **even-split**. Per-asset weight steppers/slider; weights always
  display normalized to 100% (the forge's `normalizedLegs` doctrine).
- ⚙ CONFIRM (default stands): **the amount lives here** — "Investing: $___" at the top,
  wallet value shown as context with quick chips (25% · 50% · Max). With an amount set,
  each asset shows its live $ slice, which is what makes weights feel real.
- "Even it out" one-tap reset. Remove an asset here too (tray edit without going back).
- CTAs: **Back** (to station 1, everything kept) · **Next — review**.

## Station 3 — Confirm

- The allocation, plainly: asset · weight · $ amount rows; total invested; estimated costs
  stated as estimates (routing fees/impact when computable — in Phase 1's simulated mode,
  clearly labeled estimates).
- The fine print (honesty, not decisions): "Your buys settle across the networks where
  these assets trade — routing is handled for you. Your wallet will ask you to approve
  each step. Assets land in your own wallet; nothing is pooled or held for you."
- CTAs: **Back** (to weights) · **Confirm & start**.

## Station 4 — Compute, then execute

**Sub-state A — computing (behind the scenes, visible as one calm moment):** resolve final
routes per asset · group buys by network · insert any funding/bridge steps the plan needs ·
simulate every transaction's exact bytes. Copy: "Preparing your buys…" with an optional
"what's happening" expander for the curious. If preparation finds a problem (thin route,
insufficient balance for a slice): stop BEFORE anything executes, say it plainly, offer
Back-to-weights.

**Sub-state B — executing:** one progress surface, one row per step:
`queued → approve in wallet → confirming → done`, with per-step retry on failure.
- **Persisted and resumable** — refresh/disconnect mid-run resumes where it left off
  (`bridge-pending.ts` doctrine).
- A step failure never wipes the plan; a failed READ never marks a step failed.
- Cancel is allowed between steps: completed buys are yours (they are in your wallet);
  the remainder is abandoned cleanly and said so.

**Done →** Station 0 flips to the filled state: your portfolio, live.

**Phase-1 scope law:** the whole engine runs **simulated end-to-end** (dev-fixture/demo
machinery) — every screen, state, failure and resume path real; **no funds, no contracts,
no real execution**. Real wiring is its own later phase, and its first real run is
the owner-driven.

## Copy principles (bind every station)

- Network names never appear as questions or options; only as fine-print facts.
- Never "we buy / we manage / we hold" — "your wallet approves; assets land in your
  wallet".
- Fees are fees, never earnings; estimates say "estimated".
- "Not one token" stays true everywhere the portfolio is described.

## The knobs awaiting the owner (defaults stand unless redlined)

1. **Amount placement** — on the weights station (recommended, above) vs its own station.
2. **Mount** — ~~top state of `/portfolio`~~ **SUPERSEDED by recording 2026-08-01 17:14:
   the flow lives on its own page, `/manager` (naming provisional), with a marketing
   landing ahead of station 0: hero title → marketing line + asset-panel visual (bento,
   owner's live note) → "Create your portfolio" → wallet-connect prompt → assets → picker.
   `/portfolio` carries nothing of this.**
3. **v0 asset universe** — raw assets only, basket tokens refused kindly (recommended).
