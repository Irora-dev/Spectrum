import { describe, expect, it } from 'vitest'
import {
  DOMINANCE_RATIO,
  MIN_POOL_LIQUIDITY_USD,
  assessPool,
  MAX_PLAUSIBLE_POOL_LIQUIDITY_USD,
  parsePastedPool,
  verifyPastedPool,
  asPoolDepthUsd,
  readPoolDepthUsd,
  MAX_POOL_FEE_BPS,
  MAX_TICK_SPACING,
  type PoolCandidate,
  type PoolSafetyContext,
} from './pool-safety'

const TOKEN = '0x1111111111111111111111111111111111111111'
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const SCAM = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0'

const CTX: PoolSafetyContext = { tokenAddress: TOKEN, allowedQuoteAssets: [WETH, USDC] }

const pool = (over: Partial<PoolCandidate> = {}): PoolCandidate => ({
  id: '0xaaa0000000000000000000000000000000000001',
  venue: 'v3',
  token0: TOKEN,
  token1: WETH,
  feeBps: 3000,
  tickSpacing: 60,
  liquidityUsd: 500_000,
  onChainConfirmed: true,
  indexerConfirmed: true,
  ...over,
})

describe('pool safety: the gate refuses before it guesses', () => {
  it('places into the obvious pool, and says why', () => {
    const v = assessPool([pool()], CTX)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.why.length).toBeGreaterThan(0)
  })

  it('REFUSES a pool quoted in an unrecognised asset — the catastrophic case', () => {
    // deepest by far, on-chain, corroborated, and still refused: depth does not
    // buy your way past identity
    const v = assessPool([pool({ token1: SCAM, liquidityUsd: 50_000_000 })], CTX)
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') expect(v.reason).toBe('no-recognised-quote-asset')
  })

  it('matches the token by ADDRESS, so an impostor pool is not ours', () => {
    const impostor = pool({ token0: '0x9999999999999999999999999999999999999999' })
    const v = assessPool([impostor], CTX)
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') expect(v.reason).toBe('token-not-in-pool')
  })

  it('refuses a V2-only token — a range order cannot live there', () => {
    const v = assessPool([pool({ venue: 'v2' })], CTX)
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') expect(v.reason).toBe('no-concentrated-venue')
  })

  it('refuses a pool the chain cannot confirm, however loudly the index claims it', () => {
    const v = assessPool([pool({ onChainConfirmed: false, indexerConfirmed: true })], CTX)
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') expect(v.reason).toBe('not-on-chain')
  })

  it('refuses a pool under the liquidity floor', () => {
    const v = assessPool([pool({ liquidityUsd: MIN_POOL_LIQUIDITY_USD - 1 })], CTX)
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') expect(v.reason).toBe('below-liquidity-floor')
  })

  it('refuses when the tick grid is unreadable — we cannot place an exact range', () => {
    for (const bad of [undefined, 0, -60, 1.5, Number.NaN]) {
      const v = assessPool([pool({ tickSpacing: bad as number })], CTX)
      expect(v.kind).toBe('refuse')
      if (v.kind === 'refuse') expect(v.reason).toBe('unusable-tick-spacing')
    }
  })

  it('ASKS when two pools are too close to call — doubt goes to the user', () => {
    const a = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 400_000 })
    const b = pool({ id: '0xbbb0000000000000000000000000000000000002', feeBps: 500, liquidityUsd: 300_000 })
    const v = assessPool([a, b], CTX)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') {
      expect(v.reason).toBe('two-pools-too-close')
      expect(v.message).toMatch(/paste/i)
      expect(v.candidates).toHaveLength(2)
    }
  })

  it('places when the winner is dominant by the stated margin', () => {
    const a = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 1_000_000 })
    const b = pool({ id: '0xbbb0000000000000000000000000000000000002', feeBps: 500, liquidityUsd: 1_000_000 / (DOMINANCE_RATIO + 1) })
    const v = assessPool([a, b], CTX)
    expect(v.kind).toBe('ok')
  })

  it('ASKS when depth is unreadable — unreadable is not small', () => {
    const v = assessPool([pool({ liquidityUsd: null })], CTX)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') expect(v.reason).toBe('depth-unreadable')
  })

  it('ASKS when only one source can see the pool', () => {
    const v = assessPool([pool({ indexerConfirmed: false })], CTX)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') expect(v.reason).toBe('sources-disagree')
  })

  it('refuses an empty or unreadable ask outright', () => {
    expect(assessPool([], CTX).kind).toBe('refuse')
    expect(assessPool([pool()], { ...CTX, tokenAddress: 'not-an-address' }).kind).toBe('refuse')
    expect(assessPool([pool()], { ...CTX, allowedQuoteAssets: [] }).kind).toBe('refuse')
  })

  it('never returns ok on a maybe — every non-ok verdict carries a sentence', () => {
    const cases = [
      assessPool([], CTX),
      assessPool([pool({ token1: SCAM })], CTX),
      assessPool([pool({ venue: 'v2' })], CTX),
      assessPool([pool({ liquidityUsd: null })], CTX),
      assessPool([pool({ indexerConfirmed: false })], CTX),
    ]
    for (const v of cases) {
      expect(v.kind).not.toBe('ok')
      const msg = v.kind === 'ok' ? '' : v.message
      expect(msg.length).toBeGreaterThan(20)
      expect(msg).not.toMatch(/undefined|NaN|null/)
    }
  })
})

