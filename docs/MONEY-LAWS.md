# The money laws

The single-source registry of the laws that govern every number this kit signs,
charges, floors, burns, or shows. Each law exists because a violation was measured —
live, on a fork, or by an adversarial test — never because it sounded prudent.
Written 2026-08-18 (hardening wave A); keep it current as laws are added or retired.

How to read an entry: the **statement** is the law in one sentence; the **seam** is
the ONE place in the code that enforces it (line numbers are as of 2026-08-18 — if
they drift, grep the named symbol; the symbol is the citation, the number is a
courtesy); the **pins** are the tests that prove the seam bites; the **violation**
is what you would see at runtime if the law broke.

All paths are under `app/src/lib/spectrum/` unless stated otherwise.

| # | Law | The enforcing seam |
|---|-----|--------------------|
| 1 | Exact-not-floor (sell payloads) | `universal-router.ts:334-337` |
| 2 | Generation-aware burn share | `portfolio-batcher.ts:969` |
| 3 | Under-the-cut (burn-route sizing) | `portfolio-batcher.ts:962-970` |
| 4 | The floor law | `direct-swap-lane.ts:528-529` · dial override `portfolio-batcher.ts:740-744` |
| 5 | Displayed-vs-signed | `displayed-vs-signed.ts:221` / `:536` |
| 6 | Native value = sell + fee, exactly | `direct-swap-wrapper.ts:167` |
| 7 | Divert-disclosure | `portfolio-batcher.ts:1013-1017` |
| 8 | Refusal-naming | `every-refusal-is-asserted.test.ts:137` |
| 9 | Read-failed | `zeroex-quote.ts:154` · `floor-discipline.ts:261` |
| 10 | Measured-fee (receipts outrank declarations) | `batch-fee-verification.ts:73` / `:155` |
| 11 | The receipt is read | `post-trade-reconciliation.ts:233` |
| 12 | The cross-check that never becomes a source | `calldata-lint.ts:260` / `:398` |

## 1 · The exact-not-floor sell law

**Statement.** In a Universal Router sell-to-WETH payload, the `WRAP_ETH` amount is
the `CONTRACT_BALANCE` sentinel — the router's exact whole balance — never the
minimum-out floor; the slippage floor rides only in the swap params, where the pool
fill itself enforces it.

**Seam.** `universal-router.ts:334-337` — `wrapInput` inside `encodeUrV4SellToWeth`
encodes `[UR_MSG_SENDER, UR_CONTRACT_BALANCE]`. The block comment above it
(`:290-297`) is the law's own text.

**Pins.** `universal-router.test.ts:190` — "THE WORD THAT MUST NEVER REGRESS:
WRAP_ETH carries MSG_SENDER + the CONTRACT_BALANCE sentinel — never a floor" —
asserts the sentinel by name in the decoded bytes. The contracts repo's fork suite
(`DirectSwapWrapperSellFork.t.sol`, test 2) made the theft executable, which is why
the first sell shape was scrapped (2026-08-16).

**Violation at runtime.** Passing `minOut` at the wrap step strands
`realOutput − minOut` as native ETH on the router, where any stranger's SWEEP
command takes it — a donation of the entire slippage allowance on every sell, with
the transaction itself succeeding.

## 2 · The generation-aware burn-share law

**Statement.** The burn route's share of the batch fee follows the deployed contract
generation — generation 1 burns 7/8 of the fee (the 7:1 remainder-exact split),
a 100%-burn generation (2 and 3) burns all of it — and every route must be sized at
the generation's own share.

**Seam.** `portfolio-batcher.ts:969` —
`const burnShare = input.generation === 2 ? [1n, 1n] : [7n, 8n]`. The
receipt-side mirror is `post-trade-reconciliation.ts:221-224` (`expectedBurnCut`,
over the closed `FeeGeneration = 1 | 2 | 3` union at `:130`).

