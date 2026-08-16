# Threat model — the execution + permit + approvals stack

> status: derived (annex to PHASE3-READINESS.md) · as-of: 2026-08-04 (battle-test halves 1+2
> absorbed: P6 added, P1/A1/A2/E1/E5/E6/E12/E13 hardened; §3c the evil-build red team
> added S1-S6 — 36 vectors) · owner: specallocator ·
> Trigger: the owner ~22:1x — "ensure we safeguard and prevent every possible attack vector to
> the best of our ability." Every row is a vector, its defense, and WHERE that defense
> lives. Status legend: ✅ built+pinned · 📋 spec'd (proving-matrix row / runner duty) ·
> 🔗 contracts-owed · 👁 3.2 watchpoint. "Best of our ability" includes saying what we
> can't defend — see §4.

## 1. Signature & permit vectors

| # | Vector | Defense | Status |
|---|---|---|---|
| P1 | Long-lived permit = standing grant wearing a signature | `buildBatchPermit` REFUSES deadlines past chainNow+30min — bounded by the CHAIN'S latest block timestamp, never the device clock (half-2 finding 2: a device two days fast passed the relative check while the chain honored a two-day grant; skewed-clock refusal pinned). Runner reads the chain clock at signing; proving row rehearses the skew | ✅ pinned + 📋 runner reads chain clock |
| P2 | Persistent sub-allowances accumulating | SignatureTransfer flavor by construction — single-use, self-expiring; AllowanceTransfer deliberately not used | ✅ by design |
| P3 | Permit replay across chains | chainId in the Permit2 domain; domain pinned WITHOUT version (adding one breaks verification) | ✅ pinned |
| P4 | Permit replay same-chain | unordered nonces, runner-injected randomness; reuse fails on-chain (safe-fail) | ✅ design / 📋 runner injects |
| P6 | FIRST use of an observed permit by a stranger (bearer authorization) | the signed struct carries no witness/owner-call binding — within the window ANY party could submit the user's signature with THEIR batch calldata; whether the batcher requires msg.sender==owner (or a witness) when consuming permitTransferFrom is CONTRACTS-OWED (their desk carries the ask, placed by UIGuy 2026-08-04). Not live today (Permit2 unwired); the rung stays dark until this row closes | 🔗 contracts-owed, gates the Permit2 rung |
| P5 | Malicious-permit phishing (the ecosystem's drainer vector) | exact recorded amounts · 30-min window · spender = the batcher only; plain-words signature card before every prompt (displayed-vs-signed extended to signatures) | ✅ builders / 📋 card with runner |
| P6 | Wrong spender reaching a permit | builders document batcher-only; runner pins spender against `deploymentFor` registry | 📋 runner duty + proving row |

## 2. Approval vectors

| # | Vector | Defense | Status |
|---|---|---|---|
| A1 | Standing allowances after failed/abandoned runs | post-run hygiene: verify consumed-to-zero and SAY so; leftover surfaces with one-tap revoke — and the ZERO-BALANCE memory (half-2 finding 5): tokens that ever showed an approval stay watched after being sold to zero, so an abandoned run's leftover can't go invisible | 📋 lands with runner / ✅ watch list shipped |
| A2 | Other apps' grants silently spending (incl. Permit2 sub-grants) | the Approvals ledger: live reads, ERC-20 + Permit2 layers, infinite-first, honest-failure counting (Permit2-leg failures COUNT where Permit2 is deployed — presence probed by bytecode once per chain; unreadable probe = layer counted unchecked; half-2 finding 3 closed the silent-swallow), one-tap revoke; panel face states one-wallet scope under the merged book | ✅ shipped `9d592c3` + hardened |
| A3 | Approve-race on USDT-style tokens (non-zero→non-zero reverts) | reset-then-approve (the limit ticket's precedent) generalized to batch approvals | 📋 runner duty + proving row |
| A4 | Infinite approvals requested by our own surface | exact-amount everywhere (seam law 6: approve only the winner, exact, post-re-quote) | ✅ law, 📋 enforced in runner |

## 3. Composition & execution vectors

| # | Vector | Defense | Status |
|---|---|---|---|
| E1 | Outputs pointed at an attacker (recipient tampering) | `composeBatchBuy` REFUSES recipient ≠ owner, and `simulateBatchBuy` refuses account ≠ recipient — the SIGNER-BOUND half (battle-test half-1: owner was a caller-supplied string; the signing account is the one party the last gate can verify) | ✅ pinned |
| E2 | Venue-enum confusion routing money through the wrong acquisition | explicit mapping; V4Q refuses with a sentence; naive cast unrepresentable — enum confirmed against deployed source (SpectrumContracts 2026-08-04: LegVenue {0=V4,1=V3,2=V2,3=BASKET}, hooked keys revert BadV4Key) | ✅ pinned |
| E3 | Zero/absent floors (sandwich takes everything) | floors never zero: per-leg + hub refusals at composition; B2's simulated-recipient-delta ≥ OUR floor before signing | ✅ compose / 📋 B2 in runner |
| E4 | Oracle poisoning / stale spot → floors set low | staleness REFUSAL in planToLegs (undated = stale, not fresh; swap-quote's bound, one law both paths) · credible-liquidity laws upstream · on-chain `refPriceX96`/`aggMinBps` semantics asked of contracts (the chain-side sanity) | ✅ staleness pinned · 🔗 refPrice semantics |
| E5 | Double-buy via retry/fallback after ambiguous submission (three lifetimes: one instance · a remount · TWO TABS) | `ForbiddenFallback` state machine — the forbidden transition THROWS; resolved failures final on their rung. LIFETIME HALF (half-2 finding 1, HIGH — the reducer was airtight only within one instance; a remount reset it to idle): `submission-store.ts` persists every unresolved submission the moment it exists (sanitized-on-read, bridge-pending template) and `hydrateSubmission` is the runner's MANDATORY first move — a remounted machine starts at `submitted`, where attempt throws; the breaking sequence is a pinned test · CONCURRENT half (round 10): every prior analysis assumed instances are SEQUENTIAL, but localStorage is shared across TABS — two tabs both hydrated `idle`, both legally attempted, both submitted the same money, in the window a human spends reading a wallet prompt. `claimStep` writes a CLAIM (no id) BEFORE the wallet is touched; a second tab sees it and refuses. A claim MAY expire where a submission may not: no id means nothing was sent, so there is no ambiguity to preserve — only a tab that may have closed | ✅ pinned all three |
| E6 | Displayed-vs-signed drift | ref-gate (post-paint capture, compared at click) armed on every signature — the limit ticket's machinery generalized. KNOWN LIMIT (half-1 finding 1): the gate cannot catch display and calldata deriving from the SAME wrong number — the cents/raw seam is closed upstream instead (FundingRaw brand + budgets-must-sum-to-total refusal, pinned) | 📋 runner + proving row |
| E7 | Sim-vs-sign byte drift | `simulateBatchBuy` takes the EXACT composed args object; deadline + execute-time re-quote bound the time gap | ✅ compose / 📋 re-quote in runner |
| E8 | Wrong-chain signature (approve on whatever chain was connected) | explicit chainId on every write + wallet switch as a precondition (the limit lesson; ApprovalsPanel already complies) | ✅ pattern, 📋 runner |
| E9 | Bridge under-delivery breaking downstream floors | compose-at-arrival with the ACTUAL delivered amount (F10); bridge-pending tracks; refunds shown denominated | 📋 spec'd (funding plan) |
| E10 | Fee starving the last leg | funding requirement = legs + fee, computed once, pinned (F9) | 📋 funding-plan brick |
| E11 | Malicious/weird tokens (fee-on-transfer, rebasing) | token-screen at entry + floors measure ACTUAL outputs (BatchResult), never expectations | ✅ existing + contract floors |
| E12 | Wrong batcher address (env poisoning / operator misconfig) | ceremony seats addresses; ABI verified byte-level against `batcher.ts` BEFORE the byte matrix (TWO builds now: family keyed by chainId, selector pins test-computed vs forge-inspected); runner verifies deployed BYTECODE HASH before first signature; a result whose outs length mismatches its legs REFUSES loudly (half-1 finding 5 — ABI drift is never a silent misrender) | 📋 proving rows + 🔗 hash published at ceremony |
| E13 | Group-merged positions signed from the wrong wallet | reads-take-the-group / actions-stay-active law verified explicitly in the runner (the exit-cost caveat class) — and `submitted` now CARRIES the signer (half-2 finding 6): the runner compares record.signer to the active account; a mismatch is someone else's live money — report, never resume | 📋 runner duty + ✅ field pinned |
| E14 | Reorg between confirmation and rendering "done" | confirmation-depth policy in the run panel; a 3.2 watchpoint walked with small money | 👁 watchpoint |
| E15 | Two self-pool ops on ONE basket in a single PoolManager unlock (the independent audit's C5: deferred settlement leaves the PM's raw ERC20 transfer short → ERC20InsufficientBalance revert; atomic, no fund loss) | SpectrumBatcher is IMMUNE by construction — execSellLeg settles each leg's basket token to the PM immediately (SpectrumBatcher.sol:674) before the next leg runs; measured by SpectrumContracts 2026-08-05 (two sell legs of the SAME basket through one batchRebalance, both filled — their INTEGRATOR-GUIDE §8.5 + BatchedSelfPoolC5.t.sol). TRIPWIRE: if our encoder ever composes a DEFERRED-settlement batch (any non-per-leg path) touching one basket twice, split into two unlocks or settle between them | ✅ immune (measured) · 👁 tripwire on encoder shape |

## 3b. Data-trust vectors (audit round 2 — attacker-controlled on-chain strings)

| # | Vector | Defense | Status |
|---|---|---|---|
| D1 | CSV formula injection via token symbols (= + - @ leading a cell executes in Excel/Sheets) | `csvEscape` apostrophe-guards dangerous leading chars — the utility defends itself (was unreachable only by the accidental `$` prefix) | ✅ pinned |
| D2 | Symbol-collision identity theft in unification (scam "PEPE" on chain B folds into real PEPE's tile, inherits logo + inflates value) | folding is CURATED: wrap families + stable set only; same-symbol strangers stay separate tiles | ✅ pinned |
| D3 | The residual of D2's shape: a scam token named exactly "USDC"/"ETH" folds into the family tile | shared upstream shape — the tier system's CASH_SYMBOLS/MAJORS are symbol-keyed too; the breakdown rows name every part's chain, and unpriced scams carry no USD. Full fix = canonical address registries per family (chainCfg.weth exists; BTC/cash registries don't yet) | 📋 registry when families grow |
| D4 | localStorage poisoning (drafts, plans, exec log, bridges, watchlist, last-seen) | every reader sanitizes row-by-row at the trust boundary; junk drops, never throws | ✅ pinned per store |
| D5 | XSS via on-chain strings in the UI | React escaping end-to-end; symbols never reach dangerouslySetInnerHTML/canvas-HTML paths | ✅ by construction |

## 3c. Supply-chain vectors (the EVIL-BUILD red team, 2026-08-04)

The frame, stated before the rows so no row oversells: this is a **fully client-side
bundle** — 14 runtime dependencies, ~368 transitive packages, all executing in the same
page as the money paths. A dependency that runs malicious code in that page has TOTAL
power: it can patch any module after import, hook `fetch`, and replace
`window.ethereum`. **No in-bundle defense survives that**, and pretending otherwise
would be worse than saying it (§4 carries it). What this section defends is the vector
that is actually defensible: a **source-level** compromise — a bumped dependency
shipping a patched constant, a PR that "corrects" an address, a paste from a poisoned
doc.

| # | Vector | Defense | Status |
|---|---|---|---|
| S1 | A money-bearing address silently swapped in source (Permit2 / LI.FI diamond / CoW relayer) | pinned as LITERALS in `supply-chain.test.ts` — asserted against typed-out canonical values, never import-vs-import (a test comparing a value to itself passes whatever the value becomes) | ✅ pinned |
| S2 | The spender registry dressing an attacker's address as trusted infrastructure ("Spectrum router") | the registry's producible address set is bounded by test across all three chains — an unrecognized spender fails CI | ✅ pinned |
| S3 | The launch interlock flipped by a build input | `SIMULATED` asserted to be a source LITERAL with no `import.meta`/`process.env`/`window` on its line (the 2026-08-01 blocking finding's structural form) | ✅ pinned |
| S4 | The batcher address set by build env | asserted to have NO `ENV_OVERRIDES` entry — ceremony seats it in the committed registry, and the runner verifies deployed BYTECODE HASH before the first signature (E12) | ✅ pinned |
| S5 | A patched module reading/altering the displayed-vs-signed ref, the composed recipient, or the floor after display | **NOT DEFENSIBLE in-bundle** — see §4. The residual defense is the WALLET as a separate trust domain: every move needs a confirm showing real calldata, so our duty is making that prompt legible (exact amounts, short deadlines, spender = the batcher only, never an infinite approval) | 👁 §4 + design duty |
| S6 | A dependency added to the money path without review | the execution stack is deliberately dependency-thin: the composition modules import only `viem` + house code, so a new import in `batcher.ts`/`plan-legs.ts`/`permit2.ts` is a visible diff at review | 📋 review duty |

## 3d. The self-audit series (2026-08-04, "we need to continue auditing if we're
finding issues") — 15 findings across five modules, none of them from a test suite

Every one was found by driving a module from a probe OUTSIDE its own test file,
and every module's own suite was green while the finding was live. **That is the
pattern, and it is now a standing rule:** a suite written beside a module tests
the cases its author imagined, so a money-path module is not audited until
something adversarial has driven it from outside. What the probes kept finding,
in three recurring shapes:

| Shape | Instances | The general lesson |
|---|---|---|
| **A law written for one representation of "missing"** | routing's "unreadable kills the race" checked `null` and a NaN walked past it, producing a $NaN margin · the submission store's sanitize-on-read made an unparseable record read as *no* record, un-arming the double-buy guard silently · seed-guard skipped a non-finite seed amount, so an unmeasurable seed read as clean | Absence has more than one shape: `null`, NaN, Infinity, unparseable, absent-because-storage-is-dead. A guard that names one of them protects against one of them. Check for READABILITY, not for a value. |
| **A boundary that excludes its own worst case** | seed-guard's `> 100%` meant a seed the size of the entire pool merely warned · routing's exact-equality tie let a third-of-a-cent margin move money through a third-party spender | The extreme case sits exactly ON the threshold more often than past it, and a tie needs a WIDTH, not an equals sign. |
| **A failure path with no record** | `resolve` throwing escaped the whole runner — money submitted, no exec-log row, an orphaned record · an unbounded poll spun 50,000 times in 5ms, hammering the RPC precisely while a transaction was pending | The happy path gets tested; the third-failure-inside-a-failure does not. Ask what happens when the thing that reports the answer is itself broken. |

Two more that were neither shape: the funding plan tracked cash and proceeds as
one merged surplus, so it could bridge cash while calling it sale proceeds (a
money bug); and the submission record carried a `signer` field that nothing ever
compared, so another wallet's live submission would have been adopted and
reported as this run's completed step.

Rows: the runner's laws 9–12 and the funding plan's contract errors are pinned in
their modules; `routing.ts` and `seed-guard.ts` carry their audit notes inline.
**A module joining a money path from here on gets an outside-probe pass before it
is called done** — the cadence in §5, made specific.

### The sweep that replaced the hand-probing (rounds 3–6)

Five rounds of hand-probing kept finding shape 1 — a guard written for one
representation of "missing". So the pattern became a TEST:
`hostile-numbers.test.ts` asserts one invariant across **every pure money
module at once**, and the next module to grow a money field inherits the check
instead of waiting for someone to imagine the case.

> Given any hostile number a real read can produce, a pure money module either
> REFUSES (a sentence, a throw, a dropped row) or returns only finite numbers.
> It may never emit NaN, Infinity, or a negative amount into something a human
> reads as a fact or a wallet signs as an instruction.

The five probe values are **evidence, not imagination**: `NaN` from `Number('')`
and from arithmetic on a failed read · `Infinity` from dividing by a zero
balance · `-1` from a subtraction that assumed ordering · `null` from an honest
unreadable · `1e21` from a wei amount pasted into a dollar field.

It found three more on its first run, all invisible to five rounds of hand
probing — including **"the worst week this mix would have moved -Infinity%"
shown to the user as a stated fact** (round 4 had required worst ≤ best, and
−Infinity satisfies that), and a **deadline of 1e21 composing successfully**
because `Number.isInteger(1e21)` is true: a signature ~30 trillion years out,
the standing-grant shape P1 forbids on the permit side, reached on the batch
side. The sweep asserts on the SHOWN STRINGS as well as the numbers, because
the text is the real surface.

Rounds 3–6 also closed: the submission store **evicting live money by row
count** (the TTL mistake this module's own header rejects, wearing a row cap —
every row there is unresolved money, so the cap could only ever forget a live
submission) · a **partial exec-log row claiming the money it never moved** · a
NaN reaching **`amountUsd`, the figure the confirm gates on**, where `NaN ==
null` is false so the amount-set gate would have passed it · `integerShares`
emitting non-numbers as **weights that land in a saved draft**.

### Rounds 7–8: the hostile-STRING twin, and the storage boundary

The numbers sweep left a gap the same size: a token's symbol is whatever its
deployer typed, and thirteen modules interpolate it into copy a user reads
before spending money. React escapes it against scripts (§3c) and D2 stopped
same-symbol identity theft — neither bounds what a symbol does to a SENTENCE.

| # | Vector | Defense | Status |
|---|---|---|---|
| D4 | A symbol as a WALL: 300 characters produced a 421-character refusal, pushing the button it explains off a phone screen — a denial of consent by typography | `safe-copy.ts` bounds every shown symbol/name with a VISIBLE ellipsis (a truncated name must look truncated, or the clip is a quiet claim) | ✅ pinned |
| D5 | A symbol that RESTRUCTURES a line: newlines let one leg's refusal fake being several, or forge a line that looks like ours | controls, bidi overrides (U+202E and family) and the zero-width set stripped; whitespace runs collapsed | ✅ pinned |
| D6 | A symbol that HIDES: `US​DC` with a zero-width space renders as USDC while being a different token; the reverse-override disguises a ticker | the strip makes the disguise visible — the sanitized form renders identically to the real one, so the unify layer's curated folding (D2) is what decides identity, not the pixels | ✅ pinned |
| D7 | A broken CHAIN ID printed as one: "the network-NaN transaction", and the same value used as a submission-store KEY | `showChainId` — a non-positive-integer id reads "an unknown network"; the key path bounds separately | ✅ pinned |
| D8 | A poisoned DRAFT's amount surviving the storage seam: `amountUsd` was checked `isFinite && > 0` with no ceiling, so a stored `1e21` reached the total the review DISPLAYS and the figure the confirm GATES ON | bounded at `MAX_PLAUSIBLE_AMOUNT_USD` ($1T — past any real portfolio, below a wei-scale paste, so it separates an amount from evidence of tampering without refusing a real one) | ✅ pinned |

Held and now pinned so they stay held: stored weights land in 1–100 whatever was
written · 500 stored targets cannot become 500 legs · a stored `seedPct` stays a
percentage · the CSV's formula-injection safety, which the D1 note called
"unreachable only by accident (every symbol gets a `$` prefix)", is a pinned
PROPERTY rather than a footnote — and symbols are sanitized at the source, so
one holding is always ONE visible row (`csvEscape` quotes a newline correctly
per RFC 4180, but a spreadsheet still renders that holding across two rows).

`hostile-strings.test.ts` is the standing sweep, the numbers sweep's twin. Every
probe value is a real technique rather than a curiosity.

## 4. What we CANNOT defend, said plainly

- **A compromised wallet or seed** — nothing downstream of a stolen key is ours to save.
- **A compromised DEPENDENCY executing in our page** (§3c's frame): it can patch modules,
  hook the network, and impersonate the wallet provider. Address pins and interlock pins
  raise the cost of a *source-level* swap; they do nothing against code running beside
  ours. The real boundary is the **wallet's own prompt** — a separate trust domain we do
  not control and cannot forge. This is why every signature this product requests is
  exact-amount, short-deadline, and batcher-only: the goal is that a legible prompt is
  enough for a careful user to catch us being wrong.
- **A malicious operator fork of the kit** — operators self-host; our defenses protect the
  code AS SHIPPED (structural laws beat config: E1/E12 exist for exactly this reason).
- **A malicious hook on a hooked pool** — excluded by design today; if the hooked-venue
  option ever lands, floors bound the loss but cannot make an arbitrary hook honest.
- **Chain-level failures** (validator censorship, deep reorgs) — watchpoints, not walls.

## 5. Standing audit cadence

Every new execution-path module lands with: its laws as refusals (sentences at review
time, not reverts at signing time) · pins for each law · a row here. The proving matrix
(readiness §6) is the runtime half of this table; a vector without a matrix row before
3.2 is a finding.
