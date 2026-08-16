import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { ThesisRun, ThesisRunStep, ThesisStepKind, ThesisStepState } from '../../lib/spectrum/thesis-run-types'
import {
  announceStep,
  centsToUsdcRaw,
  chainLabel,
  demoFundings,
  demoTick,
  deriveLanes,
  describeStep,
  elapsedLabel,
  firstUnsettledStep,
  landedRows,
  laneTone,
  payAssetTotal,
  primaryActionLabel,
  rawToCentsFloor,
  runFraction,
  runTotalCents,
  usdCents,
  type LaneLeg,
} from './run-lanes'

// ─────────────────────────────────────────────────────────────────────────────
// ThesisRunOverlay's model, driven headline state by headline state. The house
// suite is node-environment pure tests (no component rig), so the overlay's
// logic lives in run-lanes.ts and THIS is where each state the brief names —
// queued, awaiting, failed, skipped, success — is pinned against a hand-built
// ThesisRun. The component renders lanes verbatim; what passes here is what
// the screen says.
// ─────────────────────────────────────────────────────────────────────────────

const ADDR_BASE = '0x1111111111111111111111111111111111111111'
const ADDR_ETH = '0x2222222222222222222222222222222222222222'
const SIGNER = '0x00000000000000000000000000000000000000aa' as Address

const LEGS: LaneLeg[] = [
  { chainId: 8453, address: ADDR_BASE, symbol: 'AISC' },
  { chainId: 1, address: ADDR_ETH, symbol: 'AISC' },
]

function step(
  kind: ThesisStepKind,
  chainId: number,
  state: ThesisStepState = 'queued',
  extra: Partial<ThesisRunStep> = {},
): ThesisRunStep {
  return { id: `${kind}:${chainId}`, kind, chainId, state, ...extra }
}

/** A two-network buy: Base funded locally, Ethereum short → bridged from Base. */
function buyRun(states?: Partial<Record<string, ThesisStepState>>, patch?: Record<string, Partial<ThesisRunStep>>): ThesisRun {
  const steps: ThesisRunStep[] = [
    step('switch', 8453),
    step('buy', 8453, 'queued', { legAddress: ADDR_BASE as Address, amountCents: 30_000 }),
    step('switch', 1),
    step('bridge', 1, 'queued', { amountCents: 20_000, bridgeFromChainId: 8453 }),
    step('await-bridge', 1, 'queued', { bridgeFromChainId: 8453 }),
    step('buy', 1, 'queued', { legAddress: ADDR_ETH as Address, amountCents: 20_000 }),
  ].map((s) => ({ ...s, state: states?.[s.id] ?? s.state, ...(patch?.[s.id] ?? {}) }))
  return {
    v: 1,
    ref: 'ai-supercycle-abcd1234',
    deployer: '0x00000000000000000000000000000000000000cc',
    direction: 'buy',
    signer: SIGNER,
    amountCents: 50_000,
    steps,
    startedAt: 1_700_000_000_000,
    demo: false,
  }
}

describe('money unit crossings', () => {
  it('cents → 6dp settlement raw', () => {
    expect(centsToUsdcRaw(13_588)).toBe(135_880_000n)
    expect(centsToUsdcRaw(1)).toBe(10_000n)
    expect(centsToUsdcRaw(0)).toBe(0n)
    expect(centsToUsdcRaw(-5)).toBe(0n)
    expect(centsToUsdcRaw(Number.NaN)).toBe(0n)
  })

  it('raw → cents floors, never rounds a landing up', () => {
    expect(rawToCentsFloor(135_889_999n)).toBe(13_588)
    expect(rawToCentsFloor(9_999n)).toBe(0)
    expect(rawToCentsFloor(0n)).toBe(0)
    expect(rawToCentsFloor(-1n)).toBe(0)
  })

  it('prints exact dollars, never compacted', () => {
    expect(usdCents(13_588)).toBe('$135.88')
    expect(usdCents(120_000)).toBe('$1,200.00')
    expect(usdCents(Number.NaN)).toBe('$0.00')
  })
})

