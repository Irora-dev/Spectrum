import { describe, expect, it } from 'vitest'
import { zeroAddress } from 'viem'
import {
  assembleVersionSeed,
  deriveLauncher,
  droppedReason,
  resolveHoldingsForSeed,
  seedFeeConfig,
  seedWeightsFromPredecessor,
  SEED_TOO_FEW_ERROR,
  SEED_UNRESOLVABLE_ERROR,
  type BuilderAsset,
  type HoldingSeedInput,
} from './version-seed'
import { PoolDetectionError, Venue, ZERO_POOL_KEY } from '../pools'
import { LAUNCHER_ADDRESS } from '../config/operator'
import { bumpVersionTicker } from './versioning'
import { CAP, isValid, MIN } from './weights'
import type { BasketFees } from './use-basket-fees'

// The v1→draft recipe extracted from BasketBuilder's version-mode prefill. The
// stakes: this maps a LIVE basket's money config and composition into the next
// deploy, so every clamp, remainder push, drop and carry here is a deploy-time
// fact, not presentation.

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

const holding = (n: number, pct: number, over: Partial<HoldingSeedInput> = {}): HoldingSeedInput => ({
  asset: addr(n),
  symbol: `T${n}`,
  name: `Token ${n}`,
  decimals: 18,
  targetWeightPct: pct,
  ...over,
})

const asset = (n: number, over: Partial<BuilderAsset> = {}): BuilderAsset => ({
  address: addr(n),
  symbol: `T${n}`,
  decimals: 18,
  venueLabel: 'Uniswap V4',
  depthUsd: 1_000_000,
  warnings: [],
  route: { venue: Venue.V4, ethPool: ZERO_POOL_KEY, v3Fee: 0, v2Pair: zeroAddress },
  ...over,
})

// The full on-chain shape assembleVersionSeed consumes; the protocol-constant
// fields are inert to the seed (it picks fee/share/payout only) but the type
// is the honest one — a narrowed fixture would let the seed silently start
// reading a field the fixture never carried.
const fees = (over: Partial<BasketFees> = {}): BasketFees => ({
  basketFeeBps: 100,
  creatorShareBps: 3000,
  creatorPayout: '0x00000000000000000000000000000000000000AA',
  burnShareBps: 4000,
  interfaceShareBps: 500,
  launcherShareBps: 500,
  maxCreatorShareBps: 3000,
  launcher: null,
  deployer: null,
  ...over,
})

describe('seedWeightsFromPredecessor', () => {
  it('carries whole v1 weights verbatim when every leg survives', () => {
    const w = seedWeightsFromPredecessor([asset(1), asset(2), asset(3)], [holding(1, 50), holding(2, 30), holding(3, 20)])
    expect(w).toEqual([50, 30, 20])
  })

  it('rounds fractional on-chain pcts and pushes the remainder onto the largest', () => {
    // 3333/3333/3334 bps → 33.33/33.33/33.34 → rounds to 33+33+33 = 99; the
    // missing point lands on the largest (first of the ties), never spread.
    const w = seedWeightsFromPredecessor(
      [asset(1), asset(2), asset(3)],
      [holding(1, 33.33), holding(2, 33.33), holding(3, 33.34)],
    )
    expect(w).toEqual([34, 33, 33])
    expect(w.reduce((s, x) => s + x, 0)).toBe(CAP)
  })

  it('carries sub-floor legs verbatim now the floor is 1 — and still floors a true 0', () => {
    // 2% legs were inflated to the old 5 floor; owner 2026-08-12 relaxed the
    // floor to 1, so a foreign 2% conviction seeds AS IT IS.
    const w = seedWeightsFromPredecessor(
      [asset(1), asset(2), asset(3)],
      [holding(1, 2), holding(2, 2), holding(3, 96)],
    )
    expect(w).toEqual([2, 2, 96])
    expect(w.reduce((s, x) => s + x, 0)).toBe(CAP)
  })

  it("pushes a dropped leg's whole mass onto the largest survivor — never renormalized pro-rata", () => {
    // v1 was 40/35/25; the 25 leg died. The builder's recipe hands ALL 25
    // points to the 40 leg, not 40→53/35→47.
    const w = seedWeightsFromPredecessor([asset(1), asset(2)], [holding(1, 40), holding(2, 35), holding(3, 25)])
    expect(w).toEqual([65, 35])
    expect(w.reduce((s, x) => s + x, 0)).toBe(CAP)
  })

  it('floors an unknown leg at MIN and rebalances from the largest', () => {
    // A leg the holdings map cannot answer for maps to 0 → clamped to MIN (=1).
    const w = seedWeightsFromPredecessor([asset(1), asset(2), asset(3)], [holding(1, 95), holding(2, 5)])
    expect(w).toEqual([94, 5, MIN])
    expect(w.reduce((s, x) => s + x, 0)).toBe(CAP)
  })

  it('maps weights by address case-insensitively', () => {
    const upper = asset(1, { address: addr(1).replace('0x', '0X').toUpperCase().replace('0X', '0x') })
    const w = seedWeightsFromPredecessor([upper, asset(2)], [holding(1, 70), holding(2, 30)])
    expect(w).toEqual([70, 30])
  })

  it('returns the honest unfixable vector when clamped floors alone exceed CAP', () => {
    // With the 1% floor this needs >CAP legs (a hostile synthetic input — the
    // 20-asset cap refuses it far earlier); the recipe still never invents a
    // shorter basket or a sub-floor weight, and isValid() is what refuses.
    const legs = Array.from({ length: 101 }, (_, i) => asset(i + 1))
    const holdings = Array.from({ length: 101 }, (_, i) => holding(i + 1, 100 / 101))
    const w = seedWeightsFromPredecessor(legs, holdings)
    expect(w.every((x) => x === MIN)).toBe(true)
    expect(w.reduce((s, x) => s + x, 0)).toBe(101)
    expect(isValid(w)).toBe(false)
  })

  it('returns [] for no legs', () => {
    expect(seedWeightsFromPredecessor([], [holding(1, 100)])).toEqual([])
  })
})

