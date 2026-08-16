import { describe, expect, it } from 'vitest'
import { DEV_PREVIEW_ADDRESS } from './dev-preview'
import {
  addTarget,
  adoptGuestDraft,
  advancePlan,
  allInFeeBps,
  BATCH_FEE_BPS,
  feePctLabel,
  ZEROEX_TAKER_FEE_BPS,
  DEFAULT_SEED_PCT,
  divergencePct,
  loadPublished,
  savePublished,
  setSeedPct,
  cancelPlan,
  clearDraft,
  compilePlan,
  currentStep,
  emptyDraft,
  evenSplit,
  failCurrent,
  GUEST_SCOPE,
  loadDraft,
  loadNamedPlans,
  loadPortfolio,
  MAX_PLAUSIBLE_AMOUNT_USD,
  loadExec,
  MAX_ALLOCATION_ASSETS,
  normalizedTargets,
  planProgress,
  removeTarget,
  requestStop,
  retryStep,
  saveDraft,
  saveExec,
  setAmount,
  setIntent,
  setChannel,
  channelExecutable,
  setTargetWeight,
  startPlan,
  weightSum,
  saveNamedPlan,
  deleteNamedPlan,
  loadWatchlist,
  toggleWatch,
  isWatched,
  type AllocAsset,
  type ExecutionPlan,
  batchFeeBpsFor,
  GEN2_BATCH_FEE_BPS,
  savePortfolioBand,
} from './allocation'

// Fixture addresses must be REAL hex (the read-time validator rightly refuses
// anything else) — encode the symbol's char codes so each is unique and valid.
const A = (chainId: number, sym: string): AllocAsset => ({
  chainId,
  address: `0x${[...sym].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(40, '0').slice(0, 40)}`,
  symbol: sym,
})

const fakeStorage = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe('draft editing', () => {
  it('adds, dedupes, and caps targets', () => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'AAVE'), 2)
    d = addTarget(d, A(1, 'AAVE'), 3) // dupe — ignored
    expect(d.targets).toHaveLength(1)
    for (let i = 0; i < MAX_ALLOCATION_ASSETS + 3; i++) d = addTarget(d, A(1, `T${i}`), 4 + i)
    expect(d.targets).toHaveLength(MAX_ALLOCATION_ASSETS)
  })

  it('removes and reweights by asset key — a stepper moves ONE asset only, clamped 1–100', () => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'AAVE'))
    d = addTarget(d, A(8453, 'BANKR'))
    expect(d.targets.map((t) => t.weight)).toEqual([50, 50]) // add re-splits evenly
    d = setTargetWeight(d, A(8453, 'BANKR'), 300)
    expect(d.targets.find((t) => t.asset.symbol === 'BANKR')?.weight).toBe(100) // ceiling
    expect(d.targets.find((t) => t.asset.symbol === 'AAVE')?.weight).toBe(50) // untouched (independence)
    expect(weightSum(d)).toBe(150) // the gate's job, not the stepper's
    d = setTargetWeight(d, A(8453, 'BANKR'), -5) // floor at 1
    expect(d.targets.find((t) => t.asset.symbol === 'BANKR')?.weight).toBe(1)
    d = removeTarget(d, A(1, 'AAVE'))
    expect(d.targets.map((t) => t.asset.symbol)).toEqual(['BANKR'])
  })

  it('add-time even split always sums to exactly 100', () => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'A'))
    d = addTarget(d, A(1, 'B'))
    d = addTarget(d, A(1, 'C'))
    expect(weightSum(d)).toBe(100)
    expect(d.targets.map((t) => t.weight)).toEqual([34, 33, 33])
  })

  it('normalizes to a sum of exactly 100 (largest remainder)', () => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'A'))
    d = addTarget(d, A(1, 'B'))
    d = addTarget(d, A(1, 'C'))
    const pcts = normalizedTargets(d).map((t) => t.pct)
    expect(pcts.reduce((s, p) => s + p, 0)).toBe(100)
    expect(Math.max(...pcts) - Math.min(...pcts)).toBeLessThanOrEqual(1)
  })

  it('computes dollar slices from the amount', () => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'A'))
    d = addTarget(d, A(1, 'B'))
    d = setAmount(d, 1000)
    const slices = normalizedTargets(d).map((t) => t.usd)
    expect(slices.reduce((s, v) => s + v, 0)).toBeCloseTo(1000)
  })

  it('even split resets weights', () => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'A'))
    d = addTarget(d, A(1, 'B'))
    d = setTargetWeight(d, A(1, 'B'), 400)
    d = evenSplit(d)
    expect(normalizedTargets(d).map((t) => t.pct)).toEqual([50, 50])
  })
})

describe('draft persistence', () => {
  it('round-trips and clears', () => {
    const s = fakeStorage()
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'AAVE'))
    d = setAmount(d, 250)
    saveDraft('0xAbC', d, s)
    const back = loadDraft('0xabc', s) // case-insensitive key
    expect(back?.targets[0].asset.symbol).toBe('AAVE')
    expect(back?.amountUsd).toBe(250)
    clearDraft('0xABC', s)
    expect(loadDraft('0xabc', s)).toBeNull()
  })

  it('corrupt json reads as null, never throws', () => {
    const s = fakeStorage()
    s.setItem('spectrum:allocation:draft:0xabc', '{nope')
    expect(loadDraft('0xABC', s)).toBeNull()
  })
})

