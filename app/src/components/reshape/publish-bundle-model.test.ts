import { describe, expect, it } from 'vitest'
import { Venue, type BasketRoute } from '../../lib/pools'
import { CAP, MIN } from '../../lib/spectrum/weights'
import {
  activePublishLane,
  ADDRESS_UNREAD_NOTE,
  advancePublishLane,
  announcePublishLane,
  bundleChainIds,
  bundleNameOk,
  cleanTicker,
  composePublishLanes,
  defaultTickers,
  DEPLOY_GAS_HEADROOM_WEI,
  deployerRefusal,
  deployReadiness,
  DEPLOYS_DISABLED_NOTE,
  fundingPlan,
  groupBundleDraft,
  isBundleDraft,
  PUBLISH_INTERRUPTION_NOTE,
  publishLaneMarks,
  publishPlateWords,
  publishProgress,
  retryPublishLane,
  seedPublishLanes,
  TICKER_RE,
  type BundleDraftAsset,
  type PublishLane,
} from './publish-bundle-model'

// ── fixtures ─────────────────────────────────────────────────────────────────

const addr = (suffix: string): `0x${string}` => `0x${'0'.repeat(40 - suffix.length)}${suffix}` as `0x${string}`

const ZERO = addr('0')
const route: BasketRoute = {
  venue: Venue.V3,
  ethPool: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
  v3Fee: 3000,
  v2Pair: ZERO,
}

function asset(chainId: number, suffix: string, symbol = suffix.toUpperCase()): BundleDraftAsset {
  return { chainId, address: addr(suffix), symbol, decimals: 18, route }
}

/** 4 picks over 2 chains: Base [a1, a2] · Ethereum [b1, b2]. */
const ASSETS = [asset(8453, 'a1'), asset(1, 'b1'), asset(8453, 'a2'), asset(1, 'b2')]

function lanesOf(chainIds: number[] = [8453, 1]): PublishLane[] {
  const out = composePublishLanes(chainIds.map((chainId) => ({ chainId, ready: true, blocker: null })))
  if ('refused' in out) throw new Error(`unexpected refusal: ${out.refused}`)
  return out
}

// ── bundle detection ─────────────────────────────────────────────────────────

describe('isBundleDraft / bundleChainIds', () => {
  it('is false for empty and single-chain drafts', () => {
    expect(isBundleDraft([])).toBe(false)
    expect(isBundleDraft([{ chainId: 8453 }, { chainId: 8453 }])).toBe(false)
  })

  it('flips true the moment picks span two networks — a derivation, never a toggle', () => {
    expect(isBundleDraft([{ chainId: 8453 }, { chainId: 1 }])).toBe(true)
  })

  it('lists distinct chains in pick order', () => {
    expect(bundleChainIds(ASSETS)).toEqual([8453, 1])
  })
})

// ── grouping + the per-network split law ─────────────────────────────────────

