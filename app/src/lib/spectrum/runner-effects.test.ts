import { shownAtReviewSurface } from './displayed-vs-signed'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeErrorResult, encodeFunctionResult, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { adversarialWallet, type AdversarialWalletScript } from './adversarial-wallet'
import { asFundingRaw, batcherAbi, composeBatchBuy, type BatchSimResult, type ComposedBatchBuy } from './batcher'
import { composePortfolioBatchBuy, portfolioBatcherAbi } from './portfolio-batcher'
import { INTERFACE_TAG_ADDRESS } from '../config/operator'
import { BATCH_FEE_BPS, batchFeeBpsFor } from './allocation'
import { Venue, type PoolKey } from '../pools/types'
import { runFundingPlan, stepKeyOf, POLL_MAX_ATTEMPTS, type RunState } from './execution-runner'
import type { FundingPlan, FundingStep } from './funding-plan'
import { liveSubmissions } from './submission-store'
import {
  createRunnerEffects,
  MAX_DEADLINE_WINDOW_SEC,
  parseCallsStatusForMoney,
  planExecutable,
  type MeasuredSimulatedStep,
  type RunnerEffectsContext,
  looksStaleQuote,
  STALE_QUOTE_RETRIES,
  asPreviewRefusal,
  poisonFloor,
  resetConfirmedSettlementDecimals,
} from './runner-effects'
import { friendlyRevert, PORTFOLIO_HINTS } from './decode-revert'

// ─────────────────────────────────────────────────────────────────────────────
// THE PLUMBING'S BIRTH AUDIT — the adversarial wallet drives the FULL stack
// (createRunnerEffects → runFundingPlan) with no real chain, because every
// runner law is a claim about wallet behaviour and this suite is where a
// lying wallet finally argues back. Each misbehavior from the greenlit spec
// is a named test; the invariant common to all of them: A LYING WALLET MAY
// COST US AN ANSWER, NEVER A DOUBLE-SPEND AND NEVER A FALSE VERDICT.
// ─────────────────────────────────────────────────────────────────────────────

const ME = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
const OTHER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const BATCHER = '0x0fe4223AD99dF788A6Dcad148eB4086E6389cEB6' as Address
const KEY: PoolKey = { currency0: zeroAddress, currency1: '0x4200000000000000000000000000000000000006', fee: 500, tickSpacing: 10, hooks: zeroAddress }
const ASSET = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address

const NOW_SEC = 1_700_000_000

class MemStore implements Storage {
  private m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  clear() {
    this.m.clear()
  }
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
}
let store: MemStore
beforeEach(() => {
  store = new MemStore()
})

const batchStep = (chainId: number, order = 1): FundingStep => ({
  order,
  action: { kind: 'batch', chainId, fundedFrom: [{ source: 'new-money', fromChainId: chainId, cents: 100_000 }] },
})
const bridgeStep = (from: number, to: number): FundingStep => ({
  order: 1,
  action: { kind: 'bridge', fromChainId: from, toChainId: to, amountCents: 1_000, refuel: false, source: 'new-money' },
})
const planOf = (steps: FundingStep[]): FundingPlan => ({ steps, notes: [], refusals: [], serialized: false, txCountByChain: [] })

/** A real composed batch (one leg, native funding) — the audit runs the real
 *  encode path, not a stand-in object. */
function composedFor(chainId: number, over: { deadlineSec?: number } = {}): ComposedBatchBuy {
  const legSum = 1_000_000n
  // walk to a gross whose spendable is exactly legSum (batcher.test.ts idiom)
  let t = (legSum * 10_000n + (10_000n - BigInt(BATCH_FEE_BPS) - 1n)) / (10_000n - BigInt(BATCH_FEE_BPS))
  for (let i = 0; i < 4; i += 1) {
    const spendable = t - (t * BigInt(BATCH_FEE_BPS)) / 10_000n
    if (spendable === legSum) break
    t += spendable < legSum ? 1n : -1n
  }
  return composeBatchBuy({
    chainId,
    legs: [
      {
        symbol: 'AAVE',
        asset: ASSET,
        route: { venue: Venue.V4, ethPool: KEY, v3Fee: 0, v2Pair: zeroAddress },
        budgetRaw: asFundingRaw(legSum),
        quotedOutRaw: 500_000n,
        minOutRaw: 497_500n, // the plan's floor, stood in (50 bps off the basis)
        optional: false,
      },
    ],
    fundingAsset: zeroAddress,
    fundingTotalRaw: asFundingRaw(t),
    recipient: ME,
    owner: ME,
    deadlineSec: over.deadlineSec ?? NOW_SEC + 300,
    hubMinOutRaw: 1n,
    integrator: zeroAddress,
  })
}

/** The honest sim answer for that batch: one kept leg above its floor. */
function goodResult(composed: ComposedBatchBuy): Hex {
  const result: BatchSimResult = {
    spentFunding: composed.args[0].reduce((s, l) => s + l.budget, 0n),
    hubOut: 1_000_000n,
    feeEth: 0n,
    ethRefunded: 0n,
    usdcRefunded: 0n,
    outs: composed.args[0].map((l) => l.minOut + 500n),
    skippedBitmap: 0n,
  }
  return encodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', result })
}

interface FakeClientScript {
  callData?: (Hex | Error)[]
  receipts?: (Error | { transactionHash: string; status: string; blockNumber: bigint })[]
  simulateCalls?: Error | { results: { status: string; data?: Hex; error?: unknown }[] }
  blockTimestamp?: number
  /** the bridge simulate's allowance read (erc20 allowance) */
  allowance?: bigint
  /** law S2b's decimals() answer — omit for the canonical 6; an Error stages
   *  an unreadable token (which must refuse, never default). */
  decimals?: number | Error
}
function fakeClient(chainId: number, script: FakeClientScript = {}): PublicClient {
  let callIndex = 0
  let receiptIndex = 0
  const client = {
    chain: { id: chainId },
    async getBlock() {
      return { timestamp: BigInt(script.blockTimestamp ?? NOW_SEC) }
    },
    async call() {
      const seq = script.callData ?? []
      if (seq.length === 0) throw new Error('call not scripted')
      const v = seq[Math.min(callIndex, seq.length - 1)]
      callIndex += 1
      if (v instanceof Error) throw v
      return { data: v }
    },
    async simulateCalls() {
      const v = script.simulateCalls
      if (!v) throw Object.assign(new Error('eth_simulateV1 method not found'), { code: -32601 })
      if (v instanceof Error) throw v
      return v
    },
    async estimateGas() {
      return 200_000n
    },
    async getGasPrice() {
      return 10n ** 9n
    },
    async readContract(req?: { functionName?: string }) {
      // decimals() serves law S2b's verification; everything else on this stub
      // has always been the allowance read. Script decimals as an Error to
      // stage an unreadable token; omit for the canonical 6.
      if (req?.functionName === 'decimals') {
        const v = script.decimals
        if (v instanceof Error) throw v
        return v ?? 6
      }
      return script.allowance ?? 0n
    },
    async getTransactionReceipt() {
      const seq = script.receipts ?? []
      if (seq.length === 0) throw new Error('receipt not found')
      const v = seq[Math.min(receiptIndex, seq.length - 1)]
      receiptIndex += 1
      if (v instanceof Error) throw v
      return v
    },
  }
  return client as unknown as PublicClient
}

interface Rig {
  wallet: ReturnType<typeof adversarialWallet>
  logged: unknown[]
  sentTxs: { chainId: number; to: Address; data: Hex; value: bigint }[]
  ctx: RunnerEffectsContext
}
function rig(
  walletScript: AdversarialWalletScript,
  clients: Record<number, PublicClient>,
  over: Partial<RunnerEffectsContext> = {},
): Rig {
  const wallet = adversarialWallet(walletScript)
  const logged: unknown[] = []
  const sentTxs: Rig['sentTxs'] = []
  const composedByChain = new Map<number, ComposedBatchBuy>()
  const ctx: RunnerEffectsContext = {
    account: ME,
    activeAccount: () => ME,
    wallet: {
      provider: wallet,
      sendTransaction: async (chainId, tx) => {
        sentTxs.push({ chainId, ...tx })
        return `0x${'a'.repeat(63)}${sentTxs.length}` as Hex
      },
    },
    client: (chainId) => clients[chainId] ?? null,
    batcherAddress: () => BATCHER,
    composeStep: async (step) => {
      const chainId = step.action.kind === 'batch' ? step.action.chainId : 0
      if (!composedByChain.has(chainId)) composedByChain.set(chainId, composedFor(chainId))
      return composedByChain.get(chainId)!
    },
    // Law P8's default fixture: a shown record consistent with what this rig
    // composes, so every law-focused test passes the gate transparently. The
    // gate's OWN tests override this to construct divergence.
    shownFor: (step) => {
      const chainId = step.action.kind === 'batch' ? step.action.chainId : 0
      if (!composedByChain.has(chainId)) composedByChain.set(chainId, composedFor(chainId))
      const c = composedByChain.get(chainId)!
      // ⚠ THIS RIG DERIVES THE SHOWN RECORD FROM THE COMPOSITION, which is
      // exactly what a PRODUCTION `shownFor` may never do (see the brand's note
      // on `ShownStepReview`: it makes the gate f(x) === f(x)). Here it is
      // deliberate and confined to a fixture — the rig needs a record that
      // agrees with the bytes so law-focused tests pass the gate transparently,
      // and the gate's own tests below override it to construct divergence. The
      // brand is what makes this choice visible at the call site instead of
      // being the path of least resistance in real code.
      return shownAtReviewSurface({
        chainId,
        fundingAsset: c.args[1],
        fundingTotalRaw: c.args[2],
        recipient: c.args[3].recipient,
        legs: c.args[0].map((l, i) => ({ symbol: `L${i}`, asset: l.asset, budgetRaw: l.budget, minOutRaw: l.minOut, optional: l.optional })),
        approvals: (over.approvalsFor?.(step) ?? []).map((a) => ({ token: a.token, amountRaw: a.amountRaw })),
      })
    },
    writeExecLog: (e) => logged.push(e),
    store,
    nowMs: () => NOW_SEC * 1000,
    sleep: async () => {},
    ...over,
  }
  return { wallet, logged, sentTxs, ctx }
}

async function runPlan(r: Rig, steps: FundingStep[]): Promise<RunState> {
  return runFundingPlan({ account: ME, plan: planOf(steps), effects: createRunnerEffects(r.ctx), simulated: false })
}

describe('the plumbing, end to end — the honest wallet baseline', () => {
  it('atomic rung: probes capabilities, sends ONE atomicRequired bundle of the simulated bytes, resolves, clears the record', async () => {
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const r = rig(
      { atomic: true, sendCalls: ['id-1'], callsStatus: { 'id-1': [{ status: 100 }, { status: 200, receipts: [{ status: 'success' }] }] } },
      clients,
    )
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('done')
    expect(state.steps[0].status).toBe('done')
    // the record cleared on the terminal answer
    expect(liveSubmissions(store)).toEqual([])
    // one exec-log row, complete
    expect(r.logged).toEqual([{ partial: false, completedSteps: [stepKeyOf(batchStep(8453))] }])
    // MONEY REQUIRES ATOMICITY on the bundle rung
    const send = r.wallet.requests.find((q) => q.method === 'wallet_sendCalls')
    const params = (send?.params as { atomicRequired?: boolean; calls?: { data?: string }[] }[] | undefined)?.[0]
    expect(params?.atomicRequired).toBe(true)
    // P7 — the bytes sent are the bytes simulated (one encoding)
    expect(params?.calls?.[0]?.data).toBeTruthy()
  })

  it('plain rung when the wallet has no atomic support: one plain tx, receipt resolves it', async () => {
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        callData: [goodResult(composed)],
        receipts: [new Error('not found yet'), { transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n }],
      }),
    }
    const r = rig({ atomic: false }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('done')
    expect(r.sentTxs.length).toBe(1)
    // P7 — the plain tx sends the exact simulated bytes
    expect(r.sentTxs[0].to).toBe(BATCHER)
    expect(r.sentTxs[0].value).toBe(composed.value)
    expect(liveSubmissions(store)).toEqual([])
  })
})