// desk-204 provenance half, PROMOTED from the open-findings registry
// (2026-08-12, with the execute-station arming): the seeding seams stamp the
// book's owner so real execution can refuse a demo-seeded plan even after
// adoptGuestDraft moved it under a real wallet. The refusal itself is pinned
// in execution-arming.test.ts; these pin the field's life across the seam.
describe('seedBookOwner — the seed book’s provenance', () => {
  const seeded = (owner: string) => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'AAVE'))
    d = setAmount(d, 100)
    return { ...d, seedBookOwner: owner }
  }

  it('rides save/load, lowercased at the seam', () => {
    const s = fakeStorage()
    saveDraft('0xabc', seeded('0x29eE56bA30c02667972756b829e2B10DF1733AE2'), s)
    expect(loadDraft('0xabc', s)?.seedBookOwner).toBe('0x29ee56ba30c02667972756b829e2b10df1733ae2')
  })

  it('the demo book’s own address survives EXACTLY — the arming refusal keys off it', () => {
    const s = fakeStorage()
    saveDraft('0xabc', seeded(DEV_PREVIEW_ADDRESS), s)
    expect(loadDraft('0xabc', s)?.seedBookOwner).toBe(DEV_PREVIEW_ADDRESS)
  })

  it('a malformed owner drops to absence, never to a fake address', () => {
    const s = fakeStorage()
    for (const bad of ['demo', '0x123', 42, null, `0x${'g'.repeat(40)}`]) {
      saveDraft('0xabc', { ...seeded('0x'), seedBookOwner: bad as never }, s)
      expect(loadDraft('0xabc', s)?.seedBookOwner).toBeUndefined()
    }
  })

  it('adoptGuestDraft carries provenance across a connect — the exact desk-204 seam', () => {
    const s = fakeStorage()
    saveDraft(GUEST_SCOPE, seeded(DEV_PREVIEW_ADDRESS), s)
    adoptGuestDraft('0xAbC', s)
    expect(loadDraft('0xabc', s)?.seedBookOwner).toBe(DEV_PREVIEW_ADDRESS)
  })
})

const twoChainDraft = () => {
  let d = emptyDraft(1)
  d = addTarget(d, A(1, 'AAVE'))
  d = addTarget(d, A(1, 'SYRUP'))
  d = addTarget(d, A(4663, 'NVDA'))
  d = addTarget(d, A(8453, 'BANKR'))
  d = setAmount(d, 1000)
  return d
}

describe('channelExecutable — the chain-aware gate', () => {
  it('FAILS CLOSED without a chain, which is the old behaviour exactly', () => {
    expect(channelExecutable('limit')).toBe(false)
    expect(channelExecutable('slices')).toBe(false)
    expect(channelExecutable('market')).toBe(true)
  })

  it('allows limit only where settlement actually has code', () => {
    expect(channelExecutable('limit', 1)).toBe(true)
    expect(channelExecutable('limit', 8453)).toBe(true)
    // 4663 is where every live basket is, and CoW has NO code there — a
    // control that can never fill is the dead confirm this lane forbids
    expect(channelExecutable('limit', 4663)).toBe(false)
    expect(channelExecutable('limit', 999999)).toBe(false)
  })

  it('keeps slices false on every chain (a TWAP needs a CONTRACT owner)', () => {
    for (const c of [1, 8453, 4663]) expect(channelExecutable('slices', c)).toBe(false)
  })

  it('market never depends on the chain', () => {
    for (const c of [1, 8453, 4663, undefined]) expect(channelExecutable('market', c)).toBe(true)
  })
})

describe('intent (the doors)', () => {
  it('defaults to keep, flips to publish, survives persistence', () => {
    const s = fakeStorage()
    let d = emptyDraft(1)
    expect(d.intent).toBe('keep')
    d = addTarget(d, A(1, 'AAVE'))
    d = setIntent(d, 'publish')
    saveDraft('0xabc', d, s)
    expect(loadDraft('0xABC', s)?.intent).toBe('publish')
  })

  // A rebalance changes a portfolio you already hold. The completion path saves
  // the portfolio only on the keep branch and clears the draft either way, so
  // letting a funding draft flip to publish drops the rebalance silently
  // (UIGuy's finding). Publishing what you hold is the QUEUED publish work.
  it('refuses to publish a REBALANCE draft (funding present), by every path', () => {
    const rebalance = {
      ...emptyDraft(1),
      targets: [{ asset: A(1, 'AAVE'), weight: 100 }],
      funding: { soldUsd: 600, grossBuysUsd: 0, resultUsd: 4200 },
    }
    // the review's toggle
    expect(setIntent(rebalance, 'publish').intent).toBe('keep')
    // ?door=publish applied at LOAD — the path a toggle-only guard would miss
    const viaUrl = setIntent({ ...rebalance, intent: 'keep' }, 'publish')
    expect(viaUrl.intent).toBe('keep')
    expect(viaUrl.funding).toEqual(rebalance.funding)
    // refused, not mangled — the draft comes back untouched
    expect(setIntent(rebalance, 'publish')).toBe(rebalance)
  })

  // The DESERIALISATION twin of the two tests above (UIGuy's finding): setIntent
  // guards transitions, and a load is not a transition. A draft persisted with
  // BOTH publish and funding was reachable — the flip was allowed, and
  // persisted, before the guard existed — so it must heal on the way in.
  it('a persisted publish+funding draft heals to keep on load', () => {
    const s = fakeStorage()
    s.setItem(
      'spectrum:allocation:draft:0xabc',
      JSON.stringify({
        targets: [{ asset: A(1, 'AAVE'), weight: 100 }],
        amountUsd: 0,
        intent: 'publish',
        funding: { soldUsd: 600, grossBuysUsd: 0, resultUsd: 4200 },
        updatedAt: 1,
      }),
    )
    const loaded = loadDraft('0xabc', s)
    expect(loaded?.intent).toBe('keep')
    // healed, not emptied — the rebalance itself survives intact
    expect(loaded?.funding?.soldUsd).toBe(600)
    expect(loaded?.funding?.resultUsd).toBe(4200)
    expect(loaded?.targets).toHaveLength(1)
  })

  it('a persisted publish draft WITHOUT funding still loads as publish', () => {
    const s = fakeStorage()
    s.setItem(
      'spectrum:allocation:draft:0xabc',
      JSON.stringify({
        targets: [{ asset: A(1, 'AAVE'), weight: 100 }],
        amountUsd: 500,
        intent: 'publish',
        updatedAt: 1,
      }),
    )
    expect(loadDraft('0xabc', s)?.intent).toBe('publish')
  })

  it('an ordinary create draft still flips to publish (the rework spec stands)', () => {
    const plain = { ...emptyDraft(1), targets: [{ asset: A(1, 'AAVE'), weight: 100 }] }
    expect(setIntent(plain, 'publish').intent).toBe('publish')
    expect(setIntent(setIntent(plain, 'publish'), 'keep').intent).toBe('keep')
  })

  it('pre-doors persisted drafts read as keep', () => {
    const s = fakeStorage()
    s.setItem(
      'spectrum:allocation:draft:0xabc',
      JSON.stringify({ targets: [], amountUsd: 100, updatedAt: 1 }),
    )
    expect(loadDraft('0xabc', s)?.intent).toBe('keep')
  })
})

