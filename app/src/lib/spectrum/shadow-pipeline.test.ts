import { beforeEach, describe, expect, it } from 'vitest'
import { encodeFunctionResult, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { Venue, type PoolKey } from '../pools/types'
import { BATCH_FEE_BPS } from './allocation'
import { asFundingRaw, batcherAbi, composeBatchBuy, type BatchSimResult, type ComposedBatchBuy } from './batcher'
import { appendShadow, loadShadowLog, runShadowPass, shadowSummary } from './shadow-pipeline'

// SHADOW MODE (§6b) — the silent real-pipeline pass whose log is the 3.2
// evidence base. The pins: honest classification, never a throw, never a
// wallet, and a log that survives garbage.

const ME = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
const BATCHER = '0x0fe4223AD99dF788A6Dcad148eB4086E6389cEB6' as Address
const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }

class MemStore {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
}
let store: MemStore
beforeEach(() => {
  store = new MemStore()
})

// the fixture must satisfy the exact-sum law — walk the gross like the other suites.
// SEED FROM THE FEE, never from a literal: the gross that nets exactly 1_000_000n
// moves when the rate does, and a hand-picked seed is >1000 away from the answer
// at a different rate, so the six-step walk would silently never arrive.
function composedExact(opts: { optional?: boolean } = {}): ComposedBatchBuy {
  // ⚠ THE WALK MUST USE THE SHIPPED FEE, and neither its seed nor its step did
  // (the owner's 2026-08-07 ruling 50 → 40 bps broke all five tests in this file at
  // once). The seed is derived so the walk starts near the answer at any fee,
  // and the step reads the constant — the fixture's job is to satisfy the
  // composer's exact-sum law, which is a law about whatever the fee IS.
  let t = (1_000_000n * 10_000n) / BigInt(10_000 - BATCH_FEE_BPS) + 1n
  for (let i = 0; i < 8; i += 1) {
    const spendable = t - (t * BigInt(BATCH_FEE_BPS)) / 10_000n
    if (spendable === 1_000_000n) break
    t += spendable < 1_000_000n ? 1n : -1n
  }
  return composeBatchBuy({
    chainId: 8453,
    legs: [
      {
        symbol: 'AAVE',
        asset: ME,
        route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
        budgetRaw: asFundingRaw(1_000_000n),
        quotedOutRaw: 500_000n,
        minOutRaw: 497_500n, // the plan's floor, stood in (50 bps off the basis)
        optional: opts.optional ?? false,
      },
    ],
    fundingAsset: zeroAddress,
    fundingTotalRaw: asFundingRaw(t),
    recipient: ME,
    owner: ME,
    deadlineSec: 1_700_000_300,
    hubMinOutRaw: 1n,
    integrator: zeroAddress,
  })
}

function client(answer: Hex | Error): PublicClient {
  return {
    chain: { id: 8453 },
    async call() {
      if (answer instanceof Error) throw answer
      return { data: answer }
    },
  } as unknown as PublicClient
}

function resultOf(c: ComposedBatchBuy, over: Partial<BatchSimResult> = {}): Hex {
  const base: BatchSimResult = {
    spentFunding: c.args[0].reduce((s, l) => s + l.budget, 0n),
    hubOut: 1n,
    feeEth: 0n,
    ethRefunded: 0n,
    usdcRefunded: 0n,
    outs: c.args[0].map((l) => l.minOut + (l.minOut * 200n) / 10_000n), // 200 bps headroom
    skippedBitmap: 0n,
    ...over,
  }
  return encodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', result: base })
}

const pass = (c: ComposedBatchBuy, answer: Hex | Error) =>
  runShadowPass({
    client: client(answer),
    batcher: BATCHER,
    account: ME,
    composed: c,
    intent: 'create',
    nowMs: () => 1_722_800_000_000,
    storage: store as unknown as Storage,
  })

describe('runShadowPass — honest classification, never a throw', () => {
  it('a successful call records would-have-signed with the worst leg headroom as evidence', async () => {
    const c = composedExact()
    const rec = await pass(c, resultOf(c))
    expect(rec.outcome).toBe('would-have-signed')
    expect(rec.worstLegFloorHeadroomBps).toBe(200)
    expect(loadShadowLog(store as unknown as Storage).length).toBe(1)
  })

  it('a revert records would-have-refused with the reason — the pipeline working as designed, not a divergence', async () => {
    const c = composedExact()
    const rec = await pass(c, new Error('execution reverted: SlippageExceeded()'))
    expect(rec.outcome).toBe('would-have-refused')
    expect(rec.reason).toBeTruthy()
  })

  it('a REQUIRED leg skipped on a successful call is the DIVERGENCE class', async () => {
    const c = composedExact({ optional: false })
    const rec = await pass(c, resultOf(c, { skippedBitmap: 1n }))
    expect(rec.outcome).toBe('divergence')
    expect(rec.reason).toMatch(/required leg/i)
  })

  it('an undecodable result is a divergence — struct drift is what shadow mode exists to catch', async () => {
    const c = composedExact()
    const rec = await pass(c, '0xdeadbeef' as Hex)
    expect(rec.outcome).toBe('divergence')
  })

  it('spending above the pull is a divergence', async () => {
    const c = composedExact()
    const rec = await pass(c, resultOf(c, { spentFunding: (c.args[2] as bigint) + 1n }))
    expect(rec.outcome).toBe('divergence')
    expect(rec.reason).toMatch(/more than the batch pulls/i)
  })
})

describe('the shadow log', () => {
  it('caps, survives garbage, and summarizes for the §6b exit criterion', () => {
    const s = store as unknown as Storage
    s.setItem('spectrum:shadowlog', '{not json')
    expect(loadShadowLog(s)).toEqual([])
    appendShadow({ at: 1, chainId: 8453, intent: 'create', outcome: 'would-have-signed' }, s)
    appendShadow({ at: 2, chainId: 8453, intent: 'create', outcome: 'divergence', reason: 'x' }, s)
    appendShadow({ at: 3, chainId: 8453, intent: 'rebalance', outcome: 'would-have-refused', reason: 'y' }, s)
    const sum = shadowSummary(s)
    expect(sum).toEqual({ rows: 3, signed: 1, refused: 1, divergences: 1, firstAt: 1, lastAt: 3 })
  })

  it('a dead store is a no-op, never a throw', () => {
    expect(() => appendShadow({ at: 1, chainId: 1, intent: 'create', outcome: 'would-have-signed' }, null)).not.toThrow()
    expect(loadShadowLog(null)).toEqual([])
    expect(shadowSummary(null).rows).toBe(0)
  })
})
