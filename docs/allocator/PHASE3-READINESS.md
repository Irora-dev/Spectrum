# Phase-3 Readiness — the wiring spec

> status: derived (annex to PLAN.md Phase 3) · as-of: 2026-08-03 · owner: specallocator ·
> commitment: **committed — CONFIRMED by the owner in-session 2026-08-03 ~18:2x ("yes do all
> these"), after the desk ask stated exactly what a yes does and does not do (no money
> moves on it; 3.2 stays his own separate moment). This document is binding.**
> Source of every pinned fact: `PLAN.md` Phase 3 (the batcher integration contract, the
> bridging obligations, the routing policy) · `spectrum-contracts/docs/BATCH-PERIPHERY-DESIGN-2026-08-02.md`
> (governing) · `BATCHER-AUDIT-ROUND-1-2026-08-02.md` (evidence). Link, don't restate: where
> this document repeats a number it is for readability; the sources govern.

The one sentence: **the simulated engine gains real legs in gated slices, nothing signs
without an exact-byte simulation passing first, the first real run is the owner's, and the
SIMULATED flip is a gated event at the end — never a side effect.**

---

## 1. Scope of the flip — what goes live, in what order

| Slice | What becomes real | Stays simulated meanwhile |
|---|---|---|
| **A** | Keep-door **market batch on Base** (one `batchBuy`/`batchRebalance` per diff) | everything else |
| **B** | **Multi-chain**: funding via the LiFi seam + per-chain batches (ETH, then 4663) | publish, limit-cancel |
| **C** | **Publish real half**: basket deploy + `mintInKind` holdings-as-seed (gate: **G5**, SpectrumContracts' single-asset check) | — |
| **D** | **Limit rail live test** (already built; first order is the owner's live test; cancellation wiring joins here) | — |

**The flip discipline.** `SIMULATED` stays `true` through slices landing dark. When slice A
proves out, the constant gives way to **capability-grained truth** (`executionLive(door,
channel, chainId)` — the `channelExecutable` pattern generalized), so market-on-Base can be
real while publish honestly renders its true not-yet state. The launch-interlock test
extends to the new grain **before** any capability flips: a build that claims live
execution it does not have must fail CI, per the existing doctrine.

---

## 2. The two BLOCKING findings, resolved on paper

**B1 — "Net-out means net of GAS."**
`LifiQuote` gains `gasCostUsd` (surfaced from LiFi's `estimate.gasCosts`, summed, priced in
USD as LiFi reports it); the direct route prices its own gas the same way: `gas.ts` estimate
× the chain's native price **from the same read the page already prices with** (one price
source, no second oracle). The comparator becomes `netOutUsd − gasCostUsd` on BOTH arms,
computed in one pure function (`routing.ts`, unit-tested with the inversion case the PM
named: a small leg where gross favors the aggregator and net favors direct). Tie or
unreadable gas on either arm → **direct wins uncontested** (the permanently-warm fallback,
policy caveat (a)). *Seam note: `lifi.ts` is UIGuy's seam (@ `ce5c3f0`) — the interface
change (one added field) goes to his desk as a spec; my side consumes it and carries the
comparator.*

**B2 — "Their floor is a claim, ours is a check."**
LiFi's `toAmountMin` is never trusted as protection. At the mandatory pre-sign
`eth_call` simulation, read the **recipient balance delta** out of the simulated state and
require `delta ≥ ourFloor`, where `ourFloor = ourQuotedOut × (1 − slippageBps)` derives
from OUR quote basis (the same derivation the basket path uses — swap-quote's own law).
Below the floor: **refuse to sign, say why** ("the route delivers less than the floor we
showed you"), re-quote once, then leave the user in control. The number on screen
("you receive at least X") is OUR floor — the displayed-vs-signed ref gate (built for the
limit ticket) arms on this path too, so the shown floor and the signed floor come from
different moments and must agree.

The four non-blocking seam findings (3–6) bind the build as written in PLAN §5: baskets
excluded from the race by construction · integrator fee inside the compared quote, XOR
with the batcher fee · bounded concurrency + hard timeout, direct wins on silence ·
**approve only the winner, exact-amount, after the execution re-quote**.

---

## 3. Consuming the batcher — render-only duties

The executor **simulates `batchBuy`/`batchRebalance` to populate the review exactly**
(`BatchResult` is the review's data, never a re-derivation), and renders the seven
contract-enforced rules rather than fighting them:

1. Per-leg `minOut` + `hubMinOut` always non-zero where funding ≠ leg denomination — floors
   derive from our quote basis (B2's law), never zero, never LiFi's claim.
2. Funding = native ETH or the chain's settlement asset only — the Pay-with surface already
   constrains to this; the composer enforces it.
3. `recipient` explicit — always the user's own wallet address, stated on the review
   ("everything lands in your own wallet" stays literally true).
4. **`optional` is the consent surface**: the review marks thin legs optional (the existing
   thin-legs machinery decides *which*), shows the required-by-default posture, and the
   run panel renders a skipped leg as SKIPPED with its wei-exact refund — never as success.
5. Refunds may return in a different denomination than funding — shown as their own line,
   never silently netted into a total.
6. A BASKET leg ≈ 6 plain legs toward the 32 cap — the composer's leg budget accounts for
   it and the review says when a plan had to split.
7. `feeBps = 50` in calldata (bytecode cap 200), burns PRISM — the fee row's ⓘ already says
   this; the calldata value comes from `BATCH_FEE_BPS`, one constant, never retyped.

Planner facts honored: 12 plain legs ≈ 726k gas; one tx per chain per diff;
`batchRebalance` settles sells from the payer and funds buys from proceeds.

---

## 4. Bridging obligations (multi-chain slice B)

- **Wallet network dance**: `wallet_switchEthereumChain` before any destination-chain
  signature, with `wallet_addEthereumChain` FIRST for 4663 (most wallets don't know it) —
  an explicit step in the run panel, never a silent cast (the limit ticket's precedent).
- **Refuel**: pass `fromAmountForGas` through the seam, sized by SpectrumContracts' pending
  rule — **never hardcoded**. With refuel set, `toAmount` is token delivery alone: quote
  races compare like with like (refuel-carrying vs bare are different products).
- **4663-inbound refuel**: expected absent; contracts owe the verdict. If confirmed absent,
  4663-inbound needs its own mechanism before slice B includes it — a named gate, not a
  hope. (LI.FI routes INTO 4663 today — probed, Relay ~2s — so bridge-then-batch works.)
- **Funding denomination on 4663**: the old USDG constraint is **RETRACTED** (2026-08-02
  ~13:16, contracts' correction: their harness hardcoded a dust budget; the canonical hub
  carries deep liquidity both ways). No constraint; nothing to build.

---

## 5. The signature inventory — what gets signed, by whom, in what sequence

Every signature: (1) composed from recorded exact ends, (2) `eth_call`-simulated with the
EXACT bytes to be signed, (3) displayed-vs-signed gate armed (shown number captured
post-paint, compared at click), (4) one wallet confirm per signature, labeled with what it
does. **Signer is always the user** (the owner in 3.2); nothing signs autonomously, ever.

**Slice A — keep-door market batch (one chain):**
1. *(only when funding is ERC-20)* `approve(fundingAsset → SpectrumBatcher, exactAmount)` —
   post-re-quote amount, per seam rule 6; skipped entirely for native-ETH funding.
2. `batchBuy(legs, fundingAsset, fundingTotal, params)` — payable; simulated `BatchResult`
   IS the review the user just confirmed.

**Slice A — rebalance:** per sell asset `approve(asset → batcher, exactSellAmount)` (from
`funding.changes.sellRaw` — recorded raw amounts, never dollars divided by a price), then
`batchRebalance(sells, buys, …)`. One tx per chain per diff after approvals.

**Slice B — multi-chain, per destination chain in plan order:** LiFi bridge tx (funding +
refuel; tracked via `bridge-pending.ts` until arrival) → wallet switch/add-chain → the
chain's approvals + batch as slice A. The run panel's per-network grouping already renders
this sequence; the states gain real tx hashes and confirmations instead of timers.

**Slice C — publish:** per network: basket deploy (factory, existing path) → approvals of
the held tokens being seeded → `mintInKind` for the seeded portion. The kept remainder
stays untouched (no signature — it never moves).

**Slice D — limit:** as built (approve to vault relayer → signed order posting); adds
cancellation (one tx). First order remains the owner's live test by standing rule.

---

## 5b. The execution capability ladder (the owner, ~21:3x: "a system that tries all
these levers but can fall back")

Every signature-need resolves DOWN a ladder, per chain, per step — the user gets the
best their wallet supports, and the run panel states the REAL confirm count once
capabilities are known (never "one transaction" on a wallet that will see three).

**The rungs, in order:**
1. **Batched wallet calls (EIP-5792 `wallet_sendCalls`)** — approvals + batch as ONE
   atomic confirm. Detect via `wallet_getCapabilities` per chain (wagmi exposes both);
   absent/unknown → rung 2.
2. **Permit2 batch signature** — one signature covers all sell-side transfers
   (CONTRACTS-GATED: activates only if the batcher lands with `permitTransferFrom`
   support AND Permit2 exists on the chain). **ANSWERED from deployed source
   (SpectrumContracts, 2026-08-04): Permit2 is NOT wired anywhere in the periphery
   today** — lib/permit2 is vendored, unused; the batcher pulls sells with plain
   `safeTransferFrom`. So this rung STAYS DARK until the periphery carries it; the
   per-sold-token exact approval floor is real and rungs 1/3/4 are the live ladder.
   They want it next behind the ceremony (4,180 B of EIP-170 headroom measured on
   the batcher runtime, 20,396 B used); sooner needs the owner's ordering word.
   Tokens missing the one-time Permit2 approval fold that approve into rung 1's
   bundle or the sequence.
3. **EIP-2612 permit** for the FUNDING approval — signature instead of a tx, from a
   KNOWN-GOOD list only (2612 in the wild is inconsistent; DAI-style variants and
   broken implementations mean probing is not trusting). USDC on Base/ETH qualifies.
4. **Plain sequence** — exact-amount approve txs + the batch, exactly as §5 inventories.
   Always works; always the honest floor.

**Zero-rung**: native-ETH funding needs no approval at all — the ladder starts one rung
down by construction when payWith resolves to native.

**THE ONE SAFETY LAW OF FALLING BACK — never fall back after an ambiguous submit.**
A rung may only degrade to the next on DEFINITIVE non-support: method-not-found, an
explicit capability "no", or a rejection that provably preceded submission. If
`sendCalls` (or any rung) returns an id and then goes silent, the runner RESOLVES that
status (`callsStatus` polling) before anything else may run — a fallback fired after an
ambiguous submission is a DOUBLE-BUY, and no retry convenience is worth one. This rule
is pinned in tests before any rung ships.

**Step-model consequence:** the plan always carries the FULL sequential step list
(honest worst case); the runner COLLAPSES what a capability lets it bundle at execution
time, and the panel renders a bundle as one confirm. Fallback therefore never needs a
recompile — the sequential steps were always there.

---

## 6. The proving protocol — what "proven" means before 3.2

Per the standing rule, **no real funds in proving rounds**: proving is simulation-complete
against the REAL chains, plus rehearsed failure honesty. A slice is proven when all of:

1. **The byte matrix is green**: exact-bytes `eth_call` simulations pass on the real chain
   for every leg shape the composer can emit (plain leg · basket leg · optional leg ·
   ETH-funded · settlement-funded · rebalance with sells), against the DEPLOYED batcher —
   **and the deployed ABI is verified byte-level against `batcher.ts`'s encoding first**.
   The paper-ABI risk already bit once before any ceremony (contracts, 2026-08-04,
   twice — the later note wins): the robinhood lineage briefly diverged (five-field
   params, no integrator), then the fee split was ported the same morning, so **all
   three chains share ONE six-field ABI** (batchBuy `0xc3b25c36` · batchRebalance
   `0xce932a32` · claimIntegratorFees `0x242d665b`). What survives: `batcher.ts`'s
   explicit chain set (unmapped refuses) and the SELECTOR PINS (test-computed vs
   forge-inspected — the tripwire that caught the divergence); the ceremony's
   built-artifact handover re-verifies. Caveat: the robinhood PORT owes its own
   adversarial pass + mutation run before 4663's ceremony; Base-first unaffected.
   1c. **A REAL non-zero-integrator batch runs in fork proving** (contracts' fee-split
   lesson, 2026-08-04: the split's arithmetic had 100% test coverage and the PATH had
   0% — every integration test passed integrator=address(0), so a revert-on-any-
   integrator bug lived through a green suite; encode-only tests here have the same
   blind spot by construction). One matrix row drives batchBuy AND batchRebalance
   with a real integrator address and asserts accrual + claim.
   1a. **The 32-cap is confirmed in the contract's own units** before the byte matrix
   runs: the composer's cap has ZERO margin (32 plain legs and 5-basket plans both
   compose at exactly the cap), so an off-by-units cap on the deployed side would only
   surface as a revert — check it against the artifact first (battle-test half-1 note).
   And **"it must split" is a RUNNER DUTY with no owner yet**: neither batcher.ts nor
   plan-legs splits an over-cap plan; the runner must, or must refuse whole (row pinned
   here so it cannot silently fall to nobody).
1b. **The ASSET-CLASS coverage matrix is green** (added after the money-paths audit,
   the owner's "are we sure batching works for all assets"): per chain × per class —
   V4-pool crypto · V3 · V2 · low-cap/thin (optional-leg path) · BASKET leg (incl. a
   basket whose own legs include stocks, on 4663) · **STOCK legs — RULED (B) for the
   ceremony (SpectrumContracts, 2026-08-04, from deployed source): stocks execute
   OUTSIDE the batch on 4663 as separate stocks-fork router txs, and the review
   states the extra tx count honestly.** The enum read is confirmed: LegVenue =
   {0=V4, 1=V3, 2=V2, 3=BASKET}, no V4Q — the composition law's refusal of V4Q-cast
   legs stands (pools' V4Q=3 vs BASKET=3 would route money into a basket
   acquisition). A V4Q leg also never touches the batcher's hub (bound at
   construction to {native ETH, settlement}; NotEthSettlementPair/SettlementMismatch)
   — so venue 4 = its own funding branch + floor semantics, a periphery change with
   4,180 B of headroom. **(A) V4Q-in-batch is buildable AFTER the ceremony on
   the owner's sequencing word** — the trigger is slice B nearing with mixed RH
   portfolios wanting one-tx-per-chain; until then stocks-outside-the-batch is the
   composed shape · hooked-pool-only assets REFUSE BY NAME (**confirmed enforced
   contract-side too**: `_validate` rejects hooks ≠ 0 as BadV4Key, L890-895) ·
   Aerodrome-only assets REFUSE BY NAME (**confirmed by design: no such venue in
   the enum**; keep the "choose a token with a Uniswap pool" wording).
   "Works for all assets" is this checklist passing, not a hope.
1d. **THE FUNDING EQUATION is measured, not read** (seam round, 2026-08-04; basis
   ANSWERED off source by contracts the same day, desk note 16:02). The relationship
   `sum(legBudgets) = fundingTotal − fee(fundingTotal)` had no fee term at all until
   this round, which end-to-end forced the batch to pull only the net and let the
   contract's 50 bps come out of the legs — every floor ~0.5% above what its leg could
   buy (F9's prediction, reached from the other direction). **The basis question had a
   three-part answer, not a binary** (SpectrumBatcher.sol, line-cited in the note):
   `batchBuy` = INCLUSIVE on the pull (L352-353 — our equation, which began as the
   fail-safe reading and turned out to be the contract's own arithmetic) ·
   `batchRebalance` fully funded = ADDITIVE on `venueBuyBudget` only (L524-525; basket-
   venue buys untaxed, **sells never taxed** — an earnings line multiplying exit volume
   by feeBps is wrong by model) · under-funded rebalance = fee RE-DERIVED from actual
   spendable (L561-565), the NORMAL path whenever sells come in light, so regime 2's
   prediction is a CEILING, never the exact charge. All three live in `batcher.ts`
   (`feeCentsOfTotal`/`fundingTotalForLegCents` · `rebalanceFeeRawOnBudget`/
   `rebalanceEthNeedRaw` · `rebalanceFeeRawFromActual`), pinned including the exact
   integer inverse property at the fully-funded boundary and the mixing-is-directional
   inequality. **The fork `batchBuy` measurement (known fundingTotal → resulting
   `feeEth`) still runs as the closing tripwire** — now a confirmation of a line-cited
   answer rather than a question; contracts offered to pin all three bases as tests on
   their side (accepted — a basis change should break a test there, not this encoder
   in a rehearsal).
   1e. **The byte matrix compares RAW values, never dollar ones.** The fee is computed
   in two domains — cents are the plan's denominator (the only unit comparable across
   chains and assets), the contract computes in raw — and `floor(700c × 50bps) = 3c`
   where the chain gives `3.5c`. Any figure exchanged in dollars carries that half-cent
   gap against the chain's own view, so the matrix asserts on raw.

   **⚠ REHEARSAL RECORD, 2026-08-04 (the 4663 anvil fork contracts stood up — real
   deployed batcher, real seeded baskets; NOTHING here is a live record; every row
   re-runs against the real ceremony). Suite: `app/src/rehearsal-4663.live.test.ts`
   (`npm run rehearse:4663`; the discipline gate refuses any client that is not
   anvil/*). Six for six green; what it measured:**
   · **1d CONFIRMED off deployed bytecode:** a 0.01-native pull's `feeEth` came back
     exactly `pull × 50bps / 10000` (5e13 wei) — regime 1 measured, not read.
   · **The byte-matrix row EXECUTED:** my composer's exact bytes landed
     (sharesDelta 17.9756e18 ≥ the floor 17.8857e18 I composed) — encoder and
     deployed struct agree.
   · **1c EXECUTED with a REAL integrator:** the claim paid **exactly 20% of feeEth**
     (`INTEGRATOR_SHARE_BPS = 2000`). **Semantic captured the hard way:** the accrual
     is keyed by the INTEGRATOR — `claimIntegratorFees` reads
     `integratorAccrual[msg.sender]` and its argument is only the payout — so the
     integrator in BatchParams is a CLAIM IDENTITY Spectrum must control, never a
     passive payout address.
   · **`RequiredLegFailed(uint256)` MEASURED** (selector `0x835da7f4`): the
     client-side decode in `runner-effects.ts` recovers the failing leg index off the
     deployed contract's own revert.
   · **THE HUB FLOOR'S DENOMINATION MEASURED** (and it corrected a live bug in
     `assemble-batch.ts` before any ceremony): `hubOut` for a native-funded batch is
     SETTLEMENT raw (19,081,541 for 0.01 native ⇒ USDG 6dp) — the assembly's first
     identity-basis floor was ~1e12× too high and would have reverted HubFloorNotMet
     on every native+basket batch. Source-confirmed semantics now encoded: native
     funding hub-swaps ONLY basket budgets (no basket legs ⇒ floor never read);
     settlement funding hub-swaps venue budgets + THE FEE, out in native.
   · **Slippage evidence for the default proposal:** the basket mint path showed
     0–1 bps size impact from 0.003→0.2 native (~$6→$400) on a real seeded basket —
     at 3.2 sizes the binding risk is quote-to-execution NAV drift, not size impact.
   · **A clock lesson that is P5 observed from the other side:** the fork head's
     timestamp sat ~5h from the host clock and every SEND died `DeadlinePassed()`
     while every eth_call passed — a deadline anchored to the wrong clock is dead on
     arrival; the rehearsal pins the next block's timestamp (a fork privilege), the
     runner re-checks against `getBlock` at simulate time (law P5).
2. **The floor check bites in anger**: a deliberately-poisoned quote (floor above the
   simulated delta) is REFUSED with the honest message — rehearsed, not assumed.
3. **Failure paths render honestly**: optional-leg skip shows SKIPPED + refund; a revert
   surfaces the reason and leaves state resumable; deadline expiry re-quotes; a dropped
   wallet connection mid-run resumes from the persisted plan with real pending-tx state.
   **Known contract limit (contracts, 2026-08-04): a required leg's failure DISCARDS its
   inner reason** — `RequiredLegFailed(index)` is all that surfaces, so the runner and
   the exec-log's partial entries record the leg INDEX and say the reason is
   unavailable; review copy never claims a cause it cannot know ("tolerance too tight"
   vs "no liquidity" need opposite UX and we cannot distinguish them until the
   bubble-the-reason periphery fix lands — contracts offered it, the owner's sequencing
   word pending).
4. **Displayed-vs-signed gates verified armed** on every signature in §5 (the guard that
   compares values from two different moments — the -51 lesson class).
5. **The states that only exist live are ENUMERATED as first-run watchpoints** (inclusion
   in a block, reorg on confirmation count, gas spikes between simulate and sign) — walked
   deliberately in 3.2 with the owner's checklist in hand, small money, one confirm at a time.

---

## 6b. Shadow mode + the canary protocol (battle-test items 7+8, the owner "do all")

**SHADOW MODE — its own phase between "runner built" and 3.2.** The real pipeline
(quote → compose → simulate → would-have-signed) runs SILENTLY beside the simulated
engine for every user action on :5313/:5311, logging divergences and would-have-refused
events (device-local, the exec-log idiom). Weeks of real-data battle-testing at zero
risk; the divergence log IS the evidence base for the 3.2 go. Exit criterion: N
consecutive days with zero unexplained divergences (N = the owner's call at review).

**THE CANARY PROTOCOL — 3.2 as experiments, not vibes.** the owner drives; each run has a
pre-written script: expected outcome · watchpoint checklist (inclusion, confirmation
depth, floors honored, refunds denominated, allowances consumed-to-zero) · abort rule
(any deviation stops the session). Sequence: $10 single-leg → $50 multi-leg →
small same-chain rebalance → bridge-carrying run. Scripts live beside this doc when
the runner lands.

## 7. Order of work, and whose gate each step waits on

1. **This spec confirmed** — the owner (the gate for everything below).
2. **B1 seam spec to UIGuy's desk** (`LifiQuote.gasCostUsd`) — his seam, my consumer.
3. **Slice A built dark** behind the constant (composer → batcher calldata, simulation,
   floors, review population) — me; provable up to §6.1–.4 against a fork until:
4. **Batcher deployed on Base** — SpectrumContracts build + **the owner's ceremony** (addresses
   seat then; `deploymentFor` carries them).
5. **Proving matrix run on Base** — me; results filed to the thread.
6. **3.2 first real run** — **the owner drives, his signatures, small money, watchpoints in
   hand.** Market-on-Base flips to live behind capability-grained truth + extended interlock.
7. **Slice B** (multi-chain; 4663-inbound refuel verdict is a named sub-gate) → prove → his
   run. **Slice C** on G5. **Slice D** cancellation + his first order.
8. **3.3** periphery evolution stays parked until the owner reopens contract work (per PLAN).

**Out of scope here**: the lineage rev (own thread) · bundles/G4 · alerts (PrismBeat's
lane) · prepared plans (parked by the non-db ruling).
