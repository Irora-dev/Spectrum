import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  activeStep,
  advanceStep,
  buildThesisBuyRun,
  buildThesisSellRun,
  clearThesisRun,
  DEMO_BUY_REFUSAL,
  DEMO_SELL_REFUSAL,
  INTERRUPTED_MID_SIGNATURE_NOTE,
  loadThesisRun,
  retryStep,
  runProgress,
  saveThesisRun,
  setStepAmount,
  stepIdOf,
} from './thesis-run'
import { thesisRunKey, type LegFunding, type ThesisRun, type ThesisSellPlan } from './thesis-run-types'

// ─────────────────────────────────────────────────────────────────────────────
// The sequencer is the piece that turns a funding plan into the exact ordered
// list of things a wallet will be asked to sign — so every law here is about
// money order or money memory: bridges fire before buys (their minutes overlap
// the rest), a refused leg is shown rather than dropped, a real run never arms
// against a synthetic address, and a resume never pretends to know whether an
// interrupted signature landed.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 8453
const ETH = 1
const RH = 4663
const T0 = 1_770_000_000_000

const SIGNER = '0x00000000000000000000000000000000000000ab' as Address
const DEP = '0x00000000000000000000000000000000000000c0'
// matches THESIS_DEMO_ADDR_RE (…de50 + 4 hex at the end)
const DEMO_ADDR = '0x00000000000000000000000000000000de50beef' as Address

const addrFor = (chainId: number): Address => `0x${chainId.toString(16).padStart(40, '0')}` as Address
const leg = (chainId: number, address: Address = addrFor(chainId)) => ({ chainId, address })

const funded = (chainId: number, over: Partial<LegFunding> = {}): LegFunding => ({
  chainId,
  needCents: 10_000,
  haveCents: 10_000,
  shortfallCents: 0,
  bridge: null,
  gasOk: true,
  note: null,
  ...over,
})
const short = (chainId: number, fromChainId: number, amountCents = 5_000): LegFunding =>
  funded(chainId, {
    haveCents: 5_000,
    shortfallCents: amountCents,
    bridge: { fromChainId, amountCents, refuelWeiNeeded: null },
  })

const buy = (
  legs: { chainId: number; address: Address }[],
  fundings: LegFunding[],
  over: Partial<Parameters<typeof buildThesisBuyRun>[0]> = {},
) => buildThesisBuyRun({ ref: 'bullish-evm', deployer: DEP, signer: SIGNER, amountCents: 30_000, legs, fundings, demo: false, now: () => T0, ...over })

const asRun = (r: ThesisRun | { refused: string }): ThesisRun => {
  if ('refused' in r) throw new Error(`unexpected refusal: ${r.refused}`)
  return r
}
const kinds = (r: ThesisRun) => r.steps.map((s) => s.kind)

const sellPlan = (over: Partial<ThesisSellPlan> = {}): ThesisSellPlan => ({
  steps: [
    { chainId: ETH, address: addrFor(ETH), sellRaw: 10n ** 18n, estCents: 5_000 },
    { chainId: BASE, address: addrFor(BASE), sellRaw: 2n * 10n ** 18n, estCents: 9_000 },
  ],
  consolidate: null,
  ...over,
})

const sell = (plan: ThesisSellPlan, over: Partial<Parameters<typeof buildThesisSellRun>[0]> = {}) =>
  buildThesisSellRun({ ref: 'bullish-evm', deployer: DEP, signer: SIGNER, plan, legs: [leg(ETH), leg(BASE)], demo: false, now: () => T0, ...over })

// Persistence takes the full Storage interface, so the fake implements it all.
const fakeStorage = (): Storage => {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, v),
  }
}
const KEY = thesisRunKey(SIGNER, 'bullish-evm', 'buy')

