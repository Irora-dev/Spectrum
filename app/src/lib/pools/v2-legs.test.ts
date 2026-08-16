import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import { PoolDetectionError, Venue, ZERO_POOL_KEY } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// THE HARDENING, TESTED ADVERSARIALLY — not "does the happy path work" but
// "can a V2 leg get to a signature by any door left open".
//
// The door that was actually open is the boring one: a DRAFT SAVED BEFORE THE
// RULE. Detection can only judge a leg it is asked about, and a restore asks
// nothing — it trusts the route it stored. That is how the owner's MKR arrived
// as a V2 leg on a chain whose contracts reject venue 2, with a deep V3 pool
// sitting right there unused. So every test below INJECTS a stored venue-2
// route the way a stale draft would, and asserts the leg cannot travel:
//   · not into a basket array (toBasketEntries — the last line before money,
//     which runs before a salt is mined and long before a wallet is asked)
//   · not past the shared check any surface can call
// …and the mirror of every one of them: with the flag off, byte-identical.
// PRODUCTION MUST NOT CHANGE — the canonical factory still accepts V2.
// ─────────────────────────────────────────────────────────────────────────────

const REJECTING = 4663
const ACCEPTING = 8453
const MKR = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2' as Address
const LINK = '0x514910771AF9Ca656af840dff83E8264EcF986CA' as Address
const V2PAIR = '0xC2aDdA861F89bBB333c90c492cB837741916A225' as Address

/** Which chains say they reject — flipped per test. */
const rejects = vi.hoisted(() => new Set<number>())

vi.mock('../chain/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chain/chains')>()
  return {
    ...actual,
    // Two chains, so "rejecting" and "accepting" are both reachable in one file
    // and the build-wide backstop has something to be wrong about.
    SUPPORTED_CHAIN_IDS: [ACCEPTING, REJECTING],
    chainCfg: (chainId: number) => ({ ...actual.chainCfg(ACCEPTING), chainId, rejectsV2Legs: rejects.has(chainId) }),
  }
})

/** A leg exactly as a stale draft stores one: symbol, decimals, stored route. */
const v2Leg = (address: Address, symbol: string) => ({
  address,
  symbol,
  decimals: 18,
  route: { venue: Venue.V2, ethPool: ZERO_POOL_KEY, v3Fee: 0, v2Pair: V2PAIR },
})
const v3Leg = (address: Address, symbol: string) => ({
  address,
  symbol,
  decimals: 18,
  route: { venue: Venue.V3, ethPool: ZERO_POOL_KEY, v3Fee: 3000, v2Pair: zeroAddress as Address },
})

beforeEach(() => {
  rejects.clear()
})

describe('the shared check — one answer to "which chains refuse V2"', () => {
  it('reads the per-chain flag, and answers false for a chain it does not know', async () => {
    rejects.add(REJECTING)
    const { chainRejectsV2 } = await import('./v2-legs')
    expect(chainRejectsV2(REJECTING)).toBe(true)
    expect(chainRejectsV2(ACCEPTING)).toBe(false)
    // an unconfigured chain deploys nothing; guessing `true` would refuse legs
    // on a chain we know nothing about
    expect(chainRejectsV2(999_999)).toBe(false)
  })

  it('names only the offending legs, never the whole basket', async () => {
    rejects.add(REJECTING)
    const { rejectedV2Legs } = await import('./v2-legs')
    const legs = [v3Leg(LINK, 'LINK'), v2Leg(MKR, 'MKR')]
    expect(rejectedV2Legs(legs, REJECTING).map((l) => l.symbol)).toEqual(['MKR'])
    expect(rejectedV2Legs(legs, ACCEPTING)).toEqual([]) // production, untouched
  })

  it('the build-wide backstop only fires when EVERY offered chain refuses', async () => {
    const { everyChainRejectsV2 } = await import('./v2-legs')
    expect(everyChainRejectsV2()).toBe(false) // canonical book: nobody refuses
    rejects.add(REJECTING)
    expect(everyChainRejectsV2()).toBe(false) // a MIXED book must stay permissive
    rejects.add(ACCEPTING)
    expect(everyChainRejectsV2()).toBe(true) // rehearsal seating: all three armed
  })
})