describe('guest adoption (picker-first)', () => {
  it('moves a guest draft into the wallet scope at connect, wallet draft wins if present', () => {
    const st = fakeStorage()
    let g = emptyDraft(1)
    g = addTarget(g, A(1, 'AAVE'))
    saveDraft(GUEST_SCOPE, g, st)
    adoptGuestDraft('0xAbC', st)
    expect(loadDraft('0xabc', st)?.targets[0].asset.symbol).toBe('AAVE')
    expect(loadDraft(GUEST_SCOPE, st)).toBeNull()
    // wallet draft present → guest discarded, wallet kept
    let g2 = emptyDraft(1)
    g2 = addTarget(g2, A(1, 'PONS'))
    saveDraft(GUEST_SCOPE, g2, st)
    adoptGuestDraft('0xabc', st)
    expect(loadDraft('0xabc', st)?.targets[0].asset.symbol).toBe('AAVE')
    expect(loadDraft(GUEST_SCOPE, st)).toBeNull()
  })
})

describe('plan compilation — publish door', () => {
  it('compiles one create + one seed mint per network, seeding the CHOSEN portion', () => {
    const d = setIntent(twoChainDraft(), 'publish')
    const plan = compilePlan(d, 7)
    expect(plan.steps.map((s) => `${s.kind}:${s.chainId}`)).toEqual([
      'create:1',
      'seedmint:1',
      'create:4663',
      'seedmint:4663',
      'create:8453',
      'seedmint:8453',
    ])
    const create1 = plan.steps.find((s) => s.id === 'create:1')
    expect(create1?.usd).toBeCloseTo(500 * (DEFAULT_SEED_PCT / 100)) // seeded slice only
    const deep = compilePlan(setSeedPct(d, 100), 8)
    expect(deep.steps.find((s) => s.id === 'create:1')?.usd).toBeCloseTo(500)
    expect(runToCompletion(plan).status).toBe('done')
  })
})

describe('published snapshot + divergence (the post-publish loop)', () => {
  it('round-trips the snapshot and measures divergence', () => {
    const st = fakeStorage()
    const d = twoChainDraft()
    savePublished('0xAbC', { targets: d.targets, name: 'MIX', seedPct: 25, publishedAt: 1, simulated: true }, st)
    const back = loadPublished('0xabc', st)
    expect(back?.targets).toHaveLength(4)
    expect(divergencePct(d.targets, back!.targets)).toBe(0)
    const drifted = setTargetWeight(d, A(1, 'AAVE'), 45).targets
    expect(divergencePct(drifted, back!.targets)).toBe(20) // 45 vs 25
    const dropped = removeTarget(d, A(8453, 'BANKR')).targets
    expect(divergencePct(dropped, back!.targets)).toBe(25) // BANKR only on the published side
  })
})

describe('plan compilation', () => {
  it('keep-door BATCHES: one buy transaction per network (20 assets → 3 txs is the product)', () => {
    const plan = compilePlan(twoChainDraft(), 99)
    expect(plan.steps.map((s) => s.id)).toEqual([
      'batch:1',
      'fund:4663',
      'batch:4663',
      'fund:8453',
      'batch:8453',
    ])
    const b1 = plan.steps.find((s) => s.id === 'batch:1')
    expect(b1?.count).toBe(2)
    expect(b1?.symbols).toEqual(['AAVE', 'SYRUP'])
    expect(b1?.usd).toBeCloseTo(500)
    const fund4663 = plan.steps.find((s) => s.id === 'fund:4663')
    expect(fund4663?.usd).toBeCloseTo(250)
    expect(plan.steps.every((s) => s.state === 'queued')).toBe(true)
    expect(runToCompletion(plan).status).toBe('done')
  })

  it('single-chain plans have no fund steps', () => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'A'))
    d = addTarget(d, A(1, 'B'))
    d = setAmount(d, 100)
    const plan = compilePlan(d)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].kind).toBe('batch')
    expect(plan.steps[0].count).toBe(2)
  })
})

const runToCompletion = (plan: ExecutionPlan, cap = 100): ExecutionPlan => {
  let p = startPlan(plan)
  let guard = 0
  while (p.status === 'running' && guard++ < cap) p = advancePlan(p)
  return p
}