describe('droppedReason', () => {
  it("passes a PoolDetectionError's user-facing message through", () => {
    expect(droppedReason(new PoolDetectionError('No pool found for this token on Base.', 'NO_POOL'))).toBe(
      'No pool found for this token on Base.',
    )
  })

  it('falls back to an honest generic line for anything else', () => {
    expect(droppedReason(new Error('boom'))).toBe('No live pool could be found for this asset today.')
  })
})

describe('resolveHoldingsForSeed', () => {
  const resolveOk = (a: string, _c: number, sym?: string) =>
    Promise.resolve(asset(0, { address: a, symbol: sym ?? '?' }))

  it('resolves every leg in holdings order', async () => {
    const res = await resolveHoldingsForSeed([holding(1, 60), holding(2, 40)], 8453, {
      poolReady: true,
      resolve: resolveOk,
    })
    expect(res.ok.map((a) => a.symbol)).toEqual(['T1', 'T2'])
    expect(res.dropped).toEqual([])
  })

  it('drops a genuinely dead pool WITH its reason, keeping survivors in order', async () => {
    const res = await resolveHoldingsForSeed([holding(1, 50), holding(2, 30), holding(3, 20)], 8453, {
      poolReady: true,
      resolve: (a, c, s) =>
        a === addr(2) ? Promise.reject(new PoolDetectionError('No pool for T2.', 'NO_POOL')) : resolveOk(a, c, s),
    })
    expect(res.ok.map((a) => a.symbol)).toEqual(['T1', 'T3'])
    expect(res.dropped).toEqual([{ address: addr(2), symbol: 'T2', reason: 'No pool for T2.' }])
  })

  it('ABORTS the whole sweep on a retryable failure — never a silently-shorter basket (F4)', async () => {
    await expect(
      resolveHoldingsForSeed([holding(1, 50), holding(2, 50)], 8453, {
        poolReady: true,
        resolve: (a, c, s) =>
          a === addr(2)
            ? Promise.reject(new PoolDetectionError('RPC dropped the V3 sweep.', 'VENUE_CHECK_FAILED'))
            : resolveOk(a, c, s),
      }),
    ).rejects.toThrow('RPC dropped the V3 sweep.')
  })

  it('treats a raw transport throw as retryable too — abort, not a drop', async () => {
    await expect(
      resolveHoldingsForSeed([holding(1, 50), holding(2, 50)], 8453, {
        poolReady: true,
        resolve: () => Promise.reject(new Error('fetch failed')),
      }),
    ).rejects.toThrow('fetch failed')
  })

  it("without pool infra, carries the leg over marked 'unverified' instead of dropping", async () => {
    const res = await resolveHoldingsForSeed([holding(1, 60), holding(2, 40)], 4663, {
      poolReady: false,
      resolve: () => Promise.reject(new Error('no detection on this build')),
    })
    expect(res.ok).toHaveLength(2)
    expect(res.ok[0].venueLabel).toBe('unverified')
    expect(res.ok[0].warnings).toEqual(['Routing not re-checked on this build, verify before deploy.'])
    expect(res.ok[0].route).toEqual({ venue: Venue.V2, ethPool: ZERO_POOL_KEY, v3Fee: 0, v2Pair: zeroAddress })
    // getAddress checksums the carried address
    expect(res.ok[0].address.slice(0, 2)).toBe('0x')
    expect(res.dropped).toEqual([])
  })

  it('without pool infra, an unparseable address is dropped with its reason', async () => {
    const res = await resolveHoldingsForSeed(
      [holding(1, 60), { ...holding(2, 40), asset: 'not-an-address' }],
      4663,
      { poolReady: false, resolve: () => Promise.reject(new Error('no detection')) },
    )
    expect(res.ok).toHaveLength(1)
    expect(res.dropped).toEqual([{ address: 'not-an-address', symbol: 'T2', reason: 'Unparseable asset address.' }])
  })
})

