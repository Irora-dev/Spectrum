import { describe, expect, it } from 'vitest'
import { ADD_AT, CAP, MAX_ASSETS, MIN, STEP, equalSplit, sum } from '../../lib/spectrum/weights'
import { Venue, ZERO_POOL_KEY, type BasketRoute } from '../../lib/pools/types'
import { computeBasketDiff } from '../../lib/spectrum/versioning'
import type { ReshapeDraft, ReshapeLeg } from './reshape-types'
import {
  adjustDraftWeight,
  appendResolvedLeg,
  clampSymbolInput,
  demoSubjectRefusal,
  draftReadyToShip,
  draftToDeployInput,
  draftToDiffSide,
  droppedLine,
  equalizeDraft,
  removeDraftLeg,
  setDraftWeightPct,
  validateAddAsset,
  type AddAssetEffects,
} from './reshape-model'

// ─────────────────────────────────────────────────────────────────────────────
// The reshape model under test: the weight law's boundaries, the two adapters
// (deploy args and diff input — the shapes money and honesty flow through),
// the add pipeline's refusal order, and the demo refusal. Effects are
// injected; nothing here touches an RPC.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE: BasketRoute = {
  venue: Venue.V4,
  ethPool: { ...ZERO_POOL_KEY },
  v3Fee: 0,
  v2Pair: '0x0000000000000000000000000000000000000000',
}