describe('pool safety: a pasted pool is VERIFIED, not trusted', () => {
  it('reads an address out of a pasted URL', () => {
    expect(parsePastedPool(`https://app.uniswap.org/explore/pools/base/${'0xAbC'.padEnd(42, '1')}`)).toBe(
      `${'0xabc'.padEnd(42, '1')}`,
    )
    expect(parsePastedPool('no address here')).toBeNull()
    expect(parsePastedPool('')).toBeNull()
  })

  it('accepts a pasted pool that would have been AMBIGUOUS — that is the point', () => {
    const a = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 400_000 })
    const b = pool({ id: '0xbbb0000000000000000000000000000000000002', feeBps: 500, liquidityUsd: 300_000 })
    expect(assessPool([a, b], CTX).kind).toBe('ask')
    const v = verifyPastedPool(b.id, [a, b], CTX)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.pool.id).toBe(b.id)
  })

  it('STILL REFUSES a pasted pool with a bad quote asset — the paste is not a bypass', () => {
    const bad = pool({ id: '0xccc0000000000000000000000000000000000003', token1: SCAM })
    const v = verifyPastedPool(bad.id, [bad], CTX)
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') expect(v.reason).toBe('no-recognised-quote-asset')
  })

  it('STILL REFUSES a pasted pool that does not hold their token, or is V2, or is thin', () => {
    const wrongToken = pool({ id: '0xddd0000000000000000000000000000000000004', token0: SCAM, token1: WETH })
    expect(verifyPastedPool(wrongToken.id, [wrongToken], CTX).kind).toBe('refuse')
    const v2 = pool({ id: '0xeee0000000000000000000000000000000000005', venue: 'v2' })
    expect(verifyPastedPool(v2.id, [v2], CTX).kind).toBe('refuse')
    const thin = pool({ id: '0xfff0000000000000000000000000000000000006', liquidityUsd: 10 })
    expect(verifyPastedPool(thin.id, [thin], CTX).kind).toBe('refuse')
  })

  it('refuses a pool we never looked up — a stranger’s link is not a candidate', () => {
    const v = verifyPastedPool('0x0000000000000000000000000000000000009999', [pool()], CTX)
    expect(v.kind).toBe('refuse')
    if (v.kind === 'refuse') expect(v.reason).toBe('not-on-chain')
  })
})

