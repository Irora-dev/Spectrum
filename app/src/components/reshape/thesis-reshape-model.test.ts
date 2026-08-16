import { describe, expect, it } from 'vitest'
import type { BasketData } from '../../lib/spectrum/basket-data'
import { Venue, type BasketRoute } from '../../lib/pools'
import { DEMO_DEPLOY_SCRIPT, type ReshapeDraft, type ThesisReshapeLane } from './reshape-types'
import {
  activeLane,
  advanceLane,
  announceLane,
  composeReshapeLanes,
  DEMO_LINEAGE_NOTE,
  DEMO_RESHAPE_REFUSAL,
  demoLaneScript,
  demoReshapeRefusal,
  deployStageWords,
  draftDiffFrom,
  honestyPlateWords,
  INTERRUPTION_NOTE,
  laneMarks,
  LINEAGE_REFUSED_NOTE,
  reshapeProgress,
  retryLane,
  runnableLanes,
  SKIPPED_LANE_NOTE,
} from './thesis-reshape-model'

// ── fixtures ─────────────────────────────────────────────────────────────────

const addr = (suffix: string): `0x${string}` => `0x${'0'.repeat(40 - suffix.length)}${suffix}` as `0x${string}`

/** Matches THESIS_DEMO_ADDR_RE (…de50xxxx) — a synthetic leg. */
const DEMO_ADDR = addr('de501234')

const LEGS = [
  { chainId: 8453, address: addr('a1') },
  { chainId: 1, address: addr('b2') },
  { chainId: 4663, address: addr('c3') },
]

function lanesOf(skipped: number[] = [], legs = LEGS, demo = false): ThesisReshapeLane[] {
  const out = composeReshapeLanes({ legs, skipped, demo })
  if ('refused' in out) throw new Error(`unexpected refusal: ${out.refused}`)
  return out
}

const ZERO = addr('0')
const route: BasketRoute = {
  venue: Venue.V3,
  ethPool: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
  v3Fee: 3000,
  v2Pair: ZERO,
}

function draftOf(rows: { address: `0x${string}`; symbol: string; weight: number }[]): ReshapeDraft {
  return {
    name: 'Bullish EVM',
    symbol: 'BEVMV2',
    legs: rows.map((r) => ({ address: r.address, symbol: r.symbol, name: r.symbol, decimals: 18, route })),
    weights: rows.map((r) => r.weight),
    feeConfig: { basketFeeBps: 100, creatorShareBps: 0, creatorPayout: ZERO, launcher: ZERO },
  }
}

function basketOf(rows: { asset: `0x${string}`; symbol: string; weight: number }[]): BasketData {
  return {
    chainId: 8453,
    address: addr('feed'),
    name: 'Bullish EVM',
    symbol: 'BEVM',
    decimals: 18,
    totalSupply: 0,
    aumUsd: 0,
    navPerToken: 1,
    navSource: 'onchain',
    fullyPriced: true,
    navDivergencePct: null,
    change24hPct: null,
    holdings: rows.map((r) => ({
      asset: r.asset,
      symbol: r.symbol,
      name: r.symbol,
      decimals: 18,
      targetWeightPct: r.weight,
      balance: 0,
      priceUsd: 0,
      valueUsd: 0,
      liveWeightPct: 0,
      change24hPct: null,
      priced: true,
      series: [],
    })),
    navSeries: [],
    pricedCount: 0,
    totalCount: 0,
    inceptionTs: null,
    ageHours: null,
    deployer: null,
    effectiveSupply: null,
    updatedAt: '',
  }
}

// ── composition ──────────────────────────────────────────────────────────────

