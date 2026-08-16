# The allocator change protocol — gates every money-path change clears BEFORE it lands

> Written 2026-08-07 by specallocator, after a night in which I shipped a floor rule with the
> **sign inverted**, quoted every route to the **wrong recipient**, and wrote tests that pinned both
> as correct. Every one was caught by an independent reviewer; **none by my own testing, and none by
> my own confidence, which was high throughout.**
>
> Modelled on the contracts lane's `spectrum-contracts/docs/CONTRACT-CHANGE-PROTOCOL.md` and it
> should be read after that one. This lane's gates differ because the failure classes differ: we do
> not own an immutable contract, we **compose calldata for one** and we **show money to a human**.
> Mechanical gates A1–A5: `node app/scripts/allocator-gate.mjs`. Supply chain (A8): `npm run check:deps`. Client secrets (A9): `npm run check:secrets`.
> **A10 — the go-live interlock** runs WITH the suite (`go-live-interlock.test.ts`): flipping `SIMULATED` or `ZEROEX_COMPOSE_ENABLED` in source fails the build until the registry is empty and the M2/full-cycle policies are ruled; the open-findings row count is ratcheted there.
> **A11 — THE ADVERSARIAL REVIEW CADENCE (R ruled 2026-08-07: structural, not episodic).**
> Every batch of money-path commits gets an independent pass from a DIFFERENT lane before it
> merges down. Rotation by design — SpectrumContracts first (strongest, fluent in the floor laws),
> then a COLD reviewer with no lane context, because UIGuy's audit value came partly from distance
> and repeated eyes share blind spots. Each pass appends a row to
> `app/src/lib/spectrum/review-ledger.json` (`at · reviewer · scope · findings · notes`) — including
> the passes that FIND things, because a ledger that records only successes measures nothing.
> **A10 reads this ledger: a live flip requires the last two rows to be `findings: 0` from DISTINCT
> reviewers, neither `self:`-prefixed.** The streak therefore resets by construction on any real
> finding, and a self-run harness (however good) can never satisfy the bar — that is the
> correlated-observer trap the whole ledger exists to close. The reviewer's standing instruction is
> the one that produced today's best findings: **TRY TO BREAK THE FIX, not to confirm it.**
> **A12 — the mutation sweep** (`node app/scripts/mutation-sweep.mjs [target…]`, minutes not seconds — run after money-core changes, NOT in CI): one operator mutant at a time against the target's own suites plus the cross-module harnesses; **every survivor is a missing pin or dead code**. First runs 2026-08-07: pool-safety 31 mutants → 4 boundary pins added + 1 equivalent accepted (zero runner-up divides to Infinity, same outcome); floor-discipline 40 → 4 pins (incl. the negative-notional case that separates `&&` from `||` on the shared-hop accumulator) + 2 equivalents accepted (`hopReserve <= 0` nulls downstream via the finite check either way; a zero notional adds zero either way). Equivalent mutants are ACCEPTED AND NAMED here, never silently re-tallied.
> **funding-plan added 2026-08-07** after the coverage question was put directly — it was NOT a
> target, and M3 (a finding dropped for not reproducing) lived there: the one module where a
> survivor would have been most informative was the one the sweep never looked at. First run: 67
> mutable sites, 40 run, **13 survivors, the most of any module.** Two class-killing laws (no
> zero-cent funding DRAW, no zero-cent BRIDGE — a row for no cents is a sentence about nothing, the
> M5 family pointing the other way) killed one; the remaining **12 cluster in the CARRIER-CHAIN path
> and the `shortCents == 0` boundaries, which the module's fixtures never reach.** That is a
> COVERAGE finding, not a defect claim, and it is tracked by the open-findings row
> `desk-236-M10/M11` rather than asserted away. ALL SEVEN TARGETS NOW SWEPT (2026-08-07).
> **Final tallies: submission-store 40/0 · displayed-vs-signed 8/0 · pool-safety 30/1 ·
> floor-discipline 28/2 · plan-legs 27/13 · batcher 22/15 · funding-plan 28/12.**
> Real findings pinned along the way: the composite step KEY (a `&&`→`||` in renewClaim would let
> a Base claim adopt Ethereum's row — a double-buy shape, and it took a SUBMITTED neighbour to
> isolate because same-signer fixtures made the mutant equivalent) · both CLOCK edges in
> displayed-vs-signed (a deadline exactly on the chain clock is expired; exactly at the window is
> legal) · plan-legs' three money edges (exactly at the depth floor is THIN, exactly at max price
> age is still fresh, zero weight is legal input where negative is refused) · pool-safety's four
> boundary pins · floor-discipline's four.
> **THE ~40 REMAINING SURVIVORS ARE ONE NAMED EQUIVALENCE CLASS, not a backlog:** degenerate-input
> guards where `x <= 0` → `x < 0` yields the same output because zero already produces zero
> (`feeCentsOfTotal(0)`, `rebalanceEthNeedRaw(0n)`, a zero weight mapping to zero). A family law in
> batcher.test.ts asserts the property once over every helper and every degenerate shape rather than
> pinning them individually — **and writing it produced THREE wrong expectations of my own** (a
> missing import, `[NaN, 1]` legitimately giving the good leg everything rather than voiding the
> plan, and a 100% fee correctly making the FEE the whole total while the INVERSE helper is the one
> that refuses). Each is now the helper's actual contract instead of my assumed uniformity: a family
> law written over code you have not read closely is a guess wearing a test.
> funding-plan's 12 are the separate CARRIER-CHAIN coverage gap tracked by the `desk-236-M10/M11`
> registry row. Re-run any target after touching it: `node app/scripts/mutation-sweep.mjs <target>`.
>
> **A12b — SWEPT_CLEAN: the sweep now RECORDS what it measured** (added 2026-08-07). Until this,
> the answer to "has the whole money core been swept?" was the sentence two paragraphs above — and
> **a sentence cannot tell you its own status**, which is the exact reason the open-findings registry
> exists. Worse, the registry row asking the question grepped the sweep's SOURCE for the literal
> string `SWEPT_CLEAN`: **a row any two-character edit could close without a single mutant being
> run is not evidence, it is a password.** Now the sweep writes
> `app/src/lib/spectrum/mutation-sweep-state.json` (machine-written; per target: date, digest,
> mutable sites, mutants run, killed, survivors with a `target:line:operator` signature) and the row
> reads that. **A target is SWEPT_CLEAN when three things hold, all machine-checkable:** a run
> recorded it · **the recorded digest still matches the file on disk** — the review ledger's
> moneyDigest idea applied to coverage, so **editing a module EXPIRES its clean record**, because a
> sweep certifies the bytes it ran against and nothing later · **every survivor has a verdict in
> `mutation-triage.json`** (`equivalent` + a named class · `pinned` + where the test lives ·
> `dead-code` + deleted). **The sweep can never write that third part** — a survivor is an accepted
> equivalent, a missing pin, or dead code, and a tool that triaged its own survivors would be a
> record agreeing with itself. **State the bound rather than implying it:** SWEPT_CLEAN means
> "swept at the configured mutant cap with every survivor given a verdict", NOT "every mutable site
> exercised" — the sweep samples sites by design (`MUTATION_CAP`, default 40), so each record
> carries its own `sites` vs `mutants` and the gap stays visible. Gating on full coverage was
> considered and rejected: under the cap no module could ever qualify, and **a gate nobody can pass
> is a gate that gets ignored.** Verified end-to-end before use — the script's `digestOf` and the
> row's `digest16` were checked to agree byte for byte, since a row that cannot match its own
> record could never flip.
>
> **A13 — ABSORPTION VERIFY** (`node app/scripts/absorb-verify.mjs <branchTip> <mergeCommit>`,
> seconds, read-only — run after ANY lane-into-lane merge, by whoever merged or whoever's work was
> merged). Built 2026-08-07 because that day's absorption was reported complete and accurate — 74
> commits, 42 conflicts, 2234 green, every gate clean — and had still lost two things no conflict
> view, test run or merge message can show:
> · **a whole commit** (the merge's second parent was one behind the branch tip, so three money
>   findings including a double-buy door were simply absent — and nothing was red, because the tests
>   that would have objected were in the missing commit too);
> · **a guard**, to a union that took the other side of a rewritten line, putting a raw
>   deployer-controlled symbol back on screen eleven lines under its own bounded aria-label.
> Two checks answer both: every commit on the branch must be an ancestor of the merge, and no file's
> count of a guard call may go DOWN across it. It derives the merged-in side from the merge's own
> second parent, and checks **both** parents — a union can lose whichever lane's line it did not
> take, and checking only your own side finds only your own losses.
> **Guard names are DISCOVERED from `safe-copy.ts` at every revision involved, never hand-listed**
> (`--guard NAME` / `--guards-from PATH` to extend): an enumerated list is a memory test, and a merge
> is precisely the event that fails one — the same defect class as the enumerated FIELD list, one
> altitude up. **`--text` on the census is load-bearing:** `safe-copy.ts` and `hostile-strings.test.ts`
> hold literal bidi overrides and zero-width characters as data, so git calls them BINARY and prints
> no per-occurrence output — without it, the guard module that DEFINES these guards is the one file
> the census cannot count, and the hostile bytes break the tool that exists to police hostile bytes.
> **A DROP IS A CANDIDATE, NOT A VERDICT** — of that day's four, three were legitimate (a component
> extracted to a new file, a display removed by an owner ruling, a deliberate non-application) and
> one was the regression. The script says so and hints the extraction case by looking for the guard
> landing in a file that did not exist at the parent. **Counts OCCURRENCES, not matching LINES** —
> counting lines invented two phantom drops in the first cut, because one line can hold two calls.
> Exit codes: **0 clean · 1 items to triage · 2 REFUSED** (unresolvable ref, non-merge commit,
> unparseable grep line, or a positive control that did not bite) — a refusal is never a clean
> result, and an unfetched commit reads exactly like an unmerged one, so it refuses rather than
> reporting. Verified against the 2026-08-07 absorption: reproduces all four hand-found drops, the
> one missing commit, correctly flags the extraction as a possible move, and returns CLEAN on the
> earlier complete merge.

