import { describe, expect, it } from 'vitest'
import { pickHopReserve, readHopReserveUsd, type DexPairReserve, type DexPairsFetcher } from './hop-reserve'
import { deriveLegFloors } from './floor-discipline'

// THE SHARED HOP'S RESERVE — the input that decides every leg's self-impact
// term. Each test is named for the wrong answer it refuses to give.

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'
const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'

const pair = (over: Partial<DexPairReserve> & { base: string; quote: string }): DexPairReserve => ({
  baseToken: { address: over.base, symbol: over.base === USDC ? 'USDC' : over.base === WETH ? 'WETH' : 'AERO' },
  quoteToken: { address: over.quote, symbol: over.quote === USDC ? 'USDC' : over.quote === WETH ? 'WETH' : 'AERO' },
  liquidity: over.liquidity,
})

describe('pickHopReserve — the FUNDING side, of the pair the batch actually shares', () => {
  it('reads the funding side whichever side of the pair it sits on', () => {
    // funding as quote
    const asQuote = pickHopReserve([pair({ base: WETH, quote: USDC, liquidity: { usd: 500_000, base: 80, quote: 250_000 } })], USDC, WETH)
    expect(asQuote?.reserveUsd).toBe(250_000)
    // funding as base — the OTHER field, or the number is the wrong token's
    const asBase = pickHopReserve([pair({ base: USDC, quote: WETH, liquidity: { usd: 500_000, base: 250_000, quote: 80 } })], USDC, WETH)
    expect(asBase?.reserveUsd).toBe(250_000)
    expect(asBase?.substituted).toBe(false)
  })

  it('prefers the funding↔WETH hop over a DEEPER pair of another kind — depth is not the criterion, sharing is', () => {
    const read = pickHopReserve(
      [
        pair({ base: USDC, quote: AERO, liquidity: { usd: 9_000_000, base: 4_500_000, quote: 1 } }),
        pair({ base: USDC, quote: WETH, liquidity: { usd: 500_000, base: 250_000, quote: 80 } }),
      ],
      USDC,
      WETH,
    )
    expect(read?.reserveUsd).toBe(250_000)
    expect(read?.pair).toBe('WETH')
    expect(read?.substituted).toBe(false)
  })

  it('picks the DEEPEST funding↔WETH pair when several exist (fee tiers)', () => {
    const read = pickHopReserve(
      [
        pair({ base: USDC, quote: WETH, liquidity: { usd: 100_000, base: 50_000, quote: 16 } }),
        pair({ base: USDC, quote: WETH, liquidity: { usd: 900_000, base: 450_000, quote: 145 } }),
      ],
      USDC,
      WETH,
    )
    expect(read?.reserveUsd).toBe(450_000)
  })

  it('a substituted hop SAYS SO — the self-impact term is then against a hop the batch may not share', () => {
    const read = pickHopReserve([pair({ base: USDC, quote: AERO, liquidity: { usd: 80_000, base: 40_000, quote: 9_000 } })], USDC, WETH)
    expect(read?.substituted).toBe(true)
    expect(read?.reserveUsd).toBe(40_000)
  })

  it('a pair the funding asset is not part of is IGNORED — its reserve is not what our swaps pay into', () => {
    expect(pickHopReserve([pair({ base: WETH, quote: AERO, liquidity: { usd: 5_000_000, base: 800, quote: 900_000 } })], USDC, WETH)).toBeNull()
  })

  it('AN UNREADABLE SIDE AMOUNT IS NOT A SMALL RESERVE — the candidate drops, it never counts as zero depth', () => {
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const read = pickHopReserve(
        [pair({ base: USDC, quote: WETH, liquidity: { usd: 500_000, base: bad as number, quote: 80 } })],
        USDC,
        WETH,
      )
      expect(read, `side amount ${String(bad)} must not become a reserve`).toBeNull()
    }
  })

  it('an unreadable USD figure still allows the read — usd only RANKS candidates, it is never the answer', () => {
    const read = pickHopReserve([pair({ base: USDC, quote: WETH, liquidity: { base: 250_000, quote: 80 } })], USDC, WETH)
    expect(read?.reserveUsd).toBe(250_000)
  })

  it('empty, malformed, and non-array inputs answer NULL, never a fallback constant', () => {
    expect(pickHopReserve([], USDC, WETH)).toBeNull()
    expect(pickHopReserve([{}], USDC, WETH)).toBeNull()
    expect(pickHopReserve(null as unknown as DexPairReserve[], USDC, WETH)).toBeNull()
    expect(pickHopReserve([pair({ base: USDC, quote: WETH })], USDC, WETH)).toBeNull()
  })

  it('a chain with no WETH in its book still measures — every funding pair is a substitute candidate', () => {
    const read = pickHopReserve([pair({ base: USDC, quote: AERO, liquidity: { usd: 60_000, base: 30_000, quote: 7 } })], USDC, null)
    expect(read?.reserveUsd).toBe(30_000)
    expect(read?.substituted).toBe(true)
  })
})

