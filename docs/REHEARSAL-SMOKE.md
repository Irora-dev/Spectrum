# The rehearsal smoke

A pre-release probe that measures **the world the release is about to trust**,
against **rehearsal decoy contracts** — real, deployed, throwaway instances on
live chains, used only for testing. Two of the measured bug classes
(`docs/BUG-CLASSES.md` #1 the unsupplied seam, #2 generation/environment
drift, #4 unmeasured external assumptions) live in the wiring and the world,
where unit tests cannot see them; this probe looks exactly there.

Runner: `node app/scripts/rehearsal-smoke.mjs` (from `app/`, or anywhere —
viem resolves from the app package like the neighboring scripts).

## The three tiers

1. **SKIP (default).** No env configured → the script prints what it *would*
   probe and exits 0. CI-safe: the gate can run unconditionally and only bites
   when a rehearsal set is actually configured.
2. **READ-ONLY (`--live` + env).** Per enabled chain: RPC reachable and its
   `chainId` matches the env key · every configured rehearsal address **has
   code** (a decoy that was never deployed, or was destroyed, proves nothing —
   fail loud) · the batcher answers a revert-tolerant liveness call (a revert
   *with a reason* is an alive contract talking; only transport failure is
   dead) · `eth_simulateV1` support probed and reported (some RPCs lack it,
   and that fact changes what the app can prove there — measure it, don't
   remember it). Exit non-zero if any enabled chain fails; a report table
   prints either way.
3. **SEND (`--send`) — deliberately not implemented.** Landing real rehearsal
   transactions (a tiny batch, then asserting the receipts against the money
   laws) needs the owner's wallet and an explicit go; the flag refuses with a
   pointer here. What the read-only tier deliberately does **not** prove: that
   a swap fills, that fees burn, that receipts reconcile. That is the send
   tier's job, owner-gated, and until it runs the read-only tier's "clean"
   means *reachable and present*, not *working end to end*.

## Env contract (all optional; absence = SKIP)

| Variable | Meaning |
|---|---|
| `REHEARSAL_CHAINS` | comma list of chain ids to enable, e.g. `8453,4663` |
| `REHEARSAL_RPC_<id>` | RPC URL for that chain |
| `REHEARSAL_BATCHER_<id>` | the rehearsal batcher address |
| `REHEARSAL_WRAPPER_<id>` | the rehearsal direct-swap wrapper address |
| `REHEARSAL_COLLECTOR_<id>` | the rehearsal collector (absent on chains that burn in-protocol — not a failure) |
| `REHEARSAL_WALLET_KEY` | send tier only; never logged; unused today |

## Address rules (standing, non-negotiable)

Rehearsal addresses live in **environment variables or a gitignored
`.env.local` only** — never committed, never hardcoded, never printed in full
(the script logs short forms, `0xAB…CD`). They must never reach a shared
branch or the live site's configuration: an immutable decoy wired into
production cannot be undone. If one is ever headed that way, stop and raise
it loudly rather than proceeding.

## Example invocations

```sh
# CI / no config: prints the plan, exits 0
node app/scripts/rehearsal-smoke.mjs

# read-only probe of one chain
REHEARSAL_CHAINS=8453 \
REHEARSAL_RPC_8453=https://…, \
REHEARSAL_BATCHER_8453=0x… \
node app/scripts/rehearsal-smoke.mjs --live
```