describe('depth is an IDENTITY claim, read in BOTH directions (hostile-number sweep, 2026-08-07)', () => {
  // Found by sweeping this module for the first time. The floor stopped an
  // empty pool; nothing stopped an inflated one, and every comparison on a NaN
  // is false — so both ends returned `ok` from a screen whose entire job is to
  // refuse when it cannot identify the right pool.
  it('a NaN depth ASKS — it used to return ok, clearing the gate on an unknown', () => {
    const v = assessPool([pool({ liquidityUsd: Number.NaN })], CTX)
    expect(v.kind).toBe('ask')
    expect(v.kind === 'ask' && v.reason).toBe('depth-unreadable')
  })
  it('an Infinity depth ASKS too — same spelling of unreadable', () => {
    expect(assessPool([pool({ liquidityUsd: Number.POSITIVE_INFINITY })], CTX).kind).toBe('ask')
  })
  // ⚠ THIS TEST PINNED THE BUG (independent review, 2026-08-07). It asserted
  // `ask` for an impossible depth, and `ask` was wrong in two ways at once: the
  // question had NO ANSWER (the user pastes a pool, verifyPastedPool re-enters
  // assessPool, gate 5 fires on the same unchanged number, it asks again), and
  // its sentence claimed we could not read a depth that read back fine at 1e15.
  // A source stating something impossible has not failed to answer — it has
  // discredited itself, and with it the candidate list the ask handed back.
  // The old expectation is preserved in this comment because "the test agreed
  // with the code" is exactly how this survived a review pass.
  it('an IMPOSSIBLE depth REFUSES — it used to ask, which was a question no paste could answer', () => {
    for (const d of [1e21, MAX_PLAUSIBLE_POOL_LIQUIDITY_USD + 1]) {
      const v = assessPool([pool({ liquidityUsd: d })], CTX)
      expect(v.kind, `depth=${d}`).toBe('refuse')
      expect(v.kind === 'refuse' && v.reason).toBe('depth-implausible')
      // and the sentence may not claim an unreadable depth for a read that landed
      if (v.kind === 'refuse') expect(v.message.toLowerCase()).not.toContain('cannot read how deep')
    }
  })

  it('a NEGATIVE depth REFUSES — finite, under the ceiling, and it used to switch dominance OFF', () => {
    // the measured shape: -1 is finite so gate 5 passed it, then gate 8's
    // `runnerUp > 0` was false for it, so the dominance gate never ran and the
    // pool cleared. An HONEST runner-up at $29k asks. The wrong number bought a
    // better verdict than the right one.
    const best = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 30_000 })
    const liar = pool({ id: '0xaaa0000000000000000000000000000000000002', liquidityUsd: -1 })
    const v = assessPool([best, liar], CTX)
    expect(v.kind).toBe('refuse')
    expect(v.kind === 'refuse' && v.reason).toBe('depth-implausible')
    // the honest comparison it was impersonating
    const honest = assessPool([best, pool({ id: '0xaaa0000000000000000000000000000000000002', liquidityUsd: 29_000 })], CTX)
    expect(honest.kind).toBe('ask')
  })

  it('an EMPTY-STRING depth is absent, never a confident zero (Number("") is 0, not NaN)', () => {
    // UIGuy hit this in the launch flow the same day and his own test caught his
    // own first implementation: a blank indexer field coerces to 0, which is a
    // FACT about a pool rather than a missing read. Rejected before any numeric
    // coercion — so it asks rather than refusing a pool that may well be deep.
    const r = readPoolDepthUsd('')
    expect(r.readable).toBe(false)
    expect(r.readable === false && r.fault).toBe('absent')
    expect(assessPool([pool({ liquidityUsd: '' as unknown as number })], CTX).kind).toBe('ask')
  })

  it('the DENOMINATION mint refuses what cannot be a USD depth, and brands what can', () => {
    expect(asPoolDepthUsd(25_000)).toBe(25_000)
    expect(asPoolDepthUsd(0)).toBe(0)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(() => asPoolDepthUsd(bad)).toThrow(RangeError)
  })
  it('and a genuinely deep pool still clears — the ceiling is generous, not a tune', () => {
    expect(assessPool([pool({ liquidityUsd: MAX_PLAUSIBLE_POOL_LIQUIDITY_USD })], CTX).kind).toBe('ok')
    expect(assessPool([pool({ liquidityUsd: 3_000_000_000 })], CTX).kind).toBe('ok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE POOL-SAFETY FINDINGS FROM THE THIRD A6 REVIEW (2026-08-07). Each case
// below is the reviewer's own measured shape, so a regression reproduces the
// finding rather than merely failing.
// ─────────────────────────────────────────────────────────────────────────────
describe('our OWN thresholds are read, not assumed', () => {
  // `??` catches null and undefined and NOTHING else, so a NaN threshold walked
  // into every comparison and made all of them FALSE — which returns ok. The
  // reviewer's note: this is the exact defect the gate-5 comment beside it
  // diagnoses in the DATA while repeating it in the CONFIG. And it was reachable
  // — verifyPastedPool already passes a dominanceRatio, and assessPool is exported.
  it('a NaN floor REFUSES rather than clearing a one-dollar pool', () => {
    const v = assessPool([pool({ liquidityUsd: 1 })], { ...CTX, minLiquidityUsd: Number.NaN })
    expect(v.kind).toBe('refuse')
    expect(v.kind === 'refuse' && v.reason).toBe('unreadable-safety-threshold')
  })

  it('a NaN dominance ratio REFUSES rather than letting two equal pools through', () => {
    const a = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 400_000 })
    const b = pool({ id: '0xaaa0000000000000000000000000000000000002', liquidityUsd: 400_000 })
    expect(assessPool([a, b], { ...CTX, dominanceRatio: Number.NaN }).kind).toBe('refuse')
    // …and with an honest ratio the same pair ASKS, which is the behaviour the
    // NaN was impersonating
    expect(assessPool([a, b], CTX).kind).toBe('ask')
  })

  it('names itself as OUR fault, because it is not a fact about the token', () => {
    const v = assessPool([pool()], { ...CTX, minLiquidityUsd: Number.NaN })
    expect(v.kind === 'refuse' && v.message).toMatch(/on our side/i)
  })

  it('ZERO stays legitimate — verifyPastedPool waives dominance with it on purpose', () => {
    const a = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 400_000 })
    const b = pool({ id: '0xaaa0000000000000000000000000000000000002', liquidityUsd: 400_000 })
    // the two-pool ambiguity is exactly what the paste answers
    expect(verifyPastedPool(a.id, [a, b], CTX).kind).toBe('ok')
    expect(assessPool([a], { ...CTX, dominanceRatio: 0 }).kind).toBe('ok')
  })

  it('an unreadable threshold is caught BEFORE any claim about the pool', () => {
    // ordering matters: a broken setting must not be reported as a property of
    // someone's token, so it outranks even the no-candidates refusal.
    const v = assessPool([], { ...CTX, minLiquidityUsd: Number.NaN })
    expect(v.kind === 'refuse' && v.reason).toBe('unreadable-safety-threshold')
  })
})