## The root causes (named first, because each gate targets one)

1. **I wrote the code AND its tests.** Both encode the same mental model, so when the model is wrong
   they are wrong together and green means nothing. Twice in one night my test asserted the defect:
   `floor-discipline.test.ts` asserted a taxed floor was *lower* and was named as if that cured
   looseness; `plan-legs.test.ts` pinned the same inverted sign as an exact expected object.
2. **MIRROR DRIFT.** The app restates laws that live in an immutable contract. When the contract's
   fee model flipped from inclusive to exclusive, reusing the old scaling helper silently
   double-netted it — and the mirrored `taker` requirement was never mirrored at all.
3. **A DERIVED NUMBER TRUSTED WITHOUT ITS INPUT MEASURED.** `hopReserveUsd` was a *required* input of
   the floor formula with no producer anywhere in the app for a full day. Separately, three rounds of
   tuning tile constants against a measurement that was never taken.
4. **A GATE THAT IS ONLY A COMMENT.** `ZEROEX_COMPOSE_ENABLED` was read by nothing; the only thing
   between the path and going live was a sentence asking a future runner to remember.
5. **COMPOSED TOLERANCES THAT NOTHING MULTIPLIES.** A ±2,000 bps quote bracket feeding a 30 bps floor
   yields 2,024 bps of real permission while the surface reports 30. Neither number is wrong alone.