describe('elapsedLabel', () => {
  const t0 = 1_700_000_000_000
  it('seconds under 90s, then minutes, then hours', () => {
    expect(elapsedLabel(t0, t0 + 42_000)).toBe('42s')
    expect(elapsedLabel(t0, t0 + 4 * 60_000)).toBe('4m')
    expect(elapsedLabel(t0, t0 + 72 * 60_000)).toBe('1h 12m')
  })
  it('clamps a skewed clock to 0s instead of printing negative time', () => {
    expect(elapsedLabel(t0 + 60_000, t0)).toBe('0s')
  })
})

describe('chainLabel', () => {
  it('names configured chains from the app config', () => {
    expect(chainLabel(8453)).toBe('Base')
    expect(chainLabel(1)).toBe('Ethereum')
  })
  it('never dresses an unknown chain in another chain’s name', () => {
    expect(chainLabel(999_999)).toBe('network 999999')
    expect(chainLabel(Number.NaN)).toBe('network an unknown network')
  })
})

describe('deriveLanes', () => {
  it('one lane per network, in step order, joined to its leg and its dollars', () => {
    const lanes = deriveLanes(buyRun(), LEGS)
    expect(lanes.map((l) => l.chainId)).toEqual([8453, 1])
    expect(lanes[0].legSymbol).toBe('AISC')
    expect(lanes[0].legAddress).toBe(ADDR_BASE)
    expect(lanes[0].dollarsCents).toBe(30_000)
    expect(lanes[1].dollarsCents).toBe(20_000)
    expect(lanes[0].steps.map((s) => s.kind)).toEqual(['switch', 'buy'])
    expect(lanes[1].steps.map((s) => s.kind)).toEqual(['switch', 'bridge', 'await-bridge', 'buy'])
    expect(lanes.every((l) => l.tone === 'queued')).toBe(true)
  })

  it('a bridge in flight reads as awaiting, with its note surfaced', () => {
    const lanes = deriveLanes(
      buyRun(
        { 'switch:8453': 'done', 'buy:8453': 'done', 'switch:1': 'done', 'bridge:1': 'done', 'await-bridge:1': 'awaiting' },
        { 'await-bridge:1': { note: 'in flight' } },
      ),
      LEGS,
    )
    expect(lanes[0].tone).toBe('done')
    expect(lanes[1].tone).toBe('awaiting')
    expect(lanes[1].note).toBe('in flight')
  })

  it('a failure outranks everything and carries the honest sentence', () => {
    const lanes = deriveLanes(
      buyRun({ 'switch:1': 'done', 'bridge:1': 'failed' }, { 'bridge:1': { note: 'The route refused.' } }),
      LEGS,
    )
    expect(lanes[1].tone).toBe('failed')
    expect(lanes[1].note).toBe('The route refused.')
  })

  it('a refused leg is shown as skipped, never hidden and never done', () => {
    const lanes = deriveLanes(
      buyRun(
        { 'switch:1': 'skipped', 'bridge:1': 'skipped', 'await-bridge:1': 'skipped', 'buy:1': 'skipped' },
        { 'buy:1': { note: 'Ethereum cannot pay for its own gas.' } },
      ),
      LEGS,
    )
    expect(lanes[1].tone).toBe('skipped')
    expect(lanes[1].note).toBe('Ethereum cannot pay for its own gas.')
  })

  it('all settled reads done (skips inside a lane do not block it)', () => {
    const lanes = deriveLanes(
      buyRun({
        'switch:8453': 'skipped',
        'buy:8453': 'done',
        'switch:1': 'done',
        'bridge:1': 'done',
        'await-bridge:1': 'done',
        'buy:1': 'done',
      }),
      LEGS,
    )
    expect(lanes.map((l) => l.tone)).toEqual(['done', 'done'])
  })

  it('a consolidate step joins the lane of the chain the money LEAVES', () => {
    const run = buyRun()
    const sellish: ThesisRun = {
      ...run,
      direction: 'sell',
      steps: [
        step('sell', 1, 'done', { legAddress: ADDR_ETH as Address, amountCents: 9_000 }),
        step('consolidate', 8453, 'queued', { bridgeFromChainId: 1, amountCents: 9_000 }),
      ],
    }
    const lanes = deriveLanes(sellish, LEGS)
    expect(lanes).toHaveLength(1)
    expect(lanes[0].chainId).toBe(1)
    expect(lanes[0].steps.map((s) => s.kind)).toEqual(['sell', 'consolidate'])
  })
})

