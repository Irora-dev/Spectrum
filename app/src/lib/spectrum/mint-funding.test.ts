import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'
import { decideMintFunding, firstMintShapeGapSentence, fundingSplitBpsOf, resolveMintFunding } from './mint-funding'
import type { ContractSplitResult } from './contract-split'
import type { FirstMintWeightSplit } from './first-mint-split'

// ─────────────────────────────────────────────────────────────────────────────
// The provenance of the funding split, pinned.
//
// A buy payload funds each leg from bits [255:240] of its legMins word. Two ways
// to get that wrong, both measured by contracts:
//   · leave it zero  → nothing is acquired, the mint reverts NoOutput
//     (test/KitZeroSplitProbe.t.sol, 2026-08-05: healthy 3-leg basket, supply > 0)
//   · derive it from TARGET WEIGHTS → on a basket whose first minter starved a leg,
//     a $10,000 buy ends with $4,255 instead of $9,900 (their
//     FirstMintStarveEconomics measurement, $5,000 of attacker capital)
// So the only accepted provenance is `factory.bareLegMins`, untouched. These tests
// pin the decision table that enforces it.
// ─────────────────────────────────────────────────────────────────────────────

const FACTORY = '0x07Bfce0976b205FcfDF115F7aD1401Ab1f197e6f' as const
const BASKET = '0x0000000000000000000000000000000000000b0b' as const

const packed = (splits: number[]): ContractSplitResult => ({
  kind: 'ok',
  legs: splits.map((splitBps, i) => ({ splitBps, floorRaw: BigInt(i + 1) })),
})

describe('decideMintFunding — a lens answer becomes the payload split, untouched', () => {
  it('passes the lens splits through verbatim', () => {
    const out = decideMintFunding(packed([2500, 2500, 5000]), { legCount: 3, firstMint: false })
    expect(out).toEqual({
      ok: true,
      packed: true,
      funding: { source: 'lens-split', splitBps: [2500, 2500, 5000] },
    })
  })

  it('does NOT normalise a split that sums under 10000 (the lens rounds each leg down)', () => {
    // Measured live: an honest bare split sums 9999/10000. Topping it up would be us
    // inventing funding the contract did not derive.
    const out = decideMintFunding(packed([3333, 3333, 3333]), { legCount: 3, firstMint: false })
    expect(out.ok && fundingSplitBpsOf(out.funding)).toEqual([3333, 3333, 3333])
  })

  it('keeps a lopsided split that no weight could have produced', () => {
    // The point of the fix: a basket at 50/50 TARGET weights whose current composition
    // says 9000/1000 must be funded 9000/1000. If this ever came back [5000, 5000],
    // a weight would have leaked in.
    const out = decideMintFunding(packed([9000, 1000]), { legCount: 2, firstMint: false })
    expect(out.ok && fundingSplitBpsOf(out.funding)).toEqual([9000, 1000])
  })

  it('keeps a ZERO leg (a holding of nothing is funded with nothing)', () => {
    const out = decideMintFunding(packed([5000, 5000, 0]), { legCount: 3, firstMint: false })
    expect(out.ok && fundingSplitBpsOf(out.funding)).toEqual([5000, 5000, 0])
  })

  it('refuses an answer whose length does not describe this basket', () => {
    const out = decideMintFunding(packed([5000, 5000]), { legCount: 3, firstMint: false })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.retryable).toBe(true)
  })
})