describe('composeReshapeLanes', () => {
  it('composes one lane per leg, in leg order, queued with the predecessor carried', () => {
    const lanes = lanesOf()
    expect(lanes.map((l) => l.chainId)).toEqual([8453, 1, 4663])
    expect(lanes.map((l) => l.state)).toEqual(['queued', 'queued', 'queued'])
    expect(lanes[0].predecessor).toBe(LEGS[0].address)
    expect(lanes.every((l) => l.newAddress === null)).toBe(true)
    expect(lanes.every((l) => l.note === null)).toBe(true)
  })

  it('skipped legs compose as terminal skipped lanes with the honest note — shown, never dropped', () => {
    const lanes = lanesOf([1])
    expect(lanes).toHaveLength(3)
    const skippedLane = lanes.find((l) => l.chainId === 1)!
    expect(skippedLane.state).toBe('skipped')
    expect(skippedLane.note).toBe(SKIPPED_LANE_NOTE)
  })

  it('refuses when every leg is skipped — at least one un-skipped leg is required', () => {
    const out = composeReshapeLanes({ legs: LEGS, skipped: [8453, 1, 4663], demo: false })
    expect(out).toHaveProperty('refused')
  })

  it('BOUNDARY: all-but-one skipped composes ONE runnable lane, not zero', () => {
    const lanes = lanesOf([8453, 4663])
    const runnable = runnableLanes(lanes)
    expect(runnable).toHaveLength(1)
    expect(runnable[0].chainId).toBe(1)
    expect(runnable[0].state).toBe('queued')
    // and the cursor lands on it, past the leading skipped lane
    expect(activeLane(lanes)?.chainId).toBe(1)
  })

  it('refuses zero legs and duplicate chains', () => {
    expect(composeReshapeLanes({ legs: [], skipped: [], demo: false })).toHaveProperty('refused')
    const dup = [
      { chainId: 8453, address: addr('a1') },
      { chainId: 8453, address: addr('b2') },
    ]
    expect(composeReshapeLanes({ legs: dup, skipped: [], demo: false })).toHaveProperty('refused')
  })

  it('accepts a Set for skipped as well as an array', () => {
    const lanes = composeReshapeLanes({ legs: LEGS, skipped: new Set([1]), demo: false })
    if ('refused' in lanes) throw new Error('unexpected refusal')
    expect(lanes.find((l) => l.chainId === 1)?.state).toBe('skipped')
  })
})

// ── the demo refusal law, both ways ──────────────────────────────────────────

describe('demo refusal', () => {
  const demoLegs = [LEGS[0], { chainId: 1, address: DEMO_ADDR }]

  it('a REAL ceremony against a synthetic leg refuses, spec sentence, refusal-first', () => {
    const out = composeReshapeLanes({ legs: demoLegs, skipped: [], demo: false })
    expect(out).toEqual({ refused: DEMO_RESHAPE_REFUSAL })
    // refusal-first: it wins even over the all-skipped refusal
    const alsoAllSkipped = composeReshapeLanes({ legs: demoLegs, skipped: [8453, 1], demo: false })
    expect(alsoAllSkipped).toEqual({ refused: DEMO_RESHAPE_REFUSAL })
    expect(demoReshapeRefusal(demoLegs, false)).toBe(DEMO_RESHAPE_REFUSAL)
  })

  it('a DEMO ceremony over the same legs composes', () => {
    const out = composeReshapeLanes({ legs: demoLegs, skipped: [], demo: true })
    expect('refused' in out).toBe(false)
    expect(demoReshapeRefusal(demoLegs, true)).toBeNull()
  })

  it('a real ceremony over real legs composes (the law is about synthetic legs, not mode)', () => {
    expect(demoReshapeRefusal(LEGS, false)).toBeNull()
  })
})

// ── the cursor ───────────────────────────────────────────────────────────────

