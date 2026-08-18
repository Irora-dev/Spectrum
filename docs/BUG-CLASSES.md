# The bug classes this codebase has measured

Five recurring defect classes, each measured live in this kit — not hypothetical
risk categories. The purpose of the list is one reviewer question per class:
**which of these could this change reintroduce?** Every instance below is a real,
dated event, grounded in the changelog, the commit record, or the code comment
written at the scene. Written 2026-08-18 (hardening wave A); append instances as
they are measured, never invent them.

Companion: `docs/MONEY-LAWS.md` — most countermeasures below are laws there.

| # | Class | Killed by |
|---|-------|-----------|
| 1 | The unsupplied seam | wiring pins + required-by-default |
| 2 | Generation / environment drift | closed generation enums + conformance pins + receipt checks |
| 3 | Dual derivation | the one-seam rule + golden masters |
| 4 | Unmeasured external assumptions | canary probes + retry-then-disclose |
| 5 | Green-but-meaningless signals | exit codes read directly + explicit caps + sabotage-proven tests + mutation sweeps |

## 1 · The unsupplied seam

**Definition.** An optional member on a money path — a context field, a payload
field, a callback — that the type system permits to be absent and that production
never wires. The seam exists, compiles, and does nothing; every downstream
behavior built on it is dead or fail-closed without anyone choosing that.

**How it manifests.** A feature that "works" in tests (which supply the member)
and silently degrades or refuses in production (which does not). Because the
absence is a lawful value, no error names it; the symptom appears somewhere else
entirely.

**Measured instances.**
- **2026-08-18** — the runner's `nativeUsd` context member (the native/USD price
  per funded chain) was optional and production never supplied it, so the gas
  top-up could not be sized and every refuel bridge refused the whole plan — even
  when the destination wallet already held gas.
- **2026-08-18** — the app supplied an empty burn route (`burnSwapData` absent)
  on a 100%-burn chain: the batch charged its fee exactly and then emitted
  `BurnDiverted` for the whole fee — on a $6,645 deployment, the entire fee
  (16_612_500 raw at 6 decimals, $16.61) parked at the fallback sink instead of
  burning.
- **2026-08-09** — a buy payload carried per-leg minimums but left the funding
  split empty; the contract only derives the split itself when the payload is
  completely empty, so nothing was funded and every multi-leg buy reverted.