describe('buy composition — bridges first, then per-leg switch/await/buy', () => {
  it('fires every bridge before any buy, grouped by source with one switch per source', () => {
    // ETH's shortfall bridges from BASE; RH's bridges from ETH — two groups.
    const r = asRun(buy([leg(ETH), leg(RH)], [short(ETH, BASE), short(RH, ETH)]))
    expect(kinds(r)).toEqual(['switch', 'bridge', 'switch', 'bridge', 'await-bridge', 'buy', 'switch', 'await-bridge', 'buy'])
    // ids are the resume contract — pin them exactly, never index-derived
    expect(r.steps.map((s) => s.id)).toEqual([
      'switch:8453:src',
      'bridge:1',
      'switch:1:src',
      'bridge:4663',
      'await-bridge:1',
      'buy:1',
      'switch:4663',
      'await-bridge:4663',
      'buy:4663',
    ])
    // the bridge step signs on the SOURCE and funds the LEG
    const b = r.steps.find((s) => s.id === 'bridge:1')!
    expect(b.bridgeFromChainId).toBe(BASE)
    expect(b.chainId).toBe(ETH)
    expect(b.amountCents).toBe(5_000)
    expect(b.legAddress).toBe(addrFor(ETH))
  })

  it('collapses adjacent duplicate switches — the last bridge source flows into the first buy', () => {
    // bridge group leaves the wallet on ETH, and the first leg to buy IS ETH:
    // a second switch:1 would ask the wallet for the chain it is already on.
    const r = asRun(buy([leg(ETH), leg(RH)], [short(ETH, BASE), short(RH, ETH)]))
    expect(r.steps.filter((s) => s.kind === 'switch' && s.chainId === ETH)).toHaveLength(1)
  })

  it('places each await-bridge immediately before its own leg buy, not at the bridge', () => {
    const r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), short(ETH, BASE)]))
    const ids = r.steps.map((s) => s.id)
    expect(ids.indexOf('await-bridge:1')).toBe(ids.indexOf('buy:1') - 1)
    // and every bridge precedes every buy — the whole point of phase 1
    const lastBridge = Math.max(...r.steps.map((s, i) => (s.kind === 'bridge' ? i : -1)))
    const firstBuy = r.steps.findIndex((s) => s.kind === 'buy')
    expect(lastBridge).toBeLessThan(firstBuy)
  })

  it('THE BOUNDARY: a zero-shortfall thesis composes NO bridge and NO await steps', () => {
    // this test exists to fail if bridges were ever unconditionally emitted —
    // a wallet that already holds every leg's funds signs exactly 2 steps/leg
    const r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), funded(ETH)]))
    expect(kinds(r)).toEqual(['switch', 'buy', 'switch', 'buy'])
    expect(r.steps.some((s) => s.kind === 'bridge' || s.kind === 'await-bridge')).toBe(false)
  })

  it('a refused leg appears as ONE skipped buy step with its note — shown, never dropped', () => {
    const noRoute = funded(ETH, { note: 'No bridge route reaches this chain.', bridge: { fromChainId: BASE, amountCents: 5_000, refuelWeiNeeded: null } })
    const r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), noRoute]))
    // the skipped leg's bridge must NOT fire — money for a leg that will not buy
    expect(r.steps.some((s) => s.kind === 'bridge')).toBe(false)
    const skipped = r.steps.find((s) => s.id === 'buy:1')!
    expect(skipped.state).toBe('skipped')
    expect(skipped.note).toBe('No bridge route reaches this chain.')
    // every leg in the input appears in the run
    expect(r.steps.filter((s) => s.kind === 'buy').map((s) => s.chainId).sort()).toEqual([ETH, BASE].sort())
    // and no switch is spent on a chain with nothing to do
    expect(r.steps.filter((s) => s.kind === 'switch').map((s) => s.chainId)).toEqual([BASE])
  })

  it('gasOk=false with a null note still yields an honest sentence on the skipped step', () => {
    const r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), funded(ETH, { gasOk: false })]))
    const skipped = r.steps.find((s) => s.id === 'buy:1')!
    expect(skipped.state).toBe('skipped')
    expect(skipped.note).toBeTruthy()
  })

  it('REFUSAL LAW: a real run against a synthetic leg refuses with the exact sentence', () => {
    expect(buy([leg(BASE), leg(ETH, DEMO_ADDR)], [funded(BASE), funded(ETH)])).toEqual({ refused: DEMO_BUY_REFUSAL })
  })

  it('demo=true composes the same steps and says demo on the run', () => {
    const r = asRun(buy([leg(BASE), leg(ETH, DEMO_ADDR)], [funded(BASE), funded(ETH)], { demo: true }))
    expect(r.demo).toBe(true)
    expect(kinds(r)).toEqual(['switch', 'buy', 'switch', 'buy'])
  })

  it('refuses a non-positive, fractional or unreadable amount', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = buy([leg(BASE)], [funded(BASE)], { amountCents: bad })
      expect('refused' in r, `amount ${bad}`).toBe(true)
    }
  })

  it('refuses a funding plan that does not match the legs — never composes over a disagreement', () => {
    // a funding for a chain with no leg: no address to buy
    expect('refused' in buy([leg(BASE)], [funded(BASE), funded(ETH)])).toBe(true)
    // a leg with no funding: composing would silently drop it
    expect('refused' in buy([leg(BASE), leg(ETH)], [funded(BASE)])).toBe(true)
    // two legs on one chain: the chainId join is ambiguous
    expect('refused' in buy([leg(BASE), leg(BASE, addrFor(ETH))], [funded(BASE)])).toBe(true)
  })

  it('takes startedAt from the injected clock exactly once', () => {
    expect(asRun(buy([leg(BASE)], [funded(BASE)])).startedAt).toBe(T0)
  })
})