6. **SHOWN TEXT TREATED AS COSMETIC.** A deployer-controlled symbol reached **wallet-prompt labels**;
   338 sites across 104 files had the same shape.
7. **A FAILED READ RENDERED AS A VERDICT.** My own coverage report printed "covers everything probed"
   on a run where all 25 probes returned HTTP 401.

## The gates

### A1 — MIRROR PARITY ✅ automated
Every contract law the app restates is compared against the **contract source and artifact**: the
selector recomputed from the artifact's own tuple shape (never a hand-retyped signature), `MAX_LEGS`,
`MAX_FEE_BPS`, `MAX_DEADLINE_WINDOW`, the baked `ALLOWANCE_HOLDER`, and the **direction of the fee
inequality** that `maxCommittedFor` inverts.
⚠ **Necessary, not sufficient — and it proved that on 2026-08-07.** A1 passed green while every quote
named the wrong `taker`, because a *prose* integration constraint in the contract header is not a
constant A1 can diff. **A mirrored REQUIREMENT that is not a constant needs its own test, not a
parity check.** When the contract's comments state an obligation, that obligation is a test case.

### A2 — NO UNMEASURED INPUT ON A MONEY PATH ✅ automated
Every input the floor formula needs must (i) have a real producer module and (ii) refuse when
unreadable, with the refusal **asserted in a test** — not merely present. An input that silently
defaults is a floor built on a guess. Caught `unreadable-quote`: a guard that fired but that nothing
ever proved.

### A3 — THE DARK GATE IS CODE ✅ automated
The live entry enforces the flag, no app file reaches the unchecked path, and `SIMULATED` is still
true. A flag nothing reads is not a flag.
⚠ Residual, stated: `composePortfolioBatchBuy` and the ABI are also exported, so a determined caller
can still reach signable bytes without the flag. The gate is honest about being a convention with
one enforced door, not a sandbox.

### A4 — BOTH STANDING SWEEPS COVER EVERY MONEY MODULE ✅ automated
A new money module gets a case in `hostile-numbers` **and** `hostile-strings`, or its unreadable-input
handling is untested by construction. Applicability is **declared per module with a reason** —
because the first version of this gate demanded a hostile-*number* test for a module with no numeric
inputs, and **a vacuous test written to satisfy a gate is worse than no gate.** A stale exemption
fails too.