**Countermeasure.** Wiring pins — tests that exercise the production wiring
itself and fail the moment production stops supplying the member (the
`portfolio-run-wiring` suite; the calldata lint's burn-route-present law) — plus
a required-by-default policy: a new member on a money path is required unless a
recorded decision makes it optional, and an optional member's absent-case is
asserted, never assumed benign. A verification that silently skips when its
input is missing is this class wearing a gate's clothing.

**Review question.** Does this change add or consume an optional member on a
money path — and name the test that fails when production stops supplying it.

## 2 · Generation / environment drift

**Definition.** An encoding assumption that outlives the deployed contract
generation or environment it was written against: a share constant, a selector,
a fee rate, a payload shape that was true for the contracts of one era and is
still being applied to the contracts of the next.

**How it manifests.** Arithmetic that is exactly right for the wrong contract.
Nothing throws — the numbers are internally consistent — so the loss or refusal
shows up on-chain, in receipts, or as an honest batch refusing itself.

**Measured instances.**
- **2026-08-18** — burn routes sized at 7/8 of the fee on a 100%-burn
  (generation-2) chain: an eighth of every fee diverted to the fallback sink by
  arithmetic, even on successful quotes, because the route could never cover the
  cut the contract measured.
- **2026-08-17** — the batch conservation gate conserved against the legacy fee
  constant while the composer sized legs at the chain's own generation-2 rate,
  so an honest batch refused itself — two of our own layers disagreeing about
  which era they lived in.
- **2026-08-16** — the first live buy of the generation-3 deployment went out in
  the older no-split payload shape and the basket refused it whole; the seating
  template had missed the `packsFundingSplit` declaration on every chain, and
  the generations are indistinguishable on-chain at zero supply, so only a
  declaration can carry the fact.
- **2026-08-16** — a wrapper lane charging the batcher's 0.25% fee constant
  undercharges by 15 bps: the batcher's rate assumes the aggregator's own ~15
  bps skim rides inside its quotes, and no aggregator rides the wrapper lanes —
  a fee constant borrowed from the wrong lane.
- **2026-08-12** — the batch ABI gained its burn field at the contract ceremony,
  which moved the `batchBuy` selector; any caller still encoding through the
  retired pre-burn ABI targets a function no deployed contract answers. Pinned
  the same day: the selector is asserted against the deployed artifact, never
  recalled.

**Countermeasure.** Closed generation enums (`FeeGeneration = 1 | 2 | 3` — an
unknown generation is a type error, not a default) with every safety gate
generation-aware; conformance pins that re-derive selectors and shares from the
deployed artifact and the deployment book rather than from memory; and receipt
checks (`post-trade-reconciliation`) that verify the generation's own law —
"fee minus fee/8" or "the whole fee" — against what the chain actually emitted.

**Review question.** Which deployed generation does this encoding assume, and
where is that assumption pinned against the deployment book and the receipt?

## 3 · Dual derivation

**Definition.** The same money number derived in two places by two pieces of
code. The two agree on the day they are written and drift the first time either
side changes — and both sides are "correct" by their own lights, so nothing
refuses.

**How it manifests.** A displayed number and a signed number that part ways; a
lane that computes its own version of a bound another layer already owns and
loses (or wrongly wins) against it; two internally consistent layers refusing
each other.

**Measured instances.**
- **2026-08-18** — the sale lane derived its own floor (probe × (1 − slippage))
  beside the plan's floor: the double-haircut sat the lane's bid a hair under
  the plan's bound on every default-slippage sale, so the fee lane lost every
  route race it was built for — dead code wearing a fee.
- **2026-08-07** (shipped fixed 2026-08-09) — the swap card printed the quote's
  minimum under "Minimum received," then signed a floor rebuilt from a fresh
  simulation at click time, with nothing binding the two; on a moving market the
  signed floor could land below the number the person had read.
- **2026-08-09** — per-leg minimums derived from the basket's target weights
  while the funding split came from the factory's own lens: the two derivations
  measured 28 percent apart, which would have turned one revert into another.
  The fix derives the minimums FROM the split — one source, one consumer.

**Countermeasure.** The one-seam rule (`docs/MONEY-LAWS.md`, THE RULE): one
derivation site per money number, everything else consumes it; golden masters
that pin the composed bytes byte-exact so the single derivation cannot drift
unnoticed; and where a second derivation is genuinely wanted, it is a declared
cross-check whose output never flows back into composition (the calldata lint,
the receipt reconciler).

**Review question.** Does this change compute a number that already has a
derivation site — and if a second computation must exist, what stops it from
ever becoming a source?

## 4 · Unmeasured external assumptions

**Definition.** A belief about an external system — an RPC node, a routing
venue, a token's own transfer rules, market microstructure — adopted from
documentation, habit, or one early observation, and never re-measured against
the live thing. External behavior moves with zero code change.

**How it manifests.** Code that is correct against the imagined counterparty and
wrong against the real one: probes that silently return nothing, venues that
refuse one caller shape while filling another, "impossible" market moves that
are routine, transient failures treated as verdicts.

**Measured instances.**
- **2026-08-16** — the routing aggregator refused batcher-composed swaps on a
  thin-market token at every size while the same pool filled a wallet-taker
  fine; six theories died before the behavior was measured directly, and the
  answer was to remove the aggregator from that path entirely.
- **2026-08-17** — a chain's RPC ignored `stateDiff` state overrides entirely:
  the allowance-override probe silently ran against unprimed state, so the quote
  path moved to an `eth_simulateV1` bundle (approve + swap in one simulated
  block) and degrades by declared rungs where that is missing too.
- **2026-08-18** — a token's own transfer rule refused the fee wrapper as a
  transfer target while filling the same trade direct through the router; the
  lane now carries such tokens honestly — direct, feeless because the token
  leaves no lawful way to charge, disclosed in words on the card.
- **2026-08-18** — one transient quote failure parked a whole run's burn cut at
  the fallback sink; the identical request answered fine minutes later. The
  route now takes one quiet retry, and only then composes with the divert said
  out loud.
- **2026-08-15** — quote-to-execution drift on a thin pool was assumed to be a
  trickle and measured as a step: 854 bps peak-to-trough over four minutes with
  722 bps arriving in a single 12-second interval — a tolerance that survives
  the quiet and dies at the first step is a guaranteed revert, not protection.

**Countermeasure.** Canary probes — the daily live-chain smoke that re-runs
against real contracts, RPCs, and routing with zero code change
(`docs/RELEASES.md`); `npm run verify:deployments` and the sacred smoke reading
the book back from the chains; proving every route against the live chain
before it carries money — plus retry-then-disclose for transients: one bounded
retry, then a named, visible outcome, never a silent verdict off a single
failure (the read-failed law).

**Review question.** Which external behavior does this change assume, when was
it last measured, and what re-measures it after ship?

## 5 · Green-but-meaningless signals

**Definition.** A gate that passes without proving what its green claims: a
check whose success is compatible with the thing it guards being completely
broken. The most dangerous class, because it subtracts vigilance — a red gate
gets attention, a meaningless green gets trust.

**How it manifests.** Clean CI over live bugs. The signal is consumed (a badge,
an exit banner, a count) while the mechanism behind it checks nothing, checks a
sample, or checks itself against itself.

**Measured instances.**
- **2026-08-07** — bare `tsc --noEmit` at the repo root type-checks nothing: the
  root tsconfig is a `files: []` references stub, so the command exits 0 over
  any type error. The real gate is `tsc -b` (`npm run typecheck`), and the
  go-live doc names the trap.
- **2026-08-13** — a push went out gated on the echo of a typecheck rather than
  its exit code; the type error rode through green and was caught one commit
  later.
- **2026-08-16** — the mutation sweep's default cap is 40 mutants per file
  (`app/scripts/mutation-sweep.mjs:152`) while its largest money module has 129
  mutation sites: a capped run can wear a clean face over 89 unexamined sites.
  The tool now stamps `partial: true` — "capped runs are stated, never
  implied" — and the money modules were re-swept uncapped (129/129 sites run,
  2026-08-18).
- **2026-08-07** — the credential gate had three exit-0 bypasses; one shipped a
  BIP-39 seed phrase and called it public-by-shape. A secrets gate that can be
  exited around is a decoration.
- **2026-08-07** — the displayed-vs-signed gate's first cut checked a strict
  subset of the calldata's money fields while claiming full coverage: six
  adversarial mutations — a gutted hub floor, a repointed fee sink, a far-future
  deadline, a swapped route — all passed. The re-encode catch-all closed the
  class without enumerating it.
- **2026-08-07** — a refusal-coverage sweep matched word windows of each
  sentence against test text and reported 64 of 66 sentences asserted; 87% of
  that was false, and the bite test proved it — deleting a real assertion did
  not turn the gate red. It was replaced by an exact pinned count, which is
  weaker and honest.

**Countermeasure.** Read exit codes directly, never through a pipe or an echo;
state every cap explicitly and stamp partial results as partial; sabotage-prove
every gate at birth — break the thing it guards and watch it go red before
trusting a single green ("defeat the fix and watch the pin fail"); and run
mutation sweeps with per-module floors, because an aggregate score cannot see
one module getting worse.

**Review question.** What would this gate report if the thing it checks were
broken — and has anyone made it fail on purpose?