describe('sell composition — switch/sell pairs, then the optional consolidation', () => {
  it('composes [switch, sell] per plan step in plan order, carrying sellRaw not cents', () => {
    const r = asRun(sell(sellPlan()))
    expect(kinds(r)).toEqual(['switch', 'sell', 'switch', 'sell'])
    const s = r.steps.find((x) => x.kind === 'sell' && x.chainId === ETH)!
    expect(s.sellRaw).toBe(10n ** 18n)
    // the contract's rule: sells carry raw; estCents stays display-side
    expect(s.amountCents).toBeUndefined()
    expect(r.amountCents).toBe(0)
    expect(r.direction).toBe('sell')
  })

  it('consolidation bridges each proceeds chain home — home chain excluded, amount left for the UI', () => {
    const r = asRun(sell(sellPlan({ consolidate: { toChainId: BASE } })))
    // last sell happened on BASE (home) — only ETH's proceeds travel
    expect(kinds(r)).toEqual(['switch', 'sell', 'switch', 'sell', 'switch', 'consolidate'])
    const c = r.steps.find((s) => s.kind === 'consolidate')!
    expect(c.id).toBe('consolidate:8453:from:1')
    expect(c.chainId).toBe(BASE) // destination, same convention as buy bridges
    expect(c.bridgeFromChainId).toBe(ETH) // where it signs
    expect(c.amountCents).toBeUndefined() // unknown until the sells land
    // and the switch before it targets the SOURCE chain
    expect(r.steps[4]).toMatchObject({ kind: 'switch', chainId: ETH })
  })

  it('consolidate: null keeps proceeds where they land — no extra steps', () => {
    expect(kinds(asRun(sell(sellPlan())))).not.toContain('consolidate')
  })

  it('REFUSAL LAW on the sell side — legs AND the plan steps themselves are checked', () => {
    expect(sell(sellPlan(), { legs: [leg(ETH, DEMO_ADDR)] })).toEqual({ refused: DEMO_SELL_REFUSAL })
    const syntheticPlan = sellPlan({ steps: [{ chainId: ETH, address: DEMO_ADDR, sellRaw: 1n, estCents: null }] })
    expect(sell(syntheticPlan)).toEqual({ refused: DEMO_SELL_REFUSAL })
    expect('refused' in sell(syntheticPlan, { demo: true, legs: [leg(ETH, DEMO_ADDR)] })).toBe(false)
  })

  it('refuses an empty plan and a zero sell amount rather than composing nothing', () => {
    expect('refused' in sell(sellPlan({ steps: [] }))).toBe(true)
    expect('refused' in sell(sellPlan({ steps: [{ chainId: ETH, address: addrFor(ETH), sellRaw: 0n, estCents: null }] }))).toBe(true)
  })
})