describe('laneTone precedence', () => {
  const s = (state: ThesisStepState) => step('buy', 1, state)
  it('failed > awaiting > signing > working > queued', () => {
    expect(laneTone([s('failed'), s('awaiting'), s('signing')])).toBe('failed')
    expect(laneTone([s('awaiting'), s('signing')])).toBe('awaiting')
    expect(laneTone([s('signing'), s('confirming')])).toBe('signing')
    expect(laneTone([s('confirming'), s('queued')])).toBe('working')
    expect(laneTone([s('active'), s('queued')])).toBe('working')
    expect(laneTone([s('queued'), s('done')])).toBe('queued')
  })
})

describe('runFraction', () => {
  it('starts at 0, ends at 1, and only ever grows over a normal run', () => {
    const stages: Partial<Record<string, ThesisStepState>>[] = [
      {},
      { 'switch:8453': 'done' },
      { 'switch:8453': 'done', 'buy:8453': 'signing' },
      { 'switch:8453': 'done', 'buy:8453': 'confirming' },
      { 'switch:8453': 'done', 'buy:8453': 'done' },
      { 'switch:8453': 'done', 'buy:8453': 'done', 'switch:1': 'done', 'bridge:1': 'done', 'await-bridge:1': 'awaiting' },
      { 'switch:8453': 'done', 'buy:8453': 'done', 'switch:1': 'done', 'bridge:1': 'done', 'await-bridge:1': 'done' },
      {
        'switch:8453': 'done',
        'buy:8453': 'done',
        'switch:1': 'done',
        'bridge:1': 'done',
        'await-bridge:1': 'done',
        'buy:1': 'done',
      },
    ]
    const values = stages.map((st) => runFraction(buyRun(st)))
    expect(values[0]).toBe(0)
    expect(values[values.length - 1]).toBe(1)
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1])
  })

  it('a skipped leg counts settled — the bar does not stall on a refusal', () => {
    const all = buyRun({
      'switch:8453': 'done',
      'buy:8453': 'done',
      'switch:1': 'skipped',
      'bridge:1': 'skipped',
      'await-bridge:1': 'skipped',
      'buy:1': 'skipped',
    })
    expect(runFraction(all)).toBe(1)
  })
})

describe('firstUnsettledStep', () => {
  it('walks past done and skipped to the next real work', () => {
    const run = buyRun({ 'switch:8453': 'done', 'buy:8453': 'done', 'switch:1': 'skipped' })
    expect(firstUnsettledStep(run)?.id).toBe('bridge:1')
  })
  it('null when everything settled', () => {
    const run = buyRun({
      'switch:8453': 'done',
      'buy:8453': 'done',
      'switch:1': 'done',
      'bridge:1': 'done',
      'await-bridge:1': 'done',
      'buy:1': 'done',
    })
    expect(firstUnsettledStep(run)).toBeNull()
  })
})

describe('primaryActionLabel — one action, plainly worded', () => {
  it('names each action with its network and its money', () => {
    expect(primaryActionLabel(step('switch', 8453))).toBe('Switch to Base')
    expect(primaryActionLabel(step('bridge', 8453, 'queued', { amountCents: 13_588 }))).toBe('Bridge $135.88 to Base')
    expect(primaryActionLabel(step('buy', 8453))).toBe('Buy the Base leg')
    expect(primaryActionLabel(step('sell', 1))).toBe('Sell the Ethereum leg')
    expect(primaryActionLabel(step('consolidate', 8453, 'queued', { amountCents: 9_000 }))).toBe(
      'Bring $90.00 home to Base',
    )
  })
  it('offers NOTHING while a bridge is in flight — waiting is not an action', () => {
    expect(primaryActionLabel(step('await-bridge', 1, 'awaiting'))).toBeNull()
  })
  it('offers nothing for a consolidate whose amount was never measured', () => {
    expect(primaryActionLabel(step('consolidate', 8453))).toBeNull()
    expect(primaryActionLabel(null)).toBeNull()
  })
})

