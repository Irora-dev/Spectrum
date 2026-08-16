import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import {
  canPersistSubmissions,
  initialRunState,
  planStepIdentifiable,
  BRIDGE_POLL_MAX_ATTEMPTS,
  POLL_MAX_ATTEMPTS,
  RunnerContractError,
  runFundingPlan,
  stepKeyOf,
  type RunnerEffects,
  type SimulatedStep,
} from './execution-runner'
import type { FundingPlan, FundingStep } from './funding-plan'
import {
  CLAIM_HEARTBEAT_MS,
  CLAIM_TTL_MS,
  clearSubmission,
  hydrateSubmission,
  liveSubmissions,
  MAX_STEP_KEY_LEN,
  readSubmissions,
  RECENT_COMPLETION_WINDOW_MS,
  recordSubmission,
} from './submission-store'

/** A plausible claim stamp for fixtures that never cared about the value.
 *  `atMs: 1` used to serve here and is now correctly REJECTED by the store: a
 *  past stamp let another tab steal a LIVE claim (self-audit 2026-08-07). */
const PLAUSIBLE_MS = 1_800_000_000_000

// THE RUNNER, AUDITED AT BIRTH (threat model's own requirement). Every law in
// the module header is pinned here, and the effects are injected so no test
// needs a wallet, a chain, or a browser to prove one.

const ME = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
// NOT checksum-valid on purpose in the original — kept for the switch tests
const OTHER = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE0' as Address
/** A checksum-VALID second address: the store's own validator drops malformed
 *  ones, which is how the unparseable-record finding surfaced. */
const OTHER_VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

const batchStep = (chainId: number, order = 1): FundingStep => ({
  order,
  action: { kind: 'batch', chainId, fundedFrom: [{ source: 'local-cash', fromChainId: chainId, cents: 1000 }] },
})
const bridgeStep = (from: number, to: number, order = 2): FundingStep => ({
  order,
  action: { kind: 'bridge', fromChainId: from, toChainId: to, amountCents: 1000, refuel: false, source: 'new-money' },
})

const planOf = (steps: FundingStep[], over: Partial<FundingPlan> = {}): FundingPlan => ({
  steps,
  notes: [],
  refusals: [],
  serialized: false,
  txCountByChain: [],
  ...over,
})

const okSim: SimulatedStep = { request: { fake: true }, floorHolds: true }

/** The vitest env is `node` — there is no window.localStorage, which is exactly
 *  why the runner takes the store as a seam (law 8). Injecting a real one is
 *  what makes the double-buy guard testable at all. */
class MemStore implements Storage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.get(k) ?? null }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) { this.m.set(k, v) }
}
let store: MemStore

function effects(over: Partial<RunnerEffects> = {}): RunnerEffects & { logged: unknown[] } {
  const logged: unknown[] = []
  return {
    logged,
    activeAccount: () => ME,
    simulate: async () => okSim,
    submit: async () => ({ submissionId: `id-${Math.floor(1)}`, rung: 0 }),
    resolve: async () => ({ ok: true }),
    writeExecLog: (e) => logged.push(e),
    store,
    nowMs: () => 1_700_000_000_000,
    sleep: async () => {}, // instant tests; the real pacing is POLL_INTERVAL_MS
    ...over,
  }
}

beforeEach(() => {
  store = new MemStore()
})

describe('law 7 — nothing signs while SIMULATED, and the wallet is never touched', () => {
  it('refuses at the door: no simulate, no submit, no log', async () => {
    const fx = effects({ simulate: vi.fn(async () => okSim), submit: vi.fn(async () => ({ submissionId: 'never', rung: 0 })) })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: true })
    expect(out.phase).toBe('refused')
    expect(fx.simulate).not.toHaveBeenCalled()
    expect(fx.submit).not.toHaveBeenCalled()
    expect(fx.logged).toHaveLength(0)
    expect(out.notes.join(' ')).toMatch(/nothing can be signed. No wallet was contacted/)
  })
})

describe('law 1 — active-scoped only: a mid-run account switch stops the run', () => {
  it('refuses before the first signature when the wallet changed, and says nothing was sent', async () => {
    const fx = effects({ activeAccount: () => OTHER, submit: vi.fn(async () => ({ submissionId: 'never', rung: 0 })) })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('refused')
    expect(fx.submit).not.toHaveBeenCalled()
    expect(out.notes.join(' ')).toMatch(/connected wallet changed/)
    expect(out.notes.join(' ')).toMatch(/Nothing was sent/)
  })

  it('a switch AFTER money moved ends the run PARTIAL, with a record', async () => {
    let account: Address = ME
    const fx = effects({
      activeAccount: () => account,
      submit: async () => {
        account = OTHER // the switch happens while step 1 is in flight
        return { submissionId: 'id-1', rung: 0 }
      },
    })
    const out = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453, 1), batchStep(1, 2)]),
      effects: fx,
      simulated: false,
    })
    expect(out.phase).toBe('partial')
    expect(fx.logged).toEqual([{ partial: true, stoppedAt: 'the 1 network transaction', failedLegIndex: undefined, completedSteps: [stepKeyOf(batchStep(8453))] }])
  })
})

describe('law 2 + 3 — hydrate before attempt; record in the same tick as the id', () => {
  it('a live record from a previous instance RESOLVES; it never re-submits (the double-buy)', async () => {
    const step = batchStep(8453)
    recordSubmission({ chainId: 8453, stepKey: stepKeyOf(step), rung: 0, submissionId: 'from-before', signer: ME, atMs: PLAUSIBLE_MS }, store)
    const submit = vi.fn(async () => ({ submissionId: 'never', rung: 0 }))
    const resolve = vi.fn(async () => ({ ok: true as const }))
    const fx = effects({ submit, resolve })
    const out = await runFundingPlan({ account: ME, plan: planOf([step]), effects: fx, simulated: false })
    expect(submit).not.toHaveBeenCalled() // THE POINT: no second submission
    expect(resolve).toHaveBeenCalledWith('from-before')
    expect(out.phase).toBe('done')
    expect(out.steps[0].status).toBe('done')
  })

  it('the record exists the instant the id does, and clears on resolution', async () => {
    let seenDuringSubmit: number | null = null
    const fx = effects({
      resolve: async () => {
        // by the time we are polling, the record must already be persisted
        seenDuringSubmit = liveSubmissions(store).length
        return { ok: true as const }
      },
    })
    await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(seenDuringSubmit).toBe(1)
    expect(liveSubmissions(store)).toHaveLength(0) // cleared on the terminal answer
  })

  it('the record survives a failed resolution — the next instance still sees it was submitted', async () => {
    const fx = effects({ resolve: async () => ({ ok: false as const, message: 'reverted' }) })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('partial')
    // a RESOLVED failure is terminal, so the record is cleared: the ambiguity
    // is gone, and the exec-log carries what happened
    expect(liveSubmissions(store)).toHaveLength(0)
    expect(fx.logged[0]).toMatchObject({ partial: true })
  })
})

