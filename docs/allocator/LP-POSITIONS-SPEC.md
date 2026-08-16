# LP positions in the portfolio — spec for confirmation

> status: derived · as-of: 2026-08-06 · owner: specallocator ·
> **AWAITING THE OWNER'S CONFIRM — nothing built.** Plan-first is his standing rule
> for this lane: the exact plan is written before any build, and "how we show it
> / how it works" needs his explicit word. Source: his in-session ask,
> 2026-08-06 ~14:5x — *"we also need to surface LP positions in the portfolio
> system."* On confirm this becomes a dated row in `docs/allocator/PLAN.md` §8.

## 1. Why this is a real hole, not a nice-to-have

The portfolio reads three things: verified-list ERC-20 balances, **discovered**
ERC-20 balances (shipped today, recording 12:58), and held Spectrum baskets. An
LP position is **none of them**, and the failure is different in each venue:

| Venue | What the position IS | What the portfolio does today |
|---|---|---|
| Uniswap **V3 / V4** | an ERC-721 NFT (position manager), value = two token amounts at the current price **+ uncollected fees** | **Invisible.** No ERC-20 balance exists to sweep. |
| Uniswap **V2**, Aerodrome vAMM/sAMM | an ERC-20 LP token | **Newly visible and WRONGLY PRESENTED.** Today's discovery work surfaces it, but no price feed prices an LP token, so it lands as an unpriced row called `UNI-V2` or `vAMM-WETH/USDC`. |
| Staked LP (Aerodrome gauges, etc.) | LP token deposited in a gauge | **Invisible.** The wallet's `balanceOf` is zero — the gauge holds it. |

So the honest statement of the current state is: **the portfolio can be
confidently wrong about someone's largest position.** For the audience this
product is aiming at, LP is frequently where the money actually is — which puts
this in the same class as the low-cap detection gap, not in the polish queue.

## 2. The model — reuse, don't invent

The exposure law already answers the hard question, and it was the owner's own
ruling: **a basket is a POSITION; its contents are EXPOSURE.** An LP position
has exactly that shape.

- **One position** — "WETH/USDC 0.05% LP" — one tile, one row, one value.
- **Two legs of exposure** — the underlying token amounts, which flow into the
  risk curve, the per-chain money line and the tier bands like any other
  exposure, so nothing double-counts.
- **Uncollected fees are money you have not taken yet.** They are real and
  separately claimable, so they are stated separately, never folded silently
  into the position's value.

This means `computeExposure` and the bento's basket handling mostly already fit;
the work is discovery, valuation and one new tile shape — not a new model.

## 3. The honesty rules this surface needs (the part I most want confirmed)

1. **An LP value moves with price in a way a token balance does not.** The
   position's dollar value at today's price is a fact; what it would have been
   held unpooled is a different fact. **Proposal: state the value, state the two
   legs, and do NOT compute impermanent loss in v1** — IL needs an entry basis
   we usually cannot read, and a wrong IL number on someone's biggest position
   is worse than no IL number.
2. **Out-of-range V3 positions are 100% one asset.** That is a fact worth
   showing plainly, because it surprises people: the tile says which side it has
   fully rotated into.
3. **A position we can find but not value is UNPRICED and visible**, never
   dropped, never zero — the standing law, unchanged.
4. **Staked-vs-held is a distinction, not a detail.** If we surface gauge
   positions, the row says it is staked, because it changes what you can do with
   it today.

## 4. Scope proposal — three steps, each shippable alone

| Step | What | Cost / risk |
|---|---|---|
| **A** | **V3/V4 NFT positions** on Base + Ethereum: enumerate via the position manager, value both legs at pool price, show uncollected fees. | The bulk of the work. Bounded reads (one enumeration + per-position multicall). |
| **B** | **ERC-20 LP tokens** (V2/Aerodrome): recognise them so today's discovery stops presenting them as mystery unpriced tokens, and value them from reserves × share. | Small, and it **fixes a regression discovery just introduced**. |
| **C** | **Staked LP** in known gauges. | Venue-by-venue; the least general, and the one I would defer. |

**My recommendation: B first** (it is small, it repairs something live today, and
it makes LP legible at all), **then A** (the real prize), **and C only if he
names a venue he actually uses.**

## 5. What I need from the owner

1. **Ruling on the order** — B→A→C as above, or A first because V3 is where his
   own money sits?
2. **The IL question (§3.1)** — confirm "no impermanent-loss number in v1", or
   overrule if he wants an estimate with a stated basis.
3. **Which venues actually matter** — Uniswap V3/V4 and Aerodrome are the
   assumption; naming the ones he uses stops me building for venues nobody
   touches.

Nothing is built until these are answered.