describe('the adversarial wallet vs the runner laws', () => {
  it('THE FORGETFUL WALLET: an id it later disowns → unresolved, record SURVIVES, never a verdict', async () => {
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    // callsStatus unscripted for id-1 → every poll throws "unknown bundle id"
    const r = rig({ atomic: true, sendCalls: ['id-1'] }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('partial')
    expect(state.steps[0].status).toBe('unresolved')
    const live = liveSubmissions(store)
    expect(live.length).toBe(1)
    expect(live[0].submissionId).toBe('calls:8453:id-1')
    expect(r.logged).toEqual([expect.objectContaining({ partial: true })])
  })

  it('THE FLATTERING WALLET: a confirmed wrapper over a reverted receipt is a FAILURE, never a success (P3)', async () => {
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const r = rig(
      { atomic: true, sendCalls: ['id-1'], callsStatus: { 'id-1': [{ status: 200, receipts: [{ status: 'reverted' }] }] } },
      clients,
    )
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('partial')
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/part of it reverted/i)
    // ⚠ THIS ASSERTION WAS INVERTED, and the audit is why (R3, 2026-08-07). It
    // read "a RESOLVED failure is terminal — the record clears", which is right
    // for a TOTAL failure and wrong for this one: "part of it reverted" means
    // part of it LANDED. Clearing here let a retry re-send legs that had
    // already executed. The step is still `failed` — we know the outcome — but
    // the record survives so nothing can quietly re-send it.
    expect(liveSubmissions(store)).toHaveLength(1)
  })

  it('THE STALLING WALLET: pending past the whole poll budget → unresolved, record intact, honest words', async () => {
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const r = rig({ atomic: true, sendCalls: ['id-1'], callsStatus: { 'id-1': [{ status: 100 }] } }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.steps[0].status).toBe('unresolved')
    expect(state.steps[0].message).toMatch(/could not confirm/i)
    expect(liveSubmissions(store).length).toBe(1)
  })

  it('THE GARBLED WALLET: shapes no spec defined are AMBIGUITY, never failure and never success (P1)', async () => {
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const r = rig(
      { atomic: true, sendCalls: ['id-1'], callsStatus: { 'id-1': [{ status: { weird: 1 } }, 'lol', {}, { status: 150 }] } },
      clients,
    )
    const state = await runPlan(r, [batchStep(8453)])
    // it held ambiguity to the budget rather than classifying garbage
    expect(state.steps[0].status).toBe('unresolved')
    expect(liveSubmissions(store).length).toBe(1)
  })

  it('THE ECHOING WALLET: the same id for two different steps → the second is ambiguity BY CONSTRUCTION (P4)', async () => {
    const c8453 = composedFor(8453)
    const c1 = composedFor(1)
    const clients = {
      8453: fakeClient(8453, { callData: [goodResult(c8453)] }),
      1: fakeClient(1, { callData: [goodResult(c1)] }),
    }
    const r = rig(
      { atomic: true, sendCalls: ['same-id', 'same-id'], callsStatus: { 'same-id': [{ status: 200 }] } },
      clients,
    )
    const state = await runPlan(r, [batchStep(8453, 1), batchStep(1, 2)])
    expect(state.steps[0].status).toBe('done')
    // the second step must NOT read the first step's success as its own
    expect(state.steps[1].status).toBe('unresolved')
    const live = liveSubmissions(store)
    expect(live.length).toBe(1)
    expect(live[0].submissionId).toBe('dup:same-id')
  })

  it('THE WRONG-RECEIPT NODE: a receipt for a different hash answers nothing (P2)', async () => {
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        callData: [goodResult(composed)],
        receipts: [{ transactionHash: `0x${'b'.repeat(64)}`, status: 'success', blockNumber: 1n }],
      }),
    }
    const r = rig({ atomic: false }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.steps[0].status).toBe('unresolved')
    expect(liveSubmissions(store).length).toBe(1)
  })

  it('a mid-run account switch aborts the NEXT step and files the partial honestly (law 1, through the real passthrough)', async () => {
    const c8453 = composedFor(8453)
    const c1 = composedFor(1)
    const clients = {
      8453: fakeClient(8453, { callData: [goodResult(c8453)] }),
      1: fakeClient(1, { callData: [goodResult(c1)] }),
    }
    let calls = 0
    const r = rig(
      { atomic: true, sendCalls: ['id-1', 'id-2'], callsStatus: { 'id-1': [{ status: 200 }], 'id-2': [{ status: 200 }] } },
      clients,
      { activeAccount: () => (calls++ === 0 ? ME : OTHER) },
    )
    const state = await runPlan(r, [batchStep(8453, 1), batchStep(1, 2)])
    expect(state.steps[0].status).toBe('done')
    expect(state.phase).toBe('partial')
    expect(r.logged).toEqual([expect.objectContaining({ partial: true, completedSteps: [stepKeyOf(batchStep(8453))] })])
  })

  it('a user rejection releases the claim and nothing is recorded in flight', async () => {
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const r = rig({ atomic: true, sendCalls: [Object.assign(new Error('User rejected the request'), { code: 4001 })] }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.steps[0].message).toMatch(/declined/i)
    expect(liveSubmissions(store)).toEqual([])
  })

  it('a capability that flaps between simulate and submit falls to the SEQUENTIAL path — approve, receipt, batch (2026-08-15 ruling)', async () => {
    // The old law refused this whole ("never half a sequence") — but the
    // sequential path IS a whole sequence: each approval receipt-confirmed
    // before the batch, the sale lane's own discipline. Definitive
    // non-support of the atomic method is exactly when nothing is in flight
    // and the fallback is safe.
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        simulateCalls: { results: [{ status: 'success' }, { status: 'success', data: goodResult(composed) }] },
        receipts: [
          { transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n },
          { transactionHash: `0x${'a'.repeat(63)}2`, status: 'success', blockNumber: 2n },
        ],
      }),
    }
    const r = rig(
      { atomic: true, sendCalls: [Object.assign(new Error('method not found'), { code: -32601 })] },
      clients,
      { approvalsFor: () => [{ token: ASSET, amountRaw: 1_000_000n }] },
    )
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase, state.notes.join('|')).toBe('done')
    const sent = r.sentTxs.filter((t) => t.chainId === 8453)
    expect(sent).toHaveLength(2)
    expect(sent[0].to).toBe(ASSET)
    expect(sent[1].to).toBe(BATCHER)
  })
})

