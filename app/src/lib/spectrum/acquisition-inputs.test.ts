import { describe, expect, it } from 'vitest'
import { acquisitionRoute } from './acquisition-route'
import {
  ZEROEX_UNPROBED,
  acquisitionInputsFor,
  nativeSellPath,
  poolVerdictFrom,
  quoteAssetsFor,
} from './acquisition-inputs'
import type { PoolCandidate, PoolVerdict } from './pool-safety'

// THE PRODUCERS for acquisitionRoute's inputs. The load-bearing property is
// negative and it is the one SpectrumContracts caught: nothing in this module
// may ever turn "we could not look" into "there is no exit", because that
// fires the un-overridable refusal tier and would blanket-refuse an entire
// asset class.

const TOKEN = '0x1111111111111111111111111111111111111111'
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const JUNK = '0x9999999999999999999999999999999999999999'

const cand = (over: Partial<PoolCandidate> = {}): PoolCandidate => ({
  id: '0xpool',
  venue: 'v3',
  token0: TOKEN,
  token1: WETH,
  feeBps: 500,
  tickSpacing: 10,
  liquidityUsd: 5_000_000,
  onChainConfirmed: true,
  indexerConfirmed: true,
  ...over,
})

describe('quoteAssetsFor — the identity anchor narrows on a missing entry, never widens', () => {
  it('carries both when the book has both', () => {
    expect(quoteAssetsFor({ weth: WETH, usdc: USDC })).toEqual([WETH, USDC])
  })
  it('drops what the book does not know — an absent address is not a wildcard', () => {
    expect(quoteAssetsFor({ weth: WETH, usdc: null })).toEqual([WETH])
    expect(quoteAssetsFor({ weth: null, usdc: null })).toEqual([])
  })
})

describe('poolVerdictFrom — a read that did not happen is not a verdict', () => {
  it('null candidates answer null (uncertainty), never a refusal or an ok', () => {
    expect(poolVerdictFrom(null, TOKEN, [WETH])).toBeNull()
  })
  it('a sound, deep, corroborated pool against a canonical quote asset clears', () => {
    const v = poolVerdictFrom([cand()], TOKEN, [WETH, USDC])
    expect(v?.kind).toBe('ok')
  })
  it('a pool paired against something we do not recognise REFUSES — the impostor shape', () => {
    const v = poolVerdictFrom([cand({ token1: JUNK })], TOKEN, [WETH, USDC])
    expect(v?.kind).toBe('refuse')
  })
  it('a pool that does not contain the user’s token at all refuses', () => {
    const v = poolVerdictFrom([cand({ token0: JUNK, token1: WETH })], TOKEN, [WETH])
    expect(v?.kind).toBe('refuse')
  })
})

describe('nativeSellPath — THE LAW: "we could not look" is never "there is no exit"', () => {
  it('an absent verdict is UNCONFIRMED (warns), not none (refuses)', () => {
    expect(nativeSellPath(null)).toBe('unconfirmed')
  })
  it('an undecided screen is UNCONFIRMED — a route exists, which one is unclear', () => {
    const ask: PoolVerdict = { kind: 'ask', reason: 'two-pools-too-close', message: 'x', candidates: [] }
    expect(nativeSellPath(ask)).toBe('unconfirmed')
  })
  it('a MEASURED absence of a usable venue is the only thing that yields none', () => {
    const refuse: PoolVerdict = { kind: 'refuse', reason: 'no-candidates', message: 'x' }
    expect(nativeSellPath(refuse)).toBe('none')
  })
  it('a cleared pool confirms the exit', () => {
    const ok = poolVerdictFrom([cand()], TOKEN, [WETH])
    expect(nativeSellPath(ok)).toBe('confirmed')
  })
})

describe('the unprobed aggregator — fails CLOSED, and never fabricates a policy claim', () => {
  it('ZEROEX_UNPROBED never asserts that 0x declined the asset class', () => {
    // 'policy-refused' produces copy claiming a legal refusal. We did not ask.
    expect(ZEROEX_UNPROBED).not.toBe('policy-refused')
    expect(ZEROEX_UNPROBED).not.toBe('routable') // and never a silent batch leg
  })

  it('an unprobed asset with a sound pool is bought SEPARATELY, not batched', () => {
    const inputs = acquisitionInputsFor({
      symbol: 'NVDA',
      candidates: [cand()],
      tokenAddress: TOKEN,
      quoteAssets: [WETH, USDC],
      zeroEx: ZEROEX_UNPROBED,
    })
    expect(inputs.poolVerdict?.kind).toBe('ok')
    expect(inputs.sellPath).toBe('confirmed')
    const r = acquisitionRoute(inputs)
    expect(r.via).toBe('side-swap') // fail closed: never 'batch' on an assumption
    // and the copy makes no claim about the aggregator, because we never asked
    expect(r.message).not.toMatch(/exchange we route through/)
  })
})

describe('the whole chain, end to end — discovery classified into a route decision', () => {
  it('a cleared blue-chip that 0x DECLINES is bought separately (the owner’s ruling, reachable)', () => {
    const r = acquisitionRoute(
      acquisitionInputsFor({
        symbol: 'NVDA',
        candidates: [cand()],
        tokenAddress: TOKEN,
        quoteAssets: [WETH, USDC],
        zeroEx: 'policy-refused',
      }),
    )
    expect(r.via).toBe('side-swap')
    expect(r.message).toMatch(/cannot be bought through the exchange/)
  })

  it('a token with NO usable venue is refused, and 0x cannot override that', () => {
    for (const zeroEx of ['routable', 'no-route', 'policy-refused'] as const) {
      const r = acquisitionRoute(
        acquisitionInputsFor({
          symbol: 'SCAM',
          candidates: [cand({ token1: JUNK })], // no recognised quote asset
          tokenAddress: TOKEN,
          quoteAssets: [WETH, USDC],
          zeroEx,
        }),
      )
      expect(r.via, `zeroEx=${zeroEx}`).toBe('refused')
    }
  })

  it('discovery that FAILED yields a warning tier, never a refusal and never a batch leg', () => {
    const r = acquisitionRoute(
      acquisitionInputsFor({
        symbol: 'WHO',
        candidates: null, // the RPC did not answer
        tokenAddress: TOKEN,
        quoteAssets: [WETH],
        zeroEx: ZEROEX_UNPROBED,
      }),
    )
    expect(r.via).toBe('side-swap-on-approval')
    expect(r.message).toBeTruthy()
  })
})
