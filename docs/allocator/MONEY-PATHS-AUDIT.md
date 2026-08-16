# Money-paths audit + the funding/routing design

> status: derived (annex to PHASE3-READINESS.md) · as-of: 2026-08-04 · owner: specallocator ·
> commitment: **committed — §3 CONFIRMED by the owner in-session 2026-08-04 (~11:4x, "yes do
> what you genuinely think is smart for all these decisions"), after the three genuine
> forks were named with their tradeoffs. All three defaults stand as ruled; §3.1 records
> the pros/cons of each so a future reader can see what was traded away, not just what
> was chosen. This section is binding — deviation = amend, confirm, continue.**
> Trigger: the owner ~21:0x — "audit the actual money movement flows … so when the batcher is
> wired up we don't have any surprises; figure out the routing system — does bridging happen
> before buying, how do we know where gas needs to be bridged to, as few txs as possible."

## 1. The flows that move money (all of them)

Every surface that composes movement funnels into ONE of three shapes:

| Flow | Composer | What it hands off today |
|---|---|---|
| Create (keep door) | `compilePlan(draft)` | per-chain `fund` + `batch` steps, **dollars only** |
| Rebalance (popup) · drift-restore · dust-sweep | `composeRebalance` → draft w/ `funding` → `compilePlan` | same steps + `funding.changes` (exact ends; `sellRaw` where known) |
| Publish (both doors' B side) | `compilePlan` publish branch | per-chain `create` + `seedmint` steps |
| Top-up / cover-from-positions | folds into the rebalance shape | — |
| Limit ticket | its own rail (CoW; already wired to real modules) | out of batch scope |

## 2. AUDIT FINDINGS — the surprises, named now (F1–F10)

**F1 — the `fund` step assumes money lives on the first target chain.** `compilePlan`
emits `fund` for every chain except index 0 of *target array order*. Nothing reads where
the user's funding actually sits. Wired naively, the runner would bridge from
nowhere-in-particular. → The funding plan (§3) replaces positional guessing with an
inventory read.

**F2 — `payWith` never enters the draft.** It's `useState` in the weight station; the
plan and draft never see it. The batcher needs an address-level `fundingAsset` per chain
(native sentinel XOR settlement — contract rule 2). → `draft.payWith` becomes recorded
state; the funding plan resolves it per chain.

**F3 — steps carry dollars only.** No raw units, no funding asset, no source chain on any
step. Every real signature needs raw everything. → the funding plan compiles raw
per-chain requirements (plan-legs already does per-LEG exactness; per-chain totals get
the same integer treatment).

**F4 — the rebalance cash draw is chain-blind.** `composeRebalance` draws proportionally
across held stables on ALL chains at once — mainnet USDC can "fund" a Base buy with no
bridge modeled anywhere. `batchRebalance` on Base cannot spend mainnet USDC. → composer
stays pure/chain-blind (it answers "what should the book look like"); the funding plan
nets per chain and turns cross-chain deficits into explicit bridge actions.

**F5 — cross-chain rebalances assume teleportation.** Sell on A, buy on B: no step
bridges the proceeds; `fund` steps exist only for target chains past index 0. → per-chain
net flows in the funding plan; deficits covered by local cash → new money → bridged
surplus, in that order (defaults, §3.2).

**F6 — gas is never modeled.** Nothing computes "how much native does chain X need for
its approve+batch, and does the user have it there". The refuel seam exists
(`fromAmountForGas`) but nothing sizes or triggers it. → the gas inventory (native rows
per chain from the raw-holdings read we already have) vs the gas need per chain; refuel
rides the funding bridge exactly when short (§3.3).

**F7 — approvals are invisible in the plan.** An ERC-20-funded chain is approve+batch =
2 wallet confirms; the run panel says "one transaction". At wiring that's a shown lie.
→ plan steps gain explicit `approve` entries when funding is ERC-20 (native funding
keeps the 1-tx claim true).

**F8 — publish's `seedmint` hides N approvals.** `mintInKind` needs an approval per
seeded token to the basket/router. A 5-asset seed is 5 approvals + mint, per chain,
today rendered as one step. → slice C names them (noted now so the step model grows
once, in slice A's shape).

**F9 — the fee must ride the funding total.** `plan-legs` budgets are the NET spend;
`feeBps` is charged inside the batch (decision: 50bps flat, inside the floor). If the
funding plan sends net-only, the last leg starves by the fee. → per-chain funding
requirement = legs + fee, computed once in the funding plan, test-pinned.

**F10 — a bridge delivers a VARIABLE amount.** `toAmount` is an estimate; composing the
destination batch to the cent before arrival guarantees drift. → destination batches are
composed + simulated at ARRIVAL with the actual delivered amount (`bridge-pending`
already polls delivery); the review shows the planned shape with the caveat stated, and
the readiness spec's execute-time re-quote covers the rest.

## 3. THE FUNDING/ROUTING DESIGN (CONFIRMED 2026-08-04 — binding)

**The order of operations — bridging happens BEFORE buying, always:**

```
NET → FUND → BRIDGE (parallel, refuel-carrying) → per-chain BATCH as each arrival lands
```

1. **NET (pure, `funding-plan.ts`):** per chain: `need = buys + fee` minus `local sell
   proceeds` minus `local spendable cash consistent with payWith`. Result: deficit
   chains, surplus chains, satisfied chains.
2. **FUND — deficit coverage order (chosen defaults, veto-able):**
   a. **local first** — money already on the chain spends there (zero bridges, fewest
      txs, no bridge fees);
   b. **new money / payWith pool next** — bridged from the chain where the user's
      funding asset actually sits (the inventory read, F1's fix);
   c. **cross-chain sell proceeds LAST** — because sells→bridge→buy serializes the run
      (sell must confirm before the bridge can carry it). When (c) is the only source,
      the review says so: "your Base trims fund the Ethereum buys — this run has an
      extra leg of waiting."
3. **BRIDGE — one per deficit chain, in parallel, gas folded in:** each bridge carries
   `fromAmountForGas` sized by the contracts' rule **exactly when** the destination's
   native balance < that chain's gas need (approve-if-ERC20 + batch estimate). A chain
   already holding enough native skips refuel — like-with-like quote comparison per the
   bridging law. **The no-bridge-but-no-gas edge:** if a chain funds locally but lacks
   gas, prefer folding that chain's funding INTO a refuel-carrying bridge from the
   payWith chain over inventing a local swap-for-gas tx (one tx instead of two).
4. **BATCH — per chain, at arrival:** compose (plan-legs) → composeBatchBuy /
   batchRebalance → simulate exact bytes → B2 delta check → approve-if-ERC20 → sign.
   Sells and buys on the SAME chain always ride ONE `batchRebalance` (proceeds fund
   buys inside the tx — the contract's own shape).

**Tx count per user, stated honestly (the "as few as possible" answer):**

| Chain situation | User txs |
|---|---|
| funds local, native funding | **1** (batch) |
| funds local, ERC-20 funding | 2 (approve + batch) |
| bridged funding, native at source | 2 (bridge + batch) +1 if dest funding is ERC-20 |
| bridged funding, ERC-20 at source | 3 (source approve + bridge + batch) |
| same-chain rebalance | 1 batch + per-sell approvals (exact-amount, from `sellRaw`) |

**4663:** inbound refuel expected absent (contracts owe the verdict). Until confirmed
otherwise: a 4663 deficit plan REQUIRES existing native there, or the plan states
plainly that it cannot place gas on 4663 and the chain's legs are marked optional or
the plan refuses — never a silent half-fill.


---

## 3.1 The three forks, ruled — with what each choice trades away

Recorded because a default that reads as "obvious" a month later is a default nobody can
re-examine. Each row is the ruling, why it won, and the honest cost of winning.

### Fork 1 — deficit coverage order: local → new money → sell proceeds LAST

**RULED: the order stands, and proceeds-only runs SAY they will wait.**

| | |
|---|---|
| **Why** | Local money spends with zero bridges, zero bridge fees, fewest txs — free by construction. New money next because it is money the user *chose* to add, and it sits wherever their funding asset sits (F1's fix: never assumed on the first target chain by array order). Proceeds last because sells→bridge→buy **serializes**: the sell must confirm on chain A before a bridge can carry its output to chain B, so the run gains a real waiting leg. Ordering by cost puts the free source first and the slow source last, which is the same order a careful person would pick by hand. |
| **Cost** | A cross-chain rebalance funded only by proceeds is genuinely slow, and the user meets that fact at review rather than at planning. Mitigated by saying it in words ("your Base trims fund the Ethereum buys, this run has an extra leg of waiting"), never by hiding it behind a spinner. |
| **The alternative, and why not** | REFUSE cross-chain proceeds funding and make the user split it into two runs. Cheaper to reason about and impossible to mis-time — but it converts one honest wait into two manual runs, and a user who splits by hand ends up doing exactly what we refused to do for them, with less information. Rejected as protecting us rather than them. |
| **Re-open if** | live 3.2 runs show the serialized leg failing or stranding often (a proceeds bridge whose source batch partially filled). That is a real failure mode, not a speed complaint — it would move this to refuse-and-split. |

### Fork 2 — a chain that has the money but not the gas: fold funding into a refuel bridge

**RULED: fold it — one transaction, not two.**

| | |
|---|---|
| **Why** | The alternative (a local swap-for-gas) costs an extra transaction AND an extra approval on the very chain the user is trying to act on, and it spends the same money on swap fees + slippage anyway. Folding the funding into a refuel-carrying bridge from the payWith chain gets gas and money placed in one motion, which is the "as few txs as possible" instruction applied where it actually bites. |
| **Cost** | Money that did not need to move gets bridged: a bridge fee and bridge slippage are paid on funds that were already home. On small amounts that can be a worse *dollar* outcome than the extra tx would have been. |
| **How the cost is bounded** | The bridge quote is compared like-with-like (refuel-carrying vs bare) per the bridging law, and the review shows the bridge as its own step with its own cost — the user sees the fee they are paying to skip a transaction rather than discovering it after. |
| **Re-open if** | measured bridge cost on a fold exceeds a local swap's all-in cost by a margin worth a tx (a live-data question, not a paper one — 3.2 measurements decide it). |

### Fork 3 — a chain that cannot receive gas (4663 today): require existing native, say so

**RULED: require existing native on that chain and state it plainly. Never optional-legs, never refuse-whole.**

| | |
|---|---|
| **Why** | The two alternatives both fail the honesty bar in different directions. **Optional legs** would quietly drop assets the user explicitly asked for, and drop them for a *gas* reason that has nothing to do with the asset — the consent surface exists for thin liquidity, and reusing it for an infrastructure gap would make "optional" mean two different things. **Refusing the whole plan** punishes a nine-asset multi-chain plan for one chain's limitation. Requiring native is the only answer where nothing is silently lost and nothing unrelated is cancelled: the plan states that this chain needs gas already there, and the user either has it or handles that chain separately. |
| **Cost** | A real dead end for a user with no ETH on 4663 and no way to get it through us — they must acquire native there by some other route. We are surfacing a limitation instead of engineering around it. |
| **Not permanent** | Contracts owe the inbound-refuel verdict. If refuel INTO 4663 lands, this fork dissolves: 4663 becomes an ordinary deficit chain and Fork 2's fold covers it. The refusal is written as a stated limitation, not a law, so it can retire without a redesign. |
| **Unknown ≠ funded** | An UNREADABLE gas estimate refuses the chain by name too — the read-failed law: a chain we cannot size gas for is a chain we cannot promise executes. |

---

**What gets built (the runner's shape):** `funding-plan.ts` — pure: `(inventory,
composedPlan, payWith) → per-chain actions [{bridge?, approve?, batch}]`, pinned like
plan-legs; the runner threads inventory-read → funding-plan → bridges (bridge-pending
tracks) → arrival-composed batches. Plan steps gain `approve` and real `bridge` kinds so
the run panel stops narrating fictions (F7).
