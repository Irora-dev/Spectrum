import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, type PublicClient } from 'viem'
import { simulateSwapOut, type SwapSimInput } from './swap-sim'

// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCER SIDE OF THE FIRST-BUY FIX.
//
// swap-quote.test.ts already covers the CONSUMER thoroughly: the survival-ratio
// deflation, degrading to NAV when no simulation arrives, refusing when a leg
// floor rounds to zero. What nothing pinned was the PRODUCER — this probe's own
// hookData — which is where the actual bug lived.
//
// The bug (live user report, 2026-08-02, decoded off-chain against zero-supply
// BLUECHIP): the probe sent ZERO per-leg floors. That is legal on a later mint
// but reverts FirstMintLegMinRequired on a FIRST one (SpectrumBasket.sol:534),
// so on every never-bought basket the probe failed, `realisedOutRaw` came back
// undefined, and the buy was signed with FRICTIONLESS floors the two-hop
// acquisition can never reach. Three baskets were unbuyable and the error blamed
// the user.
//
// Contracts' lineage rev does NOT retire this: their own design doc says "the
// first mint is unchanged… keeps its existing mandatory non-zero" leg min. So
// this rule applies to the first buy on every FUTURE basket too, which is
// exactly why the fix needs a test and not just a comment. Without one, an edit
// putting the zeros back passes every other test in the suite.
// ─────────────────────────────────────────────────────────────────────────────

const HOOK_DATA_ABI = [{ type: 'uint256' }, { type: 'uint256[]' }, { type: 'address' }] as const

/** A client that records the call instead of making it. */
function spyClient(result: bigint) {
  const calls: { args: readonly unknown[] }[] = []
  const client = {
    simulateContract: async (opts: { args: readonly unknown[] }) => {
      calls.push({ args: opts.args })
      return { result }
    },
  } as unknown as PublicClient
  return { client, calls }
}

const input = (over: Partial<SwapSimInput> = {}): SwapSimInput => ({
  side: 'buy',
  basket: '0x4558B00f68F8f4161420df02bfD2f7b31bF00088',
  settlement: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  router: '0x2E39Ae825C697BE3e15ACd003d1398287C83D4b6',
  amountIn: 100_000000n,
  legCount: 3,
  holder: '0x182e54f8011cb15887764E6D4a658cD9b96c8d8F',
  allowanceCovers: true,
  ...over,
})

/** Pull the (minOut, legMins[], frontend) tuple back out of the probe's hookData. */
function decodeHookData(args: readonly unknown[]) {
  const [aggregate, legMins, frontend] = decodeAbiParameters(HOOK_DATA_ABI, args[4] as `0x${string}`)
  return { aggregate, legMins: legMins as readonly bigint[], frontend }
}

describe('swap-sim: the probe must survive a FIRST mint', () => {
  // THE REGRESSION GUARD. If this ever fails, first buys are broken again and
  // the user-facing symptom is a revert that blames the buyer.
  it('sends NON-ZERO per-leg floors, so FirstMintLegMinRequired cannot revert it', async () => {
    const { client, calls } = spyClient(42n)
    await simulateSwapOut(client, input())
    const { legMins } = decodeHookData(calls[0].args)
    expect(legMins.length).toBe(3)
    for (const m of legMins) expect(m).toBeGreaterThan(0n)
  })

  it('sends one floor per leg, because a wrong-length legMins is its own revert', async () => {
    for (const legCount of [1, 2, 5, 12]) {
      const { client, calls } = spyClient(1n)
      await simulateSwapOut(client, input({ legCount }))
      expect(decodeHookData(calls[0].args).legMins.length).toBe(legCount)
    }
  })

  // The floors have to be non-zero to pass the first-mint rule AND negligible,
  // or the probe stops measuring reality and becomes a pass/fail gate again.
  it('keeps the floors at 1 wei, which is non-zero yet below any real fill', async () => {
    const { client, calls } = spyClient(1n)
    await simulateSwapOut(client, input())
    const { aggregate, legMins } = decodeHookData(calls[0].args)
    expect(aggregate).toBe(1n)
    for (const m of legMins) expect(m).toBe(1n)
  })

  it('probes with no frontend tag, so a measurement never books a fee', async () => {
    const { client, calls } = spyClient(1n)
    await simulateSwapOut(client, input())
    expect(decodeHookData(calls[0].args).frontend).toBe('0x0000000000000000000000000000000000000000')
  })
})

