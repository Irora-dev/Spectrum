# Spectrum V2 Frontend — Operator Handover

This documentation set is the complete brief for running the **Spectrum V2 frontend** as your own independent business. Spectrum V2 is a permissionless **basket** primitive on Uniswap V4 hooks (default chain: Base): each basket is an ERC-20 token, fully collateralised by a fixed set of underlying crypto assets, that is its own V4 hook and pool — mintable and redeemable against its underlying at any time, with no admin, no manager, and no rebalancing. The frontend in this repo (`app/`) is a fully static React app that reads the chain and lets users browse, design, and (when you arm the flags) transact against **already-deployed contracts**. These docs are written *to you* — a technically capable web3 operator who will host this frontend, connect it to a deployed factory, and run it under your own name, on your own infrastructure. You were not in any of the conversations that produced this package; assume zero prior context. Everything you need is here or in the contracts source these docs point to.

---

> ## ⚠️ STATUS & PARTITION — read before anything else
>
> **These are PUBLIC / HAND-OFF operator docs.** They contain only product, technical, and business facts you are free to act on. This is software, not advice — verify everything on-chain yourself.
>
> - **The reference contracts are a reference implementation, not a deployable artifact.** Green `forge build` / `forge test` is a starting point, not a guarantee. Reviewing and verifying the contracts before any deployment is on whoever deploys this repo.
> - **Nothing is deployed yet.** This package ships an **empty address book by design** (`app/src/lib/chain/deployments.json` is all empty strings). An empty marketplace on a fresh deployment is **correct behavior, not a bug**. No address in this package is canonical — you fill addresses from a verified `ADDRESSES.md` and your own on-chain verification.
> - **The PRISM burn leg is wired-and-in-flight, not yet realised.** It has **zero lifetime completed burns**. Never describe baskets as "burning" as a present fact — the mechanism is wired; **verify it on-chain** before relying on or claiming it.
> - **Whoever produced this package operates nothing and is not your counterparty.** The package's author holds no keys to anything in it, runs no frontend, pays/endorses no operators, and is not your partner, principal, or counterparty. There is no "Spectrum team" to speak for you. If anyone claims to, be skeptical. The package anoints no venue and ships **no default recipient anywhere** — that emptiness is load-bearing.
> - **Enabling WALLET / DEPLOY / TRADING is your own decision.** A static IPFS/ENS site cannot enforce any access controls on its own; what you add at the edge layer is your call.

---

## Reading order / doc map

Read these in order. Each builds on the last.

| # | Doc | What it covers | Read it if you are… |
|---|-----|----------------|---------------------|
| — | **`README.md`** (this file) | Index, status & partition banner, reading order, adjacent-doc pointers, the consolidated red-line summary. | Everyone — start here. |
| 1 | **`01-BUSINESS.md`** | The business standpoint: what the product is, the operator roles and their economics (the interface-kickback model), the full feature catalog through a value lens, who your users are, revenue and cost structure, go-to-market and cold-start reality, the business risk register, and verifiable precedents. **(The longer-form operator/role narrative that used to be a separate handbook is folded into this doc.)** | Anyone deciding **whether and how** to run this as a business. Read first. |
| 2 | **`02-TECHNICAL.md`** | The technical reference: architecture and stack, every feature's tech spec, the contract-integration surface (`abis-v2.ts`), NAV / fee / hookData / salt-mining / deploy / pool internals, the permissionless crank surface, the config / flags / env model, build, state management, RPC strategy, performance, accessibility, testing, and known constraints. | The engineer who will **configure, build, and reason about** the app. |
| 3 | **`03-IMPLEMENTATION.md`** | The step-by-step go-live runbook: prerequisites, setup, configuration, **connecting to already-deployed + verified contracts** with on-chain checks, build (per flag tier), hosting (IPFS/ENS + alternatives + edge controls), a go-live QA smoke-test checklist, operations/maintenance (including the optional keeper role), troubleshooting, and a "no-bug" acceptance checklist. | Whoever is **putting it live**. Treat as a checklist. |
| + | **`RPC-EFFICIENCY.md`** | Running the app cheaply on your own RPC key: what talks to the RPC and how often, the optional snapshot poller (`scripts/build-snapshot.mjs` + `VITE_SNAPSHOT_URL`) that makes cost flat regardless of traffic, and key hardening (origin restriction, split keys, spend/throughput alerts). | Whoever **pays the RPC bill**. |

> The contract scope is **fixed**: you *connect to* an already-deployed, on-chain-verified factory. A deployed + verified factory and a filled `ADDRESSES.md` are a **prerequisite owned by whoever deploys the contracts** — `03-IMPLEMENTATION.md` does not walk you through deploying the contracts yourself; it points you to that role's runbook if you also hold it.

