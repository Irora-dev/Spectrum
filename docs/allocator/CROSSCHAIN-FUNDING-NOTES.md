# Cross-chain funding — the encoder's obligations (contracts' measured inputs)

> status: derived · as-of: 2026-08-06 · owner: specallocator · source of truth:
> `spectrum-contracts/docs/CROSSCHAIN-FUNDING-REQUIREMENT-2026-08-06.md` +
> `docs/BACKEND-FLOOR-DISCIPLINE.md` + `tools/bridge-probe.py` (theirs — link,
> don't restate; re-measure with the probe before relying on any route).
> Context: R ratified two-phase cross-chain (bridge BEFORE the atomic per-chain
> batch); `compilePlan`'s fund→batch-per-network shape is already the ratified
> shape. SpectrumContracts' 12:31 "4663 hard blocker" was CORRECTED at 12:37 —
> take the latest: Across DOES route to 4663 via its swap API.

## What our side must do (Phase-3 wiring, none of it built yet)

1. **4663 funding is a CROSS-CURRENCY operation.** The settlement asset there
   is USDG (Paxos), not Circle USDC — `Addresses.sol` keeps the symbol "USDC"
   for lockstep only. Fund 4663 ONLY through swap/intent-capable endpoints
   (Across `/api/swap/approval`, Relay). A naive same-asset bridge integration
   fails that leg by construction — the exact trap their own probe fell into.
2. **Routing, per route, two vendors everywhere** (their corrected numbers):
   Relay primary to 4663 on price (~3.9–4.4 bps vs Across ~6.0–6.1); Across
   primary Base↔Ethereum (1.0 vs 1.7 bps). Redundancy is the point — either
   vendor covers any route if the other degrades (Odos died a week ago).
3. **No hardcoded bridge addresses on 4663** — measured: LiFi's diamond
   differs there, Across's canonical handlers have ZERO code, Relay's
   multicaller/relayReceiver are EMPTY. Read every address from the live quote
   response. Relay footgun: `refundTo` MUST be set or automatic refunds are
   disabled entirely (and refunds are origin-side only).
4. **`compilePlan`'s funding assumption must become real detection.** Today it
   emits a fund step only for chains after the first — assuming funds start on
   `chains[0]`. R wants "smartly detect where gas is": multi-chain balance
   discovery + source-chain selection minimizing bridge fee + destination gas
   + slippage + time (measured: Ethereum gas alone can exceed the entire 0.5%
   product fee above ~2.2 gwei — cheapest bridge ≠ cheapest funding).
5. **Floor discipline is mandatory for the encoder** (their
   BACKEND-FLOOR-DISCIPLINE.md): `minBuyAmount` is the batcher's ONLY real
   protection and the contract cannot validate it — a leg routing 100% of its
   budget to an attacker PASSES if it returns 1 wei. Floors must carry the
   **intra-batch self-impact term**: all legs quote against one pre-batch
   state but execute sequentially through a shared hop — measured 384–2,968
   bps, and it GROWS along the batch, so a constant slippage is wrong for
   every leg after the first.

No contract change is needed for any of this (two-phase bought that): the
batcher stays exactly as audited, and a failed batch leaves funds in the
user's own destination wallet.