// The probe is a mint too: on a D-R1 basket it funds each leg from bits [255:240] of
// the same words. Without the split it acquires nothing and reverts NoOutput
// (contracts' KitZeroSplitProbe, 2026-08-05), so the measurement silently degrades to
// the frictionless estimate this module exists to replace.
describe('swap-sim: the probe carries the funding split', () => {
  it('packs the split beside the 1-wei floors', async () => {
    const { client, calls } = spyClient(4886n)
    await simulateSwapOut(client, input({ fundingSplitBps: [2500, 2500, 5000] }))
    const { legMins } = decodeHookData(calls[0].args)
    expect(legMins.map((w) => w >> 240n)).toEqual([2500n, 2500n, 5000n])
    expect(legMins.map((w) => w & ((1n << 240n) - 1n))).toEqual([1n, 1n, 1n])
  })

  it('leaves an unfunded leg empty (a floor there reverts LegMinNotMet)', async () => {
    const { client, calls } = spyClient(1n)
    await simulateSwapOut(client, input({ fundingSplitBps: [6000, 4000, 0] }))
    expect(decodeHookData(calls[0].args).legMins[2]).toBe(0n)
  })

  it('keeps the plain 1-wei shape when no split applies (pre-packing basket, or a sell)', async () => {
    const bare = spyClient(1n)
    await simulateSwapOut(bare.client, input())
    expect(decodeHookData(bare.calls[0].args).legMins).toEqual([1n, 1n, 1n])
    // A wrong-length split is ignored rather than measuring the wrong trade.
    const mismatched = spyClient(1n)
    await simulateSwapOut(mismatched.client, input({ fundingSplitBps: [10_000] }))
    expect(decodeHookData(mismatched.calls[0].args).legMins).toEqual([1n, 1n, 1n])
    // A sell has no funding to divide.
    const sell = spyClient(1n)
    await simulateSwapOut(sell.client, input({ side: 'sell', fundingSplitBps: [2500, 2500, 5000] }))
    expect(decodeHookData(sell.calls[0].args).legMins).toEqual([1n, 1n, 1n])
  })
})

describe('swap-sim: sides and refusals', () => {
  it('sells the BASKET and buys with the SETTLEMENT token', async () => {
    const buy = spyClient(1n)
    await simulateSwapOut(buy.client, input({ side: 'buy' }))
    expect((buy.calls[0].args[1] as string).toLowerCase()).toBe(input().settlement.toLowerCase())

    const sell = spyClient(1n)
    await simulateSwapOut(sell.client, input({ side: 'sell' }))
    expect((sell.calls[0].args[1] as string).toLowerCase()).toBe(input().basket.toLowerCase())
  })

  // A refusal costs one eth_call and returns null, which the consumer degrades
  // on. Returning 0n instead would look like a real measured outcome.
  it('returns null WITHOUT calling on a non-positive amount or an empty basket', async () => {
    for (const over of [{ amountIn: 0n }, { amountIn: -1n }, { legCount: 0 }]) {
      const { client, calls } = spyClient(1n)
      expect(await simulateSwapOut(client, input(over))).toBeNull()
      expect(calls.length).toBe(0)
    }
  })

  it('returns null rather than throwing when the simulation reverts', async () => {
    const client = {
      simulateContract: async () => {
        throw new Error('execution reverted')
      },
    } as unknown as PublicClient
    expect(await simulateSwapOut(client, input())).toBeNull()
  })

  it('passes the realised output straight through when the call succeeds', async () => {
    const { client } = spyClient(123_456n)
    expect(await simulateSwapOut(client, input())).toBe(123_456n)
  })
})