### The permissionless crank surface (so the index is complete)

Several fee- and redemption-settlement functions are **permissionless cranks** — anyone may call them, and each pays the caller an immutable `CRANK_BOUNTY_BPS` bounty (a spec default; verify the deployed bytecode). They are the contract surface behind the optional keeper role in `03-IMPLEMENTATION.md` §8.4, and none of them is wired into the frontend UI yet (a keeper today is a script you run, not a button):

- **`flushPrismBurn(minEthOut)`** — flushes a basket's accrued burn share toward the PRISM burn path once the accrued share crosses its threshold. This is the wired mechanism for the 10% burn sink; verify its status on-chain before relying on it.
- **`flushRoutes()`** — settles the basket's configured holder/recipient fee routes.
- **`flushFrontendFees(fe)`** — sweeps accrued interface (frontend) fees to the tagged recipient; with the empty default tag this follows the basket creator's routing, never a platform default.
- **`redeemClaims()`** — settles parked / dead-pool redeem claims pro-rata. This is the crank that keeps "redemption is always reachable" true for claims that could not settle inline; it is permissionless and bounty-paying like the others, and likewise has **no FE wiring yet**.

`02-TECHNICAL.md` documents these against `abis-v2.ts`; `03-IMPLEMENTATION.md` §8.4 covers running them. Never present yourself as the sole or scheduled keeper — the cranks are open to anyone by design.

---

## Adjacent docs (outside this set)

These already exist alongside this package. They are context and source-of-truth, not part of the four-doc set above.

- **`../OPERATORS.md`** — the plain-language hosting quick-note: what works keyless, that configuration and flags are yours, that every `VITE_*` value ships publicly. A fast orientation; `03-IMPLEMENTATION.md` is the full runbook.
- **The contracts' own `INTEGRATOR-GUIDE.md` and address book** — the **contract-integration source of truth**, which travels with the **contracts source** (a separate repo; not shipped in this frontend kit). The integrator guide is the self-contained how-to for talking to the factory and baskets (enumerate, read NAV/fees, mint/redeem, tag your interface); the address book is the canonical, deliberately-empty list whoever deploys the contracts fills and maintains. When these docs and the chain disagree, **the chain wins** — the frontend's ABIs are an explicit DRAFT; bind to the deployed deliverable before any deployment.

---

## Consolidated RED-LINE summary

These are load-bearing. Every doc in this set obeys them, and so must you when you operate or extend the frontend.

1. **Baskets, not indexes.** The product is always a **basket** in all user-facing prose — never "index," "fund," "ETF," or "portfolio (as a product label)." (The code carries Index-era identifiers because it was adapted from a v1 codebase; a code symbol may be named verbatim in technical text, but the product is never an index.) Never frame baskets as investment products: no *earn, yield, invest, fund, ETF, passive income, directional bet,* or *"redeemable one-to-one."* You may run a **business** and may **receive** a kickback — that framing is fine.
2. **No curation by default.** Discovery is chain-derived (factory enumeration / `Launched` events); ranking is objective-metric only (TVL / volume / age). No featured lists, no platform-authored taglines, no seed lists, no backtests or projections of hypothetical baskets. The "largest by TVL" spotlight is analytics display, not editorial. If you choose to curate or editorialise, that is **your own legal act** to own.
3. **No addresses, no built-in defaults.** No concrete contract address is canonical here — addresses come from `ADDRESSES.md` and your on-chain verification. Present no address, handle, URL, or recipient as a default. The empty interface-kickback tag (`VITE_INTERFACE_TAG_ADDRESS` unset ⇒ `address(0)` ⇒ the slice follows the **creator's** routing) is load-bearing — **never suggest a default recipient.**
4. **Honest status.** The reference contracts are a reference implementation; nothing is deployed; the burn leg is wired-and-in-flight, not realised (zero lifetime burns) — never claim baskets "burn" as a present fact, and tell readers to verify on-chain. An empty marketplace on a fresh deployment is correct, not a bug.
5. **Affirmative-only V2 properties.** State V2's safety properties affirmatively: e.g. V2 derives per-leg minimums from live quotes on every mint and redeem, so there is **no zero- or empty-slippage path — and you must never add one.** Describe what the protection does, not what any prior version did or did not do.
6. **This is software, not advice.** The kit's legal pages ship as placeholders — replace them with your own real terms / risk / eligibility copy before you go live. Enabling any transactional surface (WALLET / DEPLOY / TRADING) is your own decision and your own responsibility.