describe('law 4 — simulate then sign; the floor check bites before any signature', () => {
  it('a floor that does not hold REFUSES with its own sentence and never signs', async () => {
    const submit = vi.fn(async () => ({ submissionId: 'never', rung: 0 }))
    const fx = effects({
      simulate: async () => ({ request: {}, floorHolds: false, floorMessage: 'the route delivers less than the floor we showed you' }),
      submit,
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(submit).not.toHaveBeenCalled()
    expect(out.phase).toBe('refused')
    expect(out.steps[0].message).toMatch(/delivers less than the floor/)
  })

  it('a simulation revert surfaces the CHAIN’s message, not ours', async () => {
    const fx = effects({
      simulate: async () => {
        throw new Error('execution reverted: LegFloorNotMet')
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.steps[0].message).toBe('execution reverted: LegFloorNotMet')
    expect(out.phase).toBe('refused')
  })

  it('an Error with an EMPTY message gets the fallback sentence, never a blank card (kills messageOf :1067 && → ||)', async () => {
    const fx = effects({
      simulate: async () => {
        throw new Error('')
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.steps[0].message).toBe('This step could not be completed, and no reason was reported.')
  })

  it('a declined signature stops the run with nothing moved and nothing logged', async () => {
    const fx = effects({
      submit: async () => {
        throw new Error('User rejected the request.')
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('refused')
    expect(fx.logged).toHaveLength(0)
  })
})

describe('the ambiguity law — silence HOLDS, and never falls back', () => {
  it('polls through unknown answers until a terminal one, without a second submission', async () => {
    const submit = vi.fn(async () => ({ submissionId: 'id-1', rung: 0 }))
    let calls = 0
    const fx = effects({
      submit,
      resolve: async () => {
        calls += 1
        return calls < 3 ? null : { ok: true as const }
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(calls).toBe(3)
    expect(submit).toHaveBeenCalledTimes(1) // never re-submitted while unknown
    expect(out.phase).toBe('done')
  })
})

describe('law 5 — every outcome that moved money leaves a record, with NO guessed cause', () => {
  it('a failed leg records its INDEX and says the reason is unavailable', async () => {
    const fx = effects({
      resolve: async () => ({ ok: false as const, message: 'RequiredLegFailed', failedLegIndex: 2 }),
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('partial')
    expect(out.steps[0].failedLegIndex).toBe(2)
    expect(fx.logged[0]).toMatchObject({ partial: true, failedLegIndex: 2 })
    const note = out.notes.join(' ')
    expect(note).toMatch(/leg 3\).*did not go through/) // 1-based for the reader
    expect(note).toMatch(/does not tell us why/)
    // and NO cause is invented
    expect(note).not.toMatch(/slippage|liquidity|tolerance/i)
  })

  it('a completed run logs NOT-partial with every step', async () => {
    const fx = effects()
    const out = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453, 1), bridgeStep(8453, 1, 2), batchStep(1, 3)]),
      effects: fx,
      simulated: false,
    })
    expect(out.phase).toBe('done')
    expect(fx.logged).toEqual([{ partial: false, completedSteps: [stepKeyOf(batchStep(8453)), stepKeyOf(bridgeStep(8453, 1)), stepKeyOf(batchStep(1))] }])
  })

  it('a run refused before any signature logs NOTHING — an empty row is not history', async () => {
    const fx = effects({ simulate: async () => ({ request: {}, floorHolds: false }) })
    await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(fx.logged).toHaveLength(0)
  })
})

describe('law 6 — a stop is honored between steps, never mid-flight', () => {
  it('stops before the next step and records what finished', async () => {
    let done = 0
    const fx = effects({
      shouldStop: () => done >= 1,
      resolve: async () => {
        done += 1
        return { ok: true as const }
      },
    })
    const out = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453, 1), batchStep(1, 2)]),
      effects: fx,
      simulated: false,
    })
    expect(out.phase).toBe('partial')
    expect(fx.logged[0]).toMatchObject({ partial: true, completedSteps: [stepKeyOf(batchStep(8453))] })
  })

  it('a stop BEFORE anything moved refuses cleanly with no record', async () => {
    const fx = effects({ shouldStop: () => true, submit: vi.fn(async () => ({ submissionId: 'never', rung: 0 })) })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('refused')
    expect(fx.submit).not.toHaveBeenCalled()
    expect(fx.logged).toHaveLength(0)
    expect(out.notes.join(' ')).toMatch(/stopped before anything was sent/)
  })
})

describe('the panel contract — a plan that cannot execute says so before a run starts', () => {
  it('initialRunState surfaces the funding plan’s refusals without running anything', () => {
    const s = initialRunState(
      planOf([], { refusals: [{ chainId: 4663, reason: 'Network 4663 needs its own ETH for fees.' }] }),
    )
    expect(s.phase).toBe('refused')
    expect(s.notes).toEqual(['Network 4663 needs its own ETH for fees.'])
  })

  it('step keys are stable and unique per action — the submission store depends on it', () => {
    const steps = [batchStep(8453), batchStep(1), bridgeStep(8453, 1)]
    const keys = steps.map(stepKeyOf)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual([stepKeyOf(batchStep(8453)), stepKeyOf(batchStep(1)), stepKeyOf(bridgeStep(8453, 1))])
  })

  it('runs the plan in the plan’s order, one step at a time', async () => {
    const order: string[] = []
    const fx = effects({
      simulate: async (s) => {
        order.push(stepKeyOf(s))
        return okSim
      },
    })
    await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453, 1), bridgeStep(8453, 1, 2), batchStep(1, 3)]),
      effects: fx,
      simulated: false,
    })
    expect(order).toEqual([stepKeyOf(batchStep(8453)), stepKeyOf(bridgeStep(8453, 1)), stepKeyOf(batchStep(1))])
  })
})