const addr = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`

function leg(n: number, symbol: string): ReshapeLeg {
  return { address: addr(n), symbol, name: null, decimals: 18, route: ROUTE }
}

function draftOf(weights: number[], over: Partial<ReshapeDraft> = {}): ReshapeDraft {
  return {
    name: 'Blue Majority',
    symbol: 'BLUEV2',
    legs: weights.map((_, i) => leg(i + 1, `T${i + 1}`)),
    weights,
    feeConfig: {
      basketFeeBps: 150,
      creatorShareBps: 1000,
      creatorPayout: addr(0xbeef),
      launcher: addr(0xcafe),
    },
    ...over,
  }
}

/** Effects that refuse to be called — for stages the pipeline must never reach. */
const untouchableFx: AddAssetEffects = {
  isPoolToken: () => {
    throw new Error('isPoolToken must not be reached')
  },
  basketLineage: () => {
    throw new Error('basketLineage must not be reached')
  },
  resolve: () => {
    throw new Error('resolve must not be reached')
  },
}

const passingFx = (over: Partial<AddAssetEffects> = {}): AddAssetEffects => ({
  isPoolToken: async () => false,
  basketLineage: async () => null,
  resolve: async (address, _chainId, knownSymbol) => ({
    address,
    symbol: knownSymbol ?? 'NEW',
    decimals: 6,
    route: ROUTE,
  }),
  ...over,
})

// ── the weight law under every mutation ──────────────────────────────────────

describe('draft mutations keep the weights.ts law (Σ=CAP, MIN floor)', () => {
  it('adjusting up borrows from the largest and re-lands on CAP', () => {
    const d = adjustDraftWeight(draftOf([50, 30, 20]), 2, +STEP)
    expect(sum(d.weights)).toBe(CAP)
    expect(d.weights[2]).toBe(25)
    expect(d.weights[0]).toBe(45) // borrowed from the largest
  })

  it('adjusting below the MIN floor clamps at MIN, never lower', () => {
    const d = adjustDraftWeight(draftOf([50, 30, 20]), 2, -100)
    expect(d.weights[2]).toBe(MIN)
    expect(sum(d.weights)).toBe(CAP)
  })

  it('the dial snaps a raw TrimBar value to STEP before setting', () => {
    const d = setDraftWeightPct(draftOf([50, 30, 20]), 1, 33.4)
    expect(d.weights[1]).toBe(35) // 33.4 → 35 (nearest STEP)
    expect(sum(d.weights)).toBe(CAP)
  })

  it('removing a leg hands its weight back and keeps legs/weights aligned', () => {
    const d = removeDraftLeg(draftOf([50, 30, 20]), 1)
    expect(d.legs.map((l) => l.symbol)).toEqual(['T1', 'T3'])
    expect(d.weights).toHaveLength(2)
    expect(sum(d.weights)).toBe(CAP)
  })

  it('appending lands the new leg at ADD_AT — a visible landing, never the bare 1% floor', () => {
    const d = appendResolvedLeg(draftOf([60, 40]), leg(9, 'NEW'))
    expect(d.legs).toHaveLength(3)
    expect(d.weights[2]).toBe(ADD_AT)
    expect(sum(d.weights)).toBe(CAP)
  })

  it('appending to a FULL draft is a no-op (the ceiling holds)', () => {
    const full = draftOf(equalSplit(MAX_ASSETS))
    const d = appendResolvedLeg(full, leg(99, 'OVER'))
    expect(d.legs).toHaveLength(MAX_ASSETS)
    expect(sum(d.weights)).toBe(CAP)
  })

  it('equalize splits evenly to exactly CAP', () => {
    const d = equalizeDraft(draftOf([85, 10, 5]))
    expect(sum(d.weights)).toBe(CAP)
    expect(Math.max(...d.weights) - Math.min(...d.weights)).toBeLessThanOrEqual(1)
  })
})

// ── ship-gate + identity clamp ───────────────────────────────────────────────

describe('draftReadyToShip', () => {
  it('accepts a lawful draft and refuses a broken one', () => {
    expect(draftReadyToShip(draftOf([50, 30, 20]))).toBe(true)
    expect(draftReadyToShip(null)).toBe(false)
    expect(draftReadyToShip(draftOf([50, 30, 20], { name: '  ' }))).toBe(false)
    expect(draftReadyToShip(draftOf([50, 30, 20], { symbol: '' }))).toBe(false)
    expect(draftReadyToShip(draftOf([50, 30, 19]))).toBe(false) // Σ=99
    const misaligned = draftOf([50, 50])
    misaligned.legs = misaligned.legs.slice(0, 1)
    expect(draftReadyToShip(misaligned)).toBe(false)
  })
})

describe('clampSymbolInput (the builder’s own ticker clamp)', () => {
  it('uppercases, strips non-alphanumerics, caps at 11', () => {
    expect(clampSymbolInput('blue v2!')).toBe('BLUEV2')
    expect(clampSymbolInput('abcdefghijklmno')).toBe('ABCDEFGHIJK')
    expect(clampSymbolInput('abcdefghijklmno')).toHaveLength(11)
  })
})

// ── adapters ─────────────────────────────────────────────────────────────────

describe('draftToDeployInput', () => {
  const LAUNCHER = addr(0xfeed)

  it('keeps weights in WHOLE PERCENT — bps is toBasketEntries’ job, never done here', () => {
    const input = draftToDeployInput(draftOf([50, 30, 20]), { launcher: LAUNCHER })
    expect(input.weights).toEqual([50, 30, 20]) // NOT [5000, 3000, 2000]
    expect(sum(input.weights)).toBe(CAP)
  })

  it('carries fee/share/payout verbatim and RE-DERIVES the launcher', () => {
    const d = draftOf([100])
    const input = draftToDeployInput(d, { launcher: LAUNCHER })
    expect(input.feeConfig.basketFeeBps).toBe(150)
    expect(input.feeConfig.creatorShareBps).toBe(1000)
    expect(input.feeConfig.creatorPayout).toBe(d.feeConfig.creatorPayout)
    expect(input.feeConfig.launcher).toBe(LAUNCHER) // v1's launcher never carries
  })

  it('maps legs to DeployAssetInput and sends no seed', () => {
    const input = draftToDeployInput(draftOf([60, 40]), { launcher: LAUNCHER })
    expect(input.assets).toEqual([
      { address: addr(1), decimals: 18, route: ROUTE },
      { address: addr(2), decimals: 18, route: ROUTE },
    ])
    expect(input.seed).toBeNull()
    expect(input.name).toBe('Blue Majority')
    expect(input.symbol).toBe('BLUEV2')
  })

  it('refuses (throws) on a broken Σ, misalignment, or an empty draft', () => {
    expect(() => draftToDeployInput(draftOf([50, 45]), { launcher: LAUNCHER })).toThrow(/sum/)
    const misaligned = draftOf([50, 50])
    misaligned.weights = [100]
    expect(() => draftToDeployInput(misaligned, { launcher: LAUNCHER })).toThrow(/misaligned/)
    expect(() => draftToDeployInput(draftOf([]), { launcher: LAUNCHER })).toThrow(/empty/)
  })
})

describe('draftToDiffSide → computeBasketDiff (the review’s honesty path)', () => {
  it('added, removed and reweighted all fire across a v1→draft diff', () => {
    // v1: T1 50 / T2 30 / T3 20 — draft: T1 60 / T2 30 / NEW 10 (T3 dropped)
    const v1 = draftToDiffSide(draftOf([50, 30, 20]), 8453, addr(0xaaaa))
    const next = draftOf([60, 30, 10])
    next.legs = [leg(1, 'T1'), leg(2, 'T2'), leg(9, 'NEW')]
    const diff = computeBasketDiff(v1, draftToDiffSide(next, 8453))

    expect(diff.addedCount).toBe(1)
    expect(diff.removedCount).toBe(1)
    expect(diff.reweightedCount).toBe(1)

    const byKind = Object.fromEntries(diff.constituents.map((c) => [c.kind, c]))
    expect(byKind.added.symbol).toBe('NEW')
    expect(byKind.added.toWeightPct).toBe(10)
    expect(byKind.removed.symbol).toBe('T3')
    expect(byKind.removed.fromWeightPct).toBe(20)
    expect(byKind.reweighted.symbol).toBe('T1')
    expect(byKind.reweighted.fromWeightPct).toBe(50)
    expect(byKind.reweighted.toWeightPct).toBe(60)
    expect(byKind.unchanged.symbol).toBe('T2')
  })

  it('an untouched draft diffs as all-unchanged (no phantom changes)', () => {
    const a = draftToDiffSide(draftOf([50, 50]), 1)
    const b = draftToDiffSide(draftOf([50, 50]), 1)
    const diff = computeBasketDiff(a, b)
    expect(diff.addedCount + diff.removedCount + diff.reweightedCount).toBe(0)
  })

  it('carries targetWeightPct exactly (the one field the diff reads)', () => {
    const side = draftToDiffSide(draftOf([65, 35]), 1)
    expect(side.holdings.map((h) => h.targetWeightPct)).toEqual([65, 35])
    expect(side.holdings.map((h) => h.asset)).toEqual([addr(1), addr(2)])
  })
})

// ── the demo refusal (thesis-run.ts:134’s law, applied to the arm handler) ───

describe('demoSubjectRefusal', () => {
  const DEMO_SUBJECT = `0x${'0'.repeat(32)}de500003` as `0x${string}`

  it('refuses REAL mode on a demo subject, with a stated sentence', () => {
    const refusal = demoSubjectRefusal(DEMO_SUBJECT, false)
    expect(refusal).toBeTruthy()
    expect(refusal).toMatch(/demo/i)
  })

  it('allows demo mode on a demo subject (the walkthrough is the point)', () => {
    expect(demoSubjectRefusal(DEMO_SUBJECT, true)).toBeNull()
  })

  it('allows real mode on a real subject', () => {
    expect(demoSubjectRefusal(addr(0x1234), false)).toBeNull()
  })
})

// ── the dropped-legs sentence ────────────────────────────────────────────────

describe('droppedLine', () => {
  it('is null when nothing was dropped', () => {
    expect(droppedLine([])).toBeNull()
  })

  it('states the count, each symbol and its reason', () => {
    const line = droppedLine([
      { address: addr(7), symbol: 'GONE', reason: 'no routable pool today' },
      { address: addr(8), symbol: 'ALSO', reason: 'screened out' },
    ])
    expect(line).toContain('2 of v1')
    expect(line).toContain('$GONE (no routable pool today)')
    expect(line).toContain('$ALSO (screened out)')
  })

  it('bounds a hostile symbol before it reaches the sentence', () => {
    const line = droppedLine([{ address: addr(7), symbol: 'A'.repeat(300), reason: 'x' }])
    expect(line!.length).toBeLessThan(160) // clipped by showSymbol, never a wall
  })
})

// ── the add pipeline: refusal order + fail-open laws ─────────────────────────

describe('validateAddAsset', () => {
  const CHAIN = 8453
  const base = draftOf([60, 40])

  it('refuses a malformed address before ANY effect runs', async () => {
    const v = await validateAddAsset(base, 'not-an-address', CHAIN, untouchableFx)
    expect(v).toEqual({ ok: false, reason: expect.stringMatching(/valid token contract address/) })
  })

  it('refuses a duplicate (case-insensitively) before any effect runs', async () => {
    const v = await validateAddAsset(base, addr(1).toUpperCase().replace('0X', '0x'), CHAIN, untouchableFx)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/already in the basket/)
  })

  it('refuses at the MAX_ASSETS ceiling before any effect runs', async () => {
    const full = draftOf(new Array(MAX_ASSETS).fill(MIN))
    const v = await validateAddAsset(full, addr(999), CHAIN, untouchableFx)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain(String(MAX_ASSETS))
  })

  it('refuses a liquidity-pool token', async () => {
    const v = await validateAddAsset(base, addr(50), CHAIN, passingFx({ isPoolToken: async () => true }))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/liquidity-pool token/)
  })

  it('refuses a Spectrum basket as a leg (F7)', async () => {
    const v = await validateAddAsset(base, addr(51), CHAIN, passingFx({ basketLineage: async () => ({ any: 'lineage' }) }))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/basket can’t be a leg/)
  })

  it('a FAILED lineage read is not a verdict — the asset passes through', async () => {
    const v = await validateAddAsset(
      base,
      addr(52),
      CHAIN,
      passingFx({
        basketLineage: async () => {
          throw new Error('rpc down')
        },
      }),
    )
    expect(v.ok).toBe(true)
  })

  it('a THROWN pool probe fails open (not a pool) rather than blocking the add', async () => {
    const v = await validateAddAsset(
      base,
      addr(53),
      CHAIN,
      passingFx({
        isPoolToken: async () => {
          throw new Error('rpc blip')
        },
      }),
    )
    expect(v.ok).toBe(true)
  })

  it('returns the resolved leg — checksummed address, live route, decimals', async () => {
    const lower = addr(0xabcdef)
    const v = await validateAddAsset(base, lower, CHAIN, passingFx(), 'FRESH')
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.leg.symbol).toBe('FRESH')
      expect(v.leg.decimals).toBe(6)
      expect(v.leg.route).toBe(ROUTE)
      expect(v.leg.address.toLowerCase()).toBe(lower.toLowerCase())
    }
  })

  it('surfaces a PoolDetectionError’s own sentence, and the generic line otherwise', async () => {
    const detection = new Error('No pool for this asset on this chain.')
    detection.name = 'PoolDetectionError'
    const v1 = await validateAddAsset(
      base,
      addr(54),
      CHAIN,
      passingFx({
        resolve: async () => {
          throw detection
        },
      }),
    )
    expect(v1.ok).toBe(false)
    if (!v1.ok) expect(v1.reason).toBe('No pool for this asset on this chain.')

    const v2 = await validateAddAsset(
      base,
      addr(55),
      CHAIN,
      passingFx({
        resolve: async () => {
          throw new Error('socket hang up')
        },
      }),
    )
    expect(v2.ok).toBe(false)
    if (!v2.ok) expect(v2.reason).toMatch(/Could not validate this asset/)
  })
})
