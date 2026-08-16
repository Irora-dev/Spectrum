# Limit orders: the library contract

> status: canonical · as-of: 2026-08-02 · owner: UIGuy (the lib) → specallocator (the frontend)
> Ⓡ the owner: limit orders ship on ETH + Base; the execution frontend is the allocator lane's.

Seven modules under `app/src/lib/spectrum/` implement the whole rail below the UI.
They are tested (601 in the kit line) and **nothing imports them yet**. This file is
the map and the contract — the modules themselves carry the reasoning in their
headers, so **read the header before changing any of them** rather than trusting
this summary.

## The one-paragraph model

A limit order is **not a transaction**. The user signs an EIP-712 struct, we POST
it, and CoW's solver competition fills it — in one piece, in several pieces, or
never. There is **no contract of ours anywhere in the path**. The only on-chain
action is the user's own ERC-20 approval to the CoW vault relayer.

**The signature IS the authorization.** No simulate-then-sign, no revert to save
anyone, no second confirmation. Once signed and posted, a solver can take it at
that price and it is final. Every guard below exists because of that sentence.

## What each module is for

| Module | Role |
|---|---|
| `cow.ts` | the rail: chain support, addresses, EIP-712 payload, refusals, `appData` |
| `limit-price.ts` | turning a typed price into the exact `buyAmount`, or refusing |
| `order-intent.ts` | what will actually happen to this order, in words |
| `order-commitments.ts` | what is already spoken for, and what to approve |
| `cow-api.ts` | quote / post / status / cancel |
| `cow-pending.ts` | the persisted per-wallet order store |
| `use-cow-orders.ts` | polling the live ones |

## The sequence, in order

1. **Gate the channel.** `channelExecutable('limit', chainId)` — in
   `allocation.ts`. It **fails closed**: omit the chain and you get `false`. CoW
   has no code on 4663 while every live basket is there, so offering it there
   would be a control that can never fill.
   **A PLAN CAN SPAN NETWORKS, and this is the case my first version of this
   contract missed** (caught by specallocator, 2026-08-02). Do NOT pass one leg's
   chain: a plan touching 4663 would then be offered `limit` on the strength of
   its Base leg and **half-fill**, which is worse than not offering it at all.
   Qualify `limit` only when **EVERY leg could settle** — one unsupported leg
   yields `undefined` and the fail-closed default handles the rest.
2. **Quote the market** with `fetchCowQuote`. This is the reference you SHOW.
   It is never what you sign.
3. **Convert the typed price** with `limitAmountFromPrice`, passing the market
   and `nowMs`. It returns the exact `minBuyAmountRaw` **or a refusal**. There is
   no third outcome and no best-effort number.
4. **Read the outlook** (returned alongside) for the chip and the sentence.
   If `blocking` is true the user must not be able to reach a wallet prompt.
5. **Check the commitment** — `committedOf` + `readBalance` +
   `overCommitWarning`. Warn, do not block.
6. **Plan the approval** with `planApproval`, then send it if it is not `none`.
7. **Build the order** with `buildLimitOrder`, then `limitOrderTypedData`.
8. **Last gate before the prompt:** `confirmSignableAmount(displayed, aboutToSign)`.
   ⚠️ `displayed` must be **captured when the user saw it** (a ref updated where
   the number renders), NOT recomputed at click time. Compute at click time and
   compare against an order built from that same value and this is a tautology:
   it always passes, protects nothing, and reads perfectly in a diff.
9. **Sign**, then `postCowOrder`, then `upsertOrder` into the store.
10. **Poll** with `useCowOrders`.

## Invariants — please do not break these without talking to me

- **Never bypass `limitAmountFromPrice`.** Six layers live in it: no floats,
  explicit decimals on both sides, round UP (`buyAmount` is a FLOOR, so rounding
  down asks for less than the user typed), a round-trip proof, the market
  cross-check, and freshness. Hand-rolling the multiply loses all six.
- **A `blocking` outlook must disable signing, not just colour something red.**
  A sell price far below the market fills instantly and loses money
  irreversibly; every other bad outcome only costs time. That asymmetry is the
  entire reason it blocks.
- **Approvals target `committed + adding`, never the new order alone.** An
  allowance is one number per token. Approving just this order would set it below
  what an open order already needs and silently break it.
- **A stale market vouches for nothing.** When `outlook` comes back `null`, say
  you could not check the market. Never imply you did.
- **`appData` stays inert.** It is signed as a hash, so anything inside it is
  invisible in the prompt. `appDataRefusal` rejects `hooks`, `partnerFee` and
  `referrer`; a real Base order in the wild carries `partnerFee: volumeBps 85`,
  a wallet skimming 0.85% through exactly that field.
- **Approve the VAULT RELAYER, not settlement.** `COW_VAULT_RELAYER`. Approving
  the settlement contract leaves every order silently unfillable.
- **Unreachable ≠ rejected.** `cow-api` returns them as different values. A
  rebalance that says "no route" when the network hiccuped makes people abandon
  positions.
- **Do not hardcode `signingScheme`.** `orderPostBody` derives it from signature
  length, because smart accounts return wrapped signatures that do not
  `ecrecover`.

## Copy rules, enforced by tests rather than by review

`order-intent.ts` supplies every user-facing sentence. Its tests assert that no
shown line can contain **twap**, **over time**, **schedule**, **every N** or
**slice**, and that none promises a better price or a guaranteed fill.

The reason: **the axis is PRICE, not time.** A TWAP's mental model is a clock,
n slices every t seconds. This has none. Draw a timeline and it is a lie.

**The three cards keep their shape**, but the middle one changes meaning: a
patient order and a price target are the SAME signed struct, and only where the
price sits differs. "Spread over time" becomes **fills in pieces as the market
reaches it**, which is what a partially-fillable limit honestly does.
`slices` stays false everywhere — a real CoW TWAP needs a contract owner and our
users are EOAs.

Also: **an unfilled expiry is never a failure.** It is the order doing exactly
what was asked, and `fillProgressLine` words it that way.

## Suggested visual

The axis is price, so: **one scale with the market at centre and the user's price
as a marker** — the distance IS the explanation, and one component serves all
outcomes by where the marker lands. `markerPosition` gives you 0–1 and clamps.
For a working order, a **fill gauge** (amount, not time) via `fillFraction`.

## Known gaps, honestly

- **Nothing has ever been signed.** Verified against the live on-chain domain and
  real API responses, but the first real order is a live test.
- **Cancelling costs no gas** (off-chain signed request) — worth saying in the
  UI, because users assume otherwise. The EIP-712 types are
  `COW_CANCELLATIONS_TYPES`; the signing is not wired.
- **Basket tokens will not route.** Measured: CoW quotes 26/26 ordinary assets on
  ETH + Base, but a basket's only venue is a custom V4 hook with no visible
  liquidity. The kit already says so in `config/features.ts`. This rail serves
  the RAW ASSET legs of a portfolio.
- **Routable is not a good price.** Buying DEGEN quotes at every size but the
  rate collapses 57% at $1M. That is the argument for defaulting the long tail
  to a limit rather than market.

Evidence for all measured claims:
`the ops repo/workspace/spectrum-demand/cow-rail-feasibility-2026-08-02.md`.