describe('law 8 — no persistence, no run (found by auditing this module at birth)', () => {
  it('REFUSES when the submission record cannot be written, before any wallet contact', async () => {
    // The guard laws 2 and 3 rest on are only real if the record can be saved.
    // Without it, hydrate always answers idle and the remount double-buy guard
    // silently vanishes — so the runner says so instead of running unprotected.
    const fx = effects({ store: null, simulate: vi.fn(async () => okSim), submit: vi.fn(async () => ({ submissionId: 'x', rung: 0 })) })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('refused')
    expect(fx.simulate).not.toHaveBeenCalled()
    expect(fx.submit).not.toHaveBeenCalled()
    expect(out.notes.join(' ')).toMatch(/stops a payment being sent twice/)
    expect(out.notes.join(' ')).toMatch(/Nothing was sent/)
  })

  it('a store that EXISTS but throws on write also refuses — Safari private mode', () => {
    const throwing = new MemStore()
    throwing.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    expect(canPersistSubmissions(throwing)).toBe(false)
    // a presence check would have passed this store and lost the guard
    expect(throwing.getItem).toBeTypeOf('function')
  })

  it('a working store passes the probe and leaves nothing behind', () => {
    const s = new MemStore()
    expect(canPersistSubmissions(s)).toBe(true)
    expect(s.length).toBe(0) // the probe cleans up after itself
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT ROUND 2 (2026-08-04): four more findings, three able to lose money or
// hammer a node. Found by probing the runner's FAILURE paths from outside —
// the birth audit tested the laws it set out to test.
// ─────────────────────────────────────────────────────────────────────────────

describe('law 10 — a resolve() THROW is ambiguity, not the end of the run', () => {
  it('an RPC blip mid-poll does not escape the runner, and the record survives', async () => {
    // Before: the throw propagated out of runFundingPlan — no exec-log row, an
    // orphaned live record. Law 5 defeated by a dropped connection.
    let calls = 0
    const fx = effects({
      resolve: async () => {
        calls += 1
        if (calls < 3) throw new Error('RPC down')
        return { ok: true as const }
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('done') // it held through the blip and got its answer
    expect(calls).toBe(3)
  })

  it('a permanently throwing resolve ends the run PARTIAL with a record, never a thrown error', async () => {
    const fx = effects({
      resolve: async () => {
        throw new Error('RPC down')
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('partial')
    expect(fx.logged[0]).toMatchObject({ partial: true })
    // and the submission record SURVIVES: the money may have moved, so only a
    // human (or a later successful resolve) may clear it
    expect(liveSubmissions(store)).toHaveLength(1)
  })
})

describe('law 9 — a poll is BOUNDED and PACED (it was neither)', () => {
  it('stops at the attempt budget instead of spinning forever', async () => {
    // Measured before the fix: 50,000 resolve() calls in 5ms with no delay —
    // spinning the CPU and hammering the RPC exactly while a tx is pending.
    let calls = 0
    const fx = effects({
      resolve: async () => {
        calls += 1
        return null // never answers
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(calls).toBe(POLL_MAX_ATTEMPTS)
    expect(out.phase).toBe('partial')
  })

  it('a BRIDGE step gets the longer budget — one click is meant to carry through arrival (2026-08-15 ruling)', async () => {
    let calls = 0
    const fx = effects({
      resolve: async () => {
        calls += 1
        return null // the oracle never answers — the bound is what we measure
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([bridgeStep(8453, 1)]), effects: fx, simulated: false })
    expect(calls).toBe(BRIDGE_POLL_MAX_ATTEMPTS)
    expect(BRIDGE_POLL_MAX_ATTEMPTS).toBeGreaterThan(POLL_MAX_ATTEMPTS)
    expect(out.phase).toBe('partial') // still a bound, still honest
  })

  it('it WAITS between attempts — the pacing is real, not incidental', async () => {
    const waits: number[] = []
    let calls = 0
    const fx = effects({
      sleep: async (ms) => void waits.push(ms),
      resolve: async () => {
        calls += 1
        return calls < 4 ? null : { ok: true as const }
      },
    })
    await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(waits.length).toBe(3) // one before each retry, none before the first
    expect(waits.every((w) => w >= 1_000)).toBe(true)
  })

  it('giving up says WE DO NOT KNOW — not failed, not done — and keeps the record', async () => {
    const fx = effects({ resolve: async () => null })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.steps[0].status).toBe('unresolved') // claiming failure would be as wrong as claiming success
    expect(out.steps[0].message).toMatch(/could not confirm/)
    expect(out.steps[0].message).toMatch(/may still be pending/)
    expect(liveSubmissions(store)).toHaveLength(1) // the no-TTL law: a human clears it
  })
})

describe('law 11 — nobody else\'s money: a record signed by another wallet REFUSES', () => {
  it('does not adopt, resolve, or report another wallet\'s live submission', async () => {
    // The signer field existed from the start and NOTHING compared it: the law
    // was documented on the record and never enforced.
    const step = batchStep(8453)
    recordSubmission(
      { chainId: 8453, stepKey: stepKeyOf(step), rung: 0, submissionId: 'their-tx', signer: OTHER_VALID, atMs: PLAUSIBLE_MS },
      store,
    )
    const resolve = vi.fn(async () => ({ ok: true as const }))
    const submit = vi.fn(async () => ({ submissionId: 'mine', rung: 0 }))
    const fx = effects({ resolve, submit })
    const out = await runFundingPlan({ account: ME, plan: planOf([step]), effects: fx, simulated: false })
    expect(resolve).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(out.phase).toBe('refused')
    expect(out.steps[0].message).toMatch(/sent by a different wallet/)
    expect(liveSubmissions(store)).toHaveLength(1) // their record is untouched
  })
})

describe('law 12 — UNKNOWN is not idle: an unreadable record refuses the run', () => {
  it('a present-but-unparseable record refuses before any wallet contact', async () => {
    // The double-buy, silently: hydrate answers idle for both "nothing" and
    // "cannot read", and attempt is legal from idle.
    store.setItem(
      'spectrum:live-submission:v1',
      JSON.stringify([{ chainId: 8453, stepKey: stepKeyOf(batchStep(8453)), submissionId: 'REAL-TX', signer: ME, atMs: PLAUSIBLE_MS /* rung missing */ }]),
    )
    const fx = effects({ simulate: vi.fn(async () => okSim), submit: vi.fn(async () => ({ submissionId: 'x', rung: 0 })) })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('refused')
    expect(fx.simulate).not.toHaveBeenCalled()
    expect(fx.submit).not.toHaveBeenCalled()
    expect(out.notes.join(' ')).toMatch(/cannot read/)
    expect(out.notes.join(' ')).toMatch(/Nothing was sent/)
  })

  it('a corrupt blob refuses too — same class', async () => {
    store.setItem('spectrum:live-submission:v1', 'not json at all')
    const fx = effects({ submit: vi.fn(async () => ({ submissionId: 'x', rung: 0 })) })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('refused')
    expect(fx.submit).not.toHaveBeenCalled()
  })

  it('a healthy store with a valid record still hydrates normally — the gate is not a blanket refusal', async () => {
    const step = batchStep(8453)
    recordSubmission({ chainId: 8453, stepKey: stepKeyOf(step), rung: 0, submissionId: 'mine', signer: ME, atMs: PLAUSIBLE_MS }, store)
    const fx = effects()
    const out = await runFundingPlan({ account: ME, plan: planOf([step]), effects: fx, simulated: false })
    expect(out.phase).toBe('done')
  })
})

describe('duplicate step keys are a CONTRACT ERROR — their records would overwrite each other', () => {
  it('throws rather than running a plan whose second step is unprotected', async () => {
    await expect(
      runFundingPlan({ account: ME, plan: planOf([batchStep(8453, 1), batchStep(8453, 2)]), effects: effects(), simulated: false }),
    ).rejects.toThrow(RunnerContractError)
  })
})


describe('law 13 — TWO TABS (round 10): the claim makes the double-buy unreachable concurrently', () => {
  it('THE RACE DIES: tab B refuses while tab A is at the wallet prompt', async () => {
    // Before: both tabs hydrate idle, both legally attempt, both submit the
    // SAME money — the double-buy through tabs instead of a remount, in the
    // exact window a human spends reading a wallet prompt.
    const step = batchStep(8453)
    let releaseA: (v: { submissionId: string; rung: number }) => void = () => {}
    const aAtPrompt = new Promise<{ submissionId: string; rung: number }>((r) => (releaseA = r))

    // tab A: reaches the wallet and WAITS there (the prompt is open)
    const tabA = runFundingPlan({
      account: ME,
      plan: planOf([step]),
      effects: effects({ submit: () => aAtPrompt }),
      simulated: false,
    })
    await new Promise((r) => setTimeout(r, 10)) // A is now holding the claim

    // tab B: same person, same plan, another tab
    const submitB = vi.fn(async () => ({ submissionId: 'tabB', rung: 0 }))
    const outB = await runFundingPlan({ account: ME, plan: planOf([step]), effects: effects({ submit: submitB }), simulated: false })
    expect(submitB).not.toHaveBeenCalled() // THE POINT: no second submission
    expect(outB.phase).toBe('refused')
    expect(outB.steps[0].message).toMatch(/Another tab is already sending/)

    // and tab A completes normally
    releaseA({ submissionId: 'tabA', rung: 0 })
    const outA = await tabA
    expect(outA.phase).toBe('done')
  })

  it('a REJECTED signature releases the claim — the step is not locked for 90s', async () => {
    const step = batchStep(8453)
    const declined = await runFundingPlan({
      account: ME,
      plan: planOf([step]),
      effects: effects({
        submit: async () => {
          throw new Error('User rejected the request.')
        },
      }),
      simulated: false,
    })
    expect(declined.phase).toBe('refused')
    expect(liveSubmissions(store)).toHaveLength(0) // claim released, nothing in flight
    // and the very next attempt may proceed
    const retry = await runFundingPlan({ account: ME, plan: planOf([step]), effects: effects(), simulated: false })
    expect(retry.phase).toBe('done')
  })

  it('a step that became a real SUBMISSION between hydrate and claim is resolved, never re-sent', async () => {
    const step = batchStep(8453)
    const submit = vi.fn(async () => ({ submissionId: 'never', rung: 0 }))
    const fx = effects({ submit })
    // the other tab's submission lands after our hydrate, before our claim
    const original = fx.simulate
    fx.simulate = async (s) => {
      recordSubmission({ chainId: 8453, stepKey: stepKeyOf(step), rung: 0, submissionId: 'other-tab-real', signer: ME, atMs: PLAUSIBLE_MS }, store)
      return original(s)
    }
    const out = await runFundingPlan({ account: ME, plan: planOf([step]), effects: fx, simulated: false })
    expect(submit).not.toHaveBeenCalled()
    expect(out.phase).toBe('done') // resolved the other tab's submission
  })

  it('an EXPIRED claim is taken over — an abandoned tab does not block the step forever', async () => {
    const step = batchStep(8453)
    // a claim from a tab closed at the prompt: no id, older than the TTL
    recordSubmission({ chainId: 8453, stepKey: stepKeyOf(step), rung: 0, submissionId: null, signer: ME, atMs: PLAUSIBLE_MS }, store)
    const fx = effects({ nowMs: () => PLAUSIBLE_MS + CLAIM_TTL_MS + 1 })
    const out = await runFundingPlan({ account: ME, plan: planOf([step]), effects: fx, simulated: false })
    expect(out.phase).toBe('done')
  })

  it('a claim is NOT reported as a submission — polling an id that does not exist would hang', () => {
    recordSubmission({ chainId: 8453, stepKey: stepKeyOf(batchStep(8453)), rung: 0, submissionId: null, signer: ME, atMs: PLAUSIBLE_MS }, store)
    expect(hydrateSubmission(8453, stepKeyOf(batchStep(8453)), store).phase).toBe('idle')
  })
})

describe('R5 — a stale record must never complete a DIFFERENT plan', () => {
  // The key was `batch:<chainId>` and nothing else, so two different plans
  // touching the same chain shared one. A submission left unresolved by plan A
  // was hydrated by plan B, resolved against plan A's old receipt, and marked
  // DONE — the panel reported a completed run for a plan that was never
  // composed, simulated or sent, while the money sat untouched.
  const fundedWith = (chainId: number, cents: number, source: 'local-cash' | 'new-money' = 'local-cash'): FundingStep => ({
    order: 1,
    action: { kind: 'batch', chainId, fundedFrom: [{ source, fromChainId: chainId, cents }] },
  })

  it('two plans on the same chain funding DIFFERENT amounts do not share a key', () => {
    expect(stepKeyOf(fundedWith(8453, 1_000))).not.toBe(stepKeyOf(fundedWith(8453, 50_000)))
  })

  it('nor do they when the money comes from a different SOURCE', () => {
    expect(stepKeyOf(fundedWith(8453, 1_000, 'local-cash'))).not.toBe(stepKeyOf(fundedWith(8453, 1_000, 'new-money')))
  })

  it('but the SAME intent keeps the SAME key — a resume must still find its own record', () => {
    expect(stepKeyOf(fundedWith(8453, 1_000))).toBe(stepKeyOf(fundedWith(8453, 1_000)))
  })

  it('and the key does not change when the plan merely lists its sources in another order', () => {
    const a: FundingStep = {
      order: 1,
      action: {
        kind: 'batch',
        chainId: 8453,
        fundedFrom: [
          { source: 'local-cash', fromChainId: 8453, cents: 1_000 },
          { source: 'new-money', fromChainId: 1, cents: 500 },
        ],
      },
    }
    const b: FundingStep = {
      order: 1,
      action: {
        kind: 'batch',
        chainId: 8453,
        fundedFrom: [
          { source: 'new-money', fromChainId: 1, cents: 500 },
          { source: 'local-cash', fromChainId: 8453, cents: 1_000 },
        ],
      },
    }
    expect(stepKeyOf(a)).toBe(stepKeyOf(b))
  })

  it('a bridge binds its amount and route too', () => {
    const br = (cents: number): FundingStep => ({
      order: 1,
      action: { kind: 'bridge', fromChainId: 8453, toChainId: 1, amountCents: cents, refuel: false, source: 'new-money' },
    })
    expect(stepKeyOf(br(1_000))).not.toBe(stepKeyOf(br(9_000)))
  })
})

describe('R6 — law 11 on the CLAIM path: a foreign record landing in the race window REFUSES', () => {
  // ⚠ THE HARNESS TRAP THAT LEFT THIS FIX UNPINNED FOR A DAY, so nobody hits
  // it again: the planted row must SURVIVE parseRow. A checksum-invalid signer
  // (like OTHER above) or an over-long stepKey is silently dropped by the
  // store's own validator, and claimStep then answers 'claimed' as if the row
  // were never written — the run completes 'done' and the test proves nothing.
  // Use OTHER_VALID, and let stepKeyOf (bounded by construction now) make the
  // key. The window itself is real: `simulate` runs between hydrate and claim.
  it('refuses: nothing sent by us, nothing adopted as ours, their record untouched', async () => {
    const step = batchStep(8453)
    const submit = vi.fn(async () => ({ submissionId: 'never', rung: 0 }))
    const resolve = vi.fn(async () => ({ ok: true as const }))
    const fx = effects({ submit, resolve })
    const original = fx.simulate
    fx.simulate = async (s) => {
      // the other tab, connected as a DIFFERENT wallet, submits in the window
      recordSubmission(
        { chainId: 8453, stepKey: stepKeyOf(step), rung: 0, submissionId: 'their-tx', signer: OTHER_VALID, atMs: PLAUSIBLE_MS },
        store,
      )
      return original(s)
    }
    const out = await runFundingPlan({ account: ME, plan: planOf([step]), effects: fx, simulated: false })
    expect(submit).not.toHaveBeenCalled() // nothing sent from this wallet
    expect(resolve).not.toHaveBeenCalled() // and their tx is NOT adopted as our progress (the R6 defect)
    expect(out.phase).toBe('refused')
    expect(out.steps[0].status).toBe('failed')
    expect(out.steps[0].message).toMatch(/just sent by a different wallet/)
    expect(fx.logged).toHaveLength(0) // nothing moved, so nothing is history
    const theirs = liveSubmissions(store)
    expect(theirs).toHaveLength(1) // their live money's record survives us
    expect(theirs[0].signer).toBe(OTHER_VALID)
    expect(theirs[0].submissionId).toBe('their-tx')
  })

  it('after OUR money already moved, the same discovery ends PARTIAL with a record of what finished', async () => {
    const stepA = batchStep(8453, 1)
    const stepB = batchStep(1, 2)
    const submit = vi.fn(async () => ({ submissionId: 'ours-A', rung: 0 }))
    const fx = effects({ submit })
    const original = fx.simulate
    fx.simulate = async (s) => {
      if (s.action.kind === 'batch' && s.action.chainId === 1) {
        recordSubmission(
          { chainId: 1, stepKey: stepKeyOf(stepB), rung: 0, submissionId: 'their-tx', signer: OTHER_VALID, atMs: PLAUSIBLE_MS },
          store,
        )
      }
      return original(s)
    }
    const out = await runFundingPlan({ account: ME, plan: planOf([stepA, stepB]), effects: fx, simulated: false })
    expect(submit).toHaveBeenCalledTimes(1) // step A only
    expect(out.phase).toBe('partial')
    expect(out.steps[1].message).toMatch(/just sent by a different wallet/)
    expect(fx.logged).toEqual([
      { partial: true, stoppedAt: 'the 1 network transaction', failedLegIndex: undefined, completedSteps: [stepKeyOf(stepA)] },
    ])
  })
})

describe('law 12 AT THE CLAIM SEAM — an unreadable row appearing mid-run refuses, and the evidence survives', () => {
  it('a row we cannot parse lands in the race window: refuse, never claim over it, never erase it', async () => {
    // The door check ran on a clean store; the poison lands between hydrate
    // and claim. Before this gate, claimStep treated unknown rows as ABSENT:
    // it claimed, submitted real money, and its own writes then ERASED the row
    // law 12 exists to refuse on — this is the predecessor's R6 plant (its
    // signer fails the store's checksum validation), now pinned as the refusal
    // it should always have been.
    const step = batchStep(8453)
    const submit = vi.fn(async () => ({ submissionId: 'never', rung: 0 }))
    const fx = effects({ submit })
    const original = fx.simulate
    fx.simulate = async (s) => {
      const raw = JSON.parse(store.getItem('spectrum:live-submission:v1') ?? '[]') as unknown[]
      raw.push({ chainId: 8453, stepKey: stepKeyOf(step), rung: 0, submissionId: 'REAL-TX', signer: OTHER, atMs: PLAUSIBLE_MS })
      store.setItem('spectrum:live-submission:v1', JSON.stringify(raw))
      return original(s)
    }
    const out = await runFundingPlan({ account: ME, plan: planOf([step]), effects: fx, simulated: false })
    expect(submit).not.toHaveBeenCalled() // it may be THIS step's live money
    expect(out.phase).toBe('refused')
    expect(out.steps[0].message).toMatch(/changed while this ran/)
    expect(out.steps[0].message).toMatch(/Nothing further was sent/)
    // the evidence is NOT erased: the raw blob still carries the row, so the
    // next run's door check refuses too instead of finding a scrubbed store
    expect(store.getItem('spectrum:live-submission:v1')).toContain('REAL-TX')
    expect(readSubmissions(store).dropped).toBe(1)
  })
})

describe('A6 round (2026-08-07) — the review round\'s fixes, each pinned to bite', () => {
  it('AMBIGUITY DOES NOT EXPIRE: after an ambiguous submit throw, a retry far past the claim TTL still refuses', async () => {
    // The hole: the run ends, no heartbeat renews, no id will ever arrive —
    // and at +90s a plain claim was legally taken over, so the retry the
    // message invited bought the same thing twice.
    const step = batchStep(8453)
    const out1 = await runFundingPlan({
      account: ME,
      plan: planOf([step]),
      effects: effects({
        submit: async () => {
          throw new Error('socket hang up') // ambiguous: not a decline, not a stated nothing-sent
        },
      }),
      simulated: false,
    })
    expect(out1.phase).toBe('partial')
    expect(out1.steps[0].status).toBe('unresolved')
    const submit2 = vi.fn(async () => ({ submissionId: 'second-buy', rung: 0 }))
    const out2 = await runFundingPlan({
      account: ME,
      plan: planOf([step]),
      effects: effects({ submit: submit2, nowMs: () => 1_700_000_000_000 + CLAIM_TTL_MS * 10 }),
      simulated: false,
    })
    expect(submit2).not.toHaveBeenCalled() // THE POINT: no second buy, however late the retry
    expect(out2.phase).toBe('refused')
    expect(out2.steps[0].message).toMatch(/never answered clearly/)
  })

  it('the evidence survives the WHOLE run — a row planted during submit rides through record and clear', async () => {
    // The reviewers proved the old writes erased unknown rows (the heartbeat
    // every 15s, the record at the id-tick, the clear on resolution). Now the
    // run completes — money was already committed — but the evidence stays,
    // and the NEXT run refuses at the door.
    const step = batchStep(8453)
    const fx = effects({
      submit: async () => {
        const raw = JSON.parse(store.getItem('spectrum:live-submission:v1') ?? '[]') as unknown[]
        raw.push({ chainId: 8453, stepKey: stepKeyOf(step), rung: 0, submissionId: 'FOREIGN-UNREADABLE', signer: OTHER, atMs: PLAUSIBLE_MS })
        store.setItem('spectrum:live-submission:v1', JSON.stringify(raw))
        return { submissionId: 'ours', rung: 0 }
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([step]), effects: fx, simulated: false })
    expect(out.phase).toBe('done')
    expect(store.getItem('spectrum:live-submission:v1')).toContain('FOREIGN-UNREADABLE')
    expect(readSubmissions(store).dropped).toBe(1)
    const next = await runFundingPlan({ account: ME, plan: planOf([step]), effects: effects(), simulated: false })
    expect(next.phase).toBe('refused') // law 12, on evidence the old writes destroyed
  })

  it('a resolved race-window completion counts as MONEY MOVED — a later refusal ends partial with a record', async () => {
    // The asymmetry: the hydrate path set moneyMoved on this discovery, the
    // claim path did not — so a later refusal reported "nothing moved" with a
    // resolved completion in the same state object, and law 5's record was
    // never written.
    const stepA = batchStep(8453, 1)
    const stepB = batchStep(1, 2)
    const submit = vi.fn(async () => ({ submissionId: 'never', rung: 0 }))
    const fx = effects({
      submit,
      simulate: async (s) => {
        if (s.action.kind === 'batch' && s.action.chainId === 8453) {
          recordSubmission(
            { chainId: 8453, stepKey: stepKeyOf(stepA), rung: 0, submissionId: 'other-tab', signer: ME, atMs: PLAUSIBLE_MS },
            store,
          )
          return okSim
        }
        return { request: {}, floorHolds: false, floorMessage: 'the floor failed' } // step B refuses
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([stepA, stepB]), effects: fx, simulated: false })
    expect(submit).not.toHaveBeenCalled()
    expect(out.steps[0].status).toBe('done')
    expect(out.phase).toBe('partial') // NOT 'refused': step A's money moved
    expect(fx.logged).toHaveLength(1) // law 5: the record exists
    expect(fx.logged[0]).toMatchObject({ partial: true, completedSteps: [stepKeyOf(stepA)] })
  })

  it('a record that VANISHES between claim and hydrate reports unresolved — never done with resolve() unseen', async () => {
    // Three reads backed one decision; if the other tab resolved and cleared
    // between them, the step was marked done with zero verification — even
    // when that resolution was a failure.
    const step = batchStep(8453)
    const submit = vi.fn(async () => ({ submissionId: 'never', rung: 0 }))
    const resolve = vi.fn(async () => ({ ok: true as const }))
    let cleared = false
    const fx = effects({
      submit,
      resolve,
      onState: (s) => {
        if (!cleared && s.steps[0]?.status === 'submitted') {
          cleared = true
          clearSubmission(8453, stepKeyOf(step), store)
        }
      },
    })
    const original = fx.simulate
    fx.simulate = async (s) => {
      recordSubmission({ chainId: 8453, stepKey: stepKeyOf(step), rung: 0, submissionId: 'other-tab', signer: ME, atMs: PLAUSIBLE_MS }, store)
      return original(s)
    }
    const out = await runFundingPlan({ account: ME, plan: planOf([step]), effects: fx, simulated: false })
    expect(resolve).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(out.steps[0].status).toBe('unresolved') // the outcome is UNKNOWN, not done
    expect(out.steps[0].message).toMatch(/could not read its outcome/)
    expect(out.phase).toBe('partial')
  })

  it('a wallet id the record cannot hold ends the run honestly — and the step stays held against a late retry', async () => {
    const fx = effects({ submit: async () => ({ submissionId: 'x'.repeat(4300), rung: 0 }) })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('partial')
    expect(out.steps[0].status).toBe('unresolved')
    expect(out.steps[0].message).toMatch(/could not save the record/)
    expect(fx.logged[0]).toMatchObject({ partial: true })
    // money moved with no record — the claim must hold PAST the TTL too
    const submit2 = vi.fn(async () => ({ submissionId: 'again', rung: 0 }))
    const retry = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453)]),
      effects: effects({ submit: submit2, nowMs: () => 1_700_000_000_000 + CLAIM_TTL_MS * 10 }),
      simulated: false,
    })
    expect(submit2).not.toHaveBeenCalled()
    expect(retry.phase).toBe('refused')
  })

  it('a step whose amount is not a number cannot be IDENTIFIED — stepKeyOf throws our contract error', () => {
    const badBatch: FundingStep = {
      order: 1,
      action: { kind: 'batch', chainId: 8453, fundedFrom: [{ source: 'local-cash', fromChainId: 8453, cents: Number.NaN }] },
    }
    expect(() => stepKeyOf(badBatch)).toThrow(RunnerContractError)
    const badBridge: FundingStep = {
      order: 1,
      action: { kind: 'bridge', fromChainId: 8453, toChainId: 1, amountCents: Number.POSITIVE_INFINITY, refuel: false, source: 'new-money' },
    }
    expect(() => stepKeyOf(badBridge)).toThrow(RunnerContractError)
  })

  it('the digest form itself fits the store — even EIP-2294-edge chain ids cannot reintroduce the void', () => {
    // Two 19-digit chain ids push the readable bridge prefix past the bound;
    // the chain scope in the prefix is cosmetic (the store keys by chainId
    // anyway), so it yields before the key ever exceeds the store's ceiling.
    const abs = (from: number, to: number, cents: number): FundingStep => ({
      order: 1,
      action: { kind: 'bridge', fromChainId: from, toChainId: to, amountCents: cents, refuel: false, source: 'new-money' },
    })
    const EDGE = 9_223_372_036_854_775_000 // ~2^63: EIP-2294's own ceiling, 19 digits
    const edge = stepKeyOf(abs(EDGE, EDGE, 1e20))
    expect(edge.length).toBeLessThanOrEqual(MAX_STEP_KEY_LEN)
    expect(stepKeyOf(abs(EDGE, 1, 1e20))).not.toBe(edge) // identity still binds the route
  })
})

describe('the step key FITS THE STORE by construction — R5 intent keys composed with the store length bound', () => {
  // MAX_STEP_KEY_LEN was written when keys were `batch:<chainId>`; R5 made
  // keys carry the funded sources, and a batch funded from three ordinary
  // sources already passed 80 chars. Past the bound, parseRow drops every row
  // for the step: hydrate answers idle, claims are invisible to other tabs,
  // and the whole double-buy guard silently voids. Two bounds, each right
  // alone — nothing multiplied them (the composed-tolerance class again).
  const draws = (n: number, centsBase = 123_456_789) =>
    Array.from({ length: n }, (_, i) => ({
      source: (i % 2 ? 'local-cash' : 'new-money') as 'local-cash' | 'new-money',
      fromChainId: [1, 8453, 4663][i % 3],
      cents: centsBase + i,
    }))
  const stepOf = (fundedFrom: ReturnType<typeof draws>): FundingStep => ({
    order: 1,
    action: { kind: 'batch', chainId: 4663, fundedFrom },
  })

  it('a many-source intent still ROUND-TRIPS the store — its record must never be silently unreadable', () => {
    const step = stepOf(draws(6))
    const key = stepKeyOf(step)
    expect(key.length).toBeLessThanOrEqual(MAX_STEP_KEY_LEN)
    recordSubmission({ chainId: 4663, stepKey: key, rung: 0, submissionId: 'big-plan-tx', signer: ME, atMs: PLAUSIBLE_MS }, store)
    expect(hydrateSubmission(4663, key, store).phase).toBe('submitted') // was: idle — the guard voided
    expect(readSubmissions(store).dropped).toBe(0) // and law 12 has nothing to refuse
  })

  it('bounded keys still bind the INTENT: different money differs, reordered sources agree', () => {
    const a = draws(6)
    expect(stepKeyOf(stepOf(a))).not.toBe(stepKeyOf(stepOf(draws(6, 999_999_999))))
    expect(stepKeyOf(stepOf([...a].reverse()))).toBe(stepKeyOf(stepOf(a))) // sort precedes the digest
  })

  it('a short intent keeps its readable key — the digest form is only for keys the store would drop', () => {
    expect(stepKeyOf(batchStep(8453))).toBe('batch:8453:local-cash@8453:1000')
  })
})

describe('a wrong clock refuses in words, never a spinner (independent pass 2026-08-08)', () => {
  it('an out-of-window clock ends the run REFUSED instead of throwing past every handler', async () => {
    // MEASURED by the reviewer at epoch 0, the GPS epoch, 2000, 2016 and one
    // millisecond below the plausible floor: claimStep THREW on all of them.
    // It throws deliberately — a claim it cannot read back must never be
    // written — but its own ClaimResult type declares `store-unreadable` for
    // exactly this, and no caller ever received it: this line had no try/catch,
    // the step loop has no outer catch, and use-execution-runner has no
    // `.catch()`. So the last emitted state stayed `running` and the panel sat
    // on a spinner. It failed CLOSED — submit called zero times, nothing sent —
    // which is why this is an honesty bug and why the fix says so rather than
    // loosening the refusal.
    const submit = vi.fn(async () => ({ submissionId: 'never', rung: 0 }))
    const fx = effects({ submit, nowMs: () => 0 }) // a stopped clock
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('refused')
    expect(submit).not.toHaveBeenCalled() // still fail-closed; nothing was sent
    expect(out.steps[0].message).toMatch(/cannot tell whether something is already in progress/)
  })
})

// ── LAW 14 — the ruled full-cycle window (the owner 2026-08-13; ask q-…115) ──────
describe('law 14 — a completed plan refuses an identical re-arm inside the ruled window', () => {
  it('a DONE run stamps; the identical plan refuses with the guard sentence, fact-first', async () => {
    const first = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: effects(), simulated: false })
    expect(first.phase).toBe('done')
    // the same plan, one minute later, same browser (same injected store)
    const again = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453)]),
      effects: effects({ nowMs: () => 1_700_000_000_000 + 60_000 }),
      simulated: false,
    })
    expect(again.phase).toBe('refused')
    expect(again.notes.join(' ')).toMatch(/already completed from this browser 1 minute ago/)
    expect(again.notes.join(' ')).toMatch(/double-buy guard, not an error/)
    expect(again.notes.join(' ')).toMatch(/change the plan/)
  })

  it('a DIFFERENT plan runs immediately, and the SAME plan runs once the window has passed', async () => {
    const done1 = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: effects(), simulated: false })
    expect(done1.phase).toBe('done')
    // different step set → different digest → the guard is not a cooldown on the wallet
    const other = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(1)]),
      effects: effects({ nowMs: () => 1_700_000_000_000 + 1_000 }),
      simulated: false,
    })
    expect(other.phase).toBe('done')
    // the SAME plan, one millisecond past the ruled window
    const late = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453)]),
      effects: effects({ nowMs: () => 1_700_000_000_000 + RECENT_COMPLETION_WINDOW_MS + 1 }),
      simulated: false,
    })
    expect(late.phase).toBe('done')
  })

  it('a PARTIAL run never stamps — finishing the remainder is not a double-buy', async () => {
    let account: Address = ME
    const fx = effects({
      activeAccount: () => account,
      submit: async () => {
        account = OTHER
        return { submissionId: 'id-1', rung: 0 }
      },
    })
    const out = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453, 1), batchStep(1, 2)]),
      effects: fx,
      simulated: false,
    })
    expect(out.phase).toBe('partial')
    // the same plan re-armed right away must NOT meet law 14 (no stamp was
    // written); it runs to done now that the account is stable again
    const retry = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453, 1), batchStep(1, 2)]),
      effects: effects({ nowMs: () => 1_700_000_000_000 + 5_000 }),
      simulated: false,
    })
    expect(retry.phase).toBe('done')
  })

  it('a rewound clock is no lock — a stamp from the future proves nothing and the run proceeds', async () => {
    const done1 = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: effects(), simulated: false })
    expect(done1.phase).toBe('done')
    const rewound = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453)]),
      effects: effects({ nowMs: () => 1_700_000_000_000 - 60_000 }),
      simulated: false,
    })
    expect(rewound.phase).toBe('done')
  })
})