describe('decideMintFunding — no split available', () => {
  it('a PRE-PACKING deployment gets the legacy no-split shape', () => {
    for (const why of ['unpacked', 'no-function'] as const) {
      const out = decideMintFunding({ kind: 'unavailable', why }, { legCount: 3, firstMint: false })
      expect(out).toEqual({
        ok: true,
        packed: false,
        funding: { source: 'basket-weights', because: 'pre-packing-deployment' },
      })
    }
  })

  it('a READ THAT DID NOT LAND refuses instead of guessing the legacy shape', () => {
    // The honesty case. A flaky RPC must not be read as "this basket has no split
    // field" — that is exactly how a zero-split payload would ship again.
    for (const contract of [
      { kind: 'unavailable', why: 'read-failed' } as ContractSplitResult,
      { kind: 'unavailable' } as ContractSplitResult,
    ]) {
      const out = decideMintFunding(contract, { legCount: 3, firstMint: false })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.retryable).toBe(true)
    }
  })

  it('the factory REFUSING to derive is surfaced, never swallowed', () => {
    const out = decideMintFunding({ kind: 'not-derivable', named: true }, { legCount: 3, firstMint: false })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/cannot be funded safely/)
  })

  it('the FIRST MINT on a PRE-PACKING deployment keeps its own floors, no split', () => {
    // Two routes to the same shape: the caller knowing supply is 0, and the lens
    // saying MissingHookData when the caller did not know. No first-mint split is
    // supplied on this generation, and the shape must stay byte-identical.
    const told = decideMintFunding({ kind: 'unavailable', why: 'read-failed' }, { legCount: 3, firstMint: true })
    const discovered = decideMintFunding(
      { kind: 'not-derivable', named: false, firstMint: true },
      { legCount: 3, firstMint: false },
    )
    const explicitNull = decideMintFunding(
      { kind: 'unavailable' },
      { legCount: 3, firstMint: true, firstMintSplit: null },
    )
    for (const out of [told, discovered, explicitNull]) {
      expect(out).toEqual({
        ok: true,
        packed: false,
        funding: { source: 'basket-weights', because: 'first-mint' },
      })
    }
  })

  it('refuses a basket with no legs', () => {
    expect(decideMintFunding(packed([]), { legCount: 0, firstMint: false }).ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE EXCEPTION: the first mint on a PACKING deployment. The lens refuses at
// supply 0 (MissingHookData is its first statement), zeros acquire nothing, and the
// basket's own design weights are the only number that exists. Legal because the
// money is the first minter's own and nobody went before. These tests pin the edges.
// ─────────────────────────────────────────────────────────────────────────────
describe('decideMintFunding — first mint on a PACKING deployment', () => {
  const seed = (splitBps: number[]): FirstMintWeightSplit => ({ source: 'basket-design-weights', splitBps })

  it('packs the basket own weights, as its OWN funding case', () => {
    const out = decideMintFunding(
      { kind: 'unavailable' },
      { legCount: 3, firstMint: true, firstMintSplit: seed([4000, 4000, 2000]) },
    )
    expect(out).toEqual({
      ok: true,
      packed: true,
      funding: { source: 'first-mint-weights', splitBps: [4000, 4000, 2000] },
    })
    // Never `lens-split`: these are weights, and a payload built from them must not
    // be able to pass for something the factory derived.
    expect(out.ok && out.funding.source).not.toBe('lens-split')
  })

  it('works through the lens MissingHookData route too', () => {
    const out = decideMintFunding(
      { kind: 'not-derivable', named: false, firstMint: true },
      { legCount: 2, firstMint: false, firstMintSplit: seed([6000, 4000]) },
    )
    expect(out.ok && out.funding).toEqual({ source: 'first-mint-weights', splitBps: [6000, 4000] })
  })

  it('exposes the split for pricing, so the floors bind to what the payload funds', () => {
    const out = decideMintFunding(
      { kind: 'unavailable' },
      { legCount: 2, firstMint: true, firstMintSplit: seed([6000, 4000]) },
    )
    expect(out.ok && fundingSplitBpsOf(out.funding)).toEqual([6000, 4000])
  })

  it('refuses weights that describe a different basket', () => {
    const out = decideMintFunding(
      { kind: 'unavailable' },
      { legCount: 3, firstMint: true, firstMintSplit: seed([5000, 5000]) },
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.retryable).toBe(true)
  })

  it('⛔ A LATER MINT NEVER USES WEIGHTS — under every branch of the table', () => {
    // The exception is first-mint-only. A caller that hands a weight split to a
    // normal buy must not get one back, whatever the lens said.
    const weights = seed([4000, 4000, 2000])
    const contracts: ContractSplitResult[] = [
      { kind: 'ok', legs: [9000, 500, 500].map((splitBps) => ({ splitBps, floorRaw: 1n })) },
      { kind: 'unavailable', why: 'unpacked' },
      { kind: 'unavailable', why: 'no-function' },
      { kind: 'unavailable', why: 'read-failed' },
      { kind: 'unavailable' },
      { kind: 'not-derivable', named: true },
      { kind: 'not-derivable', named: false },
    ]
    for (const contract of contracts) {
      const out = decideMintFunding(contract, { legCount: 3, firstMint: false, firstMintSplit: weights })
      if (out.ok) {
        expect(out.funding.source).not.toBe('first-mint-weights')
        // and specifically never the weights themselves
        expect(fundingSplitBpsOf(out.funding)).not.toEqual([4000, 4000, 2000])
      }
    }
    // The lens answer still wins verbatim, weights present or not.
    const lens = decideMintFunding(packed([9000, 500, 500]), {
      legCount: 3,
      firstMint: false,
      firstMintSplit: weights,
    })
    expect(lens.ok && lens.funding).toEqual({ source: 'lens-split', splitBps: [9000, 500, 500] })
  })
})

describe('resolveMintFunding — the read around the decision', () => {
  const clientThat = (behaviour: () => Promise<readonly bigint[]>, seen: string[] = []): PublicClient =>
    ({
      readContract: (opts: { functionName: string }) => {
        seen.push(opts.functionName)
        return behaviour()
      },
    }) as unknown as PublicClient

  it('reads the lens and packs what it says', async () => {
    const client = clientThat(async () => [(4000n << 240n) | 5n, (6000n << 240n) | 7n])
    const out = await resolveMintFunding(client, {
      chainId: 8453,
      factory: FACTORY,
      basket: BASKET,
      amountIn: 5_000_000n,
      legCount: 2,
      firstMint: false,
    })
    expect(out.ok && out.packed).toBe(true)
    expect(out.ok && fundingSplitBpsOf(out.funding)).toEqual([4000, 6000])
  })

  it('does not call the chain for a first mint (the lens refuses there by design)', async () => {
    const seen: string[] = []
    const client = clientThat(async () => [], seen)
    const out = await resolveMintFunding(client, {
      chainId: 8453,
      factory: FACTORY,
      basket: BASKET,
      amountIn: 10_000_000n,
      legCount: 2,
      firstMint: true,
    })
    expect(seen).toEqual([])
    expect(out.ok && out.funding).toEqual({ source: 'basket-weights', because: 'first-mint' })
  })

  it('refuses a zero amount without calling the chain', async () => {
    const seen: string[] = []
    const client = clientThat(async () => [], seen)
    const out = await resolveMintFunding(client, {
      chainId: 8453,
      factory: FACTORY,
      basket: BASKET,
      amountIn: 0n,
      legCount: 2,
      firstMint: false,
    })
    expect(out.ok).toBe(false)
    expect(seen).toEqual([])
  })

  it('a pre-packing factory (plain floors) resolves to the legacy shape', async () => {
    const client = clientThat(async () => [123_456n, 789_012n])
    const out = await resolveMintFunding(client, {
      chainId: 8453,
      factory: FACTORY,
      basket: BASKET,
      amountIn: 5_000_000n,
      legCount: 2,
      firstMint: false,
    })
    expect(out.ok && out.funding).toEqual({ source: 'basket-weights', because: 'pre-packing-deployment' })
  })

  it('a transport failure refuses (it is not evidence about the deployment)', async () => {
    const client = clientThat(async () => {
      throw new Error('fetch failed')
    })
    const out = await resolveMintFunding(client, {
      chainId: 8453,
      factory: FACTORY,
      basket: BASKET,
      amountIn: 5_000_000n,
      legCount: 2,
      firstMint: false,
    })
    expect(out.ok).toBe(false)
  })
})

describe('fundingSplitBpsOf', () => {
  it('gives the split for pricing, and null when the basket funds itself', () => {
    expect(fundingSplitBpsOf({ source: 'lens-split', splitBps: [1, 2] })).toEqual([1, 2])
    expect(fundingSplitBpsOf({ source: 'basket-weights', because: 'first-mint' })).toBeNull()
  })
})

describe('firstMintShapeGapSentence — the mislabeled-deployment discriminator', () => {
  // The live 2026-08-15 shape: packsFundingSplit missing from deployments.json on a
  // packing factory → every seed composes unsplit → acquires nothing → the contract's
  // FirstMintUnderValued reads as pool conditions. The sentence fires ONLY on the
  // exact evidence pattern; each flag flipped individually must silence it (a
  // discriminator that fires on a neighbouring case is a guess wearing a diagnosis).
  const firing = {
    firstMint: true,
    funding: { source: 'basket-weights', because: 'pre-packing-deployment' } as const,
    resolvedProbeAnswered: false,
    weightsProbeAnswered: true,
  }
  it('fires on exactly the evidence pattern, naming the flag and clearing the pools', () => {
    const s = firstMintShapeGapSentence(firing)
    expect(s).toMatch(/packsFundingSplit/)
    expect(s).toMatch(/pools and the amount are fine/i)
  })
  it('a later mint never fires (the weight exception is first-mint-only)', () => {
    expect(firstMintShapeGapSentence({ ...firing, firstMint: false })).toBeNull()
  })
  it('a payload that already carries a split never fires (nothing was mislabeled)', () => {
    expect(
      firstMintShapeGapSentence({ ...firing, funding: { source: 'first-mint-weights', splitBps: [6600, 3400] } }),
    ).toBeNull()
  })
  it('a resolved payload that simulates fine never fires (nothing is wrong)', () => {
    expect(firstMintShapeGapSentence({ ...firing, resolvedProbeAnswered: true })).toBeNull()
  })
  it('a weights probe that ALSO fails never fires (that is a dead route, not a config gap)', () => {
    expect(firstMintShapeGapSentence({ ...firing, weightsProbeAnswered: false })).toBeNull()
  })
})