describe('activeLane (strictly sequential cursor)', () => {
  it('is the first non-terminal lane, and moves only when the lane ahead settles', () => {
    let lanes = lanesOf()
    expect(activeLane(lanes)?.chainId).toBe(8453)
    // driving the SECOND lane while the first is open changes nothing
    expect(advanceLane(lanes, 1, { state: 'switch' })).toBe(lanes)
    lanes = advanceLane(lanes, 8453, { state: 'switch' })
    lanes = advanceLane(lanes, 8453, { state: 'deploying' })
    lanes = advanceLane(lanes, 8453, { state: 'signing-lineage', newAddress: addr('e0') })
    lanes = advanceLane(lanes, 8453, { state: 'done', note: null })
    expect(activeLane(lanes)?.chainId).toBe(1)
  })

  it('a failed lane HOLDS the cursor — the lanes after it stay queued', () => {
    let lanes = lanesOf()
    lanes = advanceLane(lanes, 8453, { state: 'deploying' })
    lanes = advanceLane(lanes, 8453, { state: 'failed', note: 'the wallet declined' })
    expect(activeLane(lanes)?.chainId).toBe(8453)
    expect(lanes[1].state).toBe('queued')
    expect(lanes[2].state).toBe('queued')
  })

  it('skipped lanes are never the cursor', () => {
    const lanes = lanesOf([8453])
    expect(activeLane(lanes)?.chainId).toBe(1)
  })

  it('null when every lane settled', () => {
    let lanes = lanesOf([1, 4663])
    lanes = advanceLane(lanes, 8453, { state: 'done' })
    expect(activeLane(lanes)).toBeNull()
  })
})

// ── reducer semantics ────────────────────────────────────────────────────────

describe('advanceLane', () => {
  it('returns a NEW array on change and the SAME reference on refusal/no-op', () => {
    const lanes = lanesOf()
    const next = advanceLane(lanes, 8453, { state: 'switch' })
    expect(next).not.toBe(lanes)
    expect(next[0].state).toBe('switch')
    // no-op patch — same reference
    expect(advanceLane(next, 8453, { state: 'switch' })).toBe(next)
    // unknown chain — same reference
    expect(advanceLane(lanes, 999, { state: 'switch' })).toBe(lanes)
  })

  it('TERMINAL PROTECTION: done and skipped lanes are frozen records', () => {
    let lanes = lanesOf([1])
    lanes = advanceLane(lanes, 8453, { state: 'done' })
    // done is frozen
    expect(advanceLane(lanes, 8453, { state: 'deploying' })).toBe(lanes)
    expect(advanceLane(lanes, 8453, { note: 'rewritten' })).toBe(lanes)
    // skipped is frozen
    expect(advanceLane(lanes, 1, { state: 'queued' })).toBe(lanes)
    expect(advanceLane(lanes, 1, { note: 'rewritten' })).toBe(lanes)
  })

  it('nothing transitions INTO skipped at runtime — skip is a plan-time verdict', () => {
    const lanes = lanesOf()
    expect(advanceLane(lanes, 8453, { state: 'skipped' })).toBe(lanes)
  })

  it('a failed lane cannot change state via advanceLane, but may enrich its note', () => {
    let lanes = lanesOf()
    lanes = advanceLane(lanes, 8453, { state: 'failed', note: 'declined' })
    expect(advanceLane(lanes, 8453, { state: 'done' })).toBe(lanes)
    expect(advanceLane(lanes, 8453, { state: 'queued' })).toBe(lanes)
    const enriched = advanceLane(lanes, 8453, { note: 'declined — the auction slot closed' })
    expect(enriched).not.toBe(lanes)
    expect(enriched[0].state).toBe('failed')
    expect(enriched[0].note).toBe('declined — the auction slot closed')
  })

  it('carries newAddress with the signing-lineage transition', () => {
    let lanes = lanesOf()
    lanes = advanceLane(lanes, 8453, { state: 'deploying' })
    lanes = advanceLane(lanes, 8453, { state: 'signing-lineage', newAddress: addr('e0') })
    expect(lanes[0].newAddress).toBe(addr('e0'))
  })
})

describe('retryLane', () => {
  it('deploy-failed (no newAddress) retries to QUEUED — reset + re-prepare', () => {
    let lanes = lanesOf()
    lanes = advanceLane(lanes, 8453, { state: 'failed', note: 'simulation reverted' })
    const retried = retryLane(lanes, 8453)
    expect(retried[0].state).toBe('queued')
    expect(retried[0].note).toBeNull()
    expect(retried[0].newAddress).toBeNull()
  })

  it('lineage-failed (newAddress set) retries to SIGNING-LINEAGE — never a second deploy', () => {
    let lanes = lanesOf()
    lanes = advanceLane(lanes, 8453, { state: 'signing-lineage', newAddress: addr('e0') })
    lanes = advanceLane(lanes, 8453, { state: 'failed', note: LINEAGE_REFUSED_NOTE })
    const retried = retryLane(lanes, 8453)
    expect(retried[0].state).toBe('signing-lineage')
    expect(retried[0].newAddress).toBe(addr('e0')) // the live deploy is evidence, kept
    expect(retried[0].note).toBeNull()
  })

  it('refuses (same reference) on non-failed lanes and unknown chains', () => {
    const lanes = lanesOf()
    expect(retryLane(lanes, 8453)).toBe(lanes)
    expect(retryLane(lanes, 999)).toBe(lanes)
  })
})

