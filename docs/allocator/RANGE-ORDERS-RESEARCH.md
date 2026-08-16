# Selling through a liquidity position — research answer

> status: derived · as-of: 2026-08-06 · owner: specallocator ·
> **RESEARCH ONLY, nothing built.** the owner, 2026-08-06 14:52: *"how possible
> would it also be for us to create a system that helps people sell through
> liquidity positions… all a person wants to know is, I want to sell between 1
> million and 5 million with this amount of tokens, how much money am I going to
> make?… Would that be possible? Can you research it."*

## The short answer: yes, and it already has a name

What he described is a **range order** — a single-sided Uniswap V3/V4 position
placed entirely on one side of the current price. It is a standard, long-
established use of concentrated liquidity, not something that has to be
invented. Deposit only the token you want to sell, in a tick range **above**
spot; as the price trades up through that range the pool sells your tokens into
buyers, and when price exits the top you are holding 100% quote asset. Buying is
the mirror image: quote asset in a range **below** spot.

So the protocol capability is not the question. **The product is the UX and the
lifecycle**, which is exactly where he aimed.

## The number he wants, in closed form

His question — "I want to sell between $1M and $5M mcap, how much will I make?"
— has an exact answer, which is the good news for building a preview.

For a position of liquidity `L` over a price range `[Pa, Pb]`:

```
below the range (all token0):  amount0 = L · (1/√Pa − 1/√Pb)
above the range (all token1):  amount1 = L · (√Pb − √Pa)
```

Divide them and `L` cancels:

```
average fill price = amount1 / amount0 = √(Pa · Pb)
```

**A fully-traversed range order fills at the GEOMETRIC MEAN of its bounds.**
Verified numerically across four magnitudes (exact to floating point).

In his own units, this is the fact worth putting on the screen:

> Selling between **$1M and $5M** market cap fills at **≈ $2.24M**, not the $3M
> midpoint — `√(1 × 5) = 2.236`. That is **2.24× the price at the floor**.

Market cap maps to price by circulating supply, and price maps to ticks by
`tick = log₁.₀₀₀₁(P)`, so "between $1M and $5M mcap" converts to a tick range
mechanically. **The whole complexity he wants hidden is genuinely hideable** —
the user picks two market caps, we pick pool, fee tier, ticks and amounts.

Plus: while the position sits in range it **earns trading fees**, which a market
sell does not. That is real upside, not a rounding detail.

## The four catches, in the order they will hurt

1. **IT UN-FILLS. This is the big one.** A range order is not a limit order. If
   price runs up through your range and then comes back down, the pool spends
   your new USDC buying the tokens back. You are only "sold" once you
   **withdraw**. Any UI that says "filled ✓" and leaves the position open is
   lying by omission — the product has to own the exit, not just the entry.
2. **It only fills if price gets there.** Below the range you still hold every
   token. This is a resting offer, not an execution.
3. **Partial fill is the normal case.** Price stopping mid-range leaves a mix of
   both assets, at a blended price between spot and the geometric mean.
4. **Tick spacing quantises the bounds**, so the market caps snap to the nearest
   representable ticks — the preview must show the caps we can actually place,
   not the ones typed.

## The honest framing of the pitch

Against selling at spot, a range order above spot **always fills at a better
price** — the geometric mean of a range above spot is above spot by
construction — **but only if it fills at all**. That is the whole trade, and it
is a genuinely good one to offer: *a better price, in exchange for uncertain
execution, while earning fees to wait.*

⚠️ **Red-line note for whatever copy this ships with.** "How much money am I
going to make" as a headline is a profit projection, which is on the hard-stop
list for anything published from the Spectrum account. The number itself is
fine — it is the AMM's own arithmetic, not a forecast — but it must be framed as
**conditional**: "if it trades through this range, the pool pays you X." Never
"you'll make X." The distinction is cheap to hold and keeps a genuinely useful
calculator off the wrong side of the line.

## One more thing in our favour

On a small-cap token, **your position is likely to be most of the liquidity in
that range** — which means the estimate is not just theoretical, it is close to
what actually happens, because you are the ladder the price climbs. This idea is
better suited to exactly the low-cap audience the detection work is aimed at
than it would be on a deep-liquidity pair.

## What it would take here

The lane reads pools well and has none of the write side:

| Piece | Status in this repo |
|---|---|
| Pool detection, V3/V4 quoting, USD pricing | **exists** (`app/src/lib/pools/`) |
| Universal router / swap execution | **exists** (deployments book) |
| **Position manager (mint / decrease / collect / burn)** | **absent** — not in `app/src/lib/chain/deployments.json`, no minting code anywhere |
| Tick math + mcap↔price↔tick mapping | **absent**, but standard and closed-form |
| The preview calculator | **absent**; pure, testable, and the formula above is the whole of it |
| Position lifecycle (monitor, warn on un-fill, withdraw) | **absent** — and this is the real product |

**Dependency worth naming:** you cannot sensibly *offer* range orders before you
can *show* LP positions, so `docs/allocator/LP-POSITIONS-SPEC.md` step A (V3/V4
NFT positions in the portfolio) is the prerequisite surface for this, not a
parallel track. That spec is already awaiting his confirm.