describe('runTotalCents', () => {
  it('buy: the user’s own figure', () => {
    expect(runTotalCents(buyRun())).toBe(50_000)
  })
  it('sell: sums the estimates it has, null when it has none', () => {
    const base = buyRun()
    const withEst: ThesisRun = {
      ...base,
      direction: 'sell',
      amountCents: 0,
      steps: [
        step('sell', 8453, 'queued', { amountCents: 12_000 }),
        step('sell', 1, 'queued', { amountCents: 8_000 }),
      ],
    }
    expect(runTotalCents(withEst)).toBe(20_000)
    const withoutEst: ThesisRun = { ...withEst, steps: [step('sell', 8453), step('sell', 1)] }
    expect(runTotalCents(withoutEst)).toBeNull()
  })
})

describe('landedRows — the success plate says what landed, and what did not', () => {
  it('buy rows carry the settled dollars; a skipped leg is stated, not counted', () => {
    const rows = landedRows(
      buyRun({
        'switch:8453': 'done',
        'buy:8453': 'done',
        'switch:1': 'skipped',
        'bridge:1': 'skipped',
        'await-bridge:1': 'skipped',
        'buy:1': 'skipped',
      }),
      LEGS,
    )
    expect(rows[0]).toMatchObject({ chainId: 8453, words: '$300.00 in', ok: true })
    expect(rows[1].ok).toBe(false)
    expect(rows.filter((r) => r.ok)).toHaveLength(1)
  })

  it('sell rows say where the proceeds ended up', () => {
    const base = buyRun()
    const sold: ThesisRun = {
      ...base,
      direction: 'sell',
      steps: [
        step('sell', 8453, 'done', { note: '$88.12 out' }),
        step('sell', 1, 'done'),
        step('consolidate', 8453, 'done', { bridgeFromChainId: 1, amountCents: 9_000 }),
      ],
    }
    const rows = landedRows(sold, LEGS)
    expect(rows[0].words).toBe('$88.12 out')
    expect(rows[1].words).toBe('sold · proceeds sent home')
  })
})

describe('demoFundings — the walkthrough’s synthetic inventory', () => {
  const needs = [
    { chainId: 8453, buysCents: 30_000, feeCents: 0 },
    { chainId: 1, buysCents: 15_000, feeCents: 0 },
    { chainId: 4663, buysCents: 5_000, feeCents: 0 },
  ]
  it('home funds itself; every other leg bridges its whole share from home', () => {
    const f = demoFundings(needs, 8453)
    expect(f[0]).toMatchObject({ chainId: 8453, shortfallCents: 0, bridge: null, gasOk: true })
    expect(f[1].bridge).toMatchObject({ fromChainId: 8453, amountCents: 15_000 })
    expect(f[2].bridge).toMatchObject({ fromChainId: 8453, amountCents: 5_000 })
  })
  it('conserves every cent of the split', () => {
    const f = demoFundings(needs, 8453)
    expect(f.reduce((s, x) => s + x.needCents, 0)).toBe(50_000)
    expect(f.reduce((s, x) => s + x.haveCents + x.shortfallCents, 0)).toBe(50_000)
  })
  it('falls back to the first need when the named home is not in the split', () => {
    const f = demoFundings(needs.slice(1), 8453)
    expect(f[0].bridge).toBeNull()
    expect(f[1].bridge?.fromChainId).toBe(1)
  })
})

describe('demoTick — the walkthrough reaches the end, and the bridge lingers', () => {
  function applyTick(run: ThesisRun): { run: ThesisRun; delayMs: number } | null {
    const tick = demoTick(run)
    if (!tick) return null
    const patched = new Map(tick.patches)
    return {
      run: { ...run, steps: run.steps.map((s) => (patched.has(s.id) ? { ...s, ...patched.get(s.id)! } : s)) },
      delayMs: tick.delayMs,
    }
  }

  it('drives every step to settled in bounded beats, arrival holding ~4s', () => {
    let run = buyRun()
    let beats = 0
    let sawArrivalHold = false
    for (; beats < 40; beats++) {
      const next = applyTick(run)
      if (!next) break
      if (next.delayMs === 4000) sawArrivalHold = true
      run = next.run
    }
    expect(beats).toBeLessThan(40)
    expect(firstUnsettledStep(run)).toBeNull()
    expect(sawArrivalHold).toBe(true)
    expect(run.steps.every((s) => s.state === 'done')).toBe(true)
  })

  it('every beat waits a human-visible moment (nothing teleports)', () => {
    let run = buyRun()
    for (let i = 0; i < 40; i++) {
      const next = applyTick(run)
      if (!next) break
      expect(next.delayMs).toBeGreaterThanOrEqual(300)
      expect(next.delayMs).toBeLessThanOrEqual(4000)
      run = next.run
    }
  })
})