describe('groupBundleDraft', () => {
  it('groups per network in pick order, keeping draft indices', () => {
    const groups = groupBundleDraft(ASSETS, [40, 30, 20, 10])
    expect(groups.map((g) => g.chainId)).toEqual([8453, 1])
    expect(groups[0].indices).toEqual([0, 2])
    expect(groups[1].indices).toEqual([1, 3])
    expect(groups[0].assets.map((a) => a.symbol)).toEqual(['A1', 'A2'])
  })

  it('renormalizes each network to its own Σ=100 (the create:<chainId> split law)', () => {
    const groups = groupBundleDraft(ASSETS, [40, 30, 20, 10])
    // Base holds 40+20=60 of the mix → within its basket: 40/60·100 ≈ 67, 20/60·100 ≈ 33
    expect(groups[0].mixSharePct).toBe(60)
    expect(groups[0].deployWeights).toEqual([67, 33])
    // Ethereum holds 30+10=40 → 75 / 25
    expect(groups[1].mixSharePct).toBe(40)
    expect(groups[1].deployWeights).toEqual([75, 25])
  })

  it('every group sums to CAP exactly with each leg ≥ MIN (the weights.ts law)', () => {
    const groups = groupBundleDraft(
      [asset(8453, 'a1'), asset(8453, 'a2'), asset(8453, 'a3'), asset(1, 'b1'), asset(1, 'b2')],
      [1, 1, 47, 50, 1],
    )
    for (const g of groups) {
      expect(g.deployWeights.reduce((s, w) => s + w, 0)).toBe(CAP)
      for (const w of g.deployWeights) expect(w).toBeGreaterThanOrEqual(MIN)
      expect(g.ready).toBe(true)
    }
  })

  it('a tiny pick keeps its truth — the 1% floor holds it, the largest absorbs the remainder', () => {
    // group shares: 1/50 → 2%; 49/50 → 98 (owner 2026-08-12: the floor is 1,
    // so a small conviction deploys AS COMPOSED instead of inflating to 5)
    const groups = groupBundleDraft([asset(8453, 'a1'), asset(8453, 'a2'), asset(1, 'b1')], [1, 49, 50])
    expect(groups[0].deployWeights).toEqual([2, 98])
  })

  it('a ONE-asset network is READY — contract-valid, the owner-ruled (2026-08-15; the old two-asset floor was FE-imposed)', () => {
    const groups = groupBundleDraft(ASSETS.slice(0, 3), [50, 30, 20]) // Ethereum has only b1
    const eth = groups.find((g) => g.chainId === 1)!
    expect(eth.ready).toBe(true)
    expect(eth.blocker).toBeNull()
    expect(eth.deployWeights).toEqual([100]) // one leg carries the whole basket
    const base = groups.find((g) => g.chainId === 8453)!
    expect(base.ready).toBe(true)
  })

  it('a zero-mass group falls back to an equal split rather than dividing by zero', () => {
    const groups = groupBundleDraft([asset(8453, 'a1'), asset(8453, 'a2')], [0, 0])
    expect(groups[0].deployWeights).toEqual([50, 50])
  })
})

// ── lane composition ─────────────────────────────────────────────────────────

describe('composePublishLanes', () => {
  it('composes one queued lane per network', () => {
    const lanes = lanesOf([8453, 1, 4663])
    expect(lanes).toHaveLength(3)
    expect(lanes.every((l) => l.state === 'queued' && l.newAddress === null && l.note === null)).toBe(true)
  })

  it('refuses an empty plan', () => {
    expect(composePublishLanes([])).toEqual({ refused: 'This bundle has no networks to publish.' })
  })

  it('refuses when any network is not ready, with that network’s own blocker', () => {
    const out = composePublishLanes([
      { chainId: 8453, ready: true, blocker: null },
      { chainId: 1, ready: false, blocker: 'A basket needs at least two assets — Ethereum has one.' },
    ])
    expect(out).toEqual({ refused: 'A basket needs at least two assets — Ethereum has one.' })
  })

  it('refuses a duplicated chain (our bug, said plainly)', () => {
    const out = composePublishLanes([
      { chainId: 1, ready: true, blocker: null },
      { chainId: 1, ready: true, blocker: null },
    ])
    expect('refused' in out && out.refused).toContain('appears twice')
  })
})

describe('seedPublishLanes — resuming an interrupted ceremony', () => {
  const ADDR = '0x00000000000000000000000000000000000000aa' as const
  const g = (chainId: number, ready = true, blocker: string | null = null) => ({ chainId, ready, blocker })

  it('with nothing landed it is exactly composePublishLanes', () => {
    expect(seedPublishLanes([g(8453), g(1)], [])).toEqual(composePublishLanes([g(8453), g(1)]))
  })

  it('a landed chain seeds as a DONE lane and is never re-armed; group order holds', () => {
    const out = seedPublishLanes([g(8453), g(1)], [{ chainId: 8453, newAddress: ADDR }])
    if ('refused' in out) throw new Error('unexpected refusal')
    expect(out.map((l) => [l.chainId, l.state])).toEqual([
      [8453, 'done'],
      [1, 'queued'],
    ])
    expect(out[0].newAddress).toBe(ADDR)
    expect(activePublishLane(out)?.chainId).toBe(1)
  })

  it('a landed group edited into an INVALID shape cannot dead-end the resumed run', () => {
    // the landed chain now fails the fresh-deploy gate — irrelevant: it will
    // not deploy again, so only the pending groups face composition
    const out = seedPublishLanes(
      [g(8453, false, 'A basket needs at least two assets — Base has one.'), g(1)],
      [{ chainId: 8453, newAddress: ADDR }],
    )
    if ('refused' in out) throw new Error('unexpected refusal')
    expect(out[0].state).toBe('done')
    expect(out[1].state).toBe('queued')
  })

  it('a pending group that is not ready still refuses, with its own blocker', () => {
    const out = seedPublishLanes(
      [g(8453), g(1, false, 'A basket needs at least two assets — Ethereum has one.')],
      [{ chainId: 8453, newAddress: ADDR }],
    )
    expect('refused' in out && out.refused).toContain('Ethereum has one')
  })

  it('every chain landed opens straight onto the finished plate — nothing deploys', () => {
    const out = seedPublishLanes([g(8453), g(1)], [
      { chainId: 8453, newAddress: ADDR },
      { chainId: 1, newAddress: ADDR },
    ])
    if ('refused' in out) throw new Error('unexpected refusal')
    expect(out.every((l) => l.state === 'done')).toBe(true)
    expect(activePublishLane(out)).toBeNull()
    expect(publishProgress(out).finished).toBe(true)
  })

  it('a landed deploy whose address was unread carries the ADDRESS_UNREAD note, still done', () => {
    const out = seedPublishLanes([g(8453)], [{ chainId: 8453, newAddress: null }])
    if ('refused' in out) throw new Error('unexpected refusal')
    expect(out[0].state).toBe('done')
    expect(out[0].note).toBe(ADDRESS_UNREAD_NOTE)
  })
})