describe('a pool key needs BOTH its halves', () => {
  // feeBps was never read by assessPool at all — asymmetric with tickSpacing,
  // which IS validated — so NaN or undefined rode out inside an `ok` verdict to
  // be read by whoever built the V3/V4 key next.
  it('an unreadable fee tier REFUSES (it used to ride out inside ok)', () => {
    for (const bad of [Number.NaN, undefined, -1, MAX_POOL_FEE_BPS + 1, 3000.5]) {
      const v = assessPool([pool({ feeBps: bad as number })], CTX)
      expect(v.kind, `feeBps=${bad}`).toBe('refuse')
      expect(v.kind === 'refuse' && v.reason, `feeBps=${bad}`).toBe('unusable-fee-tier')
    }
  })

  it('the real V3 tiers still clear', () => {
    for (const tier of [100, 500, 3000, 10_000]) expect(assessPool([pool({ feeBps: tier })], CTX).kind).toBe('ok')
  })

  it('tick spacing is bounded ABOVE too — 1e9 used to return ok', () => {
    expect(assessPool([pool({ tickSpacing: 1e9 })], CTX).kind).toBe('refuse')
    expect(assessPool([pool({ tickSpacing: MAX_TICK_SPACING + 1 })], CTX).kind).toBe('refuse')
    expect(assessPool([pool({ tickSpacing: MAX_TICK_SPACING })], CTX).kind).toBe('ok')
  })
})