describe('step words', () => {
  it('every step kind has ribbon words and an announcement', () => {
    const kinds: ThesisStepKind[] = ['switch', 'bridge', 'await-bridge', 'buy', 'sell', 'consolidate']
    for (const k of kinds) {
      const st = step(k, 8453, 'queued')
      expect(describeStep(st).length).toBeGreaterThan(0)
      expect(announceStep(st)).toContain('Base')
    }
    expect(announceStep(step('buy', 1, 'signing'))).toBe('Ethereum: buy — in your wallet')
  })
})

// ── convert lanes — the pay-asset route wears the bridge's grammar ───────────
describe('convert lanes (the pay-asset picker, the owner 2026-08-13)', () => {
  const cv = (over: Partial<ThesisRunStep> = {}): ThesisRunStep =>
    step('convert', 1, 'queued', {
      bridgeFromChainId: 8453,
      amountCents: 20_000,
      payTokenAddress: '0x4200000000000000000000000000000000000006' as Address,
      paySymbol: 'WETH',
      payDecimals: 18,
      payAmountRaw: 10n ** 16n, // 0.01
      ...over,
    })

  it('describeStep names the sale by its asset — and stays honest without one', () => {
    expect(describeStep(cv())).toBe('sell WETH')
    expect(describeStep(step('convert', 1))).toBe('convert')
  })

  it('primaryActionLabel states the CEILed pay amount, never an invented one', () => {
    expect(primaryActionLabel(cv())).toContain('Sell ≈0.01 WETH')
    // a wei past exact rounds UP at display precision — the shown number is
    // always enough
    expect(primaryActionLabel(cv({ payAmountRaw: 10n ** 16n + 1n }))).toContain('Sell ≈0.010001 WETH')
    // no readable amount → the generic sentence, no number at all
    expect(primaryActionLabel(step('convert', 1))).toBe('Convert funds for Ethereum')
  })

  it('payAssetTotal sums ONE asset from ONE source — a mixed sum is refused as a wrong number', () => {
    const run: ThesisRun = {
      ...buyRun(),
      steps: [cv({ id: 'convert:1' }), cv({ id: 'convert:4663', chainId: 4663, payAmountRaw: 2n * 10n ** 16n })],
    }
    expect(payAssetTotal(run)).toEqual({ symbol: 'WETH', decimals: 18, totalRaw: 3n * 10n ** 16n, fromChainId: 8453 })
    // no conversions → no second truth to print
    expect(payAssetTotal(buyRun())).toBeNull()
    // two assets cannot share a total
    expect(payAssetTotal({ ...run, steps: [cv(), cv({ id: 'x', paySymbol: 'ETH' })] })).toBeNull()
    // one asset from two SOURCE chains is just as wrong
    expect(payAssetTotal({ ...run, steps: [cv(), cv({ id: 'y', bridgeFromChainId: 1 })] })).toBeNull()
  })

  it('the demo walkthrough drives a convert run to settled — timers, never quotes', () => {
    const steps: ThesisRunStep[] = [
      step('switch', 8453),
      cv({ id: 'convert:1' }),
      step('switch', 1),
      step('await-bridge', 1, 'queued', { bridgeFromChainId: 8453 }),
      step('buy', 1, 'queued', { legAddress: ADDR_ETH as Address, amountCents: 20_000 }),
    ]
    let run: ThesisRun = { ...buyRun(), steps }
    for (let beats = 0; beats < 40; beats++) {
      const tick = demoTick(run)
      if (!tick) break
      const patched = new Map(tick.patches)
      expect(tick.delayMs).toBeGreaterThanOrEqual(300)
      run = { ...run, steps: run.steps.map((s) => (patched.has(s.id) ? { ...s, ...patched.get(s.id)! } : s)) }
    }
    expect(firstUnsettledStep(run)).toBeNull()
    expect(run.steps.every((s) => s.state === 'done')).toBe(true)
  })
})