// ── progress ─────────────────────────────────────────────────────────────────

describe('reshapeProgress', () => {
  it('excludes skipped lanes and finishes only when every runnable lane is done', () => {
    let lanes = lanesOf([1])
    expect(reshapeProgress(lanes)).toEqual({ done: 0, total: 2, failed: 0, finished: false })
    lanes = advanceLane(lanes, 8453, { state: 'done' })
    expect(reshapeProgress(lanes)).toEqual({ done: 1, total: 2, failed: 0, finished: false })
    lanes = advanceLane(lanes, 4663, { state: 'failed', note: 'declined' })
    expect(reshapeProgress(lanes)).toEqual({ done: 1, total: 2, failed: 1, finished: false })
    lanes = retryLane(lanes, 4663)
    lanes = advanceLane(lanes, 4663, { state: 'done' })
    expect(reshapeProgress(lanes)).toEqual({ done: 2, total: 2, failed: 0, finished: true })
  })
})

// ── marks ────────────────────────────────────────────────────────────────────

describe('laneMarks', () => {
  const lane = (over: Partial<ThesisReshapeLane>): ThesisReshapeLane => ({
    chainId: 8453,
    predecessor: addr('a1'),
    state: 'queued',
    newAddress: null,
    note: null,
    ...over,
  })

  it('walks done→active→todo through the ceremony', () => {
    expect(laneMarks(lane({ state: 'switch' })).map((m) => m.state)).toEqual(['active', 'todo', 'todo'])
    expect(laneMarks(lane({ state: 'deploying' })).map((m) => m.state)).toEqual(['done', 'active', 'todo'])
    expect(laneMarks(lane({ state: 'signing-lineage' })).map((m) => m.state)).toEqual(['done', 'done', 'active'])
    expect(laneMarks(lane({ state: 'done' })).map((m) => m.state)).toEqual(['done', 'done', 'done'])
  })

  it('reads WHICH act failed off the lane evidence (newAddress)', () => {
    expect(laneMarks(lane({ state: 'failed' })).map((m) => m.state)).toEqual(['done', 'failed', 'todo'])
    expect(laneMarks(lane({ state: 'failed', newAddress: addr('e0') })).map((m) => m.state)).toEqual([
      'done',
      'done',
      'failed',
    ])
  })
})

// ── the demo walkthrough ─────────────────────────────────────────────────────

describe('demoLaneScript', () => {
  it('walks switch → deploying (every script beat, in order) → signing-lineage → done', () => {
    const beats = demoLaneScript()
    expect(beats[0].patch.state).toBe('switch')
    expect(beats[beats.length - 1].patch.state).toBe('done')
    const lineageBeats = beats.filter((b) => b.patch.state === 'signing-lineage')
    expect(lineageBeats).toHaveLength(1)
    expect(lineageBeats[0].patch.note).toBe(DEMO_LINEAGE_NOTE)
    const deployNotes = beats.filter((b) => b.patch.state === 'deploying').map((b) => b.patch.note)
    expect(deployNotes).toEqual(
      DEMO_DEPLOY_SCRIPT.filter((r) => r.status !== 'success').map((r) => deployStageWords(r.status)),
    )
  })

  it("each beat's wait is the hold in the PREVIOUS state — the script's ms travel exactly", () => {
    const beats = demoLaneScript()
    // beats: [switch, mining, preparing, ready, signing, confirming, lineage, done]
    const waits = beats.map((b) => b.waitMs)
    expect(waits.slice(2, 7)).toEqual(DEMO_DEPLOY_SCRIPT.slice(0, 5).map((r) => r.ms))
    expect(waits[waits.length - 1]).toBeGreaterThan(0) // the lineage beat is held long enough to read
  })

  it('applied through the reducer, the beats land a lane on done', () => {
    let lanes = lanesOf([], [LEGS[0]], true)
    for (const beat of demoLaneScript()) lanes = advanceLane(lanes, 8453, beat.patch)
    expect(lanes[0].state).toBe('done')
    expect(reshapeProgress(lanes).finished).toBe(true)
  })
})

