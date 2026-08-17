import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { ALLOWANCE_HOLDER, QUOTE_PLAUSIBILITY_BRACKET_BPS, QUOTE_PLAUSIBILITY_LOW_BRACKET_BPS, ZeroExQuoteRefusal, createProxyZeroExFetcher, validateLegQuote, type ZeroExQuoteResponse } from './zeroex-quote'

// THE QUOTE VALIDATOR — the aggregator is an untrusted counterparty; every
// test is named for the lie it refuses.

const AAVE = '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const EVIL = '0x2222222222222222222222222222222222222222' as Address

const expected = (over: Partial<Parameters<typeof validateLegQuote>[1]> = {}) => ({
  symbol: 'AAVE',
  chainId: 8453,
  sellToken: USDC,
  buyToken: AAVE,
  sellAmountRaw: 1_000_000n,
  spotOutRaw: 500_000n,
  ...over,
})

const honest = (over: Partial<ZeroExQuoteResponse> = {}): ZeroExQuoteResponse => ({
  liquidityAvailable: true,
  sellToken: USDC,
  buyToken: AAVE,
  sellAmount: '1000000',
  buyAmount: '497500',
  allowanceTarget: ALLOWANCE_HOLDER,
  transaction: { to: ALLOWANCE_HOLDER, value: '0', data: '0x2213bc0b' + 'ab'.repeat(64) },
  issues: { allowance: { spender: ALLOWANCE_HOLDER } },
  ...over,
})

describe('validateLegQuote — an untrusted counterparty, checked field by field', () => {
  it('an honest quote passes and carries exactly the floor basis', () => {
    const q = validateLegQuote(honest(), expected())
    expect(q.buyAmountRaw).toBe(497_500n)
    expect(q.sellAmountRaw).toBe(1_000_000n)
    expect(q.swapData.startsWith('0x2213bc0b')).toBe(true)
  })

  it('no route says so by name (their live-confirmed shape: HTTP 200, liquidityAvailable:false)', () => {
    expect(() => validateLegQuote({ liquidityAvailable: false }, expected())).toThrow(/no route/i)
  })

  it('a call target that is not the pinned AllowanceHolder is refused — every variant', () => {
    expect(() => validateLegQuote(honest({ transaction: { to: EVIL, value: '0', data: '0xdeadbeef00' } }), expected())).toThrow(
      /pinned AllowanceHolder/i,
    )
    expect(() => validateLegQuote(honest({ allowanceTarget: EVIL }), expected())).toThrow(/pinned AllowanceHolder/i)
    expect(() => validateLegQuote(honest({ issues: { allowance: { spender: EVIL } } }), expected())).toThrow(/pinned AllowanceHolder/i)
  })

  it('a value-carrying quote is refused — funding is ERC-20 only', () => {
    expect(() => validateLegQuote(honest({ transaction: { to: ALLOWANCE_HOLDER, value: '5', data: '0xdeadbeef00' } }), expected())).toThrow(
      /native value/i,
    )
  })

  it('missing or garbage calldata is refused', () => {
    for (const data of [undefined, '', '0x', '0xzz', '0x12']) {
      expect(() =>
        validateLegQuote(honest({ transaction: { to: ALLOWANCE_HOLDER, value: '0', data } }), expected()),
      ).toThrow(ZeroExQuoteRefusal)
    }
  })

  it('an echo answering a different pair or amount is refused — a response never describes itself', () => {
    expect(() => validateLegQuote(honest({ buyToken: EVIL }), expected())).toThrow(/different token pair/i)
    expect(() => validateLegQuote(honest({ sellToken: EVIL }), expected())).toThrow(/different token pair/i)
    expect(() => validateLegQuote(honest({ sellAmount: '999999' }), expected())).toThrow(/different amount/i)
    expect(() => validateLegQuote(honest({ sellAmount: '1e6' }), expected())).toThrow(/different amount/i)
  })

  it('an unusable buyAmount refuses: zero, missing, negative-shaped, non-numeric', () => {
    for (const buyAmount of ['0', undefined, '-5', '1.5', 'ffff']) {
      expect(() => validateLegQuote(honest({ buyAmount }), expected())).toThrow(ZeroExQuoteRefusal)
    }
  })

  it('THE BRACKET: a buyAmount beyond the band of our own read is a wrong quote, both directions', () => {
    const spot = 500_000n
    const lo = (spot * BigInt(10_000 - QUOTE_PLAUSIBILITY_LOW_BRACKET_BPS)) / 10_000n
    const hi = (spot * BigInt(10_000 + QUOTE_PLAUSIBILITY_BRACKET_BPS)) / 10_000n
    // inside the fence passes
    expect(() => validateLegQuote(honest({ buyAmount: lo.toString() }), expected())).not.toThrow()
    expect(() => validateLegQuote(honest({ buyAmount: hi.toString() }), expected())).not.toThrow()
    // one unit past either edge refuses — a deflated quote would LOOSEN the
    // floor derived from it (the dangerous direction), an inflated one
    // composes floors the chain reverts
    expect(() => validateLegQuote(honest({ buyAmount: (lo - 1n).toString() }), expected())).toThrow(/wrong quote/i)
    expect(() => validateLegQuote(honest({ buyAmount: (hi + 1n).toString() }), expected())).toThrow(/wrong quote/i)
    // and the classic decimals slip is nowhere near the fence
    expect(() => validateLegQuote(honest({ buyAmount: (spot * 10n ** 12n).toString() }), expected())).toThrow(/wrong quote/i)
  })

  it('no independent spot read = no validation basis = refusal, never a guess', () => {
    expect(() => validateLegQuote(honest(), expected({ spotOutRaw: null }))).toThrow(/no independent price/i)
    expect(() => validateLegQuote(honest(), expected({ spotOutRaw: 0n }))).toThrow(/no independent price/i)
  })

  it('a hostile symbol stays bounded and inert through every refusal sentence', () => {
    const sym = '$'.repeat(300) + '<script>'
    try {
      validateLegQuote({ liquidityAvailable: false }, expected({ symbol: sym }))
      expect.unreachable('must throw')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg.length).toBeLessThan(220)
      expect(msg).not.toContain('<script>')
    }
  })
})