describe('reducers — pure, terminal states frozen, failed exits only via retry', () => {
  const base = () => asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), short(ETH, BASE)]))

  it('advanceStep patches immutably and never touches the input run', () => {
    const r = base()
    const r2 = advanceStep(r, 'buy:8453', { state: 'signing' })
    expect(r2).not.toBe(r)
    expect(r2.steps.find((s) => s.id === 'buy:8453')!.state).toBe('signing')
    expect(r.steps.find((s) => s.id === 'buy:8453')!.state).toBe('queued') // purity
  })

  it('an unknown stepId returns the run unchanged — same reference, nothing corrupted', () => {
    const r = base()
    expect(advanceStep(r, 'buy:999', { state: 'done' })).toBe(r)
  })

  it('done and skipped are terminal: no patch leaves them, no patch touches them at all', () => {
    let r = advanceStep(base(), 'buy:8453', { state: 'done' })
    expect(advanceStep(r, 'buy:8453', { state: 'queued' })).toBe(r)
    expect(advanceStep(r, 'buy:8453', { note: 'rewriting history' })).toBe(r)
    // a plan-time skipped step is equally frozen
    r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), funded(ETH, { note: 'no route', gasOk: true })]))
    expect(advanceStep(r, 'buy:1', { state: 'queued' })).toBe(r)
  })

  it('nothing transitions INTO skipped at runtime — skipped is a plan-time verdict', () => {
    // a runtime skip would erase a money step from progress and fake "finished"
    const r = base()
    expect(advanceStep(r, 'buy:8453', { state: 'skipped' })).toBe(r)
  })

  it('failed exits only via retryStep; its note may still be enriched in place', () => {
    const r = advanceStep(base(), 'buy:8453', { state: 'failed', note: 'User rejected.' })
    expect(advanceStep(r, 'buy:8453', { state: 'done' })).toBe(r)
    expect(advanceStep(r, 'buy:8453', { state: 'queued' })).toBe(r)
    const annotated = advanceStep(r, 'buy:8453', { note: 'User rejected. (insufficient gas)' })
    expect(annotated.steps.find((s) => s.id === 'buy:8453')!.state).toBe('failed')
    const retried = retryStep(r, 'buy:8453')
    const step = retried.steps.find((s) => s.id === 'buy:8453')!
    expect(step.state).toBe('queued')
    expect(step.note).toBeNull()
  })

  it('retryStep refuses non-failed steps and KEEPS bridgeTxHash — a landed send is evidence', () => {
    const r = base()
    expect(retryStep(r, 'buy:8453')).toBe(r) // queued: nothing to retry
    let r2 = advanceStep(r, 'bridge:1', { state: 'failed', note: 'refunded', bridgeTxHash: '0xdead' })
    r2 = retryStep(r2, 'bridge:1')
    expect(r2.steps.find((s) => s.id === 'bridge:1')!.bridgeTxHash).toBe('0xdead')
  })

  it('activeStep is the strictly linear cursor: first non-terminal, skipped jumped, null at the end', () => {
    let r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE, { note: 'no route' }), funded(ETH)]))
    // steps: skipped buy:8453 · switch:1 · buy:1 — the cursor jumps the skip
    expect(activeStep(r)!.id).toBe('switch:1')
    r = advanceStep(r, 'switch:1', { state: 'done' })
    expect(activeStep(r)!.id).toBe('buy:1')
    // an awaiting bridge HOLDS the cursor — v1 is linear by design (bridges
    // already fired first, so their wait overlaps composition by construction)
    const withBridge = advanceStep(base(), 'switch:8453:src', { state: 'done' })
    const awaiting = advanceStep(withBridge, 'bridge:1', { state: 'awaiting' })
    expect(activeStep(awaiting)!.id).toBe('bridge:1')
    r = advanceStep(r, 'buy:1', { state: 'done' })
    expect(activeStep(r)).toBeNull()
  })

  it('runProgress excludes skipped from total and finishes only when every runnable step is done', () => {
    let r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE, { note: 'no route' }), funded(ETH)]))
    expect(runProgress(r)).toEqual({ done: 0, total: 2, failed: 0, finished: false })
    r = advanceStep(r, 'switch:1', { state: 'done' })
    r = advanceStep(r, 'buy:1', { state: 'failed', note: 'rejected' })
    expect(runProgress(r)).toEqual({ done: 1, total: 2, failed: 1, finished: false })
    r = retryStep(r, 'buy:1')
    r = advanceStep(r, 'buy:1', { state: 'done' })
    expect(runProgress(r)).toEqual({ done: 2, total: 2, failed: 0, finished: true })
  })

  it('a run whose every leg refused is finished-with-nothing-to-do (0/0) — pinned as deliberate', () => {
    const r = asRun(buy([leg(BASE)], [funded(BASE, { note: 'no route' })]))
    expect(runProgress(r)).toEqual({ done: 0, total: 0, failed: 0, finished: true })
    expect(activeStep(r)).toBeNull()
  })

  it('setStepAmount fills exactly one late-bound consolidate amount, refusing garbage', () => {
    const r = asRun(sell(sellPlan({ consolidate: { toChainId: BASE } })))
    const id = 'consolidate:8453:from:1'
    const filled = setStepAmount(r, id, 4_950)
    expect(filled.steps.find((s) => s.id === id)!.amountCents).toBe(4_950)
    expect(setStepAmount(r, id, 0)).toBe(r)
    expect(setStepAmount(r, id, 12.5)).toBe(r)
    expect(setStepAmount(r, 'sell:1:' + addrFor(ETH), 100)).toBe(r) // consolidates only
  })
})