describe('read-time validation (the localStorage seam)', () => {
  it('sanitizes NaN and negative weights — pct is always a finite number', () => {
    const d = { ...emptyDraft(1), targets: [{ asset: A(1, 'X'), weight: NaN }, { asset: A(1, 'Y'), weight: 100 }] }
    const norm = normalizedTargets(d)
    expect(norm.every((t) => Number.isFinite(t.pct))).toBe(true)
    expect(norm.map((t) => t.pct)).toEqual([0, 100])
    const neg = { ...emptyDraft(1), targets: [{ asset: A(1, 'X'), weight: -40 }, { asset: A(1, 'Y'), weight: 60 }] }
    expect(normalizedTargets(neg).map((t) => t.pct)).toEqual([0, 100])
  })

  it('filters malformed persisted targets instead of throwing later', () => {
    const s = fakeStorage()
    s.setItem(
      'spectrum:allocation:draft:0xabc',
      JSON.stringify({
        targets: [{ asset: { address: 'nope', chainId: 1 }, weight: 50 }, { asset: A(1, 'OK'), weight: 50 }],
        amountUsd: 'NaN-ish',
        updatedAt: 1,
      }),
    )
    const d = loadDraft('0xabc', s)
    expect(d?.targets.map((t) => t.asset.symbol)).toEqual(['OK'])
    expect(d?.amountUsd).toBeNull()
  })

  it('rejects a zero-step persisted plan (it wedged the execute station)', () => {
    const s = fakeStorage()
    s.setItem(
      'spectrum:allocation:exec:0xabc',
      JSON.stringify({ id: 'alloc-x', steps: [], amountUsd: 100, createdAt: 1, status: 'running' }),
    )
    expect(loadExec('0xabc', s)).toBeNull()
  })
})

describe('stop after this step (requestStop)', () => {
  it('stops immediately when the current step has not been approved', () => {
    const p = requestStop(startPlan(compilePlan(twoChainDraft())))
    expect(p.status).toBe('cancelled')
  })

  it('lets a confirming step FINISH, then cancels — done steps kept', () => {
    let p = startPlan(compilePlan(twoChainDraft()))
    p = advancePlan(p) // first step confirming
    p = requestStop(p)
    expect(p.status).toBe('running')
    expect(p.stopRequested).toBe(true)
    p = advancePlan(p) // the in-flight step completes…
    expect(p.status).toBe('cancelled') // …and THEN the run stops
    expect(p.steps[0].state).toBe('done')
    expect(p.steps.slice(1).every((s) => s.state === 'queued')).toBe(true)
  })
})

describe('execution reducers', () => {
  it('walks approve → confirming → done per step, arming the next', () => {
    let p = startPlan(compilePlan(twoChainDraft()))
    expect(currentStep(p)?.state).toBe('approve')
    p = advancePlan(p)
    expect(currentStep(p)?.state).toBe('confirming')
    p = advancePlan(p)
    expect(p.steps[0].state).toBe('done')
    expect(p.steps[1].state).toBe('approve')
  })

  it('completes with every step done', () => {
    const p = runToCompletion(compilePlan(twoChainDraft()))
    expect(p.status).toBe('done')
    expect(p.steps.every((s) => s.state === 'done')).toBe(true)
    expect(planProgress(p)).toEqual({ done: p.steps.length, total: p.steps.length })
  })

  it('a failed step blocks until retried, then completes', () => {
    let p = startPlan(compilePlan(twoChainDraft()))
    p = failCurrent(p)
    expect(p.steps[0].state).toBe('failed')
    const stuck = advancePlan(p)
    expect(stuck.steps[0].state).toBe('failed') // no silent progress past a failure
    p = retryStep(p, p.steps[0].id)
    expect(p.steps[0].state).toBe('approve')
    expect(runToCompletion(p).status).toBe('done')
  })

  it('cancel keeps finished steps and stops the run', () => {
    let p = startPlan(compilePlan(twoChainDraft()))
    p = advancePlan(advancePlan(p)) // first step done, second armed
    p = cancelPlan(p)
    expect(p.status).toBe('cancelled')
    expect(p.steps[0].state).toBe('done')
    expect(advancePlan(p)).toEqual(p) // cancelled plans never advance
  })

  it('resumes from persisted state mid-run', () => {
    const s = fakeStorage()
    let p = startPlan(compilePlan(twoChainDraft()))
    p = advancePlan(p) // first step confirming
    saveExec('0xabc', p, s)
    const back = loadExec('0xABC', s)
    expect(back?.status).toBe('running')
    expect(back && currentStep(back)?.state).toBe('confirming')
    expect(back && runToCompletion(back).status).toBe('done')
  })
})

describe('execution channel (blend spec)', () => {
  it('defaults to market and only market is executable pre-E2', () => {
    expect(channelExecutable('market')).toBe(true)
    // FAILS CLOSED with no chain: a caller that has not proven where it is does
    // not get to offer a limit order. This preserves the pre-CoW behaviour, so
    // the per-chain change can only widen the gate where a caller opts in.
    expect(channelExecutable('limit')).toBe(false)
    expect(channelExecutable('slices')).toBe(false)

    // Per-chain, now that limit orders ride CoW (owner 2026-08-02).
    expect(channelExecutable('limit', 1)).toBe(true)
    expect(channelExecutable('limit', 8453)).toBe(true)
    // CoW has NO CODE on 4663, where every live basket is. Offering "only at
    // your price" there would be a control that can never fill.
    expect(channelExecutable('limit', 4663)).toBe(false)
    // slices is false EVERYWHERE: a CoW TWAP needs a contract owner, and our
    // users are EOAs.
    expect(channelExecutable('slices', 1)).toBe(false)
    expect(channelExecutable('slices', 8453)).toBe(false)
  })

  it('setChannel round-trips through save/load', () => {
    const store = fakeStorage()
    const d = setChannel(emptyDraft(1), 'limit', 2)
    saveDraft('0xabc', d, store)
    expect(loadDraft('0xabc', store)?.channel).toBe('limit')
  })

  it('load drops unknown channel values (URL-intent law)', () => {
    const store = fakeStorage()
    store.setItem(
      'spectrum:allocation:draft:0xabc',
      JSON.stringify({ ...emptyDraft(1), channel: 'yolo' }),
    )
    // ⚠ same `?.` class as submission-store:407 — a draft REFUSED outright
    // would satisfy `?.channel === undefined` just as well as one loaded with
    // the bad channel dropped, and those are different behaviours. The law is
    // "load DROPS the unknown value", not "load refuses the draft".
    const loaded = loadDraft('0xabc', store)
    expect(loaded, 'the draft must still LOAD — refusing it is not dropping the channel').toBeDefined()
    expect(loaded?.channel).toBeUndefined()
  })
})