describe('THE BRACKET AND THE FLOOR COMPOSE (critical, review 2026-08-07)', () => {
  // The reviewer's measured scenario, verbatim: spot 500,000, 0x returns
  // exactly the old lower edge 400,000. The validator accepted it (equality
  // passed), that number became the floor's basis, and the leg shipped
  // reporting 30 bps of tolerance while permitting 2,024 bps of real
  // shortfall — 67x the number shown to a human.
  const AH = ALLOWANCE_HOLDER
  const quote = (buyAmount: string): ZeroExQuoteResponse => ({
    liquidityAvailable: true,
    sellToken: USDC,
    buyToken: AAVE,
    sellAmount: '1000000',
    buyAmount,
    allowanceTarget: AH,
    transaction: { to: AH, value: '0', data: '0x2213bc0b' + 'ab'.repeat(32) },
  })
  const want = (spotOutRaw: bigint) => ({
    symbol: 'AAVE', chainId: 8453, sellToken: USDC, buyToken: AAVE, sellAmountRaw: 1_000_000n, spotOutRaw,
  })

  it('the exact quote that used to pass is now REFUSED', () => {
    expect(() => validateLegQuote(quote('400000'), want(500_000n))).toThrow(/wrong quote/i)
  })

  it('the accepted band is now narrow enough to BOUND the floor it feeds', () => {
    // whatever the validator accepts becomes the floor basis, so the worst
    // accepted shortfall vs the reference IS the protection's real bound
    const spot = 1_000_000n
    let worstAcceptedBps = 0
    for (let bps = 0; bps <= 3_000; bps += 10) {
      const amount = (spot * BigInt(10_000 - bps)) / 10_000n
      try {
        validateLegQuote(quote(amount.toString()), want(spot))
        worstAcceptedBps = bps
      } catch {
        break
      }
    }
    // the bound is the documented LOW bracket (widened 2026-08-17 on the live
    // $LNOC evidence — thin books under-fill the curve model); the pre-2026-08
    // unbounded width stays emphatically gone
    expect(worstAcceptedBps).toBeLessThanOrEqual(QUOTE_PLAUSIBILITY_LOW_BRACKET_BPS)
    expect(worstAcceptedBps).toBeLessThan(2_000)
  })

  it('an honest quote at the depth-aware reference still passes — the bracket did not just get strict', () => {
    // a thin asset's honest quote sits below FRICTIONLESS spot, which is why
    // the caller hands us the depth-aware number instead
    const spot = 1_000_000n
    // 950 bps of real impact: past even the widened LOW bracket vs raw spot
    // (800, the 2026-08-17 $LNOC ruling), honest against its own reference
    const honestThin = (spot * 9_050n) / 10_000n
    expect(() => validateLegQuote(quote(honestThin.toString()), want(spot))).toThrow() // vs raw spot: refused
    expect(() => validateLegQuote(quote(honestThin.toString()), want(honestThin))).not.toThrow() // vs the honest reference: fine
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SLIPPAGE PARAMETER — added after three live RequiredLegFailed reverts on
// $LNOC (the owner, 2026-08-15). Unset, 0x embeds its OWN 100-bps default; the
// probe that found this confirmed it both ways against the real proxy. These
// pin that the value actually leaves the browser, and that a malformed one
// never takes the quote down with it.
// ─────────────────────────────────────────────────────────────────────────────
describe('createProxyZeroExFetcher — the tolerance has to reach the upstream to exist', () => {
  const seen: string[] = []
  const fakeFetch = (async (url: string) => {
    seen.push(String(url))
    return { status: 200, json: async () => ({ liquidityAvailable: true, buyAmount: '1' }) }
  }) as unknown as typeof fetch
  const args = {
    chainId: 4663,
    sellToken: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
    buyToken: '0x076277C3d6b57b4aAd34C592cD2f138E9316a991' as Address,
    sellAmountRaw: 3_154_410_000n,
    taker: '0x59a2756410887b7c1928Bf7C37B2bc9b1CeF95aA' as Address,
  }

  it('a usable slippageBps rides the query string', async () => {
    seen.length = 0
    await createProxyZeroExFetcher(fakeFetch)({ ...args, slippageBps: 1_200 })
    expect(seen[0]).toContain('slippageBps=1200')
  })

  it('ABSENT stays absent — the burn route and every legacy caller keep 0x’s default', async () => {
    seen.length = 0
    await createProxyZeroExFetcher(fakeFetch)(args)
    expect(seen[0]).not.toContain('slippageBps')
  })

  it('a MALFORMED slippage is dropped, not forwarded — the proxy refuses the whole request on one', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 10_000, 99_999]) {
      seen.length = 0
      await createProxyZeroExFetcher(fakeFetch)({ ...args, slippageBps: bad })
      expect(seen[0]).not.toContain('slippageBps')
    }
  })

  it('a fractional bps is rounded to an integer — the proxy’s own pattern is digits only', async () => {
    seen.length = 0
    await createProxyZeroExFetcher(fakeFetch)({ ...args, slippageBps: 299.6 })
    expect(seen[0]).toContain('slippageBps=300')
  })

  it('ZERO is a real tolerance and is forwarded, not treated as absent', async () => {
    seen.length = 0
    await createProxyZeroExFetcher(fakeFetch)({ ...args, slippageBps: 0 })
    expect(seen[0]).toContain('slippageBps=0')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE ASYMMETRIC BRACKET — the owner's $1,598 $LNOC leg refused with "0x quotes
// 887133… but our own read expects about 792012…", a 1,201 bps gap on a quote
// that was correct. Our depth model prices a constant-product curve while the
// pool is concentrated-liquidity, so it under-predicts the fill; past a few
// hundred bps of impact that pessimism starts refusing honest quotes. These pin
// that the two sides guard different things.
// ─────────────────────────────────────────────────────────────────────────────
describe('the plausibility bracket is asymmetric on purpose', () => {
  const base = (over: { spotOutRaw: bigint | null; frictionlessOutRaw?: bigint | null }) => ({
    symbol: 'LNOC',
    chainId: 4663,
    sellToken: '0x1111111111111111111111111111111111111111' as Address,
    buyToken: '0x2222222222222222222222222222222222222222' as Address,
    sellAmountRaw: 1_598_590_000n,
    ...over,
  })
  const q = (buyAmount: bigint): ZeroExQuoteResponse => ({
    liquidityAvailable: true,
    sellToken: '0x1111111111111111111111111111111111111111',
    buyToken: '0x2222222222222222222222222222222222222222',
    sellAmount: '1598590000',
    buyAmount: buyAmount.toString(),
    allowanceTarget: ALLOWANCE_HOLDER,
    transaction: { to: ALLOWANCE_HOLDER, value: '0', data: '0x2213bc0b' + 'ab'.repeat(64) },
    issues: { allowance: { spender: ALLOWANCE_HOLDER } },
  })
  // his real numbers: depth-aware 792,012…e12, frictionless spot ~887,133…e12
  const DEPTH = 792_012_534_444_444_398_302_585n
  const SPOT = 887_133_171_967_722_163_570_413n

  it('⚠ HIS EXACT REFUSAL now composes — a quote above a pessimistic model is not a wrong quote', () => {
    expect(() => validateLegQuote(q(SPOT), base({ spotOutRaw: DEPTH, frictionlessOutRaw: SPOT }))).not.toThrow()
  })

  it('the LOW side holds at ITS OWN bracket — 800 since the live $LNOC class (2026-08-17), and past it a cheap quote still refuses', () => {
    // the low band carries the curve model's under-fill error on thin books;
    // beyond it, a cheap quote is the direction that costs money — refused
    const tooLow = (DEPTH * BigInt(10_000 - QUOTE_PLAUSIBILITY_LOW_BRACKET_BPS - 1)) / 10_000n
    expect(() => validateLegQuote(q(tooLow), base({ spotOutRaw: DEPTH, frictionlessOutRaw: SPOT }))).toThrow(ZeroExQuoteRefusal)
    const withinLow = (DEPTH * BigInt(10_000 - 492)) / 10_000n // the measured honest gap
    expect(() => validateLegQuote(q(withinLow), base({ spotOutRaw: DEPTH, frictionlessOutRaw: SPOT }))).not.toThrow()
  })

  it('the HIGH side still bites — beating FRICTIONLESS spot by more than the bracket is implausible', () => {
    const absurd = (SPOT * BigInt(10_000 + QUOTE_PLAUSIBILITY_BRACKET_BPS + 1)) / 10_000n
    expect(() => validateLegQuote(q(absurd), base({ spotOutRaw: DEPTH, frictionlessOutRaw: SPOT }))).toThrow(ZeroExQuoteRefusal)
  })

  it('WITHOUT the frictionless figure the old symmetric bracket is kept exactly', () => {
    const justOver = (DEPTH * BigInt(10_000 + QUOTE_PLAUSIBILITY_BRACKET_BPS + 1)) / 10_000n
    expect(() => validateLegQuote(q(justOver), base({ spotOutRaw: DEPTH }))).toThrow(ZeroExQuoteRefusal)
  })

  it('a frictionless figure BELOW the depth-aware one cannot tighten the ceiling (hostile/incoherent input)', () => {
    // nonsense pairing: spot under the depth-adjusted figure. The ceiling must
    // not become stricter than the old behaviour off a bad input.
    const ok = (DEPTH * BigInt(10_000 + QUOTE_PLAUSIBILITY_BRACKET_BPS - 1)) / 10_000n
    expect(() => validateLegQuote(q(ok), base({ spotOutRaw: DEPTH, frictionlessOutRaw: 1n }))).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 0x'S OWN VOLUME FEE — found by SpectrumContracts decoding a live 4663 receipt
// (2026-08-15): 15 bps of the sell, to 0x's own sweeper, taken on every leg and
// on the burn route, never requested and never parsed — so all-in cost was 54.8
// bps against the 40 bps the fee bar shows. Parsing it is step one of showing it.
// ─────────────────────────────────────────────────────────────────────────────
describe('0x’s volume fee is read, so it can be shown', () => {
  const SELL = '0x1111111111111111111111111111111111111111' as Address
  const want = {
    symbol: 'LNOC',
    chainId: 4663,
    sellToken: SELL,
    buyToken: '0x2222222222222222222222222222222222222222' as Address,
    sellAmountRaw: 1_000_000_000n,
    spotOutRaw: 1_000_000n,
  }
  const withFees = (fees: unknown): ZeroExQuoteResponse => ({
    liquidityAvailable: true,
    sellToken: SELL,
    buyToken: '0x2222222222222222222222222222222222222222',
    sellAmount: '1000000000',
    buyAmount: '1000000',
    allowanceTarget: ALLOWANCE_HOLDER,
    transaction: { to: ALLOWANCE_HOLDER, value: '0', data: '0x2213bc0b' + 'ab'.repeat(64) },
    issues: { allowance: { spender: ALLOWANCE_HOLDER } },
    fees: fees as never,
  })

  it('reads the real shape 0x returns — 15 bps of the sell, in the sell token', () => {
    const q = validateLegQuote(withFees({ zeroExFee: { amount: '1500000', token: SELL.toLowerCase(), type: 'volume' } }), want)
    expect(q.zeroExFeeRaw).toBe(1_500_000n)
  })

  it('⚠ an ABSENT fee block is null, never 0 — "no fee" and "we could not see it" are different facts', () => {
    expect(validateLegQuote(withFees(undefined), want).zeroExFeeRaw).toBeNull()
    expect(validateLegQuote(withFees(null), want).zeroExFeeRaw).toBeNull()
    expect(validateLegQuote(withFees({ zeroExFee: null }), want).zeroExFeeRaw).toBeNull()
  })

  it('a fee denominated in some OTHER token is not counted — we cannot price it without a rate', () => {
    const q = validateLegQuote(withFees({ zeroExFee: { amount: '1500000', token: '0x9999999999999999999999999999999999999999' } }), want)
    expect(q.zeroExFeeRaw).toBeNull()
  })

  it('a genuinely ZERO fee is reported as zero, not as unreadable', () => {
    const q = validateLegQuote(withFees({ zeroExFee: { amount: '0', token: SELL.toLowerCase() } }), want)
    expect(q.zeroExFeeRaw).toBe(0n)
  })

  it('a malformed amount is unreadable rather than a wrong number', () => {
    for (const bad of ['abc', '-5', '1.5', ''])
      expect(validateLegQuote(withFees({ zeroExFee: { amount: bad, token: SELL.toLowerCase() } }), want).zeroExFeeRaw).toBeNull()
  })
})


describe('the LOW bracket carries the thin-book class (the owner’s live $LNOC refusals, 2026-08-17)', () => {
  const LNOC_SPOT = 2_012_988_098_717_771_732_807_159n
  const lnocWant = { symbol: 'LNOC', chainId: 4663, sellToken: USDC, buyToken: AAVE, sellAmountRaw: 1_775_000_000n, spotOutRaw: LNOC_SPOT }
  const lnocQuote = (buyAmount: string): ZeroExQuoteResponse => ({
    liquidityAvailable: true,
    buyAmount,
    sellAmount: '1775000000',
    sellToken: USDC,
    buyToken: AAVE,
    allowanceTarget: ALLOWANCE_HOLDER,
    transaction: { to: ALLOWANCE_HOLDER, value: '0', data: '0xabcdef12' },
    status: 200,
  })
  it('the two live sizes pass: an honest 492bps-under quote on a thin book is a fill, not a lie', () => {
    // 2026-08-17 20:15 verbatim: quoted 1913894995861847636988399 against our 2012988098717771732807159
    const q = validateLegQuote(lnocQuote('1913894995861847636988399'), lnocWant)
    expect(q.buyAmountRaw).toBe(1_913_894_995_861_847_636_988_399n)
  })
  it('and the bracket still bites: 920bps under is a wrong quote, refused', () => {
    const under920 = (LNOC_SPOT * 9_080n) / 10_000n
    expect(() => validateLegQuote(lnocQuote(under920.toString()), lnocWant)).toThrow(/wrong quote/i)
  })
})