## ✅ GREENLIT by the owner, ~15:1x — and what he specified

> *"yes that's fine we can show it on the portfolio page how close to full
> buying/selling you are and ability to withdraw, also we can even show a bento
> asset 'filling up' or filling down with buy/sell progress with colour. Lets do
> this, can we also ensure we take a fee somehow on doing this? maybe smaller
> than the full buy/sell tx."*

**The presentation is now specified**, which is what plan-first was waiting on:

1. **Fill progress on the portfolio page** — how close to fully bought/sold.
2. **Withdraw from the portfolio** — the exit is owned, which is exactly the
   answer to the un-fill trap above.
3. **The bento tile fills up / fills down** with the progress, in colour.

**Built already (this session):** `app/src/lib/spectrum/range-order.ts` — pure,
React-free, tested. It carries the mcap↔price↔tick mapping, the preview
(`avgFillPrice`, `proceeds`, `effectiveMcap`, `upliftVsFloor`) and
`rangeOrderProgress`, which is the number both the portfolio bar and the bento
fill read. Two properties in there are load-bearing and locked by test:

- **Progress is NOT linear in price.** The converted fraction is
  `1 − (1/√P − 1/√Pb)/(1/√Pa − 1/√Pb)`. A bar drawn from where price sits
  between the bounds would say "half sold" when it is not — a lie about money.
- **`canUnfill` is TRUE at every state, including 100%.** A filled range order
  is not a completed sale. The flag exists so no surface can render "done ✓"
  over a position that can still reverse.

## The fee — recommendation, and one conflict he has to rule on

**⚠️ THE CONFLICT, surfaced not buried.** Our live fee copy says the fee is
*"never charged on exit"* (`app/src/components/allocate/PortfolioFlow.tsx:2344`).
A sell-side range order is functionally an exit, so charging on it contradicts a
promise already on screen.

**What I recommend: a fee on REALISED PROCEEDS, taken at withdrawal, charged
only on the portion that actually converted.** Why this one:

- **You pay only for what worked.** An order that never filled and is withdrawn
  pays nothing — which is the fair version and the one that survives scrutiny.
- **It is naturally "smaller than the full buy/sell tx"** as he asked: set below
  the 0.50% batch fee (0.25% is the obvious candidate), and the user has also
  been *earning* pool fees while waiting, so their net is better than a market
  sell even after ours.
- ~~**No custody.** It composes into the withdraw transaction the app already
  has to build (decreaseLiquidity → collect → split), so we never hold the
  NFT.~~
  **⚠️ CORRECTED 2026-08-06 — this was WRONG, and wrong in the dangerous
  direction.** SpectrumContracts' review (`docs/RANGE-ORDER-FEE-HELPER-DESIGN-2026-08-06.md`):
  for a helper to call `decreaseLiquidity`/`collect` it needs approval on the
  position manager, and **an approved operator can decrease and collect that
  position at any time, not only inside our composed transaction** — with
  `setApprovalForAll`, the call an app naturally reaches for, that extends to
  every position the user will ever own. It is *worse* than holding the NFT
  because it is invisible: the user sees the NFT in their wallet and believes
  they are safe. "Not holding the NFT" is not the same as "no custody", and I
  wrote the second while only having established the first.
  **The genuinely custody-free shape exists:** `collect()` takes a recipient, so
  the USER calls `decreaseLiquidity` and `collect(recipient = helper)`, and the
  helper only ever splits tokens already sitting in it. It never touches the NFT
  and cannot act unilaterally. That is the version to build.
  Two more corrections from the same review, both load-bearing: the fee base
  must come from **`decreaseLiquidity`'s return, not `collect`'s** — `collect`
  mixes principal with accrued fees, so charging on it would tax the user's own
  LP yield, precisely the outcome we rejected when we ruled out skimming the fee
  tier. And the collect-then-split must be **atomic or bound to `msg.sender`**,
  or whatever sits in the helper between two transactions belongs to whoever
  calls the splitter first.

**Rejected alternatives, with reasons:** a fee at deposit charges for an order
that may never fill; skimming the pool's own fee tier needs a custom V4 hook and
takes the user's yield; holding the position in our contract is custody, a much
larger audit surface, and against the product's grain.

**The ruling I need from him** is not the mechanism but the promise: either
narrow the exit wording to what it actually meant (*"never charged when you
redeem a basket"*) and price this new product separately, or keep the promise
verbatim and charge on **buy-side range orders only** — which preserves every
existing word but leaves the more popular direction unmonetised.

**Contract dependency:** the withdrawal skim needs a small helper contract, and
contracts are not my lane. Filed on **SpectrumContracts' desk**.

## Verdict

**Possible, well-founded, and a good fit for this product's audience.** The
maths is exact and cheap to implement; the protocol work is standard; the
difficulty is concentrated in lifecycle UX — above all making "it can un-fill"
impossible to miss. It is a bigger build than anything in the current queue and
belongs behind the LP-in-portfolio work, not in front of it.
