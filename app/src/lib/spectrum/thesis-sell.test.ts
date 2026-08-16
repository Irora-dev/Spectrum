import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { thesisSellPlan, type ThesisSellInput } from './thesis-sell'

// ─────────────────────────────────────────────────────────────────────────────
// The sell plan is the LAST pure computation before real redeems are signed, so
// every law here is a money law: the fraction refuses rather than clamps, the
// raw amounts are bigint-exact (a float-multiplied balance is a wrong trade
// above 2^53), an unpriceable leg estimates as null and never $0, and "nothing
// to sell" is null — not an empty plan that renders a runnable run doing
// nothing.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = '0xAbCd0000000000000000000000000000000000A1' as Address
const ETH = '0x00000000000000000000000000000000000000b2' as Address
const ONE = 10n ** 18n // one basket token at 18dp

const leg = (chainId: number, over: Partial<ThesisSellInput['legs'][number]> = {}): ThesisSellInput['legs'][number] => ({
  chainId,
  address: chainId === 8453 ? BASE : ETH,
  decimals: 18,
  navPerToken: 1,
  ...over,
})

const plan = (over: Partial<ThesisSellInput> = {}) =>
  thesisSellPlan({
    legs: [leg(8453), leg(1)],
    held: [
      { chainId: 8453, address: BASE, balanceRaw: 10n * ONE },
      { chainId: 1, address: ETH, balanceRaw: 4n * ONE },
    ],
    fraction: 1,
    consolidateTo: null,
    ...over,
  })

