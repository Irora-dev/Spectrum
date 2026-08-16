import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import { PoolDetectionError, Venue, ZERO_POOL_KEY } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// THE V2 REJECTION — a per-chain lineage flag, and what it may and may not change.
//
// The failure it answers (diagnosed 2026-08-13, commit 6b2a185): the rehearsal
// contract generation reverts `InvalidEthPool` on venue 2 in the basket
// constructor (contracts 626b83a, "V2 gutted"), CREATE2 discards the inner
// reason, and the factory can only report `CREATE2Failed`. So a V2-routed leg
// mined fine, priced fine, and bricked the deploy at simulate under a message
// that named no cause — it cost a live bundle publish on both rehearsal chains.
//
// The trap on the other side: PRODUCTION STILL ACCEPTS V2 (probe-verified the
// same day against the canonical factory). A blanket removal of the venue would
// change production routing for a constraint production does not have. Hence a
// FLAG, defaulting absent/false — and hence the first test below, which is the
// one with teeth: with the flag off, a deep V2 pair must still win exactly as it
// wins today. Everything else here is what the flag is allowed to do when it IS
// on: exclude V2 from the ranking, and refuse — by name — a token that has
// nowhere else to go.
//
// THE SEAM: findBestPool takes exactly two things from outside — the chain
// config (`chainCfg`) and a read client (`clientFor`) — plus DexScreener over
// fetch. All three are faked below, so the REAL detection, ranking and refusal
// run with no network.
// ─────────────────────────────────────────────────────────────────────────────

const A = vi.hoisted(() => ({
  weth: '0x4200000000000000000000000000000000000006' as Address,
  usdc: '0x00000000000000000000000000000000000d5dc0' as Address,
  factory: '0x00000000000000000000000000000000000fac70' as Address,
  uniV2Factory: '0x00000000000000000000000000000000000fac02' as Address,
  uniV3Factory: '0x00000000000000000000000000000000000fac03' as Address,
  poolManager: '0x00000000000000000000000000000000000fac04' as Address,
  /** trades on BOTH venues — its V2 pair is the deeper one */
  bothVenues: '0x00000000000000000000000000000000000a55e1' as Address,
  /** a Uniswap V2 pair is its ONLY route */
  v2Only: '0x00000000000000000000000000000000000a55e2' as Address,
  v2PairBoth: '0x00000000000000000000000000000000000d2a11' as Address,
  v2PairOnly: '0x00000000000000000000000000000000000d2a22' as Address,
  v3Pool: '0x00000000000000000000000000000000000d3a11' as Address,
}))

const CHAIN = 8453

/** Flipped per test — the flag under examination, plus one fault injector. */
const state = vi.hoisted(() => ({ rejectsV2Legs: false, v2ReservesUnreadable: false }))

vi.mock('../chain/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chain/chains')>()
  return {
    ...actual, // isPoolReady / isV2Ready / isV3Ready stay REAL — they judge the cfg below
    chainCfg: (chainId: number) => ({
      ...actual.chainCfg(chainId),
      // A full-coverage chain (weth + both factories + a PoolManager), stated
      // here rather than inherited, so this file does not depend on whatever an
      // operator's deployments.json happens to hold while a rehearsal is seated.
      weth: A.weth,
      usdc: A.usdc,
      factory: A.factory,
      legacy: [],
      uniV2Factory: A.uniV2Factory,
      uniV3Factory: A.uniV3Factory,
      poolManager: A.poolManager,
      aerodromeFactory: null,
      dexscreenerSlug: 'base',
      v4qLineage: false,
      rejectsV2Legs: state.rejectsV2Legs,
    }),
  }
})