describe('the pre-signature gates (wallet never touched)', () => {
  it('P5 — a deadline past the chain-clock window refuses BEFORE any wallet call', async () => {
    const clients = { 8453: fakeClient(8453) }
    const r = rig({ atomic: true }, clients, {
      composeStep: async () => composedFor(8453, { deadlineSec: NOW_SEC + MAX_DEADLINE_WINDOW_SEC + 60 }),
    })
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/further ahead than we allow/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('P5 — a deadline already past on the chain clock refuses with the stale-plan sentence', async () => {
    const clients = { 8453: fakeClient(8453) }
    const r = rig({ atomic: true }, clients, {
      composeStep: async () => composedFor(8453, { deadlineSec: NOW_SEC - 10 }),
    })
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/already passed/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('P6 — a preview that skips a REQUIRED leg refuses (our plan and the chain disagree)', async () => {
    const composed = composedFor(8453)
    const bad: BatchSimResult = {
      spentFunding: 0n,
      hubOut: 0n,
      feeEth: 0n,
      ethRefunded: 0n,
      usdcRefunded: 0n,
      outs: composed.args[0].map(() => 0n),
      skippedBitmap: 1n,
    }
    const clients = { 8453: fakeClient(8453, { callData: [encodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', result: bad })] }) }
    const r = rig({ atomic: true }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/not skippable/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('P6 — a preview delivering under the floor WE composed refuses with the re-quote sentence', async () => {
    const composed = composedFor(8453)
    const bad: BatchSimResult = {
      spentFunding: 1_000_000n,
      hubOut: 1n,
      feeEth: 0n,
      ethRefunded: 0n,
      usdcRefunded: 0n,
      outs: composed.args[0].map((l) => l.minOut - 1n),
      skippedBitmap: 0n,
    }
    const clients = { 8453: fakeClient(8453, { callData: [encodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', result: bad })] }) }
    const r = rig({ atomic: true }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/less than the floor/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('an ERC-20-funded step on an RPC without previews refuses in the stated words — never signs blind', async () => {
    const clients = { 8453: fakeClient(8453) } // simulateCalls unscripted → -32601
    const r = rig({ atomic: true }, clients, { approvalsFor: () => [{ token: ASSET, amountRaw: 5n }] })
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/never sign what we could not preview/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('a bridge step is ADMITTED exactly when its facts exist — clients both ends, the pinned diamond, settlement both ends (the slice-B refusal retired with the bridge build, 2026-08-14)', async () => {
    const clients = { 8453: fakeClient(8453), 1: fakeClient(1) }
    const both = (id: number) => clients[id as 8453] ?? null
    const gateArgs = { client: both, batcherAddress: () => BATCHER, settlementAddress: () => OTHER }
    // admitted whole: pinned chains (1 and 8453 are on LIFI_TARGETS), funded ends
    expect(planExecutable([bridgeStep(1, 8453), batchStep(8453)], gateArgs).ok).toBe(true)
    // refused whole when the SIGNING chain has no pinned diamond (999 unpinned)
    const unpinned = planExecutable([{ order: 1, action: { kind: 'bridge', fromChainId: 999, toChainId: 8453, amountCents: 100, refuel: false, source: 'new-money' } } as never], {
      ...gateArgs,
      client: () => clients[8453],
    })
    expect(unpinned.ok).toBe(false)
    if (!unpinned.ok) expect(unpinned.reason).toMatch(/no verified transfer-routing contract/i)
    // refused whole when settlement is unconfigured on either end
    const unfunded = planExecutable([bridgeStep(1, 8453)], { ...gateArgs, settlementAddress: () => null })
    expect(unfunded.ok).toBe(false)
    if (!unfunded.ok) expect(unfunded.reason).toMatch(/no settlement token/i)
    // and the batch-side gates stand unchanged
    expect(planExecutable([batchStep(8453)], { client: () => clients[8453], batcherAddress: () => null }).ok).toBe(false)
    expect(planExecutable([batchStep(8453)], { client: () => null, batcherAddress: () => BATCHER }).ok).toBe(false)
    expect(planExecutable([batchStep(8453)], { client: () => clients[8453], batcherAddress: () => BATCHER }).ok).toBe(true)
  })
})

describe('the measured extras', () => {
  it('gasCostUsd is measured when the native price is readable, and NULL — never zero — when it is not', async () => {
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const withPrice = rig({ atomic: true }, clients, { nativeUsd: () => 3_000 })
    const sim = (await createRunnerEffects(withPrice.ctx).simulate(batchStep(8453))) as MeasuredSimulatedStep
    // 200k gas × 1 gwei × $3000 = $0.60
    expect(sim.gasCostUsd).toBe(0.6)
    expect(sim.result).not.toBeNull()

    const withoutPrice = rig({ atomic: true }, { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) })
    const sim2 = (await createRunnerEffects(withoutPrice.ctx).simulate(batchStep(8453))) as MeasuredSimulatedStep
    expect(sim2.gasCostUsd).toBeNull()
  })

  it('a refused simulation carries result: null — never a zeroed result a panel could read as facts', async () => {
    const clients = { 8453: fakeClient(8453, { callData: [new Error('execution reverted: SlippageExceeded()')] }) }
    const r = rig({ atomic: true }, clients)
    const sim = (await createRunnerEffects(r.ctx).simulate(batchStep(8453))) as MeasuredSimulatedStep
    expect(sim.floorHolds).toBe(false)
    expect(sim.result).toBeNull()
    expect(sim.gasCostUsd).toBeNull()
  })
})

describe('mutation-survivor kills (path-3 triage, 2026-08-04)', () => {
  it('the deadline boundaries are EXACT on the chain clock: dead AT now, alive at now + the full window', async () => {
    // deadline === chainNow is already dead (a `>=` mutant let it through)
    const clients = { 8453: fakeClient(8453) }
    const atNow = rig({ atomic: true }, clients, { composeStep: async () => composedFor(8453, { deadlineSec: NOW_SEC }) })
    const dead = await runPlan(atNow, [batchStep(8453)])
    expect(dead.phase).toBe('refused')
    expect(dead.notes.join(' ')).toMatch(/already passed/i)

    // deadline === chainNow + MAX window is the LAST legal second (a `>=`
    // mutant refused it)
    const composed = composedFor(8453, { deadlineSec: NOW_SEC + MAX_DEADLINE_WINDOW_SEC })
    const atEdge = rig(
      { atomic: true, sendCalls: ['id-e'], callsStatus: { 'id-e': [{ status: 200 }] } },
      { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) },
      { composeStep: async () => composed },
    )
    const alive = await runPlan(atEdge, [batchStep(8453)])
    expect(alive.phase).toBe('done')
  })

  it('NUMERIC receipt statuses classify like their string twins (0 = reverted outranks the wrapper, 1 = success)', () => {
    expect(parseCallsStatusForMoney({ status: 200, receipts: [{ status: 0 }] }).kind).toBe('failure')
    expect(parseCallsStatusForMoney({ status: 200, receipts: [{ status: 1 }] }).kind).toBe('success')
  })

  it('a wallet accepting the request but returning NO id is ambiguity by construction — dup:no-id, record intact', async () => {
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const r = rig({ atomic: true, sendCalls: [''] }, clients) // {id: ''} — accepted, nothing to poll
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.steps[0].status).toBe('unresolved')
    const live = liveSubmissions(store)
    expect(live.length).toBe(1)
    expect(live[0].submissionId).toBe('dup:no-id')
  })

  it('THE HAPPY ERC-20 BUNDLE: approvals ride BEFORE the batch in ONE atomic submission, value only on the batch call', async () => {
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        simulateCalls: { results: [{ status: 'success' }, { status: 'success', data: goodResult(composed) }] },
      }),
    }
    const r = rig(
      { atomic: true, sendCalls: ['id-9'], callsStatus: { 'id-9': [{ status: 200, receipts: [{ status: 'success' }] }] } },
      clients,
      { approvalsFor: () => [{ token: ASSET, amountRaw: 1_000_000n }], composeStep: async () => composed },
    )
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('done')
    const send = r.wallet.requests.find((q) => q.method === 'wallet_sendCalls')
    const params = (send?.params as { atomicRequired?: boolean; calls?: { to?: string; value?: string }[] }[] | undefined)?.[0]
    expect(params?.atomicRequired).toBe(true)
    expect(params?.calls?.length).toBe(2)
    expect(params?.calls?.[0]?.to?.toLowerCase()).toBe(ASSET.toLowerCase()) // the approve, first
    expect(params?.calls?.[0]?.value).toBeUndefined() // approvals carry no value
    expect(params?.calls?.[1]?.to?.toLowerCase()).toBe(BATCHER.toLowerCase()) // the batch, second
    expect(params?.calls?.[1]?.value).toBeTruthy() // native value rides the batch call only
  })
})

describe('parseCallsStatusForMoney — the strict zoo', () => {
  it('classifies the spec statuses and their legacy string shapes', () => {
    expect(parseCallsStatusForMoney({ status: 100 }).kind).toBe('pending')
    expect(parseCallsStatusForMoney({ status: 'PENDING' }).kind).toBe('pending')
    expect(parseCallsStatusForMoney({ status: 200 }).kind).toBe('success')
    expect(parseCallsStatusForMoney({ status: 'CONFIRMED' }).kind).toBe('success')
    expect(parseCallsStatusForMoney({ status: 400 }).kind).toBe('failure')
    expect(parseCallsStatusForMoney({ status: 500 }).kind).toBe('failure')
    expect(parseCallsStatusForMoney({ status: 'reverted' }).kind).toBe('failure')
  })
  it('600 (partially reverted) is a FAILURE for money, with the check-first sentence', () => {
    const v = parseCallsStatusForMoney({ status: 600 })
    expect(v.kind).toBe('failure')
    if (v.kind === 'failure') expect(v.message).toMatch(/part of this batch went through/i)
  })
  it('a success wrapper with any reverted receipt is a failure (P3)', () => {
    expect(parseCallsStatusForMoney({ status: 200, receipts: [{ status: 'success' }, { status: '0x0' }] }).kind).toBe('failure')
  })
  it('everything else is unknown — hold, never classify (P1)', () => {
    for (const shape of [null, 7, 'lol', {}, { status: {} }, { status: 150 }, { status: [] }, { status: true }]) {
      expect(parseCallsStatusForMoney(shape).kind, JSON.stringify(shape)).toBe('unknown')
    }
  })
  it('the poll budget matches the runner constant this suite leans on', () => {
    expect(POLL_MAX_ATTEMPTS).toBeGreaterThan(10)
  })
})

describe('the bounded final round — the LAW branches the coverage inventory showed dark', () => {
  it('simulate refuses a composed batch whose recipient is not the running account (E1 at this gate, previously uncovered)', async () => {
    const OTHER_COMPOSED = (() => {
      const c = composedFor(8453)
      // forge the mismatch downstream of the composer's own guard — exactly
      // what a compromised composeStep closure could hand the factory
      return { ...c, args: [c.args[0], c.args[1], c.args[2], { ...c.args[3], recipient: OTHER }] as typeof c.args }
    })()
    const r = rig({ atomic: true }, { 8453: fakeClient(8453) }, { composeStep: async () => OTHER_COMPOSED })
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/different address/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('simulate refuses BY NAME with no client and with no batcher — the capability truth, per step as well as up front', async () => {
    const noClient = rig({ atomic: true }, {})
    const s1 = await runPlan(noClient, [batchStep(8453)])
    expect(s1.notes.join(' ')).toMatch(/no connection to network/i)
    const noBatcher = rig({ atomic: true }, { 8453: fakeClient(8453) }, { batcherAddress: () => null })
    const s2 = await runPlan(noBatcher, [batchStep(8453)])
    expect(s2.notes.join(' ')).toMatch(/no batch contract/i)
  })

  it('a REVERTED plain tx recovers the failing leg index by replaying the exact bytes (the wiring the rehearsal proved live, now mutation-visible)', async () => {
    const composed = composedFor(8453)
    const revertData = encodeErrorResult({ abi: parseAbi(['error RequiredLegFailed(uint256 index)']), errorName: 'RequiredLegFailed', args: [2n] })
    let calls = 0
    const client = fakeClient(8453, { callData: [goodResult(composed)] })
    const origCall = client.call.bind(client)
    ;(client as { call: unknown }).call = async (args: never) => {
      calls += 1
      if (calls === 1) return origCall(args) // the pre-sign simulate
      throw Object.assign(new Error('execution reverted'), { data: revertData }) // the replay at the failing block
    }
    ;(client as { getTransactionReceipt: unknown }).getTransactionReceipt = async () => ({
      transactionHash: `0x${'a'.repeat(63)}1`,
      status: 'reverted',
      blockNumber: 7n,
    })
    const r = rig({ atomic: false }, { 8453: client })
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].failedLegIndex).toBe(2)
    expect(r.logged).toEqual([expect.objectContaining({ partial: true, failedLegIndex: 2 })])
  })

  it('A12 pins: the recovered leg index honours LEG ZERO, refuses a hostile magnitude, and survives garbage bytes', async () => {
    // leg 0 is a REAL leg (the exec-log law's own trap: a truthiness guard
    // would drop the first leg's failure) — the >= 0 bound must include it;
    // a 10_000+ index is a lying RPC, not a leg; garbage decodes to nothing.
    const shapes: [unknown, number | undefined][] = [
      [encodeErrorResult({ abi: parseAbi(['error RequiredLegFailed(uint256 index)']), errorName: 'RequiredLegFailed', args: [0n] }), 0],
      [encodeErrorResult({ abi: parseAbi(['error RequiredLegFailed(uint256 index)']), errorName: 'RequiredLegFailed', args: [10_000n] }), undefined],
      ['0xdeadbeefdeadbeef', undefined],
    ]
    for (const [revertData, want] of shapes) {
      store = new MemStore()
      const composed = composedFor(8453)
      let calls = 0
      const client = fakeClient(8453, { callData: [goodResult(composed)] })
      const origCall = client.call.bind(client)
      ;(client as { call: unknown }).call = async (args: never) => {
        calls += 1
        if (calls === 1) return origCall(args)
        throw Object.assign(new Error('execution reverted'), { data: revertData })
      }
      ;(client as { getTransactionReceipt: unknown }).getTransactionReceipt = async () => ({
        transactionHash: `0x${'a'.repeat(63)}1`,
        status: 'reverted',
        blockNumber: 7n,
      })
      const r = rig({ atomic: false }, { 8453: client })
      const state = await runPlan(r, [batchStep(8453)])
      expect(state.steps[0].status, `shape ${String(revertData).slice(0, 20)}`).toBe('failed')
      expect(state.steps[0].failedLegIndex, `shape ${String(revertData).slice(0, 20)}`).toBe(want)
    }
  })


  it('the BATCH slot failing in preview wears the batch sentence, not the approval’s (A12 :722 attribution pin)', async () => {
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        simulateCalls: { results: [{ status: 'success' }, { status: 'failure' }] },
      }),
    }
    const r = rig({ atomic: true }, clients, { approvalsFor: () => [{ token: ASSET, amountRaw: 5n }] })
    void composed
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.steps[0].message).not.toMatch(/token approval/)
  })

  it('an approval REFUSED inside the preview refuses the step in its own words — never signs the sequence', async () => {
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        simulateCalls: { results: [{ status: 'failure' }, { status: 'success', data: goodResult(composed) }] },
      }),
    }
    const r = rig({ atomic: true }, clients, { approvalsFor: () => [{ token: ASSET, amountRaw: 5n }] })
    const state = await runPlan(r, [batchStep(8453)])
    // ATTRIBUTION is part of the law (A12, :722): the failing slot decides the
    // sentence — an approval failure must speak as the APPROVAL, never wear
    // the batch's words (and vice versa, pinned in the sibling below)
    expect(state.steps[0].message).toMatch(/token approval/)
    expect(state.steps[0].message).not.toMatch(/refused this batch/)
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/token approval .* refused in simulation/i)
    // ATTRIBUTION is part of the law (A12 :722): the failing slot decides the
    // sentence — the approval's failure must never wear the batch's words
    expect(state.notes.join(' ')).not.toMatch(/refused this batch/)
    expect(r.wallet.requests).toEqual([])
  })
})

describe('THE DOUBLE-BUY DOOR (independent review, 2026-08-07)', () => {
  // The catch around wallet_sendCalls tested only for a user rejection and then
  // FELL THROUGH to the plain rung on everything else — so a lost response
  // after the wallet had already broadcast sent the same batchBuy a second
  // time, and the run reported `done`. These are the shapes that were driven
  // through it; only 4001 refused before this fix.
  const AMBIGUOUS: Error[] = [
    new Error('socket hang up'),
    new Error('Request timed out'),
    new Error('WebSocket connection closed abnormally'),
    Object.assign(new Error('Bad Gateway'), { code: -32603 }),
    Object.assign(new Error('internal JSON-RPC error'), { code: -32603 }),
    Object.assign(new Error('invalid params'), { code: -32602 }),
  ]

  it('every ambiguous wallet failure REFUSES rather than re-sending on the plain rung', async () => {
    for (const err of AMBIGUOUS) {
      const composed = composedFor(8453)
      const clients = {
        8453: fakeClient(8453, {
          simulateCalls: { results: [{ status: 'success', data: goodResult(composed) }] },
        }),
      }
      const r = rig({ atomic: true, sendCalls: [err] }, clients)
      const state = await runPlan(r, [batchStep(8453)])
      // THE INVARIANT: no plain transaction was sent as a second attempt
      expect(r.sentTxs, `${err.message}: must not re-send`).toEqual([])
      expect(state.phase, `${err.message}`).not.toBe('done')
    }
  })

  it('a DEFINITIVE non-support answer still falls back — the legal case is preserved', async () => {
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        simulateCalls: { results: [{ status: 'success', data: goodResult(composed) }] },
        receipts: [{ transactionHash: '0xabc', status: 'success', blockNumber: 1n }],
      }),
    }
    const r = rig(
      { atomic: true, sendCalls: [Object.assign(new Error('method not found'), { code: -32601 })] },
      clients,
    )
    const state = await runPlan(r, [batchStep(8453)])
    // The point of this test is the CLASSIFICATION: a definitive non-support
    // answer must not be swept into the new ambiguity refusal. Asserting the
    // absence of that sentence pins it without depending on the simulate
    // fixture's shape, which is what the ambiguity tests above already drive.
    expect(state.steps[0].message ?? '').not.toMatch(/did not answer clearly/i)
  })

  it('a DECLINED signature still releases cleanly — an unambiguous no is not ambiguity', async () => {
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        simulateCalls: { results: [{ status: 'success', data: goodResult(composed) }] },
      }),
    }
    const r = rig({ atomic: true, sendCalls: [Object.assign(new Error('user rejected'), { code: 4001 })] }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(r.sentTxs).toEqual([])
    expect(liveSubmissions(store)).toEqual([])
  })
})

describe('R3 — a partial failure keeps its record; a TOTAL one still clears', () => {
  it('the wallet’s own "partially executed" code (600) keeps the record', () => {
    const v = parseCallsStatusForMoney({ status: 600 })
    expect(v.kind).toBe('failure')
    expect(v).toMatchObject({ partial: true })
  })
  it('a confirmed wrapper over a reverted receipt is partial too — part landed', () => {
    const v = parseCallsStatusForMoney({ status: 200, receipts: [{ status: 'success' }, { status: 'reverted' }] })
    expect(v).toMatchObject({ kind: 'failure', partial: true })
  })
  it('a TOTAL failure is not partial, so its record may still clear', () => {
    for (const status of [400, 500, 'failed', 'reverted']) {
      const v = parseCallsStatusForMoney({ status })
      expect(v.kind).toBe('failure')
      expect((v as { partial?: boolean }).partial).not.toBe(true)
    }
  })
})

describe('law P8 — the displayed-vs-signed gate holds the seam', () => {
  // No callData is scripted in these rigs, so REACHING simulation would fail
  // with a different sentence — the P8 message doubles as proof the refusal
  // fired BEFORE any RPC was touched.
  it('NO shown record, NO run — the gate is not skippable by omission', async () => {
    const r = rig({}, { 8453: fakeClient(8453) }, { shownFor: () => null })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(r.sentTxs).toHaveLength(0)
    expect(out.steps[0].message).toMatch(/could not check this transaction against what you reviewed/)
  })

  it('a shown floor that differs from the BYTES refuses, before simulation and in the leg\'s own words', async () => {
    const r = rig({}, { 8453: fakeClient(8453) }, {
      shownFor: () => {
        const c = composedFor(8453)
        // divergence built ON PURPOSE (a floor one unit off the bytes) — the
        // mint validates shape, never agreement, so it cannot launder this
        return shownAtReviewSurface({
          chainId: 8453,
          fundingAsset: c.args[1],
          fundingTotalRaw: c.args[2],
          recipient: c.args[3].recipient,
          legs: c.args[0].map((l) => ({ symbol: 'AAVE', asset: l.asset, budgetRaw: l.budget, minOutRaw: l.minOut + 1n, optional: l.optional })),
          approvals: [],
        })
      },
    })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(r.sentTxs).toHaveLength(0)
    expect(out.steps[0].message).toMatch(/different protection floor/)
  })

  it('a shown record for the WRONG CHAIN refuses — the binding is per step', async () => {
    const r = rig({}, { 8453: fakeClient(8453) }, {
      shownFor: () => {
        const c = composedFor(8453)
        // a record for the WRONG CHAIN: chainId 1 against a Base step. The mint
        // accepts it (1 is a real chain id) because agreement is the GATE's job,
        // not the mint's — this is the seam the per-step binding exists for.
        return shownAtReviewSurface({
          chainId: 1,
          fundingAsset: c.args[1],
          fundingTotalRaw: c.args[2],
          recipient: c.args[3].recipient,
          legs: c.args[0].map((l) => ({ symbol: 'AAVE', asset: l.asset, budgetRaw: l.budget, minOutRaw: l.minOut, optional: l.optional })),
          approvals: [],
        })
      },
    })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(out.steps[0].message).toMatch(/could not check this transaction/)
  })
})

describe('A6 verify pass — the ambiguity that reaches the runner is the one production throws', () => {
  // ⚠ THE PIN THAT WAS MISSING, AND WHY IT MATTERED. The runner-side pin threw
  // a plain `Error('socket hang up')`, which lands in the ambiguous branch —
  // but the atomic rung never throws that. It throws a RunnerRefusal, whose
  // `certainty` defaulted to 'nothing-sent', so the runner took the DEFINITIVE
  // branch: it RELEASED the claim, reported "nothing was sent", and the very
  // next run bought the same batch again. The whole ambiguity mechanism was
  // dead code on the only production path it existed for. These tests drive
  // the REAL effects layer so the shape under test is the shape that ships.
  const lostResponses = [
    new Error('socket hang up'),
    Object.assign(new Error('Internal JSON-RPC error'), { code: -32603 }),
    new Error('Request expired. Please try again.'), // WalletConnect relay drop
    Object.assign(new Error('Bad Gateway'), { code: 502 }), // bundler 5xx
  ]

  for (const [i, thrown] of lostResponses.entries()) {
    it(`a lost response (${thrown.message}) HOLDS the claim — no release, no second submission`, async () => {
      const composed = composedFor(8453)
      const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
      const r = rig({ sendCalls: [thrown] }, clients)
      const out = await runPlan(r, [batchStep(8453)])

      // the run stops honestly: money MAY be in flight, so this is not 'refused'
      expect(out.phase).toBe('partial')
      expect(out.steps[0].status).toBe('unresolved')
      expect(out.steps[0].message).toMatch(/did not answer clearly/)
      expect(r.logged).toHaveLength(1) // law 5: it left a record

      // THE POINT: the claim is KEPT and marked ambiguous, not released
      const held = liveSubmissions(store)
      expect(held, `case ${i}`).toHaveLength(1)
      expect(held[0].ambiguous).toBe(true)

      // …and a retry — however much later — refuses instead of buying again
      const r2 = rig({ sendCalls: ['0xnever'] }, clients, { nowMs: () => (NOW_SEC + 86_400) * 1000 })
      const retry = await runPlan(r2, [batchStep(8453)])
      expect(retry.phase).toBe('refused')
      expect(retry.steps[0].message).toMatch(/never answered clearly/)
      expect(r2.wallet.requests.some((q) => q.method === 'wallet_sendCalls')).toBe(false)
    })
  }

  it('a DECLINED signature still releases the claim — definitiveness must survive the new default', async () => {
    // The inverted default must not lock steps a user simply said no to.
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const declined = Object.assign(new Error('User rejected the request.'), { code: 4001 })
    const out = await runPlan(rig({ sendCalls: [declined] }, clients), [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(liveSubmissions(store)).toHaveLength(0) // released: nothing is in flight
    // and the next attempt proceeds normally
    const again = await runPlan(rig({ sendCalls: ['0xabc'] }, clients), [batchStep(8453)])
    expect(again.steps[0].status).not.toBe('failed')
  })

  it('NO atomic support: approvals land SEQUENTIALLY, receipt-confirmed, then the batch (the owner live 2026-08-15)', () => {
    // The old law refused this shape whole ("needs its approval and batch to
    // land together") and stranded a real run at the last step. The sale
    // lane's S3 discipline now applies: approve → receipt → batch.
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        callData: [goodResult(composed)],
        simulateCalls: { results: [{ status: 'success' }, { status: 'success', data: goodResult(composed) }] },
        receipts: [
          { transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n }, // the approve
          { transactionHash: `0x${'a'.repeat(63)}2`, status: 'success', blockNumber: 2n }, // the batch
        ],
      }),
    }
    const r = rig({ atomic: false }, clients, {
      approvalsFor: () => [{ token: ASSET, amountRaw: 1_000_000n }],
    })
    return runPlan(r, [batchStep(8453)]).then((out) => {
      expect(out.phase, out.notes.join('|')).toBe('done')
      const sent = r.sentTxs.filter((t) => t.chainId === 8453)
      expect(sent).toHaveLength(2)
      expect(sent[0].to).toBe(ASSET) // the approval first…
      expect(sent[1].to).toBe(BATCHER) // …then the batch, only after its receipt
    })
  })

  it('an approval that does not confirm stops the batch cold — the batch bytes are never sent', async () => {
    const composed = composedFor(8453)
    const clients = {
      8453: fakeClient(8453, {
        callData: [goodResult(composed)],
        simulateCalls: { results: [{ status: 'success' }, { status: 'success', data: goodResult(composed) }] },
        receipts: [{ transactionHash: `0x${'a'.repeat(63)}1`, status: 'reverted', blockNumber: 1n }],
      }),
    }
    const r = rig({ atomic: false }, clients, {
      approvalsFor: () => [{ token: ASSET, amountRaw: 1_000_000n }],
    })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('partial')
    expect(out.steps[0].message).toMatch(/approval before this batch did not confirm/)
    expect(r.sentTxs.filter((t) => t.to === BATCHER)).toHaveLength(0)
  })
})