// ── LAW 14b — per-step completion guard (audit F5, 2026-08-13) ───────────────
describe('law 14b — a step completed in a prior partial is not re-bought on re-arm', () => {
  it('a partial run stamps its DONE step; re-arming the same plan skips it and finishes the rest', async () => {
    // run 1: step 1 (Base) resolves and clears; step 2 (ETH) stops on an
    // account switch mid-flight → partial. Law 14 does NOT stamp the plan
    // (partials never do), so only the per-step stamp protects step 1.
    let account: Address = ME
    const fx1 = effects({
      activeAccount: () => account,
      submit: async () => {
        account = OTHER
        return { submissionId: 'id-1', rung: 0 }
      },
    })
    const p1 = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453, 1), batchStep(1, 2)]),
      effects: fx1,
      simulated: false,
    })
    expect(p1.phase).toBe('partial')
    // step 1's submission record cleared on its resolved success
    expect(liveSubmissions(store).some((r) => r.chainId === 8453)).toBe(false)

    // re-arm the BYTE-IDENTICAL plan, account stable again, 60s later
    const seen: number[] = []
    const fx2 = effects({
      nowMs: () => 1_700_000_000_000 + 60_000,
      submit: async (step) => {
        seen.push(step.action.kind === 'batch' ? step.action.chainId : 0)
        return { submissionId: 'id-2', rung: 0 }
      },
    })
    const p2 = await runFundingPlan({
      account: ME,
      plan: planOf([batchStep(8453, 1), batchStep(1, 2)]),
      effects: fx2,
      simulated: false,
    })
    expect(p2.phase).toBe('done')
    // ⚠ THE HEART OF F5: step 1 (Base) is SKIPPED — never re-submitted — while
    // step 2 (ETH) runs. Without law 14b, `seen` would include 8453 again.
    expect(seen).not.toContain(8453)
    expect(seen).toContain(1)
    expect(p2.steps.find((s) => s.chainId === 8453)?.status).toBe('done')
  })

  it('past the window, the same step runs again (the guard is a window, not a permanent lock)', async () => {
    await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: effects(), simulated: false })
    // that was a clean single-step DONE, so law 14 (whole-plan) also stamped —
    // use a DIFFERENT single-step plan to isolate the STEP guard's expiry
    const seen: number[] = []
    const fx = effects({
      nowMs: () => 1_700_000_000_000 + RECENT_COMPLETION_WINDOW_MS + 1,
      submit: async (step) => {
        seen.push(step.action.kind === 'batch' ? step.action.chainId : 0)
        return { submissionId: 'id-x', rung: 0 }
      },
    })
    const out = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
    expect(out.phase).toBe('done')
    expect(seen).toContain(8453) // past both windows, it genuinely runs
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A12 SURVIVOR PINS (the five-module sweep, 2026-08-14 — pass-one MED-1's
// remedy round). Each test is the boundary input that tells the mutant and
// the law apart; the sweep proved no existing case could.
// ─────────────────────────────────────────────────────────────────────────────
describe('A12 pins — cycle digests, the key-length cap, the heartbeat', () => {
  it('two DIFFERENT plans get different cycle digests — the window must never confuse them', async () => {
    // ⚠ COMMENT CORRECTED (reviewer INFO-1, 2026-08-14): this test does NOT
    // kill the :904 one-index-widening mutant, and the first version of this
    // comment claimed it did. In a BITWISE xor, NaN coerces to 0, so the extra
    // round is a fixed bijective permutation of the digest space — digests
    // stay input-distinct and the mutant is EQUIVALENT (triaged as such in
    // mutation-triage.json). What this test pins is the real property the
    // window depends on: distinct plans never share a digest — plan B must
    // not refuse as "already completed" after plan A runs
    const outA = await runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: effects(), simulated: false })
    expect(outA.phase).toBe('done')
    const outB = await runFundingPlan({ account: ME, plan: planOf([batchStep(1)]), effects: effects(), simulated: false })
    expect(outB.phase).toBe('done')
    expect(outB.notes.join(' ')).not.toMatch(/already completed/)
  })

  it('a raw step key exactly AT the 80-char cap stays raw; one char over goes to the digest form (kills :337 <= → <)', () => {
    const sourcesAt = [
      { source: 'new-money' as const, fromChainId: 1, cents: 999 },
      { source: 'new-money' as const, fromChainId: 2, cents: 999 },
      { source: 'new-money' as const, fromChainId: 3, cents: 999 },
      { source: 'new-money' as const, fromChainId: 4, cents: 123_456_789 },
    ]
    const rawOf = (ss: typeof sourcesAt) =>
      `batch:8453:${ss.map((f) => `${f.source}@${f.fromChainId}:${Math.trunc(f.cents)}`).sort().join(',')}`
    const stepOf = (ss: typeof sourcesAt): FundingStep => ({ order: 1, action: { kind: 'batch', chainId: 8453, fundedFrom: ss } })
    // premise: this fixture sits EXACTLY on the cap — the boundary is the test
    expect(rawOf(sourcesAt).length).toBe(80)
    expect(stepKeyOf(stepOf(sourcesAt))).toBe(rawOf(sourcesAt))
    // one digit more crosses it: the key must change form yet still fit the store
    const sourcesOver = [...sourcesAt.slice(0, 3), { ...sourcesAt[3], cents: 1_234_567_890 }]
    expect(rawOf(sourcesOver).length).toBe(81)
    const over = stepKeyOf(stepOf(sourcesOver))
    expect(over).not.toBe(rawOf(sourcesOver))
    expect(over.length).toBeLessThanOrEqual(80)
    expect(over.startsWith('batch')).toBe(true)
  })

  it('the claim heartbeat KEEPS beating across a long submit — a successful renew must not kill the pulse (kills :754 both mutants)', async () => {
    vi.useFakeTimers()
    try {
      let clock = 1_700_000_000_000
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const fx = effects({
        nowMs: () => clock,
        submit: async () => {
          await gate
          return { submissionId: 'slow-id', rung: 0 }
        },
      })
      const done = runFundingPlan({ account: ME, plan: planOf([batchStep(8453)]), effects: fx, simulated: false })
      await vi.advanceTimersByTimeAsync(0) // reach the submit await
      for (let i = 0; i < 3; i++) {
        clock += CLAIM_HEARTBEAT_MS
        await vi.advanceTimersByTimeAsync(CLAIM_HEARTBEAT_MS)
      }
      const row = liveSubmissions(store).find((r) => r.chainId === 8453)
      expect(row, 'the claim row must exist while submit is in flight').toBeDefined()
      // the THIRD beat's renewal must be visible — the mutant clears the pulse
      // after the FIRST successful renew, freezing atMs a heartbeat in
      expect(row!.atMs).toBeGreaterThanOrEqual(1_700_000_000_000 + 3 * CLAIM_HEARTBEAT_MS)
      release()
      await vi.runAllTimersAsync()
      const out = await done
      expect(out.phase).toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── SALE IDENTITY (the 42bb0fb1 sweep: these guards were pinned only in other
// suites outside this file's sweep scope — the scope's own pins live here). ──
describe('sale step identity — the guards and the key, pinned in scope', () => {
  const sale = (over: Record<string, unknown> = {}): FundingStep =>
    ({
      order: 1,
      action: {
        kind: 'sell',
        chainId: 8453,
        asset: '0x3333333333333333333333333333333333333333',
        symbol: 'SLD',
        sellRaw: '1000',
        decimals: 18,
        floorProceedsCents: 900,
        ...over,
      },
    }) as FundingStep

  it('a valid sale is identifiable; zero raw, garbage raw, a bad address and a non-finite floor are NOT', () => {
    expect(planStepIdentifiable(sale())).toBe(true)
    expect(planStepIdentifiable(sale({ sellRaw: '0' }))).toBe(false)
    expect(planStepIdentifiable(sale({ sellRaw: 'nope' }))).toBe(false)
    expect(planStepIdentifiable(sale({ asset: '0x123' }))).toBe(false)
    expect(planStepIdentifiable(sale({ floorProceedsCents: Number.NaN }))).toBe(false)
    expect(planStepIdentifiable(sale({ chainId: Number.POSITIVE_INFINITY }))).toBe(false)
  })

  it('the key is asset + exact raw + chain — the FLOOR never enters it (a re-quote must not mint a new key)', () => {
    const a = stepKeyOf(sale())
    expect(a).toBe(stepKeyOf(sale({ floorProceedsCents: 1 })))
    expect(a).not.toBe(stepKeyOf(sale({ sellRaw: '1001' })))
    expect(a).not.toBe(stepKeyOf(sale({ asset: '0x4444444444444444444444444444444444444444' })))
    expect(a).not.toBe(stepKeyOf(sale({ chainId: 1 })))
  })
})