describe('assembleVersionSeed', () => {
  it('assembles the full draft: name verbatim, ticker kept, fees carried, weights lawful', () => {
    const ok = [asset(1), asset(2)]
    const a = assembleVersionSeed({
      name: 'Blue Basket',
      symbol: 'BLUE',
      holdings: [holding(1, 60), holding(2, 40)],
      ok,
      dropped: [],
      fees: fees(),
    })
    expect(a.errorKind).toBeNull()
    expect(a.error).toBeNull()
    expect(a.draft?.name).toBe('Blue Basket') // verbatim, never "Blue Basket v2"
    expect(a.draft?.symbol).toBe('BLUE') // v1's own ticker — keep-same default
    expect(a.draft?.symbol).not.toBe(bumpVersionTicker('BLUE')) // the bump is offered by the UIs, never seeded
    expect(a.draft?.weights).toEqual([60, 40])
    expect(a.draft?.legs.map((l) => [l.symbol, l.name, l.decimals])).toEqual([
      ['T1', 'Token 1', 18],
      ['T2', 'Token 2', 18],
    ])
    // the route is findBestPool's LIVE verdict riding through, never rebuilt
    expect(a.draft?.legs[0].route).toBe(ok[0].route)
    expect(a.draft?.feeConfig).toEqual({
      basketFeeBps: 100,
      creatorShareBps: 3000,
      creatorPayout: '0x00000000000000000000000000000000000000AA',
      launcher: zeroAddress, // NEVER carried — re-derived at deploy (deriveLauncher)
    })
  })

  it("seeds the predecessor's own ticker — keep-same is the default (owner 2026-08-12)", () => {
    // "for editing a basket the default should be to keep the same ticker and
    // give people a toggle if they do want to change the ticker" — so the seed
    // carries v1's symbol untouched, even one the bumper WOULD rewrite;
    // bumpVersionTicker survives only as the toggle's offered convenience.
    const base = { holdings: [holding(1, 60), holding(2, 40)], ok: [asset(1), asset(2)], dropped: [], fees: fees() }
    const plain = assembleVersionSeed({ ...base, name: 'B', symbol: 'BLUE' })
    expect(plain.draft?.symbol).toBe('BLUE')
    expect(plain.symbol).toBe('BLUE') // the builder-fidelity field agrees
    const versioned = assembleVersionSeed({ ...base, name: 'B', symbol: 'TBV2' })
    expect(versioned.draft?.symbol).toBe('TBV2') // not TBV3
    expect(versioned.draft?.symbol).not.toBe(bumpVersionTicker('TBV2'))
  })

  it('states dropped legs on a ready seed — a narrower draft is never silent', () => {
    const dropped = [{ address: addr(3), symbol: 'T3', reason: 'No pool for T3.' }]
    const a = assembleVersionSeed({
      name: 'B',
      symbol: 'B',
      holdings: [holding(1, 40), holding(2, 35), holding(3, 25)],
      ok: [asset(1), asset(2)],
      dropped,
      fees: fees(),
    })
    expect(a.dropped).toBe(dropped)
    expect(a.draft?.weights).toEqual([65, 35]) // the dead leg's mass on the largest
  })

  it('ONE survivor VERSIONS (supersedes the old two-asset law — MIN_ASSETS is 1, weights.ts, the owner\'s own ruling; hit live 2026-08-16 editing a single-asset leg)', () => {
    const a = assembleVersionSeed({
      name: 'B',
      symbol: 'B',
      holdings: [holding(1, 50), holding(2, 50)],
      ok: [asset(1)],
      dropped: [{ address: addr(2), symbol: 'T2', reason: 'No pool.' }],
      fees: fees(),
    })
    expect(a.errorKind).toBeNull()
    expect(a.legs).toHaveLength(1)
    expect(a.weights).toEqual([100]) // the dropped leg's mass lands on the survivor, Σ = CAP
    expect(a.dropped).toHaveLength(1) // the drop stays NAMED, never silent
  })

  it('a single-asset predecessor versions cleanly — one holding, one survivor', () => {
    const a = assembleVersionSeed({
      name: 'B',
      symbol: 'B',
      holdings: [holding(1, 100)],
      ok: [asset(1)],
      dropped: [],
      fees: fees(),
    })
    expect(a.errorKind).toBeNull()
    expect(a.legs).toHaveLength(1)
    expect(a.weights).toEqual([100])
  })

  it('ZERO survivors of a real predecessor is the poisoned-draft error — nothing else is written', () => {
    const a = assembleVersionSeed({
      name: 'B',
      symbol: 'B',
      holdings: [holding(1, 100)],
      ok: [],
      dropped: [{ address: addr(1), symbol: 'T1', reason: 'No pool.' }],
      fees: fees(),
    })
    expect(a.errorKind).toBe('unresolvable')
    expect(a.error).toBe(SEED_UNRESOLVABLE_ERROR)
    expect(a.draft).toBeNull()
    expect(a.legs).toBeNull()
    expect(a.name).toBeNull() // the partial name/fees-only prefill is exactly the poison
  })

  it('a ZERO-holding predecessor has nothing to version — its own kind, so the builder can stay silent', () => {
    const a = assembleVersionSeed({ name: 'B', symbol: 'B', holdings: [], ok: [], dropped: [], fees: fees() })
    expect(a.errorKind).toBe('too-few-holdings')
    expect(a.error).toBe(SEED_TOO_FEW_ERROR)
    expect(a.draft).toBeNull()
  })

  it('an unreadable fee config yields NO draft (fees carry silently in the popup) but keeps the builder fields', () => {
    const a = assembleVersionSeed({
      name: 'Blue Basket',
      symbol: 'BLUE',
      holdings: [holding(1, 60), holding(2, 40)],
      ok: [asset(1), asset(2)],
      dropped: [],
      fees: null,
    })
    expect(a.errorKind).toBe('fees-unreadable')
    expect(a.draft).toBeNull() // the popup must never deploy fees the creator never saw
    // ...while the builder still prefills legs/identity and falls back to its
    // own VISIBLE, editable fee defaults:
    expect(a.legs).toHaveLength(2)
    expect(a.weights).toEqual([60, 40])
    expect(a.name).toBe('Blue Basket')
    expect(a.symbol).toBe('BLUE') // keep-same rides the builder fields too
  })
})