// ── the cursor + reducers ────────────────────────────────────────────────────

describe('activePublishLane', () => {
  it('is the first non-done lane; null when the ceremony is over', () => {
    const lanes = lanesOf()
    expect(activePublishLane(lanes)?.chainId).toBe(8453)
    const after = advancePublishLane(lanes, 8453, { state: 'done' })
    expect(activePublishLane(after)?.chainId).toBe(1)
    const all = advancePublishLane(after, 1, { state: 'done' })
    expect(activePublishLane(all)).toBeNull()
  })

  it('a failed lane HOLDS the cursor — the queue never starts around it', () => {
    let lanes = lanesOf()
    lanes = advancePublishLane(lanes, 8453, { state: 'failed', note: 'declined' })
    expect(activePublishLane(lanes)?.chainId).toBe(8453)
    expect(lanes[1].state).toBe('queued')
  })
})

describe('advancePublishLane', () => {
  it('patches only the active lane; anything else returns the SAME reference', () => {
    const lanes = lanesOf()
    expect(advancePublishLane(lanes, 1, { state: 'switch' })).toBe(lanes) // not the cursor
    expect(advancePublishLane(lanes, 999, { state: 'switch' })).toBe(lanes) // unknown chain
    const moved = advancePublishLane(lanes, 8453, { state: 'switch' })
    expect(moved).not.toBe(lanes)
    expect(moved[0].state).toBe('switch')
  })

  it('a failed lane cannot transition (retry is the only exit) but may enrich its note', () => {
    let lanes = lanesOf()
    lanes = advancePublishLane(lanes, 8453, { state: 'failed', note: 'declined' })
    expect(advancePublishLane(lanes, 8453, { state: 'deploying' })).toBe(lanes)
    const enriched = advancePublishLane(lanes, 8453, { note: 'declined — wallet reported code 4001' })
    expect(enriched[0].note).toContain('4001')
    expect(enriched[0].state).toBe('failed')
  })

  it('an identical patch is a no-op returning the same reference', () => {
    let lanes = lanesOf()
    lanes = advancePublishLane(lanes, 8453, { state: 'switch' })
    expect(advancePublishLane(lanes, 8453, { state: 'switch' })).toBe(lanes)
  })
})

describe('retryPublishLane', () => {
  it('re-queues a failed lane and clears its note — the executor re-prepares from scratch', () => {
    let lanes = lanesOf()
    lanes = advancePublishLane(lanes, 8453, { state: 'failed', note: 'declined' })
    const retried = retryPublishLane(lanes, 8453)
    expect(retried[0]).toMatchObject({ state: 'queued', note: null })
  })

  it('is a no-op (same reference) on anything not failed', () => {
    const lanes = lanesOf()
    expect(retryPublishLane(lanes, 8453)).toBe(lanes)
    expect(retryPublishLane(lanes, 999)).toBe(lanes)
  })
})