### A5 — SHOWN TEXT IS BOUNDED ✅ automated
No unbounded deployer-controlled symbol in shown text, outside four **individually named** identity
exemptions (React keys and record ids, where the symbol *is* the identifier). Named individually so a
new one cannot hide in a category.
**Bound at DISPLAY, never at INGEST**: normalising on the way in would let a zero-width impostor
resolve *into* a real ticker and be read as real cash by symbol-comparing code.

### A6 — NO SELF-CERTIFICATION ⭐ the only gate that has ever caught anything here
An independent adversarial pass is a **merge gate, not a follow-up**, for any money-path change.
Required *especially* when I am confident — confidence has been the leading indicator of the defect,
not a defence against it.
**Give reviewers distinct lenses.** Two reviewers with different briefs (floor/quote arithmetic vs
composition/mirror) returned almost disjoint defect sets on 2026-08-06; one lens finds one class.
**A fix is not exempt from A6.** The contracts lane's E6 case study is a fix that passed their gates
1–4 and was withdrawn on independent review; my own five fixes went straight back through A6 for the
same reason.

### A8 — THE SUPPLY CHAIN IS CHECKED WHERE A BUNDLE TEST CANNOT REACH ✅ automated
`node scripts/dep-integrity.mjs` (`npm run check:deps`), added 2026-08-07. `supply-chain.test.ts`
admits in its own opening that a compromised dependency executing in the page has TOTAL power and no
in-bundle test can defend against it. Two controls sit outside the bundle, and this is the
install-time one: the **lockfile still pins everything** (every resolved package sha512-hashed to the
one registry, no file/git/link refs, lockfile v3+, registry pinned in `.npmrc`), and **nothing new
runs code at install** — the four packages that legitimately do are named with their reason AND their
exact script text, so a package keeping its name while changing what it executes fails the check.
⚠ **NOT a blanket `ignore-scripts`, deliberately:** esbuild's postinstall links the platform binary
it fundamentally is, so a blanket ban breaks the build and would be switched off within a day — the
same failure mode as a CSP that breaks the app. An allowlist makes a new lifecycle script a *visible
decision* instead. Verified to bite on four tampers (stripped integrity hash · a new install script ·
an allowlisted script's text changed · registry unpinned).
The **served-app** half is the CSP (`scripts/csp.mjs` → `public/_headers` + `vercel.json`). Its one
open inline-script violation was closed at source on 2026-08-07: the Coinbase Wallet SDK's telemetry
bootstrap, disabled via `telemetry: false` rather than blessed with a hash. Verify a policy change by
loading the BUILT app under the real header — that is how both of that day's remaining findings were
found, and how the redirect before them was.
**Still owed:** SRI + build provenance, so an operator or a user can verify the bundle they were
served matches the release.

### A9 — NO CREDENTIAL REACHES THE CLIENT ✅ automated
`node scripts/no-client-secrets.mjs` (`npm run check:secrets`), added 2026-08-07 after the owner's
*"we need to fix this so no one can get our 0x key."* **A static bundle cannot hold a secret, and
that was MEASURED rather than argued:** a build with a dummy `VITE_ALCHEMY_API_KEY` put the literal
into `dist/assets/index-*.js` twice, and the 0x key itself had NO origin binding — 0x answered 200 to
`Origin: https://totally-unrelated-attacker.example` and 200 to curl with no origin, while the same
call without the key answered 401. Shipping a key in the bundle IS publishing it.
The fix is a proxy (`app/netlify/edge-functions/zerox.ts`): the browser calls our own origin, the key
lives in a **server-side** `ZEROX_API_KEY`, and `api.0x.org` is now deliberately ABSENT from the CSP
so a direct client call fails closed twice. This gate is the durable half — the fix is one careless
`VITE_` prefix from being **silently** undone while the app keeps working perfectly, which is the
protection-that-vanishes class this lane refuses. Fails on four routes, each verified to bite: a
`VITE_`-prefixed secret anywhere · client code reading it · client code fetching `api.0x.org` · a
key-shaped literal in the BUILT bundle (known-benign vendored UUIDs named individually with reasons,
so a new one still fails).
⚠ **AND THE FIRST VERSION OF THIS GATE FAILED ITS OWN TITLE.** It printed *"no credential reaches
the client"* while `VITE_ALCHEMY_API_KEY` — live, paid, metered per request — sat in the built
bundle: the check was name-based and shape-based (two names, one UUID pattern) and that key matched
neither. The gate is **VALUE-BASED** now: resolve what vite would inline from the env files it
actually loads, then look for those exact values in the build output. Accepted-public keys are
listed WITH their compensating control on every run, because an accepted exposure is a standing
decision and a decision nobody restates is one nobody re-checks. Wired as `postbuild`, so it runs
on every `npm run build` rather than when a human remembers.
⚠ **STATED RESIDUAL (A7):** the proxy protects the KEY, not the QUOTA. Our endpoint is reachable by
anyone, so an actor can still spend our allowance through it — they just cannot take the credential
away. The origin check stops another *website* using us from a browser; curl forges headers. Real
quota protection is per-caller rate limiting with state, which an edge function does not have.
⚠ **AND A PROXY THAT FORWARDS WHAT IT IS HANDED IS AN OPEN RELAY** — every upstream URL is rebuilt
from an allowlist in the pure, tested `app/src/lib/spectrum/zerox-proxy-request.ts`.
⚠ **NETLIFY IS THE HOSTING PLATFORM** (the owner, 2026-08-07), and the adapter exists for it alone.
An earlier draft of this section claimed Netlify/Vercel parity — **false**: Vercel does not execute
`netlify/edge-functions/`, and `app/vercel.json` rewrites `/(.*)` to `/index.html`, so the route
would answer HTML at 200. The kit's own deploy docs still advertise Cloudflare Pages and Vercel
(and suggest Cloudflare as the default) — **on those hosts there is no 0x path**, which is a
docs-vs-platform gap raised with the owner rather than patched here.
⚠ **AND THE 0x PATH IS UNWIRED TODAY:** `ZEROEX_COMPOSE_ENABLED = false`, and
`createProxyZeroExFetcher` has no production caller — so nothing in the shipped app calls
`/api/zerox` yet. The endpoint's own exposure, however, begins the moment a site deploys with
`ZEROX_API_KEY` set, which is why it was hardened before it is used rather than after.
⚠ **THE HANDLER LIVES IN `src`, NOT IN THE EDGE FUNCTION** — `tsconfig.app.json` includes `src`
only and `lint` is `eslint src`, so an edge function is checked by nothing. The adapter is a thin
env read; every decision is in `zerox-proxy-handler.ts`, where tsc, eslint and vitest all reach it.

### A7 — STATE WHAT THE CHANGE CANNOT DO
Every money-path change records its **residuals**: what it does not protect against, and the bound.
An accepted risk that is written down is a decision; an unwritten one is a surprise. Residuals live
in `PLAN.md` §8 beside the change that created them.

## Case study — A6 caught what A1–A5 could not (2026-08-06/07)

The mechanical gates were green. Independent review found, all executed rather than reasoned:

1. **Every batch would have reverted.** Quotes named the signer as `taker`; the contract requires
   itself, in its own header. Worse variant: an all-optional plan **succeeds having bought nothing**,
   and a run panel keyed on transaction success reports a completed rebalance.
   ⇨ **RULE, EARNED: when a contract states an obligation in prose, write the test the prose implies.**
   A1 could not see this because it diffs constants and this was a sentence.
2. **Rule 4 was applied with the sign inverted.** The tax was added to the tolerance, which *lowers*
   the floor: a 200 bps token lost 394 bps of protection while being certified inside a 300 bps cap.
   ⇨ **RULE: for any correction term, write the test that fixes its DIRECTION** — "does declaring more
   risk ever make the guarantee weaker?" is one property test and it would have caught this at birth.
3. **The cap could be switched off by a NaN.** `??` catches null/undefined only. The hostile-number
   case written to catch exactly this was **vacuous**: its fixture's honest tolerance was 30 bps, so
   its `<= 300` assertion could never observe the hole.
   ⇨ **RULE (theirs, re-earned): before claiming a test answers a question, confirm the harness can
   EXPRESS the failure.**
4. **A no-exit asset reached the batch tier**, because the refusal sat below an aggregator
   short-circuit and aggregator coverage was treated as evidence about exits. It is buy-side only.
   ⇨ **RULE: a precedence order is a claim about what outranks what — enumerate the full cross-product
   and check every cell, because the ordering bug is invisible in the cells you thought to test.**

## The rule that ties them together

**No money-path change lands on my own testing.** A1–A5 are cheap; run them on everything. A6 is
expensive and non-negotiable, because it is empirically the only one that has caught a real defect in
this lane — including in the fixes for defects it had just found.

## Standing lesson

> **A guarantee cannot be audited by the person who wrote it.** Both of the floor defects above were
> written by someone who had just written the document explaining why floors are the whole
> protection, and tested by someone who believed the same wrong thing. The tests did not fail to
> catch the bugs — they *asserted* them.