describe('the last line before money — a stale V2 leg cannot become a basket array', () => {
  it('REFUSES a basket carrying an injected V2 route, before any salt is mined', async () => {
    rejects.add(REJECTING)
    const { toBasketEntries } = await import('../spectrum/deploy')
    expect(() => toBasketEntries([v3Leg(LINK, 'LINK'), v2Leg(MKR, 'MKR')], [50, 50], REJECTING)).toThrow(
      PoolDetectionError,
    )
  })

  it('names the leg and what to do, in the shared sentence — no softer variant', async () => {
    rejects.add(REJECTING)
    const { toBasketEntries } = await import('../spectrum/deploy')
    const { v2LegBlockedMessage, V2_REJECTION_CLAUSE } = await import('./v2-legs')
    let msg = ''
    try {
      toBasketEntries([v3Leg(LINK, 'LINK'), v2Leg(MKR, 'MKR')], [50, 50], REJECTING)
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toBe(v2LegBlockedMessage(['MKR']))
    expect(msg).toContain('MKR') // the leg, named
    expect(msg).toContain(V2_REJECTION_CLAUSE) // the one clause, verbatim
    expect(msg).toMatch(/V3 or V4/) // the fix, stated
  })

  it('is a VERDICT, not a retry — a re-attempt cannot help a refused route', async () => {
    rejects.add(REJECTING)
    const { toBasketEntries } = await import('../spectrum/deploy')
    const { isRetryableDetection } = await import('./types')
    try {
      toBasketEntries([v2Leg(MKR, 'MKR'), v3Leg(LINK, 'LINK')], [50, 50], REJECTING)
      expect.unreachable('should have refused')
    } catch (e) {
      expect((e as PoolDetectionError).code).toBe('V2_LEG_REJECTED')
      expect(isRetryableDetection(e)).toBe(false)
    }
  })

  it('refuses even when the caller never says which chain — IF no chain accepts V2', async () => {
    // The one production call site takes only assets + weights (another lane's
    // file). A leg that slipped through every UI must still not assemble.
    rejects.add(REJECTING)
    rejects.add(ACCEPTING)
    const { toBasketEntries } = await import('../spectrum/deploy')
    expect(() => toBasketEntries([v2Leg(MKR, 'MKR'), v3Leg(LINK, 'LINK')], [50, 50])).toThrow(/Uniswap V2 route/)
  })

  it('…and lets it through on the canonical book, chain unnamed — PRODUCTION IS NOT CHANGED', async () => {
    const { toBasketEntries } = await import('../spectrum/deploy')
    const entries = toBasketEntries([v2Leg(MKR, 'MKR'), v3Leg(LINK, 'LINK')], [50, 50])
    expect(entries.map((e) => e.venue)).toEqual([Venue.V2, Venue.V3])
    expect(entries[0].v2Pair).toBe(V2PAIR) // the route survives verbatim
    expect(entries.map((e) => e.weight)).toEqual([5000, 5000])
  })

  it('flag OFF, chain named: byte-identical to today', async () => {
    rejects.add(REJECTING)
    const { toBasketEntries } = await import('../spectrum/deploy')
    const legs = [v2Leg(MKR, 'MKR'), v3Leg(LINK, 'LINK')]
    expect(toBasketEntries(legs, [50, 50], ACCEPTING)).toEqual(toBasketEntries(legs, [50, 50]))
  })

  it('a basket with no V2 leg assembles unchanged on a rejecting chain', async () => {
    rejects.add(REJECTING)
    const { toBasketEntries } = await import('../spectrum/deploy')
    const entries = toBasketEntries([v3Leg(LINK, 'LINK'), v3Leg(MKR, 'MKR')], [60, 40], REJECTING)
    expect(entries.map((e) => e.venue)).toEqual([Venue.V3, Venue.V3])
    expect(entries.map((e) => e.weight)).toEqual([6000, 4000])
  })
})

describe('the two sentences say two DIFFERENT true things', () => {
  it('the add-time one claims the token has nowhere else to go', async () => {
    const { V2_REJECTED_MESSAGE } = await import('./v2-legs')
    expect(V2_REJECTED_MESSAGE).toMatch(/only trades through a Uniswap V2 pool/)
  })

  it('the stale-leg one claims only that the LEG carries a V2 route', async () => {
    // MKR has a deep mainnet V3 pool. Telling that user "MKR only trades
    // through V2" would be false — and it is precisely the user who hit this.
    const { v2LegBlockedMessage } = await import('./v2-legs')
    const m = v2LegBlockedMessage(['MKR'])
    expect(m).toMatch(/carries a Uniswap V2 route/)
    expect(m).not.toMatch(/only trades/)
    expect(m).toMatch(/add it again/) // re-adding re-routes it, which is the truth
  })

  it('pluralises honestly rather than saying "1 legs"', async () => {
    const { v2LegBlockedMessage } = await import('./v2-legs')
    expect(v2LegBlockedMessage(['MKR', 'AKITA'])).toMatch(/MKR, AKITA carry a Uniswap V2 route/)
    expect(v2LegBlockedMessage(['MKR', 'AKITA'])).toMatch(/remove those legs/)
  })

  it('both carry the SAME clause — the part no surface may reword', async () => {
    const { V2_REJECTED_MESSAGE, V2_REJECTION_CLAUSE, v2LegBlockedMessage } = await import('./v2-legs')
    expect(V2_REJECTED_MESSAGE).toContain(V2_REJECTION_CLAUSE)
    expect(v2LegBlockedMessage(['X'])).toContain(V2_REJECTION_CLAUSE)
  })
})