describe('the fraction — parts-per-million, refused rather than clamped', () => {
  it('fraction 1 sells EXACTLY the held balance — no off-by-one residue dust', () => {
    const p = plan()!
    expect(p.steps.map((s) => s.sellRaw)).toEqual([10n * ONE, 4n * ONE])
  })

  it('refuses NaN, zero, negative, >1 and non-finite — a wrong fraction is a wrong trade', () => {
    for (const bad of [0, -0.5, Number.NaN, 1.0000001, 2, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(plan({ fraction: bad }), `fraction ${bad}`).toBeNull()
    }
  })

  it('a balance beyond 2^53 survives — float multiplication would silently round it away', () => {
    const big = ONE + 1n // 10^18 + 1
    expect(Number(big)).toBe(1e18) // the trap the bigint path exists to avoid
    const p = plan({ held: [{ chainId: 8453, address: BASE, balanceRaw: big }], fraction: 1 })!
    expect(p.steps[0].sellRaw).toBe(big) // the +1 raw unit is still there
  })

  it('half of 10^18+1 is the exact truncated bigint, not a float approximation', () => {
    const p = plan({ held: [{ chainId: 8453, address: BASE, balanceRaw: ONE + 1n }], fraction: 0.5 })!
    expect(p.steps[0].sellRaw).toBe(500_000_000_000_000_000n)
  })

  it('ordinary decimal fractions land on their exact ppm — round absorbs binary float error', () => {
    // 0.29 × 1e6 is 289999.999… in binary; flooring would under-sell by a ppm
    // for no reason, so the quantisation rounds
    const p = plan({ held: [{ chainId: 8453, address: BASE, balanceRaw: 1_000_000n }], fraction: 0.29 })!
    expect(p.steps[0].sellRaw).toBe(290_000n)
  })

  it('a fraction within half a ppm of 1 sells everything — the documented quantisation bound', () => {
    // 0.9999999 rounds to 1_000_000 ppm; the error is 0.1 ppm of the balance,
    // inside the stated ±0.5 ppm bound — not a clamp
    const p = plan({ fraction: 0.9999999 })!
    expect(p.steps[0].sellRaw).toBe(10n * ONE)
  })

  it('a fraction below half a ppm quantises to selling nothing — null, not a run of zero-amount steps', () => {
    expect(plan({ fraction: 1e-9 })).toBeNull()
  })
})

describe('what counts as a step', () => {
  it('a leg the wallet does not hold is omitted — selling nothing is not a step', () => {
    const p = plan({ held: [{ chainId: 8453, address: BASE, balanceRaw: 10n * ONE }] })!
    expect(p.steps.map((s) => s.chainId)).toEqual([8453])
  })

  it('a zero or negative balance read is omitted', () => {
    const p = plan({
      held: [
        { chainId: 8453, address: BASE, balanceRaw: 0n },
        { chainId: 1, address: ETH, balanceRaw: -5n },
      ],
    })
    expect(p).toBeNull()
  })

  it('dust × a small fraction that quantises to zero raw units is omitted', () => {
    // 3 raw units at 10% is 0n — the other leg still sells
    const p = plan({
      held: [
        { chainId: 8453, address: BASE, balanceRaw: 3n },
        { chainId: 1, address: ETH, balanceRaw: 10n * ONE },
      ],
      fraction: 0.1,
    })!
    expect(p.steps.map((s) => s.chainId)).toEqual([1])
  })

  it('nothing held is NO PLAN, not an empty plan — the caller says "nothing to sell"', () => {
    expect(plan({ held: [] })).toBeNull()
  })

  it('matches held rows case-insensitively — checksum casing differs between reads', () => {
    // registry legs arrive checksummed, wallet reads often lowercased; a
    // case-mismatched miss would silently sell none of a leg the user holds
    const p = plan({
      held: [
        { chainId: 8453, address: BASE.toLowerCase(), balanceRaw: 10n * ONE },
        { chainId: 1, address: ETH.toUpperCase().replace('0X', '0x'), balanceRaw: 4n * ONE },
      ],
    })!
    expect(p.steps).toHaveLength(2)
    expect(p.steps[0].address).toBe(BASE) // the leg's own spelling, for execution
  })

  it('a held row for a chain or address not in the legs is ignored — not part of this thesis', () => {
    const p = plan({
      held: [
        { chainId: 999, address: BASE, balanceRaw: 100n * ONE }, // right basket, wrong chain
        { chainId: 8453, address: '0x00000000000000000000000000000000000000ff', balanceRaw: 100n * ONE }, // wrong basket
        { chainId: 8453, address: BASE, balanceRaw: 10n * ONE },
      ],
    })!
    expect(p.steps.map((s) => s.chainId)).toEqual([8453])
    expect(p.steps[0].sellRaw).toBe(10n * ONE)
  })

  it('one step per basket even when a leg is repeated — the same balance must not sell twice', () => {
    const p = plan({ legs: [leg(8453), leg(8453), leg(1)] })!
    expect(p.steps.map((s) => s.chainId)).toEqual([8453, 1])
  })

  it('steps keep the legs’ order — richest first is the thesis’s own ordering', () => {
    const p = plan({ legs: [leg(1), leg(8453)] })!
    expect(p.steps.map((s) => s.chainId)).toEqual([1, 8453])
  })
})

describe('estCents — a display estimate that never lies about not knowing', () => {
  it('unreadable NAV reads as null while sellRaw stays real — never $0 for could-not-price', () => {
    for (const nav of [null, Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const p = plan({ legs: [leg(8453, { navPerToken: nav })], held: [{ chainId: 8453, address: BASE, balanceRaw: 10n * ONE }] })!
      expect(p.steps[0].estCents, `nav ${nav}`).toBeNull()
      expect(p.steps[0].sellRaw).toBe(10n * ONE) // the sale itself needs no price
    }
  })

  it('floors to cents', () => {
    // 1 token at $1.005 is 100.5 cents → 100, never rounded up
    const p = plan({ legs: [leg(8453, { navPerToken: 1.005 })], held: [{ chainId: 8453, address: BASE, balanceRaw: ONE }] })!
    expect(p.steps[0].estCents).toBe(100)
  })

  it('a PRICED dust sale may honestly floor to 0 — 0 means "under a cent", null means "unknown"', () => {
    const p = plan({ held: [{ chainId: 8453, address: BASE, balanceRaw: 1000n }] })!
    expect(p.steps[0].estCents).toBe(0)
    expect(p.steps[0].sellRaw).toBe(1000n)
  })
})

describe('consolidation — proceeds go home only when a bridge buys something', () => {
  it('null in, null out — proceeds stay where they land by default', () => {
    expect(plan({ consolidateTo: null })!.consolidate).toBeNull()
  })

  it('passes the home chain through when several chains sold', () => {
    expect(plan({ consolidateTo: 8453 })!.consolidate).toEqual({ toChainId: 8453 })
  })

  it('a home chain the run did NOT sell on is legitimate — bridging INTO it passes through', () => {
    expect(plan({ consolidateTo: 42161 })!.consolidate).toEqual({ toChainId: 42161 })
  })

  it('consolidating the only sold chain to itself is a bridge to yourself — a fee for nothing → null', () => {
    const p = plan({ held: [{ chainId: 8453, address: BASE, balanceRaw: 10n * ONE }], consolidateTo: 8453 })!
    expect(p.steps).toHaveLength(1) // the sell itself still runs
    expect(p.consolidate).toBeNull()

    // two baskets on ONE chain are still one chain — the set of chains decides,
    // not the count of steps
    const twin = '0x00000000000000000000000000000000000000ee' as Address
    const p2 = plan({
      legs: [leg(8453), leg(8453, { address: twin })],
      held: [
        { chainId: 8453, address: BASE, balanceRaw: 10n * ONE },
        { chainId: 8453, address: twin, balanceRaw: 2n * ONE },
      ],
      consolidateTo: 8453,
    })!
    expect(p2.steps).toHaveLength(2)
    expect(p2.consolidate).toBeNull()
  })

  it('a value that cannot name a chain degrades to the safe default: no bridge', () => {
    for (const bad of [Number.NaN, 0, -1, 1.5]) {
      expect(plan({ consolidateTo: bad })!.consolidate, `toChainId ${bad}`).toBeNull()
    }
  })
})