describe('rebalance funding (PM audit 2)', () => {
  it('funding survives save/load and keeps a zero amount valid', () => {
    const store = fakeStorage()
    const d = { ...emptyDraft(1), targets: [{ asset: A(8453, 'KEEP'), weight: 100 }], amountUsd: 0, funding: { soldUsd: 412.5 } }
    saveDraft('0xabc', d, store)
    const back = loadDraft('0xabc', store)
    expect(back?.funding?.soldUsd).toBe(412.5)
    expect(back?.amountUsd).toBe(0) // valid BECAUSE funding marks a rebalance
  })

  it('zero amount without funding still loads as null (picker flow unchanged)', () => {
    const store = fakeStorage()
    const d = { ...emptyDraft(1), targets: [{ asset: A(8453, 'KEEP'), weight: 100 }], amountUsd: 0 }
    saveDraft('0xabc', d, store)
    expect(loadDraft('0xabc', store)?.amountUsd).toBeNull()
  })
})

describe('named plans (feature 6)', () => {
  // real-hex fixture addresses — the read-time validator rightly refuses
  // anything else (same rule the draft fixtures follow)
  const HEX: Record<string, string> = { WETH: '11', DEGEN: '22', AAVE: '33', X: '44', PONS: '55' }
  const A = (symbol: string): AllocAsset => ({ chainId: 8453, address: `0x${(HEX[symbol] ?? '66').repeat(20)}`, symbol })
  it('round-trips, overwrites by name case-insensitively, deletes', () => {
    const store = fakeStorage()
    saveNamedPlan('0xAB', { name: 'Aggressive', targets: [{ asset: A('WETH'), weight: 60 }, { asset: A('DEGEN'), weight: 40 }], savedAt: 5 }, store)
    saveNamedPlan('0xAB', { name: 'aggressive', targets: [{ asset: A('WETH'), weight: 50 }, { asset: A('AAVE'), weight: 50 }], savedAt: 9 }, store)
    const plans = loadNamedPlans('0xAB', store)
    expect(plans).toHaveLength(1)
    expect(plans[0].targets.map((t) => t.asset.symbol)).toEqual(['WETH', 'AAVE'])
    deleteNamedPlan('0xAB', 'AGGRESSIVE', store)
    expect(loadNamedPlans('0xAB', store)).toHaveLength(0)
  })
  it('junk rows sanitize away', () => {
    const store = fakeStorage()
    store.setItem('spectrum:plans:0xab', JSON.stringify([{ name: '', targets: [] }, { name: 'ok', targets: [{ asset: A('X'), weight: 1 }] }]))
    expect(loadNamedPlans('0xAB', store).map((p) => p.name)).toEqual(['ok'])
  })
})

describe('watchlist (feature 8)', () => {
  const A = (symbol: string): AllocAsset => ({ chainId: 8453, address: `0x${'55'.repeat(20)}`, symbol })
  it('toggles on, reports, toggles off', () => {
    const store = fakeStorage()
    expect(toggleWatch('0xCD', A('PONS'), store)).toBe(true)
    expect(isWatched('0xCD', A('PONS'), store)).toBe(true)
    expect(loadWatchlist('0xCD', store)).toHaveLength(1)
    expect(toggleWatch('0xCD', A('PONS'), store)).toBe(false)
    expect(loadWatchlist('0xCD', store)).toHaveLength(0)
  })
})