vi.mock('../chain/rpc', () => ({
  hasPrivateRpc: () => true, // the V4 log scan runs (and finds nothing) rather than degrading to "partial"
  publicWideLogsRisky: () => false,
  clientFor: () => ({
    getCode: async () => '0x60',
    getBlockNumber: async () => 100n,
    getLogs: async () => [], // no V4 pools for either token
    readContract: async (a: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const at = a.address.toLowerCase()
      const arg0 = String(a.args?.[0] ?? '').toLowerCase()
      // ── identity screen ──
      if (a.functionName === 'decimals') return 18
      if (a.functionName === 'getInterfaceImplementer') return zeroAddress // not ERC-777
      if (a.functionName === 'tokens') return zeroAddress // not a Spectrum basket
      // ── V2 discovery ──
      if (a.functionName === 'getPair') {
        if (arg0 === A.bothVenues.toLowerCase()) return A.v2PairBoth
        if (arg0 === A.v2Only.toLowerCase()) return A.v2PairOnly
        return zeroAddress
      }
      if (a.functionName === 'getReserves') {
        if (state.v2ReservesUnreadable) throw new Error('429 rate limited')
        return [1_000n * 10n ** 18n, 42n * 10n ** 18n, 0] // 1000 ETH a side
      }
      if (a.functionName === 'token0') return A.weth
      // ── V3 discovery: one 0.3% pool, and only for the two-venue token ──
      if (a.functionName === 'getPool') {
        return arg0 === A.bothVenues.toLowerCase() && a.args?.[2] === 3000 ? A.v3Pool : zeroAddress
      }
      if (a.functionName === 'balanceOf') {
        // the V3 depth read (WETH held by the pool) — everything else is the
        // fee-on-transfer slot scan, which finds no slot and stays inconclusive
        return at === A.weth.toLowerCase() && String(a.args?.[0]).toLowerCase() === A.v3Pool.toLowerCase()
          ? 50n * 10n ** 18n
          : 0n
      }
      throw new Error(`unexpected read: ${a.functionName}`)
    },
  }),
}))

// DexScreener: the V2 pair is FIVE TIMES the V3 pool's TVL, so with the flag off
// it wins the USD ranking outright — the exact shape that bricked the deploy.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  const body = url.includes('/tokens/v1/')
    ? [{ priceUsd: '3000', liquidity: { usd: 900_000_000 } }] // ETH/USD anchor
    : url.toLowerCase().includes(A.bothVenues.toLowerCase())
      ? [
          { pairAddress: A.v2PairBoth, liquidity: { usd: 5_000_000 } },
          { pairAddress: A.v3Pool, liquidity: { usd: 1_000_000 } },
        ]
      : [{ pairAddress: A.v2PairOnly, liquidity: { usd: 5_000_000 } }]
  return { ok: true, json: async () => body }
}) as typeof fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  state.rejectsV2Legs = false
  state.v2ReservesUnreadable = false
})

describe('flag OFF — production behavior, unchanged', () => {
  it('still crowns the deepest pool even when it is a V2 pair', async () => {
    const { findBestPool } = await import('./find-best-pool')
    const r = await findBestPool(A.bothVenues, CHAIN)
    expect(r.best.venue).toBe(Venue.V2)
    expect(r.route).toEqual({ venue: Venue.V2, ethPool: ZERO_POOL_KEY, v3Fee: 0, v2Pair: A.v2PairBoth })
    // …and says nothing about a rejection that this deployment does not have
    expect(r.warnings.join(' ')).not.toMatch(/reject/i)
  })

  it('still resolves a V2-ONLY token — refusing it here would break production', async () => {
    const { findBestPool } = await import('./find-best-pool')
    const r = await findBestPool(A.v2Only, CHAIN)
    expect(r.best.venue).toBe(Venue.V2)
    expect(r.route.v2Pair).toBe(A.v2PairOnly)
  })

  it('an unreadable V2 pair is still a HARD stop — an unchecked venue may not be ranked around', async () => {
    state.v2ReservesUnreadable = true
    const { findBestPool } = await import('./find-best-pool')
    await expect(findBestPool(A.bothVenues, CHAIN)).rejects.toMatchObject({ code: 'VENUE_CHECK_FAILED' })
  })
})