describe('the governed constants are pinned against LITERALS', () => {
  // ⚠ THE REVIEWER'S POINT, AND IT IS SUBTLE: the boundary tests above reference
  // the exported symbols, so they track ANY value those symbols take. That is
  // right for a boundary and useless as a pin — MAX_PLAUSIBLE_POOL_LIQUIDITY_USD
  // could go from 100e9 to 100e12 (a 1000x loosening, and the substance of half
  // that fix) and the whole suite would stay green. A governed number needs one
  // assertion that a human chose.
  it('the plausible-depth ceiling is one hundred billion dollars', () => {
    expect(MAX_PLAUSIBLE_POOL_LIQUIDITY_USD).toBe(100_000_000_000)
  })

  it('the liquidity floor is twenty-five thousand dollars', () => {
    expect(MIN_POOL_LIQUIDITY_USD).toBe(25_000)
  })

  it('the dominance ratio is 3 — and the comparison is lead < ratio, not lead < ratio/2', () => {
    expect(DOMINANCE_RATIO).toBe(3)
    // the halving the reviewer showed survives the suite: at a 2.9x lead we must
    // ASK (2.9 < 3), and at 3.1x we must not. `ratio / 2` would clear both.
    const best = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 290_000 })
    const near = pool({ id: '0xaaa0000000000000000000000000000000000002', liquidityUsd: 100_000 })
    expect(assessPool([best, near], CTX).kind).toBe('ask')
    const clear = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 310_000 })
    expect(assessPool([clear, near], CTX).kind).toBe('ok')
  })

  it('the fee and tick bounds are the numbers they claim to be', () => {
    expect(MAX_POOL_FEE_BPS).toBe(1_000_000)
    expect(MAX_TICK_SPACING).toBe(16_384)
  })
})

describe('exact boundaries — the mutation sweep found every one of these unpinned (A12, first run)', () => {
  // Five operator mutants survived the whole suite on 2026-08-07. Four were
  // missing boundary pins (each below); the fifth (`runnerUp.usd > 0` → `>=`)
  // is EQUIVALENT by outcome — a zero runner-up divides to Infinity, which
  // fails `lead < ratio` the same way skipping the branch does — so the
  // OUTCOME is pinned here and the operator survives, accepted and stated.
  it('a pool holding EXACTLY the floor composes — "less than" cannot be trusted, at it can', () => {
    expect(assessPool([pool({ liquidityUsd: MIN_POOL_LIQUIDITY_USD })], CTX).kind).toBe('ok')
    expect(assessPool([pool({ liquidityUsd: MIN_POOL_LIQUIDITY_USD - 1 })], CTX).kind).toBe('refuse')
  })

  it('a lead of EXACTLY the dominance ratio is dominant — "must carry this multiple" includes carrying it', () => {
    const best = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 300_000 })
    const near = pool({ id: '0xaaa0000000000000000000000000000000000002', liquidityUsd: 100_000 })
    expect(assessPool([best, near], CTX).kind).toBe('ok')
  })

  it('the fee-tier bound is inclusive at both ends — 0 and MAX are readable settings, one past MAX is not', () => {
    expect(assessPool([pool({ feeBps: 0 })], CTX).kind).toBe('ok')
    expect(assessPool([pool({ feeBps: MAX_POOL_FEE_BPS })], CTX).kind).toBe('ok')
    expect(assessPool([pool({ feeBps: MAX_POOL_FEE_BPS + 1 })], CTX).kind).toBe('refuse')
    expect(assessPool([pool({ feeBps: -1 })], CTX).kind).toBe('refuse')
  })

  it('a ZERO runner-up never asks — dominance over nothing is dominance (the equivalent-mutant outcome, chosen)', () => {
    const best = pool({ id: '0xaaa0000000000000000000000000000000000001', liquidityUsd: 100_000 })
    const ghost = pool({ id: '0xaaa0000000000000000000000000000000000002', liquidityUsd: 0 })
    // a zero depth is refused upstream as implausible? No — zero is DEAD, and
    // gate 5 reads it via readPoolDepthUsd: 0 is finite and non-negative, so
    // it ranks last and the winner must simply not be asked about it
    expect(assessPool([best, ghost], CTX).kind).toBe('ok')
  })
})