describe('holdings-backed publish (seedFrom) invariants', () => {
  const seeded = (): ReturnType<typeof emptyDraft> => ({
    ...emptyDraft(1),
    intent: 'publish' as const,
    targets: [
      { asset: A(1, 'WETH'), weight: 60 },
      { asset: A(8453, 'AAVE'), weight: 40 },
    ],
    amountUsd: 500,
    seedFrom: [
      { chainId: 1, address: A(1, 'WETH').address, symbol: 'WETH', heldUsd: 300 },
      { chainId: 8453, address: A(8453, 'AAVE').address, symbol: 'AAVE', heldUsd: 200 },
    ],
  })

  it('adding an asset degrades to buy-shaped: the marker drops (an add is money the wallet does not hold)', () => {
    const d = addTarget(seeded(), A(1, 'PONS'), 2)
    expect(d.targets).toHaveLength(3)
    expect(d.seedFrom).toBeUndefined()
  })

  it('removing a picked leg stays holdings-backed: its row leaves and the pinned amount follows', () => {
    const d = removeTarget(seeded(), A(1, 'WETH'), 2)
    expect(d.targets.map((t) => t.asset.symbol)).toEqual(['AAVE'])
    expect(d.seedFrom).toHaveLength(1)
    expect(d.seedFrom![0].symbol).toBe('AAVE')
    expect(d.amountUsd).toBe(200)
  })

  it('removing the LAST picked leg clears the marker rather than leaving an empty claim', () => {
    let d = removeTarget(seeded(), A(1, 'WETH'), 2)
    d = removeTarget(d, A(8453, 'AAVE'), 3)
    expect(d.targets).toHaveLength(0)
    expect(d.seedFrom).toBeUndefined()
  })

  it('loadDraft pins amountUsd to the held sum — a stored draft carrying any other number heals (the review derives leg dollars from it)', () => {
    const s = fakeStorage()
    saveDraft('0xabc', { ...seeded(), amountUsd: 50000 }, s)
    const back = loadDraft('0xabc', s)
    expect(back?.seedFrom).toHaveLength(2)
    expect(back?.amountUsd).toBe(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE FEE POLICY, PINNED AGAINST LITERALS.
//
// ⚠ WHY LITERALS AND NOT THE EXPORTED CONSTANT. A test that reads
// `BATCH_FEE_BPS` and asserts arithmetic about it tracks ANY value the constant
// takes — which is right for a conservation law and useless as a policy pin.
// Before this block the fee had NO pin of either kind: 50 → 40 (or → 200, the
// contract's ceiling) passed the whole suite silently. This is the same class as
// the unpinned pool-safety ceiling; a governed number nobody compares to a
// literal is a number nobody is guarding.
//
// If a ruling moves the fee, this block is SUPPOSED to fail. Update it in the
// same commit, citing the recording — that failure is the audit trail.
// ─────────────────────────────────────────────────────────────────────────────
describe('the fee policy', () => {
  it('charges 40 bps — the owner 2026-08-07, down from 50 because 0x takes its own cut on top', () => {
    expect(BATCH_FEE_BPS).toBe(40)
  })

  it('stays far under the contract ceiling it cannot rely on (MAX_FEE_BPS = 200 permits 5x this)', () => {
    expect(BATCH_FEE_BPS).toBeLessThan(200)
  })

  it("models 0x's own taker fee at 15 bps — measured, not ours, and not waivable", () => {
    expect(ZEROEX_TAKER_FEE_BPS).toBe(15)
  })

  it('reports 55 bps all-in on the 0x path and 40 off it — a route 0x never saw pays only ours', () => {
    expect(allInFeeBps(true)).toBe(55)
    expect(allInFeeBps(false)).toBe(40)
    expect(allInFeeBps(false)).toBe(BATCH_FEE_BPS)
  })

  it('formats every shown percentage from the charged number, to two places', () => {
    expect(feePctLabel(BATCH_FEE_BPS)).toBe('0.40%')
    expect(feePctLabel(ZEROEX_TAKER_FEE_BPS)).toBe('0.15%')
    expect(feePctLabel(allInFeeBps(true))).toBe('0.55%')
    // the formatter must not round a governed number away: 5 bps is 0.05%, not 0.1%
    expect(feePctLabel(5)).toBe('0.05%')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A12 SURVIVOR PINS — the persisted-read validators (five-module sweep,
// 2026-08-14). loadDraft/loadPortfolio sanitize UNTRUSTED storage; the sweep
// proved most validator conjunctions had no case driving the specific field
// they guard, so any `&&` could relax to `||` unnoticed. One table, one law:
// a corrupt field DROPS its record (or nulls its value), never renders.
// ─────────────────────────────────────────────────────────────────────────────
describe('A12 pins — corrupt persisted fields drop, never render', () => {
  const seed = (over: Record<string, unknown>) => {
    const s = fakeStorage()
    let d = emptyDraft(1)
    d = addTarget(d, A(8453, 'AAVE'))
    d = setAmount(d, 250)
    saveDraft('0xAbC', d, s)
    const raw = JSON.parse(s.getItem('spectrum:allocation:draft:0xabc') as string)
    Object.assign(raw, over)
    s.setItem('spectrum:allocation:draft:0xabc', JSON.stringify(raw))
    return loadDraft('0xabc', s)
  }

  it('funding with a NaN or negative soldUsd drops the whole funding record', () => {
    for (const soldUsd of [Number.NaN, -1, 'x']) {
      const back = seed({ funding: { soldUsd } })
      expect(back?.funding, `soldUsd=${String(soldUsd)}`).toBeUndefined()
    }
    // and soldUsd EXACTLY 0 is legal — "sold nothing" is a fact, not corruption
    expect(seed({ funding: { soldUsd: 0 } })?.funding).toMatchObject({ soldUsd: 0 })
  })

  it('funding sub-fields degrade individually: bad grossBuys/result vanish while soldUsd survives', () => {
    const back = seed({ funding: { soldUsd: 10, grossBuysUsd: -5, resultUsd: 0 } })
    expect(back?.funding).toMatchObject({ soldUsd: 10 })
    expect(back?.funding?.grossBuysUsd).toBeUndefined()
    expect(back?.funding?.resultUsd).toBeUndefined()
  })

  it('a change row with a malformed address or negative money drops — the survivors keep their row', () => {
    const good = { chainId: 8453, address: `0x${'aa'.repeat(20)}`, symbol: 'OK', fromUsd: 1, toUsd: 2 }
    for (const bad of [
      { ...good, address: 'not-hex' },
      { ...good, fromUsd: Number.NaN },
      { ...good, fromUsd: -1 },
      { ...good, toUsd: Number.NaN },
      null,
    ]) {
      const back = seed({ funding: { soldUsd: 10, changes: [bad, good] } })
      expect(back?.funding?.changes, JSON.stringify(bad)).toHaveLength(1)
      expect(back?.funding?.changes?.[0]).toMatchObject({ symbol: 'OK' })
    }
    // decimals outside 0..36 null the field, never invent one
    const back = seed({ funding: { soldUsd: 10, changes: [{ ...good, decimals: 400 }] } })
    expect(back?.funding?.changes?.[0].decimals).toBeUndefined()
  })

  it('ZERO is a legal value for the optional money sub-fields — never dropped as corrupt', () => {
    // grossBuysUsd 0 ("bought nothing back") and decimals 0 (an integer token)
    // are facts, not corruption — the >= bounds must include them
    const back = seed({ funding: { soldUsd: 10, grossBuysUsd: 0 } })
    expect(back?.funding?.grossBuysUsd).toBe(0)
    const good = { chainId: 8453, address: `0x${'aa'.repeat(20)}`, symbol: 'OK', fromUsd: 1, toUsd: 2, decimals: 0, sellRaw: '5' }
    const withChange = seed({ funding: { soldUsd: 10, changes: [good] } })
    expect(withChange?.funding?.changes?.[0].decimals).toBe(0)
  })

  it('a funding.before row with a malformed address drops — the survivors keep theirs', () => {
    const good = { chainId: 8453, address: `0x${'cc'.repeat(20)}`, symbol: 'OK', usd: 3 }
    const back = seed({ funding: { soldUsd: 10, before: [{ ...good, address: 'junk' }, good] } })
    expect(back?.funding?.before).toHaveLength(1)
    expect(back?.funding?.before?.[0]).toMatchObject({ symbol: 'OK' })
  })

  it('a seedFrom row with a bad address or non-positive heldUsd drops', () => {
    const good = { chainId: 8453, address: `0x${'bb'.repeat(20)}`, symbol: 'OK', heldUsd: 5 }
    for (const bad of [{ ...good, address: 'nope' }, { ...good, heldUsd: 0 }, { ...good, heldUsd: Number.NaN }]) {
      const back = seed({ intent: 'publish', funding: undefined, seedFrom: [bad, good] })
      expect(back?.seedFrom, JSON.stringify(bad)).toHaveLength(1)
    }
  })

  it('amountUsd EXACTLY at the plausibility cap survives; a hair over nulls', () => {
    expect(seed({ amountUsd: MAX_PLAUSIBLE_AMOUNT_USD })?.amountUsd).toBe(MAX_PLAUSIBLE_AMOUNT_USD)
    expect(seed({ amountUsd: MAX_PLAUSIBLE_AMOUNT_USD + 1 })?.amountUsd).toBeNull()
  })

  it('loadPortfolio round-trips a healthy book and refuses the corrupt shapes', () => {
    const s = fakeStorage()
    const healthy = { targets: [{ asset: A(8453, 'AAVE'), weight: 1 }], amountUsd: 100, bandPp: 5 }
    s.setItem('spectrum:allocation:portfolio:0xabc', JSON.stringify(healthy))
    const back = loadPortfolio('0xabc', s)
    expect(back).not.toBeNull()
    expect(back?.bandPp).toBe(5)
    // corrupt shapes: no targets array · NaN amount · band out of 1..25 (nulls the band only)
    s.setItem('spectrum:allocation:portfolio:0xabc', JSON.stringify({ ...healthy, targets: 'x' }))
    expect(loadPortfolio('0xabc', s)).toBeNull()
    s.setItem('spectrum:allocation:portfolio:0xabc', JSON.stringify({ ...healthy, amountUsd: Number.NaN }))
    expect(loadPortfolio('0xabc', s)).toBeNull()
    s.setItem('spectrum:allocation:portfolio:0xabc', JSON.stringify({ ...healthy, bandPp: 26 }))
    expect(loadPortfolio('0xabc', s)?.bandPp).toBeUndefined()
    s.setItem('spectrum:allocation:portfolio:0xabc', JSON.stringify({ ...healthy, bandPp: 1 }))
    expect(loadPortfolio('0xabc', s)?.bandPp).toBe(1)
    // the band ceiling is INCLUSIVE at 25 (kills :710 <= → <): the widest
    // ruled band must round-trip, not silently null
    s.setItem('spectrum:allocation:portfolio:0xabc', JSON.stringify({ ...healthy, bandPp: 25 }))
    expect(loadPortfolio('0xabc', s)?.bandPp).toBe(25)
  })

  it('savePortfolioBand on a MISSING portfolio writes NOTHING (kills :718 drop-!)', () => {
    // the inverted-guard mutant writes a junk {bandPp} book for an address
    // that never saved one — and stops saving bands for every real book
    const s = fakeStorage()
    savePortfolioBand('0xnobody', 5, s)
    expect(s.getItem('spectrum:allocation:portfolio:0xnobody')).toBeNull()
    // and on a REAL book it persists (the other half the inversion breaks)
    const healthy = { targets: [{ asset: A(8453, 'AAVE'), weight: 1 }], amountUsd: 100 }
    s.setItem('spectrum:allocation:portfolio:0xabc', JSON.stringify(healthy))
    savePortfolioBand('0xabc', 7, s)
    expect(loadPortfolio('0xabc', s)?.bandPp).toBe(7)
  })

  it('loadPublished with zero surviving targets is NULL, never an empty snapshot (kills :973 > → >=)', () => {
    const s = fakeStorage()
    // positive control FIRST — the same key round-trips a healthy snapshot,
    // so the null below is the sanitizer's verdict, not a mistyped key
    s.setItem('spectrum:allocation:published:0xabc', JSON.stringify({ targets: [{ asset: A(8453, 'AAVE'), weight: 1 }], publishedAt: 1 }))
    expect(loadPublished('0xabc', s)).not.toBeNull()
    s.setItem('spectrum:allocation:published:0xabc', JSON.stringify({ targets: [{ asset: { chainId: 0, address: 'junk', symbol: '' }, weight: 1 }], publishedAt: 1 }))
    expect(loadPublished('0xabc', s)).toBeNull()
  })

  it('a named plan with zero surviving targets drops from the list', () => {
    const s = fakeStorage()
    s.setItem(
      'spectrum:plans:0xabc',
      JSON.stringify([
        { name: 'ok', targets: [{ asset: A(8453, 'AAVE'), weight: 1 }], savedAt: 1 },
        { name: 'hollow', targets: [{ asset: { chainId: 8453, address: 'bad', symbol: 'X' }, weight: 1 }], savedAt: 2 },
      ]),
    )
    const plans = loadNamedPlans('0xabc', s)
    expect(plans.map((p) => p.name)).toEqual(['ok'])
  })
})


describe('batchFeeBpsFor — the per-generation fee resolver (production fee model, 2026-08-16)', () => {
  it('every deployed chain is GENERATION 2 since the gen-3 ceremony (2026-08-16) and resolves to the 25bps rate', () => {
    for (const id of [1, 8453, 4663]) expect(batchFeeBpsFor(id)).toBe(GEN2_BATCH_FEE_BPS)
    // an unscaffolded chain stays gen-1 by default — the resolver's floor
    expect(batchFeeBpsFor(999999)).toBe(BATCH_FEE_BPS)
  })
  it('the gen-2 constant is 25 bps — 0.25% ours, 100% burn (0x’s ~15bps makes ~0.4% all-in)', () => {
    expect(GEN2_BATCH_FEE_BPS).toBe(25)
  })
  it('allInFeeBps composes with the per-generation rate', () => {
    expect(allInFeeBps(true, GEN2_BATCH_FEE_BPS)).toBe(GEN2_BATCH_FEE_BPS + ZEROEX_TAKER_FEE_BPS)
    expect(allInFeeBps(false, GEN2_BATCH_FEE_BPS)).toBe(GEN2_BATCH_FEE_BPS)
  })
})


describe('sanitizer + weight-guard boundaries (A12 sweep, the tail-3 recount)', () => {
  it('the even split of an EMPTY pick set is [] — never a divide-by-zero grid (kills evenWeights :300 <= → <)', () => {
    // evenWeights is private; evenSplit is its public face. An empty draft
    // must come back empty, not NaN-weighted.
    const d = evenSplit(emptyDraft(1))
    expect(d.targets).toEqual([])
    // and the 3-way split is exact-100 largest-remainder
    let e = emptyDraft(1)
    e = addTarget(e, A(1, 'AAA'), 2)
    e = addTarget(e, A(1, 'BBB'), 3)
    e = addTarget(e, A(1, 'CCC'), 4)
    expect(evenSplit(e).targets.map((t) => t.weight)).toEqual([34, 33, 33])
  })

  it('a NEGATIVE weight sanitizes to 0 before percentages — never a negative width (kills :385 > → >= and && → ||)', () => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'AAVE'), 2)
    d = addTarget(d, A(1, 'LINK'), 3)
    d = { ...d, targets: [{ ...d.targets[0], weight: -5 }, { ...d.targets[1], weight: 50 }] }
    const rows = normalizedTargets(d)
    expect(rows[0].pct).toBe(0)
    expect(rows[1].pct).toBe(100)
  })

  it('a $0 balance row SURVIVES the funding sanitizer — zero is a real balance, not junk (kills :549 >= → >)', () => {
    const st = fakeStorage()
    const healthy = {
      targets: [{ asset: A(1, 'AAVE'), weight: 1 }],
      amountUsd: 100,
      funding: { grossBuysUsd: 100, soldUsd: 0, resultUsd: 100, before: [{ chainId: 1, address: A(1, 'USDC').address, symbol: 'USDC', usd: 0 }] },
    }
    st.setItem('spectrum:allocation:draft:0xabc', JSON.stringify(healthy))
    const back = loadDraft('0xabc', st)
    expect(back?.funding?.before?.some((b) => b.usd === 0)).toBe(true)
  })

  it('decimals exactly 36 survives the change sanitizer; 37 drops (kills :584 <= → <)', () => {
    const st = fakeStorage()
    const change = { chainId: 1, address: A(1, 'AAVE').address, symbol: 'AAVE', fromUsd: 1, toUsd: 2, decimals: 36 }
    const healthy = { targets: [{ asset: A(1, 'AAVE'), weight: 1 }], amountUsd: 100, funding: { grossBuysUsd: 100, soldUsd: 0, resultUsd: 100, changes: [change] } }
    st.setItem('spectrum:allocation:draft:0xabc', JSON.stringify(healthy))
    expect(loadDraft('0xabc', st)?.funding?.changes?.[0]?.decimals).toBe(36)
    st.setItem('spectrum:allocation:draft:0xabc', JSON.stringify({ ...healthy, funding: { ...healthy.funding, changes: [{ ...change, decimals: 37 }] } }))
    expect(loadDraft('0xabc', st)?.funding?.changes?.[0]?.decimals).toBeUndefined()
  })

  it('a 0-amount draft with NO funding loads amountUsd null — zero is not an amount to spend (kills :631 > → >=)', () => {
    const st = fakeStorage()
    st.setItem('spectrum:allocation:draft:0xabc', JSON.stringify({ targets: [{ asset: A(1, 'AAVE'), weight: 1 }], amountUsd: 0 }))
    expect(loadDraft('0xabc', st)?.amountUsd).toBeNull()
  })

  it('an EMPTY-target guest draft is never adopted — the next guest must not inherit stray fields (kills :697 > → >=)', () => {
    const st = fakeStorage()
    st.setItem('spectrum:allocation:draft:guest', JSON.stringify({ targets: [], amountUsd: 500, name: 'stray' }))
    adoptGuestDraft('0xfresh', st)
    expect(loadDraft('0xfresh', st)).toBeNull()
  })
})

describe('the flip-eve survivor round (2026-08-16) — the two real gaps', () => {
  it('ALL-ZERO weights normalize to zeros, never NaN — 0/0 must not reach the review (kills allocation:404 <= → <)', () => {
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'A'))
    d = addTarget(d, A(1, 'B'))
    d = setAmount(d, 100)
    const zeroed = { ...d, targets: d.targets.map((t) => ({ ...t, weight: 0 })) }
    const rows = normalizedTargets(zeroed)
    expect(rows.map((t) => t.pct)).toEqual([0, 0])
    expect(rows.map((t) => t.usd)).toEqual([0, 0])
  })

  it('a seedFrom that filters to EMPTY does not hijack the stored amount to $0 (kills allocation:631 > → >=)', () => {
    // stored rows can all fail the heldUsd filter; the draft's own amount must
    // then stand — the holdings pin only binds when holdings actually seeded
    const s = fakeStorage()
    let d = emptyDraft(1)
    d = addTarget(d, A(1, 'AAVE'))
    d = setAmount(d, 250)
    saveDraft('0xAbC', d, s)
    const key = 'spectrum:allocation:draft:0xabc'
    const raw = JSON.parse(s.getItem(key)!)
    raw.amountUsd = 500
    raw.intent = 'publish' // the seed path only reads on a publish draft with no funding
    raw.seedFrom = [{ chainId: 1, address: `0x${'a'.repeat(40)}`, symbol: 'GONE', heldUsd: 0 }]
    s.setItem(key, JSON.stringify(raw))
    const back = loadDraft('0xabc', s)
    expect(back?.seedFrom).toBeUndefined()
    expect(back?.amountUsd).toBe(500)
  })
})