describe('publishProgress', () => {
  it('counts done/failed and only finishes when every lane is done', () => {
    let lanes = lanesOf()
    expect(publishProgress(lanes)).toEqual({ done: 0, total: 2, failed: 0, finished: false })
    lanes = advancePublishLane(lanes, 8453, { state: 'done', newAddress: addr('11') })
    lanes = advancePublishLane(lanes, 1, { state: 'failed', note: 'declined' })
    expect(publishProgress(lanes)).toEqual({ done: 1, total: 2, failed: 1, finished: false })
    lanes = retryPublishLane(lanes, 1)
    lanes = advancePublishLane(lanes, 1, { state: 'done' })
    expect(publishProgress(lanes)).toEqual({ done: 2, total: 2, failed: 0, finished: true })
  })

  it('an empty ceremony is never finished', () => {
    expect(publishProgress([]).finished).toBe(false)
  })
})

// ── marks + announcements ────────────────────────────────────────────────────

describe('publishLaneMarks', () => {
  const lane = (state: PublishLane['state']): PublishLane => ({ chainId: 1, state, newAddress: null, note: null })

  it('walks [switch → deploy] and pins failure on the deploy', () => {
    expect(publishLaneMarks(lane('queued')).map((m) => m.state)).toEqual(['todo', 'todo'])
    expect(publishLaneMarks(lane('switch')).map((m) => m.state)).toEqual(['active', 'todo'])
    expect(publishLaneMarks(lane('deploying')).map((m) => m.state)).toEqual(['done', 'active'])
    expect(publishLaneMarks(lane('done')).map((m) => m.state)).toEqual(['done', 'done'])
    expect(publishLaneMarks(lane('failed')).map((m) => m.state)).toEqual(['done', 'failed'])
  })

  it('has no lineage mark — a fresh deploy supersedes nothing', () => {
    expect(publishLaneMarks(lane('done')).map((m) => m.key)).toEqual(['switch', 'deploy'])
  })
})

describe('announcePublishLane', () => {
  it('speaks each state in plain words', () => {
    const lane = (state: PublishLane['state']): PublishLane => ({ chainId: 1, state, newAddress: null, note: null })
    expect(announcePublishLane(lane('switch'), 'Ethereum')).toBe('Ethereum: switch offered — switching signs nothing.')
    expect(announcePublishLane(lane('deploying'), 'Ethereum')).toBe('Ethereum: deploying its basket.')
    expect(announcePublishLane(lane('done'), 'Ethereum')).toBe('Ethereum: basket live.')
    expect(announcePublishLane(lane('failed'), 'Ethereum')).toBe('Ethereum: needs a retry.')
    expect(announcePublishLane(lane('queued'), 'Ethereum')).toBe('Ethereum: queued.')
  })
})

// ── readiness ────────────────────────────────────────────────────────────────