describe('readHopReserveUsd — a failed read is null, and null refuses every leg', () => {
  const args = { chainId: 8453, slug: 'base', funding: USDC, weth: WETH }

  it('a transport failure answers null — never a fallback depth', async () => {
    const boom: DexPairsFetcher = async () => {
      throw new Error('offline')
    }
    expect(await readHopReserveUsd({ ...args, chainId: 999_001 }, boom)).toBeNull()
  })

  it('a garbage body answers null', async () => {
    const junk: DexPairsFetcher = async () => ({ nope: true }) as unknown as DexPairReserve[]
    expect(await readHopReserveUsd({ ...args, chainId: 999_002 }, junk)).toBeNull()
  })

  it('THE CONSEQUENCE, driven end to end: a null reserve refuses every leg with an honest reason', async () => {
    const boom: DexPairsFetcher = async () => {
      throw new Error('offline')
    }
    const reserve = await readHopReserveUsd({ ...args, chainId: 999_003 }, boom)
    expect(reserve).toBeNull()
    const plan = deriveLegFloors(
      [
        { key: 'a', quotedBuyAmount: 1_000_000n, notional: 500, marketSlippageBps: 30, buyTokenTaxBps: 0 },
        { key: 'b', quotedBuyAmount: 1_000_000n, notional: 500, marketSlippageBps: 30, buyTokenTaxBps: 0 },
      ],
      { hopReserve: reserve?.reserveUsd ?? null },
    )
    expect(plan.legs).toHaveLength(0)
    expect(plan.refusals.every((r) => r.reason === 'unreadable-hop-reserve')).toBe(true)
    for (const r of plan.refusals) expect(r.message.length).toBeGreaterThan(0)
  })

  it('a MEASURED DEEP hop flows through to real per-leg floors that GROW along the batch', async () => {
    // $5M funding side — a Base-like USDC/WETH hop
    const ok: DexPairsFetcher = async () => [pair({ base: USDC, quote: WETH, liquidity: { usd: 10_000_000, base: 5_000_000, quote: 1_600 } })]
    const reserve = await readHopReserveUsd({ ...args, chainId: 999_004 }, ok)
    expect(reserve?.reserveUsd).toBe(5_000_000)
    const plan = deriveLegFloors(
      [
        { key: 'a', quotedBuyAmount: 1_000_000n, notional: 1_000, marketSlippageBps: 30, buyTokenTaxBps: 0 },
        { key: 'b', quotedBuyAmount: 1_000_000n, notional: 1_000, marketSlippageBps: 30, buyTokenTaxBps: 0 },
        { key: 'c', quotedBuyAmount: 1_000_000n, notional: 1_000, marketSlippageBps: 30, buyTokenTaxBps: 0 },
      ],
      { hopReserve: reserve?.reserveUsd ?? null },
    )
    expect(plan.legs).toHaveLength(3)
    expect(plan.legs[0].breakdown.selfImpactBps).toBe(0)
    // each later leg carries the ones before it, so the floor only loosens
    expect(plan.legs[1].breakdown.selfImpactBps).toBeGreaterThan(0)
    expect(plan.legs[2].breakdown.selfImpactBps).toBeGreaterThan(plan.legs[1].breakdown.selfImpactBps)
    expect(plan.legs[2].minBuyAmount).toBeLessThan(plan.legs[0].minBuyAmount)
  })

  it('A THIN MEASURED HOP REFUSES THE LATER LEGS — the cap biting on a real reserve, which is the 4663 case', async () => {
    // $50k funding side: their rule-3 table's thin column. A second $1,000 leg
    // needs 1 − 1/(1+1000/50000)² ≈ 388 bps of self-impact alone, so its honest
    // floor (418 bps with the market term) is over the 300 cap and the leg is
    // REFUSED rather than submitted with a floor that does not protect it.
    const thin: DexPairsFetcher = async () => [pair({ base: USDC, quote: WETH, liquidity: { usd: 100_000, base: 50_000, quote: 16 } })]
    const reserve = await readHopReserveUsd({ ...args, chainId: 999_005 }, thin)
    expect(reserve?.reserveUsd).toBe(50_000)
    const plan = deriveLegFloors(
      [
        { key: 'a', quotedBuyAmount: 1_000_000n, notional: 1_000, marketSlippageBps: 30, buyTokenTaxBps: 0 },
        { key: 'b', quotedBuyAmount: 1_000_000n, notional: 1_000, marketSlippageBps: 30, buyTokenTaxBps: 0 },
      ],
      { hopReserve: reserve?.reserveUsd ?? null },
    )
    expect(plan.legs).toHaveLength(1)
    expect(plan.refusals[0].reason).toBe('exceeds-s-max')
    expect(plan.refusals[0].neededBps).toBeGreaterThan(300)
  })
})