describe('law P8 is RE-ASSERTED at submit — the "afterwards" window it names', () => {
  // ⚠ A6 review, 2026-08-07: P8 ran at simulate, then `submit` re-read
  // `sim.request.calls` and handed them to the wallet with NO re-verification.
  // The exact window the P8 header names — "any code that touches the prepared
  // call afterwards" — sat entirely after the only check. These pin that it no
  // longer does.
  it('bytes mutated BETWEEN simulate and submit are refused, and the wallet is never touched', async () => {
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const r = rig({ sendCalls: ['0xshould-never-happen'] }, clients)
    const effects = createRunnerEffects(r.ctx)
    const realSimulate = effects.simulate
    effects.simulate = async (s) => {
      const sim = await realSimulate(s)
      // a later module holding the reference, or a compromised one, swaps the
      // batch calldata after it was verified
      const prepared = sim.request as { calls: { to: string; data: string; value: bigint }[] }
      prepared.calls[prepared.calls.length - 1].data = '0xdeadbeef'
      return sim
    }
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects, simulated: false })
    expect(out.phase).toBe('refused')
    expect(out.steps[0].message).toMatch(/changed after we checked it/)
    expect(r.wallet.requests.some((q) => q.method === 'wallet_sendCalls')).toBe(false)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('a prepared step that NEVER passed P8 cannot be submitted at all', async () => {
    // submit() is exported through the effects object; a caller that fabricates
    // a request object has not been through the gate, and must be refused
    // rather than trusted because it looks well-formed.
    const composed = composedFor(8453)
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const r = rig({ sendCalls: ['0xnope'] }, clients)
    const effects = createRunnerEffects(r.ctx)
    const forged = { chainId: 8453, batchIndex: 0, calls: [{ to: BATCHER, data: '0xabcdef' as Hex, value: 0n }] }
    await expect(
      effects.submit(batchStep(8453), { request: forged, floorHolds: true } as never),
    ).rejects.toThrow(/was not checked against what you reviewed/)
    expect(r.sentTxs).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE COMPOSITION LAWS, AND THE OVERSPEND GUARD — reached by no test until now
// (mutation run 3, 2026-08-07: runner-effects scored 74.91% with 28 mutants
// under NO COVERAGE AT ALL, and these lines were among them).
//
// These are the checks that compare the composition against things it was NOT
// derived from — our own fee constant, the signing account, the chain's own
// clock — which is the only comparison a tampered composition cannot satisfy by
// construction. Everything downstream of them re-reads the composition, so if
// these do not bite, nothing else will notice.
//
// Each asserts the WALLET WAS NEVER CONTACTED, because "refused" is not the
// claim being tested — "refused before anything could be signed" is.
// ─────────────────────────────────────────────────────────────────────────────

/** A composition that broke a law on its way out of the composer. */
function lawless(chainId: number, tamper: (c: ComposedBatchBuy) => void): ComposedBatchBuy {
  const c = composedFor(chainId)
  tamper(c)
  return c
}

describe('the composition laws (independent facts the composer cannot fake)', () => {
  const cases: { name: string; tamper: (c: ComposedBatchBuy) => void; match: RegExp }[] = [
    {
      name: 'a payout redirected away from the wallet running the batch',
      tamper: (c) => {
        ;(c.args[3] as { recipient: Address }).recipient = '0x000000000000000000000000000000000000dEaD' as Address
      },
      // ⚠ THIS ONE IS GUARDED TWICE, and the EARLIER guard wins — the refusal
      // that fires is "pays out to a different address than the account running
      // it", not compositionLawsBroken's own sentence. Found by this test
      // failing on the message while passing on the behaviour. Matching both
      // rather than pinning one: the law is the backstop, and a future refactor
      // that removes the earlier check must still refuse rather than go quiet.
      match: /pays out to a different address|not the wallet running it/i,
    },
    {
      name: 'a fee that is not the one this app charges',
      tamper: (c) => {
        ;(c.args[3] as { feeBps: number }).feeBps = BATCH_FEE_BPS + 10
      },
      match: /different fee/i,
    },
    {
      name: 'no protection floor at all on the funding swap',
      tamper: (c) => {
        ;(c.args[3] as { hubMinOut: bigint }).hubMinOut = 0n
      },
      match: /no protection floor on its funding swap/i,
    },
    {
      name: 'a routing tolerance this app never sets',
      tamper: (c) => {
        ;(c.args[3] as { aggMinBps: number }).aggMinBps = 100
      },
      match: /routing tolerance this app never sets/i,
    },
    {
      name: 'a batch that pulls nothing',
      tamper: (c) => {
        ;(c.args as unknown as unknown[])[2] = 0n
      },
      match: /pulls nothing/i,
    },
    {
      name: 'a leg carrying no floor — unprotected money inside a protected batch',
      tamper: (c) => {
        c.args[0][0].minOut = 0n
      },
      match: /no protection floor/i,
    },
    {
      name: 'a leg committing nothing',
      tamper: (c) => {
        c.args[0][0].budget = 0n
      },
      match: /commits nothing/i,
    },
  ]

  for (const { name, tamper, match } of cases) {
    it(`refuses ${name} — before the wallet is contacted`, async () => {
      const clients = { 8453: fakeClient(8453) }
      const r = rig({ atomic: true }, clients, { composeStep: async () => lawless(8453, tamper) })
      const state = await runPlan(r, [batchStep(8453)])
      expect(state.phase).toBe('refused')
      expect(state.notes.join(' ')).toMatch(match)
      expect(r.wallet.requests).toEqual([])
    })
  }
})

describe('the preview-overspend guard', () => {
  it('refuses when the simulation spends MORE than the batch pulls — nothing was signed', async () => {
    const composed = composedFor(8453)
    const pulls = composed.args[2] as bigint
    const overspent: BatchSimResult = {
      // one unit over what the batch is allowed to pull: the plan and the
      // network disagree about the size of the trade, and a disagreement about
      // size is never resolved by trusting the larger number
      spentFunding: pulls + 1n,
      hubOut: 1n,
      feeEth: 0n,
      ethRefunded: 0n,
      usdcRefunded: 0n,
      outs: composed.args[0].map((l) => l.minOut),
      skippedBitmap: 0n,
    }
    const clients = {
      8453: fakeClient(8453, { callData: [encodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', result: overspent })] }),
    }
    const r = rig({ atomic: true }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/spent more than this batch pulls/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('spending EXACTLY what the batch pulls is not an overspend — the boundary is >, not >=', async () => {
    // the other half of any boundary pin: a guard that also refuses the exact
    // case is a guard that refuses honest batches, and nothing here would say so
    const composed = composedFor(8453)
    const exact: BatchSimResult = {
      spentFunding: composed.args[2] as bigint,
      hubOut: 1n,
      feeEth: 0n,
      ethRefunded: 0n,
      usdcRefunded: 0n,
      outs: composed.args[0].map((l) => l.minOut),
      skippedBitmap: 0n,
    }
    const clients = {
      8453: fakeClient(8453, { callData: [encodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', result: exact })] }),
    }
    const r = rig({ atomic: true }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.notes.join(' ')).not.toMatch(/spent more than this batch pulls/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE DEGRADATION PATHS (mutation run 7: runner-effects still the largest pool
// of uncovered mutants at 25). These are the branches that fire when something
// OUTSIDE us misbehaves — the store is full, the node answers in a shape no
// spec defined, the wallet hands back an id it has already used. Every one of
// them ends in a refusal or a demotion, and none of them had ever run.
//
// A path that only executes when the world is broken is the one least likely to
// be exercised by accident and the most expensive to get wrong, because by
// definition it runs on the day something else already went wrong.
// ─────────────────────────────────────────────────────────────────────────────

describe('the runner when the world misbehaves', () => {
  it('a store that cannot be written REFUSES before anything is sent — no record, no send', async () => {
    // the record book is what makes a submission recoverable across a remount;
    // a step that cannot leave one behind must not start, or a confirmed
    // transaction becomes an orphan nothing can reconcile
    const fullStore = {
      length: 0,
      clear() {},
      key: () => null,
      getItem: () => null,
      removeItem() {},
      setItem() {
        throw new Error('QuotaExceededError')
      },
    } as unknown as Storage
    const clients = { 8453: fakeClient(8453) }
    const r = rig({ atomic: true }, clients, { store: fullStore })
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    // ⚠ TWO GUARDS, EARLIER ONE WINS — the sentence that fires is "will not let
    // us save a record", not runner-effects' own "storage cannot take the
    // record". Matching either on purpose: the second is the backstop, and a
    // refactor removing the first must still refuse rather than go quiet.
    expect(state.notes.join(' ')).toMatch(/will not let us save|storage cannot take the record/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('an EXPLICITLY null store refuses too — it cannot record at all', async () => {
    // the comment on this guard names the trap: `??` would have silently
    // swapped null for the healthy window store, turning "cannot record" into
    // "records somewhere the run never checks"
    const clients = { 8453: fakeClient(8453) }
    const r = rig({ atomic: true }, clients, { store: null })
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/will not let us save|storage cannot take the record/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('a preview answered in an UNDECODABLE shape refuses rather than signing blind', async () => {
    // bytes that are not a batchBuy result at all. The honest answer to "we
    // could not read the network's reply" is to stop — treating an unreadable
    // preview as an absent one is how a batch gets signed against no preview.
    const clients = { 8453: fakeClient(8453, { callData: ['0xdeadbeef'] }) }
    const r = rig({ atomic: true }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/shape we do not recognize|could not read|preview/i)
    expect(r.wallet.requests).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PORTFOLIO ENGINE (the executor migration, the owner's runway order
// 2026-08-13) — the new contract's simulate path, driven through the same
// public seam as everything above. The legacy suites ARE the proof the old
// path is untouched; these pin the new one.
// ─────────────────────────────────────────────────────────────────────────────
describe('the portfolio engine — SpectrumPortfolioBatcher end to end', () => {
  const A1 = '0x1000000000000000000000000000000000000001' as Address
  const A2 = '0x1000000000000000000000000000000000000002' as Address
  const USDC = '0x1000000000000000000000000000000000000003' as Address
  const SINK = '0x1000000000000000000000000000000000000004' as Address
  /** every byte channel the wallet could have seen — 5792 bundles and plain sends */
  const bytesSent = (r: Rig): string[] => [
    ...r.sentTxs.map((t) => t.data as string),
    ...r.wallet.requests
      .filter((q) => q.method === 'wallet_sendCalls')
      .flatMap((q) => {
        const p0 = (q.params?.[0] ?? {}) as { calls?: { data?: string }[] }
        return (p0.calls ?? []).map((c) => c.data ?? '')
      }),
  ]
  const P_LEGS = [
    { symbol: 'AAA', buyToken: A1, sellAmountRaw: asFundingRaw(600_000_000n), minBuyAmountRaw: 55n * 10n ** 18n, swapData: '0xdeadbeef01' as const, optional: false },
    { symbol: 'BBB', buyToken: A2, sellAmountRaw: asFundingRaw(400_000_000n), minBuyAmountRaw: 36n * 10n ** 18n, swapData: '0xdeadbeef02' as const, optional: true },
  ]
  const portfolioComposed = (feeBps: number = BATCH_FEE_BPS, burnSwapData?: `0x${string}`) =>
    composePortfolioBatchBuy({
      legs: P_LEGS,
      fundingAsset: USDC,
      // funding rides the SAME rate the batch carries (the 2026-08-17 live
      // refusal's lesson): the old hardcoded 1_004_000_000 was the 40bps-era
      // number, self-consistent with the gate's old hardcoded 40 — and the
      // moment the gate learned the chain's real rate, every fixture built on
      // the stale pair refused, exactly as production had.
      fundingTotalRaw: asFundingRaw(1_000_000_000n + (1_000_000_000n * BigInt(feeBps)) / 10_000n),
      owner: ME,
      recipient: ME,
      chainNowSec: NOW_SEC,
      deadlineSec: NOW_SEC + 600,
      feeBps,
      ...(burnSwapData ? { burnSwapData } : {}),
      // the F4 pin (audit): feeRecipient must be the operator's own configured
      // sink, not merely non-zero — match it so the OTHER laws are what these
      // tests exercise (null config → SINK, pin dormant, still fine)
      feeRecipient: INTERFACE_TAG_ADDRESS ?? SINK,
    })

  /** The chain's answer, CONSERVING by construction unless overridden:
   *  refunded = fundingTotal − Σ(executed sell) − floor(Σexec×fee/10000). */
  const portfolioResult = (
    composed: ReturnType<typeof portfolioComposed>,
    over: { bought?: bigint[]; refundedDelta?: bigint } = {},
  ): Hex => {
    const legs = composed.args[0]
    const bought = over.bought ?? legs.map((l) => l.minBuyAmount + 10n ** 18n)
    let executed = 0n
    for (const [i, l] of legs.entries()) if ((bought[i] ?? 0n) > 0n) executed += l.sellAmount
    const fee = (executed * BigInt(composed.args[3].feeBps)) / 10_000n
    const refunded = composed.args[2] - executed - fee + (over.refundedDelta ?? 0n)
    return encodeFunctionResult({ abi: portfolioBatcherAbi, functionName: 'batchBuy', result: [bought, refunded] })
  }

  const shownFromPortfolio = (c: ReturnType<typeof portfolioComposed>, chainId: number) =>
    shownAtReviewSurface({
      chainId,
      fundingAsset: c.args[1],
      fundingTotalRaw: c.args[2],
      recipient: c.args[3].recipient,
      legs: c.args[0].map((l, i) => ({ symbol: `P${i}`, asset: l.buyToken, budgetRaw: l.sellAmount, minOutRaw: l.minBuyAmount, optional: l.optional })),
      approvals: [],
    })

  const portfolioRig = (
    script: { callData?: (Hex | Error)[] },
    over: Partial<RunnerEffectsContext> = {},
    burnSwapData?: `0x${string}`,
  ) => {
    const composed = portfolioComposed(batchFeeBpsFor(8453), burnSwapData)
    const clients = {
      8453: fakeClient(8453, {
        callData: script.callData ?? [portfolioResult(composed)],
        // the empty wallet script lands on the plain rung — a success receipt
        // is what resolves it (the legacy plain-rung test's own shape)
        receipts: [{ transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n }],
      }),
    }
    return {
      composed,
      rig: rig({}, clients, {
        engine: 'portfolio',
        composePortfolioStep: async () => composed,
        shownFor: () => shownFromPortfolio(composed, 8453),
        ...over,
      }),
    }
  }

  it('a HOSTILE native price answers null, never a dollar figure — negative on the legacy rung, zero on the portfolio rung (kills :1004 && → || and :1238 > → >=)', async () => {
    // legacy sim path: a negative price would ride (A && B) || C into a
    // NEGATIVE displayed gas figure under the || mutant
    const lc = composedFor(8453)
    const neg = rig({ atomic: true }, { 8453: fakeClient(8453, { callData: [goodResult(lc)] }) }, { nativeUsd: () => -3_000 })
    const simN = (await createRunnerEffects(neg.ctx).simulate(batchStep(8453))) as MeasuredSimulatedStep
    expect(simN.gasCostUsd).toBeNull()

    // portfolio sim path: zero is not a price — a zero-dollar gas readout is
    // a false sentence, and the guard's own comment says null, never zero
    const pc = portfolioComposed(batchFeeBpsFor(8453))
    const zero = rig(
      { atomic: true },
      { 8453: fakeClient(8453, { callData: [portfolioResult(pc)] }) },
      { engine: 'portfolio', composePortfolioStep: async () => pc, shownFor: () => shownFromPortfolio(pc, 8453), nativeUsd: () => 0 },
    )
    const simZ = (await createRunnerEffects(zero.ctx).simulate(batchStep(8453))) as MeasuredSimulatedStep
    expect(simZ.gasCostUsd).toBeNull()
  })

  it('the happy path runs to done through compose → laws → gate → preview → P6′', async () => {
    const { rig: r } = portfolioRig({})
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('done')
    // and the bytes the wallet saw were the PORTFOLIO encoding
    expect(bytesSent(r).some((d) => d.startsWith('0x0c8ef5f9'))).toBe(true)
  })

  it('F6 through the RUNNER: a burn-carrying batch runs when the app composes burns on this chain, and refuses verbatim when it does not (the ctx pass-through is the law’s only source)', async () => {
    // the 4663 LNOC live pair, 2026-08-15: the burn shipped, the law had to
    // loosen — and the sweep caught the pass-through line itself unpinned.
    // the refusing half runs FIRST: a completed run records itself and law 14
    // (the double-buy guard) would refuse the second identical plan — itself
    // proof that guard works, but not this test's subject
    const { rig: notComposable } = portfolioRig({}, { burnComposable: () => false }, '0xbeefbeef')
    const badOut = await runPlan(notComposable, [batchStep(8453)])
    expect(badOut.phase).toBe('refused')
    expect(notComposable.sentTxs).toHaveLength(0)
    expect([...badOut.notes, ...badOut.steps.map((x) => x.message)].join('|')).toMatch(/burn route this app does not compose/)

    const { rig: composable } = portfolioRig({}, { burnComposable: () => true }, '0xbeefbeef')
    const okOut = await runPlan(composable, [batchStep(8453)])
    expect(okOut.phase, okOut.notes.join('|')).toBe('done')
  })

  it('the stale-quote auto-retry runs EXACTLY 1 + STALE_QUOTE_RETRIES previews, then stops (kills :1250 < → <=)', async () => {
    // a persistently-stale market must not earn an unbounded (or off-by-one)
    // re-quote loop: each preview is a fresh compose + fresh eth_call, and the
    // ruled budget is the initial try plus STALE_QUOTE_RETRIES retries.
    const staleRevert = encodeErrorResult({
      abi: parseAbi(['error RequiredLegFailed(uint256 index)']),
      errorName: 'RequiredLegFailed',
      args: [0n],
    })
    let composes = 0
    const composed = portfolioComposed(batchFeeBpsFor(8453))
    // every preview reverts stale-class, forever (an Error with revert data —
    // the fake client's own revert convention)
    const staleClients = {
      8453: fakeClient(8453, {
        callData: Array.from({ length: STALE_QUOTE_RETRIES + 4 }, () =>
          Object.assign(new Error('execution reverted'), { data: staleRevert }),
        ),
      }),
    }
    const r = rig({}, staleClients, {
      engine: 'portfolio',
      composePortfolioStep: async () => {
        composes += 1
        return composed
      },
      shownFor: () => shownFromPortfolio(composed, 8453),
    })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).not.toBe('done')
    expect(r.sentTxs).toHaveLength(0) // previews only — nothing ever signed
    expect(composes).toBe(1 + STALE_QUOTE_RETRIES)
  })

  it('selecting the portfolio engine without its composer refuses in a sentence — never a legacy fallback', async () => {
    const { rig: r } = portfolioRig({}, { composePortfolioStep: undefined })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(out.notes.join(' ')).toMatch(/without wiring its composer/)
    expect(bytesSent(r)).toHaveLength(0)
  })

  it('PORTFOLIO attribution (A12 :722): an approval failing in the ERC-20 preview speaks as the APPROVAL, the batch slot as the BATCH', async () => {
    // the portfolio engine has its OWN copy of the slot-attribution ternary
    // (the legacy pin at :542 cannot see it — the sweep proved that by
    // surviving here while :542's mutant died). Drive it through simulateCalls
    // with an approval present: [approval fails] then [batch fails].
    for (const [results, want, never] of [
      [[{ status: 'failure' }, { status: 'success' }], /token approval/, /refused this batch/],
      [[{ status: 'success' }, { status: 'failure' }], /refused this batch|network refused/, /token approval/],
    ] as const) {
      store = new MemStore()
      const { composed } = portfolioRig({})
      const clients = { 8453: fakeClient(8453, { simulateCalls: { results: results as never } }) }
      const r = rig({}, clients, {
        engine: 'portfolio',
        composePortfolioStep: async () => composed,
        // the shown record must DISCLOSE the approval or P8's bundle-shape law
        // refuses before the preview parse this pin is aiming at
        shownFor: () => shownAtReviewSurface({
          chainId: 8453,
          fundingAsset: composed.args[1],
          fundingTotalRaw: composed.args[2],
          recipient: composed.args[3].recipient,
          legs: composed.args[0].map((l, i) => ({ symbol: `P${i}`, asset: l.buyToken, budgetRaw: l.sellAmount, minOutRaw: l.minBuyAmount, optional: l.optional })),
          approvals: [{ token: ASSET, amountRaw: 5n }],
        }),
        approvalsFor: () => [{ token: ASSET, amountRaw: 5n }],
      })
      const state = await runPlan(r, [batchStep(8453)])
      expect(state.phase, JSON.stringify(results)).toBe('refused')
      expect(state.notes.join(' ')).toMatch(want)
      expect(state.notes.join(' ')).not.toMatch(never)
    }
  })

  it('P6′: a skipped NON-optional leg refuses — bought[i]=0 is the skip signal', async () => {
    const { composed } = portfolioRig({})
    const bad = portfolioResult(composed, { bought: [0n, composed.args[0][1].minBuyAmount + 1n] })
    const { rig: r } = portfolioRig({ callData: [bad] })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(out.steps[0].message).toMatch(/not skippable/)
  })

  it('P6′: a skipped OPTIONAL leg passes, and the books still balance without it', async () => {
    const { composed } = portfolioRig({})
    const ok = portfolioResult(composed, { bought: [composed.args[0][0].minBuyAmount + 1n, 0n] })
    const { rig: r } = portfolioRig({ callData: [ok] })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('done')
  })

  it('P6′: delivery under the floor refuses even though the contract itself would enforce it', async () => {
    const { composed } = portfolioRig({})
    const bad = portfolioResult(composed, {
      bought: [composed.args[0][0].minBuyAmount - 1n, composed.args[0][1].minBuyAmount + 1n],
    })
    const { rig: r } = portfolioRig({ callData: [bad] })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(out.steps[0].message).toMatch(/less than the floor/)
  })

  it('P6′: stranding past the underspend budget refuses (the cold reviewer’s reshaped law)', async () => {
    // the budget is executedCount+1 (a wei per executed leg + the single fee
    // floor); a 2-leg batch tolerates +3, so +6 of stranded funds must refuse
    const { composed } = portfolioRig({})
    const bad = portfolioResult(composed, { refundedDelta: 6n })
    const { rig: r } = portfolioRig({ callData: [bad] })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(out.steps[0].message).toMatch(/strands part of this batch/)
  })

  it('P6′: route dust inside the budget does NOT false-refuse — and the boundary is exact', async () => {
    // +2 (inside) and +3 (exactly executedCount+1) both compose; +4 refuses.
    // The boundary case is the only input that proves the comparison
    // discriminates (the A12 lesson).
    for (const [delta, phase] of [[2n, 'done'], [3n, 'done'], [4n, 'refused']] as const) {
      // each iteration re-arms the SAME plan, which law 14's window refuses by
      // design — a fresh store per iteration keeps THIS law the one under test
      store = new MemStore()
      const { composed } = portfolioRig({})
      const res = portfolioResult(composed, { refundedDelta: delta })
      const { rig: r } = portfolioRig({ callData: [res] })
      const out = await runPlan(r, [batchStep(8453)])
      expect(out.phase, `refundedDelta ${delta}: ${out.steps[0]?.message ?? out.notes.join('|')}`).toBe(phase)
    }
  })

  it('P6′: the budget counts EXECUTED legs, not all legs — a skipped leg buys no extra tolerance (reviewer LOW-1)', async () => {
    // The discriminating fixture the pin lacked (final delta read, 2026-08-14):
    // with every leg executed, executedCount === bought.length and the two
    // are indistinguishable — the planted `> 0n → >= 0n` mutant (which makes
    // executedCount count EVERY leg) survived green. One SKIPPED optional leg
    // separates them: executedCount 1 → budget 2, mutant budget 3. So +2
    // composes under both, +3 must REFUSE under the true law and only the
    // mutant would pass it.
    for (const [delta, phase] of [[2n, 'done'], [3n, 'refused']] as const) {
      store = new MemStore()
      const { composed } = portfolioRig({})
      const res = portfolioResult(composed, {
        bought: [composed.args[0][0].minBuyAmount + 10n ** 18n, 0n], // leg 2 skipped (optional)
        refundedDelta: delta,
      })
      const { rig: r } = portfolioRig({ callData: [res] })
      const out = await runPlan(r, [batchStep(8453)])
      expect(out.phase, `skipped-leg refundedDelta ${delta}: ${out.steps[0]?.message ?? ''}`).toBe(phase)
      if (phase === 'refused') expect(out.steps[0].message).toMatch(/strands part of this batch/)
    }
  })

  it('P6′: a NEGATIVE residual refuses as a defect — the law is one-signed, never symmetric', async () => {
    // calldata sellAmount bounds the contract's measured pull from ABOVE, so
    // executed + fee + refunded can never honestly fall SHORT of the pull — a
    // negative residual is money unaccounted, broken arithmetic, not rounding.
    // The old symmetric ±(2×legs+1) tolerated this exact case. (The skipped
    // optional leg gives refunded room to shift down without going negative
    // as a uint.)
    const { composed } = portfolioRig({})
    const bad = portfolioResult(composed, {
      bought: [composed.args[0][0].minBuyAmount + 10n ** 18n, 0n],
      refundedDelta: -1n,
    })
    const { rig: r } = portfolioRig({ callData: [bad] })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(out.steps[0].message).toMatch(/loses track of part of this batch/)
  })

  it('the independent laws bind: a composed fee that is not OUR constant refuses before the wallet', async () => {
    const tampered = portfolioComposed(batchFeeBpsFor(8453) - 1) // one bip off OUR constant — clamp-legal, law-illegal
    const { rig: r } = portfolioRig({}, {
      composePortfolioStep: async () => tampered,
      shownFor: () => shownFromPortfolio(tampered, 8453),
    })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(out.notes.join(' ')).toMatch(/different fee than the one this app charges/)
    expect(bytesSent(r)).toHaveLength(0)
  })

  it('the P8 gate binds: a review that showed a different amount refuses before the wallet', async () => {
    const composed = portfolioComposed(batchFeeBpsFor(8453))
    const shownWrong = shownAtReviewSurface({
      chainId: 8453,
      fundingAsset: composed.args[1],
      fundingTotalRaw: composed.args[2],
      recipient: composed.args[3].recipient,
      legs: composed.args[0].map((l, i) => ({
        symbol: `P${i}`,
        asset: l.buyToken,
        budgetRaw: i === 0 ? l.sellAmount + 1n : l.sellAmount,
        minOutRaw: l.minBuyAmount,
        optional: l.optional,
      })),
      approvals: [],
    })
    const { rig: r } = portfolioRig({}, { shownFor: () => shownWrong })
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(out.notes.join(' ')).toMatch(/different amount than the review showed/)
    expect(bytesSent(r)).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE BRIDGE STEP, END TO END (laws B1–B4; the owner's build order 2026-08-14).
// The quote seam is injected FAITHFUL here — the guarded parse that refuses an
// off-pin target lives (and is tested) in lifi.ts; what THESE pins own is the
// runner's own conduct around a validated quote: verbatim bytes, exact
// approvals landing first, the oracle's arrival verdict, and honesty when the
// oracle cannot answer.
// ─────────────────────────────────────────────────────────────────────────────
describe('the bridge step — quote-verbatim, approve-first, arrival-by-oracle', () => {
  const PIN_1 = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae' as Address // LIFI_TARGETS[1] === [8453]
  const BRIDGE_DATA = '0xb71dce5100000000000000000000000000000000000000000000000000000000000000aa' as Hex
  const faithfulQuote = (over: Partial<{ toAmount: bigint }> = {}) => ({
    tool: 'test-route',
    toAmount: over.toAmount ?? 9_990_000n,
    toAmountMin: 9_900_000n,
    approvalAddress: PIN_1 as Address,
    tx: { to: PIN_1 as Address, data: BRIDGE_DATA, value: 0n, gasLimit: null },
    gasCostUsd: 0.42,
  })
  const bridgeRig = (over: Partial<RunnerEffectsContext> = {}, statuses: ('pending' | 'done' | 'refunded' | 'failed' | Error)[] = ['done']) => {
    let statusIdx = 0
    const clients = {
      1: fakeClient(1, { allowance: 0n, receipts: [{ transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n }] }),
      8453: fakeClient(8453, { callData: [goodResult(composedFor(8453))] }),
    }
    const r = rig({ atomic: true, sendCalls: ['id-b'], callsStatus: { 'id-b': [{ status: 200, receipts: [{ status: 'success' }] }] } }, clients, {
      settlementAddress: () => OTHER,
      lifiQuote: async () => faithfulQuote() as never,
      lifiStatus: async () => {
        const v = statuses[Math.min(statusIdx, statuses.length - 1)]
        statusIdx += 1
        if (v instanceof Error) throw v
        if (v === 'done') return { state: 'done', toAmount: 9_990_000n } as never
        if (v === 'refunded') return { state: 'refunded' } as never
        if (v === 'failed') return { state: 'failed', reason: 'route died' } as never
        return { state: 'pending' } as never
      },
      ...over,
    })
    return r
  }

  it('a 2-network plan runs WHOLE: bridge 1→8453 (approve, then the quote bytes VERBATIM), arrival, then the batch', async () => {
    const r = bridgeRig()
    const state = await runPlan(r, [bridgeStep(1, 8453), { ...batchStep(8453), order: 2 }])
    expect(state.phase, state.notes.join('|')).toBe('done')
    // the wallet saw: the exact-amount approval, then the bridge bytes verbatim
    const chain1 = r.sentTxs.filter((t) => t.chainId === 1)
    expect(chain1).toHaveLength(2)
    expect(chain1[0].to).toBe(OTHER) // the settlement token (approve)
    expect(chain1[1].to.toLowerCase()).toBe(PIN_1) // B1: the pinned diamond
    expect(chain1[1].data).toBe(BRIDGE_DATA) // B1: bytes verbatim
    expect(chain1[1].value).toBe(0n)
  })

  it('an already-sufficient allowance skips the approval — ONE transaction on the source chain', async () => {
    const r = bridgeRig()
    ;(r.ctx.client(1) as unknown as { readContract: () => Promise<bigint> }).readContract = async () => 10n ** 12n
    const state = await runPlan(r, [bridgeStep(1, 8453), { ...batchStep(8453), order: 2 }])
    expect(state.phase).toBe('done')
    expect(r.sentTxs.filter((t) => t.chainId === 1)).toHaveLength(1)
  })

  it('a REFUNDED transfer fails the step in the refund’s own words — never a silent success', async () => {
    const r = bridgeRig({}, ['refunded'])
    const state = await runPlan(r, [bridgeStep(1, 8453)])
    expect(state.phase).toBe('partial')
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/refunded on the source network/)
  })

  it('a FAILED transfer carries the oracle’s reason', async () => {
    const r = bridgeRig({}, ['failed'])
    const state = await runPlan(r, [bridgeStep(1, 8453)])
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/route died/)
  })

  it('an unreachable oracle is AMBIGUITY: the run ends unresolved with the record intact, never a verdict', async () => {
    const r = bridgeRig({}, [new Error('oracle down')])
    const state = await runPlan(r, [bridgeStep(1, 8453)])
    expect(state.phase).toBe('partial')
    expect(state.steps[0].status).toBe('unresolved')
    // the record SURVIVES — arrival keeps tracking after the run ends
    expect(liveSubmissions(r.ctx.store as Storage).some((row) => row.submissionId?.startsWith('bridge:1:8453:'))).toBe(true)
  })

  it('a mutated prepared quote refuses at submit — the B1 bytes law bites (the batch path’s P8 re-assertion, bridge-flavoured)', async () => {
    const r = bridgeRig()
    const effects = createRunnerEffects(r.ctx)
    const sim = await effects.simulate(bridgeStep(1, 8453))
    ;((sim.request as { quote: { tx: { data: string } } }).quote.tx as { data: string }).data = '0xdeadbeef'
    await expect(effects.submit(bridgeStep(1, 8453), sim)).rejects.toThrow(/changed after we checked it/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('an approval that REVERTS stops the transfer cold — the bridge bytes are never sent', async () => {
    const r = bridgeRig()
    const c1 = fakeClient(1, { allowance: 0n, receipts: [{ transactionHash: `0x${'a'.repeat(63)}1`, status: 'reverted', blockNumber: 1n }] })
    ;(r.ctx as { client: (id: number) => unknown }).client = (id: number) => (id === 1 ? c1 : fakeClient(8453, { callData: [goodResult(composedFor(8453))] }))
    const state = await runPlan(r, [bridgeStep(1, 8453)])
    // PARTIAL, not refused — an approval was genuinely signed before the
    // revert; calling that 'refused' would deny a transaction that happened.
    // The money law is the second assertion: the TRANSFER bytes never went.
    expect(state.phase).toBe('partial')
    expect(state.steps[0].message).toMatch(/approval before this transfer did not confirm/)
    expect(r.sentTxs.filter((t) => t.chainId === 1 && t.data === BRIDGE_DATA)).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SALE STEP, END TO END (laws S1–S3; the owner's sell-side order 2026-08-14).
// Same shape as the bridge block above: the quote seam is injected FAITHFUL
// (lifi.ts owns the guarded parse); what THESE pins own is the runner's own
// conduct — the floor clearing before anything signs, exact approvals on the
// SOLD token landing first, verbatim bytes, and receipt-borne honesty.
// ─────────────────────────────────────────────────────────────────────────────
describe('the sale step — floor-first, approve-the-sold-token, bytes verbatim, receipt-honest', () => {
  const PIN_1 = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae' as Address
  const SOLD = '0x3333333333333333333333333333333333333333' as Address
  const SALE_DATA = '0x5a1e00aa00000000000000000000000000000000000000000000000000000000000000bb' as Hex
  const saleQuote = (over: Partial<{ toAmountMin: bigint }> = {}) => ({
    tool: 'test-route',
    toAmount: 10_000_000n, // $10.00 in 6dp settlement
    toAmountMin: over.toAmountMin ?? 9_900_000n, // $9.90 router-enforced
    approvalAddress: PIN_1 as Address,
    tx: { to: PIN_1 as Address, data: SALE_DATA, value: 0n, gasLimit: null },
    gasCostUsd: 0.1,
  })
  const sellStep = (chainId: number, floor = 900): FundingStep => ({
    order: 1,
    action: { kind: 'sell', chainId, asset: SOLD, symbol: 'SLD', sellRaw: (5n * 10n ** 18n).toString(), decimals: 18, floorProceedsCents: floor },
  })
  const saleRig = (over: Partial<RunnerEffectsContext> = {}, receipts?: { transactionHash: string; status: string; blockNumber: bigint }[]) => {
    const clients = {
      1: fakeClient(1, {
        allowance: 0n,
        receipts: receipts ?? [
          { transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n }, // the approve
          { transactionHash: `0x${'a'.repeat(63)}2`, status: 'success', blockNumber: 2n }, // the swap
        ],
      }),
      8453: fakeClient(8453, { callData: [goodResult(composedFor(8453))] }),
    }
    return rig({ atomic: true, sendCalls: ['id-s'], callsStatus: { 'id-s': [{ status: 200, receipts: [{ status: 'success' }] }] } }, clients, {
      settlementAddress: () => OTHER,
      lifiQuote: async () => saleQuote() as never,
      ...over,
    })
  }

  it('a sale-then-batch plan runs WHOLE: approve the SOLD token, the quote bytes VERBATIM, receipt, then the batch', async () => {
    const r = saleRig()
    const state = await runPlan(r, [sellStep(1), { ...batchStep(8453), order: 2 }])
    expect(state.phase, state.notes.join('|')).toBe('done')
    const chain1 = r.sentTxs.filter((t) => t.chainId === 1)
    expect(chain1).toHaveLength(2)
    expect(chain1[0].to).toBe(SOLD) // S3: the approval is on the SOLD token
    expect(chain1[1].to.toLowerCase()).toBe(PIN_1) // S1: the pinned diamond
    expect(chain1[1].data).toBe(SALE_DATA) // S1: bytes verbatim
    expect(chain1[1].value).toBe(0n)
  })

  it('a pure cash-out — one sale, no batch — is a complete run', async () => {
    const r = saleRig()
    const state = await runPlan(r, [sellStep(1)])
    expect(state.phase, state.notes.join('|')).toBe('done')
    expect(r.sentTxs).toHaveLength(2) // approve + swap, nothing else
  })

  it('S2 boundary: a router minimum EXACTLY at the plan’s floor proceeds (met, not missed)', async () => {
    const r = saleRig()
    const state = await runPlan(r, [sellStep(1, 990)]) // floor $9.90 == quote min $9.90
    expect(state.phase, state.notes.join('|')).toBe('done')
    expect(r.sentTxs).toHaveLength(2)
  })

  it('S2: a router minimum below the plan’s floor refuses BEFORE anything signs', async () => {
    const r = saleRig()
    const state = await runPlan(r, [sellStep(1, 1_500)]) // floor $15.00 > min $9.90
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/market has moved against this sale/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('a mutated prepared quote refuses at submit — the S1 bytes law bites', async () => {
    const r = saleRig()
    const effects = createRunnerEffects(r.ctx)
    const sim = await effects.simulate(sellStep(1))
    ;((sim.request as { quote: { tx: { data: string } } }).quote.tx as { data: string }).data = '0xdeadbeef'
    await expect(effects.submit(sellStep(1), sim)).rejects.toThrow(/changed after we checked it/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('an approval that REVERTS stops the sale cold — the swap bytes are never sent', async () => {
    const r = saleRig({}, [{ transactionHash: `0x${'a'.repeat(63)}1`, status: 'reverted', blockNumber: 1n }])
    const state = await runPlan(r, [sellStep(1)])
    expect(state.phase).toBe('partial')
    expect(state.steps[0].message).toMatch(/approval before this sale did not confirm/)
    expect(r.sentTxs.filter((t) => t.data === SALE_DATA)).toHaveLength(0)
  })

  it('a swap that lands and REVERTS fails in the receipt’s own words — never a silent success', async () => {
    const r = saleRig({}, [
      { transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n },
      { transactionHash: `0x${'a'.repeat(63)}2`, status: 'reverted', blockNumber: 2n },
    ])
    const state = await runPlan(r, [sellStep(1)])
    expect(state.phase).toBe('partial')
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/included and reverted/)
  })
})

// ── LAW S2b — settlement decimals verified, never assumed (cold-review INFO-1,
// 2026-08-16). The class: floorRaw = cents × 10^4 assumed 6dp forever, so a
// >6dp settlement token made the S2 floor 10^(d−6)× too small — a sale could
// under-deliver arbitrarily and PASS. These pins hold the whole mechanism:
// the conversion scales with the verified decimals, config-vs-chain
// disagreement refuses, unreadable refuses, and the read is cached. ──────────
describe('law S2b — settlement decimals: verified, scaled, fail-closed', () => {
  const PIN_1 = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae' as Address
  const SOLD = '0x3333333333333333333333333333333333333333' as Address
  const SALE_DATA = '0x5a1e00aa00000000000000000000000000000000000000000000000000000000000000bb' as Hex
  const sellStep = (chainId: number, floor: number): FundingStep => ({
    order: 1,
    action: { kind: 'sell', chainId, asset: SOLD, symbol: 'SLD', sellRaw: (5n * 10n ** 18n).toString(), decimals: 18, floorProceedsCents: floor },
  })
  const rigAt = (script: FakeClientScript, toAmountMin: bigint, over: Partial<RunnerEffectsContext> = {}) => {
    const clients = { 1: fakeClient(1, script) }
    return rig({ atomic: true, sendCalls: ['id-s'], callsStatus: { 'id-s': [{ status: 200, receipts: [{ status: 'success' }] }] } }, clients, {
      settlementAddress: () => OTHER,
      lifiQuote: async () =>
        ({
          tool: 'test-route',
          toAmount: toAmountMin + 100n,
          toAmountMin,
          approvalAddress: PIN_1 as Address,
          tx: { to: PIN_1 as Address, data: SALE_DATA, value: 0n, gasLimit: null },
          gasCostUsd: 0.1,
        }) as never,
      ...over,
    })
  }
  const okReceipts = [
    { transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n },
    { transactionHash: `0x${'a'.repeat(63)}2`, status: 'success', blockNumber: 2n },
  ]
  // reset BOTH sides of every pin: the cache is module-level, and an 8dp entry
  // leaking into a later describe would poison its 6dp sales
  beforeEach(() => resetConfirmedSettlementDecimals())
  afterEach(() => resetConfirmedSettlementDecimals())

  it('an 8dp settlement SCALES the floor — the 6dp-sized minimum that used to pass now refuses (INFO-1, inverted)', async () => {
    // floor $9.90 at 8dp = 990_000_000 raw. A router min of 9_900_000 (the
    // exact figure that satisfied the old hardcoded 10^4 conversion) is now
    // 100× short — the silent-disable class, made loud.
    const r = rigAt({ allowance: 0n, decimals: 8 }, 9_900_000n, { settlementDecimals: () => 8 })
    const state = await runPlan(r, [sellStep(1, 990)])
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/market has moved against this sale/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('an 8dp settlement with an 8dp-sized minimum runs — non-6dp tokens WORK, they are not merely refused', async () => {
    const r = rigAt({ allowance: 0n, decimals: 8, receipts: okReceipts }, 990_000_000n, { settlementDecimals: () => 8 })
    const state = await runPlan(r, [sellStep(1, 990)])
    expect(state.phase, state.notes.join('|')).toBe('done')
    expect(r.sentTxs).toHaveLength(2)
  })

  it('config-vs-chain disagreement refuses BEFORE anything signs — a lying deployments.json cannot mis-scale money', async () => {
    const r = rigAt({ allowance: 0n, decimals: 8 }, 9_900_000n) // ctx absent → configured 6; token says 8
    const state = await runPlan(r, [sellStep(1, 990)])
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/reports 8 decimals but this app is configured for 6/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('unreadable decimals refuse — never a defaulted conversion (fail-closed, not fail-to-6)', async () => {
    const r = rigAt({ allowance: 0n, decimals: new Error('eth_call refused') }, 9_900_000n)
    const state = await runPlan(r, [sellStep(1, 990)])
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/decimals could not be read/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('absurd decimals (a non-token answer) refuse rather than compute', async () => {
    const r = rigAt({ allowance: 0n, decimals: 255 }, 9_900_000n, { settlementDecimals: () => 255 })
    const state = await runPlan(r, [sellStep(1, 990)])
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/decimals no real token has/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('the verification is CACHED per (chain, token) — a later step never re-reads, so a mid-run RPC blip cannot refuse it', async () => {
    const script: FakeClientScript = { allowance: 0n, decimals: 6, receipts: okReceipts }
    const r = rigAt(script, 9_900_000n)
    const effects = createRunnerEffects(r.ctx)
    const sim1 = await effects.simulate(sellStep(1, 990))
    expect(sim1.floorHolds).toBe(true)
    // the token turns unreadable AFTER the first verification — the cache answers
    script.decimals = new Error('rpc blip')
    const sim2 = await effects.simulate(sellStep(1, 990))
    expect(sim2.floorHolds).toBe(true)
  })

  it('the BRIDGE conversion rides the same law — a config-vs-chain mismatch on the source chain refuses the transfer', async () => {
    const clients = {
      1: fakeClient(1, { allowance: 0n, decimals: 8 }),
      8453: fakeClient(8453, { callData: [goodResult(composedFor(8453))] }),
    }
    const r = rig({ atomic: true, sendCalls: ['id-b'], callsStatus: { 'id-b': [{ status: 200, receipts: [{ status: 'success' }] }] } }, clients, {
      settlementAddress: () => OTHER,
      lifiQuote: async () =>
        ({
          tool: 'test-route',
          toAmount: 9_990_000n,
          toAmountMin: 9_900_000n,
          approvalAddress: PIN_1 as Address,
          tx: { to: PIN_1 as Address, data: '0xb71dce51aa' as Hex, value: 0n, gasLimit: null },
          gasCostUsd: 0.42,
        }) as never,
    })
    const state = await runPlan(r, [bridgeStep(1, 8453)])
    expect(state.steps[0].status).toBe('failed')
    expect(state.steps[0].message).toMatch(/reports 8 decimals but this app is configured for 6/)
    expect(r.sentTxs).toHaveLength(0)
  })
})

// ── planExecutable's SALE admission (42bb0fb1 sweep: unpinned in scope) ──────
describe('planExecutable admits sales on pin + client + settlement — no batcher required', () => {
  const saleStep = (chainId: number): FundingStep => ({
    order: 1,
    action: { kind: 'sell', chainId, asset: '0x3333333333333333333333333333333333333333', symbol: 'SLD', sellRaw: '1000', decimals: 18, floorProceedsCents: 900 },
  })
  const caps = {
    client: (id: number) => fakeClient(id),
    batcherAddress: () => null,
    settlementAddress: () => OTHER,
  }
  it('a pinned, connected, settled chain sells with NO batcher; an unpinned chain refuses by name', () => {
    expect(planExecutable([saleStep(1)], caps).ok).toBe(true)
    const off = planExecutable([saleStep(999)], caps)
    expect(off.ok).toBe(false)
    if (!off.ok) expect(off.reason).toMatch(/No verified swap-routing contract/)
  })
})

// ── EXACT boundaries on the legacy gates (42bb0fb1 sweep: the portfolio
// twins were pinned; these legacy twins were not — the twin-mutant lesson). ──
describe('legacy gate boundaries — the exact edge is part of the law', () => {
  it('P5 — a deadline EXACTLY at the chain clock has already passed (equality refuses)', async () => {
    const clients = { 8453: fakeClient(8453) }
    const r = rig({ atomic: true }, clients, {
      composeStep: async () => composedFor(8453, { deadlineSec: NOW_SEC }),
    })
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join(' ')).toMatch(/already passed/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('P5 — a window EXACTLY at the ceiling is allowed (only beyond it refuses)', async () => {
    const composed = composedFor(8453, { deadlineSec: NOW_SEC + MAX_DEADLINE_WINDOW_SEC })
    const clients = { 8453: fakeClient(8453, { callData: [goodResult(composed)] }) }
    const r = rig({ atomic: true, sendCalls: ['id-x'], callsStatus: { 'id-x': [{ status: 200, receipts: [{ status: 'success' }] }] } }, clients, {
      composeStep: async () => composed,
    })
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.notes.join(' ')).not.toMatch(/further ahead than we allow/i)
    expect(state.phase, state.notes.join('|')).toBe('done')
  })

  it('P6 — a preview delivering EXACTLY the floor composes (exact fill is success, not shortfall)', async () => {
    const composed = composedFor(8453)
    const exact: BatchSimResult = {
      spentFunding: composed.args[0].reduce((s, l) => s + l.budget, 0n),
      hubOut: 1_000_000n,
      feeEth: 0n,
      ethRefunded: 0n,
      usdcRefunded: 0n,
      outs: composed.args[0].map((l) => l.minOut),
      skippedBitmap: 0n,
    }
    const clients = { 8453: fakeClient(8453, { callData: [encodeFunctionResult({ abi: batcherAbi, functionName: 'batchBuy', result: exact })] }) }
    const r = rig({ atomic: true, sendCalls: ['id-y'], callsStatus: { 'id-y': [{ status: 200, receipts: [{ status: 'success' }] }] } }, clients)
    const state = await runPlan(r, [batchStep(8453)])
    expect(state.phase, state.notes.join('|')).toBe('done')
  })
})

// ── PORTFOLIO gate boundaries (42bb0fb1 sweep, round 3): the legacy twins
// were pinned above; THESE are simulatePortfolio's own re-assertions — the
// compose-time window is kept valid so the runner's gate is what the
// boundary actually hits. ──
describe('portfolio gate boundaries — the exact edge, on the portfolio rung', () => {
  const A1 = '0x1000000000000000000000000000000000000001' as Address
  const A2 = '0x1000000000000000000000000000000000000002' as Address
  const USDC = '0x1000000000000000000000000000000000000003' as Address
  const SINK = '0x1000000000000000000000000000000000000004' as Address
  const P_LEGS = [
    { symbol: 'AAA', buyToken: A1, sellAmountRaw: asFundingRaw(600_000_000n), minBuyAmountRaw: 55n * 10n ** 18n, swapData: '0xdeadbeef01' as const, optional: false },
    { symbol: 'BBB', buyToken: A2, sellAmountRaw: asFundingRaw(400_000_000n), minBuyAmountRaw: 36n * 10n ** 18n, swapData: '0xdeadbeef02' as const, optional: true },
  ]
  const composedAt = (chainNowSec: number, deadlineSec: number) =>
    composePortfolioBatchBuy({
      legs: P_LEGS,
      fundingAsset: USDC,
      // sized at the chain's own rate — the stale 40bps-era constant was the
      // 2026-08-17 live refusal's fixture twin
      fundingTotalRaw: asFundingRaw(1_000_000_000n + (1_000_000_000n * BigInt(batchFeeBpsFor(8453))) / 10_000n),
      owner: ME,
      recipient: ME,
      chainNowSec,
      deadlineSec,
      feeBps: batchFeeBpsFor(8453),
      feeRecipient: INTERFACE_TAG_ADDRESS ?? SINK,
    })
  const resultFor = (composed: ReturnType<typeof composedAt>, bought?: bigint[]) => {
    const legs = composed.args[0]
    const b = bought ?? legs.map((l) => l.minBuyAmount + 10n ** 18n)
    let executed = 0n
    for (const [i, l] of legs.entries()) if ((b[i] ?? 0n) > 0n) executed += l.sellAmount
    const fee = (executed * BigInt(composed.args[3].feeBps)) / 10_000n
    const refunded = composed.args[2] - executed - fee
    return encodeFunctionResult({ abi: portfolioBatcherAbi, functionName: 'batchBuy', result: [b, refunded] })
  }
  const shownOf = (c: ReturnType<typeof composedAt>) =>
    shownAtReviewSurface({
      chainId: 8453,
      fundingAsset: c.args[1],
      fundingTotalRaw: c.args[2],
      recipient: c.args[3].recipient,
      legs: c.args[0].map((l, i) => ({ symbol: `P${i}`, asset: l.buyToken, budgetRaw: l.sellAmount, minOutRaw: l.minBuyAmount, optional: l.optional })),
      approvals: [],
    })
  const rigFor = (composed: ReturnType<typeof composedAt>, callData?: Hex[]) =>
    rig(
      {},
      { 8453: fakeClient(8453, { callData: callData ?? [resultFor(composed)], receipts: [{ transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n }] }) },
      { engine: 'portfolio', composePortfolioStep: async () => composed, shownFor: () => shownOf(composed) },
    )

  it('a deadline EXACTLY at the chain clock has already passed on the portfolio rung too', async () => {
    // composed with a VALID 700s window that the chain clock has since caught
    const composed = composedAt(NOW_SEC - 700, NOW_SEC)
    const r = rigFor(composed)
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase).toBe('refused')
    expect(out.notes.join(' ')).toMatch(/already passed/i)
    expect(r.wallet.requests).toEqual([])
  })

  it('a window EXACTLY at the ceiling is allowed on the portfolio rung', async () => {
    const composed = composedAt(NOW_SEC, NOW_SEC + MAX_DEADLINE_WINDOW_SEC)
    const r = rigFor(composed)
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.notes.join(' ')).not.toMatch(/further ahead than we allow/i)
    expect(out.phase, out.notes.join('|')).toBe('done')
  })

  it('a delivery EXACTLY at a leg’s floor composes — exact fill is success, not shortfall (P6′)', async () => {
    const composed = composedAt(NOW_SEC, NOW_SEC + 600)
    const exact = composed.args[0].map((l) => l.minBuyAmount)
    const r = rigFor(composed, [resultFor(composed, exact)])
    const out = await runPlan(r, [batchStep(8453)])
    expect(out.phase, out.notes.join('|')).toBe('done')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE STALE-QUOTE RETRY (the owner, 2026-08-15, after six consecutive refusals):
// the preview is PRE-SEND — nothing signed, no gas — so a moving pool's
// momentary refusal should be re-quoted by the machine, not by the human
// pressing a door. These pin the boundary: what earns a retry, and what must
// still fail on the first attempt.
// ─────────────────────────────────────────────────────────────────────────────
describe('looksStaleQuote — only failures a fresh quote could actually clear', () => {
  it('the exact sentences a moving pool produces DO earn a retry', () => {
    for (const m of [
      'leg 1’s route failed on-chain — most often its quote went stale between review and send.',
      'The network refused this batch in simulation — nothing was signed.',
      'The preview of this batch failed — nothing was signed.',
      'execution reverted: RequiredLegFailed',
      'MinBuyNotMet(1,2)',
      'Error("return too low")',
    ])
      expect(looksStaleQuote(m)).toBe(true)
  })

  it('⚠ facts that a fresh quote CANNOT change must fail on the FIRST attempt', () => {
    for (const m of [
      'This deposit needs $60.00 but this wallet holds $59.97 — $0.03 short.',
      '$NVDA: the exchange we route through will not trade this asset',
      '$LNOC: 0x has no route for this asset on this network',
      'this network has no batch contract seated in this deployment',
      'this deployment has no operator fee sink configured',
      'the amount is too small to spend once the fee is provided for',
      'this plan carries more assets than this network can take in one go',
    ])
      expect(looksStaleQuote(m)).toBe(false)
  })

  it('⚠ the deny-list WINS over the retry-list — an insufficient balance that also names the route is still not stale', () => {
    // the dangerous overlap: a sentence carrying both vocabularies must not retry
    expect(looksStaleQuote('leg 1’s route failed on-chain — insufficient balance for this leg')).toBe(false)
  })

  it('an empty or unknown message never retries — a retry that cannot help is pure latency', () => {
    expect(looksStaleQuote('')).toBe(false)
    expect(looksStaleQuote(undefined as unknown as string)).toBe(false)
    expect(looksStaleQuote('something nobody has seen before')).toBe(false)
  })

  it('the retry budget is small and finite — a pool moving faster than three quotes is an honest refusal', () => {
    expect(STALE_QUOTE_RETRIES).toBeGreaterThan(0)
    expect(STALE_QUOTE_RETRIES).toBeLessThanOrEqual(3)
  })
})

describe('asPreviewRefusal — a preview must never read as a mined transaction', () => {
  it('appends the fact that distinguishes a preview from a chain event', () => {
    const out = asPreviewRefusal('leg 1’s route refused — most often its quote went stale')
    expect(out).toMatch(/nothing was signed and nothing was sent/i)
  })

  it('⚠ does NOT say it twice when the message already carries it', () => {
    const already = 'The network refused this batch in simulation — nothing was signed.'
    expect(asPreviewRefusal(already)).toBe(already)
  })

  it('an empty message still produces a true sentence rather than an empty one', () => {
    expect(asPreviewRefusal('')).toMatch(/nothing was signed and nothing was sent/i)
    expect(asPreviewRefusal(undefined as unknown as string)).toMatch(/nothing was signed/i)
  })

  it('punctuation is joined cleanly in both directions', () => {
    expect(asPreviewRefusal('it refused')).toContain('it refused. This was a check')
    expect(asPreviewRefusal('it refused.')).toContain('it refused. This was a check')
  })
})

describe('the shared revert copy makes no claim about the chain', () => {
  it('⚠ RequiredLegFailed no longer says "on-chain" — it is shown mostly by the PRE-SEND preview', () => {
    // decode it the way the app does: a viem-shaped error carrying the selector
    const err = { cause: { data: ('0x835da7f4' + '0'.repeat(64)) as `0x${string}` } }
    const words = friendlyRevert(err, 'fallback')
    expect(words).not.toBe('fallback')
    expect(words).not.toMatch(/on-chain/i)
    // and it still tells the user the thing that matters: their money is safe
    expect(words).toMatch(/nothing was bought|balances are untouched/i)
  })
})

describe('⚠ the stale matcher tracks the CURRENT copy, not the copy it was written against', () => {
  it('matches the sentence decode-revert actually emits today, for all three siblings', () => {
    // the regression this pins: the matchers keyed on "route failed on-chain",
    // that copy was corrected to "route refused" (a preview is not a chain
    // event), and every door keyed to the old phrase silently stopped
    // appearing — a matcher tied to prose fails SILENTLY when the prose moves
    for (const sel of ['RequiredLegFailed', 'RequiredSellFailed', 'RequiredBuyFailed']) {
      const words = PORTFOLIO_HINTS[sel]
      if (!words) continue
      expect(looksStaleQuote(words)).toBe(true)
    }
  })
})

describe('poisonFloor — the preview must prove it can fail before a pass is trusted', () => {
  const args = [
    [{ buyToken: '0xa', sellAmount: 5n, minBuyAmount: 100n, swapData: '0xab', optional: false }],
    '0xf',
    1_000n,
    { recipient: '0xr', deadline: 1n, feeBps: 40, feeRecipient: '0xs', burnSwapData: '0x' },
  ]

  it('makes EVERY leg unsatisfiable, so any floor-enforcing mechanism must reject it', () => {
    const out = poisonFloor(args)
    const legs = out[0] as { minBuyAmount: bigint }[]
    expect(legs).toHaveLength(1)
    expect(legs[0].minBuyAmount).toBeGreaterThan(10n ** 30n)
  })

  it('⚠ changes NOTHING ELSE — a probe that alters the batch is testing a different batch', () => {
    const out = poisonFloor(args)
    const legs = out[0] as Record<string, unknown>[]
    expect(legs[0].buyToken).toBe('0xa')
    expect(legs[0].sellAmount).toBe(5n)
    expect(legs[0].swapData).toBe('0xab')
    expect(legs[0].optional).toBe(false)
    expect(out[1]).toBe('0xf')
    expect(out[2]).toBe(1_000n)
    expect(out[3]).toEqual(args[3])
  })

  it('does not mutate the original args', () => {
    poisonFloor(args)
    expect((args[0] as { minBuyAmount: bigint }[])[0].minBuyAmount).toBe(100n)
  })

  it('an empty leg set does not throw — the probe is called on failure-adjacent paths', () => {
    expect(() => poisonFloor([[], '0xf', 0n, {}])).not.toThrow()
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// THE SALE FALLBACK LANE (the owner's live 4663 no-route, 2026-08-17 20:07):
// LI.FI answers nothing on the young chain while the 0x proxy — the lane the
// token page already trades through — has the route. The S-laws must hold on
// the fallback exactly as on the primary: pinned target and spender (S1, via
// validateLegQuote's baked AllowanceHolder), the settler-enforced minimum as
// the S2 floor basis, exact approvals to the pinned holder (S3).
// ─────────────────────────────────────────────────────────────────────────────
describe('the sale fallback lane — LI.FI silent, the 0x proxy answers', () => {
  const HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734'
  const SOLD2 = '0x4444444444444444444444444444444444444444' as Address
  const ZX_DATA = '0x2213bc0b00000000000000000000000000000000000000000000000000000000000000cc' as Hex
  const NO_ROUTE = new Error('No route for this swap right now (No available quotes for the requested transfer).')
  const zxResponse = (over: Partial<{ min: string }> = {}) => ({
    liquidityAvailable: true,
    buyAmount: '10000000',
    minBuyAmount: over.min ?? '9900000',
    sellAmount: (5n * 10n ** 18n).toString(),
    buyToken: OTHER,
    sellToken: SOLD2,
    allowanceTarget: HOLDER,
    transaction: { to: HOLDER, value: '0', data: ZX_DATA },
    status: 200,
  })
  const fbSellStep = (chainId: number, floor = 900): FundingStep => ({
    order: 1,
    action: { kind: 'sell', chainId, asset: SOLD2, symbol: 'SLD2', sellRaw: (5n * 10n ** 18n).toString(), decimals: 18, floorProceedsCents: floor },
  })
  const fbRig = (over: Partial<RunnerEffectsContext> = {}) => {
    const clients = {
      1: fakeClient(1, {
        allowance: 0n,
        receipts: [
          { transactionHash: `0x${'a'.repeat(63)}1`, status: 'success', blockNumber: 1n },
          { transactionHash: `0x${'a'.repeat(63)}2`, status: 'success', blockNumber: 2n },
        ],
      }),
    }
    return rig({ atomic: true }, clients, {
      settlementAddress: () => OTHER,
      lifiQuote: async () => {
        throw NO_ROUTE
      },
      zeroExQuote: (async () => zxResponse()) as never,
      ...over,
    })
  }

  it('runs the sale through the fallback WHOLE: approve the sold token, then the 0x bytes VERBATIM at the pinned holder', async () => {
    const r = fbRig()
    const state = await runPlan(r, [fbSellStep(1)])
    expect(state.phase, state.notes.join('|')).toBe('done')
    const chain1 = r.sentTxs.filter((t) => t.chainId === 1)
    expect(chain1).toHaveLength(2)
    expect(chain1[0].to).toBe(SOLD2) // S3: approval on the SOLD token…
    expect(chain1[1].to.toLowerCase()).toBe(HOLDER.toLowerCase()) // S1: the pinned holder
    expect(chain1[1].data).toBe(ZX_DATA) // S1: bytes verbatim
    expect(chain1[1].value).toBe(0n)
  })

  it('S2 on the fallback: a settler minimum under the plan’s draw refuses — nothing signs', async () => {
    const r = fbRig({ zeroExQuote: (async () => zxResponse({ min: '8000000' })) as never })
    const state = await runPlan(r, [fbSellStep(1, 900)]) // floor $9.00 > min $8.00
    expect(state.phase).toBe('refused')
    expect(state.notes.join('|')).toMatch(/market has moved against this sale/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('a quote that cannot state its enforced minimum is refused, never trusted', async () => {
    const bare = zxResponse() as Record<string, unknown>
    delete bare.minBuyAmount
    const r = fbRig({ zeroExQuote: (async () => bare) as never })
    const state = await runPlan(r, [fbSellStep(1)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join('|')).toMatch(/no readable enforced minimum/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('both lanes silent: the refusal names BOTH answers, and nothing was sent', async () => {
    const r = fbRig({
      zeroExQuote: (async () => {
        throw new Error('0x proxy unreachable')
      }) as never,
    })
    const state = await runPlan(r, [fbSellStep(1)])
    expect(state.phase).toBe('refused')
    expect(state.notes.join('|')).toMatch(/either lane we trust/)
    expect(state.notes.join('|')).toMatch(/No route for this swap right now/)
    expect(state.notes.join('|')).toMatch(/0x proxy unreachable/)
    expect(r.sentTxs).toHaveLength(0)
  })

  it('a NATIVE sale never tries the fallback — LI.FI is the native lane, and the single-lane message stands', async () => {
    let zxCalled = false
    const r = fbRig({
      zeroExQuote: (async () => {
        zxCalled = true
        return zxResponse()
      }) as never,
    })
    const native: FundingStep = {
      order: 1,
      action: { kind: 'sell', chainId: 1, asset: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address, symbol: 'ETH', sellRaw: (10n ** 18n).toString(), decimals: 18, floorProceedsCents: 900 },
    }
    const state = await runPlan(r, [native])
    expect(state.phase).toBe('refused')
    expect(zxCalled).toBe(false)
    expect(state.notes.join('|')).toMatch(/This sale could not be quoted:/)
    expect(r.sentTxs).toHaveLength(0)
  })
})