describe('deployReadiness', () => {
  const PRICE = 100_000_000_000_000_000n // 0.1 ETH

  it('mirrors use-deploy’s exact preflight headroom (one law, never a second gas model)', () => {
    expect(DEPLOY_GAS_HEADROOM_WEI).toBe(10_000_000_000_000_000n)
  })

  it('an unreadable balance is UNKNOWN, never zero, never ready', () => {
    const r = deployReadiness(8453, null, PRICE)
    expect(r.kind).toBe('unknown-balance')
    expect(r.words).toContain('readiness unknown')
  })

  it('an unreadable balance still states the deploy cost when the PRICE is readable (a public read)', () => {
    const r = deployReadiness(8453, null, PRICE)
    // 0.1 price + 0.01 headroom
    expect(r.words).toContain('0.1100')
    expect(r.words).toContain('deploy price + gas')
    // \u2026and stays silent about cost when the price is unknown too
    const noPrice = deployReadiness(8453, null, null)
    expect(noPrice.words).not.toContain('Deploys at')
  })

  it('an unreadable price states the slot may be closed and promises the cost at deploy time', () => {
    const r = deployReadiness(8453, 10n ** 18n, null)
    expect(r.kind).toBe('unknown-price')
    expect(r.words).toContain('deploy time')
  })

  it('short names the exact gap, rounded through the same wei math', () => {
    const have = 50_000_000_000_000_000n // 0.05
    const r = deployReadiness(8453, have, PRICE)
    expect(r.kind).toBe('short')
    if (r.kind === 'short') {
      expect(r.needWei).toBe(PRICE + DEPLOY_GAS_HEADROOM_WEI)
      expect(r.missingWei).toBe(r.needWei - have)
      expect(r.words).toContain('0.0600') // the missing 0.06
      expect(r.words).toContain('deploy price + gas')
    }
  })

  it('ready only at price + headroom or above — exactly the prepare() gate', () => {
    const exact = PRICE + DEPLOY_GAS_HEADROOM_WEI
    expect(deployReadiness(8453, exact, PRICE).kind).toBe('ready')
    expect(deployReadiness(8453, exact - 1n, PRICE).kind).toBe('short')
  })

  // the owner 2026-08-13: "condense, use more width, remove text to make it fit
  // the viewport" — the card wears `brief`. It may drop teaching; it may never
  // drop a figure.
  it('brief keeps EVERY figure the sentence states, in a label', () => {
    const have = 50_000_000_000_000_000n // 0.05
    const r = deployReadiness(8453, have, PRICE)
    expect(r.brief).toContain('0.0500') // holds
    expect(r.brief).toContain('0.1100') // needs (price + headroom)
    expect(r.brief).toContain('0.0600') // the gap
    expect(r.brief.length).toBeLessThan(r.words.length)
    const ready = deployReadiness(8453, 10n ** 18n, PRICE)
    expect(ready.brief).toContain('1.0000')
    expect(ready.brief).toContain('0.1100')
  })

  it('brief states the unknowns as unknowns, never as zero or ready', () => {
    expect(deployReadiness(8453, null, PRICE).brief).toContain('unreadable')
    expect(deployReadiness(8453, null, PRICE).brief).toContain('0.1100') // the public price still shows
    expect(deployReadiness(8453, null, null).brief).toContain('unreadable')
    expect(deployReadiness(8453, 10n ** 18n, null).brief).toContain('unreadable')
    expect(deployReadiness(8453, 10n ** 18n, null).brief).toContain('1.0000')
  })
})

// ── the funding door's reach ─────────────────────────────────────────────────

describe('fundingPlan — one action, and the truth about what it moves', () => {
  const base = { chainId: 8453, gasSymbol: 'ETH', settlementSymbol: 'USDC' }
  const eth = { chainId: 1, gasSymbol: 'ETH', settlementSymbol: 'USDC' }

  it('nothing short ⇒ no funding action at all', () => {
    expect(fundingPlan([])).toBeNull()
  })

  it('NEVER implies it delivers gas — the label names both currencies', () => {
    const p = fundingPlan([base])
    expect(p?.kind).toBe('door')
    if (p?.kind !== 'door') throw new Error('expected a door')
    expect(p.openChainId).toBe(8453)
    expect(p.label).toContain('USDC')
    expect(p.label).toContain('not ETH')
    expect(p.note).toContain('cannot deliver ETH')
    // the promise it must never make
    expect(p.label).not.toMatch(/then publish/i)
  })

  it('opens on the FIRST short network and says the others are short too', () => {
    const p = fundingPlan([base, eth])
    if (p?.kind !== 'door') throw new Error('expected a door')
    expect(p.openChainId).toBe(8453)
    expect(p.shortChainIds).toEqual([8453, 1])
    expect(p.note).toContain('short too')
  })

  it('skips a short network the door cannot reach and opens on one it can', () => {
    const nowhere = { chainId: 4663, gasSymbol: 'ETH', settlementSymbol: null }
    const p = fundingPlan([nowhere, base])
    if (p?.kind !== 'door') throw new Error('expected a door')
    expect(p.openChainId).toBe(8453)
    expect(p.shortChainIds).toEqual([4663, 8453])
  })

  it('no settlement asset anywhere short ⇒ NO door, and it says so instead of opening one', () => {
    const p = fundingPlan([{ chainId: 4663, gasSymbol: 'ETH', settlementSymbol: null }])
    expect(p?.kind).toBe('no-route')
    if (p?.kind !== 'no-route') throw new Error('expected no-route')
    expect(p.note).toContain('no way to move funds there')
    expect(p.shortChainIds).toEqual([4663])
  })

  it('speaks each chain’s OWN gas + settlement symbols, never a hardcoded pair', () => {
    const p = fundingPlan([{ chainId: 4663, gasSymbol: 'RBH', settlementSymbol: 'USDG' }])
    if (p?.kind !== 'door') throw new Error('expected a door')
    expect(p.label).toContain('USDG')
    expect(p.label).toContain('not RBH')
    expect(p.note).toContain('short of RBH')
  })
})