**Pins.** `portfolio-run-wiring.test.ts` (the burn suite — the route sized at the
generation's whole cut); `calldata-lint.test.ts:239` ("law 4 · burn-route-present —
on the 100%-burn generation an empty route diverts the WHOLE fee");
`post-trade-reconciliation.test.ts:136` ("generations 2 and 3 burn the whole fee").

**Violation at runtime.** Measured 2026-08-18 on Base: routes sized at 7/8 on a
100%-burn chain diverted an eighth of every fee to the fallback sink by arithmetic —
even when the quote succeeded — because the route could never cover the cut the
contract measured.

## 3 · The under-the-cut law

**Statement.** The burn route is sized at or under the cut the contract will
actually measure — the guaranteed floor of the spend (non-optional legs only, since
every optional leg may skip) with a 0.5% haircut for quote drift — because a route
quoted for more than the measured cut reverts the whole batch; under-sizing is the
only safe direction, and the remainder diverts as dust by design.

**Seam.** `portfolio-batcher.ts:962-970` — `requiredCommitted` sums only
non-optional legs; `burnEstRaw` applies the generation share and the ×995/1000
haircut.

**Pins.** `portfolio-run-wiring.test.ts:561` ("mainnet composes with a quoted burn
route, sized UNDER the required-leg fee cut"); `portfolio-batcher.test.ts:612`
(a zero burn estimate fetches no quote at all); `portfolio-batcher.test.ts:707`
(the burn route deliberately asks no tolerance — it has no floor of ours to
protect; the contract's own burn floor holds on-chain).

**Violation at runtime.** A route quoted over the measured cut reverts the entire
batch on-chain — the exact failure of the live transaction that produced this law
(2026-08-15).

## 4 · The floor law

**Statement.** The signed floor is the **stronger** of the probe's haircut and the
plan's own floor — `max(probedOut × (1 − slippage), planFloor)` — never lowered;
the tolerance behind it is capped per leg, a cap breach is a refusal rather than a
clamp, and a user's protection-dial override replaces the ceiling at exactly one
seam.

**Seam.** `direct-swap-lane.ts:528-529` — the haircut, raised to `minFloorRaw`
where one is supplied; a probe that cannot clear the plan's floor refuses. The
dial override binds at `portfolio-batcher.ts:740-744` ("an override replaces the
ceiling at THE one seam"), with the ceilings themselves at `floor-discipline.ts:49`
(`S_MAX_BPS`) and `:136` (`S_MAX_THIN_BPS`, measured-thin legs only) and the
refuse-don't-clamp derivation at `floor-discipline.ts:261` (`deriveLegFloors` —
a refused leg is removed, never floored at something arbitrary).

**Pins.** `direct-swap-lane.test.ts:207` ("the PLAN'S floor RAISES the signed
floor — never the double-haircut that lost the race"); `floor-discipline.test.ts`
(the tolerance stack and its caps); `portfolio-batcher.test.ts:837` (an unreadable
depth still refuses even under a consented override — law 9 outranks the dial).

**Violation at runtime.** Two shapes. Lowering: a floor looser than the plan
consented to signs away protection. Doubling: the lane's own haircut stacked on
the plan's — measured live 2026-08-18, the fee lane's bid sat a hair under the
plan's floor on every default-slippage sale and the lane lost every race it was
built for.

## 5 · The displayed-vs-signed law

**Statement.** The review's number and the signature's number must be the same
number: the gate decodes the exact bytes the wallet would sign, diffs every
money-bearing field against what the review showed, then re-encodes the whole
composition and demands the bytes equal it exactly — a mismatch refuses in review
words before any signature exists.

**Seam.** `displayed-vs-signed.ts:221` (`diffDisplayedVsSigned`) and `:536`
(`diffDisplayedVsSignedPortfolio`), each ending in the re-encode catch-all. The
swap card's half of the same law is `shown-floor.ts` — the floor as painted is
captured where it renders, never recomputed at click (a recomputed comparison is
`f(x) === f(x)` and can never fire).

**Pins.** `displayed-vs-signed.test.ts` — a redirected recipient, a swapped
funding asset, an inflated pull by one raw unit, a swapped leg asset, each refused
by name; `shown-floor.test.ts` and `shown-floor.guard.test.ts` for the card.

**Violation at runtime.** A signature over different money than the screen showed.
The measured near-miss (2026-08-07): the gate's first cut checked a strict subset
of the calldata's money fields while claiming full coverage — six adversarial
mutations (a gutted hub floor, a 30→900 fee with a repointed sink, a year-5138
deadline, a swapped route with arbitrary hook code) all passed until the re-encode
catch-all closed the class without enumerating it.

## 6 · The native-value exactness law

**Statement.** A native-input wrapper call sends `sellAmount + fee` as its value,
byte-exact against the contract's own floor-division fee arithmetic; an ERC-20
input sends zero value — the fee travels in the sell token.

**Seam.** `direct-swap-wrapper.ts:167` —
`value: native ? args.sellAmount + fee : 0n`, with `fee` from `wrapperFeeRaw`
(`:89-91`, the contract's exact arithmetic, exclusive of `sellAmount`).

**Pins.** `direct-swap-wrapper.test.ts:78` ("native input sends sellAmount + fee
EXACTLY, and the args round-trip") and `:96` ("ERC-20 input carries ZERO value");
`:62` pins the fee floor against solidity integer division.

**Violation at runtime.** The contract's exact-value check reverts any other
value — an off-by-anything native send is a refused transaction, and a value
computed from a different fee formula than the contract's is a permanent revert
wearing a working UI.

## 7 · The divert-disclosure law

**Statement.** A fee that cannot burn parks at the fallback sink and is said out
loud — a failed burn quote never blocks the batch (the burn is fail-closed
on-chain) and never passes silently.

**Seam.** `portfolio-batcher.ts:1013-1017` — the failed quote pushes a named
refusal: "the burn route could not be quoted, so this run's burn cut will divert
to the fallback sink instead of burning — nothing else is affected." One quiet
retry precedes it (`:972-980`), because a single transient blip should not park a
whole run's fee.

**Pins.** `portfolio-run-wiring.test.ts:611` ("a failed burn quote never blocks
the batch — it composes with the divert said out loud") asserting the sentence
reaches the review; the refusal ratchet (law 8) acknowledges the sentence in its
pinned count.

**Violation at runtime.** A silent divert: the batch lands, the fee parks at the
sink, and nothing on any screen says so — the exact shape of the 2026-08-18
incident (law 11 is the after-the-fact reader that now catches it; this law is
the before-the-fact disclosure).

## 8 · The refusal-naming law

**Statement.** Every refusal on a money path carries a human sentence, and the
set of such sentences is pinned: the money modules emit exactly the acknowledged
number, so adding or removing a refusal is a visible, chosen change that owes a
read-back assertion.

**Seam.** `every-refusal-is-asserted.test.ts:137` — `expect(found).toHaveLength(70)`
over the enforced scope, the `MONEY_MODULES` list (`funding-plan`,
`floor-discipline`, `plan-legs`, `assemble-batch`, `portfolio-batcher`,
`pool-safety`, `displayed-vs-signed`), extracted from source by the ratchet's own
scanner. The file's header records why counting replaced matching: word-window
matching could not answer its own question at any window size.

**Pins.** The ratchet is itself the pin; each acknowledged sentence is asserted in
its owning module's suite (the header's ledger of count changes names them).

**Violation at runtime.** A person is refused money movement with no sentence, or
with a false one — both measured before the law: a missing operator key rendered
as "this quote steers funds somewhere other than the pinned AllowanceHolder,"
and "we cannot read how deep these pools are" shown over a read that had
succeeded.

## 9 · The read-failed law

**Statement.** A failed read is never a market fact and never a value: an
unreadable quote classifies as `read-failed` (not `no-route`), an unreadable
depth keeps a null market term, and both still refuse — nothing defaults, nothing
computes with a number it does not have.

**Seam.** `zeroex-quote.ts:154` (`classifyZeroExOutcome` — our own failures,
rate limits, unparseable bodies, and amount-less 200s are `read-failed`;
`routable` requires positive evidence, a usable positive `buyAmount`) with the
refusal branch in `validateLegQuote` (`:365`, the read-failed throw). The depth
side: `floor-discipline.ts:261` (`deriveLegFloors` — null is unmeasured, which is
not zero; the leg is refused) fed by nulls that stay null
(`portfolio-run-market.ts:76`).

**Pins.** `portfolio-batcher.test.ts:837` ("an UNREADABLE depth still refuses
under consent — the read-failed law outranks the dial, for 'none' AND for a
number"); the acquisition-route suite pins the rendered difference between
"no route" and "we could not check."

**Violation at runtime.** A claim about a market made off a read that never
happened — measured 2026-08-07: every proxy failure and rate limit was shown as
"0x has no route for this asset on this network," and an unauthenticated third
party could burn the quota to a 429 that became a false market fact on every
user's screen.

## 10 · The measured-fee law

**Statement.** The fee is verified from the receipt's own event — the event's
`fundingTotal`, exact integer comparison, floor division — never from the
calldata's declared `feeBps`, which is the caller's own claim about itself.

**Seam.** `batch-fee-verification.ts:73` (`expectedBatchFee` — the module cannot
even be handed a submitted total, by API construction) and `:155`
(`verifyBatchFee` — no matching event is a refusal, never a clean result), over
the pinned `BATCH_EXECUTED_TOPIC0`.

**Pins.** `batch-fee-verification.test.ts:43` (the documented topic0 IS
keccak256 of the documented signature — recomputed, not recalled) and `:100`
("ONE WEI short is under-paid — the boundary that proves the compare is exact").

**Violation at runtime.** Fee deflation that every tolerance would hide: a route
that hands the pulled funding back inside the same call drives measured spend to
zero, so the fee is zero and nothing burns while the buyer still receives the
asset and the calldata's declaration still looks right.

## 11 · The receipt-is-read law

**Statement.** Every run's receipt is reconciled against what the run promised —
one typed verdict per law, each a plain sentence — because a receipt held unread
is an incident report nobody opened.

**Seam.** `post-trade-reconciliation.ts:233` (`reconcileRun`, pure and total,
over `decodeReceiptFacts` at `:676`), reusing law 10's arithmetic and event
shapes rather than re-deriving them.

**Pins.** `post-trade-reconciliation.test.ts:146` — the anchor fixture is the
real incident (2026-08-18: fee charged exactly, the whole fee `BurnDiverted`
because the app supplied an empty burn route; the receipt said so at t=0 and was
decoded by hand days later). Each law is pinned by the case that must come out
different.

**Violation at runtime.** Exactly that incident: the chain announced the problem
in the run's own receipt and no code was listening.

## 12 · The cross-check law

**Statement.** An independent decoder re-judges composed money calldata against
the laws at the wallet seam — a deliberate second derivation, used only as a
cross-check, whose output never flows back into composition; a lint that feeds
the pipeline becomes the pipeline.

**Seam.** `calldata-lint.ts:260` (`lintBatchCalldata`) and `:398`
(`lintWrapperCalldata`) — pure, no IO, decoding the finished bytes with the same
pinned ABIs and re-judging rate, recipient, deadline, floor-present, and
burn-route-present. It complements law 5: that gate binds the bytes to what the
review showed; this one binds them to the laws themselves, so a pipeline that
displays the same wrong number it signs is still caught.

**Pins.** `calldata-lint.test.ts` — law by law, including `:239` (an empty burn
route on the 100%-burn generation diverts the whole fee).

**Violation at runtime.** The one law 5 admits it cannot see: a wrong number
shared by display and calldata, both projections reading one poisoned source,
matching perfectly at the diff.

---

## THE RULE

**One derivation site per money number; everything else consumes it.** The fee
percentage every screen shows is computed from the one constant that is actually
charged; the floor that signs is the floor the review rendered; the split the
minimums follow is the split the payload carries; the burn cut is the
generation's own, read from the deployment book, and verified from the event.
Golden masters (`basket-golden-masters.test.ts`) pin the composed bytes so the
one derivation cannot drift unnoticed.

A second derivation of the same number is allowed for exactly one purpose: a
**cross-check that never becomes a source** (laws 10, 11, 12 — the receipt
verifier, the reconciler, the calldata lint). Nothing a cross-check computes may
flow back into composition; the moment it does, there are two sources again, and
every bug class in `docs/BUG-CLASSES.md` under "dual derivation" reopens.