describe('seedFeeConfig', () => {
  it('maps a zero creator share to the zero-address payout (the BadCreatorShare invariant)', () => {
    expect(seedFeeConfig(fees({ creatorShareBps: 0, creatorPayout: null }))).toEqual({
      basketFeeBps: 100,
      creatorShareBps: 0,
      creatorPayout: zeroAddress,
      launcher: zeroAddress,
    })
  })
})

describe('deriveLauncher', () => {
  const me = '0x00000000000000000000000000000000000000Cc'
  const ref = '0x00000000000000000000000000000000000000dD' as `0x${string}`
  const operator = LAUNCHER_ADDRESS ?? zeroAddress

  it('credits the referrer as launcher on a referred FIRST basket', () => {
    const d = deriveLauncher({ account: me, allBaskets: [], referrer: ref, refAlreadyUsed: false })
    expect(d).toEqual({ launcher: ref, appliedReferrer: true, isFirstBasket: true })
  })

  it('a LOADING basket list is NOT-first — never over-credit before the read resolves', () => {
    const d = deriveLauncher({ account: me, allBaskets: undefined, referrer: ref, refAlreadyUsed: false })
    expect(d.isFirstBasket).toBe(false)
    expect(d.appliedReferrer).toBe(false)
    expect(d.launcher).toBe(operator)
  })

  it('a wallet with an existing basket (any case) is not first', () => {
    const d = deriveLauncher({
      account: me,
      allBaskets: [{ deployer: me.toUpperCase().replace('0X', '0x') }],
      referrer: ref,
      refAlreadyUsed: false,
    })
    expect(d.isFirstBasket).toBe(false)
    expect(d.launcher).toBe(operator)
  })

  it('never credits a SELF-referrer as their own launcher', () => {
    const d = deriveLauncher({
      account: ref,
      allBaskets: [],
      referrer: ref,
      refAlreadyUsed: false,
    })
    expect(d.appliedReferrer).toBe(false)
    expect(d.launcher).toBe(operator)
  })

  it('the one-shot used flag closes the same-session race', () => {
    const d = deriveLauncher({ account: me, allBaskets: [], referrer: ref, refAlreadyUsed: true })
    expect(d.appliedReferrer).toBe(false)
    expect(d.launcher).toBe(operator)
  })

  it('no referrer → the operator launcher (or the zero address when none is configured)', () => {
    const d = deriveLauncher({ account: me, allBaskets: [], referrer: null, refAlreadyUsed: false })
    expect(d.launcher).toBe(operator)
    expect(d.appliedReferrer).toBe(false)
  })
})