// ── the identity lock ────────────────────────────────────────────────────────

describe('deployerRefusal — one deployer for the whole bundle', () => {
  const A = '0x000000000000000000000000000000000000aaaa'
  const B = '0x000000000000000000000000000000000000bbbb'

  it('refuses a SECOND wallet by name once a lane has landed (the live 2026-08-13 bug)', () => {
    const words = deployerRefusal(A, B)
    expect(words).not.toBeNull()
    // both wallets are named — "which one?" must never be the creator's problem
    expect(words).toContain('0x0000…aaaa')
    expect(words).toContain('0x0000…bbbb')
    expect(words).toContain('Reconnect')
    expect(words).toContain('start a new bundle')
  })

  it('the same wallet proceeds — and case is not identity', () => {
    expect(deployerRefusal(A, A)).toBeNull()
    expect(deployerRefusal(A, A.toUpperCase().replace('0X', '0x'))).toBeNull()
    expect(deployerRefusal(A.toUpperCase().replace('0X', '0x'), A)).toBeNull()
  })

  it('before anything has landed there is NO anchor, so any wallet may still be the creator', () => {
    expect(deployerRefusal(null, B)).toBeNull()
    expect(deployerRefusal(undefined, B)).toBeNull()
    expect(deployerRefusal('', B)).toBeNull()
  })

  it('a disconnected wallet is not a mismatch — the connect CTA governs that', () => {
    expect(deployerRefusal(A, null)).toBeNull()
    expect(deployerRefusal(A, undefined)).toBeNull()
    expect(deployerRefusal(A, '')).toBeNull()
  })
})

// ── words + laws ─────────────────────────────────────────────────────────────

describe('the ceremony’s words', () => {
  it('the interruption footer tells the recognition story verbatim', () => {
    // the owner 2026-08-13: "center this text and remove em dash and make a little
    // larger" — two sentences now; the centering and the type step belong to
    // the render site (PublishBundleModal's ship footer).
    expect(PUBLISH_INTERRUPTION_NOTE).toBe(
      'If this closes mid-way, finished networks keep their baskets. The bundle recognises them the moment the rest ship.',
    )
    expect(PUBLISH_INTERRUPTION_NOTE).not.toContain('—')
  })

  it('the honesty plate counts baskets and states the split law', () => {
    const words = publishPlateWords(3)
    expect(words).toContain('3 baskets')
    expect(words).toContain('one per network')
    expect(words).toContain('deploy price plus gas')
    expect(words).toContain('renormalize to 100%')
    expect(publishPlateWords(1)).toContain('1 basket —')
  })

  it('the disabled note offers nothing and loses nothing', () => {
    expect(DEPLOYS_DISABLED_NOTE).toContain('deploys are disabled')
    expect(DEPLOYS_DISABLED_NOTE).toContain('nothing is lost')
  })

  it('a confirmed-but-unread deploy is DONE with a warning, never a retryable failure', () => {
    expect(ADDRESS_UNREAD_NOTE).toContain('the basket is live')
  })
})

describe('ticker + name laws', () => {
  it('cleanTicker enforces the builder’s own symbol law', () => {
    expect(cleanTicker('my-ticker!')).toBe('MYTICKER')
    expect(cleanTicker('averyverylongticker')).toBe('AVERYVERYLO')
    expect(TICKER_RE.test(cleanTicker('bevm'))).toBe(true)
    expect(TICKER_RE.test('')).toBe(false)
    expect(TICKER_RE.test('X')).toBe(false)
  })

  it('defaultTickers seeds every network from the one typed ticker', () => {
    expect(defaultTickers([8453, 1], 'bevm')).toEqual({ 8453: 'BEVM', 1: 'BEVM' })
    expect(defaultTickers([8453], '')).toEqual({ 8453: '' })
  })

  it('bundleNameOk is the builder’s nameValid', () => {
    expect(bundleNameOk('  a ')).toBe(false)
    expect(bundleNameOk('ab')).toBe(true)
  })
})