// ── the diff adapter ─────────────────────────────────────────────────────────

describe('draftDiffFrom', () => {
  it('reads added/removed/reweighted between the live basket and the draft', () => {
    const prev = basketOf([
      { asset: addr('11'), symbol: 'AAA', weight: 50 },
      { asset: addr('22'), symbol: 'BBB', weight: 30 },
      { asset: addr('33'), symbol: 'CCC', weight: 20 },
    ])
    const draft = draftOf([
      { address: addr('11'), symbol: 'AAA', weight: 60 }, // reweighted
      { address: addr('22'), symbol: 'BBB', weight: 30 }, // unchanged
      { address: addr('44'), symbol: 'DDD', weight: 10 }, // added (CCC removed)
    ])
    const diff = draftDiffFrom(prev, draft)
    expect(diff.addedCount).toBe(1)
    expect(diff.removedCount).toBe(1)
    expect(diff.reweightedCount).toBe(1)
    const kinds = new Map(diff.constituents.map((c) => [c.symbol, c.kind]))
    expect(kinds.get('DDD')).toBe('added')
    expect(kinds.get('CCC')).toBe('removed')
    expect(kinds.get('AAA')).toBe('reweighted')
    expect(kinds.get('BBB')).toBe('unchanged')
  })

  it('an untouched draft diffs clean (no added/removed/reweighted)', () => {
    const prev = basketOf([
      { asset: addr('11'), symbol: 'AAA', weight: 50 },
      { asset: addr('22'), symbol: 'BBB', weight: 50 },
    ])
    const draft = draftOf([
      { address: addr('11'), symbol: 'AAA', weight: 50 },
      { address: addr('22'), symbol: 'BBB', weight: 50 },
    ])
    const diff = draftDiffFrom(prev, draft)
    expect(diff.addedCount + diff.removedCount + diff.reweightedCount).toBe(0)
  })
})

// ── the words ────────────────────────────────────────────────────────────────

describe('words', () => {
  it('the honesty plate states the count and the three honest facts', () => {
    const three = honestyPlateWords(3)
    expect(three).toContain('a new version on 3 networks, one at a time')
    expect(three).toContain('a deploy and a signature per network')
    expect(three).toContain('The current baskets stay exactly as they are')
    expect(three).toContain('deploy price plus gas')
    expect(honestyPlateWords(1)).toContain('on 1 network,')
  })

  it('the lineage-refusal note names the recovery path on the new basket’s own page', () => {
    expect(LINEAGE_REFUSED_NOTE).toContain('Link previous version')
    expect(LINEAGE_REFUSED_NOTE).toContain('new basket’s own page')
  })

  it('the interruption note tells the durable-artifact story', () => {
    expect(INTERRUPTION_NOTE).toContain('finished networks keep their new versions')
    expect(INTERRUPTION_NOTE).toContain('linked later')
    // the same treatment the publish footer got (the owner 2026-08-13): two
    // sentences, no em dash — the two ceremonies' footers must not drift
    expect(INTERRUPTION_NOTE).not.toContain('—')
    expect(INTERRUPTION_NOTE).toBe(
      'If this closes mid-way, finished networks keep their new versions. An unsigned lineage can be linked later from the new basket’s own page.',
    )
  })

  it('announceLane speaks every state', () => {
    const base: ThesisReshapeLane = { chainId: 8453, predecessor: addr('a1'), state: 'queued', newAddress: null, note: null }
    for (const state of ['queued', 'switch', 'deploying', 'signing-lineage', 'done', 'failed', 'skipped'] as const) {
      expect(announceLane({ ...base, state }, 'Base')).toContain('Base')
    }
  })
})