describe('persistence — roundtrip, hostile blobs, and the money law on resume', () => {
  it('a buy run roundtrips exactly', () => {
    const s = fakeStorage()
    const r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), short(ETH, BASE)]))
    saveThesisRun(r, s)
    expect(loadThesisRun(SIGNER, 'bullish-evm', 'buy', s)).toEqual(r)
  })

  it('sellRaw survives the JSON roundtrip as a real bigint, past 2^53', () => {
    const s = fakeStorage()
    const big = 123_456_789_012_345_678_901_234_567_890n
    const r = asRun(sell(sellPlan({ steps: [{ chainId: ETH, address: addrFor(ETH), sellRaw: big, estCents: null }] })))
    saveThesisRun(r, s)
    const back = loadThesisRun(SIGNER, 'bullish-evm', 'sell', s)!
    const step = back.steps.find((x) => x.kind === 'sell')!
    expect(typeof step.sellRaw).toBe('bigint')
    expect(step.sellRaw).toBe(big)
    expect(back).toEqual(r)
  })

  it('the key is signer-scoped and the signer match is case-insensitive', () => {
    const s = fakeStorage()
    saveThesisRun(asRun(buy([leg(BASE)], [funded(BASE)])), s)
    expect(loadThesisRun('0x00000000000000000000000000000000000000AB', 'bullish-evm', 'buy', s)).not.toBeNull()
    // another wallet's key holds nothing — one wallet never sees another's run
    expect(loadThesisRun('0x00000000000000000000000000000000000000ff', 'bullish-evm', 'buy', s)).toBeNull()
  })

  it('clearThesisRun removes the run', () => {
    const s = fakeStorage()
    saveThesisRun(asRun(buy([leg(BASE)], [funded(BASE)])), s)
    clearThesisRun(SIGNER, 'bullish-evm', 'buy', s)
    expect(loadThesisRun(SIGNER, 'bullish-evm', 'buy', s)).toBeNull()
  })

  it('hostile blobs read as no-run, never a crash or a wrong resume', () => {
    const good = asRun(buy([leg(BASE)], [funded(BASE)]))
    const blob = () => JSON.parse(JSON.stringify({ ...good, steps: good.steps.map((x) => ({ ...x })) })) as Record<string, unknown>
    const cases: [string, string][] = [
      ['truncated JSON', '{"v":1,"steps":['],
      ['not an object', '"a string"'],
      ['wrong version', JSON.stringify({ ...blob(), v: 2 })],
      ['foreign signer inside the blob', JSON.stringify({ ...blob(), signer: '0x00000000000000000000000000000000000000ff' })],
      ['non-array steps', JSON.stringify({ ...blob(), steps: {} })],
      ['empty steps', JSON.stringify({ ...blob(), steps: [] })],
      ['unknown state', JSON.stringify({ ...blob(), steps: [{ id: 'buy:8453', kind: 'buy', chainId: BASE, state: 'exploded' }] })],
      ['unknown kind', JSON.stringify({ ...blob(), steps: [{ id: 'x:8453', kind: 'teleport', chainId: BASE, state: 'queued' }] })],
      ['duplicate step ids', JSON.stringify({ ...blob(), steps: [
        { id: 'buy:8453', kind: 'buy', chainId: BASE, state: 'queued' },
        { id: 'buy:8453', kind: 'buy', chainId: BASE, state: 'queued' },
      ] })],
      // a NUMBER sellRaw already lost precision — lossy money reads as no-run
      ['numeric sellRaw', JSON.stringify({ ...blob(), direction: 'buy', steps: [{ id: 'sell:1:x', kind: 'sell', chainId: ETH, state: 'queued', sellRaw: 9007199254740993 }] })],
      ['missing demo flag', JSON.stringify({ ...blob(), demo: undefined })],
      // the refusal law at the load seam: a "real" run carrying a synthetic leg
      ['demo address in a real run', JSON.stringify({ ...blob(), steps: [{ id: 'buy:1', kind: 'buy', chainId: ETH, legAddress: DEMO_ADDR, state: 'queued' }] })],
    ]
    for (const [why, raw] of cases) {
      const s = fakeStorage()
      s.setItem(KEY, raw)
      expect(loadThesisRun(SIGNER, 'bullish-evm', 'buy', s), why).toBeNull()
    }
  })

  it('THE MONEY LAW: signing/confirming demote to failed on load with the honest note', () => {
    // the reducer cannot know whether the interrupted signature moved money —
    // the retry must be the user's informed act (submission-store.ts doctrine)
    for (const interrupted of ['signing', 'confirming'] as const) {
      const s = fakeStorage()
      const r = advanceStep(asRun(buy([leg(BASE)], [funded(BASE)])), 'buy:8453', { state: interrupted })
      saveThesisRun(r, s)
      const back = loadThesisRun(SIGNER, 'bullish-evm', 'buy', s)!
      const step = back.steps.find((x) => x.id === 'buy:8453')!
      expect(step.state, interrupted).toBe('failed')
      expect(step.note).toBe(INTERRUPTED_MID_SIGNATURE_NOTE)
    }
  })

  it("'awaiting' survives a reload untouched — bridge-pending re-polls it by txHash", () => {
    const s = fakeStorage()
    let r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), short(ETH, BASE)]))
    r = advanceStep(r, 'bridge:1', { state: 'awaiting', bridgeTxHash: `0x${'ab'.repeat(32)}` })
    saveThesisRun(r, s)
    const back = loadThesisRun(SIGNER, 'bullish-evm', 'buy', s)!
    const bridge = back.steps.find((x) => x.id === 'bridge:1')!
    expect(bridge.state).toBe('awaiting')
    expect(bridge.bridgeTxHash).toBe(`0x${'ab'.repeat(32)}`)
    // and 'active' survives too — no signature was requested yet
    const r2 = advanceStep(r, 'switch:8453:src', { state: 'active' })
    saveThesisRun(r2, s)
    expect(loadThesisRun(SIGNER, 'bullish-evm', 'buy', s)!.steps[0].state).toBe('active')
  })

  it('save is best-effort: a throwing store degrades to no-resume, never breaks the flow', () => {
    const angry = {
      ...fakeStorage(),
      setItem: () => {
        throw new Error('quota')
      },
    } as Storage
    expect(() => saveThesisRun(asRun(buy([leg(BASE)], [funded(BASE)])), angry)).not.toThrow()
  })
})