describe('flag ON — the leg routes around V2', () => {
  beforeEach(() => {
    state.rejectsV2Legs = true
  })

  it('gives the deeper V2 pair up and takes the V3 pool instead', async () => {
    const { findBestPool } = await import('./find-best-pool')
    const r = await findBestPool(A.bothVenues, CHAIN)
    expect(r.best.venue).toBe(Venue.V3)
    // the route struct the factory reads, in full: V3 fee carried, V2 pair zeroed
    expect(r.route.venue).toBe(Venue.V3)
    expect(r.route.v3Fee).toBe(3000)
    expect(r.route.v2Pair).toBe(zeroAddress)
    // the excluded venue never even reaches the candidate list the UI shows
    expect(r.candidates.some((c) => c.venue === Venue.V2)).toBe(false)
  })

  it('SAYS the V2 pair was excluded, so a shallower depth is explained rather than mysterious', async () => {
    const { findBestPool } = await import('./find-best-pool')
    const r = await findBestPool(A.bothVenues, CHAIN)
    const w = r.warnings.find((x) => /Uniswap V2 pair exists/.test(x))
    expect(w).toBeTruthy()
    expect(w).toMatch(/reject Uniswap V2 legs/) // the shared clause, verbatim
    expect(w).toMatch(/Uniswap V3/) // names where it went instead
  })

  it('does not stall the add when only the V2 read failed — V2 cannot win here anyway', async () => {
    state.v2ReservesUnreadable = true
    const { findBestPool } = await import('./find-best-pool')
    const r = await findBestPool(A.bothVenues, CHAIN)
    expect(r.best.venue).toBe(Venue.V3)
  })
})

describe('flag ON — a V2-only token is REFUSED by name', () => {
  beforeEach(() => {
    state.rejectsV2Legs = true
  })

  it('throws V2_ONLY rather than inventing a route or reporting "no pool"', async () => {
    const { findBestPool } = await import('./find-best-pool')
    await expect(findBestPool(A.v2Only, CHAIN)).rejects.toBeInstanceOf(PoolDetectionError)
    await expect(findBestPool(A.v2Only, CHAIN)).rejects.toMatchObject({ code: 'V2_ONLY' })
  })

  it('pins the sentence — this is the one line every add surface shows in place of the leg', async () => {
    const { findBestPool } = await import('./find-best-pool')
    const { V2_REJECTED_MESSAGE } = await import('./v2-legs')
    expect(V2_REJECTED_MESSAGE).toBe(
      "This token only trades through a Uniswap V2 pool, and this deployment's contracts reject Uniswap V2 legs — pick this asset on a network where it has a V3 or V4 market, or choose another asset.",
    )
    await expect(findBestPool(A.v2Only, CHAIN)).rejects.toThrow(V2_REJECTED_MESSAGE)
  })

  it('is a VERDICT, not a retry — the batch resolvers must drop the leg, not abort the sweep', async () => {
    const { findBestPool } = await import('./find-best-pool')
    const { isRetryableDetection } = await import('./types')
    const e = await findBestPool(A.v2Only, CHAIN).catch((x) => x)
    expect(isRetryableDetection(e)).toBe(false)
  })

  it('will not decide between "V2-only" and "no pool" on an unread V2 pair', async () => {
    // Nothing else answered AND the one venue that might have is unknown — the
    // narrowing above stops exactly here: two verdicts, no evidence, so retry.
    state.v2ReservesUnreadable = true
    const { findBestPool } = await import('./find-best-pool')
    await expect(findBestPool(A.v2Only, CHAIN)).rejects.toMatchObject({ code: 'VENUE_CHECK_FAILED' })
  })
})

describe('the flag itself — how deployments.json is read', () => {
  it('defaults FALSE when the chain entry never mentions it', async () => {
    const { deploymentFor } = await import('../chain/deployments')
    // An id with no entry at all: the absent case, which is what every shipped
    // chain looks like and what production must keep looking like.
    expect(deploymentFor(999_999).rejectsV2Legs).toBe(false)
  })

  it('only the boolean true arms it — a stringy or misspelled value must not remove a venue', async () => {
    vi.resetModules()
    vi.doMock('../chain/deployments.json', () => ({
      default: {
        '8453': { rejectsV2Legs: true },
        '1': { rejectsV2Legs: 'true' },
        '4663': { rejectsV2legs: true }, // misspelled — silently ignored, never guessed
      },
    }))
    const { deploymentFor } = await import('../chain/deployments')
    expect(deploymentFor(8453).rejectsV2Legs).toBe(true)
    expect(deploymentFor(1).rejectsV2Legs).toBe(false)
    expect(deploymentFor(4663).rejectsV2Legs).toBe(false)
    vi.doUnmock('../chain/deployments.json')
    vi.resetModules()
  })
})