describe('stepIdOf — the id contract', () => {
  it('is kind:chainId, plus the discriminator where two of a kind share a chain', () => {
    expect(stepIdOf('buy', 8453)).toBe('buy:8453')
    expect(stepIdOf('switch', 1, 'src')).toBe('switch:1:src')
    expect(stepIdOf('consolidate', 8453, 'from:1')).toBe('consolidate:8453:from:1')
  })
})

// ── the convert route (the pay-asset picker, the owner 2026-08-13) ───────────────
describe('convert steps — the pay-asset route composes like a bridge and refuses like one', () => {
  const PAY = '0x4200000000000000000000000000000000000006' as Address
  const converted = (
    chainId: number,
    fromChainId: number,
    over: Partial<NonNullable<LegFunding['convert']>> = {},
  ): LegFunding =>
    funded(chainId, {
      haveCents: 5_000,
      shortfallCents: 5_000,
      convert: {
        fromChainId,
        token: { address: PAY, symbol: 'WETH', decimals: 18 },
        fromAmountRaw: 10n ** 16n,
        quotedToRaw: 51_000_000n,
        quotedToMinRaw: 50_500_000n,
        ...over,
      },
    })

  it('a SAME-CHAIN sale needs no arrival step — it settles in its own transaction', () => {
    const r = asRun(buy([leg(BASE)], [converted(BASE, BASE)]))
    expect(kinds(r)).not.toContain('await-bridge')
    const cv = r.steps.find((s) => s.kind === 'convert')!
    expect(cv.chainId).toBe(BASE)
    expect(cv.bridgeFromChainId).toBe(BASE)
    expect(cv.paySymbol).toBe('WETH')
    expect(cv.payAmountRaw).toBe(10n ** 16n)
    // the settlement cents the sale covers ride as display truth
    expect(cv.amountCents).toBe(5_000)
    expect(kinds(r)).toContain('buy')
  })

  it('a CROSS-CHAIN sale walks the bridge grammar: send on the source, arrival on the leg', () => {
    const r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), converted(ETH, BASE)]))
    const cv = r.steps.find((s) => s.kind === 'convert')!
    expect(cv.chainId).toBe(ETH) // the leg the money FUNDS
    expect(cv.bridgeFromChainId).toBe(BASE) // where the sale signs
    const arrival = r.steps.find((s) => s.kind === 'await-bridge')!
    expect(arrival.chainId).toBe(ETH)
    expect(arrival.bridgeFromChainId).toBe(BASE)
  })

  it('a row carrying BOTH bridge and convert is refused — never a guessed route', () => {
    const both = { ...short(ETH, BASE), convert: converted(ETH, BASE).convert }
    const r = buy([leg(ETH)], [both])
    expect('refused' in r && r.refused).toMatch(/both a bridge and a conversion/)
  })

  it('an unquoted sale never arms: a convert with no quoted floor is refused', () => {
    const r = buy([leg(BASE)], [converted(BASE, BASE, { quotedToMinRaw: 0n })])
    expect('refused' in r && r.refused).toMatch(/no quoted floor/)
  })

  it('a hostile pay token refuses: bad address, empty or oversized symbol, absurd decimals', () => {
    const bad = (token: Partial<{ address: Address; symbol: string; decimals: number }>) =>
      buy([leg(BASE)], [
        converted(BASE, BASE, {
          token: { address: PAY, symbol: 'WETH', decimals: 18, ...token } as never,
        }),
      ])
    expect('refused' in bad({ address: '0xnot-an-address' as Address })).toBe(true)
    expect('refused' in bad({ symbol: '' })).toBe(true)
    expect('refused' in bad({ symbol: 'W'.repeat(25) })).toBe(true)
    expect('refused' in bad({ decimals: 77 })).toBe(true)
  })

  it('payAmountRaw survives the JSON roundtrip as a real bigint, past 2^53', () => {
    const s = fakeStorage()
    const big = 123_456_789_012_345_678_901n
    const r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), converted(ETH, BASE, { fromAmountRaw: big })]))
    saveThesisRun(r, s)
    const back = loadThesisRun(SIGNER, 'bullish-evm', 'buy', s)!
    const cv = back.steps.find((x) => x.kind === 'convert')!
    expect(typeof cv.payAmountRaw).toBe('bigint')
    expect(cv.payAmountRaw).toBe(big)
    expect(back).toEqual(r)
  })

  it('a convert that lost its quartet in storage reads as NO-RUN — the wallet never signs garbage', () => {
    const s = fakeStorage()
    const r = asRun(buy([leg(BASE), leg(ETH)], [funded(BASE), converted(ETH, BASE)]))
    saveThesisRun(r, s)
    const key = thesisRunKey(SIGNER, 'bullish-evm', 'buy')
    const blob = JSON.parse(s.getItem(key)!) as { steps: Record<string, unknown>[] }
    // a JSON NUMBER where the bigint string belongs: past 2^53 it has already
    // lost precision, so the whole run must read as no-run
    for (const st of blob.steps) if (st.kind === 'convert') st.payAmountRaw = 12345
    s.setItem(key, JSON.stringify(blob))
    expect(loadThesisRun(SIGNER, 'bullish-evm', 'buy', s)).toBeNull()
    // and a MISSING member of the quartet is the same refusal
    saveThesisRun(r, s)
    const blob2 = JSON.parse(s.getItem(key)!) as { steps: Record<string, unknown>[] }
    for (const st of blob2.steps) if (st.kind === 'convert') delete st.paySymbol
    s.setItem(key, JSON.stringify(blob2))
    expect(loadThesisRun(SIGNER, 'bullish-evm', 'buy', s)).toBeNull()
  })
})
